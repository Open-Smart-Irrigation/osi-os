import { constants as fsConstants } from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import { access, lstat, open, readFile, realpath, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { BuilderError, type BuilderErrorCode } from '../../domain/errors.js';
import { validateBuilderLock, type BuilderLock } from '../../domain/builder-lock.js';
import { encodeBranchSlug, inspectReleasePathUnderRoot, withHeldParentUnderRoot } from '../../domain/paths.js';
import { resolveApprovedRoot, withApprovedRootSnapshot, withStateRootSnapshot, type ApprovedOutputRoot, type BuilderConfig, type LoadedConfig } from '../../config/load.js';
import { SourceResolverError, type GitResolutionMetadata, type SourceResolverCode } from './git/source-resolver.js';
import type { TargetId } from '../../domain/types.js';
import type { LoadedManifest, TargetManifest } from '../../manifest/schema.js';

export const PREFLIGHT_TTL_MS = 10 * 60 * 1000;
const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PREFLIGHT_ID = /^pf_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const PREFLIGHT_COMMAND_TIMEOUT_MS = 5_000;
const PREFLIGHT_COMMAND_MAX_BUFFER = 8 * 1024;

export const TRUSTED_PREFLIGHT_EXECUTABLES = Object.freeze({
  git: '/usr/bin/git', docker: '/usr/bin/docker', node: '/usr/bin/node', npm: '/usr/bin/npm',
  sqlite3: '/usr/bin/sqlite3', systemctl: '/usr/bin/systemctl',
} as const);
export type TrustedPreflightExecutable = keyof typeof TRUSTED_PREFLIGHT_EXECUTABLES;

export const PREFLIGHT_CHECK_IDS = Object.freeze([
  'source-sha', 'repository', 'disk-worktree', 'disk-output',
  'executable-git', 'executable-docker', 'executable-node', 'executable-npm',
  'executable-sqlite3', 'executable-systemctl', 'systemd-user-manager',
  'builder-lock', 'docker-builder-image', 'target-manifest', 'approved-output-root',
  'staging-directory', 'same-filesystem-staging', 'output-collision',
] as const);
export type PreflightCheckId = (typeof PREFLIGHT_CHECK_IDS)[number];
export type PreflightErrorCode = BuilderErrorCode;
export type PreflightDetailValue = string | number | boolean | null;
export type PreflightDetails = Readonly<Record<string, PreflightDetailValue>>;

export interface PreflightCheckRecord {
  readonly id: PreflightCheckId;
  readonly status: 'passed' | 'failed';
  readonly details: PreflightDetails;
  readonly errorCode?: PreflightErrorCode;
}

const retryableCodes = new Set<BuilderErrorCode>([
  'SOURCE_UNAVAILABLE', 'BRANCH_MOVED', 'GIT_FETCH_FAILED', 'REPOSITORY_UNAVAILABLE', 'PREFLIGHT_DISK_SPACE',
  'TOOL_UNAVAILABLE', 'SYSTEMD_USER_UNAVAILABLE', 'DOCKER_UNAVAILABLE', 'PREFLIGHT_EXPIRED', 'PREFLIGHT_CACHE_FULL',
]);

const PREFLIGHT_ERROR_CATALOG: Readonly<Partial<Record<BuilderErrorCode, Readonly<{ diagnosis: string; recovery: string }>>>> = Object.freeze({
  INVALID_BRANCH: { diagnosis: 'The requested branch name is invalid.', recovery: 'Select a valid branch and run preflight again.' },
  INVALID_SHA: { diagnosis: 'The expected source SHA is invalid.', recovery: 'Refresh the branch SHA and submit a new preflight request.' },
  PREFLIGHT_INVALID_TARGET: { diagnosis: 'The requested firmware target is not approved.', recovery: 'Select an approved Raspberry Pi target and run preflight again.' },
  PREFLIGHT_INVALID_OUTPUT_ROOT: { diagnosis: 'The requested output root is not approved.', recovery: 'Select an approved output root and run preflight again.' },
  PREFLIGHT_NOT_FOUND: { diagnosis: 'The preflight token is unknown or was not retained.', recovery: 'Run preflight again before accepting the build.' },
  PREFLIGHT_EXPIRED: { diagnosis: 'The preflight token expired before acceptance completed.', recovery: 'Run preflight again and accept it within ten minutes.' },
  PREFLIGHT_REQUEST_MISMATCH: { diagnosis: 'The acceptance request differs from the preflight request.', recovery: 'Submit the exact preflight request or run preflight again.' },
  PREFLIGHT_INVALID_ID: { diagnosis: 'The generated preflight ID is invalid.', recovery: 'Restart the builder service and generate a new preflight token.' },
  PREFLIGHT_CACHE_DUPLICATE: { diagnosis: 'The generated preflight ID is already retained.', recovery: 'Restart the builder service or fix the ID generator before retrying.' },
  PREFLIGHT_CACHE_FULL: { diagnosis: 'The preflight cache reached its configured capacity.', recovery: 'Accept or let existing preflights expire, then retry.' },
  SOURCE_UNAVAILABLE: { diagnosis: 'The source resolver could not establish the requested source state.', recovery: 'Check repository access and retry preflight.' },
  BRANCH_MOVED: { diagnosis: 'The branch no longer points at the expected SHA.', recovery: 'Refresh the branch, review the new commit, and run preflight again.' },
  GIT_FETCH_FAILED: { diagnosis: 'The configured Git remote could not be fetched.', recovery: 'Restore SSH/network access and retry preflight.' },
  ORIGIN_NOT_SSH: { diagnosis: 'The configured origin is not an approved SSH remote.', recovery: 'Configure the approved SSH origin and retry configuration validation.' },
  SOURCE_NOT_COMMIT: { diagnosis: 'The requested source ref does not resolve to a commit.', recovery: 'Refresh branches and select a valid commit-backed branch.' },
  REPOSITORY_UNAVAILABLE: { diagnosis: 'The configured repository is not an available Git worktree.', recovery: 'Restore the repository path and retry preflight.' },
  PREFLIGHT_DISK_SPACE: { diagnosis: 'A required filesystem does not have enough free space.', recovery: 'Free space on the state or selected output filesystem and retry.' },
  TOOL_UNAVAILABLE: { diagnosis: 'A required trusted host executable is unavailable.', recovery: 'Install or repair the named executable and retry preflight.' },
  SYSTEMD_USER_UNAVAILABLE: { diagnosis: 'The user systemd manager is unavailable or a runner is already active.', recovery: 'Enable the user manager or wait for the active runner, then retry.' },
  DOCKER_UNAVAILABLE: { diagnosis: 'Docker or its structured daemon/image evidence is unavailable.', recovery: 'Start Docker and restore the locked builder image, then retry.' },
  BUILDER_LOCK_INVALID: { diagnosis: 'The installed builder lock is not a valid production lock.', recovery: 'Install a generated immutable builder package and retry.' },
  BUILDER_DIGEST_MISMATCH: { diagnosis: 'The inspected builder image does not match the installed lock.', recovery: 'Restore the locked immutable builder image and retry.' },
  TARGET_MANIFEST_INVALID: { diagnosis: 'The selected target is absent or invalid in the trusted manifest.', recovery: 'Repair the installed target manifest and retry preflight.' },
  OUTPUT_ROOT_INVALID: { diagnosis: 'The approved output root failed canonical no-follow validation.', recovery: 'Restore the approved root directory and retry.' },
  STAGING_DIRECTORY_INVALID: { diagnosis: 'The configured staging directory is absent or unsafe.', recovery: 'Create the configured non-symlink staging directory and retry.' },
  STAGING_FILESYSTEM_MISMATCH: { diagnosis: 'The staging directory is on a different filesystem mount.', recovery: 'Place staging on the output root mount and retry.' },
  OUTPUT_COLLISION: { diagnosis: 'The deterministic release destination is unsafe or already occupied.', recovery: 'Select another approved root or retain the existing immutable release.' },
});

export class PreflightError extends BuilderError {
  readonly checks: readonly PreflightCheckRecord[];

  constructor(
    code: BuilderErrorCode,
    details: PreflightDetails = {},
    checks: readonly PreflightCheckRecord[] = [],
    requestId = 'preflight',
  ) {
    super({
      code,
      stage: 'preflight',
      details,
      retryable: retryableCodes.has(code),
      requestId,
      diagnosis: PREFLIGHT_ERROR_CATALOG[code]?.diagnosis ?? `Preflight failed with code ${code}.`,
      recovery: PREFLIGHT_ERROR_CATALOG[code]?.recovery ?? 'Review the recorded preflight evidence and retry with a corrected request.',
    });
    this.name = 'PreflightError';
    this.checks = Object.freeze([...checks]);
  }

  override toJSON() { return Object.freeze({ ...super.toJSON(), checks: this.checks }); }
}

export interface PreflightRequest {
  readonly branch: string;
  readonly expectedSha: string;
  readonly targetId: TargetId;
  readonly outputRootId: string;
}

export interface PreflightRepositoryCapability {
  readonly inspect: (repositoryPath: string) => Promise<{ readonly isGitWorktree: boolean }>;
}

export interface PreflightDirectoryInspection {
  readonly path: string;
  readonly canonical: boolean;
  readonly writable: boolean;
  readonly symlink: boolean;
  readonly device: number;
  readonly inode: number;
  readonly mountId: number;
}

export interface PreflightReleasePathInspection {
  readonly finalExists: boolean;
  readonly finalSymlink: boolean;
  readonly parentWritable: boolean;
  readonly unsafeAncestor?: 'symlink' | 'not-directory';
}

export interface PreflightPathCapability {
  readonly inspectWorktreeFilesystem: (loadedConfig: LoadedConfig) => Promise<PreflightDirectoryInspection>;
  readonly inspectApprovedRoot: (loadedConfig: LoadedConfig, rootId: string) => Promise<PreflightDirectoryInspection>;
  readonly inspectStaging: (loadedConfig: LoadedConfig, rootId: string) => Promise<PreflightDirectoryInspection>;
  readonly inspectReleasePath: (loadedConfig: LoadedConfig, rootId: string, relativeComponents: readonly string[]) => Promise<PreflightReleasePathInspection>;
}

export interface PreflightFileSystemCapability {
  readonly statfs: (path: string) => Promise<{ readonly freeBytes: number }>;
}

export interface PreflightExecOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxBuffer: number;
  readonly shell: false;
}

