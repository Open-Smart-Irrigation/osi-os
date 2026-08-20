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
