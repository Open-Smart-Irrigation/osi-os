#!/bin/sh
set -eu

BOUNDARY="/tmp/osi-staged-npm-tests-$(id -u)"
mkdir -p "$BOUNDARY"
chmod 700 "$BOUNDARY"
rm -rf "$BOUNDARY/data"
MOUNTINFO="$BOUNDARY/mountinfo.test"
printf '42 1 0:42 / %s rw,relatime - ext4 /dev/test rw\n' "$BOUNDARY/data" >"$MOUNTINFO"
chmod 600 "$MOUNTINFO"
export OSI_STAGED_NPM_TEST_MOUNTINFO="$MOUNTINFO"
ROOT=$(mktemp -d "$BOUNDARY/case-XXXXXX")
ORPHAN_COORD=
ORPHAN_PID=
LEADERLESS_COORD=
LEADERLESS_PGID=
cleanup() {
  [ -z "$ORPHAN_COORD" ] || kill -KILL "$ORPHAN_COORD" 2>/dev/null || true
  [ -z "$ORPHAN_PID" ] || kill -KILL "-$ORPHAN_PID" 2>/dev/null || true
  [ -z "$LEADERLESS_COORD" ] || kill -KILL "$LEADERLESS_COORD" 2>/dev/null || true
  [ -z "$LEADERLESS_PGID" ] || kill -KILL "-$LEADERLESS_PGID" 2>/dev/null || true
  rm -rf "$ROOT"
}
trap cleanup EXIT
STAGE="$BOUNDARY/data/osi-deploy/staging/dep-1"
BIN="$ROOT/bin"
LOG="$ROOT/npm.log"
SIBLING="$ROOT/sibling"
PARENT_SENTINEL="$ROOT/parent-sentinel"
mkdir -p "$STAGE" "$BIN" "$SIBLING"
chmod 700 "$BOUNDARY/data" "$BOUNDARY/data/osi-deploy" "$BOUNDARY/data/osi-deploy/staging" "$STAGE"
printf '%s\n' original >"$PARENT_SENTINEL"
printf '%s\n' original >"$SIBLING/sentinel"
printf '%s\n' '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}' >"$STAGE/package-lock.json"
printf '%s\n' '{"name":"fixture","version":"1.0.0"}' >"$STAGE/package.json"
PACKAGE_BEFORE=$(sha256sum "$STAGE/package.json" | awk '{print $1}')
LOCK_BEFORE=$(sha256sum "$STAGE/package-lock.json" | awk '{print $1}')

cat >"$BIN/ujail" <<'EOF'
#!/bin/sh
set -eu
name= console= essential= user= group= rootfs= readonly=
stage= node_modules= home= cache= tmp= npm= node= shell= envbin= module_tree=
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
  case "$1" in
    -n) name=$2; shift 2 ;;
    -c) console=1; shift ;;
    -E) essential=1; shift ;;
    -N) echo 'unsupported ujail network flag: -N' >&2; exit 70 ;;
    -U) user=$2; shift 2 ;;
    -G) group=$2; shift 2 ;;
    -R) rootfs=$2; shift 2 ;;
    -o) readonly=1; shift ;;
    -r)
      host=${2%%:*}; jail=${2#*:}
      case "$jail" in
        /work/runtime) stage=$host ;;
        /usr/bin/npm) npm=$host ;;
        /usr/bin/node) node=$host ;;
        /bin/sh) shell=$host ;;
        /usr/bin/env) envbin=$host ;;
        /usr/lib/node_modules/npm) module_tree=$host ;;
        *) echo "unexpected readonly mount: $2" >&2; exit 70 ;;
      esac
      shift 2 ;;
    -w)
      host=${2%%:*}; jail=${2#*:}
      case "$jail" in
        /work/runtime/node_modules) node_modules=$host ;;
        /work/home) home=$host ;;
        /work/cache) cache=$host ;;
        /work/tmp) tmp=$host ;;
        *) echo "unexpected writable mount: $2" >&2; exit 70 ;;
      esac
      shift 2 ;;
    *) echo "unsupported ujail test flag: $1" >&2; exit 70 ;;
  esac
done

[ "${1:-}" = -- ] && shift
[ -n "$name" ] && [ "$console" = 1 ] && [ "$essential" = 1 ] && [ "$user" = nobody ] && [ "$group" = nogroup ]
[ -d "$rootfs" ] && [ "$readonly" = 1 ] && [ -n "$stage" ] && [ -n "$node_modules" ]
[ "$(stat -c %a "$rootfs")" = 755 ] || { echo 'extroot is not traversable after uid drop' >&2; exit 70; }
case "${OSI_STAGED_NPM_TEST_REMOVE_IDENTITY:-}" in passwd) rm -f "$rootfs/etc/passwd" ;; group) rm -f "$rootfs/etc/group" ;; esac
[ -f "$rootfs/etc/passwd" ] && [ ! -L "$rootfs/etc/passwd" ] || { echo 'missing extroot passwd identity' >&2; exit 70; }
[ -f "$rootfs/etc/group" ] && [ ! -L "$rootfs/etc/group" ] || { echo 'missing extroot group identity' >&2; exit 70; }
[ "$(cat "$rootfs/etc/passwd")" = 'nobody:x:65534:65534:nobody:/nonexistent:/bin/false' ]
[ "$(cat "$rootfs/etc/group")" = 'nogroup:x:65534:' ]
[ -n "$home" ] && [ -n "$cache" ] && [ -n "$tmp" ] && [ -n "$npm" ] && [ -n "$node" ]
[ -n "$shell" ] && [ -n "$envbin" ] && [ -d "$module_tree" ]
[ "$1" = /bin/sh ] && [ "$2" = -c ]
case "$*" in *npm-jail-identity-mismatch*) ;; *) exit 70 ;; esac
case "$*" in *process.getuid*) ;; *) exit 70 ;; esac
case "$*" in *process.getgid*) ;; *) exit 70 ;; esac
case "$*" in *process.getgroups*) ;; *) exit 70 ;; esac
printf '%s\n' "$name|$user|$group|$rootfs|$*" >>"$UJAIL_LOG"
/usr/bin/bwrap --die-with-parent --unshare-user --unshare-pid --unshare-net \
  --uid 65534 --gid 65534 --tmpfs / --proc /proc --dev /dev \
  --dir /bin --dir /usr --dir /usr/bin --dir /usr/lib --dir /work \
  --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /usr/lib /usr/lib \
  --ro-bind "$shell" /bin/sh --ro-bind "$envbin" /usr/bin/env \
  --ro-bind "$node" /usr/bin/node --ro-bind "$npm" /usr/bin/npm \
  --ro-bind "$module_tree" /usr/lib/node_modules/npm \
  --ro-bind "$stage" /work/runtime \
  --bind "$node_modules" /work/runtime/node_modules --bind "$home" /work/home \
  --bind "$cache" /work/cache --bind "$tmp" /work/tmp -- "$@"
