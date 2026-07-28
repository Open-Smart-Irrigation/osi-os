import { describe, expect, it, vi } from 'vitest';

import {
  classifyCleanupLeaseForStartup,
  reconcileCleanupAdmissionAtStartup,
  type CleanupLeaseStartupClassification,
} from '../../api/src/recovery.js';
import {
  STARTUP_PHASES,
  createStartupBootstrap,
  createStartupCoordinator,
  type StartupPhaseResult,
} from '../../api/src/startup-order.js';
import type { QueueBlocker, QueueStartupGate } from '../../api/src/queue.js';

const NOW = '2026-07-28T10:00:00.000Z';
const FUTURE = '2026-07-28T10:01:00.000Z';
const EXPIRED = '2026-07-28T09:59:00.000Z';

function clear(): StartupPhaseResult {
  return { blockers: [] };
}

function startupGate(): QueueStartupGate {
  return {
    beginStartupReconciliation: vi.fn(),
    completeStartupReconciliation: vi.fn(),
  };
}

describe('startup reconciliation order', () => {
  it('binds a fail-closed queue behind one production startup boundary', async () => {
    const phases: string[] = [];
    const phase = (name: string) => async (): Promise<StartupPhaseResult> => {
      phases.push(name);
      return clear();
    };
    const bootstrap = createStartupBootstrap({
      queue: {
        db: {
          prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(() => undefined) })),
        },
        ownership: { apiWrite: vi.fn(() => ({ ok: true, kind: 'committed', eventSeq: 1, value: undefined })) } as never,
        systemd: {
          inspect: vi.fn(async (unit: string) => ({ unit, active: false, pending: false, observedAt: NOW })),
          start: vi.fn(async (unit: string) => ({ unit, argv: ['systemctl', '--user', 'start', unit], exitCode: 0, timedOut: false })),
        },
        safety: { inspect: vi.fn(async () => null) },
        clock: { now: () => NOW },
      },
      services: {
        migrations: phase('migrations'),
        cleanupAdmissions: phase('cleanup-admissions'),
        liveRunnerClassification: phase('live-runner-classification'),
        stalePublishingRecovery: phase('stale-publishing-recovery'),
        nonPublishingInterruption: phase('non-publishing-interruption'),
        retention: phase('retention'),
      },
    });

    await expect(bootstrap.start()).resolves.toMatchObject({ dispatched: true, blockers: [] });
    expect(phases).toEqual(STARTUP_PHASES.slice(0, -1));
    expect(bootstrap.events().map((event) => event.phase)).toEqual([...STARTUP_PHASES]);
  });

  it('runs migrations through dispatch in the exact required order and records phase events', async () => {
    const calls: string[] = [];
    const phase = (name: string): (() => Promise<StartupPhaseResult>) => async () => {
      calls.push(name);
      return clear();
    };
    const target = createStartupCoordinator({
      queueGate: startupGate(),
      migrations: phase('migrations'),
      cleanupAdmissions: phase('cleanup-admissions'),
      liveRunnerClassification: phase('live-runner-classification'),
      stalePublishingRecovery: phase('stale-publishing-recovery'),
      nonPublishingInterruption: phase('non-publishing-interruption'),
      retention: phase('retention'),
      dispatch: phase('dispatch'),
    });

    await expect(target.start()).resolves.toMatchObject({ dispatched: true, blockers: [] });
    expect(calls).toEqual([...STARTUP_PHASES]);
    expect(target.events().map((event) => event.phase)).toEqual([...STARTUP_PHASES]);
    expect(target.events().every((event) => event.status === 'completed')).toBe(true);
  });

  it('does not dispatch while an earlier recovery phase reports a blocker', async () => {
    const dispatch = vi.fn(async () => clear());
    const target = createStartupCoordinator({
      queueGate: startupGate(),
      migrations: async () => clear(),
      cleanupAdmissions: async () => clear(),
      liveRunnerClassification: async () => ({ blockers: [{ code: 'CLEANUP_UNIT_STOP_FAILED', details: { jobId: 'job-a' } }] }),
      stalePublishingRecovery: async () => clear(),
      nonPublishingInterruption: async () => clear(),
      retention: async () => clear(),
      dispatch,
    });

    await expect(target.start()).resolves.toMatchObject({ dispatched: false, blockers: [{ code: 'CLEANUP_UNIT_STOP_FAILED' }] });
    expect(dispatch).not.toHaveBeenCalled();
    expect(target.events().map((event) => event.phase)).toEqual([
      'migrations', 'cleanup-admissions', 'live-runner-classification',
      'stale-publishing-recovery', 'non-publishing-interruption', 'retention',
    ]);
  });

  it('keeps retention as an injected phase and dispatches after a later retry clears blockers', async () => {
    let blocked = true;
    const dispatch = vi.fn(async () => clear());
    const target = createStartupCoordinator({
      queueGate: startupGate(),
      migrations: async () => clear(),
      cleanupAdmissions: async () => clear(),
      liveRunnerClassification: async () => clear(),
      stalePublishingRecovery: async () => ({ blockers: blocked ? [{ code: 'UNVERIFIED_FINAL_PATH_BLOCKER', details: { jobId: 'job-publish' } }] : [] }),
      nonPublishingInterruption: async () => clear(),
      retention: async () => clear(),
      dispatch,
    });

    await target.start();
    blocked = false;
    await expect(target.start()).resolves.toMatchObject({ dispatched: true, blockers: [] });
    expect(dispatch).toHaveBeenCalledOnce();
  });
});

