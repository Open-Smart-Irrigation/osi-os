import { DatabaseSync } from 'node:sqlite';
import {
  BUILDER_ERROR_CODES,
  FRESHNESS_STATES,
  JOB_STATES,
  PIPELINE_STAGE_NAMES,
  TARGET_IDS,
  TRUSTED_OPERATION_IDS,
  type BuilderErrorCode,
  type FreshnessState,
  type JobState,
  type PipelineStageName,
  type TargetId,
  type TrustedOperationId,
} from '../../domain/types.js';
import {
  boundedText,
  canonicalInstant as sharedCanonicalInstant,
  stableRelativePath,
  encodeJson,
  parseJson,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  SharedValidationError,
} from './validation.js';
import {
  validateOfflineFeedPreparation,
  validateRecursiveSourcePreparation,
  type OfflineFeedPreparation,
  type RecursiveSourcePreparation,
} from './git/source-resolver.js';
import { encodeBranchSlug } from '../../domain/paths.js';

export { JSON_LIMITS } from './validation.js';
export type { JsonObject, JsonPrimitive, JsonValue } from './validation.js';
export const EVENT_PAGE_DEFAULT_LIMIT = 100;
export const EVENT_PAGE_MAX_LIMIT = 1_000;
export const CANCELLATION_PROTOCOL_EVENT_QUERY = `
  SELECT job_id, seq, event_type, state, stage, payload_json, at,
         stream, file_generation, byte_offset, byte_length, partial
  FROM job_events INDEXED BY job_events_cancellation_protocol
  WHERE job_id = ?
    AND event_type = 'cleanup'
    AND json_extract(payload_json, '$.kind')
      IN ('cancellation-evidence', 'cancellation-cleanup')
  ORDER BY seq
  LIMIT 3
`;
type PublishState = 'not_started' | 'staged' | 'publishing' | 'published' | 'quarantined' | 'blocked';
type StageOutcome = 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted';
type LifecyclePhase = 'not_created' | 'created' | 'started' | 'stopped' | 'removed';
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const HASH40 = /^[0-9a-f]{40}$/;
const HASH64 = /^[0-9a-f]{64}$/;
const QUEUE_STATES = ['queued', 'dispatched', 'released', 'cancelled', 'complete'] as const;
const PUBLISH_STATES = ['not_started', 'staged', 'publishing', 'published', 'quarantined', 'blocked'] as const;
const STAGE_OUTCOMES = ['running', 'passed', 'failed', 'cancelled', 'interrupted'] as const;
const LIFECYCLE_PHASES = ['not_created', 'created', 'started', 'stopped', 'removed'] as const;
const EVENT_TYPES = [
  'enqueue', 'cancellation_requested', 'dispatch', 'state', 'stage', 'operation', 'container',
  'artifact', 'publish', 'terminal', 'cleanup_admission', 'cleanup_claim', 'cleanup_renew',
  'cleanup_complete', 'cleanup', 'recovery', 'freshness', 'log', 'log_orphan_tail', 'log-gap',
  'log-truncated',
] as const;
type EventType = (typeof EVENT_TYPES)[number];

function storeValidation<T>(work: () => T): T {
  try { return work(); } catch (error) {
    if (error instanceof SharedValidationError) throw new StoreValidationError(error.message, { cause: error });
    throw error;
  }
}

const assertJsonObject = (value: unknown, field: string): string => storeValidation(() => encodeJson(value, field, true));

const parseJsonObject = (value: string | null, field: string): JsonObject | null => {
  if (value === null) return null;
  try { return parseJson(value, field, true) as JsonObject; }
  catch (error) { if (error instanceof SharedValidationError) throw new StoreDataError(error.message, { cause: error }); throw error; }
};

const jsonOrNull = (value: unknown, field: string): string | null =>
  value === undefined || value === null ? null : assertJsonObject(value, field);

const JOB_LABEL = 'org.osi.image-builder.job-id';
const MANIFEST_LABEL = 'org.osi.image-builder.manifest-sha';

function assertContainerLabels(labels: JsonObject, jobId: string, targetManifestSha256: string): string {
  const keys = Object.keys(labels).sort();
  if (keys.length !== 2 || keys[0] !== JOB_LABEL || keys[1] !== MANIFEST_LABEL) {
    throw new StoreValidationError('container labels must contain exactly the job and manifest labels');
  }
  if (labels[JOB_LABEL] !== jobId || labels[MANIFEST_LABEL] !== targetManifestSha256) {
    throw new StoreValidationError('container labels do not match the job and target manifest');
  }
  return assertJsonObject(labels, 'container labels');
}

function parseJsonArray(value: string, field: string): readonly string[] {
  let bounded: JsonValue;
  try { bounded = parseJson(value, field); }
  catch (error) { if (error instanceof SharedValidationError) throw new StoreDataError(error.message, { cause: error }); throw error; }
  if (!Array.isArray(bounded) || bounded.some((item) => typeof item !== 'string')) {
    throw new StoreDataError(`${field} is not a string array`);
  }
  return bounded as readonly string[];
}

export class StoreError extends Error {
  rollbackCause?: unknown;
  releaseCause?: unknown;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreError';
  }
}

export class StoreTransactionError extends StoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreTransactionError';
  }
}

export class StoreNotFoundError extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = 'StoreNotFoundError';
  }
}

export class StoreDataError extends StoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreDataError';
  }
}

export class StoreConflictError extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = 'StoreConflictError';
  }
}

export class StoreValidationError extends StoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreValidationError';
  }
}

export function encodeSourcePreparation(value: unknown, pinnedSha: string): string {
  try {
    return encodeJson(
      validateRecursiveSourcePreparation(value as RecursiveSourcePreparation, pinnedSha),
      'source preparation',
      true,
    );
  } catch (error) {
    throw new StoreValidationError('source preparation is invalid', { cause: error });
  }
}

function persistedSourcePreparation(value: string | null, pinnedSha: string): RecursiveSourcePreparation | null {
  if (value === null) return null;
  try {
    const parsed = parseJson(value, 'source_preparation_json', true);
    return validateRecursiveSourcePreparation(parsed as unknown as RecursiveSourcePreparation, pinnedSha);
  } catch (error) {
    if (error instanceof StoreDataError) throw error;
    throw new StoreDataError('persisted source preparation is invalid', { cause: error });
  }
}

export function encodeOfflineFeedPreparation(
  value: unknown,
  jobId: string,
  pinnedSha: string,
): string {
  try {
    return encodeJson(
      validateOfflineFeedPreparation(value as OfflineFeedPreparation, jobId, pinnedSha),
      'offline feed preparation',
      true,
    );
  } catch (error) {
    throw new StoreValidationError('offline feed preparation is invalid', { cause: error });
  }
}

function persistedOfflineFeedPreparation(
  value: string | null,
  jobId: string,
  pinnedSha: string,
): OfflineFeedPreparation | null {
  if (value === null) return null;
  try {
    const parsed = parseJson(value, 'offline_feed_preparation_json', true);
    return validateOfflineFeedPreparation(
      parsed as unknown as OfflineFeedPreparation,
      jobId,
      pinnedSha,
    );
  } catch (error) {
    if (error instanceof StoreDataError) throw error;
    throw new StoreDataError('persisted offline feed preparation is invalid', { cause: error });
  }
}

export interface CreateJobInput {
  readonly jobId: string;
  readonly requestId: string;
  readonly request: JsonObject;
  readonly sourceRemote: string;
  readonly sourceRef: string;
  readonly sourceBranch: string;
  readonly branch: string;
  readonly expectedSha: string;
  readonly pinnedSha: string;
  readonly sourcePreparation: RecursiveSourcePreparation;
  readonly offlineFeedPreparation: OfflineFeedPreparation;
  readonly targetId: TargetId;
  readonly rootId: string;
  readonly targetManifestSha256: string;
  readonly sourceCommitTime: string;
  readonly sourceAuthor: string;
  readonly sourceSubject: string;
  readonly preflightSha?: string | null;
  readonly preflightCheckedAt?: string | null;
  readonly preflightExpiresAt?: string | null;
  readonly acceptedAt: string;
}

interface SourceIdentityBase {
  readonly sourceRemote: string;
  readonly sourceRef: string;
  readonly sourceBranch: string;
  readonly branch: string;
  readonly expectedSha: string;
  readonly pinnedSha: string;
  readonly sourceCommitTime: string;
  readonly sourceAuthor: string;
  readonly sourceSubject: string;
}

export interface SourceIdentity extends SourceIdentityBase {
  readonly sourcePreparation: RecursiveSourcePreparation;
  readonly offlineFeedPreparation: OfflineFeedPreparation;
  readonly sourceRunnable: true;
}

