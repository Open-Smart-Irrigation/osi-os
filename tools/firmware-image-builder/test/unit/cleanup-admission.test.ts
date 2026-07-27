import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ADMISSION_ID_PATTERN, createCleanupAdmissionRecovery, createRecoveryFileSystem, type RecoveryDirectoryHandle, type RecoveryFileSystem, type RecoverySystemd } from '../../api/src/recovery.js';

const NOW = '2026-07-27T12:00:00.000Z';
const EXPIRES = '2026-07-27T12:05:00.000Z';
const tempDirectories: string[] = [];

function snapshot(jobId: string) {
  return { runner: { unit: `osi-image-builder-runner@${jobId}.service`, owner: null, leaseExpiresAt: null, inactiveAt: NOW, observedAt: NOW }, state: 'starting' as const, container: { kind: 'absent' as const, globalLabelResult: 'no-match' as const, observedAt: NOW }, staging: { kind: 'absent' as const, path: null }, logs: { runner: 'absent' as const, docker: 'absent' as const, verifiedAt: NOW }, blocker: 'none' as const };
}

function fakeOwnership() { const writes: unknown[] = []; return { writes, apiWrite(command: unknown) { const kind = (command as { kind?: string }).kind; if (kind !== 'cleanup-credential-reserve' && kind !== 'cleanup-credential-abort') writes.push(command); return { ok: true, kind: 'committed', eventSeq: writes.length, value: undefined } as const; } }; }
function realFileSystem(): RecoveryFileSystem { return undefined as never; }
function fakeSystemd(events: string[] = []): RecoverySystemd { return { async start(unit) { events.push(`systemd:start:${unit}`); }, async stop(unit) { events.push(`systemd:stop:${unit}`); }, async isActive() { return false; } }; }
function recordingFileSystem(events: string[]): RecoveryFileSystem {
  const base = createRecoveryFileSystem();
  const wrap = (directory: RecoveryDirectoryHandle, path: string): RecoveryDirectoryHandle => ({
    ...directory,
    async sync() { events.push('parent:fsync'); await directory.sync(); },
    async openDirectoryChild(name) { return wrap(await directory.openDirectoryChild(name), join(path, name)); },
    async openFileChild(name, flags, mode) {
      const file = await directory.openFileChild(name, flags, mode);
      return { ...file, async sync() { events.push('file:fsync'); await file.sync(); } };
    },
  });
  return { openDirectory: async (path) => wrap(await base.openDirectory(path), path) };
}

function readFailureFileSystem(base: RecoveryFileSystem, shouldFail: () => boolean): RecoveryFileSystem {
  return {
    openDirectory: async (path) => {
      const wrap = async (directory: RecoveryDirectoryHandle): Promise<RecoveryDirectoryHandle> => ({
        ...directory,
        async openDirectoryChild(name) { return wrap(await directory.openDirectoryChild(name)); },
        async openFileChild(name, flags, mode) {
          if (shouldFail() && (flags & fsConstants.O_WRONLY) === 0 && (flags & fsConstants.O_DIRECTORY) === 0) {
            throw Object.assign(new Error('disk read failure'), { code: 'EIO' });
          }
          return directory.openFileChild(name, flags, mode);
        },
      });
      return wrap(await base.openDirectory(path));
    },
  };
}

function wrongOwnerFileSystem(base: RecoveryFileSystem, ownerUid: number, shouldSpoof: () => boolean): RecoveryFileSystem {
  return {
    openDirectory: async (path) => {
      const wrap = async (directory: RecoveryDirectoryHandle): Promise<RecoveryDirectoryHandle> => ({
        ...directory,
        async openDirectoryChild(name) { return wrap(await directory.openDirectoryChild(name)); },
        async openFileChild(name, flags, mode) {
          const handle = await directory.openFileChild(name, flags, mode);
          const readOnly = (flags & (fsConstants.O_WRONLY | fsConstants.O_RDWR)) === 0;
          if (!shouldSpoof() || !name.endsWith('.token') || !readOnly || (flags & fsConstants.O_DIRECTORY) !== 0) return handle;
          const stats = await handle.stat();
          return {
            ...handle,
            async stat() {
              return { uid: ownerUid + 1, mode: stats.mode, nlink: stats.nlink, isFile: () => stats.isFile(), isDirectory: () => stats.isDirectory(), isSymbolicLink: () => stats.isSymbolicLink() };
            },
          };
        },
      });
      return wrap(await base.openDirectory(path));
    },
  };
}