status=$?
[ ! -f "$tmp/npm.log" ] || cat "$tmp/npm.log" >>"$UJAIL_LOG"
exit "$status"
EOF
cat >"$BIN/npm" <<EOF
#!/bin/sh
printf 'argv=%s\n' "\$*" >>/work/tmp/npm.log
printf 'secret=%s\n' "\${OSI_TEST_SECRET-unset}" >>/work/tmp/npm.log
for target in "$PARENT_SENTINEL" "$SIBLING/sentinel" /etc/osi-staged-npm-forbidden; do
  if printf attacked >"\$target" 2>/dev/null; then
    printf 'forbidden-write-succeeded=%s\n' "\$target" >>/work/tmp/npm.log
  else
    printf 'forbidden-write-blocked=%s\n' "\$target" >>/work/tmp/npm.log
  fi
done
case "\$1" in
  ci)
    if [ -e /work/runtime/.long-running ]; then
      exec /usr/bin/node -e 'const fs=require("node:fs"); fs.writeFileSync("/work/runtime/node_modules/orphan.pid",String(process.pid)); let n=0; setInterval(()=>fs.writeFileSync("/work/runtime/node_modules/orphan-heartbeat",String(++n)),20)'
    fi
    printf ok >/work/runtime/node_modules/pkg/index.js
    if [ -e /work/runtime/.make-world-writable ]; then
      printf unsafe >/work/runtime/node_modules/pkg/unsafe.js
      chmod 666 /work/runtime/node_modules/pkg/unsafe.js
    fi
    ;;
  ls) printf '%s\n' '{"name":"fixture"}' ;;
esac
EOF
mkdir -p "$BIN/npm-module-tree" "$STAGE/node_modules/pkg"
cp /usr/bin/node "$BIN/node"
chmod 755 "$BIN/ujail" "$BIN/npm" "$BIN/node"
export OSI_STAGED_NPM_TEST_NODE="$BIN/node"
export OSI_STAGED_NPM_TEST_MODULE_ROOT="$BIN/npm-module-tree"
export UJAIL_LOG="$LOG"
PATH_ATTACK_BIN="$ROOT/path-attack-bin"
PATH_ATTACK_SENTINEL="$ROOT/path-attack-sentinel"
mkdir -p "$PATH_ATTACK_BIN"
printf original >"$PATH_ATTACK_SENTINEL"
for command in sleep node stat sha256sum awk id readlink chmod chown mkdir rm; do
  cat >"$PATH_ATTACK_BIN/$command" <<EOF
#!/bin/sh
printf attacked >"$PATH_ATTACK_SENTINEL"
exec /usr/bin/$command "\$@"
EOF
  chmod 755 "$PATH_ATTACK_BIN/$command"
done

make_authority_stage() {
  authority_id=$1
  authority_stage="$BOUNDARY/data/osi-deploy/staging/$authority_id"
  mkdir -p "$authority_stage/node_modules/pkg"
  chmod 700 "$authority_stage"
  printf '%s\n' '{"name":"fixture","version":"1.0.0"}' >"$authority_stage/package.json"
  printf '%s\n' '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}' >"$authority_stage/package-lock.json"
  printf '%s\n' "$authority_stage"
}

FOREIGN_OWNER_STAGE=$(make_authority_stage dep-foreign-owner)
if OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
  OSI_STAGED_NPM_TEST_REQUIRE_ROOT_OWNER=1 OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$FOREIGN_OWNER_STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-foreign-owner \
  --manifest-out "$FOREIGN_OWNER_STAGE/runtime-dependency-manifest.json" 2>"$ROOT/foreign-owner.err"; then
  echo 'FAIL: a non-root deployment authority was accepted' >&2
  exit 1
fi
grep -Eqi 'root-owned|owner|authority' "$ROOT/foreign-owner.err"
[ ! -e "$FOREIGN_OWNER_STAGE/.npm-ci-intent.json" ]
[ ! -e "$FOREIGN_OWNER_STAGE/.npm-private" ]

for authority_case in group-writable world-writable; do
  authority_stage=$(make_authority_stage "dep-$authority_case")
  case "$authority_case" in
    group-writable) chmod 770 "$BOUNDARY/data/osi-deploy" ;;
    world-writable) chmod 702 "$BOUNDARY/data/osi-deploy/staging" ;;
  esac
  if OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
    OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
    sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$authority_stage" \
    --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id "dep-$authority_case" \
    --manifest-out "$authority_stage/runtime-dependency-manifest.json" 2>"$ROOT/$authority_case.err"; then
    echo "FAIL: $authority_case deployment authority was accepted" >&2
    exit 1
  fi
  chmod 700 "$BOUNDARY/data/osi-deploy" "$BOUNDARY/data/osi-deploy/staging"
  grep -Eqi '0700|mode|authority' "$ROOT/$authority_case.err"
  [ ! -e "$authority_stage/.npm-ci-intent.json" ]
  [ ! -e "$authority_stage/.npm-private" ]
