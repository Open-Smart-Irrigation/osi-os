import type { JobState } from '../../domain/types.js';
import type {
  CleanupSnapshot,
  DirectInterruptionProof,
} from './ownership.js';
import type {
  ApiRecoveryInspection,
  ApiRecoveryInspector,
} from './recovery-service.js';
import type { RecoveryJobRecord } from './store.js';
import { canonicalInstant } from './validation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ADMISSION_ID_PATTERN = /^cln_[0-7][0-9a-hj-km-np-tv-z]{25}$/u;

export type PhysicalUnitActivity = 'active' | 'inactive' | 'unknown';

export interface PhysicalRecoveryUnitObservation {
  readonly unit: string;
  readonly activity: PhysicalUnitActivity;
  readonly observedAt: string;
}

export interface PhysicalCleanupUnitObservation extends PhysicalRecoveryUnitObservation {
  readonly admissionId: string;
  readonly generation: number;
}

export interface PhysicalRecoveryObservation {
  readonly jobId: string;
  readonly state: JobState;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly runner: PhysicalRecoveryUnitObservation;
  readonly cleanup: PhysicalCleanupUnitObservation | null;
  readonly directProof: DirectInterruptionProof | null;
  readonly cleanupSnapshot: CleanupSnapshot | null;
}

export interface PhysicalRecoveryProbe {
  readonly inspect: (input: Readonly<{
    readonly job: RecoveryJobRecord;
    readonly retry: boolean;
    readonly at: string;
  }>) => PhysicalRecoveryObservation | Promise<PhysicalRecoveryObservation>;
}

export interface ProductionRecoveryInspectorOptions {
  readonly physical: PhysicalRecoveryProbe;
}

export class ProductionRecoveryInspectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProductionRecoveryInspectionError';
  }
}

function fail(message: string, cause?: unknown): never {
  throw new ProductionRecoveryInspectionError(message, cause === undefined ? undefined : { cause });
}

function instant(value: unknown, field: string): string {
  if (typeof value !== 'string') return fail(`${field} is invalid`);
  try {
    return canonicalInstant(value, field);
  } catch (error) {
    return fail(`${field} is invalid`, error);
  }
}

function expectedRunnerUnit(jobId: string): string {
  if (!JOB_ID_PATTERN.test(jobId)) return fail('recovery job ID is invalid');
  return `osi-image-builder-runner@${jobId}.service`;
}

function expectedCleanupUnit(admissionId: string): string {
  if (!ADMISSION_ID_PATTERN.test(admissionId)) return fail('cleanup admission ID is invalid');
  return `osi-image-builder-cleanup@${admissionId}.service`;
}

function withinWindow(value: unknown, field: string, startedAt: string, finishedAt: string): string {
  const observedAt = instant(value, field);
  if (observedAt < startedAt || observedAt > finishedAt) {
    return fail(`${field} is outside the physical inspection window`);
  }
  return observedAt;
}

function validateDirectProof(
  proof: DirectInterruptionProof,
  job: RecoveryJobRecord,
  startedAt: string,
  finishedAt: string,
): void {
  const runnerUnit = expectedRunnerUnit(job.jobId);
  if (
    proof.runnerUnit !== runnerUnit
    || proof.blocker !== 'none'
    || proof.cleanupAdmission !== null
    || proof.cleanupFence !== null
    || proof.container.kind !== 'absent'
    || proof.container.globalLabelResult !== 'no-match'
    || proof.staging.kind !== 'absent'
    || proof.staging.path !== null
  ) return fail('direct interruption proof does not prove a residue-free job');
  withinWindow(proof.unitInactiveAt, 'direct runner inactivity observation', startedAt, finishedAt);
  withinWindow(proof.container.observedAt, 'direct container observation', startedAt, finishedAt);
  withinWindow(proof.logs.verifiedAt, 'direct log observation', startedAt, finishedAt);
  if (proof.kind === 'start-failure') {
    if (
      job.state !== 'starting'
      || proof.runnerLeaseOwner !== null
      || proof.runnerLeaseExpiresAt !== null
    ) return fail('start-failure proof does not match the durable job');
    withinWindow(proof.startAttemptedAt, 'runner start attempt', startedAt, finishedAt);
    return;
  }
  if (
    proof.runnerLeaseOwner.length === 0
    || instant(proof.runnerLeaseExpiresAt, 'runner lease expiry') > finishedAt
    || withinWindow(proof.leaseStaleAt, 'runner lease stale observation', startedAt, finishedAt) < proof.runnerLeaseExpiresAt
  ) return fail('active interruption proof does not contain a stale runner lease');
}