afterEach(async () => { const { rm } = await import('node:fs/promises'); await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('cleanup admission credentials', () => {
  it('generates safe admission IDs and the exact cleanup unit after the durable admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-unit-')); tempDirectories.push(root); const order: string[] = []; const ownership = fakeOwnership();
    const recovery = createCleanupAdmissionRecovery({ stateRoot: root, db: { prepare: () => ({ get: () => ({ cleanup_generation: 0 }) }) } as never, ownership, systemd: fakeSystemd(order), clock: { now: () => NOW }, crypto: { randomBytes: () => Buffer.from('0123456789abcdef') }, fileSystem: realFileSystem(), ownerUid: process.getuid?.() ?? 0, onAdmissionCommitted: () => { order.push('db:admission-committed'); } });
    await recovery.openAdmissions();
    const result = await recovery.admitAndStart({ jobId: 'job-unit', owner: 'api', expiresAt: EXPIRES, at: NOW, snapshot: snapshot('job-unit') });
    expect(result.admissionId).toMatch(/^cln_[0-9a-hj-km-np-tv-z]{26}$/); expect(ADMISSION_ID_PATTERN.test(result.admissionId)).toBe(true); expect(result.unitName).toBe(`osi-image-builder-cleanup@${result.admissionId}.service`); expect(order).toEqual(['db:admission-committed', `systemd:start:${result.unitName}`]); expect(ownership.writes[0]).toMatchObject({ kind: 'cleanup-admission', unitName: result.unitName, credentialRelativePath: `recovery/cleanup-credentials/${result.admissionId}.token` });
  });

  it('writes a fixed 0600 credential record and never sends the token to systemd or SQLite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-credential-')); tempDirectories.push(root); const ownership = fakeOwnership(); const start = vi.fn(async (unit: string) => { expect(unit).toMatch(/^osi-image-builder-cleanup@cln_[0-9a-hj-km-np-tv-z]{26}\.service$/); });
    const recovery = createCleanupAdmissionRecovery({ stateRoot: root, db: { prepare: () => ({ get: () => ({ cleanup_generation: 4 }) }) } as never, ownership, systemd: { start, isActive: async () => false }, clock: { now: () => NOW }, crypto: { randomBytes: () => Buffer.alloc(32, 7) }, fileSystem: realFileSystem(), ownerUid: process.getuid?.() ?? 0 });
    await recovery.openAdmissions();
    const result = await recovery.admitAndStart({ jobId: 'job-credential', owner: 'api', expiresAt: EXPIRES, at: NOW, snapshot: snapshot('job-credential') }); const path = join(root, 'jobs', 'job-credential', result.credentialRelativePath); const contents = await readFile(path, 'utf8'); const record = JSON.parse(contents) as { admissionId: string; generation: number; token: string };
    expect(record).toMatchObject({ admissionId: result.admissionId, generation: 5 }); expect((await stat(path)).mode & 0o777).toBe(0o600); expect((await stat(path)).uid).toBe(process.getuid?.() ?? 0); expect((await stat(join(root, 'jobs', 'job-credential', 'recovery', 'cleanup-credentials'))).mode & 0o777).toBe(0o700); expect(ownership.writes[0]).not.toHaveProperty('token'); expect(JSON.stringify(ownership.writes[0])).not.toContain(record.token); expect(start).toHaveBeenCalledOnce(); expect(createHash('sha256').update(record.token).digest('hex')).toBe((ownership.writes[0] as { fenceTokenHash: string }).fenceTokenHash);
  });

  it('fsyncs the credential file before its parent directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-fsync-')); tempDirectories.push(root); const events: string[] = []; const ownership = fakeOwnership();
    const recovery = createCleanupAdmissionRecovery({ stateRoot: root, db: { prepare: () => ({ get: () => ({ cleanup_generation: 0 }) }) } as never, ownership, systemd: fakeSystemd(), clock: { now: () => NOW }, crypto: { randomBytes: () => Buffer.alloc(32, 8) }, fileSystem: recordingFileSystem(events), ownerUid: process.getuid?.() ?? 0 });
    await recovery.openAdmissions();
    await recovery.admitAndStart({ jobId: 'job-fsync', owner: 'api', expiresAt: EXPIRES, at: NOW, snapshot: snapshot('job-fsync') }); expect(events).toEqual(['parent:fsync', 'parent:fsync', 'parent:fsync', 'parent:fsync', 'file:fsync', 'parent:fsync']);
  });

  it('fails closed on an unexpected credential filesystem read failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-fs-failure-')); tempDirectories.push(root); const events: string[] = []; const base = recordingFileSystem(events); let failRead = false; let lease: Record<string, unknown> | undefined; const writes: unknown[] = [];
    const ownerUid = process.getuid?.() ?? 0; const fileSystem = readFailureFileSystem(base, () => failRead); const ownership = { apiWrite(command: unknown) { const kind = (command as { kind: string }).kind; if (kind === 'cleanup-credential-reserve' || kind === 'cleanup-credential-abort') return { ok: true, kind: 'committed', eventSeq: writes.length, value: undefined } as const; writes.push(command); if (kind === 'cleanup-admission') { const value = command as Record<string, unknown>; lease = { admission_id: value.admissionId, job_id: 'job-fs-failure', status: 'admitted', expires_at: EXPIRES, credential_relative_path: value.credentialRelativePath, credential_sha256: value.credentialSha256, fence_generation: 1, fence_token_hash: value.fenceTokenHash, unit_name: value.unitName }; } return { ok: true, kind: 'committed', eventSeq: writes.length, value: undefined } as const; } }; const db = { prepare: (sql: string) => ({ get: () => sql.includes('cleanup_credential_reservations') ? undefined : sql.includes('cleanup_leases') ? lease : { cleanup_generation: 0 } }) } as never; let randomCall = 0; const recovery = createCleanupAdmissionRecovery({ stateRoot: root, db, ownership, systemd: fakeSystemd(), clock: { now: () => NOW }, crypto: { randomBytes: (size) => Buffer.alloc(size, ++randomCall) }, fileSystem, ownerUid }); await recovery.openAdmissions(); const first = await recovery.admitAndStart({ jobId: 'job-fs-failure', owner: 'api', expiresAt: EXPIRES, at: NOW, snapshot: snapshot('job-fs-failure') }); failRead = true;
    await expect(recovery.reconcileAndStart({ jobId: 'job-fs-failure', admissionId: first.admissionId, owner: 'api', expiresAt: EXPIRES, at: NOW, snapshot: snapshot('job-fs-failure') })).rejects.toThrow('cleanup credential filesystem read failed'); expect(writes).toHaveLength(1);
  });

  it('rotates a missing credential through a new generation and rejects the old token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-rotation-')); tempDirectories.push(root); const oldId = 'cln_00000000000000000000000000'; const ownership = fakeOwnership();
    const recovery = createCleanupAdmissionRecovery({
      stateRoot: root,
      db: {
        prepare: (sql: string) => ({
          get: () => sql.includes('cleanup_leases')
            ? {
                admission_id: oldId,
                job_id: 'job-rotate',
                status: 'admitted',
                expires_at: EXPIRES,
                credential_relative_path: `recovery/cleanup-credentials/${oldId}.token`,
                credential_sha256: '0'.repeat(64),
                fence_generation: 1,
                fence_token_hash: createHash('sha256').update('old-token').digest('hex'),
                unit_name: `osi-image-builder-cleanup@${oldId}.service`,
              }
            : { cleanup_generation: 1 },
        }),
      } as never,
      ownership,
      systemd: fakeSystemd(),
      clock: { now: () => NOW },
      crypto: { randomBytes: () => Buffer.alloc(32, 9) },
      fileSystem: realFileSystem(),
      ownerUid: process.getuid?.() ?? 0,
    });
    await recovery.openAdmissions(); const result = await recovery.reconcileAndStart({ jobId: 'job-rotate', admissionId: oldId, owner: 'api', expiresAt: EXPIRES, at: NOW, snapshot: snapshot('job-rotate') }); expect(result.rotated).toBe(true); expect(result.generation).toBe(2); expect(result.admissionId).not.toBe(oldId); expect(ownership.writes[0]).toMatchObject({ kind: 'cleanup-admission-rotate', previousAdmissionId: oldId });
  });

  it.each([
    ['corrupt credential', async (path: string) => { const { writeFile, chmod } = await import('node:fs/promises'); await writeFile(path, '{broken\n'); await chmod(path, 0o600); }],
    ['wrong mode credential', async (path: string) => { const { chmod } = await import('node:fs/promises'); await chmod(path, 0o644); }],
    ['mismatched credential', async (path: string) => { const { writeFile } = await import('node:fs/promises'); const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; await writeFile(path, JSON.stringify({ ...record, token: 'different-token-value' })); }],
    ['expired credential', async () => {}],
    ['wrong owner credential', async () => {}],
  ])('rotates a %s without starting the invalid predecessor', async (_name, mutate) => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-invalid-')); tempDirectories.push(root); const writes: unknown[] = []; let lease: Record<string, unknown> | undefined; const ownership = { writes, apiWrite(command: unknown) { const kind = (command as { kind: string }).kind; if (kind === 'cleanup-credential-reserve' || kind === 'cleanup-credential-abort') return { ok: true, kind: 'committed', eventSeq: writes.length, value: undefined } as const; writes.push(command); if (kind === 'cleanup-admission') { const value = command as Record<string, unknown>; lease = { admission_id: value.admissionId, job_id: 'job-invalid', status: 'admitted', expires_at: EXPIRES, credential_relative_path: value.credentialRelativePath, credential_sha256: value.credentialSha256, fence_generation: 1, fence_token_hash: value.fenceTokenHash, unit_name: value.unitName }; } return { ok: true, kind: 'committed', eventSeq: writes.length, value: undefined } as const; } };
    const ownerUid = process.getuid?.() ?? 0; let wrongOwner = false; const baseFileSystem = recordingFileSystem([]); const fileSystem = wrongOwnerFileSystem(baseFileSystem, ownerUid, () => wrongOwner); const db = { prepare: (sql: string) => ({ get: () => sql.includes('cleanup_credential_reservations') ? undefined : sql.includes('cleanup_leases') ? lease : { cleanup_generation: 0 } }) } as never; const systemd = fakeSystemd(); let randomCall = 0; const recovery = createCleanupAdmissionRecovery({ stateRoot: root, db, ownership, systemd, clock: { now: () => NOW }, crypto: { randomBytes: (size) => Buffer.alloc(size, ++randomCall) }, fileSystem, ownerUid }); await recovery.openAdmissions(); const first = await recovery.admitAndStart({ jobId: 'job-invalid', owner: 'api', expiresAt: EXPIRES, at: NOW, snapshot: snapshot('job-invalid') }); const path = join(root, 'jobs', 'job-invalid', first.credentialRelativePath); await mutate(path); wrongOwner = _name === 'wrong owner credential'; const at = _name === 'expired credential' ? '2026-07-27T12:06:00.000Z' : NOW; const rotated = await recovery.reconcileAndStart({ jobId: 'job-invalid', admissionId: first.admissionId, owner: 'api', expiresAt: '2026-07-27T12:10:00.000Z', at, snapshot: snapshot('job-invalid') }); expect(rotated.rotated).toBe(true); expect(writes.at(-1)).toMatchObject({ kind: 'cleanup-admission-rotate', previousAdmissionId: first.admissionId });
  });
});
