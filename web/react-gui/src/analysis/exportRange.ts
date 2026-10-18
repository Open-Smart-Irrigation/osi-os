import type { HistoryExportGranularity } from '../services/api';

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

// The calendar date (YYYY-MM-DD) of an instant in the given IANA time zone, or
// in the browser's own zone when none is given or it is unknown. The all-zones
// export takes days, not instants: a UTC date would ask a gateway whose zones
// are behind UTC for "tomorrow" every evening, which the gateway refuses.
export function exportCalendarDate(value: string | null | undefined, timezone?: string | null): string | null {
  const ms = Date.parse(value ?? '');
  if (!Number.isFinite(ms)) return null;
  const instant = new Date(ms);
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(instant);
      const part = (type: string) => parts.find((entry) => entry.type === type)?.value;
      const year = part('year');
      const month = part('month');
      const day = part('day');
      if (year && month && day) return `${year.padStart(4, '0')}-${month}-${day}`;
    } catch {
      // An unknown time zone name falls through to the browser's calendar.
    }
  }
  return `${pad(instant.getFullYear(), 4)}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}`;
}

export function exportRangeFor(
  range: { from?: string | null; to?: string | null; timezone?: string | null } | null | undefined,
): { from: string; to: string } | null {
  const from = exportCalendarDate(range?.from, range?.timezone);
  const to = exportCalendarDate(range?.to, range?.timezone);
  return from && to ? { from, to } : null;
}

export function exportGranularity(applied: string | undefined): HistoryExportGranularity {
  return applied === 'raw' || applied === 'hourly' || applied === 'daily' ? applied : 'daily';
}
