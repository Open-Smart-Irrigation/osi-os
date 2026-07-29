import { randomUUID } from 'node:crypto';

import type { LoadedManifest } from '../../manifest/schema.js';
import {
  OwnershipTransactionError,
  type ApiWriteCommand,
  type OwnershipConflictKind,
  type OwnershipResult,
} from './ownership.js';
import type {
  AcceptedPreflightResult,
  PreflightRequest,
  PreflightResult,
} from './preflight.js';
import { PreflightError } from './preflight.js';
import type { ApiEnqueueRequest, ApiEnqueueService, PersistedEnqueueAcceptance } from './routes.js';
import type { BuilderStore, JobRecord } from './store.js';
import { HttpTransportError } from './server.js';
import { canonicalInstant } from './validation.js';

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export type EnqueueErrorCode =
  | 'ENQUEUE_ID_INVALID'
  | 'ENQUEUE_ACCEPTANCE_INVALID'
  | 'QUEUE_FULL'
  | 'ENQUEUE_CONFLICT'
  | 'ENQUEUE_PERSISTENCE_FAILED'
  | 'ENQUEUE_CLEANUP_FAILED';

export class EnqueueError extends HttpTransportError {
  constructor(code: EnqueueErrorCode, status: number, retryable = false) {
    super({ code, status, retryable });
    this.name = 'EnqueueError';
  }
}

export interface EnqueuePreflightCapability {
  readonly run: (request: PreflightRequest) => Promise<PreflightResult>;
  readonly accept: (
    preflightId: string,
    request: PreflightRequest,
    jobId: string,
  ) => Promise<AcceptedPreflightResult>;
  readonly discardAcceptedJob: (jobId: string) => Promise<void>;
}

export interface EnqueueOwnershipCapability {
  readonly apiWrite: (
    command: Extract<ApiWriteCommand, { readonly kind: 'enqueue' }>,
  ) => OwnershipResult;
}

export interface EnqueueStoreCapability {
  readonly getJob: BuilderStore['getJob'];
}

export interface EnqueueServiceOptions {
  readonly manifest: LoadedManifest;
  readonly preflight: EnqueuePreflightCapability;
  readonly ownership: EnqueueOwnershipCapability;
  readonly store: EnqueueStoreCapability;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

function selection(request: ApiEnqueueRequest): Readonly<PreflightRequest> {
  return Object.freeze({
    branch: request.branch,
    expectedSha: request.expectedSha,
    targetId: request.targetId,
    outputRootId: request.outputRootId,
  });
}

function generatedJobId(factory: () => string): string {
  let jobId: unknown;
  try {
    jobId = factory();
  } catch {
    throw new EnqueueError('ENQUEUE_ID_INVALID', 500, true);
  }
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) {
    throw new EnqueueError('ENQUEUE_ID_INVALID', 500, true);
  }
  return jobId;
}

function validateRequestId(requestId: string): void {
  if (!REQUEST_ID.test(requestId)) {
    throw new EnqueueError('ENQUEUE_ACCEPTANCE_INVALID', 500, true);
  }
}

function acceptanceMatches(
  accepted: AcceptedPreflightResult,
  request: PreflightRequest,
  preflightId: string,
  jobId: string,
): void {
  try {
    const checkedAt = canonicalInstant(accepted.checkedAt, 'enqueue preflight checked time');
    const createdAt = canonicalInstant(accepted.createdAt, 'enqueue preflight creation time');
    const expiresAt = canonicalInstant(accepted.expiresAt, 'enqueue preflight expiry');
    if (
      accepted.preflightId !== preflightId
      || accepted.jobId !== jobId
      || accepted.branch !== request.branch
      || accepted.expectedSha !== request.expectedSha
      || accepted.observedSha !== request.expectedSha
      || accepted.source.remote !== 'origin'
      || accepted.source.ref !== `refs/remotes/origin/${request.branch}`
      || accepted.source.branch !== request.branch
      || accepted.source.sha !== request.expectedSha
      || accepted.target.id !== request.targetId
      || accepted.outputRoot.id !== request.outputRootId
      || accepted.offlineFeedPreparation.jobId !== jobId
      || accepted.offlineFeedPreparation.sourceSha !== request.expectedSha
      || !SHA40.test(accepted.source.sha)
      || createdAt > checkedAt
      || checkedAt >= expiresAt
    ) {
      throw new Error('acceptance identity mismatch');
    }
  } catch {
    throw new EnqueueError('ENQUEUE_ACCEPTANCE_INVALID', 500, true);
  }
}

