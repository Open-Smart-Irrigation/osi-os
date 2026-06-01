import { act, renderHook } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  anchorRatioForPoint,
  applyDragPan,
  applyPinchZoom,
  distance,
  isLongPress,
  midpoint,
  timestampAtSurfaceRatio,
  type Point,
} from '../../../history/gestureModel';
import { useVisualizationGestures } from '../../../history/useVisualizationGestures';
import { createDefaultTimeViewport } from '../../../history/useTimeViewport';

const fixedNow = new Date('2026-05-31T12:00:00.000Z');

function durationMs(viewport: ReturnType<typeof createDefaultTimeViewport>): number {
  return Date.parse(viewport.range.to ?? '') - Date.parse(viewport.range.from ?? '');
}

function fakePointerEvent(
  target: HTMLElement,
  overrides: Partial<React.PointerEvent<HTMLElement>>,
): React.PointerEvent<HTMLElement> {
  return {
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    currentTarget: target,
    preventDefault: vi.fn(),
    ...overrides,
  } as React.PointerEvent<HTMLElement>;
}

function createGestureTarget(): HTMLElement {
  return {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    getBoundingClientRect: () => ({
      left: 10,
      top: 0,
      width: 200,
      height: 120,
      right: 210,
      bottom: 120,
      x: 10,
      y: 0,
      toJSON: () => ({}),
    }),
  } as unknown as HTMLElement;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('history gesture model', () => {
  it('measures pointer distance, midpoint, and surface anchor ratio', () => {
    const a: Point = { x: 10, y: 10 };
    const b: Point = { x: 40, y: 50 };

    expect(distance(a, b)).toBe(50);
    expect(midpoint(a, b)).toEqual({ x: 25, y: 30 });
    expect(anchorRatioForPoint(60, 10, 200)).toBe(0.25);
    expect(anchorRatioForPoint(-100, 10, 200)).toBe(0);
    expect(anchorRatioForPoint(500, 10, 200)).toBe(1);
  });

  it('pinch open zooms into a narrower anchored time window', () => {
    const viewport = createDefaultTimeViewport('24h', fixedNow, 'Europe/Zurich');

    const result = applyPinchZoom(viewport, {
      previousDistancePx: 100,
      nextDistancePx: 140,
      anchorRatio: 0.25,
    });

    expect(durationMs(result)).toBeLessThan(durationMs(viewport));
    expect(result.range.label).toBe('custom');
    expect(result.aggregation).toBe('auto');
  });

  it('pinch close zooms out to a wider anchored time window', () => {
    const viewport = createDefaultTimeViewport('24h', fixedNow, 'Europe/Zurich');

    const result = applyPinchZoom(viewport, {
      previousDistancePx: 140,
      nextDistancePx: 100,
      anchorRatio: 0.75,
    });

    expect(durationMs(result)).toBeGreaterThan(durationMs(viewport));
    expect(result.range.label).toBe('custom');
    expect(result.aggregation).toBe('auto');
  });

  it('small pinch jitter below threshold does not change the viewport', () => {
    const viewport = createDefaultTimeViewport('24h', fixedNow, 'Europe/Zurich');

    const result = applyPinchZoom(viewport, {
      previousDistancePx: 100,
      nextDistancePx: 103,
      anchorRatio: 0.5,
    });

    expect(result).toBe(viewport);
  });

  it('maps a touched x-position to a timestamp inside the current viewport', () => {
    const viewport = createDefaultTimeViewport('24h', fixedNow, 'Europe/Zurich');
    const timestamp = timestampAtSurfaceRatio(viewport, 0.25);

    expect(Date.parse(timestamp)).toBeGreaterThan(Date.parse(viewport.range.from ?? ''));
    expect(Date.parse(timestamp)).toBeLessThan(Date.parse(viewport.range.to ?? ''));
    expect(timestamp).toBe('2026-05-30T18:00:00.000Z');
  });

  it('keeps drag jitter inside the dead zone and pans above it', () => {
    const viewport = createDefaultTimeViewport('24h', fixedNow, 'Europe/Zurich');

    expect(applyDragPan(viewport, { surfaceWidthPx: 200, deltaXPx: 4 })).toBe(viewport);

    const result = applyDragPan(viewport, { surfaceWidthPx: 200, deltaXPx: 20 });

    expect(result).not.toBe(viewport);
    expect(result.range.label).toBe('custom');
    expect(result.aggregation).toBe('auto');
    expect(result.range.from).toBe('2026-05-30T09:36:00.000Z');
    expect(result.range.to).toBe('2026-05-31T09:36:00.000Z');
  });

  it('applies long press threshold and movement cancellation', () => {
    expect(isLongPress(499, 0)).toBe(false);
    expect(isLongPress(500, 10)).toBe(true);
    expect(isLongPress(500, 10.1)).toBe(false);
  });
});

describe('useVisualizationGestures', () => {
  it('returns pointer handlers with touch-action disabled', () => {
    const { result } = renderHook(() =>
      useVisualizationGestures({
        viewport: createDefaultTimeViewport('24h', fixedNow, 'Europe/Zurich'),
        defaultRange: '24h',
        onViewportChange: vi.fn(),
      }),
    );

    expect(result.current.style).toEqual({ touchAction: 'none' });
    expect(result.current.onPointerDown).toEqual(expect.any(Function));
    expect(result.current.onPointerMove).toEqual(expect.any(Function));
    expect(result.current.onPointerUp).toEqual(expect.any(Function));
    expect(result.current.onPointerCancel).toEqual(expect.any(Function));
  });

  it('uses pointer handlers to pan, pinch, and inspect at the touched x-position', () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const target = createGestureTarget();
    const onViewportChange = vi.fn();
    const onInspect = vi.fn();
    const viewport = createDefaultTimeViewport('24h', fixedNow, 'Europe/Zurich');
    const { result } = renderHook(() =>
      useVisualizationGestures({
        viewport,
        defaultRange: '24h',
        onViewportChange,
        onInspect,
      }),
    );

    act(() => {
      result.current.onPointerDown(fakePointerEvent(target, { pointerId: 1, clientX: 110, clientY: 30 }));
      result.current.onPointerMove(fakePointerEvent(target, { pointerId: 1, clientX: 140, clientY: 30 }));
    });

    expect(target.setPointerCapture).toHaveBeenCalledWith(1);
    expect(onViewportChange).toHaveBeenCalledWith(
      expect.objectContaining({
        range: expect.objectContaining({ label: 'custom' }),
        aggregation: 'auto',
      }),
    );

    const pannedViewport =
      onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[0] ?? viewport;
    onViewportChange.mockClear();

    const { result: pinchResult } = renderHook(() =>
      useVisualizationGestures({
        viewport: pannedViewport,
        defaultRange: '24h',
        onViewportChange,
        onInspect,
      }),
    );

    act(() => {
      pinchResult.current.onPointerDown(fakePointerEvent(target, { pointerId: 1, clientX: 70, clientY: 40 }));
      pinchResult.current.onPointerDown(fakePointerEvent(target, { pointerId: 2, clientX: 150, clientY: 40 }));
      pinchResult.current.onPointerMove(fakePointerEvent(target, { pointerId: 2, clientX: 190, clientY: 40 }));
    });

    expect(onViewportChange).toHaveBeenCalledWith(
      expect.objectContaining({
        range: expect.objectContaining({ label: 'custom' }),
        aggregation: 'auto',
      }),
    );
    const pinchedViewport =
      onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[0] ?? pannedViewport;

    act(() => {
      pinchResult.current.onPointerUp(fakePointerEvent(target, { pointerId: 1, clientX: 70, clientY: 40 }));
      pinchResult.current.onPointerUp(fakePointerEvent(target, { pointerId: 2, clientX: 190, clientY: 40 }));
      pinchResult.current.onPointerDown(fakePointerEvent(target, { pointerId: 3, clientX: 60, clientY: 40 }));
      vi.advanceTimersByTime(500);
    });

    expect(onInspect).toHaveBeenCalledWith({
      timestamp: timestampAtSurfaceRatio(pinchedViewport, 0.25),
    });
  });

  it('resets the viewport on double tap', () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const target = createGestureTarget();
    const onViewportChange = vi.fn();
    const viewport = {
      ...createDefaultTimeViewport('24h', fixedNow, 'Europe/Zurich'),
      range: {
        mode: 'absolute' as const,
        label: 'custom' as const,
        from: '2026-05-31T00:00:00.000Z',
        to: '2026-05-31T12:00:00.000Z',
        timezone: 'Europe/Zurich',
      },
      aggregation: 'auto' as const,
    };
    const { result } = renderHook(() =>
      useVisualizationGestures({
        viewport,
        defaultRange: '24h',
        onViewportChange,
      }),
    );

    act(() => {
      result.current.onPointerDown(fakePointerEvent(target, { pointerId: 1, clientX: 120, clientY: 40 }));
      result.current.onPointerUp(fakePointerEvent(target, { pointerId: 1, clientX: 120, clientY: 40 }));
      result.current.onPointerDown(fakePointerEvent(target, { pointerId: 2, clientX: 124, clientY: 42 }));
    });

    expect(onViewportChange).toHaveBeenCalledWith(
      expect.objectContaining({
        range: expect.objectContaining({
          mode: 'relative',
          label: '24h',
          from: '2026-05-30T12:00:00.000Z',
          to: '2026-05-31T12:00:00.000Z',
          timezone: 'Europe/Zurich',
        }),
      }),
    );
  });

  it('accumulates slow drag movement until it exceeds the dead zone', () => {
    const target = createGestureTarget();
    const onViewportChange = vi.fn();
    const viewport = createDefaultTimeViewport('24h', fixedNow, 'Europe/Zurich');
    const { result } = renderHook(() =>
      useVisualizationGestures({
        viewport,
        defaultRange: '24h',
        onViewportChange,
      }),
    );

    act(() => {
      result.current.onPointerDown(fakePointerEvent(target, { pointerId: 1, clientX: 110, clientY: 30 }));
      result.current.onPointerMove(fakePointerEvent(target, { pointerId: 1, clientX: 114, clientY: 30 }));
      result.current.onPointerMove(fakePointerEvent(target, { pointerId: 1, clientX: 118, clientY: 30 }));
    });

    expect(onViewportChange).toHaveBeenCalledWith(
      expect.objectContaining({
        range: expect.objectContaining({ label: 'custom' }),
        aggregation: 'auto',
      }),
    );
  });

  it('does not treat a completed long press inspect as the first tap of a double tap reset', () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const target = createGestureTarget();
    const onViewportChange = vi.fn();
    const onInspect = vi.fn();
    const viewport = {
      ...createDefaultTimeViewport('24h', fixedNow, 'Europe/Zurich'),
      range: {
        mode: 'absolute' as const,
        label: 'custom' as const,
        from: '2026-05-31T00:00:00.000Z',
        to: '2026-05-31T12:00:00.000Z',
        timezone: 'Europe/Zurich',
      },
      aggregation: 'auto' as const,
    };
    const { result } = renderHook(() =>
      useVisualizationGestures({
        viewport,
        defaultRange: '24h',
        onViewportChange,
        onInspect,
      }),
    );

    act(() => {
      result.current.onPointerDown(fakePointerEvent(target, { pointerId: 1, clientX: 120, clientY: 40 }));
      vi.advanceTimersByTime(500);
      result.current.onPointerUp(fakePointerEvent(target, { pointerId: 1, clientX: 120, clientY: 40 }));
      result.current.onPointerDown(fakePointerEvent(target, { pointerId: 2, clientX: 124, clientY: 42 }));
      result.current.onPointerUp(fakePointerEvent(target, { pointerId: 2, clientX: 124, clientY: 42 }));
    });

    expect(onInspect).toHaveBeenCalledTimes(1);
    expect(onViewportChange).not.toHaveBeenCalled();
  });
});
