import { createHash } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { join } from 'node:path';

import {
  ConfigAuthorityError,
  withApprovedRootSnapshot,
  withStateRootSnapshot,
  type ApprovedRootRegistry,
  type StateRootAuthority,
} from '../../config/load.js';
import {
  RecoveryBoundaryError,
  RecoveryInfrastructureError,
  type RecoveryCleanupEvidence,
  type RecoveryCleanupEvidenceReader,
  type RecoveryStagingVerificationInput,
  type RecoveryStagingVerifier,
} from './recovery.js';
import type { CleanupPostcondition } from './ownership.js';
import { JSON_LIMITS, TEXT_LIMITS, canonicalInstant, encodeJson, type JsonObject } from './validation.js';
import { ACTIVE_RECOVERY_STATES, ADMISSION_ID_PATTERN } from '../../domain/types.js';

const DIRECTORY_MODE = 0o700;
const PUBLISHER_DIRECTORY_MODE = 0o750;
const EVIDENCE_MODE = 0o600;
const MAX_EVIDENCE_BYTES = JSON_LIMITS.maxEncodedBytes + 1;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH64 = /^[0-9a-f]{64}$/u;
const RUNNER_UNIT_PATTERN = /^osi-image-builder-runner@[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.service$/u;
const PROC_FD = '/proc/self/fd';
const O_CLOEXEC = (fsConstants as typeof fsConstants & { readonly O_CLOEXEC?: number }).O_CLOEXEC ?? 0x80000;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | O_CLOEXEC;
const FILE_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | O_CLOEXEC;
const FATAL_DECODER = new TextDecoder('utf-8', { fatal: true });
const BOUNDARY_OPEN_ERROR_CODES = new Set([
  'EACCES',
  'EISDIR',
  'ELOOP',
  'ENOENT',
  'ENOTDIR',
  'EPERM',
]);

export interface RecoveryPhysicalVerificationOptions {
  readonly stateRootAuthority: StateRootAuthority;
  readonly approvedRootRegistry: ApprovedRootRegistry;
  readonly ownerUid?: number;
  readonly maxEvidenceBytes?: number;
}

export interface RecoveryPhysicalVerification {
  readonly evidence: RecoveryCleanupEvidenceReader;
  readonly staging: RecoveryStagingVerifier;
}

type NativeStats = Stats;
type RecordValue = Record<string, unknown>;

function fail(message: string, cause?: unknown): never {
  throw new RecoveryBoundaryError(message, cause === undefined ? undefined : { cause });
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

export type RecoveryFileSystemOperation = 'open' | 'stat' | 'read' | 'close';

export function classifyRecoveryFileSystemError(
  operation: RecoveryFileSystemOperation,
  message: string,
  cause: unknown,
): RecoveryBoundaryError | RecoveryInfrastructureError {
  if (cause instanceof RecoveryBoundaryError || cause instanceof RecoveryInfrastructureError) return cause;
  const code = errorCode(cause);
  if (operation === 'open' && BOUNDARY_OPEN_ERROR_CODES.has(code ?? '')) {
    return new RecoveryBoundaryError(message, { cause });
  }
  return new RecoveryInfrastructureError(message, { cause });
}

function fileSystemFailure(operation: RecoveryFileSystemOperation, message: string, cause: unknown): never {
  throw classifyRecoveryFileSystemError(operation, message, cause);
}

export function classifyRecoveryAuthorityError(
  message: string,
  error: unknown,
): RecoveryBoundaryError | RecoveryInfrastructureError {
  if (error instanceof RecoveryBoundaryError || error instanceof RecoveryInfrastructureError) return error;
  if (error instanceof ConfigAuthorityError) {
    if (error.code !== undefined || error.cause === undefined) {
      return new RecoveryBoundaryError(message, { cause: error });
    }
    const cause = error.cause;
    if (BOUNDARY_OPEN_ERROR_CODES.has(errorCode(cause) ?? '')) {
      return new RecoveryBoundaryError(message, { cause: error });
    }
    return new RecoveryInfrastructureError(message, { cause: error });
  }
  return new RecoveryInfrastructureError(message, { cause: error });
}

function authorityFailure(message: string, error: unknown): never {
  throw classifyRecoveryAuthorityError(message, error);
}

async function descriptorStat(handle: FileHandle, field: string): Promise<NativeStats> {
  try {
    return await handle.stat();
  } catch (error) {
    return fileSystemFailure('stat', `cannot stat recovery descriptor: ${field}`, error);
  }
}

async function descriptorRead(
  handle: FileHandle,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
  field: string,
): Promise<Readonly<{ bytesRead: number; buffer: Buffer }>> {
  try {
    return await handle.read(buffer, offset, length, position);
  } catch (error) {
    return fileSystemFailure('read', `cannot read recovery descriptor: ${field}`, error);
  }
}

async function descriptorClose(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    fileSystemFailure('close', 'cannot close recovery descriptor', error);
  }
}

function safeSegment(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    return fail(`${field} is not a safe path segment`);
  }
  return value;
}

