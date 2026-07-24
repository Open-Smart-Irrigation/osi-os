'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const commands = require('./index');

const repoRoot = path.resolve(__dirname, '../../../../../../..');
const seedSql = fs.readFileSync(
  path.join(repoRoot, 'database/seed-blank.sql'),
  'utf8'
);
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'osi-device-command-test-')
);
const GATEWAY_EUI = '0016C001F11715E2';
const WRONG_EUI = 'FFFFFFFFFFFFFFFF';
const DEVICE_EUI = '0123456789ABCDEF';
const OWNER_UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER_UUID = '22222222-2222-4222-8222-222222222222';
const ZONE_UUID = '33333333-3333-4333-8333-333333333333';
const COMMAND_UUID = '44444444-4444-4444-8444-444444444444';

let databaseCounter = 0;
const openDatabases = [];

test.after(() => {
  for (const db of openDatabases) db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

class TestDb {
  constructor() {
    databaseCounter += 1;
    this.native = new DatabaseSync(
      path.join(tempRoot, `db-${databaseCounter}.db`)
    );
    this.native.exec(seedSql);
    this.failSql = null;
    openDatabases.push(this);
  }

  get(sql, params) {
    return Promise.resolve(this.native.prepare(sql).get(...(params || [])));
  }

  all(sql, params) {
    return Promise.resolve(this.native.prepare(sql).all(...(params || [])));
  }

  run(sql, params) {
    if (this.failSql && String(sql).includes(this.failSql)) {
      throw new Error('injected write failure');
    }
    return Promise.resolve(this.native.prepare(sql).run(...(params || [])));
  }

  async transaction(executor) {
    this.native.exec('BEGIN IMMEDIATE');
    try {
      const result = await executor(this);
      this.native.exec('COMMIT');
      return result;
    } catch (error) {
      this.native.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.native.close();
  }
}

function setup(type = 'DRAGINO_LSN50') {
  const db = new TestDb();
  const now = '2026-07-24T00:00:00.000Z';
  for (const [username, uuid, disabledAt] of [
    ['grower', OWNER_UUID, null],
    ['disabled', OTHER_OWNER_UUID, now],
  ]) {
    db.native.prepare(`
      INSERT INTO users (
        username, password_hash, created_at, updated_at, user_uuid, disabled_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(username, 'not-a-real-hash', now, now, uuid, disabledAt);
  }
  db.native.prepare(`
    INSERT INTO irrigation_zones (
      name, user_id, zone_uuid, gateway_device_eui, sync_version,
      created_at, updated_at
    ) VALUES (
      'North',
      (SELECT id FROM users WHERE user_uuid = ?),
      ?, ?, 1, ?, ?
    )
  `).run(OWNER_UUID, ZONE_UUID, GATEWAY_EUI, now, now);
  db.native.prepare(`
    INSERT INTO devices (
      deveui, name, type_id, user_id, current_state, target_state,
      created_at, updated_at, sync_version, gateway_device_eui,
      dendro_ratio_at_retracted, device_mode
    ) VALUES (
      ?, 'Original', ?, (SELECT id FROM users WHERE user_uuid = ?),
      'OPEN', 'CLOSED', ?, ?, 1, ?, 0.25, 4
    )
  `).run(DEVICE_EUI, type, OWNER_UUID, now, now, GATEWAY_EUI);
  db.native.prepare(`
    INSERT INTO sync_link_state (
      peer_node, linked, server_url, cloud_user_id,
      gateway_device_eui, updated_at
    ) VALUES ('cloud', 1, 'https://example.invalid', 41, ?, ?)
    ON CONFLICT(peer_node) DO UPDATE SET
      linked=excluded.linked,
      gateway_device_eui=excluded.gateway_device_eui,
      updated_at=excluded.updated_at
  `).run(GATEWAY_EUI, now);
  db.native.exec('DELETE FROM sync_outbox');
  return db;
}

function resource(type, target, overrides = {}) {
  return {
    contract_version: 1,
    device_eui: DEVICE_EUI,
    name: 'North sensor',
    type,
    claimed_user_uuid: OWNER_UUID,
    zone_uuid: ZONE_UUID,
    dendro_enabled: type === 'DRAGINO_LSN50' ? 1 : 0,
    temp_enabled: type === 'DRAGINO_LSN50' ? 1 : 0,
    rain_gauge_enabled: 0,
    flow_meter_enabled: 0,
    is_reference_tree: type === 'DRAGINO_LSN50' ? 1 : 0,
    chameleon_enabled: type === 'DRAGINO_LSN50' ? 1 : 0,
    soil_moisture_probe_depths_json:
      ['KIWI_SENSOR', 'TEKTELIC_CLOVER'].includes(type)
        ? { swt_1: 15, swt_2: 35 }
        : {},
    soil_moisture_probe_depths_configured:
      ['KIWI_SENSOR', 'TEKTELIC_CLOVER'].includes(type) ? 1 : 0,
    chameleon_swt1_depth_cm: type === 'DRAGINO_LSN50' ? 20 : null,
    chameleon_swt2_depth_cm: type === 'DRAGINO_LSN50' ? 40 : null,
    chameleon_swt3_depth_cm: null,
    strega_model: type === 'STREGA_VALVE' ? 'MOTORIZED' : null,
    gateway_device_eui: GATEWAY_EUI,
    sync_version: target,
    deleted_at: null,
    ...overrides,
  };
}

function envelope(type, deviceType, base, overrides = {}) {
  const target = base + 1;
  const prefix = type === 'UNCLAIM_DEVICE' ? 'device_unclaim' : 'device';
  const device = resource(deviceType, target);
  if (type === 'UNCLAIM_DEVICE') {
    device.claimed_user_uuid = null;
    device.zone_uuid = null;
  }
  const payload = {
    command_id: COMMAND_UUID,
    command_type: type,
    effect_key: `${prefix}:${DEVICE_EUI}:${base}`,
    device_eui: DEVICE_EUI,
    gateway_device_eui: GATEWAY_EUI,
    base_sync_version: base,
    target_sync_version: target,
    device,
    ...overrides,
  };
  return {
    commandId: 100 + base,
    commandType: type,
    effectKey: payload.effect_key,
    payload,
  };
}

const runtime = {
  command_type_recognized: true,
  gateway_device_eui: GATEWAY_EUI,
};

function row(db) {
  return db.native.prepare(`
    SELECT d.*, u.user_uuid, z.zone_uuid
      FROM devices d
      LEFT JOIN users u ON u.id=d.user_id
      LEFT JOIN irrigation_zones z ON z.id=d.irrigation_zone_id
     WHERE d.deveui=?
  `).get(DEVICE_EUI);
}

test('applies assignment, rename, flags, and Chameleon depths as one aggregate', async () => {
  const db = setup();
  const result = await commands.applyDeviceCommand(
    db,
    envelope('UPSERT_DEVICE', 'DRAGINO_LSN50', 1),
    runtime
  );
  assert.equal(result.handled, true);
  assert.equal(result.ack.result, 'APPLIED');
  assert.equal(result.ack.appliedSyncVersion, 2);
  const current = row(db);
  assert.equal(current.name, 'North sensor');
  assert.equal(current.user_uuid, OWNER_UUID);
  assert.equal(current.zone_uuid, ZONE_UUID);
  assert.equal(current.dendro_enabled, 1);
  assert.equal(current.temp_enabled, 1);
  assert.equal(current.is_reference_tree, 1);
  assert.equal(current.chameleon_enabled, 1);
  assert.equal(current.chameleon_swt1_depth_cm, 20);
  assert.equal(current.chameleon_swt2_depth_cm, 40);
  assert.equal(current.sync_version, 2);
  assert.equal(current.current_state, 'OPEN');
  assert.equal(current.target_state, 'CLOSED');
  assert.equal(current.dendro_ratio_at_retracted, 0.25);
  assert.equal(current.device_mode, 4);
  const event = db.native.prepare(`
    SELECT op,payload_json,sync_version FROM sync_outbox
     WHERE aggregate_type='DEVICE'
  `).get();
  assert.equal(event.op, 'DEVICE_ASSIGNED');
  assert.equal(event.sync_version, 2);
  assert.equal(JSON.parse(event.payload_json).device_eui, DEVICE_EUI);
});

test('applies unassignment without removing ownership', async () => {
  const db = setup();
  db.native.prepare(`
    UPDATE devices SET irrigation_zone_id=(
      SELECT id FROM irrigation_zones WHERE zone_uuid=?
    ) WHERE deveui=?
  `).run(ZONE_UUID, DEVICE_EUI);
  db.native.exec('DELETE FROM sync_outbox');
  const command = envelope('UPSERT_DEVICE', 'DRAGINO_LSN50', 1);
  command.payload.device.zone_uuid = null;
  const result = await commands.applyDeviceCommand(db, command, runtime);
  assert.equal(result.ack.result, 'APPLIED');
  assert.equal(row(db).zone_uuid, null);
  assert.equal(row(db).user_uuid, OWNER_UUID);
  assert.equal(
    db.native.prepare(`SELECT op FROM sync_outbox`).get().op,
    'DEVICE_UNASSIGNED'
  );
});

test('applies Kiwi and Clover soil probe depths', async () => {
  for (const type of ['KIWI_SENSOR', 'TEKTELIC_CLOVER']) {
    const db = setup(type);
    const result = await commands.applyDeviceCommand(
      db,
      envelope('UPSERT_DEVICE', type, 1),
      runtime
    );
    assert.equal(result.ack.result, 'APPLIED');
    const current = row(db);
    assert.deepEqual(JSON.parse(current.soil_moisture_probe_depths_json), {
      swt_1: 15,
      swt_2: 35,
    });
    assert.equal(current.soil_moisture_probe_depths_configured, 1);
  }
});

test('applies STREGA model without changing valve observations', async () => {
  const db = setup('STREGA_VALVE');
  const result = await commands.applyDeviceCommand(
    db,
    envelope('UPSERT_DEVICE', 'STREGA_VALVE', 1),
    runtime
  );
  assert.equal(result.ack.result, 'APPLIED');
  const current = row(db);
  assert.equal(current.strega_model, 'MOTORIZED');
  assert.equal(current.current_state, 'OPEN');
  assert.equal(current.target_state, 'CLOSED');
});

test('unclaims the device with a separate protected effect family', async () => {
  const db = setup();
  db.native.prepare(`
    UPDATE devices SET irrigation_zone_id=(
      SELECT id FROM irrigation_zones WHERE zone_uuid=?
    ) WHERE deveui=?
  `).run(ZONE_UUID, DEVICE_EUI);
  db.native.exec('DELETE FROM sync_outbox');
  const result = await commands.applyDeviceCommand(
    db,
    envelope('UNCLAIM_DEVICE', 'DRAGINO_LSN50', 1),
    runtime
  );
  assert.equal(result.ack.result, 'APPLIED');
  const current = row(db);
  assert.equal(current.user_uuid, null);
  assert.equal(current.zone_uuid, null);
  assert.equal(
    db.native.prepare(`SELECT op FROM sync_outbox`).get().op,
    'DEVICE_UNCLAIMED'
  );
});

test('replays an exact command and conflicts on changed intent at the same base', async () => {
  const db = setup();
  const command = envelope('UPSERT_DEVICE', 'DRAGINO_LSN50', 1);
  const first = await commands.applyDeviceCommand(db, command, runtime);
  const replay = await commands.applyDeviceCommand(db, command, runtime);
  assert.deepEqual(replay.ack, first.ack);

  const changed = envelope('UPSERT_DEVICE', 'DRAGINO_LSN50', 1);
  changed.commandId = 202;
  changed.payload.command_id = '55555555-5555-4555-8555-555555555555';
  changed.payload.device.name = 'Changed intent';
  const conflict = await commands.applyDeviceCommand(db, changed, runtime);
  assert.equal(conflict.ack.result, 'CONFLICT');
  assert.equal(row(db).name, 'North sensor');
  assert.equal(
    db.native.prepare('SELECT COUNT(*) AS count FROM applied_commands').get()
      .count,
    2
  );
});

test('rejects stale base, wrong gateway, inaccessible or changed owner, type mismatch, and missing zone', async () => {
  const staleDb = setup();
  const stale = envelope('UPSERT_DEVICE', 'DRAGINO_LSN50', 0);
  assert.equal(
    (await commands.applyDeviceCommand(staleDb, stale, runtime)).ack.result,
    'CONFLICT'
  );

  const wrongGateway = setup();
  const wrong = envelope('UPSERT_DEVICE', 'DRAGINO_LSN50', 1);
  wrong.payload.gateway_device_eui = WRONG_EUI;
  await assert.rejects(
    commands.applyDeviceCommand(wrongGateway, wrong, runtime),
    /gateway/
  );

  const inaccessibleDb = setup();
  const inaccessible = envelope('UPSERT_DEVICE', 'DRAGINO_LSN50', 1);
  inaccessible.payload.device.claimed_user_uuid = OTHER_OWNER_UUID;
  assert.equal(
    (await commands.applyDeviceCommand(inaccessibleDb, inaccessible, runtime))
      .ack.result,
    'REJECTED_PERMANENT'
  );

  const changedOwnerDb = setup();
  changedOwnerDb.native.prepare(
    'UPDATE users SET disabled_at=NULL WHERE user_uuid=?'
  ).run(OTHER_OWNER_UUID);
  const changedOwner = envelope('UPSERT_DEVICE', 'DRAGINO_LSN50', 1);
  changedOwner.payload.device.claimed_user_uuid = OTHER_OWNER_UUID;
  changedOwner.payload.device.zone_uuid = null;
  assert.equal(
    (await commands.applyDeviceCommand(changedOwnerDb, changedOwner, runtime))
      .ack.result,
    'REJECTED_PERMANENT'
  );

  const mismatchDb = setup();
  const mismatch = envelope('UPSERT_DEVICE', 'KIWI_SENSOR', 1);
  assert.equal(
    (await commands.applyDeviceCommand(mismatchDb, mismatch, runtime)).ack.result,
    'REJECTED_PERMANENT'
  );

  const missingZoneDb = setup();
  const missingZone = envelope('UPSERT_DEVICE', 'DRAGINO_LSN50', 1);
  missingZone.payload.device.zone_uuid =
    '66666666-6666-4666-8666-666666666666';
  assert.equal(
    (await commands.applyDeviceCommand(missingZoneDb, missingZone, runtime))
      .ack.result,
    'REJECTED_PERMANENT'
  );
});

test('rolls back the device, returning event, and ledger when ACK persistence fails', async () => {
  const db = setup();
  db.failSql = 'INSERT INTO command_ack_outbox';
  await assert.rejects(
    commands.applyDeviceCommand(
      db,
      envelope('UPSERT_DEVICE', 'DRAGINO_LSN50', 1),
      runtime
    ),
    /injected write failure/
  );
  assert.equal(row(db).name, 'Original');
  assert.equal(row(db).sync_version, 1);
  assert.equal(
    db.native.prepare('SELECT COUNT(*) AS count FROM sync_outbox').get().count,
    0
  );
  assert.equal(
    db.native.prepare('SELECT COUNT(*) AS count FROM applied_commands').get()
      .count,
    0
  );
});
