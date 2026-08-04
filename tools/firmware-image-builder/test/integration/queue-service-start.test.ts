import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OwnershipStore,
  type CleanupPostcondition,
  type CleanupSnapshot,
  type DirectInterruptionProof,
} from '../../api/src/ownership.js';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { type CreateJobInput } from '../../api/src/store.js';
import { createReadyQueueCoordinatorForTesting, type DirectInterruptionInput, type QueueCoordinatorOptions, type QueueSystemd } from '../../api/src/queue.js';
import { TEST_BUILDER_IDENTITY } from '../helpers/builder-identity.js';

const ACCEPTED = '2026-07-28T10:00:00.000Z';
const DISPATCHED = '2026-07-28T10:00:01.000Z';
const OBSERVED = '2026-07-28T10:00:02.000Z';
const WRITTEN = '2026-07-28T10:00:03.000Z';
const LATER = '2026-07-28T10:00:04.000Z';
const FINAL = '2026-07-28T10:00:05.000Z';
const EXPIRED = '2026-07-28T10:00:35.000Z';
const SHA40 = 'a'.repeat(40);
const SHA64 = 'b'.repeat(64);
const directories: string[] = [];
const databases: Array<ReturnType<typeof openBuilderDatabase>> = [];

// These direct queue tests bypass the not-yet-wired HTTP startup coordinator explicitly.
function createQueueCoordinator(options: QueueCoordinatorOptions) {
  return createReadyQueueCoordinatorForTesting(options);
}

function sourcePreparation() {
  return {
    schemaVersion: 1 as const,
    sourceSha: SHA40,
    gitmodulesBlobSha: 'c'.repeat(40),
    preparedAt: ACCEPTED,
    components: [
      { path: 'feeds/chirpstack-openwrt-feed' as const, mode: '040000' as const, type: 'tree' as const, objectId: 'd'.repeat(40), provenanceUrl: 'https://github.com/chirpstack/chirpstack-openwrt-feed.git' },
      { path: 'openwrt' as const, mode: '040000' as const, type: 'tree' as const, objectId: 'e'.repeat(40), provenanceUrl: 'https://github.com/openwrt/openwrt.git' },
    ],
  };
}

function offlineFeeds(jobId: string) {
  const recursiveSubmoduleStatusSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  return {
    schemaVersion: 1 as const,
    boundary: 'api-prepared-pinned-feeds-v1' as const,
    networkPolicy: 'runner-offline' as const,
    jobId,
    sourceSha: SHA40,
    preparedAt: ACCEPTED,
    feeds: [
      { name: 'packages', location: 'https://git.openwrt.org/feed/packages.git', commit: 'd8cd30f4e281d6853b3de134c4f147a807583e43', detached: true as const, clean: true as const, recursiveSubmodulesPrepared: true as const, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: SHA64 },
      { name: 'luci', location: 'https://git.openwrt.org/project/luci.git', commit: '2ac26e56cc55102cb10e7b0867c2b78e0f6d5fd8', detached: true as const, clean: true as const, recursiveSubmodulesPrepared: true as const, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: SHA64 },
      { name: 'routing', location: 'https://git.openwrt.org/feed/routing.git', commit: 'c9b636698881059a3c981032770968f5a98ff201', detached: true as const, clean: true as const, recursiveSubmodulesPrepared: true as const, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: SHA64 },
    ],
  };
}

function input(jobId: string): CreateJobInput {
  return {
    jobId,
    requestId: `request-${jobId}`,
    request: { branch: 'main', target: 'rpi-5' },
    sourceRemote: 'git@example.com:osi-os.git',
    sourceRef: 'refs/remotes/origin/main',
    sourceBranch: 'main',
    branch: 'main',
    expectedSha: SHA40,
    pinnedSha: SHA40,
    sourcePreparation: sourcePreparation(),
    offlineFeedPreparation: offlineFeeds(jobId),
    targetId: 'rpi-5',
    rootId: 'release',
    targetManifestSha256: SHA64,
    builderIdentity: TEST_BUILDER_IDENTITY,
    sourceCommitTime: ACCEPTED,
    sourceAuthor: 'queue integration',
    sourceSubject: 'queue integration',
    acceptedAt: ACCEPTED,
  };
}

function dispatchCommand(jobId: string, at = DISPATCHED, owner = `dispatcher-${jobId}`, claimExpiresAt = new Date(Date.parse(at) + 60_000).toISOString()): Extract<Parameters<OwnershipStore['apiWrite']>[0], { kind: 'dispatch' }> {
  return { kind: 'dispatch', jobId, runnerUnit: `osi-image-builder-runner@${jobId}.service`, claimOwner: owner, claimExpiresAt, at };
}

function dispatchStartCommand(command: Extract<Parameters<OwnershipStore['apiWrite']>[0], { kind: 'dispatch' }>, at = command.at): Extract<Parameters<OwnershipStore['apiWrite']>[0], { kind: 'dispatch-start' }> {
  return {
    kind: 'dispatch-start',
    jobId: command.jobId,
    runnerUnit: command.runnerUnit,
    claimOwner: command.claimOwner,
    expectedClaimExpiresAt: command.claimExpiresAt,
    claimExpiresAt: command.claimExpiresAt,
    unitInactiveAt: at,
    startAttemptedAt: at,
    at,
  };
}

function directProof(jobId: string, startAttemptedAt: string, unitInactiveAt: string, verifiedAt: string): DirectInterruptionProof {
  return {
    kind: 'start-failure',
    runnerUnit: `osi-image-builder-runner@${jobId}.service`,
    startAttemptedAt,
    unitInactiveAt,
    runnerLeaseOwner: null,
    runnerLeaseExpiresAt: null,
    container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: unitInactiveAt },
    staging: { kind: 'absent', path: null },
    logs: { runner: 'absent', docker: 'absent', verifiedAt, generationIdentity: { runner: [], docker: [] } },
    blocker: 'none',
    cleanupAdmission: null,
    cleanupFence: null,
  };
}

function nullCleanupSnapshot(jobId: string): CleanupSnapshot {
  return {
    runner: { unit: `osi-image-builder-runner@${jobId}.service`, owner: null, leaseExpiresAt: null, inactiveAt: OBSERVED, observedAt: OBSERVED },
    state: 'starting',
    container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: OBSERVED },
    staging: { kind: 'absent', path: null },
    logs: { runner: 'absent', docker: 'absent', verifiedAt: OBSERVED },
    blocker: 'none',
  };
}

function nullCleanupPostcondition(jobId: string): CleanupPostcondition {
  return {
    runner: nullCleanupSnapshot(jobId).runner,
    state: 'starting',
    container: { kind: 'null-identity', dockerAction: 'none', globalLabelResult: 'no-match', observedAt: WRITTEN },
    staging: { kind: 'absent', path: null, sourcePath: `staging/${jobId}`, sourceAbsent: true, verifiedAt: WRITTEN },
    logs: { runner: 'absent', docker: 'absent', verifiedAt: WRITTEN },
    egress: { persistedDocker: null, discoveredDocker: [], credentials: [], globalLabelResult: 'no-match' },
    blocker: 'none',
  };
}

function physicalCleanupSnapshot(jobId: string): CleanupSnapshot {
  return {
    runner: { unit: `osi-image-builder-runner@${jobId}.service`, owner: null, leaseExpiresAt: null, inactiveAt: OBSERVED, observedAt: OBSERVED },
    state: 'starting',
    container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: OBSERVED },
    staging: { kind: 'physical-present', path: `staging/${jobId}`, sha256: null, size: null, observedAt: OBSERVED },
    logs: { runner: 'absent', docker: 'absent', verifiedAt: OBSERVED },
    blocker: 'staging-or-log',
  };
}

function physicalCleanupPostcondition(jobId: string): CleanupPostcondition {
  return {
    runner: physicalCleanupSnapshot(jobId).runner,
    state: 'starting',
    container: { kind: 'null-identity', dockerAction: 'none', globalLabelResult: 'no-match', observedAt: WRITTEN },
    staging: { kind: 'quarantined', sourcePath: `staging/${jobId}`, destinationPath: `quarantine/${jobId}`, sourceAbsent: true, destinationPresent: true, sha256: null, size: null, verifiedAt: WRITTEN },
    logs: { runner: 'absent', docker: 'absent', verifiedAt: WRITTEN },
    egress: { persistedDocker: null, discoveredDocker: [], credentials: [], globalLabelResult: 'no-match' },
    blocker: 'none',
  };
}

async function fixture(jobIds: readonly string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'osi-queue-service-start-'));
  directories.push(directory);
  const db = openBuilderDatabase(join(directory, 'jobs.sqlite'));
  databases.push(db);
  const ownership = new OwnershipStore(db, { now: () => WRITTEN });
  for (const jobId of jobIds) expect(ownership.apiWrite({ kind: 'enqueue', input: input(jobId) }).ok).toBe(true);
  return { db, ownership };
}

