import { describe, expect, it } from 'vitest';
import { clampCalendarMonthOffset, isFutureCalendarDate } from '../calendarMonth';

const NOW_MS = Date.UTC(2026, 6, 11, 12); // 2026-07-11T12:00Z

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