function safeJobId(value: unknown): string {
  if (typeof value !== 'string' || !JOB_ID_PATTERN.test(value)) return fail('job ID is invalid');
  return value;
}

function safeAdmissionId(value: unknown): string {
  if (typeof value !== 'string' || !ADMISSION_ID_PATTERN.test(value)) return fail('admission ID is invalid');
  return value;
}

function modeOf(stats: NativeStats): number {
  const mode = typeof stats.mode === 'bigint' ? Number(stats.mode) : stats.mode;
  return mode & 0o7777;
}

function assertDirectory(stats: NativeStats, field: string, ownerUid: number, device: number, exactMode = DIRECTORY_MODE): void {
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.uid !== ownerUid
    || modeOf(stats) !== exactMode
    || stats.nlink < 2
    || stats.dev !== device
  ) {
    fail(`unsafe recovery directory: ${field}`);
  }
}

function assertPublisherDirectory(stats: NativeStats, field: string, ownerUid: number, device: number): void {
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.uid !== ownerUid
    || modeOf(stats) !== PUBLISHER_DIRECTORY_MODE
    || stats.nlink < 2
    || stats.dev !== device
  ) {
    fail(`unsafe recovery publisher directory: ${field}`);
  }
}

function assertJobDirectory(stats: NativeStats, field: string, ownerUid: number, device: number): void {
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.uid !== ownerUid
    || modeOf(stats) !== DIRECTORY_MODE
    || stats.nlink < 2
    || stats.dev !== device
  ) {
    fail(`unsafe recovery job directory: ${field}`);
  }
}

function sameDirectoryIdentity(left: NativeStats, right: NativeStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertApprovedRoot(stats: NativeStats, field: string, ownerUid: number, device: number, inode: number): void {
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.uid !== ownerUid
    || (modeOf(stats) & 0o700) !== 0o700
    || (modeOf(stats) & 0o022) !== 0
    || stats.nlink < 2
    || stats.dev !== device
    || stats.ino !== inode
  ) {
    fail(`unsafe approved output root: ${field}`);
  }
}

function assertRegularEvidence(stats: NativeStats, field: string, ownerUid: number, device: number): void {
  if (
    stats.isSymbolicLink()
    || !stats.isFile()
    || stats.uid !== ownerUid
    || modeOf(stats) !== EVIDENCE_MODE
    || stats.nlink !== 1
    || stats.dev !== device
  ) {
    fail(`unsafe cleanup evidence file: ${field}`);
  }
}

function assertRegularArtifact(stats: NativeStats, field: string, ownerUid: number, device: number): void {
  if (
    stats.isSymbolicLink()
    || !stats.isFile()
    || stats.uid !== ownerUid
    || modeOf(stats) !== EVIDENCE_MODE
    || stats.nlink !== 1
    || stats.dev !== device
  ) {
    fail(`unsafe quarantined artifact file: ${field}`);
  }
}

function childPath(parent: FileHandle, name: string, field: string): string {
  safeSegment(name, field);
  if (process.platform !== 'linux') return fail('descriptor recovery verification requires Linux no-follow semantics');
  return join(PROC_FD, String(parent.fd), name);
}

async function openDirectoryChild(parent: FileHandle, name: string, field: string): Promise<FileHandle> {
  try {
    return await open(childPath(parent, name, field), DIRECTORY_FLAGS);
  } catch (error) {
    return fileSystemFailure('open', `cannot open recovery directory: ${field}`, error);
  }
}

async function openOptionalDirectoryChild(parent: FileHandle, name: string, field: string): Promise<FileHandle | null> {
  try {
    return await open(childPath(parent, name, field), DIRECTORY_FLAGS);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    return fileSystemFailure('open', `cannot inspect recovery directory: ${field}`, error);
  }
}

async function openFileChild(parent: FileHandle, name: string, field: string): Promise<FileHandle> {
  try {
    return await open(childPath(parent, name, field), FILE_FLAGS);
  } catch (error) {
    return fileSystemFailure('open', `cannot open recovery evidence: ${field}`, error);
  }
}

