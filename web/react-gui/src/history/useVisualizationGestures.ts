import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  anchorRatioForPoint,
  applyDragPan,
  applyPinchZoom,
  classifyTouchGesture,
  distance,
  midpoint,
  swipeDirection,
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

type SwipeAxis = 'horizontal' | 'vertical';

interface UseVisualizationGesturesInput {
  viewport: HistoryTimeViewport;
  defaultRange: HistoryRangeLabel;
  onViewportChange: (viewport: HistoryTimeViewport) => void;
  onInspect?: (selection: InspectSelection) => void;
  onSwipe?: (direction: SwipeAxis, signedDelta: number) => void;
}

interface TapState {
  timeMs: number;
  point: Point;
}

interface ActiveGestureState {
  startPoint: Point;
  currentPoint: Point;
  startTimeMs: number;
  dragBaseline: Point;
  surfaceLeft: number;
  surfaceWidth: number;
  previousPinchDistancePx: number | null;
  didPan: boolean;
  didPinch: boolean;
  didLongPress: boolean;
  longPressTimerId: number | null;
}

function touchPoints(touches: TouchList | Touch[]): Point[] {
  return Array.from(touches).map((touch) => ({ x: touch.clientX, y: touch.clientY }));
}

function viewportDurationMs(viewport: HistoryTimeViewport): number | null {
  const fromMs = viewport.range.from ? Date.parse(viewport.range.from) : NaN;
  const toMs = viewport.range.to ? Date.parse(viewport.range.to) : NaN;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
  return toMs - fromMs;
}

function isZoomedIn(viewport: HistoryTimeViewport, defaultRange: HistoryRangeLabel): boolean {
  const currentMs = viewportDurationMs(viewport);
  const defaultMs = viewportDurationMs(
    createDefaultTimeViewport(defaultRange, new Date(), viewport.range.timezone),
  );
  if (currentMs === null || defaultMs === null) return viewport.range.label === 'custom';
  return currentMs < defaultMs * 0.98;
}