describe('cleanup lease startup classification', () => {
  it.each([
    ['claimed active and unexpired', 'claimed', true, FUTURE, 'defer'],
    ['claimed inactive and unexpired', 'claimed', false, FUTURE, 'rotate'],
    ['claimed inactive and expired', 'claimed', false, EXPIRED, 'rotate'],
    ['claimed active and expired', 'claimed', true, EXPIRED, 'stop-and-rotate'],
    ['admitted inactive and unexpired', 'admitted', false, FUTURE, 'start'],
  ] as const)('classifies %s as %s', (_name, status, active, predecessorExpiresAt, expected: CleanupLeaseStartupClassification) => {
    expect(classifyCleanupLeaseForStartup({ status, active, predecessorExpiresAt, now: NOW })).toBe(expected);
  });

  it('does not classify a persisted stop blocker as replacement-eligible', async () => {
    const reconcileAndStart = vi.fn();
    await expect(reconcileCleanupAdmissionAtStartup({
      jobId: 'job-a', admissionId: 'cln_00000000000000000000000000', owner: 'api',
      predecessorExpiresAt: EXPIRED, replacementExpiresAt: FUTURE, snapshot: {} as never,
      status: 'blocking', active: true,
      unitName: 'osi-image-builder-cleanup@cln_00000000000000000000000000.service',
      observedUnitName: 'osi-image-builder-cleanup@cln_00000000000000000000000000.service',
      blocker: { code: 'CLEANUP_UNIT_STOP_FAILED', details: { failure: 'still-active' } }, now: NOW, at: NOW,
    }, { reconcileAndStart })).resolves.toMatchObject({ action: 'blocked', blocker: { code: 'CLEANUP_UNIT_STOP_FAILED' } });
    expect(reconcileAndStart).not.toHaveBeenCalled();
  });

  it('uses the future replacement expiry when rotating an expired predecessor', async () => {
    const reconcileAndStart = vi.fn(async () => ({
      admissionId: 'cln_00000000000000000000000001',
      generation: 2,
      unitName: 'osi-image-builder-cleanup@cln_00000000000000000000000001.service',
      credentialRelativePath: 'recovery/cleanup-credentials/cln_00000000000000000000000001.token',
      credentialSha256: 'a'.repeat(64),
      rotated: true,
      started: true as const,
    }));
    const input = {
      jobId: 'job-a',
      admissionId: 'cln_00000000000000000000000000',
      owner: 'api',
      predecessorExpiresAt: EXPIRED,
      replacementExpiresAt: FUTURE,
      snapshot: {} as never,
      status: 'claimed' as const,
      active: false,
      unitName: 'osi-image-builder-cleanup@cln_00000000000000000000000000.service',
      observedUnitName: 'osi-image-builder-cleanup@cln_00000000000000000000000000.service',
      now: NOW,
      at: NOW,
    };
    await expect(reconcileCleanupAdmissionAtStartup(input, { reconcileAndStart })).resolves.toMatchObject({ action: 'rotated', classification: 'rotate' });
    expect(reconcileAndStart).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: FUTURE }));
  });

  it('validates the exact persisted unit before deferring an active unexpired worker', async () => {
    const reconcileAndStart = vi.fn();
    const input = {
      jobId: 'job-a',
      admissionId: 'cln_00000000000000000000000000',
      owner: 'api',
      predecessorExpiresAt: FUTURE,
      replacementExpiresAt: '2026-07-28T10:02:00.000Z',
      snapshot: {} as never,
      status: 'claimed' as const,
      active: true,
      unitName: 'osi-image-builder-cleanup@cln_00000000000000000000000000.service',
      observedUnitName: 'osi-image-builder-cleanup@cln_00000000000000000000000000.service',
      now: NOW,
      at: NOW,
    };
    await expect(reconcileCleanupAdmissionAtStartup(input, { reconcileAndStart })).resolves.toMatchObject({ action: 'deferred', classification: 'defer' });
    expect(reconcileAndStart).not.toHaveBeenCalled();

    await expect(reconcileCleanupAdmissionAtStartup({
      ...input,
      observedUnitName: 'osi-image-builder-cleanup@cln_00000000000000000000000001.service',
    }, { reconcileAndStart })).rejects.toThrow('persisted cleanup unit');
  });

  it('routes completed admissions to hand-back and preserves failed/blocking evidence', async () => {
    const handBackCompleted = vi.fn(async () => ({
      jobId: 'job-a',
      admissionId: 'cln_00000000000000000000000000',
      state: 'interrupted' as const,
      handedBack: true,
      started: false as const,
    }));
    const reconcileAndStart = vi.fn();
    const base = {
      jobId: 'job-a',
      admissionId: 'cln_00000000000000000000000000',
      owner: 'api',
      predecessorExpiresAt: EXPIRED,
      replacementExpiresAt: FUTURE,
      snapshot: {} as never,
      active: false,
      unitName: 'osi-image-builder-cleanup@cln_00000000000000000000000000.service',
      observedUnitName: 'osi-image-builder-cleanup@cln_00000000000000000000000000.service',
      now: NOW,
      at: NOW,
    };
    await expect(reconcileCleanupAdmissionAtStartup(
      { ...base, status: 'completed' },
      { reconcileAndStart, handBackCompleted },
    )).resolves.toMatchObject({ action: 'handed-back' });
    expect(handBackCompleted).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-a' }));

    const persisted: QueueBlocker = { code: 'QUARANTINE_PENDING', details: { path: 'quarantine/job-a' } };
    await expect(reconcileCleanupAdmissionAtStartup(
      { ...base, status: 'blocking', blocker: persisted },
      { reconcileAndStart, handBackCompleted },
    )).resolves.toMatchObject({ action: 'blocked', blocker: persisted });
    expect(reconcileAndStart).not.toHaveBeenCalled();
  });

  it('never delegates a failed stop to rotation', async () => {
    const reconcileAndStart = vi.fn();
    const result = await reconcileCleanupAdmissionAtStartup({
      jobId: 'job-a',
      admissionId: 'cln_00000000000000000000000000',
      owner: 'api',
      predecessorExpiresAt: EXPIRED,
      replacementExpiresAt: FUTURE,
      snapshot: {} as never,
      status: 'blocking',
      active: true,
      unitName: 'osi-image-builder-cleanup@cln_00000000000000000000000000.service',
      observedUnitName: 'osi-image-builder-cleanup@cln_00000000000000000000000000.service',
      blocker: { code: 'CLEANUP_UNIT_STOP_FAILED', details: { failure: 'still-active' } },
      now: NOW,
      at: NOW,
    }, { reconcileAndStart });
    expect(result).toMatchObject({ action: 'blocked' });
    reconcileAndStart.mockClear();
    expect(reconcileAndStart).not.toHaveBeenCalled();
  });
});
