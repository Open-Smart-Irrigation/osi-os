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
  path.join(os.tmpdir(), 'osi-irrigation-config-command-test-')
);
const GATEWAY_EUI = '0016C001F11715E2';
const WRONG_EUI = 'FFFFFFFFFFFFFFFF';
const USER_UUID = '11111111-1111-4111-8111-111111111111';
const ZONE_UUID = '22222222-2222-4222-8222-222222222222';
const COMMAND_UUID = '33333333-3333-4333-8333-333333333333';

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

function setup() {
  const db = new TestDb();
  db.native.prepare(`
    INSERT INTO users (
      username, password_hash, created_at, user_uuid
    ) VALUES (?, ?, ?, ?)
  `).run('grower', 'not-a-real-hash', '2026-07-24T00:00:00.000Z', USER_UUID);
  db.native.prepare(`
    INSERT INTO irrigation_zones (
      name, user_id, zone_uuid, gateway_device_eui, sync_version,
      created_at, updated_at
    ) VALUES (
      'North',
      (SELECT id FROM users WHERE user_uuid = ?),
      ?, ?, 1, ?, ?
    )
  `).run(
    USER_UUID,
    ZONE_UUID,
    GATEWAY_EUI,
    '2026-07-24T00:01:00.000Z',
    '2026-07-24T00:01:00.000Z'
  );
  db.native.exec('DELETE FROM sync_outbox');
  return db;
}

