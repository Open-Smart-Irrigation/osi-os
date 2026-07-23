import { createHash } from 'node:crypto';
import { lstat, open, readlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  ConfigAuthorityError,
  withApprovedRootSnapshot,
  withStateRootSnapshot,
  type ApprovedRootRegistry,
  type PathAuthorityDependencies,
  type StateRootAuthority,
} from '../config/load.js';
import { TARGET_IDS, type TargetId } from './types.js';

const SHA40 = /^[0-9a-f]{40}$/;
const MAX_SEGMENT_BYTES = 255;
const MAX_PATH_BYTES = 4_096;
const MAX_BRANCH_SOURCE_BYTES = 4_096;
const MAX_READ_BYTES = 16 * 1024 * 1024;
const PROC_FD_ROOT = '/proc/self/fd';
const LINUX_O_PATH = 0x200000;
const LINUX_O_CLOEXEC = 0x80000;
const directDependencies: PathAuthorityDependencies = Object.freeze({
  close: async (handle: FileHandle) => handle.close(),
  stat: async (handle: FileHandle) => handle.stat(),
  statBigInt: async (handle: FileHandle) => handle.stat({ bigint: true }),
  readlink,
  mountId: async (handle: FileHandle) => {
    if (process.platform !== 'linux') throw new Error('Linux fdinfo mount IDs are unavailable');
    const { readFile } = await import('node:fs/promises');
    const contents = await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
    const match = contents.match(/^mnt_id:\s*(\d+)\s*$/m);
    if (!match) throw new Error('Linux fdinfo mount ID is malformed');
    const mountId = Number(match[1]);
    if (!Number.isSafeInteger(mountId) || mountId < 0) throw new Error('Linux fdinfo mount ID is invalid');
    return mountId;
  },
  beforeRead: async () => undefined,
});

export type { ApprovedRootRegistry, StateRootAuthority } from '../config/load.js';

export type PathPreviewKind = 'staging' | 'quarantine' | 'release' | 'evidence';
export interface PathPreview {
  readonly kind: PathPreviewKind;
  readonly rootId: string | null;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly collision: boolean;
  readonly authority: 'preview-only';
}

export interface ReadCapabilityStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly device: number;
  readonly inode: number;
  readonly links: number;
}

export interface ReadCapability {
  readonly read: (maxBytes?: number) => Promise<Buffer>;
  readonly readFile: (maxBytes?: number) => Promise<Buffer>;
  readonly stat: () => Promise<ReadCapabilityStat>;
  readonly hashSha256: () => Promise<string>;
}

export interface HeldParentCapability {
  readonly openRead: <T>(basename: string, callback: (reader: ReadCapability) => Promise<T>) => Promise<T>;
}

export type PathErrorCode = 'INVALID_PATH' | 'OUTPUT_COLLISION' | 'NON_REGULAR_TARGET' | 'MOUNT_CROSSING' | 'HARDLINK_TARGET' | 'CAPABILITY_EXPIRED' | 'PROC_UNAVAILABLE';

export class PathSecurityError extends Error {
  readonly code: PathErrorCode;
  cleanupErrors?: readonly unknown[];

  constructor(code: PathErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PathSecurityError';
    this.code = code;
  }
}

function reject(code: PathErrorCode, message: string, cause?: unknown): never {
  throw new PathSecurityError(code, message, cause === undefined ? undefined : { cause });
}

function authorityError(error: unknown): never {
  if (error instanceof ConfigAuthorityError) return reject('INVALID_PATH', 'configured path authority is invalid', error);
  throw error;
}

