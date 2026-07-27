import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { OwnershipStore } from '../../api/src/ownership.js';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { BuilderStore, type CreateJobInput } from '../../api/src/store.js';
import { createRunnerCancellation } from '../../runner/src/cancellation.js';

const NOW = '2026-07-27T09:00:00.000Z';
const LATER = '2026-07-27T09:00:01.000Z';
const SHA40 = 'a'.repeat(40);
const SHA64 = 'b'.repeat(64);
const CONTAINER_ID = 'c'.repeat(64);
const CONTAINER_NAME = 'osi-image-builder-cancel-integration';
const tempDirectories: string[] = [];

function sourcePreparation() {
  return {
    schemaVersion: 1 as const,
    sourceSha: SHA40,
    gitmodulesBlobSha: 'c'.repeat(40),
    preparedAt: NOW,
    components: [
      { path: 'feeds/chirpstack-openwrt-feed' as const, mode: '040000' as const, type: 'tree' as const, objectId: 'd'.repeat(40), provenanceUrl: 'https://github.com/chirpstack/chirpstack-openwrt-feed.git' },
      { path: 'openwrt' as const, mode: '040000' as const, type: 'tree' as const, objectId: 'e'.repeat(40), provenanceUrl: 'https://github.com/openwrt/openwrt.git' },
    ],
  };
}

