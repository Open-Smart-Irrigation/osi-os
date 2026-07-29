import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { BuilderStore, EVENT_PAGE_MAX_LIMIT, JSON_LIMITS, StoreConflictError, StoreDataError, type CreateJobInput } from '../../api/src/store.js';
import { encodeJson, normalizeJson } from '../../api/src/validation.js';
import { OwnershipStore, OwnershipTransactionError, OwnershipValidationError, type ApiWriteCommand, type RunnerWriteCommand } from '../../api/src/ownership.js';
import type { JobState, PipelineStageName } from '../../domain/types.js';

const SHA40 = 'a'.repeat(40);
const SHA64 = 'c'.repeat(64);
const ADMISSION_ID = `cln_0${'a'.repeat(25)}`;
const NOW = '2026-07-23T10:00:00.000Z';
const LATER = '2026-07-23T10:01:00.000Z';
const SOURCE_PREPARATION = Object.freeze({
  schemaVersion: 1 as const,
  sourceSha: SHA40,
  gitmodulesBlobSha: 'b'.repeat(40),
  preparedAt: NOW,
  components: Object.freeze([
    Object.freeze({
      path: 'feeds/chirpstack-openwrt-feed' as const,
      mode: '040000' as const,
      type: 'tree' as const,
      objectId: 'd'.repeat(40),
      provenanceUrl: 'https://github.com/chirpstack/chirpstack-openwrt-feed.git',
    }),
    Object.freeze({
      path: 'openwrt' as const,
      mode: '040000' as const,
      type: 'tree' as const,
      objectId: 'e'.repeat(40),
      provenanceUrl: 'https://github.com/openwrt/openwrt.git',
    }),
  ]),
});
function offlineFeedPreparation(jobId: string) {
  const recursiveSubmoduleStatusSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  return Object.freeze({
    schemaVersion: 1 as const,
    boundary: 'api-prepared-pinned-feeds-v1' as const,
    networkPolicy: 'runner-offline' as const,
    jobId,
    sourceSha: SHA40,
    preparedAt: NOW,
    feeds: Object.freeze([
      Object.freeze({ name: 'packages', location: 'https://git.openwrt.org/feed/packages.git', commit: 'd8cd30f4e281d6853b3de134c4f147a807583e43', detached: true as const, clean: true as const, recursiveSubmodulesPrepared: true as const, recursiveSubmodules: Object.freeze([]), recursiveSubmoduleStatusSha256, treeSha256: SHA64 }),
      Object.freeze({ name: 'luci', location: 'https://git.openwrt.org/project/luci.git', commit: '2ac26e56cc55102cb10e7b0867c2b78e0f6d5fd8', detached: true as const, clean: true as const, recursiveSubmodulesPrepared: true as const, recursiveSubmodules: Object.freeze([]), recursiveSubmoduleStatusSha256, treeSha256: SHA64 }),
      Object.freeze({ name: 'routing', location: 'https://git.openwrt.org/feed/routing.git', commit: 'c9b636698881059a3c981032770968f5a98ff201', detached: true as const, clean: true as const, recursiveSubmodulesPrepared: true as const, recursiveSubmodules: Object.freeze([]), recursiveSubmoduleStatusSha256, treeSha256: SHA64 }),
    ]),
  });
}
const tempPaths: string[] = [];
const openStores: BuilderStore[] = [];
const openDatabases: Array<ReturnType<typeof openBuilderDatabase>> = [];

function seedReadFixture(db: ReturnType<typeof openBuilderDatabase>): void {
  db.prepare(`INSERT INTO jobs (job_id, request_id, request_json, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, source_preparation_json, offline_feed_preparation_json,
    target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, queue_position, created_at, updated_at)
    VALUES ('job-1', 'request-1', ?, 'git@example.com:osi-os.git', 'refs/remotes/origin/main', 'main', 'main', ?, ?, ?, ?, 'rpi-5', 'release', ?, ?, 'Phil', 'build', ?, 'queued', 'queued', 0, ?, ?)`).run(
    JSON.stringify({ branch: 'main', target: 'rpi-5' }), SHA40, SHA40, JSON.stringify(SOURCE_PREPARATION), JSON.stringify(offlineFeedPreparation('job-1')), SHA64, NOW, NOW, NOW, NOW,
  );
  db.prepare('INSERT INTO queue_entries (job_id, fifo_seq, enqueued_at) VALUES (\'job-1\', 0, ?)').run(NOW);
  db.prepare("INSERT INTO job_events (job_id, seq, event_type, state, stage, payload_json, at) VALUES ('job-1', 0, 'enqueue', 'queued', NULL, ?, ?)").run(JSON.stringify({ requestId: 'request-1' }), NOW);
}

async function openFixture(): Promise<{ store: BuilderStore; ownership: OwnershipStore; path: string; db: ReturnType<typeof openBuilderDatabase> }> {
  const directory = await mkdtemp(join(tmpdir(), 'osi-image-builder-store-read-'));
  tempPaths.push(directory);
  const path = join(directory, 'jobs.sqlite');
  const db = openBuilderDatabase(path);
  seedReadFixture(db);
  const store = new BuilderStore(db);
  const ownership = new OwnershipStore(db, { now: () => NOW });
  openStores.push(store);
  return { store, ownership, path, db };
}

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  for (const db of openDatabases.splice(0)) db.close();
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function runnerBase(jobId = 'job-1', leaseExpiresAt = '2026-07-23T10:02:00.000Z'): { jobId: string; owner: string; runnerUnit: string; leaseExpiresAt: string; at: string } {
  return { jobId, owner: 'runner-a', runnerUnit: `osi-image-builder-runner@${jobId}.service`, leaseExpiresAt, at: LATER };
}

function dispatchCommand(jobId = 'job-1'): Extract<ApiWriteCommand, { kind: 'dispatch' }> {
  return { kind: 'dispatch', jobId, runnerUnit: `osi-image-builder-runner@${jobId}.service`, claimOwner: `dispatcher-${jobId}`, claimExpiresAt: '2026-07-23T10:05:00.000Z', at: NOW };
}

function dispatchStartCommand(jobId = 'job-1'): Extract<ApiWriteCommand, { kind: 'dispatch-start' }> {
  return { kind: 'dispatch-start', jobId, runnerUnit: `osi-image-builder-runner@${jobId}.service`, claimOwner: `dispatcher-${jobId}`, expectedClaimExpiresAt: '2026-07-23T10:05:00.000Z', claimExpiresAt: '2026-07-23T10:05:00.000Z', unitInactiveAt: NOW, startAttemptedAt: NOW, at: NOW };
}

