import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createEvidenceWriter, type EvidenceFileSystem } from '../../runner/src/evidence.js';
import { setupSourceWorktree, type SourceFileSystem } from '../../runner/src/source.js';
import type { CommandResult, CommandExecutor } from '../../runner/src/command-executor.js';
import { loadConfig, type PathAuthorityDependencies, type StateRootAuthority } from '../../config/load.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OPERATION = null;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

class MemoryEvidenceFileSystem implements EvidenceFileSystem {
  readonly files = new Map<string, Buffer>();

  async publishExclusive(_root: StateRootAuthority, path: string, contents: Buffer): Promise<void> {
    if (this.files.has(path)) {
      const error = new Error('already exists') as NodeJS.ErrnoException;
      error.code = 'EEXIST';
      throw error;
    }
    this.files.set(path, Buffer.from(contents));
  }
}

async function authorityFixture(pathAuthorityDependencies?: Partial<PathAuthorityDependencies>) {
  const base = await mkdtemp(join(tmpdir(), 'osi-builder-authority-'));
  temporaryDirectories.push(base);
  const configHome = join(base, 'config');
  const repositoryPath = join(base, 'repository');
  await mkdir(configHome, { recursive: true });
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(join(base, 'images'), { recursive: true });
  const configPath = join(configHome, 'config.json');
  await writeFile(configPath, JSON.stringify({
    repositoryPath,
    approvedOutputRoots: [{ id: 'images', label: 'images', path: join(base, 'images') }],
    builderLockPath: '/opt/osi-image-builder/2026.07.22.1/builder.lock.json',
    maxQueueLength: 50,
    diskFreeMinimumBytes: 20 * 1024 ** 3,
  }));
  const loaded = await loadConfig({
    configPath,
    env: { HOME: base, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: join(base, 'state-home') },
    git: { getOriginPolicy: async () => ({ url: 'git@github.com:Open-Smart-Irrigation/osi-os.git', fetchRefspec: '+refs/heads/*:refs/remotes/origin/*' }) },
    rootFs: { statfs: async () => ({ bavail: 30, bsize: 1024 ** 3 }) },
    pathAuthorityDependencies,
  });
  return { stateRoot: loaded.pathAuthorities.stateRoot, statePath: loaded.stateRoot, repositoryPath };
}

function commandResult(argv: readonly string[], exitCode = 0, stdout = ''): CommandResult {
  return { argv, exitCode, signal: null, stdout, stderr: '', timedOut: false, startedAt: '2026-07-26T10:00:00.000Z', finishedAt: '2026-07-26T10:00:01.000Z' };
}

function sourceInput() {
  return {
    repositoryPath: '/work/osi-os',
    stateRoot: undefined as never,
    jobId: 'job-1',
    source: {
      sourceRemote: 'ssh://git.example/Open-Smart-Irrigation/osi-os.git',
      sourceRef: 'refs/remotes/origin/main',
      sourceBranch: 'main',
      branch: 'main',
      pinnedSha: SHA,
      sourceCommitTime: '2026-07-25T09:00:00.000Z',
      sourceAuthor: 'Author <author@example.test>',
      sourceSubject: 'pinned source',
    },
    target: { openwrtTarget: 'bcm27xx/bcm2712' },
    now: () => '2026-07-26T10:00:00.000Z',
  } as const;
}

async function runUnitSourceWithSubmoduleStatus(status: string) {
  const authority = await authorityFixture();
  const executor: CommandExecutor = {
    async run(argv, options) {
      const command = argv.slice(1).join(' ');
      if (command.startsWith('remote get-url')) return commandResult(argv, 0, `${sourceInput().source.sourceRemote}\n`);
      if (argv[1] === 'show') return commandResult(argv, 0, `${SHA}\u00001784970000\u0000Author\u0000author@example.test\u0000pinned source\u0000`);
      if (argv[1] === 'config') return commandResult(argv, 0, 'submodule.openwrt.url https://git.example/Open-Smart-Irrigation/openwrt.git\n');
      if (argv[1] === 'submodule' && argv.includes('status')) return commandResult(argv, 0, status);
      if (argv[1] === 'rev-parse' && options.cwd?.endsWith('/workspace/source')) return commandResult(argv, 0, `${SHA}\n`);
      return commandResult(argv);
    },
  };
  const fileSystem: SourceFileSystem = { async lstat() { const error = new Error('missing') as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error; } };
  return setupSourceWorktree({ ...sourceInput(), stateRoot: authority.stateRoot, executor, fileSystem });
}

