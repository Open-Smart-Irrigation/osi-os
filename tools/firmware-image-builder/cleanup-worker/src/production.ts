import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { deriveSystemdBusEnvironment, FIXED_PREFLIGHT_ENV } from '../../api/src/preflight.js';
import {
  loadConfig,
  loadStateRootAuthority,
  withApprovedRootSnapshot as withApprovedRootAuthoritySnapshot,
  withStateRootSnapshot as withStateRootAuthoritySnapshot,
  type LoadedConfig,
  type LoadedStateRoot,
} from '../../config/load.js';
import { validateBuilderLock } from '../../domain/builder-lock.js';
import {
  createCleanupWorker,
  CLEANUP_ADMISSION_ID_PATTERN,
  CleanupWorkerError,
  type CleanupDocker,
  type CleanupDockerContainer,
  type CleanupEvidenceWriter,
  type CleanupLogSeal,
  type CleanupLogSealer,
  type CleanupQuarantine,
  type CleanupRunnerSystemd,
  type CleanupWorkerClock,
  type CleanupWorkerOptions,
  type CleanupWorkerResult,
} from './main.js';
import {
  createRecoveryFileSystem,
  type RecoveryDescriptorFileSystem,
  type RecoveryDirectoryHandle,
  type RecoveryFileHandle,
} from '../../api/src/recovery.js';
import { OwnershipStore } from '../../api/src/ownership.js';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { encodeJson, canonicalInstant, type JsonObject } from '../../api/src/validation.js';
import { createCommandExecutor, type CommandExecutor, type CommandResult } from '../../runner/src/command-executor.js';
import { holdInstalledPublisher, validateInstalledPublisherAuthority } from '../../runner/src/main.js';
import { createPublisherClient, type PublisherClient, type PublisherResponse } from '../../publisher/client.js';

const SYSTEMCTL = '/usr/bin/systemctl';
const DOCKER = '/usr/bin/docker';
const RUNNER_UNIT = /^osi-image-builder-runner@[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.service$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH64 = /^[0-9a-f]{64}$/u;
const FIXED_MAX_CAPTURE_BYTES = 64 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_OWNER = 'cleanup-worker';
const DIRECTORY_MODE = 0o700;
const EVIDENCE_MODE = 0o600;
const MAX_LOG_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_LOG_BYTES = 512 * 1024 * 1024;
const MAX_LOG_GENERATIONS = 128;
const MAX_LOG_EVENTS = 8_192;
const LOG_CHUNK_BYTES = 64 * 1024;
const LABEL_JOB = 'org.osi.image-builder.job-id';
const LABEL_MANIFEST = 'org.osi.image-builder.manifest-sha';
const PUBLISHER_ENV = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });

export interface CleanupPublisherAuthority {
  readonly executable: string;
  readonly expectedVersion: string;
  readonly expectedSourceSha256: string;
  readonly close?: () => Promise<void>;
}

interface ApprovedRootSnapshot {
  readonly id: string;
  readonly path: string;
  readonly quarantinePath: string;
  readonly device: number;
  readonly inode: number;
}

interface StateRootSnapshot {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

type ApprovedRootSnapshotRunner = <T>(
  rootId: string,
  callback: (snapshot: ApprovedRootSnapshot) => Promise<T>,
) => Promise<T>;

type StateRootSnapshotRunner = <T>(callback: (snapshot: StateRootSnapshot) => Promise<T>) => Promise<T>;

export interface CleanupProductionDependencies {
  readonly loadStateRoot?: (options: { readonly env?: NodeJS.ProcessEnv }) => Promise<LoadedStateRoot>;
  readonly loadConfiguration?: (options: { readonly env?: NodeJS.ProcessEnv }) => Promise<LoadedConfig>;
  readonly openDatabase?: (path: string) => DatabaseSync;
  readonly commandExecutor?: CommandExecutor;
  readonly publisherAuthority?: CleanupPublisherAuthority;
  readonly publisherClientFactory?: typeof createPublisherClient;
  readonly systemdEnvironment?: () => Promise<Readonly<Record<string, string>>>;
  readonly fileSystem?: RecoveryDescriptorFileSystem;
  readonly clock?: CleanupWorkerClock;
  readonly ownerUid?: number;
  readonly workerOwner?: string;
  readonly systemdExecutable?: string;
  readonly dockerExecutable?: string;
  readonly commandTimeoutMs?: number;
  readonly approvedRootSnapshot?: ApprovedRootSnapshotRunner;
  readonly stateRootSnapshot?: StateRootSnapshotRunner;
}

export interface CleanupProductionAdapters {
  readonly systemd: CleanupRunnerSystemd;
  readonly docker: CleanupDocker;
  readonly logSealer: CleanupLogSealer;
  readonly quarantine: CleanupQuarantine;
  readonly evidenceWriter: CleanupEvidenceWriter;
}

export interface CleanupProductionComposition {
  readonly worker: ReturnType<typeof createCleanupWorker>;
  readonly adapters: CleanupProductionAdapters;
  readonly stateRoot: string;
  readonly run: (argv: readonly string[]) => Promise<CleanupWorkerResult>;
  readonly close: () => Promise<void>;
}

interface CommandPolicy {
  readonly executor: CommandExecutor;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

interface LogRow {
  readonly stream: string;
  readonly generation: number;
  readonly path: string;
  readonly started_at: string;
  readonly sealed_at: string | null;
  readonly size_bytes: number;
  readonly sha256: string | null;
}

interface LogEventRow {
  readonly stream: string;
  readonly file_generation: number;
  readonly seq: number;
  readonly event_type: string;
  readonly at: string;
  readonly byte_offset: number;
  readonly byte_length: number;
  readonly partial: number;
}

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

interface HashedFile extends FileIdentity {
  readonly sha256: string;
  readonly size: number;
}

function message(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

function workerError(code: string, text: string, cause?: unknown): CleanupWorkerError {
  return new CleanupWorkerError(code, text, cause === undefined ? undefined : { cause });
}

function safeJobId(jobId: string): void {
  if (!JOB_ID.test(jobId)) throw workerError('QUARANTINE_PENDING', 'job ID is not safe for cleanup paths');
}

function safeUnit(unit: string): void {
  if (!RUNNER_UNIT.test(unit)) throw workerError('CLEANUP_ADMISSION_BLOCKED', 'runner unit is not an exact trusted unit');
}

function boundedResult(result: CommandResult, argv: readonly string[], allowedExitCodes: readonly number[]): CommandResult {
  const exitCode = result.exitCode;
  if (
    JSON.stringify(result.argv) !== JSON.stringify(argv)
    || result.signal !== null
    || result.timedOut
    || !Number.isSafeInteger(exitCode)
    || !allowedExitCodes.includes(exitCode as number)
    || Buffer.byteLength(result.stdout, 'utf8') > FIXED_MAX_CAPTURE_BYTES
    || Buffer.byteLength(result.stderr, 'utf8') > FIXED_MAX_CAPTURE_BYTES
  ) {
    throw new Error(`trusted command evidence is invalid: ${argv[0]}`);
  }
  return result;
}

async function runTrusted(policy: CommandPolicy, argv: readonly string[], allowedExitCodes: readonly number[] = [0]): Promise<CommandResult> {
  const result = await policy.executor.run(argv, {
    env: policy.env,
    timeoutMs: policy.timeoutMs,
    maxCaptureBytes: FIXED_MAX_CAPTURE_BYTES,
  });
  return boundedResult(result, argv, allowedExitCodes);
}

function parseSingleLine(stdout: string, field: string): string {
  const lines = stdout.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== 1 || lines[0]!.length === 0 || lines[0]!.includes('\r')) throw new Error(`${field} output is malformed`);
  return lines[0]!;
}

function canonicalJsonObject(value: unknown, field: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} is not an object`);
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' || key.length === 0 || item.length > 4096) throw new Error(`${field} contains an invalid label`);
  }
  return value as JsonObject;
}

function dockerInstant(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '' || /^0001-01-01T00:00:00(?:\.0+)?Z$/u.test(String(value))) return null;
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} is not a timestamp`);
  return parsed.toISOString();
}

