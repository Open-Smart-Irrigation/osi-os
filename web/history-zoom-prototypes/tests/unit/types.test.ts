import { describe, expect, test } from 'vitest';
import {
  CHART_HEIGHT,
  DAY_MS,
  FIXTURE_EXTENT,
  HOUR_MS,
  INITIAL_VIEWPORT,
  MIN_SPAN_MS,
  MAX_SPAN_MS,
  PLOT_INSETS,
  type ChartAdapter,
} from '../../src/shared/types';

describe('history zoom shared contract', () => {
  test('defines the fixed extent and viewport rules', () => {
    const start = Date.UTC(2026, 6, 1);
    expect(FIXTURE_EXTENT).toEqual({ from: start, to: start + 90 * DAY_MS });
    expect(INITIAL_VIEWPORT).toEqual({ from: FIXTURE_EXTENT.to - DAY_MS, to: FIXTURE_EXTENT.to });
    expect(MIN_SPAN_MS).toBe(HOUR_MS);
    expect(MAX_SPAN_MS).toBe(90 * DAY_MS);
    expect(CHART_HEIGHT).toBe(360);
    expect(PLOT_INSETS).toEqual({ top: 16, right: 12, bottom: 36, left: 52 });
  });

  test('requires renderer readback on every adapter', () => {
    const adapter: ChartAdapter = {
      setData: (_series) => undefined,
      setViewport: (_viewport) => undefined,
      getViewport: () => INITIAL_VIEWPORT,
      getPlotRect: () => new DOMRectReadOnly(52, 16, 326, 308),
      resize: () => undefined,
      destroy: () => undefined,
    };
    expect(adapter.getViewport()).toEqual(INITIAL_VIEWPORT);
  });
});