describe('stage evidence', () => {
  it('publishes one canonical immutable file with a SHA-256 result', async () => {
    const fileSystem = new MemoryEvidenceFileSystem();
    const authority = await authorityFixture();
    const writer = createEvidenceWriter({ stateRoot: authority.stateRoot, fileSystem });
    const result = await writer.write({
      jobId: 'job-1',
      stage: 'source',
      startedAt: '2026-07-26T10:00:00.000Z',
      finishedAt: '2026-07-26T10:00:01.000Z',
      outcome: 'passed',
      operationId: OPERATION,
      commands: [{ argv: ['/usr/bin/git', 'status', '--porcelain'], exitCode: 0 }],
      inputs: { pinnedSha: SHA },
      observations: { targetOutputAbsent: true },
      error: null,
    });

    expect(result.path).toBe('jobs/job-1/evidence/01-source.json');
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(fileSystem.files.get(result.path)!.toString('utf8'))).toEqual({
      schemaVersion: 1,
      jobId: 'job-1',
      stage: 'source',
      startedAt: '2026-07-26T10:00:00.000Z',
      finishedAt: '2026-07-26T10:00:01.000Z',
      outcome: 'passed',
      operationId: OPERATION,
      commands: [{ argv: ['/usr/bin/git', 'status', '--porcelain'], exitCode: 0 }],
      inputs: { pinnedSha: SHA },
      observations: { targetOutputAbsent: true },
      error: null,
    });
    await expect(writer.write({
      jobId: 'job-1', stage: 'source', startedAt: '2026-07-26T10:00:00.000Z', finishedAt: '2026-07-26T10:00:01.000Z',
      outcome: 'passed', operationId: OPERATION, commands: [], inputs: {}, observations: {}, error: null,
    })).rejects.toMatchObject({ code: 'EVIDENCE_EXISTS' });
  });

  it('writes complete stable error evidence for a failed stage', async () => {
    const authority = await authorityFixture();
    const writer = createEvidenceWriter({ stateRoot: authority.stateRoot });
    const result = await writer.write({
      jobId: 'job-2', stage: 'source', startedAt: '2026-07-26T10:00:00.000Z', finishedAt: '2026-07-26T10:00:01.000Z',
      outcome: 'failed', operationId: OPERATION,
      commands: [{ argv: ['/usr/bin/git', 'cat-file', '-e', `${SHA}^{commit}`], exitCode: 128 }],
      inputs: { pinnedSha: SHA }, observations: {},
      error: { code: 'SOURCE_NOT_COMMIT', stage: 'source', details: { sha: SHA }, retryable: false, requestId: 'req-1', diagnosis: 'The pinned source is not a commit.', recovery: 'Re-run source selection and queue a valid commit.' },
    });

    const bytes = await readFile(join(authority.statePath, result.path));
    expect(result.sha256).toBe((await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'));
    expect(JSON.parse(bytes.toString('utf8')).error).toMatchObject({ code: 'SOURCE_NOT_COMMIT', diagnosis: expect.any(String), recovery: expect.any(String) });
  });

  it('rejects unsafe evidence paths before publication', async () => {
    const authority = await authorityFixture();
    const writer = createEvidenceWriter({ stateRoot: authority.stateRoot });
    await expect(writer.write({
      jobId: '../escape', stage: 'source', startedAt: '2026-07-26T10:00:00.000Z', finishedAt: '2026-07-26T10:00:01.000Z',
      outcome: 'passed', operationId: OPERATION, commands: [], inputs: {}, observations: {}, error: null,
    })).rejects.toMatchObject({ code: 'EVIDENCE_PATH_INVALID' });
  });

  it('rejects a symlinked evidence directory without writing outside the state root', async () => {
    const authority = await authorityFixture();
    const outside = await mkdtemp(join(tmpdir(), 'osi-builder-evidence-outside-'));
    temporaryDirectories.push(outside);
    await mkdir(join(authority.statePath, 'jobs', 'job-3'), { recursive: true });
    await symlink(outside, join(authority.statePath, 'jobs', 'job-3', 'evidence'));
    const writer = createEvidenceWriter({ stateRoot: authority.stateRoot });

    await expect(writer.write({
      jobId: 'job-3', stage: 'source', startedAt: '2026-07-26T10:00:00.000Z', finishedAt: '2026-07-26T10:00:01.000Z',
      outcome: 'passed', operationId: OPERATION, commands: [], inputs: {}, observations: {}, error: null,
    })).rejects.toMatchObject({ code: 'EVIDENCE_PATH_INVALID' });
    await expect(readFile(join(outside, '01-source.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reconciles a one-shot post-link directory fsync failure and leaves no temporary link', async () => {
    let failures = 1;
    const authority = await authorityFixture({ beforeDirectorySync: async () => { if (failures > 0) { failures -= 1; throw new Error('injected fsync failure'); } } });
    const writer = createEvidenceWriter({ stateRoot: authority.stateRoot });
    const result = await writer.write({
      jobId: 'job-6', stage: 'source', startedAt: '2026-07-26T10:00:00.000Z', finishedAt: '2026-07-26T10:00:01.000Z',
      outcome: 'passed', operationId: OPERATION, commands: [], inputs: {}, observations: {}, error: null,
    });
    expect(await readFile(join(authority.statePath, result.path))).toBeTruthy();
    const names = await (await import('node:fs/promises')).readdir(join(authority.statePath, 'jobs', 'job-6', 'evidence'));
    expect(names.some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('retries successfully after final-link cleanup fsync fails', async () => {
    let syncCalls = 0;
    const authority = await authorityFixture({ beforeDirectorySync: async () => { syncCalls += 1; if (syncCalls === 2) throw new Error('injected cleanup fsync failure'); } });
    const input = {
      jobId: 'job-8', stage: 'source' as const, startedAt: '2026-07-26T10:00:00.000Z', finishedAt: '2026-07-26T10:00:01.000Z',
      outcome: 'passed' as const, operationId: OPERATION, commands: [], inputs: {}, observations: {}, error: null,
    };
    const writer = createEvidenceWriter({ stateRoot: authority.stateRoot });
    await expect(writer.write(input)).rejects.toMatchObject({ code: 'EVIDENCE_PUBLICATION_FAILED' });
    await expect(writer.write(input)).resolves.toMatchObject({ path: 'jobs/job-8/evidence/01-source.json' });
    const names = await (await import('node:fs/promises')).readdir(join(authority.statePath, 'jobs', 'job-8', 'evidence'));
    expect(names).toEqual(['01-source.json']);
  });

  it('rejects an ancestor replacement race through the held state authority', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'osi-builder-race-outside-'));
    temporaryDirectories.push(outside);
    let statePath = '';
    let swapped = false;
    const raced = await authorityFixture({ beforeDirectoryAccess: async () => {
      if (swapped) return;
      swapped = true;
      await rename(join(statePath, 'jobs'), join(outside, 'held-jobs'));
      await symlink(outside, join(statePath, 'jobs'));
    } });
    statePath = raced.statePath;
    await mkdir(join(statePath, 'jobs'), { recursive: true });
    const writer = createEvidenceWriter({ stateRoot: raced.stateRoot });
    await expect(writer.write({
      jobId: 'job-7', stage: 'source', startedAt: '2026-07-26T10:00:00.000Z', finishedAt: '2026-07-26T10:00:01.000Z',
      outcome: 'passed', operationId: OPERATION, commands: [], inputs: {}, observations: {}, error: null,
    })).rejects.toMatchObject({ code: 'EVIDENCE_PATH_INVALID' });
    await expect(readFile(join(outside, '01-source.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('source setup boundary', () => {
  it('uses persisted source identity and fixed non-shell Git commands', async () => {
    const calls: Array<{ argv: readonly string[]; options: { cwd?: string; env: Readonly<Record<string, string>> } }> = [];
    const executor: CommandExecutor = {
      async run(argv, options) {
        calls.push({ argv, options });
        const command = argv.slice(1).join(' ');
        if (command.startsWith('rev-parse --verify --end-of-options refs/remotes/origin/main')) return commandResult(argv, 0, `${SHA}\n`);
        if (argv[1] === 'remote') return commandResult(argv, 0, `${sourceInput().source.sourceRemote}\n`);
        if (argv[1] === 'show') return commandResult(argv, 0, `${SHA}\u00001784970000\u0000Author\u0000author@example.test\u0000pinned source\u0000`);
        if (argv[1] === 'cat-file') return commandResult(argv);
        if (argv[1] === 'rev-parse' && options.cwd?.endsWith('/workspace/source')) return commandResult(argv, 0, `${SHA}\n`);
        if (argv[1] === 'config') return commandResult(argv, 0, 'submodule.openwrt.url https://git.example/Open-Smart-Irrigation/openwrt.git\n');
        if (argv[1] === 'submodule') return commandResult(argv, 0, ` ${'a'.repeat(40)} openwrt\n`);
        if (argv[1] === 'status') return commandResult(argv, 0, '');
        return commandResult(argv);
      },
    };
    const fileSystem: SourceFileSystem = { async lstat() { const error = new Error('missing') as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error; } };

    const authority = await authorityFixture();
    const result = await setupSourceWorktree({ ...sourceInput(), stateRoot: authority.stateRoot, executor, fileSystem });
    expect(result.observations.targetOutputAbsent).toBe(true);
    expect(result.observations.checkedTargetOutputPath).toBe('openwrt/bin/targets/bcm27xx/bcm2712/');
    expect(calls.every(({ argv, options }) => argv[0] === '/usr/bin/git' && options.env.GIT_CONFIG_NOSYSTEM === '1')).toBe(true);
    expect(calls.some(({ argv }) => argv.includes('refs/remotes/origin/main'))).toBe(false);
    expect(calls.some(({ argv }) => argv[1] === 'worktree' && argv.includes('--detach'))).toBe(true);
    expect(calls.some(({ argv }) => argv[1] === 'submodule' && argv.includes('--recursive'))).toBe(true);
    expect(calls.every(({ options }) => options.env.GIT_ALLOW_PROTOCOL === 'file')).toBe(true);
  });

  it('uses canonical timestamps and requires complete coherent errors', async () => {
    const authority = await authorityFixture();
    const writer = createEvidenceWriter({ stateRoot: authority.stateRoot });
    await expect(writer.write({
      jobId: 'job-4', stage: 'source', startedAt: '2026-07-26T10:00:00+00:00', finishedAt: '2026-07-26T10:00:01.000Z',
      outcome: 'passed', operationId: OPERATION, commands: [], inputs: {}, observations: {}, error: null,
    })).rejects.toMatchObject({ code: 'EVIDENCE_INVALID' });
    await expect(writer.write({
      jobId: 'job-5', stage: 'source', startedAt: '2026-07-26T10:00:00.000Z', finishedAt: '2026-07-26T10:00:01.000Z',
      outcome: 'failed', operationId: OPERATION, commands: [], inputs: {}, observations: {},
      error: { code: 'SOURCE_NOT_COMMIT', stage: 'build', details: {}, retryable: false, requestId: 'req-1', diagnosis: 'bad', recovery: 'retry' },
    })).rejects.toMatchObject({ code: 'EVIDENCE_INVALID' });
  });

  it.each([
    ['absent openwrt', ` ${'a'.repeat(40)} other\n`],
    ['uninitialized openwrt', `-${'a'.repeat(40)} openwrt\n`],
    ['wrong or dirty openwrt', `+${'a'.repeat(40)} openwrt\n`],
    ['dirty nested submodule', ` ${'a'.repeat(40)} openwrt\n-${'b'.repeat(40)} openwrt/nested\n`],
  ])('rejects %s recursive submodule state', async (_name, status) => {
    await expect(runUnitSourceWithSubmoduleStatus(status)).rejects.toMatchObject({ code: 'WORKTREE_CREATE_FAILED' });
  });
});
