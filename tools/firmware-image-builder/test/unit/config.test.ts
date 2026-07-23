import { execFile as execFileCallback } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigValidationError,
  loadConfig,
  resolveApprovedRoot,
  validateOrigin,
  validateApprovedRoots,
  type RootStats,
} from '../../config/load.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    await import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true }));
  }
});

async function createWorkspace() {
  const directory = await mkdtemp('/tmp/osi-image-builder-config-');
  temporaryDirectories.push(directory);

  const configHome = join(directory, 'config-home');
  const stateHome = join(directory, 'state-home');
  const repositoryPath = join(directory, 'osi-os');
  const outputRoot = join(directory, 'images');
  await mkdir(join(configHome, 'osi-image-builder'), { recursive: true });
  await mkdir(stateHome, { recursive: true });
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(outputRoot, { recursive: true });

  return { directory, configHome, stateHome, repositoryPath, outputRoot };
}

const execFile = promisify(execFileCallback);

function configFor(workspace: Awaited<ReturnType<typeof createWorkspace>>, overrides: Record<string, unknown> = {}) {
  return {
    repositoryPath: workspace.repositoryPath,
    approvedOutputRoots: [
      { id: 'sdcard-images', label: 'SD card images', path: workspace.outputRoot },
    ],
    builderLockPath: '/opt/osi-image-builder/2026.07.22.1/builder.lock.json',
    maxQueueLength: 50,
    diskFreeMinimumBytes: 20 * 1024 ** 3,
    ...overrides,
  };
}

async function writeConfig(workspace: Awaited<ReturnType<typeof createWorkspace>>, value: unknown) {
  await writeFile(
    join(workspace.configHome, 'osi-image-builder', 'config.json'),
    JSON.stringify(value),
  );
}

const ampleDisk = async () => ({ bavail: 30, bsize: 1024 ** 3 });
const sshOrigin = { getOriginUrl: async () => 'git@github.com:Open-Smart-Irrigation/osi-os.git' };
const httpsOrigin = { getOriginUrl: async () => 'https://github.com/example/osi-os.git' };
const cleanGitEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
};

async function initGitRepository(path: string, origin?: string) {
  await execFile('/usr/bin/git', ['init', '--quiet', path], { env: cleanGitEnv });
  if (origin) {
    await execFile('/usr/bin/git', ['-C', path, 'config', '--local', 'remote.origin.url', origin], { env: cleanGitEnv });
  }
}

async function addGitOrigin(path: string, origin: string) {
  await execFile('/usr/bin/git', ['-C', path, 'config', '--local', '--add', 'remote.origin.url', origin], { env: cleanGitEnv });
}

async function snapshotTree(path: string): Promise<unknown> {
  const entries = await readdir(path, { withFileTypes: true });
  return Promise.all(entries.map(async (entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return [entry.name, await snapshotTree(child)];
    const metadata = await lstat(child);
    return [entry.name, metadata.isSymbolicLink() ? 'symlink' : `${metadata.mode}:${metadata.size}`];
  }));
}

function fakeDirectoryStats(overrides: Partial<RootStats> = {}): RootStats {
  return {
    isSymbolicLink: () => false,
    isDirectory: () => true,
    isBlockDevice: () => false,
    uid: process.geteuid?.() ?? -1,
    mode: 0o755,
    ...overrides,
  };
}

