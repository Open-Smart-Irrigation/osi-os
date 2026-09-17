'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDb } = require('./test-helpers');
const { applyCloudCommand } = require('./cloud-commands');
const store = require('./store');

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
  const out = await apply(db, { commandType: 'DELETE_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: uuid });
  assert.equal(out.ok, true);
  const row = await db.get('SELECT deleted_at FROM valve_schedules WHERE schedule_uuid=?', [uuid]);
  assert.ok(row.deleted_at);
});

test('DELETE_VALVE_SCHEDULE on an unknown schedule_uuid returns not_found', async () => {
  const { db } = await tempDb();
  const out = await apply(db, { commandType: 'DELETE_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: 'does-not-exist' });
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

test('UPSERT_VALVE_SETTINGS applies a partial update (only the fields present in the command change)', async () => {
  const { db } = await tempDb();
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN2', default_open_minutes: 20 });
  const out = await apply(db, { commandType: 'UPSERT_VALVE_SETTINGS', device_eui: EUI, default_open_minutes: 30 });
  assert.equal(out.ok, true);
  assert.deepEqual(out.downlinks, []);
  const row = await db.get('SELECT strega_generation, default_open_minutes FROM valve_settings WHERE device_eui=?', [EUI]);
  assert.equal(row.strega_generation, 'GEN2', 'absent field (strega_generation) is left unchanged');
  assert.equal(row.default_open_minutes, 30, 'present field is updated');
});

test('UPSERT_VALVE_SETTINGS creates a row for a valve with no prior settings', async () => {
  const { db } = await tempDb();
  const out = await apply(db, { commandType: 'UPSERT_VALVE_SETTINGS', device_eui: EUI, strega_generation: 'GEN2', flow_rate_lpm: 4.5, flow_rate_source: 'measured' });
  assert.equal(out.ok, true);
  const row = await db.get('SELECT strega_generation, flow_rate_lpm, flow_rate_source FROM valve_settings WHERE device_eui=?', [EUI]);
  assert.equal(row.strega_generation, 'GEN2');
  assert.equal(row.flow_rate_lpm, 4.5);
  assert.equal(row.flow_rate_source, 'measured');
});

test('UPSERT_VALVE_SETTINGS: flow_rate_lpm=null clears flow_rate_lpm/flow_rate_source together (matches the REST route)', async () => {
  const { db } = await tempDb();
  await store.upsertSettings(db, EUI, { flow_rate_lpm: 4.5, flow_rate_source: 'measured' });
  const out = await apply(db, { commandType: 'UPSERT_VALVE_SETTINGS', device_eui: EUI, flow_rate_lpm: null });
  assert.equal(out.ok, true);
  const row = await db.get('SELECT flow_rate_lpm, flow_rate_source FROM valve_settings WHERE device_eui=?', [EUI]);
  assert.equal(row.flow_rate_lpm, null);
  assert.equal(row.flow_rate_source, null);
});

test('UPSERT_VALVE_SETTINGS: a non-"measured" flow_rate_source coerces to "estimated" (matches the REST route)', async () => {
  const { db } = await tempDb();
  const out = await apply(db, { commandType: 'UPSERT_VALVE_SETTINGS', device_eui: EUI, flow_rate_lpm: 3, flow_rate_source: 'guessed' });
  assert.equal(out.ok, true);
  const row = await db.get('SELECT flow_rate_source FROM valve_settings WHERE device_eui=?', [EUI]);
  assert.equal(row.flow_rate_source, 'estimated');
});

test('UPSERT_VALVE_SETTINGS rejects an invalid strega_generation', async () => {
  const { db } = await tempDb();
  const out = await apply(db, { commandType: 'UPSERT_VALVE_SETTINGS', device_eui: EUI, strega_generation: 'GEN3' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'invalid_generation');
  const row = await db.get('SELECT device_eui FROM valve_settings WHERE device_eui=?', [EUI]);
  assert.equal(row, undefined, 'a rejected command must never reach the DB');
});

test('UPSERT_VALVE_SETTINGS rejects an out-of-range flow_rate_lpm', async () => {
  const { db } = await tempDb();
  const out = await apply(db, { commandType: 'UPSERT_VALVE_SETTINGS', device_eui: EUI, flow_rate_lpm: -1 });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'invalid_flow_rate');
});

test('UPSERT_VALVE_SETTINGS rejects an out-of-range default_open_minutes', async () => {
  const { db } = await tempDb();
  const out = await apply(db, { commandType: 'UPSERT_VALVE_SETTINGS', device_eui: EUI, default_open_minutes: 256 });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'invalid_default_open_minutes');
});

test('UPSERT_VALVE_SETTINGS rejects scheduler_status (the REST PUT /settings route does not accept it either)', async () => {
  const { db } = await tempDb();
  const out = await apply(db, { commandType: 'UPSERT_VALVE_SETTINGS', device_eui: EUI, scheduler_status: 'DEACTIVATED' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'scheduler_status_not_supported');
  const row = await db.get('SELECT device_eui FROM valve_settings WHERE device_eui=?', [EUI]);
  assert.equal(row, undefined, 'a rejected command must never reach the DB');
});

test('UPSERT_VALVE_SETTINGS on an unknown EUI returns not_found', async () => {
  const { db } = await tempDb();
  const out = await apply(db, { commandType: 'UPSERT_VALVE_SETTINGS', device_eui: 'FFFFFFFFFFFFFFFF', strega_generation: 'GEN2' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'not_found');
});

test('UPSERT_VALVE_SETTINGS on a non-valve device is rejected', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES ('0016C001F1000099','Sensor','DRAGINO_LSN50',1,datetime('now'),datetime('now'))");
  const out = await apply(db, { commandType: 'UPSERT_VALVE_SETTINGS', device_eui: '0016C001F1000099', strega_generation: 'GEN2' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'not_a_valve');
});

test('UPSERT_VALVE_SETTINGS replay (same command applied twice) is idempotent: bumps sync_version once per apply, final state matches', async () => {
  const { db } = await tempDb();
  const first = await apply(db, { commandType: 'UPSERT_VALVE_SETTINGS', device_eui: EUI, default_open_minutes: 15 });
  assert.equal(first.ok, true);
  const afterFirst = await db.get('SELECT default_open_minutes, sync_version FROM valve_settings WHERE device_eui=?', [EUI]);
  assert.equal(afterFirst.default_open_minutes, 15);
  assert.equal(afterFirst.sync_version, 1);
  const second = await apply(db, { commandType: 'UPSERT_VALVE_SETTINGS', device_eui: EUI, default_open_minutes: 15 });
  assert.equal(second.ok, true);
  const afterSecond = await db.get('SELECT default_open_minutes, sync_version FROM valve_settings WHERE device_eui=?', [EUI]);
  assert.equal(afterSecond.default_open_minutes, 15, 'replay converges on the same value');
  assert.equal(afterSecond.sync_version, 2, 'sync_version still advances on replay (idempotent VALUE, not a no-op write)');
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

// Review fix (Task 1.4, finding 1): the Valve Cloud Command Bridge builds flushQueue inside
// its own try/catch and passes null when createProvisioningClientFromEnv throws. The
// applier must fail closed rather than silently skip the flush while still cancelling.
test('CANCEL_VALVE_ACTUATION fails closed with chirpstack_unavailable when the bridge could not build a ChirpStack client (flushQueue: null): no row mutated', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e1', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });
  const out = await apply(db, { commandType: 'CANCEL_VALVE_ACTUATION', device_eui: EUI, reason: 'operator_cancel' }, { flushQueue: null });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'chirpstack_unavailable');
  assert.deepEqual(out.downlinks, []);
  const row = await db.get('SELECT reconciliation_state, cancel_reason FROM valve_actuation_expectations WHERE expectation_id=?', ['e1']);
  assert.equal(row.reconciliation_state, 'PENDING_OBSERVATION');
  assert.equal(row.cancel_reason, null);
  const device = await db.get('SELECT target_state FROM devices WHERE UPPER(deveui)=?', [EUI]);
  assert.notEqual(device.target_state, 'CLOSED');
});

// --- F144: every cloud-originated schedule mutation is scoped to (schedule_uuid, device_eui) ---
// valve_schedules is one table per gateway and schedule_uuid is globally UNIQUE in it, so an
// applier that locates the row by uuid alone lets a command addressed to valve X rewrite or
// soft-delete valve Y's schedule. The device_eui in the command is the addressed valve, not a
// hint: a uuid that belongs to another valve is a terminal rejection (schedule_device_mismatch),
// never a silent re-home of the schedule to the addressed valve.
const OTHER_EUI = '0016C001F1000002';

async function addValve(db, eui) {
  await db.run("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES (?,'Valve B','STREGA_VALVE',1,datetime('now'),datetime('now'))", [eui || OTHER_EUI]);
}

test('F144: UPSERT_VALVE_SCHEDULE addressed to valve B with valve A\'s schedule_uuid is rejected and leaves A\'s row byte-for-byte untouched', async () => {
  const { db } = await tempDb();
  await addValve(db);
  const uuid = 'f1440000-0000-0000-0000-000000000001';
  await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: uuid, kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:00', duration_minutes: 15, enabled: true });
  const before = await db.get('SELECT * FROM valve_schedules WHERE schedule_uuid=?', [uuid]);
  const out = await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: OTHER_EUI, schedule_uuid: uuid, kind: 'WEEKLY', weekdays_mask: 64, start_time: '23:00', duration_minutes: 90, enabled: true });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'schedule_device_mismatch');
  const after = await db.get('SELECT * FROM valve_schedules WHERE schedule_uuid=?', [uuid]);
  assert.deepEqual(after, before, "valve A's schedule must not be edited, re-homed or version-bumped by a command addressed to valve B");
});

test('F144: UPSERT_VALVE_SCHEDULE with deleted_at addressed to valve B cannot soft-delete valve A\'s schedule', async () => {
  const { db } = await tempDb();
  await addValve(db);
  const uuid = 'f1440000-0000-0000-0000-000000000002';
  await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: uuid, kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:00', duration_minutes: 15, enabled: true });
  const out = await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: OTHER_EUI, schedule_uuid: uuid, deleted_at: new Date().toISOString() });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'schedule_device_mismatch');
  const row = await db.get('SELECT deleted_at FROM valve_schedules WHERE schedule_uuid=?', [uuid]);
  assert.equal(row.deleted_at, null, "valve A's schedule must still be live");
});