done

SYMLINK_AUTHORITY_REAL="$BOUNDARY/data/osi-deploy/staging/dep-symlink-authority-real"
SYMLINK_AUTHORITY_STAGE="$BOUNDARY/data/osi-deploy/staging/dep-symlink-authority"
mkdir -p "$SYMLINK_AUTHORITY_REAL/node_modules/pkg"
chmod 700 "$SYMLINK_AUTHORITY_REAL"
printf '%s\n' '{"name":"fixture","version":"1.0.0"}' >"$SYMLINK_AUTHORITY_REAL/package.json"
printf '%s\n' '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}' >"$SYMLINK_AUTHORITY_REAL/package-lock.json"
ln -s "$SYMLINK_AUTHORITY_REAL" "$SYMLINK_AUTHORITY_STAGE"
if OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
  OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$SYMLINK_AUTHORITY_STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-symlink-authority \
  --manifest-out "$SYMLINK_AUTHORITY_STAGE/runtime-dependency-manifest.json" 2>"$ROOT/symlink-authority.err"; then
  echo 'FAIL: a symlinked attempt authority was accepted' >&2
  exit 1
fi
grep -Eqi 'symlink|real directory|authority' "$ROOT/symlink-authority.err"
[ ! -e "$SYMLINK_AUTHORITY_REAL/.npm-ci-intent.json" ]
[ ! -e "$SYMLINK_AUTHORITY_REAL/.npm-private" ]

for race in attempt staging; do
  race_stage=$(make_authority_stage "dep-race-$race")
  if OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
    OSI_STAGED_NPM_TEST_AUTHORITY_RACE="$race" OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
    sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$race_stage" \
    --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id "dep-race-$race" \
    --manifest-out "$race_stage/runtime-dependency-manifest.json" 2>"$ROOT/race-$race.err"; then
    echo "FAIL: $race authority replacement was accepted" >&2
    exit 1
  fi
  case "$race" in
    attempt)
      rm -rf "$race_stage"
      mv "$race_stage.authority-race-original" "$race_stage"
      ;;
    staging)
      rm -rf "$BOUNDARY/data/osi-deploy/staging"
      mv "$BOUNDARY/data/osi-deploy/staging.authority-race-original" "$BOUNDARY/data/osi-deploy/staging"
      ;;
  esac
  grep -Eqi 'changed|inode|authority' "$ROOT/race-$race.err"
  [ ! -e "$race_stage/.npm-ci-intent.json" ]
  [ ! -e "$race_stage/.npm-private" ]
done

PATH="$PATH_ATTACK_BIN:/usr/bin:/bin" OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_TEST_SECRET=must-not-leak OSI_STAGED_NPM_TEST_MODE=1 \
OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
sh "$(dirname "$0")/run-staged-npm-ci.sh" \
  --staging-root "$STAGE" --target-manifest-sha256 "$(printf '%064d' 0)" \
  --deployment-id dep-1 --manifest-out "$STAGE/runtime-dependency-manifest.json"

grep -q 'argv=ci --omit=dev --no-fund --no-audit' "$LOG"
grep -q 'argv=ls --omit=dev --json' "$LOG"
grep -q 'secret=unset' "$LOG"
! grep -q 'forbidden-write-succeeded' "$LOG"
[ "$(cat "$PARENT_SENTINEL")" = original ]
[ "$(cat "$SIBLING/sentinel")" = original ]
[ "$(cat "$PATH_ATTACK_SENTINEL")" = original ]
[ ! -e /etc/osi-staged-npm-forbidden ]
[ "$(sha256sum "$STAGE/package.json" | awk '{print $1}')" = "$PACKAGE_BEFORE" ]
[ "$(sha256sum "$STAGE/package-lock.json" | awk '{print $1}')" = "$LOCK_BEFORE" ]
[ "$(stat -c %a "$STAGE")" = 700 ]
[ "$(stat -c %a "$STAGE/runtime-dependency-manifest.json")" = 600 ]
grep -q 'osi-staged-npm|nobody|nogroup' "$LOG"
! grep -q -- '--help' "$LOG"
node -e "const m=require(process.argv[1]); if(m.format!==1||m.deploymentId!=='dep-1'||!Array.isArray(m.entries)||m.entries.length<3) process.exit(1)" "$STAGE/runtime-dependency-manifest.json"

MISSING_IDENTITY_STAGE="$BOUNDARY/data/osi-deploy/staging/dep-missing-identity"
mkdir -p "$MISSING_IDENTITY_STAGE/node_modules/pkg"; chmod 700 "$MISSING_IDENTITY_STAGE"
printf '%s\n' '{"name":"fixture","version":"1.0.0"}' >"$MISSING_IDENTITY_STAGE/package.json"
printf '%s\n' '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}' >"$MISSING_IDENTITY_STAGE/package-lock.json"
if OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
  OSI_STAGED_NPM_TEST_REMOVE_IDENTITY=group OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$MISSING_IDENTITY_STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-missing-identity \
  --manifest-out "$MISSING_IDENTITY_STAGE/runtime-dependency-manifest.json" 2>"$ROOT/missing-identity.err"; then
  echo 'FAIL: jailed npm ran without its extroot group identity' >&2
  exit 1
fi
grep -q 'missing extroot group identity' "$ROOT/missing-identity.err"
[ ! -e "$MISSING_IDENTITY_STAGE/runtime-dependency-manifest.json" ]

