import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir as nodeMkdir, open as nodeOpen, readdir as nodeReaddir, unlink as nodeUnlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  ACTIVE_RECOVERY_STATES,
  ADMISSION_ID_PATTERN,
  CLEANUP_CREDENTIAL_TOKEN_MAX_CHARS,
  CLEANUP_CREDENTIAL_TOKEN_MIN_CHARS,
  type BuilderErrorCode,
} from '../../domain/types.js';
import type {
  CleanupAdmissionPredecessor,
  CleanupAdmissionPredecessorStatus,
  CleanupPostcondition,
  CleanupSnapshot,
  OwnershipResult,
  ApiWriteCommand,
  HandBackProof,
  OwnershipStore,
} from './ownership.js';
import type { JsonObject } from './store.js';
import { canonicalInstant } from './validation.js';

export { ADMISSION_ID_PATTERN } from '../../domain/types.js';
const ADMISSION_BODY_PATTERN = /^[0-7][0-9a-hj-km-np-tv-z]{25}$/;
const CREDENTIAL_NAME_PATTERN = /^cln_([0-7][0-9a-hj-km-np-tv-z]{25})\.token$/;
const CREDENTIAL_DIRECTORY = 'recovery/cleanup-credentials';
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const HASH64 = /^[0-9a-f]{64}$/;
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const ULID_TIMESTAMP_MAX = 0xffffffffffffn;
const RESERVATION_MIN_HOLD_MS = 5 * 60 * 1000;
const STOP_AUTHORIZATION_HOLD_MS = 30 * 1000;
const STOP_AUTHORIZATION_ATTEMPT_PATTERN = /^sta_[a-f0-9]{32}$/;
const HAND_BACK_ACTIVE_STATES = new Set<string>(ACTIVE_RECOVERY_STATES);
const MAX_LOG_GENERATIONS = 128;
const MAX_LOG_EVENTS = 8_192;

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

export type RecoveryFileSystem = RecoveryDescriptorFileSystem;

export interface RecoveryCrypto {
  readonly randomBytes: (size: number) => Uint8Array;
  readonly sha256: (value: Uint8Array | string) => string;
}

export interface RecoverySystemd {
  readonly start: (unit: string) => Promise<void>;
  readonly isActive: (unit: string) => Promise<boolean>;
  readonly stop?: (unit: string) => Promise<void>;
}

export interface RecoveryDockerObservation {
  readonly id: string;
  readonly labels: JsonObject;
}

export interface RecoveryDocker {
  readonly inspect: (containerId: string) => Promise<RecoveryDockerObservation | null>;
  readonly listByLabels: (labels: JsonObject) => Promise<readonly RecoveryDockerObservation[]>;
}

export interface RecoveryCleanupEvidence {
  readonly jobId: string;
  readonly admissionId: string;
  readonly sha256: string;
  readonly postcondition: CleanupPostcondition;
}

export interface RecoveryCleanupEvidenceReader {
  readonly read: (input: Readonly<{ jobId: string; admissionId: string; path: string; sha256: string }>) => Promise<RecoveryCleanupEvidence>;
}

export interface RecoveryStagingVerifier {
  readonly verify: (input: Readonly<{ jobId: string; admissionId: string; postcondition: CleanupPostcondition['staging'] }>) => Promise<boolean | void>;
}

export interface RecoveryHandBackDependencies {
  readonly docker: RecoveryDocker;
  readonly evidence: RecoveryCleanupEvidenceReader;
  readonly staging: RecoveryStagingVerifier;
}

export interface RecoveryClock {
  readonly now: () => string;
}

export interface RecoveryDatabase {
  readonly prepare: (sql: string) => {
    readonly get: (...parameters: readonly unknown[]) => unknown;
    readonly all?: (...parameters: readonly unknown[]) => readonly unknown[];
    readonly run?: (...parameters: readonly unknown[]) => { readonly changes?: number };
  };
  readonly exec?: (sql: string) => unknown;
}

export interface CleanupAdmissionRecoveryOptions {
  readonly stateRoot: string;
  readonly db: DatabaseSync | RecoveryDatabase;
  readonly ownership: Pick<OwnershipStore, 'apiWrite'>;
  readonly systemd: RecoverySystemd;
  readonly handBack?: RecoveryHandBackDependencies;
  readonly fileSystem?: RecoveryFileSystem;
  readonly crypto?: Partial<RecoveryCrypto>;
  readonly clock?: RecoveryClock;
  readonly ownerUid?: number;
  readonly onAdmissionCommitted?: () => void;
  readonly onCredentialWritten?: () => void | Promise<void>;
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

export interface CompletedCleanupInput {
  readonly jobId: string;
  readonly admissionId: string;
  readonly at?: string;
}

export interface CleanupHandBackResult {
  readonly jobId: string;
  readonly admissionId: string;
  readonly state: 'interrupted' | 'already-interrupted';
  readonly handedBack: boolean;
  readonly started: false;
}

export interface CleanupAdmissionRecovery {
  readonly admitAndStart: (input: CleanupAdmissionInput) => Promise<CleanupAdmissionResult>;
  readonly reconcileAndStart: (input: ReconcileAdmissionInput) => Promise<CleanupAdmissionResult>;
  readonly retryCorrectedAndStart: (input: CorrectedRetryAdmissionInput) => Promise<CleanupAdmissionResult>;
  readonly handBackCompleted: (input: CompletedCleanupInput) => Promise<CleanupHandBackResult>;
  readonly reconcileCompletedAdmissions: () => Promise<readonly CleanupHandBackResult[]>;
  readonly openAdmissions: () => Promise<void>;
  readonly pruneOrphanCredentials: () => Promise<number>;
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

type CleanupStopFailure = 'capability-unavailable' | 'stop-error' | 'still-active';

class CleanupStopFailureError extends RecoveryBoundaryError {
  readonly failure: CleanupStopFailure;

  constructor(failure: CleanupStopFailure, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CleanupStopFailureError';
    this.failure = failure;
  }
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}

function incrementBigEndian(bytes: Uint8Array): boolean {
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    if (bytes[index]! !== 0xff) {
      bytes[index] = bytes[index]! + 1;
      return true;
    }
    bytes[index] = 0;
  }
  return false;
}

async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number, timeoutError: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.resolve().then(operation);
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

export function encodeAdmissionId(timestampMs: number, randomness: Uint8Array): string {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || BigInt(timestampMs) > ULID_TIMESTAMP_MAX) throw new RecoveryBoundaryError('admission ID timestamp is invalid');
  if (randomness.length < 10) throw new RecoveryBoundaryError('admission ID entropy is too short');
  let entropy = 0n;
  for (const byte of randomness.subarray(0, 10)) entropy = (entropy << 8n) | BigInt(byte);
  let value = (BigInt(timestampMs) << 80n) | entropy;
  let body = '';
  for (let index = 0; index < 26; index += 1) {
    body = CROCKFORD[Number(value & 31n)]! + body;
    value >>= 5n;
  }
  if (!ADMISSION_BODY_PATTERN.test(body)) throw new RecoveryBoundaryError('generated admission ID is invalid');
  return `cln_${body}`;
}

export function decodeAdmissionId(admissionId: string): { readonly timestampMs: number; readonly randomness: Uint8Array } {
  if (!ADMISSION_ID_PATTERN.test(admissionId)) throw new RecoveryBoundaryError('admission ID is invalid');
  let value = 0n;
  for (const character of admissionId.slice(4)) {
    const digit = CROCKFORD.indexOf(character);
    if (digit < 0) throw new RecoveryBoundaryError('admission ID alphabet is invalid');
    value = (value << 5n) | BigInt(digit);
  }
  const timestampMs = Number(value >> 80n);
  const randomness = new Uint8Array(10);
  let entropy = value & ((1n << 80n) - 1n);
  for (let index = randomness.length - 1; index >= 0; index -= 1) {
    randomness[index] = Number(entropy & 0xffn);
    entropy >>= 8n;
  }
  return { timestampMs, randomness };
}

