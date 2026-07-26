import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import type { Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readlink,
  readdir,
  symlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  withStateRootSnapshot,
  type PathAuthorityDependencies,
  type StateRootAuthority,
} from '../../config/load.js';
import { BuilderError, type BuilderErrorCode } from '../../domain/errors.js';
import type { TargetManifest } from '../../manifest/schema.js';
import {
  enforceOpenWrtRustFeed,
  OPENWRT_RUST_FEED_CONTRACT,
} from '../../builder/validate-rust-toolchain.js';
import {
  createOperationDefinition,
  type OperationDefinition,
} from './operation-registry.js';
import type { CommandResult } from './command-executor.js';
import type { EvidencePublication, EvidenceWriter } from './evidence.js';
import type {
  ApiPreparedFeed,
  OfflineFeedPreparation,
} from '../../api/src/git/source-resolver.js';
import { hashRecursiveSubmoduleAttestation } from '../../api/src/git/source-resolver.js';

export type {
  ApiPreparedFeed,
  OfflineFeedPreparation,
} from '../../api/src/git/source-resolver.js';

export const ROOTFS_PADDING_PATCH = 'image-with-padded-rootfs.patch';
export const APPROVED_ROOTFS_SCRIPT_SHA256 = 'c1a646a136a4ccd3ddd279ec8d861c8c1768ab4a9b2cdbe8a681ab6fb9310817';

const PACKAGES_COMMIT = OPENWRT_RUST_FEED_CONTRACT.sourceCommit;
const REQUIRED_LINKS = Object.freeze(['node-red', 'node-red-contrib-chirpstack', 'node-red-node-sqlite', 'chirpstack'] as const);
const TARGET_SETUP_OPERATIONS = Object.freeze(['activate-target', 'copy-feed-config', 'update-feeds', 'install-feeds', 'resolve-config'] as const);
const PROC_FD = '/proc/self/fd';
const DIR_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const WRITE_FLAGS = fsConstants.O_RDWR | fsConstants.O_NOFOLLOW;
const CREATE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const HTTPS_FEED = /^https:\/\/[^\s^]+$/u;

export type TargetSetupOperationId = (typeof TARGET_SETUP_OPERATIONS)[number];

export interface HeldWorkspaceCapability {
  readonly descriptorPath: string;
  readonly device: number;
  readonly inode: number;
  readonly containerWorkingDirectory: '/workdir';
}

export class TargetSetupError extends BuilderError {
  constructor(
    code: BuilderErrorCode,
    message: string,
    requestId: string,
    details: Record<string, string | number | boolean | null> = {},
    operationId?: TargetSetupOperationId,
  ) {
    super({
      code,
      stage: code === 'FEED_INSTALL_FAILED' || code === 'FEED_LINKS_MISSING'
        ? 'feeds'
        : code === 'TARGET_CONFIG_MISMATCH'
          ? 'config'
          : 'target-setup',
      details,
      retryable: code === 'FEED_INSTALL_FAILED',
      requestId,
      diagnosis: message,
      recovery: code === 'RUST_BOOTSTRAP_UNAVAILABLE'
        ? 'Restore the API-prepared pinned packages feed and supported LLVM-backed Rust configuration.'
        : 'Inspect the target-setup evidence and create a new job from the corrected pinned source.',
      operationId,
    });
    this.name = 'TargetSetupError';
  }
}

export interface LockedTargetSetupOperations {
  readonly run: (
    operationId: TargetSetupOperationId,
    definition: OperationDefinition,
    workspace: HeldWorkspaceCapability,
  ) => Promise<CommandResult>;
}

export interface TargetSetupCommandRequest {
  readonly operationId: TargetSetupOperationId;
  readonly definition: OperationDefinition;
  readonly cwd: string;
  readonly containerWorkingDirectory: '/workdir';
  readonly workspaceIdentity: {
    readonly device: number;
    readonly inode: number;
  };
  readonly network: 'none';
}

export type TargetSetupCommandExecutor = (request: TargetSetupCommandRequest) => Promise<CommandResult>;

const LOCKED_OPERATION_ADAPTERS = new WeakSet<object>();

export function createLockedTargetSetupOperations(execute: TargetSetupCommandExecutor): LockedTargetSetupOperations {
  if (typeof execute !== 'function') throw new TypeError('target setup command executor is required');
  const operations: LockedTargetSetupOperations = Object.freeze({
    run(
      operationId: TargetSetupOperationId,
      definition: OperationDefinition,
      workspace: HeldWorkspaceCapability,
    ) {
      return execute(Object.freeze({
        operationId,
        definition,
        cwd: workspace.descriptorPath,
        containerWorkingDirectory: workspace.containerWorkingDirectory,
        workspaceIdentity: Object.freeze({
          device: workspace.device,
          inode: workspace.inode,
        }),
        network: 'none' as const,
      }));
    },
  });
  LOCKED_OPERATION_ADAPTERS.add(operations);
  return operations;
}

export interface RootfsPatchStateInput {
  readonly series: readonly string[];
  readonly applied: readonly string[];
  readonly output: string;
  readonly rootfsScript: string;
}

export type RootfsPatchDecision = 'applied' | 'already-present';

interface HeldDirectory {
  readonly handle: FileHandle;
  readonly parent: HeldDirectory | null;
  readonly name: string | null;
  readonly relativePath: string;
}

interface PreparedFeedAuthority {
  readonly record: ApiPreparedFeed;
  readonly directory: HeldDirectory;
}

interface PinnedGitFeed {
  readonly name: string;
  readonly location: string;
  readonly commit: string;
}

interface ProfileResolution {
  readonly target: TargetManifest['id'];
  readonly environment: string;
  readonly selectedTarget: string;
  readonly profile: string;
  readonly rootfsPartSize: number;
  readonly sourceSha256: string;
  readonly sourceConfigEvidencePath: string;
  readonly resolvedSha256: string;
  readonly patchDecision: RootfsPatchDecision;
}

interface FeedResolution {
  readonly sourceSha256: string;
  readonly destinationSha256: string;
  readonly localPath: string;
  readonly packagesCommit: string;
  readonly installedPackages: readonly string[];
  readonly prepared: readonly {
    readonly name: string;
    readonly commit: string;
    readonly sourceTreeSha256: string;
    readonly destinationTreeSha256: string;
  }[];
}

interface RustResolution {
  readonly sourceSha256: string;
  readonly enforcedSha256: string;
  readonly path: string;
  readonly sourceCommit: string;
  readonly hostTriple: string;
}

function fail(
  code: BuilderErrorCode,
  message: string,
  requestId: string,
  details: Record<string, string | number | boolean | null> = {},
  operationId?: TargetSetupOperationId,
): never {
  throw new TargetSetupError(code, message, requestId, details, operationId);
}

function sha256(contents: Buffer | string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function fdPath(parent: FileHandle, name?: string): string {
  return name === undefined ? join(PROC_FD, String(parent.fd)) : join(PROC_FD, String(parent.fd), name);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function safeSegment(value: string, requestId: string, code: BuilderErrorCode, label: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value) > 255
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || /[\0-\x1f\x7f]/u.test(value)
  ) {
    fail(code, `${label} is not a safe path segment.`, requestId, { value });
  }
  return value;
}

function assertJobId(jobId: string, requestId: string): string {
  if (!SAFE_IDENTIFIER.test(jobId)) fail('WORKTREE_CREATE_FAILED', 'The API-issued job ID is not a canonical path segment.', requestId, { value: jobId });
  return jobId;
}

async function closeHandles(handles: FileHandle[]): Promise<void> {
  for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
}

