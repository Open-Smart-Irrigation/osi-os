import type {
  CancellationEvidence,
  CancellationLogProof,
  CancellationProof,
  OwnershipResult,
  RunnerWriteCommand,
  StagingCleanupProof,
} from '../../api/src/ownership.js';
import type { EventPage, JobRecord, JsonObject } from '../../api/src/store.js';
import {
  ACTIVE_RECOVERY_STATES,
  type ActiveRecoveryState,
  type JobState,
  type PipelineStageName,
  type TrustedOperationId,
} from '../../domain/types.js';

const JOB_LABEL = 'org.osi.image-builder.job-id';
const MANIFEST_LABEL = 'org.osi.image-builder.manifest-sha';
export const COOPERATIVE_STOP_TIMEOUT_MS = 30_000;

type CancellationJob = Pick<JobRecord,
  'jobId' | 'state' | 'currentStage' | 'cancelRequestedAt' | 'runnerUnit' |
  'runnerLeaseOwner' | 'runnerLeaseExpiresAt' | 'targetManifestSha256' |
  'containerId' | 'containerName' | 'containerImageDigest' |
  'containerLabelJobId' | 'containerLabelManifestSha' | 'containerLabels' |
  'containerMount' | 'containerEnvironment' | 'containerSecurity' | 'containerInspection' |
  'containerCreatedAt' | 'containerStartedAt' | 'containerStoppedAt' | 'artifactStagingPath'>;

export interface CancellationContainer {
  readonly id: string;
  readonly name: string;
  readonly imageDigest: string;
  readonly labels: JsonObject;
  readonly running: boolean;
  readonly status: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly stoppedAt: string | null;
}

/**
 * The runner receives a narrow control surface. It has no force flag and no
 * API/systemd operation, which keeps cancellation cooperative by construction.
 */
export interface CancellationDockerExecutor {
  readonly inspect: (containerId: string, deadline: number) => Promise<CancellationContainer | null>;
  readonly stop: (containerId: string, deadline: number) => Promise<void>;
  readonly waitForStopped: (containerId: string, deadline: number) => Promise<CancellationContainer>;
  readonly remove: (containerId: string, deadline: number) => Promise<void>;
  readonly listByLabels: (labels: JsonObject, deadline: number) => Promise<readonly CancellationContainer[]>;
}

export interface RunnerCancellationSignals {
  readonly on: (signal: 'SIGUSR1', listener: () => void) => void;
  readonly off: (signal: 'SIGUSR1', listener: () => void) => void;
}

export interface RunnerCancellationEvidencePublication {
  readonly path: string;
  readonly sha256: string;
}

export interface RecoveredRunnerCancellationEvidence extends RunnerCancellationEvidencePublication {
  readonly value: JsonObject;
}

export interface RunnerCancellationOptions {
  readonly jobId: string;
  readonly runnerUnit: string;
  readonly owner: string;
  readonly leaseExpiresAt: () => string;
  readonly store: Readonly<{
    getJob: (jobId: string) => CancellationJob;
    listEvents: (jobId: string, options?: { readonly afterSeq?: number; readonly limit?: number }) => EventPage;
  }>;
  readonly ownership: Readonly<{
    runnerWrite: (command: RunnerWriteCommand) => OwnershipResult;
  }>;
  readonly docker: CancellationDockerExecutor;
  readonly evidence: (value: JsonObject) => Promise<RunnerCancellationEvidencePublication>;
  readonly recoverEvidence?: () => Promise<RecoveredRunnerCancellationEvidence | null>;
  readonly cleanup: Readonly<{
    readonly staging: () => Promise<StagingCleanupProof>;
    readonly logs: () => Promise<CancellationLogProof>;
  }>;
  readonly clock?: () => string;
  readonly monotonicNow?: () => number;
  readonly signals?: RunnerCancellationSignals;
}

export type CancellationObservation =
  | Readonly<{ requested: false; handled: false }>
  | Readonly<{ requested: true; handled: true; state: 'cancelled'; evidencePath: string; evidenceSha256: string }>
  | Readonly<{ requested: true; handled: false; ignored: 'publishing' | 'stale' }>;

export interface CancellationBudget {
  readonly requested: boolean;
  readonly deadline: number | null;
  readonly remainingMs: number | null;
}

export type CancellationBlockerCode =
  | 'RUNNER_DISAPPEARED'
  | 'QUARANTINE_PENDING'
  | 'RECOVERY_LOG_GAP'
  | 'DOCKER_CONTAINER_ORPHANED';

