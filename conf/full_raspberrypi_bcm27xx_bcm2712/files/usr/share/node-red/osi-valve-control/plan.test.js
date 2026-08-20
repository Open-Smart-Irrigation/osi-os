'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./plan');

const hex = (b) => Buffer.from(b).toString('hex').toUpperCase();

test('GEN1 day encoding matches vendor example (Sun 08:30-08:45, 23:05-00:10)', () => {
  const buf = P.encodeGen1Day([{ onH: 8, onM: 30, offH: 8, offM: 45 }, { onH: 23, onM: 5, offH: 0, offM: 10 }]);
  assert.equal(hex(buf), 'FF8830FF0845FFA305FF0010' + 'FF'.repeat(12));
  assert.equal(buf.length, 24);
});

test('GEN1 empty day is all FF', () => {
  assert.equal(hex(P.encodeGen1Day([])), 'FF'.repeat(24));
});

test('GEN2 all days 19:15-19:30 + 19:45-20:01 matches vendor example', () => {
  assert.equal(hex(P.encodeGen2(0x80, [{ onH: 19, onM: 15, offH: 19, offM: 30 }, { onH: 19, onM: 45, offH: 20, offM: 1 }])), '809915193099452001');
});

test('GEN2 Tue+Sat 06:05-10:05 matches vendor example', () => {
  assert.equal(hex(P.encodeGen2((1 << 2) | (1 << 6), [{ onH: 6, onM: 5, offH: 10, offM: 5 }])), '4486051005');
});

test('compileWindows: duration wraps past midnight and stays on start weekday', () => {
  const r = P.compileWindows([{ schedule_uuid: 'a', kind: 'WEEKLY', enabled: 1, weekdays_mask: 1, start_time: '23:05', duration_minutes: 65 }]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.days[0].length, 1);
  assert.deepEqual({ onH: r.days[0][0].onH, onM: r.days[0][0].onM, offH: r.days[0][0].offH, offM: r.days[0][0].offM }, { onH: 23, onM: 5, offH: 0, offM: 10 });
  assert.equal(r.days[1].length, 0);
});

test('compileWindows: more than 4 windows on a weekday is an error naming the weekday', () => {
  const s = (i) => ({ schedule_uuid: 's' + i, kind: 'WEEKLY', enabled: 1, weekdays_mask: 2, start_time: `0${i}:00`, duration_minutes: 10 });
  const r = P.compileWindows([1, 2, 3, 4, 5].map(s));
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].code, 'too_many_windows');
  assert.equal(r.errors[0].weekday, 1);
});

test('compileWindows: overlapping windows on a weekday is an error listing both uuids', () => {
  const r = P.compileWindows([
    { schedule_uuid: 'a', kind: 'WEEKLY', enabled: 1, weekdays_mask: 4, start_time: '06:00', duration_minutes: 90 },
    { schedule_uuid: 'b', kind: 'WEEKLY', enabled: 1, weekdays_mask: 4, start_time: '07:00', duration_minutes: 30 },
  ]);
  assert.equal(r.errors[0].code, 'overlap');
  assert.deepEqual(r.errors[0].conflicts.sort(), ['a', 'b']);
});

test('compileWindows ignores disabled and ONCE schedules', () => {
  const r = P.compileWindows([
    { schedule_uuid: 'a', kind: 'WEEKLY', enabled: 0, weekdays_mask: 127, start_time: '06:00', duration_minutes: 30 },
    { schedule_uuid: 'b', kind: 'ONCE', enabled: 1, fire_at: '2026-08-22T20:00:00Z', duration_minutes: 30 },
  ]);
  assert.deepEqual(r.days.map((d) => d.length), [0, 0, 0, 0, 0, 0, 0]);
});

