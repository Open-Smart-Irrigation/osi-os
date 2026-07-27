import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat as nodeLstat, mkdir as nodeMkdir, open as nodeOpen, readdir as nodeReaddir, unlink as nodeUnlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { BuilderErrorCode } from '../../domain/types.js';
import type {
  CleanupAdmissionPredecessor,
  CleanupAdmissionPredecessorStatus,
  CleanupSnapshot,
  OwnershipResult,
  ApiWriteCommand,
  OwnershipStore,
} from './ownership.js';
import type { JsonObject } from './store.js';

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

export interface RecoveryDirectoryHandle extends RecoveryFileHandle {
  readonly openDirectoryChild: (name: string) => Promise<RecoveryDirectoryHandle>;
  readonly mkdirChild: (name: string, mode: number) => Promise<void>;
  readonly openFileChild: (name: string, flags: number, mode?: number) => Promise<RecoveryFileHandle>;
  readonly readdir: () => Promise<readonly string[]>;
  readonly unlinkChild: (name: string) => Promise<void>;
}

export interface RecoveryDescriptorFileSystem {
  readonly openDirectory: (path: string) => Promise<RecoveryDirectoryHandle>;
}

// Retained as an adapter seam for Task 19 tests and callers. Production uses descriptors.
export interface RecoveryLegacyFileSystem {
  readonly lstat: (path: string) => Promise<RecoveryStats>;
  readonly mkdir: (path: string, mode: number) => Promise<void>;
  readonly open: (path: string, flags: number, mode?: number) => Promise<RecoveryFileHandle>;
  readonly readdir: (path: string) => Promise<readonly string[]>;
  readonly unlink: (path: string) => Promise<void>;
}

export type RecoveryFileSystem = RecoveryDescriptorFileSystem | RecoveryLegacyFileSystem;

export interface RecoveryCrypto {
  readonly randomBytes: (size: number) => Uint8Array;
  readonly sha256: (value: Uint8Array | string) => string;
}

export interface RecoverySystemd {
  readonly start: (unit: string) => Promise<void>;
  readonly isActive: (unit: string) => Promise<boolean>;
  readonly stop?: (unit: string) => Promise<void>;
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

export interface CorrectedRetryAdmissionInput extends ReconcileAdmissionInput {
  readonly correctedSnapshot: CleanupSnapshot;
  readonly expectedBlockerCode: BuilderErrorCode;
  readonly expectedBlocker: JsonObject;
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

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}

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

function closeErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? `: ${error.message}` : '';
}

function procChildPath(fd: number, name: string): string {
  safeSegment(name, 'directory child');
  return `/proc/self/fd/${fd}/${name}`;
}

function wrapFileHandle(handle: import('node:fs/promises').FileHandle): RecoveryFileHandle {
  return {
    writeFile: async (contents) => { await handle.writeFile(contents); },
    readFile: async () => handle.readFile(),
    sync: async () => { await handle.sync(); },
    stat: async () => handle.stat(),
    close: async () => { await handle.close(); },
  };
}

