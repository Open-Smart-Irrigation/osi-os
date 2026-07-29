import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const O_CLOEXEC = (fsConstants as typeof fsConstants & { readonly O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | O_CLOEXEC;
const FILE_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | O_CLOEXEC;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const PROC_FD_ROOT = '/proc/self/fd';
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;

const CONTENT_TYPES = Object.freeze<Record<string, string>>({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
});

export type StaticUiErrorCode =
  | 'STATIC_UI_ROOT_UNAVAILABLE'
  | 'STATIC_UI_ROOT_UNSAFE'
  | 'STATIC_UI_PATH_UNSAFE'
  | 'STATIC_UI_ASSET_UNSAFE';

export class StaticUiError extends Error {
  readonly code: StaticUiErrorCode;

  constructor(code: StaticUiErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StaticUiError';
    this.code = code;
  }
}

export interface StaticUiAsset {
  readonly status: 200;
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly cacheControl: string;
}

export interface StaticUiService {
  readonly resolve: (pathname: string) => Promise<StaticUiAsset | null>;
  readonly close: () => void;
}

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

function rootError(root: string, error: unknown): never {
  const code = errorCode(error);
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    throw new StaticUiError('STATIC_UI_ROOT_UNAVAILABLE', `built UI root is unavailable: ${root}`, { cause: error });
  }
  throw new StaticUiError('STATIC_UI_ROOT_UNSAFE', `built UI root is unsafe: ${root}`, { cause: error });
}

function assertDirectory(stats: Stats, field: string): void {
  if (stats.isSymbolicLink() || !stats.isDirectory() || stats.nlink < 1) {
    throw new StaticUiError('STATIC_UI_ROOT_UNSAFE', `${field} is not a safe directory`);
  }
}

function assertRegularFile(stats: Stats, field: string): void {
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new StaticUiError('STATIC_UI_ASSET_UNSAFE', `${field} is not a safe regular file`);
  }
  if (!Number.isSafeInteger(stats.size) || stats.size < 0 || stats.size > MAX_ASSET_BYTES) {
    throw new StaticUiError('STATIC_UI_ASSET_UNSAFE', `${field} exceeds the static asset size limit`);
  }
}

function procChild(fd: number, segment: string): string {
  if (!SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..') {
    throw new StaticUiError('STATIC_UI_PATH_UNSAFE', 'static UI path contains an unsafe segment');
  }
  return `${PROC_FD_ROOT}/${fd}/${segment}`;
}

function sameIdentity(before: Stats, after: Stats): boolean {
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

function pathSegments(pathname: string): readonly string[] | null {
  if (
    typeof pathname !== 'string'
    || pathname.length === 0
    || !pathname.startsWith('/')
    || pathname.startsWith('//')
    || pathname.includes('\\')
    || pathname.includes('\0')
    || pathname.includes('%')
    || pathname.includes('?')
    || pathname.includes('#')
  ) throw new StaticUiError('STATIC_UI_PATH_UNSAFE', 'static UI path is unsafe');
  if (pathname === '/') return ['index.html'];
  const segments = pathname.slice(1).split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.length === 0)) {
    throw new StaticUiError('STATIC_UI_PATH_UNSAFE', 'static UI path contains an unsafe segment');
  }
  if (pathname === '/index.html') return ['index.html'];
  if (segments[0] !== 'assets' || segments.length < 2) return null;
  for (const segment of segments) {
    if (!SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..') {
      throw new StaticUiError('STATIC_UI_PATH_UNSAFE', 'static UI path contains an unsafe segment');
    }
  }
  return segments;
}

async function close(handle: FileHandle | null): Promise<void> {
  if (handle === null) return;
  try {
    await handle.close();
  } catch (error) {
    throw new StaticUiError('STATIC_UI_ASSET_UNSAFE', 'cannot close static UI descriptor', { cause: error });
  }
}

