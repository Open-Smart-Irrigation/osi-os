import { createHash } from 'node:crypto';

import type {
  ApiWriteCommand,
  ObservedJsonEvidence,
  PublishRecoveryEvidence,
} from './ownership.js';
import type { JsonObject } from './store.js';
import type { BuilderErrorCode } from '../../domain/types.js';
import { encodeBranchSlug } from '../../domain/paths.js';
import { encodeJson, canonicalInstant } from './validation.js';

const SHA256 = /^[0-9a-f]{64}$/u;

export interface PublishingRecoveryJob {
  readonly jobId: string;
  readonly state: 'publishing';
  readonly publishState: 'publishing';
  readonly runnerUnit: string;
  readonly runnerOwner: string;
  readonly runnerLeaseExpiresAt: string;
  readonly runnerInactiveAt: string;
  readonly stageStartedAt: string;
  readonly rootId: string;
  readonly branch: string;
  readonly pinnedSha: string;
  readonly targetId: string;
  readonly artifactStagingPath: string;
  readonly artifactSha256: string;
  readonly artifactSize: number;
  readonly artifactMtime: string;
  readonly checksumPath: string;
  readonly checksumSha256: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly verificationPath: string;
  readonly verificationSha256: string;
  readonly finalDirectory: string;
  readonly finalPath: string;
  readonly artifactQuarantineIntentPath: string;
  readonly publishStartedAt: string;
  readonly publishedAt: null;
}

export interface PublishingRecoveryContainerProof {
  readonly kind: 'absent';
  readonly globalLabelResult: 'no-match';
  readonly observedAt: string;
}

export interface PublishingRecoveryArtifactObservation {
  readonly final: Readonly<{
    readonly present: boolean;
    readonly path: string;
    readonly held: boolean;
    readonly size: number | null;
    readonly sha256: string | null;
  }>;
  readonly checksum: Readonly<{
    readonly present: boolean;
    readonly path: string;
    readonly contents: string | null;
    readonly sha256: string | null;
  }>;
  readonly manifest: Readonly<{
    readonly present: boolean;
    readonly path: string;
    readonly bytes: string | null;
    readonly content: JsonObject | null;
    readonly sha256: string | null;
  }>;
  readonly verification: Readonly<{
    readonly present: boolean;
    readonly path: string;
    readonly bytes: string | null;
    readonly content: JsonObject | null;
    readonly sha256: string | null;
  }>;
  readonly staging: Readonly<{
    readonly state: 'present' | 'absent';
    readonly path: string | null;
    readonly sha256: string | null;
    readonly size: number | null;
    readonly held: boolean;
  }>;
  readonly quarantine: Readonly<{
    readonly state: 'present' | 'absent';
    readonly path: string | null;
    readonly held: boolean;
    readonly artifactPath: string | null;
    readonly artifactSize: number | null;
    readonly artifactSha256: string | null;
  }>;
}

export interface PublishingRecoveryPublisherObservation {
  readonly destination: 'absent' | 'candidate' | 'mismatched' | 'unknown';
  readonly staging: 'absent' | 'present' | 'unknown';
  readonly mutationCount: 0;
}

export interface PublishingRecoveryPublisher {
  readonly recheck: (job: PublishingRecoveryJob) => Promise<PublishingRecoveryPublisherObservation>;
  readonly quarantine: (job: PublishingRecoveryJob) => Promise<Readonly<{
    readonly outcome: 'quarantined' | 'failed';
    readonly mutationCount: number;
    readonly errorCode?: 'QUARANTINE_PENDING';
  }>>;
}

export interface PublishingRecoveryLogProof {
  readonly runner: 'sealed';
  readonly docker: 'sealed';
  readonly verifiedAt: string;
  readonly noGap: true;
}

export interface PublishingRecoveryLogService {
  readonly sealOrphanTail: (stream: 'runner' | 'docker', proof: Readonly<{
    readonly unitInactive: true;
    readonly leaseStale: true;
    readonly noMatchingContainer: true;
  }>) => Promise<void>;
  readonly verify: (job: PublishingRecoveryJob) => Promise<PublishingRecoveryLogProof>;
}

