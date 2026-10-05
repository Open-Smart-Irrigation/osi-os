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
`], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
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
  let sharedRaw;
  class Database {
    constructor() {
      if (!sharedRaw) {
        sharedRaw = new DatabaseSync(':memory:');
        sharedRaw.exec(seed);
        sharedRaw.prepare('INSERT INTO users(id,username,password_hash,created_at,updated_at,user_uuid,role) VALUES(?,?,?,?,?,?,?)').run(1, 'owner', 'hash', now, now, owner, 'admin');
        sharedRaw.prepare('INSERT INTO sync_link_state(peer_node,linked,gateway_device_eui,updated_at) VALUES(?,?,?,?)').run('cloud', 1, gateway, now);
        sharedRaw.prepare('INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,gateway_device_eui,sync_version,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,?)').run(device, 'Watermark', 'DRAGINO_LSN50', 1, null, gateway, now, now);
      }
      this.raw = sharedRaw;
    }
    async transaction(fn) {
      this.raw.exec('BEGIN IMMEDIATE');
      try { const result = await fn(scope(this.raw)); this.raw.exec('COMMIT'); return result; }
      catch (error) { try { this.raw.exec('ROLLBACK'); } catch (_) {} throw error; }
    }
    close(callback) { callback(); }
  }
  const osiLib = { require(name) {
    if (name === 'osi-db-helper') return { ok: true, value: { Database } };
    if (name === 'watermark-helper') return { ok: true, value: watermark };
    if (name === 'osi-command-ledger') return { ok: true, value: ledger };
    return { ok: false, error: 'unexpected helper ' + name };
  } };
  const env = { get: (key) => ({ DEVICE_EUI: gateway, OSI_SCOPED_ACCESS: '1' }[key] || '') };
  const node = { error: (...args) => { console.error(args.join(' ')); }, warn: () => {}, status: () => {} };
  const flow = {};
  const dedupeRun = new Function('msg', 'node', 'env', 'flow', 'osiLib', ${JSON.stringify(dedupe.func)});
  const helperRun = new Function('msg', 'node', 'env', 'flow', 'osiLib', ${JSON.stringify(helper.func)});
  function makeEnvelope(commandId, commandType = 'SET_WATERMARK_CALIBRATION', changes = {}) {
    const operation = commandType === 'DELETE_WATERMARK_CALIBRATION' ? 'delete' : 'set';
    const payload = {
      command_type: commandType, command_id: '11111111-1111-4111-8111-' + String(commandId).padStart(12, '0'),
      effect_key: 'watermark_calibration:' + operation + ':' + gateway + ':' + device + ':0', device_eui: device,
      gateway_device_eui: gateway, actor_user_uuid: owner, base_sync_version: 0, operation,
      values: operation === 'delete' ? undefined : Object.assign({}, calibration)
    };
    Object.assign(payload, changes);
    return { commandId, commandType, effectKey: payload.effect_key, payload };
  }
  async function invoke(envelope) {
    const msg = { payload: { _pendingCommandEnvelope: envelope }, _commandTypeRecognized: true };
    const deduped = await dedupeRun(msg, node, env, flow, osiLib);
    assert.deepEqual(deduped[2] || deduped[0], msg);
    const applied = await helperRun(msg, node, env, flow, osiLib);
    assert.equal(applied[0], null);
    if (!applied[1]) return undefined;
    return JSON.parse(applied[1].payload);
  }
  (async () => {
    const first = await invoke(makeEnvelope(9124));
    assert.equal(first.result, 'APPLIED');
    const baseline = sharedRaw.prepare('SELECT command_type,binding_hash,intent_hash,gateway_device_eui,actor_user_uuid,base_sync_version,operation FROM applied_commands WHERE command_id=?').get('9124');
    const calibrationBefore = sharedRaw.prepare('SELECT sync_version,pullup_1_ohm FROM watermark_calibrations WHERE deveui=?').get(device);
    const exact = await invoke(makeEnvelope(9124));
    assert.equal(exact.result, 'APPLIED');
    assert.equal(exact.duplicate, false);
    const durableAckBeforeConflicts = sharedRaw.prepare('SELECT payload_json FROM command_ack_outbox WHERE command_id=?').get('9124').payload_json;
    const effect = await invoke(makeEnvelope(9125));
    assert.equal(effect.result, 'APPLIED');
    assert.equal(effect.duplicate, true);
    assert.equal(sharedRaw.prepare('SELECT COUNT(*) AS n FROM applied_commands WHERE effect_key=?').get('watermark_calibration:set:' + gateway + ':' + device + ':0').n, 2);
    assert.deepEqual(JSON.parse(sharedRaw.prepare('SELECT payload_json FROM command_ack_outbox WHERE command_id=?').get('9125').payload_json), effect);
    const conflictCases = [
      { label: 'actor', changes: { actor_user_uuid: '44444444-4444-4444-8444-444444444444' } },
      { label: 'gateway', changes: { gateway_device_eui: '0011223344556688' } },
      { label: 'device', changes: { device_eui: 'AABBCCDDEEFF0022' } },
      { label: 'base', changes: { base_sync_version: 1 } },
      { label: 'type', commandType: 'DELETE_WATERMARK_CALIBRATION' },
      { label: 'intent', changes: { values: Object.assign({}, calibration, { pullup_1_ohm: 41671 }) } },
    ];
    for (const item of conflictCases) {
      const conflict = await invoke(makeEnvelope(9124, item.commandType, item.changes));
      assert.equal(conflict.result, 'CONFLICT', item.label);
      assert.equal(conflict.commandId, 9124, item.label);
      const row = sharedRaw.prepare('SELECT command_type,binding_hash,intent_hash,gateway_device_eui,actor_user_uuid,base_sync_version,operation FROM applied_commands WHERE command_id=?').get('9124');
      assert.deepEqual(row, baseline, item.label + ' rewrote terminal ledger');
      assert.deepEqual(sharedRaw.prepare('SELECT sync_version,pullup_1_ohm FROM watermark_calibrations WHERE deveui=?').get(device), calibrationBefore, item.label + ' mutated calibration');
      assert.deepEqual(JSON.parse(sharedRaw.prepare('SELECT payload_json FROM command_ack_outbox WHERE command_id=?').get('9124').payload_json), JSON.parse(durableAckBeforeConflicts), item.label + ' rewrote durable ACK');
    }
    sharedRaw.prepare('INSERT INTO applied_commands(command_id,effect_key,device_eui,command_type,result,applied_at,result_detail,originator) VALUES(?,?,?,?,?,?,?,?)').run('9130', 'watermark_calibration:set:' + gateway + ':' + device + ':0', device, 'SET_WATERMARK_CALIBRATION', 'APPLIED', now, JSON.stringify({ commandId: 9130, result: 'APPLIED', status: 'ACKED', duplicate: false }), 'edge');
    const legacy = await invoke(makeEnvelope(9130));
    assert.equal(legacy.result, 'CONFLICT');
    assert.equal(sharedRaw.prepare('SELECT binding_hash FROM applied_commands WHERE command_id=?').get('9130').binding_hash, null);
    const originalApply = watermark.applyWatermarkCommand;
    watermark.applyWatermarkCommand = (db, envelope, runtime) => originalApply(db, envelope, Object.assign({}, runtime, { lifecycle_hooks: { afterCommandLedger() { throw new Error('injected ACK failure'); } } }));
    const failed = await invoke(makeEnvelope(9131, 'SET_WATERMARK_CALIBRATION', { base_sync_version: 1, effect_key: 'watermark_calibration:set:' + gateway + ':' + device + ':1', values: Object.assign({}, calibration, { pullup_1_ohm: 41672 }) }));
    assert.equal(failed, undefined);
    watermark.applyWatermarkCommand = originalApply;
    assert.deepEqual(sharedRaw.prepare('SELECT sync_version,pullup_1_ohm FROM watermark_calibrations WHERE deveui=?').get(device), calibrationBefore);
    assert.equal(sharedRaw.prepare('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?').get('9131').n, 0);
    assert.equal(sharedRaw.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?').get('9131').n, 0);
    // A first admin or backfilled user carries a 32-hex users.user_uuid. The
    // flow hands it to the helper unchanged and the exact lookup finds it.
    const hexAdmin = '0123456789abcdef0123456789abcdef';
    sharedRaw.prepare('INSERT INTO users(id,username,password_hash,created_at,updated_at,user_uuid,role) VALUES(?,?,?,?,?,?,?)').run(2, 'hex-admin', 'hash', now, now, hexAdmin, 'admin');
    const hexValues = Object.assign({}, calibration, { pullup_1_ohm: 41673 });
    const hexApplied = await invoke(makeEnvelope(9140, 'SET_WATERMARK_CALIBRATION', { actor_user_uuid: hexAdmin, base_sync_version: 1, effect_key: 'watermark_calibration:set:' + gateway + ':' + device + ':1', values: hexValues }));
    assert.equal(hexApplied.result, 'APPLIED', JSON.stringify(hexApplied));
    assert.equal(sharedRaw.prepare('SELECT actor_user_uuid FROM applied_commands WHERE command_id=?').get('9140').actor_user_uuid, hexAdmin);
    assert.deepEqual({ ...sharedRaw.prepare('SELECT sync_version,pullup_1_ohm FROM watermark_calibrations WHERE deveui=?').get(device) }, { sync_version: 2, pullup_1_ohm: 41673 });
    const hexUnknown = await invoke(makeEnvelope(9141, 'SET_WATERMARK_CALIBRATION', { actor_user_uuid: 'fedcba9876543210fedcba9876543210', base_sync_version: 2, effect_key: 'watermark_calibration:set:' + gateway + ':' + device + ':2' }));
    assert.equal(hexUnknown.result, 'REJECTED_PERMANENT');
    assert.equal(hexUnknown.reason, 'actor_missing_or_disabled');
    console.log('STATEFUL_PROTECTED_MATRIX_OK');
  })().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
`], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
assert.equal(protectedChainProbe.status, 0, protectedChainProbe.stderr || protectedChainProbe.stdout);
assert.match(protectedChainProbe.stdout, /STATEFUL_PROTECTED_MATRIX_OK/);

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
  timeout: 180000,
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
  timeout: 180000,
});
assert.equal(ledgerRun.status, 0, ledgerRun.stderr || ledgerRun.stdout);
assert.match(ledgerRun.stdout, /# pass \d+/);
const bootstrapTests = path.join(ROOT, 'scripts/test-journal-bootstrap.js');
const bootstrapRun = spawnSync(process.execPath, ['--test', bootstrapTests], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 180000,
});
assert.equal(bootstrapRun.status, 0, bootstrapRun.stderr || bootstrapRun.stdout);
assert.match(bootstrapRun.stdout, /# pass 62/);

console.log('protected configuration dispatch checks passed');
