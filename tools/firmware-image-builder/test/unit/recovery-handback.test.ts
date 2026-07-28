import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createCleanupAdmissionRecovery,
  RecoveryBoundaryError,
  RecoveryInfrastructureError,
  type RecoveryHandBackDependencies,
  type RecoverySystemd,
} from '../../api/src/recovery.js';
import type { CleanupPostcondition, CleanupSnapshot } from '../../api/src/ownership.js';

const NOW = '2026-07-28T12:00:00.000Z';
const STALE = '2026-07-28T11:55:00.000Z';
const JOB_ID = 'handback-unit';
const ADMISSION_ID = 'cln_0123456789abcdefghjkmnpqrs';
const RUNNER_UNIT = `osi-image-builder-runner@${JOB_ID}.service`;
const CLEANUP_UNIT = `osi-image-builder-cleanup@${ADMISSION_ID}.service`;
const TOKEN_HASH = 'a'.repeat(64);
const EVIDENCE_HASH = 'b'.repeat(64);
const LABEL_JOB = 'org.osi.image-builder.job-id';
const LABEL_MANIFEST = 'org.osi.image-builder.manifest-sha';
const MANIFEST_SHA = 'c'.repeat(64);

function snapshot(): CleanupSnapshot {
  return {
    runner: { unit: RUNNER_UNIT, owner: 'runner-owner', leaseExpiresAt: STALE, inactiveAt: NOW, observedAt: NOW },
    state: 'building',
    container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: NOW },
    staging: { kind: 'absent', path: null },
    logs: { runner: 'absent', docker: 'absent', verifiedAt: NOW },
    blocker: 'none',
  };
}

function postcondition(): CleanupPostcondition {
  const current = snapshot();
  return {
    runner: current.runner,
    state: current.state,
    container: { kind: 'null-identity', dockerAction: 'none', globalLabelResult: 'no-match', observedAt: NOW },
    staging: { kind: 'absent', path: null, sourcePath: `staging/${JOB_ID}`, sourceAbsent: true, verifiedAt: NOW },
    logs: { runner: 'absent', docker: 'absent', verifiedAt: NOW },
    blocker: 'none',
  };
}

