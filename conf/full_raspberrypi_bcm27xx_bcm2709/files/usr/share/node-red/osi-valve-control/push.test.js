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


// ---------------------------------------------------------------------------------------------
// CMD-04 PR0, design (C): snapshot compile. Every compile is a new intent that writes the
// COMPLETE desired state of every slot the valve can hold (GEN1: 7 weekday plans + scheduler
// status; GEN2: a daymask set covering all 7 days, empty days as zero-window frames, + status).
// The compile flushes the device queue, supersedes every outstanding plan/status row, and
// leaves the snapshot pending; the valve tick emits it once the debounce window has passed
// since the last edit. Nothing previously emitted is replayed. CLOCK_SYNC is never part of a
// compile. LOST is only what the 24 h sweep finds unacknowledged in the latest snapshot.
// ---------------------------------------------------------------------------------------------

const { tempDb, linkCloud, FIXTURE_EUI: EUI, fakeChirpStack, applyToValve } = require('./test-helpers');
const store = require('./store');
const workers = require('./workers');
const { compileAndQueue, queuePushes, emitPendingSnapshots, buildSnapshotPushes, SNAPSHOT_DEBOUNCE_MS, SNAPSHOT_MAX_DELAY_MS } = require('./push');

const T0 = Date.parse('2026-08-19T10:00:00Z');
const at = (sec) => new Date(T0 + sec * 1000);
const WINDOW_SEC = SNAPSHOT_DEBOUNCE_MS / 1000;
const EMPTY_GEN1 = 'FF'.repeat(24);
const weekly = (uuid, mask, start, dur) => ({ schedule_uuid: uuid, device_eui: EUI, kind: 'WEEKLY', label: null, weekdays_mask: mask, start_time: start, duration_minutes: dur, timezone: 'UTC', enabled: 1 });
const asItems = (rows) => rows.map((r) => ({ fPort: r.fport, hex: r.payload_hex.toUpperCase() }));
const hex = (buf) => Buffer.from(buf).toString('hex').toUpperCase();

function harness(db) {
  const cs = fakeChirpStack();
  return {
    cs,
    compile: (sec, extra) => compileAndQueue(Object.assign({ db, deviceEui: EUI, appId: 'app', now: at(sec), flushQueue: cs.flushQueue, warn: () => {} }, extra || {})),
    emit: async (sec) => { const r = await emitPendingSnapshots({ db, now: at(sec), appId: 'app', warn: () => {} }); cs.enqueue(r.messages); return r; },
    tick: async (sec) => {
      const h = await workers.runHousekeeping({ db, now: at(sec), appId: 'app', warn: () => {} });
      cs.enqueue(h.messages);
      const c = await workers.runClockTick({ db, now: at(sec), appId: 'app', warn: () => {} });
      cs.enqueue(c.messages);
      return { housekeeping: h, clock: c };
    },
  };
}

async function statesById(db, ids) {
  const rows = await db.all('SELECT push_id, state, error FROM valve_schedule_pushes WHERE device_eui=?', [EUI]);
  const byId = Object.fromEntries(rows.map((r) => [r.push_id, r]));
  return ids.map((id) => byId[id]);
}

// What the DB says the valve should hold, in applyToValve's shape.
async function desiredValve(db, generation) {
  const days = P.compileWindows(await store.listSchedules(db, EUI)).days;
  const settings = await store.getSettings(db, EUI);
  const status = { ACTIVE: '0', SKIP_TODAY: '1', DEACTIVATED: '2' }[settings.scheduler_status];
  if (generation === 'GEN2') return { gen2: days.map((d) => hex(P.encodeGen2(0, d)).slice(2)), status };
  return { gen1: days.map((d) => hex(P.encodeGen1Day(d))), status };
}

function valveView(state, generation) {
  return generation === 'GEN2' ? { gen2: state.gen2, status: state.status } : { gen1: state.gen1, status: state.status };
}

test('snapshot: a GEN1 compile writes 7 weekday plans + status, sends nothing until the debounce window has passed, then emits it exactly once', async () => {
  const { db } = await tempDb();
  const h = harness(db);
  await store.insertSchedule(db, weekly('u1', 0x02, '06:00', 30));
  const r = await h.compile(0);
  assert.deepEqual(r.rows.map((row) => [row.purpose, row.weekday]),
    [['SCHEDULER_STATUS', null]].concat([0, 1, 2, 3, 4, 5, 6].map((d) => ['WEEKDAY_PLAN', d])), 'status first (R5 M1)');
  assert.equal(r.rows.some((row) => row.purpose === 'CLOCK_SYNC'), false, 'CLOCK_SYNC is never part of a compile');
  assert.deepEqual(r.messages, [], 'the snapshot is emitted by the valve tick, not by the edit');
  assert.equal(h.cs.log.flushes, 1);

  assert.equal((await h.emit(WINDOW_SEC - 1)).messages.length, 0, 'inside the window: nothing');
  const e = await h.emit(WINDOW_SEC);
  assert.equal(e.messages.length, 8);
  assert.deepEqual(h.cs.getQueue(), asItems(r.rows));
  assert.equal((await h.emit(WINDOW_SEC + 600)).messages.length, 0, 'a snapshot is emitted at most once');
  db.close();
});

test('compileAndQueue rejects >4 windows with a 422 plan_conflict and writes nothing', async () => {
  const { db } = await tempDb();
  for (let i = 1; i <= 5; i += 1) await store.insertSchedule(db, weekly('x' + i, 4, '0' + i + ':00', 10));
  let flushed = false;
  await assert.rejects(() => compileAndQueue({ db, deviceEui: EUI, appId: 'app', flushQueue: async () => { flushed = true; }, warn: () => {} }), (e) => e.statusCode === 422 && e.details[0].weekday === 2);
  assert.equal(flushed, false);
  assert.equal((await db.all('SELECT 1 FROM valve_schedule_pushes')).length, 0);
  db.close();
});

