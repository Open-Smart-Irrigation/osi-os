'use strict';
// Behavioural tests for the gateway records deploy.sh keeps outside the
// Node-RED payload: the reported firmware version (UCI
// osi-server.cloud.firmware_version) and the osi-bootstrap service that
// provisions ChirpStack at boot.
//
// deploy.sh mutates real system paths from its first line, so these tests do
// not run it whole. They extract the real shell functions and fragments
// (between their own begin/end markers) and run them under a POSIX shell with
// `uci`, `logread`, `sleep`, the payload switch and the init scripts stubbed. Run with a BusyBox `sh` first
// on PATH to check the fragments under ash.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const DEPLOY = fs.readFileSync(path.join(REPO, 'deploy.sh'), 'utf8');
const VERSION_SOURCE_REL = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config';

function extractFunction(name) {
  const open = new RegExp(`^${name}\\(\\) \\{$`, 'm').exec(DEPLOY);
  assert.ok(open, `deploy.sh is missing ${name}()`);
  const close = DEPLOY.indexOf('\n}\n', open.index);
  assert.ok(close > open.index, `deploy.sh ${name}() has no closing brace`);
  return DEPLOY.slice(open.index, close + 3);
}

function extractBetween(beginMarker, endMarker) {
  const begin = new RegExp(`^[ \\t]*${beginMarker}[ \\t]*$`, 'm').exec(DEPLOY);
  const end = new RegExp(`^[ \\t]*${endMarker}[ \\t]*$`, 'm').exec(DEPLOY);
  assert.ok(begin, `deploy.sh is missing the "${beginMarker}" marker`);
  assert.ok(end, `deploy.sh is missing the "${endMarker}" marker`);
  assert.ok(end.index > begin.index, `"${beginMarker}" must precede "${endMarker}"`);
  return DEPLOY.slice(DEPLOY.indexOf('\n', begin.index) + 1, end.index);
}

// Every temporary directory is removed when the file's tests finish, even
// when an assertion fails before a test's own cleanup.
const TEMP_DIRS = [];
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

function writeExecutable(file, lines) {
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o755 });
}

// A uci stand-in backed by a flat file: one "key=value" line per option, plus
// a "section" marker when osi-server.cloud exists. Every call is logged.
function writeUciStub(binDir) {
  writeExecutable(path.join(binDir, 'uci'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$UCI_LOG"',
    '[ "$1" = "-q" ] && shift',
    'case "$1" in',
    '  get)',
    '    if [ "$2" = "osi-server.cloud" ]; then',
    '      grep -qx "section" "$UCI_STATE" && { echo osi_server; exit 0; }',
    '      exit 1',
    '    fi',
    '    key="${2#osi-server.cloud.}"',
    '    line="$(grep "^$key=" "$UCI_STATE" 2>/dev/null | head -n 1)"',
    '    [ -n "$line" ] || exit 1',
    '    echo "${line#*=}"',
    '    ;;',
    '  set)',
    '    [ "${UCI_FAIL_SET:-0}" = "1" ] && exit 1',
    '    grep -qx "section" "$UCI_STATE" || exit 1',
    '    kv="${2#osi-server.cloud.}"',
    '    grep -v "^${kv%%=*}=" "$UCI_STATE" > "$UCI_STATE.tmp" || true',
    '    echo "$kv" >> "$UCI_STATE.tmp"',
    '    mv "$UCI_STATE.tmp" "$UCI_STATE"',
    '    ;;',
    '  delete)',
    '    key="${2#osi-server.cloud.}"',
    '    grep -v "^${key}=" "$UCI_STATE" > "$UCI_STATE.tmp" || true',
    '    mv "$UCI_STATE.tmp" "$UCI_STATE"',
    '    ;;',
    '  commit) [ "${UCI_FAIL_COMMIT:-0}" = "1" ] && exit 1; exit 0 ;;',
    '  revert) exit 0 ;;',
    '  *) exit 0 ;;',
    'esac',
  ]);
}

// PATH for the child: stub dir first, then only the standard system dirs, so a
// workstation-installed uci can never leak into the "no uci" case.
function childPath(binDir) {
  const shellDir = path.dirname(resolveShell());
  return [binDir, shellDir, '/usr/local/bin', '/usr/bin', '/bin'].join(':');
}

function resolveShell() {
  for (const dir of (process.env.PATH || '').split(':')) {
    const candidate = path.join(dir, 'sh');
    if (dir && fs.existsSync(candidate)) return candidate;
  }
  return '/bin/sh';
}

function runShell(script, env) {
  return spawnSync(resolveShell(), ['-c', script], { encoding: 'utf8', env });
}

function uciFixture({ section = true, version = null } = {}) {
  const dir = tempDir('osi-deploy-uci-');
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  const state = path.join(dir, 'uci.state');
  const lines = [];
  if (section) lines.push('section');
  if (version !== null) lines.push(`firmware_version=${version}`);
  fs.writeFileSync(state, lines.join('\n') + (lines.length ? '\n' : ''));
  const log = path.join(dir, 'uci.log');
  fs.writeFileSync(log, '');
  return { dir, binDir, state, log };
}