export interface PublishingRecoveryStageEvidenceInput {
  readonly outcome: 'passed' | 'failed';
  readonly observations: JsonObject;
  readonly error: JsonObject | null;
}

export interface PublishingRecoveryOptions {
  readonly publisher: PublishingRecoveryPublisher;
  readonly logs: PublishingRecoveryLogService;
}

export interface PublishingRecoveryInput {
  readonly job: PublishingRecoveryJob;
  readonly at: string;
  readonly container: PublishingRecoveryContainerProof;
  readonly observeArtifacts: (job: PublishingRecoveryJob) => Promise<PublishingRecoveryArtifactObservation>;
  readonly completeDestination?: (input: Readonly<{
    readonly job: PublishingRecoveryJob;
    readonly at: string;
    readonly logs: PublishingRecoveryLogProof;
  }>) => Promise<Readonly<{
    readonly observed: PublishingRecoveryArtifactObservation;
    readonly stageEvidence: ObservedJsonEvidence;
  }>>;
  readonly writeStageEvidence: (input: PublishingRecoveryStageEvidenceInput) => Promise<ObservedJsonEvidence>;
}

export type PublishingRecoveryBlockerCode =
  | 'PUBLISH_RECOVERY_FAILED'
  | 'UNVERIFIED_FINAL_PATH_BLOCKER'
  | 'QUARANTINE_PENDING'
  | 'RECOVERY_PROOF_INSUFFICIENT';

export type PublishingRecoveryResult =
  | Readonly<{
      readonly kind: 'succeeded' | 'failed';
      readonly command: Extract<ApiWriteCommand, { readonly kind: 'publish-recovery' }>;
    }>
  | Readonly<{
      readonly kind: 'blocked';
      readonly code: PublishingRecoveryBlockerCode;
      readonly reason: string;
    }>;

export class PublishingRecoveryError extends Error {
  readonly code: PublishingRecoveryBlockerCode;

  constructor(code: PublishingRecoveryBlockerCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PublishingRecoveryError';
    this.code = code;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function instant(value: string, field: string): string {
  try {
    return canonicalInstant(value, field);
  } catch (error) {
    throw new PublishingRecoveryError('RECOVERY_PROOF_INSUFFICIENT', `${field} is not canonical`, { cause: error });
  }
}

function fail(code: PublishingRecoveryBlockerCode, message: string): never {
  throw new PublishingRecoveryError(code, message);
}

function jsonObject(value: unknown, field: string): JsonObject {
  try {
    return JSON.parse(encodeJson(value, field, true)) as JsonObject;
  } catch (error) {
    throw new PublishingRecoveryError('RECOVERY_PROOF_INSUFFICIENT', `${field} is not canonical JSON`, { cause: error });
  }
}

function assertJob(input: PublishingRecoveryInput): void {
  const { job, at, container } = input;
  instant(at, 'recovery time');
  instant(job.runnerInactiveAt, 'runner inactive time');
  instant(job.runnerLeaseExpiresAt, 'runner lease expiry');
  instant(job.stageStartedAt, 'publish stage start');
  instant(job.publishStartedAt, 'publish start');
  if (
    job.state !== 'publishing'
    || job.publishState !== 'publishing'
    || job.runnerLeaseExpiresAt >= at
    || job.runnerInactiveAt > at
    || job.stageStartedAt > at
    || job.publishStartedAt > at
    || job.runnerUnit !== `osi-image-builder-runner@${job.jobId}.service`
    || job.runnerOwner.length === 0
    || container.kind !== 'absent'
    || container.globalLabelResult !== 'no-match'
  ) fail('RECOVERY_PROOF_INSUFFICIENT', 'job is not an inactive, lease-expired, container-free publishing job');
  if (instant(container.observedAt, 'container observation') > at) fail('RECOVERY_PROOF_INSUFFICIENT', 'container observation is from the future');
  if (
    !SHA256.test(job.artifactSha256)
    || !SHA256.test(job.checksumSha256)
    || !SHA256.test(job.manifestSha256)
    || !SHA256.test(job.verificationSha256)
    || !Number.isSafeInteger(job.artifactSize)
    || job.artifactSize < 0
  ) fail('RECOVERY_PROOF_INSUFFICIENT', 'persisted artifact identity is incomplete');
}

function assertPublisherObservation(
  before: PublishingRecoveryPublisherObservation,
  after: PublishingRecoveryPublisherObservation,
): void {
  if (before.mutationCount !== 0 || after.mutationCount !== 0) fail('RECOVERY_PROOF_INSUFFICIENT', 'publisher recheck reported a mutation');
  if (before.destination !== after.destination || before.staging !== after.staging) fail('RECOVERY_PROOF_INSUFFICIENT', 'publisher compare-and-swap recheck changed during recovery');
}

function validateSidecar(
  sidecar: PublishingRecoveryArtifactObservation['manifest'],
  expectedPath: string,
  expectedSha: string,
  job: PublishingRecoveryJob,
  field: string,
): void {
  if (!sidecar.present || sidecar.path !== expectedPath || sidecar.bytes === null || sidecar.content === null || sidecar.sha256 !== expectedSha || sha256(sidecar.bytes) !== expectedSha) {
    fail('RECOVERY_PROOF_INSUFFICIENT', `${field} is not an exact held sidecar`);
  }
  const canonical = jsonObject(sidecar.content, `${field} content`);
  if (sidecar.bytes !== encodeJson(canonical, `${field} bytes`, true)) {
    fail('RECOVERY_PROOF_INSUFFICIENT', `${field} is not canonical`);
  }
  if (canonical.jobId !== job.jobId || canonical.branch !== job.branch || canonical.pinnedSha !== job.pinnedSha || canonical.targetId !== job.targetId || canonical.artifactSha256 !== job.artifactSha256) {
    fail('RECOVERY_PROOF_INSUFFICIENT', `${field} is not bound to the job`);
  }
}

function validateFinalArtifacts(observed: PublishingRecoveryArtifactObservation, job: PublishingRecoveryJob): void {
  if (
    !observed.final.present
    || !observed.final.held
    || observed.final.path !== job.finalPath
    || observed.final.size !== job.artifactSize
    || observed.final.sha256 !== job.artifactSha256
  ) fail('UNVERIFIED_FINAL_PATH_BLOCKER', 'final artifact is absent, unheld, or mismatched');
  if (
    observed.checksum.path !== `${job.finalDirectory}/sha256sums`
    || !observed.checksum.present
    || observed.checksum.contents === null
    || observed.checksum.sha256 !== job.checksumSha256
    || sha256(observed.checksum.contents) !== job.checksumSha256
  ) fail('UNVERIFIED_FINAL_PATH_BLOCKER', 'final checksum sidecar is not exact');
  const checksumTokens = observed.checksum.contents.trim().split(/\s+/u);
  if (checksumTokens.length !== 2 || checksumTokens[0] !== job.artifactSha256 || checksumTokens[1] !== job.artifactStagingPath.split('/').at(-1)) fail('UNVERIFIED_FINAL_PATH_BLOCKER', 'final checksum sidecar is not exact');
  validateSidecar(observed.manifest, `${job.finalDirectory}/build-manifest.json`, job.manifestSha256, job, 'final manifest');
  if (observed.verification.sha256 === null || !SHA256.test(observed.verification.sha256)) {
    fail('UNVERIFIED_FINAL_PATH_BLOCKER', 'final verification identity is incomplete');
  }
  validateSidecar(
    observed.verification,
    `${job.finalDirectory}/verification.json`,
    observed.verification.sha256,
    job,
    'final verification',
  );
  validateTerminalVerification(observed.verification.content!, job);
  if (
    observed.staging.state !== 'absent'
    || observed.staging.path !== null
    || observed.staging.sha256 !== null
    || observed.staging.size !== null
    || observed.staging.held
  ) fail('UNVERIFIED_FINAL_PATH_BLOCKER', 'staging remains after final publication');
}

function failureSidecar(
  sidecar: PublishingRecoveryArtifactObservation['manifest'],
  expectedPath: string,
  field: string,
): void {
  if (sidecar.path !== expectedPath || (sidecar.present && sidecar.bytes === null) || (!sidecar.present && (sidecar.bytes !== null || sidecar.content !== null || sidecar.sha256 !== null))) fail('RECOVERY_PROOF_INSUFFICIENT', `${field} failure observation is inconsistent`);
}

function validateFailedArtifacts(observed: PublishingRecoveryArtifactObservation, job: PublishingRecoveryJob): void {
  if (observed.final.path !== job.finalPath || observed.final.present && (observed.final.size !== null && (!Number.isSafeInteger(observed.final.size) || observed.final.size < 0) || observed.final.sha256 !== null && !SHA256.test(observed.final.sha256))) fail('RECOVERY_PROOF_INSUFFICIENT', 'failed final observation is malformed');
  if (!observed.final.present && (observed.final.held || observed.final.size !== null || observed.final.sha256 !== null)) fail('RECOVERY_PROOF_INSUFFICIENT', 'absent final observation contains identity');
  if (observed.checksum.path !== job.checksumPath || (observed.checksum.present && observed.checksum.contents === null) || (!observed.checksum.present && (observed.checksum.contents !== null || observed.checksum.sha256 !== null))) fail('RECOVERY_PROOF_INSUFFICIENT', 'staging checksum failure observation is inconsistent');
  failureSidecar(observed.manifest, job.manifestPath, 'staging manifest');
  failureSidecar(observed.verification, job.verificationPath, 'staging verification');
  if (
    observed.staging.state === 'present'
    && (
      observed.staging.path !== job.artifactStagingPath
      || observed.staging.sha256 !== job.artifactSha256
      || observed.staging.size !== job.artifactSize
      || !observed.staging.held
    )
  ) fail('RECOVERY_PROOF_INSUFFICIENT', 'staging observation does not match the job');
  if (observed.staging.state === 'absent') {
    if (
      observed.staging.path !== null
      || observed.staging.sha256 !== null
      || observed.staging.size !== null
      || observed.staging.held
    ) fail('RECOVERY_PROOF_INSUFFICIENT', 'absent staging observation contains identity');
    if (observed.quarantine.state === 'present') {
      if (
        observed.quarantine.path !== job.artifactQuarantineIntentPath
        || !observed.quarantine.held
        || observed.quarantine.artifactPath !== `${job.artifactQuarantineIntentPath}/${job.artifactStagingPath.split('/').at(-1)}`
        || observed.quarantine.artifactSize !== job.artifactSize
        || observed.quarantine.artifactSha256 !== job.artifactSha256
      ) fail('RECOVERY_PROOF_INSUFFICIENT', 'absent staging has invalid quarantine proof');
    } else if (
      observed.quarantine.path !== null
      || observed.quarantine.held
      || observed.quarantine.artifactPath !== null
      || observed.quarantine.artifactSize !== null
      || observed.quarantine.artifactSha256 !== null
    ) {
      fail('RECOVERY_PROOF_INSUFFICIENT', 'absent quarantine observation contains identity');
    }
  } else if (observed.quarantine.state !== 'absent') {
    fail('RECOVERY_PROOF_INSUFFICIENT', 'present staging cannot also have quarantine proof');
  }
}

type ValidatedStageEvidence = Readonly<{
  readonly observed: ObservedJsonEvidence;
  readonly finishedAt: string;
}>;

function stageEvidence(
  input: PublishingRecoveryStageEvidenceInput,
  job: PublishingRecoveryJob,
  evidence: ObservedJsonEvidence,
  recoveryAt: string,
  terminalVerificationSha256?: string,
): ValidatedStageEvidence {
  const expectedPath = `jobs/${job.jobId}/evidence/09-publish.json`;
  if (evidence.path !== expectedPath || !evidence.present || sha256(evidence.bytes) !== evidence.sha256) fail('RECOVERY_PROOF_INSUFFICIENT', 'stage evidence writer returned an invalid identity');
  let parsed: unknown;
  try { parsed = JSON.parse(evidence.bytes); } catch (error) { throw new PublishingRecoveryError('RECOVERY_PROOF_INSUFFICIENT', 'stage evidence writer returned invalid JSON', { cause: error }); }
  const canonical = encodeJson(parsed, 'publish stage evidence', true);
  if (evidence.bytes !== canonical && evidence.bytes !== `${canonical}\n`) fail('RECOVERY_PROOF_INSUFFICIENT', 'stage evidence writer returned non-canonical JSON');
  const value = parsed as Record<string, unknown>;
  const inputs = value.inputs as Record<string, unknown> | null;
  if (value.schemaVersion !== 1 || value.jobId !== job.jobId || value.stage !== 'publish' || value.outcome !== input.outcome || inputs === null || inputs.branch !== job.branch || inputs.pinnedSha !== job.pinnedSha || inputs.rootId !== job.rootId || inputs.targetId !== job.targetId) fail('RECOVERY_PROOF_INSUFFICIENT', 'stage evidence writer returned an unbound record');
  if (input.outcome === 'passed' && value.error !== null) {
    fail('RECOVERY_PROOF_INSUFFICIENT', 'successful stage evidence contains an error');
  }
  if (input.outcome === 'failed') {
    const storedError = value.error;
    const details = storedError !== null && typeof storedError === 'object' && !Array.isArray(storedError)
      ? (storedError as Record<string, unknown>).details
      : null;
    const recoveryError = details !== null && typeof details === 'object' && !Array.isArray(details)
      ? (details as Record<string, unknown>).recoveryError
      : undefined;
    const directMatch = encodeJson(storedError, 'stored publish error', true)
      === encodeJson(input.error, 'expected publish error', true);
    const wrappedMatch = recoveryError !== undefined
      && encodeJson(recoveryError, 'stored wrapped publish error', true)
        === encodeJson(input.error, 'expected wrapped publish error', true);
    if (!directMatch && !wrappedMatch) {
      fail('RECOVERY_PROOF_INSUFFICIENT', 'failed stage evidence does not bind the recovery error');
    }
  }
  const observations = value.observations as Record<string, unknown> | null;
  const final = observations?.final as Record<string, unknown> | null;
  if (
    input.outcome === 'passed'
    && (
      terminalVerificationSha256 === undefined
      || final?.verificationSha256 !== terminalVerificationSha256
    )
  ) fail('RECOVERY_PROOF_INSUFFICIENT', 'successful stage evidence omits terminal verification identity');
  if (typeof value.finishedAt !== 'string') {
    fail('RECOVERY_PROOF_INSUFFICIENT', 'stage evidence finishedAt is missing');
  }
  const finishedAt = instant(value.finishedAt, 'stage evidence finishedAt');
  if (finishedAt < job.stageStartedAt || finishedAt > recoveryAt) {
    fail('RECOVERY_PROOF_INSUFFICIENT', 'stage evidence chronology is invalid');
  }
  return Object.freeze({ observed: evidence, finishedAt });
}

function validateTerminalVerification(content: JsonObject, job: PublishingRecoveryJob): void {
  const observations = content.observations;
  if (observations === null || typeof observations !== 'object' || Array.isArray(observations)) fail('UNVERIFIED_FINAL_PATH_BLOCKER', 'terminal verification observations are missing');
  const record = observations as JsonObject;
  const publishEvidence = record.publishEvidence;
  if (publishEvidence === null || typeof publishEvidence !== 'object' || Array.isArray(publishEvidence) || (publishEvidence as JsonObject).path !== `jobs/${job.jobId}/evidence/09-publish.json`) fail('UNVERIFIED_FINAL_PATH_BLOCKER', 'terminal verification does not bind publish evidence');
  const stageEvidence = record.stageEvidence;
  const stages = ['preflight', 'source', 'release-gates', 'frontend', 'target-setup', 'feeds', 'config', 'build', 'verify', 'publish'];
  if (!Array.isArray(stageEvidence) || stageEvidence.length !== stages.length) fail('UNVERIFIED_FINAL_PATH_BLOCKER', 'terminal verification stage aggregation is incomplete');
  stageEvidence.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail('UNVERIFIED_FINAL_PATH_BLOCKER', 'terminal verification stage entry is malformed');
    const item = entry as JsonObject;
    if (item.stage !== stages[index] || item.path !== `${String(index).padStart(2, '0')}-${stages[index]}.json` || item.outcome !== 'passed') fail('UNVERIFIED_FINAL_PATH_BLOCKER', 'terminal verification stage aggregation is not terminal');
  });
}

