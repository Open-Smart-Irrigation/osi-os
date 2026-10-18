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

const { tempDb, linkCloud } = require('./test-helpers');
const store = require('./store');
const { compileAndQueue, queuePushes } = require('./push');

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
  const superseded = await db.all("SELECT state FROM valve_schedule_pushes WHERE weekday=1 ORDER BY rowid");
  assert.deepEqual(superseded.map((s) => s.state), ['SUPERSEDED', 'QUEUED']);
  db.close();
});

test('compileAndQueue: after the gateway clock steps back, reverting a weekday to its earlier plan still pushes it', async () => {
  // The valve has no read-back of its scheduler, so the gateway's ledger is the only record of
  // what the valve holds. Plan A (Monday 06:00) is pushed while the clock runs 5 minutes fast;
  // the clock is corrected and plan B (Monday 07:00) is pushed and acked. The valve now runs B.
  // Reverting to A must queue a Monday push; deciding "already pushed" from the row with the
  // later timestamp (A) would leave the valve opening at 07:00 while the gateway shows 06:00.
  const { db } = await tempDb();
  const eui = '0016C001F1000001';
  const run = () => compileAndQueue({ db, deviceEui: eui, appId: 'app', force: false, now: new Date('2026-09-17T14:00:00Z'), flushQueue: async () => {}, warn: () => {} });
  await store.insertSchedule(db, { schedule_uuid: 'u1', device_eui: eui, kind: 'WEEKLY', label: null, weekdays_mask: 2, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  const a = await run();
  assert.equal(a.rows.filter((r) => r.purpose === 'WEEKDAY_PLAN').length, 7);
  await db.run("UPDATE valve_schedule_pushes SET queued_at='2026-09-17 14:05:00', state='ACKED', acked_at='2026-09-17T14:05:30.000Z'");

  await store.updateSchedule(db, 'u1', { start_time: '07:00' }, eui);
  const b = await run();
  assert.deepEqual(b.rows.map((r) => r.weekday), [1]);
  await db.run("UPDATE valve_schedule_pushes SET queued_at='2026-09-17 14:00:00', state='ACKED', acked_at='2026-09-17T14:00:30.000Z' WHERE push_id=?", [b.rows[0].push_id]);

  await store.updateSchedule(db, 'u1', { start_time: '06:00' }, eui);
  const reverted = await run();
  assert.deepEqual(reverted.rows.map((r) => r.weekday), [1], 'Monday must be pushed again: the valve holds plan B, not A');
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
  await store.updateSchedule(db, 'g1', { weekdays_mask: 127 & ~0x02 }, '0016C001F1000001');
  await store.insertSchedule(db, { schedule_uuid: 'g2', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 0x02, start_time: '09:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  const r2 = await compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', force: false, now: new Date(), flushQueue: async () => {}, warn: () => {} });
  const gen2_2 = r2.rows.filter((r) => r.purpose === 'DAYMASK_PLAN');
  assert.equal(gen2_2.length, 1, 'only the Monday group actually changed');

  // Revert Monday back into the original all-days window.
  await store.updateSchedule(db, 'g1', { weekdays_mask: 127 }, '0016C001F1000001');
  await store.softDeleteSchedule(db, 'g2', '0016C001F1000001');
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

test('M1: a Gen2->Gen1 demotion whose GEN1 hashes still match ACKED rows produces zero pushes, but the leftover DAYMASK_PLAN row is still superseded', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'g1', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 127, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });

  // GEN1 compile, then ACK all 7 WEEKDAY_PLAN rows so their hashes persist in lastPushHashes
  // (this is what lets the eventual demotion compile find "nothing changed").
  const r1 = await compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', force: false, now: new Date('2026-08-19T10:00:00Z'), flushQueue: async () => {}, warn: () => {} });
  assert.equal(r1.rows.filter((r) => r.purpose === 'WEEKDAY_PLAN').length, 7);
  for (const row of r1.rows) await db.run("UPDATE valve_schedule_pushes SET state='ACKED' WHERE push_id=?", [row.push_id]);

  // Self-correction promotes to GEN2 and force-compiles (as MAJOR-A's test above), leaving
  // one QUEUED DAYMASK_PLAN row plus a same-device SCHEDULER_STATUS push queued in between.
  await store.upsertSettings(db, '0016C001F1000001', { strega_generation: 'GEN2' });
  const r2 = await compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', force: true, now: new Date(), flushQueue: async () => {}, warn: () => {} });
  assert.equal(r2.rows.filter((r) => r.purpose === 'DAYMASK_PLAN').length, 1);
  await queuePushes({ db, deviceEui: '0016C001F1000001', appId: 'app', pushes: [buildStatusPush('1')], flushQueue: null, warn: () => {} });

  // Another device's GEN2 compile, in parallel, must stay untouched by anything below.
  const OTHER = '0016C001F1000002';
  await db.run("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES (?,'Valve B','STREGA_VALVE',1,datetime('now'),datetime('now'))", [OTHER]);
  await store.insertSchedule(db, { schedule_uuid: 'o1', device_eui: OTHER, kind: 'WEEKLY', label: null, weekdays_mask: 127, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  await store.upsertSettings(db, OTHER, { strega_generation: 'GEN2' });
  await compileAndQueue({ db, deviceEui: OTHER, appId: 'app', force: false, now: new Date(), flushQueue: async () => {}, warn: () => {} });

  // Operator switches the valve back to Gen1 (ValveSettingsDialog.tsx); the next unforced
  // compile finds the GEN1 hashes already match the ACKED rows above, so it produces ZERO
  // pushes -- the exact case that used to hit `if (!pushes.length) return` before the
  // cross-generation supersede ran.
  await store.upsertSettings(db, '0016C001F1000001', { strega_generation: 'GEN1' });
  const r3 = await compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', force: false, now: new Date(), flushQueue: async () => {}, warn: () => {} });
  assert.equal(r3.rows.length, 0, 'the demoting compile itself must still produce no pushes -- this is the hole, not a workaround');

  // The abandoned DAYMASK_PLAN row must be superseded even though the compile that demoted it
  // produced nothing.
  const dm = await db.all("SELECT state FROM valve_schedule_pushes WHERE device_eui='0016C001F1000001' AND purpose='DAYMASK_PLAN'");
  assert.deepEqual(new Set(dm.map((r) => r.state)), new Set(['SUPERSEDED']), 'demotion direction must clean up the abandoned GEN2 row too, mirroring MAJOR-A');

  // The GEN1 plan rows are the real, currently-applying plan: they were ACKED before the
  // demotion and must survive as the newest-per-slot state, not be collaterally touched.
  const wd = await db.all("SELECT state FROM valve_schedule_pushes WHERE device_eui='0016C001F1000001' AND purpose='WEEKDAY_PLAN'");
  assert.deepEqual(new Set(wd.map((r) => r.state)), new Set(['ACKED']));

  // A SCHEDULER_STATUS push queued in between must not be collaterally superseded.
  const st = await db.all("SELECT state FROM valve_schedule_pushes WHERE device_eui='0016C001F1000001' AND purpose='SCHEDULER_STATUS'");
  assert.equal(st.length, 1);
  assert.equal(st[0].state, 'QUEUED', 'SCHEDULER_STATUS must NOT be collaterally superseded');

  // The other device's outstanding GEN2 plan (same generation, unrelated device) survives.
  const otherDm = await db.all("SELECT state FROM valve_schedule_pushes WHERE device_eui=? AND purpose='DAYMASK_PLAN'", [OTHER]);
  assert.equal(otherDm.length, 1);
  assert.equal(otherDm[0].state, 'QUEUED', "another device's same-generation outstanding push must survive");

  // The GUI badge: no phantom queued/failed for the demoted valve, now or 24h later.
  const summary = await store.pushSummary(db, '0016C001F1000001');
  assert.equal(summary.queued, 0, 'no stale GEN2 slots left outstanding after demotion');
  assert.equal(summary.acked, 7, 'the real GEN1 plan is what shows as applied');
  assert.equal(summary.failed, 0);
  await store.failStalePushes(db, new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  const afterSweep = await store.pushSummary(db, '0016C001F1000001');
  assert.equal(afterSweep.failed, 0, 'the abandoned GEN2 row must not surface as a phantom failure 24h later');
  db.close();
});

test('M1: a clock-sync-only queuePushes call (no generation, no plan purpose) supersedes nothing', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'g1', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 127, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  await compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', force: false, now: new Date(), flushQueue: async () => {}, warn: () => {} });
  await store.upsertSettings(db, '0016C001F1000001', { strega_generation: 'GEN2' });
  // Called directly, bypassing compileAndQueue, so no `generation` is known/passed -- exactly
  // how workers.js's runClockTick queues a standalone clock push.
  await queuePushes({ db, deviceEui: '0016C001F1000001', appId: 'app', pushes: [buildClockPush('GEN2', new Date(), 'UTC')], flushQueue: null, warn: () => {} });
  const wd = await db.all("SELECT state FROM valve_schedule_pushes WHERE device_eui='0016C001F1000001' AND purpose='WEEKDAY_PLAN'");
  assert.deepEqual(new Set(wd.map((r) => r.state)), new Set(['QUEUED']), 'a clock push alone must not touch plan rows');
  db.close();
});

// P3-E1: queuePushes is one of the code seams that changes ValveRuntime's derived state
// (push_state.queued/acked/failed/weekday_states) -- but only for WEEKDAY_PLAN/DAYMASK_PLAN
// pushes; a SCHEDULER_STATUS/CLOCK_SYNC-only push leaves that resource unchanged.
test('P3-E1: a plan-affecting queuePushes call emits VALVE_RUNTIME_CHANGED on a linked gateway; a clock-sync-only call does not', async () => {
  const { db } = await tempDb();
  await linkCloud(db);
  await store.insertSchedule(db, { schedule_uuid: 'g1', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });

  await compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', force: false, now: new Date('2026-08-19T10:00:00Z'), flushQueue: async () => {}, warn: () => {} });
  const afterPlan = await db.all("SELECT op FROM sync_outbox WHERE op='VALVE_RUNTIME_CHANGED'");
  assert.equal(afterPlan.length, 1, 'the WEEKDAY_PLAN pushes (+ their bundled clock push) must emit exactly one runtime event');

  await queuePushes({ db, deviceEui: '0016C001F1000001', appId: 'app', pushes: [buildClockPush('GEN1', new Date(), 'UTC')], flushQueue: null, warn: () => {} });
  const afterClock = await db.all("SELECT op FROM sync_outbox WHERE op='VALVE_RUNTIME_CHANGED'");
  assert.equal(afterClock.length, 1, 'a standalone clock push must not add another runtime event');
  db.close();
});

// P3-E1 review fix (IMPORTANT 4): the emit inside queuePushes' transaction used to be uncaught --
// a failure there would have rolled back the push-ledger writes made in the SAME transaction,
// losing a real, successful plan compile over a best-effort sync side effect.
test('P3-E1: queuePushes still commits its push-ledger writes even when the runtime emission inside the same transaction fails', async () => {
  const { db } = await tempDb();
  await linkCloud(db);
  await store.insertSchedule(db, { schedule_uuid: 'g1', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  const warnings = [];
  const failingDb = {
    get: (...args) => db.get(...args),
    all: (...args) => db.all(...args),
    run: (...args) => db.run(...args),
    close: (...args) => db.close(...args),
    transaction: (executor) => db.transaction((tx) => executor({
      get: (...args) => tx.get(...args),
      all: (...args) => tx.all(...args),
      run: (sql, params) => (/insert into sync_outbox/i.test(sql) ? Promise.reject(new Error('boom')) : tx.run(sql, params)),
    })),
  };

  const r = await compileAndQueue({ db: failingDb, deviceEui: '0016C001F1000001', appId: 'app', force: false, now: new Date('2026-08-19T10:00:00Z'), flushQueue: async () => {}, warn: (m) => warnings.push(m) });

  assert.equal(r.rows.filter((row) => row.purpose === 'WEEKDAY_PLAN').length, 7, 'the push-ledger writes must still have committed');
  // Scoped to VALVE_RUNTIME_CHANGED, not "no sync_outbox rows at all": insertSchedule's own
  // trigger (VALVE_SCHEDULE_UPSERTED) and the clock-sync settings write's trigger
  // (VALVE_SETTINGS_UPSERTED) legitimately land rows here too -- this test is only about the
  // runtime emission specifically not landing (and not blocking the rest).
  assert.equal((await db.all("SELECT * FROM sync_outbox WHERE op='VALVE_RUNTIME_CHANGED'")).length, 0, 'the failed emit itself never landed');
  assert.ok(warnings.some((w) => /runtime emit failed/.test(w)));
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


// ---------------------------------------------------------------------------------------------
// CMD-04 PR0 (owner decision Q02 = (c)): no automatic configuration re-send. A compile that
// flushes the device's ChirpStack queue sends only what it compiled itself. Rows an earlier
// compile left QUEUED (and that this compile does not replace) are not re-emitted: they become
// LOST -- stored as state FAILED with error 'not_resent_q02c', because the 0022 CHECK on
// valve_schedule_pushes.state does not admit a new state value -- and are surfaced as
// "device may not hold this plan". They are never re-sent automatically afterwards, only by an
// explicit operator "Resend plan" (force).
// ---------------------------------------------------------------------------------------------

const workers = require('./workers');
const { FIXTURE_EUI: EUI } = require('./test-helpers');
const hexOf = (m) => Buffer.from(m.payload.data, 'base64').toString('hex').toUpperCase();
const ledger = async (db) => db.all('SELECT push_id, purpose, weekday, payload_hex, state, error FROM valve_schedule_pushes WHERE device_eui=? ORDER BY rowid', [EUI]);

test('Q02c GEN2 bench scenario: three compiles in quick succession re-emit nothing; earlier rows not replaced become LOST and are surfaced', async () => {
  // The live case behind the old re-emission (bench Gen2 valve, 2026-08-23): several compiles
  // inside ~12 s, each flushing the device queue. An earlier compile's DAYMASK_PLAN for days
  // 1+4 was not replaced by the later compiles (different day-set), so its downlink was flushed
  // away. The old fix re-sent it from the stored bytes; under Q02 (c) it is surfaced instead.
  const { db } = await tempDb();
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN2' });
  const flushes = [];
  const flushQueue = async (e) => { flushes.push(e); };

  // Compile A: a window on days 1 and 4.
  await store.insertSchedule(db, { schedule_uuid: 'a1', device_eui: EUI, kind: 'WEEKLY', label: null, weekdays_mask: 0x12, start_time: '06:00', duration_minutes: 30, timezone: 'Europe/Zurich', enabled: 1 });
  const rA = await compileAndQueue({ db, deviceEui: EUI, appId: 'app', force: false, now: new Date('2026-08-23T10:00:00Z'), flushQueue, warn: () => {} });
  const daysAB = rA.rows.find((r) => r.purpose === 'DAYMASK_PLAN' && r.payload_hex.startsWith('12'));
  assert.ok(daysAB, 'compile A queues the days-1+4 group');

  // Compile B: add days 0/3/6. Days 1+4 are unchanged, so B does not replace A's 1+4 row.
  await store.insertSchedule(db, { schedule_uuid: 'b1', device_eui: EUI, kind: 'WEEKLY', label: null, weekdays_mask: 0x49, start_time: '08:00', duration_minutes: 45, timezone: 'Europe/Zurich', enabled: 1 });
  const rB = await compileAndQueue({ db, deviceEui: EUI, appId: 'app', force: false, now: new Date('2026-08-23T10:00:05Z'), flushQueue, warn: () => {} });

  // Compile C: add day 5.
  await store.insertSchedule(db, { schedule_uuid: 'c1', device_eui: EUI, kind: 'WEEKLY', label: null, weekdays_mask: 0x20, start_time: '09:00', duration_minutes: 15, timezone: 'Europe/Zurich', enabled: 1 });
  const rC = await compileAndQueue({ db, deviceEui: EUI, appId: 'app', force: false, now: new Date('2026-08-23T10:00:10Z'), flushQueue, warn: () => {} });

  assert.equal(flushes.length, 3, 'every compile flushed the device queue');
  for (const [name, r] of [['B', rB], ['C', rC]]) {
    assert.equal(r.messages.length, r.rows.length, `compile ${name} must send only the rows it compiled itself`);
    const freshHex = new Set(r.rows.map((row) => row.payload_hex.toUpperCase()));
    for (const m of r.messages) assert.ok(freshHex.has(hexOf(m)), `compile ${name} re-emitted a stored payload ${hexOf(m)}`);
  }
  assert.ok(!rB.messages.concat(rC.messages).some((m) => hexOf(m) === daysAB.payload_hex.toUpperCase()), "A's days-1+4 plan must not be re-sent");

  const rows = await ledger(db);
  const aRow = rows.find((r) => r.push_id === daysAB.push_id);
  assert.equal(aRow.state, 'FAILED');
  assert.equal(aRow.error, 'not_resent_q02c', "A's days-1+4 row is LOST, not left QUEUED and not superseded");
  assert.equal(rows.filter((r) => r.state === 'QUEUED' && !rC.rows.some((f) => f.push_id === r.push_id)).length, 0,
    'after the last compile, only its own rows are still QUEUED');

  // Surfaced: summary, per-slot states, and the synced runtime snapshot.
  const summary = await store.pushSummary(db, EUI, new Date('2026-08-23T10:00:10Z'));
  assert.ok(summary.lost >= 2, 'days 1 and 4 at least are LOST slots');
  assert.ok(summary.failed >= summary.lost, 'LOST slots are a subset of failed (backward compatible count)');
  const states = await store.weekdayPushStates(db, EUI);
  assert.equal(states.find((r) => r.payload_hex === daysAB.payload_hex).state, 'LOST');
  db.close();
});

test('Q02c GEN1: a compile after a flush with 3 carried rows sends 0 extra downlinks; the 3 rows become LOST and are surfaced', async () => {
  const { db } = await tempDb();
  await linkCloud(db);
  await store.insertSchedule(db, { schedule_uuid: 'm1', device_eui: EUI, kind: 'WEEKLY', label: null, weekdays_mask: 0x02, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  await compileAndQueue({ db, deviceEui: EUI, appId: 'app', force: false, now: new Date('2026-08-19T10:00:00Z'), flushQueue: async () => {}, warn: () => {} });
  // The valve confirmed everything except weekdays 3 and 5.
  await db.run("UPDATE valve_schedule_pushes SET state='ACKED', acked_at='2026-08-19T10:05:00.000Z' WHERE device_eui=? AND state='QUEUED' AND NOT (purpose='WEEKDAY_PLAN' AND weekday IN (3,5))", [EUI]);
  // A pause queued without a flush (third carried row).
  await queuePushes({ db, deviceEui: EUI, appId: 'app', pushes: [buildStatusPush('0')], flushQueue: null, warn: () => {} });
  const carried = (await ledger(db)).filter((r) => r.state === 'QUEUED');
  assert.equal(carried.length, 3);

  // Unrelated edit: Tuesday (weekday 2) gets a window. The compile flushes the queue.
  await store.insertSchedule(db, { schedule_uuid: 't1', device_eui: EUI, kind: 'WEEKLY', label: null, weekdays_mask: 0x04, start_time: '07:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  const warnings = [];
  const r = await compileAndQueue({ db, deviceEui: EUI, appId: 'app', force: false, now: new Date('2026-08-19T10:10:00Z'), flushQueue: async () => {}, warn: (m) => warnings.push(m) });

  assert.deepEqual(r.rows.map((row) => [row.purpose, row.weekday]), [['WEEKDAY_PLAN', 2]]);
  assert.equal(r.messages.length, 1, 'exactly the one compiled downlink, no re-emission');
  assert.equal(r.lost, 3);
  assert.ok(warnings.some((w) => /not re-sent/.test(w)), 'the loss is logged');

  const after = await ledger(db);
  for (const c of carried) {
    const row = after.find((x) => x.push_id === c.push_id);
    assert.equal(row.state, 'FAILED', `${c.purpose}/${c.weekday} must leave QUEUED`);
    assert.equal(row.error, 'not_resent_q02c');
  }

  const summary = await store.pushSummary(db, EUI, new Date('2026-08-19T10:10:00Z'));
  assert.equal(summary.lost, 2, 'weekdays 3 and 5 are LOST');
  assert.equal(summary.failed, 2);
  assert.equal(summary.queued, 1);
  assert.equal(summary.scheduler_status_lost, true, 'the lost pause is surfaced too');
  const states = await store.weekdayPushStates(db, EUI);
  assert.equal(states.find((s) => s.weekday === 3).state, 'LOST');
  assert.equal(states.find((s) => s.weekday === 5).state, 'LOST');

  // The synced runtime keeps the old state enum (an old cloud renders FAILED) and adds the flag.
  const { buildRuntimePayload } = require('./runtime');
  const payload = await buildRuntimePayload(db, EUI, new Date('2026-08-19T10:10:00Z'));
  assert.equal(payload.push_state.lost, 2);
  assert.equal(payload.push_state.failed, 2);
  assert.equal(payload.push_state.scheduler_status_lost, true);
  const wd3 = payload.push_state.weekday_states.find((w) => w.weekday === 3);
  assert.deepEqual(wd3, { weekday: 3, state: 'FAILED', acked_at: null, lost: true });
  const events = await db.all("SELECT payload_json FROM sync_outbox WHERE op='VALVE_RUNTIME_CHANGED' ORDER BY rowid DESC LIMIT 1");
  assert.equal(JSON.parse(events[0].payload_json).push_state.lost, 2, 'the compile emitted a runtime change carrying the loss');
  db.close();
});

test('Q02c: an unrelated later edit never re-sends a LOST or 24h-FAILED plan; an explicit Resend (force) still does', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'm1', device_eui: EUI, kind: 'WEEKLY', label: null, weekdays_mask: 0x02, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  await compileAndQueue({ db, deviceEui: EUI, appId: 'app', force: false, now: new Date('2026-08-19T10:00:00Z'), flushQueue: async () => {}, warn: () => {} });
  // Monday (1) never confirmed; the 24 h sweep fails it. Every other row confirmed.
  await db.run("UPDATE valve_schedule_pushes SET state='ACKED' WHERE device_eui=? AND NOT (purpose='WEEKDAY_PLAN' AND weekday=1)", [EUI]);
  await db.run("UPDATE valve_schedule_pushes SET queued_at='2026-08-17 10:00:00' WHERE device_eui=? AND weekday=1", [EUI]);
  await store.failStalePushes(db, '2026-08-18T10:00:00.000Z');
  assert.equal((await db.get('SELECT state FROM valve_schedule_pushes WHERE weekday=1')).state, 'FAILED');

  // Unrelated edit (Wednesday). Monday's plan must not ride along.
  await store.insertSchedule(db, { schedule_uuid: 'w1', device_eui: EUI, kind: 'WEEKLY', label: null, weekdays_mask: 0x08, start_time: '07:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  const r1 = await compileAndQueue({ db, deviceEui: EUI, appId: 'app', force: false, now: new Date('2026-08-19T11:00:00Z'), flushQueue: async () => {}, warn: () => {} });
  assert.deepEqual(r1.rows.map((row) => row.weekday), [3], 'only the edited weekday is sent');

  // Thursday's row is still QUEUED when Friday is edited: it becomes LOST ...
  await store.insertSchedule(db, { schedule_uuid: 'f1', device_eui: EUI, kind: 'WEEKLY', label: null, weekdays_mask: 0x20, start_time: '07:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  const r2 = await compileAndQueue({ db, deviceEui: EUI, appId: 'app', force: false, now: new Date('2026-08-19T11:01:00Z'), flushQueue: async () => {}, warn: () => {} });
  assert.deepEqual(r2.rows.map((row) => row.weekday), [5]);
  assert.equal(r2.lost, 1);
  // ... and the next unrelated edit does not re-send it either.
  await store.insertSchedule(db, { schedule_uuid: 's1', device_eui: EUI, kind: 'WEEKLY', label: null, weekdays_mask: 0x40, start_time: '07:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  const r3 = await compileAndQueue({ db, deviceEui: EUI, appId: 'app', force: false, now: new Date('2026-08-19T11:02:00Z'), flushQueue: async () => {}, warn: () => {} });
  assert.deepEqual(r3.rows.map((row) => row.weekday), [6], 'the LOST Wednesday plan is not re-sent by a Saturday edit');

  // Explicit operator Resend stays as today: every weekday goes out again, and the LOST
  // surfacing clears because the newest row per slot is now the resent one.
  const r4 = await compileAndQueue({ db, deviceEui: EUI, appId: 'app', force: true, now: new Date('2026-08-19T11:03:00Z'), flushQueue: async () => {}, warn: () => {} });
  assert.equal(r4.rows.filter((row) => row.purpose === 'WEEKDAY_PLAN').length, 7);
  const summary = await store.pushSummary(db, EUI, new Date('2026-08-19T11:03:00Z'));
  assert.equal(summary.lost, 0);
  assert.equal(summary.queued, 7);
  db.close();
});

test('Q02c: CLOCK_SYNC is never replayed from stored bytes; a lost clock sync is recomputed fresh by the next clock tick', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'm1', device_eui: EUI, kind: 'WEEKLY', label: null, weekdays_mask: 0x02, start_time: '06:00', duration_minutes: 30, timezone: 'Europe/Zurich', enabled: 1 });
  const r1 = await compileAndQueue({ db, deviceEui: EUI, appId: 'app', force: false, now: new Date('2026-08-19T10:00:00Z'), flushQueue: async () => {}, warn: () => {} });
  const storedClock = r1.rows.find((row) => row.purpose === 'CLOCK_SYNC');
  assert.ok(storedClock);
  await db.run("UPDATE valve_schedule_pushes SET state='ACKED' WHERE device_eui=? AND purpose='WEEKDAY_PLAN'", [EUI]);

  // Two hours later an edit flushes the queue while the clock sync is still unconfirmed.
  await store.insertSchedule(db, { schedule_uuid: 't1', device_eui: EUI, kind: 'WEEKLY', label: null, weekdays_mask: 0x04, start_time: '07:00', duration_minutes: 30, timezone: 'Europe/Zurich', enabled: 1 });
  const r2 = await compileAndQueue({ db, deviceEui: EUI, appId: 'app', force: false, now: new Date('2026-08-19T12:00:00Z'), flushQueue: async () => {}, warn: () => {} });
  assert.ok(!r2.messages.some((m) => hexOf(m) === storedClock.payload_hex.toUpperCase()), 'the stored wall-clock bytes are not replayed');
  const clockRow = await db.get('SELECT state, error FROM valve_schedule_pushes WHERE push_id=?', [storedClock.push_id]);
  assert.deepEqual({ ...clockRow }, { state: 'FAILED', error: 'not_resent_q02c' });
  const settings = await store.getSettings(db, EUI);
  assert.equal(settings.last_clock_sync_queued_at, null, 'the lost clock sync makes the valve due for a fresh one');

  // The next clock tick computes the payload from its own current time.
  const tickNow = new Date('2026-08-19T12:10:00Z');
  const tick = await workers.runClockTick({ db, now: tickNow, appId: 'app', warn: () => {} });
  assert.equal(tick.messages.length, 1);
  assert.equal(hexOf(tick.messages[0]), buildClockPush('GEN1', tickNow, 'Europe/Zurich').payloadHex);
  assert.notEqual(hexOf(tick.messages[0]), storedClock.payload_hex.toUpperCase());
  db.close();
});

test('Q02c: without a flush (an actuation awaiting observation) earlier rows stay QUEUED and nothing is marked LOST', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'm1', device_eui: EUI, kind: 'WEEKLY', label: null, weekdays_mask: 0x02, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  await compileAndQueue({ db, deviceEui: EUI, appId: 'app', force: false, now: new Date('2026-08-19T10:00:00Z'), flushQueue: async () => {}, warn: () => {} });
  await db.run(
    "INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, created_at) VALUES ('e1', ?, '2026-08-19T10:01:00Z', 600, '2026-08-19T10:11:00Z', 'unknown', 'PENDING_OBSERVATION', '2026-08-19T10:01:00Z')",
    [EUI]
  );
  let flushed = false;
  await store.insertSchedule(db, { schedule_uuid: 't1', device_eui: EUI, kind: 'WEEKLY', label: null, weekdays_mask: 0x04, start_time: '07:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  const r = await compileAndQueue({ db, deviceEui: EUI, appId: 'app', force: false, now: new Date('2026-08-19T10:02:00Z'), flushQueue: async () => { flushed = true; }, warn: () => {} });
  assert.equal(flushed, false);
  assert.equal(r.lost, 0);
  const lost = await db.all("SELECT 1 FROM valve_schedule_pushes WHERE error='not_resent_q02c'");
  assert.equal(lost.length, 0);
  db.close();
});

test('classifyCarried: a DAYMASK_PLAN row is replaced only when the batch covers every one of its days', () => {
  const { classifyCarried } = require('./push');
  const queued = [
    { push_id: 'full', purpose: 'DAYMASK_PLAN', weekday: null, payload_hex: '0699151930' }, // days 1+2
    { push_id: 'partial', purpose: 'DAYMASK_PLAN', weekday: null, payload_hex: '1899151930' }, // days 3+4
    { push_id: 'all', purpose: 'DAYMASK_PLAN', weekday: null, payload_hex: '8099151930' }, // every day
    { push_id: 'wd', purpose: 'WEEKDAY_PLAN', weekday: 2, payload_hex: 'FF' },
    { push_id: 'status', purpose: 'SCHEDULER_STATUS', weekday: null, payload_hex: '30' },
    { push_id: 'clock', purpose: 'CLOCK_SYNC', weekday: null, payload_hex: '01' },
  ];
  const pushes = [
    { purpose: 'DAYMASK_PLAN', daymask: 0x0E, weekday: null }, // days 1-3
    { purpose: 'CLOCK_SYNC', weekday: null },
  ];
  // The DAYMASK_PLAN push implies supersedeWeekday (the GEN1 row belongs to the abandoned generation).
  const lost = classifyCarried(queued, pushes, { supersedeWeekday: true, supersedeDaymask: false });
  assert.deepEqual(lost.map((r) => r.push_id), ['partial', 'all', 'status']);
  // A status-only batch replaces nothing but the older status push.
  const lost2 = classifyCarried(queued, [{ purpose: 'SCHEDULER_STATUS', weekday: null }], {});
  assert.deepEqual(lost2.map((r) => r.push_id), ['full', 'partial', 'all', 'wd', 'clock']);
});
