import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  rename,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  basename,
  dirname,
  join,
} from 'node:path';

import {
  OwnershipStore,
  type LogCleanupProof,
  type RunnerWriteCommand,
} from '../../api/src/ownership.js';
import {
  createReadOnlyPreflightDefaults,
  TRUSTED_PREFLIGHT_EXECUTABLES,
} from '../../api/src/preflight.js';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import {
  BuilderStore,
  type ArtifactInput,
  type JobRecord,
  type JsonObject,
  type StoredOperation,
} from '../../api/src/store.js';
import {
  encodeJson,
  normalizeJson,
  stableRelativePath,
} from '../../api/src/validation.js';
import { canonicalBuilderImageReference } from '../../builder/validate-builder.js';
import {
  loadConfig,
  loadStateRootAuthority,
  withApprovedRootSnapshot,
  withStateRootSnapshot,
  type ApprovedRootRegistry,
  type LoadedConfig,
  type StateRootAuthority,
} from '../../config/load.js';
import { validateBuilderLock, type BuilderLock } from '../../domain/builder-lock.js';
import { encodeBranchSlug } from '../../domain/paths.js';
import type {
  BuilderErrorContract,
  JobState,
  PipelineStageName,
  TrustedOperationId,
} from '../../domain/types.js';
import { ACTIVE_RECOVERY_STATES } from '../../domain/types.js';
import {
  loadManifest,
  type ManifestFileSystem,
} from '../../manifest/validate.js';
import type { TargetManifest } from '../../manifest/schema.js';
import { createRunnerPublisherClient } from './publisher-client.js';
import { createDockerExecutor } from './docker-executor.js';
import { createEvidenceWriter } from './evidence.js';
import { createApiFreshnessSocketClient } from './freshness.js';
import {
  createOperationDefinition,
  type OperationDefinition,
} from './operation-registry.js';
import {
  createPipeline,
  type FinalPublicationProof,
  type PipelineClock,
  type PipelineEvidenceWriter,
  type PipelineInput,
  type PipelineLease,
  type PipelineOperationExecution,
  type PipelineResult,
  type PreparedPublication,
  type PublicationFilesPrepareInput,
  type StageActionContext,
  type TargetSetupStageResult,
  type VerifiedPipelineArtifact,
} from './pipeline.js';
import {
  setupSourceWorktree,
  type SourceSetupResult,
} from './source.js';
import {
  classifyTargetSetupOperationResult,
  createLockedTargetSetupOperations,
  createTargetSetupConfigObservations,
  createTargetSetupSourceObservations,
  resolveTargetSetup,
  type OfflineFeedPreparation,
  type TargetSetupConfigObservations,
  type TargetSetupPhaseResult,
  type TargetSetupResult,
  type TargetSetupSourceObservations,
} from './target-setup.js';
import type { CommandResult } from './command-executor.js';
import {
  verifyFirmwareArtifacts,
  type RootfsNodeResolutionRequest,
  type RootfsNodeResolutionResult,
} from './verification.js';

const RUNNER_UNIT = /^osi-image-builder-runner@[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.service$/u;
const SAFE_OWNER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_JOB = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PROC_FD = '/proc/self/fd';
const DIRECTORY_FLAGS = fsConstants.O_RDONLY
  | fsConstants.O_DIRECTORY
  | fsConstants.O_NOFOLLOW;
const READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const CREATE_FLAGS = fsConstants.O_WRONLY
  | fsConstants.O_CREAT
  | fsConstants.O_EXCL
  | fsConstants.O_NOFOLLOW;
const CREATE_READ_WRITE_FLAGS = fsConstants.O_RDWR
  | fsConstants.O_CREAT
  | fsConstants.O_EXCL
  | fsConstants.O_NOFOLLOW;
const LEASE_DURATION_MS = 60_000;
const MAX_OPERATION_CAPTURE_BYTES = 8 * 1024 * 1024;
const ROOTFS_NODE_MODULES = Object.freeze([
  ['@grpc/grpc-js', '@grpc/grpc-js'],
  ['@chirpstack/chirpstack-api', '@chirpstack/chirpstack-api'],
  ['google-protobuf', 'google-protobuf'],
  ['protobufjs', 'protobufjs'],
  ['osi-chameleon-helper', 'osi-chameleon-helper'],
  ['osi-chirpstack-helper', 'osi-chirpstack-helper'],
  ['osi-cloud-http', 'osi-cloud-http'],
  ['osi-db-helper', 'osi-db-helper'],
  ['osi-dendro-helper', 'osi-dendro-helper'],
  ['osi-health-helper', 'osi-health-helper'],
  ['osi-history-helper', 'osi-history-helper'],
  ['osi-history-sync-helper', 'osi-history-sync-helper'],
  ['osi-lib', 'osi-lib'],
  ['osi-command-ledger', './osi-command-ledger'],
  ['osi-dendro-analytics', './osi-dendro-analytics'],
  ['osi-zone-env', './osi-zone-env'],
  ['osi-history-router', './osi-history-router'],
  ['osi-journal', './osi-journal'],
  ['osi-device-writer', './osi-device-writer'],
  ['osi-uc512-normalize', './osi-uc512-normalize'],
  ['osi-lsn50-normalize', './osi-lsn50-normalize'],
] as const);

interface TrustedOperationRequestInput {
  readonly operationId: TrustedOperationId;
  readonly requestedDefinition?: OperationDefinition;
  readonly selectedEnvironment: string;
  readonly allowedEnvironments: readonly string[];
  readonly activeTargetSetupEnvironment: string | null;
}

interface TrustedOperationRequest {
  readonly definition: OperationDefinition;
  readonly environment: string;
}

function sameOperationDefinition(
  actual: OperationDefinition,
  expected: OperationDefinition,
): boolean {
  return Object.keys(actual).sort().join('\0') === 'argv\0workingDirectory'
    && actual.workingDirectory === expected.workingDirectory
    && Array.isArray(actual.argv)
    && actual.argv.length === expected.argv.length
    && actual.argv.every((value, index) => value === expected.argv[index]);
}

export function resolveTrustedOperationRequest(
  input: TrustedOperationRequestInput,
): TrustedOperationRequest {
  const allowed = new Set(input.allowedEnvironments);
  if (
    allowed.size !== input.allowedEnvironments.length
    || !allowed.has(input.selectedEnvironment)
  ) {
    throw new Error('trusted target manifest environments are invalid');
  }
  if (input.requestedDefinition === undefined) {
    return Object.freeze({
      definition: createOperationDefinition(input.operationId, {
        environment: input.selectedEnvironment,
      }),
      environment: input.selectedEnvironment,
    });
  }
  if (input.operationId === 'activate-target') {
    const environment = input.allowedEnvironments.find((candidate) => (
      sameOperationDefinition(
        input.requestedDefinition!,
        createOperationDefinition(input.operationId, { environment: candidate }),
      )
    ));
    if (environment === undefined) {
      throw new Error('operation definition is not derived from the trusted target manifest');
    }
    return Object.freeze({
      definition: createOperationDefinition(input.operationId, { environment }),
      environment,
    });
  }
  if (
    input.activeTargetSetupEnvironment === null
    || !allowed.has(input.activeTargetSetupEnvironment)
  ) {
    throw new Error('target setup has no active target profile');
  }
  const definition = createOperationDefinition(input.operationId, {
    environment: input.activeTargetSetupEnvironment,
  });
  if (!sameOperationDefinition(input.requestedDefinition, definition)) {
    throw new Error('operation definition is not derived from the trusted target manifest');
  }
  return Object.freeze({
    definition,
    environment: input.activeTargetSetupEnvironment,
  });
}

export interface RunnerArguments {
  readonly jobId: string;
  readonly runnerUnit: string;
  readonly owner: string;
  readonly leaseExpiresAt: string;
}

interface ProductionComposition {
  readonly input: PipelineInput;
  close(): Promise<void>;
}

export interface GuardedCompositionInput {
  readonly args: RunnerArguments;
  readonly clock: PipelineClock;
  readonly store: BuilderStore;
  readonly ownership: OwnershipStore;
  readonly evidenceWriter: PipelineEvidenceWriter;
  readonly compose: (lease: PipelineLease) => Promise<ProductionComposition>;
}

interface PublicationFileSet {
  readonly artifact: ArtifactInput;
  readonly buildManifestBytes: string;
  readonly verificationManifestBytes: string;
  readonly checksumBytes: string;
}

interface DirectoryChain {
  readonly directory: FileHandle;
  readonly handles: readonly FileHandle[];
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function holdInstalledPublisher(path: string): Promise<Readonly<{
  executable: string;
  sha256: string;
  bytes: Buffer;
  close: () => Promise<void>;
}>> {
  const handle = await open(path, READ_FLAGS);
  try {
    const before = await handle.stat();
    if (!before.isFile() || (before.mode & 0o111) === 0) {
      throw new Error('installed publisher is not an executable regular file');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error('installed publisher changed while establishing authority');
    }
    return Object.freeze({
      executable: `/proc/${String(process.pid)}/fd/${String(handle.fd)}`,
      sha256: sha256(bytes),
      bytes,
      close: () => handle.close(),
    });
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function fdPath(parent: FileHandle, name?: string): string {
  return name === undefined
    ? `${PROC_FD}/${String(parent.fd)}`
    : `${PROC_FD}/${String(parent.fd)}/${name}`;
}

function safeSegment(value: string, field: string): string {
  if (
    value.length === 0
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > 255
  ) {
    throw new Error(`${field} is not a safe path segment`);
  }
  return value;
}

async function closeHandles(handles: readonly FileHandle[]): Promise<void> {
  for (const handle of [...handles].reverse()) {
    await handle.close().catch(() => undefined);
  }
}

async function openDirectoryChain(
  parent: FileHandle,
  components: readonly string[],
  create: boolean,
): Promise<DirectoryChain> {
  const handles: FileHandle[] = [];
  let current = parent;
  try {
    for (const raw of components) {
      const name = safeSegment(raw, 'directory component');
      let child: FileHandle;
      try {
        child = await open(fdPath(current, name), DIRECTORY_FLAGS);
      } catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await mkdir(fdPath(current, name), { mode: 0o700 });
        child = await open(fdPath(current, name), DIRECTORY_FLAGS);
      }
      const stats = await child.stat();
      if (!stats.isDirectory()) {
        await child.close();
        throw new Error('held path component is not a directory');
      }
      handles.push(child);
      current = child;
    }
    return { directory: current, handles };
  } catch (error) {
    await closeHandles(handles);
    throw error;
  }
}

async function hashHandle(handle: FileHandle): Promise<string> {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const result = await handle.read(buffer, 0, buffer.length, position);
    if (result.bytesRead === 0) break;
    digest.update(buffer.subarray(0, result.bytesRead));
    position += result.bytesRead;
  }
  return digest.digest('hex');
}

async function readHeldFile(
  parent: FileHandle,
  name: string,
): Promise<Readonly<{ bytes: Buffer; sha256: string; size: number; mtime: string }>> {
  const handle = await open(fdPath(parent, safeSegment(name, 'file name')), READ_FLAGS);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('held publication path is not a regular file');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error('held publication file changed while being read');
    }
    return {
      bytes,
      sha256: sha256(bytes),
      size: after.size,
      mtime: after.mtime.toISOString(),
    };
  } finally {
    await handle.close();
  }
}

