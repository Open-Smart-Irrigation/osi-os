import {
  ACTIVE_RECOVERY_STATES,
  CLEANUP_WORKER_OWNER,
  type ActiveRecoveryState,
  type JobState,
} from '../../domain/types.js';
import type { ApiRecoveryRequest, ApiRecoveryResult, ApiRecoveryService } from './routes.js';
import type { ApiWriteCommand, CleanupSnapshot, OwnershipResult, OwnershipStore } from './ownership.js';
import type { CleanupAdmissionRecovery, CleanupAdmissionResult } from './recovery.js';
import type { BuilderStore, JsonObject, RecoveryJobRecord } from './store.js';
import { canonicalInstant } from './validation.js';

const DEFAULT_CLEANUP_LEASE_MS = 5 * 60 * 1_000;
const MAX_CLEANUP_LEASE_MS = 60 * 60 * 1_000;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ACTIVE_STATE_SET = new Set<string>(ACTIVE_RECOVERY_STATES);
const DIRECT_ERROR_CODES = new Set(['RUNNER_DISAPPEARED', 'SERVICE_START_FAILED']);

type DirectInterruptionCommand = Extract<ApiWriteCommand, { readonly kind: 'direct-interrupt' }>;

export type ApiRecoveryInspection =
  | Readonly<{
      readonly kind: 'direct';
      readonly jobId: string;
      readonly state: ActiveRecoveryState;
      readonly at: string;
      readonly command: DirectInterruptionCommand;
    }>
  | Readonly<{
      readonly kind: 'cleanup';
      readonly jobId: string;
      readonly state: ActiveRecoveryState | 'interrupted';
      readonly at: string;
      readonly snapshot: CleanupSnapshot;
    }>
  | Readonly<{
      readonly kind: 'cleanup-in-progress';
      readonly jobId: string;
      readonly state: ActiveRecoveryState | 'interrupted';
      readonly at: string;
      readonly admissionId: string;
      readonly generation: number;
    }>
  | Readonly<{
      readonly kind: 'not-eligible';
      readonly jobId: string;
      readonly state: JobState;
      readonly at: string;
    }>;

export interface ApiRecoveryInspector {
  readonly inspect: (input: Readonly<{
    readonly job: RecoveryJobRecord;
    readonly retry: boolean;
    readonly at: string;
  }>) => ApiRecoveryInspection | Promise<ApiRecoveryInspection>;
}

export interface ApiRecoveryServiceOptions {
  readonly store: Pick<BuilderStore, 'getRecoveryJob'>;
  readonly ownership: Pick<OwnershipStore, 'apiWrite'>;
  readonly recovery: Pick<CleanupAdmissionRecovery, 'admitAndStart' | 'reconcileAndStart' | 'retryCorrectedAndStart' | 'handBackCompleted'>;
  readonly inspector: ApiRecoveryInspector;
  readonly owner?: () => string;
  readonly cleanupLeaseMs?: number;
}

export class ApiRecoveryBoundaryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApiRecoveryBoundaryError';
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return current;
    return Object.fromEntries(Object.entries(current as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
  });
}

function validateRequest(request: ApiRecoveryRequest): string {
  if (!JOB_ID_PATTERN.test(request.jobId)) throw new ApiRecoveryBoundaryError('recovery job ID is invalid');
  if (typeof request.retry !== 'boolean') throw new ApiRecoveryBoundaryError('recovery retry flag is invalid');
  try {
    return canonicalInstant(request.at, 'recovery request time');
  } catch (error) {
    throw new ApiRecoveryBoundaryError('recovery request time is invalid', { cause: error });
  }
}

function validateOwner(owner: string): string {
  if (!OWNER_PATTERN.test(owner)) throw new ApiRecoveryBoundaryError('recovery owner is invalid');
  return owner;
}

function leaseExpiry(at: string, durationMs: number): string {
  return new Date(Date.parse(at) + durationMs).toISOString();
}

