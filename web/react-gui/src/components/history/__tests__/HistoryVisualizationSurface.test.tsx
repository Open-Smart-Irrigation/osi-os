import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

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

  it('reports a horizontal single-finger swipe when the viewport is not zoomed', () => {
    const onSwipe = vi.fn();
    render(
      <HistoryVisualizationSurface
        viewport={viewport24h()}
        defaultRange="24h"
        onViewportChange={vi.fn()}
        onSwipe={onSwipe}
      >
        <div>Soil profile</div>
      </HistoryVisualizationSurface>,
    );
    const surface = screen.getByTestId('history-visualization-surface');
    prepareSurfaceGeometry(surface);

    dispatchTouch(surface, 'touchstart', [{ clientX: 300, clientY: 120 }]);
    dispatchTouch(surface, 'touchmove', [{ clientX: 120, clientY: 124 }]);
    dispatchTouch(surface, 'touchend', []);

    expect(onSwipe).toHaveBeenCalledWith('horizontal', -180);
  });

  it('pans the viewport on one-finger horizontal drag when zoomed in', () => {
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

    expect(onViewportChange).toHaveBeenCalledWith(
      expect.objectContaining({
        range: expect.objectContaining({ label: 'custom' }),
        aggregation: 'auto',
      }),
    );
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
