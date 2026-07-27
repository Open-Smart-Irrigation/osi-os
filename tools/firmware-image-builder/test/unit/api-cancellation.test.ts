import { describe, expect, it, vi } from 'vitest';
import type { JobRecord, JsonObject } from '../../api/src/store.js';
import type { ApiWriteCommand, OwnershipResult } from '../../api/src/ownership.js';
import type { CommandResult } from '../../runner/src/command-executor.js';
import {
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
  'terminalError' | 'queueState' | 'queuePosition'>;

function job(overrides: Partial<MutableJob> = {}): MutableJob {
  return {
    jobId: JOB_ID,
    state: 'building',
    cancelRequestedAt: null,
    cancelReason: null,
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
}

function result(eventSeq = 1): OwnershipResult {
  return { ok: true, kind: 'committed', eventSeq, value: undefined };
}

function observation(active: boolean, overrides: Partial<{
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}> = {}) {
  return {
    active,
    argv: [],
    exitCode: active ? 0 : 3,
    signal: null,
    stdout: active ? 'active\n' : 'inactive\n',
    stderr: '',
    timedOut: false,
    ...overrides,
  };
}

function fakeClock(onSleep?: (monotonic: number) => void): ApiCancellationClock & { readonly monotonic: () => number } {
  let monotonic = 0;
  return {
    now: () => AT,
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
      return observation(true);
    },
    stopRunner: async (unit, deadline) => {
      stops.push(`${unit}:${deadline}`);
      return observation(true);
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
        current = { ...current, cancelRequestedAt: command.at, cancelReason: command.reason };
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
    expect(fixture.writes).toHaveLength(1);
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
    expect(fixture.writes).toHaveLength(0);
    expect(fixture.systemd.signals).toHaveLength(1);
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
    expect(fixture.writes).toHaveLength(2);
    expect(fixture.writes[1]).toMatchObject({
      kind: 'runner-recovery-blocker',
      jobId: JOB_ID,
      runnerUnit: UNIT,
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
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes.some((write) => write.kind === 'direct-interrupt')).toBe(false);
    expect(fixture.writes.some((write) => write.kind === 'runner-recovery-blocker')).toBe(false);
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
    expect(fixture.writes[1]).toMatchObject({
      kind: 'runner-recovery-blocker',
      blocker: expect.objectContaining({
        systemd: expect.objectContaining({
          stop: expect.objectContaining({ argv: ['/usr/bin/systemctl', '--user', 'stop', UNIT], stderr: 'systemctl stop timed out' }),
          inspections: expect.arrayContaining([expect.objectContaining({ active: false })]),
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
    const calls: Array<{ readonly argv: readonly string[]; readonly timeoutMs: number | undefined }> = [];
    const commandExecutor = {
      run: vi.fn(async (argv: readonly string[], options: { readonly timeoutMs?: number }): Promise<CommandResult> => {
        calls.push({ argv, timeoutMs: options.timeoutMs });
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

    await systemd.signalCancellation(UNIT, 30_000);
    await systemd.stopRunner(UNIT, 45_000);
    const status = await systemd.inspectRunner(UNIT, 45_000);

    expect(calls.map(({ argv }) => argv)).toEqual([
      ['/usr/bin/systemctl', '--user', 'kill', '--signal=SIGUSR1', UNIT],
      ['/usr/bin/systemctl', '--user', 'stop', UNIT],
      ['/usr/bin/systemctl', '--user', 'is-active', UNIT],
    ]);
    expect(calls.map(({ timeoutMs }) => timeoutMs)).toEqual([20_000, 35_000, 35_000]);
    expect(status.active).toBe(false);
    await expect(systemd.signalCancellation(`${UNIT};touch /tmp/pwned`, 30_000)).rejects.toThrow(/unit/i);
  });
});
