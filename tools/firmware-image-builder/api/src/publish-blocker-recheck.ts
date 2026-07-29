import { encodeBranchSlug } from '../../domain/paths.js';
import type { TargetId } from '../../domain/types.js';
import type { PublisherClient, PublisherRequest, PublisherResponse } from '../../publisher/client.js';
import type {
  ApiWriteCommand,
  OwnershipConflictKind,
  OwnershipResult,
  PublishBlockerRecheckProof,
} from './ownership.js';
import type { JobRecord } from './store.js';
import { canonicalInstant } from './validation.js';

const HASH40 = /^[0-9a-f]{40}$/u;
const HASH64 = /^[0-9a-f]{64}$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export type PublishBlockerRecheckErrorCode =
  | 'NOT_ELIGIBLE'
  | 'INVALID_DURABLE_EVIDENCE'
  | 'INVALID_PUBLISHER_EVIDENCE'
  | 'PUBLISHER_MUTATED'
  | 'INVALID_CLOCK'
  | 'OWNERSHIP_NOT_COMMITTED';

export class PublishBlockerRecheckError extends Error {
  readonly code: PublishBlockerRecheckErrorCode;

  constructor(code: PublishBlockerRecheckErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PublishBlockerRecheckError';
    this.code = code;
  }
}

export interface FinalDestinationEvidence {
  readonly finalDirectory: string;
  readonly finalPath: string;
  readonly artifact: Readonly<{ readonly sha256: string; readonly size: number; readonly mtime: string }>;
  readonly checksum: Readonly<{ readonly path: string; readonly sha256: string }>;
  readonly manifest: Readonly<{ readonly path: string; readonly sha256: string }>;
  readonly verification: Readonly<{ readonly path: string; readonly sha256: string }>;
  readonly staging: Readonly<{ readonly path: string; readonly state: 'absent' | 'present' }>;
}

export interface FinalDestinationVerificationInput {
  readonly job: JobRecord;
  readonly finalDirectory: string;
  readonly finalPath: string;
}

export interface FinalDestinationVerifier {
  readonly verify: (input: FinalDestinationVerificationInput) => FinalDestinationEvidence | Promise<FinalDestinationEvidence>;
}

export type PublishBlockerRecheckResult =
  | Readonly<{ readonly kind: 'cleared-absent' | 'marked-published' | 'retained-blocker'; readonly jobId: string }>
  | Readonly<{
      readonly kind: 'conflict';
      readonly jobId: string;
      readonly conflict: Readonly<{ readonly kind: OwnershipConflictKind; readonly message: string; readonly rollbackCause?: unknown }>;
    }>;

export interface PublishBlockerRecheckService {
  readonly recheck: (input: Readonly<{ readonly jobId: string }>) => Promise<PublishBlockerRecheckResult>;
}

export interface PublishBlockerRecheckServiceOptions {
  readonly store: Readonly<{ readonly getJob: (jobId: string) => JobRecord }>;
  readonly publisher: Pick<PublisherClient, 'recheck'>;
  readonly verifier: FinalDestinationVerifier;
  readonly ownership: Readonly<{ readonly apiWrite: (command: ApiWriteCommand) => OwnershipResult }>;
  readonly clock: Readonly<{ readonly now: () => string }>;
}

interface DurableBinding {
  readonly finalDirectory: string;
  readonly finalPath: string;
}