for (const generation of ['GEN1', 'GEN2']) {
  test(`acceptance 1 (${generation}): two quick deletes with no uplink between leave only compile-2 rows queued, with an explicit clear for every day either schedule covered; compile-1 rows SUPERSEDED, none LOST, none re-enqueued`, async () => {
    const { db } = await tempDb();
    await store.upsertSettings(db, EUI, { strega_generation: generation });
    const h = harness(db);
    await store.insertSchedule(db, weekly('a', 0x3E, '06:00', 30)); // Mon-Fri
    await store.insertSchedule(db, weekly('b', 0x43, '18:00', 20)); // Sun, Mon, Sat
    const base = await h.compile(0);
    await h.emit(WINDOW_SEC);
    h.cs.drain(); // the valve took the whole baseline snapshot ...
    for (const row of base.rows) await db.run("UPDATE valve_schedule_pushes SET state='ACKED' WHERE push_id=?", [row.push_id]); // ... and confirmed it
    const enqueuedBefore = h.cs.log.enqueued.length;

    await store.softDeleteSchedule(db, 'a', EUI);
    const c1 = await h.compile(100);
    await store.softDeleteSchedule(db, 'b', EUI);
    const c2 = await h.compile(105);
    await h.emit(105 + WINDOW_SEC);

    assert.deepEqual(h.cs.getQueue(), asItems(c2.rows), 'the queue holds exactly compile 2');
    assert.equal(h.cs.log.enqueued.length - enqueuedBefore, c2.rows.length, 'nothing from compile 1 was ever enqueued');
    const valve = applyToValve(null, h.cs.getQueue());
    for (let d = 0; d < 7; d += 1) {
      if (generation === 'GEN1') assert.equal(valve.gen1[d], EMPTY_GEN1, `weekday ${d} has an explicit empty plan`);
      else assert.equal(valve.gen2[d], '', `weekday ${d} has an explicit zero-window clear`);
    }
    const c1States = await statesById(db, c1.rows.map((row) => row.push_id));
    assert.deepEqual([...new Set(c1States.map((s) => s.state))], ['SUPERSEDED']);
    assert.equal((await db.all("SELECT 1 FROM valve_schedule_pushes WHERE state='FAILED'")).length, 0, 'nothing is LOST');
    db.close();
  });

  test(`acceptance 2 (${generation}): add, edit, delete with zero uplinks -> the queue is snapshot 3 exactly and draining it gives the valve the DB state`, async () => {
    const { db } = await tempDb();
    await store.upsertSettings(db, EUI, { strega_generation: generation });
    const h = harness(db);
    await store.insertSchedule(db, weekly('keep', 0x7F, '05:00', 15));
    const s0 = await h.compile(0);
    await h.emit(WINDOW_SEC);
    const valve = applyToValve(null, h.cs.drain()); // the valve holds snapshot 0

    await store.insertSchedule(db, weekly('n', 0x14, '20:00', 10));
    await h.compile(100);
    await store.updateSchedule(db, 'n', { start_time: '21:00' }, EUI);
    await h.compile(110);
    await store.softDeleteSchedule(db, 'keep', EUI);
    const c3 = await h.compile(120);
    await h.emit(120 + WINDOW_SEC);

    assert.deepEqual(h.cs.getQueue(), asItems(c3.rows));
    applyToValve(valve, h.cs.drain());
    assert.deepEqual(valveView(valve, generation), await desiredValve(db, generation));
    assert.ok(s0.rows.length > 0);
    db.close();
  });

  test(`acceptance 3 (${generation}): the valve drains part of snapshot 1, then compile 2 -> every compile-1 row SUPERSEDED, the queue is compile 2's rows, no compile-1 plan payload reappears`, async () => {
    const { db } = await tempDb();
    await store.upsertSettings(db, EUI, { strega_generation: generation });
    const h = harness(db);
    await store.insertSchedule(db, weekly('d', 0x7F, '06:00', 30));
    await store.insertSchedule(db, weekly('m', 0x02, '19:00', 10)); // makes GEN2 two groups
    const c1 = await h.compile(0);
    await h.emit(WINDOW_SEC);
    const valve = applyToValve(null, h.cs.drain(generation === 'GEN1' ? 3 : 1));

    await store.updateSchedule(db, 'd', { start_time: '07:00' }, EUI); // every day's plan changes
    await store.updateSchedule(db, 'm', { start_time: '20:00' }, EUI);
    const c2 = await h.compile(200);
    await h.emit(200 + WINDOW_SEC);

    const c1States = await statesById(db, c1.rows.map((row) => row.push_id));
    assert.deepEqual([...new Set(c1States.map((s) => s.state))], ['SUPERSEDED'], 'drained or not, every compile-1 row is SUPERSEDED');
    assert.deepEqual(h.cs.getQueue(), asItems(c2.rows), 'the queue is compile 2, in order');
    const c1PlanHex = new Set(c1.rows.filter((row) => row.purpose !== 'SCHEDULER_STATUS').map((row) => row.payload_hex.toUpperCase()));
    for (const item of h.cs.getQueue()) assert.equal(c1PlanHex.has(item.hex), false, 'compile-1 plan bytes ' + item.hex + ' reappeared');
    applyToValve(valve, h.cs.drain());
    assert.deepEqual(valveView(valve, generation), await desiredValve(db, generation));
    db.close();
  });
}

