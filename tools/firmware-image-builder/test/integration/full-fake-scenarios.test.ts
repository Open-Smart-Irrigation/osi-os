import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestCancellation, type ApiCancellationSystemd } from '../../api/src/cancellation.js';
import {
  OwnershipStore,
  type CleanupPostcondition,
  type CleanupSnapshot,
  type DirectLogProof,
  type PublishRecoveryEvidence,
  type RunnerWriteCommand,
} from '../../api/src/ownership.js';
import { createReadyQueueCoordinatorForTesting, type QueueSystemd } from '../../api/src/queue.js';
import { createCleanupAdmissionRecovery } from '../../api/src/recovery.js';
import { createRecoveryFileSystem } from '../../api/src/recovery.js';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { BuilderStore, type CreateJobInput, type JobRecord, type JsonObject } from '../../api/src/store.js';
import { encodeJson } from '../../api/src/validation.js';
import { createCleanupWorker, type CleanupDockerContainer } from '../../cleanup-worker/src/main.js';
import { PIPELINE_STAGE_NAMES, type TargetId } from '../../domain/types.js';
import { TEST_BUILDER_IDENTITY } from '../helpers/builder-identity.js';

const ACCEPTED = '2026-07-29T10:00:00.000Z';
const DISPATCHED = '2026-07-29T10:00:01.000Z';
const OBSERVED = '2026-07-29T10:00:02.000Z';
const FINISHED = '2026-07-29T10:00:03.000Z';
const RECOVERY = '2026-07-29T10:10:00.000Z';
const EXPIRED = '2026-07-29T09:59:00.000Z';
const LEASE_EXPIRES = '2026-07-29T10:05:00.000Z';
const NEXT_EXPIRES = '2026-07-29T10:20:00.000Z';
const PIPELINE_ARTIFACT = '2026-07-29T10:00:11.000Z';
const PIPELINE_PUBLISH = '2026-07-29T10:00:12.000Z';
const PIPELINE_TERMINAL = '2026-07-29T10:00:14.000Z';
const SHA40 = 'a'.repeat(40);
const SHA64 = 'b'.repeat(64);
const IMAGE_DIGEST = 'c'.repeat(64);
const EVIDENCE_SHA = 'd'.repeat(64);
const UID = process.getuid?.() ?? 0;
const JOB_LABEL = 'org.osi.image-builder.job-id';
const MANIFEST_LABEL = 'org.osi.image-builder.manifest-sha';

const directories: string[] = [];
const databases: Array<ReturnType<typeof openBuilderDatabase>> = [];

function sourcePreparation() {
  return {
    schemaVersion: 1 as const,
    sourceSha: SHA40,
    gitmodulesBlobSha: 'e'.repeat(40),
    preparedAt: ACCEPTED,
    components: [
      { path: 'feeds/chirpstack-openwrt-feed' as const, mode: '040000' as const, type: 'tree' as const, objectId: 'f'.repeat(40), provenanceUrl: 'https://github.com/chirpstack/chirpstack-openwrt-feed.git' },
      { path: 'openwrt' as const, mode: '040000' as const, type: 'tree' as const, objectId: '1'.repeat(40), provenanceUrl: 'https://github.com/openwrt/openwrt.git' },
    ],
  };
}

function offlineFeeds(jobId: string) {
  const recursiveSubmoduleStatusSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  return {
    schemaVersion: 1 as const,
    boundary: 'api-prepared-pinned-feeds-v1' as const,
    networkPolicy: 'runner-offline' as const,
    jobId,
    sourceSha: SHA40,
    preparedAt: ACCEPTED,
    feeds: [
      { name: 'packages', location: 'https://git.openwrt.org/feed/packages.git', commit: '1'.repeat(40), detached: true as const, clean: true as const, recursiveSubmodulesPrepared: true as const, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: SHA64 },
      { name: 'luci', location: 'https://git.openwrt.org/project/luci.git', commit: '2'.repeat(40), detached: true as const, clean: true as const, recursiveSubmodulesPrepared: true as const, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: SHA64 },
      { name: 'routing', location: 'https://git.openwrt.org/feed/routing.git', commit: '3'.repeat(40), detached: true as const, clean: true as const, recursiveSubmodulesPrepared: true as const, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: SHA64 },
    ],
  };
}