async function openDefaultDirectory(path: string): Promise<RecoveryDirectoryHandle> {
  const handle = await nodeOpen(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  const file = wrapFileHandle(handle);
  try {
    if (!handle.stat) throw new RecoveryBoundaryError(`cannot inspect recovery directory: ${path}`);
    return {
      ...file,
      openDirectoryChild: async (name) => openDefaultDirectory(procChildPath(handle.fd, name)),
      mkdirChild: async (name, mode) => { await nodeMkdir(procChildPath(handle.fd, name), { mode }); },
      openFileChild: async (name, flags, mode) => wrapFileHandle(await nodeOpen(procChildPath(handle.fd, name), flags, mode)),
      readdir: async () => nodeReaddir(`/proc/self/fd/${handle.fd}`, { encoding: 'utf8' }),
      unlinkChild: async (name) => { await nodeUnlink(procChildPath(handle.fd, name)); },
    };
  } catch (error) {
    await file.close();
    throw error;
  }
}

export function createRecoveryFileSystem(): RecoveryDescriptorFileSystem {
  return { openDirectory: openDefaultDirectory };
}

function legacyFileSystem(fileSystem: RecoveryLegacyFileSystem): RecoveryDescriptorFileSystem {
  const legacy = fileSystem;
  async function openDirectory(path: string): Promise<RecoveryDirectoryHandle> {
    const handle = await legacy.open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    return {
      ...handle,
      openDirectoryChild: async (name) => openDirectory(join(path, name)),
      mkdirChild: async (name, mode) => { await legacy.mkdir(join(path, name), mode); },
      openFileChild: async (name, flags, mode) => legacy.open(join(path, name), flags | fsConstants.O_NOFOLLOW, mode),
      readdir: async () => legacy.readdir(path),
      unlinkChild: async (name) => { await legacy.unlink(join(path, name)); },
    };
  }
  return { openDirectory };
}

interface DirectoryLease {
  readonly directory: RecoveryDirectoryHandle;
  readonly close: () => Promise<void>;
}

async function closeHandles(handles: readonly RecoveryFileHandle[]): Promise<void> {
  let firstError: unknown;
  for (const handle of handles.slice().reverse()) {
    try { await handle.close(); } catch (error) { firstError ??= error; }
  }
  if (firstError !== undefined) throw firstError;
}

export function createCleanupAdmissionRecovery(options: CleanupAdmissionRecoveryOptions) {
  const suppliedFileSystem = options.fileSystem;
  const fileSystem: RecoveryDescriptorFileSystem = suppliedFileSystem === undefined
    ? createRecoveryFileSystem()
    : 'openDirectory' in suppliedFileSystem
      ? suppliedFileSystem
      : legacyFileSystem(suppliedFileSystem);
  const crypto: RecoveryCrypto = { randomBytes: (size) => nodeRandomBytes(size), sha256: (value) => createHash('sha256').update(value).digest('hex'), ...options.crypto };
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const ownerUid = options.ownerUid ?? (process.getuid?.() ?? 0);
  const jobLocks = new Map<string, Promise<void>>();
  let admissionSequence = 0;
  let admissionsOpen = false;
  let lifecycleTail = Promise.resolve();

  async function withLifecycleLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = lifecycleTail;
    let release!: () => void;
    lifecycleTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }

  async function withJobLock<T>(jobId: string, work: () => Promise<T>): Promise<T> {
    const previous = jobLocks.get(jobId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    jobLocks.set(jobId, current);
    await previous;
    try { return await work(); } finally {
      release();
      if (jobLocks.get(jobId) === current) jobLocks.delete(jobId);
    }
  }

  function requireAdmissionsOpen(): void {
    if (!admissionsOpen) throw new RecoveryBoundaryError('cleanup admissions are not open');
  }

  async function openChildDirectory(parent: RecoveryDirectoryHandle, name: string, path: string, create: boolean): Promise<RecoveryDirectoryHandle | null> {
    safeSegment(name, 'recovery directory child');
    try {
      const child = await parent.openDirectoryChild(name);
      verifyDirectory(await child.stat(), path, ownerUid);
      return child;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' || !create) {
        if (errorCode(error) === 'ENOENT' && !create) return null;
        throw error;
      }
      try {
        await parent.mkdirChild(name, DIRECTORY_MODE);
        await parent.sync();
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== 'EEXIST') throw mkdirError;
      }
      const child = await parent.openDirectoryChild(name);
      verifyDirectory(await child.stat(), path, ownerUid);
      return child;
    }
  }

  async function directoryLease(jobId: string, create: boolean): Promise<DirectoryLease | null> {
    safeSegment(jobId, 'job ID');
    const handles: RecoveryFileHandle[] = [];
    try {
      const root = await fileSystem.openDirectory(options.stateRoot);
      handles.push(root);
      verifyDirectory(await root.stat(), options.stateRoot, ownerUid);
      const jobs = await openChildDirectory(root, 'jobs', join(options.stateRoot, 'jobs'), create);
      if (jobs === null) return await closeAndNull(handles);
      handles.push(jobs);
      const job = await openChildDirectory(jobs, jobId, join(options.stateRoot, 'jobs', jobId), create);
      if (job === null) return await closeAndNull(handles);
      handles.push(job);
      const recovery = await openChildDirectory(job, 'recovery', join(options.stateRoot, 'jobs', jobId, 'recovery'), create);
      if (recovery === null) return await closeAndNull(handles);
      handles.push(recovery);
      const credentials = await openChildDirectory(recovery, 'cleanup-credentials', join(options.stateRoot, 'jobs', jobId, CREDENTIAL_DIRECTORY), create);
      if (credentials === null) return await closeAndNull(handles);
      handles.push(credentials);
      return { directory: credentials, close: async () => { await closeHandles(handles); } };
    } catch (error) {
      try { await closeHandles(handles); } catch (closeError) { throw new RecoveryBoundaryError('recovery directory close failed', { cause: closeError }); }
      throw error;
    }
  }

  async function closeAndNull(handles: RecoveryFileHandle[]): Promise<null> {
    await closeHandles(handles);
    return null;
  }

  async function writeCredential(jobId: string, admissionId: string, generation: number, token: string): Promise<{ readonly relativePath: string; readonly sha256: string }> {
    const lease = await directoryLease(jobId, true);
    if (lease === null) throw new RecoveryBoundaryError('cleanup credential directory is unavailable');
    const filename = `${admissionId}.token`;
    const relativePath = `${CREDENTIAL_DIRECTORY}/${filename}`;
    const contents = credentialRecord(admissionId, generation, token);
    try {
      const handle = await lease.directory.openFileChild(filename, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, FILE_MODE);
      try {
        await handle.writeFile(contents);
        await handle.sync();
        verifyCredentialFile(await handle.stat(), relativePath, ownerUid);
      } finally { await handle.close(); }
      await lease.directory.sync();
      return { relativePath, sha256: crypto.sha256(contents) };
    } catch (error) {
      throw new RecoveryBoundaryError(`cleanup credential filesystem operation failed${closeErrorMessage(error)}`, { cause: error });
    } finally {
      await lease.close();
    }
  }

  function newAdmission(): { readonly admissionId: string; readonly token: string } {
    admissionSequence += 1;
    const idBytes = new Uint8Array(crypto.randomBytes(16));
    for (let index = 0, value = admissionSequence; index < 8; index += 1, value = Math.floor(value / 256)) idBytes[15 - index] = (idBytes[15 - index]! ^ (value & 0xff));
    const admissionId = encodeAdmissionId(idBytes);
    const tokenBytes = new Uint8Array(crypto.randomBytes(32));
    for (let index = 0, value = admissionSequence; index < 8; index += 1, value = Math.floor(value / 256)) tokenBytes[31 - index] = tokenBytes[31 - index]! ^ (value & 0xff);
    return { admissionId, token: Buffer.from(tokenBytes).toString('base64url') };
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

  function exactUnit(admissionId: string, unitName: unknown): string {
    if (typeof unitName !== 'string' || !ADMISSION_ID_PATTERN.test(admissionId) || unitName !== `osi-image-builder-cleanup@${admissionId}.service`) throw new RecoveryBoundaryError('persisted cleanup unit is invalid');
    return unitName;
  }

  async function start(unitName: string): Promise<void> {
    const admissionId = unitName.slice('osi-image-builder-cleanup@'.length, -'.service'.length);
    exactUnit(admissionId, unitName);
    await options.systemd.start(unitName);
  }

  async function stopAndConfirmInactive(unitName: string): Promise<void> {
    const admissionId = unitName.slice('osi-image-builder-cleanup@'.length, -'.service'.length);
    exactUnit(admissionId, unitName);
    if (!options.systemd.stop) throw new RecoveryBoundaryError('cleanup predecessor stop capability is unavailable');
    await options.systemd.stop(unitName);
    if (await options.systemd.isActive(unitName)) throw new RecoveryBoundaryError(`cleanup predecessor remains active: ${unitName}`);
  }

  async function readCredential(jobId: string, lease: Record<string, unknown>): Promise<void> {
    const admissionId = typeof lease.admission_id === 'string' ? lease.admission_id : '';
    const relativePath = lease.credential_relative_path;
    if (typeof relativePath !== 'string' || relativePath !== `${CREDENTIAL_DIRECTORY}/${admissionId}.token` || !ADMISSION_ID_PATTERN.test(admissionId)) throw new RecoveryBoundaryError('cleanup credential path is invalid');
    const directory = await directoryLease(jobId, false);
    if (directory === null) throw new CleanupCredentialInvalidError('cleanup credential directory is missing');
    const filename = `${admissionId}.token`;
    let handle: RecoveryFileHandle | null = null;
    try {
      try { handle = await directory.directory.openFileChild(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
      catch (error) {
        if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ELOOP') throw new CleanupCredentialInvalidError('cleanup credential is unsafe or missing', { cause: error });
        throw new RecoveryBoundaryError(`cleanup credential filesystem read failed${closeErrorMessage(error)}`, { cause: error });
      }
      let bytes: Buffer;
      try {
        verifyCredentialFile(await handle.stat(), relativePath, ownerUid);
        bytes = await handle.readFile();
      } catch (error) {
        if (error instanceof RecoveryBoundaryError && error.message.startsWith('unsafe cleanup credential')) throw new CleanupCredentialInvalidError(error.message, { cause: error });
        throw new RecoveryBoundaryError(`cleanup credential filesystem read failed${closeErrorMessage(error)}`, { cause: error });
      }
      let record: { readonly admissionId: string; readonly generation: number; readonly token: string };
      try { record = parseCredential(bytes); } catch (error) { throw new CleanupCredentialInvalidError(error instanceof Error ? error.message : 'cleanup credential is corrupt', { cause: error }); }
      if (record.admissionId !== admissionId || record.generation !== Number(lease.fence_generation) || crypto.sha256(bytes) !== lease.credential_sha256 || crypto.sha256(record.token) !== lease.fence_token_hash) throw new CleanupCredentialInvalidError('cleanup credential does not match the committed admission');
    } finally {
      if (handle !== null) await handle.close();
      await directory.close();
    }
  }

  function predecessor(lease: Record<string, unknown>): CleanupAdmissionPredecessor {
    const admissionId = typeof lease.admission_id === 'string' ? lease.admission_id : '';
    const status = String(lease.status) as CleanupAdmissionPredecessorStatus;
    const blockerCode = lease.blocker_code === null || lease.blocker_code === undefined ? null : String(lease.blocker_code) as BuilderErrorCode;
    let blocker: JsonObject | null = null;
    if (lease.blocker_json !== null && lease.blocker_json !== undefined) {
      try {
        const parsed = JSON.parse(String(lease.blocker_json)) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('blocker evidence is not an object');
        blocker = parsed as JsonObject;
      } catch (error) { throw new RecoveryBoundaryError('persisted cleanup blocker evidence is corrupt', { cause: error }); }
    }
    if (!ADMISSION_ID_PATTERN.test(admissionId) || !['admitted', 'claimed', 'failed', 'blocking'].includes(status) || typeof lease.unit_name !== 'string' || !Number.isSafeInteger(Number(lease.fence_generation)) || typeof lease.fence_token_hash !== 'string') throw new RecoveryBoundaryError('persisted cleanup predecessor identity is invalid');
    return {
      previousAdmissionId: admissionId,
      previousStatus: status,
      previousUnitName: exactUnit(admissionId, lease.unit_name),
      previousFenceGeneration: Number(lease.fence_generation),
      previousFenceTokenHash: String(lease.fence_token_hash),
      previousClaimAt: lease.claim_at === null || lease.claim_at === undefined ? null : String(lease.claim_at),
      previousRenewAt: lease.renew_at === null || lease.renew_at === undefined ? null : String(lease.renew_at),
      previousBlockerCode: blockerCode,
      previousBlocker: blocker,
    };
  }

  function replacementResult(admissionId: string, generation: number, unitName: string, credential: { readonly relativePath: string; readonly sha256: string }, rotated: boolean): CleanupAdmissionResult {
    return { admissionId, generation, unitName, credentialRelativePath: credential.relativePath, credentialSha256: credential.sha256, rotated, started: true };
  }

  async function admitAndStart(input: CleanupAdmissionInput): Promise<CleanupAdmissionResult> {
    requireAdmissionsOpen();
    safeSegment(input.jobId, 'job ID');
    return withJobLock(input.jobId, async () => {
      const at = input.at ?? clock.now();
      const generation = jobGeneration(input.jobId);
      const material = newAdmission();
      const credential = await writeCredential(input.jobId, material.admissionId, generation, material.token);
      const unitName = `osi-image-builder-cleanup@${material.admissionId}.service`;
      const command: ApiWriteCommand = { kind: 'cleanup-admission', jobId: input.jobId, admissionId: material.admissionId, owner: input.owner, unitName, expiresAt: input.expiresAt, credentialRelativePath: credential.relativePath, credentialSha256: credential.sha256, fenceTokenHash: crypto.sha256(material.token), snapshot: input.snapshot, at };
      ownershipCommandResult(options.ownership.apiWrite(command));
      options.onAdmissionCommitted?.();
      await start(unitName);
      return replacementResult(material.admissionId, generation, unitName, credential, false);
    });
  }

  async function ensurePredecessorStillMatches(jobId: string, expected: CleanupAdmissionPredecessor): Promise<Record<string, unknown>> {
    const current = dbLease(expected.previousAdmissionId, jobId);
    if (current === null) throw new RecoveryBoundaryError('cleanup predecessor disappeared before rotation');
    const actual = predecessor(current);
    if (actual.previousStatus !== expected.previousStatus || actual.previousUnitName !== expected.previousUnitName || actual.previousFenceGeneration !== expected.previousFenceGeneration || actual.previousFenceTokenHash !== expected.previousFenceTokenHash || actual.previousClaimAt !== expected.previousClaimAt || actual.previousRenewAt !== expected.previousRenewAt || JSON.stringify(actual.previousBlocker) !== JSON.stringify(expected.previousBlocker)) throw new RecoveryBoundaryError('cleanup predecessor changed before rotation');
    return current;
  }

  async function rotateInternal(input: ReconcileAdmissionInput, retry: CorrectedRetryAdmissionInput | null): Promise<CleanupAdmissionResult> {
    const at = input.at ?? clock.now();
    const old = dbLease(input.admissionId, input.jobId);
    if (old === null) throw new RecoveryBoundaryError('cleanup admission does not exist');
    if (old.status === 'expired') throw new RecoveryBoundaryError('cleanup admission is not rotatable');
    const expected = predecessor(old);
    if (expected.previousStatus === 'failed' || expected.previousStatus === 'blocking') {
      if (retry === null) throw new RecoveryBoundaryError('failed or blocking cleanup admission requires explicit corrected retry');
    } else if (retry !== null) {
      throw new RecoveryBoundaryError('corrected cleanup retry requires a failed or blocking predecessor');
    }
    const oldUnit = expected.previousUnitName;
    if (expected.previousStatus === 'claimed') {
      await stopAndConfirmInactive(oldUnit);
    } else if (await options.systemd.isActive(oldUnit)) {
      throw new RecoveryBoundaryError('cleanup worker is active; recovery deferred');
    }
    let credentialValid = true;
    if (retry === null) {
      try { await readCredential(input.jobId, old); }
      catch (error) {
        if (!(error instanceof CleanupCredentialInvalidError)) throw error;
        credentialValid = false;
      }
    } else if (expected.previousBlockerCode !== retry.expectedBlockerCode || JSON.stringify(expected.previousBlocker) !== JSON.stringify(retry.expectedBlocker)) {
      throw new RecoveryBoundaryError('corrected cleanup retry blocker does not match persisted evidence');
    }
    if (retry === null && credentialValid && expected.previousStatus === 'admitted' && typeof old.expires_at === 'string' && old.expires_at > at) {
      await ensurePredecessorStillMatches(input.jobId, expected);
      const currentActive = await options.systemd.isActive(oldUnit);
      if (currentActive) throw new RecoveryBoundaryError('cleanup worker became active during recovery');
      await start(oldUnit);
      return { admissionId: expected.previousAdmissionId, generation: expected.previousFenceGeneration, unitName: oldUnit, credentialRelativePath: String(old.credential_relative_path), credentialSha256: String(old.credential_sha256), rotated: false, started: true };
    }
    const generation = jobGeneration(input.jobId);
    const material = newAdmission();
    const credential = await writeCredential(input.jobId, material.admissionId, generation, material.token);
    await ensurePredecessorStillMatches(input.jobId, expected);
    await stopAndConfirmInactive(oldUnit);
    await ensurePredecessorStillMatches(input.jobId, expected);
    const unitName = `osi-image-builder-cleanup@${material.admissionId}.service`;
    const command: ApiWriteCommand = retry === null
      ? { kind: 'cleanup-admission-rotate', ...expected, jobId: input.jobId, admissionId: material.admissionId, owner: input.owner, unitName, expiresAt: input.expiresAt, credentialRelativePath: credential.relativePath, credentialSha256: credential.sha256, fenceTokenHash: crypto.sha256(material.token), snapshot: input.snapshot, at }
      : { kind: 'cleanup-admission-retry', ...expected, jobId: input.jobId, admissionId: material.admissionId, owner: input.owner, unitName, expiresAt: input.expiresAt, credentialRelativePath: credential.relativePath, credentialSha256: credential.sha256, fenceTokenHash: crypto.sha256(material.token), expectedBlockerCode: retry.expectedBlockerCode, expectedBlocker: retry.expectedBlocker, snapshot: retry.correctedSnapshot, at };
    ownershipCommandResult(options.ownership.apiWrite(command));
    if (await options.systemd.isActive(oldUnit)) await stopAndConfirmInactive(oldUnit);
    options.onAdmissionCommitted?.();
    await start(unitName);
    return replacementResult(material.admissionId, generation, unitName, credential, true);
  }

  async function reconcileAndStart(input: ReconcileAdmissionInput): Promise<CleanupAdmissionResult> {
    requireAdmissionsOpen();
    safeSegment(input.jobId, 'job ID');
    return withJobLock(input.jobId, () => rotateInternal(input, null));
  }

  async function retryCorrectedAndStart(input: CorrectedRetryAdmissionInput): Promise<CleanupAdmissionResult> {
    requireAdmissionsOpen();
    safeSegment(input.jobId, 'job ID');
    return withJobLock(input.jobId, () => rotateInternal(input, input));
  }

  async function pruneInternal(): Promise<number> {
    const root = await fileSystem.openDirectory(options.stateRoot);
    verifyDirectory(await root.stat(), options.stateRoot, ownerUid);
    let jobs: RecoveryDirectoryHandle | null = null;
    try {
      jobs = await openChildDirectory(root, 'jobs', join(options.stateRoot, 'jobs'), false);
      if (jobs === null) return 0;
      let removed = 0;
      for (const jobId of await jobs.readdir()) {
        try { safeSegment(jobId, 'job ID'); } catch { continue; }
        let directory: DirectoryLease | null = null;
        try { directory = await directoryLease(jobId, false); } catch { continue; }
        if (directory === null) continue;
        try {
          for (const name of await directory.directory.readdir()) {
            const match = name.match(/^cln_([0-9a-hj-km-np-tv-z]{26})\.token$/);
            if (!match) continue;
            const admissionId = `cln_${match[1]}`;
            let handle: RecoveryFileHandle | null = null;
            try {
              handle = await directory.directory.openFileChild(name, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
              verifyCredentialFile(await handle.stat(), `${CREDENTIAL_DIRECTORY}/${name}`, ownerUid);
            } catch { if (handle !== null) await handle.close(); continue; }
            await handle.close(); handle = null;
            const matching = options.db.prepare('SELECT 1 FROM cleanup_leases WHERE job_id=? AND admission_id=?').get(jobId, admissionId);
            if (matching !== undefined && matching !== null) continue;
            await directory.directory.unlinkChild(name);
            await directory.directory.sync();
            removed += 1;
          }
        } finally { await directory.close(); }
      }
      return removed;
    } finally {
      if (jobs !== null) await jobs.close();
      await root.close();
    }
  }

  async function openAdmissions(): Promise<void> {
    await withLifecycleLock(async () => {
      if (admissionsOpen) return;
      await pruneInternal();
      admissionsOpen = true;
    });
  }

  async function pruneOrphanCredentials(): Promise<number> {
    return withLifecycleLock(async () => {
      if (admissionsOpen) throw new RecoveryBoundaryError('prune is unavailable after admissions open');
      return pruneInternal();
    });
  }

  return { admitAndStart, reconcileAndStart, retryCorrectedAndStart, openAdmissions, pruneOrphanCredentials };
}