test('gen2Groups merges identical weekdays and uses 0x80 for all-days', () => {
  const w = [{ onH: 6, onM: 0, offH: 6, offM: 30 }];
  const all = P.gen2Groups([w, w, w, w, w, w, w]);
  assert.deepEqual(all.map((g) => g.daymask), [0x80]);
  // Empty weekdays form their own group on purpose (spec §5.1 step 3: cleared days get an explicit empty push).
  const some = P.gen2Groups([[], w, [], [], [], [], w]);
  // Ascending-sorted actual masks compared against an ascending-sorted expected literal
  // (the brief's original literal was written in descending order, inconsistent with the
  // a-b comparator; fixed here per task-2-report.md).
  assert.deepEqual(some.map((g) => g.daymask).sort((a, b) => a - b), [0x3D, (1 << 1) | (1 << 6)]);
});

test('planHash is order-independent for equal windows and differs for different windows', () => {
  const a = [{ onH: 6, onM: 0, offH: 6, offM: 30 }, { onH: 7, onM: 0, offH: 7, offM: 30 }];
  const b = [a[1], a[0]];
  assert.equal(P.planHash(a), P.planHash(b));
  assert.notEqual(P.planHash(a), P.planHash([a[0]]));
});

test('gen1ClockPayload: 2026-08-20 01:03:44 Thu in Europe/Zurich -> 14 digits HHMMSSddDDMMYY', () => {
  // 2026-08-19T23:03:44Z == 2026-08-20 01:03:44 CEST (Thursday)
  const buf = P.gen1ClockPayload(new Date('2026-08-19T23:03:44Z'), 'Europe/Zurich');
  assert.equal(hex(buf), '0001000304040004020000080206');
});

test('localParts handles DST boundary (Europe/Zurich 2026-10-25)', () => {
  const before = P.localParts(new Date('2026-10-25T00:30:00Z'), 'Europe/Zurich'); // 02:30 CEST
  const after = P.localParts(new Date('2026-10-25T01:30:00Z'), 'Europe/Zurich');  // 02:30 CET
  assert.equal(before.hour, 2); assert.equal(after.hour, 2);
  assert.equal(P.isDstTransitionWithin('Europe/Zurich', Date.parse('2026-10-24T12:00:00Z'), Date.parse('2026-10-25T12:00:00Z')), true);
  assert.equal(P.isDstTransitionWithin('Europe/Zurich', Date.parse('2026-08-01T12:00:00Z'), Date.parse('2026-08-02T12:00:00Z')), false);
});

test('nextRun picks the earliest upcoming WEEKLY or ONCE occurrence', () => {
  const now = new Date('2026-08-19T10:00:00Z'); // Wed 12:00 CEST
  const r = P.nextRun([
    { schedule_uuid: 'w', kind: 'WEEKLY', enabled: 1, weekdays_mask: 1 << 3, start_time: '13:00', duration_minutes: 30, timezone: 'Europe/Zurich' },
    { schedule_uuid: 'o', kind: 'ONCE', enabled: 1, once_state: 'PENDING', fire_at: '2026-08-19T12:30:00Z', duration_minutes: 15, timezone: 'Europe/Zurich' },
  ], now, 'Europe/Zurich');
  assert.equal(r.kind, 'WEEKLY'); // 13:00 CEST == 11:00Z, before the ONCE at 12:30Z
  assert.equal(r.at, '2026-08-19T11:00:00.000Z');
  assert.equal(r.minutes, 30);
});

test('validateScheduleInput: WEEKLY and ONCE happy paths and rejections', () => {
  assert.equal(P.validateScheduleInput({ kind: 'WEEKLY', weekdays_mask: 3, start_time: '06:00', duration_minutes: 45 }).ok, true);
  assert.equal(P.validateScheduleInput({ kind: 'ONCE', fire_at: '2026-08-22T20:00:00Z', duration_minutes: 90 }).ok, true);
  assert.equal(P.validateScheduleInput({ kind: 'WEEKLY', weekdays_mask: 0, start_time: '06:00', duration_minutes: 45 }).ok, false);
  assert.equal(P.validateScheduleInput({ kind: 'WEEKLY', weekdays_mask: 1, start_time: '24:00', duration_minutes: 45 }).ok, false);
  assert.equal(P.validateScheduleInput({ kind: 'ONCE', fire_at: '2026-08-22T20:00:00Z', duration_minutes: 300 }).ok, false);
  assert.equal(P.validateScheduleInput({ kind: 'DAILY' }).ok, false);
});