export interface JobRecord extends SourceIdentityBase {
  readonly sourcePreparation: RecursiveSourcePreparation | null;
  readonly offlineFeedPreparation: OfflineFeedPreparation | null;
  readonly sourceRunnable: boolean;
  readonly jobId: string;
  readonly requestId: string;
  readonly request: JsonObject | null;
  readonly targetId: TargetId;
  readonly rootId: string;
  readonly targetManifestSha256: string;
  readonly acceptedAt: string;
  readonly state: JobState;
  readonly currentStage: PipelineStageName | null;
  readonly queueState: string;
  readonly queuePosition: number | null;
  readonly cancelRequestedAt: string | null;
  readonly cancelReason: string | null;
  readonly cancellationCooperativeDeadlineAt: string | null;
  readonly cancellationEscalationOwner: string | null;
  readonly cancellationEscalationLeaseExpiresAt: string | null;
  readonly cancellationStopIntentAt: string | null;
  readonly cancellationGraceDeadlineAt: string | null;
  readonly cancellationSignalObservation: JsonObject | null;
  readonly cancellationStopObservation: JsonObject | null;
  readonly cancellationInspectionObservations: JsonObject | null;
  readonly cancellationClockHighWaterAt: string | null;
  readonly cancellationStopAuthorizedAt: string | null;
  readonly cancellationStopAuthorizedLeaseExpiresAt: string | null;
  readonly dispatchedAt: string | null;
  readonly runnerUnit: string | null;
  readonly runnerLeaseOwner: string | null;
  readonly runnerLeaseExpiresAt: string | null;
  readonly containerId: string | null;
  readonly containerName: string | null;
  readonly containerImageDigest: string | null;
  readonly containerLabelJobId: string | null;
  readonly containerLabelManifestSha: string | null;
  readonly containerLabels: JsonObject | null;
  readonly containerMount: JsonObject | null;
  readonly containerEnvironment: JsonObject | null;
  readonly containerSecurity: JsonObject | null;
  readonly containerInspection: JsonObject | null;
  readonly containerCreatedAt: string | null;
  readonly containerStartedAt: string | null;
  readonly containerStoppedAt: string | null;
  readonly containerRemovedAt: string | null;
  readonly containerCleanupOutcome: string | null;
  readonly cleanupBlockerCode: BuilderErrorCode | null;
  readonly cleanupBlocker: JsonObject | null;
  readonly terminalErrorCode: BuilderErrorCode | null;
  readonly terminalError: JsonObject | null;
  readonly terminalAt: string | null;
  readonly artifactStagingPath: string | null;
  readonly artifactQuarantinePath: string | null;
  readonly artifactQuarantineIntentPath: string | null;
  readonly artifactFinalDirectory: string | null;
  readonly artifactFinalPath: string | null;
  readonly artifactSha256: string | null;
  readonly artifactSize: number | null;
  readonly artifactMtime: string | null;
  readonly checksumPath: string | null;
  readonly checksumSha256: string | null;
  readonly manifestPath: string | null;
  readonly manifestSha256: string | null;
  readonly verificationPath: string | null;
  readonly verificationSha256: string | null;
  readonly publishState: PublishState | null;
  readonly publishStartedAt: string | null;
  readonly publishedAt: string | null;
  readonly publishBlockerCode: BuilderErrorCode | null;
  readonly publishBlocker: JsonObject | null;
  readonly freshnessStatus: FreshnessState | null;
  readonly freshnessObservedSha: string | null;
  readonly newerSourceAvailable: boolean | null;
  readonly freshnessRequestedAt: string | null;
  readonly freshnessCheckedAt: string | null;
  readonly freshnessErrorCode: BuilderErrorCode | null;
  readonly freshnessError: JsonObject | null;
  readonly freshnessErrorEvidencePath: string | null;
  readonly freshnessErrorEvidenceSha256: string | null;
}

export type PublishBlockerRecheckResolution = 'cleared_absent' | 'marked_published' | 'retained_blocker';

export interface PublishBlockerRecheckRecord {
  readonly jobId: string;
  readonly attempt: number;
  readonly eventSeq: number;
  readonly resolution: PublishBlockerRecheckResolution;
  readonly observedAt: string;
  readonly committedAt: string;
  readonly priorPublishState: 'blocked';
  readonly priorBlockerCode: 'UNVERIFIED_FINAL_PATH_BLOCKER';
  readonly priorBlocker: JsonObject;
  readonly artifactStagingPath: string | null;
  readonly artifactQuarantinePath: string | null;
  readonly artifactSha256: string;
  readonly artifactSize: number;
  readonly artifactMtime: string;
  readonly checksumPath: string;
  readonly checksumSha256: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly verificationPath: string;
  readonly verificationSha256: string;
  readonly finalDirectory: string | null;
  readonly finalPath: string | null;
  readonly publishedAt: string | null;
  readonly proof: JsonObject;
}

export interface CancellationJobRecord {
  readonly jobId: string;
  readonly state: JobState;
  readonly cancelRequestedAt: string | null;
  readonly cancelReason: string | null;
  readonly runnerUnit: string | null;
  readonly runnerLeaseOwner: string | null;
  readonly runnerLeaseExpiresAt: string | null;
  readonly cancellationCooperativeDeadlineAt: string | null;
  readonly cancellationEscalationOwner: string | null;
  readonly cancellationEscalationLeaseExpiresAt: string | null;
  readonly cancellationStopIntentAt: string | null;
  readonly cancellationGraceDeadlineAt: string | null;
  readonly cancellationSignalObservation: JsonObject | null;
  readonly cancellationStopObservation: JsonObject | null;
  readonly cancellationInspectionObservations: JsonObject | null;
  readonly cancellationClockHighWaterAt: string | null;
  readonly cancellationStopAuthorizedAt: string | null;
  readonly cancellationStopAuthorizedLeaseExpiresAt: string | null;
  readonly cleanupFenceGeneration: number | null;
  readonly cleanupAdmissionId: string | null;
  readonly cleanupBlockerCode: BuilderErrorCode | null;
  readonly cleanupBlocker: JsonObject | null;
}

export interface RecoveryJobRecord {
  readonly jobId: string;
  readonly state: JobState;
  readonly queueState: string;
  readonly queuePosition: number | null;
  readonly terminalAt: string | null;
  readonly terminalErrorCode: BuilderErrorCode | null;
  readonly terminalError: JsonObject | null;
  readonly cleanupFenceGeneration: number | null;
  readonly cleanupAdmissionId: string | null;
  readonly cleanupBlockerCode: BuilderErrorCode | null;
  readonly cleanupBlocker: JsonObject | null;
  readonly cleanupLeaseStatus: 'admitted' | 'claimed' | 'completed' | 'handed_back' | 'failed' | 'blocking' | 'expired' | null;
  readonly cleanupLeaseExpiresAt: string | null;
  readonly cleanupLeaseBlockerCode: BuilderErrorCode | null;
  readonly cleanupLeaseBlocker: JsonObject | null;
}

export interface QueueClaim {
  readonly jobId: string;
  readonly fifoSeq: number;
  readonly runnerUnit: string;
}

export interface StageInput {
  readonly stage: PipelineStageName;
  readonly outcome: StageOutcome;
  readonly startedAt: string;
  readonly finishedAt?: string | null;
  readonly evidencePath?: string | null;
  readonly evidenceSha256?: string | null;
  readonly errorCode?: BuilderErrorCode | null;
  readonly error?: JsonObject | null;
}

export interface StoredStage {
  readonly jobId: string;
  readonly stage: PipelineStageName;
  readonly outcome: StageOutcome | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly evidencePath: string | null;
  readonly evidenceSha256: string | null;
  readonly errorCode: BuilderErrorCode | null;
  readonly error: JsonObject | null;
}

export interface OperationInput {
  readonly operationId: TrustedOperationId;
  readonly attempt: number;
  readonly argvHash: string;
  readonly argv: readonly string[];
  readonly startedAt: string;
  readonly finishedAt?: string | null;
  readonly containerId?: string | null;
  readonly containerName?: string | null;
  readonly containerImageDigest?: string | null;
  readonly containerLabelJobId?: string | null;
  readonly containerLabelManifestSha?: string | null;
  readonly containerMount?: JsonObject | null;
  readonly containerEnvironment?: JsonObject | null;
  readonly containerSecurity?: JsonObject | null;
  readonly inspection?: JsonObject | null;
  readonly timedOut: boolean;
  readonly lifecyclePhase: LifecyclePhase;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly outcome: 'passed' | 'failed' | 'accepted';
  readonly acceptedDisposition?: 'expected-rootfs-already-present' | null;
  readonly evidencePath: string;
  readonly evidenceSha256: string;
  readonly errorCode?: BuilderErrorCode | null;
  readonly error?: JsonObject | null;
}

export interface RuntimeDiagnosticsInput {
  readonly containerId: string;
  readonly containerName: string;
  readonly targetManifestSha256: string;
  readonly imageDigest: string;
  readonly labels: JsonObject;
  readonly mount: JsonObject;
  readonly environment: JsonObject;
  readonly security: JsonObject;
  readonly inspection: JsonObject;
  readonly lifecycle: LifecyclePhase;
  readonly occurredAt: string;
  readonly createdAt?: string | null;
  readonly startedAt?: string | null;
  readonly stoppedAt?: string | null;
  readonly removedAt?: string | null;
  readonly cleanupOutcome?: 'passed' | 'failed' | 'blocking' | null;
}

export interface ArtifactInput {
  readonly stagingPath: string;
  readonly artifactSha256: string;
  readonly artifactSize: number;
  readonly artifactMtime: string;
  readonly checksumPath: string;
  readonly checksumSha256: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly verificationPath: string;
  readonly verificationSha256: string;
}

export interface PublishInput {
  readonly state: PublishState;
  readonly stagingPath?: string | null;
  readonly finalDirectory?: string;
  readonly finalPath?: string;
  readonly quarantinePath?: string;
  readonly startedAt?: string;
  readonly publishedAt?: string;
  readonly blockerCode?: BuilderErrorCode;
  readonly blocker?: JsonObject;
}

export interface FreshnessInput {
  readonly status: FreshnessState;
  readonly pinnedSha: string;
  readonly observedSha: string | null;
  readonly checkedAt: string;
  readonly error?: JsonObject;
  readonly errorEvidencePath?: string;
  readonly errorEvidenceSha256?: string;
}

export interface EventRecord {
  readonly jobId: string;
  readonly seq: number;
  readonly eventType: EventType;
  readonly state: JobState | null;
  readonly stage: PipelineStageName | null;
  readonly payload: JsonObject;
  readonly at: string;
}

export interface EventPageOptions {
  readonly afterSeq?: number;
  readonly limit?: number;
}

export interface EventPage {
  readonly events: readonly EventRecord[];
  readonly nextAfterSeq: number | null;
}

