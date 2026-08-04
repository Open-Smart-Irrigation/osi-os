import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

import {
  OwnershipConflictError,
  type DirectInterruptionProof,
  type OwnershipResult,
  type OwnershipStore,
} from './ownership.js';
import type { DispatchClaimPhase } from './ownership.js';
import type { JsonObject } from './store.js';
import type { ActiveRecoveryState } from '../../domain/types.js';
import type {
  StartupBootstrap,
  StartupBootstrapOptions,
  StartupCoordinator,
  StartupPhaseResult,
  StartupResult,
} from './startup-order.js';

const ACTIVE_STATES = new Set<ActiveRecoveryState>([
  'starting', 'preflight', 'source', 'release_gates', 'frontend', 'target_setup',
  'feeds', 'config', 'building', 'verifying', 'cancel_requested',
]);

const RUNNER_UNIT = /^osi-image-builder-runner@[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.service$/u;
const START_ARGV = (unit: string): readonly string[] => ['systemctl', '--user', 'start', unit];
const MAX_ACTIVE_RUNNER_UNITS = 64;
const MAX_ACTIVE_DATABASE_ROWS = 64;
const DISPATCH_CLAIM_LEASE_MS = 30_000;
const DISPATCH_CLAIM_RENEW_INTERVAL_MS = 5_000;
const OPERATION_TIMEOUT_MS = 15_000;

type QueueRow = Readonly<Record<string, unknown>>;

type DispatchClaim = Readonly<{
  readonly jobId: string;
  readonly owner: string;
  readonly claimedAt: string;
  readonly leaseExpiresAt: string;
  readonly phase: DispatchClaimPhase;
  readonly startAttemptedAt: string | null;
  readonly unitInactiveAt: string | null;
}>;

export interface QueueStatement {
  readonly all: (...parameters: readonly unknown[]) => readonly QueueRow[];
  readonly get: (...parameters: readonly unknown[]) => QueueRow | undefined;
}

export interface QueueDatabase {
  readonly prepare: (sql: string) => QueueStatement;
}

export interface SystemdUnitObservation {
  readonly unit: string;
  readonly active: boolean;
  /** True while systemd has an activating/pending manager transaction for the unit. */
  readonly pending: boolean;
  readonly observedAt: string;
}

export interface SystemdStartResult {
  readonly unit: string;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly signal?: string | null;
}

export interface QueueSystemd {
  readonly inspect: (unit: string, signal?: AbortSignal) => Promise<SystemdUnitObservation>;
  readonly start: (unit: string, signal?: AbortSignal) => Promise<SystemdStartResult>;
  /** Lists runner units in either active or activating systemd states. */
  readonly listActive?: (signal?: AbortSignal) => Promise<readonly string[]>;
}

export interface QueueBlocker {
  readonly code: string;
  readonly details?: JsonObject;
}

export interface QueueSafetyChecks {
  readonly inspect: (input: Readonly<{
    readonly phase: 'before-claim' | 'before-start' | 'direct-proof';
    readonly jobId?: string;
  }>, signal?: AbortSignal) => Promise<QueueBlocker | null>;
}

export interface DirectInterruptionInput {
  readonly jobId: string;
  readonly runnerUnit: string;
  readonly startAttemptedAt: string;
  readonly unitInactiveAt: string;
  readonly expectedClaimExpiresAt: string;
  readonly reason: string;
}

export interface QueueCoordinatorOptions {
  readonly db: DatabaseSync | QueueDatabase;
  readonly ownership: Pick<OwnershipStore, 'apiWrite'>;
  readonly systemd: QueueSystemd;
  readonly safety?: QueueSafetyChecks;
  readonly directInterrupt?: (input: DirectInterruptionInput, signal?: AbortSignal) => Promise<DirectInterruptionProof | null>;
  readonly clock?: Readonly<{ readonly now: () => string }>;
  readonly coordinatorId?: string;
  readonly dispatchClaimLeaseMs?: number;
  readonly dispatchClaimRenewIntervalMs?: number;
  readonly operationTimeoutMs?: number;
}

export type QueueDispatchResult =
  | Readonly<{ readonly kind: 'idle' }>
  | Readonly<{ readonly kind: 'started'; readonly jobId: string; readonly runnerUnit: string }>
  | Readonly<{ readonly kind: 'interrupted'; readonly jobId: string }>
  | Readonly<{ readonly kind: 'recovery-blocked'; readonly jobId: string; readonly blocker: QueueBlocker }>
  | Readonly<{ readonly kind: 'blocked'; readonly reason: string; readonly jobId?: string }>;

export interface QueueCoordinator {
  readonly dispatchNext: () => Promise<QueueDispatchResult>;
}

export interface QueueStartupGate {
  readonly beginStartupReconciliation: () => void;
  readonly completeStartupReconciliation: (blockers?: readonly QueueBlocker[]) => void;
}

interface QueueCoordinatorInternal extends QueueCoordinator, QueueStartupGate {
  readonly beginStartupReconciliation: () => void;
  readonly completeStartupReconciliation: (blockers?: readonly QueueBlocker[]) => void;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nullableText(row: QueueRow, key: string): string | null {
  return text(row[key]);
}

type RunnerLeaseState =
  | Readonly<{ readonly kind: 'none' }>
  | Readonly<{ readonly kind: 'live' }>
  | Readonly<{ readonly kind: 'stale' }>
  | Readonly<{ readonly kind: 'malformed' }>;

function runnerLeaseState(row: QueueRow, now: string): RunnerLeaseState {
  const owner = row.runner_lease_owner;
  const expiresAt = row.runner_lease_expires_at;
  const ownerAbsent = owner === null || owner === undefined;
  const expiryAbsent = expiresAt === null || expiresAt === undefined;
  if (ownerAbsent && expiryAbsent) return { kind: 'none' };
  if (ownerAbsent !== expiryAbsent || typeof owner !== 'string' || owner.length === 0 || typeof expiresAt !== 'string') return { kind: 'malformed' };
  const canonicalExpiry = canonicalInstant(expiresAt);
  if (canonicalExpiry === null) return { kind: 'malformed' };
  return Date.parse(canonicalExpiry) > Date.parse(now) ? { kind: 'live' } : { kind: 'stale' };
}

function isActiveState(value: unknown): value is ActiveRecoveryState {
  return typeof value === 'string' && ACTIVE_STATES.has(value as ActiveRecoveryState);
}

function isRunnerLeaseOwnedState(value: unknown): boolean {
  return isActiveState(value) || value === 'publishing';
}

function runnerUnit(jobId: string): string {
  return `osi-image-builder-runner@${jobId}.service`;
}

function canonicalInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

function dispatchClaimFromRow(row: QueueRow): DispatchClaim {
  const jobId = text(row.job_id);
  const owner = text(row.owner);
  const claimedAt = canonicalInstant(row.claimed_at);
  const leaseExpiresAt = canonicalInstant(row.lease_expires_at);
  const phase = row.phase === 'pre-start' || row.phase === 'start-attempted' ? row.phase : null;
  const startAttemptedAt = row.start_attempted_at === null ? null : canonicalInstant(row.start_attempted_at);
  const unitInactiveAt = row.unit_inactive_at === null ? null : canonicalInstant(row.unit_inactive_at);
  if (jobId === null || owner === null || claimedAt === null || leaseExpiresAt === null || phase === null
    || (phase === 'pre-start' && (startAttemptedAt !== null || unitInactiveAt !== null))
    || (phase === 'start-attempted' && (startAttemptedAt === null || unitInactiveAt === null))) {
    throw new Error('database returned a malformed queue dispatch claim');
  }
  return { jobId, owner, claimedAt, leaseExpiresAt, phase, startAttemptedAt, unitInactiveAt };
}

function dispatchClaimExpiry(at: string, leaseMs: number): string {
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) throw new Error('dispatch claim time is invalid');
  return new Date(parsed + leaseMs).toISOString();
}

function laterInstant(first: string, second: string): string {
  return Date.parse(first) >= Date.parse(second) ? first : second;
}

function objectDetails(value: QueueBlocker): JsonObject {
  return { code: value.code, ...(value.details ?? {}) };
}

function success(result: OwnershipResult): boolean {
  return result.ok;
}

function resultMessage(result: OwnershipResult): string {
  return result.ok ? 'ownership write did not return a conflict' : result.conflict.message;
}

function database(db: DatabaseSync | QueueDatabase): QueueDatabase {
  return db as unknown as QueueDatabase;
}

function rowJobId(row: QueueRow): string | null {
  return text(row.job_id) ?? text(row.jobId);
}

function isBlockedResult(value: QueueRow | QueueDispatchResult): value is Extract<QueueDispatchResult, { readonly kind: 'blocked' }> {
  return value.kind === 'blocked' && typeof value.reason === 'string';
}

function safeResult(result: unknown): result is SystemdStartResult {
  if (typeof result !== 'object' || result === null) return false;
  const value = result as Record<string, unknown>;
  return typeof value.unit === 'string'
    && Array.isArray(value.argv) && value.argv.every((item) => typeof item === 'string')
    && (typeof value.exitCode === 'number' || value.exitCode === null)
    && typeof value.timedOut === 'boolean'
    && (value.signal === undefined || value.signal === null || typeof value.signal === 'string');
}

function safeObservation(value: unknown, expectedUnit: string): value is SystemdUnitObservation {
  if (typeof value !== 'object' || value === null) return false;
  const observation = value as Record<string, unknown>;
  return observation.unit === expectedUnit
    && typeof observation.active === 'boolean'
    && typeof observation.pending === 'boolean'
    && canonicalInstant(observation.observedAt) !== null;
}

function observationIsLive(observation: SystemdUnitObservation): boolean {
  return observation.active || observation.pending;
}

function observationIsInactive(observation: SystemdUnitObservation): boolean {
  return !observation.active && !observation.pending;
}

class QueueOperationTimeoutError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(`${operation} timed out`);
    this.name = 'QueueOperationTimeoutError';
    this.operation = operation;
  }
}

