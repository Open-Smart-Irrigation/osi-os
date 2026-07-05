// Pure helpers for the S2120 rain history views (RainMonitor).
// RainDay mirrors the edge payload of GET /api/devices/:deveui/rain-history.

export interface RainDay {
  day: string; // 'YYYY-MM-DD' local calendar day (as bucketed by the edge)
  total_mm: number;
  samples: number;
}

export interface RainIntervalPoint {
  t: string;
  value: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Minutes to ADD to UTC to get local wall time (JS getTimezoneOffset is inverted).
export function localTzOffsetMinutes(date: Date = new Date()): number {
  return -date.getTimezoneOffset();
}

export function localDayIso(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addDaysIso(day: string, delta: number): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(ms + delta * DAY_MS).toISOString().slice(0, 10);
}

// Produce exactly windowDays entries ending at lastDay, ascending, with
// zero-total placeholders for days the endpoint returned no row.
// Rows outside the window are dropped defensively.
export function fillMissingRainDays(days: RainDay[], windowDays: number, lastDay: string): RainDay[] {
  const byDay = new Map(days.map((entry) => [entry.day, entry]));
  const filled: RainDay[] = [];
  for (let back = windowDays - 1; back >= 0; back -= 1) {
    const day = addDaysIso(lastDay, -back);
    filled.push(byDay.get(day) ?? { day, total_mm: 0, samples: 0 });
  }
  return filled;
}

export interface RainDailySummary {
  totalMm: number;
  rainyDays: number;
  wettestDay: RainDay | null;
}

// A day with samples === 0 is a "no data" placeholder (zero-filled gap: the
// station reported no valid uplink that day), NOT a measured-dry day — ingest
// writes rain_mm_delta = 0.0 on every valid dry uplink, so a real dry day has
// samples > 0. Do not invent history values: no-data days are excluded from
// the total, the rainy-day count, and wettest-day selection.
export function summarizeRainDays(days: RainDay[]): RainDailySummary {
  let totalMm = 0;
  let rainyDays = 0;
  let wettestDay: RainDay | null = null;
  for (const entry of days) {
    if (entry.samples === 0) continue;
    if (!Number.isFinite(entry.total_mm)) continue;
    totalMm += entry.total_mm;
    if (entry.total_mm > 0) {
      rainyDays += 1;
      if (!wettestDay || entry.total_mm > wettestDay.total_mm) {
        wettestDay = entry;
      }
    }
  }
  return { totalMm, rainyDays, wettestDay };
}

export interface RainIntervalSummary {
  totalMm: number;
  peakMm: number | null;
  wetIntervals: number;
}

export function summarizeRainIntervals(points: RainIntervalPoint[]): RainIntervalSummary {
  let totalMm = 0;
  let peakMm: number | null = null;
  let wetIntervals = 0;
  for (const point of points) {
    const value = point.value;
    if (value == null || !Number.isFinite(value)) continue;
    totalMm += value;
    if (peakMm === null || value > peakMm) peakMm = value;
    if (value > 0) wetIntervals += 1;
  }
  return { totalMm, peakMm, wetIntervals };
}
