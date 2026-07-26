import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  ACTIVE_RECOVERY_STATES,
  STATE_TRANSITIONS,
  TARGET_IDS,
  BUILDER_ERROR_CODES,
  JOB_STATES,
  PIPELINE_STAGE_NAMES,
  type ActiveRecoveryState,
  type BuilderErrorCode,
  type JobState,
  type PipelineStageName,
  TRUSTED_OPERATION_IDS,
  type TrustedOperationId,
} from '../../domain/types.js';
import { encodeSourcePreparation, type ArtifactInput, type CreateJobInput, type FreshnessInput, type JsonObject, type JsonValue, type OperationInput } from './store.js';
import { TEXT_LIMITS, boundedText, canonicalInstant as sharedCanonicalInstant, encodeJson, normalizeCommand, normalizeJson, requireChronology as sharedRequireChronology, SharedValidationError } from './validation.js';

const HASH64 = /^[0-9a-f]{64}$/;
const ADMISSION_ID = /^cln_[0-9a-hj-km-np-tv-z]{26}$/;
const EVENT_TYPES = new Set(['enqueue', 'dispatch', 'cancellation_requested', 'state', 'stage', 'operation', 'container', 'artifact', 'publish', 'terminal', 'cleanup_admission', 'cleanup_claim', 'cleanup_renew', 'cleanup_complete', 'cleanup', 'recovery', 'freshness']);
const ACTIVE_STATES = new Set<JobState>(ACTIVE_RECOVERY_STATES);
const ACTIVE_RECOVERY_STATE_SQL = ACTIVE_RECOVERY_STATES.map((state) => `'${state}'`).join(',');
const RUNNER_LEASE_RENEWABLE_STATES = Object.freeze([...ACTIVE_RECOVERY_STATES, 'publishing'] as const);
const RUNNER_LEASE_RENEWABLE_STATE_SQL = RUNNER_LEASE_RENEWABLE_STATES.map((state) => `'${state}'`).join(',');
export const MAX_QUEUE_LENGTH = 50;
const STAGE_STATE: Readonly<Record<PipelineStageName, JobState>> = Object.freeze({
  preflight: 'preflight', source: 'source', 'release-gates': 'release_gates', frontend: 'frontend',
  'target-setup': 'target_setup', feeds: 'feeds', config: 'config', build: 'building', verify: 'verifying', publish: 'publishing',
});

type Row = Record<string, string | number | null>;
type JsonInput = JsonObject | null | undefined;

type DbStatement = Readonly<{
  readonly run: (...parameters: any[]) => any;
  readonly get: (...parameters: any[]) => any;
  readonly all: (...parameters: any[]) => any[];
}>;
type DbFacade = Readonly<{
  readonly exec: (sql: string) => unknown;
  readonly prepare: (sql: string) => DbStatement;
}>;
const TRUSTED_DB_ERROR = new WeakSet<object>();

function markDbError(error: unknown): never {
  if (typeof error === 'object' && error !== null) TRUSTED_DB_ERROR.add(error);
  throw error;
}

function taggedDbCall<T>(work: () => T): T {
  try { return work(); } catch (error) { return markDbError(error); }
}

function dbFacade(db: DatabaseSync): DbFacade {
  return {
    exec: (sql) => taggedDbCall(() => db.exec(sql)),
    prepare: (sql) => {
      const statement = taggedDbCall(() => db.prepare(sql));
      return {
        run: (...parameters) => taggedDbCall(() => statement.run(...parameters)),
        get: (...parameters) => taggedDbCall(() => statement.get(...parameters)),
        all: (...parameters) => taggedDbCall(() => statement.all(...parameters)),
      };
    },
  };
}

function isTaggedDbError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && TRUSTED_DB_ERROR.has(error);
}

export type OwnershipConflictKind =
  | 'stale-predecessor' | 'stale-runner-owner' | 'stale-lease' | 'fenced' | 'admission-mismatch'
  | 'token-mismatch' | 'generation-mismatch' | 'identity-mismatch' | 'illegal-predecessor' | 'cas-lost' | 'queue-full';

export class OwnershipConflictError extends Error {
  readonly kind: OwnershipConflictKind;
  rollbackCause?: unknown;

  constructor(kind: OwnershipConflictKind, message: string = kind, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OwnershipConflictError';
    this.kind = kind;
  }
}

export class OwnershipViolationError extends Error {
  readonly actor: 'api' | 'runner' | 'cleanup-worker';
  readonly command: string;

  constructor(actor: 'api' | 'runner' | 'cleanup-worker', command: unknown) {
    super(`${actor} is not allowed to perform ${String(command)}`);
    this.name = 'OwnershipViolationError';
    this.actor = actor;
    this.command = String(command);
  }
}

export class OwnershipValidationError extends Error {
  rollbackCause?: unknown;
  constructor(message: string, options?: ErrorOptions & { rollbackCause?: unknown }) {
    super(message, options);
    this.name = 'OwnershipValidationError';
    this.rollbackCause = options?.rollbackCause;
  }
}

export class OwnershipTransactionError extends Error {
  rollbackCause?: unknown;
  constructor(message: string, options?: ErrorOptions & { rollbackCause?: unknown }) {
    super(message, options);
    this.name = 'OwnershipTransactionError';
    this.rollbackCause = options?.rollbackCause;
  }
}

export type OwnershipResult<T = void> =
  | { readonly ok: true; readonly kind: 'committed'; readonly eventSeq: number; readonly value: T }
  | { readonly ok: true; readonly kind: 'idempotent'; readonly value: T }
  | { readonly ok: false; readonly conflict: { readonly kind: OwnershipConflictKind; readonly message: string; readonly rollbackCause?: unknown } };

export type StagingCleanupProof =
  | Readonly<{ readonly kind: 'absent'; readonly path: null }>
  | Readonly<{ readonly kind: 'quarantined'; readonly sourcePath: string; readonly destinationPath: string; readonly sourceAbsent: true; readonly destinationPresent: true; readonly sha256: string; readonly size: number; readonly verifiedAt: string }>;

export type LogCleanupProof = Readonly<{ readonly runner: 'absent' | 'sealed'; readonly docker: 'absent' | 'sealed'; readonly verifiedAt: string }>;
export type LogCleanupSnapshot = Readonly<{ readonly runner: 'absent' | 'sealed' | 'unsealed'; readonly docker: 'absent' | 'sealed' | 'unsealed'; readonly verifiedAt: string }>;

export type DirectLogGeneration = Readonly<{ readonly generation: number; readonly path: string; readonly startedAt: string }>;
type LogGenerationIdentity = DirectLogGeneration;
type PersistedLogCleanupSnapshot = LogCleanupSnapshot & Readonly<{ readonly generationIdentity: Readonly<{ readonly runner: readonly LogGenerationIdentity[]; readonly docker: readonly LogGenerationIdentity[] }> }>;
type PersistedCleanupSnapshot = Omit<CleanupSnapshot, 'logs'> & Readonly<{ readonly logs: PersistedLogCleanupSnapshot }>;

export type CleanupStagingSnapshot =
  | Readonly<{ readonly kind: 'absent'; readonly path: null }>
  | Readonly<{ readonly kind: 'present'; readonly path: string; readonly sha256: string; readonly size: number }>;

type NullContainerProof = Readonly<{ readonly kind: 'absent'; readonly globalLabelResult: 'no-match'; readonly observedAt: string }>;

export type DirectInterruptionProof =
  | Readonly<{ readonly kind: 'start-failure'; readonly runnerUnit: string; readonly startAttemptedAt: string; readonly unitInactiveAt: string; readonly runnerLeaseOwner: null; readonly runnerLeaseExpiresAt: null; readonly container: NullContainerProof; readonly staging: Readonly<{ readonly kind: 'absent'; readonly path: null }>; readonly logs: DirectLogProof; readonly blocker: 'none'; readonly cleanupAdmission: null; readonly cleanupFence: null }>
  | Readonly<{ readonly kind: 'active'; readonly runnerUnit: string; readonly runnerLeaseOwner: string; readonly runnerLeaseExpiresAt: string; readonly leaseStaleAt: string; readonly unitInactiveAt: string; readonly container: NullContainerProof; readonly staging: Readonly<{ readonly kind: 'absent'; readonly path: null }>; readonly logs: DirectLogProof; readonly blocker: 'none'; readonly cleanupAdmission: null; readonly cleanupFence: null }>;

export type DirectLogProof = Readonly<{
  readonly runner: 'absent' | 'sealed';
  readonly docker: 'absent' | 'sealed';
  readonly verifiedAt: string;
  readonly generationIdentity: Readonly<{ readonly runner: readonly DirectLogGeneration[]; readonly docker: readonly DirectLogGeneration[] }>;
}>;

export type CancellationProof =
  | Readonly<{ readonly kind: 'pre-container'; readonly runnerUnit: string; readonly unitInactiveAt: string; readonly container: NullContainerProof; readonly staging: StagingCleanupProof; readonly logs: LogCleanupProof }>
  | Readonly<{ readonly kind: 'container'; readonly runnerUnit: string; readonly unitInactiveAt: string; readonly container: Readonly<{ readonly kind: 'removed'; readonly id: string; readonly name: string; readonly imageDigest: string; readonly labels: JsonObject; readonly stoppedAt: string; readonly removedAt: string; readonly globalLabelResult: 'no-match'; readonly observedAt: string }>; readonly staging: StagingCleanupProof; readonly logs: LogCleanupProof }>;

export type CleanupSnapshot = Readonly<{
  readonly runner: Readonly<{ readonly unit: string; readonly owner: string | null; readonly leaseExpiresAt: string | null; readonly inactiveAt: string; readonly observedAt: string }>;
  readonly state: ActiveRecoveryState | 'interrupted';
  readonly container: NullContainerProof | Readonly<{ readonly kind: 'present'; readonly id: string; readonly name: string; readonly imageDigest: string; readonly labels: JsonObject; readonly globalLabelResult: 'single-exact-match'; readonly observedAt: string }>;
  readonly staging: CleanupStagingSnapshot;
  readonly logs: LogCleanupSnapshot;
  readonly blocker: 'none' | 'staging-or-log';
}>;

export type CleanupPostContainer =
  | Readonly<{ readonly kind: 'removed'; readonly id: string; readonly name: string; readonly imageDigest: string; readonly labels: JsonObject; readonly exactIdAbsent: true; readonly globalLabelResult: 'no-match'; readonly stoppedAt: string; readonly removedAt: string; readonly observedAt: string }>
  | Readonly<{ readonly kind: 'null-identity'; readonly dockerAction: 'none'; readonly globalLabelResult: 'no-match'; readonly observedAt: string }>;

export type CleanupPostcondition = Readonly<{
  readonly runner: CleanupSnapshot['runner'];
  readonly state: CleanupSnapshot['state'];
  readonly container: CleanupPostContainer;
  readonly staging: StagingCleanupProof;
  readonly logs: LogCleanupProof;
  readonly blocker: 'none';
}>;

export type PublishRecoveryEvidence = Readonly<{
  readonly runner: Readonly<{ readonly unit: string; readonly owner: string; readonly leaseExpiresAt: string; readonly inactiveAt: string; readonly observedAt: string }>;
  readonly container: NullContainerProof;
  readonly artifact: Readonly<Pick<ArtifactInput, 'stagingPath' | 'artifactSha256' | 'artifactSize' | 'artifactMtime' | 'checksumPath' | 'checksumSha256' | 'manifestPath' | 'manifestSha256' | 'verificationPath' | 'verificationSha256'>>;
  readonly final: Readonly<{ readonly directory: string; readonly path: string; readonly publishStartedAt: string; readonly publishedAt: string | null }>;
  readonly observed: Readonly<{
    readonly final: Readonly<{ readonly present: boolean; readonly path: string; readonly held: boolean; readonly size: number | null; readonly sha256: string | null }>;
    readonly checksum: Readonly<{ readonly present: boolean; readonly path: string; readonly contents: string | null; readonly sha256: string | null }>;
    readonly manifest: Readonly<{ readonly present: boolean; readonly path: string; readonly bytes: string | null; readonly content: JsonObject | null; readonly sha256: string | null }>;
    readonly verification: Readonly<{ readonly present: boolean; readonly path: string; readonly bytes: string | null; readonly content: JsonObject | null; readonly sha256: string | null }>;
    readonly staging: Readonly<{ readonly state: 'present' | 'absent'; readonly path: string | null; readonly sha256: string | null }>;
    readonly logs: Readonly<{ readonly runner: 'sealed'; readonly docker: 'sealed'; readonly verifiedAt: string; readonly noGap: true }>;
  }>;
}>;

export type OperationCleanupProof =
  | Readonly<{ readonly kind: 'null-identity'; readonly container: NullContainerProof; readonly logs: LogCleanupProof }>
  | Readonly<{ readonly kind: 'container-removed'; readonly id: string; readonly name: string; readonly imageDigest: string; readonly labels: JsonObject; readonly stoppedAt: string; readonly removedAt: string; readonly observedAt: string; readonly globalLabelResult: 'no-match'; readonly logs: LogCleanupProof }>;

export type HandBackProof = Readonly<{ readonly runner: Readonly<{ readonly unit: string; readonly owner: string | null; readonly leaseExpiresAt: string | null; readonly inactiveAt: string; readonly observedAt: string }>; readonly container: NullContainerProof; readonly blocker: 'none' }>;

type CommonRunner = Readonly<{ jobId: string; owner: string; runnerUnit: string; leaseExpiresAt: string; at: string }>;

export type ApiWriteCommand =
  | Readonly<{ kind: 'enqueue'; input: CreateJobInput }>
  | Readonly<{ kind: 'dispatch'; jobId: string; runnerUnit: string; at: string }>
  | Readonly<{ kind: 'request-cancellation'; jobId: string; reason: string; at: string; error?: JsonInput }>
  | Readonly<{ kind: 'freshness-request'; jobId: string; at: string }>
  | Readonly<{ kind: 'freshness-result'; jobId: string; input: FreshnessInput; at: string }>
  | Readonly<{ kind: 'direct-interrupt'; jobId: string; expectedState: ActiveRecoveryState; at: string; proof: DirectInterruptionProof; errorCode: BuilderErrorCode; error: JsonObject }>
  | Readonly<{ kind: 'publish-recovery'; jobId: string; expectedState: 'publishing'; at: string; state: 'succeeded' | 'failed'; evidence: PublishRecoveryEvidence; errorCode?: BuilderErrorCode; error?: JsonObject }>
  | Readonly<{ kind: 'cleanup-admission'; jobId: string; admissionId: string; owner: string; unitName: string; expiresAt: string; credentialRelativePath: string; credentialSha256: string; fenceTokenHash: string; snapshot: CleanupSnapshot; at: string }>
  | Readonly<{ kind: 'hand-back'; jobId: string; admissionId: string; owner: string; unitName: string; fenceGeneration: number; fenceTokenHash: string; at: string; proof: HandBackProof }>;

export type RunnerWriteCommand =
  | Readonly<{ kind: 'acquire-lease'; jobId: string; runnerUnit: string; owner: string; expiresAt: string; at: string }>
  | Readonly<{ kind: 'renew-lease'; jobId: string; runnerUnit: string; owner: string; expectedExpiresAt: string; expiresAt: string; at: string }>
  | (CommonRunner & Readonly<{ kind: 'cancellation-transition'; expectedState: ActiveRecoveryState }>)
  | (CommonRunner & Readonly<{ kind: 'cancellation-cleanup'; expectedState: 'cancel_requested'; proof: CancellationProof }>)
  | (CommonRunner & Readonly<{ kind: 'cancellation-terminal'; expectedState: 'cancel_requested'; terminalAt: string; cleanupEventSeq: number }>)
  | (CommonRunner & Readonly<{ kind: 'stage'; expectedState: JobState; state: JobState; stage: PipelineStageName; outcome: 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted'; startedAt: string; finishedAt?: string | null; evidencePath?: string | null; evidenceSha256?: string | null; errorCode?: BuilderErrorCode | null; error?: JsonInput }>)
  | (CommonRunner & Readonly<{ kind: 'container'; lifecycle: 'created' | 'started' | 'stopped' | 'removed'; containerId: string; containerName: string; imageDigest: string; labels: JsonObject; mount: JsonObject; environment: JsonObject; security: JsonObject; inspection: JsonObject; occurredAt: string; createdAt?: string | null; startedAt?: string | null; stoppedAt?: string | null; removedAt?: string | null; cleanupOutcome?: 'passed' | 'failed' | 'blocking' | null }>)
  | (CommonRunner & Readonly<{ kind: 'artifact'; expectedState: JobState; state: JobState; stagingPath: string; artifactSha256: string; artifactSize: number; artifactMtime: string; checksumPath: string; checksumSha256: string; manifestPath: string; manifestSha256: string; verificationPath: string; verificationSha256: string }>)
  | (CommonRunner & Readonly<{ kind: 'publish'; expectedState: JobState; state: 'staged' | 'publishing' | 'published' | 'blocked'; finalDirectory?: string; finalPath?: string; startedAt?: string; publishedAt?: string; blockerCode?: BuilderErrorCode; blocker?: JsonObject }>)
  | (CommonRunner & Readonly<{ kind: 'normal-terminal'; expectedState: JobState; state: 'succeeded' | 'failed'; terminalAt: string; errorCode?: BuilderErrorCode | null; error?: JsonInput }>)
  | (CommonRunner & Readonly<{ kind: 'operation-begin'; expectedState: JobState; operationId: TrustedOperationId; attempt: number; argvHash: string; argv: readonly string[]; startedAt: string }>)
  | (CommonRunner & Readonly<{ kind: 'operation-complete'; expectedState: JobState; operationId: TrustedOperationId; attempt: number; input: OperationInput }>)
  | (CommonRunner & Readonly<{ kind: 'operation-cleanup'; expectedState: JobState; operationId: TrustedOperationId; attempt: number; proof: OperationCleanupProof }>);

export type CleanupWriteCommand =
  | Readonly<{ kind: 'claim-lease'; jobId: string; admissionId: string; owner: string; unitName: string; fenceGeneration: number; fenceTokenHash: string; snapshot: CleanupSnapshot; at: string }>
  | Readonly<{ kind: 'renew-lease'; jobId: string; admissionId: string; owner: string; unitName: string; fenceGeneration: number; fenceTokenHash: string; expectedExpiresAt: string; expiresAt: string; snapshot: CleanupSnapshot; at: string }>
  | Readonly<{ kind: 'complete'; jobId: string; admissionId: string; owner: string; unitName: string; fenceGeneration: number; fenceTokenHash: string; snapshot: CleanupSnapshot; postcondition: CleanupPostcondition; exactContainerId: string | null; containerAbsent: true; evidencePath: string; evidenceSha256: string; at: string }>
  | Readonly<{ kind: 'evidence'; jobId: string; admissionId: string; owner: string; unitName: string; fenceGeneration: number; fenceTokenHash: string; snapshot: CleanupSnapshot; status: 'failed' | 'blocking'; blockerCode: BuilderErrorCode; blocker: JsonObject; at: string }>;

function instant(value: string, field: string): string {
  try { return sharedCanonicalInstant(value, field); }
  catch (error) { if (error instanceof SharedValidationError) throw new OwnershipValidationError(error.message, { cause: error }); throw error; }
}

function requireChronology(values: readonly (readonly [string, string | null | undefined])[]): void {
  try { sharedRequireChronology(values); }
  catch (error) { if (error instanceof SharedValidationError) throw new OwnershipValidationError(error.message, { cause: error }); throw error; }
}

function matchesExpectedState(actual: string, expected: JobState | readonly JobState[]): boolean {
  return Array.isArray(expected) ? expected.includes(actual as JobState) : actual === expected;
}

const COMMAND_OUTCOMES = new Set(['running', 'passed', 'failed', 'cancelled', 'interrupted', 'blocking']);
const COMMAND_LIFECYCLES = new Set(['created', 'started', 'stopped', 'removed', 'not_created']);
const CONTAINER_LIFECYCLES = Object.freeze(['created', 'started', 'stopped', 'removed'] as const);

function prepareCommand<T>(command: T): T {
  try {
    const prepared = normalizeCommand(command, 'actor command');
    if (prepared === null || typeof prepared !== 'object' || Array.isArray(prepared)) throw new SharedValidationError('actor command must be an object');
    return prepared;
  } catch (error) {
    if (error instanceof OwnershipValidationError) throw error;
    if (error instanceof SharedValidationError) throw new OwnershipValidationError(error.message, { cause: error });
    throw new OwnershipValidationError('actor command validation failed', { cause: error });
  }
}

type PreparedRecord = Readonly<Record<string, unknown>> & Readonly<{ kind: string }>;

function preparedObject(value: unknown, field: string): PreparedRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new OwnershipValidationError(`${field} must be an object`);
  return value as PreparedRecord;
}

function preparedString(value: unknown, field: string, maxBytes = TEXT_LIMITS.maxTextBytes): string {
  if (typeof value !== 'string') throw new OwnershipValidationError(`${field} is required`);
  try { return boundedText(value, field, maxBytes); }
  catch (error) { if (error instanceof SharedValidationError) throw new OwnershipValidationError(error.message, { cause: error }); throw error; }
}

function preparedPath(value: unknown, field: string): void { confinedPath(preparedString(value, field, TEXT_LIMITS.maxPathBytes), field); }

function preparedOptionalString(value: unknown, field: string): void {
  if (value !== undefined && value !== null) preparedString(value, field);
}

function preparedJsonArray(value: unknown, field: string, maxBytes = TEXT_LIMITS.maxArgvBytes): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new OwnershipValidationError(`${field} must be a string array`);
  for (const [index, item] of value.entries()) preparedString(item, `${field}[${index}]`);
  try {
    const encoded = encodeJson(value, field);
    if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw new OwnershipValidationError(`${field} exceeds its byte limit`);
  } catch (error) { if (error instanceof SharedValidationError) throw new OwnershipValidationError(error.message, { cause: error }); throw error; }
}

function preparedOptionalPath(value: unknown, field: string): void {
  if (value !== undefined && value !== null) preparedPath(value, field);
}

function preparedInstant(value: unknown, field: string): void { instant(preparedString(value, field), field); }
function preparedOptionalInstant(value: unknown, field: string): void { if (value !== undefined && value !== null) preparedInstant(value, field); }
function preparedHash(value: unknown, field: string, sha40 = false): void { (sha40 ? hash40 : hash)(preparedString(value, field), field); }
function preparedOptionalHash(value: unknown, field: string, sha40 = false): void { if (value !== undefined && value !== null) preparedHash(value, field, sha40); }
function preparedJsonObject(value: unknown, field: string, optional = false): void {
  if (value === undefined || value === null) { if (!optional) throw new OwnershipValidationError(`${field} is required`); return; }
  jsonValue(value, field, 'object');
}
function preparedEnum(value: unknown, values: readonly string[], field: string, optional = false): void {
  if (value === undefined || value === null) { if (!optional) throw new OwnershipValidationError(`${field} is required`); return; }
  if (typeof value !== 'string' || !values.includes(value)) throw new OwnershipValidationError(`${field} is invalid`);
}
function preparedCommon(command: PreparedRecord, actor: string): void {
  preparedString(command.jobId, `${actor} jobId`, TEXT_LIMITS.maxIdentifierBytes); preparedInstant(command.at, `${actor} command time`);
}
function preparedRunnerCommon(command: PreparedRecord): void {
  preparedCommon(command, 'runner'); preparedString(command.owner, 'runner owner', TEXT_LIMITS.maxIdentifierBytes); runnerUnit(String(command.jobId), preparedString(command.runnerUnit, 'runner unit', TEXT_LIMITS.maxIdentifierBytes)); preparedInstant(command.leaseExpiresAt, 'runner lease expiry');
}

function sourcePreparationJson(value: unknown, pinnedSha: unknown): string {
  if (typeof pinnedSha !== 'string') throw new OwnershipValidationError('enqueue pinnedSha is invalid');
  try {
    return encodeSourcePreparation(value, pinnedSha);
  } catch (error) {
    throw new OwnershipValidationError('enqueue sourcePreparation is invalid', { cause: error });
  }
}

function validateCreateJobInput(input: unknown): void {
  const value = preparedObject(input, 'enqueue input');
  for (const field of ['jobId', 'requestId', 'sourceRemote', 'sourceRef', 'sourceBranch', 'branch', 'rootId', 'sourceAuthor', 'sourceSubject']) preparedString(value[field], `enqueue ${field}`, TEXT_LIMITS.maxIdentifierBytes);
  preparedJsonObject(value.request, 'enqueue request'); preparedEnum(value.targetId, TARGET_IDS, 'enqueue targetId');
  for (const field of ['expectedSha', 'pinnedSha']) preparedHash(value[field], `enqueue ${field}`, true);
  sourcePreparationJson(value.sourcePreparation, value.pinnedSha);
  preparedHash(value.targetManifestSha256, 'enqueue targetManifestSha256'); preparedInstant(value.sourceCommitTime, 'enqueue sourceCommitTime'); preparedInstant(value.acceptedAt, 'enqueue acceptedAt');
  preparedOptionalHash(value.preflightSha, 'enqueue preflightSha', true); preparedOptionalInstant(value.preflightCheckedAt, 'enqueue preflightCheckedAt'); preparedOptionalInstant(value.preflightExpiresAt, 'enqueue preflightExpiresAt');
  const preflightFields = [value.preflightSha, value.preflightCheckedAt, value.preflightExpiresAt].filter((field) => field !== undefined && field !== null);
  if (preflightFields.length !== 0 && preflightFields.length !== 3) throw new OwnershipValidationError('enqueue preflight evidence is incomplete');
  requireChronology([['source commit time', String(value.sourceCommitTime)], ['accepted time', String(value.acceptedAt)], ['preflight checked time', value.preflightCheckedAt as string | null | undefined], ['preflight expiry', value.preflightExpiresAt as string | null | undefined]]);
}

function validateFreshnessInputShape(value: PreparedRecord): void {
  preparedEnum(value.status, ['fresh', 'advanced', 'unknown'], 'freshness status'); preparedHash(value.pinnedSha, 'freshness pinned SHA', true); preparedOptionalHash(value.observedSha, 'freshness observed SHA', true); preparedInstant(value.checkedAt, 'freshness checkedAt'); preparedJsonObject(value.error, 'freshness error', true); preparedOptionalPath(value.errorEvidencePath, 'freshness error evidence path'); preparedOptionalHash(value.errorEvidenceSha256, 'freshness error evidence SHA');
  const hasPath = value.errorEvidencePath !== undefined && value.errorEvidencePath !== null; const hasHash = value.errorEvidenceSha256 !== undefined && value.errorEvidenceSha256 !== null;
  if (hasPath !== hasHash) throw new OwnershipValidationError('freshness error evidence is incomplete');
  if (value.status === 'fresh' && (value.observedSha !== value.pinnedSha || value.error !== undefined && value.error !== null || hasPath)) throw new OwnershipValidationError('fresh freshness evidence is incoherent');
  if (value.status === 'advanced' && (value.observedSha === undefined || value.observedSha === null || value.error !== undefined && value.error !== null || hasPath)) throw new OwnershipValidationError('advanced freshness evidence is incoherent');
  if (value.status === 'unknown' && (value.observedSha !== undefined && value.observedSha !== null || value.error === undefined || value.error === null || !hasPath)) throw new OwnershipValidationError('unknown freshness evidence is incomplete');
}