CRASH_755_STAGE="$BOUNDARY/data/osi-deploy/staging/dep-crash-755"
mkdir -p "$CRASH_755_STAGE/node_modules/pkg"; chmod 700 "$CRASH_755_STAGE"
printf '%s\n' '{"name":"fixture","version":"1.0.0"}' >"$CRASH_755_STAGE/package.json"
printf '%s\n' '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}' >"$CRASH_755_STAGE/package-lock.json"
set +e
OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
  OSI_STAGED_NPM_TEST_CRASH_AT=after-stage-0755 OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$CRASH_755_STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-crash-755 \
  --manifest-out "$CRASH_755_STAGE/runtime-dependency-manifest.json"
CRASH_STATUS=$?
set -e
[ "$CRASH_STATUS" -eq 137 ]
[ "$(stat -c %a "$CRASH_755_STAGE")" = 755 ]
[ -f "$CRASH_755_STAGE/.npm-ci-intent.json" ]
OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
  OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$CRASH_755_STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-crash-755 \
  --manifest-out "$CRASH_755_STAGE/runtime-dependency-manifest.json"
[ "$(stat -c %a "$CRASH_755_STAGE")" = 700 ]
[ ! -e "$CRASH_755_STAGE/.npm-ci-intent.json" ]

CRASH_MANIFEST_STAGE="$BOUNDARY/data/osi-deploy/staging/dep-crash-manifest"
mkdir -p "$CRASH_MANIFEST_STAGE/node_modules/pkg"; chmod 700 "$CRASH_MANIFEST_STAGE"
printf '%s\n' '{"name":"fixture","version":"1.0.0"}' >"$CRASH_MANIFEST_STAGE/package.json"
printf '%s\n' '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}' >"$CRASH_MANIFEST_STAGE/package-lock.json"
set +e
OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
  OSI_STAGED_NPM_TEST_CRASH_AT=after-manifest-publication OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$CRASH_MANIFEST_STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-crash-manifest \
  --manifest-out "$CRASH_MANIFEST_STAGE/runtime-dependency-manifest.json"
CRASH_STATUS=$?
set -e
[ "$CRASH_STATUS" -eq 137 ]
[ "$(stat -c %a "$CRASH_MANIFEST_STAGE")" = 700 ]
[ -f "$CRASH_MANIFEST_STAGE/runtime-dependency-manifest.json" ]
CRASH_MANIFEST_SHA=$(sha256sum "$CRASH_MANIFEST_STAGE/runtime-dependency-manifest.json" | awk '{print $1}')
OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
  OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$CRASH_MANIFEST_STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-crash-manifest \
  --manifest-out "$CRASH_MANIFEST_STAGE/runtime-dependency-manifest.json"
[ "$(sha256sum "$CRASH_MANIFEST_STAGE/runtime-dependency-manifest.json" | awk '{print $1}')" = "$CRASH_MANIFEST_SHA" ]

# Every durable staged-npm lifecycle boundary must be restartable after the
# privileged coordinator is killed. In particular, the supervisor must write
# its own PID/starttime/process-group record before a permit can make npm run;
# otherwise spawned-pre-record is an untrackable writer window.
for lifecycle_boundary in \
  after-launch-published \
  after-supervisor-spawned \
  after-process-observed \
  after-permit-published \
  cleanup-after-permit-unlink \
  cleanup-after-permit-fsync \
  cleanup-after-launch-unlink \
  cleanup-after-launch-fsync \
  cleanup-after-record-unlink \
  cleanup-after-record-fsync
do
  lifecycle_id="dep-lifecycle-${lifecycle_boundary}"
  lifecycle_stage="$BOUNDARY/data/osi-deploy/staging/$lifecycle_id"
  mkdir -p "$lifecycle_stage/node_modules/pkg"
  chmod 700 "$lifecycle_stage"
  printf '%s\n' '{"name":"fixture","version":"1.0.0"}' >"$lifecycle_stage/package.json"
  printf '%s\n' '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}' >"$lifecycle_stage/package-lock.json"
  set +e
  OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
    OSI_STAGED_NPM_TEST_CRASH_AT="$lifecycle_boundary" \
    OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
    sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$lifecycle_stage" \
    --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id "$lifecycle_id" \
    --manifest-out "$lifecycle_stage/runtime-dependency-manifest.json"
  lifecycle_status=$?
  set -e
  [ "$lifecycle_status" -eq 137 ] || {
    echo "FAIL: lifecycle crash adapter $lifecycle_boundary did not stop at its boundary" >&2
    exit 1
  }
  if [ "$lifecycle_boundary" = cleanup-after-record-unlink ]; then
    # With all names absent after the final unlink, retry still has to fsync
    # the lifecycle directory. Otherwise that unlink is not durable across a
    # power loss even though a same-boot retry appears clean.
    lifecycle_log_lines_before=$(wc -l <"$LOG")
    set +e
    OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
      OSI_STAGED_NPM_TEST_CRASH_AT=cleanup-after-record-fsync \
      OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
      sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$lifecycle_stage" \
      --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id "$lifecycle_id" \
      --manifest-out "$lifecycle_stage/runtime-dependency-manifest.json"
    lifecycle_resume_status=$?
    set -e
    [ "$lifecycle_resume_status" -eq 137 ] || {
      echo 'FAIL: empty lifecycle retry did not repeat the final directory fsync' >&2
      exit 1
    }
    [ "$(wc -l <"$LOG")" -eq "$lifecycle_log_lines_before" ] || {
      echo 'FAIL: retry spawned npm before completing the interrupted lifecycle fsync' >&2
      exit 1
    }
  fi
  timeout 30s env OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
    OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
    sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$lifecycle_stage" \
    --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id "$lifecycle_id" \
    --manifest-out "$lifecycle_stage/runtime-dependency-manifest.json"
  [ -f "$lifecycle_stage/runtime-dependency-manifest.json" ]
  [ "$(stat -c %a "$lifecycle_stage")" = 700 ]
  [ ! -e "$lifecycle_stage/.npm-private/npm-ci-launch.json" ]
  [ ! -e "$lifecycle_stage/.npm-private/npm-ci-process.json" ]
  [ ! -e "$lifecycle_stage/.npm-private/npm-ci-run.permit" ]
