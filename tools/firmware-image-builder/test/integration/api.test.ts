import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PIPELINE_STAGE_NAMES, type PipelineStageName } from '../../domain/types.js';
import { createHttpServer, type ApiRouteContext } from '../../api/src/server.js';
import { createApiRouteHandler, type ApiRouteDependencies } from '../../api/src/routes.js';
import { StoreNotFoundError } from '../../api/src/store.js';
import type { EvidenceIndex } from '../../api/src/evidence-reader.js';
import { PreflightError } from '../../api/src/preflight.js';

const sha = 'a'.repeat(40);
const now = '2026-07-28T10:00:00.000Z';
const later = '2026-07-28T10:00:01.000Z';

function persistedAcceptance(job: Record<string, unknown>) {
  return {
    kind: 'persisted-queued-job' as const,
    secondOriginFetch: 'verified' as const,
    persistence: 'atomic-source-job-queue' as const,
    job,
  };
}

function stageEvidence(stage: PipelineStageName = 'publish', outcome: 'passed' | 'failed' = 'passed') {
  const index = PIPELINE_STAGE_NAMES.indexOf(stage);
  return {
    schemaVersion: 1,
    jobId: 'job-1',
    stage,
    startedAt: now,
    finishedAt: later,
    outcome,
    operationId: null,
    commands: [],
    inputs: { targetId: 'rpi-5', rootId: 'release', branch: 'main', pinnedSha: sha },
    observations: { artifactSha256: 'c'.repeat(64) },
    error: outcome === 'passed' ? null : {
      code: 'BUILD_FAILED',
      stage,
      details: { expectedSha: sha, secret: 'redact-me' },
      retryable: false,
      requestId: 'request-1',
      diagnosis: 'The stage failed.',
      recovery: 'Retry the stage.',
      evidencePath: `jobs/job-1/evidence/${String(index).padStart(2, '0')}-${stage}.json`,
    },
  };
}

function useEvidence(
  dependencies: ApiRouteDependencies,
  evidence: Record<string, unknown>,
  stage: PipelineStageName,
  outcome: 'passed' | 'failed',
): void {
  Object.assign(dependencies.store as object, {
    getStage: (id: string, requestedStage: string) => id === 'job-1' && requestedStage === stage ? {
      jobId: 'job-1', stage, outcome, startedAt: now, finishedAt: later,
      evidencePath: `jobs/job-1/evidence/${String(PIPELINE_STAGE_NAMES.indexOf(stage)).padStart(2, '0')}-${stage}.json`,
      evidenceSha256: 'd'.repeat(64), errorCode: outcome === 'failed' ? 'BUILD_FAILED' : null, error: null,
    } : null,
  });
  Object.assign(dependencies as object, { evidenceReader: { read: async () => evidence } });
}

function job(id: string) {
  return {
    jobId: id,
    requestId: 'request-1',
    sourceRemote: 'ssh://git.example/osi-os', sourceRef: 'refs/remotes/origin/main',
    sourceBranch: 'main', branch: 'main', expectedSha: sha, pinnedSha: sha,
    sourceCommitTime: now, sourceAuthor: 'builder', sourceSubject: 'subject',
    request: null,
    sourcePreparation: null, offlineFeedPreparation: null, sourceRunnable: false,
    targetId: 'rpi-5', rootId: 'release', targetManifestSha256: 'b'.repeat(64), acceptedAt: now,
    state: 'succeeded', currentStage: 'publish', queueState: 'done', queuePosition: null,
    cancelRequestedAt: null, cancelReason: null, cancellationCooperativeDeadlineAt: null,
    cancellationEscalationOwner: null, cancellationEscalationLeaseExpiresAt: null,
    cancellationStopIntentAt: null, cancellationGraceDeadlineAt: null,
    cancellationSignalObservation: null, cancellationStopObservation: null,
    cancellationInspectionObservations: null, cancellationClockHighWaterAt: null,
    cancellationStopAuthorizedAt: null, cancellationStopAuthorizedLeaseExpiresAt: null,
    dispatchedAt: now, runnerUnit: 'osi-image-builder-runner@job-1.service',
    runnerLeaseOwner: null, runnerLeaseExpiresAt: null,
    containerId: 'container-secret', containerName: 'builder-job-1', containerImageDigest: 'sha256:image',
    containerLabelJobId: id, containerLabelManifestSha: 'b'.repeat(64),
    containerLabels: { 'org.osi.image-builder.job-id': id }, containerMount: { source: '/private' },
    containerEnvironment: { GIT_SSH_COMMAND: 'secret' }, containerSecurity: { network: 'none' }, containerInspection: null,
    containerCreatedAt: now, containerStartedAt: now, containerStoppedAt: now, containerRemovedAt: now,
    containerCleanupOutcome: 'removed', cleanupBlockerCode: null, cleanupBlocker: null,
    terminalErrorCode: null, terminalError: null, terminalAt: now,
    artifactStagingPath: 'staging/job-1/image', artifactQuarantinePath: null, artifactQuarantineIntentPath: null,
    artifactFinalDirectory: `main/${sha}/rpi-5`, artifactFinalPath: `main/${sha}/rpi-5/image`, artifactSha256: 'c'.repeat(64),
    artifactSize: 123, artifactMtime: now, checksumPath: 'release/job-1/SHA256SUMS', checksumSha256: 'c'.repeat(64),
    manifestPath: 'release/job-1/manifest.json', manifestSha256: 'c'.repeat(64),
    verificationPath: 'release/job-1/verification.json', verificationSha256: 'c'.repeat(64),
    publishState: 'published', publishStartedAt: now, publishedAt: now, publishBlockerCode: null, publishBlocker: null,
    freshnessStatus: 'fresh', freshnessObservedSha: sha, newerSourceAvailable: false,
    freshnessRequestedAt: now, freshnessCheckedAt: now, freshnessErrorCode: null, freshnessError: null,
    freshnessErrorEvidencePath: null, freshnessErrorEvidenceSha256: null,
  } as const;
}

function dependencies(mutator?: (dependencies: ApiRouteDependencies) => void): ApiRouteDependencies {
  const record = job('job-1');
  const stage = {
    jobId: 'job-1', stage: 'publish' as const, outcome: 'passed' as const,
    startedAt: now, finishedAt: now, evidencePath: 'jobs/job-1/evidence/09-publish.json', evidenceSha256: 'd'.repeat(64),
    errorCode: null, error: null,
  };
  const result = {
    version: 'test-version',
    config: {
      repository: { path: '/srv/osi-os', remote: 'origin' },
      approvedOutputRoots: [{ id: 'release', label: 'Release images', path: '/srv/images', quarantinePath: '/srv/images/.quarantine' }],
      builderLockPath: '/srv/state/lock', maxQueueLength: 4, diskFreeMinimumBytes: 1,
    },
    targets: [{
      id: 'rpi-5', label: 'Raspberry Pi 5', environment: 'bcm2712', openwrtTarget: 'bcm27xx/bcm2712', profile: 'DEVICE_rpi-5', rootfs: 'ext4', artifactGlob: '*.img',
      rootfsPartSize: 14336, minimumArtifactBytes: 67108864,
      configSymbols: [{ name: 'CONFIG_TARGET_PROFILE', type: 'string', value: 'DEVICE_rpi-5' }],
      operations: ['activate-target'],
    }],
    health: () => ({ activeJobId: 'job-1' }),
    branches: {
      get: async () => ({ fetchedAt: now, branches: [{ name: 'main', sha, commitTime: now, subject: 'subject' }] }),
      refresh: async () => ({ fetchedAt: now, branches: [{ name: 'main', sha, commitTime: now, subject: 'subject' }] }),
    },
    preflight: {
      run: async (preflightRequest: { branch: string; expectedSha: string; targetId: string; outputRootId: string }) => ({
        preflightId: 'pf_test_01',
        ...preflightRequest,
        observedSha: preflightRequest.expectedSha,
        target: { id: preflightRequest.targetId },
        outputRoot: { id: preflightRequest.outputRootId },
        createdAt: now,
        expiresAt: '2026-07-28T10:10:00.000Z',
        checks: [{ id: 'source-sha', status: 'passed', details: { expectedSha: preflightRequest.expectedSha, observedSha: preflightRequest.expectedSha, remote: 'origin' } }],
      }),
    },
    enqueue: {
      acceptAfterRefetchAndPersist: async (
        enqueueRequest: { branch: string; expectedSha: string; targetId: string; outputRootId: string },
        requestId: string,
      ) => persistedAcceptance({
        jobId: 'job-queued',
        requestId,
        state: 'queued',
        queuePosition: 0,
        branch: enqueueRequest.branch,
        expectedSha: enqueueRequest.expectedSha,
        pinnedSha: enqueueRequest.expectedSha,
        targetId: enqueueRequest.targetId,
        rootId: enqueueRequest.outputRootId,
      }),
    },
    now: () => now,
    cancellation: {
      requestCancellation: async (requestValue: { jobId: string }) => ({
        kind: 'already-terminal',
        jobId: requestValue.jobId,
        state: 'succeeded',
        requestPersisted: false,
      }),
    },
    recovery: {
      recover: async (requestValue: { jobId: string }) => ({
        kind: 'not-eligible',
        jobId: requestValue.jobId,
      }),
    },
    eventStream: {
      open: async function* (jobId: string, afterSeq: number) {
        yield `id: ${afterSeq + 1}\nevent: terminal\ndata: ${JSON.stringify({ jobId, state: 'succeeded' })}\n\n`;
      },
    },
    store: {
      listJobs: async ({ cursor, limit }: { cursor: string | null; limit: number }) => ({ jobs: [record], nextCursor: cursor === null && limit === 1 ? 'next-page' : null }),
      getJob: (id: string) => id === 'job-1' ? record : (() => { throw new StoreNotFoundError('not found'); })(),
      getRecoveryJob: (id: string) => id === 'job-1' ? {
        ...record,
        cleanupFenceGeneration: null,
        cleanupAdmissionId: null,
        cleanupLeaseStatus: null,
        cleanupLeaseExpiresAt: null,
        cleanupLeaseBlockerCode: null,
        cleanupLeaseBlocker: null,
      } : (() => { throw new StoreNotFoundError('not found'); })(),
      getStage: (id: string, requestedStage: typeof stage.stage) => id === 'job-1' && requestedStage === 'publish' ? stage : null,
      getTerminalEvent: (id: string) => id === 'job-1' ? {
        jobId: id,
        seq: 3,
        eventType: 'terminal' as const,
        state: 'succeeded' as const,
        stage: 'publish' as const,
        payload: { state: 'succeeded', errorCode: null },
        at: now,
      } : null,
      listEvents: (id: string, options?: { afterSeq?: number; limit?: number }) => id === 'job-1'
        ? (options?.afterSeq ?? -1) >= 2
          ? { events: [], nextAfterSeq: null }
          : {
            events: [{ jobId: id, seq: 2, eventType: 'terminal' as const, state: 'succeeded' as const, stage: 'publish' as const, payload: { artifactFinalPath: '/private', token: 'secret' }, at: now }],
            nextAfterSeq: options?.afterSeq === 0 ? 2 : null,
          }
        : (() => { throw new StoreNotFoundError('not found'); })(),
    },
    evidenceReader: { read: async () => ({
      schemaVersion: 1,
      jobId: 'job-1',
      stage: 'publish',
      startedAt: now,
      finishedAt: now,
      outcome: 'passed',
      operationId: null,
      commands: [],
      inputs: { targetId: 'rpi-5', rootId: 'release', branch: 'main', pinnedSha: sha },
      observations: { artifactSha256: 'c'.repeat(64) },
      error: null,
    }) },
  } as ApiRouteDependencies;
  mutator?.(result);
  return result;
}

async function start(routeDependencies = dependencies()) {
  const server = createHttpServer({ origin: 'http://127.0.0.1:0', routeHandler: createApiRouteHandler(routeDependencies) });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return { server, port: address.port };
}

async function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const requestValue = request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    requestValue.on('error', reject);
    requestValue.end();
  });
}

async function post(port: number, path: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const requestValue = request({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', ...headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    requestValue.on('error', reject);
    requestValue.end(body);
  });
}

async function getText(port: number, path: string): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const requestValue = request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    requestValue.on('error', reject);
    requestValue.end();
  });
}

let server: ReturnType<typeof createHttpServer> | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