async function openBoundDirectory(
  parent: HeldDirectory,
  name: string,
  dependencies: PathAuthorityDependencies,
  requestId: string,
  code: BuilderErrorCode,
  diagnosis: string,
): Promise<HeldDirectory> {
  safeSegment(name, requestId, code, 'A target-setup path component');
  try {
    await dependencies.beforeDirectoryAccess?.(parent.handle);
    const handle = await open(fdPath(parent.handle, name), DIR_FLAGS);
    const stats = await handle.stat();
    if (!stats.isDirectory()) {
      await handle.close();
      fail(code, diagnosis, requestId, { path: parent.relativePath.length === 0 ? name : `${parent.relativePath}/${name}` });
    }
    const directory = {
      handle,
      parent,
      name,
      relativePath: parent.relativePath.length === 0 ? name : `${parent.relativePath}/${name}`,
    };
    await assertDirectoryBinding(directory, dependencies, requestId, code, diagnosis);
    return directory;
  } catch (error) {
    if (error instanceof BuilderError) throw error;
    fail(code, diagnosis, requestId, {
      path: parent.relativePath.length === 0 ? name : `${parent.relativePath}/${name}`,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function assertDirectoryBinding(
  directory: HeldDirectory,
  dependencies: PathAuthorityDependencies,
  requestId: string,
  code: BuilderErrorCode,
  diagnosis: string,
): Promise<void> {
  if (directory.parent === null || directory.name === null) return;
  let current: FileHandle | undefined;
  try {
    await dependencies.beforeDirectoryAccess?.(directory.parent.handle);
    current = await open(fdPath(directory.parent.handle, directory.name), DIR_FLAGS);
    const [heldStats, currentStats] = await Promise.all([directory.handle.stat(), current.stat()]);
    if (!heldStats.isDirectory() || !currentStats.isDirectory() || !sameIdentity(heldStats, currentStats)) {
      fail(code, diagnosis, requestId, { path: directory.relativePath });
    }
  } catch (error) {
    if (error instanceof BuilderError) throw error;
    fail(code, diagnosis, requestId, {
      path: directory.relativePath,
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await current?.close().catch(() => undefined);
  }
}

async function assertBindings(
  directories: readonly HeldDirectory[],
  dependencies: PathAuthorityDependencies,
  requestId: string,
): Promise<void> {
  for (const directory of directories) {
    const code = directory.relativePath.includes('prepared-feeds/packages')
      ? 'RUST_BOOTSTRAP_UNAVAILABLE'
      : directory.relativePath.includes('prepared-feeds') || directory.relativePath.endsWith('feeds/chirpstack-openwrt-feed')
        ? 'FEED_INSTALL_FAILED'
        : 'WORKTREE_CREATE_FAILED';
    await assertDirectoryBinding(
      directory,
      dependencies,
      requestId,
      code,
      'A held target-setup authority binding changed during the stage.',
    );
  }
}

async function openDirectoryPath(
  root: HeldDirectory,
  segments: readonly string[],
  dependencies: PathAuthorityDependencies,
  requestId: string,
  code: BuilderErrorCode,
  diagnosis: string,
): Promise<{ readonly directory: HeldDirectory; readonly handles: FileHandle[] }> {
  const handles: FileHandle[] = [];
  let current = root;
  try {
    for (const segment of segments) {
      current = await openBoundDirectory(current, segment, dependencies, requestId, code, diagnosis);
      handles.push(current.handle);
    }
    return { directory: current, handles };
  } catch (error) {
    await closeHandles(handles);
    throw error;
  }
}

async function openAbsoluteDirectoryChain(
  absolutePath: string,
  dependencies: PathAuthorityDependencies,
  requestId: string,
): Promise<{
  readonly directory: HeldDirectory;
  readonly handles: readonly FileHandle[];
  readonly bindings: readonly HeldDirectory[];
}> {
  if (!absolutePath.startsWith('/') || absolutePath.includes('\0')) {
    fail('WORKTREE_CREATE_FAILED', 'The configured state root path is not canonical.', requestId);
  }
  const handles: FileHandle[] = [];
  const bindings: HeldDirectory[] = [];
  let current: HeldDirectory;
  try {
    const rootHandle = await open('/', DIR_FLAGS);
    handles.push(rootHandle);
    current = { handle: rootHandle, parent: null, name: null, relativePath: '' };
    for (const segment of absolutePath.split('/').filter(Boolean)) {
      current = await openBoundDirectory(
        current,
        segment,
        dependencies,
        requestId,
        'WORKTREE_CREATE_FAILED',
        'The configured state-root parent chain is unavailable, replaced, or symlinked.',
      );
      handles.push(current.handle);
      bindings.push(current);
    }
    return { directory: current, handles, bindings };
  } catch (error) {
    await closeHandles(handles);
    throw error;
  }
}

async function readHandle(handle: FileHandle): Promise<Buffer> {
  const stats = await handle.stat();
  if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size < 0) throw new Error('held entry is not a bounded regular file');
  const contents = Buffer.alloc(stats.size);
  let offset = 0;
  while (offset < contents.length) {
    const read = await handle.read(contents, offset, contents.length - offset, offset);
    if (read.bytesRead === 0) throw new Error('held file ended before its inspected size');
    offset += read.bytesRead;
  }
  const after = await handle.stat();
  if (!sameIdentity(stats, after) || stats.size !== after.size) throw new Error('held file changed while it was read');
  return contents;
}

async function openRegularFile(
  parent: HeldDirectory,
  name: string,
  flags: number,
  dependencies: PathAuthorityDependencies,
  requestId: string,
  code: BuilderErrorCode,
  diagnosis: string,
): Promise<{ readonly handle: FileHandle; readonly stats: Stats }> {
  safeSegment(name, requestId, code, 'A target-setup filename');
  let handle: FileHandle | undefined;
  try {
    handle = await open(fdPath(parent.handle, name), flags);
    const stats = await handle.stat();
    if (!stats.isFile()) fail(code, diagnosis, requestId, { path: `${parent.relativePath}/${name}` });
    await dependencies.beforeRead(handle);
    return { handle, stats };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof BuilderError) throw error;
    fail(code, diagnosis, requestId, {
      path: `${parent.relativePath}/${name}`,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function assertFileBinding(
  parent: HeldDirectory,
  name: string,
  held: FileHandle,
  expected: Stats,
  requestId: string,
  code: BuilderErrorCode,
  diagnosis: string,
): Promise<void> {
  let current: FileHandle | undefined;
  try {
    current = await open(fdPath(parent.handle, name), READ_FLAGS);
    const [heldStats, currentStats] = await Promise.all([held.stat(), current.stat()]);
    if (!heldStats.isFile() || !currentStats.isFile() || !sameIdentity(heldStats, currentStats) || !sameIdentity(expected, heldStats)) {
      fail(code, diagnosis, requestId, { path: `${parent.relativePath}/${name}` });
    }
  } catch (error) {
    if (error instanceof BuilderError) throw error;
    fail(code, diagnosis, requestId, {
      path: `${parent.relativePath}/${name}`,
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await current?.close().catch(() => undefined);
  }
}

async function readRegularFile(
  parent: HeldDirectory,
  name: string,
  dependencies: PathAuthorityDependencies,
  requestId: string,
  code: BuilderErrorCode,
  diagnosis: string,
): Promise<Buffer> {
  const opened = await openRegularFile(parent, name, READ_FLAGS, dependencies, requestId, code, diagnosis);
  try {
    const contents = await readHandle(opened.handle);
    await assertFileBinding(parent, name, opened.handle, opened.stats, requestId, code, diagnosis);
    return contents;
  } catch (error) {
    if (error instanceof BuilderError) throw error;
    fail(code, diagnosis, requestId, {
      path: `${parent.relativePath}/${name}`,
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

async function readTextFile(
  parent: HeldDirectory,
  name: string,
  dependencies: PathAuthorityDependencies,
  requestId: string,
  code: BuilderErrorCode,
  diagnosis: string,
): Promise<string> {
  return (await readRegularFile(parent, name, dependencies, requestId, code, diagnosis)).toString('utf8');
}

async function readTextPath(
  root: HeldDirectory,
  segments: readonly string[],
  dependencies: PathAuthorityDependencies,
  requestId: string,
  code: BuilderErrorCode,
  diagnosis: string,
): Promise<string> {
  const parent = await openDirectoryPath(root, segments.slice(0, -1), dependencies, requestId, code, diagnosis);
  try {
    return await readTextFile(parent.directory, segments.at(-1)!, dependencies, requestId, code, diagnosis);
  } finally {
    await closeHandles(parent.handles);
  }
}

async function readLink(
  parent: HeldDirectory,
  name: string,
  requestId: string,
  code: BuilderErrorCode,
  diagnosis: string,
): Promise<string> {
  const path = fdPath(parent.handle, name);
  try {
    const before = await lstat(path);
    if (!before.isSymbolicLink()) fail(code, diagnosis, requestId, { path: `${parent.relativePath}/${name}` });
    const target = await readlink(path);
    const after = await lstat(path);
    if (!after.isSymbolicLink() || !sameIdentity(before, after)) fail(code, diagnosis, requestId, { path: `${parent.relativePath}/${name}` });
    return target;
  } catch (error) {
    if (error instanceof BuilderError) throw error;
    fail(code, diagnosis, requestId, {
      path: `${parent.relativePath}/${name}`,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function validPatchPath(value: string): boolean {
  return (
    value.length > 0
    && value.length <= 1024
    && !value.startsWith('/')
    && !value.includes('\\')
    && !/[\0-\x20\x7f]/u.test(value)
    && value.endsWith('.patch')
    && value.split('/').every((segment) => (
      segment.length > 0
      && segment !== '.'
      && segment !== '..'
      && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(segment)
    ))
  );
}

function parsePatchNames(lines: readonly string[]): string[] | null {
  const names: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (!validPatchPath(line)) return null;
    names.push(line);
  }
  const basenames = names.map((name) => posix.basename(name));
  if (new Set(names).size !== names.length || new Set(basenames).size !== basenames.length) return null;
  return names;
}

function hasExactList(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function reversedPatchAttributions(
  output: string,
  series: readonly string[],
): readonly string[] | null {
  const attributions: string[] = [];
  let applyingPatch: string | null = null;
  let applyingIndex = -1;
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const applying = /^Applying(?: patch)? ([^\s]+)$/u.exec(line);
    if (applying) {
      const path = applying[1]!;
      const index = series.indexOf(path);
      if (!validPatchPath(path) || index < 0 || index <= applyingIndex) return null;
      applyingPatch = path;
      applyingIndex = index;
      continue;
    }
    if (/^Applying\b/u.test(line)) return null;
    if (!/revers(?:ed|e)|previously applied/iu.test(line)) continue;
    const reversed = /^Reversed \(or previously applied\) patch detected: ([^\s]+)$/u.exec(line);
    if (!reversed || applyingPatch === null) return null;
    const path = reversed[1]!;
    if (!validPatchPath(path) || !series.includes(path) || path !== applyingPatch) return null;
    attributions.push(path);
  }
  return Object.freeze(attributions);
}

export function decideRootfsPatchState(input: RootfsPatchStateInput, requestId = 'target-setup'): RootfsPatchDecision {
  const series = parsePatchNames(input.series);
  const applied = parsePatchNames(input.applied);
  if (
    series === null
    || applied === null
    || series.length === 0
    || !series.includes(ROOTFS_PADDING_PATCH)
    || sha256(input.rootfsScript) !== APPROVED_ROOTFS_SCRIPT_SHA256
  ) {
    fail('PATCH_STATE_AMBIGUOUS', 'The rootfs padding patch series or implementation hash is not approved.', requestId);
  }
  const reversed = reversedPatchAttributions(input.output, series);
  if (reversed === null) {
    fail('PATCH_STATE_AMBIGUOUS', 'OpenWrt patch output cannot be bound to the exact ordered patch series.', requestId);
  }
  const expectedApplied = series.filter((patch) => patch !== ROOTFS_PADDING_PATCH);
  if (reversed.length === 1 && reversed[0] === ROOTFS_PADDING_PATCH && hasExactList(applied, expectedApplied)) return 'already-present';
  if (reversed.length > 0) {
    fail('PATCH_STATE_AMBIGUOUS', 'OpenWrt reported an unapproved reverse-applicable patch state.', requestId, { patch: ROOTFS_PADDING_PATCH });
  }
  if (hasExactList(applied, series)) return 'applied';
  fail('PATCH_STATE_AMBIGUOUS', 'OpenWrt reported an incomplete rootfs patch stack.', requestId, { patch: ROOTFS_PADDING_PATCH });
}

function parseFeedConfig(contents: string, requestId: string): {
  readonly gitFeeds: readonly PinnedGitFeed[];
  readonly chirpstackLocation: string;
} {
  const names = new Set<string>();
  const gitFeeds: PinnedGitFeed[] = [];
  let chirpstackLocation: string | undefined;
  for (const raw of contents.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const parts = line.split(/\s+/u);
    if (parts.length !== 3 || !SAFE_IDENTIFIER.test(parts[1]!)) fail('FEED_INSTALL_FAILED', 'The pinned feed configuration contains a malformed entry.', requestId);
    const [type, name, location] = parts as [string, string, string];
    if (names.has(name)) fail('FEED_INSTALL_FAILED', 'The pinned feed configuration contains duplicate feed names.', requestId, { feed: name });
    names.add(name);
    if (type === 'src-git') {
      const match = /^(https:\/\/[^\s^]+)\^([0-9a-f]{40})$/u.exec(location);
      if (!match) fail('FEED_INSTALL_FAILED', 'Every Git feed must be HTTPS and pinned to one exact commit.', requestId, { feed: name });
      gitFeeds.push({ name, location: match[1]!, commit: match[2]! });
    } else if (type === 'src-link' && name === 'chirpstack') {
      chirpstackLocation = location;
    } else {
      fail('FEED_INSTALL_FAILED', 'The pinned feed configuration contains an unsupported feed entry.', requestId, { feed: name, type });
    }
  }
  if (chirpstackLocation !== 'feeds/chirpstack-openwrt-feed') {
    fail('FEED_INSTALL_FAILED', 'The feed configuration does not contain the exact worktree-local ChirpStack feed.', requestId, { entry: chirpstackLocation ?? null });
  }
  const packages = gitFeeds.find((feed) => feed.name === 'packages');
  if (packages?.commit !== PACKAGES_COMMIT) {
    fail('RUST_BOOTSTRAP_UNAVAILABLE', 'The packages feed is not pinned to the approved Rust contract commit.', requestId, { expectedCommit: PACKAGES_COMMIT });
  }
  return { gitFeeds, chirpstackLocation };
}

function validatePreparedInput(
  preparation: OfflineFeedPreparation,
  feeds: readonly PinnedGitFeed[],
  jobId: string,
  sourceSha: string,
  requestId: string,
): ReadonlyMap<string, ApiPreparedFeed> {
  if (
    !preparation
    || Object.keys(preparation).sort().join(',') !== 'boundary,feeds,jobId,networkPolicy,preparedAt,schemaVersion,sourceSha'
    || preparation.schemaVersion !== 1
    || preparation.boundary !== 'api-prepared-pinned-feeds-v1'
    || preparation.networkPolicy !== 'runner-offline'
    || preparation.jobId !== jobId
    || preparation.sourceSha !== sourceSha
    || !SHA40.test(preparation.sourceSha)
    || !isCanonicalInstant(preparation.preparedAt)
    || !Array.isArray(preparation.feeds)
  ) {
    fail('FEED_INSTALL_FAILED', 'The API-prepared offline feed handoff is invalid.', requestId);
  }
  const records = new Map<string, ApiPreparedFeed>();
  for (const candidate of preparation.feeds as readonly unknown[]) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      fail('FEED_INSTALL_FAILED', 'An API-prepared feed attestation is invalid.', requestId);
    }
    const record = candidate as ApiPreparedFeed;
    const keys = Object.keys(record).sort();
    if (
      keys.join(',') !== 'clean,commit,detached,location,name,recursiveSubmoduleStatusSha256,recursiveSubmodules,recursiveSubmodulesPrepared,treeSha256'
      || !SAFE_IDENTIFIER.test(record.name)
      || !HTTPS_FEED.test(record.location)
      || !SHA40.test(record.commit)
      || !SHA256.test(record.treeSha256)
      || !SHA256.test(record.recursiveSubmoduleStatusSha256)
      || record.detached !== true
      || record.clean !== true
      || record.recursiveSubmodulesPrepared !== true
      || !Array.isArray(record.recursiveSubmodules)
      || record.recursiveSubmodules.some((submodule: ApiPreparedFeed['recursiveSubmodules'][number]) => (
        !submodule
        || typeof submodule !== 'object'
        || Array.isArray(submodule)
        || Object.keys(submodule).sort().join(',') !== 'commit,path'
        || !SHA40.test(submodule.commit)
        || submodule.path.split('/').some((part: string) => part.length === 0 || part === '.' || part === '..')
      ))
      || new Set(record.recursiveSubmodules.map(({ path }: ApiPreparedFeed['recursiveSubmodules'][number]) => path)).size !== record.recursiveSubmodules.length
      || record.recursiveSubmoduleStatusSha256 !== hashRecursiveSubmoduleAttestation(record.recursiveSubmodules)
      || records.has(record.name)
    ) {
      fail(record.name === 'packages' ? 'RUST_BOOTSTRAP_UNAVAILABLE' : 'FEED_INSTALL_FAILED', 'An API-prepared feed attestation is invalid.', requestId, { feed: record.name ?? null });
    }
    records.set(record.name, record);
  }
  if (records.size !== feeds.length) fail('FEED_INSTALL_FAILED', 'The API-prepared feed set does not exactly cover the pinned Git feeds.', requestId);
  for (const feed of feeds) {
    const record = records.get(feed.name);
    if (!record || record.location !== feed.location || record.commit !== feed.commit) {
      fail(feed.name === 'packages' ? 'RUST_BOOTSTRAP_UNAVAILABLE' : 'FEED_INSTALL_FAILED', 'An API-prepared feed does not match the pinned feed entry.', requestId, { feed: feed.name });
    }
  }
  return records;
}

function assertSafeTreeSymlink(target: string, relativePath: string, requestId: string, code: BuilderErrorCode): void {
  if (target.length === 0 || target.includes('\0') || posix.isAbsolute(target)) {
    fail(code, 'A prepared feed contains an unsafe symbolic link.', requestId, { path: relativePath });
  }
  const resolvedTarget = posix.resolve('/prepared-feed', posix.dirname(relativePath), target);
  if (resolvedTarget !== '/prepared-feed' && !resolvedTarget.startsWith('/prepared-feed/')) {
    fail(code, 'A prepared feed symbolic link escapes its feed tree.', requestId, { path: relativePath });
  }
}

async function hashFeedTree(
  directory: HeldDirectory,
  dependencies: PathAuthorityDependencies,
  requestId: string,
  code: BuilderErrorCode,
): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (current: HeldDirectory, prefix: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(fdPath(current.handle));
    } catch (error) {
      fail(code, 'An API-prepared feed tree cannot be enumerated.', requestId, { path: current.relativePath, cause: error instanceof Error ? error.message : String(error) });
    }
    entries.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    for (const name of entries) {
      safeSegment(name, requestId, code, 'A prepared feed entry');
      const relativePath = prefix.length === 0 ? name : `${prefix}/${name}`;
      let stats: Stats;
      try {
        stats = await lstat(fdPath(current.handle, name));
      } catch (error) {
        fail(code, 'An API-prepared feed entry cannot be inspected.', requestId, { path: relativePath, cause: error instanceof Error ? error.message : String(error) });
      }
      if (stats.isDirectory()) {
        hash.update(`D\0${relativePath}\0${stats.mode & 0o777}\0`);
        const child = await openBoundDirectory(current, name, dependencies, requestId, code, 'A prepared feed directory is unsafe or changed.');
        try {
          await visit(child, relativePath);
          await assertDirectoryBinding(child, dependencies, requestId, code, 'A prepared feed directory changed during hashing.');
        } finally {
          await child.handle.close().catch(() => undefined);
        }
      } else if (stats.isFile()) {
        hash.update(`F\0${relativePath}\0${stats.mode & 0o777}\0`);
        const contents = await readRegularFile(current, name, dependencies, requestId, code, 'A prepared feed file is unsafe or changed.');
        hash.update(contents);
        hash.update('\0');
      } else if (stats.isSymbolicLink()) {
        const target = await readLink(current, name, requestId, code, 'A prepared feed symbolic link is unsafe or changed.');
        assertSafeTreeSymlink(target, relativePath, requestId, code);
        hash.update(`L\0${relativePath}\0${target}\0`);
      } else {
        fail(code, 'A prepared feed contains an unsupported filesystem entry.', requestId, { path: relativePath });
      }
    }
  };
  await visit(directory, '');
  return hash.digest('hex');
}

async function createDirectoryAt(
  parent: HeldDirectory,
  name: string,
  mode: number,
  dependencies: PathAuthorityDependencies,
  requestId: string,
): Promise<HeldDirectory> {
  safeSegment(name, requestId, 'FEED_INSTALL_FAILED', 'A feed destination path component');
  try {
    await mkdir(fdPath(parent.handle, name), { mode });
    const directory = await openBoundDirectory(parent, name, dependencies, requestId, 'FEED_INSTALL_FAILED', 'A feed destination directory is unsafe.');
    await directory.handle.chmod(mode & 0o777);
    return directory;
  } catch (error) {
    if (error instanceof BuilderError) throw error;
    fail('FEED_INSTALL_FAILED', 'A feed destination directory already exists or cannot be created safely.', requestId, {
      path: `${parent.relativePath}/${name}`,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function copyFeedTree(
  source: HeldDirectory,
  destination: HeldDirectory,
  dependencies: PathAuthorityDependencies,
  requestId: string,
  prefix = '',
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(fdPath(source.handle));
  } catch (error) {
    fail('FEED_INSTALL_FAILED', 'An API-prepared feed tree cannot be copied.', requestId, { path: source.relativePath, cause: error instanceof Error ? error.message : String(error) });
  }
  entries.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  for (const name of entries) {
    safeSegment(name, requestId, 'FEED_INSTALL_FAILED', 'A prepared feed entry');
    const relativePath = prefix.length === 0 ? name : `${prefix}/${name}`;
    let stats: Stats;
    try {
      stats = await lstat(fdPath(source.handle, name));
    } catch (error) {
      fail('FEED_INSTALL_FAILED', 'An API-prepared feed entry cannot be inspected for copying.', requestId, { path: relativePath, cause: error instanceof Error ? error.message : String(error) });
    }
    if (stats.isDirectory()) {
      const sourceChild = await openBoundDirectory(source, name, dependencies, requestId, 'FEED_INSTALL_FAILED', 'A prepared feed directory changed during copying.');
      const destinationChild = await createDirectoryAt(destination, name, stats.mode, dependencies, requestId);
      try {
        await copyFeedTree(sourceChild, destinationChild, dependencies, requestId, relativePath);
        await assertDirectoryBinding(sourceChild, dependencies, requestId, 'FEED_INSTALL_FAILED', 'A prepared feed directory changed during copying.');
      } finally {
        await destinationChild.handle.close().catch(() => undefined);
        await sourceChild.handle.close().catch(() => undefined);
      }
    } else if (stats.isFile()) {
      const contents = await readRegularFile(source, name, dependencies, requestId, 'FEED_INSTALL_FAILED', 'A prepared feed file changed during copying.');
      let destinationFile: FileHandle | undefined;
      try {
        destinationFile = await open(fdPath(destination.handle, name), CREATE_FLAGS, stats.mode & 0o777);
        await destinationFile.chmod(stats.mode & 0o777);
        if (contents.length > 0) await destinationFile.write(contents, 0, contents.length, 0);
        await destinationFile.sync();
      } catch (error) {
        fail('FEED_INSTALL_FAILED', 'A prepared feed file cannot be copied safely.', requestId, { path: relativePath, cause: error instanceof Error ? error.message : String(error) });
      } finally {
        await destinationFile?.close().catch(() => undefined);
      }
    } else if (stats.isSymbolicLink()) {
      const target = await readLink(source, name, requestId, 'FEED_INSTALL_FAILED', 'A prepared feed symbolic link changed during copying.');
      assertSafeTreeSymlink(target, relativePath, requestId, 'FEED_INSTALL_FAILED');
      try {
        await symlink(target, fdPath(destination.handle, name));
      } catch (error) {
        fail('FEED_INSTALL_FAILED', 'A prepared feed symbolic link cannot be copied safely.', requestId, { path: relativePath, cause: error instanceof Error ? error.message : String(error) });
      }
    } else {
      fail('FEED_INSTALL_FAILED', 'A prepared feed contains an unsupported filesystem entry.', requestId, { path: relativePath });
    }
  }
}

async function materializeFeeds(
  openwrt: HeldDirectory,
  prepared: readonly PreparedFeedAuthority[],
  dependencies: PathAuthorityDependencies,
  requestId: string,
): Promise<readonly FeedResolution['prepared'][number][]> {
  const feedsDirectory = await createDirectoryAt(openwrt, 'feeds', 0o755, dependencies, requestId);
  const evidence: FeedResolution['prepared'][number][] = [];
  try {
    for (const source of prepared) {
      const code = source.record.name === 'packages' ? 'RUST_BOOTSTRAP_UNAVAILABLE' : 'FEED_INSTALL_FAILED';
      const sourceTreeSha256 = await hashFeedTree(source.directory, dependencies, requestId, code);
      if (sourceTreeSha256 !== source.record.treeSha256) {
        fail(code, 'An API-prepared feed tree changed before materialization.', requestId, { feed: source.record.name, expected: source.record.treeSha256, observed: sourceTreeSha256 });
      }
      const destination = await createDirectoryAt(feedsDirectory, source.record.name, 0o755, dependencies, requestId);
      try {
        await copyFeedTree(source.directory, destination, dependencies, requestId);
        const destinationTreeSha256 = await hashFeedTree(destination, dependencies, requestId, code);
        if (destinationTreeSha256 !== sourceTreeSha256) {
          fail(code, 'A materialized feed tree differs from the API-prepared source.', requestId, { feed: source.record.name, sourceTreeSha256, destinationTreeSha256 });
        }
        evidence.push({ name: source.record.name, commit: source.record.commit, sourceTreeSha256, destinationTreeSha256 });
      } finally {
        await destination.handle.close().catch(() => undefined);
      }
    }
    return Object.freeze(evidence.map((entry) => Object.freeze(entry)));
  } finally {
    await feedsDirectory.handle.close().catch(() => undefined);
  }
}

async function rustFeed(
  openwrt: HeldDirectory,
  requestId: string,
  dependencies: PathAuthorityDependencies,
): Promise<RustResolution> {
  const path = ['feeds', 'packages', ...OPENWRT_RUST_FEED_CONTRACT.sourcePath.split('/')] as const;
  const parent = await openDirectoryPath(
    openwrt,
    path.slice(0, -1),
    dependencies,
    requestId,
    'RUST_BOOTSTRAP_UNAVAILABLE',
    'The pinned packages feed Rust source path is unavailable or unsafe.',
  );
  const filename = path.at(-1)!;
  const opened = await openRegularFile(
    parent.directory,
    filename,
    WRITE_FLAGS,
    dependencies,
    requestId,
    'RUST_BOOTSTRAP_UNAVAILABLE',
    'The pinned packages feed Rust Makefile is unavailable or unsafe.',
  );
  try {
    const source = (await readHandle(opened.handle)).toString('utf8');
    await assertFileBinding(parent.directory, filename, opened.handle, opened.stats, requestId, 'RUST_BOOTSTRAP_UNAVAILABLE', 'The pinned Rust source changed while it was inspected.');
    const enforcement = enforceOpenWrtRustFeed(source, OPENWRT_RUST_FEED_CONTRACT);
    if (!enforcement.ok) {
      fail('RUST_BOOTSTRAP_UNAVAILABLE', `The pinned Rust feed failed the exact transformation contract: ${enforcement.reason}`, requestId, {
        path: `openwrt/feeds/packages/${OPENWRT_RUST_FEED_CONTRACT.sourcePath}`,
        commit: PACKAGES_COMMIT,
        hostTriple: OPENWRT_RUST_FEED_CONTRACT.hostTriple,
      });
    }
    const contents = Buffer.from(enforcement.source);
    await opened.handle.truncate(0);
    if (contents.length > 0) await opened.handle.write(contents, 0, contents.length, 0);
    await opened.handle.sync();
    await dependencies.beforeDirectorySync?.(parent.directory.handle);
    await assertFileBinding(parent.directory, filename, opened.handle, await opened.handle.stat(), requestId, 'RUST_BOOTSTRAP_UNAVAILABLE', 'The transformed Rust source path changed while it was written.');
    if (sha256(await readHandle(opened.handle)) !== enforcement.enforcedSha256) {
      fail('RUST_BOOTSTRAP_UNAVAILABLE', 'The transformed Rust feed hash does not match the approved contract.', requestId);
    }
    return Object.freeze({
      sourceSha256: enforcement.sourceSha256,
      enforcedSha256: enforcement.enforcedSha256,
      path: `openwrt/feeds/packages/${OPENWRT_RUST_FEED_CONTRACT.sourcePath}`,
      sourceCommit: PACKAGES_COMMIT,
      hostTriple: OPENWRT_RUST_FEED_CONTRACT.hostTriple,
    });
  } catch (error) {
    if (error instanceof BuilderError) throw error;
    fail('RUST_BOOTSTRAP_UNAVAILABLE', 'The Rust feed source could not be transformed through its held descriptor.', requestId, { cause: error instanceof Error ? error.message : String(error) });
  } finally {
    await opened.handle.close().catch(() => undefined);
    await closeHandles(parent.handles);
  }
}

async function verifyRustTransform(
  openwrt: HeldDirectory,
  expected: RustResolution,
  requestId: string,
  dependencies: PathAuthorityDependencies,
  operationId: 'update-feeds' | 'install-feeds',
): Promise<void> {
  const path = ['feeds', 'packages', ...OPENWRT_RUST_FEED_CONTRACT.sourcePath.split('/')] as const;
  const parent = await openDirectoryPath(openwrt, path.slice(0, -1), dependencies, requestId, 'RUST_BOOTSTRAP_UNAVAILABLE', 'The transformed Rust feed path is unavailable after feed processing.');
  try {
    const contents = await readRegularFile(parent.directory, path.at(-1)!, dependencies, requestId, 'RUST_BOOTSTRAP_UNAVAILABLE', 'The transformed Rust feed changed after feed processing.');
    if (sha256(contents) !== expected.enforcedSha256) {
      fail('RUST_BOOTSTRAP_UNAVAILABLE', `The exact Rust feed transform changed after ${operationId}.`, requestId, { operationId, expected: expected.enforcedSha256, observed: sha256(contents) }, operationId);
    }
  } finally {
    await closeHandles(parent.handles);
  }
}

async function captureMaterializedFeedHashes(
  openwrt: HeldDirectory,
  prepared: readonly PreparedFeedAuthority[],
  dependencies: PathAuthorityDependencies,
  requestId: string,
): Promise<ReadonlyMap<string, string>> {
  const feeds = await openBoundDirectory(
    openwrt,
    'feeds',
    dependencies,
    requestId,
    'FEED_INSTALL_FAILED',
    'The materialized feed directory is unavailable or unsafe.',
  );
  try {
    const hashes = new Map<string, string>();
    for (const source of prepared) {
      const code = source.record.name === 'packages' ? 'RUST_BOOTSTRAP_UNAVAILABLE' : 'FEED_INSTALL_FAILED';
      const destination = await openBoundDirectory(
        feeds,
        source.record.name,
        dependencies,
        requestId,
        code,
        `The materialized ${source.record.name} feed is unavailable or unsafe.`,
      );
      try {
        hashes.set(source.record.name, await hashFeedTree(destination, dependencies, requestId, code));
      } finally {
        await destination.handle.close().catch(() => undefined);
      }
    }
    return hashes;
  } finally {
    await feeds.handle.close().catch(() => undefined);
  }
}

async function verifyPreparedAndMaterializedFeeds(
  openwrt: HeldDirectory,
  prepared: readonly PreparedFeedAuthority[],
  expectedDestinationHashes: ReadonlyMap<string, string>,
  dependencies: PathAuthorityDependencies,
  requestId: string,
  operationId: 'update-feeds' | 'install-feeds',
): Promise<void> {
  const feeds = await openBoundDirectory(
    openwrt,
    'feeds',
    dependencies,
    requestId,
    'FEED_INSTALL_FAILED',
    `The materialized feed directory is unavailable after ${operationId}.`,
  );
  try {
    for (const source of prepared) {
      const code = source.record.name === 'packages' ? 'RUST_BOOTSTRAP_UNAVAILABLE' : 'FEED_INSTALL_FAILED';
      const sourceHash = await hashFeedTree(source.directory, dependencies, requestId, code);
      if (sourceHash !== source.record.treeSha256) {
        fail(code, `The API-prepared ${source.record.name} feed changed after ${operationId}.`, requestId, {
          feed: source.record.name,
          expected: source.record.treeSha256,
          observed: sourceHash,
        }, operationId);
      }
      const destination = await openBoundDirectory(
        feeds,
        source.record.name,
        dependencies,
        requestId,
        code,
        `The materialized ${source.record.name} feed is unavailable after ${operationId}.`,
      );
      try {
        const destinationHash = await hashFeedTree(destination, dependencies, requestId, code);
        const expected = expectedDestinationHashes.get(source.record.name);
        if (expected === undefined || destinationHash !== expected) {
          fail(code, `The materialized ${source.record.name} feed changed after ${operationId}.`, requestId, {
            feed: source.record.name,
            expected: expected ?? null,
            observed: destinationHash,
          }, operationId);
        }
      } finally {
        await destination.handle.close().catch(() => undefined);
      }
    }
  } finally {
    await feeds.handle.close().catch(() => undefined);
  }
}

async function patchState(
  workspace: HeldDirectory,
  activationOutput: string,
  requestId: string,
  dependencies: PathAuthorityDependencies,
): Promise<RootfsPatchDecision> {
  const series = await readTextPath(workspace, ['openwrt', '.pc', 'series'], dependencies, requestId, 'PATCH_STATE_AMBIGUOUS', 'The OpenWrt quilt series is unavailable or unsafe.');
  const applied = await readTextPath(workspace, ['openwrt', '.pc', 'applied-patches'], dependencies, requestId, 'PATCH_STATE_AMBIGUOUS', 'The OpenWrt applied patch list is unavailable or unsafe.');
  const rootfsScript = await readTextPath(
    workspace,
    ['openwrt', 'target', 'linux', 'bcm27xx', 'image', 'gen_rpi_sdcard_img.sh'],
    dependencies,
    requestId,
    'PATCH_STATE_AMBIGUOUS',
    'The approved rootfs image implementation is unavailable or unsafe.',
  );
  return decideRootfsPatchState({
    series: series.split(/\r?\n/u),
    applied: applied.split(/\r?\n/u),
    output: activationOutput,
    rootfsScript,
  }, requestId);
}

function expectedConfigValue(config: string, name: string, type: 'bool' | 'string' | 'number'): boolean | string | number | undefined {
  const matching = config.split(/\r?\n/u).filter((line) => line.startsWith(`${name}=`) || line === `# ${name} is not set`);
  if (matching.length !== 1) return undefined;
  const line = matching[0]!;
  if (type === 'bool') return line === `${name}=y`;
  if (line.startsWith(`${name}="`) && line.endsWith('"')) return type === 'string' ? line.slice(name.length + 2, -1) : undefined;
  if (type === 'number' && new RegExp(`^${name}=-?\\d+$`, 'u').test(line)) return Number(line.slice(name.length + 1));
  return undefined;
}

function checkConfig(
  config: string,
  target: TargetManifest,
  requestId: string,
  context: string,
  operationId?: TargetSetupOperationId,
): void {
  for (const symbol of target.configSymbols) {
    const actual = expectedConfigValue(config, symbol.name, symbol.type);
    if (actual !== symbol.value) {
      fail('TARGET_CONFIG_MISMATCH', `The ${context} config symbol ${symbol.name} does not match the target manifest.`, requestId, {
        symbol: symbol.name,
        expected: String(symbol.value),
        observed: actual === undefined ? null : String(actual),
      }, operationId);
    }
  }
}

async function readProfileConfigBytes(
  workspace: HeldDirectory,
  target: TargetManifest,
  dependencies: PathAuthorityDependencies,
  requestId: string,
): Promise<Buffer> {
  const parent = await openDirectoryPath(
    workspace,
    ['conf', target.environment],
    dependencies,
    requestId,
    'TARGET_CONFIG_MISMATCH',
    `The ${target.id} profile config is unavailable or unsafe.`,
  );
  try {
    return await readRegularFile(
      parent.directory,
      '.config',
      dependencies,
      requestId,
      'TARGET_CONFIG_MISMATCH',
      `The ${target.id} profile config is unavailable or unsafe.`,
    );
  } finally {
    await closeHandles(parent.handles);
  }
}

async function verifySelectedConfigLinks(
  workspace: HeldDirectory,
  target: TargetManifest,
  dependencies: PathAuthorityDependencies,
  requestId: string,
): Promise<void> {
  const conf = await openDirectoryPath(workspace, ['conf'], dependencies, requestId, 'TARGET_CONFIG_MISMATCH', 'The selected profile config directory is unavailable.');
  const openwrt = await openDirectoryPath(workspace, ['openwrt'], dependencies, requestId, 'TARGET_CONFIG_MISMATCH', 'The OpenWrt config directory is unavailable.');
  try {
    const confTarget = await readLink(conf.directory, '.config', requestId, 'TARGET_CONFIG_MISMATCH', 'The selected profile config link is unavailable or unsafe.');
    const openwrtTarget = await readLink(openwrt.directory, '.config', requestId, 'TARGET_CONFIG_MISMATCH', 'The OpenWrt config link is unavailable or unsafe.');
    if (confTarget !== `${target.environment}/.config` || openwrtTarget !== '../conf/.config') {
      fail('TARGET_CONFIG_MISMATCH', 'The active OpenWrt config links do not bind the selected manifest profile.', requestId, { environment: target.environment });
    }
  } finally {
    await closeHandles(openwrt.handles);
    await closeHandles(conf.handles);
  }
}

async function verifyLinks(
  workspace: HeldDirectory,
  localFeed: HeldDirectory,
  requestId: string,
  dependencies: PathAuthorityDependencies,
): Promise<readonly string[]> {
  const links = await openDirectoryPath(
    workspace,
    ['openwrt', 'package', 'feeds', 'chirpstack'],
    dependencies,
    requestId,
    'FEED_LINKS_MISSING',
    'The installed ChirpStack package link directory is unavailable or unsafe.',
  );
  const names: string[] = [];
  try {
    for (const name of REQUIRED_LINKS) {
      const expectedPath = name === 'chirpstack' ? ['chirpstack', 'chirpstack'] : ['apps', name];
      const expected = await openDirectoryPath(localFeed, expectedPath, dependencies, requestId, 'FEED_LINKS_MISSING', `The local feed package ${name} is unavailable.`);
      let resolved: FileHandle | undefined;
      try {
        const target = await readLink(links.directory, name, requestId, 'FEED_LINKS_MISSING', `The installed feed link ${name} is missing or unsafe.`);
        const lexicalTarget = posix.resolve('/workspace/openwrt/package/feeds/chirpstack', target);
        if (!lexicalTarget.startsWith('/workspace/openwrt/')) {
          fail('FEED_LINKS_MISSING', `The installed feed link ${name} escapes the OpenWrt tree.`, requestId, { package: name });
        }
        resolved = await open(fdPath(links.directory.handle, name), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
        const [resolvedStats, expectedStats] = await Promise.all([resolved.stat(), expected.directory.handle.stat()]);
        if (!sameIdentity(resolvedStats, expectedStats)) {
          fail('FEED_LINKS_MISSING', `The installed feed link ${name} does not resolve to the pinned local feed package.`, requestId, { package: name });
        }
        names.push(name);
      } catch (error) {
        if (error instanceof BuilderError) throw error;
        fail('FEED_LINKS_MISSING', `The installed feed link ${name} is missing, broken, or unsafe.`, requestId, { package: name, cause: error instanceof Error ? error.message : String(error) });
      } finally {
        await resolved?.close().catch(() => undefined);
        await closeHandles(expected.handles);
      }
    }
    return Object.freeze(names);
  } finally {
    await closeHandles(links.handles);
  }
}

function operationFailureCode(operationId: TargetSetupOperationId): BuilderErrorCode {
  if (operationId === 'activate-target') return 'PATCH_STATE_AMBIGUOUS';
  if (operationId === 'resolve-config') return 'TARGET_CONFIG_MISMATCH';
  return 'FEED_INSTALL_FAILED';
}

function operationFailureMessage(operationId: TargetSetupOperationId): string {
  if (operationId === 'activate-target') return 'Target environment activation did not complete exactly.';
  if (operationId === 'copy-feed-config') return 'The pinned feed configuration copy did not complete exactly.';
  if (operationId === 'update-feeds') return 'OpenWrt feed update did not complete exactly.';
  if (operationId === 'install-feeds') return 'OpenWrt feed installation did not complete exactly.';
  return 'OpenWrt defconfig did not complete exactly.';
}

async function runOperation(
  operations: LockedTargetSetupOperations,
  operationId: TargetSetupOperationId,
  definition: OperationDefinition,
  workspace: HeldWorkspaceCapability,
  verifyWorkspaceBinding: () => Promise<void>,
  requestId: string,
): Promise<CommandResult> {
  await verifyWorkspaceBinding();
  let result: CommandResult | undefined;
  let operationError: unknown;
  try {
    result = await operations.run(operationId, definition, workspace);
  } catch (error) {
    operationError = error;
  }
  await verifyWorkspaceBinding();
  if (operationError !== undefined) {
    fail(operationFailureCode(operationId), operationFailureMessage(operationId), requestId, { cause: operationError instanceof Error ? operationError.message : String(operationError) }, operationId);
  }
  if (result === undefined) fail(operationFailureCode(operationId), operationFailureMessage(operationId), requestId, {}, operationId);
  if (
    result.exitCode !== 0
    || result.signal !== null
    || result.timedOut !== false
    || !hasExactList(result.argv, definition.argv)
  ) {
    fail(operationFailureCode(operationId), operationFailureMessage(operationId), requestId, {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      argvMatches: hasExactList(result.argv, definition.argv),
    }, operationId);
  }
  return result;
}

function validateTargets(input: TargetSetupInput): {
  readonly selected: TargetManifest;
  readonly ordered: readonly TargetManifest[];
  readonly definitions: ReadonlyMap<string, ReadonlyMap<TargetSetupOperationId, OperationDefinition>>;
} {
  if (!Array.isArray(input.targets) || input.targets.length !== 2) {
    fail('TARGET_CONFIG_MISMATCH', 'Both shipped Raspberry Pi profile manifests are required for target setup.', input.requestId);
  }
  const targetById = new Map(input.targets.map((target) => [target.id, target]));
  if (targetById.size !== 2 || !targetById.has('rpi-5') || !targetById.has('rpi-2')) {
    fail('TARGET_CONFIG_MISMATCH', 'The target manifest set must contain exactly the two shipped Raspberry Pi targets.', input.requestId);
  }
  const selected = targetById.get(input.target.id);
  if (!selected || !isDeepStrictEqual(selected, input.target)) {
    fail('TARGET_CONFIG_MISMATCH', 'The selected target does not exactly match its validated manifest entry.', input.requestId, { target: input.target.id });
  }
  const definitions = new Map<string, ReadonlyMap<TargetSetupOperationId, OperationDefinition>>();
  for (const target of input.targets) {
    const targetDefinitions = new Map<TargetSetupOperationId, OperationDefinition>();
    for (const operationId of TARGET_SETUP_OPERATIONS) {
      try {
        targetDefinitions.set(operationId, createOperationDefinition(operationId, { environment: target.environment }));
      } catch {
        fail('TARGET_CONFIG_MISMATCH', 'A target environment cannot produce the exact registered operation definitions.', input.requestId, { environment: target.environment }, operationId);
      }
    }
    definitions.set(target.id, targetDefinitions);
  }
  const ordered = input.targets.filter((target) => target.id !== selected.id).concat(selected);
  return { selected, ordered, definitions };
}

export interface TargetSetupInput {
  readonly stateRoot: StateRootAuthority;
  readonly jobId: string;
  readonly sourceSha: string;
  readonly target: TargetManifest;
  readonly targets: readonly TargetManifest[];
  readonly preparedFeeds: OfflineFeedPreparation;
  readonly operations: LockedTargetSetupOperations;
  readonly evidenceWriter: Pick<EvidenceWriter, 'writeTargetSetupSourceConfig'>;
  readonly requestId: string;
}

export interface TargetSetupResult {
  readonly workspacePath: string;
  readonly target: TargetManifest['id'];
  readonly patchDecision: RootfsPatchDecision;
  readonly feed: FeedResolution;
  readonly rust: RustResolution;
  readonly config: {
    readonly selectedTarget: string;
    readonly profile: string;
    readonly rootfsPartSize: number;
    readonly sourceSha256: string;
    readonly resolvedSha256: string;
    readonly bothProfilesChecked: true;
    readonly profiles: Readonly<Record<TargetManifest['id'], ProfileResolution>>;
  };
}

export async function resolveTargetSetup(input: TargetSetupInput): Promise<TargetSetupResult> {
  const jobId = assertJobId(input.jobId, input.requestId);
  if (!input.operations || !LOCKED_OPERATION_ADAPTERS.has(input.operations as object)) {
    fail('WORKTREE_CREATE_FAILED', 'Target setup requires the module-owned descriptor-bound operation adapter.', input.requestId);
  }
  if (!SHA40.test(input.sourceSha)) {
    fail('FEED_INSTALL_FAILED', 'The persisted source SHA is not an exact Git commit identity.', input.requestId);
  }
  const targetState = validateTargets(input);
  if (process.platform !== 'linux' || typeof fsConstants.O_NOFOLLOW !== 'number' || typeof fsConstants.O_DIRECTORY !== 'number') {
    fail('WORKTREE_CREATE_FAILED', 'Target setup requires Linux no-follow descriptor traversal.', input.requestId);
  }

  return withStateRootSnapshot(input.stateRoot, async ({ snapshot, dependencies }) => {
    const handles: FileHandle[] = [];
    const bindings: HeldDirectory[] = [];
    let root: HeldDirectory;
    try {
      const rootChain = await openAbsoluteDirectoryChain(snapshot.path, dependencies, input.requestId);
      handles.push(...rootChain.handles);
      bindings.push(...rootChain.bindings);
      root = rootChain.directory;
      const rootStats = await root.handle.stat();
      if (!rootStats.isDirectory() || rootStats.dev !== snapshot.device || rootStats.ino !== snapshot.inode) {
        fail('WORKTREE_CREATE_FAILED', 'The configured state root identity changed before target setup.', input.requestId);
      }
    } catch (error) {
      if (error instanceof BuilderError) throw error;
      fail('WORKTREE_CREATE_FAILED', 'The configured state root cannot be held safely for target setup.', input.requestId, { cause: error instanceof Error ? error.message : String(error) });
    }

    try {
      const jobs = await openBoundDirectory(root, 'jobs', dependencies, input.requestId, 'WORKTREE_CREATE_FAILED', 'The job state directory is unavailable or unsafe.');
      handles.push(jobs.handle);
      bindings.push(jobs);
      const job = await openBoundDirectory(jobs, jobId, dependencies, input.requestId, 'WORKTREE_CREATE_FAILED', 'The job state directory is unavailable or unsafe.');
      handles.push(job.handle);
      bindings.push(job);
      const workspaceParent = await openBoundDirectory(job, 'workspace', dependencies, input.requestId, 'WORKTREE_CREATE_FAILED', 'The job workspace directory is unavailable or unsafe.');
      handles.push(workspaceParent.handle);
      bindings.push(workspaceParent);
      const workspace = await openBoundDirectory(workspaceParent, 'source', dependencies, input.requestId, 'WORKTREE_CREATE_FAILED', 'The job-owned source workspace is unavailable, replaced, or symlinked.');
      handles.push(workspace.handle);
      bindings.push(workspace);
      const openwrt = await openBoundDirectory(workspace, 'openwrt', dependencies, input.requestId, 'WORKTREE_CREATE_FAILED', 'The OpenWrt source directory is unavailable or unsafe.');
      handles.push(openwrt.handle);
      bindings.push(openwrt);
      const feeds = await openBoundDirectory(workspace, 'feeds', dependencies, input.requestId, 'FEED_INSTALL_FAILED', 'The repository feed directory is unavailable or unsafe.');
      handles.push(feeds.handle);
      bindings.push(feeds);
      const localFeed = await openBoundDirectory(feeds, 'chirpstack-openwrt-feed', dependencies, input.requestId, 'FEED_INSTALL_FAILED', 'The worktree-local ChirpStack feed is unavailable, replaced, or symlinked.');
      handles.push(localFeed.handle);
      bindings.push(localFeed);

      const sourceFeed = await readTextFile(workspace, 'feeds.conf.default', dependencies, input.requestId, 'FEED_INSTALL_FAILED', 'The pinned repository feed configuration is unavailable or unsafe.');
      const parsedFeeds = parseFeedConfig(sourceFeed, input.requestId);
      const preparedRecords = validatePreparedInput(
        input.preparedFeeds,
        parsedFeeds.gitFeeds,
        jobId,
        input.sourceSha,
        input.requestId,
      );
      const preparedRoot = await openBoundDirectory(job, 'prepared-feeds', dependencies, input.requestId, 'FEED_INSTALL_FAILED', 'The API-prepared feed directory is unavailable or unsafe.');
      handles.push(preparedRoot.handle);
      bindings.push(preparedRoot);
      const prepared: PreparedFeedAuthority[] = [];
      for (const pinned of parsedFeeds.gitFeeds) {
        const record = preparedRecords.get(pinned.name)!;
        const code = pinned.name === 'packages' ? 'RUST_BOOTSTRAP_UNAVAILABLE' : 'FEED_INSTALL_FAILED';
        const directory = await openBoundDirectory(preparedRoot, pinned.name, dependencies, input.requestId, code, `The API-prepared ${pinned.name} feed is unavailable, replaced, or symlinked.`);
        handles.push(directory.handle);
        bindings.push(directory);
        const gitDirectory = await openBoundDirectory(directory, '.git', dependencies, input.requestId, code, `The API-prepared ${pinned.name} feed is not a complete offline Git checkout.`);
        try {
          const head = (await readRegularFile(gitDirectory, 'HEAD', dependencies, input.requestId, code, `The API-prepared ${pinned.name} Git checkout has no held HEAD file.`)).toString('utf8');
          if (head !== `${record.commit}\n`) {
            fail(code, `The API-prepared ${pinned.name} checkout HEAD differs from its attested commit.`, input.requestId, { feed: pinned.name, expected: record.commit, observed: head.trim() });
          }
        } finally {
          await gitDirectory.handle.close().catch(() => undefined);
        }
        const treeSha256 = await hashFeedTree(directory, dependencies, input.requestId, code);
        if (treeSha256 !== record.treeSha256) {
          fail(code, `The API-prepared ${pinned.name} feed tree hash does not match its attestation.`, input.requestId, { feed: pinned.name, expected: record.treeSha256, observed: treeSha256 });
        }
        prepared.push({ record, directory });
      }

      const preparedPackages = prepared.find((feed) => feed.record.name === 'packages')!;
      const preparedRust = await readTextPath(
        preparedPackages.directory,
        OPENWRT_RUST_FEED_CONTRACT.sourcePath.split('/'),
        dependencies,
        input.requestId,
        'RUST_BOOTSTRAP_UNAVAILABLE',
        'The exact pinned Rust feed source is unavailable in the API-prepared packages checkout.',
      );
      const preparedEnforcement = enforceOpenWrtRustFeed(preparedRust, OPENWRT_RUST_FEED_CONTRACT);
      if (!preparedEnforcement.ok) {
        fail('RUST_BOOTSTRAP_UNAVAILABLE', `The API-prepared packages checkout violates the exact Rust source contract: ${preparedEnforcement.reason}`, input.requestId, {
          commit: PACKAGES_COMMIT,
          path: OPENWRT_RUST_FEED_CONTRACT.sourcePath,
          hostTriple: OPENWRT_RUST_FEED_CONTRACT.hostTriple,
        });
      }
      await assertBindings(bindings, dependencies, input.requestId);
      const workspaceStats = await workspace.handle.stat();
      const workspaceCapability: HeldWorkspaceCapability = Object.freeze({
        descriptorPath: `/proc/${process.pid}/fd/${workspace.handle.fd}`,
        device: workspaceStats.dev,
        inode: workspaceStats.ino,
        containerWorkingDirectory: '/workdir',
      });

      const profileResults = new Map<TargetManifest['id'], ProfileResolution>();
      let selectedFeed: FeedResolution | undefined;
      let selectedRust: RustResolution | undefined;
      for (const target of targetState.ordered) {
        const definitions = targetState.definitions.get(target.id)!;
        const verifyWorkspaceBinding = () => assertBindings(bindings, dependencies, input.requestId);
        await assertBindings(bindings, dependencies, input.requestId);
        const activation = await runOperation(input.operations, 'activate-target', definitions.get('activate-target')!, workspaceCapability, verifyWorkspaceBinding, input.requestId);
        await assertBindings(bindings, dependencies, input.requestId);
        await verifySelectedConfigLinks(workspace, target, dependencies, input.requestId);
        const sourceConfigBytes = await readProfileConfigBytes(workspace, target, dependencies, input.requestId);
        const sourceConfig = sourceConfigBytes.toString('utf8');
        checkConfig(sourceConfig, target, input.requestId, `${target.id} source`);
        const sourceConfigSha256 = sha256(sourceConfigBytes);
        const sourceConfigEvidencePath = `evidence/target-setup/${target.id}.source.config`;
        let sourceConfigPublication: EvidencePublication;
        try {
          sourceConfigPublication = await input.evidenceWriter.writeTargetSetupSourceConfig({
            jobId,
            targetId: target.id,
            contents: sourceConfigBytes,
          });
        } catch (error) {
          fail('TARGET_CONFIG_MISMATCH', `The ${target.id} source config could not be published durably before mutation.`, input.requestId, {
            target: target.id,
            cause: error instanceof Error ? error.message : String(error),
          });
        }
        if (
          sourceConfigPublication.path !== `jobs/${jobId}/${sourceConfigEvidencePath}`
          || sourceConfigPublication.sha256 !== sourceConfigSha256
        ) {
          fail('TARGET_CONFIG_MISMATCH', `The ${target.id} source config evidence does not match the held bytes.`, input.requestId, {
            target: target.id,
            expectedPath: `jobs/${jobId}/${sourceConfigEvidencePath}`,
            observedPath: sourceConfigPublication.path,
            expectedSha256: sourceConfigSha256,
            observedSha256: sourceConfigPublication.sha256,
          });
        }

        await runOperation(input.operations, 'copy-feed-config', definitions.get('copy-feed-config')!, workspaceCapability, verifyWorkspaceBinding, input.requestId);
        await assertBindings(bindings, dependencies, input.requestId);
        const immediateSourceFeed = await readTextFile(workspace, 'feeds.conf.default', dependencies, input.requestId, 'FEED_INSTALL_FAILED', 'The repository feed configuration changed after target activation.');
        const immediateDestinationFeed = await readTextFile(openwrt, 'feeds.conf.default', dependencies, input.requestId, 'FEED_INSTALL_FAILED', 'The copied feed configuration is missing or unsafe.');
        const sourceSha256 = sha256(immediateSourceFeed);
        const destinationSha256 = sha256(immediateDestinationFeed);
        if (immediateSourceFeed !== sourceFeed || sourceSha256 !== destinationSha256) {
          fail('FEED_INSTALL_FAILED', 'The copied feed configuration hash differs from the pinned repository source.', input.requestId, { sourceSha256, destinationSha256 }, 'copy-feed-config');
        }
        const patchDecision = await patchState(workspace, `${activation.stdout}\n${activation.stderr}`, input.requestId, dependencies);
        const preparedEvidence = await materializeFeeds(openwrt, prepared, dependencies, input.requestId);
        const rust = await rustFeed(openwrt, input.requestId, dependencies);
        const materializedFeedHashes = await captureMaterializedFeedHashes(openwrt, prepared, dependencies, input.requestId);

        await runOperation(input.operations, 'update-feeds', definitions.get('update-feeds')!, workspaceCapability, verifyWorkspaceBinding, input.requestId);
        await verifyPreparedAndMaterializedFeeds(
          openwrt,
          prepared,
          materializedFeedHashes,
          dependencies,
          input.requestId,
          'update-feeds',
        );
        await verifyRustTransform(openwrt, rust, input.requestId, dependencies, 'update-feeds');
        await assertBindings(bindings, dependencies, input.requestId);
        await runOperation(input.operations, 'install-feeds', definitions.get('install-feeds')!, workspaceCapability, verifyWorkspaceBinding, input.requestId);
        await verifyPreparedAndMaterializedFeeds(
          openwrt,
          prepared,
          materializedFeedHashes,
          dependencies,
          input.requestId,
          'install-feeds',
        );
        await verifyRustTransform(openwrt, rust, input.requestId, dependencies, 'install-feeds');
        const installedPackages = await verifyLinks(workspace, localFeed, input.requestId, dependencies);

        await runOperation(input.operations, 'resolve-config', definitions.get('resolve-config')!, workspaceCapability, verifyWorkspaceBinding, input.requestId);
        await verifySelectedConfigLinks(workspace, target, dependencies, input.requestId);
        const resolvedConfig = (await readProfileConfigBytes(workspace, target, dependencies, input.requestId)).toString('utf8');
        checkConfig(resolvedConfig, target, input.requestId, `${target.id} resolved`, 'resolve-config');
        const profile = expectedConfigValue(resolvedConfig, 'CONFIG_TARGET_PROFILE', 'string');
        const rootfsPartSize = expectedConfigValue(resolvedConfig, 'CONFIG_TARGET_ROOTFS_PARTSIZE', 'number');
        if (profile !== target.profile || rootfsPartSize !== target.rootfsPartSize) {
          fail('TARGET_CONFIG_MISMATCH', 'The resolved profile or rootfs size does not exactly match the target manifest.', input.requestId, { target: target.id }, 'resolve-config');
        }
        const profileResult = Object.freeze({
          target: target.id,
          environment: target.environment,
          selectedTarget: target.openwrtTarget,
          profile,
          rootfsPartSize,
          sourceSha256: sourceConfigSha256,
          sourceConfigEvidencePath,
          resolvedSha256: sha256(resolvedConfig),
          patchDecision,
        });
        profileResults.set(target.id, profileResult);
        if (target.id === targetState.selected.id) {
          selectedFeed = Object.freeze({
            sourceSha256,
            destinationSha256,
            localPath: join(snapshot.path, 'jobs', jobId, 'workspace', 'source', parsedFeeds.chirpstackLocation),
            packagesCommit: PACKAGES_COMMIT,
            installedPackages,
            prepared: preparedEvidence,
          });
          selectedRust = rust;
        }
        await assertBindings(bindings, dependencies, input.requestId);
      }

      const selectedProfile = profileResults.get(targetState.selected.id)!;
      const profiles = Object.freeze({
        'rpi-5': profileResults.get('rpi-5')!,
        'rpi-2': profileResults.get('rpi-2')!,
      });
      return Object.freeze({
        workspacePath: join(snapshot.path, 'jobs', jobId, 'workspace', 'source'),
        target: targetState.selected.id,
        patchDecision: selectedProfile.patchDecision,
        feed: selectedFeed!,
        rust: selectedRust!,
        config: Object.freeze({
          selectedTarget: selectedProfile.selectedTarget,
          profile: selectedProfile.profile,
          rootfsPartSize: selectedProfile.rootfsPartSize,
          sourceSha256: selectedProfile.sourceSha256,
          resolvedSha256: selectedProfile.resolvedSha256,
          bothProfilesChecked: true as const,
          profiles,
        }),
      });
    } finally {
      await closeHandles(handles);
    }
  });
}
