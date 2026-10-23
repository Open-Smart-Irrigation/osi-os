import { describe, expect, it, vi } from 'vitest';
import { startFrameSampler } from '../../src/shared/metrics';

describe('startFrameSampler', () => {
  it('summarizes RAF intervals and cancels once', () => {
    const callbacks: FrameRequestCallback[] = [];
    const cancel = vi.fn();
    const sampler = startFrameSampler((callback) => { callbacks.push(callback); return callbacks.length; }, cancel);
    [0, 16, 34, 70].forEach((time) => callbacks.shift()?.(time));
    const summary = sampler.stop();
    expect(summary).toMatchObject({ sampleCount: 3, meanMs: 70 / 3, p95Ms: 36, maxMs: 36, over16_7: 2, over33_3: 1 });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(sampler.stop()).toEqual(summary);
  });
});
