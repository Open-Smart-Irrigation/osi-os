import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { OwnershipStore } from '../../api/src/ownership.js';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { BuilderStore, type CreateJobInput, type JsonObject } from '../../api/src/store.js';
import { encodeJson } from '../../api/src/validation.js';
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
  return { db, directory, ownership, store, input };
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
        logs: async () => ({ runner: 'absent', docker: 'absent', verifiedAt: '2026-07-27T09:00:03.000Z' }),
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

  it('retries a repaired cancellation blocker after a fresh signal and reaches cancelled', async () => {
    const fixtureValue = await fixture();
    const listeners = new Set<() => void>();
    const signals = {
      on: (_signal: 'SIGUSR1', listener: () => void) => { listeners.add(listener); },
      off: (_signal: 'SIGUSR1', listener: () => void) => { listeners.delete(listener); },
      emit: () => { for (const listener of listeners) listener(); },
    };
    let stagingBlocked = true;
    const controller = createRunnerCancellation({
      jobId: fixtureValue.input.jobId,
      runnerUnit: `osi-image-builder-runner@${fixtureValue.input.jobId}.service`,
      owner: 'runner-integration',
      leaseExpiresAt: () => '2026-07-27T09:10:00.000Z',
      store: fixtureValue.store,
      ownership: fixtureValue.ownership,
      docker: {
        inspect: async () => null,
        stop: async () => { throw new Error('pre-container retry must not stop'); },
        remove: async () => { throw new Error('pre-container retry must not remove'); },
        waitForStopped: async () => { throw new Error('pre-container retry must not wait'); },
        listByLabels: async () => [],
      },
      evidence: async () => ({
        path: `jobs/${fixtureValue.input.jobId}/evidence/cancellation.json`,
        sha256: SHA64,
      }),
      cleanup: {
        staging: async () => {
          if (stagingBlocked) throw new Error('temporary quarantine inspection failure');
          return { kind: 'absent', path: null };
        },
        logs: async () => fixtureValue.ownership.cancellationLogProof(
          fixtureValue.input.jobId,
          '2026-07-27T09:00:03.000Z',
        ),
      },
      clock: () => '2026-07-27T09:00:03.000Z',
      signals,
    });

    signals.emit();
    await expect(controller.cancelIfRequested()).rejects.toMatchObject({
      blockerCode: 'QUARANTINE_PENDING',
    });
    expect(fixtureValue.store.getJob(fixtureValue.input.jobId).state).toBe('cancel_requested');
    expect((fixtureValue.db.prepare('SELECT cleanup_blocker_code FROM jobs WHERE job_id=?').get(fixtureValue.input.jobId) as { cleanup_blocker_code: string | null }).cleanup_blocker_code).toBe('QUARANTINE_PENDING');

    stagingBlocked = false;
    signals.emit();
    await expect(controller.cancelIfRequested()).resolves.toMatchObject({
      state: 'cancelled',
    });
    expect(fixtureValue.store.getJob(fixtureValue.input.jobId).state).toBe('cancelled');
    expect((fixtureValue.db.prepare('SELECT cleanup_blocker_code FROM jobs WHERE job_id=?').get(fixtureValue.input.jobId) as { cleanup_blocker_code: string | null }).cleanup_blocker_code).toBeNull();
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
      createdAt: LATER,
      startedAt: LATER,
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
      cleanup: { staging: async () => ({ kind: 'absent', path: null }), logs: async () => ({ runner: 'absent', docker: 'absent', verifiedAt: '2026-07-27T09:00:05.000Z' }) },
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
      cleanup: { staging: async () => ({ kind: 'absent', path: null }), logs: async () => ({ runner: 'absent', docker: 'absent', verifiedAt: '2026-07-27T09:00:05.000Z' }) },
      clock: () => '2026-07-27T09:00:05.000Z',
      signals: { on: () => undefined, off: () => undefined },
    });

    await expect(controller.cancelIfRequested()).resolves.toMatchObject({ state: 'cancelled' });
    expect(removed).toBe(false);
    expect(fixtureValue.store.getJob(fixtureValue.input.jobId)).toMatchObject({ state: 'cancelled', containerId: null });
    fixtureValue.db.close();
  });

  it('reuses durable cancellation evidence after rm succeeds and cleanup CAS crashes', async () => {
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
      createdAt: LATER,
      startedAt: LATER,
      stoppedAt: null as string | null,
    };
    let removed = false;
    let removeCalls = 0;
    let rejectCleanup = true;
    const evidenceRecords: unknown[] = [];
    const chronology: string[] = [];
    const ownership = {
      runnerWrite: (command: Parameters<typeof fixtureValue.ownership.runnerWrite>[0]) => {
        chronology.push(`ownership:${command.kind}`);
        if (command.kind === 'cancellation-cleanup' && rejectCleanup) {
          return { ok: false as const, conflict: { kind: 'cas-lost' as const, message: 'injected crash after rm' } };
        }
        return fixtureValue.ownership.runnerWrite(command);
      },
    };
    const docker = {
      inspect: async () => removed ? null : current,
      stop: async () => {
        chronology.push('docker:stop');
        current.running = false;
        current.status = 'exited';
        current.stoppedAt = '2026-07-27T09:00:04.000Z';
      },
      waitForStopped: async () => {
        chronology.push('docker:wait-stopped');
        return current;
      },
      remove: async () => {
        chronology.push('docker:rm');
        removeCalls += 1;
        removed = true;
      },
      listByLabels: async () => [],
    };
    const first = createRunnerCancellation({
      jobId: fixtureValue.input.jobId,
      runnerUnit: `osi-image-builder-runner@${fixtureValue.input.jobId}.service`,
      owner: 'runner-integration',
      leaseExpiresAt: () => '2026-07-27T09:10:00.000Z',
      store: fixtureValue.store,
      ownership,
      docker,
      evidence: async (record) => {
        chronology.push('evidence:file');
        evidenceRecords.push(record);
        return { path: `jobs/${fixtureValue.input.jobId}/evidence/cancellation.json`, sha256: SHA64 };
      },
      cleanup: {
        staging: async () => ({ kind: 'absent', path: null }),
        logs: async () => ({ runner: 'absent', docker: 'absent', verifiedAt: '2026-07-27T09:00:05.000Z' }),
      },
      clock: () => '2026-07-27T09:00:05.000Z',
      signals: { on: () => undefined, off: () => undefined },
    });

    await expect(first.cancelIfRequested()).rejects.toMatchObject({
      blockerCode: 'RUNNER_DISAPPEARED',
    });
    const stoppedAfterCrash = fixtureValue.store.getJob(fixtureValue.input.jobId);
    expect(stoppedAfterCrash).toMatchObject({
      state: 'cancel_requested',
      containerId: CONTAINER_ID,
      containerStoppedAt: '2026-07-27T09:00:04.000Z',
    });
    const evidenceEvent = fixtureValue.store.listEvents(fixtureValue.input.jobId).events.find(
      (event) => event.eventType === 'cleanup' && event.payload.kind === 'cancellation-evidence',
    );
    expect(evidenceEvent).toBeDefined();
    expect(removeCalls).toBe(1);
    expect(evidenceRecords).toHaveLength(1);
    expect(chronology.indexOf('docker:wait-stopped')).toBeLessThan(chronology.indexOf('ownership:container'));
    expect(chronology.indexOf('ownership:container')).toBeLessThan(chronology.indexOf('evidence:file'));
    expect(chronology.indexOf('evidence:file')).toBeLessThan(chronology.indexOf('ownership:cancellation-evidence'));
    expect(chronology.indexOf('ownership:cancellation-evidence')).toBeLessThan(chronology.indexOf('docker:rm'));
    expect(chronology.indexOf('docker:rm')).toBeLessThan(chronology.indexOf('ownership:cancellation-cleanup'));

    rejectCleanup = false;
    const second = createRunnerCancellation({
      jobId: fixtureValue.input.jobId,
      runnerUnit: `osi-image-builder-runner@${fixtureValue.input.jobId}.service`,
      owner: 'runner-integration',
      leaseExpiresAt: () => '2026-07-27T09:10:00.000Z',
      store: fixtureValue.store,
      ownership,
      docker: {
        ...docker,
        stop: async () => { throw new Error('retry must not stop an absent container'); },
        waitForStopped: async () => { throw new Error('retry must not wait for an absent container'); },
        remove: async () => { throw new Error('retry must not remove an already-absent container'); },
      },
      evidence: async () => { throw new Error('retry must reuse the immutable evidence file'); },
      cleanup: {
        staging: async () => { throw new Error('retry must reuse persisted staging proof'); },
        logs: async () => { throw new Error('retry must reuse persisted log proof'); },
      },
      clock: () => '2026-07-27T09:00:06.000Z',
      signals: { on: () => undefined, off: () => undefined },
    });

    await expect(second.cancelIfRequested()).resolves.toMatchObject({
      state: 'cancelled',
      evidencePath: `jobs/${fixtureValue.input.jobId}/evidence/cancellation.json`,
      evidenceSha256: SHA64,
    });
    expect(removeCalls).toBe(1);
    expect(evidenceRecords).toHaveLength(1);
    expect(fixtureValue.store.listEvents(fixtureValue.input.jobId).events.filter(
      (event) => event.eventType === 'cleanup' && event.payload.kind === 'cancellation-evidence',
    )).toEqual([evidenceEvent]);
    expect(fixtureValue.store.getJob(fixtureValue.input.jobId)).toMatchObject({ state: 'cancelled', containerId: null });
    fixtureValue.db.close();
  });

  it('finishes terminal from a committed cleanup event without duplicating cleanup', async () => {
    const fixtureValue = await fixture();
    let rejectTerminal = true;
    const ownership = {
      runnerWrite: (command: Parameters<typeof fixtureValue.ownership.runnerWrite>[0]) => {
        if (command.kind === 'cancellation-terminal' && rejectTerminal) {
          return { ok: false as const, conflict: { kind: 'cas-lost' as const, message: 'injected crash after cleanup commit' } };
        }
        return fixtureValue.ownership.runnerWrite(command);
      },
    };
    const base = {
      jobId: fixtureValue.input.jobId,
      runnerUnit: `osi-image-builder-runner@${fixtureValue.input.jobId}.service`,
      owner: 'runner-integration',
      leaseExpiresAt: () => '2026-07-27T09:10:00.000Z',
      store: fixtureValue.store,
      ownership,
      docker: {
        inspect: async () => null,
        stop: async () => { throw new Error('terminal retry must not stop'); },
        waitForStopped: async () => { throw new Error('terminal retry must not wait'); },
        remove: async () => { throw new Error('terminal retry must not remove'); },
        listByLabels: async () => [],
      },
      clock: () => '2026-07-27T09:00:05.000Z',
      signals: { on: () => undefined, off: () => undefined },
    } as const;
    const first = createRunnerCancellation({
      ...base,
      evidence: async () => ({
        path: `jobs/${fixtureValue.input.jobId}/evidence/cancellation.json`,
        sha256: SHA64,
      }),
      cleanup: {
        staging: async () => ({ kind: 'absent', path: null }),
        logs: async () => ({ runner: 'absent', docker: 'absent', verifiedAt: '2026-07-27T09:00:04.000Z' }),
      },
    });

    await expect(first.cancelIfRequested()).rejects.toMatchObject({
      blockerCode: 'RUNNER_DISAPPEARED',
    });
    const cleanupEventsBefore = fixtureValue.store.listEvents(fixtureValue.input.jobId).events.filter(
      (event) => event.eventType === 'cleanup' && event.payload.kind === 'cancellation-cleanup',
    );
    expect(cleanupEventsBefore).toHaveLength(1);
    expect(fixtureValue.store.getJob(fixtureValue.input.jobId)).toMatchObject({
      state: 'cancel_requested',
      containerId: null,
    });

    rejectTerminal = false;
    const second = createRunnerCancellation({
      ...base,
      evidence: async () => { throw new Error('terminal retry must reuse committed evidence'); },
      cleanup: {
        staging: async () => { throw new Error('terminal retry must reuse committed staging proof'); },
        logs: async () => ({ runner: 'absent', docker: 'absent', verifiedAt: '2026-07-27T09:00:05.000Z' }),
      },
    });
    await expect(second.cancelIfRequested()).resolves.toMatchObject({
      state: 'cancelled',
      evidencePath: `jobs/${fixtureValue.input.jobId}/evidence/cancellation.json`,
      evidenceSha256: SHA64,
    });
    expect(fixtureValue.store.listEvents(fixtureValue.input.jobId).events.filter(
      (event) => event.eventType === 'cleanup' && event.payload.kind === 'cancellation-cleanup',
    )).toEqual(cleanupEventsBefore);
    expect(fixtureValue.store.getJob(fixtureValue.input.jobId).state).toBe('cancelled');
    fixtureValue.db.close();
  });

  it('recovers an immutable cancellation file when the evidence event did not commit', async () => {
    const fixtureValue = await fixture();
    const relativePath = `jobs/${fixtureValue.input.jobId}/evidence/cancellation.json`;
    const absolutePath = join(fixtureValue.directory, relativePath);
    let rejectEvidence = true;
    let publishedRecord: JsonObject | null = null;
    let publishedSha256: string | null = null;
    const ownership = {
      runnerWrite: (command: Parameters<typeof fixtureValue.ownership.runnerWrite>[0]) => {
        if (command.kind === 'cancellation-evidence' && rejectEvidence) {
          return { ok: false as const, conflict: { kind: 'cas-lost' as const, message: 'injected crash after immutable evidence write' } };
        }
        return fixtureValue.ownership.runnerWrite(command);
      },
    };
    const base = {
      jobId: fixtureValue.input.jobId,
      runnerUnit: `osi-image-builder-runner@${fixtureValue.input.jobId}.service`,
      owner: 'runner-integration',
      leaseExpiresAt: () => '2026-07-27T09:10:00.000Z',
      store: fixtureValue.store,
      ownership,
      docker: {
        inspect: async () => null,
        stop: async () => { throw new Error('immutable retry must not stop'); },
        waitForStopped: async () => { throw new Error('immutable retry must not wait'); },
        remove: async () => { throw new Error('immutable retry must not remove'); },
        listByLabels: async () => [],
      },
      signals: { on: () => undefined, off: () => undefined },
    } as const;
    const first = createRunnerCancellation({
      ...base,
      evidence: async (record) => {
        publishedRecord = record;
        const bytes = Buffer.from(`${encodeJson(record, 'cancellation evidence fixture', true)}\n`);
        publishedSha256 = createHash('sha256').update(bytes).digest('hex');
        await mkdir(join(fixtureValue.directory, 'jobs', fixtureValue.input.jobId, 'evidence'), { recursive: true });
        await writeFile(absolutePath, bytes, { flag: 'wx' });
        return { path: relativePath, sha256: publishedSha256 };
      },
      cleanup: {
        staging: async () => ({ kind: 'absent', path: null }),
        logs: async () => ({ runner: 'absent', docker: 'absent', verifiedAt: '2026-07-27T09:00:04.000Z' }),
      },
      clock: () => '2026-07-27T09:00:05.000Z',
    });

    await expect(first.cancelIfRequested()).rejects.toMatchObject({
      blockerCode: 'RUNNER_DISAPPEARED',
    });
    expect(publishedRecord).not.toBeNull();
    expect(fixtureValue.store.listEvents(fixtureValue.input.jobId).events.some(
      (event) => event.eventType === 'cleanup' && event.payload.kind === 'cancellation-evidence',
    )).toBe(false);

    rejectEvidence = false;
    const second = createRunnerCancellation({
      ...base,
      recoverEvidence: async () => {
        const bytes = await readFile(absolutePath);
        return {
          value: JSON.parse(bytes.toString('utf8')) as JsonObject,
          path: relativePath,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      },
      evidence: async () => { throw new Error('immutable retry must not rewrite cancellation.json'); },
      cleanup: {
        staging: async () => { throw new Error('immutable retry must reuse the file staging proof'); },
        logs: async () => { throw new Error('immutable retry must reuse the file log proof'); },
      },
      clock: () => '2026-07-27T09:00:06.000Z',
    });

    await expect(second.cancelIfRequested()).resolves.toMatchObject({
      state: 'cancelled',
      evidencePath: relativePath,
      evidenceSha256: publishedSha256,
    });
    expect(await readFile(absolutePath, 'utf8')).toBe(`${encodeJson(publishedRecord, 'cancellation evidence fixture', true)}\n`);
    expect(fixtureValue.store.listEvents(fixtureValue.input.jobId).events.filter(
      (event) => event.eventType === 'cleanup' && event.payload.kind === 'cancellation-evidence',
    )).toHaveLength(1);
    fixtureValue.db.close();
  });
});
