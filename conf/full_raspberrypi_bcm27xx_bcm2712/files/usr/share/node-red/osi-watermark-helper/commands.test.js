'use strict';

// Task 8 RED suite.  These tests intentionally load the command receiver
// before the implementation exists; the first run is the required RED
// evidence.  The fixture uses the shipped schema and real sqlite transactions
// so later command/ledger assertions exercise the same tables as a gateway.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const commands = require('./commands');

const ROOT = path.resolve(__dirname, '../../../../../../..');
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const GATEWAY = '0011223344556677';
const OTHER_GATEWAY = '0011223344556688';
const DEVICE = 'AABBCCDDEEFF0011';
const OTHER_DEVICE = 'AABBCCDDEEFF0022';
const OWNER = '22222222-2222-4222-8222-222222222222';
const WRITER = '33333333-3333-4333-8333-333333333333';
const VIEWER = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-09-30T09:00:00.000Z';
const CAL = {
  pullup_1_ohm: 41670, pulldown_1_ohm: 41260, series_fwd_1_ohm: 130, series_rev_1_ohm: 112,
  pullup_2_ohm: 42530, pulldown_2_ohm: 42070, series_fwd_2_ohm: 46, series_rev_2_ohm: 27
};

function fixture(t) {
  const raw = new DatabaseSync(':memory:');
  t.after(() => raw.close());
  raw.exec(SEED);
  const user = (id, uuid, role, disabled = null) => raw.prepare(
    'INSERT INTO users(id,username,password_hash,created_at,updated_at,user_uuid,role,disabled_at) VALUES(?,?,?,?,?,?,?,?)'
  ).run(id, uuid.slice(0, 8), 'hash', NOW, NOW, uuid, role, disabled);
  user(1, OWNER, 'admin'); user(2, WRITER, 'researcher'); user(3, VIEWER, 'viewer');
  raw.prepare('INSERT INTO sync_link_state(peer_node,linked,gateway_device_eui,updated_at) VALUES(\'cloud\',1,?,?)').run(GATEWAY, NOW);
  const device = (eui, gateway, userId = 1, zoneId = null, type = 'DRAGINO_LSN50') => raw.prepare(
    'INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,gateway_device_eui,sync_version,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,?)'
  ).run(eui, 'Watermark', type, userId, zoneId, gateway, NOW, NOW);
  device(DEVICE, GATEWAY); device(OTHER_DEVICE, OTHER_GATEWAY);
  const scope = {
    get: async (sql, params = []) => raw.prepare(sql).get(...params),
    all: async (sql, params = []) => raw.prepare(sql).all(...params),
    run: async (sql, params = []) => { raw.prepare(sql).run(...params); },
    exec: async (sql) => raw.exec(sql),
  };
  const db = Object.assign({}, scope, {
    transaction: async (fn) => { raw.exec('BEGIN IMMEDIATE'); try { const v = await fn(scope); raw.exec('COMMIT'); return v; } catch (e) { raw.exec('ROLLBACK'); throw e; } }
  });
  return { raw, db };
}

function runtime(extra = {}) {
  return Object.assign({ gateway_device_eui: GATEWAY, scopedMode: true, command_type_recognized: true }, extra);
}

function envelope(id, type, values, extra = {}) {
  const operation = type === 'DELETE_WATERMARK_CALIBRATION' ? 'delete' : 'set';
  const payload = Object.assign({
    command_type: type,
    command_id: '11111111-1111-4111-8111-' + String(id).padStart(12, '0'),
    effect_key: `watermark_calibration:${operation}:${GATEWAY}:${DEVICE}:0`,
    device_eui: DEVICE,
    gateway_device_eui: GATEWAY,
    actor_user_uuid: OWNER,
    base_sync_version: 0,
    operation,
    values,
  }, extra.payload || {});
  return { commandId: id, commandType: type, payload };
}

