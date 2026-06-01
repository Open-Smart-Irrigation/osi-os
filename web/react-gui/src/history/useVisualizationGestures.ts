import { useCallback, useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import {
  anchorRatioForPoint,
  applyDragPan,
  applyPinchZoom,
  distance,
  midpoint,
  timestampAtSurfaceRatio,
  type Point,
} from './gestureModel';
import { createDefaultTimeViewport, type HistoryTimeViewport } from './useTimeViewport';
import type { HistoryRangeLabel } from './types';

const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DISTANCE_PX = 20;
const LONG_PRESS_MS = 500;
const LONG_PRESS_CANCEL_MOVEMENT_PX = 10;

interface InspectSelection {
  timestamp: string;
}

interface UseVisualizationGesturesInput {
  viewport: HistoryTimeViewport;
  defaultRange: HistoryRangeLabel;
  onViewportChange: (viewport: HistoryTimeViewport) => void;
  onInspect?: (selection: InspectSelection) => void;
}

interface PinchState {
  distancePx: number;
}

interface LongPressState {
  pointerId: number;
  startedAtMs: number;
  point: Point;
  surfaceLeft: number;
  surfaceWidth: number;
  timerId: number;
}

interface TapState {
  timeMs: number;
  point: Point;
}

export function useVisualizationGestures({
  viewport,
  defaultRange,
  onViewportChange,
  onInspect,
}: UseVisualizationGesturesInput) {
  const activePointersRef = useRef(new Map<number, Point>());
  const viewportRef = useRef(viewport);
  const onViewportChangeRef = useRef(onViewportChange);
  const onInspectRef = useRef(onInspect);
  const pinchStateRef = useRef<PinchState | null>(null);
  const longPressStateRef = useRef<LongPressState | null>(null);
  const lastTapRef = useRef<TapState | null>(null);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);

  useEffect(() => {
    onInspectRef.current = onInspect;
  }, [onInspect]);

  const clearLongPress = useCallback(() => {
    if (!longPressStateRef.current) return;
    window.clearTimeout(longPressStateRef.current.timerId);
    longPressStateRef.current = null;
  }, []);

  useEffect(() => clearLongPress, [clearLongPress]);

  const publishViewport = useCallback((nextViewport: HistoryTimeViewport) => {
    viewportRef.current = nextViewport;
    onViewportChangeRef.current(nextViewport);
  }, []);

  const resetViewport = useCallback(() => {
    publishViewport(createDefaultTimeViewport(defaultRange, new Date(), viewportRef.current.range.timezone));
  }, [defaultRange, publishViewport]);

  const maybeResetForDoubleTap = useCallback((point: Point): boolean => {
    const previousTap = lastTapRef.current;
    if (!previousTap) return false;

    const isDoubleTap =
      Date.now() - previousTap.timeMs <= DOUBLE_TAP_MS &&
      distance(previousTap.point, point) <= DOUBLE_TAP_DISTANCE_PX;

    if (!isDoubleTap) return false;

    lastTapRef.current = null;
    clearLongPress();
    resetViewport();
    return true;
  }, [clearLongPress, resetViewport]);

  const updatePinchState = useCallback((currentTarget: EventTarget & HTMLElement) => {
    const activePointers = Array.from(activePointersRef.current.values());
    if (activePointers.length !== 2) {
      pinchStateRef.current = null;
      return;
    }

    const [first, second] = activePointers;
    const nextDistancePx = distance(first, second);
    const previousDistancePx = pinchStateRef.current?.distancePx ?? nextDistancePx;
    const bounds = currentTarget.getBoundingClientRect();
    const anchorPoint = midpoint(first, second);
    const nextViewport = applyPinchZoom(viewportRef.current, {
      previousDistancePx,
      nextDistancePx,
      anchorRatio: anchorRatioForPoint(anchorPoint.x, bounds.left, bounds.width),
    });

    if (nextViewport !== viewportRef.current) {
      publishViewport(nextViewport);
      pinchStateRef.current = { distancePx: nextDistancePx };
      return;
    }

    if (!pinchStateRef.current) {
      pinchStateRef.current = { distancePx: nextDistancePx };
    }
  }, [publishViewport]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const point: Point = { x: event.clientX, y: event.clientY };
    const activePointers = activePointersRef.current;
    const wasIdle = activePointers.size === 0;

    event.currentTarget.setPointerCapture(event.pointerId);

    if (wasIdle && maybeResetForDoubleTap(point)) {
      activePointers.clear();
      return;
    }

    activePointers.set(event.pointerId, point);

    if (activePointers.size === 1) {
      const bounds = event.currentTarget.getBoundingClientRect();
      clearLongPress();
      const timerId = window.setTimeout(() => {
        const state = longPressStateRef.current;
        if (!state || state.pointerId !== event.pointerId) return;
        const timestamp = timestampAtSurfaceRatio(
          viewportRef.current,
          anchorRatioForPoint(state.point.x, state.surfaceLeft, state.surfaceWidth),
        );
        longPressStateRef.current = null;
        onInspectRef.current?.({ timestamp });
      }, LONG_PRESS_MS);

      longPressStateRef.current = {
        pointerId: event.pointerId,
        startedAtMs: Date.now(),
        point,
        surfaceLeft: bounds.left,
        surfaceWidth: bounds.width,
        timerId,
      };
      return;
    }

    clearLongPress();
    updatePinchState(event.currentTarget);
  }, [clearLongPress, maybeResetForDoubleTap, updatePinchState]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const activePointers = activePointersRef.current;
    const previousPoint = activePointers.get(event.pointerId);
    if (!previousPoint) return;

    const nextPoint: Point = { x: event.clientX, y: event.clientY };

    if (longPressStateRef.current?.pointerId === event.pointerId) {
      const movedPx = distance(longPressStateRef.current.point, nextPoint);
      if (movedPx > LONG_PRESS_CANCEL_MOVEMENT_PX) {
        clearLongPress();
      }
    }

    activePointers.set(event.pointerId, nextPoint);

    if (activePointers.size === 1) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const nextViewport = applyDragPan(viewportRef.current, {
        surfaceWidthPx: bounds.width,
        deltaXPx: nextPoint.x - previousPoint.x,
      });

      if (nextViewport !== viewportRef.current) {
        publishViewport(nextViewport);
      }
      return;
    }

    if (activePointers.size === 2) {
      clearLongPress();
      updatePinchState(event.currentTarget);
    }
  }, [clearLongPress, publishViewport, updatePinchState]);

  const finishPointer = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const activePointers = activePointersRef.current;
    const previousPoint = activePointers.get(event.pointerId);
    activePointers.delete(event.pointerId);

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The browser may already have released capture during cancellation.
    }

    if (longPressStateRef.current?.pointerId === event.pointerId) {
      clearLongPress();
    }

    if (activePointers.size < 2) {
      pinchStateRef.current = null;
    }

    if (activePointers.size === 0 && previousPoint) {
      lastTapRef.current = { timeMs: Date.now(), point: previousPoint };
    }
  }, [clearLongPress]);

  const onDoubleClick = useCallback(() => {
    clearLongPress();
    resetViewport();
  }, [clearLongPress, resetViewport]);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: finishPointer,
    onPointerCancel: finishPointer,
    onDoubleClick,
    style: { touchAction: 'none' } satisfies CSSProperties,
  };
}