done

SUPERVISOR_CRASH_STAGE="$BOUNDARY/data/osi-deploy/staging/dep-supervisor-pre-record"
mkdir -p "$SUPERVISOR_CRASH_STAGE/node_modules/pkg"
chmod 700 "$SUPERVISOR_CRASH_STAGE"
printf '%s\n' '{"name":"fixture","version":"1.0.0"}' >"$SUPERVISOR_CRASH_STAGE/package.json"
printf '%s\n' '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}' >"$SUPERVISOR_CRASH_STAGE/package-lock.json"
set +e
OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
  OSI_STAGED_NPM_TEST_SUPERVISOR_CRASH_AT=before-process-publication \
  OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$SUPERVISOR_CRASH_STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-supervisor-pre-record \
  --manifest-out "$SUPERVISOR_CRASH_STAGE/runtime-dependency-manifest.json"
SUPERVISOR_CRASH_STATUS=$?
set -e
[ "$SUPERVISOR_CRASH_STATUS" -ne 0 ] || {
  echo 'FAIL: spawned supervisor pre-record crash still reported success' >&2
  exit 1
}
[ ! -e "$SUPERVISOR_CRASH_STAGE/runtime-dependency-manifest.json" ]
[ ! -e "$SUPERVISOR_CRASH_STAGE/node_modules/pkg/index.js" ]
timeout 30s env OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
  OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$SUPERVISOR_CRASH_STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-supervisor-pre-record \
  --manifest-out "$SUPERVISOR_CRASH_STAGE/runtime-dependency-manifest.json"
[ -f "$SUPERVISOR_CRASH_STAGE/runtime-dependency-manifest.json" ]

SPLIT_STAGE="$BOUNDARY/data/osi-deploy/staging/dep-split-authority"
mkdir -p "$SPLIT_STAGE/node_modules/pkg" "$SPLIT_STAGE/.npm-private"
chmod 700 "$SPLIT_STAGE" "$SPLIT_STAGE/.npm-private"
printf '%s\n' '{"name":"fixture","version":"1.0.0"}' >"$SPLIT_STAGE/package.json"
printf '%s\n' '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}' >"$SPLIT_STAGE/package-lock.json"
printf '%s\n' '{"format":2,"kind":"STAGED_NPM_CI_LAUNCH","deploymentId":"dep-split-authority","phase":"install","launchNonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' \
  >"$SPLIT_STAGE/.npm-private/npm-ci-launch.json"
printf '%s\n' '{"format":2,"kind":"STAGED_NPM_CI_PROCESS","deploymentId":"dep-split-authority","phase":"install","launchNonce":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","pid":2147483000,"processGroupId":2147483000,"starttime":"1"}' \
  >"$SPLIT_STAGE/.npm-private/npm-ci-process.json"
chmod 600 "$SPLIT_STAGE/.npm-private/npm-ci-launch.json" "$SPLIT_STAGE/.npm-private/npm-ci-process.json"
timeout 30s env OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
  OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$SPLIT_STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-split-authority \
  --manifest-out "$SPLIT_STAGE/runtime-dependency-manifest.json"
[ -f "$SPLIT_STAGE/runtime-dependency-manifest.json" ]

WRONG_STAGE="$BOUNDARY/data/other/dep-1"
mkdir -p "$WRONG_STAGE"
chmod 700 "$WRONG_STAGE"
printf '%s\n' '{}' >"$WRONG_STAGE/package.json"
printf '%s\n' '{}' >"$WRONG_STAGE/package-lock.json"
if OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$WRONG_STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-1 --manifest-out "$WRONG_STAGE/manifest.json"; then
  echo 'FAIL: staging outside exact per-attempt subtree accepted' >&2
  exit 1
fi

if OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-1 --manifest-out "$ROOT/outside-manifest.json"; then
  echo 'FAIL: manifest outside the attempt subtree accepted' >&2
  exit 1
fi

if OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 OSI_STAGED_NPM_TEST_UJAIL="$ROOT/missing" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-2 --manifest-out "$ROOT/no.json"; then
  echo 'FAIL: missing ujail accepted' >&2
  exit 1
fi

if OSI_REPAIR_PROGRAM_MODE=1 OSI_STAGED_NPM_TEST_MODE=1 OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" OSI_DEPLOY_ARTIFACT_MODE=live \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-live --manifest-out "$ROOT/live.json"; then
  echo 'FAIL: test adapter accepted live artifact mode' >&2
  exit 1
fi

if OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root / \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-protected --manifest-out "$ROOT/protected.json" 2>"$ROOT/protected.err"; then
  echo 'FAIL: protected live root accepted' >&2
  exit 1
fi
grep -qi protected "$ROOT/protected.err"

if OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 OSI_STAGED_NPM_TEST_UJAIL=/bin/true OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-adapter --manifest-out "$ROOT/adapter.json" 2>"$ROOT/adapter.err"; then
  echo 'FAIL: adapter outside fixed test boundary accepted' >&2
  exit 1
fi
grep -qi boundary "$ROOT/adapter.err"