function validateApiCommand(command: ApiWriteCommand): void {
  const value = command as unknown as PreparedRecord;
  switch (command.kind) {
    case 'enqueue': validateCreateJobInput(value.input); return;
    case 'dispatch': preparedCommon(value, 'API'); runnerUnit(preparedString(value.jobId, 'dispatch jobId'), preparedString(value.runnerUnit, 'dispatch runnerUnit')); return;
    case 'request-cancellation': preparedCommon(value, 'API'); preparedString(value.reason, 'cancellation reason'); preparedJsonObject(value.error, 'cancellation error', true); return;
    case 'freshness-request': preparedCommon(value, 'API'); return;
    case 'freshness-result':
      preparedCommon(value, 'API'); validateFreshnessInputShape(preparedObject(value.input, 'freshness input')); return;
    case 'direct-interrupt': preparedCommon(value, 'API'); preparedEnum(value.expectedState, JOB_STATES, 'direct interruption expectedState'); shapeDirectProof(value.proof, value.at as string); preparedEnum(value.errorCode, BUILDER_ERROR_CODES, 'direct interruption errorCode'); preparedJsonObject(value.error, 'direct interruption error'); return;
    case 'publish-recovery': preparedCommon(value, 'API'); preparedEnum(value.expectedState, ['publishing'], 'publish recovery expectedState'); preparedEnum(value.state, ['succeeded', 'failed'], 'publish recovery state'); shapePublishEvidence(value.evidence, value.at as string); preparedOptionalEnum(value.errorCode, BUILDER_ERROR_CODES, 'publish recovery errorCode'); preparedJsonObject(value.error, 'publish recovery error', true); return;
    case 'cleanup-admission': preparedCommon(value, 'API'); preparedString(value.admissionId, 'cleanup admission id', TEXT_LIMITS.maxIdentifierBytes); preparedString(value.owner, 'cleanup admission owner', TEXT_LIMITS.maxIdentifierBytes); preparedString(value.unitName, 'cleanup admission unit', TEXT_LIMITS.maxIdentifierBytes); preparedInstant(value.expiresAt, 'cleanup admission expiry'); preparedPath(value.credentialRelativePath, 'cleanup credential path'); preparedHash(value.credentialSha256, 'cleanup credential SHA'); preparedHash(value.fenceTokenHash, 'cleanup fence token hash'); shapeCleanupSnapshot(value.snapshot, 'cleanup admission snapshot', value.at as string); return;
    case 'hand-back': preparedCommon(value, 'API'); preparedString(value.admissionId, 'hand-back admission id'); preparedString(value.owner, 'hand-back owner'); preparedString(value.unitName, 'hand-back unit'); preparedHash(value.fenceTokenHash, 'hand-back fence token hash'); if (!Number.isSafeInteger(value.fenceGeneration) || Number(value.fenceGeneration) < 0) throw new OwnershipValidationError('hand-back fence generation is invalid'); shapeHandBackProof(value.proof, value.at as string); return;
    default: throw new OwnershipValidationError('API command kind is invalid');
  }
}

function preparedOptionalEnum(value: unknown, values: readonly string[], field: string): void { preparedEnum(value, values, field, true); }

function validateOperationInput(input: unknown): void {
  const value = preparedObject(input, 'operation input'); preparedEnum(value.operationId, TRUSTED_OPERATION_IDS, 'operation input operationId');
  if (!Number.isSafeInteger(value.attempt) || Number(value.attempt) <= 0) throw new OwnershipValidationError('operation input attempt is invalid');
  preparedHash(value.argvHash, 'operation input argv hash'); preparedPath(value.evidencePath, 'operation input evidence path'); preparedHash(value.evidenceSha256, 'operation input evidence SHA'); preparedInstant(value.startedAt, 'operation input startedAt'); preparedOptionalInstant(value.finishedAt, 'operation input finishedAt');
  preparedEnum(value.lifecyclePhase, [...COMMAND_LIFECYCLES], 'operation input lifecycle'); preparedEnum(value.outcome, ['passed', 'failed'], 'operation input outcome');
  preparedJsonArray(value.argv, 'operation input argv');
  if (typeof value.timedOut !== 'boolean') throw new OwnershipValidationError('operation input timedOut is invalid');
  preparedOptionalHash(value.containerImageDigest, 'operation input container image digest'); if (value.containerId !== undefined && value.containerId !== null) preparedString(value.containerId, 'operation input container id', TEXT_LIMITS.maxIdentifierBytes); if (value.containerName !== undefined && value.containerName !== null) preparedString(value.containerName, 'operation input container name', TEXT_LIMITS.maxIdentifierBytes); if (value.containerLabelJobId !== undefined && value.containerLabelJobId !== null) preparedString(value.containerLabelJobId, 'operation input container job label', TEXT_LIMITS.maxIdentifierBytes); preparedOptionalHash(value.containerLabelManifestSha, 'operation input container manifest label');
  preparedJsonObject(value.containerMount, 'operation input mount', true); preparedJsonObject(value.containerEnvironment, 'operation input environment', true); preparedJsonObject(value.containerSecurity, 'operation input security', true); preparedJsonObject(value.inspection, 'operation input inspection', true); preparedJsonObject(value.error, 'operation input error', true); preparedOptionalEnum(value.errorCode, BUILDER_ERROR_CODES, 'operation input errorCode');
  const containerFields = ['containerId', 'containerName', 'containerImageDigest', 'containerLabelJobId', 'containerLabelManifestSha', 'containerMount', 'containerEnvironment', 'containerSecurity', 'inspection'];
  const hasContainer = containerFields.some((field) => value[field] !== undefined && value[field] !== null);
  if (value.lifecyclePhase === 'not_created' && hasContainer) throw new OwnershipValidationError('pre-container operation result contains container evidence');
  if (value.lifecyclePhase !== 'not_created' && containerFields.some((field) => value[field] === undefined || value[field] === null)) throw new OwnershipValidationError('container operation result is incomplete');
  if (value.outcome === 'passed' && (value.errorCode !== undefined && value.errorCode !== null || value.error !== undefined && value.error !== null)) throw new OwnershipValidationError('passed operation contains error evidence');
  if (value.outcome === 'failed' && (value.errorCode === undefined || value.errorCode === null || value.error === undefined || value.error === null)) throw new OwnershipValidationError('failed operation is missing error evidence');
  if (value.exitCode !== undefined && value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || Number(value.exitCode) < 0)) throw new OwnershipValidationError('operation exit code is invalid');
  if (value.exitCode !== undefined && value.exitCode !== null && value.signal !== undefined && value.signal !== null) throw new OwnershipValidationError('operation exit and signal evidence are mutually exclusive');
}

function shapeRecord(value: unknown, field: string): PreparedRecord {
  return preparedObject(value, field);
}

function shapeLiteral(value: unknown, expected: string | boolean | null, field: string): void {
  if (value !== expected) throw new OwnershipValidationError(`${field} must be ${String(expected)}`);
}

function shapeChronology(values: readonly (readonly [string, unknown])[], field: string): void {
  try { sharedRequireChronology(values.map(([name, value]) => [name, value as string | null | undefined] as const)); }
  catch (error) { if (error instanceof SharedValidationError) throw new OwnershipValidationError(`${field} chronology is invalid`, { cause: error }); throw error; }
}

function shapeNullableString(value: unknown, field: string, path = false): void {
  if (value !== null && value !== undefined) path ? preparedPath(value, field) : preparedString(value, field);
}

function shapeNullableHash(value: unknown, field: string): void {
  if (value !== null && value !== undefined) preparedHash(value, field);
}

function shapeNullContainer(value: unknown, field: string, at: string): void {
  const proof = shapeRecord(value, field);
  shapeLiteral(proof.kind, 'absent', `${field}.kind`); shapeLiteral(proof.globalLabelResult, 'no-match', `${field}.globalLabelResult`); preparedInstant(proof.observedAt, `${field}.observedAt`); shapeChronology([[`${field}.observedAt`, proof.observedAt], [`${field}.command.at`, at]], field);
}

function shapeLogs(value: unknown, field: string, allowUnsealed: boolean, at: string): void {
  const proof = shapeRecord(value, field);
  const states = allowUnsealed ? ['absent', 'sealed', 'unsealed'] : ['absent', 'sealed'];
  preparedEnum(proof.runner, states, `${field}.runner`); preparedEnum(proof.docker, states, `${field}.docker`); preparedInstant(proof.verifiedAt, `${field}.verifiedAt`); shapeChronology([[`${field}.verifiedAt`, proof.verifiedAt], [`${field}.command.at`, at]], field);
}

function shapeStaging(value: unknown, field: string, allowPresent: boolean, allowQuarantined: boolean): void {
  const proof = shapeRecord(value, field);
  if (proof.kind === 'absent') { shapeLiteral(proof.path, null, `${field}.path`); if (proof.sha256 !== undefined && proof.sha256 !== null) throw new OwnershipValidationError(`${field}.sha256 must be absent`); if (proof.size !== undefined && proof.size !== null) throw new OwnershipValidationError(`${field}.size must be absent`); return; }
  if (proof.kind === 'present' && allowPresent) {
    preparedPath(proof.path, `${field}.path`); const path = proof.path as string; if (!path.startsWith('staging/')) throw new OwnershipValidationError(`${field}.path is not a staging path`); preparedHash(proof.sha256, `${field}.sha256`); if (!Number.isSafeInteger(proof.size) || Number(proof.size) < 0) throw new OwnershipValidationError(`${field}.size is invalid`); return;
  }
  if (proof.kind === 'quarantined' && allowQuarantined) {
    preparedPath(proof.sourcePath, `${field}.sourcePath`); preparedPath(proof.destinationPath, `${field}.destinationPath`); const source = proof.sourcePath as string; const destination = proof.destinationPath as string; if (!source.startsWith('staging/') || !destination.startsWith('quarantine/') || source === destination) throw new OwnershipValidationError(`${field} quarantine paths are invalid`); shapeLiteral(proof.sourceAbsent, true, `${field}.sourceAbsent`); shapeLiteral(proof.destinationPresent, true, `${field}.destinationPresent`); preparedHash(proof.sha256, `${field}.sha256`); if (!Number.isSafeInteger(proof.size) || Number(proof.size) < 0) throw new OwnershipValidationError(`${field}.size is invalid`); preparedInstant(proof.verifiedAt, `${field}.verifiedAt`); return;
  }
  throw new OwnershipValidationError(`${field}.kind is invalid`);
}

function shapeDirectLog(value: unknown, field: string, at: string): void {
  const proof = shapeRecord(value, field); preparedEnum(proof.runner, ['absent', 'sealed'], `${field}.runner`); preparedEnum(proof.docker, ['absent', 'sealed'], `${field}.docker`); preparedInstant(proof.verifiedAt, `${field}.verifiedAt`);
  const identity = shapeRecord(proof.generationIdentity, `${field}.generationIdentity`);
  for (const stream of ['runner', 'docker']) {
    if (!Array.isArray(identity[stream])) throw new OwnershipValidationError(`${field}.generationIdentity.${stream} is required`);
    for (const [index, item] of (identity[stream] as unknown[]).entries()) {
      const generation = shapeRecord(item, `${field}.generationIdentity.${stream}[${index}]`);
      if (!Number.isSafeInteger(generation.generation) || Number(generation.generation) < 0) throw new OwnershipValidationError(`${field}.generation is invalid`);
      preparedPath(generation.path, `${field}.generation.path`); preparedInstant(generation.startedAt, `${field}.generation.startedAt`);
      shapeChronology([[`${field}.generation.startedAt`, generation.startedAt], [`${field}.verifiedAt`, proof.verifiedAt]], `${field}.generation`);
    }
  }
  shapeChronology([[`${field}.verifiedAt`, proof.verifiedAt], [`${field}.at`, at]], field);
}

function shapeDirectProof(value: unknown, at: string): void {
  const proof = shapeRecord(value, 'direct interruption proof'); preparedEnum(proof.kind, ['start-failure', 'active'], 'direct interruption kind'); preparedString(proof.runnerUnit, 'direct interruption runner unit', TEXT_LIMITS.maxIdentifierBytes); preparedInstant(proof.unitInactiveAt, 'direct interruption inactive time');
  shapeNullContainer(proof.container, 'direct interruption container', at); shapeStaging(proof.staging, 'direct interruption staging', false, false); shapeLiteral(proof.blocker, 'none', 'direct interruption blocker'); shapeLiteral(proof.cleanupAdmission, null, 'direct interruption cleanupAdmission'); shapeLiteral(proof.cleanupFence, null, 'direct interruption cleanupFence'); shapeDirectLog(proof.logs, 'direct interruption logs', at); shapeChronology([['direct unit inactiveAt', proof.unitInactiveAt], ['direct command.at', at]], 'direct interruption');
  if (proof.kind === 'start-failure') { preparedInstant(proof.startAttemptedAt, 'direct interruption startAttemptedAt'); shapeChronology([['direct startAttemptedAt', proof.startAttemptedAt], ['direct unitInactiveAt', proof.unitInactiveAt]], 'direct interruption'); shapeLiteral(proof.runnerLeaseOwner, null, 'direct interruption runnerLeaseOwner'); shapeLiteral(proof.runnerLeaseExpiresAt, null, 'direct interruption runnerLeaseExpiresAt'); }
  else { preparedString(proof.runnerLeaseOwner, 'direct interruption runnerLeaseOwner', TEXT_LIMITS.maxIdentifierBytes); preparedInstant(proof.runnerLeaseExpiresAt, 'direct interruption runnerLeaseExpiresAt'); preparedInstant(proof.leaseStaleAt, 'direct interruption leaseStaleAt'); shapeChronology([['direct runner lease expiry', proof.runnerLeaseExpiresAt], ['direct lease stale time', proof.leaseStaleAt], ['direct command.at', at]], 'direct interruption lease'); }
}

function shapeCancellationProof(value: unknown, at: string): void {
  const proof = shapeRecord(value, 'cancellation proof'); preparedEnum(proof.kind, ['pre-container', 'container'], 'cancellation kind'); preparedString(proof.runnerUnit, 'cancellation runner unit', TEXT_LIMITS.maxIdentifierBytes); preparedInstant(proof.unitInactiveAt, 'cancellation inactive time'); shapeLogs(proof.logs, 'cancellation logs', false, at as string); shapeStaging(proof.staging, 'cancellation staging', false, true);
  if (proof.kind === 'pre-container') shapeNullContainer(proof.container, 'cancellation container', at as string);
  else { const container = shapeRecord(proof.container, 'cancellation container'); shapeLiteral(container.kind, 'removed', 'cancellation container kind'); preparedString(container.id, 'cancellation container id', TEXT_LIMITS.maxIdentifierBytes); preparedString(container.name, 'cancellation container name', TEXT_LIMITS.maxIdentifierBytes); preparedHash(container.imageDigest, 'cancellation image digest'); preparedJsonObject(container.labels, 'cancellation labels'); preparedInstant(container.stoppedAt, 'cancellation stoppedAt'); preparedInstant(container.removedAt, 'cancellation removedAt'); preparedInstant(container.observedAt, 'cancellation observedAt'); shapeLiteral(container.globalLabelResult, 'no-match', 'cancellation globalLabelResult'); shapeChronology([['cancellation stoppedAt', container.stoppedAt], ['cancellation removedAt', container.removedAt], ['cancellation observedAt', container.observedAt], ['cancellation command.at', at]], 'cancellation container'); }
  const logs = shapeRecord(proof.logs, 'cancellation logs'); const staging = shapeRecord(proof.staging, 'cancellation staging'); shapeChronology([['cancellation inactiveAt', proof.unitInactiveAt], ['cancellation at', at]], 'cancellation proof'); shapeChronology([['cancellation logs verifiedAt', logs.verifiedAt], ['cancellation at', at]], 'cancellation logs'); if (staging.kind === 'quarantined') shapeChronology([['cancellation quarantine verifiedAt', staging.verifiedAt], ['cancellation at', at]], 'cancellation staging');
}

function shapeCleanupSnapshot(value: unknown, field: string, at: string): void {
  const snapshot = shapeRecord(value, field); const runner = shapeRecord(snapshot.runner, `${field}.runner`); preparedString(runner.unit, `${field}.runner.unit`, TEXT_LIMITS.maxIdentifierBytes); shapeNullableString(runner.owner, `${field}.runner.owner`); shapeNullableString(runner.leaseExpiresAt, `${field}.runner.leaseExpiresAt`); if ((runner.owner == null) !== (runner.leaseExpiresAt == null)) throw new OwnershipValidationError(`${field}.runner owner/lease pair is incomplete`); preparedInstant(runner.inactiveAt, `${field}.runner.inactiveAt`); preparedInstant(runner.observedAt, `${field}.runner.observedAt`); preparedEnum(snapshot.state, ['starting', 'preflight', 'source', 'release_gates', 'frontend', 'target_setup', 'feeds', 'config', 'building', 'verifying', 'publishing', 'cancel_requested', 'interrupted'], `${field}.state`); preparedEnum(snapshot.blocker, ['none', 'staging-or-log'], `${field}.blocker`); shapeStaging(snapshot.staging, `${field}.staging`, true, false);
  const container = shapeRecord(snapshot.container, `${field}.container`);
  if (container.kind === 'absent') shapeNullContainer(snapshot.container, `${field}.container`, at as string);
  else { shapeLiteral(container.kind, 'present', `${field}.container.kind`); preparedString(container.id, `${field}.container.id`, TEXT_LIMITS.maxIdentifierBytes); preparedString(container.name, `${field}.container.name`, TEXT_LIMITS.maxIdentifierBytes); preparedHash(container.imageDigest, `${field}.container.imageDigest`); preparedJsonObject(container.labels, `${field}.container.labels`); shapeLiteral(container.globalLabelResult, 'single-exact-match', `${field}.container.globalLabelResult`); preparedInstant(container.observedAt, `${field}.container.observedAt`); shapeChronology([[`${field}.container.observedAt`, container.observedAt], [`${field}.command.at`, at]], field); }
  const logs = shapeRecord(snapshot.logs, `${field}.logs`); const staging = shapeRecord(snapshot.staging, `${field}.staging`); shapeChronology([[`${field}.runner.inactiveAt`, runner.inactiveAt], [`${field}.runner.observedAt`, runner.observedAt], [`${field}.at`, at]], field); shapeLogs(snapshot.logs, `${field}.logs`, true, at as string); if (staging.kind === 'quarantined') shapeChronology([[`${field}.staging.verifiedAt`, staging.verifiedAt], [`${field}.at`, at]], field);
}

function shapeCleanupPostcondition(value: unknown, at: string): void {
  const post = shapeRecord(value, 'cleanup postcondition');
  const runner = shapeRecord(post.runner, 'cleanup postcondition runner'); preparedString(runner.unit, 'cleanup postcondition runner unit', TEXT_LIMITS.maxIdentifierBytes); shapeNullableString(runner.owner, 'cleanup postcondition runner owner'); shapeNullableString(runner.leaseExpiresAt, 'cleanup postcondition runner leaseExpiresAt'); if ((runner.owner == null) !== (runner.leaseExpiresAt == null)) throw new OwnershipValidationError('cleanup postcondition runner owner/lease pair is incomplete'); preparedInstant(runner.inactiveAt, 'cleanup postcondition runner inactiveAt'); preparedInstant(runner.observedAt, 'cleanup postcondition runner observedAt'); preparedEnum(post.state, ['starting', 'preflight', 'source', 'release_gates', 'frontend', 'target_setup', 'feeds', 'config', 'building', 'verifying', 'publishing', 'cancel_requested', 'interrupted'], 'cleanup postcondition state');
  const container = shapeRecord(post.container, 'cleanup postcondition container');
  if (container.kind === 'removed') { preparedString(container.id, 'cleanup postcondition container id', TEXT_LIMITS.maxIdentifierBytes); preparedString(container.name, 'cleanup postcondition container name', TEXT_LIMITS.maxIdentifierBytes); preparedHash(container.imageDigest, 'cleanup postcondition image digest'); preparedJsonObject(container.labels, 'cleanup postcondition labels'); shapeLiteral(container.exactIdAbsent, true, 'cleanup postcondition exactIdAbsent'); shapeLiteral(container.globalLabelResult, 'no-match', 'cleanup postcondition globalLabelResult'); preparedInstant(container.stoppedAt, 'cleanup postcondition stoppedAt'); preparedInstant(container.removedAt, 'cleanup postcondition removedAt'); preparedInstant(container.observedAt, 'cleanup postcondition observedAt'); }
  else if (container.kind === 'null-identity') { shapeLiteral(container.dockerAction, 'none', 'cleanup postcondition dockerAction'); shapeLiteral(container.globalLabelResult, 'no-match', 'cleanup postcondition globalLabelResult'); preparedInstant(container.observedAt, 'cleanup postcondition observedAt'); }
  else throw new OwnershipValidationError('cleanup postcondition container kind is invalid');
  shapeStaging(post.staging, 'cleanup postcondition staging', false, true); shapeLogs(post.logs, 'cleanup postcondition logs', false, at as string); shapeLiteral(post.blocker, 'none', 'cleanup postcondition blocker'); const logs = shapeRecord(post.logs, 'cleanup postcondition logs'); const staging = shapeRecord(post.staging, 'cleanup postcondition staging'); shapeChronology([['cleanup runner inactiveAt', runner.inactiveAt], ['cleanup runner observedAt', runner.observedAt], ['cleanup at', at]], 'cleanup postcondition'); if (staging.kind === 'quarantined') shapeChronology([['cleanup quarantine verifiedAt', staging.verifiedAt], ['cleanup at', at]], 'cleanup postcondition'); if (container.kind === 'removed') shapeChronology([['cleanup stoppedAt', container.stoppedAt], ['cleanup removedAt', container.removedAt], ['cleanup observedAt', container.observedAt], ['cleanup at', at]], 'cleanup container'); else shapeChronology([['cleanup null-container observedAt', container.observedAt], ['cleanup at', at]], 'cleanup container');
}

function shapeOperationCleanupProof(value: unknown, at: string): void {
  const proof = shapeRecord(value, 'operation cleanup proof'); preparedEnum(proof.kind, ['null-identity', 'container-removed'], 'operation cleanup kind');
  if (proof.kind === 'null-identity') { shapeNullContainer(proof.container, 'operation cleanup container', at as string); shapeLogs(proof.logs, 'operation cleanup logs', false, at as string); return; }
  preparedString(proof.id, 'operation cleanup container id', TEXT_LIMITS.maxIdentifierBytes); preparedString(proof.name, 'operation cleanup container name', TEXT_LIMITS.maxIdentifierBytes); preparedHash(proof.imageDigest, 'operation cleanup image digest'); preparedJsonObject(proof.labels, 'operation cleanup labels'); preparedInstant(proof.stoppedAt, 'operation cleanup stoppedAt'); preparedInstant(proof.removedAt, 'operation cleanup removedAt'); preparedInstant(proof.observedAt, 'operation cleanup observedAt'); shapeLiteral(proof.globalLabelResult, 'no-match', 'operation cleanup globalLabelResult'); shapeChronology([['operation cleanup stoppedAt', proof.stoppedAt], ['operation cleanup removedAt', proof.removedAt], ['operation cleanup observedAt', proof.observedAt], ['operation cleanup at', at]], 'operation cleanup'); shapeLogs(proof.logs, 'operation cleanup logs', false, at as string);
}

function shapeHandBackProof(value: unknown, at: string): void {
  const proof = shapeRecord(value, 'hand-back proof'); const runner = shapeRecord(proof.runner, 'hand-back runner'); preparedString(runner.unit, 'hand-back runner unit', TEXT_LIMITS.maxIdentifierBytes); shapeNullableString(runner.owner, 'hand-back runner owner'); shapeNullableString(runner.leaseExpiresAt, 'hand-back runner lease expiry'); if ((runner.owner == null) !== (runner.leaseExpiresAt == null)) throw new OwnershipValidationError('hand-back runner owner/lease pair is incomplete'); preparedInstant(runner.inactiveAt, 'hand-back runner inactiveAt'); preparedInstant(runner.observedAt, 'hand-back runner observedAt'); shapeNullContainer(proof.container, 'hand-back container', at as string); shapeLiteral(proof.blocker, 'none', 'hand-back blocker'); shapeChronology([['hand-back inactiveAt', runner.inactiveAt], ['hand-back observedAt', runner.observedAt], ['hand-back at', at]], 'hand-back proof');
}

function shapeStageCommand(value: PreparedRecord, at: string): void {
  const outcome = String(value.outcome);
  const finished = value.finishedAt !== undefined && value.finishedAt !== null;
  const evidence = value.evidencePath !== undefined && value.evidencePath !== null;
  const evidenceHash = value.evidenceSha256 !== undefined && value.evidenceSha256 !== null;
  const errorCode = value.errorCode !== undefined && value.errorCode !== null;
  const error = value.error !== undefined && value.error !== null;
  shapeChronology([['stage startedAt', value.startedAt], ['stage finishedAt', value.finishedAt], ['stage command.at', at]], 'stage');
  if (outcome === 'running' && (finished || evidence || evidenceHash || errorCode || error)) throw new OwnershipValidationError('running stage contains terminal evidence');
  if (outcome === 'passed' && (!finished || !evidence || !evidenceHash || errorCode || error)) throw new OwnershipValidationError('passed stage evidence is incomplete');
  if (['failed', 'cancelled', 'interrupted'].includes(outcome) && (!finished || !evidence || !evidenceHash || !errorCode || !error)) throw new OwnershipValidationError('failed stage evidence is incomplete');
}

function shapeContainerCommand(value: PreparedRecord, at: string): void {
  const lifecycle = String(value.lifecycle);
  if (!(CONTAINER_LIFECYCLES as readonly string[]).includes(lifecycle)) throw new OwnershipValidationError('container lifecycle is invalid');
  const occurred = value.occurredAt;
  const created = value.createdAt ?? (lifecycle === 'created' ? occurred : null);
  const started = value.startedAt ?? (lifecycle === 'started' ? occurred : null);
  const stopped = value.stoppedAt ?? (lifecycle === 'stopped' ? occurred : null);
  const removed = value.removedAt ?? (lifecycle === 'removed' ? occurred : null);
  shapeChronology([
    ['container createdAt', created], ['container startedAt', started], ['container stoppedAt', stopped],
    ['container removedAt', removed], ['container occurredAt', occurred], ['container command.at', at],
  ], 'container');
}

