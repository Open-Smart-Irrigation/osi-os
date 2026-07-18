#!/bin/sh
set -eu

# Internal carrier mode. The ordinary launcher starts this exact resident in a
# private session, with descriptor 9 owned by the supervisor. Until the
# supervisor writes GO, no target argv is executed. If the supervisor dies,
# the pipe loses its final writer and this carrier exits on EOF.
if [ "${1:-}" = --gated-child ]; then
    [ "$#" -ge 6 ] || exit 125
    GATED_FILE=$2
    shift 2
    [ "${1:-}" = --launch-token-sha256 ] || exit 125
    [ -n "${2:-}" ] || exit 125
    shift 2
    [ "${1:-}" = -- ] || exit 125
    shift
    [ "$#" -gt 0 ] || exit 125
    exec 8>&- 9>&-
    IFS= read -r GATED_SIGNAL < "$GATED_FILE" || exit 125
    [ "$GATED_SIGNAL" = GO ] || exit 125
    exec "$@"
fi

# Do not allow caller-controlled command resolution anywhere on the permit
# consumption path.  The packaged Node runtime is an immutable deployment
# prerequisite and is validated again by the bound verifier below.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
NODE=/usr/bin/node
MKFIFO=/usr/bin/mkfifo

fail() {
    printf 'node-red-guarded-launch: %s\n' "$1" >&2
    exit 1
}

STATE_CLI=
ROOT=
GUARD_MARKER=
STATE=
RECEIPTS=
PROBE_NONCE_FILE=

while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
    [ "$#" -ge 2 ] || fail "missing value for $1"
    case "$1" in
        --state-cli) [ -z "$STATE_CLI" ] || fail 'duplicate --state-cli'; STATE_CLI=$2 ;;
        --root) [ -z "$ROOT" ] || fail 'duplicate --root'; ROOT=$2 ;;
        --guard-marker) [ -z "$GUARD_MARKER" ] || fail 'duplicate --guard-marker'; GUARD_MARKER=$2 ;;
        --state) [ -z "$STATE" ] || fail 'duplicate --state'; STATE=$2 ;;
        --receipts) [ -z "$RECEIPTS" ] || fail 'duplicate --receipts'; RECEIPTS=$2 ;;
        --probe-nonce-file) [ -z "$PROBE_NONCE_FILE" ] || fail 'duplicate --probe-nonce-file'; PROBE_NONCE_FILE=$2 ;;
        *) fail "unknown option: $1" ;;
    esac
    shift 2
done