export interface StoredOperation {
  readonly jobId: string;
  readonly operationId: TrustedOperationId;
  readonly attempt: number;
  readonly argvHash: string;
  readonly argv: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly containerId: string | null;
  readonly containerName: string | null;
  readonly containerImageDigest: string | null;
  readonly containerLabelJobId: string | null;
  readonly containerLabelManifestSha: string | null;
  readonly containerMount: JsonObject | null;
  readonly containerEnvironment: JsonObject | null;
  readonly containerSecurity: JsonObject | null;
  readonly inspection: JsonObject | null;
  readonly timedOut: boolean;
  readonly lifecyclePhase: LifecyclePhase;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly outcome: 'passed' | 'failed' | 'accepted' | null;
  readonly acceptedDisposition: 'expected-rootfs-already-present' | null;
  readonly evidencePath: string | null;
  readonly evidenceSha256: string | null;
  readonly errorCode: BuilderErrorCode | null;
  readonly error: JsonObject | null;
}

type DbRow = Record<string, unknown>;

function canonicalInstant(value: string, field: string): string {
  try { return sharedCanonicalInstant(value, field); }
  catch (error) { if (error instanceof SharedValidationError) throw new StoreDataError(error.message, { cause: error }); throw error; }
}

function optionalInstant(value: string | null | undefined, field: string): string | null {
  return value === undefined || value === null ? null : canonicalInstant(value, field);
}

function nullableInstant(row: DbRow, key: string): string | null {
  return optionalInstant(nullableString(row, key), key);
}

function requireHash(value: string, pattern: RegExp, field: string): void {
  if (!pattern.test(value)) throw new StoreValidationError(`${field} must be a lowercase hexadecimal hash`);
}

function asString(row: DbRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new StoreDataError(`SQLite column ${key} is not text`);
  try { return boundedText(value, key); }
  catch (error) { if (error instanceof SharedValidationError) throw new StoreDataError(error.message, { cause: error }); throw error; }
}

function nullableString(row: DbRow, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : asString(row, key);
}

function persistedRelativePath(row: DbRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  try { return stableRelativePath(value, key); }
  catch (error) { if (error instanceof SharedValidationError) throw new StoreDataError(error.message, { cause: error }); throw error; }
}

function nullableGroup(row: DbRow, keys: readonly string[], context: string): void {
  const present = keys.map((key) => row[key] !== null && row[key] !== undefined);
  if (present.some(Boolean) && !present.every(Boolean)) throw new StoreDataError(`${context} nullable group is incomplete`, { cause: new SharedValidationError(`${context} nullable group is incomplete`) });
}

function requiredInteger(row: DbRow, key: string, context = key): number {
  if (row[key] === null || row[key] === undefined) throw new StoreDataError(`${context} is unexpectedly null`);
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 0) throw new StoreDataError(`${context} is invalid`, { cause: new SharedValidationError(`${context} must be a non-negative safe integer`) });
  return value;
}

function persistedEnum(row: DbRow, key: string, allowed: readonly string[], optional = true): string | null {
  const value = nullableString(row, key);
  if (value === null) { if (!optional) throw new StoreDataError(`SQLite column ${key} is unexpectedly null`); return null; }
  if (!allowed.includes(value)) throw new StoreDataError(`SQLite column ${key} contains an invalid persisted value`, { cause: new SharedValidationError(`${key} enum value is invalid`) });
  return value;
}

function nullableNumber(row: DbRow, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new StoreDataError(`SQLite column ${key} is not numeric`);
  return number;
}

function queuePosition(row: DbRow): number | null {
  const value = nullableNumber(row, 'queue_position');
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new StoreDataError('SQLite queue_position is invalid');
  return value;
}

function readHash(row: DbRow, key: string, pattern: RegExp): string | null {
  const value = nullableString(row, key);
  if (value !== null && !pattern.test(value)) throw new StoreDataError(`SQLite column ${key} contains an invalid hash`);
  return value;
}

function requiredHash(row: DbRow, key: string, pattern: RegExp): string {
  const value = readHash(row, key, pattern);
  if (value === null) throw new StoreDataError(`SQLite column ${key} is unexpectedly null`);
  return value;
}

function requiredRelativePath(row: DbRow, key: string): string {
  const value = persistedRelativePath(row, key);
  if (value === null) throw new StoreDataError(`SQLite column ${key} is unexpectedly null`);
  return value;
}

function proofObject(value: unknown, field: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new StoreDataError(`${field} is not a JSON object`);
  return value as JsonObject;
}

function proofText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new StoreDataError(`${field} is not text`);
  try { return boundedText(value, field); }
  catch (error) { if (error instanceof SharedValidationError) throw new StoreDataError(error.message, { cause: error }); throw error; }
}

function proofPath(value: unknown, field: string): string {
  try { return stableRelativePath(value, field); }
  catch (error) { if (error instanceof SharedValidationError) throw new StoreDataError(error.message, { cause: error }); throw error; }
}

function proofHash(value: unknown, field: string): string {
  const result = proofText(value, field);
  if (!HASH64.test(result)) throw new StoreDataError(`${field} contains an invalid hash`);
  return result;
}

function proofSize(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new StoreDataError(`${field} is invalid`);
  return value;
}

function proofInstant(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new StoreDataError(`${field} is not an instant`);
  return canonicalInstant(value, field);
}

interface ValidatedPublishBlockerBinding {
  readonly priorBlocker: JsonObject;
  readonly stagingPath: string;
  readonly finalDirectory: string;
  readonly finalPath: string;
}

function validatePublishBlockerBinding(
  row: DbRow,
  jobId: string,
  artifactSha256: string,
  artifactSize: number,
): ValidatedPublishBlockerBinding {
  const priorBlocker = parseJsonObject(nullableString(row, 'prior_blocker_json'), 'prior_blocker_json');
  if (priorBlocker === null) throw new StoreDataError('publish blocker recheck prior blocker is unexpectedly null');
  const binding = proofObject(priorBlocker.binding, 'prior_blocker_json.binding');
  const rootId = asString(row, 'job_root_id');
  const branch = asString(row, 'job_branch');
  const pinnedSha = readHash(row, 'job_pinned_sha', HASH40);
  const targetId = persistedEnum(row, 'job_target_id', TARGET_IDS, false);
  if (pinnedSha === null || targetId === null) throw new StoreDataError('publish blocker recheck joined job identity is incomplete');
  const branchSlug = encodeBranchSlug(branch);
  const expectedStagingDirectory = `staging/${jobId}`;
  const expectedFinalDirectory = `${branchSlug}/${pinnedSha}/${targetId}`;
  const bindingJobId = proofText(binding.jobId, 'prior_blocker_json.binding.jobId');
  const bindingRootId = proofText(binding.rootId, 'prior_blocker_json.binding.rootId');
  const bindingBranch = proofText(binding.branch, 'prior_blocker_json.binding.branch');
  const bindingBranchSlug = proofPath(binding.branchSlug, 'prior_blocker_json.binding.branchSlug');
  const bindingPinnedSha = proofText(binding.pinnedSha, 'prior_blocker_json.binding.pinnedSha');
  if (!HASH40.test(bindingPinnedSha)) throw new StoreDataError('prior_blocker_json.binding.pinnedSha contains an invalid hash');
  const bindingTargetId = proofText(binding.targetId, 'prior_blocker_json.binding.targetId');
  const stagingDirectory = proofPath(binding.stagingDirectory, 'prior_blocker_json.binding.stagingDirectory');
  const stagingPath = proofPath(binding.stagingPath, 'prior_blocker_json.binding.stagingPath');
  const finalDirectory = proofPath(binding.finalDirectory, 'prior_blocker_json.binding.finalDirectory');
  const finalPath = proofPath(binding.finalPath, 'prior_blocker_json.binding.finalPath');
  const bindingArtifactSha256 = proofHash(binding.artifactSha256, 'prior_blocker_json.binding.artifactSha256');
  const bindingArtifactSize = proofSize(binding.artifactSize, 'prior_blocker_json.binding.artifactSize');
  const stagingRemainder = stagingPath.startsWith(`${stagingDirectory}/`) ? stagingPath.slice(stagingDirectory.length + 1) : null;
  const finalRemainder = finalPath.startsWith(`${finalDirectory}/`) ? finalPath.slice(finalDirectory.length + 1) : null;
  if (
    bindingJobId !== jobId
    || bindingRootId !== rootId
    || bindingBranch !== branch
    || bindingBranchSlug !== branchSlug
    || bindingPinnedSha !== pinnedSha
    || bindingTargetId !== targetId
    || stagingDirectory !== expectedStagingDirectory
    || stagingRemainder === null
    || stagingRemainder.length === 0
    || stagingRemainder.includes('/')
    || finalDirectory !== expectedFinalDirectory
    || finalRemainder === null
    || finalRemainder.length === 0
    || finalRemainder.includes('/')
    || finalRemainder !== stagingRemainder
    || bindingArtifactSha256 !== artifactSha256
    || bindingArtifactSize !== artifactSize
  ) throw new StoreDataError('publish blocker recheck prior blocker binding is not exact');
  return { priorBlocker, stagingPath, finalDirectory, finalPath };
}

