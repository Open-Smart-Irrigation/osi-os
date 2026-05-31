import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultAggregationForRange } from './rangeModel';
import type { HistoryAggregationLevel, HistoryRangeLabel, HistoryRangeSelection } from './types';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MIN_VIEWPORT_MS = HOUR_MS;
const MAX_VIEWPORT_MS = 366 * DAY_MS;

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

function aggregationForDuration(durationMs: number): HistoryAggregationLevel {
  if (durationMs <= 24 * HOUR_MS) return 'raw';
  if (durationMs <= 7 * DAY_MS) return 'hourly';
  if (durationMs <= 30 * DAY_MS) return 'daily';
  return 'weekly';
}

function timezoneForBrowser(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
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
  const fromMs = viewport.range.from ? Date.parse(viewport.range.from) : NaN;
  const toMs = viewport.range.to ? Date.parse(viewport.range.to) : NaN;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return viewport;

  const currentDurationMs = toMs - fromMs;
  const nextDurationMs = clampDuration(currentDurationMs * (deltaY < 0 ? 0.5 : 2));
  const midpointMs = fromMs + currentDurationMs / 2;
  const nextFromMs = midpointMs - nextDurationMs / 2;
  const nextToMs = midpointMs + nextDurationMs / 2;

  return {
    range: {
      mode: 'absolute',
      label: 'custom',
      from: new Date(nextFromMs).toISOString(),
      to: new Date(nextToMs).toISOString(),
      timezone: viewport.range.timezone,
    },
    aggregation: aggregationForDuration(nextDurationMs),
  };
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