export interface PreflightExecCapability {
  readonly run: (executable: string, argv: readonly string[], options: PreflightExecOptions) => Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number | null;
  }>;
}

export interface PreflightExecutableCapability {
  readonly check: (name: TrustedPreflightExecutable, path: string) => Promise<{ readonly path: string; readonly version: string }>;
}

export interface PreflightManifestCapability {
  readonly inspect: (manifest: LoadedManifest, targetId: TargetId) => { readonly sha256: string; readonly target: TargetManifest | undefined };
}

export interface PreflightDockerCapability {
  readonly inspectLockedImage: (imageReference: string) => Promise<{
    readonly available: boolean;
    readonly imageReference: string;
    readonly imageDigest: string | null;
    readonly imageId: string | null;
    readonly clientVersion: string | null;
    readonly serverVersion: string | null;
    readonly architecture: string | null;
    readonly os: string | null;
  }>;
}

export interface PreflightSystemdCapability {
  readonly checkUserManager: () => Promise<{ readonly available: boolean; readonly runnerActive: boolean }>;
}

export interface PreflightLockCapability { readonly read: (path: string) => Promise<string>; }
export interface PreflightClockCapability { readonly now: () => Date; }
export interface PreflightSourceCapability { readonly resolveAtAcceptance: (branch: unknown, expectedSha: unknown) => Promise<Readonly<GitResolutionMetadata>>; }

