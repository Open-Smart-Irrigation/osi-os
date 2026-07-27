import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { LoadedConfig } from '../../config/load.js';

import { createRecoveryFileSystem } from '../../api/src/recovery.js';
import { createCleanupProduction } from '../../cleanup-worker/src/production.js';

const NOW = '2026-07-27T12:00:00.000Z';
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

function deps(root: string, executor: { run: ReturnType<typeof vi.fn> }, publisherCalls: ReturnType<typeof vi.fn>, database?: DatabaseSync) {
  const db = database ?? ({ close: vi.fn() } as unknown as DatabaseSync);
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
  };
}

afterEach(async () => {
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
    await composition.adapters.docker.listByLabels({ 'org.osi.image-builder.job-id': JOB, 'org.osi.image-builder.manifest-sha': HASH }, 1000);
    expect(run).toHaveBeenCalledWith(
      ['/usr/bin/systemctl', '--user', 'show', '--no-pager', '--property=ActiveState', '--value', `osi-image-builder-runner@${JOB}.service`],
      expect.objectContaining({ timeoutMs: 1000, maxCaptureBytes: 64 * 1024, env: expect.objectContaining({ PATH: '/usr/bin:/bin' }) }),
    );
    expect(run).toHaveBeenCalledWith(
      ['/usr/bin/docker', 'ps', '--all', '--no-trunc', '--filter', `org.osi.image-builder.job-id=${JOB}`, '--filter', `org.osi.image-builder.manifest-sha=${HASH}`, '--format', '{{json .ID}}'],
      expect.objectContaining({ timeoutMs: 1000, maxCaptureBytes: 64 * 1024 }),
    );
    await composition.close();
    expect(((options.database as unknown) as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledOnce();
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
    await mkdir(join(output, '.osi-image-builder', 'staging', JOB), { recursive: true });
    await mkdir(join(output, '.osi-image-builder', 'quarantine'), { recursive: true });
    const artifact = Buffer.from('physical staging');
    await writeFile(join(output, '.osi-image-builder', 'staging', JOB, 'image'), artifact);
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

  it('proves admitted staging absence without invoking the publisher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-production-')); roots.push(root);
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
    const bytes = Buffer.from('runner cleanup log');
    await mkdir(join(root, 'jobs', JOB, 'logs'), { recursive: true });
    await writeFile(join(root, 'jobs', JOB, 'logs', 'runner-0.log'), bytes);
    const rows = [{
      stream: 'runner', generation: 0, path: 'logs/runner-0.log', started_at: NOW,
      sealed_at: null as string | null, size_bytes: bytes.length, sha256: null as string | null,
    }];
    const all = vi.fn(() => rows);
    const update = vi.fn((sealedAt: string, sha256: string) => {
      rows[0]!.sealed_at = sealedAt;
      rows[0]!.sha256 = sha256;
      return { changes: 1 };
    });
    const database = {
      close: vi.fn(),
      prepare: vi.fn((sql: string) => sql.startsWith('SELECT stream')
        ? { all }
        : sql.startsWith('UPDATE job_log_generations')
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
    expect(all).toHaveBeenCalledWith(JOB, 129);
    expect(update).toHaveBeenCalledWith(NOW, createHash('sha256').update(bytes).digest('hex'), JOB, 'runner', 0);
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
});