describe('read-only builder API routes', () => {
  it('serves typed read DTOs without internal paths or credentials', async () => {
    const started = await start(); server = started.server;
    const health = await get(started.port, '/api/health');
    expect(health).toEqual({ status: 200, body: { status: 'ok', version: 'test-version', activeJobId: 'job-1' } });

    const config = await get(started.port, '/api/config');
    expect(config.body).toEqual(expect.objectContaining({ repository: { path: '/srv/osi-os', remote: 'origin' }, approvedOutputRoots: [{ id: 'release', label: 'Release images', path: '/srv/images' }] }));
    expect(JSON.stringify(config.body)).not.toContain('lock');
    expect(config.body).toEqual(expect.objectContaining({ targets: [{
      id: 'rpi-5', label: 'Raspberry Pi 5', environment: 'bcm2712', openwrtTarget: 'bcm27xx/bcm2712', profile: 'DEVICE_rpi-5', rootfs: 'ext4', artifactGlob: '*.img',
      rootfsPartSize: 14336, minimumArtifactBytes: 67108864,
      configSymbols: [{ name: 'CONFIG_TARGET_PROFILE', type: 'string', value: 'DEVICE_rpi-5' }], operations: ['activate-target'],
    }] }));

    expect((await get(started.port, '/api/branches')).body).toEqual({ fetchedAt: now, branches: [{ name: 'main', sha, commitTime: now, subject: 'subject' }] });
    const jobs = await get(started.port, '/api/jobs?limit=1');
    expect(jobs).toMatchObject({ status: 200, body: { jobs: [{ id: 'job-1', state: 'succeeded', branch: 'main', targetId: 'rpi-5', outputRootId: 'release' }], nextCursor: 'next-page' } });

    const detail = await get(started.port, '/api/jobs/job-1');
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toMatch(/private|secret|staging|container-secret/);
    expect(detail.body).toMatchObject({
      id: 'job-1', state: 'succeeded', stage: 'publish', branch: 'main', pinnedSha: sha, targetId: 'rpi-5', outputRootId: 'release',
      queuePosition: null, cancelRequestedAt: null,
      artifact: {
        rootId: 'release', directory: `main/${sha}/rpi-5`, path: `main/${sha}/rpi-5/image`,
        sha256: 'c'.repeat(64), size: 123, mtime: now, publishState: 'published', publishedAt: now,
      },
      freshnessStatus: 'fresh', freshnessCheckedAt: now, newerSourceAvailable: false, error: null,
      source: expect.objectContaining({ branch: 'main', pinnedSha: sha }),
      evidence: [expect.objectContaining({ stage: 'publish', outcome: 'passed', path: 'evidence/09-publish.json', evidenceSha256: 'd'.repeat(64) })],
    });

    const evidence = await get(started.port, '/api/jobs/job-1/evidence/publish');
    expect(evidence.body).toEqual({
      schemaVersion: 1, jobId: 'job-1', stage: 'publish', startedAt: now, finishedAt: now,
      outcome: 'passed', operationId: null, commands: [], inputs: { targetId: 'rpi-5', rootId: 'release', branch: 'main', pinnedSha: sha },
      observations: { artifactSha256: 'c'.repeat(64) }, error: null,
    });
    const events = await get(started.port, '/api/jobs/job-1/events?after=0');
    expect(events.body).toEqual({ events: [{ seq: 2, event: 'terminal', state: 'succeeded', stage: 'publish', at: now, data: {} }], next: 2 });
    expect((await get(started.port, '/api/jobs/job-1/events?after=2')).body).toEqual({ events: [], next: 2 });
  });

  it('uses get for reads and refresh for the exact empty-object refresh request', async () => {
    let gets = 0;
    let refreshes = 0;
    const started = await start(dependencies((value) => {
      Object.assign(value as object, {
        branches: {
          get: async () => {
            gets += 1;
            return { fetchedAt: now, branches: [{ name: 'main', sha, commitTime: now, subject: 'subject' }] };
          },
          refresh: async () => {
            refreshes += 1;
            return { fetchedAt: now, branches: [{ name: 'main', sha, commitTime: now, subject: 'subject' }] };
          },
        },
      });
    }));
    server = started.server;

    const read = await get(started.port, '/api/branches');
    const refreshed = await post(started.port, '/api/branches/refresh', '{}');

    expect(read).toEqual({ status: 200, body: { fetchedAt: now, branches: [{ name: 'main', sha, commitTime: now, subject: 'subject' }] } });
    expect(refreshed).toEqual(read);
    expect(gets).toBe(1);
    expect(refreshes).toBe(1);
  });

  it.each(['null', '[]', '{"extra":true}', '{"__proto__":null}'])('rejects non-exact refresh body %s', async (body) => {
    const refresh = vi.fn(async () => ({ fetchedAt: now, branches: [] }));
    const started = await start(dependencies((value) => {
      Object.assign(value as object, { branches: { get: async () => ({ fetchedAt: now, branches: [] }), refresh } });
    }));
    server = started.server;

    const response = await post(started.port, '/api/branches/refresh', body);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('rejects a missing refresh body without calling refresh', async () => {
    const refresh = vi.fn(async () => ({ fetchedAt: now, branches: [] }));
    const started = await start(dependencies((value) => {
      Object.assign(value as object, { branches: { get: async () => ({ fetchedAt: now, branches: [] }), refresh } });
    }));
    server = started.server;

    const response = await post(started.port, '/api/branches/refresh', '');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('maps refresh fetch and validation failures to GIT_FETCH_FAILED', async () => {
    const started = await start(dependencies((value) => {
      Object.assign(value as object, {
        branches: {
          get: async () => ({ fetchedAt: now, branches: [] }),
          refresh: async () => { throw new Error('remote unavailable'); },
        },
      });
    }));
    server = started.server;

    const response = await post(started.port, '/api/branches/refresh', '{}');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: { code: 'GIT_FETCH_FAILED' } });
  });

  it.each([
    ['sparse', () => new Array(1)],
    ['accessor-backed', () => {
      const branches: unknown[] = [];
      Object.defineProperty(branches, '0', {
        enumerable: true,
        configurable: true,
        get: () => ({ name: 'main', sha, commitTime: now, subject: 'subject' }),
      });
      return branches;
    }],
  ])('rejects %s branch arrays from a malicious cache dependency', async (_description, makeBranches) => {
    const started = await start(dependencies((value) => {
      Object.assign(value as object, {
        branches: {
          get: async () => ({ fetchedAt: now, branches: makeBranches() }),
          refresh: async () => ({ fetchedAt: now, branches: [] }),
        },
      });
    }));
    server = started.server;

    const response = await get(started.port, '/api/branches');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: { code: 'GIT_FETCH_FAILED' } });
  });

  it('isolates branch routes by method', async () => {
    const started = await start();
    server = started.server;

    expect((await get(started.port, '/api/branches/refresh')).status).toBe(404);
    expect((await post(started.port, '/api/branches', '{}')).status).toBe(404);
    expect((await post(started.port, '/api/branches/refresh', '{}', { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('runs preflight with an exact request and projects only safe result fields', async () => {
    const run = vi.fn(async (preflightRequest: { branch: string; expectedSha: string; targetId: string; outputRootId: string }) => ({
      preflightId: 'pf_safe_01',
      ...preflightRequest,
      observedSha: preflightRequest.expectedSha,
      source: { author: 'private author', subject: 'private subject', originUrl: 'ssh://secret@example.test/repository' },
      target: { id: preflightRequest.targetId, privatePath: '/private/target' },
      outputRoot: { id: preflightRequest.outputRootId, path: '/private/output' },
      createdAt: now,
      expiresAt: '2026-07-28T10:10:00.000Z',
      checks: [
        {
          id: 'source-sha',
          status: 'passed',
          details: {
            expectedSha: preflightRequest.expectedSha,
            observedSha: preflightRequest.expectedSha,
            remote: 'origin',
            path: '/private/repository',
            version: 'secret-version',
          },
        },
        {
          id: 'disk-output',
          status: 'passed',
          details: { freeBytes: 1_000_000, minimumBytes: 500_000, path: '/private/output' },
        },
      ],
    }));
    const started = await start(dependencies((value) => {
      Object.assign(value as object, { preflight: { run } });
    }));
    server = started.server;
    const requestBody = { branch: 'main', expectedSha: sha, targetId: 'rpi-5', outputRootId: 'release' };

    const response = await post(started.port, '/api/preflight', JSON.stringify(requestBody));

    expect(run).toHaveBeenCalledWith(requestBody);
    expect(response).toEqual({
      status: 200,
      body: {
        preflightId: 'pf_safe_01',
        observedSha: sha,
        expiresAt: '2026-07-28T10:10:00.000Z',
        checks: [
          { id: 'source-sha', status: 'passed', details: { expectedSha: sha, observedSha: sha, remote: 'origin' } },
          { id: 'disk-output', status: 'passed', details: { freeBytes: 1_000_000, minimumBytes: 500_000 } },
        ],
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/private|secret|version|author|subject|originUrl/u);
  });

  it.each([
    ['null', 'null'],
    ['array', '[]'],
    ['missing field', JSON.stringify({ branch: 'main', expectedSha: sha, targetId: 'rpi-5' })],
    ['extra field', JSON.stringify({ branch: 'main', expectedSha: sha, targetId: 'rpi-5', outputRootId: 'release', extra: true })],
    ['invalid branch', JSON.stringify({ branch: '../main', expectedSha: sha, targetId: 'rpi-5', outputRootId: 'release' })],
    ['invalid SHA', JSON.stringify({ branch: 'main', expectedSha: sha.toUpperCase(), targetId: 'rpi-5', outputRootId: 'release' })],
    ['unknown target', JSON.stringify({ branch: 'main', expectedSha: sha, targetId: 'rpi-9', outputRootId: 'release' })],
    ['unknown root', JSON.stringify({ branch: 'main', expectedSha: sha, targetId: 'rpi-5', outputRootId: 'private-path' })],
  ])('rejects %s preflight input before invoking the service', async (_description, body) => {
    const run = vi.fn();
    const started = await start(dependencies((value) => {
      Object.assign(value as object, { preflight: { run } });
    }));
    server = started.server;

    const response = await post(started.port, '/api/preflight', body);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ['branch movement', new PreflightError('BRANCH_MOVED', { expectedSha: sha, observedSha: 'b'.repeat(40) }), 409],
    ['retryable prerequisite', new PreflightError('SOURCE_UNAVAILABLE', {}), 503],
  ])('maps %s preflight failure to a stable status', async (_description, failure, status) => {
    const started = await start(dependencies((value) => {
      Object.assign(value as object, { preflight: { run: async () => { throw failure; } } });
    }));
    server = started.server;

    const response = await post(started.port, '/api/preflight', JSON.stringify({
      branch: 'main', expectedSha: sha, targetId: 'rpi-5', outputRootId: 'release',
    }));

    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ error: { code: failure.code, stage: 'preflight' } });
  });

  it('fails closed when preflight service output is not bound to the request', async () => {
    const started = await start(dependencies((value) => {
      Object.assign(value as object, {
        preflight: {
          run: async () => ({
            preflightId: 'pf_bad_01',
            branch: 'other',
            expectedSha: sha,
            observedSha: sha,
            target: { id: 'rpi-5' },
            outputRoot: { id: 'release' },
            createdAt: now,
            expiresAt: '2026-07-28T10:10:00.000Z',
            checks: [],
          }),
        },
      });
    }));
    server = started.server;

    const response = await post(started.port, '/api/preflight', JSON.stringify({
      branch: 'main', expectedSha: sha, targetId: 'rpi-5', outputRootId: 'release',
    }));

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });

  it('accepts an exact build request and returns only the bound queued job projection', async () => {
    let observedRequestId = '';
    const accept = vi.fn(async (
      enqueueRequest: { branch: string; expectedSha: string; targetId: string; outputRootId: string; preflightId?: string },
      requestId: string,
    ) => {
      observedRequestId = requestId;
      return persistedAcceptance({
        jobId: '20260728T100000Z-01J4D5YQG7M9R2C6N8P0S1T3V',
        requestId,
        state: 'queued',
        queuePosition: 2,
        branch: enqueueRequest.branch,
        expectedSha: enqueueRequest.expectedSha,
        pinnedSha: enqueueRequest.expectedSha,
        targetId: enqueueRequest.targetId,
        rootId: enqueueRequest.outputRootId,
        artifactStagingPath: '/private/staging',
        sourceAuthor: 'private author',
      });
    });
    const started = await start(dependencies((value) => {
      Object.assign(value as object, { enqueue: { acceptAfterRefetchAndPersist: accept } });
    }));
    server = started.server;
    const requestBody = {
      branch: 'main',
      expectedSha: sha,
      targetId: 'rpi-5',
      outputRootId: 'release',
      preflightId: 'pf_safe_01',
    };

    const response = await post(started.port, '/api/jobs', JSON.stringify(requestBody));

    expect(accept).toHaveBeenCalledWith(requestBody, observedRequestId);
    expect(observedRequestId).toMatch(/^req_[a-z0-9]+_[0-9a-f]{32}$/u);
    expect(response).toEqual({
      status: 202,
      body: {
        job: {
          id: '20260728T100000Z-01J4D5YQG7M9R2C6N8P0S1T3V',
          state: 'queued',
          queuePosition: 2,
          branch: 'main',
          targetId: 'rpi-5',
          outputRootId: 'release',
        },
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/private|author|staging/u);
  });

  it('allows trusted automation to enqueue without a preflight token', async () => {
    const accept = vi.fn(async (
      enqueueRequest: { branch: string; expectedSha: string; targetId: string; outputRootId: string },
      requestId: string,
    ) => persistedAcceptance({
      jobId: 'job-automation',
      requestId,
      state: 'queued',
      queuePosition: 0,
      branch: enqueueRequest.branch,
      expectedSha: enqueueRequest.expectedSha,
      pinnedSha: enqueueRequest.expectedSha,
      targetId: enqueueRequest.targetId,
      rootId: enqueueRequest.outputRootId,
    }));
    const started = await start(dependencies((value) => {
      Object.assign(value as object, { enqueue: { acceptAfterRefetchAndPersist: accept } });
    }));
    server = started.server;
    const requestBody = { branch: 'main', expectedSha: sha, targetId: 'rpi-5', outputRootId: 'release' };

    const response = await post(started.port, '/api/jobs', JSON.stringify(requestBody));

    expect(response.status).toBe(202);
    expect(accept.mock.calls[0]?.[0]).toEqual(requestBody);
  });

  it.each([
    ['null', 'null'],
    ['array', '[]'],
    ['missing field', JSON.stringify({ branch: 'main', expectedSha: sha, targetId: 'rpi-5' })],
    ['extra field', JSON.stringify({ branch: 'main', expectedSha: sha, targetId: 'rpi-5', outputRootId: 'release', extra: true })],
    ['invalid preflight ID', JSON.stringify({ branch: 'main', expectedSha: sha, targetId: 'rpi-5', outputRootId: 'release', preflightId: '../pf' })],
    ['invalid branch', JSON.stringify({ branch: '../main', expectedSha: sha, targetId: 'rpi-5', outputRootId: 'release' })],
    ['invalid SHA', JSON.stringify({ branch: 'main', expectedSha: sha.toUpperCase(), targetId: 'rpi-5', outputRootId: 'release' })],
    ['unknown target', JSON.stringify({ branch: 'main', expectedSha: sha, targetId: 'rpi-9', outputRootId: 'release' })],
    ['unknown root', JSON.stringify({ branch: 'main', expectedSha: sha, targetId: 'rpi-5', outputRootId: 'private' })],
  ])('rejects %s enqueue input before acceptance', async (_description, body) => {
    const accept = vi.fn();
    const started = await start(dependencies((value) => {
      Object.assign(value as object, { enqueue: { acceptAfterRefetchAndPersist: accept } });
    }));
    server = started.server;

    const response = await post(started.port, '/api/jobs', body);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(accept).not.toHaveBeenCalled();
  });

  it('returns 409 without a job projection when the branch moved during acceptance', async () => {
    const started = await start(dependencies((value) => {
      Object.assign(value as object, {
        enqueue: {
          acceptAfterRefetchAndPersist: async () => {
            throw new PreflightError('BRANCH_MOVED', { expectedSha: sha, observedSha: 'b'.repeat(40) });
          },
        },
      });
    }));
    server = started.server;

    const response = await post(started.port, '/api/jobs', JSON.stringify({
      branch: 'main', expectedSha: sha, targetId: 'rpi-5', outputRootId: 'release',
    }));

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: { code: 'BRANCH_MOVED', details: { expectedSha: sha, observedSha: 'b'.repeat(40) } },
    });
    expect(JSON.stringify(response.body)).not.toContain('"job"');
  });

  it('fails closed when the accepted job is not queued or bound to the request', async () => {
    const started = await start(dependencies((value) => {
      Object.assign(value as object, {
        enqueue: {
          acceptAfterRefetchAndPersist: async () => persistedAcceptance({
            jobId: 'job-invalid',
            state: 'succeeded',
            queuePosition: null,
            branch: 'other',
            targetId: 'rpi-5',
            rootId: 'release',
          }),
        },
      });
    }));
    server = started.server;

    const response = await post(started.port, '/api/jobs', JSON.stringify({
      branch: 'main', expectedSha: sha, targetId: 'rpi-5', outputRootId: 'release',
    }));

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });

  it('rejects a queued job without second-fetch and atomic-persistence proof', async () => {
    const started = await start(dependencies((value) => {
      Object.assign(value as object, {
        enqueue: {
          acceptAfterRefetchAndPersist: async () => ({
            kind: 'persisted-queued-job',
            secondOriginFetch: 'skipped',
            persistence: 'job-only',
            job: {
              jobId: 'job-unproven',
              requestId: 'unbound',
              state: 'queued',
              queuePosition: 0,
              branch: 'main',
              expectedSha: sha,
              pinnedSha: sha,
              targetId: 'rpi-5',
              rootId: 'release',
            },
          }),
        },
      });
    }));
    server = started.server;

    const response = await post(started.port, '/api/jobs', JSON.stringify({
      branch: 'main', expectedSha: sha, targetId: 'rpi-5', outputRootId: 'release',
    }));

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });

  it('cancels a queued job with operator reason and returns the updated job detail', async () => {
    const cancelled = {
      ...job('job-1'),
      state: 'cancelled' as const,
      currentStage: null,
      queueState: 'cancelled',
      queuePosition: null,
      cancelRequestedAt: now,
      cancelReason: 'operator',
      dispatchedAt: null,
      runnerUnit: null,
      terminalErrorCode: 'CANCELLED' as const,
      terminalError: { reason: 'operator' },
      terminalAt: now,
    };
    const requestCancellation = vi.fn(async () => ({
      kind: 'queued-cancelled',
      jobId: 'job-1',
      state: 'cancelled',
      requestPersisted: true,
    }));
    const started = await start(dependencies((value) => {
      Object.assign(value as object, {
        now: () => now,
        cancellation: { requestCancellation },
      });
      Object.assign(value.store as object, {
        getJob: (id: string) => id === 'job-1' ? cancelled : (() => { throw new StoreNotFoundError('not found'); })(),
      });
    }));
    server = started.server;

    const response = await post(started.port, '/api/jobs/job-1/cancel', '{}');

    expect(requestCancellation).toHaveBeenCalledWith({ jobId: 'job-1', reason: 'operator', at: now });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: 'job-1',
      state: 'cancelled',
      queuePosition: null,
      cancelRequestedAt: now,
      error: { code: 'CANCELLED' },
    });
  });

  it.each(['null', '[]', '{"extra":true}', ''])('rejects non-empty-object cancel body %s', async (body) => {
    const requestCancellation = vi.fn();
    const started = await start(dependencies((value) => {
      Object.assign(value as object, { cancellation: { requestCancellation } });
    }));
    server = started.server;

    const response = await post(started.port, '/api/jobs/job-1/cancel', body);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(requestCancellation).not.toHaveBeenCalled();
  });

  it('returns 409 for a terminal cancellation result', async () => {
    const started = await start(dependencies((value) => {
      Object.assign(value as object, {
        cancellation: {
          requestCancellation: async () => ({
            kind: 'already-terminal',
            jobId: 'job-1',
            state: 'succeeded',
            requestPersisted: false,
          }),
        },
      });
    }));
    server = started.server;

    const response = await post(started.port, '/api/jobs/job-1/cancel', '{}');

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: 'CANCELLATION_TERMINAL' } });
  });

  it('does not invoke cancellation for an unknown job', async () => {
    const requestCancellation = vi.fn();
    const started = await start(dependencies((value) => {
      Object.assign(value as object, { cancellation: { requestCancellation } });
    }));
    server = started.server;

    const response = await post(started.port, '/api/jobs/missing/cancel', '{}');

    expect(response.status).toBe(404);
    expect(requestCancellation).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown kind', { kind: 'unknown', jobId: 'job-1' }],
    ['wrong job', { kind: 'queued-cancelled', jobId: 'job-other', state: 'cancelled', requestPersisted: true }],
    ['uncommitted success', { kind: 'queued-cancelled', jobId: 'job-1', state: 'cancelled', requestPersisted: true }],
    ['missing terminal state', { kind: 'already-terminal', jobId: 'job-1', requestPersisted: false }],
    ['wrong terminal persistence', { kind: 'already-terminal', jobId: 'job-1', state: 'succeeded', requestPersisted: true }],
    ['missing late marker', { kind: 'late-publishing', jobId: 'job-1', state: 'publishing', requestPersisted: true }],
    ['wrong runner ownership', { kind: 'runner-terminal', jobId: 'job-1', state: 'succeeded', runnerOwned: false }],
    ['missing recovery evidence', { kind: 'recovery-blocked', jobId: 'job-1', state: 'building', blockerCode: 'RUNNER_DISAPPEARED', requestPersisted: true }],
    ['wrong recovery blocker', { kind: 'recovery-blocked', jobId: 'job-1', state: 'building', blockerCode: 'OTHER', requestPersisted: true, evidence: {} }],
    ['missing coordination deadline', { kind: 'coordination-pending', jobId: 'job-1', state: 'building', requestPersisted: true, cancellationClockHighWaterAt: now }],
    ['missing rejection evidence', { kind: 'request-not-accepted', jobId: 'job-1', state: 'succeeded' }],
  ])('fails closed on cancellation result with %s', async (_description, result) => {
    const started = await start(dependencies((value) => {
      Object.assign(value as object, {
        cancellation: { requestCancellation: async () => result },
      });
    }));
    server = started.server;

    const response = await post(started.port, '/api/jobs/job-1/cancel', '{}');

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });

  it('rejects accessor-backed cancellation result fields', async () => {
    const result = {
      kind: 'already-terminal',
      jobId: 'job-1',
      requestPersisted: false,
      get state() { return 'succeeded'; },
    };
    const started = await start(dependencies((value) => {
      Object.assign(value as object, {
        cancellation: { requestCancellation: async () => result },
      });
    }));
    server = started.server;

    const response = await post(started.port, '/api/jobs/job-1/cancel', '{}');

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });

  it.each([
    ['runner terminal without a persisted request', { kind: 'runner-terminal', jobId: 'job-1', state: 'succeeded', runnerOwned: true }],
    ['terminal state mismatch', { kind: 'already-terminal', jobId: 'job-1', state: 'failed', requestPersisted: false }],
    ['rejection state mismatch', { kind: 'request-not-accepted', jobId: 'job-1', state: 'building', evidence: {} }],
    ['recovery without a durable blocker', { kind: 'recovery-blocked', jobId: 'job-1', state: 'building', blockerCode: 'RUNNER_DISAPPEARED', requestPersisted: true, evidence: {} }],
  ])('fails closed on cancellation result/store mismatch: %s', async (_description, result) => {
    const started = await start(dependencies((value) => {
      Object.assign(value as object, {
        cancellation: { requestCancellation: async () => result },
      });
    }));
    server = started.server;

    const response = await post(started.port, '/api/jobs/job-1/cancel', '{}');

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });

  it('rejects a queued-cancelled result backed by a runner-owned terminal record', async () => {
    const runnerCancelled = {
      ...job('job-1'),
      state: 'cancelled' as const,
      queueState: 'complete',
      queuePosition: null,
      cancelRequestedAt: now,
      cancelReason: 'operator',
      terminalErrorCode: 'CANCELLED' as const,
      terminalError: { reason: 'cancelled' },
      terminalAt: now,
    };
    const started = await start(dependencies((value) => {
      Object.assign(value as object, {
        cancellation: {
          requestCancellation: async () => ({
            kind: 'queued-cancelled',
            jobId: 'job-1',
            state: 'cancelled',
            requestPersisted: true,
          }),
        },
      });
      Object.assign(value.store as object, { getJob: () => runnerCancelled });
    }));
    server = started.server;

    expect((await post(started.port, '/api/jobs/job-1/cancel', '{}')).status).toBe(500);
  });

  it('rejects late-publishing without durable late chronology', async () => {
    const publishing = {
      ...job('job-1'),
      state: 'publishing' as const,
      cancelRequestedAt: now,
      cancelReason: 'operator',
      publishStartedAt: now,
      terminalAt: null,
      terminalErrorCode: null,
      terminalError: null,
    };
    const started = await start(dependencies((value) => {
      Object.assign(value as object, {
        cancellation: {
          requestCancellation: async () => ({
            kind: 'late-publishing',
            jobId: 'job-1',
            state: 'publishing',
            late: true,
            requestPersisted: true,
          }),
        },
      });
      Object.assign(value.store as object, { getJob: () => publishing });
    }));
    server = started.server;

    expect((await post(started.port, '/api/jobs/job-1/cancel', '{}')).status).toBe(500);
  });

  it('accepts late-publishing only after the durable publish start', async () => {
    const publishing = {
      ...job('job-1'),
      state: 'publishing' as const,
      cancelRequestedAt: later,
      cancelReason: 'operator',
      publishStartedAt: now,
      terminalAt: null,
      terminalErrorCode: null,
      terminalError: null,
    };
    const started = await start(dependencies((value) => {
      Object.assign(value as object, {
        now: () => later,
        cancellation: {
          requestCancellation: async () => ({
            kind: 'late-publishing',
            jobId: 'job-1',
            state: 'publishing',
            late: true,
            requestPersisted: true,
          }),
        },
      });
      Object.assign(value.store as object, { getJob: () => publishing });
    }));
    server = started.server;

    expect((await post(started.port, '/api/jobs/job-1/cancel', '{}')).status).toBe(200);
  });

  it('accepts runner-terminal only with the exact durable runner terminal event', async () => {
    const runnerCancelled = {
      ...job('job-1'),
      state: 'cancelled' as const,
      queueState: 'complete',
      queuePosition: null,
      cancelRequestedAt: now,
      cancelReason: 'operator',
      terminalErrorCode: 'CANCELLED' as const,
      terminalError: { reason: 'cancelled' },
      terminalAt: now,
    };
    const started = await start(dependencies((value) => {
      Object.assign(value as object, {
        cancellation: {
          requestCancellation: async () => ({
            kind: 'runner-terminal',
            jobId: 'job-1',
            state: 'cancelled',
            runnerOwned: true,
          }),
        },
      });
      Object.assign(value.store as object, {
        getJob: () => runnerCancelled,
        getTerminalEvent: () => ({
          jobId: 'job-1',
          seq: 4,
          eventType: 'terminal',
          state: 'cancelled',
          stage: 'publish',
          payload: { state: 'cancelled', errorCode: 'CANCELLED', cleanupEventSeq: 3 },
          at: now,
        }),
      });
    }));
    server = started.server;

    expect((await post(started.port, '/api/jobs/job-1/cancel', '{}')).status).toBe(200);
  });

  it('rejects an API recovery terminal reported as runner-owned', async () => {
    const recovered = {
      ...job('job-1'),
      state: 'interrupted' as const,
      queueState: 'complete',
      queuePosition: null,
      cancelRequestedAt: now,
      cancelReason: 'operator',
      terminalErrorCode: 'RUNNER_DISAPPEARED' as const,
      terminalError: { reason: 'recovered' },
      terminalAt: later,
    };
    const started = await start(dependencies((value) => {
      Object.assign(value as object, {
        cancellation: {
          requestCancellation: async () => ({
            kind: 'runner-terminal',
            jobId: 'job-1',
            state: 'interrupted',
            runnerOwned: true,
          }),
        },
      });
      Object.assign(value.store as object, {
        getJob: () => recovered,
        getTerminalEvent: () => ({
          jobId: 'job-1',
          seq: 4,
          eventType: 'terminal',
          state: 'interrupted',
          stage: 'publish',
          payload: { state: 'interrupted', errorCode: 'RUNNER_DISAPPEARED', error: { reason: 'recovered' } },
          at: later,
        }),
      });
    }));
    server = started.server;

    expect((await post(started.port, '/api/jobs/job-1/cancel', '{}')).status).toBe(500);
  });

  it('returns the durably re-read interrupted job after direct recovery', async () => {
    const recovered = {
      ...job('job-1'),
      state: 'interrupted' as const,
      queueState: 'complete',
      queuePosition: null,
      terminalErrorCode: 'RUNNER_DISAPPEARED' as const,
      terminalError: { reason: 'direct recovery completed' },
      terminalAt: later,
      cleanupFenceGeneration: null,
      cleanupAdmissionId: null,
      cleanupBlockerCode: null,
      cleanupBlocker: null,
      cleanupLeaseStatus: null,
      cleanupLeaseExpiresAt: null,
      cleanupLeaseBlockerCode: null,
      cleanupLeaseBlocker: null,
    };
    const recover = vi.fn(async () => ({
      kind: 'direct-recovered' as const,
      jobId: 'job-1',
      terminalAt: later,
      terminalEventSeq: 4,
    }));
    const started = await start(dependencies((value) => {
      Object.assign(value as object, { recovery: { recover } });
      Object.assign(value.store as object, {
        getJob: () => recovered,
        getRecoveryJob: () => recovered,
        getTerminalEvent: () => ({
          jobId: 'job-1',
          seq: 4,
          eventType: 'terminal',
          state: 'interrupted',
          stage: 'publish',
          payload: { state: 'interrupted', errorCode: 'RUNNER_DISAPPEARED', error: { reason: 'direct recovery completed' } },
          at: later,
        }),
      });
    }));
    server = started.server;

    const response = await post(started.port, '/api/jobs/job-1/recover', '{}');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: 'job-1', state: 'interrupted' });
    expect(recover).toHaveBeenCalledWith({ jobId: 'job-1', retry: false, at: now });
  });

  it('returns cleanup admission evidence only after the durable fence matches', async () => {
    const admissionId = 'cln_0123456789abcdefghjkmnpqrs';
    const pending = {
      ...job('job-1'),
      state: 'verifying' as const,
      queueState: 'dispatched',
      currentStage: 'verify' as const,
      terminalErrorCode: null,
      terminalError: null,
      terminalAt: null,
      artifactStagingPath: 'staging/job-1/image',
      artifactFinalDirectory: null,
      artifactFinalPath: null,
      checksumPath: 'staging/job-1/SHA256SUMS',
      manifestPath: 'staging/job-1/manifest.json',
      verificationPath: 'staging/job-1/verification.json',
      publishState: 'staged' as const,
      publishStartedAt: null,
      publishedAt: null,
      cleanupFenceGeneration: 3,
      cleanupAdmissionId: admissionId,
      cleanupBlockerCode: null,
      cleanupBlocker: null,
    };
    const recover = vi.fn(async () => ({
      kind: 'cleanup-pending' as const,
      jobId: 'job-1',
      admissionId,
      generation: 3,
    }));
    const started = await start(dependencies((value) => {
      Object.assign(value as object, { recovery: { recover } });
      Object.assign(value.store as object, {
        getJob: () => pending,
        getRecoveryJob: () => ({
          ...pending,
          cleanupLeaseStatus: 'admitted',
          cleanupLeaseExpiresAt: '2026-07-28T10:05:00.000Z',
          cleanupLeaseBlockerCode: null,
          cleanupLeaseBlocker: null,
        }),
      });
    }));
    server = started.server;

    const response = await post(started.port, '/api/jobs/job-1/recover', '{"retry":true}');
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      job: { id: 'job-1', state: 'verifying' },
      recovery: 'cleanup_pending',
      cleanupLeaseId: admissionId,
    });
    expect(recover).toHaveBeenCalledWith({ jobId: 'job-1', retry: true, at: now });
  });

  it.each([
    ['not eligible', { kind: 'not-eligible', jobId: 'job-1' }, 'RECOVERY_NOT_ELIGIBLE'],
    ['cleanup in progress', { kind: 'cleanup-in-progress', jobId: 'job-1', admissionId: 'cln_0123456789abcdefghjkmnpqrs', generation: 2 }, 'CLEANUP_IN_PROGRESS'],
    ['retry blocker', { kind: 'retry-blocked', jobId: 'job-1', admissionId: 'cln_0123456789abcdefghjkmnpqrs', generation: 2, blockerCode: 'QUARANTINE_PENDING' }, 'CLEANUP_RETRY_BLOCKED'],
  ])('maps %s recovery outcomes to stable conflicts', async (_description, result, code) => {
    const started = await start(dependencies((value) => {
      Object.assign(value as object, { recovery: { recover: async () => result } });
      if ('generation' in result && 'admissionId' in result) {
      Object.assign(value.store as object, {
          getRecoveryJob: () => ({
            ...job('job-1'),
            cleanupFenceGeneration: result.generation,
            cleanupAdmissionId: result.admissionId,
            cleanupBlockerCode: 'blockerCode' in result ? result.blockerCode : null,
            cleanupBlocker: 'blockerCode' in result ? { code: result.blockerCode } : null,
            cleanupLeaseStatus: 'blockerCode' in result ? 'blocking' : 'claimed',
            cleanupLeaseExpiresAt: '2026-07-28T10:05:00.000Z',
            cleanupLeaseBlockerCode: 'blockerCode' in result ? result.blockerCode : null,
            cleanupLeaseBlocker: 'blockerCode' in result ? { code: result.blockerCode } : null,
          }),
        });
      }
    }));
    server = started.server;

    expect(await post(started.port, '/api/jobs/job-1/recover', '{}')).toMatchObject({
      status: 409,
      body: { error: { code } },
    });
  });

  it.each([
    ['retry false', '{"retry":false}'],
    ['unknown field', '{"retry":true,"force":true}'],
    ['non-object', '[]'],
  ])('rejects invalid recovery body: %s', async (_description, body) => {
    const recover = vi.fn();
    const started = await start(dependencies((value) => {
      Object.assign(value as object, { recovery: { recover } });
    }));
    server = started.server;

    expect((await post(started.port, '/api/jobs/job-1/recover', body)).status).toBe(400);
    expect(recover).not.toHaveBeenCalled();
  });

  it.each([
    ['extra result field', { kind: 'not-eligible', jobId: 'job-1', secret: 'leak' }],
    ['wrong job', { kind: 'direct-recovered', jobId: 'job-other', terminalAt: later, terminalEventSeq: 4 }],
    ['invalid internal job', { kind: 'direct-recovered', jobId: '../job', terminalAt: later, terminalEventSeq: 4 }],
    ['uncommitted direct recovery', { kind: 'direct-recovered', jobId: 'job-1', terminalAt: later, terminalEventSeq: 4 }],
    ['uncommitted cleanup fence', { kind: 'cleanup-pending', jobId: 'job-1', admissionId: 'cln_0123456789abcdefghjkmnpqrs', generation: 3 }],
  ])('fails closed for recovery result/store mismatch: %s', async (_description, result) => {
    const started = await start(dependencies((value) => {
      Object.assign(value as object, { recovery: { recover: async () => result } });
      Object.assign(value.store as object, {
        getRecoveryJob: () => ({
          ...job('job-1'),
          cleanupFenceGeneration: null,
          cleanupAdmissionId: null,
          cleanupLeaseStatus: null,
          cleanupLeaseExpiresAt: null,
          cleanupLeaseBlockerCode: null,
          cleanupLeaseBlocker: null,
        }),
      });
    }));
    server = started.server;

    expect((await post(started.port, '/api/jobs/job-1/recover', '{}')).status).toBe(500);
  });

  it('fails closed when cleanup hand-back races the cleanup-pending response', async () => {
    const admissionId = 'cln_0123456789abcdefghjkmnpqrs';
    let reads = 0;
    const pending = {
      ...job('job-1'),
      state: 'verifying' as const,
      queueState: 'dispatched',
      terminalAt: null,
      terminalErrorCode: null,
      terminalError: null,
      cleanupFenceGeneration: 3,
      cleanupAdmissionId: admissionId,
      cleanupLeaseStatus: 'admitted',
      cleanupLeaseExpiresAt: '2026-07-28T10:05:00.000Z',
      cleanupLeaseBlockerCode: null,
      cleanupLeaseBlocker: null,
    };
    const started = await start(dependencies((value) => {
      Object.assign(value as object, {
        recovery: {
          recover: async () => ({ kind: 'cleanup-pending', jobId: 'job-1', admissionId, generation: 3 }),
        },
      });
      Object.assign(value.store as object, {
        getJob: () => pending,
        getRecoveryJob: () => reads++ === 0 ? pending : {
          ...pending,
          state: 'interrupted',
          queueState: 'complete',
          cleanupFenceGeneration: null,
          cleanupAdmissionId: null,
          cleanupLeaseStatus: null,
          cleanupLeaseExpiresAt: null,
        },
      });
    }));
    server = started.server;

    expect((await post(started.port, '/api/jobs/job-1/recover', '{}')).status).toBe(500);
  });

  it('passes the exact stored evidence index to the indexed reader', async () => {
    const reader = vi.fn(async (index: EvidenceIndex) => {
      expect(Object.isFrozen(index)).toBe(true);
      expect(index.path).toBe('jobs/job-1/evidence/09-publish.json');
      return stageEvidence();
    });
    const routeDependencies = dependencies((value) => {
      Object.assign(value as object, { evidenceReader: { read: reader } });
    });
    const started = await start(routeDependencies); server = started.server;

    expect((await get(started.port, '/api/jobs/job-1/evidence/publish')).status).toBe(200);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith({
      jobId: 'job-1', stage: 'publish', path: 'jobs/job-1/evidence/09-publish.json', sha256: 'd'.repeat(64),
    });
    expect(Object.keys(reader.mock.calls[0]![0]!)).toEqual(['jobId', 'stage', 'path', 'sha256']);
  });

  it('rejects a display-short stored evidence path before invoking the reader', async () => {
    const reader = vi.fn(async () => stageEvidence());
    const routeDependencies = dependencies((value) => {
      Object.assign(value.store as object, {
        getStage: () => ({
          jobId: 'job-1', stage: 'publish' as const, outcome: 'passed' as const,
          startedAt: now, finishedAt: now, evidencePath: 'evidence/09-publish.json', evidenceSha256: 'd'.repeat(64),
          errorCode: null, error: null,
        }),
      });
      Object.assign(value as object, { evidenceReader: { read: reader } });
    });
    const started = await start(routeDependencies); server = started.server;

    expect((await get(started.port, '/api/jobs/job-1/evidence/publish')).status).toBe(500);
    expect(reader).not.toHaveBeenCalled();
  });

  it('rejects accessor-backed indexed stage fields without invoking the reader', async () => {
    const reader = vi.fn(async () => stageEvidence());
    let getterCalls = 0;
    let changingJobId = 'job-1';
    let changingStage = 'publish';
    let changingEvidencePath = 'jobs/job-1/evidence/09-publish.json';
    let changingEvidenceSha256 = 'd'.repeat(64);
    const routeDependencies = dependencies((value) => {
      const stored = {
        outcome: 'passed' as const, startedAt: now, finishedAt: now, errorCode: null, error: null,
      };
      Object.defineProperties(stored, {
        jobId: { get: () => { getterCalls += 1; const result = changingJobId; changingJobId = 'job-2'; return result; }, enumerable: true },
        stage: { get: () => { getterCalls += 1; const result = changingStage; changingStage = 'build'; return result; }, enumerable: true },
        evidencePath: { get: () => { getterCalls += 1; const result = changingEvidencePath; changingEvidencePath = 'evidence/07-build.json'; return result; }, enumerable: true },
        evidenceSha256: { get: () => { getterCalls += 1; const result = changingEvidenceSha256; changingEvidenceSha256 = 'e'.repeat(64); return result; }, enumerable: true },
      });
      Object.assign(value.store as object, { getStage: () => stored });
      Object.assign(value as object, { evidenceReader: { read: reader } });
    });
    const started = await start(routeDependencies); server = started.server;

    expect((await get(started.port, '/api/jobs/job-1/evidence/publish')).status).toBe(500);
    expect(getterCalls).toBe(0);
    expect(reader).not.toHaveBeenCalled();
  });

  it('returns not found and never reads indexed evidence with a null path or hash', async () => {
    for (const field of ['evidencePath', 'evidenceSha256'] as const) {
      const reader = vi.fn(async () => stageEvidence());
      const routeDependencies = dependencies((value) => {
        const stored = {
          jobId: 'job-1', stage: 'publish' as const, outcome: 'passed' as const,
          startedAt: now, finishedAt: now, evidencePath: 'jobs/job-1/evidence/09-publish.json', evidenceSha256: 'd'.repeat(64),
          errorCode: null, error: null,
          [field]: null,
        };
        Object.assign(value.store as object, { getStage: () => stored });
        Object.assign(value as object, { evidenceReader: { read: reader } });
      });
      const started = await start(routeDependencies); server = started.server;

      expect((await get(started.port, '/api/jobs/job-1/evidence/publish')).status).toBe(404);
      expect(reader).not.toHaveBeenCalled();
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
  });

  it('never reads evidence when the indexed row has mismatched identity', async () => {
    const reader = vi.fn(async () => stageEvidence());
    const routeDependencies = dependencies((value) => {
      Object.assign(value.store as object, {
        getStage: () => ({
          jobId: 'job-1', stage: 'build' as const, outcome: 'passed' as const,
          startedAt: now, finishedAt: now, evidencePath: 'jobs/job-1/evidence/07-build.json', evidenceSha256: 'd'.repeat(64),
          errorCode: null, error: null,
        }),
      });
      Object.assign(value as object, { evidenceReader: { read: reader } });
    });
    const started = await start(routeDependencies); server = started.server;

    expect((await get(started.port, '/api/jobs/job-1/evidence/publish')).status).toBe(500);
    expect(reader).not.toHaveBeenCalled();
  });

  it('returns a stable redacted 500 when the indexed reader fails', async () => {
    const reader = vi.fn(async () => {
      throw new Error('private path /srv/secret token=do-not-leak');
    });
    const routeDependencies = dependencies((value) => {
      Object.assign(value as object, { evidenceReader: { read: reader } });
    });
    const started = await start(routeDependencies); server = started.server;

    const response = await get(started.port, '/api/jobs/job-1/evidence/publish');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: 'INTERNAL_ERROR', message: 'The request could not be completed.', stage: null,
        details: {}, retryable: true, requestId: expect.stringMatching(/^req_/u),
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('do-not-leak');
    expect(JSON.stringify(response.body)).not.toContain('/srv/secret');
  });

  it('serves complete validated production failure evidence', async () => {
    const base = stageEvidence('build', 'failed');
    const evidence = {
      ...base,
      operationId: 'build-image' as const,
      error: {
        ...base.error!,
        details: { expectedSha: sha, observedSha: 'b'.repeat(40), operationId: 'build-image', secret: 'redact-me' },
        operationId: 'build-image' as const,
      },
    };
    const routeDependencies = dependencies();
    useEvidence(routeDependencies, evidence, 'build', 'failed');
    const started = await start(routeDependencies); server = started.server;

    expect(await get(started.port, '/api/jobs/job-1/evidence/build')).toEqual({
      status: 200,
      body: {
        schemaVersion: 1, jobId: 'job-1', stage: 'build', startedAt: now, finishedAt: later,
        outcome: 'failed', operationId: 'build-image', commands: [],
        inputs: { targetId: 'rpi-5', rootId: 'release', branch: 'main', pinnedSha: sha }, observations: { artifactSha256: 'c'.repeat(64) },
        error: {
          code: 'BUILD_FAILED',
          details: { expectedSha: sha, observedSha: 'b'.repeat(40), operationId: 'build-image' },
          stage: 'build', retryable: false, requestId: 'request-1',
          diagnosis: 'The stage failed.', recovery: 'Retry the stage.',
          evidencePath: 'jobs/job-1/evidence/07-build.json', operationId: 'build-image',
        },
      },
    });
  });

  it('rejects public failure evidence whose request ID does not belong to the owning job', async () => {
    const base = stageEvidence('build', 'failed');
    const routeDependencies = dependencies();
    useEvidence(routeDependencies, {
      ...base,
      error: { ...base.error!, requestId: 'credential-request-id' },
    }, 'build', 'failed');
    const started = await start(routeDependencies); server = started.server;

    const response = await get(started.port, '/api/jobs/job-1/evidence/build');
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('credential-request-id');
  });

  it('emits the persisted owning job request ID for valid public failure evidence', async () => {
    const base = stageEvidence('build', 'failed');
    const routeDependencies = dependencies();
    useEvidence(routeDependencies, base, 'build', 'failed');
    const started = await start(routeDependencies); server = started.server;

    expect(await get(started.port, '/api/jobs/job-1/evidence/build')).toMatchObject({
      status: 200,
      body: { error: { requestId: 'request-1' } },
    });
  });

  it('accepts public evidence inputs bound to the configured production job identity', async () => {
    const routeDependencies = dependencies();
    useEvidence(routeDependencies, stageEvidence(), 'publish', 'passed');
    const started = await start(routeDependencies); server = started.server;

    expect(await get(started.port, '/api/jobs/job-1/evidence/publish')).toMatchObject({
      status: 200,
      body: { inputs: { targetId: 'rpi-5', rootId: 'release', branch: 'main', pinnedSha: sha } },
    });
  });

  it('sanitizes public evidence command argv while preserving production command metadata', async () => {
    const command = (argv: readonly string[]) => ({
      argv, startedAt: now, finishedAt: later, exitCode: 17, signal: 'SIGTERM', timedOut: true, outputLimit: true,
    });
    const routeDependencies = dependencies();
    useEvidence(routeDependencies, {
      ...stageEvidence(),
      commands: [
        command(['/usr/bin/git', '-C', 'worktree/job-1', 'rev-parse', '--verify', sha, 'target=rpi-5', 'osi-image-builder-runner@job-1.service', 'https://example.test/repository.git', './release/image.img', '../cache/image.img', 'status\tok\r\n']),
        command(['/usr/bin/docker', 'run', '--rm', '--name', 'builder-job-1', '--network=none', `sha256:${'b'.repeat(64)}`, 'targetId=rpi-5']),
        command(['/usr/bin/node', '/home/builder/build.js', '/opt/osi-builder/tool', '/proc/self/status', '--output=/data/x', 'password=hunter2', 'https://build-user:build-password@example.test/repository.git', '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-material\n-----END OPENSSH PRIVATE KEY-----', 'safe\tline\r\n']),
        command(['/opt/unknown/bin/tool', '--flag', 'target=rpi-5']),
      ],
    }, 'publish', 'passed');
    const started = await start(routeDependencies); server = started.server;

    const response = await get(started.port, '/api/jobs/job-1/evidence/publish');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      commands: [
        {
          argv: ['/usr/bin/git', '-C', 'worktree/job-1', 'rev-parse', '--verify', sha, 'target=rpi-5', 'osi-image-builder-runner@job-1.service', 'https://example.test/repository.git', './release/image.img', '../cache/image.img', 'status\tok\r\n'],
          startedAt: now, finishedAt: later, exitCode: 17, signal: 'SIGTERM', timedOut: true, outputLimit: true,
        },
        {
          argv: ['/usr/bin/docker', 'run', '--rm', '--name', 'builder-job-1', '--network=none', `sha256:${'b'.repeat(64)}`, 'targetId=rpi-5'],
          startedAt: now, finishedAt: later, exitCode: 17, signal: 'SIGTERM', timedOut: true, outputLimit: true,
        },
        {
          argv: ['/usr/bin/node', '[redacted]', '[redacted]', '[redacted]', '[redacted]', '[redacted]', '[redacted]', '[redacted]', 'safe\tline\r\n'],
          startedAt: now, finishedAt: later, exitCode: 17, signal: 'SIGTERM', timedOut: true, outputLimit: true,
        },
        {
          argv: ['[redacted]', '--flag', 'target=rpi-5'],
          startedAt: now, finishedAt: later, exitCode: 17, signal: 'SIGTERM', timedOut: true, outputLimit: true,
        },
      ],
    });
    const encoded = JSON.stringify(response.body);
    for (const forbidden of ['/home/builder/build.js', '/opt/osi-builder/tool', '/proc/self/status', '/data/x', 'hunter2', 'build-user:build-password', 'private-material']) {
      expect(encoded).not.toContain(forbidden);
    }
  });

  it('redacts split-form sensitive argv values without carrying state across commands', async () => {
    const routeDependencies = dependencies();
    useEvidence(routeDependencies, {
      ...stageEvidence(),
      commands: [
        {
          argv: [
            '/usr/bin/node',
            '--passphrase', 'passphrase-secret',
            '--oauth-token', 'oauth-secret',
            '--session-key', 'session-secret',
            '--password', 'password-secret',
            '--access-key-id', 'access-key-secret',
            '--safe-flag', 'safe-value',
            '--password',
          ],
          startedAt: now,
          finishedAt: later,
          exitCode: 1,
          signal: null,
          timedOut: false,
          outputLimit: false,
        },
        {
          argv: ['/usr/bin/node', '--safe-flag', 'safe-value'],
          startedAt: now,
          finishedAt: later,
          exitCode: 0,
          signal: null,
          timedOut: false,
          outputLimit: false,
        },
      ],
    }, 'publish', 'failed');
    const started = await start(routeDependencies); server = started.server;

    expect(await get(started.port, '/api/jobs/job-1/evidence/publish')).toMatchObject({
      status: 200,
      body: {
        commands: [
          {
            argv: [
              '/usr/bin/node',
              '--passphrase', '[redacted]',
              '--oauth-token', '[redacted]',
              '--session-key', '[redacted]',
              '--password', '[redacted]',
              '--access-key-id', '[redacted]',
              '--safe-flag', 'safe-value',
              '--password',
            ],
          },
          { argv: ['/usr/bin/node', '--safe-flag', 'safe-value'] },
        ],
      },
    });
  });

  it('shares URL, absolute-path, and authorization classification across observations and argv', async () => {
    const routeDependencies = dependencies();
    useEvidence(routeDependencies, {
      ...stageEvidence(),
      commands: [{
        argv: [
          '/usr/bin/node',
          'https://:secret@example.test/repository.git',
          '//opt/osi-builder/image.img',
          '///data/db/farming.db',
          'https://example.test//opt/osi-builder/image.img',
          'https://example.test///data/db/farming.db',
          'Basic verification passed',
          'Bearer checks passed',
          'Basic dXNlcjpwYXNz',
          'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
          'Authorization: opaque-value',
        ],
        startedAt: now,
        finishedAt: later,
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputLimit: false,
      }],
      observations: {
        neutralUrl: 'https://:secret@example.test/repository.git',
        repeatedAbsolutePaths: ['//opt/osi-builder/image.img', '///data/db/farming.db'],
        safeUrls: ['https://example.test//opt/osi-builder/image.img', 'https://example.test///data/db/farming.db'],
        ordinaryAuthWords: ['Basic verification passed.', 'Bearer checks passed successfully'],
        neutralAuthValues: ['Basic dXNlcjpwYXNz', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature'],
        neutralHeaderText: 'Authorization: opaque-value',
      },
    }, 'publish', 'passed');
    const started = await start(routeDependencies); server = started.server;

    const response = await get(started.port, '/api/jobs/job-1/evidence/publish');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      observations: {
        neutralUrl: '[redacted]',
        repeatedAbsolutePaths: ['[redacted]', '[redacted]'],
        safeUrls: ['https://example.test//opt/osi-builder/image.img', 'https://example.test///data/db/farming.db'],
        ordinaryAuthWords: ['Basic verification passed.', 'Bearer checks passed successfully'],
        neutralAuthValues: ['[redacted]', '[redacted]'],
        neutralHeaderText: '[redacted]',
      },
      commands: [{
        argv: [
          '/usr/bin/node',
          '[redacted]',
          '[redacted]',
          '[redacted]',
          'https://example.test//opt/osi-builder/image.img',
          'https://example.test///data/db/farming.db',
          'Basic verification passed',
          'Bearer checks passed',
          '[redacted]',
          '[redacted]',
          '[redacted]',
        ],
      }],
    });
  });

  it('redacts lowercase auth credentials, URL userinfo, expanded sensitive keys, assignments, and errors', async () => {
    const lowercaseCredentials = ['basic lowercasevalue', 'bearer secret', 'bearer verylonglowercasetokenvalue'];
    const userinfoUrls = [
      'https://build-user@example.test/repository.git',
      'https://%62uild-user@example.test/repository.git',
      'https://:build-password@example.test/repository.git',
    ];
    const sensitiveAssignments = [
      'passphrase=passphrase-secret',
      'authHeader: auth-header-secret',
      'oauth_token=oauth-secret',
      'accessKeyId=access-key-id-secret',
      'access-key: access-key-secret',
      'session_key=session-key-secret',
      'failed (password=secret)',
    ];
    const routeDependencies = dependencies();
    useEvidence(routeDependencies, {
      ...stageEvidence('publish', 'failed'),
      commands: [{
        argv: [
          '/usr/bin/node',
          ...lowercaseCredentials,
          ...userinfoUrls,
          'https://example.test/repository.git',
          ...sensitiveAssignments,
        ],
        startedAt: now,
        finishedAt: later,
        exitCode: 1,
        signal: null,
        timedOut: false,
        outputLimit: false,
      }],
      observations: {
        lowercaseValues: lowercaseCredentials,
        userinfoValues: userinfoUrls,
        safeUrl: 'https://example.test/repository.git',
        sensitiveAssignments,
        sensitiveKeys: {
          passphrase: 'passphrase-value',
          authHeader: 'auth-header-value',
          authToken: 'auth-token-value',
          oauth: 'oauth-value',
          accessKeyId: 'access-key-id-value',
          accessKey: 'access-key-value',
          sessionKey: 'session-key-value',
          sessionKeyId: 'session-key-id-value',
        },
        ordinaryAuthProse: ['Basic verification passed.', 'Bearer checks passed successfully'],
      },
      error: {
        ...stageEvidence('publish', 'failed').error!,
        diagnosis: 'failed (password=error-secret)',
        recovery: 'retry (password=recovery-secret)',
      },
    }, 'publish', 'failed');
    const started = await start(routeDependencies); server = started.server;

    const response = await get(started.port, '/api/jobs/job-1/evidence/publish');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      commands: [{ argv: [
        '/usr/bin/node',
        ...Array(lowercaseCredentials.length + userinfoUrls.length).fill('[redacted]'),
        'https://example.test/repository.git',
        ...Array(sensitiveAssignments.length).fill('[redacted]'),
      ] }],
      observations: {
        lowercaseValues: Array(lowercaseCredentials.length).fill('[redacted]'),
        userinfoValues: Array(userinfoUrls.length).fill('[redacted]'),
        safeUrl: 'https://example.test/repository.git',
        sensitiveAssignments: Array(sensitiveAssignments.length).fill('[redacted]'),
        sensitiveKeys: {},
        ordinaryAuthProse: ['Basic verification passed.', 'Bearer checks passed successfully'],
      },
      error: {
        diagnosis: '[redacted]',
        recovery: '[redacted]',
      },
    });
    const encoded = JSON.stringify(response.body);
    for (const forbidden of [
      ...lowercaseCredentials,
      ...userinfoUrls,
      ...sensitiveAssignments,
      'passphrase-value', 'auth-header-value', 'auth-token-value', 'oauth-value',
      'access-key-id-value', 'access-key-value', 'session-key-value', 'session-key-id-value',
      'error-secret', 'recovery-secret', '/srv/private', 'errorsecret',
    ]) expect(encoded).not.toContain(forbidden);
  });

  it.each([
    ['target ID mismatch', { targetId: 'rpi-2' }],
    ['root ID mismatch', { rootId: 'archive' }],
    ['branch mismatch', { branch: 'feature/a' }],
    ['pinned SHA mismatch', { pinnedSha: 'b'.repeat(40) }],
  ])('rejects public evidence input %s against the owning job', async (_label, override) => {
    const routeDependencies = dependencies();
    Object.assign(routeDependencies as object, { targets: [...routeDependencies.targets, {
      id: 'rpi-2', label: 'Raspberry Pi 2', environment: 'bcm2709', openwrtTarget: 'bcm27xx/bcm2709', profile: 'DEVICE_rpi-2', rootfs: 'ext4', artifactGlob: '*.img',
      rootfsPartSize: 14336, minimumArtifactBytes: 67108864, configSymbols: [{ name: 'CONFIG_TARGET_PROFILE', type: 'string', value: 'DEVICE_rpi-2' }], operations: ['activate-target'],
    }] });
    Object.assign(routeDependencies.config as object, { approvedOutputRoots: [
      ...routeDependencies.config.approvedOutputRoots,
      { id: 'archive', label: 'Archive images', path: '/srv/archive', quarantinePath: '/srv/archive/.quarantine' },
    ] });
    useEvidence(routeDependencies, { ...stageEvidence(), inputs: { ...stageEvidence().inputs, ...override } }, 'publish', 'passed');
    const started = await start(routeDependencies); server = started.server;

    expect((await get(started.port, '/api/jobs/job-1/evidence/publish')).status).toBe(500);
  });

  it.each([
    ['HEAD', 'release'],
    ['@', 'release'],
    ['feature branch', 'release'],
    ['.hidden', 'release'],
    ['feature/.hidden', 'release'],
    ['main', 'RELEASE'],
    ['main', '../release'],
  ])('rejects malformed public evidence branch or root %s/%s', async (branch, rootId) => {
    const routeDependencies = dependencies();
    useEvidence(routeDependencies, { ...stageEvidence(), inputs: { ...stageEvidence().inputs, branch, rootId } }, 'publish', 'passed');
    const started = await start(routeDependencies); server = started.server;

    expect((await get(started.port, '/api/jobs/job-1/evidence/publish')).status).toBe(500);
  });

  it('recursively redacts sensitive public observations without hiding benign evidence', async () => {
    const forbiddenValues = [
      'token-value-123',
      'password-value-456',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-material\n-----END OPENSSH PRIVATE KEY-----',
      '/home/builder/.config/secret.json',
      'artifact was written to /tmp/build-output/image.img',
      'socket=/run/osi-builder.sock',
      'loaded /etc/osi-image-builder/config.json',
      'read /proc/self/status',
      'checked /sys/class/thermal/thermal_zone0/temp',
      'device at /dev/ttyUSB0',
      'root is /root/.cache/builder',
      'stored in /var/lib/osi-builder/state',
      'served from /srv/images/release.img',
      'file:///home/builder/.ssh/id_ed25519',
      'see ~/.ssh/id_ed25519 for details',
      'password=hunter2',
      'GIT_SSH_COMMAND=ssh -i /home/builder/.ssh/id_ed25519',
      '/run/secret-agent.sock',
      '/home/builder/.config/credentials.json',
      'Bearer authorization-value',
      'session-cookie-value',
      'secret-value',
      'api-key-value',
      'x-api-key-value',
      'ssh-key-value',
      'identity-file-value',
      'client-secret-value',
    ];
    const routeDependencies = dependencies();
    useEvidence(routeDependencies, {
      ...stageEvidence(),
      observations: {
        neutralHomePath: forbiddenValues[3],
        neutralEmbeddedPaths: forbiddenValues.slice(4, 13),
        neutralFileUri: forbiddenValues[13],
        neutralSshEvidence: forbiddenValues[14],
        nested: {
          buildAccessToken: forbiddenValues[0],
          Db_PASSWORD: forbiddenValues[1],
          private_key: forbiddenValues[2],
          apiKey: 'api-key-value',
          'x-api-key': 'x-api-key-value',
          sshKey: 'ssh-key-value',
          identityFile: 'identity-file-value',
          clientSecret: 'client-secret-value',
          sshAuthSock: '/run/secret-agent.sock',
          git_ssh_command: forbiddenValues[16],
          credentialPath: '/home/builder/.config/credentials.json',
          deeplyNested: [{ authorizationHeader: 'Bearer authorization-value' }, { cookieValue: 'session-cookie-value' }, { someSecretValue: 'secret-value' }],
          benign: {
            relativeToolEvidence: 'logs/build/output.txt',
            hash: 'f'.repeat(64),
            url: 'https://example.test/build/output',
            enabled: true,
            count: 3,
            missing: null,
          },
        },
      },
    }, 'publish', 'passed');
    const started = await start(routeDependencies); server = started.server;

    const response = await get(started.port, '/api/jobs/job-1/evidence/publish');
    expect(response.status).toBe(200);
    const encoded = JSON.stringify(response.body);
    for (const forbiddenValue of forbiddenValues) expect(encoded).not.toContain(forbiddenValue);
    expect(response.body).toMatchObject({
      observations: {
        neutralHomePath: '[redacted]',
        neutralEmbeddedPaths: Array(9).fill('[redacted]'),
        neutralFileUri: '[redacted]',
        neutralSshEvidence: '[redacted]',
        nested: {
          deeplyNested: [{}, {}, {}],
          benign: {
            relativeToolEvidence: 'logs/build/output.txt',
            hash: 'f'.repeat(64),
            url: 'https://example.test/build/output',
            enabled: true,
            count: 3,
            missing: null,
          },
        },
      },
    });
  });

  it('redacts structured credentials and generic absolute paths under neutral keys', async () => {
    const structuredSecrets = [
      'https://build-user:build-password@example.test/repository.git',
      'Authorization: Bearer bearer-secret-value',
      'authorization: Basic dXNlcjpwYXNz',
      'token=token-secret-value',
      'password: password-secret-value',
      'apiKey=x-api-key-secret-value',
      'x-api-key: header-key-secret-value',
      'PuTTY-User-Key-File-2: ssh-rsa\nPrivate-Lines: 2\nprivate-material',
      '-----BEGIN RSA PRIVATE KEY-----\nrsa-material\n-----END RSA PRIVATE KEY-----',
      '-----BEGIN EC PRIVATE KEY-----\nec-material\n-----END EC PRIVATE KEY-----',
      '-----BEGIN DSA PRIVATE KEY-----\ndsa-material\n-----END DSA PRIVATE KEY-----',
      '---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\nssh2-material\n---- END SSH2 ENCRYPTED PRIVATE KEY ----',
    ];
    const absolutePaths = [
      '/opt/osi-builder/image.img',
      'artifact was written to /usr/local/share/image.img',
      'mounted at /mnt/build/image.img',
      'copied to /media/usb/image.img',
      'database is at /data/db/farming.db',
      'custom root is /custom/root/image.img',
    ];
    const routeDependencies = dependencies();
    useEvidence(routeDependencies, {
      ...stageEvidence(),
      observations: {
        neutralStructuredValues: structuredSecrets,
        neutralAbsolutePaths: absolutePaths,
        safeUrls: [
          'https://example.test/opt/osi-builder/image.img',
          'https://example.test/usr/local/share/image.img?path=/data/db',
        ],
        safeRelativePaths: ['logs/build/output.txt', './release/image.img', '../cache/image.img'],
      },
    }, 'publish', 'passed');
    const started = await start(routeDependencies); server = started.server;

    const response = await get(started.port, '/api/jobs/job-1/evidence/publish');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      observations: {
        neutralStructuredValues: Array(structuredSecrets.length).fill('[redacted]'),
        neutralAbsolutePaths: Array(absolutePaths.length).fill('[redacted]'),
        safeUrls: [
          'https://example.test/opt/osi-builder/image.img',
          'https://example.test/usr/local/share/image.img?path=/data/db',
        ],
        safeRelativePaths: ['logs/build/output.txt', './release/image.img', '../cache/image.img'],
      },
    });
  });

  it('redacts bounded structured JSON credentials across all public text surfaces', async () => {
    const structuredCredentials = [
      '{"pass\\u0077ord":"escaped-secret"}',
      '{"nested":[{"password":123456},{"password":null},{"password":{"nested":"object-secret"}},{"password":[1,2,3]}]}',
      'prefix [{"safe":true},{"api\\u004bey":["array-secret"]}] suffix',
      'malformed {"password":123456',
      '{"message":"{\\"password\\":123456}"}',
    ];
    const benignJson = '{"status":"ok","nested":[{"count":2},null]}';
    const redactedCredentials = structuredCredentials;
    const routeDependencies = dependencies();
    useEvidence(routeDependencies, {
      ...stageEvidence('publish', 'failed'),
      commands: [{
        argv: ['/usr/bin/node', ...redactedCredentials, benignJson],
        startedAt: now,
        finishedAt: later,
        exitCode: 1,
        signal: null,
        timedOut: false,
        outputLimit: false,
      }],
      observations: { records: [...redactedCredentials, benignJson] },
      error: {
        ...stageEvidence('publish', 'failed').error!,
        diagnosis: `failed with ${structuredCredentials[0]}`,
        recovery: `retry with ${structuredCredentials[1]}`,
      },
    }, 'publish', 'failed');
    const started = await start(routeDependencies); server = started.server;

    const response = await get(started.port, '/api/jobs/job-1/evidence/publish');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      commands: [{ argv: ['/usr/bin/node', ...Array(redactedCredentials.length).fill('[redacted]'), benignJson] }],
      observations: { records: [...Array(redactedCredentials.length).fill('[redacted]'), benignJson] },
      error: { diagnosis: '[redacted]', recovery: '[redacted]' },
    });
    const encoded = JSON.stringify(response.body);
    for (const credential of redactedCredentials) expect(encoded).not.toContain(credential);
    for (const secret of ['escaped-secret', 'object-secret', 'array-secret', '123456']) {
      expect(encoded).not.toContain(secret);
    }
  });

  it('redacts credential-like object fragments with either quote style across all public text surfaces', async () => {
    const quotedCredentials = [
      "{'password':'single-$secret'}",
      '{"password":"double-secret"}',
      "{ 'password' : \"mixed-secret\" }",
    ];
    const routeDependencies = dependencies();
    useEvidence(routeDependencies, {
      ...stageEvidence('publish', 'failed'),
      commands: [{
        argv: ['/usr/bin/node', ...quotedCredentials],
        startedAt: now,
        finishedAt: later,
        exitCode: 1,
        signal: null,
        timedOut: false,
        outputLimit: false,
      }],
      observations: {
        quotedValues: quotedCredentials,
        author: 'build author',
        authority: 'build authority',
        authorizationStatus: 'verified',
      },
      error: {
        ...stageEvidence('publish', 'failed').error!,
        diagnosis: `failed with ${quotedCredentials[0]}`,
        recovery: `retry with ${quotedCredentials[1]}`,
      },
    }, 'publish', 'failed');
    const started = await start(routeDependencies); server = started.server;

    const response = await get(started.port, '/api/jobs/job-1/evidence/publish');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      commands: [{ argv: ['/usr/bin/node', ...Array(quotedCredentials.length).fill('[redacted]')] }],
      observations: {
        quotedValues: Array(quotedCredentials.length).fill('[redacted]'),
        author: 'build author',
        authority: 'build authority',
        authorizationStatus: 'verified',
      },
      error: { diagnosis: '[redacted]', recovery: '[redacted]' },
    });
    const encoded = JSON.stringify(response.body);
    for (const credential of quotedCredentials) expect(encoded).not.toContain(credential);
    for (const secret of ['single-$secret', 'double-secret', 'mixed-secret']) expect(encoded).not.toContain(secret);
  });

  it('redacts authorization credentials before alphabetic text after ampersand or pipe delimiters', async () => {
    const delimiterCredentials = ['Basic dXNlcjpwYXNz&', 'Bearer alphabetic|', 'Basic alphabetic#'];
    const routeDependencies = dependencies();
    useEvidence(routeDependencies, {
      ...stageEvidence('publish', 'failed'),
      commands: [{
        argv: ['/usr/bin/node', ...delimiterCredentials],
        startedAt: now,
        finishedAt: later,
        exitCode: 1,
        signal: null,
        timedOut: false,
        outputLimit: false,
      }],
      observations: { authValues: delimiterCredentials },
      error: {
        ...stageEvidence('publish', 'failed').error!,
        diagnosis: `failed with ${delimiterCredentials[0]}`,
        recovery: `retry with ${delimiterCredentials[1]}`,
      },
    }, 'publish', 'failed');
    const started = await start(routeDependencies); server = started.server;

    const response = await get(started.port, '/api/jobs/job-1/evidence/publish');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      commands: [{ argv: ['/usr/bin/node', ...Array(delimiterCredentials.length).fill('[redacted]')] }],
      observations: { authValues: Array(delimiterCredentials.length).fill('[redacted]') },
      error: { diagnosis: '[redacted]', recovery: '[redacted]' },
    });
    const encoded = JSON.stringify(response.body);
    for (const credential of delimiterCredentials) expect(encoded).not.toContain(credential);
    expect(encoded).not.toContain('dXNlcjpwYXNz');
    expect(encoded).not.toContain('alphabetic');
  });

  it('recovers from an unmatched quote before a credential-like object fragment', async () => {
    const malformedCredential = 'prefix "unterminated {"password":123456';
    const routeDependencies = dependencies();
    useEvidence(routeDependencies, {
      ...stageEvidence('publish', 'failed'),
      commands: [{
        argv: ['/usr/bin/node', malformedCredential],
        startedAt: now,
        finishedAt: later,
        exitCode: 1,
        signal: null,
        timedOut: false,
        outputLimit: false,
      }],
      observations: { malformedValue: malformedCredential },
      error: {
        ...stageEvidence('publish', 'failed').error!,
        diagnosis: `failed with ${malformedCredential}`,
        recovery: `retry with ${malformedCredential}`,
      },
    }, 'publish', 'failed');
    const started = await start(routeDependencies); server = started.server;

    const response = await get(started.port, '/api/jobs/job-1/evidence/publish');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      commands: [{ argv: ['/usr/bin/node', '[redacted]'] }],
      observations: { malformedValue: '[redacted]' },
      error: { diagnosis: '[redacted]', recovery: '[redacted]' },
    });
    expect(JSON.stringify(response.body)).not.toContain('123456');
  });

  it('redacts malformed escaped credential keys across every public text surface', async () => {
    const malformedCredential = String.raw`malformed {\"password\":123`;
    const routeDependencies = dependencies();
    useEvidence(routeDependencies, {
      ...stageEvidence('publish', 'failed'),
      commands: [{
        argv: ['/usr/bin/node', malformedCredential],
        startedAt: now,
        finishedAt: later,
        exitCode: 1,
        signal: null,
        timedOut: false,
        outputLimit: false,
      }],
      observations: { malformedEscapedValue: malformedCredential },
      error: {
        ...stageEvidence('publish', 'failed').error!,
        diagnosis: `failed with ${malformedCredential}`,
        recovery: `retry with ${malformedCredential}`,
      },
    }, 'publish', 'failed');
    const started = await start(routeDependencies); server = started.server;

    const response = await get(started.port, '/api/jobs/job-1/evidence/publish');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      commands: [{ argv: ['/usr/bin/node', '[redacted]'] }],
      observations: { malformedEscapedValue: '[redacted]' },
      error: { diagnosis: '[redacted]', recovery: '[redacted]' },
    });
    expect(JSON.stringify(response.body)).not.toContain('password');
  });

  it('classifies credentials in surrounding text while preserving benign auth prose and status keys', async () => {
    const routeDependencies = dependencies();
    useEvidence(routeDependencies, {
      ...stageEvidence('publish', 'failed'),
      commands: [{
        argv: ['/usr/bin/node', 'prefix\tBearer\nabc$def, suffix', 'prefix Basic dXNlcjpwYXNz suffix', '{"message":"Bearer abc$def"}', 'Basic verification passed.'],
        startedAt: now,
        finishedAt: later,
        exitCode: 1,
        signal: null,
        timedOut: false,
        outputLimit: false,
      }],
      observations: {
        neutralText: 'prefix\tBearer\nabc$def, suffix',
        neutralAuthText: 'prefix Basic dXNlcjpwYXNz suffix',
        benignText: ['Basic verification passed.', 'Bearer checks passed successfully'],
        author: 'build author',
        authority: 'build authority',
        authorizationStatus: 'verified',
        authHeader: 'Bearer header-secret',
        authToken: 'token-secret',
        oauth: 'oauth-secret',
      },
      error: {
        ...stageEvidence('publish', 'failed').error!,
        diagnosis: 'request failed: Basic abc$def.',
        recovery: 'retry with {"message":"Bearer abc$def"}',
      },
    }, 'publish', 'failed');
    const started = await start(routeDependencies); server = started.server;

    const response = await get(started.port, '/api/jobs/job-1/evidence/publish');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      commands: [{ argv: ['/usr/bin/node', '[redacted]', '[redacted]', '[redacted]', 'Basic verification passed.'] }],
      observations: {
        neutralText: '[redacted]',
        neutralAuthText: '[redacted]',
        benignText: ['Basic verification passed.', 'Bearer checks passed successfully'],
        author: 'build author',
        authority: 'build authority',
        authorizationStatus: 'verified',
      },
      error: { diagnosis: '[redacted]', recovery: '[redacted]' },
    });
  });

  it('keeps escape-heavy input linear at the exact evidence byte limit', async () => {
    const emptyEvidence = stageEvidence();
    const escapedQuotes = String.raw`\"`.repeat(15_000);
    const escapedEvidence = {
      ...emptyEvidence,
      observations: { unmatchedOpeners: escapedQuotes },
    };
    const remainingBytes = 65_536 - Buffer.byteLength(JSON.stringify(escapedEvidence), 'utf8');
    expect(remainingBytes).toBeGreaterThan(0);
    const unmatchedOpeners = escapedQuotes + '{'.repeat(remainingBytes);
    const evidence = {
      ...emptyEvidence,
      observations: { unmatchedOpeners },
    };
    expect(Buffer.byteLength(JSON.stringify(evidence), 'utf8')).toBe(65_536);
    const routeDependencies = dependencies();
    useEvidence(routeDependencies, evidence, 'publish', 'passed');
    const started = await start(routeDependencies); server = started.server;

    const scanStartedAt = performance.now();
    const response = await get(started.port, '/api/jobs/job-1/evidence/publish');
    const elapsedMs = performance.now() - scanStartedAt;
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ observations: { unmatchedOpeners } });
    expect(elapsedMs).toBeLessThan(500);
  });

  it('preserves safe production multiline text while redacting other controls', async () => {
    const multiline = {
      stdout: 'make image\tstarted\r\nmake image\tfinished\r\n',
      stderr: 'warning: optional package missing\r\n',
      source: 'diff --git a/Makefile b/Makefile\r\n+\tmake all\n',
      checksum: 'a'.repeat(64) + '  image.img\r\n',
    };
    const routeDependencies = dependencies();
    useEvidence(routeDependencies, {
      ...stageEvidence(),
      observations: {
        multiline,
        controls: ['nul\u0000control', 'vertical\u000btab', 'c1\u0085control', 'delete\u007fcontrol'],
      },
    }, 'publish', 'passed');
    const started = await start(routeDependencies); server = started.server;

    const response = await get(started.port, '/api/jobs/job-1/evidence/publish');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      observations: {
        multiline,
        controls: Array(4).fill('[redacted]'),
      },
    });
  });

  it('rejects malformed stored stage evidence', async () => {
    const rejected = async (evidence: Record<string, unknown>, stage: PipelineStageName, outcome: 'passed' | 'failed') => {
      const routeDependencies = dependencies();
      useEvidence(routeDependencies, evidence, stage, outcome);
      const started = await start(routeDependencies); server = started.server;
      expect((await get(started.port, `/api/jobs/job-1/evidence/${stage}`)).status).toBe(500);
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    };
    const validFailure = stageEvidence('publish', 'failed');

    await rejected({ ...stageEvidence(), error: validFailure.error }, 'publish', 'passed');
    await rejected({ ...stageEvidence('publish', 'failed'), error: null }, 'publish', 'failed');
    await rejected({ ...stageEvidence(), startedAt: later, finishedAt: now }, 'publish', 'passed');
    await rejected({
      ...stageEvidence(),
      commands: [{ argv: ['make'], startedAt: later, finishedAt: now, exitCode: 0, signal: null, timedOut: false, outputLimit: false }],
    }, 'publish', 'passed');
    await rejected({ ...stageEvidence('source'), operationId: 'frontend-test' }, 'source', 'passed');
    await rejected({ ...stageEvidence(), operationId: 'build-image' }, 'publish', 'passed');
    await rejected({ ...stageEvidence(), unexpected: true }, 'publish', 'passed');
    await rejected({ ...validFailure, error: { ...validFailure.error!, unexpected: true } }, 'publish', 'failed');
    await rejected({ ...stageEvidence(), inputs: { payload: 'x'.repeat(65_536) } }, 'publish', 'passed');
    await rejected({ ...stageEvidence(), inputs: { targetId: 'rpi-5', rootId: 'release', branch: 'main', pinnedSha: sha, extra: true } }, 'publish', 'passed');
    await rejected({ ...stageEvidence(), inputs: { targetId: 'rpi-5', rootId: 'release', branch: 'main' } }, 'publish', 'passed');
    await rejected({ ...stageEvidence(), inputs: { targetId: 'rpi-4', rootId: 'release', branch: 'main', pinnedSha: sha } }, 'publish', 'passed');
    await rejected({ ...stageEvidence(), inputs: { targetId: 'rpi-5', rootId: 'release', branch: '/main', pinnedSha: sha } }, 'publish', 'passed');
    await rejected({ ...stageEvidence(), inputs: { targetId: 'rpi-5', rootId: 'release', branch: 'main', pinnedSha: sha.toUpperCase() } }, 'publish', 'passed');
  });

  it('rejects a public evidence response whose final encoding exceeds the shared JSON bound', async () => {
    const routeDependencies = dependencies();
    useEvidence(routeDependencies, {
      ...stageEvidence(),
      observations: { payload: 'x'.repeat(65_500) },
    }, 'publish', 'passed');
    const started = await start(routeDependencies); server = started.server;

    expect((await get(started.port, '/api/jobs/job-1/evidence/publish')).status).toBe(500);
  });

  it('rejects malformed and unbounded read parameters and unknown resources', async () => {
    const started = await start(); server = started.server;
    expect((await get(started.port, '/api/jobs?limit=101')).status).toBe(400);
    expect((await get(started.port, '/api/jobs?cursor=not%20opaque')).status).toBe(400);
    expect((await get(started.port, '/api/jobs/job-1/events?after=-2')).status).toBe(400);
    expect((await get(started.port, `/api/jobs/job-1/evidence/${PIPELINE_STAGE_NAMES.join('')}`)).status).toBe(400);
    expect((await get(started.port, '/api/jobs/missing')).status).toBe(404);
    expect((await get(started.port, '/api/jobs/job-1%252fsecret')).status).toBe(400);
    expect((await get(started.port, '/api/jobs/%252e%252e')).status).toBe(400);
    expect((await get(started.port, '/api/jobs/missing/evidence/not-a-stage')).status).toBe(400);
    expect((await get(started.port, '/api/jobs/job-1/events/stream?after=-2')).status).toBe(400);
    expect((await get(started.port, '/api/jobs/missing/events/stream')).status).toBe(404);
    expect((await get(started.port, '/api/jobs/missing/events')).status).toBe(404);
  });

  it('streams job events from the durable after cursor with a request abort signal', async () => {
    const open = vi.fn((jobId: string, afterSeq: number, signal: AbortSignal) => (async function* () {
      expect(signal.aborted).toBe(false);
      yield `id: ${afterSeq + 1}\nevent: stage\ndata: ${JSON.stringify({ jobId, state: 'building' })}\n\n`;
      yield `id: ${afterSeq + 2}\nevent: terminal\ndata: ${JSON.stringify({ jobId, state: 'succeeded' })}\n\n`;
    })());
    const started = await start(dependencies((value) => {
      Object.assign(value as object, { eventStream: { open } });
    }));
    server = started.server;

    const response = await getText(started.port, '/api/jobs/job-1/events/stream?after=41');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(response.body).toBe(
      'id: 42\nevent: stage\ndata: {"jobId":"job-1","state":"building"}\n\n'
      + 'id: 43\nevent: terminal\ndata: {"jobId":"job-1","state":"succeeded"}\n\n',
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toBe('job-1');
    expect(open.mock.calls[0]![1]).toBe(41);
    expect(open.mock.calls[0]![2]).toBeInstanceOf(AbortSignal);
  });

  it('preserves valid source subjects and keeps unknown freshness informational', async () => {
    const informational = {
      ...job('job-1'),
      sourceSubject: '',
      freshnessStatus: 'unknown' as const,
      freshnessObservedSha: null,
      freshnessErrorCode: 'FRESHNESS_UNKNOWN' as const,
      freshnessError: { expectedSha: sha },
    };
    const started = await start(dependencies((value) => {
      Object.assign(value as object, {
        branches: {
          get: async () => ({ fetchedAt: now, branches: [{ name: 'main', sha, commitTime: now, subject: 'line one\nline two' }] }),
          refresh: async () => ({ fetchedAt: now, branches: [{ name: 'main', sha, commitTime: now, subject: 'line one\nline two' }] }),
        },
      });
      Object.assign(value.store as object, {
        getJob: (id: string) => id === 'job-1' ? informational : (() => { throw new StoreNotFoundError('not found'); })(),
      });
    }));
    server = started.server;
    expect((await get(started.port, '/api/branches')).body).toMatchObject({
      branches: [{ name: 'main', subject: 'line one\nline two' }],
    });
    const response = await get(started.port, '/api/jobs/job-1');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      state: 'succeeded',
      freshnessStatus: 'unknown',
      error: null,
      source: { subject: '' },
      errors: { freshness: { code: 'FRESHNESS_UNKNOWN' } },
    });
  });

  it('fails closed on malformed branch, job-page, and event-page data', async () => {
    const invalidBranches = await start(dependencies((value) => {
      Object.assign(value as object, { branches: {
        get: async () => ({ fetchedAt: now, branches: Array.from({ length: 1001 }, (_, index) => ({ name: `branch-${index}`, sha, commitTime: now, subject: 'subject' })) }),
        refresh: async () => ({ fetchedAt: now, branches: [] }),
      } });
    }));
    server = invalidBranches.server;
    expect((await get(invalidBranches.port, '/api/branches')).status).toBe(503);
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;

    const invalidPage = await start(dependencies((value) => {
      Object.assign(value.store as object, { listJobs: async () => ({ jobs: [job('job-1'), job('job-1')], nextCursor: null }) });
    }));
    server = invalidPage.server;
    expect((await get(invalidPage.port, '/api/jobs?limit=1')).status).toBe(500);
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;

    const stalledCursor = await start(dependencies((value) => {
      Object.assign(value.store as object, { listJobs: async () => ({ jobs: [], nextCursor: 'same' }) });
    }));
    server = stalledCursor.server;
    expect((await get(stalledCursor.port, '/api/jobs?cursor=same')).status).toBe(500);
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;

    const mismatchedEvidence = await start(dependencies((value) => {
      const wrongStage = {
        jobId: 'job-1', stage: 'build' as const, outcome: 'passed' as const,
        startedAt: now, finishedAt: now, evidencePath: 'jobs/job-1/evidence/09-publish.json',
        evidenceSha256: 'd'.repeat(64), errorCode: null, error: null,
      };
      Object.assign(value.store as object, {
        getStage: (id: string, requestedStage: string) => id === 'job-1' && requestedStage === 'build' ? wrongStage : null,
      });
    }));
    server = mismatchedEvidence.server;
    expect((await get(mismatchedEvidence.port, '/api/jobs/job-1')).status).toBe(500);
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;

    const invalidEvents = await start(dependencies((value) => {
      Object.assign(value.store as object, { listEvents: () => ({
        events: [
          { jobId: 'job-1', seq: 2, eventType: 'terminal' as const, state: 'succeeded' as const, stage: 'publish' as const, payload: {}, at: now },
          { jobId: 'job-1', seq: 2, eventType: 'terminal' as const, state: 'succeeded' as const, stage: 'publish' as const, payload: {}, at: now },
        ], nextAfterSeq: null,
      }) });
    }));
    server = invalidEvents.server;
    expect((await get(invalidEvents.port, '/api/jobs/job-1/events')).status).toBe(500);
  });

  it('rejects repeated stage rows and artifacts outside the deterministic release directory', async () => {
    const repeatedStage = await start(dependencies((value) => {
      Object.assign(value.store as object, { getStage: (id: string) => id === 'job-1' ? {
        jobId: 'job-1', stage: 'publish' as const, outcome: 'passed' as const, startedAt: now, finishedAt: now,
        evidencePath: 'jobs/job-1/evidence/09-publish.json', evidenceSha256: 'd'.repeat(64), errorCode: null, error: null,
      } : null });
    }));
    server = repeatedStage.server;
    expect((await get(repeatedStage.port, '/api/jobs/job-1')).status).toBe(500);
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;

    const mismatchedEvidenceStage = await start(dependencies((value) => {
      Object.assign(value.store as object, { getStage: (id: string, requestedStage: string) => id === 'job-1' && requestedStage === 'publish' ? {
        jobId: 'job-1', stage: 'build' as const, outcome: 'passed' as const, startedAt: now, finishedAt: now,
        evidencePath: 'jobs/job-1/evidence/07-build.json', evidenceSha256: 'd'.repeat(64), errorCode: null, error: null,
      } : null });
    }));
    server = mismatchedEvidenceStage.server;
    expect((await get(mismatchedEvidenceStage.port, '/api/jobs/job-1/evidence/publish')).status).toBe(500);
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;

    const mismatchedEvidenceJob = await start(dependencies((value) => {
      Object.assign(value.store as object, { getStage: (id: string, requestedStage: string) => id === 'job-1' && requestedStage === 'publish' ? {
        jobId: 'job-2', stage: 'publish' as const, outcome: 'passed' as const, startedAt: now, finishedAt: now,
        evidencePath: 'jobs/job-2/evidence/09-publish.json', evidenceSha256: 'd'.repeat(64), errorCode: null, error: null,
      } : null });
    }));
    server = mismatchedEvidenceJob.server;
    expect((await get(mismatchedEvidenceJob.port, '/api/jobs/job-1/evidence/publish')).status).toBe(500);
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;

    const unrelatedArtifact = await start(dependencies((value) => {
      Object.assign(value.store as object, { getJob: () => ({ ...job('job-1'), artifactFinalDirectory: 'unrelated/location', artifactFinalPath: 'unrelated/location/image' }) });
    }));
    server = unrelatedArtifact.server;
    expect((await get(unrelatedArtifact.port, '/api/jobs/job-1')).status).toBe(500);
  });
});
