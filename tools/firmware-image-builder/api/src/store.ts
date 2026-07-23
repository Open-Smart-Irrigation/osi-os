import { DatabaseSync } from 'node:sqlite';
import {
  PIPELINE_STAGE_NAMES,
  TRUSTED_OPERATION_IDS,
  type BuilderErrorCode,
  type FreshnessState,
  type JobState,
  type PipelineStageName,
  type TargetId,
  type TrustedOperationId,
} from '../../domain/types.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | Readonly<{ readonly [key: string]: JsonValue }>;
export type JsonObject = Readonly<{ readonly [key: string]: JsonValue }>;
export const JSON_LIMITS = Object.freeze({
  maxDepth: 16,
  maxKeys: 256,
  maxArrayElements: 256,
  maxNodes: 512,
  maxEdges: 1_024,
  maxEncodedBytes: 65_536,
});
export const EVENT_PAGE_DEFAULT_LIMIT = 100;
export const EVENT_PAGE_MAX_LIMIT = 1_000;
type PublishState = 'staged' | 'publishing' | 'published' | 'quarantined' | 'blocked';
type StageOutcome = 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted';
type LifecyclePhase = 'not_created' | 'created' | 'started' | 'stopped' | 'removed';

const HASH40 = /^[0-9a-f]{40}$/;
const HASH64 = /^[0-9a-f]{64}$/;
const EVENT_TYPES = [
  'enqueue', 'cancellation_requested', 'dispatch', 'state', 'stage', 'operation', 'container',
  'artifact', 'publish', 'terminal', 'cleanup_admission', 'cleanup_claim', 'cleanup_renew',
  'cleanup_complete', 'cleanup', 'recovery', 'freshness', 'log', 'log_orphan_tail', 'log-gap',
  'log-truncated',
] as const;
type EventType = (typeof EVENT_TYPES)[number];

interface JsonBudget {
  nodes: number;
  edges: number;
}

function normalizeJson(value: unknown, field: string, depth = 0, seen = new WeakSet<object>(), budget: JsonBudget = { nodes: 0, edges: 0 }): JsonValue {
  budget.nodes += 1;
  if (budget.nodes > JSON_LIMITS.maxNodes) throw new StoreValidationError(`${field} exceeds JSON node limit`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new StoreValidationError(`${field} contains a non-finite number`);
    return value;
  }
  if (typeof value !== 'object') throw new StoreValidationError(`${field} contains a non-JSON value`);
  if (depth >= JSON_LIMITS.maxDepth) throw new StoreValidationError(`${field} exceeds JSON depth limit`);
  if (seen.has(value)) throw new StoreValidationError(`${field} contains a cyclic reference`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > JSON_LIMITS.maxArrayElements) throw new StoreValidationError(`${field} exceeds JSON array limit`);
      return value.map((item, index) => {
        budget.edges += 1;
        if (budget.edges > JSON_LIMITS.maxEdges) throw new StoreValidationError(`${field} exceeds JSON edge limit`);
        return normalizeJson(item, `${field}[${index}]`, depth + 1, seen, budget);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new StoreValidationError(`${field} contains a non-plain object`);
    const keys = Object.keys(value);
    if (keys.length > JSON_LIMITS.maxKeys) throw new StoreValidationError(`${field} exceeds JSON object key limit`);
    const object = Object.create(null) as Record<string, JsonValue>;
    for (const key of keys.sort()) {
      budget.edges += 1;
      if (budget.edges > JSON_LIMITS.maxEdges) throw new StoreValidationError(`${field} exceeds JSON edge limit`);
      const normalized = normalizeJson((value as Record<string, unknown>)[key], `${field}.${key}`, depth + 1, seen, budget);
      Object.defineProperty(object, key, { configurable: true, enumerable: true, value: normalized, writable: true });
    }
    return object;
  } catch (error) {
    if (error instanceof StoreValidationError) throw error;
    throw new StoreValidationError(`${field} is not valid JSON`, { cause: error });
  } finally {
    seen.delete(value);
  }
}

function encodeJson(value: unknown, field: string, objectOnly = false): string {
  if (objectOnly && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw new StoreValidationError(`${field} must be a JSON object`);
  }
  const normalized = normalizeJson(value, field);
  const encoded = JSON.stringify(normalized);
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > JSON_LIMITS.maxEncodedBytes) {
    throw new StoreValidationError(`${field} exceeds encoded JSON byte limit`);
  }
  return encoded;
}

const assertJsonObject = (value: unknown, field: string): string => encodeJson(value, field, true);

