import type { CDPSession } from '@playwright/test';

export interface TouchPoint { id: number; x: number; y: number }
export type TouchEventType = 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel';
export interface TouchStep { type: TouchEventType; touchPoints: readonly TouchPoint[]; pauseMs?: number }
export interface PlotRect { left: number; top: number; width: number; height: number }
export type Axis = 'horizontal' | 'vertical';

const point = (id: number, x: number, y: number): TouchPoint => ({ id, x, y });
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export async function dispatchTouchSequence(cdp: CDPSession, steps: readonly TouchStep[]): Promise<void> {
  for (const step of steps) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: step.type,
      touchPoints: step.touchPoints.map((p) => ({ ...p, radiusX: 1, radiusY: 1, force: 1 })),
      modifiers: 0,
    });
    if ((step.pauseMs ?? 0) > 0) await new Promise((resolve) => setTimeout(resolve, step.pauseMs));
  }
}

export function panPoints(rect: PlotRect, options: {
  fromX: number; toX: number; y?: number; steps: number; pauseMs?: number;
}): TouchStep[] {
  const y = rect.top + (options.y ?? rect.height / 2);
  const result: TouchStep[] = [];
  for (let index = 0; index <= options.steps; index += 1) {
    const p = point(1, rect.left + lerp(options.fromX, options.toX, index / options.steps), y);
    result.push({ type: index === 0 ? 'touchStart' : 'touchMove', touchPoints: [p], pauseMs: options.pauseMs ?? 16 });
  }
  result.push({ type: 'touchEnd', touchPoints: [] });
  return result;
}

export function pinchPoints(rect: PlotRect, options: {
  startGap: number; endGap: number;
  startCenterFraction: number; endCenterFraction: number;
  axis?: Axis; steps: number; pauseMs?: number;
}): TouchStep[] {
  const axis = options.axis ?? 'horizontal';
  const result: TouchStep[] = [];
  for (let index = 0; index <= options.steps; index += 1) {
    const t = index / options.steps;
    const gap = lerp(options.startGap, options.endGap, t);
    const cx = rect.left + rect.width * lerp(options.startCenterFraction, options.endCenterFraction, t);
    const cy = rect.top + rect.height / 2;
    const points = axis === 'horizontal'
      ? [point(1, cx - gap / 2, cy), point(2, cx + gap / 2, cy)]
      : [point(1, cx, cy - gap / 2), point(2, cx, cy + gap / 2)];
    result.push({ type: index === 0 ? 'touchStart' : 'touchMove', touchPoints: points, pauseMs: options.pauseMs ?? 16 });
  }
  result.push({ type: 'touchEnd', touchPoints: [] });
  return result;
}

export interface PartialLiftPhases {
  initialPan: TouchStep[];
  spread: TouchStep[];
  release: TouchStep[];
  remainingPan: TouchStep[];
  remainingId: 1 | 2;
  releaseId: 1 | 2;
}

export function partialLiftPhases(rect: PlotRect, releaseId: 1 | 2): PartialLiftPhases {
  const remainingId = releaseId === 1 ? 2 : 1;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const atGap = (id: 1 | 2, gap: number) => point(id, cx + (id === 1 ? -gap / 2 : gap / 2), cy);
  const panEnd = atGap(remainingId, 80);
  const panStart = point(remainingId, panEnd.x - 30, cy);
  const initialPan: TouchStep[] = [];
  for (let index = 0; index <= 6; index += 1) {
    const p = point(remainingId, lerp(panStart.x, panEnd.x, index / 6), cy);
    initialPan.push({ type: index === 0 ? 'touchStart' : 'touchMove', touchPoints: [p], pauseMs: 16 });
  }
  const spread: TouchStep[] = [{ type: 'touchStart', touchPoints: [atGap(1, 80), atGap(2, 80)], pauseMs: 16 }];
  for (let index = 1; index <= 10; index += 1) {
    const gap = lerp(80, 160, index / 10);
    spread.push({ type: 'touchMove', touchPoints: [atGap(1, gap), atGap(2, gap)], pauseMs: 16 });
  }
  const released = atGap(releaseId, 160);
  const remaining = atGap(remainingId, 160);
  const remainingPan: TouchStep[] = [];
  for (let index = 1; index <= 10; index += 1) {
    remainingPan.push({
      type: 'touchMove',
      touchPoints: [point(remainingId, remaining.x + 50 * index / 10, cy)],
      pauseMs: 16,
    });
  }
  remainingPan.push({ type: 'touchEnd', touchPoints: [] });
  return {
    initialPan,
    spread,
    // CDP has no changedTouches field. For a partial touchEnd, touchPoints is
    // the released contact. Ending the final contact uses an empty array.
    release: [{ type: 'touchEnd', touchPoints: [released], pauseMs: 16 }],
    remainingPan,
    remainingId,
    releaseId,
  };
}

export function verticalPageSwipe(x: number, fromY: number, toY: number): TouchStep[] {
  const steps: TouchStep[] = [];
  for (let index = 0; index <= 12; index += 1) {
    const p = point(9, x, lerp(fromY, toY, index / 12));
    steps.push({ type: index === 0 ? 'touchStart' : 'touchMove', touchPoints: [p], pauseMs: 16 });
  }
  steps.push({ type: 'touchEnd', touchPoints: [] });
  return steps;
}