test('acceptance 4 (GEN1 completeness): every snapshot has 7 weekday rows + status, also once every schedule is deleted', async () => {
  const { db } = await tempDb();
  const h = harness(db);
  const shape = (rows) => rows.map((row) => row.fport).sort((a, b) => a - b);
  const full = [14, 15, 16, 17, 18, 19, 20, 21];
  await store.insertSchedule(db, weekly('a', 0x08, '06:00', 30));
  assert.deepEqual(shape((await h.compile(0)).rows), full);
  await store.insertSchedule(db, weekly('b', 0x10, '07:00', 30));
  assert.deepEqual(shape((await h.compile(10)).rows), full);
  await store.softDeleteSchedule(db, 'a', EUI);
  await store.softDeleteSchedule(db, 'b', EUI);
  const empty = await h.compile(20);
  assert.deepEqual(shape(empty.rows), full, 'zero schedules still overwrites all 7 days');
  assert.ok(empty.rows.filter((row) => row.purpose === 'WEEKDAY_PLAN').every((row) => row.payload_hex === EMPTY_GEN1));
  db.close();
});

test('acceptance 5 (GEN2 completeness): every snapshot covers all 7 days, empty days as an explicit zero-window frame', async () => {
  const { db } = await tempDb();
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN2' });
  const h = harness(db);
  const covered = (rows) => rows.filter((row) => row.purpose === 'DAYMASK_PLAN')
    .reduce((m, row) => m | (row.payload_hex.slice(0, 2) === '80' ? 0x7F : parseInt(row.payload_hex.slice(0, 2), 16)), 0);
  await store.insertSchedule(db, weekly('a', 0x7F, '06:00', 30));
  const s1 = await h.compile(0);
  assert.equal(covered(s1.rows), 0x7F);
  await store.insertSchedule(db, weekly('b', 0x22, '19:00', 10)); // regroups Mon+Fri
  const s2 = await h.compile(10);
  assert.equal(covered(s2.rows), 0x7F);
  await store.updateSchedule(db, 'a', { weekdays_mask: 0x01 }, EUI); // Sun only; Tue-Thu, Sat now empty
  const s3 = await h.compile(20);
  assert.equal(covered(s3.rows), 0x7F, 'the days that lost their windows are cleared explicitly');
  assert.ok(s3.rows.some((row) => row.purpose === 'DAYMASK_PLAN' && row.payload_hex.length === 2), 'a zero-window clear frame is present');
  await store.softDeleteSchedule(db, 'a', EUI);
  await store.softDeleteSchedule(db, 'b', EUI);
  const s4 = await h.compile(30);
  assert.deepEqual(s4.rows.map((row) => row.payload_hex), ['30', '80'], 'no schedules left: status + one all-days clear');
  db.close();
});

test('acceptance 6: CLOCK_SYNC is never compiled; after a flush the next tick enqueues one freshly computed clock sync and no older one exists', async () => {
  const { db } = await tempDb();
  workers._resetHousekeepingForTests();
  const h = harness(db);
  await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
  const first = await h.tick(0); // clock due: never synced
  assert.equal(first.clock.messages.length, 1);
  const oldClockHex = h.cs.getQueue()[0].hex;
  const c = await h.compile(120);
  assert.equal(c.rows.some((row) => row.purpose === 'CLOCK_SYNC'), false);
  assert.equal(h.cs.getQueue().length, 0, 'the compile flushed the queued clock sync');
  assert.equal((await store.getSettings(db, EUI)).last_clock_sync_queued_at, null, 'the flushed clock sync leaves the valve due for a fresh one');

  await h.tick(180); // the next valve tick: emits the snapshot, then a fresh clock sync
  const clocks = h.cs.getQueue().filter((item) => item.fPort === 12);
  assert.equal(clocks.length, 1);
  assert.equal(clocks[0].hex, buildClockPush('GEN1', at(180), 'UTC').payloadHex, 'computed at the tick, from the tick\'s own time');
  assert.notEqual(clocks[0].hex, oldClockHex);
  const queuedClockRows = await db.all("SELECT payload_hex FROM valve_schedule_pushes WHERE purpose='CLOCK_SYNC' AND state='QUEUED'");
  assert.deepEqual(queuedClockRows.map((r) => r.payload_hex), [clocks[0].hex]);
  db.close();
});

test('acceptance 7: the 24 h sweep marks only the latest snapshot LOST and surfaces it; SUPERSEDED rows are never surfaced or re-sent', async () => {
  const { db } = await tempDb();
  await linkCloud(db);
  const h = harness(db);
  await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
  const c1 = await h.compile(0);
  await store.insertSchedule(db, weekly('b', 0x04, '07:00', 30));
  const c2 = await h.compile(10);
  await h.emit(10 + WINDOW_SEC);
  await db.run("UPDATE valve_schedule_pushes SET queued_at='2026-08-18 08:00:00'");
  const enqueuedBefore = h.cs.log.enqueued.length;
  await workers.runClockTick({ db, now: at(0), appId: 'app', warn: () => {} });

  const c1States = await statesById(db, c1.rows.map((row) => row.push_id));
  assert.deepEqual([...new Set(c1States.map((s) => s.state))], ['SUPERSEDED'], 'superseded rows are not swept');
  const c2States = await statesById(db, c2.rows.map((row) => row.push_id));
  for (const s of c2States) assert.deepEqual({ state: s.state, error: s.error }, { state: 'FAILED', error: 'stale_unconfirmed' });
  const summary = await store.pushSummary(db, EUI, at(0));
  assert.equal(summary.lost, 7);
  assert.equal(summary.failed, 7);
  assert.equal(summary.queued, 0);
  assert.equal(summary.scheduler_status_lost, true);
  const states = await store.weekdayPushStates(db, EUI);
  assert.equal(states.some((r) => r.state === 'SUPERSEDED'), false);
  assert.deepEqual([...new Set(states.filter((r) => c2.rows.some((row) => row.payload_hex === r.payload_hex && row.weekday === r.weekday)).map((r) => r.state))], ['LOST']);
  const payload = JSON.parse((await db.get("SELECT payload_json FROM sync_outbox WHERE op='VALVE_RUNTIME_CHANGED' ORDER BY rowid DESC LIMIT 1")).payload_json);
  assert.equal(payload.push_state.lost, 7, 'the sweep emitted a runtime change carrying the loss');
  assert.equal(payload.push_state.scheduler_status_lost, true);

  // Nothing resends them on its own.
  await h.emit(5000);
  await h.tick(5000);
  assert.equal(h.cs.log.enqueued.slice(enqueuedBefore).filter((item) => item.fPort !== 12).length, 0, 'no plan or status row is re-sent');
  db.close();
});

