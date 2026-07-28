import { describe, expect, it, vi } from 'vitest';

import {
  classifyCleanupLeaseForStartup,
  reconcileCleanupAdmissionAtStartup,
  type CleanupLeaseStartupClassification,
} from '../../api/src/recovery.js';
import {
  STARTUP_PHASES,
  createStartupCoordinator,
  type StartupPhaseResult,
} from '../../api/src/startup-order.js';

const NOW = '2026-07-28T10:00:00.000Z';
const FUTURE = '2026-07-28T10:01:00.000Z';
const EXPIRED = '2026-07-28T09:59:00.000Z';

function clear(): StartupPhaseResult {
  return { blockers: [] };
}

describe('startup reconciliation order', () => {
  it('runs migrations through dispatch in the exact required order and records phase events', async () => {
    const calls: string[] = [];
    const phase = (name: string): (() => Promise<StartupPhaseResult>) => async () => {
      calls.push(name);
      return clear();
    };
    const target = createStartupCoordinator({
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
      migrations: async () => clear(),
      cleanupAdmissions: async () => clear(),
      liveRunnerClassification: async () => clear(),
      stalePublishingRecovery: async () => ({ blockers: blocked ? [{ code: 'UNVERIFIED_FINAL_PATH_BLOCKER', jobId: 'job-publish' }] : [] }),
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
  ] as const)('classifies %s as %s', (_name, status, active, expiresAt, expected: CleanupLeaseStartupClassification) => {
    expect(classifyCleanupLeaseForStartup({ status, active, expiresAt, now: NOW })).toBe(expected);
  });

  it('does not classify stop failure as replacement-eligible', () => {
    expect(classifyCleanupLeaseForStartup({ status: 'claimed', active: true, expiresAt: EXPIRED, now: NOW, stopFailure: true })).toBe('blocked');
  });

  it('delegates eligible rotation to the existing recovery coordinator and never writes for a deferral', async () => {
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
      expiresAt: EXPIRED,
      snapshot: {} as never,
      status: 'claimed' as const,
      active: false,
      now: NOW,
      at: NOW,
    };
    await expect(reconcileCleanupAdmissionAtStartup(input, { reconcileAndStart })).resolves.toMatchObject({ action: 'rotated', classification: 'rotate' });
    expect(reconcileAndStart).toHaveBeenCalledOnce();

    reconcileAndStart.mockClear();
    await expect(reconcileCleanupAdmissionAtStartup({ ...input, active: true, expiresAt: FUTURE }, { reconcileAndStart })).resolves.toMatchObject({ action: 'deferred', classification: 'defer' });
    expect(reconcileAndStart).not.toHaveBeenCalled();
  });
});