export class CancellationBlockedError extends Error {
  readonly code = 'CANCELLATION_BLOCKED';
  readonly blockerCode: CancellationBlockerCode;

  constructor(message: string, blockerCode: CancellationBlockerCode = 'QUARANTINE_PENDING', options?: ErrorOptions) {
    super(message, options);
    this.name = 'CancellationBlockedError';
    this.blockerCode = blockerCode;
  }
}

class CancellationIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CancellationIdentityError';
  }
}

function now(options: RunnerCancellationOptions): string {
  const value = options.clock?.() ?? new Date().toISOString();
  if (typeof value !== 'string' || new Date(value).toISOString() !== value) {
    throw new TypeError('runner cancellation clock must return a canonical instant');
  }
  return value;
}

function monotonicNow(options: RunnerCancellationOptions): number {
  const value = options.monotonicNow?.() ?? performance.now();
  if (!Number.isFinite(value) || value < 0) throw new TypeError('runner cancellation monotonic clock must return a non-negative finite number');
  return value;
}

function exactJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => exactJson(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return JSON.stringify(leftKeys) === JSON.stringify(rightKeys)
    && leftKeys.every((key) => exactJson(leftRecord[key], rightRecord[key]));
}

function labels(job: CancellationJob): JsonObject {
  return {
    [JOB_LABEL]: job.jobId,
    [MANIFEST_LABEL]: job.targetManifestSha256,
  };
}

function assertExactPersistedIdentity(job: CancellationJob, expectedLabels: JsonObject): {
  readonly id: string;
  readonly name: string;
  readonly imageDigest: string;
  readonly labels: JsonObject;
} | null {
  const fields = [
    job.containerId,
    job.containerName,
    job.containerImageDigest,
    job.containerLabelJobId,
    job.containerLabelManifestSha,
    job.containerLabels,
  ];
  const present = fields.some((value) => value !== null);
  if (!present) return null;
  if (fields.some((value) => value === null)) throw new CancellationIdentityError('persisted container identity is incomplete');
  if (job.containerLabelJobId !== job.jobId || job.containerLabelManifestSha !== job.targetManifestSha256) {
    throw new CancellationIdentityError('persisted container labels do not match the job');
  }
  if (!exactJson(job.containerLabels, expectedLabels)) {
    throw new CancellationIdentityError('persisted container labels are not exact');
  }
  return {
    id: job.containerId!,
    name: job.containerName!,
    imageDigest: job.containerImageDigest!,
    labels: expectedLabels,
  };
}

function assertObservedIdentity(
  observed: CancellationContainer,
  expected: Readonly<{ id: string; name: string; imageDigest: string; labels: JsonObject }>,
): void {
  if (
    observed.id !== expected.id
    || observed.name !== expected.name
    || observed.imageDigest !== expected.imageDigest
    || !exactJson(observed.labels, expected.labels)
  ) {
    throw new CancellationIdentityError('Docker container identity or labels do not match persisted identity');
  }
}

function runnerWrite(
  options: RunnerCancellationOptions,
  build: (at: string) => RunnerWriteCommand,
): OwnershipResult {
  const result = options.ownership.runnerWrite(build(now(options)));
  if (result.ok !== true) throw new CancellationBlockedError(`runner cancellation ownership lost: ${result.conflict.kind}`, 'RUNNER_DISAPPEARED');
  return result;
}

function eventSeq(result: OwnershipResult): number {
  if (result.ok !== true || result.kind !== 'committed') {
    throw new CancellationBlockedError('runner cancellation cleanup did not return a committed event sequence', 'RUNNER_DISAPPEARED');
  }
  if (!Number.isSafeInteger(result.eventSeq) || result.eventSeq < 0) {
    throw new CancellationBlockedError('runner cancellation cleanup returned an invalid event sequence', 'RUNNER_DISAPPEARED');
  }
  return result.eventSeq;
}