test('acceptance 8: a late ACK for a SUPERSEDED row leaves the ledger unchanged; an ACK for a snapshot still waiting to be emitted is not credited', async () => {
  const { db } = await tempDb();
  const h = harness(db);
  await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
  const c1 = await h.compile(0);
  await h.emit(WINDOW_SEC);
  await store.updateSchedule(db, 'a', { start_time: '07:00' }, EUI);
  const c2 = await h.compile(100);
  await h.emit(100 + WINDOW_SEC);
  for (const row of c2.rows) assert.equal(await store.ackPush(db, EUI, row.purpose, row.fport, row.weekday, 0, '2026-08-19T11:00:00.000Z'), 1);
  const before = await db.all('SELECT * FROM valve_schedule_pushes ORDER BY rowid');
  const lateMonday = c1.rows.find((row) => row.weekday === 1);
  assert.equal(await store.ackPush(db, EUI, 'WEEKDAY_PLAN', lateMonday.fport, 1, 0, '2026-08-19T11:05:00.000Z'), 0);
  assert.deepEqual(await db.all('SELECT * FROM valve_schedule_pushes ORDER BY rowid'), before);

  // A third edit: its snapshot waits out the debounce window. An ACK that arrives meanwhile was
  // sent for an earlier snapshot and must not mark the new, never-sent row ACKED.
  await store.updateSchedule(db, 'a', { start_time: '08:00' }, EUI);
  const c3 = await h.compile(300);
  assert.equal(await store.ackPush(db, EUI, 'WEEKDAY_PLAN', lateMonday.fport, 1, 0, '2026-08-19T11:06:00.000Z'), 0);
  assert.equal((await statesById(db, [c3.rows.find((row) => row.weekday === 1).push_id]))[0].state, 'QUEUED');
  db.close();
});

test('acceptance 9: after K compiles the queue holds at most one snapshot plus one CLOCK_SYNC', async () => {
  const { db } = await tempDb();
  workers._resetHousekeepingForTests();
  const h = harness(db);
  await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
  let sec = 0;
  for (let k = 0; k < 6; k += 1) {
    await store.updateSchedule(db, 'a', { start_time: '0' + (k + 1) + ':00' }, EUI);
    await h.compile(sec);
    if (k % 2) h.cs.drain(1); // an uplink now and then
    await h.tick(sec + 60);
    await h.tick(sec + 61);
    const q = h.cs.getQueue();
    assert.ok(q.filter((item) => item.fPort === 12).length <= 1, 'at most one clock sync');
    assert.ok(q.filter((item) => item.fPort !== 12).length <= 8, 'at most one snapshot');
    sec += 120;
  }
  db.close();
});

test('acceptance 10: five edits inside the debounce window produce one snapshot on the air', async () => {
  const { db } = await tempDb();
  const h = harness(db);
  await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
  const results = [];
  for (let i = 0; i < 5; i += 1) {
    await store.updateSchedule(db, 'a', { duration_minutes: 30 + i }, EUI);
    results.push(await h.compile(i * 5));
    assert.equal((await h.emit(i * 5 + 1)).messages.length, 0, 'still inside the window');
  }
  await h.emit(20 + WINDOW_SEC);
  assert.equal(h.cs.log.enqueued.length, 8, 'one snapshot was enqueued');
  assert.deepEqual(h.cs.getQueue(), asItems(results[4].rows), 'and it is the last one');
  for (const r of results.slice(0, 4)) {
    assert.deepEqual([...new Set((await statesById(db, r.rows.map((row) => row.push_id))).map((s) => s.state))], ['SUPERSEDED']);
  }
  db.close();
});

test('snapshot: a scheduler-status change on a valve the gateway never programmed sends the status only (a Bluetooth plan is not wiped)', async () => {
  const { db } = await tempDb();
  const h = harness(db);
  const r = await h.compile(0, { schedulerStatus: 'DEACTIVATED' });
  assert.deepEqual(r.rows.map((row) => [row.purpose, row.payload_hex]), [['SCHEDULER_STATUS', '32']]);
  db.close();
});

test('snapshot: a scheduler-status change on a programmed valve sends the full plan with the new status', async () => {
  const { db } = await tempDb();
  const h = harness(db);
  await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
  const r = await h.compile(0, { schedulerStatus: 'SKIP_TODAY' });
  assert.equal(r.rows.length, 8);
  assert.equal(r.rows[0].payload_hex, '31');
  await assert.rejects(() => h.compile(5, { schedulerStatus: 'NONSENSE' }));
  db.close();
});

test('snapshot: without a flush (an open still awaiting observation) older rows are still SUPERSEDED, and the new snapshot is appended behind them', async () => {
  const { db } = await tempDb();
  const h = harness(db);
  await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
  const c1 = await h.compile(0);
  await h.emit(WINDOW_SEC);
  await db.run(
    "INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, created_at) VALUES ('e1', ?, '2026-08-19T10:01:00Z', 600, '2026-08-19T10:11:00Z', 'unknown', 'PENDING_OBSERVATION', '2026-08-19T10:01:00Z')",
    [EUI]);
  await store.updateSchedule(db, 'a', { start_time: '07:00' }, EUI);
  const c2 = await h.compile(100);
  assert.equal(c2.flushed, false);
  assert.equal((await h.emit(100 + WINDOW_SEC)).messages.length, 0, 'held while the open is unobserved (R5 M5)');
  await db.run("UPDATE valve_actuation_expectations SET reconciliation_state='OBSERVED_RUNNING' WHERE expectation_id='e1'");
  await h.emit(200 + WINDOW_SEC);
  assert.deepEqual(h.cs.getQueue(), asItems(c1.rows).concat(asItems(c2.rows)), 'FIFO: the valve applies snapshot 1, then snapshot 2, and ends on 2');
  assert.deepEqual([...new Set((await statesById(db, c1.rows.map((row) => row.push_id))).map((s) => s.state))], ['SUPERSEDED']);
  db.close();
});