function shapePublishCommand(value: PreparedRecord, at: string): void {
  const state = String(value.state);
  const startedAt = value.startedAt;
  const publishedAt = value.publishedAt;
  if (state === 'publishing') {
    if (publishedAt !== undefined && publishedAt !== null) throw new OwnershipValidationError('publishing command cannot include publishedAt');
    shapeChronology([['effective publish startedAt', startedAt ?? at], ['publish command.at', at]], 'publish');
  } else if (state === 'published') {
    shapeChronology([['publish startedAt', startedAt], ['publish publishedAt', publishedAt], ['publish command.at', at]], 'publish');
  } else if ((state === 'staged' || state === 'blocked') && (startedAt !== undefined && startedAt !== null || publishedAt !== undefined && publishedAt !== null)) {
    throw new OwnershipValidationError(`${state} publish command cannot include publish timestamps`);
  }
}

function shapePublishEvidence(value: unknown, at: string): void {
  const evidence = shapeRecord(value, 'publish recovery evidence'); const runner = shapeRecord(evidence.runner, 'publish recovery runner'); preparedString(runner.unit, 'publish recovery runner unit', TEXT_LIMITS.maxIdentifierBytes); preparedString(runner.owner, 'publish recovery runner owner', TEXT_LIMITS.maxIdentifierBytes); preparedInstant(runner.leaseExpiresAt, 'publish recovery lease expiry'); preparedInstant(runner.inactiveAt, 'publish recovery inactiveAt'); preparedInstant(runner.observedAt, 'publish recovery observedAt'); shapeNullContainer(evidence.container, 'publish recovery container', at as string);
  const artifact = shapeRecord(evidence.artifact, 'publish recovery artifact'); for (const field of ['stagingPath', 'checksumPath', 'manifestPath', 'verificationPath']) preparedPath(artifact[field], `publish recovery ${field}`); for (const field of ['artifactSha256', 'checksumSha256', 'manifestSha256', 'verificationSha256']) preparedHash(artifact[field], `publish recovery ${field}`); if (!Number.isSafeInteger(artifact.artifactSize) || Number(artifact.artifactSize) < 0) throw new OwnershipValidationError('publish recovery artifact size is invalid'); preparedInstant(artifact.artifactMtime, 'publish recovery artifact mtime');
  const final = shapeRecord(evidence.final, 'publish recovery final'); preparedPath(final.directory, 'publish recovery final directory'); preparedPath(final.path, 'publish recovery final path'); preparedInstant(final.publishStartedAt, 'publish recovery publishStartedAt'); preparedOptionalInstant(final.publishedAt, 'publish recovery publishedAt');
  const observed = shapeRecord(evidence.observed, 'publish recovery observations');
  const finalObserved = shapeRecord(observed.final, 'publish recovery observed final'); if (typeof finalObserved.present !== 'boolean' || typeof finalObserved.held !== 'boolean') throw new OwnershipValidationError('publish recovery observed final flags are invalid'); preparedPath(finalObserved.path, 'publish recovery observed final path'); shapeNullableHash(finalObserved.sha256, 'publish recovery observed final SHA'); if (finalObserved.size !== null && finalObserved.size !== undefined && (!Number.isSafeInteger(finalObserved.size) || Number(finalObserved.size) < 0)) throw new OwnershipValidationError('publish recovery observed final size is invalid');
  const checksum = shapeRecord(observed.checksum, 'publish recovery checksum'); if (typeof checksum.present !== 'boolean') throw new OwnershipValidationError('publish recovery checksum present is invalid'); preparedPath(checksum.path, 'publish recovery checksum path'); if (checksum.contents !== null && checksum.contents !== undefined) preparedString(checksum.contents, 'publish recovery checksum contents', TEXT_LIMITS.maxChecksumBytes); shapeNullableHash(checksum.sha256, 'publish recovery checksum SHA');
  for (const [name, sidecar] of [['manifest', observed.manifest], ['verification', observed.verification]] as const) { const item = shapeRecord(sidecar, `publish recovery ${name}`); if (typeof item.present !== 'boolean') throw new OwnershipValidationError(`publish recovery ${name} present is invalid`); preparedPath(item.path, `publish recovery ${name} path`); if (item.bytes !== null && item.bytes !== undefined) preparedString(item.bytes, `publish recovery ${name} bytes`, TEXT_LIMITS.maxManifestBytes); preparedJsonObject(item.content, `publish recovery ${name} content`, true); shapeNullableHash(item.sha256, `publish recovery ${name} SHA`); }
  const staging = shapeRecord(observed.staging, 'publish recovery observed staging'); preparedEnum(staging.state, ['present', 'absent'], 'publish recovery staging state'); shapeNullableString(staging.path, 'publish recovery staging path', true); shapeNullableHash(staging.sha256, 'publish recovery staging SHA'); if (staging.state === 'absent' && (staging.path !== undefined && staging.path !== null || staging.sha256 !== undefined && staging.sha256 !== null)) throw new OwnershipValidationError('absent staging observation contains identity'); if (staging.state === 'present') { if (staging.path === undefined || staging.path === null || staging.sha256 === undefined || staging.sha256 === null) throw new OwnershipValidationError('present staging observation is incomplete'); const path = staging.path as string; if (!path.startsWith('staging/')) throw new OwnershipValidationError('present staging observation path is invalid'); } shapeLogs(observed.logs, 'publish recovery logs', false, at as string); shapeLiteral(shapeRecord(observed.logs, 'publish recovery logs').noGap, true, 'publish recovery logs noGap'); shapeChronology([['publish runner inactiveAt', runner.inactiveAt], ['publish runner observedAt', runner.observedAt], ['publish at', at]], 'publish recovery'); shapeChronology([['publish start', final.publishStartedAt], ['publish finish', final.publishedAt], ['publish at', at]], 'publish recovery');
}

function validateRunnerCommand(command: RunnerWriteCommand): void {
  const value = command as unknown as PreparedRecord;
  switch (command.kind) {
    case 'acquire-lease': preparedCommon(value, 'runner'); runnerUnit(preparedString(value.jobId, 'lease jobId'), preparedString(value.runnerUnit, 'lease runnerUnit')); preparedString(value.owner, 'lease owner'); preparedInstant(value.expiresAt, 'lease expiry'); return;
    case 'renew-lease': preparedCommon(value, 'runner'); runnerUnit(preparedString(value.jobId, 'renew jobId'), preparedString(value.runnerUnit, 'renew runnerUnit')); preparedString(value.owner, 'renew owner'); preparedInstant(value.expectedExpiresAt, 'renew expected expiry'); preparedInstant(value.expiresAt, 'renew expiry'); return;
    case 'cancellation-transition': preparedRunnerCommon(value); preparedEnum(value.expectedState, [...ACTIVE_STATES], 'cancellation expectedState'); return;
    case 'cancellation-cleanup': preparedRunnerCommon(value); preparedEnum(value.expectedState, ['cancel_requested'], 'cancellation cleanup expectedState'); shapeCancellationProof(value.proof, value.at as string); return;
    case 'cancellation-terminal': preparedRunnerCommon(value); preparedEnum(value.expectedState, ['cancel_requested'], 'cancellation terminal expectedState'); preparedInstant(value.terminalAt, 'cancellation terminal time'); shapeChronology([['cancellation terminal time', value.terminalAt], ['cancellation command.at', value.at]], 'cancellation terminal'); if (!Number.isSafeInteger(value.cleanupEventSeq) || Number(value.cleanupEventSeq) < 0) throw new OwnershipValidationError('cancellation cleanup event sequence is invalid'); return;
    case 'stage': preparedRunnerCommon(value); preparedEnum(value.expectedState, JOB_STATES, 'stage expectedState'); preparedEnum(value.state, JOB_STATES, 'stage state'); preparedEnum(value.stage, PIPELINE_STAGE_NAMES, 'stage name'); preparedEnum(value.outcome, [...COMMAND_OUTCOMES], 'stage outcome'); preparedInstant(value.startedAt, 'stage startedAt'); preparedOptionalInstant(value.finishedAt, 'stage finishedAt'); preparedOptionalPath(value.evidencePath, 'stage evidence path'); preparedOptionalHash(value.evidenceSha256, 'stage evidence SHA'); preparedOptionalEnum(value.errorCode, BUILDER_ERROR_CODES, 'stage errorCode'); preparedJsonObject(value.error, 'stage error', true); shapeStageCommand(value, value.at as string); return;
    case 'container': preparedRunnerCommon(value); preparedEnum(value.lifecycle, CONTAINER_LIFECYCLES, 'container lifecycle'); for (const field of ['containerId', 'containerName']) preparedString(value[field], `container ${field}`, TEXT_LIMITS.maxIdentifierBytes); preparedHash(value.imageDigest, 'container image digest'); preparedJsonObject(value.labels, 'container labels'); preparedJsonObject(value.mount, 'container mount'); preparedJsonObject(value.environment, 'container environment'); preparedJsonObject(value.security, 'container security'); preparedJsonObject(value.inspection, 'container inspection'); preparedInstant(value.occurredAt, 'container occurredAt'); preparedOptionalInstant(value.createdAt, 'container createdAt'); preparedOptionalInstant(value.startedAt, 'container startedAt'); preparedOptionalInstant(value.stoppedAt, 'container stoppedAt'); preparedOptionalInstant(value.removedAt, 'container removedAt'); preparedOptionalEnum(value.cleanupOutcome, ['passed', 'failed', 'blocking'], 'container cleanup outcome'); shapeContainerCommand(value, value.at as string); return;
    case 'artifact': preparedRunnerCommon(value); preparedEnum(value.expectedState, JOB_STATES, 'artifact expectedState'); preparedEnum(value.state, JOB_STATES, 'artifact state'); for (const field of ['stagingPath', 'checksumPath', 'manifestPath', 'verificationPath']) preparedPath(value[field], `artifact ${field}`); for (const field of ['artifactSha256', 'checksumSha256', 'manifestSha256', 'verificationSha256']) preparedHash(value[field], `artifact ${field}`); if (!Number.isSafeInteger(value.artifactSize) || Number(value.artifactSize) < 0) throw new OwnershipValidationError('artifact size is invalid'); preparedInstant(value.artifactMtime, 'artifact mtime'); shapeChronology([['artifact mtime', value.artifactMtime], ['artifact command.at', value.at]], 'artifact'); return;
    case 'publish': preparedRunnerCommon(value); preparedEnum(value.expectedState, JOB_STATES, 'publish expectedState'); preparedEnum(value.state, ['staged', 'publishing', 'published', 'blocked'], 'publish state'); if (value.finalDirectory !== undefined && value.finalDirectory !== null) preparedPath(value.finalDirectory, 'publish final directory'); if (value.finalPath !== undefined && value.finalPath !== null) preparedPath(value.finalPath, 'publish final path'); preparedOptionalInstant(value.startedAt, 'publish startedAt'); preparedOptionalInstant(value.publishedAt, 'publish publishedAt'); preparedOptionalEnum(value.blockerCode, BUILDER_ERROR_CODES, 'publish blockerCode'); preparedJsonObject(value.blocker, 'publish blocker', true); shapePublishCommand(value, value.at as string); return;
    case 'normal-terminal': preparedRunnerCommon(value); preparedEnum(value.expectedState, JOB_STATES, 'terminal expectedState'); preparedEnum(value.state, ['succeeded', 'failed'], 'terminal state'); preparedInstant(value.terminalAt, 'terminal time'); shapeChronology([['terminal time', value.terminalAt], ['terminal command.at', value.at]], 'terminal'); preparedOptionalEnum(value.errorCode, BUILDER_ERROR_CODES, 'terminal errorCode'); preparedJsonObject(value.error, 'terminal error', true); return;
    case 'operation-begin': preparedRunnerCommon(value); preparedEnum(value.expectedState, JOB_STATES, 'operation expectedState'); preparedEnum(value.operationId, TRUSTED_OPERATION_IDS, 'operation id'); if (!Number.isSafeInteger(value.attempt) || Number(value.attempt) <= 0) throw new OwnershipValidationError('operation attempt is invalid'); preparedHash(value.argvHash, 'operation argv hash'); preparedJsonArray(value.argv, 'operation argv'); preparedInstant(value.startedAt, 'operation startedAt'); shapeChronology([['operation startedAt', value.startedAt], ['operation command.at', value.at]], 'operation begin'); return;
    case 'operation-complete': preparedRunnerCommon(value); preparedEnum(value.expectedState, JOB_STATES, 'operation complete expectedState'); preparedEnum(value.operationId, TRUSTED_OPERATION_IDS, 'operation complete operation id'); if (!Number.isSafeInteger(value.attempt) || Number(value.attempt) <= 0) throw new OwnershipValidationError('operation complete attempt is invalid'); validateOperationInput(value.input); { const input = preparedObject(value.input, 'operation input'); shapeChronology([['operation startedAt', input.startedAt], ['operation finishedAt', input.finishedAt], ['operation command.at', value.at]], 'operation complete'); } return;
    case 'operation-cleanup': preparedRunnerCommon(value); preparedEnum(value.expectedState, JOB_STATES, 'operation cleanup expectedState'); preparedEnum(value.operationId, TRUSTED_OPERATION_IDS, 'operation cleanup operation id'); if (!Number.isSafeInteger(value.attempt) || Number(value.attempt) <= 0) throw new OwnershipValidationError('operation cleanup attempt is invalid'); shapeOperationCleanupProof(value.proof, value.at as string); return;
    default: throw new OwnershipValidationError('runner command kind is invalid');
  }
}

function validatePublishEffectiveSemantics(command: Extract<RunnerWriteCommand, { kind: 'publish' }>, row: Row): void {
  const acceptedAt = String(row.accepted_at);
  const artifactMtime = row.artifact_mtime === null ? null : String(row.artifact_mtime);
  const persistedStart = row.publish_started_at === null ? null : String(row.publish_started_at);
  if (command.state === 'publishing') {
    if (persistedStart !== null && command.startedAt !== undefined && command.startedAt !== null && command.startedAt !== persistedStart) throw new OwnershipValidationError('publishing startedAt must match the persisted publish start time');
    const effectiveStart = persistedStart ?? command.startedAt ?? command.at;
    requireChronology([['accepted time', acceptedAt], ['artifact mtime', artifactMtime], ['effective publish start time', effectiveStart], ['publish write time', command.at]]);
    return;
  }
  if (command.state === 'published') {
    if (row.publish_state !== 'publishing' || persistedStart === null) throw new OwnershipValidationError('published completion requires an existing publishing start time');
    if (command.startedAt !== undefined && command.startedAt !== null && command.startedAt !== persistedStart) throw new OwnershipValidationError('published completion startedAt must match the persisted publishing start time');
    const effectivePublishedAt = command.publishedAt ?? command.at;
    requireChronology([['accepted time', acceptedAt], ['artifact mtime', artifactMtime], ['persisted publish start time', persistedStart], ['effective published time', effectivePublishedAt], ['publish write time', command.at]]);
    return;
  }
  requireChronology([['accepted time', acceptedAt], ['artifact mtime', artifactMtime], ['publish write time', command.at]]);
}

function validateCleanupCommand(command: CleanupWriteCommand): void {
  const value = command as unknown as PreparedRecord;
  switch (command.kind) {
    case 'claim-lease': preparedCommon(value, 'cleanup'); preparedString(value.admissionId, 'cleanup admissionId'); preparedString(value.owner, 'cleanup owner'); preparedString(value.unitName, 'cleanup unitName'); preparedHash(value.fenceTokenHash, 'cleanup fence token'); if (!Number.isSafeInteger(value.fenceGeneration) || Number(value.fenceGeneration) < 0) throw new OwnershipValidationError('cleanup fence generation is invalid'); shapeCleanupSnapshot(value.snapshot, 'cleanup snapshot', value.at as string); return;
    case 'renew-lease': validateCleanupCommand({ ...command, kind: 'claim-lease' } as never); preparedInstant(value.expectedExpiresAt, 'cleanup expected expiry'); preparedInstant(value.expiresAt, 'cleanup expiry'); return;
    case 'complete': validateCleanupCommand({ ...command, kind: 'claim-lease' } as never); shapeCleanupPostcondition(value.postcondition, value.at as string); if (value.containerAbsent !== true) throw new OwnershipValidationError('containerAbsent must be true'); preparedOptionalString(value.exactContainerId, 'cleanup exact container id'); preparedPath(value.evidencePath, 'cleanup evidence path'); preparedHash(value.evidenceSha256, 'cleanup evidence SHA'); return;
    case 'evidence': validateCleanupCommand({ ...command, kind: 'claim-lease' } as never); preparedEnum(value.status, ['failed', 'blocking'], 'cleanup evidence status'); preparedEnum(value.blockerCode, BUILDER_ERROR_CODES, 'cleanup blocker code'); preparedJsonObject(value.blocker, 'cleanup blocker'); return;
    default: throw new OwnershipValidationError('cleanup command kind is invalid');
  }
}

function hash(value: string, field: string): string {
  try {
    const bounded = boundedText(value, field, 128);
    if (!HASH64.test(bounded)) throw new OwnershipValidationError(`${field} must be a lowercase SHA-256`);
    return bounded;
  } catch (error) { if (error instanceof SharedValidationError) throw new OwnershipValidationError(error.message, { cause: error }); throw error; }
}

function hash40(value: string, field: string): string {
  try {
    const bounded = boundedText(value, field, 128);
    if (!/^[0-9a-f]{40}$/.test(bounded)) throw new OwnershipValidationError(`${field} must be a lowercase SHA-1`);
    return bounded;
  } catch (error) { if (error instanceof SharedValidationError) throw new OwnershipValidationError(error.message, { cause: error }); throw error; }
}

function boundedJson(value: unknown, field: string, depth = 0, nodes = { value: 0 }, edges = { value: 0 }, seen = new WeakSet<object>()): JsonValue {
  try { return normalizeJson(value, field) as JsonValue; }
  catch (error) { if (error instanceof SharedValidationError) throw new OwnershipValidationError(error.message, { cause: error }); throw error; }
}

function json(value: unknown, field: string, required = false): string | null {
  if (value === null || value === undefined) {
    if (required) throw new TypeError(`${field} is required`);
    return null;
  }
  try { return encodeJson(value, field, true); }
  catch (error) { if (error instanceof SharedValidationError) throw new OwnershipValidationError(error.message, { cause: error }); throw error; }
}

function jsonValue(value: unknown, field: string, expected: 'array' | 'object'): string {
  try {
    const bounded = normalizeJson(value, field);
    if (expected === 'array' && !Array.isArray(bounded)) throw new OwnershipValidationError(`${field} must be a JSON array`);
    if (expected === 'object' && (bounded === null || Array.isArray(bounded) || typeof bounded !== 'object')) throw new OwnershipValidationError(`${field} must be a JSON object`);
    return encodeJson(bounded, field, expected === 'object');
  } catch (error) { if (error instanceof SharedValidationError) throw new OwnershipValidationError(error.message, { cause: error }); throw error; }
}

function labels(value: JsonObject, jobId: string, manifestSha: string): string {
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'org.osi.image-builder.job-id' || keys[1] !== 'org.osi.image-builder.manifest-sha') throw new OwnershipValidationError('container labels must contain exactly the two builder labels');
  if (value['org.osi.image-builder.job-id'] !== jobId || value['org.osi.image-builder.manifest-sha'] !== manifestSha) throw new OwnershipValidationError('container labels do not match the job');
  return jsonValue(value, 'container labels', 'object');
}

function proofJson(value: object, field: string): string {
  return jsonValue(value, field, 'object');
}

function validateCleanupProof(proof: StagingCleanupProof | LogCleanupProof | CleanupStagingSnapshot | LogCleanupSnapshot, field: string): void {
  if (field === 'staging') {
    const value = proof as StagingCleanupProof | CleanupStagingSnapshot;
    if (value.kind === 'absent') return;
    if (value.kind === 'present') {
      confinedPath(value.path, 'staging source path'); hash(value.sha256, 'staging source SHA-256');
      if (!value.path.startsWith('staging/') || !Number.isSafeInteger(value.size) || value.size < 0) throw new OwnershipValidationError('staging source snapshot is invalid');
      return;
    }
    if (value.kind !== 'quarantined') throw new OwnershipValidationError('staging cleanup proof kind is invalid');
    if (value.sourceAbsent !== true || value.destinationPresent !== true) throw new OwnershipValidationError('quarantine move presence proof is incomplete');
    confinedPath(value.sourcePath, 'quarantine source path'); confinedPath(value.destinationPath, 'quarantine destination path');
    if (!value.sourcePath.startsWith('staging/') || !value.destinationPath.startsWith('quarantine/') || value.sourcePath === value.destinationPath) throw new OwnershipValidationError('quarantine paths are not distinct confined paths');
    hash(value.sha256, 'quarantine SHA-256');
    if (!Number.isSafeInteger(value.size) || value.size < 0) throw new OwnershipValidationError('quarantine size is invalid');
    instant(value.verifiedAt, 'quarantine verification time');
    return;
  }
  const logs = proof as LogCleanupProof;
  if (!['absent', 'sealed', 'unsealed'].includes(logs.runner) || !['absent', 'sealed', 'unsealed'].includes(logs.docker)) throw new OwnershipValidationError('log cleanup proof is invalid');
  instant(logs.verifiedAt, 'log verification time');
}

function validateCleanupSnapshot(db: DbFacade, snapshot: CleanupSnapshot, job: Row, at: string, mode: 'admission' | 'worker' = 'admission', admitted?: PersistedCleanupSnapshot): string {
  instant(at, 'cleanup snapshot time');
  if (!['starting', 'preflight', 'source', 'release_gates', 'frontend', 'target_setup', 'feeds', 'config', 'building', 'verifying', 'publishing', 'cancel_requested', 'interrupted'].includes(snapshot.state)) throw new OwnershipValidationError('cleanup snapshot state is invalid');
  if (snapshot.container.kind !== 'present' && snapshot.container.kind !== 'absent') throw new OwnershipValidationError('cleanup snapshot container kind is invalid');
  string(snapshot.runner.unit, 'snapshot runner unit');
  if (snapshot.runner.unit !== job.runner_unit) throw new OwnershipConflictError('stale-runner-owner', 'cleanup snapshot runner unit does not match the job');
  if (snapshot.state !== job.state) throw new OwnershipConflictError('stale-predecessor', 'cleanup snapshot state does not match the job');
  if (snapshot.runner.leaseExpiresAt !== job.runner_lease_expires_at || snapshot.runner.owner !== job.runner_lease_owner) throw new OwnershipConflictError('stale-lease', 'cleanup snapshot lease does not match the job');
  instant(snapshot.runner.inactiveAt, 'runner inactive time'); instant(snapshot.runner.observedAt, 'runner snapshot time');
  requireChronology([['runner inactive time', snapshot.runner.inactiveAt], ['runner snapshot time', snapshot.runner.observedAt]]);
  if (snapshot.runner.leaseExpiresAt !== null) {
    instant(snapshot.runner.leaseExpiresAt, 'snapshot lease expiry');
    if (snapshot.runner.leaseExpiresAt >= at || snapshot.runner.owner === null) throw new OwnershipConflictError('stale-lease', 'cleanup snapshot lease is not stale');
  } else if (snapshot.runner.owner !== null) {
    throw new OwnershipValidationError('null runner lease must have a null owner');
  }
  if (snapshot.runner.inactiveAt > at || snapshot.runner.observedAt > at) throw new OwnershipValidationError('cleanup snapshot is from the future');
  validateCleanupProof(snapshot.staging, 'staging'); validateCleanupProof(snapshot.logs, 'logs');
  const actualLogs = cleanupLogSnapshot(db, String(job.job_id), at);
  if (mode === 'admission') {
    if (snapshot.logs.runner !== actualLogs.runner || snapshot.logs.docker !== actualLogs.docker) throw new OwnershipConflictError('identity-mismatch', 'cleanup log snapshot does not match persisted generations');
  } else {
    if (!admitted) throw new OwnershipTransactionError('cleanup admission snapshot is missing');
    if (cleanupSnapshotIdentity(snapshot) !== cleanupSnapshotIdentity(admitted)) throw new OwnershipConflictError('identity-mismatch', 'cleanup snapshot identity changed after admission');
    assertPersistedLogIdentity(db, String(job.job_id), admitted.logs.generationIdentity);
    assertMonotonicLogState(admitted.logs, actualLogs);
    const matchesAdmission = snapshot.logs.runner === admitted.logs.runner && snapshot.logs.docker === admitted.logs.docker;
    const matchesCurrent = snapshot.logs.runner === actualLogs.runner && snapshot.logs.docker === actualLogs.docker;
    if (!matchesAdmission && !matchesCurrent) throw new OwnershipConflictError('identity-mismatch', 'cleanup log snapshot is neither the admitted nor current state');
  }
  if (snapshot.staging.kind === 'present' && snapshot.staging.path && snapshot.staging.path.startsWith('staging/') === false) throw new OwnershipValidationError('cleanup staging snapshot path is invalid');
  if (snapshot.logs.verifiedAt > at) throw new OwnershipValidationError('cleanup log proof is from the future');
  if (snapshot.blocker !== 'none' && snapshot.blocker !== 'staging-or-log') throw new OwnershipValidationError('cleanup blocker kind is invalid');
  if (snapshot.blocker === 'none' && (snapshot.staging.kind !== 'absent' || snapshot.logs.runner === 'unsealed' || snapshot.logs.docker === 'unsealed')) throw new OwnershipValidationError('no-blocker cleanup snapshot retains cleanup work');
  if (snapshot.blocker === 'staging-or-log' && snapshot.staging.kind === 'absent' && snapshot.logs.runner !== 'unsealed' && snapshot.logs.docker !== 'unsealed') throw new OwnershipValidationError('cleanup blocker snapshot has no blocker');
  if (snapshot.staging.kind === 'absent' && job.artifact_staging_path !== null) throw new OwnershipConflictError('identity-mismatch', 'cleanup staging absence conflicts with persisted staging');
  if (snapshot.staging.kind === 'present' && (job.artifact_staging_path !== snapshot.staging.path || job.artifact_quarantine_path !== null || job.artifact_sha256 !== snapshot.staging.sha256 || Number(job.artifact_size) !== snapshot.staging.size)) throw new OwnershipConflictError('identity-mismatch', 'cleanup staging snapshot conflicts with persisted artifact');
  if (snapshot.container.kind === 'present') {
    instant(snapshot.container.observedAt, 'container observation time');
    if (snapshot.container.observedAt > at) throw new OwnershipValidationError('cleanup container observation is from the future');
    if (job.container_id !== snapshot.container.id || job.container_name !== snapshot.container.name || job.container_image_digest !== snapshot.container.imageDigest) throw new OwnershipConflictError('identity-mismatch', 'cleanup snapshot container identity does not match the job');
    if (job.container_label_job_id !== job.job_id || job.container_label_manifest_sha !== job.target_manifest_sha256) throw new OwnershipValidationError('persisted container labels are not exact');
    const snapshotLabels = labels(snapshot.container.labels, String(job.job_id), String(job.target_manifest_sha256));
    if (job.container_labels_json !== snapshotLabels) throw new OwnershipConflictError('identity-mismatch', 'cleanup snapshot labels do not match persisted labels');
    if (snapshot.container.globalLabelResult !== 'single-exact-match') throw new OwnershipValidationError('present cleanup snapshot lacks a single exact label match');
  } else {
    validateNullContainerProof(snapshot.container, at);
    if (job.container_id !== null || job.container_name !== null || job.container_image_digest !== null || job.container_label_job_id !== null || job.container_label_manifest_sha !== null || job.container_labels_json !== null) throw new OwnershipConflictError('identity-mismatch', 'null cleanup snapshot conflicts with persisted container identity');
    if (snapshot.container.globalLabelResult !== 'no-match') throw new OwnershipValidationError('absent cleanup snapshot lacks a global no-label result');
  }
  return mode === 'admission' ? persistCleanupSnapshot(db, String(job.job_id), snapshot) : proofJson(admitted!, 'cleanup admission snapshot');
}

