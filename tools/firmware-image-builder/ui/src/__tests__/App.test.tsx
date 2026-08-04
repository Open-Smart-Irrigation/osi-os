// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App.js';
import type {
  CancelJobResponse,
  EventPage,
  HealthSnapshot,
  JobDetail,
  JobEvent,
  JobPage,
  JobSummary,
} from '../types.js';

const SHA = 'a'.repeat(40);
const NOW = '2026-07-28T10:00:00.000Z';
const LATER = '2026-07-28T10:05:00.000Z';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function summary(id: string, branch: string, state: JobSummary['state'] = 'building'): JobSummary {
  return {
    id,
    state,
    branch,
    targetId: 'rpi-5',
    outputRootId: 'release',
    acceptedAt: NOW,
    currentStage: state === 'publishing' ? 'publish' : 'build',
    queuePosition: null,
    terminalAt: null,
  };
}

function detail(id: string, branch: string, pinnedSha: string, state: JobDetail['state'] = 'building'): JobDetail {
  const item = summary(id, branch, state);
  return {
    ...item,
    stage: state === 'publishing' ? 'publish' : 'build',
    pinnedSha,
    cancelRequestedAt: null,
    artifact: null,
    freshnessStatus: 'fresh',
    freshnessCheckedAt: LATER,
    newerSourceAvailable: false,
    error: null,
    source: {
      branch,
      sourceRef: `refs/remotes/origin/${branch}`,
      expectedSha: pinnedSha,
      pinnedSha,
      commitTime: NOW,
      author: 'OSI Builder',
      subject: `${branch} firmware`,
    },
    output: null,
    errors: { terminal: null, publish: null, cleanup: null, freshness: null },
    cancellation: { requestedAt: null, cooperativeDeadlineAt: null, graceDeadlineAt: null },
    runtime: { runnerUnit: `osi-image-builder-runner@${id}.service`, dispatchedAt: NOW, cleanupOutcome: null },
    evidence: [],
  };
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
  closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.set(name, listener as (event: MessageEvent<string>) => void);
  }

  close(): void {
    this.closed = true;
  }

  emit(sequence: number): void {
    this.listeners.get('stage')?.(new MessageEvent('stage', {
      data: JSON.stringify({ state: 'building', stage: 'build', at: LATER }),
      lastEventId: String(sequence),
    }));
  }
}

class ApiFixture {
  readonly details = new Map<string, JobDetail>();
  readonly queuedDetails = new Map<string, Array<Promise<JobDetail>>>();
  readonly queuedEvents = new Map<string, Array<Promise<EventPage>>>();
  readonly jobRequestCounts = new Map<string, number>();
  readonly queuedJobPages: Array<Promise<JobPage>> = [];
  readonly queuedHealthSnapshots: Array<Promise<HealthSnapshot>> = [];
  jobPageRequestCount = 0;
  healthRequestCount = 0;
  cancelResponse: Promise<CancelJobResponse> | null = null;

  constructor(readonly jobs: readonly JobSummary[], details: readonly JobDetail[]) {
    for (const item of details) this.details.set(item.id, item);
  }

  queueDetails(jobId: string, ...responses: Array<Promise<JobDetail>>): void {
    this.queuedDetails.set(jobId, responses);
  }

  queueEvents(jobId: string, ...responses: Array<Promise<EventPage>>): void {
    this.queuedEvents.set(jobId, responses);
  }

  queueJobPages(...responses: Array<Promise<JobPage>>): void {
    this.queuedJobPages.push(...responses);
  }

  queueHealthSnapshots(...responses: Array<Promise<HealthSnapshot>>): void {
    this.queuedHealthSnapshots.push(...responses);
  }