test('all four protected operation names are handled', async (t) => {
  const { db } = fixture(t);
  for (const type of ['SET_WATERMARK_CALIBRATION', 'DELETE_WATERMARK_CALIBRATION', 'SET_CHAMELEON_CONFIG', 'UPSERT_DEVICE_SOIL_DEPTHS']) {
    assert.equal(typeof commands.applyWatermarkCommand, 'function');
    assert.equal(commands.COMMAND_TYPES.includes(type), true);
  }
});

test('valid calibration set uses exact base and terminal ACK atomically', async (t) => {
  const { raw, db } = fixture(t);
  const result = await commands.applyWatermarkCommand(db, envelope(1, 'SET_WATERMARK_CALIBRATION', CAL), runtime());
  assert.equal(result.ack.result, 'APPLIED');
  assert.equal(raw.prepare('SELECT sync_version FROM watermark_calibrations WHERE deveui=?').get(DEVICE).sync_version, 1);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, 1);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox').get().n, 1);
});

test('calibration delete, Chameleon, and soil-depth set share terminal path', async (t) => {
  const { raw, db } = fixture(t);
  const set = await commands.applyWatermarkCommand(db, envelope(2, 'SET_WATERMARK_CALIBRATION', CAL), runtime());
  assert.equal(set.ack.result, 'APPLIED');
  const del = await commands.applyWatermarkCommand(db, envelope(3, 'DELETE_WATERMARK_CALIBRATION', undefined, {
    payload: { base_sync_version: 1, effect_key: `watermark_calibration:delete:${GATEWAY}:${DEVICE}:1` }
  }), runtime());
  assert.equal(del.ack.result, 'APPLIED');
  const ch = await commands.applyWatermarkCommand(db, envelope(4, 'SET_CHAMELEON_CONFIG', { chameleon_enabled: true }, {
    payload: { base_sync_version: 1, effect_key: `chameleon_config:set:${GATEWAY}:${DEVICE}:1` }
  }), runtime());
  assert.equal(ch.ack.result, 'APPLIED');
  const depth = await commands.applyWatermarkCommand(db, envelope(5, 'UPSERT_DEVICE_SOIL_DEPTHS', {
    soil_moisture_probe_depths_json: { swt_1: 15 }, soil_moisture_probe_depths_configured: true
  }, { payload: { base_sync_version: 2, effect_key: `device_soil_depths:set:${GATEWAY}:${DEVICE}:2` } }), runtime());
  assert.equal(depth.ack.result, 'APPLIED');
  assert.equal(raw.prepare('SELECT chameleon_enabled, soil_moisture_probe_depths_json FROM devices WHERE deveui=?').get(DEVICE).chameleon_enabled, 1);
});

test('DEVICE exact-base conflict leaves the existing configuration untouched', async (t) => {
  const { raw, db } = fixture(t);
  const stale = await commands.applyWatermarkCommand(db, envelope(6, 'SET_CHAMELEON_CONFIG', { chameleon_enabled: true }, {
    payload: { base_sync_version: 0, effect_key: `chameleon_config:set:${GATEWAY}:${DEVICE}:0` }
  }), runtime());
  assert.equal(stale.ack.result, 'CONFLICT');
  assert.deepEqual({ ...raw.prepare('SELECT chameleon_enabled, sync_version FROM devices WHERE deveui=?').get(DEVICE) }, { chameleon_enabled: 0, sync_version: 1 });
});

test('stale base and all listed identity/auth denials are terminal without mutation', async (t) => {
  const cases = [
    ['stale', { payload: { base_sync_version: 9, effect_key: `watermark_calibration:set:${GATEWAY}:${DEVICE}:9` } }, 'CONFLICT'],
    ['missing actor', { payload: { actor_user_uuid: '99999999-9999-4999-8999-999999999999' } }, 'REJECTED_PERMANENT'],
    ['viewer', { payload: { actor_user_uuid: VIEWER } }, 'REJECTED_PERMANENT'],
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const [name, override, expected] = cases[index];
    const { raw, db } = fixture(t);
    const result = await commands.applyWatermarkCommand(db, envelope(20 + index, 'SET_WATERMARK_CALIBRATION', CAL, override), runtime());
    assert.equal(result.ack.result, expected, name);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM watermark_calibrations').get().n, 0, name);
  }
});

