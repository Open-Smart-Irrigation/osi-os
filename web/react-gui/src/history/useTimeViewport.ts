import { useCallback, useEffect, useMemo, useState } from 'react';
import { defaultAggregationForRange } from './rangeModel';
import type {
  HistoryAggregationLevel,
  HistoryRangeLabel,
  HistoryRangeSelection,
  HistoryWorkspaceRange,
} from './types';

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

type TimeViewportState = {
  resetKey: string;
  viewport: HistoryTimeViewport;
};

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

export function setTimeViewportRange(
  rangeLabel: HistoryRangeLabel,
  now = new Date(),
  timezone = 'UTC',
): HistoryTimeViewport {
  return createDefaultTimeViewport(rangeLabel, now, timezone);
}

export function createTimeViewportFromWorkspaceRange(
  workspaceRange: HistoryWorkspaceRange,
  aggregation: HistoryAggregationLevel,
  now = new Date(),
  timezone = 'UTC',
): HistoryTimeViewport {
  const fallback = createDefaultTimeViewport(workspaceRange.label, now, timezone);

  return {
    range: {
      mode: workspaceRange.mode,
      label: workspaceRange.label,
      from: workspaceRange.from ?? fallback.range.from,
      to: workspaceRange.to ?? fallback.range.to,
      timezone,
    },
    aggregation,
  };
}

export function workspaceRangeFromTimeViewport(
  viewport: HistoryTimeViewport,
): HistoryWorkspaceRange {
  return {
    mode: viewport.range.mode,
    label: viewport.range.label,
    from: viewport.range.from,
    to: viewport.range.to,
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
  const createDefaultViewport = useCallback(
    () => createDefaultTimeViewport(defaultRange, new Date(), timezone),
    [defaultRange, timezone],
  );
  const [viewportState, setViewportState] = useState<TimeViewportState>(() => ({
    resetKey,
    viewport: createDefaultViewport(),
  }));
  const viewport = viewportState.resetKey === resetKey ? viewportState.viewport : createDefaultViewport();

  useEffect(() => {
    if (viewportState.resetKey === resetKey) return;
    setViewportState({
      resetKey,
      viewport: createDefaultViewport(),
    });
  }, [createDefaultViewport, resetKey, viewportState.resetKey]);

  const setViewport = useCallback((
    nextViewport: HistoryTimeViewport | ((current: HistoryTimeViewport) => HistoryTimeViewport),
  ) => {
    setViewportState((current) => {
      const currentViewport = current.resetKey === resetKey ? current.viewport : createDefaultViewport();
      const viewportValue = typeof nextViewport === 'function' ? nextViewport(currentViewport) : nextViewport;
      return {
        resetKey,
        viewport: viewportValue,
      };
    });
  }, [createDefaultViewport, resetKey]);

  const reset = useCallback(() => {
    setViewportState({
      resetKey,
      viewport: createDefaultViewport(),
    });
  }, [createDefaultViewport, resetKey]);

  const zoom = useCallback((deltaY: number) => {
    setViewport((current) => zoomTimeViewport(current, deltaY));
  }, [setViewport]);

  return {
    viewport,
    setViewport,
    zoom,
    reset,
  };
}
