import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIGRATION_021_STRONG_RECOVERY_QUERY, migration021PostRecoveryQuery } from './migration-021-recovery-proof.js';

export interface MigrationDescriptor {
  readonly version: number;
  readonly filename: string;
  readonly sha256: string;
}

const migrationRegistry = [
  { version: 1, filename: '001_initial.sql', sha256: '8e598d53a64191e73ac9ef42f2adb154fabd6978341381c3b8a858f99513e8b8' },
  { version: 2, filename: '002_recovery.sql', sha256: '1f5a01693e1b0ced9fc5676af008099a842d0ecbac709f4b7587a7af6fb878bd' },
  { version: 3, filename: '003_freshness_and_logs.sql', sha256: 'f6bbe6bb8471828c4486e7a29615d8238bc58e5369deaafae39e03560a656d29' },
  { version: 4, filename: '004_source_preparation.sql', sha256: 'c23610252d741721f9e815af35909a0bc80ffd91e226c5ec6f92bb635a57bcd9' },
  { version: 5, filename: '005_offline_feed_preparation.sql', sha256: '469d8d3cbd1c16cbd2e3b604f3a688726546387d8974f57c5b0c6254c95f7c02' },
  { version: 6, filename: '006_blocked_publish_artifact_location.sql', sha256: 'c6334dd0fd03b34b8261e5b34bc0b09501e35a02ee4b57f81c98fd62af6e54a0' },
  { version: 7, filename: '007_publish_intent_and_accepted_operations.sql', sha256: '5f22812edecb2846b5f7993dd48a570a6210d5ef76fc378557bcc96795c84b93' },
  { version: 8, filename: '008_preparation_artifact_ownership.sql', sha256: '2c41fb53b1cc068ffaaf0c4ae9d935a74cb9aa25b0a7bcbe13c4f68bcab584a9' },
  { version: 9, filename: '009_cancellation_protocol_index.sql', sha256: '24753ab202491f25942c7a0f1a7505f2531aa6870649ac58b1f225baa03804c3' },
  { version: 10, filename: '010_cancellation_escalation_coordination.sql', sha256: 'e358b53895ae97bdf1778135c957257ab1cb014b44d72caeecb2c511ca02c283' },
  { version: 11, filename: '011_cancellation_clock_and_stop_authorization.sql', sha256: '0e9255cd9ceed96061eaad598821b7a137cb364a6bc530018f3ffaf2984df7ce' },
  { version: 12, filename: '012_cleanup_admission_supersession_evidence.sql', sha256: '2ad0bf8a9084ca8a875ca4b1699df827448eb991c5518c78e5aa68048df21a97' },
  { version: 13, filename: '013_queue_dispatch_claim.sql', sha256: '71b0dc3ea317f5c92e79021fbdda17a0639f11061105e325968f75a2094ca3b9' },
  { version: 14, filename: '014_retention_prunes.sql', sha256: '4735a255db547ad3a65ceb48cf26907b02ef3d765f9fdbe7f625a00bf0097418' },
  { version: 15, filename: '015_retention_prune_target_identity.sql', sha256: '7ce5f98e5a6b373b6d934816373e6bae87de756e443d890b2da399b972d3c317' },
  { version: 16, filename: '016_log_gap_source_seq_unique.sql', sha256: 'a2b204916583b2f8ee3bce3b633ee8b1bf477df1b9f27b829b14fcc24833436e' },
  { version: 17, filename: '017_publish_blocker_recheck.sql', sha256: '80a4c6c4ad4c2d63eff82cabedd6750b7d3eb06767e7bac6e1c56c5baf61b947' },
  { version: 18, filename: '018_release_seal_status.sql', sha256: 'e8c20bd286c10c790499336aca351be7da182aad800fad3a9d9868f0e5d56841' },
  { version: 19, filename: '019_job_builder_identity.sql', sha256: 'b8a3086a265cc9f61e45fb884dbf3498faade567cef04100603c5b5371dc6805' },
  { version: 20, filename: '020_complete_builder_identity.sql', sha256: '9a3a9e119ff5a329ca899d66e2642733a0a5d75cc1597e712ec48074bb1f77f2' },
  { version: 21, filename: '021_dependency_egress_proxy_identity.sql', sha256: '5390ec094daa621818ac14d8e0ea424100bae0cc6f839a926e1a5e6dcdb0f70b' },
  { version: 22, filename: '022_audit_dependency_egress_recovery.sql', sha256: '46458f17e00b3aa8b15ff805fb51f4789e41d8bcb14865c7c266aa721fbb69b8' },
] as const;