function validateCleanupSnapshot(
  snapshot: CleanupSnapshot,
  job: RecoveryJobRecord,
  startedAt: string,
  finishedAt: string,
): void {
  if (snapshot.state !== job.state || snapshot.runner.unit !== expectedRunnerUnit(job.jobId)) {
    return fail('cleanup snapshot does not match the durable job');
  }
  withinWindow(snapshot.runner.inactiveAt, 'cleanup runner inactivity observation', startedAt, finishedAt);
  withinWindow(snapshot.runner.observedAt, 'cleanup runner observation', startedAt, finishedAt);
  withinWindow(snapshot.container.observedAt, 'cleanup container observation', startedAt, finishedAt);
  withinWindow(snapshot.logs.verifiedAt, 'cleanup log observation', startedAt, finishedAt);
  if (snapshot.staging.kind === 'physical-present') {
    withinWindow(snapshot.staging.observedAt, 'cleanup staging observation', startedAt, finishedAt);
  }
  const residue = snapshot.container.kind === 'present'
    || snapshot.staging.kind !== 'absent'
    || snapshot.logs.runner !== 'absent'
    || snapshot.logs.docker !== 'absent';
  if (residue && snapshot.blocker === 'none') return fail('cleanup snapshot omits its physical residue blocker');
  if (!residue && snapshot.blocker !== 'none') return fail('cleanup snapshot reports residue that was not observed');
}

function validateObservation(
  observation: PhysicalRecoveryObservation,
  job: RecoveryJobRecord,
  at: string,
): Readonly<{ startedAt: string; finishedAt: string }> {
  const startedAt = instant(observation.startedAt, 'physical inspection start');
  const finishedAt = instant(observation.finishedAt, 'physical inspection finish');
  if (startedAt > finishedAt || finishedAt > at) return fail('physical inspection chronology is invalid');
  if (observation.jobId !== job.jobId || observation.state !== job.state) {
    return fail('physical observation does not match the durable job');
  }
  if (observation.runner.unit !== expectedRunnerUnit(job.jobId)) {
    return fail('runner observation does not match the durable job');
  }
  withinWindow(observation.runner.observedAt, 'runner unit observation', startedAt, finishedAt);
  if (!['active', 'inactive', 'unknown'].includes(observation.runner.activity)) {
    return fail('runner activity observation is invalid');
  }
  if (observation.directProof !== null && observation.cleanupSnapshot !== null) {
    return fail('physical observation contains ambiguous direct and cleanup proofs');
  }
  if (observation.directProof !== null) {
    validateDirectProof(observation.directProof, job, startedAt, finishedAt);
    if (
      observation.runner.activity !== 'inactive'
      || observation.directProof.unitInactiveAt !== observation.runner.observedAt
    ) return fail('direct proof does not match the runner observation');
  }
  if (observation.cleanupSnapshot !== null) {
    validateCleanupSnapshot(observation.cleanupSnapshot, job, startedAt, finishedAt);
    if (
      observation.runner.activity !== 'inactive'
      || observation.cleanupSnapshot.runner.observedAt !== observation.runner.observedAt
    ) return fail('cleanup snapshot does not match the runner observation');
  }
  return { startedAt, finishedAt };
}

function validateCleanupObservation(
  cleanup: PhysicalCleanupUnitObservation,
  job: RecoveryJobRecord,
  startedAt: string,
  finishedAt: string,
): void {
  if (
    job.cleanupAdmissionId === null
    || job.cleanupFenceGeneration === null
    || cleanup.admissionId !== job.cleanupAdmissionId
    || cleanup.generation !== job.cleanupFenceGeneration
    || cleanup.unit !== expectedCleanupUnit(job.cleanupAdmissionId)
  ) return fail('cleanup observation does not match the durable fence');
  if (!Number.isSafeInteger(cleanup.generation) || cleanup.generation <= 0) {
    return fail('cleanup observation generation is invalid');
  }
  if (!['active', 'inactive', 'unknown'].includes(cleanup.activity)) {
    return fail('cleanup activity observation is invalid');
  }
  withinWindow(cleanup.observedAt, 'cleanup unit observation', startedAt, finishedAt);
}