test('F144: UPSERT_VALVE_SCHEDULE on the owning valve still applies (the scope check only rejects a foreign uuid)', async () => {
  const { db } = await tempDb();
  await addValve(db);
  const uuid = 'f1440000-0000-0000-0000-000000000003';
  await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: uuid, kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:00', duration_minutes: 15, enabled: true });
  const out = await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: uuid, kind: 'WEEKLY', weekdays_mask: 1, start_time: '08:45', duration_minutes: 25, enabled: true });
  assert.equal(out.ok, true);
  const row = await db.get('SELECT device_eui, start_time, duration_minutes FROM valve_schedules WHERE schedule_uuid=?', [uuid]);
  assert.equal(row.device_eui, EUI);
  assert.equal(row.start_time, '08:45');
  assert.equal(row.duration_minutes, 25);
});

test('F144: UPSERT_VALVE_SCHEDULE with a uuid no valve owns still creates the row under the addressed valve', async () => {
  const { db } = await tempDb();
  await addValve(db);
  const uuid = 'f1440000-0000-0000-0000-000000000004';
  const out = await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: OTHER_EUI, schedule_uuid: uuid, kind: 'WEEKLY', weekdays_mask: 2, start_time: '05:30', duration_minutes: 12, enabled: true });
  assert.equal(out.ok, true);
  const row = await db.get('SELECT device_eui FROM valve_schedules WHERE schedule_uuid=?', [uuid]);
  assert.equal(row.device_eui, OTHER_EUI);
});

