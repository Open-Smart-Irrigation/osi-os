'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDb } = require('./test-helpers');
const store = require('./store');

test('listValvesForUser: valve with no valve_settings row defaults to GEN1/ACTIVE (IMPORTANT 3)', async () => {
  const { db } = await tempDb();
  const rows = await store.listValvesForUser(db, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].strega_generation, 'GEN1');
  assert.equal(rows[0].scheduler_status, 'ACTIVE');
  db.close();
});

test('upsertSettings bumps sync_version when the patch touches a synced column (cloud full-parity Task P2-E1)', async () => {
  const { db } = await tempDb();
  await store.upsertSettings(db, '0016C001F1000001', { strega_generation: 'GEN2' });
  const row = await db.get('SELECT strega_generation, sync_version FROM valve_settings WHERE device_eui=?', ['0016C001F1000001']);
  assert.equal(row.strega_generation, 'GEN2');
  assert.equal(row.sync_version, 1, 'first synced-column write bumps sync_version from the column default 0 to 1');
});

test('upsertSettings does NOT bump sync_version for a clock-sync-bookkeeping-only patch (no synced column touched)', async () => {
  const { db } = await tempDb();
  await store.upsertSettings(db, '0016C001F1000001', { strega_generation: 'GEN2' }); // sync_version -> 1
  await store.upsertSettings(db, '0016C001F1000001', { last_clock_sync_queued_at: '2026-08-25T10:00:00.000Z' });
  const row = await db.get('SELECT last_clock_sync_queued_at, sync_version FROM valve_settings WHERE device_eui=?', ['0016C001F1000001']);
  assert.equal(row.last_clock_sync_queued_at, '2026-08-25T10:00:00.000Z', 'bookkeeping column is still written');
  assert.equal(row.sync_version, 1, 'a clock-sync-only write must not flood sync_outbox with irrelevant events');
});

test('upsertSettings bumps sync_version on every call that touches a synced column, even mixed with bookkeeping fields', async () => {
  const { db } = await tempDb();
  await store.upsertSettings(db, '0016C001F1000001', {
    scheduler_status: 'SKIP_TODAY',
    skip_today_date: '2026-08-25',
    last_clock_sync_acked_at: '2026-08-25T09:00:00.000Z',
  });
  const row = await db.get('SELECT scheduler_status, last_clock_sync_acked_at, sync_version FROM valve_settings WHERE device_eui=?', ['0016C001F1000001']);
  assert.equal(row.scheduler_status, 'SKIP_TODAY');
  assert.equal(row.last_clock_sync_acked_at, '2026-08-25T09:00:00.000Z');
  assert.equal(row.sync_version, 1);
});

test('supersedeQueued(DAYMASK_PLAN) supersedes only rows whose mask intersects the new push (CRITICAL 1)', async () => {
  const { db } = await tempDb();
  // Row A: mask 0x80 (all days) QUEUED
  await store.insertPushes(db, [{ push_id: 'a', device_eui: '0016C001F1000001', purpose: 'DAYMASK_PLAN', weekday: null, fport: 25, payload_hex: '8099151930', plan_hash: 'h1' }]);
  // Row B: mask 0x08 (Wed only, bit3) QUEUED — must NOT be touched by a Monday-only (bit1=0x02) supersede
  await store.insertPushes(db, [{ push_id: 'b', device_eui: '0016C001F1000001', purpose: 'DAYMASK_PLAN', weekday: null, fport: 25, payload_hex: '0899151930', plan_hash: 'h2' }]);
  await store.supersedeQueued(db, '0016C001F1000001', 'DAYMASK_PLAN', 0x02);
  const rows = await db.all('SELECT push_id, state FROM valve_schedule_pushes ORDER BY push_id');
  const byId = Object.fromEntries(rows.map((r) => [r.push_id, r.state]));
  assert.equal(byId.a, 'SUPERSEDED', '0x80 (all-days, treated as 0x7F) intersects Monday (bit1)');
  assert.equal(byId.b, 'QUEUED', '0x08 (Wed) does not intersect Monday (bit1)');
  db.close();
});

test('updateSchedule and softDeleteSchedule resolve with no return value (MINOR 6)', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 's1', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  const u = await store.updateSchedule(db, 's1', { label: 'x' }, '0016C001F1000001');
  assert.equal(u, undefined);
  const d = await store.softDeleteSchedule(db, 's1', '0016C001F1000001');
  assert.equal(d, undefined);
  db.close();
});

function workerFiresBetweenGuardAndUpdate(db, scheduleUuid) {
  let raced = false;
  return {
    get: (...args) => db.get(...args),
    all: (...args) => db.all(...args),
    run: async (sql, params) => {
      if (!raced && /^UPDATE valve_schedules SET/.test(sql) && sql.includes('fire_at')) {
        raced = true;
        await db.run("UPDATE valve_schedules SET once_state='FIRED', once_fired_at=? WHERE schedule_uuid=?", ['2026-08-19T10:00:00.000Z', scheduleUuid]);
      }
      return db.run(sql, params);
    },
  };
}

test('updateSchedule fences a worker firing between the guard and UPDATE', async () => {
  const { db } = await tempDb();
  const uuid = 'store-race-once';
  await store.insertSchedule(db, { schedule_uuid: uuid, device_eui: '0016C001F1000001', kind: 'ONCE', fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 5, timezone: 'UTC', enabled: 1 });
  await assert.rejects(
    () => store.updateSchedule(workerFiresBetweenGuardAndUpdate(db, uuid), uuid, { fire_at: '2026-08-19T11:00:00.000Z' }, '0016C001F1000001'),
    (error) => error && error.code === 'once_fire_at_immutable'
  );
  const row = await db.get('SELECT fire_at, once_state FROM valve_schedules WHERE schedule_uuid=?', [uuid]);
  assert.equal(row.fire_at, '2026-08-19T10:00:00.000Z');
  assert.equal(row.once_state, 'FIRED');
  db.close();
});

test('failStalePushes (C2) compares like-formatted timestamps: a fresh push survives a 24h ISO cutoff, a genuinely 25h-stale one fails', async () => {
  const { db } = await tempDb();
  await store.insertPushes(db, [{ push_id: 'fresh', device_eui: '0016C001F1000001', purpose: 'CLOCK_SYNC', weekday: null, fport: 12, payload_hex: '00', plan_hash: null }]);
  await store.insertPushes(db, [{ push_id: 'stale', device_eui: '0016C001F1000001', purpose: 'CLOCK_SYNC', weekday: null, fport: 13, payload_hex: '01', plan_hash: null }]);
  // Both rows get queued_at from the DB's own datetime('now') default (space-separated);
  // backdate 'stale' using the DB's own datetime() arithmetic so the column format used in the
  // regression matches what the schema actually writes, not an ISO literal it never would.
  await db.run("UPDATE valve_schedule_pushes SET queued_at = datetime(queued_at, '-25 hours') WHERE push_id='stale'");
  const cutoffIso = new Date(Date.now() - 24 * 3600000).toISOString();
  await store.failStalePushes(db, cutoffIso);
  const rows = await db.all('SELECT push_id, state FROM valve_schedule_pushes ORDER BY push_id');
  const byId = Object.fromEntries(rows.map((r) => [r.push_id, r.state]));
  assert.equal(byId.fresh, 'QUEUED', 'a just-queued push must not be failed by a same-day ISO cutoff');
  assert.equal(byId.stale, 'FAILED', 'a genuinely 25h-old push must still be caught');
  db.close();
});

