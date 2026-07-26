import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';

import type {
  OwnershipResult,
  RunnerWriteCommand,
} from '../../api/src/ownership.js';
import {
  encodeJson,
  normalizeJson,
} from '../../api/src/validation.js';
import type {
  ArtifactInput,
  EventPage,
  JobRecord,
  JsonObject,
  StoredOperation,
  StoredStage,
} from '../../api/src/store.js';
import { canonicalBuilderImageReference } from '../../builder/validate-builder.js';
import { validateBuilderLock, type BuilderLock } from '../../domain/builder-lock.js';
import { encodeBranchSlug } from '../../domain/paths.js';
import {
  PIPELINE_STAGE_NAMES,
  type BuilderErrorCode,
  type BuilderErrorContract,
  type JobState,
  type PipelineStageName,
  type TrustedOperationId,
} from '../../domain/types.js';
import {
  loadManifest,
  type ManifestFileSystem,
} from '../../manifest/validate.js';
import type { LoadedManifest, TargetManifest } from '../../manifest/schema.js';
import type {
  PublisherClient,
  PublisherRequest,
  PublisherResponse,
} from '../../publisher/client.js';
import type {
  EvidenceCommand,
  EvidencePublication,
  StageEvidenceInput,
} from './evidence.js';
import type { OperationDefinition } from './operation-registry.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const SHA40 = /^[0-9a-f]{40}$/u;
const RELEASE_OPERATIONS = Object.freeze([
  'verify-profile-parity',
  'verify-chameleon',
  'verify-db-schema',
  'verify-sync-flow',
  'verify-strega',
  'verify-communication',
  'check-mqtt-topics',
] as const satisfies readonly TrustedOperationId[]);
const FRONTEND_OPERATIONS = Object.freeze([
  'frontend-install',
  'frontend-test',
  'frontend-typecheck',
  'frontend-build',
  'mirror-gui',
] as const satisfies readonly TrustedOperationId[]);
const TARGET_SETUP_OPERATIONS = Object.freeze([
  'activate-target',
  'copy-feed-config',
  'update-feeds',
  'install-feeds',
  'resolve-config',
] as const satisfies readonly TrustedOperationId[]);

const STAGE_STATE: Readonly<Record<PipelineStageName, JobState>> = Object.freeze({
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
});

export interface PipelineClock {
  readonly now: () => string;
}

export interface PipelineLease {
  readonly owner: string;
  readonly runnerUnit: string;
  readonly expiresAt: string;
}

export interface PipelineStore {
  readonly getJob: (jobId: string) => JobRecord;
  readonly getStage: (jobId: string, stage: PipelineStageName) => StoredStage | null;
  readonly getOperation: (
    jobId: string,
    operationId: TrustedOperationId,
    attempt: number,
  ) => StoredOperation | null;
  readonly listEvents: (
    jobId: string,
    options?: { readonly afterSeq?: number; readonly limit?: number },
  ) => EventPage;
}

export interface PipelineOwnership {
  readonly runnerWrite: (command: RunnerWriteCommand) => OwnershipResult;
}

type PipelineRunnerWriteCommand = RunnerWriteCommand extends infer Command
  ? Command extends RunnerWriteCommand
    ? Omit<Command, 'jobId' | 'owner' | 'runnerUnit' | 'leaseExpiresAt' | 'at'>
    : never
  : never;

export interface PipelineEvidenceWriter {
  readonly write: (input: StageEvidenceInput) => Promise<EvidencePublication>;
}

export interface PipelineOperationExecution {
  readonly operationId: TrustedOperationId;
  readonly attempt: number;
  readonly outcome: 'passed' | 'failed';
  readonly command: EvidenceCommand;
  readonly observations: Readonly<Record<string, unknown>>;
  readonly error?: BuilderErrorContract;
}

export interface StageActionContext {
  readonly job: JobRecord;
  readonly target: TargetManifest;
  readonly stage: PipelineStageName;
  readonly lease: PipelineLease;
  readonly runOperation: (
    operationId: TrustedOperationId,
    requestedDefinition?: OperationDefinition,
  ) => Promise<PipelineOperationExecution>;
  readonly runTargetSetupOperation: (
    operationId: 'activate-target' | 'copy-feed-config' | 'update-feeds' | 'install-feeds' | 'resolve-config',
    requestedDefinition: OperationDefinition,
  ) => Promise<PipelineOperationExecution>;
}

export interface SourceStageResult {
  readonly commands: readonly EvidenceCommand[];
  readonly observations: Readonly<Record<string, unknown>>;
}

export interface TargetSetupStageResult {
  readonly executions: readonly PipelineOperationExecution[];
  readonly observations: Readonly<Record<string, unknown>>;
}

export interface VerifiedPipelineArtifact {
  readonly artifact: {
    readonly path: string;
    readonly basename: string;
    readonly size: number;
    readonly mtime: string;
    readonly sha256: string;
    readonly gzip: true;
  };
  readonly config: Readonly<Record<string, unknown>>;
  readonly verification: Readonly<Record<string, unknown>>;
}

export interface PreparedPublication {
  readonly artifact: ArtifactInput;
  readonly buildManifestBytes: string;
  readonly verificationManifestBytes: string;
  readonly checksumBytes: string;
}

export interface PublicationFilesPrepareInput {
  readonly job: JobRecord;
  readonly target: TargetManifest;
  readonly root: ApprovedRootBinding;
  readonly artifact: VerifiedPipelineArtifact['artifact'];
  readonly buildManifest: JsonObject;
  readonly buildManifestBytes: string;
  readonly verificationManifest: JsonObject;
  readonly verificationManifestBytes: string;
  readonly checksumBytes: string;
}

export interface FinalPublicationProof {
  readonly verified: true;
  readonly finalPath: string;
  readonly artifactSha256: string;
  readonly artifactSize: number;
  readonly checksumPath: string;
  readonly checksumSha256: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly verificationPath: string;
  readonly verificationSha256: string;
  readonly staging: 'absent';
}

export interface PublicationBinding {
  readonly jobId: string;
  readonly rootId: string;
  readonly rootPath: string;
  readonly rootDevice: number;
  readonly rootInode: number;
  readonly branch: string;
  readonly branchSlug: string;
  readonly pinnedSha: string;
  readonly targetId: TargetManifest['id'];
  readonly stagingDirectory: string;
  readonly stagingPath: string;
  readonly finalDirectory: string;
  readonly finalPath: string;
  readonly artifactSha256: string;
  readonly artifactSize: number;
}

