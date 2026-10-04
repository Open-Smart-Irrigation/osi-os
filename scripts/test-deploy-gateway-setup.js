'use strict';
// Behavioural tests for the gateway records deploy.sh keeps outside the
// Node-RED payload: the reported firmware version (UCI
// osi-server.cloud.firmware_version) and the osi-bootstrap service that
// provisions ChirpStack at boot.
//
// deploy.sh mutates real system paths from its first line, so these tests do
// not run it whole. They extract the real shell functions and fragments
// (between their own begin/end markers) and run them under a POSIX shell with
// `uci`, `logread`, `sleep` and the init script stubbed. Run with a BusyBox `sh` first
// on PATH to check the fragments under ash.
const test = require('node:test');
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

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

test('deploy.sh reads the version before any gateway state changes', () => {
  const readAt = DEPLOY.indexOf('DEPLOY_FIRMWARE_VERSION="$(read_release_firmware_version)"');
  const firstInstall = DEPLOY.indexOf('fetch_required "Node-RED settings.js"');
  assert.ok(readAt > 0, 'deploy.sh must read the release version into DEPLOY_FIRMWARE_VERSION');
  assert.ok(readAt < firstInstall, 'the version must be read before the first file is installed');
});

// ---------------------------------------------------------------------------
// record_firmware_version: tolerant writer
// ---------------------------------------------------------------------------

function runRecord(fixture, version, extraEnv = {}) {
  const script = `set -eu
${extractFunction('record_firmware_version')}
record_firmware_version ${JSON.stringify(version)}
echo "RC=$?"
`;
  return runShell(script, {
    PATH: childPath(fixture.binDir),
    UCI_LOG: fixture.log,
    UCI_STATE: fixture.state,
    ...extraEnv,
  });
}

test('record_firmware_version sets and commits the key', () => {
  const fx = uciFixture({ version: '0.6.5' });
  try {
    writeUciStub(fx.binDir);
    const r = runRecord(fx, '0.8.0');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RC=0/);
    assert.equal(readState(fx), '0.8.0');
    const calls = uciCalls(fx);
    assert.ok(calls.includes('set osi-server.cloud.firmware_version=0.8.0'), calls.join('\n'));
    assert.ok(calls.includes('commit osi-server'), calls.join('\n'));
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('record_firmware_version leaves an equal value alone', () => {
  const fx = uciFixture({ version: '0.8.0' });
  try {
    writeUciStub(fx.binDir);
    const r = runRecord(fx, '0.8.0');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!uciCalls(fx).some((c) => c.startsWith('set ') || c.startsWith('commit')), uciCalls(fx).join('\n'));
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('record_firmware_version without a uci binary logs and returns 0', () => {
  const fx = uciFixture({ version: '0.6.5' });
  try {
    // no stub written: uci is absent from PATH
    const r = runRecord(fx, '0.8.0');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RC=0/);
    assert.match(r.stderr, /uci not found/);
    assert.equal(readState(fx), '0.6.5');
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('record_firmware_version with no osi-server.cloud section logs and returns 0', () => {
  const fx = uciFixture({ section: false });
  try {
    writeUciStub(fx.binDir);
    const r = runRecord(fx, '0.8.0');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RC=0/);
    assert.match(r.stderr, /osi-server\.cloud is missing/);
    assert.ok(!uciCalls(fx).some((c) => c.startsWith('set ')), uciCalls(fx).join('\n'));
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('record_firmware_version survives a failing set or commit and an unknown version', () => {
  for (const env of [{ UCI_FAIL_SET: '1' }, { UCI_FAIL_COMMIT: '1' }]) {
    const fx = uciFixture({ version: '0.6.5' });
    try {
      writeUciStub(fx.binDir);
      const r = runRecord(fx, '0.8.0', env);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /RC=0/);
      assert.match(r.stderr, /could not write osi-server\.cloud\.firmware_version/);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  }
  const fx = uciFixture({ version: '0.6.5' });
  try {
    writeUciStub(fx.binDir);
    const r = runRecord(fx, '');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /release version unknown/);
    assert.deepEqual(uciCalls(fx), []);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Placement: only after a passing self-check, never on rollback
// ---------------------------------------------------------------------------

// Runs deploy.sh's real self-check, commit-or-rollback and version-record
// region with the payload and service helpers stubbed. `logLine` is what
// logread shows after the restart: the completion marker (healthy) or the
// abort line (unhealthy, rolls back).
function runSelfCheckRegion({ logLine, prevStamp }) {
  const fx = uciFixture({ version: '0.6.5' });
  writeUciStub(fx.binDir);
  writeExecutable(path.join(fx.binDir, 'sleep'), ['#!/bin/sh', 'exit 0']);
  writeExecutable(path.join(fx.binDir, 'logread'), ['#!/bin/sh', `echo ${JSON.stringify(`gw node-red[1]: ${logLine}`)}`]);
  const script = `set -eu
${extractFunction('record_firmware_version')}
swap_call() { echo "swap_call $*" >> "$UCI_LOG.swap"; return 0; }
wait_for_node_red_health() { probe_elapsed=1; return 0; }
hold_node_red_stopped() { return 0; }
verify_payload_db_compatibility() { return 0; }
cleanup_failed_first_payload() { return 0; }
NODE_RED_INIT=:
NODE_RED_LOG_MARK=0
GUI_ROOT=/nonexistent-gui
PAYLOAD_KEEP_N=5
DEPLOY_STAMP=new-stamp
PREV_STAMP=${JSON.stringify(prevStamp || '')}
MIGRATION_RUNNER_AVAILABLE=1
DEPLOY_FIRMWARE_VERSION=0.8.0
${extractBetween('# init log check begin', '# firmware version record end')}
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

test('a passing self-check commits the payload and then records the new version', () => {
  const { result, fx } = runSelfCheckRegion({ logLine: 'sync-init: schema init complete', prevStamp: 'old-stamp' });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /REACHED_END/);
    assert.equal(readState(fx), '0.8.0');
    assert.ok(result.stdout.indexOf('OK: committing payload') < result.stdout.indexOf('firmware_version'),
      'the version is written after the payload is committed');
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('a rolled-back deploy leaves the old version', () => {
  const { result, fx } = runSelfCheckRegion({ logLine: 'devices rebuild ABORTED (devices left intact): boom', prevStamp: 'old-stamp' });
  try {
    assert.notEqual(result.status, 0, 'a rollback must still fail the deploy');
    assert.match(result.stderr, /ROLLED BACK/);
    assert.equal(readState(fx), '0.6.5');
    assert.ok(!uciCalls(fx).some((c) => c.startsWith('set ')), uciCalls(fx).join('\n'));
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('a failed first deploy (nothing to roll back to) leaves the old version', () => {
  const { result, fx } = runSelfCheckRegion({ logLine: 'devices rebuild ABORTED (devices left intact): boom', prevStamp: '' });
  try {
    assert.notEqual(result.status, 0);
    assert.equal(readState(fx), '0.6.5');
    assert.ok(!uciCalls(fx).some((c) => c.startsWith('set ')), uciCalls(fx).join('\n'));
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
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
