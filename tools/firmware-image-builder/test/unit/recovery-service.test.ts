import { describe, expect, it, vi } from 'vitest';

import type { ApiWriteCommand, CleanupSnapshot, OwnershipResult } from '../../api/src/ownership.js';
import {
  ApiRecoveryBoundaryError,
  createApiRecoveryService,
  type ApiRecoveryInspection,
} from '../../api/src/recovery-service.js';
import type { CleanupAdmissionRecovery } from '../../api/src/recovery.js';
import type { RecoveryJobRecord } from '../../api/src/store.js';

const NOW = '2026-07-28T12:00:00.000Z';
const EXPIRES = '2026-07-28T12:05:00.000Z';
const STALE = '2026-07-28T11:59:00.000Z';
const JOB_ID = 'recovery-service';
const ADMISSION_ID = 'cln_0123456789abcdefghjkmnpqrs';
const NEXT_ADMISSION_ID = 'cln_1123456789abcdefghjkmnpqrs';
const RUNNER_UNIT = `osi-image-builder-runner@${JOB_ID}.service`;
const BLOCKER = { kind: 'cleanup-unit-stop-failed', observedAt: STALE };

function recoveryJob(overrides: Partial<RecoveryJobRecord> = {}): RecoveryJobRecord {
  return {
    jobId: JOB_ID,
    state: 'building',
    queueState: 'active',
    queuePosition: null,
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
    ...overrides,
  };
}

function cleanupSnapshot(state: CleanupSnapshot['state'] = 'building'): CleanupSnapshot {
  return {
    runner: {
      unit: RUNNER_UNIT,
      owner: 'runner-owner',
      leaseExpiresAt: STALE,
      inactiveAt: NOW,
      observedAt: NOW,
    },
    state,
    container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: NOW },
    staging: { kind: 'absent', path: null },
    logs: { runner: 'absent', docker: 'absent', verifiedAt: NOW },
    blocker: 'none',
  };
}

function directCommand(overrides: Partial<Extract<ApiWriteCommand, { kind: 'direct-interrupt' }>> = {}): Extract<ApiWriteCommand, { kind: 'direct-interrupt' }> {
  return {
    kind: 'direct-interrupt',
    jobId: JOB_ID,
    expectedState: 'building',
    at: NOW,
    proof: {
      kind: 'active',
      runnerUnit: RUNNER_UNIT,
      runnerLeaseOwner: 'runner-owner',
      runnerLeaseExpiresAt: STALE,
      leaseStaleAt: NOW,
      unitInactiveAt: NOW,
      container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: NOW },
      staging: { kind: 'absent', path: null },
      logs: { runner: 'absent', docker: 'absent', verifiedAt: NOW, generationIdentity: { runner: [], docker: [] } },
      blocker: 'none',
      cleanupAdmission: null,
      cleanupFence: null,
    },
    errorCode: 'RUNNER_DISAPPEARED',
    error: { reason: 'runner unit inactive' },
    ...overrides,
  };
}

function directInspection(command = directCommand()): ApiRecoveryInspection {
  return { kind: 'direct', jobId: JOB_ID, state: 'building', at: NOW, command };
}

function cleanupInspection(snapshot = cleanupSnapshot()): ApiRecoveryInspection {
  return { kind: 'cleanup', jobId: JOB_ID, state: snapshot.state, at: NOW, snapshot };
}

function cleanupInProgressInspection(state: CleanupSnapshot['state'] = 'building', generation = 3): ApiRecoveryInspection {
  return {
    kind: 'cleanup-in-progress',
    jobId: JOB_ID,
    state,
    at: NOW,
    admissionId: ADMISSION_ID,
    generation,
  };
}

