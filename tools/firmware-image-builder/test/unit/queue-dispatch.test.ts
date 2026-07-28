import { describe, expect, it, vi } from 'vitest';

import { createQueueCoordinator, type QueueSystemd } from '../../api/src/queue.js';

const NOW = '2026-07-28T10:00:00.000Z';
const LATER = '2026-07-28T10:00:01.000Z';
const AFTER = '2026-07-28T10:00:02.000Z';
const BEFORE = '2026-07-28T09:59:59.000Z';
const UNIT = 'osi-image-builder-runner@job-1.service';

function proof() {
  return {
    kind: 'start-failure' as const, runnerUnit: UNIT, startAttemptedAt: NOW, unitInactiveAt: LATER,
    runnerLeaseOwner: null, runnerLeaseExpiresAt: null,
    container: { kind: 'absent' as const, globalLabelResult: 'no-match' as const, observedAt: LATER },
    staging: { kind: 'absent' as const, path: null },
    logs: { runner: 'absent' as const, docker: 'absent' as const, verifiedAt: LATER, generationIdentity: { runner: [], docker: [] } },
    blocker: 'none' as const, cleanupAdmission: null, cleanupFence: null,
  };
}

function row(state = 'starting'): Record<string, unknown> {
  return {
    job_id: 'job-1', state, queue_state: state === 'starting' ? 'dispatched' : 'queued', runner_unit: UNIT,
    dispatched_at: NOW,
    runner_lease_owner: null, runner_lease_expires_at: null, cleanup_blocker_code: null,
    cleanup_fence_generation: null, cleanup_admission_id: null, container_id: null,
    container_name: null, container_image_digest: null, container_label_job_id: null,
    container_label_manifest_sha: null, container_labels_json: null, artifact_staging_path: null,
    artifact_quarantine_path: null, artifact_quarantine_intent_path: null, publish_blocker_code: null,
  };
}

function coordinator(overrides: Record<string, unknown> = {}) {
  const databaseBlockerJobId = overrides.databaseBlockerJobId as string | (() => string | undefined) | undefined;
  const queueOverrides = { ...overrides };
  delete queueOverrides.databaseBlockerJobId;
  const ownership = { apiWrite: vi.fn(() => ({ ok: true, kind: 'committed', eventSeq: 1, value: undefined as void } as const)) };
  const systemd: {
    inspect: ReturnType<typeof vi.fn<QueueSystemd['inspect']>>;
    start: ReturnType<typeof vi.fn<QueueSystemd['start']>>;
    listActive: ReturnType<typeof vi.fn<NonNullable<QueueSystemd['listActive']>>>;
  } = {
    inspect: vi.fn(async (unit: string) => ({ unit, active: false, observedAt: NOW })),
    start: vi.fn(async (unit: string) => ({ unit, argv: ['systemctl', '--user', 'start', unit], exitCode: 0, timedOut: false })),
    listActive: vi.fn(async () => [] as readonly string[]),
  };
  const db = {
    prepare: vi.fn((sql: string) => ({
      all: vi.fn(() => sql.includes('queue_entries') ? [{ ...row('queued'), state: 'queued', queue_state: 'queued' }] : []),
      get: vi.fn(() => {
        if (sql.startsWith('SELECT * FROM jobs')) return row();
        if (!sql.includes('SELECT job_id FROM jobs') || databaseBlockerJobId === undefined) return undefined;
        const value = typeof databaseBlockerJobId === 'function' ? databaseBlockerJobId() : databaseBlockerJobId;
        return value === undefined ? undefined : { job_id: value };
      }),
    })),
  };
  return {
    ownership, systemd, db,
    queue: createQueueCoordinator({
      db, ownership, systemd, safety: { inspect: vi.fn(async () => null) },
      directInterrupt: vi.fn(async () => proof()), clock: { now: () => NOW }, ...queueOverrides,
    }),
  };
}

