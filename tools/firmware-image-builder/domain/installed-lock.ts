import { constants as fsConstants, type BigIntStats, type Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';

import {
  INSTALLED_BUILDER_LOCK_MODE,
  INSTALLED_BUILDER_LOCK_NAME,
} from './installed-layout.js';

const DEFAULT_MAX_BYTES = 65_536;
const PROC_FD = '/proc/self/fd';
const O_CLOEXEC = (fsConstants as typeof fsConstants & { readonly O_CLOEXEC?: number }).O_CLOEXEC ?? 0x80000;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | O_CLOEXEC;
const FILE_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW | O_CLOEXEC;
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true });

export type InstalledLockReadErrorCode =
  | 'CONFIG_INVALID'
  | 'PLATFORM_UNSUPPORTED'
  | 'PATH_UNSAFE'
  | 'NOT_FOUND'
  | 'OWNER_MISMATCH'
  | 'LOCK_UNSAFE'
  | 'SIZE_INVALID'
  | 'RACE_DETECTED'
  | 'JSON_INVALID'
  | 'READ_FAILED';

export class InstalledLockReadError extends Error {
  readonly code: InstalledLockReadErrorCode;

  constructor(code: InstalledLockReadErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InstalledLockReadError';
    this.code = code;
  }
}

export interface InstalledLockIdentity {
  readonly installationDirectory: string;
  readonly lockPath: string;
  readonly parent: InstalledLockParentIdentity;
  readonly file: InstalledLockFileIdentity;
}

export interface InstalledLockParentIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

export interface InstalledLockFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

export interface InstalledLockReadResult {
  readonly bytes: Buffer;
  readonly text: string;
  readonly identity: InstalledLockIdentity;
}

export interface InstalledLockReaderHooks {
  readonly afterOpenDirectory?: (context: { readonly directory: FileHandle }) => Promise<void> | void;
  readonly beforePostRead?: (context: { readonly directory: FileHandle; readonly lock: FileHandle }) => Promise<void> | void;
  readonly beforeParentRevalidation?: (context: { readonly directory: FileHandle; readonly lock: FileHandle }) => Promise<void> | void;
}

export interface InstalledLockReaderOptions {
  readonly ownerUid?: number;
  readonly maxBytes?: number;
  readonly hooks?: InstalledLockReaderHooks;
}

export interface InstalledLockReader {
  readonly read: (installationDirectory: string) => Promise<InstalledLockReadResult>;
}

interface Snapshot {
  readonly stats: Stats;
  readonly precise: BigIntStats;
}

function fail(code: InstalledLockReadErrorCode, message: string, cause?: unknown): never {
  throw new InstalledLockReadError(code, message, cause === undefined ? undefined : { cause });
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function mapOpenError(error: unknown, field: string): never {
  switch (errorCode(error)) {
    case 'ENOENT': return fail('NOT_FOUND', `${field} was not found`, error);
    case 'ELOOP':
    case 'ENOTDIR':
    case 'EXDEV': return fail('PATH_UNSAFE', `${field} pathname is unsafe`, error);
    default: return fail('READ_FAILED', `could not open ${field}`, error);
  }
}

function validateOptions(options: InstalledLockReaderOptions): { readonly ownerUid: number; readonly maxBytes: number } {
  if (process.platform !== 'linux' || typeof fsConstants.O_NOFOLLOW !== 'number' || typeof fsConstants.O_DIRECTORY !== 'number') {
    fail('PLATFORM_UNSUPPORTED', 'installed lock reading requires Linux no-follow directory semantics');
  }
  const ownerUid = options.ownerUid ?? (typeof process.geteuid === 'function' ? process.geteuid() : undefined);
  if (ownerUid === undefined || !Number.isSafeInteger(ownerUid) || ownerUid < 0) fail('CONFIG_INVALID', 'installed lock owner UID is invalid');
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) fail('CONFIG_INVALID', 'installed lock maxBytes is invalid');
  return { ownerUid, maxBytes };
}

function childPath(directory: FileHandle, name: string): string {
  return join(PROC_FD, String(directory.fd), name);
}

function isRegular(stats: Stats): boolean {
  return stats.isFile() && !stats.isSymbolicLink();
}