function acceptanceTime(
  now: () => Date,
  accepted: AcceptedPreflightResult,
  requestId: string,
): string {
  let acceptedAt: string;
  try {
    acceptedAt = canonicalInstant(now().toISOString(), 'enqueue acceptance time');
  } catch {
    throw new EnqueueError('ENQUEUE_ACCEPTANCE_INVALID', 500, true);
  }
  if (acceptedAt < accepted.checkedAt) {
    throw new EnqueueError('ENQUEUE_ACCEPTANCE_INVALID', 500, true);
  }
  if (acceptedAt >= accepted.expiresAt) {
    throw new PreflightError(
      'PREFLIGHT_EXPIRED',
      { expiresAt: accepted.expiresAt, checkedAt: acceptedAt },
      accepted.checks,
      requestId,
    );
  }
  return acceptedAt;
}

function ownershipFailure(kind: OwnershipConflictKind): never {
  if (kind === 'queue-full') throw new EnqueueError('QUEUE_FULL', 409, true);
  throw new EnqueueError('ENQUEUE_CONFLICT', 409, true);
}

function committed(result: OwnershipResult): void {
  if (!result.ok) ownershipFailure(result.conflict.kind);
  if (result.kind !== 'committed') throw new EnqueueError('ENQUEUE_CONFLICT', 409, true);
}

export function createProductionEnqueueService(options: EnqueueServiceOptions): ApiEnqueueService {
  if (!SHA256.test(options.manifest.sha256)) {
    throw new EnqueueError('ENQUEUE_ACCEPTANCE_INVALID', 500, true);
  }
  const idFactory = options.idFactory ?? (() => `job_${randomUUID().replaceAll('-', '')}`);
  const now = options.now ?? (() => new Date());

  return Object.freeze({
    async acceptAfterRefetchAndPersist(
      request: ApiEnqueueRequest,
      requestId: string,
    ): Promise<PersistedEnqueueAcceptance> {
      validateRequestId(requestId);
      const jobId = generatedJobId(idFactory);
      const acceptedSelection = selection(request);
      const preflightId = request.preflightId
        ?? (await options.preflight.run(acceptedSelection)).preflightId;
      const accepted = await options.preflight.accept(preflightId, acceptedSelection, jobId);
      try {
        acceptanceMatches(accepted, acceptedSelection, preflightId, jobId);
        const acceptedAt = acceptanceTime(now, accepted, requestId);
        const command: Extract<ApiWriteCommand, { readonly kind: 'enqueue' }> = {
          kind: 'enqueue',
          input: {
            jobId,
            requestId,
            request: acceptedSelection,
            sourceRemote: accepted.source.remote,
            sourceRef: accepted.source.ref,
            sourceBranch: accepted.source.branch,
            branch: accepted.branch,
            expectedSha: accepted.expectedSha,
            pinnedSha: accepted.source.sha,
            sourcePreparation: accepted.source.sourcePreparation,
            offlineFeedPreparation: accepted.offlineFeedPreparation,
            targetId: accepted.target.id,
            rootId: accepted.outputRoot.id,
            targetManifestSha256: options.manifest.sha256,
            sourceCommitTime: accepted.source.commitTime,
            sourceAuthor: accepted.source.author,
            sourceSubject: accepted.source.subject,
            preflightSha: accepted.observedSha,
            preflightCheckedAt: accepted.checkedAt,
            preflightExpiresAt: accepted.expiresAt,
            acceptedAt,
          },
        };
        committed(options.ownership.apiWrite(command));
      } catch (error) {
        try {
          await options.preflight.discardAcceptedJob(jobId);
        } catch {
          throw new EnqueueError('ENQUEUE_CLEANUP_FAILED', 503, true);
        }
        if (error instanceof OwnershipTransactionError) throw new EnqueueError('ENQUEUE_PERSISTENCE_FAILED', 503, true);
        throw error;
      }

      const job: JobRecord = options.store.getJob(jobId);
      return Object.freeze({
        kind: 'persisted-queued-job',
        secondOriginFetch: 'verified',
        persistence: 'atomic-source-job-queue',
        job,
      });
    },
  });
}
