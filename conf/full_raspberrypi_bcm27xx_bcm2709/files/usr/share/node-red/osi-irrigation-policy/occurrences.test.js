'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { occurrencesBetween, resolveLocalDateTime, decisionWindow, missedAuditBounds } = require('./occurrences');

const schedule = (overrides = {}) => ({
  schedule_uuid: 'schedule-1', device_eui: 'A840410000000001', kind: 'WEEKLY',
  start_time: '02:30', weekdays_mask: 1 << 0, duration_minutes: 20,
  timezone: 'Europe/Zurich', enabled: 1, deleted_at: null,
  effective_from: '2026-01-01T00:00:00Z', ...overrides,
});

test('strict local resolver skips a nonexistent spring-forward wall time', () => {
  assert.equal(resolveLocalDateTime('2026-03-29', '02:30', 'Europe/Zurich'), null);
});

test('strict local resolver chooses the first fall-back fold', () => {
  assert.equal(resolveLocalDateTime('2026-10-25', '02:30', 'Europe/Zurich').toISOString(), '2026-10-25T00:30:00.000Z');
});

test('weekly occurrences have stable local identity and dueAt across a range', () => {
  const rows = occurrencesBetween(schedule({ weekdays_mask: (1 << 0) | (1 << 1) }),
    '2026-10-24T00:00:00Z', '2026-10-27T00:00:00Z');
  assert.deepEqual(rows.map((row) => [row.local_date, row.local_time, row.dueAt]), [
    ['2026-10-25', '02:30', '2026-10-25T00:30:00.000Z'],
    ['2026-10-26', '02:30', '2026-10-26T01:30:00.000Z'],
  ]);
  const revised = occurrencesBetween(schedule({ schedule_uuid: 'revision-2', start_time: '02:30' }),
    '2026-10-25T00:00:00Z', '2026-10-25T02:00:00Z');
  assert.equal(revised[0].local_date, '2026-10-25');
  assert.equal(revised[0].local_time, '02:30');
});

test('effective_from excludes earlier occurrences and disabled/deleted schedules are empty', () => {
  assert.deepEqual(occurrencesBetween(schedule({ weekdays_mask: 1 << 1, effective_from: '2026-10-26T00:00:00Z' }),
    '2026-10-24T00:00:00Z', '2026-10-27T00:00:00Z').map((row) => row.local_date), ['2026-10-26']);
  assert.deepEqual(occurrencesBetween(schedule({ enabled: 0 }), '2026-10-24T00:00:00Z', '2026-10-27T00:00:00Z'), []);
  assert.deepEqual(occurrencesBetween(schedule({ deleted_at: '2026-01-02T00:00:00Z' }), '2026-10-24T00:00:00Z', '2026-10-27T00:00:00Z'), []);
});

test('effective_from is strictly future and excludes equality', () => {
  assert.deepEqual(occurrencesBetween(schedule({ weekdays_mask: 1 << 0, effective_from: '2026-10-25T00:30:00.000Z' }),
    '2026-10-25T00:00:00Z', '2026-10-25T02:00:00Z'), []);
});

test('decision grace is inclusive and missed audit is bounded to the last trusted tick and 24 hours', () => {
  const due = '2026-10-25T00:30:00.000Z';
  assert.deepEqual(decisionWindow(due, '2026-10-25T00:40:00.000Z'), { eligible: true, reason: null });
  assert.deepEqual(decisionWindow(due, '2026-10-25T00:40:00.001Z'), { eligible: false, reason: 'missed_start' });
  assert.deepEqual(missedAuditBounds('2026-10-24T23:00:00.000Z', '2026-10-26T12:00:00.000Z'), {
    from: '2026-10-25T12:00:00.000Z', to: '2026-10-26T12:00:00.000Z',
  });
  assert.equal(missedAuditBounds(null, '2026-10-26T12:00:00.000Z'), null);
});
