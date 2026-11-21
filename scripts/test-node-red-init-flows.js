'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
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
const nodes = [
  { id: brokerId, type: 'mqtt-broker', clientid: '' },
  { id: 'fixture-tab', type: 'tab' },
  { id: 'fixture-route', type: 'http in', z: 'fixture-tab', url: '/api/fixture', method: 'get' },
];
const seed = JSON.stringify(nodes) + '\n';
const swap = require('./deploy-payload-swap');
const imageSeedScript = fs.readFileSync(profile + '/etc/uci-defaults/98_osi_node_red_seed', 'utf8');

function sqlite(db, query) {
  return execFileSync('sqlite3', ['-batch', '-bail', db, query], { encoding: 'utf8' }).trim();
}

function addLedger(db) {
  sqlite(db, "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT, status TEXT);" +
    "INSERT INTO schema_migrations VALUES (72,'fixture','applied');");
}


function fixture(t, { linked = false, password = '', pristine = seed } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-red-init-flows-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data', 'db'), { recursive: true });
  const db = path.join(root, 'data', 'db', 'farming.db');
  const imageDb = path.join(root, 'image-seed.db');
  if (!linked) {
    addLedger(imageDb);
    fs.copyFileSync(imageDb, db);
  }
  const userDir = path.join(root, 'srv', 'node-red');
  const flows = path.join(userDir, 'flows.json');
  const creds = path.join(userDir, 'flows_cred.json');
  const bundled = path.join(root, 'bundled-flows.json');
  const active = path.join(userDir, 'payloads', 'active');
  const payload = path.join(userDir, 'payloads', 'fixture');
  const target = linked ? path.join(payload, 'flows.json') : flows;
  fs.mkdirSync(linked ? payload : userDir, { recursive: true });
  fs.writeFileSync(bundled, seed);
  const origin = path.join(userDir, '.image-flows-origin');
  if (!linked) fs.writeFileSync(origin, createHash('sha256').update(seed).digest('hex') + '\n');
  if (linked) {
    fs.symlinkSync('fixture', active);
    fs.symlinkSync('payloads/active/flows.json', flows);
    fs.copyFileSync(require.resolve('./deploy-payload-swap'), path.join(userDir, '.payload-swap.js'));
    if (pristine !== null) {
      fs.writeFileSync(target, pristine);
      swap.sealPristineFlows(userDir, 'fixture', target);
      swap.writeCompatibility(userDir, 'fixture', '73', '73:fixture');
    }
  }
  const initPath = path.join(root, 'node-red.init');
  fs.writeFileSync(initPath, init
    .replaceAll('/srv/', root + '/srv/')
    .replaceAll('/data/', root + '/data/')
    .replaceAll('/usr/libexec/', root + '/usr/libexec/')
    .replaceAll('/usr/lib/node-red/gui', path.join(root, 'gui'))
    .replaceAll('/dev/console', path.join(root, 'console'))
    .replaceAll('/usr/share/flows.json', bundled)
    .replaceAll('/usr/share/db/farming.db', imageDb));
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
  function start({ boot = false, failSync = '', expectFailure = false, blockBootstrap = '' } = {}) {
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
    node() {
        if [ "$1" = "$TEST_BLOCK_BOOTSTRAP" ]; then
            printf 'selected the retained legacy bootstrap\\n'
            return 0
        fi
        command node "$@"
    }
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
        TEST_BLOCK_BOOTSTRAP: blockBootstrap,
        ...(failSync ? { NODE_OPTIONS: '--require=' + preload, FS_TRACE: trace, FAIL_SYNC: failSync } : {}),
      },
    });
    assert.ifError(result.error);
    if (failSync || expectFailure) return result;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout + result.stderr;
  }
  return { root, userDir, initPath, flows, creds, active, target, start, trace, origin, db, imageDb, bundled, stamp: path.join(root, 'etc', 'osi-bootstrap.done') };
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
  ['null node', Buffer.from('[null]')],
  ['empty node', Buffer.from('[{}]')],
  ['no tab', Buffer.from(JSON.stringify([nodes[2]]))],
  ['no HTTP route', Buffer.from(JSON.stringify([nodes[1]]))],
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
  fs.writeFileSync(fx.flows, '[null]');
  const log = fx.start({ boot: true });
  assert.match(log, /flows.json portable communication contract verified/);
  assert.match(log, /bootstrap completed successfully/);
  assert.doesNotMatch(log, /bootstrap failed/);
  assert.equal(fs.existsSync(fx.stamp), true);
});

