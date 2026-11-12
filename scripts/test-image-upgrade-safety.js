'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const repo = path.resolve(__dirname, '..');
const profile = path.join(repo, 'conf/full_raspberrypi_bcm27xx_bcm2712/files');
const helper = path.join(profile, 'usr/libexec/osi-image-safety.js');
const missingImageNode = '/__osi_fixture_missing_node__/node';
function portableInterpreter(text) {
  // Optional masking proves no copied script can accidentally use this host's
  // /usr/bin/node. Change only the interpreter token, never product behavior.
  const imageNode = process.env.OSI_TEST_IMAGE_NODE || '/usr/bin/node';
  return text.replaceAll('/usr/bin/node', imageNode)
    .replaceAll(imageNode, process.execPath).replaceAll(missingImageNode, process.execPath);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-image-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(root, name, value, mode = 0o644) {
  const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, value, { mode }); return p;
}
function db(root, accounts = 1, head = 70) {
  const dest = path.join(root, 'data/db/farming.db'); fs.mkdirSync(path.dirname(dest), { recursive: true });
  const sql = `CREATE TABLE users(id INTEGER); CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES(${head}); ${accounts ? 'INSERT INTO users VALUES(1);' : ''}`;
  const result = spawnSync('sqlite3', [dest, sql]); assert.equal(result.status, 0, String(result.stderr)); return dest;
}
function rewrite(text, root) {
  return portableInterpreter(text).replaceAll("const LIVE_ROOT = '/';", `const LIVE_ROOT = ${JSON.stringify(root)};`)
    .replace(/\/(?:usr\/libexec|usr\/share|etc\/osi-|srv\/node-red|data\/db)[^\s'";)]*/g, match => root + match);
}
function installFixtureHelper(root) {
  put(root, 'usr/libexec/osi-image-safety.js', portableInterpreter(fs.readFileSync(helper, 'utf8')).replace("const LIVE_ROOT = '/';", `const LIVE_ROOT = ${JSON.stringify(root)};`));
  put(root, 'etc/osi-image-initialization.required', '1\n');
}
function shellSeed(root, name) {
  const file = put(root, `test-${name}`, rewrite(fs.readFileSync(path.join(profile, 'etc/uci-defaults', name), 'utf8'), root));
  return spawnSync('/bin/sh', [file], { encoding: 'utf8' });
}
function safety(root) { return require(root ? path.join(root, 'usr/libexec/osi-image-safety.js') : helper); }

test('copied scripts substitute the test interpreter even when the image path is unavailable', t => {
  const root = fixture(t); installFixtureHelper(root);
  put(root, 'srv/chirpstack/chirpstack.sqlite', 'made-up-radio-state');
  put(root, 'usr/share/db/farming.db', 'must not seed');
  const source = fs.readFileSync(path.join(profile, 'etc/uci-defaults/97_osi_db_seed'), 'utf8')
    .replaceAll('/usr/bin/node', missingImageNode);
  const unavailable = put(root, 'missing-interpreter-control', source);
  const control = spawnSync('/bin/sh', [unavailable], { encoding: 'utf8' });
  assert.equal(control.status, 127, 'negative control must prove the image interpreter is unavailable');
  const copied = put(root, 'portable-seed', rewrite(source, root));
  const result = spawnSync('/bin/sh', [copied], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(safety().readStatus(root).phase, 'held');
  assert.equal(fs.existsSync(path.join(root, 'data/db/farming.db')), false);
  t.diagnostic('missing interpreter control exit 127; copied script using process.execPath exit 0');
});

test('an image with retained radio state never silently seeds an empty farm', t => {
  const root = fixture(t);
  put(root, 'srv/chirpstack/chirpstack.sqlite', 'made-up-radio-state');
  put(root, 'usr/share/db/farming.db', 'seed');
  if (fs.existsSync(helper)) installFixtureHelper(root);
  const result = shellSeed(root, '97_osi_db_seed');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(root, 'data/db/farming.db')), false, 'retained radio state must refuse a fresh seed');
  assert.equal(safety().readStatus(root).phase, 'held');
});

test('source guard distinguishes accounts, empty DB, radio state and unprovable DB', t => {
  const s = safety();
  const empty = fixture(t); assert.equal(s.provisionReason(empty), null);
  db(empty, 0); assert.equal(s.provisionReason(empty), null);
  const farm = fixture(t); db(farm); assert.match(s.provisionReason(farm), /account/);
  const radio = fixture(t); put(radio, 'srv/chirpstack/chirpstack.sqlite', 'radio'); assert.match(s.provisionReason(radio), /ChirpStack/);
  const invalid = fixture(t); put(invalid, 'data/db/farming.db', 'bad'); assert.match(s.provisionReason(invalid), /unproven/);
  const orphan = fixture(t); put(orphan, 'data/db/farming.db-wal', 'orphan'); assert.match(s.provisionReason(orphan), /sidecar/);
});

for (const head of [70, 79]) test(`first image boot holds a kept head-${head} DB without changing DB or old code`, t => {
  const root = fixture(t); installFixtureHelper(root); const file = db(root, 1, head);
  const before = fs.readFileSync(file); const flow = put(root, 'srv/node-red/flows.json', 'old code');
  put(root, 'usr/share/db/farming.db', 'must not seed');
  assert.equal(shellSeed(root, '97_osi_db_seed').status, 0);
  assert.equal(shellSeed(root, '98_osi_node_red_seed').status, 0);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.readFileSync(flow, 'utf8'), 'old code');
  assert.equal(safety().readStatus(root).phase, 'held');
  assert.equal(safety().runtimeAllowed(root), false);
  assert.equal(safety().begin(root), false, 'reboot cannot release a hold');
});