type PublisherObservation = Readonly<{
  readonly destination: 'absent' | 'candidate' | 'mismatched' | 'unknown';
  readonly staging: 'absent' | 'present' | 'unknown';
  readonly mutationCount: 0;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function durableBinding(job: JobRecord): DurableBinding {
  if (
    job.state !== 'failed'
    || job.publishState !== 'blocked'
    || job.publishBlockerCode !== 'UNVERIFIED_FINAL_PATH_BLOCKER'
  ) {
    throw new PublishBlockerRecheckError('NOT_ELIGIBLE', 'job is not eligible for publish blocker recheck');
  }
  if (
    !JOB_ID.test(job.jobId)
    || !HASH40.test(job.pinnedSha)
    || !HASH64.test(job.artifactSha256 ?? '')
    || !Number.isSafeInteger(job.artifactSize)
    || Number(job.artifactSize) < 0
    || job.artifactMtime === null
    || !HASH64.test(job.checksumSha256 ?? '')
    || !HASH64.test(job.manifestSha256 ?? '')
    || !HASH64.test(job.verificationSha256 ?? '')
    || job.checksumPath === null
    || job.manifestPath === null
    || job.verificationPath === null
  ) {
    throw new PublishBlockerRecheckError('INVALID_DURABLE_EVIDENCE', 'job artifact evidence is incomplete');
  }
  canonicalInstant(job.artifactMtime, 'publish blocker artifact mtime');
  const blocker = record(job.publishBlocker);
  const binding = record(blocker?.binding);
  if (binding === null) {
    throw new PublishBlockerRecheckError('INVALID_DURABLE_EVIDENCE', 'publish blocker binding is missing');
  }
  const branchSlug = encodeBranchSlug(job.branch);
  const finalDirectory = `${branchSlug}/${job.pinnedSha}/${job.targetId}`;
  const stagingDirectory = `staging/${job.jobId}`;
  const stagingPath = binding.stagingPath;
  const finalPath = binding.finalPath;
  if (
    binding.jobId !== job.jobId
    || binding.rootId !== job.rootId
    || binding.branch !== job.branch
    || binding.branchSlug !== branchSlug
    || binding.pinnedSha !== job.pinnedSha
    || binding.targetId !== job.targetId
    || binding.stagingDirectory !== stagingDirectory
    || typeof stagingPath !== 'string'
    || !stagingPath.startsWith(`${stagingDirectory}/`)
    || stagingPath.slice(stagingDirectory.length + 1).includes('/')
    || binding.finalDirectory !== finalDirectory
    || typeof finalPath !== 'string'
    || !finalPath.startsWith(`${finalDirectory}/`)
    || finalPath.slice(finalDirectory.length + 1).includes('/')
    || finalPath.slice(finalDirectory.length + 1) !== stagingPath.slice(stagingDirectory.length + 1)
    || binding.artifactSha256 !== job.artifactSha256
    || binding.artifactSize !== job.artifactSize
  ) {
    throw new PublishBlockerRecheckError('INVALID_DURABLE_EVIDENCE', 'publish blocker binding does not match the job');
  }
  return { finalDirectory, finalPath };
}

function publisherRequest(job: JobRecord): PublisherRequest {
  return {
    rootId: job.rootId,
    jobId: job.jobId,
    branchSlug: encodeBranchSlug(job.branch),
    sourceSha: job.pinnedSha,
    targetId: job.targetId as TargetId,
  };
}

function publisherObservation(response: PublisherResponse): PublisherObservation | null {
  if (
    typeof response.available !== 'boolean'
    || typeof response.published !== 'boolean'
    || typeof response.quarantined !== 'boolean'
    || typeof response.selfTest !== 'boolean'
    || !Number.isSafeInteger(response.mutationCount)
    || response.mutationCount < 0
  ) {
    throw new PublishBlockerRecheckError('INVALID_PUBLISHER_EVIDENCE', 'publisher recheck required fields are invalid');
  }
  if (response.mutationCount !== 0) {
    throw new PublishBlockerRecheckError('PUBLISHER_MUTATED', 'publisher recheck reported a filesystem mutation');
  }
  if (response.published !== false || response.quarantined !== false || response.selfTest !== false) {
    throw new PublishBlockerRecheckError('INVALID_PUBLISHER_EVIDENCE', 'publisher recheck returned a mutating outcome');
  }
  const hasForbiddenEvidence = response.sourceRelativePath !== undefined
    || response.destinationRelativePath !== undefined
    || response.renameResult !== undefined
    || response.publisherVersion !== undefined
    || response.publisherSourceSha256 !== undefined;
  if (!response.available) {
    if (
      response.errorCode !== 'PUBLISHER_UNSUPPORTED'
      || response.destination !== undefined
      || response.staging !== undefined
      || hasForbiddenEvidence
    ) {
      throw new PublishBlockerRecheckError('INVALID_PUBLISHER_EVIDENCE', 'unavailable publisher evidence is contradictory');
    }
    return null;
  }
  if (hasForbiddenEvidence) {
    throw new PublishBlockerRecheckError('INVALID_PUBLISHER_EVIDENCE', 'publisher recheck returned forbidden mutation evidence');
  }
  const { destination, staging } = response;
  if (
    destination === undefined
    || staging === undefined
    || !['absent', 'candidate', 'mismatched', 'unknown'].includes(destination)
    || !['absent', 'present', 'unknown'].includes(staging)
  ) {
    throw new PublishBlockerRecheckError('INVALID_PUBLISHER_EVIDENCE', 'publisher recheck disposition is incomplete');
  }
  const coherent = (destination === 'candidate' && staging === 'absent' && response.errorCode === undefined)
    || (destination === 'absent' && staging !== 'unknown' && response.errorCode === 'PUBLISH_RECOVERY_FAILED')
    || (destination === 'mismatched' && staging !== 'unknown' && response.errorCode === 'UNVERIFIED_FINAL_PATH_BLOCKER')
    || (destination === 'unknown' && staging === 'unknown' && response.errorCode === 'PUBLISH_RECOVERY_FAILED');
  if (!coherent) {
    throw new PublishBlockerRecheckError('INVALID_PUBLISHER_EVIDENCE', 'publisher recheck disposition is contradictory');
  }
  return { destination, staging, mutationCount: 0 };
}

function matchingEvidence(job: JobRecord, binding: DurableBinding, evidence: FinalDestinationEvidence): boolean {
  return evidence.finalDirectory === binding.finalDirectory
    && evidence.finalPath === binding.finalPath
    && evidence.artifact.sha256 === job.artifactSha256
    && evidence.artifact.size === job.artifactSize
    && evidence.artifact.mtime === job.artifactMtime
    && evidence.checksum.path === `${binding.finalDirectory}/sha256sums`
    && evidence.checksum.sha256 === job.checksumSha256
    && evidence.manifest.path === `${binding.finalDirectory}/build-manifest.json`
    && evidence.manifest.sha256 === job.manifestSha256
    && evidence.verification.path === `${binding.finalDirectory}/verification.json`
    && evidence.verification.sha256 === job.verificationSha256
    && evidence.staging.path === `staging/${job.jobId}`
    && evidence.staging.state === 'absent';
}

function clockInstant(options: PublishBlockerRecheckServiceOptions, field: string): string {
  try {
    return canonicalInstant(options.clock.now(), field);
  } catch (error) {
    throw new PublishBlockerRecheckError('INVALID_CLOCK', `${field} is invalid`, { cause: error });
  }
}

function commandInstant(
  options: PublishBlockerRecheckServiceOptions,
  observedAt: string,
  field: string,
): string {
  const at = clockInstant(options, field);
  if (observedAt > at) {
    throw new PublishBlockerRecheckError('INVALID_CLOCK', `${field} predates its physical observation`);
  }
  return at;
}

function ownershipResult(
  result: OwnershipResult,
  jobId: string,
  kind: 'cleared-absent' | 'marked-published' | 'retained-blocker',
): PublishBlockerRecheckResult {
  if (!result.ok) return { kind: 'conflict', jobId, conflict: result.conflict };
  if (result.kind !== 'committed') {
    throw new PublishBlockerRecheckError('OWNERSHIP_NOT_COMMITTED', 'publish blocker recheck was not durably committed');
  }
  return { kind, jobId };
}

export function createPublishBlockerRecheckService(options: PublishBlockerRecheckServiceOptions): PublishBlockerRecheckService {
  return Object.freeze({
    async recheck(input: Readonly<{ readonly jobId: string }>): Promise<PublishBlockerRecheckResult> {
      if (!JOB_ID.test(input.jobId)) {
        throw new PublishBlockerRecheckError('NOT_ELIGIBLE', 'job ID is invalid');
      }
      const job = options.store.getJob(input.jobId);
      if (job.jobId !== input.jobId) {
        throw new PublishBlockerRecheckError('INVALID_DURABLE_EVIDENCE', 'stored job identity does not match the request');
      }
      const binding = durableBinding(job);
      let observation: PublisherObservation | null;
      try {
        observation = publisherObservation(await options.publisher.recheck(publisherRequest(job)));
      } catch (error) {
        if (error instanceof PublishBlockerRecheckError) throw error;
        observation = null;
      }
      const publisherObservedAt = clockInstant(options, 'publisher recheck observation time');
      const common = (at: string) => ({
        kind: 'publish-blocker-recheck' as const,
        jobId: job.jobId,
        expectedState: 'failed' as const,
        expectedPublishState: 'blocked' as const,
        expectedBlockerCode: 'UNVERIFIED_FINAL_PATH_BLOCKER' as const,
        at,
      });
      if (observation === null || observation.destination === 'unknown') {
        const at = commandInstant(options, publisherObservedAt, 'publish blocker recheck commit time');
        const proof: Extract<PublishBlockerRecheckProof, { kind: 'retained-blocker' }> = {
          kind: 'retained-blocker',
          observedAt: publisherObservedAt,
          reason: 'publisher-unavailable',
          publisher: { destination: 'unknown', staging: 'unknown', mutationCount: 0 },
        };
        return ownershipResult(options.ownership.apiWrite({ ...common(at), resolution: 'retain-blocker', proof }), job.jobId, 'retained-blocker');
      }
      if (observation.destination === 'absent' && observation.staging === 'absent') {
        const at = commandInstant(options, publisherObservedAt, 'publish blocker recheck commit time');
        const publisher = { destination: 'absent' as const, staging: 'absent' as const, mutationCount: 0 as const };
        const proof: Extract<PublishBlockerRecheckProof, { kind: 'destination-absent' }> = {
          kind: 'destination-absent',
          observedAt: publisherObservedAt,
          publisher,
          finalDirectory: binding.finalDirectory,
          finalPath: binding.finalPath,
        };
        return ownershipResult(options.ownership.apiWrite({ ...common(at), resolution: 'clear-absent', proof }), job.jobId, 'cleared-absent');
      }
      if (observation.destination === 'candidate' && observation.staging === 'absent') {
        const publisher = { destination: 'candidate' as const, staging: 'absent' as const, mutationCount: 0 as const };
        let evidence: FinalDestinationEvidence | null = null;
        try {
          const candidate = await options.verifier.verify({
            job,
            finalDirectory: binding.finalDirectory,
            finalPath: binding.finalPath,
          });
          if (matchingEvidence(job, binding, candidate)) evidence = candidate;
        } catch {
          evidence = null;
        }
        const verifierObservedAt = clockInstant(options, 'final destination observation time');
        if (publisherObservedAt > verifierObservedAt) {
          throw new PublishBlockerRecheckError('INVALID_CLOCK', 'final destination observation predates publisher observation');
        }
        const at = commandInstant(options, verifierObservedAt, 'publish blocker recheck commit time');
        if (evidence !== null) {
          const proof: Extract<PublishBlockerRecheckProof, { kind: 'destination-matches' }> = {
            kind: 'destination-matches',
            observedAt: verifierObservedAt,
            publisher,
            finalDirectory: evidence.finalDirectory,
            finalPath: evidence.finalPath,
            staging: { path: evidence.staging.path, state: 'absent' },
            artifact: evidence.artifact,
            checksum: evidence.checksum,
            manifest: evidence.manifest,
            verification: evidence.verification,
          };
          return ownershipResult(options.ownership.apiWrite({ ...common(at), resolution: 'mark-published', proof }), job.jobId, 'marked-published');
        }
        const proof: Extract<PublishBlockerRecheckProof, { kind: 'retained-blocker' }> = {
          kind: 'retained-blocker',
          observedAt: verifierObservedAt,
          reason: 'incomplete-evidence',
          publisher,
        };
        return ownershipResult(options.ownership.apiWrite({ ...common(at), resolution: 'retain-blocker', proof }), job.jobId, 'retained-blocker');
      }
      const at = commandInstant(options, publisherObservedAt, 'publish blocker recheck commit time');
      const reason = observation.staging === 'present' ? 'staging-present' : 'destination-mismatched';
      const proof: Extract<PublishBlockerRecheckProof, { kind: 'retained-blocker' }> = {
        kind: 'retained-blocker',
        observedAt: publisherObservedAt,
        reason,
        publisher: observation,
      };
      return ownershipResult(options.ownership.apiWrite({ ...common(at), resolution: 'retain-blocker', proof }), job.jobId, 'retained-blocker');
    },
  });
}
