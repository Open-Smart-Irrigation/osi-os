import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { BUILD_OUTPUT_TAIL_BYTES, runStreamingBuild } from '../support/run-streaming-build.js';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  readonly closeOnTerm: boolean;

  constructor(closeOnTerm: boolean) {
    super();
    this.closeOnTerm = closeOnTerm;
  }

  kill(signal: string): boolean {
    this.signals.push(signal);
    if (signal === 'SIGTERM' && this.closeOnTerm) setTimeout(() => this.emit('close', null, signal), 0);
    if (signal === 'SIGKILL') setTimeout(() => this.emit('close', null, signal), 0);
    return true;
  }
}

describe('streaming build process lifecycle', () => {
  it('awaits graceful close before rejecting a timeout', async () => {
    const child = new FakeChild(true);
    const promise = runStreamingBuild(['build'], '/tmp', { timeoutMs: 5, graceMs: 20, spawnProcess: () => child as unknown as ReturnType<typeof import('node:child_process').spawn> });
    await expect(promise).rejects.toThrow(/timed out after 5ms/u);
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('escalates to SIGKILL and settles once when graceful close does not arrive', async () => {
    const child = new FakeChild(false);
    child.stdout.write('x'.repeat(BUILD_OUTPUT_TAIL_BYTES + 10));
    const promise = runStreamingBuild(['build'], '/tmp', { timeoutMs: 5, graceMs: 5, spawnProcess: () => child as unknown as ReturnType<typeof import('node:child_process').spawn> });
    await expect(promise).rejects.toThrow(/timed out after 5ms/u);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