test('fresh seeding is atomic, resumable and ready only after code initialization', t => {
  const root = fixture(t); installFixtureHelper(root);
  const seedRoot = fixture(t); const seed = db(seedRoot, 0, 79);
  put(root, 'usr/share/db/farming.db', fs.readFileSync(seed));
  assert.equal(shellSeed(root, '97_osi_db_seed').status, 0);
  assert.equal(safety().readStatus(root).phase, 'fresh');
  assert.equal(safety().runtimeAllowed(root), false);
  assert.equal(shellSeed(root, '97_osi_db_seed').status, 0, 'retry keeps its own fresh seed');
  safety().complete(root);
  assert.equal(safety().runtimeAllowed(root), true);
  fs.unlinkSync(path.join(root, 'data/db/farming.db'));
  assert.equal(safety().runtimeAllowed(root), false);
  assert.equal(shellSeed(root, '97_osi_db_seed').status, 0);
  assert.equal(fs.existsSync(path.join(root, 'data/db/farming.db')), false, 'missing DB after ready never reseeds');
});

test('corrupt or unproven failure status never grants fresh initialization', t => {
  for (const content of ['broken JSON', JSON.stringify({ schema: 1, phase: 'failed', step: 'inspect', reason: 'cannot inspect', origin: 'unproven' })]) {
    const root = fixture(t); installFixtureHelper(root);
    put(root, 'etc/osi-image-initialization.json', content);
    put(root, 'usr/share/db/farming.db', 'seed');
    assert.equal(shellSeed(root, '97_osi_db_seed').status, 0);
    assert.equal(fs.existsSync(path.join(root, 'data/db/farming.db')), false);
    assert.equal(safety().runtimeAllowed(root), false);
  }
  const legacy = fixture(t); db(legacy);
  assert.equal(safety().runtimeAllowed(legacy), true, 'application deploy on an old image has no image marker');
});

test('new image entry distrusts a ready receipt carried in a manually extended archive', t => {
  const root = fixture(t); installFixtureHelper(root);
  const seedRoot = fixture(t); put(root, 'usr/share/db/farming.db', fs.readFileSync(db(seedRoot, 0, 79)));
  safety().seed(root); safety().complete(root);
  assert.equal(safety().runtimeAllowed(root), true);
  safety().imageEntry(root);
  assert.equal(safety().readStatus(root).phase, 'held');
  assert.equal(safety().runtimeAllowed(root), false);
  const defaults = fs.readFileSync(path.join(profile, 'etc/uci-defaults/93_osi_image_upgrade_guard'), 'utf8');
  assert.ok(defaults.indexOf(' image-entry') < defaults.indexOf(' install'));
});

