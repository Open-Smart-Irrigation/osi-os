import { describe, expect, it, vi } from 'vitest';
import type { JobRecord, JsonObject } from '../../api/src/store.js';
import type { ApiWriteCommand, OwnershipResult } from '../../api/src/ownership.js';
import type { CommandResult } from '../../runner/src/command-executor.js';
import {
  createApiCancellationService,
  createSystemdCancellationAdapter,
  requestCancellation,
  type ApiCancellationClock,
  type ApiCancellationSystemd,
} from '../../api/src/cancellation.js';

const JOB_ID = 'job-api-cancel';
const UNIT = `osi-image-builder-runner@${JOB_ID}.service`;
const OTHER_UNIT = 'osi-image-builder-runner@other-job.service';
const AT = '2026-07-27T12:00:00.000Z';
const LEASE_EXPIRY = '2026-07-27T12:10:00.000Z';

type MutableJob = Pick<JobRecord,
  'jobId' | 'state' | 'cancelRequestedAt' | 'cancelReason' | 'runnerUnit' |
  'runnerLeaseOwner' | 'runnerLeaseExpiresAt' | 'terminalAt' | 'terminalErrorCode' |
  'terminalError' | 'queueState' | 'queuePosition' | 'cancellationCooperativeDeadlineAt' |
  'cancellationEscalationOwner' | 'cancellationEscalationLeaseExpiresAt' |
  'cancellationStopIntentAt' | 'cancellationGraceDeadlineAt' |
  'cancellationSignalObservation' | 'cancellationStopObservation' |
  'cancellationInspectionObservations' | 'cancellationClockHighWaterAt' |
  'cancellationStopAuthorizedAt' | 'cancellationStopAuthorizedLeaseExpiresAt' |
  'cleanupBlockerCode' | 'cleanupBlocker'>;

function job(overrides: Partial<MutableJob> = {}): MutableJob {
  const value: MutableJob = {
    jobId: JOB_ID,
    state: 'building',
    cancelRequestedAt: null,
    cancelReason: null,
    cancellationCooperativeDeadlineAt: null,
    cancellationEscalationOwner: null,
    cancellationEscalationLeaseExpiresAt: null,
    cancellationStopIntentAt: null,
    cancellationGraceDeadlineAt: null,
    cancellationSignalObservation: null,
    cancellationStopObservation: null,
    cancellationInspectionObservations: null,
    cancellationClockHighWaterAt: null,
    cancellationStopAuthorizedAt: null,
    cancellationStopAuthorizedLeaseExpiresAt: null,
    cleanupBlockerCode: null,
    cleanupBlocker: null,
    runnerUnit: UNIT,
    runnerLeaseOwner: 'runner-api-test',
    runnerLeaseExpiresAt: LEASE_EXPIRY,
    terminalAt: null,
    terminalErrorCode: null,
    terminalError: null,
    queueState: 'dispatched',
    queuePosition: null,
    ...overrides,
  };
  if (value.cancelRequestedAt !== null) {
    return {
      ...value,
      cancellationCooperativeDeadlineAt: overrides.cancellationCooperativeDeadlineAt
        ?? new Date(Date.parse(value.cancelRequestedAt) + 30_000).toISOString(),
      cancellationClockHighWaterAt: overrides.cancellationClockHighWaterAt ?? value.cancelRequestedAt,
    };
  }
  return value;
}

function result(eventSeq = 1): OwnershipResult {
  return { ok: true, kind: 'committed', eventSeq, value: undefined };
}

function observation(active: boolean, overrides: Partial<{
  readonly commandOutcome: 'completed' | 'timed-out' | 'transport-error';
  readonly activity: 'active' | 'inactive' | 'unknown';
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}> = {}) {
  return {
    commandOutcome: 'completed' as const,
    activity: active ? 'active' as const : 'inactive' as const,
    argv: [],
    exitCode: active ? 0 : 3,
    signal: null,
    stdout: active ? 'active\n' : 'inactive\n',
    stderr: '',
    timedOut: false,
    ...overrides,
  };
}

function fakeClock(
  onSleep?: (monotonic: number) => void,
  wallStart = AT,
): ApiCancellationClock & { readonly monotonic: () => number } {
  let monotonic = 0;
  const wallStartMilliseconds = Date.parse(wallStart);
  return {
    now: () => new Date(wallStartMilliseconds + monotonic).toISOString(),
    monotonicNow: () => monotonic,
    monotonic: () => monotonic,
    sleep: async (milliseconds) => {
      monotonic += milliseconds;
      onSleep?.(monotonic);
    },
  };
}

type TestSystemd = {
  signalCancellation: ApiCancellationSystemd['signalCancellation'];
  stopRunner: ApiCancellationSystemd['stopRunner'];
  inspectRunner: ApiCancellationSystemd['inspectRunner'];
  readonly signals: string[];
  readonly stops: string[];
  readonly statuses: string[];
};

function fakeSystemd(overrides: Partial<TestSystemd> = {}): TestSystemd {
  const signals: string[] = [];
  const stops: string[] = [];
  const statuses: string[] = [];
  return {
    signals,
    stops,
    statuses,
    signalCancellation: async (unit, deadline) => {
      signals.push(`${unit}:${deadline}`);
      return observation(true, { activity: 'unknown' });
    },
    stopRunner: async (unit, deadline) => {
      stops.push(`${unit}:${deadline}`);
      return observation(true, { activity: 'unknown' });
    },
    inspectRunner: async (unit, deadline) => {
      statuses.push(`${unit}:${deadline}`);
      return observation(true);
    },
    ...overrides,
  };
}

