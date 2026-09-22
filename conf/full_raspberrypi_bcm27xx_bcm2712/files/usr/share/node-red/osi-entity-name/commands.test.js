'use strict';
// Receiver tests for UPSERT_DEVICE_NAME and UPSERT_ZONE_NAME (design section
// 5.6 and the "Receiver" row of section 10). The database is the real
// seed-blank.sql schema, so applied_commands, command_ack_outbox and the two
// outbox triggers behave exactly as they do on a gateway.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const commands = require('./commands');
const ledger = require('../osi-command-ledger');
const scopeHelper = require('../osi-scope-helper');

const repo = path.resolve(__dirname, '../../../../../../..');
const SEED = fs.readFileSync(path.join(repo, 'database/seed-blank.sql'), 'utf8');

const GATEWAY = '0011223344556677';
const OTHER_GATEWAY = '0011223344556688';
const DEVICE = 'AABBCCDDEEFF0011';
const ZONE_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const VIEWER = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-09-21T09:00:00.000Z';

function fixture(t) {
  const raw = new DatabaseSync(':memory:');
  t.after(() => raw.close());
  raw.exec(SEED);
  raw.prepare(
    'INSERT INTO users(id,username,password_hash,created_at,updated_at,user_uuid,role) ' +
    "VALUES(1,'grower','hash',?,?,?,'admin')"
  ).run(NOW, NOW, OWNER);
  raw.prepare(
    'INSERT INTO users(id,username,password_hash,created_at,updated_at,user_uuid,role) ' +
    "VALUES(2,'stranger','hash',?,?,?,'admin')"
  ).run(NOW, NOW, STRANGER);
  raw.prepare(
    'INSERT INTO users(id,username,password_hash,created_at,updated_at,user_uuid,role) ' +
    "VALUES(3,'reader','hash',?,?,?,'viewer')"
  ).run(NOW, NOW, VIEWER);
  raw.prepare(
    'INSERT INTO sync_link_state(peer_node,linked,gateway_device_eui,updated_at) ' +
    "VALUES('cloud',1,?,?)"
  ).run(GATEWAY, NOW);
  raw.prepare(
    'INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,gateway_device_eui,sync_version,created_at,updated_at) ' +
    'VALUES(1,?,1,?,?,3,?,?)'
  ).run('Old zone', ZONE_UUID, GATEWAY, NOW, NOW);
  raw.prepare(
    'INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,gateway_device_eui,sync_version,created_at,updated_at) ' +
    "VALUES(?,?,'DRAGINO_LSN50',1,1,?,5,?,?)"
  ).run(DEVICE, 'Old device', GATEWAY, NOW, NOW);
  // The viewer is granted the zone so the scoped-mode test isolates canMutate
  // from the access assertion.
  raw.prepare(
    'INSERT INTO user_zone_assignments(assignment_uuid,user_uuid,zone_uuid,created_at,updated_at,sync_version) ' +
    'VALUES(?,?,?,?,?,1)'
  ).run('55555555-5555-4555-8555-555555555555', VIEWER, ZONE_UUID, NOW, NOW);
  raw.exec('DELETE FROM sync_outbox');

  const scope = {
    get: async (sql, params = []) => raw.prepare(sql).get(...params),
    all: async (sql, params = []) => raw.prepare(sql).all(...params),
    run: async (sql, params = []) => { raw.prepare(sql).run(...params); },
    exec: async (sql) => { raw.exec(sql); },
  };
  const db = Object.assign({}, scope, {
    transaction: async (executor) => {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const value = await executor(scope);
        raw.exec('COMMIT');
        return value;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  });
  return { raw, db };
}

function deviceCommand(id, overrides = {}) {
  return {
    commandId: id,
    commandType: 'UPSERT_DEVICE_NAME',
    payload: Object.assign({
      command_type: 'UPSERT_DEVICE_NAME',
      command_id: '11111111-1111-4111-8111-' + String(id).padStart(12, '0'),
      gateway_device_eui: GATEWAY,
      device_eui: DEVICE,
      actor_user_uuid: OWNER,
      requested_at: '2026-09-21T10:00:00.000Z',
      values: { name: 'Probe 7' },
    }, overrides),
  };
}

function zoneCommand(id, overrides = {}) {
  return {
    commandId: id,
    commandType: 'UPSERT_ZONE_NAME',
    payload: Object.assign({
      command_type: 'UPSERT_ZONE_NAME',
      command_id: '11111111-1111-4111-8111-' + String(id).padStart(12, '0'),
      gateway_device_eui: GATEWAY,
      zone_uuid: ZONE_UUID,
      actor_user_uuid: OWNER,
      requested_at: '2026-09-21T10:00:00.000Z',
      values: { name: 'North block' },
    }, overrides),
  };
}

// Scoped mode is a runtime flag, never process.env, so these tests behave the
// same whether or not the developer has OSI_SCOPED_ACCESS set.
function runtime(options = {}) {
  return Object.assign({
    gateway_device_eui: GATEWAY,
    scopedMode: false,
    command_type_recognized: true,
  }, options);
}

test('another command type is not handled', async (t) => {
  const { db } = fixture(t);
  assert.deepEqual(
    await commands.applyNameCommand(db, { commandId: 1, commandType: 'REBOOT', payload: {} }, runtime()),
    { handled: false }
  );
});

test('a device rename applies, acknowledges and enqueues one event', async (t) => {
  const { raw, db } = fixture(t);
  const result = await commands.applyNameCommand(db, deviceCommand(1), runtime());
  assert.equal(result.handled, true);
  assert.deepEqual(
    {
      commandId: result.ack.commandId,
      commandType: result.ack.commandType,
      effectKey: result.ack.effectKey,
      gatewayDeviceEui: result.ack.gatewayDeviceEui,
      status: result.ack.status,
      result: result.ack.result,
      reason: result.ack.reason,
      duplicate: result.ack.duplicate,
      appliedSyncVersion: result.ack.appliedSyncVersion,
      target: result.ack.target,
      requestedAt: result.ack.requestedAt,
    },
    {
      commandId: 1,
      commandType: 'UPSERT_DEVICE_NAME',
      effectKey: null,
      gatewayDeviceEui: GATEWAY,
      status: 'ACKED',
      result: 'APPLIED',
      reason: null,
      duplicate: false,
      appliedSyncVersion: 6,
      target: DEVICE,
      requestedAt: '2026-09-21T10:00:00.000Z',
    }
  );
  assert.equal(raw.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE).name, 'Probe 7');
  assert.equal(raw.prepare('SELECT command_id FROM applied_commands').get().command_id, '1');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox').get().n, 1);
  const events = raw.prepare('SELECT op, payload_json FROM sync_outbox').all();
  assert.equal(events.length, 1);
  assert.equal(events[0].op, 'DEVICE_FLAGS_UPDATED');
  assert.equal(JSON.parse(events[0].payload_json).name, 'Probe 7');
});

