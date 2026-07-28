import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCleanupAdmissionRecovery, reconcileCleanupAdmissionAtStartup, type RecoverySystemd } from '../../api/src/recovery.js';
import { OwnershipStore, type CleanupSnapshot, type DirectInterruptionProof, type PublishRecoveryEvidence, type RunnerWriteCommand } from '../../api/src/ownership.js';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { createStartupBootstrap, type StartupPhaseResult } from '../../api/src/startup-order.js';
import type { QueueSystemd } from '../../api/src/queue.js';
import { encodeJson } from '../../api/src/validation.js';
import type { CreateJobInput, JsonObject } from '../../api/src/store.js';

const NOW = '2026-07-28T12:00:00.000Z';
const EXPIRED = '2026-07-28T11:59:00.000Z';
const REPLACEMENT_EXPIRES = '2026-07-28T12:10:00.000Z';
const CLAIM_EXPIRES = '2026-07-28T12:00:30.000Z';
const SHA40 = 'a'.repeat(40);
const SHA64 = 'b'.repeat(64);
const roots: string[] = [];
const databases: Array<ReturnType<typeof openBuilderDatabase>> = [];

function input(jobId: string): CreateJobInput {
  const preparation = {
    schemaVersion: 1 as const, sourceSha: SHA40, gitmodulesBlobSha: SHA40, preparedAt: NOW,
    components: [
      { path: 'feeds/chirpstack-openwrt-feed' as const, mode: '040000' as const, type: 'tree' as const, objectId: SHA40, provenanceUrl: 'https://github.com/chirpstack/chirpstack-openwrt-feed.git' },
      { path: 'openwrt' as const, mode: '040000' as const, type: 'tree' as const, objectId: SHA40, provenanceUrl: 'https://github.com/openwrt/openwrt.git' },
    ],
  };
  const feeds = {
    schemaVersion: 1 as const, boundary: 'api-prepared-pinned-feeds-v1' as const, networkPolicy: 'runner-offline' as const,
    jobId, sourceSha: SHA40, preparedAt: NOW,
    feeds: [
      ['packages', 'https://git.openwrt.org/feed/packages.git'],
      ['luci', 'https://git.openwrt.org/project/luci.git'],
      ['routing', 'https://git.openwrt.org/feed/routing.git'],
    ].map(([name, location]) => ({
      name, location, commit: SHA40, detached: true as const, clean: true as const,
      recursiveSubmodulesPrepared: true as const, recursiveSubmodules: [],
      recursiveSubmoduleStatusSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', treeSha256: SHA64,
    })),
  };
  return {
    jobId, requestId: `request-${jobId}`, request: { branch: 'main', target: 'rpi-5' },
    sourceRemote: 'git@example.com:osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main',
    expectedSha: SHA40, pinnedSha: SHA40, sourcePreparation: preparation, offlineFeedPreparation: feeds,
    targetId: 'rpi-5', rootId: 'release', targetManifestSha256: SHA64, sourceCommitTime: NOW, sourceAuthor: 'test', sourceSubject: 'test', acceptedAt: NOW,
  };
}

function committed(result: { readonly ok: boolean; readonly conflict?: { readonly message: string } }): void {
  if (!result.ok) throw new Error(result.conflict?.message ?? 'ownership write failed');
}

function seedStarting(ownership: OwnershipStore, jobId: string, alreadyEnqueued = false): void {
  if (!alreadyEnqueued) committed(ownership.apiWrite({ kind: 'enqueue', input: input(jobId) }));
  committed(ownership.apiWrite({ kind: 'dispatch', jobId, runnerUnit: `osi-image-builder-runner@${jobId}.service`, claimOwner: `dispatcher-${jobId}`, claimExpiresAt: CLAIM_EXPIRES, at: NOW }));
  committed(ownership.apiWrite({ kind: 'dispatch-start', jobId, runnerUnit: `osi-image-builder-runner@${jobId}.service`, claimOwner: `dispatcher-${jobId}`, expectedClaimExpiresAt: CLAIM_EXPIRES, claimExpiresAt: CLAIM_EXPIRES, unitInactiveAt: NOW, startAttemptedAt: NOW, at: NOW }));
}