test('fresh code initialization repairs a directory/link collision and records a failed native step', t => {
  for (const failNative of [false, true]) {
    const root = fixture(t); installFixtureHelper(root);
    const seedRoot = fixture(t); put(root, 'usr/share/db/farming.db', fs.readFileSync(db(seedRoot, 0, 79)));
    assert.equal(shellSeed(root, '97_osi_db_seed').status, 0);
    put(root, 'usr/share/flows.json', 'new flows');
    put(root, 'usr/share/node-red/osi-lib/index.js', 'new helper');
    fs.mkdirSync(path.join(root, 'usr/share/node-red/node_modules'), { recursive: true });
    fs.symlinkSync('../osi-lib', path.join(root, 'usr/share/node-red/node_modules/osi-lib'));
    // Prior partial fresh initialization left a real helper directory.
    put(root, 'srv/node-red/node_modules/osi-lib/index.js', 'partial helper');
    let script = fs.readFileSync(path.join(profile, 'etc/uci-defaults/98_osi_node_red_seed'), 'utf8');
    // The dedicated native suite executes that block. Here a controlled exit
    // lets us test the surrounding real copy and durable failure/ready paths.
    script = script.replace(/# BEGIN native sqlite3 seed[\s\S]*?# END native sqlite3 seed/, `# BEGIN native sqlite3 seed\n/usr/bin/node /usr/libexec/osi-image-safety.js step native-sqlite\n${failNative ? 'exit 7' : ':'}\n# END native sqlite3 seed`);
    const file = put(root, 'seed-with-native-seam', rewrite(script, root));
    const result = spawnSync('/bin/sh', [file], { encoding: 'utf8' });
    assert.equal(result.status, failNative ? 7 : 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'srv/node-red/osi-lib/index.js'), 'utf8'), 'new helper');
    assert.equal(safety().readStatus(root).phase, failNative ? 'failed' : 'ready');
    if (failNative) {
      assert.equal(safety().readStatus(root).step, 'native-sqlite');
      assert.match(safety().readStatus(root).reason, /7/);
      assert.equal(safety().runtimeAllowed(root), false);
    }
  }
});

test('old application evidence and orphaned sidecars hold even without a farm DB', t => {
  for (const name of ['srv/node-red/flows.json', 'data/db/farming.db-wal', 'data/db/farming.db-journal']) {
    const root = fixture(t); installFixtureHelper(root); put(root, name, 'unproven');
    put(root, 'usr/share/db/farming.db', 'must not seed');
    assert.equal(shellSeed(root, '97_osi_db_seed').status, 0);
    assert.equal(shellSeed(root, '98_osi_node_red_seed').status, 0);
    assert.equal(fs.existsSync(path.join(root, 'data/db/farming.db')), false);
    assert.equal(safety().readStatus(root).phase, 'held');
  }
});

