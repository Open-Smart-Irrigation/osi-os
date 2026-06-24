import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { HistoryVisualizationSurface } from '../mobile/HistoryVisualizationSurface';
import { createDefaultTimeViewport } from '../../../history/useTimeViewport';

const fixedNow = new Date('2026-05-31T12:00:00.000Z');

function viewport24h() {
  return createDefaultTimeViewport('24h', fixedNow, 'UTC');
}

function zoomedViewport() {
  return {
    ...viewport24h(),
    range: {
      mode: 'absolute' as const,
      label: 'custom' as const,
      from: '2026-05-31T00:00:00.000Z',
      to: '2026-05-31T12:00:00.000Z',
      timezone: 'UTC',
    },
    aggregation: 'auto' as const,
  };
}

function prepareSurfaceGeometry(surface: HTMLElement) {
  Object.defineProperty(surface, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      width: 320,
      height: 240,
      right: 320,
      bottom: 240,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}

function dispatchTouch(
  surface: HTMLElement,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  touches: Array<{ clientX: number; clientY: number }>,
) {
  const touchList = touches.map((touch, index) => ({
    identifier: index,
    target: surface,
    clientX: touch.clientX,
    clientY: touch.clientY,
  }));
  const event =
    typeof TouchEvent === 'function'
      ? new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: touchList as unknown as TouchList,
          changedTouches: touchList as unknown as TouchList,
        })
      : new Event(type, { bubbles: true, cancelable: true });

  if (!(event instanceof TouchEvent)) {
    Object.defineProperty(event, 'touches', { value: touchList });
    Object.defineProperty(event, 'changedTouches', { value: touchList });
  }

  surface.dispatchEvent(event);
}

function oneFingerSwipe(
  surface: HTMLElement,
  {
    fromX = 160,
    toX = fromX,
    fromY = 120,
    toY = fromY,
  }: { fromX?: number; toX?: number; fromY?: number; toY?: number },
) {
  dispatchTouch(surface, 'touchstart', [{ clientX: fromX, clientY: fromY }]);
  dispatchTouch(surface, 'touchmove', [{ clientX: toX, clientY: toY }]);
  dispatchTouch(surface, 'touchend', []);
}

function twoFingerSwipe(
  surface: HTMLElement,
  {
    fromMidX,
    toMidX,
    y = 120,
    distancePx = 80,
  }: { fromMidX: number; toMidX: number; y?: number; distancePx?: number },
) {
  const half = distancePx / 2;
  dispatchTouch(surface, 'touchstart', [
    { clientX: fromMidX - half, clientY: y },
    { clientX: fromMidX + half, clientY: y },
  ]);
  dispatchTouch(surface, 'touchmove', [
    { clientX: toMidX - half, clientY: y },
    { clientX: toMidX + half, clientY: y },
  ]);
  dispatchTouch(surface, 'touchend', []);
}

function pinchMove(
  surface: HTMLElement,
  {
    centerX = 160,
    centerY = 90,
    startDist = 80,
    endDist = 200,
  }: { centerX?: number; centerY?: number; startDist?: number; endDist?: number } = {},
) {
  dispatchTouch(surface, 'touchstart', [
    { clientX: centerX - startDist / 2, clientY: centerY },
    { clientX: centerX + startDist / 2, clientY: centerY },
  ]);
  dispatchTouch(surface, 'touchmove', [
    { clientX: centerX - endDist / 2, clientY: centerY },
    { clientX: centerX + endDist / 2, clientY: centerY },
  ]);
}

function pinchEnd(surface: HTMLElement) {
  dispatchTouch(surface, 'touchend', []);
}

