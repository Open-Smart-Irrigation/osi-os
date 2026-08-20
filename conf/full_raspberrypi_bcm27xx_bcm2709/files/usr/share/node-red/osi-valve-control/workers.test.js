'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDb } = require('./test-helpers');
const store = require('./store');
const P = require('./plan');
const W = require('./workers');

test('handleUplink acks the newest queued weekday push and records RTC ack', async () => {
  const { db } = await tempDb();
  await store.insertPushes(db, [{ push_id: 'p1', device_eui: '0016C001F1000001', purpose: 'WEEKDAY_PLAN', weekday: 2, fport: 16, payload_hex: 'FF'.repeat(24), plan_hash: 'h' }, { push_id: 'p2', device_eui: '0016C001F1000001', purpose: 'CLOCK_SYNC', weekday: null, fport: 12, payload_hex: '00', plan_hash: null }]);
  const r = await W.handleUplink({ db, deviceEui: '0016C001F1000001', decoded: { Schl_Port: 16, Schl_status: '00' }, fPort: 2, rawBytes: null, receivedAt: '2026-08-19T10:00:00.000Z', warn: () => {} });
  assert.equal(r.acked, 1);
  await W.handleUplink({ db, deviceEui: '0016C001F1000001', decoded: { RTC_Port: 12, RTC_status: '00' }, fPort: 2, receivedAt: '2026-08-19T10:01:00.000Z', warn: () => {} });
  const rows = await db.all('SELECT push_id, state FROM valve_schedule_pushes ORDER BY push_id');
  // node:sqlite returns null-prototype row objects; spread into plain objects before deepEqual (strict).
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ push_id: 'p1', state: 'ACKED' }, { push_id: 'p2', state: 'ACKED' }]);
  assert.equal((await store.getSettings(db, '0016C001F1000001')).last_clock_sync_acked_at, '2026-08-19T10:01:00.000Z');
});