test('failStalePushes (C2) discriminating case: a same-calendar-day, genuinely-fresh push must not be failed by naive string comparison', async () => {
  const { db } = await tempDb();
  // The two scenarios above still pass even on the unwrapped `queued_at < ?` comparison because
  // their calendar dates differ, so plain ASCII digit comparison of the 'YYYY-MM-DD' prefix
  // alone happens to give the right answer. The actual defect only shows up when queued_at
  // (space-separated) and the cutoff (ISO 'T'-separated) share the SAME calendar date: at the
  // date/time separator position, ' ' (0x20) sorts below 'T' (0x54) — below EVERY digit, in
  // fact — so any same-day space-form queued_at compares as "less than" a same-day ISO cutoff
  // REGARDLESS of the actual clock time that follows, silently failing pushes that are still
  // well within the 24h grace window (this is how "healthy pushes FAILED after ~90 min" showed
  // up in production: whenever `now - 24h` and a push's queued_at land on the same UTC date).
  await store.insertPushes(db, [{ push_id: 'same_day_fresh', device_eui: '0016C001F1000001', purpose: 'CLOCK_SYNC', weekday: null, fport: 12, payload_hex: '00', plan_hash: null }]);
  await db.run("UPDATE valve_schedule_pushes SET queued_at='2026-08-19 23:30:00' WHERE push_id='same_day_fresh'");
  // cutoff = 2026-08-19T23:00:00.000Z: the push above is queued 30 minutes AFTER this cutoff
  // (same calendar date), i.e. genuinely fresher than the 24h threshold, and must stay QUEUED.
  await store.failStalePushes(db, '2026-08-19T23:00:00.000Z');
  const row = await db.get("SELECT state FROM valve_schedule_pushes WHERE push_id='same_day_fresh'");
  assert.equal(row.state, 'QUEUED');
  db.close();
});

test('listValvesForUser recent_stale_state (minor a): an ISO-stamped STALE_* expectation from today is still found by the "last 1 day" filter', async () => {
  const { db } = await tempDb();
  const nowIso = new Date().toISOString();
  await db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, trigger, created_at) VALUES ('s1','0016C001F1000001', ?, 900, ?, 'unknown', 'STALE_NO_OBSERVATION', 'on_valve_schedule', ?)", [nowIso, nowIso, nowIso]);
  const rows = await store.listValvesForUser(db, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recent_stale_state, 'STALE_NO_OBSERVATION');
  db.close();
});

test('pushSummary (final-fix-wave IMPORTANT 1): GEN1 re-edit within the window counts the CURRENT plan slots, never the cumulative row count', async () => {
  const { db } = await tempDb();
  // Original plan: all 7 weekdays pushed and acked.
  const original = [];
  for (let d = 0; d < 7; d += 1) {
    original.push({ push_id: 'orig' + d, device_eui: '0016C001F1000001', purpose: 'WEEKDAY_PLAN', weekday: d, fport: 30 + d, payload_hex: '00', plan_hash: 'h1' });
  }
  await store.insertPushes(db, original);
  // Backdate so the re-edit below is unambiguously newer (queued_at has 1s resolution).
  await db.run("UPDATE valve_schedule_pushes SET queued_at = datetime(queued_at, '-1 minute') WHERE plan_hash='h1'");
  await db.run("UPDATE valve_schedule_pushes SET state='ACKED', acked_at=datetime('now') WHERE plan_hash='h1'");

  // The user edits the schedule: every weekday is recompiled and re-queued under a new hash.
  // supersedeQueued only touches QUEUED rows, so the old ACKED rows are left as history —
  // exactly the shape that produced the inflated "of 14" bug.
  const edited = [];
  for (let d = 0; d < 7; d += 1) {
    edited.push({ push_id: 'edit' + d, device_eui: '0016C001F1000001', purpose: 'WEEKDAY_PLAN', weekday: d, fport: 30 + d, payload_hex: '01', plan_hash: 'h2' });
  }
  await store.insertPushes(db, edited);

  const summary = await store.pushSummary(db, '0016C001F1000001');
  assert.equal(summary.queued, 7, 'the current (edited) plan is 7 fresh QUEUED rows, one per weekday slot');
  assert.equal(summary.acked, 0, 'the superseded ACKED rows from before the edit must not count');
  assert.equal(summary.failed, 0);
  assert.equal(summary.queued + summary.acked, 7, 'total must equal the current plan slot count (7), never the cumulative 14 rows across the edit');
  db.close();
});

test('pushSummary (final-fix-wave IMPORTANT 1): GEN2 daymask rows expand per-weekday-bit; only the latest row per weekday slot counts, mixed states allowed', async () => {
  const { db } = await tempDb();
  // Group A: all 7 days (0x7F), QUEUED then ACKED.
  await store.insertPushes(db, [{ push_id: 'g1', device_eui: '0016C001F1000001', purpose: 'DAYMASK_PLAN', weekday: null, fport: 25, payload_hex: '7f99151930', plan_hash: 'h1' }]);
  await db.run("UPDATE valve_schedule_pushes SET queued_at = datetime(queued_at, '-1 minute') WHERE plan_hash='h1'");
  await db.run("UPDATE valve_schedule_pushes SET state='ACKED', acked_at=datetime('now') WHERE plan_hash='h1'");
  // A partial regroup re-pushes only Sun+Mon (mask 0x03) under a new hash — newer queued_at.
  await store.insertPushes(db, [{ push_id: 'g2', device_eui: '0016C001F1000001', purpose: 'DAYMASK_PLAN', weekday: null, fport: 25, payload_hex: '0399151930', plan_hash: 'h2' }]);

  const summary = await store.pushSummary(db, '0016C001F1000001');
  // Slots 0,1 (Sun,Mon): latest row is g2, QUEUED. Slots 2-6: latest row is still g1, ACKED.
  assert.equal(summary.queued, 2, 'only the two regrouped weekday slots are QUEUED');
  assert.equal(summary.acked, 5, 'the five untouched weekday slots are still ACKED under the original group');
  assert.equal(summary.failed, 0);
  assert.equal(summary.queued + summary.acked, 7, 'exactly 7 weekday slots total, matching the schedule-dialog badge grouping');
  db.close();
});

test('pushSummary (final-fix-wave IMPORTANT 1): CLOCK_SYNC/SCHEDULER_STATUS pushes never count toward the plan-delivery ratio', async () => {
  const { db } = await tempDb();
  const plan = [];
  for (let d = 0; d < 7; d += 1) {
    plan.push({ push_id: 'plan' + d, device_eui: '0016C001F1000001', purpose: 'WEEKDAY_PLAN', weekday: d, fport: 30 + d, payload_hex: '00', plan_hash: 'h1' });
  }
  await store.insertPushes(db, plan);
  await store.insertPushes(db, [
    { push_id: 'clock1', device_eui: '0016C001F1000001', purpose: 'CLOCK_SYNC', weekday: null, fport: 12, payload_hex: '00', plan_hash: null },
    { push_id: 'status1', device_eui: '0016C001F1000001', purpose: 'SCHEDULER_STATUS', weekday: null, fport: 21, payload_hex: '01', plan_hash: null },
  ]);
  await db.run("UPDATE valve_schedule_pushes SET state='ACKED', acked_at=datetime('now') WHERE purpose IN ('CLOCK_SYNC','SCHEDULER_STATUS')");

  const summary = await store.pushSummary(db, '0016C001F1000001');
  assert.equal(summary.queued, 7, 'the 7 WEEKDAY_PLAN slots are still QUEUED');
  assert.equal(summary.acked, 0, 'CLOCK_SYNC/SCHEDULER_STATUS pushes must not be mixed into the plan-delivery count');
  db.close();
});

