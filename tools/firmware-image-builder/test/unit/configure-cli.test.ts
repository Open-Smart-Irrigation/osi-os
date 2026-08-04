import { describe, expect, it, vi } from 'vitest';

import { runConfigureCli } from '../../installer/configure.js';

describe('configuration CLI', () => {
  it('requires explicit approved-root and repository paths before configuration', async () => {
    const configure = vi.fn();
    const stderr: string[] = [];
    for (const argv of [
      [],
      ['--approved-root', '/images'],
      ['--repository', '/repo'],
      ['--approved-root', '/images', '--repository', '/repo', 'extra'],
    ]) {
      await expect(runConfigureCli(argv, {
        configure,
        writeStdout: () => undefined,
        writeStderr: (value) => stderr.push(value),
      })).resolves.toBe(2);
    }
    expect(configure).not.toHaveBeenCalled();
    expect(stderr).toHaveLength(4);
  });

  it('passes only the two explicit paths to production configuration', async () => {
    const configure = vi.fn(async () => ({
      approvedOutputRoot: '/canonical/images',
      repositoryPath: '/canonical/repo',
      configPath: '/home/test/.config/osi-image-builder/config.json',
      authorityPath: '/home/test/.local/lib/osi-image-builder/configured-authorities.json',
      versionRoot: '/home/test/.local/lib/osi-image-builder/0.1.0',
    }));
    const stdout: string[] = [];

    await expect(runConfigureCli([
      '--approved-root',
      '/images',
      '--repository',
      '/repo',
    ], {
      configure,
      writeStdout: (value) => stdout.push(value),
      writeStderr: () => undefined,
    })).resolves.toBe(0);

    expect(configure).toHaveBeenCalledWith({
      approvedRoot: '/images',
      repositoryPath: '/repo',
    });
    expect(stdout).toEqual([
      `${JSON.stringify({
        available: true,
        approvedOutputRoot: '/canonical/images',
        repositoryPath: '/canonical/repo',
        configPath: '/home/test/.config/osi-image-builder/config.json',
        authorityPath: '/home/test/.local/lib/osi-image-builder/configured-authorities.json',
        versionRoot: '/home/test/.local/lib/osi-image-builder/0.1.0',
      })}\n`,
    ]);
  });

  it('preserves bounded activation causes and service disposition from aggregate failures', async () => {
    const stderr: string[] = [];
    const activation = new AggregateError([
      new Error('migration blocker rejected the new package'),
      new Error('rollback daemon-reload failed'),
    ], 'configuration activation and rollback failed; service-state=stopped');

    await expect(runConfigureCli([
      '--approved-root',
      '/images',
      '--repository',
      '/repo',
    ], {
      configure: async () => { throw activation; },
      writeStdout: () => undefined,
      writeStderr: (value) => stderr.push(value),
    })).resolves.toBe(1);

    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/service-state=stopped/u);
    expect(stderr[0]).toMatch(/migration blocker rejected the new package/u);
    expect(stderr[0]).toMatch(/rollback daemon-reload failed/u);
    expect(stderr[0]).not.toMatch(/[\r\t]/u);
    expect(Buffer.byteLength(stderr[0] ?? '', 'utf8')).toBeLessThanOrEqual(1_024);
  });

  it('truncates multibyte errors only at complete UTF-8 code-point boundaries', async () => {
    const stderr: string[] = [];

    await expect(runConfigureCli([
      '--approved-root',
      '/images',
      '--repository',
      '/repo',
    ], {
      configure: async () => { throw new Error('\u{1f6a8}'.repeat(1_024)); },
      writeStdout: () => undefined,
      writeStderr: (value) => stderr.push(value),
    })).resolves.toBe(1);

    expect(stderr).toHaveLength(1);
    expect(stderr[0]).not.toContain('\ufffd');
    expect(Buffer.byteLength(stderr[0] ?? '', 'utf8')).toBeLessThanOrEqual(1_024);
  });
});
