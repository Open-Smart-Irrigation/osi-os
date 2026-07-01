import { describe, expect, it } from 'vitest';
import { panViewport, resetViewport, zoomViewport, MIN_SPAN_MS } from '../historyViewport';

const bounds = { minMs: 0, maxMs: 1_000_000 };

describe('historyViewport', () => {
  it('zooms in around the anchor, keeping the anchor at the same relative position', () => {
    const vp = { fromMs: 0, toMs: 1_000_000 };
    const next = zoomViewport(vp, bounds, 250_000, 0.5);
    expect(next.toMs - next.fromMs).toBeCloseTo(500_000, -1);
    const rel = (250_000 - next.fromMs) / (next.toMs - next.fromMs);
    expect(rel).toBeCloseTo(0.25, 5);
  });

  it('clamps zoom-out to bounds', () => {
    const vp = { fromMs: 100_000, toMs: 200_000 };
    const next = zoomViewport(vp, bounds, 150_000, 100);
    expect(next.fromMs).toBe(0);
    expect(next.toMs).toBe(1_000_000);
  });

  it('does not zoom below MIN_SPAN_MS', () => {
    const vp = { fromMs: 0, toMs: MIN_SPAN_MS * 2 };
    const next = zoomViewport(vp, bounds, 0, 0.0001);
    expect(next.toMs - next.fromMs).toBeGreaterThanOrEqual(MIN_SPAN_MS);
  });

  it('pans and clamps at the left bound', () => {
    const vp = { fromMs: 100_000, toMs: 200_000 };
    const next = panViewport(vp, bounds, -500_000);
    expect(next.fromMs).toBe(0);
    expect(next.toMs).toBe(MIN_SPAN_MS);
  });

  it('pans a viewport wider than the bounds without returning out-of-bounds dates', () => {
    const next = panViewport({ fromMs: -100_000, toMs: 1_200_000 }, bounds, 50_000);
    expect(next).toEqual({ fromMs: 0, toMs: 1_000_000 });
  });

  it('reset returns the default range clamped to bounds', () => {
    expect(resetViewport(bounds, 300_000)).toEqual({ fromMs: 700_000, toMs: 1_000_000 });
  });
});