RECLAIM_STAGE="$BOUNDARY/data/osi-deploy/staging/dep-reclaim"
mkdir -p "$RECLAIM_STAGE/node_modules/pkg"; chmod 700 "$RECLAIM_STAGE"
printf '%s\n' '{"name":"fixture","version":"1.0.0"}' >"$RECLAIM_STAGE/package.json"
printf '%s\n' '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}' >"$RECLAIM_STAGE/package-lock.json"
if OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
  OSI_STAGED_NPM_TEST_RECLAIM_FAILURE=1 OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$RECLAIM_STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-reclaim \
  --manifest-out "$RECLAIM_STAGE/runtime-dependency-manifest.json" 2>"$ROOT/reclaim.err"; then
  echo 'FAIL: reclaim ownership failure still published a manifest' >&2
  exit 1
fi
[ ! -e "$RECLAIM_STAGE/runtime-dependency-manifest.json" ]
grep -Eqi 'reclaim|owner' "$ROOT/reclaim.err"

OWNERSHIP_STAGE="$BOUNDARY/data/osi-deploy/staging/dep-ownership"
mkdir -p "$OWNERSHIP_STAGE/node_modules/pkg"; chmod 700 "$OWNERSHIP_STAGE"
printf '%s\n' '{"name":"fixture","version":"1.0.0"}' >"$OWNERSHIP_STAGE/package.json"
printf '%s\n' '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}' >"$OWNERSHIP_STAGE/package-lock.json"
printf original >"$ROOT/ownership-escape-target"
ln -s "$ROOT/ownership-escape-target" "$OWNERSHIP_STAGE/node_modules/pkg/escape-link"
CHOWN_BIN="$ROOT/chown-bin"
mkdir -p "$CHOWN_BIN"
cat >"$CHOWN_BIN/chown" <<EOF
#!/bin/sh
# Model target BusyBox recursive chown following an escaping symlink. The
# production implementation must not invoke this recursive utility at all.
for candidate in "\$@"; do
  if [ -L "\$candidate/pkg/escape-link" ]; then printf attacked >"$ROOT/ownership-escape-target"; fi
done
exec /usr/bin/chown "\$@"
EOF
chmod 755 "$CHOWN_BIN/chown"
if PATH="$CHOWN_BIN:/usr/bin:/bin" OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
  OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$OWNERSHIP_STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-ownership \
  --manifest-out "$OWNERSHIP_STAGE/runtime-dependency-manifest.json" 2>"$ROOT/ownership.err"; then
  echo 'FAIL: escaping ownership symlink was published' >&2
  exit 1
fi
[ "$(cat "$ROOT/ownership-escape-target")" = original ]
node - "$OWNERSHIP_STAGE" <<'NODE'
const fs = require('node:fs'); const path = require('node:path');
const root = process.argv[2]; const uid = process.getuid();
function visit(candidate) {
  const stat = fs.lstatSync(candidate);
  if (stat.uid !== uid) throw new Error(`entry was not reclaimed without following links: ${candidate}`);
  if (stat.isDirectory()) for (const name of fs.readdirSync(candidate)) visit(path.join(candidate, name));
}
visit(root);
NODE

UNSAFE_MODE_STAGE="$BOUNDARY/data/osi-deploy/staging/dep-unsafe-mode"
mkdir -p "$UNSAFE_MODE_STAGE/node_modules/pkg"; chmod 700 "$UNSAFE_MODE_STAGE"
printf '%s\n' '{"name":"fixture","version":"1.0.0"}' >"$UNSAFE_MODE_STAGE/package.json"
printf '%s\n' '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}' >"$UNSAFE_MODE_STAGE/package-lock.json"
printf marker >"$UNSAFE_MODE_STAGE/.make-world-writable"
if OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
  OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$UNSAFE_MODE_STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-unsafe-mode \
  --manifest-out "$UNSAFE_MODE_STAGE/runtime-dependency-manifest.json" 2>"$ROOT/unsafe-mode.err"; then
  echo 'FAIL: group/world-writable staged output was published' >&2
  exit 1
fi
[ ! -e "$UNSAFE_MODE_STAGE/runtime-dependency-manifest.json" ]
[ -s "$ROOT/unsafe-mode.err" ]

SYMLINK_STAGE="$BOUNDARY/data/osi-deploy/staging/dep-symlink"
mkdir -p "$SYMLINK_STAGE"; chmod 700 "$SYMLINK_STAGE"
printf '%s\n' '{"name":"fixture","version":"1.0.0"}' >"$SYMLINK_STAGE/real-package.json"
ln -s real-package.json "$SYMLINK_STAGE/package.json"
printf '%s\n' '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}' >"$SYMLINK_STAGE/package-lock.json"
if OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$SYMLINK_STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-symlink --manifest-out "$SYMLINK_STAGE/manifest.json" 2>"$ROOT/symlink.err"; then
  echo 'FAIL: symlinked package.json accepted' >&2
  exit 1
fi
grep -qi nonsymlink "$ROOT/symlink.err"

for kind in escape missing cycle special; do
  BAD_STAGE="$BOUNDARY/data/osi-deploy/staging/dep-$kind"
  mkdir -p "$BAD_STAGE/node_modules/pkg"; chmod 700 "$BAD_STAGE"
  printf '%s\n' '{"name":"fixture","version":"1.0.0"}' >"$BAD_STAGE/package.json"
  printf '%s\n' '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}' >"$BAD_STAGE/package-lock.json"
  case "$kind" in
    escape) ln -s "$ROOT/outside-target" "$BAD_STAGE/bad-link" ;;
    missing) ln -s missing-target "$BAD_STAGE/bad-link" ;;
    cycle) ln -s cycle-b "$BAD_STAGE/cycle-a"; ln -s cycle-a "$BAD_STAGE/cycle-b" ;;
    special) mkfifo "$BAD_STAGE/bad-fifo" ;;
  esac
  if OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
    OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
    sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$BAD_STAGE" \
    --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id "dep-$kind" \
    --manifest-out "$BAD_STAGE/runtime-dependency-manifest.json" 2>"$ROOT/$kind.err"; then
    echo "FAIL: $kind staged entry accepted" >&2
    exit 1
  fi
  grep -Eqi 'escaping|missing|cyclic|special|unsupported' "$ROOT/$kind.err"
  [ ! -e "$BAD_STAGE/runtime-dependency-manifest.json" ]
