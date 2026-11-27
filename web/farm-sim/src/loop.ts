import {frameSlot, FrameQuality, type QualityTier} from './view/quality';

/** Section 12 frame hook. Only the perf probe in src/render-review.ts, loaded by ?perf, sets it. */
export const loopProbe: {frame?: (start: number, end: number, quality: QualityTier) => void} = {};

export function startLoop(frame: (now: number, delta: number, elapsed: number, quality: QualityTier) => void) {
  const quality = new FrameQuality((navigator as Navigator & {deviceMemory?: number}).deviceMemory);
  let start: number | undefined;
  let previous: number | undefined;
  let lastSlot = -1;
  function draw(now: number) {
    start ??= now;
    const elapsed = now - start;
    const slot = frameSlot(elapsed, quality.current);
    if (slot > lastSlot) {
      const before = performance.now();
      frame(now, now - (previous ?? now), elapsed, quality.current);
      previous = now;
      const after = performance.now();
      quality.observe(now, after - before);
      loopProbe.frame?.(before, after, quality.current);
      lastSlot = frameSlot(elapsed, quality.current);
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}
