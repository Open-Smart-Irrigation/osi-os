import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat as nodeLstat, mkdir as nodeMkdir, open as nodeOpen, readdir as nodeReaddir, unlink as nodeUnlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { CleanupSnapshot, OwnershipResult, ApiWriteCommand, OwnershipStore } from './ownership.js';

export const ADMISSION_ID_PATTERN = /^cln_[0-9a-hj-km-np-tv-z]{26}$/;
const ADMISSION_BODY_PATTERN = /^[0-9a-hj-km-np-tv-z]{26}$/;
const CREDENTIAL_NAME_PATTERN = /^([0-9a-hj-km-np-tv-z]{26})\.token$/;
const CREDENTIAL_DIRECTORY = 'recovery/cleanup-credentials';
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

export interface RecoveryStats {
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
  readonly isFile: () => boolean;
  readonly isDirectory: () => boolean;
  readonly isSymbolicLink: () => boolean;
}

export interface RecoveryFileHandle {
  readonly writeFile: (contents: Uint8Array) => Promise<void>;
  readonly readFile: () => Promise<Buffer>;
  readonly sync: () => Promise<void>;
  readonly stat: () => Promise<RecoveryStats>;
  readonly close: () => Promise<void>;
}

export interface RecoveryFileSystem {
  readonly lstat: (path: string) => Promise<RecoveryStats>;
  readonly mkdir: (path: string, mode: number) => Promise<void>;
  readonly open: (path: string, flags: number, mode?: number) => Promise<RecoveryFileHandle>;
  readonly readdir: (path: string) => Promise<readonly string[]>;
  readonly unlink: (path: string) => Promise<void>;
}

export interface RecoveryCrypto {
  readonly randomBytes: (size: number) => Uint8Array;
  readonly sha256: (value: Uint8Array | string) => string;
}

export interface RecoverySystemd {
  readonly start: (unit: string) => Promise<void>;
  readonly isActive: (unit: string) => Promise<boolean>;
}

export interface RecoveryClock {
  readonly now: () => string;
}

export interface RecoveryDatabase {
  readonly prepare: (sql: string) => { readonly get: (...parameters: readonly unknown[]) => unknown; readonly all?: (...parameters: readonly unknown[]) => readonly unknown[] };
}

export interface CleanupAdmissionRecoveryOptions {
  readonly stateRoot: string;
  readonly db: DatabaseSync | RecoveryDatabase;
  readonly ownership: Pick<OwnershipStore, 'apiWrite'>;
  readonly systemd: RecoverySystemd;
  readonly fileSystem?: RecoveryFileSystem;
  readonly crypto?: Partial<RecoveryCrypto>;
  readonly clock?: RecoveryClock;
  readonly ownerUid?: number;
  readonly onAdmissionCommitted?: () => void;
}

export interface CleanupAdmissionInput {
  readonly jobId: string;
  readonly owner: string;
  readonly expiresAt: string;
  readonly snapshot: CleanupSnapshot;
  readonly at?: string;
}

export interface ReconcileAdmissionInput extends CleanupAdmissionInput {
  readonly admissionId: string;
}

export interface CleanupAdmissionResult {
  readonly admissionId: string;
  readonly generation: number;
  readonly unitName: string;
  readonly credentialRelativePath: string;
  readonly credentialSha256: string;
  readonly rotated: boolean;
  readonly started: true;
}

export class RecoveryBoundaryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RecoveryBoundaryError';
  }
}

export class CleanupCredentialInvalidError extends RecoveryBoundaryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CleanupCredentialInvalidError';
  }
}

function defaultFileSystem(): RecoveryFileSystem {
  return {
    lstat: async (path) => nodeLstat(path),
    mkdir: async (path, mode) => { await nodeMkdir(path, { mode }); },
    open: async (path, flags, mode) => {
      const handle = await nodeOpen(path, flags, mode);
      return {
        writeFile: async (contents) => { await handle.writeFile(contents); },
        readFile: async () => handle.readFile(),
        sync: async () => { await handle.sync(); },
        stat: async () => handle.stat(),
        close: async () => { await handle.close(); },
      };
    },
    readdir: async (path) => nodeReaddir(path, { encoding: 'utf8' }),
    unlink: async (path) => { await nodeUnlink(path); },
  };
}

const defaultCrypto: RecoveryCrypto = {
  randomBytes: (size) => nodeRandomBytes(size),
  sha256: (value) => createHash('sha256').update(value).digest('hex'),
};

function safeSegment(value: string, field: string): void {
  if (value.length === 0 || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) throw new RecoveryBoundaryError(`${field} is not a safe path segment`);
}

function modeOf(stats: RecoveryStats): number { return stats.mode & 0o7777; }