  response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, 'http://localhost');
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (method === 'GET' && url.pathname === '/api/health') {
      this.healthRequestCount += 1;
      const queued = this.queuedHealthSnapshots.shift();
      return this.response(queued === undefined
        ? { status: 'ok', version: 'test', activeJobId: this.jobs[0]?.id ?? null }
        : await queued);
    }
    if (method === 'GET' && url.pathname === '/api/config') {
      return this.response({
        repository: { path: '/srv/osi-os', remote: 'origin' },
        approvedOutputRoots: [{ id: 'release', label: 'Release', path: '/srv/images' }],
        targets: [{
          id: 'rpi-5', label: 'Pi 5', environment: 'bcm2712', openwrtTarget: 'bcm27xx/bcm2712',
          profile: 'DEVICE_rpi-5', rootfs: 'ext4', artifactGlob: '*.img.gz', rootfsPartSize: 14336,
          minimumArtifactBytes: 67_108_864, configSymbols: [], operations: [],
        }],
      });
    }
    if (method === 'GET' && url.pathname === '/api/branches') {
      return this.response({ fetchedAt: NOW, branches: [{ name: 'main', sha: SHA, commitTime: NOW, subject: 'main firmware' }] });
    }
    if (method === 'GET' && url.pathname === '/api/jobs') {
      this.jobPageRequestCount += 1;
      const queued = this.queuedJobPages.shift();
      return this.response(queued === undefined ? { jobs: this.jobs, nextCursor: null } : await queued);
    }
    const cancelMatch = /^\/api\/jobs\/([^/]+)\/cancel$/u.exec(url.pathname);
    if (method === 'POST' && cancelMatch !== null) {
      if (this.cancelResponse === null) throw new Error('cancel response was not configured');
      return this.response(await this.cancelResponse);
    }
    const eventsMatch = /^\/api\/jobs\/([^/]+)\/events$/u.exec(url.pathname);
    if (method === 'GET' && eventsMatch !== null) {
      const jobId = decodeURIComponent(eventsMatch[1]!);
      const queued = this.queuedEvents.get(jobId)?.shift();
      return this.response(queued === undefined ? { events: [], next: -1 } : await queued);
    }
    const jobMatch = /^\/api\/jobs\/([^/]+)$/u.exec(url.pathname);
    if (method === 'GET' && jobMatch !== null) {
      const jobId = decodeURIComponent(jobMatch[1]!);
      this.jobRequestCounts.set(jobId, (this.jobRequestCounts.get(jobId) ?? 0) + 1);
      const queued = this.queuedDetails.get(jobId)?.shift();
      const value = queued === undefined ? this.details.get(jobId) : await queued;
      if (value === undefined) return this.response({ error: { code: 'JOB_NOT_FOUND', message: 'JOB_NOT_FOUND' } }, 404);
      return this.response(value);
    }
    throw new Error(`unexpected API request: ${method} ${url.pathname}`);
  };
}

async function renderApp(fixture: ApiFixture, waitForStream = true): Promise<void> {
  vi.stubGlobal('fetch', vi.fn(fixture.fetch));
  vi.stubGlobal('EventSource', FakeEventSource);
  render(<App />);
  await screen.findByRole('heading', { name: 'OSI image builder' });
  if (waitForStream) await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
}

function captureJobPoller(): () => void {
  let poller: (() => void) | undefined;
  const realSetInterval = globalThis.setInterval;
  vi.spyOn(window, 'setInterval').mockImplementation((handler, timeout) => {
    if (timeout === 5_000) poller = handler;
    return realSetInterval.call(globalThis, handler, timeout);
  });
  return () => {
    if (typeof poller !== 'function') throw new Error('job poller was not installed');
    poller();
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeEventSource.instances = [];
});