test('MAJOR-A: a Gen1->Gen2 self-correction snapshot supersedes the abandoned WEEKDAY_PLAN rows; pushSummary shows only the 7 GEN2 slots', async () => {
  const { db } = await tempDb();
  const h = harness(db);
  await store.insertSchedule(db, weekly('g1', 127, '06:00', 30));
  await h.compile(0);
  assert.equal((await store.pushSummary(db, EUI, at(0))).queued, 7);
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN2' });
  const r2 = await h.compile(10, { force: true });
  assert.deepEqual(r2.rows.map((row) => row.payload_hex), ['30', '8086000630']);
  const weekdayStates = await db.all("SELECT state FROM valve_schedule_pushes WHERE purpose='WEEKDAY_PLAN'");
  assert.deepEqual(new Set(weekdayStates.map((r) => r.state)), new Set(['SUPERSEDED']));
  const after = await store.pushSummary(db, EUI, at(10));
  assert.equal(after.queued, 7);
  assert.equal(after.failed, 0);
  db.close();
});

test('M1: a Gen2->Gen1 demotion compiles a full GEN1 snapshot and supersedes the leftover DAYMASK_PLAN row; another device is untouched', async () => {
  const { db } = await tempDb();
  const h = harness(db);
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN2' });
  await store.insertSchedule(db, weekly('g1', 127, '06:00', 30));
  await h.compile(0);
  const OTHER = EUI.slice(0, 15) + '2'; // a second fixture valve
  await db.run("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES (?,'Valve B','STREGA_VALVE',1,datetime('now'),datetime('now'))", [OTHER]);
  await store.insertSchedule(db, Object.assign(weekly('o1', 127, '06:00', 30), { device_eui: OTHER }));
  await store.upsertSettings(db, OTHER, { strega_generation: 'GEN2' });
  await compileAndQueue({ db, deviceEui: OTHER, appId: 'app', now: at(0), flushQueue: async () => {}, warn: () => {} });

  await store.upsertSettings(db, EUI, { strega_generation: 'GEN1' });
  const r = await h.compile(20);
  assert.equal(r.rows.filter((row) => row.purpose === 'WEEKDAY_PLAN').length, 7);
  const dm = await db.all('SELECT state FROM valve_schedule_pushes WHERE device_eui=? AND purpose=?', [EUI, 'DAYMASK_PLAN']);
  assert.deepEqual(new Set(dm.map((x) => x.state)), new Set(['SUPERSEDED']));
  const other = await db.all('SELECT state FROM valve_schedule_pushes WHERE device_eui=?', [OTHER]);
  assert.deepEqual(new Set(other.map((x) => x.state)), new Set(['QUEUED']));
  db.close();
});

test('M1: a clock-sync-only queuePushes call (the clock tick) supersedes no plan or status row and flushes nothing', async () => {
  const { db } = await tempDb();
  const h = harness(db);
  await store.insertSchedule(db, weekly('g1', 127, '06:00', 30));
  await h.compile(0);
  await queuePushes({ db, deviceEui: EUI, appId: 'app', pushes: [buildClockPush('GEN1', at(5), 'UTC')], warn: () => {} });
  const states = await db.all("SELECT DISTINCT state FROM valve_schedule_pushes WHERE purpose IN ('WEEKDAY_PLAN','SCHEDULER_STATUS')");
  assert.deepEqual(states.map((r) => r.state), ['QUEUED']);
  assert.equal(h.cs.log.flushes, 1, 'only the compile flushed');
  db.close();
});

test('P3-E1: a snapshot compile emits one VALVE_RUNTIME_CHANGED on a linked gateway; a clock-sync-only call does not', async () => {
  const { db } = await tempDb();
  await linkCloud(db);
  const h = harness(db);
  await store.insertSchedule(db, weekly('g1', 1, '06:00', 30));
  await h.compile(0);
  assert.equal((await db.all("SELECT op FROM sync_outbox WHERE op='VALVE_RUNTIME_CHANGED'")).length, 1);
  await queuePushes({ db, deviceEui: EUI, appId: 'app', pushes: [buildClockPush('GEN1', at(5), 'UTC')], warn: () => {} });
  assert.equal((await db.all("SELECT op FROM sync_outbox WHERE op='VALVE_RUNTIME_CHANGED'")).length, 1);
  db.close();
});

test('P3-E1: a snapshot compile still commits its ledger writes when the runtime emission inside the same transaction fails', async () => {
  const { db } = await tempDb();
  await linkCloud(db);
  await store.insertSchedule(db, weekly('g1', 1, '06:00', 30));
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
  const r = await compileAndQueue({ db: failingDb, deviceEui: EUI, appId: 'app', now: at(0), flushQueue: async () => {}, warn: (m) => warnings.push(m) });
  assert.equal(r.rows.length, 8);
  assert.equal((await db.all("SELECT 1 FROM valve_schedule_pushes WHERE state='QUEUED'")).length, 8);
  assert.equal((await db.all("SELECT * FROM sync_outbox WHERE op='VALVE_RUNTIME_CHANGED'")).length, 0);
  assert.ok(warnings.some((w) => /runtime emit failed/.test(w)));
  db.close();
});

// ---------------------------------------------------------------------------------------------
// R5 review fixes (H1, M1, M2, M3, M5, L1, L3, G1).
// ---------------------------------------------------------------------------------------------
const { cancelActuation } = require('./cancel');

