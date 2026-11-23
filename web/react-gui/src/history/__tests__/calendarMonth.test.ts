import { describe, expect, it } from 'vitest';
import { calendarMonthForRange, calendarMonthRange, clampCalendarMonthOffset, isFutureCalendarDate } from '../calendarMonth';

const NOW_MS = Date.UTC(2026, 6, 11, 12); // 2026-07-11T12:00Z

describe('requested calendar month', () => {
  it.each([
    ['Europe/Zurich', 2026, 11, '2026-10-31T23:00:00.000Z', '2026-11-30T22:59:59.999Z'],
    ['Europe/Zurich', 2026, 3, '2026-02-28T23:00:00.000Z', '2026-03-31T21:59:59.999Z'],
    ['Europe/Zurich', 2026, 10, '2026-09-30T22:00:00.000Z', '2026-10-31T22:59:59.999Z'],
    ['Pacific/Kiritimati', 2026, 12, '2026-11-30T10:00:00.000Z', '2026-12-31T09:59:59.999Z'],
    ['America/New_York', 2024, 2, '2024-02-01T05:00:00.000Z', '2024-03-01T04:59:59.999Z'],
  ])('bounds %s %i-%i in local time', (timezone, year, month, from, to) => {
    expect(calendarMonthRange({ year, month }, timezone)).toEqual({ label: 'custom', timezone, from, to });
  });

  it('selects the month at the farm rather than UTC and handles year rollover', () => {
    const range = { label: '24h' as const, from: null, to: '2026-11-30T23:30:00.000Z', timezone: 'Europe/Zurich' };
    expect(calendarMonthForRange(range, 0)).toEqual({ year: 2026, month: 12 });
    expect(calendarMonthForRange(range, 1)).toEqual({ year: 2027, month: 1 });
  });

  it('clamps navigation using the farm current month at the UTC boundary', () => {
    const now = Date.parse('2026-11-30T23:30:00Z');
    expect(clampCalendarMonthOffset('2026-11-15T12:00:00Z', 0, 1, now, 'Europe/Zurich')).toBe(1);
    expect(clampCalendarMonthOffset('2026-11-15T12:00:00Z', 1, 1, now, 'Europe/Zurich')).toBe(1);
  });
});

describe('isFutureCalendarDate', () => {
  it('flags dates after today', () => {
    expect(isFutureCalendarDate('2026-07-12', '2026-07-11')).toBe(true);
  });
  it('keeps today and the past', () => {
    expect(isFutureCalendarDate('2026-07-11', '2026-07-11')).toBe(false);
    expect(isFutureCalendarDate('2026-06-30', '2026-07-11')).toBe(false);
  });
});

describe('clampCalendarMonthOffset', () => {
  const base = '2026-07-11T09:00:00.000Z';
  it('blocks swiping into a future month', () => {
    expect(clampCalendarMonthOffset(base, 0, 1, NOW_MS)).toBe(0);
  });
  it('allows returning to the current month from the past', () => {
    expect(clampCalendarMonthOffset(base, -1, 1, NOW_MS)).toBe(0);
  });
  it('always allows going further into the past', () => {
    expect(clampCalendarMonthOffset(base, -1, -1, NOW_MS)).toBe(-2);
  });
  it('clamps when the viewport base is already a past month', () => {
    expect(clampCalendarMonthOffset('2026-05-20T00:00:00.000Z', 2, 1, NOW_MS)).toBe(2);
  });
});
