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
const calibration = require('./calibration');
const bindingCanonicalization = require('../osi-watermark-binding/canonicalization');

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
const PAYLOAD_HEX = 'a2030ce407c408620220032003200cdb0cdb20004700470fda0fda';

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
  return Object.assign({ gateway_device_eui: GATEWAY, scopedMode: true, command_type_recognized: true,
    capabilities: ['watermark_v1', 'chameleon_config_commands_v1', 'device_soil_depth_commands_v1'] }, extra);
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

function seedWaiting(raw, count) {
  const data = raw.prepare('INSERT INTO device_data(deveui,recorded_at) VALUES(?,?)');
  const reading = raw.prepare(
    "INSERT INTO watermark_readings(deveui,recorded_at,device_data_id,payload_hex,frame_status,profile,supply_mv,ch1_status,ch2_status,conversion_version) VALUES(?,?,?,?,?,?,?,?,?,?)"
  );
  for (let index = 0; index < count; index += 1) {
    const recordedAt = new Date(Date.UTC(2026, 8, 1, 0, index, 0)).toISOString();
    const deviceData = data.run(DEVICE, recordedAt);
    reading.run(DEVICE, recordedAt, Number(deviceData.lastInsertRowid), PAYLOAD_HEX, 'accepted', 3, 3300,
      'calibration_required', 'calibration_required', 'wm-lsn50-p3-v1');
  }
}

async function seedCalibration(state) {
  await calibration.saveCalibration(state.db, {
    deveui: DEVICE,
    userId: 1,
    scoped: true,
    body: Object.assign({}, CAL, { expected_sync_version: 0 }),
  });
}

test('all four protected operation names are handled', async (t) => {
  const { db } = fixture(t);
  for (const type of ['SET_WATERMARK_CALIBRATION', 'DELETE_WATERMARK_CALIBRATION', 'SET_CHAMELEON_CONFIG', 'UPSERT_DEVICE_SOIL_DEPTHS']) {
    assert.equal(typeof commands.applyWatermarkCommand, 'function');
    assert.equal(commands.COMMAND_TYPES.includes(type), true);
  }
});

test('each protected operation executes its authorization decision independently', async (t) => {
  const cases = [
    ['SET_WATERMARK_CALIBRATION', CAL, `watermark_calibration:set:${GATEWAY}:${DEVICE}:0`],
    ['DELETE_WATERMARK_CALIBRATION', undefined, `watermark_calibration:delete:${GATEWAY}:${DEVICE}:0`],
    ['SET_CHAMELEON_CONFIG', { chameleon_enabled: true }, `chameleon_config:set:${GATEWAY}:${DEVICE}:0`],
    ['UPSERT_DEVICE_SOIL_DEPTHS', {
      soil_moisture_probe_depths_json: { swt_1: 20 },
      soil_moisture_probe_depths_configured: true,
    }, `device_soil_depths:set:${GATEWAY}:${DEVICE}:0`],
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const [type, values, effect] = cases[index];
    const { raw, db } = fixture(t);
    const result = await commands.applyWatermarkCommand(db, envelope(60 + index, type, values, {
      payload: {
        actor_user_uuid: VIEWER,
        effect_key: effect,
      },
    }), runtime());
    assert.equal(result.ack.result, 'REJECTED_PERMANENT', type);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, 1, type);
  }
});

test('valid calibration set uses exact base and terminal ACK atomically', async (t) => {
  const { raw, db } = fixture(t);
  const result = await commands.applyWatermarkCommand(db, envelope(1, 'SET_WATERMARK_CALIBRATION', CAL), runtime());
  assert.equal(result.ack.result, 'APPLIED');
  assert.equal(raw.prepare('SELECT sync_version FROM watermark_calibrations WHERE deveui=?').get(DEVICE).sync_version, 1);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, 1);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox').get().n, 1);
  const conflict = await commands.applyWatermarkCommand(
    db, envelope(1, 'SET_WATERMARK_CALIBRATION', CAL), runtime({ local_actor_user_uuid: WRITER })
  );
  assert.equal(conflict.ack.result, 'CONFLICT');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, 1);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox').get().n, 1);
});

