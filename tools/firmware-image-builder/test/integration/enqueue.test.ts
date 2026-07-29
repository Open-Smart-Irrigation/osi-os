import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createProductionEnqueueService, type EnqueueServiceOptions } from '../../api/src/enqueue.js';
import { OwnershipStore } from '../../api/src/ownership.js';
import type { AcceptedPreflightResult, PreflightRequest, PreflightResult } from '../../api/src/preflight.js';
import { BuilderStore } from '../../api/src/store.js';
import { openBuilderDatabase } from '../../api/src/store-schema.js';

const SHA = 'a'.repeat(40);
const MANIFEST_SHA = 'b'.repeat(64);
const CREATED_AT = '2026-07-26T10:00:00.000Z';
const CHECKED_AT = '2026-07-26T10:01:00.000Z';
const ACCEPTED_AT = '2026-07-26T10:01:01.000Z';
const EXPIRES_AT = '2026-07-26T10:10:00.000Z';
const REQUEST = Object.freeze({
  branch: 'main',
  expectedSha: SHA,
  targetId: 'rpi-5' as const,
  outputRootId: 'images',
  preflightId: 'pf_enqueue_integration',
});
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function accepted(jobId: string): AcceptedPreflightResult {
  const recursiveSubmoduleStatusSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  return {
    preflightId: REQUEST.preflightId,
    branch: 'main',
    expectedSha: SHA,
    observedSha: SHA,
    source: {
      remote: 'origin',
      originUrl: 'ssh://git.example/osi-os',
      ref: 'refs/remotes/origin/main',
      branch: 'main',
      sha: SHA,
      commitTime: CREATED_AT,
      author: 'Builder',
      subject: 'Current source',
      sourcePreparation: {
        schemaVersion: 1,
        sourceSha: SHA,
        gitmodulesBlobSha: 'c'.repeat(40),
        preparedAt: CREATED_AT,
        components: [
          { path: 'feeds/chirpstack-openwrt-feed', mode: '040000', type: 'tree', objectId: 'd'.repeat(40), provenanceUrl: 'https://github.com/chirpstack/chirpstack-openwrt-feed.git' },
          { path: 'openwrt', mode: '040000', type: 'tree', objectId: 'e'.repeat(40), provenanceUrl: 'https://github.com/openwrt/openwrt.git' },
        ],
      },
    },
    target: {
      id: 'rpi-5',
      label: 'Raspberry Pi 5',
      environment: 'full_raspberrypi_bcm27xx_bcm2712',
      openwrtTarget: 'bcm27xx/bcm2712',
      profile: 'DEVICE_rpi-5',
      rootfs: 'ext4',
      artifactGlob: '*.img.gz',
      rootfsPartSize: 14336,
      minimumArtifactBytes: 67108864,
      configSymbols: [],
      operations: [],
    },
    outputRoot: {
      id: 'images',
      label: 'Images',
      path: '/srv/images',
      quarantinePath: '/srv/images/.osi-image-builder/quarantine',
    },
    createdAt: CREATED_AT,
    checkedAt: CHECKED_AT,
    expiresAt: EXPIRES_AT,
    checks: [],
    jobId,
    offlineFeedPreparation: {
      schemaVersion: 1,
      boundary: 'api-prepared-pinned-feeds-v1',
      networkPolicy: 'runner-offline',
      jobId,
      sourceSha: SHA,
      preparedAt: CHECKED_AT,
      feeds: [
        {
          name: 'packages',
          location: 'https://git.openwrt.org/feed/packages.git',
          commit: 'd8cd30f4e281d6853b3de134c4f147a807583e43',
          detached: true,
          clean: true,
          recursiveSubmodulesPrepared: true,
          recursiveSubmodules: [],
          recursiveSubmoduleStatusSha256,
          treeSha256: 'f'.repeat(64),
        },
        {
          name: 'luci',
          location: 'https://git.openwrt.org/project/luci.git',
          commit: '2ac26e56cc55102cb10e7b0867c2b78e0f6d5fd8',
          detached: true,
          clean: true,
          recursiveSubmodulesPrepared: true,
          recursiveSubmodules: [],
          recursiveSubmoduleStatusSha256,
          treeSha256: '1'.repeat(64),
        },
        {
          name: 'routing',
          location: 'https://git.openwrt.org/feed/routing.git',
          commit: 'c9b636698881059a3c981032770968f5a98ff201',
          detached: true,
          clean: true,
          recursiveSubmodulesPrepared: true,
          recursiveSubmodules: [],
          recursiveSubmoduleStatusSha256,
          treeSha256: '2'.repeat(64),
        },
      ],
    },
  };
}