function coordinatorFixture(initial: MutableJob, systemd: TestSystemd, clock: ApiCancellationClock) {
  let current = initial;
  const writes: ApiWriteCommand[] = [];
  const store = {
    getJob: vi.fn(() => current as unknown as JobRecord),
  };
  const ownership = {
    apiWrite: vi.fn((command: ApiWriteCommand) => {
      writes.push(command);
      if (command.kind === 'request-cancellation') {
        current = {
          ...current,
          cancelRequestedAt: command.at,
          cancelReason: command.reason,
          cancellationCooperativeDeadlineAt: command.cooperativeDeadlineAt ?? null,
          cancellationClockHighWaterAt: command.at,
        };
      } else if (command.kind === 'initialize-cancellation-coordination') {
        current = {
          ...current,
          cancellationCooperativeDeadlineAt: command.cooperativeDeadlineAt,
          cancellationClockHighWaterAt: current.cancellationClockHighWaterAt ?? command.at,
        };
      } else if (command.kind === 'observe-cancellation-clock') {
        if (current.cancellationClockHighWaterAt !== command.expectedHighWaterAt) {
          return { ok: false as const, conflict: { kind: 'cas-lost' as const, message: 'clock high-water changed' } };
        }
        current = { ...current, cancellationClockHighWaterAt: command.observedAt };
      } else if (command.kind === 'record-cancellation-signal') {
        if (current.state === 'cancelled' || current.state === 'failed' || current.state === 'succeeded' || current.state === 'interrupted' || current.state === 'publishing') {
          return { ok: false as const, conflict: { kind: 'cas-lost' as const, message: 'state changed' } };
        }
        current = { ...current, cancellationSignalObservation: command.observation };
      } else if (command.kind === 'claim-cancellation-escalation') {
        if (current.cancellationStopIntentAt !== null) {
          return { ok: false as const, conflict: { kind: 'cas-lost' as const, message: 'already claimed' } };
        }
        current = {
          ...current,
          cancellationEscalationOwner: command.escalationOwner,
          cancellationEscalationLeaseExpiresAt: command.escalationLeaseExpiresAt,
          cancellationStopIntentAt: command.stopIntentAt,
          cancellationGraceDeadlineAt: command.graceDeadlineAt,
        };
      } else if (command.kind === 'authorize-cancellation-stop') {
        if (
          current.cancellationClockHighWaterAt !== command.expectedHighWaterAt
          || current.runnerLeaseExpiresAt !== command.observedLeaseExpiresAt
        ) return { ok: false as const, conflict: { kind: 'cas-lost' as const, message: 'stop authorization changed' } };
        current = {
          ...current,
          cancellationStopAuthorizedAt: command.authorizedAt,
          cancellationStopAuthorizedLeaseExpiresAt: command.observedLeaseExpiresAt,
        };
      } else if (command.kind === 'record-cancellation-stop') {
        current = { ...current, cancellationStopObservation: command.observation };
      } else if (command.kind === 'record-cancellation-inspection') {
        const observations = current.cancellationInspectionObservations?.observations;
        current = {
          ...current,
          cancellationInspectionObservations: {
            observations: [...(Array.isArray(observations) ? observations : []), command.observation],
          },
        };
      } else if (command.kind === 'cancellation-recovery-blocker') {
        if (
          current.state !== command.expectedState
          || current.cancelRequestedAt !== command.cancelRequestedAt
          || current.runnerUnit !== command.observedRunnerUnit
          || current.runnerLeaseOwner !== command.observedOwner
          || current.runnerLeaseExpiresAt !== command.observedLeaseExpiresAt
        ) return { ok: false as const, conflict: { kind: 'identity-mismatch' as const, message: 'stale observation' } };
        if (current.cleanupBlocker !== null) return result(writes.length);
        current = { ...current, cleanupBlockerCode: 'RUNNER_DISAPPEARED', cleanupBlocker: command.blocker };
      }
      return result(writes.length);
    }),
  };
  return {
    store,
    ownership,
    writes,
    systemd,
    clock,
    setJob: (next: MutableJob) => { current = next; },
    getJob: () => current,
  };
}

