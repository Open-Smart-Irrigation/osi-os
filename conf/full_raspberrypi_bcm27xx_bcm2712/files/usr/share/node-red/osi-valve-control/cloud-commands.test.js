'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDb } = require('./test-helpers');
const { applyCloudCommand } = require('./cloud-commands');

const EUI = '0016C001F1000001';
const noopFlush = async () => {};
const noopWarn = () => {};

async function apply(db, cmd, extra) {
  return applyCloudCommand(Object.assign({ db, cmd, appId: 'app', flushQueue: noopFlush, warn: noopWarn, now: new Date() }, extra || {}));
}

test('UPSERT_VALVE_SCHEDULE inserts a new WEEKLY schedule and compiles a plan push', async () => {
  const { db } = await tempDb();
  const out = await apply(db, {
    commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: 'a1111111-0000-0000-0000-000000000001',
    kind: 'WEEKLY', weekdays_mask: 0x7F, start_time: '06:00', duration_minutes: 15, enabled: true,
  });
  assert.equal(out.ok, true);
  assert.ok(out.downlinks.length >= 1, 'a WEEKLY upsert must compile and queue at least one downlink');
  const row = await db.get('SELECT * FROM valve_schedules WHERE schedule_uuid=?', ['a1111111-0000-0000-0000-000000000001']);
  assert.equal(row.device_eui, EUI);
  assert.equal(row.duration_minutes, 15);
});

test('UPSERT_VALVE_SCHEDULE updates an existing schedule in place (same schedule_uuid, no duplicate row)', async () => {
  const { db } = await tempDb();
  const uuid = 'a1111111-0000-0000-0000-000000000002';
  await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: uuid, kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:00', duration_minutes: 10, enabled: true });
  const out = await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: uuid, kind: 'WEEKLY', weekdays_mask: 1, start_time: '07:30', duration_minutes: 20, enabled: true });
  assert.equal(out.ok, true);
  const rows = await db.all('SELECT * FROM valve_schedules WHERE schedule_uuid=?', [uuid]);
  assert.equal(rows.length, 1, 'must UPDATE the existing row, not insert a second one');
  assert.equal(rows[0].start_time, '07:30');
  assert.equal(rows[0].duration_minutes, 20);
});

test('UPSERT_VALVE_SCHEDULE rejects an overlapping WEEKLY window without persisting it (plan_conflict)', async () => {
  const { db } = await tempDb();
  await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: 'a1111111-0000-0000-0000-000000000003', kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:00', duration_minutes: 60, enabled: true });
  const out = await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: 'a1111111-0000-0000-0000-000000000004', kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:30', duration_minutes: 10, enabled: true });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'plan_conflict');
  const row = await db.get('SELECT * FROM valve_schedules WHERE schedule_uuid=?', ['a1111111-0000-0000-0000-000000000004']);
  assert.equal(row, undefined, 'a rejected schedule must never reach the DB');
});

test('UPSERT_VALVE_SCHEDULE with deleted_at set soft-deletes an existing schedule (defensive path)', async () => {
  const { db } = await tempDb();
  const uuid = 'a1111111-0000-0000-0000-000000000005';
  await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: uuid, kind: 'ONCE', fire_at: new Date(Date.now() + 3600000).toISOString(), duration_minutes: 5, enabled: true });
  const out = await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: uuid, deleted_at: new Date().toISOString() });
  assert.equal(out.ok, true);
  const row = await db.get('SELECT deleted_at FROM valve_schedules WHERE schedule_uuid=?', [uuid]);
  assert.ok(row.deleted_at, 'schedule must be soft-deleted');
});

test('UPSERT_VALVE_SCHEDULE rejects an unknown device (not_found)', async () => {
  const { db } = await tempDb();
  const out = await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: 'FFFFFFFFFFFFFFFF', schedule_uuid: 'a1111111-0000-0000-0000-000000000006', kind: 'ONCE', fire_at: new Date(Date.now() + 3600000).toISOString(), duration_minutes: 5, enabled: true });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'not_found');
});

test('DELETE_VALVE_SCHEDULE soft-deletes a WEEKLY schedule and recompiles the plan', async () => {
  const { db } = await tempDb();
  const uuid = 'a1111111-0000-0000-0000-000000000007';
  await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: uuid, kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:00', duration_minutes: 15, enabled: true });
  const out = await apply(db, { commandType: 'DELETE_VALVE_SCHEDULE', schedule_uuid: uuid });
  assert.equal(out.ok, true);
  const row = await db.get('SELECT deleted_at FROM valve_schedules WHERE schedule_uuid=?', [uuid]);
  assert.ok(row.deleted_at);
});

