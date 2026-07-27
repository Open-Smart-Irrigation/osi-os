import { DatabaseSync } from 'node:sqlite';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openBuilderDatabase, MIGRATION_REGISTRY, MigrationError, validateMigrationRegistry } from '../../api/src/store-schema.js';
import {
  BuilderStore,
  CANCELLATION_PROTOCOL_EVENT_QUERY,
} from '../../api/src/store.js';
import { OwnershipStore } from '../../api/src/ownership.js';

const repoMigrationDir = fileURLToPath(new URL('../../api/migrations/', import.meta.url));
const tempPaths: string[] = [];
const SHA40 = 'a'.repeat(40);
const HASH64 = 'b'.repeat(64);
const HISTORICAL_V6_SHA256 = 'c6334dd0fd03b34b8261e5b34bc0b09501e35a02ee4b57f81c98fd62af6e54a0';
const ADMISSION_ID = `cln_0${'a'.repeat(25)}`;

function sourcePreparationJson(sourceSha = SHA40): string {
  return JSON.stringify({
    schemaVersion: 1,
    sourceSha,
    gitmodulesBlobSha: 'c'.repeat(40),
    preparedAt: '2026-07-23T00:00:00.000Z',
    components: [
      { path: 'feeds/chirpstack-openwrt-feed', mode: '040000', type: 'tree', objectId: 'd'.repeat(40), provenanceUrl: 'https://github.com/chirpstack/chirpstack-openwrt-feed.git' },
      { path: 'openwrt', mode: '040000', type: 'tree', objectId: 'e'.repeat(40), provenanceUrl: 'https://github.com/openwrt/openwrt.git' },
    ],
  });
}

function offlineFeedPreparationJson(jobId = 'job-valid', sourceSha = SHA40): string {
  return JSON.stringify({
    schemaVersion: 1,
    boundary: 'api-prepared-pinned-feeds-v1',
    networkPolicy: 'runner-offline',
    jobId,
    sourceSha,
    preparedAt: '2026-07-23T00:00:00.000Z',
    feeds: [
      {
        name: 'packages',
        location: 'https://git.openwrt.org/feed/packages.git',
        commit: 'd8cd30f4e281d6853b3de134c4f147a807583e43',
        detached: true,
        clean: true,
        recursiveSubmodulesPrepared: true,
        recursiveSubmodules: [],
        recursiveSubmoduleStatusSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        treeSha256: HASH64,
      },
      {
        name: 'luci',
        location: 'https://git.openwrt.org/project/luci.git',
        commit: '2ac26e56cc55102cb10e7b0867c2b78e0f6d5fd8',
        detached: true,
        clean: true,
        recursiveSubmodulesPrepared: true,
        recursiveSubmodules: [],
        recursiveSubmoduleStatusSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        treeSha256: HASH64,
      },
      {
        name: 'routing',
        location: 'https://git.openwrt.org/feed/routing.git',
        commit: 'c9b636698881059a3c981032770968f5a98ff201',
        detached: true,
        clean: true,
        recursiveSubmodulesPrepared: true,
        recursiveSubmodules: [],
        recursiveSubmoduleStatusSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        treeSha256: HASH64,
      },
    ],
  });
}

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'osi-image-builder-migrations-'));
  tempPaths.push(directory);
  return join(directory, 'jobs.sqlite');
}

async function copyMigrations(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'osi-image-builder-migrations-src-'));
  tempPaths.push(directory);
  for (const migration of MIGRATION_REGISTRY) {
    await cp(join(repoMigrationDir, migration.filename), join(directory, migration.filename));
  }
  return directory;
}