function createQueueCoordinatorInternal(options: QueueCoordinatorOptions): QueueCoordinatorInternal {
  const db = database(options.db);
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const coordinatorId = options.coordinatorId ?? `queue-dispatcher-${randomUUID()}`;
  let dispatchInFlight = false;
  // Startup is fail-closed. The only normal release path is the typed gate below.
  let startupReady = false;
  let startupBlocker: QueueBlocker | null = null;
  let lastClockAt = Number.NEGATIVE_INFINITY;
  let lastObservationAt = Number.NEGATIVE_INFINITY;

  function clockReading(): string {
    const value = canonicalInstant(clock.now());
    if (value === null) throw new Error('clock returned a non-canonical instant');
    const at = Date.parse(value);
    if (at < lastClockAt) throw new Error('clock observations moved backwards');
    lastClockAt = at;
    return value;
  }

  function statement(sql: string): QueueStatement {
    const prepared = db.prepare(sql);
    if (typeof prepared.all !== 'function' || typeof prepared.get !== 'function') throw new Error('database statement is missing required get/all methods');
    return prepared;
  }

  function rows(sql: string, ...parameters: readonly unknown[]): readonly QueueRow[] {
    const result = statement(sql).all(...parameters);
    if (!Array.isArray(result) || result.length > MAX_ACTIVE_DATABASE_ROWS || result.some((value) => typeof value !== 'object' || value === null)) throw new Error('database returned malformed or unbounded rows');
    return result;
  }

  function one(sql: string, ...parameters: readonly unknown[]): QueueRow | undefined {
    const result = statement(sql).get(...parameters);
    if (result !== undefined && (typeof result !== 'object' || result === null)) throw new Error('database returned a malformed row');
    return result;
  }

  function currentJob(jobId: string): QueueRow | undefined {
    return one('SELECT * FROM jobs WHERE job_id=?', jobId);
  }

  function currentDispatchClaim(): DispatchClaim | undefined {
    const row = one('SELECT job_id, owner, claimed_at, lease_expires_at, phase, start_attempted_at, unit_inactive_at FROM queue_dispatch_claims WHERE claim_id=1');
    return row === undefined ? undefined : dispatchClaimFromRow(row);
  }

  const claimLeaseMs = options.dispatchClaimLeaseMs ?? DISPATCH_CLAIM_LEASE_MS;
  const claimRenewIntervalMs = options.dispatchClaimRenewIntervalMs ?? DISPATCH_CLAIM_RENEW_INTERVAL_MS;
  const operationTimeoutMs = options.operationTimeoutMs ?? OPERATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(claimLeaseMs) || claimLeaseMs <= 0 || !Number.isSafeInteger(claimRenewIntervalMs) || claimRenewIntervalMs <= 0 || claimRenewIntervalMs * 2 >= claimLeaseMs) {
    throw new Error('dispatch claim lease and renewal intervals are invalid');
  }
  if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs <= 0 || operationTimeoutMs > 120_000) {
    throw new Error('queue operation timeout is invalid');
  }

  async function boundedOperation<T>(operation: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new QueueOperationTimeoutError(operation);
        reject(error);
        controller.abort(error);
      }, operationTimeoutMs);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => work(controller.signal)),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  type ClaimHeartbeat = Readonly<{
    readonly checkpoint: (allowExpired?: boolean) => boolean;
    readonly pin: () => DispatchClaim | null;
    readonly isLost: () => boolean;
    readonly stop: () => Promise<void>;
  }>;

  function claimHeartbeat(jobId: string, owner: string): ClaimHeartbeat {
    let lost = false;
    let stopped = false;
    let handedOff = false;
    let pinnedExpiry: string | null = null;
    let renewal = Promise.resolve();
    let timer: ReturnType<typeof setInterval> | undefined;
    const checkpoint = (allowExpired = false): boolean => {
      if (stopped || lost) return false;
      try {
        const at = clockReading();
        if (handedOff) {
          const current = currentJob(jobId);
          const lease = current === undefined ? { kind: 'malformed' as const } : runnerLeaseState(current, at);
          if (current !== undefined && isRunnerLeaseOwnedState(current.state) && current.runner_unit === runnerUnit(jobId) && lease.kind === 'live') return true;
          lost = true;
          return false;
        }
        const claim = currentDispatchClaim();
        if (pinnedExpiry !== null) {
          if (claim !== undefined
            && claim.jobId === jobId
            && claim.owner === owner
            && claim.leaseExpiresAt === pinnedExpiry
            && Date.parse(claim.leaseExpiresAt) > Date.parse(at)) {
            return true;
          }
          lost = true;
          return false;
        }
        if (claim === undefined || claim.jobId !== jobId || claim.owner !== owner) {
          const current = currentJob(jobId);
          const lease = current === undefined ? { kind: 'malformed' as const } : runnerLeaseState(current, at);
          if (claim === undefined && current !== undefined && isRunnerLeaseOwnedState(current.state) && current.runner_unit === runnerUnit(jobId) && lease.kind === 'live') {
            handedOff = true;
            if (timer !== undefined) clearInterval(timer);
            return true;
          }
          lost = true;
          return false;
        }
        if (Date.parse(claim.leaseExpiresAt) <= Date.parse(at)) {
          if (allowExpired) return true;
          lost = true;
          return false;
        }
        const result = options.ownership.apiWrite({
          kind: 'dispatch-renew',
          jobId,
          claimOwner: owner,
          expectedClaimExpiresAt: claim.leaseExpiresAt,
          claimExpiresAt: dispatchClaimExpiry(at, claimLeaseMs),
          at,
        });
        if (!success(result)) {
          lost = true;
          return false;
        }
        return true;
      } catch {
        lost = true;
        return false;
      }
    };
    const tick = (): void => {
      if (stopped || lost) return;
      renewal = renewal.then(() => { checkpoint(); }).catch(() => { lost = true; });
    };
    timer = setInterval(tick, claimRenewIntervalMs);
    timer.unref?.();
    return {
      checkpoint,
      pin: () => {
        if (!checkpoint() || handedOff) return null;
        const claim = currentDispatchClaim();
        if (claim === undefined || claim.jobId !== jobId || claim.owner !== owner) {
          lost = true;
          return null;
        }
        pinnedExpiry = claim.leaseExpiresAt;
        if (timer !== undefined) clearInterval(timer);
        return claim;
      },
      isLost: () => lost,
      stop: async () => {
        stopped = true;
        if (timer !== undefined) clearInterval(timer);
        await renewal;
      },
    };
  }

  function activeJobs(): readonly QueueRow[] {
    const result = rows(`SELECT * FROM jobs WHERE state IN ('starting','preflight','source','release_gates','frontend','target_setup','feeds','config','building','verifying','cancel_requested') OR queue_state='dispatched' ORDER BY updated_at, job_id`);
    if (result.some((value) => rowJobId(value) === null || !isActiveState(value.state))) throw new Error('database returned a malformed active job row');
    return result;
  }

  function oldestQueued(): QueueRow | undefined {
    const result = rows(`SELECT jobs.* FROM queue_entries JOIN jobs ON jobs.job_id=queue_entries.job_id
      WHERE jobs.state='queued' AND jobs.queue_state='queued' ORDER BY queue_entries.fifo_seq, queue_entries.job_id LIMIT 1`);
    if (result.some((value) => rowJobId(value) === null || value.state !== 'queued' || value.queue_state !== 'queued')) throw new Error('database returned a malformed queued job row');
    return result[0];
  }

  async function safetyBlocker(phase: 'before-claim' | 'before-start' | 'direct-proof', jobId?: string): Promise<QueueBlocker | null> {
    if (options.safety === undefined) return { code: 'SAFETY_CHECK_UNAVAILABLE', details: { phase } };
    try {
      const result = await boundedOperation('safety inspection', (signal) => options.safety!.inspect({ phase, jobId }, signal));
      if (result === null) return null;
      if (typeof result.code !== 'string' || result.code.length === 0) return { code: 'SAFETY_CHECK_INVALID', details: { phase } };
      return result;
    } catch (error) {
      if (error instanceof QueueOperationTimeoutError) return { code: 'SAFETY_CHECK_TIMEOUT', details: { phase } };
      return { code: 'SAFETY_CHECK_UNAVAILABLE', details: { phase, error: error instanceof Error ? error.message : String(error) } };
    }
  }

  function databaseBlocker(expectedDispatchJobId?: string): QueueBlocker | null {
    const activity = expectedDispatchJobId === undefined
      ? `(queue_state='dispatched'
        OR state IN ('starting','preflight','source','release_gates','frontend','target_setup','feeds','config','building','verifying','cancel_requested'))`
      : `(job_id<>? AND (queue_state='dispatched'
        OR state IN ('starting','preflight','source','release_gates','frontend','target_setup','feeds','config','building','verifying','cancel_requested')))`;
    const row = one(`SELECT job_id FROM jobs
      WHERE (${activity}
        OR cleanup_fence_generation IS NOT NULL
        OR cleanup_admission_id IS NOT NULL
        OR cleanup_blocker_code IS NOT NULL OR cleanup_blocker_json IS NOT NULL
        OR container_id IS NOT NULL OR container_name IS NOT NULL OR container_image_digest IS NOT NULL
        OR container_label_job_id IS NOT NULL OR container_label_manifest_sha IS NOT NULL OR container_labels_json IS NOT NULL
        OR artifact_staging_path IS NOT NULL OR artifact_quarantine_intent_path IS NOT NULL
        OR (artifact_quarantine_path IS NOT NULL AND publish_state IS NOT 'quarantined')
        OR publish_blocker_code IS NOT NULL OR publish_blocker_json IS NOT NULL
        OR publish_state IN ('blocked','publishing')
        OR EXISTS (SELECT 1 FROM job_log_generations AS logs WHERE logs.job_id=jobs.job_id AND logs.sealed_at IS NULL))
      LIMIT 1`, ...(expectedDispatchJobId === undefined ? [] : [expectedDispatchJobId]));
    const jobId = row === undefined ? null : rowJobId(row);
    if (row !== undefined && jobId === null) return { code: 'DATABASE_RESULT_INVALID' };
    return jobId === null ? null : { code: 'SQLITE_QUEUE_BLOCKER', details: { jobId } };
  }

  async function systemdBlocker(unit: string): Promise<QueueBlocker | null> {
    if (!RUNNER_UNIT.test(unit)) return { code: 'INVALID_RUNNER_UNIT', details: { unit } };
    if (options.systemd.listActive === undefined) return { code: 'SYSTEMD_INSPECTION_UNAVAILABLE' };
    try {
      const startedAt = clockReading();
      const active = await boundedOperation('systemd active-unit inspection', (signal) => options.systemd.listActive!(signal));
      const finishedAt = clockReading();
      if (!Array.isArray(active) || active.length > MAX_ACTIVE_RUNNER_UNITS || Date.parse(startedAt) > Date.parse(finishedAt)) return { code: 'INVALID_SYSTEMD_LIST' };
      for (const activeUnit of active) {
        if (typeof activeUnit !== 'string' || !RUNNER_UNIT.test(activeUnit)) return { code: 'INVALID_SYSTEMD_UNIT', details: { unit: activeUnit } };
      }
      return active.length === 0 ? null : { code: 'LIVE_RUNNER_UNIT', details: { unit: active[0]! } };
    } catch (error) {
      if (error instanceof QueueOperationTimeoutError) return { code: 'SYSTEMD_INSPECTION_TIMEOUT' };
      return { code: 'SYSTEMD_INSPECTION_UNAVAILABLE', details: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  async function inspectInactive(unit: string): Promise<SystemdUnitObservation | QueueBlocker> {
    try {
      const startedAt = clockReading();
      const observation = await boundedOperation('systemd unit inspection', (signal) => options.systemd.inspect(unit, signal));
      const finishedAt = clockReading();
      const observedAt = safeObservation(observation, unit) ? Date.parse(observation.observedAt) : Number.NaN;
      if (!Number.isFinite(observedAt) || observedAt < Date.parse(startedAt) || observedAt > Date.parse(finishedAt)) return { code: 'INVALID_SYSTEMD_OBSERVATION', details: { unit } };
      if (observedAt < lastObservationAt) return { code: 'SYSTEMD_OBSERVATION_OUT_OF_ORDER', details: { unit } };
      lastObservationAt = observedAt;
      return observation;
    } catch (error) {
      if (error instanceof QueueOperationTimeoutError) return { code: 'SYSTEMD_INSPECTION_TIMEOUT', details: { unit } };
      return { code: 'SYSTEMD_INSPECTION_UNAVAILABLE', details: { unit, error: error instanceof Error ? error.message : String(error) } };
    }
  }

  async function persistRecoveryBlocker(
    row: QueueRow,
    unit: string,
    reason: string,
    blocker: QueueBlocker,
    at: string,
    blockerCode: 'SERVICE_START_FAILED' | 'RUNNER_DISAPPEARED' = 'SERVICE_START_FAILED',
    dispatchClaimOwner?: string,
    dispatchClaimExpiresAt?: string,
  ): Promise<QueueDispatchResult> {
    const jobId = rowJobId(row);
    if (jobId === null || !isActiveState(row.state)) return { kind: 'blocked', reason: 'recovery predecessor is invalid', jobId: jobId ?? undefined };
    const result = options.ownership.apiWrite({
      kind: 'runner-recovery-blocker', jobId, expectedState: row.state, runnerUnit: unit,
      observedOwner: nullableText(row, 'runner_lease_owner'), observedLeaseExpiresAt: nullableText(row, 'runner_lease_expires_at'),
      blockerCode,
      blocker: { code: blockerCode, reason, blocker: objectDetails(blocker) }, dispatchClaimOwner, expectedClaimExpiresAt: dispatchClaimExpiresAt, at,
    });
    if (!success(result)) {
      return { kind: 'blocked', reason: resultMessage(result), jobId };
    }
    return { kind: 'recovery-blocked', jobId, blocker };
  }

  function currentRecoveryRow(row: QueueRow, jobId: string, unit: string, expectedLease: 'none' | 'stale' = 'none'): QueueRow | QueueDispatchResult {
    const current = currentJob(jobId);
    if (current === undefined || !isActiveState(current.state) || current.state !== row.state || current.runner_unit !== unit) {
      return { kind: 'blocked', reason: 'runner recovery predecessor changed', jobId };
    }
    const lease = runnerLeaseState(current, clockReading());
    if (lease.kind !== expectedLease) return { kind: 'blocked', reason: `RUNNER_LEASE_${lease.kind.toUpperCase()}`, jobId };
    return current;
  }

  async function recoverClaimed(row: QueueRow, unit: string, reason: string, claimOwner?: string, existingHeartbeat?: ClaimHeartbeat): Promise<QueueDispatchResult> {
    const jobId = rowJobId(row);
    if (jobId === null || !isActiveState(row.state)) return { kind: 'blocked', reason: 'claimed job identity is invalid' };
    const claim = currentDispatchClaim();
    if (claim === undefined || claim.jobId !== jobId) {
      const current = currentJob(jobId);
      if (current !== undefined && current.runner_lease_owner !== null && current.runner_lease_expires_at !== null) {
        const lease = runnerLeaseState(current, clockReading());
        if (lease.kind === 'live') return { kind: 'blocked', reason: 'RUNNER_LEASE_LIVE', jobId };
        if (lease.kind === 'stale') {
          const stale = currentRecoveryRow(row, jobId, unit, 'stale');
          if (isBlockedResult(stale)) return stale;
          return persistRecoveryBlocker(stale, unit, 'dispatcher observed an expired runner lease after claim handoff', { code: 'RUNNER_DISAPPEARED', details: { unit } }, clockReading(), 'RUNNER_DISAPPEARED');
        }
      }
      return { kind: 'blocked', reason: 'DISPATCH_CLAIM_MISSING', jobId };
    }
    if (claimOwner !== undefined && claim.owner !== claimOwner) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
    if (claim.phase === 'pre-start') {
      const current = currentRecoveryRow(row, jobId, unit);
      if (isBlockedResult(current)) return current;
      const heartbeat = existingHeartbeat ?? claimHeartbeat(jobId, claim.owner);
      const ownsHeartbeat = existingHeartbeat === undefined;
      try {
        if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        const inspected = await inspectInactive(unit);
        if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        if ('code' in inspected) return { kind: 'blocked', reason: inspected.code, jobId };
        if (observationIsLive(inspected)) return { kind: 'blocked', reason: 'runner unit is live', jobId };
        const safety = await safetyBlocker('direct-proof', jobId);
        if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        const final = await inspectInactive(unit);
        if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        if ('code' in final) return { kind: 'blocked', reason: final.code, jobId };
        if (!observationIsInactive(final) || Date.parse(final.observedAt) < Date.parse(inspected.observedAt)) {
          return { kind: 'blocked', reason: 'runner unit is live or final inactivity proof is ambiguous', jobId };
        }
        const at = laterInstant(clockReading(), final.observedAt);
        if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        const finalClaim = currentDispatchClaim();
        if (finalClaim === undefined || finalClaim.jobId !== jobId || finalClaim.owner !== claim.owner || finalClaim.phase !== 'pre-start') {
          return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        }
        const blocker = safety ?? { code: 'SERVICE_START_FAILED', details: { reason, inactiveAt: final.observedAt } };
        return persistRecoveryBlocker(current, unit, reason, blocker, at, 'SERVICE_START_FAILED', finalClaim.owner, finalClaim.leaseExpiresAt);
      } finally {
        if (ownsHeartbeat) await heartbeat.stop();
      }
    }
    if (claim.startAttemptedAt === null || claim.unitInactiveAt === null) return { kind: 'blocked', reason: 'DISPATCH_CLAIM_MALFORMED', jobId };
    const startAttemptedAt = claim.startAttemptedAt;
    const unitInactiveAt = claim.unitInactiveAt;
    const heartbeat = existingHeartbeat ?? claimHeartbeat(jobId, claim.owner);
    const ownsHeartbeat = existingHeartbeat === undefined;
    try {
      if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
      const inspected = await inspectInactive(unit);
      if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
      if ('code' in inspected) return { kind: 'blocked', reason: inspected.code, jobId };
      if (observationIsLive(inspected)) return { kind: 'blocked', reason: 'runner unit is live', jobId };
      if (Date.parse(inspected.observedAt) < Date.parse(claim.unitInactiveAt)) return { kind: 'blocked', reason: 'runner inactivity proof is stale', jobId };
      const current = currentRecoveryRow(row, jobId, unit);
      if (isBlockedResult(current)) return current;
      const currentClaim = currentDispatchClaim();
      if (currentClaim === undefined || currentClaim.jobId !== jobId || currentClaim.owner !== claim.owner || currentClaim.phase !== 'start-attempted' || currentClaim.startAttemptedAt !== claim.startAttemptedAt) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
      const safety = await safetyBlocker('direct-proof', jobId);
      if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
      if (safety !== null) {
        const final = await inspectInactive(unit);
        if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        if ('code' in final) return { kind: 'blocked', reason: final.code, jobId };
        if (!observationIsInactive(final) || Date.parse(final.observedAt) < Date.parse(inspected.observedAt) || Date.parse(final.observedAt) < Date.parse(claim.startAttemptedAt)) {
          return { kind: 'blocked', reason: 'runner unit is live or final inactivity proof is ambiguous', jobId };
        }
        const at = laterInstant(clockReading(), final.observedAt);
        if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        const finalClaim = currentDispatchClaim();
        if (finalClaim === undefined || finalClaim.jobId !== jobId || finalClaim.owner !== claim.owner || finalClaim.phase !== 'start-attempted' || finalClaim.startAttemptedAt !== claim.startAttemptedAt || finalClaim.unitInactiveAt !== claim.unitInactiveAt) {
          return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        }
        return persistRecoveryBlocker(current, unit, reason, safety, at, 'SERVICE_START_FAILED', finalClaim.owner, finalClaim.leaseExpiresAt);
      }
      const proofClaim = heartbeat.pin();
      if (proofClaim === null
        || proofClaim.phase !== 'start-attempted'
        || proofClaim.startAttemptedAt !== claim.startAttemptedAt
        || proofClaim.unitInactiveAt !== claim.unitInactiveAt) {
        return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
      }
      let proof: DirectInterruptionProof | null = null;
      try {
        proof = options.directInterrupt === undefined
          ? null
          : await boundedOperation('direct interruption proof', (signal) => options.directInterrupt!({
            jobId,
            runnerUnit: unit,
            startAttemptedAt,
            unitInactiveAt,
            expectedClaimExpiresAt: proofClaim.leaseExpiresAt,
            reason,
          }, signal));
      } catch (error) {
        if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        const final = await inspectInactive(unit);
        if (!heartbeat.checkpoint() || 'code' in final || !observationIsInactive(final) || Date.parse(final.observedAt) < Date.parse(inspected.observedAt) || Date.parse(final.observedAt) < Date.parse(claim.startAttemptedAt)) {
          return { kind: 'blocked', reason: 'runner unit is live or final inactivity proof is ambiguous', jobId };
        }
        const at = laterInstant(clockReading(), final.observedAt);
        if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        const finalClaim = currentDispatchClaim();
        if (finalClaim === undefined || finalClaim.jobId !== jobId || finalClaim.owner !== claim.owner || finalClaim.phase !== 'start-attempted' || finalClaim.startAttemptedAt !== claim.startAttemptedAt || finalClaim.unitInactiveAt !== claim.unitInactiveAt) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        return persistRecoveryBlocker(current, unit, reason, { code: 'DIRECT_PROOF_UNAVAILABLE', details: { error: error instanceof Error ? error.message : String(error) } }, at, 'SERVICE_START_FAILED', finalClaim.owner, finalClaim.leaseExpiresAt);
      }
      if (proof === null) {
        const final = await inspectInactive(unit);
        if (!heartbeat.checkpoint() || 'code' in final || !observationIsInactive(final) || Date.parse(final.observedAt) < Date.parse(inspected.observedAt) || Date.parse(final.observedAt) < Date.parse(claim.startAttemptedAt)) {
          return { kind: 'blocked', reason: 'runner unit is live or final inactivity proof is ambiguous', jobId };
        }
        const at = laterInstant(clockReading(), final.observedAt);
        if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        const finalClaim = currentDispatchClaim();
        if (finalClaim === undefined || finalClaim.jobId !== jobId || finalClaim.owner !== claim.owner || finalClaim.phase !== 'start-attempted' || finalClaim.startAttemptedAt !== claim.startAttemptedAt || finalClaim.unitInactiveAt !== claim.unitInactiveAt) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        return persistRecoveryBlocker(current, unit, reason, { code: 'DIRECT_PROOF_UNAVAILABLE' }, at, 'SERVICE_START_FAILED', finalClaim.owner, finalClaim.leaseExpiresAt);
      }
      if (!heartbeat.checkpoint() || proof.kind !== 'start-failure' || proof.runnerUnit !== unit || proof.startAttemptedAt !== claim.startAttemptedAt || proof.unitInactiveAt !== claim.unitInactiveAt
        || Date.parse(proof.container.observedAt) < Date.parse(claim.startAttemptedAt)
        || Date.parse(proof.logs.verifiedAt) < Date.parse(claim.startAttemptedAt)) {
        return { kind: 'blocked', reason: 'DIRECT_PROOF_MISMATCH', jobId };
      }
      const final = await inspectInactive(unit);
      if (!heartbeat.checkpoint() || 'code' in final) return { kind: 'blocked', reason: 'code' in final ? final.code : 'dispatch claim ownership changed', jobId };
      if (!observationIsInactive(final)) return { kind: 'blocked', reason: 'runner unit is live', jobId };
      if (Date.parse(final.observedAt) < Date.parse(inspected.observedAt) || Date.parse(final.observedAt) < Date.parse(claim.startAttemptedAt)) return { kind: 'blocked', reason: 'final inactivity proof is stale', jobId };
      const at = laterInstant(clockReading(), final.observedAt);
      const trustedProof: DirectInterruptionProof = { ...proof, unitInactiveAt: final.observedAt };
      if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
      const finalClaim = currentDispatchClaim();
      if (finalClaim === undefined || finalClaim.jobId !== jobId || finalClaim.owner !== claim.owner || finalClaim.phase !== 'start-attempted' || finalClaim.startAttemptedAt !== claim.startAttemptedAt || finalClaim.unitInactiveAt !== claim.unitInactiveAt || finalClaim.leaseExpiresAt !== proofClaim.leaseExpiresAt) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
      const result = options.ownership.apiWrite({ kind: 'direct-interrupt', jobId, expectedState: row.state, at, proof: trustedProof, errorCode: 'SERVICE_START_FAILED', error: { reason }, dispatchClaimOwner: finalClaim.owner, expectedClaimExpiresAt: finalClaim.leaseExpiresAt, expectedStartAttemptedAt: finalClaim.startAttemptedAt, expectedUnitInactiveAt: finalClaim.unitInactiveAt });
      if (!success(result)) return { kind: 'blocked', reason: resultMessage(result), jobId };
      return { kind: 'interrupted', jobId };
    } finally {
      if (ownsHeartbeat) await heartbeat.stop();
    }
  }

  async function reconcileStarting(): Promise<QueueDispatchResult | null> {
    for (const row of activeJobs()) {
      const jobId = rowJobId(row);
      if (jobId === null) return { kind: 'blocked', reason: 'active job identity is invalid' };
      if (!isActiveState(row.state)) continue;
      if (row.cleanup_blocker_code !== null && row.cleanup_blocker_code !== undefined) return { kind: 'blocked', reason: 'active recovery blocker is unresolved', jobId };
      if (row.state !== 'starting') return { kind: 'blocked', reason: 'active runner is unresolved', jobId };
      const unit = nullableText(row, 'runner_unit');
      if (unit === null || unit !== runnerUnit(jobId)) return { kind: 'blocked', reason: 'persisted runner unit is invalid', jobId };
      const dispatchedAt = canonicalInstant(row.dispatched_at);
      if (dispatchedAt === null) return { kind: 'blocked', reason: 'persisted dispatch time is invalid', jobId };
      if (Date.parse(dispatchedAt) > Date.parse(clockReading())) return { kind: 'blocked', reason: 'persisted dispatch time is from the future', jobId };
      let claim = currentDispatchClaim();
      const lease = runnerLeaseState(row, clockReading());
      if (lease.kind === 'malformed') return { kind: 'blocked', reason: 'RUNNER_LEASE_MALFORMED', jobId };
      if (lease.kind === 'live') return { kind: 'blocked', reason: 'RUNNER_LEASE_LIVE', jobId };
      if (claim !== undefined && claim.jobId !== jobId) return { kind: 'blocked', reason: 'DISPATCH_CLAIM_LIVE', jobId };
      if (claim === undefined && lease.kind === 'none') return { kind: 'blocked', reason: 'DISPATCH_CLAIM_MISSING', jobId };
      if (claim !== undefined) {
        const claimNow = clockReading();
        if (Date.parse(claim.leaseExpiresAt) > Date.parse(claimNow)) return { kind: 'blocked', reason: 'DISPATCH_CLAIM_LIVE', jobId };
        const expiredObservation = await inspectInactive(unit);
        if ('code' in expiredObservation) return { kind: 'blocked', reason: expiredObservation.code, jobId };
        if (!observationIsInactive(expiredObservation)) return { kind: 'blocked', reason: 'runner unit is live', jobId };
        const expiredHeartbeat = claimHeartbeat(jobId, claim.owner);
        try {
          if (!expiredHeartbeat.checkpoint(true)) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
          const reclaimAt = clockReading();
          const verifiedClaim = currentDispatchClaim();
          if (verifiedClaim === undefined || verifiedClaim.jobId !== jobId || verifiedClaim.owner !== claim.owner || Date.parse(verifiedClaim.leaseExpiresAt) > Date.parse(reclaimAt)) {
            return { kind: 'blocked', reason: 'DISPATCH_CLAIM_LIVE', jobId };
          }
          const reclaimed = options.ownership.apiWrite({ kind: 'dispatch-reclaim', jobId, runnerUnit: unit, previousOwner: verifiedClaim.owner, claimOwner: coordinatorId, claimExpiresAt: dispatchClaimExpiry(reclaimAt, claimLeaseMs), at: reclaimAt });
          if (!success(reclaimed)) return { kind: 'blocked', reason: resultMessage(reclaimed), jobId };
          claim = currentDispatchClaim();
          if (claim === undefined || claim.jobId !== jobId || claim.owner !== coordinatorId) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        } finally {
          await expiredHeartbeat.stop();
        }
      }
      const recoveryHeartbeat = claim === undefined ? undefined : claimHeartbeat(jobId, claim.owner);
      try {
        const observation = await inspectInactive(unit);
        if (recoveryHeartbeat !== undefined && !recoveryHeartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        if ('code' in observation) return { kind: 'blocked', reason: observation.code, jobId };
        if (observationIsLive(observation)) return { kind: 'blocked', reason: 'runner unit is live', jobId };
        if (lease.kind === 'stale') {
          const current = currentRecoveryRow(row, jobId, unit, 'stale');
          if (isBlockedResult(current)) return current;
          const at = laterInstant(clockReading(), observation.observedAt);
          if (recoveryHeartbeat !== undefined && !recoveryHeartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
          const finalClaim = currentDispatchClaim();
          if (finalClaim !== undefined && (finalClaim.jobId !== jobId || finalClaim.owner !== claim?.owner)) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
          return persistRecoveryBlocker(current, unit, 'dispatcher observed an expired runner lease', { code: 'RUNNER_DISAPPEARED', details: { unit, inactiveAt: observation.observedAt } }, at, 'RUNNER_DISAPPEARED', finalClaim?.owner, finalClaim?.leaseExpiresAt);
        }
        if (claim === undefined) return { kind: 'blocked', reason: 'DISPATCH_CLAIM_MISSING', jobId };
        return await recoverClaimed(row, unit, 'dispatcher found a claimed starting job before service start', claim.owner, recoveryHeartbeat);
      } finally {
        await recoveryHeartbeat?.stop();
      }
    }
    return null;
  }

  async function dispatchNext(): Promise<QueueDispatchResult> {
    if (!startupReady) return { kind: 'blocked', reason: startupBlocker?.code ?? 'STARTUP_RECONCILIATION_INCOMPLETE' };
    if (dispatchInFlight) return { kind: 'blocked', reason: 'dispatcher already has an in-flight claim' };
    dispatchInFlight = true;
    try {
      const recovered = await reconcileStarting();
      if (recovered !== null) return recovered;
      const global = databaseBlocker();
      if (global !== null) return { kind: 'blocked', reason: global.code, jobId: (global.details?.jobId as string | undefined) };
      const safety = await safetyBlocker('before-claim');
      if (safety !== null) return { kind: 'blocked', reason: safety.code };
      const candidate = oldestQueued();
      if (candidate === undefined) return { kind: 'idle' };
      const jobId = rowJobId(candidate);
      if (jobId === null) return { kind: 'blocked', reason: 'queued job identity is invalid' };
      const unit = runnerUnit(jobId);
      const liveBeforeClaim = await systemdBlocker(unit);
      if (liveBeforeClaim !== null) return { kind: 'blocked', reason: liveBeforeClaim.code, jobId };
      const dispatchAt = clockReading();
      const claimed = options.ownership.apiWrite({ kind: 'dispatch', jobId, runnerUnit: unit, at: dispatchAt, claimOwner: coordinatorId, claimExpiresAt: dispatchClaimExpiry(dispatchAt, claimLeaseMs) });
      if (!success(claimed)) return { kind: 'blocked', reason: resultMessage(claimed), jobId };
      const heartbeat = claimHeartbeat(jobId, coordinatorId);
      try {
        const afterClaimSafety = await safetyBlocker('before-start', jobId);
        if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        const claimedRow = currentJob(jobId);
        const claimedDispatch = currentDispatchClaim();
        if (claimedRow === undefined || claimedDispatch === undefined || claimedDispatch.jobId !== jobId || claimedDispatch.owner !== coordinatorId || claimedDispatch.phase !== 'pre-start') return { kind: 'blocked', reason: 'DISPATCH_CLAIM_MISSING', jobId };
        const afterClaimDatabase = databaseBlocker(jobId);
        if (afterClaimSafety !== null) return await recoverClaimed(claimedRow, unit, 'runtime blocker appeared after queue claim', coordinatorId, heartbeat);
        if (afterClaimDatabase !== null) return await recoverClaimed(claimedRow, unit, 'SQLite blocker appeared after queue claim', coordinatorId, heartbeat);
        const observation = await inspectInactive(unit);
        if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        if ('code' in observation) return await recoverClaimed(claimedRow, unit, observation.code, coordinatorId, heartbeat);
        if (observationIsLive(observation)) return await recoverClaimed(currentJob(jobId) ?? claimedRow, unit, 'runner unit became live before service start', coordinatorId, heartbeat);
        const beforeStart = await safetyBlocker('before-start', jobId);
        if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        if (beforeStart !== null) return await recoverClaimed(claimedRow, unit, 'runtime blocker appeared during final start check', coordinatorId, heartbeat);
        const liveBeforeStart = await systemdBlocker(unit);
        if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        if (liveBeforeStart !== null) return await recoverClaimed(claimedRow, unit, 'runner unit became live during final start check', coordinatorId, heartbeat);
        const sqliteBeforeStart = databaseBlocker(jobId);
        if (sqliteBeforeStart !== null) return await recoverClaimed(claimedRow, unit, 'SQLite blocker appeared during final start check', coordinatorId, heartbeat);
        if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        const currentBeforeStart = currentDispatchClaim();
        if (currentBeforeStart === undefined || currentBeforeStart.jobId !== jobId || currentBeforeStart.owner !== coordinatorId || currentBeforeStart.phase !== 'pre-start') return { kind: 'blocked', reason: 'DISPATCH_CLAIM_MISSING', jobId };
        const startAttemptedAt = clockReading();
        const startOwnership = options.ownership.apiWrite({ kind: 'dispatch-start', jobId, runnerUnit: unit, claimOwner: coordinatorId, expectedClaimExpiresAt: currentBeforeStart.leaseExpiresAt, claimExpiresAt: dispatchClaimExpiry(startAttemptedAt, claimLeaseMs), unitInactiveAt: observation.observedAt, startAttemptedAt, at: startAttemptedAt });
        if (!success(startOwnership)) return { kind: 'blocked', reason: resultMessage(startOwnership), jobId };
        let start: unknown;
        try { start = await boundedOperation('systemd start', (signal) => options.systemd.start(unit, signal)); }
        catch (error) {
          if (error instanceof QueueOperationTimeoutError) return { kind: 'blocked', reason: 'SYSTEMD_START_TIMEOUT', jobId };
          if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
          return await recoverClaimed(claimedRow, unit, `systemd start threw: ${error instanceof Error ? error.message : String(error)}`, coordinatorId, heartbeat);
        }
        if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        if (!safeResult(start) || start.unit !== unit || JSON.stringify(start.argv) !== JSON.stringify(START_ARGV(unit)) || start.exitCode !== 0 || start.timedOut || start.signal !== undefined && start.signal !== null) {
          return await recoverClaimed(claimedRow, unit, 'systemd service start failed or returned an invalid command result', coordinatorId, heartbeat);
        }
        const postStart = await inspectInactive(unit);
        if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        if ('code' in postStart) return await recoverClaimed(claimedRow, unit, postStart.code, coordinatorId, heartbeat);
        if (!postStart.active || postStart.pending || Date.parse(postStart.observedAt) < Date.parse(startAttemptedAt)) return await recoverClaimed(claimedRow, unit, 'systemd start did not produce a fresh active observation', coordinatorId, heartbeat);
        if (!heartbeat.checkpoint()) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
        return { kind: 'started', jobId, runnerUnit: unit };
      } finally {
        await heartbeat.stop();
      }
    } catch (error) {
      if (error instanceof OwnershipConflictError) return { kind: 'blocked', reason: error.message };
      return { kind: 'blocked', reason: error instanceof Error ? error.message : String(error) };
    } finally {
      dispatchInFlight = false;
    }
  }

  function beginStartupReconciliation(): void {
    startupReady = false;
    startupBlocker = null;
  }

  function completeStartupReconciliation(blockers: readonly QueueBlocker[] = []): void {
    if (blockers.length > 0) {
      startupReady = false;
      startupBlocker = blockers[0] ?? null;
      return;
    }
    startupBlocker = null;
    startupReady = true;
  }

  return Object.freeze({ dispatchNext, beginStartupReconciliation, completeStartupReconciliation });
}

export function createQueueCoordinator(options: QueueCoordinatorOptions): QueueCoordinator {
  const internal = createQueueCoordinatorInternal(options);
  return Object.freeze({ dispatchNext: internal.dispatchNext });
}

export function createReadyQueueCoordinatorForTesting(options: QueueCoordinatorOptions): QueueCoordinator {
  if (process.env.NODE_ENV !== 'test') throw new Error('createReadyQueueCoordinatorForTesting requires NODE_ENV=test');
  const internal = createQueueCoordinatorInternal(options);
  internal.completeStartupReconciliation([]);
  return Object.freeze({ dispatchNext: internal.dispatchNext });
}

function queueDispatchPhase(result: QueueDispatchResult): StartupPhaseResult {
  if (result.kind === 'recovery-blocked') return { blockers: [result.blocker] };
  if (result.kind === 'blocked') return {
    blockers: [{ code: 'QUEUE_DISPATCH_BLOCKED', details: { reason: result.reason, ...(result.jobId === undefined ? {} : { jobId: result.jobId }) } }],
  };
  return { blockers: [] };
}

export function createStartupBootstrap(options: StartupBootstrapOptions): StartupBootstrap {
  const internal = createQueueCoordinatorInternal(options.queue);
  const startupGate: QueueStartupGate = {
    beginStartupReconciliation: internal.beginStartupReconciliation,
    completeStartupReconciliation: internal.completeStartupReconciliation,
  };
  let coordinatorPromise: Promise<StartupCoordinator> | undefined;
  let coordinatorInstance: StartupCoordinator | undefined;
  const coordinator = (): Promise<StartupCoordinator> => {
    if (coordinatorPromise === undefined) {
      coordinatorPromise = import('./startup-order.js')
        .then(({ createStartupCoordinator }) => createStartupCoordinator({
          ...options.services,
          queueGate: startupGate,
          dispatch: async () => queueDispatchPhase(await internal.dispatchNext()),
        }))
        .then((created) => {
          coordinatorInstance = created;
          return created;
        });
    }
    return coordinatorPromise;
  };
  const reconcile = async (): Promise<StartupResult> => {
    internal.beginStartupReconciliation();
    const services = [
      options.services.cleanupAdmissions,
      options.services.liveRunnerClassification,
      options.services.cancellationCoordination,
      options.services.stalePublishingRecovery,
      options.services.nonPublishingInterruption,
    ] as const;
    const reconciliationBlockers: QueueBlocker[] = [];
    for (const service of services) {
      const result = await service();
      if (!result || !Array.isArray(result.blockers)) {
        throw new TypeError('reconciliation phase returned an invalid result');
      }
      reconciliationBlockers.push(...result.blockers);
    }
    if (reconciliationBlockers.length > 0) {
      internal.completeStartupReconciliation(reconciliationBlockers);
      return Object.freeze({
        dispatched: false,
        blockers: Object.freeze(reconciliationBlockers),
      });
    }
    internal.completeStartupReconciliation([]);
    const dispatchResult = queueDispatchPhase(await internal.dispatchNext());
    return Object.freeze({
      dispatched: dispatchResult.blockers.length === 0,
      blockers: Object.freeze([...dispatchResult.blockers]),
    });
  };
  return Object.freeze({
    start: async () => (await coordinator()).start(),
    reconcile,
    dispatch: async () => queueDispatchPhase(await internal.dispatchNext()),
    events: () => coordinatorInstance?.events() ?? [],
  });
}
