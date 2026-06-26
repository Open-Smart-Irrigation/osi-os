import { describe, expect, it } from 'vitest';

import {
  applyDayClick,
  applyDayDoubleClick,
  isInRange,
  monthGridDays,
  shiftMonth,
} from '../rangeCalendarModel';

describe('rangeCalendarModel', () => {
  it('monthGridDays returns leading/trailing days and flags', () => {
    const days = monthGridDays(2026, 5, '2026-05-15');
    expect(days.length % 7).toBe(0);

    const may1 = days.find((day) => day.date === '2026-05-01');
    expect(may1).toBeDefined();
    expect(may1?.inMonth).toBe(true);

    const future = days.find((day) => day.date === '2026-05-20');
    expect(future).toBeDefined();
    expect(future?.isFuture).toBe(true);
  });

  it('single click sets start, second click sets end in sorted order', () => {
    let state = { from: null as string | null, to: null as string | null };

    state = applyDayClick(state, '2026-05-11');
    expect(state).toEqual({ from: '2026-05-11', to: null });

    state = applyDayClick(state, '2026-05-07');
    expect(state).toEqual({ from: '2026-05-07', to: '2026-05-11' });

    state = applyDayClick(state, '2026-05-20');
    expect(state).toEqual({ from: '2026-05-20', to: null });
  });

  it('double click selects a single day', () => {
    expect(
      applyDayDoubleClick({ from: '2026-05-01', to: '2026-05-09' }, '2026-05-15'),
    ).toEqual({ from: '2026-05-15', to: '2026-05-15' });
  });

  it('isInRange and shiftMonth handle boundaries', () => {
    expect(isInRange('2026-05-09', '2026-05-07', '2026-05-11')).toBe(true);
    expect(isInRange('2026-05-12', '2026-05-07', '2026-05-11')).toBe(false);
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
  });
});