test('source wrappers cover CLI, LuCI/rpcd exec and direct procd validation before stock code', t => {
  const root = fixture(t); installFixtureHelper(root);
  for (const name of ['sbin/sysupgrade', 'usr/libexec/validate_firmware_image']) put(root, name, '#!/bin/sh\nprintf "stock:%s\\n" "$*"\n', 0o755);
  const s = safety(root); s.install(root); s.install(root);
  let result = spawnSync(path.join(root, 'sbin/sysupgrade'), ['image.bin'], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.match(result.stdout, /stock:image.bin/);
  db(root);
  for (const args of [['image.bin'], ['-n', '--force', 'image.bin'], ['-b', '/tmp/backup.tgz'], ['--create-backup', '-'], ['-f', '/tmp/backup.tgz', 'image.bin']]) {
    result = spawnSync(path.join(root, 'sbin/sysupgrade'), args, { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.doesNotMatch(result.stdout, /stock:/); assert.match(result.stderr, /deploy.sh/);
    assert.match(result.stderr, /off the device/);
  }
  result = spawnSync(path.join(root, 'usr/libexec/validate_firmware_image'), ['image.bin'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.doesNotMatch(result.stdout, /stock:/);
  result = spawnSync(path.join(root, 'sbin/sysupgrade'), ['--list-backup'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
});

test('real OpenWrt upgrade and validator scripts are stopped before any stock instruction', t => {
  const root = fixture(t); installFixtureHelper(root); db(root);
  for (const name of ['sbin/sysupgrade', 'usr/libexec/validate_firmware_image']) {
    const stock = fs.readFileSync(path.join(repo, 'openwrt/package/base-files/files', name));
    put(root, name, stock, 0o755);
  }
  safety(root).install(root);
  for (const [name, args] of [['sbin/sysupgrade', ['image.bin']], ['sbin/sysupgrade', ['-b', '/tmp/backup.tgz']], ['usr/libexec/validate_firmware_image', ['image.bin']]]) {
    const result = spawnSync(path.join(root, name), args, { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Image upgrade refused/);
    assert.doesNotMatch(result.stderr, /cannot open.*lib\/functions/);
  }
});

test('wrapper installer refuses conflicting originals and recovers a cut after preserving stock', t => {
  const root = fixture(t); installFixtureHelper(root);
  const s = safety(root);
  for (const name of ['sbin/sysupgrade', 'usr/libexec/validate_firmware_image']) {
    put(root, name, '#!/bin/sh\nexit 0\n', 0o755);
    fs.copyFileSync(path.join(root, name), path.join(root, name + '.osi-stock'));
  }
  s.install(root);
  put(root, 'sbin/sysupgrade.osi-stock', 'unexpected');
  assert.throws(() => s.install(root), /stock/);
});

test('application deploy installs both source guards through its real shell fragment', t => {
  const root = fixture(t); installFixtureHelper(root);
  for (const name of ['sbin/sysupgrade', 'usr/libexec/validate_firmware_image']) put(root, name, '#!/bin/sh\nexit 0\n', 0o755);
  const source = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  const fragment = source.split('# image upgrade guard begin\n')[1].split('# image upgrade guard end')[0]
    .replace(/(?<=[ \t"'])\/(usr\/libexec|usr\/sbin)/g, match => root + match);
  const prepared = put(root, 'prepared-helper.js', portableInterpreter(fs.readFileSync(helper, 'utf8')).replace("const LIVE_ROOT = '/';", `const LIVE_ROOT = ${JSON.stringify(root)};`));
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const stub = `fetch_required() { case "$2" in */osi-image-safety.js) cp '${prepared}' "$3";; *) cp '${repo}/'"$2" "$3";; esac; }\nTMP_DIR='${root}/tmp'\n`;
  const result = spawnSync('/bin/sh', ['-ec', stub + fragment], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['sbin/sysupgrade', 'usr/libexec/validate_firmware_image']) assert.match(fs.readFileSync(path.join(root, name), 'utf8'), /OSI image-upgrade guard/);
  assert.equal(fs.statSync(path.join(root, 'usr/sbin/osi-factory-reset')).mode & 0o777, 0o755);
});

test('console reset requires the explicit erasure option, root and a terminal', t => {
  const root = fixture(t); const calls = [];
  const run = (...args) => { calls.push(args); };
  const s = safety();
  for (const args of [[], ['-n'], ['--erase-farm-and-radio-state', 'extra']]) assert.throws(() => s.factoryReset(root, args, { tty: true, uid: 0, run }), /erase/);
  assert.throws(() => s.factoryReset(root, ['--erase-farm-and-radio-state'], { tty: false, uid: 0, run }), /console/);
  assert.throws(() => s.factoryReset(root, ['--erase-farm-and-radio-state'], { tty: true, uid: 0, run, mounts: '/dev/state /data ext4 rw 0 0\n' }), /mounted/);
  s.factoryReset(root, ['--erase-farm-and-radio-state'], { tty: true, uid: 0, run, mounts: '/dev/root / squashfs ro 0 0\n' });
  assert.deepEqual(calls.map(c => c[0]), [path.join(root, 'sbin/firstboot'), path.join(root, 'sbin/reboot')]);
});

test('manual init starts the hold responder before any application or W5 repair', t => {
  const root = fixture(t); installFixtureHelper(root);
  put(root, 'srv/chirpstack/chirpstack.sqlite', 'radio'); safety().begin(root);
  const init = rewrite(fs.readFileSync(path.join(repo, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init'), 'utf8'), root);
  const script = put(root, 'init-under-test', init);
  const result = spawnSync('/bin/sh', ['-c', `. '${script}'; procd_open_instance() { echo INSTANCE; }; procd_set_param() { echo "$*"; }; procd_close_instance() { :; }; payload_switch_repair() { echo BAD_REPAIR; }; ensure_persistent_syslog_sink() { echo BAD_APP; }; start_service`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /osi-image-hold/); assert.doesNotMatch(result.stdout, /BAD_APP|BAD_REPAIR/);
});

test('hold page explains console recovery and provides no unauthenticated action', async t => {
  const { createServer } = require(path.join(profile, 'usr/libexec/osi-image-hold.js'));
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const method of ['GET', 'POST', 'DELETE']) {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/gui/', method }, res => {
        let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      }); req.on('error', reject); req.end();
    });
    assert.equal(response.status, 503); assert.match(response.body, /restore.*backup/i); assert.match(response.body, /console/);
    assert.doesNotMatch(response.body, /<form|<script|<button/);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});