function readState(fixture) {
  const line = fs.readFileSync(fixture.state, 'utf8').split('\n').find((l) => l.startsWith('firmware_version='));
  return line ? line.slice('firmware_version='.length) : null;
}

function uciCalls(fixture) {
  return fs.readFileSync(fixture.log, 'utf8').split('\n').filter(Boolean);
}

// ---------------------------------------------------------------------------
// Where the version comes from
// ---------------------------------------------------------------------------

function treeVersion() {
  const text = fs.readFileSync(path.join(REPO, VERSION_SOURCE_REL), 'utf8');
  const m = /^set osi-server\.cloud\.firmware_version=(.+)$/m.exec(text);
  assert.ok(m, `${VERSION_SOURCE_REL} must set osi-server.cloud.firmware_version`);
  return m[1].trim();
}

function runReadVersion(base) {
  const dir = tempDir('osi-deploy-version-');
  try {
    const script = `set -eu
BASE=${JSON.stringify(base)}
TMP_DIR=${JSON.stringify(dir)}
${extractFunction('fetch')}
${extractFunction('read_release_firmware_version')}
v="$(read_release_firmware_version)"
printf 'VERSION=[%s]\\n' "$v"
`;
    return runShell(script, { PATH: childPath(dir) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the release version is read from the fetched first-boot config, the one file that sets the key on a flashed image', () => {
  const result = runReadVersion(`file://${REPO}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`VERSION=\\[${treeVersion().replace(/\./g, '\\.')}\\]`));
});

test('an unreadable or implausible version source yields no version and does not fail', () => {
  const missing = runReadVersion('file:///nonexistent-osi-release-prep');
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /VERSION=\[\]/);

  const root = tempDir('osi-deploy-version-src-');
  try {
    const file = path.join(root, VERSION_SOURCE_REL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\nset osi-server.cloud.firmware_version=$(cat /etc/x)\n');
    const bogus = runReadVersion(`file://${root}`);
    assert.equal(bogus.status, 0, bogus.stderr);
    assert.match(bogus.stdout, /VERSION=\[\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deploy.sh reads the version and captures the previous value before any gateway state changes', () => {
  const readAt = DEPLOY.indexOf('DEPLOY_FIRMWARE_VERSION="$(read_release_firmware_version)"');
  const captureAt = DEPLOY.indexOf('\ncapture_previous_firmware_version\n');
  const firstInstall = DEPLOY.indexOf('fetch_required "Node-RED settings.js"');
  assert.ok(readAt > 0, 'deploy.sh must read the release version into DEPLOY_FIRMWARE_VERSION');
  assert.ok(captureAt > readAt, 'deploy.sh must capture the previous value after reading the release version');
  assert.ok(captureAt < firstInstall, 'both must happen before the first file is installed');
});

// ---------------------------------------------------------------------------
// The three version helpers: capture, apply (forward flip), restore (flip back)
// ---------------------------------------------------------------------------

const FW_FUNCTIONS = () => [
  'capture_previous_firmware_version',
  'apply_release_firmware_version',
  'restore_previous_firmware_version',
].map(extractFunction).join('\n');

function runFw(fixture, body, extraEnv = {}) {
  const script = `set -eu
${FW_FUNCTIONS()}
${body}
echo "RC=$? W=\${FW_WRITTEN:-0} PREV=[\${FW_PREV:-}] PREV_SET=\${FW_PREV_SET:-0}"
`;
  return runShell(script, {
    PATH: childPath(fixture.binDir),
    UCI_LOG: fixture.log,
    UCI_STATE: fixture.state,
    ...extraEnv,
  });
}

function writeCalls(fixture) {
  return uciCalls(fixture).map((c) => c.replace(/^-q /, '')).filter((c) => /^(set|delete|commit) /.test(c));
}

test('capture records the previous value and writes nothing', () => {
  const set = uciFixture({ version: '0.6.5' });
  const unset = uciFixture();
  const noUci = uciFixture({ version: '0.6.5' });
  writeUciStub(set.binDir);
  writeUciStub(unset.binDir);
  let r = runFw(set, 'capture_previous_firmware_version');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREV=\[0\.6\.5\] PREV_SET=1/);
  assert.deepEqual(writeCalls(set), []);
  r = runFw(unset, 'capture_previous_firmware_version');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREV=\[\] PREV_SET=0/);
  r = runFw(noUci, 'capture_previous_firmware_version');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREV_SET=0/);
});

test('apply sets and commits the key and marks it written', () => {
  const fx = uciFixture({ version: '0.6.5' });
  writeUciStub(fx.binDir);
  const r = runFw(fx, 'capture_previous_firmware_version\napply_release_firmware_version 0.8.0');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RC=0 W=1/);
  assert.equal(readState(fx), '0.8.0');
  assert.deepEqual(writeCalls(fx), ['set osi-server.cloud.firmware_version=0.8.0', 'commit osi-server']);
});

test('apply leaves an equal value alone and marks nothing to restore', () => {
  const fx = uciFixture({ version: '0.8.0' });
  writeUciStub(fx.binDir);
  const r = runFw(fx, 'capture_previous_firmware_version\napply_release_firmware_version 0.8.0');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RC=0 W=0/);
  assert.deepEqual(writeCalls(fx), []);
});