function input(jobId: string, targetId: TargetId): CreateJobInput {
  return {
    jobId,
    requestId: `request-${jobId}`,
    request: { branch: 'main', target: targetId },
    sourceRemote: 'git@example.com:osi-os.git',
    sourceRef: 'refs/remotes/origin/main',
    sourceBranch: 'main',
    branch: 'main',
    expectedSha: SHA40,
    pinnedSha: SHA40,
    sourcePreparation: sourcePreparation(),
    offlineFeedPreparation: offlineFeeds(jobId),
    targetId,
    rootId: 'release',
    targetManifestSha256: SHA64,
    builderIdentity: TEST_BUILDER_IDENTITY,
    sourceCommitTime: ACCEPTED,
    sourceAuthor: 'scenario test',
    sourceSubject: `scenario ${jobId}`,
    acceptedAt: ACCEPTED,
  };
}

type Fixture = {
  readonly root: string;
  readonly db: ReturnType<typeof openBuilderDatabase>;
  readonly store: BuilderStore;
  readonly ownership: OwnershipStore;
  readonly jobId: string;
  readonly targetId: TargetId;
};

async function fixture(jobId: string, targetId: TargetId): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `osi-full-fake-${jobId}-`));
  directories.push(root);
  const db = openBuilderDatabase(join(root, 'state.sqlite'));
  databases.push(db);
  const ownership = new OwnershipStore(db, { now: () => ACCEPTED });
  const store = new BuilderStore(db);
  const result = ownership.apiWrite({ kind: 'enqueue', input: input(jobId, targetId) });
  expect(result).toMatchObject({ ok: true });
  return { root, db, store, ownership, jobId, targetId };
}

function committed<T extends { readonly ok: boolean; readonly kind?: string }>(result: T): number {
  if (!result.ok || result.kind !== 'committed') throw new Error(`expected a committed ownership write: ${JSON.stringify(result)}`);
  return (result as T & { readonly eventSeq: number }).eventSeq;
}

function runnerBase(value: Pick<Fixture, 'jobId'>): Pick<Extract<RunnerWriteCommand, { kind: 'stage' }>, 'jobId' | 'owner' | 'runnerUnit' | 'leaseExpiresAt' | 'at'> {
  return {
    jobId: value.jobId,
    owner: 'runner-a',
    runnerUnit: `osi-image-builder-runner@${value.jobId}.service`,
    leaseExpiresAt: LEASE_EXPIRES,
    at: OBSERVED,
  };
}

function queueSystemd() {
  const active = new Set<string>();
  const starts: string[] = [];
  const systemd: QueueSystemd = {
    inspect: async (unit) => ({ unit, active: active.has(unit), pending: false, observedAt: DISPATCHED }),
    listActive: async () => [...active],
    start: async (unit) => {
      starts.push(unit);
      active.add(unit);
      return { unit, argv: ['systemctl', '--user', 'start', unit], exitCode: 0, timedOut: false };
    },
  };
  return { systemd, active, starts };
}

async function dispatch(value: Fixture): Promise<void> {
  const state = queueSystemd();
  const coordinator = createReadyQueueCoordinatorForTesting({
    db: value.db,
    ownership: value.ownership,
    systemd: state.systemd,
    safety: { inspect: async () => null },
    clock: { now: () => DISPATCHED },
  });
  const result = await coordinator.dispatchNext();
  if (result.kind !== 'started') throw new Error(`dispatch fixture blocked: ${JSON.stringify(result)}`);
  expect(result).toMatchObject({ kind: 'started', jobId: value.jobId });
  committed(value.ownership.runnerWrite({
    kind: 'acquire-lease',
    jobId: value.jobId,
    runnerUnit: `osi-image-builder-runner@${value.jobId}.service`,
    owner: 'runner-a',
    expiresAt: LEASE_EXPIRES,
    at: OBSERVED,
  }));
}

