import { rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCleanupAdmissionRecovery,
  type RecoveryDocker,
  type RecoveryHandBackDependencies,
  type RecoverySystemd,
} from '../../api/src/recovery.js';
import {
  OwnershipStore,
  type CleanupPostcondition,
  type CleanupSnapshot,
} from '../../api/src/ownership.js';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { createRecoveryFileSystem } from '../../api/src/recovery.js';
import { createCleanupWorker, type CleanupDockerContainer } from '../../cleanup-worker/src/main.js';

const NOW = '2026-07-28T12:00:00.000Z';
const AFTER = '2026-07-28T12:10:00.000Z';
const EXPIRES = '2026-07-28T12:05:00.000Z';
const NEXT_EXPIRES = '2026-07-28T12:20:00.000Z';
const RUNNER_EXPIRES = '2026-07-28T11:55:00.000Z';
const MANIFEST_SHA = 'a'.repeat(64);
const IMAGE_DIGEST = 'b'.repeat(64);
const EVIDENCE_SHA = 'c'.repeat(64);
const UID = process.getuid?.() ?? 0;
const LABEL_JOB = 'org.osi.image-builder.job-id';
const LABEL_MANIFEST = 'org.osi.image-builder.manifest-sha';
const roots: string[] = [];
const databases: Array<ReturnType<typeof openBuilderDatabase>> = [];

function labels(jobId: string) { return { [LABEL_JOB]: jobId, [LABEL_MANIFEST]: MANIFEST_SHA }; }

function sourcePreparation() {
  return {
    schemaVersion: 1,
    sourceSha: 'd'.repeat(40),
    gitmodulesBlobSha: 'e'.repeat(40),
    preparedAt: NOW,
    components: [
      { path: 'feeds/chirpstack-openwrt-feed', mode: '040000', type: 'tree', objectId: 'f'.repeat(40), provenanceUrl: 'https://github.com/chirpstack/chirpstack-openwrt-feed.git' },
      { path: 'openwrt', mode: '040000', type: 'tree', objectId: '1'.repeat(40), provenanceUrl: 'https://github.com/openwrt/openwrt.git' },
    ],
  };
}

function offlineFeedPreparation(jobId: string) {
  const recursiveSubmoduleStatusSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  return {
    schemaVersion: 1,
    boundary: 'api-prepared-pinned-feeds-v1',
    networkPolicy: 'runner-offline',
    jobId,
    sourceSha: 'd'.repeat(40),
    preparedAt: NOW,
    feeds: [
      { name: 'packages', location: 'https://git.openwrt.org/feed/packages.git', commit: '1'.repeat(40), detached: true, clean: true, recursiveSubmodulesPrepared: true, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: '1'.repeat(64) },
      { name: 'luci', location: 'https://git.openwrt.org/project/luci.git', commit: '2'.repeat(40), detached: true, clean: true, recursiveSubmodulesPrepared: true, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: '2'.repeat(64) },
      { name: 'routing', location: 'https://git.openwrt.org/feed/routing.git', commit: '3'.repeat(40), detached: true, clean: true, recursiveSubmodulesPrepared: true, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: '3'.repeat(64) },
    ],
  };
}

