import { mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, type PathAuthorityDependencies, type StateRootAuthority } from '../../config/load.js';
import { createEvidenceWriter, type EvidenceFileSystem, type StageEvidenceInput } from '../../runner/src/evidence.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
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
  return { stateRoot: loaded.pathAuthorities.stateRoot, statePath: loaded.stateRoot };
}

function command() {
  return {
    argv: ['/usr/bin/git', 'status', '--porcelain'],
    startedAt: '2026-07-26T10:00:00.000Z',
    finishedAt: '2026-07-26T10:00:01.000Z',
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputLimit: false,
  } as const;
}

function passedInput(jobId = 'job-1'): StageEvidenceInput {
  return {
    jobId,
    stage: 'source',
    startedAt: '2026-07-26T10:00:00.000Z',
    finishedAt: '2026-07-26T10:00:01.000Z',
    outcome: 'passed',
    operationId: null,
    commands: [command()],
    inputs: { pinnedSha: SHA },
    observations: { targetOutputAbsent: true },
    error: null,
  };
}

function failedInput(jobId = 'job-2'): StageEvidenceInput {
  return {
    ...passedInput(jobId),
    outcome: 'failed',
    commands: [{ ...command(), exitCode: 128 }],
    error: {
      code: 'SOURCE_NOT_COMMIT',
      stage: 'source',
      details: { z: 'last', a: 'first' },
      retryable: false,
      requestId: 'req-1',
      diagnosis: 'The pinned source is not a commit.',
      recovery: 'Re-run source selection and queue a valid commit.',
      evidencePath: `jobs/${jobId}/evidence/01-source.json`,
    },
  };
}

async function replaceEvidenceAncestor(statePath: string, jobId: string, ancestor: 'state' | 'jobs' | 'job' | 'evidence'): Promise<void> {
  if (ancestor === 'state') {
    await rename(statePath, `${statePath}-held`);
    await mkdir(statePath);
    return;
  }
  const jobPath = join(statePath, 'jobs', jobId);
  const paths = {
    jobs: join(statePath, 'jobs'),
    job: jobPath,
    evidence: join(jobPath, 'evidence'),
  } as const;
  const selected = paths[ancestor];
  await rename(selected, `${selected}-held`);
  await mkdir(selected);
}