test('a zone rename applies, acknowledges and enqueues one event', async (t) => {
  const { raw, db } = fixture(t);
  const result = await commands.applyNameCommand(db, zoneCommand(2), runtime());
  assert.equal(result.ack.result, 'APPLIED');
  assert.equal(result.ack.target, ZONE_UUID);
  assert.equal(result.ack.appliedSyncVersion, 4);
  assert.equal(raw.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'North block');
  const events = raw.prepare('SELECT op FROM sync_outbox').all();
  assert.deepEqual(events.map((event) => event.op), ['ZONE_UPSERTED']);
});

test('a replayed envelope id returns the stored ack and re-queues it once', async (t) => {
  const { raw, db } = fixture(t);
  const first = await commands.applyNameCommand(db, deviceCommand(3), runtime());
  raw.prepare('UPDATE command_ack_outbox SET delivered_at=?').run(NOW);
  const replay = await commands.applyNameCommand(db, deviceCommand(3), runtime());
  assert.deepEqual(replay.ack, first.ack);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, 1);
  assert.equal(
    raw.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE delivered_at IS NULL').get().n,
    1
  );
  assert.equal(raw.prepare('SELECT sync_version FROM devices WHERE deveui=?').get(DEVICE).sync_version, 6);
});

test('an unchanged name still acknowledges APPLIED and writes no event', async (t) => {
  const { raw, db } = fixture(t);
  const result = await commands.applyNameCommand(
    db,
    deviceCommand(4, { values: { name: 'Old device' } }),
    runtime()
  );
  assert.equal(result.ack.result, 'APPLIED');
  assert.equal(result.ack.appliedSyncVersion, 5);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, 0);
});

