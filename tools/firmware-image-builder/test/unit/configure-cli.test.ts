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
});
