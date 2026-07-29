import { describe, expect, it, vi } from 'vitest';

import { createDispatchingApiProcess } from '../../api/src/dispatching-process.js';
import type { ApiProcessStartResult } from '../../api/src/main.js';

const STARTED: ApiProcessStartResult = Object.freeze({
  port: 43120,
  freshnessSocketPath: '/state/api.sock',
  startup: Object.freeze({ dispatched: true, blockers: Object.freeze([]) }),
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe('production queue pump', () => {
  it('dispatches queued work and periodically reruns startup reconciliation', async () => {
    const processStart = vi.fn(async () => STARTED);
    const processStop = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => ({ blockers: [] }));
    const reconcile = vi.fn(async () => ({ dispatched: true, blockers: [] }));
    const errors: unknown[] = [];
    const process = createDispatchingApiProcess({
      process: { start: processStart, stop: processStop },
      bootstrap: { start: async () => STARTED.startup, reconcile, dispatch },
      dispatchIntervalMs: 5,
      reconciliationIntervalMs: 15,
      reportError: (error) => errors.push(error),
    });

    await expect(process.start()).resolves.toBe(STARTED);
    await delay(38);
    await process.stop();

    expect(processStart).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls.length).toBeGreaterThan(0);
    expect(reconcile.mock.calls.length).toBeGreaterThan(0);
    expect(processStop).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

  it('serializes dispatch work and reports errors without stopping later ticks', async () => {
    let active = 0;
    let maximumActive = 0;
    const errors: unknown[] = [];
    const dispatch = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await delay(8);
      active -= 1;
      if (dispatch.mock.calls.length === 1) throw new Error('first dispatch failed');
      return { blockers: [] };
    });
    const process = createDispatchingApiProcess({
      process: { start: async () => STARTED, stop: async () => undefined },
      bootstrap: {
        start: async () => ({ dispatched: true, blockers: [] }),
        reconcile: async () => ({ dispatched: true, blockers: [] }),
        dispatch,
      },
      dispatchIntervalMs: 3,
      reconciliationIntervalMs: 30,
      reportError: (error) => errors.push(error),
    });

    await process.start();
    await delay(28);
    await process.stop();

    expect(maximumActive).toBe(1);
    expect(dispatch.mock.calls.length).toBeGreaterThan(1);
    expect(errors).toHaveLength(1);
  });
});
