import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { PIPELINE_STAGE_NAMES } from '../../domain/types.js';
import { createHttpServer, type ApiRouteContext } from '../../api/src/server.js';
import { createApiRouteHandler, type ApiRouteDependencies } from '../../api/src/routes.js';
import { StoreNotFoundError } from '../../api/src/store.js';

const sha = 'a'.repeat(40);
const now = '2026-07-28T10:00:00.000Z';

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
    branches: async () => ({ fetchedAt: now, branches: [{ name: 'main', sha, commitTime: now, subject: 'subject' }] }),
    store: {
      listJobs: async ({ cursor, limit }: { cursor: string | null; limit: number }) => ({ jobs: [record], nextCursor: cursor === null && limit === 1 ? 'next-page' : null }),
      getJob: (id: string) => id === 'job-1' ? record : (() => { throw new StoreNotFoundError('not found'); })(),
      getStage: (id: string, requestedStage: typeof stage.stage) => id === 'job-1' && requestedStage === 'publish' ? stage : null,
      listEvents: (id: string, options?: { afterSeq?: number; limit?: number }) => id === 'job-1'
        ? (options?.afterSeq ?? -1) >= 2
          ? { events: [], nextAfterSeq: null }
          : {
            events: [{ jobId: id, seq: 2, eventType: 'terminal' as const, state: 'succeeded' as const, stage: 'publish' as const, payload: { artifactFinalPath: '/private', token: 'secret' }, at: now }],
            nextAfterSeq: options?.afterSeq === 0 ? 2 : null,
          }
        : (() => { throw new StoreNotFoundError('not found'); })(),
    },
    readEvidence: async () => ({
      schemaVersion: 1,
      jobId: 'job-1',
      stage: 'publish',
      startedAt: now,
      finishedAt: now,
      outcome: 'passed',
      operationId: null,
      commands: [],
      inputs: { pinnedSha: sha },
      observations: { artifactSha256: 'c'.repeat(64) },
      error: null,
    }),
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
      outcome: 'passed', operationId: null, commands: [], inputs: { pinnedSha: sha },
      observations: { artifactSha256: 'c'.repeat(64) }, error: null,
    });
    const events = await get(started.port, '/api/jobs/job-1/events?after=0');
    expect(events.body).toEqual({ events: [{ seq: 2, event: 'terminal', state: 'succeeded', stage: 'publish', at: now, data: {} }], next: 2 });
    expect((await get(started.port, '/api/jobs/job-1/events?after=2')).body).toEqual({ events: [], next: 2 });
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
    expect((await get(started.port, '/api/jobs/job-1/events/stream')).status).toBe(404);
    expect((await get(started.port, '/api/jobs/missing/events')).status).toBe(404);
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
        branches: async () => ({ fetchedAt: now, branches: [{ name: 'main', sha, commitTime: now, subject: 'line one\nline two' }] }),
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
      Object.assign(value as object, { branches: async () => ({ fetchedAt: now, branches: Array.from({ length: 1001 }, (_, index) => ({ name: `branch-${index}`, sha, commitTime: now, subject: 'subject' })) }) });
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
});
