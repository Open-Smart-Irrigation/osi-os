#!/bin/sh
set -eu

BOUNDARY="/tmp/osi-deployment-inhibit-tests-$(id -u)"
mkdir -p "$BOUNDARY"
ROOT=$(mktemp -d "$BOUNDARY/case-XXXXXX")
trap 'rm -rf "$ROOT"' EXIT
LOG="$ROOT/calls"
FSYNC_LOG="$ROOT/fsync-calls"
SHADOW_LOG="$ROOT/path-shadow-calls"
STATE_CLI="$ROOT/state-cli"
GUARD_MARKER="$ROOT/data/osi-deploy/guard-installed.json"
HELPER="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/deployment-inhibit.sh"
BIN="$ROOT/bin"
mkdir -p "$BIN"

cat >"$STATE_CLI" <<EOF
#!/usr/bin/env node
'use strict';
require('node:fs').appendFileSync('${LOG}', process.argv.slice(2).join(' ') + '\\n');
process.exit(Number(process.env.STATE_EXIT || 0));
EOF
chmod 755 "$STATE_CLI"

write_guard_marker() {
  mkdir -p "$(dirname "$GUARD_MARKER")"
  /usr/bin/node - "$GUARD_MARKER" "$STATE_CLI" <<'NODE'
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const [markerPath, stateCliPath] = process.argv.slice(2);
const marker = {
  residents: {
    stateCli: {
      path: stateCliPath,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(stateCliPath)).digest('hex'),
      mode: 0o755,
    },
  },
};
fs.writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
fs.chmodSync(markerPath, 0o600);
NODE
}
write_guard_marker

cat >"$BIN/node" <<EOF
#!/bin/sh
printf '%s\n' node >>"$SHADOW_LOG"
exit 99
EOF
chmod 755 "$BIN/node"

cat >"$BIN/rm" <<EOF
#!/bin/sh
printf '%s\n' rm >>"$SHADOW_LOG"
exit 99
EOF
chmod 755 "$BIN/rm"

mkdir -p "$ROOT/etc/rc.d"
for link in S90osi-db-integrity S98osi-identityd K98osi-identityd S99node-red K99node-red S99osi-bootstrap; do
  ln -s "../init.d/${link#???}" "$ROOT/etc/rc.d/$link"
done

PATH="$BIN:$PATH" OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test \
  OSI_DEPLOY_INHIBIT_TEST_FSYNC_LOG="$FSYNC_LOG" STATE_EXIT=1 "$HELPER" enforce --root "$ROOT" --state-cli "$STATE_CLI" \
  --deployment-root "$ROOT/data/osi-deploy" --guard-marker "$GUARD_MARKER" \
  --state "$ROOT/data/osi-deploy/deployment-state.json" --receipts "$ROOT/data/osi-deploy/receipts"

for link in S90osi-db-integrity S98osi-identityd K98osi-identityd S99node-red K99node-red S99osi-bootstrap; do
  { [ ! -e "$ROOT/etc/rc.d/$link" ] && [ ! -L "$ROOT/etc/rc.d/$link" ]; } || { echo "FAIL: $link survived inhibition" >&2; exit 1; }
done
grep -q 'startup-check.*--service osi-db-integrity' "$LOG"
[ "$(wc -l <"$FSYNC_LOG")" -eq 6 ] || { echo 'FAIL: each quarantined link must be followed by an rc.d fsync' >&2; exit 1; }
[ ! -e "$SHADOW_LOG" ] || { echo 'FAIL: helper executed a PATH-shadowed tool' >&2; exit 1; }

# A durability failure is reported only after all six links are absent.
: >"$FSYNC_LOG"
for link in S90osi-db-integrity S98osi-identityd K98osi-identityd S99node-red K99node-red S99osi-bootstrap; do
  ln -s "../init.d/${link#???}" "$ROOT/etc/rc.d/$link"
