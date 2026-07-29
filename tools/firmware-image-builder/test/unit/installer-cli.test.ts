import { describe, expect, it, vi } from 'vitest';

import { runInstallerCoreCli } from '../../installer/production.js';

describe('installer core CLI', () => {
  it('accepts only the explicit core marker and does not prepare on invalid argv', async () => {
    const install = vi.fn();
    const stderr: string[] = [];

    await expect(runInstallerCoreCli([], {
      install,
      writeStdout: () => undefined,
      writeStderr: (value) => stderr.push(value),
    })).resolves.toBe(2);
    await expect(runInstallerCoreCli(['--core', 'extra'], {
      install,
      writeStdout: () => undefined,
      writeStderr: (value) => stderr.push(value),
    })).resolves.toBe(2);

    expect(install).not.toHaveBeenCalled();
    expect(stderr).toEqual([
      'installer core requires exactly --core\n',
      'installer core requires exactly --core\n',
    ]);
  });

  it('runs one production installation and emits bounded structured success', async () => {
    const stdout: string[] = [];
    const install = vi.fn(async () => ({
      available: true as const,
      packageVersion: '0.1.0',
      reference: `registry.example.invalid/osi-builder@sha256:${'a'.repeat(64)}`,
    }));

    await expect(runInstallerCoreCli(['--core'], {
      install,
      writeStdout: (value) => stdout.push(value),
      writeStderr: () => undefined,
    })).resolves.toBe(0);

    expect(install).toHaveBeenCalledTimes(1);
    expect(stdout).toEqual([
      `${JSON.stringify({
        available: true,
        packageVersion: '0.1.0',
        reference: `registry.example.invalid/osi-builder@sha256:${'a'.repeat(64)}`,
      })}\n`,
    ]);
  });

  it('returns nonzero with a single-line bounded error and no success output', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(runInstallerCoreCli(['--core'], {
      install: async () => {
        throw new Error(`validation failed\n${'x'.repeat(4_000)}`);
      },
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
    })).resolves.toBe(1);

    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/^installer failed: validation failed x+/u);
    expect(stderr[0]!.slice(0, -1)).not.toContain('\n');
    expect(Buffer.byteLength(stderr[0]!, 'utf8')).toBeLessThanOrEqual(1_024);
    expect(stderr[0]).toMatch(/\n$/u);
  });
});
