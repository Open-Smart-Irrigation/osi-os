import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import {
  BuilderStore,
  StoreConflictError,
  StoreTransactionError,
  StoreValidationError,
  EVENT_PAGE_MAX_LIMIT,
  JSON_LIMITS,
  type CreateJobInput,
} from '../../api/src/store.js';

const SHA40 = 'a'.repeat(40);
const SHA40_B = 'b'.repeat(40);
const SHA64 = 'c'.repeat(64);
const SHA64_B = 'd'.repeat(64);
const NOW = '2026-07-23T10:00:00.000Z';
const tempPaths: string[] = [];
const openStores: BuilderStore[] = [];

async function createStore(options: { failBeforeCommit?: () => void } = {}): Promise<{ store: BuilderStore; path: string; db: ReturnType<typeof openBuilderDatabase> }> {
  const directory = await mkdtemp(join(tmpdir(), 'osi-image-builder-store-'));
  tempPaths.push(directory);
  const path = join(directory, 'jobs.sqlite');
  const db = openBuilderDatabase(path);
  const store = new BuilderStore(db, { now: () => NOW, ...options });
  openStores.push(store);
  return { store, path, db };
}

function closeStore(store: BuilderStore): void {
  const index = openStores.indexOf(store);
  if (index >= 0) openStores.splice(index, 1);
  try { store.close(); } catch { /* cleanup is best effort after injected close failures */ }
}

function jobInput(jobId: string, requestId = `request-${jobId}`): CreateJobInput {
  return {
    jobId,
    requestId,
    request: { branch: 'main', target: 'rpi-5', rootId: 'release' },
    sourceRemote: 'git@example.com:osi-os.git',
    sourceRef: 'refs/remotes/origin/main',
    sourceBranch: 'main',
    branch: 'main',
    expectedSha: SHA40,
    pinnedSha: SHA40,
    targetId: 'rpi-5',
    rootId: 'release',
    targetManifestSha256: SHA64,
    sourceCommitTime: NOW,
    sourceAuthor: 'Phil',
    sourceSubject: 'build image',
    acceptedAt: NOW,
  };
}

function eventRows(store: BuilderStore, jobId: string): Array<Record<string, unknown>> {
  return store.listEvents(jobId).events.map((event) => ({
    seq: event.seq,
    type: event.eventType,
    state: event.state,
    stage: event.stage,
    payload: event.payload,
  }));
}

function countRows(path: string, table: string): number {
  const db = openBuilderDatabase(path);
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  db.close();
  return Number(row.count);
}