test('a malformed payload is rejected permanently', async (t) => {
  const { raw, db } = fixture(t);
  const cases = [
    deviceCommand(10, { command_type: 'UPSERT_ZONE_NAME' }),
    deviceCommand(11, { command_id: 'not-a-uuid' }),
    deviceCommand(12, { actor_user_uuid: 'nope' }),
    deviceCommand(13, { requested_at: '2026-09-21T10:00:00Z' }),
    deviceCommand(14, { device_eui: 'aabb' }),
    deviceCommand(15, { values: { name: 42 } }),
    deviceCommand(16, { values: {} }),
    zoneCommand(17, { zone_uuid: 'nope' }),
  ];
  for (const envelope of cases) {
    const result = await commands.applyNameCommand(db, envelope, runtime());
    assert.equal(result.ack.result, 'REJECTED_PERMANENT', JSON.stringify(result.ack));
    assert.equal(result.ack.status, 'NACKED');
    assert.equal(result.ack.reason, 'malformed_command');
    assert.equal(result.ack.appliedSyncVersion, null);
  }
  assert.equal(raw.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE).name, 'Old device');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, 0);
});

test('a name that breaks the rule is rejected with its own reason code', async (t) => {
  const { raw, db } = fixture(t);
  const cases = [
    [20, '', 'name_empty'],
    [21, 'a'.repeat(101), 'name_too_long'],
    [22, 'Row\t7', 'name_control_characters'],
    [23, '\ud83c', 'name_invalid_unicode'],
  ];
  for (const [id, name, reason] of cases) {
    const result = await commands.applyNameCommand(db, deviceCommand(id, { values: { name } }), runtime());
    assert.equal(result.ack.result, 'REJECTED_PERMANENT');
    assert.equal(result.ack.reason, reason);
  }
  assert.equal(raw.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE).name, 'Old device');
});

test('a name with surrounding whitespace is stored trimmed', async (t) => {
  const { raw, db } = fixture(t);
  const result = await commands.applyNameCommand(
    db,
    deviceCommand(24, { values: { name: '\u00a0Probe 7\u00a0' } }),
    runtime()
  );
  assert.equal(result.ack.result, 'APPLIED');
  assert.equal(raw.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE).name, 'Probe 7');
});

test('a command addressed to another gateway is rejected', async (t) => {
  const { db } = fixture(t);
  const result = await commands.applyNameCommand(
    db,
    deviceCommand(30, { gateway_device_eui: OTHER_GATEWAY }),
    runtime()
  );
  assert.equal(result.ack.result, 'REJECTED_PERMANENT');
  assert.equal(result.ack.reason, 'gateway_mismatch');
});

test('a row bound to another gateway is rejected', async (t) => {
  const { raw, db } = fixture(t);
  raw.prepare('UPDATE devices SET gateway_device_eui=? WHERE deveui=?').run(OTHER_GATEWAY, DEVICE);
  raw.prepare('UPDATE irrigation_zones SET gateway_device_eui=? WHERE id=1').run(OTHER_GATEWAY);
  raw.exec('DELETE FROM sync_outbox');
  const device = await commands.applyNameCommand(db, deviceCommand(31), runtime());
  const zone = await commands.applyNameCommand(db, zoneCommand(32), runtime());
  assert.equal(device.ack.reason, 'gateway_mismatch');
  assert.equal(zone.ack.reason, 'gateway_mismatch');
});

test('an unknown or deleted target is rejected as not_found', async (t) => {
  const { raw, db } = fixture(t);
  const unknownDevice = await commands.applyNameCommand(
    db, deviceCommand(33, { device_eui: 'AABBCCDDEEFF9999' }), runtime()
  );
  const unknownZone = await commands.applyNameCommand(
    db, zoneCommand(34, { zone_uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }), runtime()
  );
  assert.equal(unknownDevice.ack.reason, 'not_found');
  assert.equal(unknownZone.ack.reason, 'not_found');
  raw.prepare('UPDATE devices SET deleted_at=? WHERE deveui=?').run(NOW, DEVICE);
  const deleted = await commands.applyNameCommand(db, deviceCommand(35), runtime());
  assert.equal(deleted.ack.reason, 'not_found');
});

test('a disabled or missing actor is rejected', async (t) => {
  const { raw, db } = fixture(t);
  const missing = await commands.applyNameCommand(
    db, deviceCommand(36, { actor_user_uuid: '66666666-6666-4666-8666-666666666666' }), runtime()
  );
  assert.equal(missing.ack.reason, 'actor_missing_or_disabled');
  raw.prepare('UPDATE users SET disabled_at=? WHERE user_uuid=?').run(NOW, OWNER);
  const disabled = await commands.applyNameCommand(db, deviceCommand(37), runtime());
  assert.equal(disabled.ack.reason, 'actor_missing_or_disabled');
});

