import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCleanupAdmissionRecovery, reconcileCleanupAdmissionAtStartup, type RecoverySystemd } from '../../api/src/recovery.js';
import { OwnershipStore, type CleanupSnapshot } from '../../api/src/ownership.js';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { createStartupBootstrap, type StartupPhaseResult } from '../../api/src/startup-order.js';
import type { QueueSystemd } from '../../api/src/queue.js';
import type { CreateJobInput } from '../../api/src/store.js';

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

function seedStarting(ownership: OwnershipStore, jobId: string): void {
  committed(ownership.apiWrite({ kind: 'enqueue', input: input(jobId) }));
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
});
