import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { GitCommand } from '../../api/src/git/git-command.js';
import { SourceResolver } from '../../api/src/git/source-resolver.js';
import { loadConfig, type PathAuthorityDependencies } from '../../config/load.js';
import { createSourceGitCommand, setupSourceWorktree, SOURCE_GIT_ENV } from '../../runner/src/source.js';

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

async function git(directory: string, ...argv: string[]): Promise<string> {
  const result = await execFile('/usr/bin/git', ['-C', directory, ...argv], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
  return result.stdout.trim();
}

async function gitRaw(directory: string, ...argv: string[]): Promise<void> {
  await execFile('/usr/bin/git', ['-C', directory, ...argv], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

interface RaceControl {
  readonly ancestor: 'state' | 'jobs' | 'job' | 'workspace';
  readonly trigger?: number;
  readonly heldPathSuffix?: string;
  statePath: string;
  validations: number;
  swapped: boolean;
}

async function replaceAncestor(control: RaceControl): Promise<void> {
  if (control.ancestor === 'state') {
    await (await import('node:fs/promises')).rename(control.statePath, `${control.statePath}-held`);
    await mkdir(control.statePath);
    return;
  }
  const jobPath = join(control.statePath, 'jobs', 'job-race');
  const paths = {
    jobs: join(control.statePath, 'jobs'),
    job: jobPath,
    workspace: join(jobPath, 'workspace'),
  } as const;
  const selected = paths[control.ancestor];
  await (await import('node:fs/promises')).rename(selected, `${selected}-held`);
  await mkdir(selected);
}

function raceDependencies(control: RaceControl): Partial<PathAuthorityDependencies> {
  return {
    beforeDirectoryAccess: async (handle) => {
      const heldPath = await readlink(`/proc/self/fd/${handle.fd}`);
      if (control.heldPathSuffix !== undefined) {
        if (!control.swapped && heldPath.endsWith(control.heldPathSuffix)) {
          control.swapped = true;
          await replaceAncestor(control);
        }
        return;
      }
      if (!heldPath.endsWith('/workspace') && !heldPath.endsWith('/workspace/source')) return;
      control.validations += 1;
      if (!control.swapped && control.validations === control.trigger) {
        control.swapped = true;
        await replaceAncestor(control);
      }
    },
  };
}

async function createFixture(options: {
  readonly collision?: boolean;
  readonly gitmodulesUrl?: string;
  readonly race?: RaceControl;
  readonly pathAuthorityDependencies?: Partial<PathAuthorityDependencies>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'osi-builder-source-'));
  temporaryDirectories.push(root);
  const active = join(root, 'active');
  await mkdir(active);
  await gitRaw(active, 'init');
  await gitRaw(active, 'config', 'user.name', 'Author');
  await gitRaw(active, 'config', 'user.email', 'author@example.test');
  await gitRaw(active, 'config', 'remote.origin.url', 'ssh://git.example/Open-Smart-Irrigation/osi-os.git');
  await gitRaw(active, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  await mkdir(join(active, 'openwrt'), { recursive: true });
  await mkdir(join(active, 'feeds', 'chirpstack-openwrt-feed'), { recursive: true });
  await writeFile(join(active, 'README.md'), 'active\n');
  await writeFile(join(active, 'openwrt', 'Makefile'), 'vendored openwrt tree\n');
  await writeFile(join(active, 'feeds', 'chirpstack-openwrt-feed', 'README.md'), 'vendored chirpstack feed tree\n');
  await writeFile(join(active, '.gitmodules'), [
    '[submodule "openwrt"]',
    '\tpath = openwrt',
    `\turl = ${options.gitmodulesUrl ?? 'https://github.com/openwrt/openwrt.git'}`,
    '\tbranch = openwrt-24.10',
    '[submodule "feeds/chirpstack-openwrt-feed"]',
    '\tpath = feeds/chirpstack-openwrt-feed',
    '\turl = https://github.com/chirpstack/chirpstack-openwrt-feed.git',
    '',
  ].join('\n'));
  if (options.collision) {
    await mkdir(join(active, 'openwrt', 'bin', 'targets', 'bcm27xx', 'bcm2712'), { recursive: true });
    await writeFile(join(active, 'openwrt', 'bin', 'targets', 'bcm27xx', 'bcm2712', 'old.img.gz'), 'old output\n');
  }
  await gitRaw(active, 'add', '.');
  await gitRaw(active, 'commit', '-m', 'pinned vendored source');
  const sha = await git(active, 'rev-parse', 'HEAD');
  await gitRaw(active, 'update-ref', 'refs/remotes/origin/main', sha);
  const commitTime = new Date(Number(await git(active, 'show', '-s', '--format=%ct', sha)) * 1_000).toISOString();
  const authorName = await git(active, 'show', '-s', '--format=%an', sha);
  const authorEmail = await git(active, 'show', '-s', '--format=%ae', sha);
  const subject = await git(active, 'show', '-s', '--format=%s', sha);
  const preparation = options.gitmodulesUrl === undefined
    ? await new SourceResolver({
      repositoryPath: active,
      git: new GitCommand({ sshAuthSock: null }),
      now: () => '2026-07-26T10:00:00.000Z',
    }).prepareRecursiveSource(sha)
    : null;
  await writeFile(join(active, 'README.md'), 'dirty active checkout\n');
  await writeFile(join(active, 'untracked.txt'), 'must remain\n');
  const dirtyStatusBefore = await git(active, 'status', '--porcelain=v1', '--untracked-files=all');
  const configHome = join(root, 'config');
  await mkdir(join(root, 'images'), { recursive: true });
  await mkdir(configHome, { recursive: true });
  await writeFile(join(configHome, 'config.json'), JSON.stringify({
    repositoryPath: active,
    approvedOutputRoots: [{ id: 'images', label: 'images', path: join(root, 'images') }],
    builderLockPath: '/opt/osi-image-builder/2026.07.22.1/builder.lock.json',
    maxQueueLength: 50,
    diskFreeMinimumBytes: 20 * 1024 ** 3,
  }));
  const loaded = await loadConfig({
    configPath: join(configHome, 'config.json'),
    env: { HOME: root, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: join(root, 'state-home') },
    git: { getOriginPolicy: async () => ({ url: 'git@github.com:Open-Smart-Irrigation/osi-os.git', fetchRefspec: '+refs/heads/*:refs/remotes/origin/*' }) },
    rootFs: { statfs: async () => ({ bavail: 30, bsize: 1024 ** 3 }) },
    pathAuthorityDependencies: options.race ? raceDependencies(options.race) : options.pathAuthorityDependencies,
  });
  if (options.race) options.race.statePath = loaded.stateRoot;
  return {
    root,
    active,
    sha,
    preparation,
    dirtyStatusBefore,
    stateRoot: loaded.pathAuthorities.stateRoot,
    statePath: loaded.stateRoot,
    source: preparation === null ? null : {
      sourceRemote: 'ssh://git.example/Open-Smart-Irrigation/osi-os.git',
      sourceRef: 'refs/remotes/origin/main',
      sourceBranch: 'main',
      branch: 'main',
      pinnedSha: sha,
      sourceCommitTime: commitTime,
      sourceAuthor: `${authorName} <${authorEmail}>`,
      sourceSubject: subject,
      sourcePreparation: preparation,
    },
  };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('source worktree integration', () => {
  it('fails closed on real Git output overflow while retaining bounded execution evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-builder-source-overflow-'));
    temporaryDirectories.push(root);
    await gitRaw(root, 'init');
    await gitRaw(root, 'config', 'user.name', 'Overflow Author');
    await gitRaw(root, 'config', 'user.email', 'overflow@example.test');
    await writeFile(join(root, 'large.txt'), 'x'.repeat(256 * 1024));
    await gitRaw(root, 'add', 'large.txt');
    await gitRaw(root, 'commit', '-m', 'large output');

    const result = await createSourceGitCommand().run(['show', 'HEAD:large.txt'], { cwd: root });

    expect(result.outputLimit).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(128 * 1024);
    expect(result.argv).toEqual(['/usr/bin/git', 'show', 'HEAD:large.txt']);
    expect(result.startedAt).toMatch(/Z$/);
    expect(result.finishedAt >= result.startedAt).toBe(true);
  });

  it('attaches complete execution evidence when the trusted wrapper reports overflow', async () => {
    const fixture = await createFixture();
    const realGit = createSourceGitCommand();
    let caught: unknown;
    try {
      await setupSourceWorktree({
        repositoryPath: fixture.active,
        stateRoot: fixture.stateRoot,
        jobId: 'job-overflow-evidence',
        source: fixture.source!,
        target: { openwrtTarget: 'bcm27xx/bcm2712' },
        git: {
          async run(args, options) {
            const result = await realGit.run(args, options);
            return args[0] === 'cat-file' ? { ...result, outputLimit: true } : result;
          },
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'SOURCE_NOT_COMMIT' });
    const commands = (caught as { readonly commands: readonly Record<string, unknown>[] }).commands;
    expect(commands).toEqual([expect.objectContaining({
      argv: ['/usr/bin/git', 'cat-file', '-e', '--end-of-options', `${fixture.sha}^{commit}`],
      startedAt: expect.stringMatching(/Z$/),
      finishedAt: expect.stringMatching(/Z$/),
      exitCode: 0,
      signal: null,
      timedOut: false,
      outputLimit: true,
    })]);
  });

  it('uses API-prepared production HTTPS provenance to create an offline detached vendored-tree worktree', async () => {
    const fixture = await createFixture();
    const workspacePath = join(fixture.statePath, 'jobs', 'job-1', 'workspace', 'source');
    const result = await setupSourceWorktree({
      repositoryPath: fixture.active,
      stateRoot: fixture.stateRoot,
      jobId: 'job-1',
      source: fixture.source!,
      target: { openwrtTarget: 'bcm27xx/bcm2712' },
    });

    expect(result.workspacePath).toBe(workspacePath);
    expect(result.observations.targetOutputAbsent).toBe(true);
    expect(result.observations.checkedTargetOutputPath).toBe('openwrt/bin/targets/bcm27xx/bcm2712/');
    expect(result.observations.worktreeHead).toBe(fixture.sha);
    expect(result.observations.worktreeClean).toBe(true);
    expect(result.observations.components).toEqual(fixture.preparation!.components.map((component) => ({
      path: component.path,
      treeId: component.objectId,
      provenanceUrl: component.provenanceUrl,
    })));
    expect(result.commands.every((command) => command.startedAt <= command.finishedAt
      && typeof command.timedOut === 'boolean'
      && typeof command.outputLimit === 'boolean')).toBe(true);
    expect(SOURCE_GIT_ENV).not.toHaveProperty('GIT_ALLOW_PROTOCOL');
    expect(SOURCE_GIT_ENV).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(SOURCE_GIT_ENV.GIT_CONFIG_VALUE_1).toBe('never');
    expect(await git(workspacePath, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')).toBe('');
    expect(await git(workspacePath, 'rev-parse', 'HEAD')).toBe(fixture.sha);
    expect(await git(fixture.active, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(fixture.dirtyStatusBefore);
  });

  it('rejects production-shape provenance drift during API preparation before checkout', async () => {
    const fixture = await createFixture({ gitmodulesUrl: 'https://example.invalid/openwrt.git' });
    await expect(new SourceResolver({
      repositoryPath: fixture.active,
      git: new GitCommand({ sshAuthSock: null }),
    }).prepareRecursiveSource(fixture.sha)).rejects.toMatchObject({ code: 'SOURCE_PREPARATION_FAILED' });
    await expect(access(join(fixture.statePath, 'jobs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a gitlink representation because the current source contract is vendored trees', async () => {
    const fixture = await createFixture();
    await gitRaw(fixture.active, 'rm', '-r', '--cached', 'openwrt');
    await gitRaw(fixture.active, 'update-index', '--add', '--cacheinfo', `160000,${fixture.sha},openwrt`);
    await gitRaw(fixture.active, 'commit', '-m', 'replace vendored tree with gitlink');
    const gitlinkSha = await git(fixture.active, 'rev-parse', 'HEAD');

    await expect(new SourceResolver({
      repositoryPath: fixture.active,
      git: new GitCommand({ sshAuthSock: null }),
    }).prepareRecursiveSource(gitlinkSha)).rejects.toMatchObject({ code: 'SOURCE_PREPARATION_FAILED' });
  });

  it('rejects a missing required vendored component during API preparation', async () => {
    const fixture = await createFixture();
    await gitRaw(fixture.active, 'rm', '-r', 'feeds/chirpstack-openwrt-feed');
    await gitRaw(fixture.active, 'commit', '-m', 'remove required feed tree');
    const missingSha = await git(fixture.active, 'rev-parse', 'HEAD');

    await expect(new SourceResolver({
      repositoryPath: fixture.active,
      git: new GitCommand({ sshAuthSock: null }),
    }).prepareRecursiveSource(missingSha)).rejects.toMatchObject({ code: 'SOURCE_PREPARATION_FAILED' });
  });

  it('rejects an API preparation whose exact vendored-tree identity no longer matches before workspace creation', async () => {
    const fixture = await createFixture();
    const alteredPreparation = {
      ...fixture.preparation!,
      components: fixture.preparation!.components.map((component) => component.path === 'openwrt'
        ? { ...component, objectId: 'f'.repeat(40) }
        : component),
    };
    await expect(setupSourceWorktree({
      repositoryPath: fixture.active,
      stateRoot: fixture.stateRoot,
      jobId: 'job-preparation-mismatch',
      source: { ...fixture.source!, sourcePreparation: alteredPreparation },
      target: { openwrtTarget: 'bcm27xx/bcm2712' },
    })).rejects.toMatchObject({ code: 'SOURCE_NOT_COMMIT' });
    await expect(access(join(fixture.statePath, 'jobs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails before later mutation when the exact target output directory exists', async () => {
    const fixture = await createFixture({ collision: true });
    await expect(setupSourceWorktree({
      repositoryPath: fixture.active,
      stateRoot: fixture.stateRoot,
      jobId: 'job-2',
      source: fixture.source!,
      target: { openwrtTarget: 'bcm27xx/bcm2712' },
    })).rejects.toMatchObject({ code: 'BUILD_OUTPUT_COLLISION' });
    expect(await git(fixture.active, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(fixture.dirtyStatusBefore);
  });

  it.each([
    ['openwrt', 'openwrt/Makefile'],
    ['chirpstack feed', 'feeds/chirpstack-openwrt-feed/README.md'],
  ] as const)('rejects a dirty %s vendored component at final verification', async (_name, relativePath) => {
    let sourceValidations = 0;
    const fixture = await createFixture({
      pathAuthorityDependencies: {
        beforeDirectoryAccess: async (handle) => {
          const heldPath = await readlink(`/proc/self/fd/${handle.fd}`);
          if (!heldPath.endsWith('/workspace/source')) return;
          sourceValidations += 1;
          if (sourceValidations === 9) await writeFile(`/proc/self/fd/${handle.fd}/${relativePath}`, 'dirty after checkout\n');
        },
      },
    });
    await expect(setupSourceWorktree({
      repositoryPath: fixture.active,
      stateRoot: fixture.stateRoot,
      jobId: 'job-dirty-component',
      source: fixture.source!,
      target: { openwrtTarget: 'bcm27xx/bcm2712' },
    })).rejects.toMatchObject({ code: 'WORKTREE_CREATE_FAILED' });
  });

  it.each([
    ['after worktree add', { trigger: 5 }],
    ['during target inspection', { heldPathSuffix: '/workspace/source/openwrt' }],
    ['during final verification', { trigger: 15 }],
  ] as const)('retains every ancestor binding %s', async (_phase, injection) => {
    for (const ancestor of ['state', 'jobs', 'job', 'workspace'] as const) {
      const race: RaceControl = { ancestor, ...injection, statePath: '', validations: 0, swapped: false };
      const fixture = await createFixture({ race });
      await expect(setupSourceWorktree({
        repositoryPath: fixture.active,
        stateRoot: fixture.stateRoot,
        jobId: 'job-race',
        source: fixture.source!,
        target: { openwrtTarget: 'bcm27xx/bcm2712' },
      })).rejects.toMatchObject({ code: 'WORKTREE_CREATE_FAILED' });
      expect(race.swapped).toBe(true);
      await expect(access(join(fixture.statePath, 'jobs', 'job-race', 'workspace', 'source'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});
