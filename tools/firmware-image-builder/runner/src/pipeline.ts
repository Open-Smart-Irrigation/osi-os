import { createHash } from 'node:crypto';

import type { BuilderLock } from '../../domain/builder-lock.js';
import { canonicalBuilderImageReference } from '../../builder/validate-builder.js';
import {
  PIPELINE_STAGE_NAMES,
  type BuilderErrorCode,
  type BuilderErrorContract,
  type JobState,
  type PipelineStageName,
  type TargetId,
  type TrustedOperationId,
} from '../../domain/types.js';
import type { TargetManifest } from '../../manifest/schema.js';
import type {
  ArtifactInput,
  JobRecord,
  JsonObject,
  OperationInput,
} from '../../api/src/store.js';
import type { OwnershipResult, RunnerWriteCommand } from '../../api/src/ownership.js';
import {
  createOperationDefinition,
  hashOperationDefinition,
  type OperationDefinition,
} from './operation-registry.js';
import type { CommandResult } from './command-executor.js';
import type { EvidencePublication, StageEvidenceInput } from './evidence.js';
import type { PublisherClient, PublisherResponse, PublisherRequest } from '../../publisher/client.js';

const STAGE_OPERATIONS: Readonly<Record<PipelineStageName, readonly TrustedOperationId[]>> = Object.freeze({
  preflight: [],
  source: [],
  'release-gates': ['verify-profile-parity', 'verify-chameleon', 'verify-db-schema', 'verify-sync-flow', 'verify-strega', 'verify-communication', 'check-mqtt-topics'],
  frontend: ['frontend-install', 'frontend-test', 'frontend-typecheck', 'frontend-build', 'mirror-gui'],
  'target-setup': ['activate-target'],
  feeds: ['copy-feed-config', 'update-feeds', 'install-feeds'],
  config: ['resolve-config'],
  build: ['build-image'],
  verify: ['verify-image'],
  publish: [],
});

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

const NEXT_STATE: Readonly<Record<PipelineStageName, JobState>> = Object.freeze({
  preflight: 'source',
  source: 'release_gates',
  'release-gates': 'frontend',
  frontend: 'target_setup',
  'target-setup': 'feeds',
  feeds: 'config',
  config: 'building',
  build: 'verifying',
  verify: 'publishing',
  publish: 'publishing',
});

const HASH = /^[0-9a-f]{64}$/u;

export interface PipelineClock {
  readonly now: () => string;
}

export interface PipelineStore {
  readonly getJob: (jobId: string) => JobRecord;
  readonly runnerWrite: (command: RunnerWriteCommand) => OwnershipResult;
}

export interface PipelineOperationExecution {
  readonly result: CommandResult;
  readonly outcome: 'passed' | 'failed';
  readonly lifecyclePhase: 'not_created' | 'created' | 'started' | 'stopped' | 'removed';
  readonly container?: Readonly<{
    readonly id: string;
    readonly name: string;
    readonly imageDigest: string;
    readonly labels: JsonObject;
    readonly mount: JsonObject;
    readonly environment: JsonObject;
    readonly security: JsonObject;
    readonly inspection: JsonObject;
    readonly createdAt?: string | null;
    readonly startedAt?: string | null;
    readonly stoppedAt?: string | null;
    readonly removedAt?: string | null;
    readonly cleanupOutcome?: 'passed' | 'failed' | 'blocking' | null;
  }>;
  readonly errorCode?: BuilderErrorCode | null;
  readonly error?: BuilderErrorContract | null;
  readonly cleanupProof?: OperationCleanupProof;
}

export type OperationCleanupProof =
  | Readonly<{ kind: 'null-identity'; container: Readonly<{ kind: 'absent'; globalLabelResult: 'no-match'; observedAt: string }>; logs: Readonly<{ runner: 'absent' | 'sealed'; docker: 'absent' | 'sealed'; verifiedAt: string }> }>
  | Readonly<{ kind: 'container-removed'; id: string; name: string; imageDigest: string; labels: JsonObject; stoppedAt: string; removedAt: string; observedAt: string; globalLabelResult: 'no-match'; logs: Readonly<{ runner: 'absent' | 'sealed'; docker: 'absent' | 'sealed'; verifiedAt: string }> }>;

