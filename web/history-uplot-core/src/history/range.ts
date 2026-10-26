import { DAY_MS, HISTORY_MAX_VIEWPORT_SPAN_MS, MINUTE_MS, type Viewport } from '../shared/types';
import type { HistoryAcceptedData, HistoryRangeRequest } from './types';

export const HISTORY_NAVIGATION_START_MS = 0;
export { HISTORY_MAX_VIEWPORT_SPAN_MS };

const TIER_MAX: Record<HistoryRangeRequest['aggregation'], number> = {
  raw: DAY_MS,
  "15m": 7 * DAY_MS,
  hourly: 30 * DAY_MS,
  daily: HISTORY_MAX_VIEWPORT_SPAN_MS,
};
export function minuteViewport(viewport: Viewport): Viewport {
  return {
    from: Math.floor(viewport.from / MINUTE_MS) * MINUTE_MS,
    to: Math.floor(viewport.to / MINUTE_MS) * MINUTE_MS,
  };
}
export function requestForViewport(viewport: Viewport): HistoryRangeRequest {
  const span = viewport.to - viewport.from;
  if (!Number.isFinite(span) || span <= 0) throw new Error("Invalid viewport");
  if (span <= DAY_MS)
    return {
      from: viewport.from,
      to: viewport.to,
      rangeLabel: "24h",
      aggregation: "raw",
    };
  if (span <= 7 * DAY_MS)
    return {
      from: viewport.from,
      to: viewport.to,
      rangeLabel: "7d",
      aggregation: "15m",
    };
  if (span <= 30 * DAY_MS)
    return {
      from: viewport.from,
      to: viewport.to,
      rangeLabel: "30d",
      aggregation: "hourly",
    };
  if (span <= HISTORY_MAX_VIEWPORT_SPAN_MS)
    return {
      from: viewport.from,
      to: viewport.to,
      rangeLabel: "30d",
      aggregation: "daily",
    };
  throw new Error("Viewport exceeds pilot horizon");
}
export function bufferedRequest(
  viewport: Viewport,
  horizon: Viewport,
): HistoryRangeRequest {
  const request = requestForViewport(viewport);
  const span = viewport.to - viewport.from;
  const maxSpan = TIER_MAX[request.aggregation];
  const padding =
    span >= maxSpan ? 0 : Math.min(span * 0.25, (maxSpan - span) / 2);
  const center = (viewport.from + viewport.to) / 2;
  const half = span / 2 + padding;
  let from = Math.max(horizon.from, center - half);
  let to = Math.min(horizon.to, center + half);
  if (to - from > maxSpan) {
    if (from === horizon.from) to = from + maxSpan;
    else if (to === horizon.to) from = to - maxSpan;
    else {
      from = center - maxSpan / 2;
      to = center + maxSpan / 2;
    }
  }
  return { ...request, from, to };
}
export function coverageContains(
  accepted: Pick<HistoryAcceptedData, 'coverage' | 'request'>,
  visible: Viewport,
  desiredAggregation: HistoryRangeRequest['aggregation'],
): boolean {
  return (
    accepted.request.aggregation === desiredAggregation &&
    accepted.coverage.from <= visible.from &&
    accepted.coverage.to >= visible.to
  );
}
export function neighborRequest(
  viewport: Viewport,
  direction: "back" | "forward",
  horizon: Viewport,
): HistoryRangeRequest | null {
  const span = viewport.to - viewport.from;
  if (!Number.isFinite(span) || span <= 0) return null;
  const delta = span * 0.8 * (direction === "back" ? -1 : 1);
  if (
    !Number.isFinite(horizon.from) ||
    !Number.isFinite(horizon.to) ||
    horizon.to <= horizon.from
  )
    return null;
  const candidate = { from: viewport.from + delta, to: viewport.to + delta };
  if (candidate.from >= horizon.from && candidate.to <= horizon.to)
    return bufferedRequest(candidate, horizon);
  const shifted =
    candidate.from < horizon.from
      ? { from: horizon.from, to: horizon.from + span }
      : { from: horizon.to - span, to: horizon.to };
  if (
    shifted.from < horizon.from ||
    shifted.to > horizon.to ||
    (shifted.from === viewport.from && shifted.to === viewport.to)
  )
    return null;
  return bufferedRequest(shifted, horizon);
}
