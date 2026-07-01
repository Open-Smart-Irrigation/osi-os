import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pixelToTime, useChartMouseInteractions, wheelZoomFactor } from '../useChartMouseInteractions';
import type { HistoryViewport, ViewportBounds } from '../historyViewport';

function ChartHarness({
  viewport,
  bounds,
  onViewportChange,
}: {
  viewport: HistoryViewport;
  bounds: ViewportBounds;
  onViewportChange: (viewport: HistoryViewport) => void;
}) {
  const { ref } = useChartMouseInteractions({
    viewport,
    bounds,
    onViewportChange,
    onReset: vi.fn(),
  });
  return React.createElement('div', {
    ref,
    'data-testid': 'chart',
  });
}

describe('chart mouse mapping', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps a pixel x within the plot to a timestamp in the viewport', () => {
    const t = pixelToTime({ left: 100, width: 400 }, { fromMs: 0, toMs: 1000 }, 300);
    expect(t).toBeCloseTo(500, 5);
  });
  it('wheel up (negative deltaY) zooms in (factor < 1)', () => {
    expect(wheelZoomFactor(-100)).toBeLessThan(1);
    expect(wheelZoomFactor(100)).toBeGreaterThan(1);
  });

  it('compounds multiple wheel deltas queued in one animation frame', () => {
    let frame: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const onViewportChange = vi.fn();

    render(React.createElement(ChartHarness, {
      viewport: { fromMs: 0, toMs: 1_000_000 },
      bounds: { minMs: 0, maxMs: 1_000_000 },
      onViewportChange,
    }));
    const chart = screen.getByTestId('chart');
    Object.defineProperty(chart, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, width: 1_000, top: 0, height: 100, right: 1_000, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }),
    });

    fireEvent.wheel(chart, { clientX: 500, deltaY: -200 });
    fireEvent.wheel(chart, { clientX: 500, deltaY: -200 });

    act(() => {
      frame?.(0);
    });

    expect(onViewportChange).toHaveBeenCalledWith({ fromMs: 180_000, toMs: 820_000 });
  });
});