test('pushSummary (final-fix-wave IMPORTANT 1): last_plan_queued_at/last_plan_acked_at keep their prior (unfiltered-by-slot) semantics', async () => {
  const { db } = await tempDb();
  await store.insertPushes(db, [{ push_id: 'a', device_eui: '0016C001F1000001', purpose: 'WEEKDAY_PLAN', weekday: 0, fport: 30, payload_hex: '00', plan_hash: 'h1' }]);
  const ackAt = new Date().toISOString();
  await db.run("UPDATE valve_schedule_pushes SET transport_json=?", [JSON.stringify({ phase: 'ATTEMPTED', attempted_at: new Date(Date.parse(ackAt) - 60000).toISOString() })]);
  await store.ackPush(db, '0016C001F1000001', 'WEEKDAY_PLAN', 30, 0, 0, ackAt);
  const summary = await store.pushSummary(db, '0016C001F1000001');
  assert.ok(summary.last_plan_queued_at, 'last_plan_queued_at must still be populated');
  assert.ok(summary.last_plan_acked_at, 'last_plan_acked_at must still be populated');
  db.close();
});

test('pushSummary (PR-H): the 30-day lookback is computed against an injected `now`, not SQLite\'s own wall clock', async () => {
  const { db } = await tempDb();
  // Fixture `now` is deliberately far from the real wall clock: with the old bare
  // datetime('now','-30 day') filter, a row backdated relative to THIS `now` would be judged
  // against the REAL current time instead and silently disappear/reappear depending only on
  // how far the real clock has drifted from the fixture -- exactly workers.test.js's P3-E1
  // runClockTick regression.
  const now = new Date('2020-01-19T10:00:00Z');
  await store.insertPushes(db, [{ push_id: 'p1', device_eui: '0016C001F1000001', purpose: 'WEEKDAY_PLAN', weekday: 0, fport: 30, payload_hex: '00', plan_hash: 'h1' }]);
  await db.run("UPDATE valve_schedule_pushes SET queued_at = datetime('2020-01-19 10:00:00', '-3 days') WHERE push_id='p1'");

  const summary = await store.pushSummary(db, '0016C001F1000001', now);
  assert.equal(summary.queued, 1, 'a row 3 days before the injected now must count against ITS window');

  // A second row 31 days before that SAME injected now must be excluded from it.
  await store.insertPushes(db, [{ push_id: 'p2', device_eui: '0016C001F1000001', purpose: 'WEEKDAY_PLAN', weekday: 1, fport: 31, payload_hex: '00', plan_hash: 'h2' }]);
  await db.run("UPDATE valve_schedule_pushes SET queued_at = datetime('2020-01-19 10:00:00', '-31 days') WHERE push_id='p2'");
  const summary2 = await store.pushSummary(db, '0016C001F1000001', now);
  assert.equal(summary2.queued, 1, 'the 31-day-old row must stay excluded by the injected now, regardless of the real wall clock');

  // The documented contract accepts an ISO string too, not only a Date instance.
  const summary3 = await store.pushSummary(db, '0016C001F1000001', now.toISOString());
  assert.equal(summary3.queued, 1, 'an ISO string `now` must behave identically to a Date `now`');
  db.close();
});

test('pushSummary: with no `now` argument, defaults to the real wall clock (unchanged behaviour for existing callers)', async () => {
  const { db } = await tempDb();
  await store.insertPushes(db, [{ push_id: 'fresh', device_eui: '0016C001F1000001', purpose: 'WEEKDAY_PLAN', weekday: 0, fport: 30, payload_hex: '00', plan_hash: 'h1' }]);
  const summary = await store.pushSummary(db, '0016C001F1000001');
  assert.equal(summary.queued, 1, 'a just-inserted row must count under the default real-wall-clock window');
  db.close();
});

test('getGatewaySetting (FW-T5): returns the stored value when the key is present', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO app_settings(key, value) VALUES ('gateway_timezone', 'Europe/Zurich')");
  assert.equal(await store.getGatewaySetting(db, 'gateway_timezone'), 'Europe/Zurich');
  db.close();
});

test('getGatewaySetting (FW-T5): returns null when the table exists but the key is absent', async () => {
  const { db } = await tempDb();
  assert.equal(await store.getGatewaySetting(db, 'gateway_timezone'), null);
  db.close();
});

test('getGatewaySetting (FW-T5): table-missing-safe — returns null instead of throwing on a pre-migration DB', async () => {
  const { db, raw } = await tempDb();
  raw.exec('DROP TABLE app_settings');
  assert.equal(await store.getGatewaySetting(db, 'gateway_timezone'), null);
  db.close();
});

// (review R2, NEW-MAJOR-3) VALVE_LIST_SQL's enclosure subqueries are bounded to a 7-day
// recency window measured against wall-clock `now` (review R1, MAJOR-1). A fixture pinned to
// a hardcoded calendar date ages out of that window the day the calendar catches up to it,
// turning the suite red with no commit to blame. Anchor every enclosure fixture below to
// `Date.now()`, the same pattern the pre-existing `nowIso` fixture above (guarding
// `recent_stale_state`'s own `datetime('now','-1 day')` predicate) already uses.
test('listValvesForUser: enclosure reading comes from the newest non-null row per column, not the newest row overall', async () => {
  const { db } = await tempDb();
  const readingIso = new Date(Date.now() - 10 * 3600000).toISOString();
  const nullRowIso = new Date(Date.now() - 9 * 3600000).toISOString();
  await db.run("INSERT INTO device_data (deveui, recorded_at, ambient_temperature, relative_humidity) VALUES ('0016C001F1000001', ?, 21.5, 48.2)", [readingIso]);
  // Newest row overall is a state-only uplink (both columns null) and must not blank out the reading above.
  await db.run("INSERT INTO device_data (deveui, recorded_at, ambient_temperature, relative_humidity) VALUES ('0016C001F1000001', ?, NULL, NULL)", [nullRowIso]);
  const [valve] = await store.listValvesForUser(db, 1);
  assert.equal(valve.enclosure_temperature_c, 21.5);
  assert.equal(valve.enclosure_humidity_pct, 48.2);
  assert.equal(valve.enclosure_measured_at, readingIso);
  db.close();
});

test('listValvesForUser: enclosure reading is null when no device_data row ever carried one', async () => {
  const { db } = await tempDb();
  const rowIso = new Date(Date.now() - 10 * 3600000).toISOString();
  await db.run("INSERT INTO device_data (deveui, recorded_at) VALUES ('0016C001F1000001', ?)", [rowIso]);
  const [valve] = await store.listValvesForUser(db, 1);
  assert.equal(valve.enclosure_temperature_c, null);
  assert.equal(valve.enclosure_humidity_pct, null);
  assert.equal(valve.enclosure_measured_at, null);
  db.close();
});

test('listValvesForUser: a valve that reports temperature but not humidity keeps the temperature instead of dropping both', async () => {
  const { db } = await tempDb();
  const readingIso = new Date(Date.now() - 10 * 3600000).toISOString();
  await db.run("INSERT INTO device_data (deveui, recorded_at, ambient_temperature, relative_humidity) VALUES ('0016C001F1000001', ?, 19.4, NULL)", [readingIso]);
  const [valve] = await store.listValvesForUser(db, 1);
  assert.equal(valve.enclosure_temperature_c, 19.4);
  assert.equal(valve.enclosure_humidity_pct, null);
  assert.equal(valve.enclosure_measured_at, readingIso);
  db.close();
});

