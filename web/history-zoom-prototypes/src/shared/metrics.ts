import type { FrameSummary } from './types';

type RequestFrame = (callback: FrameRequestCallback) => number;
type CancelFrame = (handle: number) => void;
type Now = () => number;

export function startFrameSampler(
  requestFrame: RequestFrame = (callback) => window.requestAnimationFrame(callback),
  cancelFrame: CancelFrame = (handle) => window.cancelAnimationFrame(handle),
  now: Now = () => performance.now(),
): { stop(): FrameSummary } {
  const samples: number[] = [];
  let previous: number | undefined;
  let scheduled: number | null = null;
  let stopped = false;
  const tick: FrameRequestCallback = (timestamp) => {
    scheduled = null;
    if (stopped) return;
    const current = Number.isFinite(timestamp) ? timestamp : now();
    if (previous !== undefined) samples.push(Math.max(0, current - previous));
    previous = current;
    scheduled = requestFrame(tick);
  };
  scheduled = requestFrame(tick);
  const summary = (): FrameSummary => {
    if (samples.length === 0) return { sampleCount: 0, meanMs: 0, p95Ms: 0, maxMs: 0, over16_7: 0, over33_3: 0 };
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
    return {
      sampleCount: samples.length,
      meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
      p95Ms: p95,
      maxMs: sorted[sorted.length - 1],
      over16_7: samples.filter((value) => value > 16.7).length,
      over33_3: samples.filter((value) => value > 33.3).length,
    };
  };
  return {
    stop() {
      if (!stopped) {
        stopped = true;
        if (scheduled !== null) cancelFrame(scheduled);
        scheduled = null;
      }
      return summary();
    },
  };
}
