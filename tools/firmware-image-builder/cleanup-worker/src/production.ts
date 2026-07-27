import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { deriveSystemdBusEnvironment, FIXED_PREFLIGHT_ENV } from '../../api/src/preflight.js';
import {
  loadConfig,
  loadStateRootAuthority,
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
const MAX_LOG_GENERATIONS = 128;
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

async function directoryState(path: string): Promise<'absent' | 'present'> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`unsafe staging directory: ${path}`);
    return 'present';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
}

async function fileHash(path: string): Promise<Readonly<{ sha256: string; size: number }>> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_LOG_BYTES) throw new Error(`unsafe or oversized artifact: ${path}`);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(LOG_CHUNK_BYTES);
    let total = 0;
    while (total < stats.size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, stats.size - total), null);
      if (result.bytesRead <= 0) throw new Error(`artifact changed while hashing: ${path}`);
      hash.update(buffer.subarray(0, result.bytesRead));
      total += result.bytesRead;
    }
    if (total !== stats.size) throw new Error(`artifact size changed while hashing: ${path}`);
    return { sha256: hash.digest('hex'), size: total };
  } finally {
    await handle.close();
  }
}

function createQuarantineAdapter(
  config: LoadedConfig,
  publisher: PublisherClient,
  clock: CleanupWorkerClock,
): CleanupQuarantine {
  return {
    quarantine: async (input) => {
      safeJobId(input.jobId);
      const root = config.config.approvedOutputRoots.find((candidate) => candidate.id === input.rootId);
      if (root === undefined) throw workerError('QUARANTINE_PENDING', 'cleanup root is not approved');
      const sourceInternal = `staging/${input.jobId}`;
      const destinationInternal = `quarantine/${input.jobId}`;
      const source = join(root.path, '.osi-image-builder', sourceInternal);
      const destination = join(root.path, '.osi-image-builder', destinationInternal);
      const sourceState = await directoryState(source);
      if (input.admittedStaging.kind === 'absent') {
        if (sourceState !== 'absent') throw workerError('QUARANTINE_PENDING', 'admitted staging absence is contradicted by physical staging');
        return { kind: 'absent', path: null, sourcePath: sourceInternal, sourceAbsent: true, verifiedAt: clock.now() };
      }
      if (sourceState !== 'present') throw workerError('QUARANTINE_PENDING', 'admitted staging directory is absent');
      if (input.admittedStaging.kind === 'physical-present' && (input.stagingPath !== null || input.artifactSha256 !== null || input.artifactSize !== null)) throw workerError('QUARANTINE_PENDING', 'physical staging admission has tracked artifact identity');
      const artifactRelative = input.stagingPath === null ? null : safeRelative(input.stagingPath, sourceInternal);
      const sourceArtifact = artifactRelative === null ? null : join(source, artifactRelative);
      const destinationArtifact = artifactRelative === null ? null : join(destination, artifactRelative);
      let before: Readonly<{ sha256: string; size: number }> | null = null;
      if (sourceArtifact !== null) {
        before = await fileHash(sourceArtifact);
        if (input.artifactSha256 !== null && before.sha256 !== input.artifactSha256) throw workerError('QUARANTINE_PENDING', 'physical staging hash differs from persisted artifact');
        if (input.artifactSize !== null && before.size !== input.artifactSize) throw workerError('QUARANTINE_PENDING', 'physical staging size differs from persisted artifact');
      }
      const response: PublisherResponse = await publisher.quarantine({ rootId: input.rootId, jobId: input.jobId });
      if (!response.available || !response.quarantined || response.sourceRelativePath !== `.osi-image-builder/${sourceInternal}` || response.destinationRelativePath !== `.osi-image-builder/${destinationInternal}`) throw workerError('QUARANTINE_PENDING', `native publisher did not prove quarantine${response.errorCode ? `: ${response.errorCode}` : ''}`);
      if (await directoryState(source) !== 'absent' || await directoryState(destination) !== 'present') throw workerError('QUARANTINE_PENDING', 'native publisher quarantine paths are not proven');
      if (destinationArtifact !== null) {
        const after = await fileHash(destinationArtifact);
        if (before === null || after.sha256 !== before.sha256 || after.size !== before.size) throw workerError('QUARANTINE_PENDING', 'quarantined artifact identity changed');
      }
      return {
        kind: 'quarantined',
        sourcePath: sourceInternal,
        destinationPath: destinationInternal,
        sourceAbsent: true,
        destinationPresent: true,
        sha256: input.artifactSha256,
        size: input.artifactSize,
        verifiedAt: clock.now(),
      };
    },
  };
}

