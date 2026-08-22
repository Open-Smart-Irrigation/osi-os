'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./plan');
const { buildPlanPushes, buildDownlinkMessage, buildStatusPush, buildClockPush } = require('./push');

const w = (onH, onM, offH, offM) => ({ onH, onM, offH, offM });

test('GEN1: only changed weekdays are pushed unless force', () => {
  const days = [[w(6, 0, 6, 30)], [], [], [], [], [], []];
  const lastHashes = {};
  for (let d = 1; d < 7; d += 1) lastHashes['WEEKDAY_PLAN:' + d] = P.planHash([]);
  const pushes = buildPlanPushes({ generation: 'GEN1', days, lastHashes, force: false });
  assert.deepEqual(pushes.map((p) => p.weekday), [0]);
  assert.equal(pushes[0].fport, 14);
  assert.equal(pushes[0].payloadHex.length, 48);
  assert.equal(buildPlanPushes({ generation: 'GEN1', days, lastHashes, force: true }).length, 7);
});

test('GEN1 with no prior pushes sends all 7 weekdays', () => {
  const days = Array.from({ length: 7 }, () => []);
  assert.equal(buildPlanPushes({ generation: 'GEN1', days, lastHashes: {}, force: false }).length, 7);
});

test('GEN2: one push per distinct window group, all-days uses 0x80', () => {
  const days = Array.from({ length: 7 }, () => [w(19, 15, 19, 30)]);
  const pushes = buildPlanPushes({ generation: 'GEN2', days, lastHashes: {}, force: false });
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].fport, 25);
  assert.equal(pushes[0].payloadHex, '8099151930');
});

test('downlink message shape for ChirpStack MQTT', () => {
  const m = buildDownlinkMessage({ appId: 'app-uuid', deviceEui: '0016C001F1000001', fport: 14, payloadHex: 'FF'.repeat(24) });
  assert.equal(m.topic, 'application/app-uuid/device/0016C001F1000001/command/down');
  assert.deepEqual(Object.keys(m.payload).sort(), ['confirmed', 'data', 'devEui', 'fPort']);
  assert.equal(m.payload.confirmed, false);
  assert.equal(Buffer.from(m.payload.data, 'base64').length, 24);
});

test('status and clock pushes', () => {
  assert.deepEqual(buildStatusPush('1'), { purpose: 'SCHEDULER_STATUS', weekday: null, fport: 21, payloadHex: '31', planHash: null });
  assert.equal(buildClockPush('GEN1', new Date('2026-08-19T23:03:44Z'), 'Europe/Zurich').payloadHex, '0001000304040004020000080206');
  assert.deepEqual(buildClockPush('GEN2', new Date(), 'Europe/Zurich'), { purpose: 'CLOCK_SYNC', weekday: null, fport: 13, payloadHex: '01', planHash: null });
});

const { tempDb } = require('./test-helpers');
const store = require('./store');
const { compileAndQueue } = require('./push');

test('compileAndQueue: first save pushes 7 weekdays + clock, second identical save pushes nothing, change pushes one day', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'u1', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, timezone: 'Europe/Zurich', enabled: 1 });
  const flushes = [];
  const r1 = await compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', force: false, now: new Date('2026-08-19T10:00:00Z'), flushQueue: async (e) => flushes.push(e), warn: () => {} });
  assert.equal(r1.rows.filter((r) => r.purpose === 'WEEKDAY_PLAN').length, 7);
  assert.equal(r1.rows.filter((r) => r.purpose === 'CLOCK_SYNC').length, 1);
  assert.equal(r1.messages.length, 8);
  assert.deepEqual(flushes, ['0016C001F1000001']);
  const r2 = await compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', force: false, now: new Date(), flushQueue: async () => {}, warn: () => {} });
  assert.equal(r2.rows.length, 0);
  await store.insertSchedule(db, { schedule_uuid: 'u2', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 2, start_time: '07:00', duration_minutes: 30, timezone: 'Europe/Zurich', enabled: 1 });
  const r3 = await compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', force: false, now: new Date(), flushQueue: async () => {}, warn: () => {} });
  assert.deepEqual(r3.rows.map((r) => r.weekday), [1]);
  const superseded = await db.all("SELECT state FROM valve_schedule_pushes WHERE weekday=1 ORDER BY queued_at");
  assert.deepEqual(superseded.map((s) => s.state), ['SUPERSEDED', 'QUEUED']);
  db.close();
});

