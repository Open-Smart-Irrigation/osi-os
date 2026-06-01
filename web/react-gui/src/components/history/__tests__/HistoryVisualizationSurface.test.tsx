import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

import { HistoryVisualizationSurface } from '../mobile/HistoryVisualizationSurface';
import { createDefaultTimeViewport } from '../../../history/useTimeViewport';

const fixedNow = new Date('2026-05-31T12:00:00.000Z');

function viewport24h() {
  return createDefaultTimeViewport('24h', fixedNow, 'UTC');
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
  surface.setPointerCapture = vi.fn();
  surface.releasePointerCapture = vi.fn();
}

function pointerDrag(
  surface: HTMLElement,
  { fromX, toX, fromY = 80, toY = fromY }: { fromX: number; toX: number; fromY?: number; toY?: number },
) {
  fireEvent.pointerDown(surface, { pointerId: 1, clientX: fromX, clientY: fromY });
  fireEvent.pointerMove(surface, { pointerId: 1, clientX: toX, clientY: toY });
  fireEvent.pointerUp(surface, { pointerId: 1, clientX: toX, clientY: toY });
}

function pointerPinch(
  surface: HTMLElement,
  { startDistance, endDistance }: { startDistance: number; endDistance: number },
) {
  const centerX = 160;
  fireEvent.pointerDown(surface, { pointerId: 1, clientX: centerX - startDistance / 2, clientY: 90 });
  fireEvent.pointerDown(surface, { pointerId: 2, clientX: centerX + startDistance / 2, clientY: 90 });
  fireEvent.pointerMove(surface, { pointerId: 2, clientX: centerX + endDistance / 2, clientY: 90 });
  fireEvent.pointerUp(surface, { pointerId: 1, clientX: centerX - startDistance / 2, clientY: 90 });
  fireEvent.pointerUp(surface, { pointerId: 2, clientX: centerX + endDistance / 2, clientY: 90 });
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
    expect(pageRoot).not.toHaveStyle({ touchAction: 'none' });
    expect(screen.getByText('24h')).toBeInTheDocument();
    expect(screen.getByText('Raw')).toBeInTheDocument();
  });

  it('pans the viewport on one-finger horizontal drag', () => {
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

    pointerDrag(surface, { fromX: 300, toX: 120 });

    expect(onViewportChange).toHaveBeenCalledWith(
      expect.objectContaining({
        range: expect.objectContaining({ label: 'custom' }),
        aggregation: 'auto',
      }),
    );
  });

  it('zooms the viewport on two-pointer pinch', () => {
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

    pointerPinch(surface, { startDistance: 80, endDistance: 160 });

    expect(onViewportChange).toHaveBeenCalledWith(
      expect.objectContaining({
        range: expect.objectContaining({ label: 'custom' }),
        aggregation: 'auto',
      }),
    );
  });

  it('double tap resets through the gesture hook behavior', () => {
    const onViewportChange = vi.fn();
    const viewport = {
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
    render(
      <HistoryVisualizationSurface
        viewport={viewport}
        defaultRange="24h"
        onViewportChange={onViewportChange}
      >
        <div>Soil profile</div>
      </HistoryVisualizationSurface>,
    );
    const surface = screen.getByTestId('history-visualization-surface');
    prepareSurfaceGeometry(surface);

    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 120, clientY: 80 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 120, clientY: 80 });
    fireEvent.pointerDown(surface, { pointerId: 2, clientX: 124, clientY: 82 });

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

    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 80, clientY: 90 });
    vi.advanceTimersByTime(500);

    expect(onInspect).toHaveBeenCalledWith({ timestamp: '2026-05-30T18:00:00.000Z' });
  });
});
