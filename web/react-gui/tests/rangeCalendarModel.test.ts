import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDayClick,
  applyDayDoubleClick,
  isInRange,
  monthGridDays,
  shiftMonth,
} from '../src/components/farming/rangeCalendarModel';

test('monthGridDays returns leading/trailing days and flags', () => {
  const days = monthGridDays(2026, 5, '2026-05-15');
  assert.equal(days.length % 7, 0);

  const may1 = days.find((day) => day.date === '2026-05-01');
  assert.ok(may1 && may1.inMonth);

  const future = days.find((day) => day.date === '2026-05-20');
  assert.ok(future && future.isFuture, 'days after today are future');
});

test('single click sets start, second click sets end in sorted order', () => {
  let state = { from: null as string | null, to: null as string | null };

  state = applyDayClick(state, '2026-05-11');
  assert.deepEqual(state, { from: '2026-05-11', to: null });

  state = applyDayClick(state, '2026-05-07');
  assert.deepEqual(state, { from: '2026-05-07', to: '2026-05-11' });

  state = applyDayClick(state, '2026-05-20');
  assert.deepEqual(state, { from: '2026-05-20', to: null });
});

test('double click selects a single day', () => {
  assert.deepEqual(
    applyDayDoubleClick({ from: '2026-05-01', to: '2026-05-09' }, '2026-05-15'),
    { from: '2026-05-15', to: '2026-05-15' }
  );
});

test('isInRange and shiftMonth handle boundaries', () => {
  assert.ok(isInRange('2026-05-09', '2026-05-07', '2026-05-11'));
  assert.ok(!isInRange('2026-05-12', '2026-05-07', '2026-05-11'));
  assert.deepEqual(shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
  assert.deepEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
});