function publicationBinding(job: PublishingRecoveryJob): JsonObject {
  const branchSlug = encodeBranchSlug(job.branch);
  const stagingDirectory = `staging/${job.jobId}`;
  const finalDirectory = `${branchSlug}/${job.pinnedSha}/${job.targetId}`;
  const artifactName = job.artifactStagingPath.slice(stagingDirectory.length + 1);
  if (
    job.artifactStagingPath.slice(0, stagingDirectory.length + 1) !== `${stagingDirectory}/`
    || artifactName.length === 0
    || artifactName.includes('/')
    || job.finalDirectory !== finalDirectory
    || job.finalPath !== `${finalDirectory}/${artifactName}`
  ) {
    fail('RECOVERY_PROOF_INSUFFICIENT', 'publication binding does not match the recovered job');
  }
  return {
    jobId: job.jobId,
    rootId: job.rootId,
    branch: job.branch,
    branchSlug,
    pinnedSha: job.pinnedSha,
    targetId: job.targetId,
    stagingDirectory,
    stagingPath: job.artifactStagingPath,
    finalDirectory,
    finalPath: job.finalPath,
    artifactSha256: job.artifactSha256,
    artifactSize: job.artifactSize,
  };
}

function errorObject(
  code: BuilderErrorCode,
  reason: string,
  job: PublishingRecoveryJob,
  quarantine?: Readonly<{ readonly outcome: 'quarantined' | 'failed'; readonly mutationCount: number }>,
): JsonObject {
  if (code === 'UNVERIFIED_FINAL_PATH_BLOCKER') {
    return { code, reason, binding: publicationBinding(job) };
  }
  if (code === 'QUARANTINE_PENDING') {
    return {
      code,
      reason,
      quarantineIntent: {
        sourcePath: `staging/${job.jobId}`,
        destinationPath: job.artifactQuarantineIntentPath,
        outcome: quarantine?.outcome ?? 'failed',
        mutationCount: quarantine?.mutationCount ?? 0,
      },
    };
  }
  return { code, reason };
}

