import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ADMISSION_ID_PATTERN,
  createCleanupAdmissionRecovery,
  createRecoveryFileSystem,
  decodeAdmissionId,
  encodeAdmissionId,
  type CleanupAdmissionRecoveryOptions,
  type RecoveryDirectoryHandle,
  type RecoveryFileHandle,
  type RecoveryFileSystem,
  type RecoverySystemd,
} from '../../api/src/recovery.js';
import { MIGRATION_REGISTRY } from '../../api/src/store-schema.js';

const NOW = '2026-07-27T12:00:00.000Z';
const EXPIRES = '2026-07-27T12:05:00.000Z';
const LATER = '2026-07-27T12:01:00.000Z';
const SHA = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const OLD_ID = 'cln_0123456789abcdefghjkmnpqrs';

const roots: string[] = [];

function snapshot(jobId: string, blocker: 'none' | 'staging-or-log' = 'none') {
  return {
    runner: { unit: `osi-image-builder-runner@${jobId}.service`, owner: null, leaseExpiresAt: null, inactiveAt: NOW, observedAt: NOW },
    state: 'starting' as const,
    container: { kind: 'absent' as const, globalLabelResult: 'no-match' as const, observedAt: NOW },
    staging: blocker === 'none' ? { kind: 'absent' as const, path: null } : { kind: 'present' as const, path: 'staging/image', sha256: SHA, size: 1 },
    logs: { runner: 'absent' as const, docker: 'absent' as const, verifiedAt: NOW },
    blocker,
  };
}

function systemd(events: string[] = [], active = { value: false }): RecoverySystemd {
  return {
    async start(unit) { events.push(`start:${unit}:${active.value ? 'overlap' : 'clear'}`); active.value = true; },
    async stop(unit) { events.push(`stop:${unit}`); active.value = false; },
    async isActive(unit) { events.push(`active:${unit}`); return active.value; },
  } as RecoverySystemd;
}

