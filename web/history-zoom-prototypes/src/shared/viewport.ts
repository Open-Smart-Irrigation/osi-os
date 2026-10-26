import { scaleLinear } from 'd3-scale';
import { zoomIdentity, type ZoomTransform } from 'd3-zoom';
import { INITIAL_VIEWPORT, MAX_SPAN_MS, MIN_SPAN_MS, type Viewport, type ViewportSource } from './types';

export function normalizeViewport(candidate: Viewport, extent: Viewport, minSpanMs: number, maxSpanMs: number, fallback: Viewport): Viewport {
  if (!Number.isFinite(candidate.from) || !Number.isFinite(candidate.to) || candidate.from >= candidate.to) return { ...fallback };
  const span = Math.min(maxSpanMs, Math.max(minSpanMs, candidate.to - candidate.from));
  const midpoint = (candidate.from + candidate.to) / 2;
  let from = midpoint - span / 2;
  let to = midpoint + span / 2;
  if (from < extent.from) { from = extent.from; to = from + span; }
  if (to > extent.to) { to = extent.to; from = to - span; }
  return { from, to };
}

export function sameViewport(a: Viewport, b: Viewport, epsilonMs = 1): boolean {
  return Math.abs(a.from - b.from) <= epsilonMs && Math.abs(a.to - b.to) <= epsilonMs;
}

export function viewportToTransform(viewport: Viewport, extent: Viewport, width: number): ZoomTransform {
  const k = (extent.to - extent.from) / (viewport.to - viewport.from);
  const x = -((viewport.from - extent.from) / (extent.to - extent.from)) * width * k;
  return zoomIdentity.translate(x, 0).scale(k);
}

export function transformToViewport(
  transform: ZoomTransform,
  extent: Viewport,
  width: number,
  fallback: Viewport,
  minSpanMs = MIN_SPAN_MS,
  maxSpanMs = extent.to - extent.from,
): Viewport {
  const base = scaleLinear().domain([extent.from, extent.to]).range([0, width]);
  const domain = transform.rescaleX(base).domain();
  return normalizeViewport({ from: Number(domain[0]), to: Number(domain[1]) }, extent, minSpanMs, maxSpanMs, fallback);
}

export interface ViewportStore {
  get(): Viewport;
  set(candidate: Viewport, source: ViewportSource): Viewport;
  subscribe(listener: (viewport: Viewport, source: ViewportSource) => void): () => void;
}

export function createViewportStore(initial: Viewport, extent: Viewport, minSpanMs = MIN_SPAN_MS, maxSpanMs = extent.to - extent.from): ViewportStore {
  const fallback = normalizeViewport(INITIAL_VIEWPORT, extent, minSpanMs, maxSpanMs, extent);
  let current = normalizeViewport(initial, extent, minSpanMs, maxSpanMs, fallback);
  const listeners = new Set<(viewport: Viewport, source: ViewportSource) => void>();
  return {
    get: () => current,
    set(candidate, source) {
      const next = normalizeViewport(candidate, extent, minSpanMs, maxSpanMs, current);
      if (!sameViewport(current, next)) { current = { ...next }; listeners.forEach((listener) => listener(current, source)); }
      return current;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