describe('stage evidence', () => {
  it('publishes canonical immutable evidence and retains complete command execution fields', async () => {
    const fileSystem = new MemoryEvidenceFileSystem();
    const authority = await authorityFixture();
    const writer = createEvidenceWriter({ stateRoot: authority.stateRoot, fileSystem });
    const result = await writer.write(passedInput());

    expect(result.path).toBe('jobs/job-1/evidence/01-source.json');
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(fileSystem.files.get(result.path)!.toString('utf8'))).toEqual({
      schemaVersion: 1,
      jobId: 'job-1',
      stage: 'source',
      startedAt: '2026-07-26T10:00:00.000Z',
      finishedAt: '2026-07-26T10:00:01.000Z',
      outcome: 'passed',
      operationId: null,
      commands: [command()],
      inputs: { pinnedSha: SHA },
      observations: { targetOutputAbsent: true },
      error: null,
    });
  });

  it('serializes the normalized exact error rather than the caller object', async () => {
    const fileSystem = new MemoryEvidenceFileSystem();
    const authority = await authorityFixture();
    const writer = createEvidenceWriter({ stateRoot: authority.stateRoot, fileSystem });
    const input = failedInput();
    const callerError = input.error!;
    const result = await writer.write(input);
    const serialized = JSON.parse(fileSystem.files.get(result.path)!.toString('utf8'));

    expect(serialized.error).toEqual({
      code: 'SOURCE_NOT_COMMIT',
      stage: 'source',
      details: { a: 'first', z: 'last' },
      retryable: false,
      requestId: 'req-1',
      diagnosis: 'The pinned source is not a commit.',
      recovery: 'Re-run source selection and queue a valid commit.',
      evidencePath: 'jobs/job-2/evidence/01-source.json',
    });
    expect(serialized.error).not.toBe(callerError);
  });

  it('rejects extra error fields and evidence paths that do not identify this exact evidence file', async () => {
    const authority = await authorityFixture();
    const writer = createEvidenceWriter({ stateRoot: authority.stateRoot });
    const extra = failedInput('job-extra');
    await expect(writer.write({
      ...extra,
      error: { ...extra.error!, unexpected: true } as never,
    })).rejects.toMatchObject({ code: 'EVIDENCE_INVALID' });
    const mismatch = failedInput('job-mismatch');
    await expect(writer.write({
      ...mismatch,
      error: { ...mismatch.error!, evidencePath: 'jobs/job-other/evidence/01-source.json' },
    })).rejects.toMatchObject({ code: 'EVIDENCE_INVALID' });
  });

  it('rejects incomplete command evidence and incoherent source operation identity', async () => {
    const authority = await authorityFixture();
    const writer = createEvidenceWriter({ stateRoot: authority.stateRoot });
    await expect(writer.write({
      ...passedInput('job-command'),
      commands: [{ argv: ['/usr/bin/git', 'status'], exitCode: 0 } as never],
    })).rejects.toMatchObject({ code: 'EVIDENCE_INVALID' });
    await expect(writer.write({
      ...passedInput('job-operation'),
      operationId: 'activate-target',
    })).rejects.toMatchObject({ code: 'EVIDENCE_INVALID' });
  });

  it('rejects unsafe evidence paths and symlinked evidence directories', async () => {
    const authority = await authorityFixture();
    const writer = createEvidenceWriter({ stateRoot: authority.stateRoot });
    await expect(writer.write({ ...passedInput(), jobId: '../escape' })).rejects.toMatchObject({ code: 'EVIDENCE_PATH_INVALID' });

    const outside = await mkdtemp(join(tmpdir(), 'osi-builder-evidence-outside-'));
    temporaryDirectories.push(outside);
    await mkdir(join(authority.statePath, 'jobs', 'job-symlink'), { recursive: true });
    await symlink(outside, join(authority.statePath, 'jobs', 'job-symlink', 'evidence'));
    await expect(writer.write(passedInput('job-symlink'))).rejects.toMatchObject({ code: 'EVIDENCE_PATH_INVALID' });
    await expect(readFile(join(outside, '01-source.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reconciles retry exhaustion after final link and removes the temporary link on retry', async () => {
    let failures = 2;
    const authority = await authorityFixture({
      beforeDirectorySync: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('injected post-link fsync failure');
        }
      },
    });
    const writer = createEvidenceWriter({ stateRoot: authority.stateRoot });
    const input = passedInput('job-post-link');
    await expect(writer.write(input)).rejects.toMatchObject({ code: 'EVIDENCE_PUBLICATION_FAILED' });
    await expect(writer.write(input)).resolves.toMatchObject({ path: 'jobs/job-post-link/evidence/01-source.json' });
    expect(await readdir(join(authority.statePath, 'jobs', 'job-post-link', 'evidence'))).toEqual(['01-source.json']);
  });

  it('reconciles an exact canonical file after injected final cleanup fsync failure', async () => {
    let syncCalls = 0;
    const authority = await authorityFixture({
      beforeDirectorySync: async () => {
        syncCalls += 1;
        if (syncCalls === 2) throw new Error('injected cleanup fsync failure');
      },
    });
    const writer = createEvidenceWriter({ stateRoot: authority.stateRoot });
    const input = passedInput('job-cleanup');
    await expect(writer.write(input)).rejects.toMatchObject({ code: 'EVIDENCE_PUBLICATION_FAILED' });
    await expect(writer.write(input)).resolves.toMatchObject({ path: 'jobs/job-cleanup/evidence/01-source.json' });
    expect(await readdir(join(authority.statePath, 'jobs', 'job-cleanup', 'evidence'))).toEqual(['01-source.json']);
  });

  it('blocks same-UID temporary pathname substitution immediately before the final link', async () => {
    const jobId = 'job-temp-substitution';
    let statePath = '';
    let validations = 0;
    const authority = await authorityFixture({
      beforeDirectoryAccess: async (handle) => {
        const heldPath = await readlink(`/proc/self/fd/${handle.fd}`);
        if (!heldPath.endsWith('/evidence')) return;
        validations += 1;
        if (validations !== 2) return;
        const directory = join(statePath, 'jobs', jobId, 'evidence');
        const temporary = (await readdir(directory)).find((entry) => entry.startsWith('.01-source.json.') && entry.endsWith('.tmp'));
        if (temporary === undefined) throw new Error('temporary evidence link was not present');
        await rename(join(directory, temporary), join(directory, `${temporary}.survivor.tmp`));
        await writeFile(join(directory, temporary), 'same-uid substitute\n');
      },
    });
    statePath = authority.statePath;
    const writer = createEvidenceWriter({ stateRoot: authority.stateRoot });

    await expect(writer.write(passedInput(jobId))).rejects.toMatchObject({ code: 'EVIDENCE_TEMPORARY_BLOCKER' });
    await expect(writer.write(passedInput(jobId))).rejects.toMatchObject({ code: 'EVIDENCE_TEMPORARY_BLOCKER' });
  });

  it('blocks an unexpected temporary survivor injected during cleanup and on retry', async () => {
    const jobId = 'job-cleanup-survivor';
    let statePath = '';
    let syncCalls = 0;
    const authority = await authorityFixture({
      beforeDirectorySync: async () => {
        syncCalls += 1;
        if (syncCalls !== 2) return;
        const directory = join(statePath, 'jobs', jobId, 'evidence');
        await writeFile(join(directory, '.01-source.json.unexpected.tmp'), 'unexpected survivor\n');
      },
    });
    statePath = authority.statePath;
    const writer = createEvidenceWriter({ stateRoot: authority.stateRoot });

    await expect(writer.write(passedInput(jobId))).rejects.toMatchObject({ code: 'EVIDENCE_TEMPORARY_BLOCKER' });
    await expect(writer.write(passedInput(jobId))).rejects.toMatchObject({ code: 'EVIDENCE_TEMPORARY_BLOCKER' });
  });

  it('rejects replacement of the bound final file after its first successful fsync', async () => {
    const jobId = 'job-final-race';
    let statePath = '';
    let validations = 0;
    const authority = await authorityFixture({
      beforeDirectoryAccess: async (handle) => {
        const heldPath = await readlink(`/proc/self/fd/${handle.fd}`);
        if (!heldPath.endsWith('/evidence')) return;
        validations += 1;
        if (validations === 3) {
          const finalPath = join(statePath, 'jobs', jobId, 'evidence', '01-source.json');
          await rename(finalPath, `${finalPath}.replaced`);
          await writeFile(finalPath, '{"tampered":true}\n');
        }
      },
    });
    statePath = authority.statePath;
    await expect(createEvidenceWriter({ stateRoot: authority.stateRoot }).write(passedInput(jobId)))
      .rejects.toMatchObject({ code: 'EVIDENCE_PUBLICATION_FAILED' });
  });

  it.each([
    ['before publication', 1],
    ['after publication', 3],
  ] as const)('rejects every %s ancestor replacement race', async (_phase, trigger) => {
    for (const ancestor of ['state', 'jobs', 'job', 'evidence'] as const) {
      const jobId = `job-race-${ancestor}-${String(trigger)}`;
      let statePath = '';
      let validations = 0;
      let swapped = false;
      const authority = await authorityFixture({
        beforeDirectoryAccess: async (handle) => {
          const heldPath = await readlink(`/proc/self/fd/${handle.fd}`);
          if (!heldPath.endsWith('/evidence')) return;
          validations += 1;
          if (!swapped && validations === trigger) {
            swapped = true;
            await replaceEvidenceAncestor(statePath, jobId, ancestor);
          }
        },
      });
      statePath = authority.statePath;
      const writer = createEvidenceWriter({ stateRoot: authority.stateRoot });
      await expect(writer.write(passedInput(jobId))).rejects.toMatchObject({ code: 'EVIDENCE_PATH_INVALID' });
      expect(swapped).toBe(true);
      await expect(readFile(join(statePath, 'jobs', jobId, 'evidence', '01-source.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});