function fixture() {
  const current = snapshot();
  const completedPostcondition = postcondition();
  const completed = {
    admission_id: ADMISSION_ID,
    job_id: JOB_ID,
    owner: 'cleanup-worker',
    unit_name: CLEANUP_UNIT,
    status: 'completed',
    expires_at: '2026-07-28T12:05:00.000Z',
    fence_generation: 1,
    fence_token_hash: TOKEN_HASH,
    completion_evidence_path: `jobs/${JOB_ID}/evidence/cleanup/cleanup.json`,
    completion_evidence_sha256: EVIDENCE_HASH,
    blocker_code: null,
    blocker_json: null,
    stale_runner_unit: RUNNER_UNIT,
    stale_runner_owner: 'runner-owner',
    stale_runner_lease_expires_at: STALE,
    stale_state: 'building',
    stale_container_id: null,
    stale_container_name: null,
    stale_container_labels_json: null,
    proof_json: JSON.stringify(current),
    complete_at: NOW,
  };
  const job = {
    job_id: JOB_ID,
    state: 'building',
    runner_unit: RUNNER_UNIT,
    runner_lease_owner: 'runner-owner',
    runner_lease_expires_at: STALE,
    cleanup_admission_id: ADMISSION_ID,
    cleanup_fence_generation: 1,
    cleanup_fence_token_hash: TOKEN_HASH,
    cleanup_blocker_code: null,
    cleanup_blocker_json: null,
    container_id: null,
    container_name: null,
    container_image_digest: null,
    container_label_job_id: null,
    container_label_manifest_sha: null,
    container_labels_json: null,
    container_mount_json: null,
    container_env_json: null,
    container_security_json: null,
    container_inspection_json: null,
    container_created_at: null,
    container_started_at: null,
    container_stopped_at: null,
    container_removed_at: null,
    container_cleanup_outcome: null,
    artifact_staging_path: null,
    artifact_quarantine_path: null,
    publish_state: null,
    root_id: 'release',
    artifact_sha256: null,
    artifact_size: null,
    checksum_path: null,
    checksum_sha256: null,
    manifest_path: null,
    manifest_sha256: null,
    verification_path: null,
    verification_sha256: null,
    target_manifest_sha256: MANIFEST_SHA,
  };
  const completionEvent = {
    seq: 10,
    at: NOW,
    payload_json: JSON.stringify({ admissionId: ADMISSION_ID, evidencePath: `jobs/${JOB_ID}/evidence/cleanup/cleanup.json`, postcondition: completedPostcondition }),
  };
  const logGenerations: Record<string, unknown>[] = [];
  const logEvents: Record<string, unknown>[] = [];
  const db = {
    exec: vi.fn(),
    prepare: vi.fn((sql: string) => ({
      all: (..._parameters: readonly unknown[]) => sql.includes('FROM job_log_generations')
        ? logGenerations
        : sql.includes('FROM job_events') && sql.includes('stream IS NOT NULL')
          ? logEvents
          : [],
      get: (..._parameters: readonly unknown[]) => {
        if (sql.includes('job_events')) return completionEvent;
        if (sql.includes('cleanup_leases')) return completed;
        if (sql.includes('FROM jobs')) return job;
        return undefined;
      },
    })),
  };
  const writes: unknown[] = [];
  const ownership = {
    apiWrite: vi.fn((command: unknown) => {
      writes.push(command);
      return { ok: true, kind: 'committed', eventSeq: writes.length, value: undefined } as const;
    }),
  };
  const systemd: RecoverySystemd = {
    start: vi.fn(),
    isActive: vi.fn(async () => false),
    inspect: vi.fn(async (unit: string) => ({ unit, active: false, observedAt: NOW })),
  };
  const handBack: RecoveryHandBackDependencies = {
    docker: {
      inspect: vi.fn(async () => ({ container: null, observedAt: NOW })),
      listByLabels: vi.fn(async () => ({ containers: [], observedAt: NOW })),
    },
    evidence: {
      read: vi.fn(async () => ({ jobId: JOB_ID, admissionId: ADMISSION_ID, sha256: EVIDENCE_HASH, postcondition: completedPostcondition })),
    },
    staging: {
      verify: vi.fn(async () => true as const),
    },
    logs: {
      verify: vi.fn(async () => true as const),
    },
  };
  return { db, ownership, systemd, handBack, writes, completed, job, completionEvent, completedPostcondition, logGenerations, logEvents };
}

function exposeCompletedStartupRow(value: ReturnType<typeof fixture>): void {
  const prepare = value.db.prepare as ReturnType<typeof vi.fn>;
  const implementation = prepare.getMockImplementation() as ((sql: string) => unknown) | undefined;
  if (implementation === undefined) throw new Error('test database prepare implementation is unavailable');
  let returned = false;
  prepare.mockImplementation((sql: string) => sql.includes("WHERE status='completed'") && sql.includes('SELECT admission_id, job_id, complete_at')
    ? { all: () => returned ? [] : (returned = true, [{ admission_id: ADMISSION_ID, job_id: JOB_ID, complete_at: NOW }]) }
    : sql.includes("WHERE status='completed'")
      ? { all: () => [{ admission_id: ADMISSION_ID, job_id: JOB_ID }] }
    : implementation(sql));
}