export interface PreflightCapabilities {
  readonly clock: PreflightClockCapability;
  readonly sourceResolver: PreflightSourceCapability;
  readonly manifest: PreflightManifestCapability;
  readonly repository: PreflightRepositoryCapability;
  readonly fileSystem: PreflightFileSystemCapability;
  readonly paths: PreflightPathCapability;
  readonly executables: PreflightExecutableCapability;
  readonly docker: PreflightDockerCapability;
  readonly systemd: PreflightSystemdCapability;
  readonly lock: PreflightLockCapability;
}

export interface PreflightServiceOptions {
  readonly loadedConfig: LoadedConfig;
  readonly manifest: LoadedManifest;
  readonly capabilities: PreflightCapabilities;
  readonly idFactory: () => string;
  readonly requestId?: string;
  readonly maxCacheEntries?: number;
}

export interface PreflightResult {
  readonly preflightId: string;
  readonly branch: string;
  readonly expectedSha: string;
  readonly observedSha: string;
  readonly target: TargetManifest;
  readonly outputRoot: ApprovedOutputRoot;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly checks: readonly PreflightCheckRecord[];
}

function passed(id: PreflightCheckId, details: PreflightDetails): PreflightCheckRecord {
  return Object.freeze({ id, status: 'passed', details: Object.freeze({ ...details }) });
}
function failed(id: PreflightCheckId, code: BuilderErrorCode, details: PreflightDetails): PreflightCheckRecord {
  return Object.freeze({ id, status: 'failed', errorCode: code, details: Object.freeze({ ...details }) });
}
function isTarget(value: unknown): value is TargetId { return value === 'rpi-5' || value === 'rpi-2'; }
function asDockerDigest(value: string | null): string | null { return value?.startsWith('sha256:') ? value.slice(7) : value; }
function isBoundedText(value: string | null): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f\n\r]/u.test(value); }
function isDockerImageId(value: string | null): value is string { return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value); }
function immutable<T extends object>(value: T): Readonly<T> { return Object.freeze(value); }

export class PreflightService {
  readonly #loadedConfig: LoadedConfig;
  readonly #config: BuilderConfig;
  readonly #manifest: LoadedManifest;
  readonly #capabilities: PreflightCapabilities;
  readonly #idFactory: () => string;
  readonly #requestId: string;
  readonly #capacity: number;
  readonly #results = new Map<string, PreflightResult>();
  readonly #reservedIds = new Set<string>();

  constructor(options: PreflightServiceOptions) {
    this.#loadedConfig = options.loadedConfig;
    this.#config = options.loadedConfig.config;
    this.#manifest = options.manifest;
    this.#capabilities = options.capabilities;
    this.#idFactory = options.idFactory;
    this.#requestId = options.requestId ?? 'preflight';
    if (options.maxCacheEntries !== undefined && (!Number.isSafeInteger(options.maxCacheEntries) || options.maxCacheEntries < 1 || options.maxCacheEntries > 1_000)) throw new TypeError('maxCacheEntries must be a safe integer from 1 through 1000');
    this.#capacity = options.maxCacheEntries ?? this.#config.maxQueueLength;
  }

