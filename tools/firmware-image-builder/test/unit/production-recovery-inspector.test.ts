import { describe, expect, it, vi } from 'vitest';

import type { CleanupSnapshot, DirectInterruptionProof } from '../../api/src/ownership.js';
import {
  ProductionRecoveryInspectionError,
  createProductionRecoveryInspector,
  type PhysicalRecoveryObservation,
} from '../../api/src/production-recovery-inspector.js';
import type { RecoveryJobRecord } from '../../api/src/store.js';

const NOW = '2026-07-29T10:00:00.000Z';
const BEFORE = '2026-07-29T09:59:59.000Z';
const STALE = '2026-07-29T09:55:00.000Z';
const FUTURE = '2026-07-29T10:05:00.000Z';
const JOB_ID = 'physical-recovery';
const RUNNER_UNIT = `osi-image-builder-runner@${JOB_ID}.service`;
const ADMISSION_ID = 'cln_0123456789abcdefghjkmnpqrs';
const CLEANUP_UNIT = `osi-image-builder-cleanup@${ADMISSION_ID}.service`;

function job(overrides: Partial<RecoveryJobRecord> = {}): RecoveryJobRecord {
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

function directProof(overrides: Partial<Extract<DirectInterruptionProof, { kind: 'active' }>> = {}): DirectInterruptionProof {
  return {
    kind: 'active',
    runnerUnit: RUNNER_UNIT,
    runnerLeaseOwner: 'runner-owner',
    runnerLeaseExpiresAt: STALE,
    leaseStaleAt: NOW,
    unitInactiveAt: NOW,
    container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: NOW },
    staging: { kind: 'absent', path: null },
    logs: {
      runner: 'absent',
      docker: 'absent',
      verifiedAt: NOW,
      generationIdentity: { runner: [], docker: [] },
    },
    blocker: 'none',
    cleanupAdmission: null,
    cleanupFence: null,
    ...overrides,
  };
}

function cleanupSnapshot(overrides: Partial<CleanupSnapshot> = {}): CleanupSnapshot {
  return {
    runner: {
      unit: RUNNER_UNIT,
      owner: 'runner-owner',
      leaseExpiresAt: STALE,
      inactiveAt: NOW,
      observedAt: NOW,
    },
    state: 'building',
    container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: NOW },
    staging: { kind: 'physical-present', path: `staging/${JOB_ID}`, sha256: null, size: null, observedAt: NOW },
    logs: { runner: 'sealed', docker: 'sealed', verifiedAt: NOW },
    blocker: 'staging-or-log',
    ...overrides,
  };
}

function observation(overrides: Partial<PhysicalRecoveryObservation> = {}): PhysicalRecoveryObservation {
  return {
    jobId: JOB_ID,
    state: 'building',
    startedAt: BEFORE,
    finishedAt: NOW,
    runner: {
      unit: RUNNER_UNIT,
      activity: 'inactive',
      observedAt: NOW,
    },
    cleanup: null,
    directProof: directProof(),
    cleanupSnapshot: null,
    ...overrides,
  };
}

function fixture(physical = observation()) {
  const inspect = vi.fn(async () => physical);
  return {
    inspect,
    inspector: createProductionRecoveryInspector({ physical: { inspect } }),
  };
}