function utf8Width(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function scanRelative(value: unknown, field: string, maxBytes = MAX_PATH_BYTES): string[] {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value) || value.includes('\\') || value.includes('\0')) return reject('INVALID_PATH', `${field} must be a stable relative path`);
  const parts: string[] = [];
  let start = 0;
  let segmentBytes = 0;
  let totalBytes = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!;
    const characterLength = codePoint > 0xffff ? 2 : 1;
    const character = value.slice(index, index + characterLength);
    if (character === '/') {
      if (segmentBytes === 0 || value.slice(start, index) === '.' || value.slice(start, index) === '..') return reject('INVALID_PATH', `${field} contains an unsafe component`);
      totalBytes += 1;
      if (totalBytes > maxBytes) return reject('INVALID_PATH', `${field} exceeds its byte budget`);
      parts.push(value.slice(start, index));
      start = index + 1;
      segmentBytes = 0;
    } else {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) return reject('INVALID_PATH', `${field} contains an unpaired surrogate`);
      const width = utf8Width(codePoint);
      totalBytes += width;
      segmentBytes += width;
      if (totalBytes > maxBytes) return reject('INVALID_PATH', `${field} exceeds its byte budget`);
      if (segmentBytes > MAX_SEGMENT_BYTES) return reject('INVALID_PATH', `${field} exceeds its segment budget`);
    }
    index += characterLength;
  }
  if (segmentBytes === 0 || value.slice(start) === '.' || value.slice(start) === '..') return reject('INVALID_PATH', `${field} contains an unsafe component`);
  parts.push(value.slice(start));
  return parts;
}

function boundedSegment(value: unknown, field: string): string {
  const parts = scanRelative(value, field, MAX_SEGMENT_BYTES);
  if (parts.length !== 1) return reject('INVALID_PATH', `${field} must be a single segment`);
  return parts[0];
}