function verifyDirectory(stats: RecoveryStats, path: string, ownerUid: number): void {
  if (stats.isSymbolicLink() || !stats.isDirectory() || stats.uid !== ownerUid || modeOf(stats) !== DIRECTORY_MODE) throw new RecoveryBoundaryError(`unsafe recovery directory: ${path}`);
}

function verifyCredentialFile(stats: RecoveryStats, path: string, ownerUid: number): void {
  if (stats.isSymbolicLink() || !stats.isFile() || stats.uid !== ownerUid || modeOf(stats) !== FILE_MODE || stats.nlink !== 1) throw new RecoveryBoundaryError(`unsafe cleanup credential: ${path}`);
}

function encodeAdmissionId(bytes: Uint8Array): string {
  if (bytes.length < 16) throw new RecoveryBoundaryError('admission ID entropy is too short');
  let value = 0n;
  for (const byte of bytes.subarray(0, 16)) value = (value << 8n) | BigInt(byte);
  let body = '';
  for (let index = 0; index < 26; index += 1) {
    body = CROCKFORD[Number(value & 31n)]! + body;
    value >>= 5n;
  }
  if (!ADMISSION_BODY_PATTERN.test(body)) throw new RecoveryBoundaryError('generated admission ID is invalid');
  return `cln_${body}`;
}

function credentialRecord(admissionId: string, generation: number, token: string): Buffer {
  return Buffer.from(JSON.stringify({ admissionId, generation, token }) + '\n', 'utf8');
}

function parseCredential(bytes: Uint8Array): { readonly admissionId: string; readonly generation: number; readonly token: string } {
  if (bytes.length === 0 || bytes.length > MAX_CREDENTIAL_BYTES) throw new RecoveryBoundaryError('cleanup credential size is invalid');
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown; } catch (error) { throw new RecoveryBoundaryError('cleanup credential is corrupt', { cause: error }); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RecoveryBoundaryError('cleanup credential record is invalid');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'admissionId,generation,token' || typeof record.admissionId !== 'string' || !ADMISSION_ID_PATTERN.test(record.admissionId) || !Number.isSafeInteger(record.generation) || Number(record.generation) <= 0 || typeof record.token !== 'string' || record.token.length < 16) throw new RecoveryBoundaryError('cleanup credential record fields are invalid');
  return { admissionId: record.admissionId, generation: Number(record.generation), token: record.token };
}

function ownershipCommandResult(result: OwnershipResult): void {
  if (!result.ok) throw new RecoveryBoundaryError(`cleanup admission CAS rejected: ${result.conflict.kind}: ${result.conflict.message}`);
}

