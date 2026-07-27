import type {
  CancellationEvidence,
  CancellationProof,
  LogCleanupProof,
  OwnershipResult,
  RunnerWriteCommand,
  StagingCleanupProof,
} from '../../api/src/ownership.js';
import type { JobRecord, JsonObject } from '../../api/src/store.js';
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
  'containerStoppedAt' | 'artifactStagingPath'>;

export interface CancellationContainer {
  readonly id: string;
  readonly name: string;
  readonly imageDigest: string;
  readonly labels: JsonObject;
  readonly running: boolean;
  readonly status: string;
  readonly stoppedAt: string | null;
}

/**
 * The runner receives a narrow control surface. It has no force flag and no
 * API/systemd operation, which keeps cancellation cooperative by construction.
 */
export interface CancellationDockerExecutor {
  readonly inspect: (containerId: string) => Promise<CancellationContainer | null>;
  readonly stop: (containerId: string) => Promise<void>;
  readonly waitForStopped: (containerId: string, timeoutMs: number) => Promise<CancellationContainer>;
  readonly remove: (containerId: string) => Promise<void>;
  readonly listByLabels: (labels: JsonObject) => Promise<readonly CancellationContainer[]>;
}

export interface RunnerCancellationSignals {
  readonly on: (signal: 'SIGUSR1', listener: () => void) => void;
  readonly off: (signal: 'SIGUSR1', listener: () => void) => void;
}

export interface RunnerCancellationEvidencePublication {
  readonly path: string;
  readonly sha256: string;
}

export interface RunnerCancellationOptions {
  readonly jobId: string;
  readonly runnerUnit: string;
  readonly owner: string;
  readonly leaseExpiresAt: () => string;
  readonly store: Readonly<{ getJob: (jobId: string) => CancellationJob }>;
  readonly ownership: Readonly<{
    runnerWrite: (command: RunnerWriteCommand) => OwnershipResult;
  }>;
  readonly docker: CancellationDockerExecutor;
  readonly evidence: (value: JsonObject) => Promise<RunnerCancellationEvidencePublication>;
  readonly cleanup: Readonly<{
    readonly staging: () => Promise<StagingCleanupProof>;
    readonly logs: () => Promise<LogCleanupProof>;
  }>;
  readonly clock?: () => string;
  readonly signals?: RunnerCancellationSignals;
}

export type CancellationObservation =
  | Readonly<{ requested: false; handled: false }>
  | Readonly<{ requested: true; handled: true; state: 'cancelled'; evidencePath: string; evidenceSha256: string }>
  | Readonly<{ requested: true; handled: false; ignored: 'publishing' | 'stale' }>;

export class CancellationBlockedError extends Error {
  readonly code = 'CANCELLATION_BLOCKED';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CancellationBlockedError';
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
  if (result.ok !== true) throw new CancellationBlockedError(`runner cancellation ownership lost: ${result.conflict.kind}`);
  return result;
}