function safeLogPath(jobId: string, value: string): string {
  const prefix = `logs/`;
  if (!value.startsWith(prefix) || value.includes('\\') || value.split('/').some((part) => part.length === 0 || part === '.' || part === '..')) throw workerError('RECOVERY_LOG_GAP', `log path is unsafe for ${jobId}`);
  return value;
}

async function createLogSealer(db: DatabaseSync, stateRoot: string, clock: CleanupWorkerClock): Promise<CleanupLogSealer> {
  void clock;
  return {
    seal: async (input): Promise<CleanupLogSeal> => {
      const rows = db.prepare('SELECT stream, generation, path, started_at, sealed_at, size_bytes, sha256 FROM job_log_generations WHERE job_id=? ORDER BY stream, generation LIMIT ?').all(input.jobId, MAX_LOG_GENERATIONS + 1) as unknown as LogRow[];
      if (rows.length > MAX_LOG_GENERATIONS || rows.some((row) => row.stream !== 'runner' && row.stream !== 'docker')) {
        throw workerError('RECOVERY_LOG_GAP', 'cleanup log generation identity exceeds the bounded stream contract');
      }
      const states: Record<'runner' | 'docker', 'absent' | 'sealed'> = { runner: 'absent', docker: 'absent' };
      for (const stream of ['runner', 'docker'] as const) {
        const streamRows = rows.filter((row) => row.stream === stream);
        for (const [index, row] of streamRows.entries()) {
          if (row.generation !== index || !Number.isSafeInteger(row.size_bytes) || row.size_bytes < 0 || row.size_bytes > MAX_LOG_BYTES) throw workerError('RECOVERY_LOG_GAP', `${stream} log generations are not contiguous`);
          safeLogPath(input.jobId, row.path);
          const startedAt = canonicalInstant(row.started_at, `${stream} log startedAt`);
          if (startedAt > input.at) throw workerError('RECOVERY_LOG_GAP', `${stream} log generation starts in the future`);
          if (row.sealed_at !== null) {
            const sealedAt = canonicalInstant(row.sealed_at, `${stream} log sealedAt`);
            if (sealedAt > input.at || row.sha256 === null || !HASH64.test(row.sha256)) throw workerError('RECOVERY_LOG_GAP', `${stream} log seal evidence is invalid`);
          } else {
            const path = join(stateRoot, 'jobs', input.jobId, row.path);
            const observed = await fileHash(path);
            if (observed.size !== row.size_bytes) throw workerError('RECOVERY_LOG_GAP', `${stream} log size does not match the persisted generation`);
            const update = db.prepare('UPDATE job_log_generations SET sealed_at=?, sha256=? WHERE job_id=? AND stream=? AND generation=? AND sealed_at IS NULL').run(input.at, observed.sha256, input.jobId, stream, row.generation);
            if (Number(update.changes) !== 1) throw workerError('RECOVERY_LOG_GAP', `${stream} log seal CAS was lost`);
          }
        }
        if (streamRows.length > 0) states[stream] = 'sealed';
      }
      return { runner: states.runner, docker: states.docker, verifiedAt: input.at, contiguous: true };
    },
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
      logSealer: await createLogSealer(db, state.stateRoot, clock),
      quarantine: createQuarantineAdapter(loaded, publisher, clock),
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
