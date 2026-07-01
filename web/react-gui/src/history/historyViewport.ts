export interface HistoryViewport { fromMs: number; toMs: number }
export interface ViewportBounds { minMs: number; maxMs: number }

export const MIN_SPAN_MS = 5 * 60 * 1000; // 5 minutes

function clampSpanToBounds(from: number, to: number, bounds: ViewportBounds): HistoryViewport {
  let span = Math.min(Math.max(to - from, MIN_SPAN_MS), bounds.maxMs - bounds.minMs);
  let nextFrom = from;
  let nextTo = from + span;
  if (nextFrom < bounds.minMs) { nextFrom = bounds.minMs; nextTo = nextFrom + span; }
  if (nextTo > bounds.maxMs) { nextTo = bounds.maxMs; nextFrom = nextTo - span; }
  if (nextFrom < bounds.minMs) nextFrom = bounds.minMs;
  return { fromMs: nextFrom, toMs: nextTo };
}

export function zoomViewport(vp: HistoryViewport, bounds: ViewportBounds, anchorMs: number, factor: number): HistoryViewport {
  const span = vp.toMs - vp.fromMs;
  const anchor = Math.min(Math.max(anchorMs, vp.fromMs), vp.toMs);
  const rel = span > 0 ? (anchor - vp.fromMs) / span : 0.5;
  const maxSpan = bounds.maxMs - bounds.minMs;
  const nextSpan = Math.min(Math.max(span * factor, MIN_SPAN_MS), maxSpan);
  const nextFrom = anchor - rel * nextSpan;
  return clampSpanToBounds(nextFrom, nextFrom + nextSpan, bounds);
}

export function panViewport(vp: HistoryViewport, bounds: ViewportBounds, deltaMs: number): HistoryViewport {
  return clampSpanToBounds(vp.fromMs + deltaMs, vp.toMs + deltaMs, bounds);
}

export function resetViewport(bounds: ViewportBounds, defaultSpanMs: number): HistoryViewport {
  const span = Math.min(Math.max(defaultSpanMs, MIN_SPAN_MS), bounds.maxMs - bounds.minMs);
  return { fromMs: bounds.maxMs - span, toMs: bounds.maxMs };
}