export interface TrustedOperationRunner {
  readonly run: (input: {
    readonly operationId: TrustedOperationId;
    readonly definition: OperationDefinition;
    readonly stage: PipelineStageName;
    readonly job: JobRecord;
  }) => Promise<PipelineOperationExecution>;
}

export interface OperationEvidenceWriter {
  readonly write: (input: Readonly<Record<string, unknown>>) => Promise<EvidencePublication>;
}

export interface PipelineEvidenceWriter {
  readonly write: (input: StageEvidenceInput) => Promise<EvidencePublication>;
}

export interface MetadataWriterInput {
  readonly buildManifest: JsonObject;
  readonly verificationManifest: JsonObject;
  readonly checksumContents: string;
}

export interface MetadataWriterResult {
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly verificationPath: string;
  readonly verificationSha256: string;
  readonly checksumPath: string;
  readonly checksumSha256: string;
}

export interface MetadataWriter {
  readonly write: (input: MetadataWriterInput) => Promise<MetadataWriterResult>;
}

export interface ArtifactPreparation {
  readonly artifact: Omit<ArtifactInput, 'checksumPath' | 'checksumSha256' | 'manifestPath' | 'manifestSha256' | 'verificationPath' | 'verificationSha256'>;
  readonly verification: JsonObject;
  readonly checksumContents?: string;
}

export interface PipelineHooks {
  readonly preflight?: (context: PipelineStageContext) => Promise<Readonly<Record<string, unknown>>>;
  readonly source?: (context: PipelineStageContext) => Promise<Readonly<Record<string, unknown>>>;
  readonly targetSetup?: (context: PipelineStageContext) => Promise<Readonly<Record<string, unknown>>>;
  readonly verify?: (context: PipelineStageContext) => Promise<ArtifactPreparation>;
  readonly stageObservations?: (stage: PipelineStageName, context: PipelineStageContext) => Promise<Readonly<Record<string, unknown>>>;
}

export interface PipelineStageContext {
  readonly job: JobRecord;
  readonly target: TargetManifest;
  readonly stage: PipelineStageName;
  readonly runOperation: (operationId: TrustedOperationId) => Promise<PipelineOperationExecution>;
}

export interface PipelineInput {
  readonly jobId: string;
  readonly runnerUnit: string;
  readonly owner: string;
  readonly leaseExpiresAt: string;
  readonly clock: PipelineClock;
  readonly store: PipelineStore;
  readonly manifest: { readonly targets: readonly TargetManifest[]; readonly stages: readonly PipelineStageName[] };
  readonly target: TargetManifest;
  readonly targetManifestSha256: string;
  readonly builderLock: BuilderLock;
  readonly builderLockSha256: string;
  readonly configMetadata: JsonObject;
  readonly toolMetadata: JsonObject;
  readonly operationRunner: TrustedOperationRunner;
  readonly evidenceWriter: PipelineEvidenceWriter;
  readonly operationEvidenceWriter: OperationEvidenceWriter;
  readonly metadataWriter: MetadataWriter;
  readonly publisher: Pick<PublisherClient, 'publish'>;
  readonly publisherRequest: PublisherRequest;
  readonly postRenameVerify: (input: Readonly<{ readonly response: PublisherResponse; readonly artifact: ArtifactInput; readonly metadata: MetadataWriterResult }>) => Promise<Readonly<{ readonly verified: true; readonly finalPath: string }>>;
  readonly hooks?: PipelineHooks;
}

export interface PipelineResult {
  readonly state: 'succeeded' | 'failed';
  readonly buildManifest: JsonObject | null;
  readonly verificationManifest: JsonObject | null;
  readonly blockerCode: BuilderErrorCode | null;
}

export interface PublishRecoveryInput {
  readonly response: PublisherResponse;
  readonly artifact: ArtifactInput;
  readonly metadata: MetadataWriterResult;
  readonly verifyFinal: () => Promise<Readonly<{ readonly verified: true; readonly finalPath: string }>>;
}

export type PublishRecoveryResult =
  | Readonly<{ kind: 'complete'; finalPath: string }>
  | Readonly<{ kind: 'staging-survives'; code: 'PUBLISH_RECOVERY_FAILED' }>
  | Readonly<{ kind: 'mismatched'; code: 'UNVERIFIED_FINAL_PATH_BLOCKER' }>
  | Readonly<{ kind: 'collision'; code: 'OUTPUT_COLLISION' }>;

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertHash(value: string, field: string): void {
  if (!HASH.test(value)) throw new Error(`${field} must be a lowercase SHA-256`);
}

