import { randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import { link, lstat, open, readFile, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import {
  FRESHNESS_PROTOCOL_MAX_BYTES,
  FRESHNESS_SOCKET_BASENAME,
  handleApiFreshnessSignal,
  parseFreshnessSignal,
  type ApiFreshnessErrorEvidenceWriter,
  type ApiFreshnessProtocolStore,
  type ApiFreshnessResolver,
} from './freshness-protocol.js';
import { withStateRootSnapshot, type StateRootAuthority } from '../../config/load.js';

const DEFAULT_IDLE_TIMEOUT_MS = 5_000;
const DEFAULT_LIVENESS_TIMEOUT_MS = 250;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;
const SOCKET_MODE = 0o600;
const SOCKET_UMASK = 0o177;
const SOCKET_ANCHOR_BASENAME = '.api.sock.listener';
const LIFECYCLE_LOCK_BASENAME = '.api.lock';
const MAX_LOCK_BYTES = 512;
const O_CLOEXEC = (fsConstants as typeof fsConstants & { readonly O_CLOEXEC?: number }).O_CLOEXEC ?? 0x80000;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | O_CLOEXEC;
const LOCK_CREATE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW | O_CLOEXEC;
const LOCK_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | O_CLOEXEC;

interface ApiFreshnessServerTestHooks {
  readonly afterBindBeforeIdentity?: () => void | Promise<void>;
  readonly afterListen?: (context: {
    readonly socketPath: string;
    readonly bindingPath: string;
    readonly anchorPath: string;
    readonly anchorBindingPath: string;
    readonly created: SocketIdentity;
  }) => void | Promise<void>;
  readonly beforeLivenessProbe?: (context: {
    readonly socketPath: string;
    readonly bindingPath: string;
    readonly existing: SocketIdentity;
  }) => void | Promise<void>;
  readonly beforeUnlink?: (context: {
    readonly socketPath: string;
    readonly bindingPath: string;
    readonly expected: SocketIdentity;
  }) => void | Promise<void>;
  readonly livenessProbe?: (path: string) => Promise<'stale'>;
  readonly privateClose?: (close: () => Promise<void>) => Promise<void>;
}

export interface ApiFreshnessServerOptions {
  readonly stateRoot: StateRootAuthority;
  readonly store: ApiFreshnessProtocolStore;
  readonly resolver: ApiFreshnessResolver;
  readonly errorEvidence: ApiFreshnessErrorEvidenceWriter;
  readonly now: () => string;
  readonly idleTimeoutMs?: number;
  readonly livenessTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

export interface ApiFreshnessServer {
  readonly socketPath: string;
  readonly settled: Promise<void>;
  readonly close: () => Promise<void>;
}

export interface SocketIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
}

interface RawSocketIdentity extends SocketIdentity {
  readonly type: 'socket' | 'other';
}

interface LifecycleLock {
  readonly handle: FileHandle;
  readonly path: string;
  readonly bindingPath: string;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
}

const retainedListeners = new Set<{
  readonly server: Server;
  readonly root: FileHandle;
  readonly lifecycleLock: LifecycleLock;
}>();

class PrivateListenerCloseTimeoutError extends Error {
  readonly settled: Promise<void>;

  constructor(settled: Promise<void>) {
    super('freshness private listener shutdown timed out');
    this.name = 'PrivateListenerCloseTimeoutError';
    this.settled = settled;
  }
}

function boundedTimeout(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > MAX_TIMEOUT_MS) {
    throw new Error(`freshness ${name} is invalid`);
  }
  return result;
}

function effectiveUid(): number {
  if (typeof process.geteuid !== 'function') throw new Error('freshness effective UID is unavailable');
  const uid = process.geteuid();
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('freshness effective UID is invalid');
  return uid;
}

function procChild(parent: FileHandle, basename: string): string {
  return join('/proc/self/fd', String(parent.fd), basename);
}

function rawSocketIdentity(stats: Stats): RawSocketIdentity {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    uid: stats.uid,
    mode: stats.mode & 0o777,
    type: stats.isSocket() ? 'socket' : 'other',
  });
}