function fixture(initial = recoveryJob(), inspection: ApiRecoveryInspection = directInspection()) {
  let current = structuredClone(initial);
  const store = {
    getRecoveryJob: vi.fn(() => structuredClone(current)),
  };
  const ownership = {
    apiWrite: vi.fn((command: ApiWriteCommand): OwnershipResult => {
      if (command.kind !== 'direct-interrupt') throw new Error('unexpected ownership command');
      current = recoveryJob({
        state: 'interrupted',
        queueState: 'complete',
        terminalAt: command.at,
        terminalErrorCode: command.errorCode,
        terminalError: command.error,
      });
      return { ok: true, kind: 'committed', eventSeq: 41, value: undefined };
    }),
  };
  const recovery = {
    admitAndStart: vi.fn(async (input: Parameters<CleanupAdmissionRecovery['admitAndStart']>[0]) => {
      current = {
        ...current,
        cleanupFenceGeneration: 1,
        cleanupAdmissionId: ADMISSION_ID,
        cleanupLeaseStatus: 'admitted',
        cleanupLeaseExpiresAt: input.expiresAt,
      };
      return {
        admissionId: ADMISSION_ID,
        generation: 1,
        unitName: `osi-image-builder-cleanup@${ADMISSION_ID}.service`,
        credentialRelativePath: `recovery/cleanup-credentials/${ADMISSION_ID}.token`,
        credentialSha256: 'a'.repeat(64),
        rotated: false,
        started: true as const,
      };
    }),
    retryCorrectedAndStart: vi.fn(async (input: Parameters<CleanupAdmissionRecovery['retryCorrectedAndStart']>[0]) => {
      current = {
        ...current,
        cleanupFenceGeneration: 4,
        cleanupAdmissionId: NEXT_ADMISSION_ID,
        cleanupLeaseStatus: 'admitted',
        cleanupLeaseExpiresAt: input.expiresAt,
        cleanupBlockerCode: null,
        cleanupBlocker: null,
        cleanupLeaseBlockerCode: null,
        cleanupLeaseBlocker: null,
      };
      return {
        admissionId: NEXT_ADMISSION_ID,
        generation: 4,
        unitName: `osi-image-builder-cleanup@${NEXT_ADMISSION_ID}.service`,
        credentialRelativePath: `recovery/cleanup-credentials/${NEXT_ADMISSION_ID}.token`,
        credentialSha256: 'b'.repeat(64),
        rotated: true,
        started: true as const,
      };
    }),
    reconcileAndStart: vi.fn(async (input: Parameters<CleanupAdmissionRecovery['reconcileAndStart']>[0]) => {
      current = {
        ...current,
        cleanupFenceGeneration: 3,
        cleanupAdmissionId: ADMISSION_ID,
        cleanupLeaseStatus: 'admitted',
        cleanupLeaseExpiresAt: input.expiresAt,
      };
      return {
        admissionId: ADMISSION_ID,
        generation: 3,
        unitName: `osi-image-builder-cleanup@${ADMISSION_ID}.service`,
        credentialRelativePath: `recovery/cleanup-credentials/${ADMISSION_ID}.token`,
        credentialSha256: 'c'.repeat(64),
        rotated: false,
        started: true as const,
      };
    }),
    handBackCompleted: vi.fn(async (input: Parameters<CleanupAdmissionRecovery['handBackCompleted']>[0]) => {
      current = recoveryJob({
        state: 'interrupted',
        queueState: 'complete',
        terminalAt: input.at ?? NOW,
        terminalErrorCode: 'RUNNER_DISAPPEARED',
        terminalError: { reason: 'cleanup completed' },
      });
      return {
        jobId: input.jobId,
        admissionId: input.admissionId,
        state: 'interrupted' as const,
        recoveryEventSeq: 77,
        handedBack: true,
        started: false as const,
      };
    }),
  };
  const inspector = { inspect: vi.fn(async () => inspection) };
  const service = createApiRecoveryService({
    store,
    ownership,
    recovery,
    inspector,
    owner: () => 'api-recovery-test',
  });
  return { service, store, ownership, recovery, inspector, current: () => current, setCurrent: (value: RecoveryJobRecord) => { current = value; } };
}