describe('production API recovery inspector', () => {
  it('leaves an active or activating runner untouched', async () => {
    const value = fixture(observation({
      runner: { unit: RUNNER_UNIT, activity: 'active', observedAt: NOW },
      directProof: null,
    }));

    await expect(value.inspector.inspect({ job: job(), retry: false, at: NOW })).resolves.toEqual({
      kind: 'not-eligible',
      jobId: JOB_ID,
      state: 'building',
      at: NOW,
    });
  });

  it('creates a bound direct-interruption command only from a residue-free inactive proof', async () => {
    const value = fixture();

    await expect(value.inspector.inspect({ job: job(), retry: false, at: NOW })).resolves.toEqual({
      kind: 'direct',
      jobId: JOB_ID,
      state: 'building',
      at: NOW,
      command: {
        kind: 'direct-interrupt',
        jobId: JOB_ID,
        expectedState: 'building',
        at: NOW,
        proof: directProof(),
        errorCode: 'RUNNER_DISAPPEARED',
        error: { reason: 'fresh physical recovery inspection found the runner inactive without cleanup residue' },
      },
    });
  });

  it('uses SERVICE_START_FAILED for a failed starting unit with a matching start proof', async () => {
    const proof: DirectInterruptionProof = {
      kind: 'start-failure',
      runnerUnit: RUNNER_UNIT,
      startAttemptedAt: BEFORE,
      unitInactiveAt: NOW,
      runnerLeaseOwner: null,
      runnerLeaseExpiresAt: null,
      container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: NOW },
      staging: { kind: 'absent', path: null },
      logs: {
        runner: 'absent',
        docker: 'absent',
        verifiedAt: NOW,
        generationIdentity: { runner: [], docker: [] },
      },
      blocker: 'none',
      cleanupAdmission: null,
      cleanupFence: null,
    };
    const value = fixture(observation({ state: 'starting', directProof: proof }));

    await expect(value.inspector.inspect({
      job: job({ state: 'starting' }),
      retry: false,
      at: NOW,
    })).resolves.toMatchObject({
      kind: 'direct',
      command: { errorCode: 'SERVICE_START_FAILED', proof },
    });
  });

  it('routes residual staging, container, or logs through cleanup admission', async () => {
    const snapshot = cleanupSnapshot();
    const value = fixture(observation({ directProof: null, cleanupSnapshot: snapshot }));

    await expect(value.inspector.inspect({ job: job(), retry: false, at: NOW })).resolves.toEqual({
      kind: 'cleanup',
      jobId: JOB_ID,
      state: 'building',
      at: NOW,
      snapshot,
    });
  });

  it('returns cleanup progress only for the exact active unexpired admission', async () => {
    const value = fixture(observation({
      cleanup: {
        admissionId: ADMISSION_ID,
        generation: 3,
        unit: CLEANUP_UNIT,
        activity: 'active',
        observedAt: NOW,
      },
      directProof: null,
    }));

    await expect(value.inspector.inspect({
      job: job({
        cleanupFenceGeneration: 3,
        cleanupAdmissionId: ADMISSION_ID,
        cleanupLeaseStatus: 'claimed',
        cleanupLeaseExpiresAt: FUTURE,
      }),
      retry: false,
      at: NOW,
    })).resolves.toEqual({
      kind: 'cleanup-in-progress',
      jobId: JOB_ID,
      state: 'building',
      at: NOW,
      admissionId: ADMISSION_ID,
      generation: 3,
    });
  });

  it('rejects ignored recovery proof attached to an active cleanup observation', async () => {
    const value = fixture(observation({
      cleanup: {
        admissionId: ADMISSION_ID,
        generation: 3,
        unit: CLEANUP_UNIT,
        activity: 'active',
        observedAt: NOW,
      },
    }));

    await expect(value.inspector.inspect({
      job: job({
        cleanupFenceGeneration: 3,
        cleanupAdmissionId: ADMISSION_ID,
        cleanupLeaseStatus: 'claimed',
        cleanupLeaseExpiresAt: FUTURE,
      }),
      retry: false,
      at: NOW,
    })).rejects.toThrow('cleanup progress contains unused recovery proof');
  });

  it('returns a fresh cleanup snapshot when the fenced cleanup unit is inactive', async () => {
    const snapshot = cleanupSnapshot();
    const value = fixture(observation({
      cleanup: {
        admissionId: ADMISSION_ID,
        generation: 3,
        unit: CLEANUP_UNIT,
        activity: 'inactive',
        observedAt: NOW,
      },
      directProof: null,
      cleanupSnapshot: snapshot,
    }));

    await expect(value.inspector.inspect({
      job: job({
        cleanupFenceGeneration: 3,
        cleanupAdmissionId: ADMISSION_ID,
        cleanupLeaseStatus: 'claimed',
        cleanupLeaseExpiresAt: STALE,
      }),
      retry: false,
      at: NOW,
    })).resolves.toMatchObject({ kind: 'cleanup', snapshot });
  });

  it('treats an interrupted job with no physical residue as not eligible', async () => {
    const value = fixture(observation({
      state: 'interrupted',
      directProof: null,
      cleanupSnapshot: null,
    }));

    await expect(value.inspector.inspect({
      job: job({
        state: 'interrupted',
        queueState: 'complete',
        terminalAt: BEFORE,
        terminalErrorCode: 'RUNNER_DISAPPEARED',
        terminalError: { reason: 'already interrupted' },
      }),
      retry: false,
      at: NOW,
    })).resolves.toMatchObject({ kind: 'not-eligible', state: 'interrupted' });
  });

  it('never returns a second direct interruption for an interrupted job', async () => {
    const value = fixture(observation({ state: 'interrupted' }));

    await expect(value.inspector.inspect({
      job: job({
        state: 'interrupted',
        queueState: 'complete',
        terminalAt: BEFORE,
        terminalErrorCode: 'RUNNER_DISAPPEARED',
        terminalError: { reason: 'already interrupted' },
      }),
      retry: false,
      at: NOW,
    })).rejects.toThrow('interrupted job cannot use direct recovery proof');
  });

  it('binds direct runner inactivity to the unit observation used by the decision', async () => {
    const value = fixture(observation({
      runner: { unit: RUNNER_UNIT, activity: 'inactive', observedAt: NOW },
      directProof: directProof({ unitInactiveAt: BEFORE }),
    }));

    await expect(value.inspector.inspect({ job: job(), retry: false, at: NOW }))
      .rejects.toThrow('direct proof does not match the runner observation');
  });

  it.each([
    ['wrong job', observation({ jobId: 'other-job' })],
    ['wrong state', observation({ state: 'verifying' })],
    ['observation after request', observation({ finishedAt: FUTURE })],
    ['observation before it started', observation({ startedAt: NOW, finishedAt: BEFORE })],
    ['wrong runner unit', observation({ runner: { unit: 'osi-image-builder-runner@other.service', activity: 'inactive', observedAt: NOW } })],
    ['ambiguous proof pair', observation({ cleanupSnapshot: cleanupSnapshot() })],
  ] as const)('rejects a %s physical observation', async (_name, physical) => {
    const value = fixture(physical);

    await expect(value.inspector.inspect({ job: job(), retry: false, at: NOW }))
      .rejects.toBeInstanceOf(ProductionRecoveryInspectionError);
  });

  it('rejects cleanup progress that does not match the durable admission identity', async () => {
    const value = fixture(observation({
      cleanup: {
        admissionId: 'cln_1123456789abcdefghjkmnpqrs',
        generation: 4,
        unit: 'osi-image-builder-cleanup@cln_1123456789abcdefghjkmnpqrs.service',
        activity: 'active',
        observedAt: NOW,
      },
      directProof: null,
    }));

    await expect(value.inspector.inspect({
      job: job({
        cleanupFenceGeneration: 3,
        cleanupAdmissionId: ADMISSION_ID,
        cleanupLeaseStatus: 'claimed',
        cleanupLeaseExpiresAt: FUTURE,
      }),
      retry: false,
      at: NOW,
    })).rejects.toThrow('cleanup observation does not match the durable fence');
  });
});