export interface ApprovedRootBinding {
  readonly id: string;
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

export interface PipelineServices {
  readonly workspace: {
    readonly revalidate: (input: Readonly<{
      job: JobRecord;
      stage: PipelineStageName;
      phase: 'before' | 'after';
    }>) => Promise<void>;
  };
  readonly preflight: {
    readonly recheck: (input: Readonly<{
      job: JobRecord;
      target: TargetManifest;
      root: ApprovedRootBinding;
      lock: BuilderLock;
    }>) => Promise<Readonly<Record<string, unknown>>>;
  };
  readonly source: {
    readonly setup: (input: Readonly<{
      job: JobRecord;
      target: TargetManifest;
    }>) => Promise<SourceStageResult>;
  };
  readonly operations: {
    readonly run: (
      context: StageActionContext,
      operationId: TrustedOperationId,
      requestedDefinition?: OperationDefinition,
    ) => Promise<PipelineOperationExecution>;
  };
  readonly targetSetup: {
    readonly setup: (context: StageActionContext) => Promise<TargetSetupStageResult>;
    readonly feeds: (context: StageActionContext) => Promise<TargetSetupStageResult>;
    readonly config: (context: StageActionContext) => Promise<TargetSetupStageResult>;
  };
  readonly verification: {
    readonly verify: (input: Readonly<{
      job: JobRecord;
      target: TargetManifest;
      targetSetup: Readonly<Record<string, unknown>>;
    }>) => Promise<VerifiedPipelineArtifact>;
  };
  readonly publicationFiles: {
    readonly prepare: (
      input: PublicationFilesPrepareInput,
    ) => Promise<PreparedPublication>;
    readonly reopenStaging: (
      input: Readonly<{
        job: JobRecord;
        root: ApprovedRootBinding;
        artifact: ArtifactInput;
      }>,
    ) => Promise<PreparedPublication>;
    readonly verifyFinal: (
      input: Readonly<{
        binding: PublicationBinding;
        artifact: ArtifactInput;
      }>,
    ) => Promise<FinalPublicationProof>;
  };
  readonly publisher: PublisherClient;
}

export interface PipelineInput {
  readonly jobId: string;
  readonly runnerUnit: string;
  readonly owner: string;
  readonly leaseDurationMs: number;
  readonly clock: PipelineClock;
  readonly store: PipelineStore;
  readonly ownership: PipelineOwnership;
  readonly manifest: LoadedManifest;
  readonly target: TargetManifest;
  readonly approvedRoot: ApprovedRootBinding;
  readonly authoritativeFiles: {
    readonly builderLockPath: string;
    readonly readBuilderLock: () => Promise<Buffer>;
    readonly targetManifestPath: string;
    readonly readTargetManifest: () => Promise<Buffer>;
  };
  readonly evidenceWriter: PipelineEvidenceWriter;
  readonly services: PipelineServices;
}

export type PipelineResult =
  | Readonly<{
      state: 'succeeded';
      buildManifest: JsonObject;
      verificationManifest: JsonObject;
      blockerCode: null;
    }>
  | Readonly<{
      state: 'failed';
      buildManifest: JsonObject | null;
      verificationManifest: JsonObject | null;
      blockerCode: BuilderErrorCode | null;
    }>
  | Readonly<{
      state: 'recovery-required';
      buildManifest: JsonObject | null;
      verificationManifest: JsonObject | null;
      blockerCode: 'RUNNER_DISAPPEARED';
      reason: string;
    }>;

export interface PublicationBindingInput {
  readonly persisted: PublicationBinding;
  readonly candidate: PublicationBinding;
  readonly request: PublisherRequest;
}

export interface PublishRecoveryInput {
  readonly publisher: Pick<PublisherClient, 'recheck' | 'quarantine'>;
  readonly request: PublisherRequest;
  readonly binding: PublicationBinding;
  readonly response: PublisherResponse | null;
  readonly invocationFailure?: NativeFailureEvidence;
  readonly verifyFinal: () => Promise<FinalPublicationProof>;
}

export interface NativeFailureEvidence {
  readonly phase: 'publish' | 'recheck' | 'quarantine' | 'verify-final';
  readonly message: string;
}

export type PublishRecoveryResult =
  | Readonly<{
      kind: 'complete';
      response: PublisherResponse;
      proof: FinalPublicationProof;
      recovered: boolean;
      nativeFailures?: readonly NativeFailureEvidence[];
    }>
  | Readonly<{
      kind: 'blocked';
      code:
        | 'OUTPUT_COLLISION'
        | 'PUBLISH_RECOVERY_FAILED'
        | 'UNVERIFIED_FINAL_PATH_BLOCKER'
        | 'QUARANTINE_PENDING'
        | 'PUBLISH_FAILED'
        | 'STAGING_FILESYSTEM_MISMATCH';
      staging: 'present' | 'absent' | 'quarantined' | 'unknown';
      response: PublisherResponse | null;
      recheck?: PublisherResponse;
      quarantine?: PublisherResponse;
      nativeFailures?: readonly NativeFailureEvidence[];
    }>;

interface StageResult {
  readonly operationId: TrustedOperationId | null;
  readonly commands: readonly EvidenceCommand[];
  readonly observations: Readonly<Record<string, unknown>>;
}

interface Provenance {
  readonly lock: BuilderLock;
  readonly lockSha256: string;
  readonly manifestSha256: string;
  readonly canonicalImageRef: string;
}

class PipelineOwnershipLostError extends Error {
  readonly conflict: string;

  constructor(conflict: string) {
    super(`runner ownership CAS failed: ${conflict}`);
    this.name = 'PipelineOwnershipLostError';
    this.conflict = conflict;
  }
}

class PipelineExpectedError extends Error {
  readonly contract: BuilderErrorContract;

  constructor(contract: BuilderErrorContract, options?: ErrorOptions) {
    super(contract.diagnosis, options);
    this.name = 'PipelineExpectedError';
    this.contract = contract;
  }
}

class PipelineTerminalFailure extends Error {
  readonly result: Extract<PipelineResult, { state: 'failed' }>;

