import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createCleanupAdmissionRecovery,
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
    target_manifest_sha256: 'c'.repeat(64),
  };
  const completionEvent = {
    payload_json: JSON.stringify({ admissionId: ADMISSION_ID, evidencePath: `jobs/${JOB_ID}/evidence/cleanup/cleanup.json`, postcondition: completedPostcondition }),
  };
  const logGenerations: Record<string, unknown>[] = [];
  const logEvents: Record<string, unknown>[] = [];
  const db = {
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
  };
  const handBack: RecoveryHandBackDependencies = {
    docker: {
      inspect: vi.fn(async () => null),
      listByLabels: vi.fn(async () => []),
    },
    evidence: {
      read: vi.fn(async () => ({ jobId: JOB_ID, admissionId: ADMISSION_ID, sha256: EVIDENCE_HASH, postcondition: completedPostcondition })),
    },
    staging: {
      verify: vi.fn(async () => true),
    },
  };
  return { db, ownership, systemd, handBack, writes, completed, job, completionEvent, completedPostcondition, logGenerations, logEvents };
}

describe('cleanup hand-back recovery', () => {
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
      started_at: STALE,
      sealed_at: NOW,
      size_bytes: 4,
      sha256: 'd'.repeat(64),
    });
    value.logEvents.push({
      stream: 'runner',
      file_generation: 0,
      seq: 0,
      event_type: 'log_orphan_tail',
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
      expect(value.systemd.isActive).not.toHaveBeenCalled();
      expect(value.handBack.docker.inspect).not.toHaveBeenCalled();
      expect(value.handBack.docker.listByLabels).not.toHaveBeenCalled();
      expect(value.handBack.staging.verify).not.toHaveBeenCalled();
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