function cleanupSnapshot(jobId: string): CleanupSnapshot {
  return {
    runner: { unit: `osi-image-builder-runner@${jobId}.service`, owner: null, leaseExpiresAt: null, inactiveAt: NOW, observedAt: NOW },
    state: 'starting', container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: NOW },
    staging: { kind: 'absent', path: null }, logs: { runner: 'absent', docker: 'absent', verifiedAt: NOW }, blocker: 'none',
  };
}

function systemdFixture(stopFails: boolean) {
  const active = new Set<string>();
  const starts: string[] = [];
  const stops: string[] = [];
  const recovery: RecoverySystemd = {
    start: vi.fn(async (unit: string) => { starts.push(unit); active.add(unit); }),
    isActive: vi.fn(async (unit: string) => active.has(unit)),
    stop: vi.fn(async (unit: string) => {
      stops.push(unit);
      if (stopFails) throw new Error('simulated cleanup stop failure');
      active.delete(unit);
    }),
  };
  const queue: QueueSystemd = {
    inspect: vi.fn(async (unit: string) => ({ unit, active: active.has(unit), pending: false, observedAt: NOW })),
    listActive: vi.fn(async () => [...active]),
    start: vi.fn(async (unit: string) => { starts.push(unit); active.add(unit); return { unit, argv: ['systemctl', '--user', 'start', unit], exitCode: 0, timedOut: false }; }),
  };
  return { active, starts, stops, recovery, queue };
}

async function fixture(stopFails = false) {
  const root = await mkdtemp(join(tmpdir(), 'osi-startup-recovery-')); roots.push(root);
  const db = openBuilderDatabase(join(root, 'jobs.sqlite')); databases.push(db);
  const ownership = new OwnershipStore(db, { now: () => NOW });
  const systemd = systemdFixture(stopFails);
  return { root, db, ownership, systemd };
}

async function seedClaimedCleanup(value: Awaited<ReturnType<typeof fixture>>, jobId: string) {
  seedStarting(value.ownership, jobId);
  const snapshot = cleanupSnapshot(jobId);
  const recovery = createCleanupAdmissionRecovery({
    stateRoot: value.root, db: value.db, ownership: value.ownership, systemd: value.systemd.recovery,
    clock: { now: () => NOW }, crypto: { randomBytes: (size) => Buffer.alloc(size, 7) }, ownerUid: process.getuid?.() ?? 0,
  });
  await recovery.openAdmissions();
  const admission = await recovery.admitAndStart({ jobId, owner: 'cleanup-worker', expiresAt: REPLACEMENT_EXPIRES, at: NOW, snapshot });
  const lease = value.db.prepare('SELECT fence_generation, fence_token_hash FROM cleanup_leases WHERE admission_id=?').get(admission.admissionId) as { fence_generation: number; fence_token_hash: string };
  committed(value.ownership.cleanupWrite({ kind: 'claim-lease', jobId, admissionId: admission.admissionId, owner: 'cleanup-worker', unitName: admission.unitName, fenceGeneration: lease.fence_generation, fenceTokenHash: lease.fence_token_hash, snapshot, at: NOW }));
  value.db.prepare('UPDATE cleanup_leases SET expires_at=? WHERE admission_id=?').run(EXPIRED, admission.admissionId);
  return { recovery, admission, snapshot };
}

function clear(): StartupPhaseResult { return { blockers: [] }; }

const PUBLISH_FINISHED = '2026-07-28T12:00:30.000Z';
const PUBLISH_RECOVERY = '2026-07-28T12:01:00.000Z';
const DIRECT_CLAIM_EXPIRES = '2026-07-28T12:02:00.000Z';

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function publishManifest(jobId: string): JsonObject {
  return { artifactSha256: SHA64, branch: 'main', jobId, pinnedSha: SHA40, targetId: 'rpi-5' };
}

