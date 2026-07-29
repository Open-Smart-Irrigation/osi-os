import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { lstat, open, readdir, rmdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { QueueBlocker } from './queue.js';
import type { StartupPhaseResult, StartupService } from './startup-order.js';

export const RETENTION_DAYS = Object.freeze({ rows: 180, evidence: 180, logs: 180, worktrees: 7, caches: 30, quarantine: 180 });
const MIN_CACHE_FREE_BYTES = 20 * 1024 ** 3;
const RETENTION_CATEGORIES = ['row', 'evidence', 'log', 'worktree', 'cache', 'quarantine'] as const;
const PRE_V15_QUARANTINE_INTENT_REASON = 'pre-v15-quarantine-intent-missing-target-identity';
const ELIGIBLE_TERMINAL_ROW_SQL = `state IN ('succeeded', 'failed', 'cancelled', 'interrupted')
  AND terminal_at IS NOT NULL AND terminal_at < ?
  AND cleanup_fence_generation IS NULL AND cleanup_admission_id IS NULL AND cleanup_blocker_code IS NULL
  AND container_id IS NULL AND container_name IS NULL
  AND artifact_staging_path IS NULL AND artifact_quarantine_intent_path IS NULL
  AND publish_blocker_code IS NULL`;

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
  readonly beforeDelete?: (candidate: { readonly category: RetentionCategory; readonly path: string }) => void | Promise<void>;
  readonly beforeRowPurge?: (candidate: { readonly jobId: string; readonly path: string }) => void | Promise<void>;
}

export type RetentionStartupHook = StartupService;

interface Candidate {
  readonly base: string;
  readonly auditBase: string;
  readonly path: string;
  readonly category: RetentionCategory;
  readonly cutoffDays: number;
  readonly stateEligible: boolean;
  readonly durable: boolean;
  readonly replayIdentity?: Readonly<{ readonly dev: number; readonly ino: number }>;
}

interface OpenRoot {
  readonly path: string;
  readonly handle: FileHandle;
}

interface EntryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

const OPEN_DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const OPEN_OWNED_DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY;
const OPEN_ENTRY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

function procPath(handle: FileHandle, name?: string): string {
  return procFdPath(handle.fd, name);
}

function procFdPath(fd: number, name?: string): string {
  return `/proc/self/fd/${fd}${name === undefined ? '' : `/${name}`}`;
}

function identity(stats: { dev: number; ino: number; mode: number; isDirectory: () => boolean; isSymbolicLink: () => boolean }): EntryIdentity {
  return { dev: stats.dev, ino: stats.ino, mode: stats.mode, isDirectory: stats.isDirectory(), isSymbolicLink: stats.isSymbolicLink() };
}

function sameIdentity(left: EntryIdentity, right: EntryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.isDirectory === right.isDirectory && left.isSymbolicLink === right.isSymbolicLink;
}