describe('App asynchronous job updates', () => {
  it('does not let a slow detail bootstrap overwrite a newer detail poll', async () => {
    const fixture = new ApiFixture(
      [summary('job-a', 'main')],
      [detail('job-a', 'main', 'a'.repeat(40))],
    );
    const bootstrapDetail = deferred<JobDetail>();
    const bootstrapEvents = deferred<EventPage>();
    const pollDetail = deferred<JobDetail>();
    fixture.queueDetails('job-a', bootstrapDetail.promise, pollDetail.promise);
    fixture.queueEvents('job-a', bootstrapEvents.promise);
    const poll = captureJobPoller();
    await renderApp(fixture, false);
    await waitFor(() => expect(fixture.jobRequestCounts.get('job-a')).toBe(1));

    act(() => poll());
    await waitFor(() => expect(fixture.jobRequestCounts.get('job-a')).toBe(2));
    await act(async () => pollDetail.resolve(detail('job-a', 'main', 'd'.repeat(40))));
    expect(await screen.findByText('d'.repeat(40))).toBeInTheDocument();

    await act(async () => {
      bootstrapDetail.resolve(detail('job-a', 'main', 'b'.repeat(40)));
      bootstrapEvents.resolve({ events: [], next: -1 });
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    expect(screen.getByText('d'.repeat(40))).toBeInTheDocument();
    expect(screen.queryByText('b'.repeat(40))).not.toBeInTheDocument();
  });

  it('ignores stale queue and health polling successes and errors', async () => {
    const fixture = new ApiFixture(
      [summary('job-a', 'main')],
      [detail('job-a', 'main', 'a'.repeat(40))],
    );
    const poll = captureJobPoller();
    await renderApp(fixture);
    const staleJobsSuccess = deferred<JobPage>();
    const staleJobsError = deferred<JobPage>();
    const latestJobs = deferred<JobPage>();
    const staleHealthSuccess = deferred<HealthSnapshot>();
    const staleHealthError = deferred<HealthSnapshot>();
    const latestHealth = deferred<HealthSnapshot>();
    fixture.queueJobPages(staleJobsSuccess.promise, staleJobsError.promise, latestJobs.promise);
    fixture.queueHealthSnapshots(staleHealthSuccess.promise, staleHealthError.promise, latestHealth.promise);

    act(() => {
      poll();
      poll();
      poll();
    });
    await waitFor(() => {
      expect(fixture.jobPageRequestCount).toBe(4);
      expect(fixture.healthRequestCount).toBe(4);
    });
    await act(async () => {
      latestJobs.resolve({ jobs: [summary('job-a', 'latest-queue')], nextCursor: null });
      latestHealth.resolve({ status: 'ok', version: 'latest-health', activeJobId: 'job-a' });
    });
    expect(await screen.findByText('latest-queue')).toBeInTheDocument();
    expect(screen.getByText('vlatest-health')).toBeInTheDocument();

    await act(async () => {
      staleJobsSuccess.resolve({ jobs: [summary('job-a', 'stale-queue')], nextCursor: null });
      staleHealthSuccess.resolve({ status: 'ok', version: 'stale-health', activeJobId: null });
    });
    await act(async () => {
      staleJobsError.reject(new Error('stale queue poll failure'));
      staleHealthError.reject(new Error('stale health poll failure'));
    });

    expect(screen.getByText('latest-queue')).toBeInTheDocument();
    expect(screen.queryByText('stale-queue')).not.toBeInTheDocument();
    expect(screen.getByText('vlatest-health')).toBeInTheDocument();
    expect(screen.queryByText('vstale-health')).not.toBeInTheDocument();
    expect(screen.queryByText('NETWORK_UNAVAILABLE')).not.toBeInTheDocument();
  });

  it('ignores bootstrap and polling successes after selected-job cleanup', async () => {
    const fixture = new ApiFixture(
      [summary('job-a', 'main'), summary('job-b', 'feature')],
      [detail('job-a', 'main', 'a'.repeat(40)), detail('job-b', 'feature', 'e'.repeat(40))],
    );
    const bootstrapDetail = deferred<JobDetail>();
    const bootstrapEvents = deferred<EventPage>();
    const pollDetail = deferred<JobDetail>();
    const pollJobs = deferred<JobPage>();
    const pollHealth = deferred<HealthSnapshot>();
    fixture.queueDetails('job-a', bootstrapDetail.promise, pollDetail.promise);
    fixture.queueEvents('job-a', bootstrapEvents.promise);
    const poll = captureJobPoller();
    await renderApp(fixture, false);
    await waitFor(() => expect(fixture.jobRequestCounts.get('job-a')).toBe(1));
    fixture.queueJobPages(pollJobs.promise);
    fixture.queueHealthSnapshots(pollHealth.promise);
    act(() => poll());
    await waitFor(() => expect(fixture.jobRequestCounts.get('job-a')).toBe(2));

    fireEvent.click(screen.getByRole('button', { name: 'View job job-b' }));
    expect(await screen.findByText('e'.repeat(40))).toBeInTheDocument();
    await act(async () => {
      bootstrapDetail.resolve(detail('job-a', 'main', 'b'.repeat(40)));
      bootstrapEvents.resolve({ events: [], next: -1 });
      pollDetail.resolve(detail('job-a', 'main', 'c'.repeat(40)));
      pollJobs.resolve({ jobs: [summary('job-a', 'cleanup-stale-queue')], nextCursor: null });
      pollHealth.resolve({ status: 'ok', version: 'cleanup-stale-health', activeJobId: 'job-a' });
    });

    expect(screen.getByText('e'.repeat(40))).toBeInTheDocument();
    expect(screen.queryByText('b'.repeat(40))).not.toBeInTheDocument();
    expect(screen.queryByText('c'.repeat(40))).not.toBeInTheDocument();
    expect(screen.queryByText('cleanup-stale-queue')).not.toBeInTheDocument();
    expect(screen.getByText('vtest')).toBeInTheDocument();
    expect(screen.queryByText('vcleanup-stale-health')).not.toBeInTheDocument();
  });

  it('ignores bootstrap and polling errors after selected-job cleanup', async () => {
    const fixture = new ApiFixture(
      [summary('job-a', 'main'), summary('job-b', 'feature')],
      [detail('job-a', 'main', 'a'.repeat(40)), detail('job-b', 'feature', 'e'.repeat(40))],
    );
    const bootstrapDetail = deferred<JobDetail>();
    const bootstrapEvents = deferred<EventPage>();
    const pollDetail = deferred<JobDetail>();
    const pollJobs = deferred<JobPage>();
    const pollHealth = deferred<HealthSnapshot>();
    fixture.queueDetails('job-a', bootstrapDetail.promise, pollDetail.promise);
    fixture.queueEvents('job-a', bootstrapEvents.promise);
    const poll = captureJobPoller();
    await renderApp(fixture, false);
    await waitFor(() => expect(fixture.jobRequestCounts.get('job-a')).toBe(1));
    fixture.queueJobPages(pollJobs.promise);
    fixture.queueHealthSnapshots(pollHealth.promise);
    act(() => poll());
    await waitFor(() => expect(fixture.jobRequestCounts.get('job-a')).toBe(2));

    fireEvent.click(screen.getByRole('button', { name: 'View job job-b' }));
    expect(await screen.findByText('e'.repeat(40))).toBeInTheDocument();
    await act(async () => {
      bootstrapDetail.resolve(detail('job-a', 'main', 'b'.repeat(40)));
      bootstrapEvents.reject(new Error('disposed event bootstrap failure'));
      pollDetail.reject(new Error('disposed detail poll failure'));
      pollJobs.reject(new Error('disposed queue poll failure'));
      pollHealth.reject(new Error('disposed health poll failure'));
    });

    expect(screen.getByText('e'.repeat(40))).toBeInTheDocument();
    expect(screen.queryByText('NETWORK_UNAVAILABLE')).not.toBeInTheDocument();
  });

  it('ignores stale detail success and error after newer SSE-triggered requests complete', async () => {
    const initial = detail('job-a', 'main', 'a'.repeat(40));
    const fixture = new ApiFixture([summary('job-a', 'main')], [initial]);
    await renderApp(fixture);
    const staleSuccess = deferred<JobDetail>();
    const staleError = deferred<JobDetail>();
    const latest = deferred<JobDetail>();
    fixture.queueDetails('job-a', staleSuccess.promise, staleError.promise, latest.promise);

    act(() => {
      FakeEventSource.instances[0]!.emit(1);
      FakeEventSource.instances[0]!.emit(2);
      FakeEventSource.instances[0]!.emit(3);
    });
    await waitFor(() => expect(fixture.jobRequestCounts.get('job-a')).toBe(4));
    await act(async () => latest.resolve(detail('job-a', 'main', 'd'.repeat(40))));
    expect(await screen.findByText('d'.repeat(40))).toBeInTheDocument();

    await act(async () => staleSuccess.resolve(detail('job-a', 'main', 'b'.repeat(40))));
    await act(async () => staleError.reject(new Error('stale detail failure')));

    expect(screen.getByText('d'.repeat(40))).toBeInTheDocument();
    expect(screen.queryByText('b'.repeat(40))).not.toBeInTheDocument();
    expect(screen.queryByText('NETWORK_UNAVAILABLE')).not.toBeInTheDocument();
  });

  it('ignores stale detail success and error after changing the selected job', async () => {
    const jobA = detail('job-a', 'main', 'a'.repeat(40));
    const jobB = detail('job-b', 'feature', 'e'.repeat(40));
    const fixture = new ApiFixture([summary('job-a', 'main'), summary('job-b', 'feature')], [jobA, jobB]);
    await renderApp(fixture);
    const staleSuccess = deferred<JobDetail>();
    const staleError = deferred<JobDetail>();
    fixture.queueDetails('job-a', staleSuccess.promise, staleError.promise);

    act(() => {
      FakeEventSource.instances[0]!.emit(1);
      FakeEventSource.instances[0]!.emit(2);
    });
    await waitFor(() => expect(fixture.jobRequestCounts.get('job-a')).toBe(3));
    fireEvent.click(screen.getByRole('button', { name: 'View job job-b' }));
    expect(await screen.findByText('e'.repeat(40))).toBeInTheDocument();

    await act(async () => staleSuccess.resolve(detail('job-a', 'main', 'b'.repeat(40))));
    await act(async () => staleError.reject(new Error('stale selected-job failure')));

    expect(screen.getByText('e'.repeat(40))).toBeInTheDocument();
    expect(screen.queryByText('b'.repeat(40))).not.toBeInTheDocument();
    expect(screen.queryByText('NETWORK_UNAVAILABLE')).not.toBeInTheDocument();
  });

  it('does not show a late cancellation notice after selection changes to another job', async () => {
    const jobA = detail('job-a', 'main', 'a'.repeat(40), 'publishing');
    const jobB = detail('job-b', 'feature', 'e'.repeat(40));
    const fixture = new ApiFixture([summary('job-a', 'main', 'publishing'), summary('job-b', 'feature')], [jobA, jobB]);
    const cancellation = deferred<CancelJobResponse>();
    fixture.cancelResponse = cancellation.promise;
    vi.stubGlobal('confirm', vi.fn(() => true));
    await renderApp(fixture);

    fireEvent.click(screen.getByRole('button', { name: 'Request cancellation; publication may complete for job-a' }));
    fireEvent.click(screen.getByRole('button', { name: 'View job job-b' }));
    expect(await screen.findByText('e'.repeat(40))).toBeInTheDocument();
    await act(async () => cancellation.resolve({
      ...jobA,
      cancellationResult: {
        kind: 'late-publishing',
        jobId: 'job-a',
        state: 'publishing',
        late: true,
        requestPersisted: true,
      },
    }));

    await waitFor(() => expect(screen.queryByText('Cancellation was recorded after publication started. Publication may complete.')).not.toBeInTheDocument());
    expect(screen.getByText('e'.repeat(40))).toBeInTheDocument();
  });
});
