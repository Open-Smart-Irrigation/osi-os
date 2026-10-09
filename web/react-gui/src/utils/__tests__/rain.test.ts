import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  parseRainHistory,
  summarizeRainDays,
  summarizeRainIntervals,
  type RainHistoryDay,
} from '../rain';

function day(dayKey: string, totalMm: number | null, samples: number, soFar = false): RainHistoryDay {
  return {
    day: dayKey,
    period_start: null,
    period_end: null,
    total_mm: totalMm,
    samples,
    quality: 'received_only',
    so_far: soFar,
  };
}

describe('addDaysIso', () => {
  it('adds days across month boundaries', () => {
    expect(addDaysIso('2026-06-30', 1)).toBe('2026-07-01');
  });

  it('subtracts days across year boundaries', () => {
    expect(addDaysIso('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('parseRainHistory', () => {
  it('reads the version 2 payload of the gateway', () => {
    const history = parseRainHistory({
      version: 2,
      deveui: 'A840410000000001',
      timezone: 'Europe/Zurich',
      timezone_basis: 'zone',
      period_start: '2026-10-24T22:00:00.000Z',
      period_end: '2026-10-26T12:00:00.000Z',
      days: [
        {
          day: '2026-10-25',
          period_start: '2026-10-24T22:00:00.000Z',
          period_end: '2026-10-25T23:00:00.000Z',
          total_mm: 1.5,
          samples: 3,
          quality: 'received_only',
          so_far: false,
        },
        {
          day: '2026-10-26',
          period_start: '2026-10-25T23:00:00.000Z',
          period_end: '2026-10-26T12:00:00.000Z',
          total_mm: null,
          samples: 0,
          quality: 'received_only',
          so_far: true,
        },
      ],
    });
    expect(history.timezone).toBe('Europe/Zurich');
    expect(history.timezoneBasis).toBe('zone');
    expect(history.periodStart).toBe('2026-10-24T22:00:00.000Z');
    expect(history.periodEnd).toBe('2026-10-26T12:00:00.000Z');
    expect(history.days).toEqual([
      {
        day: '2026-10-25',
        period_start: '2026-10-24T22:00:00.000Z',
        period_end: '2026-10-25T23:00:00.000Z',
        total_mm: 1.5,
        samples: 3,
        quality: 'received_only',
        so_far: false,
      },
      {
        day: '2026-10-26',
        period_start: '2026-10-25T23:00:00.000Z',
        period_end: '2026-10-26T12:00:00.000Z',
        total_mm: null,
        samples: 0,
        quality: 'received_only',
        so_far: true,
      },
    ]);
  });

  it('drops malformed days and keeps a null total as null, never zero', () => {
    const history = parseRainHistory({
      version: 2,
      timezone: 'CET',
      timezone_basis: 'abbreviation',
      days: [
        { day: '26-10-2026', total_mm: 1, samples: 1 },
        { day: '2026-10-26', total_mm: 'wet', samples: 1 },
        { day: '2026-10-27', total_mm: null, samples: 0 },
      ],
    });
    expect(history.timezoneBasis).toBe('abbreviation');
    expect(history.days.map((entry) => [entry.day, entry.total_mm, entry.samples])).toEqual([
      ['2026-10-27', null, 0],
    ]);
  });

  it('maps the old array payload of an older gateway to received-only days without a timezone', () => {
    const history = parseRainHistory([
      { day: '2026-07-01', total_mm: 1.6, samples: 2 },
      { day: 'bad', total_mm: 1, samples: 1 },
    ]);
    expect(history.timezone).toBeNull();
    expect(history.timezoneBasis).toBeNull();
    expect(history.days).toEqual([
      {
        day: '2026-07-01',
        period_start: null,
        period_end: null,
        total_mm: 1.6,
        samples: 2,
        quality: 'received_only',
        so_far: false,
      },
    ]);
  });

  it('rejects a payload of another version', () => {
    expect(() => parseRainHistory({ version: 3, days: [] })).toThrow();
    expect(() => parseRainHistory(null)).toThrow();
  });
});

describe('summarizeRainDays', () => {
  it('sums totals, counts rainy days, and finds the wettest day', () => {
    const summary = summarizeRainDays([
      day('2026-07-01', 0, 10),
      day('2026-07-02', 3.4, 12),
      day('2026-07-03', 1.2, 6),
    ]);
    expect(summary.totalMm).toBeCloseTo(4.6);
    expect(summary.rainyDays).toBe(2);
    expect(summary.wettestDay?.day).toBe('2026-07-02');
  });

  it('returns the zero/null shape for empty input', () => {
    expect(summarizeRainDays([])).toEqual({ totalMm: 0, rainyDays: 0, wettestDay: null });
  });

  it('excludes no-data days (samples 0 or total_mm null) from totals, rainy-day count, and wettest day', () => {
    const summary = summarizeRainDays([
      day('2026-07-01', null, 0), // no data
      day('2026-07-02', 5, 0), // inconsistent row without samples: still no data
      day('2026-07-03', null, 4), // inconsistent row without a total: no data
      day('2026-07-04', 0, 8), // measured dry: counted, not rainy
      day('2026-07-05', 2.1, 9), // measured wet
    ]);
    expect(summary.totalMm).toBeCloseTo(2.1);
    expect(summary.rainyDays).toBe(1);
    expect(summary.wettestDay?.day).toBe('2026-07-05');
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
