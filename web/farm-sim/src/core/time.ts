export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const SOIL_STEP_MS = 10 * MINUTE_MS;

export const FARM_SITE = Object.freeze({
  latDeg: -2, lonDeg: 0, elevationM: 1_200, timezone: 'Etc/GMT-3',
});
const OFFSET_MS = 3 * HOUR_MS;

export function localDayStart(at: number): number {
  return Math.floor((at + OFFSET_MS) / DAY_MS) * DAY_MS - OFFSET_MS;
}

export function nextLocalMidnight(at: number): number {
  return localDayStart(at) + DAY_MS;
}

export function localDate(at: number): string {
  return new Date(at + OFFSET_MS).toISOString().slice(0, 10);
}

export function localDateStart(date: string): number {
  const utc = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(utc) || localDate(utc - OFFSET_MS) !== date) {
    throw new RangeError('Expected a local date in YYYY-MM-DD format');
  }
  return utc - OFFSET_MS;
}

export function localHour(at: number): number {
  return (at - localDayStart(at)) / HOUR_MS;
}

export function localMonth(at: number): number {
  return new Date(at + OFFSET_MS).getUTCMonth() + 1;
}

export function dayOfYear(at: number): number {
  const year = new Date(at + OFFSET_MS).getUTCFullYear();
  return Math.floor((at + OFFSET_MS - Date.UTC(year, 0, 1)) / DAY_MS) + 1;
}

export function seasonAt(at: number): 'Long Rains' | 'Cool Dry' | 'Short Rains' | 'Hot Dry' {
  const month = localMonth(at);
  if (month <= 2) return 'Hot Dry';
  if (month <= 5) return 'Long Rains';
  if (month <= 9) return 'Cool Dry';
  return 'Short Rains';
}

export const WEATHER_START = localDateStart('2026-10-11');
export const SLICE_START = localDateStart('2027-01-11') + 6.5 * HOUR_MS;
export const SLICE_END = SLICE_START + 14 * DAY_MS;
export const WELL_REFILL_HOUR = 5;
export const SUNRISE_HOUR = 6;
export const SUNSET_HOUR = 18;

export function nextSoilGridAt(at: number): number {
  const midnight = localDayStart(at);
  return midnight + (Math.floor((at - midnight) / SOIL_STEP_MS) + 1) * SOIL_STEP_MS;
}

export function sleepUntil(at: number): number | null {
  return localHour(at) >= 18 ? nextLocalMidnight(at) + 5 * HOUR_MS + 50 * MINUTE_MS : null;
}

/** Integral of a daylight sine, normalised to one over the local day. */
export function daylightFraction(dayStart: number, from: number, to: number): number {
  const phase = (at: number) => Math.min(1, Math.max(0,
    ((at - dayStart) / HOUR_MS - SUNRISE_HOUR) / (SUNSET_HOUR - SUNRISE_HOUR)));
  return (Math.cos(Math.PI * phase(from)) - Math.cos(Math.PI * phase(to))) / 2;
}