function validatePublishBlockerRecheckProof(
  row: DbRow,
  resolution: PublishBlockerRecheckResolution,
  jobId: string,
  binding: ValidatedPublishBlockerBinding,
  observedAt: string,
  finalDirectory: string | null,
  finalPath: string | null,
  publishedAt: string | null,
  artifactSha256: string,
  artifactSize: number,
  artifactMtime: string,
  checksumSha256: string,
  manifestSha256: string,
  verificationSha256: string,
): JsonObject {
  const proof = parseJsonObject(nullableString(row, 'proof_json'), 'proof_json');
  if (proof === null) throw new StoreDataError('publish blocker recheck proof is unexpectedly null');
  if (proofInstant(proof.observedAt, 'proof.observedAt') !== observedAt) throw new StoreDataError('publish blocker recheck proof time is not bound to observed_at');
  const publisher = proofObject(proof.publisher, 'proof.publisher');
  if (publisher.mutationCount !== 0) throw new StoreDataError('publish blocker recheck publisher mutation count is not zero');
  if (typeof publisher.mutationCount !== 'number' || !Number.isSafeInteger(publisher.mutationCount)) throw new StoreDataError('publish blocker recheck publisher mutation count is invalid');

  if (resolution === 'cleared_absent') {
    if (proof.kind !== 'destination-absent' || publisher.destination !== 'absent' || publisher.staging !== 'absent') throw new StoreDataError('cleared publish blocker recheck proof is incoherent');
    if (proofPath(proof.finalDirectory, 'proof.finalDirectory') !== binding.finalDirectory || proofPath(proof.finalPath, 'proof.finalPath') !== binding.finalPath) throw new StoreDataError('cleared publish blocker recheck proof path is not bound');
  } else if (resolution === 'marked_published') {
    if (proof.kind !== 'destination-matches' || publisher.destination !== 'candidate' || publisher.staging !== 'absent') throw new StoreDataError('marked publish blocker recheck proof is incoherent');
    if (finalDirectory === null || finalPath === null || publishedAt === null) throw new StoreDataError('marked publish blocker recheck final evidence is incomplete');
    if (finalDirectory !== binding.finalDirectory || finalPath !== binding.finalPath) throw new StoreDataError('marked publish blocker recheck final path is not bound');
    if (proofPath(proof.finalDirectory, 'proof.finalDirectory') !== finalDirectory || proofPath(proof.finalPath, 'proof.finalPath') !== finalPath) throw new StoreDataError('marked publish blocker recheck proof path is not bound');
    const staging = proofObject(proof.staging, 'proof.staging');
    if (proofPath(staging.path, 'proof.staging.path') !== `staging/${jobId}` || staging.state !== 'absent') throw new StoreDataError('marked publish blocker recheck staging proof is incoherent');
    const artifact = proofObject(proof.artifact, 'proof.artifact');
    if (proofHash(artifact.sha256, 'proof.artifact.sha256') !== artifactSha256 || proofSize(artifact.size, 'proof.artifact.size') !== artifactSize || proofInstant(artifact.mtime, 'proof.artifact.mtime') !== artifactMtime) throw new StoreDataError('marked publish blocker recheck artifact proof is not bound');
    for (const [key, expectedPath, hash] of [['checksum', `${finalDirectory}/sha256sums`, checksumSha256], ['manifest', `${finalDirectory}/build-manifest.json`, manifestSha256], ['verification', `${finalDirectory}/verification.json`, verificationSha256] as const]) {
      const sidecar = proofObject(proof[key], `proof.${key}`);
      if (proofPath(sidecar.path, `proof.${key}.path`) !== expectedPath || proofHash(sidecar.sha256, `proof.${key}.sha256`) !== hash) throw new StoreDataError(`marked publish blocker recheck ${key} proof is not bound`);
    }
  } else {
    if (proof.kind !== 'retained-blocker') throw new StoreDataError('retained publish blocker recheck proof is incoherent');
    const reason = proofText(proof.reason, 'proof.reason');
    const coherent = (reason === 'destination-mismatched' && publisher.destination === 'mismatched')
      || (reason === 'staging-present' && publisher.staging === 'present')
      || (reason === 'incomplete-evidence' && publisher.destination === 'candidate' && publisher.staging === 'absent')
      || ((reason === 'unsafe-path' || reason === 'publisher-unavailable') && publisher.destination === 'unknown' && publisher.staging === 'unknown');
    if (!coherent || finalDirectory !== null || finalPath !== null || publishedAt !== null) throw new StoreDataError('retained publish blocker recheck evidence is incoherent');
  }
  return proof;
}

export class BuilderStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  close(): void { this.#db.close(); }

  getJob(jobId: string): JobRecord {
    const row = this.#db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as DbRow | undefined;
    if (!row) throw new StoreNotFoundError(`job not found: ${jobId}`);
    return this.#mapJob(row);
  }