export const MIGRATION_REGISTRY: readonly MigrationDescriptor[] = Object.freeze(
  migrationRegistry.map((migration) => Object.freeze(migration)),
);

export class MigrationError extends Error {
  closeCause?: unknown;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

export interface OpenBuilderDatabaseOptions {
  readonly migrationsDirectory?: string;
  readonly busyTimeoutMs?: number;
  readonly now?: () => string;
  readonly beforeMigration?: (migration: MigrationDescriptor) => void;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const migrationNamePattern = /^\d{3}_[a-z0-9_]+\.sql$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

export function validateMigrationRegistry(registry: readonly MigrationDescriptor[]): void {
  if (registry.length === 0) throw new MigrationError('migration registry must not be empty');
  const versions = registry.map((migration) => migration.version);
  if (versions.some((version) => !Number.isInteger(version) || version <= 0)) {
    throw new MigrationError('migration registry versions must be positive integers');
  }
  if (new Set(versions).size !== versions.length) throw new MigrationError('migration registry versions must be unique');
  const filenames = registry.map((migration) => migration.filename);
  if (new Set(filenames).size !== filenames.length) throw new MigrationError('migration registry filenames must be unique');
  if (versions.some((version, index) => version !== index + 1) || versions.some((version, index) => index > 0 && version <= versions[index - 1]!)) {
    throw new MigrationError('migration registry versions must be strictly sorted and contiguous');
  }
  for (const migration of registry) {
    if (!migrationNamePattern.test(migration.filename)) throw new MigrationError('migration registry contains an invalid filename');
    const expectedPrefix = `${String(migration.version).padStart(3, '0')}_`;
    if (!migration.filename.startsWith(expectedPrefix)) throw new MigrationError('migration filename/version prefix mismatch');
    if (!sha256Pattern.test(migration.sha256)) throw new MigrationError('migration registry contains an invalid SHA-256');
  }
}

function digest(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

function closeAfterError(db: DatabaseSync, error: unknown): never {
  try { db.close(); } catch (closeError) { void closeError; }
  throw error;
}

function configurePragmas(db: DatabaseSync, busyTimeoutMs: number): void {
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs <= 0 || busyTimeoutMs > 30_000) {
    throw new MigrationError('busy timeout must be a positive value no greater than 30000 ms');
  }
  const journal = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: string };
  if (journal.journal_mode?.toLowerCase() !== 'wal') {
    throw new MigrationError('SQLite WAL mode could not be enabled');
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: number };
  const timeout = db.prepare('PRAGMA busy_timeout').get() as { timeout?: number };
  if (foreignKeys.foreign_keys !== 1 || !timeout.timeout || timeout.timeout <= 0 || timeout.timeout > 30_000) {
    throw new MigrationError('SQLite safety pragmas were not applied');
  }
}

function readAndValidateMigrations(directory: string): Map<number, string> {
  try {
    const entries = readdirSync(directory, { withFileTypes: true });
    const migrationLikeEntries = entries.filter((entry) => entry.name.endsWith('.sql') || /^\d{3}_/.test(entry.name));
    if (migrationLikeEntries.some((entry) => !entry.isFile())) {
      throw new MigrationError('migration directory contains a non-regular migration entry');
    }
    const sqlFilenames = migrationLikeEntries.map((entry) => entry.name);
    const filenames = new Set(sqlFilenames);
    const knownNames = new Set(MIGRATION_REGISTRY.map((migration) => migration.filename));
    for (const filename of filenames) {
      if (!migrationNamePattern.test(filename) || !knownNames.has(filename)) {
        throw new MigrationError(`unknown migration file: ${filename}`);
      }
    }
    if (filenames.size !== knownNames.size || [...knownNames].some((filename) => !filenames.has(filename))) {
      throw new MigrationError('migration files are missing or incomplete');
    }
    const contents = new Map<number, string>();
    for (const migration of MIGRATION_REGISTRY) {
      const bytes = readFileSync(join(directory, migration.filename));
      const actual = digest(bytes);
      if (actual !== migration.sha256) {
        throw new MigrationError(`migration checksum drift: ${migration.filename}`);
      }
      contents.set(migration.version, bytes.toString());
    }
    return contents;
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError('cannot read migration files', { cause: error });
  }
}

interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly sql: string | null;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function liveSchemaFingerprint(db: DatabaseSync): string {
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE type IN ('table', 'index', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as unknown as SchemaObject[];
  const tableNames = objects.filter((object) => object.type === 'table').map((object) => object.name);
  const foreignKeys = tableNames.map((table) => [table, db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all()] as const);
  return JSON.stringify({ objects, foreignKeys });
}

function verifyLiveSchema(db: DatabaseSync, migrationContents: Map<number, string>, appliedCount: number): void {
  let canonical: DatabaseSync;
  try {
    canonical = new DatabaseSync(':memory:');
  } catch (error) {
    throw new MigrationError('schema validation failed', { cause: error });
  }
  let hasPrimaryError = false;
  let primaryError: unknown;
  let hasCloseError = false;
  let closeError: unknown;
  try {
    for (const migration of MIGRATION_REGISTRY.slice(0, appliedCount)) {
      const sql = migrationContents.get(migration.version);
      if (sql === undefined) throw new MigrationError(`missing migration contents: ${migration.filename}`);
      canonical.exec(sql);
    }
    if (liveSchemaFingerprint(db) !== liveSchemaFingerprint(canonical)) {
      throw new MigrationError('live schema drift detected');
    }
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  } finally {
    try {
      canonical.close();
    } catch (error) {
      hasCloseError = true;
      closeError = error;
    }
  }
  if (hasPrimaryError) {
    if (primaryError instanceof MigrationError) {
      if (hasCloseError) primaryError.closeCause = closeError;
      throw primaryError;
    }
    const validationError = new MigrationError('schema validation failed', { cause: primaryError });
    if (hasCloseError) validationError.closeCause = closeError;
    throw validationError;
  }
  if (hasCloseError) throw new MigrationError('schema validation close failed', { cause: closeError });
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}

function validateAppliedMigrations(db: DatabaseSync): number {
  try {
    if (!hasTable(db, 'schema_migrations')) {
      const stateTable = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name IN ('jobs', 'queue_entries', 'job_stages', 'job_operations', 'job_events', 'cleanup_leases') LIMIT 1").get();
      if (stateTable !== undefined) throw new MigrationError('state tables exist without schema_migrations');
      return 0;
    }
    const rows = db.prepare('SELECT version, filename, sha256 FROM schema_migrations ORDER BY version').all() as Array<{ version: number; filename: string; sha256: string }>;
    if (rows.some((row) => !MIGRATION_REGISTRY.some((migration) => migration.version === row.version))) {
      throw new MigrationError('unknown applied migration version');
    }
    if (rows.length > MIGRATION_REGISTRY.length) throw new MigrationError('unknown applied migration version');
    for (let index = 0; index < rows.length; index += 1) {
      const expected = MIGRATION_REGISTRY[index];
      const actual = rows[index];
      if (!expected || actual.version !== expected.version || actual.filename !== expected.filename) {
        throw new MigrationError('migration versions are gapped or reordered');
      }
      if (actual.sha256 !== expected.sha256) throw new MigrationError(`applied migration checksum drift: ${actual.filename}`);
    }
    return rows.length;
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError('invalid schema_migrations table', { cause: error });
  }
}

function assertNoActiveLegacyBuilderIdentity(db: DatabaseSync): void {
  const blocked = db.prepare(`SELECT job_id, state, queue_state
    FROM jobs
    WHERE builder_identity_status = 'legacy_blocked'
      AND (
        queue_state = 'dispatched'
        OR state IN ('starting', 'preflight', 'source', 'release_gates', 'frontend', 'target_setup',
          'feeds', 'config', 'building', 'verifying', 'publishing', 'cancel_requested')
        OR (runner_finished_at IS NULL AND (
          runner_lease_owner IS NOT NULL
          OR runner_lease_expires_at IS NOT NULL
          OR runner_started_at IS NOT NULL
        ))
        OR EXISTS (
          SELECT 1 FROM cleanup_leases
          WHERE cleanup_leases.job_id = jobs.job_id
            AND cleanup_leases.status IN ('admitted', 'claimed')
        )
      )
    LIMIT 1`).get() as { job_id: string; state: string; queue_state: string } | undefined;
  if (blocked !== undefined) {
    throw new MigrationError(
      `legacy builder identity is active or dispatched: ${blocked.job_id}`,
    );
  }
}

function assertNoActiveUnboundBuilderIdentity(db: DatabaseSync): void {
  const blocked = db.prepare(`SELECT job_id, state, queue_state
    FROM jobs
    WHERE builder_identity_status IN ('admitted', 'legacy_blocked')
      AND (
        queue_state = 'dispatched'
        OR state IN ('starting', 'preflight', 'source', 'release_gates', 'frontend', 'target_setup',
          'feeds', 'config', 'building', 'verifying', 'publishing', 'cancel_requested')
        OR (runner_finished_at IS NULL AND (
          runner_lease_owner IS NOT NULL
          OR runner_lease_expires_at IS NOT NULL
          OR runner_started_at IS NOT NULL
        ))
        OR EXISTS (
          SELECT 1 FROM cleanup_leases
          WHERE cleanup_leases.job_id = jobs.job_id
            AND cleanup_leases.status IN ('admitted', 'claimed')
        )
      )
    LIMIT 1`).get() as { job_id: string; state: string; queue_state: string } | undefined;
  if (blocked !== undefined) {
    throw new MigrationError(
      `legacy builder identity is active or dispatched before migration 021: ${blocked.job_id}`,
    );
  }
}

interface RecoveryCandidate {
  readonly job_id: string;
  readonly complete_at: string;
}

const RECONCILED_RECOVERY_CANDIDATES_SQL = `
  SELECT job.job_id
  FROM jobs AS job
  JOIN cleanup_leases AS lease
    ON lease.job_id = job.job_id
   AND lease.status = 'handed_back'
  JOIN job_events AS completion
    ON completion.job_id = job.job_id
   AND completion.event_type = 'cleanup_complete'
   AND completion.at = lease.complete_at
   AND completion.state = lease.stale_state
  JOIN job_events AS handback
    ON handback.job_id = job.job_id
   AND handback.event_type = 'recovery'
   AND handback.at = lease.handback_at
   AND handback.state = 'interrupted'
  WHERE job.builder_identity_status = 'legacy_blocked'
    AND job.state = 'interrupted'
    AND job.queue_state = 'complete'
    AND job.terminal_at IS NOT NULL
    AND job.runner_unit IS NOT NULL
    AND job.runner_started_at IS NOT NULL
    AND job.runner_finished_at = lease.complete_at
    AND job.runner_lease_owner IS NULL
    AND job.runner_lease_expires_at IS NULL
    AND job.cleanup_admission_id IS NULL
    AND job.cleanup_fence_generation IS NULL
    AND job.cleanup_fence_token_hash IS NULL
    AND job.cleanup_blocker_code IS NULL
    AND job.cleanup_blocker_json IS NULL
    AND job.container_id IS NULL
    AND job.container_name IS NULL
    AND job.container_image_digest IS NULL
    AND job.container_label_job_id IS NULL
    AND job.container_label_manifest_sha IS NULL
    AND job.container_labels_json IS NULL
    AND job.container_mount_json IS NULL
    AND job.container_env_json IS NULL
    AND job.container_security_json IS NULL
    AND job.container_inspection_json IS NULL
    AND job.container_created_at IS NULL
    AND job.container_started_at IS NULL
    AND job.container_stopped_at IS NULL
    AND job.container_removed_at IS NULL
    AND job.container_cleanup_outcome IS NULL
    AND lease.handback_at = job.terminal_at
  GROUP BY job.job_id
  HAVING COUNT(*) = 1`;

function readRecoveryCandidates(db: DatabaseSync, query: string): RecoveryCandidate[] {
  try {
    return db.prepare(query).all() as unknown as RecoveryCandidate[];
  } catch (error) {
    throw new MigrationError('dependency-egress recovery qualification query failed', { cause: error });
  }
}

function reconcileStrongV20RecoveryCandidates(db: DatabaseSync, candidates: readonly RecoveryCandidate[]): void {
  const reconcile = db.prepare(`
    UPDATE jobs
    SET runner_finished_at = ?,
        runner_lease_owner = NULL,
        runner_lease_expires_at = NULL
    WHERE job_id = ?
      AND runner_finished_at IS NULL
      AND runner_lease_owner IS NOT NULL
      AND runner_lease_expires_at IS NOT NULL`);
  for (const candidate of candidates) {
    reconcile.run(candidate.complete_at, candidate.job_id);
    const row = db.prepare(`SELECT runner_finished_at, runner_lease_owner, runner_lease_expires_at
      FROM jobs WHERE job_id=?`).get(candidate.job_id) as {
        runner_finished_at: string | null;
        runner_lease_owner: string | null;
        runner_lease_expires_at: string | null;
      } | undefined;
    if (row?.runner_finished_at !== candidate.complete_at || row.runner_lease_owner !== null || row.runner_lease_expires_at !== null) {
      throw new MigrationError(`dependency-egress recovery reconciliation failed: ${candidate.job_id}`);
    }
  }
}

function assertNoUnprovenDependencyEgressRecovery(
  db: DatabaseSync,
  migrationVersion: 21 | 22,
  strongPreCandidates?: readonly RecoveryCandidate[],
): void {
  const reconciled = readRecoveryCandidates(db, RECONCILED_RECOVERY_CANDIDATES_SQL);
  const proven = readRecoveryCandidates(db, migration021PostRecoveryQuery());
  const provenIds = new Set(proven.map((candidate) => candidate.job_id));
  const strongPreIds = strongPreCandidates === undefined
    ? undefined
    : new Set(strongPreCandidates.map((candidate) => candidate.job_id));
  const unproven = reconciled.find((candidate) => !provenIds.has(candidate.job_id) || (strongPreIds !== undefined && !strongPreIds.has(candidate.job_id)))
    ?? strongPreCandidates?.find((candidate) => !provenIds.has(candidate.job_id));
  if (unproven !== undefined) {
    if (migrationVersion === 21) {
      throw new MigrationError(
        `legacy builder identity is active or dispatched before migration 021: ${unproven.job_id}`,
      );
    }
    throw new MigrationError(`unproven historical dependency-egress recovery: ${unproven.job_id}`);
  }
}

export function openBuilderDatabase(databasePath: string, options: OpenBuilderDatabaseOptions = {}): DatabaseSync {
  validateMigrationRegistry(MIGRATION_REGISTRY);
  const migrationsDirectory = options.migrationsDirectory ?? fileURLToPath(new URL('../migrations/', import.meta.url));
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const now = options.now ?? (() => new Date().toISOString());
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(databasePath);
  } catch (error) {
    throw new MigrationError('cannot open database', { cause: error });
  }
  try {
    try {
      configurePragmas(db, busyTimeoutMs);
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      throw new MigrationError('SQLite pragma configuration failed', { cause: error });
    }
    const migrationContents = readAndValidateMigrations(migrationsDirectory);
    const appliedCount = validateAppliedMigrations(db);
    verifyLiveSchema(db, migrationContents, appliedCount);
    for (const migration of MIGRATION_REGISTRY.slice(appliedCount)) {
      const sql = migrationContents.get(migration.version);
      if (sql === undefined) throw new MigrationError(`missing migration contents: ${migration.filename}`);
      options.beforeMigration?.(migration);
      try {
        db.exec('BEGIN IMMEDIATE');
        const strongPreCandidates = migration.version === 21
          ? readRecoveryCandidates(db, MIGRATION_021_STRONG_RECOVERY_QUERY)
          : undefined;
        db.exec(sql);
        if (migration.version === 21) {
          reconcileStrongV20RecoveryCandidates(db, strongPreCandidates!);
          assertNoUnprovenDependencyEgressRecovery(db, migration.version, strongPreCandidates);
          assertNoActiveUnboundBuilderIdentity(db);
        }
        if (migration.version === 22) assertNoUnprovenDependencyEgressRecovery(db, migration.version);
        db.prepare('INSERT INTO schema_migrations (version, filename, sha256, applied_at) VALUES (?, ?, ?, ?)')
          .run(migration.version, migration.filename, migration.sha256, now());
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch (rollbackError) { void rollbackError; }
        if (error instanceof MigrationError) throw error;
        throw new MigrationError(`migration ${migration.filename} failed`, { cause: error });
      }
    }
    verifyLiveSchema(db, migrationContents, MIGRATION_REGISTRY.length);
    assertNoActiveLegacyBuilderIdentity(db);
    return db;
  } catch (error) {
    return closeAfterError(db, error);
  }
}
