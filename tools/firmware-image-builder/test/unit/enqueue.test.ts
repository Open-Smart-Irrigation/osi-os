import { describe, expect, it, vi } from 'vitest';

import {
  EnqueueError,
  createProductionEnqueueService,
  type EnqueueServiceOptions,
} from '../../api/src/enqueue.js';
import type { AcceptedPreflightResult, PreflightRequest, PreflightResult } from '../../api/src/preflight.js';
import type { ApiWriteCommand, OwnershipResult } from '../../api/src/ownership.js';
import type { JobRecord } from '../../api/src/store.js';

const SHA = 'a'.repeat(40);
const MANIFEST_SHA = 'b'.repeat(64);
const CREATED_AT = '2026-07-26T10:00:00.000Z';
const CHECKED_AT = '2026-07-26T10:01:00.000Z';
const ACCEPTED_AT = '2026-07-26T10:01:01.000Z';
const EXPIRES_AT = '2026-07-26T10:10:00.000Z';
const JOB_ID = 'job_enqueue_01';
const REQUEST_ID = 'req_enqueue_01';
const BUILDER_IDENTITY = Object.freeze({
  packageVersion: '0.1.24',
  packageRoot: '/home/builder/.local/lib/osi-image-builder/0.1.24',
  lockSha256: 'e'.repeat(64),
  executionDefinitionSha256: 'f'.repeat(64),
  targetManifestSha256: MANIFEST_SHA,
  runnerSha256: '1'.repeat(64),
  cleanupWorkerSha256: '2'.repeat(64),
  dependencyEgressProxySha256: '3'.repeat(64),
  imageReference: `registry.example.invalid/osi-image-builder@sha256:${'c'.repeat(64)}`,
  imageId: `sha256:${'d'.repeat(64)}`,
  imageDigest: 'c'.repeat(64),
});
const REQUEST = Object.freeze({
  branch: 'main',
  expectedSha: SHA,
  targetId: 'rpi-5' as const,
  outputRootId: 'images',
});

function sourcePreparation() {
  return Object.freeze({
    schemaVersion: 1 as const,
    sourceSha: SHA,
    gitmodulesBlobSha: 'c'.repeat(40),
    preparedAt: CREATED_AT,
    components: Object.freeze([
      Object.freeze({
        path: 'feeds/chirpstack-openwrt-feed' as const,
        mode: '040000' as const,
        type: 'tree' as const,
        objectId: 'd'.repeat(40),
        provenanceUrl: 'ssh://git.example/chirpstack-feed',
      }),
      Object.freeze({
        path: 'openwrt' as const,
        mode: '040000' as const,
        type: 'tree' as const,
        objectId: 'e'.repeat(40),
        provenanceUrl: 'ssh://git.example/openwrt',
      }),
    ]),
  });
}

function offlineFeedPreparation(jobId: string) {
  return Object.freeze({
    schemaVersion: 1 as const,
    boundary: 'api-prepared-pinned-feeds-v1' as const,
    networkPolicy: 'runner-offline' as const,
    jobId,
    sourceSha: SHA,
    preparedAt: CHECKED_AT,
    feeds: Object.freeze([]),
  });
}

function accepted(jobId = JOB_ID, preflightId = 'pf_enqueue_01'): AcceptedPreflightResult {
  return Object.freeze({
    preflightId,
    branch: REQUEST.branch,
    expectedSha: SHA,
    observedSha: SHA,
    source: Object.freeze({
      remote: 'origin' as const,
      originUrl: 'ssh://git.example/osi-os',
      ref: 'refs/remotes/origin/main',
      branch: 'main',
      sha: SHA,
      commitTime: CREATED_AT,
      author: 'Builder',
      subject: 'Current source',
      sourcePreparation: sourcePreparation(),
    }),
    target: Object.freeze({
      id: 'rpi-5' as const,
      label: 'Raspberry Pi 5',
      environment: 'full_raspberrypi_bcm27xx_bcm2712',
      openwrtTarget: 'bcm27xx/bcm2712',
      profile: 'DEVICE_rpi-5',
      rootfs: 'ext4',
      artifactGlob: '*.img.gz',
      rootfsPartSize: 14336 as const,
      minimumArtifactBytes: 67108864,
      configSymbols: Object.freeze([]),
      operations: Object.freeze([]),
    }),
    outputRoot: Object.freeze({
      id: 'images',
      label: 'Images',
      path: '/srv/images',
      quarantinePath: '/srv/images/.osi-image-builder/quarantine',
    }),
    createdAt: CREATED_AT,
    checkedAt: CHECKED_AT,
    expiresAt: EXPIRES_AT,
    checks: Object.freeze([]),
    jobId,
    offlineFeedPreparation: offlineFeedPreparation(jobId),
  });
}

