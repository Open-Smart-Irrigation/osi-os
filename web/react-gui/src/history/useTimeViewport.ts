import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultAggregationForRange } from './rangeModel';
import type { HistoryAggregationLevel, HistoryRangeLabel, HistoryRangeSelection } from './types';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MIN_VIEWPORT_MS = HOUR_MS;
const MAX_VIEWPORT_MS = 366 * DAY_MS;
const PAN_FRACTION = 0.25;

const RANGE_DURATIONS_MS: Record<HistoryRangeLabel, number> = {
  '12h': 12 * HOUR_MS,
  '24h': 24 * HOUR_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
  season: 180 * DAY_MS,
  custom: 24 * HOUR_MS,
};

export interface HistoryTimeViewport {
  range: HistoryRangeSelection & { mode: 'relative' | 'absolute' };
  aggregation: HistoryAggregationLevel;
}

function clampDuration(durationMs: number): number {
  return Math.min(Math.max(durationMs, MIN_VIEWPORT_MS), MAX_VIEWPORT_MS);
}

function timezoneForBrowser(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function parseViewportRange(viewport: HistoryTimeViewport): { fromMs: number; toMs: number; durationMs: number } | null {
  const fromMs = viewport.range.from ? Date.parse(viewport.range.from) : NaN;
  const toMs = viewport.range.to ? Date.parse(viewport.range.to) : NaN;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
  return { fromMs, toMs, durationMs: toMs - fromMs };
}

function clampRangeToCurrentBoundary(fromMs: number, durationMs: number): { fromMs: number; toMs: number } {
  const nowMs = Date.now();
  const toMs = fromMs + durationMs;
  if (Number.isFinite(nowMs) && toMs > nowMs) {
    return { fromMs: nowMs - durationMs, toMs: nowMs };
  }
  return { fromMs, toMs };
}

function customViewport(
  viewport: HistoryTimeViewport,
  fromMs: number,
  durationMs: number,
): HistoryTimeViewport {
  const range = clampRangeToCurrentBoundary(fromMs, durationMs);

  return {
    range: {
      mode: 'absolute',
      label: 'custom',
      from: new Date(range.fromMs).toISOString(),
      to: new Date(range.toMs).toISOString(),
      timezone: viewport.range.timezone,
    },
    aggregation: 'auto',
  };
}

export function createDefaultTimeViewport(
  rangeLabel: HistoryRangeLabel,
  now = new Date(),
  timezone = 'UTC',
): HistoryTimeViewport {
  const to = now.getTime();
  const from = to - RANGE_DURATIONS_MS[rangeLabel];

  return {
    range: {
      mode: 'relative',
      label: rangeLabel,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      timezone,
    },
    aggregation: defaultAggregationForRange(rangeLabel),
  };
}

export function zoomTimeViewport(viewport: HistoryTimeViewport, deltaY: number): HistoryTimeViewport {
  const parsedRange = parseViewportRange(viewport);
  if (!parsedRange) return viewport;

  const { fromMs, durationMs: currentDurationMs } = parsedRange;
  const nextDurationMs = clampDuration(currentDurationMs * (deltaY < 0 ? 0.5 : 2));
  const midpointMs = fromMs + currentDurationMs / 2;
  const nextFromMs = midpointMs - nextDurationMs / 2;
  return customViewport(viewport, nextFromMs, nextDurationMs);
}

export function panTimeViewport(viewport: HistoryTimeViewport, direction: 'left' | 'right'): HistoryTimeViewport {
  const parsedRange = parseViewportRange(viewport);
  if (!parsedRange) return viewport;

  const offsetMs = parsedRange.durationMs * PAN_FRACTION * (direction === 'left' ? -1 : 1);
  return customViewport(viewport, parsedRange.fromMs + offsetMs, parsedRange.durationMs);
}

export function useTimeViewport(defaultRange: HistoryRangeLabel, resetKey: string = defaultRange) {
  const timezone = useMemo(timezoneForBrowser, []);
  const previousResetKey = useRef(resetKey);
  const [viewport, setViewport] = useState<HistoryTimeViewport>(() =>
    createDefaultTimeViewport(defaultRange, new Date(), timezone),
  );

  useEffect(() => {
    if (previousResetKey.current === resetKey) return;
    previousResetKey.current = resetKey;
    setViewport(createDefaultTimeViewport(defaultRange, new Date(), timezone));
  }, [defaultRange, resetKey, timezone]);

  const reset = useCallback(() => {
    setViewport(createDefaultTimeViewport(defaultRange, new Date(), timezone));
  }, [defaultRange, timezone]);

  const zoom = useCallback((deltaY: number) => {
    setViewport((current) => zoomTimeViewport(current, deltaY));
  }, []);

  return {
    viewport,
    setViewport,
    zoom,
    reset,
  };
}
