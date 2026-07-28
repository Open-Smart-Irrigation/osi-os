import { lstat, readdir, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { QueueBlocker } from './queue.js';
import type { StartupPhaseResult, StartupService } from './startup-order.js';

export const RETENTION_DAYS = Object.freeze({ rows: 180, evidence: 180, logs: 180, worktrees: 7, caches: 30, quarantine: 180 });
const MIN_CACHE_FREE_BYTES = 20 * 1024 ** 3;
const TERMINAL_STATES = ['succeeded', 'failed', 'cancelled', 'interrupted'] as const;
const RETENTION_CATEGORIES = ['row', 'evidence', 'log', 'worktree', 'cache', 'quarantine'] as const;

export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];

export interface RetentionPaths {
  readonly stateRoot: string;
  readonly builderOwnedRoots: readonly string[];
  readonly approvedQuarantineRoots: readonly string[];
  readonly approvedReleaseRoots: readonly string[];
  /** Optional test/packaging root. Production defaults to jobs/<id>/workspace/source. */
  readonly worktreeRoot?: string;
}

export interface RetentionPruneRecord {
  readonly category: RetentionCategory;
  readonly relativePath: string;
  readonly action: 'removed' | 'skipped' | 'failed';
  readonly bytes: number;
  readonly timestamp: string;
}

export interface RetentionOptions {
  readonly paths: RetentionPaths;
  readonly db?: DatabaseSync;
  readonly now?: string;
  readonly clock?: Readonly<{ readonly now: () => string }>;
  readonly freeBytes: number | (() => number | Promise<number>);
  readonly recordPrune?: (record: RetentionPruneRecord) => void | Promise<void>;
}

export type RetentionStartupHook = StartupService;

interface Candidate {
  readonly base: string;
  readonly auditBase: string;
  readonly path: string;
  readonly category: RetentionCategory;
  readonly cutoffDays: number;
  readonly stateEligible: boolean;
}

function contained(base: string, child: string): boolean {
  const root = resolve(base);
  const target = resolve(child);
  return target === root || target.startsWith(`${root}${sep}`);
}

function overlaps(left: string, right: string): boolean {
  return contained(left, right) || contained(right, left);
}

function safeSegment(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..'
    && !value.includes('/') && !value.includes('\\') && !value.includes('\0');
}

function relativePath(base: string, target: string): string {
  const value = relative(resolve(base), resolve(target));
  return value.split(sep).join('/');
}

function threshold(now: string, days: number): number {
  const value = Date.parse(now) - days * 24 * 60 * 60 * 1_000;
  if (!Number.isFinite(value)) throw new Error('retention clock is invalid');
  return value;
}