function parseDockerInspect(value: unknown): CleanupDockerContainer {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Docker inspect evidence is not an object');
  const root = value as Record<string, unknown>;
  const id = root.Id;
  const rawName = root.Name;
  const config = root.Config;
  const state = root.State;
  if (typeof id !== 'string' || !/^[a-f0-9]{12,64}$/u.test(id) || typeof rawName !== 'string' || !/^\/?[^/\0]+$/u.test(rawName)) throw new Error('Docker identity evidence is invalid');
  if (config === null || typeof config !== 'object' || Array.isArray(config) || state === null || typeof state !== 'object' || Array.isArray(state)) throw new Error('Docker inspect evidence is incomplete');
  const configRecord = config as Record<string, unknown>;
  const stateRecord = state as Record<string, unknown>;
  const image = configRecord.Image;
  const running = stateRecord.Running;
  if (typeof image !== 'string' || typeof running !== 'boolean') throw new Error('Docker image or running evidence is invalid');
  const digest = image.match(/@sha256:([0-9a-f]{64})$/u)?.[1];
  if (digest === undefined) throw new Error('Docker inspect image is not digest bound');
  return {
    id,
    name: rawName.replace(/^\//u, ''),
    imageDigest: digest,
    labels: canonicalJsonObject(configRecord.Labels, 'Docker labels'),
    running,
    stoppedAt: dockerInstant(stateRecord.FinishedAt, 'Docker FinishedAt'),
  };
}

function createSystemdAdapter(policy: CommandPolicy, executable: string): CleanupRunnerSystemd {
  return {
    inspect: async (unit, timeoutMs) => {
      safeUnit(unit);
      const argv = [executable, '--user', 'show', '--no-pager', '--property=ActiveState', '--value', unit] as const;
      const result = await runTrusted({ ...policy, timeoutMs: Math.min(timeoutMs, policy.timeoutMs) }, argv);
      const state = parseSingleLine(result.stdout, 'systemd ActiveState');
      if (!['active', 'activating', 'deactivating', 'reloading', 'inactive', 'failed'].includes(state)) throw new Error('systemd ActiveState evidence is invalid');
      return { unit, active: !['inactive', 'failed'].includes(state), observedAt: result.finishedAt };
    },
  };
}

function createDockerAdapter(policy: CommandPolicy, executable: string): CleanupDocker {
  async function inspect(containerId: string, timeoutMs: number): Promise<CleanupDockerContainer | null> {
    if (!/^[a-f0-9]{12,64}$/u.test(containerId)) throw new Error('Docker container ID is invalid');
    const argv = [executable, 'inspect', '--type=container', '--format', '{{json .}}', containerId] as const;
    const result = await runTrusted({ ...policy, timeoutMs: Math.min(timeoutMs, policy.timeoutMs) }, argv, [0, 1]);
    if (result.exitCode === 1) {
      if (result.stdout !== '' || !/no such object|no such container/iu.test(result.stderr)) throw new Error('Docker missing-container evidence is invalid');
      return null;
    }
    const text = parseSingleLine(result.stdout, 'Docker inspect');
    let value: unknown;
    try { value = JSON.parse(text) as unknown; } catch (error) { throw new Error('Docker inspect JSON is malformed', { cause: error }); }
    if (JSON.stringify(value) !== text) throw new Error('Docker inspect JSON is not canonical');
    return parseDockerInspect(value);
  }

  async function waitForStopped(containerId: string, timeoutMs: number): Promise<CleanupDockerContainer> {
    const observed = await inspect(containerId, timeoutMs);
    if (observed === null || observed.running || observed.stoppedAt === null) throw new Error('Docker stop did not produce stopped evidence');
    return observed;
  }

  return {
    inspect,
    stop: async (containerId, timeoutMs) => {
      if (!/^[a-f0-9]{12,64}$/u.test(containerId)) throw new Error('Docker container ID is invalid');
      await runTrusted({ ...policy, timeoutMs: Math.min(timeoutMs, policy.timeoutMs) }, [executable, 'stop', '--time=10', containerId]);
    },
    waitForStopped,
    remove: async (containerId, timeoutMs) => {
      if (!/^[a-f0-9]{12,64}$/u.test(containerId)) throw new Error('Docker container ID is invalid');
      await runTrusted({ ...policy, timeoutMs: Math.min(timeoutMs, policy.timeoutMs) }, [executable, 'rm', containerId]);
    },
    listByLabels: async (labels, timeoutMs) => {
      const job = labels[LABEL_JOB];
      const manifest = labels[LABEL_MANIFEST];
      if (typeof job !== 'string' || typeof manifest !== 'string' || !JOB_ID.test(job) || !HASH64.test(manifest) || Object.keys(labels).length !== 2) throw new Error('Docker label query is not exact');
      const argv = [
        executable, 'ps', '--all', '--no-trunc',
        '--filter', `${LABEL_JOB}=${job}`,
        '--filter', `${LABEL_MANIFEST}=${manifest}`,
        '--format', '{{json .ID}}',
      ] as const;
      const result = await runTrusted({ ...policy, timeoutMs: Math.min(timeoutMs, policy.timeoutMs) }, argv);
      const output = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
      if (output === '') return [];
      const ids = output.split('\n');
      if (ids.length > 1024 || ids.some((line) => line.length === 0 || line.includes('\r'))) throw new Error('Docker label listing is malformed');
      const unique = new Set<string>();
      const containers: CleanupDockerContainer[] = [];
      for (const line of ids) {
        let parsed: unknown;
        try { parsed = JSON.parse(line) as unknown; } catch (error) { throw new Error('Docker label listing JSON is malformed', { cause: error }); }
        if (JSON.stringify(parsed) !== line || typeof parsed !== 'string' || !/^[a-f0-9]{12,64}$/u.test(parsed) || unique.has(parsed)) throw new Error('Docker label listing identity is invalid');
        unique.add(parsed);
        const item = await inspect(parsed, timeoutMs);
        if (item === null) throw new Error('Docker label listing changed while inspected');
        containers.push(item);
      }
      return containers;
    },
  };
}

function safeRelative(value: string, prefix: string): string {
  if (!value.startsWith(`${prefix}/`) || value.includes('\\') || value.split('/').some((part) => part.length === 0 || part === '.' || part === '..')) throw workerError('QUARANTINE_PENDING', 'artifact path is outside the fixed staging directory');
  return value.slice(prefix.length + 1);
}

const DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const FILE_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;

function descriptorChild(parent: FileHandle, name: string, code: 'QUARANTINE_PENDING' | 'RECOVERY_LOG_GAP'): string {
  if (name.length === 0 || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) throw workerError(code, 'descriptor child name is unsafe');
  return `/proc/self/fd/${parent.fd}/${name}`;
}

async function openDirectoryChild(parent: FileHandle, name: string, code: 'QUARANTINE_PENDING' | 'RECOVERY_LOG_GAP'): Promise<FileHandle> {
  return open(descriptorChild(parent, name, code), DIRECTORY_FLAGS);
}

async function openOptionalDirectoryChild(parent: FileHandle, name: string, code: 'QUARANTINE_PENDING' | 'RECOVERY_LOG_GAP'): Promise<FileHandle | null> {
  try {
    return await openDirectoryChild(parent, name, code);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function fileIdentity(stats: { readonly dev: number; readonly ino: number }): FileIdentity {
  return { device: stats.dev, inode: stats.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function verifyDirectoryHandle(handle: FileHandle, expected: FileIdentity | null, field: string): Promise<FileIdentity> {
  const stats = await handle.stat();
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${field} is not a real directory`);
  const identity = fileIdentity(stats);
  if (expected !== null && !sameIdentity(identity, expected)) throw new Error(`${field} identity changed`);
  return identity;
}

async function hashFileHandle(handle: FileHandle, field: string): Promise<HashedFile> {
  const before = await handle.stat();
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_LOG_BYTES) throw new Error(`${field} is unsafe or oversized`);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(LOG_CHUNK_BYTES);
  let total = 0;
  while (total < before.size) {
    const result = await handle.read(buffer, 0, Math.min(buffer.length, before.size - total), total);
    if (result.bytesRead <= 0) throw new Error(`${field} changed while hashing`);
    hash.update(buffer.subarray(0, result.bytesRead));
    total += result.bytesRead;
  }
  const after = await handle.stat();
  if (total !== before.size || after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino) throw new Error(`${field} changed while hashing`);
  return { ...fileIdentity(before), sha256: hash.digest('hex'), size: total };
}

async function openRelativeFile(parent: FileHandle, relative: string, code: 'QUARANTINE_PENDING' | 'RECOVERY_LOG_GAP'): Promise<{ readonly file: FileHandle; readonly handles: readonly FileHandle[] }> {
  const parts = relative.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..' || part.includes('\\'))) throw workerError(code, 'relative file path is unsafe');
  const handles: FileHandle[] = [];
  let current = parent;
  try {
    for (const part of parts.slice(0, -1)) {
      const child = await openDirectoryChild(current, part, code);
      handles.push(child);
      current = child;
    }
    const final = parts.at(-1);
    if (final === undefined) throw workerError(code, 'relative file path is empty');
    return { file: await open(descriptorChild(current, final, code), FILE_FLAGS), handles };
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
    throw error;
  }
}

async function closeFileHandles(handles: readonly FileHandle[]): Promise<void> {
  let firstError: unknown;
  for (const handle of handles.slice().reverse()) {
    try { await handle.close(); } catch (error) { firstError ??= error; }
  }
  if (firstError !== undefined) throw firstError;
}

interface FixedStagingHandles {
  readonly root: FileHandle;
  readonly builder: FileHandle | null;
  readonly stagingParent: FileHandle | null;
  readonly quarantineParent: FileHandle | null;
  readonly source: FileHandle | null;
  readonly destination: FileHandle | null;
  readonly handles: readonly FileHandle[];
}

async function openFixedStaging(snapshot: ApprovedRootSnapshot, jobId: string): Promise<FixedStagingHandles> {
  const handles: FileHandle[] = [];
  try {
    const root = await open(snapshot.path, DIRECTORY_FLAGS);
    handles.push(root);
    await verifyDirectoryHandle(root, { device: snapshot.device, inode: snapshot.inode }, 'approved output root');
    const builder = await openOptionalDirectoryChild(root, '.osi-image-builder', 'QUARANTINE_PENDING');
    if (builder === null) return { root, builder: null, stagingParent: null, quarantineParent: null, source: null, destination: null, handles };
    handles.push(builder);
    const stagingParent = await openOptionalDirectoryChild(builder, 'staging', 'QUARANTINE_PENDING');
    const quarantineParent = await openOptionalDirectoryChild(builder, 'quarantine', 'QUARANTINE_PENDING');
    if (stagingParent !== null) handles.push(stagingParent);
    if (quarantineParent !== null) handles.push(quarantineParent);
    const source = stagingParent === null ? null : await openOptionalDirectoryChild(stagingParent, jobId, 'QUARANTINE_PENDING');
    const destination = quarantineParent === null ? null : await openOptionalDirectoryChild(quarantineParent, jobId, 'QUARANTINE_PENDING');
    if (source !== null) handles.push(source);
    if (destination !== null) handles.push(destination);
    return { root, builder, stagingParent, quarantineParent, source, destination, handles };
  } catch (error) {
    await closeFileHandles(handles);
    throw error;
  }
}

async function assertSourceAbsent(stagingParent: FileHandle | null, jobId: string): Promise<void> {
  if (stagingParent === null) return;
  const source = await openOptionalDirectoryChild(stagingParent, jobId, 'QUARANTINE_PENDING');
  if (source === null) return;
  await source.close().catch(() => undefined);
  throw workerError('QUARANTINE_PENDING', 'staging source is still present after quarantine');
}

async function destinationAfterRename(
  handles: FixedStagingHandles,
  jobId: string,
): Promise<{ readonly destination: FileHandle; readonly handles: readonly FileHandle[] }> {
  if (handles.builder === null) throw workerError('QUARANTINE_PENDING', 'quarantine parent is absent after native rename');
  const quarantineParent = handles.quarantineParent ?? await openDirectoryChild(handles.builder, 'quarantine', 'QUARANTINE_PENDING');
  const extra: FileHandle[] = handles.quarantineParent === null ? [quarantineParent] : [];
  try {
    const destination = await openDirectoryChild(quarantineParent, jobId, 'QUARANTINE_PENDING');
    extra.push(destination);
    return { destination, handles: extra };
  } catch (error) {
    await closeFileHandles(extra);
    throw error;
  }
}

async function verifyQuarantineDestination(
  destination: FileHandle,
  input: Parameters<CleanupQuarantine['quarantine']>[0],
  artifactRelative: string | null,
  expectedDirectory: FileIdentity | null,
): Promise<{ readonly identity: FileIdentity; readonly artifact: HashedFile | null }> {
  const identity = await verifyDirectoryHandle(destination, expectedDirectory, 'quarantine destination');
  let artifact: HashedFile | null = null;
  if (artifactRelative !== null) {
    const opened = await openRelativeFile(destination, artifactRelative, 'QUARANTINE_PENDING');
    try { artifact = await hashFileHandle(opened.file, 'quarantined artifact'); }
    finally { await closeFileHandles([opened.file, ...opened.handles]); }
    if (input.artifactSha256 !== null && artifact.sha256 !== input.artifactSha256) throw workerError('QUARANTINE_PENDING', 'quarantined artifact hash differs from persisted identity');
    if (input.artifactSize !== null && artifact.size !== input.artifactSize) throw workerError('QUARANTINE_PENDING', 'quarantined artifact size differs from persisted identity');
  }
  return { identity, artifact };
}

function assertApprovedRootSnapshot(expected: ApprovedRootSnapshot, actual: ApprovedRootSnapshot): void {
  if (expected.id !== actual.id || expected.path !== actual.path || expected.quarantinePath !== actual.quarantinePath || expected.device !== actual.device || expected.inode !== actual.inode) {
    throw workerError('QUARANTINE_PENDING', 'approved output root identity changed during quarantine');
  }
}

function createQuarantineAdapter(
  config: LoadedConfig,
  publisher: PublisherClient,
  clock: CleanupWorkerClock,
  approvedRootSnapshot: ApprovedRootSnapshotRunner,
): CleanupQuarantine {
  return {
    quarantine: async (input) => {
      safeJobId(input.jobId);
      const root = config.config.approvedOutputRoots.find((candidate) => candidate.id === input.rootId);
      if (root === undefined) throw workerError('QUARANTINE_PENDING', 'cleanup root is not approved');
      const sourceInternal = `staging/${input.jobId}`;
      const destinationInternal = `quarantine/${input.jobId}`;
      if (input.admittedStaging.kind === 'physical-present' && (input.stagingPath !== null || input.artifactSha256 !== null || input.artifactSize !== null)) throw workerError('QUARANTINE_PENDING', 'physical staging admission has tracked artifact identity');
      const artifactRelative = input.stagingPath === null ? null : safeRelative(input.stagingPath, sourceInternal);
      try {
        return await approvedRootSnapshot(input.rootId, async (snapshot) => {
          if (snapshot.id !== input.rootId || snapshot.path !== root.path || snapshot.quarantinePath !== root.quarantinePath) throw workerError('QUARANTINE_PENDING', 'approved root configuration changed');
          const fixed = await openFixedStaging(snapshot, input.jobId);
          const ownedHandles = [...fixed.handles];
          try {
            if (input.admittedStaging.kind === 'absent') {
              if (fixed.source !== null || fixed.destination !== null) throw workerError('QUARANTINE_PENDING', 'admitted staging absence has physical source or quarantine state');
              await assertSourceAbsent(fixed.stagingParent, input.jobId);
              return { kind: 'absent', path: null, sourcePath: sourceInternal, sourceAbsent: true, verifiedAt: clock.now() };
            }
            if (fixed.source !== null && fixed.destination !== null) throw workerError('QUARANTINE_PENDING', 'staging source and quarantine destination are both present');
            if (fixed.source === null && fixed.destination === null) throw workerError('QUARANTINE_PENDING', 'staging source and quarantine destination are both absent');
            if (fixed.source === null && fixed.destination !== null) {
              await verifyQuarantineDestination(fixed.destination, input, artifactRelative, null);
              await assertSourceAbsent(fixed.stagingParent, input.jobId);
              await approvedRootSnapshot(input.rootId, async (after) => { assertApprovedRootSnapshot(snapshot, after); return undefined; });
              return { kind: 'quarantined', sourcePath: sourceInternal, destinationPath: destinationInternal, sourceAbsent: true, destinationPresent: true, sha256: input.artifactSha256, size: input.artifactSize, verifiedAt: clock.now() };
            }
            const source = fixed.source!;
            const sourceIdentity = await verifyDirectoryHandle(source, null, 'staging source');
            let sourceArtifact: HashedFile | null = null;
            if (artifactRelative !== null) {
              const opened = await openRelativeFile(source, artifactRelative, 'QUARANTINE_PENDING');
              try { sourceArtifact = await hashFileHandle(opened.file, 'staged artifact'); }
              finally { await closeFileHandles([opened.file, ...opened.handles]); }
              if (input.artifactSha256 !== null && sourceArtifact.sha256 !== input.artifactSha256) throw workerError('QUARANTINE_PENDING', 'physical staging hash differs from persisted artifact');
              if (input.artifactSize !== null && sourceArtifact.size !== input.artifactSize) throw workerError('QUARANTINE_PENDING', 'physical staging size differs from persisted artifact');
            }
            const response: PublisherResponse = await publisher.quarantine({ rootId: input.rootId, jobId: input.jobId });
            if (!response.available || !response.quarantined || response.sourceRelativePath !== `.osi-image-builder/${sourceInternal}` || response.destinationRelativePath !== `.osi-image-builder/${destinationInternal}`) throw workerError('QUARANTINE_PENDING', `native publisher did not prove quarantine${response.errorCode ? `: ${response.errorCode}` : ''}`);
            const reopened = await destinationAfterRename(fixed, input.jobId);
            ownedHandles.push(...reopened.handles);
            const verified = await verifyQuarantineDestination(reopened.destination, input, artifactRelative, sourceIdentity);
            if (sourceArtifact !== null && (verified.artifact === null || !sameIdentity(sourceArtifact, verified.artifact))) throw workerError('QUARANTINE_PENDING', 'quarantined artifact inode or device changed');
            await verifyDirectoryHandle(source, sourceIdentity, 'staging source');
            await assertSourceAbsent(fixed.stagingParent, input.jobId);
            await approvedRootSnapshot(input.rootId, async (after) => { assertApprovedRootSnapshot(snapshot, after); return undefined; });
            return { kind: 'quarantined', sourcePath: sourceInternal, destinationPath: destinationInternal, sourceAbsent: true, destinationPresent: true, sha256: input.artifactSha256, size: input.artifactSize, verifiedAt: clock.now() };
          } finally {
            await closeFileHandles(ownedHandles);
          }
        });
      } catch (error) {
        if (error instanceof CleanupWorkerError) throw error;
        throw workerError('QUARANTINE_PENDING', `quarantine evidence failed: ${message(error)}`, error);
      }
    },
  };
}

function safeLogPath(jobId: string, value: string): readonly string[] {
  const prefix = 'logs/';
  if (!value.startsWith(prefix) || value.includes('\\')) throw workerError('RECOVERY_LOG_GAP', `log path is unsafe for ${jobId}`);
  const parts = value.slice(prefix.length).split('/');
  if (parts.length === 0 || parts.some((part) => part.length === 0 || part === '.' || part === '..')) throw workerError('RECOVERY_LOG_GAP', `log path is unsafe for ${jobId}`);
  return parts;
}

async function hashLogFile(state: StateRootSnapshot, jobId: string, relativePath: string): Promise<HashedFile> {
  const parts = safeLogPath(jobId, relativePath);
  const handles: FileHandle[] = [];
  const root = await open(state.path, DIRECTORY_FLAGS);
  handles.push(root);
  try {
    const rootIdentity = await root.stat();
    if (rootIdentity.dev !== state.device || rootIdentity.ino !== state.inode) throw workerError('RECOVERY_LOG_GAP', 'state root identity changed while reading logs');
    const jobs = await openDirectoryChild(root, 'jobs', 'RECOVERY_LOG_GAP'); handles.push(jobs);
    const job = await openDirectoryChild(jobs, jobId, 'RECOVERY_LOG_GAP'); handles.push(job);
    const logs = await openDirectoryChild(job, 'logs', 'RECOVERY_LOG_GAP'); handles.push(logs);
    const opened = await openRelativeFile(logs, parts.join('/'), 'RECOVERY_LOG_GAP');
    handles.push(opened.file, ...opened.handles);
    return await hashFileHandle(opened.file, `log ${relativePath}`);
  } finally {
    await closeFileHandles(handles);
  }
}

interface LogSealPlan {
  readonly row: LogRow;
  readonly stream: 'runner' | 'docker';
  readonly physical: HashedFile;
  readonly tailOffset: number;
  readonly tailLength: number;
}

function numberField(value: unknown, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw workerError('RECOVERY_LOG_GAP', `${field} is invalid`);
  return result;
}

function validateLogEvents(
  row: LogRow,
  events: readonly LogEventRow[],
  physicalSize: number,
  inputAt: string,
  stream: 'runner' | 'docker',
): number {
  const relevant = events.filter((event) => event.stream === stream && event.file_generation === row.generation).sort((left, right) => left.seq - right.seq);
  let previousSeq = -1;
  let end = 0;
  const ranges = relevant.map((event) => {
    const sequence = numberField(event.seq, `${stream} log event sequence`);
    if (sequence <= previousSeq || !['log', 'log_orphan_tail', 'log-truncated'].includes(event.event_type) || event.event_type === 'log-gap') throw workerError('RECOVERY_LOG_GAP', `${stream} log event contract is invalid`);
    previousSeq = sequence;
    const at = canonicalInstant(event.at, `${stream} log event time`);
    const started = canonicalInstant(row.started_at, `${stream} log startedAt`);
    if (at < started || at > inputAt) throw workerError('RECOVERY_LOG_GAP', `${stream} log event time is outside the sealed interval`);
    const offset = numberField(event.byte_offset, `${stream} log event offset`);
    const length = numberField(event.byte_length, `${stream} log event length`);
    if (length <= 0 || event.partial !== 0 && event.partial !== 1 || offset + length > physicalSize) throw workerError('RECOVERY_LOG_GAP', `${stream} log event range is invalid`);
    return { offset, length };
  }).sort((left, right) => left.offset - right.offset);
  for (const range of ranges) {
    if (range.offset !== end) throw workerError('RECOVERY_LOG_GAP', `${stream} log event coverage has a gap`);
    end += range.length;
  }
  return end;
}

async function createLogSealer(db: DatabaseSync, clock: CleanupWorkerClock, stateRootSnapshot: StateRootSnapshotRunner): Promise<CleanupLogSealer> {
  void clock;
  return {
    seal: async (input): Promise<CleanupLogSeal> => stateRootSnapshot(async (state) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const rows = db.prepare('SELECT stream, generation, path, started_at, sealed_at, size_bytes, sha256 FROM job_log_generations WHERE job_id=? ORDER BY stream, generation LIMIT ?').all(input.jobId, MAX_LOG_GENERATIONS + 1) as unknown as LogRow[];
        const events = db.prepare('SELECT stream, file_generation, seq, event_type, at, byte_offset, byte_length, partial FROM job_events WHERE job_id=? AND stream IS NOT NULL ORDER BY stream, file_generation, seq LIMIT ?').all(input.jobId, MAX_LOG_EVENTS + 1) as unknown as LogEventRow[];
        if (rows.length > MAX_LOG_GENERATIONS || events.length > MAX_LOG_EVENTS || rows.some((row) => row.stream !== 'runner' && row.stream !== 'docker') || events.some((event) => event.stream !== 'runner' && event.stream !== 'docker')) throw workerError('RECOVERY_LOG_GAP', 'cleanup log identity exceeds the bounded stream contract');
        const generationKeys = new Set(rows.map((row) => `${row.stream}:${row.generation}`));
        if (events.some((event) => !generationKeys.has(`${event.stream}:${event.file_generation}`))) throw workerError('RECOVERY_LOG_GAP', 'log event references an unknown generation');
        const plans: LogSealPlan[] = [];
        const states: Record<'runner' | 'docker', 'absent' | 'sealed'> = { runner: 'absent', docker: 'absent' };
        let totalPhysicalBytes = 0;
        for (const stream of ['runner', 'docker'] as const) {
          const streamRows = rows.filter((row) => row.stream === stream);
          for (const [index, row] of streamRows.entries()) {
            if (row.generation !== index || !Number.isSafeInteger(row.size_bytes) || row.size_bytes < 0 || row.size_bytes > MAX_LOG_BYTES) throw workerError('RECOVERY_LOG_GAP', `${stream} log generations are not contiguous`);
            safeLogPath(input.jobId, row.path);
            const startedAt = canonicalInstant(row.started_at, `${stream} log startedAt`);
            if (startedAt > input.at) throw workerError('RECOVERY_LOG_GAP', `${stream} log generation starts in the future`);
            const sealedAt = row.sealed_at === null ? null : canonicalInstant(row.sealed_at, `${stream} log sealedAt`);
            if (sealedAt !== null && sealedAt > input.at) throw workerError('RECOVERY_LOG_GAP', `${stream} log generation seal is from the future`);
            const physical = await hashLogFile(state, input.jobId, row.path);
            totalPhysicalBytes += physical.size;
            if (totalPhysicalBytes > MAX_TOTAL_LOG_BYTES) throw workerError('RECOVERY_LOG_GAP', 'cleanup log bytes exceed the bounded recovery limit');
            if (physical.size < row.size_bytes) throw workerError('RECOVERY_LOG_GAP', `${stream} log is shorter than persisted generation size`);
            if (row.sealed_at === null && row.sha256 !== null || row.sealed_at !== null && (row.sha256 === null || !HASH64.test(row.sha256) || physical.size !== row.size_bytes || physical.sha256 !== row.sha256)) throw workerError('RECOVERY_LOG_GAP', `${stream} sealed log bytes do not match persisted evidence`);
            const coveredEnd = validateLogEvents(row, events, physical.size, sealedAt ?? input.at, stream);
            if (coveredEnd > row.size_bytes) throw workerError('RECOVERY_LOG_GAP', `${stream} log events exceed persisted generation size`);
            if (sealedAt !== null) {
              if (coveredEnd !== row.size_bytes) throw workerError('RECOVERY_LOG_GAP', `${stream} sealed log coverage is incomplete`);
            } else {
              plans.push({ row, stream, physical, tailOffset: coveredEnd, tailLength: physical.size - coveredEnd });
            }
          }
          if (streamRows.length > 0) states[stream] = 'sealed';
        }
        for (const plan of plans) {
          if (plan.tailLength > 0) {
            const resized = db.prepare('UPDATE job_log_generations SET size_bytes=? WHERE job_id=? AND stream=? AND generation=? AND sealed_at IS NULL AND size_bytes=?').run(plan.physical.size, input.jobId, plan.stream, plan.row.generation, plan.row.size_bytes);
            if (Number(resized.changes) !== 1) throw workerError('RECOVERY_LOG_GAP', `${plan.stream} log size update CAS was lost`);
            const next = db.prepare('SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM job_events WHERE job_id=?').get(input.jobId) as { seq: number };
            const seq = numberField(next.seq, 'log event sequence');
            db.prepare('INSERT INTO job_events (job_id, seq, event_type, state, stage, payload_json, at, stream, file_generation, byte_offset, byte_length, partial) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)').run(input.jobId, seq, 'log_orphan_tail', '{}', input.at, plan.stream, plan.row.generation, plan.tailOffset, plan.tailLength, 0);
          }
          const sealed = db.prepare('UPDATE job_log_generations SET sealed_at=?, sha256=? WHERE job_id=? AND stream=? AND generation=? AND sealed_at IS NULL AND sha256 IS NULL AND size_bytes=?').run(input.at, plan.physical.sha256, input.jobId, plan.stream, plan.row.generation, plan.physical.size);
          if (Number(sealed.changes) !== 1) throw workerError('RECOVERY_LOG_GAP', `${plan.stream} log seal CAS was lost`);
        }
        db.exec('COMMIT');
        return { runner: states.runner, docker: states.docker, verifiedAt: input.at, contiguous: true };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch (rollbackError) { throw workerError('RECOVERY_LOG_GAP', 'cleanup log rollback failed', rollbackError); }
        if (error instanceof CleanupWorkerError) throw error;
        throw workerError('RECOVERY_LOG_GAP', `cleanup log sealing failed: ${message(error)}`, error);
      }
    }),
  };
}

async function ensureDirectory(parent: RecoveryDirectoryHandle, name: string): Promise<RecoveryDirectoryHandle> {
  try {
    return await parent.openDirectoryChild(name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await parent.mkdirChild(name, DIRECTORY_MODE);
    await parent.sync();
    return parent.openDirectoryChild(name);
  }
}

function isDirectoryStat(value: { readonly isDirectory: () => boolean; readonly isSymbolicLink: () => boolean }): boolean {
  return value.isDirectory() && !value.isSymbolicLink();
}

async function verifyEvidenceDirectory(handle: RecoveryDirectoryHandle, path: string, ownerUid: number): Promise<void> {
  const stats = await handle.stat();
  if (!isDirectoryStat(stats) || stats.uid !== ownerUid || (stats.mode & 0o7777) !== DIRECTORY_MODE) {
    throw new Error(`cleanup evidence directory is unsafe: ${path}`);
  }
}

async function closeRecoveryHandles(handles: readonly RecoveryFileHandle[]): Promise<void> {
  let firstError: unknown;
  for (const handle of handles.slice().reverse()) {
    try {
      await handle.close();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

function createEvidenceWriter(stateRoot: string, ownerUid: number, fileSystem: RecoveryDescriptorFileSystem): CleanupEvidenceWriter {
  return {
    write: async (input) => {
      safeJobId(input.jobId);
      if (!CLEANUP_ADMISSION_ID_PATTERN.test(input.admissionId)) throw new Error('cleanup evidence admission ID is invalid');
      const kind = input.evidence.kind;
      if (kind !== 'cleanup-complete' && kind !== 'cleanup-blocked') throw new Error('cleanup evidence kind is invalid');
      const outcome = kind === 'cleanup-complete' ? 'complete' : 'blocked';
      const encoded = encodeJson(input.evidence, 'cleanup evidence', true);
      const contents = Buffer.from(`${encoded}\n`, 'utf8');
      const sha256 = createHash('sha256').update(contents).digest('hex');
      const root = await fileSystem.openDirectory(stateRoot);
      const handles: RecoveryFileHandle[] = [root];
      try {
        await verifyEvidenceDirectory(root, stateRoot, ownerUid);
        const jobs = await ensureDirectory(root, 'jobs'); handles.push(jobs); await verifyEvidenceDirectory(jobs, 'jobs', ownerUid);
        const job = await ensureDirectory(jobs, input.jobId); handles.push(job); await verifyEvidenceDirectory(job, `jobs/${input.jobId}`, ownerUid);
        const evidenceDirectory = await ensureDirectory(job, 'evidence'); handles.push(evidenceDirectory); await verifyEvidenceDirectory(evidenceDirectory, `jobs/${input.jobId}/evidence`, ownerUid);
        const cleanupDirectory = await ensureDirectory(evidenceDirectory, 'cleanup'); handles.push(cleanupDirectory); await verifyEvidenceDirectory(cleanupDirectory, `jobs/${input.jobId}/evidence/cleanup`, ownerUid);
        const filename = `${input.admissionId}.${outcome}.json`;
        const file = await cleanupDirectory.openFileChild(filename, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, EVIDENCE_MODE);
        try {
          const stats = await file.stat();
          if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== ownerUid || (stats.mode & 0o7777) !== EVIDENCE_MODE || stats.nlink !== 1) throw new Error('cleanup evidence file is unsafe');
          await file.writeFile(contents);
          await file.sync();
        } finally {
          await file.close();
        }
        await cleanupDirectory.sync();
        return { path: `jobs/${input.jobId}/evidence/cleanup/${filename}`, sha256 };
      } finally {
        await closeRecoveryHandles(handles);
      }
    },
  };
}

async function defaultPublisherAuthority(loaded: LoadedConfig, executor: CommandExecutor): Promise<CleanupPublisherAuthority & { readonly heldClose: () => Promise<void> }> {
  const lockPath = loaded.config.builderLockPath;
  const installedVersion = basename(dirname(lockPath));
  const lockHandle = await open(lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let lockBytes: Buffer;
  try { lockBytes = await lockHandle.readFile(); } finally { await lockHandle.close(); }
  let parsed: unknown;
  try { parsed = JSON.parse(lockBytes.toString('utf8')) as unknown; } catch (error) { throw new Error('builder lock JSON is malformed', { cause: error }); }
  const lock = validateBuilderLock(parsed, installedVersion);
  if (!lock.ok) throw new Error(`builder lock is invalid: ${lock.reason}`);
  const held = await holdInstalledPublisher(join(dirname(lockPath), 'bin', 'osi-image-publish'));
  try {
    const argv = [held.executable, '--version'] as const;
    const result = await runTrusted({ executor, env: PUBLISHER_ENV, timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS }, argv);
    const text = parseSingleLine(result.stdout, 'publisher version');
    let value: unknown;
    try { value = JSON.parse(text) as unknown; } catch (error) { throw new Error('publisher version JSON is malformed', { cause: error }); }
    if (JSON.stringify(value) !== text || value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('publisher version evidence is not canonical');
    const record = value as Record<string, unknown>;
    if (record.available !== true || typeof record.version !== 'string' || typeof record.sourceSha256 !== 'string') throw new Error('publisher version evidence is incomplete');
    const authority = validateInstalledPublisherAuthority(lock.lock, installedVersion, held.bytes, { publisherVersion: record.version, publisherSourceSha256: record.sourceSha256 });
    return { executable: held.executable, expectedVersion: authority.packageVersion, expectedSourceSha256: authority.publisherSourceSha256, heldClose: held.close };
  } catch (error) {
    await held.close().catch(() => undefined);
    throw error;
  }
}

export async function createCleanupProduction(options: CleanupProductionDependencies = {}): Promise<CleanupProductionComposition> {
  const env = process.env;
  const ownerUid = options.ownerUid ?? process.getuid?.() ?? 0;
  const workerOwner = options.workerOwner ?? DEFAULT_OWNER;
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const loadState = options.loadStateRoot ?? ((input: { readonly env?: NodeJS.ProcessEnv }) => loadStateRootAuthority(input));
  const loadConfiguration = options.loadConfiguration ?? ((input: { readonly env?: NodeJS.ProcessEnv }) => loadConfig(input));
  const openDatabase = options.openDatabase ?? openBuilderDatabase;
  const state = await loadState({ env });
  let db: DatabaseSync | null = null;
  let authorityClose: (() => Promise<void>) | undefined;
  try {
    db = openDatabase(join(state.stateRoot, 'jobs.sqlite'));
    const loaded = await loadConfiguration({ env });
    if (loaded.stateRoot !== state.stateRoot) throw new Error('configured state root differs from guarded cleanup state');
    const executor = options.commandExecutor ?? createCommandExecutor();
    const timeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const systemdEnv = options.systemdEnvironment ?? (() => deriveSystemdBusEnvironment({ uid: ownerUid }));
    const commandEnv = Object.freeze({ ...FIXED_PREFLIGHT_ENV, ...(await systemdEnv()) });
    const publisherAuthority = options.publisherAuthority ?? await defaultPublisherAuthority(loaded, executor);
    const approvedRootSnapshot = options.approvedRootSnapshot ?? ((rootId: string, callback: (snapshot: ApprovedRootSnapshot) => Promise<unknown>) => (
      withApprovedRootAuthoritySnapshot(loaded.pathAuthorities.approvedRoots, rootId, async ({ snapshot }) => callback(snapshot))
    )) as ApprovedRootSnapshotRunner;
    const stateRootSnapshot = options.stateRootSnapshot ?? ((callback: (snapshot: StateRootSnapshot) => Promise<unknown>) => (
      withStateRootAuthoritySnapshot(state.authority, async ({ snapshot }) => callback(snapshot))
    )) as StateRootSnapshotRunner;
    const heldClose = (publisherAuthority as CleanupPublisherAuthority & { readonly heldClose?: () => Promise<void> }).heldClose;
    authorityClose = publisherAuthority.close ?? heldClose;
    const publisher = (options.publisherClientFactory ?? createPublisherClient)({
      executable: publisherAuthority.executable,
      approvedRoots: loaded.config.approvedOutputRoots,
      expectedVersion: publisherAuthority.expectedVersion,
      expectedSourceSha256: publisherAuthority.expectedSourceSha256,
      commandExecutor: executor,
      timeoutMs,
    });
    const adapters: CleanupProductionAdapters = {
      systemd: createSystemdAdapter({ executor, env: commandEnv, timeoutMs }, options.systemdExecutable ?? SYSTEMCTL),
      docker: createDockerAdapter({ executor, env: Object.freeze({ ...FIXED_PREFLIGHT_ENV }), timeoutMs }, options.dockerExecutable ?? DOCKER),
      logSealer: await createLogSealer(db, clock, stateRootSnapshot),
      quarantine: createQuarantineAdapter(loaded, publisher, clock, approvedRootSnapshot),
      evidenceWriter: createEvidenceWriter(state.stateRoot, ownerUid, options.fileSystem ?? createRecoveryFileSystem()),
    };
    const workerOptions: CleanupWorkerOptions = {
      db,
      stateRoot: state.stateRoot,
      ownerUid,
      workerOwner,
      ownership: new OwnershipStore(db, { now: clock.now }),
      systemd: adapters.systemd,
      docker: adapters.docker,
      logSealer: adapters.logSealer,
      quarantine: adapters.quarantine,
      evidenceWriter: adapters.evidenceWriter,
      clock,
      timeouts: { dockerMs: timeoutMs, systemdMs: timeoutMs },
    };
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      let closeError: unknown;
      try {
        await authorityClose?.();
      } catch (error) {
        closeError = error;
      }
      try {
        db?.close();
      } catch (error) {
        closeError ??= error;
      }
      if (closeError !== undefined) throw closeError;
    };
    const worker = createCleanupWorker(workerOptions);
    return { worker, adapters, stateRoot: state.stateRoot, run: worker.run, close };
  } catch (error) {
    await authorityClose?.().catch(() => undefined);
    db?.close();
    throw error;
  }
}

export async function runCleanupWorker(argv: readonly string[], options: CleanupProductionDependencies = {}): Promise<CleanupWorkerResult> {
  const composition = await createCleanupProduction(options);
  try { return await composition.run(argv); } finally { await composition.close(); }
}
