#!/bin/sh
set -eu

BOUNDARY="/tmp/osi-predeploy-tests-$(id -u)"
mkdir -p "$BOUNDARY"; chmod 700 "$BOUNDARY"
ROOT=$(mktemp -d "$BOUNDARY/case-XXXXXX")
OUTSIDE_ROOT="/tmp/osi-predeploy-outside-${ROOT##*-}"
trap 'rm -rf "$ROOT" "$OUTSIDE_ROOT"' EXIT HUP INT TERM
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WRAPPER_ROOT="$ROOT/wrapper-root"
mkdir -p "$WRAPPER_ROOT/usr/libexec"
chmod 700 "$WRAPPER_ROOT" "$WRAPPER_ROOT/usr" "$WRAPPER_ROOT/usr/libexec"
cp "$HERE/pre-deploy-database-helper.js" "$WRAPPER_ROOT/usr/libexec/osi-pre-deploy-database-helper.js"
chmod 755 "$WRAPPER_ROOT/usr/libexec/osi-pre-deploy-database-helper.js"
export OSI_REPAIR_PROGRAM_MODE=1
export OSI_DEPLOY_ARTIFACT_MODE=test
export OSI_PREDEPLOY_WRAPPER_TEST_ROOT="$WRAPPER_ROOT"
LIVE="$ROOT/live.db"; printf 'live-must-not-change\n' >"$LIVE"
BACKUP="$ROOT/backup.db"; printf 'backup-must-not-be-read\n' >"$BACKUP"
STATE="$ROOT/state.json"; printf '{"untrusted":"not-parsed"}\n' >"$STATE"
MANIFEST="$ROOT/backup-manifest.json"; printf '{"untrusted":"not-parsed"}\n' >"$MANIFEST"
PREP="$ROOT/preparation.json"; printf '{"result":"BACKUP_REPLACEMENT_PREPARED"}\n' >"$PREP"
BEFORE=$(sha256sum "$LIVE" | awk '{print $1}')
SHA=$(sha256sum "$BACKUP" | awk '{print $1}'); SIZE=$(stat -c %s "$BACKUP")

expect_deferred() {
  name=$1; shift
  if sh "$HERE/restore-pre-deploy.sh" restore "$@" >"$ROOT/$name.out" 2>"$ROOT/$name.err"; then
    echo "FAIL: deferred $name restore returned success" >&2; exit 1
  fi
  grep -q 'NOT_IMPLEMENTED_IN_THIS_SLICE' "$ROOT/$name.err"
  [ "$(sha256sum "$LIVE" | awk '{print $1}')" = "$BEFORE" ]
}

expect_deferred ledger --purpose command-ledger-disposition --state "$STATE" \
  --recovery-operation-id recovery-1 --backup-manifest "$MANIFEST" --expected-path "$BACKUP" \
  --expected-size "$SIZE" --expected-sha256 "$SHA" --restore-preparation-result "$PREP"
expect_deferred general --purpose general-database-restore --state "$STATE" \
  --recovery-operation-id recovery-1 --backup-manifest "$MANIFEST" --restore-baseline "$ROOT/baseline.json" \
  --expected-path "$BACKUP" --expected-size "$SIZE" --expected-sha256 "$SHA" \
  --database-restore-preparation-result "$PREP"
expect_deferred integrity --purpose database-integrity-recovery --state "$STATE" \
  --request "$ROOT/request.json" --authority "$ROOT/authority.json" --preparation-result "$PREP" \
  --backup-manifest "$MANIFEST" --forensic-destination "$ROOT/forensic"

STALE_SENTINEL="$ROOT/stale-helper-ran"
printf '%s\n' '#!/bin/sh' "printf stale >'$STALE_SENTINEL'" 'exit 0' \
  >"$WRAPPER_ROOT/usr/libexec/pre-deploy-database-helper.js"
chmod 755 "$WRAPPER_ROOT/usr/libexec/pre-deploy-database-helper.js"
rm "$WRAPPER_ROOT/usr/libexec/osi-pre-deploy-database-helper.js"
if sh "$HERE/restore-pre-deploy.sh" restore --purpose command-ledger-disposition --state "$STATE" \
  --recovery-operation-id recovery-1 --backup-manifest "$MANIFEST" --expected-path "$BACKUP" \
  --expected-size "$SIZE" --expected-sha256 "$SHA" --restore-preparation-result "$PREP" \
  >"$ROOT/stale.out" 2>"$ROOT/stale.err"; then
  echo 'FAIL: unprefixed stale helper shadowed the shipped helper path' >&2; exit 1