async function writeHeldFile(
  parent: FileHandle,
  name: string,
  contents: Buffer | string,
  mtime?: string,
): Promise<Readonly<{ sha256: string; size: number; mtime: string }>> {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  const handle = await open(
    fdPath(parent, safeSegment(name, 'file name')),
    CREATE_FLAGS,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    if (mtime !== undefined) {
      const timestamp = new Date(mtime);
      if (!Number.isFinite(timestamp.getTime())) throw new Error('artifact mtime is invalid');
      await handle.utimes(timestamp, timestamp);
    }
    await handle.sync();
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size !== bytes.byteLength) {
      throw new Error('durable publication file does not match its source');
    }
    return {
      sha256: sha256(bytes),
      size: stats.size,
      mtime: stats.mtime.toISOString(),
    };
  } finally {
    await handle.close();
  }
}

export async function stageVerifiedArtifact(
  workspaceAuthority: string | FileHandle,
  relativePath: string,
  destination: FileHandle,
  destinationName: string,
  expected: PublicationFilesPrepareInput['artifact'],
): Promise<Readonly<{ sha256: string; size: number; mtime: string }>> {
  const stable = stableRelativePath(relativePath, 'verified artifact path');
  const components = stable.split('/');
  const sourceName = components.pop();
  if (sourceName === undefined) throw new Error('verified artifact path is incomplete');
  const workspace = typeof workspaceAuthority === 'string'
    ? await open(workspaceAuthority, DIRECTORY_FLAGS)
    : workspaceAuthority;
  const ownsWorkspace = typeof workspaceAuthority === 'string';
  let chain: DirectoryChain | null = null;
  try {
    chain = await openDirectoryChain(workspace, components, false);
    const source = await open(fdPath(chain.directory, sourceName), READ_FLAGS);
    try {
      const stats = await source.stat();
      if (
        !stats.isFile()
        || stats.size !== expected.size
        || stats.mtime.toISOString() !== expected.mtime
      ) {
        throw new Error('verified artifact metadata changed before staging');
      }
      const sourceHash = await hashHandle(source);
      if (sourceHash !== expected.sha256) {
        throw new Error('verified artifact hash changed before staging');
      }
      const destinationHandle = await open(
        fdPath(destination, safeSegment(destinationName, 'artifact basename')),
        CREATE_READ_WRITE_FLAGS,
        0o600,
      );
      try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let position = 0;
        while (position < stats.size) {
          const result = await source.read(
            buffer,
            0,
            Math.min(buffer.length, stats.size - position),
            position,
          );
          if (result.bytesRead === 0) throw new Error('artifact source ended during staging');
          await destinationHandle.write(buffer, 0, result.bytesRead);
          position += result.bytesRead;
        }
        const timestamp = new Date(expected.mtime);
        await destinationHandle.utimes(timestamp, timestamp);
        await destinationHandle.sync();
        const copied = await destinationHandle.stat();
        const copiedHash = await hashHandle(destinationHandle);
        if (
          !copied.isFile()
          || copied.size !== expected.size
          || copied.mtime.toISOString() !== expected.mtime
          || copiedHash !== expected.sha256
        ) {
          throw new Error('staged artifact differs from verified source');
        }
        return {
          sha256: copiedHash,
          size: copied.size,
          mtime: copied.mtime.toISOString(),
        };
      } finally {
        await destinationHandle.close();
      }
    } finally {
      await source.close();
    }
  } finally {
    if (chain !== null) await closeHandles(chain.handles);
    if (ownsWorkspace) await workspace.close();
  }
}