export function createPublishingRecoveryService(options: PublishingRecoveryOptions): Readonly<{
  readonly recover: (input: PublishingRecoveryInput) => Promise<PublishingRecoveryResult>;
}> {
  if (typeof options.publisher?.recheck !== 'function' || typeof options.publisher?.quarantine !== 'function' || typeof options.logs?.sealOrphanTail !== 'function' || typeof options.logs?.verify !== 'function') throw new TypeError('publishing recovery dependencies are incomplete');
  return Object.freeze({
    async recover(input: PublishingRecoveryInput): Promise<PublishingRecoveryResult> {
      try {
        assertJob(input);
        const orphanProof = { unitInactive: true as const, leaseStale: true as const, noMatchingContainer: true as const };
        await options.logs.sealOrphanTail('runner', orphanProof);
        await options.logs.sealOrphanTail('docker', orphanProof);
        const logProof = await options.logs.verify(input.job);
        if (logProof.runner !== 'sealed' || logProof.docker !== 'sealed' || !logProof.noGap) fail('RECOVERY_PROOF_INSUFFICIENT', 'log proof is incomplete');
        const before = await options.publisher.recheck(input.job);
        if (before.destination === 'unknown' || before.staging === 'unknown') fail('RECOVERY_PROOF_INSUFFICIENT', 'publisher recheck is unknown');
        if (before.destination === 'mismatched') {
          const observed = await input.observeArtifacts(input.job);
          const afterMismatch = await options.publisher.recheck(input.job);
          assertPublisherObservation(before, afterMismatch);
          if (afterMismatch.destination !== 'mismatched') {
            fail('RECOVERY_PROOF_INSUFFICIENT', 'publisher state changed while recording the mismatched final destination');
          }
          return await failedResult(
            input,
            observed,
            logProof,
            'UNVERIFIED_FINAL_PATH_BLOCKER',
            'publisher reports a mismatched final destination',
          );
        }
        if (before.destination === 'candidate' && before.staging !== 'absent') fail('RECOVERY_PROOF_INSUFFICIENT', 'candidate final has unexpected staging');
        if (before.destination === 'absent' && before.staging === 'absent') {
          const observed = await input.observeArtifacts(input.job);
          const after = await options.publisher.recheck(input.job);
          assertPublisherObservation(before, after);
          if (after.destination !== 'absent' || after.staging !== 'absent') fail('RECOVERY_PROOF_INSUFFICIENT', 'publisher state changed while proving absent publication');
          return await failedResult(input, observed, logProof, 'PUBLISH_RECOVERY_FAILED', 'final and staging are absent');
        }
        if (before.destination === 'candidate' && before.staging === 'absent') {
          if (input.completeDestination === undefined) {
            fail('RECOVERY_PROOF_INSUFFICIENT', 'candidate final completion service is unavailable');
          }
          const completion = await input.completeDestination({
            job: input.job,
            at: input.at,
            logs: logProof,
          });
          const afterCompletion = await options.publisher.recheck(input.job);
          assertPublisherObservation(before, afterCompletion);
          if (afterCompletion.destination !== 'candidate' || afterCompletion.staging !== 'absent') {
            fail('RECOVERY_PROOF_INSUFFICIENT', 'publisher state changed while completing the final destination');
          }
          try { validateFinalArtifacts(completion.observed, input.job); }
          catch (error) {
            if (error instanceof PublishingRecoveryError && error.code === 'UNVERIFIED_FINAL_PATH_BLOCKER') return { kind: 'blocked', code: error.code, reason: error.message };
            throw error;
          }
          const stageObservations = jsonObject({
            checksum: completion.observed.checksum,
            final: { verificationSha256: completion.observed.verification.sha256 },
            logs: logProof,
            manifest: completion.observed.manifest,
            staging: completion.observed.staging,
            verification: completion.observed.verification,
          }, 'publish stage observations');
          const stage = stageEvidence(
            { outcome: 'passed', observations: stageObservations, error: null },
            input.job,
            completion.stageEvidence,
            input.at,
            completion.observed.verification.sha256 ?? undefined,
          );
          return succeededResult(input, completion.observed, logProof, stage);
        }
        const observedBeforeQuarantine = await input.observeArtifacts(input.job);
        validateFailedArtifacts(observedBeforeQuarantine, input.job);
        const afterObservation = await options.publisher.recheck(input.job);
        assertPublisherObservation(before, afterObservation);
        if (afterObservation.destination !== 'absent' || afterObservation.staging !== 'present') fail('RECOVERY_PROOF_INSUFFICIENT', 'publisher recheck is not a quarantinable staging-only state');
        const quarantine = await options.publisher.quarantine(input.job);
        const afterQuarantine = await options.publisher.recheck(input.job);
        const observed = await input.observeArtifacts(input.job);
        if (afterQuarantine.mutationCount !== 0) {
          fail('RECOVERY_PROOF_INSUFFICIENT', 'quarantine recheck reported a mutation');
        }
        if (afterQuarantine.destination === 'mismatched') {
          return await failedResult(
            input,
            observed,
            logProof,
            'UNVERIFIED_FINAL_PATH_BLOCKER',
            'quarantine recheck found a mismatched final destination',
          );
        }
        if (afterQuarantine.destination !== 'absent') {
          fail('RECOVERY_PROOF_INSUFFICIENT', 'quarantine recheck did not prove an absent final destination');
        }
        if (
          afterQuarantine.staging === 'absent'
          && observed.staging.state === 'absent'
          && observed.quarantine.state === 'present'
        ) {
          return await failedResult(
            input,
            observed,
            logProof,
            'PUBLISH_RECOVERY_FAILED',
            'final is absent and staging was quarantined',
          );
        }
        return await failedResult(
          input,
          observed,
          logProof,
          'QUARANTINE_PENDING',
          'quarantine mutation was not durably proven',
          quarantine,
        );
      } catch (error) {
        if (error instanceof PublishingRecoveryError) return { kind: 'blocked', code: error.code, reason: error.message };
        return { kind: 'blocked', code: 'RECOVERY_PROOF_INSUFFICIENT', reason: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}

function succeededResult(
  input: PublishingRecoveryInput,
  observed: PublishingRecoveryArtifactObservation,
  logs: PublishingRecoveryLogProof,
  stage: ValidatedStageEvidence,
): PublishingRecoveryResult {
  const evidence: PublishRecoveryEvidence = {
    stage: { startedAt: input.job.stageStartedAt, finishedAt: stage.finishedAt, evidencePath: stage.observed.path, evidenceSha256: stage.observed.sha256 },
    runner: { unit: input.job.runnerUnit, owner: input.job.runnerOwner, leaseExpiresAt: input.job.runnerLeaseExpiresAt, inactiveAt: input.job.runnerInactiveAt, observedAt: input.at },
    container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: input.at },
    artifact: artifact(input.job),
    final: { directory: input.job.finalDirectory, path: input.job.finalPath, publishStartedAt: input.job.publishStartedAt, publishedAt: null },
    observed: { ...observed, stageEvidence: stage.observed, logs },
  };
  return { kind: 'succeeded', command: { kind: 'publish-recovery', jobId: input.job.jobId, expectedState: 'publishing', at: input.at, state: 'succeeded', evidence } };
}

async function failedResult(
  input: PublishingRecoveryInput,
  observed: PublishingRecoveryArtifactObservation,
  logs: PublishingRecoveryLogProof,
  code: BuilderErrorCode,
  reason: string,
  quarantine?: Readonly<{ readonly outcome: 'quarantined' | 'failed'; readonly mutationCount: number }>,
): Promise<PublishingRecoveryResult> {
  validateFailedArtifacts(observed, input.job);
  const observations = jsonObject({ final: observed.final, checksum: observed.checksum, manifest: observed.manifest, verification: observed.verification, staging: observed.staging, quarantine: observed.quarantine, logs }, 'publish observations');
  const error = errorObject(code, reason, input.job, quarantine);
  const stage = stageEvidence(
    { outcome: 'failed', observations, error },
    input.job,
    await input.writeStageEvidence({ outcome: 'failed', observations, error }),
    input.at,
  );
  const evidence: PublishRecoveryEvidence = {
    stage: { startedAt: input.job.stageStartedAt, finishedAt: stage.finishedAt, evidencePath: stage.observed.path, evidenceSha256: stage.observed.sha256 },
    runner: { unit: input.job.runnerUnit, owner: input.job.runnerOwner, leaseExpiresAt: input.job.runnerLeaseExpiresAt, inactiveAt: input.job.runnerInactiveAt, observedAt: input.at },
    container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: input.at },
    artifact: artifact(input.job),
    final: { directory: input.job.finalDirectory, path: input.job.finalPath, publishStartedAt: input.job.publishStartedAt, publishedAt: null },
    observed: { ...observed, stageEvidence: stage.observed, logs },
  };
  return { kind: 'failed', command: { kind: 'publish-recovery', jobId: input.job.jobId, expectedState: 'publishing', at: input.at, state: 'failed', errorCode: code, error, evidence } };
}

function artifact(job: PublishingRecoveryJob): PublishRecoveryEvidence['artifact'] {
  return {
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
  };
}
