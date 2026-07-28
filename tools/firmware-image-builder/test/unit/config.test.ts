import { execFile as execFileCallback } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigValidationError,
  loadCleanupConfig,
  loadConfig,
  resolveApprovedRoot,
  validateOrigin,
  validateApprovedRoots,
  withApprovedRootSnapshot,
  type RootStats,
} from '../../config/load.js';
import { CANONICAL_FETCH_REFSPEC, type ValidatedOriginPolicy } from '../../config/origin-policy.js';

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
function originPolicy(url: string): ValidatedOriginPolicy {
  return { url, fetchRefspec: CANONICAL_FETCH_REFSPEC };
}

const sshOrigin = { getOriginPolicy: async () => originPolicy('git@github.com:Open-Smart-Irrigation/osi-os.git') };
const httpsOrigin = { getOriginPolicy: async () => originPolicy('https://github.com/example/osi-os.git') };
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
  await execFile('/usr/bin/git', ['-C', path, 'config', '--local', 'remote.origin.fetch', CANONICAL_FETCH_REFSPEC], { env: cleanGitEnv });
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
  it('loads cleanup authority without probing or opening the configured repository', async () => {
    const workspace = await createWorkspace();
    const inaccessibleRepository = join(workspace.directory, 'repository-is-not-mounted');
    const outputWorkRoot = join(workspace.outputRoot, '.osi-image-builder');
    await mkdir(outputWorkRoot, { mode: 0o750 });
    await writeConfig(workspace, configFor(workspace, {
      repositoryPath: inaccessibleRepository,
    }));
    const access = vi.fn(async (path: string) => {
      if (path === resolve(workspace.outputRoot)) throw Object.assign(new Error('read-only output root'), { code: 'EROFS' });
    });

    const loaded = await loadCleanupConfig({
      env: {
        HOME: homedir(),
        XDG_CONFIG_HOME: workspace.configHome,
        XDG_STATE_HOME: workspace.stateHome,
      },
      rootFs: { access, statfs: async () => ({ bavail: 0, bsize: 1024 ** 3 }) },
      pathAuthorityDependencies: { writableAccess: access },
    });
    await expect(withApprovedRootSnapshot(
      loaded.pathAuthorities.approvedRoots,
      'sdcard-images',
      async ({ snapshot }) => snapshot.path,
    )).resolves.toBe(resolve(workspace.outputRoot));

    expect(loaded.stateRoot).toBe(resolve(workspace.stateHome, 'osi-image-builder'));
    expect(loaded.config).toEqual({
      approvedOutputRoots: [{
        id: 'sdcard-images',
        label: 'SD card images',
        path: resolve(workspace.outputRoot),
        quarantinePath: join(resolve(workspace.outputRoot), '.osi-image-builder', 'quarantine'),
      }],
      builderLockPath: '/opt/osi-image-builder/2026.07.22.1/builder.lock.json',
    });
    expect(access).toHaveBeenCalledWith(outputWorkRoot, expect.any(Number));
    expect(access.mock.calls.filter(([path]) => path === outputWorkRoot)).toHaveLength(3);
    expect(access).not.toHaveBeenCalledWith(resolve(workspace.outputRoot), expect.any(Number));
    await expect(lstat(inaccessibleRepository)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects cleanup authority when the fixed output work root is unavailable', async () => {
    const workspace = await createWorkspace();
    await writeConfig(workspace, configFor(workspace));

    await expect(loadCleanupConfig({
      env: {
        XDG_CONFIG_HOME: workspace.configHome,
        XDG_STATE_HOME: workspace.stateHome,
      },
      rootFs: { statfs: ampleDisk },
    })).rejects.toMatchObject({ code: 'OUTPUT_ROOT_NOT_FOUND', field: 'sdcard-images' });
  });

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
    ['HTTPS', 'https://github.com/example/osi-os.git'],
    ['SSH password', 'ssh://user:secret@example.com/repo'],
    ['percent encoded control', 'ssh://example.com/repo%0A'],
    ['remote helper', 'ext::ssh example.com/repo'],
    ['local file', 'file:///tmp/osi-os.git'],
    ['ambiguous SCP', 'example.com:repo'],
    ['absolute SCP path', 'git@example.com:/repo'],
    ['SSH port zero', 'ssh://git@example.com:0/repo'],
    ['SSH option-like username', 'ssh://-git@example.com/repo'],
    ['SSH option-like host', 'ssh://git@-example.com/repo'],
    ['SSH malformed host label', 'ssh://git@example..com/repo'],
    ['SCP option-like username', '-git@example.com:repo'],
    ['SCP option-like host', 'git@-example.com:repo'],
    ['SCP option-like path', 'git@example.com:-repo'],
  ])('rejects %s origin values', (_name, value) => {
    expect(() => validateOrigin(value)).toThrowError(
      expect.objectContaining<Partial<ConfigValidationError>>({ code: 'ORIGIN_NOT_SSH' }),
    );
  });

  it.each([
    'ssh://git@example.com:1/repo',
    'ssh://git@example.com:65535/repo',
    'git@example.com:repo.git',
  ])('accepts bounded SSH target %s', (value) => {
    expect(() => validateOrigin(value)).not.toThrow();
  });

  it('uses the shared policy to reject local transport overrides at startup', async () => {
    const workspace = await createWorkspace();
    await initGitRepository(workspace.repositoryPath, 'git@github.com:Open-Smart-Irrigation/osi-os.git');
    await execFile('/usr/bin/git', ['-C', workspace.repositoryPath, 'config', '--local', 'core.sshCommand', 'ssh -i /secret/key'], { env: cleanGitEnv });
    await writeConfig(workspace, configFor(workspace));

    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      rootFs: { statfs: ampleDisk },
    })).rejects.toMatchObject({ code: 'ORIGIN_NOT_SSH' });
  });

  it('accepts the configured common hooks path because startup Git is fixed to /dev/null', async () => {
    const workspace = await createWorkspace();
    await initGitRepository(workspace.repositoryPath, 'git@github.com:Open-Smart-Irrigation/osi-os.git');
    await execFile('/usr/bin/git', ['-C', workspace.repositoryPath, 'config', '--local', 'core.hooksPath', '/home/phil/Repos/osi-os/.git/hooks'], { env: cleanGitEnv });
    await writeConfig(workspace, configFor(workspace));

    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      rootFs: { statfs: ampleDisk },
    })).resolves.toBeDefined();
  });

  it('rejects configured hook commands and bundle endpoints during startup inspection', async () => {
    const workspace = await createWorkspace();
    await initGitRepository(workspace.repositoryPath, 'git@github.com:Open-Smart-Irrigation/osi-os.git');
    await execFile('/usr/bin/git', ['-C', workspace.repositoryPath, 'config', '--local', 'hook.reference-transaction.command', 'touch /tmp/configured-hook'], { env: cleanGitEnv });
    await execFile('/usr/bin/git', ['-C', workspace.repositoryPath, 'config', '--local', 'hook.reference-transaction.event', 'prepared'], { env: cleanGitEnv });
    await execFile('/usr/bin/git', ['-C', workspace.repositoryPath, 'config', '--local', 'fetch.bundleURI', 'https://example.invalid/bundle'], { env: cleanGitEnv });
    await writeConfig(workspace, configFor(workspace));

    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      rootFs: { statfs: ampleDisk },
    })).rejects.toMatchObject({ code: 'ORIGIN_NOT_SSH' });
  });

  it('inspects effective worktree config and rejects transport, protocol, and refspec overrides', async () => {
    const workspace = await createWorkspace();
    await initGitRepository(workspace.repositoryPath, 'git@github.com:Open-Smart-Irrigation/osi-os.git');
    await execFile('/usr/bin/git', ['-C', workspace.repositoryPath, 'config', '--local', 'extensions.worktreeConfig', 'true'], { env: cleanGitEnv });
    for (const [key, value] of [
      ['url.ext::evil.insteadOf', 'git@github.com:rewritten/osi-os.git'],
      ['protocol.ext.allow', 'always'],
      ['core.sshCommand', 'ssh -i /secret/key'],
      ['core.hooksPath', '/tmp/hooks'],
      ['core.alternateRefsCommand', 'touch /tmp/alternate-refs'],
      ['core.pager', 'touch /tmp/pager'],
      ['core.editor', 'touch /tmp/editor'],
      ['fetch.bundleURI', 'https://example.invalid/bundle'],
      ['remote.origin.uploadpack', 'evil-upload-pack'],
      ['remote.origin.fetch', 'refs/heads/main:refs/remotes/origin/main'],
    ]) {
      await execFile('/usr/bin/git', ['-C', workspace.repositoryPath, 'config', '--worktree', key, value], { env: cleanGitEnv });
    }
    await writeConfig(workspace, configFor(workspace));

    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      rootFs: { statfs: ampleDisk },
    })).rejects.toMatchObject({ code: 'ORIGIN_NOT_SSH' });
  });

  it('validates the canonical fetch refspec during startup', async () => {
    const workspace = await createWorkspace();
    await initGitRepository(workspace.repositoryPath, 'git@github.com:Open-Smart-Irrigation/osi-os.git');
    await execFile('/usr/bin/git', ['-C', workspace.repositoryPath, 'config', '--local', '--replace-all', 'remote.origin.fetch', 'refs/heads/main:refs/remotes/origin/main'], { env: cleanGitEnv });
    await writeConfig(workspace, configFor(workspace));

    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      rootFs: { statfs: ampleDisk },
    })).rejects.toMatchObject({ code: 'ORIGIN_NOT_SSH' });
  });

  it('sanitizes global and system Git config while inspecting the repository', async () => {
    const workspace = await createWorkspace();
    const ambientConfig = join(workspace.directory, 'ambient.gitconfig');
    await initGitRepository(workspace.repositoryPath, 'git@github.com:Open-Smart-Irrigation/osi-os.git');
    await writeFile(ambientConfig, '[core]\n\tsshCommand = ssh -i /secret/key\n[protocol "ext"]\n\tallow = always\n[url "ext::evil"]\n\tinsteadOf = git@github.com:\n[remote "origin"]\n\tfetch = refs/heads/main:refs/remotes/origin/main\n');
    await writeConfig(workspace, configFor(workspace));
    vi.stubEnv('GIT_CONFIG_GLOBAL', ambientConfig);
    vi.stubEnv('GIT_CONFIG_SYSTEM', ambientConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0');

    await expect(loadConfig({
      env: { XDG_CONFIG_HOME: workspace.configHome, XDG_STATE_HOME: workspace.stateHome },
      rootFs: { statfs: ampleDisk },
    })).resolves.toBeDefined();
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
      git: { getOriginPolicy: async () => { throw new Error('secret stderr from git'); } },
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