  getPublishBlockerRecheck(jobId: string, eventSeq: number): PublishBlockerRecheckRecord | null {
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new StoreValidationError('publish blocker recheck job ID is invalid');
    if (!Number.isSafeInteger(eventSeq) || eventSeq < 0) throw new StoreValidationError('publish blocker recheck event sequence is invalid');
    const row = this.#db.prepare(`SELECT
      audit.job_id, audit.attempt, audit.event_seq, audit.resolution, audit.observed_at, audit.committed_at,
      audit.prior_publish_state, audit.prior_blocker_code, audit.prior_blocker_json,
      audit.artifact_staging_path, audit.artifact_quarantine_path, audit.artifact_sha256, audit.artifact_size, audit.artifact_mtime,
      audit.checksum_path, audit.checksum_sha256, audit.manifest_path, audit.manifest_sha256,
      audit.verification_path, audit.verification_sha256, audit.final_directory, audit.final_path, audit.published_at, audit.proof_json,
      job.root_id AS job_root_id, job.branch AS job_branch, job.pinned_sha AS job_pinned_sha, job.target_id AS job_target_id
      FROM publish_blocker_rechecks AS audit
      JOIN jobs AS job ON job.job_id = audit.job_id
      WHERE audit.job_id = ? AND audit.event_seq = ?`).get(jobId, eventSeq) as DbRow | undefined;
    if (!row) return null;
    if (asString(row, 'job_id') !== jobId) throw new StoreDataError('publish blocker recheck job identity is corrupt');
    const attempt = requiredInteger(row, 'attempt');
    if (attempt <= 0) throw new StoreDataError('publish blocker recheck attempt is invalid');
    const storedEventSeq = requiredInteger(row, 'event_seq');
    if (storedEventSeq !== eventSeq || storedEventSeq < 0) throw new StoreDataError('publish blocker recheck event sequence is corrupt');
    const resolution = persistedEnum(row, 'resolution', ['cleared_absent', 'marked_published', 'retained_blocker'], false)! as PublishBlockerRecheckResolution;
    const observedAt = canonicalInstant(asString(row, 'observed_at'), 'publish blocker recheck observed_at');
    const committedAt = canonicalInstant(asString(row, 'committed_at'), 'publish blocker recheck committed_at');
    if (observedAt > committedAt) throw new StoreDataError('publish blocker recheck chronology is invalid');
    if (persistedEnum(row, 'prior_publish_state', ['blocked'], false) !== 'blocked') throw new StoreDataError('publish blocker recheck prior publish state is invalid');
    if (persistedEnum(row, 'prior_blocker_code', ['UNVERIFIED_FINAL_PATH_BLOCKER'], false) !== 'UNVERIFIED_FINAL_PATH_BLOCKER') throw new StoreDataError('publish blocker recheck prior blocker code is invalid');
    const artifactStagingPath = persistedRelativePath(row, 'artifact_staging_path');
    const artifactQuarantinePath = persistedRelativePath(row, 'artifact_quarantine_path');
    const artifactSha256 = requiredHash(row, 'artifact_sha256', HASH64);
    const artifactSize = requiredInteger(row, 'artifact_size');
    const artifactMtime = canonicalInstant(asString(row, 'artifact_mtime'), 'publish blocker recheck artifact_mtime');
    const checksumPath = requiredRelativePath(row, 'checksum_path');
    const checksumSha256 = requiredHash(row, 'checksum_sha256', HASH64);
    const manifestPath = requiredRelativePath(row, 'manifest_path');
    const manifestSha256 = requiredHash(row, 'manifest_sha256', HASH64);
    const verificationPath = requiredRelativePath(row, 'verification_path');
    const verificationSha256 = requiredHash(row, 'verification_sha256', HASH64);
    const finalDirectory = persistedRelativePath(row, 'final_directory');
    const finalPath = persistedRelativePath(row, 'final_path');
    const publishedAt = nullableInstant(row, 'published_at');
    if ((finalDirectory === null) !== (finalPath === null)) throw new StoreDataError('publish blocker recheck final path group is incomplete');
    if (resolution === 'marked_published' ? publishedAt === null || finalDirectory === null : publishedAt !== null || finalDirectory !== null) throw new StoreDataError('publish blocker recheck resolution evidence is incoherent');
    if (resolution !== 'retained_blocker' && artifactStagingPath !== null) throw new StoreDataError('publish blocker recheck staging path is unexpectedly present');
    const binding = validatePublishBlockerBinding(row, jobId, artifactSha256, artifactSize);
    if (resolution === 'retained_blocker' && artifactStagingPath !== null && artifactStagingPath !== binding.stagingPath) throw new StoreDataError('retained publish blocker recheck staging path is not bound');
    if (resolution === 'marked_published' && publishedAt !== committedAt) throw new StoreDataError('marked publish blocker recheck published_at is not committed_at');
    const proof = validatePublishBlockerRecheckProof(row, resolution, jobId, binding, observedAt, finalDirectory, finalPath, publishedAt, artifactSha256, artifactSize, artifactMtime, checksumSha256, manifestSha256, verificationSha256);
    const priorBlocker = binding.priorBlocker;
    return {
      jobId, attempt, eventSeq: storedEventSeq, resolution, observedAt, committedAt,
      priorPublishState: 'blocked', priorBlockerCode: 'UNVERIFIED_FINAL_PATH_BLOCKER', priorBlocker,
      artifactStagingPath, artifactQuarantinePath, artifactSha256, artifactSize, artifactMtime,
      checksumPath, checksumSha256, manifestPath, manifestSha256, verificationPath, verificationSha256,
      finalDirectory, finalPath, publishedAt, proof,
    };
  }

  getCancellationJob(jobId: string): CancellationJobRecord {
    const row = this.#db.prepare(`SELECT
      job_id, state, cancel_requested_at, cancel_reason,
      runner_unit, runner_lease_owner, runner_lease_expires_at,
      cancellation_cooperative_deadline_at,
      cancellation_escalation_owner, cancellation_escalation_lease_expires_at,
      cancellation_stop_intent_at, cancellation_grace_deadline_at,
      cancellation_signal_observation_json, cancellation_stop_observation_json,
      cancellation_inspection_observations_json,
      cancellation_clock_high_water_at, cancellation_stop_authorized_at,
      cancellation_stop_authorized_lease_expires_at,
      cleanup_fence_generation, cleanup_admission_id,
      cleanup_blocker_code, cleanup_blocker_json
      FROM jobs WHERE job_id = ?`).get(jobId) as DbRow | undefined;
    if (!row) throw new StoreNotFoundError(`job not found: ${jobId}`);
    const cleanupBlockerCode = persistedEnum(row, 'cleanup_blocker_code', BUILDER_ERROR_CODES) as BuilderErrorCode | null;
    const cleanupBlocker = parseJsonObject(nullableString(row, 'cleanup_blocker_json'), 'cleanup_blocker_json');
    if ((cleanupBlockerCode === null) !== (cleanupBlocker === null)) throw new StoreDataError('cleanup blocker evidence is incomplete');
    return {
      jobId: asString(row, 'job_id'),
      state: persistedEnum(row, 'state', JOB_STATES, false)! as JobState,
      cancelRequestedAt: nullableInstant(row, 'cancel_requested_at'),
      cancelReason: nullableString(row, 'cancel_reason'),
      runnerUnit: nullableString(row, 'runner_unit'),
      runnerLeaseOwner: nullableString(row, 'runner_lease_owner'),
      runnerLeaseExpiresAt: nullableString(row, 'runner_lease_expires_at'),
      cancellationCooperativeDeadlineAt: nullableInstant(row, 'cancellation_cooperative_deadline_at'),
      cancellationEscalationOwner: nullableString(row, 'cancellation_escalation_owner'),
      cancellationEscalationLeaseExpiresAt: nullableInstant(row, 'cancellation_escalation_lease_expires_at'),
      cancellationStopIntentAt: nullableInstant(row, 'cancellation_stop_intent_at'),
      cancellationGraceDeadlineAt: nullableInstant(row, 'cancellation_grace_deadline_at'),
      cancellationSignalObservation: parseJsonObject(nullableString(row, 'cancellation_signal_observation_json'), 'cancellation_signal_observation_json'),
      cancellationStopObservation: parseJsonObject(nullableString(row, 'cancellation_stop_observation_json'), 'cancellation_stop_observation_json'),
      cancellationInspectionObservations: parseJsonObject(nullableString(row, 'cancellation_inspection_observations_json'), 'cancellation_inspection_observations_json'),
      cancellationClockHighWaterAt: nullableInstant(row, 'cancellation_clock_high_water_at'),
      cancellationStopAuthorizedAt: nullableInstant(row, 'cancellation_stop_authorized_at'),
      cancellationStopAuthorizedLeaseExpiresAt: nullableInstant(row, 'cancellation_stop_authorized_lease_expires_at'),
      cleanupFenceGeneration: nullableNumber(row, 'cleanup_fence_generation'),
      cleanupAdmissionId: nullableString(row, 'cleanup_admission_id'),
      cleanupBlockerCode,
      cleanupBlocker,
    };
  }

  getRecoveryJob(jobId: string): RecoveryJobRecord {
    const row = this.#db.prepare(`SELECT
      job.job_id, job.state, job.queue_state, job.queue_position,
      job.terminal_at, job.terminal_error_code, job.terminal_error_json,
      job.cleanup_fence_generation, job.cleanup_admission_id,
      job.cleanup_blocker_code, job.cleanup_blocker_json,
      lease.status AS cleanup_lease_status,
      lease.expires_at AS cleanup_lease_expires_at,
      lease.fence_generation AS cleanup_lease_fence_generation,
      lease.blocker_code AS cleanup_lease_blocker_code,
      lease.blocker_json AS cleanup_lease_blocker_json
      FROM jobs AS job
      LEFT JOIN cleanup_leases AS lease
        ON lease.job_id = job.job_id
       AND lease.admission_id = job.cleanup_admission_id
      WHERE job.job_id = ?`).get(jobId) as DbRow | undefined;
    if (!row) throw new StoreNotFoundError(`job not found: ${jobId}`);
    const cleanupFenceGeneration = nullableNumber(row, 'cleanup_fence_generation');
    const cleanupAdmissionId = nullableString(row, 'cleanup_admission_id');
    if ((cleanupFenceGeneration === null) !== (cleanupAdmissionId === null)) {
      throw new StoreDataError('cleanup recovery fence is incomplete');
    }
    if (cleanupFenceGeneration !== null && (!Number.isSafeInteger(cleanupFenceGeneration) || cleanupFenceGeneration <= 0)) {
      throw new StoreDataError('cleanup recovery fence generation is invalid');
    }
    const cleanupLeaseStatus = persistedEnum(
      row,
      'cleanup_lease_status',
      ['admitted', 'claimed', 'completed', 'handed_back', 'failed', 'blocking', 'expired'],
    ) as RecoveryJobRecord['cleanupLeaseStatus'];
    const cleanupLeaseExpiresAt = nullableInstant(row, 'cleanup_lease_expires_at');
    const cleanupLeaseFenceGeneration = nullableNumber(row, 'cleanup_lease_fence_generation');
    if (cleanupFenceGeneration === null) {
      if (cleanupLeaseStatus !== null || cleanupLeaseExpiresAt !== null || cleanupLeaseFenceGeneration !== null) {
        throw new StoreDataError('unfenced recovery row unexpectedly joined a cleanup lease');
      }
    } else if (
      cleanupLeaseStatus === null
      || cleanupLeaseExpiresAt === null
      || cleanupLeaseFenceGeneration !== cleanupFenceGeneration
      || cleanupLeaseStatus === 'handed_back'
      || cleanupLeaseStatus === 'expired'
    ) {
      throw new StoreDataError('cleanup recovery lease does not match its active fence');
    }
    const cleanupBlockerCode = persistedEnum(row, 'cleanup_blocker_code', BUILDER_ERROR_CODES) as BuilderErrorCode | null;
    const cleanupBlocker = parseJsonObject(nullableString(row, 'cleanup_blocker_json'), 'cleanup_blocker_json');
    if ((cleanupBlockerCode === null) !== (cleanupBlocker === null)) {
      throw new StoreDataError('cleanup blocker evidence is incomplete');
    }
    const cleanupLeaseBlockerCode = persistedEnum(row, 'cleanup_lease_blocker_code', BUILDER_ERROR_CODES) as BuilderErrorCode | null;
    const cleanupLeaseBlocker = parseJsonObject(nullableString(row, 'cleanup_lease_blocker_json'), 'cleanup_lease_blocker_json');
    if ((cleanupLeaseBlockerCode === null) !== (cleanupLeaseBlocker === null)) {
      throw new StoreDataError('cleanup lease blocker evidence is incomplete');
    }
    if (
      cleanupLeaseStatus === 'failed' || cleanupLeaseStatus === 'blocking'
        ? cleanupLeaseBlockerCode === null
        : cleanupLeaseBlockerCode !== null
    ) {
      throw new StoreDataError('cleanup lease status and blocker evidence disagree');
    }
    if (
      cleanupLeaseStatus === 'failed' || cleanupLeaseStatus === 'blocking'
        ? cleanupBlockerCode !== cleanupLeaseBlockerCode
          || cleanupBlocker === null
          || cleanupLeaseBlocker === null
          || assertJsonObject(cleanupBlocker, 'cleanup blocker') !== assertJsonObject(cleanupLeaseBlocker, 'cleanup lease blocker')
        : false
    ) {
      throw new StoreDataError('cleanup job and lease blocker evidence disagree');
    }
    return {
      jobId: asString(row, 'job_id'),
      state: persistedEnum(row, 'state', JOB_STATES, false)! as JobState,
      queueState: persistedEnum(row, 'queue_state', QUEUE_STATES, false)!,
      queuePosition: queuePosition(row),
      terminalAt: nullableInstant(row, 'terminal_at'),
      terminalErrorCode: persistedEnum(row, 'terminal_error_code', BUILDER_ERROR_CODES) as BuilderErrorCode | null,
      terminalError: parseJsonObject(nullableString(row, 'terminal_error_json'), 'terminal_error_json'),
      cleanupFenceGeneration,
      cleanupAdmissionId,
      cleanupBlockerCode,
      cleanupBlocker,
      cleanupLeaseStatus,
      cleanupLeaseExpiresAt,
      cleanupLeaseBlockerCode,
      cleanupLeaseBlocker,
    };
  }

  getQueuePosition(jobId: string): number | null {
    const row = this.#db.prepare("SELECT COUNT(*) AS count FROM queue_entries q JOIN jobs j ON j.job_id = q.job_id WHERE q.fifo_seq < COALESCE((SELECT fifo_seq FROM queue_entries WHERE job_id = ?), -1) AND j.queue_state = 'queued'").get(jobId) as DbRow;
    const entry = this.#db.prepare("SELECT queue_state, queue_position FROM jobs WHERE job_id = ?").get(jobId) as DbRow | undefined;
    if (!entry) throw new StoreNotFoundError(`job not found: ${jobId}`);
    const queueState = persistedEnum(entry, 'queue_state', QUEUE_STATES, false)!;
    const persisted = queuePosition(entry);
    if (queueState !== 'queued') { if (persisted !== null) throw new StoreDataError('non-queued job contains a queue position'); return null; }
    const dynamic = Number(row.count);
    if (persisted === null || persisted !== dynamic) throw new StoreDataError('persisted queue position disagrees with FIFO position');
    return persisted;
  }

  getSourceIdentity(jobId: string): SourceIdentity {
    const job = this.getJob(jobId);
    if (!job.sourceRunnable || job.sourcePreparation === null || job.offlineFeedPreparation === null) {
      throw new StoreConflictError('persisted job source is legacy-unprepared and non-runnable');
    }
    return {
      sourceRemote: job.sourceRemote, sourceRef: job.sourceRef, sourceBranch: job.sourceBranch, branch: job.branch,
      expectedSha: job.expectedSha, pinnedSha: job.pinnedSha, sourceCommitTime: job.sourceCommitTime,
      sourcePreparation: job.sourcePreparation, offlineFeedPreparation: job.offlineFeedPreparation,
      sourceRunnable: true,
      sourceAuthor: job.sourceAuthor, sourceSubject: job.sourceSubject,
    };
  }

  getStage(jobId: string, stage: PipelineStageName): StoredStage | null {
    const row = this.#db.prepare('SELECT * FROM job_stages WHERE job_id = ? AND stage = ?').get(jobId, stage) as DbRow | undefined;
    return row ? this.#mapStage(row) : null;
  }

  getOperation(jobId: string, operationId: TrustedOperationId, attempt: number): StoredOperation | null {
    const row = this.#db.prepare('SELECT * FROM job_operations WHERE job_id = ? AND operation_id = ? AND attempt = ?').get(jobId, operationId, attempt) as DbRow | undefined;
    return row ? this.#mapOperation(row) : null;
  }

  getNextEventSequence(jobId: string): number {
    this.#requireJob(jobId);
    const row = this.#db.prepare('SELECT COALESCE(MAX(seq) + 1, 0) AS next_seq FROM job_events WHERE job_id = ?').get(jobId) as DbRow;
    return Number(row.next_seq);
  }

  listEvents(jobId: string, options: EventPageOptions = {}): EventPage {
    this.#requireJob(jobId);
    const afterSeq = options.afterSeq ?? -1;
    const limit = options.limit ?? EVENT_PAGE_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) throw new StoreValidationError('event cursor must be a safe integer greater than or equal to -1');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > EVENT_PAGE_MAX_LIMIT) throw new StoreValidationError(`event limit must be a safe integer between 1 and ${EVENT_PAGE_MAX_LIMIT}`);
    const rows = this.#db.prepare('SELECT job_id, seq, event_type, state, stage, payload_json, at, stream, file_generation, byte_offset, byte_length, partial FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(jobId, afterSeq, limit + 1) as unknown as DbRow[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map((row) => this.#mapEvent(row));
    return { events, nextAfterSeq: hasMore ? events.at(-1)?.seq ?? null : null };
  }

  getTerminalEvent(jobId: string): EventRecord | null {
    this.#requireJob(jobId);
    const rows = this.#db.prepare(
      `SELECT job_id, seq, event_type, state, stage, payload_json, at,
              stream, file_generation, byte_offset, byte_length, partial
       FROM job_events
       WHERE job_id = ? AND event_type = 'terminal'
       ORDER BY seq DESC
       LIMIT 2`,
    ).all(jobId) as unknown as DbRow[];
    if (rows.length > 1) throw new StoreDataError('job contains multiple terminal events');
    return rows.length === 0 ? null : this.#mapEvent(rows[0]!);
  }

  getCancellationProtocolEvents(jobId: string): readonly EventRecord[] {
    this.#requireJob(jobId);
    const rows = this.#db.prepare(
      CANCELLATION_PROTOCOL_EVENT_QUERY,
    ).all(jobId) as unknown as DbRow[];
    return rows.map((row) => this.#mapEvent(row));
  }

  #mapEvent(row: DbRow): EventRecord {
    const seq = Number(row.seq);
    if (!Number.isSafeInteger(seq) || seq < 0) throw new StoreDataError('SQLite event sequence is invalid');
    const eventType = persistedEnum(row, 'event_type', EVENT_TYPES, false)! as EventType;
    const state = persistedEnum(row, 'state', JOB_STATES) as JobState | null;
    const stage = persistedEnum(row, 'stage', PIPELINE_STAGE_NAMES) as PipelineStageName | null;
    const stream = persistedEnum(row, 'stream', ['runner', 'docker']);
    if (stream !== null) {
      const generation = nullableNumber(row, 'file_generation'); const offset = nullableNumber(row, 'byte_offset'); const length = nullableNumber(row, 'byte_length'); const partial = nullableNumber(row, 'partial');
      if (generation === null || offset === null || length === null || partial === null || !Number.isSafeInteger(generation) || generation < 0 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || (partial !== 0 && partial !== 1)) throw new StoreDataError('SQLite log event range is invalid');
      if (!['log', 'log_orphan_tail', 'log-gap', 'log-truncated'].includes(eventType)) throw new StoreDataError('SQLite log event type is invalid');
    } else if (row.file_generation !== null || row.byte_offset !== null || row.byte_length !== null || row.partial !== null) throw new StoreDataError('SQLite event log range nullable group is invalid');
    return {
      jobId: asString(row, 'job_id'),
      seq,
      eventType,
      state,
      stage,
      payload: parseJsonObject(asString(row, 'payload_json'), 'event payload') ?? {},
      at: canonicalInstant(asString(row, 'at'), 'event at'),
    };
  }

  #requireJob(jobId: string): DbRow {
    const row = this.#db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as DbRow | undefined;
    if (!row) throw new StoreNotFoundError(`job not found: ${jobId}`);
    return row;
  }

  #mapJob(row: DbRow): JobRecord {
    const state = persistedEnum(row, 'state', JOB_STATES, false)! as JobState;
    const publishState = persistedEnum(row, 'publish_state', PUBLISH_STATES) as PublishState | null;
    const freshnessStatus = persistedEnum(row, 'freshness_status', FRESHNESS_STATES) as FreshnessState | null;
    const pinnedSha = readHash(row, 'pinned_sha', HASH40)!;
    const sourcePreparation = persistedSourcePreparation(nullableString(row, 'source_preparation_json'), pinnedSha);
    const jobId = asString(row, 'job_id');
    const offlineFeedPreparation = persistedOfflineFeedPreparation(
      nullableString(row, 'offline_feed_preparation_json'),
      jobId,
      pinnedSha,
    );
    const sourceRunnable = sourcePreparation !== null && offlineFeedPreparation !== null;
    nullableGroup(row, ['preflight_sha', 'preflight_checked_at', 'preflight_expires_at'], 'preflight evidence');
    nullableGroup(row, ['cancel_requested_at', 'cancel_reason'], 'cancellation request');
    nullableGroup(row, [
      'cancellation_escalation_owner',
      'cancellation_escalation_lease_expires_at',
      'cancellation_stop_intent_at',
      'cancellation_grace_deadline_at',
    ], 'cancellation escalation');
    nullableGroup(row, [
      'cancellation_stop_authorized_at',
      'cancellation_stop_authorized_lease_expires_at',
    ], 'cancellation stop authorization');
    nullableGroup(row, ['dispatched_at', 'runner_unit'], 'dispatch evidence');
    nullableGroup(row, ['runner_lease_owner', 'runner_lease_expires_at'], 'runner lease');
    nullableGroup(row, ['container_id', 'container_name', 'container_image_digest', 'container_label_job_id', 'container_label_manifest_sha', 'container_labels_json', 'container_mount_json', 'container_env_json', 'container_security_json', 'container_inspection_json', 'container_created_at'], 'container identity');
    nullableGroup(row, ['artifact_sha256', 'artifact_size', 'artifact_mtime'], 'artifact evidence');
    nullableGroup(row, ['checksum_path', 'checksum_sha256'], 'checksum evidence');
    nullableGroup(row, ['manifest_path', 'manifest_sha256'], 'manifest evidence');
    nullableGroup(row, ['verification_path', 'verification_sha256'], 'verification evidence');
    nullableGroup(row, ['artifact_final_directory', 'artifact_final_path'], 'final artifact destination');
    nullableGroup(row, ['freshness_error_evidence_path', 'freshness_error_evidence_sha256'], 'freshness error evidence');
    nullableGroup(row, ['publish_blocker_code', 'publish_blocker_json'], 'publish blocker');
    nullableGroup(row, ['cleanup_blocker_code', 'cleanup_blocker_json'], 'cleanup blocker');
    const publishBlockerCode = persistedEnum(row, 'publish_blocker_code', BUILDER_ERROR_CODES) as BuilderErrorCode | null;
    const cleanupBlockerCode = persistedEnum(row, 'cleanup_blocker_code', BUILDER_ERROR_CODES) as BuilderErrorCode | null;
    const publishBlocker = parseJsonObject(nullableString(row, 'publish_blocker_json'), 'publish_blocker_json');
    const cleanupBlocker = parseJsonObject(nullableString(row, 'cleanup_blocker_json'), 'cleanup_blocker_json');
    const hasContainerIdentity = ['container_id', 'container_name', 'container_image_digest', 'container_label_job_id', 'container_label_manifest_sha', 'container_labels_json'].some((key) => row[key] !== null && row[key] !== undefined);
    if (!hasContainerIdentity && row.container_cleanup_outcome !== null && row.container_cleanup_outcome !== undefined) throw new StoreDataError('container cleanup outcome has no container identity');
    if (state === 'succeeded') {
      if (row.terminal_at === null || row.terminal_error_code !== null || row.terminal_error_json !== null) throw new StoreDataError('succeeded terminal evidence is invalid');
    } else if (['failed', 'cancelled', 'interrupted'].includes(state)) {
      if (row.terminal_at === null || row.terminal_error_code === null || row.terminal_error_json === null) throw new StoreDataError('failed terminal evidence is invalid');
    } else if (row.terminal_at !== null || row.terminal_error_code !== null || row.terminal_error_json !== null) {
      throw new StoreDataError('non-terminal state contains terminal evidence');
    }
    if (freshnessStatus === null) {
      if (row.freshness_observed_sha !== null || row.newer_source_available !== null || row.freshness_checked_at !== null || row.freshness_error_code !== null || row.freshness_error_json !== null || row.freshness_error_evidence_path !== null || row.freshness_error_evidence_sha256 !== null) throw new StoreDataError('null freshness status contains result evidence');
    } else if (row.freshness_requested_at === null || row.freshness_checked_at === null) {
      throw new StoreDataError('freshness result is missing request or check time');
    }
    if (freshnessStatus === 'fresh' && (row.newer_source_available !== 0 || row.freshness_observed_sha !== row.pinned_sha || row.freshness_error_code !== null || row.freshness_error_json !== null || row.freshness_error_evidence_path !== null || row.freshness_error_evidence_sha256 !== null)) throw new StoreDataError('fresh freshness evidence is incoherent');
    if (freshnessStatus === 'advanced' && (row.newer_source_available !== 1 || row.freshness_observed_sha === null || row.freshness_error_code !== null || row.freshness_error_json !== null)) throw new StoreDataError('advanced freshness evidence is incoherent');
    if (freshnessStatus === 'unknown' && (row.newer_source_available !== 0 || row.freshness_observed_sha !== null || row.freshness_error_code !== 'FRESHNESS_UNKNOWN' || row.freshness_error_json === null)) throw new StoreDataError('unknown freshness evidence is incoherent');
    const publishFields = ['artifact_staging_path', 'artifact_quarantine_path', 'artifact_quarantine_intent_path', 'artifact_final_directory', 'artifact_final_path', 'artifact_sha256', 'artifact_size', 'artifact_mtime', 'checksum_path', 'checksum_sha256', 'manifest_path', 'manifest_sha256', 'verification_path', 'verification_sha256', 'publish_started_at', 'published_at', 'publish_blocker_code', 'publish_blocker_json'];
    const hasAnyPublish = publishFields.some((key) => row[key] !== null && row[key] !== undefined);
    const artifactComplete = ['artifact_sha256', 'artifact_size', 'artifact_mtime', 'checksum_path', 'checksum_sha256', 'manifest_path', 'manifest_sha256', 'verification_path', 'verification_sha256'].every((key) => row[key] !== null && row[key] !== undefined);
    const noPublishBlocker = publishBlockerCode === null && publishBlocker === null;
    if (publishState === null) {
      if (hasAnyPublish) throw new StoreDataError('null publish state contains publish evidence');
    } else if (publishState === 'not_started') {
      const plannedPreparation = artifactComplete
        && row.artifact_staging_path !== null
        && row.artifact_quarantine_path === null
        && row.artifact_quarantine_intent_path === null
        && row.artifact_final_directory === null
        && row.artifact_final_path === null
        && row.publish_started_at === null
        && row.published_at === null
        && noPublishBlocker;
      if (hasAnyPublish && !plannedPreparation) {
        throw new StoreDataError('not_started publish state contains incomplete preparation ownership');
      }
    } else if (publishState === 'staged') {
      if (!artifactComplete || row.artifact_staging_path === null || row.artifact_quarantine_path !== null || row.artifact_quarantine_intent_path !== null || row.artifact_final_directory !== null || row.artifact_final_path !== null || row.publish_started_at !== null || row.published_at !== null || !noPublishBlocker) throw new StoreDataError('staged publish state evidence is incoherent');
    } else if (publishState === 'publishing') {
      const quarantineIntent = persistedRelativePath(row, 'artifact_quarantine_intent_path');
      if (!artifactComplete || row.artifact_staging_path === null || row.artifact_quarantine_path !== null || (quarantineIntent !== null && quarantineIntent !== `.osi-image-builder/quarantine/${jobId}`) || row.artifact_final_directory === null || row.artifact_final_path === null || row.publish_started_at === null || row.published_at !== null || !noPublishBlocker) throw new StoreDataError('publishing state evidence is incoherent');
    } else if (publishState === 'published') {
      if (!artifactComplete || row.artifact_staging_path !== null || row.artifact_quarantine_path !== null || row.artifact_quarantine_intent_path !== null || row.artifact_final_directory === null || row.artifact_final_path === null || row.publish_started_at === null || row.published_at === null || !noPublishBlocker) throw new StoreDataError('published state evidence is incoherent');
    } else if (publishState === 'quarantined') {
      const artifactAbsent = ['artifact_sha256', 'artifact_size', 'artifact_mtime', 'checksum_path', 'checksum_sha256', 'manifest_path', 'manifest_sha256', 'verification_path', 'verification_sha256'].every((key) => row[key] === null || row[key] === undefined);
      if (row.artifact_staging_path !== null || row.artifact_quarantine_path === null || row.artifact_quarantine_intent_path !== null || row.artifact_final_directory !== null || row.artifact_final_path !== null || row.publish_started_at !== null || row.published_at !== null || !noPublishBlocker || (!artifactAbsent && !artifactComplete)) throw new StoreDataError('quarantined publish state evidence is incoherent');
    } else if (publishState === 'blocked') {
      const stagingDisposition = publishBlocker?.['staging'];
      const stagingRetained = row.artifact_staging_path !== null && row.artifact_quarantine_path === null
        && (stagingDisposition === undefined || stagingDisposition === 'present' || stagingDisposition === 'unknown');
      const stagingAbsent = row.artifact_staging_path === null && row.artifact_quarantine_path === null
        && stagingDisposition === 'absent';
      const quarantine = publishBlocker?.['quarantine'];
      const quarantineRecord = quarantine !== null
        && typeof quarantine === 'object'
        && !Array.isArray(quarantine)
        ? quarantine as JsonObject
        : null;
      const stagingQuarantined = row.artifact_staging_path === null && row.artifact_quarantine_path !== null
        && stagingDisposition === 'quarantined'
        && quarantineRecord?.['quarantined'] === true
        && quarantineRecord['renameResult'] === 'RENAMED'
        && quarantineRecord['destinationRelativePath'] === row.artifact_quarantine_path;
      if (!artifactComplete || row.artifact_quarantine_intent_path !== null || (!stagingRetained && !stagingAbsent && !stagingQuarantined) || row.artifact_final_directory !== null || row.artifact_final_path !== null || row.publish_started_at !== null || row.published_at !== null || publishBlockerCode === null || publishBlocker === null) throw new StoreDataError('blocked publish state evidence is incoherent');
    }
    if ((cleanupBlockerCode === null) !== (cleanupBlocker === null)) throw new StoreDataError('cleanup blocker evidence is incomplete');
    if (cleanupBlockerCode !== null && !['starting', 'preflight', 'source', 'release_gates', 'frontend', 'target_setup', 'feeds', 'config', 'building', 'verifying', 'cancel_requested', 'interrupted'].includes(state)) throw new StoreDataError('cleanup blocker is invalid for terminal state');
    if (row.queue_position !== null && row.queue_state !== 'queued') throw new StoreDataError('non-queued job contains a queue position');
    return {
      jobId, requestId: asString(row, 'request_id'), request: parseJsonObject(nullableString(row, 'request_json'), 'request_json'),
      sourceRemote: asString(row, 'source_remote'), sourceRef: asString(row, 'source_ref'), sourceBranch: asString(row, 'source_branch'), branch: asString(row, 'branch'),
      expectedSha: readHash(row, 'expected_sha', HASH40)!, pinnedSha, sourcePreparation, offlineFeedPreparation, sourceRunnable,
      targetId: persistedEnum(row, 'target_id', TARGET_IDS, false)! as TargetId, rootId: asString(row, 'root_id'),
      targetManifestSha256: readHash(row, 'target_manifest_sha256', HASH64)!, sourceCommitTime: canonicalInstant(asString(row, 'source_commit_time'), 'source_commit_time'), sourceAuthor: asString(row, 'source_author'), sourceSubject: asString(row, 'source_subject'),
      acceptedAt: canonicalInstant(asString(row, 'accepted_at'), 'accepted_at'), state, currentStage: persistedEnum(row, 'current_stage', PIPELINE_STAGE_NAMES) as PipelineStageName | null,
      queueState: persistedEnum(row, 'queue_state', QUEUE_STATES, false)!, queuePosition: queuePosition(row), cancelRequestedAt: nullableInstant(row, 'cancel_requested_at'), cancelReason: nullableString(row, 'cancel_reason'),
      cancellationCooperativeDeadlineAt: nullableInstant(row, 'cancellation_cooperative_deadline_at'),
      cancellationEscalationOwner: nullableString(row, 'cancellation_escalation_owner'),
      cancellationEscalationLeaseExpiresAt: nullableInstant(row, 'cancellation_escalation_lease_expires_at'),
      cancellationStopIntentAt: nullableInstant(row, 'cancellation_stop_intent_at'),
      cancellationGraceDeadlineAt: nullableInstant(row, 'cancellation_grace_deadline_at'),
      cancellationSignalObservation: parseJsonObject(nullableString(row, 'cancellation_signal_observation_json'), 'cancellation_signal_observation_json'),
      cancellationStopObservation: parseJsonObject(nullableString(row, 'cancellation_stop_observation_json'), 'cancellation_stop_observation_json'),
      cancellationInspectionObservations: parseJsonObject(nullableString(row, 'cancellation_inspection_observations_json'), 'cancellation_inspection_observations_json'),
      cancellationClockHighWaterAt: nullableInstant(row, 'cancellation_clock_high_water_at'),
      cancellationStopAuthorizedAt: nullableInstant(row, 'cancellation_stop_authorized_at'),
      cancellationStopAuthorizedLeaseExpiresAt: nullableInstant(row, 'cancellation_stop_authorized_lease_expires_at'),
      dispatchedAt: nullableInstant(row, 'dispatched_at'), runnerUnit: nullableString(row, 'runner_unit'), runnerLeaseOwner: nullableString(row, 'runner_lease_owner'), runnerLeaseExpiresAt: nullableInstant(row, 'runner_lease_expires_at'),
      containerId: nullableString(row, 'container_id'), containerName: nullableString(row, 'container_name'), containerImageDigest: nullableString(row, 'container_image_digest'), containerLabelJobId: nullableString(row, 'container_label_job_id'), containerLabelManifestSha: nullableString(row, 'container_label_manifest_sha'),
      containerLabels: parseJsonObject(nullableString(row, 'container_labels_json'), 'container_labels_json'), containerMount: parseJsonObject(nullableString(row, 'container_mount_json'), 'container_mount_json'), containerEnvironment: parseJsonObject(nullableString(row, 'container_env_json'), 'container_env_json'), containerSecurity: parseJsonObject(nullableString(row, 'container_security_json'), 'container_security_json'), containerInspection: parseJsonObject(nullableString(row, 'container_inspection_json'), 'container_inspection_json'),
      containerCreatedAt: nullableInstant(row, 'container_created_at'), containerStartedAt: nullableInstant(row, 'container_started_at'), containerStoppedAt: nullableInstant(row, 'container_stopped_at'), containerRemovedAt: nullableInstant(row, 'container_removed_at'), containerCleanupOutcome: persistedEnum(row, 'container_cleanup_outcome', ['passed', 'failed', 'blocking']) as 'passed' | 'failed' | 'blocking' | null,
      cleanupBlockerCode, cleanupBlocker,
      terminalErrorCode: persistedEnum(row, 'terminal_error_code', BUILDER_ERROR_CODES) as BuilderErrorCode | null, terminalError: parseJsonObject(nullableString(row, 'terminal_error_json'), 'terminal_error_json'), terminalAt: nullableInstant(row, 'terminal_at'),
      artifactStagingPath: persistedRelativePath(row, 'artifact_staging_path'), artifactQuarantinePath: persistedRelativePath(row, 'artifact_quarantine_path'), artifactQuarantineIntentPath: persistedRelativePath(row, 'artifact_quarantine_intent_path'), artifactFinalDirectory: persistedRelativePath(row, 'artifact_final_directory'), artifactFinalPath: persistedRelativePath(row, 'artifact_final_path'), artifactSha256: readHash(row, 'artifact_sha256', HASH64), artifactSize: nullableNumber(row, 'artifact_size'), artifactMtime: nullableInstant(row, 'artifact_mtime'), checksumPath: persistedRelativePath(row, 'checksum_path'), checksumSha256: readHash(row, 'checksum_sha256', HASH64), manifestPath: persistedRelativePath(row, 'manifest_path'), manifestSha256: readHash(row, 'manifest_sha256', HASH64), verificationPath: persistedRelativePath(row, 'verification_path'), verificationSha256: readHash(row, 'verification_sha256', HASH64), publishState, publishStartedAt: nullableInstant(row, 'publish_started_at'), publishedAt: nullableInstant(row, 'published_at'), publishBlockerCode, publishBlocker,
      freshnessStatus, freshnessObservedSha: readHash(row, 'freshness_observed_sha', HASH40), newerSourceAvailable: row.newer_source_available === null || row.newer_source_available === undefined ? null : (() => { const value = Number(row.newer_source_available); if (value !== 0 && value !== 1) throw new StoreDataError('SQLite newer_source_available is invalid'); return value === 1; })(), freshnessRequestedAt: nullableInstant(row, 'freshness_requested_at'), freshnessCheckedAt: nullableInstant(row, 'freshness_checked_at'), freshnessErrorCode: persistedEnum(row, 'freshness_error_code', BUILDER_ERROR_CODES) as BuilderErrorCode | null, freshnessError: parseJsonObject(nullableString(row, 'freshness_error_json'), 'freshness_error_json'), freshnessErrorEvidencePath: persistedRelativePath(row, 'freshness_error_evidence_path'), freshnessErrorEvidenceSha256: readHash(row, 'freshness_error_evidence_sha256', HASH64),
    };
  }

  #mapStage(row: DbRow): StoredStage {
    const outcome = persistedEnum(row, 'outcome', STAGE_OUTCOMES) as StageOutcome | null;
    nullableGroup(row, ['evidence_path', 'evidence_sha256'], 'stage evidence');
    nullableGroup(row, ['error_code', 'error_json'], 'stage error');
    if (outcome === null && ['started_at', 'finished_at', 'evidence_path', 'evidence_sha256', 'error_code', 'error_json'].some((key) => row[key] !== null && row[key] !== undefined)) throw new StoreDataError('empty stage contains evidence');
    if (outcome !== null && row.started_at === null) throw new StoreDataError('stage outcome is missing its start time');
    if (outcome === 'running' && ['finished_at', 'evidence_path', 'evidence_sha256', 'error_code', 'error_json'].some((key) => row[key] !== null && row[key] !== undefined)) throw new StoreDataError('running stage contains completion evidence');
    if (outcome !== null && outcome !== 'running' && (row.finished_at === null || row.evidence_path === null || row.evidence_sha256 === null)) throw new StoreDataError('terminal stage is missing evidence');
    if (['failed', 'cancelled', 'interrupted'].includes(outcome ?? '') && (row.error_code === null || row.error_json === null)) throw new StoreDataError('failed stage is missing error evidence');
    if (outcome === 'passed' && (row.error_code !== null || row.error_json !== null)) throw new StoreDataError('passed stage contains error evidence');
    return {
      jobId: asString(row, 'job_id'), stage: persistedEnum(row, 'stage', PIPELINE_STAGE_NAMES, false)! as PipelineStageName,
      outcome, startedAt: nullableInstant(row, 'started_at'),
      finishedAt: nullableInstant(row, 'finished_at'), evidencePath: persistedRelativePath(row, 'evidence_path'),
      evidenceSha256: readHash(row, 'evidence_sha256', HASH64), errorCode: persistedEnum(row, 'error_code', BUILDER_ERROR_CODES) as BuilderErrorCode | null,
      error: parseJsonObject(nullableString(row, 'error_json'), 'stage error'),
    };
  }

  #mapOperation(row: DbRow): StoredOperation {
    const attempt = requiredInteger(row, 'attempt', 'operation attempt');
    if (attempt < 1) throw new StoreDataError('operation attempt is invalid');
    const lifecyclePhase = persistedEnum(row, 'lifecycle_phase', LIFECYCLE_PHASES, false)! as LifecyclePhase;
    const outcome = persistedEnum(row, 'outcome', ['passed', 'failed', 'accepted']) as 'passed' | 'failed' | 'accepted' | null;
    const acceptedDisposition = persistedEnum(
      row,
      'accepted_disposition',
      ['expected-rootfs-already-present'],
    ) as 'expected-rootfs-already-present' | null;
    nullableGroup(row, ['container_id', 'container_name', 'container_image_digest', 'container_label_job_id', 'container_label_manifest_sha', 'container_mount_json', 'container_env_json', 'container_security_json', 'inspection_json'], 'operation container evidence');
    nullableGroup(row, ['evidence_path', 'evidence_sha256'], 'operation evidence');
    nullableGroup(row, ['error_code', 'error_json'], 'operation error');
    if (lifecyclePhase === 'not_created' && ['container_id', 'container_name', 'container_image_digest', 'container_label_job_id', 'container_label_manifest_sha', 'container_mount_json', 'container_env_json', 'container_security_json', 'inspection_json'].some((key) => row[key] !== null && row[key] !== undefined)) throw new StoreDataError('pre-container operation contains container evidence');
    if (lifecyclePhase !== 'not_created' && ['container_id', 'container_name', 'container_image_digest', 'container_label_job_id', 'container_label_manifest_sha', 'container_mount_json', 'container_env_json', 'container_security_json', 'inspection_json'].some((key) => row[key] === null || row[key] === undefined)) throw new StoreDataError('container operation is missing identity evidence');
    if (outcome === null && ['finished_at', 'accepted_disposition', 'evidence_path', 'evidence_sha256', 'error_code', 'error_json'].some((key) => row[key] !== null && row[key] !== undefined)) throw new StoreDataError('incomplete operation contains result evidence');
    if (outcome !== null && (row.finished_at === null || row.evidence_path === null || row.evidence_sha256 === null)) throw new StoreDataError('completed operation is missing result evidence');
    if (outcome === 'passed' && (row.error_code !== null || row.error_json !== null)) throw new StoreDataError('passed operation contains error evidence');
    if (
      outcome === 'accepted'
      && (
        acceptedDisposition !== 'expected-rootfs-already-present'
        || row.operation_id !== 'activate-target'
        || Number(row.exit_code) !== 2
        || row.signal !== null
        || Number(row.timed_out) !== 0
        || row.error_code !== null
        || row.error_json !== null
      )
    ) {
      throw new StoreDataError('accepted operation evidence is incoherent');
    }
    if (outcome !== 'accepted' && acceptedDisposition !== null) throw new StoreDataError('operation disposition has no accepted outcome');
    if (outcome === 'failed' && (row.error_code === null || row.error_json === null)) throw new StoreDataError('failed operation is missing error evidence');
    return {
      jobId: asString(row, 'job_id'), operationId: persistedEnum(row, 'operation_id', TRUSTED_OPERATION_IDS, false)! as TrustedOperationId, attempt, argvHash: readHash(row, 'argv_hash', HASH64)!,
      argv: parseJsonArray(asString(row, 'argv_json'), 'operation argv_json'), startedAt: canonicalInstant(asString(row, 'started_at'), 'operation started_at'), finishedAt: nullableInstant(row, 'finished_at'),
      containerId: nullableString(row, 'container_id'), containerName: nullableString(row, 'container_name'), containerImageDigest: nullableString(row, 'container_image_digest'),
      containerLabelJobId: nullableString(row, 'container_label_job_id'), containerLabelManifestSha: nullableString(row, 'container_label_manifest_sha'),
      containerMount: parseJsonObject(nullableString(row, 'container_mount_json'), 'operation mount'), containerEnvironment: parseJsonObject(nullableString(row, 'container_env_json'), 'operation environment'),
      containerSecurity: parseJsonObject(nullableString(row, 'container_security_json'), 'operation security'), inspection: parseJsonObject(nullableString(row, 'inspection_json'), 'operation inspection'),
      timedOut: (() => { const value = Number(row.timed_out); if (value !== 0 && value !== 1) throw new StoreDataError('SQLite operation timed_out is invalid'); return value === 1; })(), lifecyclePhase, exitCode: nullableNumber(row, 'exit_code'), signal: nullableString(row, 'signal'),
      outcome, acceptedDisposition, evidencePath: persistedRelativePath(row, 'evidence_path'), evidenceSha256: readHash(row, 'evidence_sha256', HASH64),
      errorCode: persistedEnum(row, 'error_code', BUILDER_ERROR_CODES) as BuilderErrorCode | null, error: parseJsonObject(nullableString(row, 'error_json'), 'operation error'),
    };
  }
}