function publishRecoveryEvidence(jobId: string): PublishRecoveryEvidence {
  const manifest = publishManifest(jobId);
  const manifestSha256 = hash(canonical(manifest));
  const stageContent: JsonObject = {
    schemaVersion: 1, jobId, stage: 'publish', startedAt: NOW, finishedAt: PUBLISH_RECOVERY, outcome: 'failed', operationId: null,
    commands: [], inputs: { targetId: 'rpi-5', rootId: 'release', branch: 'main', pinnedSha: SHA40 },
    observations: { final: { verificationSha256: manifestSha256 } }, error: null,
  };
  const stageBytes = `${encodeJson(stageContent, 'startup publish stage evidence', true)}\n`;
  const stageSha256 = hash(stageBytes);
  const checksumContents = `${SHA64}  image\n`;
  const checksumSha256 = hash(checksumContents);
  return {
    runner: { unit: `osi-image-builder-runner@${jobId}.service`, owner: 'runner-a', leaseExpiresAt: CLAIM_EXPIRES, inactiveAt: PUBLISH_FINISHED, observedAt: PUBLISH_RECOVERY },
    container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: PUBLISH_RECOVERY },
    stage: { startedAt: NOW, finishedAt: PUBLISH_RECOVERY, evidencePath: `jobs/${jobId}/evidence/09-publish.json`, evidenceSha256: stageSha256 },
    artifact: {
      stagingPath: 'staging/image', artifactSha256: SHA64, artifactSize: 10, artifactMtime: NOW,
      checksumPath: 'staging/sums', checksumSha256, manifestPath: 'staging/manifest', manifestSha256,
      verificationPath: 'staging/verify', verificationSha256: manifestSha256,
    },
    final: { directory: `release/${jobId}`, path: `release/${jobId}/image`, publishStartedAt: NOW, publishedAt: null },
    observed: {
      stageEvidence: { present: true, path: `jobs/${jobId}/evidence/09-publish.json`, bytes: stageBytes, sha256: stageSha256 },
      final: { present: false, path: `release/${jobId}/image`, held: false, size: null, sha256: null },
      checksum: { present: true, path: 'staging/sums', contents: checksumContents, sha256: checksumSha256 },
      manifest: { present: true, path: 'staging/manifest', bytes: canonical(manifest), content: manifest, sha256: manifestSha256 },
      verification: { present: true, path: 'staging/verify', bytes: canonical(manifest), content: manifest, sha256: manifestSha256 },
      staging: { state: 'present', path: 'staging/image', sha256: SHA64 },
      logs: { runner: 'sealed', docker: 'sealed', verifiedAt: PUBLISH_RECOVERY, noGap: true },
    },
  };
}

function runnerBase(jobId: string): Pick<Extract<RunnerWriteCommand, { kind: 'stage' }>, 'jobId' | 'owner' | 'runnerUnit' | 'leaseExpiresAt' | 'at'> {
  return { jobId, owner: 'runner-a', runnerUnit: `osi-image-builder-runner@${jobId}.service`, leaseExpiresAt: CLAIM_EXPIRES, at: NOW };
}

function seedPublishing(ownership: OwnershipStore, jobId: string, alreadyEnqueued = false): void {
  seedStarting(ownership, jobId, alreadyEnqueued);
  committed(ownership.runnerWrite({ kind: 'acquire-lease', jobId, runnerUnit: `osi-image-builder-runner@${jobId}.service`, owner: 'runner-a', expiresAt: CLAIM_EXPIRES, at: NOW }));
  const stages = [
    ['preflight', 'starting', 'preflight'], ['source', 'preflight', 'source'], ['release-gates', 'source', 'release_gates'],
    ['frontend', 'release_gates', 'frontend'], ['target-setup', 'frontend', 'target_setup'], ['feeds', 'target_setup', 'feeds'],
    ['config', 'feeds', 'config'], ['build', 'config', 'building'], ['verify', 'building', 'verifying'],
  ] as const;
  for (const [stage, expectedState, state] of stages) committed(ownership.runnerWrite({ ...runnerBase(jobId), kind: 'stage', expectedState, state, stage, outcome: 'passed', startedAt: NOW, finishedAt: NOW, evidencePath: `evidence/${stage}`, evidenceSha256: SHA64 }));
  const manifest = publishManifest(jobId);
  const manifestSha256 = hash(canonical(manifest));
  committed(ownership.runnerWrite({ ...runnerBase(jobId), kind: 'artifact', expectedState: 'verifying', state: 'verifying', stagingPath: 'staging/image', artifactSha256: SHA64, artifactSize: 10, artifactMtime: NOW, checksumPath: 'staging/sums', checksumSha256: hash(`${SHA64}  image\n`), manifestPath: 'staging/manifest', manifestSha256, verificationPath: 'staging/verify', verificationSha256: manifestSha256 }));
  committed(ownership.runnerWrite({ ...runnerBase(jobId), kind: 'publish-stage-start', expectedState: 'verifying', startedAt: NOW, finalDirectory: `release/${jobId}`, finalPath: `release/${jobId}/image`, publishStartedAt: NOW }));
}

