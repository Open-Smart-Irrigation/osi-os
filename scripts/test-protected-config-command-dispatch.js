'use strict';

// Executable dispatch contract. The stateful binding/rollback matrix lives in
// osi-command-ledger and osi-watermark-helper tests; this test proves the
// production flow reaches that transaction boundary before generic routing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const flowPath = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const flows = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
const byName = Object.fromEntries(flows.filter((node) => node.name).map((node) => [node.name, node]));
const helper = byName['Apply WATERMARK Protected Command'];
const dedupe = byName['Deduplicate Pending Command'];
const ack = byName['Queue REST Command ACK'];
assert.ok(helper, 'protected helper node exists');
assert.ok(dedupe, 'real dedupe node exists');
assert.ok(ack, 'durable ACK queue exists');

assert.match(dedupe.func, /deduplicatePendingCommand/);
assert.match(dedupe.func, /_pendingCommandEnvelope/);
assert.match(dedupe.func, /gateway_device_eui/);
assert.match(dedupe.func, /protectedTypes/);
assert.match(dedupe.func, /return \[null, null, msg\]/);
assert.deepEqual(dedupe.wires, [['journal-command-apply-fn'], ['9d5e3035c3d069c4'], ['watermark-config-command-apply-fn']]);

// Execute the real function-node body for a protected command. This must
// take the semantic-helper output before attempting generic replay; static
// wiring checks alone cannot prove that ordering.
const dedupeProbe = spawnSync(process.execPath, ['-e', `
  const assert = require('node:assert/strict');
  const body = ${JSON.stringify(dedupe.func)};
  const run = new Function('msg', 'node', 'env', 'flow', 'osiLib', body);
  const msg = { payload: { _pendingCommandEnvelope: {
    commandId: 9123,
    commandType: 'SET_WATERMARK_CALIBRATION',
    payload: { operation: 'set' }
  } }, _commandTypeRecognized: true };
  const node = {
    error: (...args) => { throw new Error(args.join(' ')); },
    warn: () => {},
    status: () => {}
  };
  const env = { get: (key) => key === 'DEVICE_EUI' ? 'AABBCCDDEEFF0011' : '' };
  const flow = {};
  const osiLib = { require: () => { throw new Error('generic replay loader reached'); } };
  Promise.resolve(run(msg, node, env, flow, osiLib)).then((result) => {
    assert.deepEqual(result, [null, null, msg]);
  }).catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
`], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
assert.equal(dedupeProbe.status, 0, dedupeProbe.stderr || dedupeProbe.stdout);

// Run the protected hand-off through both shipped function-node bodies with a
// real in-memory seed database and the production ledger/helper modules. The
// wrapper only adapts node:sqlite's synchronous API to the callback-shaped
// osi-db-helper surface; no command/ACK decision is mocked.
const protectedChainProbe = spawnSync(process.execPath, ['-e', `
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const root = ${JSON.stringify(ROOT)};
  const seed = fs.readFileSync(path.join(root, 'database/seed-blank.sql'), 'utf8');
  const watermark = require(path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/commands.js'));
  const ledger = require(path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.js'));
  const gateway = '0011223344556677';
  const device = 'AABBCCDDEEFF0011';
  const owner = '22222222-2222-4222-8222-222222222222';
  const now = '2026-09-30T09:00:00.000Z';
  const calibration = {
    pullup_1_ohm: 41670, pulldown_1_ohm: 41260, series_fwd_1_ohm: 130, series_rev_1_ohm: 112,
    pullup_2_ohm: 42530, pulldown_2_ohm: 42070, series_fwd_2_ohm: 46, series_rev_2_ohm: 27
  };
  function scope(raw) {
    return {
      get: async (sql, params = []) => raw.prepare(sql).get(...params),
      all: async (sql, params = []) => raw.prepare(sql).all(...params),
      run: async (sql, params = []) => { raw.prepare(sql).run(...params); },
      exec: async (sql) => raw.exec(sql),
    };
  }
  class Database {
    constructor() {
      this.raw = new DatabaseSync(':memory:');
      this.raw.exec(seed);
      this.raw.prepare('INSERT INTO users(id,username,password_hash,created_at,updated_at,user_uuid,role) VALUES(?,?,?,?,?,?,?)').run(1, 'owner', 'hash', now, now, owner, 'admin');
      this.raw.prepare('INSERT INTO sync_link_state(peer_node,linked,gateway_device_eui,updated_at) VALUES(?,?,?,?)').run('cloud', 1, gateway, now);
      this.raw.prepare('INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,gateway_device_eui,sync_version,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,?)').run(device, 'Watermark', 'DRAGINO_LSN50', 1, null, gateway, now, now);
    }
    async transaction(fn) {
      this.raw.exec('BEGIN IMMEDIATE');
      try { const result = await fn(scope(this.raw)); this.raw.exec('COMMIT'); return result; }
      catch (error) { try { this.raw.exec('ROLLBACK'); } catch (_) {} throw error; }
    }
    close(callback) { try { this.raw.close(); callback(); } catch (error) { callback(error); } }
  }
  const osiLib = { require(name) {
    if (name === 'osi-db-helper') return { ok: true, value: { Database } };
    if (name === 'watermark-helper') return { ok: true, value: watermark };
    if (name === 'osi-command-ledger') return { ok: true, value: ledger };
    return { ok: false, error: 'unexpected helper ' + name };
  } };
  const env = { get: (key) => ({ DEVICE_EUI: gateway, OSI_SCOPED_ACCESS: '1' }[key] || '') };
  const node = { error: (...args) => { throw new Error(args.join(' ')); }, warn: () => {}, status: () => {} };
  const flow = {};
  const payload = {
    command_type: 'SET_WATERMARK_CALIBRATION', command_id: '11111111-1111-4111-8111-000000000001',
    effect_key: 'watermark_calibration:set:' + gateway + ':' + device + ':0', device_eui: device,
    gateway_device_eui: gateway, actor_user_uuid: owner, base_sync_version: 0, operation: 'set', values: calibration
  };
  const msg = { payload: { _pendingCommandEnvelope: { commandId: 9124, commandType: 'SET_WATERMARK_CALIBRATION', effectKey: payload.effect_key, payload } }, _commandTypeRecognized: true };
  const dedupeRun = new Function('msg', 'node', 'env', 'flow', 'osiLib', ${JSON.stringify(dedupe.func)});
  const helperRun = new Function('msg', 'node', 'env', 'flow', 'osiLib', ${JSON.stringify(helper.func)});
  (async () => {
    const deduped = await dedupeRun(msg, node, env, flow, osiLib);
    assert.deepEqual(deduped, [null, null, msg]);
    const applied = await helperRun(deduped[2], node, env, flow, osiLib);
    assert.equal(applied[0], null);
    assert.equal(JSON.parse(applied[1].payload).result, 'APPLIED');
  })().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
`], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
assert.equal(protectedChainProbe.status, 0, protectedChainProbe.stderr || protectedChainProbe.stdout);

assert.match(helper.func, /withProtectedCommandTransaction|applyWatermarkCommand/);
assert.match(helper.func, /command_type_recognized/);
assert.match(helper.func, /protected_context/);
assert.match(helper.func, /finally/);
assert.match(helper.func, /recordProtectedDecision/);
assert.match(ack.func, /queueCommandAck/);

// The generic replay node must stay upstream of the semantic helper's pass
// through, while the helper's ACK output is durable rather than downlink-only.
assert.deepEqual(helper.wires, [['934bf2bc19a8ce22'], ['9d5e3035c3d069c4']]);
assert.doesNotMatch(helper.func, /UPDATE devices SET soil_moisture_probe_depths_json/);
assert.doesNotMatch(helper.func, /INSERT OR REPLACE INTO watermark_readings/);

// The flow-wiring assertions above prove the production order.  Run the real
// SQLite-backed helper/ledger matrix as part of this gate too: it covers the
// semantic-before-replay mismatch cases, legacy rows without trusted binding,
// and rollback between local mutation and terminal ACK/outbox persistence.
const helperTests = path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/commands.test.js'
);
const helperRun = spawnSync(process.execPath, ['--test', helperTests], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 60000,
});
assert.equal(helperRun.status, 0, helperRun.stderr || helperRun.stdout);
assert.match(helperRun.stdout, /# pass \d+/);
const ledgerTests = path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js'
);
const ledgerRun = spawnSync(process.execPath, ['--test', ledgerTests], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 60000,
});
assert.equal(ledgerRun.status, 0, ledgerRun.stderr || ledgerRun.stdout);
assert.match(ledgerRun.stdout, /# pass \d+/);
const bootstrapTests = path.join(ROOT, 'scripts/test-journal-bootstrap.js');
const bootstrapRun = spawnSync(process.execPath, ['--test', bootstrapTests], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 60000,
});
assert.equal(bootstrapRun.status, 0, bootstrapRun.stderr || bootstrapRun.stdout);
assert.match(bootstrapRun.stdout, /# pass 62/);

console.log('protected configuration dispatch checks passed');