function acquireAndLease(ownership: OwnershipStore, jobId = 'job-1'): void {
  ownership.apiWrite(dispatchCommand(jobId));
  ownership.apiWrite(dispatchStartCommand(jobId));
  ownership.runnerWrite({ kind: 'acquire-lease', jobId, runnerUnit: `osi-image-builder-runner@${jobId}.service`, owner: 'runner-a', expiresAt: '2026-07-23T10:02:00.000Z', at: NOW });
}

function stageCommand(jobId: string, expectedState: 'starting' | 'preflight' | 'source', state: 'preflight' | 'source' | 'release_gates', stage: 'preflight' | 'source' | 'release-gates', outcome: 'running' | 'passed' = 'passed'): RunnerWriteCommand {
  return { ...runnerBase(jobId), kind: 'stage', expectedState, state, stage, outcome, startedAt: NOW, ...(outcome === 'passed' ? { finishedAt: NOW, evidencePath: `evidence/${stage}`, evidenceSha256: SHA64 } : {}) } as RunnerWriteCommand;
}

function artifactCommand(jobId = 'job-1', expectedState: JobState = 'source', state: JobState = expectedState): RunnerWriteCommand {
  return { ...runnerBase(jobId), kind: 'artifact', expectedState, state, stagingPath: 'staging/image.img.gz', artifactSha256: SHA64, artifactSize: 100, artifactMtime: NOW, checksumPath: 'staging/SHA256SUMS', checksumSha256: SHA64, manifestPath: 'staging/manifest.json', manifestSha256: SHA64, verificationPath: 'staging/verification.json', verificationSha256: SHA64 } as RunnerWriteCommand;
}

function advanceToVerifying(ownership: OwnershipStore): void {
  const stages: Array<[JobState, JobState, PipelineStageName]> = [
    ['starting', 'preflight', 'preflight'], ['preflight', 'source', 'source'], ['source', 'release_gates', 'release-gates'],
    ['release_gates', 'frontend', 'frontend'], ['frontend', 'target_setup', 'target-setup'], ['target_setup', 'feeds', 'feeds'],
    ['feeds', 'config', 'config'], ['config', 'building', 'build'], ['building', 'verifying', 'verify'],
  ];
  for (const [expectedState, state, stage] of stages) ownership.runnerWrite({ ...runnerBase(), kind: 'stage', expectedState, state, stage, outcome: 'passed', startedAt: NOW, finishedAt: NOW, evidencePath: `evidence/${stage}`, evidenceSha256: SHA64 } as RunnerWriteCommand);
}

