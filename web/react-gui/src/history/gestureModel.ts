import {
  panTimeViewportByRatio,
  zoomTimeViewportAtRatio,
  type HistoryTimeViewport,
} from './useTimeViewport';

const PINCH_RATIO_THRESHOLD = 0.08;
const DRAG_DEAD_ZONE_PX = 6;
const LONG_PRESS_MS = 500;
const LONG_PRESS_CANCEL_MOVEMENT_PX = 10;
const SWIPE_THRESHOLD_DEFAULT = 40;
const DRAG_MIN_PX = 8;

export interface Point {
  x: number;
  y: number;
}

export type TouchGesture = 'pinch' | 'drag' | 'longpress' | 'tap';

export interface PinchZoomInput {
  previousDistancePx: number;
  nextDistancePx: number;
  anchorRatio: number;
}

export interface DragPanInput {
  surfaceWidthPx: number;
  deltaXPx: number;
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(Math.max(ratio, 0), 1);
}

function parseViewportRange(viewport: HistoryTimeViewport): { fromMs: number; toMs: number; durationMs: number } | null {
  const fromMs = viewport.range.from ? Date.parse(viewport.range.from) : NaN;
  const toMs = viewport.range.to ? Date.parse(viewport.range.to) : NaN;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
  return { fromMs, toMs, durationMs: toMs - fromMs };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

export function pinchScale(previousDistancePx: number, nextDistancePx: number): number {
  if (previousDistancePx <= 0 || nextDistancePx <= 0) return 1;
  return previousDistancePx / nextDistancePx;
}

export function swipeDirection(
  delta: { dx: number; dy: number },
  threshold = SWIPE_THRESHOLD_DEFAULT,
): 'horizontal' | 'vertical' | null {
  const absX = Math.abs(delta.dx);
  const absY = Math.abs(delta.dy);
  if (Math.max(absX, absY) < threshold) return null;
  return absX >= absY ? 'horizontal' : 'vertical';
}

export function classifyTouchGesture(state: {
  pointerCount: number;
  movedPx?: number;
  elapsedMs?: number;
}): TouchGesture {
  if (state.pointerCount >= 2) return 'pinch';
  const movedPx = state.movedPx ?? 0;
  const elapsedMs = state.elapsedMs ?? 0;
  if (movedPx >= DRAG_MIN_PX) return 'drag';
  if (elapsedMs >= LONG_PRESS_MS && movedPx <= LONG_PRESS_CANCEL_MOVEMENT_PX) return 'longpress';
  return 'tap';
}

export function anchorRatioForPoint(pointX: number, surfaceLeft: number, surfaceWidth: number): number {
  if (!Number.isFinite(surfaceWidth) || surfaceWidth <= 0) return 0;
  return clampRatio((pointX - surfaceLeft) / surfaceWidth);
}

export function applyPinchZoom(
  viewport: HistoryTimeViewport,
  input: PinchZoomInput,
): HistoryTimeViewport {
  if (input.previousDistancePx <= 0 || input.nextDistancePx <= 0) return viewport;

  const scale = pinchScale(input.previousDistancePx, input.nextDistancePx);
  if (!Number.isFinite(scale) || Math.abs(scale - 1) < PINCH_RATIO_THRESHOLD) return viewport;

  return zoomTimeViewportAtRatio(viewport, scale, input.anchorRatio);
}

export function applyDragPan(
  viewport: HistoryTimeViewport,
  input: DragPanInput,
): HistoryTimeViewport {
  if (!Number.isFinite(input.surfaceWidthPx) || input.surfaceWidthPx <= 0) return viewport;
  if (!Number.isFinite(input.deltaXPx) || Math.abs(input.deltaXPx) < DRAG_DEAD_ZONE_PX) return viewport;

  return panTimeViewportByRatio(viewport, -input.deltaXPx / input.surfaceWidthPx);
}

export function timestampAtSurfaceRatio(viewport: HistoryTimeViewport, anchorRatio: number): string {
  const parsedRange = parseViewportRange(viewport);
  if (!parsedRange) return viewport.range.from ?? viewport.range.to ?? new Date(0).toISOString();

  const ratio = clampRatio(anchorRatio);
  return new Date(parsedRange.fromMs + parsedRange.durationMs * ratio).toISOString();
}

export function isLongPress(elapsedMs: number, movedPx: number): boolean {
  return elapsedMs >= LONG_PRESS_MS && movedPx <= LONG_PRESS_CANCEL_MOVEMENT_PX;
}