function exactIdentityFixture() {
  const value = fixture();
  const identity = {
    id: `container-${JOB_ID}`,
    name: `osi-${JOB_ID}`,
    imageDigest: 'd'.repeat(64),
    labels: { [LABEL_JOB]: JOB_ID, [LABEL_MANIFEST]: MANIFEST_SHA },
  };
  const persisted = JSON.parse(value.completed.proof_json) as Record<string, unknown>;
  persisted.container = { kind: 'present', ...identity, globalLabelResult: 'single-exact-match', observedAt: NOW };
  persisted.blocker = 'container';
  Object.assign(value.completed as Record<string, unknown>, {
    stale_container_id: identity.id,
    stale_container_name: identity.name,
    stale_container_labels_json: JSON.stringify(identity.labels),
    proof_json: JSON.stringify(persisted),
  });
  Object.assign(value.completedPostcondition, {
    container: {
      kind: 'already-absent',
      ...identity,
      exactIdAbsent: true,
      dockerAction: 'none',
      globalLabelResult: 'no-match',
      observedAt: NOW,
    },
  });
  value.completionEvent.payload_json = JSON.stringify({
    admissionId: ADMISSION_ID,
    evidencePath: `jobs/${JOB_ID}/evidence/cleanup/cleanup.json`,
    postcondition: value.completedPostcondition,
  });
  return value;
}

