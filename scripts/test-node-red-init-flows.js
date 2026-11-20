'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const init = fs.readFileSync(
  'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init', 'utf8');
const profile = 'conf/full_raspberrypi_bcm27xx_bcm2712/files';
const bootstrapInit = fs.readFileSync(profile + '/etc/init.d/osi-bootstrap', 'utf8');
const bootstrapSource = fs.readFileSync('scripts/chirpstack-bootstrap.js', 'utf8');
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
  const bootInit = path.join(root, 'osi-bootstrap');
  const service = path.join(root, 'etc', 'init.d', 'osi-identityd');
  const request = path.join(root, 'usr', 'libexec', 'osi-identityd.sh');
  for (const stub of [service, request]) {
    fs.mkdirSync(path.dirname(stub), { recursive: true });
    fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  fs.writeFileSync(bootInit, bootstrapInit.replace(/\/(srv|etc|usr)\//g, match => root + match));
  const bootstrapRuntime = path.join(root, 'usr', 'share', 'node-red', 'chirpstack-bootstrap.js');
  fs.mkdirSync(path.dirname(bootstrapRuntime), { recursive: true });
  // Use the real flow consumer under local service/gRPC fixtures.
  const validator = bootstrapSource.match(/^function validatePortableFlows\(\) \{[^]*?^\}/m)[0];
  fs.writeFileSync(bootstrapRuntime, [
    "const fs = require('fs');",
    'const CFG = { flowsJson: ' + JSON.stringify(flows) + ' };',
    validator, 'validatePortableFlows();',
  ].join('\n'));

  const trace = path.join(root, 'fs-trace');
  const preload = path.join(root, 'fs-trace.cjs');
  fs.writeFileSync(preload, `
const fs = require('fs');
const sync = fs.fsyncSync;
const rename = fs.renameSync;
const trace = process.env.FS_TRACE;
let failed = false;
fs.fsyncSync = function(fd) {
  const kind = fs.fstatSync(fd).isDirectory() ? 'directory' : 'file';
  fs.appendFileSync(trace, kind + '\\n');
  if (kind === process.env.FAIL_SYNC && !failed) {
    failed = true;
    throw new Error('injected ' + kind + ' fsync failure');
  }
  return sync(fd);
};
fs.renameSync = function(source, target) {
  fs.appendFileSync(trace, 'rename\\n');
  return rename(source, target);
};
`);
  function start({ boot = false, failSync = '' } = {}) {
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
start_service || exit $?
if [ "$TEST_BOOT" = 1 ]; then
    . "$TEST_BOOT_INIT"
    curl() { return 0; }
    sync() { return 0; }
    boot
fi
`, 'fixture', initPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GATEWAY_IDENTITY_DEVICE_EUI: eui,
        TEST_PASSWORD: password,
        TEST_BOOT: boot ? '1' : '0',
        TEST_BOOT_INIT: bootInit,
        ...(failSync ? { NODE_OPTIONS: '--require=' + preload, FS_TRACE: trace, FAIL_SYNC: failSync } : {}),
      },
    });
    assert.ifError(result.error);
    if (failSync) return result;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout + result.stderr;
  }
  return { flows, creds, active, target, start, trace, stamp: path.join(root, 'etc', 'osi-bootstrap.done') };
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

test('boot recovery reaches the real bootstrap flow validator on the same boot', t => {
  const nodePriority = init.match(/^START=(\d+)/m)[1];
  const bootstrapPriority = bootstrapInit.match(/^START=(\d+)/m)[1];
  assert.ok('S' + nodePriority + 'node-red' < 'S' + bootstrapPriority + 'osi-bootstrap');
  const fx = fixture(t);
  fs.writeFileSync(fx.flows, Buffer.alloc(Buffer.byteLength(seed)));
  const log = fx.start({ boot: true });
  assert.match(log, /flows.json portable communication contract verified/);
  assert.match(log, /bootstrap completed successfully/);
  assert.doesNotMatch(log, /bootstrap failed/);
  assert.equal(fs.existsSync(fx.stamp), true);
});

for (const [failure, expected] of [
  ['file', ['file']],
  ['directory', ['file', 'rename', 'directory', 'rename', 'directory']],
]) {
  test(`a ${failure} fsync failure retains the previous flow file and is logged`, t => {
    const fx = fixture(t, { linked: true });
    fs.writeFileSync(fx.target, seed);
    const previous = fs.statSync(fx.target);
    const result = fx.start({ failSync: failure });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp('injected ' + failure + ' fsync failure'));
    assert.match(result.stderr, /logger .*Node-RED startup refused/);
    assert.doesNotMatch(result.stdout, /procd start/);
    assert.equal(fs.readFileSync(fx.target, 'utf8'), seed);
    assert.equal(fs.statSync(fx.target).ino, previous.ino);
    assert.equal(fs.realpathSync(fx.flows), fx.target);
    assert.deepEqual(fs.readFileSync(fx.trace, 'utf8').trim().split('\n'), expected);
  });
}