function terminalEvents(value: Fixture): readonly ReturnType<BuilderStore['listEvents']>['events'][number][] {
  const events = value.store.listEvents(value.jobId).events;
  return events.filter((event) => event.eventType === 'terminal' || (
    event.eventType === 'recovery'
    && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(event.state ?? '')
    && event.payload.state === event.state
  ));
}

function expectOneTerminalPath(value: Fixture, expectedTarget: TargetId, expectedState: JobRecord['state']): void {
  const job = value.store.getJob(value.jobId);
  expect(job.targetId).toBe(expectedTarget);
  expect(job.state).toBe(expectedState);
  expect(terminalEvents(value)).toHaveLength(1);
  expect(value.db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE job_id=? AND target_id=?').get(value.jobId, expectedTarget)).toEqual({ count: 1 });
}

function buildIdentity(value: Pick<Fixture, 'jobId' | 'targetId'>): JsonObject {
  return {
    artifactSha256: SHA64,
    branch: 'main',
    jobId: value.jobId,
    pinnedSha: SHA40,
    targetId: value.targetId,
  };
}

function buildIdentitySha256(value: Pick<Fixture, 'jobId' | 'targetId'>): string {
  return hash(canonical(buildIdentity(value)));
}

function terminalVerification(value: Pick<Fixture, 'jobId' | 'targetId'>): {
  readonly content: JsonObject;
  readonly bytes: string;
  readonly sha256: string;
} {
  const content: JsonObject = {
    ...buildIdentity(value),
    observations: {
      publishEvidence: {
        path: `jobs/${value.jobId}/evidence/09-publish.json`,
      },
      stageEvidence: PIPELINE_STAGE_NAMES.map((stage, index) => ({
        stage,
        path: `${String(index).padStart(2, '0')}-${stage}.json`,
        outcome: 'passed',
      })),
    },
  };
  const bytes = encodeJson(content, 'terminal verification fixture', true);
  return { content, bytes, sha256: hash(bytes) };
}

function publishStageEvidence(
  value: Pick<Fixture, 'jobId' | 'targetId'>,
  verificationSha256: string,
  finishedAt = PIPELINE_TERMINAL,
): { readonly bytes: string; readonly sha256: string } {
  const content: JsonObject = {
    schemaVersion: 1,
    jobId: value.jobId,
    stage: 'publish',
    startedAt: PIPELINE_PUBLISH,
    finishedAt,
    outcome: 'passed',
    operationId: null,
    commands: [],
    inputs: {
      targetId: value.targetId,
      rootId: 'release',
      branch: 'main',
      pinnedSha: SHA40,
    },
    observations: { final: { verificationSha256 } },
    error: null,
  };
  const bytes = `${encodeJson(content, 'publish stage fixture', true)}\n`;
  return { bytes, sha256: hash(bytes) };
}

function finishSuccessfully(value: Fixture): void {
  seedPublishing(value);
  const base = runnerBase(value);
  const verification = terminalVerification(value);
  const stage = publishStageEvidence(value, verification.sha256);
  committed(value.ownership.runnerWrite({
    ...base,
    at: PIPELINE_TERMINAL,
    kind: 'publish-terminal',
    expectedState: 'publishing',
    startedAt: PIPELINE_PUBLISH,
    finishedAt: PIPELINE_TERMINAL,
    evidencePath: `jobs/${value.jobId}/evidence/09-publish.json`,
    evidenceSha256: stage.sha256,
    finalDirectory: `release/${value.jobId}`,
    finalPath: `release/${value.jobId}/image`,
    publishStartedAt: PIPELINE_PUBLISH,
    publishedAt: PIPELINE_TERMINAL,
    terminalAt: PIPELINE_TERMINAL,
    priorVerificationSha256: buildIdentitySha256(value),
    verificationSha256: verification.sha256,
    observedStageEvidence: {
      present: true,
      path: `jobs/${value.jobId}/evidence/09-publish.json`,
      bytes: stage.bytes,
      sha256: stage.sha256,
    },
    observedVerification: {
      present: true,
      path: `release/${value.jobId}/verification.json`,
      bytes: verification.bytes,
      sha256: verification.sha256,
    },
  }));
}

function cancellationClock(start = ACCEPTED) {
  let monotonic = 0;
  return {
    now: () => new Date(Date.parse(start) + monotonic).toISOString(),
    monotonicNow: () => monotonic,
    sleep: async (milliseconds: number) => { monotonic += milliseconds; },
  };
}

function cancellationSystemd(): ApiCancellationSystemd & { readonly calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    signalCancellation: vi.fn(async (unit) => { calls.push(['signal', unit]); return { commandOutcome: 'completed' as const, activity: 'unknown' as const, argv: [], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }; }),
    stopRunner: vi.fn(async (unit) => { calls.push(['stop', unit]); return { commandOutcome: 'completed' as const, activity: 'unknown' as const, argv: [], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }; }),
    inspectRunner: vi.fn(async (unit) => { calls.push(['inspect', unit]); return { commandOutcome: 'completed' as const, activity: 'active' as const, argv: [], exitCode: 0, signal: null, stdout: 'active\n', stderr: '', timedOut: false }; }),
  };
}