done

ORPHAN_STAGE="$BOUNDARY/data/osi-deploy/staging/dep-orphan"
mkdir -p "$ORPHAN_STAGE/node_modules/pkg"
chmod 700 "$ORPHAN_STAGE"
printf '%s\n' '{"name":"fixture","version":"1.0.0"}' >"$ORPHAN_STAGE/package.json"
printf '%s\n' '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}' >"$ORPHAN_STAGE/package-lock.json"
printf marker >"$ORPHAN_STAGE/.long-running"
OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
  OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$ORPHAN_STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-orphan \
  --manifest-out "$ORPHAN_STAGE/runtime-dependency-manifest.json" >"$ROOT/orphan-first.out" 2>"$ROOT/orphan-first.err" &
ORPHAN_COORD=$!
tries=0
while [ ! -s "$ORPHAN_STAGE/node_modules/orphan.pid" ] && [ "$tries" -lt 250 ]; do
  sleep 0.02
  tries=$((tries + 1))
done
[ -s "$ORPHAN_STAGE/node_modules/orphan.pid" ]
[ -f "$ORPHAN_STAGE/.npm-private/npm-ci-process.json" ]
ORPHAN_PID=$(node -e 'process.stdout.write(String(require(process.argv[1]).pid))' "$ORPHAN_STAGE/.npm-private/npm-ci-process.json")
node - "$ORPHAN_STAGE/.npm-private/npm-ci-launch.json" "$ORPHAN_STAGE/.npm-private/npm-ci-process.json" \
  "$ORPHAN_STAGE/.npm-private/npm-ci-run.permit" <<'NODE'
'use strict';
const fs = require('node:fs');
const launch = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const record = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const permit = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
if (launch.format !== 2 || launch.kind !== 'STAGED_NPM_CI_LAUNCH'
    || record.format !== 2 || record.kind !== 'STAGED_NPM_CI_PROCESS'
    || record.processGroupId !== record.pid || !/^\d+$/.test(record.starttime)
    || record.launchNonce !== launch.launchNonce
    || permit.kind !== 'STAGED_NPM_CI_RUN_PERMIT' || permit.launchNonce !== record.launchNonce) process.exit(1);
NODE
kill -KILL "$ORPHAN_COORD"
wait "$ORPHAN_COORD" 2>/dev/null || true
ORPHAN_COORD=
kill -0 "$ORPHAN_PID"
rm -f "$ORPHAN_STAGE/.long-running"
timeout 30s env OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
  OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$ORPHAN_STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-orphan \
  --manifest-out "$ORPHAN_STAGE/runtime-dependency-manifest.json"
if kill -0 "$ORPHAN_PID" 2>/dev/null; then
  echo 'FAIL: retry left the prior jailed npm process alive' >&2
  exit 1
fi
ORPHAN_PID=
[ -f "$ORPHAN_STAGE/runtime-dependency-manifest.json" ]
[ ! -e "$ORPHAN_STAGE/.npm-private/npm-ci-process.json" ]
ORPHAN_HEARTBEAT=$(cat "$ORPHAN_STAGE/node_modules/orphan-heartbeat")
sleep 0.1
[ "$(cat "$ORPHAN_STAGE/node_modules/orphan-heartbeat")" = "$ORPHAN_HEARTBEAT" ]

LEADERLESS_STAGE="$BOUNDARY/data/osi-deploy/staging/dep-leaderless"
mkdir -p "$LEADERLESS_STAGE/node_modules/pkg"
chmod 700 "$LEADERLESS_STAGE"
printf '%s\n' '{"name":"fixture","version":"1.0.0"}' >"$LEADERLESS_STAGE/package.json"
printf '%s\n' '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}' >"$LEADERLESS_STAGE/package-lock.json"
printf marker >"$LEADERLESS_STAGE/.long-running"
OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
  OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$LEADERLESS_STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-leaderless \
  --manifest-out "$LEADERLESS_STAGE/runtime-dependency-manifest.json" >"$ROOT/leaderless-first.out" 2>"$ROOT/leaderless-first.err" &
LEADERLESS_COORD=$!
tries=0
while { [ ! -s "$LEADERLESS_STAGE/node_modules/orphan.pid" ] || [ ! -s "$LEADERLESS_STAGE/.npm-private/npm-ci-process.json" ]; } \
  && [ "$tries" -lt 250 ]
do
  sleep 0.02
  tries=$((tries + 1))
done
[ -s "$LEADERLESS_STAGE/node_modules/orphan.pid" ]
[ -s "$LEADERLESS_STAGE/.npm-private/npm-ci-process.json" ]
LEADERLESS_PGID=$(node -e 'const r=require(process.argv[1]); if(r.processGroupId!==r.pid) process.exit(1); process.stdout.write(String(r.processGroupId))' \
  "$LEADERLESS_STAGE/.npm-private/npm-ci-process.json")
kill -KILL "$LEADERLESS_COORD"
wait "$LEADERLESS_COORD" 2>/dev/null || true
LEADERLESS_COORD=
kill -KILL "$LEADERLESS_PGID"
tries=0
while [ -e "/proc/$LEADERLESS_PGID" ] && [ "$tries" -lt 100 ]; do sleep 0.02; tries=$((tries + 1)); done
node - "$LEADERLESS_PGID" <<'NODE'
'use strict';
const fs = require('node:fs');
const pgid = Number(process.argv[2]);
let descendants = 0;
for (const entry of fs.readdirSync('/proc')) {
  if (!/^\d+$/.test(entry)) continue;
  try {
    const raw = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(') ') + 2).trim().split(/\s+/);
    if (fields[0] !== 'Z' && Number(fields[2]) === pgid) descendants += 1;
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
}
if (descendants === 0) throw new Error('leader death did not leave the required descendant recovery case');
NODE
rm -f "$LEADERLESS_STAGE/.long-running"
timeout 30s env OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
  OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$LEADERLESS_STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-leaderless \
  --manifest-out "$LEADERLESS_STAGE/runtime-dependency-manifest.json"