function persistedJob(jobId = JOB_ID): JobRecord {
  return {
    jobId,
    requestId: REQUEST_ID,
    request: REQUEST,
    sourceRemote: 'ssh://git.example/osi-os',
    sourceRef: 'refs/remotes/origin/main',
    sourceBranch: 'main',
    branch: 'main',
    expectedSha: SHA,
    pinnedSha: SHA,
    sourcePreparation: sourcePreparation(),
    offlineFeedPreparation: offlineFeedPreparation(jobId),
    sourceRunnable: true,
    targetId: 'rpi-5',
    rootId: 'images',
    targetManifestSha256: MANIFEST_SHA,
    builderIdentity: BUILDER_IDENTITY,
    sourceCommitTime: CREATED_AT,
    sourceAuthor: 'Builder',
    sourceSubject: 'Current source',
    acceptedAt: ACCEPTED_AT,
    state: 'queued',
    currentStage: null,
    queueState: 'queued',
    queuePosition: 0,
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
  } as unknown as JobRecord;
}

type ApiCommand = Extract<ApiWriteCommand, { readonly kind: 'enqueue' }>;

function fixture(overrides: {
  readonly idFactory?: () => string;
  readonly run?: (request: PreflightRequest) => Promise<PreflightResult>;
  readonly accept?: (preflightId: string, request: PreflightRequest, jobId: string) => Promise<AcceptedPreflightResult>;
  readonly discard?: (jobId: string) => Promise<void>;
  readonly write?: (command: ApiWriteCommand) => OwnershipResult;
} = {}) {
  const run = vi.fn(overrides.run ?? (async () => accepted()));
  const accept = vi.fn(overrides.accept ?? (async (preflightId, _request, jobId) => accepted(jobId, preflightId)));
  const discard = vi.fn(overrides.discard ?? (async () => undefined));
  const write = vi.fn(overrides.write ?? (() => ({
    ok: true as const,
    kind: 'committed' as const,
    eventSeq: 0,
    value: undefined,
  })));
  const getJob = vi.fn((jobId: string) => persistedJob(jobId));
  const options = {
    manifest: {
      sha256: MANIFEST_SHA,
      manifest: {
        schemaVersion: 1 as const,
        repository: { name: 'osi-os' as const, remote: 'origin' as const },
        stages: [],
        stageDefinitions: {},
        targets: [],
      },
    },
    builderIdentity: BUILDER_IDENTITY,
    preflight: { run, accept, discardAcceptedJob: discard },
    ownership: { apiWrite: write },
    store: { getJob },
    idFactory: overrides.idFactory ?? (() => JOB_ID),
    now: () => new Date(ACCEPTED_AT),
  } as unknown as EnqueueServiceOptions;
  return { service: createProductionEnqueueService(options), run, accept, discard, write, getJob };
}