test('with scoped access off, a non-owner and an unclaimed device are refused', async (t) => {
  const { raw, db } = fixture(t);
  const stranger = await commands.applyNameCommand(
    db, deviceCommand(40, { actor_user_uuid: STRANGER }), runtime()
  );
  assert.equal(stranger.ack.reason, 'forbidden');
  const strangerZone = await commands.applyNameCommand(
    db, zoneCommand(41, { actor_user_uuid: STRANGER }), runtime()
  );
  assert.equal(strangerZone.ack.reason, 'forbidden');
  raw.prepare('UPDATE devices SET user_id=NULL WHERE deveui=?').run(DEVICE);
  raw.exec('DELETE FROM sync_outbox');
  const unclaimed = await commands.applyNameCommand(db, deviceCommand(42), runtime());
  assert.equal(unclaimed.ack.reason, 'forbidden');
  assert.equal(raw.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE).name, 'Old device');
});

test('with scoped access on, an actor without access is refused and the owner is not', async (t) => {
  const { raw, db } = fixture(t);
  const forged = await commands.applyNameCommand(
    db, deviceCommand(43, { actor_user_uuid: STRANGER }), runtime({ scopedMode: true })
  );
  assert.equal(forged.ack.reason, 'forbidden');
  const forgedZone = await commands.applyNameCommand(
    db, zoneCommand(44, { actor_user_uuid: STRANGER }), runtime({ scopedMode: true })
  );
  assert.equal(forgedZone.ack.reason, 'forbidden');
  const owner = await commands.applyNameCommand(db, deviceCommand(45), runtime({ scopedMode: true }));
  assert.equal(owner.ack.result, 'APPLIED');
  assert.equal(raw.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE).name, 'Probe 7');
});

test('with scoped access on, a viewer who has the zone still cannot rename it', async (t) => {
  const { raw, db } = fixture(t);
  const result = await commands.applyNameCommand(
    db, zoneCommand(46, { actor_user_uuid: VIEWER }), runtime({ scopedMode: true })
  );
  assert.equal(result.ack.reason, 'forbidden');
  assert.equal(raw.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Old zone');
});

test('a scoped access database fault writes no terminal result and the command can retry', async (t) => {
  const { raw, db } = fixture(t);
  const original = scopeHelper.assertFreshDeviceAccess;
  let attempts = 0;
  scopeHelper.assertFreshDeviceAccess = async (...args) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error('database is locked');
      error.code = 'SQLITE_BUSY';
      throw error;
    }
    return original(...args);
  };
  t.after(() => { scopeHelper.assertFreshDeviceAccess = original; });

  await assert.rejects(
    commands.applyNameCommand(db, deviceCommand(47), runtime({ scopedMode: true })),
    (error) => error && error.code === 'SQLITE_BUSY'
  );
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox').get().n, 0);
  assert.equal(raw.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE).name, 'Old device');

  const retry = await commands.applyNameCommand(
    db, deviceCommand(47), runtime({ scopedMode: true })
  );
  assert.equal(retry.ack.result, 'APPLIED');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, 1);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox').get().n, 1);
});

test('two renames of one target apply in order', async (t) => {
  const { raw, db } = fixture(t);
  const first = await commands.applyNameCommand(
    db,
    deviceCommand(50, { requested_at: '2026-09-21T10:00:00.000Z', values: { name: 'Probe 7' } }),
    runtime()
  );
  const second = await commands.applyNameCommand(
    db,
    deviceCommand(51, { requested_at: '2026-09-21T10:05:00.000Z', values: { name: 'Probe 8' } }),
    runtime()
  );
  assert.equal(first.ack.result, 'APPLIED');
  assert.equal(second.ack.result, 'APPLIED');
  assert.equal(second.ack.appliedSyncVersion, 7);
  assert.equal(raw.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE).name, 'Probe 8');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, 2);
});

test('an older command that arrives after a newer one is rejected as superseded', async (t) => {
  const { raw, db } = fixture(t);
  const newer = await commands.applyNameCommand(
    db,
    deviceCommand(52, { requested_at: '2026-09-21T10:05:00.000Z', values: { name: 'Probe 8' } }),
    runtime()
  );
  assert.equal(newer.ack.result, 'APPLIED');
  const older = await commands.applyNameCommand(
    db,
    deviceCommand(53, { requested_at: '2026-09-21T10:00:00.000Z', values: { name: 'Probe 7' } }),
    runtime()
  );
  assert.equal(older.ack.result, 'REJECTED_PERMANENT');
  assert.equal(older.ack.reason, 'superseded');
  assert.equal(raw.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE).name, 'Probe 8');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, 1);
});