done
if PATH="$BIN:$PATH" OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test \
  OSI_DEPLOY_INHIBIT_TEST_FSYNC_LOG="$FSYNC_LOG" OSI_DEPLOY_INHIBIT_TEST_FSYNC_FAIL_AT=1 \
  STATE_EXIT=1 "$HELPER" enforce --root "$ROOT" --state-cli "$STATE_CLI" \
  --deployment-root "$ROOT/data/osi-deploy" --guard-marker "$GUARD_MARKER" \
  --state "$ROOT/data/osi-deploy/deployment-state.json" --receipts "$ROOT/data/osi-deploy/receipts"; then
  echo 'FAIL: fsync failure was ignored' >&2
  exit 1
fi
[ ! -e "$ROOT/etc/rc.d/S90osi-db-integrity" ] && [ ! -L "$ROOT/etc/rc.d/S90osi-db-integrity" ]
for link in S90osi-db-integrity S98osi-identityd K98osi-identityd S99node-red K99node-red S99osi-bootstrap; do
  { [ ! -e "$ROOT/etc/rc.d/$link" ] && [ ! -L "$ROOT/etc/rc.d/$link" ]; } || { echo "FAIL: fsync fault left $link enabled" >&2; exit 1; }
done

# A transient unlink error is also accumulated, retried, and returned only
# after every startup link is proven absent.
RM_LOG="$ROOT/rm-calls"
: >"$RM_LOG"
for link in S90osi-db-integrity S98osi-identityd K98osi-identityd S99node-red K99node-red S99osi-bootstrap; do
  ln -s "../init.d/${link#???}" "$ROOT/etc/rc.d/$link"
done
if PATH="$BIN:$PATH" OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test \
  OSI_DEPLOY_INHIBIT_TEST_RM_LOG="$RM_LOG" OSI_DEPLOY_INHIBIT_TEST_RM_FAIL_AT=1 \
  OSI_DEPLOY_INHIBIT_TEST_FSYNC_LOG="$FSYNC_LOG" STATE_EXIT=1 "$HELPER" enforce --root "$ROOT" --state-cli "$STATE_CLI" \
  --deployment-root "$ROOT/data/osi-deploy" --guard-marker "$GUARD_MARKER" \
  --state "$ROOT/data/osi-deploy/deployment-state.json" --receipts "$ROOT/data/osi-deploy/receipts"; then
  echo 'FAIL: unlink failure was ignored' >&2
  exit 1
fi
for link in S90osi-db-integrity S98osi-identityd K98osi-identityd S99node-red K99node-red S99osi-bootstrap; do
  { [ ! -e "$ROOT/etc/rc.d/$link" ] && [ ! -L "$ROOT/etc/rc.d/$link" ]; } || { echo "FAIL: unlink fault left $link enabled" >&2; exit 1; }
done

: >"$LOG"
for link in S90osi-db-integrity S98osi-identityd K98osi-identityd S99node-red K99node-red S99osi-bootstrap; do
  rm -f "$ROOT/etc/rc.d/$link"
  ln -s "../init.d/${link#???}" "$ROOT/etc/rc.d/$link"
done
PATH="$BIN:$PATH" OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test \
  OSI_DEPLOY_INHIBIT_TEST_FSYNC_LOG="$FSYNC_LOG" STATE_EXIT=0 "$HELPER" enforce --root "$ROOT" --state-cli "$STATE_CLI" \
  --deployment-root "$ROOT/data/osi-deploy" --guard-marker "$GUARD_MARKER" \
  --state "$ROOT/data/osi-deploy/deployment-state.json" --receipts "$ROOT/data/osi-deploy/receipts"
[ -L "$ROOT/etc/rc.d/S99node-red" ]

# Marker/CLI validation is an independent prerequisite to trusting a passing
# startup-check. Corrupt CLI bytes must quarantine all links without executing
# the now-untrusted status authority.
: >"$LOG"
printf '\n// marker-bound bytes changed\n' >>"$STATE_CLI"
for link in S90osi-db-integrity S98osi-identityd K98osi-identityd S99node-red K99node-red S99osi-bootstrap; do
  rm -f "$ROOT/etc/rc.d/$link"
  ln -s "../init.d/${link#???}" "$ROOT/etc/rc.d/$link"
