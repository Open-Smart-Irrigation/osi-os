import { createHash } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { chmod, link, lstat, mkdir, open, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { LoadedConfig } from '../../config/load.js';

import { createRecoveryFileSystem } from '../../api/src/recovery.js';
import { runCleanupWorkerCli } from '../../cleanup-worker/src/cli.js';
import { createCleanupProduction, runCleanupWorker } from '../../cleanup-worker/src/production.js';

const execFile = promisify(nodeExecFile);

const NOW = '2026-07-27T12:00:00.000Z';
const AFTER = '2026-07-27T12:00:01.000Z';
const HASH = 'a'.repeat(64);
const JOB = 'job-1';
const ROOT_ID = 'release';
const ADMISSION = 'cln_0123456789abcdefghjkmnpqrs';

const roots: string[] = [];

function commandResult(argv: readonly string[], stdout: string, exitCode = 0) {
  return {
    argv: [...argv], exitCode, signal: null, stdout, stderr: '', timedOut: false,
    startedAt: NOW, finishedAt: NOW,
  } as const;
}

function physicalQuarantineInput() {
  return {
    rootId: ROOT_ID,
    jobId: JOB,
    admittedStaging: { kind: 'physical-present' as const, path: `staging/${JOB}`, sha256: null, size: null, observedAt: NOW },
    stagingPath: null,
    artifactSha256: null,
    artifactSize: null,
  };
}

function loaded(stateRoot: string): LoadedConfig {
  return {
    stateRoot,
    config: {
      repository: { path: '/repo', remote: 'origin' as const },
      approvedOutputRoots: [{ id: ROOT_ID, label: 'release', path: join(stateRoot, 'output'), quarantinePath: join(stateRoot, 'output', '.osi-image-builder', 'quarantine') }],
      builderLockPath: '/opt/osi-image-builder/2026.07.27/builder.lock.json',
      maxQueueLength: 1,
      diskFreeMinimumBytes: 1,
    },
    redacted: {} as LoadedConfig['redacted'],
    configRoot: '/etc/osi-image-builder',
    pathAuthorities: {} as never,
  } as LoadedConfig;
}

async function createPublisherTree(output: string, source = true): Promise<{
  readonly builder: string;
  readonly staging: string;
  readonly quarantine: string;
  readonly source: string;
}> {
  const builder = join(output, '.osi-image-builder');
  const staging = join(builder, 'staging');
  const quarantine = join(builder, 'quarantine');
  const sourcePath = join(staging, JOB);
  await mkdir(output, { mode: 0o700 });
  await mkdir(builder, { mode: 0o750 });
  await mkdir(staging, { mode: 0o750 });
  await mkdir(quarantine, { mode: 0o750 });
  if (source) await mkdir(sourcePath, { mode: 0o700 });
  return { builder, staging, quarantine, source: sourcePath };
}

async function createSecureLogFile(root: string, relativePath: string, bytes: Buffer): Promise<string> {
  let current = root;
  for (const part of ['jobs', JOB, 'logs', ...relativePath.split('/').slice(0, -1)]) {
    current = join(current, part);
    await mkdir(current, { mode: 0o700 });
  }
  const path = join(current, relativePath.split('/').at(-1)!);
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}

async function createFifo(path: string): Promise<void> {
  await execFile('/usr/bin/mkfifo', [path], { windowsHide: true });
}

function deps(root: string, executor: { run: ReturnType<typeof vi.fn> }, publisherCalls: ReturnType<typeof vi.fn>, database?: DatabaseSync) {
  const db = database ?? ({ close: vi.fn() } as unknown as DatabaseSync);
  async function approvedRootSnapshot<T>(rootId: string, callback: (snapshot: { id: string; path: string; quarantinePath: string; device: number; inode: number }) => Promise<T>): Promise<T> {
    const candidate = loaded(root).config.approvedOutputRoots.find((item) => item.id === rootId);
    if (candidate === undefined) throw new Error('test root is unknown');
    const stats = await lstat(candidate.path);
    return callback({ id: candidate.id, path: candidate.path, quarantinePath: candidate.quarantinePath, device: stats.dev, inode: stats.ino });
  }
  async function stateRootSnapshot<T>(callback: (snapshot: { path: string; device: number; inode: number }) => Promise<T>): Promise<T> {
    const stats = await lstat(root);
    return callback({ path: root, device: stats.dev, inode: stats.ino });
  }
  return {
    database: db,
    loadStateRoot: vi.fn(async () => ({ stateRoot: root, authority: {} as never })),
    loadConfiguration: vi.fn(async () => loaded(root)),
    openDatabase: vi.fn(() => db),
    commandExecutor: executor as never,
    publisherAuthority: { executable: '/proc/1/fd/9', expectedVersion: '2026.07.27', expectedSourceSha256: HASH },
    publisherClientFactory: vi.fn(() => ({
      publish: vi.fn(),
      recheck: vi.fn(),
      quarantine: publisherCalls,
    })) as never,
    systemdEnvironment: vi.fn(async () => ({ XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' })),
    fileSystem: createRecoveryFileSystem(),
    clock: { now: () => NOW },
    ownerUid: process.getuid?.() ?? 0,
    approvedRootSnapshot,
    stateRootSnapshot,
  };
}

type LogFixtureRow = {
  stream: 'runner' | 'docker';
  generation: number;
  path: string;
  started_at: string;
  sealed_at: string | null;
  size_bytes: number;
  sha256: string | null;
};

type LogFixtureEvent = {
  stream: 'runner' | 'docker';
  file_generation: number;
  seq: number;
  event_type: 'log' | 'log_orphan_tail' | 'log-truncated' | 'log-gap';
  at: string;
  byte_offset: number;
  byte_length: number;
  partial: number;
};

function logDatabase(rows: LogFixtureRow[], events: LogFixtureEvent[]) {
  const all = vi.fn(() => rows);
  const eventsAll = vi.fn(() => events);
  const exec = vi.fn();
  const resize = vi.fn((size: number, _jobId: string, stream: string, generation: number) => {
    const row = rows.find((candidate) => candidate.stream === stream && candidate.generation === generation);
    if (row !== undefined) row.size_bytes = size;
    return { changes: row === undefined ? 0 : 1 };
  });
  const insertEvent = vi.fn((...values: unknown[]) => {
    events.push({ stream: values[5] as 'runner' | 'docker', file_generation: Number(values[6]), seq: Number(values[1]), event_type: 'log_orphan_tail', at: String(values[4]), byte_offset: Number(values[7]), byte_length: Number(values[8]), partial: Number(values[9]) });
    return { changes: 1 };
  });
  const update = vi.fn((sealedAt: string, sha256: string, _jobId: string, stream: string, generation: number) => {
    const row = rows.find((candidate) => candidate.stream === stream && candidate.generation === generation);
    if (row !== undefined) { row.sealed_at = sealedAt; row.sha256 = sha256; }
    return { changes: row === undefined ? 0 : 1 };
  });
  const database = {
    close: vi.fn(),
    exec,
    prepare: vi.fn((sql: string) => sql.startsWith('SELECT COALESCE(MAX(seq)')
      ? { get: () => ({ seq: events.reduce((maximum, event) => Math.max(maximum, event.seq + 1), 0) }) }
      : sql.includes('FROM job_log_generations') && sql.startsWith('SELECT')
        ? { all }
        : sql.includes('FROM job_events') && sql.startsWith('SELECT')
          ? { all: eventsAll }
          : sql.startsWith('UPDATE job_log_generations SET size_bytes')
            ? { run: resize }
            : sql.startsWith('INSERT INTO job_events')
              ? { run: insertEvent }
              : sql.startsWith('UPDATE job_log_generations SET sealed_at')
                ? { run: update }
                : (() => { throw new Error(`unexpected SQL: ${sql}`); })()),
  } as unknown as DatabaseSync;
  return { database, all, eventsAll, exec, resize, insertEvent, update };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('cleanup production composition', () => {
  it('instantiates bounded systemd, Docker, publisher, log, quarantine, and evidence boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const run = vi.fn(async (argv: readonly string[]) => {
      if (argv[1] === '--user') return commandResult(argv, 'inactive\n');
      if (argv[1] === 'ps') return commandResult(argv, '');
      throw new Error(`unexpected command: ${argv.join(' ')}`);
    });
    const publisherCalls = vi.fn(async () => ({
      available: true, published: false, quarantined: true, selfTest: false, mutationCount: 1,
      sourceRelativePath: `.osi-image-builder/staging/${JOB}`,
      destinationRelativePath: `.osi-image-builder/quarantine/${JOB}`,
      renameResult: 'RENAMED' as const,
      publisherVersion: '2026.07.27', publisherSourceSha256: HASH,
    }));
    const options = deps(root, { run }, publisherCalls);
    const composition = await createCleanupProduction(options);
    expect(composition.adapters.systemd).toBeDefined();
    expect(composition.adapters.docker).toBeDefined();
    expect(composition.adapters.logSealer).toBeDefined();
    expect(composition.adapters.quarantine).toBeDefined();
    expect(composition.adapters.evidenceWriter).toBeDefined();
    await composition.adapters.systemd.inspect(`osi-image-builder-runner@${JOB}.service`, 1000);
    await composition.adapters.docker.listByJobId(JOB, 1000);
    expect(run).toHaveBeenCalledWith(
      ['/usr/bin/systemctl', '--user', 'show', '--no-pager', '--property=ActiveState', '--value', `osi-image-builder-runner@${JOB}.service`],
      expect.objectContaining({ timeoutMs: 1000, maxCaptureBytes: 64 * 1024, env: expect.objectContaining({ PATH: '/usr/bin:/bin' }) }),
    );
    expect(run).toHaveBeenCalledWith(
      ['/usr/bin/docker', 'ps', '--all', '--no-trunc', '--filter', `label=org.osi.image-builder.job-id=${JOB}`, '--format', '{{json .ID}}'],
      expect.objectContaining({ timeoutMs: 1000, maxCaptureBytes: 64 * 1024 }),
    );
    await expect(composition.adapters.docker.listByJobId('../other', 1000)).rejects.toThrow(/job ID/);
    await composition.close();
    expect(((options.database as unknown) as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledOnce();
  });

  it('proves a nonzero global label result without inspecting every matching container', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const run = vi.fn(async (argv: readonly string[]) => {
      if (argv[1] === '--user') return commandResult(argv, 'inactive\n');
      if (argv[1] === 'ps') return commandResult(argv, `${JSON.stringify('a'.repeat(12))}\n${JSON.stringify('b'.repeat(12))}\n`);
      if (argv[1] === 'inspect') throw new Error('listByJobId must not inspect each result');
      throw new Error(`unexpected command: ${argv.join(' ')}`);
    });
    const composition = await createCleanupProduction(deps(root, { run }, vi.fn()));
    await expect(composition.adapters.docker.hasByJobId(JOB, 1000)).resolves.toBe(true);
    expect(run.mock.calls.filter(([argv]) => argv[1] === 'inspect')).toHaveLength(0);
    await composition.close();
  });

  it('rejects nonzero, timeout, malformed systemd, Docker, and publisher command evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const publisherCalls = vi.fn();
    const run = vi.fn(async (argv: readonly string[]) => commandResult(argv, '{bad', 2));
    const composition = await createCleanupProduction(deps(root, { run }, publisherCalls));
    await expect(composition.adapters.systemd.inspect(`osi-image-builder-runner@${JOB}.service`, 1000)).rejects.toThrow();
    await expect(composition.adapters.docker.inspect('a'.repeat(12), 1000)).rejects.toThrow();
    await composition.close();
  });

  it('proves physical null-identity quarantine through the native publisher and maps paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const output = join(root, 'output');
    await createPublisherTree(output);
    const artifact = Buffer.from('physical staging');
    await writeFile(join(output, '.osi-image-builder', 'staging', JOB, 'image'), artifact, { mode: 0o600 });
    const publisherCalls = vi.fn(async () => {
      await rename(join(output, '.osi-image-builder', 'staging', JOB), join(output, '.osi-image-builder', 'quarantine', JOB));
      return {
        available: true, published: false, quarantined: true, selfTest: false, mutationCount: 1,
        sourceRelativePath: `.osi-image-builder/staging/${JOB}`,
        destinationRelativePath: `.osi-image-builder/quarantine/${JOB}`,
        renameResult: 'RENAMED' as const, publisherVersion: '2026.07.27', publisherSourceSha256: HASH,
      };
    });
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const base = loaded(root);
    const composition = await createCleanupProduction({
      ...deps(root, executor, publisherCalls),
      loadConfiguration: vi.fn(async () => ({
        ...base,
        config: {
          ...base.config,
          approvedOutputRoots: [{ id: ROOT_ID, label: 'release', path: output, quarantinePath: join(output, '.osi-image-builder', 'quarantine') }],
        },
      })),
    });
    const proof = await composition.adapters.quarantine.quarantine({
      rootId: ROOT_ID, jobId: JOB,
      admittedStaging: { kind: 'physical-present', path: `staging/${JOB}`, sha256: null, size: null, observedAt: NOW },
      stagingPath: null, artifactSha256: null, artifactSize: null,
    });
    expect(proof).toMatchObject({ kind: 'quarantined', sourcePath: `staging/${JOB}`, destinationPath: `quarantine/${JOB}`, sha256: null, size: null });
    expect(publisherCalls).toHaveBeenCalledWith({ rootId: ROOT_ID, jobId: JOB });
    await composition.close();
  });

  it('retries a crash after rename from the existing quarantine destination without republishing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const output = join(root, 'output');
    const source = join(output, '.osi-image-builder', 'staging', JOB);
    const destination = join(output, '.osi-image-builder', 'quarantine', JOB);
    await createPublisherTree(output);
    let crashed = false;
    const publisherCalls = vi.fn(async () => {
      await rename(source, destination);
      if (!crashed) { crashed = true; throw new Error('simulated worker crash after native rename'); }
      throw new Error('publisher must not be called for the retry');
    });
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const base = loaded(root);
    const composition = await createCleanupProduction({
      ...deps(root, executor, publisherCalls),
      loadConfiguration: vi.fn(async () => ({ ...base, config: { ...base.config, approvedOutputRoots: [{ id: ROOT_ID, label: 'release', path: output, quarantinePath: join(output, '.osi-image-builder', 'quarantine') }] } })),
    });
    const input = { rootId: ROOT_ID, jobId: JOB, admittedStaging: { kind: 'physical-present' as const, path: `staging/${JOB}`, sha256: null, size: null, observedAt: NOW }, stagingPath: null, artifactSha256: null, artifactSize: null };
    await expect(composition.adapters.quarantine.quarantine(input)).rejects.toThrow('simulated worker crash after native rename');
    await expect(composition.adapters.quarantine.quarantine(input)).resolves.toMatchObject({ kind: 'quarantined', destinationPath: `quarantine/${JOB}`, sha256: null, size: null });
    expect(publisherCalls).toHaveBeenCalledOnce();
    await composition.close();
  });

  it('rejects a destination inode swap after native quarantine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const output = join(root, 'output');
    const source = join(output, '.osi-image-builder', 'staging', JOB);
    const destination = join(output, '.osi-image-builder', 'quarantine', JOB);
    await createPublisherTree(output);
    const publisherCalls = vi.fn(async () => {
      await rename(source, destination);
      await rm(destination, { recursive: true });
      await mkdir(destination, { mode: 0o700 });
      return { available: true, published: false, quarantined: true, selfTest: false, mutationCount: 1, sourceRelativePath: `.osi-image-builder/staging/${JOB}`, destinationRelativePath: `.osi-image-builder/quarantine/${JOB}`, renameResult: 'RENAMED' as const, publisherVersion: '2026.07.27', publisherSourceSha256: HASH };
    });
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const base = loaded(root);
    const composition = await createCleanupProduction({
      ...deps(root, executor, publisherCalls),
      loadConfiguration: vi.fn(async () => ({ ...base, config: { ...base.config, approvedOutputRoots: [{ id: ROOT_ID, label: 'release', path: output, quarantinePath: join(output, '.osi-image-builder', 'quarantine') }] } })),
    });
    await expect(composition.adapters.quarantine.quarantine({ rootId: ROOT_ID, jobId: JOB, admittedStaging: { kind: 'physical-present', path: `staging/${JOB}`, sha256: null, size: null, observedAt: NOW }, stagingPath: null, artifactSha256: null, artifactSize: null })).rejects.toMatchObject({ code: 'QUARANTINE_PENDING' });
    await composition.close();
  });

  it('rejects an approved-root inode swap during native quarantine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const output = join(root, 'output');
    const movedOutput = join(root, 'output-moved');
    const source = join(output, '.osi-image-builder', 'staging', JOB);
    const destination = join(output, '.osi-image-builder', 'quarantine', JOB);
    await createPublisherTree(output);
    const publisherCalls = vi.fn(async () => {
      await rename(source, destination);
      await rename(output, movedOutput);
      await mkdir(output, { mode: 0o700 });
      return { available: true, published: false, quarantined: true, selfTest: false, mutationCount: 1, sourceRelativePath: `.osi-image-builder/staging/${JOB}`, destinationRelativePath: `.osi-image-builder/quarantine/${JOB}`, renameResult: 'RENAMED' as const, publisherVersion: '2026.07.27', publisherSourceSha256: HASH };
    });
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const base = loaded(root);
    const composition = await createCleanupProduction({
      ...deps(root, executor, publisherCalls),
      loadConfiguration: vi.fn(async () => ({ ...base, config: { ...base.config, approvedOutputRoots: [{ id: ROOT_ID, label: 'release', path: output, quarantinePath: join(output, '.osi-image-builder', 'quarantine') }] } })),
    });
    await expect(composition.adapters.quarantine.quarantine({ rootId: ROOT_ID, jobId: JOB, admittedStaging: { kind: 'physical-present', path: `staging/${JOB}`, sha256: null, size: null, observedAt: NOW }, stagingPath: null, artifactSha256: null, artifactSize: null })).rejects.toMatchObject({ code: 'QUARANTINE_PENDING' });
    await composition.close();
  });

  it.each([
    ['builder', 0o700],
    ['builder', 0o755],
    ['staging', 0o700],
    ['staging', 0o755],
    ['quarantine', 0o700],
    ['quarantine', 0o755],
  ] as const)('rejects unsafe publisher metadata for %s mode %o before mutation', async (field, mode) => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const output = join(root, 'output');
    const paths = await createPublisherTree(output);
    await chmod(paths[field], mode);
    const publisherCalls = vi.fn();
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const base = loaded(root);
    const composition = await createCleanupProduction({
      ...deps(root, executor, publisherCalls),
      loadConfiguration: vi.fn(async () => ({
        ...base,
        config: { ...base.config, approvedOutputRoots: [{ id: ROOT_ID, label: 'release', path: output, quarantinePath: paths.quarantine }] },
      })),
    });
    await expect(composition.adapters.quarantine.quarantine(physicalQuarantineInput())).rejects.toMatchObject({ code: 'QUARANTINE_PENDING' });
    expect(publisherCalls).not.toHaveBeenCalled();
    await composition.close();
  });

  it.each([0o750, 0o755])('rejects runner job directory mode %o before mutation', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const output = join(root, 'output');
    const paths = await createPublisherTree(output);
    await chmod(paths.source, mode);
    const publisherCalls = vi.fn();
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const base = loaded(root);
    const composition = await createCleanupProduction({
      ...deps(root, executor, publisherCalls),
      loadConfiguration: vi.fn(async () => ({
        ...base,
        config: { ...base.config, approvedOutputRoots: [{ id: ROOT_ID, label: 'release', path: output, quarantinePath: paths.quarantine }] },
      })),
    });
    await expect(composition.adapters.quarantine.quarantine(physicalQuarantineInput())).rejects.toMatchObject({ code: 'QUARANTINE_PENDING' });
    expect(publisherCalls).not.toHaveBeenCalled();
    await composition.close();
  });

  it.each(['mode', 'hard-link'] as const)('rejects tracked artifact %s metadata before mutation', async (mutation) => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const output = join(root, 'output');
    const paths = await createPublisherTree(output);
    const bytes = Buffer.from('tracked artifact bytes');
    const artifactPath = join(paths.source, 'image');
    await writeFile(artifactPath, bytes, { mode: mutation === 'mode' ? 0o644 : 0o600 });
    if (mutation === 'hard-link') await link(artifactPath, join(root, 'artifact-hard-link'));
    const publisherCalls = vi.fn(async () => {
      await rename(paths.source, join(paths.quarantine, JOB));
      return {
        available: true, published: false, quarantined: true, selfTest: false, mutationCount: 1,
        sourceRelativePath: `.osi-image-builder/staging/${JOB}`,
        destinationRelativePath: `.osi-image-builder/quarantine/${JOB}`,
        renameResult: 'RENAMED' as const, publisherVersion: '2026.07.27', publisherSourceSha256: HASH,
      };
    });
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const base = loaded(root);
    const composition = await createCleanupProduction({
      ...deps(root, executor, publisherCalls),
      loadConfiguration: vi.fn(async () => ({
        ...base,
        config: { ...base.config, approvedOutputRoots: [{ id: ROOT_ID, label: 'release', path: output, quarantinePath: paths.quarantine }] },
      })),
    });
    await expect(composition.adapters.quarantine.quarantine({
      rootId: ROOT_ID,
      jobId: JOB,
      admittedStaging: { kind: 'present', path: `staging/${JOB}/image`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length },
      stagingPath: `staging/${JOB}/image`,
      artifactSha256: createHash('sha256').update(bytes).digest('hex'),
      artifactSize: bytes.length,
    })).rejects.toMatchObject({ code: 'QUARANTINE_PENDING' });
    expect(publisherCalls).not.toHaveBeenCalled();
    await composition.close();
  });

  it('quarantines a canonical tracked artifact with secure metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const output = join(root, 'output');
    const paths = await createPublisherTree(output);
    const bytes = Buffer.from('tracked artifact bytes');
    await writeFile(join(paths.source, 'image'), bytes, { mode: 0o600 });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const publisherCalls = vi.fn(async () => {
      await rename(paths.source, join(paths.quarantine, JOB));
      return {
        available: true, published: false, quarantined: true, selfTest: false, mutationCount: 1,
        sourceRelativePath: `.osi-image-builder/staging/${JOB}`,
        destinationRelativePath: `.osi-image-builder/quarantine/${JOB}`,
        renameResult: 'RENAMED' as const, publisherVersion: '2026.07.27', publisherSourceSha256: HASH,
      };
    });
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const base = loaded(root);
    const composition = await createCleanupProduction({
      ...deps(root, executor, publisherCalls),
      loadConfiguration: vi.fn(async () => ({
        ...base,
        config: { ...base.config, approvedOutputRoots: [{ id: ROOT_ID, label: 'release', path: output, quarantinePath: paths.quarantine }] },
      })),
    });
    await expect(composition.adapters.quarantine.quarantine({
      rootId: ROOT_ID,
      jobId: JOB,
      admittedStaging: { kind: 'present', path: `staging/${JOB}/image`, sha256, size: bytes.length },
      stagingPath: `staging/${JOB}/image`,
      artifactSha256: sha256,
      artifactSize: bytes.length,
    })).resolves.toMatchObject({ kind: 'quarantined', sha256, size: bytes.length });
    expect(publisherCalls).toHaveBeenCalledOnce();
    await composition.close();
  });

  it.skipIf(process.platform !== 'linux')('rejects a FIFO staged artifact before any publisher mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const output = join(root, 'output');
    const paths = await createPublisherTree(output);
    await createFifo(join(paths.source, 'image'));
    const publisherCalls = vi.fn();
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const base = loaded(root);
    const composition = await createCleanupProduction({
      ...deps(root, executor, publisherCalls),
      loadConfiguration: vi.fn(async () => ({
        ...base,
        config: { ...base.config, approvedOutputRoots: [{ id: ROOT_ID, label: 'release', path: output, quarantinePath: paths.quarantine }] },
      })),
    });
    await expect(composition.adapters.quarantine.quarantine({
      rootId: ROOT_ID,
      jobId: JOB,
      admittedStaging: { kind: 'present', path: `staging/${JOB}/image`, sha256: null, size: null },
      stagingPath: `staging/${JOB}/image`,
      artifactSha256: null,
      artifactSize: null,
    })).rejects.toMatchObject({ code: 'QUARANTINE_PENDING' });
    expect(publisherCalls).not.toHaveBeenCalled();
    await composition.close();
  });

  it('rejects wrong owner and cross-device authority metadata before mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const output = join(root, 'output');
    const paths = await createPublisherTree(output);
    const publisherCalls = vi.fn();
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const base = loaded(root);
    const wrongOwner = await createCleanupProduction({
      ...deps(root, executor, publisherCalls),
      ownerUid: (process.getuid?.() ?? 0) + 1,
      loadConfiguration: vi.fn(async () => ({
        ...base,
        config: { ...base.config, approvedOutputRoots: [{ id: ROOT_ID, label: 'release', path: output, quarantinePath: paths.quarantine }] },
      })),
    });
    await expect(wrongOwner.adapters.quarantine.quarantine(physicalQuarantineInput())).rejects.toMatchObject({ code: 'QUARANTINE_PENDING' });
    await wrongOwner.close();

    const crossDevice = await createCleanupProduction({
      ...deps(root, executor, publisherCalls),
      loadConfiguration: vi.fn(async () => ({
        ...base,
        config: { ...base.config, approvedOutputRoots: [{ id: ROOT_ID, label: 'release', path: output, quarantinePath: paths.quarantine }] },
      })),
      approvedRootSnapshot: async (rootId, callback) => {
        const stats = await lstat(output);
        return callback({ id: rootId, path: output, quarantinePath: paths.quarantine, device: stats.dev + 1, inode: stats.ino });
      },
    });
    await expect(crossDevice.adapters.quarantine.quarantine(physicalQuarantineInput())).rejects.toMatchObject({ code: 'QUARANTINE_PENDING' });
    expect(publisherCalls).not.toHaveBeenCalled();
    await crossDevice.close();
  });

  it('rejects an approved root that violates the secure configured mode contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const output = join(root, 'output');
    const paths = await createPublisherTree(output);
    await chmod(output, 0o770);
    const publisherCalls = vi.fn();
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const base = loaded(root);
    const composition = await createCleanupProduction({
      ...deps(root, executor, publisherCalls),
      loadConfiguration: vi.fn(async () => ({
        ...base,
        config: { ...base.config, approvedOutputRoots: [{ id: ROOT_ID, label: 'release', path: output, quarantinePath: paths.quarantine }] },
      })),
    });
    await expect(composition.adapters.quarantine.quarantine(physicalQuarantineInput())).rejects.toMatchObject({ code: 'QUARANTINE_PENDING' });
    expect(publisherCalls).not.toHaveBeenCalled();
    await composition.close();
  });

  it('proves admitted staging absence without invoking the publisher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    await mkdir(join(root, 'output'), { recursive: true });
    const publisherCalls = vi.fn();
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const composition = await createCleanupProduction(deps(root, executor, publisherCalls));
    await expect(composition.adapters.quarantine.quarantine({
      rootId: ROOT_ID,
      jobId: JOB,
      admittedStaging: { kind: 'absent', path: null },
      stagingPath: null,
      artifactSha256: null,
      artifactSize: null,
    })).resolves.toMatchObject({ kind: 'absent', sourcePath: `staging/${JOB}`, sourceAbsent: true });
    expect(publisherCalls).not.toHaveBeenCalled();
    await composition.close();
  });

  it('seals bounded contiguous persisted log generations from the physical bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const bytes = Buffer.from('runner cleanup log\n');
    const logPath = await createSecureLogFile(root, 'runner-0.log', bytes);
    const probe = await open(logPath, 'r');
    const sync = vi.spyOn(Object.getPrototypeOf(probe) as { sync: () => Promise<void> }, 'sync');
    await probe.close();
    const rows = [{
      stream: 'runner', generation: 0, path: 'logs/runner-0.log', started_at: NOW,
      sealed_at: null as string | null, size_bytes: bytes.length, sha256: null as string | null,
    }];
    const events: unknown[] = [];
    const all = vi.fn(() => rows);
    const eventsAll = vi.fn(() => events);
    const nextEvent = vi.fn(() => ({ seq: 0 }));
    const resize = vi.fn(() => ({ changes: 1 }));
    const insertEvent = vi.fn(() => ({ changes: 1 }));
    const update = vi.fn((sealedAt: string, sha256: string) => {
      rows[0]!.sealed_at = sealedAt;
      rows[0]!.sha256 = sha256;
      return { changes: 1 };
    });
    const database = {
      close: vi.fn(),
      exec: vi.fn(),
      prepare: vi.fn((sql: string) => sql.startsWith('SELECT COALESCE(MAX(seq)')
        ? { get: nextEvent }
        : sql.includes('FROM job_log_generations') && sql.startsWith('SELECT')
        ? { all }
        : sql.includes('FROM job_events') && sql.startsWith('SELECT')
          ? { all: eventsAll }
          : sql.startsWith('UPDATE job_log_generations SET size_bytes')
              ? { run: resize }
              : sql.startsWith('INSERT INTO job_events')
                ? { run: insertEvent }
                : sql.startsWith('UPDATE job_log_generations SET sealed_at')
                  ? { run: update }
                  : (() => { throw new Error(`unexpected SQL: ${sql}`); })()),
    } as unknown as DatabaseSync;
    const publisherCalls = vi.fn();
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const composition = await createCleanupProduction(deps(root, executor, publisherCalls, database));
    await expect(composition.adapters.logSealer.seal({
      jobId: JOB,
      admissionId: ADMISSION,
      at: NOW,
      snapshot: {} as never,
    })).resolves.toEqual({ runner: 'sealed', docker: 'absent', verifiedAt: NOW, contiguous: true });
    expect(all).toHaveBeenCalledWith(4096, JOB, 129);
    expect(eventsAll).toHaveBeenCalledWith(JOB, 8_193);
    expect(resize).toHaveBeenCalledWith(bytes.length, JOB, 'runner', 0, bytes.length);
    expect(insertEvent).toHaveBeenCalledWith(JOB, 0, 'log_orphan_tail', '{}', NOW, 'runner', 0, 0, bytes.length, 0);
    expect(update).toHaveBeenCalledWith(NOW, createHash('sha256').update(bytes).digest('hex'), JOB, 'runner', 0, bytes.length);
    expect(sync).toHaveBeenCalled();
    rows.splice(0, rows.length, ...Array.from({ length: 129 }, (_, generation) => ({
      stream: 'runner', generation, path: `logs/runner-${generation}.log`, started_at: NOW,
      sealed_at: NOW, size_bytes: 0, sha256: HASH,
    })));
    await expect(composition.adapters.logSealer.seal({
      jobId: JOB,
      admissionId: ADMISSION,
      at: NOW,
      snapshot: {} as never,
    })).rejects.toMatchObject({ code: 'RECOVERY_LOG_GAP' });
    rows.splice(0, rows.length, ...Array.from({ length: 83 }, (_, generation) => ({
      stream: 'runner', generation,
      path: `logs/${Array.from({ length: 11 }, (_, depth) => `g${generation}-${depth}`).join('/')}/runner.log`,
      started_at: NOW, sealed_at: NOW, size_bytes: 0, sha256: HASH,
    })));
    await expect(composition.adapters.logSealer.seal({
      jobId: JOB,
      admissionId: ADMISSION,
      at: NOW,
      snapshot: {} as never,
    })).rejects.toMatchObject({ code: 'RECOVERY_LOG_GAP' });
    await composition.close();
  });

  it('marks an unterminated durable orphan tail as partial', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const bytes = Buffer.from('partial tail');
    await createSecureLogFile(root, 'runner-0.log', bytes);
    const rows: LogFixtureRow[] = [{
      stream: 'runner',
      generation: 0,
      path: 'logs/runner-0.log',
      started_at: NOW,
      sealed_at: null,
      size_bytes: 0,
      sha256: null,
    }];
    const database = logDatabase(rows, []);
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const composition = await createCleanupProduction(deps(root, executor, vi.fn(), database.database));
    await expect(composition.adapters.logSealer.seal({
      jobId: JOB,
      admissionId: ADMISSION,
      at: NOW,
      snapshot: {} as never,
    })).resolves.toMatchObject({ runner: 'sealed', contiguous: true });
    expect(database.insertEvent).toHaveBeenCalledWith(JOB, 0, 'log_orphan_tail', '{}', NOW, 'runner', 0, 0, bytes.length, 1);
    await composition.close();
  });

  it('does not seal a generation when persisted event ranges have a gap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const bytes = Buffer.from('four');
    await createSecureLogFile(root, 'runner-0.log', bytes);
    const rows: LogFixtureRow[] = [{ stream: 'runner', generation: 0, path: 'logs/runner-0.log', started_at: NOW, sealed_at: null, size_bytes: bytes.length, sha256: null }];
    const database = logDatabase(rows, [{ stream: 'runner', file_generation: 0, seq: 0, event_type: 'log', at: NOW, byte_offset: 1, byte_length: 1, partial: 0 }]);
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const composition = await createCleanupProduction(deps(root, executor, vi.fn(), database.database));
    await expect(composition.adapters.logSealer.seal({ jobId: JOB, admissionId: ADMISSION, at: NOW, snapshot: {} as never })).rejects.toMatchObject({ code: 'RECOVERY_LOG_GAP' });
    expect(rows[0]!.sealed_at).toBeNull();
    expect(database.update).not.toHaveBeenCalled();
    expect(database.exec).toHaveBeenLastCalledWith('ROLLBACK');
    await composition.close();
  });

  it('rejects tampered physical bytes for an already-sealed generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const bytes = Buffer.from('tampered');
    await createSecureLogFile(root, 'runner-0.log', bytes);
    const rows: LogFixtureRow[] = [{ stream: 'runner', generation: 0, path: 'logs/runner-0.log', started_at: NOW, sealed_at: NOW, size_bytes: bytes.length, sha256: HASH }];
    const database = logDatabase(rows, [{ stream: 'runner', file_generation: 0, seq: 0, event_type: 'log', at: NOW, byte_offset: 0, byte_length: bytes.length, partial: 0 }]);
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const composition = await createCleanupProduction(deps(root, executor, vi.fn(), database.database));
    await expect(composition.adapters.logSealer.seal({ jobId: JOB, admissionId: ADMISSION, at: NOW, snapshot: {} as never })).rejects.toMatchObject({ code: 'RECOVERY_LOG_GAP' });
    expect(database.update).not.toHaveBeenCalled();
    expect(database.exec).toHaveBeenLastCalledWith('ROLLBACK');
    await composition.close();
  });

  it.each([
    ['jobs', 0o750],
    [`jobs/${JOB}`, 0o755],
    [`jobs/${JOB}/logs`, 0o750],
    [`jobs/${JOB}/logs/nested`, 0o755],
  ] as const)('rejects log directory %s mode %o', async (relative, mode) => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const bytes = Buffer.from('runner cleanup log\n');
    await createSecureLogFile(root, 'nested/runner-0.log', bytes);
    await chmod(join(root, relative), mode);
    const rows: LogFixtureRow[] = [{
      stream: 'runner', generation: 0, path: 'logs/nested/runner-0.log', started_at: NOW,
      sealed_at: null, size_bytes: bytes.length, sha256: null,
    }];
    const database = logDatabase(rows, []);
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const composition = await createCleanupProduction(deps(root, executor, vi.fn(), database.database));
    await expect(composition.adapters.logSealer.seal({ jobId: JOB, admissionId: ADMISSION, at: NOW, snapshot: {} as never })).rejects.toMatchObject({ code: 'RECOVERY_LOG_GAP' });
    expect(database.update).not.toHaveBeenCalled();
    await composition.close();
  });

  it.each(['mode', 'hard-link'] as const)('rejects log file %s metadata', async (mutation) => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const bytes = Buffer.from('runner cleanup log\n');
    const logPath = await createSecureLogFile(root, 'runner-0.log', bytes);
    if (mutation === 'mode') await chmod(logPath, 0o640);
    else await link(logPath, join(root, 'log-hard-link'));
    const rows: LogFixtureRow[] = [{
      stream: 'runner', generation: 0, path: 'logs/runner-0.log', started_at: NOW,
      sealed_at: null, size_bytes: bytes.length, sha256: null,
    }];
    const database = logDatabase(rows, []);
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const composition = await createCleanupProduction(deps(root, executor, vi.fn(), database.database));
    await expect(composition.adapters.logSealer.seal({ jobId: JOB, admissionId: ADMISSION, at: NOW, snapshot: {} as never })).rejects.toMatchObject({ code: 'RECOVERY_LOG_GAP' });
    expect(database.update).not.toHaveBeenCalled();
    await composition.close();
  });

  it.skipIf(process.platform !== 'linux')('rejects a FIFO log candidate before attempting to hash it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const logPath = await createSecureLogFile(root, 'runner-0.log', Buffer.from('runner cleanup log\n'));
    await rm(logPath);
    await createFifo(logPath);
    const rows: LogFixtureRow[] = [{ stream: 'runner', generation: 0, path: 'logs/runner-0.log', started_at: NOW, sealed_at: null, size_bytes: 0, sha256: null }];
    const database = logDatabase(rows, []);
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const composition = await createCleanupProduction(deps(root, executor, vi.fn(), database.database));
    await expect(composition.adapters.logSealer.seal({ jobId: JOB, admissionId: ADMISSION, at: NOW, snapshot: {} as never })).rejects.toMatchObject({ code: 'RECOVERY_LOG_GAP' });
    expect(database.exec).toHaveBeenLastCalledWith('ROLLBACK');
    await composition.close();
  });

  it('returns verifiedAt from the clock only after physical hashing and durable COMMIT', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const bytes = Buffer.from('runner cleanup log\n');
    await createSecureLogFile(root, 'runner-0.log', bytes);
    const rows: LogFixtureRow[] = [{
      stream: 'runner', generation: 0, path: 'logs/runner-0.log', started_at: NOW,
      sealed_at: null, size_bytes: bytes.length, sha256: null,
    }];
    const database = logDatabase(rows, []);
    const clock = {
      now: vi.fn(() => {
        expect(database.exec).toHaveBeenCalledWith('COMMIT');
        return AFTER;
      }),
    };
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const composition = await createCleanupProduction({ ...deps(root, executor, vi.fn(), database.database), clock });
    await expect(composition.adapters.logSealer.seal({
      jobId: JOB,
      admissionId: ADMISSION,
      at: NOW,
      snapshot: {} as never,
    })).resolves.toMatchObject({ runner: 'sealed', verifiedAt: AFTER, contiguous: true });
    expect(database.update).toHaveBeenCalledWith(NOW, expect.any(String), JOB, 'runner', 0, bytes.length);
    expect(clock.now).toHaveBeenCalledOnce();
    await composition.close();
  });

  it('rejects same-size log metadata mutation between physical hash and sealing recheck', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const bytes = Buffer.from('runner cleanup log\n');
    const logPath = await createSecureLogFile(root, 'runner-0.log', bytes);
    const inode = (await lstat(logPath)).ino;
    const probe = await open(logPath, 'r');
    const prototype = Object.getPrototypeOf(probe) as { stat: (this: FileHandle, ...args: unknown[]) => Promise<Awaited<ReturnType<typeof lstat>>> };
    await probe.close();
    const nativeStat = prototype.stat;
    let matchingStats = 0;
    vi.spyOn(prototype, 'stat').mockImplementation(async function (this: FileHandle, ...args: unknown[]) {
      const stats = await nativeStat.apply(this, args);
      if (stats.ino === inode) {
        matchingStats += 1;
        if (matchingStats === 2) await chmod(logPath, 0o640);
      }
      return stats;
    });
    const rows: LogFixtureRow[] = [{
      stream: 'runner', generation: 0, path: 'logs/runner-0.log', started_at: NOW,
      sealed_at: null, size_bytes: bytes.length, sha256: null,
    }];
    const database = logDatabase(rows, []);
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const composition = await createCleanupProduction(deps(root, executor, vi.fn(), database.database));
    await expect(composition.adapters.logSealer.seal({
      jobId: JOB,
      admissionId: ADMISSION,
      at: NOW,
      snapshot: {} as never,
    })).rejects.toMatchObject({ code: 'RECOVERY_LOG_GAP' });
    expect(database.update).not.toHaveBeenCalled();
    await composition.close();
  });

  it.each(['owner', 'device'] as const)('rejects wrong log %s authority metadata', async (mismatch) => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const bytes = Buffer.from('runner cleanup log\n');
    await createSecureLogFile(root, 'runner-0.log', bytes);
    const rows: LogFixtureRow[] = [{
      stream: 'runner', generation: 0, path: 'logs/runner-0.log', started_at: NOW,
      sealed_at: null, size_bytes: bytes.length, sha256: null,
    }];
    const database = logDatabase(rows, []);
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const base = deps(root, executor, vi.fn(), database.database);
    const composition = await createCleanupProduction({
      ...base,
      ...(mismatch === 'owner' ? { ownerUid: (process.getuid?.() ?? 0) + 1 } : {
        stateRootSnapshot: async (callback) => {
          const stats = await lstat(root);
          return callback({ path: root, device: stats.dev + 1, inode: stats.ino });
        },
      }),
    });
    await expect(composition.adapters.logSealer.seal({
      jobId: JOB,
      admissionId: ADMISSION,
      at: NOW,
      snapshot: {} as never,
    })).rejects.toMatchObject({ code: 'RECOVERY_LOG_GAP' });
    expect(database.update).not.toHaveBeenCalled();
    await composition.close();
  });

  it('writes canonical cleanup evidence exclusively and fsyncs through the descriptor boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
    const publisherCalls = vi.fn();
    const executor = { run: vi.fn(async (argv: readonly string[]) => commandResult(argv, 'inactive\n')) };
    const composition = await createCleanupProduction(deps(root, executor, publisherCalls));
    const evidence = await composition.adapters.evidenceWriter.write({ jobId: JOB, admissionId: ADMISSION, evidence: { schemaVersion: 1, kind: 'cleanup-complete' } });
    expect(evidence.path).toBe(`jobs/${JOB}/evidence/cleanup/${ADMISSION}.complete.json`);
    const bytes = await import('node:fs/promises').then(({ readFile }) => readFile(join(root, evidence.path)));
    expect(bytes.toString()).toBe('{"kind":"cleanup-complete","schemaVersion":1}\n');
    expect(evidence.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    await expect(composition.adapters.evidenceWriter.write({ jobId: JOB, admissionId: ADMISSION, evidence: { schemaVersion: 1, kind: 'cleanup-complete' } })).rejects.toThrow();
    const blocked = await composition.adapters.evidenceWriter.write({ jobId: JOB, admissionId: ADMISSION, evidence: { schemaVersion: 1, kind: 'cleanup-blocked' } });
    expect(blocked.path).toBe(`jobs/${JOB}/evidence/cleanup/${ADMISSION}.blocked.json`);
    await composition.close();
  });

  it('returns a bounded nonzero CLI status and consumes the supplied argument vector', async () => {
    const runner = vi.fn(async (argv: readonly string[]) => {
      expect(argv).toEqual([ADMISSION]);
      return { status: 'completed' as const, jobId: JOB, admissionId: ADMISSION, exactContainerId: null };
    });
    expect(await runCleanupWorkerCli([ADMISSION], { run: runner })).toBe(0);
    expect(runner).toHaveBeenCalledOnce();
    let stderr = '';
    expect(await runCleanupWorkerCli([ADMISSION], { run: async () => { throw new Error(`${'x'.repeat(10_000)}\nsecret-line`); }, writeStderr: (text) => { stderr += text; } })).toBe(1);
    expect(Buffer.byteLength(stderr, 'utf8')).toBeLessThanOrEqual(1_024 + Buffer.byteLength('cleanup worker failed: \n', 'utf8'));
    expect(stderr).not.toContain('\nsecret-line');
  });

  it('rejects invalid argv before production composition or an injected CLI runner', async () => {
    const loadStateRoot = vi.fn(async () => { throw new Error('composition must not start'); });
    await expect(runCleanupWorker(['invalid'], { loadStateRoot })).rejects.toThrow('exactly one valid admission ID');
    expect(loadStateRoot).not.toHaveBeenCalled();

    const runner = vi.fn(async () => ({ status: 'completed' as const, jobId: JOB, admissionId: ADMISSION, exactContainerId: null }));
    let stderr = '';
    expect(await runCleanupWorkerCli(['invalid'], { run: runner, writeStderr: (text) => { stderr += text; } })).toBe(1);
    expect(runner).not.toHaveBeenCalled();
    expect(stderr).toContain('exactly one valid admission ID');
  });
});
