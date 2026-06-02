import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  anchorRatioForPoint,
  applyDragPan,
  applyPinchZoom,
  classifyTwoFinger,
  classifyTouchGesture,
  distance,
  midpoint,
  swipeDirection,
  timestampAtSurfaceRatio,
  type Point,
} from './gestureModel';
import { createDefaultTimeViewport, type HistoryTimeViewport } from './useTimeViewport';
import type { HistoryRangeLabel, HistoryViewMode } from './types';

const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DISTANCE_PX = 20;
const LONG_PRESS_MS = 500;
const LONG_PRESS_CANCEL_MOVEMENT_PX = 10;
const EDGE_GUTTER_PX = 24;

interface InspectSelection {
  timestamp: string;
}

interface UseVisualizationGesturesInput {
  viewport: HistoryTimeViewport;
  defaultRange: HistoryRangeLabel;
  activeView?: HistoryViewMode;
  isZoomed?: boolean;
  onViewportChange: (viewport: HistoryTimeViewport) => void;
  onInspect?: (selection: InspectSelection) => void;
  onCardSwipe?: (delta: -1 | 1) => void;
  onViewSwipe?: (delta: -1 | 1) => void;
  onMonthSwipe?: (delta: -1 | 1) => void;
}

interface TapState {
  timeMs: number;
  point: Point;
}

interface ActiveGestureState {
  startPoint: Point;
  currentPoint: Point;
  startPoints: Point[];
  currentPoints: Point[];
  startTimeMs: number;
  dragBaseline: Point;
  surfaceLeft: number;
  surfaceWidth: number;
  previousPinchDistancePx: number | null;
  didPan: boolean;
  didPinch: boolean;
  didTwoFingerSwipe: boolean;
  didLongPress: boolean;
  longPressTimerId: number | null;
}

function touchPoints(touches: TouchList | Touch[]): Point[] {
  return Array.from(touches).map((touch) => ({ x: touch.clientX, y: touch.clientY }));
}

export function useVisualizationGestures({
  viewport,
  defaultRange,
  activeView = 'line-chart',
  isZoomed = viewport.range.label === 'custom',
  onViewportChange,
  onInspect,
  onCardSwipe,
  onViewSwipe,
  onMonthSwipe,
}: UseVisualizationGesturesInput) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const viewportRef = useRef(viewport);
  const defaultRangeRef = useRef(defaultRange);
  const activeViewRef = useRef(activeView);
  const isZoomedRef = useRef(isZoomed);
  const onViewportChangeRef = useRef(onViewportChange);
  const onInspectRef = useRef(onInspect);
  const onCardSwipeRef = useRef(onCardSwipe);
  const onViewSwipeRef = useRef(onViewSwipe);
  const onMonthSwipeRef = useRef(onMonthSwipe);
  const activeGestureRef = useRef<ActiveGestureState | null>(null);
  const lastTapRef = useRef<TapState | null>(null);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    defaultRangeRef.current = defaultRange;
  }, [defaultRange]);

  useEffect(() => {
    activeViewRef.current = activeView;
  }, [activeView]);

  useEffect(() => {
    isZoomedRef.current = isZoomed;
  }, [isZoomed]);

  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);

  useEffect(() => {
    onInspectRef.current = onInspect;
  }, [onInspect]);

  useEffect(() => {
    onCardSwipeRef.current = onCardSwipe;
  }, [onCardSwipe]);

  useEffect(() => {
    onViewSwipeRef.current = onViewSwipe;
  }, [onViewSwipe]);

  useEffect(() => {
    onMonthSwipeRef.current = onMonthSwipe;
  }, [onMonthSwipe]);

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
        startPoints: points,
        currentPoints: points,
        startTimeMs: Date.now(),
        dragBaseline: firstPoint,
        surfaceLeft: bounds.left,
        surfaceWidth: bounds.width,
        previousPinchDistancePx: points.length >= 2 ? distance(points[0], points[1]) : null,
        didPan: false,
        didPinch: false,
        didTwoFingerSwipe: false,
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
        const anchorPoint = midpoint(points[0], points[1]);
        state.currentPoint = anchorPoint;
        state.currentPoints = points;

        const twoFingerGesture = classifyTwoFinger(state.startPoints, points);
        if (twoFingerGesture === 'swipe') {
          state.didTwoFingerSwipe = true;
          return;
        }

        const nextDistancePx = distance(points[0], points[1]);
        const previousDistancePx = state.previousPinchDistancePx ?? nextDistancePx;
        state.previousPinchDistancePx = nextDistancePx;

        if (twoFingerGesture === 'pinch') {
          const nextViewport = applyPinchZoom(viewportRef.current, {
            previousDistancePx,
            nextDistancePx,
            anchorRatio: anchorRatioForPoint(anchorPoint.x, state.surfaceLeft, state.surfaceWidth),
          });

          state.didPinch = true;
          if (nextViewport !== viewportRef.current) {
            publishViewport(nextViewport);
          }
        }
        return;
      }

      const nextPoint = points[0];
      state.currentPoint = nextPoint;
      state.currentPoints = points;

      if (distance(state.startPoint, nextPoint) > LONG_PRESS_CANCEL_MOVEMENT_PX) {
        clearLongPress();
      }

      if (!isZoomedRef.current || activeViewRef.current === 'calendar') return;

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
      const isTwoFinger = state.startPoints.length >= 2;
      const dx = state.currentPoint.x - state.startPoint.x;
      const dy = state.currentPoint.y - state.startPoint.y;
      const axis = swipeDirection({ dx, dy });
      const elapsedMs = Date.now() - state.startTimeMs;
      const movedPx = distance(state.startPoint, state.currentPoint);
      const gesture = classifyTouchGesture({ pointerCount: isTwoFinger ? 2 : 1, movedPx, elapsedMs });

      if (isTwoFinger) {
        const twoFingerGesture = classifyTwoFinger(state.startPoints, state.currentPoints);
        if (!state.didPinch && (twoFingerGesture === 'swipe' || state.didTwoFingerSwipe)) {
          const startMidpoint = midpoint(state.startPoints[0], state.startPoints[1]);
          const currentMidpoint = midpoint(state.currentPoints[0], state.currentPoints[1]);
          const midDx = currentMidpoint.x - startMidpoint.x;
          onCardSwipeRef.current?.(midDx < 0 ? -1 : 1);
        }
      } else if (!state.didPan && !state.didLongPress && axis) {
        if (axis === 'vertical') {
          onViewSwipeRef.current?.(dy < 0 ? -1 : 1);
        } else if (
          activeViewRef.current === 'calendar'
          && state.startPoint.x - state.surfaceLeft >= EDGE_GUTTER_PX
          && state.surfaceLeft + state.surfaceWidth - state.startPoint.x >= EDGE_GUTTER_PX
        ) {
          onMonthSwipeRef.current?.(dx < 0 ? -1 : 1);
        }
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