const absent = (observedAt = FINISHED) => ({ kind: 'absent' as const, globalLabelResult: 'no-match' as const, observedAt });
const directLogs: DirectLogProof = { runner: 'absent', docker: 'absent', verifiedAt: FINISHED, generationIdentity: { runner: [], docker: [] } };

function cancellationEvidence(value: Fixture): Extract<RunnerWriteCommand, { kind: 'cancellation-evidence' }>['evidence'] {
  return {
    kind: 'pre-container',
    runnerUnit: `osi-image-builder-runner@${value.jobId}.service`,
    runnerObservedAt: FINISHED,
    evidencePath: `jobs/${value.jobId}/evidence/cancellation.json`,
    evidenceSha256: EVIDENCE_SHA,
    container: absent(),
    staging: { kind: 'absent', path: null },
    logs: { runner: 'absent', docker: 'absent', verifiedAt: FINISHED },
  };
}

function cleanupSnapshot(value: Fixture): CleanupSnapshot {
  return {
    runner: { unit: `osi-image-builder-runner@${value.jobId}.service`, owner: 'runner-a', leaseExpiresAt: EXPIRED, inactiveAt: FINISHED, observedAt: FINISHED },
    state: 'starting',
    container: { kind: 'present', id: `container-${value.jobId}`, name: `osi-${value.jobId}`, imageDigest: IMAGE_DIGEST, labels: { [JOB_LABEL]: value.jobId, [MANIFEST_LABEL]: SHA64 }, globalLabelResult: 'single-exact-match', observedAt: FINISHED },
    staging: { kind: 'absent', path: null },
    logs: { runner: 'absent', docker: 'absent', verifiedAt: FINISHED },
    blocker: 'container',
  };
}

async function cleanupFixture(jobId: string): Promise<{ readonly value: Fixture; readonly snapshot: CleanupSnapshot; readonly recovery: ReturnType<typeof createCleanupAdmissionRecovery>; readonly admission: Awaited<ReturnType<ReturnType<typeof createCleanupAdmissionRecovery>['admitAndStart']>>; readonly docker: { present: boolean; removeCalls: number } }> {
  const value = await fixture(jobId, 'rpi-5');
  await dispatch(value);
  committed(value.ownership.runnerWrite({
    ...runnerBase(value),
    kind: 'container',
    lifecycle: 'created',
    containerId: `container-${jobId}`,
    containerName: `osi-${jobId}`,
    imageDigest: IMAGE_DIGEST,
    labels: { [JOB_LABEL]: jobId, [MANIFEST_LABEL]: SHA64 },
    mount: { source: '/tmp/worktree', destination: '/work' },
    environment: { CI: '1' },
    security: { noNewPrivileges: true },
    inspection: { running: true },
    occurredAt: OBSERVED,
    createdAt: OBSERVED,
  }));
  value.db.prepare('UPDATE jobs SET runner_lease_expires_at=? WHERE job_id=?').run(EXPIRED, value.jobId);
  const snapshot = cleanupSnapshot(value);
  const systemd: { readonly start: (unit: string) => Promise<void>; readonly isActive: (unit: string) => Promise<boolean>; readonly inspect: (unit: string) => Promise<{ readonly unit: string; readonly active: boolean; readonly observedAt: string }>; readonly starts: string[] } = {
    starts: [],
    start: async () => undefined,
    isActive: async () => false,
    inspect: async (unit) => ({ unit, active: false, observedAt: FINISHED }),
  };
  const recovery = createCleanupAdmissionRecovery({
    stateRoot: value.root,
    db: value.db,
    ownership: value.ownership,
    systemd,
    clock: { now: () => FINISHED },
    crypto: { randomBytes: (size) => Buffer.alloc(size, 7) },
    ownerUid: UID,
  });
  await recovery.openAdmissions();
  const admission = await recovery.admitAndStart({ jobId, owner: 'cleanup-worker', expiresAt: LEASE_EXPIRES, at: FINISHED, snapshot });
  const docker = { present: true, removeCalls: 0 };
  return { value, snapshot, recovery, admission, docker };
}