describe('OwnershipStore persistence coverage', () => {
  it('enqueues through the API actor with queue position and event', async () => {
    const { ownership, store } = await openFixture();
    const input = { jobId: 'job-2', requestId: 'request-2', request: { branch: 'main' }, sourceRemote: 'git@example.com:osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main', expectedSha: SHA40, pinnedSha: SHA40, sourcePreparation: SOURCE_PREPARATION, offlineFeedPreparation: offlineFeedPreparation('job-2'), targetId: 'rpi-5' as const, rootId: 'release', targetManifestSha256: SHA64, sourceCommitTime: NOW, sourceAuthor: 'Phil', sourceSubject: 'build', acceptedAt: NOW };
    expect(ownership.apiWrite({ kind: 'enqueue', input }).ok).toBe(true);
    expect(store.getQueuePosition('job-2')).toBe(1); expect(store.listEvents('job-2').events[0].eventType).toBe('enqueue');
  });

  it('keeps dispatch FIFO when a later job requests dispatch first', async () => {
    const { ownership, store } = await openFixture();
    const input = { jobId: 'job-2', requestId: 'request-2', request: { branch: 'main' }, sourceRemote: 'git@example.com:osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main', expectedSha: SHA40, pinnedSha: SHA40, sourcePreparation: SOURCE_PREPARATION, offlineFeedPreparation: offlineFeedPreparation('job-2'), targetId: 'rpi-5' as const, rootId: 'release', targetManifestSha256: SHA64, sourceCommitTime: NOW, sourceAuthor: 'Phil', sourceSubject: 'build', acceptedAt: NOW };
    ownership.apiWrite({ kind: 'enqueue', input }); expect(ownership.apiWrite(dispatchCommand('job-2'))).toMatchObject({ ok: false });
    expect(ownership.apiWrite(dispatchCommand()).ok).toBe(true); expect(store.getQueuePosition('job-2')).toBe(0); expect(store.getJob('job-2').queuePosition).toBe(0);
  });

  it('re-sequences persisted queue positions after cancellation and dispatch', async () => {
    const { ownership, store, db, path } = await openFixture();
    for (const jobId of ['job-2', 'job-3']) ownership.apiWrite({ kind: 'enqueue', input: { jobId, requestId: `request-${jobId}`, request: { branch: 'main' }, sourceRemote: 'git@example.com:osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main', expectedSha: SHA40, pinnedSha: SHA40, sourcePreparation: SOURCE_PREPARATION, offlineFeedPreparation: offlineFeedPreparation(jobId), targetId: 'rpi-5', rootId: 'release', targetManifestSha256: SHA64, sourceCommitTime: NOW, sourceAuthor: 'Phil', sourceSubject: 'build', acceptedAt: NOW } });
    expect(ownership.apiWrite({ kind: 'request-cancellation', jobId: 'job-2', reason: 'operator', at: NOW }).ok).toBe(true);
    expect(store.getJob('job-3').queuePosition).toBe(1); expect(store.getQueuePosition('job-3')).toBe(1);
    expect(ownership.apiWrite(dispatchCommand()).ok).toBe(true);
    expect(store.getJob('job-3').queuePosition).toBe(0); expect(store.getQueuePosition('job-3')).toBe(0);
    expect((db.prepare('SELECT queue_position FROM jobs WHERE job_id=?').get('job-3') as { queue_position: number }).queue_position).toBe(0);
    const index = openStores.indexOf(store); if (index >= 0) openStores.splice(index, 1); store.close();
    const reopened = new BuilderStore(openBuilderDatabase(path)); openStores.push(reopened);
    expect(reopened.getJob('job-3').queuePosition).toBe(0); expect(reopened.getQueuePosition('job-3')).toBe(0);
  });

  it('cancels a queued job through the API terminal path', async () => {
    const { ownership, store } = await openFixture();
    expect(ownership.apiWrite({ kind: 'request-cancellation', jobId: 'job-1', reason: 'operator', at: NOW }).ok).toBe(true);
    expect(store.getJob('job-1')).toMatchObject({ state: 'cancelled', terminalErrorCode: 'CANCELLED', queueState: 'cancelled' });
  });

  it('maps source identity independently from queue state', async () => {
    const { store } = await openFixture();
    expect(store.getSourceIdentity('job-1')).toMatchObject({ sourceRemote: 'git@example.com:osi-os.git', sourceBranch: 'main', expectedSha: SHA40, pinnedSha: SHA40 });
  });

  it('reads the bounded recovery status independently from the public job record', async () => {
    const { store } = await openFixture();
    expect(store.getRecoveryJob('job-1')).toEqual({
      jobId: 'job-1',
      state: 'queued',
      queueState: 'queued',
      queuePosition: 0,
      terminalAt: null,
      terminalErrorCode: null,
      terminalError: null,
      cleanupFenceGeneration: null,
      cleanupAdmissionId: null,
      cleanupBlockerCode: null,
      cleanupBlocker: null,
      cleanupLeaseStatus: null,
      cleanupLeaseExpiresAt: null,
      cleanupLeaseBlockerCode: null,
      cleanupLeaseBlocker: null,
    });
  });

  it('joins the exact active cleanup lease and its blocker evidence', async () => {
    const { store, db } = await openFixture();
    db.prepare(`INSERT INTO cleanup_leases (
      admission_id, job_id, unit_name, owner, expires_at, status,
      credential_relative_path, credential_sha256, fence_generation,
      fence_token_hash, proof_json, admitted_at
    ) VALUES (?, 'job-1', ?, 'api-recovery', ?, 'admitted', ?, ?, 1, ?, '{}', ?)`).run(
      ADMISSION_ID,
      `osi-image-builder-cleanup@${ADMISSION_ID}.service`,
      '2026-07-23T10:05:00.000Z',
      `recovery/cleanup-credentials/${ADMISSION_ID}.token`,
      SHA64,
      'd'.repeat(64),
      NOW,
    );
    db.prepare(`UPDATE jobs SET
      cleanup_generation=1, cleanup_fence_generation=1,
      cleanup_fence_token_hash=?, cleanup_admission_id=?
      WHERE job_id='job-1'`).run('d'.repeat(64), ADMISSION_ID);

    expect(store.getRecoveryJob('job-1')).toMatchObject({
      cleanupFenceGeneration: 1,
      cleanupAdmissionId: ADMISSION_ID,
      cleanupLeaseStatus: 'admitted',
      cleanupLeaseExpiresAt: '2026-07-23T10:05:00.000Z',
      cleanupLeaseBlockerCode: null,
      cleanupLeaseBlocker: null,
    });

    db.prepare(`UPDATE cleanup_leases SET
      status='blocking', blocker_code='QUARANTINE_PENDING',
      blocker_json='{"code":"QUARANTINE_PENDING"}'
      WHERE admission_id=?`).run(ADMISSION_ID);
    db.prepare(`UPDATE jobs SET
      cleanup_blocker_code='QUARANTINE_PENDING',
      cleanup_blocker_json='{"code":"QUARANTINE_PENDING"}'
      WHERE job_id='job-1'`).run();

    expect(store.getRecoveryJob('job-1')).toMatchObject({
      cleanupLeaseStatus: 'blocking',
      cleanupBlockerCode: 'QUARANTINE_PENDING',
      cleanupLeaseBlockerCode: 'QUARANTINE_PENDING',
    });

    db.prepare(`UPDATE jobs SET cleanup_blocker_json='{"code":"QUARANTINE_PENDING","different":true}'
      WHERE job_id='job-1'`).run();
    expect(() => store.getRecoveryJob('job-1')).toThrow('cleanup job and lease blocker evidence disagree');
  });

  it.each([
    ['incomplete cleanup fence', "UPDATE jobs SET cleanup_fence_generation=1, cleanup_admission_id=NULL WHERE job_id='job-1'", 'cleanup recovery fence is incomplete'],
    ['invalid cleanup fence generation', "UPDATE jobs SET cleanup_fence_generation=0, cleanup_admission_id='cln_0123456789abcdefghjkmnpqrs' WHERE job_id='job-1'", 'cleanup recovery fence generation is invalid'],
    ['incomplete cleanup blocker', "UPDATE jobs SET cleanup_blocker_code='RUNNER_DISAPPEARED', cleanup_blocker_json=NULL WHERE job_id='job-1'", 'cleanup blocker evidence is incomplete'],
  ])('fails closed on %s in the recovery status read model', async (_description, sql, message) => {
    const { store, db } = await openFixture();
    db.exec('PRAGMA ignore_check_constraints=ON');
    db.exec('DROP TRIGGER jobs_fence_guard_update');
    db.exec('DROP TRIGGER jobs_cleanup_blocker_guard_update');
    db.prepare(sql).run();
    expect(() => store.getRecoveryJob('job-1')).toThrow(message);
  });

  it('acquires and renews the exact runner lease', async () => {
    const { ownership, store } = await openFixture(); ownership.apiWrite(dispatchCommand()); ownership.apiWrite(dispatchStartCommand());
    expect(ownership.runnerWrite({ kind: 'acquire-lease', jobId: 'job-1', runnerUnit: runnerBase().runnerUnit, owner: 'runner-a', expiresAt: '2026-07-23T10:02:00.000Z', at: NOW }).ok).toBe(true);
    expect(ownership.runnerWrite({ kind: 'renew-lease', jobId: 'job-1', runnerUnit: runnerBase().runnerUnit, owner: 'runner-a', expectedExpiresAt: '2026-07-23T10:02:00.000Z', expiresAt: '2026-07-23T10:03:00.000Z', at: LATER }).ok).toBe(true);
    expect(store.getJob('job-1')).toMatchObject({ runnerLeaseOwner: 'runner-a', runnerLeaseExpiresAt: '2026-07-23T10:03:00.000Z' });
  });

  it('persists a running stage and its evidence mapping', async () => {
    const { ownership, store } = await openFixture(); acquireAndLease(ownership);
    expect(ownership.runnerWrite(stageCommand('job-1', 'starting', 'preflight', 'preflight', 'running')).ok).toBe(true);
    expect(store.getStage('job-1', 'preflight')).toMatchObject({ outcome: 'running', evidencePath: null });
  });

  it('does not append an event for a stale stage predecessor', async () => {
    const { ownership, store } = await openFixture(); acquireAndLease(ownership);
    expect(ownership.runnerWrite(stageCommand('job-1', 'source', 'preflight', 'preflight', 'passed'))).toMatchObject({ ok: false });
    expect(store.listEvents('job-1').events).toHaveLength(4);
  });

  it('round-trips a pre-container operation result', async () => {
    const { ownership, store } = await openFixture(); acquireAndLease(ownership);
    const begin: RunnerWriteCommand = { ...runnerBase(), kind: 'operation-begin', expectedState: 'starting', operationId: 'activate-target', attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW };
    expect(ownership.runnerWrite(begin).ok).toBe(true);
    const result = { ...runnerBase(), kind: 'operation-complete' as const, expectedState: 'starting' as const, operationId: 'activate-target' as const, attempt: 1, input: { operationId: 'activate-target' as const, attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW, finishedAt: LATER, timedOut: false, lifecyclePhase: 'not_created' as const, containerMount: null, containerEnvironment: null, containerSecurity: null, inspection: null, exitCode: 1, signal: null, outcome: 'failed' as const, evidencePath: 'evidence/op.json', evidenceSha256: SHA64, errorCode: 'BUILD_FAILED' as const, error: { reason: 'create failed' } } };
    expect(ownership.runnerWrite(result).ok).toBe(true); expect(store.getOperation('job-1', 'activate-target', 1)).toMatchObject({ lifecyclePhase: 'not_created', containerId: null, outcome: 'failed' });
  });

  it('keeps completed operation retries immutable', async () => {
    const { ownership, store } = await openFixture(); acquireAndLease(ownership);
    ownership.runnerWrite({ ...runnerBase(), kind: 'operation-begin', expectedState: 'starting', operationId: 'activate-target', attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW });
    const input = { operationId: 'activate-target' as const, attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW, finishedAt: LATER, timedOut: false, lifecyclePhase: 'not_created' as const, containerMount: null, containerEnvironment: null, containerSecurity: null, inspection: null, exitCode: 1, signal: null, outcome: 'failed' as const, evidencePath: 'evidence/op.json', evidenceSha256: SHA64, errorCode: 'BUILD_FAILED' as const, error: { reason: 'failed' } };
    expect(ownership.runnerWrite({ ...runnerBase(), kind: 'operation-complete', expectedState: 'starting', operationId: 'activate-target', attempt: 1, input }).ok).toBe(true);
    const before = store.listEvents('job-1').events.length; expect(ownership.runnerWrite({ ...runnerBase(), kind: 'operation-complete', expectedState: 'starting', operationId: 'activate-target', attempt: 1, input }).ok).toBe(true); expect(store.listEvents('job-1').events).toHaveLength(before);
  });

  it('persists artifact metadata through the runner actor', async () => {
    const { ownership, store } = await openFixture(); acquireAndLease(ownership); ownership.runnerWrite(stageCommand('job-1', 'starting', 'preflight', 'preflight')); ownership.runnerWrite(stageCommand('job-1', 'preflight', 'source', 'source'));
    expect(ownership.runnerWrite(artifactCommand()).ok).toBe(true); expect(store.getJob('job-1')).toMatchObject({ publishState: 'staged', artifactStagingPath: 'staging/image.img.gz', artifactSize: 100, artifactSha256: SHA64 });
  });

  it('persists publishing and published states with their paths', async () => {
    const { ownership, store } = await openFixture(); acquireAndLease(ownership); advanceToVerifying(ownership); ownership.runnerWrite(artifactCommand('job-1', 'verifying'));
    expect(ownership.runnerWrite({ ...runnerBase(), kind: 'publish', expectedState: 'verifying', state: 'publishing', finalDirectory: 'release/main/rpi-5', finalPath: 'release/main/rpi-5/image', startedAt: NOW }).ok).toBe(true);
    expect(store.getJob('job-1')).toMatchObject({ state: 'publishing', publishState: 'publishing', artifactFinalPath: 'release/main/rpi-5/image' });
  });

  it('retains a publish blocker and staged artifact', async () => {
    const { ownership, store, db } = await openFixture(); acquireAndLease(ownership); ownership.runnerWrite(stageCommand('job-1', 'starting', 'preflight', 'preflight')); ownership.runnerWrite(stageCommand('job-1', 'preflight', 'source', 'source')); ownership.runnerWrite(artifactCommand());
    expect(ownership.runnerWrite({ ...runnerBase(), kind: 'publish', expectedState: 'source', state: 'blocked', blockerCode: 'PUBLISH_FAILED', blocker: { reason: 'rename' } }).ok).toBe(true);
    expect(store.getJob('job-1')).toMatchObject({ publishState: 'blocked', artifactStagingPath: 'staging/image.img.gz' }); expect((db.prepare('SELECT publish_blocker_code AS code FROM jobs WHERE job_id=?').get('job-1') as { code: string }).code).toBe('PUBLISH_FAILED');
  });

  it('writes a failed normal terminal with typed error evidence', async () => {
    const { ownership, store } = await openFixture(); acquireAndLease(ownership); ownership.runnerWrite(stageCommand('job-1', 'starting', 'preflight', 'preflight', 'running'));
    expect(ownership.runnerWrite({ ...runnerBase(), kind: 'normal-terminal', expectedState: 'preflight', state: 'failed', terminalAt: LATER, errorCode: 'BUILD_FAILED', error: { reason: 'test' } }).ok).toBe(true);
    expect(store.getJob('job-1')).toMatchObject({ state: 'failed', terminalErrorCode: 'BUILD_FAILED', terminalAt: LATER });
    expect(store.getTerminalEvent('job-1')).toMatchObject({
      eventType: 'terminal',
      state: 'failed',
      payload: { state: 'failed', errorCode: 'BUILD_FAILED' },
      at: LATER,
    });
  });

  it('fails closed when a job contains more than one terminal event', async () => {
    const { ownership, store, db } = await openFixture(); acquireAndLease(ownership); ownership.runnerWrite(stageCommand('job-1', 'starting', 'preflight', 'preflight', 'running'));
    ownership.runnerWrite({ ...runnerBase(), kind: 'normal-terminal', expectedState: 'preflight', state: 'failed', terminalAt: LATER, errorCode: 'BUILD_FAILED', error: { reason: 'test' } });
    db.prepare("INSERT INTO job_events (job_id, seq, event_type, state, stage, payload_json, at) SELECT 'job-1', MAX(seq) + 1, 'terminal', 'failed', 'preflight', ?, ? FROM job_events WHERE job_id='job-1'").run(
      JSON.stringify({ state: 'failed', errorCode: 'BUILD_FAILED' }),
      LATER,
    );
    expect(() => store.getTerminalEvent('job-1')).toThrow(StoreDataError);
  });

  it('persists freshness request and API result idempotently', async () => {
    const { ownership, store } = await openFixture(); ownership.apiWrite({ kind: 'freshness-request', jobId: 'job-1', at: NOW });
    const result = { kind: 'freshness-result' as const, jobId: 'job-1', at: LATER, input: { status: 'fresh' as const, pinnedSha: SHA40, observedSha: SHA40, checkedAt: LATER } };
    expect(ownership.apiWrite(result).ok).toBe(true); const count = store.listEvents('job-1').events.length; expect(ownership.apiWrite(result).ok).toBe(true); expect(store.listEvents('job-1').events).toHaveLength(count);
  });

  it('paginates event history with a deterministic cursor', async () => {
    const { ownership, store } = await openFixture(); ownership.apiWrite({ kind: 'request-cancellation', jobId: 'job-1', reason: 'operator', at: NOW });
    expect(store.listEvents('job-1', { limit: 1 }).events).toHaveLength(1); expect(store.listEvents('job-1', { afterSeq: 0, limit: EVENT_PAGE_MAX_LIMIT }).events[0].seq).toBe(1);
  });

  it('rejects invalid event pagination bounds', async () => {
    const { store } = await openFixture(); expect(() => store.listEvents('job-1', { limit: 0 })).toThrow(); expect(() => store.listEvents('job-1', { afterSeq: -2 })).toThrow(); expect(() => store.listEvents('job-1', { limit: EVENT_PAGE_MAX_LIMIT + 1 })).toThrow();
  });

  it('throws typed validation for malformed actor commands', async () => {
    const { ownership } = await openFixture(); expect(() => ownership.apiWrite({ kind: 'dispatch', jobId: 'job-1', runnerUnit: 'wrong', claimOwner: 'dispatcher-job-1', claimExpiresAt: '2026-07-23T10:05:00.000Z', at: NOW })).toThrow(OwnershipValidationError);
  });

  it('requires a durable claim owner and expiry on every dispatch', async () => {
    const { ownership } = await openFixture();
    expect(() => ownership.apiWrite({ kind: 'dispatch', jobId: 'job-1', runnerUnit: 'osi-image-builder-runner@job-1.service', at: NOW } as never)).toThrow(OwnershipValidationError);
  });

  it('rejects cyclic and oversized JSON before persistence', async () => {
    const { ownership, path } = await openFixture(); const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const input = { jobId: 'json-cycle', requestId: 'json-cycle', request: cycle, sourceRemote: 'git@example.com:osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main', expectedSha: SHA40, pinnedSha: SHA40, targetId: 'rpi-5' as const, rootId: 'release', targetManifestSha256: SHA64, sourceCommitTime: NOW, sourceAuthor: 'Phil', sourceSubject: 'json', acceptedAt: NOW };
    expect(() => ownership.apiWrite({ kind: 'enqueue', input: input as never })).toThrow(); const db = openBuilderDatabase(path); expect((db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE job_id=?').get('json-cycle') as { count: number }).count).toBe(0); db.close(); expect(JSON_LIMITS.maxNodes).toBeGreaterThan(0);
  });

  it('uses the shared lossless JSON bounds for root arrays and prototype keys', async () => {
    expect(() => encodeJson(['x'.repeat(100_004)], 'store root array')).toThrow();
    const value = JSON.parse('{"__proto__":{"safe":true},"constructor":"kept","prototype":"kept"}') as object;
    const normalized = normalizeJson(value, 'store prototype') as Record<string, unknown>;
    expect(Object.getPrototypeOf(normalized)).toBeNull(); expect(Object.keys(normalized)).toEqual(['__proto__', 'constructor', 'prototype']); expect(({} as Record<string, unknown>).safe).toBeUndefined();
  });

  it('rejects impossible persisted instants through the shared mapper', async () => {
    const { db, store } = await openFixture();
    db.exec('DROP TRIGGER jobs_request_immutable_guard');
    db.prepare('UPDATE jobs SET source_commit_time=? WHERE job_id=?').run('2026-02-30T10:00:00.000Z', 'job-1');
    expect(() => store.getJob('job-1')).toThrow(StoreDataError);
  });

  it('classifies persisted oversized argv, malformed JSON, and hashes as StoreDataError', async () => {
    const { db, store, ownership } = await openFixture();
    ownership.apiWrite(dispatchCommand()); ownership.apiWrite(dispatchStartCommand());
    ownership.runnerWrite({ kind: 'acquire-lease', jobId: 'job-1', runnerUnit: 'osi-image-builder-runner@job-1.service', owner: 'runner-a', expiresAt: LATER, at: NOW });
    ownership.runnerWrite({ kind: 'operation-begin', expectedState: 'starting', jobId: 'job-1', owner: 'runner-a', runnerUnit: 'osi-image-builder-runner@job-1.service', leaseExpiresAt: LATER, at: NOW, operationId: 'activate-target', attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW });
    db.exec('PRAGMA ignore_check_constraints=ON'); db.prepare('UPDATE job_operations SET argv_json=? WHERE job_id=?').run(JSON.stringify(['x'.repeat(70_000)]), 'job-1');
    expect(() => store.getOperation('job-1', 'activate-target', 1)).toThrow(StoreDataError);
    db.prepare('UPDATE job_operations SET argv_json=? WHERE job_id=?').run('{bad', 'job-1');
    expect(() => store.getOperation('job-1', 'activate-target', 1)).toThrow(StoreDataError);
    db.exec('DROP TRIGGER jobs_request_immutable_guard'); db.prepare('UPDATE jobs SET expected_sha=? WHERE job_id=?').run('not-a-hash', 'job-1');
    expect(() => store.getJob('job-1')).toThrow(StoreDataError);
  });

  it('rejects persisted domain enum and nullable-shape corruption as StoreDataError', async () => {
    const { db, store } = await openFixture();
    db.exec('PRAGMA ignore_check_constraints=ON');
    db.exec('DROP TRIGGER jobs_publish_guard');
    db.exec('DROP TRIGGER jobs_publish_null_guard_update');
    db.exec('DROP TRIGGER jobs_publish_pairs_guard_update');
    db.exec('DROP TRIGGER jobs_freshness_guard_update');
    db.exec('DROP TRIGGER jobs_freshness_null_guard_update');
    db.exec('DROP TRIGGER jobs_terminal_guard_update');
    db.exec('DROP TRIGGER job_events_immutable_update_guard');
    const corruptions: Array<readonly [string, string]> = [
      ['state', 'not-a-state'], ['current_stage', 'not-a-stage'], ['queue_state', 'not-a-queue-state'],
      ['publish_state', 'not-a-publish-state'], ['freshness_status', 'not-a-freshness-state'], ['terminal_error_code', 'not-an-error-code'],
    ];
    const valid: Record<string, string | null> = { state: 'queued', current_stage: null, queue_state: 'queued', publish_state: null, freshness_status: null, terminal_error_code: null };
    for (const [column, value] of corruptions) {
      db.prepare(`UPDATE jobs SET ${column}=? WHERE job_id=?`).run(value, 'job-1');
      expect(() => store.getJob('job-1'), column).toThrow(StoreDataError);
      db.prepare(`UPDATE jobs SET ${column}=? WHERE job_id=?`).run(valid[column], 'job-1');
    }
    db.prepare('UPDATE job_events SET event_type=?, stream=? WHERE job_id=?').run('not-an-event', 'not-a-stream', 'job-1');
    expect(() => store.listEvents('job-1')).toThrow(StoreDataError);
  });

  it('rejects each persisted nullable group and validates not_started queue/publish enums', async () => {
    const { db, store } = await openFixture();
    db.exec('PRAGMA ignore_check_constraints=ON');
    db.exec('DROP TRIGGER jobs_publish_null_guard_update');
    db.exec('DROP TRIGGER jobs_publish_pairs_guard_update');
    db.exec('DROP TRIGGER jobs_runner_lease_guard_update');
    db.exec('DROP TRIGGER jobs_container_guard_update');
    const partials: Array<readonly [string, string]> = [
      ['cancel_reason', 'operator'], ['dispatched_at', NOW], ['runner_lease_owner', 'runner-a'], ['container_id', 'container-1'],
      ['artifact_sha256', SHA64], ['checksum_path', 'staging/sums'], ['manifest_path', 'staging/manifest'], ['verification_path', 'staging/verify'],
    ];
    for (const [column, value] of partials) {
      db.prepare(`UPDATE jobs SET ${column}=? WHERE job_id=?`).run(value, 'job-1');
      expect(() => store.getJob('job-1'), column).toThrow(StoreDataError);
      db.prepare(`UPDATE jobs SET ${column}=NULL WHERE job_id=?`).run('job-1');
    }
    db.prepare("UPDATE jobs SET publish_state='not_started' WHERE job_id=?").run('job-1');
    expect(store.getJob('job-1').publishState).toBe('not_started');
    db.prepare("UPDATE jobs SET queue_state='bogus' WHERE job_id=?").run('job-1');
    expect(() => store.getQueuePosition('job-1')).toThrow(StoreDataError);
  });

  it('accepts complete preflight fields and rejects partial evidence', async () => {
    const { ownership, db } = await openFixture(); const base = { jobId: 'preflight', requestId: 'preflight', request: { branch: 'main' }, sourceRemote: 'git@example.com:osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main', expectedSha: SHA40, pinnedSha: SHA40, sourcePreparation: SOURCE_PREPARATION, offlineFeedPreparation: offlineFeedPreparation('preflight'), targetId: 'rpi-5' as const, rootId: 'release', targetManifestSha256: SHA64, sourceCommitTime: NOW, sourceAuthor: 'Phil', sourceSubject: 'preflight', acceptedAt: NOW };
    expect(ownership.apiWrite({ kind: 'enqueue', input: { ...base, preflightSha: SHA40, preflightCheckedAt: NOW, preflightExpiresAt: LATER } }).ok).toBe(true); expect((db.prepare('SELECT preflight_sha AS sha FROM jobs WHERE job_id=?').get('preflight') as { sha: string }).sha).toBe(SHA40);
    expect(() => ownership.apiWrite({ kind: 'enqueue', input: { ...base, jobId: 'partial', requestId: 'partial', preflightCheckedAt: NOW } })).toThrow();
  });

  it('maps runtime container identity and preserves exact labels', async () => {
    const { ownership, store } = await openFixture(); acquireAndLease(ownership);
    const labels = { 'org.osi.image-builder.job-id': 'job-1', 'org.osi.image-builder.manifest-sha': SHA64 };
    expect(ownership.runnerWrite({ ...runnerBase(), kind: 'container', lifecycle: 'created', containerId: 'container-1', containerName: 'osi-job-1', imageDigest: SHA64, labels, mount: { source: '/tmp', destination: '/work' }, environment: { CI: '1' }, security: { user: '1000' }, inspection: { running: true }, occurredAt: NOW }).ok).toBe(true);
    expect(store.getJob('job-1')).toMatchObject({ containerId: 'container-1', containerLabelJobId: 'job-1', containerLabelManifestSha: SHA64 });
  });

  it('rolls back mutation and event together on injected transaction failure', async () => {
    const { path, store } = await openFixture(); let fail = true; const db = openBuilderDatabase(path); openDatabases.push(db); const injected = new OwnershipStore(db, { now: () => NOW, failBeforeCommit: () => { if (fail) throw new Error('injected'); } });
    expect(() => injected.apiWrite({ kind: 'request-cancellation', jobId: 'job-1', reason: 'rollback', at: NOW })).toThrow(OwnershipTransactionError); expect(store.getJob('job-1').cancelRequestedAt).toBeNull(); expect(store.listEvents('job-1').events).toHaveLength(1); fail = false;
  });

  it('reopens SQLite and ignores an unrelated runtime snapshot', async () => {
    const { path, ownership, store } = await openFixture(); acquireAndLease(ownership);
    const index = openStores.indexOf(store); if (index >= 0) openStores.splice(index, 1); store.close();
    await writeFile(join(dirname(path), 'runtime.json'), JSON.stringify({ state: 'succeeded', containerId: 'stale-container' }));
    const reopened = new BuilderStore(openBuilderDatabase(path)); openStores.push(reopened);
    expect(reopened.getJob('job-1')).toMatchObject({ state: 'starting', runnerUnit: 'osi-image-builder-runner@job-1.service' });
    expect(reopened.listEvents('job-1').events.map((event) => event.eventType)).toEqual(['enqueue', 'dispatch', 'recovery', 'state']);
  });
});

describe('BuilderStore read surface', () => {
  it('exposes queries and maps the test-local persisted fixture', async () => {
    const { store } = await openFixture();
    expect(store.getJob('job-1')).toMatchObject({ jobId: 'job-1', state: 'queued', queueState: 'queued', targetId: 'rpi-5' });
    expect(store.getQueuePosition('job-1')).toBe(0);
    expect(store.getSourceIdentity('job-1')).toMatchObject({ branch: 'main', pinnedSha: SHA40 });
    expect(store.getStage('job-1', 'preflight')).toBeNull();
    expect(store.getOperation('job-1', 'activate-target', 1)).toBeNull();
    expect(store.getNextEventSequence('job-1')).toBe(1);
    expect(store.listEvents('job-1').events.map((event) => event.eventType)).toEqual(['enqueue']);
  });

  it('persists and reloads the authoritative recursive source preparation', async () => {
    const { ownership, store, path } = await openFixture();
    const input = {
      jobId: 'job-prepared',
      requestId: 'request-prepared',
      request: { branch: 'main' },
      sourceRemote: 'git@example.com:osi-os.git',
      sourceRef: 'refs/remotes/origin/main',
      sourceBranch: 'main',
      branch: 'main',
      expectedSha: SHA40,
      pinnedSha: SHA40,
      sourcePreparation: SOURCE_PREPARATION,
      offlineFeedPreparation: offlineFeedPreparation('job-prepared'),
      targetId: 'rpi-5' as const,
      rootId: 'release',
      targetManifestSha256: SHA64,
      sourceCommitTime: NOW,
      sourceAuthor: 'Phil',
      sourceSubject: 'prepared',
      acceptedAt: NOW,
    };
    expect(ownership.apiWrite({ kind: 'enqueue', input }).ok).toBe(true);
    const index = openStores.indexOf(store);
    if (index >= 0) openStores.splice(index, 1);
    store.close();

    const reopened = new BuilderStore(openBuilderDatabase(path));
    openStores.push(reopened);
    expect(reopened.getSourceIdentity('job-prepared')).toMatchObject({
      sourcePreparation: SOURCE_PREPARATION,
      offlineFeedPreparation: offlineFeedPreparation('job-prepared'),
    });
  });

  it('rejects missing or source-substituted persisted offline feed preparation', async () => {
    const { db, store } = await openFixture();
    db.exec('DROP TRIGGER jobs_offline_feed_preparation_immutable_guard');
    db.prepare('UPDATE jobs SET offline_feed_preparation_json=NULL WHERE job_id=?').run('job-1');
    expect(() => store.getSourceIdentity('job-1')).toThrow(StoreConflictError);

    db.prepare('UPDATE jobs SET offline_feed_preparation_json=? WHERE job_id=?').run(
      JSON.stringify({ ...offlineFeedPreparation('job-1'), sourceSha: 'f'.repeat(40) }),
      'job-1',
    );
    expect(() => store.getSourceIdentity('job-1')).toThrow(StoreDataError);
  });

  it('rejects missing or substituted persisted recursive source preparation', async () => {
    const { db, store } = await openFixture();
    db.exec('DROP TRIGGER jobs_source_preparation_immutable_guard');
    db.prepare('UPDATE jobs SET source_preparation_json=NULL WHERE job_id=?').run('job-1');
    expect(() => store.getSourceIdentity('job-1')).toThrow(StoreConflictError);

    db.prepare('UPDATE jobs SET source_preparation_json=? WHERE job_id=?').run(
      JSON.stringify({ ...SOURCE_PREPARATION, sourceSha: 'f'.repeat(40) }),
      'job-1',
    );
    expect(() => store.getSourceIdentity('job-1')).toThrow(StoreDataError);
  });

  it('has no actor-owned mutation functions on the prototype or instances', async () => {
    const { store } = await openFixture();
    const mutationNames = [
      'createJob', 'requestCancellation', 'setSourceIdentity', 'claimNextQueued', 'dispatch',
      'recordStage', 'stage', 'recordOperation', 'operation', 'recordEvidenceReference',
      'recordRuntimeDiagnostics', 'runtime', 'recordArtifact', 'artifact', 'recordPublish', 'publish',
      'requestFreshness', 'recordFreshness', 'freshness', 'recordTerminal', 'terminal', 'container',
    ];
    for (const name of mutationNames) {
      expect(Object.prototype.hasOwnProperty.call(BuilderStore.prototype, name), `prototype owns ${name}`).toBe(false);
      expect(name in store, `instance exposes ${name}`).toBe(false);
    }
    expect(Object.getOwnPropertyNames(BuilderStore.prototype)).toEqual(expect.arrayContaining(['constructor', 'close', 'getJob', 'listEvents']));
    expect(Object.getOwnPropertyNames(BuilderStore.prototype)).toEqual(expect.not.arrayContaining(['mapJob', 'mapStage', 'mapOperation', 'requireJob', 'payload']));
  });
});

describe('Task 7 persisted publish and path coherence', () => {
  it('maps every typed persisted path through stable-relative validation', async () => {
    const cases = [
      ['job artifact staging', async () => { const f = await openFixture(); f.db.exec('PRAGMA ignore_check_constraints=ON'); f.db.exec('DROP TRIGGER jobs_publish_null_guard_update'); f.db.prepare("UPDATE jobs SET publish_state='staged', artifact_staging_path='../../outside', artifact_sha256=?, artifact_size=1, artifact_mtime=?, checksum_path='staging/sums', checksum_sha256=?, manifest_path='staging/manifest', manifest_sha256=?, verification_path='staging/verify', verification_sha256=? WHERE job_id=?").run(SHA64, NOW, SHA64, SHA64, SHA64, 'job-1'); return f.store; }],
      ['stage evidence', async () => { const f = await openFixture(); acquireAndLease(f.ownership); f.ownership.runnerWrite(stageCommand('job-1', 'starting', 'preflight', 'preflight', 'running')); f.db.exec('PRAGMA ignore_check_constraints=ON'); f.db.prepare("UPDATE job_stages SET outcome='passed', started_at=?, finished_at=?, evidence_path='../../outside', evidence_sha256=? WHERE job_id=?").run(NOW, LATER, SHA64, 'job-1'); return f.store; }],
      ['operation evidence', async () => { const f = await openFixture(); acquireAndLease(f.ownership); f.ownership.runnerWrite({ ...runnerBase(), kind: 'operation-begin', expectedState: 'starting', operationId: 'activate-target', attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW }); f.db.exec('PRAGMA ignore_check_constraints=ON'); f.db.prepare("UPDATE job_operations SET outcome='failed', finished_at=?, evidence_path='/outside', evidence_sha256=?, error_code='BUILD_FAILED', error_json='{}' WHERE job_id=?").run(LATER, SHA64, 'job-1'); return f.store; }],
    ] as const;
    for (const [name, makeStore] of cases) {
      const store = await makeStore();
      expect(() => name === 'stage evidence' ? store.getStage('job-1', 'preflight') : name === 'operation evidence' ? store.getOperation('job-1', 'activate-target', 1) : store.getJob('job-1'), name).toThrow(StoreDataError);
    }
  });

  it('rejects each incoherent publish state and blocker form as StoreDataError', async () => {
    const corrupt = async (updates: string, values: Array<string | number | null> = []) => {
      const f = await openFixture(); f.db.exec('PRAGMA ignore_check_constraints=ON');
      for (const trigger of ['jobs_publish_guard', 'jobs_publish_null_guard_update', 'jobs_publish_pairs_guard_update']) { try { f.db.exec(`DROP TRIGGER ${trigger}`); } catch { /* fixture version may omit a trigger */ } }
      f.db.prepare(`UPDATE jobs SET ${updates} WHERE job_id='job-1'`).run(...values); return f.store;
    };
    const complete = [SHA64, 1, NOW, 'staging/sums', SHA64, 'staging/manifest', SHA64, 'staging/verify', SHA64];
    const staged = await corrupt("publish_state='staged', artifact_sha256=NULL, artifact_size=NULL, artifact_mtime=NULL, checksum_path=NULL, checksum_sha256=NULL, manifest_path=NULL, manifest_sha256=NULL, verification_path=NULL, verification_sha256=NULL, artifact_staging_path=NULL");
    expect(() => staged.getJob('job-1')).toThrow(StoreDataError);
    const publishing = await corrupt("publish_state='publishing', artifact_staging_path='staging/image', artifact_sha256=?, artifact_size=?, artifact_mtime=?, checksum_path=?, checksum_sha256=?, manifest_path=?, manifest_sha256=?, verification_path=?, verification_sha256=?, artifact_final_directory=NULL, artifact_final_path=NULL, publish_started_at=NULL", complete);
    expect(() => publishing.getJob('job-1')).toThrow(StoreDataError);
    const published = await corrupt("publish_state='published', artifact_staging_path='staging/image', artifact_final_directory='release', artifact_final_path='release/image', publish_started_at=?, published_at=?", [NOW, LATER]);
    expect(() => published.getJob('job-1')).toThrow(StoreDataError);
    const blocker = await corrupt("publish_state='blocked', artifact_staging_path='staging/image', artifact_sha256=?, artifact_size=?, artifact_mtime=?, checksum_path=?, checksum_sha256=?, manifest_path=?, manifest_sha256=?, verification_path=?, verification_sha256=?, publish_blocker_code='UNKNOWN', publish_blocker_json='{}'", complete);
    expect(() => blocker.getJob('job-1')).toThrow(StoreDataError);
    const pair = await corrupt("publish_state='blocked', artifact_staging_path='staging/image', artifact_sha256=?, artifact_size=?, artifact_mtime=?, checksum_path=?, checksum_sha256=?, manifest_path=?, manifest_sha256=?, verification_path=?, verification_sha256=?, publish_blocker_code='PUBLISH_FAILED', publish_blocker_json=NULL", complete);
    expect(() => pair.getJob('job-1')).toThrow(StoreDataError);
    const quarantineOnly = await corrupt("publish_state='blocked', artifact_staging_path=NULL, artifact_quarantine_path='quarantine/image', artifact_sha256=?, artifact_size=?, artifact_mtime=?, checksum_path=?, checksum_sha256=?, manifest_path=?, manifest_sha256=?, verification_path=?, verification_sha256=?, publish_blocker_code='PUBLISH_FAILED', publish_blocker_json='{\"staging\":\"quarantined\",\"quarantine\":{\"quarantined\":true,\"renameResult\":\"RENAMED\",\"destinationRelativePath\":\"quarantine/image\"}}'", complete);
    expect(quarantineOnly.getJob('job-1')).toMatchObject({
      artifactStagingPath: null,
      artifactQuarantinePath: 'quarantine/image',
    });
    const bothRetained = await corrupt("publish_state='blocked', artifact_staging_path='staging/image', artifact_quarantine_path='quarantine/image', artifact_sha256=?, artifact_size=?, artifact_mtime=?, checksum_path=?, checksum_sha256=?, manifest_path=?, manifest_sha256=?, verification_path=?, verification_sha256=?, publish_blocker_code='PUBLISH_FAILED', publish_blocker_json='{}'", complete);
    expect(() => bothRetained.getJob('job-1')).toThrow(StoreDataError);
    const noRetainedArtifact = await corrupt("publish_state='blocked', artifact_staging_path=NULL, artifact_quarantine_path=NULL, artifact_sha256=?, artifact_size=?, artifact_mtime=?, checksum_path=?, checksum_sha256=?, manifest_path=?, manifest_sha256=?, verification_path=?, verification_sha256=?, publish_blocker_code='PUBLISH_FAILED', publish_blocker_json='{\"staging\":\"absent\"}'", complete);
    expect(noRetainedArtifact.getJob('job-1')).toMatchObject({
      artifactStagingPath: null,
      artifactQuarantinePath: null,
    });
  });
});
