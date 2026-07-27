import { describe, expect, it, vi } from 'vitest';

import type { JobRecord, JsonObject } from '../../api/src/store.js';
import type { OwnershipResult, RunnerWriteCommand } from '../../api/src/ownership.js';
import {
  CancellationBlockedError,
  createRunnerCancellation,
  type CancellationContainer,
  type CancellationDockerExecutor,
  type RunnerCancellationSignals,
} from '../../runner/src/cancellation.js';

const NOW = '2026-07-27T09:00:00.000Z';
const STOPPED = '2026-07-27T09:00:01.000Z';
const JOB_ID = 'job-cancel-unit';
const RUNNER_UNIT = `osi-image-builder-runner@${JOB_ID}.service`;
const OWNER = 'runner-unit-test';
const LEASE = '2026-07-27T09:10:00.000Z';
const IMAGE_DIGEST = 'a'.repeat(64);
const MANIFEST_SHA = 'b'.repeat(64);
const CONTAINER_ID = 'c'.repeat(64);
const CONTAINER_NAME = 'osi-image-builder-cancel-unit';
const JOB_LABEL = 'org.osi.image-builder.job-id';
const MANIFEST_LABEL = 'org.osi.image-builder.manifest-sha';
const LABELS: JsonObject = {
  [JOB_LABEL]: JOB_ID,
  [MANIFEST_LABEL]: MANIFEST_SHA,
};

type TestJob = Pick<JobRecord,
  'jobId' | 'state' | 'currentStage' | 'cancelRequestedAt' | 'runnerUnit' |
  'runnerLeaseOwner' | 'runnerLeaseExpiresAt' | 'targetManifestSha256' |
  'containerId' | 'containerName' | 'containerImageDigest' |
  'containerLabelJobId' | 'containerLabelManifestSha' | 'containerLabels' |
  'containerMount' | 'containerEnvironment' | 'containerSecurity' | 'containerInspection' |
  'containerCreatedAt' | 'containerStartedAt' | 'containerStoppedAt' | 'artifactStagingPath'>;

function job(overrides: Partial<TestJob> = {}): TestJob {
  return {
    jobId: JOB_ID,
    state: 'building',
    currentStage: 'build',
    cancelRequestedAt: null,
    runnerUnit: RUNNER_UNIT,
    runnerLeaseOwner: OWNER,
    runnerLeaseExpiresAt: LEASE,
    targetManifestSha256: MANIFEST_SHA,
    containerId: null,
    containerName: null,
    containerImageDigest: null,
    containerLabelJobId: null,
    containerLabelManifestSha: null,
    containerLabels: null,
    containerMount: null,
    containerEnvironment: null,
    containerSecurity: null,
    containerInspection: null,
    containerCreatedAt: null,
    containerStartedAt: null,
    containerStoppedAt: null,
    artifactStagingPath: null,
    ...overrides,
  };
}

function containerJob(overrides: Partial<TestJob> = {}): TestJob {
  return job({
    containerId: CONTAINER_ID,
    containerName: CONTAINER_NAME,
    containerImageDigest: IMAGE_DIGEST,
    containerLabelJobId: JOB_ID,
    containerLabelManifestSha: MANIFEST_SHA,
    containerLabels: LABELS,
    containerMount: { source: '/tmp', destination: '/workdir' },
    containerEnvironment: { CI: '1' },
    containerSecurity: { user: '1000:1000' },
    containerInspection: { running: true, status: 'running' },
    containerCreatedAt: NOW,
    containerStartedAt: NOW,
    ...overrides,
  });
}

function container(overrides: Partial<CancellationContainer> = {}): CancellationContainer {
  return {
    id: CONTAINER_ID,
    name: CONTAINER_NAME,
    imageDigest: IMAGE_DIGEST,
    labels: LABELS,
    running: true,
    status: 'running',
    createdAt: NOW,
    startedAt: NOW,
    stoppedAt: null,
    ...overrides,
  };
}

function signals(): RunnerCancellationSignals & { emit: (signal: NodeJS.Signals) => void } {
  const listeners = new Map<NodeJS.Signals, () => void>();
  return {
    on(signal, listener) { listeners.set(signal, listener); },
    off(signal, listener) {
      if (listeners.get(signal) === listener) listeners.delete(signal);
    },
    emit(signal) { listeners.get(signal)?.(); },
  };
}