test('the fence is per target and per command type', async (t) => {
  const { raw, db } = fixture(t);
  await commands.applyNameCommand(
    db, deviceCommand(54, { requested_at: '2026-09-21T10:05:00.000Z' }), runtime()
  );
  // An older zone rename is untouched by a newer device rename.
  const zone = await commands.applyNameCommand(
    db, zoneCommand(55, { requested_at: '2026-09-21T10:00:00.000Z' }), runtime()
  );
  assert.equal(zone.ack.result, 'APPLIED');
  assert.equal(raw.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'North block');
});

test('a rejected command does not arm the fence', async (t) => {
  const { db } = fixture(t);
  const rejected = await commands.applyNameCommand(
    db,
    deviceCommand(56, { requested_at: '2026-09-21T10:05:00.000Z', values: { name: 'a'.repeat(101) } }),
    runtime()
  );
  assert.equal(rejected.ack.result, 'REJECTED_PERMANENT');
  const older = await commands.applyNameCommand(
    db, deviceCommand(57, { requested_at: '2026-09-21T10:00:00.000Z' }), runtime()
  );
  assert.equal(older.ack.result, 'APPLIED');
});

test('an invalid delivery envelope throws instead of acknowledging', async (t) => {
  const { db } = fixture(t);
  for (const commandId of [0, -1, 1.5, '1', null]) {
    await assert.rejects(
      () => commands.applyNameCommand(db, { commandId, commandType: 'UPSERT_DEVICE_NAME', payload: {} }, runtime()),
      /invalid protected delivery envelope/
    );
  }
});

test('the command ledger hands a name command without an effect_key to the receiver', async (t) => {
  const { db } = fixture(t);
  for (const envelope of [deviceCommand(60), zoneCommand(61)]) {
    assert.deepEqual(
      await ledger.deduplicatePendingCommand(db, envelope, {
        gateway_device_eui: GATEWAY,
        command_type_recognized: true,
      }),
      { handled: false },
      envelope.commandType + ' must reach the receiver, not be swallowed by the ledger'
    );
  }
});

test('the command ledger still catches an exact delivery replay before the receiver', async (t) => {
  const { db } = fixture(t);
  await commands.applyNameCommand(db, deviceCommand(62), runtime());
  const replay = await ledger.deduplicatePendingCommand(db, deviceCommand(62), {
    gateway_device_eui: GATEWAY,
    command_type_recognized: true,
  });
  assert.equal(replay.handled, true);
  assert.equal(replay.ack.commandId, 62);
  assert.equal(replay.ack.result, 'APPLIED');
});

// Fix round 1 / finding I1: TARGETS is a plain object literal, so a
// caller-supplied commandType equal to an inherited Object.prototype key
// (constructor, toString, __proto__, valueOf, hasOwnProperty) reads as
// truthy through TARGETS[type] even though it was never one of the two real
// command types. Each must be refused the same as any other unrecognized
// type, and must never reach the write path.
test('a command type inherited from Object.prototype is not handled', async (t) => {
  const { raw, db } = fixture(t);
  const dangerous = ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'];
  let id = 200;
  for (const commandType of dangerous) {
    const result = await commands.applyNameCommand(
      db, { commandId: id, commandType, payload: {} }, runtime()
    );
    assert.deepEqual(result, { handled: false }, commandType + ' must not be handled');
    id += 1;
  }
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox').get().n, 0);
});

// Fix round 1 / controller ruling T3-M6: a local misconfiguration (the
// runtime never supplied a valid gateway EUI) must not burn the delivery id.
// It must throw before the transaction opens, write nothing, and leave the
// command retryable once the runtime is fixed.
test('a missing or invalid runtime gateway EUI throws before any write, and a retry with a valid one applies', async (t) => {
  const { raw, db } = fixture(t);
  for (const badGateway of [undefined, '']) {
    await assert.rejects(
      () => commands.applyNameCommand(db, deviceCommand(70), runtime({ gateway_device_eui: badGateway })),
      (error) => error.code === 'invalid_entity_name_command'
    );
  }
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox').get().n, 0);
  const retry = await commands.applyNameCommand(db, deviceCommand(70), runtime());
  assert.equal(retry.ack.result, 'APPLIED');
});