describe('API cancellation coordination', () => {
  it('persists an active request before signalling the exact runner unit', async () => {
    const fixture = coordinatorFixture(job({ state: 'building' }), fakeSystemd(), fakeClock());
    fixture.systemd.signalCancellation = async (unit) => {
      expect(fixture.writes[0]).toMatchObject({ kind: 'request-cancellation', jobId: JOB_ID });
      expect(unit).toBe(UNIT);
      fixture.setJob(job({ state: 'cancelled', cancelRequestedAt: AT, cancelReason: 'operator', terminalAt: AT, terminalErrorCode: 'CANCELLED', terminalError: { reason: 'operator' }, queueState: 'complete' }));
      return observation(true);
    };

    const outcome = await requestCancellation({
      store: fixture.store,
      ownership: fixture.ownership,
      systemd: fixture.systemd,
      clock: fixture.clock,
    }, { jobId: JOB_ID, reason: 'operator', at: AT });

    expect(outcome).toMatchObject({ kind: 'runner-terminal', state: 'cancelled', runnerOwned: true });
    expect(fixture.writes.filter((write) => write.kind === 'request-cancellation')).toHaveLength(1);
    expect(fixture.writes.some((write) => write.kind === 'direct-interrupt')).toBe(false);
    expect(fixture.systemd.stops).toHaveLength(0);
  });

  it('re-signals an already cancel_requested runner without duplicating the API request', async () => {
    const fixture = coordinatorFixture(job({ state: 'cancel_requested', cancelRequestedAt: AT, cancelReason: 'operator' }), fakeSystemd(), fakeClock());
    fixture.systemd.signalCancellation = async (unit) => {
      fixture.systemd.signals.push(`${unit}:0`);
      expect(unit).toBe(UNIT);
      fixture.setJob(job({ state: 'cancelled', cancelRequestedAt: AT, cancelReason: 'operator', terminalAt: AT, terminalErrorCode: 'CANCELLED', terminalError: { reason: 'operator' }, queueState: 'complete' }));
      return observation(true);
    };

    const outcome = await requestCancellation({
      store: fixture.store,
      ownership: fixture.ownership,
      systemd: fixture.systemd,
      clock: fixture.clock,
    }, { jobId: JOB_ID, reason: 'operator-retry', at: AT });

    expect(outcome).toMatchObject({ kind: 'runner-terminal', state: 'cancelled' });
    expect(fixture.writes.filter((write) => write.kind === 'request-cancellation')).toHaveLength(0);
    expect(fixture.systemd.signals).toHaveLength(1);
  });

  it('records the signal observation when the same runner renews its lease in flight', async () => {
    const fixture = coordinatorFixture(job(), fakeSystemd(), fakeClock());
    fixture.systemd.signalCancellation = async (unit, deadline) => {
      fixture.systemd.signals.push(`${unit}:${deadline}`);
      fixture.setJob({
        ...fixture.getJob(),
        runnerLeaseExpiresAt: '2026-07-27T12:11:00.000Z',
      });
      return observation(true, { activity: 'unknown' });
    };

    await requestCancellation({
      store: fixture.store,
      ownership: fixture.ownership,
      systemd: fixture.systemd,
      clock: fixture.clock,
      cooperativeTimeoutMs: 0,
      systemdGraceMs: 0,
    }, { jobId: JOB_ID, reason: 'operator', at: AT });

    expect(fixture.writes.find((write) => write.kind === 'record-cancellation-signal')).toMatchObject({
      runnerUnit: UNIT,
      observedOwner: 'runner-api-test',
      observedLeaseExpiresAt: '2026-07-27T12:11:00.000Z',
    });
    expect(fixture.getJob().cancellationSignalObservation).not.toBeNull();
  });

  it('uses one monotonic 30-second cooperative deadline and avoids stop when the runner commits at the boundary', async () => {
    const clock = fakeClock((monotonic) => {
      if (monotonic >= 30_000) {
        fixture.setJob(job({ state: 'cancelled', cancelRequestedAt: AT, cancelReason: 'operator', terminalAt: AT, terminalErrorCode: 'CANCELLED', terminalError: { reason: 'operator' }, queueState: 'complete' }));
      }
    });
    const systemd = fakeSystemd();
    const fixture = coordinatorFixture(job(), systemd, clock);
    systemd.signalCancellation = async (_unit, deadline) => {
      expect(deadline).toBe(30_000);
      return observation(true);
    };

    const outcome = await requestCancellation({
      store: fixture.store,
      ownership: fixture.ownership,
      systemd,
      clock,
      pollIntervalMs: 10_000,
    }, { jobId: JOB_ID, reason: 'operator', at: AT });

    expect(outcome).toMatchObject({ kind: 'runner-terminal', state: 'cancelled' });
    expect(clock.monotonic()).toBe(30_000);
    expect(systemd.stops).toHaveLength(0);
  });

  it('blocks without signalling when wall time is behind the durable cancellation high-water', async () => {
    const fixture = coordinatorFixture(
      job({ state: 'building' }),
      fakeSystemd(),
      fakeClock(undefined, '2026-07-27T11:59:59.000Z'),
    );

    const outcome = await requestCancellation({
      store: fixture.store,
      ownership: fixture.ownership,
      systemd: fixture.systemd,
      clock: fixture.clock,
    }, { jobId: JOB_ID, reason: 'operator', at: AT });

    expect(outcome).toMatchObject({
      kind: 'recovery-blocked',
      evidence: expect.objectContaining({
        kind: 'api-cancellation-clock-regression',
        observedAt: '2026-07-27T11:59:59.000Z',
        highWaterAt: AT,
      }),
    });
    expect(fixture.systemd.signals).toHaveLength(0);
    expect(fixture.systemd.stops).toHaveLength(0);
  });

  it('detects partial wall-clock rollback after progress without recreating cooperative budget', async () => {
    let monotonic = 0;
    let wall = Date.parse(AT);
    const rollbackClock: ApiCancellationClock = {
      now: () => new Date(wall).toISOString(),
      monotonicNow: () => monotonic,
      sleep: async (milliseconds) => {
        monotonic += milliseconds;
        wall += milliseconds;
        if (monotonic >= 20_000) wall = Date.parse('2026-07-27T12:00:05.000Z');
      },
    };
    const fixture = coordinatorFixture(job(), fakeSystemd(), rollbackClock);

    const outcome = await requestCancellation({
      store: fixture.store,
      ownership: fixture.ownership,
      systemd: fixture.systemd,
      clock: rollbackClock,
      pollIntervalMs: 10_000,
    }, { jobId: JOB_ID, reason: 'operator', at: AT });

    expect(outcome).toMatchObject({
      kind: 'recovery-blocked',
      evidence: expect.objectContaining({
        kind: 'api-cancellation-clock-regression',
        observedAt: '2026-07-27T12:00:05.000Z',
        highWaterAt: '2026-07-27T12:00:10.000Z',
      }),
    });
    expect(fixture.systemd.signals).toHaveLength(1);
    expect(fixture.systemd.stops).toHaveLength(0);
  });

  it('derives retry budget from the durable cancellation instant instead of resetting thirty seconds', async () => {
    const fixture = coordinatorFixture(job({
      state: 'cancel_requested',
      cancelRequestedAt: AT,
      cancelReason: 'operator',
      cancellationCooperativeDeadlineAt: '2026-07-27T12:00:30.000Z',
    }), fakeSystemd(), fakeClock(undefined, '2026-07-27T12:00:29.000Z'));

    await requestCancellation({
      store: fixture.store,
      ownership: fixture.ownership,
      systemd: fixture.systemd,
      clock: fixture.clock,
      systemdGraceMs: 0,
    }, { jobId: JOB_ID, reason: 'retry', at: '2026-07-27T12:00:29.000Z' });

    expect(fixture.systemd.signals[0]).toBe(`${UNIT}:1000`);
  });

  it('allows concurrent retries to share one durable stop escalation intent', async () => {
    const fixture = coordinatorFixture(job({
      state: 'cancel_requested',
      cancelRequestedAt: AT,
      cancelReason: 'operator',
      cancellationCooperativeDeadlineAt: '2026-07-27T12:00:30.000Z',
    }), fakeSystemd(), fakeClock(undefined, '2026-07-27T12:00:31.000Z'));
    const options = {
      store: fixture.store,
      ownership: fixture.ownership,
      systemd: fixture.systemd,
      clock: fixture.clock,
      cooperativeTimeoutMs: 0,
      systemdGraceMs: 0,
    };

    await Promise.all([
      requestCancellation(options, { jobId: JOB_ID, reason: 'retry-one', at: '2026-07-27T12:00:31.000Z' }),
      requestCancellation(options, { jobId: JOB_ID, reason: 'retry-two', at: '2026-07-27T12:00:31.000Z' }),
    ]);

    expect(fixture.systemd.stops).toHaveLength(1);
  });

  it('stops exactly the persisted unit after cooperative expiry, then records a blocker after the 15-second grace without inferring a terminal state', async () => {
    const clock = fakeClock();
    const systemd = fakeSystemd({
      stopRunner: async (unit, deadline) => {
        systemd.stops.push(`${unit}:${deadline}`);
        expect(unit).toBe(UNIT);
        expect(deadline).toBe(45_000);
        return observation(true, { stderr: 'stop requested' });
      },
      inspectRunner: async (unit, deadline) => {
        systemd.statuses.push(`${unit}:${deadline}`);
        expect(unit).toBe(UNIT);
        expect(deadline).toBe(45_000);
        return observation(true);
      },
    });
    const fixture = coordinatorFixture(job(), systemd, clock);

    const outcome = await requestCancellation({
      store: fixture.store,
      ownership: fixture.ownership,
      systemd,
      clock,
      pollIntervalMs: 5_000,
    }, { jobId: JOB_ID, reason: 'operator', at: AT });

    expect(outcome).toMatchObject({ kind: 'recovery-blocked', state: 'building', blockerCode: 'RUNNER_DISAPPEARED' });
    expect(fixture.getJob().state).toBe('building');
    expect(systemd.stops).toHaveLength(1);
    expect(fixture.writes.filter((write) => write.kind === 'claim-cancellation-escalation')).toHaveLength(1);
    expect(fixture.writes.find((write) => write.kind === 'cancellation-recovery-blocker')).toMatchObject({
      kind: 'cancellation-recovery-blocker',
      jobId: JOB_ID,
      observedRunnerUnit: UNIT,
      expectedState: 'building',
      observedOwner: 'runner-api-test',
      observedLeaseExpiresAt: LEASE_EXPIRY,
      blocker: expect.objectContaining({
        runnerUnit: UNIT,
        systemd: expect.objectContaining({
          stop: expect.objectContaining({ stderr: 'stop requested' }),
        }),
      }),
    });
  });

  it('returns a runner terminal result during systemd grace and never writes an API terminal', async () => {
    const clock = fakeClock();
    const systemd = fakeSystemd();
    const fixture = coordinatorFixture(job(), systemd, clock);
    systemd.stopRunner = async () => {
      systemd.stops.push(UNIT);
      fixture.setJob(job({ state: 'failed', cancelRequestedAt: AT, cancelReason: 'operator', terminalAt: AT, terminalErrorCode: 'BUILD_FAILED', terminalError: { reason: 'runner finished' }, queueState: 'complete' }));
      return observation(false);
    };

    const outcome = await requestCancellation({
      store: fixture.store,
      ownership: fixture.ownership,
      systemd,
      clock,
    }, { jobId: JOB_ID, reason: 'operator', at: AT });

    expect(outcome).toMatchObject({ kind: 'runner-terminal', state: 'failed', runnerOwned: true });
    expect(fixture.writes.filter((write) => write.kind === 'request-cancellation')).toHaveLength(1);
    expect(fixture.writes.some((write) => write.kind === 'direct-interrupt')).toBe(false);
    expect(fixture.writes.some((write) => write.kind === 'cancellation-recovery-blocker')).toBe(false);
  });

  it('does not stop when the runner commits terminal state immediately after stop-intent ownership', async () => {
    const fixture = coordinatorFixture(job(), fakeSystemd(), fakeClock());
    const originalWrite = fixture.ownership.apiWrite;
    fixture.ownership.apiWrite = vi.fn((command: ApiWriteCommand) => {
      const write = originalWrite(command);
      if (command.kind === 'claim-cancellation-escalation' && write.ok) {
        fixture.setJob(job({
          state: 'cancelled',
          cancelRequestedAt: AT,
          cancelReason: 'operator',
          terminalAt: '2026-07-27T12:00:30.000Z',
          terminalErrorCode: 'CANCELLED',
          terminalError: { reason: 'operator' },
          queueState: 'complete',
          cancellationEscalationOwner: command.escalationOwner,
          cancellationEscalationLeaseExpiresAt: command.escalationLeaseExpiresAt,
          cancellationStopIntentAt: command.stopIntentAt,
          cancellationGraceDeadlineAt: command.graceDeadlineAt,
        }));
      }
      return write;
    });

    const outcome = await requestCancellation({
      store: fixture.store,
      ownership: fixture.ownership,
      systemd: fixture.systemd,
      clock: fixture.clock,
      pollIntervalMs: 30_000,
    }, { jobId: JOB_ID, reason: 'operator', at: AT });

    expect(outcome).toMatchObject({ kind: 'runner-terminal', state: 'cancelled' });
    expect(fixture.systemd.stops).toHaveLength(0);
    expect(fixture.systemd.statuses).toHaveLength(0);
  });

  it('does not inspect or block when the runner commits terminal state at the stop boundary', async () => {
    const systemd = fakeSystemd();
    const fixture = coordinatorFixture(job(), systemd, fakeClock());
    systemd.stopRunner = async (unit, deadline) => {
      systemd.stops.push(`${unit}:${deadline}`);
      fixture.setJob(job({
        state: 'cancelled',
        cancelRequestedAt: AT,
        cancelReason: 'operator',
        terminalAt: '2026-07-27T12:00:30.000Z',
        terminalErrorCode: 'CANCELLED',
        terminalError: { reason: 'operator' },
        queueState: 'complete',
      }));
      return observation(false, { activity: 'unknown' });
    };

    const outcome = await requestCancellation({
      store: fixture.store,
      ownership: fixture.ownership,
      systemd,
      clock: fixture.clock,
      pollIntervalMs: 30_000,
    }, { jobId: JOB_ID, reason: 'operator', at: AT });

    expect(outcome).toMatchObject({ kind: 'runner-terminal', state: 'cancelled' });
    expect(systemd.stops).toHaveLength(1);
    expect(systemd.statuses).toHaveLength(0);
    expect(fixture.writes.some((write) => write.kind === 'cancellation-recovery-blocker')).toBe(false);
  });

  it('fails closed with evidence when the persisted runner unit is missing or mismatched', async () => {
    for (const runnerUnit of [null, OTHER_UNIT]) {
      const fixture = coordinatorFixture(job({ runnerUnit }), fakeSystemd(), fakeClock());
      const outcome = await requestCancellation({
        store: fixture.store,
        ownership: fixture.ownership,
        systemd: fixture.systemd,
        clock: fixture.clock,
      }, { jobId: JOB_ID, reason: 'operator', at: AT });

      expect(outcome).toMatchObject({ kind: 'recovery-blocked', blockerCode: 'RUNNER_DISAPPEARED', evidence: expect.objectContaining({ requestedAt: AT, persistedRunnerUnit: runnerUnit }) });
      expect(fixture.systemd.signals).toHaveLength(0);
      expect(fixture.systemd.stops).toHaveLength(0);
    }
  });

  it('fails closed on a missing or stale runner lease without signalling a possibly different owner', async () => {
    for (const lease of [
      { runnerLeaseOwner: null, runnerLeaseExpiresAt: null },
      { runnerLeaseOwner: 'runner-api-test', runnerLeaseExpiresAt: '2026-07-27T11:59:59.000Z' },
    ]) {
      const fixture = coordinatorFixture(job(lease), fakeSystemd(), fakeClock());
      const outcome = await requestCancellation({
        store: fixture.store,
        ownership: fixture.ownership,
        systemd: fixture.systemd,
        clock: fixture.clock,
      }, { jobId: JOB_ID, reason: 'operator', at: AT });

      expect(outcome).toMatchObject({ kind: 'recovery-blocked', blockerCode: 'RUNNER_DISAPPEARED', evidence: expect.objectContaining({ reason: expect.stringMatching(/lease/i) }) });
      expect(fixture.systemd.signals).toHaveLength(0);
      expect(fixture.systemd.stops).toHaveLength(0);
    }
  });

  it('fails closed when the runner lease identity changes before systemd escalation', async () => {
    let leaseChanged = false;
    const systemd = fakeSystemd();
    let fixture: ReturnType<typeof coordinatorFixture>;
    const clock = fakeClock((monotonic) => {
      if (!leaseChanged && monotonic >= 30_000) {
        leaseChanged = true;
        fixture.setJob(job({
          cancelRequestedAt: AT,
          cancelReason: 'operator',
          runnerLeaseOwner: 'runner-replaced',
          runnerLeaseExpiresAt: '2026-07-27T12:20:00.000Z',
        }));
      }
    });
    fixture = coordinatorFixture(job(), systemd, clock);

    const outcome = await requestCancellation({
      store: fixture.store,
      ownership: fixture.ownership,
      systemd,
      clock,
      pollIntervalMs: 10_000,
    }, { jobId: JOB_ID, reason: 'operator', at: AT });

    expect(outcome).toMatchObject({
      kind: 'recovery-blocked',
      evidence: expect.objectContaining({ reason: expect.stringMatching(/lease identity/i) }),
    });
    expect(systemd.stops).toHaveLength(0);
  });

  it('rechecks lease liveness at a fresh wall-clock instant immediately before stop', async () => {
    const clock = fakeClock();
    const systemd = fakeSystemd();
    const fixture = coordinatorFixture(job({
      runnerLeaseExpiresAt: '2026-07-27T12:00:20.000Z',
    }), systemd, clock);

    const outcome = await requestCancellation({
      store: fixture.store,
      ownership: fixture.ownership,
      systemd,
      clock,
      pollIntervalMs: 10_000,
    }, { jobId: JOB_ID, reason: 'operator', at: AT });

    expect(outcome).toMatchObject({
      kind: 'recovery-blocked',
      evidence: expect.objectContaining({ reason: expect.stringMatching(/expired before systemd escalation/i) }),
    });
    expect(systemd.stops).toHaveLength(0);
    expect(fixture.getJob().cleanupBlockerCode).toBe('RUNNER_DISAPPEARED');
  });

  it('accepts same-owner lease renewal and authorizes stop against the fresh extended expiry', async () => {
    let renewed = false;
    let fixture: ReturnType<typeof coordinatorFixture>;
    const clock = fakeClock((monotonic) => {
      if (!renewed && monotonic >= 20_000) {
        renewed = true;
        fixture.setJob(job({
          cancelRequestedAt: AT,
          cancelReason: 'operator',
          cancellationClockHighWaterAt: '2026-07-27T12:00:10.000Z',
          runnerLeaseExpiresAt: '2026-07-27T12:11:00.000Z',
        }));
      }
    });
    fixture = coordinatorFixture(job(), fakeSystemd(), clock);

    await requestCancellation({
      store: fixture.store,
      ownership: fixture.ownership,
      systemd: fixture.systemd,
      clock,
      pollIntervalMs: 10_000,
      systemdGraceMs: 0,
    }, { jobId: JOB_ID, reason: 'operator', at: AT });

    expect(fixture.systemd.stops).toHaveLength(1);
    expect(fixture.writes.find((write) => write.kind === 'authorize-cancellation-stop')).toMatchObject({
      runnerUnit: UNIT,
      observedOwner: 'runner-api-test',
      observedLeaseExpiresAt: '2026-07-27T12:11:00.000Z',
    });
    expect(fixture.getJob()).toMatchObject({
      cancellationStopAuthorizedAt: '2026-07-27T12:00:30.000Z',
      cancellationStopAuthorizedLeaseExpiresAt: '2026-07-27T12:11:00.000Z',
    });
  });

  it('accepts same-owner lease renewal immediately after stop authorization', async () => {
    const fixture = coordinatorFixture(job(), fakeSystemd(), fakeClock());
    const originalWrite = fixture.ownership.apiWrite;
    fixture.ownership.apiWrite = vi.fn((command: ApiWriteCommand) => {
      const write = originalWrite(command);
      if (command.kind === 'authorize-cancellation-stop' && write.ok) {
        fixture.setJob({
          ...fixture.getJob(),
          runnerLeaseExpiresAt: '2026-07-27T12:11:00.000Z',
        });
      }
      return write;
    });

    await requestCancellation({
      store: fixture.store,
      ownership: fixture.ownership,
      systemd: fixture.systemd,
      clock: fixture.clock,
      pollIntervalMs: 30_000,
      systemdGraceMs: 0,
    }, { jobId: JOB_ID, reason: 'operator', at: AT });

    expect(fixture.systemd.stops).toHaveLength(1);
    expect(fixture.getJob()).toMatchObject({
      runnerLeaseExpiresAt: '2026-07-27T12:11:00.000Z',
      cancellationStopAuthorizedLeaseExpiresAt: LEASE_EXPIRY,
    });
  });

  it('does not stop when the fresh lease expires between escalation claim and stop authorization', async () => {
    const fixture = coordinatorFixture(job(), fakeSystemd(), fakeClock());
    const originalWrite = fixture.ownership.apiWrite;
    fixture.ownership.apiWrite = vi.fn((command: ApiWriteCommand) => {
      const write = originalWrite(command);
      if (command.kind === 'claim-cancellation-escalation' && write.ok) {
        fixture.setJob({
          ...fixture.getJob(),
          runnerLeaseExpiresAt: command.stopIntentAt,
        });
      }
      return write;
    });

    const outcome = await requestCancellation({
      store: fixture.store,
      ownership: fixture.ownership,
      systemd: fixture.systemd,
      clock: fixture.clock,
      pollIntervalMs: 30_000,
    }, { jobId: JOB_ID, reason: 'operator', at: AT });

    expect(outcome).toMatchObject({
      kind: 'recovery-blocked',
      evidence: expect.objectContaining({ reason: expect.stringMatching(/stop authorization|expired/i) }),
    });
    expect(fixture.systemd.stops).toHaveLength(0);
  });

  it('fails closed on lease expiry regression immediately before stop authorization', async () => {
    const fixture = coordinatorFixture(job(), fakeSystemd(), fakeClock());
    const originalWrite = fixture.ownership.apiWrite;
    fixture.ownership.apiWrite = vi.fn((command: ApiWriteCommand) => {
      const write = originalWrite(command);
      if (command.kind === 'claim-cancellation-escalation' && write.ok) {
        fixture.setJob({
          ...fixture.getJob(),
          runnerLeaseExpiresAt: '2026-07-27T12:09:00.000Z',
        });
      }
      return write;
    });

    const outcome = await requestCancellation({
      store: fixture.store,
      ownership: fixture.ownership,
      systemd: fixture.systemd,
      clock: fixture.clock,
      pollIntervalMs: 30_000,
    }, { jobId: JOB_ID, reason: 'operator', at: AT });

    expect(outcome).toMatchObject({
      kind: 'recovery-blocked',
      evidence: expect.objectContaining({ reason: expect.stringMatching(/regressed/i) }),
    });
    expect(fixture.systemd.stops).toHaveLength(0);
  });

  it('retains exact stop argv when the systemd adapter reports a stop timeout and does not infer cancellation from inactivity', async () => {
    const clock = fakeClock();
    const systemd = fakeSystemd({
      stopRunner: async (unit, deadline) => {
        systemd.stops.push(`${unit}:${deadline}`);
        throw new Error('systemctl stop timed out');
      },
      inspectRunner: async (unit, deadline) => {
        systemd.statuses.push(`${unit}:${deadline}`);
        return observation(false);
      },
    });
    const fixture = coordinatorFixture(job(), systemd, clock);

    const outcome = await requestCancellation({
      store: fixture.store,
      ownership: fixture.ownership,
      systemd,
      clock,
      pollIntervalMs: 5_000,
    }, { jobId: JOB_ID, reason: 'operator', at: AT });

    expect(outcome).toMatchObject({ kind: 'recovery-blocked', blockerCode: 'RUNNER_DISAPPEARED' });
    expect(fixture.writes.find((write) => write.kind === 'cancellation-recovery-blocker')).toMatchObject({
      kind: 'cancellation-recovery-blocker',
      blocker: expect.objectContaining({
        systemd: expect.objectContaining({
          stop: expect.objectContaining({ argv: ['/usr/bin/systemctl', '--user', 'stop', UNIT], stderr: 'systemctl stop timed out' }),
          inspections: expect.objectContaining({
            observations: expect.arrayContaining([expect.objectContaining({ activity: 'inactive' })]),
          }),
        }),
      }),
    });
    expect(fixture.getJob().state).toBe('building');
  });

  it('records a late publishing request without signalling or stopping the publisher', async () => {
    const fixture = coordinatorFixture(job({ state: 'publishing', queueState: 'dispatched' }), fakeSystemd(), fakeClock());
    const outcome = await requestCancellation({
      store: fixture.store,
      ownership: fixture.ownership,
      systemd: fixture.systemd,
      clock: fixture.clock,
    }, { jobId: JOB_ID, reason: 'operator', at: AT });

    expect(outcome).toMatchObject({ kind: 'late-publishing', state: 'publishing', late: true });
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0]).toMatchObject({ kind: 'request-cancellation' });
    expect(fixture.systemd.signals).toHaveLength(0);
    expect(fixture.systemd.stops).toHaveLength(0);
  });
});

