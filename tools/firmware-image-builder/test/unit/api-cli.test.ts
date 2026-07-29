import { describe, expect, it, vi } from 'vitest';

import { runApiCli } from '../../api/src/cli.js';

describe('API CLI', () => {
  it('accepts no command arguments and starts one production process', async () => {
    const start = vi.fn(async () => ({
      port: 43120,
      freshnessSocketPath: '/tmp/api.sock',
      startup: { dispatched: false, blockers: [] },
    }));
    const create = vi.fn(async () => ({ start, stop: async () => undefined }));

    await expect(runApiCli([], {
      create,
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    })).resolves.toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('rejects command arguments before constructing production state', async () => {
    const create = vi.fn();
    const stderr: string[] = [];
    await expect(runApiCli(['unexpected'], {
      create,
      writeStdout: () => undefined,
      writeStderr: (value) => stderr.push(value),
    })).resolves.toBe(2);
    expect(create).not.toHaveBeenCalled();
    expect(stderr).toEqual(['API accepts no command arguments\n']);
  });

  it('returns nonzero with one bounded line when startup fails', async () => {
    const stderr: string[] = [];
    await expect(runApiCli([], {
      create: async () => ({
        start: async () => { throw new Error(`startup failed\n${'x'.repeat(4_000)}`); },
        stop: async () => undefined,
      }),
      writeStdout: () => undefined,
      writeStderr: (value) => stderr.push(value),
    })).resolves.toBe(1);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]!.slice(0, -1)).not.toContain('\n');
    expect(Buffer.byteLength(stderr[0]!, 'utf8')).toBeLessThanOrEqual(1_024);
  });
});
