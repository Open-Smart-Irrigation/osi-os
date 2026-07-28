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
import { createQueueCoordinator, type QueueSystemd } from '../../api/src/queue.js';

const ACCEPTED = '2026-07-28T10:00:00.000Z';
const DISPATCHED = '2026-07-28T10:00:01.000Z';
const OBSERVED = '2026-07-28T10:00:02.000Z';
const WRITTEN = '2026-07-28T10:00:03.000Z';
const LATER = '2026-07-28T10:00:04.000Z';
const SHA40 = 'a'.repeat(40);
const SHA64 = 'b'.repeat(64);
const directories: string[] = [];
const databases: Array<ReturnType<typeof openBuilderDatabase>> = [];

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
    sourceCommitTime: ACCEPTED,
    sourceAuthor: 'queue integration',
    sourceSubject: 'queue integration',
    acceptedAt: ACCEPTED,
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
  const starts: string[] = [];
  const systemd: QueueSystemd = {
    inspect: async (unit) => ({ unit, active: active.has(unit), observedAt: WRITTEN }),
    listActive: async () => [...active],
    start: async (unit) => {
      starts.push(unit);
      if (startResult === 'success') active.add(unit);
      return { unit, argv: ['systemctl', '--user', 'start', unit], exitCode: startResult === 'success' ? 0 : 1, timedOut: false };
    },
  };
  return { systemd, starts, active };
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
    db.exec('DROP TRIGGER jobs_publish_guard');
    db.prepare("UPDATE jobs SET publish_state='publishing' WHERE job_id=?").run('first');
  }
}

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('queue service-start recovery with real SQLite stores', () => {
  it('defers an inactive starting row with an unexpired runner lease without mutation', async () => {
    const target = await fixture(['first', 'second']);
    expect(target.ownership.apiWrite({ kind: 'dispatch', jobId: 'first', runnerUnit: 'osi-image-builder-runner@first.service', at: DISPATCHED }).ok).toBe(true);
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
    expect(target.ownership.apiWrite({ kind: 'dispatch', jobId: 'first', runnerUnit: 'osi-image-builder-runner@first.service', at: DISPATCHED }).ok).toBe(true);
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
    expect(target.ownership.apiWrite({ kind: 'dispatch', jobId: 'first', runnerUnit: 'osi-image-builder-runner@first.service', at: DISPATCHED }).ok).toBe(true);
    expect(target.ownership.runnerWrite({ kind: 'acquire-lease', jobId: 'first', runnerUnit: 'osi-image-builder-runner@first.service', owner: 'runner-a', expiresAt: OBSERVED, at: DISPATCHED }).ok).toBe(true);
    const before = target.db.prepare('SELECT state, queue_state, runner_lease_owner, runner_lease_expires_at, cleanup_blocker_code, terminal_error_code FROM jobs WHERE job_id=?').get('first');
    const state = systemdState();
    const directInterrupt = vi.fn(async () => null);
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd: state.systemd, safety: { inspect: async () => null }, directInterrupt, clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toEqual({ kind: 'blocked', reason: 'RUNNER_DISAPPEARED', jobId: 'first' });
    expect(target.db.prepare('SELECT state, queue_state, runner_lease_owner, runner_lease_expires_at, cleanup_blocker_code, terminal_error_code FROM jobs WHERE job_id=?').get('first')).toEqual(before);
    expect(directInterrupt).not.toHaveBeenCalled();
    expect(state.starts).toHaveLength(0);
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

  it('recovers a persisted starting claim after a crash and only later dispatches the next row', async () => {
    const target = await fixture(['first', 'second']);
    expect(target.ownership.apiWrite({ kind: 'dispatch', jobId: 'first', runnerUnit: 'osi-image-builder-runner@first.service', at: DISPATCHED }).ok).toBe(true);
    const state = systemdState();
    let proofInput: { startAttemptedAt: string } | undefined;
    const directInterrupt = async (inputValue: { startAttemptedAt: string; jobId: string }) => {
      proofInput = inputValue;
      return directProof(inputValue.jobId, DISPATCHED, OBSERVED, OBSERVED);
    };
    const firstCoordinator = createQueueCoordinator({
      db: target.db,
      ownership: new OwnershipStore(target.db, { now: () => WRITTEN }),
      systemd: state.systemd,
      safety: { inspect: async () => null },
      directInterrupt,
      clock: { now: () => WRITTEN },
    });

    await expect(firstCoordinator.dispatchNext()).resolves.toMatchObject({ kind: 'interrupted', jobId: 'first' });
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
    const directInterrupt = vi.fn(async (inputValue: { jobId: string; startAttemptedAt: string }) => {
      proofReturned = true;
      return directProof(inputValue.jobId, inputValue.startAttemptedAt, WRITTEN, LATER);
    });
    const coordinator = createQueueCoordinator({
      db: target.db,
      ownership: target.ownership,
      systemd: state.systemd,
      safety: { inspect: async () => null },
      directInterrupt,
      clock: { now: () => proofReturned ? LATER : WRITTEN },
    });

    await expect(coordinator.dispatchNext()).resolves.toMatchObject({ kind: 'interrupted', jobId: 'first' });
    expect(directInterrupt).toHaveBeenCalledWith(expect.objectContaining({ startAttemptedAt: WRITTEN }));
    expect(target.db.prepare('SELECT state, terminal_error_code, terminal_at FROM jobs WHERE job_id=?').get('first')).toEqual({ state: 'interrupted', terminal_error_code: 'SERVICE_START_FAILED', terminal_at: LATER });
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

    await expect(coordinator.dispatchNext()).resolves.toMatchObject({ kind: 'interrupted', jobId: 'first' });
    expect(state.starts).toHaveLength(0);
  });

  it('does not start when the live systemd list becomes blocked after claim', async () => {
    const target = await fixture(['first']);
    const state = systemdState();
    let listCalls = 0;
    const systemd = { ...state.systemd, listActive: async () => listCalls++ === 0 ? [] : ['osi-image-builder-runner@other.service'] };
    const coordinator = createQueueCoordinator({ db: target.db, ownership: target.ownership, systemd, safety: { inspect: async () => null }, directInterrupt: async () => directProof('first', WRITTEN, WRITTEN, WRITTEN), clock: { now: () => WRITTEN } });

    await expect(coordinator.dispatchNext()).resolves.toMatchObject({ kind: 'interrupted', jobId: 'first' });
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

    await expect(coordinator.dispatchNext()).resolves.toMatchObject({ kind: 'interrupted', jobId: 'first' });
    expect(state.starts).toHaveLength(0);
  });

  it('releases FIFO only after a real cleanup hand-back CAS and leaves the first job interrupted', async () => {
    const target = await fixture(['first', 'second']);
    expect(target.ownership.apiWrite({ kind: 'dispatch', jobId: 'first', runnerUnit: 'osi-image-builder-runner@first.service', at: DISPATCHED }).ok).toBe(true);
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
    expect(target.ownership.apiWrite({ kind: 'dispatch', jobId: 'first', runnerUnit: 'osi-image-builder-runner@first.service', at: DISPATCHED }).ok).toBe(true);
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
