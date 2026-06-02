import type { CSSProperties } from 'react';

/**
 * Shared axis styling for the fullscreen history charts so every view follows the
 * same data-visualization conventions: a visible time x-axis, a data-fitted y-axis
 * (not forced to zero), muted gridline-coloured ticks, and a rotated unit title.
 */

// `top: 20` keeps the top y-axis tick clear of the in-chart view-mode/device labels.
export const HISTORY_CHART_MARGIN = { top: 20, right: 16, bottom: 6, left: 8 } as const;

const AXIS_TICK: CSSProperties = { fontSize: 11, fill: 'var(--text-tertiary)' };
const AXIS_STROKE = 'var(--border)';

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
  height: 26,
  minTickGap: 48,
  tickMargin: 6,
  tick: AXIS_TICK,
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
