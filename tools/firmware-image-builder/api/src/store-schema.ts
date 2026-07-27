import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  { version: 12, filename: '012_cleanup_admission_supersession_evidence.sql', sha256: 'b25172c4238922074aac83e08ed21fea0fbceca1d81be8c4c3aea63caad1119d' },
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
      try {
        db.exec('BEGIN IMMEDIATE');
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (version, filename, sha256, applied_at) VALUES (?, ?, ?, ?)')
          .run(migration.version, migration.filename, migration.sha256, now());
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch (rollbackError) { void rollbackError; }
        throw new MigrationError(`migration ${migration.filename} failed`, { cause: error });
      }
    }
    verifyLiveSchema(db, migrationContents, MIGRATION_REGISTRY.length);
    return db;
  } catch (error) {
    return closeAfterError(db, error);
  }
}
