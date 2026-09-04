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
  const u = await store.updateSchedule(db, 's1', { label: 'x' });
  assert.equal(u, undefined);
  const d = await store.softDeleteSchedule(db, 's1');
  assert.equal(d, undefined);
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
  await store.ackPush(db, '0016C001F1000001', 'WEEKDAY_PLAN', 30, 0, 'OK', new Date().toISOString());
  const summary = await store.pushSummary(db, '0016C001F1000001');
  assert.ok(summary.last_plan_queued_at, 'last_plan_queued_at must still be populated');
  assert.ok(summary.last_plan_acked_at, 'last_plan_acked_at must still be populated');
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
