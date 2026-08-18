#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
NODE=/usr/bin/node
RM=/bin/rm

fail() { printf 'deployment-inhibit: %s\n' "$1" >&2; exit 2; }
[ "${1:-}" = enforce ] || fail 'expected enforce verb'
shift
ROOT= STATE_CLI= DEPLOYMENT_ROOT= GUARD_MARKER= STATE= RECEIPTS=
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || fail 'missing flag value'
  case "$1" in
    --root) [ -z "$ROOT" ] || fail 'duplicate --root'; ROOT=$2 ;;
    --state-cli) [ -z "$STATE_CLI" ] || fail 'duplicate --state-cli'; STATE_CLI=$2 ;;
    --deployment-root) [ -z "$DEPLOYMENT_ROOT" ] || fail 'duplicate --deployment-root'; DEPLOYMENT_ROOT=$2 ;;
    --guard-marker) [ -z "$GUARD_MARKER" ] || fail 'duplicate --guard-marker'; GUARD_MARKER=$2 ;;
    --state) [ -z "$STATE" ] || fail 'duplicate --state'; STATE=$2 ;;
    --receipts) [ -z "$RECEIPTS" ] || fail 'duplicate --receipts'; RECEIPTS=$2 ;;
    *) fail "unknown flag $1" ;;
  esac
  shift 2