type CleanupFixture = Awaited<ReturnType<typeof cleanupFixture>>;
type CleanupAdmission = Awaited<ReturnType<ReturnType<typeof createCleanupAdmissionRecovery>['reconcileAndStart']>>;

async function runCleanupWorker(
  value: CleanupFixture,
  admission: Pick<CleanupAdmission, 'admissionId'>,
  at: string,
  crashPhase?: 'before-remove' | 'after-remove',
): Promise<Readonly<{ inspectCount: number; postcondition: CleanupPostcondition | null }>> {
  let inspectCount = 0;
  let writtenPostcondition: CleanupPostcondition | null = null;
  const identity = value.snapshot.container;
  if (identity.kind !== 'present') throw new Error('cleanup fixture lost exact container identity');
  const container = (running: boolean): CleanupDockerContainer => ({
    id: identity.id,
    name: identity.name,
    imageDigest: identity.imageDigest,
    labels: identity.labels,
    running,
    stoppedAt: running ? null : at,
  });
  const worker = createCleanupWorker({
    db: value.value.db,
    stateRoot: value.value.root,
    ownerUid: UID,
    workerOwner: 'cleanup-worker',
    ownership: value.value.ownership,
    fileSystem: createRecoveryFileSystem(),
    clock: { now: () => at },
    timeouts: { dockerMs: 1_000, systemdMs: 1_000 },
    systemd: {
      inspect: vi.fn(async (unit: string) => {
        inspectCount += 1;
        const crashAt = crashPhase === 'before-remove' ? 5 : crashPhase === 'after-remove' ? 11 : null;
        if (crashAt !== null && inspectCount === crashAt) throw new Error(`simulated ${crashPhase} crash`);
        return { unit, active: false, observedAt: at };
      }),
    },
    docker: {
      inspect: vi.fn(async () => value.docker.present ? container(true) : null),
      stop: vi.fn(async () => undefined),
      waitForStopped: vi.fn(async () => container(false)),
      remove: vi.fn(async () => { value.docker.removeCalls += 1; value.docker.present = false; }),
      hasByJobId: vi.fn(async () => false),
      listByJobId: vi.fn(async () => []),
    },
    logSealer: { seal: vi.fn(async () => ({ runner: 'absent' as const, docker: 'absent' as const, verifiedAt: at, contiguous: true as const })) },
    quarantine: { quarantine: vi.fn(async () => ({ kind: 'absent' as const, path: null, sourcePath: `staging/${value.value.jobId}`, sourceAbsent: true as const, verifiedAt: at })) },
    evidenceWriter: {
      write: vi.fn(async (input) => {
        if (input.evidence.kind === 'cleanup-complete') {
          writtenPostcondition = input.evidence.postcondition as unknown as CleanupPostcondition;
        }
        return {
          path: `jobs/${value.value.jobId}/evidence/cleanup/${admission.admissionId}.complete.json`,
          sha256: EVIDENCE_SHA,
        };
      }),
    },
    dependencyEgress: { cleanup: vi.fn(async () => ({ persistedDocker: null, discoveredDocker: [], credentials: [], globalLabelResult: 'no-match' as const })) },
  });
  if (crashPhase === undefined) await worker.run([admission.admissionId]);
  else await expect(worker.run([admission.admissionId])).rejects.toThrow(`simulated ${crashPhase} crash`);
  expect(inspectCount).toBeGreaterThan(0);
  return { inspectCount, postcondition: writtenPostcondition };
}

