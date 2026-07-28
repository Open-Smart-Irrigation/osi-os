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

const ACTIVE_STATES = new Set<ActiveRecoveryState>([
  'starting', 'preflight', 'source', 'release_gates', 'frontend', 'target_setup',
  'feeds', 'config', 'building', 'verifying', 'cancel_requested',
]);

const RUNNER_UNIT = /^osi-image-builder-runner@[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.service$/u;
const START_ARGV = (unit: string): readonly string[] => ['systemctl', '--user', 'start', unit];
const MAX_ACTIVE_RUNNER_UNITS = 64;
const MAX_ACTIVE_DATABASE_ROWS = 64;
const DISPATCH_CLAIM_LEASE_MS = 30_000;

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
  readonly inspect: (unit: string) => Promise<SystemdUnitObservation>;
  readonly start: (unit: string) => Promise<SystemdStartResult>;
  readonly listActive?: () => Promise<readonly string[]>;
}

export interface QueueBlocker {
  readonly code: string;
  readonly details?: JsonObject;
}

export interface QueueSafetyChecks {
  readonly inspect: (input: Readonly<{
    readonly phase: 'before-claim' | 'before-start' | 'direct-proof';
    readonly jobId?: string;
  }>) => Promise<QueueBlocker | null>;
}

export interface DirectInterruptionInput {
  readonly jobId: string;
  readonly runnerUnit: string;
  readonly startAttemptedAt: string;
  readonly unitInactiveAt: string;
  readonly reason: string;
}

export interface QueueCoordinatorOptions {
  readonly db: DatabaseSync | QueueDatabase;
  readonly ownership: Pick<OwnershipStore, 'apiWrite'>;
  readonly systemd: QueueSystemd;
  readonly safety?: QueueSafetyChecks;
  readonly directInterrupt?: (input: DirectInterruptionInput) => Promise<DirectInterruptionProof | null>;
  readonly clock?: Readonly<{ readonly now: () => string }>;
  readonly coordinatorId?: string;
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

function dispatchClaimExpiry(at: string): string {
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) throw new Error('dispatch claim time is invalid');
  return new Date(parsed + DISPATCH_CLAIM_LEASE_MS).toISOString();
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
  return observation.unit === expectedUnit && typeof observation.active === 'boolean' && canonicalInstant(observation.observedAt) !== null;
}