done
PATH="$BIN:$PATH" OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test \
  OSI_DEPLOY_INHIBIT_TEST_FSYNC_LOG="$FSYNC_LOG" STATE_EXIT=0 "$HELPER" enforce --root "$ROOT" --state-cli "$STATE_CLI" \
  --deployment-root "$ROOT/data/osi-deploy" --guard-marker "$GUARD_MARKER" \
  --state "$ROOT/data/osi-deploy/deployment-state.json" --receipts "$ROOT/data/osi-deploy/receipts"
[ ! -s "$LOG" ] || { echo 'FAIL: corrupted state CLI was executed before marker validation' >&2; exit 1; }
for link in S90osi-db-integrity S98osi-identityd K98osi-identityd S99node-red K99node-red S99osi-bootstrap; do
  { [ ! -e "$ROOT/etc/rc.d/$link" ] && [ ! -L "$ROOT/etc/rc.d/$link" ]; } || { echo "FAIL: marker corruption left $link enabled" >&2; exit 1; }
done

if grep -Eq 'acquire-lock|release-lock' "$HELPER"; then
  echo 'FAIL: inhibitor must not own the deployment lock' >&2
  exit 1
fi

# Execute the shipped candidate through the real OpenWrt rc.common dispatcher.
# This catches malformed shebangs and positional/helper-argv drift that a direct
# helper invocation cannot see.
REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
INIT_2712="$REPO/conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-deployment-inhibit"
INIT_2709="$REPO/conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-deployment-inhibit"
[ "$(head -n 1 "$INIT_2712")" = '#!/bin/sh /etc/rc.common' ]
cmp -s "$INIT_2712" "$INIT_2709"
RCROOT="$ROOT/rc-lifecycle"
mkdir -p "$RCROOT/etc/rc.d" "$RCROOT/data/osi-deploy"
RC_STATE="$ROOT/rc-state-cli"
cat >"$RC_STATE" <<'EOF'
#!/usr/bin/env node
'use strict';
process.exit(Number(process.env.STATE_EXIT || 1));
EOF
chmod 755 "$RC_STATE"
/usr/bin/node - "$RCROOT/data/osi-deploy/guard-installed.json" "$RC_STATE" <<'NODE'
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const [markerPath, sourceCli] = process.argv.slice(2);
const marker = { residents: { stateCli: {
  path: '/usr/libexec/osi-deployment-state-cli.js',
  sha256: crypto.createHash('sha256').update(fs.readFileSync(sourceCli)).digest('hex'),
  mode: 0o755,
} } };
fs.writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
fs.chmodSync(markerPath, 0o600);
NODE
for link in S90osi-db-integrity S98osi-identityd K98osi-identityd S99node-red K99node-red S99osi-bootstrap; do
  ln -s "../init.d/${link#???}" "$RCROOT/etc/rc.d/$link"
done
run_rc_common() {
  bwrap --tmpfs / \
    --dir /usr --ro-bind /usr/bin /usr/bin --ro-bind /usr/lib /usr/lib --dir /usr/libexec \
    --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
    --proc /proc --dev /dev --tmpfs /tmp \
    --dir /etc --dir /etc/rc.d --dir /etc/init.d --dir /data \
    --bind "$RCROOT/etc/rc.d" /etc/rc.d \
    --bind "$RCROOT/data" /data \
    --ro-bind "$REPO/openwrt/package/base-files/files" /tmp/osi-openwrt-base-files \
    --ro-bind "$INIT_2712" /etc/init.d/osi-deployment-inhibit \
    --ro-bind "$HELPER" /usr/libexec/osi-deployment-inhibit.sh \
    --ro-bind "$RC_STATE" /usr/libexec/osi-deployment-state-cli.js \
    --setenv IPKG_INSTROOT /tmp/osi-openwrt-base-files \
    --setenv STATE_EXIT "$1" \
    /bin/sh /tmp/osi-openwrt-base-files/etc/rc.common /etc/init.d/osi-deployment-inhibit start
}
run_rc_common 1
for link in S90osi-db-integrity S98osi-identityd K98osi-identityd S99node-red K99node-red S99osi-bootstrap; do
  { [ ! -e "$RCROOT/etc/rc.d/$link" ] && [ ! -L "$RCROOT/etc/rc.d/$link" ]; } || { echo "FAIL: rc.common lifecycle left $link enabled" >&2; exit 1; }
done

echo 'deployment-inhibit: PASS'