async function closeHandles(handles: readonly (FileHandle | null)[]): Promise<void> {
  let firstError: unknown;
  for (const handle of handles.slice().reverse()) {
    if (handle === null) continue;
    try {
      await descriptorClose(handle);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

async function revalidateManagedJob(
  root: FileHandle,
  heldBuilder: FileHandle | null,
  heldParent: FileHandle | null,
  parentName: 'staging' | 'quarantine',
  jobId: string,
  expectedJob: FileHandle | null,
  ownerUid: number,
  device: number,
): Promise<void> {
  const currentBuilder = await openOptionalDirectoryChild(root, '.osi-image-builder', '.osi-image-builder');
  let currentParent: FileHandle | null = null;
  let currentJob: FileHandle | null = null;
  try {
    if (currentBuilder === null) {
      if (heldBuilder !== null || expectedJob !== null) return fail('managed output directory changed during staging verification');
      return;
    }
    const currentBuilderStats = await descriptorStat(currentBuilder, '.osi-image-builder');
    assertPublisherDirectory(currentBuilderStats, '.osi-image-builder', ownerUid, device);
    if (heldBuilder !== null && !sameDirectoryIdentity(await descriptorStat(heldBuilder, '.osi-image-builder held'), currentBuilderStats)) return fail('managed output directory identity changed during staging verification');

    currentParent = await openOptionalDirectoryChild(currentBuilder, parentName, `.osi-image-builder/${parentName}`);
    if (currentParent === null) {
      if (heldParent !== null || expectedJob !== null) return fail(`managed ${parentName} directory changed during staging verification`);
      return;
    }
    const currentParentStats = await descriptorStat(currentParent, `.osi-image-builder/${parentName}`);
    assertPublisherDirectory(currentParentStats, `.osi-image-builder/${parentName}`, ownerUid, device);
    if (heldParent !== null && !sameDirectoryIdentity(await descriptorStat(heldParent, `.osi-image-builder/${parentName} held`), currentParentStats)) return fail(`managed ${parentName} directory identity changed during staging verification`);

    currentJob = await openOptionalDirectoryChild(currentParent, jobId, `${parentName}/${jobId}`);
    if (currentJob === null) {
      if (expectedJob !== null) return fail(`managed ${parentName} job directory disappeared during staging verification`);
      return;
    }
    const currentJobStats = await descriptorStat(currentJob, `${parentName}/${jobId}`);
    assertJobDirectory(currentJobStats, `${parentName}/${jobId}`, ownerUid, device);
    if (expectedJob === null) return fail(`managed ${parentName} job directory appeared during staging verification`);
    if (!sameDirectoryIdentity(await descriptorStat(expectedJob, `${parentName}/${jobId} held`), currentJobStats)) return fail(`managed ${parentName} destination identity changed during staging verification`);
  } finally {
    await closeHandles([currentJob, currentParent, currentBuilder]);
  }
}

async function withDirectory<T>(
  openDirectory: () => Promise<FileHandle>,
  callback: (directory: FileHandle) => Promise<T>,
): Promise<T> {
  const directory = await openDirectory();
  try {
    return await callback(directory);
  } finally {
    await closeHandles([directory]);
  }
}

function stableStats(before: NativeStats, after: NativeStats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.uid === after.uid
    && before.gid === after.gid
    && before.nlink === after.nlink
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

async function readBoundedFile(handle: FileHandle, maxBytes: number, field: string, ownerUid: number, device: number): Promise<Buffer> {
  const before = await descriptorStat(handle, field);
  assertRegularEvidence(before, field, ownerUid, device);
  if (!Number.isSafeInteger(before.size) || before.size > maxBytes) return fail(`${field} exceeds its bounded read limit`);
  const bytes = Buffer.alloc(before.size);
  let position = 0;
  while (position < bytes.length) {
    const result = await descriptorRead(handle, bytes, position, bytes.length - position, position, field);
    if (result.bytesRead <= 0) return fail(`${field} changed during bounded read`);
    position += result.bytesRead;
  }
  const after = await descriptorStat(handle, field);
  if (!stableStats(before, after)) return fail(`${field} changed during bounded read`);
  return bytes;
}

async function hashBoundedArtifact(
  handle: FileHandle,
  expectedSize: number,
  expectedSha256: string,
  expectedMtime: string,
  field: string,
  ownerUid: number,
  device: number,
): Promise<void> {
  const before = await descriptorStat(handle, field);
  assertRegularArtifact(before, field, ownerUid, device);
  if (before.size !== expectedSize) return fail(`${field} size does not match the persisted artifact identity`);
  if (before.mtime.toISOString() !== expectedMtime) return fail(`${field} mtime does not match the persisted artifact identity`);
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < expectedSize) {
    const result = await descriptorRead(handle, buffer, 0, Math.min(buffer.length, expectedSize - position), position, field);
    if (result.bytesRead <= 0) return fail(`${field} changed during bounded hash`);
    digest.update(buffer.subarray(0, result.bytesRead));
    position += result.bytesRead;
  }
  const after = await descriptorStat(handle, field);
  if (!stableStats(before, after) || after.size !== expectedSize) return fail(`${field} changed during bounded hash`);
  if (digest.digest('hex') !== expectedSha256) return fail(`${field} hash does not match the persisted artifact identity`);
}

async function hashBoundedSidecar(handle: FileHandle, expectedSha256: string, maxBytes: number, field: string, ownerUid: number, device: number): Promise<void> {
  const before = await descriptorStat(handle, field);
  assertRegularArtifact(before, field, ownerUid, device);
  if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) return fail(`${field} exceeds its bounded sidecar limit`);
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(before.size, 1)));
  let position = 0;
  while (position < before.size) {
    const result = await descriptorRead(handle, buffer, 0, Math.min(buffer.length, before.size - position), position, field);
    if (result.bytesRead <= 0) return fail(`${field} changed during bounded hash`);
    digest.update(buffer.subarray(0, result.bytesRead));
    position += result.bytesRead;
  }
  const after = await descriptorStat(handle, field);
  if (!stableStats(before, after)) return fail(`${field} changed during bounded hash`);
  if (digest.digest('hex') !== expectedSha256) return fail(`${field} hash does not match the persisted sidecar identity`);
}