async function runningOpen(db, id) {
  await db.run(
    "INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, trigger, created_at) VALUES (?, ?, '2026-08-19T10:01:00.000Z', 900, '2026-08-19T10:16:00.000Z', 'unknown', 'OBSERVED_RUNNING', 'manual', '2026-08-19T10:01:00.000Z')",
    [id, EUI]);
}

test('H1 (probe C): a whole-queue cancel flush after the clears left marks them LOST at once, surfaced, and nothing re-sends them', async () => {
  const { db } = await tempDb();
  await linkCloud(db);
  workers._resetHousekeepingForTests();
  const h = harness(db);
  await store.insertSchedule(db, weekly('a', 0x3E, '06:00', 30));
  await h.compile(0);
  await h.emit(WINDOW_SEC);
  await store.softDeleteSchedule(db, 'a', EUI);
  const clears = await h.compile(100);
  await h.emit(100 + WINDOW_SEC); // the clears are on the air
  assert.equal(h.cs.getQueue().length, 8);
  await runningOpen(db, 'e-run');

  const out = await cancelActuation({ db, deviceEui: EUI, all: true, reason: 'operator', flushQueue: h.cs.flushQueue, now: at(200) });
  assert.equal(out.ok, true);
  assert.equal(h.cs.getQueue().length, 0, 'D19 (a): the whole queue went, clears included');
  const states = await statesById(db, clears.rows.map((r) => r.push_id));
  for (const s of states) assert.deepEqual({ state: s.state, error: s.error }, { state: 'FAILED', error: 'not_resent_q02c' });
  const summary = await store.pushSummary(db, EUI, at(200));
  assert.equal(summary.lost, 7);
  assert.equal(summary.scheduler_status_lost, true);
  const payload = JSON.parse((await db.get("SELECT payload_json FROM sync_outbox WHERE op='VALVE_RUNTIME_CHANGED' ORDER BY rowid DESC LIMIT 1")).payload_json);
  assert.equal(payload.push_state.lost, 7, 'the GUI and the cloud see it immediately, not after 24 h');

  const before = h.cs.log.enqueued.length;
  for (let s = 260; s <= 260 + 7200; s += 600) await h.tick(s);
  assert.equal(h.cs.log.enqueued.slice(before).filter((i) => i.fPort !== 12).length, 0, 'nothing re-sends the clears (owner question: D03 vs Q02 c)');
  db.close();
});

test('H1: a snapshot still waiting out the debounce window is not in the radio queue, so a cancel flush leaves it pending and it is still sent', async () => {
  const { db } = await tempDb();
  const h = harness(db);
  await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
  const snap = await h.compile(0);
  await runningOpen(db, 'e-run');
  await cancelActuation({ db, deviceEui: EUI, all: true, reason: 'operator', flushQueue: h.cs.flushQueue, now: at(5) });
  assert.deepEqual([...new Set((await statesById(db, snap.rows.map((r) => r.push_id))).map((s) => s.state))], ['QUEUED']);
  await h.emit(WINDOW_SEC + 5);
  assert.deepEqual(h.cs.getQueue(), asItems(snap.rows));
  db.close();
});

test('M1: SCHEDULER_STATUS is the first row of every snapshot (GEN1, GEN2, status change, decommission)', async () => {
  const { db } = await tempDb();
  const h = harness(db);
  await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
  assert.equal((await h.compile(0)).rows[0].purpose, 'SCHEDULER_STATUS');
  assert.equal((await h.compile(5, { schedulerStatus: 'DEACTIVATED' })).rows[0].payload_hex, '32');
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN2' });
  assert.equal((await h.compile(10)).rows[0].purpose, 'SCHEDULER_STATUS');
  const decom = buildSnapshotPushes({ generation: 'GEN1', days: Array.from({ length: 7 }, () => []), schedulerStatus: 'DEACTIVATED', includePlan: true });
  assert.equal(decom[0].purpose, 'SCHEDULER_STATUS');
  db.close();
});

test('M3: a plan_conflict in the stored schedules does not block pause/skip/resume: the status goes out alone', async () => {
  const { db } = await tempDb();
  const h = harness(db);
  for (let i = 1; i <= 5; i += 1) await store.insertSchedule(db, weekly('x' + i, 4, '0' + i + ':00', 10)); // 5 windows on Tuesday
  const warnings = [];
  const r = await compileAndQueue({ db, deviceEui: EUI, appId: 'app', now: at(0), flushQueue: h.cs.flushQueue, warn: (m) => warnings.push(m), schedulerStatus: 'DEACTIVATED', statusOnlyOnConflict: true });
  assert.deepEqual(r.rows.map((row) => [row.purpose, row.payload_hex]), [['SCHEDULER_STATUS', '32']]);
  assert.ok(warnings.some((w) => /plan_conflict/.test(w)));
  await assert.rejects(() => compileAndQueue({ db, deviceEui: EUI, appId: 'app', now: at(5), flushQueue: h.cs.flushQueue, warn: () => {} }), (e) => e.code === 'plan_conflict');
  db.close();
});

test('M2: a compile that races another compile during its flush builds its snapshot from the schedules as they are at write time', async () => {
  const { db } = await tempDb();
  const cs = fakeChirpStack();
  await store.insertSchedule(db, weekly('keep', 0x02, '06:00', 30));
  await store.insertSchedule(db, weekly('gone', 0x10, '07:00', 30)); // Thursday
  // While A's flush is in flight, B deletes 'gone' and compiles (the cloud bridge, another DB handle).
  let raced = false;
  const racingFlush = async (eui) => {
    if (!raced) {
      raced = true;
      await store.softDeleteSchedule(db, 'gone', EUI);
      await compileAndQueue({ db, deviceEui: EUI, appId: 'app', now: at(1), flushQueue: cs.flushQueue, warn: () => {} });
    }
    return cs.flushQueue(eui);
  };
  const a = await compileAndQueue({ db, deviceEui: EUI, appId: 'app', now: at(2), flushQueue: racingFlush, warn: () => {} });
  const thursday = a.rows.find((row) => row.weekday === 4);
  assert.equal(thursday.payload_hex, EMPTY_GEN1, 'A must not resurrect the schedule B deleted');
  const marker = await store.getSnapshotPending(db, EUI);
  assert.deepEqual(marker.push_ids, a.rows.map((row) => row.push_id));
  db.close();
});

