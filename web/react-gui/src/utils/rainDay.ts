// Farm-day helpers for rain "today" tiles. The server dates the latest rain value in the farm
// timezone (`rain_day`, `rain_day_timezone`); these helpers compare it with the farm's current
// date, never the browser's. Same names and semantics as the gateway GUI's `utils/rainDay.ts`.

export type RainTodayKind = 'today' | 'previous' | 'unavailable';
export interface RainTodayState { kind: RainTodayKind; value: number | null; day: string | null }

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  const key = timezone || 'UTC';
  let f = formatterCache.get(key);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-CA', { timeZone: key, year: 'numeric', month: '2-digit', day: '2-digit' }); }
    catch { f = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }); }
    formatterCache.set(key, f);
  }
  return f;
}

export function farmDateKey(nowMs: number, timezone: string): string {
  const parts = Object.fromEntries(formatter(timezone).formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function rainTodayState(input: { rainMmToday: number | null | undefined; rainDay: string | null | undefined; timezone: string | null | undefined; nowMs: number }): RainTodayState {
  const value = typeof input.rainMmToday === 'number' && Number.isFinite(input.rainMmToday) ? input.rainMmToday : null;
  const day = input.rainDay && /^\d{4}-\d{2}-\d{2}$/.test(input.rainDay) ? input.rainDay : null;
  if (value === null || day === null) return { kind: 'unavailable', value: null, day };
  return { kind: day === farmDateKey(input.nowMs, input.timezone || 'UTC') ? 'today' : 'previous', value, day };
}

// Milliseconds from nowMs to the next change of farm date (exact on 23/25-hour days).
// Bisects to the millisecond: `hi` ends on the first instant of the next farm day.
export function msUntilNextFarmMidnight(timezone: string, nowMs: number): number {
  const today = farmDateKey(nowMs, timezone);
  let lo = nowMs;
  let hi = nowMs + 26 * 3600000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (farmDateKey(mid, timezone) === today) lo = mid; else hi = mid;
  }
  return hi - nowMs;
}
