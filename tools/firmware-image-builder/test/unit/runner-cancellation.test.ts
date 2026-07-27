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
  'containerStoppedAt' | 'artifactStagingPath'>;

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
    containerStoppedAt: null,
    artifactStagingPath: null,
    ...overrides,
  };
}

function container(overrides: Partial<CancellationContainer> = {}): CancellationContainer {
  return {
    id: CONTAINER_ID,
    name: CONTAINER_NAME,
    imageDigest: IMAGE_DIGEST,
    labels: LABELS,
    running: true,
    status: 'running',
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
    store: { getJob: () => current },
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
    expect(fixture.writes).toHaveLength(3);
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

    await expect(controller.cancelIfRequested()).rejects.toThrow(/persisted container labels/i);
    expect(fixture.docker.stop).not.toHaveBeenCalled();
    expect(fixture.writes).toHaveLength(0);
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

    await expect(controller.cancelIfRequested()).rejects.toThrow(/identity or labels/i);
    expect(fixture.docker.stop).not.toHaveBeenCalled();
    expect(fixture.writes).toHaveLength(0);
  });

  it('retains the exact identity until removal proof and cleanup CAS', async () => {
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
    expect(fixture.docker.waitForStopped).toHaveBeenCalledWith(CONTAINER_ID, 30_000);
    expect(fixture.writes[1]).toMatchObject({
      kind: 'cancellation-cleanup',
      proof: { kind: 'container', container: { id: CONTAINER_ID, name: CONTAINER_NAME, globalLabelResult: 'no-match' } },
    });
    expect(fixture.writes[2]).toMatchObject({ kind: 'cancellation-terminal', cleanupEventSeq: 2 });
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
    expect(fixture.writes).toHaveLength(1);
  });
});
