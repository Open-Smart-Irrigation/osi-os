#!/bin/sh
set -eu

# This wrapper runs privileged. Never inherit a caller-controlled command path.
PATH=/usr/bin:/bin
export PATH

fail() {
    printf 'run-staged-npm-ci: %s\n' "$1" >&2
    exit 1
}

STAGING_ROOT=
TARGET_MANIFEST_SHA256=
DEPLOYMENT_ID=
MANIFEST_OUT=

while [ "$#" -gt 0 ]; do
    [ "$#" -ge 2 ] || fail "missing value for $1"
    case "$1" in
        --staging-root) [ -z "$STAGING_ROOT" ] || fail 'duplicate --staging-root'; STAGING_ROOT=$2 ;;
        --target-manifest-sha256) [ -z "$TARGET_MANIFEST_SHA256" ] || fail 'duplicate --target-manifest-sha256'; TARGET_MANIFEST_SHA256=$2 ;;
        --deployment-id) [ -z "$DEPLOYMENT_ID" ] || fail 'duplicate --deployment-id'; DEPLOYMENT_ID=$2 ;;
        --manifest-out) [ -z "$MANIFEST_OUT" ] || fail 'duplicate --manifest-out'; MANIFEST_OUT=$2 ;;
        *) fail "unknown flag $1" ;;
    esac
    shift 2
done