function stagingFileName(value: string, jobId: string, field: string, expectedName?: string): string {
  const parts = value.split('/');
  if (parts.length !== 3 || parts[0] !== 'staging' || parts[1] !== jobId) return fail(`${field} is outside the fixed job directory`);
  const name = safeSegment(parts[2], field);
  if (value !== `staging/${jobId}/${name}` || (expectedName !== undefined && name !== expectedName)) return fail(`${field} is not the fixed staging file`);
  return name;
}

function record(value: unknown, field: string): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail(`${field} must be an object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')) return fail(`${field} contains a symbol property`);
  for (const key of keys as string[]) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return fail(`${field} contains an unsafe property`);
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor)) return fail(`${field}.${key} is an accessor property`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail(`${field} must be a plain object`);
  return value as RecordValue;
}

function exactKeys(value: unknown, expected: readonly string[], field: string): RecordValue {
  const result = record(value, field);
  const actual = Reflect.ownKeys(result).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) return fail(`${field} contains extra or missing fields`);
  return result;
}

function text(value: unknown, field: string, maxBytes = 4_096): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes) return fail(`${field} is invalid`);
  return value;
}

function nullableText(value: unknown, field: string, maxBytes = 4_096): string | null {
  return value === null ? null : text(value, field, maxBytes);
}

function hash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HASH64.test(value)) return fail(`${field} is not a SHA-256 hash`);
  return value;
}

function boolean(value: unknown, expected: boolean, field: string): true {
  if (value !== expected) return fail(`${field} is invalid`);
  return true;
}

function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail(`${field} is invalid`);
  return value;
}

function instant(value: unknown, field: string): string {
  try {
    return canonicalInstant(value, field);
  } catch (error) {
    return fail(`${field} is invalid`, error);
  }
}

function jsonObject(value: unknown, field: string): JsonObject {
  const result = record(value, field);
  try {
    encodeJson(result, field, true);
  } catch (error) {
    return fail(`${field} is not bounded JSON`, error);
  }
  return result as JsonObject;
}

function validateRunner(value: unknown, field: string): CleanupPostcondition['runner'] {
  const runner = exactKeys(value, ['unit', 'owner', 'leaseExpiresAt', 'inactiveAt', 'observedAt'], field);
  const unit = text(runner.unit, `${field}.unit`, 256);
  if (!RUNNER_UNIT_PATTERN.test(unit)) return fail(`${field}.unit is invalid`);
  return {
    unit,
    owner: nullableText(runner.owner, `${field}.owner`, 256),
    leaseExpiresAt: runner.leaseExpiresAt === null ? null : instant(runner.leaseExpiresAt, `${field}.leaseExpiresAt`),
    inactiveAt: instant(runner.inactiveAt, `${field}.inactiveAt`),
    observedAt: instant(runner.observedAt, `${field}.observedAt`),
  };
}

function validateContainer(value: unknown, field: string): CleanupPostcondition['container'] {
  const initial = record(value, field);
  if (initial.kind === 'null-identity') {
    const container = exactKeys(initial, ['kind', 'dockerAction', 'globalLabelResult', 'observedAt'], field);
    if (container.dockerAction !== 'none' || container.globalLabelResult !== 'no-match') return fail(`${field} null identity is invalid`);
    return { kind: 'null-identity', dockerAction: 'none', globalLabelResult: 'no-match', observedAt: instant(container.observedAt, `${field}.observedAt`) };
  }
  if (initial.kind === 'already-absent') {
    const container = exactKeys(initial, ['kind', 'id', 'name', 'imageDigest', 'labels', 'exactIdAbsent', 'dockerAction', 'globalLabelResult', 'observedAt'], field);
    boolean(container.exactIdAbsent, true, `${field}.exactIdAbsent`);
    if (container.dockerAction !== 'none' || container.globalLabelResult !== 'no-match') return fail(`${field} already-absent identity is invalid`);
    return {
      kind: 'already-absent',
      id: text(container.id, `${field}.id`, 256),
      name: text(container.name, `${field}.name`, 256),
      imageDigest: text(container.imageDigest, `${field}.imageDigest`, 256),
      labels: jsonObject(container.labels, `${field}.labels`),
      exactIdAbsent: true,
      dockerAction: 'none',
      globalLabelResult: 'no-match',
      observedAt: instant(container.observedAt, `${field}.observedAt`),
    };
  }
  if (initial.kind === 'removed') {
    const container = exactKeys(initial, ['kind', 'id', 'name', 'imageDigest', 'labels', 'exactIdAbsent', 'globalLabelResult', 'stoppedAt', 'removedAt', 'observedAt'], field);
    boolean(container.exactIdAbsent, true, `${field}.exactIdAbsent`);
    if (container.globalLabelResult !== 'no-match') return fail(`${field} removed identity is invalid`);
    return {
      kind: 'removed',
      id: text(container.id, `${field}.id`, 256),
      name: text(container.name, `${field}.name`, 256),
      imageDigest: text(container.imageDigest, `${field}.imageDigest`, 256),
      labels: jsonObject(container.labels, `${field}.labels`),
      exactIdAbsent: true,
      globalLabelResult: 'no-match',
      stoppedAt: instant(container.stoppedAt, `${field}.stoppedAt`),
      removedAt: instant(container.removedAt, `${field}.removedAt`),
      observedAt: instant(container.observedAt, `${field}.observedAt`),
    };
  }
  return fail(`${field}.kind is invalid`);
}

function validateStaging(value: unknown, jobId: string, field: string): CleanupPostcondition['staging'] {
  const initial = record(value, field);
  const sourcePath = `staging/${jobId}`;
  if (initial.kind === 'absent') {
    const staging = exactKeys(initial, ['kind', 'path', 'sourcePath', 'sourceAbsent', 'verifiedAt'], field);
    if (staging.path !== null || staging.sourcePath !== sourcePath) return fail(`${field} absent path is invalid`);
    boolean(staging.sourceAbsent, true, `${field}.sourceAbsent`);
    return { kind: 'absent', path: null, sourcePath, sourceAbsent: true, verifiedAt: instant(staging.verifiedAt, `${field}.verifiedAt`) };
  }
  if (initial.kind === 'quarantined') {
    const staging = exactKeys(initial, ['kind', 'sourcePath', 'destinationPath', 'sourceAbsent', 'destinationPresent', 'sha256', 'size', 'verifiedAt'], field);
    const destinationPath = `quarantine/${jobId}`;
    if (staging.sourcePath !== sourcePath || staging.destinationPath !== destinationPath) return fail(`${field} quarantine path is invalid`);
    boolean(staging.sourceAbsent, true, `${field}.sourceAbsent`);
    boolean(staging.destinationPresent, true, `${field}.destinationPresent`);
    const size = staging.size === null ? null : number(staging.size, `${field}.size`);
    const sha256 = staging.sha256 === null ? null : hash(staging.sha256, `${field}.sha256`);
    return { kind: 'quarantined', sourcePath, destinationPath, sourceAbsent: true, destinationPresent: true, sha256, size, verifiedAt: instant(staging.verifiedAt, `${field}.verifiedAt`) };
  }
  return fail(`${field}.kind is invalid`);
}

function validatePostcondition(value: unknown, jobId: string, field: string): CleanupPostcondition {
  const postcondition = exactKeys(value, ['runner', 'state', 'container', 'staging', 'logs', 'blocker'], field);
  const state = postcondition.state;
  const states = [...ACTIVE_RECOVERY_STATES, 'interrupted'] as readonly string[];
  if (typeof state !== 'string' || !states.includes(state)) return fail(`${field}.state is invalid`);
  const logs = exactKeys(postcondition.logs, ['runner', 'docker', 'verifiedAt'], `${field}.logs`);
  if (!['absent', 'sealed'].includes(String(logs.runner)) || !['absent', 'sealed'].includes(String(logs.docker))) return fail(`${field}.logs state is invalid`);
  if (postcondition.blocker !== 'none') return fail(`${field}.blocker is invalid`);
  return {
    runner: validateRunner(postcondition.runner, `${field}.runner`),
    state: state as CleanupPostcondition['state'],
    container: validateContainer(postcondition.container, `${field}.container`),
    staging: validateStaging(postcondition.staging, jobId, `${field}.staging`),
    logs: { runner: logs.runner as 'absent' | 'sealed', docker: logs.docker as 'absent' | 'sealed', verifiedAt: instant(logs.verifiedAt, `${field}.logs.verifiedAt`) },
    blocker: 'none',
  };
}

function parseCompletion(bytes: Buffer, jobId: string, admissionId: string, maxBytes: number): CleanupPostcondition {
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.at(-1) !== 0x0a) return fail('cleanup completion evidence framing is invalid');
  let source: string;
  try {
    source = FATAL_DECODER.decode(bytes);
  } catch (error) {
    return fail('cleanup completion evidence is not valid UTF-8', error);
  }
  if (!source.endsWith('\n') || source.slice(0, -1).includes('\n') || source.slice(0, -1).includes('\r')) return fail('cleanup completion evidence framing is invalid');
  const json = source.slice(0, -1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    return fail('cleanup completion evidence is corrupt', error);
  }
  let canonical: string;
  try {
    canonical = encodeJson(parsed, 'cleanup completion evidence', true);
  } catch (error) {
    return fail('cleanup completion evidence has unsafe JSON structure', error);
  }
  if (canonical !== json) return fail('cleanup completion evidence is not canonical JSON');
  const envelope = exactKeys(parsed, ['schemaVersion', 'kind', 'admissionId', 'jobId', 'postcondition', 'observedAt'], 'cleanup completion evidence');
  if (envelope.schemaVersion !== 1 || envelope.kind !== 'cleanup-complete' || envelope.jobId !== jobId || envelope.admissionId !== admissionId) return fail('cleanup completion evidence identity does not match the admission');
  instant(envelope.observedAt, 'cleanup completion evidence.observedAt');
  return validatePostcondition(envelope.postcondition, jobId, 'cleanup completion evidence.postcondition');
}

async function readCompletionEvidence(
  stateRootAuthority: StateRootAuthority,
  ownerUid: number,
  maxBytes: number,
  input: Readonly<{ jobId: string; admissionId: string; path: string; sha256: string }>,
): Promise<RecoveryCleanupEvidence> {
  const jobId = safeJobId(input.jobId);
  const admissionId = safeAdmissionId(input.admissionId);
  const expectedPath = `jobs/${jobId}/evidence/cleanup/${admissionId}.complete.json`;
  if (input.path !== expectedPath) return fail('cleanup evidence path is not the fixed completion path');
  const expectedSha256 = hash(input.sha256, 'cleanup evidence SHA-256');
  try {
    return await withStateRootSnapshot(stateRootAuthority, async ({ snapshot }) => withDirectory(
      async () => {
        try {
          return await open(snapshot.path, DIRECTORY_FLAGS);
        } catch (error) {
          return fileSystemFailure('open', 'state root could not be opened no-follow', error);
        }
      },
      async (root) => {
        const rootStats = await descriptorStat(root, 'state root');
        assertDirectory(rootStats, 'state root', ownerUid, snapshot.device);
        if (rootStats.ino !== snapshot.inode) return fail('state root identity changed while opening evidence');
        return withDirectory(
          () => openDirectoryChild(root, 'jobs', 'jobs'),
          async (jobs) => {
            assertDirectory(await descriptorStat(jobs, 'jobs'), 'jobs', ownerUid, snapshot.device);
            return withDirectory(
              () => openDirectoryChild(jobs, jobId, `jobs/${jobId}`),
              async (job) => {
                assertDirectory(await descriptorStat(job, `jobs/${jobId}`), `jobs/${jobId}`, ownerUid, snapshot.device);
                return withDirectory(
                  () => openDirectoryChild(job, 'evidence', `jobs/${jobId}/evidence`),
                  async (evidence) => {
                    assertDirectory(await descriptorStat(evidence, `jobs/${jobId}/evidence`), `jobs/${jobId}/evidence`, ownerUid, snapshot.device);
                    return withDirectory(
                      () => openDirectoryChild(evidence, 'cleanup', `jobs/${jobId}/evidence/cleanup`),
                      async (cleanup) => {
                        assertDirectory(await descriptorStat(cleanup, `jobs/${jobId}/evidence/cleanup`), `jobs/${jobId}/evidence/cleanup`, ownerUid, snapshot.device);
                        const fileName = `${admissionId}.complete.json`;
                        return withDirectory(
                          () => openFileChild(cleanup, fileName, expectedPath),
                          async (file) => {
                            const bytes = await readBoundedFile(file, maxBytes, expectedPath, ownerUid, snapshot.device);
                            const actualSha256 = createHash('sha256').update(bytes).digest('hex');
                            if (actualSha256 !== expectedSha256) return fail('cleanup completion evidence hash does not match the durable hash');
                            return {
                              jobId,
                              admissionId,
                              sha256: actualSha256,
                              postcondition: parseCompletion(bytes, jobId, admissionId, maxBytes),
                            };
                          },
                        );
                      },
                    );
                  },
                );
              },
            );
          },
        );
      },
    ));
  } catch (error) {
    return authorityFailure('state root authority verification failed', error);
  }
}

async function inspectStaging(
  approvedRootRegistry: ApprovedRootRegistry,
  ownerUid: number,
  input: RecoveryStagingVerificationInput,
): Promise<true> {
  const jobId = safeJobId(input.jobId);
  safeAdmissionId(input.admissionId);
  const rootId = safeSegment(input.rootId, 'approved root ID');
  const expected = validateStaging(input.postcondition, jobId, 'cleanup staging postcondition');
  const persistedArtifactPath = input.artifactStagingPath;
  if (persistedArtifactPath !== null) stagingFileName(persistedArtifactPath, jobId, 'persisted staging artifact path');
  const trackedArtifact = expected.kind === 'quarantined' && persistedArtifactPath !== null;
  let artifactName: string | null = null;
  let checksumName: string | null = null;
  let manifestName: string | null = null;
  let verificationName: string | null = null;
  const artifactIdentity = [
    persistedArtifactPath,
    input.artifactSha256,
    input.artifactSize,
    input.artifactMtime,
    input.checksumPath,
    input.checksumSha256,
    input.manifestPath,
    input.manifestSha256,
    input.verificationPath,
    input.verificationSha256,
  ];
  const identityIsNull = artifactIdentity.every((value) => value === null);
  const identityIsComplete = artifactIdentity.every((value) => value !== null);
  if (trackedArtifact) {
    if (!identityIsComplete) return fail('persisted staging artifact set identity is incomplete');
    artifactName = stagingFileName(persistedArtifactPath, jobId, 'persisted staging artifact path');
    checksumName = stagingFileName(input.checksumPath!, jobId, 'persisted checksum sidecar path', 'sha256sums');
    manifestName = stagingFileName(input.manifestPath!, jobId, 'persisted manifest sidecar path', 'build-manifest.json');
    verificationName = stagingFileName(input.verificationPath!, jobId, 'persisted verification sidecar path', 'verification.json');
    hash(input.artifactSha256, 'persisted staging artifact SHA-256');
    number(input.artifactSize, 'persisted staging artifact size');
    instant(input.artifactMtime, 'persisted staging artifact mtime');
    hash(input.checksumSha256, 'persisted checksum sidecar SHA-256');
    hash(input.manifestSha256, 'persisted manifest sidecar SHA-256');
    hash(input.verificationSha256, 'persisted verification sidecar SHA-256');
  } else if (expected.kind === 'absent') {
    if (identityIsNull) {
      if (input.publishState !== null) return fail('absent staging without intent must have a null publish state');
    } else {
      if (!identityIsComplete) return fail('absent staging requires a complete artifact preparation intent');
      if (input.publishState !== 'not_started') return fail('absent staging artifact preparation intent requires publish state not_started');
      stagingFileName(persistedArtifactPath!, jobId, 'persisted staging artifact path');
      stagingFileName(input.checksumPath!, jobId, 'persisted checksum sidecar path', 'sha256sums');
      stagingFileName(input.manifestPath!, jobId, 'persisted manifest sidecar path', 'build-manifest.json');
      stagingFileName(input.verificationPath!, jobId, 'persisted verification sidecar path', 'verification.json');
      hash(input.artifactSha256, 'persisted staging artifact SHA-256');
      number(input.artifactSize, 'persisted staging artifact size');
      instant(input.artifactMtime, 'persisted staging artifact mtime');
      hash(input.checksumSha256, 'persisted checksum sidecar SHA-256');
      hash(input.manifestSha256, 'persisted manifest sidecar SHA-256');
      hash(input.verificationSha256, 'persisted verification sidecar SHA-256');
    }
  } else if (!identityIsNull) {
    return fail('physical-present staging must have null artifact identity');
  }
  if (expected.kind === 'quarantined') {
    if (trackedArtifact && (expected.sha256 !== input.artifactSha256 || expected.size !== input.artifactSize)) return fail('cleanup quarantine evidence does not match the persisted artifact identity');
    if (!trackedArtifact && (expected.sha256 !== null || expected.size !== null)) return fail('physical-present quarantine evidence contains artifact identity');
  }
  try {
    return await withApprovedRootSnapshot(approvedRootRegistry, rootId, async ({ snapshot, dependencies }) => withDirectory(
      async () => {
        try {
          return await open(snapshot.path, DIRECTORY_FLAGS);
        } catch (error) {
          return fileSystemFailure('open', 'approved output root could not be opened no-follow', error);
        }
      },
      async (root) => {
        const rootStats = await descriptorStat(root, 'approved output root');
        assertApprovedRoot(rootStats, 'approved output root', ownerUid, snapshot.device, snapshot.inode);
        const builder = await openOptionalDirectoryChild(root, '.osi-image-builder', '.osi-image-builder');
        let stagingParent: FileHandle | null = null;
        let quarantineParent: FileHandle | null = null;
        let source: FileHandle | null = null;
        let destination: FileHandle | null = null;
        try {
          if (builder !== null) {
            assertPublisherDirectory(await descriptorStat(builder, '.osi-image-builder'), '.osi-image-builder', ownerUid, snapshot.device);
            stagingParent = await openOptionalDirectoryChild(builder, 'staging', '.osi-image-builder/staging');
            quarantineParent = await openOptionalDirectoryChild(builder, 'quarantine', '.osi-image-builder/quarantine');
            if (stagingParent !== null) {
              assertPublisherDirectory(await descriptorStat(stagingParent, '.osi-image-builder/staging'), '.osi-image-builder/staging', ownerUid, snapshot.device);
              source = await openOptionalDirectoryChild(stagingParent, jobId, `staging/${jobId}`);
            }
            if (quarantineParent !== null) {
              assertPublisherDirectory(await descriptorStat(quarantineParent, '.osi-image-builder/quarantine'), '.osi-image-builder/quarantine', ownerUid, snapshot.device);
              destination = await openOptionalDirectoryChild(quarantineParent, jobId, `quarantine/${jobId}`);
            }
            if (source !== null) assertJobDirectory(await descriptorStat(source, `staging/${jobId}`), `staging/${jobId}`, ownerUid, snapshot.device);
            if (destination !== null) assertJobDirectory(await descriptorStat(destination, `quarantine/${jobId}`), `quarantine/${jobId}`, ownerUid, snapshot.device);
          }
          if (expected.kind === 'absent') {
            if (source !== null || destination !== null) return fail('cleanup staging absence does not match physical source and destination state');
          } else if (source !== null || destination === null) {
            return fail('cleanup quarantine does not match physical source and destination state');
          }
          if (expected.kind === 'quarantined' && trackedArtifact) {
            const files = [
              { name: artifactName!, sha256: input.artifactSha256!, size: input.artifactSize!, maxBytes: null },
              { name: checksumName!, sha256: input.checksumSha256!, size: null, maxBytes: TEXT_LIMITS.maxChecksumBytes },
              { name: manifestName!, sha256: input.manifestSha256!, size: null, maxBytes: Math.min(JSON_LIMITS.maxEncodedBytes, TEXT_LIMITS.maxManifestBytes) },
              { name: verificationName!, sha256: input.verificationSha256!, size: null, maxBytes: Math.min(JSON_LIMITS.maxEncodedBytes, TEXT_LIMITS.maxManifestBytes) },
            ] as const;
            for (const tracked of files) {
              const field = `quarantine/${jobId}/${tracked.name}`;
              const file = await openFileChild(destination!, tracked.name, field);
              try {
                try {
                  await dependencies.beforeRead(file);
                } catch (error) {
                  fileSystemFailure('read', `cannot prepare recovery descriptor read: ${field}`, error);
                }
                if (tracked.size === null) {
                  await hashBoundedSidecar(file, tracked.sha256, tracked.maxBytes!, field, ownerUid, snapshot.device);
                } else {
                  await hashBoundedArtifact(file, tracked.size, tracked.sha256, input.artifactMtime!, field, ownerUid, snapshot.device);
                }
              } finally {
                await descriptorClose(file);
              }
            }
          }
          await revalidateManagedJob(root, builder, stagingParent, 'staging', jobId, null, ownerUid, snapshot.device);
          await revalidateManagedJob(root, builder, quarantineParent, 'quarantine', jobId, expected.kind === 'quarantined' ? destination : null, ownerUid, snapshot.device);
          await withApprovedRootSnapshot(approvedRootRegistry, rootId, async ({ snapshot: current }) => {
            if (
              current.id !== snapshot.id
              || current.path !== snapshot.path
              || current.quarantinePath !== snapshot.quarantinePath
              || current.device !== snapshot.device
              || current.inode !== snapshot.inode
            ) return fail('approved output root authority changed during staging verification');
          });
          return true as const;
        } finally {
          await closeHandles([source, destination, stagingParent, quarantineParent, builder]);
        }
      },
    ));
  } catch (error) {
    return authorityFailure('approved root authority verification failed', error);
  }
}

export function createRecoveryPhysicalVerification(options: RecoveryPhysicalVerificationOptions): RecoveryPhysicalVerification {
  const ownerUid = options.ownerUid ?? process.getuid?.() ?? 0;
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0) return fail('recovery owner UID is invalid');
  const maxEvidenceBytes = options.maxEvidenceBytes ?? MAX_EVIDENCE_BYTES;
  if (!Number.isSafeInteger(maxEvidenceBytes) || maxEvidenceBytes < 2 || maxEvidenceBytes > MAX_EVIDENCE_BYTES) return fail('recovery evidence read limit is invalid');
  return Object.freeze({
    evidence: Object.freeze({ read: (input: Readonly<{ jobId: string; admissionId: string; path: string; sha256: string }>) => readCompletionEvidence(options.stateRootAuthority, ownerUid, maxEvidenceBytes, input) }),
    staging: Object.freeze({ verify: (input: RecoveryStagingVerificationInput) => inspectStaging(options.approvedRootRegistry, ownerUid, input) }),
  });
}
