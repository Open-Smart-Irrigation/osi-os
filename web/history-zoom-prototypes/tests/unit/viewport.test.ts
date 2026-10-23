import { describe, expect, test } from 'vitest';
import { zoomIdentity } from 'd3-zoom';
import { DAY_MS, FIXTURE_EXTENT, HOUR_MS, INITIAL_VIEWPORT, type Viewport } from '../../src/shared/types';
import { createViewportStore, normalizeViewport, sameViewport, transformToViewport, viewportToTransform } from '../../src/shared/viewport';

describe('viewport rules', () => {
  test.each([
    [{ from: 10, to: 20 }, { from: 0, to: 100 }, 30, 80, { from: 0, to: 30 }],
    [{ from: 10, to: 110 }, { from: 0, to: 100 }, 1, 50, { from: 35, to: 85 }],
    [{ from: -10, to: 20 }, { from: 0, to: 100 }, 1, 100, { from: 0, to: 30 }],
    [{ from: 90, to: 120 }, { from: 0, to: 100 }, 1, 100, { from: 70, to: 100 }],
  ])('clamps span and extent boundaries', (candidate, extent, min, max, expected) => {
    expect(normalizeViewport(candidate, extent, min, max, { from: 40, to: 50 })).toEqual(expected);
  });

  test('falls back for invalid candidates and compares with tolerance', () => {
    const fallback = { from: 10, to: 20 };
    expect(normalizeViewport({ from: Number.NaN, to: 30 }, { from: 0, to: 100 }, 1, 100, fallback)).toEqual(fallback);
    expect(normalizeViewport({ from: 30, to: 20 }, { from: 0, to: 100 }, 1, 100, fallback)).toEqual(fallback);
    expect(sameViewport(fallback, { from: 10.5, to: 20.5 })).toBe(true);
    expect(sameViewport(fallback, { from: 12, to: 20 })).toBe(false);
  });

  test('round trips a viewport through the d3 transform', () => {
    const viewport = { from: FIXTURE_EXTENT.from + 2 * DAY_MS, to: FIXTURE_EXTENT.from + 3 * DAY_MS };
    const transform = viewportToTransform(viewport, FIXTURE_EXTENT, 600);
    expect(transformToViewport(transform, FIXTURE_EXTENT, 600, INITIAL_VIEWPORT)).toEqual(viewport);
  });

  test('store suppresses equivalent notifications and preserves source', () => {
    const events: Array<[Viewport, string]> = [];
    const store = createViewportStore(INITIAL_VIEWPORT, FIXTURE_EXTENT);
    store.subscribe((viewport, source) => events.push([viewport, source]));
    store.set({ ...INITIAL_VIEWPORT, from: INITIAL_VIEWPORT.from - 0.5 }, 'gesture');
    store.set({ from: INITIAL_VIEWPORT.from - HOUR_MS, to: INITIAL_VIEWPORT.to - HOUR_MS }, 'external');
    expect(events).toHaveLength(1);
    expect(events[0][1]).toBe('external');
    expect(store.get()).toEqual({ from: INITIAL_VIEWPORT.from - HOUR_MS, to: INITIAL_VIEWPORT.to - HOUR_MS });
  });

  test('uses a supplied minimum span and extent for transform conversion', () => {
    const extent = { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 3, 1) };
    const minSpanMs = 60 * 60 * 1000;
    const store = createViewportStore({ from: extent.to - 24 * HOUR_MS, to: extent.to }, extent, minSpanMs);
    const transform = viewportToTransform(store.get(), extent, 600);
    expect(transformToViewport(transform, extent, 600, store.get(), minSpanMs)).toEqual(store.get());
    expect(normalizeViewport({ from: extent.from, to: extent.from + 1 }, extent, minSpanMs, extent.to - extent.from, store.get())).toEqual({
      from: extent.from,
      to: extent.from + minSpanMs,
    });
  });
});