test('apply tolerates no uci, no section, failed set or commit and an unknown version', () => {
  const cases = [
    { name: 'no uci', fixture: { version: '0.6.5' }, stub: false, version: '0.8.0', stderr: /uci not found/ },
    { name: 'no section', fixture: { section: false }, version: '0.8.0', stderr: /osi-server\.cloud is missing/ },
    { name: 'failed set', fixture: { version: '0.6.5' }, version: '0.8.0', env: { UCI_FAIL_SET: '1' }, stderr: /could not write/ },
    { name: 'failed commit', fixture: { version: '0.6.5' }, version: '0.8.0', env: { UCI_FAIL_COMMIT: '1' }, stderr: /could not write/ },
    { name: 'unknown version', fixture: { version: '0.6.5' }, version: '', stderr: /release version unknown/ },
  ];
  for (const c of cases) {
    const fx = uciFixture(c.fixture);
    if (c.stub !== false) writeUciStub(fx.binDir);
    const r = runFw(fx, `apply_release_firmware_version ${JSON.stringify(c.version)}`, c.env || {});
    assert.equal(r.status, 0, `${c.name}: ${r.stderr}`);
    assert.match(r.stdout, /RC=0 W=0/, c.name);
    assert.match(r.stderr, c.stderr, c.name);
    assert.ok(!uciCalls(fx).some((x) => x === 'set osi-server.cloud.firmware_version='), `${c.name}: never an empty value`);
  }
});

test('restore puts a previous value back, or deletes the option when it was unset', () => {
  const set = uciFixture({ version: '0.6.5' });
  writeUciStub(set.binDir);
  let r = runFw(set, 'capture_previous_firmware_version\napply_release_firmware_version 0.8.0\nrestore_previous_firmware_version');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RC=0 W=0/);
  assert.equal(readState(set), '0.6.5');
  assert.deepEqual(writeCalls(set).slice(-2), ['set osi-server.cloud.firmware_version=0.6.5', 'commit osi-server']);

  const unset = uciFixture();
  writeUciStub(unset.binDir);
  r = runFw(unset, 'capture_previous_firmware_version\napply_release_firmware_version 0.8.0\nrestore_previous_firmware_version');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readState(unset), null);
  assert.deepEqual(writeCalls(unset).slice(-2), ['delete osi-server.cloud.firmware_version', 'commit osi-server']);
});