async function readStableFile(path: string): Promise<Buffer> {
  const handle = await open(path, READ_FLAGS);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`authoritative file is not regular: ${path}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error(`authoritative file changed while held: ${path}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function loadManifestFromBytes(path: string, bytes: Buffer) {
  const descriptor = 29;
  let cursor = 0;
  let opened = false;
  const fileSystem: ManifestFileSystem = {
    open(candidate) {
      if (opened || candidate !== path) throw new Error('unexpected manifest open');
      opened = true;
      return descriptor;
    },
    stat(fd) {
      if (!opened || fd !== descriptor) throw new Error('unexpected manifest stat');
      return { size: bytes.length };
    },
    read(fd, target, offset, length, position) {
      if (!opened || fd !== descriptor || position !== null) {
        throw new Error('unexpected manifest read');
      }
      const copied = bytes.copy(
        target,
        offset,
        cursor,
        Math.min(bytes.length, cursor + length),
      );
      cursor += copied;
      return copied;
    },
    close(fd) {
      if (!opened || fd !== descriptor) throw new Error('unexpected manifest close');
      opened = false;
    },
  };
  return loadManifest(path, fileSystem);
}

function parseInstalledLock(path: string, bytes: Buffer): BuilderLock {
  const packageVersion = dirname(path).split('/').at(-1);
  if (packageVersion === undefined) throw new Error('installed package version is unavailable');
  const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  const result = validateBuilderLock(parsed, packageVersion);
  if (!result.ok) throw new Error(`installed builder lock is invalid: ${result.reason}`);
  return result.lock;
}

export interface InstalledPublisherAuthority {
  readonly packageVersion: string;
  readonly publisherSha256: string;
}

export function validateInstalledPublisherAuthority(
  lock: Readonly<Pick<BuilderLock, 'schemaVersion' | 'packageVersion' | 'publisherSha256'>>,
  installedVersion: string,
  publisherBytes: Buffer,
): InstalledPublisherAuthority {
  if (lock.schemaVersion !== 1 || lock.packageVersion !== installedVersion) {
    throw new Error('installed publisher package version does not match the builder lock');
  }
  if (
    typeof lock.publisherSha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(lock.publisherSha256)
    || /^0+$/u.test(lock.publisherSha256)
  ) {
    throw new Error('installed publisher hash is missing or invalid');
  }
  const observedSha256 = sha256(publisherBytes);
  if (observedSha256 !== lock.publisherSha256) {
    throw new Error('installed publisher hash does not match the builder lock');
  }
  return Object.freeze({
    packageVersion: lock.packageVersion,
    publisherSha256: lock.publisherSha256,
  });
}

function offlineFeedPreparation(job: JobRecord): OfflineFeedPreparation {
  if (!job.sourceRunnable || job.offlineFeedPreparation === null) {
    throw new Error('persisted offline feed preparation is missing');
  }
  return job.offlineFeedPreparation;
}

function operationError(
  operation: StoredOperation,
  stage: PipelineStageName,
  requestId: string,
): PipelineOperationExecution['error'] {
  if (operation.outcome !== 'failed' || operation.errorCode === null) return undefined;
  return Object.freeze({
    code: operation.errorCode,
    stage,
    details: {
      operationId: operation.operationId,
      attempt: operation.attempt,
    },
    retryable: false,
    requestId,
    diagnosis: `trusted operation ${operation.operationId} failed`,
    recovery: 'Inspect the durable operation evidence and submit a corrected job.',
    operationId: operation.operationId,
    ...(operation.evidencePath === null
      ? {}
      : { evidencePath: operation.evidencePath }),
  });
}

function mapOperation(
  operation: StoredOperation,
  stage: PipelineStageName,
  requestId: string,
  stdout: string,
  stderr: string,
): PipelineOperationExecution {
  if (
    operation.outcome === null
    || operation.finishedAt === null
    || operation.evidencePath === null
    || operation.evidenceSha256 === null
  ) {
    throw new Error('Docker executor did not commit complete operation evidence');
  }
  const error = operationError(operation, stage, requestId);
  return Object.freeze({
    operationId: operation.operationId,
    attempt: operation.attempt,
    outcome: operation.outcome,
    command: Object.freeze({
      argv: operation.argv,
      startedAt: operation.startedAt,
      finishedAt: operation.finishedAt,
      exitCode: operation.exitCode,
      signal: operation.signal,
      timedOut: operation.timedOut,
      outputLimit: false,
    }),
    observations: Object.freeze({
      evidencePath: operation.evidencePath,
      evidenceSha256: operation.evidenceSha256,
      lifecyclePhase: operation.lifecyclePhase,
      containerId: operation.containerId,
      acceptedDisposition: operation.acceptedDisposition,
      stdout,
      stderr,
    }),
    ...(error === undefined ? {} : { error }),
  });
}

function targetSetupCommand(
  execution: PipelineOperationExecution,
): CommandResult {
  const observations = execution.observations;
  return Object.freeze({
    argv: execution.command.argv,
    exitCode: execution.command.exitCode,
    signal: execution.command.signal as NodeJS.Signals | null,
    stdout: typeof observations.stdout === 'string' ? observations.stdout : '',
    stderr: typeof observations.stderr === 'string' ? observations.stderr : '',
    timedOut: execution.command.timedOut,
    startedAt: execution.command.startedAt,
    finishedAt: execution.command.finishedAt,
  });
}

async function writeOperationEvidence(
  stateRoot: StateRootAuthority,
  jobId: string,
  operationId: TrustedOperationId,
  attempt: number,
  value: JsonObject,
): Promise<Readonly<{ path: string; sha256: string }>> {
  const relativePath = `jobs/${jobId}/evidence/operations/${operationId}-${attempt}.json`;
  const bytes = Buffer.from(`${encodeJson(value, 'operation evidence', true)}\n`);
  await withStateRootSnapshot(stateRoot, async ({ snapshot }) => {
    const root = await open(snapshot.path, DIRECTORY_FLAGS);
    let chain: DirectoryChain | null = null;
    try {
      chain = await openDirectoryChain(
        root,
        ['jobs', jobId, 'evidence', 'operations'],
        true,
      );
      await writeHeldFile(
        chain.directory,
        `${operationId}-${attempt}.json`,
        bytes,
      );
      await chain.directory.sync();
    } finally {
      if (chain !== null) await closeHandles(chain.handles);
      await root.close();
    }
  });
  return Object.freeze({ path: relativePath, sha256: sha256(bytes) });
}

export function createNodeVerifier(
  target: TargetManifest,
  execution: () => PipelineOperationExecution,
): Readonly<{
  resolve(request: RootfsNodeResolutionRequest): Promise<RootfsNodeResolutionResult>;
}> {
  return Object.freeze({
    async resolve(request): Promise<RootfsNodeResolutionResult> {
      if (request.targetId !== target.id) {
        throw new Error('rootfs Node verifier target changed');
      }
      if (
        request.modules.length !== ROOTFS_NODE_MODULES.length
        || request.modules.some(({ packageName, specifier }, index) => (
          packageName !== ROOTFS_NODE_MODULES[index]?.[0]
          || specifier !== ROOTFS_NODE_MODULES[index]?.[1]
        ))
      ) {
        throw new Error('rootfs Node verifier request is outside the fixed operation contract');
      }
      const trusted = execution();
      if (trusted.operationId !== 'verify-image' || trusted.outcome !== 'passed') {
        throw new Error('trusted verify-image operation result is unavailable');
      }
      const stdout = trusted.observations.stdout;
      if (
        typeof stdout !== 'string'
        || stdout.includes('\r')
        || !stdout.endsWith('\n')
        || stdout.indexOf('\n') !== stdout.length - 1
      ) {
        throw new Error('trusted verify-image operation output is not one structured result');
      }
      const text = stdout.slice(0, -1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch (error) {
        throw new Error('trusted verify-image operation output is not JSON', { cause: error });
      }
      if (
        parsed === null
        || typeof parsed !== 'object'
        || Array.isArray(parsed)
        || JSON.stringify(parsed) !== text
      ) {
        throw new Error('trusted verify-image operation output is not canonical');
      }
      const result = parsed as Record<string, unknown>;
      if (
        Object.keys(result).join('\0')
          !== 'operation\0targetId\0relativePath\0size\0sha256\0nodeResolution'
        || result.operation !== 'verify-image'
        || result.targetId !== target.id
        || typeof result.relativePath !== 'string'
        || !Number.isSafeInteger(result.size)
        || (result.size as number) < 64 * 1024 * 1024
        || typeof result.sha256 !== 'string'
        || !/^[0-9a-f]{64}$/u.test(result.sha256)
        || !Array.isArray(result.nodeResolution)
      ) {
        throw new Error('trusted verify-image operation omitted exact Node resolution evidence');
      }
      stableRelativePath(result.relativePath, 'verified image path');
      const observed = result.nodeResolution as Array<{
        packageName?: unknown;
        specifier?: unknown;
        resolvedRelativePath?: unknown;
        exportType?: unknown;
      }>;
      if (observed.length !== request.modules.length) {
        throw new Error('trusted verify-image Node resolution count changed');
      }
      return Object.freeze({
        targetId: request.targetId,
        modules: Object.freeze(request.modules.map(({ packageName, specifier }, index) => {
          const candidate = observed[index];
          if (
            candidate === null
            || typeof candidate !== 'object'
            || Object.keys(candidate).join('\0')
              !== 'packageName\0specifier\0resolvedRelativePath\0exportType'
            || candidate.packageName !== packageName
            || candidate.specifier !== specifier
            || typeof candidate.resolvedRelativePath !== 'string'
            || !['function', 'object', 'incompatible'].includes(
              candidate.exportType as string,
            )
          ) {
            throw new Error('trusted verify-image Node resolution binding changed');
          }
          const relativePath = stableRelativePath(
            candidate.resolvedRelativePath,
            'resolved rootfs Node module',
          );
          const expectedRoot = specifier.startsWith('./')
            ? `${packageName}/`
            : `node_modules/${packageName}/`;
          if (!relativePath.startsWith(expectedRoot)) {
            throw new Error('trusted verify-image resolved rootfs Node module package changed');
          }
          return Object.freeze({
            packageName,
            resolvedRelativePath: relativePath,
            exportType: candidate.exportType as 'function' | 'object' | 'incompatible',
          });
        })),
      });
    },
  });
}

async function reopenPublication(
  registry: ApprovedRootRegistry,
  rootId: string,
  jobId: string,
  artifact: ArtifactInput,
): Promise<PublicationFileSet> {
  return withApprovedRootSnapshot(registry, rootId, async ({ snapshot }) => {
    const root = await open(snapshot.path, DIRECTORY_FLAGS);
    let chain: DirectoryChain | null = null;
    try {
      chain = await openDirectoryChain(
        root,
        ['.osi-image-builder', 'staging', jobId],
        false,
      );
      const artifactName = basename(artifact.stagingPath);
      const [image, checksum, manifest, verification] = await Promise.all([
        readHeldFile(chain.directory, artifactName),
        readHeldFile(chain.directory, 'sha256sums'),
        readHeldFile(chain.directory, 'build-manifest.json'),
        readHeldFile(chain.directory, 'verification.json'),
      ]);
      const reopenedArtifact: ArtifactInput = Object.freeze({
        stagingPath: `staging/${jobId}/${artifactName}`,
        artifactSha256: image.sha256,
        artifactSize: image.size,
        artifactMtime: image.mtime,
        checksumPath: `staging/${jobId}/sha256sums`,
        checksumSha256: checksum.sha256,
        manifestPath: `staging/${jobId}/build-manifest.json`,
        manifestSha256: manifest.sha256,
        verificationPath: `staging/${jobId}/verification.json`,
        verificationSha256: verification.sha256,
      });
      return Object.freeze({
        artifact: reopenedArtifact,
        buildManifestBytes: manifest.bytes.toString('utf8'),
        verificationManifestBytes: verification.bytes.toString('utf8'),
        checksumBytes: checksum.bytes.toString('utf8'),
      });
    } finally {
      if (chain !== null) await closeHandles(chain.handles);
      await root.close();
    }
  });
}

function createPublicationFiles(
  loaded: LoadedConfig,
  workspace: () => FileHandle,
): PipelineInput['services']['publicationFiles'] {
  return Object.freeze({
    async prepare(input): Promise<PreparedPublication> {
      return withApprovedRootSnapshot(
        loaded.pathAuthorities.approvedRoots,
        input.root.id,
        async ({ snapshot }) => {
          if (
            snapshot.path !== input.root.path
            || snapshot.device !== input.root.device
            || snapshot.inode !== input.root.inode
          ) {
            throw new Error('approved publication root identity changed');
          }
          const root = await open(snapshot.path, DIRECTORY_FLAGS);
          let parent: DirectoryChain | null = null;
          let staging: FileHandle | null = null;
          try {
            parent = await openDirectoryChain(
              root,
              ['.osi-image-builder', 'staging'],
              true,
            );
            await mkdir(fdPath(parent.directory, input.job.jobId), { mode: 0o700 });
            staging = await open(
              fdPath(parent.directory, input.job.jobId),
              DIRECTORY_FLAGS,
            );
            const image = await stageVerifiedArtifact(
              workspace(),
              input.artifact.path,
              staging,
              input.artifact.basename,
              input.artifact,
            );
            const [checksum, manifest, verification] = await Promise.all([
              writeHeldFile(staging, 'sha256sums', input.checksumBytes),
              writeHeldFile(staging, 'build-manifest.json', input.buildManifestBytes),
              writeHeldFile(
                staging,
                'verification.json',
                input.verificationManifestBytes,
              ),
            ]);
            await staging.sync();
            await parent.directory.sync();
            const artifact: ArtifactInput = Object.freeze({
              stagingPath: `staging/${input.job.jobId}/${input.artifact.basename}`,
              artifactSha256: image.sha256,
              artifactSize: image.size,
              artifactMtime: image.mtime,
              checksumPath: `staging/${input.job.jobId}/sha256sums`,
              checksumSha256: checksum.sha256,
              manifestPath: `staging/${input.job.jobId}/build-manifest.json`,
              manifestSha256: manifest.sha256,
              verificationPath: `staging/${input.job.jobId}/verification.json`,
              verificationSha256: verification.sha256,
            });
            return Object.freeze({
              artifact,
              buildManifestBytes: input.buildManifestBytes,
              verificationManifestBytes: input.verificationManifestBytes,
              checksumBytes: input.checksumBytes,
            });
          } finally {
            await staging?.close().catch(() => undefined);
            if (parent !== null) await closeHandles(parent.handles);
            await root.close();
          }
        },
      );
    },
    reopenStaging: ({ job, root, artifact }) => {
      if (job.rootId !== root.id) throw new Error('staging root differs from job authority');
      return reopenPublication(
        loaded.pathAuthorities.approvedRoots,
        root.id,
        job.jobId,
        artifact,
      );
    },
    async verifyFinal({ binding, artifact }): Promise<FinalPublicationProof> {
      return withApprovedRootSnapshot(
        loaded.pathAuthorities.approvedRoots,
        binding.rootId,
        async ({ snapshot }) => {
          if (
            snapshot.path !== binding.rootPath
            || snapshot.device !== binding.rootDevice
            || snapshot.inode !== binding.rootInode
          ) {
            throw new Error('final publication root identity changed');
          }
          const root = await open(snapshot.path, DIRECTORY_FLAGS);
          let stagingParent: DirectoryChain | null = null;
          let final: DirectoryChain | null = null;
          try {
            stagingParent = await openDirectoryChain(
              root,
              ['.osi-image-builder', 'staging'],
              false,
            );
            try {
              await lstat(fdPath(
                stagingParent.directory,
                safeSegment(binding.jobId, 'staging job ID'),
              ));
              throw new Error('staging still exists after native publication');
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            final = await openDirectoryChain(
              root,
              [binding.branchSlug, binding.pinnedSha, binding.targetId],
              false,
            );
            const [image, checksum, manifest, verification] = await Promise.all([
              readHeldFile(final.directory, basename(binding.finalPath)),
              readHeldFile(final.directory, 'sha256sums'),
              readHeldFile(final.directory, 'build-manifest.json'),
              readHeldFile(final.directory, 'verification.json'),
            ]);
            if (
              image.sha256 !== binding.artifactSha256
              || image.size !== binding.artifactSize
              || checksum.sha256 !== artifact.checksumSha256
              || manifest.sha256 !== artifact.manifestSha256
              || verification.sha256 !== artifact.verificationSha256
            ) {
              throw new Error('final publication files differ from persisted staging evidence');
            }
            return Object.freeze({
              verified: true,
              finalPath: binding.finalPath,
              artifactSha256: image.sha256,
              artifactSize: image.size,
              checksumPath: `${binding.finalDirectory}/sha256sums`,
              checksumSha256: checksum.sha256,
              manifestPath: `${binding.finalDirectory}/build-manifest.json`,
              manifestSha256: manifest.sha256,
              verificationPath: `${binding.finalDirectory}/verification.json`,
              verificationSha256: verification.sha256,
              staging: 'absent',
            });
          } finally {
            if (final !== null) await closeHandles(final.handles);
            if (stagingParent !== null) await closeHandles(stagingParent.handles);
            await root.close();
          }
        },
      );
    },
    async finalizeVerification(input): Promise<FinalPublicationProof> {
      const canonicalBytes = encodeJson(
        input.verificationManifest,
        'terminal verification manifest',
        true,
      );
      const observations = input.verificationManifest.observations;
      const publishEvidence = observations !== null
        && typeof observations === 'object'
        && !Array.isArray(observations)
        ? (observations as JsonObject).publishEvidence
        : null;
      const stages = observations !== null
        && typeof observations === 'object'
        && !Array.isArray(observations)
        ? (observations as JsonObject).stageEvidence
        : null;
      const publishEvidenceRecord = publishEvidence !== null
        && typeof publishEvidence === 'object'
        && !Array.isArray(publishEvidence)
        ? publishEvidence as JsonObject
        : null;
      const lastStage = Array.isArray(stages)
        ? stages.at(-1) as JsonObject | undefined
        : undefined;
      if (
        canonicalBytes !== input.verificationManifestBytes
        || publishEvidenceRecord === null
        || publishEvidenceRecord.path !== input.publishEvidencePath
        || publishEvidenceRecord.sha256 !== input.publishEvidenceSha256
        || !Array.isArray(stages)
        || stages.length !== 10
        || lastStage?.stage !== 'publish'
        || lastStage.outcome !== 'passed'
      ) {
        throw new Error('terminal verification manifest does not bind publish evidence');
      }
      return withApprovedRootSnapshot(
        loaded.pathAuthorities.approvedRoots,
        input.binding.rootId,
        async ({ snapshot }) => {
          if (
            snapshot.path !== input.binding.rootPath
            || snapshot.device !== input.binding.rootDevice
            || snapshot.inode !== input.binding.rootInode
          ) {
            throw new Error('terminal verification root identity changed');
          }
          const root = await open(snapshot.path, DIRECTORY_FLAGS);
          let final: DirectoryChain | null = null;
          const temporaryName = `.verification-${safeSegment(input.binding.jobId, 'job ID')}-${randomUUID()}.tmp`;
          try {
            final = await openDirectoryChain(
              root,
              [
                input.binding.branchSlug,
                input.binding.pinnedSha,
                input.binding.targetId,
              ],
              false,
            );
            const running = await readHeldFile(final.directory, 'verification.json');
            if (running.sha256 !== input.artifact.verificationSha256) {
              throw new Error('published verification input differs from staged authority');
            }
            await writeHeldFile(
              final.directory,
              temporaryName,
              input.verificationManifestBytes,
            );
            await rename(
              fdPath(final.directory, temporaryName),
              fdPath(final.directory, 'verification.json'),
            );
            await final.directory.sync();
            const [image, checksum, manifest, verification] = await Promise.all([
              readHeldFile(final.directory, basename(input.binding.finalPath)),
              readHeldFile(final.directory, 'sha256sums'),
              readHeldFile(final.directory, 'build-manifest.json'),
              readHeldFile(final.directory, 'verification.json'),
            ]);
            if (
              image.sha256 !== input.binding.artifactSha256
              || image.size !== input.binding.artifactSize
              || checksum.sha256 !== input.artifact.checksumSha256
              || manifest.sha256 !== input.artifact.manifestSha256
              || verification.sha256 !== sha256(input.verificationManifestBytes)
              || verification.bytes.toString('utf8') !== input.verificationManifestBytes
            ) {
              throw new Error('terminal publication files failed held revalidation');
            }
            return Object.freeze({
              verified: true,
              finalPath: input.binding.finalPath,
              artifactSha256: image.sha256,
              artifactSize: image.size,
              checksumPath: `${input.binding.finalDirectory}/sha256sums`,
              checksumSha256: checksum.sha256,
              manifestPath: `${input.binding.finalDirectory}/build-manifest.json`,
              manifestSha256: manifest.sha256,
              verificationPath: `${input.binding.finalDirectory}/verification.json`,
              verificationSha256: verification.sha256,
              staging: 'absent',
            });
          } finally {
            if (final !== null) await closeHandles(final.handles);
            await root.close();
          }
        },
      );
    },
  });
}

function compositionFailureContract(
  job: JobRecord,
  error: unknown,
): BuilderErrorContract {
  const cause = (error instanceof Error ? error.message : String(error)).slice(0, 2_048);
  return Object.freeze({
    code: 'BUILD_FAILED',
    stage: 'preflight',
    details: { cause },
    retryable: false,
    requestId: job.requestId,
    diagnosis: `runner composition failed: ${cause}`,
    recovery: 'Inspect the durable preflight evidence and repair the installed runner composition before retrying.',
  });
}

function persistCompositionRecoveryBlocker(
  input: GuardedCompositionInput,
  reason: string,
): PipelineResult {
  const job = input.store.getJob(input.args.jobId);
  if (!(ACTIVE_RECOVERY_STATES as readonly JobState[]).includes(job.state)) {
    return {
      state: 'recovery-required',
      buildManifest: null,
      verificationManifest: null,
      blockerCode: 'RUNNER_DISAPPEARED',
      reason,
    };
  }
  const at = input.clock.now();
  const blocker = {
    phase: 'composition',
    reason: reason.slice(0, 2_048),
    runnerUnit: input.args.runnerUnit,
    requestedOwner: input.args.owner,
    observedOwner: job.runnerLeaseOwner,
    observedLeaseExpiresAt: job.runnerLeaseExpiresAt,
  } as const;
  const result = input.ownership.apiWrite({
    kind: 'runner-recovery-blocker',
    jobId: job.jobId,
    expectedState: job.state as (typeof ACTIVE_RECOVERY_STATES)[number],
    runnerUnit: input.args.runnerUnit,
    observedOwner: job.runnerLeaseOwner,
    observedLeaseExpiresAt: job.runnerLeaseExpiresAt,
    blocker,
    at,
  });
  const persistedReason = result.ok
    ? reason
    : `${reason}; recovery blocker CAS failed: ${result.conflict.kind}`;
  return {
    state: 'recovery-required',
    buildManifest: null,
    verificationManifest: null,
    blockerCode: 'RUNNER_DISAPPEARED',
    reason: persistedReason,
  };
}

async function terminalizeCompositionFailure(
  input: GuardedCompositionInput,
  lease: PipelineLease,
  error: unknown,
): Promise<PipelineResult> {
  type CompositionRunnerCommand =
    | Omit<Extract<RunnerWriteCommand, { kind: 'stage' }>, 'jobId' | 'owner' | 'runnerUnit' | 'leaseExpiresAt' | 'at'>
    | Omit<Extract<RunnerWriteCommand, { kind: 'normal-terminal' }>, 'jobId' | 'owner' | 'runnerUnit' | 'leaseExpiresAt' | 'at'>;
  const runner = (command: CompositionRunnerCommand): void => {
    const result = input.ownership.runnerWrite({
      ...command,
      jobId: input.args.jobId,
      owner: lease.owner,
      runnerUnit: lease.runnerUnit,
      leaseExpiresAt: lease.expiresAt,
      at: input.clock.now(),
    } as RunnerWriteCommand);
    if (!result.ok) throw new Error(`composition ownership lost: ${result.conflict.kind}`);
  };
  const job = input.store.getJob(input.args.jobId);
  const contract = compositionFailureContract(job, error);
  const contractJson = normalizeJson(
    contract,
    'composition failure contract',
  ) as JsonObject;
  let stage = input.store.getStage(job.jobId, 'preflight');
  let startedAt: string;
  try {
    if (job.state === 'starting') {
      startedAt = input.clock.now();
      runner({
        kind: 'stage',
        expectedState: 'starting',
        state: 'preflight',
        stage: 'preflight',
        outcome: 'running',
        startedAt,
      });
      stage = input.store.getStage(job.jobId, 'preflight');
    } else if (job.state === 'preflight' && stage?.outcome === 'running') {
      startedAt = stage.startedAt!;
    } else if (job.state === 'preflight' && stage?.outcome === 'failed') {
      runner({
        kind: 'normal-terminal',
        expectedState: 'preflight',
        state: 'failed',
        terminalAt: input.clock.now(),
        errorCode: stage.errorCode ?? 'BUILD_FAILED',
        error: stage.error ?? contractJson,
      });
      return {
        state: 'failed',
        buildManifest: null,
        verificationManifest: null,
        blockerCode: null,
      };
    } else {
      return persistCompositionRecoveryBlocker(
        input,
        `composition failure cannot resume from ${job.state}`,
      );
    }
    const finishedAt = input.clock.now();
    const evidence = await input.evidenceWriter.write({
      jobId: job.jobId,
      stage: 'preflight',
      startedAt,
      finishedAt,
      outcome: 'failed',
      operationId: null,
      commands: [],
      inputs: {
        targetId: job.targetId,
        rootId: job.rootId,
        branch: job.branch,
        pinnedSha: job.pinnedSha,
      },
      observations: {
        phase: 'composition',
        runnerUnit: input.args.runnerUnit,
      },
      error: contract,
    });
    runner({
      kind: 'stage',
      expectedState: 'preflight',
      state: 'preflight',
      stage: 'preflight',
      outcome: 'failed',
      startedAt,
      finishedAt,
      evidencePath: evidence.path,
      evidenceSha256: evidence.sha256,
      errorCode: contract.code,
      error: contractJson,
    });
    runner({
      kind: 'normal-terminal',
      expectedState: 'preflight',
      state: 'failed',
      terminalAt: input.clock.now(),
      errorCode: contract.code,
      error: contractJson,
    });
    return {
      state: 'failed',
      buildManifest: null,
      verificationManifest: null,
      blockerCode: null,
    };
  } catch (terminalError) {
    return persistCompositionRecoveryBlocker(
      input,
      `composition terminalization failed: ${
        terminalError instanceof Error ? terminalError.message : String(terminalError)
      }`,
    );
  }
}

export async function runGuardedComposition(
  input: GuardedCompositionInput,
): Promise<PipelineResult> {
  const initial = input.store.getJob(input.args.jobId);
  let lease: PipelineLease | null = null;
  if (
    initial.state === 'starting'
    && initial.runnerUnit === input.args.runnerUnit
    && initial.runnerLeaseOwner === null
    && initial.runnerLeaseExpiresAt === null
  ) {
    const acquired = input.ownership.runnerWrite({
      kind: 'acquire-lease',
      jobId: input.args.jobId,
      runnerUnit: input.args.runnerUnit,
      owner: input.args.owner,
      expiresAt: input.args.leaseExpiresAt,
      at: input.clock.now(),
    });
    if (acquired.ok) {
      lease = Object.freeze({
        owner: input.args.owner,
        runnerUnit: input.args.runnerUnit,
        expiresAt: input.args.leaseExpiresAt,
      });
    }
  } else if (
    initial.runnerUnit === input.args.runnerUnit
    && initial.runnerLeaseOwner === input.args.owner
    && initial.runnerLeaseExpiresAt === input.args.leaseExpiresAt
    && initial.runnerLeaseExpiresAt > input.clock.now()
  ) {
    lease = Object.freeze({
      owner: input.args.owner,
      runnerUnit: input.args.runnerUnit,
      expiresAt: input.args.leaseExpiresAt,
    });
  }
  if (lease === null) {
    return persistCompositionRecoveryBlocker(
      input,
      'runner could not prove composition ownership',
    );
  }

  let composition: ProductionComposition;
  try {
    composition = await input.compose(lease);
  } catch (error) {
    return terminalizeCompositionFailure(input, lease, error);
  }
  try {
    let pipeline;
    try {
      pipeline = createPipeline({
        ...composition.input,
        initialLease: lease,
      });
    } catch (error) {
      return await terminalizeCompositionFailure(input, lease, error);
    }
    return await pipeline.run();
  } finally {
    await composition.close();
  }
}

async function createProductionComposition(
  args: RunnerArguments,
  loaded: LoadedConfig,
  store: BuilderStore,
  ownership: OwnershipStore,
): Promise<ProductionComposition> {
  const packageDirectory = dirname(loaded.config.builderLockPath);
  const manifestPath = join(packageDirectory, 'manifest', 'targets.json');
  const publisherPath = join(packageDirectory, 'bin', 'osi-image-publish');
  let workspaceHandle: FileHandle | null = null;
  let stateRootHandle: FileHandle | null = null;
  let stateRootIdentity: Readonly<{ path: string; device: number; inode: number }> | null = null;
  let approvedRootHandle: FileHandle | null = null;
  let heldPublisher: Awaited<ReturnType<typeof holdInstalledPublisher>> | null = null;
  try {
    heldPublisher = await holdInstalledPublisher(publisherPath);
    const [lockBytes, manifestBytes] = await Promise.all([
      readStableFile(loaded.config.builderLockPath),
      readStableFile(manifestPath),
    ]);
    const lock = parseInstalledLock(loaded.config.builderLockPath, lockBytes);
    const installedVersion = dirname(loaded.config.builderLockPath).split('/').at(-1);
    if (installedVersion === undefined) {
      throw new Error('installed publisher package version is unavailable');
    }
    const publisherAuthority = validateInstalledPublisherAuthority(
      lock,
      installedVersion,
      heldPublisher.bytes,
    );
    const manifest = loadManifestFromBytes(manifestPath, manifestBytes);
    const job = store.getJob(args.jobId);
    const target = manifest.manifest.targets.find(
      (candidate) => candidate.id === job.targetId,
    );
    if (target === undefined) throw new Error('persisted target is absent from installed manifest');
    const approvedRoot = await withApprovedRootSnapshot(
      loaded.pathAuthorities.approvedRoots,
      job.rootId,
      async ({ snapshot }) => Object.freeze({
        id: job.rootId,
        path: snapshot.path,
        device: snapshot.device,
        inode: snapshot.inode,
      }),
    );
    stateRootIdentity = await withStateRootSnapshot(
      loaded.pathAuthorities.stateRoot,
      async ({ snapshot }) => Object.freeze({
        path: snapshot.path,
        device: snapshot.device,
        inode: snapshot.inode,
      }),
    );
    stateRootHandle = await open(stateRootIdentity.path, DIRECTORY_FLAGS);
    approvedRootHandle = await open(approvedRoot.path, DIRECTORY_FLAGS);
    const preflight = createReadOnlyPreflightDefaults();
    const attempts = new Map<TrustedOperationId, number>();
    const completedExecutions = new Map<TrustedOperationId, PipelineOperationExecution>();
    let source: SourceSetupResult | null = null;
    let setup: TargetSetupResult | null = null;
    let targetSetupPhase: Extract<
      TargetSetupPhaseResult,
      { readonly phase: 'target-setup' }
    > | null = null;
    let feedsPhase: Extract<
      TargetSetupPhaseResult,
      { readonly phase: 'feeds' }
    > | null = null;
    let workspacePath: string | null = null;
    let workspaceIdentity: Readonly<{ device: number; inode: number }> | null = null;
    let heldOperationWorkspacePath: string | null = null;
    let activeTargetSetupEnvironment: string | null = null;
    const requireWorkspace = (): FileHandle => {
      if (workspaceHandle === null) throw new Error('held source workspace is unavailable');
      return workspaceHandle;
    };
    const requireWorkspaceDescriptor = (): string => {
      const handle = requireWorkspace();
      return `/proc/${String(process.pid)}/fd/${String(handle.fd)}`;
    };
    const revalidateWorkspace = async (): Promise<void> => {
      if (workspacePath === null || workspaceHandle === null || workspaceIdentity === null) {
        throw new Error('held source workspace chain is unavailable');
      }
      const [held, named] = await Promise.all([
        workspaceHandle.stat(),
        lstat(workspacePath),
      ]);
      if (
        !held.isDirectory()
        || !named.isDirectory()
        || named.isSymbolicLink()
        || held.dev !== workspaceIdentity.device
        || held.ino !== workspaceIdentity.inode
        || named.dev !== workspaceIdentity.device
        || named.ino !== workspaceIdentity.inode
      ) {
        throw new Error('held source workspace chain was replaced');
      }
    };
    const revalidateRoots = async (): Promise<void> => {
      if (
        stateRootHandle === null
        || stateRootIdentity === null
        || approvedRootHandle === null
      ) {
        throw new Error('held runner root authority is unavailable');
      }
      const [heldState, namedState, heldApproved, namedApproved] = await Promise.all([
        stateRootHandle.stat(),
        lstat(stateRootIdentity.path),
        approvedRootHandle.stat(),
        lstat(approvedRoot.path),
      ]);
      if (
        !heldState.isDirectory()
        || !namedState.isDirectory()
        || namedState.isSymbolicLink()
        || heldState.dev !== stateRootIdentity.device
        || heldState.ino !== stateRootIdentity.inode
        || namedState.dev !== stateRootIdentity.device
        || namedState.ino !== stateRootIdentity.inode
        || !heldApproved.isDirectory()
        || !namedApproved.isDirectory()
        || namedApproved.isSymbolicLink()
        || heldApproved.dev !== approvedRoot.device
        || heldApproved.ino !== approvedRoot.inode
        || namedApproved.dev !== approvedRoot.device
        || namedApproved.ino !== approvedRoot.inode
      ) {
        throw new Error('held runner root authority was replaced');
      }
    };

    const operations: PipelineInput['services']['operations'] = Object.freeze({
      async run(
        context,
        operationId,
        requestedDefinition,
      ): Promise<PipelineOperationExecution> {
        const attempt = (attempts.get(operationId) ?? 0) + 1;
        attempts.set(operationId, attempt);
        if (
          requestedDefinition !== undefined
          && !['target-setup', 'feeds', 'config'].includes(context.stage)
        ) {
          throw new Error('held operation definitions are restricted to target setup');
        }
        const operation = resolveTrustedOperationRequest({
          operationId,
          requestedDefinition,
          selectedEnvironment: context.target.environment,
          allowedEnvironments: manifest.manifest.targets.map(
            (candidate) => candidate.environment,
          ),
          activeTargetSetupEnvironment,
        });
        const { definition } = operation;
        const stdout: string[] = [];
        const stderr: string[] = [];
        const stageTimeout = manifest.manifest.stageDefinitions[context.stage]
          .timeoutSeconds * 1000;
        const executor = createDockerExecutor({
          dockerPath: TRUSTED_PREFLIGHT_EXECUTABLES.docker,
          imageReference: canonicalBuilderImageReference(lock),
          imageDigest: lock.imageDigest,
          jobId: context.job.jobId,
          manifestSha256: manifest.sha256,
          attempt,
          worktreePath: heldOperationWorkspacePath ?? requireWorkspaceDescriptor(),
          uid: typeof process.getuid === 'function' ? process.getuid() : 1000,
          gid: typeof process.getgid === 'function' ? process.getgid() : 1000,
          operationId,
          operationContext: { environment: operation.environment },
          operationTimeoutMs: stageTimeout,
          maxCaptureBytes: MAX_OPERATION_CAPTURE_BYTES,
          containerName: `osi-${sha256(
            `${context.job.jobId}\0${operationId}\0${String(attempt)}`,
          ).slice(0, 48)}`,
          store,
          ownership,
          leaseSnapshot: () => ({
            owner: context.lease.owner,
            unit: context.lease.runnerUnit,
            leaseExpiresAt: context.lease.expiresAt,
            expectedState: ({
              preflight: 'preflight',
              source: 'source',
              'release-gates': 'release_gates',
              frontend: 'frontend',
              'target-setup': 'target_setup',
              feeds: 'feeds',
              config: 'config',
              build: 'building',
              verify: 'verifying',
              publish: 'publishing',
            } satisfies Readonly<Record<PipelineStageName, JobState>>)[context.stage],
          }),
          evidence: (value) => writeOperationEvidence(
            loaded.pathAuthorities.stateRoot,
            context.job.jobId,
            operationId,
            attempt,
            value,
          ),
          finalizeLogs: async ({ operationFinishedAt }): Promise<LogCleanupProof> => ({
            runner: 'absent',
            docker: 'absent',
            verifiedAt: operationFinishedAt,
          }),
          ...(requestedDefinition !== undefined && operationId === 'activate-target'
            ? {
                classifyAcceptedResult(result: CommandResult) {
                  const classified = classifyTargetSetupOperationResult(
                    operationId,
                    requestedDefinition,
                    {
                      ...result,
                      argv: definition.argv,
                    },
                    context.job.requestId,
                  );
                  return classified.disposition === 'expected-rootfs-already-present'
                    ? classified.disposition
                    : null;
                },
              }
            : {}),
          onStdout: (chunk) => stdout.push(chunk),
          onStderr: (chunk) => stderr.push(chunk),
        });
        let executorError: unknown;
        try {
          const result = await executor.run();
          if (!result.available) throw new Error('locked Docker runtime is unavailable');
        } catch (error) {
          executorError = error;
        }
        const persisted = store.getOperation(
          context.job.jobId,
          operationId,
          attempt,
        );
        if (persisted === null) {
          throw executorError ?? new Error('Docker executor did not persist an operation');
        }
        const execution = mapOperation(
          persisted,
          context.stage,
          context.job.requestId,
          stdout.join(''),
          stderr.join(''),
        );
        if (executorError !== undefined && execution.outcome === 'passed') {
          throw executorError;
        }
        if (
          requestedDefinition !== undefined
          && operationId === 'activate-target'
        ) {
          const classified = classifyTargetSetupOperationResult(
            operationId,
            requestedDefinition,
            targetSetupCommand(execution),
            context.job.requestId,
          );
          if (
            classified.disposition === 'expected-rootfs-already-present'
              ? execution.outcome !== 'accepted'
                || execution.observations.acceptedDisposition
                  !== 'expected-rootfs-already-present'
              : execution.outcome !== 'passed'
          ) {
            throw new Error('persisted activate-target outcome differs from the trusted classifier');
          }
          activeTargetSetupEnvironment = operation.environment;
        }
        completedExecutions.set(operationId, execution);
        return execution;
      },
    });

    const runTargetSetupPhase = async (
      context: StageActionContext,
      phase: 'target-setup' | 'feeds' | 'config',
      profiles?: Extract<
        TargetSetupPhaseResult,
        { readonly phase: 'target-setup' }
      >['profiles'],
    ): Promise<Readonly<{
      result: TargetSetupPhaseResult;
      executions: readonly PipelineOperationExecution[];
    }>> => {
      const executions: PipelineOperationExecution[] = [];
      const result = await resolveTargetSetup({
        stateRoot: loaded.pathAuthorities.stateRoot,
        jobId: context.job.jobId,
        sourceSha: context.job.pinnedSha,
        target: context.target,
        targets: manifest.manifest.targets,
        preparedFeeds: offlineFeedPreparation(context.job),
        evidenceWriter: createEvidenceWriter({
          stateRoot: loaded.pathAuthorities.stateRoot,
        }),
        requestId: context.job.requestId,
        phase,
        ...(profiles === undefined ? {} : { profiles }),
        operations: createLockedTargetSetupOperations(
          async ({ operationId, definition, cwd }) => {
            if (heldOperationWorkspacePath !== null) {
              throw new Error('target setup attempted concurrent operations');
            }
            if (phase === 'config' && operationId === 'resolve-config') {
              const selected = manifest.manifest.targets.find((candidate) => (
                sameOperationDefinition(
                  definition,
                  createOperationDefinition(operationId, {
                    environment: candidate.environment,
                  }),
                )
              ));
              if (selected === undefined) {
                throw new Error('config phase definition is outside the target manifest');
              }
              activeTargetSetupEnvironment = selected.environment;
            }
            heldOperationWorkspacePath = cwd;
            let execution: PipelineOperationExecution;
            try {
              execution = await context.runTargetSetupOperation(
                operationId,
                definition,
              );
            } finally {
              heldOperationWorkspacePath = null;
            }
            executions.push(execution);
            if (
              execution.command.argv.length !== definition.argv.length
              || execution.command.argv.some(
                (value, index) => value !== definition.argv[index],
              )
            ) {
              throw new Error('Docker execution changed the held target setup definition');
            }
            return targetSetupCommand(execution);
          },
        ),
      });
      if (result.phase !== phase) {
        throw new Error('target setup phase result changed');
      }
      workspacePath = result.workspacePath;
      return Object.freeze({
        result,
        executions: Object.freeze(executions),
      });
    };

    const publicationFiles = createPublicationFiles(loaded, requireWorkspace);
    const services: PipelineInput['services'] = {
      workspace: {
        async revalidate({ stage, phase }) {
          await revalidateRoots();
          if (
            workspaceHandle === null
            && (stage === 'preflight' || stage === 'source' && phase === 'before')
          ) {
            return;
          }
          await revalidateWorkspace();
        },
      },
      preflight: {
        async recheck({ job: current, target: selected, root, lock: currentLock }) {
          const repository = await preflight.repository.inspect(
            loaded.config.repository.path,
          );
          const rootInspection = await preflight.paths.inspectApprovedRoot(
            loaded,
            root.id,
          );
          const staging = await preflight.paths.inspectStaging(loaded, root.id);
          const worktree = await preflight.paths.inspectWorktreeFilesystem(loaded);
          const release = await preflight.paths.inspectReleasePath(
            loaded,
            root.id,
            [encodeBranchSlug(current.branch), current.pinnedSha, selected.id],
          );
          const image = await preflight.docker.inspectLockedImage(
            canonicalBuilderImageReference(currentLock),
          );
          const systemd = await preflight.systemd.checkUserManager();
          const executableResults = await Promise.all(
            (Object.keys(TRUSTED_PREFLIGHT_EXECUTABLES) as Array<
              keyof typeof TRUSTED_PREFLIGHT_EXECUTABLES
            >).map((name) => preflight.executables.check(
              name,
              TRUSTED_PREFLIGHT_EXECUTABLES[name],
            )),
          );
          const [worktreeSpace, outputSpace, heldLock] = await Promise.all([
            preflight.fileSystem.statfs(worktree.path),
            preflight.fileSystem.statfs(rootInspection.path),
            preflight.lock.read(loaded.config.builderLockPath),
          ]);
          const selection = preflight.manifest.inspect(manifest, selected.id);
          if (
            !repository.isGitWorktree
            || !rootInspection.canonical
            || !rootInspection.writable
            || rootInspection.symlink
            || rootInspection.path !== root.path
            || rootInspection.device !== root.device
            || rootInspection.inode !== root.inode
            || !staging.canonical
            || !staging.writable
            || staging.symlink
            || staging.mountId !== rootInspection.mountId
            || worktreeSpace.freeBytes < loaded.config.diskFreeMinimumBytes
            || outputSpace.freeBytes < loaded.config.diskFreeMinimumBytes
            || release.finalExists
            || release.finalSymlink
            || !release.parentWritable
            || release.unsafeAncestor !== undefined
            || !image.available
            || image.imageDigest !== `sha256:${currentLock.imageDigest}`
            || !systemd.available
            || heldLock !== lockBytes.toString('utf8')
            || selection.sha256 !== manifest.sha256
            || selection.target?.id !== selected.id
            || executableResults.length !== Object.keys(
              TRUSTED_PREFLIGHT_EXECUTABLES,
            ).length
          ) {
            throw new Error('mandatory runner preflight recheck failed');
          }
          return Object.freeze({
            repository: loaded.config.repository.path,
            root: rootInspection,
            staging,
            worktree,
            freeBytes: {
              worktree: worktreeSpace.freeBytes,
              output: outputSpace.freeBytes,
            },
            image,
            systemd,
            executables: executableResults,
            manifestSha256: selection.sha256,
          });
        },
      },
      source: {
        async setup({ job: current, target: selected }) {
          const sourceIdentity = store.getSourceIdentity(current.jobId);
          source = await setupSourceWorktree({
            repositoryPath: loaded.config.repository.path,
            stateRoot: loaded.pathAuthorities.stateRoot,
            jobId: current.jobId,
            source: sourceIdentity,
            target: selected,
            requestId: current.requestId,
          });
          workspacePath = source.workspacePath;
          workspaceHandle = await open(source.workspacePath, DIRECTORY_FLAGS);
          const stats = await workspaceHandle.stat();
          if (!stats.isDirectory()) throw new Error('source workspace is not a held directory');
          workspaceIdentity = Object.freeze({
            device: stats.dev,
            inode: stats.ino,
          });
          await revalidateWorkspace();
          return Object.freeze({
            commands: source.commands,
            observations: source.observations,
          });
        },
      },
      operations,
      targetSetup: {
        async setup(
          context,
        ): Promise<TargetSetupStageResult<TargetSetupSourceObservations>> {
          const phase = await runTargetSetupPhase(context, 'target-setup');
          if (phase.result.phase !== 'target-setup') {
            throw new Error('target setup activation result is incomplete');
          }
          targetSetupPhase = phase.result;
          return Object.freeze({
            executions: phase.executions,
            observations: createTargetSetupSourceObservations(targetSetupPhase),
          });
        },
        async feeds(context): Promise<TargetSetupStageResult> {
          if (targetSetupPhase === null) {
            throw new Error('target setup activation evidence is unavailable');
          }
          const phase = await runTargetSetupPhase(context, 'feeds');
          if (phase.result.phase !== 'feeds') {
            throw new Error('target setup feed result is incomplete');
          }
          feedsPhase = phase.result;
          return Object.freeze({
            executions: phase.executions,
            observations: Object.freeze({
              feed: feedsPhase.feed,
              rust: feedsPhase.rust,
            }),
          });
        },
        async config(
          context,
        ): Promise<TargetSetupStageResult<TargetSetupConfigObservations>> {
          if (targetSetupPhase === null || feedsPhase === null) {
            throw new Error('target setup activation or feed evidence is unavailable');
          }
          const phase = await runTargetSetupPhase(
            context,
            'config',
            targetSetupPhase.profiles,
          );
          if (phase.result.phase !== 'config') {
            throw new Error('target setup config result is incomplete');
          }
          setup = Object.freeze({
            workspacePath: phase.result.workspacePath,
            target: phase.result.target,
            patchDecision: targetSetupPhase.patchDecision,
            feed: feedsPhase.feed,
            rust: feedsPhase.rust,
            config: phase.result.config,
          });
          return Object.freeze({
            executions: phase.executions,
            observations: createTargetSetupConfigObservations(phase.result),
          });
        },
      },
      verification: {
        async verify({ job: current, target: selected }): Promise<VerifiedPipelineArtifact> {
          if (source === null || setup === null) {
            throw new Error('source or target setup evidence is unavailable');
          }
          const build = [...attempts.entries()]
            .filter(([operationId]) => operationId === 'build-image')
            .map(([operationId, attempt]) => store.getOperation(
              current.jobId,
              operationId,
              attempt,
            ))
            .find((operation) => operation !== null);
          if (build === null || build === undefined) {
            throw new Error('build operation evidence is unavailable');
          }
          const result = await verifyFirmwareArtifacts({
            workspace: {
              stateRoot: loaded.pathAuthorities.stateRoot,
              jobId: current.jobId,
            },
            target: selected,
            targets: manifest.manifest.targets,
            buildStartedAt: build.startedAt,
            sourceEvidence: {
              targetId: selected.id,
              openwrtTarget: selected.openwrtTarget,
              targetOutputAbsent: source.observations.targetOutputAbsent,
              checkedTargetOutputPath: source.observations.checkedTargetOutputPath,
            },
            config: setup.config,
            pinnedSha: current.pinnedSha,
            branch: current.branch,
            nodeVerifier: createNodeVerifier(selected, () => {
              const execution = completedExecutions.get('verify-image');
              if (execution === undefined) {
                throw new Error('verify-image operation result is unavailable');
              }
              return execution;
            }),
            freshness: {
              client: createApiFreshnessSocketClient(
                loaded.pathAuthorities.stateRoot,
              ),
              store,
            },
          });
          return Object.freeze({
            artifact: result.artifact,
            config: result.config,
            verification: Object.freeze({
              checks: result.checks,
              rootfs: result.rootfs,
              freshness: result.freshness,
              evidence: result.evidence,
            }),
          });
        },
      },
      publicationFiles,
      publisher: createRunnerPublisherClient({
        executable: heldPublisher.executable,
        approvedRoots: loaded.config.approvedOutputRoots,
        expectedVersion: publisherAuthority.packageVersion,
        expectedSourceSha256: publisherAuthority.publisherSha256,
      }),
    };

    return Object.freeze({
      input: Object.freeze({
        jobId: args.jobId,
        runnerUnit: args.runnerUnit,
        owner: args.owner,
        leaseDurationMs: LEASE_DURATION_MS,
        clock: { now: () => new Date().toISOString() },
        store,
        ownership,
        manifest,
        target,
        approvedRoot,
        authoritativeFiles: {
          builderLockPath: loaded.config.builderLockPath,
          readBuilderLock: () => readStableFile(loaded.config.builderLockPath),
          targetManifestPath: manifestPath,
          readTargetManifest: () => readStableFile(manifestPath),
        },
        evidenceWriter: createEvidenceWriter({
          stateRoot: loaded.pathAuthorities.stateRoot,
        }),
        services,
      }),
      close: async () => {
        await workspaceHandle?.close().catch(() => undefined);
        await approvedRootHandle?.close().catch(() => undefined);
        await stateRootHandle?.close().catch(() => undefined);
        await heldPublisher?.close().catch(() => undefined);
      },
    });
  } catch (error) {
    await approvedRootHandle?.close().catch(() => undefined);
    await stateRootHandle?.close().catch(() => undefined);
    await heldPublisher?.close().catch(() => undefined);
    throw error;
  }
}

export function parseRunnerArguments(argv: readonly string[]): RunnerArguments {
  const allowed = new Set([
    'job-id',
    'runner-unit',
    'owner',
    'lease-expires-at',
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('runner arguments must be --key value pairs');
    }
    const name = key.slice(2);
    if (!allowed.has(name)) throw new Error(`unknown runner argument: --${name}`);
    if (values.has(name)) throw new Error(`duplicate runner argument: --${name}`);
    values.set(name, value);
    index += 1;
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined || value.length === 0) {
      throw new Error(`runner argument --${key} is required`);
    }
    return value;
  };
  const jobId = required('job-id');
  const runnerUnit = required('runner-unit');
  const owner = required('owner');
  const leaseExpiresAt = required('lease-expires-at');
  if (!SAFE_JOB.test(jobId)) throw new Error('runner job ID is invalid');
  if (
    !RUNNER_UNIT.test(runnerUnit)
    || runnerUnit !== `osi-image-builder-runner@${jobId}.service`
  ) {
    throw new Error('runner unit does not match the job ID');
  }
  if (!SAFE_OWNER.test(owner)) throw new Error('runner owner is invalid');
  if (
    new Date(leaseExpiresAt).toISOString() !== leaseExpiresAt
  ) {
    throw new Error('runner lease expiry is not canonical');
  }
  return Object.freeze({ jobId, runnerUnit, owner, leaseExpiresAt });
}

export async function runRunner(argv: readonly string[]): Promise<PipelineResult> {
  const args = parseRunnerArguments(argv);
  const state = await loadStateRootAuthority();
  const database = openBuilderDatabase(join(state.stateRoot, 'jobs.sqlite'));
  const store = new BuilderStore(database);
  const ownership = new OwnershipStore(database);
  const clock: PipelineClock = { now: () => new Date().toISOString() };
  try {
    return await runGuardedComposition({
      args,
      clock,
      store,
      ownership,
      evidenceWriter: createEvidenceWriter({
        stateRoot: state.authority,
      }),
      compose: async () => {
        const loaded = await loadConfig();
        if (loaded.stateRoot !== state.stateRoot) {
          throw new Error('configured state root differs from guarded runner state');
        }
        return createProductionComposition(
          args,
          loaded,
          store,
          ownership,
        );
      },
    });
  } finally {
    store.close();
  }
}