test('flag-off retains local owner path and rejects numeric cloud identity', async (t) => {
  const { db } = fixture(t);
  const result = await commands.applyWatermarkCommand(db, envelope(30, 'SET_WATERMARK_CALIBRATION', CAL), runtime({ scopedMode: false }));
  assert.equal(result.ack.result, 'APPLIED');
  await assert.rejects(
    commands.applyWatermarkCommand(db, envelope(31, 'SET_WATERMARK_CALIBRATION', CAL, { payload: { actor_user_uuid: '1' } }), runtime({ scopedMode: true })),
    (e) => e.code === 'protected_command_conflict'
  );
});

test('scoped assignment and account matrix is enforced for DEVICE commands', async (t) => {
  const denied = fixture(t);
  denied.raw.prepare('UPDATE users SET disabled_at=? WHERE user_uuid=?').run(NOW, WRITER);
  const disabled = await commands.applyWatermarkCommand(denied.db, envelope(40, 'UPSERT_DEVICE_SOIL_DEPTHS', {
    soil_moisture_probe_depths_json: { swt_1: 20 }, soil_moisture_probe_depths_configured: true
  }, { payload: { actor_user_uuid: WRITER, base_sync_version: 1, effect_key: `device_soil_depths:set:${GATEWAY}:${DEVICE}:1` } }), runtime());
  assert.equal(disabled.ack.result, 'REJECTED_PERMANENT');

  const assigned = fixture(t);
  assigned.raw.prepare(
    'INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,gateway_device_eui,sync_version,created_at,updated_at) VALUES(1,?,?,?,?,1,?,?)'
  ).run('Block', 2, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', GATEWAY, NOW, NOW);
  assigned.raw.prepare('UPDATE devices SET user_id=2, irrigation_zone_id=1, sync_version=1 WHERE deveui=?').run(DEVICE);
  const absent = await commands.applyWatermarkCommand(assigned.db, envelope(41, 'UPSERT_DEVICE_SOIL_DEPTHS', {
    soil_moisture_probe_depths_json: { swt_1: 20 }, soil_moisture_probe_depths_configured: true
  }, { payload: { actor_user_uuid: OWNER, base_sync_version: 1, effect_key: `device_soil_depths:set:${GATEWAY}:${DEVICE}:1` } }), runtime());
  assert.equal(absent.ack.result, 'REJECTED_PERMANENT');
  const valid = fixture(t);
  valid.raw.prepare(
    'INSERT INTO user_zone_assignments(assignment_uuid,user_uuid,zone_uuid,created_at,updated_at,sync_version) VALUES(?,?,?,?,?,1)'
  ).run('55555555-5555-4555-8555-555555555555', WRITER, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NOW, NOW);
  valid.raw.prepare(
    'INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,gateway_device_eui,sync_version,created_at,updated_at) VALUES(1,?,?,?,?,1,?,?)'
  ).run('Block', 2, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', GATEWAY, NOW, NOW);
  valid.raw.prepare('UPDATE devices SET user_id=2, irrigation_zone_id=1, sync_version=1 WHERE deveui=?').run(DEVICE);
  const applied = await commands.applyWatermarkCommand(valid.db, envelope(42, 'UPSERT_DEVICE_SOIL_DEPTHS', {
    soil_moisture_probe_depths_json: { swt_1: 20 }, soil_moisture_probe_depths_configured: true
  }, { payload: { actor_user_uuid: WRITER, base_sync_version: 1, effect_key: `device_soil_depths:set:${GATEWAY}:${DEVICE}:1` } }), runtime());
  assert.equal(applied.ack.result, 'APPLIED');
});
