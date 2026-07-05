import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  fillMissingRainDays,
  localDayIso,
  localTzOffsetMinutes,
  summarizeRainDays,
  summarizeRainIntervals,
  type RainDay,
} from '../rain';

describe('addDaysIso', () => {
  it('adds days across month boundaries', () => {
    expect(addDaysIso('2026-06-30', 1)).toBe('2026-07-01');
  });

  it('subtracts days across year boundaries', () => {
    expect(addDaysIso('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('localDayIso / localTzOffsetMinutes', () => {
  it('formats a local date as YYYY-MM-DD', () => {
    expect(localDayIso(new Date(2026, 6, 4, 12, 0, 0))).toBe('2026-07-04');
  });

  it('is the negation of getTimezoneOffset', () => {
    const now = new Date();
    expect(localTzOffsetMinutes(now)).toBe(-now.getTimezoneOffset());
  });
});

describe('fillMissingRainDays', () => {
  const rows: RainDay[] = [
    { day: '2026-07-02', total_mm: 3.4, samples: 12 },
    { day: '2026-07-04', total_mm: 1.2, samples: 6 },
  ];

  it('zero-fills a full window ending at lastDay, in ascending order', () => {
    const filled = fillMissingRainDays(rows, 4, '2026-07-04');
    expect(filled.map((entry) => entry.day)).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
    ]);
    expect(filled[0]).toEqual({ day: '2026-07-01', total_mm: 0, samples: 0 });
    expect(filled[1]).toEqual(rows[0]);
    expect(filled[3]).toEqual(rows[1]);
  });

  it('drops rows outside the window', () => {
    const filled = fillMissingRainDays(rows, 2, '2026-07-04');
    expect(filled.map((entry) => entry.day)).toEqual(['2026-07-03', '2026-07-04']);
    expect(filled[0].total_mm).toBe(0);
    expect(filled[1].total_mm).toBe(1.2);
  });
});

describe('summarizeRainDays', () => {
  it('sums totals, counts rainy days, and finds the wettest day', () => {
    const summary = summarizeRainDays([
      { day: '2026-07-01', total_mm: 0, samples: 10 },
      { day: '2026-07-02', total_mm: 3.4, samples: 12 },
      { day: '2026-07-03', total_mm: 1.2, samples: 6 },
    ]);
    expect(summary.totalMm).toBeCloseTo(4.6);
    expect(summary.rainyDays).toBe(2);
    expect(summary.wettestDay?.day).toBe('2026-07-02');
  });

  it('returns the zero/null shape for empty input', () => {
    expect(summarizeRainDays([])).toEqual({ totalMm: 0, rainyDays: 0, wettestDay: null });
  });

  it('excludes samples === 0 (no-data) days from totals, rainy-day count, and wettest day', () => {
    // A day with samples === 0 is a filled/zero-fill placeholder for a gap
    // (station offline, no valid uplinks) — it must NOT be treated as a
    // measured-dry day, unlike a day with samples > 0 and total_mm === 0
    // (station reported, genuinely no rain).
    const summary = summarizeRainDays([
      { day: '2026-07-01', total_mm: 0, samples: 0 }, // no data — excluded entirely
      { day: '2026-07-02', total_mm: 0, samples: 8 }, // measured dry — counted, not rainy
      { day: '2026-07-03', total_mm: 2.1, samples: 9 }, // measured wet
    ]);
    expect(summary.totalMm).toBeCloseTo(2.1);
    expect(summary.rainyDays).toBe(1);
    expect(summary.wettestDay?.day).toBe('2026-07-03');
  });
});

describe('summarizeRainIntervals', () => {
  it('ignores null values and computes total, peak, and wet-interval count', () => {
    const summary = summarizeRainIntervals([
      { t: '2026-07-04T08:00:00Z', value: 0.5 },
      { t: '2026-07-04T08:10:00Z', value: null },
      { t: '2026-07-04T08:20:00Z', value: 0 },
      { t: '2026-07-04T08:30:00Z', value: 1.5 },
    ]);
    expect(summary.totalMm).toBeCloseTo(2.0);
    expect(summary.peakMm).toBeCloseTo(1.5);
    expect(summary.wetIntervals).toBe(2);
  });

  it('returns null peak for empty input', () => {
    expect(summarizeRainIntervals([])).toEqual({ totalMm: 0, peakMm: null, wetIntervals: 0 });
  });
});
