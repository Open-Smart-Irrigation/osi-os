import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createEvidenceWriter, type EvidenceFileSystem } from '../../runner/src/evidence.js';
import { setupSourceWorktree, type SourceFileSystem } from '../../runner/src/source.js';
import type { CommandResult, CommandExecutor } from '../../runner/src/command-executor.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OPERATION = 'activate-target' as const;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

class MemoryEvidenceFileSystem implements EvidenceFileSystem {
  readonly files = new Map<string, Buffer>();

  async publishExclusive(_root: string, path: string, contents: Buffer): Promise<void> {
    if (this.files.has(path)) {
      const error = new Error('already exists') as NodeJS.ErrnoException;
      error.code = 'EEXIST';
      throw error;
    }
    this.files.set(path, Buffer.from(contents));
  }
}

function commandResult(argv: readonly string[], exitCode = 0, stdout = ''): CommandResult {
  return { argv, exitCode, signal: null, stdout, stderr: '', timedOut: false, startedAt: '2026-07-26T10:00:00.000Z', finishedAt: '2026-07-26T10:00:01.000Z' };
}

function sourceInput() {
  return {
    repositoryPath: '/work/osi-os',
    workspacePath: '/state/jobs/job-1/workspace/source',
    source: {
      sourceRemote: 'ssh://git.example/Open-Smart-Irrigation/osi-os.git',
      sourceRef: 'refs/remotes/origin/main',
      sourceBranch: 'main',
      branch: 'main',
      pinnedSha: SHA,
      sourceCommitTime: '2026-07-25T09:00:00+00:00',
      sourceAuthor: 'Author <author@example.test>',
      sourceSubject: 'pinned source',
    },
    target: { openwrtTarget: 'bcm27xx/bcm2712' },
    now: () => '2026-07-26T10:00:00.000Z',
  } as const;
}

describe('stage evidence', () => {
  it('publishes one canonical immutable file with a SHA-256 result', async () => {
    const fileSystem = new MemoryEvidenceFileSystem();
    const writer = createEvidenceWriter({ stateRoot: '/state', fileSystem });
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

    expect(result.path).toBe('/state/jobs/job-1/evidence/01-source.json');
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
    const root = await mkdtemp(join(tmpdir(), 'osi-builder-evidence-'));
    temporaryDirectories.push(root);
    const writer = createEvidenceWriter({ stateRoot: root });
    const result = await writer.write({
      jobId: 'job-2', stage: 'source', startedAt: '2026-07-26T10:00:00.000Z', finishedAt: '2026-07-26T10:00:01.000Z',
      outcome: 'failed', operationId: OPERATION,
      commands: [{ argv: ['/usr/bin/git', 'cat-file', '-e', `${SHA}^{commit}`], exitCode: 128 }],
      inputs: { pinnedSha: SHA }, observations: {},
      error: { code: 'SOURCE_NOT_COMMIT', stage: 'source', details: { sha: SHA }, retryable: false, requestId: 'req-1', diagnosis: 'The pinned source is not a commit.', recovery: 'Re-run source selection and queue a valid commit.', operationId: OPERATION },
    });

    const bytes = await readFile(result.path);
    expect(result.sha256).toBe((await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'));
    expect(JSON.parse(bytes.toString('utf8')).error).toMatchObject({ code: 'SOURCE_NOT_COMMIT', diagnosis: expect.any(String), recovery: expect.any(String) });
  });

  it('rejects unsafe evidence paths before publication', async () => {
    const writer = createEvidenceWriter({ stateRoot: '/state' });
    await expect(writer.write({
      jobId: '../escape', stage: 'source', startedAt: '2026-07-26T10:00:00.000Z', finishedAt: '2026-07-26T10:00:01.000Z',
      outcome: 'passed', operationId: OPERATION, commands: [], inputs: {}, observations: {}, error: null,
    })).rejects.toMatchObject({ code: 'EVIDENCE_PATH_INVALID' });
  });

  it('rejects a symlinked evidence directory without writing outside the state root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-builder-evidence-'));
    const outside = await mkdtemp(join(tmpdir(), 'osi-builder-evidence-outside-'));
    temporaryDirectories.push(root, outside);
    await mkdir(join(root, 'jobs', 'job-3'), { recursive: true });
    await symlink(outside, join(root, 'jobs', 'job-3', 'evidence'));
    const writer = createEvidenceWriter({ stateRoot: root });

    await expect(writer.write({
      jobId: 'job-3', stage: 'source', startedAt: '2026-07-26T10:00:00.000Z', finishedAt: '2026-07-26T10:00:01.000Z',
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
        if (argv[1] === 'show') return commandResult(argv, 0, `${SHA}\u00002026-07-25T09:00:00+00:00\u0000Author\u0000author@example.test\u0000pinned source\u0000`);
        if (argv[1] === 'cat-file') return commandResult(argv);
        if (argv[1] === 'rev-parse' && options.cwd === sourceInput().workspacePath) return commandResult(argv, 0, `${SHA}\n`);
        if (argv[1] === 'submodule') return commandResult(argv, 0, ` ${'a'.repeat(40)} openwrt\n`);
        if (argv[1] === 'status') return commandResult(argv, 0, '');
        return commandResult(argv);
      },
    };
    const fileSystem: SourceFileSystem = { async lstat() { const error = new Error('missing') as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error; } };

    const result = await setupSourceWorktree({ ...sourceInput(), executor, fileSystem });
    expect(result.observations.targetOutputAbsent).toBe(true);
    expect(result.observations.checkedTargetOutputPath).toBe('openwrt/bin/targets/bcm27xx/bcm2712/');
    expect(calls.every(({ argv, options }) => argv[0] === '/usr/bin/git' && options.env.GIT_CONFIG_NOSYSTEM === '1')).toBe(true);
    expect(calls.some(({ argv }) => argv.includes('refs/remotes/origin/main'))).toBe(false);
    expect(calls.some(({ argv }) => argv[1] === 'worktree' && argv.includes('--detach'))).toBe(true);
    expect(calls.some(({ argv }) => argv[1] === 'submodule' && argv.includes('--recursive'))).toBe(true);
  });
});