async function crashCleanup(value: CleanupFixture, phase: 'before-remove' | 'after-remove'): Promise<void> {
  await runCleanupWorker(value, value.admission, FINISHED, phase);
}

async function completeReplacement(value: CleanupFixture, replacement: CleanupAdmission): Promise<void> {
  const completed = await runCleanupWorker(value, replacement, RECOVERY);
  expect(value.docker.present).toBe(false);
  expect(value.docker.removeCalls).toBe(1);
  if (completed.postcondition === null) throw new Error('replacement cleanup did not write completion evidence');
  const postcondition = completed.postcondition;
  const evidence = { read: vi.fn(async () => ({ jobId: value.value.jobId, admissionId: replacement.admissionId, sha256: EVIDENCE_SHA, postcondition })) };
  const restarted = createCleanupAdmissionRecovery({
    stateRoot: value.value.root,
    db: value.value.db,
    ownership: new OwnershipStore(value.value.db, { now: () => RECOVERY }),
    systemd: { start: async () => undefined, isActive: async () => false, inspect: async (unit) => ({ unit, active: false, observedAt: RECOVERY }) },
    handBack: { docker: { inspect: async () => ({ container: null, observedAt: RECOVERY }), listByLabels: async () => ({ containers: [], observedAt: RECOVERY }) }, evidence, staging: { verify: async () => true }, logs: { verify: async () => true } },
    clock: { now: () => RECOVERY },
    ownerUid: UID,
  });
  await restarted.openAdmissions();
  await restarted.reconcileCompletedAdmissions();
  expect(value.value.store.getJob(value.value.jobId).state).toBe('interrupted');
  expect(value.value.db.prepare('SELECT status FROM cleanup_leases WHERE admission_id=?').get(replacement.admissionId))
    .toEqual({ status: 'handed_back' });
  await expect(restarted.handBackCompleted({
    jobId: value.value.jobId,
    admissionId: replacement.admissionId,
    at: RECOVERY,
  })).resolves.toMatchObject({ state: 'already-interrupted', handedBack: false });
}

