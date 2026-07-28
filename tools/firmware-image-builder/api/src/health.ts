import type { DatabaseSync } from 'node:sqlite';

import type { PipelineStageName } from '../../domain/types.js';
import type { JsonObject } from './store.js';

export type HealthRunnerLiveness = 'active' | 'stale' | 'inactive' | 'unknown';

export interface HealthBlocker {
  readonly code: string;
  readonly details?: JsonObject;
}

export interface HealthContainer {
  readonly id: string | null;
  readonly name: string | null;
  readonly imageDigest: string | null;
  readonly labels: JsonObject | null;
}

export interface HealthCleanup {
  readonly status: string | null;
  readonly generation: number;
  readonly handBackPending: boolean;
}

export interface HealthTerminalError {
  readonly code: string;
  readonly details: JsonObject | null;
  readonly at: string;
}

export interface HealthActiveJob {
  readonly jobId: string;
  readonly currentStage: PipelineStageName | null;
  readonly lastEventAt: string | null;
  readonly preflightExpiresAt: string | null;
  readonly terminalError?: HealthTerminalError | null;
  readonly queueBlockers?: readonly HealthBlocker[];
  readonly recoveryBlockers?: readonly HealthBlocker[];
  readonly staleLogAt?: string | null;
  readonly runner?: Readonly<{ readonly liveness: HealthRunnerLiveness }>;
  readonly cleanup?: HealthCleanup;
  readonly container?: HealthContainer | null;
}

export interface HealthInput {
  readonly now: string;
  readonly queueDepth: number;
  readonly activeJob: HealthActiveJob | null;
  readonly globalLastEventAt?: string | null;
  readonly diskFreeBytes: number;
  readonly builderImage: Readonly<{ readonly id: string | null; readonly digest: string | null }> | null;
  readonly lastTerminalError?: HealthTerminalError | null;
}

export interface HealthSnapshot {
  readonly queueDepth: number;
  readonly activeJobId: string | null;
  readonly currentStage: PipelineStageName | null;
  readonly lastEventAt: string | null;
  readonly lastEventAgeSeconds: number | null;
  readonly diskFreeBytes: number;
  readonly builderImage: Readonly<{ readonly id: string | null; readonly digest: string | null }> | null;
  readonly container: HealthContainer | null;
  readonly queueBlockers: readonly HealthBlocker[];
  readonly recoveryBlockers: readonly HealthBlocker[];
  readonly lastTerminalError: HealthTerminalError | null;
  readonly staleLogAgeSeconds: number | null;
  readonly runnerLiveness: HealthRunnerLiveness;
  readonly preflightExpiresAt: string | null;
  readonly cleanup: HealthCleanup;
}

export interface StructuredRecordInput {
  readonly jobId: string;
  readonly stage: PipelineStageName | null;
  readonly commandId: string;
  readonly timestamp: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface StructuredRecord {
  readonly jobId: string;
  readonly stage: PipelineStageName | null;
  readonly commandId: string;
  readonly timestamp: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface HealthDatabase {
  readonly prepare: (sql: string) => {
    readonly get: (...parameters: readonly unknown[]) => Readonly<Record<string, unknown>> | undefined;
    readonly all: (...parameters: readonly unknown[]) => readonly Readonly<Record<string, unknown>>[];
  };
}

export interface CollectHealthOptions {
  readonly db: DatabaseSync | HealthDatabase;
  readonly now: string;
  readonly diskFreeBytes: number;
  readonly builderImage: Readonly<{ readonly id: string | null; readonly digest: string | null }> | null;
  readonly runnerLiveness?: HealthRunnerLiveness;
}

const REDACTED = '[redacted]';
const SECRET_KEYS = new Set([
  'authorization', 'cookie', 'credential', 'credentialpath', 'password', 'passwd', 'secret',
  'token', 'accesstoken', 'refreshtoken', 'privatekey', 'ssh_auth_sock', 'git_ssh_command',
  'env', 'environment',
]);

function secretKey(key: string): boolean {
  const normalized = key.replaceAll('-', '').replaceAll('_', '').toLowerCase();
  return SECRET_KEYS.has(key.toLowerCase()) || SECRET_KEYS.has(normalized)
    || normalized.includes('token') || normalized.includes('password') || normalized.includes('secret')
    || normalized.includes('credential') || normalized.includes('privatekey') || normalized === 'env'
    || normalized === 'environment' || normalized === 'authorization' || normalized === 'cookie';
}

function redact(value: unknown, key?: string): unknown {
  if (key !== undefined && secretKey(key)) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) result[childKey] = redact(childValue, childKey);
    return result;
  }
  return value;
}