export function encodeBranchSlug(branch: string): string {
  if (typeof branch !== 'string' || branch.length === 0 || branch === '.' || branch === '..') return reject('INVALID_PATH', 'branch must be non-empty and not a dot segment');
  let sourceBytes = 0;
  let outputBytes = 0;
  let result = '';
  for (let index = 0; index < branch.length;) {
    const codePoint = branch.codePointAt(index)!;
    const characterLength = codePoint > 0xffff ? 2 : 1;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return reject('INVALID_PATH', 'branch contains an unpaired surrogate');
    const character = branch.slice(index, index + characterLength);
    const bytes = Buffer.from(character, 'utf8');
    sourceBytes += bytes.length;
    if (sourceBytes > MAX_BRANCH_SOURCE_BYTES) return reject('INVALID_PATH', 'branch exceeds its byte budget');
    for (const byte of bytes) {
      const literal = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e;
      outputBytes += literal ? 1 : 3;
      if (outputBytes > MAX_SEGMENT_BYTES) return reject('INVALID_PATH', 'encoded branch slug exceeds the filesystem segment limit');
      result += literal ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    index += characterLength;
  }
  return result;
}

async function existingCollision(rootPath: string, relative: string): Promise<boolean> {
  const parts = scanRelative(relative, 'path');
  let current = rootPath;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    let stats;
    try { stats = await lstat(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      return reject('INVALID_PATH', 'path component cannot be inspected', error);
    }
    if (stats.isSymbolicLink()) return reject('INVALID_PATH', 'path component may not be a symlink');
    if (index < parts.length - 1 && !stats.isDirectory()) return reject('INVALID_PATH', 'path component is not a directory');
    if (index === parts.length - 1) return true;
  }
  return false;
}

async function previewRootPath(
  kind: PathPreviewKind,
  registry: ApprovedRootRegistry,
  rootId: string,
  relative: string,
): Promise<PathPreview> {
  try {
    return await withApprovedRootSnapshot(registry, rootId, async ({ snapshot }) => ({
      kind,
      rootId,
      relativePath: relative,
      absolutePath: join(snapshot.path, ...scanRelative(relative, 'path')),
      collision: await existingCollision(snapshot.path, relative),
      authority: 'preview-only',
    }));
  } catch (error) { return authorityError(error); }
}

async function previewStatePath(stateRoot: StateRootAuthority, jobId: string, stableRelativeFile: string): Promise<PathPreview> {
  boundedSegment(jobId, 'jobId');
  const fileParts = scanRelative(stableRelativeFile, 'evidence file');
  const relative = `jobs/${jobId}/evidence/${fileParts.join('/')}`;
  try {
    return await withStateRootSnapshot(stateRoot, async ({ snapshot }) => ({
      kind: 'evidence',
      rootId: null,
      relativePath: relative,
      absolutePath: join(snapshot.path, ...scanRelative(relative, 'evidence path')),
      collision: await existingCollision(snapshot.path, relative),
      authority: 'preview-only',
    }));
  } catch (error) { return authorityError(error); }
}

export async function previewStagingPath(registry: ApprovedRootRegistry, rootId: string, jobId: string): Promise<PathPreview> {
  const job = boundedSegment(jobId, 'jobId');
  return previewRootPath('staging', registry, rootId, `.osi-image-builder/staging/${job}`);
}

export async function previewQuarantinePath(registry: ApprovedRootRegistry, rootId: string, jobId: string): Promise<PathPreview> {
  const job = boundedSegment(jobId, 'jobId');
  return previewRootPath('quarantine', registry, rootId, `.osi-image-builder/quarantine/${job}`);
}

export async function previewReleasePath(registry: ApprovedRootRegistry, rootId: string, branch: string, pinnedSha: string, targetId: TargetId): Promise<PathPreview> {
  const slug = encodeBranchSlug(branch);
  if (typeof pinnedSha !== 'string' || !SHA40.test(pinnedSha)) return reject('INVALID_PATH', 'pinned SHA must be a lowercase 40-hex commit');
  if (!(TARGET_IDS as readonly string[]).includes(targetId)) return reject('INVALID_PATH', 'target ID is not approved');
  return previewRootPath('release', registry, rootId, `${slug}/${pinnedSha}/${targetId}`);
}

export async function previewEvidencePath(stateRoot: StateRootAuthority, jobId: string, stableRelativeFile: string): Promise<PathPreview> {
  return previewStatePath(stateRoot, jobId, stableRelativeFile);
}

function requiredFlags(base: number): number {
  const optional = fsConstants as typeof fsConstants & { readonly O_CLOEXEC?: number; readonly O_PATH?: number };
  if (process.platform !== 'linux' || typeof fsConstants.O_NOFOLLOW !== 'number' || typeof fsConstants.O_DIRECTORY !== 'number' || typeof fsConstants.O_NONBLOCK !== 'number') return reject('PROC_UNAVAILABLE', 'Linux no-follow descriptor capabilities are unavailable');
  return base | fsConstants.O_NOFOLLOW | (optional.O_CLOEXEC ?? LINUX_O_CLOEXEC);
}

function procFlags(base: number): number {
  const optional = fsConstants as typeof fsConstants & { readonly O_CLOEXEC?: number };
  if (process.platform !== 'linux' || typeof fsConstants.O_DIRECTORY !== 'number') return reject('PROC_UNAVAILABLE', 'Linux proc descriptor capabilities are unavailable');
  return base | (optional.O_CLOEXEC ?? LINUX_O_CLOEXEC);
}

function pathInspectionFlags(): number { const optional = fsConstants as typeof fsConstants & { readonly O_PATH?: number }; return requiredFlags(optional.O_PATH ?? LINUX_O_PATH); }

interface ScopeToken {
  readonly addHandle: (handle: FileHandle) => void;
}

class OperationScope {
  readonly handles: FileHandle[] = [];
  private active = true;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly operationErrors: unknown[] = [];

  start<T>(operation: (token: ScopeToken) => Promise<T> | T): Promise<T> {
    if (!this.active) return Promise.reject(new PathSecurityError('CAPABILITY_EXPIRED', 'capability scope has ended'));
    this.inFlight += 1;
    const token: ScopeToken = Object.freeze({ addHandle: (handle: FileHandle) => { this.handles.push(handle); } });
    let promise: Promise<T>;
    try { promise = Promise.resolve(operation(token)); } catch (error) { promise = Promise.reject(error); }
    promise.catch((error) => {
      if (!this.operationErrors.includes(error)) this.operationErrors.push(error);
    }).finally(() => {
      this.inFlight -= 1;
      if (this.inFlight === 0) for (const waiter of this.waiters.splice(0)) waiter();
    }).catch(() => undefined);
    return promise;
  }

  async finish(): Promise<readonly unknown[]> {
    this.active = false;
    while (this.inFlight > 0) await new Promise<void>((resolveWaiter) => this.waiters.push(resolveWaiter));
    return this.operationErrors;
  }
}

async function closeAll<T>(handles: readonly FileHandle[], dependencies: PathAuthorityDependencies, primary: unknown, hasPrimary: boolean, result: T, priorCleanupErrors: readonly unknown[] = []): Promise<T> {
  const errors: unknown[] = [...priorCleanupErrors];
  const seen = new Set<number>();
  for (const handle of [...handles].reverse()) {
    if (seen.has(handle.fd)) continue;
    seen.add(handle.fd);
    try { await dependencies.close(handle); } catch (error) { errors.push(error); }
  }
  if (hasPrimary) {
    if (errors.length > 0 && primary && typeof primary === 'object' && Object.isExtensible(primary)) {
      Object.defineProperty(primary, 'cleanupErrors', { configurable: true, enumerable: false, value: errors, writable: false });
    }
    if (errors.length > 0 && (!primary || typeof primary !== 'object' || !Object.isExtensible(primary))) throw new AggregateError([primary, ...errors], 'path operation failed during cleanup');
    throw primary;
  }
  if (errors.length > 0) throw new AggregateError(errors, 'path operation cleanup failed');
  return result;
}

async function descriptorMountId(handle: FileHandle, dependencies: PathAuthorityDependencies): Promise<number> {
  try {
    const mountId = await dependencies.mountId(handle);
    if (!Number.isSafeInteger(mountId) || mountId < 0) return reject('PROC_UNAVAILABLE', 'Linux fdinfo mount ID is invalid');
    return mountId;
  } catch (error) {
    if (error instanceof PathSecurityError) throw error;
    return reject('PROC_UNAVAILABLE', 'Linux fdinfo mount ID semantics are unavailable', error);
  }
}

async function procMagicDirectory(root: FileHandle, dependencies: PathAuthorityDependencies, rootDevice: number, rootMountId: number, scope: OperationScope): Promise<void> {
  let proc: FileHandle;
  try { proc = await open(PROC_FD_ROOT, requiredFlags(fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)); } catch (error) { return reject('PROC_UNAVAILABLE', 'Linux proc fd directory could not be opened', error); }
  scope.handles.push(proc);
  const procStats = await dependencies.stat(proc);
  if (!procStats.isDirectory()) return reject('PROC_UNAVAILABLE', 'Linux proc fd path is not a directory');
  const entry = join(PROC_FD_ROOT, String(root.fd));
  let link: string;
  try { link = await dependencies.readlink(entry); } catch (error) { return reject('PROC_UNAVAILABLE', 'Linux proc fd magic link could not be read', error); }
  if (link.length === 0 || !link.startsWith('/')) return reject('PROC_UNAVAILABLE', 'Linux proc fd magic link semantics are unavailable');
  let duplicate: FileHandle;
  try { duplicate = await open(entry, procFlags(fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)); } catch (error) { return reject('PROC_UNAVAILABLE', 'Linux proc fd magic link could not be reopened', error); }
  scope.handles.push(duplicate);
  const duplicateStats = await dependencies.stat(duplicate);
  if (!duplicateStats.isDirectory() || duplicateStats.dev !== rootDevice || duplicateStats.ino !== (await dependencies.stat(root)).ino) return reject('PROC_UNAVAILABLE', 'Linux proc fd identity verification failed');
  if (await descriptorMountId(duplicate, dependencies) !== rootMountId) return reject('MOUNT_CROSSING', 'Linux proc descriptor crosses a mount boundary');
}

function sameStableFile(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.nlink === after.nlink && before.mode === after.mode && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

function statMatchesPrecise(stats: { readonly dev: number; readonly ino: number; readonly size: number; readonly nlink: number; readonly mode: number }, precise: BigIntStats): boolean {
  return BigInt(stats.dev) === precise.dev && BigInt(stats.ino) === precise.ino && BigInt(stats.size) === precise.size && BigInt(stats.nlink) === precise.nlink && BigInt(stats.mode) === precise.mode;
}

function capability(handle: FileHandle, dependencies: PathAuthorityDependencies, scope: OperationScope): ReadCapability {
  const stats = async () => dependencies.stat(handle);
  const preciseStats = async () => dependencies.statBigInt(handle);
  const safeStat = (): Promise<ReadCapabilityStat> => scope.start(async () => {
    const value = await stats();
    return { size: value.size, mtimeMs: value.mtimeMs, device: value.dev, inode: value.ino, links: value.nlink };
  });
  const readAll = (maxBytes = MAX_READ_BYTES): Promise<Buffer> => scope.start(async () => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_READ_BYTES) return reject('INVALID_PATH', 'read limit exceeds the bounded capability limit');
    const value = await stats();
    const preciseBefore = await preciseStats();
    if (!statMatchesPrecise(value, preciseBefore)) return reject('INVALID_PATH', 'file metadata changed before read');
    if (!value.isFile() || value.size > maxBytes) return reject('NON_REGULAR_TARGET', 'read target is not bounded or regular');
    const output = Buffer.alloc(value.size);
    await dependencies.beforeRead(handle);
    let position = 0;
    while (position < output.length) {
      const read = await handle.read(output, position, output.length - position, position);
      if (read.bytesRead === 0) return reject('INVALID_PATH', 'file changed during read');
      position += read.bytesRead;
    }
    const after = await stats();
    const preciseAfter = await preciseStats();
    if (!after.isFile() || !statMatchesPrecise(after, preciseAfter) || !sameStableFile(preciseBefore, preciseAfter)) return reject('INVALID_PATH', 'file changed during read');
    return output;
  });
  const hashSha256 = (): Promise<string> => scope.start(async () => {
    const value = await stats();
    const preciseBefore = await preciseStats();
    if (!statMatchesPrecise(value, preciseBefore)) return reject('INVALID_PATH', 'file metadata changed before hashing');
    if (!value.isFile()) return reject('NON_REGULAR_TARGET', 'hash target is not regular');
    await dependencies.beforeRead(handle);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    for (let position = 0; position < value.size;) {
      const read = await handle.read(buffer, 0, Math.min(buffer.length, value.size - position), position);
      if (read.bytesRead === 0) return reject('INVALID_PATH', 'file changed while hashing');
      hash.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    const after = await stats();
    const preciseAfter = await preciseStats();
    if (!after.isFile() || !statMatchesPrecise(after, preciseAfter) || !sameStableFile(preciseBefore, preciseAfter)) return reject('INVALID_PATH', 'file changed while hashing');
    return hash.digest('hex');
  });
  return Object.freeze({ read: readAll, readFile: readAll, stat: safeStat, hashSha256 });
}

async function openHeldReader<T>(parent: FileHandle, basename: string, snapshot: { readonly device: number; readonly mountId: number }, dependencies: PathAuthorityDependencies, scope: OperationScope, token: ScopeToken, callback: (reader: ReadCapability) => Promise<T>): Promise<T> {
  const finalName = boundedSegment(basename, 'basename');
  let inspected: FileHandle;
  try { inspected = await open(join(PROC_FD_ROOT, String(parent.fd), finalName), pathInspectionFlags()); } catch (error) { return reject('INVALID_PATH', 'evidence target could not be inspected no-follow', error); }
  token.addHandle(inspected);
  const inspectedStats = await dependencies.stat(inspected);
  const inspectedPrecise = await dependencies.statBigInt(inspected);
  if (!inspectedStats.isFile()) return reject('NON_REGULAR_TARGET', 'evidence target is not a regular file');
  if (!statMatchesPrecise(inspectedStats, inspectedPrecise)) return reject('PROC_UNAVAILABLE', 'inspected descriptor metadata is not precise');
  if (inspectedStats.dev !== snapshot.device) return reject('MOUNT_CROSSING', 'evidence target crosses a filesystem boundary');
  if (inspectedStats.nlink !== 1) return reject('HARDLINK_TARGET', 'evidence target is hardlinked');
  if (await descriptorMountId(inspected, dependencies) !== snapshot.mountId) return reject('MOUNT_CROSSING', 'evidence target crosses a mount boundary');
  let readable: FileHandle;
  try { readable = await open(join(PROC_FD_ROOT, String(inspected.fd)), procFlags(fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)); } catch (error) { return reject('PROC_UNAVAILABLE', 'readable descriptor could not be duplicated from the held inode', error); }
  token.addHandle(readable);
  const readableStats = await dependencies.stat(readable);
  const readablePrecise = await dependencies.statBigInt(readable);
  if (!readableStats.isFile() || readableStats.dev !== inspectedStats.dev || readableStats.ino !== inspectedStats.ino || readableStats.nlink !== inspectedStats.nlink) return reject('PROC_UNAVAILABLE', 'readable descriptor identity changed');
  if (!statMatchesPrecise(readableStats, readablePrecise) || !sameStableFile(inspectedPrecise, readablePrecise)) return reject('PROC_UNAVAILABLE', 'readable descriptor metadata changed');
  if (await descriptorMountId(readable, dependencies) !== snapshot.mountId) return reject('MOUNT_CROSSING', 'readable descriptor crosses a mount boundary');
  return callback(capability(readable, dependencies, scope));
}

export async function withHeldParentUnderRoot<T>(registry: ApprovedRootRegistry, rootId: string, relativeParent: string, callback: (parent: HeldParentCapability) => Promise<T>): Promise<T> {
  const components = relativeParent.length === 0 ? [] : scanRelative(relativeParent, 'relative parent');
  const scope = new OperationScope();
  let closeDependencies = directDependencies;
  let primary: unknown;
  let hasPrimary = false;
  let result: T;
  try {
    await withApprovedRootSnapshot(registry, rootId, async ({ snapshot, dependencies }) => {
      closeDependencies = dependencies;
      let root: FileHandle;
      try { root = await open(snapshot.path, requiredFlags(fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)); } catch (error) { return reject('INVALID_PATH', 'approved root could not be opened no-follow', error); }
      scope.handles.push(root);
      const rootStats = await dependencies.stat(root);
      if (!rootStats.isDirectory() || rootStats.dev !== snapshot.device || rootStats.ino !== snapshot.inode) return reject('INVALID_PATH', 'approved root identity changed while opening');
      const rootMountId = await descriptorMountId(root, dependencies);
      await procMagicDirectory(root, dependencies, snapshot.device, rootMountId, scope);
      let parent = root;
      for (const component of components) {
        let directory: FileHandle;
        try { directory = await open(join(PROC_FD_ROOT, String(parent.fd), component), requiredFlags(fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)); } catch (error) { return reject('INVALID_PATH', 'no-follow directory traversal failed', error); }
        scope.handles.push(directory);
        const stats = await dependencies.stat(directory);
        if (!stats.isDirectory()) return reject('INVALID_PATH', 'evidence component is not a directory');
        if (stats.dev !== snapshot.device) return reject('MOUNT_CROSSING', 'evidence component crosses a filesystem boundary');
        if (await descriptorMountId(directory, dependencies) !== rootMountId) return reject('MOUNT_CROSSING', 'evidence component crosses a mount boundary');
        parent = directory;
      }
      const parentCapability: HeldParentCapability = Object.freeze({
        openRead: <V>(basename: string, readerCallback: (reader: ReadCapability) => Promise<V>) => scope.start((token) => openHeldReader(parent, basename, { device: snapshot.device, mountId: rootMountId }, dependencies, scope, token, readerCallback)),
      });
      result = await callback(parentCapability);
    });
  } catch (error) {
    primary = error instanceof ConfigAuthorityError
      ? new PathSecurityError('INVALID_PATH', 'configured path authority is invalid', { cause: error })
      : error;
    hasPrimary = true;
  }
  const operationErrors = await scope.finish();
  if (!hasPrimary && operationErrors.length > 0) {
    primary = operationErrors.length === 1 ? operationErrors[0] : new AggregateError([...operationErrors], 'background capability operation failed');
    hasPrimary = true;
  }
  return await closeAll(scope.handles, closeDependencies, primary, hasPrimary, result!, operationErrors.filter((error) => error !== primary));
}

export async function withNoFollowFileUnderRoot<T>(registry: ApprovedRootRegistry, rootId: string, relative: string, callback: (reader: ReadCapability) => Promise<T>): Promise<T> {
  const components = scanRelative(relative, 'relative file');
  return withHeldParentUnderRoot(registry, rootId, components.slice(0, -1).join('/'), (parent) => parent.openRead(components.at(-1)!, callback));
}
