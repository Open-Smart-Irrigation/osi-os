import type { CSSProperties, SVGProps } from 'react';

/**
 * Shared axis styling for the fullscreen history charts so every view follows the
 * same data-visualization conventions: a visible time x-axis, a data-fitted y-axis
 * (not forced to zero), muted gridline-coloured ticks, and a rotated unit title.
 */

// `top: 20` keeps the top y-axis tick clear of the in-chart view-mode/device labels.
// `bottom: 28` keeps x-axis ticks above mobile browser chrome and home indicators.
export const HISTORY_CHART_MARGIN = { top: 20, right: 16, bottom: 28, left: 8 } as const;

const DAY_MS = 86_400_000;
const AXIS_TICK: SVGProps<SVGTextElement> = { fontSize: 11, fill: 'var(--text-tertiary)' };
const X_AXIS_TICK: SVGProps<SVGTextElement> = { fontSize: 10, fill: 'var(--text-tertiary)' };
const AXIS_STROKE = 'var(--border)';
const DATE_RANGE_SEPARATOR = ' – ';

export function timeTickTier(spanMs: number): 'intraday' | 'days' | 'weeks' | 'months' {
  if (Number.isNaN(spanMs) || spanMs <= 0) return 'intraday';
  if (!Number.isFinite(spanMs)) return 'months';
  if (spanMs < DAY_MS) return 'intraday';
  if (spanMs < 7 * DAY_MS) return 'days';
  if (spanMs < 90 * DAY_MS) return 'weeks';
  return 'months';
}

function datePart(ms: number, type: Intl.DateTimeFormatPartTypes): string {
  const parts = new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
  }).formatToParts(new Date(ms));
  return parts.find((part) => part.type === type)?.value ?? '';
}

function yearPart(ms: number, year: '2-digit' | 'numeric'): string {
  const parts = new Intl.DateTimeFormat(undefined, {
    year,
  }).formatToParts(new Date(ms));
  return parts.find((part) => part.type === 'year')?.value ?? '';
}

function dayMonthLabel(ms: number, includeYear = false): string {
  const day = datePart(ms, 'day');
  const month = datePart(ms, 'month');
  const year = includeYear ? yearPart(ms, 'numeric') : '';
  return [day, month, year].filter(Boolean).join(' ');
}

function monthYearLabel(ms: number): string {
  const month = datePart(ms, 'month');
  const year = yearPart(ms, '2-digit');
  return [month, year].filter(Boolean).join(' ');
}

function yearLabel(ms: number): string {
  return yearPart(ms, 'numeric');
}

function sameCalendarDay(leftMs: number, rightMs: number): boolean {
  const left = new Date(leftMs);
  const right = new Date(rightMs);
  return (
    left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
  );
}

export function formatTimeTick(ms: number, spanMs: number): string {
  if (!Number.isFinite(ms)) return '-';

  switch (timeTickTier(spanMs)) {
    case 'intraday':
      return new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(ms));
    case 'days':
      return new Intl.DateTimeFormat(undefined, {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(ms));
    case 'weeks':
      return dayMonthLabel(ms);
    case 'months':
      return monthYearLabel(ms);
  }
}

export function formatWindowCaption(fromMs: number, toMs: number): string {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return '-';

  const sameYear = yearLabel(fromMs) === yearLabel(toMs);
  switch (timeTickTier(toMs - fromMs)) {
    case 'intraday':
      return dayMonthLabel(fromMs);
    case 'days':
    case 'weeks':
      if (sameCalendarDay(fromMs, toMs)) return dayMonthLabel(fromMs, !sameYear);
      return [
        dayMonthLabel(fromMs, !sameYear),
        dayMonthLabel(toMs, !sameYear),
      ].join(DATE_RANGE_SEPARATOR);
    case 'months':
      return [
        monthYearLabel(fromMs),
        monthYearLabel(toMs),
      ].join(DATE_RANGE_SEPARATOR);
  }
}

/** Returns the shared unit when every series uses the same one, otherwise undefined. */
export function consistentUnit(series: ReadonlyArray<{ unit?: string | null }>): string | undefined {
  const units = new Set(series.map((entry) => (entry.unit ?? '').trim()).filter(Boolean));
  return units.size === 1 ? [...units][0] : undefined;
}

/** Spread onto a numeric, time-scaled XAxis. Charts add their own `domain` + `tickFormatter`. */
export const historyTimeXAxis = {
  dataKey: 'tMs' as const,
  type: 'number' as const,
  scale: 'time' as const,
  allowDataOverflow: true,
  height: 18,
  minTickGap: 36,
  tickMargin: 4,
  tick: X_AXIS_TICK,
  stroke: AXIS_STROKE,
  tickLine: { stroke: AXIS_STROKE },
  axisLine: { stroke: AXIS_STROKE },
};

/** Spread onto a YAxis. `unit` adds a rotated, centred axis title; omit for mixed-unit charts. */
export function historyValueYAxis(unit?: string, width = 48) {
  return {
    width,
    domain: ['auto', 'auto'] as [string, string],
    tickCount: 5,
    tickMargin: 4,
    tick: AXIS_TICK,
    stroke: AXIS_STROKE,
    tickLine: { stroke: AXIS_STROKE },
    axisLine: { stroke: AXIS_STROKE },
    label: unit
      ? {
          value: unit,
          angle: -90 as const,
          position: 'insideLeft' as const,
          style: { textAnchor: 'middle', fontSize: 11, fill: 'var(--text-tertiary)' } as CSSProperties,
        }
      : undefined,
  };
}