function ageSeconds(now: string, at: string | null | undefined): number | null {
  if (at === null || at === undefined) return null;
  const age = Math.floor((Date.parse(now) - Date.parse(at)) / 1_000);
  if (!Number.isFinite(age)) return null;
  return Math.max(0, age);
}

function blocker(code: unknown, details: unknown): HealthBlocker | null {
  if (typeof code !== 'string' || code.length === 0) return null;
  return { code, ...(details && typeof details === 'object' && !Array.isArray(details) ? { details: details as JsonObject } : {}) };
}

export function createStructuredRecord(input: StructuredRecordInput): StructuredRecord {
  return Object.freeze({
    jobId: input.jobId,
    stage: input.stage,
    commandId: input.commandId,
    timestamp: input.timestamp,
    fields: Object.freeze(redact(input.fields ?? {}) as Readonly<Record<string, unknown>>),
  });
}

export function buildHealthSnapshot(input: HealthInput): HealthSnapshot {
  const active = input.activeJob;
  const lastEventAt = active?.lastEventAt ?? input.globalLastEventAt ?? null;
  const staleLogAt = active?.staleLogAt ?? null;
  return Object.freeze({
    queueDepth: input.queueDepth,
    activeJobId: active?.jobId ?? null,
    currentStage: active?.currentStage ?? null,
    lastEventAt,
    lastEventAgeSeconds: ageSeconds(input.now, lastEventAt),
    diskFreeBytes: input.diskFreeBytes,
    builderImage: input.builderImage,
    container: active?.container ?? null,
    queueBlockers: Object.freeze([...(active?.queueBlockers ?? [])]),
    recoveryBlockers: Object.freeze([...(active?.recoveryBlockers ?? [])]),
    lastTerminalError: active?.terminalError ?? input.lastTerminalError ?? null,
    staleLogAgeSeconds: ageSeconds(input.now, staleLogAt),
    runnerLiveness: active?.runner?.liveness ?? 'inactive',
    preflightExpiresAt: active?.preflightExpiresAt ?? null,
    cleanup: active?.cleanup ?? { status: null, generation: 0, handBackPending: false },
  });
}

function jsonObject(value: unknown): JsonObject | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch { return null; }
}

function rowBlocker(row: Readonly<Record<string, unknown>>, codeKey: string, jsonKey: string): HealthBlocker | null {
  return blocker(row[codeKey], jsonObject(row[jsonKey]));
}