function validateNullContainerProof(proof: NullContainerProof, at: string): void {
  if (proof.kind !== 'absent' || proof.globalLabelResult !== 'no-match') throw new OwnershipValidationError('container absence proof is incomplete');
  instant(proof.observedAt, 'container absence time');
  if (proof.observedAt > at) throw new OwnershipValidationError('container absence proof is from the future');
}

type CleanupLogState = 'absent' | 'sealed' | 'unsealed';
const MAX_LOG_GENERATIONS = 128;
const MAX_LOG_EVENTS = 8_192;

function cleanupSnapshotIdentity(snapshot: CleanupSnapshot): string {
  const { logs: _logs, blocker: _blocker, ...identity } = snapshot;
  return proofJson(identity, 'cleanup snapshot identity');
}

function persistedLogGenerationIdentity(db: DbFacade, jobId: string): { runner: LogGenerationIdentity[]; docker: LogGenerationIdentity[] } {
  const result = { runner: [] as LogGenerationIdentity[], docker: [] as LogGenerationIdentity[] };
  const rows = db.prepare('SELECT stream, generation, path, started_at FROM job_log_generations WHERE job_id=? ORDER BY stream, generation LIMIT ?').all(jobId, MAX_LOG_GENERATIONS + 1) as Row[];
  if (rows.length > MAX_LOG_GENERATIONS) throw new OwnershipConflictError('identity-mismatch', 'log generation identity exceeds the bounded recovery limit');
  for (const row of rows) {
    const stream = row.stream;
    if (stream !== 'docker' && stream !== 'runner') throw new OwnershipTransactionError('cleanup log stream identity is corrupt');
    if (!Number.isSafeInteger(Number(row.generation)) || Number(row.generation) < 0 || typeof row.path !== 'string' || typeof row.started_at !== 'string') throw new OwnershipTransactionError(`${stream} log generation identity is corrupt`);
    result[stream].push({ generation: Number(row.generation), path: row.path, startedAt: row.started_at });
  }
  return result;
}

function persistCleanupSnapshot(db: DbFacade, jobId: string, snapshot: CleanupSnapshot): string {
  const generationIdentity = persistedLogGenerationIdentity(db, jobId);
  return proofJson({ ...snapshot, logs: { ...snapshot.logs, generationIdentity } }, 'cleanup snapshot');
}

function decodeCleanupAdmission(proofJsonValue: string): PersistedCleanupSnapshot {
  try {
    const parsed = JSON.parse(proofJsonValue) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('snapshot is not an object');
    const bounded = boundedJson(parsed, 'cleanup admission snapshot');
    if (bounded === null || Array.isArray(bounded) || typeof bounded !== 'object' || !('logs' in bounded) || bounded.logs === null || typeof bounded.logs !== 'object' || Array.isArray(bounded.logs) || !('generationIdentity' in bounded.logs)) throw new Error('snapshot generation identity is missing');
    return parsed as PersistedCleanupSnapshot;
  } catch (error) {
    throw new OwnershipTransactionError('cleanup admission snapshot is corrupt', { cause: error });
  }
}

function cleanupAdmissionSnapshot(db: DbFacade, jobId: string, admissionId: string): { readonly raw: string; readonly snapshot: PersistedCleanupSnapshot } {
  const row = db.prepare('SELECT proof_json FROM cleanup_leases WHERE admission_id=? AND job_id=?').get(admissionId, jobId) as Row | undefined;
  if (!row || typeof row.proof_json !== 'string') throw new OwnershipConflictError('admission-mismatch', 'cleanup admission does not exist');
  return { raw: row.proof_json, snapshot: decodeCleanupAdmission(row.proof_json) };
}

function assertPersistedLogIdentity(db: DbFacade, jobId: string, expected: PersistedLogCleanupSnapshot['generationIdentity']): void {
  const actual = persistedLogGenerationIdentity(db, jobId);
  if (proofJson(actual, 'current log generation identity') !== proofJson(expected, 'admitted log generation identity')) throw new OwnershipConflictError('identity-mismatch', 'cleanup log generation identity changed after admission');
}

function assertMonotonicLogState(admitted: LogCleanupSnapshot, actual: LogCleanupSnapshot): void {
  for (const stream of ['runner', 'docker'] as const) {
    const before = admitted[stream]; const after = actual[stream];
    if (before === 'absent' && after !== 'absent' || before === 'sealed' && after !== 'sealed' || before === 'unsealed' && after === 'absent') throw new OwnershipConflictError('identity-mismatch', `${stream} log state regressed after cleanup admission`);
  }
}

function logGenerationCoverage(rows: { readonly generations: readonly Row[]; readonly events: readonly Row[] }, stream: 'runner' | 'docker', at: string, strict: boolean): CleanupLogState {
  const generations = rows.generations.filter((row) => row.stream === stream);
  const eventsByGeneration = new Map<number, Row[]>();
  for (const event of rows.events) {
    if (event.stream !== stream) continue;
    const generation = Number(event.file_generation);
    const bucket = eventsByGeneration.get(generation) ?? [];
    bucket.push(event);
    eventsByGeneration.set(generation, bucket);
  }
  if (generations.length === 0) return 'absent';
  let valid = true;
  for (const [index, generation] of generations.entries()) {
    try {
      if (Number(generation.generation) !== index || !Number.isSafeInteger(Number(generation.size_bytes)) || Number(generation.size_bytes) < 0 || generation.sealed_at === null || generation.sha256 === null) { valid = false; continue; }
      instant(String(generation.sealed_at), `${stream} log seal time`);
      if (String(generation.sealed_at) > at) throw new OwnershipValidationError(`${stream} log seal is from the future`);
      hash(String(generation.sha256), `${stream} log SHA-256`);
      const events = (eventsByGeneration.get(index) ?? []).slice().sort((a, b) => Number(a.seq) - Number(b.seq));
      let previousSeq = -1;
      for (const event of events) {
        const seq = Number(event.seq); const offset = Number(event.byte_offset); const length = Number(event.byte_length);
        if (!['log', 'log_orphan_tail', 'log-truncated', 'log-gap'].includes(String(event.event_type)) || String(event.event_type) === 'log-gap' || !Number.isSafeInteger(seq) || seq <= previousSeq || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length <= 0 || offset < 0 || offset + length > Number(generation.size_bytes)) { valid = false; continue; }
        previousSeq = seq;
      }
      const ranges = events.map((event) => ({ offset: Number(event.byte_offset), length: Number(event.byte_length) })).sort((a, b) => a.offset - b.offset);
      let end = 0;
      for (const range of ranges) {
        if (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || range.length <= 0 || range.offset !== end || range.offset + range.length > Number(generation.size_bytes)) { valid = false; continue; }
        end = range.offset + range.length;
      }
      if (end !== Number(generation.size_bytes)) valid = false;
    } catch (error) {
      if (error instanceof OwnershipValidationError) throw error;
      valid = false;
    }
  }
  if (!valid && strict) throw new OwnershipConflictError('identity-mismatch', `${stream} log generations are not sealed with contiguous coverage`);
  return valid ? 'sealed' : 'unsealed';
}

function loadLogRows(db: DbFacade, jobId: string): { readonly generations: readonly Row[]; readonly events: readonly Row[] } {
  const generations = db.prepare('SELECT stream, generation, sealed_at, size_bytes, sha256 FROM job_log_generations WHERE job_id=? ORDER BY stream, generation LIMIT ?').all(jobId, MAX_LOG_GENERATIONS + 1) as Row[];
  if (generations.length > MAX_LOG_GENERATIONS) throw new OwnershipConflictError('identity-mismatch', 'log generations exceed the bounded recovery limit');
  const events = db.prepare('SELECT stream, file_generation, seq, event_type, byte_offset, byte_length FROM job_events WHERE job_id=? AND stream IS NOT NULL ORDER BY stream, file_generation, seq LIMIT ?').all(jobId, MAX_LOG_EVENTS + 1) as Row[];
  if (events.length > MAX_LOG_EVENTS) throw new OwnershipConflictError('identity-mismatch', 'log events exceed the bounded recovery limit');
  return { generations, events };
}

function logCoverageSnapshot(db: DbFacade, jobId: string, at: string, strict = false): LogCleanupSnapshot {
  const rows = loadLogRows(db, jobId);
  const runner = logGenerationCoverage(rows, 'runner', at, strict);
  const docker = logGenerationCoverage(rows, 'docker', at, strict);
  const anyRows = runner !== 'absent' || docker !== 'absent';
  if (anyRows && (runner !== 'sealed' || docker !== 'sealed')) return { runner: runner === 'absent' ? 'unsealed' : runner, docker: docker === 'absent' ? 'unsealed' : docker, verifiedAt: at };
  return { runner, docker, verifiedAt: at };
}

function cleanupLogSnapshot(db: DbFacade, jobId: string, at: string): LogCleanupSnapshot {
  return logCoverageSnapshot(db, jobId, at);
}

function reconcileCleanupLogs(db: DbFacade, jobId: string, claimed: LogCleanupSnapshot | LogCleanupProof, at: string): LogCleanupSnapshot {
  const actual = cleanupLogSnapshot(db, jobId, at);
  if (claimed.runner !== actual.runner || claimed.docker !== actual.docker) throw new OwnershipConflictError('identity-mismatch', 'cleanup log snapshot does not match persisted generations');
  return actual;
}

function validateCleanupPostcondition(db: DbFacade, post: CleanupPostcondition, admission: CleanupSnapshot, job: Row, at: string): string {
  if (post.state !== admission.state || post.runner.unit !== admission.runner.unit || post.runner.owner !== admission.runner.owner || post.runner.leaseExpiresAt !== admission.runner.leaseExpiresAt) throw new OwnershipConflictError('identity-mismatch', 'cleanup postcondition does not match its admission');
  instant(post.runner.inactiveAt, 'cleanup postcondition inactive time'); instant(post.runner.observedAt, 'cleanup postcondition observation time');
  requireChronology([['cleanup postcondition inactive time', post.runner.inactiveAt], ['cleanup postcondition observation time', post.runner.observedAt]]);
  if (post.runner.inactiveAt > at || post.runner.observedAt > at) throw new OwnershipValidationError('cleanup postcondition is from the future');
  if (post.blocker !== 'none') throw new OwnershipValidationError('cleanup completion postcondition retains a blocker');
  validateCleanupProof(post.staging, 'staging'); validateCleanupProof(post.logs, 'logs');
  if (post.logs.verifiedAt > at) throw new OwnershipValidationError('cleanup completion log proof is from the future');
  if (post.staging.kind === 'quarantined' && post.staging.verifiedAt > at) throw new OwnershipValidationError('cleanup completion quarantine proof is from the future');
  if (post.container.kind === 'removed') {
    instant(post.container.stoppedAt, 'cleanup postcondition container stopped time'); instant(post.container.removedAt, 'cleanup postcondition container removed time'); instant(post.container.observedAt, 'cleanup postcondition container absence time');
    if (post.container.exactIdAbsent !== true || post.container.globalLabelResult !== 'no-match' || post.container.removedAt < post.container.stoppedAt || post.container.observedAt < post.container.removedAt || post.container.stoppedAt > at || post.container.removedAt > at || post.container.observedAt > at) throw new OwnershipValidationError('cleanup postcondition exact absence proof is incomplete');
    if (job.container_id !== post.container.id || job.container_name !== post.container.name || job.container_image_digest !== post.container.imageDigest || job.container_label_job_id !== job.job_id || job.container_label_manifest_sha !== job.target_manifest_sha256 || job.container_labels_json !== labels(post.container.labels, String(job.job_id), String(job.target_manifest_sha256))) throw new OwnershipConflictError('identity-mismatch', 'cleanup postcondition container does not match the persisted identity');
  } else if (post.container.kind === 'null-identity') {
    if (post.container.dockerAction !== 'none' || post.container.globalLabelResult !== 'no-match') throw new OwnershipValidationError('null-container cleanup postcondition is not a no-Docker proof');
    validateNullContainerProof({ kind: 'absent', globalLabelResult: post.container.globalLabelResult, observedAt: post.container.observedAt }, at);
    if (job.container_id !== null || job.container_name !== null || job.container_image_digest !== null || job.container_label_job_id !== null || job.container_label_manifest_sha !== null || job.container_labels_json !== null) throw new OwnershipConflictError('identity-mismatch', 'null cleanup postcondition claims absence while identity remains');
  } else {
    throw new OwnershipValidationError('cleanup postcondition container kind is invalid');
  }
  reconcileCleanupLogs(db, String(job.job_id), post.logs, at);
  if (admission.staging.kind === 'present') {
    if (post.staging.kind !== 'quarantined' || post.staging.sourcePath !== admission.staging.path || post.staging.sha256 !== admission.staging.sha256 || post.staging.size !== admission.staging.size || job.artifact_staging_path !== admission.staging.path || job.artifact_quarantine_path !== null) throw new OwnershipConflictError('identity-mismatch', 'cleanup postcondition does not prove the admitted staging quarantine');
  } else if (post.staging.kind !== 'absent' || job.artifact_staging_path !== null) {
    throw new OwnershipConflictError('identity-mismatch', 'cleanup postcondition introduces unadmitted staging work');
  }
  return proofJson(post, 'cleanup postcondition');
}

function validateCancellationProof(proof: CancellationProof, job: Row, at: string): void {
  string(proof.runnerUnit, 'cancellation runner unit'); instant(proof.unitInactiveAt, 'runner inactive time');
  if (proof.runnerUnit !== job.runner_unit) throw new OwnershipConflictError('stale-runner-owner', 'cancellation proof runner unit does not match the job');
  if (proof.unitInactiveAt > at) throw new OwnershipValidationError('cancellation unit inactivity is from the future');
  if (proof.kind === 'pre-container') {
    validateNullContainerProof(proof.container, at);
    if (job.container_id !== null || job.container_name !== null || job.container_image_digest !== null || job.container_label_job_id !== null || job.container_label_manifest_sha !== null) throw new OwnershipConflictError('identity-mismatch', 'pre-container cancellation has persisted container identity');
  } else if (proof.kind === 'container') {
    const container = proof.container;
    if (job.container_id !== container.id || job.container_name !== container.name || job.container_image_digest !== container.imageDigest) throw new OwnershipConflictError('identity-mismatch', 'cancellation container does not match the job');
    const proofLabels = labels(container.labels, String(job.job_id), String(job.target_manifest_sha256));
    if (job.container_labels_json !== proofLabels) throw new OwnershipConflictError('identity-mismatch', 'cancellation labels do not match persisted labels');
    if (container.globalLabelResult !== 'no-match') throw new OwnershipValidationError('removed container proof lacks global no-label evidence');
    instant(container.stoppedAt, 'container stopped time'); instant(container.removedAt, 'container removed time'); instant(container.observedAt, 'container absence time');
    if (container.removedAt < container.stoppedAt || container.observedAt < container.removedAt || container.stoppedAt > at || container.removedAt > at || container.observedAt > at) throw new OwnershipValidationError('container cleanup chronology is invalid');
  } else throw new OwnershipValidationError('cancellation proof kind is invalid');
  validateCleanupProof(proof.staging, 'staging'); validateCleanupProof(proof.logs, 'logs');
  if (proof.logs.verifiedAt > at || proof.staging.kind === 'quarantined' && proof.staging.verifiedAt > at) throw new OwnershipValidationError('cancellation cleanup proof is from the future');
}

function validateDirectLogProof(db: DbFacade, proof: DirectLogProof, jobId: string, at: string): void {
  instant(proof.verifiedAt, 'direct log proof time');
  if (proof.verifiedAt > at) throw new OwnershipValidationError('direct log proof is from the future');
  for (const stream of ['runner', 'docker'] as const) {
    const identities = proof.generationIdentity?.[stream];
    if (!Array.isArray(identities)) throw new OwnershipValidationError(`direct ${stream} generation identity is required`);
    for (const identity of identities) {
      if (!Number.isSafeInteger(identity.generation) || identity.generation < 0 || typeof identity.path !== 'string' || typeof identity.startedAt !== 'string') throw new OwnershipValidationError(`direct ${stream} generation identity is invalid`);
      instant(identity.startedAt, `direct ${stream} generation start time`);
    }
  }
  const actual = cleanupLogSnapshot(db, jobId, at);
  const actualIdentity = persistedLogGenerationIdentity(db, jobId);
  if (actual.runner === 'absent' && actual.docker === 'absent') {
    if (proof.runner !== 'absent' || proof.docker !== 'absent' || proof.generationIdentity.runner.length !== 0 || proof.generationIdentity.docker.length !== 0) throw new OwnershipConflictError('identity-mismatch', 'direct interruption log proof does not prove absent logs');
    return;
  }
  if (actual.runner !== 'sealed' || actual.docker !== 'sealed') throw new OwnershipConflictError('identity-mismatch', 'direct interruption requires both log streams sealed or both absent');
  const strict = logCoverageSnapshot(db, jobId, at, true);
  if (strict.runner !== 'sealed' || strict.docker !== 'sealed') throw new OwnershipConflictError('identity-mismatch', 'direct log proof requires complete non-orphan coverage');
  if (proof.runner !== 'sealed' || proof.docker !== 'sealed' || proofJson(proof.generationIdentity, 'direct log generation identity') !== proofJson(actualIdentity, 'persisted log generation identity')) throw new OwnershipConflictError('identity-mismatch', 'direct interruption log generation identity does not match the database');
}

function validateDirectProof(db: DbFacade, proof: DirectInterruptionProof, job: Row, at: string): void {
  string(proof.runnerUnit, 'interruption runner unit'); instant(proof.unitInactiveAt, 'runner inactive time');
  if (proof.unitInactiveAt > at) throw new OwnershipValidationError('interruption unit inactivity is from the future');
  if (proof.kind !== 'start-failure' && proof.kind !== 'active') throw new OwnershipValidationError('interruption proof kind is invalid');
  if (proof.kind === 'start-failure') instant(proof.startAttemptedAt, 'runner start attempt time');
  if (proof.kind === 'start-failure' && (proof.startAttemptedAt > proof.unitInactiveAt || proof.unitInactiveAt > at)) throw new OwnershipValidationError('start failure proof chronology is invalid');
  if (proof.kind === 'active') {
    string(proof.runnerLeaseOwner, 'runner lease owner'); instant(proof.runnerLeaseExpiresAt, 'runner lease expiry'); instant(proof.leaseStaleAt, 'runner lease stale time');
    if (proof.runnerLeaseExpiresAt !== job.runner_lease_expires_at || proof.runnerLeaseOwner !== job.runner_lease_owner || proof.runnerLeaseExpiresAt >= at || proof.leaseStaleAt < proof.runnerLeaseExpiresAt || proof.leaseStaleAt > at) throw new OwnershipConflictError('stale-lease', 'active interruption proof does not match the stale lease');
  } else if (job.runner_lease_owner !== null || job.runner_lease_expires_at !== null) {
    throw new OwnershipConflictError('stale-lease', 'start failure proof cannot include a runner lease');
  }
  if (job.runner_unit !== proof.runnerUnit) throw new OwnershipConflictError('stale-runner-owner', 'interruption unit does not match the job');
  validateNullContainerProof(proof.container, at);
  if (job.container_id !== null || job.container_name !== null || job.container_image_digest !== null || job.container_label_job_id !== null || job.container_label_manifest_sha !== null || job.container_labels_json !== null) throw new OwnershipConflictError('identity-mismatch', 'interruption proof has persisted container identity');
  if (proof.staging.kind !== 'absent' || proof.blocker !== 'none' || proof.cleanupAdmission !== null || proof.cleanupFence !== null) throw new OwnershipValidationError('direct interruption proof retains cleanup work');
  validateDirectLogProof(db, proof.logs, String(job.job_id), at);
}

function validatePersistedLogEvidence(db: DbFacade, jobId: string, at: string): void {
  const coverage = logCoverageSnapshot(db, jobId, at, true);
  if (coverage.runner !== 'sealed' || coverage.docker !== 'sealed') throw new OwnershipConflictError('identity-mismatch', 'log generations are not sealed');
}

function finalSidecarPath(directory: string, name: 'sha256sums' | 'build-manifest.json' | 'verification.json'): string {
  return `${directory}/${name}`;
}

function stagingPath(value: string, field: string): void {
  confinedPath(value, field);
  if (!value.startsWith('staging/')) throw new OwnershipValidationError(`${field} is outside the approved staging root`);
}

function validateCanonicalSidecar(observed: { present: boolean; path: string; bytes: string | null; content: JsonObject | null; sha256: string | null }, expectedPath: string, expectedHash: string, job: Row, artifactSha256: string, field: string): void {
  if (!observed.present || observed.path !== expectedPath || observed.bytes === null || observed.content === null || observed.sha256 !== expectedHash) throw new OwnershipConflictError('identity-mismatch', `${field} observation does not match the persisted destination`);
  string(observed.bytes, `${field} bytes`);
  if (Buffer.byteLength(observed.bytes, 'utf8') > TEXT_LIMITS.maxManifestBytes) throw new OwnershipValidationError(`${field} bytes exceed the manifest limit`);
  let parsed: unknown;
  try { parsed = JSON.parse(observed.bytes); } catch (error) { throw new OwnershipValidationError(`${field} bytes are not valid JSON`, { cause: error }); }
  const canonical = json(parsed, `${field} bytes`, true);
  if (canonical !== observed.bytes || JSON.stringify(observed.content) !== observed.bytes || createHash('sha256').update(observed.bytes).digest('hex') !== expectedHash) throw new OwnershipConflictError('identity-mismatch', `${field} bytes or hash do not match the persisted evidence`);
  const content = observed.content;
  if (content.jobId !== job.job_id || content.branch !== job.branch || content.pinnedSha !== job.pinned_sha || content.targetId !== job.target_id || content.artifactSha256 !== artifactSha256) throw new OwnershipConflictError('identity-mismatch', `${field} canonical fields do not bind the job`);
}

function validateFailedSidecar(observed: { present: boolean; path: string; bytes: string | null; content: JsonObject | null; sha256: string | null }, expectedPath: string, field: string): void {
  if (typeof observed.present !== 'boolean' || observed.path !== expectedPath) throw new OwnershipConflictError('identity-mismatch', `${field} failure observation path does not match staging`);
  confinedPath(observed.path, `${field} failure path`);
  if (!observed.present) {
    if (observed.bytes !== null || observed.content !== null || observed.sha256 !== null) throw new OwnershipConflictError('identity-mismatch', `${field} absent failure observation contains fabricated content`);
    return;
  }
  if (observed.bytes !== null) { string(observed.bytes, `${field} failure bytes`); if (Buffer.byteLength(observed.bytes, 'utf8') > TEXT_LIMITS.maxManifestBytes) throw new OwnershipValidationError(`${field} failure bytes exceed the manifest limit`); }
  if (observed.content !== null) json(observed.content, `${field} failure content`, true);
  if (observed.sha256 !== null) hash(observed.sha256, `${field} failure SHA-256`);
}

