import { describe, expect, it } from 'vitest';
import { exportCalendarDate, exportGranularity, exportRangeFor } from '../exportRange';

describe('export range for the all-zones CSV', () => {
  it('takes the calendar date in the range time zone, not the UTC date', () => {
    // 22:00 on 7 June in New York is already 8 June in UTC: sending the UTC
    // date would ask a gateway whose zones are behind UTC for "tomorrow".
    expect(exportCalendarDate('2026-06-08T02:00:00Z', 'America/New_York')).toBe('2026-06-07');
    expect(exportCalendarDate('2026-06-07T22:30:00Z', 'Europe/Zurich')).toBe('2026-06-08');
    expect(exportCalendarDate('2026-06-07T23:59:59Z', 'UTC')).toBe('2026-06-07');
  });

  it('falls back to the browser calendar date without a usable time zone', () => {
    const value = '2026-06-07T12:00:00Z';
    const local = new Date(value);
    const expected = [
      String(local.getFullYear()).padStart(4, '0'),
      String(local.getMonth() + 1).padStart(2, '0'),
      String(local.getDate()).padStart(2, '0'),
    ].join('-');
    expect(exportCalendarDate(value)).toBe(expected);
    expect(exportCalendarDate(value, 'Not/AZone')).toBe(expected);
  });

  it('gives no range for a missing or unreadable bound', () => {
    expect(exportCalendarDate(undefined)).toBeNull();
    expect(exportCalendarDate('not a date', 'UTC')).toBeNull();
    expect(exportRangeFor({ from: '2026-06-01T00:00:00Z', to: '', timezone: 'UTC' })).toBeNull();
    expect(exportRangeFor(undefined)).toBeNull();
    expect(exportRangeFor({ from: '2026-06-01T00:00:00Z', to: '2026-06-07T23:59:59Z', timezone: 'UTC' }))
      .toEqual({ from: '2026-06-01', to: '2026-06-07' });
  });

  it('maps the applied aggregation onto an export granularity', () => {
    expect(exportGranularity('raw')).toBe('raw');
    expect(exportGranularity('hourly')).toBe('hourly');
    expect(exportGranularity('daily')).toBe('daily');
    expect(exportGranularity('15m')).toBe('daily');
    expect(exportGranularity(undefined)).toBe('daily');
  });
});