export function createCleanupAdmissionRecovery(options: CleanupAdmissionRecoveryOptions) {
  const fileSystem = options.fileSystem ?? defaultFileSystem();
  const crypto: RecoveryCrypto = { ...defaultCrypto, ...options.crypto };
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const ownerUid = options.ownerUid ?? (process.getuid?.() ?? 0);
  const activeTokenHashes = new Map<string, string>();

  async function ensureDirectory(path: string, create: boolean): Promise<boolean> {
    try {
      const stats = await fileSystem.lstat(path);
      verifyDirectory(stats, path, ownerUid);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) {
        if (error instanceof RecoveryBoundaryError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new RecoveryBoundaryError(`cannot inspect recovery directory: ${path}`, { cause: error });
        return false;
      }
      await fileSystem.mkdir(path, DIRECTORY_MODE);
      const stats = await fileSystem.lstat(path);
      verifyDirectory(stats, path, ownerUid);
      return true;
    }
  }

  async function credentialDirectory(jobId: string, create: boolean): Promise<string | null> {
    safeSegment(jobId, 'job ID');
    const rootStats = await fileSystem.lstat(options.stateRoot);
    verifyDirectory(rootStats, options.stateRoot, ownerUid);
    let current = join(options.stateRoot, 'jobs');
    if (!(await ensureDirectory(current, create))) return null;
    for (const part of [jobId, 'recovery', 'cleanup-credentials']) {
      current = join(current, part);
      if (!(await ensureDirectory(current, create))) return null;
    }
    return current;
  }

  async function fsyncParent(path: string): Promise<void> {
    const handle = await fileSystem.open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async function writeCredential(jobId: string, admissionId: string, generation: number, token: string): Promise<{ readonly relativePath: string; readonly sha256: string }> {
    try {
      const directory = await credentialDirectory(jobId, true);
      if (directory === null) throw new RecoveryBoundaryError('cleanup credential directory is unavailable');
      const relativePath = `${CREDENTIAL_DIRECTORY}/${admissionId}.token`;
      const path = join(directory, `${admissionId}.token`);
      const contents = credentialRecord(admissionId, generation, token);
      const handle = await fileSystem.open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, FILE_MODE);
      try {
        await handle.writeFile(contents);
        await handle.sync();
        verifyCredentialFile(await handle.stat(), path, ownerUid);
      } finally { await handle.close(); }
      await fsyncParent(directory);
      return { relativePath, sha256: crypto.sha256(contents) };
    } catch (error) {
      if (error instanceof RecoveryBoundaryError) throw error;
      throw new RecoveryBoundaryError('cleanup credential filesystem operation failed', { cause: error });
    }
  }

  function newAdmission(): { readonly admissionId: string; readonly token: string } {
    const admissionId = encodeAdmissionId(crypto.randomBytes(16));
    const token = Buffer.from(crypto.randomBytes(32)).toString('base64url');
    return { admissionId, token };
  }

  function jobGeneration(jobId: string): number {
    const row = options.db.prepare('SELECT cleanup_generation FROM jobs WHERE job_id=?').get(jobId) as { cleanup_generation?: unknown } | undefined;
    if (!row || !Number.isSafeInteger(Number(row.cleanup_generation)) || Number(row.cleanup_generation) < 0) throw new RecoveryBoundaryError('job cleanup generation is unavailable');
    return Number(row.cleanup_generation) + 1;
  }

  function dbLease(admissionId: string, jobId: string): Record<string, unknown> | null {
    const row = options.db.prepare('SELECT * FROM cleanup_leases WHERE admission_id=? AND job_id=?').get(admissionId, jobId) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  async function start(unitName: string): Promise<void> {
    const match = unitName.match(/^osi-image-builder-cleanup@(cln_[0-9a-hj-km-np-tv-z]{26})\.service$/);
    if (!match || unitName !== `osi-image-builder-cleanup@${match[1]}.service`) throw new RecoveryBoundaryError('cleanup unit is not exact');
    await options.systemd.start(unitName);
  }

  async function admitAndStart(input: CleanupAdmissionInput): Promise<CleanupAdmissionResult> {
    const at = input.at ?? clock.now();
    safeSegment(input.jobId, 'job ID');
    const generation = jobGeneration(input.jobId);
    const material = newAdmission();
    const credential = await writeCredential(input.jobId, material.admissionId, generation, material.token);
    const unitName = `osi-image-builder-cleanup@${material.admissionId}.service`;
    const command: ApiWriteCommand = { kind: 'cleanup-admission', jobId: input.jobId, admissionId: material.admissionId, owner: input.owner, unitName, expiresAt: input.expiresAt, credentialRelativePath: credential.relativePath, credentialSha256: credential.sha256, fenceTokenHash: crypto.sha256(material.token), snapshot: input.snapshot, at };
    ownershipCommandResult(options.ownership.apiWrite(command));
    activeTokenHashes.set(material.admissionId, command.fenceTokenHash);
    options.onAdmissionCommitted?.();
    await start(unitName);
    return { admissionId: material.admissionId, generation, unitName, credentialRelativePath: credential.relativePath, credentialSha256: credential.sha256, rotated: false, started: true };
  }

  async function readCredential(jobId: string, lease: Record<string, unknown>): Promise<{ readonly token: string; readonly tokenHash: string }> {
    const relativePath = lease.credential_relative_path;
    const admissionId = lease.admission_id;
    if (typeof relativePath !== 'string' || relativePath !== `${CREDENTIAL_DIRECTORY}/${admissionId}.token` || typeof admissionId !== 'string' || !ADMISSION_ID_PATTERN.test(admissionId)) throw new RecoveryBoundaryError('cleanup credential path is invalid');
    const directory = await credentialDirectory(jobId, false);
    if (directory === null) throw new CleanupCredentialInvalidError('cleanup credential directory is missing');
    const path = join(directory, `${admissionId}.token`);
    let stats: RecoveryStats;
    try { stats = await fileSystem.lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CleanupCredentialInvalidError('cleanup credential is missing', { cause: error });
      throw new RecoveryBoundaryError('cleanup credential filesystem read failed', { cause: error });
    }
    try { verifyCredentialFile(stats, path, ownerUid); }
    catch (error) { if (error instanceof RecoveryBoundaryError) throw new CleanupCredentialInvalidError(error.message, { cause: error }); throw error; }
    let handle: RecoveryFileHandle;
    try { handle = await fileSystem.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ELOOP') throw new CleanupCredentialInvalidError('cleanup credential is unsafe or missing', { cause: error });
      throw new RecoveryBoundaryError('cleanup credential filesystem read failed', { cause: error });
    }
    let bytes: Buffer;
    try {
      try { verifyCredentialFile(await handle.stat(), path, ownerUid); } catch (error) { if (error instanceof RecoveryBoundaryError) throw new CleanupCredentialInvalidError(error.message, { cause: error }); throw error; }
      try { bytes = await handle.readFile(); } catch (error) { throw new RecoveryBoundaryError('cleanup credential filesystem read failed', { cause: error }); }
    } finally { await handle.close(); }
    let record: { readonly admissionId: string; readonly generation: number; readonly token: string };
    try { record = parseCredential(bytes); } catch (error) { if (error instanceof RecoveryBoundaryError) throw new CleanupCredentialInvalidError(error.message, { cause: error }); throw error; }
    if (record.admissionId !== admissionId || record.generation !== Number(lease.fence_generation) || crypto.sha256(bytes) !== lease.credential_sha256 || crypto.sha256(record.token) !== lease.fence_token_hash) throw new CleanupCredentialInvalidError('cleanup credential does not match the committed admission');
    return { token: record.token, tokenHash: crypto.sha256(record.token) };
  }

  async function reconcileAndStart(input: ReconcileAdmissionInput): Promise<CleanupAdmissionResult> {
    const at = input.at ?? clock.now();
    const old = dbLease(input.admissionId, input.jobId);
    if (!old) throw new RecoveryBoundaryError('cleanup admission does not exist');
    const oldUnit = old.unit_name;
    if (typeof oldUnit !== 'string' || oldUnit !== `osi-image-builder-cleanup@${input.admissionId}.service`) throw new RecoveryBoundaryError('persisted cleanup unit is invalid');
    if (!['admitted', 'claimed', 'failed', 'blocking'].includes(String(old.status))) throw new RecoveryBoundaryError('cleanup admission is not rotatable: stale predecessor');
    if (await options.systemd.isActive(oldUnit)) throw new RecoveryBoundaryError('cleanup worker is active; recovery deferred');
    let valid = true;
    try { await readCredential(input.jobId, old); } catch (error) { if (error instanceof CleanupCredentialInvalidError) valid = false; else throw error; }
    if (valid && typeof old.expires_at === 'string' && old.expires_at > at && old.status === 'admitted') {
      activeTokenHashes.set(input.admissionId, String(old.fence_token_hash));
      await start(oldUnit);
      return { admissionId: input.admissionId, generation: Number(old.fence_generation), unitName: oldUnit, credentialRelativePath: String(old.credential_relative_path), credentialSha256: String(old.credential_sha256), rotated: false, started: true };
    }
    const generation = jobGeneration(input.jobId);
    const material = newAdmission();
    const credential = await writeCredential(input.jobId, material.admissionId, generation, material.token);
    const unitName = `osi-image-builder-cleanup@${material.admissionId}.service`;
    const command: ApiWriteCommand = { kind: 'cleanup-admission-rotate', previousAdmissionId: input.admissionId, jobId: input.jobId, admissionId: material.admissionId, owner: input.owner, unitName, expiresAt: input.expiresAt, credentialRelativePath: credential.relativePath, credentialSha256: credential.sha256, fenceTokenHash: crypto.sha256(material.token), snapshot: input.snapshot, at };
    ownershipCommandResult(options.ownership.apiWrite(command));
    activeTokenHashes.delete(input.admissionId);
    activeTokenHashes.set(material.admissionId, command.fenceTokenHash);
    options.onAdmissionCommitted?.();
    await start(unitName);
    return { admissionId: material.admissionId, generation, unitName, credentialRelativePath: credential.relativePath, credentialSha256: credential.sha256, rotated: true, started: true };
  }

  async function pruneOrphanCredentials(): Promise<number> {
    const jobsRoot = join(options.stateRoot, 'jobs');
    if (!(await ensureDirectory(jobsRoot, false))) return 0;
    let removed = 0;
    for (const jobId of await fileSystem.readdir(jobsRoot)) {
      try { safeSegment(jobId, 'job ID'); } catch { continue; }
      const directory = await credentialDirectory(jobId, false);
      if (directory === null) continue;
      for (const name of await fileSystem.readdir(directory)) {
        const match = name.startsWith('cln_') ? name.slice('cln_'.length).match(CREDENTIAL_NAME_PATTERN) : null;
        if (!match) continue;
        const admissionId = `cln_${match[1]}`;
        const path = join(directory, name);
        let stats: RecoveryStats;
        try { stats = await fileSystem.lstat(path); verifyCredentialFile(stats, path, ownerUid); } catch { continue; }
        const matching = options.db.prepare('SELECT 1 FROM cleanup_leases WHERE job_id=? AND admission_id=?').get(jobId, admissionId);
        if (matching !== undefined) continue;
        await fileSystem.unlink(path);
        await fsyncParent(directory);
        removed += 1;
      }
    }
    return removed;
  }

  function verifyToken(token: string, admissionId: string): boolean {
    if (!ADMISSION_ID_PATTERN.test(admissionId) || activeTokenHashes.get(admissionId) !== crypto.sha256(token)) return false;
    return true;
  }

  return Object.freeze({ admitAndStart, reconcileAndStart, pruneOrphanCredentials, verifyToken });
}