describe('HistoryVisualizationSurface', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders children and sets touch-action none only on the visualization surface', () => {
    render(
      <div data-testid="page-root">
        <HistoryVisualizationSurface
          viewport={viewport24h()}
          defaultRange="24h"
          onViewportChange={vi.fn()}
          rangeLabel="24h"
          aggregationLabel="Raw"
        >
          <div>Soil profile</div>
        </HistoryVisualizationSurface>
      </div>,
    );

    const pageRoot = screen.getByTestId('page-root');
    const surface = screen.getByTestId('history-visualization-surface');

    expect(surface).toHaveTextContent('Soil profile');
    expect(surface).toHaveStyle({ touchAction: 'none' });
    expect(surface).toHaveAttribute('data-history-visualization-surface', 'true');
    expect(pageRoot).not.toHaveStyle({ touchAction: 'none' });
    expect(screen.queryByText('24h')).not.toBeInTheDocument();
    expect(screen.queryByText('Raw')).not.toBeInTheDocument();
  });

  it('routes two-finger horizontal swipe to card switching and one-finger vertical to view switching', () => {
    const onCardSwipe = vi.fn();
    const onViewSwipe = vi.fn();
    render(
      <HistoryVisualizationSurface
        viewport={viewport24h()}
        defaultRange="24h"
        onViewportChange={vi.fn()}
        activeView="line-chart"
        isZoomed={false}
        onCardSwipe={onCardSwipe}
        onViewSwipe={onViewSwipe}
        onMonthSwipe={vi.fn()}
      >
        <div>Soil profile</div>
      </HistoryVisualizationSurface>,
    );
    const surface = screen.getByTestId('history-visualization-surface');
    prepareSurfaceGeometry(surface);

    twoFingerSwipe(surface, { fromMidX: 260, toMidX: 120 });
    oneFingerSwipe(surface, { fromY: 220, toY: 80 });

    expect(onCardSwipe).toHaveBeenCalledWith(-1);
    expect(onViewSwipe).toHaveBeenCalledWith(-1);
  });

  it('ignores one-finger horizontal swipe in chart views until zoomed', () => {
    const onCardSwipe = vi.fn();
    const onViewSwipe = vi.fn();
    const onMonthSwipe = vi.fn();
    const onViewportChange = vi.fn();
    render(
      <HistoryVisualizationSurface
        viewport={viewport24h()}
        defaultRange="24h"
        onViewportChange={onViewportChange}
        activeView="line-chart"
        isZoomed={false}
        onCardSwipe={onCardSwipe}
        onViewSwipe={onViewSwipe}
        onMonthSwipe={onMonthSwipe}
      >
        <div>Soil profile</div>
      </HistoryVisualizationSurface>,
    );
    const surface = screen.getByTestId('history-visualization-surface');
    prepareSurfaceGeometry(surface);

    oneFingerSwipe(surface, { fromX: 280, toX: 120, fromY: 120, toY: 124 });

    expect(onCardSwipe).not.toHaveBeenCalled();
    expect(onViewSwipe).not.toHaveBeenCalled();
    expect(onMonthSwipe).not.toHaveBeenCalled();
    expect(onViewportChange).not.toHaveBeenCalled();
  });

  it('routes inner one-finger horizontal swipe in calendar to month switching', () => {
    const onMonthSwipe = vi.fn();
    render(
      <HistoryVisualizationSurface
        viewport={viewport24h()}
        defaultRange="24h"
        onViewportChange={vi.fn()}
        activeView="calendar"
        isZoomed={false}
        onCardSwipe={vi.fn()}
        onViewSwipe={vi.fn()}
        onMonthSwipe={onMonthSwipe}
      >
        <div>Calendar</div>
      </HistoryVisualizationSurface>,
    );
    const surface = screen.getByTestId('history-visualization-surface');
    prepareSurfaceGeometry(surface);

    oneFingerSwipe(surface, { fromX: 250, toX: 120, fromY: 120, toY: 124 });

    // Swipe left advances to the next month.
    expect(onMonthSwipe).toHaveBeenCalledWith(1);
  });

  it('pans the viewport on one-finger horizontal drag when zoomed in', () => {
    const onViewportChange = vi.fn();
    render(
      <HistoryVisualizationSurface
        viewport={zoomedViewport()}
        defaultRange="24h"
        onViewportChange={onViewportChange}
        activeView="line-chart"
        isZoomed
      >
        <div>Soil profile</div>
      </HistoryVisualizationSurface>,
    );
    const surface = screen.getByTestId('history-visualization-surface');
    prepareSurfaceGeometry(surface);

    dispatchTouch(surface, 'touchstart', [{ clientX: 300, clientY: 120 }]);
    dispatchTouch(surface, 'touchmove', [{ clientX: 120, clientY: 124 }]);
    dispatchTouch(surface, 'touchend', []);

    expect(onViewportChange).toHaveBeenCalledWith(
      expect.objectContaining({
        range: expect.objectContaining({ label: 'custom' }),
        aggregation: 'auto',
      }),
    );
  });

  it('zooms the viewport on two-finger pinch', () => {
    const onViewportChange = vi.fn();
    render(
      <HistoryVisualizationSurface
        viewport={viewport24h()}
        defaultRange="24h"
        onViewportChange={onViewportChange}
        activeView="line-chart"
        isZoomed={false}
      >
        <div>Soil profile</div>
      </HistoryVisualizationSurface>,
    );
    const surface = screen.getByTestId('history-visualization-surface');
    prepareSurfaceGeometry(surface);

    dispatchTouch(surface, 'touchstart', [
      { clientX: 120, clientY: 90 },
      { clientX: 200, clientY: 90 },
    ]);
    dispatchTouch(surface, 'touchmove', [
      { clientX: 80, clientY: 90 },
      { clientX: 240, clientY: 90 },
    ]);
    dispatchTouch(surface, 'touchend', []);

    expect(onViewportChange).toHaveBeenCalledWith(
      expect.objectContaining({
        range: expect.objectContaining({ label: 'custom' }),
        aggregation: 'auto',
      }),
    );
  });

  it('pinch move updates visual window only and release commits the viewport', () => {
    const onVisualWindow = vi.fn();
    const onViewportChange = vi.fn();
    const frameQueue: FrameRequestCallback[] = [];
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        frameQueue.push(callback);
        return frameQueue.length;
      });
    const cancelAnimationFrameSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => undefined);

    render(
      <HistoryVisualizationSurface
        viewport={viewport24h()}
        defaultRange="24h"
        onViewportChange={onViewportChange}
        onVisualWindow={onVisualWindow}
        activeView="line-chart"
        isZoomed={false}
      >
        <div>Soil profile</div>
      </HistoryVisualizationSurface>,
    );
    const surface = screen.getByTestId('history-visualization-surface');
    prepareSurfaceGeometry(surface);

    pinchMove(surface, { startDist: 80, endDist: 160 });

    expect(onVisualWindow).not.toHaveBeenCalled();
    expect(onViewportChange).not.toHaveBeenCalled();
    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);

    act(() => {
      frameQueue.shift()?.(0);
    });

    expect(onVisualWindow).toHaveBeenCalledTimes(1);
    expect(onVisualWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        fromMs: expect.any(Number),
        toMs: expect.any(Number),
      }),
    );
    expect(onViewportChange).not.toHaveBeenCalled();

    pinchEnd(surface);

    expect(onViewportChange).toHaveBeenCalledTimes(1);
    expect(onViewportChange).toHaveBeenCalledWith(
      expect.objectContaining({
        range: expect.objectContaining({ label: 'custom' }),
        aggregation: 'auto',
      }),
    );
    expect(cancelAnimationFrameSpy).not.toHaveBeenCalled();
  });

  it('coalesces live pinch visual-window updates to one callback per animation frame', () => {
    const onVisualWindow = vi.fn();
    const onViewportChange = vi.fn();
    const frameQueue: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      frameQueue.push(callback);
      return frameQueue.length;
    });

    render(
      <HistoryVisualizationSurface
        viewport={viewport24h()}
        defaultRange="24h"
        onViewportChange={onViewportChange}
        onVisualWindow={onVisualWindow}
        activeView="line-chart"
        isZoomed={false}
      >
        <div>Soil profile</div>
      </HistoryVisualizationSurface>,
    );
    const surface = screen.getByTestId('history-visualization-surface');
    prepareSurfaceGeometry(surface);

    dispatchTouch(surface, 'touchstart', [
      { clientX: 120, clientY: 90 },
      { clientX: 200, clientY: 90 },
    ]);
    dispatchTouch(surface, 'touchmove', [
      { clientX: 80, clientY: 90 },
      { clientX: 240, clientY: 90 },
    ]);
    dispatchTouch(surface, 'touchmove', [
      { clientX: 60, clientY: 90 },
      { clientX: 260, clientY: 90 },
    ]);

    expect(onVisualWindow).not.toHaveBeenCalled();
    expect(onViewportChange).not.toHaveBeenCalled();
    expect(frameQueue).toHaveLength(1);

    act(() => {
      frameQueue.shift()?.(0);
    });

    expect(onVisualWindow).toHaveBeenCalledTimes(1);
    expect(onVisualWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        fromMs: expect.any(Number),
        toMs: expect.any(Number),
      }),
    );
    expect(onViewportChange).not.toHaveBeenCalled();
  });

  it('keeps emitted visual windows ordered at the zoom clamp bounds', () => {
    const onVisualWindow = vi.fn();
    const frameQueue: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      frameQueue.push(callback);
      return frameQueue.length;
    });

    render(
      <HistoryVisualizationSurface
        viewport={viewport24h()}
        defaultRange="24h"
        onViewportChange={vi.fn()}
        onVisualWindow={onVisualWindow}
        activeView="line-chart"
        isZoomed={false}
      >
        <div>Soil profile</div>
      </HistoryVisualizationSurface>,
    );
    const surface = screen.getByTestId('history-visualization-surface');
    prepareSurfaceGeometry(surface);

    pinchMove(surface, { startDist: 80, endDist: 20_000 });
    act(() => {
      frameQueue.shift()?.(0);
    });

    expect(onVisualWindow).toHaveBeenCalledTimes(1);
    const emitted = onVisualWindow.mock.calls[0]?.[0] as { fromMs: number; toMs: number };
    expect(Number.isFinite(emitted.fromMs)).toBe(true);
    expect(Number.isFinite(emitted.toMs)).toBe(true);
    expect(emitted.fromMs).toBeLessThan(emitted.toMs);
    expect(emitted.toMs - emitted.fromMs).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });

  it('double tap resets through the gesture hook behavior', () => {
    const onViewportChange = vi.fn();
    render(
      <HistoryVisualizationSurface
        viewport={zoomedViewport()}
        defaultRange="24h"
        onViewportChange={onViewportChange}
      >
        <div>Soil profile</div>
      </HistoryVisualizationSurface>,
    );
    const surface = screen.getByTestId('history-visualization-surface');
    prepareSurfaceGeometry(surface);

    dispatchTouch(surface, 'touchstart', [{ clientX: 120, clientY: 80 }]);
    dispatchTouch(surface, 'touchend', []);
    dispatchTouch(surface, 'touchstart', [{ clientX: 124, clientY: 82 }]);

    expect(onViewportChange).toHaveBeenCalledWith(
      expect.objectContaining({
        range: expect.objectContaining({ label: '24h', mode: 'relative' }),
      }),
    );
  });

  it('long press calls inspect with an x-position-derived timestamp', () => {
    const onInspect = vi.fn();
    render(
      <HistoryVisualizationSurface
        viewport={viewport24h()}
        defaultRange="24h"
        onViewportChange={vi.fn()}
        onInspect={onInspect}
      >
        <div>Soil profile</div>
      </HistoryVisualizationSurface>,
    );
    const surface = screen.getByTestId('history-visualization-surface');
    prepareSurfaceGeometry(surface);

    dispatchTouch(surface, 'touchstart', [{ clientX: 80, clientY: 90 }]);
    vi.advanceTimersByTime(500);

    expect(onInspect).toHaveBeenCalledWith({ timestamp: '2026-05-30T18:00:00.000Z' });
  });
});