test('M5: while an open awaits observation the pending snapshot is held, so edit bursts append one snapshot, not one per burst', async () => {
  const { db } = await tempDb();
  const h = harness(db);
  await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
  const c1 = await h.compile(0);
  await h.emit(WINDOW_SEC);
  await db.run(
    "INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, created_at) VALUES ('e1', ?, '2026-08-19T10:01:00Z', 600, '2026-08-19T10:11:00Z', 'unknown', 'PENDING_OBSERVATION', '2026-08-19T10:01:00Z')",
    [EUI]);
  let last = null;
  for (let i = 0; i < 3; i += 1) {
    await store.updateSchedule(db, 'a', { start_time: '0' + (7 + i) + ':00' }, EUI);
    last = await h.compile(100 + i * 100);
    assert.equal((await h.emit(100 + i * 100 + WINDOW_SEC + 5)).messages.length, 0, 'held while the open is unobserved');
  }
  await db.run("UPDATE valve_actuation_expectations SET reconciliation_state='OBSERVED_RUNNING' WHERE expectation_id='e1'");
  await h.emit(1000);
  assert.deepEqual(h.cs.getQueue(), asItems(c1.rows).concat(asItems(last.rows)), 'one held snapshot appended behind the unflushed one');
  db.close();
});

test('L3: the debounce has an upper bound: edits every 20 s still send a snapshot within 5 minutes of the first one', async () => {
  const { db } = await tempDb();
  const h = harness(db);
  await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
  let emittedAt = null;
  for (let sec = 0; sec <= 600 && emittedAt === null; sec += 20) {
    await store.updateSchedule(db, 'a', { duration_minutes: 30 + (sec / 20) % 60 }, EUI);
    await h.compile(sec);
    if ((await h.emit(sec + 10)).messages.length) emittedAt = sec + 10;
  }
  assert.ok(emittedAt !== null && emittedAt <= 300 + 20, 'emitted by the max-age bound, at ' + emittedAt);
  db.close();
});

test('L1: deleting the only WEEKLY schedule of a valve with no plan history still clears the valve (the tombstone is the intent)', async () => {
  const { db } = await tempDb();
  const h = harness(db);
  await store.insertSchedule(db, weekly('a', 0x3E, '06:00', 30)); // e.g. a restored DB: schedule on record, no push on record
  await store.softDeleteSchedule(db, 'a', EUI);
  const r = await h.compile(0);
  assert.equal(r.rows.length, 8);
  assert.ok(r.rows.filter((row) => row.purpose === 'WEEKDAY_PLAN').every((row) => row.payload_hex === EMPTY_GEN1));
  db.close();
});

test('G1: the GEN2 whole-plan clear prefix is off by default and, when set, sends status, 80, then only the non-empty groups', async () => {
  const { db } = await tempDb();
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN2' });
  const h = harness(db);
  await store.insertSchedule(db, weekly('a', 0x22, '06:00', 30)); // Mon + Fri
  const plain = await h.compile(0);
  assert.deepEqual(plain.rows.map((row) => row.payload_hex), ['30', '5D', '2286000630'], 'default: gen2Groups with the zero-window frame for the other days');
  await db.run("INSERT INTO app_settings(key, value) VALUES ('valve_gen2_snapshot_clear_prefix', '1')");
  const prefixed = await h.compile(10);
  assert.deepEqual(prefixed.rows.map((row) => row.payload_hex), ['30', '80', '2286000630'], 'fail-dry: clear everything, then program what is wanted');
  await store.softDeleteSchedule(db, 'a', EUI);
  const cleared = await h.compile(20);
  assert.deepEqual(cleared.rows.map((row) => row.payload_hex), ['30', '80']);
  db.close();
});

// ---------------------------------------------------------------------------------------------
// R5 re-review fixes (N1, N2, N3) -- probes D, G and H.
// ---------------------------------------------------------------------------------------------

test('N1 (probe D): a delete compiled during an unobserved manual open is not held past the 5-minute cap', async () => {
  const { db } = await tempDb();
  workers._resetHousekeepingForTests();
  const h = harness(db);
  await store.insertSchedule(db, weekly('a', 0x3E, '06:00', 30));
  await h.compile(0);
  await h.emit(WINDOW_SEC);
  await db.run(
    "INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, created_at) VALUES ('e-open', ?, '2026-08-19T10:01:00Z', 7200, '2026-08-19T12:01:00Z', 'unknown', 'PENDING_OBSERVATION', '2026-08-19T10:01:00Z')",
    [EUI]);
  await store.softDeleteSchedule(db, 'a', EUI);
  const clears = await h.compile(100);
  let emittedAt = null;
  for (let sec = 160; sec <= 3600 && emittedAt === null; sec += 60) {
    if ((await h.emit(sec)).messages.length) emittedAt = sec;
  }
  assert.ok(emittedAt !== null && emittedAt - 100 <= SNAPSHOT_MAX_DELAY_MS / 1000 + 60, 'the clears left ' + emittedAt + ' s in, within the cap');
  assert.ok(emittedAt - 100 >= WINDOW_SEC, 'but not before the debounce window');
  const tail = h.cs.getQueue().slice(-clears.rows.length);
  assert.deepEqual(tail, asItems(clears.rows), 'appended behind the unflushed queue');
  db.close();
});