function envelope(type, base, overrides) {
  const target = base + 1;
  const schedule = {
    contract_version: 1,
    zone_uuid: ZONE_UUID,
    gateway_device_eui: GATEWAY_EUI,
    trigger_metric: 'SWT_1',
    threshold_kpa: 35.5,
    enabled: 1,
    duration_minutes: 20,
    response_mode: 'proportional',
    sync_version: target,
    deleted_at: null,
    last_applied_at: null,
  };
  const calibration = {
    contract_version: 1,
    zone_uuid: ZONE_UUID,
    gateway_device_eui: GATEWAY_EUI,
    measured_flow_rate_lpm: 12.5,
    measurement_method: 'Timed bucket test',
    measured_at: '2026-07-24T10:00:00.000Z',
    sync_version: target,
    deleted_at: null,
    last_applied_at: null,
  };
  const prefix = type === 'UPSERT_SCHEDULE'
    ? 'schedule'
    : 'irrigation_calibration';
  const resourceKey = type === 'UPSERT_SCHEDULE'
    ? 'schedule'
    : 'irrigation_calibration';
  const payload = {
    command_id: COMMAND_UUID,
    command_type: type,
    effect_key: `${prefix}:${ZONE_UUID}:${base}`,
    zone_uuid: ZONE_UUID,
    gateway_device_eui: GATEWAY_EUI,
    base_sync_version: base,
    target_sync_version: target,
    [resourceKey]: type === 'UPSERT_SCHEDULE' ? schedule : calibration,
  };
  Object.assign(payload, overrides || {});
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

test('creates and updates a protected schedule with terminal ACKs', async () => {
  const db = setup();
  const created = await commands.applyIrrigationConfigCommand(
    db,
    envelope('UPSERT_SCHEDULE', 0),
    runtime
  );
  assert.equal(created.handled, true);
  assert.equal(created.ack.result, 'APPLIED');
  assert.equal(created.ack.appliedSyncVersion, 1);

  const first = db.native.prepare(`
    SELECT trigger_metric, threshold_kpa, enabled, duration_minutes,
           response_mode, sync_version
      FROM irrigation_schedules
  `).get();
  assert.deepEqual({ ...first }, {
    trigger_metric: 'SWT_1',
    threshold_kpa: 35.5,
    enabled: 1,
    duration_minutes: 20,
    response_mode: 'proportional',
    sync_version: 1,
  });

  const update = envelope('UPSERT_SCHEDULE', 1);
  update.commandId = 102;
  update.payload.schedule.threshold_kpa = 42;
  update.payload.schedule.sync_version = 2;
  const updated = await commands.applyIrrigationConfigCommand(db, update, runtime);
  assert.equal(updated.ack.result, 'APPLIED');
  assert.equal(
    db.native.prepare('SELECT threshold_kpa FROM irrigation_schedules').get()
      .threshold_kpa,
    42
  );
});

test('creates and updates calibration without changing the local valve binding', async () => {
  const db = setup();
  const created = await commands.applyIrrigationConfigCommand(
    db,
    envelope('UPSERT_ZONE_IRRIGATION_CALIBRATION', 0),
    runtime
  );
  assert.equal(created.ack.result, 'APPLIED');
  db.native.prepare(`
    UPDATE zone_irrigation_calibration
       SET valve_device_eui = ?
  `).run('ABCDEF0123456789');

  const update = envelope('UPSERT_ZONE_IRRIGATION_CALIBRATION', 1);
  update.commandId = 102;
  update.payload.irrigation_calibration.measured_flow_rate_lpm = 14.25;
  update.payload.irrigation_calibration.sync_version = 2;
  const updated = await commands.applyIrrigationConfigCommand(db, update, runtime);
  assert.equal(updated.ack.result, 'APPLIED');
  const row = db.native.prepare(`
    SELECT valve_device_eui, measured_flow_rate_lpm, sync_version
      FROM zone_irrigation_calibration
  `).get();
  assert.deepEqual({ ...row }, {
    valve_device_eui: 'ABCDEF0123456789',
    measured_flow_rate_lpm: 14.25,
    sync_version: 2,
  });
});

test('returns terminal conflicts for stale and future bases', async () => {
  const db = setup();
  await commands.applyIrrigationConfigCommand(
    db,
    envelope('UPSERT_SCHEDULE', 0),
    runtime
  );
  for (const [deliveryId, base] of [[201, 0], [202, 4]]) {
    const command = envelope('UPSERT_SCHEDULE', base);
    command.commandId = deliveryId;
    const result = await commands.applyIrrigationConfigCommand(
      db,
      command,
      runtime
    );
    assert.equal(result.ack.result, 'CONFLICT');
    assert.equal(result.ack.appliedSyncVersion, 1);
  }
});

test('rejects a missing zone and a wrong gateway', async () => {
  const db = setup();
  db.native.exec('DELETE FROM irrigation_zones');
  const missing = await commands.applyIrrigationConfigCommand(
    db,
    envelope('UPSERT_SCHEDULE', 0),
    runtime
  );
  assert.equal(missing.ack.result, 'REJECTED_PERMANENT');

  const wrong = envelope('UPSERT_SCHEDULE', 0, {
    gateway_device_eui: WRONG_EUI,
  });
  wrong.commandId = 301;
  await assert.rejects(
    commands.applyIrrigationConfigCommand(db, wrong, runtime),
    /gateway/
  );
});

test('exact command replay is idempotent and ACK failure rolls back mutation', async () => {
  const db = setup();
  const command = envelope('UPSERT_SCHEDULE', 0);
  const first = await commands.applyIrrigationConfigCommand(db, command, runtime);
  const replay = await commands.applyIrrigationConfigCommand(db, command, runtime);
  assert.deepEqual(replay.ack, first.ack);
  assert.equal(
    db.native.prepare('SELECT COUNT(*) AS count FROM applied_commands').get().count,
    1
  );

  const rollbackDb = setup();
  rollbackDb.failSql = 'INSERT INTO command_ack_outbox';
  await assert.rejects(
    commands.applyIrrigationConfigCommand(
      rollbackDb,
      envelope('UPSERT_SCHEDULE', 0),
      runtime
    ),
    /injected write failure/
  );
  assert.equal(
    rollbackDb.native.prepare('SELECT COUNT(*) AS count FROM irrigation_schedules').get().count,
    0
  );
  assert.equal(
    rollbackDb.native.prepare('SELECT COUNT(*) AS count FROM applied_commands').get().count,
    0
  );
});