async function fixture(options: {
  readonly failBeforeCommit?: () => void;
  readonly maxQueueLength?: number;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'osi-enqueue-'));
  directories.push(directory);
  const db = openBuilderDatabase(join(directory, 'jobs.sqlite'));
  const ownership = new OwnershipStore(db, {
    now: () => CHECKED_AT,
    ...(options.maxQueueLength === undefined ? {} : { maxQueueLength: options.maxQueueLength }),
    ...(options.failBeforeCommit === undefined ? {} : { failBeforeCommit: options.failBeforeCommit }),
  });
  const store = new BuilderStore(db);
  const preflight = {
    run: async (_request: PreflightRequest): Promise<PreflightResult> => accepted('unused'),
    accept: async (_preflightId: string, _request: PreflightRequest, jobId: string) => accepted(jobId),
    discardedJobIds: [] as string[],
    discardAcceptedJob: async (jobId: string) => { preflight.discardedJobIds.push(jobId); },
  };
  let sequence = 0;
  const service = createProductionEnqueueService({
    manifest: {
      sha256: MANIFEST_SHA,
      manifest: {
        schemaVersion: 1,
        repository: { name: 'osi-os', remote: 'origin' },
        stages: [],
        stageDefinitions: {},
        targets: [],
      },
    },
    preflight,
    ownership,
    store,
    idFactory: () => `job_enqueue_${++sequence}`,
    now: () => new Date(ACCEPTED_AT),
  } as unknown as EnqueueServiceOptions);
  return { db, store, service, preflight };
}

describe('production enqueue persistence', () => {
  it('atomically inserts exact source, job, FIFO, preflight, and one event record', async () => {
    const target = await fixture();

    const first = await target.service.acceptAfterRefetchAndPersist(REQUEST, 'req_enqueue_1');
    const second = await target.service.acceptAfterRefetchAndPersist(REQUEST, 'req_enqueue_2');

    expect(first.job).toMatchObject({ jobId: 'job_enqueue_1', queuePosition: 0, state: 'queued' });
    expect(second.job).toMatchObject({ jobId: 'job_enqueue_2', queuePosition: 1, state: 'queued' });
    expect(target.store.getSourceIdentity('job_enqueue_1')).toMatchObject({
      sourceRemote: 'origin',
      sourceRef: 'refs/remotes/origin/main',
      sourceBranch: 'main',
      expectedSha: SHA,
      pinnedSha: SHA,
      sourceAuthor: 'Builder',
      sourceSubject: 'Current source',
      sourcePreparation: accepted('job_enqueue_1').source.sourcePreparation,
      offlineFeedPreparation: accepted('job_enqueue_1').offlineFeedPreparation,
    });
    expect(target.db.prepare(`SELECT request_json, target_id, root_id, target_manifest_sha256,
      preflight_sha, preflight_checked_at, preflight_expires_at, accepted_at
      FROM jobs WHERE job_id=?`).get('job_enqueue_1')).toEqual({
      request_json: JSON.stringify({
        branch: 'main',
        expectedSha: SHA,
        outputRootId: 'images',
        targetId: 'rpi-5',
      }),
      target_id: 'rpi-5',
      root_id: 'images',
      target_manifest_sha256: MANIFEST_SHA,
      preflight_sha: SHA,
      preflight_checked_at: CHECKED_AT,
      preflight_expires_at: EXPIRES_AT,
      accepted_at: ACCEPTED_AT,
    });
    expect(target.db.prepare('SELECT job_id, fifo_seq, enqueued_at FROM queue_entries ORDER BY fifo_seq').all()).toEqual([
      { job_id: 'job_enqueue_1', fifo_seq: 0, enqueued_at: ACCEPTED_AT },
      { job_id: 'job_enqueue_2', fifo_seq: 1, enqueued_at: ACCEPTED_AT },
    ]);
    expect(target.store.listEvents('job_enqueue_1').events).toHaveLength(1);
    expect(target.store.listEvents('job_enqueue_1').events[0]).toMatchObject({
      seq: 0,
      eventType: 'enqueue',
      at: ACCEPTED_AT,
      payload: { requestId: 'req_enqueue_1' },
    });
  });

  it('rolls back all enqueue rows and returns a typed persistence failure', async () => {
    const target = await fixture({ failBeforeCommit: () => { throw new Error('injected commit failure'); } });

    await expect(target.service.acceptAfterRefetchAndPersist(REQUEST, 'req_enqueue_failure')).rejects.toMatchObject({
      name: 'EnqueueError',
      code: 'ENQUEUE_PERSISTENCE_FAILED',
      status: 503,
      retryable: true,
    });
    expect(target.db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 });
    expect(target.db.prepare('SELECT COUNT(*) AS count FROM queue_entries').get()).toEqual({ count: 0 });
    expect(target.db.prepare('SELECT COUNT(*) AS count FROM job_events').get()).toEqual({ count: 0 });
    expect(target.preflight.discardedJobIds).toEqual(['job_enqueue_1']);
  });

  it('enforces the configured queue bound inside the atomic transaction', async () => {
    const target = await fixture({ maxQueueLength: 1 });
    await target.service.acceptAfterRefetchAndPersist(REQUEST, 'req_enqueue_capacity_1');

    await expect(target.service.acceptAfterRefetchAndPersist(
      REQUEST,
      'req_enqueue_capacity_2',
    )).rejects.toMatchObject({
      name: 'EnqueueError',
      code: 'QUEUE_FULL',
      status: 409,
      retryable: true,
    });
    expect(target.db.prepare('SELECT job_id FROM jobs ORDER BY job_id').all()).toEqual([
      { job_id: 'job_enqueue_1' },
    ]);
    expect(target.db.prepare('SELECT job_id FROM queue_entries').all()).toEqual([
      { job_id: 'job_enqueue_1' },
    ]);
    expect(target.db.prepare('SELECT job_id FROM job_events').all()).toEqual([
      { job_id: 'job_enqueue_1' },
    ]);
    expect(target.preflight.discardedJobIds).toEqual(['job_enqueue_2']);
  });
});