test('listValvesForUser (review R1, MINOR-1/2): temperature from an older row and humidity from a newer row are both returned, each from its own row, and enclosure_measured_at is the newer of the two (MAX, not MIN)', async () => {
  const { db } = await tempDb();
  const temperatureIso = new Date(Date.now() - 12 * 3600000).toISOString();
  const humidityIso = new Date(Date.now() - 9 * 3600000).toISOString();
  await db.run("INSERT INTO device_data (deveui, recorded_at, ambient_temperature, relative_humidity) VALUES ('0016C001F1000001', ?, 17.25, NULL)", [temperatureIso]);
  await db.run("INSERT INTO device_data (deveui, recorded_at, ambient_temperature, relative_humidity) VALUES ('0016C001F1000001', ?, NULL, 61.5)", [humidityIso]);
  const [valve] = await store.listValvesForUser(db, 1);
  assert.equal(valve.enclosure_temperature_c, 17.25, 'temperature subquery finds its own newest non-null row, independent of the humidity row');
  assert.equal(valve.enclosure_humidity_pct, 61.5, 'humidity subquery finds its own newest non-null row, independent of the temperature row');
  assert.equal(valve.enclosure_measured_at, humidityIso, 'MAX over either-column-non-null rows must pick the newer (humidity) row, not the older (temperature) one a MIN regression would report');
  db.close();
});

test('listValvesForUser (review R2, NEW-MINOR): the recency window boundary itself — a reading 2h old is present in all three fields, a reading 8d old is absent in all three', async () => {
  const { db } = await tempDb();
  // A second valve, so the two ages can be checked in isolation rather than one row shadowing
  // the other on the same deveui.
  await db.run("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES ('0016C001F1000002','Valve B','STREGA_VALVE',1,datetime('now'),datetime('now'))");
  const recentIso = new Date(Date.now() - 2 * 3600000).toISOString(); // well inside the 7-day window
  const staleIso = new Date(Date.now() - 8 * 24 * 3600000).toISOString(); // outside it
  await db.run("INSERT INTO device_data (deveui, recorded_at, ambient_temperature, relative_humidity) VALUES ('0016C001F1000001', ?, 22.5, 55.0)", [recentIso]);
  await db.run("INSERT INTO device_data (deveui, recorded_at, ambient_temperature, relative_humidity) VALUES ('0016C001F1000002', ?, 22.5, 55.0)", [staleIso]);
  const rows = await store.listValvesForUser(db, 1);
  const recent = rows.find((r) => r.deveui === '0016C001F1000001');
  const stale = rows.find((r) => r.deveui === '0016C001F1000002');
  assert.equal(recent.enclosure_temperature_c, 22.5, 'a reading 2h old sits well inside the 7-day window and must be present');
  assert.equal(recent.enclosure_humidity_pct, 55.0, 'a reading 2h old sits well inside the 7-day window and must be present');
  assert.equal(recent.enclosure_measured_at, recentIso);
  assert.equal(stale.enclosure_temperature_c, null, 'a reading 8 days old sits outside the 7-day window and must report absent, not stale-but-shown (widening the window to e.g. 700 days would leave this false)');
  assert.equal(stale.enclosure_humidity_pct, null, 'a reading 8 days old sits outside the 7-day window and must report absent, not stale-but-shown');
  assert.equal(stale.enclosure_measured_at, null, 'a reading 8 days old sits outside the 7-day window and must report absent, not stale-but-shown');
  db.close();
});

test('getGatewaySetting (FW-T5 review R1, m6): swallows a non-table-missing read error too, warning instead of throwing', async () => {
  // Unified policy: a scheduled worker tick (runObserveTick/runClockTick/runHousekeeping)
  // has no enclosing try/catch around this one call, so ANY read failure — not just a
  // missing table — must resolve to null instead of aborting the whole tick.
  const warnings = [];
  const fakeDb = { get: async () => { throw new Error('SQLITE_BUSY: database is locked'); } };
  const result = await store.getGatewaySetting(fakeDb, 'gateway_timezone', (m) => warnings.push(m));
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /gateway_timezone read failed:.*SQLITE_BUSY/);
});

// F135. Customer test gateway harness run 5, case V2 check #18: GET /api/valves reported
// {"queued":0,"acked":7} while the ledger held three QUEUED plan pushes, so the one
// question the check exists to answer -- "did this valve ever answer?" -- came back
// wrong. The ledger was never wrong; the newest-per-slot collapse was. queued_at is
// written only by the column default `datetime('now')`, i.e. whole seconds, and
// pushSummary ordered by it alone, so two recompiles landing in the same second left
// the winner to an unstable sort. The V2 case does exactly that: a NACKed recompile
// at 14:00:13.657 and a dropped-ACK recompile at 14:00:13.98 shared queued_at
// '2026-09-17 14:00:13', and the older ACKED rows won all three slots. It passed in
// runs 2-4 and failed twice in run 5 on byte-identical code, which is the signature
// of an ordering tie rather than a regression.
//
// The tie is written as fixed values, not taken from the wall clock. An earlier version
// copied one h2 row's datetime('now') onto the h3 rows; when the three h2 inserts
// straddled a second boundary (n0 at :09, n1 and n2 at :10), the h3 rows got :09 and the
// "tie" became an h3 row one second OLDER than the h2 row it was meant to tie with, so
// the slot correctly went to h2 and the test failed (once in CI). Fixed timestamps make
// the fixture describe one situation on every run.
const F135_EARLIER = '2026-09-17 13:59:13';
const F135_TIE = '2026-09-17 14:00:13';
const F135_NOW = new Date('2026-09-17T14:00:14Z');

async function seedSameSecondRecompile(db, store) {
  const plan = [];
  for (let d = 0; d < 7; d += 1) {
    plan.push({ push_id: 'p' + d, device_eui: '0016C001F1000001', purpose: 'WEEKDAY_PLAN', weekday: d, fport: 30 + d, payload_hex: '00', plan_hash: 'h1' });
  }
  await store.insertPushes(db, plan);
  await db.run("UPDATE valve_schedule_pushes SET queued_at = ?, state='ACKED', acked_at=? WHERE plan_hash='h1'", [F135_EARLIER, F135_EARLIER]);

  // Recompile one: answered, so these rows end ACKED.
  const nacked = [];
  for (let d = 0; d < 3; d += 1) {
    nacked.push({ push_id: 'n' + d, device_eui: '0016C001F1000001', purpose: 'WEEKDAY_PLAN', weekday: d, fport: 30 + d, payload_hex: '01', plan_hash: 'h2' });
  }
  await store.insertPushes(db, nacked);
  await db.run("UPDATE valve_schedule_pushes SET queued_at = ?, state='ACKED', acked_at=? WHERE plan_hash='h2'", [F135_TIE, F135_TIE]);

  // Recompile two, same wall-clock second, never answered: these are the rows an
  // operator must see as outstanding.
  const dropped = [];
  for (let d = 0; d < 3; d += 1) {
    dropped.push({ push_id: 'q' + d, device_eui: '0016C001F1000001', purpose: 'WEEKDAY_PLAN', weekday: d, fport: 30 + d, payload_hex: '02', plan_hash: 'h3' });
  }
  await store.insertPushes(db, dropped);
  await db.run("UPDATE valve_schedule_pushes SET queued_at = ? WHERE plan_hash='h3'", [F135_TIE]);
}

