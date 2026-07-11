import type { HistoryCalendar } from './types';

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
): number {
  const next = currentOffset + delta;
  const baseMs = baseIso ? Date.parse(baseIso) : NaN;
  const base = Number.isFinite(baseMs) ? new Date(baseMs) : new Date(nowMs);
  const targetMonthStartMs = Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + next, 1);
  const now = new Date(nowMs);
  const currentMonthStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return targetMonthStartMs > currentMonthStartMs ? currentOffset : next;
}

export function formatHistoryCalendarMonthLabel(calendar: HistoryCalendar | null | undefined): string | null {
  const month = latestCalendarMonth(calendar);
  if (!calendar || !month) return null;
  const timezone = calendar.timezone || 'UTC';
  const monthDate = new Date(Date.UTC(month.year, month.month - 1, 15, 12));
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: timezone,
  }).format(monthDate);
}