async function readAsset(rootFd: number, segments: readonly string[]): Promise<Buffer | null> {
  let directory: FileHandle | null = null;
  let file: FileHandle | null = null;
  try {
    let parentFd = rootFd;
    for (const segment of segments.slice(0, -1)) {
      let next: FileHandle;
      try {
        next = await open(procChild(parentFd, segment), DIRECTORY_FLAGS);
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT') return null;
        throw new StaticUiError('STATIC_UI_PATH_UNSAFE', 'static UI directory cannot be opened no-follow', { cause: error });
      }
      const stats = await next.stat();
      if (!stats.isDirectory() || stats.isSymbolicLink() || stats.nlink < 1) {
        await next.close();
        throw new StaticUiError('STATIC_UI_PATH_UNSAFE', 'static UI path traverses an unsafe directory');
      }
      await close(directory);
      directory = next;
      parentFd = next.fd;
    }
    try {
      file = await open(procChild(directory?.fd ?? rootFd, segments.at(-1)!), FILE_FLAGS);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw new StaticUiError('STATIC_UI_PATH_UNSAFE', 'static UI asset cannot be opened no-follow', { cause: error });
    }
    const before = await file.stat();
    assertRegularFile(before, 'static UI asset');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await file.read(bytes, offset, bytes.byteLength - offset, offset);
      if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead <= 0 || result.bytesRead > bytes.byteLength - offset) {
        throw new StaticUiError('STATIC_UI_ASSET_UNSAFE', 'static UI asset changed during read');
      }
      offset += result.bytesRead;
    }
    const after = await file.stat();
    assertRegularFile(after, 'static UI asset');
    if (!sameIdentity(before, after)) {
      throw new StaticUiError('STATIC_UI_ASSET_UNSAFE', 'static UI asset identity changed during read');
    }
    return bytes;
  } finally {
    let failure: unknown;
    try { await close(file); } catch (error) { failure = error; }
    try { await close(directory); } catch (error) { failure ??= error; }
    if (failure !== undefined) throw failure;
  }
}

function validateStartupAsset(rootFd: number, segments: readonly string[], kind: 'file' | 'directory'): void {
  let fd: number | null = null;
  try {
    const flags = kind === 'directory' ? DIRECTORY_FLAGS : FILE_FLAGS;
    fd = openSync(procChild(rootFd, segments[0]!), flags);
    const stats = fstatSync(fd);
    if (kind === 'directory') assertDirectory(stats, 'static UI asset directory');
    else assertRegularFile(stats, 'static UI index');
  } catch (error) {
    rootError('required built UI assets', error);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function createStaticUiService(rootPath: string): StaticUiService {
  const root = resolve(rootPath);
  let rootFd: number | null = null;
  try {
    const linkStats = lstatSync(root);
    if (linkStats.isSymbolicLink()) throw new StaticUiError('STATIC_UI_ROOT_UNSAFE', 'built UI root must not be a symlink');
    assertDirectory(linkStats, 'built UI root');
    if (realpathSync(root) !== root) throw new StaticUiError('STATIC_UI_ROOT_UNSAFE', 'built UI root is not canonical');
    rootFd = openSync(root, DIRECTORY_FLAGS);
    const heldStats = fstatSync(rootFd);
    assertDirectory(heldStats, 'held built UI root');
    if (heldStats.dev !== linkStats.dev || heldStats.ino !== linkStats.ino) {
      throw new StaticUiError('STATIC_UI_ROOT_UNSAFE', 'built UI root identity changed while opening');
    }
    validateStartupAsset(rootFd, ['index.html'], 'file');
    validateStartupAsset(rootFd, ['assets'], 'directory');
  } catch (error) {
    if (rootFd !== null) closeSync(rootFd);
    if (error instanceof StaticUiError) throw error;
    return rootError(root, error);
  }

  let closed = false;
  let activeResolutions = 0;
  let descriptorClosed = false;
  const heldRootFd = rootFd;
  const closeDescriptor = (): void => {
    if (descriptorClosed) return;
    descriptorClosed = true;
    closeSync(heldRootFd);
  };
  return Object.freeze({
    async resolve(pathname: string): Promise<StaticUiAsset | null> {
      if (closed) throw new StaticUiError('STATIC_UI_ROOT_UNAVAILABLE', 'static UI service is closed');
      activeResolutions += 1;
      try {
        const segments = pathSegments(pathname);
        if (segments === null) return null;
        const contentType = CONTENT_TYPES[extname(segments.at(-1)!).toLowerCase()];
        if (contentType === undefined) return null;
        const bytes = await readAsset(heldRootFd, segments);
        if (bytes === null) return null;
        return {
          status: 200,
          bytes,
          contentType,
          cacheControl: segments[0] === 'assets'
            ? 'public, max-age=31536000, immutable'
            : 'no-store',
        };
      } finally {
        activeResolutions -= 1;
        if (closed && activeResolutions === 0) closeDescriptor();
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (activeResolutions === 0) closeDescriptor();
    },
  });
}