function persistedCancellationProtocol(
  options: RunnerCancellationOptions,
  job: CancellationJob,
): {
  readonly evidenceEventSeq: number;
  readonly evidence: CancellationEvidence;
  readonly cleanupEventSeq: number | null;
  readonly cleanupProof: CancellationProof | null;
} | null {
  let afterSeq = -1;
  let found: { readonly eventSeq: number; readonly evidence: CancellationEvidence } | null = null;
  let cleanup: { readonly eventSeq: number; readonly evidenceEventSeq: number; readonly proof: CancellationProof } | null = null;
  for (let pageCount = 0; pageCount < 128; pageCount += 1) {
    const page = options.store.listEvents(options.jobId, { afterSeq, limit: 128 });
    for (const event of page.events) {
      if (event.eventType !== 'cleanup') continue;
      if (event.payload.kind === 'cancellation-evidence') {
        const evidence = event.payload.evidence as CancellationEvidence | undefined;
        if (evidence === undefined || evidence.runnerUnit !== options.runnerUnit) {
          throw new CancellationIdentityError('persisted cancellation evidence has the wrong runner identity');
        }
        if (found !== null) throw new CancellationIdentityError('multiple durable cancellation evidence events exist');
        found = { eventSeq: event.seq, evidence };
      } else if (event.payload.kind === 'cancellation-cleanup') {
        const evidenceEventSeq = event.payload.evidenceEventSeq;
        const proof = event.payload.proof as CancellationProof | undefined;
        if (!Number.isSafeInteger(evidenceEventSeq) || proof === undefined || cleanup !== null) {
          throw new CancellationIdentityError('persisted cancellation cleanup event is invalid');
        }
        cleanup = { eventSeq: event.seq, evidenceEventSeq: Number(evidenceEventSeq), proof };
      }
    }
    if (page.nextAfterSeq === null) {
      if (found === null) {
        if (cleanup !== null) throw new CancellationIdentityError('persisted cancellation cleanup has no evidence event');
        return null;
      }
      if (cleanup !== null) {
        if (cleanup.evidenceEventSeq !== found.eventSeq) throw new CancellationIdentityError('persisted cancellation cleanup references the wrong evidence event');
        if (
          job.containerId !== null
          || job.containerName !== null
          || job.containerImageDigest !== null
          || job.containerLabelJobId !== null
          || job.containerLabelManifestSha !== null
          || job.containerLabels !== null
        ) {
          throw new CancellationIdentityError('persisted cancellation cleanup did not clear container identity');
        }
        return {
          evidenceEventSeq: found.eventSeq,
          evidence: found.evidence,
          cleanupEventSeq: cleanup.eventSeq,
          cleanupProof: cleanup.proof,
        };
      }
      return {
        evidenceEventSeq: found.eventSeq,
        evidence: found.evidence,
        cleanupEventSeq: null,
        cleanupProof: null,
      };
    }
    afterSeq = page.nextAfterSeq;
  }
  throw new CancellationBlockedError('cancellation event history exceeds the bounded retry scan', 'RUNNER_DISAPPEARED');
}

function assertPersistedCancellationEvidence(
  job: CancellationJob,
  identity: Readonly<{ id: string; name: string; imageDigest: string; labels: JsonObject }> | null,
  evidence: CancellationEvidence,
): void {
  if (identity === null) {
    if (evidence.kind !== 'pre-container' || evidence.container.kind !== 'absent') {
      throw new CancellationIdentityError('persisted cancellation evidence does not match null container identity');
    }
    return;
  }
  if (
    evidence.kind !== 'container'
    || evidence.container.kind !== 'stopped'
    || evidence.container.id !== identity.id
    || evidence.container.name !== identity.name
    || evidence.container.imageDigest !== identity.imageDigest
    || !exactJson(evidence.container.labels, identity.labels)
    || evidence.container.stoppedAt !== job.containerStoppedAt
  ) {
    throw new CancellationIdentityError('persisted cancellation evidence does not match stopped container identity');
  }
}

function activeState(state: JobState): state is ActiveRecoveryState {
  return (ACTIVE_RECOVERY_STATES as readonly JobState[]).includes(state);
}

function cancellationProof(
  options: RunnerCancellationOptions,
  job: CancellationJob,
  identity: Readonly<{ id: string; name: string; imageDigest: string; labels: JsonObject }> | null,
  stopped: CancellationContainer | null,
  removedAt: string,
  observedAt: string,
  staging: StagingCleanupProof,
  logs: CancellationLogProof,
): CancellationProof {
  const unitInactiveAt = null;
  if (identity === null) {
    return {
      kind: 'pre-container',
      runnerUnit: options.runnerUnit,
      unitInactiveAt,
      container: { kind: 'absent', globalLabelResult: 'no-match', observedAt },
      staging,
      logs,
    };
  }
  if (stopped === null) throw new CancellationBlockedError('container cleanup did not produce stopped inspection', 'DOCKER_CONTAINER_ORPHANED');
  return {
    kind: 'container',
    runnerUnit: options.runnerUnit,
    unitInactiveAt,
    container: {
      kind: 'removed',
      id: identity.id,
      name: identity.name,
      imageDigest: identity.imageDigest,
      labels: identity.labels,
      stoppedAt: stopped.stoppedAt ?? job.containerStoppedAt ?? removedAt,
      removedAt,
      globalLabelResult: 'no-match',
      observedAt,
    },
    staging,
    logs,
  };
}

