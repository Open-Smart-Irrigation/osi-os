import { createHash } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import { opendir, open, type FileHandle } from 'node:fs/promises';
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
  type RecoveryLogVerificationInput,
  type RecoveryLogVerifier,
  type RecoveryPresentStagingProof,
  type RecoveryStagingPostcondition,
  type RecoveryStagingVerificationInput,
  type RecoveryStagingVerifier,
} from './recovery.js';
import type { CleanupPostcondition } from './ownership.js';
import { JSON_LIMITS, TEXT_LIMITS, canonicalInstant, encodeJson, type JsonObject } from './validation.js';
import {
  DEPENDENCY_EGRESS_OPERATION_HOSTS,
  type DependencyEgressCleanupPostcondition,
  type DependencyEgressCredentialAbsenceProof,
  type DependencyEgressDockerAbsenceProof,
  type DependencyEgressPersistedDockerAbsenceProof,
} from '../../domain/dependency-egress-identity.js';
import { ACTIVE_RECOVERY_STATES, ADMISSION_ID_PATTERN, isDependencyEgressOperationId, type DependencyEgressOperationId } from '../../domain/types.js';

const DIRECTORY_MODE = 0o700;
const PUBLISHER_DIRECTORY_MODE = 0o750;
const EVIDENCE_MODE = 0o600;
const MAX_EVIDENCE_BYTES = JSON_LIMITS.maxEncodedBytes + 1;
const MAX_TOTAL_LOG_BYTES = 512 * 1024 * 1024;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH64 = /^[0-9a-f]{64}$/u;
const RUNNER_UNIT_PATTERN = /^osi-image-builder-runner@[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.service$/u;
const PROC_FD = '/proc/self/fd';
const O_CLOEXEC = (fsConstants as typeof fsConstants & { readonly O_CLOEXEC?: number }).O_CLOEXEC ?? 0x80000;
const O_PATH = (fsConstants as typeof fsConstants & { readonly O_PATH?: number }).O_PATH ?? 0x200000;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | O_CLOEXEC;
const FILE_INSPECTION_FLAGS = O_PATH | fsConstants.O_NOFOLLOW | O_CLOEXEC;
const FILE_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | O_CLOEXEC;
const FATAL_DECODER = new TextDecoder('utf-8', { fatal: true });
const BOUNDARY_OPEN_ERROR_CODES = new Set([
  'EACCES',
  'EISDIR',
  'ELOOP',
  'ENOENT',
  'ENOTDIR',
  'EPERM',
]);
const MAX_LOG_TREE_ENTRIES = 8_192;
const MAX_LOG_TREE_DEPTH = 16;
const MAX_LOG_PATH_BYTES = 4_096;
const MAX_LOG_COMPONENT_BYTES = 255;
const MAX_LOG_COMPONENTS = MAX_LOG_TREE_DEPTH;
const MAX_LOG_DESCRIPTORS = 1_024;
const MAX_LOG_FILE_OPEN_DESCRIPTORS = 2;
const MAX_LOG_FINAL_CHAIN_DESCRIPTORS = 3;
// Reserve both descriptor classes retained at each recursive level, the final
// canonical chain, and the O_PATH/read pair used while opening a log file.
const MAX_LOG_REVALIDATION_TEMP_DESCRIPTORS = (MAX_LOG_TREE_DEPTH * 2) + MAX_LOG_FINAL_CHAIN_DESCRIPTORS + MAX_LOG_FILE_OPEN_DESCRIPTORS;

export interface RecoveryPhysicalVerificationOptions {
  readonly stateRootAuthority: StateRootAuthority;
  readonly approvedRootRegistry: ApprovedRootRegistry;
  readonly ownerUid?: number;
  readonly maxEvidenceBytes?: number;
}

export interface RecoveryPhysicalVerification {
  readonly evidence: RecoveryCleanupEvidenceReader;
  readonly staging: RecoveryStagingVerifier;
  readonly logs: RecoveryLogVerifier;
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
    || stats.nlink < 1
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
    || stats.nlink < 1
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
    || stats.nlink < 1
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
    || stats.nlink < 1
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

function assertRegularCandidate(stats: NativeStats, field: string): void {
  if (stats.isSymbolicLink() || !stats.isFile()) return fail(`recovery candidate is not a regular file: ${field}`);
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

async function openFileChild(
  parent: FileHandle,
  name: string,
  field: string,
  ownerUid?: number,
  device?: number,
  assertion?: (stats: NativeStats, field: string, owner: number, dev: number) => void,
): Promise<FileHandle> {
  let inspected: FileHandle | null = null;
  let readable: FileHandle | null = null;
  try {
    if (process.platform !== 'linux') return fail('descriptor recovery verification requires Linux no-follow semantics');
    inspected = await open(childPath(parent, name, field), FILE_INSPECTION_FLAGS);
    const inspectedStats = await descriptorStat(inspected, `${field} inspection`);
    assertRegularCandidate(inspectedStats, field);
    if (assertion !== undefined && ownerUid !== undefined && device !== undefined) assertion(inspectedStats, field, ownerUid, device);
    readable = await open(join(PROC_FD, String(inspected.fd)), FILE_READ_FLAGS);
    const readableStats = await descriptorStat(readable, `${field} readable descriptor`);
    assertRegularCandidate(readableStats, field);
    if (!stableStats(inspectedStats, readableStats)) return fail(`recovery candidate identity changed while opening: ${field}`);
    if (assertion !== undefined && ownerUid !== undefined && device !== undefined) assertion(readableStats, field, ownerUid, device);
    const result = readable;
    readable = null;
    return result;
  } catch (error) {
    return fileSystemFailure('open', `cannot open recovery evidence: ${field}`, error);
  } finally {
    if (readable !== null) await closeHandles([readable]);
    if (inspected !== null) await closeHandles([inspected]);
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

interface HeldDescriptor {
  readonly path: string;
  readonly parts: readonly string[];
  readonly handle: FileHandle;
  readonly stats: NativeStats;
  readonly kind: 'directory' | 'file';
  readonly directoryMode?: 0o700 | 0o750;
}

async function revalidateHeldChain(
  root: FileHandle,
  rootStats: NativeStats,
  descriptors: ReadonlyMap<string, HeldDescriptor>,
  leaf: HeldDescriptor,
  ownerUid: number,
  device: number,
  fileAssertion: (stats: NativeStats, field: string, owner: number, dev: number) => void,
  baseDescriptors = 0,
): Promise<void> {
  const currentRoot = await descriptorStat(root, `${leaf.path} root`);
  if (!stableStats(rootStats, currentRoot)) return fail(`recovery root identity changed while verifying ${leaf.path}`);
  let current = root;
  const opened: FileHandle[] = [];
  let path = '';
  try {
    for (let index = 0; index < leaf.parts.length; index += 1) {
      path = path.length === 0 ? leaf.parts[index]! : `${path}/${leaf.parts[index]!}`;
      const expected = descriptors.get(path);
      if (expected === undefined) return fail(`recovery descriptor chain is incomplete for ${leaf.path}`);
      const name = leaf.parts[index]!;
      if (baseDescriptors + opened.length + 2 > MAX_LOG_DESCRIPTORS) return fail('recovery descriptor revalidation exceeds its bounded limit');
      const child = expected.kind === 'directory'
        ? await openDirectoryChild(current, name, path)
        : await openFileChild(current, name, path, ownerUid, device, fileAssertion);
      opened.push(child);
      const stats = await descriptorStat(child, path);
      if (expected.kind === 'directory') {
        if (expected.directoryMode === PUBLISHER_DIRECTORY_MODE) assertPublisherDirectory(stats, path, ownerUid, device);
        else assertDirectory(stats, path, ownerUid, device);
      }
      else fileAssertion(stats, path, ownerUid, device);
      if (!stableStats(expected.stats, stats)) return fail(`recovery descriptor identity changed for ${path}`);
      current = child;
    }
  } finally {
    await closeHandles(opened);
  }
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

function validateStaging(value: unknown, jobId: string, field: string): RecoveryStagingPostcondition {
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
  if (initial.kind === 'present') {
    const staging = exactKeys(initial, ['kind', 'sourcePath', 'sourcePresent', 'destinationPath', 'destinationAbsent', 'sha256', 'size', 'verifiedAt'], field);
    const destinationPath = `quarantine/${jobId}`;
    if (staging.sourcePath !== sourcePath || staging.destinationPath !== destinationPath) return fail(`${field} present path is invalid`);
    boolean(staging.sourcePresent, true, `${field}.sourcePresent`);
    boolean(staging.destinationAbsent, true, `${field}.destinationAbsent`);
    return {
      kind: 'present',
      sourcePath,
      sourcePresent: true,
      destinationPath,
      destinationAbsent: true,
      sha256: hash(staging.sha256, `${field}.sha256`),
      size: number(staging.size, `${field}.size`),
      verifiedAt: instant(staging.verifiedAt, `${field}.verifiedAt`),
    };
  }
  return fail(`${field}.kind is invalid`);
}

function egressOperation(value: unknown, field: string): DependencyEgressOperationId {
  if (typeof value !== 'string' || !isDependencyEgressOperationId(value) || !Object.hasOwn(DEPENDENCY_EGRESS_OPERATION_HOSTS, value)) return fail(`${field} is invalid`);
  return value;
}

function egressAttempt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return fail(`${field} is invalid`);
  return value;
}

function egressExpectedPaths(stateRoot: string, jobId: string, operationId: DependencyEgressOperationId, attempt: number): Readonly<{ readonly credentialHostPath: string; readonly tlsHostDirectory: string }> {
  const base = join(stateRoot, 'jobs', jobId, 'recovery', 'dependency-egress');
  return Object.freeze({
    credentialHostPath: join(base, `${operationId}-${String(attempt)}.proxy-credential`),
    tlsHostDirectory: join(base, `${operationId}-${String(attempt)}.proxy-tls`),
  });
}

function validateEgressCredential(value: unknown, field: string, stateRoot: string, jobId: string): DependencyEgressCredentialAbsenceProof {
  const credential = exactKeys(value, ['kind', 'operationId', 'attempt', 'hostPath', 'expectedSha256', 'observedSha256', 'tls', 'absent'], field);
  if (credential.kind !== 'normal' && credential.kind !== 'credential-only' && credential.kind !== 'tls-only') return fail(`${field}.kind is invalid`);
  const operationId = egressOperation(credential.operationId, `${field}.operationId`);
  const attempt = egressAttempt(credential.attempt, `${field}.attempt`);
  const expected = egressExpectedPaths(stateRoot, jobId, operationId, attempt);
  const hostPath = text(credential.hostPath, `${field}.hostPath`, TEXT_LIMITS.maxPathBytes);
  if (hostPath !== expected.credentialHostPath) return fail(`${field}.hostPath is outside the configured state root`);
  const tls = exactKeys(credential.tls, ['hostDirectory', 'absent'], `${field}.tls`);
  if (tls.hostDirectory !== expected.tlsHostDirectory) return fail(`${field}.tls.hostDirectory is outside the configured state root`);
  boolean(tls.absent, true, `${field}.tls.absent`);
  boolean(credential.absent, true, `${field}.absent`);
  const expectedSha256 = credential.expectedSha256 === null ? null : hash(credential.expectedSha256, `${field}.expectedSha256`);
  const observedSha256 = credential.observedSha256 === null ? null : hash(credential.observedSha256, `${field}.observedSha256`);
  if (credential.kind === 'tls-only') {
    if (observedSha256 !== null) return fail(`${field}.observedSha256 must be null for a TLS-only remnant`);
    return { kind: 'tls-only', operationId, attempt, hostPath, expectedSha256, observedSha256: null, tls: { hostDirectory: expected.tlsHostDirectory, absent: true }, absent: true };
  }
  if (expectedSha256 === null) return fail(`${field}.expectedSha256 is required for a credential remnant`);
  if (observedSha256 !== null && observedSha256 !== expectedSha256) return fail(`${field}.observedSha256 does not match expectedSha256`);
  if (credential.kind === 'normal' && observedSha256 === null) return fail(`${field}.normal proof must include an observed credential hash`);
  return { kind: credential.kind, operationId, attempt, hostPath, expectedSha256, observedSha256, tls: { hostDirectory: expected.tlsHostDirectory, absent: true }, absent: true };
}

function validateEgressDockerAbsence(
  value: unknown,
  field: string,
  stateRoot: string,
  jobId: string,
  nullableProxy: boolean,
  globalAttestation: boolean,
): DependencyEgressDockerAbsenceProof | DependencyEgressPersistedDockerAbsenceProof {
  const proof = exactKeys(value, globalAttestation
    ? ['operationId', 'attempt', 'proxy', 'network', 'tls', 'credential', 'globalLabelResult']
    : ['operationId', 'attempt', 'proxy', 'network', 'tls', 'credential'], field);
  const operationId = egressOperation(proof.operationId, `${field}.operationId`);
  const attempt = egressAttempt(proof.attempt, `${field}.attempt`);
  const expected = egressExpectedPaths(stateRoot, jobId, operationId, attempt);
  let proxy: Readonly<{ readonly id: string; readonly absent: true }> | null = null;
  if (proof.proxy === null) {
    if (!nullableProxy) return fail(`${field}.proxy is required`);
  } else {
    const valueProxy = exactKeys(proof.proxy, ['id', 'absent'], `${field}.proxy`);
    const id = hash(valueProxy.id, `${field}.proxy.id`);
    boolean(valueProxy.absent, true, `${field}.proxy.absent`);
    proxy = { id, absent: true };
  }
  const network = exactKeys(proof.network, ['id', 'absent'], `${field}.network`);
  const networkId = hash(network.id, `${field}.network.id`);
  boolean(network.absent, true, `${field}.network.absent`);
  const tls = exactKeys(proof.tls, ['hostDirectory', 'absent'], `${field}.tls`);
  if (tls.hostDirectory !== expected.tlsHostDirectory) return fail(`${field}.tls.hostDirectory is outside the configured state root`);
  boolean(tls.absent, true, `${field}.tls.absent`);
  const credential = exactKeys(proof.credential, ['hostPath', 'sha256'], `${field}.credential`);
  if (credential.hostPath !== expected.credentialHostPath) return fail(`${field}.credential.hostPath is outside the configured state root`);
  const credentialSha256 = hash(credential.sha256, `${field}.credential.sha256`);
  if (globalAttestation && proof.globalLabelResult !== 'no-match') return fail(`${field}.globalLabelResult is invalid`);
  const common = {
    operationId,
    attempt,
    proxy,
    network: { id: networkId, absent: true as const },
    tls: { hostDirectory: expected.tlsHostDirectory, absent: true as const },
    credential: { hostPath: expected.credentialHostPath, sha256: credentialSha256 },
  };
  return globalAttestation
    ? { ...common, proxy: proxy!, globalLabelResult: 'no-match' as const }
    : common;
}

function validateEgress(value: unknown, field: string, stateRoot: string, jobId: string): DependencyEgressCleanupPostcondition {
  const egress = exactKeys(value, ['persistedDocker', 'discoveredDocker', 'credentials', 'globalLabelResult'], field);
  if (egress.globalLabelResult !== 'no-match') return fail(`${field}.globalLabelResult is invalid`);
  const persistedDocker = egress.persistedDocker === null
    ? null
    : validateEgressDockerAbsence(egress.persistedDocker, `${field}.persistedDocker`, stateRoot, jobId, false, true) as DependencyEgressPersistedDockerAbsenceProof;
  if (!Array.isArray(egress.discoveredDocker) || egress.discoveredDocker.length > 128) return fail(`${field}.discoveredDocker is invalid`);
  const discoveredDocker = egress.discoveredDocker.map((proof, index) => validateEgressDockerAbsence(proof, `${field}.discoveredDocker[${index}]`, stateRoot, jobId, true, false) as DependencyEgressDockerAbsenceProof);
  if (!Array.isArray(egress.credentials) || egress.credentials.length > 128) return fail(`${field}.credentials is invalid`);
  const credentials = egress.credentials.map((credential, index) => validateEgressCredential(credential, `${field}.credentials[${index}]`, stateRoot, jobId));
  const credentialByOperation = new Map<string, DependencyEgressCredentialAbsenceProof>();
  for (const credential of credentials) {
    const key = `${credential.operationId}:${String(credential.attempt)}`;
    if (credentialByOperation.has(key)) return fail(`${field}.credentials contains a duplicate operation proof`);
    credentialByOperation.set(key, credential);
  }
  const dockerKeys = new Set<string>();
  const proxyIds = new Set<string>();
  const networkIds = new Set<string>();
  const allDocker = persistedDocker === null ? discoveredDocker : [persistedDocker, ...discoveredDocker];
  for (const [index, proof] of allDocker.entries()) {
    const key = `${proof.operationId}:${String(proof.attempt)}`;
    if (dockerKeys.has(key)) return fail(`${field} contains duplicate Docker absence evidence`);
    dockerKeys.add(key);
    if (networkIds.has(proof.network.id)) return fail(`${field} contains duplicate network absence evidence`);
    networkIds.add(proof.network.id);
    if (proof.proxy !== null) {
      if (proxyIds.has(proof.proxy.id)) return fail(`${field} contains duplicate proxy absence evidence`);
      proxyIds.add(proof.proxy.id);
    }
    const credential = credentialByOperation.get(key);
    if (credential === undefined || credential.expectedSha256 === null || credential.hostPath !== proof.credential.hostPath || credential.expectedSha256 !== proof.credential.sha256) return fail(`${field} Docker absence evidence has no matching credential absence`);
    if (index === 0 && persistedDocker !== null && proof.proxy === null) return fail(`${field}.persistedDocker.proxy is required`);
  }
  return {
    persistedDocker,
    discoveredDocker,
    credentials,
    globalLabelResult: 'no-match',
  };
}

function validatePostcondition(value: unknown, jobId: string, stateRoot: string, field: string): CleanupPostcondition {
  const postcondition = exactKeys(value, ['runner', 'state', 'container', 'staging', 'logs', 'egress', 'blocker'], field);
  const state = postcondition.state;
  const states = [...ACTIVE_RECOVERY_STATES, 'interrupted'] as readonly string[];
  if (typeof state !== 'string' || !states.includes(state)) return fail(`${field}.state is invalid`);
  const logs = exactKeys(postcondition.logs, ['runner', 'docker', 'verifiedAt'], `${field}.logs`);
  if (!['absent', 'sealed'].includes(String(logs.runner)) || !['absent', 'sealed'].includes(String(logs.docker))) return fail(`${field}.logs state is invalid`);
  if (postcondition.blocker !== 'none') return fail(`${field}.blocker is invalid`);
  const staging = validateStaging(postcondition.staging, jobId, `${field}.staging`);
  if (staging.kind === 'present') return fail(`${field}.staging cannot retain a present source`);
  return {
    runner: validateRunner(postcondition.runner, `${field}.runner`),
    state: state as CleanupPostcondition['state'],
    container: validateContainer(postcondition.container, `${field}.container`),
    staging,
    logs: { runner: logs.runner as 'absent' | 'sealed', docker: logs.docker as 'absent' | 'sealed', verifiedAt: instant(logs.verifiedAt, `${field}.logs.verifiedAt`) },
    egress: validateEgress(postcondition.egress, `${field}.egress`, stateRoot, jobId),
    blocker: 'none',
  };
}

function parseCompletion(bytes: Buffer, jobId: string, admissionId: string, stateRoot: string, maxBytes: number): CleanupPostcondition {
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
  return validatePostcondition(envelope.postcondition, jobId, stateRoot, 'cleanup completion evidence.postcondition');
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
    return await withStateRootSnapshot(stateRootAuthority, async ({ snapshot, dependencies }) => {
      const evidence = await withDirectory(
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
        const held = new Map<string, HeldDescriptor>();
        return withDirectory(
          () => openDirectoryChild(root, 'jobs', 'jobs'),
          async (jobs) => {
            const jobsStats = await descriptorStat(jobs, 'jobs');
            assertDirectory(jobsStats, 'jobs', ownerUid, snapshot.device);
            held.set('jobs', { path: 'jobs', parts: ['jobs'], handle: jobs, stats: jobsStats, kind: 'directory' });
            return withDirectory(
              () => openDirectoryChild(jobs, jobId, `jobs/${jobId}`),
              async (job) => {
                const jobPath = `jobs/${jobId}`;
                const jobStats = await descriptorStat(job, jobPath);
                assertDirectory(jobStats, jobPath, ownerUid, snapshot.device);
                held.set(jobPath, { path: jobPath, parts: ['jobs', jobId], handle: job, stats: jobStats, kind: 'directory' });
                return withDirectory(
                  () => openDirectoryChild(job, 'evidence', `jobs/${jobId}/evidence`),
                  async (evidence) => {
                    const evidencePath = `jobs/${jobId}/evidence`;
                    const evidenceStats = await descriptorStat(evidence, evidencePath);
                    assertDirectory(evidenceStats, evidencePath, ownerUid, snapshot.device);
                    held.set(evidencePath, { path: evidencePath, parts: ['jobs', jobId, 'evidence'], handle: evidence, stats: evidenceStats, kind: 'directory' });
                    return withDirectory(
                      () => openDirectoryChild(evidence, 'cleanup', `jobs/${jobId}/evidence/cleanup`),
                      async (cleanup) => {
                        const cleanupPath = `jobs/${jobId}/evidence/cleanup`;
                        const cleanupStats = await descriptorStat(cleanup, cleanupPath);
                        assertDirectory(cleanupStats, cleanupPath, ownerUid, snapshot.device);
                        held.set(cleanupPath, { path: cleanupPath, parts: ['jobs', jobId, 'evidence', 'cleanup'], handle: cleanup, stats: cleanupStats, kind: 'directory' });
                        const fileName = `${admissionId}.complete.json`;
                        return withDirectory(
                          () => openFileChild(cleanup, fileName, expectedPath, ownerUid, snapshot.device, assertRegularEvidence),
                          async (file) => {
                            const fileStats = await descriptorStat(file, expectedPath);
                            assertRegularEvidence(fileStats, expectedPath, ownerUid, snapshot.device);
                            try {
                              await dependencies.beforeRead(file);
                            } catch (error) {
                              fileSystemFailure('read', `cannot prepare recovery descriptor read: ${expectedPath}`, error);
                            }
                            const bytes = await readBoundedFile(file, maxBytes, expectedPath, ownerUid, snapshot.device);
                            const actualSha256 = createHash('sha256').update(bytes).digest('hex');
                            if (actualSha256 !== expectedSha256) return fail('cleanup completion evidence hash does not match the durable hash');
                            const heldFile: HeldDescriptor = { path: expectedPath, parts: expectedPath.split('/'), handle: file, stats: fileStats, kind: 'file' };
                            held.set(expectedPath, heldFile);
                            await revalidateHeldChain(root, rootStats, held, heldFile, ownerUid, snapshot.device, assertRegularEvidence);
                            return {
                              jobId,
                              admissionId,
                              sha256: actualSha256,
                              postcondition: parseCompletion(bytes, jobId, admissionId, snapshot.path, maxBytes),
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
      );
      await withStateRootSnapshot(stateRootAuthority, async ({ snapshot: current }) => {
        if (current.path !== snapshot.path || current.device !== snapshot.device || current.inode !== snapshot.inode) return fail('state root authority changed after completion evidence read');
        return undefined;
      });
      return evidence;
    });
  } catch (error) {
    return authorityFailure('state root authority verification failed', error);
  }
}

function assertLogFile(stats: NativeStats, field: string, ownerUid: number, device: number): void {
  if (
    stats.isSymbolicLink()
    || !stats.isFile()
    || stats.uid !== ownerUid
    || modeOf(stats) !== EVIDENCE_MODE
    || stats.nlink !== 1
    || stats.dev !== device
  ) return fail(`unsafe recovery log file: ${field}`);
}

function safeLogPath(value: string, jobId: string): readonly string[] {
  const prefix = 'logs/';
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_LOG_PATH_BYTES || !value.startsWith(prefix) || value.includes('\\')) return fail(`cleanup log path is invalid for ${jobId}`);
  const parts: string[] = [];
  let start = prefix.length;
  for (let index = prefix.length; index <= value.length; index += 1) {
    if (index !== value.length && value[index] !== '/') continue;
    const part = value.slice(start, index);
    if (part.length === 0 || part === '.' || part === '..' || Buffer.byteLength(part, 'utf8') > MAX_LOG_COMPONENT_BYTES) return fail(`cleanup log path is invalid for ${jobId}`);
    parts.push(part);
    if (parts.length > MAX_LOG_COMPONENTS) return fail(`cleanup log path exceeds its depth bound for ${jobId}`);
    start = index + 1;
  }
  return parts;
}

interface HashedRecoveryLog {
  readonly stats: NativeStats;
  readonly sha256: string;
}

async function hashLogFile(handle: FileHandle, field: string, ownerUid: number, device: number): Promise<HashedRecoveryLog> {
  const before = await descriptorStat(handle, field);
  assertLogFile(before, field, ownerUid, device);
  if (!Number.isSafeInteger(before.size) || before.size > 256 * 1024 * 1024) return fail(`${field} exceeds the bounded log size`);
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < before.size) {
    const result = await descriptorRead(handle, buffer, 0, Math.min(buffer.length, before.size - position), position, field);
    if (result.bytesRead <= 0) return fail(`${field} changed during physical log hashing`);
    digest.update(result.buffer.subarray(0, result.bytesRead));
    position += result.bytesRead;
  }
  const after = await descriptorStat(handle, field);
  assertLogFile(after, field, ownerUid, device);
  if (!stableStats(before, after) || position !== before.size) return fail(`${field} changed during physical log hashing`);
  return { stats: after, sha256: digest.digest('hex') };
}

async function verifyPhysicalLogs(
  stateRootAuthority: StateRootAuthority,
  ownerUid: number,
  input: RecoveryLogVerificationInput,
): Promise<true> {
  const jobId = safeJobId(input.jobId);
  const completedAt = instant(input.completedAt, 'cleanup log completion time');
  if (!Number.isSafeInteger(input.completionEventSeq) || input.completionEventSeq < 0) return fail('cleanup log completion event sequence is invalid');
  if (input.generations.length > 128) return fail('cleanup physical log generations exceed the bounded recovery limit');
  const seenPaths = new Set<string>();
  const streamCounts = { runner: 0, docker: 0 };
  for (const row of input.generations) {
    if (row.stream !== 'runner' && row.stream !== 'docker') return fail('cleanup physical log stream is invalid');
    if (!Number.isSafeInteger(row.generation) || row.generation !== streamCounts[row.stream]) return fail('cleanup physical log generations are not contiguous');
    streamCounts[row.stream] += 1;
    safeLogPath(row.path, jobId);
    if (seenPaths.has(row.path)) return fail('cleanup physical log paths are ambiguous');
    seenPaths.add(row.path);
    if (!Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 0 || row.sizeBytes > 256 * 1024 * 1024 || !HASH64.test(row.sha256)) return fail('cleanup physical log identity is invalid');
    const startedAt = instant(row.startedAt, 'cleanup physical log start time');
    const sealedAt = instant(row.sealedAt, 'cleanup physical log seal time');
    if (sealedAt < startedAt || sealedAt > completedAt) return fail('cleanup physical log chronology is invalid');
  }
  for (const stream of ['runner', 'docker'] as const) {
    const count = streamCounts[stream];
    if (input.postcondition[stream] === 'absent' && count !== 0 || input.postcondition[stream] === 'sealed' && count === 0) return fail(`${stream} physical log state does not match cleanup evidence`);
  }

  const rows = new Map<string, RecoveryLogVerificationInput['generations'][number]>();
  const allowedDirectories = new Set<string>(['logs']);
  for (const row of input.generations) {
    const path = row.path;
    rows.set(path, row);
    const parts = safeLogPath(path, jobId);
    let prefix = 'logs';
    for (let index = 0; index < parts.length - 1; index += 1) {
      prefix += `/${parts[index]}`;
      allowedDirectories.add(prefix);
    }
  }
  if (3 + allowedDirectories.size + rows.size + MAX_LOG_REVALIDATION_TEMP_DESCRIPTORS > MAX_LOG_DESCRIPTORS) return fail('cleanup physical log descriptor plan exceeds its bounded limit');

  let activeLogEnumerationDescriptors = 0;
  let activeLogTraversalDescriptors = 0;
  async function forEachEntry(directory: FileHandle, field: string, visit: (entry: import('node:fs').Dirent) => Promise<void>): Promise<void> {
    let stream: import('node:fs').Dir;
    try {
      stream = await opendir(join(PROC_FD, String(directory.fd)));
    } catch (error) {
      return fileSystemFailure('read', `cannot enumerate recovery log tree: ${field}`, error);
    }
    activeLogEnumerationDescriptors += 1;
    try {
      for await (const entry of stream) await visit(entry);
    } catch (error) {
      return fileSystemFailure('read', `cannot enumerate recovery log tree: ${field}`, error);
    } finally {
      activeLogEnumerationDescriptors -= 1;
      await stream.close().catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') fileSystemFailure('close', `cannot close recovery log tree: ${field}`, error);
      });
    }
  }

  try {
    return await withStateRootSnapshot(stateRootAuthority, async ({ snapshot, dependencies }) => {
      const handles: FileHandle[] = [];
      const held = new Map<string, HeldDescriptor>();
      let totalBytes = 0;
      let extraHeldDescriptors = 0;
      try {
        let root: FileHandle;
        try {
          root = await open(snapshot.path, DIRECTORY_FLAGS);
        } catch (error) {
          return fileSystemFailure('open', 'state root could not be opened no-follow for cleanup logs', error);
        }
        handles.push(root);
        const rootStats = await descriptorStat(root, 'state root for cleanup logs');
        assertDirectory(rootStats, 'state root for cleanup logs', ownerUid, snapshot.device);
        if (rootStats.ino !== snapshot.inode) return fail('state root identity changed while opening cleanup logs');
        const jobs = await openDirectoryChild(root, 'jobs', 'jobs for cleanup logs'); handles.push(jobs);
        const jobsStats = await descriptorStat(jobs, 'jobs for cleanup logs');
        assertDirectory(jobsStats, 'jobs for cleanup logs', ownerUid, snapshot.device);
        held.set('jobs', { path: 'jobs', parts: ['jobs'], handle: jobs, stats: jobsStats, kind: 'directory' });
        const job = await openDirectoryChild(jobs, jobId, `jobs/${jobId} for cleanup logs`); handles.push(job);
        const jobPath = `jobs/${jobId}`;
        const jobStats = await descriptorStat(job, jobPath);
        assertDirectory(jobStats, jobPath, ownerUid, snapshot.device);
        held.set(jobPath, { path: jobPath, parts: ['jobs', jobId], handle: job, stats: jobStats, kind: 'directory' });
        const logs = await openOptionalDirectoryChild(job, 'logs', `jobs/${jobId}/logs`);
        if (logs !== null) {
          handles.push(logs);
          const logsStats = await descriptorStat(logs, `jobs/${jobId}/logs`);
          assertDirectory(logsStats, `jobs/${jobId}/logs`, ownerUid, snapshot.device);
          held.set('logs', { path: 'logs', parts: ['jobs', jobId, 'logs'], handle: logs, stats: logsStats, kind: 'directory' });
        }
        if (input.generations.length > 0 && logs === null) return fail('cleanup physical log directory is missing');
        if (logs !== null) {
          let treeEntries = 0;
          async function walk(directory: FileHandle, prefix: string, depth: number, revalidate: boolean): Promise<void> {
            if (depth > MAX_LOG_TREE_DEPTH) return fail('cleanup physical log tree exceeds its depth bound');
            await forEachEntry(directory, prefix, async (entry) => {
              const path = `${prefix}/${entry.name}`;
              const row = rows.get(path);
              const isDirectory = allowedDirectories.has(path);
              treeEntries += 1;
              if (treeEntries > MAX_LOG_TREE_ENTRIES) return fail('cleanup physical log tree exceeds its entry bound');
              if (entry.isSymbolicLink()) return fail(`cleanup physical log tree contains a symlink: ${path}`);
              if (!isDirectory && row === undefined) return fail(`cleanup physical log tree contains an unindexed entry: ${path}`);
              const openingDescriptors = isDirectory ? 1 : MAX_LOG_FILE_OPEN_DESCRIPTORS;
              if (handles.length + extraHeldDescriptors + activeLogEnumerationDescriptors + activeLogTraversalDescriptors + openingDescriptors > MAX_LOG_DESCRIPTORS) return fail('cleanup physical log descriptor count exceeds its bounded limit');
              const child = isDirectory
                ? await openDirectoryChild(directory, entry.name, path)
                : await openFileChild(directory, entry.name, path, ownerUid, snapshot.device, assertLogFile);
              if (revalidate) activeLogTraversalDescriptors += 1;
              else handles.push(child);
              try {
                const stats = await descriptorStat(child, path);
                if (isDirectory) {
                  assertDirectory(stats, path, ownerUid, snapshot.device);
                  if (revalidate) {
                    const previous = held.get(path);
                    if (previous === undefined || !stableStats(previous.stats, stats)) return fail(`cleanup physical log directory identity changed: ${path}`);
                  } else {
                    held.set(path, { path, parts: ['jobs', jobId, ...path.split('/')], handle: child, stats, kind: 'directory' });
                  }
                  await walk(child, path, depth + 1, revalidate);
                } else {
                  if (row === undefined) return fail(`cleanup physical log entry is not indexed: ${path}`);
                  assertLogFile(stats, path, ownerUid, snapshot.device);
                  if (revalidate) {
                    const previous = held.get(path);
                    if (previous === undefined || !stableStats(previous.stats, stats)) return fail(`cleanup physical log file identity changed: ${path}`);
                    const physical = await hashLogFile(child, path, ownerUid, snapshot.device);
                    if (physical.stats.size !== row.sizeBytes || physical.sha256 !== row.sha256) return fail(`cleanup physical log identity does not match ${path}`);
                  } else {
                    try {
                      await dependencies.beforeRead(child);
                    } catch (error) {
                      fileSystemFailure('read', `cannot prepare cleanup log descriptor read: ${path}`, error);
                    }
                    const physical = await hashLogFile(child, path, ownerUid, snapshot.device);
                    if (physical.stats.size !== row.sizeBytes || physical.sha256 !== row.sha256) return fail(`cleanup physical log identity does not match ${path}`);
                    totalBytes += physical.stats.size;
                    if (totalBytes > MAX_TOTAL_LOG_BYTES) return fail('cleanup physical logs exceed the bounded total size');
                    held.set(path, { path, parts: ['jobs', jobId, 'logs', ...path.slice('logs/'.length).split('/')], handle: child, stats, kind: 'file' });
                  }
                }
              } finally {
                if (revalidate) {
                  try { await closeHandles([child]); }
                  finally { activeLogTraversalDescriptors -= 1; }
                }
              }
            });
          }
          await walk(logs, 'logs', 0, false);
          const fileCount = [...held.values()].filter((descriptor) => descriptor.kind === 'file').length;
          if (fileCount !== rows.size) return fail('cleanup physical log tree does not contain every indexed generation');
          treeEntries = 0;
          await walk(logs, 'logs', 0, true);
          const chain = new Map<string, HeldDescriptor>([
            ['jobs', held.get('jobs')!],
            [jobPath, held.get(jobPath)!],
          ]);
          for (const descriptor of held.values()) chain.set(descriptor.parts.join('/'), descriptor);
          async function revalidateAll(baseDescriptors: number): Promise<void> {
            const verified = new Set<HeldDescriptor>();
            for (const descriptor of held.values()) {
              if (verified.has(descriptor)) continue;
              verified.add(descriptor);
              await revalidateHeldChain(root, rootStats, chain, descriptor, ownerUid, snapshot.device, assertLogFile, baseDescriptors);
            }
          }
          await revalidateAll(handles.length);
          try {
            await dependencies.beforeRead(root);
          } catch (error) {
            fileSystemFailure('read', 'cannot prepare final cleanup log chain read', error);
          }
          const finalHandles: FileHandle[] = [];
          let finalLogs: FileHandle | null = null;
          try {
            const finalJobs = await openDirectoryChild(root, 'jobs', 'jobs for final cleanup logs');
            finalHandles.push(finalJobs);
            const expectedJobs = held.get('jobs');
            const finalJobsStats = await descriptorStat(finalJobs, 'jobs for final cleanup logs');
            assertDirectory(finalJobsStats, 'jobs for final cleanup logs', ownerUid, snapshot.device);
            if (expectedJobs === undefined || !stableStats(expectedJobs.stats, finalJobsStats)) return fail('cleanup physical log jobs directory identity changed before final enumeration');
            const finalJob = await openDirectoryChild(finalJobs, jobId, `jobs/${jobId} for final cleanup logs`);
            finalHandles.push(finalJob);
            const expectedJob = held.get(jobPath);
            const finalJobStats = await descriptorStat(finalJob, `jobs/${jobId} for final cleanup logs`);
            assertDirectory(finalJobStats, jobPath, ownerUid, snapshot.device);
            if (expectedJob === undefined || !stableStats(expectedJob.stats, finalJobStats)) return fail('cleanup physical log job directory identity changed before final enumeration');
            finalLogs = await openDirectoryChild(finalJob, 'logs', `jobs/${jobId}/logs for final cleanup logs`);
            finalHandles.push(finalLogs);
            const expectedLogs = held.get('logs');
            const finalLogsStats = await descriptorStat(finalLogs, `jobs/${jobId}/logs for final cleanup logs`);
            assertDirectory(finalLogsStats, `jobs/${jobId}/logs`, ownerUid, snapshot.device);
            if (expectedLogs === undefined || !stableStats(expectedLogs.stats, finalLogsStats)) return fail('cleanup physical log root identity changed before final enumeration');
            extraHeldDescriptors = finalHandles.length;
            treeEntries = 0;
            await walk(finalLogs, 'logs', 0, true);
            await revalidateAll(handles.length + finalHandles.length);
          } finally {
            extraHeldDescriptors = 0;
            await closeHandles(finalHandles);
          }
        }
        await withStateRootSnapshot(stateRootAuthority, async ({ snapshot: current }) => {
          if (current.path !== snapshot.path || current.device !== snapshot.device || current.inode !== snapshot.inode) return fail('state root authority changed after cleanup log verification');
          return undefined;
        });
        return true as const;
      } finally {
        await closeHandles(handles);
      }
    });
  } catch (error) {
    return authorityFailure('state root authority verification failed', error);
  }
}

async function inspectStaging(
  approvedRootRegistry: ApprovedRootRegistry,
  ownerUid: number,
  input: RecoveryStagingVerificationInput,
): Promise<true | RecoveryPresentStagingProof> {
  const jobId = safeJobId(input.jobId);
  safeAdmissionId(input.admissionId);
  const rootId = safeSegment(input.rootId, 'approved root ID');
  const expected = validateStaging(input.postcondition, jobId, 'cleanup staging postcondition');
  const persistedArtifactPath = input.artifactStagingPath;
  if (persistedArtifactPath !== null) stagingFileName(persistedArtifactPath, jobId, 'persisted staging artifact path');
  const trackedArtifact = (expected.kind === 'quarantined' || expected.kind === 'present')
    && persistedArtifactPath !== null;
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
  } else if (expected.kind === 'present') {
    return fail('physical-present staging requires complete tracked artifact identity');
  } else if (!identityIsNull) {
    return fail('physical-present staging must have null artifact identity');
  }
  if (identityIsComplete) {
    artifactName = stagingFileName(persistedArtifactPath!, jobId, 'persisted staging artifact path');
    checksumName = stagingFileName(input.checksumPath!, jobId, 'persisted checksum sidecar path', 'sha256sums');
    manifestName = stagingFileName(input.manifestPath!, jobId, 'persisted manifest sidecar path', 'build-manifest.json');
    verificationName = stagingFileName(input.verificationPath!, jobId, 'persisted verification sidecar path', 'verification.json');
    const names = [artifactName, checksumName, manifestName, verificationName];
    if (new Set(names).size !== names.length) return fail('tracked staging artifact and sidecar paths must be pairwise distinct');
  }
  if (expected.kind === 'quarantined') {
    if (trackedArtifact && (expected.sha256 !== input.artifactSha256 || expected.size !== input.artifactSize)) return fail('cleanup quarantine evidence does not match the persisted artifact identity');
    if (!trackedArtifact && (expected.sha256 !== null || expected.size !== null)) return fail('physical-present quarantine evidence contains artifact identity');
  } else if (
    expected.kind === 'present'
    && (
      expected.sha256 !== input.artifactSha256
      || expected.size !== input.artifactSize
      || input.publishState !== 'publishing'
    )
  ) {
    return fail('recovery staging-present evidence does not match the persisted publishing artifact');
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
        const trackedFiles: HeldDescriptor[] = [];
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
          } else if (expected.kind === 'quarantined' && (source !== null || destination === null)) {
            return fail('cleanup quarantine does not match physical source and destination state');
          } else if (expected.kind === 'present' && (source === null || destination !== null)) {
            return fail('recovery staging-present proof does not match physical source and destination state');
          }
          if (trackedArtifact) {
            const directory = expected.kind === 'present' ? source! : destination!;
            const directoryName = expected.kind === 'present' ? 'staging' : 'quarantine';
            const files = [
              { name: artifactName!, sha256: input.artifactSha256!, size: input.artifactSize!, maxBytes: null },
              { name: checksumName!, sha256: input.checksumSha256!, size: null, maxBytes: TEXT_LIMITS.maxChecksumBytes },
              { name: manifestName!, sha256: input.manifestSha256!, size: null, maxBytes: Math.min(JSON_LIMITS.maxEncodedBytes, TEXT_LIMITS.maxManifestBytes) },
              { name: verificationName!, sha256: input.verificationSha256!, size: null, maxBytes: Math.min(JSON_LIMITS.maxEncodedBytes, TEXT_LIMITS.maxManifestBytes) },
            ] as const;
            const openedIdentities = new Set<string>();
            for (const tracked of files) {
              const field = `${directoryName}/${jobId}/${tracked.name}`;
              const file = await openFileChild(directory, tracked.name, field, ownerUid, snapshot.device, assertRegularArtifact);
              try {
                const fileStats = await descriptorStat(file, field);
                assertRegularArtifact(fileStats, field, ownerUid, snapshot.device);
                const identity = `${fileStats.dev}:${fileStats.ino}`;
                if (openedIdentities.has(identity)) return fail('tracked quarantine files must have distinct inode identities');
                openedIdentities.add(identity);
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
                trackedFiles.push({
                  path: `.osi-image-builder/${field}`,
                  parts: ['.osi-image-builder', directoryName, jobId, tracked.name],
                  handle: file,
                  stats: fileStats,
                  kind: 'file',
                });
              } catch (error) {
                await descriptorClose(file);
                throw error;
              }
            }
          }
          await revalidateManagedJob(root, builder, stagingParent, 'staging', jobId, expected.kind === 'present' ? source : null, ownerUid, snapshot.device);
          await revalidateManagedJob(root, builder, quarantineParent, 'quarantine', jobId, expected.kind === 'quarantined' ? destination : null, ownerUid, snapshot.device);
          if (trackedFiles.length > 0) {
            const parent = expected.kind === 'present' ? stagingParent : quarantineParent;
            const directory = expected.kind === 'present' ? source : destination;
            const directoryName = expected.kind === 'present' ? 'staging' : 'quarantine';
            if (builder === null || parent === null || directory === null) return fail('tracked staging descriptor chain is incomplete');
            const builderStats = await descriptorStat(builder, '.osi-image-builder held');
            const parentStats = await descriptorStat(parent, `.osi-image-builder/${directoryName} held`);
            const directoryStats = await descriptorStat(directory, `${directoryName}/${jobId} held`);
            assertPublisherDirectory(builderStats, '.osi-image-builder held', ownerUid, snapshot.device);
            assertPublisherDirectory(parentStats, `.osi-image-builder/${directoryName} held`, ownerUid, snapshot.device);
            assertJobDirectory(directoryStats, `${directoryName}/${jobId} held`, ownerUid, snapshot.device);
            const descriptors = new Map<string, HeldDescriptor>([
              ['.osi-image-builder', { path: '.osi-image-builder', parts: ['.osi-image-builder'], handle: builder, stats: builderStats, kind: 'directory', directoryMode: PUBLISHER_DIRECTORY_MODE }],
              [`.osi-image-builder/${directoryName}`, { path: `.osi-image-builder/${directoryName}`, parts: ['.osi-image-builder', directoryName], handle: parent, stats: parentStats, kind: 'directory', directoryMode: PUBLISHER_DIRECTORY_MODE }],
              [`.osi-image-builder/${directoryName}/${jobId}`, { path: `.osi-image-builder/${directoryName}/${jobId}`, parts: ['.osi-image-builder', directoryName, jobId], handle: directory, stats: directoryStats, kind: 'directory', directoryMode: DIRECTORY_MODE }],
            ]);
            for (const tracked of trackedFiles) {
              descriptors.set(tracked.path, tracked);
              await revalidateHeldChain(root, rootStats, descriptors, tracked, ownerUid, snapshot.device, assertRegularArtifact);
            }
          }
          await withApprovedRootSnapshot(approvedRootRegistry, rootId, async ({ snapshot: current }) => {
            if (
              current.id !== snapshot.id
              || current.path !== snapshot.path
              || current.quarantinePath !== snapshot.quarantinePath
              || current.device !== snapshot.device
              || current.inode !== snapshot.inode
            ) return fail('approved output root authority changed during staging verification');
          });
          if (expected.kind === 'present') {
            return Object.freeze({
              kind: 'present' as const,
              path: input.artifactStagingPath!,
              held: true as const,
              size: input.artifactSize!,
              sha256: input.artifactSha256!,
              verifiedAt: expected.verifiedAt,
            });
          }
          return true as const;
        } finally {
          await closeHandles([...trackedFiles.map((tracked) => tracked.handle), source, destination, stagingParent, quarantineParent, builder]);
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
    logs: Object.freeze({ verify: (input: RecoveryLogVerificationInput) => verifyPhysicalLogs(options.stateRootAuthority, ownerUid, input) }),
  });
}
