import { describe, expect, it } from 'vitest';
import { pixelToTime, wheelZoomFactor } from '../useChartMouseInteractions';

describe('chart mouse mapping', () => {
  it('maps a pixel x within the plot to a timestamp in the viewport', () => {
    const t = pixelToTime({ left: 100, width: 400 }, { fromMs: 0, toMs: 1000 }, 300);
    expect(t).toBeCloseTo(500, 5);
  });
  it('wheel up (negative deltaY) zooms in (factor < 1)', () => {
    expect(wheelZoomFactor(-100)).toBeLessThan(1);
    expect(wheelZoomFactor(100)).toBeGreaterThan(1);
  });
});