test('runOnceTick fires due ONCE rows within grace and skips stale ones', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'due', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  await store.insertSchedule(db, { schedule_uuid: 'old', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T09:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  await store.insertSchedule(db, { schedule_uuid: 'future', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T12:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  const r = await W.runOnceTick({ db, now: new Date('2026-08-19T10:03:00Z'), warn: () => {} });
  assert.deepEqual(r.fired.map((f) => f.schedule_uuid), ['due']);
  assert.deepEqual(r.skipped.map((f) => f.schedule_uuid), ['old']);
  assert.equal(r.fired[0].actuator_command.data.action, 'OPEN_FOR_DURATION');
  assert.equal(r.fired[0].actuator_command.data.duration_minutes, 20);
  assert.equal(r.fired[0].actuator_command.data.reason, 'one_time_open');
  const states = await db.all('SELECT schedule_uuid, once_state FROM valve_schedules ORDER BY schedule_uuid');
  assert.deepEqual(states.map((s) => ({ ...s })), [{ schedule_uuid: 'due', once_state: 'FIRED' }, { schedule_uuid: 'future', once_state: 'PENDING' }, { schedule_uuid: 'old', once_state: 'SKIPPED' }]);
  const again = await W.runOnceTick({ db, now: new Date('2026-08-19T10:04:00Z'), warn: () => {} });
  assert.equal(again.fired.length + again.skipped.length, 0, 'idempotent');
});

test('runOnceTick (I3) ignores PENDING ONCE rows on a soft-deleted device and leaves the row untouched', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'gone', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  // devices.deleted_at is always written as an ISO instant in production (flows.json writes
  // `new Date().toISOString()` throughout).
  await db.run("UPDATE devices SET deleted_at=? WHERE deveui='0016C001F1000001'", [new Date().toISOString()]);
  const r = await W.runOnceTick({ db, now: new Date('2026-08-19T10:03:00Z'), warn: () => {} });
  assert.equal(r.fired.length, 0);
  assert.equal(r.skipped.length, 0);
  const row = await db.get("SELECT once_state FROM valve_schedules WHERE schedule_uuid='gone'");
  assert.equal(row.once_state, 'PENDING');
});

test('runObserveTick creates an on_valve_schedule expectation when OPEN inside a compiled window, unexplained otherwise', async () => {
  const { db } = await tempDb();
  // runObserveTick resolves local time via the device's irrigation zone timezone (d.zone_timezone),
  // not the schedule row's own timezone column, so the device must be assigned to a zone with the
  // matching IANA timezone for the window-hit check below to use Europe/Zurich local time.
  await db.run("INSERT INTO irrigation_zones(name, user_id, timezone) VALUES ('Zone Z', 1, 'Europe/Zurich')");
  const zone = await db.get("SELECT id FROM irrigation_zones WHERE name='Zone Z'");
  await db.run('UPDATE devices SET irrigation_zone_id=? WHERE deveui=?', [zone.id, '0016C001F1000001']);
  // valve reports OPEN at 06:10 local (Europe/Zurich) on a Wednesday; window Wed 06:00-06:30 exists
  await store.insertSchedule(db, { schedule_uuid: 'w', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: 'Morning', weekdays_mask: 1 << 3, start_time: '06:00', duration_minutes: 30, timezone: 'Europe/Zurich', enabled: 1 });
  await db.run("UPDATE devices SET current_state='OPEN' WHERE deveui='0016C001F1000001'");
  await db.run("INSERT INTO device_data(deveui, recorded_at) VALUES ('0016C001F1000001','2026-08-19T04:10:00.000Z')");
  const r = await W.runObserveTick({ db, now: new Date('2026-08-19T04:10:30Z'), warn: () => {} });
  assert.equal(r.created, 1);
  const e = await db.get("SELECT trigger, commanded_duration_seconds, reconciliation_state, volume_source FROM valve_actuation_expectations WHERE device_eui='0016C001F1000001'");
  assert.equal(e.trigger, 'on_valve_schedule'); assert.equal(e.commanded_duration_seconds, 1800); assert.equal(e.reconciliation_state, 'OBSERVED_RUNNING');
  // second tick does not duplicate
  assert.equal((await W.runObserveTick({ db, now: new Date('2026-08-19T04:11:30Z'), warn: () => {} })).created, 0);
});

test('runObserveTick: OPEN outside any window -> unexplained with 0 duration', async () => {
  const { db } = await tempDb();
  await db.run("UPDATE devices SET current_state='OPEN' WHERE deveui='0016C001F1000001'");
  await db.run("INSERT INTO device_data(deveui, recorded_at) VALUES ('0016C001F1000001','2026-08-19T15:00:00.000Z')");
  await W.runObserveTick({ db, now: new Date('2026-08-19T15:00:30Z'), warn: () => {} });
  const e = await db.get("SELECT trigger, commanded_duration_seconds FROM valve_actuation_expectations WHERE device_eui='0016C001F1000001'");
  assert.deepEqual({ ...e }, { trigger: 'unexplained', commanded_duration_seconds: 0 });
});

test('runObserveTick (I1): a STALE_OPEN_OBSERVED expectation still blocks a duplicate unexplained row', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, trigger, created_at) VALUES ('stale1','0016C001F1000001','2026-08-19T04:00:00.000Z',1800,'2026-08-19T04:30:00.000Z','unknown','STALE_OPEN_OBSERVED','on_valve_schedule','2026-08-19T04:00:00.000Z')");
  await db.run("UPDATE devices SET current_state='OPEN' WHERE deveui='0016C001F1000001'");
  await db.run("INSERT INTO device_data(deveui, recorded_at) VALUES ('0016C001F1000001','2026-08-19T04:40:00.000Z')");
  const r = await W.runObserveTick({ db, now: new Date('2026-08-19T04:40:30Z'), warn: () => {} });
  assert.equal(r.created, 0);
});

