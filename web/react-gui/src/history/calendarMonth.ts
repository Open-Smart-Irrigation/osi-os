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