describe('builder configuration', () => {
  it('expands XDG paths, validates SSH origin, and returns canonical approved roots', async () => {
    const workspace = await createWorkspace();
    await writeConfig(workspace, configFor(workspace));

    const loaded = await loadConfig({
      env: {
        HOME: homedir(),
        XDG_CONFIG_HOME: workspace.configHome,
        XDG_STATE_HOME: workspace.stateHome,
      },
      git: sshOrigin,
      rootFs: { statfs: ampleDisk },
    });

    expect(loaded.configRoot).toBe(resolve(workspace.configHome, 'osi-image-builder'));
    expect(loaded.stateRoot).toBe(resolve(workspace.stateHome, 'osi-image-builder'));
    expect(loaded.config.repository.path).toBe(resolve(workspace.repositoryPath));
    expect(loaded.config.repository.remote).toBe('origin');
    expect(loaded.config.approvedOutputRoots).toEqual([
      {
        id: 'sdcard-images',
        label: 'SD card images',
        path: resolve(workspace.outputRoot),
        quarantinePath: join(resolve(workspace.outputRoot), '.osi-image-builder', 'quarantine'),
      },
    ]);
    expect(loaded.redacted.approvedOutputRoots).toEqual(loaded.config.approvedOutputRoots);
    expect(loaded.redacted).not.toHaveProperty('originUrl');
  });

  it('rejects unsafe configuration without creating state or quarantine files', async () => {
    const workspace = await createWorkspace();
    await writeConfig(workspace, configFor(workspace));
    const before = await snapshotTree(workspace.directory);

    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      git: httpsOrigin,
      rootFs: { statfs: ampleDisk },
    })).rejects.toMatchObject({ code: 'ORIGIN_NOT_SSH' });

    expect(await snapshotTree(workspace.directory)).toEqual(before);
    await expect(readFile(join(workspace.stateHome, 'osi-image-builder', 'jobs.sqlite'))).rejects.toThrow();
  });

  it.each([
    ['approved root overlaps repository', { approvedOutputRoots: [{ id: 'sdcard-images', label: 'images', path: 'repository' }] }],
    ['approved root overlaps state root', { approvedOutputRoots: [{ id: 'sdcard-images', label: 'images', path: 'state' }] }],
    ['approved roots are equal', { approvedOutputRoots: [{ id: 'a', label: 'a', path: 'images' }, { id: 'b', label: 'b', path: 'images' }] }],
  ])('rejects %s with typed overlap and does not create state', async (_name, override) => {
    const workspace = await createWorkspace();
    const statePath = resolve(workspace.stateHome, 'osi-image-builder');
    const approvedOutputRoots = override.approvedOutputRoots.map((root) => ({
      ...root,
      path: root.path === 'repository' ? workspace.repositoryPath : root.path === 'state' ? workspace.stateHome : workspace.outputRoot,
    }));
    await writeConfig(workspace, configFor(workspace, { approvedOutputRoots }));

    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      git: sshOrigin,
      rootFs: { statfs: ampleDisk },
    })).rejects.toMatchObject({ code: 'OUTPUT_ROOT_OVERLAP' });
    await expect(lstat(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['relative repository path', { repositoryPath: 'osi-os' }, 'REPOSITORY_PATH_NOT_ABSOLUTE'],
    ['short queue', { maxQueueLength: 0 }, 'MAX_QUEUE_INVALID'],
    ['long queue', { maxQueueLength: 51 }, 'MAX_QUEUE_INVALID'],
    ['unversioned builder lock', { builderLockPath: '/opt/osi-image-builder/latest/builder.lock.json' }, 'BUILDER_LOCK_PATH_INVALID'],
  ])('rejects %s', async (_name, overrides, code) => {
    const workspace = await createWorkspace();
    await writeConfig(workspace, configFor(workspace, overrides));

    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      git: sshOrigin,
      rootFs: { statfs: ampleDisk },
    })).rejects.toMatchObject({ code });
  });

  it('rejects unknown configuration keys instead of silently applying defaults', async () => {
    const workspace = await createWorkspace();
    await writeConfig(workspace, configFor(workspace, { maxQueuLength: 50 }));

    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      git: sshOrigin,
      rootFs: { statfs: ampleDisk },
    })).rejects.toMatchObject({ code: 'CONFIG_FILE_INVALID' });
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['non-string', 42],
  ])('rejects %s origin values', (_name, value) => {
    expect(() => validateOrigin(value)).toThrowError(
      expect.objectContaining<Partial<ConfigValidationError>>({ code: 'ORIGIN_NOT_SSH' }),
    );
  });

  it('reads the raw repository-local origin despite ambient Git config and GIT_DIR', async () => {
    const workspace = await createWorkspace();
    const decoyRepository = join(workspace.directory, 'decoy-repository');
    const ambientConfig = join(workspace.directory, 'ambient.gitconfig');
    await mkdir(decoyRepository, { recursive: true });
    await initGitRepository(workspace.repositoryPath, 'https://github.com/example/osi-os.git');
    await initGitRepository(decoyRepository, 'git@github.com:example/decoy.git');
    await writeFile(ambientConfig, '[url "git@github.com:example/rewritten.git"]\n\tinsteadOf = https://github.com/example/\n');
    await writeConfig(workspace, configFor(workspace));
    vi.stubEnv('GIT_DIR', join(decoyRepository, '.git'));
    vi.stubEnv('GIT_CONFIG_GLOBAL', ambientConfig);
    vi.stubEnv('GIT_CONFIG_SYSTEM', ambientConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0');

    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      rootFs: { statfs: ampleDisk },
    })).rejects.toMatchObject({ code: 'ORIGIN_NOT_SSH' });
  });

  it('accepts a single SSH origin through the production Git probe', async () => {
    const workspace = await createWorkspace();
    await initGitRepository(workspace.repositoryPath, 'git@github.com:Open-Smart-Irrigation/osi-os.git');
    await writeConfig(workspace, configFor(workspace));

    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      rootFs: { statfs: ampleDisk },
    })).resolves.toBeDefined();
  });

  it.each([
    ['missing origin', undefined, undefined],
    ['multiple SSH origins', 'git@github.com:one/osi-os.git', 'git@github.com:two/osi-os.git'],
    ['HTTPS first and SSH second', 'https://github.com/example/osi-os.git', 'git@github.com:example/osi-os.git'],
    ['whitespace/local first and SSH second', ' https://github.com/example/osi-os.git ', 'git@github.com:example/osi-os.git'],
    ['empty duplicate', 'git@github.com:example/osi-os.git', ''],
  ])('rejects %s through the production Git probe', async (_name, first, second) => {
    const workspace = await createWorkspace();
    await initGitRepository(workspace.repositoryPath, first);
    if (second !== undefined) await addGitOrigin(workspace.repositoryPath, second);
    await writeConfig(workspace, configFor(workspace));

    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      rootFs: { statfs: ampleDisk },
    })).rejects.toMatchObject({ code: 'ORIGIN_NOT_SSH' });
  });

  it('rejects a whitespace-padded SSH origin through the production Git probe', async () => {
    const workspace = await createWorkspace();
    await initGitRepository(workspace.repositoryPath, ' git@github.com:example/osi-os.git ');
    await writeConfig(workspace, configFor(workspace));

    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      rootFs: { statfs: ampleDisk },
    })).rejects.toMatchObject({ code: 'ORIGIN_NOT_SSH' });
  });

  it('does not expose raw origin probe process errors', async () => {
    const workspace = await createWorkspace();
    await writeConfig(workspace, configFor(workspace));

    const result = loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      git: { getOriginUrl: async () => { throw new Error('secret stderr from git'); } },
      rootFs: { statfs: ampleDisk },
    });
    await expect(result).rejects.toMatchObject({ code: 'ORIGIN_NOT_SSH' });
    await result.catch((error: unknown) => {
      expect(String(error)).not.toContain('secret stderr from git');
    });
  });

  it('rejects a symlinked root, a block-device root, and a root below the free-space threshold', async () => {
    const workspace = await createWorkspace();
    const symlinkPath = join(workspace.directory, 'images-link');
    await symlink(workspace.outputRoot, symlinkPath);
    await writeConfig(workspace, configFor(workspace, {
      approvedOutputRoots: [{ id: 'sdcard-images', label: 'SD card images', path: symlinkPath }],
    }));

    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      git: sshOrigin,
      rootFs: { statfs: ampleDisk },
    })).rejects.toMatchObject({ code: 'OUTPUT_ROOT_SYMLINK' });

    await writeConfig(workspace, configFor(workspace));
    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      git: sshOrigin,
      rootFs: { statfs: ampleDisk, lstat: async () => fakeDirectoryStats({ isBlockDevice: () => true }) },
    })).rejects.toMatchObject({ code: 'OUTPUT_ROOT_BLOCK_DEVICE' });

    await writeConfig(workspace, configFor(workspace));
    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      git: sshOrigin,
      rootFs: { statfs: async () => ({ bavail: 1, bsize: 1024 ** 3 }) },
    })).rejects.toMatchObject({ code: 'PREFLIGHT_DISK_SPACE' });
  });

  it('accepts only configured root IDs and never an arbitrary submitted path', async () => {
    const workspace = await createWorkspace();
    await writeConfig(workspace, configFor(workspace));
    const loaded = await loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      git: sshOrigin,
      rootFs: { statfs: ampleDisk },
    });

    expect(resolveApprovedRoot(loaded.config, 'sdcard-images')).toEqual(loaded.config.approvedOutputRoots[0]);
    expect(() => resolveApprovedRoot(loaded.config, 'missing-root')).toThrowError(
      expect.objectContaining<Partial<ConfigValidationError>>({ code: 'OUTPUT_ROOT_ID_UNKNOWN' }),
    );
    expect(() => resolveApprovedRoot(loaded.config, 'sdcard-images', '/tmp/other')).toThrowError(
      expect.objectContaining<Partial<ConfigValidationError>>({ code: 'OUTPUT_PATH_NOT_ALLOWED' }),
    );
  });

  it('rejects a non-writable approved root', async () => {
    const workspace = await createWorkspace();
    await writeConfig(workspace, configFor(workspace));

    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      git: sshOrigin,
      rootFs: { statfs: ampleDisk, access: async () => { throw new Error('access denied'); } },
    })).rejects.toMatchObject({ code: 'OUTPUT_ROOT_NOT_WRITABLE' });
  });

  it('rejects insecure output-root modes and unexpected owners', async () => {
    const workspace = await createWorkspace();
    await writeConfig(workspace, configFor(workspace));
    await chmod(workspace.outputRoot, 0o775);
    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      git: sshOrigin,
      rootFs: { statfs: ampleDisk },
    })).rejects.toMatchObject({ code: 'OUTPUT_ROOT_MODE' });
    await chmod(workspace.outputRoot, 0o755);
    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      git: sshOrigin,
      rootFs: { lstat: async () => fakeDirectoryStats({ uid: (process.geteuid?.() ?? -1) + 1 }), statfs: ampleDisk },
    })).rejects.toMatchObject({ code: 'OUTPUT_ROOT_OWNER' });
  });

  it('rejects an existing insecure state root without granting authority', async () => {
    const workspace = await createWorkspace();
    const statePath = resolve(workspace.stateHome, 'osi-image-builder');
    await mkdir(statePath);
    await chmod(statePath, 0o755);
    await writeConfig(workspace, configFor(workspace));
    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      git: sshOrigin,
      rootFs: { statfs: ampleDisk },
    })).rejects.toMatchObject({ code: 'STATE_ROOT_MODE' });
  });

  it('uses effective access instead of requiring root ownership', async () => {
    const workspace = await createWorkspace();
    await writeConfig(workspace, configFor(workspace));

    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      git: sshOrigin,
      rootFs: {
        lstat: async () => fakeDirectoryStats(),
        access: async () => undefined,
        statfs: ampleDisk,
      },
    })).resolves.toBeDefined();
  });

  it('maps canonicalization and space-probe failures to stable config errors', async () => {
    const workspace = await createWorkspace();
    await writeConfig(workspace, configFor(workspace));

    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      git: sshOrigin,
      rootFs: { realpath: async () => { throw new Error('realpath unavailable'); }, statfs: ampleDisk },
    })).rejects.toMatchObject({ code: 'OUTPUT_ROOT_CANONICALIZE_FAILED' });

    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      git: sshOrigin,
      rootFs: { statfs: async () => { throw new Error('statfs unavailable'); } },
    })).rejects.toMatchObject({ code: 'OUTPUT_ROOT_SPACE_CHECK_FAILED' });
  });

  it('does not allow a caller to lower the approved root free-space threshold', async () => {
    const workspace = await createWorkspace();
    await writeConfig(workspace, configFor(workspace));

    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      git: sshOrigin,
      rootFs: { statfs: async () => ({ bavail: 1, bsize: 1024 ** 3 }) },
    })).rejects.toMatchObject({ code: 'PREFLIGHT_DISK_SPACE' });
  });

  it('enforces the 20 GiB minimum when validateApprovedRoots is called directly', async () => {
    const workspace = await createWorkspace();

    await expect(validateApprovedRoots([
      { id: 'sdcard-images', label: 'SD card images', path: workspace.outputRoot },
    ], {
      minimumFreeBytes: 1,
      rootFs: { statfs: ampleDisk },
    })).rejects.toMatchObject({ code: 'DISK_THRESHOLD_INVALID' });
  });
});