test('runClockTick queues a weekly GEN1 clock push and fails >24h queued pushes', async () => {
  const { db } = await tempDb();
  // runClockTick only considers valves with at least one active schedule (its valves query joins
  // on EXISTS valve_schedules); without this the device is invisible to the tick.
  await store.insertSchedule(db, { schedule_uuid: 's1', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  await store.upsertSettings(db, '0016C001F1000001', { last_clock_sync_queued_at: '2026-08-01T00:00:00.000Z' });
  await store.insertPushes(db, [{ push_id: 'stale', device_eui: '0016C001F1000001', purpose: 'WEEKDAY_PLAN', weekday: 0, fport: 14, payload_hex: 'FF'.repeat(24), plan_hash: 'h' }]);
  // queued_at is left at the DB's own datetime('now') default, then backdated with datetime()
  // arithmetic — matching how failStalePushes' own comparison must read this column.
  await db.run("UPDATE valve_schedule_pushes SET queued_at = datetime(queued_at, '-3 days') WHERE push_id='stale'");
  const r = await W.runClockTick({ db, now: new Date('2026-08-19T10:00:00Z'), appId: 'app', warn: () => {} });
  assert.equal(r.messages.length, 1); assert.equal(r.messages[0].payload.fPort, 12);
  assert.equal((await db.get("SELECT state FROM valve_schedule_pushes WHERE push_id='stale'")).state, 'FAILED');
});

test('runClockTick (I2) uses the schedule timezone, not the zone timezone, for the FPort 12 wall-clock payload', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO irrigation_zones(name, user_id, timezone) VALUES ('Zone UTC', 1, 'UTC')");
  const zone = await db.get("SELECT id FROM irrigation_zones WHERE name='Zone UTC'");
  await db.run('UPDATE devices SET irrigation_zone_id=? WHERE deveui=?', [zone.id, '0016C001F1000001']);
  await store.insertSchedule(db, { schedule_uuid: 'w', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, timezone: 'Europe/Zurich', enabled: 1 });
  const now = new Date('2026-08-19T10:00:00Z');
  const r = await W.runClockTick({ db, now, appId: 'app', warn: () => {} });
  assert.equal(r.messages.length, 1);
  const msg = r.messages[0];
  assert.equal(msg.payload.fPort, 12);
  const expected = P.gen1ClockPayload(now, 'Europe/Zurich').toString('base64');
  assert.equal(msg.payload.data, expected, 'must encode Europe/Zurich wall clock, not UTC (the zone tz)');
});

test('runHousekeeping resets SKIP_TODAY once the valve local date has moved past skip_today_date', async () => {
  const { db } = await tempDb();
  W._resetHousekeepingForTests();
  await store.upsertSettings(db, '0016C001F1000001', { scheduler_status: 'SKIP_TODAY', skip_today_date: '2026-08-19' });
  const same = await W.runHousekeeping({ db, now: new Date('2026-08-19T12:00:00Z'), appId: 'app', warn: () => {} });
  assert.equal(same.resets, 0);
  assert.equal((await store.getSettings(db, '0016C001F1000001')).scheduler_status, 'SKIP_TODAY');
  const next = await W.runHousekeeping({ db, now: new Date('2026-08-20T00:30:00Z'), appId: 'app', warn: () => {} });
  assert.equal(next.resets, 1);
  const s = await store.getSettings(db, '0016C001F1000001');
  assert.equal(s.scheduler_status, 'ACTIVE');
  assert.equal(s.skip_today_date, null);
});

test('runHousekeeping (C1) clock-jump detector tolerates the real 10-min tick cadence and only trips on a backward jump or a >6h forward gap', async () => {
  const { db } = await tempDb();
  W._resetHousekeepingForTests();
  const t0 = new Date('2026-08-19T10:00:00Z');
  const t1 = new Date('2026-08-19T10:10:00Z'); // +10 min: the real production tick period
  const r0 = await W.runHousekeeping({ db, now: t0, appId: 'app', warn: () => {} });
  assert.equal(r0.clockJump, false, 'first tick ever: nothing to compare against');
  const r1 = await W.runHousekeeping({ db, now: t1, appId: 'app', warn: () => {} });
  assert.equal(r1.clockJump, false, 'consecutive 10-min ticks must never trip the detector');
  const forward = new Date(t1.getTime() + 7 * 3600000);
  const r2 = await W.runHousekeeping({ db, now: forward, appId: 'app', warn: () => {} });
  assert.equal(r2.clockJump, true, 'a 7h forward gap exceeds any normal tick delay');
  const backward = new Date(forward.getTime() - 2 * 60000);
  const r3 = await W.runHousekeeping({ db, now: backward, appId: 'app', warn: () => {} });
  assert.equal(r3.clockJump, true, 'now moving 2min before the last tick is a backward jump');
});

test('runHousekeeping decommission sweep: soft-deleted device with an ACKED non-empty plan gets 7 empty pushes + FPort 21 "2"; second run is a no-op', async () => {
  const { db } = await tempDb();
  W._resetHousekeepingForTests();
  await store.insertPushes(db, [{ push_id: 'acked1', device_eui: '0016C001F1000001', purpose: 'WEEKDAY_PLAN', weekday: 2, fport: 16, payload_hex: '00'.repeat(24), plan_hash: 'a-real-plan-hash' }]);
  await db.run("UPDATE valve_schedule_pushes SET state='ACKED' WHERE push_id='acked1'");
  // deleted_at must be ISO on the SAME calendar day the sweep runs (not a fixed past-date
  // literal): the sweep's own newly-queued pushes get queued_at from the DB's datetime('now')
  // default (space-separated), so a deleted_at from a prior day would let the date portion
  // alone mask the 'T' vs ' ' string-comparison bug this test is meant to catch (C4). Backdated
  // a couple seconds (not exactly "now") only so this test's own deleted_at write and the
  // sweep's queued_at write can't land in the SAME whole second — SQLite's datetime() has
  // 1-second resolution, so an exact tie there would read as "not yet swept" on a technicality
  // that never happens in production (housekeeping ticks run 10 minutes apart, never in the
  // same second a device was just soft-deleted).
  const deletedAtIso = new Date(Date.now() - 2000).toISOString();
  await db.run("UPDATE devices SET deleted_at=? WHERE deveui='0016C001F1000001'", [deletedAtIso]);
  const now = new Date();
  const r1 = await W.runHousekeeping({ db, now, appId: 'app', warn: () => {} });
  assert.equal(r1.decommissioned, 1);
  assert.equal(r1.messages.length, 8);
  const weekdayMsgs = r1.messages.filter((m) => m.payload.fPort >= 14 && m.payload.fPort <= 20);
  assert.equal(weekdayMsgs.length, 7);
  const statusMsgs = r1.messages.filter((m) => m.payload.fPort === 21);
  assert.equal(statusMsgs.length, 1);
  assert.equal(Buffer.from(statusMsgs[0].payload.data, 'base64').toString('ascii'), '2');
  const r2 = await W.runHousekeeping({ db, now: new Date(now.getTime() + 3600000), appId: 'app', warn: () => {} });
  assert.equal(r2.decommissioned, 0);
  assert.equal(r2.messages.length, 0);
});

test('runTriggerBackfill: an actuator_log scheduler_ reason within +/-2 min -> trigger_based', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, created_at) VALUES ('e1','0016C001F1000001','2026-08-19T06:00:00.000Z',900,'2026-08-19T06:15:00.000Z','unknown','2026-08-19T06:00:00.000Z')");
  // actuator_log.created_at is ALWAYS written as an ISO instant in production (both writers in
  // flows.json use `new Date().toISOString()`; there is no code path that writes the DB's
  // space-separated datetime('now') form to this column), so the regression test must too.
  await db.run("INSERT INTO actuator_log(deveui, action, reason, created_at) VALUES ('0016C001F1000001','OPEN','scheduler_threshold','2026-08-19T06:01:00.000Z')");
  const r = await W.runTriggerBackfill({ db, warn: () => {} });
  assert.equal(r.updated, 1);
  assert.equal((await db.get("SELECT trigger FROM valve_actuation_expectations WHERE expectation_id='e1'")).trigger, 'trigger_based');
});