function feeds(jobId: string) {
  return {
    schemaVersion: 1 as const,
    boundary: 'api-prepared-pinned-feeds-v1' as const,
    networkPolicy: 'runner-offline' as const,
    jobId,
    sourceSha: SHA40,
    preparedAt: NOW,
    feeds: [
      { name: 'packages', location: 'https://git.openwrt.org/feed/packages.git', commit: 'd8cd30f4e281d6853b3de134c4f147a807583e43', detached: true as const, clean: true as const, recursiveSubmodulesPrepared: true as const, recursiveSubmodules: [], recursiveSubmoduleStatusSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', treeSha256: SHA64 },
      { name: 'luci', location: 'https://git.openwrt.org/project/luci.git', commit: '2ac26e56cc55102cb10e7b0867c2b78e0f6d5fd8', detached: true as const, clean: true as const, recursiveSubmodulesPrepared: true as const, recursiveSubmodules: [], recursiveSubmoduleStatusSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', treeSha256: SHA64 },
      { name: 'routing', location: 'https://git.openwrt.org/feed/routing.git', commit: 'c9b636698881059a3c981032770968f5a98ff201', detached: true as const, clean: true as const, recursiveSubmodulesPrepared: true as const, recursiveSubmodules: [], recursiveSubmoduleStatusSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', treeSha256: SHA64 },
    ],
  };
}

async function fixture(options: { readonly cancellation?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'osi-runner-cancel-'));
  tempDirectories.push(directory);
  const db = openBuilderDatabase(join(directory, 'jobs.sqlite'));
  const ownership = new OwnershipStore(db, { now: () => NOW });
  const store = new BuilderStore(db);
  const input: CreateJobInput = {
    jobId: 'job-cancel-integration',
    requestId: 'request-cancel-integration',
    request: { branch: 'main', target: 'rpi-5' },
    sourceRemote: 'git@example.com:osi-os.git',
    sourceRef: 'refs/remotes/origin/main',
    sourceBranch: 'main',
    branch: 'main',
    expectedSha: SHA40,
    pinnedSha: SHA40,
    sourcePreparation: sourcePreparation(),
    offlineFeedPreparation: feeds('job-cancel-integration'),
    targetId: 'rpi-5',
    rootId: 'release',
    targetManifestSha256: SHA64,
    sourceCommitTime: NOW,
    sourceAuthor: 'Builder',
    sourceSubject: 'cancellation integration',
    acceptedAt: NOW,
  };
  expect(ownership.apiWrite({ kind: 'enqueue', input }).ok).toBe(true);
  expect(ownership.apiWrite({ kind: 'dispatch', jobId: input.jobId, runnerUnit: `osi-image-builder-runner@${input.jobId}.service`, at: LATER }).ok).toBe(true);
  expect(ownership.runnerWrite({ kind: 'acquire-lease', jobId: input.jobId, runnerUnit: `osi-image-builder-runner@${input.jobId}.service`, owner: 'runner-integration', expiresAt: '2026-07-27T09:10:00.000Z', at: LATER }).ok).toBe(true);
  if (options.cancellation !== false) {
    expect(ownership.apiWrite({ kind: 'request-cancellation', jobId: input.jobId, reason: 'operator', at: '2026-07-27T09:00:02.000Z' }).ok).toBe(true);
  }
  return { db, ownership, store, input };
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function persistContainer(fixtureValue: Awaited<ReturnType<typeof fixture>>, lifecycle: 'created' | 'stopped'): void {
  const stopped = lifecycle === 'stopped';
  expect(fixtureValue.ownership.runnerWrite({
    kind: 'container',
    jobId: fixtureValue.input.jobId,
    owner: 'runner-integration',
    runnerUnit: `osi-image-builder-runner@${fixtureValue.input.jobId}.service`,
    leaseExpiresAt: '2026-07-27T09:10:00.000Z',
    at: stopped ? '2026-07-27T09:00:02.000Z' : LATER,
    lifecycle,
    containerId: CONTAINER_ID,
    containerName: CONTAINER_NAME,
    imageDigest: SHA64,
    labels: {
      'org.osi.image-builder.job-id': fixtureValue.input.jobId,
      'org.osi.image-builder.manifest-sha': SHA64,
    },
    mount: { source: '/tmp', destination: '/work' },
    environment: { CI: '1' },
    security: { user: '1000:1000' },
    inspection: { running: !stopped, status: stopped ? 'exited' : 'created' },
    occurredAt: stopped ? '2026-07-27T09:00:02.000Z' : LATER,
    createdAt: LATER,
    ...(stopped ? { startedAt: LATER, stoppedAt: '2026-07-27T09:00:02.000Z' } : {}),
  }).ok).toBe(true);
}

describe('runner cancellation with the persisted ownership store', () => {
  it('commits transition, cleanup evidence, and terminal state through runner CAS', async () => {
    const fixtureValue = await fixture();
    const evidence: unknown[] = [];
    const controller = createRunnerCancellation({
      jobId: fixtureValue.input.jobId,
      runnerUnit: `osi-image-builder-runner@${fixtureValue.input.jobId}.service`,
      owner: 'runner-integration',
      leaseExpiresAt: () => '2026-07-27T09:10:00.000Z',
      store: fixtureValue.store,
      ownership: fixtureValue.ownership,
      docker: {
        inspect: async () => null,
        stop: async () => { throw new Error('stop must not be called for a pre-container cancellation'); },
        remove: async () => { throw new Error('remove must not be called for a pre-container cancellation'); },
        waitForStopped: async () => { throw new Error('wait must not be called for a pre-container cancellation'); },
        listByLabels: async () => [],
      },
      evidence: async (record) => {
        evidence.push(record);
        return { path: 'jobs/job-cancel-integration/evidence/cancellation.json', sha256: SHA64 };
      },
      cleanup: {
        staging: async () => ({ kind: 'absent', path: null }),
        logs: async () => ({ runner: 'sealed', docker: 'sealed', verifiedAt: '2026-07-27T09:00:03.000Z' }),
      },
      clock: () => '2026-07-27T09:00:03.000Z',
      signals: { on: () => undefined, off: () => undefined },
    });

    await expect(controller.cancelIfRequested()).resolves.toMatchObject({ state: 'cancelled' });
    expect(fixtureValue.store.getJob(fixtureValue.input.jobId)).toMatchObject({
      state: 'cancelled',
      containerId: null,
      terminalErrorCode: 'CANCELLED',
    });
    expect(evidence).toHaveLength(1);
    expect(fixtureValue.store.listEvents(fixtureValue.input.jobId).events.map((event) => event.eventType)).toEqual([
      'enqueue', 'dispatch', 'state', 'cancellation_requested', 'state', 'cleanup', 'cleanup', 'terminal',
    ]);
    fixtureValue.db.close();
  });

  it('retains a present exact container through durable evidence before cleanup CAS', async () => {
    const fixtureValue = await fixture({ cancellation: false });
    persistContainer(fixtureValue, 'created');
    expect(fixtureValue.ownership.apiWrite({ kind: 'request-cancellation', jobId: fixtureValue.input.jobId, reason: 'operator', at: '2026-07-27T09:00:03.000Z' }).ok).toBe(true);
    const current = {
      id: CONTAINER_ID,
      name: CONTAINER_NAME,
      imageDigest: SHA64,
      labels: {
        'org.osi.image-builder.job-id': fixtureValue.input.jobId,
        'org.osi.image-builder.manifest-sha': SHA64,
      },
      running: true,
      status: 'running',
      stoppedAt: null as string | null,
    };
    let removed = false;
    const docker = {
      inspect: async () => removed ? null : current,
      stop: async () => { current.running = false; current.status = 'exited'; current.stoppedAt = '2026-07-27T09:00:04.000Z'; },
      waitForStopped: async () => current,
      remove: async () => { removed = true; },
      listByLabels: async () => [],
    };
    const evidence: unknown[] = [];
    const controller = createRunnerCancellation({
      jobId: fixtureValue.input.jobId,
      runnerUnit: `osi-image-builder-runner@${fixtureValue.input.jobId}.service`,
      owner: 'runner-integration',
      leaseExpiresAt: () => '2026-07-27T09:10:00.000Z',
      store: fixtureValue.store,
      ownership: fixtureValue.ownership,
      docker,
      evidence: async (record) => { evidence.push(record); return { path: `jobs/${fixtureValue.input.jobId}/evidence/cancellation.json`, sha256: SHA64 }; },
      cleanup: { staging: async () => ({ kind: 'absent', path: null }), logs: async () => ({ runner: 'sealed', docker: 'sealed', verifiedAt: '2026-07-27T09:00:05.000Z' }) },
      clock: () => '2026-07-27T09:00:05.000Z',
      signals: { on: () => undefined, off: () => undefined },
    });

    await expect(controller.cancelIfRequested()).resolves.toMatchObject({ state: 'cancelled' });
    expect(evidence).toHaveLength(1);
    expect(fixtureValue.store.getJob(fixtureValue.input.jobId)).toMatchObject({ state: 'cancelled', containerId: null, terminalErrorCode: 'CANCELLED' });
    expect(fixtureValue.db.prepare("SELECT json_extract(payload_json, '$.kind') AS kind FROM job_events WHERE job_id=? AND event_type='cleanup' ORDER BY seq LIMIT 1").get(fixtureValue.input.jobId)).toEqual({ kind: 'cancellation-evidence' });
    fixtureValue.db.close();
  });

  it('retries an already-absent stopped exact container without docker rm', async () => {
    const fixtureValue = await fixture({ cancellation: false });
    persistContainer(fixtureValue, 'created');
    persistContainer(fixtureValue, 'stopped');
    expect(fixtureValue.ownership.apiWrite({ kind: 'request-cancellation', jobId: fixtureValue.input.jobId, reason: 'operator', at: '2026-07-27T09:00:03.000Z' }).ok).toBe(true);
    let removed = false;
    const controller = createRunnerCancellation({
      jobId: fixtureValue.input.jobId,
      runnerUnit: `osi-image-builder-runner@${fixtureValue.input.jobId}.service`,
      owner: 'runner-integration',
      leaseExpiresAt: () => '2026-07-27T09:10:00.000Z',
      store: fixtureValue.store,
      ownership: fixtureValue.ownership,
      docker: {
        inspect: async () => null,
        stop: async () => { throw new Error('already-absent retry must not stop'); },
        waitForStopped: async () => { throw new Error('already-absent retry must not wait'); },
        remove: async () => { removed = true; },
        listByLabels: async () => [],
      },
      evidence: async () => ({ path: `jobs/${fixtureValue.input.jobId}/evidence/cancellation.json`, sha256: SHA64 }),
      cleanup: { staging: async () => ({ kind: 'absent', path: null }), logs: async () => ({ runner: 'sealed', docker: 'sealed', verifiedAt: '2026-07-27T09:00:05.000Z' }) },
      clock: () => '2026-07-27T09:00:05.000Z',
      signals: { on: () => undefined, off: () => undefined },
    });

    await expect(controller.cancelIfRequested()).resolves.toMatchObject({ state: 'cancelled' });
    expect(removed).toBe(false);
    expect(fixtureValue.store.getJob(fixtureValue.input.jobId)).toMatchObject({ state: 'cancelled', containerId: null });
    fixtureValue.db.close();
  });
});