test('semantic values are normalized before binding and malformed input is terminal', async (t) => {
  const { raw, db } = fixture(t);
  const normalized = await commands.applyWatermarkCommand(db, envelope(7, 'SET_CHAMELEON_CONFIG', {
    chameleon_enabled: true,
  }, { payload: { base_sync_version: 1, effect_key: `chameleon_config:set:${GATEWAY}:${DEVICE}:1` } }), runtime());
  assert.equal(normalized.ack.result, 'APPLIED');
  const row = raw.prepare('SELECT * FROM applied_commands WHERE command_id=?').get('7');
  const intent = { chameleon_enabled: true };
  const binding = {
    command_type: 'SET_CHAMELEON_CONFIG', resource: 'DEVICE', device_eui: DEVICE,
    gateway_device_eui: GATEWAY, actor_user_uuid: OWNER, base_sync_version: 1,
    operation: 'set', normalized_intent: intent,
  };
  assert.equal(row.intent_hash, bindingCanonicalization.sha256(intent));
  assert.equal(row.binding_hash, bindingCanonicalization.sha256(binding));

  for (const [id, type, values, effect] of [
    [8, 'SET_WATERMARK_CALIBRATION', Object.assign({}, CAL, { measured_at: 'yesterday-ish' }), `watermark_calibration:set:${GATEWAY}:${DEVICE}:0`],
    [9, 'SET_WATERMARK_CALIBRATION', Object.assign({}, CAL, { pullup_1_ohm: 'not-a-number' }), `watermark_calibration:set:${GATEWAY}:${DEVICE}:0`],
    [10, 'SET_CHAMELEON_CONFIG', { chameleon_enabled: 'maybe' }, `chameleon_config:set:${GATEWAY}:${DEVICE}:0`],
    [11, 'UPSERT_DEVICE_SOIL_DEPTHS', { soil_moisture_probe_depths_json: { swt_1: '20' }, soil_moisture_probe_depths_configured: true }, `device_soil_depths:set:${GATEWAY}:${DEVICE}:0`],
    [15, 'UPSERT_DEVICE_SOIL_DEPTHS', { soil_moisture_probe_depths_json: {}, soil_moisture_probe_depths_configured: false }, `device_soil_depths:set:${GATEWAY}:${DEVICE}:0`],
  ]) {
    const result = await commands.applyWatermarkCommand(db, envelope(id, type, values, { payload: { effect_key: effect } }), runtime());
    assert.equal(result.ack.result, 'REJECTED_PERMANENT', type);
    assert.equal(result.ack.reason, type === 'SET_CHAMELEON_CONFIG' || type === 'UPSERT_DEVICE_SOIL_DEPTHS' ? 'invalid_values' : 'invalid_calibration');
  }
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, 6, 'malformed commands receive durable terminal decisions');
});

test('cloud calibration command commits first 500 atomically and continues later batches', async (t) => {
  const { raw, db } = fixture(t);
  seedWaiting(raw, 1201);
  const result = await commands.applyWatermarkCommand(db, envelope(12, 'SET_WATERMARK_CALIBRATION', CAL), runtime());
  assert.equal(result.ack.result, 'APPLIED');
  assert.equal(result.backfilled, 1201);
  assert.equal(raw.prepare('SELECT sync_version FROM watermark_calibrations WHERE deveui=?').get(DEVICE).sync_version, 1);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM watermark_readings WHERE ch1_status='calibration_required' OR ch2_status='calibration_required'").get().n, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, 1);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox').get().n, 1);
});