function databaseRun(db: DatabaseSync | RecoveryDatabase, sql: string, ...parameters: readonly unknown[]): number {
  const statement = db.prepare(sql);
  if (typeof statement.run !== 'function') return 0;
  return Number(statement.run(...(parameters as any)).changes ?? 0);
}

function databaseExec(db: DatabaseSync | RecoveryDatabase, sql: string): void {
  if (typeof (db as RecoveryDatabase).exec === 'function') (db as RecoveryDatabase).exec!(sql);
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
  if (Object.keys(record).sort().join(',') !== 'admissionId,generation,token' || typeof record.admissionId !== 'string' || !ADMISSION_ID_PATTERN.test(record.admissionId) || !Number.isSafeInteger(record.generation) || Number(record.generation) <= 0 || typeof record.token !== 'string' || record.token.length < CLEANUP_CREDENTIAL_TOKEN_MIN_CHARS || record.token.length > CLEANUP_CREDENTIAL_TOKEN_MAX_CHARS) throw new RecoveryBoundaryError('cleanup credential record fields are invalid');
  return { admissionId: record.admissionId, generation: Number(record.generation), token: record.token };
}

function ownershipCommandResult(result: OwnershipResult): void {
  if (!result.ok) throw new RecoveryBoundaryError(`cleanup admission CAS rejected: ${result.conflict.kind}: ${result.conflict.message}`);
}

function closeErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? `: ${error.message}` : '';
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return current;
    return Object.fromEntries(Object.entries(current as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
  });
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

interface DirectoryLease {
  readonly directory: RecoveryDirectoryHandle;
  readonly close: () => Promise<void>;
}

interface StopAuthorizationRecord {
  readonly attemptId: string;
  readonly authorizationOwner: string;
  readonly authorizationAt: string;
  readonly authorizationExpiresAt: string;
  readonly state: 'authorized' | 'consumed' | 'failed' | 'orphaned';
}

async function closeHandles(handles: readonly RecoveryFileHandle[]): Promise<void> {
  let firstError: unknown;
  for (const handle of handles.slice().reverse()) {
    try { await handle.close(); } catch (error) { firstError ??= error; }
  }
  if (firstError !== undefined) throw firstError;
}

function databaseAll(db: DatabaseSync | RecoveryDatabase, sql: string, ...parameters: readonly unknown[]): readonly Record<string, unknown>[] {
  const statement = db.prepare(sql);
  if (typeof statement.all !== 'function') return [];
  return statement.all(...(parameters as any[])) as readonly Record<string, unknown>[];
}

function requiredRowString(row: Record<string, unknown>, field: string): string {
  if (typeof row[field] !== 'string' || row[field] === '') throw new RecoveryBoundaryError(`persisted recovery ${field} is invalid`);
  return row[field] as string;
}

function nullableRowString(row: Record<string, unknown>, field: string): string | null {
  if (row[field] === null || row[field] === undefined) return null;
  return requiredRowString(row, field);
}

function jsonRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RecoveryBoundaryError(`${field} is not an object`);
  return value as Record<string, unknown>;
}

function parseJsonRecord(value: unknown, field: string): Record<string, unknown> {
  try { return jsonRecord(JSON.parse(String(value)), field); }
  catch (error) { throw new RecoveryBoundaryError(`${field} is corrupt`, { cause: error }); }
}

function cleanupEvidencePath(path: string, jobId: string): string {
  const parts = path.split('/');
  if (parts.length < 5 || parts[0] !== 'jobs' || parts[1] !== jobId || parts[2] !== 'evidence' || parts[3] !== 'cleanup' || parts.some((part) => part.length === 0)) throw new RecoveryBoundaryError('cleanup evidence path is outside the fixed job evidence directory');
  for (const part of parts.slice(1)) safeSegment(part, 'cleanup evidence path segment');
  return path;
}

function notFuture(value: unknown, at: string, field: string): void {
  const instant = canonicalInstant(value, field);
  const upperBound = canonicalInstant(at, `${field} upper bound`);
  if (instant > upperBound) throw new RecoveryBoundaryError(`${field} is invalid or from the future`);
}

function cleanupIdentityIsNull(row: Record<string, unknown>): boolean {
  return [
    'container_id', 'container_name', 'container_image_digest', 'container_label_job_id',
    'container_label_manifest_sha', 'container_labels_json', 'container_mount_json',
    'container_env_json', 'container_security_json', 'container_inspection_json',
    'container_created_at', 'container_started_at', 'container_stopped_at',
    'container_removed_at', 'container_cleanup_outcome',
  ].every((field) => row[field] === null || row[field] === undefined);
}

function verifyLogContinuity(db: DatabaseSync | RecoveryDatabase, jobId: string, logs: CleanupPostcondition['logs'], at: string): void {
  const generations = databaseAll(db, 'SELECT stream, generation, started_at, size_bytes, sealed_at, sha256 FROM job_log_generations WHERE job_id=? ORDER BY stream, generation LIMIT ?', jobId, MAX_LOG_GENERATIONS + 1);
  const events = databaseAll(db, `SELECT stream, file_generation, seq, event_type, at, byte_offset, byte_length, partial
    FROM job_events WHERE job_id=? AND stream IS NOT NULL ORDER BY stream, file_generation, seq LIMIT ?`, jobId, MAX_LOG_EVENTS + 1);
  if (generations.length > MAX_LOG_GENERATIONS || events.length > MAX_LOG_EVENTS) throw new RecoveryBoundaryError('cleanup log evidence exceeds the bounded recovery limit');
  if (generations.some((row) => row.stream !== 'runner' && row.stream !== 'docker') || events.some((row) => row.stream !== 'runner' && row.stream !== 'docker')) throw new RecoveryBoundaryError('cleanup log evidence has an invalid stream');
  for (const stream of ['runner', 'docker'] as const) {
    const streamGenerations = generations.filter((row) => row.stream === stream);
    const streamEvents = events.filter((candidate) => candidate.stream === stream);
    if (logs[stream] === 'absent') {
      if (streamGenerations.length !== 0 || streamEvents.length !== 0) throw new RecoveryBoundaryError(`${stream} cleanup logs are present but evidence says absent`);
      continue;
    }
    if (streamGenerations.length === 0) throw new RecoveryBoundaryError(`${stream} cleanup logs are not indexed`);
    let expectedGeneration = 0;
    for (const generation of streamGenerations) {
      if (generation.sealed_at === null || generation.sealed_at === undefined) throw new RecoveryBoundaryError(`${stream} cleanup log generation is not sealed`);
      const generationNumber = Number(generation.generation);
      const size = Number(generation.size_bytes);
      if (!Number.isSafeInteger(generationNumber) || generationNumber < 0 || !Number.isSafeInteger(size) || size < 0) throw new RecoveryBoundaryError(`${stream} cleanup log generation metadata is invalid`);
      if (generationNumber !== expectedGeneration || typeof generation.sha256 !== 'string' || !HASH64.test(generation.sha256)) throw new RecoveryBoundaryError(`${stream} cleanup log generations are not contiguous and sealed`);
      const startedAt = canonicalInstant(generation.started_at, `${stream} cleanup log start time`);
      const sealedAt = canonicalInstant(generation.sealed_at, `${stream} cleanup log seal time`);
      if (sealedAt < startedAt || sealedAt > at) throw new RecoveryBoundaryError(`${stream} cleanup log seal chronology is invalid`);
      expectedGeneration += 1;
      let offset = 0;
      let previousSequence = -1;
      for (const event of streamEvents.filter((candidate) => Number(candidate.file_generation) === generationNumber)) {
        const sequence = Number(event.seq);
        const eventOffset = Number(event.byte_offset);
        const length = Number(event.byte_length);
        const partial = Number(event.partial);
        const eventAt = canonicalInstant(event.at, `${stream} cleanup log event time`);
        if (!Number.isSafeInteger(sequence) || sequence <= previousSequence || !Number.isSafeInteger(eventOffset) || !Number.isSafeInteger(length) || length <= 0 || eventOffset !== offset || eventOffset + length > size || !Number.isSafeInteger(partial) || partial !== 0 && partial !== 1 || eventAt < startedAt || eventAt > sealedAt) {
          throw new RecoveryBoundaryError(`${stream} cleanup log ranges are not contiguous`);
        }
        if (!['log', 'log_orphan_tail', 'log-truncated', 'log-gap'].includes(String(event.event_type)) || event.event_type === 'log-gap') throw new RecoveryBoundaryError(`${stream} cleanup logs contain invalid or gap evidence`);
        previousSequence = sequence;
        offset += length;
      }
      if (offset !== size) throw new RecoveryBoundaryError(`${stream} cleanup log ranges do not cover the sealed file`);
    }
    if (streamEvents.some((event) => !streamGenerations.some((generation) => Number(generation.generation) === Number(event.file_generation)))) throw new RecoveryBoundaryError(`${stream} cleanup log event references an unknown generation`);
  }
  if (generations.some((row) => row.sealed_at === null || row.sealed_at === undefined)) throw new RecoveryBoundaryError('cleanup logs retain an unsealed generation');
}