function seedJob(db: ReturnType<typeof openBuilderDatabase>, jobId: string, state: 'building' | 'interrupted'): CleanupSnapshot {
  db.prepare(`INSERT INTO jobs (
    job_id, request_id, request_json, source_remote, source_ref, source_branch, branch,
    expected_sha, pinned_sha, source_preparation_json, offline_feed_preparation_json, target_id, root_id, target_manifest_sha256,
    source_commit_time, source_author, source_subject, accepted_at, state, queue_state,
    queue_position, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'building', 'dispatched', NULL, ?, ?)`).run(
    jobId, `request-${jobId}`, JSON.stringify({ branch: 'main' }), 'git@example.com:osi-os.git',
    'refs/remotes/origin/main', 'main', 'main', 'd'.repeat(40), 'd'.repeat(40), JSON.stringify(sourcePreparation()), JSON.stringify(offlineFeedPreparation(jobId)), 'rpi-5',
    'release', MANIFEST_SHA, NOW, 'test', 'integration', NOW, NOW, NOW,
  );
  if (state === 'interrupted') db.prepare("UPDATE jobs SET state='interrupted', queue_state='complete', terminal_at=?, terminal_error_code='RUNNER_DISAPPEARED', terminal_error_json=? WHERE job_id=?").run(NOW, JSON.stringify({ reason: 'test' }), jobId);
  db.prepare('UPDATE jobs SET dispatched_at=?, runner_unit=?, runner_lease_owner=?, runner_lease_expires_at=?, runner_started_at=? WHERE job_id=?').run(
    NOW, `osi-image-builder-runner@${jobId}.service`, 'runner-owner', RUNNER_EXPIRES, NOW, jobId,
  );
  const id = `container-${jobId}`;
  const name = `osi-${jobId}`;
  db.prepare(`UPDATE jobs SET
    container_id=?, container_name=?, container_image_digest=?, container_label_job_id=?,
    container_label_manifest_sha=?, container_labels_json=?, container_mount_json=?,
    container_env_json=?, container_security_json=?, container_inspection_json=?,
    container_created_at=?, container_started_at=? WHERE job_id=?`).run(
    id, name, IMAGE_DIGEST, jobId, MANIFEST_SHA, JSON.stringify(labels(jobId)), JSON.stringify({ source: '/tmp/worktree', destination: '/work' }),
    JSON.stringify({ CI: '1' }), JSON.stringify({ noNewPrivileges: true }), JSON.stringify({ running: false }), NOW, NOW, jobId,
  );
  return {
    runner: { unit: `osi-image-builder-runner@${jobId}.service`, owner: 'runner-owner', leaseExpiresAt: RUNNER_EXPIRES, inactiveAt: NOW, observedAt: NOW },
    state,
    container: { kind: 'present', id, name, imageDigest: IMAGE_DIGEST, labels: labels(jobId), globalLabelResult: 'single-exact-match', observedAt: NOW },
    staging: { kind: 'absent', path: null },
    logs: { runner: 'absent', docker: 'absent', verifiedAt: NOW },
    blocker: 'container',
  };
}

function absentStaging(jobId: string) {
  return { kind: 'absent' as const, path: null, sourcePath: `staging/${jobId}`, sourceAbsent: true as const, verifiedAt: NOW };
}

function removedPostcondition(jobId: string, snapshot: CleanupSnapshot): CleanupPostcondition {
  if (snapshot.container.kind !== 'present') throw new Error('test fixture requires a persisted container');
  return {
    runner: snapshot.runner,
    state: snapshot.state,
    container: {
      kind: 'already-absent',
      id: snapshot.container.id,
      name: snapshot.container.name,
      imageDigest: snapshot.container.imageDigest,
      labels: snapshot.container.labels,
      exactIdAbsent: true,
      dockerAction: 'none',
      globalLabelResult: 'no-match',
      observedAt: NOW,
    },
    staging: absentStaging(jobId),
    logs: { runner: 'absent', docker: 'absent', verifiedAt: NOW },
    blocker: 'none',
  };
}

function systemdState(observedAt = NOW) {
  const active = new Map<string, boolean>();
  const starts: string[] = [];
  const systemd: RecoverySystemd = {
    start: vi.fn(async (unit: string) => { starts.push(unit); }),
    isActive: vi.fn(async (unit: string) => active.get(unit) ?? false),
    inspect: vi.fn(async (unit: string) => ({ unit, active: active.get(unit) ?? false, observedAt })),
  };
  return { active, starts, systemd };
}

function handBackDependencies(postcondition: CleanupPostcondition, observedAt = NOW): RecoveryHandBackDependencies {
  const docker: RecoveryDocker = {
    inspect: vi.fn(async () => ({ container: null, observedAt })),
    listByLabels: vi.fn(async () => ({ containers: [], observedAt })),
  };
  return {
    docker,
    evidence: { read: vi.fn(async () => ({ jobId: '', admissionId: '', sha256: EVIDENCE_SHA, postcondition })) },
    staging: { verify: vi.fn(async () => true as const) },
    logs: { verify: vi.fn(async () => true as const) },
  };
}