function directProof(jobId: string): DirectInterruptionProof {
  return {
    kind: 'start-failure', runnerUnit: `osi-image-builder-runner@${jobId}.service`, startAttemptedAt: NOW, unitInactiveAt: PUBLISH_FINISHED,
    runnerLeaseOwner: null, runnerLeaseExpiresAt: null, container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: PUBLISH_FINISHED },
    staging: { kind: 'absent', path: null }, logs: { runner: 'absent', docker: 'absent', verifiedAt: PUBLISH_FINISHED, generationIdentity: { runner: [], docker: [] } },
    blocker: 'none', cleanupAdmission: null, cleanupFence: null,
  };
}

function sealPublishLogs(db: ReturnType<typeof openBuilderDatabase>, jobId: string): void {
  for (const stream of ['runner', 'docker'] as const) {
    db.prepare('INSERT INTO job_log_generations (job_id, stream, generation, path, started_at, size_bytes) VALUES (?, ?, 0, ?, ?, 0)').run(jobId, stream, `logs/${stream}-0.log`, NOW);
  }
  db.prepare('UPDATE job_log_generations SET sealed_at=?, sha256=? WHERE job_id=?').run(PUBLISH_FINISHED, SHA64, jobId);
}

function seedDirectStartingRow(db: ReturnType<typeof openBuilderDatabase>, jobId: string): void {
  const job = input(jobId);
  db.prepare(`INSERT INTO jobs (
    job_id, request_id, request_json, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha,
    source_preparation_json, offline_feed_preparation_json, target_id, root_id, target_manifest_sha256,
    source_commit_time, source_author, source_subject, accepted_at, state, queue_state, queue_position,
    created_at, updated_at, dispatched_at, runner_unit
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', 'dispatched', NULL, ?, ?, ?, ?)`).run(
    job.jobId, job.requestId, JSON.stringify(job.request), job.sourceRemote, job.sourceRef, job.sourceBranch, job.branch,
    job.expectedSha, job.pinnedSha, JSON.stringify(job.sourcePreparation), JSON.stringify(job.offlineFeedPreparation), job.targetId,
    job.rootId, job.targetManifestSha256, job.sourceCommitTime, job.sourceAuthor, job.sourceSubject, job.acceptedAt, NOW, NOW, NOW,
    `osi-image-builder-runner@${jobId}.service`,
  );
  db.prepare("INSERT INTO job_events (job_id, seq, event_type, state, stage, payload_json, at) VALUES (?, 0, 'state', 'starting', NULL, '{}', ?)").run(jobId, NOW);
  db.prepare("INSERT INTO queue_dispatch_claims (claim_id, job_id, owner, claimed_at, lease_expires_at, phase, start_attempted_at, unit_inactive_at) VALUES (1, ?, ?, ?, ?, 'start-attempted', ?, ?)").run(jobId, `dispatcher-${jobId}`, NOW, DIRECT_CLAIM_EXPIRES, NOW, PUBLISH_FINISHED);
}

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('startup recovery with real SQLite stores', () => {
  it('stops an active expired cleanup worker, rotates its lease, and starts exactly one replacement', async () => {
    const value = await fixture();
    const cleanup = await seedClaimedCleanup(value, 'expired-cleanup');
    const trace: string[] = [];
    const bootstrap = createStartupBootstrap({
      queue: { db: value.db, ownership: value.ownership, systemd: value.systemd.queue, safety: { inspect: async () => null }, clock: { now: () => NOW } },
      services: {
        migrations: async () => { value.db.prepare('SELECT 1').get(); return clear(); },
        cleanupAdmissions: async () => {
          const row = value.db.prepare('SELECT admission_id, status, unit_name, expires_at FROM cleanup_leases WHERE job_id=? ORDER BY fence_generation DESC LIMIT 1').get('expired-cleanup') as { admission_id: string; status: string; unit_name: string; expires_at: string };
          await reconcileCleanupAdmissionAtStartup({ jobId: 'expired-cleanup', admissionId: row.admission_id, owner: 'startup-recovery', status: row.status as 'claimed', active: true, predecessorExpiresAt: row.expires_at, replacementExpiresAt: REPLACEMENT_EXPIRES, unitName: row.unit_name, observedUnitName: row.unit_name, snapshot: cleanup.snapshot, now: NOW, at: NOW }, cleanup.recovery);
          trace.push('cleanup-rotation-committed');
          return clear();
        },
        liveRunnerClassification: async () => { value.db.prepare('SELECT COUNT(*) FROM jobs').get(); return clear(); },
        stalePublishingRecovery: async () => clear(),
        nonPublishingInterruption: async () => clear(),
        retention: async () => clear(),
      },
    });

    await bootstrap.start();
    expect(trace).toEqual(['cleanup-rotation-committed']);
    expect(value.systemd.recovery.stop).toHaveBeenCalledTimes(1);
    expect(value.systemd.starts.filter((unit) => unit.startsWith('osi-image-builder-cleanup@'))).toHaveLength(2);
    const leases = value.db.prepare('SELECT status FROM cleanup_leases WHERE job_id=? ORDER BY fence_generation').all('expired-cleanup') as Array<{ status: string }>;
    expect(leases).toHaveLength(2);
    expect(leases.at(-1)?.status).toBe('admitted');
  });

  it('persists the stop blocker and keeps bootstrap dispatch closed when stop confirmation fails', async () => {
    const value = await fixture(true);
    const cleanup = await seedClaimedCleanup(value, 'stop-failure');
    const bootstrap = createStartupBootstrap({
      queue: { db: value.db, ownership: value.ownership, systemd: value.systemd.queue, safety: { inspect: async () => null }, clock: { now: () => NOW } },
      services: {
        migrations: async () => { value.db.prepare('SELECT 1').get(); return clear(); },
        cleanupAdmissions: async () => {
          const row = value.db.prepare('SELECT admission_id, status, unit_name, expires_at FROM cleanup_leases WHERE job_id=? ORDER BY fence_generation DESC LIMIT 1').get('stop-failure') as { admission_id: string; status: string; unit_name: string; expires_at: string };
          try {
            await reconcileCleanupAdmissionAtStartup({ jobId: 'stop-failure', admissionId: row.admission_id, owner: 'startup-recovery', status: row.status as 'claimed', active: true, predecessorExpiresAt: row.expires_at, replacementExpiresAt: REPLACEMENT_EXPIRES, unitName: row.unit_name, observedUnitName: row.unit_name, snapshot: cleanup.snapshot, now: NOW, at: NOW }, cleanup.recovery);
            return clear();
          } catch {
            const blocker = value.db.prepare('SELECT cleanup_blocker_code, cleanup_blocker_json FROM jobs WHERE job_id=?').get('stop-failure') as { cleanup_blocker_code: string | null; cleanup_blocker_json: string | null };
            return { blockers: [{ code: blocker.cleanup_blocker_code ?? 'CLEANUP_UNIT_STOP_FAILED', details: blocker.cleanup_blocker_json ? JSON.parse(blocker.cleanup_blocker_json) : {} }] };
          }
        },
        liveRunnerClassification: async () => clear(), stalePublishingRecovery: async () => clear(), nonPublishingInterruption: async () => clear(), retention: async () => clear(),
      },
    });

    const result = await bootstrap.start();
    expect(result.dispatched).toBe(false);
    expect(result.blockers[0]?.code).toBe('CLEANUP_UNIT_STOP_FAILED');
    expect(value.systemd.recovery.stop).toHaveBeenCalledTimes(1);
    expect(value.systemd.starts.filter((unit) => unit.startsWith('osi-image-builder-cleanup@'))).toHaveLength(1);
    expect(value.db.prepare('SELECT cleanup_blocker_code, cleanup_fence_generation FROM jobs WHERE job_id=?').get('stop-failure')).toMatchObject({ cleanup_blocker_code: 'CLEANUP_UNIT_STOP_FAILED' });
  });

  it('commits stale publishing recovery before direct interruption and opens the queue only afterward', async () => {
    const value = await fixture();
    seedPublishing(value.ownership, 'publishing-recovery');
    sealPublishLogs(value.db, 'publishing-recovery');
    const trace: string[] = [];
    const bootstrap = createStartupBootstrap({
      queue: { db: value.db, ownership: value.ownership, systemd: value.systemd.queue, safety: { inspect: async () => null }, clock: { now: () => NOW } },
      services: {
        migrations: async () => { value.db.prepare('SELECT 1').get(); return clear(); },
        cleanupAdmissions: async () => { value.db.prepare('SELECT COUNT(*) FROM cleanup_leases').get(); return clear(); },
        liveRunnerClassification: async () => { value.db.prepare("SELECT COUNT(*) FROM jobs WHERE state='publishing'").get(); return clear(); },
        stalePublishingRecovery: async () => {
          const row = value.db.prepare("SELECT state FROM jobs WHERE job_id=? AND state='publishing'").get('publishing-recovery');
          if (row === undefined) throw new Error('publishing recovery row was not found');
          committed(value.ownership.apiWrite({ kind: 'publish-recovery', jobId: 'publishing-recovery', expectedState: 'publishing', at: PUBLISH_RECOVERY, state: 'failed', evidence: publishRecoveryEvidence('publishing-recovery'), errorCode: 'PUBLISH_FAILED', error: { reason: 'startup recovery proof' } }));
          trace.push('publishing-recovery-committed');
          return clear();
        },
        nonPublishingInterruption: async () => {
          seedDirectStartingRow(value.db, 'direct-interruption');
          const row = value.db.prepare("SELECT state FROM jobs WHERE job_id=? AND state='starting'").get('direct-interruption');
          if (row === undefined) throw new Error('direct interruption row was not found');
          committed(value.ownership.apiWrite({ kind: 'direct-interrupt', jobId: 'direct-interruption', expectedState: 'starting', at: PUBLISH_FINISHED, proof: directProof('direct-interruption'), errorCode: 'SERVICE_START_FAILED', error: { reason: 'startup direct interruption proof' }, dispatchClaimOwner: 'dispatcher-direct-interruption', expectedClaimExpiresAt: DIRECT_CLAIM_EXPIRES, expectedStartAttemptedAt: NOW, expectedUnitInactiveAt: PUBLISH_FINISHED }));
          trace.push('direct-interruption-committed');
          return clear();
        },
        retention: async () => { value.db.prepare('SELECT COUNT(*) FROM job_events').get(); return clear(); },
      },
    });

    const result = await bootstrap.start();
    expect(trace).toEqual(['publishing-recovery-committed', 'direct-interruption-committed']);
    expect(result.dispatched).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(value.db.prepare('SELECT state FROM jobs WHERE job_id=?').get('publishing-recovery')).toEqual({ state: 'failed' });
    expect(value.db.prepare('SELECT state, queue_state FROM jobs WHERE job_id=?').get('direct-interruption')).toEqual({ state: 'interrupted', queue_state: 'complete' });
    expect(bootstrap.events().map((event) => event.phase)).toEqual(['migrations', 'cleanup-admissions', 'live-runner-classification', 'stale-publishing-recovery', 'non-publishing-interruption', 'retention', 'dispatch']);
    expect(value.systemd.queue.start).not.toHaveBeenCalled();
  });
});
