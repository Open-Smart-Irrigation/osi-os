import { describe, expect, it, vi } from 'vitest';

import { runRunnerCli } from '../../runner/src/cli.js';

describe('runner CLI', () => {
  it('passes the exact systemd instance argument to the production runner', async () => {
    const run = vi.fn(async () => ({
      state: 'succeeded' as const,
      buildManifest: {},
      verificationManifest: {},
      blockerCode: null,
    }));

    await expect(runRunnerCli(['job-01'], { run, writeStderr: () => undefined })).resolves.toBe(0);
    expect(run).toHaveBeenCalledWith(['job-01']);
  });

  it('returns nonzero for failed or recovery-required pipeline results', async () => {
    for (const result of [
      { state: 'failed' as const, buildManifest: null, verificationManifest: null, blockerCode: 'BUILD_FAILED' as const },
      { state: 'recovery-required' as const, buildManifest: null, verificationManifest: null, blockerCode: 'RUNNER_DISAPPEARED' as const, reason: 'lost lease' },
    ]) {
      await expect(runRunnerCli(['job-01'], {
        run: async () => result,
        writeStderr: () => undefined,
      })).resolves.toBe(1);
    }
  });

  it('emits one bounded line when production composition throws', async () => {
    const stderr: string[] = [];
    await expect(runRunnerCli(['job-01'], {
      run: async () => { throw new Error(`failed\n${'x'.repeat(4_000)}`); },
      writeStderr: (value) => stderr.push(value),
    })).resolves.toBe(1);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]!.slice(0, -1)).not.toContain('\n');
    expect(Buffer.byteLength(stderr[0]!, 'utf8')).toBeLessThanOrEqual(1_024);
  });
});