test('F144: a soft-deleted schedule_uuid stays owned by its valve: valve B cannot reuse it', async () => {
  const { db } = await tempDb();
  await addValve(db);
  const uuid = 'f1440000-0000-0000-0000-000000000005';
  await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: uuid, kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:00', duration_minutes: 15, enabled: true });
  await apply(db, { commandType: 'DELETE_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: uuid });
  const out = await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: OTHER_EUI, schedule_uuid: uuid, kind: 'WEEKLY', weekdays_mask: 4, start_time: '07:00', duration_minutes: 20, enabled: true });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'schedule_device_mismatch', 'schedule_uuid is globally UNIQUE, so an insert under B would fail anyway - it must fail as an explicit rejection, not as a raw SQLite constraint error');
  const row = await db.get('SELECT device_eui FROM valve_schedules WHERE schedule_uuid=?', [uuid]);
  assert.equal(row.device_eui, EUI);
});

test('F144: DELETE_VALVE_SCHEDULE addressed to valve B cannot soft-delete valve A\'s schedule', async () => {
  const { db } = await tempDb();
  await addValve(db);
  const uuid = 'f1440000-0000-0000-0000-000000000006';
  await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: uuid, kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:00', duration_minutes: 15, enabled: true });
  const before = await db.get('SELECT * FROM valve_schedules WHERE schedule_uuid=?', [uuid]);
  const out = await apply(db, { commandType: 'DELETE_VALVE_SCHEDULE', device_eui: OTHER_EUI, schedule_uuid: uuid });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'schedule_device_mismatch');
  assert.deepEqual(out.downlinks || [], [], 'a rejected delete must not push a recompiled plan to either valve');
  const after = await db.get('SELECT * FROM valve_schedules WHERE schedule_uuid=?', [uuid]);
  assert.deepEqual(after, before);
});

