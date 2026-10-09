// Pure helpers for the rain history views (RainMonitor).
// RainHistory mirrors the version 2 payload of
// GET /api/devices/:deveui/rain-history: the gateway decides the farm's days
// from the device's zone timezone, so the browser never re-buckets them.

export type RainTimezoneBasis =
  | 'zone'
  | 'weather_station_zone'
  | 'unassigned_default'
  | 'abbreviation'
  | 'invalid';

export type RainDayQuality = 'received_only' | 'complete' | 'partial' | 'unknown';

export interface RainHistoryDay {
  day: string; // 'YYYY-MM-DD' farm calendar day, as bucketed by the gateway
  period_start: string | null;
  period_end: string | null;
  total_mm: number | null; // null = no data that day, never a dry day
  samples: number;
  quality: RainDayQuality;
  so_far: boolean; // the current day, ending at the request time
}

export interface RainHistory {
  timezone: string | null; // null only for an older gateway's array payload
  timezoneBasis: RainTimezoneBasis | null;
  periodStart: string | null;
  periodEnd: string | null;
  days: RainHistoryDay[];
}

export interface RainIntervalPoint {
  t: string;
  value: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const TIMEZONE_BASES: readonly RainTimezoneBasis[] = [
  'zone',
  'weather_station_zone',
  'unassigned_default',
  'abbreviation',
  'invalid',
];
const QUALITIES: readonly RainDayQuality[] = ['received_only', 'complete', 'partial', 'unknown'];

export function addDaysIso(day: string, delta: number): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(ms + delta * DAY_MS).toISOString().slice(0, 10);
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function parseDay(row: unknown): RainHistoryDay | null {
  if (typeof row !== 'object' || row === null) return null;
  const record = row as Record<string, unknown>;
  const day = String(record.day ?? '');
  if (!DAY_KEY.test(day)) return null;
  const rawTotal = record.total_mm;
  if (rawTotal !== null && rawTotal !== undefined && (typeof rawTotal !== 'number' || !Number.isFinite(rawTotal))) {
    return null;
  }
  const samples = Number(record.samples);
  const quality = record.quality === undefined
    ? 'received_only'
    : (QUALITIES as readonly unknown[]).includes(record.quality) ? (record.quality as RainDayQuality) : 'unknown';
  return {
    day,
    period_start: textOrNull(record.period_start),
    period_end: textOrNull(record.period_end),
    total_mm: typeof rawTotal === 'number' ? rawTotal : null,
    samples: Number.isFinite(samples) && samples > 0 ? Math.round(samples) : 0,
    quality,
    so_far: record.so_far === true,
  };
}

// Validates the gateway payload. An array is the pre-version-2 shape of an
// older gateway (days with samples only, no timezone): it is read as
// received-only days without a timezone. Anything else is an error.
export function parseRainHistory(payload: unknown): RainHistory {
  if (Array.isArray(payload)) {
    return {
      timezone: null,
      timezoneBasis: null,
      periodStart: null,
      periodEnd: null,
      days: payload.map(parseDay).filter((entry): entry is RainHistoryDay => entry !== null),
    };
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Unexpected rain history response');
  }
  const record = payload as Record<string, unknown>;
  if (record.version !== 2 || !Array.isArray(record.days)) {
    throw new Error('Unexpected rain history response');
  }
  const basis = (TIMEZONE_BASES as readonly unknown[]).includes(record.timezone_basis)
    ? (record.timezone_basis as RainTimezoneBasis)
    : null;
  return {
    timezone: textOrNull(record.timezone),
    timezoneBasis: basis,
    periodStart: textOrNull(record.period_start),
    periodEnd: textOrNull(record.period_end),
    days: record.days.map(parseDay).filter((entry): entry is RainHistoryDay => entry !== null),
  };
}

// True when a day carries a received amount (not a no-data day).
export function hasRainData(entry: RainHistoryDay): entry is RainHistoryDay & { total_mm: number } {
  return entry.samples > 0 && entry.total_mm !== null && Number.isFinite(entry.total_mm);
}

export interface RainDailySummary {
  totalMm: number;
  rainyDays: number;
  wettestDay: RainHistoryDay | null;
}

// A day with samples === 0 or total_mm === null is a no-data day (the gauge
// reported no valid uplink that day), NOT a measured-dry day: ingest writes
// rain_mm_delta = 0.0 on every valid dry uplink, so a real dry day has
// samples > 0 and total 0. No-data days are excluded from the total, the
// rainy-day count, and wettest-day selection.
export function summarizeRainDays(days: RainHistoryDay[]): RainDailySummary {
  let totalMm = 0;
  let rainyDays = 0;
  let wettestDay: (RainHistoryDay & { total_mm: number }) | null = null;
  for (const entry of days) {
    if (!hasRainData(entry)) continue;
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