function requireFence(job: RecoveryJobRecord): Readonly<{ admissionId: string; generation: number; expiresAt: string; status: NonNullable<RecoveryJobRecord['cleanupLeaseStatus']> }> {
  if (
    job.cleanupAdmissionId === null
    || job.cleanupFenceGeneration === null
    || job.cleanupLeaseExpiresAt === null
    || job.cleanupLeaseStatus === null
  ) throw new ApiRecoveryBoundaryError('active cleanup fence is incomplete');
  return {
    admissionId: job.cleanupAdmissionId,
    generation: job.cleanupFenceGeneration,
    expiresAt: job.cleanupLeaseExpiresAt,
    status: job.cleanupLeaseStatus,
  };
}

function validateInspectionEnvelope(job: RecoveryJobRecord, at: string, inspection: ApiRecoveryInspection): void {
  if (inspection.jobId !== job.jobId || inspection.state !== job.state || inspection.at !== at) {
    throw new ApiRecoveryBoundaryError('recovery inspection identity, state, or time does not match the request');
  }
}

function validateDirectInspection(job: RecoveryJobRecord, at: string, inspection: Extract<ApiRecoveryInspection, { kind: 'direct' }>): DirectInterruptionCommand {
  const command = inspection.command;
  if (
    command.kind !== 'direct-interrupt'
    || command.jobId !== job.jobId
    || command.expectedState !== job.state
    || command.at !== at
    || !DIRECT_ERROR_CODES.has(command.errorCode)
  ) throw new ApiRecoveryBoundaryError('direct recovery command does not match its inspection');
  return command;
}

function committedEventSeq(result: OwnershipResult, operation: string): number {
  if (!result.ok) throw new ApiRecoveryBoundaryError(`${operation} CAS rejected: ${result.conflict.kind}: ${result.conflict.message}`);
  if (result.kind !== 'committed') throw new ApiRecoveryBoundaryError(`${operation} did not append a durable event`);
  return result.eventSeq;
}

function noCleanupFence(job: RecoveryJobRecord): boolean {
  return job.cleanupFenceGeneration === null
    && job.cleanupAdmissionId === null
    && job.cleanupLeaseStatus === null
    && job.cleanupLeaseExpiresAt === null
    && job.cleanupBlockerCode === null
    && job.cleanupBlocker === null
    && job.cleanupLeaseBlockerCode === null
    && job.cleanupLeaseBlocker === null;
}

function validateDirectPostState(
  current: RecoveryJobRecord,
  command: DirectInterruptionCommand,
  terminalEventSeq: number,
): void {
  if (
    current.jobId !== command.jobId
    || current.state !== 'interrupted'
    || current.queueState !== 'complete'
    || current.queuePosition !== null
    || current.terminalAt !== command.at
    || current.terminalErrorCode !== command.errorCode
    || stableJson(current.terminalError) !== stableJson(command.error)
    || !noCleanupFence(current)
    || !Number.isSafeInteger(terminalEventSeq)
    || terminalEventSeq < 0
  ) throw new ApiRecoveryBoundaryError('durable job state does not match direct recovery');
}

function validateCleanupPostState(
  current: RecoveryJobRecord,
  expectedJobId: string,
  expectedState: JobState,
  expectedExpiry: string,
  result: CleanupAdmissionResult,
): void {
  if (
    current.jobId !== expectedJobId
    || current.state !== expectedState
    || current.cleanupAdmissionId !== result.admissionId
    || current.cleanupFenceGeneration !== result.generation
    || (current.cleanupLeaseStatus !== 'admitted' && current.cleanupLeaseStatus !== 'claimed')
    || current.cleanupLeaseExpiresAt !== expectedExpiry
    || current.cleanupBlockerCode !== null
    || current.cleanupBlocker !== null
    || current.cleanupLeaseBlockerCode !== null
    || current.cleanupLeaseBlocker !== null
  ) throw new ApiRecoveryBoundaryError('durable cleanup fence does not match admission result');
}