type MockExecutor = CancellationDockerExecutor & {
  calls: string[];
  current: CancellationContainer | null;
  inspect: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  waitForStopped: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  listByLabels: ReturnType<typeof vi.fn>;
};

function executor(initial: CancellationContainer | null = null): MockExecutor {
  const calls: string[] = [];
  const value = {
    calls,
    current: initial,
    inspect: vi.fn(async () => value.current),
    stop: vi.fn(async () => {
      value.calls.push('stop');
      if (value.current) value.current = container({ ...value.current, running: false, status: 'exited', stoppedAt: STOPPED });
    }),
    remove: vi.fn(async () => {
      value.calls.push('remove');
      value.current = null;
    }),
    waitForStopped: vi.fn(async () => {
      if (value.current === null || value.current.running) throw new Error('container did not stop cooperatively');
      return value.current;
    }),
    listByLabels: vi.fn(async () => value.current === null ? [] : [value.current]),
  };
  return value as unknown as MockExecutor;
}

type TestOptions = Omit<Parameters<typeof createRunnerCancellation>[0], 'docker' | 'signals' | 'evidence'> & {
  docker: MockExecutor;
  signals: ReturnType<typeof signals>;
  evidence: (record: JsonObject) => Promise<{ path: string; sha256: string }>;
};

function dependencies(overrides: Partial<Parameters<typeof createRunnerCancellation>[0]> = {}) {
  let current = job();
  const writes: RunnerWriteCommand[] = [];
  const evidence: JsonObject[] = [];
  const ownership = {
    runnerWrite(command: RunnerWriteCommand): OwnershipResult {
      writes.push(command);
      return { ok: true, kind: 'committed', eventSeq: writes.length, value: undefined };
    },
  };
  const docker = executor();
  const value = {
    jobId: JOB_ID,
    runnerUnit: RUNNER_UNIT,
    owner: OWNER,
    leaseExpiresAt: () => LEASE,
    store: {
      getJob: () => current,
      listEvents: () => ({ events: [], nextAfterSeq: null }),
    },
    ownership,
    docker,
    evidence: async (record: JsonObject) => {
      evidence.push(record);
      return { path: `jobs/${JOB_ID}/evidence/cancellation.json`, sha256: 'd'.repeat(64) };
    },
    cleanup: {
      staging: async () => ({ kind: 'absent', path: null } as const),
      logs: async () => ({ runner: 'sealed', docker: 'sealed', verifiedAt: NOW } as const),
    },
    clock: () => NOW,
    signals: signals(),
    ...overrides,
  } as TestOptions;
  return {
    value,
    writes,
    evidence,
    docker,
    setJob(next: TestJob) { current = next; },
  };
}