describe('systemd cancellation command adapter', () => {
  it('uses fixed absolute systemctl argv and never treats a unit string as shell input', async () => {
    const calls: Array<{
      readonly argv: readonly string[];
      readonly env: Readonly<Record<string, string>> | undefined;
      readonly timeoutMs: number | undefined;
    }> = [];
    const commandExecutor = {
      run: vi.fn(async (
        argv: readonly string[],
        options: {
          readonly env?: Readonly<Record<string, string>>;
          readonly timeoutMs?: number;
        },
      ): Promise<CommandResult> => {
        calls.push({ argv, env: options.env, timeoutMs: options.timeoutMs });
        return {
          argv,
          exitCode: argv[2] === 'is-active' ? 3 : 0,
          signal: null,
          stdout: argv[2] === 'is-active' ? 'inactive\n' : '',
          stderr: '',
          timedOut: false,
          startedAt: AT,
          finishedAt: AT,
        };
      }),
    };
    const systemd = createSystemdCancellationAdapter({
      commandExecutor,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      monotonicNow: () => 10_000,
    });

    const signal = await systemd.signalCancellation(UNIT, 30_000);
    const stop = await systemd.stopRunner(UNIT, 45_000);
    const status = await systemd.inspectRunner(UNIT, 45_000);

    expect(calls.map(({ argv }) => argv)).toEqual([
      ['/usr/bin/systemctl', '--user', 'kill', '--kill-whom=main', '--signal=SIGUSR1', UNIT],
      ['/usr/bin/systemctl', '--user', 'stop', UNIT],
      ['/usr/bin/systemctl', '--user', 'is-active', UNIT],
    ]);
    expect(calls.map(({ env }) => env)).toEqual([
      { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    ]);
    expect(calls.map(({ timeoutMs }) => timeoutMs)).toEqual([20_000, 35_000, 35_000]);
    expect(signal).toMatchObject({ commandOutcome: 'completed', activity: 'unknown', exitCode: 0 });
    expect(stop).toMatchObject({ commandOutcome: 'completed', activity: 'unknown', exitCode: 0 });
    expect(status).toMatchObject({ commandOutcome: 'completed', activity: 'inactive', exitCode: 3 });
    await expect(systemd.signalCancellation(`${UNIT};touch /tmp/pwned`, 30_000)).rejects.toThrow(/unit/i);
  });

  it('keeps command timeout and transport failure separate from observed unit activity', async () => {
    const timedOutExecutor = {
      run: vi.fn(async (argv: readonly string[]): Promise<CommandResult> => ({
        argv,
        exitCode: null,
        signal: 'SIGKILL',
        stdout: '',
        stderr: 'deadline',
        timedOut: true,
        startedAt: AT,
        finishedAt: AT,
      })),
    };
    const timedOut = createSystemdCancellationAdapter({
      commandExecutor: timedOutExecutor,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      monotonicNow: () => 0,
    });
    expect(await timedOut.stopRunner(UNIT, 1)).toMatchObject({
      commandOutcome: 'timed-out',
      activity: 'unknown',
      timedOut: true,
    });
    expect(await timedOut.inspectRunner(UNIT, 1)).toMatchObject({
      commandOutcome: 'timed-out',
      activity: 'unknown',
    });

    const unknownUnit = createSystemdCancellationAdapter({
      commandExecutor: {
        run: vi.fn(async (argv: readonly string[]): Promise<CommandResult> => ({
          argv,
          exitCode: 4,
          signal: null,
          stdout: 'unknown\n',
          stderr: '',
          timedOut: false,
          startedAt: AT,
          finishedAt: AT,
        })),
      },
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      monotonicNow: () => 0,
    });
    expect(await unknownUnit.inspectRunner(UNIT, 1)).toMatchObject({
      commandOutcome: 'completed',
      activity: 'unknown',
      exitCode: 4,
    });

    const transportFailure = createSystemdCancellationAdapter({
      commandExecutor: { run: vi.fn(async () => { throw new Error('dbus unavailable'); }) },
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      monotonicNow: () => 0,
    });
    expect(await transportFailure.inspectRunner(UNIT, 1)).toMatchObject({
      commandOutcome: 'transport-error',
      activity: 'unknown',
      exitCode: null,
      stderr: 'dbus unavailable',
    });
    expect(() => createSystemdCancellationAdapter({
      commandExecutor: { run: vi.fn(async () => { throw new Error('unused'); }) },
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', EXTRA: 'forbidden' },
    })).toThrow(/environment/i);
  });

  it('exposes a production service seam with only the fixed systemd environment', async () => {
    const fixture = coordinatorFixture(job(), fakeSystemd(), fakeClock());
    const calls: Array<{ readonly argv: readonly string[]; readonly env: Readonly<Record<string, string>> }> = [];
    const commandExecutor = {
      run: vi.fn(async (
        argv: readonly string[],
        options: { readonly env: Readonly<Record<string, string>> },
      ): Promise<CommandResult> => {
        calls.push({ argv, env: options.env });
        if (argv[2] === 'kill') {
          fixture.setJob(job({
            state: 'cancelled',
            cancelRequestedAt: AT,
            cancelReason: 'operator',
            terminalAt: AT,
            terminalErrorCode: 'CANCELLED',
            terminalError: { reason: 'operator' },
            queueState: 'complete',
          }));
        }
        return { argv, exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: AT, finishedAt: AT };
      }),
    };
    const service = createApiCancellationService({
      store: fixture.store,
      ownership: fixture.ownership,
      commandExecutor,
      systemdBusEnvironment: {
        XDG_RUNTIME_DIR: '/run/user/1000',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      },
      clock: fixture.clock,
      coordinatorId: 'production-service-test',
    });

    await expect(service.requestCancellation({ jobId: JOB_ID, reason: 'operator', at: AT }))
      .resolves.toMatchObject({ kind: 'runner-terminal', state: 'cancelled' });
    expect(calls).toEqual([{
      argv: ['/usr/bin/systemctl', '--user', 'kill', '--kill-whom=main', '--signal=SIGUSR1', UNIT],
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        XDG_RUNTIME_DIR: '/run/user/1000',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      },
    }]);
  });
});