function canonical(value: Record<string, unknown>): string { return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function publishEvidence(value: Pick<Fixture, 'jobId' | 'targetId'>): PublishRecoveryEvidence {
  const { jobId } = value;
  const manifest = buildIdentity(value);
  const manifestSha256 = hash(canonical(manifest));
  const verification = terminalVerification(value);
  const stage = publishStageEvidence(value, verification.sha256, RECOVERY);
  const checksumContents = `${SHA64}  image\n`;
  const checksumSha256 = hash(checksumContents);
  return {
    runner: { unit: `osi-image-builder-runner@${jobId}.service`, owner: 'runner-a', leaseExpiresAt: LEASE_EXPIRES, inactiveAt: FINISHED, observedAt: RECOVERY },
    container: absent(RECOVERY),
    stage: { startedAt: PIPELINE_PUBLISH, finishedAt: RECOVERY, evidencePath: `jobs/${jobId}/evidence/09-publish.json`, evidenceSha256: stage.sha256 },
    artifact: { stagingPath: 'staging/image', artifactSha256: SHA64, artifactSize: 10, artifactMtime: OBSERVED, checksumPath: 'staging/sums', checksumSha256, manifestPath: 'staging/manifest', manifestSha256, verificationPath: 'staging/verify', verificationSha256: manifestSha256 },
    final: { directory: `release/${jobId}`, path: `release/${jobId}/image`, publishStartedAt: PIPELINE_PUBLISH, publishedAt: null },
    observed: {
      stageEvidence: { present: true, path: `jobs/${jobId}/evidence/09-publish.json`, bytes: stage.bytes, sha256: stage.sha256 },
      final: { present: true, path: `release/${jobId}/image`, held: true, size: 10, sha256: SHA64 },
      checksum: { present: true, path: `release/${jobId}/sha256sums`, contents: checksumContents, sha256: checksumSha256 },
      manifest: { present: true, path: `release/${jobId}/build-manifest.json`, bytes: canonical(manifest), content: manifest, sha256: manifestSha256 },
      verification: { present: true, path: `release/${jobId}/verification.json`, bytes: verification.bytes, content: verification.content, sha256: verification.sha256 },
      staging: { state: 'absent', path: null, sha256: null, size: null, held: false },
      logs: { runner: 'sealed', docker: 'sealed', verifiedAt: RECOVERY, noGap: true },
    },
  };
}

function seedPublishing(value: Fixture): void {
  const base = runnerBase(value);
  const stages: Array<[Extract<RunnerWriteCommand, { kind: 'stage' }>['stage'], JobRecord['state'], JobRecord['state']]> = [
    ['preflight', 'starting', 'preflight'], ['source', 'preflight', 'source'], ['release-gates', 'source', 'release_gates'], ['frontend', 'release_gates', 'frontend'], ['target-setup', 'frontend', 'target_setup'], ['feeds', 'target_setup', 'feeds'], ['config', 'feeds', 'config'], ['build', 'config', 'building'], ['verify', 'building', 'verifying'],
  ];
  for (const [index, [stage, expectedState, state]] of stages.entries()) {
    const startedAt = new Date(Date.parse(ACCEPTED) + (index + 2) * 1_000).toISOString();
    const finishedAt = new Date(Date.parse(startedAt) + 100).toISOString();
    const at = new Date(Date.parse(startedAt) + 200).toISOString();
    committed(value.ownership.runnerWrite({ ...base, at, kind: 'stage', expectedState, state, stage, outcome: 'passed', startedAt, finishedAt, evidencePath: `jobs/${value.jobId}/evidence/${stage}.json`, evidenceSha256: SHA64 }));
  }
  const manifestSha256 = buildIdentitySha256(value);
  committed(value.ownership.runnerWrite({ ...base, at: PIPELINE_ARTIFACT, kind: 'artifact', expectedState: 'verifying', state: 'verifying', stagingPath: 'staging/image', artifactSha256: SHA64, artifactSize: 10, artifactMtime: OBSERVED, checksumPath: 'staging/sums', checksumSha256: hash(`${SHA64}  image\n`), manifestPath: 'staging/manifest', manifestSha256, verificationPath: 'staging/verify', verificationSha256: manifestSha256 }));
  committed(value.ownership.runnerWrite({ ...base, at: PIPELINE_PUBLISH, kind: 'publish-stage-start', expectedState: 'verifying', startedAt: PIPELINE_PUBLISH, finalDirectory: `release/${value.jobId}`, finalPath: `release/${value.jobId}/image`, publishStartedAt: PIPELINE_PUBLISH }));
}

function seedSealedLogs(value: Fixture): void {
  for (const stream of ['runner', 'docker']) {
    value.db.prepare(`INSERT INTO job_log_generations
      (job_id, stream, generation, path, started_at, sealed_at, size_bytes, sha256)
      VALUES (?, ?, 0, ?, ?, ?, 0, ?)`)
      .run(value.jobId, stream, `logs/${stream}-0.log`, ACCEPTED, FINISHED, SHA64);
  }
}

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('full deterministic fake build scenarios', () => {
  it('builds a Pi 5 job to one successful terminal path', async () => {
    const value = await fixture('pi5-success', 'rpi-5');
    await dispatch(value);
    finishSuccessfully(value);
    expectOneTerminalPath(value, 'rpi-5', 'succeeded');
  });

  it('builds a Pi 4 job to one successful terminal path', async () => {
    const value = await fixture('pi4-success', 'rpi-2');
    await dispatch(value);
    finishSuccessfully(value);
    expectOneTerminalPath(value, 'rpi-2', 'succeeded');
  });

  it('cancels a queued job atomically with one terminal path and no runner start', async () => {
    const value = await fixture('queued-cancel', 'rpi-5');
    const systemd = cancellationSystemd();
    await expect(requestCancellation({ store: value.store, ownership: value.ownership, systemd, clock: cancellationClock() }, { jobId: value.jobId, reason: 'operator', at: DISPATCHED })).resolves.toMatchObject({ kind: 'queued-cancelled', state: 'cancelled' });
    expect(systemd.calls).toEqual([]);
    expectOneTerminalPath(value, 'rpi-5', 'cancelled');
  });

  it('cancels an active job through the runner protocol exactly once', async () => {
    const value = await fixture('active-cancel', 'rpi-5');
    await dispatch(value);
    committed(value.ownership.apiWrite({
      kind: 'request-cancellation',
      jobId: value.jobId,
      reason: 'operator',
      at: OBSERVED,
      cooperativeDeadlineAt: FINISHED,
    }));
    const base = runnerBase(value);
    committed(value.ownership.runnerWrite({ ...base, kind: 'cancellation-transition', expectedState: 'starting', at: OBSERVED }));
    const evidence = value.ownership.runnerWrite({ ...base, kind: 'cancellation-evidence', expectedState: 'cancel_requested', evidence: cancellationEvidence(value), at: FINISHED });
    const cleanup = value.ownership.runnerWrite({ ...base, kind: 'cancellation-cleanup', expectedState: 'cancel_requested', evidenceEventSeq: committed(evidence), proof: { kind: 'pre-container', runnerUnit: base.runnerUnit, unitInactiveAt: null, container: absent(), staging: { kind: 'absent', path: null }, logs: directLogs }, at: FINISHED });
    committed(value.ownership.runnerWrite({ ...base, kind: 'cancellation-terminal', expectedState: 'cancel_requested', terminalAt: FINISHED, cleanupEventSeq: committed(cleanup), at: FINISHED }));
    expectOneTerminalPath(value, 'rpi-5', 'cancelled');
  });

  it.each([
    ['before exact artifact removal', 'before-remove' as const],
    ['after exact artifact removal before cleanup CAS', 'after-remove' as const],
  ])('recovers a cleanup crash %s through one interrupted terminal path', async (_label, phase) => {
    const value = await cleanupFixture(`cleanup-crash-${phase}`);
    await crashCleanup(value, phase);
    expect(value.docker.present).toBe(phase === 'before-remove');
    const replacement = await value.recovery.reconcileAndStart({ jobId: value.value.jobId, admissionId: value.admission.admissionId, owner: 'cleanup-worker', expiresAt: NEXT_EXPIRES, at: RECOVERY, snapshot: value.snapshot });
    expect(replacement.rotated).toBe(true);
    await completeReplacement(value, replacement);
    expectOneTerminalPath(value.value, 'rpi-5', 'interrupted');
  });

  it('recovers a publishing job with durable evidence and one successful terminal path', async () => {
    const value = await fixture('publish-recovery', 'rpi-5');
    await dispatch(value);
    seedPublishing(value);
    seedSealedLogs(value);
    const result = value.ownership.apiWrite({ kind: 'publish-recovery', jobId: value.jobId, expectedState: 'publishing', at: RECOVERY, state: 'succeeded', evidence: publishEvidence(value) });
    expect(result).toMatchObject({ ok: true });
    expectOneTerminalPath(value, 'rpi-5', 'succeeded');
  });

  it('rotates a delayed cleanup admission after its fence expires and closes once', async () => {
    const value = await cleanupFixture('delayed-rotated-admission');
    const tokenHash = (value.value.db.prepare('SELECT fence_token_hash FROM cleanup_leases WHERE admission_id=?').get(value.admission.admissionId) as { fence_token_hash: string }).fence_token_hash;
    committed(value.value.ownership.cleanupWrite({ kind: 'claim-lease', jobId: value.value.jobId, admissionId: value.admission.admissionId, owner: 'cleanup-worker', unitName: value.admission.unitName, fenceGeneration: value.admission.generation, fenceTokenHash: tokenHash, snapshot: value.snapshot, at: FINISHED }));
    const replacement = await value.recovery.reconcileAndStart({ jobId: value.value.jobId, admissionId: value.admission.admissionId, owner: 'cleanup-worker', expiresAt: NEXT_EXPIRES, at: RECOVERY, snapshot: value.snapshot });
    expect(replacement.rotated).toBe(true);
    await completeReplacement(value, replacement);
    expectOneTerminalPath(value.value, 'rpi-5', 'interrupted');
  });
});