function validatePublishEvidence(db: DbFacade, evidence: PublishRecoveryEvidence, job: Row, at: string, terminalState: 'succeeded' | 'failed'): void {
  if (terminalState !== 'succeeded' && terminalState !== 'failed') throw new OwnershipValidationError('publish recovery terminal state is invalid');
  string(evidence.runner.unit, 'publish recovery runner unit'); string(evidence.runner.owner, 'publish recovery runner owner');
  instant(evidence.runner.leaseExpiresAt, 'publish recovery lease expiry'); instant(evidence.runner.inactiveAt, 'publish recovery inactive time'); instant(evidence.runner.observedAt, 'publish recovery observation time');
  if (evidence.runner.inactiveAt > at || evidence.runner.observedAt > at) throw new OwnershipValidationError('publish recovery observation is from the future');
  if (evidence.runner.unit !== job.runner_unit || evidence.runner.owner !== job.runner_lease_owner || evidence.runner.leaseExpiresAt !== job.runner_lease_expires_at || evidence.runner.leaseExpiresAt >= at) throw new OwnershipConflictError('stale-lease', 'publish recovery runner snapshot does not match the job');
  validateNullContainerProof(evidence.container, at);
  if (job.container_id !== null || job.container_name !== null || job.container_image_digest !== null || job.container_label_job_id !== null || job.container_label_manifest_sha !== null || job.container_labels_json !== null) throw new OwnershipConflictError('identity-mismatch', 'publish recovery requires null container identity');
  const artifact = evidence.artifact;
  stagingPath(artifact.stagingPath, 'publish recovery staging path');
  stagingPath(artifact.checksumPath, 'publish recovery checksum path');
  stagingPath(artifact.manifestPath, 'publish recovery manifest path');
  stagingPath(artifact.verificationPath, 'publish recovery verification path');
  for (const [value, field] of [[artifact.artifactSha256, 'artifact SHA-256'], [artifact.checksumSha256, 'checksum SHA-256'], [artifact.manifestSha256, 'manifest SHA-256'], [artifact.verificationSha256, 'verification SHA-256']] as const) hash(value, field);
  if (!Number.isSafeInteger(artifact.artifactSize) || artifact.artifactSize < 0) throw new OwnershipValidationError('publish recovery artifact size is invalid');
  if (job.artifact_staging_path !== artifact.stagingPath || job.artifact_sha256 !== artifact.artifactSha256 || Number(job.artifact_size) !== artifact.artifactSize || job.artifact_mtime !== artifact.artifactMtime || job.checksum_path !== artifact.checksumPath || job.checksum_sha256 !== artifact.checksumSha256 || job.manifest_path !== artifact.manifestPath || job.manifest_sha256 !== artifact.manifestSha256 || job.verification_path !== artifact.verificationPath || job.verification_sha256 !== artifact.verificationSha256) throw new OwnershipConflictError('identity-mismatch', 'publish recovery artifact evidence does not match the job');
  if (job.artifact_final_directory !== evidence.final.directory || job.artifact_final_path !== evidence.final.path || job.publish_started_at !== evidence.final.publishStartedAt || job.published_at !== evidence.final.publishedAt) throw new OwnershipConflictError('identity-mismatch', 'publish recovery final-path evidence does not match the job');
  instant(evidence.final.publishStartedAt, 'publish start time'); if (evidence.final.publishedAt !== null) instant(evidence.final.publishedAt, 'published time');
  requireChronology([['publish start time', evidence.final.publishStartedAt], ['published time', evidence.final.publishedAt], ['recovery observation time', at]]);
  const final = evidence.observed.final;
  confinedPath(evidence.final.directory, 'final directory'); confinedPath(evidence.final.path, 'final path'); confinedPath(final.path, 'observed final path');
  if (final.path !== evidence.final.path || !final.path.startsWith(`${evidence.final.directory}/`) || typeof final.present !== 'boolean' || typeof final.held !== 'boolean') throw new OwnershipConflictError('identity-mismatch', 'observed final destination does not match the approved held path');
  if (terminalState === 'succeeded' && ((final.present && (!final.held || final.size !== artifact.artifactSize || final.sha256 !== artifact.artifactSha256)) || (!final.present && (final.held || final.size !== null || final.sha256 !== null)))) throw new OwnershipConflictError('identity-mismatch', 'observed final destination does not match the approved held artifact');
  if (terminalState === 'failed' && final.present && (final.size !== null && (!Number.isSafeInteger(final.size) || final.size < 0) || final.sha256 !== null && !HASH64.test(final.sha256))) throw new OwnershipValidationError('failed final observation dimensions are invalid');
  if (terminalState === 'failed' && !final.present && (final.held || final.size !== null || final.sha256 !== null)) throw new OwnershipConflictError('identity-mismatch', 'absent failed final observation contains fabricated identity');
  const checksum = evidence.observed.checksum;
  if (checksum.contents !== null) { string(checksum.contents, 'checksum sidecar bytes'); if (Buffer.byteLength(checksum.contents, 'utf8') > TEXT_LIMITS.maxChecksumBytes) throw new OwnershipValidationError('checksum sidecar bytes exceed the checksum limit'); }
  const checksumTokens = checksum.contents?.trim().split(/\s+/) ?? [];
  const expectedChecksumPath = terminalState === 'succeeded' ? finalSidecarPath(evidence.final.directory, 'sha256sums') : artifact.checksumPath;
  const expectedChecksumArtifactName = (terminalState === 'succeeded' ? evidence.final.path : artifact.stagingPath).split('/').at(-1);
  if (terminalState === 'failed') {
    validateFailedSidecar({ present: checksum.present, path: checksum.path, bytes: checksum.contents, content: null, sha256: checksum.sha256 }, expectedChecksumPath, 'checksum sidecar');
  } else if (checksum.path !== expectedChecksumPath || (checksum.present && (!checksum.contents || checksum.sha256 !== artifact.checksumSha256 || checksumTokens.length !== 2 || checksumTokens[0] !== artifact.artifactSha256 || checksumTokens[1] !== expectedChecksumArtifactName || createHash('sha256').update(checksum.contents).digest('hex') !== artifact.checksumSha256)) || (!checksum.present && (checksum.contents !== null || checksum.sha256 !== null)) || !checksum.present) throw new OwnershipConflictError('identity-mismatch', 'observed checksum sidecar does not bind the artifact and persisted checksum expectation');
  const manifestEvidence = evidence.observed.manifest;
  const verificationEvidence = evidence.observed.verification;
  const expectedManifestPath = terminalState === 'succeeded' ? finalSidecarPath(evidence.final.directory, 'build-manifest.json') : artifact.manifestPath;
  const expectedVerificationPath = terminalState === 'succeeded' ? finalSidecarPath(evidence.final.directory, 'verification.json') : artifact.verificationPath;
  if (terminalState === 'failed') {
    validateFailedSidecar(manifestEvidence, expectedManifestPath, 'build manifest');
    validateFailedSidecar(verificationEvidence, expectedVerificationPath, 'verification manifest');
  } else {
    validateCanonicalSidecar(manifestEvidence, expectedManifestPath, artifact.manifestSha256, job, artifact.artifactSha256, 'build manifest');
    validateCanonicalSidecar(verificationEvidence, expectedVerificationPath, artifact.verificationSha256, job, artifact.artifactSha256, 'verification manifest');
  }
  const staging = evidence.observed.staging;
  if (terminalState === 'succeeded' && (staging.state !== 'absent' || staging.path !== null || staging.sha256 !== null || !final.present || !checksum.present || !manifestEvidence.path.startsWith(`${evidence.final.directory}/`) || !verificationEvidence.path.startsWith(`${evidence.final.directory}/`))) throw new OwnershipConflictError('identity-mismatch', 'successful recovery requires final held sidecars and absent staging');
  if (terminalState === 'failed' && (staging.state !== 'present' || staging.path !== artifact.stagingPath || staging.sha256 !== artifact.artifactSha256)) throw new OwnershipConflictError('identity-mismatch', 'failed recovery must retain staging');
  if (evidence.observed.logs.runner !== 'sealed' || evidence.observed.logs.docker !== 'sealed' || !evidence.observed.logs.noGap) throw new OwnershipValidationError('publish recovery log evidence is incomplete');
  validatePersistedLogEvidence(db, String(job.job_id), at);
}

function string(value: string, field: string): string {
  try { return boundedText(value, field, TEXT_LIMITS.maxTextBytes); }
  catch (error) { if (error instanceof SharedValidationError) throw new OwnershipValidationError(error.message, { cause: error }); throw error; }
}

function confinedPath(value: string, field: string): void {
  try { boundedText(value, field, TEXT_LIMITS.maxPathBytes); } catch (error) { if (error instanceof SharedValidationError) throw new OwnershipValidationError(error.message, { cause: error }); throw error; }
  const parts = value.split('/');
  if (value.length === 0 || value.startsWith('/') || value.includes('\0') || value.includes('\\') || parts.some((part) => part.length === 0 || part === '.' || part === '..')) throw new OwnershipValidationError(`${field} is not a confined relative path`);
}

function runnerUnit(jobId: string, unit: string): void {
  if (unit !== `osi-image-builder-runner@${jobId}.service`) throw new OwnershipValidationError('runner unit does not match job');
}

function cleanupUnit(admissionId: string, unit: string): void {
  if (!ADMISSION_ID.test(admissionId) || unit !== `osi-image-builder-cleanup@${admissionId}.service`) throw new OwnershipValidationError('cleanup unit does not match admission');
}

const JOB_TIMELINE_COLUMNS = [
  'source_commit_time', 'accepted_at', 'created_at', 'updated_at', 'dispatched_at', 'runner_started_at', 'runner_finished_at',
  'cancel_requested_at', 'container_created_at', 'container_started_at', 'container_stopped_at', 'container_removed_at',
  'terminal_at', 'artifact_mtime', 'publish_started_at', 'published_at', 'freshness_requested_at', 'freshness_checked_at',
] as const;

function latestPersistedFact(db: DbFacade, jobId: string, includeTypedTables = false): string | null {
  const job = db.prepare('SELECT * FROM jobs WHERE job_id=?').get(jobId) as Row | undefined;
  if (!job) return null;
  const facts: string[] = [];
  for (const column of JOB_TIMELINE_COLUMNS) if (job[column] !== null && job[column] !== undefined) facts.push(String(job[column]));
  const tableFacts = includeTypedTables ? [
    'SELECT started_at AS at FROM job_stages WHERE job_id=? UNION ALL SELECT finished_at FROM job_stages WHERE job_id=?',
    'SELECT started_at AS at FROM job_operations WHERE job_id=? UNION ALL SELECT finished_at FROM job_operations WHERE job_id=?',
  ] : [];
  for (const sql of tableFacts) {
    const parameters = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => jobId);
    for (const row of db.prepare(sql).all(...parameters) as Row[]) if (row.at !== null && row.at !== undefined) facts.push(String(row.at));
  }
  let latest: string | null = null;
  for (const value of facts) {
    try { sharedCanonicalInstant(value, 'persisted chronology fact'); }
    catch (error) { throw new OwnershipTransactionError('persisted chronology fact is corrupt', { cause: error }); }
    if (latest === null || value > latest) latest = value;
  }
  return latest;
}

function requirePersistedFacts(db: DbFacade, jobId: string, values: readonly (readonly [string, string | null | undefined])[], includeTypedTables = true): void {
  const latest = latestPersistedFact(db, jobId, includeTypedTables);
  const write = values[0];
  if (latest !== null && write !== undefined && write[1] !== null && write[1] !== undefined) requireChronology([['latest persisted fact', latest], [write[0], write[1]]]);
}

function requirePersistedTimeline(db: DbFacade, jobId: string, values: readonly (readonly [string, string | null | undefined])[], includeTypedTables = true): void {
  requirePersistedFacts(db, jobId, values, includeTypedTables);
}

function transition(from: JobState, to: JobState): boolean {
  return (STATE_TRANSITIONS[from] as readonly JobState[]).includes(to);
}

function isActiveState(state: JobState): state is ActiveRecoveryState {
  return ACTIVE_STATES.has(state);
}

function isRunnerLeaseRenewableState(state: JobState): boolean {
  return RUNNER_LEASE_RENEWABLE_STATES.includes(state as (typeof RUNNER_LEASE_RENEWABLE_STATES)[number]);
}

function conflict(kind: OwnershipConflictKind, message: string = kind): never {
  throw new OwnershipConflictError(kind, message);
}

type TrustedSqliteError = Readonly<{ code: string; message: string; errcode: number | null }>;

function trustedSqliteError(error: unknown): TrustedSqliteError | null {
  if (!(error instanceof Error)) return null;
  const codeDescriptor = Object.getOwnPropertyDescriptor(error, 'code');
  const messageDescriptor = Object.getOwnPropertyDescriptor(error, 'message');
  const errcodeDescriptor = Object.getOwnPropertyDescriptor(error, 'errcode');
  if (!codeDescriptor || !('value' in codeDescriptor) || typeof codeDescriptor.value !== 'string' || !messageDescriptor || !('value' in messageDescriptor) || typeof messageDescriptor.value !== 'string') return null;
  const code = codeDescriptor.value;
  if (!['ERR_SQLITE_ERROR', 'ERR_SQLITE_BUSY', 'ERR_SQLITE_CONSTRAINT'].includes(code)) return null;
  const errcode = errcodeDescriptor && 'value' in errcodeDescriptor && typeof errcodeDescriptor.value === 'number' ? errcodeDescriptor.value : null;
  return { code, message: messageDescriptor.value.toLowerCase(), errcode };
}

export interface OwnershipStoreOptions { readonly now?: () => string; readonly failBeforeCommit?: () => void; readonly beforeBegin?: () => void; readonly beforeEvent?: () => void }

export class OwnershipStore {
  readonly #db: DbFacade;
  readonly #now: () => string;
  readonly #failBeforeCommit?: () => void;
  readonly #beforeBegin?: () => void;
  readonly #beforeEvent?: () => void;
  #savepointSequence = 0;
  #eventSeq: number | null = null;

  constructor(db: DatabaseSync, options: OwnershipStoreOptions = {}) {
    this.#db = dbFacade(db);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#failBeforeCommit = options.failBeforeCommit;
    this.#beforeBegin = options.beforeBegin;
    this.#beforeEvent = options.beforeEvent;
  }

  apiWrite(command: ApiWriteCommand): OwnershipResult {
    const prepared = prepareCommand(command) as ApiWriteCommand;
    if (typeof prepared.kind !== 'string') throw new OwnershipValidationError('actor command kind is required');
    if (!['enqueue', 'dispatch', 'request-cancellation', 'freshness-request', 'freshness-result', 'direct-interrupt', 'publish-recovery', 'cleanup-admission', 'hand-back'].includes(prepared.kind)) {
      throw new OwnershipViolationError('api', prepared.kind);
    }
    validateApiCommand(prepared);
    switch (prepared.kind) {
      case 'enqueue': return this.#transaction(() => this.#enqueue(prepared));
      case 'dispatch': return this.#transaction(() => this.#dispatch(prepared));
      case 'request-cancellation': return this.#transaction(() => this.#requestCancellation(prepared));
      case 'freshness-request': return this.#transaction(() => this.#freshnessRequest(prepared));
      case 'freshness-result': return this.#transaction(() => this.#freshnessResult(prepared));
      case 'direct-interrupt': return this.#transaction(() => this.#directInterrupt(prepared));
      case 'publish-recovery': return this.#transaction(() => this.#publishRecovery(prepared));
      case 'cleanup-admission': return this.#transaction(() => this.#cleanupAdmission(prepared));
      case 'hand-back': return this.#transaction(() => this.#handBack(prepared));
    }
  }

  runnerWrite(command: RunnerWriteCommand): OwnershipResult {
    const prepared = prepareCommand(command) as RunnerWriteCommand;
    if (typeof prepared.kind !== 'string') throw new OwnershipValidationError('actor command kind is required');
    if (!['acquire-lease', 'renew-lease', 'cancellation-transition', 'cancellation-cleanup', 'cancellation-terminal', 'stage', 'container', 'artifact', 'publish', 'normal-terminal', 'operation-begin', 'operation-complete', 'operation-cleanup'].includes(prepared.kind)) {
      throw new OwnershipViolationError('runner', prepared.kind);
    }
    validateRunnerCommand(prepared);
    if (prepared.kind === 'publish') this.#validatePublishPreflight(prepared);
    switch (prepared.kind) {
      case 'acquire-lease': return this.#transaction(() => this.#acquireLease(prepared));
      case 'renew-lease': return this.#transaction(() => this.#renewLease(prepared));
      case 'cancellation-transition': return this.#transaction(() => this.#cancellationTransition(prepared));
      case 'cancellation-cleanup': return this.#transaction(() => this.#cancellationCleanup(prepared));
      case 'cancellation-terminal': return this.#transaction(() => this.#cancellationTerminal(prepared));
      case 'stage': return this.#transaction(() => this.#stage(prepared));
      case 'container': return this.#transaction(() => this.#container(prepared));
      case 'artifact': return this.#transaction(() => this.#artifact(prepared));
      case 'publish': return this.#transaction(() => this.#publish(prepared));
      case 'normal-terminal': return this.#transaction(() => this.#normalTerminal(prepared));
      case 'operation-begin': return this.#transaction(() => this.#operationBegin(prepared));
      case 'operation-complete': return this.#transaction(() => this.#operationComplete(prepared));
      case 'operation-cleanup': return this.#transaction(() => this.#operationCleanup(prepared));
    }
  }

  cleanupWrite(command: CleanupWriteCommand): OwnershipResult {
    const prepared = prepareCommand(command) as CleanupWriteCommand;
    if (typeof prepared.kind !== 'string') throw new OwnershipValidationError('actor command kind is required');
    if (!['claim-lease', 'renew-lease', 'complete', 'evidence'].includes(prepared.kind)) {
      throw new OwnershipViolationError('cleanup-worker', prepared.kind);
    }
    validateCleanupCommand(prepared);
    switch (prepared.kind) {
      case 'claim-lease': return this.#transaction(() => this.#claimLease(prepared));
      case 'renew-lease': return this.#transaction(() => this.#renewCleanupLease(prepared));
      case 'complete': return this.#transaction(() => this.#completeCleanup(prepared));
      case 'evidence': return this.#transaction(() => this.#cleanupEvidence(prepared));
    }
  }