  constructor(result: Extract<PipelineResult, { state: 'failed' }>) {
    super('pipeline terminated with a recorded failure');
    this.name = 'PipelineTerminalFailure';
    this.result = result;
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactJson(left: unknown, right: unknown): boolean {
  return encodeJson(normalizeJson(left, 'left'), 'left')
    === encodeJson(normalizeJson(right, 'right'), 'right');
}

function canonicalObject(value: unknown, field: string): JsonObject {
  const normalized = normalizeJson(value, field);
  if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new TypeError(`${field} must be a JSON object`);
  }
  return normalized as JsonObject;
}

function operationIdFor(
  executions: readonly PipelineOperationExecution[] = [],
): TrustedOperationId | null {
  return executions.at(-1)?.operationId ?? null;
}

function summaryError(contract: BuilderErrorContract): BuilderErrorContract {
  const { operationId: _operationId, ...summary } = contract;
  return Object.freeze(summary);
}

function commandsFromError(error: unknown): readonly EvidenceCommand[] | null {
  if (error === null || typeof error !== 'object' || !('commands' in error)) {
    return null;
  }
  const commands = (error as { readonly commands?: unknown }).commands;
  if (!Array.isArray(commands)) return null;
  const result = commands as EvidenceCommand[];
  result.forEach(assertCommand);
  return result;
}

function errorContract(
  error: unknown,
  stage: PipelineStageName,
  requestId: string,
  operationId: TrustedOperationId | null,
): BuilderErrorContract {
  const nested = error instanceof PipelineExpectedError
    ? error.contract
    : error && typeof error === 'object' && 'contract' in error
      ? (error as { readonly contract?: unknown }).contract
      : error;
  if (nested && typeof nested === 'object') {
    const candidate = nested as Partial<BuilderErrorContract>;
    if (
      typeof candidate.code === 'string'
      && typeof candidate.diagnosis === 'string'
      && typeof candidate.recovery === 'string'
    ) {
      return Object.freeze({
        code: candidate.code as BuilderErrorCode,
        stage,
        details: candidate.details ?? {},
        retryable: candidate.retryable === true,
        requestId: candidate.requestId ?? requestId,
        diagnosis: candidate.diagnosis,
        recovery: candidate.recovery,
        ...(operationId === null ? {} : {
          operationId: candidate.operationId ?? operationId,
        }),
      });
    }
  }
  const text = error instanceof Error ? error.message : String(error);
  const metadataFailure = /metadata|manifest|checksum|publication preparation|artifact/i
    .test(text);
  return Object.freeze({
    code: metadataFailure ? 'CHECKSUM_FAILED' : 'BUILD_FAILED',
    stage,
    details: { cause: text },
    retryable: false,
    requestId,
    diagnosis: `${stage} failed: ${text}`,
    recovery: 'Inspect the durable stage evidence and submit a new job after correcting the failure.',
    ...(operationId === null ? {} : { operationId }),
  });
}

function validateServiceComposition(input: PipelineInput): void {
  const required: readonly (readonly [unknown, string])[] = [
    [input.store?.getJob, 'store.getJob'],
    [input.ownership?.runnerWrite, 'ownership.runnerWrite'],
    [input.evidenceWriter?.write, 'evidenceWriter.write'],
    [input.authoritativeFiles?.readBuilderLock, 'readBuilderLock'],
    [input.authoritativeFiles?.readTargetManifest, 'readTargetManifest'],
    [input.services?.workspace?.revalidate, 'workspace.revalidate'],
    [input.services?.preflight?.recheck, 'preflight.recheck'],
    [input.services?.source?.setup, 'source.setup'],
    [input.services?.operations?.run, 'operations.run'],
    [input.services?.targetSetup?.setup, 'targetSetup.setup'],
    [input.services?.targetSetup?.feeds, 'targetSetup.feeds'],
    [input.services?.targetSetup?.config, 'targetSetup.config'],
    [input.services?.verification?.verify, 'verification.verify'],
    [input.services?.publicationFiles?.prepare, 'publicationFiles.prepare'],
    [input.services?.publicationFiles?.reopenStaging, 'publicationFiles.reopenStaging'],
    [input.services?.publicationFiles?.verifyFinal, 'publicationFiles.verifyFinal'],
    [input.services?.publisher?.publish, 'publisher.publish'],
    [input.services?.publisher?.recheck, 'publisher.recheck'],
    [input.services?.publisher?.quarantine, 'publisher.quarantine'],
  ];
  const missing = required
    .filter(([value]) => typeof value !== 'function')
    .map(([, name]) => name);
  if (missing.length > 0) {
    throw new TypeError(`production pipeline composition is incomplete: ${missing.join(', ')}`);
  }
  if (
    !Number.isSafeInteger(input.leaseDurationMs)
    || input.leaseDurationMs < 10_000
  ) {
    throw new TypeError('lease duration must be at least ten seconds');
  }
  if (
    JSON.stringify(input.manifest.manifest.stages)
    !== JSON.stringify(PIPELINE_STAGE_NAMES)
  ) {
    throw new TypeError('pipeline manifest stage order is not trusted');
  }
}

function validateRootIdentity(value: ApprovedRootBinding): void {
  if (
    typeof value.id !== 'string'
    || value.id.length === 0
    || !value.path.startsWith('/')
    || !Number.isSafeInteger(value.device)
    || value.device < 0
    || !Number.isSafeInteger(value.inode)
    || value.inode < 0
  ) {
    throw new TypeError('approved root identity is invalid');
  }
}

function persistedRootIdentity(job: JobRecord): {
  readonly device: number;
  readonly inode: number;
} | null {
  const request = job.request;
  if (
    request === null
    || request.outputRootIdentity === null
    || typeof request.outputRootIdentity !== 'object'
    || Array.isArray(request.outputRootIdentity)
  ) {
    return null;
  }
  const identity = request.outputRootIdentity as JsonObject;
  return typeof identity.device === 'number'
    && Number.isSafeInteger(identity.device)
    && typeof identity.inode === 'number'
    && Number.isSafeInteger(identity.inode)
    ? { device: identity.device, inode: identity.inode }
    : null;
}

function validateInitialBinding(input: PipelineInput, job: JobRecord): void {
  validateRootIdentity(input.approvedRoot);
  const target = input.manifest.manifest.targets.find(
    (candidate) => candidate.id === input.target.id,
  );
  const rootIdentity = persistedRootIdentity(job);
  if (
    job.jobId !== input.jobId
    || job.state !== 'starting'
    || job.runnerUnit !== input.runnerUnit
    || job.runnerLeaseOwner !== null
    || job.runnerLeaseExpiresAt !== null
    || !job.sourceRunnable
    || job.sourcePreparation === null
    || job.offlineFeedPreparation === null
    || job.targetId !== input.target.id
    || target === undefined
    || !exactJson(target, input.target)
    || job.targetManifestSha256 !== input.manifest.sha256
    || job.rootId !== input.approvedRoot.id
    || rootIdentity !== null && (
      rootIdentity.device !== input.approvedRoot.device
      || rootIdentity.inode !== input.approvedRoot.inode
    )
    || !SHA40.test(job.pinnedSha)
    || job.expectedSha !== job.pinnedSha
    || job.sourceBranch !== job.branch
    || job.sourceRef !== `refs/remotes/origin/${job.branch}`
  ) {
    throw new Error('persisted job binding does not match the runner composition');
  }
}

function loadHeldManifest(path: string, bytes: Buffer): LoadedManifest {
  const descriptor = 17;
  let cursor = 0;
  let open = false;
  const fileSystem: ManifestFileSystem = {
    open(candidate) {
      if (open || candidate !== path) throw new Error('unexpected manifest open');
      open = true;
      return descriptor;
    },
    stat(fd) {
      if (!open || fd !== descriptor) throw new Error('unexpected manifest stat');
      return { size: bytes.length };
    },
    read(fd, target, offset, length, position) {
      if (!open || fd !== descriptor || position !== null) {
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
      if (!open || fd !== descriptor) throw new Error('unexpected manifest close');
      open = false;
    },
  };
  return loadManifest(path, fileSystem);
}

async function loadProvenance(input: PipelineInput, job: JobRecord): Promise<Provenance> {
  const [lockBytes, manifestBytes] = await Promise.all([
    input.authoritativeFiles.readBuilderLock(),
    input.authoritativeFiles.readTargetManifest(),
  ]);
  if (!Buffer.isBuffer(lockBytes) || !Buffer.isBuffer(manifestBytes)) {
    throw new TypeError('authoritative provenance readers must return held bytes');
  }
  const authoritativeManifest = loadHeldManifest(
    input.authoritativeFiles.targetManifestPath,
    manifestBytes,
  );
  const lockSha256 = sha256(lockBytes);
  const manifestSha256 = authoritativeManifest.sha256;
  const authoritativeTarget = authoritativeManifest.manifest.targets.find(
    (candidate) => candidate.id === job.targetId,
  );
  if (
    manifestSha256 !== input.manifest.sha256
    || manifestSha256 !== job.targetManifestSha256
    || !exactJson(authoritativeManifest.manifest, input.manifest.manifest)
    || authoritativeTarget === undefined
    || !exactJson(authoritativeTarget, input.target)
  ) {
    throw new Error('authoritative target manifest differs from the persisted runner composition');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lockBytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error('builder lock bytes are not JSON', { cause: error });
  }
  const installedVersion = basename(dirname(input.authoritativeFiles.builderLockPath));
  const validated = validateBuilderLock(parsed, installedVersion);
  if (!validated.ok) {
    throw new Error(`builder lock validation failed: ${validated.reason}`);
  }
  return Object.freeze({
    lock: validated.lock,
    lockSha256,
    manifestSha256,
    canonicalImageRef: canonicalBuilderImageReference(validated.lock),
  });
}

function assertOwnership(result: OwnershipResult): void {
  if (!result.ok) throw new PipelineOwnershipLostError(result.conflict.kind);
}

function assertCommand(command: EvidenceCommand): void {
  if (
    !Array.isArray(command.argv)
    || command.argv.length === 0
    || command.finishedAt < command.startedAt
    || typeof command.timedOut !== 'boolean'
    || typeof command.outputLimit !== 'boolean'
  ) {
    throw new TypeError('operation returned incomplete command evidence');
  }
}

function sameArtifact(left: ArtifactInput, right: ArtifactInput): boolean {
  return exactJson(left, right);
}

function validatePreparedPublication(
  prepared: PreparedPublication,
  reopened: PreparedPublication,
  expected: Readonly<{
    artifact: VerifiedPipelineArtifact['artifact'];
    buildManifestBytes: string;
    verificationManifestBytes: string;
    checksumBytes: string;
    jobId: string;
  }>,
): ArtifactInput {
  const artifact = reopened.artifact;
  const expectedDirectory = `staging/${expected.jobId}`;
  const expectedPath = `${expectedDirectory}/${expected.artifact.basename}`;
  const expectedChecksumPath = `${expectedDirectory}/sha256sums`;
  const expectedManifestPath = `${expectedDirectory}/build-manifest.json`;
  const expectedVerificationPath = `${expectedDirectory}/verification.json`;
  if (
    !sameArtifact(prepared.artifact, reopened.artifact)
    || artifact.stagingPath !== expectedPath
    || artifact.artifactSha256 !== expected.artifact.sha256
    || artifact.artifactSize !== expected.artifact.size
    || artifact.artifactMtime !== expected.artifact.mtime
    || artifact.checksumPath !== expectedChecksumPath
    || artifact.manifestPath !== expectedManifestPath
    || artifact.verificationPath !== expectedVerificationPath
    || reopened.buildManifestBytes !== expected.buildManifestBytes
    || reopened.verificationManifestBytes !== expected.verificationManifestBytes
    || reopened.checksumBytes !== expected.checksumBytes
    || artifact.manifestSha256 !== sha256(expected.buildManifestBytes)
    || artifact.verificationSha256 !== sha256(expected.verificationManifestBytes)
    || artifact.checksumSha256 !== sha256(expected.checksumBytes)
  ) {
    throw new Error('reopened publication metadata or artifact identity differs');
  }
  return artifact;
}

function expectedPublisherPaths(binding: PublicationBinding): {
  readonly source: string;
  readonly destination: string;
} {
  return {
    source: `.osi-image-builder/staging/${binding.jobId}`,
    destination: binding.finalDirectory,
  };
}

function validatePublisherPathEvidence(
  response: PublisherResponse,
  binding: PublicationBinding,
  operation: 'publish' | 'quarantine',
): void {
  const expected = expectedPublisherPaths(binding);
  const destination = operation === 'publish'
    ? expected.destination
    : `.osi-image-builder/quarantine/${binding.jobId}`;
  if (
    response.sourceRelativePath !== expected.source
    || response.destinationRelativePath !== destination
    || response.publisherVersion !== '0.1.0'
    || typeof response.publisherSourceSha256 !== 'string'
    || !SHA256.test(response.publisherSourceSha256)
  ) {
    throw new Error('publisher path or executable evidence does not match the publication binding');
  }
}

function validateFinalProof(
  proof: FinalPublicationProof,
  binding: PublicationBinding,
): FinalPublicationProof {
  if (
    proof.verified !== true
    || proof.staging !== 'absent'
    || proof.finalPath !== binding.finalPath
    || proof.artifactSha256 !== binding.artifactSha256
    || proof.artifactSize !== binding.artifactSize
    || proof.checksumPath !== `${binding.finalDirectory}/sha256sums`
    || proof.manifestPath !== `${binding.finalDirectory}/build-manifest.json`
    || proof.verificationPath !== `${binding.finalDirectory}/verification.json`
    || !SHA256.test(proof.checksumSha256)
    || !SHA256.test(proof.manifestSha256)
    || !SHA256.test(proof.verificationSha256)
  ) {
    throw new Error('final publication proof does not match the persisted artifact');
  }
  return proof;
}

function nativeFailure(
  phase: NativeFailureEvidence['phase'],
  error: unknown,
): NativeFailureEvidence {
  const message = error instanceof Error ? error.message : String(error);
  return Object.freeze({
    phase,
    message: message.slice(0, 2_048),
  });
}

async function verifyPublishedDestination(
  input: PublishRecoveryInput,
  response: PublisherResponse,
  recovered: boolean,
  recheck?: PublisherResponse,
  nativeFailures: readonly NativeFailureEvidence[] = [],
): Promise<PublishRecoveryResult> {
  try {
    return {
      kind: 'complete',
      response,
      proof: validateFinalProof(await input.verifyFinal(), input.binding),
      recovered,
      ...(nativeFailures.length === 0 ? {} : { nativeFailures }),
    };
  } catch (error) {
    return {
      kind: 'blocked',
      code: 'UNVERIFIED_FINAL_PATH_BLOCKER',
      staging: 'absent',
      response,
      ...(recheck === undefined ? {} : { recheck }),
      nativeFailures: [...nativeFailures, nativeFailure('verify-final', error)],
    };
  }
}

async function recoverAmbiguousPublishing(
  input: PublishRecoveryInput,
  initial: PublisherResponse | null,
  nativeFailures: readonly NativeFailureEvidence[],
): Promise<PublishRecoveryResult> {
  let recheck: PublisherResponse;
  try {
    recheck = await input.publisher.recheck(input.request);
  } catch (error) {
    return {
      kind: 'blocked',
      code: 'PUBLISH_RECOVERY_FAILED',
      staging: 'unknown',
      response: initial,
      nativeFailures: [...nativeFailures, nativeFailure('recheck', error)],
    };
  }
  if (recheck.destination === 'candidate' && recheck.staging === 'absent') {
    return verifyPublishedDestination(
      input,
      recheck,
      true,
      recheck,
      nativeFailures,
    );
  }
  if (recheck.destination === 'mismatched') {
    return {
      kind: 'blocked',
      code: 'UNVERIFIED_FINAL_PATH_BLOCKER',
      staging: 'unknown',
      response: initial,
      recheck,
      ...(nativeFailures.length === 0 ? {} : { nativeFailures }),
    };
  }
  if (recheck.destination === 'absent' && recheck.staging === 'present') {
    let quarantine: PublisherResponse;
    try {
      quarantine = await input.publisher.quarantine({
        rootId: input.request.rootId,
        jobId: input.request.jobId,
      });
    } catch (error) {
      return {
        kind: 'blocked',
        code: 'QUARANTINE_PENDING',
        staging: 'unknown',
        response: initial,
        recheck,
        nativeFailures: [...nativeFailures, nativeFailure('quarantine', error)],
      };
    }
    if (quarantine.renameResult !== undefined || quarantine.quarantined) {
      validatePublisherPathEvidence(quarantine, input.binding, 'quarantine');
    }
    if (quarantine.quarantined && quarantine.renameResult === 'RENAMED') {
      return {
        kind: 'blocked',
        code: 'PUBLISH_RECOVERY_FAILED',
        staging: 'quarantined',
        response: initial,
        recheck,
        quarantine,
        ...(nativeFailures.length === 0 ? {} : { nativeFailures }),
      };
    }
    return {
      kind: 'blocked',
      code: 'QUARANTINE_PENDING',
      staging: quarantine.renameResult === 'RENAMED' ? 'unknown' : 'present',
      response: initial,
      recheck,
      quarantine,
      ...(nativeFailures.length === 0 ? {} : { nativeFailures }),
    };
  }
  return {
    kind: 'blocked',
    code: 'PUBLISH_RECOVERY_FAILED',
    staging: recheck.staging === 'absent' ? 'absent' : 'unknown',
    response: initial,
    recheck,
    ...(nativeFailures.length === 0 ? {} : { nativeFailures }),
  };
}

export function validatePublicationBinding(
  input: PublicationBindingInput,
): PublicationBinding {
  const expectedRequest: PublisherRequest = {
    rootId: input.persisted.rootId,
    jobId: input.persisted.jobId,
    branchSlug: input.persisted.branchSlug,
    sourceSha: input.persisted.pinnedSha,
    targetId: input.persisted.targetId,
  };
  if (
    !exactJson(input.persisted, input.candidate)
    || !exactJson(expectedRequest, input.request)
    || input.persisted.branchSlug !== encodeBranchSlug(input.persisted.branch)
    || input.persisted.stagingDirectory !== `staging/${input.persisted.jobId}`
    || input.persisted.stagingPath
      !== `${input.persisted.stagingDirectory}/${basename(input.persisted.stagingPath)}`
    || input.persisted.finalDirectory
      !== `${input.persisted.branchSlug}/${input.persisted.pinnedSha}/${input.persisted.targetId}`
    || input.persisted.finalPath
      !== `${input.persisted.finalDirectory}/${basename(input.persisted.stagingPath)}`
    || !SHA40.test(input.persisted.pinnedSha)
    || !SHA256.test(input.persisted.artifactSha256)
  ) {
    throw new Error('publication binding does not match persisted authority');
  }
  return input.persisted;
}

export async function recoverPublishing(
  input: PublishRecoveryInput,
): Promise<PublishRecoveryResult> {
  validatePublicationBinding({
    persisted: input.binding,
    candidate: input.binding,
    request: input.request,
  });
  const initial = input.response;
  if (initial === null) {
    if (input.invocationFailure?.phase !== 'publish') {
      throw new Error('missing publish response requires exact invocation failure evidence');
    }
    return recoverAmbiguousPublishing(input, null, [input.invocationFailure]);
  }
  if (input.invocationFailure !== undefined) {
    throw new Error('publish response and invocation failure evidence are contradictory');
  }
  if (initial.renameResult !== undefined || initial.published) {
    validatePublisherPathEvidence(initial, input.binding, 'publish');
  }
  if (initial.renameResult === 'EEXIST' || initial.errorCode === 'OUTPUT_COLLISION') {
    return {
      kind: 'blocked',
      code: 'OUTPUT_COLLISION',
      staging: 'present',
      response: initial,
    };
  }
  if (initial.published && initial.renameResult === 'RENAMED') {
    return verifyPublishedDestination(input, initial, false);
  }
  if (initial.renameResult !== 'RENAMED') {
    const code = initial.errorCode === 'STAGING_FILESYSTEM_MISMATCH'
      ? 'STAGING_FILESYSTEM_MISMATCH'
      : 'PUBLISH_FAILED';
    return {
      kind: 'blocked',
      code,
      staging: 'present',
      response: initial,
    };
  }
  return recoverAmbiguousPublishing(input, initial, []);
}

export function createPipeline(input: PipelineInput): {
  readonly run: () => Promise<PipelineResult>;
} {
  validateServiceComposition(input);
  const now = input.clock.now;
  let currentState: JobState = 'starting';
  let lease: PipelineLease | null = null;
  let buildManifest: JsonObject | null = null;
  let verificationManifest: JsonObject | null = null;
  let blockerCode: BuilderErrorCode | null = null;
  let targetSetup: TargetSetupStageResult | null = null;
  let verifiedArtifact: VerifiedPipelineArtifact | null = null;
  let preparedArtifact: ArtifactInput | null = null;
  let preparedPublication: PreparedPublication | null = null;
  let publicationBinding: PublicationBinding | null = null;
  let publishStartedAt: string | null = null;
  let provenance: Provenance | null = null;
  let preflightObservations: Readonly<Record<string, unknown>> | null = null;
  const operationExecutions: PipelineOperationExecution[] = [];

  const write = (
    command: PipelineRunnerWriteCommand,
  ): void => {
    if (lease === null) throw new PipelineOwnershipLostError('missing-lease');
    try {
      assertOwnership(input.ownership.runnerWrite({
        ...command,
        jobId: input.jobId,
        owner: lease.owner,
        runnerUnit: lease.runnerUnit,
        leaseExpiresAt: lease.expiresAt,
        at: now(),
      } as RunnerWriteCommand));
    } catch (error) {
      if (error instanceof PipelineOwnershipLostError) throw error;
      throw new PipelineOwnershipLostError('ownership-write-exception');
    }
  };

  const acquireLease = (): void => {
    const at = now();
    const expiresAt = new Date(
      Date.parse(at) + input.leaseDurationMs,
    ).toISOString();
    try {
      assertOwnership(input.ownership.runnerWrite({
        kind: 'acquire-lease',
        jobId: input.jobId,
        runnerUnit: input.runnerUnit,
        owner: input.owner,
        expiresAt,
        at,
      }));
    } catch (error) {
      if (error instanceof PipelineOwnershipLostError) throw error;
      throw new PipelineOwnershipLostError('lease-acquire-exception');
    }
    lease = Object.freeze({
      owner: input.owner,
      runnerUnit: input.runnerUnit,
      expiresAt,
    });
  };

  const renewLease = (): void => {
    if (lease === null) throw new PipelineOwnershipLostError('missing-lease');
    const at = now();
    const nextTimestamp = Math.max(
      Date.parse(at) + input.leaseDurationMs,
      Date.parse(lease.expiresAt) + 1_000,
    );
    const expiresAt = new Date(nextTimestamp).toISOString();
    const expected = lease;
    try {
      assertOwnership(input.ownership.runnerWrite({
        kind: 'renew-lease',
        jobId: input.jobId,
        runnerUnit: expected.runnerUnit,
        owner: expected.owner,
        expectedExpiresAt: expected.expiresAt,
        expiresAt,
        at,
      }));
    } catch (error) {
      if (error instanceof PipelineOwnershipLostError) throw error;
      throw new PipelineOwnershipLostError('lease-renew-exception');
    }
    lease = Object.freeze({
      owner: expected.owner,
      runnerUnit: expected.runnerUnit,
      expiresAt,
    });
  };

  const context = (
    job: JobRecord,
    stage: PipelineStageName,
  ): StageActionContext => {
    if (lease === null) throw new PipelineOwnershipLostError('missing-lease');
    return Object.freeze({
      job,
      target: input.target,
      stage,
      get lease(): PipelineLease {
        if (lease === null) throw new PipelineOwnershipLostError('missing-lease');
        return lease;
      },
      runOperation: (
        operationId: TrustedOperationId,
        requestedDefinition?: OperationDefinition,
      ) => runOperation(
        job,
        stage,
        operationId,
        requestedDefinition,
      ),
      runTargetSetupOperation: (
        operationId: 'activate-target' | 'copy-feed-config' | 'update-feeds' | 'install-feeds' | 'resolve-config',
        requestedDefinition: OperationDefinition,
      ) => {
        if (stage !== 'target-setup' && stage !== 'feeds' && stage !== 'config') {
          throw new TypeError('classifiable target operation is outside target setup stages');
        }
        return runOperationResult(
          job,
          stage,
          operationId,
          requestedDefinition,
        );
      },
    });
  };

  const withLeaseHeartbeat = async <T>(work: () => Promise<T>): Promise<T> => {
    const pending = work();
    const interval = Math.max(1_000, Math.floor(input.leaseDurationMs / 3));
    while (true) {
      let timer: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        pending.then(
          (value) => ({ kind: 'result' as const, value }),
          (error: unknown) => ({ kind: 'error' as const, error }),
        ),
        new Promise<Readonly<{ kind: 'heartbeat' }>>((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'heartbeat' }), interval);
          timer.unref();
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (result.kind === 'result') return result.value;
      if (result.kind === 'error') throw result.error;
      try {
        renewLease();
      } catch (error) {
        await pending.catch(() => undefined);
        throw error;
      }
    }
  };

  const runOperationResult = async (
    job: JobRecord,
    stage: PipelineStageName,
    operationId: TrustedOperationId,
    requestedDefinition?: OperationDefinition,
  ): Promise<PipelineOperationExecution> => {
    renewLease();
    let execution: PipelineOperationExecution;
    try {
      execution = await input.services.operations.run(
        context(job, stage),
        operationId,
        requestedDefinition,
      );
    } catch (error) {
      throw new PipelineExpectedError(errorContract(
        error,
        stage,
        job.requestId,
        operationId,
      ));
    }
    assertCommand(execution.command);
    if (execution.operationId !== operationId) {
      throw new TypeError('operation executor changed the trusted operation ID');
    }
    operationExecutions.push(execution);
    renewLease();
    return execution;
  };

  const runOperation = async (
    job: JobRecord,
    stage: PipelineStageName,
    operationId: TrustedOperationId,
    requestedDefinition?: OperationDefinition,
  ): Promise<PipelineOperationExecution> => {
    const execution = await runOperationResult(
      job,
      stage,
      operationId,
      requestedDefinition,
    );
    if (execution.outcome !== 'passed') {
      const contract = execution.error ?? errorContract(
        new Error(`${operationId} failed`),
        stage,
        job.requestId,
        operationId,
      );
      throw new PipelineExpectedError(contract);
    }
    return execution;
  };

  const runOperations = async (
    job: JobRecord,
    stage: PipelineStageName,
    operations: readonly TrustedOperationId[],
  ): Promise<StageResult> => {
    const executions: PipelineOperationExecution[] = [];
    for (const operationId of operations) {
      executions.push(await runOperation(job, stage, operationId));
    }
    return {
      operationId: operationIdFor(executions),
      commands: executions.map(({ command }) => command),
      observations: {
        operations: executions.map((execution) => ({
          operationId: execution.operationId,
          attempt: execution.attempt,
          outcome: execution.outcome,
          ...execution.observations,
        })),
      },
    };
  };

  const targetStageResult = (
    stage: 'target-setup' | 'feeds' | 'config',
    phase: TargetSetupStageResult,
  ): StageResult => {
    if (phase.executions.length === 0) {
      throw new Error(`${stage} has no trusted operation evidence`);
    }
    return {
      operationId: operationIdFor(phase.executions),
      commands: phase.executions.map(({ command }) => command),
      observations: {
        ...phase.observations,
        operations: phase.executions.map((execution) => ({
          operationId: execution.operationId,
          attempt: execution.attempt,
          outcome: execution.outcome,
          ...execution.observations,
        })),
      },
    };
  };

  const buildMetadata = (
    job: JobRecord,
    artifact: VerifiedPipelineArtifact,
  ): {
    readonly build: JsonObject;
    readonly verification: JsonObject;
    readonly buildBytes: string;
    readonly verificationBytes: string;
    readonly checksumBytes: string;
  } => {
    if (provenance === null) throw new Error('builder provenance is unavailable');
    const preflight = input.store.getStage(job.jobId, 'preflight');
    if (
      preflight === null
      || preflight.outcome !== 'passed'
      || preflight.finishedAt === null
      || preflight.evidencePath === null
      || preflight.evidenceSha256 === null
      || preflightObservations === null
    ) {
      throw new Error('complete preflight tool and timestamp evidence is unavailable');
    }
    const lock = provenance.lock;
    const exactLock = {
      schemaVersion: 1,
      packageVersion: lock.packageVersion,
      imageRepository: lock.imageRepository,
      imageDigest: lock.imageDigest,
      baseImage: lock.baseImage,
      baseImageDigest: lock.baseImageDigest,
      dockerfileSha256: lock.dockerfileSha256,
      packageSet: lock.packageSet,
      rustConfig: lock.rustConfig,
      nodeVersion: lock.nodeVersion,
      executionDefinitionSha256: lock.executionDefinitionSha256,
      validationEvidenceSha256: lock.validationEvidenceSha256,
    };
    const shared = canonicalObject({
      ...exactLock,
      builderLockSha256: provenance.lockSha256,
      canonicalImageRef: provenance.canonicalImageRef,
      targetManifestSha256: provenance.manifestSha256,
      jobId: job.jobId,
      branch: job.branch,
      pinnedSha: job.pinnedSha,
      targetId: job.targetId,
      rootId: job.rootId,
      rootIdentity: {
        device: input.approvedRoot.device,
        inode: input.approvedRoot.inode,
      },
      source: {
        remote: job.sourceRemote,
        ref: job.sourceRef,
        branch: job.branch,
        pinnedSha: job.pinnedSha,
        commitTime: job.sourceCommitTime,
        author: job.sourceAuthor,
        subject: job.sourceSubject,
      },
      config: artifact.config,
      tool: {
        nodeVersion: lock.nodeVersion,
        preflight: {
          startedAt: preflight.startedAt,
          finishedAt: preflight.finishedAt,
          evidencePath: preflight.evidencePath,
          evidenceSha256: preflight.evidenceSha256,
          observations: preflightObservations,
        },
        operations: operationExecutions.map((execution) => ({
          operationId: execution.operationId,
          attempt: execution.attempt,
          argv: execution.command.argv,
          exitCode: execution.command.exitCode,
          startedAt: execution.command.startedAt,
          finishedAt: execution.command.finishedAt,
          observations: execution.observations,
        })),
      },
      artifactSha256: artifact.artifact.sha256,
      artifactSize: artifact.artifact.size,
      artifactMtime: artifact.artifact.mtime,
      artifactBasename: artifact.artifact.basename,
    }, 'build manifest');
    const verification = canonicalObject({
      ...shared,
      verification: artifact.verification,
      observations: {
        stageEvidence: PIPELINE_STAGE_NAMES.map((stage, index) => ({
          stage,
          path: `${String(index).padStart(2, '0')}-${stage}.json`,
          outcome: 'passed',
        })),
      },
    }, 'verification manifest');
    const buildBytes = encodeJson(shared, 'build manifest', true);
    const verificationBytes = encodeJson(
      verification,
      'verification manifest',
      true,
    );
    return {
      build: shared,
      verification,
      buildBytes,
      verificationBytes,
      checksumBytes: `${artifact.artifact.sha256}  ${artifact.artifact.basename}\n`,
    };
  };

  const preparePublication = async (
    job: JobRecord,
    artifact: VerifiedPipelineArtifact,
  ): Promise<StageResult> => {
    const metadata = buildMetadata(job, artifact);
    const prepared = await input.services.publicationFiles.prepare({
      job,
      target: input.target,
      root: input.approvedRoot,
      artifact: artifact.artifact,
      buildManifest: metadata.build,
      buildManifestBytes: metadata.buildBytes,
      verificationManifest: metadata.verification,
      verificationManifestBytes: metadata.verificationBytes,
      checksumBytes: metadata.checksumBytes,
    });
    const reopened = await input.services.publicationFiles.reopenStaging({
      job,
      root: input.approvedRoot,
      artifact: prepared.artifact,
    });
    const artifactInput = validatePreparedPublication(prepared, reopened, {
      artifact: artifact.artifact,
      buildManifestBytes: metadata.buildBytes,
      verificationManifestBytes: metadata.verificationBytes,
      checksumBytes: metadata.checksumBytes,
      jobId: job.jobId,
    });
    preparedPublication = reopened;
    preparedArtifact = artifactInput;
    buildManifest = metadata.build;
    verificationManifest = metadata.verification;
    write({
      kind: 'artifact',
      expectedState: 'verifying',
      state: 'verifying',
      ...artifactInput,
    });
    return {
      operationId: 'verify-image',
      commands: operationExecutions
        .filter(({ operationId }) => operationId === 'verify-image')
        .slice(-1)
        .map(({ command }) => command),
      observations: {
        artifact: {
          path: artifactInput.stagingPath,
          sha256: artifactInput.artifactSha256,
          size: artifactInput.artifactSize,
          mtime: artifactInput.artifactMtime,
        },
        metadata: {
          checksumPath: artifactInput.checksumPath,
          checksumSha256: artifactInput.checksumSha256,
          manifestPath: artifactInput.manifestPath,
          manifestSha256: artifactInput.manifestSha256,
          verificationPath: artifactInput.verificationPath,
          verificationSha256: artifactInput.verificationSha256,
        },
      },
    };
  };

  const createBinding = (job: JobRecord): PublicationBinding => {
    if (preparedArtifact === null) {
      throw new Error('verified artifact metadata is incomplete');
    }
    const branchSlug = encodeBranchSlug(job.branch);
    const finalDirectory = `${branchSlug}/${job.pinnedSha}/${job.targetId}`;
    const artifactBasename = basename(preparedArtifact.stagingPath);
    const binding: PublicationBinding = Object.freeze({
      jobId: job.jobId,
      rootId: job.rootId,
      rootPath: input.approvedRoot.path,
      rootDevice: input.approvedRoot.device,
      rootInode: input.approvedRoot.inode,
      branch: job.branch,
      branchSlug,
      pinnedSha: job.pinnedSha,
      targetId: job.targetId,
      stagingDirectory: `staging/${job.jobId}`,
      stagingPath: preparedArtifact.stagingPath,
      finalDirectory,
      finalPath: `${finalDirectory}/${artifactBasename}`,
      artifactSha256: preparedArtifact.artifactSha256,
      artifactSize: preparedArtifact.artifactSize,
    });
    const persisted = input.store.getJob(job.jobId);
    const persistedBinding: PublicationBinding = {
      ...binding,
      jobId: persisted.jobId,
      rootId: persisted.rootId,
      branch: persisted.branch,
      pinnedSha: persisted.pinnedSha,
      targetId: persisted.targetId,
      stagingPath: persisted.artifactStagingPath ?? '',
      artifactSha256: persisted.artifactSha256 ?? '',
      artifactSize: persisted.artifactSize ?? -1,
    };
    return validatePublicationBinding({
      persisted: persistedBinding,
      candidate: binding,
      request: {
        rootId: binding.rootId,
        jobId: binding.jobId,
        branchSlug: binding.branchSlug,
        sourceSha: binding.pinnedSha,
        targetId: binding.targetId,
      },
    });
  };

  const publish = async (job: JobRecord): Promise<StageResult> => {
    if (preparedArtifact === null || preparedPublication === null) {
      throw new Error('publication files are incomplete');
    }
    if (publicationBinding === null || publishStartedAt === null) {
      throw new Error('publication ownership transaction is incomplete');
    }
    const binding = publicationBinding;
    const request: PublisherRequest = Object.freeze({
      rootId: binding.rootId,
      jobId: binding.jobId,
      branchSlug: binding.branchSlug,
      sourceSha: binding.pinnedSha,
      targetId: binding.targetId,
    });
    renewLease();
    let response: PublisherResponse | null = null;
    let invocationFailure: NativeFailureEvidence | undefined;
    try {
      response = await input.services.publisher.publish(request);
    } catch (error) {
      invocationFailure = nativeFailure('publish', error);
    }
    renewLease();
    const outcome = await recoverPublishing({
      publisher: input.services.publisher,
      request,
      binding,
      response,
      ...(invocationFailure === undefined ? {} : { invocationFailure }),
      verifyFinal: () => input.services.publicationFiles.verifyFinal({
        binding,
        artifact: preparedArtifact!,
      }),
    });
    if (outcome.kind === 'blocked') {
      blockerCode = outcome.code;
      const blocker = canonicalObject({
        code: outcome.code,
        diagnosis: 'Native publication did not produce a verified final destination.',
        binding,
        response: outcome.response,
        recheck: outcome.recheck ?? null,
        quarantine: outcome.quarantine ?? null,
        nativeFailures: outcome.nativeFailures ?? [],
        staging: outcome.staging,
      }, 'publish blocker');
      write({
        kind: 'publish',
        expectedState: 'publishing',
        state: 'blocked',
        blockerCode: outcome.code,
        blocker,
      });
      throw new PipelineExpectedError(errorContract(
        {
          code: outcome.code,
          diagnosis: `publication blocked: ${outcome.code}`,
          recovery: outcome.code === 'UNVERIFIED_FINAL_PATH_BLOCKER'
            ? 'Do not touch the final path; perform the non-destructive blocker recheck after operator correction.'
            : 'Inspect native publisher evidence and correct the output filesystem before submitting a new job.',
          details: { staging: outcome.staging },
          retryable: false,
          requestId: job.requestId,
        },
        'publish',
        job.requestId,
        null,
      ));
    }
    const proof = validateFinalProof(outcome.proof, binding);
    return {
      operationId: null,
      commands: [],
      observations: {
        native: outcome.response,
        recovered: outcome.recovered,
        nativeFailures: outcome.nativeFailures ?? [],
        final: proof,
      },
    };
  };

  const stageAction = async (
    stage: PipelineStageName,
    job: JobRecord,
  ): Promise<StageResult> => {
    if (stage === 'preflight') {
      if (provenance === null) throw new Error('preflight provenance is unavailable');
      preflightObservations = await input.services.preflight.recheck({
        job,
        target: input.target,
        root: input.approvedRoot,
        lock: provenance.lock,
      });
      return {
        operationId: null,
        commands: [],
        observations: preflightObservations,
      };
    }
    if (stage === 'source') {
      const result = await input.services.source.setup({ job, target: input.target });
      result.commands.forEach(assertCommand);
      return {
        operationId: null,
        commands: result.commands,
        observations: result.observations,
      };
    }
    if (stage === 'release-gates') {
      return runOperations(job, stage, RELEASE_OPERATIONS);
    }
    if (stage === 'frontend') {
      return runOperations(job, stage, FRONTEND_OPERATIONS);
    }
    if (stage === 'target-setup') {
      targetSetup = await input.services.targetSetup.setup(context(job, stage));
      return targetStageResult(stage, targetSetup);
    }
    if (stage === 'feeds') {
      const feeds = await input.services.targetSetup.feeds(context(job, stage));
      if (targetSetup === null) throw new Error('target setup evidence is unavailable');
      targetSetup = Object.freeze({
        executions: Object.freeze([...targetSetup.executions, ...feeds.executions]),
        observations: Object.freeze({
          ...targetSetup.observations,
          ...feeds.observations,
        }),
      });
      return targetStageResult(stage, feeds);
    }
    if (stage === 'config') {
      const config = await input.services.targetSetup.config(context(job, stage));
      if (targetSetup === null) throw new Error('target setup evidence is unavailable');
      targetSetup = Object.freeze({
        executions: Object.freeze([...targetSetup.executions, ...config.executions]),
        observations: Object.freeze({
          ...targetSetup.observations,
          ...config.observations,
        }),
      });
      return targetStageResult(stage, config);
    }
    if (stage === 'build') {
      return runOperations(job, stage, ['build-image']);
    }
    if (stage === 'verify') {
      const operation = await runOperation(job, stage, 'verify-image');
      if (targetSetup === null) throw new Error('target setup evidence is unavailable');
      verifiedArtifact = await input.services.verification.verify({
        job,
        target: input.target,
        targetSetup: targetSetup.observations,
      });
      if (
        verifiedArtifact.artifact.basename !== basename(verifiedArtifact.artifact.path)
        || !SHA256.test(verifiedArtifact.artifact.sha256)
        || verifiedArtifact.artifact.size < 0
      ) {
        throw new Error('verification returned missing artifact metadata');
      }
      const result = await preparePublication(job, verifiedArtifact);
      const verificationEvidence = verifiedArtifact.verification.evidence;
      const evidenceJson = verificationEvidence !== null
        && typeof verificationEvidence === 'object'
        && !Array.isArray(verificationEvidence)
        && 'json' in verificationEvidence
        && verificationEvidence.json !== null
        && typeof verificationEvidence.json === 'object'
        && !Array.isArray(verificationEvidence.json)
          ? verificationEvidence.json as Readonly<Record<string, unknown>>
          : null;
      const observations = evidenceJson?.observations;
      const freshness = verifiedArtifact.verification.freshness;
      const freshnessRecord = freshness !== null
        && typeof freshness === 'object'
        && !Array.isArray(freshness)
          ? freshness as Readonly<Record<string, unknown>>
          : {};
      return {
        ...result,
        commands: [operation.command],
        observations: {
          ...result.observations,
          config: verifiedArtifact.config,
          verification: verifiedArtifact.verification,
          rootfs: verifiedArtifact.verification.rootfs,
          freshnessStatus: freshnessRecord.status ?? null,
          newerSourceAvailable: freshnessRecord.newerSourceAvailable ?? false,
          pinnedSha: freshnessRecord.pinnedSha ?? job.pinnedSha,
          observedSha: freshnessRecord.observedSha ?? null,
          freshnessCheckedAt: freshnessRecord.checkedAt ?? null,
          freshnessError: freshnessRecord.error ?? null,
          ...(observations !== null
            && typeof observations === 'object'
            && !Array.isArray(observations)
              ? observations as Readonly<Record<string, unknown>>
              : {}),
        },
      };
    }
    return publish(job);
  };

  const completeFailure = async (
    stage: PipelineStageName,
    startedAt: string,
    error: unknown,
    operationId: TrustedOperationId | null,
    commands: readonly EvidenceCommand[],
    job: JobRecord,
  ): Promise<never> => {
    renewLease();
    const finishedAt = now();
    const contract = errorContract(error, stage, job.requestId, operationId);
    const evidenceError = summaryError(contract);
    const evidence = await withLeaseHeartbeat(() => input.evidenceWriter.write({
      jobId: job.jobId,
      stage,
      startedAt,
      finishedAt,
      outcome: 'failed',
      operationId: null,
      commands,
      inputs: {
        targetId: job.targetId,
        rootId: job.rootId,
        branch: job.branch,
        pinnedSha: job.pinnedSha,
      },
      observations: {
        currentState,
        blockerCode,
      },
      error: evidenceError,
    }));
    renewLease();
    write({
      kind: 'stage',
      expectedState: currentState,
      state: currentState,
      stage,
      outcome: 'failed',
      startedAt,
      finishedAt,
      evidencePath: evidence.path,
      evidenceSha256: evidence.sha256,
      errorCode: contract.code,
      error: canonicalObject(contract, 'stage failure'),
    });
    const terminalAt = now();
    write({
      kind: 'normal-terminal',
      expectedState: currentState,
      state: 'failed',
      terminalAt,
      errorCode: contract.code,
      error: canonicalObject(contract, 'terminal failure'),
    });
    throw new PipelineTerminalFailure({
      state: 'failed',
      buildManifest,
      verificationManifest,
      blockerCode,
    });
  };

  const runStage = async (
    stage: PipelineStageName,
    job: JobRecord,
  ): Promise<void> => {
    renewLease();
    const stageState = STAGE_STATE[stage];
    const startedAt = now();
    let result: StageResult | null = null;
    try {
      if (stage === 'publish') {
        const binding = createBinding(job);
        publicationBinding = binding;
        publishStartedAt = now();
        write({
          kind: 'publish-stage-start',
          expectedState: 'verifying',
          startedAt,
          finalDirectory: binding.finalDirectory,
          finalPath: binding.finalPath,
          publishStartedAt,
        });
      } else {
        write({
          kind: 'stage',
          expectedState: currentState,
          state: stageState,
          stage,
          outcome: 'running',
          startedAt,
        });
      }
      currentState = stageState;
      await withLeaseHeartbeat(() => input.services.workspace.revalidate({
        job,
        stage,
        phase: 'before',
      }));
      const stageResult = await withLeaseHeartbeat(() => stageAction(stage, job));
      result = stageResult;
      await withLeaseHeartbeat(() => input.services.workspace.revalidate({
        job,
        stage,
        phase: 'after',
      }));
      renewLease();
      const finishedAt = now();
      const evidence = await withLeaseHeartbeat(() => input.evidenceWriter.write({
        jobId: job.jobId,
        stage,
        startedAt,
        finishedAt,
        outcome: 'passed',
        operationId: null,
        commands: stageResult.commands,
        inputs: {
          targetId: job.targetId,
          rootId: job.rootId,
          branch: job.branch,
          pinnedSha: job.pinnedSha,
        },
        observations: stageResult.observations,
        error: null,
      }));
      renewLease();
      if (stage === 'publish') {
        if (publicationBinding === null || publishStartedAt === null) {
          throw new Error('publication terminal binding is incomplete');
        }
        const publishedAt = now();
        const terminalAt = now();
        write({
          kind: 'publish-terminal',
          expectedState: 'publishing',
          startedAt,
          finishedAt,
          evidencePath: evidence.path,
          evidenceSha256: evidence.sha256,
          finalDirectory: publicationBinding.finalDirectory,
          finalPath: publicationBinding.finalPath,
          publishStartedAt,
          publishedAt,
          terminalAt,
        });
        return;
      }
      write({
        kind: 'stage',
        expectedState: currentState,
        state: currentState,
        stage,
        outcome: 'passed',
        startedAt,
        finishedAt,
        evidencePath: evidence.path,
        evidenceSha256: evidence.sha256,
      });
      renewLease();
    } catch (error) {
      if (error instanceof PipelineOwnershipLostError) throw error;
      const operationId = error instanceof PipelineExpectedError
        ? error.contract.operationId ?? null
        : result?.operationId
          ?? operationExecutions.filter((execution) => (
            execution.error !== undefined
          )).at(-1)?.operationId
          ?? null;
      const commands = result?.commands
        ?? commandsFromError(error)
        ?? operationExecutions
            .filter((execution) => execution.error?.operationId === operationId)
            .slice(-1)
            .map(({ command }) => command);
      return completeFailure(stage, startedAt, error, operationId, commands, job);
    }
  };

  const run = async (): Promise<PipelineResult> => {
    let job: JobRecord;
    try {
      job = input.store.getJob(input.jobId);
    } catch (error) {
      return {
        state: 'recovery-required',
        buildManifest: null,
        verificationManifest: null,
        blockerCode: 'RUNNER_DISAPPEARED',
        reason: `runner could not establish persisted job ownership: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    try {
      acquireLease();
      try {
        validateInitialBinding(input, job);
        provenance = await withLeaseHeartbeat(() => loadProvenance(input, job));
        renewLease();
      } catch (error) {
        if (error instanceof PipelineOwnershipLostError) throw error;
        const startedAt = now();
        write({
          kind: 'stage',
          expectedState: 'starting',
          state: 'preflight',
          stage: 'preflight',
          outcome: 'running',
          startedAt,
        });
        currentState = 'preflight';
        await completeFailure('preflight', startedAt, error, null, [], job);
      }
      for (const stage of PIPELINE_STAGE_NAMES) {
        await runStage(stage, job);
      }
      if (
        buildManifest === null
        || verificationManifest === null
        || preparedArtifact === null
        || preparedPublication === null
        || verifiedArtifact === null
        || publicationBinding === null
      ) {
        throw new Error('pipeline reached terminal success with incomplete metadata');
      }
      return {
        state: 'succeeded',
        buildManifest,
        verificationManifest,
        blockerCode: null,
      };
    } catch (error) {
      if (error instanceof PipelineTerminalFailure) return error.result;
      if (error instanceof PipelineOwnershipLostError) {
        return {
          state: 'recovery-required',
          buildManifest,
          verificationManifest,
          blockerCode: 'RUNNER_DISAPPEARED',
          reason: error.message,
        };
      }
      throw error;
    }
  };

  return Object.freeze({ run });
}