function systemdState(startResult: 'success' | 'failure' = 'success') {
  const active = new Set<string>();
  const pending = new Set<string>();
  const starts: string[] = [];
  const systemd: QueueSystemd = {
    inspect: async (unit) => ({ unit, active: active.has(unit), pending: pending.has(unit), observedAt: WRITTEN }),
    listActive: async () => [...new Set([...active, ...pending])],
    start: async (unit) => {
      starts.push(unit);
      if (startResult === 'success') active.add(unit);
      return { unit, argv: ['systemctl', '--user', 'start', unit], exitCode: startResult === 'success' ? 0 : 1, timedOut: false };
    },
  };
  return { systemd, starts, active, pending };
}

function seedQueueBlocker(db: ReturnType<typeof openBuilderDatabase>, kind: string): void {
  if (kind === 'cleanup fence') {
    db.exec('DROP TRIGGER jobs_fence_guard_update');
    db.prepare('UPDATE jobs SET cleanup_generation=1, cleanup_fence_generation=1, cleanup_fence_token_hash=?, cleanup_admission_id=? WHERE job_id=?').run(SHA64, 'cln_0123456789abcdefghjkmnpqrs', 'first');
  } else if (kind === 'cleanup admission') {
    db.exec('DROP TRIGGER jobs_fence_guard_update');
    db.prepare('UPDATE jobs SET cleanup_generation=1, cleanup_fence_generation=1, cleanup_fence_token_hash=?, cleanup_admission_id=? WHERE job_id=?').run(SHA64, 'cln_0123456789abcdefghjkmnpqrs', 'first');
  }
  else if (kind === 'cleanup blocker') db.prepare("UPDATE jobs SET cleanup_blocker_code='SERVICE_START_FAILED', cleanup_blocker_json='{}' WHERE job_id=?").run('first');
  else if (kind === 'container') db.prepare(`UPDATE jobs SET
    container_id='container-first', container_name='osi-first', container_image_digest=?, container_label_job_id='first',
    container_label_manifest_sha=?, container_labels_json=?, container_mount_json='{}', container_env_json='{}',
    container_security_json='{}', container_inspection_json='{}', container_created_at=? WHERE job_id=?`).run(SHA64, SHA64, JSON.stringify({ 'org.osi.image-builder.job-id': 'first', 'org.osi.image-builder.manifest-sha': SHA64 }), WRITTEN, 'first');
  else if (kind === 'staging') {
    db.exec('DROP TRIGGER jobs_publish_null_guard_update');
    db.prepare("UPDATE jobs SET artifact_staging_path='staging/first/image' WHERE job_id=?").run('first');
  } else if (kind === 'unsealed log') db.prepare('INSERT INTO job_log_generations (job_id, stream, generation, path, started_at, size_bytes) VALUES (?, ?, 0, ?, ?, 0)').run('first', 'runner', 'logs/runner-0.log', WRITTEN);
  else if (kind === 'publish blocker') {
    db.exec('DROP TRIGGER jobs_publish_guard');
    db.prepare("UPDATE jobs SET publish_state='blocked', publish_blocker_code='PUBLISH_FAILED', publish_blocker_json='{}' WHERE job_id=?").run('first');
  }
  else if (kind === 'publishing state') {
    db.prepare(`UPDATE jobs SET
      artifact_staging_path='staging/first/image.gz',
      artifact_final_directory='main/${SHA40}/rpi-5',
      artifact_final_path='main/${SHA40}/rpi-5/image.gz',
      artifact_sha256=?, artifact_size=1, artifact_mtime=?,
      checksum_path='staging/first/image.gz.sha256', checksum_sha256=?,
      manifest_path='staging/first/manifest.json', manifest_sha256=?,
      verification_path='staging/first/verification.json', verification_sha256=?,
      publish_state='publishing', publish_started_at=?, release_seal_status='in_progress'
      WHERE job_id=?`).run(SHA64, WRITTEN, SHA64, SHA64, SHA64, WRITTEN, 'first');
  }
}

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('queue service-start recovery with real SQLite stores', () => {
  it('defers an inactive starting row with an unexpired runner lease without mutation', async () => {
    const target = await fixture(['first', 'second']);
    const dispatch = dispatchCommand('first');
    expect(target.ownership.apiWrite(dispatch).ok).toBe(true);
    expect(target.ownership.apiWrite(dispatchStartCommand(dispatch)).ok).toBe(true);
    expect(target.ownership.runnerWrite({ kind: 'acquire-lease', jobId: 'first', runnerUnit: 'osi-image-builder-runner@first.service', owner: 'runner-a', expiresAt: LATER, at: OBSERVED }).ok).toBe(true);
    const before = target.db.prepare('SELECT state, queue_state, runner_lease_owner, runner_lease_expires_at, cleanup_blocker_code FROM jobs WHERE job_id=?').get('first');
    const state = systemdState();
    const directInterrupt = vi.fn(async () => null);
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd: state.systemd, safety: { inspect: async () => null }, directInterrupt, clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toEqual({ kind: 'blocked', reason: 'RUNNER_LEASE_LIVE', jobId: 'first' });
    expect(target.db.prepare('SELECT state, queue_state, runner_lease_owner, runner_lease_expires_at, cleanup_blocker_code FROM jobs WHERE job_id=?').get('first')).toEqual(before);
    expect(directInterrupt).not.toHaveBeenCalled();
    expect(state.starts).toHaveLength(0);
  });

  it.each([
    ['owner without expiry', 'runner-a', null],
    ['expiry without owner', null, LATER],
    ['invalid expiry', 'runner-a', 'not-an-instant'],
  ])('fails closed for a malformed runner lease pair: %s', async (_label, owner, expiresAt) => {
    const target = await fixture(['first', 'second']);
    expect(target.ownership.apiWrite(dispatchCommand('first')).ok).toBe(true);
    target.db.exec('DROP TRIGGER jobs_runner_lease_guard_update');
    target.db.prepare('UPDATE jobs SET runner_lease_owner=?, runner_lease_expires_at=? WHERE job_id=?').run(owner, expiresAt, 'first');
    const before = target.db.prepare('SELECT state, queue_state, runner_lease_owner, runner_lease_expires_at, cleanup_blocker_code FROM jobs WHERE job_id=?').get('first');
    const state = systemdState();
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd: state.systemd, safety: { inspect: async () => null }, clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toEqual({ kind: 'blocked', reason: 'RUNNER_LEASE_MALFORMED', jobId: 'first' });
    expect(target.db.prepare('SELECT state, queue_state, runner_lease_owner, runner_lease_expires_at, cleanup_blocker_code FROM jobs WHERE job_id=?').get('first')).toEqual(before);
    expect(state.starts).toHaveLength(0);
  });

  it('defers a stale lease to RUNNER_DISAPPEARED recovery without SERVICE_START_FAILED mutation', async () => {
    const target = await fixture(['first', 'second']);
    const dispatch = dispatchCommand('first');
    expect(target.ownership.apiWrite(dispatch).ok).toBe(true);
    expect(target.ownership.apiWrite(dispatchStartCommand(dispatch)).ok).toBe(true);
    expect(target.ownership.runnerWrite({ kind: 'acquire-lease', jobId: 'first', runnerUnit: 'osi-image-builder-runner@first.service', owner: 'runner-a', expiresAt: OBSERVED, at: DISPATCHED }).ok).toBe(true);
    const before = target.db.prepare('SELECT state, queue_state, runner_lease_owner, runner_lease_expires_at, cleanup_blocker_code, terminal_error_code FROM jobs WHERE job_id=?').get('first');
    const state = systemdState();
    const directInterrupt = vi.fn(async () => null);
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd: state.systemd, safety: { inspect: async () => null }, directInterrupt, clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toMatchObject({ kind: 'recovery-blocked', jobId: 'first', blocker: { code: 'RUNNER_DISAPPEARED' } });
    expect(target.db.prepare('SELECT state, queue_state, runner_lease_owner, runner_lease_expires_at, cleanup_blocker_code, terminal_error_code FROM jobs WHERE job_id=?').get('first')).toEqual({ ...before, cleanup_blocker_code: 'RUNNER_DISAPPEARED' });
    expect(directInterrupt).not.toHaveBeenCalled();
    expect(state.starts).toHaveLength(0);
  });

  it('defers a stale lease without mutation when the runner unit is active', async () => {
    const target = await fixture(['first', 'second']);
    const dispatch = dispatchCommand('first');
    expect(target.ownership.apiWrite(dispatch).ok).toBe(true);
    expect(target.ownership.apiWrite(dispatchStartCommand(dispatch)).ok).toBe(true);
    expect(target.ownership.runnerWrite({ kind: 'acquire-lease', jobId: 'first', runnerUnit: 'osi-image-builder-runner@first.service', owner: 'runner-a', expiresAt: OBSERVED, at: DISPATCHED }).ok).toBe(true);
    const before = target.db.prepare('SELECT state, queue_state, runner_lease_owner, runner_lease_expires_at, cleanup_blocker_code, terminal_error_code FROM jobs WHERE job_id=?').get('first');
    const state = systemdState();
    state.active.add('osi-image-builder-runner@first.service');
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd: state.systemd, safety: { inspect: async () => null }, clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toEqual({ kind: 'blocked', reason: 'runner unit is live', jobId: 'first' });
    expect(target.db.prepare('SELECT state, queue_state, runner_lease_owner, runner_lease_expires_at, cleanup_blocker_code, terminal_error_code FROM jobs WHERE job_id=?').get('first')).toEqual(before);
    expect(state.starts).toHaveLength(0);
  });

  it('treats an activating runner returned by listActive as a live unit', async () => {
    const target = await fixture(['first', 'second']);
    const state = systemdState();
    state.pending.add('osi-image-builder-runner@first.service');
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd: state.systemd, safety: { inspect: async () => null }, clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toEqual({ kind: 'blocked', reason: 'LIVE_RUNNER_UNIT', jobId: 'first' });
    expect(state.starts).toHaveLength(0);
    expect(target.db.prepare('SELECT state, queue_state FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'queued', queue_state: 'queued' });
  });

  it('fails closed for a claimless pre-start row without direct terminal recovery', async () => {
    const target = await fixture(['first', 'second']);
    expect(target.ownership.apiWrite({ kind: 'dispatch', jobId: 'first', runnerUnit: 'osi-image-builder-runner@first.service', claimOwner: 'dispatcher-a', claimExpiresAt: EXPIRED, at: DISPATCHED }).ok).toBe(true);
    target.db.prepare('DELETE FROM queue_dispatch_claims WHERE claim_id=1').run();
    const state = systemdState('failure');
    const directInterrupt = vi.fn(async (inputValue: { jobId: string; startAttemptedAt: string; unitInactiveAt: string }) => directProof(inputValue.jobId, inputValue.startAttemptedAt, inputValue.unitInactiveAt, WRITTEN));
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd: state.systemd, safety: { inspect: async () => null }, directInterrupt, clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toEqual({ kind: 'blocked', reason: 'DISPATCH_CLAIM_MISSING', jobId: 'first' });
    expect(directInterrupt).not.toHaveBeenCalled();
    expect(target.db.prepare('SELECT state, queue_state, cleanup_blocker_code, terminal_error_code FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'starting', queue_state: 'dispatched', cleanup_blocker_code: null, terminal_error_code: null });
    expect(target.db.prepare('SELECT state, queue_state FROM jobs WHERE job_id=?').get('second')).toEqual({ state: 'queued', queue_state: 'queued' });
  });

  it('reclaims an expired pre-start claim, persists SERVICE_START_FAILED, and releases it atomically', async () => {
    const target = await fixture(['first', 'second']);
    expect(target.ownership.apiWrite({ kind: 'dispatch', jobId: 'first', runnerUnit: 'osi-image-builder-runner@first.service', claimOwner: 'dispatcher-a', claimExpiresAt: EXPIRED, at: DISPATCHED }).ok).toBe(true);
    const state = systemdState('failure');
    const systemd = { ...state.systemd, inspect: async (unit: string) => ({ unit, active: false, pending: false, observedAt: EXPIRED }) };
    const directInterrupt = vi.fn(async () => directProof('first', DISPATCHED, WRITTEN, WRITTEN));
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd, safety: { inspect: async () => null }, directInterrupt, coordinatorId: 'dispatcher-a', clock: { now: () => EXPIRED } });

    await expect(coordinator.dispatchNext()).resolves.toMatchObject({ kind: 'recovery-blocked', jobId: 'first', blocker: { code: 'SERVICE_START_FAILED' } });
    expect(directInterrupt).not.toHaveBeenCalled();
    expect(target.db.prepare('SELECT state, queue_state, cleanup_blocker_code, terminal_error_code FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'starting', queue_state: 'dispatched', cleanup_blocker_code: 'SERVICE_START_FAILED', terminal_error_code: null });
    expect(target.db.prepare('SELECT 1 AS present FROM queue_dispatch_claims WHERE claim_id=1').get()).toBeUndefined();
    expect(target.db.prepare('SELECT state, queue_state FROM jobs WHERE job_id=?').get('second')).toEqual({ state: 'queued', queue_state: 'queued' });
  });

  it('serializes claim-to-start ownership across coordinators while coordinator A is paused after its dispatch CAS', async () => {
    const target = await fixture(['first', 'second']);
    const state = systemdState();
    let releaseA!: () => void;
    const pausedA = new Promise<void>((resolve) => { releaseA = resolve; });
    let afterClaim = false;
    const safetyA = { inspect: async ({ phase }: { phase: string }) => {
      if (phase === 'before-start' && !afterClaim) {
        afterClaim = true;
        await pausedA;
      }
      return null;
    } };
    const coordinatorA = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd: state.systemd, safety: safetyA, coordinatorId: 'dispatcher-a', clock: { now: () => WRITTEN } });
    const coordinatorB = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd: state.systemd, safety: { inspect: async () => null }, coordinatorId: 'dispatcher-b', clock: { now: () => WRITTEN } });
    const dispatchA = coordinatorA.dispatchNext();
    await vi.waitFor(() => expect(target.db.prepare('SELECT job_id, owner, phase FROM queue_dispatch_claims WHERE claim_id=1').get()).toMatchObject({ job_id: 'first', owner: expect.any(String), phase: 'pre-start' }));
    const beforeB = target.db.prepare('SELECT state, queue_state, runner_unit, dispatched_at FROM jobs ORDER BY job_id').all();

    await expect(coordinatorB.dispatchNext()).resolves.toEqual({ kind: 'blocked', reason: 'DISPATCH_CLAIM_LIVE', jobId: 'first' });
    expect(target.db.prepare('SELECT state, queue_state, runner_unit, dispatched_at FROM jobs ORDER BY job_id').all()).toEqual(beforeB);
    expect(state.starts).toHaveLength(0);

    releaseA();
    await expect(dispatchA).resolves.toMatchObject({ kind: 'started', jobId: 'first' });
    expect(target.db.prepare('SELECT job_id, owner, phase FROM queue_dispatch_claims WHERE claim_id=1').get()).toEqual({ job_id: 'first', owner: 'dispatcher-a', phase: 'start-attempted' });
    expect(target.ownership.runnerWrite({ kind: 'acquire-lease', jobId: 'first', runnerUnit: 'osi-image-builder-runner@first.service', owner: 'runner-a', expiresAt: LATER, at: WRITTEN }).ok).toBe(true);
    expect(target.db.prepare('SELECT 1 AS present FROM queue_dispatch_claims WHERE claim_id=1').get()).toBeUndefined();
  });

  it('renews a claim while systemd start is pending beyond its original expiry', async () => {
    vi.useFakeTimers();
    try {
      const target = await fixture(['first', 'second']);
      const base = Date.parse(DISPATCHED);
      let virtualNow = base;
      let releaseStart!: () => void;
      let enteredStart!: () => void;
      const startEntered = new Promise<void>((resolve) => { enteredStart = resolve; });
      const startPaused = new Promise<void>((resolve) => { releaseStart = resolve; });
      const active = new Set<string>();
      const systemd: QueueSystemd = {
        inspect: async (unit) => ({ unit, active: active.has(unit), pending: false, observedAt: new Date(virtualNow).toISOString() }),
        listActive: async () => [...active],
        start: async (unit) => {
          enteredStart();
          await startPaused;
          active.add(unit);
          return { unit, argv: ['systemctl', '--user', 'start', unit], exitCode: 0, timedOut: false };
        },
      };
      const common = {
        db: target.db,
        systemd,
        safety: { inspect: async () => null },
        clock: { now: () => new Date(virtualNow).toISOString() },
        dispatchClaimLeaseMs: 40,
        dispatchClaimRenewIntervalMs: 5,
      } as unknown as QueueCoordinatorOptions;
      const coordinatorA = createQueueCoordinator({ ...common, ownership: target.ownership, coordinatorId: 'dispatcher-a' });
      const coordinatorB = createQueueCoordinator({ ...common, ownership: target.ownership, coordinatorId: 'dispatcher-b' });
      const dispatchA = coordinatorA.dispatchNext();
      await startEntered;
      expect(target.db.prepare('SELECT phase FROM queue_dispatch_claims WHERE claim_id=1').get()).toEqual({ phase: 'start-attempted' });
      target.db.prepare('UPDATE queue_dispatch_claims SET lease_expires_at=? WHERE claim_id=1').run(new Date(base + 40).toISOString());

      virtualNow = base + 20;
      await vi.advanceTimersByTimeAsync(10);
      virtualNow = base + 50;
      await vi.advanceTimersByTimeAsync(10);
      const renewed = target.db.prepare('SELECT lease_expires_at FROM queue_dispatch_claims WHERE claim_id=1').get() as { lease_expires_at: string };
      expect(Date.parse(renewed.lease_expires_at)).toBeGreaterThan(virtualNow);

      await expect(coordinatorB.dispatchNext()).resolves.toEqual({ kind: 'blocked', reason: 'DISPATCH_CLAIM_LIVE', jobId: 'first' });
      expect(target.db.prepare('SELECT cleanup_blocker_code FROM jobs WHERE job_id=?').get('first')).toEqual({ cleanup_blocker_code: null });
      expect(target.db.prepare('SELECT state, queue_state FROM jobs WHERE job_id=?').get('second')).toEqual({ state: 'queued', queue_state: 'queued' });

      releaseStart();
      await expect(dispatchA).resolves.toMatchObject({ kind: 'started', jobId: 'first' });
      expect(target.db.prepare('SELECT phase FROM queue_dispatch_claims WHERE claim_id=1').get()).toEqual({ phase: 'start-attempted' });
      expect(target.ownership.runnerWrite({ kind: 'acquire-lease', jobId: 'first', runnerUnit: 'osi-image-builder-runner@first.service', owner: 'runner-a', expiresAt: new Date(virtualNow + 1_000).toISOString(), at: new Date(virtualNow).toISOString() }).ok).toBe(true);
      expect(target.db.prepare('SELECT 1 AS present FROM queue_dispatch_claims WHERE claim_id=1').get()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reclaims an expired start-attempt claim before physical recovery', async () => {
    const target = await fixture(['first']);
    expect(target.ownership.apiWrite(dispatchCommand('first', DISPATCHED, 'dispatcher-a', EXPIRED)).ok).toBe(true);
    expect(target.ownership.apiWrite({ kind: 'dispatch-start', jobId: 'first', runnerUnit: 'osi-image-builder-runner@first.service', claimOwner: 'dispatcher-a', expectedClaimExpiresAt: EXPIRED, claimExpiresAt: EXPIRED, unitInactiveAt: WRITTEN, startAttemptedAt: WRITTEN, at: WRITTEN }).ok).toBe(true);
    const state = systemdState('failure');
    const directInterrupt = vi.fn(async (inputValue: { jobId: string; startAttemptedAt: string; unitInactiveAt: string }) => directProof(inputValue.jobId, inputValue.startAttemptedAt, inputValue.unitInactiveAt, EXPIRED));
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd: { ...state.systemd, inspect: async (unit) => ({ unit, active: false, pending: false, observedAt: EXPIRED }) }, safety: { inspect: async () => null }, directInterrupt, coordinatorId: 'dispatcher-b', clock: { now: () => EXPIRED } });

    await expect(coordinator.dispatchNext()).resolves.toMatchObject({ kind: 'interrupted', jobId: 'first' });
    expect(directInterrupt).toHaveBeenCalledWith(expect.objectContaining({ startAttemptedAt: WRITTEN, unitInactiveAt: WRITTEN }), expect.any(AbortSignal));
    expect(target.db.prepare('SELECT 1 AS present FROM queue_dispatch_claims WHERE claim_id=1').get()).toBeUndefined();
  });

  it('uses SQLite FIFO CAS when two coordinators dispatch concurrently', async () => {
    const target = await fixture(['first', 'second']);
    const state = systemdState();
    const options = { db: target.db, ownership: target.ownership, systemd: state.systemd, safety: { inspect: async () => null }, clock: { now: () => WRITTEN } };
    const [left, right] = await Promise.all([
      createQueueCoordinator(options).dispatchNext(),
      createQueueCoordinator(options).dispatchNext(),
    ]);

    expect([left, right].filter((result) => result.kind === 'started')).toHaveLength(1);
    expect(state.starts).toHaveLength(1);
    expect(target.db.prepare('SELECT job_id, state, queue_state FROM jobs ORDER BY job_id').all()).toEqual([
      { job_id: 'first', state: 'starting', queue_state: 'dispatched' },
      { job_id: 'second', state: 'queued', queue_state: 'queued' },
    ]);
  });

  it('recovers a persisted start-attempt claim after a crash and only later dispatches the next row', async () => {
    const target = await fixture(['first', 'second']);
    expect(target.ownership.apiWrite(dispatchCommand('first', DISPATCHED, 'dispatcher-first', WRITTEN)).ok).toBe(true);
    expect(target.ownership.apiWrite({ kind: 'dispatch-start', jobId: 'first', runnerUnit: 'osi-image-builder-runner@first.service', claimOwner: 'dispatcher-first', expectedClaimExpiresAt: WRITTEN, claimExpiresAt: WRITTEN, unitInactiveAt: DISPATCHED, startAttemptedAt: DISPATCHED, at: DISPATCHED }).ok).toBe(true);
    const state = systemdState();
    let proofInput: { startAttemptedAt: string } | undefined;
    const directInterrupt = async (inputValue: { startAttemptedAt: string; jobId: string; unitInactiveAt: string }) => {
      proofInput = inputValue;
      return directProof(inputValue.jobId, inputValue.startAttemptedAt, inputValue.unitInactiveAt, WRITTEN);
    };
    const firstCoordinator = createQueueCoordinator({
      db: target.db,
      ownership: new OwnershipStore(target.db, { now: () => WRITTEN }),
      systemd: state.systemd,
      safety: { inspect: async () => null },
      directInterrupt,
      clock: { now: () => WRITTEN },
    });

    await expect(firstCoordinator.dispatchNext()).resolves.toEqual({ kind: 'interrupted', jobId: 'first' });
    expect(proofInput?.startAttemptedAt).toBe(DISPATCHED);
    expect(target.db.prepare('SELECT state, queue_state, terminal_error_code FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'interrupted', queue_state: 'complete', terminal_error_code: 'SERVICE_START_FAILED' });
    expect(target.db.prepare('SELECT 1 AS present FROM queue_entries WHERE job_id=?').get('first')).toBeUndefined();

    await expect(firstCoordinator.dispatchNext()).resolves.toMatchObject({ kind: 'started', jobId: 'second' });
    expect(state.starts).toEqual(['osi-image-builder-runner@second.service']);
    expect(target.db.prepare('SELECT state, queue_state FROM jobs WHERE job_id=?').get('second')).toEqual({ state: 'starting', queue_state: 'dispatched' });
  });

  it('commits a trusted direct start interruption at the timestamp captured after physical proof', async () => {
    const target = await fixture(['first']);
    const state = systemdState('failure');
    let proofReturned = false;
    const systemd: QueueSystemd = {
      ...state.systemd,
      inspect: async (unit) => ({ unit, active: false, pending: false, observedAt: proofReturned ? LATER : WRITTEN }),
    };
    const directInterrupt = vi.fn(async (inputValue: { jobId: string; startAttemptedAt: string }) => {
      proofReturned = true;
      return directProof(inputValue.jobId, inputValue.startAttemptedAt, WRITTEN, LATER);
    });
    let capturedProof: DirectInterruptionProof | undefined;
    const ownership = { apiWrite: (command: Parameters<OwnershipStore['apiWrite']>[0]) => {
      if (command.kind === 'direct-interrupt') capturedProof = command.proof;
      return target.ownership.apiWrite(command);
    } };
    const coordinator = createQueueCoordinator({
      db: target.db,
      ownership,
      systemd,
      safety: { inspect: async () => null },
      directInterrupt,
      clock: { now: () => proofReturned ? LATER : WRITTEN },
    });

    await expect(coordinator.dispatchNext()).resolves.toMatchObject({ kind: 'interrupted', jobId: 'first' });
    expect(directInterrupt).toHaveBeenCalledWith(expect.objectContaining({ startAttemptedAt: WRITTEN }), expect.any(AbortSignal));
    expect(capturedProof?.kind).toBe('start-failure');
    expect(capturedProof && capturedProof.kind === 'start-failure' ? capturedProof.unitInactiveAt : undefined).toBe(LATER);
    expect(target.db.prepare('SELECT state, terminal_error_code, terminal_at FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'interrupted', terminal_error_code: 'SERVICE_START_FAILED', terminal_at: LATER });
  });

  it('keeps physical container and log timestamps while rebinding only final systemd inactivity', async () => {
    const target = await fixture(['first']);
    const state = systemdState('failure');
    let inspectCount = 0;
    let capturedProof: DirectInterruptionProof | undefined;
    const systemd: QueueSystemd = {
      ...state.systemd,
      inspect: async (unit) => {
        inspectCount += 1;
        return { unit, active: false, pending: false, observedAt: inspectCount >= 3 ? FINAL : WRITTEN };
      },
    };
    const directInterrupt = vi.fn(async (inputValue: { jobId: string; startAttemptedAt: string; unitInactiveAt: string }) => ({
      ...directProof(inputValue.jobId, inputValue.startAttemptedAt, inputValue.unitInactiveAt, LATER),
      container: { kind: 'absent' as const, globalLabelResult: 'no-match' as const, observedAt: LATER },
    }));
    const ownership = { apiWrite: (command: Parameters<OwnershipStore['apiWrite']>[0]) => {
      if (command.kind === 'direct-interrupt') capturedProof = command.proof;
      return target.ownership.apiWrite(command);
    } };
    const coordinator = createQueueCoordinator({ db: target.db, ownership, systemd, safety: { inspect: async () => null }, directInterrupt, clock: { now: () => inspectCount >= 3 ? FINAL : WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toMatchObject({ kind: 'interrupted', jobId: 'first' });
    expect(capturedProof).toMatchObject({ unitInactiveAt: FINAL, container: { observedAt: LATER }, logs: { verifiedAt: LATER } });
    expect(target.db.prepare('SELECT state, terminal_at FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'interrupted', terminal_at: FINAL });
  });

  it('rejects a direct proof whose timestamps do not match the verifier input', async () => {
    const target = await fixture(['first', 'second']);
    const state = systemdState('failure');
    const directInterrupt = vi.fn(async (inputValue: { jobId: string; unitInactiveAt: string }) => directProof(inputValue.jobId, DISPATCHED, inputValue.unitInactiveAt, WRITTEN));
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd: state.systemd, safety: { inspect: async () => null }, directInterrupt, coordinatorId: 'dispatcher-a', clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toEqual({ kind: 'blocked', reason: 'DIRECT_PROOF_MISMATCH', jobId: 'first' });
    expect(target.db.prepare('SELECT state, queue_state, cleanup_blocker_code, terminal_error_code FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'starting', queue_state: 'dispatched', cleanup_blocker_code: null, terminal_error_code: null });
    expect(target.db.prepare('SELECT phase, start_attempted_at FROM queue_dispatch_claims WHERE claim_id=1').get()).toMatchObject({ phase: 'start-attempted', start_attempted_at: WRITTEN });
  });

  it('rejects a direct proof whose container observation does not match the verifier input', async () => {
    const target = await fixture(['first', 'second']);
    const state = systemdState('failure');
    const directInterrupt = vi.fn(async (inputValue: { jobId: string; startAttemptedAt: string; unitInactiveAt: string }) => ({
      ...directProof(inputValue.jobId, inputValue.startAttemptedAt, inputValue.unitInactiveAt, WRITTEN),
      container: { kind: 'absent' as const, globalLabelResult: 'no-match' as const, observedAt: DISPATCHED },
    }));
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd: state.systemd, safety: { inspect: async () => null }, directInterrupt, coordinatorId: 'dispatcher-a', clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toEqual({ kind: 'blocked', reason: 'DIRECT_PROOF_MISMATCH', jobId: 'first' });
    expect(target.db.prepare('SELECT state, queue_state, cleanup_blocker_code, terminal_error_code FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'starting', queue_state: 'dispatched', cleanup_blocker_code: null, terminal_error_code: null });
    expect(target.db.prepare('SELECT phase, unit_inactive_at FROM queue_dispatch_claims WHERE claim_id=1').get()).toEqual({ phase: 'start-attempted', unit_inactive_at: WRITTEN });
  });

  it('does not terminalize when the runner activates during the physical proof', async () => {
    const target = await fixture(['first', 'second']);
    const state = systemdState('failure');
    let inspectCount = 0;
    let releaseProof!: () => void;
    const proofPaused = new Promise<void>((resolve) => { releaseProof = resolve; });
    const systemd: QueueSystemd = {
      ...state.systemd,
      inspect: async (unit) => {
        inspectCount += 1;
        if (inspectCount === 3) return { unit, active: true, pending: false, observedAt: LATER };
        return { unit, active: false, pending: false, observedAt: inspectCount === 1 ? WRITTEN : LATER };
      },
    };
    const directInterrupt = vi.fn(async (inputValue: { jobId: string; startAttemptedAt: string; unitInactiveAt: string }) => {
      await proofPaused;
      return directProof(inputValue.jobId, inputValue.startAttemptedAt, inputValue.unitInactiveAt, WRITTEN);
    });
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd, safety: { inspect: async () => null }, directInterrupt, coordinatorId: 'dispatcher-a', clock: { now: () => inspectCount <= 1 ? WRITTEN : LATER } });
    const dispatch = coordinator.dispatchNext();
    await vi.waitFor(() => expect(directInterrupt).toHaveBeenCalledTimes(1));
    releaseProof();

    await expect(dispatch).resolves.toEqual({ kind: 'blocked', reason: 'runner unit is live', jobId: 'first' });
    expect(target.db.prepare('SELECT state, queue_state, cleanup_blocker_code, terminal_error_code FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'starting', queue_state: 'dispatched', cleanup_blocker_code: null, terminal_error_code: null });
    expect(target.db.prepare('SELECT phase, unit_inactive_at FROM queue_dispatch_claims WHERE claim_id=1').get()).toEqual({ phase: 'start-attempted', unit_inactive_at: WRITTEN });
  });

  it('does not mutate or advance FIFO when the failed start leaves the runner unit active without a lease', async () => {
    const target = await fixture(['first', 'second']);
    const state = systemdState('failure');
    let inspectCount = 0;
    const directInterrupt = vi.fn(async () => directProof('first', WRITTEN, WRITTEN, WRITTEN));
    const systemd: QueueSystemd = {
      ...state.systemd,
      inspect: async (unit) => ({ unit, active: inspectCount++ > 0, pending: false, observedAt: WRITTEN }),
    };
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd, safety: { inspect: async () => null }, directInterrupt, clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toEqual({ kind: 'blocked', reason: 'runner unit is live', jobId: 'first' });
    expect(target.db.prepare('SELECT state, queue_state, cleanup_blocker_code, terminal_error_code FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'starting', queue_state: 'dispatched', cleanup_blocker_code: null, terminal_error_code: null });
    expect(target.db.prepare('SELECT state, queue_state FROM jobs WHERE job_id=?').get('second')).toEqual({ state: 'queued', queue_state: 'queued' });
    expect(directInterrupt).not.toHaveBeenCalled();
    expect(state.starts).toHaveLength(1);
  });

  it('does not mutate or advance FIFO when the failed start leaves the runner unit active with a live lease', async () => {
    const target = await fixture(['first', 'second']);
    const state = systemdState('failure');
    let inspectCount = 0;
    const directInterrupt = vi.fn(async () => directProof('first', WRITTEN, WRITTEN, WRITTEN));
    const systemd: QueueSystemd = {
      ...state.systemd,
      inspect: async (unit) => ({ unit, active: inspectCount++ > 0, pending: false, observedAt: WRITTEN }),
      start: async (unit) => {
        state.starts.push(unit);
        target.ownership.runnerWrite({ kind: 'acquire-lease', jobId: 'first', runnerUnit: unit, owner: 'runner-a', expiresAt: LATER, at: WRITTEN });
        return { unit, argv: ['systemctl', '--user', 'start', unit], exitCode: 1, timedOut: false };
      },
    };
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd, safety: { inspect: async () => null }, directInterrupt, clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toEqual({ kind: 'blocked', reason: 'RUNNER_LEASE_LIVE', jobId: 'first' });
    expect(target.db.prepare('SELECT state, queue_state, runner_lease_owner, runner_lease_expires_at, cleanup_blocker_code, terminal_error_code FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'starting', queue_state: 'dispatched', runner_lease_owner: 'runner-a', runner_lease_expires_at: LATER, cleanup_blocker_code: null, terminal_error_code: null });
    expect(target.db.prepare('SELECT state, queue_state FROM jobs WHERE job_id=?').get('second')).toEqual({ state: 'queued', queue_state: 'queued' });
    expect(directInterrupt).not.toHaveBeenCalled();
    expect(state.starts).toHaveLength(1);
  });

  it('does not reclaim or terminalize an expired claim while the manager reports a pending start', async () => {
    const target = await fixture(['first', 'second']);
    expect(target.ownership.apiWrite(dispatchCommand('first', ACCEPTED, 'dispatcher-old', DISPATCHED)).ok).toBe(true);
    let inspectCount = 0;
    const state = systemdState('failure');
    const systemd: QueueSystemd = {
      ...state.systemd,
      inspect: async (unit) => ({ unit, active: false, pending: inspectCount++ > -1, observedAt: EXPIRED }),
    };
    const before = target.db.prepare('SELECT job_id, owner, lease_expires_at, phase FROM queue_dispatch_claims WHERE claim_id=1').get();
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd, safety: { inspect: async () => null }, directInterrupt: async () => null, coordinatorId: 'dispatcher-new', clock: { now: () => EXPIRED } });

    await expect(coordinator.dispatchNext()).resolves.toEqual({ kind: 'blocked', reason: 'runner unit is live', jobId: 'first' });
    expect(target.db.prepare('SELECT job_id, owner, lease_expires_at, phase FROM queue_dispatch_claims WHERE claim_id=1').get()).toEqual(before);
    expect(target.db.prepare('SELECT state, queue_state, cleanup_blocker_code, terminal_error_code FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'starting', queue_state: 'dispatched', cleanup_blocker_code: null, terminal_error_code: null });
    expect(state.starts).toHaveLength(0);
  });

  it('treats a pending manager transaction as live after a failed start', async () => {
    const target = await fixture(['first', 'second']);
    const state = systemdState('failure');
    let inspectCount = 0;
    const systemd: QueueSystemd = {
      ...state.systemd,
      inspect: async (unit) => {
        inspectCount += 1;
        return { unit, active: false, pending: inspectCount === 3, observedAt: WRITTEN };
      },
    };
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd, safety: { inspect: async () => null }, directInterrupt: async () => directProof('first', WRITTEN, WRITTEN, WRITTEN), clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toEqual({ kind: 'blocked', reason: 'runner unit is live', jobId: 'first' });
    expect(target.db.prepare('SELECT state, queue_state, cleanup_blocker_code, terminal_error_code FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'starting', queue_state: 'dispatched', cleanup_blocker_code: null, terminal_error_code: null });
    expect(target.db.prepare('SELECT phase, unit_inactive_at FROM queue_dispatch_claims WHERE claim_id=1').get()).toEqual({ phase: 'start-attempted', unit_inactive_at: WRITTEN });
  });

  it.each([
    ['unavailable', async () => { throw new Error('systemd unavailable'); }, 'SYSTEMD_INSPECTION_UNAVAILABLE'],
    ['malformed', async (unit: string) => ({ unit } as never), 'INVALID_SYSTEMD_OBSERVATION'],
  ] as const)('does not mutate or advance FIFO when failed-start inactivity proof is %s', async (_label, recoveryInspection, reason) => {
    const target = await fixture(['first', 'second']);
    const state = systemdState('failure');
    let inspectCount = 0;
    const directInterrupt = vi.fn(async () => directProof('first', WRITTEN, WRITTEN, WRITTEN));
    const systemd: QueueSystemd = {
      ...state.systemd,
      inspect: async (unit) => {
        if (inspectCount++ === 0) return { unit, active: false, pending: false, observedAt: WRITTEN };
        return recoveryInspection(unit);
      },
    };
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd, safety: { inspect: async () => null }, directInterrupt, clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toEqual({ kind: 'blocked', reason, jobId: 'first' });
    expect(target.db.prepare('SELECT state, queue_state, cleanup_blocker_code, terminal_error_code FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'starting', queue_state: 'dispatched', cleanup_blocker_code: null, terminal_error_code: null });
    expect(target.db.prepare('SELECT state, queue_state FROM jobs WHERE job_id=?').get('second')).toEqual({ state: 'queued', queue_state: 'queued' });
    expect(directInterrupt).not.toHaveBeenCalled();
    expect(state.starts).toHaveLength(1);
  });

  it.each(['null', 'unavailable'])('persists durable SERVICE_START_FAILED recovery when trusted direct proof is %s', async (mode) => {
    const target = await fixture(['first', 'second']);
    const state = systemdState('failure');
    const directInterrupt = mode === 'null' ? async () => null : async () => { throw new Error('physical proof unavailable'); };
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd: state.systemd, safety: { inspect: async () => null }, directInterrupt, clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toMatchObject({ kind: 'recovery-blocked', jobId: 'first' });
    expect(target.db.prepare('SELECT state, queue_state, cleanup_blocker_code FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'starting', queue_state: 'dispatched', cleanup_blocker_code: 'SERVICE_START_FAILED' });
    expect(target.db.prepare('SELECT 1 AS present FROM queue_entries WHERE job_id=?').get('first')).toBeUndefined();
    expect(target.db.prepare('SELECT state, queue_state FROM jobs WHERE job_id=?').get('second')).toEqual({ state: 'queued', queue_state: 'queued' });
    expect(state.starts).toHaveLength(1);
  });

  it('requires a fresh active proof after a successful systemd start', async () => {
    const target = await fixture(['first']);
    const state = systemdState();
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd: state.systemd, safety: { inspect: async () => null }, clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toMatchObject({ kind: 'started', jobId: 'first' });
    expect(state.starts).toEqual(['osi-image-builder-runner@first.service']);
    expect(state.active.has('osi-image-builder-runner@first.service')).toBe(true);
  });

  it('keeps every later dispatch checkpoint successful after runner handoff during systemd start', async () => {
    const target = await fixture(['first']);
    const state = systemdState();
    let now = DISPATCHED;
    let activeListInspections = 0;
    const systemd: QueueSystemd = {
      ...state.systemd,
      inspect: async (unit) => ({
        unit,
        active: state.active.has(unit),
        pending: state.pending.has(unit),
        observedAt: state.active.has(unit) ? now : (now = OBSERVED),
      }),
      listActive: async () => {
        activeListInspections += 1;
        if (activeListInspections === 2) now = WRITTEN;
        return [...new Set([...state.active, ...state.pending])];
      },
      start: async (unit) => {
        state.starts.push(unit);
        state.active.add(unit);
        now = LATER;
        expect(target.ownership.runnerWrite({
          kind: 'acquire-lease',
          jobId: 'first',
          runnerUnit: unit,
          owner: 'runner-a',
          expiresAt: FINAL,
          at: LATER,
        }).ok).toBe(true);
        return { unit, argv: ['systemctl', '--user', 'start', unit], exitCode: 0, timedOut: false };
      },
    };
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd, safety: { inspect: async () => null }, clock: { now: () => now } });

    await expect(coordinator.dispatchNext()).resolves.toEqual({ kind: 'started', jobId: 'first', runnerUnit: 'osi-image-builder-runner@first.service' });
    expect(target.db.prepare('SELECT runner_lease_owner, runner_lease_expires_at FROM jobs WHERE job_id=?').get('first')).toEqual({ runner_lease_owner: 'runner-a', runner_lease_expires_at: FINAL });
    expect(target.db.prepare('SELECT 1 AS present FROM queue_dispatch_claims WHERE claim_id=1').get()).toBeUndefined();
  });

  it('accepts a live runner handoff that reaches publishing before dispatch returns', async () => {
    const target = await fixture(['first']);
    const state = systemdState();
    const systemd: QueueSystemd = {
      ...state.systemd,
      start: async (unit) => {
        state.starts.push(unit);
        state.active.add(unit);
        expect(target.ownership.runnerWrite({
          kind: 'acquire-lease',
          jobId: 'first',
          runnerUnit: unit,
          owner: 'runner-a',
          expiresAt: LATER,
          at: WRITTEN,
        }).ok).toBe(true);
        target.db.prepare("UPDATE jobs SET state='publishing' WHERE job_id=?").run('first');
        return { unit, argv: ['systemctl', '--user', 'start', unit], exitCode: 0, timedOut: false };
      },
    };
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd, safety: { inspect: async () => null }, clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toEqual({ kind: 'started', jobId: 'first', runnerUnit: 'osi-image-builder-runner@first.service' });
    expect(target.db.prepare('SELECT state, runner_lease_owner FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'publishing', runner_lease_owner: 'runner-a' });
  });

  it('rejects physical direct-proof observations that predate the durable start attempt', async () => {
    const target = await fixture(['first']);
    expect(target.ownership.apiWrite(dispatchCommand('first', DISPATCHED, 'dispatcher-old', WRITTEN)).ok).toBe(true);
    expect(target.ownership.apiWrite({
      kind: 'dispatch-start',
      jobId: 'first',
      runnerUnit: 'osi-image-builder-runner@first.service',
      claimOwner: 'dispatcher-old',
      expectedClaimExpiresAt: WRITTEN,
      claimExpiresAt: WRITTEN,
      unitInactiveAt: DISPATCHED,
      startAttemptedAt: OBSERVED,
      at: OBSERVED,
    }).ok).toBe(true);
    const state = systemdState('failure');
    const systemd: QueueSystemd = {
      ...state.systemd,
      inspect: async (unit) => ({ unit, active: false, pending: false, observedAt: LATER }),
    };
    const directInterrupt = vi.fn(async (inputValue: DirectInterruptionInput) => directProof(
      inputValue.jobId,
      inputValue.startAttemptedAt,
      inputValue.unitInactiveAt,
      LATER,
    ));
    const coordinator = createQueueCoordinator({
      db: target.db,
      ownership: target.ownership,
      systemd,
      safety: { inspect: async () => null },
      directInterrupt,
      coordinatorId: 'dispatcher-new',
      clock: { now: () => LATER },
    });

    await expect(coordinator.dispatchNext()).resolves.toEqual({ kind: 'blocked', reason: 'DIRECT_PROOF_MISMATCH', jobId: 'first' });
    expect(target.db.prepare('SELECT state, terminal_error_code FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'starting', terminal_error_code: null });
  });

  it('does not terminalize when claim renewal wins after direct-proof verifier input', async () => {
    const target = await fixture(['first']);
    const state = systemdState('failure');
    let releaseVerifier!: () => void;
    const verifierPaused = new Promise<void>((resolve) => { releaseVerifier = resolve; });
    const proofInputs: DirectInterruptionInput[] = [];
    const directInterrupt = vi.fn(async (inputValue: DirectInterruptionInput) => {
      proofInputs.push(inputValue);
      await verifierPaused;
      return directProof(String(inputValue.jobId), String(inputValue.startAttemptedAt), String(inputValue.unitInactiveAt), WRITTEN);
    });
    const coordinator = createQueueCoordinator({
      db: target.db,
      ownership: target.ownership,
      systemd: state.systemd,
      safety: { inspect: async () => null },
      directInterrupt,
      coordinatorId: 'dispatcher-direct-claim-expiry-race',
      clock: { now: () => WRITTEN },
    });

    const dispatch = coordinator.dispatchNext();
    await vi.waitFor(() => expect(directInterrupt).toHaveBeenCalledTimes(1));
    const verifierInput = proofInputs[0]!;
    const expectedClaimExpiresAt = String(verifierInput.expectedClaimExpiresAt);
    const renewedClaimExpiresAt = new Date(Date.parse(expectedClaimExpiresAt) + 1_000).toISOString();
    expect(target.ownership.apiWrite({
      kind: 'dispatch-renew',
      jobId: 'first',
      claimOwner: 'dispatcher-direct-claim-expiry-race',
      expectedClaimExpiresAt,
      claimExpiresAt: renewedClaimExpiresAt,
      at: LATER,
    }).ok).toBe(true);
    releaseVerifier();

    await expect(dispatch).resolves.toMatchObject({ kind: 'blocked', jobId: 'first' });
    expect(target.db.prepare('SELECT state, queue_state, terminal_error_code FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'starting', queue_state: 'dispatched', terminal_error_code: null });
    expect(target.db.prepare('SELECT lease_expires_at FROM queue_dispatch_claims WHERE claim_id=1').get()).toEqual({ lease_expires_at: renewedClaimExpiresAt });
  });

  it.each([
    'cleanup blocker', 'container', 'staging', 'unsealed log', 'publish blocker', 'publishing state',
  ])('retains a claimed-job %s blocker and prevents systemd start', async (kind) => {
    const target = await fixture(['first', 'second']);
    const state = systemdState();
    let injected = false;
    const safety = { inspect: async ({ phase }: { phase: string }) => {
      if (phase === 'before-start' && !injected) {
        injected = true;
        seedQueueBlocker(target.db, kind);
      }
      return null;
    } };
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd: state.systemd, safety, clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toMatchObject({ kind: expect.stringMatching(/^(blocked|recovery-blocked)$/), jobId: 'first' });
    expect(state.starts).toHaveLength(0);
    expect(target.db.prepare('SELECT state, queue_state FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'starting', queue_state: 'dispatched' });
    expect(target.db.prepare('SELECT state, queue_state FROM jobs WHERE job_id=?').get('second')).toEqual({ state: 'queued', queue_state: 'queued' });
    const retained = target.db.prepare(`SELECT cleanup_fence_generation, cleanup_admission_id, cleanup_blocker_code,
      container_id, artifact_staging_path, publish_state, publish_blocker_code,
      NULLIF((SELECT COUNT(*) FROM job_log_generations WHERE job_id=jobs.job_id AND sealed_at IS NULL), 0) AS unsealed_log_count
      FROM jobs WHERE job_id=?`).get('first') as Record<string, unknown>;
    expect(Object.values(retained).some((value) => value !== null)).toBe(true);
  });

  it('fails closed when the claim expires between final safety inspection and blocker CAS', async () => {
    vi.useFakeTimers();
    try {
      const target = await fixture(['first', 'second']);
      const base = Date.parse(DISPATCHED);
      let virtualNow = base;
      let releaseSafety!: () => void;
      const paused = new Promise<void>((resolve) => { releaseSafety = resolve; });
      let safetyCalls = 0;
      const state = systemdState('failure');
      const coordinator = createQueueCoordinator({
        db: target.db,
        ownership: target.ownership,
        systemd: state.systemd,
        safety: { inspect: async ({ phase }) => {
          if (phase === 'before-start' && safetyCalls++ === 0) await paused;
          return phase === 'before-start' && safetyCalls > 1 ? { code: 'LATE_SAFETY_BLOCKER' } : null;
        } },
        coordinatorId: 'dispatcher-expiring-blocker',
        clock: { now: () => new Date(virtualNow).toISOString() },
        dispatchClaimLeaseMs: 40,
        dispatchClaimRenewIntervalMs: 5,
      });
      const dispatch = coordinator.dispatchNext();
      await vi.waitFor(() => expect(target.db.prepare('SELECT phase FROM queue_dispatch_claims WHERE claim_id=1').get()).toEqual({ phase: 'pre-start' }));
      virtualNow = base + 50;
      releaseSafety();
      await expect(dispatch).resolves.toMatchObject({ kind: 'blocked', jobId: 'first' });
      expect(target.db.prepare('SELECT cleanup_blocker_code, state, queue_state FROM jobs WHERE job_id=?').get('first')).toEqual({ cleanup_blocker_code: null, state: 'starting', queue_state: 'dispatched' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when the claim expires after post-start observation', async () => {
    vi.useFakeTimers();
    try {
      const target = await fixture(['first']);
      const base = Date.parse(DISPATCHED);
      let virtualNow = base;
      const state = systemdState();
      const systemd: QueueSystemd = {
        ...state.systemd,
        inspect: async (unit) => ({ unit, active: state.active.has(unit), pending: false, observedAt: new Date(virtualNow).toISOString() }),
        start: async (unit) => { virtualNow = base + 50; state.active.add(unit); return { unit, argv: ['systemctl', '--user', 'start', unit], exitCode: 0, timedOut: false }; },
      };
      const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd, safety: { inspect: async () => null }, clock: { now: () => new Date(virtualNow).toISOString() }, dispatchClaimLeaseMs: 40, dispatchClaimRenewIntervalMs: 5 });

      await expect(coordinator.dispatchNext()).resolves.toMatchObject({ kind: 'blocked', jobId: 'first' });
      expect(target.db.prepare('SELECT state, queue_state, cleanup_blocker_code FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'starting', queue_state: 'dispatched', cleanup_blocker_code: null });
      expect(target.db.prepare('SELECT phase FROM queue_dispatch_claims WHERE claim_id=1').get()).toEqual({ phase: 'start-attempted' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a stalled systemd start and stops renewing its retained claim', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(WRITTEN);
    try {
      const target = await fixture(['first', 'second']);
      let releaseStart!: (result: Awaited<ReturnType<QueueSystemd['start']>>) => void;
      let startEntered = false;
      let startSignal: AbortSignal | undefined;
      const stalledStart = new Promise<Awaited<ReturnType<QueueSystemd['start']>>>((resolve) => { releaseStart = resolve; });
      const systemd: QueueSystemd = {
        inspect: async (unit) => ({ unit, active: false, pending: false, observedAt: new Date().toISOString() }),
        listActive: async () => [],
        start: async (_unit, signal) => {
          startEntered = true;
          startSignal = signal;
          return stalledStart;
        },
      };
      const coordinator = createQueueCoordinator({
        db: target.db,
        ownership: target.ownership,
        systemd,
        safety: { inspect: async () => null },
        dispatchClaimLeaseMs: 40,
        dispatchClaimRenewIntervalMs: 5,
        operationTimeoutMs: 20,
      });
      let settled = false;
      const dispatch = coordinator.dispatchNext().then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(startEntered).toBe(true);
      await vi.advanceTimersByTimeAsync(25);
      const settledBeforeRelease = settled;
      const expiryAfterTimeout = target.db.prepare('SELECT lease_expires_at FROM queue_dispatch_claims WHERE claim_id=1').get();
      await vi.advanceTimersByTimeAsync(50);
      const expiryAfterWait = target.db.prepare('SELECT lease_expires_at FROM queue_dispatch_claims WHERE claim_id=1').get();
      releaseStart({ unit: 'osi-image-builder-runner@first.service', argv: ['systemctl', '--user', 'start', 'osi-image-builder-runner@first.service'], exitCode: 1, timedOut: false });

      await expect(dispatch).resolves.toEqual({ kind: 'blocked', reason: 'SYSTEMD_START_TIMEOUT', jobId: 'first' });
      expect(settledBeforeRelease).toBe(true);
      expect(startSignal?.aborted).toBe(true);
      expect(expiryAfterWait).toEqual(expiryAfterTimeout);
      expect(target.db.prepare('SELECT state, queue_state FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'starting', queue_state: 'dispatched' });
      expect(target.db.prepare('SELECT state, queue_state FROM jobs WHERE job_id=?').get('second')).toEqual({ state: 'queued', queue_state: 'queued' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a stalled post-claim safety inspection without starting systemd', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(WRITTEN);
    try {
      const target = await fixture(['first']);
      const state = systemdState();
      let releaseSafety!: () => void;
      const stalledSafety = new Promise<void>((resolve) => { releaseSafety = resolve; });
      let stalled = false;
      let safetySignal: AbortSignal | undefined;
      const safety = { inspect: async ({ phase }: { phase: string }, signal?: AbortSignal) => {
        if (phase === 'before-start' && !stalled) {
          stalled = true;
          safetySignal = signal;
          await stalledSafety;
        }
        return null;
      } };
      const coordinator = createQueueCoordinator({
        db: target.db,
        ownership: target.ownership,
        systemd: {
          ...state.systemd,
          inspect: async (unit) => ({ unit, active: false, pending: false, observedAt: new Date().toISOString() }),
        },
        safety,
        operationTimeoutMs: 20,
      });
      let settled = false;
      const dispatch = coordinator.dispatchNext().then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stalled).toBe(true);
      await vi.advanceTimersByTimeAsync(25);
      const settledBeforeRelease = settled;
      releaseSafety();

      await expect(dispatch).resolves.toMatchObject({ kind: 'recovery-blocked', jobId: 'first' });
      expect(settledBeforeRelease).toBe(true);
      expect(safetySignal?.aborted).toBe(true);
      expect(state.starts).toHaveLength(0);
      expect(target.db.prepare('SELECT state, queue_state, cleanup_blocker_code FROM jobs WHERE job_id=?').get('first')).toEqual({
        state: 'starting',
        queue_state: 'dispatched',
        cleanup_blocker_code: 'SERVICE_START_FAILED',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    'cleanup fence', 'cleanup admission', 'cleanup blocker', 'container', 'staging', 'unsealed log', 'publish blocker', 'publishing state',
  ])('keeps the queue blocked by a real SQLite %s blocker', async (kind) => {
    const target = await fixture(['first', 'second']);
    seedQueueBlocker(target.db, kind);
    const state = systemdState();
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd: state.systemd, safety: { inspect: async () => null }, clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toMatchObject({ kind: 'blocked', reason: 'SQLITE_QUEUE_BLOCKER' });
    expect(state.starts).toHaveLength(0);
    expect(target.db.prepare('SELECT state, queue_state FROM jobs WHERE job_id=?').get('second')).toEqual({ state: 'queued', queue_state: 'queued' });
  });

  it('does not start when a final safety check observes a blocker after claim', async () => {
    const target = await fixture(['first', 'second']);
    const state = systemdState();
    let beforeStartCalls = 0;
    const safety = { inspect: async ({ phase }: { phase: string }) => {
      if (phase === 'before-start' && beforeStartCalls++ === 1) return { code: 'LATE_SAFETY_BLOCKER' };
      return null;
    } };
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd: state.systemd, safety, directInterrupt: async () => directProof('first', WRITTEN, WRITTEN, WRITTEN), clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toMatchObject({ kind: 'recovery-blocked', jobId: 'first' });
    expect(state.starts).toHaveLength(0);
  });

  it('does not start when the live systemd list becomes blocked after claim', async () => {
    const target = await fixture(['first']);
    const state = systemdState();
    let listCalls = 0;
    const systemd = { ...state.systemd, listActive: async () => listCalls++ === 0 ? [] : ['osi-image-builder-runner@other.service'] };
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd, safety: { inspect: async () => null }, directInterrupt: async () => directProof('first', WRITTEN, WRITTEN, WRITTEN), clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toMatchObject({ kind: 'recovery-blocked', jobId: 'first' });
    expect(state.starts).toHaveLength(0);
  });

  it('does not start when SQLite gains a blocker immediately before start', async () => {
    const target = await fixture(['first', 'second']);
    const state = systemdState();
    let beforeStartCalls = 0;
    const safety = { inspect: async ({ phase }: { phase: string }) => {
      if (phase === 'before-start' && beforeStartCalls++ === 1) target.db.prepare("UPDATE jobs SET cleanup_blocker_code='SERVICE_START_FAILED', cleanup_blocker_json='{}' WHERE job_id=?").run('second');
      return null;
    } };
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd: state.systemd, safety, directInterrupt: async () => directProof('first', WRITTEN, WRITTEN, WRITTEN), clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toMatchObject({ kind: 'recovery-blocked', jobId: 'first' });
    expect(state.starts).toHaveLength(0);
  });

  it('releases FIFO only after a real cleanup hand-back CAS and leaves the first job interrupted', async () => {
    const target = await fixture(['first', 'second']);
    expect(target.ownership.apiWrite(dispatchCommand('first')).ok).toBe(true);
    const admissionId = 'cln_0123456789abcdefghjkmnpqrs';
    const unitName = `osi-image-builder-cleanup@${admissionId}.service`;
    const snapshot = nullCleanupSnapshot('first');
    expect(target.ownership.apiWrite({ kind: 'cleanup-credential-reserve', jobId: 'first', admissionId, owner: 'cleanup-worker', credentialRelativePath: `recovery/cleanup-credentials/${admissionId}.token`, createdAt: OBSERVED, expiresAt: LATER, at: OBSERVED }).ok).toBe(true);
    expect(target.ownership.apiWrite({ kind: 'cleanup-admission', jobId: 'first', admissionId, owner: 'cleanup-worker', unitName, expiresAt: LATER, credentialRelativePath: `recovery/cleanup-credentials/${admissionId}.token`, credentialSha256: SHA64, fenceTokenHash: SHA64, reservationCreatedAt: OBSERVED, reservationExpiresAt: LATER, snapshot, at: OBSERVED }).ok).toBe(true);
    expect(target.ownership.cleanupWrite({ kind: 'claim-lease', jobId: 'first', admissionId, owner: 'cleanup-worker', unitName, fenceGeneration: 1, fenceTokenHash: SHA64, snapshot, at: OBSERVED }).ok).toBe(true);
    expect(target.ownership.cleanupWrite({ kind: 'complete', jobId: 'first', admissionId, owner: 'cleanup-worker', unitName, fenceGeneration: 1, fenceTokenHash: SHA64, snapshot, postcondition: nullCleanupPostcondition('first'), exactContainerId: null, containerAbsent: true, evidencePath: 'recovery/cleanup.json', evidenceSha256: SHA64, at: WRITTEN }).ok).toBe(true);
    expect(target.ownership.apiWrite({ kind: 'hand-back', jobId: 'first', admissionId, owner: 'cleanup-worker', unitName, fenceGeneration: 1, fenceTokenHash: SHA64, at: LATER, proof: { runner: { ...snapshot.runner, inactiveAt: LATER, observedAt: LATER }, container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: LATER }, blocker: 'none' } }).ok).toBe(true);
    expect(target.db.prepare('SELECT state, queue_state, cleanup_fence_generation FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'interrupted', queue_state: 'complete', cleanup_fence_generation: null });

    const state = systemdState();
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd: state.systemd, safety: { inspect: async () => null }, clock: { now: () => WRITTEN } });
    await expect(coordinator.dispatchNext()).resolves.toMatchObject({ kind: 'started', jobId: 'second' });
    expect(target.db.prepare('SELECT 1 AS present FROM queue_entries WHERE job_id=?').get('first')).toBeUndefined();
    expect(state.starts).toEqual(['osi-image-builder-runner@second.service']);
  });

  it('releases FIFO after cleanup hand-back quarantines staging', async () => {
    const target = await fixture(['first', 'second']);
    expect(target.ownership.apiWrite(dispatchCommand('first')).ok).toBe(true);
    const admissionId = 'cln_0123456789abcdefghjkmnpqrs';
    const unitName = `osi-image-builder-cleanup@${admissionId}.service`;
    const snapshot = physicalCleanupSnapshot('first');
    expect(target.ownership.apiWrite({ kind: 'cleanup-credential-reserve', jobId: 'first', admissionId, owner: 'cleanup-worker', credentialRelativePath: `recovery/cleanup-credentials/${admissionId}.token`, createdAt: OBSERVED, expiresAt: LATER, at: OBSERVED }).ok).toBe(true);
    expect(target.ownership.apiWrite({ kind: 'cleanup-admission', jobId: 'first', admissionId, owner: 'cleanup-worker', unitName, expiresAt: LATER, credentialRelativePath: `recovery/cleanup-credentials/${admissionId}.token`, credentialSha256: SHA64, fenceTokenHash: SHA64, reservationCreatedAt: OBSERVED, reservationExpiresAt: LATER, snapshot, at: OBSERVED }).ok).toBe(true);
    expect(target.ownership.cleanupWrite({ kind: 'claim-lease', jobId: 'first', admissionId, owner: 'cleanup-worker', unitName, fenceGeneration: 1, fenceTokenHash: SHA64, snapshot, at: OBSERVED }).ok).toBe(true);
    expect(target.ownership.cleanupWrite({ kind: 'complete', jobId: 'first', admissionId, owner: 'cleanup-worker', unitName, fenceGeneration: 1, fenceTokenHash: SHA64, snapshot, postcondition: physicalCleanupPostcondition('first'), exactContainerId: null, containerAbsent: true, evidencePath: 'recovery/cleanup.json', evidenceSha256: SHA64, at: WRITTEN }).ok).toBe(true);
    expect(target.ownership.apiWrite({ kind: 'hand-back', jobId: 'first', admissionId, owner: 'cleanup-worker', unitName, fenceGeneration: 1, fenceTokenHash: SHA64, at: LATER, proof: { runner: { ...snapshot.runner, inactiveAt: LATER, observedAt: LATER }, container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: LATER }, blocker: 'none' } }).ok).toBe(true);
    expect(target.db.prepare('SELECT state, queue_state, artifact_staging_path, artifact_quarantine_path, publish_state FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'interrupted', queue_state: 'complete', artifact_staging_path: null, artifact_quarantine_path: 'quarantine/first', publish_state: 'quarantined' });

    const state = systemdState();
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd: state.systemd, safety: { inspect: async () => null }, clock: { now: () => WRITTEN } });
    await expect(coordinator.dispatchNext()).resolves.toMatchObject({ kind: 'started', jobId: 'second' });
    expect(state.starts).toEqual(['osi-image-builder-runner@second.service']);
  });
});