test('N2 (probe G): a pause is written in the snapshot transaction, so a compile from another origin right after it carries DEACTIVATED', async () => {
  const { path, db: setupDb } = await tempDb();
  await store.insertSchedule(setupDb, weekly('a', 0x02, '06:00', 30));
  await compileAndQueue({ db: setupDb, deviceEui: EUI, appId: 'app', now: at(0), flushQueue: async () => {}, warn: () => {} });
  setupDb.close();
  const { handleHttpRequest } = require('./api');
  const { DatabaseSync } = require('node:sqlite');
  const { facade } = require('./test-helpers');
  // After the pause's snapshot transaction commits, the cloud bridge (another DB handle)
  // compiles an edit before the route returns.
  function RacingDatabase(dbPath) {
    const d = facade(new DatabaseSync(dbPath));
    const tx = d.transaction.bind(d);
    let raced = false;
    d.transaction = async (executor) => {
      const out = await tx(executor);
      if (!raced) {
        raced = true;
        const other = facade(new DatabaseSync(dbPath));
        await compileAndQueue({ db: other, deviceEui: EUI, appId: 'app', now: at(10), flushQueue: async () => {}, warn: () => {} });
        other.close();
      }
      return out;
    };
    return d;
  }
  const crypto = require('node:crypto');
  const SECRET = 'test-secret';
  const token = Buffer.from(JSON.stringify({ userId: 1, username: 'u', exp: Date.now() + 60000 })).toString('base64url');
  const auth = 'Bearer ' + token + '.' + crypto.createHmac('sha256', SECRET).update(token).digest('base64url');
  const out = await handleHttpRequest({
    msg: { req: { method: 'POST', url: '/api/valves/' + EUI + '/scheduler-status', headers: { authorization: auth }, params: {} }, payload: { status: 'DEACTIVATED' } },
    Database: RacingDatabase, environment: { authTokenSecret: SECRET, dbPath: path }, appId: 'app', flushQueue: async () => {}, now: at(5), warn: () => {},
  });
  assert.equal(out.statusCode, 202);
  const check = facade(new DatabaseSync(path));
  assert.equal((await store.getSettings(check, EUI)).scheduler_status, 'DEACTIVATED');
  const marker = await store.getSnapshotPending(check, EUI);
  const pending = await store.queuedPushesById(check, EUI, marker.push_ids);
  assert.equal(pending[0].payload_hex, '32', 'the newest snapshot carries the pause, not the old status');
  check.close();
});

test('N3 (probe H): a tick that emits between a cancel\'s flush and its transaction does not get its rows marked LOST', async () => {
  const { db } = await tempDb();
  const h = harness(db);
  await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
  const snap = await h.compile(0);
  await runningOpen(db, 'e-run');
  const flushThenTick = async (eui) => {
    const r = await h.cs.flushQueue(eui);
    await h.emit(WINDOW_SEC + 30); // the valve tick fires inside the cancel's gap
    return r;
  };
  const out = await cancelActuation({ db, deviceEui: EUI, all: true, reason: 'operator', flushQueue: flushThenTick, now: at(WINDOW_SEC + 30) });
  assert.equal(out.ok, true);
  assert.deepEqual(h.cs.getQueue(), asItems(snap.rows), 'the snapshot is on the air');
  assert.deepEqual([...new Set((await statesById(db, snap.rows.map((r) => r.push_id))).map((s) => s.state))], ['QUEUED'], 'so it is not LOST');
  db.close();
});

// ---------------------------------------------------------------------------------------------
// R5 final re-review N4: the emission/flush ordering must not depend on the wall clock. With
// the clock frozen, the emission and the cancel's flush fall in the same millisecond.
// ---------------------------------------------------------------------------------------------
async function withFrozenClock(fn) {
  const RealDate = Date;
  const FIXED = RealDate.parse('2026-10-19T03:00:00.000Z');
  class FrozenDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(FIXED); }
    static now() { return FIXED; }
  }
  global.Date = FrozenDate;
  try { return await fn(); } finally { global.Date = RealDate; }
}

test('N4: same-millisecond tie, emitted before the cancel -> the flushed clears are LOST (probe C with a frozen clock)', async () => {
  await withFrozenClock(async () => {
    const { db } = await tempDb();
    const h = harness(db);
    await store.insertSchedule(db, weekly('a', 0x3E, '06:00', 30));
    await h.compile(0);
    await h.emit(WINDOW_SEC);
    await store.softDeleteSchedule(db, 'a', EUI);
    const clears = await h.compile(100);
    await h.emit(100 + WINDOW_SEC);
    await runningOpen(db, 'e-run');
    await cancelActuation({ db, deviceEui: EUI, all: true, reason: 'operator', flushQueue: h.cs.flushQueue, now: at(200) });
    for (const s of await statesById(db, clears.rows.map((r) => r.push_id))) assert.deepEqual({ state: s.state, error: s.error }, { state: 'FAILED', error: 'not_resent_q02c' });
    db.close();
  });
});

test('N4: same-millisecond tie, emitted inside the cancel\'s flush -> the rows stay QUEUED (probe H with a frozen clock)', async () => {
  await withFrozenClock(async () => {
    const { db } = await tempDb();
    const h = harness(db);
    await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
    const snap = await h.compile(0);
    await runningOpen(db, 'e-run');
    const flushThenTick = async (eui) => { const r = await h.cs.flushQueue(eui); await h.emit(WINDOW_SEC + 30); return r; };
    await cancelActuation({ db, deviceEui: EUI, all: true, reason: 'operator', flushQueue: flushThenTick, now: at(WINDOW_SEC + 30) });
    assert.deepEqual([...new Set((await statesById(db, snap.rows.map((r) => r.push_id))).map((s) => s.state))], ['QUEUED']);
    db.close();
  });
});
