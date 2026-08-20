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