function socketIdentity(raw: RawSocketIdentity, uid: number): SocketIdentity {
  if (raw.type !== 'socket') throw new Error('freshness socket is not a Unix socket');
  if (raw.uid !== uid) throw new Error('freshness socket owner is invalid');
  if (raw.mode !== SOCKET_MODE) throw new Error('freshness socket mode is invalid');
  return Object.freeze({ dev: raw.dev, ino: raw.ino, uid: raw.uid, mode: raw.mode });
}

function sameIdentity(actual: SocketIdentity, expected: SocketIdentity): boolean {
  return actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.uid === expected.uid
    && actual.mode === expected.mode;
}

function sameRawIdentity(
  actual: RawSocketIdentity,
  expected: RawSocketIdentity,
  includeMode: boolean,
): boolean {
  return actual.type === expected.type
    && actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.uid === expected.uid
    && (!includeMode || actual.mode === expected.mode);
}

async function inspectSocket(path: string, uid: number): Promise<SocketIdentity | null> {
  try {
    return socketIdentity(rawSocketIdentity(await lstat(path)), uid);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function captureRawSocket(path: string): Promise<RawSocketIdentity | null> {
  try {
    return rawSocketIdentity(await lstat(path));
  } catch (error) {
    if (isCode(error, 'ENOENT')) return null;
    throw error;
  }
}

async function assertParentBinding(
  root: FileHandle,
  namedParent: string,
  expectedDevice: number,
  expectedInode: number,
): Promise<void> {
  const held = await root.stat();
  if (!held.isDirectory() || held.dev !== expectedDevice || held.ino !== expectedInode) {
    throw new Error('freshness state-root parent binding changed');
  }
  const named = await lstat(namedParent);
  if (!named.isDirectory() || named.isSymbolicLink() || named.dev !== expectedDevice || named.ino !== expectedInode) {
    throw new Error('freshness state-root parent binding changed');
  }
}

function isCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}

async function processStartTime(pid: number): Promise<string | null> {
  let contents: string;
  try {
    contents = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    if (isCode(error, 'ENOENT') || isCode(error, 'ESRCH')) return null;
    throw new Error('freshness lifecycle owner could not be inspected', { cause: error });
  }
  const commandEnd = contents.lastIndexOf(') ');
  if (commandEnd < 0) throw new Error('freshness lifecycle owner identity is malformed');
  const fields = contents.slice(commandEnd + 2).trim().split(/\s+/u);
  const startTime = fields[19];
  if (startTime === undefined || !/^[0-9]+$/u.test(startTime)) {
    throw new Error('freshness lifecycle owner identity is malformed');
  }
  return startTime;
}

async function currentBootId(): Promise<string> {
  let value: string;
  try {
    value = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  } catch (error) {
    throw new Error('freshness boot identity is unavailable', { cause: error });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error('freshness boot identity is malformed');
  }
  return value;
}

function lifecycleOwner(bytes: string): {
  readonly pid: number;
  readonly startTime: string;
  readonly nonce: string;
  readonly bootId: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch (error) {
    throw new Error('freshness lifecycle lock is malformed', { cause: error });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('freshness lifecycle lock is malformed');
  }
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'bootId,nonce,pid,schemaVersion,startTime'
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.pid)
    || Number(value.pid) <= 0
    || typeof value.startTime !== 'string'
    || !/^[0-9]+$/u.test(value.startTime)
    || typeof value.nonce !== 'string'
    || !/^[0-9a-f-]{36}$/u.test(value.nonce)
    || typeof value.bootId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.bootId)) {
    throw new Error('freshness lifecycle lock is malformed');
  }
  return {
    pid: Number(value.pid),
    startTime: value.startTime,
    nonce: value.nonce,
    bootId: value.bootId,
  };
}