async function runReplacementWorker(
  value: Awaited<ReturnType<typeof createFixture>>,
  at = AFTER,
): Promise<CleanupPostcondition> {
  let containerPresent = value.snapshot.container.kind === 'present';
  let postcondition: CleanupPostcondition | undefined;
  const identity = value.snapshot.container;
  const container = (running: boolean): CleanupDockerContainer => {
    if (identity.kind !== 'present') throw new Error('test fixture lost its exact container identity');
    return { id: identity.id, name: identity.name, imageDigest: identity.imageDigest, labels: identity.labels, running, stoppedAt: running ? null : at };
  };
  const worker = createCleanupWorker({
    db: value.db,
    stateRoot: value.root,
    ownerUid: UID,
    workerOwner: 'cleanup-worker',
    ownership: value.ownership,
    fileSystem: createRecoveryFileSystem(),
    clock: { now: () => at },
    timeouts: { dockerMs: 1_000, systemdMs: 1_000 },
    systemd: { inspect: vi.fn(async (unit: string) => ({ unit, active: false, observedAt: at })) },
    docker: {
      inspect: vi.fn(async () => containerPresent ? container(true) : null),
      stop: vi.fn(async () => undefined),
      waitForStopped: vi.fn(async () => container(false)),
      remove: vi.fn(async () => { containerPresent = false; }),
      hasByJobId: vi.fn(async () => false),
      listByJobId: vi.fn(async () => []),
    },
    logSealer: { seal: vi.fn(async () => ({ runner: 'absent' as const, docker: 'absent' as const, verifiedAt: at, contiguous: true as const })) },
    quarantine: { quarantine: vi.fn(async () => ({ kind: 'absent' as const, path: null, sourcePath: `staging/${value.jobId}`, sourceAbsent: true as const, verifiedAt: at })) },
    evidenceWriter: {
      write: vi.fn(async (input: { readonly evidence: Record<string, unknown> }) => {
        postcondition = input.evidence.postcondition as CleanupPostcondition;
        return { path: `jobs/${value.jobId}/evidence/cleanup/${value.admission.admissionId}.complete.json`, sha256: EVIDENCE_SHA };
      }),
    },
  });
  await expect(worker.run([value.admission.admissionId])).resolves.toMatchObject({ status: 'completed', admissionId: value.admission.admissionId });
  if (postcondition === undefined) throw new Error('replacement worker did not write completion postcondition');
  return postcondition;
}

function boundHandBack(
  value: Pick<Awaited<ReturnType<typeof createFixture>>, 'jobId' | 'admission'>,
  postcondition: CleanupPostcondition,
): RecoveryHandBackDependencies {
  const dependencies = handBackDependencies(postcondition);
  (dependencies.evidence.read as ReturnType<typeof vi.fn>).mockResolvedValue({
    jobId: value.jobId,
    admissionId: value.admission.admissionId,
    sha256: EVIDENCE_SHA,
    postcondition,
  });
  return dependencies;
}

async function createFixture(state: 'building' | 'interrupted' = 'building') {
  const root = await mkdtemp(join(tmpdir(), 'osi-image-builder-recovery-')); roots.push(root);
  const db = openBuilderDatabase(join(root, 'state.sqlite')); databases.push(db);
  const jobId = `recovery-${state}`;
  const snapshot = seedJob(db, jobId, state);
  const ownership = new OwnershipStore(db, { now: () => NOW });
  const systemdValue = systemdState();
  const recovery = createCleanupAdmissionRecovery({
    stateRoot: root,
    db,
    ownership,
    systemd: systemdValue.systemd,
    clock: { now: () => NOW },
    crypto: { randomBytes: (size) => Buffer.alloc(size, 7) },
    ownerUid: UID,
  });
  await recovery.openAdmissions();
  const admission = await recovery.admitAndStart({ jobId, owner: 'cleanup-worker', expiresAt: EXPIRES, at: NOW, snapshot });
  return { root, db, jobId, snapshot, ownership, recovery, admission, systemd: systemdValue };
}

function completeAdmission(
  value: Awaited<ReturnType<typeof createFixture>>,
  postcondition = removedPostcondition(value.jobId, value.snapshot),
): CleanupPostcondition {
  const tokenHash = (value.db.prepare('SELECT fence_token_hash FROM cleanup_leases WHERE admission_id=?').get(value.admission.admissionId) as { fence_token_hash: string }).fence_token_hash;
  expect(value.ownership.cleanupWrite({
    kind: 'claim-lease',
    jobId: value.jobId,
    admissionId: value.admission.admissionId,
    owner: 'cleanup-worker',
    unitName: value.admission.unitName,
    fenceGeneration: value.admission.generation,
    fenceTokenHash: tokenHash,
    snapshot: value.snapshot,
    at: NOW,
  }).ok).toBe(true);
  expect(value.ownership.cleanupWrite({
    kind: 'complete',
    jobId: value.jobId,
    admissionId: value.admission.admissionId,
    owner: 'cleanup-worker',
    unitName: value.admission.unitName,
    fenceGeneration: value.admission.generation,
    fenceTokenHash: tokenHash,
    snapshot: value.snapshot,
    postcondition,
    exactContainerId: value.snapshot.container.kind === 'present' ? value.snapshot.container.id : null,
    containerAbsent: true,
    evidencePath: `jobs/${value.jobId}/evidence/cleanup/cleanup.json`,
    evidenceSha256: EVIDENCE_SHA,
    at: NOW,
  }).ok).toBe(true);
  return postcondition;
}