for value in "$STAGING_ROOT" "$MANIFEST_OUT"; do
    case "$value" in /*) ;; *) fail 'staging root and manifest output must be absolute' ;; esac
done
case "$STAGING_ROOT" in
    /|/bin|/bin/*|/boot|/boot/*|/dev|/dev/*|/etc|/etc/*|/lib|/lib/*|/lib64|/lib64/*|/proc|/proc/*|/root|/root/*|/run|/run/*|/sbin|/sbin/*|/srv|/srv/*|/sys|/sys/*|/tmp|/usr|/usr/*|/var|/var/*|/data|/data/db|/data/db/*)
        fail 'protected root cannot be used as a staging authority'
        ;;
esac
[ -n "$DEPLOYMENT_ID" ] || fail 'missing --deployment-id'
case "$TARGET_MANIFEST_SHA256" in
    *[!0-9a-f]*|'') fail 'target manifest sha256 must be lowercase hexadecimal' ;;
esac
[ "${#TARGET_MANIFEST_SHA256}" -eq 64 ] || fail 'target manifest sha256 must contain 64 characters'

PREFLIGHT_STAGE_JAIL_VISIBLE=0
STATE_LIB=/usr/libexec/osi-deployment-state.js
HOST_NODE=/usr/bin/node
HOST_CHMOD=/bin/chmod
HOST_ID=/usr/bin/id
HOST_READLINK=/usr/bin/readlink
HOST_RM=/bin/rm
HOST_SHA256SUM=/usr/bin/sha256sum
[ -x "$HOST_NODE" ] || fail 'node is unavailable'
for host_tool in "$HOST_CHMOD" "$HOST_ID" "$HOST_READLINK" "$HOST_RM" "$HOST_SHA256SUM"; do
    [ -x "$host_tool" ] || fail "required host utility is unavailable: $host_tool"
done
HOST_UID=$("$HOST_ID" -u)
HOST_GID=$("$HOST_ID" -g)
hash_file() {
    checksum=$("$HOST_SHA256SUM" "$1") || return 1
    printf '%s\n' "${checksum%% *}"
}
if [ "${OSI_STAGED_NPM_TEST_MODE:-0}" = 1 ]; then
    SCRIPT_DIR=${0%/*}
    [ "$SCRIPT_DIR" != "$0" ] || SCRIPT_DIR=.
    STATE_LIB=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)/lib/deployment-state.js
fi
preflight() {
expected_authority=${1:-}
"$HOST_NODE" - "$STAGING_ROOT" "$MANIFEST_OUT" "$DEPLOYMENT_ID" "${OSI_STAGED_NPM_TEST_MODE:-0}" "${OSI_STAGED_NPM_TEST_UJAIL:-}" "${OSI_STAGED_NPM_TEST_NPM:-}" "$PREFLIGHT_STAGE_JAIL_VISIBLE" "$STATE_LIB" "$expected_authority" "${OSI_STAGED_NPM_TEST_REQUIRE_ROOT_OWNER:-0}" <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [stageArg, manifestArg, deploymentId, testMode, ujail, npm, jailVisible, stateLibPath,
  expectedAuthority, requireRootOwner] = process.argv.slice(2);
const stateLib = require(stateLibPath);
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(deploymentId) || deploymentId.includes('..')) throw new Error('unsafe deployment id');
const boundary = `/tmp/osi-staged-npm-tests-${process.getuid()}`;
const dataRoot = testMode === '1' ? `${boundary}/data` : '/data';
if (testMode !== '1' && (process.getuid() !== 0 || process.getgid() !== 0)) {
  throw new Error('live staged npm requires a root-owned authority process');
}
if (testMode === '1' && requireRootOwner !== '0' && requireRootOwner !== '1') {
  throw new Error('invalid test root-owner adapter');
}
const authorityUid = testMode === '1' && requireRootOwner !== '1' ? process.getuid() : 0;
const authorityGid = testMode === '1' && requireRootOwner !== '1' ? process.getgid() : 0;
const stage = path.resolve(stageArg);
const manifest = path.resolve(manifestArg);
const deployRoot = path.join(dataRoot, 'osi-deploy');
const stagingRoot = path.join(deployRoot, 'staging');
const expectedStage = path.join(dataRoot, 'osi-deploy', 'staging', deploymentId);
if (stage !== expectedStage) throw new Error(`staging root must be the exact per-attempt path: ${expectedStage}`);
if (manifest === stage || !manifest.startsWith(`${stage}/`)) throw new Error('manifest must be inside the same attempt subtree');

function walkNoFollow(candidate, label) {
  let cursor = candidate;
  const seen = [];
  while (cursor !== path.dirname(cursor)) { seen.push(cursor); cursor = path.dirname(cursor); }
  seen.push(cursor);
  for (const current of seen.reverse()) {
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`${label} has a symlink ancestor: ${current}`);
  }
}
for (const [candidate, label] of [[deployRoot, 'deployment authority'], [stagingRoot, 'staging authority'],
  [stage, 'attempt authority'], [manifest, 'manifest']]) walkNoFollow(candidate, label);
const authority = [];
for (const [candidate, label, expectedMode] of [
  [deployRoot, 'deployment authority', 0o700],
  [stagingRoot, 'staging authority', 0o700],
  [stage, 'attempt authority', jailVisible === '1' ? 0o755 : 0o700],
]) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  if (stat.uid !== BigInt(authorityUid) || stat.gid !== BigInt(authorityGid)) {
    throw new Error(`${label} must be root-owned`);
  }
  if ((stat.mode & 0o777n) !== BigInt(expectedMode)) {
    throw new Error(`${label} must use mode ${expectedMode.toString(8).padStart(4, '0')}`);
  }
  if (fs.realpathSync(candidate) !== candidate) throw new Error(`${label} must not resolve through an alias`);
  authority.push({ path: candidate, dev: stat.dev.toString(), ino: stat.ino.toString() });
}
const authoritySha256 = crypto.createHash('sha256').update(JSON.stringify(authority)).digest('hex');
if (expectedAuthority && authoritySha256 !== expectedAuthority) {
  throw new Error('deployment authority inode identity changed');
}
const stageStat = fs.lstatSync(stage);
const expectedStageMode = jailVisible === '1' ? 0o755 : 0o700;
if (!stageStat.isDirectory() || stageStat.isSymbolicLink() || stageStat.uid !== authorityUid
    || stageStat.gid !== authorityGid
    || (stageStat.mode & 0o777) !== expectedStageMode) {
  throw new Error(`staging root must be a root-owned mode-${expectedStageMode.toString(8)} real directory`);
}
if (jailVisible === '1') {
  const intent = path.join(stage, '.npm-ci-intent.json');
  const stat = fs.lstatSync(intent);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== authorityUid || stat.gid !== authorityGid
      || (stat.mode & 0o777) !== 0o600) {
    throw new Error('mode-0755 interrupted staging root has no safe immutable npm intent');
  }
}
for (const name of ['package.json', 'package-lock.json']) {
  const candidate = path.join(stage, name);
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== authorityUid || stat.gid !== authorityGid
      || (stat.mode & 0o022) !== 0) {
    throw new Error(`${name} must be a root-owned, non-writable regular nonsymlink file`);
  }
}
const dataReal = fs.realpathSync(dataRoot);
const stageReal = fs.realpathSync(stage);
if (stageReal !== dataReal && !stageReal.startsWith(`${dataReal}/`)) throw new Error('staging realpath escapes the data root');

let mountInfoPath = '/proc/self/mountinfo';
if (testMode === '1') {
  if (process.env.OSI_REPAIR_PROGRAM_MODE !== '1' || process.env.OSI_DEPLOY_ARTIFACT_MODE !== 'test') throw new Error('test adapter requires explicit repair/test artifact mode');
  mountInfoPath = `${boundary}/mountinfo.test`;
  if (process.env.OSI_STAGED_NPM_TEST_MOUNTINFO !== mountInfoPath) throw new Error('test mountinfo adapter must use the fixed test boundary');
  const mountInfoStat = fs.lstatSync(mountInfoPath);
  if (!mountInfoStat.isFile() || mountInfoStat.isSymbolicLink()
      || mountInfoStat.uid !== process.getuid() || (mountInfoStat.mode & 0o777) !== 0o600) {
    throw new Error('test mountinfo adapter must be an owned mode-0600 regular file');
  }
  for (const [candidate, label] of [[stage, 'staging root'], [manifest, 'manifest'], [ujail, 'ujail adapter'], [npm, 'npm adapter']]) {
    const resolved = path.resolve(candidate);
    if (resolved !== boundary && !resolved.startsWith(`${boundary}/`)) throw new Error(`${label} is outside the fixed test boundary`);
    walkNoFollow(resolved, label);
  }
  for (const [candidate, label] of [[ujail, 'ujail adapter'], [npm, 'npm adapter']]) {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o111) === 0) throw new Error(`${label} is not an owned executable regular file`);
  }
}
const mountInfo = fs.readFileSync(mountInfoPath, 'utf8');
stateLib.validatePersistentMountProfile(path.join(dataRoot, 'osi-deploy'), mountInfo, {
  simulatedRoot: dataRoot,
});
process.stdout.write(authoritySha256);
NODE
}

# A killed jail run may leave the deliberately jail-visible staging root at
# 0755. That mode is accepted only long enough to validate an immutable intent
# inside the exact attempt subtree; an unmarked 0755 tree still fails closed.
INTENT="$STAGING_ROOT/.npm-ci-intent.json"
STAGE_MODE=$("$HOST_NODE" - "$STAGING_ROOT" <<'NODE'
'use strict';
const fs = require('node:fs');
const stat = fs.lstatSync(process.argv[2]);
if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('attempt authority must be a real directory');
process.stdout.write((stat.mode & 0o777).toString(8));
NODE
) || fail 'attempt authority is unavailable'
case "$STAGE_MODE" in
    755) PREFLIGHT_STAGE_JAIL_VISIBLE=1 ;;
    700) ;;
    *) fail 'staging root must be mode 0700 or an intent-bound interrupted mode 0755 run' ;;
esac
AUTHORITY_IDENTITY=$(preflight) || fail 'staging confinement or test-adapter boundary check failed'

# Deterministic test-only replacement between capture and the first privileged
# mutation. The following authority recheck must reject both inode changes.
if [ "${OSI_STAGED_NPM_TEST_MODE:-0}" = 1 ] && [ -n "${OSI_STAGED_NPM_TEST_AUTHORITY_RACE:-}" ]; then
    "$HOST_NODE" - "$STAGING_ROOT" "$DEPLOYMENT_ID" "$OSI_STAGED_NPM_TEST_AUTHORITY_RACE" <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [stage, deploymentId, race] = process.argv.slice(2);
const staging = path.dirname(stage);
if (path.basename(stage) !== deploymentId) throw new Error('race adapter is outside the attempt boundary');
if (race === 'attempt') {
  const previous = `${stage}.authority-race-original`;
  fs.renameSync(stage, previous);
  fs.mkdirSync(stage, { mode: 0o700 });
  for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(previous, name), path.join(stage, name));
} else if (race === 'staging') {
  const previous = `${staging}.authority-race-original`;
  fs.renameSync(staging, previous);
  fs.mkdirSync(staging, { mode: 0o700 });
  fs.renameSync(path.join(previous, deploymentId), stage);
} else {
  throw new Error('invalid authority race adapter');
}
NODE
fi
preflight "$AUTHORITY_IDENTITY" >/dev/null || fail 'deployment authority changed before the first privileged mutation'
[ -d "$STAGING_ROOT" ] || fail 'staging root does not exist'
[ -f "$STAGING_ROOT/package.json" ] || fail 'package.json is missing'
[ -f "$STAGING_ROOT/package-lock.json" ] || fail 'package-lock.json is missing'

PRIVATE="$STAGING_ROOT/.npm-private"
JAIL_ROOT="$PRIVATE/rootfs"
JAIL_ETC="$JAIL_ROOT/etc"
NPM_HOME="$PRIVATE/home"
NPM_CACHE="$PRIVATE/cache"
NPM_TMP="$PRIVATE/tmp"
NODE_MODULES="$STAGING_ROOT/node_modules"
PROCESS_LAUNCH="$PRIVATE/npm-ci-launch.json"
PROCESS_RECORD="$PRIVATE/npm-ci-process.json"
PROCESS_PERMIT="$PRIVATE/npm-ci-run.permit"
SLEEP=/bin/sleep
[ -x "$SLEEP" ] || fail 'sleep is unavailable'

# Inspect every future mutation root before intent publication or any
# mkdir/chmod/chown. The staging root is non-writable to the jailed identity at
# this point, so a successful no-follow walk establishes a stable authority
# boundary for the guarded creates below.
"$HOST_NODE" - "$STAGING_ROOT" "$PRIVATE" "$JAIL_ROOT" "$JAIL_ETC" "$NPM_HOME" "$NPM_CACHE" "$NPM_TMP" "$NODE_MODULES" <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [stageArg, ...roots] = process.argv.slice(2);
const stage = path.resolve(stageArg);
for (const candidate of roots) {
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(`${stage}${path.sep}`)) throw new Error(`mutation root escapes staging: ${resolved}`);
  let cursor = stage;
  for (const part of path.relative(stage, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`mutation root is not a real directory: ${cursor}`);
  }
}
NODE

process_group_empty() {
    "$HOST_NODE" - "$1" <<'NODE'
'use strict';
const fs = require('node:fs');
const pgid = Number(process.argv[2]);
function readStat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = raw.lastIndexOf(') ');
    if (end < 0) return null;
    const fields = raw.slice(end + 2).trim().split(/\s+/);
    return { state: fields[0], pgrp: Number(fields[2]) };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}
for (const entry of fs.readdirSync('/proc')) {
  if (!/^\d+$/.test(entry)) continue;
  const stat = readStat(entry);
  if (stat && stat.state !== 'Z' && stat.pgrp === pgid) process.exit(1);
}
NODE
}

classify_prior_jail() {
    "$HOST_NODE" - "$PROCESS_LAUNCH" "$PROCESS_RECORD" "$PROCESS_PERMIT" "$DEPLOYMENT_ID" <<'NODE'
'use strict';
const fs = require('node:fs');
const [launchPath, recordPath, permitPath, deploymentId] = process.argv.slice(2);
function existsNoFollow(candidate) {
  try { return fs.lstatSync(candidate); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const launchStat = existsNoFollow(launchPath);
const recordStat = existsNoFollow(recordPath);
const permitStat = existsNoFollow(permitPath);
if (!launchStat && !recordStat && !permitStat) { process.stdout.write('none'); process.exit(0); }
for (const [candidate, stat, label] of [[launchPath, launchStat, 'launch'], [recordPath, recordStat, 'process'],
  [permitPath, permitStat, 'permit']]) {
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (stat.mode & 0o777) !== 0o600)) {
    throw new Error(`${label} record is unsafe: ${candidate}`);
  }
}
if (permitStat && !recordStat) throw new Error('run permit exists without process authority');
const launch = launchStat ? JSON.parse(fs.readFileSync(launchPath, 'utf8')) : null;
const record = recordStat ? JSON.parse(fs.readFileSync(recordPath, 'utf8')) : null;
if (launch && (launch.format !== 2 || launch.kind !== 'STAGED_NPM_CI_LAUNCH' || launch.deploymentId !== deploymentId
    || !['install', 'verify'].includes(launch.phase) || !/^[0-9a-f]{32}$/.test(launch.launchNonce))) {
  throw new Error('launch record does not match this deployment');
}
if (!record) { process.stdout.write(`launch-only:${launch.launchNonce}`); process.exit(0); }
if (record.format !== 2 || record.kind !== 'STAGED_NPM_CI_PROCESS' || record.deploymentId !== deploymentId
    || !['install', 'verify'].includes(record.phase) || !/^[0-9a-f]{32}$/.test(record.launchNonce)
    || !Number.isSafeInteger(record.pid) || record.pid < 2
    || record.processGroupId !== record.pid || !/^\d+$/.test(record.starttime)) {
  throw new Error('process record does not match its launch authority');
}
if (permitStat) {
  const permit = JSON.parse(fs.readFileSync(permitPath, 'utf8'));
  if (permit.format !== 1 || permit.kind !== 'STAGED_NPM_CI_RUN_PERMIT'
      || permit.launchNonce !== record.launchNonce) throw new Error('run permit does not match process authority');
}
function readStat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = raw.lastIndexOf(') ');
    if (end < 0) throw new Error(`invalid proc stat for ${pid}`);
    const fields = raw.slice(end + 2).trim().split(/\s+/);
    return { state: fields[0], pgrp: Number(fields[2]), starttime: fields[19] };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}
const leader = readStat(record.pid);
const members = [];
for (const entry of fs.readdirSync('/proc')) {
  if (!/^\d+$/.test(entry)) continue;
  const stat = readStat(entry);
  if (stat && stat.state !== 'Z' && stat.pgrp === record.processGroupId) members.push(Number(entry));
}
if (leader && leader.state !== 'Z') {
  if (leader.pgrp !== record.processGroupId || leader.starttime !== record.starttime) {
    throw new Error('recorded process identity was reused or changed');
  }
  process.stdout.write(`alive:${record.processGroupId}`);
} else if (members.length > 0) {
  // The supervisor published this group identity before the nonce-bound run
  // permit existed. Linux cannot reuse the PGID while these members remain,
  // so they are authenticated descendants of the recorded supervisor.
  process.stdout.write(`leaderless:${record.processGroupId}`);
} else {
  process.stdout.write(`stale:${record.processGroupId}`);
}
NODE
}

durable_remove_lifecycle_file() {
    target=$1
    kind=$2
    "$HOST_NODE" - "$target" "$kind" <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [target, kind] = process.argv.slice(2);
const enabled = process.env.OSI_REPAIR_PROGRAM_MODE === '1'
  && process.env.OSI_DEPLOY_ARTIFACT_MODE === 'test'
  && process.env.OSI_STAGED_NPM_TEST_MODE === '1';
function crash(label) {
  if (enabled && process.env.OSI_STAGED_NPM_TEST_CRASH_AT === label) {
    process.kill(process.ppid, 'SIGKILL');
    process.exit(137);
  }
}
let stat;
try { stat = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`unsafe lifecycle file removal: ${target}`);
  }
  fs.unlinkSync(target);
  crash(`cleanup-after-${kind}-unlink`);
}
const fd = fs.openSync(path.dirname(target), 'r');
try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
crash(`cleanup-after-${kind}-fsync`);
NODE
}

reconcile_prior_jail() {
    preflight "$AUTHORITY_IDENTITY" >/dev/null || return 1
    lifecycle=$(classify_prior_jail) || return 1
    if [ "${lifecycle#launch-only:}" != "$lifecycle" ]; then
        # The supervisor cannot run npm without a process record and a later
        # nonce-bound permit. Give a just-spawned supervisor time to publish;
        # if it died before publication, retire the launch durably. A late
        # publisher is caught by the post-removal settling pass below.
        tries=0
        while [ ! -e "$PROCESS_RECORD" ] && [ "$tries" -lt 100 ]; do
            "$SLEEP" 0.02
            tries=$((tries + 1))
        done
        if [ -e "$PROCESS_RECORD" ]; then
            reconcile_prior_jail
            return $?
        fi
        durable_remove_lifecycle_file "$PROCESS_LAUNCH" launch || return 1
        tries=0
        while [ ! -e "$PROCESS_RECORD" ] && [ "$tries" -lt 25 ]; do
            "$SLEEP" 0.02
            tries=$((tries + 1))
        done
        if [ -e "$PROCESS_RECORD" ]; then
            reconcile_prior_jail
            return $?
        fi
        return 0
    fi
    case "$lifecycle" in
        none)
            # A prior process may have died after unlinking the final record
            # but before syncing this directory. Repeating the barrier before
            # any new launch makes the all-absent state durable, not merely
            # visually clean in the current page cache.
            [ -d "$PRIVATE" ] || return 0
            durable_remove_lifecycle_file "$PROCESS_RECORD" record || return 1
            return 0
            ;;
        alive:*|leaderless:*)
            pgid=${lifecycle#*:}
            kill -TERM -- "-$pgid" 2>/dev/null || true
            tries=0
            while ! process_group_empty "$pgid" && [ "$tries" -lt 50 ]; do
                "$SLEEP" 0.1
                tries=$((tries + 1))
            done
            if ! process_group_empty "$pgid"; then
                kill -KILL -- "-$pgid" 2>/dev/null || true
                tries=0
                while ! process_group_empty "$pgid" && [ "$tries" -lt 50 ]; do
                    "$SLEEP" 0.1
                    tries=$((tries + 1))
                done
            fi
            process_group_empty "$pgid" || return 1
            ;;
        stale:*) ;;
        *) return 1 ;;
    esac
    # Keep the authenticated process record until last. Therefore every
    # interrupted removal prefix is unambiguous and safely resumable.
    durable_remove_lifecycle_file "$PROCESS_PERMIT" permit || return 1
    durable_remove_lifecycle_file "$PROCESS_LAUNCH" launch || return 1
    durable_remove_lifecycle_file "$PROCESS_RECORD" record || return 1
}

# Recovery of a recorded jail precedes every mutation-root create, chmod, or
# ownership walk. A launch-only supervisor never has a permit, while any
# process record remains sufficient to quiesce its group even if a late
# publisher crossed a newer launch nonce. A retry cannot publish over an
# untracked old npm writer.
reconcile_prior_jail || fail 'could not authenticate and quiesce the prior staged npm process tree'

UJAIL=/sbin/ujail
NPM=/usr/bin/npm
NODE=/usr/bin/node
SHELL=/bin/sh
ENV_BIN=/usr/bin/env
SETSID=/usr/bin/setsid
NPM_MODULE_ROOT=/usr/lib/node_modules/npm
if [ "${OSI_STAGED_NPM_TEST_MODE:-0}" = 1 ]; then
    UJAIL=${OSI_STAGED_NPM_TEST_UJAIL:-$UJAIL}
    NPM=${OSI_STAGED_NPM_TEST_NPM:-$NPM}
    NODE=${OSI_STAGED_NPM_TEST_NODE:-$NODE}
    NPM_MODULE_ROOT=${OSI_STAGED_NPM_TEST_MODULE_ROOT:-$NPM_MODULE_ROOT}
fi
[ -x "$UJAIL" ] || fail 'ujail is unavailable'
[ -x "$NPM" ] || fail 'npm is unavailable'
[ -x "$NODE" ] || fail 'node is unavailable'
[ -x "$SHELL" ] || fail 'shell is unavailable'
[ -x "$ENV_BIN" ] || fail 'env is unavailable'
[ -x "$SETSID" ] || fail 'setsid is unavailable'
[ -d "$NPM_MODULE_ROOT" ] || fail 'pinned npm module tree is unavailable'
if [ "${OSI_STAGED_NPM_TEST_MODE:-0}" != 1 ]; then
    [ "$("$HOST_READLINK" -f "$NPM")" = /usr/lib/node_modules/npm/bin/npm-cli.js ] \
        || fail 'npm executable does not resolve to the pinned npm-cli.js'
fi

# The shipped jail identity is fixed and must never collapse to UID 0.
NOBODY_UID=65534
NOBODY_GID=65534
[ "$NOBODY_UID" -ne 0 ] && [ "$NOBODY_GID" -ne 0 ] || fail 'invalid jail identity'

LOCK_BEFORE=$(hash_file "$STAGING_ROOT/package-lock.json")
PACKAGE_BEFORE=$(hash_file "$STAGING_ROOT/package.json")
preflight "$AUTHORITY_IDENTITY" >/dev/null || fail 'deployment authority changed before intent publication'
"$HOST_NODE" - "$INTENT" "$DEPLOYMENT_ID" "$TARGET_MANIFEST_SHA256" "$PACKAGE_BEFORE" "$LOCK_BEFORE" "$STATE_LIB" <<'NODE'
'use strict';
const fs = require('node:fs');
const [intentPath, deploymentId, targetManifestSha256, packageSha256, packageLockSha256, stateLibPath] = process.argv.slice(2);
const stateLib = require(stateLibPath);
const content = { format: 1, kind: 'STAGED_NPM_CI_INTENT', deploymentId, targetManifestSha256, packageSha256, packageLockSha256 };
const intendedBytes = Buffer.from(`${JSON.stringify(content)}\n`);
if (fs.existsSync(intentPath)) {
  if (!fs.readFileSync(intentPath).equals(intendedBytes)) throw new Error('existing staged npm intent does not match this invocation');
} else {
  stateLib.publishImmutableBytes(intentPath, intendedBytes, { crashLabelPrefix: 'staged-npm-intent' });
}
const stat = fs.lstatSync(intentPath);
if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
  throw new Error('staged npm intent has unsafe identity');
}
NODE
preflight "$AUTHORITY_IDENTITY" >/dev/null || fail 'deployment authority changed before private-root creation'
"$HOST_NODE" - "$STAGING_ROOT" "$PRIVATE" "$JAIL_ROOT" "$JAIL_ETC" "$NPM_HOME" "$NPM_CACHE" "$NPM_TMP" "$NODE_MODULES" <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [stageArg, ...roots] = process.argv.slice(2);
const stage = path.resolve(stageArg);
for (const candidate of roots) {
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(`${stage}${path.sep}`)) throw new Error(`mutation root escapes staging: ${resolved}`);
  const parent = path.dirname(resolved);
  const before = fs.lstatSync(parent);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`unsafe mutation parent: ${parent}`);
  let stat;
  try { stat = fs.lstatSync(resolved); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(resolved, { mode: 0o700 });
    stat = fs.lstatSync(resolved);
  }
  const stableParent = fs.lstatSync(parent);
  if (!stableParent.isDirectory() || stableParent.isSymbolicLink()
      || stableParent.dev !== before.dev || stableParent.ino !== before.ino) {
    throw new Error(`mutation parent changed during guarded create: ${parent}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`mutation root is not a real directory: ${resolved}`);
  if (stat.uid !== process.getuid() && stat.uid !== 65534) throw new Error(`mutation root has unexpected owner: ${resolved}`);
}
NODE
"$HOST_CHMOD" 700 "$PRIVATE" "$JAIL_ROOT" "$JAIL_ETC" "$NPM_HOME" "$NPM_CACHE" "$NPM_TMP" "$NODE_MODULES"
"$HOST_NODE" - "$JAIL_ETC/passwd" "$JAIL_ETC/group" <<'NODE'
'use strict';
const fs = require('node:fs');
const [passwdPath, groupPath] = process.argv.slice(2);
for (const [target, content, label] of [
  [passwdPath, 'nobody:x:65534:65534:nobody:/nonexistent:/bin/false\n', 'jail-passwd'],
  [groupPath, 'nogroup:x:65534:\n', 'jail-group'],
]) {
  const intended = Buffer.from(content);
  try {
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o444);
    try { fs.writeFileSync(fd, intended); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || (stat.mode & 0o777) !== 0o444 || !fs.readFileSync(target).equals(intended)) {
      throw new Error(`${label} has unsafe or conflicting content`);
    }
  }
}
NODE
"$HOST_CHMOD" 755 "$JAIL_ROOT" "$JAIL_ETC"
confined_chown_tree() {
    owner_uid=$1
    owner_gid=$2
    shift 2
    "$HOST_NODE" - "$STAGING_ROOT" "$owner_uid" "$owner_gid" "$@" <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [stageArg, uidArg, gidArg, ...roots] = process.argv.slice(2);
const stage = path.resolve(stageArg);
const uid = Number(uidArg); const gid = Number(gidArg);
if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0 || roots.length === 0) {
  throw new Error('invalid confined ownership walk arguments');
}
function assertConfined(candidate) {
  const resolved = path.resolve(candidate);
  if (resolved !== stage && !resolved.startsWith(`${stage}${path.sep}`)) throw new Error('ownership root escapes staging');
  let cursor = stage;
  for (const part of path.relative(stage, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (cursor !== resolved && stat.isSymbolicLink()) throw new Error(`ownership root has a symlink ancestor: ${cursor}`);
  }
  return resolved;
}
function visit(candidate) {
  const before = fs.lstatSync(candidate);
  if (before.isDirectory() && !before.isSymbolicLink()) {
    const names = fs.readdirSync(candidate);
    const stable = fs.lstatSync(candidate);
    if (!stable.isDirectory() || stable.isSymbolicLink() || stable.dev !== before.dev || stable.ino !== before.ino) {
      throw new Error(`ownership directory changed during walk: ${candidate}`);
    }
    for (const name of names) visit(path.join(candidate, name));
  }
  // lchown never follows the final path if npm planted a symlink. This is
  // deliberately used for every entry, not only known symlinks, so a
  // last-moment final-component replacement cannot escape the staging tree.
  fs.lchownSync(candidate, uid, gid);
}
for (const root of roots.map(assertConfined)) visit(root);
NODE
}
preflight "$AUTHORITY_IDENTITY" >/dev/null || fail 'staging confinement changed before ownership mutation'
if [ "${OSI_STAGED_NPM_TEST_MODE:-0}" != 1 ]; then
    confined_chown_tree "$NOBODY_UID" "$NOBODY_GID" "$NPM_HOME" "$NPM_CACHE" "$NPM_TMP" "$NODE_MODULES"
else
    "$HOST_CHMOD" 777 "$NPM_HOME" "$NPM_CACHE" "$NPM_TMP" "$NODE_MODULES"
fi
"$HOST_CHMOD" 755 "$STAGING_ROOT"
PREFLIGHT_STAGE_JAIL_VISIBLE=1
preflight "$AUTHORITY_IDENTITY" >/dev/null || fail 'staging confinement changed before jail entry'
if [ "${OSI_STAGED_NPM_TEST_MODE:-0}" = 1 ] && [ "${OSI_STAGED_NPM_TEST_CRASH_AT:-}" = after-stage-0755 ]; then
    kill -9 $$
fi

reclaim_for_publication() {
    if [ "${OSI_STAGED_NPM_TEST_MODE:-0}" = 1 ] && [ "${OSI_STAGED_NPM_TEST_RECLAIM_FAILURE:-0}" = 1 ]; then
        return 1
    fi
    preflight "$AUTHORITY_IDENTITY" >/dev/null || return 1
    confined_chown_tree "$HOST_UID" "$HOST_GID" "$NPM_HOME" "$NPM_CACHE" "$NPM_TMP" "$NODE_MODULES" || return 1
    "$HOST_CHMOD" 700 "$STAGING_ROOT" "$NODE_MODULES" || return 1
    PREFLIGHT_STAGE_JAIL_VISIBLE=0
    preflight "$AUTHORITY_IDENTITY" >/dev/null || return 1
}
cleanup_reclaim() {
    reconcile_prior_jail >/dev/null 2>&1 || return 1
    reclaim_for_publication >/dev/null 2>&1 || return 1
}
on_signal() {
    status=$1
    cleanup_reclaim >/dev/null 2>&1 || true
    trap - EXIT HUP INT TERM
    exit "$status"
}
trap 'cleanup_reclaim >/dev/null 2>&1 || true' EXIT
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

run_tracked_jail() {
    phase=$1
    shift
    launch_nonce=$("$HOST_NODE" -e "process.stdout.write(require('node:crypto').randomBytes(16).toString('hex'))") \
        || return 1
    "$HOST_NODE" - "$PROCESS_LAUNCH" "$DEPLOYMENT_ID" "$phase" "$launch_nonce" "$STATE_LIB" <<'NODE'
'use strict';
const [target, deploymentId, phase, launchNonce, stateLibPath] = process.argv.slice(2);
const stateLib = require(stateLibPath);
const content = { format: 2, kind: 'STAGED_NPM_CI_LAUNCH', deploymentId, phase, launchNonce };
stateLib.publishImmutableBytes(target, Buffer.from(`${JSON.stringify(content)}\n`), { crashLabelPrefix: 'staged-npm-launch' });
NODE
    if [ "${OSI_STAGED_NPM_TEST_MODE:-0}" = 1 ] && [ "${OSI_STAGED_NPM_TEST_CRASH_AT:-}" = after-launch-published ]; then
        kill -9 $$
    fi
    # The process-group leader is the supervisor itself. It publishes its own
    # PID/starttime/PGID authority durably, then waits for the matching nonce
    # permit before it can spawn the jail command. The coordinator is never
    # trusted to describe a process it merely hopes is still the one spawned.
    "$SETSID" "$HOST_NODE" - "$PROCESS_LAUNCH" "$PROCESS_RECORD" "$PROCESS_PERMIT" \
        "$DEPLOYMENT_ID" "$phase" "$launch_nonce" "$STATE_LIB" "$@" <<'NODE' &
'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const [launchPath, recordPath, permitPath, deploymentId, phase, launchNonce, stateLibPath, ...command] = process.argv.slice(2);
const stateLib = require(stateLibPath);
if (command.length === 0) throw new Error('staged npm supervisor has no command');
function readOwnedJson(candidate, label) {
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} has unsafe identity`);
  }
  return JSON.parse(fs.readFileSync(candidate, 'utf8'));
}
function requireLaunch() {
  const launch = readOwnedJson(launchPath, 'launch record');
  if (launch.format !== 2 || launch.kind !== 'STAGED_NPM_CI_LAUNCH' || launch.deploymentId !== deploymentId
      || launch.phase !== phase || launch.launchNonce !== launchNonce) throw new Error('launch authority changed');
}
function selfIdentity() {
  const raw = fs.readFileSync('/proc/self/stat', 'utf8');
  const end = raw.lastIndexOf(') ');
  if (end < 0) throw new Error('invalid supervisor proc stat');
  const fields = raw.slice(end + 2).trim().split(/\s+/);
  const pgrp = Number(fields[2]);
  if (pgrp !== process.pid) throw new Error('supervisor is not its process-group leader');
  return { processGroupId: pgrp, starttime: fields[19] };
}
requireLaunch();
const identity = selfIdentity();
const supervisorCrashEnabled = process.env.OSI_REPAIR_PROGRAM_MODE === '1'
  && process.env.OSI_DEPLOY_ARTIFACT_MODE === 'test'
  && process.env.OSI_STAGED_NPM_TEST_MODE === '1';
if (supervisorCrashEnabled
    && process.env.OSI_STAGED_NPM_TEST_SUPERVISOR_CRASH_AT === 'before-process-publication') {
  process.kill(process.pid, 'SIGKILL');
}
const record = { format: 2, kind: 'STAGED_NPM_CI_PROCESS', deploymentId, phase, launchNonce,
  pid: process.pid, processGroupId: identity.processGroupId, starttime: identity.starttime };
stateLib.publishImmutableBytes(recordPath, Buffer.from(`${JSON.stringify(record)}\n`), {
  crashLabelPrefix: 'staged-npm-process',
});
// Publication returning proves both the file and parent directory barriers.
// Recheck the nonce after publication so a retired launch cannot cross-bind
// this supervisor to a later retry's permit.
requireLaunch();
const wait = new Int32Array(new SharedArrayBuffer(4));
let permit;
for (;;) {
  try { permit = readOwnedJson(permitPath, 'run permit'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    Atomics.wait(wait, 0, 0, 20);
    requireLaunch();
    continue;
  }
  break;
}
if (permit.format !== 1 || permit.kind !== 'STAGED_NPM_CI_RUN_PERMIT' || permit.launchNonce !== launchNonce) {
  throw new Error('run permit does not match supervisor authority');
}
requireLaunch();
const current = readOwnedJson(recordPath, 'process record');
if (JSON.stringify(current) !== JSON.stringify(record)) throw new Error('process authority changed before jail spawn');
const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: process.env });
child.once('error', (error) => { console.error(error.stack || error.message); process.exit(127); });
child.once('exit', (code, signal) => {
  if (signal) {
    const signals = require('node:os').constants.signals;
    process.exit(128 + (signals[signal] || 0));
  }
  process.exit(code === null ? 1 : code);
});
NODE
    tracked_pid=$!
    if [ "${OSI_STAGED_NPM_TEST_MODE:-0}" = 1 ] && [ "${OSI_STAGED_NPM_TEST_CRASH_AT:-}" = after-supervisor-spawned ]; then
        kill -9 $$
    fi
    observed=
    tries=0
    while [ -z "$observed" ] && [ "$tries" -lt 100 ]; do
        observed=$("$HOST_NODE" - "$PROCESS_RECORD" "$DEPLOYMENT_ID" "$phase" "$launch_nonce" "$tracked_pid" <<'NODE' 2>/dev/null || true
'use strict';
const fs = require('node:fs');
const [recordPath, deploymentId, phase, launchNonce, pidArg] = process.argv.slice(2);
const pid = Number(pidArg);
const stat = fs.lstatSync(recordPath);
if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) process.exit(1);
const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
if (record.format !== 2 || record.kind !== 'STAGED_NPM_CI_PROCESS' || record.deploymentId !== deploymentId
    || record.phase !== phase || record.launchNonce !== launchNonce || record.pid !== pid
    || record.processGroupId !== pid || !/^\d+$/.test(record.starttime)) process.exit(1);
const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
const end = raw.lastIndexOf(') ');
if (end < 0) process.exit(1);
const fields = raw.slice(end + 2).trim().split(/\s+/);
if (Number(fields[2]) !== pid || fields[19] !== record.starttime) process.exit(1);
process.stdout.write('observed');
NODE
        )
        [ -n "$observed" ] || "$SLEEP" 0.02
        tries=$((tries + 1))
    done
    if [ -z "$observed" ]; then
        kill -KILL -- "-$tracked_pid" 2>/dev/null || kill -KILL "$tracked_pid" 2>/dev/null || true
        wait "$tracked_pid" 2>/dev/null || true
        reconcile_prior_jail >/dev/null 2>&1 || true
        return 1
    fi
    if [ "${OSI_STAGED_NPM_TEST_MODE:-0}" = 1 ] && [ "${OSI_STAGED_NPM_TEST_CRASH_AT:-}" = after-process-observed ]; then
        kill -9 $$
    fi
    "$HOST_NODE" - "$PROCESS_PERMIT" "$launch_nonce" "$STATE_LIB" <<'NODE'
'use strict';
const [target, launchNonce, stateLibPath] = process.argv.slice(2);
const permit = { format: 1, kind: 'STAGED_NPM_CI_RUN_PERMIT', launchNonce };
require(stateLibPath).publishImmutableBytes(target, Buffer.from(`${JSON.stringify(permit)}\n`), {
  crashLabelPrefix: 'staged-npm-permit',
});
NODE
    if [ "${OSI_STAGED_NPM_TEST_MODE:-0}" = 1 ] && [ "${OSI_STAGED_NPM_TEST_CRASH_AT:-}" = after-permit-published ]; then
        kill -9 $$
    fi
    if wait "$tracked_pid"; then
        tracked_status=0
    else
        tracked_status=$?
    fi
    reconcile_prior_jail || return 1
    return "$tracked_status"
}

# env -i is the credential boundary. The jail receives no caller deployment,
# MQTT, ChirpStack, cloud, GitHub, or operator variables.
IDENTITY_CHECK='const expected=65534; const groups=[...new Set(process.getgroups())]; if (process.getuid()!==expected || process.getgid()!==expected || groups.length!==1 || groups[0]!==expected) { console.error("npm-jail-identity-mismatch"); process.exit(77); }'
run_tracked_jail install "$UJAIL" -n osi-staged-npm -c -E -U nobody -G nogroup -R "$JAIL_ROOT" -o \
    -r "$SHELL:/bin/sh" -r "$ENV_BIN:/usr/bin/env" -r "$NODE:/usr/bin/node" -r "$NPM:/usr/bin/npm" \
    -r "$NPM_MODULE_ROOT:/usr/lib/node_modules/npm" -r "$STAGING_ROOT:/work/runtime" \
    -w "$NODE_MODULES:/work/runtime/node_modules" -w "$NPM_HOME:/work/home" \
    -w "$NPM_CACHE:/work/cache" -w "$NPM_TMP:/work/tmp" -- \
    /bin/sh -c '/usr/bin/node -e "$1"; shift; cd /work/runtime && exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C HOME=/work/home npm_config_cache=/work/cache TMPDIR=/work/tmp /usr/bin/npm ci --omit=dev --no-fund --no-audit' \
    npm-jail "$IDENTITY_CHECK"

LOCK_AFTER=$(hash_file "$STAGING_ROOT/package-lock.json")
[ "$LOCK_AFTER" = "$LOCK_BEFORE" ] || fail 'npm ci changed package-lock.json'

run_tracked_jail verify "$UJAIL" -n osi-staged-npm-verify -c -E -U nobody -G nogroup -R "$JAIL_ROOT" -o \
    -r "$SHELL:/bin/sh" -r "$ENV_BIN:/usr/bin/env" -r "$NODE:/usr/bin/node" -r "$NPM:/usr/bin/npm" \
    -r "$NPM_MODULE_ROOT:/usr/lib/node_modules/npm" -r "$STAGING_ROOT:/work/runtime" \
    -w "$NODE_MODULES:/work/runtime/node_modules" -w "$NPM_HOME:/work/home" \
    -w "$NPM_CACHE:/work/cache" -w "$NPM_TMP:/work/tmp" -- \
    /bin/sh -c '/usr/bin/node -e "$1"; shift; cd /work/runtime && exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C HOME=/work/home npm_config_cache=/work/cache TMPDIR=/work/tmp /usr/bin/npm ls --omit=dev --json' \
    npm-jail "$IDENTITY_CHECK" >/dev/null

reclaim_for_publication || fail 'failed to reclaim staged npm output ownership'
trap - EXIT HUP INT TERM
"$HOST_RM" -rf "$PRIVATE"
"$HOST_RM" -f "$INTENT"
PREFLIGHT_STAGE_JAIL_VISIBLE=0

preflight "$AUTHORITY_IDENTITY" >/dev/null || fail 'staging confinement changed before manifest publication'

"$HOST_NODE" - "$STAGING_ROOT" "$TARGET_MANIFEST_SHA256" "$DEPLOYMENT_ID" "$LOCK_AFTER" "$MANIFEST_OUT" "$STATE_LIB" <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const [root, targetManifestSha256, deploymentId, packageLockSha256, output, stateLibPath] = process.argv.slice(2);
const stateLib = require(stateLibPath);
function assertConfined(candidate, label) {
  const resolved = path.resolve(candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`escaping staged ${label}`);
  return resolved;
}
function verifySymlinkChain(absolute, relative) {
  const seen = new Set();
  let cursor = absolute;
  for (let depth = 0; depth < 64; depth += 1) {
    cursor = assertConfined(cursor, `symlink: ${relative}`);
    if (seen.has(cursor)) throw new Error(`cyclic staged symlink: ${relative}`);
    seen.add(cursor);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`missing staged symlink target: ${relative}`);
      throw error;
    }
    if (!stat.isSymbolicLink()) {
      if (!stat.isFile() && !stat.isDirectory()) throw new Error(`special staged symlink target: ${relative}`);
      return;
    }
    cursor = path.resolve(path.dirname(cursor), fs.readlinkSync(cursor));
  }
  throw new Error(`staged symlink chain is too deep: ${relative}`);
}
function collect() {
 const entries = [];
 function visit(directory) {
  for (const name of fs.readdirSync(directory).sort()) {
    const absolute = path.join(directory, name);
    if (absolute === output) continue;
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const stat = fs.lstatSync(absolute);
    if (stat.uid !== process.getuid()) throw new Error(`staged path has wrong owner: ${relative}`);
    if (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0) {
      throw new Error(`staged path is group/world-writable: ${relative}`);
    }
    if (stat.isDirectory()) {
      visit(absolute);
    } else if (stat.isFile()) {
      entries.push({ path: relative, type: 'file', mode: stat.mode & 0o777, sizeBytes: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') });
    } else if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      verifySymlinkChain(absolute, relative);
      entries.push({ path: relative, type: 'symlink', mode: stat.mode & 0o777, target });
    } else {
      throw new Error(`unsupported staged entry: ${relative}`);
    }
  }
 }
 visit(root);
 entries.sort((a, b) => a.path.localeCompare(b.path));
 return entries;
}
const entries = collect();
const rechecked = collect();
if (JSON.stringify(entries) !== JSON.stringify(rechecked)) throw new Error('staged runtime changed during manifest collection');
const manifest = { format: 1, targetManifestSha256, deploymentId, packageLockSha256, entries };
stateLib.publishImmutableBytes(output, Buffer.from(`${JSON.stringify(manifest)}\n`), {
  crashLabelPrefix: 'runtime-dependency-manifest', allowExactExisting: true,
});
NODE

if [ "${OSI_STAGED_NPM_TEST_MODE:-0}" = 1 ] && [ "${OSI_STAGED_NPM_TEST_CRASH_AT:-}" = after-manifest-publication ]; then
    kill -9 $$
fi

MANIFEST_SHA256=$(hash_file "$MANIFEST_OUT")
printf 'RUNTIME_DEPENDENCY_MANIFEST_SHA256=%s\n' "$MANIFEST_SHA256"