test('cloud command later-batch failure retains calibration and reports incomplete backfill', async (t) => {
  const { raw, db } = fixture(t);
  seedWaiting(raw, 1201);
  let transactions = 0;
  const flaky = Object.assign({}, db, {
    transaction: async (fn) => {
      transactions += 1;
      if (transactions === 3) throw new Error('disk I/O error');
      return db.transaction(fn);
    },
  });
  const result = await commands.applyWatermarkCommand(flaky, envelope(13, 'SET_WATERMARK_CALIBRATION', CAL), runtime());
  assert.equal(result.ack.result, 'APPLIED');
  assert.equal(result.backfill_incomplete, true);
  assert.equal(result.backfilled, 1000);
  assert.equal(raw.prepare('SELECT sync_version FROM watermark_calibrations WHERE deveui=?').get(DEVICE).sync_version, 1);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM watermark_readings WHERE ch1_status='calibration_required'").get().n, 201);
});

test('mutation and ACK/outbox failures roll back the command transaction', async (t) => {
  const makeFailingDb = (mode) => {
    const state = fixture(t);
    const wrapped = Object.assign({}, state.db, {
      transaction: async (fn) => {
        state.raw.exec('BEGIN IMMEDIATE');
        const scope = Object.assign({}, state.db, {
          run: async (sql, params = []) => {
            if (mode === 'ack' && /command_ack_outbox/i.test(sql)) throw new Error('ack outbox unavailable');
            state.raw.prepare(sql).run(...params);
          },
          get: async (sql, params = []) => state.raw.prepare(sql).get(...params),
          all: async (sql, params = []) => state.raw.prepare(sql).all(...params),
          exec: async (sql) => state.raw.exec(sql),
        });
        try {
          const value = await fn(scope);
          if (mode === 'mutation') throw new Error('ledger unavailable');
          state.raw.exec('COMMIT');
          return value;
        } catch (cause) {
          state.raw.exec('ROLLBACK');
          throw cause;
        }
      },
    });
    return { state, wrapped };
  };
  for (const mode of ['mutation', 'ack']) {
    const { state, wrapped } = makeFailingDb(mode);
    await assert.rejects(commands.applyWatermarkCommand(wrapped, envelope(14 + mode.length, 'SET_CHAMELEON_CONFIG', {
      chameleon_enabled: true,
    }, { payload: { base_sync_version: 1, effect_key: `chameleon_config:set:${GATEWAY}:${DEVICE}:1` } }), runtime()));
    const row = state.raw.prepare('SELECT chameleon_enabled,sync_version FROM devices WHERE deveui=?').get(DEVICE);
    assert.deepEqual({ chameleon_enabled: row.chameleon_enabled, sync_version: row.sync_version }, { chameleon_enabled: 0, sync_version: 1 }, mode);
    assert.equal(state.raw.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, 0, mode);
    assert.equal(state.raw.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox').get().n, 0, mode);
  }
});

test('calibration ACK failure rolls back the saved row and all first-batch conversions', async (t) => {
  const state = fixture(t);
  seedWaiting(state.raw, 500);
  const failing = Object.assign({}, state.db, {
    transaction: async (fn) => {
      state.raw.exec('BEGIN IMMEDIATE');
      const scope = Object.assign({}, state.db, {
        run: async (sql, params = []) => {
          if (/command_ack_outbox/i.test(sql)) throw new Error('ack outbox unavailable');
          state.raw.prepare(sql).run(...params);
        },
        get: async (sql, params = []) => state.raw.prepare(sql).get(...params),
        all: async (sql, params = []) => state.raw.prepare(sql).all(...params),
        exec: async (sql) => state.raw.exec(sql),
      });
      try {
        const value = await fn(scope);
        state.raw.exec('COMMIT');
        return value;
      } catch (cause) {
        state.raw.exec('ROLLBACK');
        throw cause;
      }
    },
  });
  await assert.rejects(commands.applyWatermarkCommand(failing, envelope(16, 'SET_WATERMARK_CALIBRATION', CAL), runtime()));
  assert.equal(state.raw.prepare('SELECT COUNT(*) AS n FROM watermark_calibrations').get().n, 0);
  assert.equal(state.raw.prepare("SELECT COUNT(*) AS n FROM watermark_readings WHERE ch1_status='calibration_required'").get().n, 500);
  assert.equal(state.raw.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, 0);
  assert.equal(state.raw.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox').get().n, 0);
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

test('foreign identity and missing device are classified before any local write', async (t) => {
  const foreign = fixture(t);
  const foreignResult = await commands.applyWatermarkCommand(foreign.db, envelope(27, 'SET_WATERMARK_CALIBRATION', CAL, {
    payload: {
      device_eui: OTHER_DEVICE,
      effect_key: `watermark_calibration:set:${GATEWAY}:${OTHER_DEVICE}:0`,
    },
  }), runtime());
  assert.equal(foreignResult.ack.result, 'CONFLICT');
  const missing = fixture(t);
  const result = await commands.applyWatermarkCommand(missing.db, envelope(28, 'SET_WATERMARK_CALIBRATION', CAL, {
    payload: {
      device_eui: 'AABBCCDDEEFF0033',
      effect_key: `watermark_calibration:set:${GATEWAY}:AABBCCDDEEFF0033:0`,
    },
  }), runtime());
  assert.equal(result.ack.result, 'REJECTED_PERMANENT');
  assert.equal(missing.raw.prepare('SELECT COUNT(*) AS n FROM watermark_calibrations').get().n, 0);
});

test('flag-off retains local owner path and rejects numeric cloud identity', async (t) => {
  const { db } = fixture(t);
  const result = await commands.applyWatermarkCommand(db, envelope(30, 'SET_WATERMARK_CALIBRATION', CAL), runtime({ scopedMode: false }));
  assert.equal(result.ack.result, 'APPLIED');
  const malformed = await commands.applyWatermarkCommand(
    db, envelope(31, 'SET_WATERMARK_CALIBRATION', CAL, { payload: { actor_user_uuid: '1' } }), runtime({ scopedMode: true })
  );
  assert.equal(malformed.ack.result, 'REJECTED_PERMANENT');
  assert.equal(malformed.ack.reason, 'malformed_command');
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

  const unsupported = fixture(t);
  const missingCapability = await commands.applyWatermarkCommand(unsupported.db, envelope(43, 'SET_CHAMELEON_CONFIG', { chameleon_enabled: true }, {
    payload: { base_sync_version: 1, effect_key: `chameleon_config:set:${GATEWAY}:${DEVICE}:1` }
  }), runtime({ capabilities: ['watermark_v1', 'device_soil_depth_commands_v1'] }));
  assert.equal(missingCapability.ack.result, 'REJECTED_PERMANENT');
});

test('assigned authorization validates zone existence, deletion, gateway, owner, and grant', async (t) => {
  const setup = (zone) => {
    const state = fixture(t);
    state.raw.prepare(
      'INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,gateway_device_eui,sync_version,deleted_at,created_at,updated_at) VALUES(1,?,?,?,?,1,?,?,?)'
    ).run('Block', zone.userId, zone.uuid, zone.gateway, zone.deletedAt, NOW, NOW);
    state.raw.prepare('UPDATE devices SET user_id=?, irrigation_zone_id=1, sync_version=1 WHERE deveui=?')
      .run(zone.deviceUserId || 1, DEVICE);
    return state;
  };
  const command = (state, id, actor, expected) => commands.applyWatermarkCommand(state.db, envelope(id, 'UPSERT_DEVICE_SOIL_DEPTHS', {
    soil_moisture_probe_depths_json: { swt_1: 20 }, soil_moisture_probe_depths_configured: true,
  }, { payload: {
    actor_user_uuid: actor, base_sync_version: 1,
    effect_key: `device_soil_depths:set:${GATEWAY}:${DEVICE}:1`,
  } }), runtime()).then((result) => assert.equal(result.ack.result, expected));

  await command(setup({ userId: 2, uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', gateway: GATEWAY, deletedAt: null }), 70, OWNER, 'REJECTED_PERMANENT');
  const deleted = setup({ userId: 2, uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', gateway: GATEWAY, deletedAt: NOW });
  await command(deleted, 71, OWNER, 'REJECTED_PERMANENT');
  const foreign = setup({ userId: 2, uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', gateway: OTHER_GATEWAY, deletedAt: null });
  await command(foreign, 72, OWNER, 'REJECTED_PERMANENT');
  const owner = setup({ userId: 2, uuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', gateway: GATEWAY, deletedAt: null });
  await command(owner, 73, WRITER, 'APPLIED');
  const granted = setup({ userId: 1, uuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', gateway: GATEWAY, deletedAt: null });
  granted.raw.prepare(
    'INSERT INTO user_zone_assignments(assignment_uuid,user_uuid,zone_uuid,created_at,updated_at,sync_version) VALUES(?,?,?,?,?,1)'
  ).run('66666666-6666-4666-8666-666666666666', WRITER, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', NOW, NOW);
  await command(granted, 74, WRITER, 'APPLIED');
});

test('every protected operation traverses the independent scoped denial matrix', async (t) => {
  const operations = [
    ['SET_WATERMARK_CALIBRATION', CAL],
    ['DELETE_WATERMARK_CALIBRATION', undefined],
    ['SET_CHAMELEON_CONFIG', { chameleon_enabled: true }],
    ['UPSERT_DEVICE_SOIL_DEPTHS', { soil_moisture_probe_depths_json: { swt_1: 20 }, soil_moisture_probe_depths_configured: true }],
  ];
  const scenarios = [
    { name: 'missing actor', actor: '99999999-9999-4999-8999-999999999999' },
    { name: 'viewer', actor: VIEWER },
    { name: 'disabled account', actor: WRITER, prepare: (s) => s.raw.prepare('UPDATE users SET disabled_at=? WHERE user_uuid=?').run(NOW, WRITER) },
    { name: 'missing capability', actor: OWNER, runtime: () => runtime({ capabilities: [] }) },
    { name: 'wrong device type', actor: OWNER, prepare: (s) => s.raw.prepare('UPDATE devices SET type_id=? WHERE deveui=?').run('DRAGINO_SDI12', DEVICE) },
    { name: 'dangling assignment', actor: OWNER, prepare: (s) => {
      s.raw.exec('PRAGMA foreign_keys=OFF');
      s.raw.prepare('UPDATE devices SET irrigation_zone_id=999 WHERE deveui=?').run(DEVICE);
      s.raw.exec('PRAGMA foreign_keys=ON');
    } },
    {
      name: 'deleted assignment', actor: OWNER, prepare: (s) => {
        s.raw.prepare('INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,gateway_device_eui,sync_version,deleted_at,created_at,updated_at) VALUES(1,?,?,?,?,1,?,?,?)').run('Deleted', 2, '11111111-1111-4111-8111-111111111111', GATEWAY, NOW, NOW, NOW);
        s.raw.prepare('UPDATE devices SET irrigation_zone_id=1 WHERE deveui=?').run(DEVICE);
      },
    },
    {
      name: 'foreign assignment', actor: OWNER, prepare: (s) => {
        s.raw.prepare('INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,gateway_device_eui,sync_version,created_at,updated_at) VALUES(1,?,?,?,?,1,?,?)').run('Foreign', 2, '22222222-2222-4222-8222-222222222223', OTHER_GATEWAY, NOW, NOW);
        s.raw.prepare('UPDATE devices SET irrigation_zone_id=1 WHERE deveui=?').run(DEVICE);
      },
    },
    {
      name: 'assigned admin without grant', actor: OWNER, prepare: (s) => {
        s.raw.prepare('INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,gateway_device_eui,sync_version,created_at,updated_at) VALUES(1,?,?,?,?,1,?,?)').run('Owned elsewhere', 2, '33333333-3333-4333-8333-333333333334', GATEWAY, NOW, NOW);
        s.raw.prepare('UPDATE devices SET irrigation_zone_id=1 WHERE deveui=?').run(DEVICE);
      },
    },
    { name: 'unassigned researcher', actor: WRITER },
  ];
  let id = 100;
  for (const scenario of scenarios) {
    for (const [type, values] of operations) {
      const state = fixture(t);
      if (scenario.prepare) scenario.prepare(state);
      const operationRuntime = scenario.runtime ? scenario.runtime() : runtime();
      const deviceBase = state.raw.prepare('SELECT sync_version FROM devices WHERE deveui=?').get(DEVICE).sync_version;
      const result = await commands.applyWatermarkCommand(state.db, envelope(id++, type, values, {
        payload: {
          actor_user_uuid: scenario.actor,
          base_sync_version: deviceBase,
          effect_key: commands.expectedEffect(type, GATEWAY, DEVICE, deviceBase),
        },
      }), operationRuntime);
      assert.equal(result.ack.result, 'REJECTED_PERMANENT', `${scenario.name}/${type}`);
    }
  }
});

test('DELETE auth uses the live calibration version, reports specific denials, and preserves state', async (t) => {
  const scenarios = [
    { name: 'missing actor', actor: '99999999-9999-4999-8999-999999999999', reason: 'actor_missing_or_disabled' },
    { name: 'viewer', actor: VIEWER, reason: 'forbidden' },
    { name: 'disabled account', actor: WRITER, reason: 'actor_missing_or_disabled', prepare: (s) => s.raw.prepare('UPDATE users SET disabled_at=? WHERE user_uuid=?').run(NOW, WRITER) },
    { name: 'missing capability', actor: OWNER, reason: 'capability_missing', runtime: () => runtime({ capabilities: [] }) },
    { name: 'wrong type', actor: OWNER, reason: 'unsupported_device_type', prepare: (s) => s.raw.prepare('UPDATE devices SET type_id=? WHERE deveui=?').run('KIWI_SENSOR', DEVICE) },
    { name: 'dangling assignment', actor: OWNER, reason: 'device_not_found', prepare: (s) => {
      s.raw.exec('PRAGMA foreign_keys=OFF');
      s.raw.prepare('UPDATE devices SET irrigation_zone_id=999 WHERE deveui=?').run(DEVICE);
      s.raw.exec('PRAGMA foreign_keys=ON');
    } },
    { name: 'deleted assignment', actor: OWNER, reason: 'device_not_found', prepare: (s) => {
      s.raw.prepare('INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,gateway_device_eui,sync_version,deleted_at,created_at,updated_at) VALUES(1,?,?,?,?,1,?,?,?)').run('Deleted zone', 2, '55555555-5555-4555-8555-555555555556', GATEWAY, NOW, NOW, NOW);
      s.raw.prepare('UPDATE devices SET irrigation_zone_id=1 WHERE deveui=?').run(DEVICE);
    } },
    { name: 'foreign assignment', actor: OWNER, reason: 'device_not_found', prepare: (s) => {
      s.raw.prepare('INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,gateway_device_eui,sync_version,created_at,updated_at) VALUES(1,?,?,?,?,1,?,?)').run('Foreign zone', 2, '66666666-6666-4666-8666-666666666667', OTHER_GATEWAY, NOW, NOW);
      s.raw.prepare('UPDATE devices SET irrigation_zone_id=1 WHERE deveui=?').run(DEVICE);
    } },
    { name: 'assigned admin without grant', actor: OWNER, reason: 'forbidden', prepare: (s) => {
      s.raw.prepare('INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,gateway_device_eui,sync_version,created_at,updated_at) VALUES(1,?,?,?,?,1,?,?)').run('Other zone', 2, '44444444-4444-4444-8444-444444444445', GATEWAY, NOW, NOW);
      s.raw.prepare('UPDATE devices SET irrigation_zone_id=1 WHERE deveui=?').run(DEVICE);
    } },
    { name: 'unassigned researcher', actor: WRITER, reason: 'forbidden' },
  ];
  let id = 180;
  for (const scenario of scenarios) {
    const state = fixture(t);
    await seedCalibration(state);
    if (scenario.prepare) scenario.prepare(state);
    const calibrationVersion = state.raw.prepare('SELECT sync_version FROM watermark_calibrations WHERE deveui=?').get(DEVICE).sync_version;
    const result = await commands.applyWatermarkCommand(state.db, envelope(id++, 'DELETE_WATERMARK_CALIBRATION', undefined, {
      payload: {
        actor_user_uuid: scenario.actor,
        base_sync_version: calibrationVersion,
        effect_key: `watermark_calibration:delete:${GATEWAY}:${DEVICE}:${calibrationVersion}`,
      },
    }), scenario.runtime ? scenario.runtime() : runtime());
    assert.equal(result.ack.result, 'REJECTED_PERMANENT', scenario.name);
    assert.equal(result.ack.reason, scenario.reason, scenario.name);
    const row = state.raw.prepare('SELECT sync_version,deleted_at FROM watermark_calibrations WHERE deveui=?').get(DEVICE);
    assert.equal(row.sync_version, calibrationVersion, scenario.name);
    assert.equal(row.deleted_at, null, scenario.name);
  }

  const authorized = fixture(t);
  await seedCalibration(authorized);
  const version = authorized.raw.prepare('SELECT sync_version FROM watermark_calibrations WHERE deveui=?').get(DEVICE).sync_version;
  const deleted = await commands.applyWatermarkCommand(authorized.db, envelope(id, 'DELETE_WATERMARK_CALIBRATION', undefined, {
    payload: {
      base_sync_version: version,
      effect_key: `watermark_calibration:delete:${GATEWAY}:${DEVICE}:${version}`,
    },
  }), runtime());
  assert.equal(deleted.ack.result, 'APPLIED');
  const tombstone = authorized.raw.prepare('SELECT sync_version,deleted_at FROM watermark_calibrations WHERE deveui=?').get(DEVICE);
  assert.equal(tombstone.sync_version, version + 1);
  assert.ok(tombstone.deleted_at);
});

test('device type gates admit only the approved WATERMARK families', async (t) => {
  const chameleon = fixture(t);
  chameleon.raw.prepare('UPDATE devices SET type_id=? WHERE deveui=?').run('KIWI_SENSOR', DEVICE);
  const chameleonResult = await commands.applyWatermarkCommand(chameleon.db, envelope(80, 'SET_CHAMELEON_CONFIG', {
    chameleon_enabled: true,
  }, { payload: { effect_key: `chameleon_config:set:${GATEWAY}:${DEVICE}:0` } }), runtime());
  assert.equal(chameleonResult.ack.result, 'REJECTED_PERMANENT');

  const depth = fixture(t);
  depth.raw.prepare('UPDATE devices SET type_id=? WHERE deveui=?').run('DRAGINO_SDI12', DEVICE);
  const depthResult = await commands.applyWatermarkCommand(depth.db, envelope(81, 'UPSERT_DEVICE_SOIL_DEPTHS', {
    soil_moisture_probe_depths_json: { swt_1: 20 }, soil_moisture_probe_depths_configured: true,
  }, { payload: { effect_key: `device_soil_depths:set:${GATEWAY}:${DEVICE}:0` } }), runtime());
  assert.equal(depthResult.ack.result, 'REJECTED_PERMANENT');
});