test('pushSummary (F135): when two recompiles share a queued_at second, the later one owns the slot', async () => {
  const { db } = await tempDb();
  await seedSameSecondRecompile(db, store);

  const summary = await store.pushSummary(db, '0016C001F1000001', F135_NOW);
  assert.equal(summary.queued, 3, 'the three unanswered slots must be reported as queued');
  assert.equal(summary.acked, 4, 'only the four untouched weekdays are still acked');
  db.close();
});

test('weekdayPushStates (F135): the same tie must not hand a slot to the older row', async () => {
  const { db } = await tempDb();
  await seedSameSecondRecompile(db, store);

  const rows = await store.weekdayPushStates(db, '0016C001F1000001');
  const firstByWeekday = new Map();
  for (const row of rows) {
    if (!firstByWeekday.has(row.weekday)) firstByWeekday.set(row.weekday, row.state);
  }
  // runtime.js consumes these rows first-seen-per-weekday, so the ordering has to be
  // decided here, not by whichever row the sorter happens to emit first.
  assert.equal(firstByWeekday.get(0), 'QUEUED');
  assert.equal(firstByWeekday.get(1), 'QUEUED');
  assert.equal(firstByWeekday.get(2), 'QUEUED');
  assert.equal(firstByWeekday.get(6), 'ACKED');
  db.close();
});

// A gateway clock that steps backwards (a clock set ahead and then corrected by NTP, a
// restore from a wrong RTC; runHousekeeping already detects such jumps) stamps a LATER push
// with an EARLIER queued_at, because queued_at is only ever the wall clock at insert time.
// The ledger's insertion order is what the valve saw last (ChirpStack delivers FIFO), so
// "newest per slot" must follow insertion order, not the clock. Each case below inserts
// 'ahead' first under a clock 5 minutes fast, then 'behind' after the clock was corrected,
// and acks 'ahead' late, after 'behind' exists, to show a state change on the older row
// does not move it either.
const STEP_EUI = '0016C001F1000001';
const STEP_AHEAD = '2026-09-17 14:05:00';
const STEP_BEHIND = '2026-09-17 14:00:00';

async function seedClockStepBack(db, purpose, { aheadPayload, behindPayload, aheadState = 'ACKED' } = {}) {
  const weekday = purpose === 'WEEKDAY_PLAN' ? 1 : null;
  const fport = purpose === 'WEEKDAY_PLAN' ? 15 : 25;
  await store.insertPushes(db, [{ push_id: 'ahead', device_eui: STEP_EUI, purpose, weekday, fport, payload_hex: aheadPayload || '00', plan_hash: 'h-ahead' }]);
  await db.run("UPDATE valve_schedule_pushes SET queued_at=? WHERE push_id='ahead'", [STEP_AHEAD]);
  await store.insertPushes(db, [{ push_id: 'behind', device_eui: STEP_EUI, purpose, weekday, fport, payload_hex: behindPayload || '01', plan_hash: 'h-behind' }]);
  await db.run("UPDATE valve_schedule_pushes SET queued_at=? WHERE push_id='behind'", [STEP_BEHIND]);
  if (aheadState === 'ACKED') {
    await db.run("UPDATE valve_schedule_pushes SET state='ACKED', acked_at=? WHERE push_id='ahead'", ['2026-09-17T14:01:00.000Z']);
  }
}

test('clock step back: weekdayPushStates hands the slot to the later insert, not the later timestamp', async () => {
  const { db } = await tempDb();
  await seedClockStepBack(db, 'WEEKDAY_PLAN');
  const rows = await store.weekdayPushStates(db, STEP_EUI);
  assert.equal(rows[0].queued_at, STEP_BEHIND, 'the push queued after the clock was corrected is the newest');
  assert.equal(rows[0].state, 'QUEUED');
  db.close();
});

test('clock step back: pushSummary counts the later insert for the slot', async () => {
  const { db } = await tempDb();
  await seedClockStepBack(db, 'WEEKDAY_PLAN');
  const summary = await store.pushSummary(db, STEP_EUI, new Date('2026-09-17T14:01:00Z'));
  assert.equal(summary.queued, 1, 'the plan the valve has not confirmed yet is outstanding');
  assert.equal(summary.acked, 0, 'the earlier plan the valve confirmed is no longer what it should hold');
  db.close();
});

// B-2 (night run) changed which row an ACK settles: ChirpStack delivers the queue first in,
// first out, so the ACK belongs to the EARLIER insert, not the newest (newest-first credited
// an old plan's ACK to a newer revision). Insertion order still decides, not queued_at: the
// earlier insert carries the later timestamp here.
test('clock step back: ackPush settles the earlier QUEUED insert (first in, first out) when two are outstanding for the same purpose and port', async () => {
  const { db } = await tempDb();
  // GEN2 rows with disjoint masks are not superseded by each other, so both stay QUEUED.
  await seedClockStepBack(db, 'DAYMASK_PLAN', { aheadPayload: '0499151930', behindPayload: '0299151930', aheadState: 'QUEUED' });
  await db.run("UPDATE valve_schedule_pushes SET transport_json=? WHERE push_id='ahead'", [JSON.stringify({ phase: 'ACCEPTED', queue_id: 'q-ahead', attempted_at: '2026-09-17T14:01:00.000Z' })]);
  await db.run("UPDATE valve_schedule_pushes SET transport_json=? WHERE push_id='behind'", [JSON.stringify({ phase: 'ACCEPTED', queue_id: 'q-behind', attempted_at: '2026-09-17T14:01:00.000Z' })]);
  await store.upsertSettings(db, STEP_EUI, { strega_generation: 'GEN2' });
  assert.equal(await store.ackPush(db, STEP_EUI, 'DAYMASK_PLAN', 25, null, 1, '2026-09-17T14:02:00.000Z'), 1);
  const byId = Object.fromEntries((await db.all('SELECT push_id, state FROM valve_schedule_pushes')).map((r) => [r.push_id, r.state]));
  assert.equal(byId.ahead, 'ACKED');
  assert.equal(byId.behind, 'QUEUED');
  db.close();
});