test('runTriggerBackfill: no evidence at all -> manual', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, created_at) VALUES ('e2','0016C001F1000001','2026-08-19T06:00:00.000Z',900,'2026-08-19T06:15:00.000Z','unknown','2026-08-19T06:00:00.000Z')");
  const r = await W.runTriggerBackfill({ db, warn: () => {} });
  assert.equal(r.updated, 1);
  assert.equal((await db.get("SELECT trigger FROM valve_actuation_expectations WHERE expectation_id='e2'")).trigger, 'manual');
});

test('runTriggerBackfill: command_id present in a one_time_open irrigation_events payload -> one_time', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO irrigation_zones(name, user_id) VALUES ('Zone A', 1)");
  const zone = await db.get("SELECT id FROM irrigation_zones WHERE name='Zone A'");
  await db.run("INSERT INTO irrigation_events(user_id, irrigation_zone_id, action, reason, duration_minutes, valve_deveui, payload_json, created_at) VALUES (1, ?, 'IRRIGATE', 'one_time_open', 20, '0016C001F1000001', ?, '2026-08-19T06:00:00.000Z')", [zone.id, JSON.stringify({ command_id: 'cmd-123' })]);
  await db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, created_at) VALUES ('e3','0016C001F1000001','cmd-123','2026-08-19T06:00:00.000Z',900,'2026-08-19T06:15:00.000Z','unknown','2026-08-19T06:00:00.000Z')");
  const r = await W.runTriggerBackfill({ db, warn: () => {} });
  assert.equal(r.updated, 1);
  assert.equal((await db.get("SELECT trigger FROM valve_actuation_expectations WHERE expectation_id='e3'")).trigger, 'one_time');
});

test('runTriggerBackfill: unknown-volume row backfilled from zone calibration flow rate (12.5 L/min x 1800s -> 375 L)', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO irrigation_zones(name, user_id) VALUES ('Zone B', 1)");
  const zone = await db.get("SELECT id FROM irrigation_zones WHERE name='Zone B'");
  await db.run("INSERT INTO zone_irrigation_calibration(zone_id, measured_flow_rate_lpm, measurement_method, measured_at, created_at, updated_at) VALUES (?, 12.5, 'meter', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')", [zone.id]);
  await db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, zone_id, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, trigger, created_at) VALUES ('e4','0016C001F1000001', ?, '2026-08-19T06:00:00.000Z',1800,'2026-08-19T06:32:00.000Z','unknown','OBSERVED_RUNNING','on_valve_schedule','2026-08-19T06:00:00.000Z')", [zone.id]);
  await W.runTriggerBackfill({ db, warn: () => {} });
  const row = await db.get("SELECT flow_rate_lpm, flow_rate_source, estimated_gross_liters, volume_source FROM valve_actuation_expectations WHERE expectation_id='e4'");
  assert.equal(row.flow_rate_lpm, 12.5);
  assert.equal(row.flow_rate_source, 'zone_calibration');
  assert.equal(row.estimated_gross_liters, 375);
  assert.equal(row.volume_source, 'estimated_duration_flow_rate');
});
