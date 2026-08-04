import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { createCommandExecutor } from '../../runner/src/command-executor.js';

describe('command executor aborts', () => {
  it('terminates a running child and rejects with the absolute-deadline reason', async () => {
    const controller = new AbortController();
    const reason = new Error('request deadline exceeded');
    const startedAt = performance.now();
    const execution = createCommandExecutor().run(['/usr/bin/sleep', '5'], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      timeoutMs: 250,
      abortSignal: controller.signal,
    });

    setTimeout(() => controller.abort(reason), 20);

    await expect(execution).rejects.toBe(reason);
    expect(performance.now() - startedAt).toBeLessThan(200);
  });

  it('force-kills a child that ignores the cooperative abort signal', async () => {
    const controller = new AbortController();
    const reason = new Error('request deadline exceeded');
    const startedAt = performance.now();
    const execution = createCommandExecutor().run([
      process.execPath,
      '-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      timeoutMs: 5_000,
      abortSignal: controller.signal,
    });

    setTimeout(() => controller.abort(reason), 50);

    await expect(execution).rejects.toBe(reason);
    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2_000);
  });
});