async function existingLifecycleLock(
  root: FileHandle,
  path: string,
  bindingPath: string,
  uid: number,
  bootId: string,
): Promise<{ readonly active: boolean; readonly dev: number; readonly ino: number }> {
  const handle = await open(bindingPath, LOCK_READ_FLAGS);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.isSymbolicLink()
      || stats.uid !== uid || (stats.mode & 0o777) !== 0o600
      || !Number.isSafeInteger(stats.size) || stats.size <= 0 || stats.size > MAX_LOCK_BYTES) {
      throw new Error('freshness lifecycle lock is unsafe');
    }
    const named = await lstat(path);
    if (!named.isFile() || named.isSymbolicLink()
      || named.dev !== stats.dev || named.ino !== stats.ino
      || named.uid !== uid || (named.mode & 0o777) !== 0o600) {
      throw new Error('freshness lifecycle lock identity changed');
    }
    const owner = lifecycleOwner(await handle.readFile('utf8'));
    const observedStart = await processStartTime(owner.pid);
    return {
      active: owner.bootId === bootId
        && observedStart !== null
        && observedStart === owner.startTime,
      dev: stats.dev,
      ino: stats.ino,
    };
  } finally {
    await handle.close();
  }
}

async function acquireLifecycleLock(
  root: FileHandle,
  stateRoot: string,
  uid: number,
  allowStaleRecovery = true,
): Promise<LifecycleLock> {
  const startTime = await processStartTime(process.pid);
  if (startTime === null) throw new Error('freshness process identity is unavailable');
  const bootId = await currentBootId();
  const nonce = randomUUID();
  const temporaryBasename = `.api.lock.${process.pid}.${nonce}`;
  const temporaryPath = join(stateRoot, temporaryBasename);
  const temporaryBindingPath = procChild(root, temporaryBasename);
  const path = join(stateRoot, LIFECYCLE_LOCK_BASENAME);
  const bindingPath = procChild(root, LIFECYCLE_LOCK_BASENAME);
  const handle = await open(temporaryBindingPath, LOCK_CREATE_FLAGS, 0o600);
  let linked = false;
  let temporaryIdentity: { readonly dev: number; readonly ino: number } | undefined;
  try {
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      startTime,
      nonce,
      bootId,
    })}\n`, 'utf8');
    await handle.sync();
    const temporaryStats = await handle.stat();
    temporaryIdentity = { dev: temporaryStats.dev, ino: temporaryStats.ino };
    try {
      await link(temporaryBindingPath, bindingPath);
      linked = true;
      await root.sync();
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
      const existing = await existingLifecycleLock(root, path, bindingPath, uid, bootId);
      if (existing.active || !allowStaleRecovery) {
        throw new Error('freshness lifecycle is already owned');
      }
      const named = await lstat(path);
      if (!named.isFile() || named.dev !== existing.dev || named.ino !== existing.ino
        || named.uid !== uid || (named.mode & 0o777) !== 0o600) {
        throw new Error('freshness stale lifecycle lock identity changed');
      }
      await unlink(bindingPath);
      await root.sync();
    }
    if (!linked) {
      await handle.close();
      await unlink(temporaryBindingPath).catch(() => undefined);
      return acquireLifecycleLock(root, stateRoot, uid, false);
    }
    const stats = await handle.stat();
    if (!stats.isFile() || stats.uid !== uid || (stats.mode & 0o777) !== 0o600) {
      throw new Error('freshness lifecycle lock creation is unsafe');
    }
    await unlink(temporaryBindingPath);
    await root.sync();
    return Object.freeze({
      handle,
      path,
      bindingPath,
      dev: stats.dev,
      ino: stats.ino,
      uid: stats.uid,
      mode: stats.mode & 0o777,
    });
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryBindingPath).catch(() => undefined);
    if (linked && temporaryIdentity !== undefined) {
      const named = await lstat(path).catch(() => null);
      if (named !== null
        && named.dev === temporaryIdentity.dev
        && named.ino === temporaryIdentity.ino) {
        await unlink(bindingPath).catch(() => undefined);
        await root.sync().catch(() => undefined);
      }
    }
    throw error;
  }
}

async function releaseLifecycleLock(root: FileHandle, lock: LifecycleLock): Promise<void> {
  const held = await lock.handle.stat();
  const named = await lstat(lock.path);
  if (!held.isFile() || !named.isFile() || named.isSymbolicLink()
    || held.dev !== lock.dev || held.ino !== lock.ino
    || named.dev !== lock.dev || named.ino !== lock.ino
    || named.uid !== lock.uid || (named.mode & 0o777) !== lock.mode) {
    throw new Error('freshness lifecycle lock identity changed');
  }
  await unlink(lock.bindingPath);
  await root.sync();
  await lock.handle.close();
}

async function unlinkExactSocket(input: {
  readonly root: FileHandle;
  readonly socketPath: string;
  readonly bindingPath: string;
  readonly parentPath: string;
  readonly parentIdentity: { readonly dev: number; readonly ino: number };
  readonly expected: RawSocketIdentity;
  readonly allowModeDrift?: boolean;
  readonly beforeUnlink?: ApiFreshnessServerTestHooks['beforeUnlink'];
}): Promise<void> {
  const verify = async (): Promise<void> => {
    await assertParentBinding(input.root, input.parentPath, input.parentIdentity.dev, input.parentIdentity.ino);
    const named = await captureRawSocket(input.socketPath);
    const held = await captureRawSocket(input.bindingPath);
    if (named === null || held === null) throw new Error('freshness socket identity is missing');
    const includeMode = input.allowModeDrift !== true;
    if (!sameRawIdentity(named, input.expected, includeMode)
      || !sameRawIdentity(held, input.expected, includeMode)) {
      throw new Error('freshness socket identity changed; replacement was not unlinked');
    }
  };

  await verify();
  await input.beforeUnlink?.({
    socketPath: input.socketPath,
    bindingPath: input.bindingPath,
    expected: input.expected,
  });
  await verify();
  await unlink(input.bindingPath);
  await input.root.sync();
}

async function assertExactSocket(input: {
  readonly root: FileHandle;
  readonly namedPath: string;
  readonly bindingPath: string;
  readonly parentPath: string;
  readonly parentIdentity: { readonly dev: number; readonly ino: number };
  readonly expected: RawSocketIdentity;
}): Promise<void> {
  await assertParentBinding(
    input.root,
    input.parentPath,
    input.parentIdentity.dev,
    input.parentIdentity.ino,
  );
  const named = await captureRawSocket(input.namedPath);
  const held = await captureRawSocket(input.bindingPath);
  if (named === null || held === null
    || !sameRawIdentity(named, input.expected, true)
    || !sameRawIdentity(held, input.expected, true)) {
    throw new Error('freshness private listener identity changed');
  }
}

function connectLivenessProbe(path: string, timeoutMs: number): Promise<'stale'> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('freshness socket liveness is unknown'));
    }, timeoutMs);
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error === undefined) resolve('stale');
      else reject(error);
    };
    socket.once('connect', () => finish(new Error('freshness socket is already active')));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') finish();
      else finish(new Error('freshness socket liveness is unknown'));
    });
  });
}

async function probeLiveness(
  path: string,
  timeoutMs: number,
  probe?: (path: string) => Promise<'stale'>,
): Promise<'stale'> {
  if (probe === undefined) return connectLivenessProbe(path, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe(path),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('freshness socket liveness is unknown')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function destroySockets(sockets: ReadonlySet<Socket>): void {
  for (const socket of sockets) socket.destroy();
}

async function waitForHandlers(handlers: ReadonlySet<Promise<void>>, timeoutMs: number): Promise<void> {
  if (handlers.size === 0) return;
  const pending = Promise.all([...handlers]).then(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error('freshness handler shutdown timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function closePrivateListener(input: {
  readonly server: Server;
  readonly sockets: ReadonlySet<Socket>;
  readonly root: FileHandle;
  readonly anchorPath: string;
  readonly anchorBindingPath: string;
  readonly parentPath: string;
  readonly parentIdentity: { readonly dev: number; readonly ino: number };
  readonly expected: RawSocketIdentity;
  readonly timeoutMs: number;
  readonly allowModeDrift?: boolean;
  readonly closeOperation?: ApiFreshnessServerTestHooks['privateClose'];
}): Promise<void> {
  if (input.allowModeDrift === true) {
    await assertParentBinding(
      input.root,
      input.parentPath,
      input.parentIdentity.dev,
      input.parentIdentity.ino,
    );
    const named = await captureRawSocket(input.anchorPath);
    const held = await captureRawSocket(input.anchorBindingPath);
    if (named === null || held === null
      || !sameRawIdentity(named, input.expected, false)
      || !sameRawIdentity(held, input.expected, false)) {
      throw new Error('freshness private listener identity changed');
    }
  } else {
    await assertExactSocket({
      root: input.root,
      namedPath: input.anchorPath,
      bindingPath: input.anchorBindingPath,
      parentPath: input.parentPath,
      parentIdentity: input.parentIdentity,
      expected: input.expected,
    });
  }
  destroySockets(input.sockets);
  const nativeClose = (): Promise<void> => new Promise((resolve, reject) => {
    input.server.close((error) => error ? reject(error) : resolve());
  });
  const settled = (input.closeOperation?.(nativeClose) ?? nativeClose()).then(async () => {
    const anchor = await captureRawSocket(input.anchorBindingPath);
    if (anchor !== null) throw new Error('freshness private listener path remained after close');
    await input.root.sync();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      settled,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PrivateListenerCloseTimeoutError(settled)),
          input.timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function stopAccepting(server: Server, accepting: { value: boolean }): void {
  accepting.value = false;
  server.unref();
}

function trackHandler(
  promise: Promise<void>,
  handlers: Set<Promise<void>>,
): void {
  handlers.add(promise);
  void promise.finally(() => handlers.delete(promise)).catch(() => undefined);
}

function requestHandler(
  socket: Socket,
  accepting: { readonly value: boolean },
  sockets: Set<Socket>,
  handlers: Set<Promise<void>>,
  dependencies: Omit<ApiFreshnessServerOptions, 'stateRoot' | 'idleTimeoutMs' | 'livenessTimeoutMs' | 'shutdownTimeoutMs'>,
  idleTimeoutMs: number,
): void {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  if (!accepting.value) {
    socket.destroy();
    return;
  }
  socket.setTimeout(idleTimeoutMs, () => socket.destroy());
  const chunks: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  const rejectRequest = (): void => {
    if (settled) return;
    settled = true;
    socket.destroy();
  };
  socket.on('error', rejectRequest);
  socket.on('data', (chunk: Buffer) => {
    if (settled) return;
    bytes += chunk.byteLength;
    if (bytes > FRESHNESS_PROTOCOL_MAX_BYTES) {
      rejectRequest();
      return;
    }
    chunks.push(chunk);
  });
  socket.once('end', () => {
    if (settled || bytes === 0) {
      rejectRequest();
      return;
    }
    const request = Buffer.concat(chunks, bytes);
    try {
      parseFreshnessSignal(request);
    } catch {
      rejectRequest();
      return;
    }
    const handler = handleApiFreshnessSignal(request, dependencies).then(
      (ack) => {
        if (settled || socket.destroyed) return;
        settled = true;
        socket.end(ack);
      },
      () => rejectRequest(),
    );
    trackHandler(handler, handlers);
  });
}

async function listenWithPrivateUmask(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    const previous = process.umask(SOCKET_UMASK);
    try {
      server.listen(path);
    } finally {
      process.umask(previous);
    }
  });
}

async function closeResources(input: {
  readonly server: Server;
  readonly accepting: { value: boolean };
  readonly sockets: ReadonlySet<Socket>;
  readonly handlers: ReadonlySet<Promise<void>>;
  readonly handlerSettlement: Promise<void>;
  readonly finalized: {
    readonly resolve: () => void;
  };
  readonly root: FileHandle;
  readonly socketPath: string;
  readonly bindingPath: string;
  readonly anchorPath: string;
  readonly anchorBindingPath: string;
  readonly parentIdentity: { readonly dev: number; readonly ino: number };
  readonly created: RawSocketIdentity;
  readonly lifecycleLock: LifecycleLock;
  readonly shutdownTimeoutMs: number;
  readonly beforeUnlink?: ApiFreshnessServerTestHooks['beforeUnlink'];
  readonly privateClose?: ApiFreshnessServerTestHooks['privateClose'];
}): Promise<void> {
  stopAccepting(input.server, input.accepting);
  destroySockets(input.sockets);
  let failure: unknown;
  let handlersTimedOut = false;
  try {
    await waitForHandlers(input.handlers, input.shutdownTimeoutMs);
  } catch (error) {
    failure = error;
    handlersTimedOut = true;
  }
  try {
    await unlinkExactSocket({
      root: input.root,
      socketPath: input.socketPath,
      bindingPath: input.bindingPath,
      parentPath: input.socketPath.slice(0, input.socketPath.lastIndexOf('/')),
      parentIdentity: input.parentIdentity,
      expected: input.created,
      beforeUnlink: input.beforeUnlink,
    });
  } catch (error) {
    failure ??= error;
  }
  let listenerClosed = false;
  let listenerSettlement: Promise<void> | undefined;
  try {
    await closePrivateListener({
      server: input.server,
      sockets: input.sockets,
      root: input.root,
      anchorPath: input.anchorPath,
      anchorBindingPath: input.anchorBindingPath,
      parentPath: input.socketPath.slice(0, input.socketPath.lastIndexOf('/')),
      parentIdentity: input.parentIdentity,
      expected: input.created,
      timeoutMs: input.shutdownTimeoutMs,
      closeOperation: input.privateClose,
    });
    listenerClosed = true;
  } catch (error) {
    failure ??= error;
    if (error instanceof PrivateListenerCloseTimeoutError) {
      listenerSettlement = error.settled;
    }
  }
  const release = async (): Promise<void> => {
    await releaseLifecycleLock(input.root, input.lifecycleLock);
    await input.root.close();
  };
  if (listenerClosed) {
    if (handlersTimedOut) {
      void input.handlerSettlement.then(release).then(
        input.finalized.resolve,
        () => undefined,
      );
    } else {
      try {
        await release();
        input.finalized.resolve();
      } catch (error) {
        failure ??= error;
      }
    }
  } else if (listenerSettlement !== undefined) {
    void Promise.all([input.handlerSettlement, listenerSettlement])
      .then(release)
      .then(input.finalized.resolve, () => undefined);
  } else {
    input.server.unref();
    retainedListeners.add({
      server: input.server,
      root: input.root,
      lifecycleLock: input.lifecycleLock,
    });
  }
  if (failure !== undefined) throw failure;
}

async function createApiFreshnessServerInternal(
  options: ApiFreshnessServerOptions,
  testHooks: ApiFreshnessServerTestHooks | undefined,
): Promise<ApiFreshnessServer> {
  if (process.platform !== 'linux') throw new Error('freshness socket server requires Linux');
  const idleTimeoutMs = boundedTimeout(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 'idle timeout');
  const livenessTimeoutMs = boundedTimeout(options.livenessTimeoutMs, DEFAULT_LIVENESS_TIMEOUT_MS, 'liveness timeout');
  const shutdownTimeoutMs = boundedTimeout(options.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS, 'shutdown timeout');
  const major = Number(process.versions.node.split('.', 1)[0]);
  if (!Number.isSafeInteger(major) || major < 22) throw new Error('freshness socket server requires Node 22 or newer');
  const uid = effectiveUid();

  return withStateRootSnapshot(options.stateRoot, async ({ snapshot }) => {
    const root = await open(snapshot.path, DIRECTORY_FLAGS);
    const sockets = new Set<Socket>();
    const handlers = new Set<Promise<void>>();
    const accepting = { value: false };
    const socketPath = join(snapshot.path, FRESHNESS_SOCKET_BASENAME);
    const bindingPath = procChild(root, FRESHNESS_SOCKET_BASENAME);
    const anchorPath = join(snapshot.path, SOCKET_ANCHOR_BASENAME);
    const anchorBindingPath = procChild(root, SOCKET_ANCHOR_BASENAME);
    let server: Server | undefined;
    let created: RawSocketIdentity | undefined;
    let lifecycleLock: LifecycleLock | undefined;
    let listenerBound = false;
    try {
      const opened = await root.stat();
      if (!opened.isDirectory() || opened.dev !== snapshot.device || opened.ino !== snapshot.inode) {
        throw new Error('freshness state-root identity changed while opening');
      }
      lifecycleLock = await acquireLifecycleLock(root, snapshot.path, uid);

      const existingRaw = await captureRawSocket(bindingPath);
      if (existingRaw !== null) {
        const existing = socketIdentity(existingRaw, uid);
        const existingAnchor = await captureRawSocket(anchorBindingPath);
        if (existingAnchor !== null) {
          socketIdentity(existingAnchor, uid);
          if (!sameRawIdentity(existingAnchor, existingRaw, true)) {
            throw new Error('freshness stale listener links do not match');
          }
        }
        await testHooks?.beforeLivenessProbe?.({ socketPath, bindingPath, existing });
        await probeLiveness(
          bindingPath,
          livenessTimeoutMs,
          testHooks?.livenessProbe,
        );
        await unlinkExactSocket({
          root,
          socketPath,
          bindingPath,
          parentPath: snapshot.path,
          parentIdentity: { dev: snapshot.device, ino: snapshot.inode },
          expected: existingRaw,
          beforeUnlink: testHooks?.beforeUnlink,
        });
        if (existingAnchor !== null) {
          await unlinkExactSocket({
            root,
            socketPath: anchorPath,
            bindingPath: anchorBindingPath,
            parentPath: snapshot.path,
            parentIdentity: { dev: snapshot.device, ino: snapshot.inode },
            expected: existingAnchor,
          });
        }
      } else {
        try {
          await lstat(bindingPath);
          throw new Error('freshness socket changed during startup');
        } catch (error) {
          if (!isCode(error, 'ENOENT')) throw error;
        }
        const existingAnchor = await captureRawSocket(anchorBindingPath);
        if (existingAnchor !== null) {
          socketIdentity(existingAnchor, uid);
          await probeLiveness(
            anchorBindingPath,
            livenessTimeoutMs,
            testHooks?.livenessProbe,
          );
          await unlinkExactSocket({
            root,
            socketPath: anchorPath,
            bindingPath: anchorBindingPath,
            parentPath: snapshot.path,
            parentIdentity: { dev: snapshot.device, ino: snapshot.inode },
            expected: existingAnchor,
          });
        }
      }

      server = createServer({ allowHalfOpen: true }, (socket) => requestHandler(
        socket,
        accepting,
        sockets,
        handlers,
        {
          store: options.store,
          resolver: options.resolver,
          errorEvidence: options.errorEvidence,
          now: options.now,
        },
        idleTimeoutMs,
      ));
      await listenWithPrivateUmask(server, anchorBindingPath);
      listenerBound = true;
      await testHooks?.afterBindBeforeIdentity?.();
      // Capture the created identity before any other post-listen operation.
      const createdRaw = await captureRawSocket(anchorBindingPath);
      if (createdRaw === null) throw new Error('freshness socket disappeared during startup');
      created = createdRaw;
      const createdValidated = socketIdentity(createdRaw, uid);
      await testHooks?.afterListen?.({
        socketPath,
        bindingPath,
        anchorPath,
        anchorBindingPath,
        created: createdValidated,
      });
      await assertParentBinding(root, snapshot.path, snapshot.device, snapshot.inode);
      await link(anchorBindingPath, bindingPath);
      await root.sync();
      const named = await inspectSocket(socketPath, uid);
      const held = await inspectSocket(bindingPath, uid);
      if (named === null || held === null
        || !sameIdentity(named, createdRaw)
        || !sameIdentity(held, createdRaw)) {
        throw new Error('freshness socket parent binding changed during startup');
      }
      accepting.value = true;
      server.unref();
      let closePromise: Promise<void> | undefined;
      let settleHandlers: (() => void) | undefined;
      const settled = new Promise<void>((resolve) => {
        settleHandlers = resolve;
      });
      const handle: ApiFreshnessServer = Object.freeze({
        socketPath,
        settled,
        close: () => {
          if (closePromise === undefined) {
            const handlerSettlement = Promise.all([...handlers]).then(() => undefined);
            let resolveFinalized!: () => void;
            const finalized = new Promise<void>((resolve) => {
              resolveFinalized = resolve;
            });
            void Promise.all([handlerSettlement, finalized]).then(
              () => settleHandlers!(),
              () => undefined,
            );
            closePromise = closeResources({
              server: server!,
              accepting,
              sockets,
              handlers,
              handlerSettlement,
              finalized: { resolve: resolveFinalized },
              root,
              socketPath,
              bindingPath,
              anchorPath,
              anchorBindingPath,
              parentIdentity: { dev: snapshot.device, ino: snapshot.inode },
              created: created!,
              lifecycleLock: lifecycleLock!,
              shutdownTimeoutMs,
              beforeUnlink: testHooks?.beforeUnlink,
              privateClose: testHooks?.privateClose,
            });
          }
          return closePromise;
        },
      });
      return handle;
    } catch (error) {
      if (server !== undefined) {
        accepting.value = false;
        server.unref();
        destroySockets(sockets);
        try { await waitForHandlers(handlers, shutdownTimeoutMs); } catch { /* preserve startup error */ }
        if (created === undefined && listenerBound) {
          created = await captureRawSocket(anchorBindingPath).catch(() => null) ?? undefined;
        }
        if (created !== undefined) {
          const publicSocket = await captureRawSocket(bindingPath).catch(() => null);
          if (publicSocket !== null && sameRawIdentity(publicSocket, created, false)) {
            try {
              await unlinkExactSocket({
                root,
                socketPath,
                bindingPath,
                parentPath: snapshot.path,
                parentIdentity: { dev: snapshot.device, ino: snapshot.inode },
                expected: created,
                allowModeDrift: true,
              });
            } catch { /* preserve uncertainty; never unlink an unproven path */ }
          }
          let listenerClosed = false;
          try {
            await closePrivateListener({
              server,
              sockets,
              root,
              anchorPath,
              anchorBindingPath,
              parentPath: snapshot.path,
              parentIdentity: { dev: snapshot.device, ino: snapshot.inode },
              expected: created,
              timeoutMs: shutdownTimeoutMs,
              allowModeDrift: true,
            });
            listenerClosed = true;
          } catch { /* preserve startup error */ }
          if (listenerClosed) {
            if (lifecycleLock !== undefined) {
              await releaseLifecycleLock(root, lifecycleLock).catch(() => undefined);
            }
            await root.close().catch(() => undefined);
          } else if (lifecycleLock !== undefined) {
            retainedListeners.add({ server, root, lifecycleLock });
          }
        } else if (listenerBound && lifecycleLock !== undefined) {
          retainedListeners.add({ server, root, lifecycleLock });
        } else {
          if (lifecycleLock !== undefined) {
            await releaseLifecycleLock(root, lifecycleLock).catch(() => undefined);
          }
          await root.close().catch(() => undefined);
        }
      } else {
        if (lifecycleLock !== undefined) {
          await releaseLifecycleLock(root, lifecycleLock).catch(() => undefined);
        }
        await root.close().catch(() => undefined);
      }
      throw error;
    }
  });
}

export function createApiFreshnessServer(
  options: ApiFreshnessServerOptions,
): Promise<ApiFreshnessServer> {
  return createApiFreshnessServerInternal(options, undefined);
}

export function createApiFreshnessServerForTest(
  options: ApiFreshnessServerOptions,
  testHooks: ApiFreshnessServerTestHooks,
): Promise<ApiFreshnessServer> {
  return createApiFreshnessServerInternal(options, Object.freeze({ ...testHooks }));
}

export const startApiFreshnessServer = createApiFreshnessServer;
