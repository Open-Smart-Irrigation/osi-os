'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { makeGateway, reboot, acceptRetiredPayload } = require('./fixtures/legacy-device-gateway');
const { prepareOffline, assertHold, releaseHold } = require('./lib/legacy-device-repair-ops');
const { retiredFunction, functionText } = require('./rehearse-legacy-catalog');
const ROOT = path.resolve(__dirname, '..');
const files = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files');
const deploy = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
const fn = name => {
  const found = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm').exec(deploy);
  assert.ok(found, name); return found[0];
};
function setup(t) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eb19-handoff-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const root = makeGateway(path.join(scratch, 'gateway'));
  const dbPath = path.join(root, 'data/db/farming.db');
  const db = new DatabaseSync(dbPath); db.exec('CREATE TABLE devices(id INTEGER PRIMARY KEY); INSERT INTO devices VALUES(1)'); db.close();
  prepareOffline({ root });
  return { root, dbPath, scratch, flows: path.join(root, 'srv/node-red/flows.json') };
}
function command(f, script) {
  return spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, DB_PATH: f.dbPath, SWAP_ROOT: path.dirname(f.flows), NODE_RED_INIT: path.join(f.root, 'mock-init'), IPKG_INSTROOT: f.root } });
}
function healthFunctions() {
  return fn('recovery_hold_present') + fn('repair_health_start').replace('/usr/share/node-red/osi-db-integrity/index.js', path.join(files, 'usr/share/node-red/osi-db-integrity/index.js'));
}
test('one recovery hold policy ships byte-identically in both profiles', () => {
  for (const profile of ['bcm2712', 'bcm2709']) {
    assert.deepEqual(fs.readFileSync(path.join(ROOT, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/node-red/osi-db-integrity/recovery-hold.js`)), fs.readFileSync(path.join(ROOT, 'lib/osi-migrate/recovery-hold.js')));
  }
});
test('cut after deploy stages the real identity defaults keeps both reboot entries disabled', t => {
  const f = setup(t);
  const pending = fs.readFileSync(path.join(files, 'etc/uci-defaults/94_osi_identityd_enable'), 'utf8').replaceAll('/data/db/farming.db', f.dbPath).replaceAll('/etc/init.d/', f.root + '/etc/init.d/').replaceAll('/etc/rc.d/', f.root + '/etc/rc.d/');
  fs.writeFileSync(path.join(f.root, 'etc/uci-defaults/94_osi_identityd_enable'), pending);
  const run = command(f, pending);
  assert.equal(run.status, 1, run.stderr);
  reboot(f.root);
  assert.equal(fs.existsSync(path.join(f.root, 'started')), false);
  assertHold(f.root);
});
for (const flow of ['old-compatible', 'retired']) {
  test(`held health start checks the actual ${flow} payload before the init entry`, t => {
    const f = setup(t);
    fs.writeFileSync(f.flows, JSON.stringify([{ id: 'sync-init-fn', func: flow === 'retired' ? retiredFunction(functionText()) : functionText() }]));
    fs.writeFileSync(path.join(f.root, 'mock-init'), '#!/bin/sh\necho "$1:$OSI_LEGACY_REPAIR_HEALTH" >> "$IPKG_INSTROOT/health-started"\n', { mode: 0o700 });
    const run = command(f, healthFunctions() + '\nrepair_health_start restart');
    assert.equal(run.status, flow === 'retired' ? 0 : 1, run.stderr);
    if (flow === 'retired') assert.equal(fs.readFileSync(path.join(f.root, 'health-started'), 'utf8'), 'restart:1\n');
    else assert.equal(fs.existsSync(path.join(f.root, 'health-started')), false);
    reboot(f.root); // cut after health and before explicit release
    assert.equal(fs.existsSync(path.join(f.root, 'started')), false);
    assertHold(f.root);
  });
}
test('held health start refuses orphan data before init even on a retired payload', t => {
  const f = setup(t);
  fs.writeFileSync(f.flows, JSON.stringify([{ id: 'sync-init-fn', func: retiredFunction(functionText()) }]));
  const db = new DatabaseSync(f.dbPath); db.exec('PRAGMA foreign_keys=OFF; CREATE TABLE child(id REFERENCES devices(id)); INSERT INTO child VALUES(42)'); db.close();
  const run = command(f, healthFunctions() + '\nrepair_health_start restart');
  assert.equal(run.status, 1); assert.match(run.stderr, /health check failed/);
  assertHold(f.root);
});
for (const phase of ['failed-before-flip', 'failed-after-flip', 'healthy-before-release']) {
  test(`deploy exit ${phase} stops held writers and never runs compatibility rollback`, t => {
    const f = setup(t);
    const script = fn('recovery_hold_present') + fn('deploy_exit_handler') + `
set -u
DB_MIGRATION_COMMITTED=1
PAYLOAD_FLIPPED=${phase === 'failed-before-flip' ? 0 : 1}
hold_node_red_stopped() { echo node-red-stop; }
quiesce_identityd_instance() { echo identityd-stop; }
cleanup() { :; }
restart_previous_payload() { echo UNSAFE-ROLLBACK; return 0; }
restore_identityd_prior_state() { echo UNSAFE-RESTORE; }
deploy_exit_handler ${phase === 'healthy-before-release' ? 0 : 1}
`;
    const run = command(f, script);
    assert.equal(run.status, phase === 'healthy-before-release' ? 0 : 1, run.stderr);
    assert.equal(run.stdout, 'node-red-stop\nidentityd-stop\n');
    assertHold(f.root); reboot(f.root);
    assert.equal(fs.existsSync(path.join(f.root, 'started')), false);
  });
}
test('release consumes only the reviewed pending enable script and preserves originally disabled identityd', async t => {
  const f = setup(t);
  const receipt = path.join(f.dbPath + '.osi-recovery', 'receipt.json');
  const record = JSON.parse(fs.readFileSync(receipt)); record.services[0].enabled = false; fs.writeFileSync(receipt, JSON.stringify(record));
  fs.writeFileSync(f.flows, JSON.stringify([{ id: 'sync-init-fn', func: retiredFunction(functionText()) }]));
  const pending = path.join(f.root, 'etc/uci-defaults/94_osi_identityd_enable');
  fs.copyFileSync(path.join(files, 'etc/uci-defaults/94_osi_identityd_enable'), pending);
  acceptRetiredPayload(f.root, retiredFunction(functionText()));
  await releaseHold({ root: f.root, verify: async () => {} });
  assert.equal(fs.existsSync(pending), false);
  assert.equal(fs.readdirSync(path.join(f.root, 'etc/rc.d')).some(n => /^S/.test(n) && n.endsWith('osi-identityd')), false);
});

for (const point of ['releasing', 'restored-osi-identityd', 'restored-node-red', 'released']) {
  test(`release retries a power cut at ${point} without losing prior enablement`, async t => {
    const f = setup(t);
    acceptRetiredPayload(f.root, retiredFunction(functionText()));
    const run = spawnSync(process.execPath, ['-e', `require(process.argv[1]).releaseHold({root:process.argv[2],verify:async()=>{},checkpoint:async p=>{if(p===process.argv[3])process.kill(process.pid,'SIGKILL')}}).catch(e=>{console.error(e);process.exitCode=1})`, path.join(ROOT, 'scripts/lib/legacy-device-repair-ops.js'), f.root, point], {encoding:'utf8'});
    assert.equal(run.signal, 'SIGKILL', run.stderr);
    // New init checks the persistent marker even if one enable link survived.
    const init = fs.readFileSync(path.join(ROOT, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init'), 'utf8');
    assert.match(init, /OSI_LEGACY_REPAIR_HEALTH/);
    const a = init.indexOf('    for recovery_suffix in', init.indexOf('start_service() {'));
    const b = init.indexOf('    payload_switch_repair', a);
    const guard = command(f, `OSI_DB_PATH="$DB_PATH"
check_init_hold() {
${init.slice(a,b)}
}
check_init_hold`);
    assert.equal(guard.status, 1, guard.stderr);

    const r = await releaseHold({root:f.root,verify:async()=>{assertHold(f.root);}});
    assert.equal(r.released, true);
    assert.equal(fs.existsSync(f.dbPath+'.osi-recovery'), false);
    assert.equal(fs.readdirSync(path.join(f.root,'etc/rc.d')).filter(n=>/^S/.test(n)).length, 2);
  });
}
for (const state of ['unverified', 'held']) {
  test(`release refuses a retired payload with durable ${state} health`, async t => {
    const f = setup(t);
    acceptRetiredPayload(f.root, retiredFunction(functionText()));
    fs.writeFileSync(path.join(f.root,'srv/node-red/payload-state.json'),JSON.stringify({format:1,active:'retired',state}));
    await assert.rejects(releaseHold({root:f.root,verify:async()=>{}}), /successful deploy health verdict/);
    assertHold(f.root);
  });
}

test('the original cleanup stops a held owed-health start on a later staging failure', t => {
  const f = setup(t);
  const script = fn('cleanup') + `
HELD_HEALTH_STARTED=1
COMMAND_LEDGER_STAGE=""
DISCARD_STAGE_ON_EXIT=0
TMP_DIR="$1"
hold_node_red_stopped() { echo node-red-stop; }
quiesce_identityd_instance() { echo identityd-stop; }
release_deploy_lock() { :; }
cleanup
`;
  const temp = path.join(f.scratch,'deploy-stage'); fs.mkdirSync(temp);
  const run = spawnSync('/bin/sh',['-c',script,'cleanup',temp],{encoding:'utf8',env:{...process.env,DB_PATH:f.dbPath}});
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.stdout,'node-red-stop\nidentityd-stop\n');
  assertHold(f.root); reboot(f.root);
  assert.equal(fs.existsSync(path.join(f.root,'started')),false);
});