function cancellationEvidence(
  options: RunnerCancellationOptions,
  job: CancellationJob,
  identity: Readonly<{ id: string; name: string; imageDigest: string; labels: JsonObject }> | null,
  stopped: CancellationContainer | null,
  publication: RunnerCancellationEvidencePublication,
  staging: StagingCleanupProof,
  logs: CancellationLogProof,
  runnerObservedAt = now(options),
): CancellationEvidence {
  if (identity !== null && stopped === null) throw new CancellationBlockedError('cancellation evidence requires a stopped container', 'DOCKER_CONTAINER_ORPHANED');
  return {
    kind: identity === null ? 'pre-container' : 'container',
    runnerUnit: options.runnerUnit,
    runnerObservedAt,
    evidencePath: publication.path,
    evidenceSha256: publication.sha256,
    container: identity === null
      ? { kind: 'absent', globalLabelResult: 'no-match', observedAt: runnerObservedAt }
      : {
          kind: 'stopped',
          id: identity.id,
          name: identity.name,
          imageDigest: identity.imageDigest,
          labels: identity.labels,
          stoppedAt: stopped!.stoppedAt ?? job.containerStoppedAt ?? now(options),
        },
    staging,
    logs,
  };
}

function recoveredCancellationRecord(
  options: RunnerCancellationOptions,
  current: CancellationJob,
  identity: Readonly<{ id: string; name: string; imageDigest: string; labels: JsonObject }> | null,
  recovered: RecoveredRunnerCancellationEvidence,
): {
  readonly publication: RunnerCancellationEvidencePublication;
  readonly staging: StagingCleanupProof;
  readonly logs: CancellationLogProof;
  readonly runnerObservedAt: string;
} {
  const value = recovered.value as Record<string, unknown>;
  const expectedPath = `jobs/${options.jobId}/evidence/cancellation.json`;
  if (
    recovered.path !== expectedPath
    || !/^[0-9a-f]{64}$/u.test(recovered.sha256)
    || value.schemaVersion !== 1
    || value.kind !== 'runner-cancellation'
    || value.jobId !== options.jobId
    || value.state !== 'cancel_requested'
    || value.outcome !== 'controlled'
    || value.stage !== current.currentStage
    || typeof value.runnerObservedAt !== 'string'
    || new Date(value.runnerObservedAt).toISOString() !== value.runnerObservedAt
    || value.staging === null
    || typeof value.staging !== 'object'
    || value.logs === null
    || typeof value.logs !== 'object'
  ) {
    throw new CancellationIdentityError('immutable cancellation evidence is invalid');
  }
  const expectedContainer = identity === null
    ? { kind: 'absent', globalLabelResult: 'no-match' }
    : {
        kind: 'present',
        id: identity.id,
        name: identity.name,
        imageDigest: identity.imageDigest,
        labels: identity.labels,
        stoppedAt: current.containerStoppedAt,
      };
  if (!exactJson(value.container, expectedContainer)) {
    throw new CancellationIdentityError('immutable cancellation evidence container identity changed');
  }
  return {
    publication: { path: recovered.path, sha256: recovered.sha256 },
    staging: value.staging as StagingCleanupProof,
    logs: value.logs as CancellationLogProof,
    runnerObservedAt: value.runnerObservedAt,
  };
}