function directInspection(
  job: RecoveryJobRecord,
  at: string,
  proof: DirectInterruptionProof,
): ApiRecoveryInspection {
  const startFailure = proof.kind === 'start-failure';
  return {
    kind: 'direct',
    jobId: job.jobId,
    state: job.state as Extract<JobState, 'starting' | 'preflight' | 'source' | 'release_gates' | 'frontend' | 'target_setup' | 'feeds' | 'config' | 'building' | 'verifying' | 'cancel_requested'>,
    at,
    command: {
      kind: 'direct-interrupt',
      jobId: job.jobId,
      expectedState: job.state as Extract<JobState, 'starting' | 'preflight' | 'source' | 'release_gates' | 'frontend' | 'target_setup' | 'feeds' | 'config' | 'building' | 'verifying' | 'cancel_requested'>,
      at,
      proof,
      errorCode: startFailure ? 'SERVICE_START_FAILED' : 'RUNNER_DISAPPEARED',
      error: {
        reason: startFailure
          ? 'fresh physical recovery inspection found a failed runner start without cleanup residue'
          : 'fresh physical recovery inspection found the runner inactive without cleanup residue',
      },
    },
  };
}

export function createProductionRecoveryInspector(
  options: ProductionRecoveryInspectorOptions,
): ApiRecoveryInspector {
  if (options.physical === null || typeof options.physical?.inspect !== 'function') {
    throw new TypeError('physical recovery probe is required');
  }
  return Object.freeze({
    async inspect(input: Parameters<ApiRecoveryInspector['inspect']>[0]): Promise<ApiRecoveryInspection> {
      const at = instant(input.at, 'recovery request time');
      const observation = await options.physical.inspect(input);
      const { startedAt, finishedAt } = validateObservation(observation, input.job, at);
      const fenced = input.job.cleanupAdmissionId !== null || input.job.cleanupFenceGeneration !== null;
      if ((input.job.cleanupAdmissionId === null) !== (input.job.cleanupFenceGeneration === null)) {
        return fail('durable cleanup fence is incomplete');
      }
      if (fenced) {
        if (observation.cleanup === null) {
          if (input.job.cleanupLeaseStatus === 'admitted' || input.job.cleanupLeaseStatus === 'claimed') {
            return fail('active cleanup fence has no physical unit observation');
          }
        } else {
          validateCleanupObservation(observation.cleanup, input.job, startedAt, finishedAt);
          if (
            observation.cleanup.activity === 'active'
            && input.job.cleanupLeaseExpiresAt !== null
            && input.job.cleanupLeaseExpiresAt > at
          ) {
            if (observation.directProof !== null || observation.cleanupSnapshot !== null) {
              return fail('cleanup progress contains unused recovery proof');
            }
            return {
              kind: 'cleanup-in-progress',
              jobId: input.job.jobId,
              state: input.job.state as CleanupSnapshot['state'],
              at,
              admissionId: observation.cleanup.admissionId,
              generation: observation.cleanup.generation,
            };
          }
          if (observation.cleanup.activity === 'unknown') {
            return fail('cleanup unit activity could not be proven');
          }
        }
        if (observation.cleanupSnapshot === null) {
          return fail('inactive cleanup fence has no fresh cleanup snapshot');
        }
        return {
          kind: 'cleanup',
          jobId: input.job.jobId,
          state: input.job.state as CleanupSnapshot['state'],
          at,
          snapshot: observation.cleanupSnapshot,
        };
      }
      if (observation.cleanup !== null) return fail('unfenced job has a cleanup unit observation');
      if (observation.runner.activity === 'active') {
        if (observation.directProof !== null || observation.cleanupSnapshot !== null) {
          return fail('live runner observation contains recovery proof');
        }
        return { kind: 'not-eligible', jobId: input.job.jobId, state: input.job.state, at };
      }
      if (observation.runner.activity === 'unknown') return fail('runner unit activity could not be proven');
      if (observation.cleanupSnapshot !== null) {
        return {
          kind: 'cleanup',
          jobId: input.job.jobId,
          state: input.job.state as CleanupSnapshot['state'],
          at,
          snapshot: observation.cleanupSnapshot,
        };
      }
      if (observation.directProof !== null) {
        if (input.job.state === 'interrupted') {
          return fail('interrupted job cannot use direct recovery proof');
        }
        return directInspection(input.job, at, observation.directProof);
      }
      if (input.job.state === 'interrupted') {
        return { kind: 'not-eligible', jobId: input.job.jobId, state: input.job.state, at };
      }
      return fail('inactive active job has no physical recovery proof');
    },
  });
}
