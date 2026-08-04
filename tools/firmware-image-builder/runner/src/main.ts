import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants, type Stats } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path';

import {
  OwnershipStore,
  type LogCleanupProof,
  type ObservedJsonEvidence,
  type StagingCleanupProof,
  type RunnerWriteCommand,
} from '../../api/src/ownership.js';
import type {
  PublishingRecoveryArtifactObservation,
  PublishingRecoveryLogProof,
} from '../../api/src/publishing-recovery.js';
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
  canonicalInstant,
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
import { validateAdmittedBuilderPackage } from '../../domain/admitted-builder-package.js';
import { parseBuilderIdentity, type BuilderIdentity } from '../../domain/builder-identity.js';
import { createInstalledLockReader } from '../../domain/installed-lock.js';
import { createInstalledDependencyEgressProxyReader } from '../../domain/installed-dependency-egress-proxy.js';
import { installedMigrationsDirectory } from '../../domain/installed-layout.js';
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
import { loadInstalledDependencyEgressPolicy } from './network-policy.js';
import {
  createRunnerPublisherClient,
  type RunnerPublisherClient,
} from './publisher-client.js';
import {
  DockerCancellationRequestedError,
  createDockerContainerName,
  createDockerCancellationControls,
  createDockerExecutor,
} from './docker-executor.js';
import {
  CancellationBlockedError,
  createRunnerCancellation,
  type RecoveredRunnerCancellationEvidence,
} from './cancellation.js';
import {
  createEvidenceWriter,
  type EvidencePublication,
} from './evidence.js';
import { createApiFreshnessSocketClient } from './freshness.js';
import {
  createByteBoundedTextCapture,
  createRunnerLogCoordinator,
  type RunnerLogCoordinator,
} from './log-coordinator.js';
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
  type PipelineCancellation,
  type PipelineResult,
  type PreparedPublication,
  type PublicationBinding,
  type PublicationFilesPrepareInput,
  type StageActionContext,
  type TargetSetupStageResult,
  type VerifiedPipelineArtifact,
} from './pipeline.js';
import {
  setupSourceWorktree,
  type SourceSetupResult,
} from './source.js';
import { createTerminalVerification } from './terminal-verification.js';
import {
  classifyTargetSetupOperationResult,
  createLockedTargetSetupOperations,
  createTargetSetupConfigObservations,
  createTargetSetupSourceObservations,
  assertActiveTargetLinks,
  resolveTargetSetup,
  type OfflineFeedPreparation,
  type TargetSetupConfigObservations,
  type TargetSetupPhaseResult,
  type TargetSetupResult,
  type TargetSetupSourceObservations,
} from './target-setup.js';
import {
  createCommandExecutor,
  type CommandResult,
} from './command-executor.js';
import {
  verifyFirmwareArtifacts,
  type RootfsNodeResolutionRequest,
  type RootfsNodeResolutionResult,
} from './verification.js';

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

interface WorkspaceIdentity {
  readonly device: number;
  readonly inode: number;
}

