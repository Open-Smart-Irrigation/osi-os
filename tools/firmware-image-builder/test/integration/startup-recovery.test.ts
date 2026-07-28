import { describe, expect, it, vi } from 'vitest';

import { createQueueCoordinator } from '../../api/src/queue.js';
import { createStartupCoordinator, type StartupPhaseResult } from '../../api/src/startup-order.js';

const NOW = '2026-07-28T10:00:00.000Z';
function clear(): StartupPhaseResult {
  return { blockers: [] };
}

function queueFixture() {
  const ownership = { apiWrite: vi.fn(() => ({ ok: true, kind: 'committed', eventSeq: 1, value: undefined })) } as never;
  const db = {
    prepare: vi.fn((sql: string) => ({
      all: vi.fn(() => sql.includes('queue_entries') ? [] : []),
      get: vi.fn(() => undefined),
    })),
  };
  const systemd = {
    inspect: vi.fn(async (unit: string) => ({ unit, active: false, pending: false, observedAt: NOW })),
    start: vi.fn(async (unit: string) => ({ unit, argv: ['systemctl', '--user', 'start', unit], exitCode: 0, timedOut: false })),
    listActive: vi.fn(async () => [] as readonly string[]),
  };
  const queue = createQueueCoordinator({
    db,
    ownership,
    systemd,
    safety: { inspect: vi.fn(async () => null) },
    clock: { now: () => NOW },
  });
  return { queue, systemd };
}

describe('startup recovery integration boundary', () => {
  it('keeps dispatch closed by default when no startup coordinator completes', async () => {
    const fixture = queueFixture();
    await expect(fixture.queue.dispatchNext()).resolves.toMatchObject({
      kind: 'blocked',
      reason: 'STARTUP_RECONCILIATION_INCOMPLETE',
    });
    expect(fixture.systemd.start).not.toHaveBeenCalled();
  });

  it('holds the queue gate through cleanup-worker recovery and direct interruption blockers', async () => {
    const fixture = queueFixture();
    const phases: string[] = [];
    const recoveryBlocker = { code: 'RUNNER_DISAPPEARED', details: { jobId: 'job-1' } };
    const phase = (name: string, result: StartupPhaseResult = clear()) => async () => {
      phases.push(name);
      return result;
    };
    const startup = createStartupCoordinator({
      queueGate: fixture.queue,
      migrations: phase('migrations'),
      cleanupAdmissions: phase('cleanup-admissions', { blockers: [{ code: 'CLEANUP_ADMISSION_BLOCKED', details: { jobId: 'job-cleanup' } }] }),
      liveRunnerClassification: phase('live-runner-classification'),
      stalePublishingRecovery: phase('stale-publishing-recovery'),
      nonPublishingInterruption: phase('non-publishing-interruption', { blockers: [recoveryBlocker] }),
      retention: phase('retention'),
      dispatch: async () => {
        phases.push('dispatch');
        return clear();
      },
    });

    await expect(startup.start()).resolves.toMatchObject({ dispatched: false });
    await expect(fixture.queue.dispatchNext()).resolves.toMatchObject({ kind: 'blocked', reason: 'CLEANUP_ADMISSION_BLOCKED' });
    expect(phases).not.toContain('dispatch');
    expect(fixture.systemd.start).not.toHaveBeenCalled();
  });

  it('opens the queue only after stale publishing, interruption proof, and retention clear', async () => {
    const fixture = queueFixture();
    const startup = createStartupCoordinator({
      queueGate: fixture.queue,
      migrations: async () => clear(),
      cleanupAdmissions: async () => clear(),
      liveRunnerClassification: async () => clear(),
      stalePublishingRecovery: async () => clear(),
      nonPublishingInterruption: async () => clear(),
      retention: async () => clear(),
      dispatch: async () => clear(),
    });

    await expect(startup.start()).resolves.toMatchObject({ dispatched: true });
    await expect(fixture.queue.dispatchNext()).resolves.toMatchObject({ kind: 'idle' });
  });
});
