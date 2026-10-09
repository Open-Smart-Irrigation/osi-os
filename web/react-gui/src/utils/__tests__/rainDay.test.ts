import { describe, expect, it } from 'vitest';
import { farmDateKey, msUntilNextFarmMidnight, rainTodayState } from '../rainDay';

const zurich = 'Europe/Zurich';

describe('rainTodayState', () => {
  it('is today when the sample day is the farm date', () => {
    const now = Date.parse('2026-10-09T07:00:00Z'); // 09:00 in Zurich
    expect(rainTodayState({ rainMmToday: 2.5, rainDay: '2026-10-09', timezone: zurich, nowMs: now }))
      .toEqual({ kind: 'today', value: 2.5, day: '2026-10-09' });
  });
  it('a previous day is never today (finding 10: 8 mm at 23:50, silent next morning)', () => {
    const now = Date.parse('2026-10-09T06:00:00Z');
    expect(rainTodayState({ rainMmToday: 8, rainDay: '2026-10-08', timezone: zurich, nowMs: now }))
      .toEqual({ kind: 'previous', value: 8, day: '2026-10-08' });
  });
  it('uses the farm zone, not the browser: 22:30Z is already tomorrow in Zurich', () => {
    const now = Date.parse('2026-07-01T22:30:00Z');
    expect(farmDateKey(now, zurich)).toBe('2026-07-02');
    expect(rainTodayState({ rainMmToday: 1, rainDay: '2026-07-01', timezone: zurich, nowMs: now }).kind).toBe('previous');
  });
  it('missing data is unavailable', () => {
    expect(rainTodayState({ rainMmToday: null, rainDay: '2026-10-09', timezone: zurich, nowMs: Date.now() }).kind).toBe('unavailable');
    expect(rainTodayState({ rainMmToday: 3, rainDay: null, timezone: zurich, nowMs: Date.now() }).kind).toBe('unavailable');
  });
  it('next farm midnight on the 25-hour day', () => {
    const now = Date.parse('2026-10-25T21:00:00Z'); // 22:00 CET
    expect(msUntilNextFarmMidnight(zurich, now)).toBe(2 * 3600000);
  });
});

describe('msUntilNextFarmMidnight precision', () => {
  it('is exact to the millisecond, also off a whole second and on the 23-hour day', () => {
    // 2026-03-28T22:00:00.500Z is 23:00:00.5 CET; the farm date changes at 23:00Z (00:00 CET, 03-29).
    expect(msUntilNextFarmMidnight(zurich, Date.parse('2026-03-28T22:00:00.500Z'))).toBe(3_599_500);
    // 2026-03-29 has 23 hours: from 00:00 CET (23:00Z) to the next midnight (22:00Z, 00:00 CEST).
    expect(msUntilNextFarmMidnight(zurich, Date.parse('2026-03-28T23:00:00Z'))).toBe(23 * 3600000);
  });
});
