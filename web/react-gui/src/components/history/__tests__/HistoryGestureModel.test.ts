import { describe, expect, it } from 'vitest';

import {
  anchorRatioForPoint,
  applyDragPan,
  applyPinchZoom,
  classifyTwoFinger,
  classifyTouchGesture,
  distance,
  midpoint,
  pinchScale,
  swipeDirection,
  timestampAtSurfaceRatio,
  type Point,
} from '../../../history/gestureModel';
import { createDefaultTimeViewport } from '../../../history/useTimeViewport';

const fixedNow = new Date('2026-05-31T12:00:00.000Z');

function durationMs(viewport: ReturnType<typeof createDefaultTimeViewport>): number {
  return Date.parse(viewport.range.to ?? '') - Date.parse(viewport.range.from ?? '');
}

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

  it('calculates pinch scale so fingers apart narrow the time window', () => {
    expect(pinchScale(80, 160)).toBeLessThan(1);
    expect(pinchScale(160, 80)).toBeGreaterThan(1);
    expect(pinchScale(0, 80)).toBe(1);
  });

  it('picks the dominant swipe axis past the threshold', () => {
    expect(swipeDirection({ dx: 90, dy: 10 }, 40)).toBe('horizontal');
    expect(swipeDirection({ dx: 12, dy: 80 }, 40)).toBe('vertical');
    expect(swipeDirection({ dx: 10, dy: 12 }, 40)).toBeNull();
  });

  it('classifies touch gestures by pointer count, movement, and hold time', () => {
    expect(classifyTouchGesture({ pointerCount: 2 })).toBe('pinch');
    expect(classifyTouchGesture({ pointerCount: 1, movedPx: 30, elapsedMs: 120 })).toBe('drag');
    expect(classifyTouchGesture({ pointerCount: 1, movedPx: 3, elapsedMs: 600 })).toBe('longpress');
    expect(classifyTouchGesture({ pointerCount: 1, movedPx: 3, elapsedMs: 120 })).toBe('tap');
  });

  it('distinguishes two-finger pinch from parallel two-finger swipe', () => {
    const start = [{ x: 100, y: 200 }, { x: 200, y: 200 }];
    const apart = [{ x: 60, y: 200 }, { x: 240, y: 200 }];
    const shifted = [{ x: -20, y: 200 }, { x: 80, y: 200 }];

    expect(classifyTwoFinger(start, apart)).toBe('pinch');
    expect(classifyTwoFinger(start, shifted)).toBe('swipe');
    expect(classifyTwoFinger(start, [{ x: 102, y: 200 }, { x: 202, y: 200 }])).toBeNull();
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
});
