import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';

import type { JobRecord } from '../../api/src/store.js';
import {
  FRESHNESS_PROTOCOL_MAX_BYTES,
  FRESHNESS_SOCKET_BASENAME,
  encodeFreshnessSignal,
  parseFreshnessAck,
} from '../../api/src/freshness-protocol.js';
import { canonicalInstant, normalizeJson } from '../../api/src/validation.js';
import {
  withStateRootSnapshot,
  type PathAuthorityDependencies,
  type StateRootAuthority,
} from '../../config/load.js';

const DIR_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
type FreshnessUnknownReason =
  | 'socket-unavailable'
  | 'timeout'
  | 'malformed-result'
  | 'api-error';

export type VerificationFreshnessResult =
  | Readonly<{
    status: 'fresh';
    pinnedSha: string;
    observedSha: string;
    newerSourceAvailable: false;
    checkedAt: string;
  }>
  | Readonly<{
    status: 'advanced';
    pinnedSha: string;
    observedSha: string;
    newerSourceAvailable: true;
    checkedAt: string;
  }>
  | Readonly<{
    status: 'unknown';
    pinnedSha: string;
    observedSha: null;
    newerSourceAvailable: false;
    checkedAt: string | null;
    error: Readonly<{
      code: 'FRESHNESS_UNKNOWN';
      reason: FreshnessUnknownReason;
      evidencePath?: string;
      evidenceSha256?: string;
      details?: Readonly<Record<string, unknown>>;
    }>;
  }>;

export interface FreshnessJobReader {
  readonly getJob: (jobId: string) => JobRecord;
}

export interface ApiFreshnessSocketClient {
  readonly signal: (jobId: string) => Promise<void>;
}

export interface FreshnessBoundary {
  readonly client: ApiFreshnessSocketClient;
  readonly store: FreshnessJobReader;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

function procChild(parent: FileHandle, basename: string): string {
  return join('/proc/self/fd', String(parent.fd), basename);
}

interface DirectoryBinding {
  readonly handle: FileHandle;
  readonly parent: FileHandle | null;
  readonly basename: string | null;
  readonly device: number;
  readonly inode: number;
}

async function bindDirectory(
  handle: FileHandle,
  parent: FileHandle | null,
  basename: string | null,
): Promise<DirectoryBinding> {
  const info = await handle.stat();
  if (!info.isDirectory()) throw new Error('freshness authority component is not a directory');
  return Object.freeze({
    handle,
    parent,
    basename,
    device: info.dev,
    inode: info.ino,
  });
}

async function assertDirectoryBindings(
  bindings: readonly DirectoryBinding[],
  dependencies: PathAuthorityDependencies,
): Promise<void> {
  const leaf = bindings.at(-1);
  if (!leaf) throw new Error('freshness authority has no directory bindings');
  await dependencies.beforeDirectoryAccess?.(leaf.handle);
  for (const binding of bindings) {
    const held = await binding.handle.stat();
    if (!held.isDirectory()
      || held.dev !== binding.device
      || held.ino !== binding.inode) {
      throw new Error('freshness absolute ancestor binding changed');
    }
    if (binding.parent !== null && binding.basename !== null) {
      const named = await lstat(procChild(binding.parent, binding.basename));
      if (named.isSymbolicLink()
        || !named.isDirectory()
        || named.dev !== binding.device
        || named.ino !== binding.inode) {
        throw new Error('freshness absolute ancestor binding changed');
      }
    }
  }
}

async function openStateRootChain(
  rootPath: string,
  dependencies: PathAuthorityDependencies,
  expectedDevice: number,
  expectedInode: number,
): Promise<{
  readonly root: FileHandle;
  readonly bindings: readonly DirectoryBinding[];
  readonly close: () => Promise<void>;
}> {
  const handles: FileHandle[] = [];
  const bindings: DirectoryBinding[] = [];
  try {
    if (!rootPath.startsWith('/') || resolve(rootPath) !== rootPath) {
      throw new Error('freshness state-root path is not canonical and absolute');
    }
    let current = await open('/', DIR_FLAGS);
    handles.push(current);
    bindings.push(await bindDirectory(current, null, null));
    for (const basename of rootPath.split('/').filter((segment) => segment.length > 0)) {
      await assertDirectoryBindings(bindings, dependencies);
      const next = await open(procChild(current, basename), DIR_FLAGS);
      handles.push(next);
      bindings.push(await bindDirectory(next, current, basename));
      current = next;
    }
    const stateRoot = bindings.at(-1)!;
    if (stateRoot.device !== expectedDevice || stateRoot.inode !== expectedInode) {
      throw new Error('freshness state-root identity changed');
    }
    await assertDirectoryBindings(bindings, dependencies);
    return Object.freeze({
      root: stateRoot.handle,
      bindings: Object.freeze(bindings),
      close: async () => {
        for (const handle of [...handles].reverse()) await handle.close().catch(() => undefined);
      },
    });
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
    throw new Error('freshness absolute ancestor binding could not be established', { cause: error });
  }
}

function exchangeSocket(path: string, request: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => {
      socket.destroy(new Error('freshness socket timed out'));
    }, timeoutMs);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    socket.once('error', finish);
    socket.once('connect', () => socket.end(request));
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > FRESHNESS_PROTOCOL_MAX_BYTES) {
        socket.destroy(new Error('freshness acknowledgement is too large'));
      } else {
        chunks.push(chunk);
      }
    });
    socket.once('end', () => finish());
  });
}