function tableInfo(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

function expectColumns(db: DatabaseSync, table: string, columns: readonly string[]): void {
  expect([...tableInfo(db, table)]).toEqual([...columns]);
}

function check(db: DatabaseSync, sql: string, expected: RegExp): void {
  let error: unknown;
  try {
    db.prepare(sql).run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(expected);
}

function expectMigrationError(action: () => unknown, message: RegExp, causeMessage?: RegExp): void {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(MigrationError);
  expect((error as Error).message).toMatch(message);
  if (causeMessage) {
    expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
    expect(((error as Error & { cause: Error }).cause).message).toMatch(causeMessage);
  }
}

function insertValidJob(db: DatabaseSync, jobId = 'job-valid', state = 'queued'): void {
  db.prepare(`INSERT INTO jobs (
    job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id,
    target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at,
    source_preparation_json, offline_feed_preparation_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    jobId, `request-${jobId}`, 'git@example:repo.git', 'refs/remotes/origin/main', 'main', 'main', SHA40, SHA40,
    'rpi-5', 'release', HASH64, '2026-07-23T00:00:00.000Z', 'author', 'subject', '2026-07-23T00:00:00.000Z',
    state, state === 'queued' ? 'queued' : 'dispatched', '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z',
    sourcePreparationJson(), offlineFeedPreparationJson(jobId),
  );
}

function insertAdmittedLease(db: DatabaseSync, jobId = 'job-valid'): void {
  db.prepare(`INSERT INTO cleanup_leases (
    admission_id, job_id, unit_name, owner, expires_at, status, credential_relative_path, credential_sha256,
    fence_generation, fence_token_hash, proof_json, admitted_at
  ) VALUES (?, ?, ?, ?, ?, 'admitted', ?, ?, ?, ?, ?, ?)`).run(
    ADMISSION_ID, jobId, `osi-image-builder-cleanup@${ADMISSION_ID}.service`, 'builder', '2026-07-23T01:00:00.000Z',
    `recovery/cleanup-credentials/${ADMISSION_ID}.token`, HASH64, 1, 'c'.repeat(64), '{}', '2026-07-23T00:00:00.000Z',
  );
}

function containerLabels(jobId: string, manifestSha = HASH64): string {
  return JSON.stringify({
    'org.osi.image-builder.job-id': jobId,
    'org.osi.image-builder.manifest-sha': manifestSha,
  });
}

function stagingEvidence(): Record<string, string | number> {
  return {
    artifact_staging_path: 'staging/image.gz', artifact_sha256: HASH64, artifact_size: 100, artifact_mtime: '2026-07-23T00:00:00.000Z',
    checksum_path: 'staging/SHA256SUMS', checksum_sha256: HASH64,
    manifest_path: 'staging/build-manifest.json', manifest_sha256: HASH64,
    verification_path: 'staging/verification.json', verification_sha256: HASH64,
  };
}

function schemaSnapshot(db: DatabaseSync): unknown {
  const tables = (db.prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all());
  const tableNames = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  const columns = Object.fromEntries(tableNames.map((table) => [table, db.prepare(`PRAGMA table_info(${table})`).all()]));
  const foreignKeys = Object.fromEntries(tableNames.map((table) => [table, db.prepare(`PRAGMA foreign_key_list(${table})`).all()]));
  return { tables, columns, foreignKeys };
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('versioned builder database migrations', () => {
  it('validates the migration registry before it is used', () => {
    const [first, second, third] = MIGRATION_REGISTRY;
    expect(() => validateMigrationRegistry([])).toThrow(/must not be empty/i);
    expect(() => validateMigrationRegistry([first, { ...second, version: 3, filename: '003_recovery.sql' }])).toThrow(/sorted and contiguous/i);
    expect(() => validateMigrationRegistry([second, first, third])).toThrow(/sorted and contiguous/i);
    expect(() => validateMigrationRegistry([first, { ...second, version: 1, filename: '001_recovery.sql' }])).toThrow(/versions must be unique/i);
    expect(() => validateMigrationRegistry([first, { ...second, filename: first.filename }])).toThrow(/filenames must be unique/i);
    expect(() => validateMigrationRegistry([first, { ...second, filename: '001_recovery.sql' }])).toThrow(/prefix mismatch/i);
    expect(() => validateMigrationRegistry([first, { ...second, sha256: 'z'.repeat(64) }])).toThrow(/SHA-256/i);
    expect(() => validateMigrationRegistry([{ ...first, version: 0 }])).toThrow(/positive integers/i);
  });

  it('opens a complete fresh schema with required pragmas and indexes', async () => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);

    expect(Object.isFrozen(MIGRATION_REGISTRY)).toBe(true);
    expect(MIGRATION_REGISTRY.every((migration) => Object.isFrozen(migration))).toBe(true);

    expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    const busyTimeout = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    expect(busyTimeout.timeout).toBeGreaterThan(0);
    expect(busyTimeout.timeout).toBeLessThanOrEqual(30_000);

    expect(db.prepare('SELECT version, filename FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1, filename: '001_initial.sql' },
      { version: 2, filename: '002_recovery.sql' },
      { version: 3, filename: '003_freshness_and_logs.sql' },
      { version: 4, filename: '004_source_preparation.sql' },
      { version: 5, filename: '005_offline_feed_preparation.sql' },
      { version: 6, filename: '006_blocked_publish_artifact_location.sql' },
      { version: 7, filename: '007_publish_intent_and_accepted_operations.sql' },
      { version: 8, filename: '008_preparation_artifact_ownership.sql' },
      { version: 9, filename: '009_cancellation_protocol_index.sql' },
      { version: 10, filename: '010_cancellation_escalation_coordination.sql' },
      { version: 11, filename: '011_cancellation_clock_and_stop_authorization.sql' },
      { version: 12, filename: '012_cleanup_admission_supersession_evidence.sql' },
    ]);
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name))
      .toEqual(['cleanup_credential_reservations', 'cleanup_leases', 'cleanup_stop_authorization_heads', 'cleanup_stop_authorization_outcomes', 'cleanup_stop_authorizations', 'job_events', 'job_log_generations', 'job_operations', 'job_stages', 'jobs', 'legacy_blocked_publish_evidence', 'queue_entries', 'schema_migrations']);
    expectColumns(db, 'jobs', [
      'job_id', 'request_id', 'request_json', 'source_remote', 'source_ref', 'source_branch', 'branch', 'expected_sha', 'pinned_sha',
      'target_id', 'root_id', 'target_manifest_sha256', 'source_commit_time', 'source_author', 'source_subject',
      'preflight_sha', 'preflight_checked_at', 'preflight_expires_at', 'accepted_at', 'state', 'current_stage',
      'queue_state', 'queue_position', 'cancel_requested_at', 'cancel_reason', 'created_at', 'updated_at',
      'dispatched_at', 'runner_unit', 'runner_lease_owner', 'runner_lease_expires_at', 'runner_started_at', 'runner_finished_at',
      'container_id', 'container_name', 'container_image_digest', 'container_label_job_id', 'container_label_manifest_sha',
      'container_labels_json', 'container_mount_json', 'container_env_json', 'container_security_json', 'container_inspection_json',
      'container_created_at', 'container_started_at', 'container_stopped_at', 'container_removed_at', 'container_cleanup_outcome',
      'cleanup_generation', 'cleanup_fence_generation', 'cleanup_fence_token_hash', 'cleanup_admission_id', 'cleanup_blocker_code',
      'cleanup_blocker_json', 'terminal_error_code', 'terminal_error_json', 'terminal_at', 'artifact_staging_path',
      'artifact_quarantine_path', 'artifact_final_directory', 'artifact_final_path', 'artifact_sha256', 'artifact_size',
      'artifact_mtime', 'checksum_path', 'checksum_sha256', 'manifest_path', 'manifest_sha256', 'verification_path',
      'verification_sha256', 'publish_state', 'publish_started_at', 'published_at', 'publish_blocker_code', 'publish_blocker_json',
      'freshness_status', 'freshness_observed_sha', 'newer_source_available', 'freshness_requested_at', 'freshness_checked_at',
      'freshness_error_code', 'freshness_error_json', 'freshness_error_evidence_path', 'freshness_error_evidence_sha256',
      'source_preparation_json', 'offline_feed_preparation_json', 'artifact_quarantine_intent_path',
      'cancellation_cooperative_deadline_at', 'cancellation_escalation_owner',
      'cancellation_escalation_lease_expires_at', 'cancellation_stop_intent_at',
      'cancellation_grace_deadline_at', 'cancellation_signal_observation_json',
      'cancellation_stop_observation_json', 'cancellation_inspection_observations_json',
      'cancellation_clock_high_water_at', 'cancellation_stop_authorized_at',
      'cancellation_stop_authorized_lease_expires_at',
    ]);
    expectColumns(db, 'job_stages', [
      'job_id', 'stage', 'outcome', 'started_at', 'finished_at', 'evidence_path', 'evidence_sha256', 'error_code',
      'error_json',
    ]);
    expectColumns(db, 'job_operations', [
      'job_id', 'operation_id', 'attempt', 'argv_hash', 'argv_json', 'started_at', 'finished_at', 'container_id',
      'container_name', 'container_image_digest', 'container_label_job_id', 'container_label_manifest_sha', 'container_mount_json',
      'container_env_json', 'container_security_json', 'inspection_json', 'timed_out', 'lifecycle_phase', 'exit_code', 'signal', 'outcome', 'accepted_disposition', 'evidence_path',
      'evidence_sha256', 'error_code', 'error_json',
    ]);
    expectColumns(db, 'job_events', [
      'job_id', 'seq', 'event_type', 'state', 'stage', 'payload_json', 'at', 'stream', 'file_generation',
      'byte_offset', 'byte_length', 'partial',
    ]);
    expectColumns(db, 'cleanup_leases', [
      'admission_id', 'job_id', 'unit_name', 'owner', 'expires_at', 'status', 'credential_relative_path',
      'credential_sha256', 'fence_generation', 'fence_token_hash', 'stale_runner_unit', 'stale_runner_owner', 'stale_runner_lease_expires_at',
      'stale_state', 'stale_container_id', 'stale_container_name', 'stale_container_labels_json',
      'proof_json', 'blocker_code', 'blocker_json', 'completion_evidence_path', 'completion_evidence_sha256',
      'admitted_at', 'claim_at', 'renew_at', 'complete_at', 'handback_at', 'expired_at', 'superseded_at',
      'superseded_by_admission_id', 'predecessor_status', 'predecessor_claim_at', 'predecessor_renew_at',
      'predecessor_blocker_code', 'predecessor_blocker_json', 'stop_authorization_attempt_id', 'stop_authorization_owner',
      'stop_authorization_at', 'stop_authorization_expires_at', 'stop_authorization_state', 'unexpected_exit_json',
      'predecessor_stop_authorization_attempt_id', 'predecessor_stop_authorization_owner', 'predecessor_stop_authorization_at',
      'predecessor_stop_authorization_expires_at', 'predecessor_stop_authorization_state', 'predecessor_unexpected_exit_json',
    ]);
    expectColumns(db, 'cleanup_credential_reservations', [
      'job_id', 'admission_id', 'owner', 'credential_relative_path', 'created_at', 'expires_at',
    ]);
    expectColumns(db, 'cleanup_stop_authorizations', [
      'attempt_id', 'attempt_no', 'job_id', 'admission_id', 'request_owner', 'authorization_owner', 'authorization_at',
      'authorization_expires_at', 'unit_name', 'fence_generation', 'fence_token_hash', 'predecessor_status', 'predecessor_owner',
      'predecessor_expires_at', 'predecessor_claim_at', 'predecessor_renew_at', 'predecessor_blocker_code', 'predecessor_blocker_json',
    ]);
    expectColumns(db, 'cleanup_stop_authorization_heads', [
      'admission_id', 'job_id', 'attempt_id', 'state', 'authorization_owner', 'updated_at', 'outcome_json',
    ]);
    expectColumns(db, 'cleanup_stop_authorization_outcomes', [
      'attempt_id', 'job_id', 'admission_id', 'authorization_owner', 'outcome_state', 'unit_name', 'observed_at',
      'outcome_json', 'event_seq',
    ]);
    expectColumns(db, 'job_log_generations', [
      'job_id', 'stream', 'generation', 'path', 'started_at', 'sealed_at', 'size_bytes', 'sha256',
    ]);
    expectColumns(db, 'legacy_blocked_publish_evidence', [
      'job_id', 'artifact_staging_path', 'artifact_quarantine_path', 'artifact_final_directory',
      'artifact_final_path', 'artifact_sha256', 'artifact_size', 'artifact_mtime', 'checksum_path',
      'checksum_sha256', 'manifest_path', 'manifest_sha256', 'verification_path', 'verification_sha256',
      'publish_state', 'publish_started_at', 'published_at', 'publish_blocker_code', 'publish_blocker_json',
    ]);
    expectColumns(db, 'schema_migrations', ['version', 'filename', 'sha256', 'applied_at']);
    expectColumns(db, 'queue_entries', ['job_id', 'fifo_seq', 'enqueued_at', 'claimed_at']);
    expectColumns(db, 'job_events', [
      'job_id', 'seq', 'event_type', 'state', 'stage', 'payload_json', 'at', 'stream', 'file_generation',
      'byte_offset', 'byte_length', 'partial',
    ]);

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all()
      .map((row) => (row as { name: string }).name);
    expect(indexes.sort()).toEqual([
      'cleanup_credential_reservations_expiry', 'cleanup_credential_reservations_job_path', 'cleanup_leases_expiry', 'cleanup_leases_fence_identity', 'cleanup_leases_fence_token_identity', 'cleanup_leases_job', 'cleanup_stop_authorization_outcomes_admission', 'cleanup_stop_authorizations_admission', 'cleanup_stop_authorizations_expiry', 'job_events_cancellation_protocol', 'job_events_log_range', 'job_events_sequence', 'job_log_generations_active', 'job_operations_identity',
      'job_stages_job', 'jobs_cleanup_admission', 'jobs_recovery', 'queue_entries_fifo',
    ]);
    const normalizeForeignKeys = (child: string) => db.prepare(`PRAGMA foreign_key_list(${child})`).all()
      .map((row) => {
        const value = row as { table: string; from: string; to: string; on_delete: string; on_update: string };
        return { table: value.table, from: value.from, to: value.to, on_delete: value.on_delete, on_update: value.on_update };
      });
    expect(normalizeForeignKeys('queue_entries')).toEqual([{ table: 'jobs', from: 'job_id', to: 'job_id', on_delete: 'RESTRICT', on_update: 'RESTRICT' }]);
    expect(normalizeForeignKeys('job_stages')).toEqual([{ table: 'jobs', from: 'job_id', to: 'job_id', on_delete: 'RESTRICT', on_update: 'RESTRICT' }]);
    expect(normalizeForeignKeys('job_operations')).toEqual([{ table: 'jobs', from: 'job_id', to: 'job_id', on_delete: 'RESTRICT', on_update: 'RESTRICT' }]);
    expect(normalizeForeignKeys('cleanup_leases')).toEqual([{ table: 'jobs', from: 'job_id', to: 'job_id', on_delete: 'RESTRICT', on_update: 'RESTRICT' }]);
    expect(normalizeForeignKeys('cleanup_credential_reservations')).toEqual([{ table: 'jobs', from: 'job_id', to: 'job_id', on_delete: 'RESTRICT', on_update: 'RESTRICT' }]);
    expect(normalizeForeignKeys('cleanup_stop_authorizations').sort((a, b) => `${a.table}${a.from}`.localeCompare(`${b.table}${b.from}`))).toEqual([
      { table: 'cleanup_leases', from: 'admission_id', to: 'admission_id', on_delete: 'RESTRICT', on_update: 'RESTRICT' },
      { table: 'jobs', from: 'job_id', to: 'job_id', on_delete: 'RESTRICT', on_update: 'RESTRICT' },
    ]);
    expect(normalizeForeignKeys('cleanup_stop_authorization_heads').sort((a, b) => `${a.table}${a.from}`.localeCompare(`${b.table}${b.from}`))).toEqual([
      { table: 'cleanup_leases', from: 'admission_id', to: 'admission_id', on_delete: 'RESTRICT', on_update: 'RESTRICT' },
      { table: 'cleanup_stop_authorizations', from: 'attempt_id', to: 'attempt_id', on_delete: 'RESTRICT', on_update: 'RESTRICT' },
      { table: 'jobs', from: 'job_id', to: 'job_id', on_delete: 'RESTRICT', on_update: 'RESTRICT' },
    ]);
    expect(normalizeForeignKeys('job_log_generations')).toEqual([{ table: 'jobs', from: 'job_id', to: 'job_id', on_delete: 'RESTRICT', on_update: 'RESTRICT' }]);
    expect(normalizeForeignKeys('legacy_blocked_publish_evidence')).toEqual([{ table: 'jobs', from: 'job_id', to: 'job_id', on_delete: 'RESTRICT', on_update: 'RESTRICT' }]);
    expect(normalizeForeignKeys('job_events').sort((a, b) => `${a.table}${a.from}`.localeCompare(`${b.table}${b.from}`))).toEqual([
      { table: 'job_log_generations', from: 'file_generation', to: 'generation', on_delete: 'RESTRICT', on_update: 'RESTRICT' },
      { table: 'job_log_generations', from: 'job_id', to: 'job_id', on_delete: 'RESTRICT', on_update: 'RESTRICT' },
      { table: 'job_log_generations', from: 'stream', to: 'stream', on_delete: 'RESTRICT', on_update: 'RESTRICT' },
      { table: 'jobs', from: 'job_id', to: 'job_id', on_delete: 'RESTRICT', on_update: 'RESTRICT' },
    ]);
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()
      .map((row) => (row as { name: string }).name);
    expect(triggers.sort()).toEqual([
      'cleanup_leases_fence_delete_guard', 'cleanup_leases_fence_update_guard', 'cleanup_leases_status_guard',
      'cleanup_leases_status_guard_update', 'cleanup_leases_identity_guard', 'job_events_append_guard', 'job_events_immutable_update_guard', 'job_log_generations_append_guard',
      'cleanup_leases_admission_id_guard', 'cleanup_leases_admission_id_guard_update',
      'cleanup_credential_reservations_immutable_update_guard', 'cleanup_leases_supersession_insert_guard', 'cleanup_leases_supersession_transition_guard', 'cleanup_leases_expired_immutable_guard',
      'cleanup_stop_authorizations_immutable_update_guard', 'cleanup_stop_authorizations_identity_guard', 'cleanup_stop_authorization_heads_transition_guard', 'cleanup_stop_authorization_head_identity_guard', 'cleanup_stop_authorization_head_identity_update_guard',
      'cleanup_stop_authorization_outcomes_delete_guard', 'cleanup_stop_authorization_outcomes_identity_guard', 'cleanup_stop_authorization_outcomes_immutable_guard',
      'cleanup_leases_stop_authorization_columns_guard', 'cleanup_leases_stop_authorization_columns_update_guard', 'cleanup_leases_stop_authorization_identity_guard',
      'job_log_generations_immutable_guard', 'job_log_generations_seal_guard', 'job_log_generations_size_guard',
      'job_operations_committed_delete_guard', 'job_operations_committed_update_guard', 'job_operations_manifest_label_guard',
      'job_operations_manifest_label_guard_update', 'jobs_cleanup_generation_guard', 'jobs_container_guard',
      'legacy_blocked_publish_evidence_delete_guard', 'legacy_blocked_publish_evidence_update_guard',
      'jobs_container_guard_update', 'jobs_fence_guard', 'jobs_fence_guard_update', 'jobs_cleanup_blocker_guard',
      'jobs_cleanup_blocker_guard_update', 'jobs_freshness_evidence_pair_guard',
      'jobs_freshness_evidence_pair_guard_update', 'jobs_freshness_guard', 'jobs_freshness_guard_update',
      'jobs_freshness_null_guard', 'jobs_freshness_null_guard_update', 'jobs_freshness_timestamp_guard',
      'jobs_freshness_timestamp_guard_update', 'jobs_publish_guard', 'jobs_publish_guard_insert', 'jobs_publish_null_guard',
      'jobs_publish_null_guard_update', 'jobs_publish_pairs_guard', 'jobs_publish_pairs_guard_update',
      'jobs_request_immutable_guard', 'jobs_runner_lease_guard', 'jobs_runner_lease_guard_update',
      'jobs_offline_feed_preparation_immutable_guard', 'jobs_offline_feed_preparation_insert_guard',
      'jobs_source_preparation_immutable_guard', 'jobs_source_preparation_insert_guard', 'jobs_terminal_guard',
      'jobs_terminal_guard_update',
    ].sort());
    db.close();
  });

  it('backfills an active historical cancellation deadline without inventing escalation ownership', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    for (const migration of MIGRATION_REGISTRY.slice(0, 9)) {
      historical.exec(await readFile(join(repoMigrationDir, migration.filename), 'utf8'));
      historical.prepare('INSERT INTO schema_migrations (version, filename, sha256, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.filename, migration.sha256, '2026-07-23T00:00:00.000Z');
    }
    insertValidJob(historical, 'cancel-backfill', 'starting');
    historical.prepare(`UPDATE jobs SET
      cancel_requested_at=?, cancel_reason=?, dispatched_at=?, runner_unit=?,
      runner_lease_owner=?, runner_lease_expires_at=?
      WHERE job_id=?`).run(
      '2026-07-23T00:00:02.125Z',
      'operator',
      '2026-07-23T00:00:01.000Z',
      'osi-image-builder-runner@cancel-backfill.service',
      'runner-a',
      '2026-07-23T00:10:00.000Z',
      'cancel-backfill',
    );
    historical.close();

    const upgraded = openBuilderDatabase(path);
    expect(upgraded.prepare(`SELECT
      cancellation_cooperative_deadline_at AS deadline,
      cancellation_escalation_owner AS owner,
      cancellation_stop_intent_at AS intent,
      cancellation_grace_deadline_at AS grace,
      cancellation_clock_high_water_at AS high_water,
      cancellation_stop_authorized_at AS authorized,
      cancellation_stop_authorized_lease_expires_at AS authorized_lease
      FROM jobs WHERE job_id=?`).get('cancel-backfill')).toEqual({
      deadline: '2026-07-23T00:00:32.125Z',
      owner: null,
      intent: null,
      grace: null,
      high_water: '2026-07-23T00:00:02.125Z',
      authorized: null,
      authorized_lease: null,
    });
    expect(() => upgraded.prepare(`UPDATE jobs SET
      cancellation_escalation_owner='coordinator',
      cancellation_escalation_lease_expires_at='2026-07-23T00:00:47.125Z',
      cancellation_stop_intent_at='2026-07-23T00:00:32.125Z',
      cancellation_grace_deadline_at='2026-07-23T00:00:47.125Z',
      cancellation_stop_authorized_at='2026-07-23T00:00:32.125Z',
      cancellation_stop_authorized_lease_expires_at='2026-07-23T00:00:31.125Z'
      WHERE job_id=?`).run('cancel-backfill')).toThrow(/CHECK constraint failed/i);
    expect(upgraded.prepare(`SELECT
      cancellation_stop_authorized_at AS authorized,
      cancellation_stop_authorized_lease_expires_at AS authorized_lease
      FROM jobs WHERE job_id=?`).get('cancel-backfill')).toEqual({
      authorized: null,
      authorized_lease: null,
    });
    upgraded.close();
  });

  it('uses the selective cancellation protocol index through large unrelated event history', async () => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    insertValidJob(db, 'cancellation-protocol-index', 'starting');
    const insert = db.prepare(
      'INSERT INTO job_events (job_id, seq, event_type, state, stage, payload_json, at) VALUES (?, ?, ?, ?, NULL, ?, ?)',
    );
    db.exec('BEGIN IMMEDIATE');
    try {
      for (let seq = 0; seq < 20_000; seq += 1) {
        insert.run(
          'cancellation-protocol-index',
          seq,
          'recovery',
          'starting',
          '{"unrelated":true}',
          '2026-07-23T00:00:00.000Z',
        );
      }
      insert.run(
        'cancellation-protocol-index',
        20_000,
        'cleanup',
        'cancel_requested',
        '{"kind":"cancellation-evidence"}',
        '2026-07-23T00:00:01.000Z',
      );
      insert.run(
        'cancellation-protocol-index',
        20_001,
        'cleanup',
        'cancel_requested',
        '{"kind":"cancellation-cleanup"}',
        '2026-07-23T00:00:02.000Z',
      );
      for (let seq = 20_002; seq < 40_002; seq += 1) {
        insert.run(
          'cancellation-protocol-index',
          seq,
          'recovery',
          'cancel_requested',
          '{"unrelated":true}',
          '2026-07-23T00:00:02.000Z',
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const plan = db.prepare(
      `EXPLAIN QUERY PLAN ${CANCELLATION_PROTOCOL_EVENT_QUERY}`,
    ).all(
      'cancellation-protocol-index',
    ) as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join('\n')).toMatch(
      /USING INDEX job_events_cancellation_protocol/u,
    );
    expect(plan.map((row) => row.detail).join('\n')).not.toMatch(
      /USE TEMP B-TREE/u,
    );
    expect(new BuilderStore(db).getCancellationProtocolEvents(
      'cancellation-protocol-index',
    ).map((event) => event.payload.kind)).toEqual([
      'cancellation-evidence',
      'cancellation-cleanup',
    ]);
    db.close();
  });

  it('is idempotent and keeps the final schema identical across a restart', async () => {
    const path = await temporaryDatabase();
    const first = openBuilderDatabase(path);
    const schema = first.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
      .all();
    first.close();

    const second = openBuilderDatabase(path);
    expect(second.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all())
      .toEqual(schema);
    expect(second.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 12 });
    second.close();
  });

  it('rejects migration drift and unknown files before changing existing jobs', async () => {
    const path = await temporaryDatabase();
    const migrationDir = await copyMigrations();
    const db = openBuilderDatabase(path, { migrationsDirectory: migrationDir });
    db.prepare(`INSERT INTO jobs (
      job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id,
      target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at,
      source_preparation_json, offline_feed_preparation_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'job-existing', 'request-existing', 'git@example:repo.git', 'refs/remotes/origin/main', 'main', 'main', 'a'.repeat(40), 'a'.repeat(40),
      'rpi-5', 'release', 'b'.repeat(64), '2026-07-23T00:00:00.000Z', 'author', 'subject', '2026-07-23T00:00:00.000Z', 'queued', 'queued', '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z',
      sourcePreparationJson(), offlineFeedPreparationJson('job-existing'),
    );
    db.close();

    await writeFile(join(migrationDir, '003_freshness_and_logs.sql'), `${await readFile(join(migrationDir, '003_freshness_and_logs.sql'), 'utf8')}\n-- drift\n`);
    expect(() => openBuilderDatabase(path, { migrationsDirectory: migrationDir })).toThrow(/migration checksum drift: 003_freshness_and_logs\.sql/);
    const unchanged = new DatabaseSync(path);
    expect(unchanged.prepare('SELECT job_id, state FROM jobs').all()).toEqual([{ job_id: 'job-existing', state: 'queued' }]);
    unchanged.close();

    const unknownDir = await copyMigrations();
    await writeFile(join(unknownDir, '005_unknown.sql'), 'CREATE TABLE should_not_exist (id INTEGER);');
    expect(() => openBuilderDatabase(path, { migrationsDirectory: unknownDir })).toThrow(/unknown migration file: 005_unknown\.sql/);
    const afterUnknown = new DatabaseSync(path);
    expect(afterUnknown.prepare("SELECT name FROM sqlite_master WHERE name='should_not_exist'").get()).toBeUndefined();
    afterUnknown.close();

    const unexpectedLikeDir = await copyMigrations();
    await writeFile(join(unexpectedLikeDir, '001_initial.sql.bak'), 'unexpected');
    expect(() => openBuilderDatabase(path, { migrationsDirectory: unexpectedLikeDir })).toThrow(/unknown migration file: 001_initial\.sql\.bak/);

    const symlinkDir = await copyMigrations();
    await rm(join(symlinkDir, '001_initial.sql'));
    await symlink('/etc/hosts', join(symlinkDir, '001_initial.sql'));
    expect(() => openBuilderDatabase(path, { migrationsDirectory: symlinkDir })).toThrow(/migration directory contains a non-regular migration entry/);
  });

  it('rejects live schema drift before a valid job can be mutated', async () => {
    const triggerPath = await temporaryDatabase();
    const triggerDb = openBuilderDatabase(triggerPath);
    insertValidJob(triggerDb, 'drift-trigger');
    triggerDb.close();
    const triggerTamper = new DatabaseSync(triggerPath);
    triggerTamper.exec('DROP TRIGGER jobs_container_guard');
    triggerTamper.close();
    expectMigrationError(() => openBuilderDatabase(triggerPath), /live schema drift detected/);
    const triggerCheck = new DatabaseSync(triggerPath);
    expect(triggerCheck.prepare("SELECT job_id FROM jobs WHERE job_id='drift-trigger'").get()).toEqual({ job_id: 'drift-trigger' });
    triggerCheck.close();

    const foreignKeyPath = await temporaryDatabase();
    const foreignKeyDb = openBuilderDatabase(foreignKeyPath);
    insertValidJob(foreignKeyDb, 'drift-fk');
    foreignKeyDb.close();
    const foreignKeyTamper = new DatabaseSync(foreignKeyPath);
    foreignKeyTamper.exec('PRAGMA foreign_keys=OFF; DROP TABLE queue_entries; CREATE TABLE queue_entries (job_id TEXT PRIMARY KEY, fifo_seq INTEGER NOT NULL UNIQUE, enqueued_at TEXT NOT NULL, claimed_at TEXT); PRAGMA foreign_keys=ON;');
    foreignKeyTamper.close();
    expectMigrationError(() => openBuilderDatabase(foreignKeyPath), /live schema drift detected/);
    const foreignKeyCheck = new DatabaseSync(foreignKeyPath);
    expect(foreignKeyCheck.prepare("SELECT job_id FROM jobs WHERE job_id='drift-fk'").get()).toEqual({ job_id: 'drift-fk' });
    foreignKeyCheck.close();
  });

  it('rejects unknown, gapped, reordered, or checksum-mismatched applied versions before applying pending SQL', async () => {
    const cases = [
      { name: 'unknown', rows: [[99, '099_unknown.sql', 'a'.repeat(64)]] },
      { name: 'gap', rows: [[1, '001_initial.sql', MIGRATION_REGISTRY[0].sha256], [3, '003_freshness_and_logs.sql', MIGRATION_REGISTRY[2].sha256]] },
      { name: 'missing-prefix', rows: [[2, '002_recovery.sql', MIGRATION_REGISTRY[1].sha256]] },
      { name: 'checksum', rows: [[1, '001_initial.sql', 'b'.repeat(64)]] },
    ];
    for (const testCase of cases) {
      const path = await temporaryDatabase();
      const db = new DatabaseSync(path);
      db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, filename TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL);`);
      for (const row of testCase.rows) db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)').run(...row, '2026-07-23T00:00:00.000Z');
      db.close();
      const expectedError = {
        unknown: /unknown applied migration version/,
        gap: /migration versions are gapped or reordered/,
        'missing-prefix': /migration versions are gapped or reordered/,
        checksum: /applied migration checksum drift: 001_initial\.sql/,
      }[testCase.name];
      expect(expectedError).toBeDefined();
      expect(() => openBuilderDatabase(path)).toThrow(expectedError);
      const checkDb = new DatabaseSync(path);
      expect(checkDb.prepare("SELECT name FROM sqlite_master WHERE name='jobs'").get()).toBeUndefined();
      checkDb.close();
    }

    const physicalOrderPath = await temporaryDatabase();
    const physicalOrderDb = new DatabaseSync(physicalOrderPath);
    physicalOrderDb.exec(await readFile(join(repoMigrationDir, '001_initial.sql'), 'utf8'));
    physicalOrderDb.exec(await readFile(join(repoMigrationDir, '002_recovery.sql'), 'utf8'));
    physicalOrderDb.exec('DELETE FROM schema_migrations');
    physicalOrderDb.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)').run(2, '002_recovery.sql', MIGRATION_REGISTRY[1].sha256, 'x');
    physicalOrderDb.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)').run(1, '001_initial.sql', MIGRATION_REGISTRY[0].sha256, 'x');
    physicalOrderDb.close();
    const accepted = openBuilderDatabase(physicalOrderPath);
    expect(accepted.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 12 });
    accepted.close();
  });

  it('rolls back a pending migration without changing an existing job', async () => {
    const path = await temporaryDatabase();
    const migrationDir = await copyMigrations();
    const db = new DatabaseSync(path);
    db.exec((await readFile(join(migrationDir, '001_initial.sql',), 'utf8')));
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)').run(1, '001_initial.sql', MIGRATION_REGISTRY[0].sha256, '2026-07-23T00:00:00.000Z');
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'keep', 'request-keep', 'git@example:repo.git', 'refs/remotes/origin/main', 'main', 'main', 'a'.repeat(40), 'a'.repeat(40), 'rpi-5', 'release', 'b'.repeat(64), 'x', 'author', 'subject', 'x', 'queued', 'queued', 'x', 'x',
    );
    db.close();
    expectMigrationError(
      () => openBuilderDatabase(path, { migrationsDirectory: migrationDir, now: () => { throw new Error('clock failure'); } }),
      /migration 002_recovery.sql failed/,
      /clock failure/,
    );
    const unchanged = new DatabaseSync(path);
    expect(unchanged.prepare('SELECT job_id, state FROM jobs').all()).toEqual([{ job_id: 'keep', state: 'queued' }]);
    expect(unchanged.prepare("SELECT name FROM pragma_table_info('jobs') WHERE name='runner_unit'").get()).toBeUndefined();
    unchanged.close();
  });

  it('preserves filesystem causes in startup migration errors', async () => {
    const path = await temporaryDatabase();
    const missingDirectory = join(dirname(path), 'missing-migrations');
    expectMigrationError(() => openBuilderDatabase(path, { migrationsDirectory: missingDirectory }), /cannot read migration files/, /ENOENT|no such file/i);
  });

  it('preserves SQLite causes for malformed ledger and startup probe failures', async () => {
    const malformedPath = await temporaryDatabase();
    const malformed = new DatabaseSync(malformedPath);
    malformed.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);');
    malformed.close();
    expectMigrationError(() => openBuilderDatabase(malformedPath), /invalid schema_migrations table/, /no such column: filename/);

    const pragmaPath = await temporaryDatabase();
    const originalPrepare = DatabaseSync.prototype.prepare;
    const pragmaSpy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === 'PRAGMA foreign_keys') throw new Error('foreign-key pragma probe failed');
      return originalPrepare.call(this, sql);
    });
    try {
      expectMigrationError(() => openBuilderDatabase(pragmaPath), /SQLite pragma configuration failed/, /foreign-key pragma probe failed/);
    } finally {
      pragmaSpy.mockRestore();
    }

    const schemaPath = await temporaryDatabase();
    const schemaDb = openBuilderDatabase(schemaPath);
    schemaDb.close();
    const schemaSpy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('SELECT type, name, sql FROM sqlite_schema')) throw new Error('schema fingerprint query failed');
      return originalPrepare.call(this, sql);
    });
    try {
      expectMigrationError(() => openBuilderDatabase(schemaPath), /schema validation failed/, /schema fingerprint query failed/);
    } finally {
      schemaSpy.mockRestore();
    }
  });

  it('preserves primary schema failures when canonical close also fails', async () => {
    const closeOnlyPath = await temporaryDatabase();
    const closeSpy = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(() => {
      throw new Error('canonical close failed');
    });
    try {
      expectMigrationError(() => openBuilderDatabase(closeOnlyPath), /schema validation close failed/, /canonical close failed/);
    } finally {
      closeSpy.mockRestore();
    }

    const validationPath = await temporaryDatabase();
    const valid = openBuilderDatabase(validationPath);
    valid.close();
    const originalPrepare = DatabaseSync.prototype.prepare;
    const originalCause = new Error('retained primary cause');
    const primaryError = new MigrationError('retained primary validation failure', { cause: originalCause });
    const combinedPrepareSpy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('SELECT type, name, sql FROM sqlite_schema')) throw primaryError;
      return originalPrepare.call(this, sql);
    });
    const closeError = new Error('secondary canonical close failed');
    const combinedCloseSpy = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(() => { throw closeError; });
    let error: unknown;
    try {
      openBuilderDatabase(validationPath);
    } catch (caught) {
      error = caught;
    } finally {
      combinedPrepareSpy.mockRestore();
      combinedCloseSpy.mockRestore();
    }
    expect(error).toBe(primaryError);
    expect((error as MigrationError).message).toBe('retained primary validation failure');
    expect((error as MigrationError).cause).toBe(originalCause);
    expect((error as MigrationError).closeCause).toBe(closeError);
  });

  it('enforces foreign keys, domain enums, hashes, ranges, event sequences, and log ranges', async () => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    const job = ['job-1', 'req-1', 'git@example:repo.git', 'refs/remotes/origin/main', 'main', 'main', 'a'.repeat(40), 'a'.repeat(40), 'rpi-5', 'release', 'b'.repeat(64), '2026-07-23T00:00:00.000Z', 'author', 'subject', '2026-07-23T00:00:00.000Z', 'queued', 'queued', '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z'] as const;
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...job, sourcePreparationJson(), offlineFeedPreparationJson('job-1'));
    db.prepare('INSERT INTO queue_entries (job_id, fifo_seq, enqueued_at) VALUES (?, ?, ?)').run('job-1', 0, job[17]);
    check(db, "INSERT INTO queue_entries VALUES ('unknown', 1, 'x', NULL)", /FOREIGN KEY constraint failed/);
    insertValidJob(db, 'bad-state');
    check(db, "UPDATE jobs SET state='not-a-state' WHERE job_id='bad-state'", /CHECK constraint failed: state IN/);
    check(db, "UPDATE jobs SET cleanup_fence_generation=-1 WHERE job_id='job-1'", /invalid cleanup fence/);
    check(db, "UPDATE jobs SET pinned_sha='A' WHERE job_id='job-1'", /accepted job identity is immutable/);
    db.prepare(`INSERT INTO job_events (job_id, seq, event_type, state, payload_json, at) VALUES (?, ?, ?, ?, ?, ?)`).run('job-1', 0, 'state', 'queued', '{}', job[11]);
    check(db, "INSERT INTO job_events (job_id, seq, event_type, state, payload_json, at) VALUES ('job-1', 0, 'state', 'queued', '{}', 'x')", /job events must append within an open log generation/);
    check(db, "INSERT INTO job_events (job_id, seq, event_type, state, payload_json, at, stream) VALUES ('job-1', 1, 'log', 'queued', '{}', 'x', 'runner')", /CHECK constraint failed/);
    db.prepare(`INSERT INTO job_log_generations (job_id, stream, generation, path, started_at) VALUES ('job-1', 'runner', 0, 'logs/runner.0', 'x')`).run();
    db.prepare("UPDATE job_log_generations SET size_bytes=5 WHERE job_id='job-1' AND stream='runner' AND generation=0").run();
    db.prepare(`INSERT INTO job_events (job_id, seq, event_type, state, payload_json, at, stream, file_generation, byte_offset, byte_length, partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('job-1', 1, 'log', 'queued', '{}', job[11], 'runner', 0, 0, 5, 0);
    check(db, "INSERT INTO job_events (job_id, seq, event_type, state, payload_json, at, stream, file_generation, byte_offset, byte_length, partial) VALUES ('job-1', 2, 'state', 'queued', '{}', 'x', 'runner', 0, 0, 1, 0)", /job events must append within an open log generation/);
    expect(() => db.prepare("DELETE FROM jobs WHERE job_id='job-1'").run()).toThrow(/FOREIGN KEY constraint failed/);
    db.close();
  });

  it('keeps committed operation evidence immutable while allowing an uncommitted result to be completed', async () => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    insertValidJob(db, 'job-1', 'building');
    db.prepare(`INSERT INTO job_operations (job_id, operation_id, attempt, argv_hash, argv_json, started_at) VALUES ('job-1', 'verify-image', 1, '${'a'.repeat(64)}', '[]', 'x')`).run();
    check(db, "UPDATE job_operations SET container_id='cid', container_name='builder', container_image_digest='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', container_label_job_id='job-1', container_label_manifest_sha='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', container_mount_json='{}', container_env_json='{}', container_security_json='{}', inspection_json='{}', lifecycle_phase='started', exit_code=0, outcome='passed', finished_at='y', evidence_path='e', evidence_sha256='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' WHERE job_id='job-1' AND operation_id='verify-image' AND attempt=1", /operation Docker manifest label is invalid/);
    db.prepare(`INSERT INTO job_operations (job_id, operation_id, attempt, argv_hash, argv_json, started_at, outcome) VALUES ('job-1', 'build-image', 1, '${'a'.repeat(64)}', '["make"]', 'x', NULL)`).run();
    db.prepare(`UPDATE job_operations SET container_id='cid', container_name='builder', container_image_digest='${'c'.repeat(64)}', container_label_job_id='job-1', container_label_manifest_sha='${'b'.repeat(64)}', container_mount_json='{}', container_env_json='{}', container_security_json='{}', inspection_json='{}', lifecycle_phase='started', exit_code=0, outcome='passed', finished_at='y', evidence_path='evidence/build.json', evidence_sha256='${'b'.repeat(64)}' WHERE job_id='job-1' AND operation_id='build-image' AND attempt=1`).run();
    check(db, "UPDATE job_operations SET evidence_path='changed' WHERE job_id='job-1' AND operation_id='build-image' AND attempt=1", /committed operation evidence is immutable/);
    check(db, "DELETE FROM job_operations WHERE job_id='job-1' AND operation_id='build-image' AND attempt=1", /committed operation evidence is immutable/);
    db.close();
  });

  it('keeps a migrated legacy job history-visible but rejects FIFO dispatch without authoritative preparation', async () => {
    const partialPath = await temporaryDatabase();
    const freshPath = await temporaryDatabase();
    const migrationDir = await copyMigrations();
    const partial = new DatabaseSync(partialPath);
    partial.exec(await readFile(join(migrationDir, '001_initial.sql'), 'utf8'));
    partial.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)').run(1, '001_initial.sql', MIGRATION_REGISTRY[0].sha256, '2026-07-23T00:00:00.000Z');
    partial.prepare(`INSERT INTO jobs (
      job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id,
      target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'preserve-me', 'request-preserve-me', 'git@example:repo.git', 'refs/remotes/origin/main', 'main', 'main', SHA40, SHA40,
      'rpi-5', 'release', HASH64, '2026-07-23T00:00:00.000Z', 'author', 'subject', '2026-07-23T00:00:00.000Z',
      'queued', 'queued', '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z',
    );
    partial.close();

    const upgraded = openBuilderDatabase(partialPath, { migrationsDirectory: migrationDir });
    const fresh = openBuilderDatabase(freshPath, { migrationsDirectory: migrationDir });
    expect(schemaSnapshot(upgraded)).toEqual(schemaSnapshot(fresh));
    const store = new BuilderStore(upgraded);
    expect(store.getJob('preserve-me')).toMatchObject({
      jobId: 'preserve-me',
      state: 'queued',
      sourceRunnable: false,
      sourcePreparation: null,
      offlineFeedPreparation: null,
    });
    const ownership = new OwnershipStore(upgraded, {
      now: () => '2026-07-23T00:00:00.000Z',
    });
    expect(ownership.apiWrite({
      kind: 'dispatch',
      jobId: 'preserve-me',
      runnerUnit: 'osi-image-builder-runner@preserve-me.service',
      at: '2026-07-23T00:00:00.000Z',
    })).toMatchObject({
      ok: false,
      conflict: { kind: 'stale-predecessor' },
    });
    expect(store.getJob('preserve-me')).toMatchObject({
      state: 'queued',
      queueState: 'queued',
      sourceRunnable: false,
    });
    store.close();
    fresh.close();
  });

  it('upgrades an exact historical v6 database without losing legacy blocked publish evidence', async () => {
    expect(MIGRATION_REGISTRY[5]).toMatchObject({
      version: 6,
      filename: '006_blocked_publish_artifact_location.sql',
      sha256: HISTORICAL_V6_SHA256,
    });

    const path = await temporaryDatabase();
    const freshPath = await temporaryDatabase();
    const migrationDir = await copyMigrations();
    const legacy = new DatabaseSync(path);
    for (const migration of MIGRATION_REGISTRY.slice(0, 5)) {
      legacy.exec(await readFile(join(migrationDir, migration.filename), 'utf8'));
      legacy.prepare(
        'INSERT INTO schema_migrations (version, filename, sha256, applied_at) VALUES (?, ?, ?, ?)',
      ).run(
        migration.version,
        migration.filename,
        migration.sha256,
        '2026-07-23T00:00:00.000Z',
      );
    }
    const terminalSentinel = '{"legacy_publish":{"sentinel":"keep"},"terminal":"preserved"}';
    insertValidJob(legacy, 'legacy-terminal');
    legacy.prepare(`
      UPDATE jobs
      SET state='failed',
          queue_state='complete',
          publish_state='blocked',
          publish_blocker_code='PUBLISH_FAILED',
          publish_blocker_json='{"legacy":"terminal"}',
          terminal_at='2026-07-23T00:01:00.000Z',
          terminal_error_code='PUBLISH_FAILED',
          terminal_error_json=?
      WHERE job_id='legacy-terminal'
    `).run(terminalSentinel);
    insertValidJob(legacy, 'legacy-nonterminal');
    legacy.prepare(`
      UPDATE jobs
      SET state='building',
          queue_state='dispatched',
          artifact_staging_path='legacy/staging/image.gz',
          publish_state='blocked',
          publish_blocker_code='PUBLISH_FAILED',
          publish_blocker_json='{"legacy":"nonterminal"}'
      WHERE job_id='legacy-nonterminal'
    `).run();
    const historicalV6 = MIGRATION_REGISTRY[5]!;
    legacy.exec(await readFile(join(migrationDir, historicalV6.filename), 'utf8'));
    legacy.prepare(
      'INSERT INTO schema_migrations (version, filename, sha256, applied_at) VALUES (?, ?, ?, ?)',
    ).run(6, historicalV6.filename, HISTORICAL_V6_SHA256, '2026-07-23T00:00:00.000Z');
    legacy.close();

    const upgraded = openBuilderDatabase(path, { migrationsDirectory: migrationDir });
    const fresh = openBuilderDatabase(freshPath, { migrationsDirectory: migrationDir });
    expect(schemaSnapshot(upgraded)).toEqual(schemaSnapshot(fresh));

    const rows = upgraded.prepare(`
      SELECT job_id, state, publish_state, artifact_staging_path, publish_blocker_code,
             publish_blocker_json, terminal_at, terminal_error_code, terminal_error_json
      FROM jobs
      WHERE job_id IN ('legacy-nonterminal', 'legacy-terminal')
      ORDER BY job_id
    `).all() as Array<Record<string, string | null>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      job_id: 'legacy-nonterminal',
      state: 'building',
      publish_state: 'not_started',
      artifact_staging_path: null,
      publish_blocker_code: null,
      publish_blocker_json: null,
      terminal_at: null,
      terminal_error_code: null,
      terminal_error_json: null,
    });
    expect(rows[1]).toMatchObject({
      job_id: 'legacy-terminal',
      state: 'failed',
      publish_state: 'not_started',
      artifact_staging_path: null,
      publish_blocker_code: null,
      publish_blocker_json: null,
      terminal_at: '2026-07-23T00:01:00.000Z',
      terminal_error_code: 'PUBLISH_FAILED',
      terminal_error_json: terminalSentinel,
    });

    const archiveRows = upgraded.prepare(
      'SELECT * FROM legacy_blocked_publish_evidence ORDER BY job_id',
    ).all() as Array<Record<string, string | number | null>>;
    expect(archiveRows).toEqual([
      {
        job_id: 'legacy-nonterminal',
        artifact_staging_path: 'legacy/staging/image.gz',
        artifact_quarantine_path: null,
        artifact_final_directory: null,
        artifact_final_path: null,
        artifact_sha256: null,
        artifact_size: null,
        artifact_mtime: null,
        checksum_path: null,
        checksum_sha256: null,
        manifest_path: null,
        manifest_sha256: null,
        verification_path: null,
        verification_sha256: null,
        publish_state: 'blocked',
        publish_started_at: null,
        published_at: null,
        publish_blocker_code: 'PUBLISH_FAILED',
        publish_blocker_json: '{"legacy":"nonterminal"}',
      },
      {
        job_id: 'legacy-terminal',
        artifact_staging_path: null,
        artifact_quarantine_path: null,
        artifact_final_directory: null,
        artifact_final_path: null,
        artifact_sha256: null,
        artifact_size: null,
        artifact_mtime: null,
        checksum_path: null,
        checksum_sha256: null,
        manifest_path: null,
        manifest_sha256: null,
        verification_path: null,
        verification_sha256: null,
        publish_state: 'blocked',
        publish_started_at: null,
        published_at: null,
        publish_blocker_code: 'PUBLISH_FAILED',
        publish_blocker_json: '{"legacy":"terminal"}',
      },
    ]);
    check(
      upgraded,
      "INSERT INTO legacy_blocked_publish_evidence SELECT * FROM legacy_blocked_publish_evidence WHERE job_id='legacy-terminal'",
      /UNIQUE constraint failed: legacy_blocked_publish_evidence\.job_id/,
    );
    check(
      upgraded,
      "UPDATE legacy_blocked_publish_evidence SET publish_blocker_code='changed' WHERE job_id='legacy-terminal'",
      /legacy blocked publish evidence is immutable/,
    );
    check(
      upgraded,
      "DELETE FROM legacy_blocked_publish_evidence WHERE job_id='legacy-terminal'",
      /legacy blocked publish evidence is immutable/,
    );
    upgraded.close();
    fresh.close();

    const reopened = openBuilderDatabase(path, { migrationsDirectory: migrationDir });
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 12 });
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM legacy_blocked_publish_evidence').get()).toEqual({ count: 2 });
    expect(reopened.prepare("SELECT terminal_error_json FROM jobs WHERE job_id='legacy-terminal'").get())
      .toEqual({ terminal_error_json: terminalSentinel });
    reopened.close();
  });

  it('normalizes legacy blocked publish rows that have no tracked artifact', async () => {
    const path = await temporaryDatabase();
    const migrationDir = await copyMigrations();
    const legacy = new DatabaseSync(path);
    for (const migration of MIGRATION_REGISTRY.slice(0, 5)) {
      legacy.exec(await readFile(join(migrationDir, migration.filename), 'utf8'));
      legacy.prepare(
        'INSERT INTO schema_migrations (version, filename, sha256, applied_at) VALUES (?, ?, ?, ?)',
      ).run(
        migration.version,
        migration.filename,
        migration.sha256,
        '2026-07-23T00:00:00.000Z',
      );
    }
    insertValidJob(legacy, 'legacy-blocked');
    legacy.prepare(`
      UPDATE jobs
      SET state='failed',
          queue_state='complete',
          publish_state='blocked',
          publish_blocker_code='PUBLISH_FAILED',
          publish_blocker_json='{"legacy":true}',
          terminal_at='2026-07-23T00:01:00.000Z',
          terminal_error_code='PUBLISH_FAILED',
          terminal_error_json='{"legacy":true}'
      WHERE job_id='legacy-blocked'
    `).run();
    legacy.close();

    const upgraded = openBuilderDatabase(path, { migrationsDirectory: migrationDir });
    const store = new BuilderStore(upgraded);
    expect(store.getJob('legacy-blocked')).toMatchObject({
      state: 'failed',
      publishState: 'not_started',
      artifactStagingPath: null,
      artifactQuarantinePath: null,
      publishBlockerCode: null,
      publishBlocker: null,
      terminalErrorCode: 'PUBLISH_FAILED',
    });
    expect(upgraded.prepare(`
      SELECT job_id, publish_state, publish_blocker_code, publish_blocker_json
      FROM legacy_blocked_publish_evidence
    `).get()).toEqual({
      job_id: 'legacy-blocked',
      publish_state: 'blocked',
      publish_blocker_code: 'PUBLISH_FAILED',
      publish_blocker_json: '{"legacy":true}',
    });
    expect(upgraded.prepare("SELECT terminal_error_json FROM jobs WHERE job_id='legacy-blocked'").get())
      .toEqual({ terminal_error_json: '{"legacy":true}' });
    store.close();
  });

  it('preserves a v7 legacy null preparation state for compatible artifact completion', async () => {
    const path = await temporaryDatabase();
    const migrationDir = await copyMigrations();
    const legacy = new DatabaseSync(path);
    for (const migration of MIGRATION_REGISTRY.slice(0, 7)) {
      legacy.exec(await readFile(join(migrationDir, migration.filename), 'utf8'));
      legacy.prepare(
        'INSERT INTO schema_migrations (version, filename, sha256, applied_at) VALUES (?, ?, ?, ?)',
      ).run(
        migration.version,
        migration.filename,
        migration.sha256,
        '2026-07-23T00:00:00.000Z',
      );
    }
    insertValidJob(legacy, 'legacy-null-preparation', 'verifying');
    legacy.prepare(
      "UPDATE jobs SET publish_state='not_started' WHERE job_id='legacy-null-preparation'",
    ).run();
    legacy.close();

    const upgraded = openBuilderDatabase(path, { migrationsDirectory: migrationDir });
    const store = new BuilderStore(upgraded);
    expect(store.getJob('legacy-null-preparation')).toMatchObject({
      state: 'verifying',
      publishState: 'not_started',
      artifactStagingPath: null,
      artifactSha256: null,
      artifactSize: null,
      checksumPath: null,
      manifestPath: null,
      verificationPath: null,
    });
    expect(upgraded.prepare(
      "SELECT COUNT(*) AS count FROM schema_migrations WHERE version=8",
    ).get()).toEqual({ count: 1 });
    store.close();
  });

  it('enforces cleanup generations, exact admissions, lease status evidence, and cross-table fences', async () => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    insertValidJob(db);
    insertAdmittedLease(db);
    db.prepare(`UPDATE jobs SET cleanup_generation=1, cleanup_fence_generation=1, cleanup_fence_token_hash=?, cleanup_admission_id=? WHERE job_id=?`).run('c'.repeat(64), ADMISSION_ID, 'job-valid');
    check(db, "UPDATE jobs SET cleanup_generation=2, cleanup_fence_generation=1 WHERE job_id='job-valid'", /invalid cleanup fence/);
    check(db, "UPDATE jobs SET cleanup_generation=2, cleanup_fence_generation=2 WHERE job_id='job-valid'", /invalid cleanup fence/);
    check(db, "UPDATE jobs SET cleanup_fence_generation=NULL WHERE job_id='job-valid'", /invalid cleanup fence/);
    db.prepare("UPDATE jobs SET cleanup_fence_generation=NULL, cleanup_fence_token_hash=NULL, cleanup_admission_id=NULL WHERE job_id='job-valid'").run();
    check(db, "UPDATE jobs SET cleanup_generation=0 WHERE job_id='job-valid'", /cleanup generation is monotonic/);
    db.prepare("UPDATE jobs SET cleanup_generation=1, cleanup_fence_generation=1, cleanup_fence_token_hash=?, cleanup_admission_id=? WHERE job_id='job-valid'").run('c'.repeat(64), ADMISSION_ID);
    check(db, "UPDATE jobs SET cleanup_fence_token_hash=NULL WHERE job_id='job-valid'", /invalid cleanup fence/);
    check(db, `INSERT INTO cleanup_leases (admission_id, job_id, unit_name, owner, expires_at, status, credential_relative_path, credential_sha256, fence_generation, fence_token_hash, proof_json, admitted_at) VALUES ('cln_iiiiiiiiiiiiiiiiiiiiiiiiii', 'job-valid', 'osi-image-builder-cleanup@cln_iiiiiiiiiiiiiiiiiiiiiiiiii.service', 'x', 'x', 'admitted', 'recovery/cleanup-credentials/cln_iiiiiiiiiiiiiiiiiiiiiiiiii.token', '${HASH64}', 2, '${'e'.repeat(64)}', '{}', 'x')`, /lowercase ULID|CHECK constraint failed/);
    check(db, `INSERT INTO cleanup_leases (admission_id, job_id, unit_name, owner, expires_at, status, credential_relative_path, credential_sha256, fence_generation, fence_token_hash, proof_json, admitted_at) VALUES ('cln_0${'b'.repeat(25)}', 'job-valid', 'osi-image-builder-cleanup@cln_0${'b'.repeat(25)}.service', 'x', 'x', 'failed', 'recovery/cleanup-credentials/cln_0${'b'.repeat(25)}.token', '${HASH64}', 2, '${'e'.repeat(64)}', '{}', 'x')`, /CHECK constraint failed/);
    db.prepare(`UPDATE cleanup_leases SET status='claimed', claim_at='2026-07-23T00:10:00.000Z' WHERE admission_id=?`).run(ADMISSION_ID);
    check(db, `UPDATE cleanup_leases SET status='failed', complete_at='2026-07-23T00:15:00.000Z', blocker_code='BUILD_FAILED', blocker_json='{}' WHERE admission_id='${ADMISSION_ID}'`, /CHECK constraint failed/);
    db.prepare(`UPDATE cleanup_leases SET status='completed', complete_at='2026-07-23T00:20:00.000Z', completion_evidence_path='evidence/cleanup.json', completion_evidence_sha256=? WHERE admission_id=?`).run(HASH64, ADMISSION_ID);
    db.prepare(`UPDATE jobs SET cleanup_fence_generation=NULL, cleanup_fence_token_hash=NULL, cleanup_admission_id=NULL WHERE job_id=?`).run('job-valid');
    db.prepare(`UPDATE cleanup_leases SET status='handed_back', handback_at='2026-07-23T00:30:00.000Z' WHERE admission_id=?`).run(ADMISSION_ID);
    check(db, `INSERT INTO cleanup_leases (admission_id, job_id, unit_name, owner, expires_at, status, credential_relative_path, credential_sha256, fence_generation, fence_token_hash, proof_json, admitted_at) VALUES ('cln_0${'b'.repeat(25)}', 'job-valid', 'osi-image-builder-cleanup@cln_0${'b'.repeat(25)}.service', 'x', 'x', 'admitted', 'recovery/cleanup-credentials/cln_0${'b'.repeat(25)}.token', '${HASH64}', 1, '${'d'.repeat(64)}', '{}', 'x')`, /UNIQUE constraint failed: cleanup_leases\.job_id, cleanup_leases\.fence_generation/);
    check(db, `INSERT INTO cleanup_leases (admission_id, job_id, unit_name, owner, expires_at, status, credential_relative_path, credential_sha256, fence_generation, fence_token_hash, proof_json, admitted_at) VALUES ('cln_0${'c'.repeat(25)}', 'job-valid', 'osi-image-builder-cleanup@cln_0${'c'.repeat(25)}.service', 'x', 'x', 'admitted', 'recovery/cleanup-credentials/cln_0${'c'.repeat(25)}.token', '${HASH64}', 2, '${'c'.repeat(64)}', '{}', 'x')`, /UNIQUE constraint failed: cleanup_leases\.job_id, cleanup_leases\.fence_token_hash/);
    check(db, "UPDATE jobs SET cleanup_generation=0 WHERE job_id='job-valid'", /cleanup generation is monotonic/);
    db.prepare("UPDATE jobs SET cleanup_generation=2 WHERE job_id='job-valid'").run();
    check(db, "UPDATE jobs SET cleanup_generation=1 WHERE job_id='job-valid'", /cleanup generation is monotonic/);
    expect(db.prepare('SELECT status, handback_at FROM cleanup_leases WHERE admission_id=?').get(ADMISSION_ID)).toMatchObject({ status: 'handed_back' });
    db.close();
  });

  it('rejects forged supersession evidence and freezes a coherent expired predecessor', async () => {
    const probe = async (write: (db: DatabaseSync) => void): Promise<void> => {
      const path = await temporaryDatabase();
      const db = openBuilderDatabase(path);
      insertValidJob(db);
      insertAdmittedLease(db);
      expect(() => write(db)).toThrow();
      db.close();
    };
    await probe((db) => db.prepare(`INSERT INTO cleanup_leases (
      admission_id, job_id, unit_name, owner, expires_at, status, credential_relative_path, credential_sha256,
      fence_generation, fence_token_hash, proof_json, admitted_at
    ) VALUES (?, 'job-valid', ?, 'builder', ?, 'expired', ?, ?, 1, ?, '{}', ?)`).run(
      'cln_0' + 'b'.repeat(25),
      'osi-image-builder-cleanup@cln_0' + 'b'.repeat(25) + '.service',
      '2026-07-23T01:00:00.000Z',
      'recovery/cleanup-credentials/cln_0' + 'b'.repeat(25) + '.token',
      HASH64,
      'd'.repeat(64),
      '2026-07-23T00:00:00.000Z',
    ));
    await probe((db) => db.prepare('UPDATE cleanup_leases SET expired_at=? WHERE admission_id=?').run('2026-07-23T00:01:00.000Z', ADMISSION_ID));
    await probe((db) => db.prepare(`UPDATE cleanup_leases SET status='expired', expired_at=?, superseded_at=?, superseded_by_admission_id=?, predecessor_status=? WHERE admission_id=?`).run(
      '2026-07-23T00:01:00.000Z', '2026-07-23T00:01:00.000Z', 'cln_0' + 'b'.repeat(25), 'admitted', ADMISSION_ID,
    ));

    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    insertValidJob(db);
    insertAdmittedLease(db);
    db.prepare("UPDATE cleanup_leases SET status='claimed', claim_at='2026-07-23T00:10:00.000Z' WHERE admission_id=?").run(ADMISSION_ID);
    db.prepare("UPDATE cleanup_leases SET status='failed', blocker_code='CLEANUP_ADMISSION_BLOCKED', blocker_json='{}' WHERE admission_id=?").run(ADMISSION_ID);
    const replacement = 'cln_0' + 'b'.repeat(25);
    db.prepare(`INSERT INTO cleanup_leases (
      admission_id, job_id, unit_name, owner, expires_at, status, credential_relative_path, credential_sha256,
      fence_generation, fence_token_hash, proof_json, admitted_at
    ) VALUES (?, 'job-valid', ?, 'replacement', ?, 'admitted', ?, ?, 2, ?, '{}', ?)`).run(
      replacement,
      `osi-image-builder-cleanup@${replacement}.service`,
      '2026-07-23T01:01:00.000Z',
      `recovery/cleanup-credentials/${replacement}.token`,
      HASH64,
      'd'.repeat(64),
      '2026-07-23T00:11:00.000Z',
    );
    db.prepare('UPDATE jobs SET cleanup_generation=2, cleanup_fence_generation=2, cleanup_fence_token_hash=?, cleanup_admission_id=? WHERE job_id=?').run('d'.repeat(64), replacement, 'job-valid');
    db.prepare(`UPDATE cleanup_leases SET
      status='expired', blocker_code=NULL, blocker_json=NULL, expired_at=?, superseded_at=?, superseded_by_admission_id=?,
      predecessor_status='failed', predecessor_claim_at='2026-07-23T00:10:00.000Z', predecessor_renew_at=NULL,
      predecessor_blocker_code='CLEANUP_ADMISSION_BLOCKED', predecessor_blocker_json='{}'
      WHERE admission_id=?`).run('2026-07-23T00:12:00.000Z', '2026-07-23T00:12:00.000Z', replacement, ADMISSION_ID);
    expect(() => db.prepare("UPDATE cleanup_leases SET owner='forged' WHERE admission_id=?").run(ADMISSION_ID)).toThrow();
    db.close();
  });

  it.each([
    ['admission_id', 'cln_0' + 'e'.repeat(25)],
    ['job_id', 'job-valid-2'],
    ['unit_name', `osi-image-builder-cleanup@cln_0${'e'.repeat(25)}.service`],
    ['owner', 'forged-owner'],
    ['expires_at', '2026-07-23T02:00:00.000Z'],
    ['credential_relative_path', `recovery/cleanup-credentials/cln_0${'e'.repeat(25)}.token`],
    ['credential_sha256', 'e'.repeat(64)],
    ['fence_generation', 3],
    ['fence_token_hash', 'e'.repeat(64)],
    ['stale_runner_unit', 'osi-image-builder-runner@job-valid.service'],
    ['stale_runner_owner', 'stale-runner'],
    ['stale_runner_lease_expires_at', '2026-07-23T00:01:00.000Z'],
    ['stale_state', 'building'],
    ['stale_container_id', 'container-forged'],
    ['stale_container_name', 'forged-container'],
    ['stale_container_labels_json', '{"forged":true}'],
    ['proof_json', '{"forged":true}'],
    ['completion_evidence_path', 'evidence/forged.json'],
    ['completion_evidence_sha256', 'e'.repeat(64)],
    ['admitted_at', '2026-07-23T00:02:00.000Z'],
    ['claim_at', '2026-07-23T00:02:30.000Z'],
    ['renew_at', '2026-07-23T00:02:45.000Z'],
    ['complete_at', '2026-07-23T00:03:00.000Z'],
    ['handback_at', '2026-07-23T00:04:00.000Z'],
    ['stop_authorization_attempt_id', 'sta_' + 'a'.repeat(32)],
    ['stop_authorization_owner', 'stop-owner'],
    ['stop_authorization_at', '2026-07-23T00:02:50.000Z'],
    ['stop_authorization_expires_at', '2026-07-23T00:03:50.000Z'],
    ['stop_authorization_state', 'failed'],
    ['unexpected_exit_json', '{"kind":"cleanup-unit-unexpected-exit"}'],
    ['predecessor_stop_authorization_attempt_id', 'sta_' + 'b'.repeat(32)],
    ['predecessor_stop_authorization_owner', 'previous-stop-owner'],
    ['predecessor_stop_authorization_at', '2026-07-23T00:02:50.000Z'],
    ['predecessor_stop_authorization_expires_at', '2026-07-23T00:03:50.000Z'],
    ['predecessor_stop_authorization_state', 'failed'],
    ['predecessor_unexpected_exit_json', '{"kind":"cleanup-unit-unexpected-exit"}'],
  ])('rejects supersession transition mutation of historical %s', async (column, value) => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    insertValidJob(db);
    insertAdmittedLease(db);
    db.prepare("UPDATE cleanup_leases SET status='claimed', claim_at='2026-07-23T00:10:00.000Z' WHERE admission_id=?").run(ADMISSION_ID);
    db.prepare("UPDATE cleanup_leases SET status='failed', blocker_code='CLEANUP_ADMISSION_BLOCKED', blocker_json='{}' WHERE admission_id=?").run(ADMISSION_ID);
    const replacement = 'cln_0' + 'b'.repeat(25);
    db.prepare(`INSERT INTO cleanup_leases (
      admission_id, job_id, unit_name, owner, expires_at, status, credential_relative_path, credential_sha256,
      fence_generation, fence_token_hash, proof_json, admitted_at
    ) VALUES (?, 'job-valid', ?, 'replacement', ?, 'admitted', ?, ?, 2, ?, '{}', ?)`).run(
      replacement,
      `osi-image-builder-cleanup@${replacement}.service`,
      '2026-07-23T01:01:00.000Z',
      `recovery/cleanup-credentials/${replacement}.token`,
      HASH64,
      'd'.repeat(64),
      '2026-07-23T00:11:00.000Z',
    );
    db.prepare('UPDATE jobs SET cleanup_generation=2, cleanup_fence_generation=2, cleanup_fence_token_hash=?, cleanup_admission_id=? WHERE job_id=?').run('d'.repeat(64), replacement, 'job-valid');
    expect(() => db.prepare(`UPDATE cleanup_leases SET status='expired', blocker_code=NULL, blocker_json=NULL, expired_at=?, superseded_at=?, superseded_by_admission_id=?, predecessor_status='failed', predecessor_claim_at='2026-07-23T00:10:00.000Z', predecessor_renew_at=NULL, predecessor_blocker_code='CLEANUP_ADMISSION_BLOCKED', predecessor_blocker_json='{}', ${column}=? WHERE admission_id=?`).run(
      '2026-07-23T00:12:00.000Z', '2026-07-23T00:12:00.000Z', replacement, value, ADMISSION_ID,
    )).toThrow(/supersession transition evidence|immutable|active job fence|FOREIGN KEY|CHECK/);
    db.close();
  });

  it('keeps cleanup credential reservation identity immutable', async () => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    insertValidJob(db);
    const reservation = 'cln_0' + 'd'.repeat(25);
    db.prepare(`INSERT INTO cleanup_credential_reservations (
      job_id, admission_id, owner, credential_relative_path, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?)`).run(
      'job-valid',
      reservation,
      'builder',
      `recovery/cleanup-credentials/${reservation}.token`,
      '2026-07-23T00:00:00.000Z',
      '2026-07-23T01:00:00.000Z',
    );
    expect(() => db.prepare('UPDATE cleanup_credential_reservations SET owner=? WHERE admission_id=?').run('forged', reservation))
      .toThrow(/immutable/);
    db.close();
  });

  it('enforces stop-authorization identity, complete columns, and durable head transitions in SQL', async () => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    insertValidJob(db);
    insertValidJob(db, 'job-other');
    insertAdmittedLease(db);
    db.prepare('UPDATE jobs SET cleanup_generation=1, cleanup_fence_generation=1, cleanup_fence_token_hash=?, cleanup_admission_id=? WHERE job_id=?').run('c'.repeat(64), ADMISSION_ID, 'job-valid');
    const attemptId = 'sta_' + 'a'.repeat(32);
    const unitName = `osi-image-builder-cleanup@${ADMISSION_ID}.service`;
    db.prepare(`INSERT INTO cleanup_stop_authorizations (
      attempt_id, attempt_no, job_id, admission_id, request_owner, authorization_owner, authorization_at, authorization_expires_at,
      unit_name, fence_generation, fence_token_hash, predecessor_status, predecessor_owner, predecessor_expires_at,
      predecessor_claim_at, predecessor_renew_at, predecessor_blocker_code, predecessor_blocker_json
    ) VALUES (?, 1, 'job-valid', ?, 'api', 'stop-owner', '2026-07-23T02:00:00.000Z', '2026-07-23T03:00:00.000Z', ?, 1, ?, 'admitted', 'builder', '2026-07-23T01:00:00.000Z', NULL, NULL, NULL, NULL)`).run(attemptId, ADMISSION_ID, unitName, 'c'.repeat(64));
    db.prepare(`INSERT INTO cleanup_stop_authorization_heads (admission_id, job_id, attempt_id, state, authorization_owner, updated_at, outcome_json)
      VALUES (?, 'job-valid', ?, 'authorized', 'stop-owner', '2026-07-23T02:00:00.000Z', NULL)`).run(ADMISSION_ID, attemptId);

    check(db, `UPDATE cleanup_leases SET stop_authorization_attempt_id='${attemptId}' WHERE admission_id='${ADMISSION_ID}'`, /columns must be complete|evidence is incoherent/);
    check(db, `UPDATE cleanup_leases SET stop_authorization_attempt_id='${attemptId}', stop_authorization_owner='forged-owner', stop_authorization_at='2026-07-23T02:00:00.000Z', stop_authorization_expires_at='2026-07-23T03:00:00.000Z', stop_authorization_state='failed' WHERE admission_id='${ADMISSION_ID}'`, /evidence is incoherent/);
    check(db, `INSERT INTO cleanup_stop_authorizations (
      attempt_id, attempt_no, job_id, admission_id, request_owner, authorization_owner, authorization_at, authorization_expires_at,
      unit_name, fence_generation, fence_token_hash, predecessor_status, predecessor_owner, predecessor_expires_at,
      predecessor_claim_at, predecessor_renew_at, predecessor_blocker_code, predecessor_blocker_json
    ) VALUES ('sta_${'b'.repeat(32)}', 2, 'job-other', '${ADMISSION_ID}', 'api', 'stop-owner', '2026-07-23T02:00:00.000Z', '2026-07-23T03:00:00.000Z', '${unitName}', 1, '${'c'.repeat(64)}', 'admitted', 'builder', '2026-07-23T01:00:00.000Z', NULL, NULL, NULL, NULL)`, /identity is incoherent/);
    check(db, `UPDATE cleanup_stop_authorization_heads SET authorization_owner='forged-owner' WHERE admission_id='${ADMISSION_ID}'`, /identity is incoherent|transition is incoherent/);
    check(db, `UPDATE cleanup_stop_authorization_heads SET outcome_json='{}' WHERE admission_id='${ADMISSION_ID}'`, /transition is incoherent/);
    check(db, `UPDATE cleanup_stop_authorization_heads SET attempt_id='sta_${'c'.repeat(32)}' WHERE admission_id='${ADMISSION_ID}'`, /identity is incoherent|transition is incoherent/);
    check(db, `UPDATE cleanup_stop_authorization_heads SET job_id='job-other' WHERE admission_id='${ADMISSION_ID}'`, /identity is incoherent|FOREIGN KEY/);
    check(db, `UPDATE cleanup_stop_authorization_heads SET admission_id='cln_0${'b'.repeat(25)}' WHERE admission_id='${ADMISSION_ID}'`, /identity is incoherent|FOREIGN KEY/);

    check(db, `UPDATE cleanup_leases SET stop_authorization_attempt_id='${attemptId}', stop_authorization_owner='stop-owner', stop_authorization_at='2026-07-23T02:00:00.000Z', stop_authorization_expires_at='2026-07-23T03:00:00.000Z', stop_authorization_state='consumed' WHERE admission_id='${ADMISSION_ID}'`, /evidence is incoherent/);
    check(db, `UPDATE cleanup_stop_authorization_heads SET state='consumed', outcome_json='{"active":false}' WHERE admission_id='${ADMISSION_ID}'`, /transition is incoherent/);
    check(db, `UPDATE cleanup_stop_authorization_heads SET authorization_owner='forged-owner' WHERE admission_id='${ADMISSION_ID}'`, /identity is incoherent|transition is incoherent/);
    check(db, `UPDATE cleanup_stop_authorization_heads SET outcome_json='{"active":true}' WHERE admission_id='${ADMISSION_ID}'`, /transition is incoherent/);
    check(db, `UPDATE cleanup_stop_authorization_heads SET attempt_id='sta_${'d'.repeat(32)}' WHERE admission_id='${ADMISSION_ID}'`, /identity is incoherent|transition is incoherent/);
    db.close();
  });

  it('requires event-bound terminal stop evidence and unexpected-exit proof for direct SQL transitions', async () => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    insertValidJob(db);
    insertAdmittedLease(db);
    db.prepare('UPDATE jobs SET cleanup_generation=1, cleanup_fence_generation=1, cleanup_fence_token_hash=?, cleanup_admission_id=? WHERE job_id=?').run('c'.repeat(64), ADMISSION_ID, 'job-valid');
    const attemptId = 'sta_' + 'e'.repeat(32);
    const unitName = `osi-image-builder-cleanup@${ADMISSION_ID}.service`;
    db.prepare(`INSERT INTO cleanup_stop_authorizations (
      attempt_id, attempt_no, job_id, admission_id, request_owner, authorization_owner, authorization_at, authorization_expires_at,
      unit_name, fence_generation, fence_token_hash, predecessor_status, predecessor_owner, predecessor_expires_at,
      predecessor_claim_at, predecessor_renew_at, predecessor_blocker_code, predecessor_blocker_json
    ) VALUES (?, 1, 'job-valid', ?, 'api', 'stop-owner', '2026-07-23T02:00:00.000Z', '2026-07-23T03:00:00.000Z', ?, 1, ?, 'admitted', 'builder', '2026-07-23T01:00:00.000Z', NULL, NULL, NULL, NULL)`).run(attemptId, ADMISSION_ID, unitName, 'c'.repeat(64));
    db.prepare(`INSERT INTO cleanup_stop_authorization_heads (admission_id, job_id, attempt_id, state, authorization_owner, updated_at, outcome_json)
      VALUES (?, 'job-valid', ?, 'authorized', 'stop-owner', '2026-07-23T02:00:00.000Z', NULL)`).run(ADMISSION_ID, attemptId);
    check(db, `UPDATE cleanup_leases SET stop_authorization_attempt_id='${attemptId}', stop_authorization_owner='stop-owner', stop_authorization_at='2026-07-23T02:00:00.000Z', stop_authorization_expires_at='2026-07-23T03:00:00.000Z', stop_authorization_state='consumed' WHERE admission_id='${ADMISSION_ID}'`, /evidence|outcome|terminal/);
    check(db, `UPDATE cleanup_stop_authorization_heads SET state='consumed', outcome_json='{}' WHERE admission_id='${ADMISSION_ID}'`, /evidence|outcome|transition/);
    check(db, `UPDATE cleanup_leases SET stop_authorization_attempt_id='${attemptId}', stop_authorization_owner='stop-owner', stop_authorization_at='2026-07-23T02:00:00.000Z', stop_authorization_expires_at='2026-07-23T03:00:00.000Z', stop_authorization_state='failed' WHERE admission_id='${ADMISSION_ID}'`, /evidence|outcome|terminal/);
    db.close();

    const supersessionPath = await temporaryDatabase();
    const supersession = openBuilderDatabase(supersessionPath);
    insertValidJob(supersession);
    insertAdmittedLease(supersession);
    supersession.prepare("UPDATE cleanup_leases SET status='claimed', claim_at='2026-07-23T00:10:00.000Z' WHERE admission_id=?").run(ADMISSION_ID);
    const replacement = 'cln_0' + 'f'.repeat(25);
    supersession.prepare(`INSERT INTO cleanup_leases (
      admission_id, job_id, unit_name, owner, expires_at, status, credential_relative_path, credential_sha256,
      fence_generation, fence_token_hash, proof_json, admitted_at
    ) VALUES (?, 'job-valid', ?, 'replacement', '2026-07-23T01:01:00.000Z', 'admitted', ?, ?, 2, ?, '{}', '2026-07-23T00:11:00.000Z')`).run(
      replacement, `osi-image-builder-cleanup@${replacement}.service`, `recovery/cleanup-credentials/${replacement}.token`, HASH64, 'd'.repeat(64),
    );
    supersession.prepare('UPDATE jobs SET cleanup_generation=2, cleanup_fence_generation=2, cleanup_fence_token_hash=?, cleanup_admission_id=? WHERE job_id=?').run('d'.repeat(64), replacement, 'job-valid');
    check(supersession, `UPDATE cleanup_leases SET status='expired', blocker_code=NULL, blocker_json=NULL, expired_at='2026-07-23T00:12:00.000Z', superseded_at='2026-07-23T00:12:00.000Z', superseded_by_admission_id='${replacement}', predecessor_status='claimed', predecessor_claim_at='2026-07-23T00:10:00.000Z', predecessor_renew_at=NULL, predecessor_blocker_code=NULL, predecessor_blocker_json=NULL WHERE admission_id='${ADMISSION_ID}'`, /unexpected-exit|supersession|evidence/);
    const unexpected = JSON.stringify({ kind: 'cleanup-unit-unexpected-exit', code: 'CLEANUP_UNIT_UNEXPECTED_EXIT', unitName: `osi-image-builder-cleanup@${ADMISSION_ID}.service`, active: false, inactiveAt: '2026-07-23T00:11:00.000Z', observedAt: '2026-07-23T00:11:00.000Z' });
    supersession.prepare('UPDATE cleanup_leases SET unexpected_exit_json=? WHERE admission_id=?').run(unexpected, ADMISSION_ID);
    supersession.prepare(`UPDATE cleanup_leases SET status='expired', blocker_code=NULL, blocker_json=NULL, expired_at='2026-07-23T00:12:00.000Z', superseded_at='2026-07-23T00:12:00.000Z', superseded_by_admission_id=?, predecessor_status='claimed', predecessor_claim_at='2026-07-23T00:10:00.000Z', predecessor_renew_at=NULL, predecessor_blocker_code=NULL, predecessor_blocker_json=NULL, predecessor_unexpected_exit_json=? WHERE admission_id=?`).run(replacement, unexpected, ADMISSION_ID);
    expect(supersession.prepare('SELECT status, predecessor_unexpected_exit_json FROM cleanup_leases WHERE admission_id=?').get(ADMISSION_ID)).toMatchObject({ status: 'expired', predecessor_unexpected_exit_json: unexpected });
    supersession.close();
  });

  it('enforces complete Docker identity lifecycle evidence and permits only a complete clear', async () => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    insertValidJob(db, 'container-job', 'building');
    check(db, "UPDATE jobs SET container_id='cid' WHERE job_id='container-job'", /container identity and lifecycle evidence is incomplete/);
    db.prepare(`UPDATE jobs SET container_id='cid', container_name='builder', container_image_digest=?, container_label_job_id='container-job', container_label_manifest_sha=?, container_labels_json=?, container_mount_json='{}', container_env_json='{}', container_security_json='{}', container_inspection_json='{}', container_created_at='2026-07-23T00:00:00.000Z' WHERE job_id='container-job'`).run(HASH64, HASH64, containerLabels('container-job'));
    check(db, "UPDATE jobs SET container_label_manifest_sha='c' WHERE job_id='container-job'", /CHECK constraint failed: length\(container_label_manifest_sha\)|container identity and lifecycle evidence is incomplete/);
    check(db, "UPDATE jobs SET container_labels_json='{}' WHERE job_id='container-job'", /container identity and lifecycle evidence is incomplete/);
    check(db, "UPDATE jobs SET container_labels_json='{\"extra\":\"x\"}' WHERE job_id='container-job'", /container identity and lifecycle evidence is incomplete/);
    check(db, "UPDATE jobs SET container_started_at='2026-07-22T23:59:00.000Z' WHERE job_id='container-job'", /container identity and lifecycle evidence is incomplete/);
    check(db, "UPDATE jobs SET container_removed_at='x' WHERE job_id='container-job'", /container identity and lifecycle evidence is incomplete/);
    db.prepare("UPDATE jobs SET container_started_at='2026-07-23T00:01:00.000Z' WHERE job_id='container-job'").run();
    check(db, "UPDATE jobs SET container_removed_at='2026-07-23T00:01:30.000Z', container_cleanup_outcome='passed' WHERE job_id='container-job'", /container identity and lifecycle evidence is incomplete/);
    check(db, "UPDATE jobs SET container_stopped_at='2026-07-23T00:00:30.000Z' WHERE job_id='container-job'", /container identity and lifecycle evidence is incomplete/);
    db.prepare("UPDATE jobs SET container_stopped_at='2026-07-23T00:02:00.000Z' WHERE job_id='container-job'").run();
    check(db, "UPDATE jobs SET container_removed_at='2026-07-23T00:01:30.000Z' WHERE job_id='container-job'", /container identity and lifecycle evidence is incomplete/);
    db.prepare("UPDATE jobs SET container_removed_at='2026-07-23T00:03:00.000Z', container_cleanup_outcome='passed' WHERE job_id='container-job'").run();
    db.prepare(`UPDATE jobs SET container_id=NULL, container_name=NULL, container_image_digest=NULL, container_label_job_id=NULL, container_label_manifest_sha=NULL, container_labels_json=NULL, container_mount_json=NULL, container_env_json=NULL, container_security_json=NULL, container_inspection_json=NULL, container_created_at=NULL, container_started_at=NULL, container_stopped_at=NULL, container_removed_at=NULL, container_cleanup_outcome=NULL WHERE job_id='container-job'`).run();
    insertValidJob(db, 'never-started', 'building');
    db.prepare(`UPDATE jobs SET container_id='cid-2', container_name='builder-2', container_image_digest=?, container_label_job_id='never-started', container_label_manifest_sha=?, container_labels_json=?, container_mount_json='{}', container_env_json='{}', container_security_json='{}', container_inspection_json='{}', container_created_at='2026-07-23T00:00:00.000Z' WHERE job_id='never-started'`).run(HASH64, HASH64, containerLabels('never-started'));
    db.prepare("UPDATE jobs SET container_removed_at='2026-07-23T00:01:00.000Z', container_cleanup_outcome='passed' WHERE job_id='never-started'").run();
    db.close();
  });

  it('enforces acceptance identity, artifact/publish evidence, and exact freshness outcomes', async () => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    insertValidJob(db, 'evidence-job', 'verifying');
    check(db, "UPDATE jobs SET expected_sha='c' WHERE job_id='evidence-job'", /accepted job identity is immutable/);
    check(db, "UPDATE jobs SET source_branch='other' WHERE job_id='evidence-job'", /accepted job identity is immutable/);
    check(db, "UPDATE jobs SET target_manifest_sha256='A' WHERE job_id='evidence-job'", /accepted job identity is immutable/);
    check(db, "UPDATE jobs SET preflight_checked_at='x' WHERE job_id='evidence-job'", /accepted job identity is immutable/);
    check(db, "UPDATE jobs SET publish_state=NULL, artifact_staging_path='staging/image.gz' WHERE job_id='evidence-job'", /publish fields require a state/);
    check(db, "UPDATE jobs SET artifact_staging_path='staging/image.gz' WHERE job_id='evidence-job'", /publish fields require a state/);
    for (const partial of [
      { artifact_staging_path: 'staging/image.gz' },
      { artifact_sha256: HASH64, artifact_size: 100, artifact_mtime: 'x' },
      { artifact_staging_path: 'staging/image.gz', artifact_sha256: HASH64 },
      { checksum_path: 'staging/SHA256SUMS' },
      { checksum_sha256: HASH64 },
      { manifest_path: 'staging/build-manifest.json' },
      { verification_sha256: HASH64 },
      { artifact_final_directory: 'release' },
      { artifact_final_path: 'release/image.gz' },
    ]) {
      const assignments = Object.entries(partial).map(([key, value]) => `${key}=${typeof value === 'number' ? value : `'${value}'`}`).join(', ');
      check(db, `UPDATE jobs SET ${assignments} WHERE job_id='evidence-job'`, /publish fields require a state|artifact evidence groups are incomplete/);
    }
    const staged = stagingEvidence();
    db.prepare(`UPDATE jobs SET ${Object.keys(staged).map((key) => `${key}=?`).join(', ')}, publish_state='staged' WHERE job_id='evidence-job'`).run(...Object.values(staged));
    check(db, "UPDATE jobs SET publish_state='quarantined', artifact_quarantine_path='quarantine/image.gz' WHERE job_id='evidence-job'", /publish result is incoherent/);
    db.prepare(`UPDATE jobs SET artifact_final_directory='release', artifact_final_path='release/image.gz', publish_started_at='2026-07-23T00:01:00.000Z', publish_state='publishing' WHERE job_id='evidence-job'`).run();
    check(db, "UPDATE jobs SET publish_state='published', artifact_staging_path='staging/image.gz' WHERE job_id='evidence-job'", /publish result is incoherent/);
    db.prepare(`UPDATE jobs SET artifact_staging_path=NULL, artifact_final_directory='release', artifact_final_path='release/image.gz', publish_state='published', published_at='2026-07-23T00:02:00.000Z' WHERE job_id='evidence-job'`).run();
    check(db, "UPDATE jobs SET artifact_quarantine_path='quarantine/image.gz', publish_state='published' WHERE job_id='evidence-job'", /publish result is incoherent/);
    db.prepare(`UPDATE jobs SET publish_state='quarantined', artifact_quarantine_path='quarantine/image.gz', artifact_final_directory=NULL, artifact_final_path=NULL, artifact_staging_path=NULL, artifact_sha256=NULL, artifact_size=NULL, artifact_mtime=NULL, checksum_path=NULL, checksum_sha256=NULL, manifest_path=NULL, manifest_sha256=NULL, verification_path=NULL, verification_sha256=NULL, publish_started_at=NULL, published_at=NULL WHERE job_id='evidence-job'`).run();
    check(db, "UPDATE jobs SET publish_started_at='x' WHERE job_id='evidence-job'", /publish result is incoherent/);
    check(db, "UPDATE jobs SET publish_state='blocked', publish_blocker_code='PUBLISH_FAILED' WHERE job_id='evidence-job'", /publish result is incoherent/);
    db.prepare(`UPDATE jobs SET ${Object.keys(staged).map((key) => `${key}=?`).join(', ')}, publish_state='blocked', publish_blocker_code='PUBLISH_FAILED', publish_blocker_json='{}', artifact_quarantine_path=NULL, artifact_final_directory=NULL, artifact_final_path=NULL, publish_started_at=NULL, published_at=NULL WHERE job_id='evidence-job'`).run(...Object.values(staged));
    check(db, "UPDATE jobs SET publish_started_at='x' WHERE job_id='evidence-job'", /publish result is incoherent/);
    db.prepare("UPDATE jobs SET artifact_staging_path=NULL, artifact_quarantine_path='quarantine/image.gz' WHERE job_id='evidence-job'").run();
    check(db, "UPDATE jobs SET artifact_staging_path='staging/image.gz' WHERE job_id='evidence-job'", /publish result is incoherent/);
    insertValidJob(db, 'blocked-job', 'building');
    const blockedEvidence = stagingEvidence();
    db.prepare(`UPDATE jobs SET ${Object.keys(blockedEvidence).map((key) => `${key}=?`).join(', ')}, publish_state='blocked', publish_blocker_code='PUBLISH_FAILED', publish_blocker_json='{}' WHERE job_id='blocked-job'`).run(...Object.values(blockedEvidence));
    check(db, "UPDATE jobs SET publish_state=NULL, publish_blocker_json='{}' WHERE job_id='evidence-job'", /publish fields require a state/);
    db.prepare("UPDATE jobs SET freshness_requested_at='2026-07-23T00:03:00.000Z' WHERE job_id='evidence-job'").run();
    check(db, "UPDATE jobs SET freshness_checked_at='x' WHERE job_id='evidence-job'", /freshness result requires a status/);
    db.prepare(`UPDATE jobs SET freshness_status='fresh', freshness_observed_sha=?, newer_source_available=0, freshness_checked_at='2026-07-23T00:04:00.000Z' WHERE job_id='evidence-job'`).run(SHA40);
    check(db, "UPDATE jobs SET freshness_requested_at='changed' WHERE job_id='evidence-job'", /freshness timestamps are immutable/);
    check(db, "UPDATE jobs SET freshness_checked_at='changed' WHERE job_id='evidence-job'", /freshness timestamps are immutable/);
    check(db, `UPDATE jobs SET freshness_status='advanced', freshness_observed_sha='${SHA40}', newer_source_available=1 WHERE job_id='evidence-job'`, /freshness result is incoherent/);
    check(db, "UPDATE jobs SET freshness_status='unknown', freshness_observed_sha=NULL, newer_source_available=0 WHERE job_id='evidence-job'", /freshness result is incoherent/);
    db.prepare(`UPDATE jobs SET freshness_status='unknown', freshness_observed_sha=NULL, newer_source_available=0, freshness_error_code='FRESHNESS_UNKNOWN', freshness_error_json='{}', freshness_error_evidence_path='evidence/freshness.json', freshness_error_evidence_sha256=?, freshness_checked_at='2026-07-23T00:04:00.000Z' WHERE job_id='evidence-job'`).run(HASH64);
    check(db, "UPDATE jobs SET publish_state='published' WHERE job_id='evidence-job'", /publish result is incoherent/);
    db.close();
  });

  it('enforces completed operation result semantics and durable log generations/ranges', async () => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    insertValidJob(db, 'log-job', 'building');
    db.prepare(`INSERT INTO job_operations (job_id, operation_id, attempt, argv_hash, argv_json, started_at) VALUES ('log-job', 'build-image', 1, ?, '["make"]', 'x')`).run(HASH64);
    check(db, `UPDATE job_operations SET container_id='cid', container_name='builder', container_image_digest='${HASH64}', container_label_job_id='log-job', container_label_manifest_sha='${HASH64}', container_mount_json='{}', container_env_json='{}', container_security_json='{}', inspection_json='{}', lifecycle_phase='started', exit_code=1, outcome='passed', finished_at='y', evidence_path='e', evidence_sha256='${HASH64}' WHERE job_id='log-job'`, /CHECK constraint failed: operation_passed_exit/);
    db.prepare(`UPDATE job_operations SET container_id='cid', container_name='builder', container_image_digest=?, container_label_job_id='log-job', container_label_manifest_sha=?, container_mount_json='{}', container_env_json='{}', container_security_json='{}', inspection_json='{}', lifecycle_phase='started', exit_code=0, outcome='passed', finished_at='y', evidence_path='e', evidence_sha256=? WHERE job_id='log-job'`).run(HASH64, HASH64, HASH64);
    db.prepare(`INSERT INTO job_operations (job_id, operation_id, attempt, argv_hash, argv_json, started_at) VALUES ('log-job', 'frontend-test', 1, ?, '["test"]', 'x')`).run(HASH64);
    check(db, `UPDATE job_operations SET container_id='cid', container_name='builder', container_image_digest='${HASH64}', container_label_job_id='log-job', container_label_manifest_sha='${HASH64}', container_mount_json='{}', container_env_json='{}', container_security_json='{}', inspection_json='{}', lifecycle_phase='started', exit_code=1, outcome='failed', finished_at='y', evidence_path='e', evidence_sha256='${HASH64}' WHERE job_id='log-job' AND operation_id='frontend-test'`, /CHECK constraint failed: operation_failed_error_evidence/);
    db.prepare(`UPDATE job_operations SET container_id='cid', container_name='builder', container_image_digest=?, container_label_job_id='log-job', container_label_manifest_sha=?, container_mount_json='{}', container_env_json='{}', container_security_json='{}', inspection_json='{}', lifecycle_phase='started', exit_code=1, outcome='failed', error_code='BUILD_FAILED', error_json='{}', finished_at='y', evidence_path='e', evidence_sha256=? WHERE job_id='log-job' AND operation_id='frontend-test'`).run(HASH64, HASH64, HASH64);
    db.prepare(`INSERT INTO job_operations (job_id, operation_id, attempt, argv_hash, argv_json, started_at, finished_at, lifecycle_phase, outcome, error_code, error_json, evidence_path, evidence_sha256) VALUES ('log-job', 'resolve-config', 1, ?, '[]', 'x', 'y', 'not_created', 'failed', 'BUILD_FAILED', '{}', 'e', ?)`).run(HASH64, HASH64);
    check(db, "INSERT INTO job_operations (job_id, operation_id, attempt, argv_hash, argv_json, started_at, finished_at, lifecycle_phase, exit_code, signal, outcome, error_code, error_json, evidence_path, evidence_sha256) VALUES ('log-job', 'verify-communication', 1, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '[]', 'x', 'y', 'not_created', 1, 'TERM', 'failed', 'BUILD_FAILED', '{}', 'e', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')", /CHECK constraint failed: operation_exit_signal_exclusive/);
    db.prepare(`INSERT INTO job_operations (job_id, operation_id, attempt, argv_hash, argv_json, started_at) VALUES ('log-job', 'verify-profile-parity', 1, ?, '[]', 'x')`).run(HASH64);
    check(db, `UPDATE job_operations SET container_id='cid', container_name='builder', container_image_digest='${HASH64}', container_label_job_id='log-job', container_label_manifest_sha='${HASH64}', container_mount_json='{}', container_env_json='{}', container_security_json='{}', inspection_json='{}', lifecycle_phase='not_created', exit_code=1, outcome='failed', error_code='BUILD_FAILED', error_json='{}', finished_at='y', evidence_path='e', evidence_sha256='${HASH64}' WHERE job_id='log-job' AND operation_id='verify-profile-parity'`, /CHECK constraint failed: operation_failed_container_shape/);
    db.prepare(`INSERT INTO job_operations (job_id, operation_id, attempt, argv_hash, argv_json, started_at) VALUES ('log-job', 'verify-image', 1, ?, '[]', 'x')`).run(HASH64);
    check(db, `UPDATE job_operations SET container_id='cid', container_name='builder', container_image_digest='${HASH64}', container_label_job_id='log-job', container_label_manifest_sha='${'c'.repeat(64)}', container_mount_json='{}', container_env_json='{}', container_security_json='{}', inspection_json='{}', lifecycle_phase='started', exit_code=0, outcome='passed', finished_at='y', evidence_path='e', evidence_sha256='${HASH64}' WHERE job_id='log-job' AND operation_id='verify-image'`, /operation Docker manifest label is invalid/);
    db.prepare(`INSERT INTO job_operations (job_id, operation_id, attempt, argv_hash, argv_json, started_at) VALUES ('log-job', 'activate-target', 1, ?, '[]', 'x')`).run(HASH64);
    check(db, `UPDATE job_operations SET container_id='cid', container_name='builder', container_image_digest='${HASH64}', container_label_job_id='log-job', container_label_manifest_sha='${HASH64}', container_mount_json='{}', container_env_json='{}', container_security_json='{}', inspection_json='{}', lifecycle_phase='started', timed_out=1, exit_code=0, outcome='passed', finished_at='y', evidence_path='e', evidence_sha256='${HASH64}' WHERE job_id='log-job' AND operation_id='activate-target'`, /CHECK constraint failed: operation_passed_timeout/);
    db.prepare(`INSERT INTO job_log_generations (job_id, stream, generation, path, started_at) VALUES ('log-job', 'runner', 0, 'logs/runner.0', 'x')`).run();
    check(db, "INSERT INTO job_log_generations (job_id, stream, generation, path, started_at) VALUES ('log-job', 'cleanup', 0, 'logs/cleanup.0', 'x')", /CHECK constraint failed: stream IN/);
    check(db, "INSERT INTO job_log_generations (job_id, stream, generation, path, started_at) VALUES ('log-job', 'runner', 2, 'bad', 'x')", /log generations must be contiguous/);
    db.prepare("UPDATE job_log_generations SET size_bytes=5 WHERE job_id='log-job' AND stream='runner' AND generation=0").run();
    db.prepare(`INSERT INTO job_events (job_id, seq, event_type, payload_json, at) VALUES ('log-job', 0, 'state', '{}', 'x')`).run();
    db.prepare(`INSERT INTO job_events (job_id, seq, event_type, payload_json, at, stream, file_generation, byte_offset, byte_length, partial) VALUES ('log-job', 1, 'log', '{}', 'x', 'runner', 0, 0, 5, 0)`).run();
    check(db, "UPDATE job_events SET byte_offset=1 WHERE job_id='log-job' AND seq=1", /job events are immutable/);
    check(db, "INSERT INTO job_events (job_id, seq, event_type, payload_json, at, stream, file_generation, byte_offset, byte_length, partial) VALUES ('log-job', 2, 'log', '{}', 'x', 'runner', 0, 4, 1, 0)", /job events must append within an open log generation/);
    check(db, "INSERT INTO job_events (job_id, seq, event_type, payload_json, at, stream, file_generation, byte_offset, byte_length, partial) VALUES ('log-job', 2, 'log', '{}', 'x', 'cleanup', 0, 5, 0, 0)", /job events must append within an open log generation/);
    check(db, "UPDATE job_log_generations SET size_bytes=4 WHERE job_id='log-job' AND stream='runner' AND generation=0", /log generation size is not append-only/);
    check(db, "UPDATE job_log_generations SET path='logs/changed' WHERE job_id='log-job' AND stream='runner' AND generation=0", /log generation identity is immutable/);
    check(db, "UPDATE job_log_generations SET sealed_at='y' WHERE job_id='log-job' AND stream='runner' AND generation=0", /log generation seal is immutable/);
    db.prepare(`UPDATE job_log_generations SET sealed_at='y', sha256=? WHERE job_id='log-job' AND stream='runner' AND generation=0`).run(HASH64);
    check(db, "UPDATE job_events SET payload_json='{}' WHERE job_id='log-job' AND seq=1", /job events are immutable/);
    expect(() => db.prepare("DELETE FROM job_log_generations WHERE job_id='log-job'").run()).toThrow(/FOREIGN KEY constraint failed/);
    db.prepare("DELETE FROM job_events WHERE job_id='log-job' AND seq=1").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id='log-job' AND seq=1").get()).toEqual({ count: 0 });
    check(db, "UPDATE job_log_generations SET size_bytes=6 WHERE job_id='log-job' AND stream='runner' AND generation=0", /log generation size is not append-only/);
    check(db, "INSERT INTO job_events (job_id, seq, event_type, payload_json, at, stream, file_generation, byte_offset, byte_length, partial) VALUES ('log-job', 2, 'log', '{}', 'x', 'runner', 0, 5, 1, 0)", /job events must append within an open log generation/);
    db.close();
  });

  it('enforces static stage, lease, terminal, blocker, and JSON coherence', async () => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    insertValidJob(db, 'static-job', 'building');
    for (const column of ['request_json', 'container_labels_json', 'container_mount_json', 'container_env_json', 'container_security_json', 'container_inspection_json', 'cleanup_blocker_json', 'terminal_error_json']) {
      check(db, `UPDATE jobs SET ${column}='not-json' WHERE job_id='static-job'`, column === 'request_json' ? /accepted job identity is immutable/ : column.startsWith('container_') ? /container identity and lifecycle evidence is incomplete/ : column === 'cleanup_blocker_json' ? /cleanup blocker evidence is incomplete/ : column === 'terminal_error_json' ? /terminal state evidence is incoherent/ : /CHECK constraint failed/);
    }
    check(db, "UPDATE jobs SET runner_unit='osi-image-builder.service' WHERE job_id='static-job'", /runner lease evidence is incomplete/);
    db.prepare("UPDATE jobs SET runner_unit='osi-image-builder-runner@static-job.service' WHERE job_id='static-job'").run();
    check(db, "UPDATE jobs SET runner_lease_owner='builder' WHERE job_id='static-job'", /runner lease evidence is incomplete/);
    db.prepare("UPDATE jobs SET runner_lease_owner='builder', runner_lease_expires_at='2026-07-23T01:00:00.000Z' WHERE job_id='static-job'").run();
    check(db, "UPDATE jobs SET runner_lease_owner=NULL WHERE job_id='static-job'", /runner lease evidence is incomplete/);
    db.prepare("UPDATE jobs SET runner_started_at='2026-07-23T00:01:00.000Z', runner_finished_at='2026-07-23T00:02:00.000Z' WHERE job_id='static-job'").run();
    check(db, "UPDATE jobs SET state='succeeded', terminal_at=NULL WHERE job_id='static-job'", /terminal state evidence is incoherent/);
    check(db, "UPDATE jobs SET state='succeeded', terminal_at='x', terminal_error_code='BUILD_FAILED', terminal_error_json='{}' WHERE job_id='static-job'", /terminal state evidence is incoherent/);
    db.prepare("UPDATE jobs SET state='succeeded', terminal_at='2026-07-23T00:03:00.000Z', terminal_error_code=NULL, terminal_error_json=NULL WHERE job_id='static-job'").run();
    check(db, "UPDATE jobs SET cleanup_blocker_code='PUBLISH_FAILED' WHERE job_id='static-job'", /cleanup blocker evidence is incomplete/);
    db.prepare("UPDATE jobs SET cleanup_blocker_code='PUBLISH_FAILED', cleanup_blocker_json='{}' WHERE job_id='static-job'").run();

    check(db, "INSERT INTO job_stages (job_id, stage, outcome, started_at, finished_at, evidence_path, evidence_sha256) VALUES ('static-job', 'build', 'running', 'x', 'y', 'e', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')", /CHECK constraint failed/);
    check(db, "INSERT INTO job_stages (job_id, stage, started_at) VALUES ('static-job', 'source', 'x')", /CHECK constraint failed/);
    db.prepare("INSERT INTO job_stages (job_id, stage, outcome, started_at) VALUES ('static-job', 'verify', 'running', 'x')").run();
    check(db, "UPDATE job_stages SET outcome='passed', finished_at='y' WHERE job_id='static-job' AND stage='verify'", /CHECK constraint failed/);
    db.prepare("UPDATE job_stages SET outcome='passed', finished_at='y', evidence_path='e', evidence_sha256=? WHERE job_id='static-job' AND stage='verify'").run(HASH64);
    check(db, "UPDATE job_stages SET error_code='BUILD_FAILED' WHERE job_id='static-job' AND stage='verify'", /CHECK constraint failed/);
    db.prepare("INSERT INTO job_stages (job_id, stage, outcome, started_at, finished_at, evidence_path, evidence_sha256, error_code, error_json) VALUES ('static-job', 'publish', 'failed', 'x', 'y', 'e', ?, 'PUBLISH_FAILED', '{}')").run(HASH64);
    check(db, "INSERT INTO job_events (job_id, seq, event_type, payload_json, at) VALUES ('static-job', 0, 'state', 'not-json', 'x')", /CHECK constraint failed/);
    db.prepare("INSERT INTO job_events (job_id, seq, event_type, payload_json, at) VALUES ('static-job', 0, 'state', '{}', 'x')").run();
    db.close();
  });
});