describe('runner cooperative cancellation', () => {
  it('owns one absolute monotonic deadline from the first observed request', () => {
    let monotonic = 12_500;
    const fixture = dependencies({ monotonicNow: () => monotonic });
    const controller = createRunnerCancellation(fixture.value);

    expect(controller.cancellationBudget()).toEqual({
      requested: false,
      deadline: null,
      remainingMs: null,
    });
    fixture.value.signals.emit('SIGUSR1');
    expect(controller.cancellationBudget()).toEqual({
      requested: true,
      deadline: 42_500,
      remainingMs: 30_000,
    });
    monotonic = 20_000;
    expect(controller.cancellationBudget()).toEqual({
      requested: true,
      deadline: 42_500,
      remainingMs: 22_500,
    });
  });

  it('handles SIGUSR1 and observes the request at a stage boundary', async () => {
    const fixture = dependencies();
    const controller = createRunnerCancellation(fixture.value);

    fixture.value.signals.emit('SIGUSR1');
    fixture.setJob(job({ cancelRequestedAt: NOW }));
    expect(controller.isRequested()).toBe(true);
    expect(await controller.observeBetweenStages('build')).toMatchObject({
      requested: true,
      handled: true,
      state: 'cancelled',
    });
    expect(fixture.writes.map((write) => write.kind)).toEqual([
      'cancellation-transition',
      'cancellation-evidence',
      'cancellation-cleanup',
      'cancellation-terminal',
    ]);
    expect(fixture.evidence).toHaveLength(1);
  });

  it('observes cancellation between operations without acting before the boundary', async () => {
    const fixture = dependencies();
    const controller = createRunnerCancellation(fixture.value);

    expect(await controller.observeBetweenOperations('build-image')).toEqual({
      requested: false,
      handled: false,
    });
    fixture.value.signals.emit('SIGUSR1');
    fixture.setJob(job({ cancelRequestedAt: NOW }));
    expect(await controller.observeBetweenOperations('verify-image')).toMatchObject({
      requested: true,
      handled: true,
    });
    expect(fixture.writes).toHaveLength(4);
  });

  it('validates persisted ID, name, and both labels before controlled stop', async () => {
    const fixture = dependencies();
    fixture.setJob(job({
      cancelRequestedAt: NOW,
      containerId: CONTAINER_ID,
      containerName: CONTAINER_NAME,
      containerImageDigest: IMAGE_DIGEST,
      containerLabelJobId: JOB_ID,
      containerLabelManifestSha: MANIFEST_SHA,
      containerLabels: { ...LABELS, extra: 'forged' },
    }));
    fixture.docker.current = container();
    const controller = createRunnerCancellation(fixture.value);
    fixture.value.signals.emit('SIGUSR1');

    await expect(controller.cancelIfRequested()).rejects.toMatchObject({
      blockerCode: 'DOCKER_CONTAINER_ORPHANED',
    });
    expect(fixture.docker.stop).not.toHaveBeenCalled();
    expect(fixture.writes).toEqual([
      expect.objectContaining({ kind: 'cancellation-transition' }),
      expect.objectContaining({
        kind: 'cancellation-blocker',
        blockerCode: 'DOCKER_CONTAINER_ORPHANED',
        blocker: expect.objectContaining({ cause: expect.stringMatching(/persisted container labels/i) }),
      }),
    ]);
  });

  it.each([
    ['ID', () => container({ id: 'd'.repeat(64) })],
    ['name', () => container({ name: 'osi-image-builder-other' })],
    ['job label', () => container({ labels: { ...LABELS, [JOB_LABEL]: 'other-job' } })],
    ['manifest label', () => container({ labels: { ...LABELS, [MANIFEST_LABEL]: 'e'.repeat(64) } })],
  ])('rejects a Docker %s mismatch before stop', async (_field, observedContainer) => {
    const fixture = dependencies();
    fixture.setJob(job({
      cancelRequestedAt: NOW,
      containerId: CONTAINER_ID,
      containerName: CONTAINER_NAME,
      containerImageDigest: IMAGE_DIGEST,
      containerLabelJobId: JOB_ID,
      containerLabelManifestSha: MANIFEST_SHA,
      containerLabels: LABELS,
    }));
    fixture.docker.current = observedContainer();
    const controller = createRunnerCancellation(fixture.value);
    fixture.value.signals.emit('SIGUSR1');

    await expect(controller.cancelIfRequested()).rejects.toMatchObject({
      blockerCode: 'DOCKER_CONTAINER_ORPHANED',
    });
    expect(fixture.docker.stop).not.toHaveBeenCalled();
    expect(fixture.writes).toEqual([
      expect.objectContaining({ kind: 'cancellation-transition' }),
      expect.objectContaining({
        kind: 'cancellation-blocker',
        blockerCode: 'DOCKER_CONTAINER_ORPHANED',
        blocker: expect.objectContaining({ cause: expect.stringMatching(/identity or labels/i) }),
      }),
    ]);
  });

  it.each([
    ['Docker label lookup', false, 'label query transport failed'],
    ['Docker exact inspection', true, 'inspect transport failed'],
  ])('persists a Docker orphan blocker when %s fails', async (_phase, withIdentity, message) => {
    const fixture = dependencies();
    fixture.setJob(withIdentity
      ? containerJob({ cancelRequestedAt: NOW })
      : job({ cancelRequestedAt: NOW }));
    if (withIdentity) {
      fixture.docker.inspect.mockRejectedValue(new Error(message));
    } else {
      fixture.docker.listByLabels.mockRejectedValue(new Error(message));
    }
    const controller = createRunnerCancellation(fixture.value);
    fixture.value.signals.emit('SIGUSR1');

    await expect(controller.cancelIfRequested()).rejects.toMatchObject({
      blockerCode: 'DOCKER_CONTAINER_ORPHANED',
    });
    expect(fixture.writes).toEqual([
      expect.objectContaining({ kind: 'cancellation-transition' }),
      expect.objectContaining({
        kind: 'cancellation-blocker',
        blockerCode: 'DOCKER_CONTAINER_ORPHANED',
        blocker: expect.objectContaining({ cause: message }),
      }),
    ]);
  });

  it('retains the exact identity until removal proof and cleanup CAS', async () => {
    const fixture = dependencies();
    fixture.setJob(containerJob({
      cancelRequestedAt: NOW,
    }));
    fixture.docker.current = container();
    fixture.docker.listByLabels.mockImplementation(async () => []);
    const identityAtEvidence: Array<string | null> = [];
    fixture.value.evidence = async (record: JsonObject) => {
      identityAtEvidence.push(fixture.value.store.getJob(JOB_ID).containerId);
      fixture.evidence.push(record);
      return { path: `jobs/${JOB_ID}/evidence/cancellation.json`, sha256: 'd'.repeat(64) };
    };
    const controller = createRunnerCancellation(fixture.value);
    fixture.value.signals.emit('SIGUSR1');

    await expect(controller.cancelIfRequested()).resolves.toMatchObject({ state: 'cancelled' });
    expect(identityAtEvidence).toEqual([CONTAINER_ID]);
    expect(fixture.docker.calls).toEqual(['stop', 'remove']);
    expect(fixture.docker.stop).toHaveBeenCalledWith(CONTAINER_ID, 30_000);
    expect(fixture.docker.waitForStopped).toHaveBeenCalledWith(CONTAINER_ID, expect.any(Number));
    expect(fixture.writes[1]).toMatchObject({
      kind: 'container',
      lifecycle: 'stopped',
      stoppedAt: STOPPED,
    });
    expect(fixture.writes[2]).toMatchObject({
      kind: 'cancellation-evidence',
      evidence: {
        evidencePath: `jobs/${JOB_ID}/evidence/cancellation.json`,
        evidenceSha256: 'd'.repeat(64),
        container: { id: CONTAINER_ID },
      },
    });
    expect(fixture.writes[3]).toMatchObject({
      kind: 'cancellation-cleanup',
      proof: { kind: 'container', unitInactiveAt: null, container: { id: CONTAINER_ID, name: CONTAINER_NAME, globalLabelResult: 'no-match' } },
    });
    expect(fixture.writes[4]).toMatchObject({ kind: 'cancellation-terminal', cleanupEventSeq: 4 });
  });

  it('starts the full cooperative budget when cancellation first changes to requested after a long operation', async () => {
    let monotonic = 0;
    const fixture = dependencies({ monotonicNow: () => monotonic });
    fixture.setJob(containerJob({
      cancelRequestedAt: null,
    }));
    fixture.docker.current = container();
    const controller = createRunnerCancellation(fixture.value);

    expect(controller.isRequested()).toBe(false);
    monotonic = 120_000;
    fixture.value.signals.emit('SIGUSR1');
    fixture.setJob(containerJob({
      cancelRequestedAt: NOW,
    }));

    await expect(controller.cancelIfRequested()).resolves.toMatchObject({ state: 'cancelled' });
    expect(fixture.docker.stop).toHaveBeenCalledWith(CONTAINER_ID, 30_000);
    expect(fixture.docker.waitForStopped).toHaveBeenCalledWith(CONTAINER_ID, 30_000);
  });

  it('shares one exact 30-second budget across cooperative stop and stopped proof', async () => {
    let monotonic = 10_000;
    const fixture = dependencies({ monotonicNow: () => monotonic });
    fixture.setJob(containerJob({
      cancelRequestedAt: NOW,
    }));
    fixture.docker.current = container();
    fixture.docker.stop.mockImplementation(async () => {
      fixture.docker.calls.push('stop');
      fixture.docker.current = container({ running: false, status: 'exited', stoppedAt: STOPPED });
      monotonic += 12_000;
    });
    const controller = createRunnerCancellation(fixture.value);
    fixture.value.signals.emit('SIGUSR1');

    await expect(controller.cancelIfRequested()).resolves.toMatchObject({ state: 'cancelled' });
    expect(fixture.docker.stop).toHaveBeenCalledWith(CONTAINER_ID, 30_000);
    expect(fixture.docker.waitForStopped).toHaveBeenCalledWith(CONTAINER_ID, 18_000);
  });

  it('does not call rm when the persisted stopped identity is already absent', async () => {
    const fixture = dependencies();
    fixture.setJob(job({
      cancelRequestedAt: NOW,
      containerId: CONTAINER_ID,
      containerName: CONTAINER_NAME,
      containerImageDigest: IMAGE_DIGEST,
      containerLabelJobId: JOB_ID,
      containerLabelManifestSha: MANIFEST_SHA,
      containerLabels: LABELS,
      containerStoppedAt: STOPPED,
    }));
    fixture.docker.inspect.mockResolvedValue(null);
    fixture.docker.listByLabels.mockResolvedValue([]);
    const controller = createRunnerCancellation(fixture.value);
    fixture.value.signals.emit('SIGUSR1');

    await expect(controller.cancelIfRequested()).resolves.toMatchObject({ state: 'cancelled' });
    expect(fixture.docker.remove).not.toHaveBeenCalled();
  });

  it('persists a blocker when an active exact container disappears before stopped evidence', async () => {
    const fixture = dependencies();
    fixture.setJob(job({
      cancelRequestedAt: NOW,
      containerId: CONTAINER_ID,
      containerName: CONTAINER_NAME,
      containerImageDigest: IMAGE_DIGEST,
      containerLabelJobId: JOB_ID,
      containerLabelManifestSha: MANIFEST_SHA,
      containerLabels: LABELS,
    }));
    fixture.docker.inspect.mockResolvedValue(null);
    const controller = createRunnerCancellation(fixture.value);
    fixture.value.signals.emit('SIGUSR1');

    await expect(controller.cancelIfRequested()).rejects.toBeInstanceOf(CancellationBlockedError);
    expect(fixture.docker.remove).not.toHaveBeenCalled();
    expect(fixture.writes).toEqual([
      expect.objectContaining({ kind: 'cancellation-transition' }),
      expect.objectContaining({ kind: 'cancellation-blocker', blocker: expect.objectContaining({ reason: expect.stringMatching(/disappeared/i) }) }),
    ]);
  });

  it('persists a cleanup blocker when staging or log cleanup fails', async () => {
    const fixture = dependencies({
      cleanup: {
        staging: async () => { throw new Error('staging quarantine ambiguous'); },
        logs: async () => ({ runner: 'sealed', docker: 'sealed', verifiedAt: NOW } as const),
      },
    });
    fixture.setJob(job({ cancelRequestedAt: NOW }));
    const controller = createRunnerCancellation(fixture.value);
    fixture.value.signals.emit('SIGUSR1');

    await expect(controller.cancelIfRequested()).rejects.toBeInstanceOf(CancellationBlockedError);
    expect(fixture.writes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'cancellation-blocker',
        blockerCode: 'QUARANTINE_PENDING',
        blocker: expect.objectContaining({ reason: expect.stringMatching(/staging/i) }),
      }),
    ]));
  });

  it('persists RECOVERY_LOG_GAP when cancellation log coverage cannot be proved', async () => {
    const fixture = dependencies({
      cleanup: {
        staging: async () => ({ kind: 'absent', path: null } as const),
        logs: async () => { throw new Error('runner generation has a coverage gap'); },
      },
    });
    fixture.setJob(job({ cancelRequestedAt: NOW }));
    const controller = createRunnerCancellation(fixture.value);
    fixture.value.signals.emit('SIGUSR1');

    await expect(controller.cancelIfRequested()).rejects.toMatchObject({
      blockerCode: 'RECOVERY_LOG_GAP',
    });
    expect(fixture.writes).toContainEqual(expect.objectContaining({
      kind: 'cancellation-blocker',
      blockerCode: 'RECOVERY_LOG_GAP',
    }));
  });

  it('reports stale terminal state distinctly and clears the signal latch', async () => {
    const fixture = dependencies();
    fixture.setJob(job({ state: 'cancelled', cancelRequestedAt: NOW, currentStage: null }));
    const controller = createRunnerCancellation(fixture.value);
    fixture.value.signals.emit('SIGUSR1');

    await expect(controller.cancelIfRequested()).resolves.toEqual({
      requested: true,
      handled: false,
      ignored: 'stale',
    });
    fixture.setJob(job({ cancelRequestedAt: null }));
    expect(controller.isRequested()).toBe(false);
  });

  it('clears a latched signal when the cancellation transition loses its CAS race', async () => {
    const fixture = dependencies();
    fixture.setJob(job({ cancelRequestedAt: NOW }));
    vi.spyOn(fixture.value.ownership, 'runnerWrite').mockReturnValue({
      ok: false,
      conflict: { kind: 'cas-lost', message: 'state changed before cancellation transition' },
    });
    const controller = createRunnerCancellation(fixture.value);
    fixture.value.signals.emit('SIGUSR1');

    await expect(controller.cancelIfRequested()).rejects.toMatchObject({
      blockerCode: 'RUNNER_DISAPPEARED',
    });
    fixture.setJob(job({ cancelRequestedAt: null }));
    expect(controller.isRequested()).toBe(false);
  });

  it('does not cancel or stop a job after publishing has started', async () => {
    const fixture = dependencies();
    fixture.setJob(job({ state: 'publishing', currentStage: 'publish', cancelRequestedAt: NOW }));
    const controller = createRunnerCancellation(fixture.value);
    fixture.value.signals.emit('SIGUSR1');

    await expect(controller.cancelIfRequested()).resolves.toEqual({
      requested: true,
      handled: false,
      ignored: 'publishing',
    });
    expect(fixture.writes).toHaveLength(0);
    expect(fixture.docker.stop).not.toHaveBeenCalled();
  });

  it('does not remove a container when cooperative waiting cannot prove exit', async () => {
    const fixture = dependencies();
    fixture.setJob(job({
      cancelRequestedAt: NOW,
      containerId: CONTAINER_ID,
      containerName: CONTAINER_NAME,
      containerImageDigest: IMAGE_DIGEST,
      containerLabelJobId: JOB_ID,
      containerLabelManifestSha: MANIFEST_SHA,
      containerLabels: LABELS,
    }));
    fixture.docker.current = container();
    fixture.docker.stop.mockResolvedValue(undefined);
    fixture.docker.inspect.mockImplementation(async () => container());
    fixture.docker.waitForStopped.mockRejectedValue(new CancellationBlockedError('container did not exit within the cooperative deadline'));
    const controller = createRunnerCancellation(fixture.value);
    fixture.value.signals.emit('SIGUSR1');

    await expect(controller.cancelIfRequested()).rejects.toBeInstanceOf(CancellationBlockedError);
    expect(fixture.docker.remove).not.toHaveBeenCalled();
    expect(fixture.writes).toHaveLength(2);
    expect(fixture.writes[1]).toMatchObject({
      kind: 'cancellation-blocker',
      blockerCode: 'DOCKER_CONTAINER_ORPHANED',
    });
  });

  it('persists DOCKER_CONTAINER_ORPHANED when exact removal fails after durable evidence', async () => {
    const fixture = dependencies();
    fixture.setJob(containerJob({ cancelRequestedAt: NOW }));
    fixture.docker.current = container({ running: false, status: 'exited', stoppedAt: STOPPED });
    fixture.docker.remove.mockRejectedValue(new Error('docker rm transport ambiguous'));
    const controller = createRunnerCancellation(fixture.value);
    fixture.value.signals.emit('SIGUSR1');

    await expect(controller.cancelIfRequested()).rejects.toMatchObject({
      blockerCode: 'DOCKER_CONTAINER_ORPHANED',
    });
    expect(fixture.writes).toContainEqual(expect.objectContaining({
      kind: 'cancellation-blocker',
      blockerCode: 'DOCKER_CONTAINER_ORPHANED',
    }));
  });

  it('persists an attached-operation Docker blocker without starting cleanup', async () => {
    const fixture = dependencies();
    fixture.setJob(containerJob({ cancelRequestedAt: NOW }));
    fixture.docker.current = container({ running: false, status: 'exited', stoppedAt: STOPPED });
    const controller = createRunnerCancellation(fixture.value);
    fixture.value.signals.emit('SIGUSR1');

    await expect(controller.blockRecoveryRequired(
      'DOCKER_CONTAINER_ORPHANED',
      'attached Docker child remains after cooperative deadline',
    )).rejects.toMatchObject({
      blockerCode: 'DOCKER_CONTAINER_ORPHANED',
    });
    expect(fixture.writes).toEqual([
      expect.objectContaining({ kind: 'cancellation-transition' }),
      expect.objectContaining({
        kind: 'cancellation-blocker',
        blockerCode: 'DOCKER_CONTAINER_ORPHANED',
      }),
    ]);
    expect(fixture.docker.stop).not.toHaveBeenCalled();
    expect(fixture.docker.remove).not.toHaveBeenCalled();
    expect(fixture.evidence).toHaveLength(0);
  });
});