function samePrecise(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameParentIdentity(left: Snapshot, right: Snapshot): boolean {
  return left.stats.isDirectory()
    && right.stats.isDirectory()
    && left.stats.dev === right.stats.dev
    && left.stats.ino === right.stats.ino
    && left.stats.uid === right.stats.uid
    && (left.stats.mode & 0o7777) === (right.stats.mode & 0o7777)
    && left.stats.nlink === right.stats.nlink;
}

function sameFileIdentity(left: Snapshot, right: Snapshot): boolean {
  return isRegular(left.stats)
    && isRegular(right.stats)
    && samePrecise(left.precise, right.precise);
}

async function snapshot(handle: FileHandle): Promise<Snapshot> {
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
    ) fail('RACE_DETECTED', 'installed lock metadata precision changed');
    return { stats, precise };
  } catch (error) {
    if (error instanceof InstalledLockReadError) throw error;
    fail('READ_FAILED', 'could not stat installed lock', error);
  }
}

function assertParent(snapshotValue: Snapshot, ownerUid: number): void {
  if (!snapshotValue.stats.isDirectory() || snapshotValue.stats.isSymbolicLink()) fail('PATH_UNSAFE', 'installation directory is not a regular directory');
  if (snapshotValue.stats.uid !== ownerUid) fail('OWNER_MISMATCH', 'installation directory owner does not match the configured UID');
  if (snapshotValue.stats.nlink < 1) fail('PATH_UNSAFE', 'installation directory has an invalid link count');
}

function assertLock(snapshotValue: Snapshot, parent: Snapshot, ownerUid: number, maxBytes: number): void {
  const stats = snapshotValue.stats;
  if (!isRegular(stats)) fail('LOCK_UNSAFE', 'installed builder lock is not a regular file');
  if (stats.uid !== ownerUid) fail('OWNER_MISMATCH', 'installed builder lock owner does not match the configured UID');
  if ((stats.mode & 0o7777) !== INSTALLED_BUILDER_LOCK_MODE || stats.nlink !== 1 || stats.dev !== parent.stats.dev) {
    fail('LOCK_UNSAFE', 'installed builder lock metadata is unsafe');
  }
  if (!Number.isSafeInteger(stats.size) || stats.size < 1 || stats.size > maxBytes) fail('SIZE_INVALID', 'installed builder lock exceeds its byte bound');
}

function stableIdentity(snapshotValue: Snapshot): InstalledLockFileIdentity {
  return Object.freeze({
    dev: snapshotValue.stats.dev,
    ino: snapshotValue.stats.ino,
    uid: snapshotValue.stats.uid,
    mode: snapshotValue.stats.mode & 0o7777,
    nlink: snapshotValue.stats.nlink,
    size: snapshotValue.stats.size,
    mtimeNs: snapshotValue.precise.mtimeNs.toString(),
    ctimeNs: snapshotValue.precise.ctimeNs.toString(),
  });
}

function parentIdentity(snapshotValue: Snapshot): InstalledLockParentIdentity {
  return Object.freeze({
    dev: snapshotValue.stats.dev,
    ino: snapshotValue.stats.ino,
    uid: snapshotValue.stats.uid,
    mode: snapshotValue.stats.mode & 0o7777,
    nlink: snapshotValue.stats.nlink,
    mtimeNs: snapshotValue.precise.mtimeNs.toString(),
    ctimeNs: snapshotValue.precise.ctimeNs.toString(),
  });
}