test('DELETE_VALVE_SCHEDULE on an unknown schedule_uuid returns not_found', async () => {
  const { db } = await tempDb();
  const out = await apply(db, { commandType: 'DELETE_VALVE_SCHEDULE', schedule_uuid: 'does-not-exist' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'not_found');
});

test('RESEND_VALVE_PLAN force-recompiles even when nothing changed', async () => {
  const { db } = await tempDb();
  await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: 'a1111111-0000-0000-0000-000000000008', kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:00', duration_minutes: 15, enabled: true });
  const out = await apply(db, { commandType: 'RESEND_VALVE_PLAN', device_eui: EUI });
  assert.equal(out.ok, true);
  assert.ok(out.downlinks.length >= 1);
});

test('RESEND_VALVE_PLAN on a non-valve device is rejected', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES ('0016C001F1000099','Sensor','DRAGINO_LSN50',1,datetime('now'),datetime('now'))");
  const out = await apply(db, { commandType: 'RESEND_VALVE_PLAN', device_eui: '0016C001F1000099' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'not_a_valve');
});

test('SET_VALVE_SCHEDULER_STATUS persists status and queues a status push', async () => {
  const { db } = await tempDb();
  const out = await apply(db, { commandType: 'SET_VALVE_SCHEDULER_STATUS', device_eui: EUI, status: 'SKIP_TODAY' });
  assert.equal(out.ok, true);
  assert.equal(out.downlinks.length, 1);
  const row = await db.get('SELECT scheduler_status, skip_today_date FROM valve_settings WHERE device_eui=?', [EUI]);
  assert.equal(row.scheduler_status, 'SKIP_TODAY');
  assert.ok(row.skip_today_date);
});

test('SET_VALVE_SCHEDULER_STATUS rejects an invalid status', async () => {
  const { db } = await tempDb();
  const out = await apply(db, { commandType: 'SET_VALVE_SCHEDULER_STATUS', device_eui: EUI, status: 'BOGUS' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'invalid_status');
});

test('an unrecognised command type is rejected without touching the DB', async () => {
  const { db } = await tempDb();
  const out = await apply(db, { commandType: 'NOT_A_REAL_COMMAND', device_eui: EUI });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'unknown_command_type');
});

async function insertExpectation(db, { id, state, commandedAt, deviceEui }) {
  await db.run(
    "INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, trigger, created_at) " +
    "VALUES (?, ?, ?, 900, ?, 'unknown', ?, 'on_valve_schedule', ?)",
    [id, deviceEui || EUI, commandedAt, commandedAt, state, commandedAt]
  );
}

test('CANCEL_VALVE_ACTUATION cancels the newest active expectation and flushes the queue exactly once', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e1', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });
  const flushCalls = [];
  const out = await apply(db, { commandType: 'CANCEL_VALVE_ACTUATION', device_eui: EUI, reason: 'operator_cancel' }, {
    flushQueue: async (eui) => { flushCalls.push(eui); },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.downlinks, []);
  assert.equal(flushCalls.length, 1);
  const row = await db.get('SELECT reconciliation_state, cancel_reason FROM valve_actuation_expectations WHERE expectation_id=?', ['e1']);
  assert.equal(row.reconciliation_state, 'CANCELLED');
  assert.equal(row.cancel_reason, 'operator_cancel');
});

test('CANCEL_VALVE_ACTUATION with an explicit null reason defaults to operator_cancel', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e1', state: 'OBSERVED_RUNNING', commandedAt: '2026-08-25T10:00:00.000Z' });
  const out = await apply(db, { commandType: 'CANCEL_VALVE_ACTUATION', device_eui: EUI, reason: null });
  assert.equal(out.ok, true);
  const row = await db.get('SELECT cancel_reason FROM valve_actuation_expectations WHERE expectation_id=?', ['e1']);
  assert.equal(row.cancel_reason, 'operator_cancel');
});

test('CANCEL_VALVE_ACTUATION with no active expectation matches the REST route (no flush, no_active_actuation)', async () => {
  const { db } = await tempDb();
  const flushCalls = [];
  const out = await apply(db, { commandType: 'CANCEL_VALVE_ACTUATION', device_eui: EUI }, {
    flushQueue: async (eui) => { flushCalls.push(eui); },
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'no_active_actuation');
  assert.equal(flushCalls.length, 0);
});

test('CANCEL_VALVE_ACTUATION on an unknown EUI returns not_found', async () => {
  const { db } = await tempDb();
  const out = await apply(db, { commandType: 'CANCEL_VALVE_ACTUATION', device_eui: 'FFFFFFFFFFFFFFFF' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'not_found');
});

test('CANCEL_VALVE_ACTUATION on a non-valve device returns not_a_valve', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES ('0016C001F1000099','Sensor','DRAGINO_LSN50',1,datetime('now'),datetime('now'))");
  const out = await apply(db, { commandType: 'CANCEL_VALVE_ACTUATION', device_eui: '0016C001F1000099' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'not_a_valve');
});

test('CANCEL_VALVE_ACTUATION command replay (applied twice) is harmless', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e1', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });
  const first = await apply(db, { commandType: 'CANCEL_VALVE_ACTUATION', device_eui: EUI, reason: 'operator_cancel' });
  assert.equal(first.ok, true);
  const second = await apply(db, { commandType: 'CANCEL_VALVE_ACTUATION', device_eui: EUI, reason: 'operator_cancel' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'no_active_actuation');
  const row = await db.get('SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id=?', ['e1']);
  assert.equal(row.reconciliation_state, 'CANCELLED');
});