function errorContract(error: unknown, stage: PipelineStageName, requestId: string, operationId?: TrustedOperationId): BuilderErrorContract {
  if (error && typeof error === 'object' && 'code' in error && 'diagnosis' in error && 'recovery' in error) {
    const value = error as Partial<BuilderErrorContract>;
    if (typeof value.code === 'string' && typeof value.diagnosis === 'string' && typeof value.recovery === 'string') {
      return Object.freeze({
        code: value.code as BuilderErrorCode,
        stage,
        details: value.details ?? {},
        retryable: value.retryable === true,
        requestId: value.requestId ?? requestId,
        diagnosis: value.diagnosis,
        recovery: value.recovery,
        ...(operationId === undefined ? {} : { operationId }),
      });
    }
  }
  return Object.freeze({
    code: 'BUILD_FAILED',
    stage,
    details: { cause: error instanceof Error ? error.message : String(error) },
    retryable: false,
    requestId,
    diagnosis: `${stage} failed`,
    recovery: 'Inspect the stage evidence and start a new job after correcting the reported failure.',
    ...(operationId === undefined ? {} : { operationId }),
  });
}

function commandEvidence(result: CommandResult): Readonly<Record<string, unknown>> {
  return {
    argv: result.argv,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
  };
}

function ownership(store: PipelineStore, command: RunnerWriteCommand): void {
  const result = store.runnerWrite(command);
  if (!result.ok) throw new Error(`runner ownership CAS failed: ${result.conflict.kind}`);
}

type PipelineRunnerCommand = RunnerWriteCommand extends infer Command
  ? Command extends RunnerWriteCommand
    ? Omit<Command, 'jobId' | 'owner' | 'runnerUnit' | 'leaseExpiresAt' | 'at'>
    : never
  : never;

function jsonObject(value: unknown): JsonObject {
  return value as JsonObject;
}

function stageIndex(stages: readonly PipelineStageName[], stage: PipelineStageName): number {
  const index = stages.indexOf(stage);
  if (index < 0) throw new Error(`manifest is missing stage ${stage}`);
  return index;
}

function assertManifest(input: PipelineInput): void {
  if (JSON.stringify(input.manifest.stages) !== JSON.stringify(PIPELINE_STAGE_NAMES)) throw new Error('pipeline manifest stage order is not the trusted ten-stage order');
  if (!input.manifest.targets.some((target) => target.id === input.target.id)) throw new Error('selected target is not in the manifest');
  if (input.target.id !== input.publisherRequest.targetId) throw new Error('publisher target does not match the selected target');
  assertHash(input.targetManifestSha256, 'target manifest hash');
  assertHash(input.builderLockSha256, 'builder lock hash');
  canonicalBuilderImageReference(input.builderLock);
}

function manifestMetadata(input: PipelineInput, job: JobRecord, artifact: ArtifactPreparation): { readonly build: JsonObject; readonly verification: JsonObject } {
  const lock = input.builderLock;
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
  const shared = {
    ...exactLock,
    builderLockSha256: input.builderLockSha256,
    imageReference: canonicalBuilderImageReference(lock),
    targetManifestSha256: input.targetManifestSha256,
    jobId: job.jobId,
    source: { branch: job.branch, pinnedSha: job.pinnedSha, sourceRemote: job.sourceRemote, sourceRef: job.sourceRef, sourceCommitTime: job.sourceCommitTime, sourceAuthor: job.sourceAuthor, sourceSubject: job.sourceSubject },
    target: input.target.id,
    outputRootId: job.rootId,
    config: input.configMetadata,
    tool: input.toolMetadata,
    artifact: { path: artifact.artifact.stagingPath, sha256: artifact.artifact.artifactSha256, size: artifact.artifact.artifactSize, mtime: artifact.artifact.artifactMtime },
  } as unknown as JsonObject;
  return {
    build: Object.freeze({ ...shared }),
    verification: Object.freeze({ ...shared, verification: jsonObject(artifact.verification) }),
  };
}

