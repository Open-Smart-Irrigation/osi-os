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
SOURCE="$ROOT/farming.db"
printf 'not-opened-sqlite-sentinel\n' >"$SOURCE"
BEFORE=$(sha256sum "$SOURCE" | awk '{print $1}')

for purpose in command-ledger-disposition general-database-restore database-integrity-recovery; do
  DEST="$ROOT/$purpose.db"; MANIFEST="$ROOT/$purpose.json"
  if sh "$HERE/backup-pre-deploy.sh" snapshot --purpose "$purpose" \
    --source "$SOURCE" --destination "$DEST" --manifest-out "$MANIFEST" \
    --state "$ROOT/state.json" --expected-operation-id op-1 \
    --expected-state-sha256 "$(printf 'a%.0s' $(seq 1 64))" \
    --preparation not-applicable-before-snapshot >"$ROOT/$purpose.out" 2>"$ROOT/$purpose.err"; then
    echo "FAIL: deferred $purpose snapshot returned success" >&2; exit 1
  fi
  grep -q 'NOT_IMPLEMENTED_IN_THIS_SLICE' "$ROOT/$purpose.err"
  [ ! -e "$DEST" ] && [ ! -e "$MANIFEST" ]
  [ "$(sha256sum "$SOURCE" | awk '{print $1}')" = "$BEFORE" ]
done

STALE_SENTINEL="$ROOT/stale-helper-ran"
printf '%s\n' '#!/bin/sh' "printf stale >'$STALE_SENTINEL'" 'exit 0' \
  >"$WRAPPER_ROOT/usr/libexec/pre-deploy-database-helper.js"
chmod 755 "$WRAPPER_ROOT/usr/libexec/pre-deploy-database-helper.js"
rm "$WRAPPER_ROOT/usr/libexec/osi-pre-deploy-database-helper.js"
if sh "$HERE/backup-pre-deploy.sh" snapshot --purpose command-ledger-disposition \
  --source "$SOURCE" --destination "$ROOT/stale.db" --manifest-out "$ROOT/stale.json" \
  --state "$ROOT/state.json" --expected-operation-id op-1 \
  --expected-state-sha256 "$(printf 'a%.0s' $(seq 1 64))" \
  --preparation not-applicable-before-snapshot >"$ROOT/stale.out" 2>"$ROOT/stale.err"; then
  echo 'FAIL: unprefixed stale helper shadowed the shipped helper path' >&2; exit 1
fi
[ ! -e "$STALE_SENTINEL" ]

cp "$HERE/pre-deploy-database-helper.js" "$WRAPPER_ROOT/usr/libexec/osi-pre-deploy-database-helper.js"
printf '\n// tampered helper\n' >>"$WRAPPER_ROOT/usr/libexec/osi-pre-deploy-database-helper.js"
chmod 755 "$WRAPPER_ROOT/usr/libexec/osi-pre-deploy-database-helper.js"
if sh "$HERE/backup-pre-deploy.sh" snapshot --purpose command-ledger-disposition \
  --source "$SOURCE" --destination "$ROOT/tampered.db" --manifest-out "$ROOT/tampered.json" \
  --state "$ROOT/state.json" --expected-operation-id op-1 \
  --expected-state-sha256 "$(printf 'a%.0s' $(seq 1 64))" \
  --preparation not-applicable-before-snapshot >"$ROOT/tampered.out" 2>"$ROOT/tampered.err"; then
  echo 'FAIL: helper hash drift was accepted' >&2; exit 1
fi
grep -q 'hash' "$ROOT/tampered.err"

mkdir -p "$OUTSIDE_ROOT/usr/libexec"
chmod 700 "$OUTSIDE_ROOT" "$OUTSIDE_ROOT/usr" "$OUTSIDE_ROOT/usr/libexec"
cp "$HERE/pre-deploy-database-helper.js" "$OUTSIDE_ROOT/usr/libexec/osi-pre-deploy-database-helper.js"
chmod 755 "$OUTSIDE_ROOT/usr/libexec/osi-pre-deploy-database-helper.js"
DOTDOT_ROOT="$BOUNDARY/../$(basename "$OUTSIDE_ROOT")"
if OSI_PREDEPLOY_WRAPPER_TEST_ROOT="$DOTDOT_ROOT" sh "$HERE/backup-pre-deploy.sh" snapshot \
  >"$ROOT/dotdot.out" 2>"$ROOT/dotdot.err"; then
  echo 'FAIL: dot-dot test adapter escaped the fixed helper boundary' >&2; exit 1
fi
grep -Eq 'dot-dot|outside the fixed boundary' "$ROOT/dotdot.err"

if sh "$HERE/backup-pre-deploy.sh" --dormant-snapshot "$SOURCE" "$ROOT/old.db" "$ROOT/old.json" old commit-1-dormant >/dev/null 2>&1; then
  echo 'FAIL: removed ad-hoc dormant interface is still accepted' >&2; exit 1
fi

SHADOW_DIR="$ROOT/path-shadow"; SENTINEL="$ROOT/path-shadow-ran"
mkdir "$SHADOW_DIR"
cp "$HERE/pre-deploy-database-helper.js" "$WRAPPER_ROOT/usr/libexec/osi-pre-deploy-database-helper.js"
chmod 755 "$WRAPPER_ROOT/usr/libexec/osi-pre-deploy-database-helper.js"
for tool in id stat readlink dirname sha256sum node; do
  printf '%s\n' '#!/bin/sh' "printf '%s\\n' '$tool' >>'$SENTINEL'" "exec /usr/bin/$tool \"\$@\"" >"$SHADOW_DIR/$tool"
  chmod 755 "$SHADOW_DIR/$tool"
done
if PATH="$SHADOW_DIR:$PATH" sh "$HERE/backup-pre-deploy.sh" snapshot --purpose command-ledger-disposition \
  --source "$SOURCE" --destination "$ROOT/shadow.db" --manifest-out "$ROOT/shadow.json" \
  --state "$ROOT/state.json" --expected-operation-id op-1 \
  --expected-state-sha256 "$(printf 'a%.0s' $(seq 1 64))" \
  --preparation not-applicable-before-snapshot >"$ROOT/shadow.out" 2>"$ROOT/shadow.err"; then
  echo 'FAIL: deferred snapshot returned success under PATH shadow test' >&2; exit 1
fi
grep -q 'NOT_IMPLEMENTED_IN_THIS_SLICE' "$ROOT/shadow.err"
[ ! -e "$SENTINEL" ] || { echo 'FAIL: backup wrapper executed a caller PATH shadow' >&2; exit 1; }
echo 'backup-pre-deploy deferred purpose boundary: PASS'