// Guards for the invariant the reads above rely on: rowid order is insertion order. Each of
// these changes would silently break it: a WITHOUT ROWID or INTEGER PRIMARY KEY table (no
// rowid, or a caller-chosen one), REPLACE/DELETE on the ledger, or a migration that rebuilds
// the table and copies rows without their rowid (the copy renumbers them in scan order).
test('push ledger invariant: the table keeps an implicit rowid that grows with every insert', async () => {
  const { db } = await tempDb();
  const ddl = (await db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='valve_schedule_pushes'")).sql;
  assert.doesNotMatch(ddl, /WITHOUT\s+ROWID/i);
  const intPk = (await db.all('PRAGMA table_info(valve_schedule_pushes)')).filter((c) => c.pk > 0 && /^INTEGER$/i.test(c.type));
  assert.deepEqual(intPk, [], 'an INTEGER PRIMARY KEY column would alias rowid to a caller-written value');
  const row = (id) => ({ push_id: id, device_eui: STEP_EUI, purpose: 'CLOCK_SYNC', weekday: null, fport: 12, payload_hex: '00', plan_hash: null });
  await store.insertPushes(db, [row('i1'), row('i2'), row('i3')]);
  await db.run("DELETE FROM valve_schedule_pushes WHERE push_id='i3'"); // the newest row gone: its rowid may be reused
  await store.insertPushes(db, [row('i4')]);
  const ids = (await db.all('SELECT push_id FROM valve_schedule_pushes ORDER BY rowid')).map((r) => r.push_id);
  assert.deepEqual(ids, ['i1', 'i2', 'i4'], 'a new insert sorts after every existing row');
  db.close();
});

test('push ledger invariant: no product code replaces or deletes ledger rows, and no migration copies the table without its rowid', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.js') && !n.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.doesNotMatch(src, /(REPLACE\s+INTO|DELETE\s+FROM)\s+valve_schedule_pushes\b/i, f + ' must keep the push ledger append-only');
  }
  let root = __dirname;
  while (!fs.existsSync(path.join(root, 'database/migrations/ordered'))) {
    const up = path.dirname(root);
    assert.notEqual(up, root, 'database/migrations/ordered not found above ' + __dirname);
    root = up;
  }
  const dir = path.join(root, 'database/migrations/ordered');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(';')) {
      if (!/valve_schedule_pushes/i.test(stmt)) continue;
      assert.doesNotMatch(stmt, /(REPLACE\s+INTO|DELETE\s+FROM)\s+valve_schedule_pushes\b/i, f);
      if (/INSERT\s+(OR\s+\w+\s+)?INTO[\s\S]*\bSELECT\b/i.test(stmt)) {
        assert.match(stmt, /\browid\b/i, f + ': a rebuild of valve_schedule_pushes must copy rowid (INSERT INTO new(rowid, ...) SELECT rowid, ...)');
      }
    }
  }
});

// --- F144: updateSchedule/softDeleteSchedule are scoped to the owning valve ---
// One gateway, one valve_schedules table: every writer must name the valve it means, so a
// caller that passes the wrong (or no) EUI writes nothing instead of hitting another valve's
// row through the globally UNIQUE schedule_uuid.
const F144_A = '0016C001F1000001';
const F144_B = '0016C001F1000002';

