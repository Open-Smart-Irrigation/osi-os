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
    artifactFinalDirectory: 'release/job-1', artifactFinalPath: 'release/job-1/image', artifactSha256: 'c'.repeat(64),
    artifactSize: 123, artifactMtime: now, checksumPath: 'release/job-1/SHA256SUMS', checksumSha256: 'c'.repeat(64),
    manifestPath: 'release/job-1/manifest.json', manifestSha256: 'c'.repeat(64),
    verificationPath: 'release/job-1/verification.json', verificationSha256: 'c'.repeat(64),
    publishState: 'published', publishStartedAt: now, publishedAt: now, publishBlockerCode: null, publishBlocker: null,
    freshnessStatus: 'fresh', freshnessObservedSha: sha, newerSourceAvailable: false,
    freshnessRequestedAt: now, freshnessCheckedAt: now, freshnessErrorCode: null, freshnessError: null,
    freshnessErrorEvidencePath: null, freshnessErrorEvidenceSha256: null,
  } as const;
}

function dependencies(): ApiRouteDependencies {
  const record = job('job-1');
  const stage = {
    jobId: 'job-1', stage: 'publish' as const, outcome: 'passed' as const,
    startedAt: now, finishedAt: now, evidencePath: 'jobs/job-1/evidence/publish.json', evidenceSha256: 'd'.repeat(64),
    errorCode: null, error: null,
  };
  return {
    version: 'test-version',
    config: {
      repository: { path: '/srv/osi-os', remote: 'origin' },
      approvedOutputRoots: [{ id: 'release', label: 'Release images', path: '/srv/images', quarantinePath: '/srv/images/.quarantine' }],
      builderLockPath: '/srv/state/lock', maxQueueLength: 4, diskFreeMinimumBytes: 1,
    },
    targets: [{ id: 'rpi-5', label: 'Raspberry Pi 5', environment: 'bcm2712', openwrtTarget: 'bcm27xx/bcm2712', profile: 'DEVICE_rpi-5', rootfs: 'ext4', artifactGlob: '*.img' }],
    health: () => ({ activeJobId: 'job-1' }),
    branches: async () => ({ fetchedAt: now, branches: [{ name: 'main', sha, commitTime: now, subject: 'subject' }] }),
    store: {
      listJobs: async ({ cursor, limit }) => ({ jobs: [record], nextCursor: cursor === null && limit === 1 ? 'next-page' : null }),
      getJob: (id) => id === 'job-1' ? record : (() => { throw new StoreNotFoundError('not found'); })(),
      getStage: (id, requestedStage) => id === 'job-1' && requestedStage === 'publish' ? stage : null,
      listEvents: (id, options) => id === 'job-1' ? {
        events: [{ jobId: id, seq: 2, eventType: 'terminal' as const, state: 'succeeded' as const, stage: 'publish' as const, payload: { artifactFinalPath: '/private', token: 'secret' }, at: now }],
        nextAfterSeq: options?.afterSeq === 0 ? 3 : null,
      } : (() => { throw new Error('not found'); })(),
    },
    readEvidence: async () => ({ stage: 'publish', artifactPath: '/private', credentials: { token: 'secret' }, result: 'ok' }),
  } as ApiRouteDependencies;
}

async function start() {
  const server = createHttpServer({ origin: 'http://127.0.0.1:0', routeHandler: createApiRouteHandler(dependencies()) });
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
    expect(config.body).toEqual(expect.objectContaining({ targets: [{ id: 'rpi-5', label: 'Raspberry Pi 5', environment: 'bcm2712', openwrtTarget: 'bcm27xx/bcm2712', profile: 'DEVICE_rpi-5', rootfs: 'ext4', artifactGlob: '*.img' }] }));

    expect((await get(started.port, '/api/branches')).body).toEqual({ fetchedAt: now, branches: [{ name: 'main', sha, commitTime: now, subject: 'subject' }] });
    const jobs = await get(started.port, '/api/jobs?limit=1');
    expect(jobs).toMatchObject({ status: 200, body: { jobs: [{ id: 'job-1', state: 'succeeded', branch: 'main', targetId: 'rpi-5', outputRootId: 'release' }], nextCursor: 'next-page' } });

    const detail = await get(started.port, '/api/jobs/job-1');
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toMatch(/private|secret|staging|release\/job/);
    expect(detail.body).toMatchObject({ id: 'job-1', source: expect.objectContaining({ branch: 'main', pinnedSha: sha }), evidence: [expect.objectContaining({ stage: 'publish', outcome: 'passed', evidenceSha256: 'd'.repeat(64) })] });

    const evidence = await get(started.port, '/api/jobs/job-1/evidence/publish');
    expect(evidence.body).toEqual({ stage: 'publish', result: 'ok' });
    const events = await get(started.port, '/api/jobs/job-1/events?after=0');
    expect(events.body).toEqual({ events: [{ seq: 2, event: 'terminal', state: 'succeeded', stage: 'publish', at: now, data: {} }], next: 3 });
  });

  it('rejects malformed and unbounded read parameters and unknown resources', async () => {
    const started = await start(); server = started.server;
    expect((await get(started.port, '/api/jobs?limit=101')).status).toBe(400);
    expect((await get(started.port, '/api/jobs?cursor=not%20opaque')).status).toBe(400);
    expect((await get(started.port, '/api/jobs/job-1/events?after=-2')).status).toBe(400);
    expect((await get(started.port, `/api/jobs/job-1/evidence/${PIPELINE_STAGE_NAMES.join('')}`)).status).toBe(400);
    expect((await get(started.port, '/api/jobs/missing')).status).toBe(404);
    expect((await get(started.port, '/api/jobs/job-1/events/stream')).status).toBe(404);
  });
});