describe('API recovery coordinator', () => {
  it('returns not-eligible without inspection or mutation for a terminal job', async () => {
    const value = fixture(recoveryJob({ state: 'succeeded', queueState: 'complete', terminalAt: NOW }));

    await expect(value.service.recover({ jobId: JOB_ID, retry: false, at: NOW }))
      .resolves.toEqual({ kind: 'not-eligible', jobId: JOB_ID });
    expect(value.inspector.inspect).not.toHaveBeenCalled();
    expect(value.ownership.apiWrite).not.toHaveBeenCalled();
    expect(value.recovery.admitAndStart).not.toHaveBeenCalled();
  });

  it('commits direct interruption and returns its exact terminal event provenance', async () => {
    const value = fixture();

    await expect(value.service.recover({ jobId: JOB_ID, retry: false, at: NOW })).resolves.toEqual({
      kind: 'direct-recovered',
      jobId: JOB_ID,
      terminalAt: NOW,
      terminalEventSeq: 41,
    });
    expect(value.ownership.apiWrite).toHaveBeenCalledWith(directCommand());
  });

  it('honors a matching not-eligible inspection without mutating an active job', async () => {
    const value = fixture(recoveryJob(), {
      kind: 'not-eligible',
      jobId: JOB_ID,
      state: 'building',
      at: NOW,
    });

    await expect(value.service.recover({ jobId: JOB_ID, retry: false, at: NOW }))
      .resolves.toEqual({ kind: 'not-eligible', jobId: JOB_ID });
    expect(value.ownership.apiWrite).not.toHaveBeenCalled();
    expect(value.recovery.admitAndStart).not.toHaveBeenCalled();
  });

  it('admits cleanup with a bounded owner and five-minute lease', async () => {
    const value = fixture(recoveryJob(), cleanupInspection());

    await expect(value.service.recover({ jobId: JOB_ID, retry: false, at: NOW })).resolves.toEqual({
      kind: 'cleanup-pending',
      jobId: JOB_ID,
      admissionId: ADMISSION_ID,
      generation: 1,
    });
    expect(value.recovery.admitAndStart).toHaveBeenCalledWith({
      jobId: JOB_ID,
      owner: 'api-recovery-test',
      expiresAt: EXPIRES,
      snapshot: cleanupSnapshot(),
      at: NOW,
    });
  });

  it('reports an unexpired admitted or claimed fence only after physical inspection confirms progress', async () => {
    const value = fixture(recoveryJob({
      cleanupFenceGeneration: 3,
      cleanupAdmissionId: ADMISSION_ID,
      cleanupLeaseStatus: 'claimed',
      cleanupLeaseExpiresAt: EXPIRES,
    }), cleanupInProgressInspection());

    await expect(value.service.recover({ jobId: JOB_ID, retry: false, at: NOW })).resolves.toEqual({
      kind: 'cleanup-in-progress',
      jobId: JOB_ID,
      admissionId: ADMISSION_ID,
      generation: 3,
    });
    expect(value.inspector.inspect).toHaveBeenCalledOnce();
    expect(value.recovery.reconcileAndStart).not.toHaveBeenCalled();
  });

  it('reconciles an inactive admitted or claimed cleanup unit before returning', async () => {
    const value = fixture(recoveryJob({
      cleanupFenceGeneration: 3,
      cleanupAdmissionId: ADMISSION_ID,
      cleanupLeaseStatus: 'claimed',
      cleanupLeaseExpiresAt: STALE,
    }), cleanupInspection());

    await expect(value.service.recover({ jobId: JOB_ID, retry: false, at: NOW })).resolves.toEqual({
      kind: 'cleanup-pending',
      jobId: JOB_ID,
      admissionId: ADMISSION_ID,
      generation: 3,
    });
    expect(value.recovery.reconcileAndStart).toHaveBeenCalledWith({
      jobId: JOB_ID,
      admissionId: ADMISSION_ID,
      owner: 'api-recovery-test',
      expiresAt: EXPIRES,
      snapshot: cleanupSnapshot(),
      at: NOW,
    });
  });

  it('rejects cleanup progress that does not match the durable fence', async () => {
    const value = fixture(recoveryJob({
      cleanupFenceGeneration: 3,
      cleanupAdmissionId: ADMISSION_ID,
      cleanupLeaseStatus: 'claimed',
      cleanupLeaseExpiresAt: EXPIRES,
    }), cleanupInProgressInspection('building', 4));

    await expect(value.service.recover({ jobId: JOB_ID, retry: false, at: NOW }))
      .rejects.toThrow('cleanup progress inspection does not match');
    expect(value.recovery.reconcileAndStart).not.toHaveBeenCalled();
  });

  it('hands back a completed cleanup and returns its durable recovery event', async () => {
    const value = fixture(recoveryJob({
      cleanupFenceGeneration: 3,
      cleanupAdmissionId: ADMISSION_ID,
      cleanupLeaseStatus: 'completed',
      cleanupLeaseExpiresAt: EXPIRES,
    }));

    await expect(value.service.recover({ jobId: JOB_ID, retry: false, at: NOW })).resolves.toEqual({
      kind: 'handed-back',
      jobId: JOB_ID,
      admissionId: ADMISSION_ID,
      recoveryEventSeq: 77,
    });
    expect(value.recovery.handBackCompleted).toHaveBeenCalledWith({ jobId: JOB_ID, admissionId: ADMISSION_ID, at: NOW });
    expect(value.inspector.inspect).not.toHaveBeenCalled();
  });

  it.each(['failed', 'blocking'] as const)('requires explicit retry for a %s cleanup lease', async (status) => {
    const value = fixture(recoveryJob({
      cleanupFenceGeneration: 3,
      cleanupAdmissionId: ADMISSION_ID,
      cleanupBlockerCode: 'CLEANUP_UNIT_STOP_FAILED',
      cleanupBlocker: BLOCKER,
      cleanupLeaseStatus: status,
      cleanupLeaseExpiresAt: STALE,
      cleanupLeaseBlockerCode: 'CLEANUP_UNIT_STOP_FAILED',
      cleanupLeaseBlocker: BLOCKER,
    }));

    await expect(value.service.recover({ jobId: JOB_ID, retry: false, at: NOW })).resolves.toEqual({
      kind: 'retry-blocked',
      jobId: JOB_ID,
      admissionId: ADMISSION_ID,
      generation: 3,
      blockerCode: 'CLEANUP_UNIT_STOP_FAILED',
    });
    expect(value.inspector.inspect).not.toHaveBeenCalled();
  });

  it('binds corrected retry to the persisted blocker and fresh cleanup snapshot', async () => {
    const blocked = recoveryJob({
      cleanupFenceGeneration: 3,
      cleanupAdmissionId: ADMISSION_ID,
      cleanupBlockerCode: 'CLEANUP_UNIT_STOP_FAILED',
      cleanupBlocker: BLOCKER,
      cleanupLeaseStatus: 'failed',
      cleanupLeaseExpiresAt: STALE,
      cleanupLeaseBlockerCode: 'CLEANUP_UNIT_STOP_FAILED',
      cleanupLeaseBlocker: BLOCKER,
    });
    const value = fixture(blocked, cleanupInspection());

    await expect(value.service.recover({ jobId: JOB_ID, retry: true, at: NOW })).resolves.toEqual({
      kind: 'cleanup-pending',
      jobId: JOB_ID,
      admissionId: NEXT_ADMISSION_ID,
      generation: 4,
    });
    expect(value.recovery.retryCorrectedAndStart).toHaveBeenCalledWith({
      jobId: JOB_ID,
      admissionId: ADMISSION_ID,
      owner: 'api-recovery-test',
      expiresAt: EXPIRES,
      snapshot: cleanupSnapshot(),
      correctedSnapshot: cleanupSnapshot(),
      expectedBlockerCode: 'CLEANUP_UNIT_STOP_FAILED',
      expectedBlocker: BLOCKER,
      at: NOW,
    });
  });

  it.each([
    ['job ID', { ...directInspection(), jobId: 'other-job' }],
    ['state', { ...directInspection(), state: 'source' }],
    ['inspection time', { ...directInspection(), at: STALE }],
  ] as const)('fails closed on mismatched inspector %s', async (_case, inspection) => {
    const value = fixture(recoveryJob(), inspection as ApiRecoveryInspection);

    await expect(value.service.recover({ jobId: JOB_ID, retry: false, at: NOW }))
      .rejects.toBeInstanceOf(ApiRecoveryBoundaryError);
    expect(value.ownership.apiWrite).not.toHaveBeenCalled();
  });

  it('fails closed when direct interruption loses its ownership CAS', async () => {
    const value = fixture();
    value.ownership.apiWrite.mockReturnValueOnce({
      ok: false,
      conflict: { kind: 'stale-predecessor', message: 'job moved' },
    });

    await expect(value.service.recover({ jobId: JOB_ID, retry: false, at: NOW }))
      .rejects.toThrow('direct interruption CAS rejected');
  });

  it('fails closed when cleanup admission result is not reflected by durable state', async () => {
    const value = fixture(recoveryJob(), cleanupInspection());
    value.recovery.admitAndStart.mockImplementationOnce(async () => ({
      admissionId: ADMISSION_ID,
      generation: 1,
      unitName: `osi-image-builder-cleanup@${ADMISSION_ID}.service`,
      credentialRelativePath: `recovery/cleanup-credentials/${ADMISSION_ID}.token`,
      credentialSha256: 'a'.repeat(64),
      rotated: false,
      started: true as const,
    }));

    await expect(value.service.recover({ jobId: JOB_ID, retry: false, at: NOW }))
      .rejects.toThrow('durable cleanup fence does not match');
  });

  it('admits cleanup for an interrupted job that still has physical cleanup work', async () => {
    const snapshot = cleanupSnapshot('interrupted');
    const value = fixture(recoveryJob({
      state: 'interrupted',
      queueState: 'complete',
      terminalAt: STALE,
      terminalErrorCode: 'RUNNER_DISAPPEARED',
      terminalError: { reason: 'runner disappeared' },
    }), cleanupInspection(snapshot));

    await expect(value.service.recover({ jobId: JOB_ID, retry: false, at: NOW })).resolves.toEqual({
      kind: 'cleanup-pending',
      jobId: JOB_ID,
      admissionId: ADMISSION_ID,
      generation: 1,
    });
    expect(value.recovery.admitAndStart).toHaveBeenCalledWith(expect.objectContaining({
      jobId: JOB_ID,
      snapshot,
    }));
  });
});
