import { createHash } from 'node:crypto';
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
import { parseBuilderIdentity, type BuilderIdentity } from '../../domain/builder-identity.js';

const repoMigrationDir = fileURLToPath(new URL('../../api/migrations/', import.meta.url));
const tempPaths: string[] = [];
const SHA40 = 'a'.repeat(40);
const HASH64 = 'b'.repeat(64);
const HISTORICAL_V6_SHA256 = 'c6334dd0fd03b34b8261e5b34bc0b09501e35a02ee4b57f81c98fd62af6e54a0';
const HISTORICAL_V21_SHA256 = '5390ec094daa621818ac14d8e0ea424100bae0cc6f839a926e1a5e6dcdb0f70b';
const ADMISSION_ID = `cln_0${'a'.repeat(25)}`;
const SECOND_ADMISSION_ID = `cln_0${'c'.repeat(25)}`;
const LEGACY_RUNNER_OWNER = 'runner-5a53c150-02e8-4436-9862-6c874575a988';
type GenerationIdentity = Readonly<{
  readonly runner: readonly Readonly<{ readonly generation: number; readonly path: string; readonly startedAt: string }>[];
  readonly docker: readonly Readonly<{ readonly generation: number; readonly path: string; readonly startedAt: string }>[];
}>;
const DEFAULT_GENERATION_IDENTITY: GenerationIdentity = {
  runner: [{ generation: 0, path: 'logs/runner-0.log', startedAt: '2026-08-01T12:24:40.000Z' }],
  docker: [{ generation: 0, path: 'logs/docker-0.log', startedAt: '2026-08-01T12:24:40.000Z' }],
};

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