export function createPipeline(input: PipelineInput): { readonly run: () => Promise<PipelineResult> } {
  assertManifest(input);
  const now = input.clock.now;
  const requestId = input.jobId;
  let leaseExpiresAt = input.leaseExpiresAt;
  let currentState: JobState = 'starting';
  let buildManifest: JsonObject | null = null;
  let verificationManifest: JsonObject | null = null;
  let blockerCode: BuilderErrorCode | null = null;
  let preparedArtifact: ArtifactInput | null = null;

  const write = (command: PipelineRunnerCommand): void => ownership(input.store, { ...command, jobId: input.jobId, owner: input.owner, runnerUnit: input.runnerUnit, leaseExpiresAt, at: now() } as RunnerWriteCommand);

  const runOperation = async (job: JobRecord, stage: PipelineStageName, operationId: TrustedOperationId): Promise<PipelineOperationExecution> => {
    const definition = createOperationDefinition(operationId, { environment: input.target.environment });
    const startedAt = now();
    const argvHash = hashOperationDefinition(definition);
    write({ kind: 'operation-begin', expectedState: STAGE_STATE[stage], operationId, attempt: 1, argvHash, argv: definition.argv, startedAt });
    let execution: PipelineOperationExecution;
    try {
      execution = await input.operationRunner.run({ operationId, definition, stage, job });
    } catch (error) {
      execution = {
        result: { argv: definition.argv, exitCode: null, signal: null, stdout: '', stderr: error instanceof Error ? error.message : String(error), timedOut: false, startedAt, finishedAt: now() },
        outcome: 'failed', lifecyclePhase: 'not_created', errorCode: 'BUILD_FAILED', error: errorContract(error, stage, requestId, operationId),
      };
    }
    const evidence = await input.operationEvidenceWriter.write({ schemaVersion: 1, jobId: input.jobId, stage, operationId, definition: { argv: definition.argv, workingDirectory: definition.workingDirectory, sha256: argvHash }, command: commandEvidence(execution.result), outcome: execution.outcome, error: execution.error ?? null });
    const operationInput: OperationInput = {
      operationId, attempt: 1, argvHash, argv: definition.argv, startedAt, finishedAt: execution.result.finishedAt,
      timedOut: execution.result.timedOut, lifecyclePhase: execution.lifecyclePhase, exitCode: execution.result.exitCode, signal: execution.result.signal,
      outcome: execution.outcome, evidencePath: evidence.path, evidenceSha256: evidence.sha256,
      errorCode: execution.errorCode ?? null, error: jsonObject(execution.error) ?? null,
      ...(execution.container === undefined ? {} : {
        containerId: execution.container.id, containerName: execution.container.name, containerImageDigest: execution.container.imageDigest,
        containerLabelJobId: input.jobId, containerLabelManifestSha: input.targetManifestSha256, containerMount: execution.container.mount,
        containerEnvironment: execution.container.environment, containerSecurity: execution.container.security, inspection: execution.container.inspection,
      }),
    };
    write({ kind: 'operation-complete', expectedState: STAGE_STATE[stage], operationId, attempt: 1, input: operationInput });
    if (execution.cleanupProof !== undefined) write({ kind: 'operation-cleanup', expectedState: STAGE_STATE[stage], operationId, attempt: 1, proof: execution.cleanupProof });
    if (execution.outcome !== 'passed') throw execution.error ?? errorContract(new Error(`operation ${operationId} failed`), stage, requestId, operationId);
    return execution;
  };

  const runStage = async (stage: PipelineStageName, job: JobRecord, action: (context: PipelineStageContext) => Promise<Readonly<Record<string, unknown>>>, advanceTo: JobState = NEXT_STATE[stage]): Promise<void> => {
    const stageState = STAGE_STATE[stage];
    const startedAt = now();
    write({ kind: 'stage', expectedState: currentState, state: stageState, stage, outcome: 'running', startedAt });
    currentState = stageState;
    const context: PipelineStageContext = { job, target: input.target, stage, runOperation: (operationId) => runOperation(job, stage, operationId) };
    try {
      const observations = await action(context);
      const finishedAt = now();
      const evidence = await input.evidenceWriter.write({
        jobId: input.jobId, stage, startedAt, finishedAt, outcome: 'passed', operationId: null, commands: [],
        inputs: { target: input.target.id, branch: job.branch, pinnedSha: job.pinnedSha }, observations, error: null,
      });
      write({ kind: 'stage', expectedState: currentState, state: advanceTo, stage, outcome: 'passed', startedAt, finishedAt, evidencePath: evidence.path, evidenceSha256: evidence.sha256 });
      currentState = advanceTo;
    } catch (error) {
      const finishedAt = now();
      const contract = errorContract(error, stage, requestId);
      const evidence = await input.evidenceWriter.write({
        jobId: input.jobId, stage, startedAt, finishedAt, outcome: 'failed', operationId: null, commands: [],
        inputs: { target: input.target.id, branch: job.branch, pinnedSha: job.pinnedSha }, observations: {}, error: contract,
      });
      write({ kind: 'stage', expectedState: currentState, state: currentState, stage, outcome: 'failed', startedAt, finishedAt, evidencePath: evidence.path, evidenceSha256: evidence.sha256, errorCode: contract.code, error: jsonObject(contract) });
      write({ kind: 'normal-terminal', expectedState: currentState, state: 'failed', terminalAt: finishedAt, errorCode: contract.code, error: jsonObject(contract) });
      throw error;
    }
  };

  const defaultAction = async (context: PipelineStageContext): Promise<Readonly<Record<string, unknown>>> => {
    const results: Record<string, unknown> = {};
    for (const operationId of STAGE_OPERATIONS[context.stage]) {
      const execution = await context.runOperation(operationId);
      results[operationId] = commandEvidence(execution.result);
    }
    const custom = input.hooks?.stageObservations === undefined ? {} : await input.hooks.stageObservations(context.stage, context);
    return Object.freeze({ operations: results, ...custom });
  };

  const run = async (): Promise<PipelineResult> => {
    const job = input.store.getJob(input.jobId);
    const leaseAt = now();
    ownership(input.store, { kind: 'acquire-lease', jobId: input.jobId, runnerUnit: input.runnerUnit, owner: input.owner, expiresAt: leaseExpiresAt, at: leaseAt });
    try {
      for (const stage of input.manifest.stages) {
        if (stage === 'publish') {
          if (currentState !== 'verifying') throw new Error('publish stage requires verifying state');
          const publishStartedAt = now();
          const artifactForPublish = preparedArtifact ?? (() => {
            const persisted = input.store.getJob(input.jobId);
            if (persisted.artifactStagingPath === null || persisted.artifactSha256 === null || persisted.artifactSize === null || persisted.artifactMtime === null || persisted.checksumPath === null || persisted.checksumSha256 === null || persisted.manifestPath === null || persisted.manifestSha256 === null || persisted.verificationPath === null || persisted.verificationSha256 === null) throw new Error('verified artifact metadata is incomplete');
            return {
              stagingPath: persisted.artifactStagingPath, artifactSha256: persisted.artifactSha256, artifactSize: persisted.artifactSize, artifactMtime: persisted.artifactMtime,
              checksumPath: persisted.checksumPath, checksumSha256: persisted.checksumSha256, manifestPath: persisted.manifestPath, manifestSha256: persisted.manifestSha256,
              verificationPath: persisted.verificationPath, verificationSha256: persisted.verificationSha256,
            } satisfies ArtifactInput;
          })();
          const artifactName = artifactForPublish.stagingPath.split('/').at(-1) ?? 'artifact.img.gz';
          const finalDirectory = `${input.publisherRequest.branchSlug}/${input.publisherRequest.sourceSha}/${input.publisherRequest.targetId}`;
          const finalPath = `${finalDirectory}/${artifactName}`;
          write({ kind: 'publish', expectedState: 'verifying', state: 'publishing', finalDirectory, finalPath, startedAt: publishStartedAt });
          currentState = 'publishing';
          const publishAction = async (): Promise<Readonly<Record<string, unknown>>> => {
            const response = await input.publisher.publish(input.publisherRequest);
            if (!response.published || response.renameResult !== 'RENAMED') {
              const code = response.errorCode === 'OUTPUT_COLLISION' || response.renameResult === 'EEXIST' ? 'OUTPUT_COLLISION' : (response.errorCode ?? 'PUBLISH_FAILED');
              blockerCode = code as BuilderErrorCode;
              const contract = errorContract(new Error(`publication did not complete: ${code}`), 'publish', requestId);
              write({ kind: 'publish', expectedState: 'publishing', state: 'blocked', blockerCode, blocker: jsonObject(contract) });
              throw contract;
            }
            const verified = await input.postRenameVerify({ response, artifact: artifactForPublish, metadata: {
              manifestPath: artifactForPublish.manifestPath, manifestSha256: artifactForPublish.manifestSha256,
              verificationPath: artifactForPublish.verificationPath, verificationSha256: artifactForPublish.verificationSha256,
              checksumPath: artifactForPublish.checksumPath, checksumSha256: artifactForPublish.checksumSha256,
            } });
            write({ kind: 'publish', expectedState: 'publishing', state: 'published', finalDirectory, finalPath: verified.finalPath, startedAt: publishStartedAt, publishedAt: now() });
            return Object.freeze({ response, finalPath: verified.finalPath, postRenameVerified: true });
          };
          await runStage(stage, job, async (context) => publishAction().then(async (observations) => {
            const custom = input.hooks?.stageObservations === undefined ? {} : await input.hooks.stageObservations('publish', context);
            return Object.freeze({ ...observations, ...custom });
          }));
          const finishedAt = now();
          write({ kind: 'normal-terminal', expectedState: 'publishing', state: 'succeeded', terminalAt: finishedAt });
          return { state: 'succeeded', buildManifest, verificationManifest, blockerCode: null };
        }
        const action = stage === 'preflight' ? (input.hooks?.preflight ?? defaultAction)
          : stage === 'source' ? (input.hooks?.source ?? defaultAction)
            : stage === 'target-setup' ? (input.hooks?.targetSetup ?? defaultAction)
              : stage === 'verify' && input.hooks?.verify !== undefined
                ? async (context: PipelineStageContext) => {
                    const execution = await context.runOperation('verify-image');
                    const prepared = await input.hooks!.verify!(context);
                    const metadata = manifestMetadata(input, job, prepared);
                    const files = await input.metadataWriter.write({ buildManifest: metadata.build, verificationManifest: metadata.verification, checksumContents: prepared.checksumContents ?? `${prepared.artifact.artifactSha256}  ${prepared.artifact.stagingPath.split('/').at(-1)}\n` });
                    const artifact: ArtifactInput = { ...prepared.artifact, ...files };
                    write({ kind: 'artifact', expectedState: 'verifying', state: 'verifying', stagingPath: artifact.stagingPath, artifactSha256: artifact.artifactSha256, artifactSize: artifact.artifactSize, artifactMtime: artifact.artifactMtime, checksumPath: artifact.checksumPath, checksumSha256: artifact.checksumSha256, manifestPath: artifact.manifestPath, manifestSha256: artifact.manifestSha256, verificationPath: artifact.verificationPath, verificationSha256: artifact.verificationSha256 });
                    preparedArtifact = artifact;
                    buildManifest = metadata.build;
                    verificationManifest = metadata.verification;
                    return { artifact, verification: prepared.verification, verifyImage: commandEvidence(execution.result) };
                  }
                : defaultAction;
        await runStage(stage, job, action, stage === 'verify' ? 'verifying' : NEXT_STATE[stage]);
      }
      throw new Error('pipeline exhausted without publish stage');
    } catch (error) {
      if (error instanceof Error && /runner ownership CAS failed/u.test(error.message)) throw error;
      return { state: 'failed', buildManifest, verificationManifest, blockerCode };
    }
  };

  return Object.freeze({ run });
}

export async function recoverPublishing(input: PublishRecoveryInput): Promise<PublishRecoveryResult> {
  if (input.response.renameResult === 'EEXIST' || input.response.errorCode === 'OUTPUT_COLLISION') return { kind: 'collision', code: 'OUTPUT_COLLISION' };
  if (input.response.destination === 'mismatched' || input.response.errorCode === 'UNVERIFIED_FINAL_PATH_BLOCKER') return { kind: 'mismatched', code: 'UNVERIFIED_FINAL_PATH_BLOCKER' };
  if (input.response.destination === 'absent' && input.response.staging === 'present') return { kind: 'staging-survives', code: 'PUBLISH_RECOVERY_FAILED' };
  if (input.response.destination === 'candidate' && input.response.staging === 'absent') {
    const verified = await input.verifyFinal();
    return { kind: 'complete', finalPath: verified.finalPath };
  }
  if (input.response.published && input.response.renameResult === 'RENAMED') {
    const verified = await input.verifyFinal();
    return { kind: 'complete', finalPath: verified.finalPath };
  }
  return { kind: 'staging-survives', code: 'PUBLISH_RECOVERY_FAILED' };
}