afterEach(async () => {
  for (const store of openStores.splice(0)) closeStore(store);
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('BuilderStore', () => {
  it('creates a job and enqueues it with a durable event and queue position', async () => {
    const { store } = await createStore();

    store.createJob(jobInput('job-1'));
    store.createJob(jobInput('job-2'));

    expect(store.getQueuePosition('job-1')).toBe(0);
    expect(store.getQueuePosition('job-2')).toBe(1);
    expect(eventRows(store, 'job-1')).toEqual([{ seq: 0, type: 'enqueue', state: 'queued', stage: null, payload: { requestId: 'request-job-1' } }]);
    expect(store.getNextEventSequence('job-1')).toBe(1);
  });

  it('persists cancellation, source identity, and claims FIFO with a dispatch event', async () => {
    const { store } = await createStore();
    store.createJob(jobInput('job-1'));
    store.createJob({ ...jobInput('job-2'), expectedSha: SHA40_B, pinnedSha: SHA40_B });

    store.requestCancellation('job-2', 'operator requested', NOW);
    expect(store.getSourceIdentity('job-1')).toMatchObject({ sourceAuthor: 'Phil', sourceSubject: 'build image' });
    const claim = store.claimNextQueued('osi-image-builder-runner@job-1.service', NOW);

    expect(claim).toMatchObject({ jobId: 'job-1', fifoSeq: 0, runnerUnit: 'osi-image-builder-runner@job-1.service' });
    expect(store.getQueuePosition('job-1')).toBeNull();
    expect(store.getQueuePosition('job-2')).toBe(0);
    expect(store.getJob('job-1')).toMatchObject({ state: 'starting', queueState: 'dispatched', sourceAuthor: 'Phil' });
    expect(eventRows(store, 'job-2')).toEqual([
      { seq: 0, type: 'enqueue', state: 'queued', stage: null, payload: { requestId: 'request-job-2' } },
      { seq: 1, type: 'cancellation_requested', state: 'queued', stage: null, payload: { reason: 'operator requested' } },
    ]);
    expect(eventRows(store, 'job-1').at(-1)).toEqual({ seq: 1, type: 'dispatch', state: 'starting', stage: null, payload: { runnerUnit: 'osi-image-builder-runner@job-1.service' } });
  });

  it('writes stage, operation, evidence, artifact, publish, terminal, and freshness records with events', async () => {
    const { store } = await createStore();
    store.createJob(jobInput('job-1'));
    store.claimNextQueued('osi-image-builder-runner@job-1.service', NOW);

    store.recordStage('job-1', {
      stage: 'preflight', outcome: 'passed', startedAt: NOW, finishedAt: NOW,
      evidencePath: 'evidence/00-preflight.json', evidenceSha256: SHA64,
    });
    store.recordOperation('job-1', {
      operationId: 'activate-target', attempt: 1, argvHash: SHA64, argv: ['make', 'defconfig'],
      startedAt: NOW, finishedAt: NOW, outcome: 'failed', timedOut: false, lifecyclePhase: 'not_created',
      exitCode: 1, signal: null, evidencePath: 'evidence/00-op.json', evidenceSha256: SHA64,
      errorCode: 'BUILD_FAILED', error: { detail: 'defconfig failed' },
    });
    store.recordArtifact('job-1', {
      stagingPath: 'staging/image.img.gz', artifactSha256: SHA64, artifactSize: 100, artifactMtime: NOW,
      checksumPath: 'staging/SHA256SUMS', checksumSha256: SHA64,
      manifestPath: 'staging/manifest.json', manifestSha256: SHA64,
      verificationPath: 'staging/verification.json', verificationSha256: SHA64,
    });
    store.recordPublish('job-1', {
      state: 'publishing', finalDirectory: 'release/main/a/rpi-5', finalPath: 'release/main/a/rpi-5/image.img.gz',
      startedAt: NOW,
    });
    store.recordPublish('job-1', {
      state: 'published', finalDirectory: 'release/main/a/rpi-5', finalPath: 'release/main/a/rpi-5/image.img.gz',
      publishedAt: NOW,
    });
    store.requestFreshness('job-1', NOW);
    store.recordFreshness('job-1', { status: 'advanced', pinnedSha: SHA40, observedSha: SHA40_B, checkedAt: NOW });
    store.recordTerminal('job-1', {
      state: 'failed', terminalAt: NOW, errorCode: 'BUILD_FAILED', error: { reason: 'test' },
    });
    store.recordEvidenceReference('job-1', { stage: 'preflight', path: 'evidence/00-preflight.json', sha256: SHA64 });

    expect(store.getStage('job-1', 'preflight')).toMatchObject({ outcome: 'passed', evidencePath: 'evidence/00-preflight.json' });
    expect(store.getOperation('job-1', 'activate-target', 1)).toMatchObject({ outcome: 'failed', errorCode: 'BUILD_FAILED' });
    expect(store.getJob('job-1')).toMatchObject({
      state: 'failed', publishState: 'published', freshnessStatus: 'advanced', newerSourceAvailable: true,
      artifactSize: 100, terminalErrorCode: 'BUILD_FAILED',
    });
    expect(eventRows(store, 'job-1').map((event) => [event.seq, event.type])).toEqual([
      [0, 'enqueue'], [1, 'dispatch'], [2, 'stage'], [3, 'operation'], [4, 'artifact'],
      [5, 'publish'], [6, 'publish'], [7, 'freshness'], [8, 'freshness'], [9, 'terminal'],
    ]);
    expect(store.getNextEventSequence('job-1')).toBe(10);
  });

  it('round-trips every stored operation field, including a null pre-container result', async () => {
    const { store } = await createStore();
    store.createJob(jobInput('job-1'));
    store.claimNextQueued('osi-image-builder-runner@job-1.service', NOW);

    store.recordOperation('job-1', {
      operationId: 'activate-target', attempt: 1, argvHash: SHA64, argv: ['make', 'defconfig'],
      startedAt: NOW, finishedAt: NOW, outcome: 'failed', timedOut: false, lifecyclePhase: 'not_created',
      exitCode: 127, signal: null, evidencePath: 'evidence/process-create.json', evidenceSha256: SHA64,
      errorCode: 'DOCKER_EXECUTION_DEFINITION_MISMATCH', error: { phase: 'create' },
    });
    expect(store.getOperation('job-1', 'activate-target', 1)).toEqual(expect.objectContaining({
      jobId: 'job-1', operationId: 'activate-target', attempt: 1, argvHash: SHA64, argv: ['make', 'defconfig'],
      startedAt: NOW, finishedAt: NOW, containerId: null, containerName: null, containerImageDigest: null,
      containerLabelJobId: null, containerLabelManifestSha: null, containerMount: null, containerEnvironment: null,
      containerSecurity: null, inspection: null, timedOut: false, lifecyclePhase: 'not_created', exitCode: 127,
      signal: null, outcome: 'failed', evidencePath: 'evidence/process-create.json', evidenceSha256: SHA64,
      errorCode: 'DOCKER_EXECUTION_DEFINITION_MISMATCH', error: { phase: 'create' },
    }));

    const labels = { 'org.osi.image-builder.job-id': 'job-1', 'org.osi.image-builder.manifest-sha': SHA64 };
    store.recordOperation('job-1', {
      operationId: 'build-image', attempt: 1, argvHash: SHA64_B, argv: ['make', 'image'],
      startedAt: NOW, finishedAt: NOW, containerId: 'container-1', containerName: 'osi-job-1', containerImageDigest: SHA64_B,
      containerLabelJobId: 'job-1', containerLabelManifestSha: SHA64, containerMount: { source: '/tmp', destination: '/work' },
      containerEnvironment: { CI: '1' }, containerSecurity: { user: '1000:1000' }, inspection: { running: false },
      timedOut: false, lifecyclePhase: 'removed', exitCode: 0, signal: null, outcome: 'passed',
      evidencePath: 'evidence/build.json', evidenceSha256: SHA64_B,
    });
    const committed = store.getOperation('job-1', 'build-image', 1);
    expect(committed).toEqual(expect.objectContaining({
      containerId: 'container-1', containerName: 'osi-job-1', containerImageDigest: SHA64_B,
      containerLabelJobId: 'job-1', containerLabelManifestSha: SHA64, containerMount: { source: '/tmp', destination: '/work' },
      containerEnvironment: { CI: '1' }, containerSecurity: { user: '1000:1000' }, inspection: { running: false },
      timedOut: false, lifecyclePhase: 'removed', exitCode: 0, signal: null, outcome: 'passed',
      evidencePath: 'evidence/build.json', evidenceSha256: SHA64_B, errorCode: null, error: null,
    }));
    const beforeRetry = eventRows(store, 'job-1');
    store.recordOperation('job-1', {
      operationId: 'build-image', attempt: 1, argvHash: SHA64_B, argv: ['make', 'image'],
      startedAt: NOW, finishedAt: NOW, containerId: 'container-1', containerName: 'osi-job-1', containerImageDigest: SHA64_B,
      containerLabelJobId: 'job-1', containerLabelManifestSha: SHA64, containerMount: { source: '/tmp', destination: '/work' },
      containerEnvironment: { CI: '1' }, containerSecurity: { user: '1000:1000' }, inspection: { running: false },
      timedOut: false, lifecyclePhase: 'removed', exitCode: 0, signal: null, outcome: 'passed',
      evidencePath: 'evidence/build.json', evidenceSha256: SHA64_B,
    });
    expect(eventRows(store, 'job-1')).toEqual(beforeRetry);
    expect(() => store.recordOperation('job-1', {
      operationId: 'build-image', attempt: 1, argvHash: SHA64_B, argv: ['make', 'image'],
      startedAt: NOW, finishedAt: NOW, containerId: 'container-1', containerName: 'osi-job-1', containerImageDigest: SHA64_B,
      containerLabelJobId: 'job-1', containerLabelManifestSha: SHA64, containerMount: { source: '/tmp', destination: '/work' },
      containerEnvironment: { CI: '1' }, containerSecurity: { user: '1000:1000' }, inspection: { running: false },
      timedOut: false, lifecyclePhase: 'removed', exitCode: 0, signal: null, outcome: 'passed',
      evidencePath: 'evidence/changed.json', evidenceSha256: SHA64,
    })).toThrow(StoreConflictError);
    expect(store.getOperation('job-1', 'build-image', 1)).toEqual(committed);
    expect(eventRows(store, 'job-1')).toEqual(beforeRetry);
  });

  it('requires exact distinct runtime labels and persists manifest and image digests separately', async () => {
    const { store } = await createStore();
    store.createJob(jobInput('job-1'));
    store.claimNextQueued('osi-image-builder-runner@job-1.service', NOW);
    const base = {
      containerId: 'container-1', containerName: 'osi-job-1', targetManifestSha256: SHA64, imageDigest: SHA64_B,
      labels: { 'org.osi.image-builder.job-id': 'job-1', 'org.osi.image-builder.manifest-sha': SHA64 },
      mount: { source: '/tmp/source', destination: '/work' }, environment: { CI: '1' }, security: { user: '1000:1000' },
      inspection: { running: true }, lifecycle: 'created' as const, occurredAt: NOW,
    };

    expect(() => store.recordRuntimeDiagnostics('job-1', { ...base, labels: { 'org.osi.image-builder.job-id': 'job-1', 'org.osi.image-builder.manifest-sha': SHA64_B } })).toThrow(StoreValidationError);
    expect(() => store.recordRuntimeDiagnostics('job-1', { ...base, labels: { 'org.osi.image-builder.job-id': 'job-1' } })).toThrow(StoreValidationError);
    expect(() => store.recordRuntimeDiagnostics('job-1', { ...base, labels: { ...base.labels, extra: 'rejected' } })).toThrow(StoreValidationError);

    store.recordRuntimeDiagnostics('job-1', { ...base, labels: { 'org.osi.image-builder.job-id': 'job-1', 'org.osi.image-builder.manifest-sha': SHA64 } });
    expect(store.getJob('job-1')).toMatchObject({ containerImageDigest: SHA64_B, containerLabelManifestSha: SHA64, containerLabelJobId: 'job-1' });
  });

  it('preserves monotonic container lifecycle facts, including never-started removal', async () => {
    const { store } = await createStore();
    store.createJob(jobInput('job-1'));
    store.claimNextQueued('osi-image-builder-runner@job-1.service', NOW);
    const base = {
      containerId: 'container-1', containerName: 'osi-job-1', targetManifestSha256: SHA64, imageDigest: SHA64_B,
      labels: { 'org.osi.image-builder.job-id': 'job-1', 'org.osi.image-builder.manifest-sha': SHA64 },
      mount: { source: '/tmp/source', destination: '/work' }, environment: { CI: '1' }, security: { user: '1000:1000' }, inspection: { running: true },
    };
    store.recordRuntimeDiagnostics('job-1', { ...base, lifecycle: 'created', occurredAt: '2026-07-23T10:01:00.000Z' });
    store.recordRuntimeDiagnostics('job-1', { ...base, lifecycle: 'started', occurredAt: '2026-07-23T10:02:00.000Z' });
    store.recordRuntimeDiagnostics('job-1', { ...base, lifecycle: 'stopped', occurredAt: '2026-07-23T10:03:00.000Z' });
    store.recordRuntimeDiagnostics('job-1', { ...base, lifecycle: 'removed', occurredAt: '2026-07-23T10:04:00.000Z', cleanupOutcome: 'passed' });
    expect(store.getJob('job-1')).toMatchObject({
      containerCreatedAt: '2026-07-23T10:01:00.000Z', containerStartedAt: '2026-07-23T10:02:00.000Z',
      containerStoppedAt: '2026-07-23T10:03:00.000Z', containerRemovedAt: '2026-07-23T10:04:00.000Z', containerCleanupOutcome: 'passed',
    });

    store.createJob(jobInput('job-2', 'request-2'));
    store.claimNextQueued('osi-image-builder-runner@job-2.service', NOW);
    const neverStarted = { ...base, containerId: 'container-2', containerName: 'osi-job-2', labels: { 'org.osi.image-builder.job-id': 'job-2', 'org.osi.image-builder.manifest-sha': SHA64 } };
    store.recordRuntimeDiagnostics('job-2', { ...neverStarted, lifecycle: 'created', occurredAt: '2026-07-23T10:05:00.000Z' });
    store.recordRuntimeDiagnostics('job-2', { ...neverStarted, lifecycle: 'removed', occurredAt: '2026-07-23T10:06:00.000Z', cleanupOutcome: 'passed' });
    expect(store.getJob('job-2')).toMatchObject({ containerCreatedAt: '2026-07-23T10:05:00.000Z', containerStartedAt: null, containerStoppedAt: null, containerRemovedAt: '2026-07-23T10:06:00.000Z' });
  });

  it('keeps recovery paths and evidence while representing publish blockers', async () => {
    const { store } = await createStore();
    store.createJob(jobInput('job-1'));
    store.claimNextQueued('osi-image-builder-runner@job-1.service', NOW);
    store.recordArtifact('job-1', {
      stagingPath: 'staging/image.img.gz', artifactSha256: SHA64, artifactSize: 100, artifactMtime: NOW,
      checksumPath: 'staging/SHA256SUMS', checksumSha256: SHA64, manifestPath: 'staging/manifest.json', manifestSha256: SHA64,
      verificationPath: 'staging/verification.json', verificationSha256: SHA64,
    });
    store.recordPublish('job-1', { state: 'blocked', blockerCode: 'PUBLISH_FAILED', blocker: { reason: 'rename failed' } });
    expect(store.getJob('job-1')).toMatchObject({ publishState: 'blocked', artifactStagingPath: 'staging/image.img.gz', artifactQuarantinePath: null, artifactSha256: SHA64 });
    const failedBefore = eventRows(store, 'job-1');
    expect(() => store.recordPublish('job-1', { state: 'blocked', stagingPath: null, blockerCode: 'PUBLISH_FAILED', blocker: { reason: 'retry' } })).toThrow(StoreConflictError);
    expect(() => store.recordPublish('job-1', { state: 'blocked', stagingPath: 'staging/other.img.gz', blockerCode: 'PUBLISH_FAILED', blocker: { reason: 'retry' } })).toThrow(StoreConflictError);
    expect(store.getJob('job-1')).toMatchObject({ publishState: 'blocked', artifactStagingPath: 'staging/image.img.gz' });
    expect(eventRows(store, 'job-1')).toEqual(failedBefore);
    store.recordPublish('job-1', { state: 'publishing', finalDirectory: 'release/main/a/rpi-5', finalPath: 'release/main/a/rpi-5/image.img.gz' });
    store.recordPublish('job-1', { state: 'published', finalDirectory: 'release/main/a/rpi-5', finalPath: 'release/main/a/rpi-5/image.img.gz' });
    expect(store.getJob('job-1')).toMatchObject({ publishState: 'published', artifactStagingPath: null });

    store.createJob(jobInput('job-2', 'request-2'));
    store.claimNextQueued('osi-image-builder-runner@job-2.service', NOW);
    store.recordArtifact('job-2', {
      stagingPath: 'staging/job-2.img.gz', artifactSha256: SHA64_B, artifactSize: 100, artifactMtime: NOW,
      checksumPath: 'staging/job-2.SHA256SUMS', checksumSha256: SHA64_B, manifestPath: 'staging/job-2-manifest.json', manifestSha256: SHA64_B,
      verificationPath: 'staging/job-2-verification.json', verificationSha256: SHA64_B,
    });
    store.recordPublish('job-2', { state: 'blocked', blockerCode: 'QUARANTINE_PENDING', blocker: { reason: 'move not proven' } });
    const quarantineBefore = eventRows(store, 'job-2');
    expect(() => store.recordPublish('job-2', { state: 'blocked', stagingPath: null, blockerCode: 'QUARANTINE_PENDING', blocker: { reason: 'retry' } })).toThrow(StoreConflictError);
    expect(() => store.recordPublish('job-2', { state: 'blocked', stagingPath: 'staging/other-job-2.img.gz', blockerCode: 'QUARANTINE_PENDING', blocker: { reason: 'retry' } })).toThrow(StoreConflictError);
    expect(store.getJob('job-2')).toMatchObject({ publishState: 'blocked', artifactStagingPath: 'staging/job-2.img.gz' });
    expect(eventRows(store, 'job-2')).toEqual(quarantineBefore);
    store.recordPublish('job-2', { state: 'quarantined', quarantinePath: 'quarantine/job-2' });
    expect(store.getJob('job-2')).toMatchObject({ publishState: 'quarantined', artifactStagingPath: null, artifactQuarantinePath: 'quarantine/job-2' });
  });

  it('makes evidence references immutable and idempotent', async () => {
    const { store } = await createStore();
    store.createJob(jobInput('job-1'));
    store.claimNextQueued('osi-image-builder-runner@job-1.service', NOW);
    store.recordStage('job-1', { stage: 'preflight', outcome: 'passed', startedAt: NOW, finishedAt: NOW, evidencePath: 'evidence/preflight.json', evidenceSha256: SHA64 });
    const before = eventRows(store, 'job-1');
    store.recordEvidenceReference('job-1', { stage: 'preflight', path: 'evidence/preflight.json', sha256: SHA64 });
    expect(eventRows(store, 'job-1')).toEqual(before);
    expect(() => store.recordEvidenceReference('job-1', { stage: 'preflight', path: 'evidence/other.json', sha256: SHA64_B })).toThrow(StoreConflictError);
    expect(eventRows(store, 'job-1')).toEqual(before);
    expect(store.getStage('job-1', 'preflight')).toMatchObject({ evidencePath: 'evidence/preflight.json', evidenceSha256: SHA64 });
  });

  it('rolls back each state mutation and its event independently', async () => {
    const cases = [
      ['enqueue', (store: BuilderStore) => store.createJob(jobInput('job-1')), (store: BuilderStore) => expect(() => store.getJob('job-1')).toThrow(), 'job-1'],
      ['claim', (store: BuilderStore) => { store.createJob(jobInput('job-1')); }, (store: BuilderStore) => { expect(store.getJob('job-1')).toMatchObject({ state: 'queued' }); expect(store.getQueuePosition('job-1')).toBe(0); }, 'job-1'],
      ['stage', (store: BuilderStore) => { store.createJob(jobInput('job-1')); store.claimNextQueued('osi-image-builder-runner@job-1.service', NOW); }, (store: BuilderStore) => { expect(store.getStage('job-1', 'preflight')).toBeNull(); expect(store.getJob('job-1')).toMatchObject({ currentStage: null }); }, 'job-1'],
      ['operation', (store: BuilderStore) => { store.createJob(jobInput('job-1')); store.claimNextQueued('osi-image-builder-runner@job-1.service', NOW); }, (store: BuilderStore) => { expect(store.getOperation('job-1', 'activate-target', 1)).toBeNull(); }, 'job-1'],
      ['terminal', (store: BuilderStore) => { store.createJob(jobInput('job-1')); store.claimNextQueued('osi-image-builder-runner@job-1.service', NOW); }, (store: BuilderStore) => { expect(store.getJob('job-1')).toMatchObject({ state: 'starting', terminalAt: null }); }, 'job-1'],
      ['freshness', (store: BuilderStore) => { store.createJob(jobInput('job-1')); store.requestFreshness('job-1', NOW); }, (store: BuilderStore) => { expect(store.getJob('job-1')).toMatchObject({ freshnessStatus: null, freshnessCheckedAt: null }); }, 'job-1'],
      ['cancellation', (store: BuilderStore) => { store.createJob(jobInput('job-1')); }, (store: BuilderStore) => { expect(store.getJob('job-1')).toMatchObject({ cancelRequestedAt: null, cancelReason: null }); }, 'job-1'],
    ] as const;
    for (const [name, setup, assertRolledBack, jobId] of cases) {
      let fail = false;
      const { store, path } = await createStore({ failBeforeCommit: () => { if (fail) throw new Error(`injected ${name}`); } });
      if (name !== 'enqueue') setup(store);
      const eventCount = name === 'enqueue' ? 0 : eventRows(store, jobId).length;
      fail = true;
      if (name === 'enqueue') expect(() => setup(store)).toThrow(StoreTransactionError);
      else if (name === 'claim') expect(() => store.claimNextQueued('osi-image-builder-runner@job-1.service', NOW)).toThrow(StoreTransactionError);
      else if (name === 'stage') expect(() => store.recordStage('job-1', { stage: 'preflight', outcome: 'running', startedAt: NOW })).toThrow(StoreTransactionError);
      else if (name === 'operation') expect(() => store.recordOperation('job-1', { operationId: 'activate-target', attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW, finishedAt: NOW, outcome: 'failed', timedOut: false, lifecyclePhase: 'not_created', exitCode: 1, signal: null, evidencePath: 'evidence/op.json', evidenceSha256: SHA64, errorCode: 'BUILD_FAILED', error: {} })).toThrow(StoreTransactionError);
      else if (name === 'terminal') expect(() => store.recordTerminal('job-1', { state: 'failed', terminalAt: NOW, errorCode: 'BUILD_FAILED', error: {} })).toThrow(StoreTransactionError);
      else if (name === 'freshness') expect(() => store.recordFreshness('job-1', { status: 'fresh', pinnedSha: SHA40, observedSha: SHA40, checkedAt: NOW })).toThrow(StoreTransactionError);
      else expect(() => store.requestCancellation('job-1', 'rollback', NOW)).toThrow(StoreTransactionError);
      if (name === 'enqueue') {
        assertRolledBack(store);
      } else {
        assertRolledBack(store);
        expect(eventRows(store, jobId)).toHaveLength(eventCount);
      }
      expect(countRows(path, 'job_events')).toBe(eventCount);
      closeStore(store);
    }
  });

  it('rolls back the state and event together when the transaction fails', async () => {
    let fail = true;
    const { store } = await createStore({ failBeforeCommit: () => { if (fail) throw new Error('injected failure'); } });
    fail = false;
    store.createJob(jobInput('job-1'));
    fail = true;

    expect(() => store.requestCancellation('job-1', 'rollback', NOW)).toThrow(StoreTransactionError);
    expect(store.getJob('job-1')).toMatchObject({ cancelRequestedAt: null, cancelReason: null });
    expect(eventRows(store, 'job-1')).toHaveLength(1);

    fail = false;
    store.requestCancellation('job-1', 'committed', NOW);
    expect(store.getJob('job-1')).toMatchObject({ cancelRequestedAt: NOW, cancelReason: 'committed' });
    expect(eventRows(store, 'job-1')).toHaveLength(2);
  });

  it('reopens from SQLite and ignores a deliberately stale runtime diagnostic snapshot', async () => {
    const { store, path } = await createStore();
    store.createJob(jobInput('job-1'));
    store.claimNextQueued('osi-image-builder-runner@job-1.service', NOW);
    store.recordRuntimeDiagnostics('job-1', {
      containerId: 'container-1', containerName: 'osi-job-1', imageDigest: SHA64_B,
      labels: { 'org.osi.image-builder.job-id': 'job-1', 'org.osi.image-builder.manifest-sha': SHA64 },
      mount: { source: '/tmp/source', destination: '/work' }, environment: { CI: '1' }, security: { user: '1000:1000' },
      targetManifestSha256: SHA64, inspection: { running: true }, lifecycle: 'started', createdAt: NOW, occurredAt: NOW,
    });
    closeStore(store);
    await writeFile(join(dirname(path), 'runtime.json'), JSON.stringify({ state: 'succeeded', containerId: 'stale-container' }));

    const reopenedDb = openBuilderDatabase(path);
    const reopened = new BuilderStore(reopenedDb, { now: () => NOW });
    expect(reopened.getJob('job-1')).toMatchObject({ state: 'starting', containerId: 'container-1', runnerUnit: 'osi-image-builder-runner@job-1.service' });
    expect(reopened.listEvents('job-1').events.map((event) => event.eventType)).toEqual(['enqueue', 'dispatch', 'container']);
    closeStore(reopened);
  });

  it('composes nested store work with a caller transaction and rolls back only its savepoint', async () => {
    const { store, db } = await createStore();
    db.exec('BEGIN IMMEDIATE');
    store.createJob(jobInput('job-1'));
    expect(db.isTransaction).toBe(true);
    db.exec('COMMIT');
    expect(store.getJob('job-1')).toMatchObject({ jobId: 'job-1' });

    let fail = true;
    const composed = await createStore({ failBeforeCommit: () => { if (fail) throw new Error('nested failure'); } });
    composed.db.exec('BEGIN IMMEDIATE');
    expect(() => composed.store.createJob(jobInput('job-2'))).toThrow(StoreTransactionError);
    expect(composed.db.isTransaction).toBe(true);
    composed.db.exec('COMMIT');
    expect(() => composed.store.getJob('job-2')).toThrow();
    fail = false;
  });

  it('does not rollback a caller transaction when BEGIN IMMEDIATE fails', async () => {
    const first = await createStore();
    const secondDb = openBuilderDatabase(first.path, { busyTimeoutMs: 1 });
    const second = new BuilderStore(secondDb, { now: () => NOW });
    openStores.push(second);
    first.db.exec('BEGIN IMMEDIATE');
    first.db.prepare('INSERT INTO jobs (job_id, request_id, request_json, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('caller-job', 'caller-request', '{}', 'remote', 'refs/remotes/origin/main', 'main', 'main', SHA40, SHA40, 'rpi-5', 'release', SHA64, NOW, 'author', 'subject', NOW, 'queued', 'queued', NOW, NOW);
    expect(() => second.createJob(jobInput('job-2'))).toThrow(StoreTransactionError);
    expect(first.db.isTransaction).toBe(true);
    expect(Number((first.db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE job_id = ?').get('caller-job') as { count: number }).count)).toBe(1);
    first.db.exec('ROLLBACK');
  });

  it('keeps rollback failures inspectable without replacing the primary transaction error', async () => {
    let store: BuilderStore;
    let fail = true;
    ({ store } = await createStore({ failBeforeCommit: () => { if (fail) { store.close(); throw new Error('primary failure'); } } }));
    let thrown: unknown;
    try { store.createJob(jobInput('job-1')); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(StoreTransactionError);
    expect((thrown as StoreTransactionError).cause).toBeInstanceOf(Error);
    expect((thrown as StoreTransactionError).rollbackCause).toBeInstanceOf(Error);
    fail = false;
  });

  it('validates canonical timestamps and chronology before any state mutation', async () => {
    const { store, path } = await createStore();
    expect(() => store.createJob({ ...jobInput('bad-time'), acceptedAt: '2026-07-23T10:00:00Z' })).toThrow(StoreValidationError);
    expect(countRows(path, 'jobs')).toBe(0);
    store.createJob(jobInput('job-1'));
    store.claimNextQueued('osi-image-builder-runner@job-1.service', NOW);
    expect(() => store.recordStage('job-1', { stage: 'preflight', outcome: 'passed', startedAt: '2026-07-23T10:01:00.000Z', finishedAt: NOW, evidencePath: 'evidence/a', evidenceSha256: SHA64 })).toThrow(StoreValidationError);
    expect(() => store.recordOperation('job-1', { operationId: 'activate-target', attempt: 1, argvHash: SHA64, argv: [], startedAt: '2026-07-23T10:01:00.000Z', finishedAt: NOW, outcome: 'failed', timedOut: false, lifecyclePhase: 'not_created', exitCode: 1, signal: null, evidencePath: 'evidence/op', evidenceSha256: SHA64, errorCode: 'BUILD_FAILED', error: {} })).toThrow(StoreValidationError);
    expect(() => store.requestCancellation('job-1', 'bad', '2026-07-23T10:00:00+00:00')).toThrow(StoreValidationError);
    store.recordArtifact('job-1', { stagingPath: 'staging/image', artifactSha256: SHA64, artifactSize: 1, artifactMtime: NOW, checksumPath: 'staging/sums', checksumSha256: SHA64, manifestPath: 'staging/manifest', manifestSha256: SHA64, verificationPath: 'staging/verify', verificationSha256: SHA64 });
    expect(() => store.recordPublish('job-1', { state: 'published', finalDirectory: 'release', finalPath: 'release/image', startedAt: '2026-07-23T10:02:00.000Z', publishedAt: '2026-07-23T10:01:00.000Z' })).toThrow(StoreValidationError);
    store.requestFreshness('job-1', NOW);
    expect(() => store.recordFreshness('job-1', { status: 'fresh', pinnedSha: SHA40, observedSha: SHA40, checkedAt: '2026-07-23T09:59:00.000Z' })).toThrow(StoreValidationError);
    expect(() => store.recordTerminal('job-1', { state: 'failed', terminalAt: '2026-07-23T09:59:00.000Z', errorCode: 'BUILD_FAILED', error: {} })).toThrow(StoreValidationError);
  });

  it('paginates events with bounded deterministic cursors', async () => {
    const { store } = await createStore();
    store.createJob(jobInput('job-1'));
    store.requestCancellation('job-1', 'one', NOW);
    store.requestCancellation('job-1', 'two', NOW);
    expect(store.listEvents('job-1').events.map((event) => event.seq)).toEqual([0, 1, 2]);
    expect(store.listEvents('job-1', { limit: EVENT_PAGE_MAX_LIMIT }).events).toHaveLength(3);
    expect(store.listEvents('job-1', { limit: 2 })).toEqual(expect.objectContaining({ nextAfterSeq: 1 }));
    const page = store.listEvents('job-1', { afterSeq: 1, limit: 2 });
    expect(page.events.map((event) => event.seq)).toEqual([2]);
    expect(page.nextAfterSeq).toBeNull();
    expect(() => store.listEvents('job-1', { afterSeq: -2 })).toThrow(StoreValidationError);
    expect(() => store.listEvents('job-1', { afterSeq: 1.5 })).toThrow(StoreValidationError);
    expect(() => store.listEvents('job-1', { limit: 0 })).toThrow(StoreValidationError);
    expect(() => store.listEvents('job-1', { limit: EVENT_PAGE_MAX_LIMIT + 1 })).toThrow(StoreValidationError);
  });

  it('rejects unsupported or excessive JSON values with bounded validation', async () => {
    const { store } = await createStore();
    const invalid: unknown[] = [undefined, () => 1, Symbol('bad'), 1n, Number.NaN, Number.POSITIVE_INFINITY];
    for (const [index, request] of invalid.entries()) {
      expect(() => store.createJob({ ...jobInput(`invalid-${index}`), request } as never)).toThrow(StoreValidationError);
    }
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => store.createJob({ ...jobInput('cycle'), request: cycle as never })).toThrow(StoreValidationError);
    const tooMany = Object.fromEntries(Array.from({ length: JSON_LIMITS.maxKeys + 1 }, (_, index) => [`key-${index}`, index]));
    expect(() => store.createJob({ ...jobInput('too-many'), request: tooMany })).toThrow(StoreValidationError);
    expect(() => store.createJob({ ...jobInput('too-many-array'), request: { values: Array.from({ length: JSON_LIMITS.maxArrayElements + 1 }, () => 1) } })).toThrow(StoreValidationError);
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < JSON_LIMITS.maxDepth + 1; index++) deep = { child: deep };
    expect(() => store.createJob({ ...jobInput('too-deep'), request: deep as never })).toThrow(StoreValidationError);
    expect(() => store.createJob({ ...jobInput('too-large'), request: { value: 'x'.repeat(JSON_LIMITS.maxEncodedBytes) } })).toThrow(StoreValidationError);
  });

  it('preserves prototype-sensitive own JSON keys without prototype pollution', async () => {
    const { store } = await createStore();
    const request = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"marker":1},"prototype":{"marker":2}}') as unknown;
    store.createJob({ ...jobInput('prototype-keys'), request: request as never });
    const saved = store.getJob('prototype-keys').request as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(saved, '__proto__')).toBe(true);
    expect(saved.__proto__).toEqual({ polluted: true });
    expect(saved.constructor).toEqual({ marker: 1 });
    expect(saved.prototype).toEqual({ marker: 2 });
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('enforces a cumulative traversal budget for shared JSON DAGs', async () => {
    const { store } = await createStore();
    const shared = { leaf: 'value' };
    const normal = { branches: [shared, shared] };
    store.createJob({ ...jobInput('shared-normal'), request: normal });
    expect(store.getJob('shared-normal').request?.branches).toEqual([shared, shared]);

    const excessive = Object.fromEntries(Array.from({ length: JSON_LIMITS.maxKeys }, (_, index) => [`branch-${index}`, shared]));
    expect(() => store.createJob({ ...jobInput('shared-excessive'), request: excessive })).toThrow(StoreValidationError);
  });

  it('makes freshness request and result retries idempotent or conflicting as a unit', async () => {
    const { store } = await createStore();
    store.createJob(jobInput('freshness-retry'));
    store.requestFreshness('freshness-retry', NOW);
    const requestedJob = store.getJob('freshness-retry');
    const requestedEvents = eventRows(store, 'freshness-retry');
    store.requestFreshness('freshness-retry', NOW);
    expect(store.getJob('freshness-retry')).toEqual(requestedJob);
    expect(eventRows(store, 'freshness-retry')).toEqual(requestedEvents);
    expect(() => store.requestFreshness('freshness-retry', '2026-07-23T10:01:00.000Z')).toThrow(StoreConflictError);
    expect(store.getJob('freshness-retry')).toEqual(requestedJob);
    expect(eventRows(store, 'freshness-retry')).toEqual(requestedEvents);

    store.recordFreshness('freshness-retry', { status: 'fresh', pinnedSha: SHA40, observedSha: SHA40, checkedAt: NOW });
    const completedJob = store.getJob('freshness-retry');
    const completedEvents = eventRows(store, 'freshness-retry');
    store.recordFreshness('freshness-retry', { status: 'fresh', pinnedSha: SHA40, observedSha: SHA40, checkedAt: NOW });
    expect(store.getJob('freshness-retry')).toEqual(completedJob);
    expect(eventRows(store, 'freshness-retry')).toEqual(completedEvents);
    expect(() => store.recordFreshness('freshness-retry', { status: 'advanced', pinnedSha: SHA40, observedSha: SHA40_B, checkedAt: '2026-07-23T10:01:00.000Z' })).toThrow(StoreConflictError);
    expect(() => store.recordFreshness('freshness-retry', { status: 'fresh', pinnedSha: SHA40_B, observedSha: SHA40_B, checkedAt: '2026-07-23T10:01:00.000Z' })).toThrow(StoreConflictError);
    expect(store.getJob('freshness-retry')).toEqual(completedJob);
    expect(eventRows(store, 'freshness-retry')).toEqual(completedEvents);
  });

  it('requires matching complete preflight fields and compares source fields independently', async () => {
    const { store, path } = await createStore();
    store.createJob(jobInput('absent'));
    expect(countRows(path, 'jobs')).toBe(1);
    expect(() => store.createJob({ ...jobInput('mismatch'), preflightSha: SHA40_B, preflightCheckedAt: NOW, preflightExpiresAt: NOW })).toThrow(StoreValidationError);
    expect(() => store.createJob({ ...jobInput('partial'), preflightSha: undefined, preflightCheckedAt: NOW, preflightExpiresAt: NOW })).toThrow(StoreValidationError);
    const identity = store.getSourceIdentity('absent');
    store.setSourceIdentity('absent', {
      sourceSubject: identity.sourceSubject, sourceAuthor: identity.sourceAuthor, sourceCommitTime: identity.sourceCommitTime,
      pinnedSha: identity.pinnedSha, expectedSha: identity.expectedSha, branch: identity.branch,
      sourceBranch: identity.sourceBranch, sourceRef: identity.sourceRef, sourceRemote: identity.sourceRemote,
    });
    expect(() => store.setSourceIdentity('absent', { ...identity, sourceSubject: 'changed' })).toThrow(StoreConflictError);
  });

  it('returns a typed stage mapping', async () => {
    const { store } = await createStore();
    store.createJob(jobInput('job-1'));
    store.claimNextQueued('osi-image-builder-runner@job-1.service', NOW);
    store.recordStage('job-1', { stage: 'preflight', outcome: 'running', startedAt: NOW });
    expect(store.getStage('job-1', 'preflight')).toEqual(expect.objectContaining({ jobId: 'job-1', stage: 'preflight', outcome: 'running' }));
  });
});