async function applyRegisteredMigrations(
  db: DatabaseSync,
  count: number,
  appliedAt = '2026-08-03T00:00:00.000Z',
): Promise<void> {
  for (const migration of MIGRATION_REGISTRY.slice(0, count)) {
    db.exec(await readFile(join(repoMigrationDir, migration.filename), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (version, filename, sha256, applied_at) VALUES (?, ?, ?, ?)')
      .run(migration.version, migration.filename, migration.sha256, appliedAt);
  }
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

function insertValidJob(
  db: DatabaseSync,
  jobId = 'job-valid',
  state = 'queued',
  admittedIdentity = true,
  identityOverrides: Partial<BuilderIdentity> = {},
): void {
  const hasCompleteIdentitySchema = tableInfo(db, 'jobs').has('builder_identity_status');
  const hasProxyIdentitySchema = tableInfo(db, 'jobs').has('builder_dependency_egress_proxy_sha256');
  const identityColumns = hasCompleteIdentitySchema && admittedIdentity
    ? `, builder_identity_status, builder_package_version, builder_package_root, builder_lock_sha256,
       builder_execution_definition_sha256, builder_target_manifest_sha256,
       builder_runner_sha256, builder_cleanup_worker_sha256, builder_image_reference,
       builder_image_id, builder_image_digest${hasProxyIdentitySchema ? ', builder_dependency_egress_proxy_sha256' : ''}`
    : '';
  const identityPlaceholders = hasCompleteIdentitySchema && admittedIdentity
    ? `, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${hasProxyIdentitySchema ? ', ?' : ''}`
    : '';
  const identity = {
    packageVersion: '0.1.24',
    packageRoot: '/home/builder/.local/lib/osi-image-builder/0.1.24',
    lockSha256: '1'.repeat(64),
    executionDefinitionSha256: '2'.repeat(64),
    targetManifestSha256: HASH64,
    runnerSha256: '5'.repeat(64),
    cleanupWorkerSha256: '6'.repeat(64),
    dependencyEgressProxySha256: '7'.repeat(64),
    imageReference: `registry.example.invalid/osi-image-builder@sha256:${'3'.repeat(64)}`,
    imageId: `sha256:${'4'.repeat(64)}`,
    imageDigest: '3'.repeat(64),
    ...identityOverrides,
  } satisfies BuilderIdentity;
  const identityValues = hasCompleteIdentitySchema && admittedIdentity ? [
    'admitted', identity.packageVersion, identity.packageRoot,
    identity.lockSha256, identity.executionDefinitionSha256, identity.targetManifestSha256,
    identity.runnerSha256, identity.cleanupWorkerSha256,
    identity.imageReference, identity.imageId, identity.imageDigest,
    ...(hasProxyIdentitySchema ? [identity.dependencyEgressProxySha256] : []),
  ] : [];
  db.prepare(`INSERT INTO jobs (
    job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id,
    target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at,
    source_preparation_json, offline_feed_preparation_json${identityColumns}
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${identityPlaceholders})`).run(
    jobId, `request-${jobId}`, 'git@example:repo.git', 'refs/remotes/origin/main', 'main', 'main', SHA40, SHA40,
    'rpi-5', 'release', HASH64, '2026-07-23T00:00:00.000Z', 'author', 'subject', '2026-07-23T00:00:00.000Z',
    state, state === 'queued' ? 'queued' : 'dispatched', '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z',
    sourcePreparationJson(), offlineFeedPreparationJson(jobId), ...identityValues,
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

interface HandedBackCleanupProofOptions {
  readonly admissionId?: string;
  readonly fenceGeneration?: number;
  readonly eventSeqBase?: number;
  readonly recoveryEventSeq?: number;
  readonly updateJob?: boolean;
  readonly eventRunnerOwner?: string;
  readonly eventRunnerLeaseExpiresAt?: string;
  readonly runnerInactiveAt?: string;
  readonly runnerObservedAt?: string;
  readonly eventContainerId?: string;
  readonly eventContainerName?: string;
  readonly eventContainerImageDigest?: string;
  readonly eventContainerLabels?: Record<string, string>;
  readonly eventContainerObservedAt?: string;
  readonly eventContainerKind?: 'already-absent' | 'removed';
  readonly generationIdentity?: GenerationIdentity;
  readonly persistedGenerationIdentity?: GenerationIdentity;
  readonly admissionStaging?: 'absent' | 'present' | 'physical-present';
  readonly admissionStagingSha256?: string | null;
  readonly admissionStagingSize?: number | null;
  readonly completionStaging?: 'absent' | 'quarantined';
  readonly completionStagingSourcePath?: string;
  readonly completionStagingDestinationPath?: string;
  readonly completionStagingSha256?: string | null;
  readonly completionStagingSize?: number | null;
  readonly currentStagingState?: 'absent' | 'pre-handback' | 'quarantined';
  readonly currentStagingIdentity?: 'tracked' | 'unknown';
  readonly admissionLogs?: Readonly<{ readonly runner: 'absent' | 'sealed'; readonly docker: 'absent' | 'sealed' }>;
  readonly completionLogs?: Readonly<{ readonly runner: 'absent' | 'sealed'; readonly docker: 'absent' | 'sealed' }>;
  readonly runnerStartedAt?: string;
  readonly runnerLeaseExpiresAt?: string;
  readonly dispatchedAt?: string;
  readonly admittedAt?: string;
  readonly claimAt?: string;
  readonly completeAt?: string;
  readonly handbackAt?: string;
  readonly terminalAt?: string;
  readonly cleanupLeaseExpiresAt?: string;
  readonly snapshotRunnerInactiveAt?: string;
  readonly snapshotRunnerObservedAt?: string;
  readonly snapshotContainerObservedAt?: string;
  readonly snapshotStagingObservedAt?: string;
  readonly snapshotLogsVerifiedAt?: string;
  readonly completionRunnerInactiveAt?: string;
  readonly completionRunnerObservedAt?: string;
  readonly completionContainerObservedAt?: string;
  readonly completionContainerStoppedAt?: string;
  readonly completionContainerRemovedAt?: string;
  readonly completionStagingVerifiedAt?: string;
  readonly completionLogsVerifiedAt?: string;
  readonly globalLabelResult?: string;
  readonly includeEgress?: boolean;
  readonly extraEgressField?: boolean;
  readonly snapshotBlocker?: 'none' | 'container' | 'staging-or-log';
  readonly extraSnapshotField?: 'root' | 'runner' | 'container' | 'staging' | 'logs';
  readonly extraCompletionField?: 'container' | 'staging' | 'logs';
}

interface PersistedLogCoverage {
  readonly stream: 'runner' | 'docker';
  readonly generation: number;
  readonly byteLengths: readonly number[];
}

const JOB_EVENTS_APPEND_GUARD_SQL = `CREATE TRIGGER job_events_append_guard
BEFORE INSERT ON job_events
WHEN NEW.seq <> COALESCE((SELECT MAX(seq) + 1 FROM job_events WHERE job_id = NEW.job_id), 0)
  OR (NEW.stream IS NOT NULL AND (
    NEW.byte_offset <> COALESCE((SELECT MAX(byte_offset + byte_length) FROM job_events WHERE job_id = NEW.job_id AND stream = NEW.stream AND file_generation = NEW.file_generation), 0)
    OR NEW.byte_offset + NEW.byte_length > (SELECT size_bytes FROM job_log_generations WHERE job_id = NEW.job_id AND stream = NEW.stream AND generation = NEW.file_generation)
    OR EXISTS (SELECT 1 FROM job_log_generations WHERE job_id = NEW.job_id AND stream = NEW.stream AND generation = NEW.file_generation AND sealed_at IS NOT NULL)))
BEGIN
  SELECT RAISE(ABORT, 'job events must append within an open log generation');
END`;

const JOB_EVENTS_IMMUTABLE_UPDATE_GUARD_SQL = `CREATE TRIGGER job_events_immutable_update_guard
BEFORE UPDATE ON job_events
BEGIN
  SELECT RAISE(ABORT, 'job events are immutable');
END`;

const JOB_LOG_GENERATIONS_SIZE_GUARD_SQL = `CREATE TRIGGER job_log_generations_size_guard
BEFORE UPDATE OF size_bytes ON job_log_generations
WHEN NEW.size_bytes < OLD.size_bytes OR OLD.sealed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'log generation size is not append-only');
END`;

function replacePersistedLogCoverage(
  db: DatabaseSync,
  jobId: string,
  coverage: readonly PersistedLogCoverage[],
): void {
  const eventCount = coverage.reduce((count, generation) => count + generation.byteLengths.length, 0);
  if (eventCount <= 1) throw new TypeError('persisted log coverage fixture requires at least two events');

  db.exec('DROP TRIGGER job_events_append_guard');
  db.exec('DROP TRIGGER job_events_immutable_update_guard');
  db.exec('DROP TRIGGER job_log_generations_size_guard');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE job_events SET seq=seq+? WHERE job_id=?').run(eventCount, jobId);
    const updateGeneration = db.prepare(`UPDATE job_log_generations SET size_bytes=?
      WHERE job_id=? AND stream=? AND generation=?`);
    const insertEvent = db.prepare(`INSERT INTO job_events (
      job_id, seq, event_type, state, stage, payload_json, at,
      stream, file_generation, byte_offset, byte_length, partial
    ) VALUES (?, ?, 'log', 'release_gates', NULL, '{}', ?, ?, ?, ?, ?, 0)`);
    let seq = 0;
    for (const generation of coverage) {
      const size = generation.byteLengths.reduce((sum, length) => sum + length, 0);
      const updated = updateGeneration.run(size, jobId, generation.stream, generation.generation);
      if (Number(updated.changes) !== 1) throw new Error('persisted log coverage generation is missing');
      let offset = 0;
      for (const length of generation.byteLengths) {
        insertEvent.run(
          jobId,
          seq,
          '2026-08-01T12:24:40.050Z',
          generation.stream,
          generation.generation,
          offset,
          length,
        );
        seq += 1;
        offset += length;
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec(JOB_EVENTS_APPEND_GUARD_SQL);
    db.exec(JOB_EVENTS_IMMUTABLE_UPDATE_GUARD_SQL);
    db.exec(JOB_LOG_GENERATIONS_SIZE_GUARD_SQL);
  }
}

function boundedLogFixture(extraEvent = false): Readonly<{
  generationIdentity: GenerationIdentity;
  coverage: readonly PersistedLogCoverage[];
}> {
  const generationIdentity: GenerationIdentity = {
    runner: Array.from({ length: 64 }, (_, generation) => ({
      generation,
      path: `logs/runner-${generation}.log`,
      startedAt: '2026-08-01T12:24:40.000Z',
    })),
    docker: Array.from({ length: 64 }, (_, generation) => ({
      generation,
      path: `logs/docker-${generation}.log`,
      startedAt: '2026-08-01T12:24:40.000Z',
    })),
  };
  const coverage = (['runner', 'docker'] as const).flatMap((stream) =>
    generationIdentity[stream].map(({ generation }) => ({
      stream,
      generation,
      byteLengths: Array.from({
        length: 64 + (extraEvent && stream === 'runner' && generation === 0 ? 1 : 0),
      }, () => 1),
    })),
  );
  return { generationIdentity, coverage };
}

function mutatePersistedLogEvent(db: DatabaseSync, sql: string, jobId: string): void {
  db.exec('DROP TRIGGER job_events_immutable_update_guard');
  try {
    db.prepare(sql).run(jobId);
  } finally {
    db.exec(JOB_EVENTS_IMMUTABLE_UPDATE_GUARD_SQL);
  }
}

function insertHandedBackCleanupProof(
  db: DatabaseSync,
  jobId: string,
  options: HandedBackCleanupProofOptions = {},
): void {
  const admissionId = options.admissionId ?? ADMISSION_ID;
  const fenceGeneration = options.fenceGeneration ?? 1;
  const eventSeqBase = options.eventSeqBase ?? 0;
  const recoveryEventSeq = options.recoveryEventSeq ?? eventSeqBase + 1;
  const runnerUnit = `osi-image-builder-runner@${jobId}.service`;
  const cleanupUnit = `osi-image-builder-cleanup@${admissionId}.service`;
  const runnerLeaseExpiresAt = options.runnerLeaseExpiresAt ?? '2026-07-30T16:49:26.626Z';
  const runnerStartedAt = options.runnerStartedAt ?? '2026-07-30T16:47:40.685Z';
  const dispatchedAt = options.dispatchedAt ?? '2026-07-30T16:47:40.600Z';
  const inactiveAt = options.runnerInactiveAt ?? '2026-08-01T12:24:40.953Z';
  const observedAt = options.runnerObservedAt ?? '2026-08-01T12:24:40.953Z';
  const completeAt = options.completeAt ?? '2026-08-01T12:24:41.520Z';
  const handbackAt = options.handbackAt ?? '2026-08-01T12:24:49.169Z';
  const admittedAt = options.admittedAt ?? '2026-08-01T12:24:41.000Z';
  const claimAt = options.claimAt ?? '2026-08-01T12:24:41.100Z';
  const containerId = '29e1762f42b19d3bdb2fb7c47521c32d66b398241f9325089e2853ab19866096';
  const containerName = 'osi-image-builder-365205a0300e78e467742294e80bc2a3a31b1678e48520ad';
  const containerImageDigest = 'b3fa88f84f6815db4b55ac12c4ef14064a18d60f7c4eb3d636f10695ba3ba337';
  const containerLabels = {
    'org.osi.image-builder.job-id': jobId,
    'org.osi.image-builder.manifest-sha': HASH64,
  };
  const evidencePath = `jobs/${jobId}/evidence/cleanup/${admissionId}.complete.json`;
  const generationIdentity = options.generationIdentity ?? DEFAULT_GENERATION_IDENTITY;
  const persistedGenerationIdentity = options.persistedGenerationIdentity ?? generationIdentity;
  const admissionStaging = options.admissionStaging ?? 'absent';
  const completionStaging = options.completionStaging ?? 'absent';
  const admissionStagingSha256 = options.admissionStagingSha256 === undefined ? HASH64 : options.admissionStagingSha256;
  const admissionStagingSize = options.admissionStagingSize === undefined ? 100 : options.admissionStagingSize;
  const admissionLogs = options.admissionLogs ?? { runner: 'sealed' as const, docker: 'sealed' as const };
  const completionLogs = options.completionLogs ?? { runner: 'sealed' as const, docker: 'sealed' as const };
  const snapshotObservedAt = options.snapshotRunnerObservedAt ?? observedAt;
  const snapshotInactiveAt = options.snapshotRunnerInactiveAt ?? inactiveAt;
  const snapshotContainerObservedAt = options.snapshotContainerObservedAt ?? observedAt;
  const snapshotStagingObservedAt = options.snapshotStagingObservedAt ?? observedAt;
  const snapshotLogsVerifiedAt = options.snapshotLogsVerifiedAt ?? observedAt;
  const completionContainerObservedAt = options.completionContainerObservedAt ?? '2026-08-01T12:24:41.470Z';
  const completionStagingVerifiedAt = options.completionStagingVerifiedAt ?? completeAt;
  const completionLogsVerifiedAt = options.completionLogsVerifiedAt ?? completeAt;
  const admissionStagingValue = admissionStaging === 'absent'
    ? { kind: 'absent', path: null }
    : admissionStaging === 'physical-present'
      ? { kind: 'physical-present', path: `staging/${jobId}`, sha256: null, size: null, observedAt: snapshotStagingObservedAt }
      : { kind: 'present', path: `staging/${jobId}`, sha256: admissionStagingSha256, size: admissionStagingSize };
  const completionStagingValue = completionStaging === 'quarantined'
    ? {
      kind: 'quarantined', sourcePath: `staging/${jobId}`, destinationPath: `quarantine/${jobId}`,
      sourceAbsent: true, destinationPresent: true,
      sha256: options.completionStagingSha256 === undefined ? (admissionStaging === 'present' ? admissionStagingSha256 : null) : options.completionStagingSha256,
      size: options.completionStagingSize === undefined ? (admissionStaging === 'present' ? admissionStagingSize : null) : options.completionStagingSize, verifiedAt: completionStagingVerifiedAt,
    }
    : { kind: 'absent', path: null, sourcePath: `staging/${jobId}`, sourceAbsent: true, verifiedAt: completionStagingVerifiedAt };
  const snapshot = {
    runner: { unit: runnerUnit, owner: LEGACY_RUNNER_OWNER, leaseExpiresAt: runnerLeaseExpiresAt, inactiveAt: snapshotInactiveAt, observedAt: snapshotObservedAt, ...(options.extraSnapshotField === 'runner' ? { unsafeExtra: true } : {}) },
    state: 'release_gates',
    container: { kind: 'present', id: containerId, name: containerName, imageDigest: containerImageDigest, labels: containerLabels, globalLabelResult: 'no-match', observedAt: snapshotContainerObservedAt, ...(options.extraSnapshotField === 'container' ? { unsafeExtra: true } : {}) },
    staging: { ...admissionStagingValue, ...(options.extraSnapshotField === 'staging' ? { unsafeExtra: true } : {}) },
    logs: { runner: admissionLogs.runner, docker: admissionLogs.docker, verifiedAt: snapshotLogsVerifiedAt, generationIdentity, ...(options.extraSnapshotField === 'logs' ? { unsafeExtra: true } : {}) },
    ...(options.extraSnapshotField === 'root' ? { unsafeExtra: true } : {}),
    blocker: options.snapshotBlocker ?? 'container',
  };
  const eventContainerObservedAt = options.completionContainerObservedAt ?? options.eventContainerObservedAt ?? '2026-08-01T12:24:41.470Z';
  const postcondition = {
    runner: {
      ...snapshot.runner,
      inactiveAt: options.completionRunnerInactiveAt ?? snapshot.runner.inactiveAt,
      observedAt: options.completionRunnerObservedAt ?? snapshot.runner.observedAt,
      owner: options.eventRunnerOwner ?? snapshot.runner.owner,
      leaseExpiresAt: options.eventRunnerLeaseExpiresAt ?? snapshot.runner.leaseExpiresAt,
    },
    state: snapshot.state,
    container: options.eventContainerKind === 'removed'
      ? {
        kind: 'removed',
        id: options.eventContainerId ?? containerId,
        name: options.eventContainerName ?? containerName,
        imageDigest: options.eventContainerImageDigest ?? containerImageDigest,
        labels: options.eventContainerLabels ?? containerLabels,
        exactIdAbsent: true,
        globalLabelResult: options.globalLabelResult ?? 'no-match',
        stoppedAt: options.completionContainerStoppedAt ?? '2026-08-01T12:24:41.450Z',
        removedAt: options.completionContainerRemovedAt ?? '2026-08-01T12:24:41.460Z',
        observedAt: eventContainerObservedAt,
        ...(options.extraCompletionField === 'container' ? { unsafeExtra: true } : {}),
      }
      : {
        kind: 'already-absent',
        id: options.eventContainerId ?? containerId,
        name: options.eventContainerName ?? containerName,
        imageDigest: options.eventContainerImageDigest ?? containerImageDigest,
        labels: options.eventContainerLabels ?? containerLabels,
        exactIdAbsent: true,
        dockerAction: 'none',
        globalLabelResult: options.globalLabelResult ?? 'no-match',
        observedAt: eventContainerObservedAt,
        ...(options.extraCompletionField === 'container' ? { unsafeExtra: true } : {}),
      },
    staging: {
      ...completionStagingValue,
      ...(options.completionStagingSourcePath === undefined ? {} : { sourcePath: options.completionStagingSourcePath }),
      ...(options.completionStagingDestinationPath === undefined ? {} : { destinationPath: options.completionStagingDestinationPath }),
      ...(options.extraCompletionField === 'staging' ? { unsafeExtra: true } : {}),
    },
    logs: { runner: completionLogs.runner, docker: completionLogs.docker, verifiedAt: completionLogsVerifiedAt, ...(options.extraCompletionField === 'logs' ? { unsafeExtra: true } : {}) },
    ...(options.includeEgress === false ? {} : {
      egress: {
        persistedDocker: null,
        discoveredDocker: [],
        credentials: [],
        globalLabelResult: 'no-match',
        ...(options.extraEgressField === true ? { unsafeExtra: true } : {}),
      },
    }),
    blocker: 'none',
  };
  if (options.updateJob !== false) {
    db.prepare(`UPDATE jobs SET state='interrupted', queue_state='complete', queue_position=NULL,
      dispatched_at=?, runner_unit=?, runner_lease_owner=?, runner_lease_expires_at=?, runner_started_at=?,
      terminal_error_code='RUNNER_DISAPPEARED', terminal_error_json='{}', terminal_at=?
      WHERE job_id=?`).run(
      dispatchedAt, runnerUnit, LEGACY_RUNNER_OWNER, runnerLeaseExpiresAt, runnerStartedAt, options.terminalAt ?? handbackAt, jobId,
    );
  }
  if (options.currentStagingState === 'pre-handback') {
    db.prepare(`UPDATE jobs SET publish_state='staged', artifact_staging_path=?, artifact_sha256=?, artifact_size=?, artifact_mtime=?,
      checksum_path=?, checksum_sha256=?, manifest_path=?, manifest_sha256=?, verification_path=?, verification_sha256=? WHERE job_id=?`).run(
      `staging/${jobId}`, HASH64, 100, '2026-08-01T12:00:00.000Z',
      `staging/${jobId}/sha256sums`, HASH64, `staging/${jobId}/build-manifest.json`, HASH64,
      `staging/${jobId}/verification.json`, HASH64, jobId,
    );
  } else if (options.currentStagingState === 'quarantined') {
    const trackedIdentity = options.currentStagingIdentity === undefined
      ? admissionStaging === 'present'
      : options.currentStagingIdentity === 'tracked';
    db.prepare(`UPDATE jobs SET publish_state='quarantined', artifact_staging_path=NULL, artifact_quarantine_path=?,
      artifact_sha256=?, artifact_size=?, artifact_mtime=?, checksum_path=?, checksum_sha256=?,
      manifest_path=?, manifest_sha256=?, verification_path=?, verification_sha256=? WHERE job_id=?`).run(
      `quarantine/${jobId}`,
      trackedIdentity ? HASH64 : null,
      trackedIdentity ? 100 : null,
      trackedIdentity ? '2026-08-01T12:00:00.000Z' : null,
      trackedIdentity ? `staging/${jobId}/sha256sums` : null,
      trackedIdentity ? HASH64 : null,
      trackedIdentity ? `staging/${jobId}/build-manifest.json` : null,
      trackedIdentity ? HASH64 : null,
      trackedIdentity ? `staging/${jobId}/verification.json` : null,
      trackedIdentity ? HASH64 : null,
      jobId,
    );
  }
  for (const stream of ['runner', 'docker'] as const) {
    for (const generation of persistedGenerationIdentity[stream]) {
      if (!db.prepare('SELECT 1 FROM job_log_generations WHERE job_id=? AND stream=? AND generation=?').get(jobId, stream, generation.generation)) {
        db.prepare(`INSERT INTO job_log_generations (job_id, stream, generation, path, started_at, sealed_at, size_bytes, sha256)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?)`).run(jobId, stream, generation.generation, generation.path, generation.startedAt, '2026-08-01T12:24:40.100Z', HASH64);
      }
    }
  }
  db.prepare(`INSERT INTO cleanup_leases (
    admission_id, job_id, unit_name, owner, expires_at, status, credential_relative_path, credential_sha256,
    fence_generation, fence_token_hash, stale_runner_unit, stale_runner_owner, stale_runner_lease_expires_at,
    stale_state, stale_container_id, stale_container_name, stale_container_labels_json, proof_json,
    completion_evidence_path, completion_evidence_sha256, admitted_at, claim_at, complete_at, handback_at
  ) VALUES (?, ?, ?, 'cleanup-worker', ?, 'handed_back', ?, ?, ?, ?, ?, ?, ?, 'release_gates', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    admissionId, jobId, cleanupUnit, options.cleanupLeaseExpiresAt ?? '2026-08-03T01:00:00.000Z',
    `recovery/cleanup-credentials/${admissionId}.token`, HASH64, fenceGeneration, fenceGeneration === 1 ? 'c'.repeat(64) : 'e'.repeat(64),
    runnerUnit, LEGACY_RUNNER_OWNER, runnerLeaseExpiresAt, containerId, containerName, JSON.stringify(containerLabels), JSON.stringify(snapshot),
    evidencePath, HASH64, admittedAt, claimAt, completeAt, handbackAt,
  );
  if (options.recoveryEventSeq !== undefined) {
    db.exec('DROP TRIGGER job_events_append_guard');
  }
  db.prepare(`INSERT INTO job_events (job_id, seq, event_type, state, stage, payload_json, at)
    VALUES (?, ?, 'cleanup_complete', 'release_gates', NULL, ?, ?),
           (?, ?, 'recovery', 'interrupted', NULL, ?, ?)`).run(
    jobId, eventSeqBase, JSON.stringify({ admissionId, evidencePath, postcondition }), completeAt,
    jobId, recoveryEventSeq, JSON.stringify({ admissionId, state: 'interrupted' }), handbackAt,
  );
  if (options.recoveryEventSeq !== undefined) {
    db.exec(JOB_EVENTS_APPEND_GUARD_SQL);
  }
}

function expectMigration21Rollback(path: string, jobId: string): void {
  expectMigrationError(
    () => openBuilderDatabase(path),
    /legacy builder identity is active or dispatched before migration 021/u,
  );
  const unchanged = new DatabaseSync(path);
  expect(unchanged.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 20 });
  expect(unchanged.prepare(`SELECT builder_identity_status, runner_lease_owner, runner_finished_at
    FROM jobs WHERE job_id=?`).get(jobId)).toEqual({
    builder_identity_status: 'admitted',
    runner_lease_owner: LEGACY_RUNNER_OWNER,
    runner_finished_at: null,
  });
  expect(unchanged.prepare("SELECT 1 AS present FROM pragma_table_info('jobs') WHERE name='builder_dependency_egress_proxy_sha256'").get()).toBeUndefined();
  unchanged.close();
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
      { version: 13, filename: '013_queue_dispatch_claim.sql' },
      { version: 14, filename: '014_retention_prunes.sql' },
      { version: 15, filename: '015_retention_prune_target_identity.sql' },
      { version: 16, filename: '016_log_gap_source_seq_unique.sql' },
      { version: 17, filename: '017_publish_blocker_recheck.sql' },
      { version: 18, filename: '018_release_seal_status.sql' },
      { version: 19, filename: '019_job_builder_identity.sql' },
      { version: 20, filename: '020_complete_builder_identity.sql' },
      { version: 21, filename: '021_dependency_egress_proxy_identity.sql' },
      { version: 22, filename: '022_audit_dependency_egress_recovery.sql' },
    ]);
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name))
      .toEqual(['cleanup_credential_reservations', 'cleanup_leases', 'cleanup_stop_authorization_heads', 'cleanup_stop_authorization_outcomes', 'cleanup_stop_authorizations', 'job_events', 'job_log_generations', 'job_operations', 'job_stages', 'jobs', 'legacy_blocked_publish_evidence', 'publish_blocker_rechecks', 'queue_dispatch_claims', 'queue_entries', 'retention_prune_intents', 'retention_prunes', 'retention_purge_authorizations', 'schema_migrations', 'sqlite_sequence']);
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
      'release_seal_status',
      'builder_package_version', 'builder_image_reference', 'builder_image_id', 'builder_image_digest',
      'builder_identity_status', 'builder_package_root', 'builder_lock_sha256',
      'builder_execution_definition_sha256', 'builder_target_manifest_sha256',
      'builder_runner_sha256', 'builder_cleanup_worker_sha256',
      'builder_dependency_egress_proxy_sha256',
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
    expectColumns(db, 'queue_dispatch_claims', ['claim_id', 'job_id', 'owner', 'claimed_at', 'lease_expires_at', 'phase', 'start_attempted_at', 'unit_inactive_at']);
    expectColumns(db, 'retention_prune_intents', ['intent_id', 'category', 'relative_path', 'status', 'planned_at', 'updated_at', 'bytes', 'error', 'target_dev', 'target_ino']);
    expect(() => db.prepare(`INSERT INTO retention_prune_intents
      (category, relative_path, status, planned_at, updated_at, bytes, target_dev)
      VALUES ('quarantine', '.osi-image-builder/quarantine/partial-identity', 'planned', ?, ?, 0, 1)`)
      .run('2026-07-28T12:00:00.000Z', '2026-07-28T12:00:00.000Z'))
      .toThrow(/CHECK constraint failed/u);
    expectColumns(db, 'job_events', [
      'job_id', 'seq', 'event_type', 'state', 'stage', 'payload_json', 'at', 'stream', 'file_generation',
      'byte_offset', 'byte_length', 'partial',
    ]);

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all()
      .map((row) => (row as { name: string }).name);
    expect(indexes.sort()).toEqual([
      'cleanup_credential_reservations_expiry', 'cleanup_credential_reservations_job_path', 'cleanup_leases_expiry', 'cleanup_leases_fence_identity', 'cleanup_leases_fence_token_identity', 'cleanup_leases_job', 'cleanup_stop_authorization_outcomes_admission', 'cleanup_stop_authorizations_admission', 'cleanup_stop_authorizations_expiry', 'job_events_cancellation_protocol', 'job_events_log_gap_source_seq', 'job_events_log_range', 'job_events_sequence', 'job_log_generations_active', 'job_operations_identity',
      'job_stages_job', 'jobs_cleanup_admission', 'jobs_recovery', 'queue_dispatch_claims_expiry', 'queue_entries_fifo', 'retention_prune_intents_status', 'retention_prunes_at',
    ]);
    const normalizeForeignKeys = (child: string) => db.prepare(`PRAGMA foreign_key_list(${child})`).all()
      .map((row) => {
        const value = row as { table: string; from: string; to: string; on_delete: string; on_update: string };
        return { table: value.table, from: value.from, to: value.to, on_delete: value.on_delete, on_update: value.on_update };
      });
    expect(normalizeForeignKeys('queue_entries')).toEqual([{ table: 'jobs', from: 'job_id', to: 'job_id', on_delete: 'RESTRICT', on_update: 'RESTRICT' }]);
    expect(normalizeForeignKeys('queue_dispatch_claims')).toEqual([{ table: 'jobs', from: 'job_id', to: 'job_id', on_delete: 'RESTRICT', on_update: 'RESTRICT' }]);
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
    expect(normalizeForeignKeys('publish_blocker_rechecks')).toEqual([
      { table: 'job_events', from: 'job_id', to: 'job_id', on_delete: 'RESTRICT', on_update: 'RESTRICT' },
      { table: 'job_events', from: 'event_seq', to: 'seq', on_delete: 'RESTRICT', on_update: 'RESTRICT' },
      { table: 'jobs', from: 'job_id', to: 'job_id', on_delete: 'RESTRICT', on_update: 'RESTRICT' },
    ]);
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
      'cleanup_stop_authorization_heads_delete_guard',
      'cleanup_stop_authorization_outcomes_delete_guard', 'cleanup_stop_authorization_outcomes_identity_guard', 'cleanup_stop_authorization_outcomes_immutable_guard',
      'cleanup_leases_stop_authorization_columns_guard', 'cleanup_leases_stop_authorization_columns_update_guard', 'cleanup_leases_stop_authorization_identity_guard',
      'job_log_generations_immutable_guard', 'job_log_generations_seal_guard', 'job_log_generations_size_guard',
      'job_operations_committed_delete_guard', 'job_operations_committed_update_guard', 'job_operations_manifest_label_guard',
      'job_operations_manifest_label_guard_update', 'jobs_cleanup_generation_guard', 'jobs_container_guard',
      'legacy_blocked_publish_evidence_delete_guard', 'legacy_blocked_publish_evidence_update_guard',
      'publish_blocker_rechecks_delete_guard', 'publish_blocker_rechecks_insert_guard', 'publish_blocker_rechecks_update_guard',
      'jobs_container_guard_update', 'jobs_fence_guard', 'jobs_fence_guard_update', 'jobs_cleanup_blocker_guard',
      'jobs_cleanup_blocker_guard_update', 'jobs_freshness_evidence_pair_guard',
      'jobs_freshness_evidence_pair_guard_update', 'jobs_freshness_guard', 'jobs_freshness_guard_update',
      'jobs_freshness_null_guard', 'jobs_freshness_null_guard_update', 'jobs_freshness_timestamp_guard',
      'jobs_freshness_timestamp_guard_update', 'jobs_publish_guard', 'jobs_publish_guard_insert', 'jobs_publish_null_guard',
      'jobs_publish_null_guard_update', 'jobs_publish_pairs_guard', 'jobs_publish_pairs_guard_update',
      'jobs_release_seal_status_guard', 'jobs_release_seal_status_guard_update',
      'jobs_release_seal_status_legacy_sealed_guard',
      'jobs_builder_identity_guard', 'jobs_builder_identity_guard_update',
      'jobs_builder_proxy_identity_guard',
      'jobs_request_immutable_guard', 'jobs_runner_lease_guard', 'jobs_runner_lease_guard_update',
      'jobs_offline_feed_preparation_immutable_guard', 'jobs_offline_feed_preparation_insert_guard',
      'jobs_source_preparation_immutable_guard', 'jobs_source_preparation_insert_guard', 'jobs_terminal_guard',
      'jobs_terminal_guard_update',
    ].sort());
    db.close();
  });

  it('migrates legacy jobs with a null builder identity into an immutable blocked identity', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    for (const migration of MIGRATION_REGISTRY.slice(0, 18)) {
      historical.exec(await readFile(join(repoMigrationDir, migration.filename), 'utf8'));
      historical.prepare('INSERT INTO schema_migrations (version, filename, sha256, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.filename, migration.sha256, '2026-07-23T00:00:00.000Z');
    }
    insertValidJob(historical, 'legacy-builder');
    historical.close();

    const upgraded = openBuilderDatabase(path);
    expect(upgraded.prepare(`SELECT builder_identity_status, builder_package_version, builder_image_reference, builder_image_id, builder_image_digest
      FROM jobs WHERE job_id='legacy-builder'`).get()).toEqual({
      builder_identity_status: 'legacy_blocked',
      builder_package_version: null,
      builder_image_reference: null,
      builder_image_id: null,
      builder_image_digest: null,
    });
    expect(() => upgraded.prepare("UPDATE jobs SET builder_package_version='0.1.24' WHERE job_id='legacy-builder'").run())
      .toThrow(/builder identity/iu);
    expect(() => upgraded.prepare(`UPDATE jobs SET builder_identity_status='admitted', builder_package_version='0.1.24',
      builder_package_root='/home/builder/.local/lib/osi-image-builder/0.1.24', builder_lock_sha256='${'1'.repeat(64)}',
      builder_execution_definition_sha256='${'2'.repeat(64)}', builder_target_manifest_sha256='${HASH64}',
      builder_runner_sha256='${'5'.repeat(64)}', builder_cleanup_worker_sha256='${'6'.repeat(64)}',
      builder_image_reference='registry.example.invalid/osi-image-builder@sha256:${'c'.repeat(64)}',
      builder_image_id='sha256:${'d'.repeat(64)}', builder_image_digest='${'c'.repeat(64)}'
      WHERE job_id='legacy-builder'`).run())
      .toThrow(/builder identity.*immutable/iu);
    upgraded.close();
  });

  it('blocks legacy incomplete identities during upgrade and requires complete identity on every new insert', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    for (const migration of MIGRATION_REGISTRY.slice(0, 19)) {
      historical.exec(await readFile(join(repoMigrationDir, migration.filename), 'utf8'));
      historical.prepare('INSERT INTO schema_migrations (version, filename, sha256, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.filename, migration.sha256, '2026-08-03T00:00:00.000Z');
    }
    insertValidJob(historical, 'legacy-null-builder');
    historical.prepare('INSERT INTO queue_entries (job_id, fifo_seq, enqueued_at) VALUES (?, ?, ?)')
      .run('legacy-null-builder', 0, '2026-08-03T00:00:00.000Z');
    historical.close();

    const upgraded = openBuilderDatabase(path, { now: () => '2026-08-03T00:01:00.000Z' });
    expect(upgraded.prepare(`SELECT state, queue_state, queue_position, terminal_error_code, terminal_error_json
      FROM jobs WHERE job_id='legacy-null-builder'`).get()).toEqual({
      state: 'interrupted',
      queue_state: 'complete',
      queue_position: null,
      terminal_error_code: 'BUILDER_DIGEST_MISMATCH',
      terminal_error_json: JSON.stringify({
        reason: 'legacy job has no complete admitted builder identity',
        recovery: 'reenqueue-required',
      }),
    });
    expect(upgraded.prepare("SELECT COUNT(*) AS count FROM queue_entries WHERE job_id='legacy-null-builder'").get())
      .toEqual({ count: 0 });
    expect(() => insertValidJob(upgraded, 'new-null-builder', 'queued', false)).toThrow(/builder identity/iu);
    upgraded.close();
  });

  it('normalizes a populated migration-019 four-field identity into the canonical legacy-blocked shape', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 19);
    insertValidJob(historical, 'migration-019-four-field');
    historical.prepare(`UPDATE jobs SET
      builder_package_version=?, builder_image_reference=?, builder_image_id=?, builder_image_digest=?
      WHERE job_id=?`).run(
      '0.1.23',
      `registry.example.invalid/osi-image-builder@sha256:${'3'.repeat(64)}`,
      `sha256:${'4'.repeat(64)}`,
      '3'.repeat(64),
      'migration-019-four-field',
    );
    historical.close();

    const upgraded = openBuilderDatabase(path);
    expect(upgraded.prepare(`SELECT builder_identity_status, builder_package_version, builder_package_root,
      builder_lock_sha256, builder_execution_definition_sha256, builder_target_manifest_sha256,
      builder_runner_sha256, builder_cleanup_worker_sha256, builder_image_reference,
      builder_image_id, builder_image_digest
      FROM jobs WHERE job_id='migration-019-four-field'`).get()).toEqual({
      builder_identity_status: 'legacy_blocked',
      builder_package_version: null,
      builder_package_root: null,
      builder_lock_sha256: null,
      builder_execution_definition_sha256: null,
      builder_target_manifest_sha256: null,
      builder_runner_sha256: null,
      builder_cleanup_worker_sha256: null,
      builder_image_reference: null,
      builder_image_id: null,
      builder_image_digest: null,
    });
    upgraded.close();
  });

  it('blocks migration-020 identities that do not bind the dependency egress proxy runtime', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    insertValidJob(historical, 'migration-020-unbound-proxy');
    historical.prepare('INSERT INTO queue_entries (job_id, fifo_seq, enqueued_at) VALUES (?, ?, ?)')
      .run('migration-020-unbound-proxy', 0, '2026-08-03T00:00:00.000Z');
    historical.close();

    const upgraded = openBuilderDatabase(path);
    expect(upgraded.prepare(`SELECT builder_identity_status, builder_dependency_egress_proxy_sha256,
      state, queue_state, terminal_error_code FROM jobs WHERE job_id='migration-020-unbound-proxy'`).get())
      .toEqual({
        builder_identity_status: 'legacy_blocked',
        builder_dependency_egress_proxy_sha256: null,
        state: 'interrupted',
        queue_state: 'complete',
        terminal_error_code: 'BUILDER_DIGEST_MISMATCH',
      });
    upgraded.close();
  });

  it('opens a database with the historically applied v21 bytes without checksum drift', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const migration = MIGRATION_REGISTRY[20]!;
    const bytes = await readFile(join(repoMigrationDir, migration.filename));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(HISTORICAL_V21_SHA256);
    historical.exec(bytes.toString());
    historical.prepare('INSERT INTO schema_migrations (version, filename, sha256, applied_at) VALUES (?, ?, ?, ?)')
      .run(migration.version, migration.filename, HISTORICAL_V21_SHA256, '2026-08-03T00:00:00.000Z');
    historical.close();

    const upgraded = openBuilderDatabase(path);
    expect(upgraded.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
      .toEqual({ version: MIGRATION_REGISTRY.length });
    upgraded.close();
  });

  it('fails closed on a historical v21 candidate that was weakly reconciled', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-021-weakly-reconciled-candidate';
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, {
      admittedAt: '2026-08-01T12:24:41Z',
    });
    historical.close();

    const v21 = new DatabaseSync(path);
    const migration = MIGRATION_REGISTRY[20]!;
    v21.exec(await readFile(join(repoMigrationDir, migration.filename), 'utf8'));
    v21.prepare('INSERT INTO schema_migrations (version, filename, sha256, applied_at) VALUES (?, ?, ?, ?)')
      .run(migration.version, migration.filename, migration.sha256, '2026-08-03T00:00:00.000Z');
    expect(v21.prepare(`SELECT runner_finished_at, runner_lease_owner, builder_identity_status
      FROM jobs WHERE job_id=?`).get(jobId)).toEqual({
      runner_finished_at: '2026-08-01T12:24:41.520Z',
      runner_lease_owner: null,
      builder_identity_status: 'legacy_blocked',
    });
    v21.close();

    expectMigrationError(
      () => openBuilderDatabase(path),
      /unproven historical dependency-egress recovery/u,
    );
    const unchanged = new DatabaseSync(path);
    expect(unchanged.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 21 });
    unchanged.close();
  });

  it('rejects active v20 work before migration 021 can null its builder identity', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    insertValidJob(historical, 'migration-020-active-runner', 'building');
    historical.prepare(`UPDATE jobs SET queue_state='dispatched', dispatched_at=?, runner_unit=?,
      runner_lease_owner=?, runner_lease_expires_at=?, runner_started_at=? WHERE job_id=?`).run(
      '2026-08-03T00:00:01.000Z',
      'osi-image-builder-runner@migration-020-active-runner.service',
      'runner-live',
      '2026-08-03T01:00:00.000Z',
      '2026-08-03T00:00:02.000Z',
      'migration-020-active-runner',
    );
    historical.close();

    expectMigrationError(
      () => openBuilderDatabase(path),
      /legacy builder identity is active or dispatched/u,
    );
    const unchanged = new DatabaseSync(path);
    expect(unchanged.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 20 });
    expect(unchanged.prepare(`SELECT builder_identity_status, builder_package_version
      FROM jobs WHERE job_id='migration-020-active-runner'`).get()).toEqual({
      builder_identity_status: 'admitted',
      builder_package_version: '0.1.24',
    });
    expect(unchanged.prepare("SELECT 1 AS present FROM pragma_table_info('jobs') WHERE name='builder_dependency_egress_proxy_sha256'").get()).toBeUndefined();
    unchanged.close();
  });

  it('reconciles a terminal v20 job whose handed-back cleanup proof proves runner and exact container absence', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    insertValidJob(historical, 'migration-020-handed-back');
    insertHandedBackCleanupProof(historical, 'migration-020-handed-back');
    historical.close();

    const upgraded = openBuilderDatabase(path);
    expect(upgraded.prepare(`SELECT builder_identity_status, state, queue_state, runner_unit,
      runner_lease_owner, runner_lease_expires_at, runner_started_at, runner_finished_at
      FROM jobs WHERE job_id='migration-020-handed-back'`).get()).toEqual({
      builder_identity_status: 'legacy_blocked',
      state: 'interrupted',
      queue_state: 'complete',
      runner_unit: 'osi-image-builder-runner@migration-020-handed-back.service',
      runner_lease_owner: null,
      runner_lease_expires_at: null,
      runner_started_at: '2026-07-30T16:47:40.685Z',
      runner_finished_at: '2026-08-01T12:24:41.520Z',
    });
    expect(upgraded.prepare('SELECT status, complete_at, handback_at, completion_evidence_path, completion_evidence_sha256 FROM cleanup_leases WHERE job_id=?').get('migration-020-handed-back')).toMatchObject({
      status: 'handed_back',
      complete_at: '2026-08-01T12:24:41.520Z',
      handback_at: '2026-08-01T12:24:49.169Z',
      completion_evidence_path: `jobs/migration-020-handed-back/evidence/cleanup/${ADMISSION_ID}.complete.json`,
      completion_evidence_sha256: HASH64,
    });
    upgraded.close();
  });

  it('accepts the real persisted snapshot and removed-container completion shapes', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-020-real-production-shapes';
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, { eventContainerKind: 'removed' });

    historical.close();
    const upgraded = openBuilderDatabase(path);
    expect(upgraded.prepare('SELECT runner_finished_at FROM jobs WHERE job_id=?').get(jobId)).toEqual({ runner_finished_at: '2026-08-01T12:24:41.520Z' });
    upgraded.close();
  });

  it('accepts a populated persisted generation identity and removed-container completion', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-020-generation-identity';
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, {
      eventContainerKind: 'removed',
      generationIdentity: {
        runner: [{ generation: 0, path: 'logs/runner-0.log', startedAt: '2026-08-01T12:24:40.000Z' }],
        docker: [{ generation: 0, path: 'logs/docker-0.log', startedAt: '2026-08-01T12:24:40.000Z' }],
      },
    });
    historical.close();

    const upgraded = openBuilderDatabase(path);
    expect(upgraded.prepare('SELECT runner_finished_at FROM jobs WHERE job_id=?').get(jobId)).toEqual({ runner_finished_at: '2026-08-01T12:24:41.520Z' });
    upgraded.close();
  });

  it('accepts non-empty sealed log generations with contiguous event coverage', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-020-nonempty-log-coverage';
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId);
    replacePersistedLogCoverage(historical, jobId, [
      { stream: 'runner', generation: 0, byteLengths: [2, 3] },
      { stream: 'docker', generation: 0, byteLengths: [4, 1] },
    ]);
    historical.close();

    const upgraded = openBuilderDatabase(path);
    expect(upgraded.prepare('SELECT runner_finished_at FROM jobs WHERE job_id=?').get(jobId))
      .toEqual({ runner_finished_at: '2026-08-01T12:24:41.520Z' });
    upgraded.close();
  });

  it.each([
    ['gap', "UPDATE job_events SET byte_offset=byte_offset+1 WHERE job_id=? AND stream='runner' AND seq=1"],
    ['overlap', "UPDATE job_events SET byte_offset=byte_offset-1 WHERE job_id=? AND stream='runner' AND seq=1"],
    ['event before generation', "UPDATE job_events SET at='2026-08-01T12:24:39.999Z' WHERE job_id=? AND stream='runner' AND seq=0"],
    ['log gap event', "UPDATE job_events SET event_type='log-gap' WHERE job_id=? AND stream='runner' AND seq=0"],
  ])('rejects non-empty sealed log coverage with a %s', async (caseName, mutation) => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = `migration-020-invalid-log-coverage-${caseName.replaceAll(' ', '-')}`;
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId);
    replacePersistedLogCoverage(historical, jobId, [
      { stream: 'runner', generation: 0, byteLengths: [2, 3] },
      { stream: 'docker', generation: 0, byteLengths: [4, 1] },
    ]);
    mutatePersistedLogEvent(historical, mutation, jobId);
    historical.close();

    expectMigration21Rollback(path, jobId);
  });

  it('rejects a duplicate-offset overlap balanced by a later gap', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-020-balanced-overlap-gap';
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId);
    replacePersistedLogCoverage(historical, jobId, [
      { stream: 'runner', generation: 0, byteLengths: [2, 3, 1] },
      { stream: 'docker', generation: 0, byteLengths: [4, 1] },
    ]);
    mutatePersistedLogEvent(
      historical,
      "UPDATE job_events SET byte_offset=0 WHERE job_id=? AND stream='runner' AND seq=1",
      jobId,
    );
    historical.close();

    expectMigration21Rollback(path, jobId);
  });

  it('accepts a present staging admission only when the tracked identity is quarantined unchanged', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-020-present-staging-valid';
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, {
      admissionStaging: 'present',
      completionStaging: 'quarantined',
      currentStagingState: 'quarantined',
    });
    historical.close();

    const upgraded = openBuilderDatabase(path);
    expect(upgraded.prepare('SELECT runner_finished_at FROM jobs WHERE job_id=?').get(jobId)).toEqual({ runner_finished_at: '2026-08-01T12:24:41.520Z' });
    upgraded.close();
  });

  it('accepts a preparation-intent staging admission whose identity was cleared during hand-back', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-020-present-staging-null-identity';
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, {
      admissionStaging: 'present',
      admissionStagingSha256: null,
      admissionStagingSize: null,
      completionStaging: 'quarantined',
      completionStagingSha256: null,
      completionStagingSize: null,
      currentStagingState: 'quarantined',
      currentStagingIdentity: 'unknown',
    });
    historical.close();

    const upgraded = openBuilderDatabase(path);
    expect(upgraded.prepare(`SELECT runner_finished_at, publish_state, artifact_staging_path,
      artifact_quarantine_path, artifact_sha256, artifact_size, manifest_path, verification_path
      FROM jobs WHERE job_id=?`).get(jobId)).toEqual({
      runner_finished_at: '2026-08-01T12:24:41.520Z',
      publish_state: 'quarantined',
      artifact_staging_path: null,
      artifact_quarantine_path: `quarantine/${jobId}`,
      artifact_sha256: null,
      artifact_size: null,
      manifest_path: null,
      verification_path: null,
    });
    upgraded.close();
  });

  it('rejects a preparation-intent hand-back row that retained artifact identity', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-020-preparation-intent-retained-identity';
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, {
      admissionStaging: 'present',
      admissionStagingSha256: null,
      admissionStagingSize: null,
      completionStaging: 'quarantined',
      completionStagingSha256: null,
      completionStagingSize: null,
      currentStagingState: 'quarantined',
      currentStagingIdentity: 'unknown',
    });
    historical.prepare('UPDATE jobs SET manifest_path=?, manifest_sha256=? WHERE job_id=?')
      .run(`staging/${jobId}/build-manifest.json`, HASH64, jobId);
    historical.close();

    expectMigration21Rollback(path, jobId);
  });

  it('accepts a physical-present staging admission only when it is quarantined without invented identity', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-020-physical-staging-valid';
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, {
      admissionStaging: 'physical-present',
      completionStaging: 'quarantined',
      currentStagingState: 'quarantined',
    });
    historical.close();

    const upgraded = openBuilderDatabase(path);
    expect(upgraded.prepare('SELECT runner_finished_at FROM jobs WHERE job_id=?').get(jobId)).toEqual({ runner_finished_at: '2026-08-01T12:24:41.520Z' });
    upgraded.close();
  });

  it('accepts true absence for both cleanup log streams when persisted identity is empty', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-020-logs-absent-valid';
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, {
      admissionLogs: { runner: 'absent', docker: 'absent' },
      completionLogs: { runner: 'absent', docker: 'absent' },
      generationIdentity: { runner: [], docker: [] },
    });
    historical.close();

    const upgraded = openBuilderDatabase(path);
    expect(upgraded.prepare('SELECT runner_finished_at FROM jobs WHERE job_id=?').get(jobId)).toEqual({ runner_finished_at: '2026-08-01T12:24:41.520Z' });
    upgraded.close();
  });

  it.each([
    ['absent admission quarantined', { admissionStaging: 'absent' as const, completionStaging: 'quarantined' as const, currentStagingState: 'quarantined' as const }],
    ['present admission absent', { admissionStaging: 'present' as const, completionStaging: 'absent' as const }],
    ['present admission wrong hash', { admissionStaging: 'present' as const, completionStaging: 'quarantined' as const, completionStagingSha256: 'c'.repeat(64), currentStagingState: 'quarantined' as const }],
    ['present admission wrong size', { admissionStaging: 'present' as const, completionStaging: 'quarantined' as const, completionStagingSize: 101, currentStagingState: 'quarantined' as const }],
    ['present admission null identity', { admissionStaging: 'present' as const, completionStaging: 'quarantined' as const, completionStagingSha256: null, completionStagingSize: null, currentStagingState: 'quarantined' as const }],
    ['physical admission absent', { admissionStaging: 'physical-present' as const, completionStaging: 'absent' as const }],
    ['physical admission invented identity', { admissionStaging: 'physical-present' as const, completionStaging: 'quarantined' as const, completionStagingSha256: HASH64, completionStagingSize: 100, currentStagingState: 'quarantined' as const }],
  ] satisfies ReadonlyArray<readonly [string, HandedBackCleanupProofOptions]>)('rejects an invalid staging pair: %s', async (caseName, options) => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = `migration-020-staging-invalid-${caseName.replaceAll(' ', '-')}`;
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, options);
    historical.close();

    expectMigration21Rollback(path, jobId);
  });

  it('rejects a pre-handback staging row after durable hand-back evidence', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-020-pre-handback-staging-invalid';
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, {
      admissionStaging: 'present',
      completionStaging: 'quarantined',
      currentStagingState: 'pre-handback',
    });
    historical.close();

    expectMigration21Rollback(path, jobId);
  });

  it.each([
    ['sealed state with empty runner identity', {
      admissionLogs: { runner: 'sealed' as const, docker: 'absent' as const },
      completionLogs: { runner: 'sealed' as const, docker: 'absent' as const },
      generationIdentity: { runner: [], docker: [] },
    }],
    ['absent state with persisted runner identity', {
      admissionLogs: { runner: 'absent' as const, docker: 'absent' as const },
      completionLogs: { runner: 'absent' as const, docker: 'absent' as const },
    }],
    ['sealed runner with absent docker', {
      admissionLogs: { runner: 'sealed' as const, docker: 'absent' as const },
      completionLogs: { runner: 'sealed' as const, docker: 'absent' as const },
      generationIdentity: { runner: DEFAULT_GENERATION_IDENTITY.runner, docker: [] },
    }],
    ['absent runner with sealed docker', {
      admissionLogs: { runner: 'absent' as const, docker: 'sealed' as const },
      completionLogs: { runner: 'absent' as const, docker: 'sealed' as const },
      generationIdentity: { runner: [], docker: DEFAULT_GENERATION_IDENTITY.docker },
    }],
    ['completion state differs from admission', {
      completionLogs: { runner: 'absent' as const, docker: 'sealed' as const },
    }],
  ] satisfies ReadonlyArray<readonly [string, HandedBackCleanupProofOptions]>)('rejects inconsistent persisted or completion log state: %s', async (caseName, options) => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = `migration-020-log-state-invalid-${caseName.replaceAll(' ', '-')}`;
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, options);
    historical.close();

    expectMigration21Rollback(path, jobId);
  });

  it.each([
    ['proof/table path mismatch', {
      generationIdentity: { runner: [{ generation: 0, path: 'logs/runner-proof.log', startedAt: '2026-08-01T12:24:40.000Z' }], docker: DEFAULT_GENERATION_IDENTITY.docker },
      persistedGenerationIdentity: DEFAULT_GENERATION_IDENTITY,
    }],
    ['extra persisted generation', {
      persistedGenerationIdentity: {
        runner: [
          { generation: 0, path: 'logs/runner-0.log', startedAt: '2026-08-01T12:24:40.000Z' },
          { generation: 1, path: 'logs/runner-1.log', startedAt: '2026-08-01T12:24:40.000Z' },
        ],
        docker: DEFAULT_GENERATION_IDENTITY.docker,
      },
    }],
    ['missing persisted generation', {
      generationIdentity: {
        runner: [
          { generation: 0, path: 'logs/runner-0.log', startedAt: '2026-08-01T12:24:40.000Z' },
          { generation: 1, path: 'logs/runner-1.log', startedAt: '2026-08-01T12:24:40.000Z' },
        ],
        docker: DEFAULT_GENERATION_IDENTITY.docker,
      },
      persistedGenerationIdentity: DEFAULT_GENERATION_IDENTITY,
    }],
  ] satisfies ReadonlyArray<readonly [string, HandedBackCleanupProofOptions]>)('rejects a persisted generation identity mismatch: %s', async (caseName, options) => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = `migration-020-generation-mismatch-${caseName.replaceAll(' ', '-')}`;
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, options);
    historical.close();

    expectMigration21Rollback(path, jobId);
  });

  it('rejects 129 persisted log generations split across runner and docker', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-020-generation-total-overflow';
    const generations = {
      runner: Array.from({ length: 65 }, (_, generation) => ({
        generation,
        path: `logs/runner-${generation}.log`,
        startedAt: '2026-08-01T12:24:40.000Z',
      })),
      docker: Array.from({ length: 64 }, (_, generation) => ({
        generation,
        path: `logs/docker-${generation}.log`,
        startedAt: '2026-08-01T12:24:40.000Z',
      })),
    } satisfies GenerationIdentity;
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, { generationIdentity: generations });
    historical.close();

    expectMigration21Rollback(path, jobId);
  });

  it('accepts exactly 8192 persisted log events across the bounded generations', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-020-log-event-boundary';
    const fixture = boundedLogFixture();
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, {
      generationIdentity: fixture.generationIdentity,
    });
    replacePersistedLogCoverage(historical, jobId, fixture.coverage);
    historical.close();

    const upgraded = openBuilderDatabase(path);
    expect(upgraded.prepare('SELECT runner_finished_at FROM jobs WHERE job_id=?').get(jobId))
      .toEqual({ runner_finished_at: '2026-08-01T12:24:41.520Z' });
    upgraded.close();
  }, 120_000);

  it('rejects 8193 persisted log events across the bounded generations', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-020-log-event-overflow';
    const fixture = boundedLogFixture(true);
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, {
      generationIdentity: fixture.generationIdentity,
    });
    replacePersistedLogCoverage(historical, jobId, fixture.coverage);
    historical.close();

    expectMigration21Rollback(path, jobId);
  }, 120_000);

  it('rejects a persisted container admission without blocker=container', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-020-container-blocker-mismatch';
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, { snapshotBlocker: 'none' });
    historical.close();

    expectMigration21Rollback(path, jobId);
  });

  it.each([
    ['admitted after claim', { admittedAt: '2026-08-01T12:24:41.200Z' }],
    ['noncanonical admission time', { admittedAt: '2026-08-01T12:24:41Z' }],
    ['dispatch after runner start', { dispatchedAt: '2026-07-30T16:47:40.700Z' }],
    ['runner snapshot after admission', { snapshotRunnerInactiveAt: '2026-08-01T12:24:41.010Z', snapshotRunnerObservedAt: '2026-08-01T12:24:41.020Z' }],
    ['container snapshot after admission', { snapshotContainerObservedAt: '2026-08-01T12:24:41.010Z' }],
    ['log snapshot after admission', { snapshotLogsVerifiedAt: '2026-08-01T12:24:41.010Z' }],
    ['physical staging snapshot after admission', { admissionStaging: 'physical-present' as const, completionStaging: 'quarantined' as const, currentStagingState: 'quarantined' as const, snapshotStagingObservedAt: '2026-08-01T12:24:41.010Z' }],
    ['completion staging verification after completion', { completionStagingVerifiedAt: '2026-08-01T12:24:41.521Z' }],
    ['completion log verification after completion', { completionLogsVerifiedAt: '2026-08-01T12:24:41.521Z' }],
  ] satisfies ReadonlyArray<readonly [string, HandedBackCleanupProofOptions]>)('rejects cleanup chronology inversion or future bound: %s', async (caseName, options) => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = `migration-020-chronology-invalid-${caseName.replaceAll(' ', '-')}`;
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, options);
    historical.close();

    expectMigration21Rollback(path, jobId);
  });

  it('rejects cleanup admission when runner lease expiry equals admitted_at', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-020-lease-expiry-equals-admission';
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, {
      runnerLeaseExpiresAt: '2026-08-01T12:24:41.000Z',
      snapshotRunnerInactiveAt: '2026-08-01T12:24:41.000Z',
      snapshotRunnerObservedAt: '2026-08-01T12:24:41.000Z',
    });
    historical.close();

    expectMigration21Rollback(path, jobId);
  });

  it('accepts delayed hand-back after cleanup lease expiry', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-020-handback-after-cleanup-expiry';
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, {
      cleanupLeaseExpiresAt: '2026-08-01T12:24:45.000Z',
    });
    historical.close();

    const upgraded = openBuilderDatabase(path);
    expect(upgraded.prepare('SELECT runner_finished_at FROM jobs WHERE job_id=?').get(jobId))
      .toEqual({ runner_finished_at: '2026-08-01T12:24:41.520Z' });
    upgraded.close();
  });

  it.each([
    ['completion at cleanup expiry', {
      completeAt: '2026-08-01T12:24:41.520Z',
      cleanupLeaseExpiresAt: '2026-08-01T12:24:41.520Z',
    }],
    ['completion after cleanup expiry', {
      completeAt: '2026-08-01T12:24:41.521Z',
      cleanupLeaseExpiresAt: '2026-08-01T12:24:41.520Z',
    }],
  ] satisfies ReadonlyArray<readonly [string, HandedBackCleanupProofOptions]>)('rejects cleanup completion %s', async (caseName, options) => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = `migration-020-completion-expiry-${caseName.replaceAll(' ', '-')}`;
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, options);
    historical.close();

    expectMigration21Rollback(path, jobId);
  });

  it('rejects recovery recorded before cleanup completion', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-020-recovery-before-cleanup-completion';
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, { eventSeqBase: 1, recoveryEventSeq: 0 });
    historical.close();

    expectMigration21Rollback(path, jobId);
  });

  it('accepts cleanup completion before a non-adjacent recovery event', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-020-non-adjacent-cleanup-order';
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, { eventSeqBase: 0, recoveryEventSeq: 2 });
    historical.close();

    const upgraded = openBuilderDatabase(path);
    expect(upgraded.prepare('SELECT runner_finished_at FROM jobs WHERE job_id=?').get(jobId))
      .toEqual({ runner_finished_at: '2026-08-01T12:24:41.520Z' });
    upgraded.close();
  });

  it('rejects a handed-back lease whose terminal timestamp no longer matches its recovery event', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-020-event-time-mismatch';
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, { terminalAt: '2026-08-01T12:24:49.168Z' });
    historical.close();

    expectMigration21Rollback(path, jobId);
  });

  it('rejects malformed persisted generation identity entries', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = 'migration-020-malformed-generation';
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, {
      generationIdentity: {
        runner: [{ generation: 1, path: 'logs/runner-0.log', startedAt: '2026-08-01T12:24:40.000Z' }],
        docker: [],
      },
      persistedGenerationIdentity: {
        runner: [{ generation: 0, path: 'logs/runner-0.log', startedAt: '2026-08-01T12:24:40.000Z' }],
        docker: [],
      },
    });
    historical.close();

    expectMigration21Rollback(path, jobId);
  });

  it.each(['container', 'staging', 'logs'] as const)('rejects a completion %s shape with an extra field', async (field) => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = `migration-020-extra-completion-${field}`;
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, { extraCompletionField: field });
    historical.close();

    expectMigration21Rollback(path, jobId);
  });

  it('rejects a terminal v20 job when the handed-back cleanup proof is incomplete', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    insertValidJob(historical, 'migration-020-incomplete-handback');
    insertHandedBackCleanupProof(historical, 'migration-020-incomplete-handback');
    historical.prepare("DELETE FROM job_events WHERE job_id=? AND event_type='cleanup_complete'").run('migration-020-incomplete-handback');
    historical.close();

    expectMigration21Rollback(path, 'migration-020-incomplete-handback');
  });

  it('rejects a terminal v20 job when handed-back cleanup evidence is tampered', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    insertValidJob(historical, 'migration-020-tampered-handback');
    insertHandedBackCleanupProof(historical, 'migration-020-tampered-handback', { globalLabelResult: 'match' });
    historical.close();

    expectMigration21Rollback(path, 'migration-020-tampered-handback');
  });

  it('rejects multiple fully handed-back cleanup generations for one terminal v20 job', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    insertValidJob(historical, 'migration-020-multiple-handbacks');
    insertHandedBackCleanupProof(historical, 'migration-020-multiple-handbacks');
    insertHandedBackCleanupProof(historical, 'migration-020-multiple-handbacks', {
      admissionId: SECOND_ADMISSION_ID,
      fenceGeneration: 2,
      eventSeqBase: 2,
      updateJob: false,
    });
    historical.close();

    expectMigration21Rollback(path, 'migration-020-multiple-handbacks');
  });

  it.each([
    ['owner', { eventRunnerOwner: 'runner-different-owner' }],
    ['lease expiry', { eventRunnerLeaseExpiresAt: '2026-07-30T16:49:27.626Z' }],
  ] satisfies ReadonlyArray<readonly [string, HandedBackCleanupProofOptions]>)('rejects a terminal v20 cleanup proof with mismatched runner %s', async (_field, options) => {
    const path = await temporaryDatabase();
    const jobId = `migration-020-runner-${_field.replace(' ', '-')}`;
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, options);
    historical.close();

    expectMigration21Rollback(path, jobId);
  });

  it.each([
    ['id', { eventContainerId: 'different-container-id' }],
    ['name', { eventContainerName: 'different-container-name' }],
    ['digest', { eventContainerImageDigest: 'f'.repeat(64) }],
    ['labels', { eventContainerLabels: { 'org.osi.image-builder.job-id': 'different-job', 'org.osi.image-builder.manifest-sha': HASH64 } }],
  ] satisfies ReadonlyArray<readonly [string, HandedBackCleanupProofOptions]>)('rejects a terminal v20 cleanup proof with mismatched container %s', async (field, options) => {
    const path = await temporaryDatabase();
    const jobId = `migration-020-container-${field}`;
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, options);
    historical.close();

    expectMigration21Rollback(path, jobId);
  });

  it.each([
    ['malformed runner observation', { runnerInactiveAt: 'not-a-timestamp', runnerObservedAt: 'not-a-timestamp' }],
    ['runner observation before inactivity', { runnerInactiveAt: '2026-08-01T12:24:40.954Z', runnerObservedAt: '2026-08-01T12:24:40.953Z' }],
    ['runner observation after completion', { runnerObservedAt: '2026-08-01T12:24:41.521Z' }],
    ['container observation after completion', { eventContainerObservedAt: '2026-08-01T12:24:41.521Z' }],
  ] satisfies ReadonlyArray<readonly [string, HandedBackCleanupProofOptions]>)('rejects a terminal v20 cleanup proof with %s', async (caseName, options) => {
    const path = await temporaryDatabase();
    const jobId = `migration-020-time-${caseName.replaceAll(' ', '-')}`;
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, options);
    historical.close();

    expectMigration21Rollback(path, jobId);
  });

  it('rejects a terminal v20 cleanup proof without dependency-egress absence evidence', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    insertValidJob(historical, 'migration-020-missing-egress');
    insertHandedBackCleanupProof(historical, 'migration-020-missing-egress', { includeEgress: false });
    historical.close();

    expectMigration21Rollback(path, 'migration-020-missing-egress');
  });

  it('rejects a terminal v20 cleanup proof with an extra dependency-egress field', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    insertValidJob(historical, 'migration-020-extra-egress-field');
    insertHandedBackCleanupProof(historical, 'migration-020-extra-egress-field', { extraEgressField: true });
    historical.close();

    expectMigration21Rollback(path, 'migration-020-extra-egress-field');
  });

  it.each(['root', 'runner', 'container', 'staging', 'logs'] as const)('rejects a terminal v20 cleanup proof with an extra %s snapshot field', async (field) => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    const jobId = `migration-020-extra-snapshot-${field}`;
    insertValidJob(historical, jobId);
    insertHandedBackCleanupProof(historical, jobId, { extraSnapshotField: field });
    historical.close();

    expectMigration21Rollback(path, jobId);
  });

  it('upgrades v19 through v20 but rejects active admitted work before migration 021', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 19);
    let migrationBoundaryCalls = 0;

    expectMigrationError(
      () => openBuilderDatabase(path, {
        beforeMigration: ({ version }) => {
          migrationBoundaryCalls += 1;
          if (version === 21) {
            insertValidJob(historical, 'migration-019-to-020-active', 'building');
            historical.prepare(`UPDATE jobs SET dispatched_at=?, runner_unit=?,
              runner_lease_owner=?, runner_lease_expires_at=?, runner_started_at=? WHERE job_id=?`).run(
              '2026-08-03T00:00:01.000Z',
              'osi-image-builder-runner@migration-019-to-020-active.service',
              'runner-live',
              '2026-08-03T01:00:00.000Z',
              '2026-08-03T00:00:02.000Z',
              'migration-019-to-020-active',
            );
            insertAdmittedLease(historical, 'migration-019-to-020-active');
          }
        },
      }),
      /legacy builder identity is active or dispatched before migration 021/u,
    );

    expect(migrationBoundaryCalls).toBe(2);
    const unchanged = new DatabaseSync(path);
    expect(unchanged.prepare('SELECT COUNT(*) AS count, MAX(version) AS version FROM schema_migrations').get())
      .toEqual({ count: 20, version: 20 });
    expect(unchanged.prepare(`SELECT builder_identity_status, builder_package_version, builder_package_root,
      builder_lock_sha256, builder_execution_definition_sha256, builder_target_manifest_sha256,
      builder_runner_sha256, builder_cleanup_worker_sha256, builder_image_reference,
      builder_image_id, builder_image_digest, state, queue_state, dispatched_at, runner_unit,
      runner_lease_owner, runner_lease_expires_at, runner_started_at, runner_finished_at
      FROM jobs WHERE job_id='migration-019-to-020-active'`).get()).toEqual({
      builder_identity_status: 'admitted',
      builder_package_version: '0.1.24',
      builder_package_root: '/home/builder/.local/lib/osi-image-builder/0.1.24',
      builder_lock_sha256: '1'.repeat(64),
      builder_execution_definition_sha256: '2'.repeat(64),
      builder_target_manifest_sha256: HASH64,
      builder_runner_sha256: '5'.repeat(64),
      builder_cleanup_worker_sha256: '6'.repeat(64),
      builder_image_reference: `registry.example.invalid/osi-image-builder@sha256:${'3'.repeat(64)}`,
      builder_image_id: `sha256:${'4'.repeat(64)}`,
      builder_image_digest: '3'.repeat(64),
      state: 'building',
      queue_state: 'dispatched',
      dispatched_at: '2026-08-03T00:00:01.000Z',
      runner_unit: 'osi-image-builder-runner@migration-019-to-020-active.service',
      runner_lease_owner: 'runner-live',
      runner_lease_expires_at: '2026-08-03T01:00:00.000Z',
      runner_started_at: '2026-08-03T00:00:02.000Z',
      runner_finished_at: null,
    });
    expect(unchanged.prepare(`SELECT admission_id, owner, status, credential_relative_path,
      credential_sha256, fence_generation, fence_token_hash FROM cleanup_leases
      WHERE job_id='migration-019-to-020-active'`).get()).toEqual({
      admission_id: ADMISSION_ID,
      owner: 'builder',
      status: 'admitted',
      credential_relative_path: `recovery/cleanup-credentials/${ADMISSION_ID}.token`,
      credential_sha256: HASH64,
      fence_generation: 1,
      fence_token_hash: 'c'.repeat(64),
    });
    expect(unchanged.prepare("SELECT 1 AS present FROM pragma_table_info('jobs') WHERE name='builder_dependency_egress_proxy_sha256'").get()).toBeUndefined();
    unchanged.close();
  });

  it('fails closed when migration-020 left an active cross-version cleanup lease', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 20);
    insertValidJob(historical, 'migration-020-active-cleanup');
    historical.prepare(`UPDATE jobs SET state='interrupted', queue_state='complete', queue_position=NULL,
      terminal_error_code='RUNNER_DISAPPEARED', terminal_error_json='{}', terminal_at=updated_at
      WHERE job_id='migration-020-active-cleanup'`).run();
    insertAdmittedLease(historical, 'migration-020-active-cleanup');
    historical.close();

    expectMigrationError(
      () => openBuilderDatabase(path),
      /legacy.*(?:cleanup|active)|(?:cleanup|active).*legacy/iu,
    );
  });

  it.each([
    'starting',
    'preflight',
    'source',
    'release_gates',
    'frontend',
    'target_setup',
    'feeds',
    'config',
    'building',
    'verifying',
    'publishing',
    'cancel_requested',
  ] as const)('fails closed during upgrade when a legacy-null %s job has a live dispatched runner', async (state) => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 19);
    insertValidJob(historical, `legacy-live-${state}`, state);
    historical.prepare(`UPDATE jobs SET dispatched_at=?, runner_unit=?, runner_lease_owner=?,
      runner_lease_expires_at=?, runner_started_at=? WHERE job_id=?`).run(
      '2026-08-03T00:00:01.000Z',
      `osi-image-builder-runner@legacy-live-${state}.service`,
      'runner-live',
      '2026-08-03T01:00:00.000Z',
      '2026-08-03T00:00:02.000Z',
      `legacy-live-${state}`,
    );
    historical.close();

    let opened: DatabaseSync | undefined;
    let error: unknown;
    try {
      opened = openBuilderDatabase(path);
    } catch (caught) {
      error = caught;
    } finally {
      opened?.close();
    }
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as Error).message).toMatch(/legacy.*(?:dispatched|active)|(?:dispatched|active).*legacy/iu);
  });

  it('preserves a terminal legacy job with a fully finished historical runner record', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    await applyRegisteredMigrations(historical, 19);
    insertValidJob(historical, 'legacy-finished-runner');
    historical.prepare(`UPDATE jobs SET state='failed', queue_state='complete', queue_position=NULL,
      dispatched_at=?, runner_unit=?, runner_started_at=?, runner_finished_at=?, terminal_at=?,
      terminal_error_code='BUILD_FAILED', terminal_error_json='{"legacy":true}'
      WHERE job_id=?`).run(
      '2026-08-03T00:00:01.000Z',
      'osi-image-builder-runner@legacy-finished-runner.service',
      '2026-08-03T00:00:02.000Z',
      '2026-08-03T00:00:03.000Z',
      '2026-08-03T00:00:03.000Z',
      'legacy-finished-runner',
    );
    historical.close();

    const upgraded = openBuilderDatabase(path);
    expect(upgraded.prepare(`SELECT state, queue_state, runner_unit, runner_finished_at,
      builder_identity_status FROM jobs WHERE job_id='legacy-finished-runner'`).get()).toEqual({
      state: 'failed',
      queue_state: 'complete',
      runner_unit: 'osi-image-builder-runner@legacy-finished-runner.service',
      runner_finished_at: '2026-08-03T00:00:03.000Z',
      builder_identity_status: 'legacy_blocked',
    });
    upgraded.close();
  });

  it('makes direct SQL builder-identity acceptance exactly match the runtime parser', async () => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    const digest = '3'.repeat(64);
    const base: BuilderIdentity = {
      packageVersion: '0.1.24',
      packageRoot: '/home/builder/.local/lib/osi-image-builder/0.1.24',
      lockSha256: '1'.repeat(64),
      executionDefinitionSha256: '2'.repeat(64),
      targetManifestSha256: HASH64,
      runnerSha256: '5'.repeat(64),
      cleanupWorkerSha256: '6'.repeat(64),
      dependencyEgressProxySha256: '7'.repeat(64),
      imageReference: `registry.example.invalid/osi-image-builder@sha256:${digest}`,
      imageId: `sha256:${'4'.repeat(64)}`,
      imageDigest: digest,
    };
    const valid = [
      base,
      { ...base, packageVersion: 'v1.2.3', packageRoot: '/opt/osi-image-builder/v1.2.3' },
      { ...base, packageVersion: '2026.08.03', packageRoot: '/opt/osi-image-builder/2026.08.03' },
      { ...base, packageVersion: '2026.08.03.1', packageRoot: '/opt/osi-image-builder/2026.08.03.1' },
      { ...base, imageReference: `localhost:5000/org/osi.builder-v1@sha256:${digest}` },
    ];
    const invalid = [
      { ...base, packageVersion: 'latest', packageRoot: '/opt/osi-image-builder/latest' },
      { ...base, packageVersion: '1.2', packageRoot: '/opt/osi-image-builder/1.2' },
      { ...base, packageVersion: 'v1.2.3.4', packageRoot: '/opt/osi-image-builder/v1.2.3.4' },
      { ...base, lockSha256: '0'.repeat(64) },
      { ...base, executionDefinitionSha256: '0'.repeat(64) },
      { ...base, targetManifestSha256: '0'.repeat(64) },
      { ...base, runnerSha256: '0'.repeat(64) },
      { ...base, cleanupWorkerSha256: '0'.repeat(64) },
      { ...base, dependencyEgressProxySha256: '0'.repeat(64) },
      { ...base, imageId: `sha256:${'0'.repeat(64)}` },
      { ...base, imageDigest: '0'.repeat(64), imageReference: `registry.example.invalid/osi-image-builder@sha256:${'0'.repeat(64)}` },
      { ...base, imageReference: `Registry.example.invalid/osi-image-builder@sha256:${digest}` },
      { ...base, imageReference: `registry.example.invalid:01/osi-image-builder@sha256:${digest}` },
      { ...base, imageReference: `registry.example.invalid/osi..image-builder@sha256:${digest}` },
      { ...base, imageReference: `registry.example.invalid/-osi-image-builder@sha256:${digest}` },
      {
        ...base,
        packageRoot: `/opt/${'😀'.repeat(600)}/0.1.24`,
      },
    ];

    valid.forEach((identity, index) => {
      expect(parseBuilderIdentity(identity)).toEqual(identity);
      expect(() => insertValidJob(db, `sql-valid-${index}`, 'queued', true, identity)).not.toThrow();
    });
    invalid.forEach((identity, index) => {
      expect(() => parseBuilderIdentity(identity)).toThrow(/builder identity|image reference/iu);
      expect(() => insertValidJob(db, `sql-invalid-${index}`, 'queued', true, identity)).toThrow(/builder identity/iu);
    });
    db.close();
  });

  it('classifies historical published releases as legacy mutable and active publication as in progress', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    for (const migration of MIGRATION_REGISTRY.slice(0, 17)) {
      historical.exec(await readFile(join(repoMigrationDir, migration.filename), 'utf8'));
      historical.prepare('INSERT INTO schema_migrations (version, filename, sha256, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.filename, migration.sha256, '2026-07-30T00:00:00.000Z');
    }
    const artifact = {
      artifact_sha256: HASH64,
      artifact_size: 100,
      artifact_mtime: '2026-07-30T00:00:01.000Z',
      checksum_path: 'staging/sha256sums',
      checksum_sha256: HASH64,
      manifest_path: 'staging/build-manifest.json',
      manifest_sha256: HASH64,
      verification_path: 'staging/verification.json',
      verification_sha256: HASH64,
    };
    insertValidJob(historical, 'legacy-published');
    historical.prepare(`UPDATE jobs SET
      state='succeeded', current_stage='publish', queue_state='complete', queue_position=NULL,
      terminal_at=?, artifact_staging_path=NULL, artifact_final_directory=?, artifact_final_path=?,
      artifact_sha256=?, artifact_size=?, artifact_mtime=?, checksum_path=?, checksum_sha256=?,
      manifest_path=?, manifest_sha256=?, verification_path=?, verification_sha256=?,
      publish_state='published', publish_started_at=?, published_at=?, updated_at=?
      WHERE job_id=?`).run(
      '2026-07-30T00:00:04.000Z', 'main/sha/rpi-5', 'main/sha/rpi-5/image.gz',
      artifact.artifact_sha256, artifact.artifact_size, artifact.artifact_mtime,
      artifact.checksum_path, artifact.checksum_sha256, artifact.manifest_path,
      artifact.manifest_sha256, artifact.verification_path, artifact.verification_sha256,
      '2026-07-30T00:00:02.000Z', '2026-07-30T00:00:03.000Z',
      '2026-07-30T00:00:04.000Z', 'legacy-published',
    );
    insertValidJob(historical, 'interrupted-seal');
    historical.prepare(`UPDATE jobs SET
      state='publishing', current_stage='publish', queue_state='dispatched', queue_position=NULL,
      artifact_staging_path=?, artifact_final_directory=?, artifact_final_path=?,
      artifact_sha256=?, artifact_size=?, artifact_mtime=?, checksum_path=?, checksum_sha256=?,
      manifest_path=?, manifest_sha256=?, verification_path=?, verification_sha256=?,
      publish_state='publishing', publish_started_at=?, updated_at=?
      WHERE job_id=?`).run(
      'staging/interrupted-seal/image.gz', 'main/sha/rpi-5', 'main/sha/rpi-5/image.gz',
      artifact.artifact_sha256, artifact.artifact_size, artifact.artifact_mtime,
      artifact.checksum_path, artifact.checksum_sha256, artifact.manifest_path,
      artifact.manifest_sha256, artifact.verification_path, artifact.verification_sha256,
      '2026-07-30T00:00:02.000Z', '2026-07-30T00:00:02.000Z', 'interrupted-seal',
    );
    historical.prepare(`UPDATE jobs SET
      state='cancel_requested', cancel_requested_at=?, cancel_reason=?, updated_at=?
      WHERE job_id=?`).run(
      '2026-07-30T00:00:03.000Z', 'operator cancellation',
      '2026-07-30T00:00:03.000Z', 'interrupted-seal',
    );
    historical.close();

    expectMigrationError(
      () => openBuilderDatabase(path),
      /legacy.*(?:dispatched|active)|(?:dispatched|active).*legacy/iu,
    );
    const upgraded = new DatabaseSync(path);
    expect(upgraded.prepare('SELECT job_id, release_seal_status FROM jobs ORDER BY job_id').all()).toEqual([
      { job_id: 'interrupted-seal', release_seal_status: 'in_progress' },
      { job_id: 'legacy-published', release_seal_status: 'legacy_mutable' },
    ]);
    expect(() => upgraded.prepare("UPDATE jobs SET release_seal_status='sealed' WHERE job_id='interrupted-seal'").run())
      .toThrow(/release seal status is incoherent/u);
    expect(() => upgraded.prepare("UPDATE jobs SET release_seal_status=NULL WHERE job_id='interrupted-seal'").run())
      .toThrow(/release seal status is incoherent/u);
    expect(() => upgraded.prepare("UPDATE jobs SET release_seal_status='sealed' WHERE job_id='legacy-published'").run())
      .toThrow(/legacy mutable release requires audited sealing/u);
    upgraded.close();
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

    expectMigrationError(
      () => openBuilderDatabase(path),
      /legacy.*(?:dispatched|active)|(?:dispatched|active).*legacy/iu,
    );
    const upgraded = new DatabaseSync(path);
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
    expect(second.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 22 });
    second.close();
  });

  it('treats integer, real, and exponent source sequences as one numeric identity', async () => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    insertValidJob(db, 'numeric-source-gap-index', 'building');
    const insert = db.prepare('INSERT INTO job_events (job_id, seq, event_type, payload_json, at) VALUES (?, ?, ?, ?, ?)');

    insert.run('numeric-source-gap-index', 0, 'log-gap', '{"sourceSeq":42}', '2026-07-28T00:00:00.000Z');
    expect(() => insert.run('numeric-source-gap-index', 1, 'log-gap', '{"sourceSeq":42.0}', '2026-07-28T00:00:01.000Z'))
      .toThrow(/UNIQUE constraint failed/u);
    expect(() => insert.run('numeric-source-gap-index', 1, 'log-gap', '{"sourceSeq":42e0}', '2026-07-28T00:00:01.000Z'))
      .toThrow(/UNIQUE constraint failed/u);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='job_events_log_gap_source_seq'").get()).toEqual({ name: 'job_events_log_gap_source_seq' });
    db.close();
  });

  it('excludes boolean source sequences from numeric source-gap uniqueness', async () => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    insertValidJob(db, 'boolean-source-gap-index', 'building');
    const insert = db.prepare('INSERT INTO job_events (job_id, seq, event_type, payload_json, at) VALUES (?, ?, ?, ?, ?)');

    insert.run('boolean-source-gap-index', 0, 'log-gap', '{"sourceSeq":true}', '2026-07-28T00:00:00.000Z');
    insert.run('boolean-source-gap-index', 1, 'log-gap', '{"sourceSeq":1}', '2026-07-28T00:00:01.000Z');
    expect(db.prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id='boolean-source-gap-index'").get()).toEqual({ count: 2 });
    db.close();
  });

  it('excludes text source sequences from source-gap uniqueness', async () => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    insertValidJob(db, 'text-source-gap-index', 'building');
    const insert = db.prepare('INSERT INTO job_events (job_id, seq, event_type, payload_json, at) VALUES (?, ?, ?, ?, ?)');

    insert.run('text-source-gap-index', 0, 'log-gap', '{"sourceSeq":42}', '2026-07-28T00:00:00.000Z');
    insert.run('text-source-gap-index', 1, 'log-gap', '{"sourceSeq":"42"}', '2026-07-28T00:00:01.000Z');
    insert.run('text-source-gap-index', 2, 'log-gap', '{"sourceSeq":"42"}', '2026-07-28T00:00:02.000Z');
    expect(db.prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id='text-source-gap-index'").get()).toEqual({ count: 3 });
    db.close();
  });

  it('allows missing and null source sequences plus non-gap events', async () => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    insertValidJob(db, 'nullable-source-gap-index', 'building');
    const insert = db.prepare('INSERT INTO job_events (job_id, seq, event_type, payload_json, at) VALUES (?, ?, ?, ?, ?)');

    insert.run('nullable-source-gap-index', 0, 'log-gap', '{"orphanKey":"runner:0:0"}', '2026-07-28T00:00:00.000Z');
    insert.run('nullable-source-gap-index', 1, 'log-gap', '{"orphanKey":"runner:0:0"}', '2026-07-28T00:00:01.000Z');
    insert.run('nullable-source-gap-index', 2, 'log-gap', '{"sourceSeq":null}', '2026-07-28T00:00:02.000Z');
    insert.run('nullable-source-gap-index', 3, 'log-gap', '{"sourceSeq":null}', '2026-07-28T00:00:03.000Z');
    insert.run('nullable-source-gap-index', 4, 'recovery', '{"sourceSeq":42}', '2026-07-28T00:00:04.000Z');
    insert.run('nullable-source-gap-index', 5, 'recovery', '{"sourceSeq":42}', '2026-07-28T00:00:05.000Z');
    expect(db.prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id='nullable-source-gap-index'").get()).toEqual({ count: 6 });
    db.close();
  });

  it('does not collapse oversized source sequences that SQLite represents distinctly', async () => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    insertValidJob(db, 'oversized-source-gap-index', 'building');
    const insert = db.prepare('INSERT INTO job_events (job_id, seq, event_type, payload_json, at) VALUES (?, ?, ?, ?, ?)');

    insert.run('oversized-source-gap-index', 0, 'log-gap', '{"sourceSeq":9223372036854775808}', '2026-07-28T00:00:00.000Z');
    insert.run('oversized-source-gap-index', 1, 'log-gap', '{"sourceSeq":9223372036854777856}', '2026-07-28T00:00:01.000Z');
    const represented = db.prepare(`SELECT
      typeof(json_extract(payload_json, '$.sourceSeq')) AS storage_class,
      json_extract(payload_json, '$.sourceSeq') AS source_seq
      FROM job_events WHERE job_id='oversized-source-gap-index' ORDER BY seq`).all() as Array<{
        storage_class: string;
        source_seq: number;
      }>;
    expect(represented.map((row) => row.storage_class)).toEqual(['real', 'real']);
    expect(represented[0]!.source_seq).not.toBe(represented[1]!.source_seq);
    db.close();
  });

  it('preserves failed artifact evidence when an absent final-path blocker is rechecked', async () => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    insertValidJob(db, 'rechecked-absent', 'building');
    const artifact = stagingEvidence();
    db.prepare(`UPDATE jobs SET
      state='failed', queue_state='complete', terminal_at=?, terminal_error_code='PUBLISH_FAILED',
      terminal_error_json='{"reason":"publish recovery failed"}',
      artifact_staging_path=NULL, artifact_sha256=?, artifact_size=?, artifact_mtime=?,
      checksum_path=?, checksum_sha256=?, manifest_path=?, manifest_sha256=?,
      verification_path=?, verification_sha256=?,
      publish_state='blocked', publish_blocker_code='UNVERIFIED_FINAL_PATH_BLOCKER',
      publish_blocker_json='{"binding":{"finalDirectory":"releases/main/rpi-5","finalPath":"releases/main/rpi-5/image.img.gz"},"staging":"absent"}', updated_at=?
      WHERE job_id=?`).run(
      '2026-07-28T00:01:00.000Z',
      artifact.artifact_sha256, artifact.artifact_size, artifact.artifact_mtime,
      artifact.checksum_path, artifact.checksum_sha256,
      artifact.manifest_path, artifact.manifest_sha256,
      artifact.verification_path, artifact.verification_sha256,
      '2026-07-28T00:01:00.000Z',
      'rechecked-absent',
    );

    db.exec('BEGIN IMMEDIATE');
    const proof = JSON.stringify({
      kind: 'destination-absent',
      observedAt: '2026-07-28T00:02:00.000Z',
      publisher: { destination: 'absent', staging: 'absent', mutationCount: 0 },
      finalDirectory: 'releases/main/rpi-5',
      finalPath: 'releases/main/rpi-5/image.img.gz',
    });
    const insertAudit = db.prepare(`INSERT INTO publish_blocker_rechecks (
      job_id, attempt, event_seq, resolution, observed_at, committed_at,
      prior_publish_state, prior_blocker_code, prior_blocker_json,
      artifact_staging_path, artifact_quarantine_path,
      artifact_sha256, artifact_size, artifact_mtime,
      checksum_path, checksum_sha256, manifest_path, manifest_sha256,
      verification_path, verification_sha256, final_directory, final_path,
      published_at, proof_json
    )
    SELECT
      job_id, 1, ?, 'cleared_absent', '2026-07-28T00:02:00.000Z',
      '2026-07-28T00:02:00.000Z', publish_state, publish_blocker_code,
      publish_blocker_json, artifact_staging_path, artifact_quarantine_path,
      artifact_sha256, artifact_size, artifact_mtime, checksum_path, checksum_sha256,
      manifest_path, manifest_sha256, verification_path, verification_sha256,
      NULL, NULL, NULL, ?
    FROM jobs WHERE job_id='rechecked-absent'`);
    const contradictoryProof = JSON.stringify({
      ...JSON.parse(proof),
      publisher: { destination: 'candidate', staging: 'absent', mutationCount: 0 },
    });
    db.prepare(`INSERT INTO job_events (
      job_id, seq, event_type, state, stage, payload_json, at
    ) VALUES (
      'rechecked-absent', 0, 'recovery', 'failed', NULL, ?, '2026-07-28T00:02:00.000Z'
    )`).run(JSON.stringify({
      kind: 'publish-blocker-recheck',
      resolution: 'cleared_absent',
      attempt: 1,
      proof: JSON.parse(contradictoryProof),
    }));
    expect(() => insertAudit.run(0, contradictoryProof)).toThrow(/publish blocker recheck evidence is not bound/u);
    db.prepare(`INSERT INTO job_events (
      job_id, seq, event_type, state, stage, payload_json, at
    ) VALUES (
      'rechecked-absent', 1, 'recovery', 'failed', NULL, ?, '2026-07-28T00:02:00.000Z'
    )`).run(JSON.stringify({
      kind: 'publish-blocker-recheck',
      resolution: 'cleared_absent',
      attempt: 1,
      proof: JSON.parse(proof),
    }));
    insertAudit.run(1, proof);
    db.prepare(`UPDATE jobs SET
      artifact_staging_path=NULL, artifact_quarantine_path=NULL,
      artifact_quarantine_intent_path=NULL, artifact_final_directory=NULL,
      artifact_final_path=NULL, artifact_sha256=NULL, artifact_size=NULL,
      artifact_mtime=NULL, checksum_path=NULL, checksum_sha256=NULL,
      manifest_path=NULL, manifest_sha256=NULL, verification_path=NULL,
      verification_sha256=NULL, publish_state=NULL, publish_started_at=NULL,
      published_at=NULL, publish_blocker_code=NULL, publish_blocker_json=NULL,
      updated_at='2026-07-28T00:02:00.000Z'
      WHERE job_id='rechecked-absent'`).run();
    db.exec('COMMIT');

    expect(db.prepare(`SELECT
      state, terminal_error_code, publish_state, artifact_staging_path,
      artifact_final_directory, artifact_final_path, publish_started_at, published_at,
      publish_blocker_code, publish_blocker_json, artifact_sha256
      FROM jobs WHERE job_id='rechecked-absent'`).get()).toEqual({
      state: 'failed',
      terminal_error_code: 'PUBLISH_FAILED',
      publish_state: null,
      artifact_staging_path: null,
      artifact_final_directory: null,
      artifact_final_path: null,
      publish_started_at: null,
      published_at: null,
      publish_blocker_code: null,
      publish_blocker_json: null,
      artifact_sha256: null,
    });
    expect(db.prepare(`SELECT
      resolution, prior_publish_state, prior_blocker_code, artifact_sha256,
      artifact_size, checksum_sha256, manifest_sha256, verification_sha256,
      final_path, published_at
      FROM publish_blocker_rechecks WHERE job_id='rechecked-absent'`).get()).toEqual({
      resolution: 'cleared_absent',
      prior_publish_state: 'blocked',
      prior_blocker_code: 'UNVERIFIED_FINAL_PATH_BLOCKER',
      artifact_sha256: HASH64,
      artifact_size: 100,
      checksum_sha256: HASH64,
      manifest_sha256: HASH64,
      verification_sha256: HASH64,
      final_path: null,
      published_at: null,
    });
    check(db, "UPDATE publish_blocker_rechecks SET resolution='retained_blocker'", /immutable/u);
    check(db, "DELETE FROM publish_blocker_rechecks WHERE job_id='rechecked-absent'", /immutable/u);
    db.close();
  });

  it.each([
    {
      resolution: 'marked_published',
      finalDirectory: 'releases/main/rpi-5',
      finalPath: 'releases/main/rpi-5/image.img.gz',
      publishedAt: '2026-07-28T00:02:00.000Z',
      proof: {
        kind: 'destination-matches',
        observedAt: '2026-07-28T00:02:00.000Z',
        publisher: { destination: 'candidate', staging: 'absent', mutationCount: 0 },
        finalDirectory: 'releases/main/rpi-5',
        finalPath: 'releases/main/rpi-5/image.img.gz',
        staging: { path: 'staging/rechecked-marked_published', state: 'absent' },
        artifact: {
          sha256: HASH64,
          size: 100,
          mtime: '2026-07-23T00:00:00.000Z',
        },
        checksum: { path: 'releases/main/rpi-5/sha256sums', sha256: HASH64 },
        manifest: { path: 'releases/main/rpi-5/build-manifest.json', sha256: HASH64 },
        verification: { path: 'releases/main/rpi-5/verification.json', sha256: HASH64 },
      },
    },
    {
      resolution: 'retained_blocker',
      finalDirectory: null,
      finalPath: null,
      publishedAt: null,
      proof: {
        kind: 'retained-blocker',
        observedAt: '2026-07-28T00:02:00.000Z',
        reason: 'destination-mismatched',
        publisher: { destination: 'mismatched', staging: 'absent', mutationCount: 0 },
      },
    },
  ])('accepts $resolution only when it is bound to the blocked job and durable event', async ({
    resolution,
    finalDirectory,
    finalPath,
    publishedAt,
    proof,
  }) => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    const jobId = `rechecked-${resolution}`;
    insertValidJob(db, jobId, 'building');
    const artifact = stagingEvidence();
    db.prepare(`UPDATE jobs SET
      state='failed', queue_state='complete', terminal_at=?,
      terminal_error_code='PUBLISH_FAILED', terminal_error_json='{"reason":"publish recovery failed"}',
      artifact_staging_path=NULL, artifact_sha256=?, artifact_size=?, artifact_mtime=?,
      checksum_path=?, checksum_sha256=?, manifest_path=?, manifest_sha256=?,
      verification_path=?, verification_sha256=?,
      publish_state='blocked', publish_blocker_code='UNVERIFIED_FINAL_PATH_BLOCKER',
      publish_blocker_json='{"binding":{"finalDirectory":"releases/main/rpi-5","finalPath":"releases/main/rpi-5/image.img.gz"},"destination":"unknown"}', updated_at=?
      WHERE job_id=?`).run(
      '2026-07-28T00:01:00.000Z',
      artifact.artifact_sha256, artifact.artifact_size, artifact.artifact_mtime,
      artifact.checksum_path, artifact.checksum_sha256,
      artifact.manifest_path, artifact.manifest_sha256,
      artifact.verification_path, artifact.verification_sha256,
      '2026-07-28T00:01:00.000Z',
      jobId,
    );
    const proofJson = JSON.stringify(proof);
    db.prepare(`INSERT INTO job_events (
      job_id, seq, event_type, state, stage, payload_json, at
    ) VALUES (?, 0, 'recovery', 'failed', NULL, ?, '2026-07-28T00:02:00.000Z')`).run(
      jobId,
      JSON.stringify({ kind: 'publish-blocker-recheck', resolution, attempt: 1, proof }),
    );
    db.prepare(`INSERT INTO publish_blocker_rechecks (
      job_id, attempt, event_seq, resolution, observed_at, committed_at,
      prior_publish_state, prior_blocker_code, prior_blocker_json,
      artifact_staging_path, artifact_quarantine_path,
      artifact_sha256, artifact_size, artifact_mtime,
      checksum_path, checksum_sha256, manifest_path, manifest_sha256,
      verification_path, verification_sha256, final_directory, final_path,
      published_at, proof_json
    )
    SELECT
      job_id, 1, 0, ?, '2026-07-28T00:02:00.000Z',
      '2026-07-28T00:02:00.000Z', publish_state, publish_blocker_code,
      publish_blocker_json, artifact_staging_path, artifact_quarantine_path,
      artifact_sha256, artifact_size, artifact_mtime, checksum_path, checksum_sha256,
      manifest_path, manifest_sha256, verification_path, verification_sha256,
      ?, ?, ?, ?
    FROM jobs WHERE job_id=?`).run(
      resolution,
      finalDirectory,
      finalPath,
      publishedAt,
      proofJson,
      jobId,
    );

    expect(db.prepare(`SELECT resolution, event_seq, final_directory, final_path, published_at, proof_json
      FROM publish_blocker_rechecks WHERE job_id=?`).get(jobId)).toEqual({
      resolution,
      event_seq: 0,
      final_directory: finalDirectory,
      final_path: finalPath,
      published_at: publishedAt,
      proof_json: proofJson,
    });
    const rejectSecondAudit = (
      seq: number,
      rejectedProof: Record<string, unknown>,
      rejectedFinalDirectory: string | null,
      rejectedFinalPath: string | null,
      rejectedPublishedAt: string | null,
    ): void => {
      db.prepare(`INSERT INTO job_events (
        job_id, seq, event_type, state, stage, payload_json, at
      ) VALUES (?, ?, 'recovery', 'failed', NULL, ?, '2026-07-28T00:03:00.000Z')`).run(
        jobId,
        seq,
        JSON.stringify({ kind: 'publish-blocker-recheck', resolution, attempt: 2, proof: rejectedProof }),
      );
      expect(() => db.prepare(`INSERT INTO publish_blocker_rechecks (
        job_id, attempt, event_seq, resolution, observed_at, committed_at,
        prior_publish_state, prior_blocker_code, prior_blocker_json,
        artifact_staging_path, artifact_quarantine_path,
        artifact_sha256, artifact_size, artifact_mtime,
        checksum_path, checksum_sha256, manifest_path, manifest_sha256,
        verification_path, verification_sha256, final_directory, final_path,
        published_at, proof_json
      )
      SELECT
        job_id, 2, ?, ?, '2026-07-28T00:03:00.000Z',
        '2026-07-28T00:03:00.000Z', publish_state, publish_blocker_code,
        publish_blocker_json, artifact_staging_path, artifact_quarantine_path,
        artifact_sha256, artifact_size, artifact_mtime, checksum_path, checksum_sha256,
        manifest_path, manifest_sha256, verification_path, verification_sha256,
        ?, ?, ?, ?
      FROM jobs WHERE job_id=?`).run(
        seq,
        resolution,
        rejectedFinalDirectory,
        rejectedFinalPath,
        rejectedPublishedAt,
        JSON.stringify(rejectedProof),
        jobId,
      ))
        .toThrow(/publish blocker recheck evidence is not bound/u);
    };
    if (resolution === 'marked_published') {
      rejectSecondAudit(1, {
        kind: 'destination-matches',
        observedAt: '2026-07-28T00:03:00.000Z',
        publisher: { destination: 'candidate', staging: 'absent', mutationCount: 0 },
        finalDirectory,
        finalPath,
      }, finalDirectory, finalPath, '2026-07-28T00:03:00.000Z');
      rejectSecondAudit(2, {
        ...proof,
        observedAt: '2026-07-28T00:03:00.000Z',
        publisher: { destination: 'absent', staging: 'absent', mutationCount: 0 },
      }, finalDirectory, finalPath, '2026-07-28T00:03:00.000Z');
      rejectSecondAudit(3, {
        ...proof,
        observedAt: '2026-07-28T00:03:00.000Z',
        staging: { path: 'staging/other', state: 'absent' },
      }, finalDirectory, finalPath, '2026-07-28T00:03:00.000Z');
      const wrongDirectory = 'releases/other/rpi-5';
      rejectSecondAudit(4, {
        ...proof,
        observedAt: '2026-07-28T00:03:00.000Z',
        finalDirectory: wrongDirectory,
        finalPath: `${wrongDirectory}/image.img.gz`,
        checksum: { path: `${wrongDirectory}/sha256sums`, sha256: HASH64 },
        manifest: { path: `${wrongDirectory}/build-manifest.json`, sha256: HASH64 },
        verification: { path: `${wrongDirectory}/verification.json`, sha256: HASH64 },
      }, wrongDirectory, `${wrongDirectory}/image.img.gz`, '2026-07-28T00:03:00.000Z');
    } else {
      rejectSecondAudit(1, {
        ...proof,
        observedAt: '2026-07-28T00:03:00.000Z',
        publisher: { destination: 'absent', staging: 'absent', mutationCount: 0 },
      }, null, null, null);
    }
    db.close();
  });

  it('rejects a queued job self-asserting publish blocker recheck evidence', async () => {
    const path = await temporaryDatabase();
    const db = openBuilderDatabase(path);
    const jobId = 'queued-self-asserted-recheck';
    insertValidJob(db, jobId, 'queued');
    const artifact = stagingEvidence();
    db.prepare(`UPDATE jobs SET
      artifact_staging_path=NULL, artifact_sha256=?, artifact_size=?, artifact_mtime=?,
      checksum_path=?, checksum_sha256=?, manifest_path=?, manifest_sha256=?,
      verification_path=?, verification_sha256=?,
      publish_state='blocked', publish_blocker_code='UNVERIFIED_FINAL_PATH_BLOCKER',
      publish_blocker_json='{"binding":{"finalDirectory":"releases/main/rpi-5","finalPath":"releases/main/rpi-5/image.img.gz"},"destination":"unknown"}'
      WHERE job_id=?`).run(
      artifact.artifact_sha256, artifact.artifact_size, artifact.artifact_mtime,
      artifact.checksum_path, artifact.checksum_sha256,
      artifact.manifest_path, artifact.manifest_sha256,
      artifact.verification_path, artifact.verification_sha256,
      jobId,
    );
    const proof = {
      kind: 'destination-absent',
      observedAt: '2026-07-28T00:02:00.000Z',
      publisher: { destination: 'absent', staging: 'absent', mutationCount: 0 },
      finalDirectory: 'releases/main/rpi-5',
      finalPath: 'releases/main/rpi-5/image.img.gz',
    };
    db.prepare(`INSERT INTO job_events (
      job_id, seq, event_type, state, stage, payload_json, at
    ) VALUES (?, 0, 'recovery', 'queued', NULL, ?, '2026-07-28T00:02:00.000Z')`).run(
      jobId,
      JSON.stringify({ kind: 'publish-blocker-recheck', resolution: 'cleared_absent', attempt: 1, proof }),
    );

    expect(() => db.prepare(`INSERT INTO publish_blocker_rechecks (
      job_id, attempt, event_seq, resolution, observed_at, committed_at,
      prior_publish_state, prior_blocker_code, prior_blocker_json,
      artifact_staging_path, artifact_quarantine_path,
      artifact_sha256, artifact_size, artifact_mtime,
      checksum_path, checksum_sha256, manifest_path, manifest_sha256,
      verification_path, verification_sha256, final_directory, final_path,
      published_at, proof_json
    )
    SELECT
      job_id, 1, 0, 'cleared_absent', '2026-07-28T00:02:00.000Z',
      '2026-07-28T00:02:00.000Z', publish_state, publish_blocker_code,
      publish_blocker_json, artifact_staging_path, artifact_quarantine_path,
      artifact_sha256, artifact_size, artifact_mtime, checksum_path, checksum_sha256,
      manifest_path, manifest_sha256, verification_path, verification_sha256,
      NULL, NULL, NULL, ?
    FROM jobs WHERE job_id=?`).run(JSON.stringify(proof), jobId))
      .toThrow(/publish blocker recheck evidence is not bound/u);
    expect(db.prepare('SELECT COUNT(*) AS count FROM publish_blocker_rechecks WHERE job_id=?').get(jobId))
      .toEqual({ count: 0 });
    db.close();
  });

  it('upgrades an exact v16 database additively and preserves existing jobs', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    for (const migration of MIGRATION_REGISTRY.slice(0, 16)) {
      historical.exec(await readFile(join(repoMigrationDir, migration.filename), 'utf8'));
      historical.prepare('INSERT INTO schema_migrations (version, filename, sha256, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.filename, migration.sha256, '2026-07-28T00:00:00.000Z');
    }
    insertValidJob(historical, 'preserved-v16-job', 'building');
    historical.close();

    expectMigrationError(
      () => openBuilderDatabase(path),
      /legacy.*(?:dispatched|active)|(?:dispatched|active).*legacy/iu,
    );
    const upgraded = new DatabaseSync(path);
    expect(upgraded.prepare('SELECT version, filename FROM schema_migrations WHERE version=17').get())
      .toEqual({ version: 17, filename: '017_publish_blocker_recheck.sql' });
    expect(upgraded.prepare("SELECT job_id, state FROM jobs WHERE job_id='preserved-v16-job'").get())
      .toEqual({ job_id: 'preserved-v16-job', state: 'building' });
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='publish_blocker_rechecks'").get())
      .toEqual({ name: 'publish_blocker_rechecks' });
    upgraded.close();
  });

  it('fails the source-gap migration atomically for preexisting numeric-equivalent duplicates', async () => {
    const path = await temporaryDatabase();
    const historical = new DatabaseSync(path);
    for (const migration of MIGRATION_REGISTRY.slice(0, 15)) {
      historical.exec(await readFile(join(repoMigrationDir, migration.filename), 'utf8'));
      historical.prepare('INSERT INTO schema_migrations (version, filename, sha256, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.filename, migration.sha256, '2026-07-28T00:00:00.000Z');
    }
    insertValidJob(historical, 'duplicate-source-gap', 'building');
    historical.prepare('INSERT INTO job_events (job_id, seq, event_type, payload_json, at) VALUES (?, ?, \'log-gap\', ?, ?)')
      .run('duplicate-source-gap', 0, '{"sourceSeq":7}', '2026-07-28T00:00:00.000Z');
    historical.prepare('INSERT INTO job_events (job_id, seq, event_type, payload_json, at) VALUES (?, ?, \'log-gap\', ?, ?)')
      .run('duplicate-source-gap', 1, '{"sourceSeq":7.0}', '2026-07-28T00:00:01.000Z');
    historical.close();

    expectMigrationError(() => openBuilderDatabase(path), /migration 016_log_gap_source_seq_unique\.sql failed/u, /UNIQUE constraint failed/u);
    const unchanged = new DatabaseSync(path);
    expect(unchanged.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 15 });
    expect(unchanged.prepare("SELECT payload_json FROM job_events WHERE job_id='duplicate-source-gap' AND event_type='log-gap' ORDER BY seq").all())
      .toEqual([{ payload_json: '{"sourceSeq":7}' }, { payload_json: '{"sourceSeq":7.0}' }]);
    expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='job_events_log_gap_source_seq'").get()).toBeUndefined();
    unchanged.close();
  });

  it('rejects migration drift and unknown files before changing existing jobs', async () => {
    const path = await temporaryDatabase();
    const migrationDir = await copyMigrations();
    const db = openBuilderDatabase(path, { migrationsDirectory: migrationDir });
    insertValidJob(db, 'job-existing');
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
    expect(accepted.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 22 });
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
    insertValidJob(db, 'job-1');
    db.prepare('INSERT INTO queue_entries (job_id, fifo_seq, enqueued_at) VALUES (?, ?, ?)').run('job-1', 0, '2026-07-23T00:00:00.000Z');
    check(db, "INSERT INTO queue_entries VALUES ('unknown', 1, 'x', NULL)", /FOREIGN KEY constraint failed/);
    insertValidJob(db, 'bad-state');
    check(db, "UPDATE jobs SET state='not-a-state' WHERE job_id='bad-state'", /CHECK constraint failed: state IN/);
    check(db, "UPDATE jobs SET cleanup_fence_generation=-1 WHERE job_id='job-1'", /invalid cleanup fence/);
    check(db, "UPDATE jobs SET pinned_sha='A' WHERE job_id='job-1'", /accepted job identity is immutable/);
    db.prepare(`INSERT INTO job_events (job_id, seq, event_type, state, payload_json, at) VALUES (?, ?, ?, ?, ?, ?)`).run('job-1', 0, 'state', 'queued', '{}', '2026-07-23T00:00:00.000Z');
    check(db, "INSERT INTO job_events (job_id, seq, event_type, state, payload_json, at) VALUES ('job-1', 0, 'state', 'queued', '{}', 'x')", /job events must append within an open log generation/);
    check(db, "INSERT INTO job_events (job_id, seq, event_type, state, payload_json, at, stream) VALUES ('job-1', 1, 'log', 'queued', '{}', 'x', 'runner')", /CHECK constraint failed/);
    db.prepare(`INSERT INTO job_log_generations (job_id, stream, generation, path, started_at) VALUES ('job-1', 'runner', 0, 'logs/runner.0', 'x')`).run();
    db.prepare("UPDATE job_log_generations SET size_bytes=5 WHERE job_id='job-1' AND stream='runner' AND generation=0").run();
    db.prepare(`INSERT INTO job_events (job_id, seq, event_type, state, payload_json, at, stream, file_generation, byte_offset, byte_length, partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('job-1', 1, 'log', 'queued', '{}', '2026-07-23T00:00:00.000Z', 'runner', 0, 0, 5, 0);
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
      state: 'interrupted',
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
      claimOwner: 'dispatcher-preserve-me',
      claimExpiresAt: '2026-07-23T00:01:00.000Z',
      at: '2026-07-23T00:00:00.000Z',
    })).toMatchObject({
      ok: false,
      conflict: { kind: 'stale-predecessor' },
    });
    expect(store.getJob('preserve-me')).toMatchObject({
      state: 'interrupted',
      queueState: 'complete',
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

    expectMigrationError(
      () => openBuilderDatabase(path, { migrationsDirectory: migrationDir }),
      /legacy.*(?:dispatched|active)|(?:dispatched|active).*legacy/iu,
    );
    const upgraded = new DatabaseSync(path);
    const fresh = new DatabaseSync(freshPath);
    await applyRegisteredMigrations(fresh, 20);
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

    expectMigrationError(
      () => openBuilderDatabase(path, { migrationsDirectory: migrationDir }),
      /legacy.*(?:dispatched|active)|(?:dispatched|active).*legacy/iu,
    );
    const reopened = new DatabaseSync(path);
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 20 });
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

    expectMigrationError(
      () => openBuilderDatabase(path, { migrationsDirectory: migrationDir }),
      /legacy.*(?:dispatched|active)|(?:dispatched|active).*legacy/iu,
    );
    const upgraded = new DatabaseSync(path);
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
    check(db, `INSERT INTO cleanup_leases (admission_id, job_id, unit_name, owner, expires_at, status, credential_relative_path, credential_sha256, fence_generation, fence_token_hash, proof_json, admitted_at) VALUES ('cln_8${'b'.repeat(25)}', 'job-valid', 'osi-image-builder-cleanup@cln_8${'b'.repeat(25)}.service', 'x', 'x', 'admitted', 'recovery/cleanup-credentials/cln_8${'b'.repeat(25)}.token', '${HASH64}', 2, '${'e'.repeat(64)}', '{}', 'x')`, /lowercase ULID|CHECK constraint failed/);
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
    check(db, `DELETE FROM cleanup_stop_authorization_heads WHERE admission_id='${ADMISSION_ID}'`, /immutable|delete|authorization head/);

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
    const lateOutcome = JSON.stringify({
      kind: 'cleanup-stop-observation',
      code: 'CLEANUP_UNIT_STOP_CONFIRMED_INACTIVE',
      unitName,
      active: false,
      observedAt: '2026-07-23T03:00:01.000Z',
    });
    const latePayload = JSON.stringify({
      admissionId: ADMISSION_ID,
      kind: 'cleanup-stop-authorization-complete',
      attemptId,
      authorizationOwner: 'stop-owner',
      outcomeState: 'consumed',
      outcome: JSON.parse(lateOutcome),
    });
    db.prepare(`INSERT INTO job_events (job_id, seq, event_type, state, stage, payload_json, at)
      VALUES ('job-valid', 0, 'cleanup', 'queued', NULL, ?, '2026-07-23T03:00:01.000Z')`).run(latePayload);
    check(db, `INSERT INTO cleanup_stop_authorization_outcomes (
      attempt_id, job_id, admission_id, authorization_owner, outcome_state, unit_name, observed_at, outcome_json, event_seq
    ) VALUES ('${attemptId}', 'job-valid', '${ADMISSION_ID}', 'stop-owner', 'consumed', '${unitName}', '2026-07-23T03:00:01.000Z', '${lateOutcome}', 0)`, /chronology|expiry|evidence is incoherent/);
    const mismatchedOutcome = JSON.stringify({
      kind: 'cleanup-stop-observation',
      code: 'CLEANUP_UNIT_STOP_CONFIRMED_INACTIVE',
      unitName,
      active: false,
      observedAt: '2026-07-23T02:30:00.000Z',
    });
    const mismatchedPayload = JSON.stringify({
      admissionId: ADMISSION_ID,
      kind: 'cleanup-stop-authorization-complete',
      attemptId,
      authorizationOwner: 'stop-owner',
      outcomeState: 'consumed',
      outcome: JSON.parse(mismatchedOutcome),
    });
    db.prepare(`INSERT INTO job_events (job_id, seq, event_type, state, stage, payload_json, at)
      VALUES ('job-valid', 1, 'cleanup', 'queued', NULL, ?, '2026-07-23T02:31:00.000Z')`).run(mismatchedPayload);
    check(db, `INSERT INTO cleanup_stop_authorization_outcomes (
      attempt_id, job_id, admission_id, authorization_owner, outcome_state, unit_name, observed_at, outcome_json, event_seq
    ) VALUES ('${attemptId}', 'job-valid', '${ADMISSION_ID}', 'stop-owner', 'consumed', '${unitName}', '2026-07-23T02:30:00.000Z', '${mismatchedOutcome}', 1)`, /chronology|timestamp|evidence is incoherent/);
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
    const preClaimUnexpected = JSON.stringify({ kind: 'cleanup-unit-unexpected-exit', code: 'CLEANUP_UNIT_UNEXPECTED_EXIT', unitName: `osi-image-builder-cleanup@${ADMISSION_ID}.service`, active: false, inactiveAt: '2026-07-23T00:09:00.000Z', observedAt: '2026-07-23T00:09:00.000Z' });
    supersession.prepare('UPDATE cleanup_leases SET unexpected_exit_json=? WHERE admission_id=?').run(preClaimUnexpected, ADMISSION_ID);
    check(supersession, `UPDATE cleanup_leases SET status='expired', blocker_code=NULL, blocker_json=NULL, expired_at='2026-07-23T00:12:00.000Z', superseded_at='2026-07-23T00:12:00.000Z', superseded_by_admission_id='${replacement}', predecessor_status='claimed', predecessor_claim_at='2026-07-23T00:10:00.000Z', predecessor_renew_at=NULL, predecessor_blocker_code=NULL, predecessor_blocker_json=NULL, predecessor_unexpected_exit_json='${preClaimUnexpected}' WHERE admission_id='${ADMISSION_ID}'`, /claim|chronology|supersession|evidence/);
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
    db.prepare(`UPDATE jobs SET state='publishing', artifact_final_directory='release', artifact_final_path='release/image.gz', publish_started_at='2026-07-23T00:01:00.000Z', publish_state='publishing', release_seal_status='in_progress' WHERE job_id='evidence-job'`).run();
    check(db, "UPDATE jobs SET publish_state='published', release_seal_status='legacy_mutable', artifact_staging_path='staging/image.gz' WHERE job_id='evidence-job'", /publish result is incoherent/);
    db.prepare(`UPDATE jobs SET artifact_staging_path=NULL, artifact_final_directory='release', artifact_final_path='release/image.gz', publish_state='published', release_seal_status='legacy_mutable', published_at='2026-07-23T00:02:00.000Z' WHERE job_id='evidence-job'`).run();
    check(db, "UPDATE jobs SET artifact_quarantine_path='quarantine/image.gz', publish_state='published' WHERE job_id='evidence-job'", /publish result is incoherent/);
    db.prepare(`UPDATE jobs SET publish_state='quarantined', release_seal_status=NULL, artifact_quarantine_path='quarantine/image.gz', artifact_final_directory=NULL, artifact_final_path=NULL, artifact_staging_path=NULL, artifact_sha256=NULL, artifact_size=NULL, artifact_mtime=NULL, checksum_path=NULL, checksum_sha256=NULL, manifest_path=NULL, manifest_sha256=NULL, verification_path=NULL, verification_sha256=NULL, publish_started_at=NULL, published_at=NULL WHERE job_id='evidence-job'`).run();
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
    check(db, "UPDATE jobs SET publish_state='published' WHERE job_id='evidence-job'", /publish result is incoherent|release seal status is incoherent/);
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