export function createApiFreshnessSocketClient(
  stateRoot: StateRootAuthority,
  options: { readonly timeoutMs?: number } = {},
): ApiFreshnessSocketClient {
  const timeoutMs = options.timeoutMs ?? 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new Error('freshness socket timeout is invalid');
  }
  return Object.freeze({
    signal: async (jobId: string): Promise<void> => {
      await withStateRootSnapshot(stateRoot, async ({ snapshot, dependencies }) => {
        const authority = await openStateRootChain(
          snapshot.path,
          dependencies,
          snapshot.device,
          snapshot.inode,
        );
        try {
          await assertDirectoryBindings(authority.bindings, dependencies);
          const socketPath = procChild(authority.root, FRESHNESS_SOCKET_BASENAME);
          const before = await lstat(socketPath);
          await assertDirectoryBindings(authority.bindings, dependencies);
          const expectedUid = typeof process.getuid === 'function' ? process.getuid() : before.uid;
          if (!before.isSocket()
            || before.isSymbolicLink()
            || (before.mode & 0o777) !== 0o600
            || before.uid !== expectedUid) {
            throw new Error('freshness API socket is not a mode-0600 owned socket');
          }
          const response = await exchangeSocket(
            socketPath,
            encodeFreshnessSignal(jobId),
            timeoutMs,
          );
          await assertDirectoryBindings(authority.bindings, dependencies);
          const after = await lstat(socketPath);
          await assertDirectoryBindings(authority.bindings, dependencies);
          if (!after.isSocket()
            || after.dev !== before.dev
            || after.ino !== before.ino
            || (after.mode & 0o777) !== 0o600
            || after.uid !== expectedUid) {
            throw new Error('freshness API socket identity changed');
          }
          parseFreshnessAck(response);
          await assertDirectoryBindings(authority.bindings, dependencies);
        } finally {
          await authority.close();
        }
      });
    },
  });
}

function unknown(
  pinnedSha: string,
  reason: FreshnessUnknownReason,
  extras: {
    readonly checkedAt?: string | null;
    readonly evidencePath?: string;
    readonly evidenceSha256?: string;
    readonly details?: Readonly<Record<string, unknown>>;
  } = {},
): VerificationFreshnessResult {
  return Object.freeze({
    status: 'unknown',
    pinnedSha,
    observedSha: null,
    newerSourceAvailable: false,
    checkedAt: extras.checkedAt ?? null,
    error: Object.freeze({
      code: 'FRESHNESS_UNKNOWN',
      reason,
      ...(extras.evidencePath === undefined ? {} : { evidencePath: extras.evidencePath }),
      ...(extras.evidenceSha256 === undefined ? {} : { evidenceSha256: extras.evidenceSha256 }),
      ...(extras.details === undefined ? {} : { details: extras.details }),
    }),
  });
}