export function createQueueCoordinator(options: QueueCoordinatorOptions): QueueCoordinator {
  const db = database(options.db);
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const coordinatorId = options.coordinatorId ?? `queue-dispatcher-${randomUUID()}`;
  let dispatchInFlight = false;
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
      const result = await options.safety.inspect({ phase, jobId });
      if (result === null) return null;
      if (typeof result.code !== 'string' || result.code.length === 0) return { code: 'SAFETY_CHECK_INVALID', details: { phase } };
      return result;
    } catch (error) {
      return { code: 'SAFETY_CHECK_UNAVAILABLE', details: { phase, error: error instanceof Error ? error.message : String(error) } };
    }
  }

  function databaseBlocker(excludeJobId?: string): QueueBlocker | null {
    const suffix = excludeJobId === undefined ? '' : ' AND job_id<>?';
    const row = one(`SELECT job_id FROM jobs
      WHERE (queue_state='dispatched'
        OR state IN ('starting','preflight','source','release_gates','frontend','target_setup','feeds','config','building','verifying','cancel_requested')
        OR cleanup_fence_generation IS NOT NULL
        OR cleanup_admission_id IS NOT NULL
        OR cleanup_blocker_code IS NOT NULL OR cleanup_blocker_json IS NOT NULL
        OR container_id IS NOT NULL OR container_name IS NOT NULL OR container_image_digest IS NOT NULL
        OR container_label_job_id IS NOT NULL OR container_label_manifest_sha IS NOT NULL OR container_labels_json IS NOT NULL
        OR artifact_staging_path IS NOT NULL OR artifact_quarantine_intent_path IS NOT NULL
        OR (artifact_quarantine_path IS NOT NULL AND publish_state IS NOT 'quarantined')
        OR publish_blocker_code IS NOT NULL OR publish_blocker_json IS NOT NULL
        OR publish_state IN ('blocked','publishing')
        OR EXISTS (SELECT 1 FROM job_log_generations AS logs WHERE logs.job_id=jobs.job_id AND logs.sealed_at IS NULL))${suffix}
      LIMIT 1`, ...(excludeJobId === undefined ? [] : [excludeJobId]));
    const jobId = row === undefined ? null : rowJobId(row);
    if (row !== undefined && jobId === null) return { code: 'DATABASE_RESULT_INVALID' };
    return jobId === null ? null : { code: 'SQLITE_QUEUE_BLOCKER', details: { jobId } };
  }

  async function systemdBlocker(unit: string): Promise<QueueBlocker | null> {
    if (!RUNNER_UNIT.test(unit)) return { code: 'INVALID_RUNNER_UNIT', details: { unit } };
    if (options.systemd.listActive === undefined) return { code: 'SYSTEMD_INSPECTION_UNAVAILABLE' };
    try {
      const startedAt = clockReading();
      const active = await options.systemd.listActive();
      const finishedAt = clockReading();
      if (!Array.isArray(active) || active.length > MAX_ACTIVE_RUNNER_UNITS || Date.parse(startedAt) > Date.parse(finishedAt)) return { code: 'INVALID_SYSTEMD_LIST' };
      for (const activeUnit of active) {
        if (typeof activeUnit !== 'string' || !RUNNER_UNIT.test(activeUnit)) return { code: 'INVALID_SYSTEMD_UNIT', details: { unit: activeUnit } };
      }
      return active.length === 0 ? null : { code: 'LIVE_RUNNER_UNIT', details: { unit: active[0]! } };
    } catch (error) {
      return { code: 'SYSTEMD_INSPECTION_UNAVAILABLE', details: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  async function inspectInactive(unit: string): Promise<SystemdUnitObservation | QueueBlocker> {
    try {
      const startedAt = clockReading();
      const observation = await options.systemd.inspect(unit);
      const finishedAt = clockReading();
      const observedAt = safeObservation(observation, unit) ? Date.parse(observation.observedAt) : Number.NaN;
      if (!Number.isFinite(observedAt) || observedAt < Date.parse(startedAt) || observedAt > Date.parse(finishedAt)) return { code: 'INVALID_SYSTEMD_OBSERVATION', details: { unit } };
      if (observedAt < lastObservationAt) return { code: 'SYSTEMD_OBSERVATION_OUT_OF_ORDER', details: { unit } };
      lastObservationAt = observedAt;
      return observation;
    } catch (error) {
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
  ): Promise<QueueDispatchResult> {
    const jobId = rowJobId(row);
    if (jobId === null || !isActiveState(row.state)) return { kind: 'blocked', reason: 'recovery predecessor is invalid', jobId: jobId ?? undefined };
    const result = options.ownership.apiWrite({
      kind: 'runner-recovery-blocker', jobId, expectedState: row.state, runnerUnit: unit,
      observedOwner: nullableText(row, 'runner_lease_owner'), observedLeaseExpiresAt: nullableText(row, 'runner_lease_expires_at'),
      blockerCode,
      blocker: { code: blockerCode, reason, blocker: objectDetails(blocker) }, dispatchClaimOwner, at,
    });
    if (!success(result)) return { kind: 'blocked', reason: resultMessage(result), jobId };
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

  async function recoverClaimed(row: QueueRow, unit: string, reason: string, attemptedAt: string, claimOwner?: string): Promise<QueueDispatchResult> {
    const jobId = rowJobId(row);
    if (jobId === null || !isActiveState(row.state)) return { kind: 'blocked', reason: 'claimed job identity is invalid' };
    const claim = currentDispatchClaim();
    const durableClaim = claim?.jobId === jobId ? claim : undefined;
    const proofClaim = durableClaim?.phase === 'start-attempted' ? durableClaim : undefined;
    const effectiveClaimOwner = proofClaim?.owner;
    const releaseClaimOwner = durableClaim?.owner ?? claimOwner;
    const effectiveAttemptedAt = proofClaim?.startAttemptedAt ?? attemptedAt;
    if (proofClaim !== undefined && claimOwner !== undefined && claimOwner !== proofClaim.owner) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
    const inspected = await inspectInactive(unit);
    if ('code' in inspected) return { kind: 'blocked', reason: inspected.code, jobId };
    if (inspected.active) return { kind: 'blocked', reason: 'runner unit is live', jobId };
    const current = currentRecoveryRow(row, jobId, unit);
    if (isBlockedResult(current)) return current;
    const safety = await safetyBlocker('direct-proof', jobId);
    if (safety !== null) return persistRecoveryBlocker(current, unit, reason, safety, laterInstant(clockReading(), inspected.observedAt), 'SERVICE_START_FAILED', releaseClaimOwner);
    let proof: DirectInterruptionProof | null = null;
    try {
      proof = options.directInterrupt === undefined
        ? null
        : await options.directInterrupt({ jobId, runnerUnit: unit, startAttemptedAt: effectiveAttemptedAt, unitInactiveAt: inspected.observedAt, reason });
    } catch (error) {
      const final = await inspectInactive(unit);
      if ('code' in final || final.active || Date.parse(final.observedAt) < Date.parse(inspected.observedAt) || Date.parse(final.observedAt) < Date.parse(effectiveAttemptedAt)) {
        return { kind: 'blocked', reason: 'runner unit is live or final inactivity proof is ambiguous', jobId };
      }
      return persistRecoveryBlocker(current, unit, reason, { code: 'DIRECT_PROOF_UNAVAILABLE', details: { error: error instanceof Error ? error.message : String(error) } }, laterInstant(clockReading(), final.observedAt), 'SERVICE_START_FAILED', releaseClaimOwner);
    }
    if (proof === null) {
      const final = await inspectInactive(unit);
      if ('code' in final || final.active || Date.parse(final.observedAt) < Date.parse(inspected.observedAt) || Date.parse(final.observedAt) < Date.parse(effectiveAttemptedAt)) {
        return { kind: 'blocked', reason: 'runner unit is live or final inactivity proof is ambiguous', jobId };
      }
      return persistRecoveryBlocker(current, unit, reason, { code: 'DIRECT_PROOF_UNAVAILABLE' }, laterInstant(clockReading(), final.observedAt), 'SERVICE_START_FAILED', releaseClaimOwner);
    }
    if (proof.kind !== 'start-failure' || proof.startAttemptedAt !== effectiveAttemptedAt || proof.unitInactiveAt !== inspected.observedAt) {
      return { kind: 'blocked', reason: 'DIRECT_PROOF_MISMATCH', jobId };
    }
    const final = await inspectInactive(unit);
    if ('code' in final) return { kind: 'blocked', reason: final.code, jobId };
    if (final.active) return { kind: 'blocked', reason: 'runner unit is live', jobId };
    if (Date.parse(final.observedAt) < Date.parse(inspected.observedAt) || Date.parse(final.observedAt) < Date.parse(effectiveAttemptedAt)) {
      return { kind: 'blocked', reason: 'final inactivity proof is stale', jobId };
    }
    const at = laterInstant(clockReading(), final.observedAt);
    if (effectiveClaimOwner !== undefined && proofClaim !== undefined) {
      const observed = options.ownership.apiWrite({ kind: 'dispatch-proof-observation', jobId, claimOwner: effectiveClaimOwner, unitInactiveAt: inspected.observedAt, at });
      if (!success(observed)) return { kind: 'blocked', reason: resultMessage(observed), jobId };
    }
    const result = options.ownership.apiWrite({ kind: 'direct-interrupt', jobId, expectedState: row.state, at, proof, errorCode: 'SERVICE_START_FAILED', error: { reason }, dispatchClaimOwner: effectiveClaimOwner, expectedStartAttemptedAt: effectiveAttemptedAt, expectedUnitInactiveAt: inspected.observedAt });
    if (!success(result)) return { kind: 'blocked', reason: resultMessage(result), jobId };
    if (releaseClaimOwner !== undefined && releaseClaimOwner !== effectiveClaimOwner) {
      const released = options.ownership.apiWrite({ kind: 'dispatch-release', jobId, claimOwner: releaseClaimOwner, at });
      if (!success(released)) return { kind: 'blocked', reason: resultMessage(released), jobId };
    }
    return { kind: 'interrupted', jobId };
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
      if (claim !== undefined) {
        if (claim.jobId !== jobId) return { kind: 'blocked', reason: 'DISPATCH_CLAIM_LIVE', jobId };
        const claimLeaseLive = Date.parse(claim.leaseExpiresAt) > Date.parse(clockReading());
        if (claimLeaseLive && claim.owner !== coordinatorId) return { kind: 'blocked', reason: 'DISPATCH_CLAIM_LIVE', jobId };
        if (claim.phase === 'pre-start' && claimLeaseLive) return { kind: 'blocked', reason: 'DISPATCH_CLAIM_PRE_START', jobId };
        if (claim.phase === 'start-attempted' && claim.startAttemptedAt === null) return { kind: 'blocked', reason: 'DISPATCH_CLAIM_MALFORMED', jobId };
      }
      const lease = runnerLeaseState(row, clockReading());
      if (lease.kind === 'malformed') return { kind: 'blocked', reason: 'RUNNER_LEASE_MALFORMED', jobId };
      if (lease.kind === 'live') return { kind: 'blocked', reason: 'RUNNER_LEASE_LIVE', jobId };
      if (lease.kind === 'stale') {
        const observation = await inspectInactive(unit);
        if ('code' in observation) return { kind: 'blocked', reason: observation.code, jobId };
        if (observation.active) return { kind: 'blocked', reason: 'runner unit is live', jobId };
        const current = currentRecoveryRow(row, jobId, unit, 'stale');
        if (isBlockedResult(current)) return current;
        return persistRecoveryBlocker(current, unit, 'dispatcher observed an expired runner lease', { code: 'RUNNER_DISAPPEARED', details: { unit, inactiveAt: observation.observedAt } }, laterInstant(clockReading(), observation.observedAt), 'RUNNER_DISAPPEARED', claim?.owner);
      }
      const observation = await inspectInactive(unit);
      if ('code' in observation) return { kind: 'blocked', reason: observation.code, jobId };
      if (observation.active) return { kind: 'blocked', reason: 'runner unit is live', jobId };
      if (claim !== undefined && Date.parse(claim.leaseExpiresAt) <= Date.parse(clockReading()) && claim.owner !== coordinatorId) {
        const reclaimAt = clockReading();
        const reclaimed = options.ownership.apiWrite({ kind: 'dispatch-reclaim', jobId, runnerUnit: unit, previousOwner: claim.owner, claimOwner: coordinatorId, claimExpiresAt: dispatchClaimExpiry(reclaimAt), at: reclaimAt });
        if (!success(reclaimed)) return { kind: 'blocked', reason: resultMessage(reclaimed), jobId };
        claim = currentDispatchClaim();
        if (claim === undefined || claim.jobId !== jobId || claim.owner !== coordinatorId) return { kind: 'blocked', reason: 'dispatch claim ownership changed', jobId };
      }
      const recovered = await recoverClaimed(row, unit, 'dispatcher found a claimed starting job before service start', claim?.startAttemptedAt ?? dispatchedAt, claim?.owner);
      return recovered;
    }
    return null;
  }

  async function dispatchNext(): Promise<QueueDispatchResult> {
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
      const claimed = options.ownership.apiWrite({ kind: 'dispatch', jobId, runnerUnit: unit, at: dispatchAt, claimOwner: coordinatorId, claimExpiresAt: dispatchClaimExpiry(dispatchAt) });
      if (!success(claimed)) return { kind: 'blocked', reason: resultMessage(claimed), jobId };
      const afterClaimSafety = await safetyBlocker('before-start', jobId);
      const claimedRow = currentJob(jobId) ?? { ...candidate, state: 'starting', queue_state: 'dispatched', runner_unit: unit };
      const claimedDispatch = currentDispatchClaim();
      const claimOwner = claimedDispatch?.jobId === jobId && claimedDispatch.owner === coordinatorId ? claimedDispatch.owner : undefined;
      const afterClaimDatabase = databaseBlocker(jobId);
      if (afterClaimSafety !== null) return recoverClaimed(claimedRow, unit, 'runtime blocker appeared after queue claim', clockReading(), claimOwner);
      if (afterClaimDatabase !== null) return recoverClaimed(claimedRow, unit, 'SQLite blocker appeared after queue claim', clockReading(), claimOwner);
      const observation = await inspectInactive(unit);
      if ('code' in observation) return recoverClaimed(claimedRow, unit, observation.code, clockReading(), claimOwner);
      if (observation.active) return recoverClaimed(currentJob(jobId) ?? { ...candidate, state: 'starting', runner_unit: unit }, unit, 'runner unit became live before service start', observation.observedAt, claimOwner);
      const beforeStart = await safetyBlocker('before-start', jobId);
      if (beforeStart !== null) return recoverClaimed(claimedRow, unit, 'runtime blocker appeared during final start check', observation.observedAt, claimOwner);
      const liveBeforeStart = await systemdBlocker(unit);
      if (liveBeforeStart !== null) return recoverClaimed(claimedRow, unit, 'runner unit became live during final start check', observation.observedAt, claimOwner);
      const sqliteBeforeStart = databaseBlocker(jobId);
      if (sqliteBeforeStart !== null) return recoverClaimed(claimedRow, unit, 'SQLite blocker appeared during final start check', observation.observedAt, claimOwner);
      const startAttemptedAt = clockReading();
      if (claimOwner !== undefined) {
        const startOwnership = options.ownership.apiWrite({ kind: 'dispatch-start', jobId, runnerUnit: unit, claimOwner, unitInactiveAt: observation.observedAt, startAttemptedAt, at: startAttemptedAt });
        if (!success(startOwnership)) return { kind: 'blocked', reason: resultMessage(startOwnership), jobId };
      }
      let start: unknown;
      try { start = await options.systemd.start(unit); }
      catch (error) { return recoverClaimed(claimedRow, unit, `systemd start threw: ${error instanceof Error ? error.message : String(error)}`, startAttemptedAt, claimOwner); }
      if (!safeResult(start) || start.unit !== unit || JSON.stringify(start.argv) !== JSON.stringify(START_ARGV(unit)) || start.exitCode !== 0 || start.timedOut || start.signal !== undefined && start.signal !== null) {
        return recoverClaimed(claimedRow, unit, 'systemd service start failed or returned an invalid command result', startAttemptedAt, claimOwner);
      }
      const postStart = await inspectInactive(unit);
      if ('code' in postStart) return recoverClaimed(claimedRow, unit, postStart.code, startAttemptedAt, claimOwner);
      if (!postStart.active || Date.parse(postStart.observedAt) < Date.parse(startAttemptedAt)) return recoverClaimed(claimedRow, unit, 'systemd start did not produce a fresh active observation', startAttemptedAt, claimOwner);
      if (claimOwner !== undefined) {
        const released = options.ownership.apiWrite({ kind: 'dispatch-release', jobId, claimOwner, expectedPhase: 'start-attempted', at: laterInstant(clockReading(), postStart.observedAt) });
        if (!success(released)) return { kind: 'blocked', reason: resultMessage(released), jobId };
      }
      return { kind: 'started', jobId, runnerUnit: unit };
    } catch (error) {
      if (error instanceof OwnershipConflictError) return { kind: 'blocked', reason: error.message };
      return { kind: 'blocked', reason: error instanceof Error ? error.message : String(error) };
    } finally {
      dispatchInFlight = false;
    }
  }

  return Object.freeze({ dispatchNext });
}