for (const receipt of ['absent', 'mismatched', 'verified']) {
  test(`bootstrap boot selects the correct writer when the deploy receipt is ${receipt}`, t => {
    const fx = fixture(t);
    fs.writeFileSync(fx.flows, seed);
    const updated = path.join(fx.userDir, 'chirpstack-bootstrap.js');
    const installed = 'console.log("selected the atomically installed bootstrap");\n';
    const retained = process.env.OSI_TEST_V081_BOOTSTRAP
      ? fs.readFileSync(process.env.OSI_TEST_V081_BOOTSTRAP)
      : 'console.log("selected the retained legacy bootstrap");\n';
    if (receipt !== 'absent') {
      const deploy = fs.readFileSync('deploy.sh', 'utf8');
      const scriptInstall = deploy.indexOf('fetch_required "chirpstack-bootstrap.js"');
      const receiptInstall = deploy.indexOf('if ! publish_bootstrap_receipt "$BOOTSTRAP_SCRIPT_FALLBACK"');
      const serviceInstall = deploy.indexOf('fetch_required "ChirpStack bootstrap service"');
      assert.ok(scriptInstall > 0 && scriptInstall < receiptInstall && receiptInstall < serviceInstall);
      const installer = deploy.slice(deploy.indexOf('file_sha256() {'), deploy.indexOf('# The hotplug hook'));
      fs.writeFileSync(updated, installed);
      const result = spawnSync('sh', ['-c', installer + '\npublish_bootstrap_receipt "$1"', 'receipt', updated],
        { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const file = updated + '.atomic-sha256';
      assert.equal(fs.readFileSync(file, 'utf8'), createHash('sha256').update(installed).digest('hex'));
    }
    if (receipt !== 'verified') fs.writeFileSync(updated, retained);
    assert.equal(fs.existsSync(fx.stamp), false);
    const log = fx.start({ boot: true, blockBootstrap: receipt === 'verified' ? '' : updated });
    assert.match(log, /bootstrap completed successfully/);
    if (receipt === 'verified') {
      assert.match(log, /selected the atomically installed bootstrap/);
      assert.doesNotMatch(log, /flows.json portable communication contract verified/);
    } else {
      assert.match(log, /flows.json portable communication contract verified/);
      assert.doesNotMatch(log, /selected the retained legacy bootstrap/);
    }
  });
}

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

test('a v0.8.1 image never supplies boot DDL to the deployed v73 schema', t => {
  const current = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
  const restored = current.find(node => node.id === 'sync-init-fn').func;
  const newer = JSON.stringify([...nodes, { id: 'sync-init-fn', type: 'function', func: restored }]);
  const fx = fixture(t, { linked: true, pristine: newer });
  const image = path.join(fx.root, 'bundled-flows.json');
  if (process.env.OSI_TEST_V081_FLOW) fs.copyFileSync(process.env.OSI_TEST_V081_FLOW, image);
  else fs.writeFileSync(image, JSON.stringify([...nodes, { id: 'sync-init-fn', type: 'function', func: 'legacy trigger body' }]));
  assert.notEqual(JSON.parse(fs.readFileSync(image)).find(node => node.id === 'sync-init-fn').func, restored);
  fs.writeFileSync(fx.target, '[{}]');
  const log = fx.start();
  assert.match(log, /restored flows.json .*flows.pristine.json/);
  assert.equal(JSON.parse(fs.readFileSync(fx.target)).find(node => node.id === 'sync-init-fn').func, restored);
  assertPatched(fx);
});

for (const condition of ['missing', 'bad digest', 'invalid structure']) {
  test(`a deployed payload holds when its pristine source has ${condition}`, t => {
    const fx = fixture(t, { linked: true, pristine: condition === 'missing' ? null : seed });
    const file = path.join(path.dirname(fx.target), 'flows.pristine.json');
    if (condition !== 'missing') {
      fs.chmodSync(file, 0o644);
      fs.writeFileSync(file, '[null]');
    }
    if (condition === 'invalid structure') {
      const digest = require('crypto').createHash('sha256').update('[null]').digest('hex');
      fs.writeFileSync(path.join(path.dirname(file), 'flows-seed.json'), JSON.stringify({ stamp: 'fixture', digest }));
      const metadata = path.join(path.dirname(file), 'compatibility.json');
      const record = JSON.parse(fs.readFileSync(metadata, 'utf8'));
      fs.writeFileSync(metadata, JSON.stringify({ ...record, flows_pristine_sha256: digest }));
    }
    fs.writeFileSync(fx.target, '[{}]');
    const first = fx.start({ expectFailure: true });
    assert.equal(first.status, 1);
    assert.doesNotMatch(first.stdout, /procd start/);
    assert.match(first.stderr, /HELD: Node-RED stopped/);
    assert.equal(swap.readPayloadState(fx.userDir).state, 'held');
    assert.match(fs.readFileSync(path.join(fx.userDir, 'DEPLOY-HELD'), 'utf8'), /You must re-run the deploy .* before Node-RED can start/);
    assert.equal(fs.readFileSync(quarantine(fx.target)[0], 'utf8'), '[{}]');
    assert.doesNotMatch(fx.start(), /procd start/);
  });
}

test('a missing pristine copy warns on a healthy payload and holds when recovery becomes necessary', t => {
  const fx = fixture(t, { linked: true });
  assert.match(fx.start(), /procd start/);
  const before = fs.readFileSync(fx.target);
  swap.writePayloadState(fx.userDir, 'fixture', 'healthy', 'passed health checks');
  fs.unlinkSync(path.join(path.dirname(fx.target), 'flows.pristine.json'));
  const log = fx.start();
  assert.match(log, /procd start/);
  assert.match(log, /logger .*WARN: Pristine flow recovery unavailable.*pristine flows .*missing/);
  const warning = swap.readPayloadState(fx.userDir);
  assert.equal(warning.state, 'healthy');
  assert.match(warning.flow_recovery_warning, /pristine flows .*missing/);
  assert.equal(fs.existsSync(path.join(fx.userDir, 'DEPLOY-HELD')), false);
  assert.deepEqual(fs.readFileSync(fx.target), before);

  fs.writeFileSync(fx.target, Buffer.alloc(before.length));
  const result = fx.start({ expectFailure: true });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /procd start/);
  assert.match(result.stderr, /logger .*HELD:.*pristine flows .*missing.*You must re-run the deploy/);
  assert.equal(swap.readPayloadState(fx.userDir).reason,
    fs.readFileSync(path.join(fx.userDir, 'DEPLOY-HELD'), 'utf8').trim());
  assert.doesNotMatch(fx.start(), /procd start/);
});

test('regular public paths cannot restore image DDL over a newer deployed schema', t => {
  const fx = fixture(t);
  if (process.env.OSI_TEST_V081_FLOW) fs.copyFileSync(process.env.OSI_TEST_V081_FLOW, fx.bundled);
  else fs.writeFileSync(fx.bundled, JSON.stringify([...nodes, { id: 'sync-init-fn', type: 'function', func: 'legacy trigger body' }]));
  fs.writeFileSync(fx.origin, createHash('sha256').update(fs.readFileSync(fx.bundled)).digest('hex') + '\n');
  fs.writeFileSync(fx.flows, Buffer.alloc(128));
  fs.mkdirSync(path.join(fx.userDir, 'payloads', 'newer'), { recursive: true });
  fs.mkdirSync(path.join(fx.root, 'gui'));
  fs.symlinkSync('payloads/newer/modules/osi-zone-env', path.join(fx.userDir, 'osi-zone-env'));
  swap.writePayloadState(fx.userDir, 'newer', 'healthy', 'passed health checks');

  const migration = fs.readFileSync('database/migrations/ordered/0073__zone_env_rain_quality_sync.sql', 'utf8');
  sqlite(fx.db, 'CREATE TABLE zone_daily_environment (sync_version INTEGER); ' + migration +
    "INSERT INTO schema_migrations VALUES (73,'newer','applied');");
  const query = "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name LIKE 'trg_dp_zone_env_outbox_%' ORDER BY name";
  const before = sqlite(fx.db, query);
  assert.match(before, /rain/);
  const result = fx.start({ expectFailure: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /image flows ownership is contradicted/);
  assert.doesNotMatch(result.stdout, /procd start/);
  assert.equal(swap.readPayloadState(fx.userDir).state, 'held');
  assert.deepEqual(fs.readFileSync(fx.flows), Buffer.alloc(128));
  assert.equal(sqlite(fx.db, query), before);
});

for (const [condition, prepare, expected] of [
  ['missing provenance', fx => fs.unlinkSync(fx.origin), /factory seed record/],
  ['newer ledger', fx => sqlite(fx.db, "INSERT INTO schema_migrations VALUES (73,'newer','applied');"), /newer than or differs/],
  ['missing live ledger', fx => fs.unlinkSync(fx.db), /schema ledger database is missing/],
]) {
  test(`image fallback holds when ${condition}`, t => {
    const fx = fixture(t);
    fs.writeFileSync(fx.flows, '[null]');
    prepare(fx);
    const result = fx.start({ expectFailure: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stdout, /procd start/);
    assert.equal(swap.readPayloadState(fx.userDir).state, 'held');
  });
}

for (const pristineDb of [true, false]) {
  test(`first-boot seed ${pristineDb ? 'records factory ownership' : 'refuses to mark an upgraded DB as factory'}`, t => {
    const fx = fixture(t);
    fs.unlinkSync(fx.origin);
    if (!pristineDb) sqlite(fx.db, "INSERT INTO schema_migrations VALUES (73,'newer','applied');");
    const earlySeed = imageSeedScript.slice(0, imageSeedScript.indexOf('\nNODE\n') + 6)
      .replaceAll('/srv/node-red', fx.userDir)
      .replaceAll('/usr/share/flows.json', fx.bundled)
      .replaceAll('/usr/share/db/farming.db', fx.imageDb)
      .replaceAll('/data/db/farming.db', fx.db)
      .replaceAll('/usr/share/node-red', path.join(fx.root, 'rom'))
      .replaceAll('/usr/lib/node-red/gui', path.join(fx.root, 'gui'));
    const result = spawnSync('sh', ['-c', earlySeed], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(fx.origin), pristineDb);
    assert.equal(fs.existsSync(fx.flows), pristineDb);
    if (pristineDb) {
      fs.writeFileSync(fx.flows, '[null]');
      assert.match(fx.start(), /restored flows.json .*bundled-flows.json/);
    }
  });
}

test('a legacy payload with healthy live flows can boot until its first sealed deploy', t => {
  const fx = fixture(t, { linked: true, pristine: null });
  fs.writeFileSync(fx.target, seed);
  assert.match(fx.start(), /procd start/);
  assertPatched(fx);
});

test('a same-release deploy can stage past a missing held flow and switch only to verified bytes', t => {
  const fx = fixture(t, { linked: true, pristine: null });
  const gui = path.join(fx.root, 'gui');
  const activeGui = path.join(path.dirname(fx.target), 'gui');
  fs.mkdirSync(activeGui);
  fs.writeFileSync(path.join(activeGui, 'index.html'), '<p>fixture</p>');
  fs.symlinkSync(path.join(fx.active, 'gui'), gui);
  assert.equal(fx.start({ expectFailure: true }).status, 1);
  const image = path.join(fx.root, 'bundled-flows.json');
  swap.stagePayload(fx.userDir, 'replacement', image, activeGui, 'staged');
  swap.sealPristineFlows(fx.userDir, 'replacement', image);
  swap.writeCompatibility(fx.userDir, 'replacement', '73', '73:fixture');
  assert.doesNotThrow(() => swap.switchPreflight(fx.userDir, 'replacement', gui, 'fixture'));
  swap.markActivated(fx.userDir, 'replacement');
  swap.flipTo(fx.userDir, 'replacement', gui, 'fixture');
  swap.writePayloadState(fx.userDir, 'replacement', 'unverified', 'health check pending', 'deploy.sh');
  assert.match(fx.start(), /procd start/);
  assert.equal(swap.currentStamp(fx.userDir), 'replacement');
});

test('a missing DB with a recovery hold refuses a cold start before payload checking', t => {
  const fx = fixture(t);
  fs.unlinkSync(fx.db);
  fs.writeFileSync(fx.db + '.osi-recovery', '');
  const result = fx.start({ expectFailure: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HELD: Database recovery is incomplete/);
  assert.doesNotMatch(result.stdout, /procd start/);
  assert.equal(fs.existsSync(fx.db), false);
});

test('a failed credentials directory sync restores the prior inode and removes rollback names', t => {
  const fx = fixture(t, { password: 'replacement-password' });
  fs.writeFileSync(fx.flows, seed);
  const prior = JSON.stringify({ [brokerId]: { user: eui, password: 'old-password' } });
  fs.writeFileSync(fx.creds, prior, { mode: 0o600 });
  const stat = fs.statSync(fx.creds);
  const result = fx.start({ failSync: 'directory' });
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(fx.creds, 'utf8'), prior);
  assert.equal(fs.statSync(fx.creds).ino, stat.ino);
  assert.equal(fs.statSync(fx.creds).mode, stat.mode);
  assert.equal(fs.readdirSync(fx.userDir).some(name => name.endsWith('.previous')), false);
});

test('boot removes orphan rollback links only when a valid live file exists', t => {
  const fx = fixture(t);
  fs.writeFileSync(fx.flows, seed);
  const remnant = '.tmp-3b5d89e9-6714-48b7-857c-85e4734c2482.previous';
  const settings = path.join(fx.userDir, 'settings.js');
  fs.writeFileSync(settings, 'module.exports = {};');
  fs.linkSync(settings, settings + remnant);
  fs.writeFileSync(fx.creds + remnant, '{}', { mode: 0o600 });
  fx.start();
  assert.equal(fs.existsSync(settings + remnant), false);
  assert.equal(fs.existsSync(fx.creds + remnant), true);
  fs.writeFileSync(fx.creds, '{}', { mode: 0o600 });
  fx.start();
  assert.equal(fs.existsSync(fx.creds + remnant), false);
});

for (const [label, filename] of [['settings', 'settings.js'], ['init', 'node-red.init']]) {
  test(`a kill during staged ${label} transfer leaves the cold boot of the retained payload intact`, t => {
    const fx = fixture(t, { linked: true });
    const deploy = fs.readFileSync('deploy.sh', 'utf8');
    const bootInstall = deploy.slice(deploy.indexOf('publish_boot_file() {'), deploy.indexOf('# The hotplug hook'));
    const live = filename === 'settings.js' ? path.join(fx.userDir, filename) : fx.initPath;
    if (filename === 'settings.js') fs.writeFileSync(live, 'module.exports = {};\n');
    const old = fs.readFileSync(live);
    const command = bootInstall + `
fetch() { printf 'partial transfer' > "$2"; kill -KILL "$$"; }
fetch_required 'test' 'source' "$1" 755
`;
    const result = spawnSync('sh', ['-c', command, 'fixture', live]);
    assert.equal(result.signal, 'SIGKILL');
    assert.deepEqual(fs.readFileSync(live), old);
    assert.match(fx.start(), /procd start/);
    assert.equal(fs.readlinkSync(fx.active), 'fixture');
  });
}

for (const errorAt of ['open', 'fsync']) {
  test(`a settings directory ${errorAt} failure keeps the old file and leaves no rollback link`, t => {
    const fx = fixture(t);
    const filename = path.join(fx.userDir, 'settings.js');
    const initial = "module.exports = {};\n";
    fs.writeFileSync(filename, initial, { mode: 0o640 });
    const before = fs.statSync(filename);
    const injected = Object.create(fs);
    const original = fs[errorAt === 'open' ? 'openSync' : 'fsyncSync'];
    let fired = false;
    injected[errorAt === 'open' ? 'openSync' : 'fsyncSync'] = (target, ...args) => {
      const dir = errorAt === 'open' ? target === fx.userDir : fs.fstatSync(target).isDirectory();
      if (dir && !fired) {
        fired = true;
        throw new Error('injected ' + errorAt);
      }
      return original(target, ...args);
    };
    const extract = name => bootstrapSource.match(new RegExp('^function ' + name + '[(].*?^}$', 'ms'))[0];
    const patch = new Function('fs', 'path', 'require', 'CFG', 'ENV_LOADER_MARKER',
      extract('writeAndSyncStage') + '\n' + extract('patchSettingsJs') + '\npatchSettingsJs();');
    assert.throws(() => patch(injected, path, require, { settingsJs: filename, envFile: '/fixture' }, '// marker'),
      new RegExp('injected ' + errorAt));
    assert.equal(fs.readFileSync(filename, 'utf8'), initial);
    assert.equal(fs.statSync(filename).ino, before.ino);
    assert.equal(fs.statSync(filename).mode, before.mode);
    assert.equal(fs.readdirSync(fx.userDir).some(name => name.startsWith('settings.js.tmp-')), false);
  });
}