done
for value in "$ROOT" "$STATE_CLI" "$DEPLOYMENT_ROOT" "$GUARD_MARKER" "$STATE" "$RECEIPTS"; do
  case "$value" in /*) ;; *) fail 'all paths must be absolute' ;; esac
done

# The deployment attempt lock is caller-owned. Before trusting any answer from
# the resident state authority, independently bind its exact path, bytes, and
# mode to the root-owned guard marker using the pinned Node runtime. A corrupt
# marker or resident therefore takes the same fail-closed quarantine path as a
# denied startup-check; untrusted code is never executed to decide its own
# validity.
authority_valid=0
if "$NODE" - "$GUARD_MARKER" "$STATE_CLI" <<'NODE' >/dev/null 2>&1
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const [markerPath, stateCliPath] = process.argv.slice(2);
if (process.execPath !== '/usr/bin/node') throw new Error('unexpected Node runtime');
const nodeStat = fs.lstatSync('/usr/bin/node');
if (!nodeStat.isFile() || nodeStat.isSymbolicLink() || nodeStat.uid !== 0
    || (nodeStat.mode & 0o111) === 0 || (nodeStat.mode & 0o022) !== 0) {
  throw new Error('unsafe Node runtime');
}
const markerStat = fs.lstatSync(markerPath);
if (!markerStat.isFile() || markerStat.isSymbolicLink()
    || markerStat.uid !== process.getuid() || (markerStat.mode & 0o777) !== 0o600) {
  throw new Error('unsafe guard marker');
}
const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
if (!marker || typeof marker !== 'object' || Array.isArray(marker)
    || !marker.residents || typeof marker.residents !== 'object' || Array.isArray(marker.residents)) {
  throw new Error('guard marker has no resident authority');
}
const stateCli = marker.residents.stateCli;
if (!stateCli || typeof stateCli !== 'object' || Array.isArray(stateCli)
    || Object.keys(stateCli).sort().join(',') !== 'mode,path,sha256'
    || stateCli.path !== stateCliPath || !stateCli.path.startsWith('/')
    || stateCli.mode !== 0o755 || !/^[0-9a-f]{64}$/.test(stateCli.sha256)) {
  throw new Error('guard marker state CLI binding mismatch');
}
const stateCliStat = fs.lstatSync(stateCliPath);
if (!stateCliStat.isFile() || stateCliStat.isSymbolicLink()
    || stateCliStat.uid !== process.getuid() || (stateCliStat.mode & 0o777) !== stateCli.mode) {
  throw new Error('unsafe state CLI');
}
const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(stateCliPath)).digest('hex');
if (actualSha256 !== stateCli.sha256) throw new Error('state CLI hash mismatch');
NODE
then
  authority_valid=1
fi

# Ask only the independently verified resident authority whether startup is
# safe, and quarantine the exact six application links on any uncertainty.
if [ "$authority_valid" -eq 1 ] && "$NODE" "$STATE_CLI" startup-check --root "$DEPLOYMENT_ROOT" --guard-marker "$GUARD_MARKER" \
  --state "$STATE" --receipts "$RECEIPTS" --service osi-db-integrity >/dev/null 2>&1; then
  exit 0
fi

test_adapter_enabled() {
  boundary="/tmp/osi-deployment-inhibit-tests-$(id -u)"
  [ "${OSI_REPAIR_PROGRAM_MODE:-}" = 1 ] &&
    [ "${OSI_DEPLOY_ARTIFACT_MODE:-}" = test ] &&
    { [ "$ROOT" = "$boundary" ] || [ "${ROOT#"$boundary"/}" != "$ROOT" ]; }
}

FSYNC_CALLS=0
fsync_rc_dir() {
  FSYNC_CALLS=$((FSYNC_CALLS + 1))
  if [ -n "${OSI_DEPLOY_INHIBIT_TEST_FSYNC_LOG:-}" ]; then
    test_adapter_enabled || fail 'fsync test adapter is outside the fixed boundary'
    [ "${OSI_DEPLOY_INHIBIT_TEST_FSYNC_LOG#"$ROOT"/}" != "$OSI_DEPLOY_INHIBIT_TEST_FSYNC_LOG" ] || fail 'fsync test log escapes root'
    printf '%s\n' "$ROOT/etc/rc.d" >>"$OSI_DEPLOY_INHIBIT_TEST_FSYNC_LOG"
    [ "${OSI_DEPLOY_INHIBIT_TEST_FSYNC_FAIL_AT:-0}" -ne "$FSYNC_CALLS" ] || return 9
  fi
  "$NODE" - "$ROOT/etc/rc.d" <<'NODE'
'use strict';
const fs = require('node:fs');
const directory = process.argv[2];
const fd = fs.openSync(directory, 'r');
try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
NODE
}

RM_CALLS=0
remove_link() {
  RM_CALLS=$((RM_CALLS + 1))
  if [ -n "${OSI_DEPLOY_INHIBIT_TEST_RM_LOG:-}" ]; then
    test_adapter_enabled || fail 'unlink test adapter is outside the fixed boundary'
    [ "${OSI_DEPLOY_INHIBIT_TEST_RM_LOG#"$ROOT"/}" != "$OSI_DEPLOY_INHIBIT_TEST_RM_LOG" ] || fail 'unlink test log escapes root'
    printf '%s\n' "$1" >>"$OSI_DEPLOY_INHIBIT_TEST_RM_LOG"
    [ "${OSI_DEPLOY_INHIBIT_TEST_RM_FAIL_AT:-0}" -ne "$RM_CALLS" ] || return 8
  fi
  "$RM" -f -- "$1"
}

failures=0
links='S90osi-db-integrity S98osi-identityd K98osi-identityd S99node-red K99node-red S99osi-bootstrap'
for link in $links; do
  candidate="$ROOT/etc/rc.d/$link"
  if [ -L "$candidate" ] || [ -e "$candidate" ]; then
    if ! remove_link "$candidate"; then
      printf 'deployment-inhibit: unlink failed for %s\n' "$candidate" >&2
      failures=1
    elif ! fsync_rc_dir; then
      printf 'deployment-inhibit: rc.d fsync failed after removing %s\n' "$candidate" >&2
      failures=1
    fi
  fi
done

# A transient unlink failure must not leave an enabled service behind. Retry
# every survivor once, then prove the full six-name set absent before return.
for link in $links; do
  candidate="$ROOT/etc/rc.d/$link"
  if [ -L "$candidate" ] || [ -e "$candidate" ]; then
    if ! remove_link "$candidate"; then
      printf 'deployment-inhibit: retry unlink failed for %s\n' "$candidate" >&2
      failures=1
    elif ! fsync_rc_dir; then
      printf 'deployment-inhibit: rc.d fsync failed after retrying %s\n' "$candidate" >&2
      failures=1
    fi
  fi
done
for link in $links; do
  candidate="$ROOT/etc/rc.d/$link"
  if [ -L "$candidate" ] || [ -e "$candidate" ]; then
    printf 'deployment-inhibit: startup link remains after quarantine: %s\n' "$candidate" >&2
    failures=1
  fi
done
[ "$failures" -eq 0 ] || exit 2
exit 0