[ -f "$LEADERLESS_STAGE/runtime-dependency-manifest.json" ]
[ ! -e "$LEADERLESS_STAGE/.npm-private/npm-ci-process.json" ]
LEADERLESS_PGID=

UNTRACKED_STAGE="$BOUNDARY/data/osi-deploy/staging/dep-untracked"
mkdir -p "$UNTRACKED_STAGE/.npm-private"; chmod 700 "$UNTRACKED_STAGE" "$UNTRACKED_STAGE/.npm-private"
printf '%s\n' '{"name":"fixture","version":"1.0.0"}' >"$UNTRACKED_STAGE/package.json"
printf '%s\n' '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}' >"$UNTRACKED_STAGE/package-lock.json"
printf '%s\n' '{"format":1,"kind":"STAGED_NPM_CI_LAUNCH","deploymentId":"dep-untracked","phase":"install"}' >"$UNTRACKED_STAGE/.npm-private/npm-ci-launch.json"
chmod 600 "$UNTRACKED_STAGE/.npm-private/npm-ci-launch.json"
if OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
  OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
  sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$UNTRACKED_STAGE" \
  --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id dep-untracked \
  --manifest-out "$UNTRACKED_STAGE/runtime-dependency-manifest.json" 2>"$ROOT/untracked.err"; then
  echo 'FAIL: retry mutated an untracked prior npm launch' >&2
  exit 1
fi
grep -Eqi 'authenticate|process.*missing|quiesce' "$ROOT/untracked.err"
[ ! -e "$UNTRACKED_STAGE/node_modules" ]
[ "$(stat -c %a "$UNTRACKED_STAGE")" = 700 ]

for kind in private cache home tmp node-modules; do
  MUTATION_STAGE="$BOUNDARY/data/osi-deploy/staging/dep-mutation-$kind"
  MUTATION_OUTSIDE="$ROOT/mutation-outside-$kind"
  mkdir -p "$MUTATION_STAGE" "$MUTATION_OUTSIDE"
  chmod 700 "$MUTATION_STAGE"
  chmod 755 "$MUTATION_OUTSIDE"
  printf original >"$MUTATION_OUTSIDE/sentinel"
  printf '%s\n' '{"name":"fixture","version":"1.0.0"}' >"$MUTATION_STAGE/package.json"
  printf '%s\n' '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}' >"$MUTATION_STAGE/package-lock.json"
  case "$kind" in
    private) ln -s "$MUTATION_OUTSIDE" "$MUTATION_STAGE/.npm-private" ;;
    cache)
      mkdir -p "$MUTATION_STAGE/.npm-private"
      ln -s "$MUTATION_OUTSIDE" "$MUTATION_STAGE/.npm-private/cache"
      ;;
    home)
      mkdir -p "$MUTATION_STAGE/.npm-private"
      ln -s "$MUTATION_OUTSIDE" "$MUTATION_STAGE/.npm-private/home"
      ;;
    tmp)
      mkdir -p "$MUTATION_STAGE/.npm-private"
      ln -s "$MUTATION_OUTSIDE" "$MUTATION_STAGE/.npm-private/tmp"
      ;;
    node-modules) ln -s "$MUTATION_OUTSIDE" "$MUTATION_STAGE/node_modules" ;;
  esac
  if OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test OSI_STAGED_NPM_TEST_MODE=1 \
    OSI_STAGED_NPM_TEST_UJAIL="$BIN/ujail" OSI_STAGED_NPM_TEST_NPM="$BIN/npm" \
    sh "$(dirname "$0")/run-staged-npm-ci.sh" --staging-root "$MUTATION_STAGE" \
    --target-manifest-sha256 "$(printf '%064d' 0)" --deployment-id "dep-mutation-$kind" \
    --manifest-out "$MUTATION_STAGE/runtime-dependency-manifest.json" 2>"$ROOT/mutation-$kind.err"; then
    echo "FAIL: symlinked $kind mutation root was accepted" >&2
    exit 1
  fi
  [ "$(cat "$MUTATION_OUTSIDE/sentinel")" = original ]
  [ "$(stat -c %a "$MUTATION_OUTSIDE")" = 755 ]
  [ "$(find "$MUTATION_OUTSIDE" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ]
  [ ! -e "$MUTATION_STAGE/runtime-dependency-manifest.json" ]
done

grep -q '/sbin/ujail' "$(dirname "$0")/run-staged-npm-ci.sh"
grep -q '65534' "$(dirname "$0")/run-staged-npm-ci.sh"
! grep -q -- '--help' "$(dirname "$0")/run-staged-npm-ci.sh"
! grep -Eq -- '(^|[[:space:]])-u([[:space:]]|$)|(^|[[:space:]])-g([[:space:]]|$)' "$(dirname "$0")/run-staged-npm-ci.sh"
! grep -Eq -- '(^|[[:space:]])-N([[:space:]]|$)' "$(dirname "$0")/run-staged-npm-ci.sh"
grep -Eq -- '(^|[[:space:]])-c[[:space:]]+-E([[:space:]]|$)' "$(dirname "$0")/run-staged-npm-ci.sh"
grep -q '^PATH=/usr/bin:/bin$' "$(dirname "$0")/run-staged-npm-ci.sh"
echo 'run-staged-npm-ci: PASS'