const parseJsonObject = (value: string | null, field: string): JsonObject | null => {
  if (value === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (error) {
    throw new StoreDataError(`${field} contains invalid JSON`, { cause: error });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StoreDataError(`${field} is not a JSON object`);
  }
  return normalizeJson(parsed, field) as JsonObject;
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
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (error) {
    throw new StoreDataError(`${field} contains invalid JSON`, { cause: error });
  }
  const bounded = normalizeJson(parsed, field);
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

export interface SourceIdentity {
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

export interface JobRecord extends SourceIdentity {
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
  readonly terminalErrorCode: BuilderErrorCode | null;
  readonly terminalError: JsonObject | null;
  readonly terminalAt: string | null;
  readonly artifactStagingPath: string | null;
  readonly artifactQuarantinePath: string | null;
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
  readonly outcome: 'passed' | 'failed';
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
  readonly outcome: 'passed' | 'failed' | null;
  readonly evidencePath: string | null;
  readonly evidenceSha256: string | null;
  readonly errorCode: BuilderErrorCode | null;
  readonly error: JsonObject | null;
}

export interface BuilderStoreOptions {
  readonly now?: () => string;
  readonly failBeforeCommit?: () => void;
}

type DbRow = Record<string, unknown>;

const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function canonicalInstant(value: string, field: string): string {
  if (typeof value !== 'string' || !CANONICAL_INSTANT.test(value)) {
    throw new StoreValidationError(`${field} must be a canonical RFC3339 UTC instant`);
  }
  try {
    if (new Date(value).toISOString() !== value) throw new Error('noncanonical instant');
  } catch (error) {
    throw new StoreValidationError(`${field} is not a valid instant`, { cause: error });
  }
  return value;
}

function optionalInstant(value: string | null | undefined, field: string): string | null {
  return value === undefined || value === null ? null : canonicalInstant(value, field);
}

function requireChronology(values: readonly (readonly [string, string | null])[]): void {
  let previous: [string, string] | null = null;
  for (const [field, value] of values) {
    if (value === null) continue;
    if (previous !== null && previous[1] > value) {
      throw new StoreValidationError(`${field} must not precede ${previous[0]}`);
    }
    previous = [field, value];
  }
}

function requireHash(value: string, pattern: RegExp, field: string): void {
  if (!pattern.test(value)) throw new StoreValidationError(`${field} must be a lowercase hexadecimal hash`);
}

function asString(row: DbRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new StoreDataError(`SQLite column ${key} is not text`);
  return value;
}

function nullableString(row: DbRow, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : asString(row, key);
}

function nullableNumber(row: DbRow, key: string): number | null {
  const value = row[key];
  return value === null || value === undefined ? null : Number(value);
}

export class BuilderStore {
  readonly #db: DatabaseSync;
  readonly #now: () => string;
  readonly #failBeforeCommit?: () => void;
  #savepointSequence = 0;

  constructor(db: DatabaseSync, options: BuilderStoreOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#failBeforeCommit = options.failBeforeCommit;
  }

  close(): void { this.#db.close(); }

  createJob(input: CreateJobInput): void {
    const preflight = this.validateCreateJob(input);
    const requestJson = assertJsonObject(input.request, 'request');
    this.transaction(() => {
      const fifoSeq = Number((this.#db.prepare('SELECT COALESCE(MAX(fifo_seq) + 1, 0) AS fifo_seq FROM queue_entries').get() as DbRow).fifo_seq);
      const queuePosition = Number((this.#db.prepare("SELECT COUNT(*) AS count FROM queue_entries q JOIN jobs j ON j.job_id = q.job_id WHERE j.queue_state = 'queued'").get() as DbRow).count);
      this.#db.prepare(`INSERT INTO jobs (
        job_id, request_id, request_json, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha,
        target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject,
        preflight_sha, preflight_checked_at, preflight_expires_at, accepted_at, state, queue_state, queue_position, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', ?, ?, ?)`)
        .run(
          input.jobId, input.requestId, requestJson, input.sourceRemote, input.sourceRef,
          input.sourceBranch, input.branch, input.expectedSha, input.pinnedSha, input.targetId, input.rootId,
          input.targetManifestSha256, input.sourceCommitTime, input.sourceAuthor, input.sourceSubject,
          preflight.sha, preflight.checkedAt, preflight.expiresAt,
          input.acceptedAt, queuePosition, input.acceptedAt, input.acceptedAt,
        );
      this.#db.prepare('INSERT INTO queue_entries (job_id, fifo_seq, enqueued_at) VALUES (?, ?, ?)')
        .run(input.jobId, fifoSeq, input.acceptedAt);
      this.appendEvent(input.jobId, 'enqueue', { requestId: input.requestId });
    });
  }

  getJob(jobId: string): JobRecord {
    const row = this.#db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as DbRow | undefined;
    if (!row) throw new StoreNotFoundError(`job not found: ${jobId}`);
    return this.mapJob(row);
  }

  getQueuePosition(jobId: string): number | null {
    const row = this.#db.prepare("SELECT COUNT(*) AS count FROM queue_entries q JOIN jobs j ON j.job_id = q.job_id WHERE q.fifo_seq < COALESCE((SELECT fifo_seq FROM queue_entries WHERE job_id = ?), -1) AND j.queue_state = 'queued'").get(jobId) as DbRow;
    const entry = this.#db.prepare("SELECT queue_state FROM jobs WHERE job_id = ?").get(jobId) as DbRow | undefined;
    if (!entry) throw new StoreNotFoundError(`job not found: ${jobId}`);
    if (entry.queue_state !== 'queued') return null;
    return Number(row.count);
  }

  requestCancellation(jobId: string, reason: string, at = this.now('cancellation time')): void {
    at = canonicalInstant(at, 'cancellation time');
    this.transaction(() => {
      const job = this.getJob(jobId);
      requireChronology([['acceptedAt', job.acceptedAt], ['existing cancellation time', job.cancelRequestedAt], ['cancellation time', at]]);
      this.#db.prepare('UPDATE jobs SET cancel_requested_at = ?, cancel_reason = ?, updated_at = ? WHERE job_id = ?')
        .run(at, reason, at, jobId);
      this.appendEvent(jobId, 'cancellation_requested', { reason }, undefined, at);
    });
  }

  getSourceIdentity(jobId: string): SourceIdentity {
    const job = this.getJob(jobId);
    return {
      sourceRemote: job.sourceRemote, sourceRef: job.sourceRef, sourceBranch: job.sourceBranch, branch: job.branch,
      expectedSha: job.expectedSha, pinnedSha: job.pinnedSha, sourceCommitTime: job.sourceCommitTime,
      sourceAuthor: job.sourceAuthor, sourceSubject: job.sourceSubject,
    };
  }

  setSourceIdentity(jobId: string, identity: SourceIdentity): void {
    this.validateSourceIdentity(identity);
    const current = this.getSourceIdentity(jobId);
    const fields: readonly (keyof SourceIdentity)[] = [
      'sourceRemote', 'sourceRef', 'sourceBranch', 'branch', 'expectedSha', 'pinnedSha',
      'sourceCommitTime', 'sourceAuthor', 'sourceSubject',
    ];
    if (fields.some((field) => current[field] !== identity[field])) {
      throw new StoreConflictError('accepted source identity is immutable');
    }
  }

  claimNextQueued(runnerUnit: string, at = this.now('dispatch time')): QueueClaim | null {
    at = canonicalInstant(at, 'dispatch time');
    const match = /^osi-image-builder-runner@(.+)\.service$/.exec(runnerUnit);
    if (!match?.[1]) throw new StoreValidationError('runner unit is invalid');
    return this.transaction(() => {
      const row = this.#db.prepare("SELECT q.job_id, q.fifo_seq FROM queue_entries q JOIN jobs j ON j.job_id = q.job_id WHERE j.queue_state = 'queued' AND j.state = 'queued' ORDER BY q.fifo_seq, q.job_id LIMIT 1").get() as DbRow | undefined;
      if (!row) return null;
      const jobId = asString(row, 'job_id');
      const fifoSeq = Number(row.fifo_seq);
      const job = this.getJob(jobId);
      requireChronology([['acceptedAt', job.acceptedAt], ['dispatch time', at]]);
      this.#db.prepare('DELETE FROM queue_entries WHERE job_id = ?').run(jobId);
      this.#db.prepare("UPDATE jobs SET state = 'starting', queue_state = 'dispatched', queue_position = NULL, dispatched_at = ?, runner_unit = ?, updated_at = ? WHERE job_id = ?").run(at, runnerUnit, at, jobId);
      this.resequenceQueue();
      this.appendEvent(jobId, 'dispatch', { runnerUnit }, undefined, at);
      return { jobId, fifoSeq, runnerUnit };
    });
  }

  recordStage(jobId: string, input: StageInput): void {
    this.validateStage(input);
    this.transaction(() => {
      this.requireJob(jobId);
      const existing = this.#db.prepare('SELECT evidence_path, evidence_sha256 FROM job_stages WHERE job_id = ? AND stage = ?').get(jobId, input.stage) as DbRow | undefined;
      const existingStartedAt = existing ? nullableString(existing, 'started_at') : null;
      const existingFinishedAt = existing ? nullableString(existing, 'finished_at') : null;
      requireChronology([['existing stage startedAt', existingStartedAt], ['stage startedAt', input.startedAt], ['existing stage finishedAt', existingFinishedAt], ['stage finishedAt', input.finishedAt ?? null]]);
      if (existingFinishedAt !== null && input.finishedAt == null) throw new StoreValidationError('completed stage cannot return to running');
      const existingPath = existing ? nullableString(existing, 'evidence_path') : null;
      const existingSha256 = existing ? nullableString(existing, 'evidence_sha256') : null;
      if (existingPath !== null || existingSha256 !== null) {
        if (existingPath !== input.evidencePath || existingSha256 !== input.evidenceSha256) {
          throw new StoreConflictError(`evidence reference is immutable: ${jobId}/${input.stage}`);
        }
      }
      this.#db.prepare(`INSERT INTO job_stages (job_id, stage, outcome, started_at, finished_at, evidence_path, evidence_sha256, error_code, error_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id, stage) DO UPDATE SET outcome=excluded.outcome, started_at=excluded.started_at,
          finished_at=excluded.finished_at, evidence_path=excluded.evidence_path, evidence_sha256=excluded.evidence_sha256,
          error_code=excluded.error_code, error_json=excluded.error_json`).run(
        jobId, input.stage, input.outcome, input.startedAt, input.finishedAt ?? null, input.evidencePath ?? null,
        input.evidenceSha256 ?? null, input.errorCode ?? null, jsonOrNull(input.error, 'stage error'),
      );
      this.#db.prepare('UPDATE jobs SET current_stage = ?, updated_at = ? WHERE job_id = ?').run(input.stage, this.now(), jobId);
      this.appendEvent(jobId, 'stage', this.payload(input), input.stage);
    });
  }

  getStage(jobId: string, stage: PipelineStageName): StoredStage | null {
    const row = this.#db.prepare('SELECT * FROM job_stages WHERE job_id = ? AND stage = ?').get(jobId, stage) as DbRow | undefined;
    return row ? this.mapStage(row) : null;
  }

  recordOperation(jobId: string, input: OperationInput): void {
    this.validateOperation(input);
    const argvJson = encodeJson(input.argv, 'operation argv');
    const operationJson = {
      mount: jsonOrNull(input.containerMount, 'operation mount'),
      environment: jsonOrNull(input.containerEnvironment, 'operation environment'),
      security: jsonOrNull(input.containerSecurity, 'operation security'),
      inspection: jsonOrNull(input.inspection, 'operation inspection'),
      error: jsonOrNull(input.error, 'operation error'),
    };
    this.transaction(() => {
      const job = this.getJob(jobId);
      if (input.lifecyclePhase === 'not_created') {
        if (input.containerId !== null && input.containerId !== undefined) throw new StoreValidationError('pre-container operation cannot have a container ID');
        if (input.containerName !== null && input.containerName !== undefined) throw new StoreValidationError('pre-container operation cannot have a container name');
      } else if (input.containerLabelJobId !== jobId || input.containerLabelManifestSha !== job.targetManifestSha256) {
        throw new StoreValidationError('operation container labels do not match the job');
      }
      const existingRow = this.#db.prepare('SELECT * FROM job_operations WHERE job_id = ? AND operation_id = ? AND attempt = ?').get(jobId, input.operationId, input.attempt) as DbRow | undefined;
      if (existingRow && nullableString(existingRow, 'outcome') !== null) {
        const stored = this.mapOperation(existingRow);
        if (this.operationMatchesInput(stored, input)) return;
        throw new StoreConflictError(`completed operation result is immutable: ${jobId}/${input.operationId}/${input.attempt}`);
      }
      const values = [
        jobId, input.operationId, input.attempt, input.argvHash, argvJson, input.startedAt,
        input.finishedAt ?? null, input.containerId ?? null, input.containerName ?? null, input.containerImageDigest ?? null,
        input.containerLabelJobId ?? null, input.containerLabelManifestSha ?? null, operationJson.mount,
        operationJson.environment, operationJson.security, operationJson.inspection, input.timedOut ? 1 : 0, input.lifecyclePhase,
        input.exitCode ?? null, input.signal ?? null, input.outcome, input.evidencePath, input.evidenceSha256,
        input.errorCode ?? null, operationJson.error,
      ];
      if (existingRow) {
        this.#db.prepare(`UPDATE job_operations SET argv_hash=?, argv_json=?, started_at=?, finished_at=?, container_id=?, container_name=?,
          container_image_digest=?, container_label_job_id=?, container_label_manifest_sha=?, container_mount_json=?, container_env_json=?,
          container_security_json=?, inspection_json=?, timed_out=?, lifecycle_phase=?, exit_code=?, signal=?, outcome=?, evidence_path=?,
          evidence_sha256=?, error_code=?, error_json=? WHERE job_id=? AND operation_id=? AND attempt=?`).run(...values.slice(3), jobId, input.operationId, input.attempt);
      } else {
        this.#db.prepare(`INSERT INTO job_operations (job_id, operation_id, attempt, argv_hash, argv_json, started_at, finished_at, container_id,
          container_name, container_image_digest, container_label_job_id, container_label_manifest_sha, container_mount_json, container_env_json,
          container_security_json, inspection_json, timed_out, lifecycle_phase, exit_code, signal, outcome, evidence_path, evidence_sha256,
          error_code, error_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...values);
      }
      this.appendEvent(jobId, 'operation', this.payload(input));
    });
  }

  getOperation(jobId: string, operationId: TrustedOperationId, attempt: number): StoredOperation | null {
    const row = this.#db.prepare('SELECT * FROM job_operations WHERE job_id = ? AND operation_id = ? AND attempt = ?').get(jobId, operationId, attempt) as DbRow | undefined;
    return row ? this.mapOperation(row) : null;
  }

  recordEvidenceReference(jobId: string, input: { readonly stage: PipelineStageName; readonly path: string; readonly sha256: string }): void {
    requireHash(input.sha256, HASH64, 'evidence sha256');
    this.transaction(() => {
      this.requireJob(jobId);
      const row = this.#db.prepare('SELECT evidence_path, evidence_sha256 FROM job_stages WHERE job_id = ? AND stage = ?').get(jobId, input.stage) as DbRow | undefined;
      if (!row) throw new StoreNotFoundError(`stage not found: ${jobId}/${input.stage}`);
      const existingPath = nullableString(row, 'evidence_path');
      const existingSha256 = nullableString(row, 'evidence_sha256');
      if (existingPath !== null || existingSha256 !== null) {
        if (existingPath === input.path && existingSha256 === input.sha256) return;
        throw new StoreConflictError(`evidence reference is immutable: ${jobId}/${input.stage}`);
      }
      const result = this.#db.prepare('UPDATE job_stages SET evidence_path = ?, evidence_sha256 = ? WHERE job_id = ? AND stage = ?').run(input.path, input.sha256, jobId, input.stage);
      if (Number(result.changes) !== 1) throw new StoreNotFoundError(`stage not found: ${jobId}/${input.stage}`);
      this.appendEvent(jobId, 'stage', { evidencePath: input.path, evidenceSha256: input.sha256 }, input.stage);
    });
  }

  recordRuntimeDiagnostics(jobId: string, input: RuntimeDiagnosticsInput): void {
    requireHash(input.imageDigest, HASH64, 'container image digest');
    requireHash(input.targetManifestSha256, HASH64, 'target manifest SHA-256');
    canonicalInstant(input.occurredAt, 'container occurredAt');
    const suppliedCreatedAt = optionalInstant(input.createdAt, 'container createdAt');
    const suppliedStartedAt = optionalInstant(input.startedAt, 'container startedAt');
    const suppliedStoppedAt = optionalInstant(input.stoppedAt, 'container stoppedAt');
    const suppliedRemovedAt = optionalInstant(input.removedAt, 'container removedAt');
    requireChronology([
      ['container createdAt', suppliedCreatedAt], ['container startedAt', suppliedStartedAt],
      ['container stoppedAt', suppliedStoppedAt], ['container removedAt', suppliedRemovedAt],
    ]);
    assertJsonObject(input.labels, 'container labels');
    assertJsonObject(input.mount, 'container mount');
    assertJsonObject(input.environment, 'container environment');
    assertJsonObject(input.security, 'container security');
    assertJsonObject(input.inspection, 'container inspection');
    this.transaction(() => {
      const job = this.getJob(jobId);
      if (job.targetManifestSha256 !== input.targetManifestSha256) throw new StoreValidationError('runtime manifest SHA does not match the job');
      assertContainerLabels(input.labels, jobId, input.targetManifestSha256);
      if (job.containerCreatedAt === null && input.lifecycle !== 'created' && suppliedCreatedAt === null) {
        throw new StoreValidationError('container lifecycle requires an existing or supplied createdAt');
      }
      if (job.containerId !== null && job.containerId !== input.containerId) throw new StoreConflictError('container identity is immutable');
      if (job.containerName !== null && job.containerName !== input.containerName) throw new StoreConflictError('container name is immutable');
      if (job.containerImageDigest !== null && job.containerImageDigest !== input.imageDigest) throw new StoreConflictError('container image digest is immutable');
      const createdAt = this.retainTimestamp(job.containerCreatedAt, input.createdAt, input.lifecycle === 'created' ? input.occurredAt : null, 'container createdAt');
      const startedAt = this.retainTimestamp(job.containerStartedAt, input.startedAt, input.lifecycle === 'started' ? input.occurredAt : null, 'container startedAt');
      const stoppedAt = this.retainTimestamp(job.containerStoppedAt, input.stoppedAt, input.lifecycle === 'stopped' ? input.occurredAt : null, 'container stoppedAt');
      const removedAt = this.retainTimestamp(job.containerRemovedAt, input.removedAt, input.lifecycle === 'removed' ? input.occurredAt : null, 'container removedAt');
      if (input.lifecycle === 'removed' && job.containerCleanupOutcome === null && input.cleanupOutcome !== 'passed') {
        throw new StoreValidationError('removed container diagnostics require passed cleanup evidence');
      }
      const cleanupOutcome = job.containerCleanupOutcome ?? input.cleanupOutcome ?? (removedAt === null ? null : 'passed');
      requireChronology([
        ['container createdAt', createdAt], ['container startedAt', startedAt],
        ['container stoppedAt', stoppedAt], ['container removedAt', removedAt], ['container occurredAt', input.occurredAt],
      ]);
      this.#db.prepare(`UPDATE jobs SET container_id=?, container_name=?, container_image_digest=?, container_label_job_id=?,
        container_label_manifest_sha=?, container_labels_json=?, container_mount_json=?, container_env_json=?, container_security_json=?,
        container_inspection_json=?, container_created_at=?, container_started_at=?, container_stopped_at=?, container_removed_at=?,
        container_cleanup_outcome=?, updated_at=? WHERE job_id=?`).run(
        input.containerId, input.containerName, input.imageDigest, jobId, input.targetManifestSha256,
        assertContainerLabels(input.labels, jobId, input.targetManifestSha256), assertJsonObject(input.mount, 'container mount'),
        assertJsonObject(input.environment, 'container environment'), assertJsonObject(input.security, 'container security'),
        assertJsonObject(input.inspection, 'container inspection'), createdAt, startedAt, stoppedAt, removedAt,
        cleanupOutcome, input.occurredAt, jobId,
      );
      this.appendEvent(jobId, 'container', this.payload(input), undefined, input.occurredAt);
    });
  }

  recordArtifact(jobId: string, input: ArtifactInput): void {
    this.validateArtifact(input);
    this.transaction(() => {
      const job = this.getJob(jobId);
      if (job.publishState !== null && job.publishState !== 'staged') throw new StoreConflictError('artifact metadata cannot replace a recovery or published result');
      this.#db.prepare(`UPDATE jobs SET publish_state='staged', artifact_staging_path=?, artifact_quarantine_path=NULL, artifact_final_directory=NULL,
        artifact_final_path=NULL, artifact_sha256=?, artifact_size=?, artifact_mtime=?, checksum_path=?, checksum_sha256=?, manifest_path=?,
        manifest_sha256=?, verification_path=?, verification_sha256=?, publish_started_at=NULL, published_at=NULL, publish_blocker_code=NULL,
        publish_blocker_json=NULL, updated_at=? WHERE job_id=?`).run(
        input.stagingPath, input.artifactSha256, input.artifactSize, input.artifactMtime, input.checksumPath, input.checksumSha256,
        input.manifestPath, input.manifestSha256, input.verificationPath, input.verificationSha256, this.now(), jobId,
      );
      this.appendEvent(jobId, 'artifact', this.payload(input));
    });
  }

  recordPublish(jobId: string, input: PublishInput): void {
    this.validatePublish(input);
    this.transaction(() => {
      const job = this.getJob(jobId);
      const now = this.now();
      if (input.state === 'staged') {
        if (!job.artifactStagingPath || !job.artifactSha256 || !job.checksumPath || !job.manifestPath || !job.verificationPath) {
          throw new StoreDataError('staged publish state requires complete artifact evidence');
        }
        this.#db.prepare(`UPDATE jobs SET publish_state='staged', artifact_quarantine_path=NULL, artifact_final_directory=NULL, artifact_final_path=NULL,
          publish_started_at=NULL, published_at=NULL, publish_blocker_code=NULL, publish_blocker_json=NULL, updated_at=? WHERE job_id=?`).run(now, jobId);
      } else if (input.state === 'publishing') {
        if (!job.artifactStagingPath) throw new StoreDataError('publishing requires staged artifact metadata');
        if (!input.finalDirectory || !input.finalPath) throw new StoreValidationError('publishing requires final directory and path');
        const startedAt = input.startedAt ?? now;
        requireChronology([['acceptedAt', job.acceptedAt], ['existing publish startedAt', job.publishStartedAt], ['publish startedAt', startedAt]]);
        this.#db.prepare(`UPDATE jobs SET publish_state='publishing', artifact_final_directory=?, artifact_final_path=?, publish_started_at=?,
          published_at=NULL, artifact_quarantine_path=NULL, publish_blocker_code=NULL, publish_blocker_json=NULL, updated_at=? WHERE job_id=?`).run(
          input.finalDirectory, input.finalPath, startedAt, now, jobId,
        );
      } else if (input.state === 'published') {
        if (!input.finalDirectory || !input.finalPath) throw new StoreValidationError('published state requires final directory and path');
        const startedAt = input.startedAt ?? job.publishStartedAt ?? now;
        const publishedAt = input.publishedAt ?? now;
        requireChronology([['acceptedAt', job.acceptedAt], ['publish startedAt', startedAt], ['existing publishedAt', job.publishedAt], ['publish publishedAt', publishedAt]]);
        this.#db.prepare(`UPDATE jobs SET publish_state='published', artifact_staging_path=NULL, artifact_final_directory=?, artifact_final_path=?,
          publish_started_at=COALESCE(publish_started_at, ?), published_at=?, artifact_quarantine_path=NULL, publish_blocker_code=NULL,
          publish_blocker_json=NULL, updated_at=? WHERE job_id=?`).run(input.finalDirectory, input.finalPath, startedAt, publishedAt, now, jobId);
      } else if (input.state === 'quarantined') {
        const quarantinePath = input.quarantinePath ?? job.artifactQuarantinePath;
        if (!quarantinePath) throw new StoreValidationError('quarantined state requires quarantine path');
        this.#db.prepare(`UPDATE jobs SET publish_state='quarantined', artifact_staging_path=NULL, artifact_quarantine_path=?, artifact_final_directory=NULL,
          artifact_final_path=NULL, publish_started_at=NULL, published_at=NULL, publish_blocker_code=NULL, publish_blocker_json=NULL, updated_at=? WHERE job_id=?`).run(quarantinePath, now, jobId);
      } else if (input.state === 'blocked') {
        if (!input.blockerCode || !input.blocker) throw new StoreValidationError('blocked publish requires blocker code and details');
        const preservesStaging = input.blockerCode === 'PUBLISH_FAILED' || input.blockerCode === 'QUARANTINE_PENDING';
        if (preservesStaging && !job.artifactStagingPath) throw new StoreConflictError(`${input.blockerCode} requires an existing staging path`);
        if (preservesStaging && Object.prototype.hasOwnProperty.call(input, 'stagingPath') && input.stagingPath !== job.artifactStagingPath) {
          throw new StoreConflictError(`${input.blockerCode} cannot replace or clear the authoritative staging path`);
        }
        const stagingPath = preservesStaging ? job.artifactStagingPath : (Object.prototype.hasOwnProperty.call(input, 'stagingPath') ? input.stagingPath ?? null : job.artifactStagingPath);
        const quarantinePath = Object.prototype.hasOwnProperty.call(input, 'quarantinePath') ? input.quarantinePath ?? null : job.artifactQuarantinePath;
        if (quarantinePath !== null) throw new StoreValidationError('blocked publish state cannot retain a quarantine path in the approved schema');
        this.#db.prepare(`UPDATE jobs SET publish_state='blocked', artifact_staging_path=?, artifact_quarantine_path=?, artifact_final_directory=NULL,
          artifact_final_path=NULL, publish_started_at=NULL, published_at=NULL, publish_blocker_code=?, publish_blocker_json=?, updated_at=? WHERE job_id=?`).run(stagingPath, quarantinePath, input.blockerCode, assertJsonObject(input.blocker, 'publish blocker'), now, jobId);
      } else {
        throw new StoreValidationError(`unsupported publish state: ${input.state}`);
      }
      this.appendEvent(jobId, 'publish', this.payload(input));
    });
  }

  requestFreshness(jobId: string, requestedAt = this.now('freshness request time')): void {
    requestedAt = canonicalInstant(requestedAt, 'freshness request time');
    this.transaction(() => {
      const job = this.getJob(jobId);
      if (job.freshnessRequestedAt !== null) {
        if (job.freshnessRequestedAt === requestedAt) return;
        throw new StoreConflictError('freshness request is immutable');
      }
      this.#db.prepare('UPDATE jobs SET freshness_requested_at = ?, updated_at = ? WHERE job_id = ?').run(requestedAt, requestedAt, jobId);
      this.appendEvent(jobId, 'freshness', { requestedAt }, undefined, requestedAt);
    });
  }

  recordFreshness(jobId: string, input: FreshnessInput): void {
    this.validateFreshness(input);
    this.transaction(() => {
      const job = this.getJob(jobId);
      if (job.freshnessStatus !== null) {
        if (this.freshnessMatchesInput(job, input)) return;
        throw new StoreConflictError('freshness result is immutable');
      }
      if (job.pinnedSha !== input.pinnedSha) throw new StoreDataError('freshness pinned SHA does not match job');
      requireChronology([['freshness requestedAt', job.freshnessRequestedAt], ['existing freshness checkedAt', job.freshnessCheckedAt], ['freshness checkedAt', input.checkedAt]]);
      const newer = input.status === 'advanced' ? 1 : 0;
      this.#db.prepare(`UPDATE jobs SET freshness_status=?, freshness_observed_sha=?, newer_source_available=?, freshness_checked_at=?,
        freshness_error_code=?, freshness_error_json=?, freshness_error_evidence_path=?, freshness_error_evidence_sha256=?, updated_at=? WHERE job_id=?`).run(
        input.status, input.observedSha, newer, input.checkedAt, input.status === 'unknown' ? 'FRESHNESS_UNKNOWN' : null,
        input.status === 'unknown' ? assertJsonObject(input.error ?? {}, 'freshness error') : null,
        input.status === 'unknown' ? input.errorEvidencePath ?? null : null, input.status === 'unknown' ? input.errorEvidenceSha256 ?? null : null,
        input.checkedAt, jobId,
      );
      this.appendEvent(jobId, 'freshness', this.payload(input), undefined, input.checkedAt);
    });
  }

  recordTerminal(jobId: string, input: { readonly state: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; readonly terminalAt: string; readonly errorCode?: BuilderErrorCode | null; readonly error?: JsonObject | null }): void {
    canonicalInstant(input.terminalAt, 'terminalAt');
    jsonOrNull(input.error, 'terminal error');
    this.transaction(() => {
      const job = this.getJob(jobId);
      requireChronology([['acceptedAt', job.acceptedAt], ['dispatchedAt', job.dispatchedAt], ['existing terminalAt', job.terminalAt], ['terminalAt', input.terminalAt]]);
      this.#db.prepare(`UPDATE jobs SET state=?, queue_state='complete', queue_position=NULL, terminal_at=?, terminal_error_code=?, terminal_error_json=?, updated_at=? WHERE job_id=?`).run(
        input.state, input.terminalAt, input.errorCode ?? null, jsonOrNull(input.error, 'terminal error'), input.terminalAt, jobId,
      );
      this.appendEvent(jobId, 'terminal', this.payload(input), undefined, input.terminalAt);
    });
  }

  getNextEventSequence(jobId: string): number {
    this.requireJob(jobId);
    const row = this.#db.prepare('SELECT COALESCE(MAX(seq) + 1, 0) AS next_seq FROM job_events WHERE job_id = ?').get(jobId) as DbRow;
    return Number(row.next_seq);
  }

  private now(field = 'store time'): string {
    return canonicalInstant(this.#now(), field);
  }

  listEvents(jobId: string, options: EventPageOptions = {}): EventPage {
    this.requireJob(jobId);
    const afterSeq = options.afterSeq ?? -1;
    const limit = options.limit ?? EVENT_PAGE_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) throw new StoreValidationError('event cursor must be a safe integer greater than or equal to -1');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > EVENT_PAGE_MAX_LIMIT) throw new StoreValidationError(`event limit must be a safe integer between 1 and ${EVENT_PAGE_MAX_LIMIT}`);
    const rows = this.#db.prepare('SELECT job_id, seq, event_type, state, stage, payload_json, at FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(jobId, afterSeq, limit + 1) as unknown as DbRow[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map((row) => ({
      jobId: asString(row, 'job_id'), seq: Number(row.seq), eventType: asString(row, 'event_type') as EventType,
      state: nullableString(row, 'state') as JobState | null, stage: nullableString(row, 'stage') as PipelineStageName | null,
      payload: parseJsonObject(asString(row, 'payload_json'), 'event payload') ?? {}, at: asString(row, 'at'),
    }));
    return { events, nextAfterSeq: hasMore ? events.at(-1)?.seq ?? null : null };
  }

  private transaction<T>(work: () => T): T {
    const composed = this.#db.isTransaction;
    const savepoint = `osi_store_${++this.#savepointSequence}`;
    let started = false;
    let savepointActive = false;
    try {
      if (composed) {
        this.#db.exec(`SAVEPOINT "${savepoint}"`);
        savepointActive = true;
      } else {
        this.#db.exec('BEGIN IMMEDIATE');
        started = true;
      }
      const result = work();
      this.#failBeforeCommit?.();
      if (savepointActive) {
        this.#db.exec(`RELEASE SAVEPOINT "${savepoint}"`);
        savepointActive = false;
      } else {
        this.#db.exec('COMMIT');
      }
      return result;
    } catch (error) {
      let rollbackCause: unknown;
      let releaseCause: unknown;
      if (savepointActive) {
        try { this.#db.exec(`ROLLBACK TO SAVEPOINT "${savepoint}"`); } catch (cause) { rollbackCause = cause; }
        try { this.#db.exec(`RELEASE SAVEPOINT "${savepoint}"`); } catch (cause) { releaseCause = cause; }
      } else if (started) {
        try { this.#db.exec('ROLLBACK'); } catch (cause) { rollbackCause = cause; }
      }
      if (error instanceof StoreError) {
        if (rollbackCause !== undefined) error.rollbackCause = rollbackCause;
        if (releaseCause !== undefined) error.releaseCause = releaseCause;
        throw error;
      }
      const wrapped = new StoreTransactionError('SQLite store transaction rolled back', { cause: error });
      if (rollbackCause !== undefined) wrapped.rollbackCause = rollbackCause;
      if (releaseCause !== undefined) wrapped.releaseCause = releaseCause;
      throw wrapped;
    }
  }

  private appendEvent(jobId: string, eventType: EventType, payload: JsonObject, stage?: PipelineStageName, at = this.now()): void {
    at = canonicalInstant(at, 'event time');
    if (!EVENT_TYPES.includes(eventType)) throw new StoreValidationError(`unknown event type: ${eventType}`);
    const state = this.#db.prepare('SELECT state FROM jobs WHERE job_id = ?').get(jobId) as DbRow | undefined;
    if (!state) throw new StoreNotFoundError(`job not found: ${jobId}`);
    const seq = this.getNextEventSequence(jobId);
    this.#db.prepare('INSERT INTO job_events (job_id, seq, event_type, state, stage, payload_json, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(jobId, seq, eventType, state.state as string, stage ?? null, assertJsonObject(payload, 'event payload'), at);
  }

  private resequenceQueue(): void {
    this.#db.exec(`UPDATE jobs SET queue_position = (
      SELECT COUNT(*) FROM queue_entries earlier
      JOIN jobs earlier_job ON earlier_job.job_id = earlier.job_id
      WHERE earlier_job.queue_state = 'queued'
        AND earlier.fifo_seq < (SELECT current.fifo_seq FROM queue_entries current WHERE current.job_id = jobs.job_id)
    ) WHERE queue_state = 'queued'`);
  }

  private retainTimestamp(existing: string | null, supplied: string | null | undefined, firstObserved: string | null, field: string): string | null {
    if (existing !== null && supplied !== undefined && supplied !== null && supplied !== existing) {
      throw new StoreConflictError(`${field} is an immutable lifecycle fact`);
    }
    return existing ?? supplied ?? firstObserved;
  }

  private operationMatchesInput(stored: StoredOperation, input: OperationInput): boolean {
    const scalarMatches = stored.operationId === input.operationId && stored.attempt === input.attempt
      && stored.argvHash === input.argvHash && stored.startedAt === input.startedAt
      && stored.finishedAt === (input.finishedAt ?? null) && stored.containerId === (input.containerId ?? null)
      && stored.containerName === (input.containerName ?? null) && stored.containerImageDigest === (input.containerImageDigest ?? null)
      && stored.containerLabelJobId === (input.containerLabelJobId ?? null)
      && stored.containerLabelManifestSha === (input.containerLabelManifestSha ?? null)
      && stored.timedOut === input.timedOut && stored.lifecyclePhase === input.lifecyclePhase
      && stored.exitCode === (input.exitCode ?? null) && stored.signal === (input.signal ?? null)
      && stored.outcome === input.outcome && stored.evidencePath === input.evidencePath
      && stored.evidenceSha256 === input.evidenceSha256 && stored.errorCode === (input.errorCode ?? null);
    if (!scalarMatches) return false;
    const jsonPairs: readonly [unknown, unknown][] = [
      [stored.argv, input.argv], [stored.containerMount, input.containerMount ?? null],
      [stored.containerEnvironment, input.containerEnvironment ?? null], [stored.containerSecurity, input.containerSecurity ?? null],
      [stored.inspection, input.inspection ?? null], [stored.error, input.error ?? null],
    ];
    return jsonPairs.every(([left, right]) => (left === null || right === null) ? left === right : encodeJson(left, 'stored operation') === encodeJson(right, 'operation retry'));
  }

  private freshnessMatchesInput(job: JobRecord, input: FreshnessInput): boolean {
    const expectedErrorCode = input.status === 'unknown' ? 'FRESHNESS_UNKNOWN' : null;
    const expectedError = input.status === 'unknown' ? input.error ?? {} : null;
    const jsonMatches = (left: JsonObject | null, right: JsonObject | null): boolean => {
      if (left === null || right === null) return left === right;
      return encodeJson(left, 'stored freshness error') === encodeJson(right, 'freshness retry error');
    };
    return job.pinnedSha === input.pinnedSha
      && job.freshnessStatus === input.status
      && job.freshnessObservedSha === input.observedSha
      && job.newerSourceAvailable === (input.status === 'advanced')
      && job.freshnessCheckedAt === input.checkedAt
      && job.freshnessErrorCode === expectedErrorCode
      && jsonMatches(job.freshnessError, expectedError)
      && job.freshnessErrorEvidencePath === (input.status === 'unknown' ? input.errorEvidencePath ?? null : null)
      && job.freshnessErrorEvidenceSha256 === (input.status === 'unknown' ? input.errorEvidenceSha256 ?? null : null);
  }

  private requireJob(jobId: string): DbRow {
    const row = this.#db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as DbRow | undefined;
    if (!row) throw new StoreNotFoundError(`job not found: ${jobId}`);
    return row;
  }

  private validateCreateJob(input: CreateJobInput): { sha: string | null; checkedAt: string | null; expiresAt: string | null } {
    if (!input.jobId || !input.requestId) throw new StoreValidationError('job and request IDs are required');
    this.validateSourceIdentity(input);
    requireHash(input.targetManifestSha256, HASH64, 'target manifest SHA-256');
    const sha = input.preflightSha ?? null;
    const checkedAt = optionalInstant(input.preflightCheckedAt, 'preflight checkedAt');
    const expiresAt = optionalInstant(input.preflightExpiresAt, 'preflight expiresAt');
    const present = [sha, checkedAt, expiresAt].map((value) => value !== null);
    if (new Set(present).size > 1) throw new StoreValidationError('preflight fields must be all present or all absent');
    if (sha !== null) {
      requireHash(sha, HASH40, 'preflight SHA');
      if (sha !== input.pinnedSha) throw new StoreValidationError('preflight SHA must match pinned SHA');
      requireChronology([['preflight checkedAt', checkedAt], ['preflight expiresAt', expiresAt]]);
    }
    canonicalInstant(input.acceptedAt, 'acceptedAt');
    return { sha, checkedAt, expiresAt };
  }

  private validateSourceIdentity(input: SourceIdentity): void {
    if (input.sourceBranch !== input.branch || input.sourceRef !== `refs/remotes/origin/${input.branch}`) throw new StoreValidationError('source branch identity is incoherent');
    if (input.expectedSha !== input.pinnedSha) throw new StoreValidationError('expected and pinned SHA differ');
    requireHash(input.expectedSha, HASH40, 'expected SHA');
    requireHash(input.pinnedSha, HASH40, 'pinned SHA');
    canonicalInstant(input.sourceCommitTime, 'source commit time');
  }

  private validateStage(input: StageInput): void {
    if (!PIPELINE_STAGE_NAMES.includes(input.stage)) throw new StoreValidationError('unknown stage');
    canonicalInstant(input.startedAt, 'stage startedAt');
    const finishedAt = optionalInstant(input.finishedAt, 'stage finishedAt');
    requireChronology([['stage startedAt', input.startedAt], ['stage finishedAt', finishedAt]]);
    if (input.outcome === 'running' && input.finishedAt !== undefined && input.finishedAt !== null) throw new StoreValidationError('running stage cannot be finished');
    if (input.outcome !== 'running' && !input.finishedAt) throw new StoreValidationError('completed stage requires finishedAt');
    if (input.outcome === 'passed' && (!input.evidencePath || !input.evidenceSha256)) throw new StoreValidationError('passed stage requires evidence');
    if (input.outcome !== 'running' && input.outcome !== 'passed' && (!input.evidencePath || !input.evidenceSha256 || !input.errorCode || !input.error)) throw new StoreValidationError('failed stage requires evidence and error');
    if (input.evidenceSha256) requireHash(input.evidenceSha256, HASH64, 'stage evidence SHA-256');
    jsonOrNull(input.error, 'stage error');
  }

  private validateOperation(input: OperationInput): void {
    if (!TRUSTED_OPERATION_IDS.includes(input.operationId)) throw new StoreValidationError('unknown operation');
    if (!Number.isInteger(input.attempt) || input.attempt < 1) throw new StoreValidationError('operation attempt is invalid');
    canonicalInstant(input.startedAt, 'operation startedAt');
    const finishedAt = optionalInstant(input.finishedAt, 'operation finishedAt');
    requireChronology([['operation startedAt', input.startedAt], ['operation finishedAt', finishedAt]]);
    requireHash(input.argvHash, HASH64, 'argv hash');
    requireHash(input.evidenceSha256, HASH64, 'operation evidence SHA-256');
    if (!Array.isArray(input.argv) || input.argv.some((value) => typeof value !== 'string')) throw new StoreValidationError('operation argv must be a string array');
    encodeJson(input.argv, 'operation argv');
    jsonOrNull(input.containerMount, 'operation mount');
    jsonOrNull(input.containerEnvironment, 'operation environment');
    jsonOrNull(input.containerSecurity, 'operation security');
    jsonOrNull(input.inspection, 'operation inspection');
    jsonOrNull(input.error, 'operation error');
    if (input.containerImageDigest !== undefined && input.containerImageDigest !== null) requireHash(input.containerImageDigest, HASH64, 'operation image digest');
    if (input.outcome === 'failed' && (!input.evidencePath || !input.error)) throw new StoreValidationError('failed operation requires evidence and error');
    if (input.outcome === 'passed' && (input.exitCode !== 0 || input.timedOut || input.lifecyclePhase === 'not_created')) throw new StoreValidationError('passed operation result is incoherent');
    if (input.outcome === 'failed' && !input.errorCode) throw new StoreValidationError('failed operation requires an error code');
  }

  private validateArtifact(input: ArtifactInput): void {
    for (const [value, field] of [[input.artifactSha256, 'artifact SHA-256'], [input.checksumSha256, 'checksum SHA-256'], [input.manifestSha256, 'manifest SHA-256'], [input.verificationSha256, 'verification SHA-256']] as const) requireHash(value, HASH64, field);
    if (!Number.isInteger(input.artifactSize) || input.artifactSize < 0) throw new StoreValidationError('artifact size is invalid');
    canonicalInstant(input.artifactMtime, 'artifact mtime');
  }

  private validatePublish(input: PublishInput): void {
    const startedAt = optionalInstant(input.startedAt, 'publish startedAt');
    const publishedAt = optionalInstant(input.publishedAt, 'publish publishedAt');
    requireChronology([['publish startedAt', startedAt], ['publish publishedAt', publishedAt]]);
    if (input.blocker !== undefined) assertJsonObject(input.blocker, 'publish blocker');
  }

  private validateFreshness(input: FreshnessInput): void {
    requireHash(input.pinnedSha, HASH40, 'freshness pinned SHA');
    if (input.status === 'fresh' && (input.observedSha !== input.pinnedSha)) throw new StoreValidationError('fresh freshness result must observe the pinned SHA');
    if (input.status === 'advanced' && (!input.observedSha || input.observedSha === input.pinnedSha)) throw new StoreValidationError('advanced freshness result requires a newer SHA');
    if (input.status === 'unknown' && (input.observedSha !== null || !input.errorEvidencePath || !input.errorEvidenceSha256)) throw new StoreValidationError('unknown freshness result requires evidence');
    if (input.observedSha !== null) requireHash(input.observedSha, HASH40, 'freshness observed SHA');
    if (input.status === 'unknown') requireHash(input.errorEvidenceSha256!, HASH64, 'freshness error evidence SHA-256');
    if (input.status !== 'unknown' && (input.error !== undefined || input.errorEvidencePath !== undefined || input.errorEvidenceSha256 !== undefined)) {
      throw new StoreValidationError('non-unknown freshness result cannot carry error evidence');
    }
    canonicalInstant(input.checkedAt, 'freshness checkedAt');
    jsonOrNull(input.error, 'freshness error');
  }

  private payload(value: object): JsonObject {
    return JSON.parse(encodeJson(value, 'event payload', true)) as JsonObject;
  }

  private mapJob(row: DbRow): JobRecord {
    return {
      jobId: asString(row, 'job_id'), requestId: asString(row, 'request_id'), request: parseJsonObject(nullableString(row, 'request_json'), 'request_json'),
      sourceRemote: asString(row, 'source_remote'), sourceRef: asString(row, 'source_ref'), sourceBranch: asString(row, 'source_branch'), branch: asString(row, 'branch'),
      expectedSha: asString(row, 'expected_sha'), pinnedSha: asString(row, 'pinned_sha'), targetId: asString(row, 'target_id') as TargetId, rootId: asString(row, 'root_id'),
      targetManifestSha256: asString(row, 'target_manifest_sha256'), sourceCommitTime: asString(row, 'source_commit_time'), sourceAuthor: asString(row, 'source_author'), sourceSubject: asString(row, 'source_subject'),
      acceptedAt: asString(row, 'accepted_at'), state: asString(row, 'state') as JobState, currentStage: nullableString(row, 'current_stage') as PipelineStageName | null,
      queueState: asString(row, 'queue_state'), queuePosition: nullableNumber(row, 'queue_position'), cancelRequestedAt: nullableString(row, 'cancel_requested_at'), cancelReason: nullableString(row, 'cancel_reason'),
      dispatchedAt: nullableString(row, 'dispatched_at'), runnerUnit: nullableString(row, 'runner_unit'), runnerLeaseOwner: nullableString(row, 'runner_lease_owner'), runnerLeaseExpiresAt: nullableString(row, 'runner_lease_expires_at'),
      containerId: nullableString(row, 'container_id'), containerName: nullableString(row, 'container_name'), containerImageDigest: nullableString(row, 'container_image_digest'), containerLabelJobId: nullableString(row, 'container_label_job_id'), containerLabelManifestSha: nullableString(row, 'container_label_manifest_sha'),
      containerLabels: parseJsonObject(nullableString(row, 'container_labels_json'), 'container_labels_json'), containerMount: parseJsonObject(nullableString(row, 'container_mount_json'), 'container_mount_json'), containerEnvironment: parseJsonObject(nullableString(row, 'container_env_json'), 'container_env_json'), containerSecurity: parseJsonObject(nullableString(row, 'container_security_json'), 'container_security_json'), containerInspection: parseJsonObject(nullableString(row, 'container_inspection_json'), 'container_inspection_json'),
      containerCreatedAt: nullableString(row, 'container_created_at'), containerStartedAt: nullableString(row, 'container_started_at'), containerStoppedAt: nullableString(row, 'container_stopped_at'), containerRemovedAt: nullableString(row, 'container_removed_at'), containerCleanupOutcome: nullableString(row, 'container_cleanup_outcome'),
      terminalErrorCode: nullableString(row, 'terminal_error_code') as BuilderErrorCode | null, terminalError: parseJsonObject(nullableString(row, 'terminal_error_json'), 'terminal_error_json'), terminalAt: nullableString(row, 'terminal_at'),
      artifactStagingPath: nullableString(row, 'artifact_staging_path'), artifactQuarantinePath: nullableString(row, 'artifact_quarantine_path'), artifactFinalDirectory: nullableString(row, 'artifact_final_directory'), artifactFinalPath: nullableString(row, 'artifact_final_path'), artifactSha256: nullableString(row, 'artifact_sha256'), artifactSize: nullableNumber(row, 'artifact_size'), artifactMtime: nullableString(row, 'artifact_mtime'), checksumPath: nullableString(row, 'checksum_path'), checksumSha256: nullableString(row, 'checksum_sha256'), manifestPath: nullableString(row, 'manifest_path'), manifestSha256: nullableString(row, 'manifest_sha256'), verificationPath: nullableString(row, 'verification_path'), verificationSha256: nullableString(row, 'verification_sha256'), publishState: nullableString(row, 'publish_state') as PublishState | null, publishStartedAt: nullableString(row, 'publish_started_at'), publishedAt: nullableString(row, 'published_at'),
      freshnessStatus: nullableString(row, 'freshness_status') as FreshnessState | null, freshnessObservedSha: nullableString(row, 'freshness_observed_sha'), newerSourceAvailable: row.newer_source_available === null || row.newer_source_available === undefined ? null : Boolean(row.newer_source_available), freshnessRequestedAt: nullableString(row, 'freshness_requested_at'), freshnessCheckedAt: nullableString(row, 'freshness_checked_at'), freshnessErrorCode: nullableString(row, 'freshness_error_code') as BuilderErrorCode | null, freshnessError: parseJsonObject(nullableString(row, 'freshness_error_json'), 'freshness_error_json'), freshnessErrorEvidencePath: nullableString(row, 'freshness_error_evidence_path'), freshnessErrorEvidenceSha256: nullableString(row, 'freshness_error_evidence_sha256'),
    };
  }

  private mapStage(row: DbRow): StoredStage {
    return {
      jobId: asString(row, 'job_id'), stage: asString(row, 'stage') as PipelineStageName,
      outcome: nullableString(row, 'outcome') as StageOutcome | null, startedAt: nullableString(row, 'started_at'),
      finishedAt: nullableString(row, 'finished_at'), evidencePath: nullableString(row, 'evidence_path'),
      evidenceSha256: nullableString(row, 'evidence_sha256'), errorCode: nullableString(row, 'error_code') as BuilderErrorCode | null,
      error: parseJsonObject(nullableString(row, 'error_json'), 'stage error'),
    };
  }

  private mapOperation(row: DbRow): StoredOperation {
    return {
      jobId: asString(row, 'job_id'), operationId: asString(row, 'operation_id') as TrustedOperationId, attempt: Number(row.attempt), argvHash: asString(row, 'argv_hash'),
      argv: parseJsonArray(asString(row, 'argv_json'), 'argv_json'), startedAt: asString(row, 'started_at'), finishedAt: nullableString(row, 'finished_at'),
      containerId: nullableString(row, 'container_id'), containerName: nullableString(row, 'container_name'), containerImageDigest: nullableString(row, 'container_image_digest'),
      containerLabelJobId: nullableString(row, 'container_label_job_id'), containerLabelManifestSha: nullableString(row, 'container_label_manifest_sha'),
      containerMount: parseJsonObject(nullableString(row, 'container_mount_json'), 'operation mount'), containerEnvironment: parseJsonObject(nullableString(row, 'container_env_json'), 'operation environment'),
      containerSecurity: parseJsonObject(nullableString(row, 'container_security_json'), 'operation security'), inspection: parseJsonObject(nullableString(row, 'inspection_json'), 'operation inspection'),
      timedOut: Boolean(row.timed_out), lifecyclePhase: asString(row, 'lifecycle_phase') as LifecyclePhase, exitCode: nullableNumber(row, 'exit_code'), signal: nullableString(row, 'signal'),
      outcome: nullableString(row, 'outcome') as 'passed' | 'failed' | null, evidencePath: nullableString(row, 'evidence_path'), evidenceSha256: nullableString(row, 'evidence_sha256'),
      errorCode: nullableString(row, 'error_code') as BuilderErrorCode | null, error: parseJsonObject(nullableString(row, 'error_json'), 'operation error'),
    };
  }
}
