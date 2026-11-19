import type { HistoryCalendar, HistoryRangeSelection } from './types';
import { farmDateKey } from '../utils/rainDay';

export interface CalendarMonth { year: number; month: number }

export function calendarMonthForRange(range: HistoryRangeSelection, offset = 0, nowMs = Date.now()): CalendarMonth {
  const parsed = Date.parse(range.to ?? range.from ?? '');
  const date = farmDateKey(Number.isFinite(parsed) ? parsed : nowMs, range.timezone || 'UTC');
  const shifted = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1 + offset, 1));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
}

function monthStartMs(month: CalendarMonth, timezone: string): number {
  const nominal = Date.UTC(month.year, month.month - 1, 1);
  const date = new Date(nominal).toISOString().slice(0, 10);
  // Find the first instant of the farm date, including zones with a midnight DST jump.
  let lo = nominal - 36 * 3600000;
  let hi = nominal + 36 * 3600000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (farmDateKey(mid, timezone) < date) lo = mid;
    else hi = mid;
  }
  return hi;
}

export function calendarMonthRange(month: CalendarMonth, timezone: string): HistoryRangeSelection {
  const next = new Date(Date.UTC(month.year, month.month, 1));
  return {
    label: 'custom',
    timezone,
    from: new Date(monthStartMs(month, timezone)).toISOString(),
    to: new Date(monthStartMs({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 }, timezone) - 1).toISOString(),
  };
}

export function latestCalendarMonth(calendar: HistoryCalendar | null | undefined): { year: number; month: number } | null {
  const days = Array.isArray(calendar?.days) ? calendar.days : [];
  let latest: { date: string; year: number; month: number } | null = null;
  for (const day of days) {
    const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(day.date);
    if (!match) continue;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) continue;
    if (!latest || day.date > latest.date) latest = { date: day.date, year, month };
  }
  return latest ? { year: latest.year, month: latest.month } : null;
}

export function isFutureCalendarDate(date: string, todayIsoDate: string): boolean {
  return date > todayIsoDate;
}

export function clampCalendarMonthOffset(
  baseIso: string | null | undefined,
  currentOffset: number,
  delta: -1 | 1,
  nowMs: number = Date.now(),
  timezone = 'UTC',
): number {
  const next = currentOffset + delta;
  const target = calendarMonthForRange({ label: 'custom', from: null, to: baseIso ?? null, timezone }, next, nowMs);
  const current = calendarMonthForRange({ label: 'custom', from: null, to: null, timezone }, 0, nowMs);
  return target.year * 12 + target.month > current.year * 12 + current.month ? currentOffset : next;
}

export function formatHistoryCalendarMonthLabel(calendar: HistoryCalendar | null | undefined, requestedMonth?: CalendarMonth, locale?: string): string | null {
  const month = requestedMonth ?? latestCalendarMonth(calendar);
  if (!month) return null;
  const monthDate = new Date(Date.UTC(month.year, month.month - 1, 15, 12));
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(monthDate);
}