function eventSeq(result: OwnershipResult): number {
  if (result.ok !== true || result.kind !== 'committed') {
    throw new CancellationBlockedError('runner cancellation cleanup did not return a committed event sequence');
  }
  if (!Number.isSafeInteger(result.eventSeq) || result.eventSeq < 0) {
    throw new CancellationBlockedError('runner cancellation cleanup returned an invalid event sequence');
  }
  return result.eventSeq;
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
  logs: LogCleanupProof,
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
  if (stopped === null) throw new CancellationBlockedError('container cleanup did not produce stopped inspection');
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
  logs: LogCleanupProof,
): CancellationEvidence {
  if (identity !== null && stopped === null) throw new CancellationBlockedError('cancellation evidence requires a stopped container');
  return {
    kind: identity === null ? 'pre-container' : 'container',
    runnerUnit: options.runnerUnit,
    runnerObservedAt: now(options),
    evidencePath: publication.path,
    evidenceSha256: publication.sha256,
    container: identity === null
      ? { kind: 'absent', globalLabelResult: 'no-match', observedAt: now(options) }
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

export function createRunnerCancellation(options: RunnerCancellationOptions): {
  readonly isRequested: () => boolean;
  readonly observeBetweenStages: (stage: PipelineStageName) => Promise<CancellationObservation>;
  readonly observeBetweenOperations: (operationId: TrustedOperationId) => Promise<CancellationObservation>;
  readonly cancelIfRequested: () => Promise<CancellationObservation>;
  readonly dispose: () => void;
} {
  if (options.store?.getJob === undefined || options.ownership?.runnerWrite === undefined) throw new TypeError('runner cancellation persistence is required');
  if (options.docker?.inspect === undefined || options.docker.stop === undefined || options.docker.waitForStopped === undefined || options.docker.remove === undefined || options.docker.listByLabels === undefined) throw new TypeError('runner cancellation Docker controls are incomplete');
  if (options.evidence === undefined || options.cleanup?.staging === undefined || options.cleanup.logs === undefined) throw new TypeError('runner cancellation evidence and cleanup are required');
  let signalRequested = false;
  let running: Promise<CancellationObservation> | null = null;
  const onSignal = (): void => { signalRequested = true; };
  const signals = options.signals ?? process;
  signals.on('SIGUSR1', onSignal);

  const isRequested = (): boolean => {
    if (signalRequested) return true;
    return options.store.getJob(options.jobId).cancelRequestedAt !== null;
  };

  const cancelIfRequested = async (): Promise<CancellationObservation> => {
    if (running !== null) return running;
    const work = (async (): Promise<CancellationObservation> => {
      const current = options.store.getJob(options.jobId);
      const requested = current.cancelRequestedAt !== null;
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
        throw new CancellationBlockedError('runner cancellation lease identity changed');
      }
      const expectedLabels = labels(current);
      const identity = assertExactPersistedIdentity(current, expectedLabels);
      let stopped: CancellationContainer | null = null;
      if (identity === null) {
        const matching = await options.docker.listByLabels(expectedLabels);
        if (matching.length !== 0) throw new CancellationIdentityError('Docker contains a matching labeled container without persisted identity');
      } else {
        const observed = await options.docker.inspect(identity.id);
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
            stoppedAt: current.containerStoppedAt,
          };
        }
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
      }
      const persistBlocker = (error: unknown, phase: string): never => {
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
            blockerCode: 'CANCELLED',
            blocker: { reason: `cancellation ${phase} blocked: ${reason}`, cause: reason },
          }));
        } catch (blockerError) {
          signalRequested = false;
          throw new CancellationBlockedError(`cancellation ${phase} failed and blocker persistence failed`, { cause: new AggregateError([error, blockerError]) });
        }
        signalRequested = false;
        throw new CancellationBlockedError(`cancellation ${phase} blocked`, { cause: error });
      };
      try {
        if (identity !== null) {
          const present = await options.docker.inspect(identity.id);
          if (present !== null) {
            assertObservedIdentity(present, identity);
            if (present.running) {
              await options.docker.stop(identity.id);
              stopped = await options.docker.waitForStopped(identity.id, COOPERATIVE_STOP_TIMEOUT_MS);
              assertObservedIdentity(stopped, identity);
              if (stopped.running) throw new CancellationBlockedError('Docker wait returned a running container');
              if (stopped.stoppedAt === null && current.containerStoppedAt === null) throw new CancellationBlockedError('Docker wait did not provide a stopped timestamp');
            } else {
              stopped = present;
            }
          } else if (current.containerStoppedAt === null) {
            throw new CancellationIdentityError('persisted container disappeared before controlled stop');
          } else if (stopped === null) {
            stopped = {
              id: identity.id,
              name: identity.name,
              imageDigest: identity.imageDigest,
              labels: identity.labels,
              running: false,
              status: 'exited',
              stoppedAt: current.containerStoppedAt,
            };
          }
        }
        const staging = await options.cleanup.staging();
        const logs = await options.cleanup.logs();
        const evidence = await options.evidence({
          schemaVersion: 1,
          kind: 'runner-cancellation',
          jobId: options.jobId,
          state: 'cancel_requested',
          stage: current.currentStage,
          outcome: 'controlled',
          container: identity === null ? { kind: 'absent', globalLabelResult: 'no-match' } : {
            kind: 'present', id: identity.id, name: identity.name, imageDigest: identity.imageDigest, labels: identity.labels,
            stoppedAt: stopped?.stoppedAt ?? current.containerStoppedAt,
          },
          staging,
          logs,
        });
        const durableEvidence = cancellationEvidence(options, current, identity, stopped, evidence, staging, logs);
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
        const evidenceEventSeq = eventSeq(evidenceResult);
        let removedAt = now(options);
        if (identity !== null) {
          const present = await options.docker.inspect(identity.id);
          if (present !== null) {
            assertObservedIdentity(present, identity);
            await options.docker.remove(identity.id);
            removedAt = now(options);
            if (await options.docker.inspect(identity.id) !== null) throw new CancellationBlockedError('Docker rm did not prove exact container absence');
          }
        }
        if ((await options.docker.listByLabels(expectedLabels)).length !== 0) throw new CancellationBlockedError('Docker label query did not prove cancellation container absence');
        const observedAt = now(options);
        const proof = cancellationProof(options, current, identity, stopped, removedAt, observedAt, staging, logs);
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
        runnerWrite(options, (at) => ({
          kind: 'cancellation-terminal',
          jobId: options.jobId,
          owner: options.owner,
          runnerUnit: options.runnerUnit,
          leaseExpiresAt: options.leaseExpiresAt(),
          at,
          expectedState: 'cancel_requested',
          terminalAt: at,
          cleanupEventSeq,
        }));
        signalRequested = false;
        return { requested: true, handled: true, state: 'cancelled', evidencePath: evidence.path, evidenceSha256: evidence.sha256 };
      } catch (error) {
        return persistBlocker(error, 'cleanup');
      }
    })();
    running = work;
    try {
      return await work;
    } finally {
      if (running === work) running = null;
    }
  };

  return Object.freeze({
    isRequested,
    observeBetweenStages: async (_stage) => cancelIfRequested(),
    observeBetweenOperations: async (_operationId) => cancelIfRequested(),
    cancelIfRequested,
    dispose: () => signals.off('SIGUSR1', onSignal),
  });
}