  #transaction(work: () => void): OwnershipResult {
    let rollbackCause: unknown;
    let mode: 'transaction' | 'savepoint' | null = null;
    const savepoint = `osi_ownership_${++this.#savepointSequence}`;
    try { this.#beforeBegin?.(); }
    catch (error) { throw new OwnershipTransactionError('ownership pre-lock hook failed', { cause: error }); }
    try {
      this.#eventSeq = null;
      try {
        this.#db.exec('BEGIN IMMEDIATE');
        mode = 'transaction';
      } catch (error) {
        const sqlite = isTaggedDbError(error) ? trustedSqliteError(error) : null;
        if (!sqlite || !/within a transaction|transaction is active/.test(sqlite.message)) throw error;
        this.#db.exec(`SAVEPOINT ${savepoint}`);
        mode = 'savepoint';
      }
      work();
      this.#failBeforeCommit?.();
      this.#db.exec(mode === 'transaction' ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
      return this.#eventSeq === null
        ? { ok: true, kind: 'idempotent', value: undefined }
        : { ok: true, kind: 'committed', eventSeq: this.#eventSeq, value: undefined };
    } catch (error) {
      try {
        if (mode === 'transaction') this.#db.exec('ROLLBACK');
        else if (mode === 'savepoint') {
          this.#db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.#db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        }
      } catch (cause) { rollbackCause = cause; }
      if (error instanceof OwnershipConflictError) {
        error.rollbackCause = rollbackCause;
        return { ok: false, conflict: { kind: error.kind, message: error.message, ...(rollbackCause === undefined ? {} : { rollbackCause }) } };
      }
      if (error instanceof OwnershipValidationError || error instanceof OwnershipTransactionError) {
        if (rollbackCause !== undefined) (error as OwnershipValidationError | OwnershipTransactionError).rollbackCause = rollbackCause;
        throw error;
      }
      if (error instanceof TypeError) throw new OwnershipValidationError(error.message, { cause: error, rollbackCause });
      const sqlite = isTaggedDbError(error) ? trustedSqliteError(error) : null;
      if (!sqlite) throw new OwnershipTransactionError('SQLite ownership transaction rolled back', { cause: error, rollbackCause });
      const message = sqlite.message;
      if (sqlite.code === 'ERR_SQLITE_BUSY' || sqlite.errcode === 5 || sqlite.errcode === 6 || message === 'database is locked' || message === 'database table is locked') {
        return { ok: false, conflict: { kind: 'cas-lost', message: 'SQLite transaction was busy' } };
      }
      const knownUniqueRace = sqlite.code !== 'ERR_SQLITE_BUSY' && (message.includes('unique constraint failed: jobs.request_id')
        || message.includes('unique constraint failed: queue_entries.fifo_seq')
        || message.includes('unique constraint failed: jobs.cleanup_admission_id')
        || message.includes('unique constraint failed: cleanup_leases.'));
      const knownOwnershipTrigger = [
        'invalid cleanup fence', 'cleanup lease is linked by an active job fence', 'cleanup lease fence identity is immutable',
        'cleanup status timestamps are incomplete', 'handback requires clearing the active fence',
      ].some((known) => message.includes(known)) && sqlite.code !== 'ERR_SQLITE_BUSY';
      if (knownUniqueRace) return { ok: false, conflict: { kind: 'admission-mismatch', message: 'known SQLite uniqueness race' } };
      if (knownOwnershipTrigger) return { ok: false, conflict: { kind: 'cas-lost', message: 'known ownership trigger rejected the CAS' } };
      throw new OwnershipTransactionError('SQLite ownership transaction rolled back', { cause: error, rollbackCause });
    }
  }

  #enqueue(command: Extract<ApiWriteCommand, { kind: 'enqueue' }>): void {
    const input = command.input;
    for (const [value, field] of [[input.jobId, 'jobId'], [input.requestId, 'requestId'], [input.sourceRemote, 'source remote'], [input.sourceRef, 'source ref'], [input.sourceBranch, 'source branch'], [input.branch, 'branch'], [input.rootId, 'root id'], [input.sourceAuthor, 'source author'], [input.sourceSubject, 'source subject']] as const) string(value, field);
    if (!TARGET_IDS.includes(input.targetId)) throw new OwnershipValidationError('target id is invalid');
    instant(input.sourceCommitTime, 'source commit time');
    instant(input.acceptedAt, 'accepted time');
    requireChronology([['source commit time', input.sourceCommitTime], ['accepted time', input.acceptedAt]]);
    for (const [value, field] of [[input.expectedSha, 'expected SHA'], [input.pinnedSha, 'pinned SHA']] as const) hash40(value, field);
    hash(input.targetManifestSha256, 'target manifest SHA-256');
    if (input.expectedSha !== input.pinnedSha || input.sourceBranch !== input.branch || input.sourceRef !== `refs/remotes/origin/${input.branch}`) {
      throw new OwnershipValidationError('accepted source identity is incoherent');
    }
    const sourcePreparation = sourcePreparationJson(input.sourcePreparation, input.pinnedSha);
    const request = jsonValue(input.request, 'request', 'object');
    const preflight = input.preflightSha ?? null;
    const checked = input.preflightCheckedAt ?? null;
    const expires = input.preflightExpiresAt ?? null;
    if ((preflight === null) !== (checked === null) || (preflight === null) !== (expires === null)) throw new OwnershipValidationError('preflight evidence is incomplete');
    if (preflight !== null) { hash40(preflight, 'preflight SHA'); instant(checked!, 'preflight checked time'); instant(expires!, 'preflight expiry'); requireChronology([['accepted time', input.acceptedAt], ['preflight checked time', checked], ['preflight expiry', expires]]); }
    const queued = Number((this.#db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE queue_state='queued'").get() as Row).count);
    if (queued >= MAX_QUEUE_LENGTH) conflict('queue-full', `queue is limited to ${MAX_QUEUE_LENGTH} jobs`);
    const fifo = Number((this.#db.prepare('SELECT COALESCE(MAX(fifo_seq) + 1, 0) AS next FROM queue_entries').get() as Row).next);
    const position = Number((this.#db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE queue_state='queued'").get() as Row).count);
    this.#db.prepare(`INSERT INTO jobs (job_id, request_id, request_json, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, source_preparation_json,
      target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, preflight_sha, preflight_checked_at,
      preflight_expires_at, accepted_at, state, queue_state, queue_position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', ?, ?, ?)`).run(
      input.jobId, input.requestId, request, input.sourceRemote, input.sourceRef, input.sourceBranch, input.branch, input.expectedSha, input.pinnedSha,
      sourcePreparation, input.targetId, input.rootId, input.targetManifestSha256, input.sourceCommitTime, input.sourceAuthor, input.sourceSubject,
      preflight, checked, expires, input.acceptedAt, position, input.acceptedAt, input.acceptedAt,
    );
    this.#db.prepare('INSERT INTO queue_entries (job_id, fifo_seq, enqueued_at) VALUES (?, ?, ?)').run(input.jobId, fifo, input.acceptedAt);
    this.#resequenceQueue();
    this.#event(input.jobId, 'enqueue', { requestId: input.requestId }, input.acceptedAt);
  }

  #dispatch(command: Extract<ApiWriteCommand, { kind: 'dispatch' }>): void {
    string(command.jobId, 'jobId'); runnerUnit(command.jobId, command.runnerUnit); instant(command.at, 'dispatch time');
    requirePersistedTimeline(this.#db, command.jobId, [['dispatch time', command.at]]);
    const job = this.#db.prepare('SELECT accepted_at FROM jobs WHERE job_id=?').get(command.jobId) as Row | undefined;
    if (!job) conflict('stale-predecessor', 'queued job does not exist');
    requireChronology([['accepted time', String(job.accepted_at)], ['dispatch time', command.at]]);
    const result = this.#db.prepare("UPDATE jobs SET state='starting', queue_state='dispatched', queue_position=NULL, dispatched_at=?, runner_unit=?, updated_at=? WHERE job_id=? AND state='queued' AND queue_state='queued' AND runner_unit IS NULL AND EXISTS (SELECT 1 FROM queue_entries AS candidate WHERE candidate.job_id=jobs.job_id AND candidate.fifo_seq=(SELECT MIN(first.fifo_seq) FROM queue_entries AS first JOIN jobs AS first_job ON first_job.job_id=first.job_id WHERE first_job.state='queued' AND first_job.queue_state='queued')) AND NOT EXISTS (SELECT 1 FROM jobs WHERE job_id=? AND cleanup_fence_generation IS NOT NULL)").run(command.at, command.runnerUnit, command.at, command.jobId, command.jobId);
    if (Number(result.changes) !== 1) conflict('stale-predecessor', 'queued job was already claimed');
    const queue = this.#db.prepare('DELETE FROM queue_entries WHERE job_id=?').run(command.jobId);
    if (Number(queue.changes) !== 1) conflict('cas-lost', 'FIFO queue claim lost its queue row');
    this.#resequenceQueue();
    this.#event(command.jobId, 'dispatch', { runnerUnit: command.runnerUnit }, command.at);
  }

  #requestCancellation(command: Extract<ApiWriteCommand, { kind: 'request-cancellation' }>): void {
    instant(command.at, 'cancellation time');
    const error = json(command.error ?? { reason: command.reason }, 'cancellation error', true);
    const row = this.#job(command.jobId);
    requirePersistedTimeline(this.#db, command.jobId, [['cancellation time', command.at]]);
    requireChronology([['accepted time', String(row.accepted_at)], ['cancellation time', command.at]]);
    if (row.state === 'publishing' || !ACTIVE_STATES.has(row.state as JobState) && row.state !== 'queued') conflict('illegal-predecessor', 'job cannot be cancelled by the API');
    if (row.state === 'queued') {
      const result = this.#db.prepare("UPDATE jobs SET state='cancelled', queue_state='cancelled', queue_position=NULL, cancel_requested_at=?, cancel_reason=?, terminal_at=?, terminal_error_code='CANCELLED', terminal_error_json=?, updated_at=? WHERE job_id=? AND state='queued' AND queue_state='queued'").run(command.at, command.reason, command.at, error, command.at, command.jobId);
      if (Number(result.changes) !== 1) conflict('stale-predecessor');
      this.#db.prepare('DELETE FROM queue_entries WHERE job_id=?').run(command.jobId);
      this.#resequenceQueue();
      this.#event(command.jobId, 'cancellation_requested', { reason: command.reason }, command.at);
      this.#event(command.jobId, 'terminal', { state: 'cancelled', errorCode: 'CANCELLED', error: JSON.parse(error!) as JsonObject }, command.at);
      return;
    }
    const result = this.#db.prepare('UPDATE jobs SET cancel_requested_at=?, cancel_reason=?, updated_at=? WHERE job_id=? AND state=? AND cancel_requested_at IS NULL AND cleanup_fence_generation IS NULL').run(command.at, command.reason, command.at, command.jobId, row.state as string);
    if (Number(result.changes) !== 1) conflict('cas-lost', 'cancellation request lost ownership');
    this.#event(command.jobId, 'cancellation_requested', { reason: command.reason }, command.at);
  }

  #freshnessRequest(command: Extract<ApiWriteCommand, { kind: 'freshness-request' }>): void {
    instant(command.at, 'freshness request time');
    const row = this.#job(command.jobId);
    requirePersistedTimeline(this.#db, command.jobId, [['freshness request time', command.at]]);
    requireChronology([['accepted time', String(row.accepted_at)], ['freshness request time', command.at]]);
    const result = this.#db.prepare('UPDATE jobs SET freshness_requested_at=?, updated_at=? WHERE job_id=? AND freshness_requested_at IS NULL').run(command.at, command.at, command.jobId);
    if (Number(result.changes) !== 1) conflict('cas-lost', 'freshness request already exists');
    this.#event(command.jobId, 'freshness', { requestedAt: command.at }, command.at);
  }

  #freshnessResult(command: Extract<ApiWriteCommand, { kind: 'freshness-result' }>): void {
    instant(command.at, 'freshness result time');
    const input = command.input;
    if (!['fresh', 'advanced', 'unknown'].includes(input.status)) throw new OwnershipValidationError('freshness status is invalid');
    if (!/^[0-9a-f]{40}$/.test(input.pinnedSha)) throw new OwnershipValidationError('freshness pinned SHA is invalid');
    if (input.observedSha !== null && !/^[0-9a-f]{40}$/.test(input.observedSha)) throw new OwnershipValidationError('freshness observed SHA is invalid');
    instant(input.checkedAt, 'freshness checked time');
    const errorJson = json(input.error, 'freshness error');
    if (input.status === 'fresh' && (input.observedSha !== input.pinnedSha || errorJson !== null || input.errorEvidencePath !== undefined || input.errorEvidenceSha256 !== undefined)) throw new OwnershipValidationError('freshness success evidence is incoherent');
    if (input.status === 'advanced' && (input.observedSha === null || errorJson !== null)) throw new OwnershipValidationError('freshness advanced evidence is incomplete');
    if (input.status === 'unknown' && (input.observedSha !== null || errorJson === null || !input.errorEvidencePath || !input.errorEvidenceSha256)) throw new OwnershipValidationError('freshness unknown evidence is incomplete');
    if (input.errorEvidencePath !== undefined || input.errorEvidenceSha256 !== undefined) {
      if (!input.errorEvidencePath || !input.errorEvidenceSha256) throw new OwnershipValidationError('freshness error evidence is incomplete');
      hash(input.errorEvidenceSha256, 'freshness error evidence SHA-256');
    }
    const row = this.#job(command.jobId);
    const same = row.freshness_status === input.status && row.freshness_observed_sha === input.observedSha && row.freshness_checked_at === input.checkedAt && row.freshness_error_json === errorJson && row.freshness_error_evidence_path === (input.errorEvidencePath ?? null) && row.freshness_error_evidence_sha256 === (input.errorEvidenceSha256 ?? null);
    if (row.freshness_status !== null) {
      if (!same) conflict('identity-mismatch', 'freshness result is immutable');
      return;
    }
    requirePersistedTimeline(this.#db, command.jobId, [['freshness result time', command.at], ['freshness checked time', input.checkedAt]]);
    if (row.pinned_sha !== input.pinnedSha) conflict('identity-mismatch', 'freshness result does not match pinned SHA');
    if (row.freshness_requested_at === null) conflict('stale-predecessor', 'freshness result has no request');
    const latestStage = this.#db.prepare("SELECT MAX(finished_at) AS finished_at FROM job_stages WHERE job_id=? AND finished_at IS NOT NULL").get(command.jobId) as Row;
    requireChronology([['accepted time', String(row.accepted_at)], ['freshness requested time', String(row.freshness_requested_at)], ['latest verification time', latestStage.finished_at === null ? null : String(latestStage.finished_at)], ['freshness checked time', input.checkedAt], ['freshness write time', command.at]]);
    const result = this.#db.prepare(`UPDATE jobs SET freshness_status=?, freshness_observed_sha=?, newer_source_available=?, freshness_checked_at=?, freshness_error_code=?, freshness_error_json=?, freshness_error_evidence_path=?, freshness_error_evidence_sha256=?, updated_at=?
      WHERE job_id=? AND freshness_requested_at=? AND pinned_sha=? AND freshness_status IS NULL`).run(input.status, input.observedSha, input.status === 'advanced' ? 1 : 0, input.checkedAt, input.status === 'unknown' ? 'FRESHNESS_UNKNOWN' : null, errorJson, input.errorEvidencePath ?? null, input.errorEvidenceSha256 ?? null, command.at, command.jobId, row.freshness_requested_at, input.pinnedSha);
    if (Number(result.changes) !== 1) conflict('cas-lost', 'freshness result CAS lost');
    this.#event(command.jobId, 'freshness', { status: input.status, checkedAt: input.checkedAt, observedSha: input.observedSha }, command.at);
  }

  #directInterrupt(command: Extract<ApiWriteCommand, { kind: 'direct-interrupt' }>): void {
    instant(command.at, 'interruption time'); const errorJson = json(command.error, 'interruption error', true);
    if (!isActiveState(command.expectedState)) conflict('illegal-predecessor', 'state is not recoverable by direct interruption');
    const row = this.#job(command.jobId); requirePersistedTimeline(this.#db, command.jobId, [['interruption time', command.at]]); validateDirectProof(this.#db, command.proof, row, command.at);
    const startFailure = command.proof.kind === 'start-failure';
    const logPredicate = command.proof.logs.runner === 'absent'
      ? 'AND NOT EXISTS (SELECT 1 FROM job_log_generations WHERE job_id=?)'
      : `AND EXISTS (SELECT 1 FROM job_log_generations WHERE job_id=? AND stream='runner')
            AND EXISTS (SELECT 1 FROM job_log_generations WHERE job_id=? AND stream='docker')
            AND NOT EXISTS (SELECT 1 FROM job_log_generations WHERE job_id=? AND sealed_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM job_log_generations WHERE job_id=? AND stream NOT IN ('runner', 'docker'))`;
    const logArguments = command.proof.logs.runner === 'absent' ? [command.jobId] : [command.jobId, command.jobId, command.jobId, command.jobId];
    const result = startFailure
      ? this.#db.prepare(`UPDATE jobs SET state='interrupted', queue_state='complete', queue_position=NULL, terminal_at=?, terminal_error_code=?, terminal_error_json=?, updated_at=?
          WHERE job_id=? AND state=? AND runner_unit=? AND runner_lease_owner IS NULL AND runner_lease_expires_at IS NULL AND cleanup_fence_generation IS NULL AND cleanup_admission_id IS NULL
            AND container_id IS NULL AND container_name IS NULL AND container_image_digest IS NULL AND container_label_job_id IS NULL AND container_label_manifest_sha IS NULL
            AND container_labels_json IS NULL AND artifact_staging_path IS NULL AND artifact_quarantine_path IS NULL AND publish_state IS NULL AND cleanup_blocker_code IS NULL AND cleanup_blocker_json IS NULL
            ${logPredicate}`).run(
          command.at, command.errorCode, errorJson, command.at, command.jobId, command.expectedState, command.proof.runnerUnit, ...logArguments)
      : this.#db.prepare(`UPDATE jobs SET state='interrupted', queue_state='complete', queue_position=NULL, terminal_at=?, terminal_error_code=?, terminal_error_json=?, updated_at=?
          WHERE job_id=? AND state=? AND runner_unit=? AND runner_lease_owner=? AND runner_lease_expires_at=? AND runner_lease_expires_at < ? AND cleanup_fence_generation IS NULL AND cleanup_admission_id IS NULL
            AND container_id IS NULL AND container_name IS NULL AND container_image_digest IS NULL AND container_label_job_id IS NULL AND container_label_manifest_sha IS NULL
            AND container_labels_json IS NULL AND artifact_staging_path IS NULL AND artifact_quarantine_path IS NULL AND publish_state IS NULL AND cleanup_blocker_code IS NULL AND cleanup_blocker_json IS NULL
            ${logPredicate}`).run(
          command.at, command.errorCode, errorJson, command.at, command.jobId, command.expectedState, command.proof.runnerUnit, command.proof.runnerLeaseOwner, command.proof.runnerLeaseExpiresAt, command.at, ...logArguments);
    if (Number(result.changes) !== 1) conflict('stale-predecessor', 'direct interruption proof no longer holds');
    this.#event(command.jobId, 'terminal', { state: 'interrupted', errorCode: command.errorCode, error: command.error }, command.at);
  }

  #publishRecovery(command: Extract<ApiWriteCommand, { kind: 'publish-recovery' }>): void {
    instant(command.at, 'publish recovery time');
    const row = this.#job(command.jobId); requirePersistedFacts(this.#db, command.jobId, [['publish recovery time', command.at], ['publish start time', command.evidence.final.publishStartedAt], ['published time', command.evidence.final.publishedAt]]); if (row.state !== command.expectedState) conflict('stale-predecessor', 'publishing recovery predecessor changed');
    validatePublishEvidence(this.#db, command.evidence, row, command.at, command.state);
    if (command.state === 'succeeded' && command.evidence.final.publishedAt !== null) throw new OwnershipValidationError('publishing recovery cannot claim a prior published timestamp');
    if (command.state === 'failed' && (!command.errorCode || !command.error)) throw new OwnershipValidationError('failed publish recovery requires error evidence');
    const errorJson = command.state === 'failed' ? json(command.error, 'publish recovery error', true) : null;
    const a = command.evidence.artifact; const f = command.evidence.final;
    this.#event(command.jobId, 'recovery', { kind: 'publish-recovery', state: command.state, evidence: command.evidence }, command.at);
    const result = command.state === 'succeeded'
      ? this.#db.prepare(`UPDATE jobs SET state='succeeded', queue_state='complete', queue_position=NULL, publish_state='published', artifact_staging_path=NULL,
          artifact_final_directory=?, artifact_final_path=?, publish_started_at=?, published_at=?, terminal_at=?, terminal_error_code=NULL, terminal_error_json=NULL, runner_finished_at=?, updated_at=?
        WHERE job_id=? AND state='publishing' AND publish_state='publishing' AND runner_unit=? AND runner_lease_owner=? AND runner_lease_expires_at=? AND runner_lease_expires_at < ?
          AND artifact_staging_path=? AND artifact_final_directory=? AND artifact_final_path=? AND artifact_sha256=? AND artifact_size=? AND artifact_mtime=? AND checksum_path=? AND checksum_sha256=? AND manifest_path=? AND manifest_sha256=? AND verification_path=? AND verification_sha256=?
          AND container_id IS NULL AND container_label_job_id IS NULL AND cleanup_fence_generation IS NULL AND cleanup_admission_id IS NULL`).run(f.directory, f.path, f.publishStartedAt, f.publishedAt ?? command.at, f.publishedAt ?? command.at, f.publishedAt ?? command.at, command.at, command.jobId, command.evidence.runner.unit, command.evidence.runner.owner, command.evidence.runner.leaseExpiresAt, command.at, a.stagingPath, f.directory, f.path, a.artifactSha256, a.artifactSize, a.artifactMtime, a.checksumPath, a.checksumSha256, a.manifestPath, a.manifestSha256, a.verificationPath, a.verificationSha256)
      : this.#db.prepare(`UPDATE jobs SET state='failed', queue_state='complete', queue_position=NULL, publish_state='blocked', artifact_final_directory=NULL, artifact_final_path=NULL,
          publish_started_at=NULL, published_at=NULL, publish_blocker_code=?, publish_blocker_json=?, terminal_at=?, terminal_error_code=?, terminal_error_json=?, updated_at=?
        WHERE job_id=? AND state='publishing' AND publish_state='publishing' AND runner_unit=? AND runner_lease_owner=? AND runner_lease_expires_at=? AND runner_lease_expires_at < ?
          AND artifact_staging_path=? AND artifact_final_directory=? AND artifact_final_path=? AND artifact_sha256=? AND artifact_size=? AND artifact_mtime=? AND checksum_path=? AND checksum_sha256=? AND manifest_path=? AND manifest_sha256=? AND verification_path=? AND verification_sha256=?
          AND container_id IS NULL AND container_label_job_id IS NULL AND cleanup_fence_generation IS NULL AND cleanup_admission_id IS NULL`).run('PUBLISH_RECOVERY_FAILED', errorJson, command.at, command.errorCode ?? null, errorJson, command.at, command.jobId, command.evidence.runner.unit, command.evidence.runner.owner, command.evidence.runner.leaseExpiresAt, command.at, a.stagingPath, f.directory, f.path, a.artifactSha256, a.artifactSize, a.artifactMtime, a.checksumPath, a.checksumSha256, a.manifestPath, a.manifestSha256, a.verificationPath, a.verificationSha256);
    if (Number(result.changes) !== 1) conflict('stale-predecessor', 'publishing recovery lost its recovery preconditions');
    this.#event(command.jobId, 'terminal', { state: command.state, recovery: true, finalDirectory: f.directory, finalPath: f.path }, command.at);
  }

  #cleanupAdmission(command: Extract<ApiWriteCommand, { kind: 'cleanup-admission' }>): void {
    instant(command.at, 'admission time'); instant(command.expiresAt, 'admission expiry');
    if (command.expiresAt <= command.at) conflict('stale-lease', 'cleanup admission expiry must be in the future');
    if (!ADMISSION_ID.test(command.admissionId)) throw new TypeError('admission ID is invalid');
    cleanupUnit(command.admissionId, command.unitName); hash(command.credentialSha256, 'credential SHA-256'); hash(command.fenceTokenHash, 'fence token hash');
    const row = this.#job(command.jobId);
    requirePersistedTimeline(this.#db, command.jobId, [['cleanup admission time', command.at]]);
    requireChronology([['accepted time', String(row.accepted_at)], ['cleanup admission time', command.at]]);
    if (!(isActiveState(row.state as JobState) || row.state === 'interrupted')) conflict('illegal-predecessor', 'state is not eligible for cleanup admission');
    const snapshot = validateCleanupSnapshot(this.#db, command.snapshot, row, command.at);
    if (row.runner_lease_expires_at === null && (row.state !== 'starting' || command.snapshot.runner.owner !== null || command.snapshot.runner.leaseExpiresAt !== null || command.snapshot.container.kind !== 'absent')) conflict('stale-lease', 'null-lease cleanup admission is only valid for a starting pre-container failure');
    if (row.runner_lease_expires_at !== null && row.runner_lease_expires_at >= command.at) conflict('stale-lease', 'runner lease is not stale');
    if (row.cleanup_fence_generation !== null || row.cleanup_admission_id !== null) conflict('fenced', 'job already has a cleanup admission');
    if (this.#db.prepare('SELECT 1 FROM cleanup_leases WHERE admission_id=?').get(command.admissionId)) conflict('admission-mismatch', 'cleanup admission already exists');
    const generation = Number(row.cleanup_generation) + 1;
    const lease = this.#db.prepare(`INSERT INTO cleanup_leases (admission_id, job_id, unit_name, owner, expires_at, status, credential_relative_path, credential_sha256,
      fence_generation, fence_token_hash, stale_runner_unit, stale_runner_owner, stale_runner_lease_expires_at, stale_state, stale_container_id, stale_container_name,
      stale_container_labels_json, proof_json, admitted_at) VALUES (?, ?, ?, ?, ?, 'admitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    lease.run(command.admissionId, command.jobId, command.unitName, command.owner, command.expiresAt, command.credentialRelativePath, command.credentialSha256,
      generation, command.fenceTokenHash, row.runner_unit, row.runner_lease_owner, row.runner_lease_expires_at, row.state, row.container_id, row.container_name, row.container_labels_json, snapshot, command.at);
    const result = this.#db.prepare(`UPDATE jobs SET cleanup_generation=?, cleanup_fence_generation=?, cleanup_fence_token_hash=?, cleanup_admission_id=?, updated_at=?
      WHERE job_id=? AND state=? AND ((runner_lease_expires_at IS NULL AND runner_lease_owner IS NULL) OR runner_lease_expires_at < ?) AND cleanup_fence_generation IS NULL AND cleanup_admission_id IS NULL`).run(generation, generation, command.fenceTokenHash, command.admissionId, command.at, command.jobId, row.state, command.at);
    if (Number(result.changes) !== 1) conflict('cas-lost', 'cleanup admission lost its fence CAS');
    this.#event(command.jobId, 'cleanup_admission', { admissionId: command.admissionId, generation }, command.at);
  }

  #handBack(command: Extract<ApiWriteCommand, { kind: 'hand-back' }>): void {
    instant(command.at, 'hand-back time'); cleanupUnit(command.admissionId, command.unitName); hash(command.fenceTokenHash, 'fence token hash');
    if (command.fenceGeneration <= 0) conflict('generation-mismatch', 'cleanup fence generation is invalid');
    if (command.proof.blocker !== 'none') throw new OwnershipValidationError('hand-back proof retains a cleanup blocker');
    const row = this.#job(command.jobId);
    requirePersistedFacts(this.#db, command.jobId, [['hand-back time', command.at], ['cleanup observation time', command.proof.runner.observedAt]]);
    requireChronology([['cleanup observation time', command.proof.runner.observedAt], ['hand-back time', command.at]]);
    const completion = this.#db.prepare("SELECT payload_json FROM job_events WHERE job_id=? AND event_type='cleanup_complete' ORDER BY seq DESC LIMIT 1").get(command.jobId) as Row | undefined;
    if (!completion) conflict('admission-mismatch', 'cleanup completion evidence is missing');
    let completionPayload: Record<string, unknown>;
    try { completionPayload = JSON.parse(String(completion.payload_json)) as Record<string, unknown>; } catch (error) { throw new OwnershipTransactionError('cleanup completion evidence is corrupt', { cause: error }); }
    if (completionPayload.admissionId !== command.admissionId || completionPayload.postcondition === undefined || typeof completionPayload.postcondition !== 'object' || completionPayload.postcondition === null) conflict('admission-mismatch', 'cleanup completion evidence does not match the admission');
    const completionPostcondition = completionPayload.postcondition as { logs?: LogCleanupProof };
    if (completionPostcondition.logs === undefined) conflict('admission-mismatch', 'cleanup completion log evidence is missing');
    reconcileCleanupLogs(this.#db, command.jobId, completionPostcondition.logs, command.at);
    validateNullContainerProof(command.proof.container, command.at);
    if (command.proof.runner.unit !== row.runner_unit || command.proof.runner.owner !== row.runner_lease_owner || command.proof.runner.leaseExpiresAt !== row.runner_lease_expires_at) conflict('stale-lease', 'hand-back snapshot does not match the job');
    const next = isActiveState(row.state as JobState) ? 'interrupted' : row.state as JobState;
    const terminal = next === 'interrupted' && row.state !== 'interrupted';
    const result = this.#db.prepare(`UPDATE jobs SET state=?, queue_state=CASE WHEN ?='interrupted' THEN 'complete' ELSE queue_state END, queue_position=NULL,
      terminal_at=CASE WHEN ?=1 THEN ? ELSE terminal_at END, terminal_error_code=CASE WHEN ?=1 THEN 'RUNNER_DISAPPEARED' ELSE terminal_error_code END,
      terminal_error_json=CASE WHEN ?=1 THEN ? ELSE terminal_error_json END, cleanup_fence_generation=NULL, cleanup_fence_token_hash=NULL, cleanup_admission_id=NULL,
      cleanup_blocker_code=NULL, cleanup_blocker_json=NULL, updated_at=? WHERE job_id=? AND state=? AND cleanup_fence_generation=? AND cleanup_fence_token_hash=?
      AND cleanup_admission_id=? AND container_id IS NULL AND container_name IS NULL AND container_image_digest IS NULL AND container_label_job_id IS NULL AND container_label_manifest_sha IS NULL AND container_labels_json IS NULL
      AND artifact_staging_path IS NULL AND (publish_state IS NULL OR publish_state NOT IN ('staged','publishing','blocked')) AND cleanup_blocker_code IS NULL AND cleanup_blocker_json IS NULL
      AND ((runner_lease_expires_at IS NULL AND runner_lease_owner IS NULL) OR runner_lease_expires_at < ?)
      AND NOT EXISTS (SELECT 1 FROM job_log_generations WHERE job_id=? AND sealed_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM cleanup_leases WHERE job_id=? AND status IN ('admitted','claimed','failed','blocking'))
      AND EXISTS (SELECT 1 FROM cleanup_leases WHERE admission_id=? AND job_id=? AND fence_generation=? AND fence_token_hash=? AND status='completed')`).run(
      next, next, terminal ? 1 : 0, command.at, terminal ? 1 : 0, terminal ? 1 : 0, terminal ? json({ reason: 'cleanup completed' }, 'hand-back error', true) : null,
      command.at, command.jobId, row.state, command.fenceGeneration, command.fenceTokenHash, command.admissionId, command.at, command.jobId, command.jobId, command.admissionId, command.jobId, command.fenceGeneration, command.fenceTokenHash,
    );
    if (Number(result.changes) !== 1) conflict('admission-mismatch', 'cleanup hand-back lost its fence CAS');
    const lease = this.#db.prepare(`UPDATE cleanup_leases SET status='handed_back', handback_at=? WHERE admission_id=? AND job_id=? AND owner=? AND unit_name=?
      AND fence_generation=? AND fence_token_hash=? AND status='completed'`).run(command.at, command.admissionId, command.jobId, command.owner, command.unitName, command.fenceGeneration, command.fenceTokenHash);
    if (Number(lease.changes) !== 1) conflict('admission-mismatch', 'cleanup lease is not completed by this worker');
    this.#event(command.jobId, 'recovery', { admissionId: command.admissionId, state: next }, command.at);
  }

  #acquireLease(command: Extract<RunnerWriteCommand, { kind: 'acquire-lease' }>): void {
    instant(command.at, 'runner start time'); instant(command.expiresAt, 'runner lease expiry'); runnerUnit(command.jobId, command.runnerUnit); string(command.owner, 'runner owner');
    const row = this.#job(command.jobId);
    if (row.state !== 'starting') conflict('stale-predecessor', 'runner lease predecessor changed');
    if (row.runner_unit !== command.runnerUnit) conflict('stale-runner-owner', 'runner identity changed');
    if (row.cleanup_fence_generation !== null || row.cleanup_admission_id !== null) conflict('fenced', 'runner is fenced for recovery');
    if (row.runner_lease_owner !== null || row.runner_lease_expires_at !== null) conflict('stale-predecessor', 'runner lease was already claimed');
    requirePersistedTimeline(this.#db, command.jobId, [['runner start time', command.at]]);
    requireChronology([['accepted time', String(row.accepted_at)], ['dispatch time', row.dispatched_at === null ? null : String(row.dispatched_at)], ['runner start time', command.at]]);
    if (command.expiresAt <= command.at) conflict('stale-lease', 'runner lease must be active');
    const result = this.#db.prepare(`UPDATE jobs SET runner_lease_owner=?, runner_lease_expires_at=?, runner_started_at=?, updated_at=? WHERE job_id=? AND state='starting' AND runner_unit=?
      AND runner_lease_owner IS NULL AND runner_lease_expires_at IS NULL AND cleanup_fence_generation IS NULL`).run(command.owner, command.expiresAt, command.at, command.at, command.jobId, command.runnerUnit);
    if (Number(result.changes) !== 1) conflict('stale-predecessor', 'runner lease was already claimed');
    this.#event(command.jobId, 'state', { state: 'starting', runnerOwner: command.owner }, command.at);
  }

  #renewLease(command: Extract<RunnerWriteCommand, { kind: 'renew-lease' }>): void {
    instant(command.at, 'runner renewal time'); instant(command.expectedExpiresAt, 'expected lease expiry'); instant(command.expiresAt, 'runner lease expiry'); runnerUnit(command.jobId, command.runnerUnit);
    if (command.expiresAt <= command.expectedExpiresAt || command.expiresAt <= command.at) conflict('stale-lease', 'runner lease renewal must advance the expiry');
    const row = this.#job(command.jobId);
    if (!isRunnerLeaseRenewableState(String(row.state) as JobState)) conflict('stale-predecessor', 'runner lease predecessor changed');
    if (row.runner_unit !== command.runnerUnit || row.runner_lease_owner !== command.owner) conflict('stale-runner-owner', 'runner identity changed');
    if (row.cleanup_fence_generation !== null || row.cleanup_admission_id !== null) conflict('fenced', 'runner is fenced for recovery');
    if (row.runner_lease_expires_at !== command.expectedExpiresAt) conflict('stale-lease', 'runner lease identity changed');
    requirePersistedTimeline(this.#db, command.jobId, [['runner renewal time', command.at], ['runner new expiry', command.expiresAt]]);
    requireChronology([['accepted time', String(row.accepted_at)], ['runner start time', row.runner_started_at === null ? null : String(row.runner_started_at)], ['runner renewal time', command.at]]);
    const result = this.#db.prepare(`UPDATE jobs SET runner_lease_expires_at=?, updated_at=? WHERE job_id=? AND state IN (${RUNNER_LEASE_RENEWABLE_STATE_SQL}) AND runner_unit=? AND runner_lease_owner=? AND runner_lease_expires_at=?
      AND runner_lease_expires_at > ? AND cleanup_fence_generation IS NULL`).run(command.expiresAt, command.at, command.jobId, command.runnerUnit, command.owner, command.expectedExpiresAt, command.at);
    if (Number(result.changes) !== 1) conflict('stale-lease', 'runner lease renewal lost ownership');
    this.#event(command.jobId, 'state', { state: 'runner_lease_renewed' }, command.at);
  }

  #cancellationTransition(command: Extract<RunnerWriteCommand, { kind: 'cancellation-transition' }>): void {
    this.#runnerGuard(command, command.expectedState);
    if (command.expectedState === 'cancel_requested' || !transition(command.expectedState, 'cancel_requested')) conflict('illegal-predecessor', 'cancellation transition is not in the state matrix');
    const result = this.#db.prepare("UPDATE jobs SET state='cancel_requested', updated_at=? WHERE job_id=? AND state=? AND runner_lease_owner=? AND runner_unit=? AND runner_lease_expires_at=? AND runner_lease_expires_at > ? AND cancel_requested_at IS NOT NULL AND cleanup_fence_generation IS NULL").run(command.at, command.jobId, command.expectedState, command.owner, command.runnerUnit, command.leaseExpiresAt, command.at);
    if (Number(result.changes) !== 1) conflict('cas-lost', 'cancellation transition lost ownership');
    this.#event(command.jobId, 'state', { state: 'cancel_requested' }, command.at);
  }

  #cancellationCleanup(command: Extract<RunnerWriteCommand, { kind: 'cancellation-cleanup' }>): void {
    this.#runnerGuard(command, 'cancel_requested');
    const row = this.#job(command.jobId); validateCancellationProof(command.proof, row, command.at);
    const stagingProof = command.proof.staging;
    if (stagingProof.kind === 'absent') {
      if (row.artifact_staging_path !== null) conflict('identity-mismatch', 'cancellation staging absence does not match persisted staging');
    } else {
      if (row.artifact_staging_path !== stagingProof.sourcePath || row.publish_state === null || (row.artifact_sha256 !== null && row.artifact_sha256 !== stagingProof.sha256) || (row.artifact_size !== null && Number(row.artifact_size) !== stagingProof.size)) conflict('identity-mismatch', 'cancellation quarantine evidence does not match persisted staging');
      const quarantine = this.#db.prepare(`UPDATE jobs SET publish_state='quarantined', artifact_staging_path=NULL, artifact_quarantine_path=?, publish_started_at=NULL, published_at=NULL, publish_blocker_code=NULL, publish_blocker_json=NULL, updated_at=?
        WHERE job_id=? AND state='cancel_requested' AND artifact_staging_path=? AND artifact_quarantine_path IS NULL AND cleanup_fence_generation IS NULL`).run(stagingProof.destinationPath, command.at, command.jobId, stagingProof.sourcePath);
      if (Number(quarantine.changes) !== 1) conflict('identity-mismatch', 'cancellation quarantine CAS lost');
    }
    if (command.proof.kind === 'container') {
      const c = command.proof.container;
      const clear = this.#db.prepare(`UPDATE jobs SET container_id=NULL, container_name=NULL, container_image_digest=NULL, container_label_job_id=NULL, container_label_manifest_sha=NULL,
        container_labels_json=NULL, container_mount_json=NULL, container_env_json=NULL, container_security_json=NULL, container_inspection_json=NULL, container_created_at=NULL,
        container_started_at=NULL, container_stopped_at=NULL, container_removed_at=NULL, container_cleanup_outcome=NULL, updated_at=?
        WHERE job_id=? AND state='cancel_requested' AND runner_unit=? AND runner_lease_owner=? AND runner_lease_expires_at=? AND container_id=? AND container_name=? AND container_image_digest=? AND container_label_job_id=? AND container_label_manifest_sha=? AND cleanup_fence_generation IS NULL`).run(
        command.at, command.jobId, command.runnerUnit, command.owner, command.leaseExpiresAt, c.id, c.name, c.imageDigest, command.jobId, row.target_manifest_sha256);
      if (Number(clear.changes) !== 1) conflict('identity-mismatch', 'cancellation container cleanup CAS lost');
    }
    this.#event(command.jobId, 'cleanup', { kind: 'cancellation-cleanup', proof: command.proof }, command.at);
  }

  #cancellationTerminal(command: Extract<RunnerWriteCommand, { kind: 'cancellation-terminal' }>): void {
    this.#runnerGuard(command, 'cancel_requested'); instant(command.terminalAt, 'cancellation terminal time');
    requirePersistedTimeline(this.#db, command.jobId, [['cancellation write time', command.at], ['cancellation terminal time', command.terminalAt]]);
    requireChronology([['cancellation terminal time', command.terminalAt], ['cancellation command time', command.at]]);
    if (!Number.isSafeInteger(command.cleanupEventSeq) || command.cleanupEventSeq < 0) throw new OwnershipValidationError('cancellation cleanup event sequence is invalid');
    const evidence = this.#db.prepare("SELECT payload_json FROM job_events WHERE job_id=? AND seq=? AND event_type='cleanup'").get(command.jobId, command.cleanupEventSeq) as Row | undefined;
    if (!evidence) conflict('stale-predecessor', 'cancellation cleanup evidence is missing');
    const payload = JSON.parse(String(evidence.payload_json)) as Record<string, unknown>;
    if (payload.kind !== 'cancellation-cleanup') conflict('identity-mismatch', 'cancellation cleanup event is not the required protocol step');
    const row = this.#job(command.jobId);
    if (row.container_id !== null || row.container_name !== null || row.container_image_digest !== null || row.container_label_job_id !== null || row.container_label_manifest_sha !== null || row.container_labels_json !== null || row.cleanup_blocker_code !== null || row.cleanup_blocker_json !== null || row.artifact_staging_path !== null) {
      conflict('identity-mismatch', 'cancellation cleanup did not clear all active identity and blockers');
    }
    const terminal = this.#db.prepare(`UPDATE jobs SET state='cancelled', queue_state='complete', queue_position=NULL, terminal_at=?, terminal_error_code='CANCELLED', terminal_error_json=?, runner_finished_at=?, updated_at=?
      WHERE job_id=? AND state='cancel_requested' AND runner_unit=? AND runner_lease_owner=? AND runner_lease_expires_at=? AND container_id IS NULL AND container_name IS NULL AND container_image_digest IS NULL AND container_label_job_id IS NULL AND container_label_manifest_sha IS NULL AND container_labels_json IS NULL AND artifact_staging_path IS NULL AND cleanup_blocker_code IS NULL AND cleanup_blocker_json IS NULL AND cleanup_fence_generation IS NULL`).run(
      command.terminalAt, json({ reason: 'cancelled' }, 'cancellation terminal error', true), command.terminalAt, command.at, command.jobId, command.runnerUnit, command.owner, command.leaseExpiresAt);
    if (Number(terminal.changes) !== 1) conflict('cas-lost', 'cancellation terminal CAS lost');
    this.#event(command.jobId, 'terminal', { state: 'cancelled', errorCode: 'CANCELLED', cleanupEventSeq: command.cleanupEventSeq }, command.terminalAt);
  }

  #stage(command: Extract<RunnerWriteCommand, { kind: 'stage' }>): void {
    this.#runnerGuard(command, command.expectedState);
    const job = this.#job(command.jobId);
    requirePersistedTimeline(this.#db, command.jobId, [['stage command time', command.at], ['stage start time', command.startedAt], ['stage finish time', command.finishedAt]], true);
    if (job.container_id !== null || job.container_name !== null || job.container_image_digest !== null || job.container_label_job_id !== null || job.container_label_manifest_sha !== null || job.container_labels_json !== null) conflict('identity-mismatch', 'stage requires cleared active container identity');
    instant(command.startedAt, 'stage start time'); if (command.finishedAt !== undefined && command.finishedAt !== null) instant(command.finishedAt, 'stage finish time');
    requireChronology([['stage start time', command.startedAt], ['stage finish time', command.finishedAt], ['stage write time', command.at]]);
    const timeline = this.#db.prepare('SELECT MAX(finished_at) AS finished_at FROM job_stages WHERE job_id=? AND stage<>? AND finished_at IS NOT NULL').get(command.jobId, command.stage) as Row;
    requireChronology([['accepted time', String(job.accepted_at)], ['prior stage finish time', timeline.finished_at === null ? null : String(timeline.finished_at)], ['stage start time', command.startedAt]]);
    if (!['running', 'passed', 'failed', 'cancelled', 'interrupted'].includes(command.outcome)) throw new OwnershipValidationError('stage outcome is invalid');
    const target = STAGE_STATE[command.stage];
    const stateIsStage = target === command.state;
    const stateKeepsPredecessor = command.outcome !== 'running' && command.state === command.expectedState;
    if ((!stateIsStage && !stateKeepsPredecessor) || (!stateKeepsPredecessor && !transition(command.expectedState, command.state))) conflict('illegal-predecessor', 'stage transition is not in the state matrix');
    const errorJson = json(command.error, 'stage error');
    if (command.outcome === 'running' && (command.finishedAt || command.evidencePath || command.errorCode || errorJson)) throw new TypeError('running stage has completion evidence');
    if (command.outcome !== 'running' && (!command.finishedAt || !command.evidencePath || !command.evidenceSha256 || !command.errorCode && command.outcome !== 'passed' || command.outcome !== 'passed' && !errorJson)) throw new TypeError('finished stage is missing evidence');
    if (command.evidenceSha256) hash(command.evidenceSha256, 'stage evidence SHA-256');
    const result = this.#db.prepare(`INSERT INTO job_stages (job_id, stage, outcome, started_at, finished_at, evidence_path, evidence_sha256, error_code, error_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_id, stage) DO UPDATE SET outcome=excluded.outcome, started_at=excluded.started_at, finished_at=excluded.finished_at,
      evidence_path=excluded.evidence_path, evidence_sha256=excluded.evidence_sha256, error_code=excluded.error_code, error_json=excluded.error_json`).run(
      command.jobId, command.stage, command.outcome, command.startedAt, command.finishedAt ?? null, command.evidencePath ?? null, command.evidenceSha256 ?? null, command.errorCode ?? null, errorJson,
    );
    if (Number(result.changes) !== 1) conflict('cas-lost');
    const update = this.#db.prepare('UPDATE jobs SET state=?, current_stage=?, updated_at=? WHERE job_id=? AND state=? AND runner_lease_owner=? AND runner_unit=? AND runner_lease_expires_at=? AND runner_lease_expires_at > ? AND cleanup_fence_generation IS NULL').run(command.state, command.stage, command.at, command.jobId, command.expectedState, command.owner, command.runnerUnit, command.leaseExpiresAt, command.at);
    if (Number(update.changes) !== 1) conflict('cas-lost', 'stage state CAS lost');
    this.#event(command.jobId, 'stage', { stage: command.stage, outcome: command.outcome }, command.at);
  }

  #container(command: Extract<RunnerWriteCommand, { kind: 'container' }>): void {
    this.#runnerGuard(command, ACTIVE_RECOVERY_STATES); hash(command.imageDigest, 'container image digest'); instant(command.occurredAt, 'container event time');
    if (!(CONTAINER_LIFECYCLES as readonly string[]).includes(command.lifecycle)) throw new OwnershipValidationError('container lifecycle is invalid');
    const row = this.#job(command.jobId); requirePersistedTimeline(this.#db, command.jobId, [['container command time', command.at], ['container occurred time', command.occurredAt], ['container created time', command.createdAt], ['container started time', command.startedAt], ['container stopped time', command.stoppedAt], ['container removed time', command.removedAt]]); const labelJson = labels(command.labels, String(row.job_id), String(row.target_manifest_sha256)); const mount = json(command.mount, 'container mount', true); const environment = json(command.environment, 'container environment', true);
    const security = json(command.security, 'container security', true); const inspection = json(command.inspection, 'container inspection', true);
    if (row.container_id !== null && row.container_id !== command.containerId) conflict('identity-mismatch', 'container ID changed');
    const created = command.createdAt ?? (command.lifecycle === 'created' ? command.occurredAt : null);
    const started = command.startedAt ?? (command.lifecycle === 'started' ? command.occurredAt : null);
    const stopped = command.stoppedAt ?? (command.lifecycle === 'stopped' ? command.occurredAt : null);
    const removed = command.removedAt ?? (command.lifecycle === 'removed' ? command.occurredAt : null);
    requireChronology([['accepted time', String(row.accepted_at)], ['persisted container created time', row.container_created_at === null ? null : String(row.container_created_at)], ['container created time', created], ['container started time', started], ['container stopped time', stopped], ['container removed time', removed], ['container event time', command.occurredAt], ['container write time', command.at]]);
    for (const [value, field] of [[created, 'createdAt'], [started, 'startedAt'], [stopped, 'stoppedAt'], [removed, 'removedAt']] as const) if (value) instant(value, field);
    requireChronology([['container created time', created], ['container started time', started], ['container stopped time', stopped], ['container removed time', removed], ['container event time', command.occurredAt], ['container write time', command.at]]);
    const result = this.#db.prepare(`UPDATE jobs SET container_id=?, container_name=?, container_image_digest=?, container_label_job_id=?, container_label_manifest_sha=?, container_labels_json=?,
      container_mount_json=?, container_env_json=?, container_security_json=?, container_inspection_json=?, container_created_at=COALESCE(container_created_at, ?),
      container_started_at=COALESCE(container_started_at, ?), container_stopped_at=COALESCE(container_stopped_at, ?), container_removed_at=COALESCE(container_removed_at, ?),
      container_cleanup_outcome=COALESCE(container_cleanup_outcome, ?), updated_at=? WHERE job_id=? AND state IN (${ACTIVE_RECOVERY_STATE_SQL})
      AND runner_lease_owner=? AND runner_unit=? AND runner_lease_expires_at=? AND runner_lease_expires_at > ? AND cleanup_fence_generation IS NULL
      AND (container_id IS NULL OR container_id=?)`).run(command.containerId, command.containerName, command.imageDigest, command.jobId, JSON.parse(labelJson)['org.osi.image-builder.manifest-sha'], labelJson, mount, environment, security, inspection, created, started, stopped, removed, command.cleanupOutcome ?? null, command.at, command.jobId, command.owner, command.runnerUnit, command.leaseExpiresAt, command.at, command.containerId);
    if (Number(result.changes) !== 1) conflict('cas-lost', 'runtime identity CAS lost');
    this.#event(command.jobId, 'container', { lifecycle: command.lifecycle, containerId: command.containerId }, command.at);
  }

  #validatePublishPreflight(command: Extract<RunnerWriteCommand, { kind: 'publish' }>): void {
    const row = this.#db.prepare('SELECT * FROM jobs WHERE job_id=?').get(command.jobId) as Row | undefined;
    if (!row || String(row.state) !== command.expectedState || row.runner_unit !== command.runnerUnit || row.runner_lease_owner !== command.owner || row.runner_lease_expires_at !== command.leaseExpiresAt || row.cleanup_fence_generation !== null || row.cleanup_admission_id !== null) return;
    validatePublishEffectiveSemantics(command, row);
  }

  #artifact(command: Extract<RunnerWriteCommand, { kind: 'artifact' }>): void {
    this.#runnerGuard(command, command.expectedState); const row = this.#job(command.jobId); requirePersistedTimeline(this.#db, command.jobId, [['artifact command time', command.at], ['artifact mtime', command.artifactMtime]]); if (!transition(command.expectedState, command.state) && command.expectedState !== command.state) conflict('illegal-predecessor');
    confinedPath(command.stagingPath, 'artifact staging path'); confinedPath(command.checksumPath, 'artifact checksum path'); confinedPath(command.manifestPath, 'artifact manifest path'); confinedPath(command.verificationPath, 'artifact verification path');
    for (const [value, field] of [[command.artifactSha256, 'artifact SHA-256'], [command.checksumSha256, 'checksum SHA-256'], [command.manifestSha256, 'manifest SHA-256'], [command.verificationSha256, 'verification SHA-256']] as const) hash(value, field);
    instant(command.artifactMtime, 'artifact mtime'); requireChronology([['accepted time', String(row.accepted_at)], ['artifact mtime', command.artifactMtime], ['artifact write time', command.at]]); if (!Number.isSafeInteger(command.artifactSize) || command.artifactSize < 0) throw new TypeError('artifact size is invalid');
    const result = this.#db.prepare(`UPDATE jobs SET publish_state='staged', artifact_staging_path=?, artifact_quarantine_path=NULL, artifact_final_directory=NULL, artifact_final_path=NULL,
      artifact_sha256=?, artifact_size=?, artifact_mtime=?, checksum_path=?, checksum_sha256=?, manifest_path=?, manifest_sha256=?, verification_path=?, verification_sha256=?,
      publish_started_at=NULL, published_at=NULL, publish_blocker_code=NULL, publish_blocker_json=NULL, updated_at=? WHERE job_id=? AND state=? AND runner_lease_owner=? AND runner_unit=?
      AND runner_lease_expires_at=? AND runner_lease_expires_at > ? AND cleanup_fence_generation IS NULL`).run(command.stagingPath, command.artifactSha256, command.artifactSize, command.artifactMtime, command.checksumPath, command.checksumSha256, command.manifestPath, command.manifestSha256, command.verificationPath, command.verificationSha256, command.at, command.jobId, command.expectedState, command.owner, command.runnerUnit, command.leaseExpiresAt, command.at);
    if (Number(result.changes) !== 1) conflict('cas-lost', 'artifact CAS lost');
    this.#event(command.jobId, 'artifact', { stagingPath: command.stagingPath, artifactSha256: command.artifactSha256 }, command.at);
  }

  #publish(command: Extract<RunnerWriteCommand, { kind: 'publish' }>): void {
    this.#runnerGuard(command, command.expectedState); const row = this.#job(command.jobId); if (!['staged', 'publishing', 'published', 'blocked'].includes(command.state)) throw new OwnershipValidationError('publish state is invalid'); if (command.startedAt !== undefined) instant(command.startedAt, 'publish start time'); if (command.publishedAt !== undefined) instant(command.publishedAt, 'publish finish time'); validatePublishEffectiveSemantics(command, row); requirePersistedTimeline(this.#db, command.jobId, [['publish command time', command.at], ['publish start time', command.startedAt], ['publish finish time', command.publishedAt]]); const now = command.at; let result;
    if (command.state === 'publishing') {
      if (!command.finalDirectory || !command.finalPath) throw new TypeError('publishing needs final paths');
      confinedPath(command.finalDirectory, 'publish final directory'); confinedPath(command.finalPath, 'publish final path');
      if (command.expectedState !== 'publishing' && !transition(command.expectedState, 'publishing')) conflict('illegal-predecessor', 'publish transition is not in the state matrix');
      result = this.#db.prepare(`UPDATE jobs SET state='publishing', publish_state='publishing', artifact_final_directory=?, artifact_final_path=?, publish_started_at=COALESCE(publish_started_at, ?), published_at=NULL, publish_blocker_code=NULL, publish_blocker_json=NULL, updated_at=? WHERE job_id=? AND state=? AND runner_lease_owner=? AND runner_unit=? AND runner_lease_expires_at=? AND runner_lease_expires_at > ? AND cleanup_fence_generation IS NULL`).run(command.finalDirectory, command.finalPath, command.startedAt ?? now, now, command.jobId, command.expectedState, command.owner, command.runnerUnit, command.leaseExpiresAt, now);
    } else if (command.state === 'published') {
      if (!command.finalDirectory || !command.finalPath) throw new TypeError('published needs final paths');
      confinedPath(command.finalDirectory, 'published final directory'); confinedPath(command.finalPath, 'published final path');
      result = this.#db.prepare(`UPDATE jobs SET publish_state='published', artifact_staging_path=NULL, artifact_final_directory=?, artifact_final_path=?, publish_started_at=COALESCE(publish_started_at, ?), published_at=?, artifact_quarantine_path=NULL, publish_blocker_code=NULL, publish_blocker_json=NULL, updated_at=? WHERE job_id=? AND state=? AND runner_lease_owner=? AND runner_unit=? AND runner_lease_expires_at=? AND runner_lease_expires_at > ? AND cleanup_fence_generation IS NULL`).run(command.finalDirectory, command.finalPath, command.startedAt ?? now, command.publishedAt ?? now, now, command.jobId, command.expectedState, command.owner, command.runnerUnit, command.leaseExpiresAt, now);
    } else if (command.state === 'staged') {
      result = this.#db.prepare("UPDATE jobs SET publish_state='staged', updated_at=? WHERE job_id=? AND state=? AND runner_lease_owner=? AND runner_unit=? AND runner_lease_expires_at=? AND runner_lease_expires_at > ? AND cleanup_fence_generation IS NULL").run(now, command.jobId, command.expectedState, command.owner, command.runnerUnit, command.leaseExpiresAt, now);
    } else {
      if (!command.blockerCode || !command.blocker) throw new TypeError('blocked publish needs blocker evidence');
      result = this.#db.prepare("UPDATE jobs SET publish_state='blocked', artifact_final_directory=NULL, artifact_final_path=NULL, publish_started_at=NULL, published_at=NULL, publish_blocker_code=?, publish_blocker_json=?, updated_at=? WHERE job_id=? AND state=? AND runner_lease_owner=? AND runner_unit=? AND runner_lease_expires_at=? AND runner_lease_expires_at > ? AND cleanup_fence_generation IS NULL").run(command.blockerCode, json(command.blocker, 'publish blocker', true), now, command.jobId, command.expectedState, command.owner, command.runnerUnit, command.leaseExpiresAt, now);
    }
    if (Number(result.changes) !== 1) conflict('cas-lost', 'publish CAS lost');
    this.#event(command.jobId, 'publish', { state: command.state }, now);
  }

  #normalTerminal(command: Extract<RunnerWriteCommand, { kind: 'normal-terminal' }>): void {
    this.#runnerGuard(command, command.expectedState); const row = this.#job(command.jobId); const errorJson = json(command.error, 'terminal error');
    if (command.state !== 'succeeded' && command.state !== 'failed') throw new OwnershipValidationError('terminal state is invalid');
    if (command.expectedState === 'cancel_requested') conflict('illegal-predecessor', 'cancellation requires the typed cleanup protocol');
    if (command.state === 'succeeded' && (command.errorCode || errorJson)) throw new TypeError('succeeded terminal cannot have an error');
    if (command.state !== 'succeeded' && (!command.errorCode || !errorJson)) throw new TypeError('failed terminal needs error evidence');
    instant(command.terminalAt, 'terminal time');
    requirePersistedTimeline(this.#db, command.jobId, [['terminal command time', command.at], ['terminal time', command.terminalAt]], true);
    const latestStage = this.#db.prepare("SELECT MAX(finished_at) AS finished_at FROM job_stages WHERE job_id=? AND finished_at IS NOT NULL").get(command.jobId) as Row;
    requireChronology([['accepted time', String(row.accepted_at)], ['runner start time', row.runner_started_at === null ? null : String(row.runner_started_at)], ['artifact mtime', row.artifact_mtime === null ? null : String(row.artifact_mtime)], ['publish start time', row.publish_started_at === null ? null : String(row.publish_started_at)], ['published time', row.published_at === null ? null : String(row.published_at)], ['terminal time', command.terminalAt], ['terminal write time', command.at]]);
    requireChronology([['accepted time', String(row.accepted_at)], ['latest stage finish time', latestStage.finished_at === null ? null : String(latestStage.finished_at)], ['terminal time', command.terminalAt], ['terminal write time', command.at]]);
    if (!transition(command.expectedState, command.state)) conflict('illegal-predecessor', 'terminal transition is not in the state matrix');
    const result = command.state === 'succeeded'
      ? this.#db.prepare(`UPDATE jobs SET state='succeeded', queue_state='complete', queue_position=NULL, terminal_at=?, terminal_error_code=NULL, terminal_error_json=NULL, runner_finished_at=?, updated_at=?
          WHERE job_id=? AND state=? AND publish_state='published' AND artifact_staging_path IS NULL AND artifact_final_directory IS NOT NULL AND artifact_final_path IS NOT NULL AND artifact_sha256 IS NOT NULL AND artifact_size IS NOT NULL AND artifact_mtime IS NOT NULL AND checksum_path IS NOT NULL AND checksum_sha256 IS NOT NULL AND manifest_path IS NOT NULL AND manifest_sha256 IS NOT NULL AND verification_path IS NOT NULL AND verification_sha256 IS NOT NULL AND publish_started_at IS NOT NULL AND published_at IS NOT NULL
            AND runner_lease_owner=? AND runner_unit=? AND runner_lease_expires_at=? AND runner_lease_expires_at > ? AND cleanup_fence_generation IS NULL`).run(command.terminalAt, command.terminalAt, command.at, command.jobId, command.expectedState, command.owner, command.runnerUnit, command.leaseExpiresAt, command.at)
      : this.#db.prepare(`UPDATE jobs SET state='failed', queue_state='complete', queue_position=NULL, terminal_at=?, terminal_error_code=?, terminal_error_json=?, runner_finished_at=?, updated_at=?
          WHERE job_id=? AND state=? AND runner_lease_owner=? AND runner_unit=? AND runner_lease_expires_at=? AND runner_lease_expires_at > ? AND cleanup_fence_generation IS NULL`).run(command.terminalAt, command.errorCode ?? null, errorJson, command.terminalAt, command.at, command.jobId, command.expectedState, command.owner, command.runnerUnit, command.leaseExpiresAt, command.at);
    if (Number(result.changes) !== 1) conflict('cas-lost', 'terminal CAS lost');
    this.#event(command.jobId, 'terminal', { state: command.state, errorCode: command.errorCode ?? null }, command.terminalAt);
  }

  #claimLease(command: Extract<CleanupWriteCommand, { kind: 'claim-lease' }>): void {
    instant(command.at, 'cleanup claim time'); cleanupUnit(command.admissionId, command.unitName); hash(command.fenceTokenHash, 'fence token hash');
    const row = this.#job(command.jobId); requirePersistedTimeline(this.#db, command.jobId, [['cleanup claim time', command.at]]); const admission = cleanupAdmissionSnapshot(this.#db, command.jobId, command.admissionId); validateCleanupSnapshot(this.#db, command.snapshot, row, command.at, 'worker', admission.snapshot);
    const admitted = this.#db.prepare('SELECT admitted_at, expires_at FROM cleanup_leases WHERE admission_id=? AND job_id=?').get(command.admissionId, command.jobId) as Row | undefined;
    if (!admitted) conflict('admission-mismatch', 'cleanup admission does not exist');
    requireChronology([['cleanup admitted time', String(admitted.admitted_at)], ['cleanup claim time', command.at]]);
    const result = this.#db.prepare(`UPDATE cleanup_leases SET status='claimed', claim_at=? WHERE admission_id=? AND job_id=? AND owner=? AND unit_name=? AND fence_generation=? AND fence_token_hash=? AND proof_json=? AND status='admitted' AND expires_at > ?
      AND EXISTS (SELECT 1 FROM jobs WHERE job_id=? AND cleanup_admission_id=? AND cleanup_fence_generation=? AND cleanup_fence_token_hash=?)`).run(command.at, command.admissionId, command.jobId, command.owner, command.unitName, command.fenceGeneration, command.fenceTokenHash, admission.raw, command.at, command.jobId, command.admissionId, command.fenceGeneration, command.fenceTokenHash);
    if (Number(result.changes) !== 1) conflict('admission-mismatch', 'cleanup claim does not match the active admission');
    this.#event(command.jobId, 'cleanup_claim', { admissionId: command.admissionId }, command.at);
  }

  #renewCleanupLease(command: Extract<CleanupWriteCommand, { kind: 'renew-lease' }>): void {
    instant(command.at, 'cleanup renewal time'); instant(command.expectedExpiresAt, 'expected cleanup expiry'); instant(command.expiresAt, 'cleanup expiry'); cleanupUnit(command.admissionId, command.unitName); hash(command.fenceTokenHash, 'fence token hash');
    if (command.expiresAt <= command.at) conflict('stale-lease', 'cleanup lease expiry must be in the future');
    if (command.expiresAt <= command.expectedExpiresAt) conflict('stale-lease', 'cleanup lease renewal must advance the expiry');
    const row = this.#job(command.jobId); requirePersistedTimeline(this.#db, command.jobId, [['cleanup renewal time', command.at], ['cleanup new expiry', command.expiresAt]]); const admission = cleanupAdmissionSnapshot(this.#db, command.jobId, command.admissionId); validateCleanupSnapshot(this.#db, command.snapshot, row, command.at, 'worker', admission.snapshot);
    const leaseTimeline = this.#db.prepare('SELECT admitted_at, claim_at, expires_at FROM cleanup_leases WHERE admission_id=? AND job_id=?').get(command.admissionId, command.jobId) as Row | undefined;
    if (!leaseTimeline) conflict('admission-mismatch', 'cleanup lease does not exist');
    requireChronology([['cleanup admitted time', String(leaseTimeline.admitted_at)], ['cleanup claim time', leaseTimeline.claim_at === null ? null : String(leaseTimeline.claim_at)], ['cleanup renewal time', command.at]]);
    const result = this.#db.prepare('UPDATE cleanup_leases SET expires_at=?, renew_at=? WHERE admission_id=? AND job_id=? AND owner=? AND unit_name=? AND fence_generation=? AND fence_token_hash=? AND proof_json=? AND status=\'claimed\' AND expires_at=? AND expires_at > ? AND EXISTS (SELECT 1 FROM jobs WHERE job_id=? AND cleanup_admission_id=? AND cleanup_fence_generation=? AND cleanup_fence_token_hash=?)').run(command.expiresAt, command.at, command.admissionId, command.jobId, command.owner, command.unitName, command.fenceGeneration, command.fenceTokenHash, admission.raw, command.expectedExpiresAt, command.at, command.jobId, command.admissionId, command.fenceGeneration, command.fenceTokenHash);
    if (Number(result.changes) !== 1) conflict('stale-lease', 'cleanup renewal lost ownership');
    this.#event(command.jobId, 'cleanup_renew', { admissionId: command.admissionId }, command.at);
  }

  #completeCleanup(command: Extract<CleanupWriteCommand, { kind: 'complete' }>): void {
    instant(command.at, 'cleanup completion time'); cleanupUnit(command.admissionId, command.unitName); hash(command.fenceTokenHash, 'fence token hash'); hash(command.evidenceSha256, 'cleanup evidence SHA-256'); json({ evidencePath: command.evidencePath }, 'cleanup evidence', true);
    if (command.containerAbsent !== true) throw new OwnershipValidationError('cleanup completion must prove container absence');
    const row = this.#job(command.jobId); requirePersistedTimeline(this.#db, command.jobId, [['cleanup completion time', command.at]]); const admission = cleanupAdmissionSnapshot(this.#db, command.jobId, command.admissionId); validateCleanupSnapshot(this.#db, command.snapshot, row, command.at, 'worker', admission.snapshot); const snapshotJson = admission.raw;
    const leaseTimeline = this.#db.prepare('SELECT admitted_at, claim_at, renew_at, expires_at FROM cleanup_leases WHERE admission_id=? AND job_id=?').get(command.admissionId, command.jobId) as Row | undefined;
    if (!leaseTimeline) conflict('admission-mismatch', 'cleanup lease does not exist');
    requireChronology([['cleanup admitted time', String(leaseTimeline.admitted_at)], ['cleanup claim time', leaseTimeline.claim_at === null ? null : String(leaseTimeline.claim_at)], ['cleanup renew time', leaseTimeline.renew_at === null ? null : String(leaseTimeline.renew_at)], ['cleanup completion time', command.at]]);
    validateCleanupPostcondition(this.#db, command.postcondition, admission.snapshot, row, command.at);
    const present = command.postcondition.container.kind === 'removed';
    if (present) {
      if (command.exactContainerId === null || command.postcondition.container.id !== command.exactContainerId) conflict('identity-mismatch', 'cleanup completion requires the exact admitted container');
    } else if (command.exactContainerId !== null) {
      conflict('identity-mismatch', 'null-container cleanup cannot claim an exact container');
    } else if (command.snapshot.blocker === 'staging-or-log' && command.snapshot.staging.kind === 'absent' && row.cleanup_blocker_code === null) {
      conflict('identity-mismatch', 'null-container cleanup requires persisted blocker evidence');
    } else if (command.snapshot.blocker === 'none' && row.cleanup_blocker_code !== null) {
      conflict('identity-mismatch', 'null-container cleanup snapshot omits persisted blocker evidence');
    }
    if (command.postcondition.logs.runner === 'sealed' || command.postcondition.logs.docker === 'sealed') {
      const unsealed = this.#db.prepare("SELECT 1 FROM job_log_generations WHERE job_id=? AND sealed_at IS NULL LIMIT 1").get(command.jobId);
      if (unsealed) conflict('identity-mismatch', 'cleanup log blocker is not sealed in the database');
    }
    const quarantineUpdate = command.postcondition.staging.kind === 'quarantined'
      ? 'artifact_staging_path=NULL, artifact_quarantine_path=?, publish_state=\'quarantined\', publish_started_at=NULL, published_at=NULL, '
      : '';
    const quarantineParams = command.postcondition.staging.kind === 'quarantined' ? [command.postcondition.staging.destinationPath] : [];
    const result = present
      ? this.#db.prepare(`UPDATE jobs SET container_id=NULL, container_name=NULL, container_image_digest=NULL, container_label_job_id=NULL, container_label_manifest_sha=NULL,
          container_labels_json=NULL, container_mount_json=NULL, container_env_json=NULL, container_security_json=NULL, container_inspection_json=NULL, container_created_at=NULL,
          container_started_at=NULL, container_stopped_at=NULL, container_removed_at=NULL, container_cleanup_outcome=NULL, ${quarantineUpdate}updated_at=? WHERE job_id=? AND container_id=? AND cleanup_admission_id=?
          AND cleanup_fence_generation=? AND cleanup_fence_token_hash=? AND EXISTS (SELECT 1 FROM cleanup_leases WHERE admission_id=? AND job_id=? AND owner=? AND unit_name=? AND fence_generation=? AND fence_token_hash=? AND proof_json=? AND status='claimed' AND expires_at > ?)`).run(...quarantineParams, command.at, command.jobId, command.exactContainerId, command.admissionId, command.fenceGeneration, command.fenceTokenHash, command.admissionId, command.jobId, command.owner, command.unitName, command.fenceGeneration, command.fenceTokenHash, snapshotJson, command.at)
      : this.#db.prepare(`UPDATE jobs SET cleanup_blocker_code=NULL, cleanup_blocker_json=NULL, ${quarantineUpdate}updated_at=? WHERE job_id=? AND container_id IS NULL AND container_name IS NULL AND container_image_digest IS NULL AND container_labels_json IS NULL AND cleanup_admission_id=?
          AND cleanup_fence_generation=? AND cleanup_fence_token_hash=? AND EXISTS (SELECT 1 FROM cleanup_leases WHERE admission_id=? AND job_id=? AND owner=? AND unit_name=? AND fence_generation=? AND fence_token_hash=? AND proof_json=? AND status IN ('claimed','blocking') AND expires_at > ?)`).run(...quarantineParams, command.at, command.jobId, command.admissionId, command.fenceGeneration, command.fenceTokenHash, command.admissionId, command.jobId, command.owner, command.unitName, command.fenceGeneration, command.fenceTokenHash, snapshotJson, command.at);
    if (Number(result.changes) !== 1) conflict('identity-mismatch', 'cleanup completion identity or lease changed');
    const lease = this.#db.prepare(`UPDATE cleanup_leases SET status='completed', blocker_code=NULL, blocker_json=NULL, complete_at=?, completion_evidence_path=?, completion_evidence_sha256=? WHERE admission_id=? AND job_id=? AND owner=? AND unit_name=? AND fence_generation=? AND fence_token_hash=? AND proof_json=? AND status IN ('claimed','blocking') AND expires_at > ?`).run(command.at, command.evidencePath, command.evidenceSha256, command.admissionId, command.jobId, command.owner, command.unitName, command.fenceGeneration, command.fenceTokenHash, snapshotJson, command.at);
    if (Number(lease.changes) !== 1) conflict('admission-mismatch', 'cleanup completion lease CAS lost');
    this.#event(command.jobId, 'cleanup_complete', { admissionId: command.admissionId, evidencePath: command.evidencePath, postcondition: command.postcondition }, command.at);
  }

  #cleanupEvidence(command: Extract<CleanupWriteCommand, { kind: 'evidence' }>): void {
    instant(command.at, 'cleanup evidence time'); cleanupUnit(command.admissionId, command.unitName); hash(command.fenceTokenHash, 'fence token hash'); const blocker = json(command.blocker, 'cleanup blocker', true);
    if (command.status !== 'failed' && command.status !== 'blocking') throw new OwnershipValidationError('cleanup evidence status is invalid');
    const row = this.#job(command.jobId); requirePersistedTimeline(this.#db, command.jobId, [['cleanup evidence time', command.at]]); const admission = cleanupAdmissionSnapshot(this.#db, command.jobId, command.admissionId); validateCleanupSnapshot(this.#db, command.snapshot, row, command.at, 'worker', admission.snapshot); const snapshotJson = admission.raw;
    const leaseTimeline = this.#db.prepare('SELECT admitted_at, claim_at, renew_at FROM cleanup_leases WHERE admission_id=? AND job_id=?').get(command.admissionId, command.jobId) as Row | undefined;
    if (!leaseTimeline) conflict('admission-mismatch', 'cleanup lease does not exist');
    requireChronology([['cleanup admitted time', String(leaseTimeline.admitted_at)], ['cleanup claim time', leaseTimeline.claim_at === null ? null : String(leaseTimeline.claim_at)], ['cleanup renew time', leaseTimeline.renew_at === null ? null : String(leaseTimeline.renew_at)], ['cleanup evidence time', command.at]]);
    if (command.snapshot.blocker !== 'staging-or-log') throw new OwnershipValidationError('cleanup blocker evidence requires a blocker snapshot');
    const result = this.#db.prepare("UPDATE cleanup_leases SET status=?, blocker_code=?, blocker_json=? WHERE admission_id=? AND job_id=? AND owner=? AND unit_name=? AND fence_generation=? AND fence_token_hash=? AND proof_json=? AND status='claimed' AND expires_at > ? AND EXISTS (SELECT 1 FROM jobs WHERE job_id=? AND cleanup_admission_id=? AND cleanup_fence_generation=? AND cleanup_fence_token_hash=?)").run(command.status, command.blockerCode, blocker, command.admissionId, command.jobId, command.owner, command.unitName, command.fenceGeneration, command.fenceTokenHash, snapshotJson, command.at, command.jobId, command.admissionId, command.fenceGeneration, command.fenceTokenHash);
    if (Number(result.changes) !== 1) conflict('admission-mismatch', 'cleanup evidence lease CAS lost');
    const jobResult = this.#db.prepare('UPDATE jobs SET cleanup_blocker_code=?, cleanup_blocker_json=?, updated_at=? WHERE job_id=? AND cleanup_admission_id=? AND cleanup_fence_generation=? AND cleanup_fence_token_hash=? AND cleanup_blocker_code IS NULL AND cleanup_blocker_json IS NULL').run(command.blockerCode, blocker, command.at, command.jobId, command.admissionId, command.fenceGeneration, command.fenceTokenHash);
    if (Number(jobResult.changes) !== 1) conflict('admission-mismatch', 'cleanup blocker persistence CAS lost');
    this.#event(command.jobId, 'cleanup', { admissionId: command.admissionId, status: command.status, blockerCode: command.blockerCode }, command.at);
  }

  #operationBegin(command: Extract<RunnerWriteCommand, { kind: 'operation-begin' }>): void {
    this.#runnerGuard(command, command.expectedState); instant(command.startedAt, 'operation start time');
    requirePersistedTimeline(this.#db, command.jobId, [['operation command time', command.at], ['operation start time', command.startedAt]], true);
    const job = this.#job(command.jobId);
    const previous = this.#db.prepare("SELECT MAX(finished_at) AS finished_at FROM job_operations WHERE job_id=? AND finished_at IS NOT NULL").get(command.jobId) as Row;
    requireChronology([['accepted time', String(job.accepted_at)], ['prior operation finish time', previous.finished_at === null ? null : String(previous.finished_at)], ['operation start time', command.startedAt], ['operation write time', command.at]]);
    if (job.container_id !== null || job.container_name !== null || job.container_image_digest !== null || job.container_labels_json !== null) conflict('identity-mismatch', 'next operation requires cleared active container identity');
    if (!TRUSTED_OPERATION_IDS.includes(command.operationId) || !Number.isSafeInteger(command.attempt) || command.attempt <= 0) throw new OwnershipValidationError('operation identity is invalid');
    hash(command.argvHash, 'operation argv hash'); const argv = jsonValue(command.argv, 'operation argv', 'array');
    if (Buffer.byteLength(argv, 'utf8') > TEXT_LIMITS.maxArgvBytes) throw new OwnershipValidationError('operation argv exceeds the argv byte limit');
    const existing = this.#db.prepare('SELECT argv_hash, argv_json, started_at, outcome FROM job_operations WHERE job_id=? AND operation_id=? AND attempt=?').get(command.jobId, command.operationId, command.attempt) as Row | undefined;
    if (existing) {
      if (existing.outcome !== null || existing.argv_hash !== command.argvHash || existing.argv_json !== argv || existing.started_at !== command.startedAt) conflict('identity-mismatch', 'operation retry identity is immutable');
      return;
    }
    this.#db.prepare(`INSERT INTO job_operations (job_id, operation_id, attempt, argv_hash, argv_json, started_at, timed_out, lifecycle_phase)
      VALUES (?, ?, ?, ?, ?, ?, 0, 'not_created')`).run(command.jobId, command.operationId, command.attempt, command.argvHash, argv, command.startedAt);
    this.#event(command.jobId, 'operation', { operationId: command.operationId, attempt: command.attempt, phase: 'begin' }, command.at);
  }

  #operationComplete(command: Extract<RunnerWriteCommand, { kind: 'operation-complete' }>): void {
    const priorOperation = this.#db.prepare('SELECT outcome FROM job_operations WHERE job_id=? AND operation_id=? AND attempt=?').get(command.jobId, command.operationId, command.attempt) as Row | undefined;
    this.#runnerGuard(command, command.expectedState, priorOperation?.outcome !== null && priorOperation?.outcome !== undefined);
    const input = command.input;
    if (priorOperation?.outcome === null || priorOperation === undefined) requirePersistedTimeline(this.#db, command.jobId, [['operation completion command time', command.at], ['operation start time', input.startedAt], ['operation finish time', input.finishedAt]], true);
    if (!['not_created', 'created', 'started', 'stopped', 'removed'].includes(input.lifecyclePhase) || !['passed', 'failed'].includes(input.outcome)) throw new OwnershipValidationError('operation result enum is invalid');
    const job = this.#job(command.jobId);
    if (input.operationId !== command.operationId || input.attempt !== command.attempt) conflict('identity-mismatch', 'operation completion identity does not match its command');
    if (!TRUSTED_OPERATION_IDS.includes(input.operationId) || !Number.isSafeInteger(input.attempt) || input.attempt <= 0) throw new OwnershipValidationError('operation identity is invalid');
    hash(input.argvHash, 'operation argv hash'); hash(input.evidenceSha256, 'operation evidence SHA-256');
    const argv = jsonValue(input.argv, 'operation argv', 'array');
    if (Buffer.byteLength(argv, 'utf8') > TEXT_LIMITS.maxArgvBytes) throw new OwnershipValidationError('operation argv exceeds the argv byte limit');
    const errorJson = json(input.error, 'operation error');
    const mount = input.containerMount === undefined || input.containerMount === null ? null : jsonValue(input.containerMount, 'operation mount', 'object');
    const environment = input.containerEnvironment === undefined || input.containerEnvironment === null ? null : jsonValue(input.containerEnvironment, 'operation environment', 'object');
    const security = input.containerSecurity === undefined || input.containerSecurity === null ? null : jsonValue(input.containerSecurity, 'operation security', 'object');
    const inspection = input.inspection === undefined || input.inspection === null ? null : jsonValue(input.inspection, 'operation inspection', 'object');
    instant(input.startedAt, 'operation start time'); if (input.finishedAt !== undefined && input.finishedAt !== null) instant(input.finishedAt, 'operation finish time'); requireChronology([['operation start time', input.startedAt], ['operation finish time', input.finishedAt]]);
    if (input.finishedAt === undefined || input.finishedAt === null || (input.outcome === 'passed' && (input.exitCode !== 0 || input.timedOut)) || (input.outcome === 'failed' && !input.errorCode)) throw new OwnershipValidationError('operation completion evidence is incomplete');
    if (input.lifecyclePhase === 'not_created') {
      if (input.containerId !== undefined || input.containerName !== undefined || input.containerImageDigest !== undefined || input.containerLabelJobId !== undefined || input.containerLabelManifestSha !== undefined || mount !== null || environment !== null || security !== null || inspection !== null) throw new OwnershipValidationError('pre-container operation result contains container evidence');
    } else {
      if (!input.containerId || !input.containerName || !input.containerImageDigest || !input.containerLabelJobId || !input.containerLabelManifestSha || mount === null || environment === null || security === null || inspection === null) throw new OwnershipValidationError('container operation result is incomplete');
      hash(input.containerImageDigest, 'operation container image digest'); hash(input.containerLabelManifestSha, 'operation manifest label');
      if (input.containerLabelJobId !== command.jobId || job.container_id !== input.containerId || job.container_name !== input.containerName || job.container_image_digest !== input.containerImageDigest || job.container_label_job_id !== input.containerLabelJobId || job.container_label_manifest_sha !== input.containerLabelManifestSha) conflict('identity-mismatch', 'operation container identity does not match the active job container');
      const persistedLabels = job.container_labels_json;
      if (persistedLabels !== labels({ 'org.osi.image-builder.job-id': command.jobId, 'org.osi.image-builder.manifest-sha': String(job.target_manifest_sha256) }, command.jobId, String(job.target_manifest_sha256))) conflict('identity-mismatch', 'operation container labels are not persisted exactly');
      if (job.container_mount_json !== mount || job.container_env_json !== environment || job.container_security_json !== security || job.container_inspection_json !== inspection) conflict('identity-mismatch', 'operation container evidence is not persisted exactly');
    }
    const existing = this.#db.prepare('SELECT * FROM job_operations WHERE job_id=? AND operation_id=? AND attempt=?').get(command.jobId, input.operationId, input.attempt) as Row | undefined;
    if (!existing) conflict('stale-predecessor', 'operation begin is required before completion');
    if (existing.outcome === null) requireChronology([['accepted time', String(job.accepted_at)], ['persisted operation start time', String(existing.started_at)], ['operation start time', input.startedAt], ['operation finish time', input.finishedAt], ['operation write time', command.at]]);
    if (existing.outcome !== null) {
      const same = existing.finished_at === input.finishedAt
        && existing.container_id === (input.containerId ?? null)
        && existing.container_name === (input.containerName ?? null)
        && existing.container_image_digest === (input.containerImageDigest ?? null)
        && existing.container_label_job_id === (input.containerLabelJobId ?? null)
        && existing.container_label_manifest_sha === (input.containerLabelManifestSha ?? null)
        && existing.container_mount_json === mount
        && existing.container_env_json === environment
        && existing.container_security_json === security
        && existing.inspection_json === inspection
        && Number(existing.timed_out) === (input.timedOut ? 1 : 0)
        && existing.lifecycle_phase === input.lifecyclePhase
        && (existing.exit_code === null ? null : Number(existing.exit_code)) === (input.exitCode ?? null)
        && existing.signal === (input.signal ?? null)
        && existing.outcome === input.outcome
        && existing.evidence_path === input.evidencePath
        && existing.evidence_sha256 === input.evidenceSha256
        && existing.error_code === (input.errorCode ?? null)
        && existing.error_json === errorJson
        && existing.argv_hash === input.argvHash
        && existing.argv_json === argv
        && existing.started_at === input.startedAt;
      if (!same) conflict('identity-mismatch', 'committed operation evidence is immutable');
      return;
    }
    const result = this.#db.prepare(`UPDATE job_operations SET finished_at=?, container_id=?, container_name=?, container_image_digest=?, container_label_job_id=?, container_label_manifest_sha=?,
      container_mount_json=?, container_env_json=?, container_security_json=?, inspection_json=?, timed_out=?, lifecycle_phase=?, exit_code=?, signal=?, outcome=?, evidence_path=?, evidence_sha256=?, error_code=?, error_json=?
      WHERE job_id=? AND operation_id=? AND attempt=? AND outcome IS NULL AND argv_hash=? AND argv_json=? AND started_at=?`).run(
      input.finishedAt, input.containerId ?? null, input.containerName ?? null, input.containerImageDigest ?? null, input.containerLabelJobId ?? null, input.containerLabelManifestSha ?? null,
      mount, environment, security, inspection, input.timedOut ? 1 : 0, input.lifecyclePhase, input.exitCode ?? null, input.signal ?? null, input.outcome, input.evidencePath, input.evidenceSha256, input.errorCode ?? null, errorJson,
      command.jobId, input.operationId, input.attempt, input.argvHash, argv, input.startedAt,
    );
    if (Number(result.changes) !== 1) conflict('cas-lost', 'operation completion CAS lost');
    this.#event(command.jobId, 'operation', { operationId: input.operationId, attempt: input.attempt, phase: 'complete', outcome: input.outcome }, command.at);
  }

  #operationCleanup(command: Extract<RunnerWriteCommand, { kind: 'operation-cleanup' }>): void {
    this.#runnerGuard(command, command.expectedState);
    const row = this.#job(command.jobId);
    const operation = this.#db.prepare('SELECT outcome, lifecycle_phase FROM job_operations WHERE job_id=? AND operation_id=? AND attempt=?').get(command.jobId, command.operationId, command.attempt) as Row | undefined;
    if (!operation || operation.outcome === null) conflict('stale-predecessor', 'operation result must be committed before cleanup');
    if (command.proof.kind === 'null-identity') {
      validateNullContainerProof(command.proof.container, command.at);
      validateCleanupProof(command.proof.logs, 'logs');
      if (row.container_id !== null || row.container_name !== null || row.container_image_digest !== null || row.container_labels_json !== null) conflict('identity-mismatch', 'null operation cleanup conflicts with active identity');
    } else {
      const proof = command.proof;
      if (operation.lifecycle_phase === 'not_created') conflict('identity-mismatch', 'container cleanup cannot follow a pre-container operation result');
      hash(proof.imageDigest, 'operation cleanup image digest');
      const persistedLabels = labels(proof.labels, command.jobId, String(row.target_manifest_sha256));
      if (row.container_id !== proof.id || row.container_name !== proof.name || row.container_image_digest !== proof.imageDigest || row.container_labels_json !== persistedLabels) conflict('identity-mismatch', 'operation cleanup identity does not match the job');
      instant(proof.stoppedAt, 'operation container stopped time'); instant(proof.removedAt, 'operation container removed time'); instant(proof.observedAt, 'operation container absence time');
      if (proof.removedAt < proof.stoppedAt || proof.observedAt < proof.removedAt || proof.stoppedAt > command.at || proof.removedAt > command.at || proof.observedAt > command.at || proof.globalLabelResult !== 'no-match') throw new OwnershipValidationError('operation cleanup absence proof is incomplete');
      validateCleanupProof(proof.logs, 'logs');
    }
    const result = command.proof.kind === 'container-removed'
      ? this.#db.prepare(`UPDATE jobs SET container_id=NULL, container_name=NULL, container_image_digest=NULL, container_label_job_id=NULL, container_label_manifest_sha=NULL, container_labels_json=NULL,
          container_mount_json=NULL, container_env_json=NULL, container_security_json=NULL, container_inspection_json=NULL, container_created_at=NULL, container_started_at=NULL, container_stopped_at=NULL, container_removed_at=NULL, container_cleanup_outcome=NULL, updated_at=?
        WHERE job_id=? AND state=? AND runner_unit=? AND runner_lease_owner=? AND runner_lease_expires_at=? AND cleanup_fence_generation IS NULL AND container_id=? AND container_name=? AND container_image_digest=? AND container_labels_json=?`).run(command.at, command.jobId, command.expectedState, command.runnerUnit, command.owner, command.leaseExpiresAt, command.proof.id, command.proof.name, command.proof.imageDigest, labels(command.proof.labels, command.jobId, String(row.target_manifest_sha256)))
      : this.#db.prepare(`UPDATE jobs SET updated_at=? WHERE job_id=? AND state=? AND runner_unit=? AND runner_lease_owner=? AND runner_lease_expires_at=? AND cleanup_fence_generation IS NULL AND container_id IS NULL AND container_name IS NULL AND container_image_digest IS NULL AND container_labels_json IS NULL`).run(command.at, command.jobId, command.expectedState, command.runnerUnit, command.owner, command.leaseExpiresAt);
    if (Number(result.changes) !== 1) conflict('cas-lost', 'operation cleanup CAS lost');
    this.#event(command.jobId, 'cleanup', { kind: 'operation-cleanup', operationId: command.operationId, attempt: command.attempt, proof: command.proof }, command.at);
  }

  #resequenceQueue(): void {
    this.#db.prepare(`WITH ordered AS (
      SELECT j.job_id, ROW_NUMBER() OVER (ORDER BY q.fifo_seq) - 1 AS position
      FROM queue_entries AS q JOIN jobs AS j ON j.job_id=q.job_id
      WHERE j.queue_state='queued'
    )
    UPDATE jobs SET queue_position=ordered.position
    FROM ordered
    WHERE jobs.job_id=ordered.job_id AND jobs.queue_state='queued'`).run();
  }

  #runnerGuard(command: CommonRunner, expectedState: JobState | readonly JobState[] | undefined, skipLatest = false): void {
    instant(command.at, 'runner write time'); instant(command.leaseExpiresAt, 'runner lease expiry'); runnerUnit(command.jobId, command.runnerUnit); string(command.owner, 'runner owner');
    const row = this.#job(command.jobId);
    if (expectedState !== undefined && !matchesExpectedState(String(row.state), expectedState)) conflict('stale-predecessor', 'runner predecessor changed');
    if (row.runner_unit !== command.runnerUnit || row.runner_lease_owner !== command.owner) conflict('stale-runner-owner', 'runner identity changed');
    if (row.cleanup_fence_generation !== null || row.cleanup_admission_id !== null) conflict('fenced', 'runner is fenced for recovery');
    if (!skipLatest) requirePersistedTimeline(this.#db, command.jobId, [['runner command time', command.at]]);
    if (row.runner_lease_expires_at !== command.leaseExpiresAt || row.runner_lease_expires_at <= command.at) conflict('stale-lease', 'runner lease is stale');
  }

  #job(jobId: string): Row {
    const row = this.#db.prepare('SELECT * FROM jobs WHERE job_id=?').get(jobId) as Row | undefined;
    if (!row) throw new OwnershipValidationError(`job not found: ${jobId}`);
    return row;
  }

  #event(jobId: string, type: string, payload: JsonObject, at: string): number {
    if (!EVENT_TYPES.has(type)) throw new TypeError(`event type is not allowed: ${type}`);
    instant(at, 'event time'); const body = json(payload, 'event payload', true);
    try { this.#beforeEvent?.(); }
    catch (error) { throw new OwnershipTransactionError('ownership event hook failed', { cause: error }); }
    const row = this.#db.prepare('SELECT jobs.state AS state, jobs.current_stage AS current_stage, COALESCE(MAX(job_events.seq) + 1, 0) AS seq FROM jobs LEFT JOIN job_events ON job_events.job_id=jobs.job_id WHERE jobs.job_id=?').get(jobId) as Row;
    this.#db.prepare('INSERT INTO job_events (job_id, seq, event_type, state, stage, payload_json, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(jobId, Number(row.seq), type, row.state, row.current_stage ?? null, body, at);
    this.#eventSeq = Number(row.seq);
    return Number(row.seq);
  }
}