async function openAbsoluteDirectory(path: string): Promise<FileHandle> {
  const segments = resolve(path).split('/').filter(Boolean);
  let current = await open('/', OPEN_DIRECTORY_FLAGS);
  try {
    for (const segment of segments) {
      const next = await open(procPath(current, segment), OPEN_DIRECTORY_FLAGS);
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

async function openRelativeDirectory(root: FileHandle, segments: readonly string[]): Promise<FileHandle> {
  if (segments.length === 0) return open(procPath(root), OPEN_OWNED_DIRECTORY_FLAGS);
  let current = root;
  const owned: FileHandle[] = [];
  try {
    for (const segment of segments) {
      const next = await open(procPath(current, segment), OPEN_DIRECTORY_FLAGS);
      if (current !== root) owned.push(current);
      current = next;
    }
    for (const handle of owned) await handle.close();
    return current;
  } catch (error) {
    for (const handle of owned) await handle.close().catch(() => undefined);
    if (current !== root) await current.close().catch(() => undefined);
    throw error;
  }
}

async function directoryChildren(parent: FileHandle, path: string): Promise<readonly string[]> {
  return (await readdir(procPath(parent), { withFileTypes: true })).map((entry) => join(path, entry.name));
}

async function openEntry(parent: FileHandle, name: string): Promise<FileHandle> {
  return open(procPath(parent, name), OPEN_ENTRY_FLAGS);
}

async function removeEntry(parent: FileHandle, name: string): Promise<void> {
  if ((await lstat(procPath(parent, name))).isSymbolicLink()) {
    await unlink(procPath(parent, name));
    return;
  }
  const held = await openEntry(parent, name);
  try {
    const initial = identity(await held.stat());
    if (initial.isSymbolicLink) return;
    if (initial.isDirectory) {
      for (const child of await readdir(procPath(held), { withFileTypes: true })) await removeEntry(held, child.name);
    }
    const current = await openEntry(parent, name);
    try {
      if (!sameIdentity(initial, identity(await current.stat()))) throw new Error('retention target changed during prune');
    } finally {
      await current.close();
    }
    if (initial.isDirectory) await rmdir(procPath(parent, name));
    else await unlink(procPath(parent, name));
  } finally {
    await held.close();
  }
}

function removeEntrySync(parentFd: number, name: string): void {
  const path = procFdPath(parentFd, name);
  if (lstatSync(path).isSymbolicLink()) {
    unlinkSync(path);
    return;
  }
  const heldFd = openSync(path, OPEN_ENTRY_FLAGS);
  try {
    const initial = identity(fstatSync(heldFd));
    if (initial.isSymbolicLink) return;
    if (initial.isDirectory) {
      for (const child of readdirSync(procFdPath(heldFd), { withFileTypes: true })) {
        removeEntrySync(heldFd, child.name);
      }
    }
    const currentFd = openSync(path, OPEN_ENTRY_FLAGS);
    try {
      if (!sameIdentity(initial, identity(fstatSync(currentFd)))) throw new Error('retention target changed during prune');
    } finally {
      closeSync(currentFd);
    }
    if (initial.isDirectory) rmdirSync(path);
    else unlinkSync(path);
  } finally {
    closeSync(heldFd);
  }
}

async function openConfiguredRoots(paths: RetentionPaths): Promise<Map<string, OpenRoot>> {
  const roots = new Map<string, OpenRoot>();
  const all = [paths.stateRoot, ...paths.builderOwnedRoots, ...paths.approvedQuarantineRoots, ...paths.approvedReleaseRoots, ...(paths.worktreeRoot === undefined ? [] : [paths.worktreeRoot])];
  try {
    for (const path of all) {
      const normalized = resolve(path);
      if (!roots.has(normalized)) roots.set(normalized, { path: normalized, handle: await openAbsoluteDirectory(normalized) });
    }
    return roots;
  } catch (error) {
    await closeConfiguredRoots(roots);
    throw error;
  }
}

async function closeConfiguredRoots(roots: Map<string, OpenRoot>): Promise<void> {
  for (const root of roots.values()) await root.handle.close().catch(() => undefined);
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

function isCanonicalQuarantinePath(jobId: string, path: unknown): path is string {
  return path === `quarantine/${jobId}` || path === `.osi-image-builder/quarantine/${jobId}`;
}

function assertCanonicalQuarantinePath(jobId: string, path: unknown): void {
  if (path !== null && !isCanonicalQuarantinePath(jobId, path)) throw new Error('persisted quarantine path is not canonical');
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
  if (paths.builderOwnedRoots.some((root) => !contained(paths.stateRoot, root))) return { code: 'RETENTION_ROOT_INVALID', details: { reason: 'builder-root-outside-state' } };
  if (paths.approvedReleaseRoots.some((root) => overlaps(paths.stateRoot, root))) return { code: 'RETENTION_ROOT_INVALID', details: { reason: 'approved-release-root-overlaps-state' } };
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

async function terminalWorktreeCandidates(options: RetentionOptions, roots: Map<string, OpenRoot>, now: string, result: Candidate[]): Promise<void> {
  if (!options.db) return;
  const rows = options.db.prepare(`SELECT job_id FROM jobs WHERE ${ELIGIBLE_TERMINAL_ROW_SQL} ORDER BY job_id`)
    .all(new Date(threshold(now, RETENTION_DAYS.worktrees)).toISOString()) as Array<{ job_id?: unknown }>;
  for (const row of rows) {
    if (!safeSegment(row.job_id)) continue;
    const path = options.paths.worktreeRoot === undefined
      ? join(options.paths.stateRoot, 'jobs', row.job_id, 'workspace', 'source')
      : join(options.paths.worktreeRoot, row.job_id);
    if (!contained(options.paths.stateRoot, path)) continue;
    const stateRoot = roots.get(resolve(options.paths.stateRoot));
    if (!stateRoot) throw new Error('retention state root is not held');
    const parts = relative(resolve(options.paths.stateRoot), resolve(path)).split(sep).filter(Boolean);
    let parent: FileHandle;
    try { parent = await openRelativeDirectory(stateRoot.handle, parts.slice(0, -1)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    try {
      try { await lstat(procPath(parent, parts[parts.length - 1]!)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    } finally { await parent.close(); }
    result.push({ base: options.paths.stateRoot, auditBase: options.paths.stateRoot, path, category: 'worktree', cutoffDays: 0, stateEligible: true, durable: true });
  }
}

async function databaseCandidates(options: RetentionOptions, roots: Map<string, OpenRoot>, now: string, result: Candidate[]): Promise<void> {
  if (!options.db) return;
  await terminalWorktreeCandidates(options, roots, now, result);
  const cutoff = new Date(threshold(now, RETENTION_DAYS.rows)).toISOString();
  const expiredRows = options.db.prepare(`SELECT job_id, artifact_quarantine_path FROM jobs WHERE ${ELIGIBLE_TERMINAL_ROW_SQL} ORDER BY job_id`).all(cutoff) as Array<{ job_id?: unknown; artifact_quarantine_path?: unknown }>;
  const rowCandidates: Candidate[] = [];
  for (const row of expiredRows) {
    if (!safeSegment(row.job_id)) continue;
    if (row.artifact_quarantine_path !== null && !isCanonicalQuarantinePath(row.job_id, row.artifact_quarantine_path)) continue;
    const jobRoot = join(options.paths.stateRoot, 'jobs', row.job_id);
    rowCandidates.push({ base: options.paths.stateRoot, auditBase: options.paths.stateRoot, path: jobRoot, category: 'row', cutoffDays: 0, stateEligible: true, durable: true });
    const stateRoot = roots.get(resolve(options.paths.stateRoot));
    if (!stateRoot) throw new Error('retention state root is not held');
    let evidenceRoot: FileHandle;
    try { evidenceRoot = await openRelativeDirectory(stateRoot.handle, ['jobs', row.job_id, 'evidence']); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    try {
      for (const path of await directoryChildren(evidenceRoot, join(jobRoot, 'evidence'))) {
        result.push({ base: options.paths.stateRoot, auditBase: options.paths.stateRoot, path, category: 'evidence', cutoffDays: 0, stateEligible: true, durable: true });
      }
    } finally { await evidenceRoot.close(); }
  }
  const logRows = options.db.prepare(`SELECT generation.job_id AS job_id, generation.stream AS stream, generation.generation AS generation, generation.path AS path, generation.started_at AS started_at
    FROM job_log_generations AS generation JOIN jobs AS job ON job.job_id = generation.job_id
    WHERE job.state IN ('succeeded', 'failed', 'cancelled', 'interrupted') AND job.terminal_at IS NOT NULL
      AND generation.started_at < ? ORDER BY generation.job_id, generation.stream, generation.generation`).all(new Date(threshold(now, RETENTION_DAYS.logs)).toISOString()) as Array<{ job_id?: unknown; stream?: unknown; generation?: unknown; path?: unknown }>;
  const protectedLogs = protectedLogPaths(options.db);
  for (const row of logRows) {
    if (!safeSegment(row.job_id) || (row.stream !== 'runner' && row.stream !== 'docker') || !Number.isSafeInteger(Number(row.generation)) || typeof row.path !== 'string' || !row.path.startsWith('logs/') || row.path.split('/').some((part) => !safeSegment(part))) continue;
    if (protectedLogs.has(`${row.job_id}:${row.path}`)) continue;
    const path = join(options.paths.stateRoot, 'jobs', row.job_id, row.path);
    if (contained(options.paths.stateRoot, path)) result.push({ base: options.paths.stateRoot, auditBase: options.paths.stateRoot, path, category: 'log', cutoffDays: 0, stateEligible: true, durable: true });
  }
  result.push(...rowCandidates);
}

function quarantineCandidate(
  options: RetentionOptions,
  root: string,
  auditBase: string,
  path: string,
  now: string,
): Candidate | null {
  if (!options.db) return null;
  const jobId = relativePath(root, path);
  if (!safeSegment(jobId)) return null;
  const cutoff = new Date(threshold(now, RETENTION_DAYS.quarantine)).toISOString();
  const ownership = options.db.prepare(`SELECT
      EXISTS (SELECT 1 FROM jobs WHERE job_id=?) AS known,
      EXISTS (SELECT 1 FROM jobs WHERE job_id=? AND ${ELIGIBLE_TERMINAL_ROW_SQL}
        AND artifact_quarantine_path IN (?, ?)) AS eligible`)
    .get(jobId, jobId, cutoff, `quarantine/${jobId}`, `.osi-image-builder/quarantine/${jobId}`) as { known?: unknown; eligible?: unknown };
  if (Number(ownership.known) === 1 && Number(ownership.eligible) !== 1) return null;
  return { base: root, auditBase, path, category: 'quarantine', cutoffDays: RETENTION_DAYS.quarantine, stateEligible: false, durable: true };
}

async function quarantineCandidates(options: RetentionOptions, roots: Map<string, OpenRoot>, now: string, result: Candidate[]): Promise<void> {
  for (const root of options.paths.approvedQuarantineRoots) {
    const auditBase = options.paths.approvedReleaseRoots.find((release) => contained(release, root)) ?? root;
    const held = roots.get(resolve(root));
    if (!held) throw new Error('retention quarantine root is not held');
    for (const path of await directoryChildren(held.handle, root)) {
      const candidate = quarantineCandidate(options, root, auditBase, path, now);
      if (candidate) result.push(candidate);
    }
  }
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  }
  catch (error) { try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ } throw error; }
}

function planIntent(options: RetentionOptionsWithRoots, candidate: Candidate, now: string, bytes: number, target?: EntryIdentity): void {
  if (!options.db || !candidate.durable) return;
  const path = relativePath(candidate.auditBase, candidate.path);
  transaction(options.db, () => {
    options.db!.prepare(`INSERT INTO retention_prune_intents
        (category, relative_path, status, planned_at, updated_at, bytes, error, target_dev, target_ino)
      VALUES (?, ?, 'planned', ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(category, relative_path) DO UPDATE SET status='planned', planned_at=excluded.planned_at,
        updated_at=excluded.updated_at, bytes=excluded.bytes, error=NULL,
        target_dev=excluded.target_dev, target_ino=excluded.target_ino`)
      .run(candidate.category, path, now, now, bytes, target?.dev ?? null, target?.ino ?? null);
  });
}

function cancelPlannedIntent(options: RetentionOptions, candidate: Candidate): void {
  if (!options.db || !candidate.durable) return;
  options.db.prepare(`DELETE FROM retention_prune_intents WHERE category=? AND relative_path=? AND status='planned'`)
    .run(candidate.category, relativePath(candidate.auditBase, candidate.path));
}

function finalizeIntentInTransaction(options: RetentionOptions, candidate: Candidate, record: RetentionPruneRecord, error?: string): boolean {
  let shouldRecord = true;
  if (options.db) {
    if (candidate.durable) {
      const changed = options.db.prepare(`UPDATE retention_prune_intents SET status=?, updated_at=?, bytes=?, error=?
        WHERE category=? AND relative_path=? AND status IN ('planned', 'failed')`).run(record.action, record.timestamp, record.bytes, error ?? null, record.category, record.relativePath);
      shouldRecord = changed.changes === 1;
    }
    if (shouldRecord) options.db.prepare('INSERT INTO retention_prunes (category, relative_path, action, bytes, at) VALUES (?, ?, ?, ?, ?)').run(record.category, record.relativePath, record.action, record.bytes, record.timestamp);
  }
  return shouldRecord;
}

async function finalizeIntent(options: RetentionOptions, candidate: Candidate, record: RetentionPruneRecord, error?: string): Promise<void> {
  const shouldRecord = options.db
    ? transaction(options.db, () => finalizeIntentInTransaction(options, candidate, record, error))
    : finalizeIntentInTransaction(options, candidate, record, error);
  if (shouldRecord) await options.recordPrune?.(record);
}

type RetentionOptionsWithRoots = RetentionOptions & { readonly __retentionRoots: Map<string, OpenRoot> };

function finalizeQuarantinePrune(
  options: RetentionOptionsWithRoots,
  candidate: Candidate,
  now: string,
  parent: FileHandle,
  name: string,
  held: FileHandle,
  initial: EntryIdentity,
  record: RetentionPruneRecord,
): RetentionPruneRecord | undefined {
  if (!options.db) throw new Error('quarantine retention requires database authority');
  return transaction(options.db, () => {
    const heldStats = fstatSync(held.fd);
    const heldIdentity = identity(heldStats);
    if (!sameIdentity(initial, heldIdentity)) throw new Error('retention target changed during prune');

    const path = procPath(parent, name);
    let currentFd: number | undefined;
    try {
      if (lstatSync(path).isSymbolicLink()) {
        return finalizeIntentInTransaction(options, candidate, { ...record, action: 'skipped', bytes: 0 }) ? { ...record, action: 'skipped', bytes: 0 } : undefined;
      }
      currentFd = openSync(path, OPEN_ENTRY_FLAGS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return finalizeIntentInTransaction(options, candidate, { ...record, bytes: 0 }) ? { ...record, bytes: 0 } : undefined;
      }
      throw error;
    }
    try {
      if (!sameIdentity(initial, identity(fstatSync(currentFd)))) {
        const skipped = { ...record, action: 'skipped' as const, bytes: 0 };
        return finalizeIntentInTransaction(options, candidate, skipped) ? skipped : undefined;
      }
    } finally {
      closeSync(currentFd);
    }

    if (!candidate.stateEligible && heldStats.mtimeMs >= threshold(now, candidate.cutoffDays)) {
      cancelPlannedIntent(options, candidate);
      return undefined;
    }
    if (!quarantineCandidate(options, candidate.base, candidate.auditBase, candidate.path, now)) {
      cancelPlannedIntent(options, candidate);
      return undefined;
    }

    if (initial.isDirectory) {
      for (const child of readdirSync(procPath(held), { withFileTypes: true })) removeEntrySync(held.fd, child.name);
    }
    const finalFd = openSync(path, OPEN_ENTRY_FLAGS);
    try {
      if (!sameIdentity(initial, identity(fstatSync(finalFd)))) throw new Error('retention target changed during prune');
    } finally {
      closeSync(finalFd);
    }
    if (initial.isDirectory) rmdirSync(path);
    else unlinkSync(path);
    return finalizeIntentInTransaction(options, candidate, record) ? record : undefined;
  });
}

async function pruneCandidate(options: RetentionOptionsWithRoots, candidate: Candidate, now: string): Promise<void> {
  if (!contained(candidate.base, candidate.path) || !contained(candidate.auditBase, candidate.path)) throw new Error('retention candidate escaped an authorized root');
  const root = options.__retentionRoots.get(resolve(candidate.base));
  if (!root) throw new Error('retention candidate root is not held');
  const parts = relative(resolve(candidate.base), resolve(candidate.path)).split(sep).filter(Boolean);
  if (parts.length === 0 || parts.some((part) => !safeSegment(part))) throw new Error('retention candidate path is invalid');
  let parent: FileHandle;
  try { parent = await openRelativeDirectory(root.handle, parts.slice(0, -1)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && candidate.durable) {
      if (!candidate.replayIdentity) planIntent(options, candidate, now, 0);
      await finalizeIntent(options, candidate, { category: candidate.category, relativePath: relativePath(candidate.auditBase, candidate.path), action: 'removed', bytes: 0, timestamp: now });
      return;
    }
    throw error;
  }
  const name = parts[parts.length - 1]!;
  let held: FileHandle | undefined;
  let initial: EntryIdentity | undefined;
  try {
    const linkStats = await lstat(procPath(parent, name));
    if (linkStats.isSymbolicLink()) {
      if (candidate.category === 'row') throw new Error('retention row root is symbolic link');
      if (!candidate.replayIdentity) planIntent(options, candidate, now, 0);
      await finalizeIntent(options, candidate, { category: candidate.category, relativePath: relativePath(candidate.auditBase, candidate.path), action: 'skipped', bytes: 0, timestamp: now });
      return;
    }
    held = await openEntry(parent, name);
    initial = identity(await held.stat());
    if (initial.isSymbolicLink) return;
    if (candidate.replayIdentity
      && (initial.dev !== candidate.replayIdentity.dev || initial.ino !== candidate.replayIdentity.ino)) {
      await finalizeIntent(options, candidate, {
        category: candidate.category,
        relativePath: relativePath(candidate.auditBase, candidate.path),
        action: 'skipped',
        bytes: 0,
        timestamp: now,
      });
      return;
    }
    if (!candidate.stateEligible && linkStats.mtimeMs >= threshold(now, candidate.cutoffDays)) return;
    const record: RetentionPruneRecord = { category: candidate.category, relativePath: relativePath(candidate.auditBase, candidate.path), action: 'removed', bytes: initial.isDirectory ? 0 : linkStats.size, timestamp: now };
    if (!candidate.replayIdentity) planIntent(options, candidate, now, record.bytes, initial);
    await options.beforeDelete?.({ category: candidate.category, path: candidate.path });
    if (candidate.category === 'quarantine') {
      const finalized = finalizeQuarantinePrune(options, candidate, now, parent, name, held, initial, record);
      if (finalized) await options.recordPrune?.(finalized);
      return;
    }
    const currentHeldStats = await held.stat();
    if (!candidate.stateEligible && currentHeldStats.mtimeMs >= threshold(now, candidate.cutoffDays)) {
      cancelPlannedIntent(options, candidate);
      return;
    }
    if (initial.isDirectory) {
      for (const child of await readdir(procPath(held), { withFileTypes: true })) await removeEntry(held, child.name);
    }
    const current = await openEntry(parent, name);
    try {
      if (!sameIdentity(initial, identity(await current.stat()))) throw new Error('retention target changed during prune');
    } finally { await current.close(); }
    if (initial.isDirectory) await rmdir(procPath(parent, name));
    else await unlink(procPath(parent, name));
    await finalizeIntent(options, candidate, record);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && candidate.durable) {
      let rootAbsent = false;
      try { lstatSync(procPath(parent, name)); }
      catch (rootError) {
        if ((rootError as NodeJS.ErrnoException).code === 'ENOENT') rootAbsent = true;
        else throw rootError;
      }
      if (!rootAbsent) throw error;
      if (!candidate.replayIdentity && !initial) planIntent(options, candidate, now, 0);
      await finalizeIntent(options, candidate, { category: candidate.category, relativePath: relativePath(candidate.auditBase, candidate.path), action: 'removed', bytes: 0, timestamp: now });
      return;
    }
    throw error;
  } finally {
    await held?.close().catch(() => undefined);
    await parent.close().catch(() => undefined);
  }
}

async function pathAbsentThroughRoot(options: RetentionOptionsWithRoots, base: string, path: string): Promise<boolean> {
  const root = options.__retentionRoots.get(resolve(base));
  if (!root) throw new Error('retention cleanup root is not held');
  const parts = relative(resolve(base), resolve(path)).split(sep).filter(Boolean);
  if (parts.length === 0 || parts.some((part) => !safeSegment(part))) throw new Error('retention cleanup path is invalid');
  let parent: FileHandle;
  try { parent = await openRelativeDirectory(root.handle, parts.slice(0, -1)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
  try {
    const name = parts[parts.length - 1]!;
    try { await lstat(procPath(parent, name)); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
  } finally { await parent.close(); }
}

async function candidateMtime(options: RetentionOptionsWithRoots, candidate: Candidate): Promise<number | null> {
  const root = options.__retentionRoots.get(resolve(candidate.base));
  if (!root) throw new Error('retention candidate root is not held');
  const parts = relative(resolve(candidate.base), resolve(candidate.path)).split(sep).filter(Boolean);
  const parent = await openRelativeDirectory(root.handle, parts.slice(0, -1));
  try { return (await lstat(procPath(parent, parts[parts.length - 1]!))).mtimeMs; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  finally { await parent.close(); }
}

function assertJobRootAbsentSync(stateRoot: FileHandle, jobsRoot: FileHandle | undefined, jobId: string): void {
  try { lstatSync(jobsRoot ? procPath(jobsRoot, jobId) : procPath(stateRoot, `jobs/${jobId}`)); throw new Error('terminal job root reappeared during row purge'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

async function assertQuarantineRootsAbsent(options: RetentionOptionsWithRoots, jobId: string): Promise<void> {
  for (const root of options.paths.approvedQuarantineRoots) {
    if (!await pathAbsentThroughRoot(options, root, join(root, jobId))) throw new Error('terminal quarantine root is still present');
  }
}

function assertQuarantineRootsAbsentSync(options: RetentionOptionsWithRoots, jobId: string): void {
  for (const path of options.paths.approvedQuarantineRoots) {
    const root = options.__retentionRoots.get(resolve(path));
    if (!root) throw new Error('retention quarantine root is not held');
    try { lstatSync(procPath(root.handle, jobId)); throw new Error('terminal quarantine root reappeared during row purge'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

async function pruneTerminalRows(options: RetentionOptionsWithRoots, now: string): Promise<readonly QueueBlocker[]> {
  if (!options.db) return [];
  const blockers: QueueBlocker[] = [];
  const cutoff = new Date(threshold(now, RETENTION_DAYS.rows)).toISOString();
  const rows = options.db.prepare(`SELECT job_id, artifact_quarantine_path FROM jobs WHERE ${ELIGIBLE_TERMINAL_ROW_SQL} ORDER BY job_id`).all(cutoff) as Array<{ job_id?: unknown; artifact_quarantine_path?: unknown }>;
  const stateRoot = options.__retentionRoots.get(resolve(options.paths.stateRoot));
  if (!stateRoot) throw new Error('retention state root is not held');
  let jobsRoot: FileHandle | undefined;
  try {
    try { jobsRoot = await openRelativeDirectory(stateRoot.handle, ['jobs']); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const row of rows) {
      if (!safeSegment(row.job_id)) continue;
      const jobId = row.job_id;
      const jobPath = join(options.paths.stateRoot, 'jobs', jobId);
      const record: RetentionPruneRecord = { category: 'row', relativePath: `jobs/${jobId}`, action: 'removed', bytes: 0, timestamp: now };
      try {
        assertCanonicalQuarantinePath(jobId, row.artifact_quarantine_path);
        if (!await pathAbsentThroughRoot(options, options.paths.stateRoot, jobPath)) throw new Error('terminal job root is still present');
        if (row.artifact_quarantine_path !== null) await assertQuarantineRootsAbsent(options, jobId);
        const intent = options.db.prepare(`SELECT status FROM retention_prune_intents
          WHERE category='row' AND relative_path=?`).get(record.relativePath) as { status?: unknown } | undefined;
        if (intent?.status !== 'removed') throw new Error('terminal job row intent is not removed');
        await options.beforeRowPurge?.({ jobId, path: jobPath });
        if (!jobsRoot) {
          try { jobsRoot = await openRelativeDirectory(stateRoot.handle, ['jobs']); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      } catch (error) {
        const details = { category: 'row', relativePath: record.relativePath, reason: error instanceof Error ? error.message : String(error) };
        blockers.push({ code: 'RETENTION_ROW_PRUNE_FAILED', details });
        continue;
      }
      options.db.exec('BEGIN IMMEDIATE');
      try {
        assertJobRootAbsentSync(stateRoot.handle, jobsRoot, jobId);
        const eligible = options.db.prepare(`SELECT job_id, artifact_quarantine_path FROM jobs WHERE job_id=? AND ${ELIGIBLE_TERMINAL_ROW_SQL}`).get(jobId, cutoff) as { job_id?: unknown; artifact_quarantine_path?: unknown } | undefined;
        if (!eligible) throw new Error('terminal job row eligibility changed before purge');
        assertCanonicalQuarantinePath(jobId, eligible.artifact_quarantine_path);
        if (eligible.artifact_quarantine_path !== null) assertQuarantineRootsAbsentSync(options, jobId);
        options.db.prepare('INSERT INTO retention_purge_authorizations (job_id, authorized_at) VALUES (?, ?)').run(jobId, now);
        options.db.prepare('DELETE FROM queue_dispatch_claims WHERE job_id=?').run(jobId);
        options.db.prepare('DELETE FROM cleanup_stop_authorization_outcomes WHERE job_id=?').run(jobId);
        options.db.prepare('DELETE FROM cleanup_stop_authorization_heads WHERE job_id=?').run(jobId);
        options.db.prepare('DELETE FROM cleanup_stop_authorizations WHERE job_id=?').run(jobId);
        options.db.prepare('DELETE FROM cleanup_credential_reservations WHERE job_id=?').run(jobId);
        options.db.prepare('DELETE FROM cleanup_leases WHERE job_id=?').run(jobId);
        options.db.prepare('DELETE FROM legacy_blocked_publish_evidence WHERE job_id=?').run(jobId);
        options.db.prepare('DELETE FROM publish_blocker_rechecks WHERE job_id=?').run(jobId);
        options.db.prepare('DELETE FROM job_events WHERE job_id=?').run(jobId);
        options.db.prepare('DELETE FROM job_log_generations WHERE job_id=?').run(jobId);
        options.db.prepare('DELETE FROM job_stages WHERE job_id=?').run(jobId);
        options.db.prepare('DELETE FROM job_operations WHERE job_id=?').run(jobId);
        options.db.prepare('DELETE FROM queue_entries WHERE job_id=?').run(jobId);
        options.db.prepare('DELETE FROM retention_purge_authorizations WHERE job_id=?').run(jobId);
        const deleted = options.db.prepare(`DELETE FROM jobs WHERE job_id=? AND ${ELIGIBLE_TERMINAL_ROW_SQL}`).run(jobId, cutoff);
        if (deleted.changes !== 1) throw new Error('terminal job row was not deleted');
        assertJobRootAbsentSync(stateRoot.handle, jobsRoot, jobId);
        if (eligible.artifact_quarantine_path !== null) assertQuarantineRootsAbsentSync(options, jobId);
        options.db.exec('COMMIT');
      } catch (error) {
        try { options.db.exec('ROLLBACK'); } catch { /* preserve row prune failure */ }
        const details = { category: 'row', relativePath: record.relativePath, reason: error instanceof Error ? error.message : String(error) };
        blockers.push({ code: 'RETENTION_ROW_PRUNE_FAILED', details });
        continue;
      }
    }
  } finally { await jobsRoot?.close().catch(() => undefined); }
  return blockers;
}

async function reconcileIntents(options: RetentionOptionsWithRoots, now: string, candidates: Candidate[]): Promise<void> {
  if (!options.db) return;
  const cutoff = new Date(threshold(now, RETENTION_DAYS.rows)).toISOString();
  const jobs = options.db.prepare(`SELECT job_id, artifact_quarantine_path FROM jobs WHERE ${ELIGIBLE_TERMINAL_ROW_SQL} ORDER BY job_id`).all(cutoff) as Array<{ job_id?: unknown; artifact_quarantine_path?: unknown }>;
  const eligibleJobs = new Set(jobs.flatMap((row) => safeSegment(row.job_id) && (row.artifact_quarantine_path === null || isCanonicalQuarantinePath(row.job_id, row.artifact_quarantine_path)) ? [row.job_id] : []));
  const worktreeCutoff = new Date(threshold(now, RETENTION_DAYS.worktrees)).toISOString();
  const worktreeJobs = options.db.prepare(`SELECT job_id FROM jobs WHERE ${ELIGIBLE_TERMINAL_ROW_SQL} ORDER BY job_id`).all(worktreeCutoff) as Array<{ job_id?: unknown }>;
  const eligibleWorktreeJobs = new Set(worktreeJobs.flatMap((row) => safeSegment(row.job_id) ? [row.job_id] : []));
  const protectedLogs = protectedLogPaths(options.db);
  const existing = new Set(candidates.map((candidate) => `${candidate.category}:${relativePath(candidate.auditBase, candidate.path)}`));
  const intents = options.db.prepare(`SELECT category, relative_path, target_dev, target_ino FROM retention_prune_intents
    WHERE (category='quarantine' AND status IN ('planned', 'failed'))
       OR (category<>'quarantine' AND status IN ('planned', 'removed', 'failed'))
    ORDER BY intent_id`).all() as Array<{ category?: unknown; relative_path?: unknown; target_dev?: unknown; target_ino?: unknown }>;
  for (const intent of intents) {
    if (!RETENTION_CATEGORIES.includes(intent.category as RetentionCategory) || typeof intent.relative_path !== 'string') continue;
    const category = intent.category as RetentionCategory;
    const parts = intent.relative_path.split('/');
    if (parts.some((part) => !safeSegment(part))) continue;
    if (category === 'quarantine') {
      for (const root of options.paths.approvedQuarantineRoots) {
        const auditBase = options.paths.approvedReleaseRoots.find((release) => contained(release, root)) ?? root;
        const expectedPath = join(root, parts[parts.length - 1]!);
        if (relativePath(auditBase, expectedPath) !== intent.relative_path) continue;
        const targetDev = Number(intent.target_dev);
        const targetIno = Number(intent.target_ino);
        const hasTargetIdentity = intent.target_dev !== null && intent.target_ino !== null
          && Number.isSafeInteger(targetDev) && targetDev >= 0 && Number.isSafeInteger(targetIno) && targetIno >= 0;
        if (!hasTargetIdentity) {
          const legacyCandidate: Candidate = {
            base: root,
            auditBase,
            path: expectedPath,
            category: 'quarantine',
            cutoffDays: RETENTION_DAYS.quarantine,
            stateEligible: false,
            durable: true,
          };
          await finalizeIntent(options, legacyCandidate, {
            category: 'quarantine',
            relativePath: intent.relative_path,
            action: 'skipped',
            bytes: 0,
            timestamp: now,
          }, PRE_V15_QUARANTINE_INTENT_REASON);
          break;
        }
        const candidate = quarantineCandidate(options, root, auditBase, expectedPath, now);
        if (candidate) {
          const resumed = { ...candidate, stateEligible: true, replayIdentity: { dev: targetDev, ino: targetIno } };
          const existingIndex = candidates.findIndex((value) => value.category === 'quarantine'
            && relativePath(value.auditBase, value.path) === intent.relative_path);
          if (existingIndex === -1) candidates.push(resumed);
          else candidates[existingIndex] = resumed;
        }
        break;
      }
      continue;
    }
    const jobId = parts[1];
    if (parts[0] !== 'jobs' || !safeSegment(jobId)) continue;
    if (category === 'worktree' ? !eligibleWorktreeJobs.has(jobId) : !eligibleJobs.has(jobId)) continue;
    let path: string | undefined;
    if (category === 'row' && parts.length === 2) {
      const expectedPath = join(options.paths.stateRoot, 'jobs', jobId);
      if (relativePath(options.paths.stateRoot, expectedPath) === intent.relative_path) path = expectedPath;
    } else if (category === 'worktree') {
      const expectedPath = options.paths.worktreeRoot === undefined
        ? join(options.paths.stateRoot, 'jobs', jobId, 'workspace', 'source')
        : join(options.paths.worktreeRoot, jobId);
      if (relativePath(options.paths.stateRoot, expectedPath) === intent.relative_path) path = expectedPath;
    } else if (category === 'evidence' && parts.length > 3 && parts[2] === 'evidence') {
      path = join(options.paths.stateRoot, ...parts);
    } else if (category === 'log' && parts.length > 3 && parts[2] === 'logs' && !protectedLogs.has(`${jobId}:${parts.slice(2).join('/')}`) && options.db.prepare(`SELECT 1 FROM job_log_generations AS generation
      JOIN jobs AS job ON job.job_id = generation.job_id
      WHERE generation.job_id=? AND generation.path=? AND generation.started_at < ?
        AND job.state IN ('succeeded', 'failed', 'cancelled', 'interrupted') AND job.terminal_at IS NOT NULL LIMIT 1`).get(jobId, parts.slice(2).join('/'), new Date(threshold(now, RETENTION_DAYS.logs)).toISOString())) {
      path = join(options.paths.stateRoot, ...parts);
    }
    if (!path || !contained(options.paths.stateRoot, path)) continue;
    const key = `${category}:${intent.relative_path}`;
    if (!existing.has(key)) candidates.push({ base: options.paths.stateRoot, auditBase: options.paths.stateRoot, path, category, cutoffDays: 0, stateEligible: true, durable: true });
  }
}

export function createRetentionStartupHook(options: RetentionOptions): RetentionStartupHook {
  return async (): Promise<StartupPhaseResult> => {
    const now = options.now ?? options.clock?.now();
    if (!now) throw new Error('retention requires a clock');
    const invalid = await validateConfiguredRoots(options.paths);
    if (invalid) return { blockers: [invalid] };
    let roots: Map<string, OpenRoot>;
    try { roots = await openConfiguredRoots(options.paths); }
    catch (error) { return { blockers: [{ code: 'RETENTION_ROOT_INVALID', details: { reason: (error as NodeJS.ErrnoException).code === 'ELOOP' ? 'root-not-directory' : 'root-unavailable' } }] }; }
    const secureOptions = { ...options, __retentionRoots: roots } as RetentionOptionsWithRoots;
    try {
      const freeBytes = typeof options.freeBytes === 'function' ? await options.freeBytes() : options.freeBytes;
      const candidates: Candidate[] = [];
      const cacheCandidates: Candidate[] = [];
      for (const root of options.paths.builderOwnedRoots) {
        const builder = roots.get(resolve(root));
        if (!builder) throw new Error('retention builder root is not held');
        let cacheRoot: FileHandle;
        try { cacheRoot = await openRelativeDirectory(builder.handle, ['cache']); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        try {
          for (const cache of await directoryChildren(cacheRoot, join(root, 'cache'))) {
            const cacheHandle = await openEntry(cacheRoot, relative(join(root, 'cache'), cache));
            try { for (const path of await directoryChildren(cacheHandle, cache)) cacheCandidates.push({ base: options.paths.stateRoot, auditBase: options.paths.stateRoot, path, category: 'cache', cutoffDays: RETENTION_DAYS.caches, stateEligible: false, durable: false }); }
            finally { await cacheHandle.close(); }
          }
        } finally { await cacheRoot.close(); }
      }
      for (const root of options.paths.approvedQuarantineRoots) {
        if (!roots.has(resolve(root))) throw new Error('retention quarantine root is not held');
      }
      await quarantineCandidates(options, roots, now, candidates);
      await databaseCandidates(options, roots, now, candidates);
      await reconcileIntents(secureOptions, now, candidates);
      const blockers: QueueBlocker[] = [];
      const uniqueCandidates = [...new Map(candidates.map((candidate) => [`${candidate.category}:${resolve(candidate.path)}`, candidate])).values()]
        .sort((left, right) => Number(left.category === 'row') - Number(right.category === 'row'));
      for (const candidate of uniqueCandidates) {
        try { await pruneCandidate(secureOptions, candidate, now); }
        catch (error) {
          const details = { category: candidate.category, relativePath: relativePath(candidate.auditBase, candidate.path), reason: error instanceof Error ? error.message : String(error) };
          try { await finalizeIntent(options, candidate, { category: candidate.category, relativePath: details.relativePath, action: 'failed', bytes: 0, timestamp: now }, details.reason); } catch { /* blocker remains the durable signal */ }
          blockers.push({ code: 'RETENTION_PRUNE_FAILED', details });
        }
      }
      const uniqueCaches = [...new Map(cacheCandidates.map((candidate) => [resolve(candidate.path), candidate])).values()];
      const cacheStats = await Promise.all(uniqueCaches.map(async (candidate) => { const mtimeMs = await candidateMtime(secureOptions, candidate); return mtimeMs === null ? null : { candidate, mtimeMs }; }));
      const orderedCaches = cacheStats.filter((value): value is { candidate: Candidate; mtimeMs: number } => value !== null).sort((left, right) => left.mtimeMs - right.mtimeMs);
      let currentFreeBytes = freeBytes;
      const dynamicFreeBytes = typeof options.freeBytes === 'function';
      const belowFloor = currentFreeBytes < MIN_CACHE_FREE_BYTES;
      for (const { candidate } of orderedCaches) {
        if (belowFloor && dynamicFreeBytes) { currentFreeBytes = await options.freeBytes(); if (currentFreeBytes >= MIN_CACHE_FREE_BYTES) break; }
        const mtimeMs = await candidateMtime(secureOptions, candidate);
        if (mtimeMs === null || (!belowFloor && mtimeMs >= threshold(now, RETENTION_DAYS.caches))) continue;
        try { await pruneCandidate(secureOptions, { ...candidate, stateEligible: belowFloor }, now); }
        catch (error) {
          const details = { category: candidate.category, relativePath: relativePath(candidate.auditBase, candidate.path), reason: error instanceof Error ? error.message : String(error) };
          try { await finalizeIntent(options, candidate, { category: 'cache', relativePath: details.relativePath, action: 'failed', bytes: 0, timestamp: now }, details.reason); } catch { /* blocker remains the durable signal */ }
          blockers.push({ code: 'RETENTION_PRUNE_FAILED', details });
        }
      }
      if (blockers.length === 0) blockers.push(...await pruneTerminalRows(secureOptions, now));
      if (!options.db) {
        for (const root of options.paths.approvedQuarantineRoots) {
          const auditBase = options.paths.approvedReleaseRoots.find((release) => contained(release, root)) ?? root;
          blockers.push({
            code: 'RETENTION_PRUNE_FAILED',
            details: {
              category: 'quarantine',
              relativePath: relativePath(auditBase, root),
              reason: 'database-authority-unavailable',
            },
          });
        }
      }
      if (options.db) options.db.prepare('DELETE FROM retention_prunes WHERE at < ?').run(new Date(threshold(now, RETENTION_DAYS.rows)).toISOString());
      return { blockers };
    } finally { await closeConfiguredRoots(roots); }
  };
}

export const createRetentionHook = createRetentionStartupHook;