export function collectHealthSnapshot(options: CollectHealthOptions): HealthSnapshot {
  const queued = options.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE queue_state = 'queued'").get();
  const active = options.db.prepare(`SELECT
      job_id, current_stage, preflight_expires_at, runner_unit, runner_lease_expires_at,
      terminal_error_code, terminal_error_json, terminal_at,
      container_id, container_name, container_image_digest, container_labels_json,
      cleanup_generation, cleanup_fence_generation, cleanup_admission_id, cleanup_blocker_code, cleanup_blocker_json,
      publish_blocker_code, publish_blocker_json
    FROM jobs
    WHERE (state NOT IN ('queued', 'succeeded', 'failed', 'cancelled', 'interrupted')
      OR (state IN ('succeeded', 'failed', 'cancelled', 'interrupted') AND (
        cleanup_fence_generation IS NOT NULL OR cleanup_admission_id IS NOT NULL OR cleanup_blocker_code IS NOT NULL
      )))
    ORDER BY accepted_at, job_id LIMIT 1`).get();
  const lastEvent = options.db.prepare('SELECT MAX(at) AS at FROM job_events').get();
  const lastTerminal = options.db.prepare(`SELECT terminal_error_code, terminal_error_json, terminal_at
    FROM jobs WHERE terminal_at IS NOT NULL ORDER BY terminal_at DESC LIMIT 1`).get();
  const activeRow = active ?? null;
  const activeJobId = typeof activeRow?.job_id === 'string' ? activeRow.job_id : null;
  let activeJob: HealthActiveJob | null = null;
  if (activeJobId !== null && activeRow !== null) {
    const event = options.db.prepare('SELECT MAX(at) AS at FROM job_events WHERE job_id = ?').get(activeJobId);
    const logEvent = options.db.prepare("SELECT MAX(at) AS at FROM job_events WHERE job_id = ? AND event_type IN ('log', 'log_orphan_tail', 'log-gap', 'log-truncated')").get(activeJobId);
    const lease = typeof activeRow.cleanup_admission_id !== 'string'
      ? undefined
      : options.db.prepare('SELECT status FROM cleanup_leases WHERE admission_id = ?').get(activeRow.cleanup_admission_id);
    const queueBlockers = [rowBlocker(activeRow, 'publish_blocker_code', 'publish_blocker_json')].filter((item): item is HealthBlocker => item !== null);
    const recoveryBlockers = [rowBlocker(activeRow, 'cleanup_blocker_code', 'cleanup_blocker_json')].filter((item): item is HealthBlocker => item !== null);
    const leaseStatus = typeof lease?.status === 'string' ? lease.status : null;
    const terminalError = typeof activeRow.terminal_error_code === 'string' && typeof activeRow.terminal_at === 'string'
      ? { code: activeRow.terminal_error_code, details: jsonObject(activeRow.terminal_error_json), at: activeRow.terminal_at }
      : null;
    activeJob = {
      jobId: activeJobId,
      currentStage: typeof activeRow.current_stage === 'string' ? activeRow.current_stage as PipelineStageName : null,
      lastEventAt: typeof event?.at === 'string' ? event.at : null,
      preflightExpiresAt: typeof activeRow.preflight_expires_at === 'string' ? activeRow.preflight_expires_at : null,
      terminalError,
      queueBlockers,
      recoveryBlockers,
      staleLogAt: typeof logEvent?.at === 'string' ? logEvent.at : null,
      runner: { liveness: options.runnerLiveness ?? (activeRow.runner_unit ? 'unknown' : 'inactive') },
      cleanup: {
        status: leaseStatus,
        generation: Number(activeRow.cleanup_fence_generation ?? activeRow.cleanup_generation ?? 0),
        handBackPending: leaseStatus === 'completed',
      },
      container: {
        id: typeof activeRow.container_id === 'string' ? activeRow.container_id : null,
        name: typeof activeRow.container_name === 'string' ? activeRow.container_name : null,
        imageDigest: typeof activeRow.container_image_digest === 'string' ? activeRow.container_image_digest : null,
        labels: jsonObject(activeRow.container_labels_json),
      },
    };
  }
  const terminalError = lastTerminal && typeof lastTerminal.terminal_error_code === 'string' && typeof lastTerminal.terminal_at === 'string'
    ? { code: lastTerminal.terminal_error_code, details: jsonObject(lastTerminal.terminal_error_json), at: lastTerminal.terminal_at }
    : null;
  return buildHealthSnapshot({
    now: options.now,
    queueDepth: Number(queued?.count ?? 0),
    activeJob,
    globalLastEventAt: typeof lastEvent?.at === 'string' ? lastEvent.at : null,
    diskFreeBytes: options.diskFreeBytes,
    builderImage: options.builderImage,
    lastTerminalError: terminalError,
  });
}