export function createRunnerCancellation(options: RunnerCancellationOptions): {
  readonly isRequested: () => boolean;
  readonly cancellationBudget: () => CancellationBudget;
  readonly observeBetweenStages: (stage: PipelineStageName) => Promise<CancellationObservation>;
  readonly observeBetweenOperations: (operationId: TrustedOperationId) => Promise<CancellationObservation>;
  readonly cancelIfRequested: () => Promise<CancellationObservation>;
  readonly blockRecoveryRequired: (blockerCode: CancellationBlockerCode, reason: string) => Promise<never>;
  readonly dispose: () => void;
} {
  if (options.store?.getJob === undefined || options.store.listEvents === undefined || options.ownership?.runnerWrite === undefined) throw new TypeError('runner cancellation persistence is required');
  if (options.docker?.inspect === undefined || options.docker.stop === undefined || options.docker.waitForStopped === undefined || options.docker.remove === undefined || options.docker.listByLabels === undefined) throw new TypeError('runner cancellation Docker controls are incomplete');
  if (options.evidence === undefined || options.cleanup?.staging === undefined || options.cleanup.logs === undefined) throw new TypeError('runner cancellation evidence and cleanup are required');
  let signalRequested = false;
  let cancellationDeadline: number | null = null;
  let running: Promise<CancellationObservation> | null = null;
  const observeRequested = (requested: boolean): boolean => {
    if (requested && cancellationDeadline === null) cancellationDeadline = monotonicNow(options) + COOPERATIVE_STOP_TIMEOUT_MS;
    return requested;
  };
  const remainingBudget = (): number => {
    if (cancellationDeadline === null) throw new CancellationBlockedError('cooperative cancellation budget was not started', 'DOCKER_CONTAINER_ORPHANED');
    return Math.max(0, Math.ceil(cancellationDeadline - monotonicNow(options)));
  };
  const absoluteDeadline = (): number => {
    if (cancellationDeadline === null) throw new CancellationBlockedError('cooperative cancellation budget was not started', 'DOCKER_CONTAINER_ORPHANED');
    return cancellationDeadline;
  };
  const onSignal = (): void => {
    signalRequested = true;
    observeRequested(true);
  };
  const signals = options.signals ?? process;
  signals.on('SIGUSR1', onSignal);

  const isRequested = (): boolean => {
    if (signalRequested) return observeRequested(true);
    return observeRequested(options.store.getJob(options.jobId).cancelRequestedAt !== null);
  };
  const cancellationBudget = (): CancellationBudget => {
    const requested = isRequested();
    if (!requested || cancellationDeadline === null) {
      return { requested: false, deadline: null, remainingMs: null };
    }
    return {
      requested: true,
      deadline: cancellationDeadline,
      remainingMs: remainingBudget(),
    };
  };

  const cancelIfRequested = async (): Promise<CancellationObservation> => {
    if (running !== null) return running;
    const work = (async (): Promise<CancellationObservation> => {
      let current = options.store.getJob(options.jobId);
      const requested = observeRequested(current.cancelRequestedAt !== null || signalRequested);
      if (!requested) return { requested: false, handled: false };
      if (current.state === 'publishing') {
        signalRequested = false;
        return { requested: true, handled: false, ignored: 'publishing' };
      }
      if (!activeState(current.state)) {
        signalRequested = false;
        return { requested: true, handled: false, ignored: 'stale' };
      }
      if (current.runnerUnit !== options.runnerUnit || current.runnerLeaseOwner !== options.owner || current.runnerLeaseExpiresAt !== options.leaseExpiresAt()) {
        signalRequested = false;
        throw new CancellationBlockedError('runner cancellation lease identity changed', 'RUNNER_DISAPPEARED');
      }
      if (current.state !== 'cancel_requested') {
        const expectedState = current.state as ActiveRecoveryState;
        try {
          runnerWrite(options, (at) => ({
            kind: 'cancellation-transition',
            jobId: options.jobId,
            owner: options.owner,
            runnerUnit: options.runnerUnit,
            leaseExpiresAt: options.leaseExpiresAt(),
            at,
            expectedState,
          }));
        } catch (error) {
          signalRequested = false;
          throw error;
        }
        current = { ...current, state: 'cancel_requested' };
      }
      const persistBlocker = (error: unknown, phase: string, blockerCode: CancellationBlockerCode): never => {
        if (error instanceof CancellationBlockedError && error.blockerCode === 'RUNNER_DISAPPEARED') {
          signalRequested = false;
          throw error;
        }
        const reason = error instanceof Error ? error.message : String(error);
        try {
          runnerWrite(options, (at) => ({
            kind: 'cancellation-blocker',
            jobId: options.jobId,
            owner: options.owner,
            runnerUnit: options.runnerUnit,
            leaseExpiresAt: options.leaseExpiresAt(),
            at,
            expectedState: 'cancel_requested',
            blockerCode,
            blocker: { reason: `cancellation ${phase} blocked: ${reason}`, cause: reason },
          }));
        } catch (blockerError) {
          signalRequested = false;
          throw new CancellationBlockedError(`cancellation ${phase} failed and blocker persistence failed`, 'RUNNER_DISAPPEARED', { cause: new AggregateError([error, blockerError]) });
        }
        signalRequested = false;
        throw new CancellationBlockedError(`cancellation ${phase} blocked`, blockerCode, { cause: error });
      };
      let blockedPhase = 'durable evidence recovery';
      let blockedCode: CancellationBlockerCode = 'RUNNER_DISAPPEARED';
      try {
        const protocol = persistedCancellationProtocol(options, current);
        if (protocol !== null && protocol.cleanupEventSeq !== null && protocol.cleanupProof !== null) {
          blockedPhase = 'log coverage';
          blockedCode = 'RECOVERY_LOG_GAP';
          const currentLogs = await options.cleanup.logs();
          if (
            currentLogs.runner !== protocol.cleanupProof.logs.runner
            || currentLogs.docker !== protocol.cleanupProof.logs.docker
          ) {
            throw new CancellationBlockedError('persisted log generations changed after cancellation cleanup', 'RECOVERY_LOG_GAP');
          }
          blockedPhase = 'terminal ownership';
          blockedCode = 'RUNNER_DISAPPEARED';
          const terminalAt = now(options);
          const terminalResult = options.ownership.runnerWrite({
            kind: 'cancellation-terminal',
            jobId: options.jobId,
            owner: options.owner,
            runnerUnit: options.runnerUnit,
            leaseExpiresAt: options.leaseExpiresAt(),
            at: terminalAt,
            expectedState: 'cancel_requested',
            terminalAt,
            cleanupEventSeq: protocol.cleanupEventSeq,
          });
          if (terminalResult.ok !== true) {
            const isLogConflict = terminalResult.conflict.kind === 'identity-mismatch'
              && terminalResult.conflict.message.includes('log');
            throw new CancellationBlockedError(
              `runner cancellation ownership lost: ${terminalResult.conflict.kind}`,
              isLogConflict ? 'RECOVERY_LOG_GAP' : 'RUNNER_DISAPPEARED',
            );
          }
          signalRequested = false;
          return {
            requested: true,
            handled: true,
            state: 'cancelled',
            evidencePath: protocol.evidence.evidencePath,
            evidenceSha256: protocol.evidence.evidenceSha256,
          };
        }

        blockedPhase = 'Docker container identity';
        blockedCode = 'DOCKER_CONTAINER_ORPHANED';
        const expectedLabels = labels(current);
        const identity = assertExactPersistedIdentity(current, expectedLabels);
        let stopped: CancellationContainer | null = null;
        let observed: CancellationContainer | null = null;
        if (identity === null) {
          const matching = await options.docker.listByLabels(expectedLabels, absoluteDeadline());
          if (matching.length !== 0) throw new CancellationIdentityError('Docker contains a matching labeled container without persisted identity');
        } else {
          observed = await options.docker.inspect(identity.id, absoluteDeadline());
          if (observed !== null) {
            assertObservedIdentity(observed, identity);
            if (!observed.running) stopped = observed;
          } else if (current.containerStoppedAt !== null) {
            stopped = {
              id: identity.id,
              name: identity.name,
              imageDigest: identity.imageDigest,
              labels: identity.labels,
              running: false,
              status: 'exited',
              createdAt: current.containerCreatedAt!,
              startedAt: current.containerStartedAt,
              stoppedAt: current.containerStoppedAt,
            };
          } else {
            throw new CancellationIdentityError('persisted container disappeared before controlled stop');
          }
        }

        if (protocol !== null) {
          assertPersistedCancellationEvidence(current, identity, protocol.evidence);
          if (observed?.running === true) {
            throw new CancellationIdentityError('Docker container is running after durable stopped evidence');
          }
        }

        blockedPhase = 'Docker container control';
        if (identity !== null) {
          if (protocol === null && observed !== null) {
            if (observed.running) {
              const stopBudget = remainingBudget();
              if (stopBudget < 1) throw new CancellationBlockedError('cooperative cancellation deadline expired before Docker stop', 'DOCKER_CONTAINER_ORPHANED');
              await options.docker.stop(identity.id, absoluteDeadline());
              const waitBudget = remainingBudget();
              if (waitBudget < 1) throw new CancellationBlockedError('cooperative cancellation deadline expired before stopped-state proof', 'DOCKER_CONTAINER_ORPHANED');
              stopped = await options.docker.waitForStopped(identity.id, absoluteDeadline());
              assertObservedIdentity(stopped, identity);
              if (stopped.running) throw new CancellationBlockedError('Docker wait returned a running container', 'DOCKER_CONTAINER_ORPHANED');
              if (stopped.stoppedAt === null && current.containerStoppedAt === null) throw new CancellationBlockedError('Docker wait did not provide a stopped timestamp', 'DOCKER_CONTAINER_ORPHANED');
            } else {
              stopped = observed;
            }
          }
          if (stopped !== null && current.containerStoppedAt === null) {
            const stoppedAt = stopped.stoppedAt;
            if (stoppedAt === null) throw new CancellationBlockedError('Docker stopped proof lacks a stopped timestamp', 'DOCKER_CONTAINER_ORPHANED');
            if (
              current.containerMount === null
              || current.containerEnvironment === null
              || current.containerSecurity === null
              || current.containerInspection === null
              || current.containerCreatedAt === null
            ) {
              throw new CancellationIdentityError('persisted container lifecycle evidence is incomplete');
            }
            const startedAt = current.containerStartedAt ?? stopped.startedAt;
            if (startedAt === null) throw new CancellationIdentityError('Docker stopped proof lacks a started timestamp');
            const stoppedProof = stopped;
            runnerWrite(options, (at) => ({
              kind: 'container',
              jobId: options.jobId,
              owner: options.owner,
              runnerUnit: options.runnerUnit,
              leaseExpiresAt: options.leaseExpiresAt(),
              at,
              lifecycle: 'stopped',
              containerId: identity.id,
              containerName: identity.name,
              imageDigest: identity.imageDigest,
              labels: identity.labels,
              mount: current.containerMount!,
              environment: current.containerEnvironment!,
              security: current.containerSecurity!,
              inspection: {
                ...current.containerInspection!,
                cancellation: {
                  running: false,
                  status: stoppedProof.status,
                  stoppedAt,
                },
              },
              occurredAt: stoppedAt,
              createdAt: current.containerCreatedAt,
              startedAt,
              stoppedAt,
            }));
            current = { ...current, containerStoppedAt: stoppedAt };
          }
        }

        let staging: StagingCleanupProof;
        let logs: CancellationLogProof;
        let evidence: RunnerCancellationEvidencePublication;
        let evidenceEventSeq: number;
        if (protocol === null) {
          blockedPhase = 'immutable evidence recovery';
          blockedCode = 'QUARANTINE_PENDING';
          const recovered = await options.recoverEvidence?.() ?? null;
          let runnerObservedAt: string;
          if (recovered === null) {
            blockedPhase = 'staging quarantine';
            staging = await options.cleanup.staging();
            blockedPhase = 'log coverage';
            blockedCode = 'RECOVERY_LOG_GAP';
            logs = await options.cleanup.logs();
            runnerObservedAt = now(options);
            blockedPhase = 'immutable evidence publication';
            blockedCode = 'QUARANTINE_PENDING';
            evidence = await options.evidence({
              schemaVersion: 1,
              kind: 'runner-cancellation',
              jobId: options.jobId,
              state: 'cancel_requested',
              stage: current.currentStage,
              outcome: 'controlled',
              runnerObservedAt,
              container: identity === null ? { kind: 'absent', globalLabelResult: 'no-match' } : {
                kind: 'present', id: identity.id, name: identity.name, imageDigest: identity.imageDigest, labels: identity.labels,
                stoppedAt: stopped?.stoppedAt ?? current.containerStoppedAt,
              },
              staging,
              logs,
            });
          } else {
            const record = recoveredCancellationRecord(options, current, identity, recovered);
            staging = record.staging;
            logs = record.logs;
            evidence = record.publication;
            runnerObservedAt = record.runnerObservedAt;
          }
          const durableEvidence = cancellationEvidence(options, current, identity, stopped, evidence, staging, logs, runnerObservedAt);
          blockedPhase = 'durable evidence ownership';
          blockedCode = 'RUNNER_DISAPPEARED';
          const evidenceResult = runnerWrite(options, (at) => ({
            kind: 'cancellation-evidence',
            jobId: options.jobId,
            owner: options.owner,
            runnerUnit: options.runnerUnit,
            leaseExpiresAt: options.leaseExpiresAt(),
            at,
            expectedState: 'cancel_requested',
            evidence: durableEvidence,
          }));
          evidenceEventSeq = eventSeq(evidenceResult);
        } else {
          staging = protocol.evidence.staging;
          logs = protocol.evidence.logs;
          evidence = {
            path: protocol.evidence.evidencePath,
            sha256: protocol.evidence.evidenceSha256,
          };
          evidenceEventSeq = protocol.evidenceEventSeq;
        }
        blockedPhase = 'Docker container removal';
        blockedCode = 'DOCKER_CONTAINER_ORPHANED';
        let removedAt = now(options);
        if (identity !== null) {
          const present = await options.docker.inspect(identity.id, absoluteDeadline());
          if (present !== null) {
            assertObservedIdentity(present, identity);
            await options.docker.remove(identity.id, absoluteDeadline());
            removedAt = now(options);
            if (await options.docker.inspect(identity.id, absoluteDeadline()) !== null) throw new CancellationBlockedError('Docker rm did not prove exact container absence', 'DOCKER_CONTAINER_ORPHANED');
          }
        }
        if ((await options.docker.listByLabels(expectedLabels, absoluteDeadline())).length !== 0) throw new CancellationBlockedError('Docker label query did not prove cancellation container absence', 'DOCKER_CONTAINER_ORPHANED');
        const observedAt = now(options);
        const proof = cancellationProof(options, current, identity, stopped, removedAt, observedAt, staging, logs);
        blockedPhase = 'cleanup ownership';
        blockedCode = 'RUNNER_DISAPPEARED';
        const cleanupResult = runnerWrite(options, (at) => ({
          kind: 'cancellation-cleanup',
          jobId: options.jobId,
          owner: options.owner,
          runnerUnit: options.runnerUnit,
          leaseExpiresAt: options.leaseExpiresAt(),
          at,
          expectedState: 'cancel_requested',
          evidenceEventSeq,
          proof,
        }));
        const cleanupEventSeq = eventSeq(cleanupResult);
        blockedPhase = 'terminal ownership';
        blockedCode = 'RUNNER_DISAPPEARED';
        const terminalAt = now(options);
        const terminalResult = options.ownership.runnerWrite({
          kind: 'cancellation-terminal',
          jobId: options.jobId,
          owner: options.owner,
          runnerUnit: options.runnerUnit,
          leaseExpiresAt: options.leaseExpiresAt(),
          at: terminalAt,
          expectedState: 'cancel_requested',
          terminalAt,
          cleanupEventSeq,
        });
        if (terminalResult.ok !== true) {
          const isLogConflict = terminalResult.conflict.kind === 'identity-mismatch'
            && terminalResult.conflict.message.includes('log');
          throw new CancellationBlockedError(
            `runner cancellation ownership lost: ${terminalResult.conflict.kind}`,
            isLogConflict ? 'RECOVERY_LOG_GAP' : 'RUNNER_DISAPPEARED',
          );
        }
        signalRequested = false;
        return { requested: true, handled: true, state: 'cancelled', evidencePath: evidence.path, evidenceSha256: evidence.sha256 };
      } catch (error) {
        return persistBlocker(error, blockedPhase, blockedCode);
      }
    })();
    running = work;
    try {
      return await work;
    } finally {
      if (running === work) running = null;
    }
  };

  const blockRecoveryRequired = async (blockerCode: CancellationBlockerCode, reason: string): Promise<never> => {
    const current = options.store.getJob(options.jobId);
    if (!observeRequested(current.cancelRequestedAt !== null || signalRequested)) {
      signalRequested = false;
      throw new CancellationBlockedError('cancellation recovery blocker has no persisted request', 'RUNNER_DISAPPEARED');
    }
    if (current.state === 'publishing' || !activeState(current.state)) {
      signalRequested = false;
      throw new CancellationBlockedError('cancellation recovery blocker lost active ownership', 'RUNNER_DISAPPEARED');
    }
    if (current.state !== 'cancel_requested') {
      const expectedState = current.state as ActiveRecoveryState;
      runnerWrite(options, (at) => ({
        kind: 'cancellation-transition',
        jobId: options.jobId,
        owner: options.owner,
        runnerUnit: options.runnerUnit,
        leaseExpiresAt: options.leaseExpiresAt(),
        at,
        expectedState,
      }));
    }
    runnerWrite(options, (at) => ({
      kind: 'cancellation-blocker',
      jobId: options.jobId,
      owner: options.owner,
      runnerUnit: options.runnerUnit,
      leaseExpiresAt: options.leaseExpiresAt(),
      at,
      expectedState: 'cancel_requested',
      blockerCode,
      blocker: { reason, cause: reason },
    }));
    signalRequested = false;
    throw new CancellationBlockedError(reason, blockerCode);
  };

  return Object.freeze({
    isRequested,
    cancellationBudget,
    observeBetweenStages: async (_stage) => cancelIfRequested(),
    observeBetweenOperations: async (_operationId) => cancelIfRequested(),
    cancelIfRequested,
    blockRecoveryRequired,
    dispose: () => signals.off('SIGUSR1', onSignal),
  });
}
