import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createCommandExecutor } from '../../runner/src/command-executor.js';
import { setupSourceWorktree } from '../../runner/src/source.js';

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

async function git(directory: string, ...argv: string[]): Promise<string> {
  const result = await execFile('/usr/bin/git', ['-C', directory, ...argv], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  return result.stdout.trim();
}

async function gitRaw(directory: string, ...argv: string[]): Promise<void> {
  await execFile('/usr/bin/git', ['-C', directory, ...argv], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
}

async function createFixture(withCollision = false) {
  const root = await mkdtemp(join(tmpdir(), 'osi-builder-source-'));
  temporaryDirectories.push(root);
  const active = join(root, 'active');
  const origin = join(root, 'origin.git');
  const submodule = join(root, 'submodule');
  const submoduleOrigin = join(root, 'submodule.git');
  await mkdir(active);
  await mkdir(submodule);
  await gitRaw(root, 'init', '--bare', origin);
  await gitRaw(root, 'init', '--bare', submoduleOrigin);
  await gitRaw(submodule, 'init');
  await gitRaw(submodule, 'config', 'user.name', 'Submodule Author');
  await gitRaw(submodule, 'config', 'user.email', 'submodule@example.test');
  await writeFile(join(submodule, 'README.md'), 'submodule\n');
  await gitRaw(submodule, 'add', 'README.md');
  await gitRaw(submodule, 'commit', '-m', 'submodule fixture');
  await gitRaw(submodule, 'push', submoduleOrigin, 'HEAD:main');
  await gitRaw(submoduleOrigin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await gitRaw(active, 'init');
  await gitRaw(active, 'config', 'user.name', 'Author');
  await gitRaw(active, 'config', 'user.email', 'author@example.test');
  await gitRaw(active, 'config', 'remote.origin.url', 'ssh://git.example/Open-Smart-Irrigation/osi-os.git');
  await gitRaw(active, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  await writeFile(join(active, 'README.md'), 'active\n');
  await gitRaw(active, 'add', 'README.md');
  await gitRaw(active, 'commit', '-m', 'pinned source');
  await gitRaw(active, '-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleOrigin, 'openwrt');
  if (withCollision) {
    await mkdir(join(active, 'openwrt', 'bin', 'targets', 'bcm27xx', 'bcm2712'), { recursive: true });
    await writeFile(join(active, 'openwrt', 'bin', 'targets', 'bcm27xx', 'bcm2712', 'old.img.gz'), 'old output\n');
    await gitRaw(join(active, 'openwrt'), 'add', '.');
    await gitRaw(join(active, 'openwrt'), 'commit', '-m', 'pre-existing target output');
    await gitRaw(join(active, 'openwrt'), 'push', 'origin', 'HEAD:main');
    await gitRaw(active, 'add', 'openwrt');
  }
  await gitRaw(active, 'commit', '-am', 'add fixture submodule');
  const sha = await git(active, 'rev-parse', 'HEAD');
  await gitRaw(active, 'update-ref', 'refs/remotes/origin/main', sha);
  const commitTime = await git(active, 'show', '-s', '--format=%cI', sha);
  const authorName = await git(active, 'show', '-s', '--format=%an', sha);
  const authorEmail = await git(active, 'show', '-s', '--format=%ae', sha);
  const subject = await git(active, 'show', '-s', '--format=%s', sha);
  await writeFile(join(active, 'README.md'), 'dirty active checkout\n');
  await writeFile(join(active, 'untracked.txt'), 'must remain\n');
  const dirtyStatusBefore = await git(active, 'status', '--porcelain=v1', '--untracked-files=all');
  return {
    root, active, sha, dirtyStatusBefore,
    source: {
      sourceRemote: 'ssh://git.example/Open-Smart-Irrigation/osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main',
      pinnedSha: sha, sourceCommitTime: commitTime, sourceAuthor: `${authorName} <${authorEmail}>`, sourceSubject: subject,
    },
  };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('source worktree integration', () => {
  it('creates a detached recursive-submodule worktree and leaves a dirty active checkout unchanged', async () => {
    const fixture = await createFixture();
    const workspacePath = join(fixture.root, 'state', 'jobs', 'job-1', 'workspace', 'source');
    const executor = createCommandExecutor();
    const result = await setupSourceWorktree({
      repositoryPath: fixture.active,
      workspacePath,
      source: fixture.source,
      target: { openwrtTarget: 'bcm27xx/bcm2712' },
      executor: {
        async run(argv, options) {
          // The production policy permits SSH only. The fixture submodule is local,
          // so this adapter changes only the test transport allowance.
          return executor.run(argv, { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: 'file:ssh' } });
        },
      },
    });

    expect(result.observations.targetOutputAbsent).toBe(true);
    expect(result.observations.checkedTargetOutputPath).toBe('openwrt/bin/targets/bcm27xx/bcm2712/');
    expect(result.observations.worktreeHead).toBe(fixture.sha);
    expect(result.observations.worktreeClean).toBe(true);
    expect(result.observations.submodules).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'openwrt', sha: expect.stringMatching(/^[0-9a-f]{40}$/) })]));
    expect(await git(workspacePath, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')).toBe('');
    expect(await git(workspacePath, 'rev-parse', 'HEAD')).toBe(fixture.sha);
    expect(await git(fixture.active, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(fixture.dirtyStatusBefore);
  });

  it('fails before later mutation when the exact target output directory exists', async () => {
    const fixture = await createFixture(true);
    const workspacePath = join(fixture.root, 'state', 'jobs', 'job-2', 'workspace', 'source');
    await expect(setupSourceWorktree({
      repositoryPath: fixture.active, workspacePath, source: fixture.source, target: { openwrtTarget: 'bcm27xx/bcm2712' },
      executor: {
        async run(argv, options) {
          return createCommandExecutor().run(argv, { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: 'file:ssh' } });
        },
      },
    })).rejects.toMatchObject({ code: 'BUILD_OUTPUT_COLLISION' });
    expect(await git(fixture.active, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(fixture.dirtyStatusBefore);
  });
});