describe('production enqueue service', () => {
  it('runs an implicit preflight, accepts it, and persists exact source evidence once', async () => {
    const target = fixture();

    await expect(target.service.acceptAfterRefetchAndPersist(REQUEST, REQUEST_ID)).resolves.toEqual({
      kind: 'persisted-queued-job',
      secondOriginFetch: 'verified',
      persistence: 'atomic-source-job-queue',
      job: persistedJob(),
    });

    expect(target.run).toHaveBeenCalledOnce();
    expect(target.run).toHaveBeenCalledWith(REQUEST);
    expect(target.accept).toHaveBeenCalledWith('pf_enqueue_01', REQUEST, JOB_ID);
    expect(target.write).toHaveBeenCalledOnce();
    const command = target.write.mock.calls[0]![0] as ApiCommand;
    expect(command).toEqual({
      kind: 'enqueue',
      input: {
        jobId: JOB_ID,
        requestId: REQUEST_ID,
        request: REQUEST,
        sourceRemote: 'ssh://git.example/osi-os',
        sourceRef: 'refs/remotes/origin/main',
        sourceBranch: 'main',
        branch: 'main',
        expectedSha: SHA,
        pinnedSha: SHA,
        sourcePreparation: sourcePreparation(),
        offlineFeedPreparation: offlineFeedPreparation(JOB_ID),
        targetId: 'rpi-5',
        rootId: 'images',
        targetManifestSha256: MANIFEST_SHA,
        builderIdentity: BUILDER_IDENTITY,
        sourceCommitTime: CREATED_AT,
        sourceAuthor: 'Builder',
        sourceSubject: 'Current source',
        preflightSha: SHA,
        preflightCheckedAt: CHECKED_AT,
        preflightExpiresAt: EXPIRES_AT,
        acceptedAt: ACCEPTED_AT,
      },
    });
    expect(target.getJob).toHaveBeenCalledWith(JOB_ID);
  });

  it('uses the supplied preflight token without running another advisory preflight', async () => {
    const target = fixture();
    const request = Object.freeze({ ...REQUEST, preflightId: 'pf_supplied_01' });

    await target.service.acceptAfterRefetchAndPersist(request, REQUEST_ID);

    expect(target.run).not.toHaveBeenCalled();
    expect(target.accept).toHaveBeenCalledWith('pf_supplied_01', REQUEST, JOB_ID);
    expect((target.write.mock.calls[0]![0] as ApiCommand).input.request).toEqual(REQUEST);
    expect((target.write.mock.calls[0]![0] as ApiCommand).input.request).not.toHaveProperty('preflightId');
  });

  it('rejects an invalid generated ID before preflight or persistence', async () => {
    const target = fixture({ idFactory: () => '../invalid' });

    await expect(target.service.acceptAfterRefetchAndPersist(REQUEST, REQUEST_ID)).rejects.toMatchObject({
      name: 'EnqueueError',
      code: 'ENQUEUE_ID_INVALID',
      status: 500,
    });
    expect(target.run).not.toHaveBeenCalled();
    expect(target.accept).not.toHaveBeenCalled();
    expect(target.write).not.toHaveBeenCalled();
  });

  it.each(['branch moved', 'expired', 'feed preparation failed'])(
    'does not write when acceptance fails: %s',
    async () => {
      const failure = new Error('acceptance failed');
      const target = fixture({ accept: async () => { throw failure; } });

      await expect(target.service.acceptAfterRefetchAndPersist(
        { ...REQUEST, preflightId: 'pf_failed_01' },
        REQUEST_ID,
      )).rejects.toBe(failure);
      expect(target.write).not.toHaveBeenCalled();
      expect(target.getJob).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['queue-full', 'QUEUE_FULL'],
    ['cas-lost', 'ENQUEUE_CONFLICT'],
  ] as const)('maps %s ownership conflicts to a stable transport error', async (kind, code) => {
    const target = fixture({
      write: () => ({ ok: false, conflict: { kind, message: 'private database details' } }),
    });

    await expect(target.service.acceptAfterRefetchAndPersist(REQUEST, REQUEST_ID)).rejects.toMatchObject({
      name: 'EnqueueError',
      code,
      status: 409,
      retryable: true,
      details: {},
    });
    expect(target.getJob).not.toHaveBeenCalled();
    expect(target.discard).toHaveBeenCalledWith(JOB_ID);
  });

  it('rejects mismatched accepted evidence before persistence', async () => {
    const target = fixture({
      accept: async (_preflightId, _request, jobId) => ({
        ...accepted(jobId),
        observedSha: 'f'.repeat(40),
      }),
    });

    await expect(target.service.acceptAfterRefetchAndPersist(REQUEST, REQUEST_ID)).rejects.toBeInstanceOf(EnqueueError);
    expect(target.write).not.toHaveBeenCalled();
    expect(target.discard).toHaveBeenCalledWith(JOB_ID);
  });

  it('rejects a malformed accepted origin URL before persistence', async () => {
    const target = fixture({
      accept: async (_preflightId, _request, jobId) => ({
        ...accepted(jobId),
        source: {
          ...accepted(jobId).source,
          originUrl: 'https://github.com/Open-Smart-Irrigation/osi-os.git',
        },
      }),
    });

    await expect(target.service.acceptAfterRefetchAndPersist(REQUEST, REQUEST_ID)).rejects.toMatchObject({
      name: 'EnqueueError',
      code: 'ENQUEUE_ACCEPTANCE_INVALID',
      status: 500,
    });
    expect(target.write).not.toHaveBeenCalled();
    expect(target.discard).toHaveBeenCalledWith(JOB_ID);
  });

  it('fails closed when prepared-feed rollback cannot be verified', async () => {
    const target = fixture({
      write: () => ({ ok: false, conflict: { kind: 'queue-full', message: 'full' } }),
      discard: async () => { throw new Error('cleanup failed'); },
    });

    await expect(target.service.acceptAfterRefetchAndPersist(REQUEST, REQUEST_ID)).rejects.toMatchObject({
      name: 'EnqueueError',
      code: 'ENQUEUE_CLEANUP_FAILED',
      status: 503,
      retryable: true,
    });
    expect(target.getJob).not.toHaveBeenCalled();
  });

  it('rejects and cleans a preflight that expires before the enqueue transaction', async () => {
    const target = fixture();
    const service = createProductionEnqueueService({
      manifest: {
        sha256: MANIFEST_SHA,
        manifest: {} as never,
      },
      builderIdentity: BUILDER_IDENTITY,
      preflight: {
        run: target.run,
        accept: target.accept,
        discardAcceptedJob: target.discard,
      },
      ownership: { apiWrite: target.write },
      store: { getJob: target.getJob },
      idFactory: () => JOB_ID,
      now: () => new Date(EXPIRES_AT),
    });

    await expect(service.acceptAfterRefetchAndPersist(REQUEST, REQUEST_ID)).rejects.toMatchObject({
      code: 'PREFLIGHT_EXPIRED',
      retryable: true,
      requestId: REQUEST_ID,
    });
    expect(target.write).not.toHaveBeenCalled();
    expect(target.discard).toHaveBeenCalledWith(JOB_ID);
  });
});