export function assertTargetSetupWorkspaceIdentity(
  expected: WorkspaceIdentity | null,
  observed: WorkspaceIdentity,
): void {
  if (
    expected === null
    || !Number.isSafeInteger(observed.device)
    || !Number.isSafeInteger(observed.inode)
    || expected.device !== observed.device
    || expected.inode !== observed.inode
  ) {
    throw new Error('target-setup workspace identity does not match the retained workspace identity');
  }
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

export function resolveTargetSetupConfigEnvironment(input: Readonly<{
  readonly definition: OperationDefinition;
  readonly activeTargetSetupEnvironment: string | null;
  readonly manifestEnvironments: readonly string[];
}>): string {
  const active = input.activeTargetSetupEnvironment;
  if (active === null || !input.manifestEnvironments.includes(active)) {
    throw new Error('config phase has no active target environment from activate-target');
  }
  const expected = createOperationDefinition('resolve-config', { environment: active });
  if (!sameOperationDefinition(input.definition, expected)) {
    throw new Error('config phase definition does not match the active target environment');
  }
  return active;
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

export interface RunnerLaunchArguments {
  readonly jobId: string;
  readonly runnerUnit: string;
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
  readonly compose: () => Promise<ProductionComposition>;
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

export interface PublicationSealingDependencies {
  readonly afterVerificationTempRemovalSync?: (name: string) => void | Promise<void>;
  readonly afterVerificationTempSync?: (name: string) => void | Promise<void>;
  readonly afterFileChmod?: (name: string) => void | Promise<void>;
  readonly afterFileSync?: (name: string) => void | Promise<void>;
  readonly afterDirectoryChmod?: () => void | Promise<void>;
  readonly afterDirectorySync?: () => void | Promise<void>;
  readonly beforeCanonicalRevalidation?: () => void | Promise<void>;
  readonly beforeFinalCanonicalIdentityWalk?: () => void | Promise<void>;
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

async function assertPublicationMembership(
  parent: FileHandle,
  trackedNames: readonly string[],
  temporaryName: string | null,
): Promise<boolean> {
  const actual = (await readdir(fdPath(parent))).sort();
  const tracked = [...trackedNames].sort();
  if (actual.length === tracked.length && actual.every((name, index) => name === tracked[index])) {
    return false;
  }
  if (temporaryName !== null) {
    const recoverable = [...trackedNames, temporaryName].sort();
    if (actual.length === recoverable.length && actual.every((name, index) => name === recoverable[index])) {
      return true;
    }
  }
  throw new Error('accepted publication directory has an untracked member');
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

async function openOptionalDirectory(
  parent: FileHandle,
  name: string,
): Promise<FileHandle | null> {
  let handle: FileHandle;
  try {
    handle = await open(
      fdPath(parent, safeSegment(name, 'directory component')),
      DIRECTORY_FLAGS,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    if (!(await handle.stat()).isDirectory()) {
      throw new Error('held path component is not a directory');
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openOrCreateDirectory(
  parent: FileHandle,
  name: string,
): Promise<FileHandle> {
  const existing = await openOptionalDirectory(parent, name);
  if (existing !== null) return existing;
  const segment = safeSegment(name, 'directory component');
  try {
    await mkdir(fdPath(parent, segment), { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const created = await openOptionalDirectory(parent, segment);
  if (created === null) throw new Error('held directory creation was not observable');
  return created;
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

async function removeOwnedVerificationTemp(
  parent: FileHandle,
  name: string,
  expectedOwnerUid: number,
  expectedDevice: bigint | number,
): Promise<void> {
  const path = fdPath(parent, safeSegment(name, 'verification temp name'));
  const handle = await open(path, READ_FLAGS);
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.uid !== expectedOwnerUid
      || before.dev !== expectedDevice
      || (before.mode & 0o7777) !== 0o600
    ) {
      throw new Error('recoverable verification temp has unsafe metadata');
    }
    await unlink(path);
    const afterUnlink = await handle.stat();
    if (
      before.dev !== afterUnlink.dev
      || before.ino !== afterUnlink.ino
      || afterUnlink.nlink !== 0
    ) {
      throw new Error('recoverable verification temp path changed before unlink');
    }
    await parent.sync();
  } finally {
    await handle.close();
  }
}

async function hashHeldFile(
  parent: FileHandle,
  name: string,
): Promise<Readonly<{ sha256: string; size: number }>> {
  const handle = await open(fdPath(parent, safeSegment(name, 'file name')), READ_FLAGS);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('held artifact path is not a regular file');
    const digest = await hashHandle(handle);
    const after = await handle.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error('held artifact changed while being hashed');
    }
    return { sha256: digest, size: after.size };
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

interface AcceptedPublicationExpectation {
  readonly name: string;
  readonly sha256: string;
  readonly size: number | null;
  readonly mtime: string | null;
}

interface HeldAcceptedPublicationFile extends AcceptedPublicationExpectation {
  readonly handle: FileHandle;
  readonly identity: Readonly<{ dev: number; ino: number }>;
}

function modeOf(stats: Stats): number {
  return stats.mode & 0o7777;
}

async function validateAcceptedPublicationHandle(
  handle: FileHandle,
  expectation: AcceptedPublicationExpectation,
  allowedModes: readonly number[],
  ownerUid: number,
  device: number,
): Promise<Stats> {
  const before = await handle.stat();
  if (
    !before.isFile()
    || before.nlink !== 1
    || before.uid !== ownerUid
    || before.dev !== device
    || !allowedModes.includes(modeOf(before))
  ) {
    throw new Error('accepted publication file has unsafe metadata');
  }
  if (expectation.size !== null && before.size !== expectation.size) {
    throw new Error('accepted publication file size changed before sealing');
  }
  if (expectation.mtime !== null && before.mtime.toISOString() !== expectation.mtime) {
    throw new Error('accepted publication file mtime changed before sealing');
  }
  const digest = await hashHandle(handle);
  const after = await handle.stat();
  if (
    after.dev !== before.dev
    || after.ino !== before.ino
    || after.nlink !== before.nlink
    || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs
    || modeOf(after) !== modeOf(before)
    || digest !== expectation.sha256
  ) {
    throw new Error('accepted publication file changed while held');
  }
  return after;
}

async function holdAcceptedPublicationFile(
  parent: FileHandle,
  expectation: AcceptedPublicationExpectation,
  allowedModes: readonly number[],
  ownerUid: number,
  device: number,
): Promise<HeldAcceptedPublicationFile> {
  const handle = await open(
    fdPath(parent, safeSegment(expectation.name, 'accepted publication file name')),
    READ_FLAGS,
  );
  try {
    const stats = await validateAcceptedPublicationHandle(
      handle,
      expectation,
      allowedModes,
      ownerUid,
      device,
    );
    return { ...expectation, handle, identity: { dev: stats.dev, ino: stats.ino } };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertFinalCanonicalPublicationIdentity(input: Readonly<{
  readonly registry: ApprovedRootRegistry;
  readonly rootId: string;
  readonly rootPath: string;
  readonly rootDevice: number;
  readonly rootInode: number;
  readonly finalParts: readonly string[];
  readonly chainIdentities: readonly Readonly<{ dev: number; ino: number }>[];
  readonly finalIdentity: Readonly<{ dev: number; ino: number; uid: number }>;
  readonly files: readonly HeldAcceptedPublicationFile[];
}>): Promise<void> {
  await withApprovedRootSnapshot(input.registry, input.rootId, async ({ snapshot }) => {
    if (
      snapshot.path !== input.rootPath
      || snapshot.device !== input.rootDevice
      || snapshot.inode !== input.rootInode
    ) {
      throw new Error('accepted publication approved-root authority changed at final identity walk');
    }
    const root = await open(snapshot.path, DIRECTORY_FLAGS);
    let final: DirectoryChain | null = null;
    const named: FileHandle[] = [];
    try {
      const rootStats = await root.stat();
      if (
        !rootStats.isDirectory()
        || rootStats.dev !== input.rootDevice
        || rootStats.ino !== input.rootInode
      ) {
        throw new Error('accepted publication canonical root changed at final identity walk');
      }
      final = await openDirectoryChain(root, input.finalParts, false);
      if (final.handles.length !== input.chainIdentities.length) {
        throw new Error('accepted publication canonical chain is incomplete at final identity walk');
      }
      for (const [index, handle] of final.handles.entries()) {
        const stats = await handle.stat();
        const expected = input.chainIdentities[index]!;
        if (!stats.isDirectory() || stats.dev !== expected.dev || stats.ino !== expected.ino) {
          throw new Error('accepted publication canonical directory changed at final identity walk');
        }
      }
      const leaf = await final.directory.stat();
      if (
        !leaf.isDirectory()
        || leaf.nlink < 1
        || leaf.dev !== input.finalIdentity.dev
        || leaf.ino !== input.finalIdentity.ino
        || leaf.uid !== input.finalIdentity.uid
        || modeOf(leaf) !== 0o555
      ) {
        throw new Error('accepted publication canonical leaf is not sealed at final identity walk');
      }
      const names = input.files.map(({ name }) => name);
      await assertPublicationMembership(final.directory, names, null);
      for (const file of input.files) {
        named.push(await open(
          fdPath(final.directory, safeSegment(file.name, 'final canonical publication file name')),
          READ_FLAGS,
        ));
      }
      await assertPublicationMembership(final.directory, names, null);
      for (const [index, canonical] of named.entries()) {
        const file = input.files[index]!;
        const [canonicalStats, heldStats] = await Promise.all([
          canonical.stat(),
          file.handle.stat(),
        ]);
        if (
          !canonicalStats.isFile()
          || canonicalStats.nlink !== 1
          || canonicalStats.uid !== input.finalIdentity.uid
          || canonicalStats.dev !== file.identity.dev
          || canonicalStats.ino !== file.identity.ino
          || modeOf(canonicalStats) !== 0o444
          || heldStats.dev !== file.identity.dev
          || heldStats.ino !== file.identity.ino
          || heldStats.nlink !== 1
          || modeOf(heldStats) !== 0o444
        ) {
          throw new Error('accepted publication named inode changed at final identity walk');
        }
      }
    } finally {
      await closeHandles(named);
      if (final !== null) await closeHandles(final.handles);
      await root.close().catch(() => undefined);
    }
  });
}

async function sealAcceptedPublication(input: Readonly<{
  readonly registry: ApprovedRootRegistry;
  readonly rootId: string;
  readonly root: FileHandle;
  readonly rootPath: string;
  readonly rootDevice: number;
  readonly rootInode: number;
  readonly final: DirectoryChain;
  readonly finalParts: readonly string[];
  readonly artifact: ArtifactInput;
  readonly terminalVerificationSha256: string;
  readonly dependencies: PublicationSealingDependencies;
}>): Promise<void> {
  const finalStats = await input.final.directory.stat();
  const rootStats = await input.root.stat();
  const chainIdentities = await Promise.all(input.final.handles.map(async (handle) => {
    const stats = await handle.stat();
    return Object.freeze({ dev: stats.dev, ino: stats.ino });
  }));
  const finalMode = modeOf(finalStats);
  if (
    !finalStats.isDirectory()
    || finalStats.nlink < 1
    || finalStats.dev !== input.rootDevice
    || (finalMode !== 0o700 && finalMode !== 0o555)
  ) {
    throw new Error('accepted publication directory has an invalid seal state');
  }
  const allowedFileModes = finalMode === 0o700 ? [0o600, 0o444] as const : [0o444] as const;
  const expectations: readonly AcceptedPublicationExpectation[] = [
    {
      name: basename(input.artifact.stagingPath),
      sha256: input.artifact.artifactSha256,
      size: input.artifact.artifactSize,
      mtime: input.artifact.artifactMtime,
    },
    { name: 'sha256sums', sha256: input.artifact.checksumSha256, size: null, mtime: null },
    { name: 'build-manifest.json', sha256: input.artifact.manifestSha256, size: null, mtime: null },
    { name: 'verification.json', sha256: input.terminalVerificationSha256, size: null, mtime: null },
  ];
  await assertPublicationMembership(input.final.directory, expectations.map(({ name }) => name), null);
  const held: HeldAcceptedPublicationFile[] = [];
  try {
    for (const expectation of expectations) {
      held.push(await holdAcceptedPublicationFile(
        input.final.directory,
        expectation,
        allowedFileModes,
        finalStats.uid,
        finalStats.dev,
      ));
    }
    if (new Set(held.map(({ identity }) => `${identity.dev}:${identity.ino}`)).size !== held.length) {
      throw new Error('accepted publication files do not have distinct inodes');
    }
    for (const file of held) {
      await file.handle.chmod(0o444);
      await input.dependencies.afterFileChmod?.(file.name);
      await file.handle.sync();
      await input.dependencies.afterFileSync?.(file.name);
      const sealed = await file.handle.stat();
      if (
        sealed.dev !== file.identity.dev
        || sealed.ino !== file.identity.ino
        || modeOf(sealed) !== 0o444
      ) {
        throw new Error('accepted publication held inode did not seal read-only');
      }
    }
    await assertPublicationMembership(input.final.directory, expectations.map(({ name }) => name), null);
    await input.final.directory.chmod(0o555);
    await input.dependencies.afterDirectoryChmod?.();
    await input.final.directory.sync();
    await input.dependencies.afterDirectorySync?.();
    const sealedDirectory = await input.final.directory.stat();
    if (
      sealedDirectory.dev !== finalStats.dev
      || sealedDirectory.ino !== finalStats.ino
      || modeOf(sealedDirectory) !== 0o555
    ) {
      throw new Error('accepted publication directory did not seal read-only');
    }

    await input.dependencies.beforeCanonicalRevalidation?.();
    await withApprovedRootSnapshot(input.registry, input.rootId, async ({ snapshot }) => {
      if (
        snapshot.path !== input.rootPath
        || snapshot.device !== input.rootDevice
        || snapshot.inode !== input.rootInode
      ) {
        throw new Error('accepted publication approved-root authority changed after sealing');
      }
      const canonicalRoot = await open(snapshot.path, DIRECTORY_FLAGS);
      let canonicalFinal: DirectoryChain | null = null;
      try {
        const currentRoot = await canonicalRoot.stat();
        const heldRoot = await input.root.stat();
        if (
          currentRoot.dev !== rootStats.dev
          || currentRoot.ino !== rootStats.ino
          || heldRoot.dev !== rootStats.dev
          || heldRoot.ino !== rootStats.ino
        ) {
          throw new Error('accepted publication canonical root inode changed after sealing');
        }
        canonicalFinal = await openDirectoryChain(canonicalRoot, input.finalParts, false);
        if (canonicalFinal.handles.length !== chainIdentities.length) {
          throw new Error('accepted publication canonical directory chain changed after sealing');
        }
        for (const [index, handle] of canonicalFinal.handles.entries()) {
          const stats = await handle.stat();
          const expected = chainIdentities[index]!;
          if (stats.dev !== expected.dev || stats.ino !== expected.ino) {
            throw new Error('accepted publication canonical directory inode changed after sealing');
          }
        }
        const canonicalFinalStats = await canonicalFinal.directory.stat();
        if (
          canonicalFinalStats.dev !== finalStats.dev
          || canonicalFinalStats.ino !== finalStats.ino
          || modeOf(canonicalFinalStats) !== 0o555
        ) {
          throw new Error('accepted publication canonical directory is not sealed');
        }
        await assertPublicationMembership(
          canonicalFinal.directory,
          expectations.map(({ name }) => name),
          null,
        );
        for (const file of held) {
          const canonical = await open(
            fdPath(canonicalFinal.directory, safeSegment(file.name, 'canonical publication file name')),
            READ_FLAGS,
          );
          try {
            const canonicalStats = await validateAcceptedPublicationHandle(
              canonical,
              file,
              [0o444],
              finalStats.uid,
              finalStats.dev,
            );
            const heldStats = await validateAcceptedPublicationHandle(
              file.handle,
              file,
              [0o444],
              finalStats.uid,
              finalStats.dev,
            );
            if (
              canonicalStats.dev !== file.identity.dev
              || canonicalStats.ino !== file.identity.ino
              || heldStats.dev !== file.identity.dev
              || heldStats.ino !== file.identity.ino
            ) {
              throw new Error('accepted publication canonical named inode changed after sealing');
            }
          } finally {
            await canonical.close().catch(() => undefined);
          }
        }
      } finally {
        if (canonicalFinal !== null) await closeHandles(canonicalFinal.handles);
        await canonicalRoot.close().catch(() => undefined);
      }
    });
    await input.dependencies.beforeFinalCanonicalIdentityWalk?.();
    await assertFinalCanonicalPublicationIdentity({
      registry: input.registry,
      rootId: input.rootId,
      rootPath: input.rootPath,
      rootDevice: input.rootDevice,
      rootInode: input.rootInode,
      finalParts: input.finalParts,
      chainIdentities,
      finalIdentity: {
        dev: finalStats.dev,
        ino: finalStats.ino,
        uid: finalStats.uid,
      },
      files: held,
    });
  } finally {
    await closeHandles(held.map(({ handle }) => handle));
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
      const sourceMtime = new Date(stats.mtimeMs).toISOString();
      if (
        !stats.isFile()
        || stats.size !== expected.size
        || sourceMtime !== expected.mtime
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
        const copiedMtime = new Date(copied.mtimeMs).toISOString();
        if (
          !copied.isFile()
          || copied.size !== expected.size
          || copiedMtime !== expected.mtime
          || copiedHash !== expected.sha256
        ) {
          throw new Error('staged artifact differs from verified source');
        }
        return {
          sha256: copiedHash,
          size: copied.size,
          mtime: copiedMtime,
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
  readonly publisherExecutableSha256: string;
  readonly publisherSourceSha256: string;
}

export function validateInstalledPublisherAuthority(
  lock: Readonly<Pick<BuilderLock, 'schemaVersion' | 'packageVersion' | 'publisherSha256'>>,
  installedVersion: string,
  publisherBytes: Buffer,
  versionEvidence: Readonly<{
    readonly publisherVersion: string;
    readonly publisherSourceSha256: string;
  }>,
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
  if (versionEvidence.publisherVersion !== lock.packageVersion) {
    throw new Error('installed publisher version evidence does not match the builder lock');
  }
  if (
    !/^[0-9a-f]{64}$/u.test(versionEvidence.publisherSourceSha256)
    || /^0+$/u.test(versionEvidence.publisherSourceSha256)
  ) {
    throw new Error('installed publisher source hash evidence is invalid');
  }
  return Object.freeze({
    packageVersion: lock.packageVersion,
    publisherExecutableSha256: lock.publisherSha256,
    publisherSourceSha256: versionEvidence.publisherSourceSha256,
  });
}

export async function readHeldPublisherVersion(
  executable: string,
): Promise<Readonly<{
  readonly publisherVersion: string;
  readonly publisherSourceSha256: string;
}>> {
  const argv = [executable, '--version'] as const;
  const result = await createCommandExecutor().run(argv, {
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    timeoutMs: 30_000,
    maxCaptureBytes: 4_096,
  });
  if (
    JSON.stringify(result.argv) !== JSON.stringify(argv)
    || result.exitCode !== 0
    || result.signal !== null
    || result.timedOut
  ) {
    throw new Error('installed publisher version execution evidence is invalid');
  }
  const text = result.stdout.endsWith('\n')
    ? result.stdout.slice(0, -1)
    : result.stdout;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error('installed publisher returned invalid version evidence', {
      cause: error,
    });
  }
  if (
    parsed === null
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || JSON.stringify(parsed) !== text
    || Object.keys(parsed).join(',') !== 'available,version,sourceSha256'
  ) {
    throw new Error('installed publisher version evidence is not canonical');
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.available !== true
    || typeof value.version !== 'string'
    || typeof value.sourceSha256 !== 'string'
  ) {
    throw new Error('installed publisher version evidence is incomplete');
  }
  return Object.freeze({
    publisherVersion: value.version,
    publisherSourceSha256: value.sourceSha256,
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

async function writeRunnerCancellationEvidence(
  stateRoot: StateRootAuthority,
  jobId: string,
  value: JsonObject,
): Promise<Readonly<{ path: string; sha256: string }>> {
  const relativePath = `jobs/${jobId}/evidence/cancellation.json`;
  const bytes = Buffer.from(`${encodeJson(value, 'cancellation evidence', true)}\n`);
  await withStateRootSnapshot(stateRoot, async ({ snapshot }) => {
    const root = await open(snapshot.path, DIRECTORY_FLAGS);
    let chain: DirectoryChain | null = null;
    try {
      chain = await openDirectoryChain(root, ['jobs', jobId, 'evidence'], true);
      try {
        await writeHeldFile(chain.directory, 'cancellation.json', bytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await readHeldFile(chain.directory, 'cancellation.json');
        if (existing.sha256 !== sha256(bytes) || !existing.bytes.equals(bytes)) {
          throw new Error('immutable cancellation evidence does not match the retry payload');
        }
      }
      await chain.directory.sync();
    } finally {
      if (chain !== null) await closeHandles(chain.handles);
      await root.close();
    }
  });
  return Object.freeze({ path: relativePath, sha256: sha256(bytes) });
}

async function recoverRunnerCancellationEvidence(
  stateRoot: StateRootAuthority,
  jobId: string,
): Promise<RecoveredRunnerCancellationEvidence | null> {
  const relativePath = `jobs/${jobId}/evidence/cancellation.json`;
  return withStateRootSnapshot(stateRoot, async ({ snapshot }) => {
    const root = await open(snapshot.path, DIRECTORY_FLAGS);
    let chain: DirectoryChain | null = null;
    try {
      try {
        chain = await openDirectoryChain(root, ['jobs', jobId, 'evidence'], false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      let existing;
      try {
        existing = await readHeldFile(chain.directory, 'cancellation.json');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing.bytes.toString('utf8'));
      } catch (error) {
        throw new Error('immutable cancellation evidence is not valid JSON', { cause: error });
      }
      const value = normalizeJson(parsed, 'immutable cancellation evidence');
      if (value === null || Array.isArray(value) || typeof value !== 'object') {
        throw new Error('immutable cancellation evidence is not an object');
      }
      const canonical = Buffer.from(`${encodeJson(value, 'immutable cancellation evidence', true)}\n`);
      if (!existing.bytes.equals(canonical)) {
        throw new Error('immutable cancellation evidence bytes are not canonical');
      }
      return Object.freeze({
        value: value as JsonObject,
        path: relativePath,
        sha256: existing.sha256,
      });
    } finally {
      if (chain !== null) await closeHandles(chain.handles);
      await root.close();
    }
  });
}

export async function quarantineCancellationStaging(
  loaded: LoadedConfig,
  job: JobRecord,
  publisher: Pick<RunnerPublisherClient, 'quarantine'>,
): Promise<StagingCleanupProof> {
  if (
    job.artifactStagingPath !== null
    && (job.artifactSha256 === null || job.artifactSize === null)
  ) {
    throw new Error('cancellation staging identity is incomplete');
  }
  return withApprovedRootSnapshot(
    loaded.pathAuthorities.approvedRoots,
    job.rootId,
    async ({ snapshot }) => {
      const handles: FileHandle[] = [];
      const root = await open(snapshot.path, DIRECTORY_FLAGS);
      handles.push(root);
      try {
        const rootIdentity = await root.stat();
        if (
          rootIdentity.dev !== snapshot.device
          || rootIdentity.ino !== snapshot.inode
        ) {
          throw new Error('approved root identity changed before the held quarantine protocol');
        }
        const builder = await openOptionalDirectory(root, '.osi-image-builder');
        if (builder === null) {
          if (job.artifactStagingPath === null) return { kind: 'absent', path: null };
          throw new Error('cancellation staging parent is absent');
        }
        handles.push(builder);
        const stagingParent = await openOptionalDirectory(builder, 'staging');
        if (stagingParent === null) {
          if (job.artifactStagingPath === null) return { kind: 'absent', path: null };
          throw new Error('cancellation staging parent is absent');
        }
        handles.push(stagingParent);
        const source = await openOptionalDirectory(stagingParent, job.jobId);
        if (job.artifactStagingPath === null) {
          if (source !== null) {
            await source.close();
            throw new Error('physical staging is present while the persisted staging path is null');
          }
          return { kind: 'absent', path: null };
        }
        const artifactName = basename(job.artifactStagingPath);
        if (job.artifactStagingPath !== `staging/${job.jobId}/${artifactName}`) {
          if (source !== null) await source.close();
          throw new Error('cancellation staging path does not bind the fixed staging directory');
        }
        const quarantineParent = await openOrCreateDirectory(builder, 'quarantine');
        handles.push(quarantineParent);
        const destinationBefore = await openOptionalDirectory(quarantineParent, job.jobId);
        if (destinationBefore !== null) handles.push(destinationBefore);
        const verifyDestination = async (
          destination: FileHandle,
        ): Promise<Readonly<{ sha256: string; size: number }>> => {
          const observed = await hashHeldFile(destination, artifactName);
          if (
            observed.sha256 !== job.artifactSha256
            || observed.size !== job.artifactSize
          ) {
            throw new Error('cancellation quarantined artifact size or SHA does not match persisted identity');
          }
          return observed;
        };
        if (source === null) {
          if (destinationBefore === null) throw new Error('cancellation staging disappeared without quarantine evidence');
          const observed = await verifyDestination(destinationBefore);
          return {
            kind: 'quarantined',
            sourcePath: job.artifactStagingPath,
            destinationPath: `quarantine/${job.jobId}`,
            sourceAbsent: true,
            destinationPresent: true,
            sha256: observed.sha256,
            size: observed.size,
            verifiedAt: new Date().toISOString(),
          };
        }
        handles.push(source);
        const sourceIdentity = await source.stat();
        const result = await publisher.quarantine({
          rootId: job.rootId,
          jobId: job.jobId,
        });
        if (
          result.available !== true
          || result.quarantined !== true
          || result.renameResult !== 'RENAMED'
          || result.sourceRelativePath !== `.osi-image-builder/staging/${job.jobId}`
          || result.destinationRelativePath !== `.osi-image-builder/quarantine/${job.jobId}`
        ) {
          throw new Error(`native no-overwrite cancellation quarantine failed: ${result.renameResult ?? result.errorCode ?? 'unknown'}`);
        }
        const sourceAfter = await openOptionalDirectory(stagingParent, job.jobId);
        if (sourceAfter !== null) {
          await sourceAfter.close();
          throw new Error('cancellation staging quarantine was not proven through the held staging parent');
        }
        const destination = await openOptionalDirectory(quarantineParent, job.jobId);
        if (destination === null) throw new Error('cancellation quarantine destination is absent through the held parent');
        handles.push(destination);
        const destinationIdentity = await destination.stat();
        if (
          destinationBefore !== null
          || sourceIdentity.dev !== destinationIdentity.dev
          || sourceIdentity.ino !== destinationIdentity.ino
        ) {
          throw new Error('cancellation quarantine destination does not bind the held source directory');
        }
        const observed = await verifyDestination(destination);
        return {
          kind: 'quarantined',
          sourcePath: job.artifactStagingPath,
          destinationPath: `quarantine/${job.jobId}`,
          sourceAbsent: true,
          destinationPresent: true,
          sha256: observed.sha256,
          size: observed.size,
          verifiedAt: new Date().toISOString(),
        };
      } finally {
        await closeHandles(handles);
      }
    },
  );
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

export function createPublicationFiles(
  loaded: LoadedConfig,
  workspace: () => FileHandle,
  sealingDependencies: PublicationSealingDependencies = {},
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
        || Object.keys(publishEvidenceRecord).join('\0') !== 'path'
        || !/^[0-9a-f]{64}$/u.test(input.publishEvidenceSha256)
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
        async ({ snapshot, dependencies }) => {
          if (
            snapshot.path !== input.binding.rootPath
            || snapshot.device !== input.binding.rootDevice
            || snapshot.inode !== input.binding.rootInode
          ) {
            throw new Error('terminal verification root identity changed');
          }
          const root = await open(snapshot.path, DIRECTORY_FLAGS);
          let final: DirectoryChain | null = null;
          const temporaryName = `.verification-${safeSegment(input.binding.jobId, 'job ID')}.tmp`;
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
            const trackedNames = [
              basename(input.binding.finalPath),
              'sha256sums',
              'build-manifest.json',
              'verification.json',
            ] as const;
            const hasTemporary = await assertPublicationMembership(final.directory, trackedNames, temporaryName);
            const finalDirectoryStats = await final.directory.stat();
            if (!finalDirectoryStats.isDirectory() || finalDirectoryStats.nlink < 1) {
              throw new Error('published release directory identity is invalid');
            }
            const running = await readHeldFile(final.directory, 'verification.json');
            const terminalSha256 = sha256(input.verificationManifestBytes);
            const alreadyTerminal = (
              running.sha256 === terminalSha256
              && running.bytes.toString('utf8') === input.verificationManifestBytes
            );
            if (!alreadyTerminal && running.sha256 !== input.artifact.verificationSha256) {
              throw new Error('published verification input differs from staged authority');
            }
            if (!alreadyTerminal) {
              if (hasTemporary) {
                await removeOwnedVerificationTemp(
                  final.directory,
                  temporaryName,
                  finalDirectoryStats.uid,
                  finalDirectoryStats.dev,
                );
                await sealingDependencies.afterVerificationTempRemovalSync?.(temporaryName);
              }
              await writeHeldFile(
                final.directory,
                temporaryName,
                input.verificationManifestBytes,
              );
              await final.directory.sync();
              await sealingDependencies.afterVerificationTempSync?.(temporaryName);
              await rename(
                fdPath(final.directory, temporaryName),
                fdPath(final.directory, 'verification.json'),
              );
            } else if (hasTemporary) {
              await removeOwnedVerificationTemp(
                final.directory,
                temporaryName,
                finalDirectoryStats.uid,
                finalDirectoryStats.dev,
              );
              await sealingDependencies.afterVerificationTempRemovalSync?.(temporaryName);
            }
            await dependencies.beforeDirectorySync?.(final.directory);
            await final.directory.sync();
            await assertPublicationMembership(final.directory, trackedNames, null);
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
              || verification.sha256 !== terminalSha256
              || verification.bytes.toString('utf8') !== input.verificationManifestBytes
            ) {
              throw new Error('terminal publication files failed held revalidation');
            }
            await sealAcceptedPublication({
              registry: loaded.pathAuthorities.approvedRoots,
              rootId: input.binding.rootId,
              root,
              rootPath: snapshot.path,
              rootDevice: snapshot.device,
              rootInode: snapshot.inode,
              final,
              finalParts: [
                input.binding.branchSlug,
                input.binding.pinnedSha,
                input.binding.targetId,
              ],
              artifact: input.artifact,
              terminalVerificationSha256: terminalSha256,
              dependencies: sealingDependencies,
            });
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

function recoveryJsonObject(bytes: Buffer, field: string): JsonObject {
  const text = bytes.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${field} is not JSON`, { cause: error });
  }
  const canonical = encodeJson(parsed, field, true);
  if (text !== canonical) throw new Error(`${field} is not canonical JSON`);
  return normalizeJson(parsed, field) as JsonObject;
}

function recoveryStageEvidence(bytes: string, field: string): JsonObject {
  if (!bytes.endsWith('\n')) throw new Error(`${field} must end with one newline`);
  const content = bytes.slice(0, -1);
  if (content.endsWith('\n')) throw new Error(`${field} has more than one trailing newline`);
  const parsed = recoveryJsonObject(Buffer.from(content, 'utf8'), field);
  if (`${encodeJson(parsed, field, true)}\n` !== bytes) {
    throw new Error(`${field} is not canonical JSON`);
  }
  return parsed;
}

function sameRecoveryJson(left: unknown, right: unknown, field: string): boolean {
  return encodeJson(left, field, true) === encodeJson(right, field, true);
}

function recoveredEvidenceKeys(value: JsonObject, field: string): void {
  if (Object.keys(value).sort().join('\0') !== field) {
    throw new Error('stored recovery evidence has an invalid shape');
  }
}

function adoptRecoveredEvidence(input: Readonly<{
  readonly job: JobRecord;
  readonly stageStartedAt: string;
  readonly at: string;
  readonly expectedObservations: Readonly<Record<string, unknown>>;
  readonly publication: EvidencePublication;
}>): EvidencePublication {
  const stage = recoveryStageEvidence(input.publication.bytes, 'stored publish evidence');
  recoveredEvidenceKeys(
    stage,
    'commands\0error\0finishedAt\0inputs\0jobId\0observations\0operationId\0outcome\0schemaVersion\0stage\0startedAt',
  );
  if (
    stage.schemaVersion !== 1
    || stage.jobId !== input.job.jobId
    || stage.stage !== 'publish'
    || stage.startedAt !== input.stageStartedAt
    || stage.outcome !== 'passed'
    || stage.operationId !== null
    || !Array.isArray(stage.commands)
    || stage.commands.length !== 0
    || stage.error !== null
  ) {
    throw new Error('stored publish evidence does not bind the recovered job');
  }
  const finishedAt = canonicalInstant(stage.finishedAt, 'stored publish evidence finishedAt');
  canonicalInstant(input.stageStartedAt, 'publish stage start');
  const recoveryAt = canonicalInstant(input.at, 'recovery time');
  if (finishedAt < input.stageStartedAt || finishedAt > recoveryAt) {
    throw new Error('stored publish evidence chronology is invalid');
  }
  if (stage.inputs === null || typeof stage.inputs !== 'object' || Array.isArray(stage.inputs)) {
    throw new Error('stored publish evidence inputs are invalid');
  }
  const expectedInputs = {
    targetId: input.job.targetId,
    rootId: input.job.rootId,
    branch: input.job.branch,
    pinnedSha: input.job.pinnedSha,
  };
  if (!sameRecoveryJson(stage.inputs, expectedInputs, 'stored publish evidence inputs')) {
    throw new Error('stored publish evidence inputs do not bind the recovered job');
  }
  if (stage.observations === null || typeof stage.observations !== 'object' || Array.isArray(stage.observations)) {
    throw new Error('stored publish evidence observations are invalid');
  }
  const observations = stage.observations as JsonObject;
  recoveredEvidenceKeys(observations, 'checksum\0final\0logs\0manifest\0staging\0verification');
  const expected = input.expectedObservations as JsonObject;
  for (const field of ['checksum', 'final', 'manifest', 'staging', 'verification'] as const) {
    if (!sameRecoveryJson(observations[field], expected[field], `stored publish evidence ${field}`)) {
      throw new Error(`stored publish evidence ${field} does not bind the recovered artifact`);
    }
  }
  const logs = observations.logs;
  if (
    logs === null
    || typeof logs !== 'object'
    || Array.isArray(logs)
    || Object.keys(logs).sort().join('\0') !== 'docker\0noGap\0runner\0verifiedAt'
    || (logs as JsonObject).runner !== 'sealed'
    || (logs as JsonObject).docker !== 'sealed'
    || (logs as JsonObject).noGap !== true
  ) {
    throw new Error('stored publish evidence logs are incomplete');
  }
  const verifiedAt = canonicalInstant((logs as JsonObject).verifiedAt, 'stored log verification time');
  if (verifiedAt < input.stageStartedAt || verifiedAt > recoveryAt) {
    throw new Error('stored publish evidence logs do not bind the recovery interval');
  }
  return input.publication;
}

function recoveryArtifact(job: JobRecord): ArtifactInput {
  if (
    job.artifactStagingPath === null
    || job.artifactSha256 === null
    || job.artifactSize === null
    || job.artifactMtime === null
    || job.checksumPath === null
    || job.checksumSha256 === null
    || job.manifestPath === null
    || job.manifestSha256 === null
    || job.verificationPath === null
    || job.verificationSha256 === null
  ) {
    throw new Error('publishing recovery artifact identity is incomplete');
  }
  return Object.freeze({
    stagingPath: job.artifactStagingPath,
    artifactSha256: job.artifactSha256,
    artifactSize: job.artifactSize,
    artifactMtime: job.artifactMtime,
    checksumPath: job.checksumPath,
    checksumSha256: job.checksumSha256,
    manifestPath: job.manifestPath,
    manifestSha256: job.manifestSha256,
    verificationPath: job.verificationPath,
    verificationSha256: job.verificationSha256,
  });
}

async function inspectRecoveredPublication(
  loaded: LoadedConfig,
  job: JobRecord,
  artifact: ArtifactInput,
): Promise<Readonly<{
  readonly binding: PublicationBinding;
  readonly observed: PublishingRecoveryArtifactObservation;
}>> {
  if (
    job.state !== 'publishing'
    || job.publishState !== 'publishing'
    || job.artifactFinalDirectory === null
    || job.artifactFinalPath === null
  ) {
    throw new Error('publishing recovery job binding is incomplete');
  }
  const branchSlug = encodeBranchSlug(job.branch);
  const finalDirectory = `${branchSlug}/${job.pinnedSha}/${job.targetId}`;
  const artifactName = basename(artifact.stagingPath);
  const finalPath = `${finalDirectory}/${artifactName}`;
  if (
    job.artifactFinalDirectory !== finalDirectory
    || job.artifactFinalPath !== finalPath
    || artifact.stagingPath !== `staging/${job.jobId}/${artifactName}`
    || artifact.checksumPath !== `staging/${job.jobId}/sha256sums`
    || artifact.manifestPath !== `staging/${job.jobId}/build-manifest.json`
    || artifact.verificationPath !== `staging/${job.jobId}/verification.json`
  ) {
    throw new Error('publishing recovery paths do not match the durable binding');
  }
  const configuredRoot = loaded.config.approvedOutputRoots.find(
    (root) => root.id === job.rootId,
  );
  if (configuredRoot === undefined) throw new Error('publishing recovery root is unknown');
  return withApprovedRootSnapshot(
    loaded.pathAuthorities.approvedRoots,
    job.rootId,
    async ({ snapshot }) => {
      if (snapshot.path !== configuredRoot.path) {
        throw new Error('publishing recovery root authority changed');
      }
      const binding: PublicationBinding = Object.freeze({
        jobId: job.jobId,
        rootId: job.rootId,
        rootPath: snapshot.path,
        rootDevice: snapshot.device,
        rootInode: snapshot.inode,
        branch: job.branch,
        branchSlug,
        pinnedSha: job.pinnedSha,
        targetId: job.targetId,
        stagingDirectory: `staging/${job.jobId}`,
        stagingPath: artifact.stagingPath,
        finalDirectory,
        finalPath,
        artifactSha256: artifact.artifactSha256,
        artifactSize: artifact.artifactSize,
      });
      const root = await open(snapshot.path, DIRECTORY_FLAGS);
      let final: DirectoryChain | null = null;
      let stagingParent: DirectoryChain | null = null;
      try {
        stagingParent = await openDirectoryChain(
          root,
          ['.osi-image-builder', 'staging'],
          false,
        );
        try {
          await lstat(fdPath(stagingParent.directory, safeSegment(job.jobId, 'job ID')));
          throw new Error('staging remains after recovered publication');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        final = await openDirectoryChain(
          root,
          [branchSlug, job.pinnedSha, job.targetId],
          false,
        );
        const [image, checksum, manifest, verification] = await Promise.all([
          readHeldFile(final.directory, artifactName),
          readHeldFile(final.directory, 'sha256sums'),
          readHeldFile(final.directory, 'build-manifest.json'),
          readHeldFile(final.directory, 'verification.json'),
        ]);
        const checksumBytes = checksum.bytes.toString('utf8');
        if (
          image.sha256 !== artifact.artifactSha256
          || image.size !== artifact.artifactSize
          || image.mtime !== artifact.artifactMtime
          || checksum.sha256 !== artifact.checksumSha256
          || checksumBytes !== `${artifact.artifactSha256}  ${artifactName}\n`
          || manifest.sha256 !== artifact.manifestSha256
        ) {
          throw new Error('recovered final publication differs from persisted artifact identity');
        }
        const manifestContent = recoveryJsonObject(manifest.bytes, 'recovered build manifest');
        const verificationContent = recoveryJsonObject(
          verification.bytes,
          'recovered verification manifest',
        );
        for (const [content, field] of [
          [manifestContent, 'build manifest'],
          [verificationContent, 'verification manifest'],
        ] as const) {
          if (
            content.jobId !== job.jobId
            || content.branch !== job.branch
            || content.pinnedSha !== job.pinnedSha
            || content.targetId !== job.targetId
            || content.artifactSha256 !== artifact.artifactSha256
          ) {
            throw new Error(`recovered ${field} does not bind the publishing job`);
          }
        }
        return Object.freeze({
          binding,
          observed: Object.freeze({
            final: Object.freeze({
              present: true,
              path: finalPath,
              held: true,
              size: image.size,
              sha256: image.sha256,
            }),
            checksum: Object.freeze({
              present: true,
              path: `${finalDirectory}/sha256sums`,
              contents: checksumBytes,
              sha256: checksum.sha256,
            }),
            manifest: Object.freeze({
              present: true,
              path: `${finalDirectory}/build-manifest.json`,
              bytes: manifest.bytes.toString('utf8'),
              content: manifestContent,
              sha256: manifest.sha256,
            }),
            verification: Object.freeze({
              present: true,
              path: `${finalDirectory}/verification.json`,
              bytes: verification.bytes.toString('utf8'),
              content: verificationContent,
              sha256: verification.sha256,
            }),
            staging: Object.freeze({
              state: 'absent' as const,
              path: null,
              sha256: null,
              size: null,
              held: false,
            }),
            quarantine: Object.freeze({
              state: 'absent' as const,
              path: null,
              held: false,
              artifactPath: null,
              artifactSize: null,
              artifactSha256: null,
            }),
          }),
        });
      } finally {
        if (final !== null) await closeHandles(final.handles);
        if (stagingParent !== null) await closeHandles(stagingParent.handles);
        await root.close();
      }
    },
  );
}

export async function completeRecoveredPublication(input: Readonly<{
  readonly loaded: LoadedConfig;
  readonly job: JobRecord;
  readonly stageStartedAt: string;
  readonly at: string;
  readonly logs: PublishingRecoveryLogProof;
  readonly sealingDependencies?: PublicationSealingDependencies;
}>): Promise<Readonly<{
  readonly observed: PublishingRecoveryArtifactObservation;
  readonly stageEvidence: ObservedJsonEvidence;
}>> {
  const artifact = recoveryArtifact(input.job);
  const inspected = await inspectRecoveredPublication(input.loaded, input.job, artifact);
  const terminal = createTerminalVerification(
    input.job.jobId,
    inspected.observed.verification.content!,
  );
  const terminalSha256 = sha256(terminal.bytes);
  if (
    inspected.observed.verification.sha256 !== artifact.verificationSha256
    && (
      inspected.observed.verification.sha256 !== terminalSha256
      || inspected.observed.verification.bytes !== terminal.bytes
    )
  ) {
    throw new Error('recovered verification differs from staged and terminal authority');
  }
  const terminalVerification = Object.freeze({
    ...inspected.observed.verification,
    bytes: terminal.bytes,
    content: terminal.manifest,
    sha256: terminalSha256,
  });
  const stageObservations = Object.freeze({
    checksum: inspected.observed.checksum,
    final: Object.freeze({ verificationSha256: terminalSha256 }),
    logs: input.logs,
    manifest: inspected.observed.manifest,
    staging: inspected.observed.staging,
    verification: terminalVerification,
  });
  const evidenceWriter = createEvidenceWriter({
    stateRoot: input.loaded.pathAuthorities.stateRoot,
  });
  const evidenceInput = {
    jobId: input.job.jobId,
    stage: 'publish',
    startedAt: input.stageStartedAt,
    finishedAt: input.at,
    outcome: 'passed',
    operationId: null,
    commands: [],
    inputs: {
      targetId: input.job.targetId,
      rootId: input.job.rootId,
      branch: input.job.branch,
      pinnedSha: input.job.pinnedSha,
    },
    observations: stageObservations,
    error: null,
  } as const;
  const preparedEvidence = evidenceWriter.prepare(evidenceInput);
  const existingEvidence = await evidenceWriter.read(preparedEvidence.path);
  const evidence = existingEvidence === null
    ? null
    : adoptRecoveredEvidence({
      job: input.job,
      stageStartedAt: input.stageStartedAt,
      at: input.at,
      expectedObservations: stageObservations,
      publication: existingEvidence,
    });
  const evidenceIdentity = evidence ?? preparedEvidence;
  await createPublicationFiles(input.loaded, () => {
    throw new Error('publishing recovery has no workspace authority');
  }, input.sealingDependencies).finalizeVerification({
    binding: inspected.binding,
    artifact,
    verificationManifest: terminal.manifest,
    verificationManifestBytes: terminal.bytes,
    publishEvidencePath: evidenceIdentity.path,
    publishEvidenceSha256: evidenceIdentity.sha256,
  });
  const publishedEvidence = evidence ?? await evidenceWriter.write(evidenceInput);
  if (publishedEvidence.path !== evidenceIdentity.path || publishedEvidence.sha256 !== evidenceIdentity.sha256) {
    throw new Error('published recovery evidence differs from its adopted identity');
  }
  const completed = await inspectRecoveredPublication(input.loaded, input.job, {
    ...artifact,
    verificationSha256: terminalSha256,
  });
  if (
    completed.observed.verification.sha256 !== terminalSha256
    || completed.observed.verification.bytes !== terminal.bytes
  ) {
    throw new Error('recovered terminal verification failed final revalidation');
  }
  return Object.freeze({
    observed: completed.observed,
    stageEvidence: Object.freeze({
      present: true,
      path: publishedEvidence.path,
      bytes: publishedEvidence.bytes,
      sha256: publishedEvidence.sha256,
    }),
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

type CompositionOutcome =
  | Readonly<{ readonly kind: 'success'; readonly composition: ProductionComposition }>
  | Readonly<{ readonly kind: 'error'; readonly error: unknown }>;

type GuardedCompositionOutcome =
  | Readonly<{ readonly kind: 'success'; readonly composition: ProductionComposition; readonly lease: PipelineLease }>
  | Readonly<{ readonly kind: 'error'; readonly error: unknown; readonly lease: PipelineLease }>
  | Readonly<{ readonly kind: 'ownership-lost'; readonly reason: string }>;

function renewCompositionLease(
  input: GuardedCompositionInput,
  lease: PipelineLease,
): PipelineLease | string {
  const at = input.clock.now();
  const atMs = Date.parse(at);
  const currentExpiryMs = Date.parse(lease.expiresAt);
  if (!Number.isFinite(atMs) || !Number.isFinite(currentExpiryMs)) {
    return 'runner composition lease chronology is invalid';
  }
  const expiresAt = new Date(Math.max(
    atMs + LEASE_DURATION_MS,
    currentExpiryMs + 1_000,
  )).toISOString();
  try {
    const renewed = input.ownership.runnerWrite({
      kind: 'renew-lease',
      jobId: input.args.jobId,
      runnerUnit: lease.runnerUnit,
      owner: lease.owner,
      expectedExpiresAt: lease.expiresAt,
      expiresAt,
      at,
    });
    if (!renewed.ok) {
      return `runner composition lease renewal lost ownership: ${renewed.conflict.kind}`;
    }
  } catch (error) {
    return `runner composition lease renewal failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  return Object.freeze({
    owner: lease.owner,
    runnerUnit: lease.runnerUnit,
    expiresAt,
  });
}

async function composeWithLeaseHeartbeat(
  input: GuardedCompositionInput,
  initialLease: PipelineLease,
): Promise<GuardedCompositionOutcome> {
  const pending = Promise.resolve()
    .then(input.compose)
    .then(
      (composition): CompositionOutcome => ({ kind: 'success', composition }),
      (error: unknown): CompositionOutcome => ({ kind: 'error', error }),
    );
  const interval = Math.max(1_000, Math.floor(LEASE_DURATION_MS / 3));
  let lease = initialLease;
  while (true) {
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      pending,
      new Promise<Readonly<{ readonly kind: 'heartbeat' }>>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'heartbeat' }), interval);
        timer.unref();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (result.kind === 'success') return { ...result, lease };
    if (result.kind === 'error') return { ...result, lease };
    const renewed = renewCompositionLease(input, lease);
    if (typeof renewed !== 'string') {
      lease = renewed;
      continue;
    }

    const settled = await pending;
    let reason = renewed;
    if (settled.kind === 'success') {
      try {
        await settled.composition.close();
      } catch (error) {
        reason += `; composition close failed after lease loss: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    return { kind: 'ownership-lost', reason };
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

  const composed = await composeWithLeaseHeartbeat(input, lease);
  if (composed.kind === 'ownership-lost') {
    return persistCompositionRecoveryBlocker(input, composed.reason);
  }
  lease = composed.lease;
  if (composed.kind === 'error') {
    return terminalizeCompositionFailure(input, lease, composed.error);
  }
  const composition = composed.composition;
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
  database: DatabaseSync,
  store: BuilderStore,
  ownership: OwnershipStore,
): Promise<ProductionComposition> {
  const job = store.getJob(args.jobId);
  if (job.builderIdentity === null) throw new Error('runner job has no complete admitted builder identity');
  const builderIdentity = job.builderIdentity;
  const packageDirectory = builderIdentity.packageRoot;
  const lockPath = join(packageDirectory, 'builder.lock.json');
  const installedLockReader = createInstalledLockReader();
  const readInstalledLock = async (): Promise<Buffer> => (
    await installedLockReader.read(packageDirectory)
  ).bytes;
  const manifestPath = join(packageDirectory, 'manifest', 'targets.json');
  const publisherPath = join(packageDirectory, 'bin', 'osi-image-publish');
  const runnerPath = join(packageDirectory, 'bin', 'osi-image-builder-runner');
  const cleanupWorkerPath = join(packageDirectory, 'bin', 'osi-image-builder-cleanup');
  const executionDefinitionPath = join(packageDirectory, 'execution-definition.json');
  let packageHandle: FileHandle | null = null;
  let packageIdentity: Readonly<{ device: number; inode: number }> | null = null;
  let workspaceHandle: FileHandle | null = null;
  let stateRootHandle: FileHandle | null = null;
  let stateRootIdentity: Readonly<{ path: string; device: number; inode: number }> | null = null;
  let approvedRootHandle: FileHandle | null = null;
  let heldPublisher: Awaited<ReturnType<typeof holdInstalledPublisher>> | null = null;
  let coordinator: RunnerLogCoordinator | null = null;
  try {
    const namedPackage = await lstat(packageDirectory);
    packageHandle = await open(packageDirectory, DIRECTORY_FLAGS);
    const heldPackage = await packageHandle.stat();
    const ownerUid = typeof process.geteuid === 'function' ? process.geteuid() : heldPackage.uid;
    if (
      !namedPackage.isDirectory() || namedPackage.isSymbolicLink()
      || !heldPackage.isDirectory()
      || namedPackage.dev !== heldPackage.dev || namedPackage.ino !== heldPackage.ino
      || heldPackage.uid !== ownerUid || (heldPackage.mode & 0o777) !== 0o555
    ) throw new Error('admitted builder package directory authority is unsafe');
    packageIdentity = Object.freeze({ device: heldPackage.dev, inode: heldPackage.ino });
    const [lockBytes, manifestBytes, executionDefinitionBytes, runnerBytes, cleanupWorkerBytes, dependencyEgressProxy] = await Promise.all([
      readInstalledLock(),
      readStableFile(manifestPath),
      readStableFile(executionDefinitionPath),
      readStableFile(runnerPath),
      readStableFile(cleanupWorkerPath),
      createInstalledDependencyEgressProxyReader({ ownerUid })
        .read(packageDirectory, builderIdentity.dependencyEgressProxySha256),
    ]);
    const manifest = loadManifestFromBytes(manifestPath, manifestBytes);
    const lock = validateAdmittedBuilderPackage({
      identity: builderIdentity,
      lockBytes,
      executionDefinition: executionDefinitionBytes,
      runner: runnerBytes,
      cleanupWorker: cleanupWorkerBytes,
      dependencyEgressProxy: dependencyEgressProxy.bytes,
      manifestSha256: manifest.sha256,
    });
    if (manifest.sha256 !== job.targetManifestSha256) throw new Error('admitted builder package manifest does not match the job');
    heldPublisher = await holdInstalledPublisher(publisherPath);
    const publisherAuthority = validateInstalledPublisherAuthority(
      lock,
      builderIdentity.packageVersion,
      heldPublisher.bytes,
      await readHeldPublisherVersion(heldPublisher.executable),
    );
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
    const dependencyEgressCredentialDirectory = join(
      stateRootIdentity.path,
      'jobs',
      args.jobId,
      'recovery',
      'dependency-egress',
    );
    const dependencyEgressCredentialChain = await openDirectoryChain(
      stateRootHandle,
      ['jobs', args.jobId, 'recovery', 'dependency-egress'],
      true,
    );
    try {
      const metadata = await dependencyEgressCredentialChain.directory.stat();
      const uid = typeof process.getuid === 'function' ? process.getuid() : metadata.uid;
      if (!metadata.isDirectory() || metadata.uid !== uid || (metadata.mode & 0o777) !== 0o700) {
        throw new Error('dependency egress credential directory authority is unsafe');
      }
    } finally {
      await closeHandles(dependencyEgressCredentialChain.handles);
    }
    approvedRootHandle = await open(approvedRoot.path, DIRECTORY_FLAGS);
    coordinator = createRunnerLogCoordinator({
      db: database,
      jobRoot: join(stateRootIdentity.path, 'jobs', args.jobId),
      jobId: args.jobId,
      clock: { now: () => new Date().toISOString() },
    });
    const preflightDefaults = createReadOnlyPreflightDefaults();
    const preflight = Object.freeze({
      ...preflightDefaults,
      lock: Object.freeze({
        read: async () => (await installedLockReader.read(packageDirectory)).text,
      }),
    });
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
    let cancellation: PipelineCancellation | null = null;
    const monotonicClock = (): number => performance.now();
    const requireWorkspace = (): FileHandle => {
      if (workspaceHandle === null) throw new Error('held source workspace is unavailable');
      return workspaceHandle;
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
      if (activeTargetSetupEnvironment !== null) {
        await assertActiveTargetLinks(workspaceHandle, activeTargetSetupEnvironment);
        const [heldAfter, namedAfter] = await Promise.all([
          workspaceHandle.stat(),
          lstat(workspacePath),
        ]);
        if (
          !heldAfter.isDirectory()
          || !namedAfter.isDirectory()
          || namedAfter.isSymbolicLink()
          || heldAfter.dev !== workspaceIdentity.device
          || heldAfter.ino !== workspaceIdentity.inode
          || namedAfter.dev !== workspaceIdentity.device
          || namedAfter.ino !== workspaceIdentity.inode
        ) {
          throw new Error('held source workspace chain changed during active-link validation');
        }
      }
    };
    const revalidateRoots = async (): Promise<void> => {
      if (
        packageHandle === null
        || packageIdentity === null
        || stateRootHandle === null
        || stateRootIdentity === null
        || approvedRootHandle === null
      ) {
        throw new Error('held runner root authority is unavailable');
      }
      const [heldPackage, namedPackage, heldState, namedState, heldApproved, namedApproved] = await Promise.all([
        packageHandle.stat(),
        lstat(packageDirectory),
        stateRootHandle.stat(),
        lstat(stateRootIdentity.path),
        approvedRootHandle.stat(),
        lstat(approvedRoot.path),
      ]);
      if (
        !heldPackage.isDirectory()
        || !namedPackage.isDirectory()
        || namedPackage.isSymbolicLink()
        || heldPackage.dev !== packageIdentity.device
        || heldPackage.ino !== packageIdentity.inode
        || namedPackage.dev !== packageIdentity.device
        || namedPackage.ino !== packageIdentity.inode
        || (heldPackage.mode & 0o777) !== 0o555
        || !heldState.isDirectory()
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
      const [currentLock, currentManifest, currentExecutionDefinition, currentRunner, currentCleanupWorker, currentDependencyEgressProxy] = await Promise.all([
        readInstalledLock(),
        readStableFile(manifestPath),
        readStableFile(executionDefinitionPath),
        readStableFile(runnerPath),
        readStableFile(cleanupWorkerPath),
        createInstalledDependencyEgressProxyReader({ ownerUid })
          .read(packageDirectory, builderIdentity.dependencyEgressProxySha256),
      ]);
      validateAdmittedBuilderPackage({
        identity: builderIdentity,
        lockBytes: currentLock,
        executionDefinition: currentExecutionDefinition,
        runner: currentRunner,
        cleanupWorker: currentCleanupWorker,
        dependencyEgressProxy: currentDependencyEgressProxy.bytes,
        manifestSha256: sha256(currentManifest),
      });
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
        if (workspacePath === null) {
          throw new Error('canonical source workspace path is unavailable');
        }
        if (workspaceIdentity === null) {
          throw new Error('held source workspace identity is unavailable');
        }
        const heldWorkspaceIdentity = workspaceIdentity;
        const stdout = createByteBoundedTextCapture(MAX_OPERATION_CAPTURE_BYTES);
        const stderr = createByteBoundedTextCapture(MAX_OPERATION_CAPTURE_BYTES);
        const stageTimeout = manifest.manifest.stageDefinitions[context.stage]
          .timeoutSeconds * 1000;
        const executor = createDockerExecutor({
          dockerPath: TRUSTED_PREFLIGHT_EXECUTABLES.docker,
          imageReference: canonicalBuilderImageReference(lock),
          imageId: builderIdentity.imageId,
          imageDigest: lock.imageDigest,
          jobId: context.job.jobId,
          manifestSha256: manifest.sha256,
          attempt,
          worktreePath: workspacePath,
          dependencyEgressCredentialDirectory,
          workspaceIdentity: heldWorkspaceIdentity,
          activeTargetEnvironment: operationId === 'activate-target'
            ? null
            : activeTargetSetupEnvironment,
          revalidateWorktreeBeforeCreate: revalidateWorkspace,
          revalidateWorktreeBeforeStart: revalidateWorkspace,
          uid: typeof process.getuid === 'function' ? process.getuid() : 1000,
          gid: typeof process.getgid === 'function' ? process.getgid() : 1000,
          operationId,
          operationContext: { environment: operation.environment },
          operationTimeoutMs: stageTimeout,
          maxCaptureBytes: MAX_OPERATION_CAPTURE_BYTES,
          containerName: createDockerContainerName(
            context.job.jobId,
            operationId,
            attempt,
          ),
          store,
          ownership,
          cancellationBudget: () => cancellation?.cancellationBudget?.() ?? {
            requested: false,
            deadline: null,
            remainingMs: null,
          },
          authorizeContainerCreate: async (input) => {
            if (cancellation?.authorizeContainerCreate === undefined) {
              throw new Error('runner pre-container authorization is unavailable');
            }
            return cancellation.authorizeContainerCreate(input);
          },
          authorizeCancellation: async () => {
            if (cancellation?.authorizeActiveOperationStop === undefined) {
              throw new Error('runner cancellation authorization is unavailable');
            }
            return cancellation.authorizeActiveOperationStop();
          },
          persistCancellationBlocker: async (reason) => {
            if (cancellation?.blockRecoveryRequired === undefined) {
              throw new Error('runner cancellation blocker persistence is unavailable');
            }
            try {
              await cancellation.blockRecoveryRequired(
                'DOCKER_CONTAINER_ORPHANED',
                reason,
              );
            } catch (error) {
              if (
                error instanceof CancellationBlockedError
                && error.blockerCode === 'DOCKER_CONTAINER_ORPHANED'
              ) {
                return;
              }
              throw error;
            }
          },
          monotonicNow: monotonicClock,
          leaseSnapshot: () => ({
            owner: context.lease.owner,
            unit: context.lease.runnerUnit,
            leaseExpiresAt: context.lease.expiresAt,
            expectedState: store.getJob(context.job.jobId).state,
          }),
          evidence: (value) => writeOperationEvidence(
            loaded.pathAuthorities.stateRoot,
            context.job.jobId,
            operationId,
            attempt,
            value,
          ),
          finalizeLogs: async ({ operationFinishedAt }): Promise<LogCleanupProof> => {
            if (coordinator === null) throw new Error('runner log coordinator is unavailable');
            return coordinator.finalize(operationFinishedAt);
          },
          onStdoutBytes: (chunk) => {
            if (coordinator === null) throw new Error('runner log coordinator is unavailable');
            coordinator.appendDockerBytes(chunk);
            stdout.append(chunk);
          },
          onStderrBytes: (chunk) => {
            if (coordinator === null) throw new Error('runner log coordinator is unavailable');
            coordinator.appendDockerBytes(chunk);
            stderr.append(chunk);
          },
        });
        let executorError: unknown;
        try {
          await revalidateWorkspace();
          const result = await executor.run();
          if (!result.available) throw new Error('locked Docker runtime is unavailable');
        } catch (error) {
          executorError = error;
        } finally {
          try {
            await revalidateWorkspace();
          } catch (error) {
            executorError = executorError === undefined
              ? error
              : new AggregateError([executorError, error], 'Docker worktree identity validation failed');
          }
        }
        if (executorError instanceof DockerCancellationRequestedError) {
          throw executorError;
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
          stdout.toString(),
          stderr.toString(),
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
          if (classified.disposition !== 'passed' || execution.outcome !== 'passed') {
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
          async ({
            operationId,
            definition,
            cwd,
            workspaceIdentity: operationWorkspaceIdentity,
          }) => {
            if (heldOperationWorkspacePath !== null) {
              throw new Error('target setup attempted concurrent operations');
            }
            assertTargetSetupWorkspaceIdentity(
              workspaceIdentity,
              operationWorkspaceIdentity,
            );
            if (phase === 'config' && operationId === 'resolve-config') {
              activeTargetSetupEnvironment = resolveTargetSetupConfigEnvironment({
                definition,
                activeTargetSetupEnvironment,
                manifestEnvironments: manifest.manifest.targets.map(
                  (candidate) => candidate.environment,
                ),
              });
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
    const publisher = createRunnerPublisherClient({
      executable: heldPublisher.executable,
      approvedRoots: loaded.config.approvedOutputRoots,
      expectedVersion: publisherAuthority.packageVersion,
      expectedSourceSha256: publisherAuthority.publisherSourceSha256,
    });
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
            preflight.lock.read(),
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
      publisherAuthority,
      publisher,
    };

    const cancellationControls = createDockerCancellationControls({
      dockerPath: TRUSTED_PREFLIGHT_EXECUTABLES.docker,
      expectedImageDigest: lock.imageDigest,
      maxCaptureBytes: MAX_OPERATION_CAPTURE_BYTES,
    });
    const runnerCancellation = createRunnerCancellation({
      jobId: args.jobId,
      runnerUnit: args.runnerUnit,
      owner: args.owner,
      leaseExpiresAt: () => store.getJob(args.jobId).runnerLeaseExpiresAt ?? args.leaseExpiresAt,
      store,
      ownership,
      docker: cancellationControls,
      evidence: (value) => writeRunnerCancellationEvidence(
        loaded.pathAuthorities.stateRoot,
        args.jobId,
        value,
      ),
      recoverEvidence: () => recoverRunnerCancellationEvidence(
        loaded.pathAuthorities.stateRoot,
        args.jobId,
      ),
      cleanup: {
        staging: async () => quarantineCancellationStaging(
          loaded,
          store.getJob(args.jobId),
          publisher,
        ),
        logs: async () => {
          const verifiedAt = new Date().toISOString();
          if (coordinator === null) throw new Error('runner log coordinator is unavailable');
          const coordinatorProof = coordinator.sealForCancellation(verifiedAt);
          return ownership.cancellationLogProof(args.jobId, coordinatorProof.verifiedAt);
        },
      },
      monotonicNow: monotonicClock,
    });
    cancellation = runnerCancellation;

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
          builderLockPath: lockPath,
          readBuilderLock: readInstalledLock,
          targetManifestPath: manifestPath,
          readTargetManifest: () => readStableFile(manifestPath),
        },
        evidenceWriter: createEvidenceWriter({
          stateRoot: loaded.pathAuthorities.stateRoot,
        }),
        pipelineLogWriter: coordinator.pipelineLogWriter,
        cancellation: runnerCancellation,
        services,
      }),
      close: async () => {
        cancellation?.dispose();
        const errors: unknown[] = [];
        try { coordinator?.close(); } catch (error) { errors.push(error); }
        for (const close of [
          () => workspaceHandle?.close(),
          () => approvedRootHandle?.close(),
          () => stateRootHandle?.close(),
          () => packageHandle?.close(),
          () => heldPublisher?.close(),
        ]) {
          try { await close(); } catch (error) { errors.push(error); }
        }
        if (errors.length > 0) throw new AggregateError(errors, 'runner composition close failed');
      },
    });
  } catch (error) {
    try { coordinator?.close(); } catch { /* preserve composition error */ }
    await approvedRootHandle?.close().catch(() => undefined);
    await stateRootHandle?.close().catch(() => undefined);
    await packageHandle?.close().catch(() => undefined);
    await heldPublisher?.close().catch(() => undefined);
    throw error;
  }
}

export function parseRunnerArguments(argv: readonly string[]): RunnerLaunchArguments {
  if (argv.length !== 1) throw new Error('runner requires exactly one job ID');
  const jobId = argv[0];
  if (!SAFE_JOB.test(jobId)) throw new Error('runner job ID is invalid');
  const runnerUnit = `osi-image-builder-runner@${jobId}.service`;
  return Object.freeze({ jobId, runnerUnit });
}

export interface RunnerProductionDependencies {
  readonly currentExecutablePath?: string;
  readonly resolveAdmittedRunner?: (jobId: string) => Promise<BuilderIdentity | null>;
  readonly validateAdmittedRunner?: (identity: BuilderIdentity) => Promise<void>;
  readonly invokeAdmittedRunner?: (input: Readonly<{
    jobId: string;
    identity: BuilderIdentity;
  }>) => Promise<PipelineResult>;
  readonly loadStateRoot?: typeof loadStateRootAuthority;
  readonly loadRunnerConfig?: typeof loadConfig;
}

async function validateAdmittedRunnerPackage(identity: BuilderIdentity): Promise<void> {
  const [lockBytes, executionDefinition, runner, cleanupWorker, dependencyEgressPolicy] = await Promise.all([
    readFile(join(identity.packageRoot, 'builder.lock.json')),
    readFile(join(identity.packageRoot, 'execution-definition.json')),
    readFile(join(identity.packageRoot, 'bin', 'osi-image-builder-runner')),
    readFile(join(identity.packageRoot, 'bin', 'osi-image-builder-cleanup')),
    loadInstalledDependencyEgressPolicy(identity.packageRoot, identity.dependencyEgressProxySha256),
  ]);
  const manifest = loadManifest(join(identity.packageRoot, 'manifest', 'targets.json'));
  validateAdmittedBuilderPackage({
    identity,
    lockBytes,
    executionDefinition,
    runner,
    cleanupWorker,
    dependencyEgressProxy: dependencyEgressPolicy.bytes,
    manifestSha256: manifest.sha256,
  });
}

async function defaultResolveAdmittedRunner(jobId: string): Promise<BuilderIdentity | null> {
  const state = await loadStateRootAuthority();
  const db = new DatabaseSync(join(state.stateRoot, 'jobs.sqlite'), { readOnly: true });
  try {
    const row = db.prepare(`SELECT builder_identity_status, builder_package_version,
      builder_package_root, builder_lock_sha256, builder_execution_definition_sha256,
      builder_target_manifest_sha256, builder_runner_sha256, builder_cleanup_worker_sha256,
      builder_dependency_egress_proxy_sha256,
      builder_image_reference, builder_image_id, builder_image_digest
      FROM jobs WHERE job_id=?`).get(jobId) as Record<string, unknown> | undefined;
    if (row === undefined || row.builder_identity_status !== 'admitted') return null;
    return parseBuilderIdentity({
      packageVersion: row.builder_package_version,
      packageRoot: row.builder_package_root,
      lockSha256: row.builder_lock_sha256,
      executionDefinitionSha256: row.builder_execution_definition_sha256,
      targetManifestSha256: row.builder_target_manifest_sha256,
      runnerSha256: row.builder_runner_sha256,
      cleanupWorkerSha256: row.builder_cleanup_worker_sha256,
      dependencyEgressProxySha256: row.builder_dependency_egress_proxy_sha256,
      imageReference: row.builder_image_reference,
      imageId: row.builder_image_id,
      imageDigest: row.builder_image_digest,
    });
  } finally {
    db.close();
  }
}

function delegatedRunnerEnvironment(identity: BuilderIdentity): NodeJS.ProcessEnv {
  return Object.freeze({ ...process.env, OSI_ADMITTED_RUNNER_SHA256: identity.runnerSha256 });
}

async function defaultInvokeAdmittedRunner(input: Readonly<{
  jobId: string;
  identity: BuilderIdentity;
}>): Promise<PipelineResult> {
  await validateAdmittedRunnerPackage(input.identity);
  const held = await holdInstalledPublisher(
    join(input.identity.packageRoot, 'bin', 'osi-image-builder-runner'),
  );
  try {
    if (held.sha256 !== input.identity.runnerSha256) {
      throw new Error('admitted runner implementation hash changed');
    }
    await new Promise<void>((resolveExit, rejectExit) => {
      const child = spawn(held.executable, [input.jobId], {
        env: delegatedRunnerEnvironment(input.identity),
        stdio: 'inherit',
      });
      child.once('error', rejectExit);
      child.once('exit', (code, signal) => {
        if (code === 0 && signal === null) resolveExit();
        else rejectExit(new Error('admitted runner implementation failed'));
      });
    });
    return Object.freeze({
      state: 'succeeded',
      buildManifest: {},
      verificationManifest: {},
      blockerCode: null,
    });
  } finally {
    await held.close();
  }
}

function createLocalRunnerArguments(
  launch: RunnerLaunchArguments,
  at: string,
): RunnerArguments {
  const owner = `runner-${randomUUID()}`;
  if (!SAFE_OWNER.test(owner)) throw new Error('runner owner is invalid');
  const acceptedAt = Date.parse(at);
  if (!Number.isFinite(acceptedAt) || new Date(acceptedAt).toISOString() !== at) {
    throw new Error('runner lease start is not canonical');
  }
  const leaseExpiresAt = new Date(acceptedAt + LEASE_DURATION_MS).toISOString();
  return Object.freeze({ ...launch, owner, leaseExpiresAt });
}

export async function runRunner(
  argv: readonly string[],
  options: RunnerProductionDependencies = {},
): Promise<PipelineResult> {
  const launch = parseRunnerArguments(argv);
  const resolveAdmittedRunner = options.resolveAdmittedRunner ?? defaultResolveAdmittedRunner;
  const identity = await resolveAdmittedRunner(launch.jobId);
  if (identity === null) {
    throw new Error('runner job is legacy or has no complete admitted builder identity');
  }
  await (options.validateAdmittedRunner ?? validateAdmittedRunnerPackage)(identity);
  const currentExecutable = resolve(options.currentExecutablePath ?? process.argv[1] ?? process.execPath);
  const currentBytes = await readFile(currentExecutable);
  const currentSha256 = createHash('sha256').update(currentBytes).digest('hex');
  const admittedExecutable = join(identity.packageRoot, 'bin', 'osi-image-builder-runner');
  const delegatedMarker = process.env.OSI_ADMITTED_RUNNER_SHA256;
  const executingAdmittedRunner = currentSha256 === identity.runnerSha256
    && (currentExecutable === admittedExecutable || delegatedMarker === identity.runnerSha256);
  if (!executingAdmittedRunner) {
    return (options.invokeAdmittedRunner ?? defaultInvokeAdmittedRunner)({
      jobId: launch.jobId,
      identity,
    });
  }
  const state = await (options.loadStateRoot ?? loadStateRootAuthority)();
  const loaded = await (options.loadRunnerConfig ?? loadConfig)();
  if (loaded.stateRoot !== state.stateRoot) {
    throw new Error('configured state root differs from guarded runner state');
  }
  const database = openBuilderDatabase(join(state.stateRoot, 'jobs.sqlite'), {
    migrationsDirectory: installedMigrationsDirectory(loaded.config.builderLockPath),
  });
  const store = new BuilderStore(database);
  const ownership = new OwnershipStore(database, { stateRoot: state.stateRoot });
  const clock: PipelineClock = { now: () => new Date().toISOString() };
  try {
    const args = createLocalRunnerArguments(launch, clock.now());
    return await runGuardedComposition({
      args,
      clock,
      store,
      ownership,
      evidenceWriter: createEvidenceWriter({
        stateRoot: state.authority,
      }),
      compose: async () => createProductionComposition(
        args,
        loaded,
        database,
        store,
        ownership,
      ),
    });
  } finally {
    store.close();
  }
}