function fakeRecovery(options: {
  readonly root: string;
  readonly lease?: Record<string, unknown> | null;
  readonly generation?: number;
  readonly events?: string[];
  readonly active?: { value: boolean };
  readonly fileSystem?: RecoveryFileSystem;
}) {
  let lease = options.lease ?? null;
  let generation = options.generation ?? 0;
  const writes: unknown[] = [];
  const db = {
    prepare(sql: string) {
      return {
        get(...parameters: readonly unknown[]) {
          if (sql.includes('cleanup_credential_reservations')) return undefined;
          if (sql.includes('cleanup_leases')) {
            if (lease === null) return undefined;
            const admissionId = sql.includes('admission_id=? AND job_id=?') ? parameters[0] : parameters[1];
            const jobId = sql.includes('admission_id=? AND job_id=?') ? parameters[1] : parameters[0];
            return lease.admission_id === admissionId && lease.job_id === jobId ? lease : undefined;
          }
          void parameters;
          return { cleanup_generation: generation };
        },
      };
    },
  };
  const ownership = {
    apiWrite(command: Record<string, unknown>) {
      if (command.kind === 'cleanup-credential-reserve' || command.kind === 'cleanup-credential-abort') return { ok: true, kind: 'committed', eventSeq: writes.length, value: undefined } as const;
      writes.push(command);
      if (command.kind === 'cleanup-admission') {
        generation += 1;
        lease = {
          admission_id: command.admissionId,
          job_id: command.jobId,
          status: 'admitted',
          expires_at: command.expiresAt,
          credential_relative_path: command.credentialRelativePath,
          credential_sha256: command.credentialSha256,
          fence_generation: generation,
          fence_token_hash: command.fenceTokenHash,
          unit_name: command.unitName,
        };
      } else if (command.kind === 'cleanup-admission-rotate' || command.kind === 'cleanup-admission-retry') {
        const previous = lease;
        if (!previous || previous.admission_id !== command.previousAdmissionId || ['expired', 'handed_back'].includes(String(previous.status))) {
          return { ok: false, conflict: { kind: 'cas-lost', message: 'stale predecessor' } } as const;
        }
        previous.status = 'expired';
        generation += 1;
        lease = {
          admission_id: command.admissionId,
          job_id: command.jobId,
          status: 'admitted',
          expires_at: command.expiresAt,
          credential_relative_path: command.credentialRelativePath,
          credential_sha256: command.credentialSha256,
          fence_generation: generation,
          fence_token_hash: command.fenceTokenHash,
          unit_name: command.unitName,
        };
      }
      return { ok: true, kind: 'committed', eventSeq: writes.length, value: undefined } as const;
    },
  };
  const recovery = createCleanupAdmissionRecovery({
    stateRoot: options.root,
    db: db as never,
    ownership: ownership as never,
    systemd: systemd(options.events, options.active),
    fileSystem: options.fileSystem,
    clock: { now: () => NOW },
    crypto: { randomBytes: () => Buffer.alloc(32, 7) },
    ownerUid: process.getuid?.() ?? 0,
  } as CleanupAdmissionRecoveryOptions);
  return { recovery, writes, getLease: () => lease };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Task 20 cleanup admission corrections', () => {
  it('does not retain a legacy path-based filesystem adapter', async () => {
    const source = await readFile(new URL('../../api/src/recovery.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/RecoveryLegacyFileSystem|legacyFileSystem|join\(path, name\)/);
  });

  it('keeps admissions closed before startup prune and forbids prune after openAdmissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-correction-lifecycle-')); roots.push(root);
    const { recovery } = fakeRecovery({ root });

    await expect(recovery.admitAndStart({ jobId: 'job-lifecycle', owner: 'api', expiresAt: EXPIRES, snapshot: snapshot('job-lifecycle'), at: NOW })).rejects.toThrow(/admissions are not open/);
    await expect(recovery.openAdmissions()).resolves.toBeUndefined();
    await expect(recovery.pruneOrphanCredentials()).rejects.toThrow(/prune is unavailable after admissions open/);
  });

  it('stops a claimed predecessor again at the rotation fence and authorizes one replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-correction-interleave-')); roots.push(root);
    const events: string[] = [];
    const active = { value: false };
    const { recovery, writes, getLease } = fakeRecovery({ root, events, active });
    await recovery.openAdmissions();
    const first = await recovery.admitAndStart({ jobId: 'job-interleave', owner: 'api', expiresAt: EXPIRES, snapshot: snapshot('job-interleave'), at: NOW });
    const lease = getLease()!;
    lease.status = 'claimed';
    active.value = false;

    let firstStatusCheck = true;
    const interleavingSystemd = {
      async start(unit: string) { events.push(`start:${unit}:${active.value ? 'overlap' : 'clear'}`); active.value = true; },
      async stop(unit: string) { events.push(`stop:${unit}`); active.value = false; },
      async isActive(unit: string) {
        events.push(`active:${unit}`);
        if (firstStatusCheck) { firstStatusCheck = false; active.value = true; return false; }
        return active.value;
      },
    } satisfies RecoverySystemd;
    const replacementRecovery = createCleanupAdmissionRecovery({
      stateRoot: root,
      db: { prepare: (sql: string) => ({ get: () => sql.includes('cleanup_leases') ? getLease() : { cleanup_generation: 1 } }) } as never,
      ownership: { apiWrite: (command: never) => {
        const result = (recovery as never);
        void result;
        const write = (writes as unknown[]);
        if ((command as { kind?: string }).kind === 'cleanup-credential-reserve') {
          return { ok: true, kind: 'committed', eventSeq: write.length, value: undefined } as const;
        }
        write.push(command);
        lease.status = 'expired';
        return { ok: true, kind: 'committed', eventSeq: write.length, value: undefined } as const;
      } } as never,
      systemd: interleavingSystemd,
      clock: { now: () => NOW },
      crypto: { randomBytes: () => Buffer.alloc(32, 8) },
      ownerUid: process.getuid?.() ?? 0,
    });
    await replacementRecovery.openAdmissions();
    const result = await replacementRecovery.reconcileAndStart({ jobId: 'job-interleave', admissionId: first.admissionId, owner: 'api', expiresAt: EXPIRES, snapshot: snapshot('job-interleave'), at: NOW });

    expect(result.rotated).toBe(true);
    expect(events).toContain(`stop:${first.unitName}`);
    expect(events.some((event) => event.endsWith(':overlap'))).toBe(false);
    expect(writes.filter((command) => (command as { kind?: string }).kind?.includes('rotate')).length).toBe(1);
    expect(ADMISSION_ID_PATTERN.test(result.admissionId)).toBe(true);
  });

  it('lets concurrent rotators commit and start exactly one replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-correction-cas-')); roots.push(root);
    const lease: Record<string, unknown> = {
      admission_id: OLD_ID, job_id: 'job-cas', status: 'admitted', expires_at: EXPIRES,
      credential_relative_path: `recovery/cleanup-credentials/${OLD_ID}.token`, credential_sha256: SHA,
      fence_generation: 1, fence_token_hash: SHA_B, unit_name: `osi-image-builder-cleanup@${OLD_ID}.service`,
    };
    const writes: unknown[] = []; const starts: string[] = []; let statusChecks = 0; let release!: () => void;
    const bothInitialStatusChecks = new Promise<void>((resolve) => { release = resolve; });
    const db = { prepare(sql: string) { return { get: () => sql.includes('cleanup_leases') ? lease : { cleanup_generation: 1 } }; } };
    const ownership = { apiWrite(command: Record<string, unknown>) {
      writes.push(command);
      if (command.kind === 'cleanup-admission-rotate') {
        if (lease.status !== 'admitted') return { ok: false, conflict: { kind: 'cas-lost', message: 'stale predecessor' } } as const;
        lease.status = 'expired';
      }
      return { ok: true, kind: 'committed', eventSeq: writes.length, value: undefined } as const;
    } };
    const systemdForBoth = {
      async start(unit: string) { starts.push(unit); },
      async stop() {},
      async isActive(unit: string) {
        if (unit === `osi-image-builder-cleanup@${OLD_ID}.service` && statusChecks < 2) {
          statusChecks += 1;
          if (statusChecks === 2) release();
          await bothInitialStatusChecks;
        }
        return false;
      },
    } satisfies RecoverySystemd;
    const makeRecovery = (fill: number) => createCleanupAdmissionRecovery({
      stateRoot: root, db: db as never, ownership: ownership as never, systemd: systemdForBoth,
      clock: { now: () => NOW }, crypto: { randomBytes: () => Buffer.alloc(32, fill) }, ownerUid: process.getuid?.() ?? 0,
    });
    const first = makeRecovery(9); const second = makeRecovery(10);
    await Promise.all([first.openAdmissions(), second.openAdmissions()]);
    const input = { jobId: 'job-cas', admissionId: OLD_ID, owner: 'api', expiresAt: EXPIRES, snapshot: snapshot('job-cas'), at: NOW };
    const results = await Promise.allSettled([first.reconcileAndStart(input), second.reconcileAndStart(input)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(writes.filter((command) => (command as { kind?: string }).kind === 'cleanup-admission-rotate')).toHaveLength(1);
    expect(starts).toHaveLength(1);
    expect(starts[0]).not.toBe(`osi-image-builder-cleanup@${OLD_ID}.service`);
  });

  it('rejects plain reconcile for failed/blocking predecessors and exposes corrected retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-correction-retry-')); roots.push(root);
    const lease = {
      admission_id: OLD_ID,
      job_id: 'job-retry',
      status: 'blocking',
      expires_at: EXPIRES,
      credential_relative_path: `recovery/cleanup-credentials/${OLD_ID}.token`,
      credential_sha256: SHA,
      fence_generation: 1,
      fence_token_hash: SHA_B,
      unit_name: `osi-image-builder-cleanup@${OLD_ID}.service`,
      blocker_code: 'CLEANUP_ADMISSION_BLOCKED',
      blocker_json: JSON.stringify({ reason: 'staging remained' }),
    };
    const { recovery, writes } = fakeRecovery({ root, lease, generation: 1 });
    await recovery.openAdmissions();
    await expect(recovery.reconcileAndStart({ jobId: 'job-retry', admissionId: OLD_ID, owner: 'api', expiresAt: EXPIRES, snapshot: snapshot('job-retry'), at: NOW })).rejects.toThrow(/failed|blocking.*explicit|retry/);
    const result = await recovery.retryCorrectedAndStart({
      jobId: 'job-retry', admissionId: OLD_ID, owner: 'api', expiresAt: EXPIRES, snapshot: snapshot('job-retry'), at: NOW,
      correctedSnapshot: snapshot('job-retry'), expectedBlockerCode: 'CLEANUP_ADMISSION_BLOCKED', expectedBlocker: { reason: 'staging remained' },
    });
    expect(result.rotated).toBe(true);
    expect(writes.at(-1)).toMatchObject({ kind: 'cleanup-admission-retry', previousAdmissionId: OLD_ID });
  });

  it('uses DB-backed credential identity after external rotation and exposes no process-local verifier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-correction-credential-')); roots.push(root);
    const { recovery } = fakeRecovery({ root });
    expect('verifyToken' in recovery).toBe(false);
    expect(createHash('sha256').update('old-credential').digest('hex')).not.toBe('');
  });

  it('holds directory descriptors through parent swaps for create, read, and prune', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-correction-descriptor-')); roots.push(root);
    const outside = await mkdtemp(join(tmpdir(), 'osi-cleanup-correction-outside-')); roots.push(outside);
    const base = createRecoveryFileSystem();
    let phase: 'create' | 'read' | 'prune' | null = 'create';
    const wrap = (directory: RecoveryDirectoryHandle, path: string): RecoveryDirectoryHandle => ({
      ...directory,
      async openDirectoryChild(name) {
        const child = await directory.openDirectoryChild(name);
        if (phase === 'create' && path === join(root, 'jobs') && name === 'job-descriptor') {
          await rename(join(path, name), join(path, `${name}-held`));
          await symlink(outside, join(path, name));
        }
        if (phase === 'read' && path.endsWith('/recovery') && name === 'cleanup-credentials') {
          await rename(join(path, name), join(path, `${name}-held`));
          await symlink(outside, join(path, name));
        }
        if (phase === 'prune' && path.endsWith('/recovery') && name === 'cleanup-credentials') {
          await rename(join(path, name), join(path, `${name}-held`));
          await symlink(outside, join(path, name));
        }
        return wrap(child, join(path, name));
      },
    });
    const fileSystem: RecoveryFileSystem = {
      openDirectory: async (path) => wrap(await base.openDirectory(path), path),
    };
    const first = fakeRecovery({ root, fileSystem });
    await first.recovery.openAdmissions();
    const admission = await first.recovery.admitAndStart({ jobId: 'job-descriptor', owner: 'api', expiresAt: EXPIRES, snapshot: snapshot('job-descriptor'), at: NOW });
    expect(await stat(join(root, 'jobs', 'job-descriptor-held', admission.credentialRelativePath))).toBeDefined();
    expect(await stat(outside)).toBeDefined();
    expect(await (await import('node:fs/promises')).readdir(outside)).toEqual([]);
    await unlink(join(root, 'jobs', 'job-descriptor'));
    await rename(join(root, 'jobs', 'job-descriptor-held'), join(root, 'jobs', 'job-descriptor'));

    phase = null;
    const readRecovery = fakeRecovery({
      root,
      fileSystem,
      lease: first.getLease(),
      generation: 1,
    });
    await readRecovery.recovery.openAdmissions();
    phase = 'read';
    await expect(readRecovery.recovery.reconcileAndStart({ jobId: 'job-descriptor', admissionId: admission.admissionId, owner: 'api', expiresAt: EXPIRES, snapshot: snapshot('job-descriptor'), at: NOW })).resolves.toMatchObject({ rotated: false });
    expect(await (await import('node:fs/promises')).readdir(outside)).toEqual([]);
    await unlink(join(root, 'jobs', 'job-descriptor', 'recovery', 'cleanup-credentials'));
    await rename(join(root, 'jobs', 'job-descriptor', 'recovery', 'cleanup-credentials-held'), join(root, 'jobs', 'job-descriptor', 'recovery', 'cleanup-credentials'));

    phase = 'prune';
    const orphanPath = join(root, 'jobs', 'job-descriptor', 'recovery', 'cleanup-credentials', 'cln_00000000000000000000000000.token');
    await writeFile(orphanPath, 'orphan\n', { mode: 0o600 });
    const pruneRecovery = fakeRecovery({ root, fileSystem, lease: first.getLease(), generation: 1 });
    await expect(pruneRecovery.recovery.pruneOrphanCredentials()).resolves.toBe(1);
    await expect(stat(join(outside, 'cln_00000000000000000000000000.token'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fsyncs each newly created ancestor before opening and verifying its child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-correction-fsync-chain-')); roots.push(root);
    const base = createRecoveryFileSystem();
    const events: string[] = [];
    const instrument = (directory: RecoveryDirectoryHandle, path: string): RecoveryDirectoryHandle => ({
      ...directory,
      async sync() { events.push(`sync:dir:${path}`); await directory.sync(); },
      async mkdirChild(name, mode) { events.push(`mkdir:${path}/${name}`); await directory.mkdirChild(name, mode); },
      async openDirectoryChild(name) { events.push(`open-dir:${path}/${name}`); return instrument(await directory.openDirectoryChild(name), `${path}/${name}`); },
      async openFileChild(name, flags, mode) {
        events.push(`open-file:${path}/${name}`);
        const file = await directory.openFileChild(name, flags, mode);
        const wrapped: RecoveryFileHandle = { ...file, async sync() { events.push(`sync:file:${path}/${name}`); await file.sync(); } };
        return wrapped;
      },
    });
    const fileSystem: RecoveryFileSystem = { openDirectory: async (path) => instrument(await base.openDirectory(path), path) };
    const { recovery } = fakeRecovery({ root, fileSystem });
    await recovery.openAdmissions();
    await recovery.admitAndStart({ jobId: 'job-fsync-chain', owner: 'api', expiresAt: EXPIRES, snapshot: snapshot('job-fsync-chain'), at: NOW });
    const expected = [
      `mkdir:${root}/jobs`, `sync:dir:${root}`, `open-dir:${root}/jobs`,
      `mkdir:${root}/jobs/job-fsync-chain`, `sync:dir:${root}/jobs`, `open-dir:${root}/jobs/job-fsync-chain`,
      `mkdir:${root}/jobs/job-fsync-chain/recovery`, `sync:dir:${root}/jobs/job-fsync-chain`, `open-dir:${root}/jobs/job-fsync-chain/recovery`,
      `mkdir:${root}/jobs/job-fsync-chain/recovery/cleanup-credentials`, `sync:dir:${root}/jobs/job-fsync-chain/recovery`, `open-dir:${root}/jobs/job-fsync-chain/recovery/cleanup-credentials`,
    ];
    let cursor = -1;
    for (const event of expected) { cursor = events.indexOf(event, cursor + 1); expect(cursor).toBeGreaterThan(-1); }
    expect(events.indexOf('sync:file:' + events.find((event) => event.startsWith('open-file:'))?.slice('open-file:'.length))).toBeGreaterThan(-1);
  });

  it('retries the held parent fsync when a child directory already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-correction-parent-retry-')); roots.push(root);
    const base = createRecoveryFileSystem();
    let rootSyncs = 0;
    const fileSystem: RecoveryFileSystem = {
      openDirectory: async (path) => {
        const directory = await base.openDirectory(path);
        if (path !== root) return directory;
        return {
          ...directory,
          async sync() {
            rootSyncs += 1;
            if (rootSyncs === 1) throw new Error('simulated parent fsync failure');
            await directory.sync();
          },
        };
      },
    };
    const { recovery } = fakeRecovery({ root, fileSystem });
    await recovery.openAdmissions();
    await expect(recovery.admitAndStart({ jobId: 'job-parent-retry', owner: 'api', expiresAt: EXPIRES, snapshot: snapshot('job-parent-retry'), at: NOW })).rejects.toThrow('simulated parent fsync failure');
    await recovery.admitAndStart({ jobId: 'job-parent-retry', owner: 'api', expiresAt: EXPIRES, snapshot: snapshot('job-parent-retry'), at: NOW });
    expect(rootSyncs).toBeGreaterThanOrEqual(2);
  });

  it('encodes lowercase time-ordered 48-bit ULID admission ids', () => {
    const timestamp = Date.parse('2026-07-27T12:00:00.000Z');
    const first = encodeAdmissionId(timestamp, new Uint8Array(10).fill(1));
    const sameMillisecond = encodeAdmissionId(timestamp, new Uint8Array(10).fill(2));
    const later = encodeAdmissionId(timestamp + 1, new Uint8Array(10).fill(1));

    expect(first).toMatch(ADMISSION_ID_PATTERN);
    expect(first.slice(4, 5)).toMatch(/[0-7]/);
    expect(first).not.toBe(sameMillisecond);
    expect(first < later).toBe(true);
    expect(decodeAdmissionId(first)).toEqual({ timestampMs: timestamp, randomness: new Uint8Array(10).fill(1) });
  });

  it.each(['jobs', 'job', 'recovery', 'cleanup-credentials'] as const)('fails closed when fsync ancestor boundary fails at %s', async (boundary) => {
    const root = await mkdtemp(join(tmpdir(), `osi-cleanup-correction-fsync-${boundary}-`)); roots.push(root);
    const base = createRecoveryFileSystem();
    const fileSystem: RecoveryFileSystem = {
      openDirectory: async (path) => {
        const directory = await base.openDirectory(path);
        const wrap = (current: RecoveryDirectoryHandle, currentPath: string): RecoveryDirectoryHandle => {
          const wrapped: RecoveryDirectoryHandle = {
          ...current,
          async sync() {
            if (boundary === 'jobs' && currentPath === root || boundary === 'job' && currentPath.endsWith('/jobs') || boundary === 'recovery' && currentPath.endsWith('/job-failure') || boundary === 'cleanup-credentials' && currentPath.endsWith('/recovery')) throw new Error(`fsync failure: ${boundary}`);
            await current.sync();
          },
          async openDirectoryChild(name) { return wrap(await current.openDirectoryChild(name), `${currentPath}/${name}`); },
        };
          return wrapped;
        };
        return wrap(directory, path);
      },
    };
    const { recovery, writes } = fakeRecovery({ root, fileSystem });
    await recovery.openAdmissions();
    await expect(recovery.admitAndStart({ jobId: 'job-failure', owner: 'api', expiresAt: EXPIRES, snapshot: snapshot('job-failure'), at: NOW })).rejects.toThrow(/fsync failure/);
    expect(writes).toHaveLength(0);
  });

  it('records migration 012 as additive expiration and predecessor evidence', () => {
    expect(MIGRATION_REGISTRY.at(-1)).toMatchObject({ version: 12, filename: '012_cleanup_admission_supersession_evidence.sql' });
  });
});
