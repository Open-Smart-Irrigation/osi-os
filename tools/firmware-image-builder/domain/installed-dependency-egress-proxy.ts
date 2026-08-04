import { createHash } from 'node:crypto';
import { constants as fsConstants, type BigIntStats, type Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const HASH64 = /^[a-f0-9]{64}$/u;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const PROC_FD = '/proc/self/fd';
const OPERATIONS_DIRECTORY = 'operations';
const PROXY_FILE = 'osi-dependency-egress-proxy.cjs';
const O_CLOEXEC = (fsConstants as typeof fsConstants & { readonly O_CLOEXEC?: number }).O_CLOEXEC ?? 0x80000;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | O_CLOEXEC;
const FILE_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW | O_CLOEXEC;

export type InstalledDependencyEgressProxyErrorCode =
  | 'CONFIG_INVALID'
  | 'PLATFORM_UNSUPPORTED'
  | 'PATH_UNSAFE'
  | 'NOT_FOUND'
  | 'OWNER_MISMATCH'
  | 'DIRECTORY_UNSAFE'
  | 'FILE_UNSAFE'
  | 'SIZE_INVALID'
  | 'HASH_MISMATCH'
  | 'RACE_DETECTED'
  | 'READ_FAILED';

export class InstalledDependencyEgressProxyError extends Error {
  readonly code: InstalledDependencyEgressProxyErrorCode;

  constructor(code: InstalledDependencyEgressProxyErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InstalledDependencyEgressProxyError';
    this.code = code;
  }
}

export interface InstalledDependencyEgressProxyMetadata {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

export interface InstalledDependencyEgressProxyReadResult {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly identity: Readonly<{
    readonly packageRoot: string;
    readonly proxyPath: string;
    readonly package: InstalledDependencyEgressProxyMetadata;
    readonly operations: InstalledDependencyEgressProxyMetadata;
    readonly file: InstalledDependencyEgressProxyMetadata;
  }>;
}

export interface InstalledDependencyEgressProxyReaderHooks {
  readonly afterOpenPackage?: (context: { readonly packageDirectory: FileHandle }) => Promise<void> | void;
  readonly afterOpenOperations?: (context: { readonly packageDirectory: FileHandle; readonly operationsDirectory: FileHandle }) => Promise<void> | void;
  readonly beforePostRead?: (context: { readonly packageDirectory: FileHandle; readonly operationsDirectory: FileHandle; readonly proxy: FileHandle }) => Promise<void> | void;
  readonly beforeParentRevalidation?: (context: { readonly packageDirectory: FileHandle; readonly operationsDirectory: FileHandle; readonly proxy: FileHandle }) => Promise<void> | void;
}

export interface InstalledDependencyEgressProxyReaderOptions {
  readonly ownerUid?: number;
  readonly maxBytes?: number;
  readonly hooks?: InstalledDependencyEgressProxyReaderHooks;
}

export interface InstalledDependencyEgressProxyReader {
  readonly read: (packageRoot: string, expectedSha256: string) => Promise<InstalledDependencyEgressProxyReadResult>;
}

interface Snapshot {
  readonly stats: Stats;
  readonly precise: BigIntStats;
}

function fail(code: InstalledDependencyEgressProxyErrorCode, message: string, cause?: unknown): never {
  throw new InstalledDependencyEgressProxyError(code, message, cause === undefined ? undefined : { cause });
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function mapOpenError(error: unknown, field: string, racePossible = false): never {
  if (racePossible && ['ENOENT', 'ELOOP', 'ENOTDIR', 'EXDEV'].includes(errorCode(error) ?? '')) {
    fail('RACE_DETECTED', `${field} changed after its parent was held`, error);
  }
  switch (errorCode(error)) {
    case 'ENOENT': return fail('NOT_FOUND', `${field} was not found`, error);
    case 'ELOOP':
    case 'ENOTDIR':
    case 'EXDEV': return fail('PATH_UNSAFE', `${field} pathname is unsafe`, error);
    default: return fail('READ_FAILED', `could not open ${field}`, error);
  }
}

function validateOptions(options: InstalledDependencyEgressProxyReaderOptions): Readonly<{ ownerUid: number; maxBytes: number }> {
  if (process.platform !== 'linux' || typeof fsConstants.O_NOFOLLOW !== 'number' || typeof fsConstants.O_DIRECTORY !== 'number') {
    fail('PLATFORM_UNSUPPORTED', 'installed proxy reading requires Linux no-follow directory semantics');
  }
  const ownerUid = options.ownerUid ?? (typeof process.geteuid === 'function' ? process.geteuid() : undefined);
  if (ownerUid === undefined || !Number.isSafeInteger(ownerUid) || ownerUid < 0) {
    fail('CONFIG_INVALID', 'installed proxy owner UID is invalid');
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) {
    fail('CONFIG_INVALID', 'installed proxy maxBytes is invalid');
  }
  return Object.freeze({ ownerUid, maxBytes });
}

function childPath(directory: FileHandle, name: string): string {
  return join(PROC_FD, String(directory.fd), name);
}

async function snapshot(handle: FileHandle, field: string): Promise<Snapshot> {
  try {
    const stats = await handle.stat();
    const precise = await handle.stat({ bigint: true });
    if (
      BigInt(stats.dev) !== precise.dev
      || BigInt(stats.ino) !== precise.ino
      || BigInt(stats.mode) !== precise.mode
      || BigInt(stats.nlink) !== precise.nlink
      || BigInt(stats.uid) !== precise.uid
      || BigInt(stats.gid) !== precise.gid
      || BigInt(stats.size) !== precise.size
    ) fail('RACE_DETECTED', `${field} metadata precision changed`);
    return { stats, precise };
  } catch (error) {
    if (error instanceof InstalledDependencyEgressProxyError) throw error;
    fail('READ_FAILED', `could not stat ${field}`, error);
  }
}

async function namedSnapshot(directory: FileHandle, name: string, field: string): Promise<Snapshot> {
  try {
    const path = childPath(directory, name);
    return { stats: await lstat(path), precise: await lstat(path, { bigint: true }) };
  } catch (error) {
    mapOpenError(error, field, true);
  }
}

async function pathnameSnapshot(path: string, field: string): Promise<Snapshot> {
  try {
    return { stats: await lstat(path), precise: await lstat(path, { bigint: true }) };
  } catch (error) {
    mapOpenError(error, field, true);
  }
}

function assertDirectory(value: Snapshot, ownerUid: number, field: string, expectedDevice?: number): void {
  const stats = value.stats;
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail('PATH_UNSAFE', `${field} is not a directory`);
  if (stats.uid !== ownerUid) fail('OWNER_MISMATCH', `${field} owner does not match the configured UID`);
  if ((stats.mode & 0o7777) !== 0o555 || stats.nlink < 1 || (expectedDevice !== undefined && stats.dev !== expectedDevice)) {
    fail('DIRECTORY_UNSAFE', `${field} metadata is unsafe`);
  }
}

function assertFile(value: Snapshot, operations: Snapshot, ownerUid: number, maxBytes: number): void {
  const stats = value.stats;
  if (!stats.isFile() || stats.isSymbolicLink()) fail('FILE_UNSAFE', 'installed dependency egress proxy is not a regular file');
  if (stats.uid !== ownerUid) fail('OWNER_MISMATCH', 'installed dependency egress proxy owner does not match the configured UID');
  if ((stats.mode & 0o7777) !== 0o444 || stats.nlink !== 1 || stats.dev !== operations.stats.dev) {
    fail('FILE_UNSAFE', 'installed dependency egress proxy metadata is unsafe');
  }
  if (!Number.isSafeInteger(stats.size) || stats.size < 1 || stats.size > maxBytes) {
    fail('SIZE_INVALID', 'installed dependency egress proxy exceeds its byte bound');
  }
}

function samePrecise(left: Snapshot, right: Snapshot): boolean {
  return left.precise.dev === right.precise.dev
    && left.precise.ino === right.precise.ino
    && left.precise.mode === right.precise.mode
    && left.precise.nlink === right.precise.nlink
    && left.precise.uid === right.precise.uid
    && left.precise.gid === right.precise.gid
    && left.precise.size === right.precise.size
    && left.precise.mtimeNs === right.precise.mtimeNs
    && left.precise.ctimeNs === right.precise.ctimeNs;
}

function metadata(value: Snapshot): InstalledDependencyEgressProxyMetadata {
  return Object.freeze({
    dev: value.stats.dev,
    ino: value.stats.ino,
    uid: value.stats.uid,
    mode: value.stats.mode & 0o7777,
    nlink: value.stats.nlink,
    size: value.stats.size,
    mtimeNs: value.precise.mtimeNs.toString(),
    ctimeNs: value.precise.ctimeNs.toString(),
  });
}

async function readExact(file: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < bytes.length) {
    let result;
    try {
      result = await file.read(bytes, offset, bytes.length - offset, offset);
    } catch (error) {
      fail('READ_FAILED', 'could not read installed dependency egress proxy', error);
    }
    if (result.bytesRead <= 0 || result.bytesRead > bytes.length - offset) {
      fail('RACE_DETECTED', 'installed dependency egress proxy read was incomplete');
    }
    offset += result.bytesRead;
  }
  return bytes;
}

export function createInstalledDependencyEgressProxyReader(
  options: InstalledDependencyEgressProxyReaderOptions = {},
): InstalledDependencyEgressProxyReader {
  const { ownerUid, maxBytes } = validateOptions(options);
  const hooks = options.hooks;
  return Object.freeze({
    read: async (packageRoot: string, expectedSha256: string) => {
      if (typeof packageRoot !== 'string' || !isAbsolute(packageRoot) || packageRoot.includes('\0')) {
        fail('CONFIG_INVALID', 'installed package root must be an absolute path');
      }
      if (!HASH64.test(expectedSha256) || /^0+$/u.test(expectedSha256)) {
        fail('CONFIG_INVALID', 'expected proxy SHA-256 is invalid');
      }
      let packageDirectory: FileHandle | undefined;
      let operationsDirectory: FileHandle | undefined;
      let proxy: FileHandle | undefined;
      try {
        try { packageDirectory = await open(packageRoot, DIRECTORY_FLAGS); }
        catch (error) { mapOpenError(error, 'installed package root'); }
        const packageBefore = await snapshot(packageDirectory, 'installed package root');
        assertDirectory(packageBefore, ownerUid, 'installed package root');
        await hooks?.afterOpenPackage?.({ packageDirectory });

        try { operationsDirectory = await open(childPath(packageDirectory, OPERATIONS_DIRECTORY), DIRECTORY_FLAGS); }
        catch (error) { mapOpenError(error, 'installed operations directory', hooks?.afterOpenPackage !== undefined); }
        const operationsBefore = await snapshot(operationsDirectory, 'installed operations directory');
        assertDirectory(operationsBefore, ownerUid, 'installed operations directory', packageBefore.stats.dev);
        await hooks?.afterOpenOperations?.({ packageDirectory, operationsDirectory });

        try { proxy = await open(childPath(operationsDirectory, PROXY_FILE), FILE_FLAGS); }
        catch (error) { mapOpenError(error, 'installed dependency egress proxy', hooks?.afterOpenOperations !== undefined); }
        const fileBefore = await snapshot(proxy, 'installed dependency egress proxy');
        assertFile(fileBefore, operationsBefore, ownerUid, maxBytes);
        const bytes = await readExact(proxy, fileBefore.stats.size);

        await hooks?.beforePostRead?.({ packageDirectory, operationsDirectory, proxy });
        const fileAfter = await snapshot(proxy, 'installed dependency egress proxy');
        assertFile(fileAfter, operationsBefore, ownerUid, maxBytes);
        if (!samePrecise(fileBefore, fileAfter)) fail('RACE_DETECTED', 'installed dependency egress proxy changed while held');
        const namedFile = await namedSnapshot(operationsDirectory, PROXY_FILE, 'installed dependency egress proxy pathname');
        assertFile(namedFile, operationsBefore, ownerUid, maxBytes);
        if (!samePrecise(fileAfter, namedFile)) fail('RACE_DETECTED', 'installed dependency egress proxy pathname changed');

        await hooks?.beforeParentRevalidation?.({ packageDirectory, operationsDirectory, proxy });
        const operationsAfter = await snapshot(operationsDirectory, 'installed operations directory');
        assertDirectory(operationsAfter, ownerUid, 'installed operations directory', packageBefore.stats.dev);
        if (!samePrecise(operationsBefore, operationsAfter)) fail('RACE_DETECTED', 'installed operations directory descriptor changed');
        const namedOperations = await namedSnapshot(packageDirectory, OPERATIONS_DIRECTORY, 'installed operations directory pathname');
        assertDirectory(namedOperations, ownerUid, 'installed operations directory', packageBefore.stats.dev);
        if (!samePrecise(operationsAfter, namedOperations)) fail('RACE_DETECTED', 'installed operations directory pathname changed');

        const packageAfter = await snapshot(packageDirectory, 'installed package root');
        assertDirectory(packageAfter, ownerUid, 'installed package root');
        if (!samePrecise(packageBefore, packageAfter)) fail('RACE_DETECTED', 'installed package root descriptor changed');
        const namedPackage = await pathnameSnapshot(packageRoot, 'installed package root pathname');
        assertDirectory(namedPackage, ownerUid, 'installed package root');
        if (!samePrecise(packageAfter, namedPackage)) fail('RACE_DETECTED', 'installed package root pathname changed');

        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (sha256 !== expectedSha256) fail('HASH_MISMATCH', 'installed dependency egress proxy hash does not match the admitted identity');
        return Object.freeze({
          bytes,
          sha256,
          identity: Object.freeze({
            packageRoot,
            proxyPath: join(packageRoot, OPERATIONS_DIRECTORY, PROXY_FILE),
            package: metadata(packageAfter),
            operations: metadata(operationsAfter),
            file: metadata(fileAfter),
          }),
        });
      } catch (error) {
        if (error instanceof InstalledDependencyEgressProxyError) throw error;
        throw new InstalledDependencyEgressProxyError('READ_FAILED', 'installed dependency egress proxy read failed', { cause: error });
      } finally {
        if (proxy !== undefined) await proxy.close().catch(() => undefined);
        if (operationsDirectory !== undefined) await operationsDirectory.close().catch(() => undefined);
        if (packageDirectory !== undefined) await packageDirectory.close().catch(() => undefined);
      }
    },
  });
}
