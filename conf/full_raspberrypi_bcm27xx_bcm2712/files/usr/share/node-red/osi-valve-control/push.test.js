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
const push = require('./push');
const { compileAndQueue, queuePushes, emitPendingSnapshots, buildSnapshotPushes, setSchedulerStatus, SNAPSHOT_DEBOUNCE_MS, SNAPSHOT_MAX_DELAY_MS } = push;

const T0 = Date.parse('2026-08-19T10:00:00Z');
const at = (sec) => new Date(T0 + sec * 1000);
const WINDOW_SEC = SNAPSHOT_DEBOUNCE_MS / 1000;
const EMPTY_GEN1 = 'FF'.repeat(24);
const weekly = (uuid, mask, start, dur) => ({ schedule_uuid: uuid, device_eui: EUI, kind: 'WEEKLY', label: null, weekdays_mask: mask, start_time: start, duration_minutes: dur, timezone: 'UTC', enabled: 1 });
const asItems = (rows) => rows.map((r) => ({ fPort: r.fport, hex: r.payload_hex.toUpperCase() }));
const hex = (buf) => Buffer.from(buf).toString('hex').toUpperCase();
const MODES = ['mqtt', 'transport'];

// mode 'mqtt': the no-transport fallback (MQTT messages handed to the fake queue).
// mode 'transport': the production path on this branch -- every write goes through
// dispatch.flushValveQueue / enqueueValveCommand against the same fake queue; `messages` stay
// empty and the counts come from what the fake actually enqueued.
function harness(db, mode) {
  const cs = fakeChirpStack();
  const viaTransport = mode === 'transport';
  const io = viaTransport ? { transport: cs.transport } : { flushQueue: cs.flushQueue };
  const sent = (r, before) => (viaTransport ? cs.log.enqueued.slice(before) : r.messages);
  return {
    cs, mode: viaTransport ? 'transport' : 'mqtt',
    compile: (sec, extra) => compileAndQueue(Object.assign({ db, deviceEui: EUI, appId: 'app', now: at(sec), warn: () => {} }, io, extra || {})),
    emit: async (sec) => {
      const before = cs.log.enqueued.length;
      const r = await emitPendingSnapshots(Object.assign({ db, now: at(sec), appId: 'app', warn: () => {} }, viaTransport ? { transport: cs.transport } : {}));
      if (!viaTransport) cs.enqueue(r.messages);
      return Object.assign({}, r, { messages: sent(r, before) });
    },
    tick: async (sec) => {
      const tio = viaTransport ? { transport: cs.transport } : {};
      const before = cs.log.enqueued.length;
      const h = await workers.runHousekeeping(Object.assign({ db, now: at(sec), appId: 'app', warn: () => {} }, tio));
      if (!viaTransport) cs.enqueue(h.messages);
      const mid = cs.log.enqueued.length;
      const c = await workers.runClockTick(Object.assign({ db, now: at(sec), appId: 'app', warn: () => {} }, tio));
      if (!viaTransport) cs.enqueue(c.messages);
      return { housekeeping: Object.assign({}, h, { messages: viaTransport ? cs.log.enqueued.slice(before, mid) : h.messages }),
        clock: Object.assign({}, c, { messages: viaTransport ? cs.log.enqueued.slice(mid) : c.messages }) };
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

for (const mode of MODES) for (const generation of ['GEN1', 'GEN2']) {
  test(`acceptance 1 (${generation}) [${mode}]: two quick deletes with no uplink between leave only compile-2 rows queued, with an explicit clear for every day either schedule covered; compile-1 rows SUPERSEDED, none LOST, none re-enqueued`, async () => {
    const { db } = await tempDb();
    await store.upsertSettings(db, EUI, { strega_generation: generation });
    const h = harness(db, mode);
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

  test(`acceptance 2 (${generation}) [${mode}]: add, edit, delete with zero uplinks -> the queue is snapshot 3 exactly and draining it gives the valve the DB state`, async () => {
    const { db } = await tempDb();
    await store.upsertSettings(db, EUI, { strega_generation: generation });
    const h = harness(db, mode);
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

  test(`acceptance 3 (${generation}) [${mode}]: the valve drains part of snapshot 1, then compile 2 -> every compile-1 row SUPERSEDED, the queue is compile 2's rows, no compile-1 plan payload reappears`, async () => {
    const { db } = await tempDb();
    await store.upsertSettings(db, EUI, { strega_generation: generation });
    const h = harness(db, mode);
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

for (const mode of MODES) test(`acceptance 4 (GEN1 completeness) [${mode}]: every snapshot has 7 weekday rows + status, also once every schedule is deleted`, async () => {
  const { db } = await tempDb();
  const h = harness(db, mode);
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

for (const mode of MODES) test(`acceptance 5 (GEN2 completeness) [${mode}]: every snapshot covers all 7 days, empty days as an explicit zero-window frame`, async () => {
  const { db } = await tempDb();
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN2' });
  const h = harness(db, mode);
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

for (const mode of MODES) test(`acceptance 6 [${mode}]: CLOCK_SYNC is never compiled; after a flush the next tick enqueues one freshly computed clock sync and no older one exists`, async () => {
  const { db } = await tempDb();
  workers._resetHousekeepingForTests();
  const h = harness(db, mode);
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

for (const mode of MODES) test(`acceptance 7 [${mode}]: the 24 h sweep marks only the latest snapshot LOST and surfaces it; SUPERSEDED rows are never surfaced or re-sent`, async () => {
  const { db } = await tempDb();
  await linkCloud(db);
  const h = harness(db, mode);
  await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
  const c1 = await h.compile(0);
  await store.insertSchedule(db, weekly('b', 0x04, '07:00', 30));
  const c2 = await h.compile(10);
  await h.emit(10 + WINDOW_SEC);
  await db.run("UPDATE valve_schedule_pushes SET queued_at='2026-08-18 08:00:00'");
  const enqueuedBefore = h.cs.log.enqueued.length;
  await workers.runClockTick(Object.assign({ db, now: at(0), appId: 'app', warn: () => {} }, mode === 'transport' ? { transport: h.cs.transport } : {}));

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

// On this branch only rows that went through the transport (a durable ATTEMPTED/ACCEPTED owner)
// can be credited by an ACK, so acceptance 8 runs on the transport path. dispatch stamps
// attempted_at from the runtime clock, so the ACK instants follow the real clock.
test('acceptance 8 [transport]: a late ACK for a SUPERSEDED row leaves the ledger unchanged; an ACK for a snapshot still waiting to be emitted is not credited', async () => {
  const { db } = await tempDb();
  const h = harness(db, 'transport');
  const ackAt = (min) => new Date(Date.now() + min * 60000).toISOString();
  await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
  const c1 = await h.compile(0);
  await h.emit(WINDOW_SEC);
  await store.updateSchedule(db, 'a', { start_time: '07:00' }, EUI);
  const c2 = await h.compile(100);
  await h.emit(100 + WINDOW_SEC);
  // GEN1 has no verifiable status ACK; the seven weekday plans are credited.
  for (const row of c2.rows.filter((r) => r.purpose === 'WEEKDAY_PLAN')) assert.equal(await store.ackPush(db, EUI, row.purpose, row.fport, row.weekday, 0, ackAt(1)), 1);
  const before = await db.all('SELECT * FROM valve_schedule_pushes ORDER BY rowid');
  const lateMonday = c1.rows.find((row) => row.weekday === 1);
  assert.equal(await store.ackPush(db, EUI, 'WEEKDAY_PLAN', lateMonday.fport, 1, 0, ackAt(2)), 0);
  assert.deepEqual(await db.all('SELECT * FROM valve_schedule_pushes ORDER BY rowid'), before);

  // A third edit: its snapshot waits out the debounce window. An ACK that arrives meanwhile was
  // sent for an earlier snapshot and must not mark the new, never-sent row ACKED.
  await store.updateSchedule(db, 'a', { start_time: '08:00' }, EUI);
  const c3 = await h.compile(300);
  assert.equal(await store.ackPush(db, EUI, 'WEEKDAY_PLAN', lateMonday.fport, 1, 0, ackAt(3)), 0);
  assert.equal((await statesById(db, [c3.rows.find((row) => row.weekday === 1).push_id]))[0].state, 'QUEUED');
  db.close();
});

for (const mode of MODES) test(`acceptance 9 [${mode}]: after K compiles the queue holds at most one snapshot plus one CLOCK_SYNC`, async () => {
  const { db } = await tempDb();
  workers._resetHousekeepingForTests();
  const h = harness(db, mode);
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

for (const mode of MODES) test(`acceptance 10 [${mode}]: five edits inside the debounce window produce one snapshot on the air`, async () => {
  const { db } = await tempDb();
  const h = harness(db, mode);
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

for (const mode of MODES) test(`snapshot [${mode}]: without a flush (an open still awaiting observation) older rows are still SUPERSEDED, and the new snapshot is appended behind them`, async () => {
  const { db } = await tempDb();
  const h = harness(db, mode);
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

for (const mode of MODES) test(`H1 (probe C) [${mode}]: a whole-queue cancel flush after the clears left marks them LOST at once, surfaced, and nothing re-sends them`, async () => {
  const { db } = await tempDb();
  await linkCloud(db);
  workers._resetHousekeepingForTests();
  const h = harness(db, mode);
  await store.insertSchedule(db, weekly('a', 0x3E, '06:00', 30));
  await h.compile(0);
  await h.emit(WINDOW_SEC);
  await store.softDeleteSchedule(db, 'a', EUI);
  const clears = await h.compile(100);
  await h.emit(100 + WINDOW_SEC); // the clears are on the air
  assert.equal(h.cs.getQueue().length, 8);
  await runningOpen(db, 'e-run');

  const out = await cancelActuation({ db, deviceEui: EUI, all: true, reason: 'operator', ...(mode === 'transport' ? { transport: h.cs.transport } : { flushQueue: h.cs.flushQueue }), now: at(200) });
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

for (const mode of MODES) test(`H1 [${mode}]: a snapshot still waiting out the debounce window is not in the radio queue, so a cancel flush leaves it pending and it is still sent`, async () => {
  const { db } = await tempDb();
  const h = harness(db, mode);
  await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
  const snap = await h.compile(0);
  await runningOpen(db, 'e-run');
  await cancelActuation({ db, deviceEui: EUI, all: true, reason: 'operator', ...(mode === 'transport' ? { transport: h.cs.transport } : { flushQueue: h.cs.flushQueue }), now: at(5) });
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

// --- W8 R3 review fixes, ported onto design C (CMD-04 PR0) on the transport path. R3-B1/M3: the
// "proven unsent" evidence of a row is persisted on it at its first invalidation and never
// overwritten, and an already-invalidated owner is not captured again by later flushes, so ACK
// correlation (B-2, first in first out) keeps working across many snapshots and every flush
// captures one snapshot of owners at most. dispatch stamps attempted_at from the runtime clock,
// so the ACK instants follow the real clock.
function ackAfterSend() {
  return new Date(Date.now() + 60 * 1000).toISOString();
}

async function flushIntents(db) {
  const row = await db.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', [EUI]);
  return (JSON.parse((row && row.conditional_control_json) || '{}').flushes || []);
}

// n edits, each snapshot emitted by the tick, no uplink in between.
async function snapshotTimes(db, h, scheduleUuid, n, startSec) {
  const results = [];
  for (let i = 0; i < n; i += 1) {
    const sec = (startSec || 0) + i * 100;
    await store.updateSchedule(db, scheduleUuid, { duration_minutes: 30 + i + Math.floor((startSec || 0) / 100) }, EUI);
    results.push(await h.compile(sec));
    await h.emit(sec + WINDOW_SEC);
  }
  return results;
}

for (const n of [3, 5]) {
  test(`R3-B1 [transport]: after ${n} emitted snapshots with no uplink, the newest Monday row is ACKED and nothing is ambiguous (GEN1)`, async () => {
    const { db } = await tempDb();
    const h = harness(db, 'transport');
    await store.insertSchedule(db, weekly('mon', 0x02, '06:00', 30));
    const results = await snapshotTimes(db, h, 'mon', n);
    const newest = results[n - 1].rows.find((r) => r.weekday === 1);
    assert.equal(await store.ackPush(db, EUI, 'WEEKDAY_PLAN', 15, 1, 0, ackAfterSend()), 1);
    assert.equal((await db.get('SELECT state FROM valve_schedule_pushes WHERE push_id=?', [newest.push_id])).state, 'ACKED');
    assert.deepEqual(await db.all("SELECT push_id FROM valve_schedule_pushes WHERE error='ack_ambiguous'"), []);
    // R3-M3: every flush captured one snapshot (8 owners) at most, never a growing history.
    assert.deepEqual((await flushIntents(db)).map((f) => (f.owners || []).length), [0, ...Array(n - 1).fill(8)]);
    db.close();
  });
}

test('R3-B1 [transport]: after 3 emitted snapshots with no uplink, the newest GEN2 group is ACKED and nothing is ambiguous', async () => {
  const { db } = await tempDb();
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN2' });
  const h = harness(db, 'transport');
  await store.insertSchedule(db, weekly('all', 0x7F, '06:00', 30));
  const results = await snapshotTimes(db, h, 'all', 3);
  const newest = results[2].rows.find((r) => r.purpose === 'DAYMASK_PLAN');
  assert.equal(await store.ackPush(db, EUI, 'DAYMASK_PLAN', 25, null, 1, ackAfterSend()), 1);
  assert.equal((await db.get('SELECT state FROM valve_schedule_pushes WHERE push_id=?', [newest.push_id])).state, 'ACKED');
  assert.deepEqual(await db.all("SELECT push_id FROM valve_schedule_pushes WHERE error='ack_ambiguous'"), []);
  db.close();
});

// R3-M1 on design C: a GEN2 pause (the scheduler-status route) and a later edit both carry the
// status first, so the queue ends with exactly one status item, DEACTIVATED, ahead of the plan.
test('R3-M1 [transport]: GEN2 pause then edit: the queue holds exactly one status, DEACTIVATED, first', async () => {
  const { db } = await tempDb();
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN2' });
  const h = harness(db, 'transport');
  await store.insertSchedule(db, weekly('mon', 0x02, '06:00', 30));
  await h.compile(0);
  await h.emit(WINDOW_SEC);
  await setSchedulerStatus({ db, deviceEui: EUI, appId: 'app', status: 'DEACTIVATED', now: at(100), transport: h.cs.transport, warn: () => {} });
  await store.updateSchedule(db, 'mon', { start_time: '07:00' }, EUI);
  await h.compile(110);
  await h.emit(110 + WINDOW_SEC);
  const status = h.cs.getQueue().filter((item) => item.fPort === 21).map((item) => item.hex);
  assert.deepEqual(status, ['32'], 'exactly one status item, DEACTIVATED');
  assert.equal(h.cs.getQueue()[0].fPort, 21, 'status first (R5 M1)');
  db.close();
});

// R3-M5 on design C: a compile whose flush RPC fails leaves no proof on the rows it invalidated;
// its snapshot is still written and appended. The next completed flushes capture everything
// again and stamp the real proof, so the ACK for the newest snapshot is credited, not ambiguous.
test('R3-M5 [transport]: a failed flush followed by two completed snapshots: the newest row is ACKED, nothing ambiguous (GEN1)', async () => {
  const { db } = await tempDb();
  const h = harness(db, 'transport');
  const realFlush = h.cs.transport.flushDeviceQueue;
  await store.insertSchedule(db, weekly('mon', 0x02, '06:00', 30));
  await snapshotTimes(db, h, 'mon', 1, 0); // A
  h.cs.transport.flushDeviceQueue = async () => { throw new Error('chirpstack unreachable'); };
  const b = await snapshotTimes(db, h, 'mon', 1, 1000); // B: the flush fails, B is appended behind A
  assert.equal(b[0].flushed, false);
  h.cs.transport.flushDeviceQueue = realFlush;
  const results = await snapshotTimes(db, h, 'mon', 2, 2000); // C, D
  const newest = results[1].rows.find((r) => r.weekday === 1);
  assert.equal(await store.ackPush(db, EUI, 'WEEKDAY_PLAN', 15, 1, 0, ackAfterSend()), 1);
  assert.equal((await db.get('SELECT state FROM valve_schedule_pushes WHERE push_id=?', [newest.push_id])).state, 'ACKED');
  assert.deepEqual(await db.all("SELECT push_id FROM valve_schedule_pushes WHERE error='ack_ambiguous'"), []);
  db.close();
});

// --- B-4 (W8 proposal, R11 probe 3): unsettled plan rows no longer fence opens, and the clock tick
// treats a FAILED (24 h sweep) or SUPERSEDED clock row as settled, never one inside the 24 h.
test('B-4 (probe 3) [transport]: two quick edits, then a manual open is reserved, not valve_busy', async () => {
  const dispatch = require('./dispatch');
  const { db } = await tempDb();
  const h = harness(db, 'transport');
  await store.insertSchedule(db, weekly('a', 0x01, '06:00', 30));
  await h.compile(0);
  await h.emit(WINDOW_SEC);
  await store.updateSchedule(db, 'a', { start_time: '07:00' }, EUI);
  await h.compile(100);
  await h.emit(100 + WINDOW_SEC);
  h.cs.drain(); // the valve takes the newest snapshot; nothing is acknowledged
  const unsettled = await db.all("SELECT 1 FROM valve_schedule_pushes WHERE state<>'ACKED'");
  assert.ok(unsettled.length >= 8, 'superseded and unacknowledged rows remain on record');
  const reservation = await dispatch.reserveValveCommand({ db, command: { device_eui: EUI, command_id: 'manual-after-edits', action: 'OPEN_FOR_DURATION', duration_minutes: 5, commanded_at: at(300).toISOString(), timezone: 'UTC' }, now: at(300).toISOString() });
  assert.equal(reservation.send, true);
  db.close();
});

test('B-4 clock gate [transport]: an unacknowledged clock sync blocks a new one for 24 h; once the sweep fails it, the next due tick sends a fresh one', async () => {
  const { db } = await tempDb();
  workers._resetHousekeepingForTests();
  const h = harness(db, 'transport');
  await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
  await h.tick(0);
  const clocks = () => db.all("SELECT state, error FROM valve_schedule_pushes WHERE purpose='CLOCK_SYNC' ORDER BY rowid");
  assert.equal((await clocks()).length, 1);
  await db.run("UPDATE valve_settings SET last_clock_sync_queued_at=NULL WHERE device_eui=?", [EUI]); // due again (e.g. a clock jump)
  await h.tick(3600);
  assert.equal((await clocks()).length, 1, 'inside 24 h the unacknowledged owner is kept, no new clock');
  await db.run("UPDATE valve_schedule_pushes SET queued_at='2026-08-17 09:00:00' WHERE purpose='CLOCK_SYNC'");
  await h.tick(7200); // the sweep fails the old clock row, then the tick may send a fresh one
  const after = await clocks();
  assert.deepEqual(after.map((r) => r.state), ['FAILED', 'QUEUED']);
  db.close();
});

// --- Step 4 (R11 probe 2): the scheduler-status routes never flush and send a lone status while a
// plan snapshot is outstanding. In fixed mode the status rides first in a full snapshot; in
// conditional mode it is appended with no flush.
for (const generation of ['GEN1', 'GEN2']) {
  test(`R11 probe 2 (${generation}) [transport]: delete, pause, resume inside one uplink -> the valve ends with the deleted schedule cleared and status ACTIVE`, async () => {
    const { db } = await tempDb();
    await store.upsertSettings(db, EUI, { strega_generation: generation });
    const h = harness(db, 'transport');
    await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
    await h.compile(0);
    await h.emit(WINDOW_SEC);
    const valve = applyToValve(null, h.cs.drain()); // the valve holds schedule a
    await store.softDeleteSchedule(db, 'a', EUI);
    await h.compile(100);
    await h.emit(100 + WINDOW_SEC); // the clears are on the air
    await setSchedulerStatus({ db, deviceEui: EUI, appId: 'app', status: 'DEACTIVATED', now: at(140), transport: h.cs.transport, warn: () => {} });
    await setSchedulerStatus({ db, deviceEui: EUI, appId: 'app', status: 'ACTIVE', now: at(145), transport: h.cs.transport, warn: () => {} });
    await h.emit(145 + WINDOW_SEC);
    applyToValve(valve, h.cs.drain());
    assert.deepEqual(valveView(valve, generation), await desiredValve(db, generation));
    for (let d = 0; d < 7; d += 1) {
      if (generation === 'GEN1') assert.equal(valve.gen1[d], EMPTY_GEN1, `weekday ${d} cleared`);
      else assert.equal(valve.gen2[d], '', `weekday ${d} cleared`);
    }
    assert.equal(valve.status, '0');
    db.close();
  });
}

test('R11 probe 2 [transport]: in conditional mode a pause is appended with no flush, so the conditional clear in flight stays queued', async () => {
  const { db } = await tempDb();
  const h = harness(db, 'transport');
  await store.writeConditionalControl(db, EUI, { mode: 'CONDITIONAL', desired_revision: 'rev-1', required_push_ids: [], readiness: { state: 'PENDING', revision: 'rev-1', reason: 'awaiting_clear_ack' } });
  await h.cs.transport.enqueueDownlink({ fPort: 14, data: Buffer.from(EMPTY_GEN1, 'hex').toString('base64') }); // a clear on the air
  const flushesBefore = h.cs.log.flushes;
  const out = await setSchedulerStatus({ db, deviceEui: EUI, appId: 'app', status: 'DEACTIVATED', now: at(10), transport: h.cs.transport, warn: () => {} });
  assert.equal(out.statusOnly, true);
  assert.equal(h.cs.log.flushes, flushesBefore, 'no flush');
  assert.deepEqual(h.cs.getQueue().map((item) => item.fPort), [14, 21], 'the clear stays, the status follows');
  assert.equal((await store.getSettings(db, EUI)).scheduler_status, 'DEACTIVATED');
  await assert.rejects(setSchedulerStatus({ db, deviceEui: EUI, appId: 'app', status: 'ACTIVE', now: at(20), transport: h.cs.transport, warn: () => {} }), (e) => e.code === 'conditional_readiness_pending');
  db.close();
});

// R13-M1/m2: in conditional mode the policy worker honours Pause (DEACTIVATED), so the status
// routes must let a paused conditional valve resume. ACTIVE is refused only while the conditional
// clear is not confirmed (the valve may still hold a resident plan); once READY it is appended
// (no flush). The status row and valve_settings are written in one transaction.
test('R13-M1 [transport]: a conditional valve with a READY clear can be paused and resumed; each status is appended, never flushed', async () => {
  const { db } = await tempDb();
  const h = harness(db, 'transport');
  await store.writeConditionalControl(db, EUI, { mode: 'CONDITIONAL', desired_revision: 'rev-1', required_push_ids: [], readiness: { state: 'READY', revision: 'rev-1', reason: 'all_current_clear_acked' } });
  const flushesBefore = h.cs.log.flushes;
  await setSchedulerStatus({ db, deviceEui: EUI, appId: 'app', status: 'DEACTIVATED', now: at(10), transport: h.cs.transport, warn: () => {} });
  assert.equal((await store.getSettings(db, EUI)).scheduler_status, 'DEACTIVATED');
  const resumed = await setSchedulerStatus({ db, deviceEui: EUI, appId: 'app', status: 'ACTIVE', now: at(20), transport: h.cs.transport, warn: () => {} });
  assert.equal(resumed.statusOnly, true);
  assert.equal((await store.getSettings(db, EUI)).scheduler_status, 'ACTIVE');
  assert.equal(h.cs.log.flushes, flushesBefore, 'no flush');
  assert.deepEqual(h.cs.getQueue().map((item) => item.hex), ['32', '30']);
  db.close();
});

test('R13-m2: the conditional status row and valve_settings commit together (a send failure leaves both written, nothing half-done)', async () => {
  const { db } = await tempDb();
  await store.writeConditionalControl(db, EUI, { mode: 'CONDITIONAL', desired_revision: 'rev-1', required_push_ids: [], readiness: { state: 'READY', revision: 'rev-1', reason: 'all_current_clear_acked' } });
  const failing = { async getDeviceQueue() { return []; }, async flushDeviceQueue() {}, async enqueueDownlink() { throw new Error('chirpstack down'); } };
  const out = await setSchedulerStatus({ db, deviceEui: EUI, appId: 'app', status: 'DEACTIVATED', now: at(10), transport: failing, warn: () => {} });
  assert.equal((await store.getSettings(db, EUI)).scheduler_status, 'DEACTIVATED');
  const row = await db.get("SELECT state FROM valve_schedule_pushes WHERE purpose='SCHEDULER_STATUS' ORDER BY rowid DESC LIMIT 1");
  assert.equal(row.state, 'QUEUED');
  assert.equal(out.transportResults[0].phase, 'UNKNOWN', 'the uncertain send is reported to the route');
  db.close();
});

// R13-M3 (probe F): a transport failure in the middle of a snapshot emission leaves the valve on a
// half-old plan. The rows that did not reach ACCEPTED are LOST at once (not_resent_q02c), the
// runtime is emitted, nothing is re-sent, and the 24 h sweep changes nothing more.
test('R13-M3 (probe F) [transport]: ChirpStack fails after 3 enqueues -> the rest of the snapshot is LOST at once and surfaced', async () => {
  const { db } = await tempDb();
  await linkCloud(db);
  workers._resetHousekeepingForTests();
  const h = harness(db, 'transport');
  await store.insertSchedule(db, weekly('a', 0x3E, '06:00', 30));
  const snap = await h.compile(0);
  const realEnqueue = h.cs.transport.enqueueDownlink;
  let calls = 0;
  h.cs.transport.enqueueDownlink = async (item) => { calls += 1; if (calls > 3) throw new Error('chirpstack restarted'); return realEnqueue(item); };
  const out = await h.emit(WINDOW_SEC);
  assert.equal(h.cs.getQueue().length, 3, 'status, Sunday and Monday reached the queue');
  assert.equal(out.transportFailures.length, 1);
  const states = await statesById(db, snap.rows.map((r) => r.push_id));
  assert.deepEqual(states.slice(0, 3).map((s) => s.state), ['QUEUED', 'QUEUED', 'QUEUED']);
  for (const s of states.slice(3)) assert.deepEqual({ state: s.state, error: s.error }, { state: 'FAILED', error: 'not_resent_q02c' });
  const summary = await store.pushSummary(db, EUI, at(WINDOW_SEC));
  assert.equal(summary.lost, 5, 'surfaced now, not after 24 h');
  const payload = JSON.parse((await db.get("SELECT payload_json FROM sync_outbox WHERE op='VALVE_RUNTIME_CHANGED' ORDER BY rowid DESC LIMIT 1")).payload_json);
  assert.equal(payload.push_state.lost, 5);
  h.cs.transport.enqueueDownlink = realEnqueue;
  const before = h.cs.log.enqueued.length;
  await h.tick(WINDOW_SEC + 60);
  await h.tick(WINDOW_SEC + 120);
  assert.equal(h.cs.log.enqueued.slice(before).filter((i) => i.fPort !== 12).length, 0, 'nothing is re-sent');
  db.close();
});

// R13-M4: leaving conditional mode while an open awaits observation used to answer 202 with
// nothing written and nothing sent (the fixed plan was stored but never programmed). Design C now
// handles it like any compile during a pending observation: the control becomes FIXED, the full
// snapshot is pending, the emitter holds it (no flush) until the open is observed or the 5-minute
// cap, then appends it behind the queue; the response names the open it waited for.
test('R13-M4 (probe C\') [transport]: a conversion back to fixed during an unobserved open is pending and visible, then sent, never silent', async () => {
  const { db } = await tempDb();
  const h = harness(db, 'transport');
  await store.writeConditionalControl(db, EUI, { mode: 'CONDITIONAL', generation: 'GEN1', desired_revision: 'rev-1', required_push_ids: [], readiness: { state: 'READY', revision: 'rev-1', reason: 'all_current_clear_acked' } });
  await db.run(
    "INSERT INTO valve_actuation_expectations(expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, created_at) VALUES ('e-open', ?, 'cmd-open', '2026-08-19T10:00:00Z', 600, '2026-08-19T10:10:00Z', 'unknown', 'PENDING_OBSERVATION', '2026-08-19T10:00:00Z')",
    [EUI]);
  await store.insertSchedule(db, weekly('fixed', 0x02, '06:00', 30));
  const r = await h.compile(10);
  assert.notEqual(r.blocked, true);
  assert.equal(r.conversion_waits_for, 'cmd-open');
  assert.equal(r.rows.length, 8, 'the full fixed snapshot is written');
  assert.equal((await store.conditionalControl(db, EUI)).mode, 'FIXED');
  assert.equal((await store.pushSummary(db, EUI, at(10))).queued, 7, 'the tile shows the plan as waiting, not silently nothing');
  assert.equal((await h.emit(10 + WINDOW_SEC)).messages.length, 0, 'held while the open is unobserved');
  await db.run("UPDATE valve_actuation_expectations SET reconciliation_state='OBSERVED_RUNNING' WHERE expectation_id='e-open'");
  await h.emit(10 + 2 * WINDOW_SEC);
  assert.deepEqual(h.cs.getQueue(), asItems(r.rows), 'sent once the open is observed');
  db.close();
});

// --- PR0 2758ca709 (review of d3b0efb85: T1, T2, T3), on the transport path. T1: the tick builds a
// ChirpStack client lazily, only when something is about to be sent, and closes it. T2: the
// first transport failure stops the snapshot (the rest LOST, untried) and leaves other valves'
// snapshots pending for the next tick; overlapping ticks are skipped. T3: a client that cannot
// be built is warned about once. On this branch STREGA writes never fall back to MQTT (the
// dispatch boundary): with no client the snapshots stay pending.
function clientFactory(cs, behaviour) {
  const stats = { created: 0, closed: 0, calls: 0 };
  const factory = () => {
    stats.created += 1;
    return {
      getDeviceQueue: (eui) => cs.transport.getDeviceQueue(eui),
      flushDeviceQueue: (eui) => cs.transport.flushDeviceQueue(eui),
      enqueueDownlink: async (item) => {
        stats.calls += 1;
        if (behaviour && behaviour.enqueue) return behaviour.enqueue(item, stats);
        return cs.transport.enqueueDownlink(item);
      },
      close: () => { stats.closed += 1; return []; },
    };
  };
  return { factory, stats };
}

function deferredPromise() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const OTHER_VALVE = EUI.slice(0, 15) + '3';
async function addValve(db, eui) {
  await db.run("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES (?,'Valve C','STREGA_VALVE',1,datetime('now'),datetime('now'))", [eui]);
}

test('PR0 T1 [transport]: the valve tick builds a ChirpStack client only when a snapshot is due, and closes it, also after a failure', async () => {
  const { db } = await tempDb();
  workers._resetHousekeepingForTests();
  const cs = fakeChirpStack();
  const { factory, stats } = clientFactory(cs);
  await workers.runValveTick({ db, now: at(0), appId: 'app', warn: () => {}, transportFactory: factory });
  assert.equal(stats.created, 0, 'nothing pending: no client');
  await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
  await store.upsertSettings(db, EUI, { last_clock_sync_queued_at: at(0).toISOString() }); // no clock due here
  await compileAndQueue({ db, deviceEui: EUI, appId: 'app', now: at(10), transport: cs.transport, warn: () => {} });
  await workers.runValveTick({ db, now: at(20), appId: 'app', warn: () => {}, transportFactory: factory });
  assert.equal(stats.created, 0, 'pending but inside the debounce window: no client');
  await workers.runValveTick({ db, now: at(10 + WINDOW_SEC), appId: 'app', warn: () => {}, transportFactory: factory });
  assert.deepEqual({ created: stats.created, closed: stats.closed, calls: stats.calls }, { created: 1, closed: 1, calls: 8 });

  const failing = clientFactory(cs, { enqueue: async () => { throw new Error('unavailable'); } });
  await store.updateSchedule(db, 'a', { start_time: '07:00' }, EUI);
  await compileAndQueue({ db, deviceEui: EUI, appId: 'app', now: at(200), transport: cs.transport, warn: () => {} });
  await workers.runValveTick({ db, now: at(200 + WINDOW_SEC), appId: 'app', warn: () => {}, transportFactory: failing.factory });
  assert.deepEqual({ created: failing.stats.created, closed: failing.stats.closed, calls: failing.stats.calls }, { created: 1, closed: 1, calls: 1 }, 'one attempt, closed after the failure too');
  db.close();
});

test('PR0 T2 [transport]: the first transport failure stops the snapshot (the rest LOST, untried); other valves wait for the next tick', async () => {
  const { db } = await tempDb();
  await addValve(db, OTHER_VALVE);
  const cs = fakeChirpStack();
  await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
  await store.insertSchedule(db, Object.assign(weekly('b', 0x04, '07:00', 30), { device_eui: OTHER_VALVE }));
  const s1 = await compileAndQueue({ db, deviceEui: EUI, appId: 'app', now: at(0), transport: cs.transport, warn: () => {} });
  const s2 = await compileAndQueue({ db, deviceEui: OTHER_VALVE, appId: 'app', now: at(0), transport: cs.transport, warn: () => {} });
  let calls = 0;
  const down = Object.assign({}, cs.transport, { enqueueDownlink: async () => { calls += 1; throw new Error('DEADLINE_EXCEEDED'); } });
  const out = await emitPendingSnapshots({ db, now: at(WINDOW_SEC), appId: 'app', warn: () => {}, transport: down });
  assert.equal(calls, 1, 'one attempt, not one per row and per valve');
  assert.equal(out.transportDown, true);
  const failed = (await db.all("SELECT device_eui FROM valve_schedule_pushes WHERE state='FAILED' GROUP BY device_eui")).map((r) => r.device_eui);
  assert.equal(failed.length, 1, 'only the valve whose snapshot was attempted has LOST rows');
  const attempted = failed[0] === EUI ? s1 : s2;
  const waiting = failed[0] === EUI ? s2 : s1;
  const waitingEui = failed[0] === EUI ? OTHER_VALVE : EUI;
  const lostRows = await statesById(db, attempted.rows.map((r) => r.push_id));
  for (const r of lostRows) assert.deepEqual({ state: r.state, error: r.error }, { state: 'FAILED', error: 'not_resent_q02c' });
  const untried = await db.all('SELECT transport_json FROM valve_schedule_pushes WHERE push_id IN (' + attempted.rows.slice(1).map(() => '?').join(',') + ')', attempted.rows.slice(1).map((r) => r.push_id));
  assert.ok(untried.every((r) => !r.transport_json || !JSON.parse(r.transport_json).phase), 'the rows after the failure were never tried');
  assert.ok(await store.getSnapshotPending(db, waitingEui), 'the other snapshot is still pending, never emitted');
  const ok = await emitPendingSnapshots({ db, now: at(WINDOW_SEC + 60), appId: 'app', warn: () => {}, transport: cs.transport });
  assert.equal(ok.emitted, 1);
  assert.equal(cs.getQueue().length, waiting.rows.length);
  db.close();
});

test('PR0 T2 [transport]: a hanging transport stalls one tick; an overlapping tick skips, so no duplicate clock or decommission send', async () => {
  const { db } = await tempDb();
  workers._resetHousekeepingForTests();
  const cs = fakeChirpStack();
  await addValve(db, OTHER_VALVE);
  await store.insertPushes(db, [{ push_id: 'acked-other', device_eui: OTHER_VALVE, purpose: 'WEEKDAY_PLAN', weekday: 2, fport: 16, payload_hex: '00'.repeat(24), plan_hash: 'a-real-plan' }]);
  await db.run("UPDATE valve_schedule_pushes SET state='ACKED' WHERE push_id='acked-other'");
  await db.run('UPDATE devices SET deleted_at=? WHERE deveui=?', [new Date(Date.now() - 2000).toISOString(), OTHER_VALVE]);
  await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
  const snap = await compileAndQueue({ db, deviceEui: EUI, appId: 'app', now: at(0), transport: cs.transport, warn: () => {} });
  const hang = deferredPromise();
  let hung = 0;
  const { factory } = clientFactory(cs, { enqueue: async (item) => { if (hung === 0) { hung += 1; return hang.promise; } return cs.transport.enqueueDownlink(item); } });
  const tick1 = workers.runValveTick({ db, now: at(WINDOW_SEC), appId: 'app', warn: () => {}, transportFactory: factory });
  for (let i = 0; i < 20; i += 1) await new Promise((res) => setImmediate(res));
  const tick2 = await workers.runValveTick({ db, now: at(WINDOW_SEC + 60), appId: 'app', warn: () => {}, transportFactory: factory });
  assert.equal(tick2.skipped, true, 'the overlapping tick skips while one is running');
  hang.reject(new Error('DEADLINE_EXCEEDED'));
  const r1 = await tick1;
  assert.equal(r1.skipped, false);
  assert.deepEqual([...new Set((await statesById(db, snap.rows.map((r) => r.push_id))).map((s) => s.state))], ['FAILED']);
  const tick3 = await workers.runValveTick({ db, now: at(WINDOW_SEC + 120), appId: 'app', warn: () => {}, transportFactory: factory });
  assert.equal(tick3.skipped, false, 'the next tick runs again');
  assert.equal((await db.all("SELECT 1 FROM valve_schedule_pushes WHERE purpose='CLOCK_SYNC'")).length, 1, 'one clock sync');
  assert.equal((await db.all("SELECT 1 FROM valve_schedule_pushes WHERE device_eui=? AND purpose='SCHEDULER_STATUS' AND payload_hex='32'", [OTHER_VALVE])).length, 1, 'one decommission send');
  db.close();
});

test('PR0 T3 [transport]: a ChirpStack client that cannot be built is warned about once; STREGA snapshots stay pending (no MQTT fallback on this branch)', async () => {
  const { db } = await tempDb();
  workers._resetHousekeepingForTests();
  push._resetTransportWarningsForTests();
  const cs = fakeChirpStack();
  await store.insertSchedule(db, weekly('a', 0x02, '06:00', 30));
  await store.upsertSettings(db, EUI, { last_clock_sync_queued_at: at(0).toISOString() });
  const warnings = [];
  const broken = () => { throw new Error('CHIRPSTACK_API_URL is not set'); };
  const snap = await compileAndQueue({ db, deviceEui: EUI, appId: 'app', now: at(0), transport: cs.transport, warn: () => {} });
  for (let i = 1; i <= 3; i += 1) {
    const r = await workers.runValveTick({ db, now: at(i * 100), appId: 'app', warn: (m) => warnings.push(m), transportFactory: broken });
    assert.deepEqual(r.messages, [], 'no MQTT downlink');
  }
  assert.equal(warnings.filter((w) => /client unavailable/.test(w)).length, 1);
  assert.ok(await store.getSnapshotPending(db, EUI), 'still pending, sent once a client can be built');
  assert.deepEqual([...new Set((await statesById(db, snap.rows.map((r) => r.push_id))).map((s) => s.state))], ['QUEUED']);
  db.close();
});