describe('FIFO queue dispatch', () => {
  it('claims the oldest queued job and starts only after a fresh active observation', async () => {
    const target = coordinator();
    target.systemd.inspect
      .mockResolvedValueOnce({ unit: UNIT, active: false, observedAt: NOW })
      .mockResolvedValueOnce({ unit: UNIT, active: true, observedAt: NOW });

    await expect(target.queue.dispatchNext()).resolves.toEqual({ kind: 'started', jobId: 'job-1', runnerUnit: UNIT });
    expect(target.ownership.apiWrite).toHaveBeenCalledWith(expect.objectContaining({ kind: 'dispatch', jobId: 'job-1', runnerUnit: UNIT }));
    expect(target.systemd.start).toHaveBeenCalledWith(UNIT);
  });

  it.each([
    ['missing safety checks', { safety: undefined }],
    ['missing systemd active listing', { systemd: { inspect: vi.fn(), start: vi.fn() } }],
  ])('fails closed with %s', async (_label, override) => {
    const target = coordinator(override as never);
    await expect(target.queue.dispatchNext()).resolves.toMatchObject({ kind: 'blocked' });
    expect(target.ownership.apiWrite).not.toHaveBeenCalled();
    expect(target.systemd.start).not.toHaveBeenCalled();
  });

  it('fails closed when required database methods are absent', async () => {
    const target = coordinator({ db: { prepare: vi.fn(() => ({ get: vi.fn(() => undefined) })) } });
    await expect(target.queue.dispatchNext()).resolves.toMatchObject({ kind: 'blocked' });
    expect(target.ownership.apiWrite).not.toHaveBeenCalled();
  });

  it('fails closed on throwing, malformed, and unbounded active-runner listings', async () => {
    for (const listActive of [
      vi.fn(async () => { throw new Error('systemd unavailable'); }),
      vi.fn(async () => ['not-a-runner.service']),
      vi.fn(async () => Array.from({ length: 100 }, () => UNIT)),
    ]) {
      const target = coordinator({ systemd: { ...coordinator().systemd, listActive } });
      await expect(target.queue.dispatchNext()).resolves.toMatchObject({ kind: 'blocked' });
      expect(target.ownership.apiWrite).not.toHaveBeenCalled();
    }
  });

  it('does not synthesize direct proof when the trusted verifier is absent, null, or throws', async () => {
    for (const directInterrupt of [undefined, vi.fn(async () => null), vi.fn(async () => { throw new Error('proof unavailable'); })]) {
      const target = coordinator({ directInterrupt } as never);
      target.systemd.start.mockResolvedValue({ unit: UNIT, argv: ['systemctl', '--user', 'start', UNIT], exitCode: 1, timedOut: false });
      await expect(target.queue.dispatchNext()).resolves.toMatchObject({ kind: 'recovery-blocked', jobId: 'job-1' });
      expect(target.ownership.apiWrite).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'runner-recovery-blocker', blockerCode: 'SERVICE_START_FAILED' }));
      expect(target.ownership.apiWrite).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'direct-interrupt' }));
    }
  });

  it('rejects observations outside their canonical systemd bracket and out of chronology', async () => {
    const outside = coordinator({ directInterrupt: vi.fn(async () => null) });
    outside.systemd.inspect.mockResolvedValue({ unit: UNIT, active: false, observedAt: LATER });
    await expect(outside.queue.dispatchNext()).resolves.toMatchObject({ kind: 'blocked', reason: 'INVALID_SYSTEMD_OBSERVATION' });
    expect(outside.systemd.start).not.toHaveBeenCalled();

    const clock = vi.fn().mockReturnValue(AFTER);
    const chronological = coordinator({ clock: { now: clock } });
    chronological.systemd.inspect
      .mockResolvedValueOnce({ unit: UNIT, active: false, observedAt: LATER })
      .mockResolvedValueOnce({ unit: UNIT, active: true, observedAt: NOW });
    await expect(chronological.queue.dispatchNext()).resolves.toMatchObject({ kind: 'blocked', reason: 'INVALID_SYSTEMD_OBSERVATION' });
    expect(chronological.systemd.start).not.toHaveBeenCalled();
  });

  it('never starts after a final safety or active-runner blocker appears after claim', async () => {
    const safety = vi.fn(async ({ phase }: { phase: string }) => phase === 'before-start' ? { code: 'LATE_BLOCKER' } : null);
    const target = coordinator({ safety: { inspect: safety } });
    const safetyOutcome = await target.queue.dispatchNext();
    expect(safetyOutcome).toMatchObject({ kind: expect.stringMatching(/^(interrupted|recovery-blocked)$/), jobId: 'job-1' });
    expect(target.systemd.start).not.toHaveBeenCalled();

    const lateList = coordinator();
    lateList.systemd.listActive.mockResolvedValueOnce([]).mockResolvedValueOnce([UNIT]);
    await expect(lateList.queue.dispatchNext()).resolves.toMatchObject({ kind: 'interrupted', jobId: 'job-1' });
    expect(lateList.systemd.start).not.toHaveBeenCalled();
  });

  it('requires final safety and active-list checks immediately before start', async () => {
    const events: string[] = [];
    let inspectCount = 0;
    const target = coordinator({
      safety: { inspect: vi.fn(async ({ phase }: { phase: string }) => { events.push(`safety:${phase}`); return null; }) },
      systemd: {
        inspect: vi.fn(async (unit: string) => { inspectCount += 1; events.push('inspect'); return { unit, active: inspectCount >= 3, observedAt: NOW }; }),
        listActive: vi.fn(async () => { events.push('list-active'); return []; }),
        start: vi.fn(async (unit: string) => { events.push('start'); return { unit, argv: ['systemctl', '--user', 'start', unit], exitCode: 0, timedOut: false }; }),
      },
    });
    await target.queue.dispatchNext();
    const startIndex = events.lastIndexOf('start');
    expect(events[startIndex - 1]).toBe('list-active');
    expect(events[startIndex - 2]).toBe('safety:before-start');
  });

  it('recovers instead of returning started when post-start observation is not fresh and active', async () => {
    const target = coordinator({ directInterrupt: vi.fn(async () => null) });
    target.systemd.inspect.mockResolvedValue({ unit: UNIT, active: false, observedAt: NOW });
    await expect(target.queue.dispatchNext()).resolves.toMatchObject({ kind: 'recovery-blocked', jobId: 'job-1' });
    expect(target.systemd.start).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['throw', async (target: ReturnType<typeof coordinator>) => { target.systemd.start.mockRejectedValue(new Error('start failed')); }],
    ['nonzero', async (target: ReturnType<typeof coordinator>) => { target.systemd.start.mockResolvedValue({ unit: UNIT, argv: ['systemctl', '--user', 'start', UNIT], exitCode: 1, timedOut: false }); }],
    ['timeout', async (target: ReturnType<typeof coordinator>) => { target.systemd.start.mockResolvedValue({ unit: UNIT, argv: ['systemctl', '--user', 'start', UNIT], exitCode: null, timedOut: true }); }],
    ['signal', async (target: ReturnType<typeof coordinator>) => { target.systemd.start.mockResolvedValue({ unit: UNIT, argv: ['systemctl', '--user', 'start', UNIT], exitCode: null, timedOut: false, signal: 'SIGTERM' }); }],
    ['malformed result', async (target: ReturnType<typeof coordinator>) => { target.systemd.start.mockResolvedValue({ unit: UNIT, argv: [] } as never); }],
  ])('recovers a start %s without claiming another job', async (_label, configure) => {
    const target = coordinator({ directInterrupt: vi.fn(async () => proof()) });
    await configure(target);
    target.systemd.inspect
      .mockResolvedValueOnce({ unit: UNIT, active: false, observedAt: NOW })
      .mockResolvedValueOnce({ unit: UNIT, active: false, observedAt: NOW });

    await expect(target.queue.dispatchNext()).resolves.toMatchObject({ kind: 'interrupted', jobId: 'job-1' });
    expect(target.systemd.start).toHaveBeenCalledTimes(1);
    expect(target.ownership.apiWrite).toHaveBeenCalledWith(expect.objectContaining({ kind: 'direct-interrupt', jobId: 'job-1' }));
    expect(target.ownership.apiWrite).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'dispatch', jobId: 'second' }));
  });

  it.each([
    ['inactive', { unit: UNIT, active: false, observedAt: NOW }],
    ['malformed', {}],
    ['stale', { unit: UNIT, active: true, observedAt: BEFORE }],
  ])('recovers after a post-start %s observation', async (_label, postStart) => {
    const target = coordinator({ directInterrupt: vi.fn(async () => proof()) });
    target.systemd.inspect
      .mockResolvedValueOnce({ unit: UNIT, active: false, observedAt: NOW })
      .mockResolvedValueOnce(postStart as never)
      .mockResolvedValueOnce({ unit: UNIT, active: false, observedAt: NOW });

    await expect(target.queue.dispatchNext()).resolves.toMatchObject({ kind: 'interrupted', jobId: 'job-1' });
    expect(target.systemd.start).toHaveBeenCalledTimes(1);
  });

  it('rejects a second same-coordinator dispatch while the first start is in flight', async () => {
    let releaseStart: (() => void) | undefined;
    const startFinished = new Promise<void>((resolve) => { releaseStart = resolve; });
    const target = coordinator();
    target.systemd.start.mockImplementation(async (unit) => {
      await startFinished;
      return { unit, argv: ['systemctl', '--user', 'start', unit], exitCode: 0, timedOut: false };
    });
    target.systemd.inspect.mockResolvedValueOnce({ unit: UNIT, active: false, observedAt: NOW }).mockResolvedValueOnce({ unit: UNIT, active: true, observedAt: NOW });
    const first = target.queue.dispatchNext();
    await vi.waitFor(() => expect(target.systemd.start).toHaveBeenCalledTimes(1));
    await expect(target.queue.dispatchNext()).resolves.toEqual({ kind: 'blocked', reason: 'dispatcher already has an in-flight claim' });
    releaseStart!();
    await expect(first).resolves.toMatchObject({ kind: 'started', jobId: 'job-1' });
    expect(target.systemd.start).toHaveBeenCalledTimes(1);
  });

  it.each([
    'cleanup_fence_generation', 'cleanup_admission_id', 'cleanup_blocker_code',
    'container_id', 'container_name', 'container_image_digest', 'container_label_job_id',
    'container_label_manifest_sha', 'container_labels_json', 'artifact_staging_path',
    'artifact_quarantine_path', 'artifact_quarantine_intent_path', 'publish_blocker_code',
    'unsealed-log',
  ])('fails closed for the persisted %s blocker before claim', async (_blocker) => {
    const target = coordinator({ databaseBlockerJobId: 'job-2' });
    await expect(target.queue.dispatchNext()).resolves.toMatchObject({ kind: 'blocked', reason: 'SQLITE_QUEUE_BLOCKER' });
    expect(target.systemd.start).not.toHaveBeenCalled();
  });

  it('rechecks the database blocker after claiming and before systemd.start', async () => {
    let databaseReads = 0;
    const late = coordinator({ databaseBlockerJobId: () => databaseReads++ >= 1 ? 'job-2' : undefined, directInterrupt: vi.fn(async () => proof()) });
    late.systemd.inspect
      .mockResolvedValueOnce({ unit: UNIT, active: false, observedAt: NOW })
      .mockResolvedValueOnce({ unit: UNIT, active: false, observedAt: NOW });
    await expect(late.queue.dispatchNext()).resolves.toMatchObject({ kind: expect.stringMatching(/^(interrupted|recovery-blocked)$/), jobId: 'job-1' });
    expect(late.systemd.start).not.toHaveBeenCalled();
  });
});