describe('cleanup hand-back recovery', () => {
  it('fails closed when completed-admission snapshot support is unavailable', async () => {
    const value = fixture();
    const { exec: _exec, ...withoutSnapshot } = value.db;
    const stateRoot = await mkdtemp(join(tmpdir(), 'osi-image-builder-no-snapshot-'));
    const recovery = createCleanupAdmissionRecovery({
      stateRoot,
      db: withoutSnapshot as never,
      ownership: value.ownership,
      systemd: value.systemd,
      handBack: value.handBack,
      clock: { now: () => NOW },
    });
    try {
      await expect(recovery.openAdmissions()).rejects.toThrow(/read snapshot/);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('keeps admissions closed and retries startup after production infrastructure failure', async () => {
    const value = fixture();
    exposeCompletedStartupRow(value);
    const infrastructure = new RecoveryInfrastructureError('state-root descriptor read failed');
    const mismatch = new RecoveryBoundaryError('cleanup completion evidence is semantically invalid');
    (value.handBack.evidence.read as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(infrastructure)
      .mockRejectedValue(mismatch);
    const stateRoot = await mkdtemp(join(tmpdir(), 'osi-image-builder-handback-infrastructure-'));
    const recovery = createCleanupAdmissionRecovery({
      stateRoot,
      db: value.db as never,
      ownership: value.ownership,
      systemd: value.systemd,
      handBack: value.handBack,
      clock: { now: () => NOW },
    });
    try {
      await expect(recovery.openAdmissions()).rejects.toBe(infrastructure);
      await expect(recovery.reconcileCompletedAdmissions()).rejects.toThrow('cleanup admissions are not open');
      await expect(recovery.openAdmissions()).resolves.toBeUndefined();
      await expect(recovery.handBackCompleted({ jobId: JOB_ID, admissionId: ADMISSION_ID })).rejects.toBe(mismatch);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('suppresses semantic evidence mismatch at startup while leaving the API open and fenced', async () => {
    const value = fixture();
    exposeCompletedStartupRow(value);
    const mismatch = new RecoveryBoundaryError('cleanup completion evidence is semantically invalid');
    (value.handBack.evidence.read as ReturnType<typeof vi.fn>).mockRejectedValue(mismatch);
    const stateRoot = await mkdtemp(join(tmpdir(), 'osi-image-builder-handback-boundary-'));
    const recovery = createCleanupAdmissionRecovery({
      stateRoot,
      db: value.db as never,
      ownership: value.ownership,
      systemd: value.systemd,
      handBack: value.handBack,
      clock: { now: () => NOW },
    });
    try {
      await expect(recovery.openAdmissions()).resolves.toBeUndefined();
      await expect(recovery.handBackCompleted({ jobId: JOB_ID, admissionId: ADMISSION_ID })).rejects.toBe(mismatch);
      expect(value.ownership.apiWrite).not.toHaveBeenCalled();
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('hands back a completed admission without starting another worker', async () => {
    const value = fixture();
    const stateRoot = await mkdtemp(join(tmpdir(), 'osi-image-builder-handback-unit-'));
    const recovery = createCleanupAdmissionRecovery({
      stateRoot,
      db: value.db as never,
      ownership: value.ownership,
      systemd: value.systemd,
      handBack: value.handBack,
      clock: { now: () => NOW },
    });

    try {
      await recovery.openAdmissions();
      const result = await recovery.handBackCompleted({ jobId: JOB_ID, admissionId: ADMISSION_ID, at: NOW });

      expect(result).toMatchObject({ jobId: JOB_ID, admissionId: ADMISSION_ID, handedBack: true, started: false, state: 'interrupted' });
      expect(value.systemd.start).not.toHaveBeenCalled();
      expect(value.ownership.apiWrite).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'hand-back',
        jobId: JOB_ID,
        admissionId: ADMISSION_ID,
        owner: 'cleanup-worker',
        unitName: CLEANUP_UNIT,
        fenceGeneration: 1,
        fenceTokenHash: TOKEN_HASH,
        proof: expect.objectContaining({ blocker: 'none' }),
      }));
      expect(value.handBack.docker.listByLabels).toHaveBeenCalledWith({ [LABEL_JOB]: JOB_ID });
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('establishes an inactive systemd bracket before reading physical recovery evidence', async () => {
    const value = fixture();
    const order: string[] = [];
    vi.spyOn(value.systemd, 'inspect').mockImplementation(async (unit: string) => { order.push(`systemd:${unit}`); return { unit, active: false, observedAt: NOW }; });
    (value.handBack.evidence.read as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('evidence'); return { jobId: JOB_ID, admissionId: ADMISSION_ID, sha256: EVIDENCE_HASH, postcondition: value.completedPostcondition }; });
    (value.handBack.logs.verify as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('logs'); return true as const; });
    (value.handBack.staging.verify as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('staging'); return true as const; });
    const stateRoot = await mkdtemp(join(tmpdir(), 'osi-image-builder-handback-bracket-'));
    try {
      const recovery = createCleanupAdmissionRecovery({ stateRoot, db: value.db as never, ownership: value.ownership, systemd: value.systemd, handBack: value.handBack, clock: { now: () => NOW } });
      await recovery.openAdmissions();
      await recovery.handBackCompleted({ jobId: JOB_ID, admissionId: ADMISSION_ID, at: NOW });
      expect(order.indexOf('systemd:' + CLEANUP_UNIT)).toBeLessThan(order.indexOf('evidence'));
      expect(order.filter((entry) => entry.startsWith('systemd:'))).toHaveLength(4);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('keeps the cleanup fence when either unit activates in the post-verification bracket', async () => {
    const value = fixture();
    let inspections = 0;
    vi.spyOn(value.systemd, 'inspect').mockImplementation(async (unit: string) => {
      inspections += 1;
      return { unit, active: inspections === 3, observedAt: NOW };
    });
    const stateRoot = await mkdtemp(join(tmpdir(), 'osi-image-builder-handback-post-bracket-'));
    try {
      const recovery = createCleanupAdmissionRecovery({ stateRoot, db: value.db as never, ownership: value.ownership, systemd: value.systemd, handBack: value.handBack, clock: { now: () => NOW } });
      await recovery.openAdmissions();
      await expect(recovery.handBackCompleted({ jobId: JOB_ID, admissionId: ADMISSION_ID, at: NOW })).rejects.toThrow(/active|inactive/);
      expect(inspections).toBeGreaterThanOrEqual(3);
      expect(value.ownership.apiWrite).not.toHaveBeenCalled();
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['missing manifest label', { [LABEL_JOB]: JOB_ID }],
    ['wrong manifest label', { [LABEL_JOB]: JOB_ID, [LABEL_MANIFEST]: 'f'.repeat(64) }],
  ])('blocks null-identity hand-back for a job-labeled container with %s', async (_case, labels) => {
    const value = fixture();
    (value.handBack.docker.listByLabels as ReturnType<typeof vi.fn>).mockResolvedValue({
      containers: [{ id: 'unexpected-container', labels }],
      observedAt: NOW,
    });
    const stateRoot = await mkdtemp(join(tmpdir(), 'osi-image-builder-handback-job-label-'));
    const recovery = createCleanupAdmissionRecovery({
      stateRoot,
      db: value.db as never,
      ownership: value.ownership,
      systemd: value.systemd,
      handBack: value.handBack,
      clock: { now: () => NOW },
    });
    try {
      await recovery.openAdmissions();
      await expect(recovery.handBackCompleted({ jobId: JOB_ID, admissionId: ADMISSION_ID, at: NOW })).rejects.toThrow('global Docker label query is not empty');
      expect(value.handBack.docker.inspect).not.toHaveBeenCalled();
      expect(value.handBack.docker.listByLabels).toHaveBeenCalledWith({ [LABEL_JOB]: JOB_ID });
      expect(value.ownership.apiWrite).not.toHaveBeenCalled();
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('orders exact-identity physical checks before the final job-label observation and synchronous hand-back write', async () => {
    const value = exactIdentityFixture();
    const trace: string[] = [];
    (value.systemd.inspect as ReturnType<typeof vi.fn>).mockImplementation(async (unit: string) => {
      trace.push(unit === CLEANUP_UNIT ? 'cleanup-unit' : 'runner-unit');
      return { unit, active: false, observedAt: NOW };
    });
    (value.handBack.staging.verify as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      trace.push('staging');
      return true as const;
    });
    (value.handBack.docker.inspect as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      trace.push('exact-container');
      return { container: null, observedAt: NOW };
    });
    (value.handBack.docker.listByLabels as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      trace.push('job-label-list');
      return { containers: [], observedAt: NOW };
    });
    value.ownership.apiWrite.mockImplementation((command: unknown) => {
      trace.push('api-write');
      value.writes.push(command);
      return { ok: true, kind: 'committed', eventSeq: value.writes.length, value: undefined } as const;
    });
    const stateRoot = await mkdtemp(join(tmpdir(), 'osi-image-builder-handback-order-'));
    const recovery = createCleanupAdmissionRecovery({
      stateRoot,
      db: value.db as never,
      ownership: value.ownership,
      systemd: value.systemd,
      handBack: value.handBack,
      clock: { now: () => NOW },
    });
    try {
      await recovery.openAdmissions();
      await expect(recovery.handBackCompleted({ jobId: JOB_ID, admissionId: ADMISSION_ID, at: NOW })).resolves.toMatchObject({ handedBack: true });
      expect(trace).toEqual(['cleanup-unit', 'runner-unit', 'staging', 'exact-container', 'job-label-list', 'cleanup-unit', 'runner-unit', 'api-write']);
      expect(value.handBack.docker.listByLabels).toHaveBeenCalledWith({ [LABEL_JOB]: JOB_ID });
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('binds every persisted tracked release file into staging verification', async () => {
    const value = fixture();
    const tracked = {
      artifactStagingPath: `staging/${JOB_ID}/image.img.gz`,
      artifactSha256: '1'.repeat(64),
      artifactSize: 123,
      artifactMtime: NOW,
      checksumPath: `staging/${JOB_ID}/sha256sums`,
      checksumSha256: '2'.repeat(64),
      manifestPath: `staging/${JOB_ID}/build-manifest.json`,
      manifestSha256: '3'.repeat(64),
      verificationPath: `staging/${JOB_ID}/verification.json`,
      verificationSha256: '4'.repeat(64),
    };
    Object.assign(value.job, {
      publish_state: 'quarantined',
      artifact_staging_path: tracked.artifactStagingPath,
      artifact_sha256: tracked.artifactSha256,
      artifact_size: tracked.artifactSize,
      artifact_mtime: tracked.artifactMtime,
      checksum_path: tracked.checksumPath,
      checksum_sha256: tracked.checksumSha256,
      manifest_path: tracked.manifestPath,
      manifest_sha256: tracked.manifestSha256,
      verification_path: tracked.verificationPath,
      verification_sha256: tracked.verificationSha256,
    });
    const staging: CleanupPostcondition['staging'] = {
      kind: 'quarantined',
      sourcePath: `staging/${JOB_ID}`,
      destinationPath: `quarantine/${JOB_ID}`,
      sourceAbsent: true,
      destinationPresent: true,
      sha256: tracked.artifactSha256,
      size: tracked.artifactSize,
      verifiedAt: NOW,
    };
    (value.completedPostcondition as { staging: CleanupPostcondition['staging'] }).staging = staging;
    value.completionEvent.payload_json = JSON.stringify({
      admissionId: ADMISSION_ID,
      evidencePath: `jobs/${JOB_ID}/evidence/cleanup/cleanup.json`,
      postcondition: value.completedPostcondition,
    });
    const stateRoot = await mkdtemp(join(tmpdir(), 'osi-image-builder-handback-sidecars-'));
    const recovery = createCleanupAdmissionRecovery({
      stateRoot,
      db: value.db as never,
      ownership: value.ownership,
      systemd: value.systemd,
      handBack: value.handBack,
      clock: { now: () => NOW },
    });
    try {
      await recovery.openAdmissions();
      await expect(recovery.handBackCompleted({ jobId: JOB_ID, admissionId: ADMISSION_ID, at: NOW })).resolves.toMatchObject({ handedBack: true });
      expect(value.handBack.staging.verify).toHaveBeenCalledWith({
        jobId: JOB_ID,
        admissionId: ADMISSION_ID,
        rootId: 'release',
        publishState: 'quarantined',
        ...tracked,
        postcondition: staging,
      });
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('accepts sealed contiguous log generations and their exact durable ranges', async () => {
    const value = fixture();
    const sealedPostcondition: CleanupPostcondition = {
      ...value.completedPostcondition,
      logs: { runner: 'sealed', docker: 'absent', verifiedAt: NOW },
    };
    value.completionEvent.payload_json = JSON.stringify({
      admissionId: ADMISSION_ID,
      evidencePath: `jobs/${JOB_ID}/evidence/cleanup/cleanup.json`,
      postcondition: sealedPostcondition,
    });
    vi.spyOn(value.handBack.evidence, 'read').mockResolvedValue({
      jobId: JOB_ID,
      admissionId: ADMISSION_ID,
      sha256: EVIDENCE_HASH,
      postcondition: sealedPostcondition,
    });
    value.logGenerations.push({
      stream: 'runner',
      generation: 0,
      path: 'logs/runner-0.log',
      started_at: STALE,
      sealed_at: NOW,
      size_bytes: 4,
      sha256: 'd'.repeat(64),
    });
    value.logEvents.push({
      stream: 'runner',
      file_generation: 0,
      seq: 0,
      event_type: 'log-truncated',
      at: NOW,
      byte_offset: 0,
      byte_length: 4,
      partial: 1,
    });
    const stateRoot = await mkdtemp(join(tmpdir(), 'osi-image-builder-handback-logs-'));
    const recovery = createCleanupAdmissionRecovery({
      stateRoot,
      db: value.db as never,
      ownership: value.ownership,
      systemd: value.systemd,
      handBack: value.handBack,
      clock: { now: () => NOW },
    });
    try {
      await recovery.openAdmissions();
      await expect(recovery.handBackCompleted({ jobId: JOB_ID, admissionId: ADMISSION_ID, at: NOW })).resolves.toMatchObject({ handedBack: true });
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when the staging verifier returns no affirmative result', async () => {
    const value = fixture();
    (value.handBack.staging.verify as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const stateRoot = await mkdtemp(join(tmpdir(), 'osi-image-builder-handback-staging-'));
    const recovery = createCleanupAdmissionRecovery({
      stateRoot,
      db: value.db as never,
      ownership: value.ownership,
      systemd: value.systemd,
      handBack: value.handBack,
      clock: { now: () => NOW },
    });
    try {
      await recovery.openAdmissions();
      await expect(recovery.handBackCompleted({ jobId: JOB_ID, admissionId: ADMISSION_ID, at: NOW })).rejects.toThrow('staging postcondition is not verified');
      expect(value.ownership.apiWrite).not.toHaveBeenCalled();
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('rejects log evidence inserted at or after the cleanup completion event', async () => {
    const value = fixture();
    const sealedPostcondition: CleanupPostcondition = {
      ...value.completedPostcondition,
      logs: { runner: 'sealed', docker: 'absent', verifiedAt: NOW },
    };
    value.completionEvent.payload_json = JSON.stringify({
      admissionId: ADMISSION_ID,
      evidencePath: `jobs/${JOB_ID}/evidence/cleanup/cleanup.json`,
      postcondition: sealedPostcondition,
    });
    vi.spyOn(value.handBack.evidence, 'read').mockResolvedValue({
      jobId: JOB_ID,
      admissionId: ADMISSION_ID,
      sha256: EVIDENCE_HASH,
      postcondition: sealedPostcondition,
    });
    value.logGenerations.push({
      stream: 'runner',
      generation: 0,
      path: 'logs/runner-0.log',
      started_at: STALE,
      sealed_at: NOW,
      size_bytes: 4,
      sha256: 'd'.repeat(64),
    });
    value.logEvents.push({
      stream: 'runner',
      file_generation: 0,
      seq: value.completionEvent.seq,
      event_type: 'log',
      at: NOW,
      byte_offset: 0,
      byte_length: 4,
      partial: 0,
    });
    const stateRoot = await mkdtemp(join(tmpdir(), 'osi-image-builder-handback-post-completion-log-'));
    const recovery = createCleanupAdmissionRecovery({
      stateRoot,
      db: value.db as never,
      ownership: value.ownership,
      systemd: value.systemd,
      handBack: value.handBack,
      clock: { now: () => NOW },
    });
    try {
      await recovery.openAdmissions();
      await expect(recovery.handBackCompleted({ jobId: JOB_ID, admissionId: ADMISSION_ID, at: NOW })).rejects.toThrow('cleanup log ranges are not contiguous');
      expect(value.ownership.apiWrite).not.toHaveBeenCalled();
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('rejects mismatched cleanup evidence before systemd, Docker, staging, or ownership side effects', async () => {
    const value = fixture();
    vi.spyOn(value.handBack.evidence, 'read').mockResolvedValue({
      jobId: JOB_ID,
      admissionId: ADMISSION_ID,
      sha256: 'f'.repeat(64),
      postcondition: postcondition(),
    });
    const stateRoot = await mkdtemp(join(tmpdir(), 'osi-image-builder-handback-reject-'));
    const recovery = createCleanupAdmissionRecovery({
      stateRoot,
      db: value.db as never,
      ownership: value.ownership,
      systemd: value.systemd,
      handBack: value.handBack,
      clock: { now: () => NOW },
    });

    try {
      await recovery.openAdmissions();
      await expect(recovery.handBackCompleted({ jobId: JOB_ID, admissionId: ADMISSION_ID, at: NOW })).rejects.toThrow('cleanup completion file does not match');
      expect(value.ownership.apiWrite).not.toHaveBeenCalled();
      expect(value.systemd.inspect).toHaveBeenCalledTimes(2);
      expect(value.handBack.docker.inspect).not.toHaveBeenCalled();
      expect(value.handBack.docker.listByLabels).not.toHaveBeenCalled();
      expect(value.handBack.staging.verify).not.toHaveBeenCalled();
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
