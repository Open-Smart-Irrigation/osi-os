'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const init = fs.readFileSync(
  'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init', 'utf8');
const brokerId = init.match(/local cloud_broker_node_id="([^"]+)"/)[1];
const eui = '0016C001F1000001';
const seed = JSON.stringify([{ id: brokerId, type: 'mqtt-broker', clientid: '' }]) + '\n';

function fixture(t, { linked = false, password = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-red-init-flows-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data'));
  const userDir = path.join(root, 'srv', 'node-red');
  const flows = path.join(userDir, 'flows.json');
  const creds = path.join(userDir, 'flows_cred.json');
  const bundled = path.join(root, 'bundled-flows.json');
  const active = path.join(userDir, 'payloads', 'active');
  const payload = path.join(userDir, 'payloads', 'fixture');
  const target = linked ? path.join(payload, 'flows.json') : flows;
  fs.mkdirSync(linked ? payload : userDir, { recursive: true });
  fs.writeFileSync(bundled, seed);
  if (linked) {
    fs.symlinkSync('fixture', active);
    fs.symlinkSync('payloads/active/flows.json', flows);
  }
  const initPath = path.join(root, 'node-red.init');
  fs.writeFileSync(initPath, init
    .replaceAll('/srv/', root + '/srv/')
    .replaceAll('/data/', root + '/data/')
    .replaceAll('/usr/libexec/', root + '/usr/libexec/')
    .replaceAll('/dev/console', path.join(root, 'console'))
    .replaceAll('/usr/share/flows.json', bundled));
  function start() {
    const result = spawnSync('sh', ['-c', `
. "$1"
uci() {
    if [ "$*" = "-q get osi-server.cloud.mqtt_password" ] && [ -n "$TEST_PASSWORD" ]; then
        printf '%s\\n' "$TEST_PASSWORD"
    else
        return 1
    fi
}
logger() { printf 'logger %s\\n' "$*" >&2; }
gateway_identity_heal() { return 0; }
normalize_gateway_eui() { printf '%s' "$1"; }
procd_open_instance() { printf 'procd start\\n'; }
procd_close_instance() { :; }
procd_set_param() { printf '%s\\n' "$@"; }
start_service
`, 'fixture', initPath], {
      encoding: 'utf8',
      env: { ...process.env, GATEWAY_IDENTITY_DEVICE_EUI: eui, TEST_PASSWORD: password },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout + result.stderr;
  }
  return { flows, creds, active, target, start };
}

function quarantine(file) {
  const dir = path.dirname(file);
  const prefix = path.basename(file) + '.corrupt-';
  return fs.readdirSync(dir).filter(name => name.startsWith(prefix)).map(name => path.join(dir, name));
}

function assertPatched(fx) {
  assert.equal(JSON.parse(fs.readFileSync(fx.flows, 'utf8'))[0].clientid, 'device_' + eui);
}

for (const [state, bad] of [
  ['zeroed', Buffer.alloc(Buffer.byteLength(seed))],
  ['empty', Buffer.alloc(0)],
  ['invalid JSON', Buffer.from('[{')],
  ['missing', null],
]) {
  test(`start restores ${state} flows and applies the gateway client ID`, t => {
    const fx = fixture(t);
    if (bad) fs.writeFileSync(fx.flows, bad, { mode: 0o640 });
    const report = fx.start();
    assertPatched(fx);
    const copies = quarantine(fx.flows);
    assert.equal(copies.length, bad ? 1 : 0);
    if (bad) {
      assert.deepEqual(fs.readFileSync(copies[0]), bad);
      assert.equal(fs.statSync(fx.flows).mode & 0o777, 0o640);
    }
    assert.match(report, /logger .*restored flows.json/);
    assert.match(report, /OSI_NODE_RED_STARTUP_WARNING=[^]*restored flows.json/);
    assert.match(report, /procd start/);
  });
}

test('rewriting, restoring and recreating the real file preserve both payload links', t => {
  const fx = fixture(t, { linked: true });
  fs.writeFileSync(fx.target, seed, { mode: 0o640 });
  const before = fs.statSync(fx.target);
  fx.start();
  assertPatched(fx);
  const after = fs.statSync(fx.target);
  assert.notEqual(after.ino, before.ino, 'rewrites must use rename');
  assert.equal(after.mode, before.mode);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  fs.writeFileSync(fx.target, Buffer.alloc(32));
  fx.start();
  assertPatched(fx);
  assert.equal(quarantine(fx.target).length, 1);
  fs.unlinkSync(fx.target);
  fx.start();
  assertPatched(fx);
  assert.equal(fs.readlinkSync(fx.flows), 'payloads/active/flows.json');
  assert.equal(fs.readlinkSync(fx.active), 'fixture');
});

test('a missing public link and target are rebuilt through the active payload', t => {
  const fx = fixture(t, { linked: true });
  fs.unlinkSync(fx.flows);
  fx.start();
  assertPatched(fx);
  assert.equal(fs.realpathSync(fx.flows), fx.target);
  assert.equal(fs.readlinkSync(fx.active), 'fixture');
});

for (const password of ['', 'fixture-password']) {
  test(`corrupt credentials are quarantined (${password ? 'configured broker' : 'no configured broker'})`, t => {
    const fx = fixture(t, { password });
    fs.writeFileSync(fx.flows, seed);
    const bad = '{truncated fixture';
    fs.writeFileSync(fx.creds, bad, { mode: 0o600 });
    const report = fx.start();
    const copies = quarantine(fx.creds);
    assert.equal(copies.length, 1);
    assert.equal(fs.readFileSync(copies[0], 'utf8'), bad);
    assert.equal(fs.statSync(copies[0]).mode & 0o777, 0o600);
    assert.match(report, /logger .*quarantined flows_cred.json/);
    assert.match(report, /OSI_NODE_RED_STARTUP_WARNING=.*quarantined flows_cred.json/);
    assert.doesNotMatch(report, /truncated fixture/);
    if (password) {
      assert.deepEqual(JSON.parse(fs.readFileSync(fx.creds, 'utf8')), {
        [brokerId]: { user: eui, password },
      });
      assert.equal(fs.statSync(fx.creds).mode & 0o777, 0o600);
    } else {
      assert.equal(fs.existsSync(fx.creds), false);
    }
    assertPatched(fx);
  });
}

test('a restart with unchanged flows and credentials writes neither file', t => {
  const fx = fixture(t, { password: 'fixture-password' });
  fs.writeFileSync(fx.flows, seed);
  fx.start();
  const snapshot = file => {
    const info = fs.statSync(file, { bigint: true });
    return [info.ino, info.mtimeNs, info.ctimeNs, fs.readFileSync(file)];
  };
  const before = [snapshot(fx.flows), snapshot(fx.creds)];
  fx.start();
  assert.deepEqual([snapshot(fx.flows), snapshot(fx.creds)], before);
});