test('compileAndQueue rejects >4 windows with a 422 plan_conflict', async () => {
  const { db } = await tempDb();
  for (let i = 1; i <= 5; i += 1) await store.insertSchedule(db, { schedule_uuid: 'x' + i, device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 4, start_time: '0' + i + ':00', duration_minutes: 10, timezone: 'UTC', enabled: 1 });
  await assert.rejects(() => compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', flushQueue: async () => {}, warn: () => {} }), (e) => e.statusCode === 422 && e.details[0].weekday === 2);
  db.close();
});

test('GEN2 per-weekday hash diffing: regroup then revert re-pushes the original 0x80 group, not nothing (CRITICAL 2)', async () => {
  const { db } = await tempDb();
  await store.upsertSettings(db, '0016C001F1000001', { strega_generation: 'GEN2' });
  await store.insertSchedule(db, { schedule_uuid: 'g1', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 127, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });

  const r1 = await compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', force: false, now: new Date('2026-08-19T10:00:00Z'), flushQueue: async () => {}, warn: () => {} });
  const gen2_1 = r1.rows.filter((r) => r.purpose === 'DAYMASK_PLAN');
  assert.equal(gen2_1.length, 1);
  assert.equal(gen2_1[0].payload_hex.slice(0, 2), '80');
  const originalPayload = gen2_1[0].payload_hex;

  // Move Monday (bit1) to its own 09:00 window -> regroups into {Mon} + {rest}.
  await store.updateSchedule(db, 'g1', { weekdays_mask: 127 & ~0x02 });
  await store.insertSchedule(db, { schedule_uuid: 'g2', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 0x02, start_time: '09:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  const r2 = await compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', force: false, now: new Date(), flushQueue: async () => {}, warn: () => {} });
  const gen2_2 = r2.rows.filter((r) => r.purpose === 'DAYMASK_PLAN');
  assert.equal(gen2_2.length, 1, 'only the Monday group actually changed');

  // Revert Monday back into the original all-days window.
  await store.updateSchedule(db, 'g1', { weekdays_mask: 127 });
  await store.softDeleteSchedule(db, 'g2');
  const r3 = await compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', force: false, now: new Date(), flushQueue: async () => {}, warn: () => {} });
  const gen2_3 = r3.rows.filter((r) => r.purpose === 'DAYMASK_PLAN');
  assert.equal(gen2_3.length, 1, 'revert must re-push the all-days group, not nothing (stale per-group hash bug)');
  assert.equal(gen2_3[0].payload_hex, originalPayload);
  db.close();
});

test('GEN2 forced re-push: exactly one QUEUED row per group, old intersecting rows superseded (CRITICAL 2)', async () => {
  const { db } = await tempDb();
  await store.upsertSettings(db, '0016C001F1000001', { strega_generation: 'GEN2' });
  await store.insertSchedule(db, { schedule_uuid: 'g1', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 125, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  await store.insertSchedule(db, { schedule_uuid: 'g2', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 2, start_time: '09:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });

  const r1 = await compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', force: false, now: new Date('2026-08-19T10:00:00Z'), flushQueue: async () => {}, warn: () => {} });
  assert.equal(r1.rows.filter((r) => r.purpose === 'DAYMASK_PLAN').length, 2);

  const r2 = await compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', force: true, now: new Date(), flushQueue: async () => {}, warn: () => {} });
  assert.equal(r2.rows.filter((r) => r.purpose === 'DAYMASK_PLAN').length, 2);

  const allRows = await db.all("SELECT push_id, state FROM valve_schedule_pushes WHERE purpose='DAYMASK_PLAN' ORDER BY queued_at");
  assert.equal(allRows.filter((r) => r.state === 'QUEUED').length, 2);
  assert.equal(allRows.filter((r) => r.state === 'SUPERSEDED').length, 2);
  db.close();
});

test('MAJOR-A: a Gen1->Gen2 self-correction supersedes the abandoned WEEKDAY_PLAN rows, so pushSummary shows no stale queued/failed', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'g1', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 127, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });

  // GEN1 compile: 7x WEEKDAY_PLAN + 1x CLOCK_SYNC, all QUEUED.
  const r1 = await compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', force: false, now: new Date('2026-08-19T10:00:00Z'), flushQueue: async () => {}, warn: () => {} });
  assert.equal(r1.rows.filter((r) => r.purpose === 'WEEKDAY_PLAN').length, 7);
  const beforeSwitch = await store.pushSummary(db, '0016C001F1000001');
  assert.equal(beforeSwitch.queued, 7);

  // Self-correction: promote to GEN2 (as workers.js's handleUplink does) and force a fresh
  // compile (as valve-ack-fn's reconcile does after a successful ChirpStack profile re-point).
  await store.upsertSettings(db, '0016C001F1000001', { strega_generation: 'GEN2' });
  const r2 = await compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', force: true, now: new Date(), flushQueue: async () => {}, warn: () => {} });
  assert.equal(r2.rows.filter((r) => r.purpose === 'DAYMASK_PLAN').length, 1);

  // The 7 pre-switch WEEKDAY_PLAN rows must now be SUPERSEDED, not left QUEUED forever.
  const weekdayStates = await db.all("SELECT state FROM valve_schedule_pushes WHERE purpose='WEEKDAY_PLAN'");
  assert.deepEqual(new Set(weekdayStates.map((r) => r.state)), new Set(['SUPERSEDED']));

  // pushSummary (the GUI badge) buckets DAYMASK_PLAN rows per weekday bit set in their mask
  // (same expansion as lastPushHashes), so this single all-days group legitimately occupies
  // all 7 GEN2DAY:<d> slots -- but it must show exactly those 7, not 14 (the review's
  // reproduced defect: 7 stale WEEKDAY_PLAN:<d> slots counted ALONGSIDE the 7 new GEN2DAY:<d>
  // slots, because the two purposes are separate keyspaces), and no phantom failures, before
  // OR after the 24h stale-push sweep.
  const afterSwitch = await store.pushSummary(db, '0016C001F1000001');
  assert.equal(afterSwitch.queued, 7, 'only the 7 new GEN2 slots are outstanding, not 7 + 7 = 14 with the stale GEN1 slots still counted');
  assert.equal(afterSwitch.failed, 0);

  // The standard 24h-ago cutoff (same shape as store.test.js's C2 regression): the fresh GEN2
  // row survives on its own merits, and the already-SUPERSEDED GEN1 rows are untouched by
  // failStalePushes' `state='QUEUED'` filter regardless of cutoff -- proving they can never
  // resurface as phantom failures no matter how much real time passes.
  await store.failStalePushes(db, new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  const afterStaleSweep = await store.pushSummary(db, '0016C001F1000001');
  assert.equal(afterStaleSweep.failed, 0, 'the abandoned GEN1 rows must not surface as phantom failures 24h later');
  assert.equal(afterStaleSweep.queued, 7, 'the fresh GEN2 slots are unaffected by the sweep');
  db.close();
});

test('compileAndQueue: clock-sync timezone prefers the first enabled WEEKLY schedule over a ONCE schedule (MINOR 5)', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'o1', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, fire_at: '2026-08-20T00:00:00.000Z', duration_minutes: 5, timezone: 'Pacific/Auckland', enabled: 1 });
  await store.insertSchedule(db, { schedule_uuid: 'w1', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, timezone: 'Europe/Zurich', enabled: 1 });
  const r = await compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', force: false, now: new Date('2026-08-19T23:03:44Z'), flushQueue: async () => {}, warn: () => {} });
  const clock = r.rows.find((row) => row.purpose === 'CLOCK_SYNC');
  assert.ok(clock);
  assert.equal(clock.payload_hex, '0001000304040004020000080206');
  db.close();
});