async function directoryChildren(path: string): Promise<readonly string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).map((entry) => join(path, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function protectedLogPaths(db: DatabaseSync | undefined): ReadonlySet<string> {
  if (!db) return new Set();
  const rows = db.prepare(`SELECT DISTINCT generation.job_id AS job_id, generation.path AS path
    FROM job_log_generations AS generation
    JOIN job_events AS event
      ON event.job_id = generation.job_id
     AND event.stream = generation.stream
     AND event.file_generation = generation.generation`).all() as Array<{ job_id?: unknown; path?: unknown }>;
  return new Set(rows.flatMap((row) => typeof row.job_id === 'string' && typeof row.path === 'string' ? [`${row.job_id}:${row.path}`] : []));
}

function validateRootShape(path: string): boolean {
  return typeof path === 'string' && path.startsWith('/') && !path.includes('\0') && !path.split('/').includes('..');
}

async function validateConfiguredRoots(paths: RetentionPaths): Promise<QueueBlocker | null> {
  const all = [paths.stateRoot, ...paths.builderOwnedRoots, ...paths.approvedQuarantineRoots, ...paths.approvedReleaseRoots, ...(paths.worktreeRoot === undefined ? [] : [paths.worktreeRoot])];
  if (all.some((path) => !validateRootShape(path))) return { code: 'RETENTION_ROOT_INVALID', details: { reason: 'non-canonical-root' } };
  for (const path of all) {
    let stats;
    try { stats = await lstat(path); } catch { return { code: 'RETENTION_ROOT_INVALID', details: { reason: 'root-unavailable' } }; }
    if (stats.isSymbolicLink() || !stats.isDirectory()) return { code: 'RETENTION_ROOT_INVALID', details: { reason: 'root-not-directory' } };
  }
  if (paths.builderOwnedRoots.some((root) => !contained(paths.stateRoot, root))) return { code: 'RETENTION_ROOT_INVALID', details: { reason: 'builder-root-outside-state' } };
  for (let left = 0; left < paths.builderOwnedRoots.length; left += 1) {
    for (let right = left + 1; right < paths.builderOwnedRoots.length; right += 1) {
      if (overlaps(paths.builderOwnedRoots[left]!, paths.builderOwnedRoots[right]!)) return { code: 'RETENTION_ROOT_INVALID', details: { reason: 'builder-roots-overlap' } };
    }
  }
  for (let left = 0; left < paths.approvedReleaseRoots.length; left += 1) {
    for (let right = left + 1; right < paths.approvedReleaseRoots.length; right += 1) {
      if (contained(paths.approvedReleaseRoots[left]!, paths.approvedReleaseRoots[right]!) || contained(paths.approvedReleaseRoots[right]!, paths.approvedReleaseRoots[left]!)) {
        return { code: 'RETENTION_ROOT_INVALID', details: { reason: 'approved-release-roots-overlap' } };
      }
    }
  }
  const expectedQuarantines = paths.approvedReleaseRoots.map((release) => resolve(join(release, '.osi-image-builder', 'quarantine')));
  const actualQuarantines = paths.approvedQuarantineRoots.map((root) => resolve(root));
  if (actualQuarantines.length !== expectedQuarantines.length || actualQuarantines.some((root) => !expectedQuarantines.includes(root))) {
    return { code: 'RETENTION_ROOT_INVALID', details: { reason: 'quarantine-is-not-canonical' } };
  }
  for (let left = 0; left < actualQuarantines.length; left += 1) {
    for (let right = left + 1; right < actualQuarantines.length; right += 1) {
      if (overlaps(actualQuarantines[left]!, actualQuarantines[right]!)) return { code: 'RETENTION_ROOT_INVALID', details: { reason: 'quarantine-roots-overlap' } };
    }
  }
  if (paths.worktreeRoot !== undefined && (!validateRootShape(paths.worktreeRoot) || !contained(paths.stateRoot, paths.worktreeRoot))) {
    return { code: 'RETENTION_ROOT_INVALID', details: { reason: 'worktree-root-outside-state' } };
  }
  return null;
}

async function addChildren(
  result: Candidate[],
  paths: RetentionPaths,
  base: string,
  auditBase: string,
  category: RetentionCategory,
  days: number,
  protectedLogs: ReadonlySet<string>,
): Promise<void> {
  if (!contained(paths.stateRoot, base) && !paths.approvedQuarantineRoots.some((root) => contained(root, base))) throw new Error('retention scan root is unauthorized');
  for (const path of await directoryChildren(base)) {
    if (category === 'log' && protectedLogs.has(relativePath(base, path))) continue;
    result.push({ base, auditBase, path, category, cutoffDays: days, stateEligible: false });
  }
}

async function terminalWorktreeCandidates(options: RetentionOptions, now: string, result: Candidate[]): Promise<void> {
  if (!options.db) return;
  const rows = options.db.prepare(`SELECT job_id FROM jobs
    WHERE state IN ('succeeded', 'failed', 'cancelled', 'interrupted')
      AND terminal_at IS NOT NULL AND terminal_at < ? ORDER BY job_id`).all(new Date(threshold(now, RETENTION_DAYS.worktrees)).toISOString()) as Array<{ job_id?: unknown }>;
  for (const row of rows) {
    if (!safeSegment(row.job_id)) continue;
    const path = options.paths.worktreeRoot === undefined
      ? join(options.paths.stateRoot, 'jobs', row.job_id, 'workspace', 'source')
      : join(options.paths.worktreeRoot, row.job_id);
    if (!contained(options.paths.stateRoot, path)) continue;
    result.push({ base: options.paths.stateRoot, auditBase: options.paths.stateRoot, path, category: 'worktree', cutoffDays: 0, stateEligible: true });
  }
}

async function databaseCandidates(options: RetentionOptions, now: string, result: Candidate[]): Promise<void> {
  if (!options.db) return;
  await terminalWorktreeCandidates(options, now, result);
  const expiredRows = options.db.prepare(`SELECT job_id FROM jobs
    WHERE state IN ('succeeded', 'failed', 'cancelled', 'interrupted')
      AND terminal_at IS NOT NULL AND terminal_at < ?
      AND cleanup_fence_generation IS NULL AND cleanup_admission_id IS NULL AND cleanup_blocker_code IS NULL
      AND container_id IS NULL AND container_name IS NULL
      AND artifact_staging_path IS NULL AND artifact_quarantine_path IS NULL AND artifact_quarantine_intent_path IS NULL
      AND publish_blocker_code IS NULL ORDER BY job_id`).all(new Date(threshold(now, RETENTION_DAYS.rows)).toISOString()) as Array<{ job_id?: unknown }>;
  for (const row of expiredRows) {
    if (!safeSegment(row.job_id)) continue;
    const jobRoot = join(options.paths.stateRoot, 'jobs', row.job_id);
    for (const path of await directoryChildren(join(jobRoot, 'evidence'))) {
      result.push({ base: options.paths.stateRoot, auditBase: options.paths.stateRoot, path, category: 'evidence', cutoffDays: 0, stateEligible: true });
    }
  }
  const logRows = options.db.prepare(`SELECT job_id, stream, generation, path, started_at FROM job_log_generations
    WHERE started_at < ? ORDER BY job_id, stream, generation`).all(new Date(threshold(now, RETENTION_DAYS.logs)).toISOString()) as Array<{ job_id?: unknown; stream?: unknown; generation?: unknown; path?: unknown }>;
  const protectedLogs = protectedLogPaths(options.db);
  for (const row of logRows) {
    if (!safeSegment(row.job_id) || (row.stream !== 'runner' && row.stream !== 'docker') || !Number.isSafeInteger(Number(row.generation)) || typeof row.path !== 'string' || !row.path.startsWith('logs/') || row.path.split('/').some((part) => !safeSegment(part))) continue;
    if (protectedLogs.has(`${row.job_id}:${row.path}`)) continue;
    const path = join(options.paths.stateRoot, 'jobs', row.job_id, row.path);
    if (contained(options.paths.stateRoot, path)) result.push({ base: options.paths.stateRoot, auditBase: options.paths.stateRoot, path, category: 'log', cutoffDays: 0, stateEligible: true });
  }
}

async function recordAudit(options: RetentionOptions, record: RetentionPruneRecord): Promise<void> {
  if (options.db) {
    options.db.exec('BEGIN IMMEDIATE');
    try {
      options.db.prepare('INSERT INTO retention_prunes (category, relative_path, action, bytes, at) VALUES (?, ?, ?, ?, ?)').run(record.category, record.relativePath, record.action, record.bytes, record.timestamp);
      options.db.exec('COMMIT');
    } catch (error) {
      try { options.db.exec('ROLLBACK'); } catch { /* preserve audit failure */ }
      throw error;
    }
  }
  await options.recordPrune?.(record);
}

async function pruneCandidate(options: RetentionOptions, candidate: Candidate, now: string): Promise<void> {
  if (!contained(candidate.base, candidate.path) || !contained(candidate.auditBase, candidate.path)) throw new Error('retention candidate escaped an authorized root');
  let stats;
  try { stats = await lstat(candidate.path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    await recordAudit(options, { category: candidate.category, relativePath: relativePath(candidate.auditBase, candidate.path), action: 'skipped', bytes: 0, timestamp: now });
    return;
  }
  if (!candidate.stateEligible && stats.mtimeMs >= threshold(now, candidate.cutoffDays)) return;
  const record: RetentionPruneRecord = { category: candidate.category, relativePath: relativePath(candidate.auditBase, candidate.path), action: 'removed', bytes: stats.isFile() ? stats.size : 0, timestamp: now };
  if (options.db) options.db.exec('BEGIN IMMEDIATE');
  try {
    await rm(candidate.path, { recursive: true, force: false });
    if (options.db) {
      options.db.prepare('INSERT INTO retention_prunes (category, relative_path, action, bytes, at) VALUES (?, ?, ?, ?, ?)').run(record.category, record.relativePath, record.action, record.bytes, record.timestamp);
      options.db.exec('COMMIT');
    }
  } catch (error) {
    if (options.db) { try { options.db.exec('ROLLBACK'); } catch { /* preserve prune failure */ } }
    throw error;
  }
  await options.recordPrune?.(record);
}

async function pruneTerminalRows(options: RetentionOptions, now: string): Promise<readonly QueueBlocker[]> {
  if (!options.db) return [];
  const blockers: QueueBlocker[] = [];
  const rows = options.db.prepare(`SELECT job_id FROM jobs
    WHERE state IN ('succeeded', 'failed', 'cancelled', 'interrupted')
      AND terminal_at IS NOT NULL AND terminal_at < ?
      AND cleanup_fence_generation IS NULL AND cleanup_admission_id IS NULL AND cleanup_blocker_code IS NULL
      AND container_id IS NULL AND container_name IS NULL
      AND artifact_staging_path IS NULL AND artifact_quarantine_path IS NULL AND artifact_quarantine_intent_path IS NULL
      AND publish_blocker_code IS NULL
      ORDER BY job_id`).all(new Date(threshold(now, RETENTION_DAYS.rows)).toISOString()) as Array<{ job_id?: unknown }>;
  for (const row of rows) {
    if (!safeSegment(row.job_id)) continue;
    const jobId = row.job_id;
    const record: RetentionPruneRecord = { category: 'row', relativePath: `jobs/${jobId}`, action: 'removed', bytes: 0, timestamp: now };
    options.db.exec('BEGIN IMMEDIATE');
    try {
      options.db.prepare('INSERT INTO retention_purge_authorizations (job_id, authorized_at) VALUES (?, ?)').run(jobId, now);
      options.db.prepare('DELETE FROM queue_dispatch_claims WHERE job_id=?').run(jobId);
      options.db.prepare('DELETE FROM cleanup_stop_authorization_outcomes WHERE job_id=?').run(jobId);
      options.db.prepare('DELETE FROM cleanup_stop_authorization_heads WHERE job_id=?').run(jobId);
      options.db.prepare('DELETE FROM cleanup_stop_authorizations WHERE job_id=?').run(jobId);
      options.db.prepare('DELETE FROM cleanup_credential_reservations WHERE job_id=?').run(jobId);
      options.db.prepare('DELETE FROM cleanup_leases WHERE job_id=?').run(jobId);
      options.db.prepare('DELETE FROM legacy_blocked_publish_evidence WHERE job_id=?').run(jobId);
      options.db.prepare('DELETE FROM job_events WHERE job_id=?').run(jobId);
      options.db.prepare('DELETE FROM job_log_generations WHERE job_id=?').run(jobId);
      options.db.prepare('DELETE FROM job_stages WHERE job_id=?').run(jobId);
      options.db.prepare('DELETE FROM job_operations WHERE job_id=?').run(jobId);
      options.db.prepare('DELETE FROM queue_entries WHERE job_id=?').run(jobId);
      options.db.prepare('DELETE FROM retention_purge_authorizations WHERE job_id=?').run(jobId);
      const deleted = options.db.prepare('DELETE FROM jobs WHERE job_id=? AND state IN (?, ?, ?, ?) AND terminal_at < ?').run(jobId, ...TERMINAL_STATES, new Date(threshold(now, RETENTION_DAYS.rows)).toISOString());
      if (deleted.changes !== 1) throw new Error('terminal job row was not deleted');
      options.db.prepare('INSERT INTO retention_prunes (category, relative_path, action, bytes, at) VALUES (?, ?, ?, ?, ?)').run(record.category, record.relativePath, record.action, record.bytes, record.timestamp);
      options.db.exec('COMMIT');
    } catch (error) {
      try { options.db.exec('ROLLBACK'); } catch { /* preserve row prune failure */ }
      const details = { category: 'row', relativePath: record.relativePath, reason: error instanceof Error ? error.message : String(error) };
      try { await recordAudit(options, { ...record, action: 'failed' }); } catch { /* blocker remains the durable signal */ }
      blockers.push({ code: 'RETENTION_ROW_PRUNE_FAILED', details });
      continue;
    }
    await options.recordPrune?.(record);
    try { await rm(join(options.paths.stateRoot, 'jobs', jobId), { recursive: false, force: false }); } catch { /* unrelated leftover state remains explicitly retained */ }
  }
  return blockers;
}

export function createRetentionStartupHook(options: RetentionOptions): RetentionStartupHook {
  return async (): Promise<StartupPhaseResult> => {
    const now = options.now ?? options.clock?.now();
    if (!now) throw new Error('retention requires a clock');
    const invalid = await validateConfiguredRoots(options.paths);
    if (invalid) return { blockers: [invalid] };
    const freeBytes = typeof options.freeBytes === 'function' ? await options.freeBytes() : options.freeBytes;
    const candidates: Candidate[] = [];
    const cacheCandidates: Candidate[] = [];
    for (const root of options.paths.builderOwnedRoots) {
      for (const cache of await directoryChildren(join(root, 'cache'))) {
        for (const path of await directoryChildren(cache)) {
          cacheCandidates.push({ base: options.paths.stateRoot, auditBase: options.paths.stateRoot, path, category: 'cache', cutoffDays: RETENTION_DAYS.caches, stateEligible: false });
        }
      }
    }
    for (const root of options.paths.approvedQuarantineRoots) {
      const auditBase = options.paths.approvedReleaseRoots.find((release) => contained(release, root)) ?? root;
      await addChildren(candidates, options.paths, root, auditBase, 'quarantine', RETENTION_DAYS.quarantine, new Set());
    }
    await databaseCandidates(options, now, candidates);
    const blockers: QueueBlocker[] = [];
    const uniqueCandidates = [...new Map(candidates.map((candidate) => [`${candidate.category}:${resolve(candidate.path)}`, candidate])).values()];
    for (const candidate of uniqueCandidates) {
      try { await pruneCandidate(options, candidate, now); }
      catch (error) {
        const details = { category: candidate.category, relativePath: relativePath(candidate.auditBase, candidate.path), reason: error instanceof Error ? error.message : String(error) };
        try { await recordAudit(options, { category: candidate.category, relativePath: details.relativePath, action: 'failed', bytes: 0, timestamp: now }); }
        catch { /* the blocker below is the durable signal when audit storage also fails */ }
        blockers.push({ code: 'RETENTION_PRUNE_FAILED', details });
      }
    }
    const uniqueCaches = [...new Map(cacheCandidates.map((candidate) => [resolve(candidate.path), candidate])).values()];
    const cacheStats = await Promise.all(uniqueCaches.map(async (candidate) => {
      try { return { candidate, mtimeMs: (await lstat(candidate.path)).mtimeMs }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    }));
    const orderedCaches = cacheStats
      .filter((value): value is { candidate: Candidate; mtimeMs: number } => value !== null)
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
    let currentFreeBytes = freeBytes;
    const dynamicFreeBytes = typeof options.freeBytes === 'function';
    const belowFloor = currentFreeBytes < MIN_CACHE_FREE_BYTES;
    for (const { candidate } of orderedCaches) {
      if (belowFloor && dynamicFreeBytes) {
        currentFreeBytes = await options.freeBytes();
        if (currentFreeBytes >= MIN_CACHE_FREE_BYTES) break;
      }
      let stats;
      try { stats = await lstat(candidate.path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (!belowFloor && stats.mtimeMs >= threshold(now, RETENTION_DAYS.caches)) continue;
      try { await pruneCandidate(options, { ...candidate, stateEligible: belowFloor }, now); }
      catch (error) {
        const details = { category: candidate.category, relativePath: relativePath(candidate.auditBase, candidate.path), reason: error instanceof Error ? error.message : String(error) };
        try { await recordAudit(options, { category: 'cache', relativePath: details.relativePath, action: 'failed', bytes: 0, timestamp: now }); } catch { /* blocker remains the durable signal */ }
        blockers.push({ code: 'RETENTION_PRUNE_FAILED', details });
      }
    }
    blockers.push(...await pruneTerminalRows(options, now));
    if (options.db) {
      options.db.prepare('DELETE FROM retention_prunes WHERE at < ?').run(new Date(threshold(now, RETENTION_DAYS.rows)).toISOString());
    }
    return { blockers };
  };
}

export const createRetentionHook = createRetentionStartupHook;