export function useVisualizationGestures({
  viewport,
  defaultRange,
  onViewportChange,
  onInspect,
  onSwipe,
}: UseVisualizationGesturesInput) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const viewportRef = useRef(viewport);
  const defaultRangeRef = useRef(defaultRange);
  const onViewportChangeRef = useRef(onViewportChange);
  const onInspectRef = useRef(onInspect);
  const onSwipeRef = useRef(onSwipe);
  const activeGestureRef = useRef<ActiveGestureState | null>(null);
  const lastTapRef = useRef<TapState | null>(null);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    defaultRangeRef.current = defaultRange;
  }, [defaultRange]);

  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);

  useEffect(() => {
    onInspectRef.current = onInspect;
  }, [onInspect]);

  useEffect(() => {
    onSwipeRef.current = onSwipe;
  }, [onSwipe]);

  const clearLongPress = useCallback(() => {
    const activeGesture = activeGestureRef.current;
    if (!activeGesture?.longPressTimerId) return;
    window.clearTimeout(activeGesture.longPressTimerId);
    activeGesture.longPressTimerId = null;
  }, []);

  const publishViewport = useCallback((nextViewport: HistoryTimeViewport) => {
    viewportRef.current = nextViewport;
    onViewportChangeRef.current(nextViewport);
  }, []);

  const resetViewport = useCallback(() => {
    publishViewport(
      createDefaultTimeViewport(defaultRangeRef.current, new Date(), viewportRef.current.range.timezone),
    );
  }, [publishViewport]);

  const maybeResetForDoubleTap = useCallback((point: Point): boolean => {
    const lastTap = lastTapRef.current;
    if (!lastTap) return false;
    const isDoubleTap =
      Date.now() - lastTap.timeMs <= DOUBLE_TAP_MS &&
      distance(lastTap.point, point) <= DOUBLE_TAP_DISTANCE_PX;
    if (!isDoubleTap) return false;

    lastTapRef.current = null;
    clearLongPress();
    activeGestureRef.current = null;
    resetViewport();
    return true;
  }, [clearLongPress, resetViewport]);

  useEffect(() => {
    if (!element) return undefined;

    const startLongPressTimer = (state: ActiveGestureState) => {
      state.longPressTimerId = window.setTimeout(() => {
        const activeGesture = activeGestureRef.current;
        if (!activeGesture || activeGesture.didPan || activeGesture.didPinch) return;
        const movedPx = distance(activeGesture.startPoint, activeGesture.currentPoint);
        if (classifyTouchGesture({ pointerCount: 1, movedPx, elapsedMs: LONG_PRESS_MS }) !== 'longpress') {
          return;
        }

        const timestamp = timestampAtSurfaceRatio(
          viewportRef.current,
          anchorRatioForPoint(activeGesture.startPoint.x, activeGesture.surfaceLeft, activeGesture.surfaceWidth),
        );
        activeGesture.didLongPress = true;
        activeGesture.longPressTimerId = null;
        lastTapRef.current = null;
        onInspectRef.current?.({ timestamp });
      }, LONG_PRESS_MS);
    };

    const onTouchStart = (event: TouchEvent) => {
      const points = touchPoints(event.touches);
      if (points.length === 0) return;

      const bounds = element.getBoundingClientRect();
      const firstPoint = points[0];
      if (points.length === 1 && maybeResetForDoubleTap(firstPoint)) return;

      clearLongPress();
      const state: ActiveGestureState = {
        startPoint: firstPoint,
        currentPoint: firstPoint,
        startTimeMs: Date.now(),
        dragBaseline: firstPoint,
        surfaceLeft: bounds.left,
        surfaceWidth: bounds.width,
        previousPinchDistancePx: points.length >= 2 ? distance(points[0], points[1]) : null,
        didPan: false,
        didPinch: points.length >= 2,
        didLongPress: false,
        longPressTimerId: null,
      };
      activeGestureRef.current = state;

      if (points.length === 1) {
        startLongPressTimer(state);
      }
    };

    const onTouchMove = (event: TouchEvent) => {
      const state = activeGestureRef.current;
      const points = touchPoints(event.touches);
      if (!state || points.length === 0) return;

      event.preventDefault();

      if (points.length >= 2) {
        clearLongPress();
        const nextDistancePx = distance(points[0], points[1]);
        const previousDistancePx = state.previousPinchDistancePx ?? nextDistancePx;
        const anchorPoint = midpoint(points[0], points[1]);
        const nextViewport = applyPinchZoom(viewportRef.current, {
          previousDistancePx,
          nextDistancePx,
          anchorRatio: anchorRatioForPoint(anchorPoint.x, state.surfaceLeft, state.surfaceWidth),
        });

        state.currentPoint = anchorPoint;
        state.previousPinchDistancePx = nextDistancePx;
        state.didPinch = true;

        if (nextViewport !== viewportRef.current) {
          publishViewport(nextViewport);
        }
        return;
      }

      const nextPoint = points[0];
      state.currentPoint = nextPoint;

      if (distance(state.startPoint, nextPoint) > LONG_PRESS_CANCEL_MOVEMENT_PX) {
        clearLongPress();
      }

      if (!isZoomedIn(viewportRef.current, defaultRangeRef.current)) return;

      const nextViewport = applyDragPan(viewportRef.current, {
        surfaceWidthPx: state.surfaceWidth,
        deltaXPx: nextPoint.x - state.dragBaseline.x,
      });

      if (nextViewport !== viewportRef.current) {
        state.didPan = true;
        clearLongPress();
        state.dragBaseline = nextPoint;
        publishViewport(nextViewport);
      }
    };

    const onTouchEnd = () => {
      const state = activeGestureRef.current;
      if (!state) return;

      clearLongPress();
      const dx = state.currentPoint.x - state.startPoint.x;
      const dy = state.currentPoint.y - state.startPoint.y;
      const axis = swipeDirection({ dx, dy });
      const elapsedMs = Date.now() - state.startTimeMs;
      const movedPx = distance(state.startPoint, state.currentPoint);
      const gesture = classifyTouchGesture({ pointerCount: state.didPinch ? 2 : 1, movedPx, elapsedMs });

      if (!state.didPan && !state.didPinch && !state.didLongPress && axis) {
        onSwipeRef.current?.(axis, axis === 'horizontal' ? dx : dy);
      }

      if (gesture === 'tap' && !state.didLongPress) {
        lastTapRef.current = { timeMs: Date.now(), point: state.currentPoint };
      } else {
        lastTapRef.current = null;
      }

      activeGestureRef.current = null;
    };

    const onTouchCancel = () => {
      clearLongPress();
      activeGestureRef.current = null;
    };

    element.addEventListener('touchstart', onTouchStart);
    element.addEventListener('touchmove', onTouchMove, { passive: false });
    element.addEventListener('touchend', onTouchEnd);
    element.addEventListener('touchcancel', onTouchCancel);

    return () => {
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchCancel);
      clearLongPress();
    };
  }, [clearLongPress, element, maybeResetForDoubleTap, publishViewport]);

  const onDoubleClick = useCallback(() => {
    resetViewport();
  }, [resetViewport]);

  return {
    ref: setElement,
    onDoubleClick,
    style: { touchAction: 'none' } satisfies CSSProperties,
  };
}