// Final fix wave / controller ruling W1: only a cloud-created zone carries the
// hyphenated UUID. Every zone minted on the gateway -- by the seed trigger
// trg_sync_zones_defaults_ai (flag-off path) or by scoped-zone-create-router
// (flag-on path) -- carries 32 hex digits without dashes, so a receiver that
// demanded the hyphenated form would answer REJECTED_PERMANENT
// malformed_command for every locally created zone. osi-zone-commands' UUID2
// has accepted both spellings since the zone applier was ported.
test('W1: a zone_uuid minted by the real seed trigger is renamed, not rejected', async (t) => {
  const { raw, db } = fixture(t);
  raw.prepare(
    'INSERT INTO irrigation_zones(id,name,user_id,gateway_device_eui,created_at,updated_at) ' +
    'VALUES(2,?,1,?,?,?)'
  ).run('Trigger zone', GATEWAY, NOW, NOW);
  const minted = raw.prepare('SELECT zone_uuid FROM irrigation_zones WHERE id=2').get().zone_uuid;
  assert.match(minted, /^[0-9a-f]{32}$/, 'the seed trigger mints 32 hex digits without dashes');
  raw.exec('DELETE FROM sync_outbox');
  const result = await commands.applyNameCommand(db, zoneCommand(80, { zone_uuid: minted }), runtime());
  assert.equal(result.ack.result, 'APPLIED', JSON.stringify(result.ack));
  assert.equal(result.ack.target, minted);
  assert.equal(raw.prepare('SELECT name FROM irrigation_zones WHERE id=2').get().name, 'North block');
  const events = raw.prepare("SELECT op FROM sync_outbox WHERE aggregate_type='ZONE'").all();
  assert.deepEqual(events.map((event) => event.op), ['ZONE_UPSERTED']);
});

test('W1: the hyphenated cloud spelling still applies, in any case', async (t) => {
  const { raw, db } = fixture(t);
  const result = await commands.applyNameCommand(
    db, zoneCommand(81, { zone_uuid: ZONE_UUID.toUpperCase() }), runtime()
  );
  assert.equal(result.ack.result, 'APPLIED', JSON.stringify(result.ack));
  assert.equal(result.ack.target, ZONE_UUID);
  assert.equal(raw.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'North block');
});

test('W1: a zone_uuid in neither spelling is still malformed_command', async (t) => {
  const { raw, db } = fixture(t);
  let id = 82;
  for (const bad of ['a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32), 'not-a-uuid', '']) {
    const result = await commands.applyNameCommand(db, zoneCommand(id, { zone_uuid: bad }), runtime());
    assert.equal(result.ack.result, 'REJECTED_PERMANENT', JSON.stringify(result.ack));
    assert.equal(result.ack.reason, 'malformed_command', 'vector ' + JSON.stringify(bad));
    id += 1;
  }
  assert.equal(raw.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Old zone');
});

// Final fix wave / L94: spec 5.6 step 8 says a terminal rejection is recorded
// and acknowledged exactly like an application. Without this the receiver could
// drop a rejection on the floor and every other rejection test would still pass.
test('a REJECTED_PERMANENT outcome still writes one applied_commands row and one ack row', async (t) => {
  const { raw, db } = fixture(t);
  const result = await commands.applyNameCommand(
    db, deviceCommand(90, { values: { name: 'a'.repeat(101) } }), runtime()
  );
  assert.equal(result.ack.result, 'REJECTED_PERMANENT');
  const applied = raw.prepare('SELECT command_id, result, result_detail FROM applied_commands').all();
  assert.equal(applied.length, 1);
  assert.equal(applied[0].command_id, '90');
  assert.equal(applied[0].result, 'REJECTED_PERMANENT');
  assert.equal(JSON.parse(applied[0].result_detail).reason, 'name_too_long');
  const acks = raw.prepare('SELECT command_id, payload_json FROM command_ack_outbox WHERE delivered_at IS NULL').all();
  assert.equal(acks.length, 1);
  assert.equal(acks[0].command_id, '90');
  assert.equal(JSON.parse(acks[0].payload_json).status, 'NACKED');
});

test('a command of another type is not handled and never inspects the runtime gateway EUI', async (t) => {
  const { db } = fixture(t);
  const result = await commands.applyNameCommand(
    db,
    { commandId: 1, commandType: 'REBOOT', payload: {} },
    { command_type_recognized: true }
  );
  assert.deepEqual(result, { handled: false });
});