function canonicalText(bytes: Buffer, maxBytes: number): string {
  if (bytes.length < 1 || bytes.length > maxBytes) fail('SIZE_INVALID', 'installed builder lock exceeds its byte bound');
  let text: string;
  try {
    text = FATAL_UTF8.decode(bytes);
  } catch (error) {
    fail('JSON_INVALID', 'installed builder lock is not valid UTF-8', error);
  }
  const jsonText = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (jsonText.length === 0 || jsonText.endsWith('\n')) fail('JSON_INVALID', 'installed builder lock has invalid trailing whitespace');
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch (error) {
    fail('JSON_INVALID', 'installed builder lock is not valid JSON', error);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail('JSON_INVALID', 'installed builder lock must be a JSON object');
  let canonical: string;
  try {
    canonical = JSON.stringify(parsed);
  } catch (error) {
    fail('JSON_INVALID', 'installed builder lock cannot be canonicalized', error);
  }
  if (text !== canonical && text !== `${canonical}\n`) fail('JSON_INVALID', 'installed builder lock is not canonical JSON');
  return text;
}

async function namedLockSnapshot(directory: FileHandle): Promise<Snapshot> {
  try {
    const stats = await lstat(childPath(directory, INSTALLED_BUILDER_LOCK_NAME));
    const precise = await lstat(childPath(directory, INSTALLED_BUILDER_LOCK_NAME), { bigint: true });
    return { stats, precise };
  } catch (error) {
    mapOpenError(error, 'installed builder lock pathname');
  }
}

async function namedParentSnapshot(path: string): Promise<Snapshot> {
  try {
    const stats = await lstat(path);
    const precise = await lstat(path, { bigint: true });
    return { stats, precise };
  } catch (error) {
    mapOpenError(error, 'installation directory pathname');
  }
}

export function createInstalledLockReader(options: InstalledLockReaderOptions = {}): InstalledLockReader {
  const { ownerUid, maxBytes } = validateOptions(options);
  const hooks = options.hooks;

  return Object.freeze({
    read: async (installationDirectory: string): Promise<InstalledLockReadResult> => {
      if (typeof installationDirectory !== 'string' || !isAbsolute(installationDirectory) || installationDirectory.includes('\0')) {
        fail('CONFIG_INVALID', 'installation directory must be an absolute path');
      }
      let directory: FileHandle | undefined;
      let lock: FileHandle | undefined;
      try {
        try {
          directory = await open(installationDirectory, DIRECTORY_FLAGS);
        } catch (error) {
          mapOpenError(error, 'installation directory');
        }
        const parentBefore = await snapshot(directory);
        assertParent(parentBefore, ownerUid);
        await hooks?.afterOpenDirectory?.({ directory });

        try {
          lock = await open(childPath(directory, INSTALLED_BUILDER_LOCK_NAME), FILE_FLAGS);
        } catch (error) {
          mapOpenError(error, 'installed builder lock');
        }
        const fileBefore = await snapshot(lock);
        assertLock(fileBefore, parentBefore, ownerUid, maxBytes);

        const bytes = Buffer.alloc(fileBefore.stats.size);
        let offset = 0;
        while (offset < bytes.length) {
          let readResult;
          try {
            readResult = await lock.read(bytes, offset, bytes.length - offset, offset);
          } catch (error) {
            fail('READ_FAILED', 'could not read installed builder lock', error);
          }
          if (readResult.bytesRead <= 0 || readResult.bytesRead > bytes.length - offset) fail('RACE_DETECTED', 'installed builder lock read was incomplete');
          offset += readResult.bytesRead;
        }

        await hooks?.beforePostRead?.({ directory, lock });
        const fileAfter = await snapshot(lock);
        assertLock(fileAfter, parentBefore, ownerUid, maxBytes);
        if (!sameFileIdentity(fileBefore, fileAfter)) fail('RACE_DETECTED', 'installed builder lock changed while held');

        const namedFile = await namedLockSnapshot(directory);
        assertLock(namedFile, parentBefore, ownerUid, maxBytes);
        if (!sameFileIdentity(fileAfter, namedFile)) fail('RACE_DETECTED', 'installed builder lock pathname changed');

        await hooks?.beforeParentRevalidation?.({ directory, lock });
        const parentAfterDescriptor = await snapshot(directory);
        if (!sameParentIdentity(parentBefore, parentAfterDescriptor)) fail('RACE_DETECTED', 'installation directory descriptor changed');
        const parentAfterPathname = await namedParentSnapshot(installationDirectory);
        assertParent(parentAfterPathname, ownerUid);
        if (!sameParentIdentity(parentBefore, parentAfterPathname)) fail('RACE_DETECTED', 'installation directory pathname changed');

        const text = canonicalText(bytes, maxBytes);
        return Object.freeze({
          bytes,
          text,
          identity: Object.freeze({
            installationDirectory,
            lockPath: join(installationDirectory, INSTALLED_BUILDER_LOCK_NAME),
            parent: parentIdentity(parentBefore),
            file: stableIdentity(fileAfter),
          }),
        });
      } catch (error) {
        if (error instanceof InstalledLockReadError) throw error;
        throw new InstalledLockReadError('READ_FAILED', 'installed builder lock read failed', { cause: error });
      } finally {
        if (lock !== undefined) await lock.close().catch(() => undefined);
        if (directory !== undefined) await directory.close().catch(() => undefined);
      }
    },
  });
}