fi
[ ! -e "$STALE_SENTINEL" ]

cp "$HERE/pre-deploy-database-helper.js" "$WRAPPER_ROOT/usr/libexec/osi-pre-deploy-database-helper.js"
printf '\n// tampered helper\n' >>"$WRAPPER_ROOT/usr/libexec/osi-pre-deploy-database-helper.js"
chmod 755 "$WRAPPER_ROOT/usr/libexec/osi-pre-deploy-database-helper.js"
if sh "$HERE/restore-pre-deploy.sh" restore --purpose command-ledger-disposition --state "$STATE" \
  --recovery-operation-id recovery-1 --backup-manifest "$MANIFEST" --expected-path "$BACKUP" \
  --expected-size "$SIZE" --expected-sha256 "$SHA" --restore-preparation-result "$PREP" \
  >"$ROOT/tampered.out" 2>"$ROOT/tampered.err"; then
  echo 'FAIL: helper hash drift was accepted' >&2; exit 1
fi
grep -q 'hash' "$ROOT/tampered.err"

mkdir -p "$OUTSIDE_ROOT/usr/libexec"
chmod 700 "$OUTSIDE_ROOT" "$OUTSIDE_ROOT/usr" "$OUTSIDE_ROOT/usr/libexec"
cp "$HERE/pre-deploy-database-helper.js" "$OUTSIDE_ROOT/usr/libexec/osi-pre-deploy-database-helper.js"
chmod 755 "$OUTSIDE_ROOT/usr/libexec/osi-pre-deploy-database-helper.js"
DOTDOT_ROOT="$BOUNDARY/../$(basename "$OUTSIDE_ROOT")"
if OSI_PREDEPLOY_WRAPPER_TEST_ROOT="$DOTDOT_ROOT" sh "$HERE/restore-pre-deploy.sh" restore \
  >"$ROOT/dotdot.out" 2>"$ROOT/dotdot.err"; then
  echo 'FAIL: dot-dot test adapter escaped the fixed helper boundary' >&2; exit 1
fi
grep -Eq 'dot-dot|outside the fixed boundary' "$ROOT/dotdot.err"

if sh "$HERE/restore-pre-deploy.sh" --dormant-restore "$BACKUP" "$LIVE" >/dev/null 2>&1; then
  echo 'FAIL: removed ad-hoc dormant restore interface is still accepted' >&2; exit 1
fi

SHADOW_DIR="$ROOT/path-shadow"; SENTINEL="$ROOT/path-shadow-ran"
mkdir "$SHADOW_DIR"
cp "$HERE/pre-deploy-database-helper.js" "$WRAPPER_ROOT/usr/libexec/osi-pre-deploy-database-helper.js"
chmod 755 "$WRAPPER_ROOT/usr/libexec/osi-pre-deploy-database-helper.js"
for tool in id stat readlink dirname sha256sum node; do
  printf '%s\n' '#!/bin/sh' "printf '%s\\n' '$tool' >>'$SENTINEL'" "exec /usr/bin/$tool \"\$@\"" >"$SHADOW_DIR/$tool"
  chmod 755 "$SHADOW_DIR/$tool"
done
if PATH="$SHADOW_DIR:$PATH" sh "$HERE/restore-pre-deploy.sh" restore --purpose command-ledger-disposition \
  --state "$STATE" --recovery-operation-id recovery-1 --backup-manifest "$MANIFEST" \
  --expected-path "$BACKUP" --expected-size "$SIZE" --expected-sha256 "$SHA" \
  --restore-preparation-result "$PREP" >"$ROOT/shadow.out" 2>"$ROOT/shadow.err"; then
  echo 'FAIL: deferred restore returned success under PATH shadow test' >&2; exit 1
fi
grep -q 'NOT_IMPLEMENTED_IN_THIS_SLICE' "$ROOT/shadow.err"
[ ! -e "$SENTINEL" ] || { echo 'FAIL: restore wrapper executed a caller PATH shadow' >&2; exit 1; }
echo 'restore-pre-deploy deferred purpose boundary: PASS'