test('restore without a write does nothing, and a failed restore is logged, not fatal', () => {
  const fx = uciFixture({ version: '0.6.5' });
  writeUciStub(fx.binDir);
  let r = runFw(fx, 'capture_previous_firmware_version\nrestore_previous_firmware_version');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(writeCalls(fx), []);

  r = runFw(fx, 'FW_WRITTEN=1\nFW_PREV=0.6.5\nFW_PREV_SET=1\nrestore_previous_firmware_version', { UCI_FAIL_COMMIT: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RC=0/);
  assert.match(r.stderr, /could not restore/);
});

// ---------------------------------------------------------------------------
// Placement: the version follows the payload
// ---------------------------------------------------------------------------

// Shell snippet: the firmware_version in the stub UCI state right now.
const FW_NOW = 'fw="$(grep "^firmware_version=" "$UCI_STATE" | head -n 1)"; fw="${fw#firmware_version=}"; [ -n "$fw" ] || fw="unset"';

// Stubs that log each payload switch and Node-RED restart with the UCI value
// in force at that moment, so a test can read the order of write and restart.
function writeEventStubs(fx) {
  fx.events = path.join(fx.dir, 'events.log');
  fs.writeFileSync(fx.events, '');
  writeExecutable(path.join(fx.binDir, 'node-red-init'), [
    '#!/bin/sh',
    FW_NOW,
    `echo "node-red $1 fw=$fw" >> ${JSON.stringify(fx.events)}`,
    'exit 0',
  ]);
  writeExecutable(path.join(fx.binDir, 'sleep'), ['#!/bin/sh', 'exit 0']);
  return `swap_call() {
  ${FW_NOW}
  case "$1" in
    flipTo|deactivate) echo "$1 $2 fw=$fw" >> ${JSON.stringify(fx.events)} ;;
  esac
  return 0
}
NODE_RED_INIT=${JSON.stringify(path.join(fx.binDir, 'node-red-init'))}
`;
}

function events(fx) {
  return fs.readFileSync(fx.events, 'utf8').split('\n').filter(Boolean);
}

// deploy.sh's real activation, self-check and commit-or-rollback region. The
// restart there names /etc/init.d/node-red literally; the copy run here points
// it at the logging stub.
function runActivationRegion({ logLine, prevStamp, version }) {
  const fx = uciFixture({ version });
  writeUciStub(fx.binDir);
  const stubs = writeEventStubs(fx);
  writeExecutable(path.join(fx.binDir, 'logread'), ['#!/bin/sh', `echo ${JSON.stringify(`gw node-red[1]: ${logLine}`)}`]);
  const region = extractBetween('# payload activation begin', '# self-check verdict end')
    .split('/etc/init.d/node-red restart').join('"$NODE_RED_INIT" restart');
  const script = `set -eu
${FW_FUNCTIONS()}
${extractFunction('cleanup_failed_first_payload')}
${stubs}
wait_for_node_red_health() { probe_elapsed=1; return 0; }
hold_node_red_stopped() { return 0; }
verify_payload_db_compatibility() { return 0; }
NODE_RED_LOG_MARK=0
GUI_ROOT=/nonexistent-gui
PAYLOAD_KEEP_N=5
PAYLOAD_FLIPPED=0
DEPLOY_STAMP=new-stamp
PREV_STAMP=${JSON.stringify(prevStamp || '')}
MIGRATION_RUNNER_AVAILABLE=1
DEPLOY_FIRMWARE_VERSION=0.8.0
capture_previous_firmware_version
${region}
echo "REACHED_END"
`;
  const result = runShell(script, {
    PATH: childPath(fx.binDir),
    UCI_LOG: fx.log,
    UCI_STATE: fx.state,
    NODE_RED_INIT_TIMEOUT: '2',
  });
  return { result, fx };
}

test('the new version is in UCI before the restart onto the new payload, and stays after a passing self-check', () => {
  const { result, fx } = runActivationRegion({ logLine: 'sync-init: schema init complete', prevStamp: 'old-stamp', version: '0.6.5' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /REACHED_END/);
  assert.deepEqual(events(fx), ['flipTo new-stamp fw=0.6.5', 'node-red restart fw=0.8.0']);
  assert.equal(readState(fx), '0.8.0');
});

test('a self-check rollback restores the old version before switching back', () => {
  const { result, fx } = runActivationRegion({ logLine: 'devices rebuild ABORTED (devices left intact): boom', prevStamp: 'old-stamp', version: '0.6.5' });
  assert.notEqual(result.status, 0, 'a rollback must still fail the deploy');
  assert.match(result.stderr, /ROLLED BACK/);
  assert.deepEqual(events(fx), [
    'flipTo new-stamp fw=0.6.5',
    'node-red restart fw=0.8.0',
    'flipTo old-stamp fw=0.6.5',
    'node-red restart fw=0.6.5',
  ]);
  assert.equal(readState(fx), '0.6.5');
});

test('a failed first deploy removes the version it wrote when there was none before', () => {
  const { result, fx } = runActivationRegion({ logLine: 'devices rebuild ABORTED (devices left intact): boom', prevStamp: '', version: null });
  assert.notEqual(result.status, 0);
  assert.deepEqual(events(fx), [
    'flipTo new-stamp fw=unset',
    'node-red restart fw=0.8.0',
    'deactivate new-stamp fw=unset',
  ]);
  assert.equal(readState(fx), null);
});

// deploy_exit_handler with the real restart_previous_payload and
// cleanup_failed_first_payload; identityd and service helpers stubbed.
function runExitHandler({ version, state }) {
  const fx = uciFixture({ version });
  writeUciStub(fx.binDir);
  const stubs = writeEventStubs(fx);
  const script = `set -eu
${FW_FUNCTIONS()}
${extractFunction('restart_previous_payload')}
${extractFunction('cleanup_failed_first_payload')}
${extractFunction('deploy_exit_handler')}
${stubs}
wait_for_node_red_health() { probe_elapsed=1; return 0; }
hold_node_red_stopped() { return 0; }
hold_identityd_stopped() { return 0; }
restore_identityd_prior_state() { return 0; }
verify_payload_db_compatibility() { return 0; }
restart_node_red() { ${FW_NOW}; echo "restart_node_red fw=$fw" >> "$EVENTS"; return 0; }
cleanup() { :; }
GUI_ROOT=/nonexistent-gui
DEPLOY_STAMP=new-stamp
DEPLOY_FIRMWARE_VERSION=0.8.0
capture_previous_firmware_version
${state}
deploy_exit_handler 1
`;
  const result = runShell(script, {
    PATH: childPath(fx.binDir),
    UCI_LOG: fx.log,
    UCI_STATE: fx.state,
    EVENTS: fx.events,
  });
  return { result, fx };
}

test('a step failing after activation restores the old version before the exit handler restarts the previous payload', () => {
  const { result, fx } = runExitHandler({
    version: '0.6.5',
    state: `swap_call flipTo new-stamp
apply_release_firmware_version "$DEPLOY_FIRMWARE_VERSION"
PAYLOAD_FLIPPED=1
DB_MIGRATION_COMMITTED=1
PREV_STAMP=old-stamp
node_red_restart_needed=0`,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(events(fx), [
    'flipTo new-stamp fw=0.6.5',
    'flipTo old-stamp fw=0.6.5',
    'node-red restart fw=0.6.5',
  ]);
  assert.equal(readState(fx), '0.6.5');
});

test('a first deploy failing after activation leaves the option as it was', () => {
  const { result, fx } = runExitHandler({
    version: null,
    state: `swap_call flipTo new-stamp
apply_release_firmware_version "$DEPLOY_FIRMWARE_VERSION"
PAYLOAD_FLIPPED=1
DB_MIGRATION_COMMITTED=1
PREV_STAMP=
node_red_restart_needed=1`,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(events(fx), ['flipTo new-stamp fw=unset', 'deactivate new-stamp fw=unset']);
  assert.equal(readState(fx), null);
});

test('a deploy failing before the flip never touches the version', () => {
  const { result, fx } = runExitHandler({
    version: '0.6.5',
    state: `PAYLOAD_FLIPPED=0
DB_MIGRATION_COMMITTED=0
PREV_STAMP=old-stamp
node_red_restart_needed=0`,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(readState(fx), '0.6.5');
  assert.deepEqual(writeCalls(fx), []);
});

test('every switch to the new payload is followed by the write, every switch back is preceded by the restore', () => {
  const lines = DEPLOY.split('\n');
  const forward = [];
  const back = [];
  lines.forEach((line, i) => {
    if (/swap_call flipTo "\$DEPLOY_STAMP"/.test(line)) forward.push(i);
    if (/swap_call flipTo "\$PREV_STAMP"|swap_call deactivate "\$DEPLOY_STAMP"/.test(line)) back.push(i);
  });
  assert.equal(forward.length, 2, 'two forward flip sites (migration path, activation block)');
  assert.equal(back.length, 3, 'three switch-back sites (restart_previous_payload, self-check rollback, first-deploy cleanup)');
  // Each forward flip is followed by the write before the next restart.
  for (const i of forward) {
    const rest = lines.slice(i);
    const restartAt = rest.findIndex((l) => /restart_node_red; then|\/etc\/init\.d\/node-red restart/.test(l));
    assert.ok(restartAt > 0, `no restart after the forward flip at line ${i + 1}`);
    assert.match(rest.slice(0, restartAt).join('\n'), /apply_release_firmware_version "\$\{DEPLOY_FIRMWARE_VERSION:-\}"/,
      `forward flip at line ${i + 1}`);
  }
  for (const i of back) {
    const before = lines.slice(Math.max(0, i - 8), i).join('\n');
    assert.match(before, /restore_previous_firmware_version/, `switch back at line ${i + 1}`);
  }
  // Migration path: the write sits between its flip and its restart.
  const mig = DEPLOY.indexOf('echo "--- Activate paired flows+GUI payload before Node-RED restart ---"');
  const migApply = DEPLOY.indexOf('apply_release_firmware_version', mig);
  const migRestart = DEPLOY.indexOf('if ! restart_node_red; then', mig);
  assert.ok(mig > 0 && migApply > mig && migApply < migRestart, 'migration path writes before restart_node_red');
  assert.equal(DEPLOY.indexOf('record_firmware_version'), -1, 'the post-commit writer is gone');
});

// ---------------------------------------------------------------------------
// osi-bootstrap: enabled on a stock gateway OS install (Path B)
// ---------------------------------------------------------------------------

const BOOTSTRAP_INIT_REL = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap';
const BOOTSTRAP_INIT = fs.readFileSync(path.join(REPO, BOOTSTRAP_INIT_REL), 'utf8');
const PROVISIONED_ENV = 'CHIRPSTACK_API_KEY=token\nCHIRPSTACK_APP_SENSORS=0a1b2c3d-0000-4000-8000-000000000001\n';

// rc.common stand-in: `enabled` tests for the rc.d link, `enable` creates it.
function bootstrapFixture({ enabled = false, env = null, stamp = false, failEnable = false } = {}) {
  const dir = tempDir('osi-deploy-bootstrap-');
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  const rcLink = path.join(dir, 'S99osi-bootstrap');
  const log = path.join(dir, 'init.log');
  fs.writeFileSync(log, '');
  if (enabled) fs.writeFileSync(rcLink, '');
  const init = path.join(dir, 'osi-bootstrap');
  writeExecutable(init, [
    '#!/bin/sh',
    `echo "$1" >> ${JSON.stringify(log)}`,
    'case "$1" in',
    `  enabled) [ -e ${JSON.stringify(rcLink)} ] ;;`,
    `  enable) ${failEnable ? 'exit 1' : `: > ${JSON.stringify(rcLink)}`} ;;`,
    '  *) exit 0 ;;',
    'esac',
  ]);
  const envFile = path.join(dir, 'chirpstack.env');
  if (env !== null) fs.writeFileSync(envFile, env);
  const stampFile = path.join(dir, 'osi-bootstrap.done');
  if (stamp) fs.writeFileSync(stampFile, '');
  return { dir, binDir, init, rcLink, log, envFile, stampFile };
}

function initCalls(fx) {
  return fs.readFileSync(fx.log, 'utf8').split('\n').filter(Boolean);
}

function runEnableBootstrap(fx) {
  const script = `set -eu
OSI_BOOTSTRAP_INIT=${JSON.stringify(fx.init)}
OSI_BOOTSTRAP_STAMP=${JSON.stringify(fx.stampFile)}
CHIRPSTACK_ENV_FILE=${JSON.stringify(fx.envFile)}
${extractFunction('enable_osi_bootstrap')}
enable_osi_bootstrap
echo "RC=$?"
`;
  return runShell(script, { PATH: childPath(fx.binDir) });
}

// The init script's own stamp check, pointed at the fixture paths: returns 0
// when the service would do nothing at boot.
function serviceWouldBeNoOp(fx) {
  const open = BOOTSTRAP_INIT.indexOf('stamp_valid() {');
  const close = BOOTSTRAP_INIT.indexOf('\n}\n', open);
  assert.ok(open >= 0 && close > open, 'osi-bootstrap must keep its stamp_valid() function');
  const fn = BOOTSTRAP_INIT.slice(open, close + 3)
    .split('/etc/osi-bootstrap.done').join(fx.stampFile)
    .split('/srv/node-red/.chirpstack.env').join(fx.envFile);
  const r = runShell(`${fn}\nstamp_valid`, { PATH: childPath(fx.binDir) });
  return r.status === 0;
}

test('a gateway without the service enabled gets it enabled, with no stamp when nothing is provisioned', () => {
  const fx = bootstrapFixture();
  try {
    const r = runEnableBootstrap(fx);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RC=0/);
    assert.ok(initCalls(fx).includes('enable'), initCalls(fx).join('\n'));
    assert.ok(fs.existsSync(fx.rcLink));
    assert.equal(fs.existsSync(fx.stampFile), false, 'an unprovisioned gateway must be provisioned at the next boot');
    assert.equal(serviceWouldBeNoOp(fx), false);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('a gateway where the service is already enabled is left as it is', () => {
  const fx = bootstrapFixture({ enabled: true, env: PROVISIONED_ENV });
  try {
    const r = runEnableBootstrap(fx);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(initCalls(fx), ['enabled']);
    assert.equal(fs.existsSync(fx.stampFile), false,
      'an enabled service keeps its own retry: a removed stamp means a restart request is still owed');
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('running twice enables once', () => {
  const fx = bootstrapFixture();
  try {
    assert.equal(runEnableBootstrap(fx).status, 0);
    assert.equal(runEnableBootstrap(fx).status, 0);
    assert.equal(initCalls(fx).filter((c) => c === 'enable').length, 1, initCalls(fx).join('\n'));
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('a gateway provisioned by hand gets the stamp, so the newly enabled service is a no-op', () => {
  const fx = bootstrapFixture({ env: PROVISIONED_ENV });
  try {
    const r = runEnableBootstrap(fx);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(fx.stampFile), r.stdout + r.stderr);
    assert.equal(serviceWouldBeNoOp(fx), true, 'the init script must treat this gateway as provisioned');
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('an env file without a provisioned sensors application gets no stamp', () => {
  const fx = bootstrapFixture({ env: 'CHIRPSTACK_API_KEY=token\nCHIRPSTACK_APP_SENSORS=\n' });
  try {
    assert.equal(runEnableBootstrap(fx).status, 0);
    assert.equal(fs.existsSync(fx.stampFile), false);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('a failed enable is logged and does not fail the deploy', () => {
  const fx = bootstrapFixture({ failEnable: true, env: PROVISIONED_ENV });
  try {
    const r = runEnableBootstrap(fx);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RC=0/);
    assert.match(r.stderr, /could not enable osi-bootstrap/);
    assert.equal(fs.existsSync(fx.stampFile), false);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('deploy.sh enables the service where it installs it, with the init script\'s stamp test', () => {
  const install = DEPLOY.indexOf('chmod 755 /etc/init.d/osi-bootstrap');
  const call = DEPLOY.indexOf('\nenable_osi_bootstrap\n', install);
  const nextStep = DEPLOY.indexOf('--- Remove legacy gateway GPS sidecar ---', install);
  assert.ok(install > 0 && call > install && call < nextStep,
    'enable_osi_bootstrap must run right after the service file is installed');
  assert.match(DEPLOY, /^OSI_BOOTSTRAP_INIT="\/etc\/init\.d\/osi-bootstrap"$/m);
  assert.match(DEPLOY, /^OSI_BOOTSTRAP_STAMP="\/etc\/osi-bootstrap\.done"$/m);
  assert.match(DEPLOY, /^CHIRPSTACK_ENV_FILE="\/srv\/node-red\/\.chirpstack\.env"$/m);
  const initPattern = /grep -q '(CHIRPSTACK_APP_SENSORS=[^']+)'/.exec(BOOTSTRAP_INIT);
  assert.ok(initPattern, 'osi-bootstrap stamp_valid pattern not found');
  assert.ok(extractFunction('enable_osi_bootstrap').includes(`'${initPattern[1]}'`),
    'deploy.sh must judge "provisioned" with the same pattern as the service');
});

// ---------------------------------------------------------------------------
// Header usage line and closing banner
// ---------------------------------------------------------------------------

test('the header shows the download-then-run form, not a pipe into sh', () => {
  const header = DEPLOY.slice(0, DEPLOY.indexOf('\nset -eu\n'));
  assert.doesNotMatch(header, /\|\s*sh\b/, 'a pipe into sh hides a failed download behind sh\'s exit status');
  assert.match(header, /curl -fsSL http:\/\/127\.0\.0\.1:9876\/deploy\.sh -o \/tmp\/osi-os-deploy\.sh && sh \/tmp\/osi-os-deploy\.sh; rc=\$\?; rm -f \/tmp\/osi-os-deploy\.sh; exit "\$rc"/);
});

function runBootstrapNote(fx, { rom }) {
  const romPath = path.join(fx.dir, 'rom', 'chirpstack-bootstrap.js');
  const fallbackPath = path.join(fx.dir, 'srv', 'chirpstack-bootstrap.js');
  fs.mkdirSync(path.dirname(fallbackPath), { recursive: true });
  fs.writeFileSync(fallbackPath, '');
  if (rom) {
    fs.mkdirSync(path.dirname(romPath), { recursive: true });
    fs.writeFileSync(romPath, '');
  }
  const script = `set -eu
OSI_BOOTSTRAP_INIT=${JSON.stringify(fx.init)}
OSI_BOOTSTRAP_STAMP=${JSON.stringify(fx.stampFile)}
CHIRPSTACK_ENV_FILE=${JSON.stringify(fx.envFile)}
BOOTSTRAP_SCRIPT_ROM=${JSON.stringify(romPath)}
BOOTSTRAP_SCRIPT_FALLBACK=${JSON.stringify(fallbackPath)}
${extractFunction('print_bootstrap_note')}
print_bootstrap_note
`;
  const r = runShell(script, { PATH: childPath(fx.binDir) });
  return { r, romPath, fallbackPath };
}

test('the banner names the bootstrap script path the service runs on this gateway', () => {
  const flashed = bootstrapFixture({ enabled: true, stamp: true, env: PROVISIONED_ENV });
  const { r: r1, romPath: rom1, fallbackPath: fb1 } = runBootstrapNote(flashed, { rom: true });
  assert.equal(r1.status, 0, r1.stderr);
  assert.ok(r1.stdout.includes(rom1), r1.stdout);
  assert.ok(!r1.stdout.includes(fb1), r1.stdout);
  const stock = bootstrapFixture({ enabled: true });
  const { r: r2, romPath: rom2, fallbackPath: fb2 } = runBootstrapNote(stock, { rom: false });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(r2.stdout.includes(fb2), r2.stdout);
  assert.ok(!r2.stdout.includes(rom2), r2.stdout);
});

test('the banner never tells the operator to run the bootstrap script directly', () => {
  for (const opts of [
    { enabled: true, stamp: true, env: PROVISIONED_ENV },
    { enabled: true },
    { enabled: false },
    { enabled: true, stamp: true },
  ]) {
    const fx = bootstrapFixture(opts);
    const { r } = runBootstrapNote(fx, { rom: false });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /^\s*node /m, JSON.stringify(opts));
    assert.match(r.stdout, /osi-bootstrap start/, JSON.stringify(opts));
  }
});

test('the banner calls a gateway provisioned only with a valid stamp and env file, like the service', () => {
  const cases = [
    { opts: { enabled: true, stamp: true, env: PROVISIONED_ENV }, expect: /ChirpStack is provisioned/ },
    { opts: { enabled: true, stamp: true }, expect: /not provisioned yet[\s\S]*next boot/ },
    { opts: { enabled: true }, expect: /not provisioned yet[\s\S]*next boot/ },
    { opts: { enabled: false }, expect: /not enabled[\s\S]*osi-bootstrap enable/ },
  ];
  for (const { opts, expect } of cases) {
    const fx = bootstrapFixture(opts);
    const { r } = runBootstrapNote(fx, { rom: false });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, expect, JSON.stringify(opts));
  }
});

test('the printed re-provision command reuses the API key and goes through the service', () => {
  const fx = bootstrapFixture({ enabled: true, stamp: true, env: PROVISIONED_ENV });
  // The init stand-in records the key the command passes to `start`.
  writeExecutable(fx.init, [
    '#!/bin/sh',
    `echo "$1 key=\${CHIRPSTACK_API_KEY:-}" >> ${JSON.stringify(fx.log)}`,
    'exit 0',
  ]);
  const { r } = runBootstrapNote(fx, { rom: false });
  const cmd = r.stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('rm -f '));
  assert.ok(cmd, r.stdout);
  const run = runShell(cmd, { PATH: childPath(fx.binDir) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.existsSync(fx.stampFile), false, 'the stamp is cleared so the service reruns');
  assert.deepEqual(initCalls(fx), ['start key=token']);
});

// The init script's start(), run by hand on a not yet provisioned gateway,
// with ChirpStack, node, logger and identityd stubbed: it must write the
// stamp, which a bare `node chirpstack-bootstrap.js` does not.
test('running the service by hand provisions and writes the stamp', () => {
  const fx = bootstrapFixture({ enabled: true });
  const script = path.join(fx.dir, 'chirpstack-bootstrap.js');
  fs.writeFileSync(script, '');
  writeExecutable(path.join(fx.binDir, 'curl'), ['#!/bin/sh', 'exit 0']);
  writeExecutable(path.join(fx.binDir, 'logger'), ['#!/bin/sh', 'exit 0']);
  writeExecutable(path.join(fx.binDir, 'node'), [
    '#!/bin/sh',
    `printf 'CHIRPSTACK_APP_SENSORS=0a1b2c3d-0000-4000-8000-000000000001\\n' > ${JSON.stringify(fx.envFile)}`,
  ]);
  writeExecutable(path.join(fx.binDir, 'identityd-init'), ['#!/bin/sh', 'exit 0']);
  writeExecutable(path.join(fx.binDir, 'identityd.sh'), ['#!/bin/sh', `echo "restart-request $*" >> ${JSON.stringify(fx.log)}`]);
  const body = BOOTSTRAP_INIT
    .slice(BOOTSTRAP_INIT.indexOf('stamp_valid() {'))
    .split('/etc/osi-bootstrap.done').join(fx.stampFile)
    .split('/srv/node-red/.chirpstack.env').join(fx.envFile)
    .split('/etc/init.d/osi-identityd').join(path.join(fx.binDir, 'identityd-init'))
    .split('/usr/libexec/osi-identityd.sh').join(path.join(fx.binDir, 'identityd.sh'));
  const r = runShell(`BOOTSTRAP_ROM=/nonexistent-rom.js\nBOOTSTRAP_FALLBACK=${JSON.stringify(script)}\n${body}\nstart`,
    { PATH: childPath(fx.binDir) });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(fx.stampFile), 'start() must write the stamp');
  assert.equal(serviceWouldBeNoOp(fx), true);
  assert.ok(initCalls(fx).some((c) => c.startsWith('restart-request request-restart chirpstack_bootstrap')), initCalls(fx).join('\n'));
});

test('the closing banner calls print_bootstrap_note and hard-codes no bootstrap path', () => {
  const banner = DEPLOY.slice(DEPLOY.indexOf('echo "=== Deploy complete. ==="'));
  assert.ok(banner.includes('\nprint_bootstrap_note\n'), 'the banner must print the bootstrap note');
  assert.doesNotMatch(banner, /chirpstack-bootstrap\.js/);
  assert.match(DEPLOY, /^BOOTSTRAP_SCRIPT_ROM="\/usr\/share\/node-red\/chirpstack-bootstrap\.js"$/m);
  assert.match(DEPLOY, /^BOOTSTRAP_SCRIPT_FALLBACK="\/srv\/node-red\/chirpstack-bootstrap\.js"$/m);
  // Same precedence as the service itself.
  assert.match(BOOTSTRAP_INIT, /BOOTSTRAP_ROM="\/usr\/share\/node-red\/chirpstack-bootstrap\.js"/);
  assert.match(BOOTSTRAP_INIT, /BOOTSTRAP_FALLBACK="\/srv\/node-red\/chirpstack-bootstrap\.js"/);
});

test('a failed Kiwi/Clover profile repair is repeated in the closing banner with the exact rerun command', () => {
  const repair = DEPLOY.indexOf('--repair-soil-profiles; then');
  const complete = DEPLOY.indexOf('echo "=== Deploy complete. ==="');
  assert.ok(repair > 0 && complete > repair, 'repair step runs before the closing banner');
  const before = DEPLOY.slice(0, repair);
  assert.match(before.slice(before.lastIndexOf('\n\n')), /soil_profile_repair_failed=0/, 'flag initialised right before the repair step');
  const elseBranch = DEPLOY.slice(repair, DEPLOY.indexOf('\nfi\n', repair));
  assert.match(elseBranch, /else[\s\S]*soil_profile_repair_failed=1/, 'flag set when the repair fails');
  const banner = DEPLOY.slice(complete);
  assert.match(banner,
    /if \[ "\$soil_profile_repair_failed" = 1 \]; then[\s\S]*node \$BOOTSTRAP_SCRIPT_FALLBACK --repair-soil-profiles[\s\S]*fi/,
    'the closing banner repeats the warning with the /srv/node-red command');
});