  async run(request: PreflightRequest): Promise<PreflightResult> {
    const now = this.#validNow();
    this.#pruneExpired(now);
    let preflightId: string;
    try { preflightId = this.#idFactory(); } catch { throw this.#error('PREFLIGHT_INVALID_ID', { reason: 'ID factory failed' }); }
    if (!PREFLIGHT_ID.test(preflightId)) throw this.#error('PREFLIGHT_INVALID_ID', { preflightId });
    if (this.#results.has(preflightId) || this.#reservedIds.has(preflightId)) throw this.#error('PREFLIGHT_CACHE_DUPLICATE', { preflightId });
    if (this.#results.size + this.#reservedIds.size >= this.#capacity) throw this.#error('PREFLIGHT_CACHE_FULL', { capacity: this.#capacity });
    this.#reservedIds.add(preflightId);
    try {
      const result = await this.#evaluate(request, preflightId);
      this.#results.set(preflightId, result);
      return result;
    } finally {
      this.#reservedIds.delete(preflightId);
    }
  }

  async accept(preflightId: string, request: PreflightRequest): Promise<PreflightResult> {
    if (!PREFLIGHT_ID.test(preflightId)) throw this.#error('PREFLIGHT_INVALID_ID', { preflightId });
    const previous = this.#results.get(preflightId);
    if (previous === undefined) throw this.#error('PREFLIGHT_NOT_FOUND', { preflightId });
    const now = this.#validNow();
    if (now.getTime() >= Date.parse(previous.expiresAt)) {
      this.#pruneExpired(now);
      throw this.#error('PREFLIGHT_EXPIRED', { preflightId, expiresAt: previous.expiresAt, checkedAt: now.toISOString() });
    }
    if (request.branch !== previous.branch || request.expectedSha !== previous.expectedSha
      || request.targetId !== previous.target.id || request.outputRootId !== previous.outputRoot.id) {
      throw this.#error('PREFLIGHT_REQUEST_MISMATCH', { preflightId });
    }
    const rechecked = await this.#evaluate(request, preflightId);
    const completedAt = this.#validNow();
    if (completedAt.getTime() >= Date.parse(previous.expiresAt)) {
      throw this.#error('PREFLIGHT_EXPIRED', { preflightId, expiresAt: previous.expiresAt, checkedAt: completedAt.toISOString() }, rechecked.checks);
    }
    return immutable({ ...rechecked, preflightId, createdAt: previous.createdAt, expiresAt: previous.expiresAt });
  }

  #validNow(): Date {
    const now = this.#capabilities.clock.now();
    if (!Number.isFinite(now.getTime())) throw this.#error('SOURCE_UNAVAILABLE', { reason: 'clock unavailable' });
    return now;
  }

  #pruneExpired(now: Date): void {
    for (const [id, result] of this.#results) if (now.getTime() >= Date.parse(result.expiresAt)) this.#results.delete(id);
  }

  #error(code: BuilderErrorCode, details: PreflightDetails, checks: readonly PreflightCheckRecord[] = []): PreflightError {
    return new PreflightError(code, details, checks, this.#requestId);
  }

  async #evaluate(request: PreflightRequest, preflightId: string): Promise<PreflightResult> {
    const checks: PreflightCheckRecord[] = [];
    const created = this.#validNow();
    const createdAt = created.toISOString();
    const expiresAt = new Date(created.getTime() + PREFLIGHT_TTL_MS).toISOString();
    if (!isTarget(request.targetId)) throw this.#error('PREFLIGHT_INVALID_TARGET', { targetId: String(request.targetId) });
    if (typeof request.branch !== 'string' || request.branch.length === 0) throw this.#error('INVALID_BRANCH', { branch: String(request.branch) });
    if (typeof request.expectedSha !== 'string' || !SHA40.test(request.expectedSha)) throw this.#error('INVALID_SHA', { expectedSha: String(request.expectedSha) });
    let outputRoot: ApprovedOutputRoot;
    try { outputRoot = resolveApprovedRoot(this.#config, request.outputRootId); } catch { throw this.#error('PREFLIGHT_INVALID_OUTPUT_ROOT', { outputRootId: request.outputRootId }); }

    let source: Readonly<GitResolutionMetadata>;
    try { source = await this.#capabilities.sourceResolver.resolveAtAcceptance(request.branch, request.expectedSha); } catch (error) {
      const sourceCodes: readonly SourceResolverCode[] = ['INVALID_BRANCH', 'INVALID_SHA', 'ORIGIN_NOT_SSH', 'GIT_FETCH_FAILED', 'SOURCE_NOT_COMMIT', 'BRANCH_MOVED'];
      const code: BuilderErrorCode = error instanceof SourceResolverError && sourceCodes.includes(error.code as (typeof sourceCodes)[number]) ? error.code as BuilderErrorCode : 'SOURCE_UNAVAILABLE';
      const details = { ...(error instanceof SourceResolverError ? error.details : {}), branch: request.branch, expectedSha: request.expectedSha };
      throw this.#error(code, details, [failed('source-sha', code, details)]);
    }
    if (source.sha !== request.expectedSha) throw this.#error('BRANCH_MOVED', { branch: request.branch, expectedSha: request.expectedSha, observedSha: source.sha }, [failed('source-sha', 'BRANCH_MOVED', { expectedSha: request.expectedSha, observedSha: source.sha })]);
    checks.push(passed('source-sha', { expectedSha: request.expectedSha, observedSha: source.sha, remote: source.remote }));

    try {
      const repository = await this.#capabilities.repository.inspect(this.#config.repository.path);
      if (!repository.isGitWorktree) throw new Error('not a Git worktree');
      checks.push(passed('repository', { path: this.#config.repository.path, isGitWorktree: true }));
    } catch { throw this.#error('REPOSITORY_UNAVAILABLE', { path: this.#config.repository.path }, [...checks, failed('repository', 'REPOSITORY_UNAVAILABLE', {})]); }

    let worktree: PreflightDirectoryInspection;
    try { worktree = await this.#capabilities.paths.inspectWorktreeFilesystem(this.#loadedConfig); }
    catch { throw this.#error('PREFLIGHT_DISK_SPACE', { path: this.#loadedConfig.stateRoot }, [...checks, failed('disk-worktree', 'PREFLIGHT_DISK_SPACE', { path: this.#loadedConfig.stateRoot })]); }
    const freeWorktree = await this.#readFreeSpace(worktree.path, 'disk-worktree', checks);
    const freeOutput = await this.#readFreeSpace(outputRoot.path, 'disk-output', checks);
    if (freeWorktree < this.#config.diskFreeMinimumBytes || freeOutput < this.#config.diskFreeMinimumBytes) throw this.#error('PREFLIGHT_DISK_SPACE', { minimumBytes: this.#config.diskFreeMinimumBytes, worktreeFreeBytes: freeWorktree, outputFreeBytes: freeOutput }, checks);

    for (const name of Object.keys(TRUSTED_PREFLIGHT_EXECUTABLES) as TrustedPreflightExecutable[]) {
      const id = `executable-${name}` as PreflightCheckId;
      try {
        const result = await this.#capabilities.executables.check(name, TRUSTED_PREFLIGHT_EXECUTABLES[name]);
        checks.push(passed(id, { path: result.path, version: result.version }));
      } catch { const code: BuilderErrorCode = name === 'docker' ? 'DOCKER_UNAVAILABLE' : 'TOOL_UNAVAILABLE'; throw this.#error(code, { executable: name, path: TRUSTED_PREFLIGHT_EXECUTABLES[name] }, [...checks, failed(id, code, {})]); }
    }

    try {
      const systemd = await this.#capabilities.systemd.checkUserManager();
      if (!systemd.available || systemd.runnerActive) throw new Error('systemd user manager unavailable or busy');
      checks.push(passed('systemd-user-manager', { available: true, runnerActive: false }));
    } catch { throw this.#error('SYSTEMD_USER_UNAVAILABLE', {}, [...checks, failed('systemd-user-manager', 'SYSTEMD_USER_UNAVAILABLE', {})]); }

    let lock: BuilderLock;
    try {
      const parsed = JSON.parse(await this.#capabilities.lock.read(this.#config.builderLockPath)) as unknown;
      const installedVersion = this.#config.builderLockPath.split('/').at(-2);
      if (!installedVersion) throw new Error('builder lock install version missing');
      const validation = validateBuilderLock(parsed, installedVersion);
      if (!validation.ok) throw new Error(validation.reason);
      lock = validation.lock;
      checks.push(passed('builder-lock', { packageVersion: lock.packageVersion, imageRepository: lock.imageRepository, imageDigest: lock.imageDigest, baseImageDigest: lock.baseImageDigest, dockerfileSha256: lock.dockerfileSha256, executionDefinitionSha256: lock.executionDefinitionSha256 }));
    } catch { throw this.#error('BUILDER_LOCK_INVALID', { path: this.#config.builderLockPath }, [...checks, failed('builder-lock', 'BUILDER_LOCK_INVALID', {})]); }

    const imageReference = `${lock.imageRepository}@sha256:${lock.imageDigest}`;
    try {
      const image = await this.#capabilities.docker.inspectLockedImage(imageReference);
      if (!image.available || !isBoundedText(image.clientVersion) || !isBoundedText(image.serverVersion)
        || !isDockerImageId(image.imageId) || image.imageDigest === null || !SHA256.test(asDockerDigest(image.imageDigest) ?? '')) throw new Error('Docker evidence unavailable');
      if (image.architecture !== 'amd64') throw new Error('Docker architecture mismatch');
      if (image.imageReference !== imageReference || asDockerDigest(image.imageDigest) !== lock.imageDigest) throw new Error('Docker image digest mismatch');
      if (lock.imageId !== undefined && image.imageId !== `sha256:${lock.imageId}`) throw new Error('Docker image ID mismatch');
      checks.push(passed('docker-builder-image', { imageReference, imageDigest: lock.imageDigest, imageId: image.imageId, clientVersion: image.clientVersion, serverVersion: image.serverVersion }));
    } catch (error) {
      const mismatch = error instanceof Error && (error.message === 'Docker image digest mismatch' || error.message === 'Docker image ID mismatch');
      const code: BuilderErrorCode = mismatch ? 'BUILDER_DIGEST_MISMATCH' : 'DOCKER_UNAVAILABLE';
      throw this.#error(code, { imageReference, imageDigest: lock.imageDigest }, [...checks, failed('docker-builder-image', code, {})]);
    }

    let selection: { readonly sha256: string; readonly target: TargetManifest | undefined };
    try { selection = this.#capabilities.manifest.inspect(this.#manifest, request.targetId); }
    catch { throw this.#error('TARGET_MANIFEST_INVALID', { targetId: request.targetId }, [...checks, failed('target-manifest', 'TARGET_MANIFEST_INVALID', {})]); }
    const target = selection.target;
    if (target === undefined) throw this.#error('TARGET_MANIFEST_INVALID', { targetId: request.targetId }, [...checks, failed('target-manifest', 'TARGET_MANIFEST_INVALID', {})]);
    checks.push(passed('target-manifest', { targetId: target.id, manifestSha256: selection.sha256, environment: target.environment }));
    let root: PreflightDirectoryInspection;
    try { root = await this.#capabilities.paths.inspectApprovedRoot(this.#loadedConfig, outputRoot.id); } catch { throw this.#error('OUTPUT_ROOT_INVALID', { rootId: outputRoot.id }, [...checks, failed('approved-output-root', 'OUTPUT_ROOT_INVALID', {})]); }
    if (!root.canonical || !root.writable || root.symlink) throw this.#error('OUTPUT_ROOT_INVALID', { rootId: outputRoot.id }, [...checks, failed('approved-output-root', 'OUTPUT_ROOT_INVALID', {})]);
    checks.push(passed('approved-output-root', { rootId: outputRoot.id, path: root.path, canonical: true, writable: true, device: root.device, mountId: root.mountId, inode: root.inode }));
    let staging: PreflightDirectoryInspection;
    try { staging = await this.#capabilities.paths.inspectStaging(this.#loadedConfig, outputRoot.id); } catch { throw this.#error('STAGING_DIRECTORY_INVALID', { rootId: outputRoot.id }, [...checks, failed('staging-directory', 'STAGING_DIRECTORY_INVALID', {})]); }
    if (!staging.canonical || !staging.writable || staging.symlink) throw this.#error('STAGING_DIRECTORY_INVALID', { path: staging.path }, [...checks, failed('staging-directory', 'STAGING_DIRECTORY_INVALID', {})]);
    checks.push(passed('staging-directory', { path: staging.path, canonical: true, writable: true, device: staging.device, mountId: staging.mountId, inode: staging.inode }));
    if (root.mountId !== staging.mountId) throw this.#error('STAGING_FILESYSTEM_MISMATCH', { outputRoot: root.path, stagingPath: staging.path, outputMountId: root.mountId, stagingMountId: staging.mountId }, [...checks, failed('same-filesystem-staging', 'STAGING_FILESYSTEM_MISMATCH', {})]);
    checks.push(passed('same-filesystem-staging', { outputRoot: root.path, stagingPath: staging.path, outputMountId: root.mountId, stagingMountId: staging.mountId }));
    const releaseComponents = [encodeBranchSlug(request.branch), source.sha, target.id] as const;
    const releasePath = join(root.path, ...releaseComponents);
    try {
      const collision = await this.#capabilities.paths.inspectReleasePath(this.#loadedConfig, outputRoot.id, releaseComponents);
      if (collision.finalExists || collision.finalSymlink || !collision.parentWritable || collision.unsafeAncestor !== undefined) throw new Error('release path is unsafe or collides');
      checks.push(passed('output-collision', { releasePath, exists: false, parentWritable: true }));
    } catch { throw this.#error('OUTPUT_COLLISION', { releasePath }, [...checks, failed('output-collision', 'OUTPUT_COLLISION', {})]); }
    return immutable({ preflightId, branch: request.branch, expectedSha: request.expectedSha, observedSha: source.sha, target, outputRoot, createdAt, expiresAt, checks: Object.freeze(checks) });
  }

  async #readFreeSpace(path: string, id: 'disk-worktree' | 'disk-output', checks: PreflightCheckRecord[]): Promise<number> {
    try {
      const result = await this.#capabilities.fileSystem.statfs(path);
      if (!Number.isSafeInteger(result.freeBytes) || result.freeBytes < 0) throw new Error('invalid free-space value');
      checks.push(passed(id, { path, freeBytes: result.freeBytes, minimumBytes: this.#config.diskFreeMinimumBytes }));
      return result.freeBytes;
    } catch { checks.push(failed(id, 'PREFLIGHT_DISK_SPACE', { path })); throw this.#error('PREFLIGHT_DISK_SPACE', { path }, checks); }
  }
}

export const FIXED_PREFLIGHT_ENV = Object.freeze({
  PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C', NO_COLOR: '1',
  npm_config_update_notifier: 'false', npm_config_fund: 'false',
} as const);
export interface PreflightSystemdPathStats {
  readonly uid: number;
  readonly mode: number;
  readonly isSymbolicLink: () => boolean;
  readonly isDirectory: () => boolean;
  readonly isSocket: () => boolean;
}
export interface PreflightSystemdPathFs {
  readonly lstat: (path: string) => Promise<PreflightSystemdPathStats>;
  readonly realpath: (path: string) => Promise<string>;
}
const defaultSystemdPathFs: PreflightSystemdPathFs = { lstat, realpath };

export async function deriveSystemdBusEnvironment(options: { readonly uid?: number; readonly fs?: PreflightSystemdPathFs } = {}): Promise<Readonly<{ XDG_RUNTIME_DIR: string; DBUS_SESSION_BUS_ADDRESS: string }>> {
  const uid = options.uid ?? (typeof process.geteuid === 'function' ? process.geteuid() : -1);
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('effective service UID is unavailable');
  const runtimeDir = `/run/user/${uid}`;
  const busPath = `${runtimeDir}/bus`;
  if (runtimeDir.length > 128 || !/^\/run\/user\/\d+$/u.test(runtimeDir)) throw new Error('runtime directory is not bounded');
  const pathFs = options.fs ?? defaultSystemdPathFs;
  const runtime = await pathFs.lstat(runtimeDir);
  if (runtime.isSymbolicLink() || !runtime.isDirectory() || runtime.uid !== uid || (runtime.mode & 0o777) !== 0o700 || await pathFs.realpath(runtimeDir) !== runtimeDir) throw new Error('runtime directory is unsafe');
  const bus = await pathFs.lstat(busPath);
  if (bus.isSymbolicLink() || !bus.isSocket() || bus.uid !== uid || (bus.mode & 0o600) !== 0o600 || await pathFs.realpath(busPath) !== busPath) throw new Error('systemd user bus is unsafe');
  return Object.freeze({ XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${busPath}` });
}
const VERSION_ARGV: Readonly<Record<TrustedPreflightExecutable, readonly string[]>> = Object.freeze({
  git: Object.freeze(['--version']), docker: Object.freeze(['--version']), node: Object.freeze(['--version']),
  npm: Object.freeze(['--version']), sqlite3: Object.freeze(['--version']), systemctl: Object.freeze(['--version']),
});
const execFile = promisify(execFileCallback);

const defaultPreflightExec: PreflightExecCapability = {
  async run(executable, argv, options) {
    try {
      const result = await execFile(executable, [...argv], { env: options.env, timeout: options.timeoutMs, maxBuffer: options.maxBuffer, shell: options.shell });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
      return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: typeof failure.code === 'number' ? failure.code : 1 };
    }
  },
};

function commandOptions(env: Readonly<Record<string, string>> = FIXED_PREFLIGHT_ENV): PreflightExecOptions { return { env, timeoutMs: PREFLIGHT_COMMAND_TIMEOUT_MS, maxBuffer: PREFLIGHT_COMMAND_MAX_BUFFER, shell: false }; }
function parseJson(stdout: string): Record<string, unknown> { const value: unknown = JSON.parse(stdout); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('structured command output is invalid'); return value as Record<string, unknown>; }
async function command(exec: PreflightExecCapability, executable: string, argv: readonly string[], allowEmpty = false, allowedExitCodes: readonly number[] = [0], env: Readonly<Record<string, string>> = FIXED_PREFLIGHT_ENV): Promise<string> {
  const result = await exec.run(executable, argv, commandOptions(env));
  if (!allowedExitCodes.includes(result.exitCode ?? -1) || result.stdout.length > PREFLIGHT_COMMAND_MAX_BUFFER || (!allowEmpty && result.stdout.trim().length === 0)) throw new Error('trusted command failed');
  return result.stdout;
}

async function inspectDirectory(path: string): Promise<PreflightDirectoryInspection> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('directory is not canonical');
  const canonicalPath = await realpath(path);
  await access(canonicalPath, fsConstants.W_OK);
  const handle = await open(canonicalPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const held = await handle.stat();
    if (held.dev !== stats.dev || held.ino !== stats.ino) throw new Error('directory identity changed');
    const fdinfo = await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
    const mountId = Number(fdinfo.match(/^mnt_id:\s*(\d+)\s*$/m)?.[1] ?? NaN);
    if (!Number.isSafeInteger(mountId)) throw new Error('mount identity unavailable');
    return { path: canonicalPath, canonical: canonicalPath === resolve(path), writable: true, symlink: false, device: held.dev, inode: held.ino, mountId };
  } finally { await handle.close(); }
}

function authorityPaths(): PreflightPathCapability {
  const inspectAuthority = async (loadedConfig: LoadedConfig, rootId: string, relative = ''): Promise<PreflightDirectoryInspection> => withApprovedRootSnapshot(loadedConfig.pathAuthorities.approvedRoots, rootId, async ({ snapshot }) => inspectDirectory(relative ? join(snapshot.path, relative) : snapshot.path));
  return {
    inspectWorktreeFilesystem: async (loadedConfig) => withStateRootSnapshot(loadedConfig.pathAuthorities.stateRoot, async ({ snapshot }) => inspectDirectory(snapshot.path)),
    inspectApprovedRoot: (loadedConfig, rootId) => inspectAuthority(loadedConfig, rootId),
    inspectStaging: async (loadedConfig, rootId) => withHeldParentUnderRoot(loadedConfig.pathAuthorities.approvedRoots, rootId, '.osi-image-builder', async (parent) => {
      const inspected = await parent.inspectDirectory('staging');
      return { path: join(resolveApprovedRoot(loadedConfig.config, rootId).path, '.osi-image-builder/staging'), canonical: true, symlink: false, ...inspected };
    }),
    inspectReleasePath: (loadedConfig, rootId, components) => inspectReleasePathUnderRoot(loadedConfig.pathAuthorities.approvedRoots, rootId, components),
  };
}

export function createReadOnlyPreflightDefaults(options: { readonly exec?: PreflightExecCapability; readonly systemdBusEnvironment?: () => Promise<Readonly<{ XDG_RUNTIME_DIR: string; DBUS_SESSION_BUS_ADDRESS: string }>> } = {}): Omit<PreflightCapabilities, 'clock' | 'sourceResolver'> {
  const commandExecutor = options.exec ?? defaultPreflightExec;
  const systemdBusEnvironment = options.systemdBusEnvironment ?? (() => deriveSystemdBusEnvironment());
  return {
    paths: authorityPaths(),
    fileSystem: { statfs: async (path) => { const result = await statfs(path); return { freeBytes: Number(result.bavail) * Number(result.bsize) }; } },
    repository: { inspect: async (repositoryPath) => ({ isGitWorktree: (await command(commandExecutor, TRUSTED_PREFLIGHT_EXECUTABLES.git, ['-C', repositoryPath, 'rev-parse', '--is-inside-work-tree'])).trim() === 'true' }) },
    manifest: { inspect: (loaded, targetId) => ({ sha256: loaded.sha256, target: loaded.manifest.targets.find((target) => target.id === targetId) }) },
    executables: { check: async (name, path) => { if (path !== TRUSTED_PREFLIGHT_EXECUTABLES[name]) throw new Error('untrusted executable path'); const stdout = await command(commandExecutor, path, VERSION_ARGV[name]); return { path, version: stdout.trim().split(/\r?\n/u)[0]! }; } },
    systemd: { checkUserManager: async () => { try { const busEnv = Object.freeze({ ...FIXED_PREFLIGHT_ENV, ...(await systemdBusEnvironment()) }); const manager = await command(commandExecutor, TRUSTED_PREFLIGHT_EXECUTABLES.systemctl, ['--user', 'is-system-running'], false, [0, 1], busEnv); const active = await command(commandExecutor, TRUSTED_PREFLIGHT_EXECUTABLES.systemctl, ['--user', 'list-units', '--type=service', '--state=active,activating', '--no-legend', 'osi-image-builder-runner@*.service'], true, [0], busEnv); return { available: /^(running|degraded)$/u.test(manager.trim()), runnerActive: active.trim().length > 0 }; } catch { return { available: false, runnerActive: false }; } } },
    docker: { inspectLockedImage: async (imageReference) => { const version = parseJson(await command(commandExecutor, TRUSTED_PREFLIGHT_EXECUTABLES.docker, ['version', '--format', '{{json .}}'])); const inspected = parseJson(await command(commandExecutor, TRUSTED_PREFLIGHT_EXECUTABLES.docker, ['image', 'inspect', '--format', '{{json .}}', imageReference])); const clientVersion = typeof version.Client === 'object' && version.Client !== null && isBoundedText((version.Client as Record<string, unknown>).Version as string | null) ? (version.Client as Record<string, string>).Version : null; const serverVersion = typeof version.Server === 'object' && version.Server !== null && isBoundedText((version.Server as Record<string, unknown>).Version as string | null) ? (version.Server as Record<string, string>).Version : null; const architecture = typeof inspected.Architecture === 'string' ? inspected.Architecture : null; const os = typeof inspected.Os === 'string' ? inspected.Os : null; const imageId = isDockerImageId(typeof inspected.Id === 'string' ? inspected.Id : null) ? inspected.Id as string : null; const expectedRepository = imageReference.slice(0, imageReference.lastIndexOf('@')); const expectedDigest = imageReference.slice(imageReference.lastIndexOf('@') + 1); const repoDigests = Array.isArray(inspected.RepoDigests) ? inspected.RepoDigests.filter((item): item is string => typeof item === 'string' && item.length <= 512) : []; const imageDigest = repoDigests.includes(`${expectedRepository}@${expectedDigest}`) && /^sha256:[0-9a-f]{64}$/u.test(expectedDigest) ? expectedDigest : null; return { available: clientVersion !== null && serverVersion !== null && architecture === 'amd64' && os === 'linux' && imageId !== null && imageDigest !== null, imageReference, imageDigest: imageDigest === null ? null : imageDigest, imageId, clientVersion, serverVersion, architecture, os }; } },
    lock: { read: async (path) => readFile(path, 'utf8') },
  };
}