function validateHandBackPostState(current: RecoveryJobRecord, jobId: string, recoveryEventSeq: number): void {
  if (
    current.jobId !== jobId
    || current.state !== 'interrupted'
    || current.queueState !== 'complete'
    || current.queuePosition !== null
    || current.terminalAt === null
    || current.terminalErrorCode !== 'RUNNER_DISAPPEARED'
    || current.terminalError === null
    || !noCleanupFence(current)
    || !Number.isSafeInteger(recoveryEventSeq)
    || recoveryEventSeq < 0
  ) throw new ApiRecoveryBoundaryError('durable job state does not match cleanup hand-back');
}

function validateBlockedFence(job: RecoveryJobRecord): Readonly<{
  readonly blockerCode: NonNullable<RecoveryJobRecord['cleanupBlockerCode']>;
  readonly blocker: JsonObject;
}> {
  if (
    job.cleanupBlockerCode === null
    || job.cleanupBlocker === null
    || job.cleanupLeaseBlockerCode !== job.cleanupBlockerCode
    || job.cleanupLeaseBlocker === null
    || stableJson(job.cleanupLeaseBlocker) !== stableJson(job.cleanupBlocker)
  ) throw new ApiRecoveryBoundaryError('blocked cleanup fence is missing matching persisted evidence');
  return { blockerCode: job.cleanupBlockerCode, blocker: job.cleanupBlocker };
}