[ "${1:-}" = -- ] || fail 'missing child command after --'
shift
[ "$#" -gt 0 ] || fail 'missing child command after --'
for value in "$STATE_CLI" "$ROOT" "$GUARD_MARKER" "$STATE" "$RECEIPTS"; do
    case "$value" in /*) ;; *) fail 'required paths must be absolute' ;; esac
done
if [ -n "$PROBE_NONCE_FILE" ]; then
    case "$PROBE_NONCE_FILE" in /*) ;; *) fail '--probe-nonce-file must be absolute' ;; esac
fi
case "$1" in /*) ;; *) fail 'child command must be absolute' ;; esac

# Bind the exact executable and complete argv to the immutable guard marker
# before asking the state CLI to consume a one-shot permit.  The state CLI
# independently verifies the marker's full authority envelope.
$NODE - "$GUARD_MARKER" "$STATE_CLI" "$0" "$@" <<'NODE' || fail 'launch authority does not match guard marker'
const fs = require('node:fs');
const crypto = require('node:crypto');
const markerPath = process.argv[2];
const stateCliPath = process.argv[3];
const launcherPath = process.argv[4];
const argv = process.argv.slice(5);
const nodePath = '/usr/bin/node';
if (process.execPath !== nodePath) throw new Error('unexpected Node runtime');
const nodeStat = fs.lstatSync(nodePath);
if (!nodeStat.isFile() || nodeStat.isSymbolicLink() || nodeStat.uid !== 0 ||
    (nodeStat.mode & 0o111) === 0 || (nodeStat.mode & 0o022) !== 0) {
  throw new Error('unsafe Node runtime');
}
const stat = fs.lstatSync(markerPath);
if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new Error('unsafe guard marker');
const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
const residents = marker.residents;
const stateCli = residents && !Array.isArray(residents) ? residents.stateCli : null;
if (!stateCli || Array.isArray(stateCli) ||
    Object.keys(stateCli).sort().join(',') !== 'mode,path,sha256' ||
    !Number.isInteger(stateCli.mode) || stateCli.mode !== 0o755 ||
    typeof stateCli.path !== 'string' || !stateCli.path.startsWith('/') ||
    !/^[0-9a-f]{64}$/.test(stateCli.sha256) || stateCli.path !== stateCliPath) {
  throw new Error('missing state CLI binding');
}
const stateCliStat = fs.lstatSync(stateCliPath);
if (!stateCliStat.isFile() || stateCliStat.isSymbolicLink() ||
    stateCliStat.uid !== process.getuid() ||
    (stateCliStat.mode & 0o777) !== stateCli.mode) {
  throw new Error('unsafe state CLI');
}
const stateCliSha256 = crypto.createHash('sha256').update(fs.readFileSync(stateCliPath)).digest('hex');
if (stateCliSha256 !== stateCli.sha256) throw new Error('state CLI hash mismatch');
const guardedLauncher = residents && residents.guardedLauncher;
if (!guardedLauncher || Array.isArray(guardedLauncher) ||
    Object.keys(guardedLauncher).sort().join(',') !== 'mode,path,sha256' ||
    guardedLauncher.path !== launcherPath || guardedLauncher.mode !== 0o755 ||
    !/^[0-9a-f]{64}$/.test(guardedLauncher.sha256)) {
  throw new Error('missing guarded launcher binding');
}
const launcherStat = fs.lstatSync(launcherPath);
if (!launcherStat.isFile() || launcherStat.isSymbolicLink() ||
    launcherStat.uid !== process.getuid() || (launcherStat.mode & 0o777) !== guardedLauncher.mode ||
    crypto.createHash('sha256').update(fs.readFileSync(launcherPath)).digest('hex') !== guardedLauncher.sha256) {
  throw new Error('unsafe guarded launcher');
}
const launch = marker.nodeRedLaunch;
if (!launch || Array.isArray(launch) || Object.keys(launch).sort().join(',') !== 'argvSha256,executable') throw new Error('missing launch binding');
const digest = crypto.createHash('sha256').update(JSON.stringify(argv)).digest('hex');
if (launch.executable !== argv[0] || launch.argvSha256 !== digest) throw new Error('launch binding mismatch');
NODE

if [ -n "$PROBE_NONCE_FILE" ]; then
    case "$PROBE_NONCE_FILE" in *.nonce) ;; *) fail '--probe-nonce-file must end in .nonce' ;; esac
    LAUNCH_TOKEN_FILE=${PROBE_NONCE_FILE%.nonce}.launch-token.json
    SUPERVISOR_STARTTIME=$($NODE - "$$" <<'NODE'
const fs = require('node:fs');
const raw = fs.readFileSync(`/proc/${process.argv[2]}/stat`, 'utf8');
const fields = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/);
if (fields.length < 20 || !/^\d+$/.test(fields[19])) throw new Error('missing supervisor starttime');
process.stdout.write(fields[19]);
NODE
    ) || fail 'supervisor process identity is unavailable'
    $NODE "$STATE_CLI" startup-check --root "$ROOT" --guard-marker "$GUARD_MARKER" \
        --state "$STATE" --receipts "$RECEIPTS" --service node-red \
        --probe-nonce-file "$PROBE_NONCE_FILE" --consume-probe-permit \
        --supervisor-pid "$$" --supervisor-process-starttime "$SUPERVISOR_STARTTIME"

    LAUNCH_TOKEN=$($NODE - "$LAUNCH_TOKEN_FILE" <<'NODE'
const fs = require('node:fs');
const p = process.argv[2];
const stat = fs.lstatSync(p);
if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
  throw new Error('unsafe launch token');
}
const value = JSON.parse(fs.readFileSync(p, 'utf8'));
if (!value || typeof value.token !== 'string' || !/^[0-9a-f]{64}$/.test(value.token)) throw new Error('invalid launch token');
process.stdout.write(value.token);
NODE
    ) || fail 'durable launch token is unavailable'
    export OSI_DEPLOY_LAUNCH_TOKEN="$LAUNCH_TOKEN"

    LAUNCH_STEM=${PROBE_NONCE_FILE%.nonce}
    LAUNCH_GATE_FILE=$LAUNCH_STEM.launch-gate
    LAUNCH_SPAWN_GATE=$LAUNCH_STEM.launch-spawn-gate
    SUPERVISOR_PIPE=$LAUNCH_STEM.supervisor-pipe
    CHILD_IDENTITY_FILE=$LAUNCH_STEM.launch-child.json
    LAUNCH_SPAWNER_IDENTITY_FILE=$LAUNCH_STEM.launch-spawner.json
    $NODE - "$LAUNCH_GATE_FILE" "$LAUNCH_SPAWN_GATE" "$SUPERVISOR_PIPE" "$CHILD_IDENTITY_FILE" "$LAUNCH_SPAWNER_IDENTITY_FILE" <<'NODE' \
        || fail 'stale launch artifacts are unsafe'
const fs = require('node:fs');
const path = require('node:path');
const entries = process.argv.slice(2).map((filePath, index) => ({
  filePath,
  kind: index < 3 ? 'fifo' : 'file',
}));
let changed = false;
for (const { filePath, kind } of entries) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  const rightType = kind === 'fifo' ? stat.isFIFO() : stat.isFile();
  if (!rightType || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
    throw new Error(`unsafe stale ${kind}: ${filePath}`);
  }
  fs.unlinkSync(filePath);
  changed = true;
}
if (changed) {
  const fd = fs.openSync(path.dirname(entries[0].filePath), 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
NODE
    [ ! -e "$LAUNCH_GATE_FILE" ] || fail 'launch gate already exists'
    [ ! -e "$LAUNCH_SPAWN_GATE" ] || fail 'launch spawn gate already exists'
    [ ! -e "$SUPERVISOR_PIPE" ] || fail 'supervisor pipe already exists'
    [ ! -e "$CHILD_IDENTITY_FILE" ] || fail 'launch child identity already exists'
    [ ! -e "$LAUNCH_SPAWNER_IDENTITY_FILE" ] || fail 'launch spawner identity already exists'
    [ -x "$MKFIFO" ] || fail 'mkfifo is unavailable'
    umask 077
    "$MKFIFO" -m 600 "$LAUNCH_GATE_FILE"
    "$MKFIFO" -m 600 "$LAUNCH_SPAWN_GATE"
    "$MKFIFO" -m 600 "$SUPERVISOR_PIPE"
    exec 9<> "$LAUNCH_GATE_FILE"
    exec 8<> "$SUPERVISOR_PIPE"

    CHILD_PID=
    WATCHER_PID=
    SPAWNER_PID=
    terminate_child_group() {
        [ -n "$CHILD_PID" ] || return 0
        kill -TERM "-$CHILD_PID" 2>/dev/null || kill -TERM "$CHILD_PID" 2>/dev/null || true
        sleep 1
        kill -KILL "-$CHILD_PID" 2>/dev/null || kill -KILL "$CHILD_PID" 2>/dev/null || true
    }
    terminate_spawner() {
        [ -n "$SPAWNER_PID" ] || return 0
        kill -TERM "$SPAWNER_PID" 2>/dev/null || true
        sleep 1
        kill -KILL "$SPAWNER_PID" 2>/dev/null || true
        wait "$SPAWNER_PID" 2>/dev/null || true
        SPAWNER_PID=
    }
    cleanup_launch() {
        terminate_child_group
        terminate_spawner
        exec 9>&- 2>/dev/null || true
        exec 8>&- 2>/dev/null || true
        [ -z "$WATCHER_PID" ] || wait "$WATCHER_PID" 2>/dev/null || true
        rm -f "$LAUNCH_GATE_FILE" "$LAUNCH_SPAWN_GATE" "$SUPERVISOR_PIPE" \
            "$CHILD_IDENTITY_FILE" "$LAUNCH_SPAWNER_IDENTITY_FILE"
    }
    trap cleanup_launch EXIT
    trap 'terminate_child_group; exit 143' TERM
    trap 'terminate_child_group; exit 130' INT
    trap 'terminate_child_group; exit 129' HUP

    $NODE - "$CHILD_IDENTITY_FILE" "$LAUNCH_SPAWNER_IDENTITY_FILE" "$LAUNCH_SPAWN_GATE" "$$" "$SUPERVISOR_STARTTIME" "$0" "$LAUNCH_GATE_FILE" "$@" 8>&- 9>&- <<'NODE' &
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const identityPath = process.argv[2];
const spawnerIdentityPath = process.argv[3];
const spawnGatePath = process.argv[4];
const supervisorPid = Number(process.argv[5]);
const supervisorStartTime = process.argv[6];
const launcher = process.argv[7];
const gate = process.argv[8];
const targetArgv = process.argv.slice(9);
const token = process.env.OSI_DEPLOY_LAUNCH_TOKEN || '';
if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('missing launch token');
if (!Number.isInteger(supervisorPid) || supervisorPid <= 0 || !/^\d+$/.test(supervisorStartTime)) {
  throw new Error('invalid supervisor identity');
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const processStartTime = (pid) => {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/);
    return fields.length >= 20 && /^\d+$/.test(fields[19]) ? fields[19] : null;
  } catch (_error) { return null; }
};
const supervisorAlive = () => processStartTime(supervisorPid) === supervisorStartTime;
const ownArgvSha256 = crypto.createHash('sha256').update(JSON.stringify(process.argv)).digest('hex');
const holdBeforeIdentity = process.env.OSI_REPAIR_PROGRAM_MODE === '1'
  && process.env.OSI_DEPLOY_ARTIFACT_MODE === 'test'
  && process.env.OSI_DEPLOY_LAUNCH_TEST_HOLD_BEFORE_SPAWNER_IDENTITY_FILE;
if (holdBeforeIdentity) {
  fs.writeFileSync(holdBeforeIdentity, `${process.pid}\n`, { mode: 0o600 });
  while (!fs.existsSync(`${holdBeforeIdentity}.continue`)) sleep(10);
}
const spawnerStartTime = processStartTime(process.pid);
if (!spawnerStartTime) throw new Error('missing spawner starttime');
const spawnerFd = fs.openSync(spawnerIdentityPath,
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
try {
  fs.writeFileSync(spawnerFd, `${JSON.stringify({
    format: 1, pid: process.pid, processStartTime: spawnerStartTime, argvSha256: ownArgvSha256,
  })}\n`);
  fs.fsyncSync(spawnerFd);
} finally { fs.closeSync(spawnerFd); }
const spawnerDirFd = fs.openSync(path.dirname(spawnerIdentityPath), 'r');
try { fs.fsyncSync(spawnerDirFd); } finally { fs.closeSync(spawnerDirFd); }
const spawnGateFd = fs.openSync(spawnGatePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
const signal = Buffer.alloc(32);
for (;;) {
  let signalRead = 0;
  try { signalRead = fs.readSync(spawnGateFd, signal, 0, signal.length, null); }
  catch (error) { if (error.code !== 'EAGAIN') throw error; }
  if (signalRead > 0) {
    if (signal.subarray(0, signalRead).toString('utf8') !== 'SPAWN\n') process.exit(125);
    break;
  }
  if (!supervisorAlive()) process.exit(125);
  sleep(10);
}
fs.closeSync(spawnGateFd);
if (!supervisorAlive()) process.exit(125);
const spawnerStat = fs.lstatSync(spawnerIdentityPath);
if (!spawnerStat.isFile() || spawnerStat.isSymbolicLink() || spawnerStat.uid !== process.getuid()
    || (spawnerStat.mode & 0o777) !== 0o600 || spawnerStat.nlink !== 1) throw new Error('unsafe spawner identity');
const spawnerIdentity = JSON.parse(fs.readFileSync(spawnerIdentityPath, 'utf8'));
if (!spawnerIdentity || spawnerIdentity.format !== 1 || spawnerIdentity.pid !== process.pid
    || typeof spawnerIdentity.processStartTime !== 'string' || !/^\d+$/.test(spawnerIdentity.processStartTime)
    || typeof spawnerIdentity.argvSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(spawnerIdentity.argvSha256)
    || Object.keys(spawnerIdentity).sort().join(',') !== 'argvSha256,format,pid,processStartTime') {
  throw new Error('spawner identity mismatch');
}
if (spawnerIdentity.argvSha256 !== ownArgvSha256) throw new Error('spawner argv identity mismatch');
const tokenSha256 = crypto.createHash('sha256').update(token).digest('hex');
let child;
const terminateChild = () => {
  if (!child || !child.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch (_error) { try { child.kill('SIGTERM'); } catch (_ignored) {} }
  sleep(50);
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_error) { try { child.kill('SIGKILL'); } catch (_ignored) {} }
};
process.once('SIGTERM', () => { terminateChild(); process.exit(143); });
process.once('SIGINT', () => { terminateChild(); process.exit(130); });
process.once('SIGHUP', () => { terminateChild(); process.exit(129); });
const supervisorWatch = setInterval(() => {
  if (!supervisorAlive()) { terminateChild(); process.exit(125); }
}, 10);
child = spawn('/bin/sh', [launcher, '--gated-child', gate,
  '--launch-token-sha256', tokenSha256, '--', ...targetArgv], {
  detached: true,
  stdio: 'ignore',
  env: process.env,
});
const publishChildIdentity = () => {
  if (!supervisorAlive()) { terminateChild(); process.exit(125); }
  const raw = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8');
  const fields = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/);
  if (fields.length < 20 || !/^\d+$/.test(fields[19])) throw new Error('missing child starttime');
  if (fields[2] !== String(child.pid) || fields[3] !== String(child.pid)) throw new Error('child has no private process group/session');
  if (!supervisorAlive()) { terminateChild(); process.exit(125); }
  const fd = fs.openSync(identityPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify({ format: 1, pid: child.pid, processStartTime: fields[19] })}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const dirFd = fs.openSync(path.dirname(identityPath), 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  const signalStatus = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143, SIGKILL: 137 };
  child.once('error', (error) => { throw error; });
  child.once('exit', (code, signal) => {
    clearInterval(supervisorWatch);
    process.exit(code === null ? (signalStatus[signal] || 1) : code);
  });
};
if (process.env.OSI_REPAIR_PROGRAM_MODE === '1' && process.env.OSI_DEPLOY_ARTIFACT_MODE === 'test'
    && process.env.OSI_DEPLOY_LAUNCH_TEST_HOLD_AFTER_SPAWN_FILE) {
  const holdFile = process.env.OSI_DEPLOY_LAUNCH_TEST_HOLD_AFTER_SPAWN_FILE;
  fs.writeFileSync(holdFile, `${child.pid}\n`, { mode: 0o600 });
  const waitForContinue = () => {
    if (!supervisorAlive()) { terminateChild(); process.exit(125); }
    if (fs.existsSync(`${holdFile}.continue`)) return publishChildIdentity();
    setTimeout(waitForContinue, 10);
  };
  waitForContinue();
} else {
  publishChildIdentity();
}
NODE
    SPAWNER_PID=$!
    $NODE - "$LAUNCH_SPAWNER_IDENTITY_FILE" "$SPAWNER_PID" <<'NODE' \
        || fail 'spawner identity was not durably recorded'
const fs = require('node:fs');
const identityPath = process.argv[2];
const pid = Number(process.argv[3]);
if (!/^\d+$/.test(String(pid))) throw new Error('invalid spawner pid');
let value;
for (let i = 0; i < 300; i += 1) {
  try {
    const stat = fs.lstatSync(identityPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) throw new Error('unsafe spawner identity');
    value = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    break;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { process.kill(pid, 0); } catch (_dead) { throw new Error('spawner exited before identity publication'); }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
if (!value || value.format !== 1 || value.pid !== pid || typeof value.processStartTime !== 'string'
    || !/^\d+$/.test(value.processStartTime) || typeof value.argvSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.argvSha256)
    || Object.keys(value).sort().join(',') !== 'argvSha256,format,pid,processStartTime') {
  throw new Error('invalid spawner identity');
}
NODE
    printf 'SPAWN\n' > "$LAUNCH_SPAWN_GATE" || fail 'spawner gate could not be opened'
    CHILD_IDENTITY=$($NODE - "$CHILD_IDENTITY_FILE" "$SPAWNER_PID" 8>&- 9>&- <<'NODE'
const fs = require('node:fs');
const identityPath = process.argv[2];
const spawnerPid = Number(process.argv[3]);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let value;
for (let i = 0; i < 300; i += 1) {
  try {
    const stat = fs.lstatSync(identityPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) throw new Error('unsafe child identity');
    value = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    break;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { process.kill(spawnerPid, 0); } catch (_dead) { throw new Error('carrier spawner exited before identity publication'); }
    sleep(10);
  }
}
if (!value || value.format !== 1 || !Number.isInteger(value.pid) || value.pid <= 0
    || typeof value.processStartTime !== 'string' || !/^\d+$/.test(value.processStartTime)
    || Object.keys(value).sort().join(',') !== 'format,pid,processStartTime') {
  throw new Error('invalid child identity');
}
process.stdout.write(`${value.pid} ${value.processStartTime}`);
NODE
    ) || fail 'child process identity is unavailable'
    CHILD_PID=${CHILD_IDENTITY%% *}
    CHILD_STARTTIME=${CHILD_IDENTITY#* }

    # This watchdog owns no writer descriptor. A supervisor SIGKILL closes
    # descriptor 8, causing EOF and termination of the exact private process
    # group even after the carrier has exec'd Node-RED.
    /bin/sh -c '
      child=$1
      pipe=$2
      exec 8>&- 9>&-
      if IFS= read -r _signal < "$pipe"; then exit 0; fi
      kill -TERM "-$child" 2>/dev/null || kill -TERM "$child" 2>/dev/null || true
      sleep 1
      kill -KILL "-$child" 2>/dev/null || kill -KILL "$child" 2>/dev/null || true
    ' osi-launch-watchdog "$CHILD_PID" "$SUPERVISOR_PIPE" &
    WATCHER_PID=$!

    if ! $NODE "$STATE_CLI" record-launch-start --root "$ROOT" --guard-marker "$GUARD_MARKER" \
        --state "$STATE" --receipts "$RECEIPTS" --service node-red \
        --launch-token-file "$LAUNCH_TOKEN_FILE" --child-pid "$CHILD_PID" \
        --child-process-starttime "$CHILD_STARTTIME" --supervisor-pid "$$" \
        --supervisor-process-starttime "$SUPERVISOR_STARTTIME" \
        --launch-gate-file "$LAUNCH_GATE_FILE" 8>&- 9>&-; then
        fail 'child-start authority was not recorded'
    fi
    printf 'GO\n' >&9
    exec 9>&-
    set +e
    wait "$SPAWNER_PID"
    CHILD_STATUS=$?
    set -e
    SPAWNER_PID=
    CHILD_PID=
    exec 8>&-
    wait "$WATCHER_PID" 2>/dev/null || true
    WATCHER_PID=
    exit "$CHILD_STATUS"
else
    $NODE "$STATE_CLI" startup-check --root "$ROOT" --guard-marker "$GUARD_MARKER" \
        --state "$STATE" --receipts "$RECEIPTS" --service node-red
    exec "$@"
fi