async function crashWorker(value: Awaited<ReturnType<typeof createFixture>>, phase: 'before-remove' | 'after-remove'): Promise<{ readonly containerPresent: boolean; readonly inspectCount: number }> {
  let containerPresent = true;
  let inspectCount = 0;
  const identity = value.snapshot.container;
  if (identity.kind !== 'present') throw new Error('test fixture lost its exact container identity');
  const container = (running: boolean): CleanupDockerContainer => ({ id: identity.id, name: identity.name, imageDigest: identity.imageDigest, labels: identity.labels, running, stoppedAt: running ? null : NOW });
  const worker = createCleanupWorker({
    db: value.db,
    stateRoot: value.root,
    ownerUid: UID,
    workerOwner: 'cleanup-worker',
    ownership: value.ownership,
    fileSystem: createRecoveryFileSystem(),
    clock: { now: () => NOW },
    timeouts: { dockerMs: 1_000, systemdMs: 1_000 },
    systemd: {
      inspect: vi.fn(async (unit: string) => {
        inspectCount += 1;
        const crashAt = phase === 'before-remove' ? 5 : 11;
        if (inspectCount === crashAt) throw new Error(`simulated crash before ${phase}`);
        return { unit, active: false, observedAt: NOW };
      }),
    },
    docker: {
      inspect: vi.fn(async () => containerPresent ? container(true) : null),
      stop: vi.fn(async () => undefined),
      waitForStopped: vi.fn(async () => container(false)),
      remove: vi.fn(async () => { containerPresent = false; }),
      hasByJobId: vi.fn(async () => false),
      listByJobId: vi.fn(async () => []),
    },
    logSealer: { seal: vi.fn(async ({ at }: { at: string }) => ({ runner: 'absent' as const, docker: 'absent' as const, verifiedAt: at, contiguous: true as const })) },
    quarantine: { quarantine: vi.fn(async () => ({ kind: 'absent' as const, path: null, sourcePath: `staging/${value.jobId}`, sourceAbsent: true as const, verifiedAt: NOW })) },
    evidenceWriter: { write: vi.fn(async () => ({ path: `jobs/${value.jobId}/evidence/cleanup/cleanup.json`, sha256: EVIDENCE_SHA })) },
  });
  let failure: unknown;
  try { await worker.run([value.admission.admissionId]); }
  catch (error) { failure = error; }
  if (!(failure instanceof Error)) throw new Error('expected cleanup worker crash');
  if (inspectCount === 0) throw new Error(`cleanup worker failed before systemd guard: ${failure.message}`);
  return { containerPresent, inspectCount };
}

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('cleanup recovery crash windows', () => {
  it.each([
    ['before docker rm', false],
    ['after exact removal before cleanup CAS', true],
  ])('rotates a claimed cleanup admission after a crash %s while retaining the exact recovery handle', async (_label, exactContainerRemoved) => {
    const value = await createFixture();
    const crash = await crashWorker(value, exactContainerRemoved ? 'after-remove' : 'before-remove');
    const oldIdentity = value.snapshot.container;
    expect(oldIdentity.kind).toBe('present');
    expect(crash.containerPresent).toBe(!exactContainerRemoved);
    const result = await value.recovery.reconcileAndStart({
      jobId: value.jobId,
      admissionId: value.admission.admissionId,
      owner: 'cleanup-worker',
      expiresAt: NEXT_EXPIRES,
      at: AFTER,
      snapshot: value.snapshot,
    });
    expect(result.rotated).toBe(true);
    expect(result.admissionId).not.toBe(value.admission.admissionId);
    expect(value.systemd.starts).toContain(result.unitName);
    if (oldIdentity.kind !== 'present') throw new Error('test fixture lost its exact container identity');
    expect((value.db.prepare('SELECT container_id FROM jobs WHERE job_id=?').get(value.jobId) as { container_id: string }).container_id).toBe(oldIdentity.id);
    expect(crash.inspectCount).toBe(exactContainerRemoved ? 11 : 5);
    const oldLease = value.db.prepare('SELECT unit_name, fence_generation, fence_token_hash, expires_at FROM cleanup_leases WHERE admission_id=?').get(value.admission.admissionId) as {
      unit_name: string;
      fence_generation: number;
      fence_token_hash: string;
      expires_at: string;
    };
    const eventsBefore = (value.db.prepare('SELECT COUNT(*) AS count FROM job_events WHERE job_id=?').get(value.jobId) as { count: number }).count;
    expect(value.ownership.cleanupWrite({
      kind: 'renew-lease',
      jobId: value.jobId,
      admissionId: value.admission.admissionId,
      owner: 'cleanup-worker',
      unitName: oldLease.unit_name,
      fenceGeneration: oldLease.fence_generation,
      fenceTokenHash: oldLease.fence_token_hash,
      expectedExpiresAt: oldLease.expires_at,
      expiresAt: NEXT_EXPIRES,
      snapshot: value.snapshot,
      at: AFTER,
    })).toMatchObject({ ok: false });
    expect((value.db.prepare('SELECT COUNT(*) AS count FROM job_events WHERE job_id=?').get(value.jobId) as { count: number }).count).toBe(eventsBefore);

    const postcondition = await runReplacementWorker({ ...value, admission: result });
    const restartedSystemd = systemdState(AFTER);
    const handBack = handBackDependencies(postcondition, AFTER);
    (handBack.evidence.read as ReturnType<typeof vi.fn>).mockResolvedValue({ jobId: value.jobId, admissionId: result.admissionId, sha256: EVIDENCE_SHA, postcondition });
    const restarted = createCleanupAdmissionRecovery({ stateRoot: value.root, db: value.db, ownership: new OwnershipStore(value.db, { now: () => AFTER }), systemd: restartedSystemd.systemd, handBack, clock: { now: () => AFTER }, ownerUid: UID });
    await restarted.openAdmissions();
    expect((value.db.prepare('SELECT state, cleanup_admission_id, cleanup_fence_generation FROM jobs WHERE job_id=?').get(value.jobId) as Record<string, unknown>)).toMatchObject({ state: 'interrupted', cleanup_admission_id: null, cleanup_fence_generation: null });
    expect((value.db.prepare('SELECT status FROM cleanup_leases WHERE admission_id=?').get(result.admissionId) as { status: string }).status).toBe('handed_back');
  });

  it('hands back after cleanup CAS during startup without starting another worker', async () => {
    const value = await createFixture();
    const postcondition = removedPostcondition(value.jobId, value.snapshot);
    const tokenHash = (value.db.prepare('SELECT fence_token_hash FROM cleanup_leases WHERE admission_id=?').get(value.admission.admissionId) as { fence_token_hash: string }).fence_token_hash;
    expect(value.ownership.cleanupWrite({
      kind: 'claim-lease',
      jobId: value.jobId,
      admissionId: value.admission.admissionId,
      owner: 'cleanup-worker',
      unitName: value.admission.unitName,
      fenceGeneration: value.admission.generation,
      fenceTokenHash: tokenHash,
      snapshot: value.snapshot,
      at: NOW,
    }).ok).toBe(true);
    expect(value.ownership.cleanupWrite({
      kind: 'complete',
      jobId: value.jobId,
      admissionId: value.admission.admissionId,
      owner: 'cleanup-worker',
      unitName: value.admission.unitName,
      fenceGeneration: value.admission.generation,
      fenceTokenHash: tokenHash,
      snapshot: value.snapshot,
      postcondition,
      exactContainerId: value.snapshot.container.kind === 'present' ? value.snapshot.container.id : null,
      containerAbsent: true,
      evidencePath: `jobs/${value.jobId}/evidence/cleanup/cleanup.json`,
      evidenceSha256: EVIDENCE_SHA,
      at: NOW,
    }).ok).toBe(true);
    expect(value.db.prepare('SELECT state, queue_state, cleanup_admission_id, cleanup_fence_generation FROM jobs WHERE job_id=?').get(value.jobId)).toMatchObject({
      state: 'building',
      queue_state: 'dispatched',
      cleanup_admission_id: value.admission.admissionId,
      cleanup_fence_generation: 1,
    });

    const restartedSystemd = systemdState();
    const handBack = handBackDependencies(postcondition);
    (handBack.evidence.read as ReturnType<typeof vi.fn>).mockResolvedValue({ jobId: value.jobId, admissionId: value.admission.admissionId, sha256: EVIDENCE_SHA, postcondition });
    const restarted = createCleanupAdmissionRecovery({ stateRoot: value.root, db: value.db, ownership: new OwnershipStore(value.db, { now: () => NOW }), systemd: restartedSystemd.systemd, handBack, clock: { now: () => NOW }, ownerUid: UID });
    await restarted.openAdmissions();

    expect(restartedSystemd.starts).toEqual([]);
    expect((value.db.prepare('SELECT state, queue_state, cleanup_admission_id, cleanup_fence_generation FROM jobs WHERE job_id=?').get(value.jobId) as Record<string, unknown>)).toMatchObject({ state: 'interrupted', queue_state: 'complete', cleanup_admission_id: null, cleanup_fence_generation: null });
    expect((value.db.prepare('SELECT status FROM cleanup_leases WHERE admission_id=?').get(value.admission.admissionId) as { status: string }).status).toBe('handed_back');
    expect((handBack.docker.inspect as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(`container-${value.jobId}`);
    expect((handBack.docker.listByLabels as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ [LABEL_JOB]: value.jobId });
  });

  it('keeps admissions open when startup reconciliation finds a recovery boundary', async () => {
    const value = await createFixture();
    const postcondition = completeAdmission(value);
    const handBack = boundHandBack(value, postcondition);
    (handBack.evidence.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      jobId: value.jobId,
      admissionId: value.admission.admissionId,
      sha256: 'f'.repeat(64),
      postcondition,
    });
    const restarted = createCleanupAdmissionRecovery({
      stateRoot: value.root,
      db: value.db,
      ownership: new OwnershipStore(value.db, { now: () => NOW }),
      systemd: systemdState().systemd,
      handBack,
      clock: { now: () => NOW },
      ownerUid: UID,
    });

    await expect(restarted.openAdmissions()).resolves.toBeUndefined();
    await expect(restarted.reconcileCompletedAdmissions()).rejects.toThrow('cleanup completion file does not match');
    expect(value.db.prepare('SELECT cleanup_admission_id, cleanup_fence_generation FROM jobs WHERE job_id=?').get(value.jobId)).toMatchObject({
      cleanup_admission_id: value.admission.admissionId,
      cleanup_fence_generation: 1,
    });
  });

  it('fails startup on infrastructure errors and can retry after the dependency recovers', async () => {
    const value = await createFixture();
    const postcondition = completeAdmission(value);
    const handBack = boundHandBack(value, postcondition);
    const restartedSystemd = systemdState();
    (restartedSystemd.systemd.inspect as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('systemd unavailable'));
    const restarted = createCleanupAdmissionRecovery({
      stateRoot: value.root,
      db: value.db,
      ownership: new OwnershipStore(value.db, { now: () => NOW }),
      systemd: restartedSystemd.systemd,
      handBack,
      clock: { now: () => NOW },
      ownerUid: UID,
    });

    await expect(restarted.openAdmissions()).rejects.toThrow('systemd unavailable');
    await expect(restarted.openAdmissions()).resolves.toBeUndefined();
    expect(value.db.prepare('SELECT state, cleanup_admission_id FROM jobs WHERE job_id=?').get(value.jobId)).toMatchObject({
      state: 'interrupted',
      cleanup_admission_id: null,
    });
  });

  it('leaves an already-interrupted job terminal after hand-back', async () => {
    const value = await createFixture('interrupted');
    const postcondition = await runReplacementWorker(value, NOW);
    const handBack = handBackDependencies(postcondition);
    (handBack.evidence.read as ReturnType<typeof vi.fn>).mockResolvedValue({ jobId: value.jobId, admissionId: value.admission.admissionId, sha256: EVIDENCE_SHA, postcondition });
    const restartedSystemd = systemdState();
    const restarted = createCleanupAdmissionRecovery({ stateRoot: value.root, db: value.db, ownership: new OwnershipStore(value.db, { now: () => NOW }), systemd: restartedSystemd.systemd, handBack, clock: { now: () => NOW }, ownerUid: UID });
    const result = await restarted.openAdmissions().then(() => restarted.handBackCompleted({ jobId: value.jobId, admissionId: value.admission.admissionId, at: NOW }));
    expect(result).toMatchObject({ state: 'already-interrupted', handedBack: false, started: false });
    expect((value.db.prepare('SELECT state FROM jobs WHERE job_id=?').get(value.jobId) as { state: string }).state).toBe('interrupted');
  });

  it('retains the fence when independent hand-back proof finds an active cleanup unit', async () => {
    const value = await createFixture();
    const postcondition = removedPostcondition(value.jobId, value.snapshot);
    const tokenHash = (value.db.prepare('SELECT fence_token_hash FROM cleanup_leases WHERE admission_id=?').get(value.admission.admissionId) as { fence_token_hash: string }).fence_token_hash;
    value.ownership.cleanupWrite({ kind: 'claim-lease', jobId: value.jobId, admissionId: value.admission.admissionId, owner: 'cleanup-worker', unitName: value.admission.unitName, fenceGeneration: value.admission.generation, fenceTokenHash: tokenHash, snapshot: value.snapshot, at: NOW });
    value.ownership.cleanupWrite({ kind: 'complete', jobId: value.jobId, admissionId: value.admission.admissionId, owner: 'cleanup-worker', unitName: value.admission.unitName, fenceGeneration: value.admission.generation, fenceTokenHash: tokenHash, snapshot: value.snapshot, postcondition, exactContainerId: `container-${value.jobId}`, containerAbsent: true, evidencePath: `jobs/${value.jobId}/evidence/cleanup/cleanup.json`, evidenceSha256: EVIDENCE_SHA, at: NOW });
    const handBack = handBackDependencies(postcondition);
    (handBack.evidence.read as ReturnType<typeof vi.fn>).mockResolvedValue({ jobId: value.jobId, admissionId: value.admission.admissionId, sha256: EVIDENCE_SHA, postcondition });
    value.systemd.active.set(value.admission.unitName, true);
    const restarted = createCleanupAdmissionRecovery({ stateRoot: value.root, db: value.db, ownership: new OwnershipStore(value.db, { now: () => NOW }), systemd: value.systemd.systemd, handBack, clock: { now: () => NOW }, ownerUid: UID });
    await expect(restarted.openAdmissions()).resolves.toBeUndefined();
    await expect(restarted.handBackCompleted({ jobId: value.jobId, admissionId: value.admission.admissionId, at: NOW })).rejects.toThrow('cleanup unit is still active');
    expect((value.db.prepare('SELECT cleanup_admission_id, cleanup_fence_generation FROM jobs WHERE job_id=?').get(value.jobId) as Record<string, unknown>)).toMatchObject({ cleanup_admission_id: value.admission.admissionId, cleanup_fence_generation: 1 });
    expect((value.db.prepare('SELECT status FROM cleanup_leases WHERE admission_id=?').get(value.admission.admissionId) as { status: string }).status).toBe('completed');
  });

  it('rejects hand-back before the cleanup CAS and retains a blocking cleanup admission', async () => {
    const incomplete = await createFixture();
    await expect(incomplete.recovery.handBackCompleted({ jobId: incomplete.jobId, admissionId: incomplete.admission.admissionId, at: NOW })).rejects.toThrow('cleanup admission is not completed');
    expect(incomplete.db.prepare('SELECT cleanup_admission_id, cleanup_fence_generation FROM jobs WHERE job_id=?').get(incomplete.jobId)).toMatchObject({
      cleanup_admission_id: incomplete.admission.admissionId,
      cleanup_fence_generation: 1,
    });

    const blocked = await createFixture();
    const tokenHash = (blocked.db.prepare('SELECT fence_token_hash FROM cleanup_leases WHERE admission_id=?').get(blocked.admission.admissionId) as { fence_token_hash: string }).fence_token_hash;
    expect(blocked.ownership.cleanupWrite({
      kind: 'claim-lease',
      jobId: blocked.jobId,
      admissionId: blocked.admission.admissionId,
      owner: 'cleanup-worker',
      unitName: blocked.admission.unitName,
      fenceGeneration: blocked.admission.generation,
      fenceTokenHash: tokenHash,
      snapshot: blocked.snapshot,
      at: NOW,
    }).ok).toBe(true);
    expect(blocked.ownership.cleanupWrite({
      kind: 'evidence',
      jobId: blocked.jobId,
      admissionId: blocked.admission.admissionId,
      owner: 'cleanup-worker',
      unitName: blocked.admission.unitName,
      fenceGeneration: blocked.admission.generation,
      fenceTokenHash: tokenHash,
      snapshot: blocked.snapshot,
      status: 'blocking',
      blockerCode: 'QUARANTINE_PENDING',
      blocker: { reason: 'quarantine proof is unavailable' },
      at: NOW,
    }).ok).toBe(true);
    const restarted = createCleanupAdmissionRecovery({
      stateRoot: blocked.root,
      db: blocked.db,
      ownership: new OwnershipStore(blocked.db, { now: () => NOW }),
      systemd: systemdState().systemd,
      handBack: boundHandBack(blocked, removedPostcondition(blocked.jobId, blocked.snapshot)),
      clock: { now: () => NOW },
      ownerUid: UID,
    });
    await expect(restarted.openAdmissions()).resolves.toBeUndefined();
    expect(blocked.db.prepare('SELECT cleanup_admission_id, cleanup_fence_generation, cleanup_blocker_code FROM jobs WHERE job_id=?').get(blocked.jobId)).toMatchObject({
      cleanup_admission_id: blocked.admission.admissionId,
      cleanup_fence_generation: 1,
      cleanup_blocker_code: 'QUARANTINE_PENDING',
    });
    expect(blocked.db.prepare('SELECT status FROM cleanup_leases WHERE admission_id=?').get(blocked.admission.admissionId)).toMatchObject({ status: 'blocking' });
  });

  it.each([
    'exact container still present',
    'job-labeled container with wrong manifest remains',
    'staging postcondition is unverified',
    'stale runner unit is active',
    'systemd observation is stale',
  ] as const)('retains the completed fence when %s', async (condition) => {
    const value = await createFixture();
    const postcondition = completeAdmission(value);
    const handBack = boundHandBack(value, postcondition);
    const restartedSystemd = systemdState();
    if (condition === 'exact container still present') {
      (handBack.docker.inspect as ReturnType<typeof vi.fn>).mockResolvedValue({
        container: {
          id: `container-${value.jobId}`,
          labels: labels(value.jobId),
        },
        observedAt: NOW,
      });
    } else if (condition === 'job-labeled container with wrong manifest remains') {
      (handBack.docker.listByLabels as ReturnType<typeof vi.fn>).mockResolvedValue({
        containers: [{
          id: `container-${value.jobId}`,
          labels: { [LABEL_JOB]: value.jobId, [LABEL_MANIFEST]: 'f'.repeat(64) },
        }],
        observedAt: NOW,
      });
    } else if (condition === 'staging postcondition is unverified') {
      (handBack.staging.verify as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    } else if (condition === 'stale runner unit is active') {
      restartedSystemd.active.set(`osi-image-builder-runner@${value.jobId}.service`, true);
    } else {
      (restartedSystemd.systemd.inspect as ReturnType<typeof vi.fn>).mockImplementation(async (unit: string) => ({ unit, active: false, observedAt: RUNNER_EXPIRES }));
    }
    const restarted = createCleanupAdmissionRecovery({
      stateRoot: value.root,
      db: value.db,
      ownership: new OwnershipStore(value.db, { now: () => NOW }),
      systemd: restartedSystemd.systemd,
      handBack,
      clock: { now: () => NOW },
      ownerUid: UID,
    });
    await expect(restarted.openAdmissions()).resolves.toBeUndefined();
    await expect(restarted.handBackCompleted({ jobId: value.jobId, admissionId: value.admission.admissionId, at: NOW })).rejects.toBeInstanceOf(Error);
    expect(value.db.prepare('SELECT cleanup_admission_id, cleanup_fence_generation FROM jobs WHERE job_id=?').get(value.jobId)).toMatchObject({
      cleanup_admission_id: value.admission.admissionId,
      cleanup_fence_generation: 1,
    });
    expect(value.db.prepare('SELECT status FROM cleanup_leases WHERE admission_id=?').get(value.admission.admissionId)).toMatchObject({ status: 'completed' });
  });

  it('retains the completed fence when persisted logs contradict cleanup evidence', async () => {
    const value = await createFixture();
    const postcondition = completeAdmission(value);
    value.db.prepare('INSERT INTO job_log_generations (job_id, stream, generation, path, started_at, size_bytes) VALUES (?, ?, 0, ?, ?, 0)').run(
      value.jobId,
      'runner',
      'logs/runner-0.log',
      NOW,
    );
    const restarted = createCleanupAdmissionRecovery({
      stateRoot: value.root,
      db: value.db,
      ownership: new OwnershipStore(value.db, { now: () => NOW }),
      systemd: systemdState().systemd,
      handBack: boundHandBack(value, postcondition),
      clock: { now: () => NOW },
      ownerUid: UID,
    });
    await expect(restarted.openAdmissions()).resolves.toBeUndefined();
    await expect(restarted.handBackCompleted({ jobId: value.jobId, admissionId: value.admission.admissionId, at: NOW })).rejects.toThrow('logs are present but evidence says absent');
    expect(value.db.prepare('SELECT cleanup_fence_generation FROM jobs WHERE job_id=?').get(value.jobId)).toMatchObject({ cleanup_fence_generation: 1 });
  });
});