export function createApiRecoveryService(options: ApiRecoveryServiceOptions): ApiRecoveryService {
  const cleanupLeaseMs = options.cleanupLeaseMs ?? DEFAULT_CLEANUP_LEASE_MS;
  if (!Number.isSafeInteger(cleanupLeaseMs) || cleanupLeaseMs <= 0 || cleanupLeaseMs > MAX_CLEANUP_LEASE_MS) {
    throw new TypeError(`cleanupLeaseMs must be a positive safe integer no greater than ${MAX_CLEANUP_LEASE_MS}`);
  }
  const ownerFactory = options.owner ?? (() => CLEANUP_WORKER_OWNER);

  return {
    async recover(request: ApiRecoveryRequest): Promise<ApiRecoveryResult> {
      const at = validateRequest(request);
      const job = options.store.getRecoveryJob(request.jobId);
      if (job.jobId !== request.jobId) throw new ApiRecoveryBoundaryError('recovery store returned the wrong job');

      if (job.cleanupAdmissionId !== null || job.cleanupFenceGeneration !== null || job.cleanupLeaseStatus !== null) {
        const fence = requireFence(job);
        if (fence.status === 'admitted' || fence.status === 'claimed') {
          if (
            job.cleanupBlockerCode !== null
            || job.cleanupBlocker !== null
            || job.cleanupLeaseBlockerCode !== null
            || job.cleanupLeaseBlocker !== null
          ) throw new ApiRecoveryBoundaryError('active cleanup lease retains blocker evidence');
          const inspection = await options.inspector.inspect({ job, retry: request.retry, at });
          validateInspectionEnvelope(job, at, inspection);
          if (inspection.kind === 'cleanup-in-progress') {
            if (
              inspection.admissionId !== fence.admissionId
              || inspection.generation !== fence.generation
              || fence.expiresAt <= at
            ) throw new ApiRecoveryBoundaryError('cleanup progress inspection does not match an unexpired fence');
            return {
              kind: 'cleanup-in-progress',
              jobId: job.jobId,
              admissionId: fence.admissionId,
              generation: fence.generation,
            };
          }
          if (inspection.kind !== 'cleanup' || inspection.snapshot.state !== job.state) {
            throw new ApiRecoveryBoundaryError('cleanup reconciliation requires a matching cleanup inspection');
          }
          const owner = validateOwner(ownerFactory());
          const expiresAt = leaseExpiry(at, cleanupLeaseMs);
          const result = await options.recovery.reconcileAndStart({
            jobId: job.jobId,
            admissionId: fence.admissionId,
            owner,
            expiresAt,
            snapshot: inspection.snapshot,
            at,
          });
          validateCleanupPostState(options.store.getRecoveryJob(job.jobId), job.jobId, job.state, expiresAt, result);
          return {
            kind: 'cleanup-pending',
            jobId: job.jobId,
            admissionId: result.admissionId,
            generation: result.generation,
          };
        }
        if (fence.status === 'completed') {
          const result = await options.recovery.handBackCompleted({
            jobId: job.jobId,
            admissionId: fence.admissionId,
            at,
          });
          if (result.jobId !== job.jobId || result.admissionId !== fence.admissionId) {
            throw new ApiRecoveryBoundaryError('cleanup hand-back returned the wrong admission');
          }
          validateHandBackPostState(options.store.getRecoveryJob(job.jobId), job.jobId, result.recoveryEventSeq);
          return {
            kind: 'handed-back',
            jobId: job.jobId,
            admissionId: result.admissionId,
            recoveryEventSeq: result.recoveryEventSeq,
          };
        }
        if (fence.status !== 'failed' && fence.status !== 'blocking') {
          throw new ApiRecoveryBoundaryError(`cleanup fence status is not recoverable: ${fence.status}`);
        }
        const blocked = validateBlockedFence(job);
        if (!request.retry) {
          return {
            kind: 'retry-blocked',
            jobId: job.jobId,
            admissionId: fence.admissionId,
            generation: fence.generation,
            blockerCode: blocked.blockerCode,
          };
        }
        const inspection = await options.inspector.inspect({ job, retry: true, at });
        validateInspectionEnvelope(job, at, inspection);
        if (inspection.kind !== 'cleanup' || inspection.snapshot.state !== job.state) {
          throw new ApiRecoveryBoundaryError('corrected cleanup retry requires a matching cleanup inspection');
        }
        const owner = validateOwner(ownerFactory());
        const expiresAt = leaseExpiry(at, cleanupLeaseMs);
        const result = await options.recovery.retryCorrectedAndStart({
          jobId: job.jobId,
          admissionId: fence.admissionId,
          owner,
          expiresAt,
          snapshot: inspection.snapshot,
          correctedSnapshot: inspection.snapshot,
          expectedBlockerCode: blocked.blockerCode,
          expectedBlocker: blocked.blocker,
          at,
        });
        validateCleanupPostState(options.store.getRecoveryJob(job.jobId), job.jobId, job.state, expiresAt, result);
        return {
          kind: 'cleanup-pending',
          jobId: job.jobId,
          admissionId: result.admissionId,
          generation: result.generation,
        };
      }

      if (!noCleanupFence(job)) throw new ApiRecoveryBoundaryError('unfenced recovery job retains cleanup evidence');
      if (!ACTIVE_STATE_SET.has(job.state) && job.state !== 'interrupted') return { kind: 'not-eligible', jobId: job.jobId };

      const inspection = await options.inspector.inspect({ job, retry: request.retry, at });
      validateInspectionEnvelope(job, at, inspection);
      if (inspection.kind === 'not-eligible') return { kind: 'not-eligible', jobId: job.jobId };
      if (inspection.kind === 'cleanup-in-progress') {
        throw new ApiRecoveryBoundaryError('unfenced recovery inspection reported cleanup progress');
      }
      if (inspection.kind === 'direct') {
        const command = validateDirectInspection(job, at, inspection);
        const terminalEventSeq = committedEventSeq(options.ownership.apiWrite(command), 'direct interruption');
        validateDirectPostState(options.store.getRecoveryJob(job.jobId), command, terminalEventSeq);
        return { kind: 'direct-recovered', jobId: job.jobId, terminalAt: command.at, terminalEventSeq };
      }
      if (inspection.snapshot.state !== job.state) throw new ApiRecoveryBoundaryError('cleanup snapshot state does not match the job');
      const owner = validateOwner(ownerFactory());
      const expiresAt = leaseExpiry(at, cleanupLeaseMs);
      const result = await options.recovery.admitAndStart({
        jobId: job.jobId,
        owner,
        expiresAt,
        snapshot: inspection.snapshot,
        at,
      });
      validateCleanupPostState(options.store.getRecoveryJob(job.jobId), job.jobId, job.state, expiresAt, result);
      return {
        kind: 'cleanup-pending',
        jobId: job.jobId,
        admissionId: result.admissionId,
        generation: result.generation,
      };
    },
  };
}