export function createCleanupAdmissionRecovery(options: CleanupAdmissionRecoveryOptions): CleanupAdmissionRecovery {
  const fileSystem: RecoveryDescriptorFileSystem = options.fileSystem ?? createRecoveryFileSystem();
  const crypto: RecoveryCrypto = { randomBytes: (size) => nodeRandomBytes(size), sha256: (value) => createHash('sha256').update(value).digest('hex'), ...options.crypto };
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const ownerUid = options.ownerUid ?? (process.getuid?.() ?? 0);
  const jobLocks = new Map<string, Promise<void>>();
  const issuedAdmissionIds = new Set<string>();
  const issuedCredentialTokenHashes = new Set<string>();
  const ownedStopAuthorizationAttempts = new Set<string>();
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
      try {
        verifyDirectory(await child.stat(), path, ownerUid);
        await parent.sync();
        return child;
      } catch (error) {
        try { await child.close(); } catch (closeError) { throw new RecoveryBoundaryError('recovery child close failed', { cause: closeError }); }
        throw error;
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' || !create) {
        if (errorCode(error) === 'ENOENT' && !create) return null;
        throw error;
      }
      try {
        await parent.mkdirChild(name, DIRECTORY_MODE);
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== 'EEXIST') throw mkdirError;
      }
      await parent.sync();
      const child = await parent.openDirectoryChild(name);
      try {
        verifyDirectory(await child.stat(), path, ownerUid);
        return child;
      } catch (error) {
        try { await child.close(); } catch (closeError) { throw new RecoveryBoundaryError('recovery child close failed', { cause: closeError }); }
        throw error;
      }
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

  async function writeCredential(
    jobId: string,
    admissionId: string,
    generation: number,
    token: string,
    reservation: Readonly<{ owner: string; createdAt: string; expiresAt: string }>,
  ): Promise<{ readonly relativePath: string; readonly sha256: string }> {
    const lease = await directoryLease(jobId, true);
    if (lease === null) throw new RecoveryBoundaryError('cleanup credential directory is unavailable');
    const filename = `${admissionId}.token`;
    const relativePath = `${CREDENTIAL_DIRECTORY}/${filename}`;
    const contents = credentialRecord(admissionId, generation, token);
    let failure: unknown;
    try {
      const handle = await lease.directory.openFileChild(filename, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, FILE_MODE);
      try {
        await handle.writeFile(contents);
        await handle.sync();
        verifyCredentialFile(await handle.stat(), relativePath, ownerUid);
      } finally { await handle.close(); }
      await lease.directory.sync();
      await options.onCredentialWritten?.();
      return { relativePath, sha256: crypto.sha256(contents) };
    } catch (error) {
      failure = error;
    } finally {
      await lease.close();
    }
    let abortFailure: unknown;
    try {
      ownershipCommandResult(options.ownership.apiWrite({
        kind: 'cleanup-credential-abort',
        jobId,
        admissionId,
        owner: reservation.owner,
        credentialRelativePath: relativePath,
        createdAt: reservation.createdAt,
        expiresAt: reservation.expiresAt,
        at: reservation.createdAt,
      }));
    } catch (error) { abortFailure = error; }
    throw new RecoveryBoundaryError(
      `cleanup credential filesystem operation failed${closeErrorMessage(failure)}`,
      { cause: abortFailure ?? failure },
    );
  }

  function newAdmission(at: string): { readonly admissionId: string; readonly token: string } {
    const timestampMs = Date.parse(at);
    if (Number.isNaN(timestampMs)) throw new RecoveryBoundaryError('admission timestamp is invalid');
    const suppliedRandomness = new Uint8Array(crypto.randomBytes(10));
    if (suppliedRandomness.length < 10) throw new RecoveryBoundaryError('admission ID entropy is too short');
    const randomness = suppliedRandomness.slice(0, 10);
    let admissionId = encodeAdmissionId(timestampMs, randomness);
    while (issuedAdmissionIds.has(admissionId)) {
      for (let index = randomness.length - 1; index >= 0; index -= 1) {
        randomness[index] = (randomness[index]! + 1) & 0xff;
        if (randomness[index] !== 0) break;
      }
      admissionId = encodeAdmissionId(timestampMs, randomness);
    }
    issuedAdmissionIds.add(admissionId);
    const suppliedTokenBytes = new Uint8Array(crypto.randomBytes(32));
    if (suppliedTokenBytes.length < 32) throw new RecoveryBoundaryError('cleanup credential token entropy is too short');
    const tokenBytes = suppliedTokenBytes.slice(0, 32);
    let token = Buffer.from(tokenBytes).toString('base64url');
    while (issuedCredentialTokenHashes.has(crypto.sha256(token))) {
      if (!incrementBigEndian(tokenBytes)) throw new RecoveryBoundaryError('cleanup credential token entropy is exhausted');
      token = Buffer.from(tokenBytes).toString('base64url');
    }
    issuedCredentialTokenHashes.add(crypto.sha256(token));
    return { admissionId, token };
  }

  function reservationExpiry(at: string, leaseExpiresAt: string): string {
    const atMs = Date.parse(at);
    const leaseMs = Date.parse(leaseExpiresAt);
    if (Number.isNaN(atMs) || Number.isNaN(leaseMs)) throw new RecoveryBoundaryError('cleanup reservation chronology is invalid');
    return new Date(Math.max(leaseMs, atMs + RESERVATION_MIN_HOLD_MS)).toISOString();
  }

  function reservationPath(admissionId: string): string {
    return `${CREDENTIAL_DIRECTORY}/${admissionId}.token`;
  }

  function reserveCredential(jobId: string, admissionId: string, owner: string, createdAt: string, expiresAt: string): void {
    ownershipCommandResult(options.ownership.apiWrite({
      kind: 'cleanup-credential-reserve',
      jobId,
      admissionId,
      owner,
      credentialRelativePath: reservationPath(admissionId),
      createdAt,
      expiresAt,
      at: createdAt,
    }));
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

  function dbStopAuthorization(admissionId: string, jobId: string): StopAuthorizationRecord | null {
    const row = options.db.prepare(`SELECT h.attempt_id, h.authorization_owner, h.state, a.authorization_at, a.authorization_expires_at
      FROM cleanup_stop_authorization_heads AS h
      JOIN cleanup_stop_authorizations AS a ON a.attempt_id=h.attempt_id
      WHERE h.admission_id=? AND h.job_id=?`).get(admissionId, jobId) as Record<string, unknown> | undefined;
    if (!row || row.attempt_id === undefined) return null;
    if (typeof row.attempt_id !== 'string' || !STOP_AUTHORIZATION_ATTEMPT_PATTERN.test(row.attempt_id)
      || typeof row.authorization_owner !== 'string' || typeof row.authorization_at !== 'string'
      || typeof row.authorization_expires_at !== 'string' || !['authorized', 'consumed', 'failed', 'orphaned'].includes(String(row.state))) throw new RecoveryBoundaryError('persisted cleanup stop authorization identity is invalid');
    return {
      attemptId: row.attempt_id,
      authorizationOwner: row.authorization_owner,
      authorizationAt: row.authorization_at,
      authorizationExpiresAt: row.authorization_expires_at,
      state: String(row.state) as StopAuthorizationRecord['state'],
    };
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
    if (!options.systemd.stop) throw new CleanupStopFailureError('capability-unavailable', 'cleanup predecessor stop capability is unavailable');
    try {
      await withTimeout(
        async () => {
          await options.systemd.stop!(unitName);
          if (await options.systemd.isActive(unitName)) throw new CleanupStopFailureError('still-active', `cleanup predecessor remains active: ${unitName}`);
        },
        STOP_AUTHORIZATION_HOLD_MS,
        () => new CleanupStopFailureError('stop-error', `cleanup predecessor stop confirmation timed out: ${unitName}`),
      );
    } catch (error) {
      if (error instanceof CleanupStopFailureError) throw error;
      throw new CleanupStopFailureError('stop-error', `cleanup predecessor stop failed: ${unitName}`, { cause: error });
    }
  }

  async function readCredential(jobId: string, lease: Record<string, unknown>): Promise<void> {
    const admissionId = typeof lease.admission_id === 'string' ? lease.admission_id : '';
    const relativePath = lease.credential_relative_path;
    if (typeof relativePath !== 'string' || relativePath !== `${CREDENTIAL_DIRECTORY}/${admissionId}.token` || !ADMISSION_ID_PATTERN.test(admissionId)) throw new RecoveryBoundaryError('cleanup credential path is invalid');
    const directory = await directoryLease(jobId, false);
    if (directory === null) throw new CleanupCredentialInvalidError('cleanup credential directory is missing');
    const filename = `${admissionId}.token`;
    let handle: RecoveryFileHandle | null = null;
    let failure: unknown;
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
    } catch (error) { failure = error; }
    if (handle !== null) {
      try { await handle.close(); } catch (error) { failure ??= error; }
    }
    try { await directory.close(); } catch (error) { failure ??= error; }
    if (failure !== undefined) throw failure;
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
      previousOwner: typeof lease.owner === 'string' ? lease.owner : undefined,
      previousExpiresAt: typeof lease.expires_at === 'string' ? lease.expires_at : undefined,
      previousUnitName: exactUnit(admissionId, lease.unit_name),
      previousFenceGeneration: Number(lease.fence_generation),
      previousFenceTokenHash: String(lease.fence_token_hash),
      previousClaimAt: lease.claim_at === null || lease.claim_at === undefined ? null : String(lease.claim_at),
      previousRenewAt: lease.renew_at === null || lease.renew_at === undefined ? null : String(lease.renew_at),
      previousBlockerCode: blockerCode,
      previousBlocker: blocker,
      previousStopAuthorizationAttemptId: lease.stop_authorization_attempt_id === null || lease.stop_authorization_attempt_id === undefined ? null : String(lease.stop_authorization_attempt_id),
      previousStopAuthorizationOwner: lease.stop_authorization_owner === null || lease.stop_authorization_owner === undefined ? null : String(lease.stop_authorization_owner),
      previousStopAuthorizationAt: lease.stop_authorization_at === null || lease.stop_authorization_at === undefined ? null : String(lease.stop_authorization_at),
      previousStopAuthorizationExpiresAt: lease.stop_authorization_expires_at === null || lease.stop_authorization_expires_at === undefined ? null : String(lease.stop_authorization_expires_at),
      previousStopAuthorizationState: lease.stop_authorization_state === null || lease.stop_authorization_state === undefined ? null : String(lease.stop_authorization_state) as 'consumed' | 'failed' | 'orphaned',
      previousUnexpectedExit: lease.unexpected_exit_json === null || lease.unexpected_exit_json === undefined ? null : (() => {
        try {
          const parsed = JSON.parse(String(lease.unexpected_exit_json)) as unknown;
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('unexpected exit evidence is not an object');
          return parsed as JsonObject;
        } catch (error) { throw new RecoveryBoundaryError('persisted cleanup unexpected-exit evidence is corrupt', { cause: error }); }
      })(),
    };
  }

  function replacementResult(admissionId: string, generation: number, unitName: string, credential: { readonly relativePath: string; readonly sha256: string }, rotated: boolean): CleanupAdmissionResult {
    return { admissionId, generation, unitName, credentialRelativePath: credential.relativePath, credentialSha256: credential.sha256, rotated, started: true };
  }

  async function handBackCompleted(input: CompletedCleanupInput): Promise<CleanupHandBackResult> {
    requireAdmissionsOpen();
    safeSegment(input.jobId, 'job ID');
    if (!ADMISSION_ID_PATTERN.test(input.admissionId)) throw new RecoveryBoundaryError('cleanup admission ID is invalid');
    return withJobLock(input.jobId, async () => {
      const at = canonicalInstant(input.at ?? clock.now(), 'cleanup hand-back time');
      const lease = dbLease(input.admissionId, input.jobId);
      if (lease === null) throw new RecoveryBoundaryError('completed cleanup admission does not exist');
      const status = requiredRowString(lease, 'status');
      const job = options.db.prepare('SELECT * FROM jobs WHERE job_id=?').get(input.jobId) as Record<string, unknown> | undefined;
      if (job === undefined) throw new RecoveryBoundaryError('cleanup hand-back job does not exist');
      const jobState = requiredRowString(job, 'state');
      if (status === 'handed_back') {
        if (jobState !== 'interrupted') throw new RecoveryBoundaryError('handed-back cleanup admission has a non-terminal job state');
        return { jobId: input.jobId, admissionId: input.admissionId, state: 'already-interrupted', handedBack: false, started: false };
      }
      if (status !== 'completed') throw new RecoveryBoundaryError('cleanup admission is not completed');
      const dependencies = options.handBack;
      if (dependencies === undefined) throw new RecoveryBoundaryError('cleanup hand-back verification dependencies are unavailable');

      const owner = requiredRowString(lease, 'owner');
      const unitName = exactUnit(input.admissionId, lease.unit_name);
      const fenceGeneration = Number(lease.fence_generation);
      if (!Number.isSafeInteger(fenceGeneration) || fenceGeneration <= 0) throw new RecoveryBoundaryError('completed cleanup fence generation is invalid');
      const fenceTokenHash = requiredRowString(lease, 'fence_token_hash');
      const evidencePath = cleanupEvidencePath(requiredRowString(lease, 'completion_evidence_path'), input.jobId);
      const evidenceSha256 = requiredRowString(lease, 'completion_evidence_sha256');
      if (!HASH64.test(fenceTokenHash) || !HASH64.test(evidenceSha256)) throw new RecoveryBoundaryError('completed cleanup hashes are invalid');
      const persistedSnapshot = parseJsonRecord(requiredRowString(lease, 'proof_json'), 'cleanup admission proof') as unknown as CleanupSnapshot;
      const runnerUnit = requiredRowString(job, 'runner_unit');
      const staleRunnerUnit = requiredRowString(lease, 'stale_runner_unit');
      if (runnerUnit !== staleRunnerUnit || persistedSnapshot.runner.unit !== runnerUnit || persistedSnapshot.state !== jobState || lease.stale_state !== jobState) throw new RecoveryBoundaryError('completed cleanup runner or state evidence does not match the job');
      const runnerOwner = nullableRowString(job, 'runner_lease_owner');
      const runnerLeaseExpiresAt = nullableRowString(job, 'runner_lease_expires_at');
      if (persistedSnapshot.runner.owner !== runnerOwner || persistedSnapshot.runner.leaseExpiresAt !== runnerLeaseExpiresAt || nullableRowString(lease, 'stale_runner_owner') !== runnerOwner || nullableRowString(lease, 'stale_runner_lease_expires_at') !== runnerLeaseExpiresAt) throw new RecoveryBoundaryError('completed cleanup runner lease evidence does not match the job');
      if (runnerLeaseExpiresAt !== null && canonicalInstant(runnerLeaseExpiresAt, 'cleanup runner lease expiry') >= at) throw new RecoveryBoundaryError('runner lease is not stale for cleanup hand-back');
      if (runnerOwner === null && runnerLeaseExpiresAt !== null) throw new RecoveryBoundaryError('runner lease owner and expiry are incomplete');
      if (runnerOwner !== null && runnerLeaseExpiresAt === null) throw new RecoveryBoundaryError('runner lease owner and expiry are incomplete');
      if (job.cleanup_admission_id !== input.admissionId || Number(job.cleanup_fence_generation) !== fenceGeneration || job.cleanup_fence_token_hash !== fenceTokenHash) throw new RecoveryBoundaryError('completed cleanup fence does not match the job');
      if (job.cleanup_blocker_code !== null || job.cleanup_blocker_json !== null || lease.blocker_code !== null || lease.blocker_json !== null) throw new RecoveryBoundaryError('cleanup blocker is not resolved');
      if (!cleanupIdentityIsNull(job)) throw new RecoveryBoundaryError('cleanup CAS did not clear the active container identity');
      if (!HAND_BACK_ACTIVE_STATES.has(jobState) && jobState !== 'interrupted') throw new RecoveryBoundaryError(`job state is not eligible for cleanup hand-back: ${jobState}`);

      const completionEvent = options.db.prepare("SELECT payload_json FROM job_events WHERE job_id=? AND event_type='cleanup_complete' ORDER BY seq DESC LIMIT 1").get(input.jobId) as Record<string, unknown> | undefined;
      if (completionEvent === undefined) throw new RecoveryBoundaryError('cleanup completion event is missing');
      const completionPayload = parseJsonRecord(completionEvent.payload_json, 'cleanup completion evidence');
      if (completionPayload.admissionId !== input.admissionId || completionPayload.evidencePath !== evidencePath) throw new RecoveryBoundaryError('cleanup completion event does not match the durable admission evidence');
      const eventPostcondition = jsonRecord(completionPayload.postcondition, 'cleanup completion postcondition') as unknown as CleanupPostcondition;
      if (eventPostcondition.blocker !== 'none' || eventPostcondition.state !== persistedSnapshot.state || stableJson(eventPostcondition.runner) !== stableJson(persistedSnapshot.runner)) throw new RecoveryBoundaryError('cleanup completion postcondition does not match its admission');
      const evidence = await dependencies.evidence.read({ jobId: input.jobId, admissionId: input.admissionId, path: evidencePath, sha256: evidenceSha256 });
      if (evidence.jobId !== input.jobId || evidence.admissionId !== input.admissionId || evidence.sha256 !== evidenceSha256 || stableJson(evidence.postcondition) !== stableJson(eventPostcondition)) throw new RecoveryBoundaryError('cleanup completion file does not match the durable cleanup CAS evidence');
      const postcondition = evidence.postcondition;
      notFuture(postcondition.runner.inactiveAt, at, 'cleanup runner inactivity evidence');
      notFuture(postcondition.runner.observedAt, at, 'cleanup runner observation evidence');
      notFuture(postcondition.logs.verifiedAt, at, 'cleanup log evidence');
      if ((postcondition.logs.runner !== 'absent' && postcondition.logs.runner !== 'sealed') || (postcondition.logs.docker !== 'absent' && postcondition.logs.docker !== 'sealed')) throw new RecoveryBoundaryError('cleanup log evidence state is invalid');
      notFuture(postcondition.staging.verifiedAt, at, 'cleanup staging evidence');
      if (postcondition.staging.sourcePath !== `staging/${input.jobId}` || postcondition.staging.sourceAbsent !== true) throw new RecoveryBoundaryError('cleanup staging evidence is not bound to the fixed job path');
      if (postcondition.staging.kind === 'absent') {
        if (postcondition.staging.path !== null) throw new RecoveryBoundaryError('cleanup staging absence evidence is invalid');
      } else if (postcondition.staging.kind === 'quarantined') {
        if (postcondition.staging.destinationPath !== `quarantine/${input.jobId}` || postcondition.staging.destinationPresent !== true) throw new RecoveryBoundaryError('cleanup quarantine evidence is not bound to the fixed job path');
      } else throw new RecoveryBoundaryError('cleanup staging evidence state is invalid');
      const postContainer = postcondition.container;
      notFuture(postContainer.observedAt, at, 'cleanup container absence evidence');
      const exactContainerId = nullableRowString(lease, 'stale_container_id');
      if (exactContainerId === null) {
        if (persistedSnapshot.container.kind !== 'absent' || nullableRowString(lease, 'stale_container_name') !== null || nullableRowString(lease, 'stale_container_labels_json') !== null || postContainer.kind !== 'null-identity' || postContainer.dockerAction !== 'none' || postContainer.globalLabelResult !== 'no-match') throw new RecoveryBoundaryError('cleanup completion container proof does not match null identity');
      } else {
        if ((postContainer.kind !== 'removed' && postContainer.kind !== 'already-absent') || postContainer.id !== exactContainerId || postContainer.exactIdAbsent !== true || postContainer.globalLabelResult !== 'no-match') throw new RecoveryBoundaryError('cleanup completion container proof does not match the persisted identity');
        if (persistedSnapshot.container.kind !== 'present' || persistedSnapshot.container.id !== exactContainerId || postContainer.name !== persistedSnapshot.container.name || postContainer.imageDigest !== persistedSnapshot.container.imageDigest || stableJson(postContainer.labels) !== stableJson(persistedSnapshot.container.labels) || nullableRowString(lease, 'stale_container_name') !== persistedSnapshot.container.name || stableJson(parseJsonRecord(requiredRowString(lease, 'stale_container_labels_json'), 'stale container labels')) !== stableJson(persistedSnapshot.container.labels)) throw new RecoveryBoundaryError('cleanup completion container proof does not match the persisted identity');
        if (postContainer.kind === 'already-absent' && postContainer.dockerAction !== 'none') throw new RecoveryBoundaryError('already-absent cleanup proof claims a Docker action');
        if (postContainer.kind === 'removed') {
          notFuture(postContainer.stoppedAt, at, 'cleanup container stop evidence');
          notFuture(postContainer.removedAt, at, 'cleanup container removal evidence');
          if (postContainer.removedAt < postContainer.stoppedAt || postContainer.observedAt < postContainer.removedAt) throw new RecoveryBoundaryError('cleanup container chronology is invalid');
        }
      }
      verifyLogContinuity(options.db, input.jobId, postcondition.logs, at);
      if ((await dependencies.staging.verify({ jobId: input.jobId, admissionId: input.admissionId, postcondition: postcondition.staging })) === false) throw new RecoveryBoundaryError('cleanup staging postcondition is not verified');

      if (exactContainerId !== null && await dependencies.docker.inspect(exactContainerId) !== null) throw new RecoveryBoundaryError('exact persisted container is still present');
      const targetManifestSha = requiredRowString(job, 'target_manifest_sha256');
      const labels = { 'org.osi.image-builder.job-id': input.jobId, 'org.osi.image-builder.manifest-sha': targetManifestSha } satisfies JsonObject;
      if ((await dependencies.docker.listByLabels(labels)).length !== 0) throw new RecoveryBoundaryError('global Docker label query is not empty');
      if (await options.systemd.isActive(unitName)) throw new RecoveryBoundaryError('cleanup unit is still active during hand-back');
      if (await options.systemd.isActive(runnerUnit)) throw new RecoveryBoundaryError('stale runner unit is still active during hand-back');
      const runnerProof = {
        unit: runnerUnit,
        owner: runnerOwner,
        leaseExpiresAt: runnerLeaseExpiresAt,
        inactiveAt: at,
        observedAt: at,
      } satisfies HandBackProof['runner'];
      const proof: HandBackProof = {
        runner: runnerProof,
        container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: at },
        blocker: 'none',
      };
      ownershipCommandResult(options.ownership.apiWrite({
        kind: 'hand-back',
        jobId: input.jobId,
        admissionId: input.admissionId,
        owner,
        unitName,
        fenceGeneration,
        fenceTokenHash,
        at,
        proof,
      }));
      return { jobId: input.jobId, admissionId: input.admissionId, state: HAND_BACK_ACTIVE_STATES.has(jobState) ? 'interrupted' : 'already-interrupted', handedBack: true, started: false };
    });
  }

  function completedAdmissionRows(): readonly Record<string, unknown>[] {
    return databaseAll(options.db, "SELECT admission_id, job_id FROM cleanup_leases WHERE status='completed' ORDER BY complete_at, admission_id");
  }

  async function reconcileCompletedAdmissions(): Promise<readonly CleanupHandBackResult[]> {
    requireAdmissionsOpen();
    const results: CleanupHandBackResult[] = [];
    for (const row of completedAdmissionRows()) {
      results.push(await handBackCompleted({ jobId: requiredRowString(row, 'job_id'), admissionId: requiredRowString(row, 'admission_id') }));
    }
    return results;
  }

  async function reconcileCompletedAdmissionsAtStartup(): Promise<void> {
    for (const row of completedAdmissionRows()) {
      try {
        await handBackCompleted({ jobId: requiredRowString(row, 'job_id'), admissionId: requiredRowString(row, 'admission_id') });
      } catch (error) {
        if (!(error instanceof RecoveryBoundaryError)) throw error;
      }
    }
  }

  async function admitAndStart(input: CleanupAdmissionInput): Promise<CleanupAdmissionResult> {
    requireAdmissionsOpen();
    safeSegment(input.jobId, 'job ID');
    return withJobLock(input.jobId, async () => {
      const at = input.at ?? clock.now();
      const generation = jobGeneration(input.jobId);
      const material = newAdmission(at);
      const reservation = { createdAt: at, expiresAt: reservationExpiry(at, input.expiresAt), owner: input.owner };
      reserveCredential(input.jobId, material.admissionId, input.owner, reservation.createdAt, reservation.expiresAt);
      const credential = await writeCredential(input.jobId, material.admissionId, generation, material.token, reservation);
      const unitName = `osi-image-builder-cleanup@${material.admissionId}.service`;
      const command: ApiWriteCommand = { kind: 'cleanup-admission', jobId: input.jobId, admissionId: material.admissionId, owner: input.owner, unitName, expiresAt: input.expiresAt, credentialRelativePath: credential.relativePath, credentialSha256: credential.sha256, fenceTokenHash: crypto.sha256(material.token), reservationCreatedAt: reservation.createdAt, reservationExpiresAt: reservation.expiresAt, snapshot: input.snapshot, at };
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
    if (actual.previousStatus !== expected.previousStatus || actual.previousOwner !== expected.previousOwner || actual.previousExpiresAt !== expected.previousExpiresAt || actual.previousUnitName !== expected.previousUnitName || actual.previousFenceGeneration !== expected.previousFenceGeneration || actual.previousFenceTokenHash !== expected.previousFenceTokenHash || actual.previousClaimAt !== expected.previousClaimAt || actual.previousRenewAt !== expected.previousRenewAt || stableJson(actual.previousBlocker) !== stableJson(expected.previousBlocker) || stableJson(actual.previousUnexpectedExit ?? null) !== stableJson(expected.previousUnexpectedExit ?? null) || (actual.previousStopAuthorizationAttemptId ?? null) !== (expected.previousStopAuthorizationAttemptId ?? null) || (actual.previousStopAuthorizationOwner ?? null) !== (expected.previousStopAuthorizationOwner ?? null) || (actual.previousStopAuthorizationAt ?? null) !== (expected.previousStopAuthorizationAt ?? null) || (actual.previousStopAuthorizationExpiresAt ?? null) !== (expected.previousStopAuthorizationExpiresAt ?? null) || (actual.previousStopAuthorizationState ?? null) !== (expected.previousStopAuthorizationState ?? null)) throw new RecoveryBoundaryError('cleanup predecessor changed before rotation');
    return current;
  }

  function newStopAuthorization(at: string): StopAuthorizationRecord & { readonly attemptId: string } {
    const bytes = new Uint8Array(crypto.randomBytes(16)).slice(0, 16);
    if (bytes.length < 16) throw new RecoveryBoundaryError('cleanup stop authorization entropy is too short');
    const attemptId = `sta_${Buffer.from(bytes).toString('hex')}`;
    if (!STOP_AUTHORIZATION_ATTEMPT_PATTERN.test(attemptId)) throw new RecoveryBoundaryError('cleanup stop authorization attempt ID is invalid');
    const atMs = Date.parse(at);
    if (Number.isNaN(atMs)) throw new RecoveryBoundaryError('cleanup stop authorization time is invalid');
    return {
      attemptId,
      authorizationOwner: `cleanup-stop:${attemptId}`,
      authorizationAt: at,
      authorizationExpiresAt: new Date(atMs + STOP_AUTHORIZATION_HOLD_MS).toISOString(),
      state: 'authorized',
    };
  }

  function authorizeStop(
    input: ReconcileAdmissionInput,
    expected: CleanupAdmissionPredecessor,
    at: string,
    retry: CorrectedRetryAdmissionInput | null,
  ): StopAuthorizationRecord {
    const material = newStopAuthorization(at);
    const previousOwner = expected.previousOwner;
    const previousExpiresAt = expected.previousExpiresAt;
    if (typeof previousOwner !== 'string' || typeof previousExpiresAt !== 'string') throw new RecoveryBoundaryError('cleanup stop authorization predecessor owner or expiry is unavailable');
    ownershipCommandResult(options.ownership.apiWrite({
      kind: 'cleanup-admission-stop-authorize',
      ...expected,
      jobId: input.jobId,
      owner: input.owner,
      previousOwner,
      previousExpiresAt,
      authorizationOwner: material.authorizationOwner,
      attemptId: material.attemptId,
      authorizationAt: material.authorizationAt,
      authorizationExpiresAt: material.authorizationExpiresAt,
      ...(retry === null ? {} : {
        explicitRetry: true,
        expectedAuthorizationAttemptId: dbStopAuthorization(input.admissionId, input.jobId)?.attemptId ?? null,
      }),
      at,
    }));
    ownedStopAuthorizationAttempts.add(material.attemptId);
    return material;
  }

  async function completeStopAuthorization(input: ReconcileAdmissionInput, authorization: StopAuthorizationRecord, unitName: string, at: string): Promise<void> {
    ownershipCommandResult(options.ownership.apiWrite({
      kind: 'cleanup-admission-stop-complete',
      jobId: input.jobId,
      admissionId: input.admissionId,
      attemptId: authorization.attemptId,
      authorizationOwner: authorization.authorizationOwner,
      observation: { kind: 'cleanup-stop-observation', code: 'CLEANUP_UNIT_STOP_CONFIRMED_INACTIVE', unitName, active: false, observedAt: at },
      at,
    }));
  }

  async function recordUnexpectedExit(input: ReconcileAdmissionInput, expected: CleanupAdmissionPredecessor, at: string): Promise<CleanupAdmissionPredecessor> {
    const previousOwner = expected.previousOwner;
    const previousExpiresAt = expected.previousExpiresAt;
    if (typeof previousOwner !== 'string' || typeof previousExpiresAt !== 'string') throw new RecoveryBoundaryError('cleanup unexpected-exit predecessor owner or expiry is unavailable');
    if (expected.previousUnexpectedExit !== null && expected.previousUnexpectedExit !== undefined) {
      const persisted = expected.previousUnexpectedExit;
      if (persisted.kind !== 'cleanup-unit-unexpected-exit' || persisted.code !== 'CLEANUP_UNIT_UNEXPECTED_EXIT' || persisted.active !== false || persisted.unitName !== expected.previousUnitName || persisted.inactiveAt !== persisted.observedAt) throw new RecoveryBoundaryError('persisted cleanup unexpected-exit evidence is invalid');
      return expected;
    }
    const observation = { kind: 'cleanup-unit-unexpected-exit', code: 'CLEANUP_UNIT_UNEXPECTED_EXIT', unitName: expected.previousUnitName, active: false, inactiveAt: at, observedAt: at } satisfies JsonObject;
    ownershipCommandResult(options.ownership.apiWrite({
      kind: 'cleanup-admission-unexpected-exit',
      ...expected,
      jobId: input.jobId,
      previousOwner,
      previousExpiresAt,
      observation,
      at,
    }));
    const current = dbLease(input.admissionId, input.jobId);
    if (current === null) throw new RecoveryBoundaryError('cleanup predecessor disappeared after unexpected-exit evidence');
    return predecessor(current);
  }

  async function rotateInternal(input: ReconcileAdmissionInput, retry: CorrectedRetryAdmissionInput | null): Promise<CleanupAdmissionResult> {
    const at = input.at ?? clock.now();
    const old = dbLease(input.admissionId, input.jobId);
    if (old === null) throw new RecoveryBoundaryError('cleanup admission does not exist');
    if (old.status === 'expired') throw new RecoveryBoundaryError('cleanup admission is not rotatable');
    let expected = predecessor(old);
    if (expected.previousStatus === 'failed' || expected.previousStatus === 'blocking') {
      if (retry === null) throw new RecoveryBoundaryError('failed or blocking cleanup admission requires explicit corrected retry');
    } else if (retry !== null) {
      throw new RecoveryBoundaryError('corrected cleanup retry requires a failed or blocking predecessor');
    }
    const oldUnit = expected.previousUnitName;
    const oldUnexpired = typeof old.expires_at === 'string' && old.expires_at > at;
    const previousExpiresAt = typeof old.expires_at === 'string' ? old.expires_at : null;
    if (previousExpiresAt === null) throw new RecoveryBoundaryError('cleanup predecessor expiry is invalid');
    let stopped = false;

    const persistStopFailure = async (failure: CleanupStopFailure | 'authorization-orphaned', cause: unknown, authorization: StopAuthorizationRecord, observedAt: string): Promise<void> => {
      const previousOwner = expected.previousOwner;
      const previousExpiresAt = expected.previousExpiresAt;
      if (typeof previousOwner !== 'string' || typeof previousExpiresAt !== 'string') throw new RecoveryBoundaryError('cleanup predecessor owner or expiry is invalid');
      const orphaned = failure === 'authorization-orphaned';
      const blocker: JsonObject = {
        kind: orphaned ? 'cleanup-stop-authorization-orphaned' : 'cleanup-unit-stop-failed',
        code: 'CLEANUP_UNIT_STOP_FAILED',
        unitName: oldUnit,
        failure,
        observedAt,
        error: {
          message: cause instanceof Error ? cause.message : String(cause),
          code: errorCode(cause),
        },
      };
      ownershipCommandResult(options.ownership.apiWrite({
        kind: 'cleanup-admission-stop-failed',
        ...expected,
        jobId: input.jobId,
        owner: input.owner,
        previousOwner,
        previousExpiresAt,
        failure,
        stopAuthorizationAttemptId: authorization.attemptId,
        stopAuthorizationOwner: authorization.authorizationOwner,
        stopAuthorizationAt: authorization.authorizationAt,
        stopAuthorizationExpiresAt: authorization.authorizationExpiresAt,
        blockerCode: 'CLEANUP_UNIT_STOP_FAILED',
        blocker,
        snapshot: input.snapshot,
        at: observedAt,
      }));
    };

    const reconcileAuthorizationHead = async (): Promise<void> => {
      const authorization = dbStopAuthorization(input.admissionId, input.jobId);
      if (!authorization) return;
      if (authorization.state === 'authorized') {
        if (ownedStopAuthorizationAttempts.has(authorization.attemptId)) return;
        if (authorization.authorizationExpiresAt > at) throw new RecoveryBoundaryError('cleanup stop authorization is held by another owner; recovery deferred');
        const orphaned = new CleanupStopFailureError('still-active', 'cleanup stop authorization is orphaned after expiring before completion');
        await persistStopFailure('authorization-orphaned', orphaned, authorization, clock.now());
        throw orphaned;
      }
      if ((authorization.state === 'failed' || authorization.state === 'orphaned') && retry === null) {
        throw new RecoveryBoundaryError('cleanup stop authorization requires explicit corrected retry');
      }
    };

    const observeActive = async (): Promise<boolean> => options.systemd.isActive(oldUnit);
    await reconcileAuthorizationHead();
    const initialActive = await observeActive();
    if (initialActive && oldUnexpired) throw new RecoveryBoundaryError('cleanup worker is active; recovery deferred');
    if (!initialActive && oldUnexpired && expected.previousStatus === 'claimed') {
      const confirmedInactive = await observeActive();
      if (confirmedInactive) throw new RecoveryBoundaryError('cleanup worker became active; recovery deferred');
      expected = await recordUnexpectedExit(input, expected, at);
    }

    const stopStaleOnce = async (active: boolean): Promise<void> => {
      if (!active) return;
      if (oldUnexpired) throw new RecoveryBoundaryError('cleanup worker is active; recovery deferred');
      if (stopped) {
        const error = new CleanupStopFailureError('still-active', `cleanup predecessor remains active after stop: ${oldUnit}`);
        const existing = dbStopAuthorization(input.admissionId, input.jobId);
        if (!existing) throw new RecoveryBoundaryError('cleanup stop authorization disappeared after stop');
        await persistStopFailure(error.failure, error, existing, clock.now());
        throw error;
      }
      let authorization = dbStopAuthorization(input.admissionId, input.jobId);
      if (authorization?.state === 'authorized' && !ownedStopAuthorizationAttempts.has(authorization.attemptId)) {
        if (authorization.authorizationExpiresAt <= at) {
          const orphaned = new CleanupStopFailureError('still-active', 'cleanup stop authorization is orphaned after expiring while the unit remained active');
          await persistStopFailure('authorization-orphaned', orphaned, authorization, clock.now());
          throw orphaned;
        }
        throw new RecoveryBoundaryError('cleanup stop authorization is held by another owner');
      }
      if (authorization && ['failed', 'orphaned'].includes(authorization.state)) {
        if (retry === null) throw new RecoveryBoundaryError('cleanup stop authorization is orphaned; explicit corrected retry is required');
        authorization = authorizeStop(input, expected, at, retry);
      } else if (!authorization) {
        authorization = authorizeStop(input, expected, at, retry);
      }
      if (authorization.state !== 'authorized' || !ownedStopAuthorizationAttempts.has(authorization.attemptId)) throw new RecoveryBoundaryError('cleanup stop authorization owner is not current');
      try {
        await stopAndConfirmInactive(oldUnit);
        const observedAt = clock.now();
        await completeStopAuthorization(input, authorization, oldUnit, observedAt);
        const current = dbLease(input.admissionId, input.jobId);
        if (current === null) throw new RecoveryBoundaryError('cleanup predecessor disappeared after stop authorization completion');
        expected = predecessor(current);
        stopped = true;
      } catch (error) {
        const failure = error instanceof CleanupStopFailureError ? error.failure : 'stop-error';
        await persistStopFailure(failure, error, authorization, clock.now());
        throw error;
      }
    }
    await stopStaleOnce(initialActive);
    let credentialValid = true;
    if (retry === null) {
      try { await readCredential(input.jobId, old); }
      catch (error) {
        if (!(error instanceof CleanupCredentialInvalidError)) throw error;
        credentialValid = false;
      }
    } else if (expected.previousBlockerCode !== retry.expectedBlockerCode || stableJson(expected.previousBlocker) !== stableJson(retry.expectedBlocker)) {
      throw new RecoveryBoundaryError('corrected cleanup retry blocker does not match persisted evidence');
    }
    if (retry === null && credentialValid && expected.previousStatus === 'admitted' && oldUnexpired) {
      await ensurePredecessorStillMatches(input.jobId, expected);
      await stopStaleOnce(await observeActive());
      await start(oldUnit);
      return {
        admissionId: expected.previousAdmissionId,
        generation: expected.previousFenceGeneration,
        unitName: oldUnit,
        credentialRelativePath: String(old.credential_relative_path),
        credentialSha256: String(old.credential_sha256),
        rotated: false,
        started: true,
      };
    }
    await reconcileAuthorizationHead();
    await ensurePredecessorStillMatches(input.jobId, expected);
    await stopStaleOnce(await observeActive());
    const generation = jobGeneration(input.jobId);
    const material = newAdmission(at);
    const reservation = { createdAt: at, expiresAt: reservationExpiry(at, input.expiresAt), owner: input.owner };
    reserveCredential(input.jobId, material.admissionId, input.owner, reservation.createdAt, reservation.expiresAt);
    const credential = await writeCredential(input.jobId, material.admissionId, generation, material.token, reservation);
    await stopStaleOnce(await observeActive());
    await ensurePredecessorStillMatches(input.jobId, expected);
    const unitName = `osi-image-builder-cleanup@${material.admissionId}.service`;
    const command: ApiWriteCommand = retry === null
      ? { kind: 'cleanup-admission-rotate', ...expected, jobId: input.jobId, admissionId: material.admissionId, owner: input.owner, unitName, expiresAt: input.expiresAt, credentialRelativePath: credential.relativePath, credentialSha256: credential.sha256, fenceTokenHash: crypto.sha256(material.token), reservationCreatedAt: reservation.createdAt, reservationExpiresAt: reservation.expiresAt, snapshot: input.snapshot, at }
      : { kind: 'cleanup-admission-retry', ...expected, jobId: input.jobId, admissionId: material.admissionId, owner: input.owner, unitName, expiresAt: input.expiresAt, credentialRelativePath: credential.relativePath, credentialSha256: credential.sha256, fenceTokenHash: crypto.sha256(material.token), reservationCreatedAt: reservation.createdAt, reservationExpiresAt: reservation.expiresAt, expectedBlockerCode: retry.expectedBlockerCode, expectedBlocker: retry.expectedBlocker, snapshot: retry.correctedSnapshot, at };
    ownershipCommandResult(options.ownership.apiWrite(command));
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

  async function withPruneTransaction<T>(work: () => Promise<T>): Promise<T> {
    const transactional = typeof (options.db as RecoveryDatabase).exec === 'function';
    if (!transactional) return work();
    databaseExec(options.db, 'BEGIN IMMEDIATE');
    try {
      const result = await work();
      databaseExec(options.db, 'COMMIT');
      return result;
    } catch (error) {
      try { databaseExec(options.db, 'ROLLBACK'); } catch (rollbackError) { throw new RecoveryBoundaryError('cleanup prune transaction rollback failed', { cause: rollbackError }); }
      throw error;
    }
  }

  async function pruneInternal(): Promise<number> {
    return withPruneTransaction(async () => {
      const now = clock.now();
      databaseRun(options.db, 'DELETE FROM cleanup_credential_reservations WHERE expires_at <= ?', now);
      const root = await fileSystem.openDirectory(options.stateRoot);
      try {
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
                const match = name.match(CREDENTIAL_NAME_PATTERN);
                if (!match) continue;
                const admissionId = `cln_${match[1]}`;
                let handle: RecoveryFileHandle | null = null;
                try {
                  handle = await directory.directory.openFileChild(name, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
                  verifyCredentialFile(await handle.stat(), `${CREDENTIAL_DIRECTORY}/${name}`, ownerUid);
                } catch (error) {
                  if (handle !== null) await handle.close();
                  void error;
                  continue;
                }
                await handle.close(); handle = null;
                const matchingLease = options.db.prepare('SELECT 1 FROM cleanup_leases WHERE job_id=? AND admission_id=?').get(jobId, admissionId);
                const matchingReservation = options.db.prepare(
                  `SELECT 1 FROM cleanup_credential_reservations
                   WHERE job_id=? AND admission_id=? AND credential_relative_path=? AND expires_at > ?`,
                ).get(jobId, admissionId, `${CREDENTIAL_DIRECTORY}/${name}`, now);
                if ((matchingLease !== undefined && matchingLease !== null) || (matchingReservation !== undefined && matchingReservation !== null)) continue;
                await directory.directory.unlinkChild(name);
                await directory.directory.sync();
                removed += 1;
              }
            } finally { await directory.close(); }
          }
          return removed;
        } finally {
          if (jobs !== null) await jobs.close();
        }
      } finally {
        await root.close();
      }
    });
  }

  async function openAdmissions(): Promise<void> {
    await withLifecycleLock(async () => {
      if (admissionsOpen) return;
      await pruneInternal();
      admissionsOpen = true;
      try {
        await reconcileCompletedAdmissionsAtStartup();
      } catch (error) {
        admissionsOpen = false;
        throw error;
      }
    });
  }

  async function pruneOrphanCredentials(): Promise<number> {
    return withLifecycleLock(async () => {
      if (admissionsOpen) throw new RecoveryBoundaryError('prune is unavailable after admissions open');
      return pruneInternal();
    });
  }

  return { admitAndStart, reconcileAndStart, retryCorrectedAndStart, handBackCompleted, reconcileCompletedAdmissions, openAdmissions, pruneOrphanCredentials };
}