async function seedTwoValves(db) {
  await db.run("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES (?,'Valve B','STREGA_VALVE',1,datetime('now'),datetime('now'))", [F144_B]);
  await store.insertSchedule(db, { schedule_uuid: 'f144-a', device_eui: F144_A, kind: 'WEEKLY', label: 'A', weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
}

test('F144: updateSchedule writes nothing when the EUI scope names a different valve', async () => {
  const { db } = await tempDb();
  await seedTwoValves(db);
  const before = await db.get('SELECT * FROM valve_schedules WHERE schedule_uuid=?', ['f144-a']);
  await store.updateSchedule(db, 'f144-a', { label: 'stolen' }, F144_B);
  const after = await db.get('SELECT * FROM valve_schedules WHERE schedule_uuid=?', ['f144-a']);
  assert.deepEqual(after, before, 'not even sync_version/updated_at may move');
  db.close();
});

test('F144: softDeleteSchedule deletes nothing when the EUI scope names a different valve', async () => {
  const { db } = await tempDb();
  await seedTwoValves(db);
  await store.softDeleteSchedule(db, 'f144-a', F144_B);
  const row = await db.get('SELECT deleted_at, sync_version FROM valve_schedules WHERE schedule_uuid=?', ['f144-a']);
  assert.equal(row.deleted_at, null);
  db.close();
});

test('F144: the owning EUI (in either case) still updates and soft-deletes', async () => {
  const { db } = await tempDb();
  await seedTwoValves(db);
  await store.updateSchedule(db, 'f144-a', { label: 'mine' }, F144_A.toLowerCase());
  assert.equal((await db.get('SELECT label FROM valve_schedules WHERE schedule_uuid=?', ['f144-a'])).label, 'mine');
  await store.softDeleteSchedule(db, 'f144-a', F144_A);
  assert.ok((await db.get('SELECT deleted_at FROM valve_schedules WHERE schedule_uuid=?', ['f144-a'])).deleted_at);
  db.close();
});

test('F144: a schedule write with no EUI scope throws instead of falling back to uuid-only matching', async () => {
  const { db } = await tempDb();
  await seedTwoValves(db);
  await assert.rejects(() => store.updateSchedule(db, 'f144-a', { label: 'x' }), /deviceEui/);
  await assert.rejects(() => store.softDeleteSchedule(db, 'f144-a'), /deviceEui/);
  const row = await db.get('SELECT label, deleted_at FROM valve_schedules WHERE schedule_uuid=?', ['f144-a']);
  assert.equal(row.label, 'A');
  assert.equal(row.deleted_at, null);
  db.close();
});

test('report-only rows are skipped before active projection selection so an older command owner remains visible', async () => {
  const { db } = await tempDb();
  const commandTransport = JSON.stringify({ phase: 'ATTEMPTED', effect_snapshot: { effect_class: 'SELF_CLOSING_OPEN', future_effect_end: '2026-10-18T11:30:00.000Z' } });
  const reportTransport = JSON.stringify({ physical_run: { version: 1, source: 'explicit_report', earliest_possible_start_at: null, latest_possible_end_at: null } });
  const insert = `INSERT INTO valve_actuation_expectations
    (expectation_id,device_eui,command_id,commanded_at,commanded_duration_seconds,expected_close_at,volume_source,reconciliation_state,trigger,transport_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`;
  await db.run(insert, ['command-owner', '0016C001F1000001', 'cmd-owner', '2026-10-18T10:00:00.000Z', 120, '2026-10-18T10:02:00.000Z', 'unknown', 'OBSERVED_RUNNING', 'one_time', commandTransport, '2026-10-18T10:00:00.000Z']);
  await db.run(insert, ['report-newer', '0016C001F1000001', null, '2026-10-18T11:00:00.000Z', -1, '', 'unknown', 'OBSERVED_RUNNING', 'unexplained', reportTransport, '2026-10-18T11:00:00.000Z']);
  const [valve] = await store.listValvesForUser(db, 1);
  assert.equal(valve.active_expectation_id, 'command-owner');
  assert.equal((await store.activeActuation(db, '0016C001F1000001')).expectation_id, 'command-owner');
  db.close();
});

test('CMD-04 PR0: the 24 h sweep makes plan and status rows LOST (clock rows plain FAILED); a LOST slot stays in pushSummary past the 30-day window', async () => {
  const { db } = await tempDb();
  const eui = require('./test-helpers').FIXTURE_EUI;
  await store.insertPushes(db, [
    { push_id: 'old-lost', device_eui: eui, purpose: 'WEEKDAY_PLAN', weekday: 1, fport: 15, payload_hex: 'FF', plan_hash: 'h1' },
    { push_id: 'old-acked', device_eui: eui, purpose: 'WEEKDAY_PLAN', weekday: 2, fport: 16, payload_hex: 'FF', plan_hash: 'h2' },
    { push_id: 'status', device_eui: eui, purpose: 'SCHEDULER_STATUS', weekday: null, fport: 21, payload_hex: '30', plan_hash: null },
    { push_id: 'clock', device_eui: eui, purpose: 'CLOCK_SYNC', weekday: null, fport: 12, payload_hex: '00', plan_hash: null },
    { push_id: 'superseded', device_eui: eui, purpose: 'WEEKDAY_PLAN', weekday: 3, fport: 17, payload_hex: 'FF', plan_hash: 'h3' },
  ]);
  await db.run("UPDATE valve_schedule_pushes SET queued_at='2026-06-01 10:00:00'");
  await db.run("UPDATE valve_schedule_pushes SET state='ACKED', acked_at='2026-06-01T10:05:00.000Z' WHERE push_id='old-acked'");
  await db.run("UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE push_id='superseded'");
  await store.failStalePushes(db, '2026-06-02T10:00:00.000Z');
  const byId = Object.fromEntries((await db.all('SELECT push_id, state, error FROM valve_schedule_pushes')).map((r) => [r.push_id, [r.state, r.error]]));
  assert.deepEqual(byId, {
    'old-lost': ['FAILED', 'stale_unconfirmed'], 'old-acked': ['ACKED', null], status: ['FAILED', 'stale_unconfirmed'],
    clock: ['FAILED', 'no_ack_24h'], superseded: ['SUPERSEDED', null],
  });
  const summary = await store.pushSummary(db, eui, new Date('2026-09-01T00:00:00Z'));
  assert.equal(summary.lost, 1, 'a lost plan is never silently expired');
  assert.equal(summary.failed, 1);
  assert.equal(summary.acked, 0, 'the 30-day window still bounds the other counts');
  assert.equal(summary.scheduler_status_lost, true);
  const states = await store.weekdayPushStates(db, eui);
  assert.equal(states.find((r) => r.weekday === 1).state, 'LOST');
  assert.equal(states.find((r) => r.weekday === 1).error, 'stale_unconfirmed');
  assert.equal(states.find((r) => r.weekday === 2).state, 'ACKED');
  assert.equal(states.some((r) => r.weekday === 3), false, 'SUPERSEDED rows are not surfaced');
  db.close();
});

// --- Night-run conformance fix (B-2; CMD-04 "an old ACK cannot verify a newer revision").
// A STREGA ACK echoes only the port (GEN1 weekday ports 14-20, GEN2 port 25 for every group)
// and a status; it carries no payload or hash. ChirpStack delivers a device queue first in,
// first out, so an ACK is credited to the OLDEST outstanding handed-off row on that port, and
// only when nothing older could also own it. When an older row may have been delivered (it
// left the queue before a flush, or its handoff is unknown), the ACK cannot tell the rows
// apart: the older row consumes the ACK as ambiguous and the newer one is annotated
// 'ack_ambiguous' and stays unconfirmed, never ACKED (LOST only if the 24-hour sweep finds it so).
const B2_EUI = STEP_EUI; // the valve tempDb() seeds

async function b2Push(db, { id, purpose = 'DAYMASK_PLAN', weekday = null, fport = 25, payload, state = 'QUEUED', transport }) {
  await db.run('INSERT INTO valve_schedule_pushes(push_id, device_eui, purpose, weekday, fport, payload_hex, plan_hash, state, transport_json) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, B2_EUI, purpose, weekday, fport, payload, 'h-' + id, state, JSON.stringify(transport)]);
}

async function b2Control(db, control) {
  await store.writeConditionalControl(db, B2_EUI, control);
}

async function b2States(db) {
  const rows = await db.all('SELECT push_id, state, error, acked_at FROM valve_schedule_pushes ORDER BY rowid');
  return Object.fromEntries(rows.map((r) => [r.push_id, { state: r.state, error: r.error, consumed: r.acked_at != null }]));
}

async function seedB2Conversion(db, { snapshot }) {
  await store.upsertSettings(db, B2_EUI, { strega_generation: 'GEN2' });
  // Fixed plan A was handed off, then the conversion superseded it and flushed the queue.
  await b2Push(db, { id: 'A', payload: '0299151930', state: 'SUPERSEDED',
    transport: { phase: 'UNKNOWN', queue_id: 'q-A', attempted_at: '2026-10-19T08:00:00.000Z', invalidated_by_flush: 'f1' } });
  await b2Push(db, { id: 'C', payload: '80', transport: { phase: 'ACCEPTED', queue_id: 'q-C', attempted_at: '2026-10-19T08:05:00.000Z' } });
  await b2Control(db, { mode: 'CONDITIONAL', generation: 'GEN2', desired_revision: 'rev-1', required_push_ids: ['C'], predecessor_push_ids: ['A'],
    readiness: { state: 'PENDING', revision: 'rev-1', reason: 'awaiting_clear_ack' },
    flushes: [{ flush_id: 'f1', status: 'COMPLETE', captured_snapshot: snapshot }] });
}

const clearRule = (candidate) => candidate.row.payload_hex === '80' && candidate.status === 1;

test('B-2: an ACK that may be the superseded plan\'s does not attest the conditional clear (GEN2)', async () => {
  const { db } = await tempDb();
  await seedB2Conversion(db, { snapshot: [] }); // A had left the queue before the flush: it may have been delivered
  const matched = await store.ackPush(db, B2_EUI, 'DAYMASK_PLAN', 25, null, 1, '2026-10-19T08:06:00.000Z', { verifiedRule: clearRule, generation: 'GEN2', generationIdentity: 'GEN2' });
  assert.equal(matched, 0);
  const s = await b2States(db);
  assert.deepEqual(s.A, { state: 'SUPERSEDED', error: 'ack_ambiguous', consumed: true });
  assert.deepEqual(s.C, { state: 'QUEUED', error: 'ack_ambiguous', consumed: false }, 'the clear stays unconfirmed, not ACKED');
  const push = require('./push');
  const readiness = await push.conditionalReadiness(db, B2_EUI);
  assert.equal(readiness.ready, false);
  db.close();
});

test('B-2: a later ACK on the port still confirms the newer row once the ambiguity has consumed the older one', async () => {
  const { db } = await tempDb();
  await seedB2Conversion(db, { snapshot: [] });
  const opts = { verifiedRule: clearRule, generation: 'GEN2', generationIdentity: 'GEN2' };
  await store.ackPush(db, B2_EUI, 'DAYMASK_PLAN', 25, null, 1, '2026-10-19T08:06:00.000Z', opts);
  assert.equal(await store.ackPush(db, B2_EUI, 'DAYMASK_PLAN', 25, null, 1, '2026-10-19T08:20:00.000Z', opts), 1);
  assert.deepEqual((await b2States(db)).C, { state: 'ACKED', error: null, consumed: true });
  db.close();
});

test('B-2: an older row the flush snapshot proves unsent cannot own the ACK, so the clear is confirmed', async () => {
  const { db } = await tempDb();
  await seedB2Conversion(db, { snapshot: [{ id: 'q-A', fPort: 25, data: 'Ag==', isPending: false }] });
  const matched = await store.ackPush(db, B2_EUI, 'DAYMASK_PLAN', 25, null, 1, '2026-10-19T08:06:00.000Z', { verifiedRule: clearRule, generation: 'GEN2', generationIdentity: 'GEN2' });
  assert.equal(matched, 1);
  const s = await b2States(db);
  assert.equal(s.C.state, 'ACKED');
  assert.deepEqual(s.A, { state: 'SUPERSEDED', error: null, consumed: false });
  db.close();
});

test('B-2: the conditional clear rule applies to GEN2 too', async () => {
  const { db } = await tempDb();
  await seedB2Conversion(db, { snapshot: [{ id: 'q-A', fPort: 25, data: 'Ag==', isPending: false }] });
  const matched = await store.ackPush(db, B2_EUI, 'DAYMASK_PLAN', 25, null, 1, '2026-10-19T08:06:00.000Z', { verifiedRule: () => false, generation: 'GEN2', generationIdentity: 'GEN2' });
  assert.equal(matched, 0);
  assert.notEqual((await b2States(db)).C.state, 'ACKED');
  db.close();
});

test('B-2: two queued rows on one port are confirmed first in, first out (GEN2 groups of one compile)', async () => {
  const { db } = await tempDb();
  await store.upsertSettings(db, B2_EUI, { strega_generation: 'GEN2' });
  await b2Push(db, { id: 'G1', payload: '0299151930', transport: { phase: 'ACCEPTED', queue_id: 'q-1', attempted_at: '2026-10-19T08:00:00.000Z' } });
  await b2Push(db, { id: 'G2', payload: '0499151930', transport: { phase: 'ACCEPTED', queue_id: 'q-2', attempted_at: '2026-10-19T08:00:01.000Z' } });
  assert.equal(await store.ackPush(db, B2_EUI, 'DAYMASK_PLAN', 25, null, 1, '2026-10-19T08:10:00.000Z'), 1);
  assert.equal((await b2States(db)).G1.state, 'ACKED');
  assert.equal((await b2States(db)).G2.state, 'QUEUED');
  assert.equal(await store.ackPush(db, B2_EUI, 'DAYMASK_PLAN', 25, null, 1, '2026-10-19T08:20:00.000Z'), 1);
  assert.equal((await b2States(db)).G2.state, 'ACKED');
  db.close();
});

test('B-2: a GEN1 weekday re-edit without a flush credits the superseded row first, then the new one', async () => {
  const { db } = await tempDb();
  await b2Push(db, { id: 'A', purpose: 'WEEKDAY_PLAN', weekday: 1, fport: 15, payload: '01', state: 'SUPERSEDED', transport: { phase: 'ACCEPTED', queue_id: 'q-A', attempted_at: '2026-10-19T08:00:00.000Z' } });
  await b2Push(db, { id: 'B', purpose: 'WEEKDAY_PLAN', weekday: 1, fport: 15, payload: '02', transport: { phase: 'ACCEPTED', queue_id: 'q-B', attempted_at: '2026-10-19T08:01:00.000Z' } });
  assert.equal(await store.ackPush(db, B2_EUI, 'WEEKDAY_PLAN', 15, 1, 0, '2026-10-19T08:10:00.000Z'), 1);
  let s = await b2States(db);
  assert.equal(s.A.state, 'ACKED', 'the older plan was delivered first');
  assert.equal(s.B.state, 'QUEUED', 'the newer plan waits for its own ACK');
  assert.equal(await store.ackPush(db, B2_EUI, 'WEEKDAY_PLAN', 15, 1, 0, '2026-10-19T08:20:00.000Z'), 1);
  s = await b2States(db);
  assert.equal(s.B.state, 'ACKED');
  db.close();
});

test('B-2: a row handed off more than 24 hours before the ACK cannot own it', async () => {
  const { db } = await tempDb();
  await b2Push(db, { id: 'old', purpose: 'WEEKDAY_PLAN', weekday: 1, fport: 15, payload: '01', state: 'SUPERSEDED', transport: { phase: 'UNKNOWN', queue_id: 'q-old', attempted_at: '2026-10-17T08:00:00.000Z' } });
  await b2Push(db, { id: 'new', purpose: 'WEEKDAY_PLAN', weekday: 1, fport: 15, payload: '02', transport: { phase: 'ACCEPTED', queue_id: 'q-new', attempted_at: '2026-10-19T08:01:00.000Z' } });
  assert.equal(await store.ackPush(db, B2_EUI, 'WEEKDAY_PLAN', 15, 1, 0, '2026-10-19T08:10:00.000Z'), 1);
  assert.equal((await b2States(db)).new.state, 'ACKED');
  db.close();
});

// (W8's own B-3 sweep test is not ported: the 24 h sweep follows CMD-04 PR0, see the
// 'CMD-04 PR0: the 24 h sweep' test above.)

test('R3-B1: provenUndelivered uses the persisted proof, then any COMPLETE flush snapshot, never an incomplete one', async () => {
  const { db } = await tempDb();
  await store.upsertSettings(db, B2_EUI, { strega_generation: 'GEN2' });
  const add = (id, transport) => b2Push(db, { id, payload: '0299151930', state: 'SUPERSEDED', transport: { phase: 'UNKNOWN', attempted_at: '2026-10-19T08:00:00.000Z', ...transport } });
  await add('persisted', { queue_id: 'q-p', invalidated_by_flush: 'f9', first_invalidated_by_flush: 'f9', unsent_in_snapshot: true });
  // R3-M5: a stale false without a completed-flush stamp is not a proof; the scan decides.
  await add('unstamped', { queue_id: 'q-u', invalidated_by_flush: 'f2', unsent_in_snapshot: false });
  await add('scanned', { queue_id: 'q-s', invalidated_by_flush: 'f2' });
  await add('incomplete', { queue_id: 'q-i', invalidated_by_flush: 'f3' });
  await b2Push(db, { id: 'C', payload: '80', transport: { phase: 'ACCEPTED', queue_id: 'q-C', attempted_at: '2026-10-19T08:05:00.000Z' } });
  await b2Control(db, { flushes: [
    { flush_id: 'f1', status: 'COMPLETE', captured_snapshot: [{ id: 'q-s', isPending: false }, { id: 'q-u', isPending: false }] },
    { flush_id: 'f2', status: 'COMPLETE', captured_snapshot: [] },
    { flush_id: 'f3', status: 'UNKNOWN', captured_snapshot: [{ id: 'q-i', isPending: false }] },
  ] });
  // 'persisted' and 'scanned' are proven unsent; 'incomplete' is not, so it is the oldest candidate.
  assert.equal(await store.ackPush(db, B2_EUI, 'DAYMASK_PLAN', 25, null, 1, '2026-10-19T08:06:00.000Z'), 0);
  const s = await b2States(db);
  assert.equal(s.incomplete.error, 'ack_ambiguous');
  assert.equal(s.persisted.error, null);
  assert.equal(s.scanned.error, null);
  assert.equal(s.unstamped.error, null);
  db.close();
});

// R13 re-review R2: a flush marks the plan rows it removed LOST, but a lifecycle clear row that was
// prepared and never attempted (no transport phase) was not on the air: it stays QUEUED for the
// clear sender, so the ledger does not say "device may not hold this plan" for a clear in flight.
test('markFlushedSnapshotLost skips never-attempted lifecycle clear rows', async () => {
  const { db } = await tempDb();
  const eui = '0016C001F1000001';
  const insert = (id, transport) => db.run("INSERT INTO valve_schedule_pushes(push_id, device_eui, purpose, weekday, fport, payload_hex, plan_hash, state, transport_json) VALUES (?, ?, 'WEEKDAY_PLAN', 1, 15, '00', 'h', 'QUEUED', ?)", [id, eui, transport == null ? null : JSON.stringify(transport)]);
  await insert('p-lifecycle', { lifecycle_clear_revision: 'rev-1' });
  await insert('p-lifecycle-sent', { lifecycle_clear_revision: 'rev-1', phase: 'ACCEPTED', queue_id: 'q-1' });
  await insert('p-plan', { phase: 'ACCEPTED', queue_id: 'q-2' });
  await insert('p-legacy', null);
  const out = await store.markFlushedSnapshotLost(db, eui, {});
  const states = Object.fromEntries((await db.all('SELECT push_id, state FROM valve_schedule_pushes')).map((r) => [r.push_id, r.state]));
  assert.deepEqual(states, { 'p-lifecycle': 'QUEUED', 'p-lifecycle-sent': 'FAILED', 'p-plan': 'FAILED', 'p-legacy': 'FAILED' });
  assert.equal(out.lost, 3);
  db.close();
});