// commands.schema.json's generic rule ("else": {"required": ["device_eui"]}) already requires
// device_eui for DELETE_VALVE_SCHEDULE - every command type outside the journal/scoped-user
// exemption list carries one. Enforcing it here matches the contract; it does not change it.
test('F144: DELETE_VALVE_SCHEDULE without device_eui is rejected (the contract requires one)', async () => {
  const { db } = await tempDb();
  const uuid = 'f1440000-0000-0000-0000-000000000007';
  await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: uuid, kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:00', duration_minutes: 15, enabled: true });
  const out = await apply(db, { commandType: 'DELETE_VALVE_SCHEDULE', schedule_uuid: uuid });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'device_eui and schedule_uuid are required');
  const row = await db.get('SELECT deleted_at FROM valve_schedules WHERE schedule_uuid=?', [uuid]);
  assert.equal(row.deleted_at, null, 'an unscoped delete must not fall back to uuid-only matching');
});

test('F144: every schedule-mutating rejection stays well inside the cloud mirror\'s 255-char free-text cap (#278/#280)', async () => {
  const { db } = await tempDb();
  await addValve(db);
  const uuid = 'f1440000-0000-0000-0000-000000000008';
  await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: uuid, kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:00', duration_minutes: 15, enabled: true });
  const rejections = [
    await apply(db, { commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: OTHER_EUI, schedule_uuid: uuid, kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:00', duration_minutes: 15, enabled: true }),
    await apply(db, { commandType: 'DELETE_VALVE_SCHEDULE', device_eui: OTHER_EUI, schedule_uuid: uuid }),
    await apply(db, { commandType: 'DELETE_VALVE_SCHEDULE', schedule_uuid: uuid }),
  ];
  for (const r of rejections) {
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 0 && r.error.length <= 255, 'the bridge ships out.error verbatim as the command_ack error field: ' + r.error.length + ' chars');
  }
});