function persistedResult(
  job: JobRecord,
  pinnedSha: string,
): VerificationFreshnessResult | null {
  if (job.pinnedSha !== pinnedSha) return unknown(pinnedSha, 'malformed-result');
  if (job.freshnessStatus === null) return null;
  let checkedAt: string;
  try {
    checkedAt = canonicalInstant(job.freshnessCheckedAt, 'freshness checked time');
  } catch {
    return unknown(pinnedSha, 'malformed-result');
  }
  if (job.freshnessStatus === 'fresh'
    && job.freshnessRequestedAt !== null
    && job.freshnessObservedSha === pinnedSha
    && job.newerSourceAvailable === false
    && job.freshnessErrorCode === null
    && job.freshnessError === null) {
    return Object.freeze({
      status: 'fresh',
      pinnedSha,
      observedSha: pinnedSha,
      newerSourceAvailable: false,
      checkedAt,
    });
  }
  if (job.freshnessStatus === 'advanced'
    && job.freshnessRequestedAt !== null
    && typeof job.freshnessObservedSha === 'string'
    && SHA40.test(job.freshnessObservedSha)
    && job.freshnessObservedSha !== pinnedSha
    && job.newerSourceAvailable === true
    && job.freshnessErrorCode === null
    && job.freshnessError === null) {
    return Object.freeze({
      status: 'advanced',
      pinnedSha,
      observedSha: job.freshnessObservedSha,
      newerSourceAvailable: true,
      checkedAt,
    });
  }
  if (job.freshnessStatus === 'unknown'
    && job.freshnessRequestedAt !== null
    && job.freshnessObservedSha === null
    && job.newerSourceAvailable === false
    && job.freshnessErrorCode === 'FRESHNESS_UNKNOWN'
    && job.freshnessError !== null
    && typeof job.freshnessErrorEvidencePath === 'string'
    && typeof job.freshnessErrorEvidenceSha256 === 'string'
    && SHA256.test(job.freshnessErrorEvidenceSha256)) {
    return unknown(pinnedSha, 'api-error', {
      checkedAt,
      evidencePath: job.freshnessErrorEvidencePath,
      evidenceSha256: job.freshnessErrorEvidenceSha256,
      details: normalizeJson(job.freshnessError, 'freshness error') as Readonly<Record<string, unknown>>,
    });
  }
  return unknown(pinnedSha, 'malformed-result', { checkedAt });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function requestPersistedFreshness(input: {
  readonly boundary: FreshnessBoundary;
  readonly jobId: string;
  readonly pinnedSha: string;
}): Promise<VerificationFreshnessResult> {
  const timeoutMs = input.boundary.timeoutMs ?? 2000;
  const pollIntervalMs = input.boundary.pollIntervalMs ?? 25;
  if (!SHA40.test(input.pinnedSha)
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > 30_000
    || !Number.isSafeInteger(pollIntervalMs)
    || pollIntervalMs <= 0
    || pollIntervalMs > timeoutMs) {
    return unknown(input.pinnedSha, 'malformed-result');
  }
  const read = (): VerificationFreshnessResult | null => {
    try {
      return persistedResult(input.boundary.store.getJob(input.jobId), input.pinnedSha);
    } catch {
      return unknown(input.pinnedSha, 'malformed-result');
    }
  };
  const existing = read();
  if (existing !== null) return existing;
  let signalFailed = false;
  try {
    await input.boundary.client.signal(input.jobId);
  } catch {
    signalFailed = true;
  }
  const afterSignal = read();
  if (afterSignal !== null) return afterSignal;
  if (signalFailed) return unknown(input.pinnedSha, 'socket-unavailable');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    const result = read();
    if (result !== null) return result;
  }
  return unknown(input.pinnedSha, 'timeout');
}
