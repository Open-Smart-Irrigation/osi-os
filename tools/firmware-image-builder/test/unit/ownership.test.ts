import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { BuilderStore } from '../../api/src/store.js';
import { encodeJson, normalizeJson } from '../../api/src/validation.js';
import type { JobState, PipelineStageName } from '../../domain/types.js';
import {
  OwnershipStore, OwnershipTransactionError, OwnershipValidationError, OwnershipViolationError,
  type ApiWriteCommand, type CleanupPostcondition, type CleanupSnapshot, type CleanupWriteCommand, type DirectInterruptionProof, type DirectLogProof, type StagingCleanupProof,
  type OwnershipResult, type PublishRecoveryEvidence, type RunnerWriteCommand,
} from '../../api/src/ownership.js';
import { SharedValidationError } from '../../api/src/validation.js';

const SHA40 = 'a'.repeat(40); const SHA64 = 'c'.repeat(64); const SHA64_B = 'd'.repeat(64);
const NOW = '2026-07-23T10:00:00.000Z'; const LATER = '2026-07-23T10:01:00.000Z';
const BEFORE = '2026-07-23T09:59:00.000Z';
const ACTIVE = '2026-07-23T10:02:00.000Z'; const RECOVERY = '2026-07-23T10:03:00.000Z'; const EXPIRY = '2026-07-23T10:04:00.000Z';
const SEALED = '2026-07-23T10:03:30.000Z'; const AFTER = '2026-07-23T10:03:45.000Z';
const SOURCE_PREPARATION = Object.freeze({
  schemaVersion: 1 as const,
  sourceSha: SHA40,
  gitmodulesBlobSha: 'b'.repeat(40),
  preparedAt: NOW,
  components: Object.freeze([
    Object.freeze({ path: 'feeds/chirpstack-openwrt-feed' as const, mode: '040000' as const, type: 'tree' as const, objectId: 'd'.repeat(40), provenanceUrl: 'https://github.com/chirpstack/chirpstack-openwrt-feed.git' }),
    Object.freeze({ path: 'openwrt' as const, mode: '040000' as const, type: 'tree' as const, objectId: 'e'.repeat(40), provenanceUrl: 'https://github.com/openwrt/openwrt.git' }),
  ]),
});
const tempPaths: string[] = []; const closers: Array<() => void> = [];
function workerWrite(path: string, actor: 'api' | 'runner' | 'cleanup', command: object, barrier?: SharedArrayBuffer): Promise<unknown> {
  const ownershipUrl = new URL('../../api/src/ownership.ts', import.meta.url).href;
  const schemaUrl = new URL('../../api/src/store-schema.ts', import.meta.url).href;
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      import { parentPort, workerData } from 'node:worker_threads';
      const { openBuilderDatabase } = await import(workerData.schemaUrl);
      const { OwnershipStore } = await import(workerData.ownershipUrl);
      const db = openBuilderDatabase(workerData.path, { busyTimeoutMs: 250 });
      try {
        if (workerData.barrier) { const barrier = new Int32Array(workerData.barrier); Atomics.add(barrier, 0, 1); Atomics.notify(barrier, 0); while (Atomics.load(barrier, 1) === 0) Atomics.wait(barrier, 1, 0); }
        const ownership = new OwnershipStore(db, { now: () => '2026-07-23T10:00:00.000Z' }); parentPort.postMessage(ownership[workerData.actor + 'Write'](workerData.command));
      }
      finally { db.close(); }
    `, { eval: true, workerData: { path, actor, command, ownershipUrl, schemaUrl, barrier }, execArgv: ['--import', 'tsx'] });
    worker.once('message', (message) => resolve(message)); worker.once('error', reject); worker.once('exit', (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
  });
}
async function synchronizedWorkers(path: string, writes: ReadonlyArray<readonly ['api' | 'runner' | 'cleanup', object]>): Promise<unknown[]> {
  const barrier = new SharedArrayBuffer(8); const state = new Int32Array(barrier);
  const results = writes.map(([actor, command]) => workerWrite(path, actor, command, barrier));
  while (Atomics.load(state, 0) !== writes.length) await new Promise<void>((resolve) => setImmediate(resolve));
  expect(Atomics.load(state, 0)).toBe(writes.length);
  Atomics.store(state, 1, 1); Atomics.notify(state, 1);
  return Promise.all(results);
}
function canonicalJson(value: Record<string, unknown>): string { return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))); }
function manifestHash(jobId: string): string { return createHash('sha256').update(canonicalJson({ artifactSha256: SHA64, branch: 'main', jobId, pinnedSha: SHA40, targetId: 'rpi-5' })).digest('hex'); }
function verificationHash(jobId: string): string { return createHash('sha256').update(canonicalJson({ artifactSha256: SHA64, branch: 'main', jobId, pinnedSha: SHA40, targetId: 'rpi-5' })).digest('hex'); }
const CHECKSUM_CONTENT = `${SHA64}  image\n`;
function checksumHash(): string { return createHash('sha256').update(CHECKSUM_CONTENT).digest('hex'); }

function seedJob(db: ReturnType<typeof openBuilderDatabase>, jobId: string): void {
  db.prepare(`INSERT INTO jobs (job_id, request_id, request_json, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, source_preparation_json,
    target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, queue_position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', 0, ?, ?)`).run(
    jobId, `request-${jobId}`, JSON.stringify({ branch: 'main', target: 'rpi-5' }), 'git@example.com:osi-os.git', 'refs/remotes/origin/main', 'main', 'main', SHA40, SHA40,
    JSON.stringify(SOURCE_PREPARATION), 'rpi-5', 'release', SHA64, NOW, 'Phil', 'build', NOW, NOW, NOW,
  );
  db.prepare('INSERT INTO queue_entries (job_id, fifo_seq, enqueued_at) VALUES (?, ?, ?)').run(jobId, 0, NOW);
  db.prepare("INSERT INTO job_events (job_id, seq, event_type, state, stage, payload_json, at) VALUES (?, 0, 'enqueue', 'queued', NULL, ?, ?)").run(jobId, JSON.stringify({ requestId: `request-${jobId}` }), NOW);
}

async function fixture(jobId = 'job-1'): Promise<{ store: BuilderStore; ownership: OwnershipStore; path: string; db: ReturnType<typeof openBuilderDatabase> }> {
  const directory = await mkdtemp(join(tmpdir(), 'osi-image-builder-ownership-')); tempPaths.push(directory); const path = join(directory, 'jobs.sqlite');
  const db = openBuilderDatabase(path); seedJob(db, jobId); const store = new BuilderStore(db); const ownership = new OwnershipStore(db, { now: () => NOW }); closers.push(() => store.close()); return { store, ownership, path, db };
}
function eventCount(store: BuilderStore): number { return store.listEvents('job-1').events.length; }
function dispatch(jobId = 'job-1'): Extract<ApiWriteCommand, { kind: 'dispatch' }> { return { kind: 'dispatch', jobId, runnerUnit: `osi-image-builder-runner@${jobId}.service`, at: NOW }; }
function lease(expiresAt = ACTIVE, jobId = 'job-1'): Extract<RunnerWriteCommand, { kind: 'acquire-lease' }> { return { kind: 'acquire-lease', jobId, runnerUnit: `osi-image-builder-runner@${jobId}.service`, owner: 'runner-a', expiresAt, at: NOW }; }
function container(jobId = 'job-1'): Extract<RunnerWriteCommand, { kind: 'container' }> { return {
  kind: 'container', jobId, owner: 'runner-a', runnerUnit: `osi-image-builder-runner@${jobId}.service`, leaseExpiresAt: ACTIVE, at: NOW,
  lifecycle: 'created', containerId: `container-${jobId}`, containerName: `osi-${jobId}`, imageDigest: SHA64_B,
  labels: { 'org.osi.image-builder.job-id': jobId, 'org.osi.image-builder.manifest-sha': SHA64 }, mount: { source: '/tmp', destination: '/work' },
  environment: { CI: '1' }, security: { user: '1000:1000' }, inspection: { running: true }, occurredAt: NOW,
}; }
const absent = (observedAt = NOW) => ({ kind: 'absent' as const, globalLabelResult: 'no-match' as const, observedAt });
const logs: DirectLogProof = { runner: 'absent', docker: 'absent', verifiedAt: NOW, generationIdentity: { runner: [], docker: [] } };
const staging = { kind: 'absent' as const, path: null };
function direct(kind: 'start-failure' | 'active', jobId = 'job-1'): DirectInterruptionProof {
  if (kind === 'start-failure') return { kind, runnerUnit: `osi-image-builder-runner@${jobId}.service`, startAttemptedAt: NOW, unitInactiveAt: LATER, runnerLeaseOwner: null, runnerLeaseExpiresAt: null, container: absent(), staging, logs, blocker: 'none', cleanupAdmission: null, cleanupFence: null };
  return { kind, runnerUnit: `osi-image-builder-runner@${jobId}.service`, runnerLeaseOwner: 'runner-a', runnerLeaseExpiresAt: ACTIVE, leaseStaleAt: RECOVERY, unitInactiveAt: LATER, container: absent(), staging, logs, blocker: 'none', cleanupAdmission: null, cleanupFence: null };
}
function directWithLogs(kind: 'start-failure' | 'active', jobId: string, logProof: DirectLogProof): DirectInterruptionProof { return { ...direct(kind, jobId), logs: logProof };
}
function eventSeq(result: OwnershipResult): number { if (!result.ok || result.kind !== 'committed') throw new Error('expected a committed write'); return result.eventSeq; }
function sealedDirectLogs(path: string, jobId: string): DirectLogProof {
  const db = openBuilderDatabase(path);
  const generationIdentity = { runner: [], docker: [] } as { runner: Array<{ generation: number; path: string; startedAt: string }>; docker: Array<{ generation: number; path: string; startedAt: string }> };
  for (const stream of ['runner', 'docker'] as const) generationIdentity[stream] = (db.prepare('SELECT generation, path, started_at AS startedAt FROM job_log_generations WHERE job_id=? AND stream=? ORDER BY generation').all(jobId, stream) as Array<{ generation: number; path: string; startedAt: string }>);
  db.close();
  return { runner: 'sealed', docker: 'sealed', verifiedAt: RECOVERY, generationIdentity };
}
function snapshot(containerState: 'present' | 'absent' = 'present', jobId = 'job-1'): CleanupSnapshot { return {
  runner: { unit: `osi-image-builder-runner@${jobId}.service`, owner: 'runner-a', leaseExpiresAt: ACTIVE, inactiveAt: LATER, observedAt: RECOVERY },
  state: 'starting', container: containerState === 'present' ? { kind: 'present', id: `container-${jobId}`, name: `osi-${jobId}`, imageDigest: SHA64_B, labels: { 'org.osi.image-builder.job-id': jobId, 'org.osi.image-builder.manifest-sha': SHA64 }, globalLabelResult: 'single-exact-match', observedAt: RECOVERY } : absent(RECOVERY), staging, logs, blocker: 'none',
}; }
function postcondition(s: CleanupSnapshot): CleanupPostcondition {
  const sealedLog = (value: 'absent' | 'sealed' | 'unsealed'): 'absent' | 'sealed' => value === 'unsealed' ? 'sealed' : value;
  const postContainer = s.container.kind === 'present' ? { kind: 'removed' as const, id: s.container.id, name: s.container.name, imageDigest: s.container.imageDigest, labels: s.container.labels, exactIdAbsent: true as const, globalLabelResult: 'no-match' as const, stoppedAt: NOW, removedAt: LATER, observedAt: RECOVERY } : { kind: 'null-identity' as const, dockerAction: 'none' as const, globalLabelResult: 'no-match' as const, observedAt: RECOVERY };
  return { ...s, container: postContainer, staging: s.staging.kind === 'absent' ? staging : { kind: 'quarantined', sourcePath: s.staging.path, destinationPath: 'quarantine/image', sourceAbsent: true, destinationPresent: true, sha256: s.staging.sha256, size: s.staging.size, verifiedAt: RECOVERY }, logs: { runner: sealedLog(s.logs.runner), docker: sealedLog(s.logs.docker), verifiedAt: s.logs.verifiedAt }, blocker: 'none' };
}
function nullLeaseSnapshot(jobId = 'job-1'): CleanupSnapshot { return {
  runner: { unit: `osi-image-builder-runner@${jobId}.service`, owner: null, leaseExpiresAt: null, inactiveAt: LATER, observedAt: RECOVERY },
  state: 'starting', container: absent(RECOVERY), staging, logs, blocker: 'none',
}; }
function stagedSnapshot(jobId = 'job-1'): CleanupSnapshot { return {
  runner: { unit: `osi-image-builder-runner@${jobId}.service`, owner: 'runner-a', leaseExpiresAt: ACTIVE, inactiveAt: LATER, observedAt: RECOVERY },
  state: 'starting', container: absent(RECOVERY), staging: { kind: 'present', path: 'staging/image', sha256: SHA64, size: 10 }, logs, blocker: 'staging-or-log',
}; }
function stagedPostcondition(destinationPath = 'quarantine/image', jobId = 'job-1'): CleanupPostcondition { const admission = stagedSnapshot(jobId); return {
  ...admission, container: { kind: 'null-identity', dockerAction: 'none', globalLabelResult: 'no-match', observedAt: RECOVERY }, logs, staging: { kind: 'quarantined', sourcePath: 'staging/image', destinationPath, sourceAbsent: true, destinationPresent: true, sha256: SHA64, size: 10, verifiedAt: RECOVERY }, blocker: 'none',
}; }
function cleanupAdmission(s: CleanupSnapshot, jobId = 'job-1'): Extract<ApiWriteCommand, { kind: 'cleanup-admission' }> { return {
  kind: 'cleanup-admission', jobId, admissionId: 'cln_0123456789abcdefghjkmnpqrs', owner: 'cleanup-a', unitName: 'osi-image-builder-cleanup@cln_0123456789abcdefghjkmnpqrs.service', expiresAt: EXPIRY,
  credentialRelativePath: 'recovery/cleanup-credentials/cln_0123456789abcdefghjkmnpqrs.token', credentialSha256: SHA64, fenceTokenHash: SHA64_B, snapshot: s, at: RECOVERY,
}; }
async function claimedCleanup(jobId = 'job-1'): Promise<{ store: BuilderStore; ownership: OwnershipStore; path: string; admission: Extract<ApiWriteCommand, { kind: 'cleanup-admission' }>; snapshot: CleanupSnapshot; claim: Extract<CleanupWriteCommand, { kind: 'claim-lease' }> }> {
  const result = await fixture(jobId); result.ownership.apiWrite(dispatch(jobId)); result.ownership.runnerWrite(lease(ACTIVE, jobId)); result.ownership.runnerWrite(container(jobId));
  const snapshotValue = snapshot('present', jobId); const admission = cleanupAdmission(snapshotValue, jobId); result.ownership.apiWrite(admission);
  const claim: Extract<CleanupWriteCommand, { kind: 'claim-lease' }> = { kind: 'claim-lease', jobId, admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: snapshotValue, at: RECOVERY };
  result.ownership.cleanupWrite(claim); return { ...result, admission, snapshot: snapshotValue, claim };
}
function failingOwnership(path: string): OwnershipStore {
  const db = openBuilderDatabase(path); const ownership = new OwnershipStore(db, { now: () => NOW, failBeforeCommit: () => { throw new Error('injected rollback'); } }); closers.push(() => db.close()); return ownership;
}
function runnerBase(jobId = 'job-1'): { jobId: string; owner: string; runnerUnit: string; leaseExpiresAt: string; at: string } { return { jobId, owner: 'runner-a', runnerUnit: `osi-image-builder-runner@${jobId}.service`, leaseExpiresAt: ACTIVE, at: LATER }; }
function seedLogs(path: string, jobId: string): void {
  const db = openBuilderDatabase(path);
  for (const stream of ['runner', 'docker']) db.prepare('INSERT INTO job_log_generations (job_id, stream, generation, path, started_at, sealed_at, size_bytes, sha256) VALUES (?, ?, 0, ?, ?, ?, 0, ?)').run(jobId, stream, `logs/${stream}-0.log`, NOW, LATER, SHA64);
  db.close();
}
function seedLogGap(path: string, jobId: string): void {
  const db = openBuilderDatabase(path);
  for (const stream of ['runner', 'docker']) db.prepare('INSERT INTO job_log_generations (job_id, stream, generation, path, started_at, size_bytes) VALUES (?, ?, 0, ?, ?, 1)').run(jobId, stream, `logs/${stream}-0.log`, NOW);
  db.prepare('UPDATE job_log_generations SET sealed_at=?, sha256=? WHERE job_id=?').run(LATER, SHA64, jobId);
  db.close();
}
function seedLogRanges(path: string, jobId: string, ranges: ReadonlyArray<readonly [number, number, 'log' | 'log_orphan_tail']>): void {
  const db = openBuilderDatabase(path);
  const size = Math.max(...ranges.map(([offset, length]) => offset + length));
  for (const stream of ['runner', 'docker']) {
    db.prepare('INSERT INTO job_log_generations (job_id, stream, generation, path, started_at, size_bytes) VALUES (?, ?, 0, ?, ?, ?)').run(jobId, stream, `logs/${stream}-0.log`, NOW, size);
    for (const [offset, length, eventType] of ranges) {
      const row = db.prepare('SELECT state, stage, COALESCE(MAX(seq) + 1, 0) AS seq FROM job_events WHERE job_id=?').get(jobId) as { state: string; stage: string | null; seq: number };
      db.prepare('INSERT INTO job_events (job_id, seq, event_type, state, stage, payload_json, at, stream, file_generation, byte_offset, byte_length, partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0)').run(jobId, row.seq, eventType, row.state, row.stage, '{}', NOW, stream, offset, length);
    }
  }
  db.prepare('UPDATE job_log_generations SET sealed_at=?, sha256=? WHERE job_id=?').run(LATER, SHA64, jobId);
  db.close();
}
function seedLogUncoveredTail(path: string, jobId: string): void {
  const db = openBuilderDatabase(path);
  for (const stream of ['runner', 'docker']) {
    db.prepare('INSERT INTO job_log_generations (job_id, stream, generation, path, started_at, size_bytes) VALUES (?, ?, 0, ?, ?, 10)').run(jobId, stream, `logs/${stream}-0.log`, NOW);
    const row = db.prepare('SELECT state, stage, COALESCE(MAX(seq) + 1, 0) AS seq FROM job_events WHERE job_id=?').get(jobId) as { state: string; stage: string | null; seq: number };
    db.prepare('INSERT INTO job_events (job_id, seq, event_type, state, stage, payload_json, at, stream, file_generation, byte_offset, byte_length, partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0)').run(jobId, row.seq, 'log_orphan_tail', row.state, row.stage, '{}', NOW, stream, 0, 4);
  }
  db.prepare('UPDATE job_log_generations SET sealed_at=?, sha256=? WHERE job_id=?').run(LATER, SHA64, jobId);
  db.close();
}
function seedLogGapEvent(path: string, jobId: string, seal = true): void {
  const db = openBuilderDatabase(path);
  for (const stream of ['runner', 'docker']) {
    db.prepare('INSERT INTO job_log_generations (job_id, stream, generation, path, started_at, size_bytes) VALUES (?, ?, 0, ?, ?, 1)').run(jobId, stream, `logs/${stream}-0.log`, NOW);
    const row = db.prepare('SELECT state, stage, COALESCE(MAX(seq) + 1, 0) AS seq FROM job_events WHERE job_id=?').get(jobId) as { state: string; stage: string | null; seq: number };
    db.prepare('INSERT INTO job_events (job_id, seq, event_type, state, stage, payload_json, at, stream, file_generation, byte_offset, byte_length, partial) VALUES (?, ?, \'log-gap\', ?, ?, \'{}\', ?, ?, 0, 0, 1, 0)').run(jobId, row.seq, row.state, row.stage, NOW, stream);
  }
  if (seal) db.prepare('UPDATE job_log_generations SET sealed_at=?, sha256=? WHERE job_id=?').run(RECOVERY, SHA64, jobId);
  db.close();
}
function seedUnsealedLogs(path: string, jobId: string): void {
  const db = openBuilderDatabase(path);
  for (const stream of ['runner', 'docker']) db.prepare('INSERT INTO job_log_generations (job_id, stream, generation, path, started_at, size_bytes) VALUES (?, ?, 0, ?, ?, 0)').run(jobId, stream, `logs/${stream}-0.log`, NOW);
  db.close();
}
function toVerifying(ownership: OwnershipStore, jobId: string): void {
  ownership.apiWrite(dispatch(jobId)); ownership.runnerWrite(lease(ACTIVE, jobId));
  const stages: Array<[PipelineStageName, JobState, JobState]> = [['preflight', 'starting', 'preflight'], ['source', 'preflight', 'source'], ['release-gates', 'source', 'release_gates'], ['frontend', 'release_gates', 'frontend'], ['target-setup', 'frontend', 'target_setup'], ['feeds', 'target_setup', 'feeds'], ['config', 'feeds', 'config'], ['build', 'config', 'building'], ['verify', 'building', 'verifying']];
  for (const [name, from, to] of stages) ownership.runnerWrite({ ...runnerBase(jobId), kind: 'stage', expectedState: from, state: to, stage: name, outcome: 'passed', startedAt: NOW, finishedAt: NOW, evidencePath: `evidence/${name}`, evidenceSha256: SHA64 });
  ownership.runnerWrite({ ...runnerBase(jobId), kind: 'artifact', expectedState: 'verifying', state: 'verifying', stagingPath: 'staging/image', artifactSha256: SHA64, artifactSize: 10, artifactMtime: NOW, checksumPath: 'staging/sums', checksumSha256: checksumHash(), manifestPath: 'staging/manifest', manifestSha256: manifestHash(jobId), verificationPath: 'staging/verify', verificationSha256: verificationHash(jobId) });
}
function toPublishing(ownership: OwnershipStore, jobId: string): void {
  toVerifying(ownership, jobId);
  ownership.runnerWrite({ ...runnerBase(jobId), kind: 'publish', expectedState: 'verifying', state: 'publishing', finalDirectory: `release/${jobId}`, finalPath: `release/${jobId}/image`, startedAt: NOW });
}
function recoveryEvidence(jobId: string, terminalState: 'succeeded' | 'failed' = 'succeeded'): PublishRecoveryEvidence {
  const manifestContent = { artifactSha256: SHA64, branch: 'main', jobId, pinnedSha: SHA40, targetId: 'rpi-5' };
  const manifestSha256 = manifestHash(jobId);
  const verificationContent = { artifactSha256: SHA64, branch: 'main', jobId, pinnedSha: SHA40, targetId: 'rpi-5' };
  const verificationSha256 = verificationHash(jobId);
  const success = terminalState === 'succeeded';
  return {
  runner: { unit: `osi-image-builder-runner@${jobId}.service`, owner: 'runner-a', leaseExpiresAt: ACTIVE, inactiveAt: LATER, observedAt: RECOVERY }, container: absent(RECOVERY),
  artifact: { stagingPath: 'staging/image', artifactSha256: SHA64, artifactSize: 10, artifactMtime: NOW, checksumPath: 'staging/sums', checksumSha256: checksumHash(), manifestPath: 'staging/manifest', manifestSha256, verificationPath: 'staging/verify', verificationSha256 },
  final: { directory: `release/${jobId}`, path: `release/${jobId}/image`, publishStartedAt: NOW, publishedAt: null },
  observed: { final: success ? { present: true, path: `release/${jobId}/image`, held: true, size: 10, sha256: SHA64 } : { present: false, path: `release/${jobId}/image`, held: false, size: null, sha256: null }, checksum: { present: true, path: success ? `release/${jobId}/sha256sums` : 'staging/sums', contents: CHECKSUM_CONTENT, sha256: checksumHash() }, manifest: { present: true, path: success ? `release/${jobId}/build-manifest.json` : 'staging/manifest', bytes: canonicalJson(manifestContent), content: manifestContent, sha256: manifestSha256 }, verification: { present: true, path: success ? `release/${jobId}/verification.json` : 'staging/verify', bytes: canonicalJson(verificationContent), content: verificationContent, sha256: verificationSha256 }, staging: success ? { state: 'absent', path: null, sha256: null } : { state: 'present', path: 'staging/image', sha256: SHA64 }, logs: { runner: 'sealed', docker: 'sealed', verifiedAt: RECOVERY, noGap: true } },
  }; }

afterEach(async () => { for (const close of closers.splice(0)) close(); await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('actor-owned compare-and-set writes', () => {
  it('has no public actor mutation escape hatch and rejects cross-actor families', async () => {
    const { ownership, store } = await fixture();
    const protectedStore: BuilderStore = store; expect(protectedStore.getJob('job-1').state).toBe('queued');
    for (const kind of ['container', 'stage', 'terminal', 'artifact', 'publish', 'runner-lease'] as const) expect(() => ownership.apiWrite({ kind, jobId: 'job-1' } as never)).toThrow(OwnershipViolationError);
    for (const kind of ['dispatch', 'request-cancellation', 'cleanup-admission', 'recovery-terminal'] as const) expect(() => ownership.runnerWrite({ kind, jobId: 'job-1' } as never)).toThrow(OwnershipViolationError);
    for (const kind of ['stage', 'terminal', 'publish', 'artifact'] as const) expect(() => ownership.cleanupWrite({ kind, jobId: 'job-1' } as never)).toThrow(OwnershipViolationError);
    const hidden = ['dispatch', 'stage', 'container', 'publishRecovery', 'transaction', 'job', 'event', 'normalTerminal'];
    for (const name of hidden) {
      expect(Object.prototype.hasOwnProperty.call(OwnershipStore.prototype, name), `OwnershipStore prototype owns ${name}`).toBe(false);
      expect(name in ownership, `OwnershipStore instance exposes ${name}`).toBe(false);
      expect(typeof (ownership as unknown as Record<string, unknown>)[name]).not.toBe('function');
    }
    expect(Object.getOwnPropertyNames(OwnershipStore.prototype)).toEqual(expect.arrayContaining(['constructor', 'apiWrite', 'runnerWrite', 'cleanupWrite']));
    expect(Object.getOwnPropertyNames(OwnershipStore.prototype).filter((name) => !['constructor', 'apiWrite', 'runnerWrite', 'cleanupWrite'].includes(name))).toEqual([]);
  });

  it('prevalidates hostile and oversized commands before attempting BEGIN', async () => {
    const { ownership, store, db } = await fixture('prevalidation'); let beginAttempts = 0;
    const guarded = new OwnershipStore(db, { now: () => NOW, beforeBegin: () => { beginAttempts += 1; } }); const events = store.listEvents('prevalidation').events.length;
    const oversized = { kind: 'dispatch' as const, jobId: 'x'.repeat(100_000), runnerUnit: 'osi-image-builder-runner@prevalidation.service', at: NOW };
    expect(() => guarded.apiWrite(oversized)).toThrow(OwnershipValidationError);
    const getter = { kind: 'dispatch' as const, runnerUnit: 'osi-image-builder-runner@prevalidation.service', at: NOW } as Record<string, unknown>;
    Object.defineProperty(getter, 'jobId', { enumerable: true, get: () => { throw Object.assign(new Error('spoofed busy'), { code: 'SQLITE_BUSY' }); } });
    expect(() => guarded.apiWrite(getter as never)).toThrow(OwnershipValidationError);
    const huge = 'x'.repeat(100_000);
    expect(() => guarded.apiWrite({ kind: 'freshness-result', jobId: 'prevalidation', at: NOW, input: { status: 'unknown', pinnedSha: SHA40, observedSha: null, checkedAt: NOW, error: { reason: 'unknown' }, errorEvidencePath: huge, errorEvidenceSha256: SHA64 } } as never)).toThrow(OwnershipValidationError);
    expect(() => guarded.cleanupWrite({ kind: 'complete', jobId: 'prevalidation', evidencePath: huge } as never)).toThrow(OwnershipValidationError);
    expect(() => guarded.runnerWrite({ kind: 'operation-complete', jobId: 'prevalidation', input: { evidencePath: huge } } as never)).toThrow(OwnershipValidationError);
    expect(beginAttempts).toBe(0); expect(store.listEvents('prevalidation').events).toHaveLength(events);
  });

  it('rejects malformed command shape and aggregate payloads before the writer lock', async () => {
    const { ownership, store, db } = await fixture('aggregate-validation'); let beginAttempts = 0;
    const guarded = new OwnershipStore(db, { now: () => NOW, beforeBegin: () => { beginAttempts += 1; } });
    const before = store.listEvents('aggregate-validation').events.length;
    expect(() => guarded.apiWrite({ kind: 'dispatch', runnerUnit: 'osi-image-builder-runner@aggregate-validation.service', at: NOW } as never)).toThrow(OwnershipValidationError);
    const input = { jobId: 'aggregate-validation-2', requestId: 'aggregate-validation-2', request: { first: 'x'.repeat(40_000), second: 'y'.repeat(40_000) }, sourceRemote: 'git@example.com:osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main', expectedSha: SHA40, pinnedSha: SHA40, sourcePreparation: SOURCE_PREPARATION, targetId: 'rpi-5' as const, rootId: 'release', targetManifestSha256: SHA64, sourceCommitTime: NOW, sourceAuthor: 'Phil', sourceSubject: 'aggregate', acceptedAt: NOW };
    expect(() => guarded.apiWrite({ kind: 'enqueue', input })).toThrow(OwnershipValidationError);
    expect(beginAttempts).toBe(0); expect(store.listEvents('aggregate-validation').events).toHaveLength(before);
  });

  it('does not apply command semantics to arbitrary nested request JSON', async () => {
    const { ownership, store } = await fixture('json-semantic-isolation');
    const input = { jobId: 'json-semantic-isolation-2', requestId: 'json-semantic-isolation-2', request: { lastSeenAt: 'yesterday', artifactPath: 'free text' }, sourceRemote: 'git@example.com:osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main', expectedSha: SHA40, pinnedSha: SHA40, sourcePreparation: SOURCE_PREPARATION, targetId: 'rpi-5' as const, rootId: 'release', targetManifestSha256: SHA64, sourceCommitTime: NOW, sourceAuthor: 'Phil', sourceSubject: 'json', acceptedAt: NOW };
    expect(ownership.apiWrite({ kind: 'enqueue', input }).ok).toBe(true);
    expect(store.getJob('json-semantic-isolation-2').request).toEqual({ lastSeenAt: 'yesterday', artifactPath: 'free text' });
  });

  it('does not classify spoofed hook errors as SQLite conflicts', async () => {
    const { db, store } = await fixture('hook-error-trust');
    const spoof = () => { throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_BUSY', errcode: 5 }); };
    const beforeBegin = new OwnershipStore(db, { now: () => NOW, beforeBegin: spoof });
    expect(() => beforeBegin.apiWrite({ kind: 'request-cancellation', jobId: 'hook-error-trust', reason: 'test', at: NOW })).toThrow(OwnershipTransactionError);
    const beforeEvent = new OwnershipStore(db, { now: () => NOW, beforeEvent: spoof });
    expect(() => beforeEvent.apiWrite({ kind: 'request-cancellation', jobId: 'hook-error-trust', reason: 'test', at: NOW })).toThrow(OwnershipTransactionError);
    expect(store.getJob('hook-error-trust').cancelRequestedAt).toBeNull(); expect(store.listEvents('hook-error-trust').events).toHaveLength(1);
  });

  it('rejects canonical but backward timestamps across command families without events', async () => {
    const { ownership, store } = await fixture('chronology'); const before = store.listEvents('chronology').events.length;
    expect(() => ownership.apiWrite({ kind: 'request-cancellation', jobId: 'chronology', reason: 'early', at: BEFORE })).toThrow(OwnershipValidationError);
    ownership.apiWrite(dispatch('chronology')); ownership.runnerWrite(lease(ACTIVE, 'chronology'));
    expect(ownership.runnerWrite({ ...runnerBase('chronology'), kind: 'renew-lease', expectedExpiresAt: ACTIVE, expiresAt: NOW, at: NOW })).toMatchObject({ ok: false, conflict: { kind: 'stale-lease' } });
    expect(() => ownership.runnerWrite({ ...runnerBase('chronology'), kind: 'stage', expectedState: 'starting', state: 'preflight', stage: 'preflight', outcome: 'running', startedAt: BEFORE })).toThrow(OwnershipValidationError);
    expect(() => ownership.runnerWrite({ ...runnerBase('chronology'), kind: 'container', lifecycle: 'created', containerId: 'chronology-container', containerName: 'osi-chronology', imageDigest: SHA64_B, labels: { 'org.osi.image-builder.job-id': 'chronology', 'org.osi.image-builder.manifest-sha': SHA64 }, mount: { source: '/tmp', destination: '/work' }, environment: {}, security: {}, inspection: {}, occurredAt: NOW, createdAt: NOW, startedAt: BEFORE })).toThrow(OwnershipValidationError);
    expect(store.listEvents('chronology').events.length).toBeGreaterThan(before); expect(store.listEvents('chronology').events.filter((event) => event.eventType === 'stage' || event.eventType === 'container' || event.eventType === 'cleanup')).toHaveLength(0);
  });

  it('accepts delayed observations before the write and rejects future or backward facts', async () => {
    const stageCase = await fixture('delayed-stage'); stageCase.ownership.apiWrite(dispatch('delayed-stage')); stageCase.ownership.runnerWrite(lease(ACTIVE, 'delayed-stage'));
    expect(stageCase.ownership.runnerWrite({ ...runnerBase('delayed-stage'), kind: 'stage', expectedState: 'starting', state: 'preflight', stage: 'preflight', outcome: 'passed', startedAt: NOW, finishedAt: LATER, evidencePath: 'evidence/preflight', evidenceSha256: SHA64 }).ok).toBe(true);
    expect(() => stageCase.ownership.runnerWrite({ ...runnerBase('delayed-stage'), kind: 'stage', expectedState: 'preflight', state: 'source', stage: 'source', outcome: 'running', startedAt: RECOVERY })).toThrow(OwnershipValidationError);
    expect(() => stageCase.ownership.runnerWrite({ ...runnerBase('delayed-stage'), at: RECOVERY, kind: 'stage', expectedState: 'preflight', state: 'source', stage: 'source', outcome: 'passed', startedAt: LATER, finishedAt: NOW, evidencePath: 'evidence/source', evidenceSha256: SHA64 })).toThrow(OwnershipValidationError);

    const operationCase = await fixture('delayed-operation'); operationCase.ownership.apiWrite(dispatch('delayed-operation')); operationCase.ownership.runnerWrite(lease(ACTIVE, 'delayed-operation'));
    expect(operationCase.ownership.runnerWrite({ ...runnerBase('delayed-operation'), kind: 'operation-begin', expectedState: 'starting', operationId: 'activate-target', attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW }).ok).toBe(true);
    const operationInput = { operationId: 'activate-target' as const, attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW, finishedAt: LATER, timedOut: false, lifecyclePhase: 'not_created' as const, containerMount: null, containerEnvironment: null, containerSecurity: null, inspection: null, exitCode: 1, signal: null, outcome: 'failed' as const, evidencePath: 'evidence/op', evidenceSha256: SHA64, errorCode: 'BUILD_FAILED' as const, error: { reason: 'delayed' } };
    expect(operationCase.ownership.runnerWrite({ ...runnerBase('delayed-operation'), kind: 'operation-complete', expectedState: 'starting', operationId: 'activate-target', attempt: 1, input: operationInput }).ok).toBe(true);
    expect(() => operationCase.ownership.runnerWrite({ ...runnerBase('delayed-operation'), at: LATER, kind: 'operation-complete', expectedState: 'starting', operationId: 'activate-target', attempt: 1, input: { ...operationInput, finishedAt: RECOVERY } })).toThrow(OwnershipValidationError);

    const terminalCase = await fixture('delayed-terminal'); terminalCase.ownership.apiWrite(dispatch('delayed-terminal')); terminalCase.ownership.runnerWrite(lease(ACTIVE, 'delayed-terminal'));
    terminalCase.ownership.runnerWrite({ ...runnerBase('delayed-terminal'), kind: 'stage', expectedState: 'starting', state: 'preflight', stage: 'preflight', outcome: 'running', startedAt: NOW });
    expect(terminalCase.ownership.runnerWrite({ ...runnerBase('delayed-terminal'), kind: 'normal-terminal', expectedState: 'preflight', state: 'failed', terminalAt: LATER, errorCode: 'BUILD_FAILED', error: { reason: 'delayed' } }).ok).toBe(true);
    expect(() => terminalCase.ownership.runnerWrite({ ...runnerBase('delayed-terminal'), at: LATER, kind: 'normal-terminal', expectedState: 'preflight', state: 'failed', terminalAt: RECOVERY, errorCode: 'BUILD_FAILED', error: { reason: 'future' } })).toThrow(OwnershipValidationError);
  });

  it('rejects incomplete nested proof variants before BEGIN for every actor family', async () => {
    const { db } = await fixture('nested-proof-prevalidation'); let beginAttempts = 0;
    const guarded = new OwnershipStore(db, { now: () => NOW, beforeBegin: () => { beginAttempts += 1; } });
    const calls: Array<() => unknown> = [
      () => guarded.apiWrite({ kind: 'direct-interrupt', jobId: 'nested-proof-prevalidation', expectedState: 'starting', at: NOW, proof: {}, errorCode: 'BUILD_FAILED', error: {} } as never),
      () => guarded.apiWrite({ kind: 'publish-recovery', jobId: 'nested-proof-prevalidation', expectedState: 'publishing', at: NOW, state: 'failed', evidence: {}, errorCode: 'PUBLISH_FAILED', error: {} } as never),
      () => guarded.apiWrite({ kind: 'cleanup-admission', jobId: 'nested-proof-prevalidation', admissionId: 'cln_0123456789abcdefghjkmnpqrs', owner: 'cleanup-a', unitName: 'osi-image-builder-cleanup@cln_0123456789abcdefghjkmnpqrs.service', expiresAt: LATER, credentialRelativePath: 'recovery/token', credentialSha256: SHA64, fenceTokenHash: SHA64_B, snapshot: {} } as never),
      () => guarded.runnerWrite({ ...runnerBase('nested-proof-prevalidation'), kind: 'cancellation-cleanup', expectedState: 'cancel_requested', proof: {} } as never),
      () => guarded.cleanupWrite({ kind: 'complete', jobId: 'nested-proof-prevalidation', admissionId: 'cln_0123456789abcdefghjkmnpqrs', owner: 'cleanup-a', unitName: 'osi-image-builder-cleanup@cln_0123456789abcdefghjkmnpqrs.service', fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: {}, postcondition: {}, containerAbsent: true, exactContainerId: null, evidencePath: 'recovery/evidence', evidenceSha256: SHA64, at: NOW } as never),
    ];
    for (const call of calls) expect(call).toThrow(OwnershipValidationError);
    expect(beginAttempts).toBe(0);
  });

  it('confines every typed evidence path before the writer lock', async () => {
    const { db } = await fixture('path-prevalidation'); let beginAttempts = 0;
    const guarded = new OwnershipStore(db, { now: () => NOW, beforeBegin: () => { beginAttempts += 1; } });
    const invalidPaths: Array<() => unknown> = [
      () => guarded.apiWrite({ kind: 'freshness-result', jobId: 'path-prevalidation', at: NOW, input: { status: 'unknown', pinnedSha: SHA40, observedSha: null, checkedAt: NOW, error: { reason: 'unknown' }, errorEvidencePath: '../outside', errorEvidenceSha256: SHA64 } } as never),
      () => guarded.runnerWrite({ ...runnerBase('path-prevalidation'), kind: 'stage', expectedState: 'starting', state: 'preflight', stage: 'preflight', outcome: 'passed', startedAt: NOW, finishedAt: NOW, evidencePath: '/outside', evidenceSha256: SHA64 }),
      () => guarded.runnerWrite({ ...runnerBase('path-prevalidation'), kind: 'operation-complete', expectedState: 'starting', operationId: 'activate-target', attempt: 1, input: { operationId: 'activate-target', attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW, finishedAt: NOW, lifecyclePhase: 'not_created', timedOut: false, exitCode: 1, signal: null, outcome: 'failed', evidencePath: '../outside', evidenceSha256: SHA64, errorCode: 'BUILD_FAILED', error: {} } } as never),
      () => guarded.apiWrite({ kind: 'cleanup-admission', jobId: 'path-prevalidation', admissionId: 'cln_0123456789abcdefghjkmnpqrs', owner: 'cleanup-a', unitName: 'osi-image-builder-cleanup@cln_0123456789abcdefghjkmnpqrs.service', expiresAt: LATER, credentialRelativePath: 'a//b', credentialSha256: SHA64, fenceTokenHash: SHA64_B, snapshot: {} } as never),
    ];
    for (const call of invalidPaths) expect(call).toThrow(OwnershipValidationError);
    expect(beginAttempts).toBe(0);
  });

  it('wraps hostile JSON accessors as validation errors and keeps the shared normalizer safe', async () => {
    const getter = {}; Object.defineProperty(getter, 'secret', { enumerable: true, get: () => { throw new Error('getter executed'); } });
    expect(() => normalizeJson(getter, 'hostile JSON')).toThrow(SharedValidationError);
    const proxy = new Proxy({}, { ownKeys: () => { throw Object.assign(new Error('proxy trap'), { code: 'SQLITE_BUSY' }); } });
    expect(() => normalizeJson(proxy, 'hostile proxy')).toThrow(SharedValidationError);
  });

  it('routes enqueue and dispatch through API CAS and preserves the event transaction', async () => {
    const { ownership, store } = await fixture();
    expect(ownership.apiWrite(dispatch())).toMatchObject({ ok: true, kind: 'committed' });
    expect(ownership.apiWrite(dispatch()).ok).toBe(false); expect(eventCount(store)).toBe(2);
  });

  it('enforces FIFO dispatch atomically', async () => {
    const { ownership, store } = await fixture();
    expect(ownership.apiWrite({ kind: 'enqueue', input: {
      jobId: 'job-2', requestId: 'request-job-2', request: { branch: 'main', target: 'rpi-5' },
      sourceRemote: 'git@example.com:osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main',
      expectedSha: SHA40, pinnedSha: SHA40, sourcePreparation: SOURCE_PREPARATION, targetId: 'rpi-5', rootId: 'release', targetManifestSha256: SHA64,
      sourceCommitTime: NOW, sourceAuthor: 'Phil', sourceSubject: 'build', acceptedAt: NOW,
    } }).ok).toBe(true);
    expect(ownership.apiWrite(dispatch('job-2'))).toMatchObject({ ok: false, conflict: { kind: 'stale-predecessor' } });
    expect(store.getJob('job-2').state).toBe('queued');
    expect(ownership.apiWrite(dispatch('job-1')).ok).toBe(true);
    expect(ownership.apiWrite(dispatch('job-2')).ok).toBe(true);
  });

  it('returns a stable queue-full conflict before insert at the configured bound', async () => {
    const { ownership, store } = await fixture('queue-limit');
    for (let index = 0; index < 49; index += 1) {
      const jobId = `queue-${index}`;
      expect(ownership.apiWrite({ kind: 'enqueue', input: {
        jobId, requestId: jobId, request: { branch: 'main' }, sourceRemote: 'git@example.com:osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main', expectedSha: SHA40, pinnedSha: SHA40, sourcePreparation: SOURCE_PREPARATION, targetId: 'rpi-5', rootId: 'release', targetManifestSha256: SHA64, sourceCommitTime: NOW, sourceAuthor: 'Phil', sourceSubject: 'queue', acceptedAt: NOW,
      } }).ok).toBe(true);
    }
    const events = store.listEvents('queue-48').events.length;
    expect(ownership.apiWrite({ kind: 'enqueue', input: { jobId: 'queue-overflow', requestId: 'queue-overflow', request: { branch: 'main' }, sourceRemote: 'git@example.com:osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main', expectedSha: SHA40, pinnedSha: SHA40, sourcePreparation: SOURCE_PREPARATION, targetId: 'rpi-5', rootId: 'release', targetManifestSha256: SHA64, sourceCommitTime: NOW, sourceAuthor: 'Phil', sourceSubject: 'queue', acceptedAt: NOW } })).toMatchObject({ ok: false, conflict: { kind: 'queue-full' } });
    expect(store.listEvents('queue-48').events).toHaveLength(events); expect(() => store.getJob('queue-overflow')).toThrow();
  });

  it('records an API-owned freshness result atomically and makes retries deterministic', async () => {
    const { ownership, store } = await fixture();
    expect(ownership.apiWrite({ kind: 'freshness-request', jobId: 'job-1', at: NOW }).ok).toBe(true);
    const result: ApiWriteCommand = { kind: 'freshness-result', jobId: 'job-1', at: LATER, input: { status: 'fresh', pinnedSha: SHA40, observedSha: SHA40, checkedAt: LATER } };
    expect(ownership.apiWrite(result)).toMatchObject({ ok: true, kind: 'committed' });
    const events = eventCount(store);
    expect(ownership.apiWrite(result)).toMatchObject({ ok: true, kind: 'idempotent' });
    expect(eventCount(store)).toBe(events);
    expect(ownership.apiWrite({ ...result, input: { ...result.input, checkedAt: RECOVERY } })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
  });

  it('requires exact runner identity, predecessor, lease and fence for normal writes', async () => {
    const { ownership, store } = await fixture(); ownership.apiWrite(dispatch()); ownership.runnerWrite(lease());
    const stage = (expectedState: JobState, state: JobState, stageName: PipelineStageName, outcome: 'running' | 'passed'): RunnerWriteCommand => ({
      ...runnerBase(), kind: 'stage', expectedState, state, stage: stageName, outcome, startedAt: NOW,
      ...(outcome === 'passed' ? { finishedAt: NOW, evidencePath: `evidence/${stageName}`, evidenceSha256: SHA64 } : {}),
    });
    expect(ownership.runnerWrite({ ...stage('starting', 'preflight', 'preflight', 'running'), owner: 'runner-b' }).ok).toBe(false);
    expect(ownership.runnerWrite(stage('starting', 'preflight', 'preflight', 'running')).ok).toBe(true);
    const states: Array<[PipelineStageName, JobState, JobState]> = [['source', 'preflight', 'source'], ['release-gates', 'source', 'release_gates'], ['frontend', 'release_gates', 'frontend'], ['target-setup', 'frontend', 'target_setup'], ['feeds', 'target_setup', 'feeds'], ['config', 'feeds', 'config'], ['build', 'config', 'building'], ['verify', 'building', 'verifying']];
    for (const [name, from, to] of states) expect(ownership.runnerWrite(stage(from, to, name, 'passed')).ok).toBe(true);
    expect(store.getJob('job-1').state).toBe('verifying');
  });

  it('uses typed direct interruption proofs for pre-lease and stale active failure only', async () => {
    const first = await fixture(); first.ownership.apiWrite(dispatch());
    expect(first.ownership.apiWrite({ kind: 'direct-interrupt', jobId: 'job-1', expectedState: 'starting', at: RECOVERY, proof: { ...direct('start-failure'), logs: { ...logs, docker: 'sealed' } as never }, errorCode: 'RUNNER_DISAPPEARED', error: { reason: 'start failed' } })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
    expect(first.ownership.apiWrite({ kind: 'direct-interrupt', jobId: 'job-1', expectedState: 'starting', at: RECOVERY, proof: direct('start-failure'), errorCode: 'RUNNER_DISAPPEARED', error: { reason: 'start failed' } }).ok).toBe(true);
    const second = await fixture('job-2'); second.ownership.apiWrite(dispatch('job-2')); second.ownership.runnerWrite(lease(ACTIVE, 'job-2'));
    expect(second.ownership.apiWrite({ kind: 'direct-interrupt', jobId: 'job-2', expectedState: 'starting', at: RECOVERY, proof: direct('active', 'job-2'), errorCode: 'RUNNER_DISAPPEARED', error: { reason: 'stale' } }).ok).toBe(true);
    expect(second.ownership.apiWrite({ kind: 'direct-interrupt', jobId: 'job-2', expectedState: 'publishing', at: RECOVERY, proof: direct('active', 'job-2'), errorCode: 'RUNNER_DISAPPEARED', error: { reason: 'bad' } } as never)).toMatchObject({ ok: false, conflict: { kind: 'illegal-predecessor' } });
  });

  it('reconciles direct interruption logs in the same transaction', async () => {
    const unsealed = await fixture('direct-unsealed'); unsealed.ownership.apiWrite(dispatch('direct-unsealed')); seedUnsealedLogs(unsealed.path, 'direct-unsealed');
    expect(unsealed.ownership.apiWrite({ kind: 'direct-interrupt', jobId: 'direct-unsealed', expectedState: 'starting', at: RECOVERY, proof: direct('start-failure', 'direct-unsealed'), errorCode: 'RUNNER_DISAPPEARED', error: { reason: 'unsealed logs' } })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
    expect(unsealed.store.getJob('direct-unsealed').state).toBe('starting');

    const sealed = await fixture('direct-sealed'); sealed.ownership.apiWrite(dispatch('direct-sealed')); seedLogs(sealed.path, 'direct-sealed');
    const sealedResult = sealed.ownership.apiWrite({ kind: 'direct-interrupt', jobId: 'direct-sealed', expectedState: 'starting', at: RECOVERY, proof: directWithLogs('start-failure', 'direct-sealed', sealedDirectLogs(sealed.path, 'direct-sealed')), errorCode: 'RUNNER_DISAPPEARED', error: { reason: 'sealed logs' } }); expect(sealedResult.ok).toBe(true);

    const gap = await fixture('direct-gap'); gap.ownership.apiWrite(dispatch('direct-gap')); seedLogGapEvent(gap.path, 'direct-gap');
    expect(gap.ownership.apiWrite({ kind: 'direct-interrupt', jobId: 'direct-gap', expectedState: 'starting', at: RECOVERY, proof: directWithLogs('start-failure', 'direct-gap', sealedDirectLogs(gap.path, 'direct-gap')), errorCode: 'RUNNER_DISAPPEARED', error: { reason: 'log gap' } })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });

    const orphan = await fixture('direct-orphan'); orphan.ownership.apiWrite(dispatch('direct-orphan')); seedLogRanges(orphan.path, 'direct-orphan', [[0, 1, 'log_orphan_tail']]);
    expect(orphan.ownership.apiWrite({ kind: 'direct-interrupt', jobId: 'direct-orphan', expectedState: 'starting', at: RECOVERY, proof: directWithLogs('start-failure', 'direct-orphan', sealedDirectLogs(orphan.path, 'direct-orphan')), errorCode: 'RUNNER_DISAPPEARED', error: { reason: 'contiguous recovered tail' } }).ok).toBe(true);
  });

  it('accepts only canonical real instants and bounded JSON values', async () => {
    const { ownership } = await fixture('validation');
    const base = { jobId: 'bad-date', requestId: 'bad-date', request: { branch: 'main' }, sourceRemote: 'git@example.com:osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main', expectedSha: SHA40, pinnedSha: SHA40, sourcePreparation: SOURCE_PREPARATION, targetId: 'rpi-5' as const, rootId: 'release', targetManifestSha256: SHA64, sourceCommitTime: '2026-02-30T10:00:00.000Z', sourceAuthor: 'Phil', sourceSubject: 'date', acceptedAt: NOW };
    expect(() => ownership.apiWrite({ kind: 'enqueue', input: base })).toThrow(OwnershipValidationError);
    expect(() => ownership.apiWrite({ kind: 'enqueue', input: { ...base, jobId: 'bad-offset', requestId: 'bad-offset', sourceCommitTime: '2026-07-23T10:00:00+00:00' } })).toThrow(OwnershipValidationError);
    expect(() => encodeJson(['x'.repeat(100_004)], 'root array')).toThrow();
    const source = JSON.parse('{"__proto__":{"retained":true},"constructor":"kept","prototype":"also"}') as object;
    const normalized = normalizeJson(source, 'prototype test') as Record<string, unknown>;
    expect(Object.getPrototypeOf(normalized)).toBeNull(); expect(Object.keys(normalized)).toEqual(['__proto__', 'constructor', 'prototype']); expect(({} as Record<string, unknown>).retained).toBeUndefined();
    const shared = { value: 'shared' }; expect(() => encodeJson({ left: shared, right: shared }, 'DAG')).not.toThrow();
  });

  it('separates malformed validation, stale CAS, and unknown SQLite faults', async () => {
    const malformed = await fixture('malformed-target');
    expect(() => malformed.ownership.apiWrite({ kind: 'enqueue', input: { jobId: 'bad-target', requestId: 'bad-target', request: {}, sourceRemote: 'git@example.com:osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main', expectedSha: SHA40, pinnedSha: SHA40, sourcePreparation: SOURCE_PREPARATION, targetId: 'invalid' as never, rootId: 'release', targetManifestSha256: SHA64, sourceCommitTime: NOW, sourceAuthor: 'Phil', sourceSubject: 'bad', acceptedAt: NOW } })).toThrow(OwnershipValidationError);
    expect(malformed.ownership.apiWrite(dispatch('missing-job'))).toMatchObject({ ok: false, conflict: { kind: 'stale-predecessor' } });
    malformed.db.exec("CREATE TRIGGER unknown_check BEFORE INSERT ON jobs WHEN NEW.job_id='unknown-check' BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: injected'); END");
    const input = { jobId: 'unknown-check', requestId: 'unknown-check', request: {}, sourceRemote: 'git@example.com:osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main', expectedSha: SHA40, pinnedSha: SHA40, sourcePreparation: SOURCE_PREPARATION, targetId: 'rpi-5' as const, rootId: 'release', targetManifestSha256: SHA64, sourceCommitTime: NOW, sourceAuthor: 'Phil', sourceSubject: 'check', acceptedAt: NOW };
    expect(() => malformed.ownership.apiWrite({ kind: 'enqueue', input })).toThrow(OwnershipTransactionError);
    expect(malformed.store.listEvents('malformed-target').events).toHaveLength(1);
  });

  it('requires the runner cancellation protocol for both container paths', async () => {
    const pre = await fixture(); pre.ownership.apiWrite(dispatch()); pre.ownership.runnerWrite(lease(EXPIRY)); pre.ownership.apiWrite({ kind: 'request-cancellation', jobId: 'job-1', reason: 'stop', at: NOW }); pre.ownership.runnerWrite({ ...runnerBase(), leaseExpiresAt: EXPIRY, kind: 'cancellation-transition', expectedState: 'starting' });
    expect(pre.ownership.runnerWrite({ ...runnerBase(), kind: 'normal-terminal', expectedState: 'cancel_requested', state: 'failed', terminalAt: LATER, errorCode: 'CANCELLED', error: { reason: 'bad bypass' } } as never)).toMatchObject({ ok: false });
    const preCleanup = pre.ownership.runnerWrite({ ...runnerBase(), at: LATER, leaseExpiresAt: EXPIRY, kind: 'cancellation-cleanup', expectedState: 'cancel_requested', proof: { kind: 'pre-container', runnerUnit: runnerBase().runnerUnit, unitInactiveAt: LATER, container: absent(), staging, logs } }); expect(preCleanup.ok).toBe(true);
    expect(pre.ownership.runnerWrite({ ...runnerBase(), at: LATER, leaseExpiresAt: EXPIRY, kind: 'cancellation-cleanup', expectedState: 'cancel_requested', proof: { kind: 'pre-container', runnerUnit: runnerBase().runnerUnit, unitInactiveAt: LATER, container: absent(), staging: { kind: 'quarantined', sourcePath: 'staging/image', destinationPath: 'quarantine/image', sourceAbsent: true, destinationPresent: true, sha256: SHA64, size: 10, verifiedAt: LATER }, logs } })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
    expect(pre.store.getJob('job-1').state).toBe('cancel_requested');
    const recoveredDb = openBuilderDatabase(pre.path); const recovered = new OwnershipStore(recoveredDb); closers.push(() => recoveredDb.close());
    expect(recovered.runnerWrite({ ...runnerBase(), at: LATER, leaseExpiresAt: EXPIRY, kind: 'cancellation-terminal', expectedState: 'cancel_requested', terminalAt: LATER, cleanupEventSeq: eventSeq(preCleanup) }).ok).toBe(true);
    const withContainer = await fixture('job-2'); withContainer.ownership.apiWrite(dispatch('job-2')); withContainer.ownership.runnerWrite(lease(EXPIRY, 'job-2')); withContainer.ownership.runnerWrite({ ...container('job-2'), leaseExpiresAt: EXPIRY, at: NOW }); withContainer.ownership.apiWrite({ kind: 'request-cancellation', jobId: 'job-2', reason: 'stop', at: NOW }); withContainer.ownership.runnerWrite({ ...runnerBase('job-2'), leaseExpiresAt: EXPIRY, kind: 'cancellation-transition', expectedState: 'starting' });
    const proof = { kind: 'container' as const, runnerUnit: runnerBase('job-2').runnerUnit, unitInactiveAt: RECOVERY, container: { kind: 'removed' as const, id: 'container-job-2', name: 'osi-job-2', imageDigest: SHA64_B, labels: { 'org.osi.image-builder.job-id': 'job-2', 'org.osi.image-builder.manifest-sha': SHA64 }, stoppedAt: LATER, removedAt: LATER, globalLabelResult: 'no-match' as const, observedAt: RECOVERY }, staging, logs };
    const containerCleanup = withContainer.ownership.runnerWrite({ ...runnerBase('job-2'), at: RECOVERY, leaseExpiresAt: EXPIRY, kind: 'cancellation-cleanup', expectedState: 'cancel_requested', proof });
    expect(containerCleanup.ok).toBe(true);
    expect(withContainer.ownership.runnerWrite({ ...runnerBase('job-2'), at: RECOVERY, leaseExpiresAt: EXPIRY, kind: 'cancellation-terminal', expectedState: 'cancel_requested', terminalAt: RECOVERY, cleanupEventSeq: eventSeq(containerCleanup) }).ok).toBe(true);
  });

  it('persists a distinct staging-to-quarantine move before cancellation terminal', async () => {
    const { ownership, store } = await fixture();
    ownership.apiWrite(dispatch()); ownership.runnerWrite(lease(EXPIRY));
    ownership.runnerWrite({ ...container(), leaseExpiresAt: EXPIRY, at: NOW });
    ownership.runnerWrite({ ...runnerBase(), leaseExpiresAt: EXPIRY, kind: 'artifact', expectedState: 'starting', state: 'starting', stagingPath: 'staging/image', artifactSha256: SHA64, artifactSize: 10, artifactMtime: NOW, checksumPath: 'staging/sums', checksumSha256: checksumHash(), manifestPath: 'staging/manifest', manifestSha256: manifestHash('job-1'), verificationPath: 'staging/verify', verificationSha256: SHA64 });
    ownership.apiWrite({ kind: 'request-cancellation', jobId: 'job-1', reason: 'stop', at: LATER });
    ownership.runnerWrite({ ...runnerBase(), leaseExpiresAt: EXPIRY, kind: 'cancellation-transition', expectedState: 'starting' });
    const proof = {
      kind: 'container' as const, runnerUnit: runnerBase().runnerUnit, unitInactiveAt: RECOVERY,
      container: { kind: 'removed' as const, id: 'container-job-1', name: 'osi-job-1', imageDigest: SHA64_B,
        labels: { 'org.osi.image-builder.job-id': 'job-1', 'org.osi.image-builder.manifest-sha': SHA64 }, stoppedAt: LATER, removedAt: RECOVERY,
        globalLabelResult: 'no-match' as const, observedAt: RECOVERY },
      staging: { kind: 'quarantined' as const, sourcePath: 'staging/image', destinationPath: 'quarantine/image', sourceAbsent: true, destinationPresent: true, sha256: SHA64, size: 10, verifiedAt: RECOVERY } as StagingCleanupProof, logs,
    };
    const result = ownership.runnerWrite({ ...runnerBase(), at: RECOVERY, leaseExpiresAt: EXPIRY, kind: 'cancellation-cleanup', expectedState: 'cancel_requested', proof });
    expect(result.ok).toBe(true);
    expect(store.getJob('job-1')).toMatchObject({ artifactStagingPath: null, artifactQuarantinePath: 'quarantine/image', publishState: 'quarantined', containerId: null });
    expect(ownership.runnerWrite({ ...runnerBase(), at: RECOVERY, leaseExpiresAt: EXPIRY, kind: 'cancellation-terminal', expectedState: 'cancel_requested', terminalAt: RECOVERY, cleanupEventSeq: eventSeq(result) }).ok).toBe(true);
  });

  it('rejects false quarantine moves and preserves the staging path', async () => {
    const { ownership, store } = await fixture();
    ownership.apiWrite(dispatch()); ownership.runnerWrite(lease(EXPIRY));
    ownership.runnerWrite({ ...runnerBase(), leaseExpiresAt: EXPIRY, kind: 'artifact', expectedState: 'starting', state: 'starting', stagingPath: 'staging/image', artifactSha256: SHA64, artifactSize: 10, artifactMtime: NOW, checksumPath: 'staging/sums', checksumSha256: checksumHash(), manifestPath: 'staging/manifest', manifestSha256: manifestHash('job-1'), verificationPath: 'staging/verify', verificationSha256: SHA64 });
    ownership.apiWrite({ kind: 'request-cancellation', jobId: 'job-1', reason: 'stop', at: LATER });
    ownership.runnerWrite({ ...runnerBase(), leaseExpiresAt: EXPIRY, kind: 'cancellation-transition', expectedState: 'starting' });
    const base = { kind: 'pre-container' as const, runnerUnit: runnerBase().runnerUnit, unitInactiveAt: LATER, container: absent(), logs };
    for (const stagingProof of [
      { kind: 'quarantined' as const, sourcePath: 'staging/wrong', destinationPath: 'quarantine/image', sourceAbsent: true, destinationPresent: true, sha256: SHA64, size: 10, verifiedAt: LATER },
      { kind: 'quarantined' as const, sourcePath: 'staging/image', destinationPath: 'staging/image', sourceAbsent: true, destinationPresent: true, sha256: SHA64, size: 10, verifiedAt: LATER },
      { kind: 'quarantined' as const, sourcePath: 'staging/image', destinationPath: 'quarantine/image', sourceAbsent: true, destinationPresent: true, sha256: SHA64_B, size: 10, verifiedAt: LATER },
    ]) {
      let rejected = false;
      try { rejected = !(ownership.runnerWrite({ ...runnerBase(), leaseExpiresAt: EXPIRY, at: LATER, kind: 'cancellation-cleanup', expectedState: 'cancel_requested', proof: { ...base, staging: stagingProof as StagingCleanupProof } }).ok); } catch { rejected = true; }
      expect(rejected).toBe(true);
    }
    expect(store.getJob('job-1').artifactStagingPath).toBe('staging/image');
  });

  it('persists cleanup snapshots and only cleanup CAS can clear exact runtime identity', async () => {
    const { store, ownership, path } = await fixture(); ownership.apiWrite(dispatch()); ownership.runnerWrite(lease()); ownership.runnerWrite(container());
    const admission = cleanupAdmission(snapshot()); expect(ownership.apiWrite(admission).ok).toBe(true);
    const claim: CleanupWriteCommand = { kind: 'claim-lease', jobId: 'job-1', admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: snapshot(), at: RECOVERY };
    expect(ownership.cleanupWrite({ ...claim, owner: 'cleanup-b' })).toMatchObject({ ok: false, conflict: { kind: 'admission-mismatch' } }); expect(ownership.cleanupWrite(claim).ok).toBe(true);
    const complete: CleanupWriteCommand = { kind: 'complete', jobId: 'job-1', admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: snapshot(), postcondition: postcondition(snapshot()), exactContainerId: 'container-job-1', containerAbsent: true, evidencePath: 'recovery/cleanup.json', evidenceSha256: SHA64, at: RECOVERY };
    expect(ownership.cleanupWrite({ ...complete, fenceTokenHash: SHA64 })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } }); expect(ownership.cleanupWrite(complete).ok).toBe(true);
    expect(store.getJob('job-1')).toMatchObject({ containerId: null, state: 'starting' }); const db = openBuilderDatabase(path); expect((db.prepare('SELECT cleanup_fence_generation FROM jobs WHERE job_id=?').get('job-1') as { cleanup_fence_generation: number }).cleanup_fence_generation).toBe(1); db.close();
    expect(ownership.apiWrite({ kind: 'hand-back', jobId: 'job-1', admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, at: RECOVERY, proof: { runner: { unit: 'osi-image-builder-runner@job-1.service', owner: 'runner-a', leaseExpiresAt: ACTIVE, inactiveAt: LATER, observedAt: RECOVERY }, container: absent(RECOVERY), blocker: 'none' } }).ok).toBe(true);
    expect(store.getJob('job-1').state).toBe('interrupted');
  });

  it('admits and completes a null-identity start failure without Docker actions', async () => {
    const { ownership, store } = await fixture(); ownership.apiWrite(dispatch());
    const admission = cleanupAdmission(nullLeaseSnapshot());
    expect(ownership.apiWrite(admission).ok).toBe(true);
    const claim: CleanupWriteCommand = { kind: 'claim-lease', jobId: 'job-1', admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: nullLeaseSnapshot(), at: RECOVERY };
    expect(ownership.cleanupWrite(claim).ok).toBe(true);
    const complete: CleanupWriteCommand = { kind: 'complete', jobId: 'job-1', admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: nullLeaseSnapshot(), postcondition: postcondition(nullLeaseSnapshot()), exactContainerId: null, containerAbsent: true, evidencePath: 'recovery/cleanup.json', evidenceSha256: SHA64, at: RECOVERY };
    expect(ownership.cleanupWrite(complete).ok).toBe(true);
    expect(store.getJob('job-1')).toMatchObject({ state: 'starting', containerId: null });
    expect(ownership.apiWrite({ kind: 'hand-back', jobId: 'job-1', admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, at: RECOVERY, proof: { runner: nullLeaseSnapshot().runner, container: absent(RECOVERY), blocker: 'none' } }).ok).toBe(true);
    expect(store.getJob('job-1').state).toBe('interrupted');
  });

  it('admits a pre-cleanup staging source and completes with a separate quarantine postcondition', async () => {
    const { ownership, store } = await fixture(); ownership.apiWrite(dispatch()); ownership.runnerWrite(lease(ACTIVE));
    ownership.runnerWrite({ ...runnerBase(), kind: 'artifact', expectedState: 'starting', state: 'starting', stagingPath: 'staging/image', artifactSha256: SHA64, artifactSize: 10, artifactMtime: NOW, checksumPath: 'staging/sums', checksumSha256: checksumHash(), manifestPath: 'staging/manifest', manifestSha256: manifestHash('job-1'), verificationPath: 'staging/verify', verificationSha256: verificationHash('job-1') });
    const admission = cleanupAdmission(stagedSnapshot()); expect(ownership.apiWrite(admission).ok).toBe(true);
    const claim: CleanupWriteCommand = { kind: 'claim-lease', jobId: 'job-1', admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: stagedSnapshot(), at: RECOVERY }; expect(ownership.cleanupWrite(claim).ok).toBe(true);
    const complete: CleanupWriteCommand = { kind: 'complete', jobId: 'job-1', admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: stagedSnapshot(), postcondition: stagedPostcondition(), exactContainerId: null, containerAbsent: true, evidencePath: 'recovery/quarantine.json', evidenceSha256: SHA64, at: RECOVERY };
    expect(ownership.cleanupWrite({ ...complete, postcondition: { ...stagedPostcondition(), staging: { kind: 'quarantined', sourcePath: 'staging/wrong', destinationPath: 'quarantine/image', sourceAbsent: true, destinationPresent: true, sha256: SHA64, size: 10, verifiedAt: RECOVERY } } })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
    expect(ownership.cleanupWrite(complete).ok).toBe(true); expect(store.getJob('job-1')).toMatchObject({ artifactStagingPath: null, artifactQuarantinePath: 'quarantine/image', publishState: 'quarantined' });
    expect(ownership.apiWrite({ kind: 'hand-back', jobId: 'job-1', admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, at: RECOVERY, proof: { runner: stagedSnapshot().runner, container: absent(RECOVERY), blocker: 'none' } }).ok).toBe(true);
  });

  it('retains the staging source and fence across a cleanup crash window', async () => {
    const { ownership, store, path } = await fixture(); ownership.apiWrite(dispatch()); ownership.runnerWrite(lease(ACTIVE));
    ownership.runnerWrite({ ...runnerBase(), kind: 'artifact', expectedState: 'starting', state: 'starting', stagingPath: 'staging/image', artifactSha256: SHA64, artifactSize: 10, artifactMtime: NOW, checksumPath: 'staging/sums', checksumSha256: checksumHash(), manifestPath: 'staging/manifest', manifestSha256: manifestHash('job-1'), verificationPath: 'staging/verify', verificationSha256: verificationHash('job-1') });
    const admission = cleanupAdmission(stagedSnapshot()); ownership.apiWrite(admission); ownership.cleanupWrite({ kind: 'claim-lease', jobId: 'job-1', admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: stagedSnapshot(), at: RECOVERY });
    expect(store.getJob('job-1').artifactStagingPath).toBe('staging/image'); const db = openBuilderDatabase(path); expect((db.prepare('SELECT cleanup_fence_generation FROM jobs WHERE job_id=?').get('job-1') as { cleanup_fence_generation: number }).cleanup_fence_generation).toBe(1); db.close();
    expect(ownership.apiWrite({ kind: 'hand-back', jobId: 'job-1', admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, at: RECOVERY, proof: { runner: stagedSnapshot().runner, container: absent(RECOVERY), blocker: 'none' } })).toMatchObject({ ok: false });
  });

  it('rejects a cleanup owner mismatch without changing the lease or event stream', async () => {
    const setup = await claimedCleanup('cleanup-owner-mismatch'); const before = setup.store.listEvents('cleanup-owner-mismatch').events.length;
    const command: CleanupWriteCommand = { kind: 'renew-lease', jobId: 'cleanup-owner-mismatch', admissionId: setup.admission.admissionId, owner: 'cleanup-b', unitName: setup.admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, expectedExpiresAt: EXPIRY, expiresAt: '2026-07-23T10:05:00.000Z', snapshot: setup.snapshot, at: RECOVERY };
    expect(setup.ownership.cleanupWrite(command)).toMatchObject({ ok: false }); expect(setup.store.listEvents('cleanup-owner-mismatch').events).toHaveLength(before);
    const db = openBuilderDatabase(setup.path); expect((db.prepare('SELECT status, owner FROM cleanup_leases WHERE admission_id=?').get(setup.admission.admissionId) as { status: string; owner: string })).toEqual({ status: 'claimed', owner: 'cleanup-a' }); db.close();
  });

  it('rejects a cleanup unit mismatch as validation with no event', async () => {
    const setup = await claimedCleanup('cleanup-unit-mismatch'); const before = setup.store.listEvents('cleanup-unit-mismatch').events.length;
    const command: CleanupWriteCommand = { kind: 'renew-lease', jobId: 'cleanup-unit-mismatch', admissionId: setup.admission.admissionId, owner: 'cleanup-a', unitName: 'wrong.service', fenceGeneration: 1, fenceTokenHash: SHA64_B, expectedExpiresAt: EXPIRY, expiresAt: '2026-07-23T10:05:00.000Z', snapshot: setup.snapshot, at: RECOVERY };
    expect(() => setup.ownership.cleanupWrite(command)).toThrow(OwnershipValidationError); expect(setup.store.listEvents('cleanup-unit-mismatch').events).toHaveLength(before);
  });

  it('rejects a cleanup token mismatch without an event', async () => {
    const setup = await claimedCleanup('cleanup-token-mismatch'); const before = setup.store.listEvents('cleanup-token-mismatch').events.length;
    expect(setup.ownership.cleanupWrite({ kind: 'renew-lease', jobId: 'cleanup-token-mismatch', admissionId: setup.admission.admissionId, owner: 'cleanup-a', unitName: setup.admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64, expectedExpiresAt: EXPIRY, expiresAt: '2026-07-23T10:05:00.000Z', snapshot: setup.snapshot, at: RECOVERY })).toMatchObject({ ok: false }); expect(setup.store.listEvents('cleanup-token-mismatch').events).toHaveLength(before);
  });

  it('rejects a cleanup admission mismatch with the persisted lease unchanged', async () => {
    const setup = await claimedCleanup('cleanup-admission-mismatch'); const before = setup.store.listEvents('cleanup-admission-mismatch').events.length; const otherAdmission = 'cln_0123456789abcdefghjkmnpqrv';
    expect(setup.ownership.cleanupWrite({ kind: 'renew-lease', jobId: 'cleanup-admission-mismatch', admissionId: otherAdmission, owner: 'cleanup-a', unitName: `osi-image-builder-cleanup@${otherAdmission}.service`, fenceGeneration: 1, fenceTokenHash: SHA64_B, expectedExpiresAt: EXPIRY, expiresAt: '2026-07-23T10:05:00.000Z', snapshot: setup.snapshot, at: RECOVERY })).toMatchObject({ ok: false }); expect(setup.store.listEvents('cleanup-admission-mismatch').events).toHaveLength(before); const db = openBuilderDatabase(setup.path); expect((db.prepare('SELECT status FROM cleanup_leases WHERE job_id=?').get('cleanup-admission-mismatch') as { status: string }).status).toBe('claimed'); db.close();
  });

  it('rejects a cleanup generation mismatch without changing the fence', async () => {
    const setup = await claimedCleanup('cleanup-generation-mismatch'); const before = setup.store.listEvents('cleanup-generation-mismatch').events.length;
    expect(setup.ownership.cleanupWrite({ kind: 'renew-lease', jobId: 'cleanup-generation-mismatch', admissionId: setup.admission.admissionId, owner: 'cleanup-a', unitName: setup.admission.unitName, fenceGeneration: 2, fenceTokenHash: SHA64_B, expectedExpiresAt: EXPIRY, expiresAt: '2026-07-23T10:05:00.000Z', snapshot: setup.snapshot, at: RECOVERY })).toMatchObject({ ok: false }); expect(setup.store.listEvents('cleanup-generation-mismatch').events).toHaveLength(before); const db = openBuilderDatabase(setup.path); expect((db.prepare('SELECT fence_generation FROM cleanup_leases WHERE job_id=?').get('cleanup-generation-mismatch') as { fence_generation: number }).fence_generation).toBe(1); db.close();
  });

  it('rejects an expired cleanup lease without partial completion or events', async () => {
    const setup = await claimedCleanup('cleanup-expired'); const before = setup.store.listEvents('cleanup-expired').events.length;
    expect(setup.ownership.cleanupWrite({ kind: 'renew-lease', jobId: 'cleanup-expired', admissionId: setup.admission.admissionId, owner: 'cleanup-a', unitName: setup.admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, expectedExpiresAt: EXPIRY, expiresAt: '2026-07-23T10:05:00.000Z', snapshot: setup.snapshot, at: EXPIRY })).toMatchObject({ ok: false });
    expect(setup.store.listEvents('cleanup-expired').events).toHaveLength(before); const db = openBuilderDatabase(setup.path); expect((db.prepare('SELECT status FROM cleanup_leases WHERE job_id=?').get('cleanup-expired') as { status: string }).status).toBe('claimed'); db.close();
  });

  it('renews the exact cleanup lease and appends one durable event', async () => {
    const setup = await claimedCleanup('cleanup-renew'); const before = setup.store.listEvents('cleanup-renew').events.length;
    expect(setup.ownership.cleanupWrite({ kind: 'renew-lease', jobId: 'cleanup-renew', admissionId: setup.admission.admissionId, owner: 'cleanup-a', unitName: setup.admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, expectedExpiresAt: EXPIRY, expiresAt: '2026-07-23T10:05:00.000Z', snapshot: setup.snapshot, at: RECOVERY }).ok).toBe(true);
    expect(setup.store.listEvents('cleanup-renew').events).toHaveLength(before + 1); expect(setup.store.listEvents('cleanup-renew').events.at(-1)?.eventType).toBe('cleanup_renew'); const db = openBuilderDatabase(setup.path); expect((db.prepare('SELECT expires_at FROM cleanup_leases WHERE job_id=?').get('cleanup-renew') as { expires_at: string }).expires_at).toBe('2026-07-23T10:05:00.000Z'); db.close();
  });

  it('isolates cleanup owner, unit, token, admission, generation, expiry, and hand-back conflicts', async () => {
    const setup = await claimedCleanup(); const complete: CleanupWriteCommand = { kind: 'complete', jobId: 'job-1', admissionId: setup.admission.admissionId, owner: 'cleanup-a', unitName: setup.admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: setup.snapshot, postcondition: postcondition(setup.snapshot), exactContainerId: 'container-job-1', containerAbsent: true, evidencePath: 'recovery/cleanup.json', evidenceSha256: SHA64, at: RECOVERY };
    const before = eventCount(setup.store);
    expect(setup.ownership.cleanupWrite({ ...complete, owner: 'cleanup-b' })).toMatchObject({ ok: false });
    expect(() => setup.ownership.cleanupWrite({ ...complete, unitName: 'wrong.service' })).toThrow(OwnershipValidationError);
    expect(setup.ownership.cleanupWrite({ ...complete, fenceTokenHash: SHA64 })).toMatchObject({ ok: false });
    expect(setup.ownership.cleanupWrite({ ...complete, admissionId: 'cln_0123456789abcdefghjkmnpqrs' as string, fenceGeneration: 2 })).toMatchObject({ ok: false });
    expect(setup.ownership.cleanupWrite({ ...complete, fenceGeneration: 0 })).toMatchObject({ ok: false });
    expect(eventCount(setup.store)).toBe(before);
    expect(setup.ownership.cleanupWrite({ ...complete, at: EXPIRY })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
    expect(setup.ownership.cleanupWrite({ kind: 'renew-lease', jobId: 'job-1', admissionId: setup.admission.admissionId, owner: 'cleanup-a', unitName: setup.admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, expectedExpiresAt: EXPIRY, expiresAt: '2026-07-23T10:05:00.000Z', snapshot: setup.snapshot, at: RECOVERY }).ok).toBe(true);
    expect(setup.ownership.apiWrite({ kind: 'hand-back', jobId: 'job-1', admissionId: setup.admission.admissionId, owner: 'cleanup-a', unitName: setup.admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, at: RECOVERY, proof: { runner: setup.snapshot.runner, container: absent(RECOVERY), blocker: 'none' } })).toMatchObject({ ok: false });
  });

  it('reconciles persisted log state at cleanup admission and completion', async () => {
    const falseAbsent = await fixture('cleanup-false-absent'); falseAbsent.ownership.apiWrite(dispatch('cleanup-false-absent')); falseAbsent.ownership.runnerWrite(lease(ACTIVE, 'cleanup-false-absent')); falseAbsent.ownership.runnerWrite(container('cleanup-false-absent')); seedUnsealedLogs(falseAbsent.path, 'cleanup-false-absent');
    expect(falseAbsent.ownership.apiWrite(cleanupAdmission(snapshot('present', 'cleanup-false-absent'), 'cleanup-false-absent'))).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
    const falseSealed = await fixture('cleanup-false-sealed'); falseSealed.ownership.apiWrite(dispatch('cleanup-false-sealed')); falseSealed.ownership.runnerWrite(lease(ACTIVE, 'cleanup-false-sealed')); falseSealed.ownership.runnerWrite(container('cleanup-false-sealed')); seedUnsealedLogs(falseSealed.path, 'cleanup-false-sealed');
    const sealedSnapshot = { ...snapshot('present', 'cleanup-false-sealed'), logs: { runner: 'sealed' as const, docker: 'sealed' as const, verifiedAt: RECOVERY } };
    expect(falseSealed.ownership.apiWrite(cleanupAdmission(sealedSnapshot, 'cleanup-false-sealed'))).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
    const completion = await fixture('cleanup-false-completion'); completion.ownership.apiWrite(dispatch('cleanup-false-completion')); completion.ownership.runnerWrite(lease(ACTIVE, 'cleanup-false-completion')); completion.ownership.runnerWrite(container('cleanup-false-completion')); seedUnsealedLogs(completion.path, 'cleanup-false-completion');
    const admittedSnapshot = { ...snapshot('present', 'cleanup-false-completion'), logs: { runner: 'unsealed' as const, docker: 'unsealed' as const, verifiedAt: RECOVERY }, blocker: 'staging-or-log' as const }; const admitted = cleanupAdmission(admittedSnapshot, 'cleanup-false-completion'); expect(completion.ownership.apiWrite(admitted).ok).toBe(true); completion.ownership.cleanupWrite({ kind: 'claim-lease', jobId: 'cleanup-false-completion', admissionId: admitted.admissionId, owner: 'cleanup-a', unitName: admitted.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: admittedSnapshot, at: RECOVERY });
    const falseClaim = { ...admittedSnapshot, logs, blocker: 'none' as const };
    expect(completion.ownership.cleanupWrite({ kind: 'complete', jobId: 'cleanup-false-completion', admissionId: admitted.admissionId, owner: 'cleanup-a', unitName: admitted.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: falseClaim, postcondition: postcondition(admittedSnapshot), exactContainerId: 'container-cleanup-false-completion', containerAbsent: true, evidencePath: 'recovery/cleanup.json', evidenceSha256: SHA64, at: RECOVERY })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
    expect(completion.ownership.cleanupWrite({ kind: 'complete', jobId: 'cleanup-false-completion', admissionId: admitted.admissionId, owner: 'cleanup-a', unitName: admitted.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: admittedSnapshot, postcondition: postcondition(admittedSnapshot), exactContainerId: 'container-cleanup-false-completion', containerAbsent: true, evidencePath: 'recovery/cleanup.json', evidenceSha256: SHA64, at: RECOVERY })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
  });

  it('allows admitted unsealed logs to seal across claim renew reopen completion and hand-back', async () => {
    const target = await fixture('cleanup-log-progress'); target.ownership.apiWrite(dispatch('cleanup-log-progress')); target.ownership.runnerWrite(lease(ACTIVE, 'cleanup-log-progress')); target.ownership.runnerWrite(container('cleanup-log-progress')); seedUnsealedLogs(target.path, 'cleanup-log-progress');
    const unsealed = { ...snapshot('present', 'cleanup-log-progress'), logs: { runner: 'unsealed' as const, docker: 'unsealed' as const, verifiedAt: RECOVERY }, blocker: 'staging-or-log' as const };
    const admission = cleanupAdmission(unsealed, 'cleanup-log-progress'); expect(target.ownership.apiWrite(admission).ok).toBe(true);
    const claim: CleanupWriteCommand = { kind: 'claim-lease', jobId: 'cleanup-log-progress', admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: unsealed, at: RECOVERY };
    const claimDb = openBuilderDatabase(target.path); const claimed = new OwnershipStore(claimDb, { now: () => NOW }); closers.push(() => claimDb.close()); expect(claimed.cleanupWrite(claim).ok).toBe(true);
    const renewedBeforeSeal: CleanupWriteCommand = { kind: 'renew-lease', jobId: 'cleanup-log-progress', admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, expectedExpiresAt: EXPIRY, expiresAt: '2026-07-23T10:05:00.000Z', snapshot: unsealed, at: RECOVERY };
    expect(claimed.cleanupWrite(renewedBeforeSeal).ok).toBe(true);
    { const db = openBuilderDatabase(target.path); db.prepare('UPDATE job_log_generations SET sealed_at=?, sha256=? WHERE job_id=?').run(SEALED, SHA64, 'cleanup-log-progress'); db.close(); }
    const sealed = { ...unsealed, logs: { runner: 'sealed' as const, docker: 'sealed' as const, verifiedAt: AFTER }, blocker: 'none' as const };
    const sealedDb = openBuilderDatabase(target.path); const afterSeal = new OwnershipStore(sealedDb, { now: () => NOW }); closers.push(() => sealedDb.close());
    expect(afterSeal.cleanupWrite({ ...renewedBeforeSeal, expectedExpiresAt: '2026-07-23T10:05:00.000Z', expiresAt: '2026-07-23T10:06:00.000Z', snapshot: sealed, at: AFTER }).ok).toBe(true);
    const complete: CleanupWriteCommand = { kind: 'complete', jobId: 'cleanup-log-progress', admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: sealed, postcondition: postcondition(sealed), exactContainerId: 'container-cleanup-log-progress', containerAbsent: true, evidencePath: 'recovery/cleanup.json', evidenceSha256: SHA64, at: AFTER };
    expect(afterSeal.cleanupWrite(complete).ok).toBe(true);
    const handBackDb = openBuilderDatabase(target.path); const handBack = new OwnershipStore(handBackDb, { now: () => NOW }); closers.push(() => handBackDb.close());
    expect(handBack.apiWrite({ kind: 'hand-back', jobId: 'cleanup-log-progress', admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, at: AFTER, proof: { runner: { ...sealed.runner, observedAt: AFTER }, container: absent(AFTER), blocker: 'none' } }).ok).toBe(true);
    expect(target.store.getJob('cleanup-log-progress').state).toBe('interrupted'); expect(target.store.listEvents('cleanup-log-progress').events.filter((event) => event.eventType === 'cleanup_complete')).toHaveLength(1);
  });

  it('rejects cleanup log generation replacement, addition, and removal after admission', async () => {
    const added = await fixture('cleanup-log-added'); added.ownership.apiWrite(dispatch('cleanup-log-added')); added.ownership.runnerWrite(lease(ACTIVE, 'cleanup-log-added')); added.ownership.runnerWrite(container('cleanup-log-added')); seedUnsealedLogs(added.path, 'cleanup-log-added'); const addedSnapshot = { ...snapshot('present', 'cleanup-log-added'), logs: { runner: 'unsealed' as const, docker: 'unsealed' as const, verifiedAt: RECOVERY }, blocker: 'staging-or-log' as const }; const addedAdmission = cleanupAdmission(addedSnapshot, 'cleanup-log-added'); added.ownership.apiWrite(addedAdmission); added.ownership.cleanupWrite({ kind: 'claim-lease', jobId: 'cleanup-log-added', admissionId: addedAdmission.admissionId, owner: 'cleanup-a', unitName: addedAdmission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: addedSnapshot, at: RECOVERY });
    { const db = openBuilderDatabase(added.path); for (const stream of ['runner', 'docker']) db.prepare('INSERT INTO job_log_generations (job_id, stream, generation, path, started_at, size_bytes) VALUES (?, ?, 1, ?, ?, 0)').run('cleanup-log-added', stream, `logs/${stream}-1.log`, RECOVERY); db.close(); }
    const addedEvents = added.store.listEvents('cleanup-log-added').events.length;
    expect(added.ownership.cleanupWrite({ kind: 'renew-lease', jobId: 'cleanup-log-added', admissionId: addedAdmission.admissionId, owner: 'cleanup-a', unitName: addedAdmission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, expectedExpiresAt: EXPIRY, expiresAt: '2026-07-23T10:05:00.000Z', snapshot: addedSnapshot, at: RECOVERY })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } }); expect(added.store.listEvents('cleanup-log-added').events).toHaveLength(addedEvents);

    const removed = await fixture('cleanup-log-removed'); removed.ownership.apiWrite(dispatch('cleanup-log-removed')); removed.ownership.runnerWrite(lease(ACTIVE, 'cleanup-log-removed')); removed.ownership.runnerWrite(container('cleanup-log-removed')); seedUnsealedLogs(removed.path, 'cleanup-log-removed'); const removedSnapshot = { ...snapshot('present', 'cleanup-log-removed'), logs: { runner: 'unsealed' as const, docker: 'unsealed' as const, verifiedAt: RECOVERY }, blocker: 'staging-or-log' as const }; const removedAdmission = cleanupAdmission(removedSnapshot, 'cleanup-log-removed'); removed.ownership.apiWrite(removedAdmission);
    { const db = openBuilderDatabase(removed.path); db.prepare('DELETE FROM job_log_generations WHERE job_id=?').run('cleanup-log-removed'); db.close(); }
    const removedEvents = removed.store.listEvents('cleanup-log-removed').events.length;
    expect(removed.ownership.cleanupWrite({ kind: 'claim-lease', jobId: 'cleanup-log-removed', admissionId: removedAdmission.admissionId, owner: 'cleanup-a', unitName: removedAdmission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: removedSnapshot, at: RECOVERY })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } }); expect(removed.store.listEvents('cleanup-log-removed').events).toHaveLength(removedEvents);

    const replaced = await fixture('cleanup-log-replaced'); replaced.ownership.apiWrite(dispatch('cleanup-log-replaced')); replaced.ownership.runnerWrite(lease(ACTIVE, 'cleanup-log-replaced')); replaced.ownership.runnerWrite(container('cleanup-log-replaced')); seedUnsealedLogs(replaced.path, 'cleanup-log-replaced'); const replacedSnapshot = { ...snapshot('present', 'cleanup-log-replaced'), logs: { runner: 'unsealed' as const, docker: 'unsealed' as const, verifiedAt: RECOVERY }, blocker: 'staging-or-log' as const }; const replacedAdmission = cleanupAdmission(replacedSnapshot, 'cleanup-log-replaced'); replaced.ownership.apiWrite(replacedAdmission); replaced.ownership.cleanupWrite({ kind: 'claim-lease', jobId: 'cleanup-log-replaced', admissionId: replacedAdmission.admissionId, owner: 'cleanup-a', unitName: replacedAdmission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: replacedSnapshot, at: RECOVERY });
    { const db = openBuilderDatabase(replaced.path); db.prepare('DELETE FROM job_log_generations WHERE job_id=?').run('cleanup-log-replaced'); for (const stream of ['runner', 'docker']) db.prepare('INSERT INTO job_log_generations (job_id, stream, generation, path, started_at, size_bytes) VALUES (?, ?, 0, ?, ?, 0)').run('cleanup-log-replaced', stream, `logs/${stream}-replacement.log`, RECOVERY); db.close(); }
    const replacedEvents = replaced.store.listEvents('cleanup-log-replaced').events.length;
    expect(replaced.ownership.cleanupWrite({ kind: 'renew-lease', jobId: 'cleanup-log-replaced', admissionId: replacedAdmission.admissionId, owner: 'cleanup-a', unitName: replacedAdmission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, expectedExpiresAt: EXPIRY, expiresAt: '2026-07-23T10:05:00.000Z', snapshot: replacedSnapshot, at: RECOVERY })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } }); expect(replaced.store.listEvents('cleanup-log-replaced').events).toHaveLength(replacedEvents);
  });

  it('rejects a sealed-to-unsealed cleanup log regression without an event', async () => {
    const target = await fixture('cleanup-log-regression'); target.ownership.apiWrite(dispatch('cleanup-log-regression')); target.ownership.runnerWrite(lease(ACTIVE, 'cleanup-log-regression')); target.ownership.runnerWrite(container('cleanup-log-regression')); seedLogs(target.path, 'cleanup-log-regression');
    const sealed = { ...snapshot('present', 'cleanup-log-regression'), logs: { runner: 'sealed' as const, docker: 'sealed' as const, verifiedAt: RECOVERY } }; const admission = cleanupAdmission(sealed, 'cleanup-log-regression'); expect(target.ownership.apiWrite(admission).ok).toBe(true);
    const db = openBuilderDatabase(target.path); db.exec('DROP TRIGGER job_log_generations_seal_guard'); db.prepare('UPDATE job_log_generations SET sealed_at=NULL, sha256=NULL WHERE job_id=?').run('cleanup-log-regression'); db.close();
    const before = target.store.listEvents('cleanup-log-regression').events.length;
    expect(target.ownership.cleanupWrite({ kind: 'claim-lease', jobId: 'cleanup-log-regression', admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: sealed, at: RECOVERY })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } }); expect(target.store.listEvents('cleanup-log-regression').events).toHaveLength(before);
  });

  it('rejects contiguous log-gap evidence at admission completion and publishing recovery', async () => {
    const admissionCase = await fixture('log-gap-admission'); admissionCase.ownership.apiWrite(dispatch('log-gap-admission')); admissionCase.ownership.runnerWrite(lease(ACTIVE, 'log-gap-admission')); admissionCase.ownership.runnerWrite(container('log-gap-admission')); seedLogGapEvent(admissionCase.path, 'log-gap-admission');
    const sealed = { ...snapshot('present', 'log-gap-admission'), logs: { runner: 'sealed' as const, docker: 'sealed' as const, verifiedAt: RECOVERY } };
    expect(admissionCase.ownership.apiWrite(cleanupAdmission(sealed, 'log-gap-admission'))).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });

    const completionCase = await fixture('log-gap-completion'); completionCase.ownership.apiWrite(dispatch('log-gap-completion')); completionCase.ownership.runnerWrite(lease(ACTIVE, 'log-gap-completion')); completionCase.ownership.runnerWrite(container('log-gap-completion')); seedLogGapEvent(completionCase.path, 'log-gap-completion', false);
    const pre = { ...snapshot('present', 'log-gap-completion'), logs: { runner: 'unsealed' as const, docker: 'unsealed' as const, verifiedAt: RECOVERY }, blocker: 'staging-or-log' as const }; const completionAdmission = cleanupAdmission(pre, 'log-gap-completion'); expect(completionCase.ownership.apiWrite(completionAdmission).ok).toBe(true); completionCase.ownership.cleanupWrite({ kind: 'claim-lease', jobId: 'log-gap-completion', admissionId: completionAdmission.admissionId, owner: 'cleanup-a', unitName: completionAdmission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: pre, at: RECOVERY });
    const post = { ...postcondition(pre), logs: { runner: 'sealed' as const, docker: 'sealed' as const, verifiedAt: SEALED } };
    expect(completionCase.ownership.cleanupWrite({ kind: 'complete', jobId: 'log-gap-completion', admissionId: completionAdmission.admissionId, owner: 'cleanup-a', unitName: completionAdmission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: pre, postcondition: post, exactContainerId: 'container-log-gap-completion', containerAbsent: true, evidencePath: 'recovery/cleanup.json', evidenceSha256: SHA64, at: SEALED })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });

    const publishCase = await fixture('log-gap-publish'); toPublishing(publishCase.ownership, 'log-gap-publish'); seedLogGapEvent(publishCase.path, 'log-gap-publish');
    expect(publishCase.ownership.apiWrite({ kind: 'publish-recovery', jobId: 'log-gap-publish', expectedState: 'publishing', at: RECOVERY, state: 'succeeded', evidence: recoveryEvidence('log-gap-publish') })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
  });

  it('rejects sealed full-coverage log-gap evidence at cleanup completion without changing the lease or fence', async () => {
    const target = await fixture('log-gap-sealed-completion'); target.ownership.apiWrite(dispatch('log-gap-sealed-completion')); target.ownership.runnerWrite(lease(ACTIVE, 'log-gap-sealed-completion')); target.ownership.runnerWrite(container('log-gap-sealed-completion')); seedLogGapEvent(target.path, 'log-gap-sealed-completion', false);
    const pre = { ...snapshot('present', 'log-gap-sealed-completion'), logs: { runner: 'unsealed' as const, docker: 'unsealed' as const, verifiedAt: RECOVERY }, blocker: 'staging-or-log' as const }; const admission = cleanupAdmission(pre, 'log-gap-sealed-completion'); expect(target.ownership.apiWrite(admission).ok).toBe(true); expect(target.ownership.cleanupWrite({ kind: 'claim-lease', jobId: 'log-gap-sealed-completion', admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: pre, at: RECOVERY }).ok).toBe(true);
    { const db = openBuilderDatabase(target.path); db.prepare('UPDATE job_log_generations SET sealed_at=?, sha256=? WHERE job_id=?').run(SEALED, SHA64, 'log-gap-sealed-completion'); expect((db.prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id=? AND event_type='log-gap' AND byte_offset=0 AND byte_length=1").get('log-gap-sealed-completion') as { count: number }).count).toBe(2); db.close(); }
    const post = { ...postcondition(pre), logs: { runner: 'sealed' as const, docker: 'sealed' as const, verifiedAt: SEALED } }; const beforeEvents = target.store.listEvents('log-gap-sealed-completion').events.length;
    expect(target.ownership.cleanupWrite({ kind: 'complete', jobId: 'log-gap-sealed-completion', admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: pre, postcondition: post, exactContainerId: 'container-log-gap-sealed-completion', containerAbsent: true, evidencePath: 'recovery/cleanup.json', evidenceSha256: SHA64, at: SEALED })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
    expect(target.store.listEvents('log-gap-sealed-completion').events).toHaveLength(beforeEvents); const state = openBuilderDatabase(target.path); expect(state.prepare('SELECT status, fence_generation, fence_token_hash FROM cleanup_leases WHERE job_id=?').get('log-gap-sealed-completion')).toMatchObject({ status: 'claimed', fence_generation: 1, fence_token_hash: SHA64_B }); expect(state.prepare('SELECT cleanup_fence_generation, cleanup_admission_id FROM jobs WHERE job_id=?').get('log-gap-sealed-completion')).toMatchObject({ cleanup_fence_generation: 1, cleanup_admission_id: admission.admissionId }); state.close();
  });

  it('persists exact cleanup absence fields and explicit cleanup evidence events', async () => {
    const setup = await claimedCleanup(); const complete: CleanupWriteCommand = { kind: 'complete', jobId: 'job-1', admissionId: setup.admission.admissionId, owner: 'cleanup-a', unitName: setup.admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: setup.snapshot, postcondition: postcondition(setup.snapshot), exactContainerId: 'container-job-1', containerAbsent: true, evidencePath: 'recovery/cleanup.json', evidenceSha256: SHA64, at: RECOVERY };
    expect(setup.ownership.cleanupWrite(complete).ok).toBe(true);
    const event = setup.store.listEvents('job-1').events.find((item) => item.eventType === 'cleanup_complete');
    expect(event?.payload).toMatchObject({ postcondition: { container: { kind: 'removed', id: 'container-job-1', exactIdAbsent: true, globalLabelResult: 'no-match', stoppedAt: NOW, removedAt: LATER, observedAt: RECOVERY } } });
    const blocker = await fixture('cleanup-evidence'); blocker.ownership.apiWrite(dispatch('cleanup-evidence')); blocker.ownership.runnerWrite(lease(ACTIVE, 'cleanup-evidence')); blocker.ownership.runnerWrite({ ...container('cleanup-evidence'), at: NOW }); blocker.ownership.runnerWrite({ ...runnerBase('cleanup-evidence'), kind: 'artifact', expectedState: 'starting', state: 'starting', stagingPath: 'staging/image', artifactSha256: SHA64, artifactSize: 10, artifactMtime: NOW, checksumPath: 'staging/sums', checksumSha256: checksumHash(), manifestPath: 'staging/manifest', manifestSha256: manifestHash('cleanup-evidence'), verificationPath: 'staging/verify', verificationSha256: verificationHash('cleanup-evidence') });
    const evidenceSnapshot = { ...stagedSnapshot('cleanup-evidence'), container: snapshot('present', 'cleanup-evidence').container }; const evidenceAdmission = cleanupAdmission(evidenceSnapshot, 'cleanup-evidence'); expect(blocker.ownership.apiWrite(evidenceAdmission).ok).toBe(true); blocker.ownership.cleanupWrite({ kind: 'claim-lease', jobId: 'cleanup-evidence', admissionId: evidenceAdmission.admissionId, owner: 'cleanup-a', unitName: evidenceAdmission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: evidenceSnapshot, at: RECOVERY });
    expect(blocker.ownership.cleanupWrite({ kind: 'evidence', jobId: 'cleanup-evidence', admissionId: evidenceAdmission.admissionId, owner: 'cleanup-a', unitName: evidenceAdmission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: evidenceSnapshot, status: 'blocking', blockerCode: 'QUARANTINE_PENDING', blocker: { reason: 'move failed' }, at: RECOVERY }).ok).toBe(true);
    expect(blocker.store.getJob('cleanup-evidence').artifactStagingPath).toBe('staging/image'); expect(blocker.store.listEvents('cleanup-evidence').events.at(-1)?.eventType).toBe('cleanup');
  });

  it('requires complete publishing evidence for runner terminal and typed API recovery', async () => {
    const { ownership, store } = await fixture(); ownership.apiWrite(dispatch()); ownership.runnerWrite(lease());
    const stages: Array<[PipelineStageName, JobState, JobState]> = [['preflight', 'starting', 'preflight'], ['source', 'preflight', 'source'], ['release-gates', 'source', 'release_gates'], ['frontend', 'release_gates', 'frontend'], ['target-setup', 'frontend', 'target_setup'], ['feeds', 'target_setup', 'feeds'], ['config', 'feeds', 'config'], ['build', 'config', 'building'], ['verify', 'building', 'verifying']];
    for (const [name, from, to] of stages) ownership.runnerWrite({ ...runnerBase(), kind: 'stage', expectedState: from, state: to, stage: name, outcome: 'passed', startedAt: NOW, finishedAt: NOW, evidencePath: `evidence/${name}`, evidenceSha256: SHA64 });
    ownership.runnerWrite({ ...runnerBase(), kind: 'artifact', expectedState: 'verifying', state: 'verifying', stagingPath: 'staging/image', artifactSha256: SHA64, artifactSize: 10, artifactMtime: NOW, checksumPath: 'staging/sums', checksumSha256: SHA64, manifestPath: 'staging/manifest', manifestSha256: SHA64, verificationPath: 'staging/verify', verificationSha256: SHA64 });
    ownership.runnerWrite({ ...runnerBase(), kind: 'publish', expectedState: 'verifying', state: 'publishing', finalDirectory: 'release/main/rpi-5', finalPath: 'release/main/rpi-5/image', startedAt: NOW });
    expect(ownership.runnerWrite({ ...runnerBase(), at: RECOVERY, kind: 'normal-terminal', expectedState: 'publishing', state: 'succeeded', terminalAt: RECOVERY })).toMatchObject({ ok: false });
    ownership.runnerWrite({ ...runnerBase(), kind: 'publish', expectedState: 'publishing', state: 'published', finalDirectory: 'release/main/rpi-5', finalPath: 'release/main/rpi-5/image', startedAt: NOW, publishedAt: LATER });
    expect(ownership.runnerWrite({ ...runnerBase(), at: LATER, kind: 'normal-terminal', expectedState: 'publishing', state: 'succeeded', terminalAt: LATER }).ok).toBe(true); expect(store.getJob('job-1').state).toBe('succeeded');
  });

  it('renews a live publishing runner lease but rejects terminal and non-runner states without mutation', async () => {
    const publishing = await fixture('renew-publishing'); toPublishing(publishing.ownership, 'renew-publishing');
    const beforeEvents = publishing.store.listEvents('renew-publishing').events.length; const before = publishing.store.getJob('renew-publishing');
    expect(publishing.ownership.runnerWrite({ kind: 'renew-lease', jobId: 'renew-publishing', runnerUnit: 'osi-image-builder-runner@renew-publishing.service', owner: 'runner-a', expectedExpiresAt: ACTIVE, expiresAt: EXPIRY, at: LATER })).toMatchObject({ ok: true });
    expect(publishing.store.listEvents('renew-publishing').events).toHaveLength(beforeEvents + 1); expect(publishing.store.getJob('renew-publishing')).toMatchObject({ runnerLeaseExpiresAt: EXPIRY }); expect(publishing.store.getJob('renew-publishing')).not.toEqual(before);

    const terminal = await fixture('renew-terminal'); toPublishing(terminal.ownership, 'renew-terminal');
    terminal.ownership.runnerWrite({ ...runnerBase('renew-terminal'), kind: 'publish', expectedState: 'publishing', state: 'published', finalDirectory: 'release/renew-terminal', finalPath: 'release/renew-terminal/image', publishedAt: LATER });
    terminal.ownership.runnerWrite({ ...runnerBase('renew-terminal'), at: LATER, kind: 'normal-terminal', expectedState: 'publishing', state: 'succeeded', terminalAt: LATER });
    const terminalEvents = terminal.store.listEvents('renew-terminal').events.length; const terminalBefore = terminal.store.getJob('renew-terminal');
    expect(terminal.ownership.runnerWrite({ kind: 'renew-lease', jobId: 'renew-terminal', runnerUnit: 'osi-image-builder-runner@renew-terminal.service', owner: 'runner-a', expectedExpiresAt: ACTIVE, expiresAt: EXPIRY, at: LATER })).toMatchObject({ ok: false, conflict: { kind: 'stale-predecessor' } });
    expect(terminal.store.listEvents('renew-terminal').events).toHaveLength(terminalEvents); expect(terminal.store.getJob('renew-terminal')).toEqual(terminalBefore);

    const queued = await fixture('renew-queued'); const queuedEvents = queued.store.listEvents('renew-queued').events.length; const queuedBefore = queued.store.getJob('renew-queued');
    expect(queued.ownership.runnerWrite({ kind: 'renew-lease', jobId: 'renew-queued', runnerUnit: 'osi-image-builder-runner@renew-queued.service', owner: 'runner-a', expectedExpiresAt: ACTIVE, expiresAt: EXPIRY, at: NOW })).toMatchObject({ ok: false, conflict: { kind: 'stale-predecessor' } });
    expect(queued.store.listEvents('renew-queued').events).toHaveLength(queuedEvents); expect(queued.store.getJob('renew-queued')).toEqual(queuedBefore);
  });

  it('validates effective publish timestamps before mutation and preserves a valid completion sequence', async () => {
    const probe = await fixture('publish-effective-fallback'); toVerifying(probe.ownership, 'publish-effective-fallback');
    let begins = 0; const guarded = new OwnershipStore(probe.db, { now: () => NOW, beforeBegin: () => { begins += 1; } });
    const beforeEvents = probe.store.listEvents('publish-effective-fallback').events.length; const before = probe.store.getJob('publish-effective-fallback');
    expect(() => guarded.runnerWrite({ ...runnerBase('publish-effective-fallback'), at: LATER, kind: 'publish', expectedState: 'verifying', state: 'published', finalDirectory: 'release/publish-effective-fallback', finalPath: 'release/publish-effective-fallback/image', publishedAt: NOW } as never)).toThrow(OwnershipValidationError);
    expect(begins).toBe(0); expect(probe.store.listEvents('publish-effective-fallback').events).toHaveLength(beforeEvents); expect(probe.store.getJob('publish-effective-fallback')).toEqual(before);

    const valid = await fixture('publish-effective-valid'); toVerifying(valid.ownership, 'publish-effective-valid');
    valid.ownership.runnerWrite({ kind: 'renew-lease', jobId: 'publish-effective-valid', runnerUnit: 'osi-image-builder-runner@publish-effective-valid.service', owner: 'runner-a', expectedExpiresAt: ACTIVE, expiresAt: EXPIRY, at: LATER });
    expect(valid.ownership.runnerWrite({ ...runnerBase('publish-effective-valid'), at: LATER, leaseExpiresAt: EXPIRY, kind: 'publish', expectedState: 'verifying', state: 'publishing', finalDirectory: 'release/publish-effective-valid', finalPath: 'release/publish-effective-valid/image' }).ok).toBe(true);
    expect(valid.ownership.runnerWrite({ ...runnerBase('publish-effective-valid'), at: RECOVERY, leaseExpiresAt: EXPIRY, kind: 'publish', expectedState: 'publishing', state: 'published', finalDirectory: 'release/publish-effective-valid', finalPath: 'release/publish-effective-valid/image', publishedAt: RECOVERY }).ok).toBe(true);
    expect(valid.store.getJob('publish-effective-valid')).toMatchObject({ state: 'publishing', publishState: 'published', publishStartedAt: LATER, publishedAt: RECOVERY });

    const ignored = await fixture('publish-ignored-timestamps'); toVerifying(ignored.ownership, 'publish-ignored-timestamps'); const ignoredEvents = ignored.store.listEvents('publish-ignored-timestamps').events.length; const ignoredBefore = ignored.store.getJob('publish-ignored-timestamps');
    expect(() => ignored.ownership.runnerWrite({ ...runnerBase('publish-ignored-timestamps'), kind: 'publish', expectedState: 'verifying', state: 'staged', startedAt: NOW } as never)).toThrow(OwnershipValidationError);
    expect(() => ignored.ownership.runnerWrite({ ...runnerBase('publish-ignored-timestamps'), kind: 'publish', expectedState: 'verifying', state: 'blocked', publishedAt: NOW, blockerCode: 'PUBLISH_FAILED', blocker: { reason: 'test' } } as never)).toThrow(OwnershipValidationError);
    expect(ignored.store.listEvents('publish-ignored-timestamps').events).toHaveLength(ignoredEvents); expect(ignored.store.getJob('publish-ignored-timestamps')).toEqual(ignoredBefore);
  });

  it('accepts only typed publishing recovery evidence for success and failure', async () => {
    const success = await fixture('job-2'); toPublishing(success.ownership, 'job-2'); seedLogs(success.path, 'job-2');
    expect(success.ownership.apiWrite({ kind: 'publish-recovery', jobId: 'job-2', expectedState: 'publishing', at: RECOVERY, state: 'succeeded', evidence: recoveryEvidence('job-2') })).toMatchObject({ ok: true });
    const failed = await fixture('job-3'); toPublishing(failed.ownership, 'job-3'); seedLogs(failed.path, 'job-3');
    const failedResult = failed.ownership.apiWrite({ kind: 'publish-recovery', jobId: 'job-3', expectedState: 'publishing', at: RECOVERY, state: 'failed', evidence: recoveryEvidence('job-3', 'failed'), errorCode: 'PUBLISH_FAILED', error: { reason: 'final verification failed' } });
    expect(failedResult).toMatchObject({ ok: true });
    const incomplete = await fixture('job-4'); toPublishing(incomplete.ownership, 'job-4'); seedLogs(incomplete.path, 'job-4');
    expect(incomplete.ownership.apiWrite({ kind: 'publish-recovery', jobId: 'job-4', expectedState: 'publishing', at: RECOVERY, state: 'succeeded', evidence: { ...recoveryEvidence('job-4'), artifact: { ...recoveryEvidence('job-4').artifact, manifestSha256: SHA64_B } } })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
    expect(failed.store.getJob('job-3')).toMatchObject({ state: 'failed', artifactStagingPath: 'staging/image', publishState: 'blocked' });
  });

  it('commits failed publish recovery for missing, corrupt, and partial final evidence', async () => {
    const cases: Array<[string, (evidence: PublishRecoveryEvidence) => PublishRecoveryEvidence]> = [
      ['missing-sidecars', (evidence) => ({ ...evidence, observed: { ...evidence.observed, checksum: { present: false, path: 'staging/sums', contents: null, sha256: null }, manifest: { present: false, path: 'staging/manifest', bytes: null, content: null, sha256: null }, verification: { present: false, path: 'staging/verify', bytes: null, content: null, sha256: null } } })],
      ['corrupt-sidecars', (evidence) => ({ ...evidence, observed: { ...evidence.observed, checksum: { present: true, path: 'staging/sums', contents: 'corrupt\n', sha256: SHA64_B }, manifest: { present: true, path: 'staging/manifest', bytes: 'not-json', content: null, sha256: SHA64_B }, verification: { present: true, path: 'staging/verify', bytes: '{"wrong":true}', content: { wrong: true }, sha256: SHA64_B } } })],
      ['partial-final', (evidence) => ({ ...evidence, observed: { ...evidence.observed, final: { present: true, path: 'release/partial-final/image', held: true, size: 3, sha256: SHA64_B } } })],
    ];
    for (const [jobId, alter] of cases) {
      const target = await fixture(jobId); toPublishing(target.ownership, jobId); seedLogs(target.path, jobId);
      const result = target.ownership.apiWrite({ kind: 'publish-recovery', jobId, expectedState: 'publishing', at: RECOVERY, state: 'failed', evidence: alter(recoveryEvidence(jobId, 'failed')), errorCode: 'PUBLISH_FAILED', error: { reason: jobId } });
      expect(result.ok).toBe(true); expect(target.store.getJob(jobId)).toMatchObject({ state: 'failed', publishState: 'blocked', artifactStagingPath: 'staging/image' });
      expect(target.store.listEvents(jobId).events.at(-2)?.payload).toMatchObject({ kind: 'publish-recovery', state: 'failed' });
    }
  });

  it('rejects publish recovery final observation mismatches', async () => {
    const { ownership, path } = await fixture('final-mismatch'); toPublishing(ownership, 'final-mismatch'); seedLogs(path, 'final-mismatch');
    const evidence = recoveryEvidence('final-mismatch');
    expect(ownership.apiWrite({ kind: 'publish-recovery', jobId: 'final-mismatch', expectedState: 'publishing', at: RECOVERY, state: 'succeeded', evidence: { ...evidence, observed: { ...evidence.observed, final: { ...evidence.observed.final, size: 11 } } } })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
  });

  it('rejects publish recovery checksum content mismatches', async () => {
    const { ownership, path } = await fixture('checksum-mismatch'); toPublishing(ownership, 'checksum-mismatch'); seedLogs(path, 'checksum-mismatch');
    const evidence = recoveryEvidence('checksum-mismatch');
    expect(ownership.apiWrite({ kind: 'publish-recovery', jobId: 'checksum-mismatch', expectedState: 'publishing', at: RECOVERY, state: 'succeeded', evidence: { ...evidence, observed: { ...evidence.observed, checksum: { ...evidence.observed.checksum, contents: 'wrong  image\n' } } } })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
  });

  it('rejects self-consistent wrong checksum content and persisted checksum divergence', async () => {
    const wrong = await fixture('checksum-basename'); toPublishing(wrong.ownership, 'checksum-basename'); seedLogs(wrong.path, 'checksum-basename');
    const wrongContents = `${SHA64}  other-image\n`;
    const wrongHash = createHash('sha256').update(wrongContents).digest('hex');
    expect(wrong.ownership.apiWrite({ kind: 'publish-recovery', jobId: 'checksum-basename', expectedState: 'publishing', at: RECOVERY, state: 'succeeded', evidence: { ...recoveryEvidence('checksum-basename'), observed: { ...recoveryEvidence('checksum-basename').observed, checksum: { present: true, path: 'release/checksum-basename/sha256sums', contents: wrongContents, sha256: wrongHash } } } })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
    const divergent = await fixture('checksum-persisted'); toPublishing(divergent.ownership, 'checksum-persisted'); seedLogs(divergent.path, 'checksum-persisted');
    const db = openBuilderDatabase(divergent.path); db.prepare('UPDATE jobs SET checksum_sha256=? WHERE job_id=?').run(SHA64_B, 'checksum-persisted'); db.close();
    expect(divergent.ownership.apiWrite({ kind: 'publish-recovery', jobId: 'checksum-persisted', expectedState: 'publishing', at: RECOVERY, state: 'succeeded', evidence: recoveryEvidence('checksum-persisted') })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
  });

  it('rejects publish recovery manifest content or recomputed hash mismatches', async () => {
    const { ownership, path } = await fixture('manifest-mismatch'); toPublishing(ownership, 'manifest-mismatch'); seedLogs(path, 'manifest-mismatch');
    const evidence = recoveryEvidence('manifest-mismatch');
    expect(ownership.apiWrite({ kind: 'publish-recovery', jobId: 'manifest-mismatch', expectedState: 'publishing', at: RECOVERY, state: 'succeeded', evidence: { ...evidence, observed: { ...evidence.observed, manifest: { ...evidence.observed.manifest, content: { ...evidence.observed.manifest.content!, branch: 'feature' } } } } })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
  });

  it('rejects verification sidecar path, bytes, and hash mismatches independently', async () => {
    for (const change of ['path', 'bytes', 'sha256'] as const) {
      const jobId = `verification-${change}`; const { ownership, path } = await fixture(jobId); toPublishing(ownership, jobId); seedLogs(path, jobId);
      const evidence = recoveryEvidence(jobId); const verification = change === 'path' ? { ...evidence.observed.verification, path: `release/${jobId}/wrong-verification.json` } : change === 'bytes' ? { ...evidence.observed.verification, bytes: `${evidence.observed.verification.bytes}\n` } : { ...evidence.observed.verification, sha256: SHA64_B };
      expect(ownership.apiWrite({ kind: 'publish-recovery', jobId, expectedState: 'publishing', at: RECOVERY, state: 'succeeded', evidence: { ...evidence, observed: { ...evidence.observed, verification } } })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
    }
  });

  it('rejects publish recovery staging and sealed-log observation mismatches', async () => {
    const stagingCase = await fixture('staging-mismatch'); toPublishing(stagingCase.ownership, 'staging-mismatch'); seedLogs(stagingCase.path, 'staging-mismatch');
    const evidence = recoveryEvidence('staging-mismatch');
    expect(stagingCase.ownership.apiWrite({ kind: 'publish-recovery', jobId: 'staging-mismatch', expectedState: 'publishing', at: RECOVERY, state: 'succeeded', evidence: { ...evidence, observed: { ...evidence.observed, staging: { state: 'present', path: 'staging/image', sha256: SHA64 } } } })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
    const logCase = await fixture('log-mismatch'); toPublishing(logCase.ownership, 'log-mismatch'); seedLogs(logCase.path, 'log-mismatch');
    const logEvidence = recoveryEvidence('log-mismatch');
    expect(() => logCase.ownership.apiWrite({ kind: 'publish-recovery', jobId: 'log-mismatch', expectedState: 'publishing', at: RECOVERY, state: 'succeeded', evidence: { ...logEvidence, observed: { ...logEvidence.observed, logs: { runner: 'sealed', docker: 'sealed', noGap: false } } as never } })).toThrow(OwnershipValidationError);
  });

  it('rejects recovery when persisted log generations are unsealed or have an uncovered tail', async () => {
    const unsealed = await fixture('unsealed-log'); toPublishing(unsealed.ownership, 'unsealed-log'); seedLogs(unsealed.path, 'unsealed-log');
    const open = openBuilderDatabase(unsealed.path); for (const stream of ['runner', 'docker']) open.prepare('INSERT INTO job_log_generations (job_id, stream, generation, path, started_at, size_bytes) VALUES (?, ?, 1, ?, ?, 0)').run('unsealed-log', stream, `logs/${stream}-1.log`, NOW); open.close();
    expect(unsealed.ownership.apiWrite({ kind: 'publish-recovery', jobId: 'unsealed-log', expectedState: 'publishing', at: RECOVERY, state: 'succeeded', evidence: recoveryEvidence('unsealed-log') })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
    const gap = await fixture('log-tail'); toPublishing(gap.ownership, 'log-tail'); seedLogGap(gap.path, 'log-tail');
    expect(gap.ownership.apiWrite({ kind: 'publish-recovery', jobId: 'log-tail', expectedState: 'publishing', at: RECOVERY, state: 'succeeded', evidence: recoveryEvidence('log-tail') })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
  });

  it('accepts contiguous normal and orphan-tail log ranges and rejects uncovered bytes', async () => {
    const fullTail = await fixture('full-tail'); toPublishing(fullTail.ownership, 'full-tail'); seedLogRanges(fullTail.path, 'full-tail', [[0, 10, 'log_orphan_tail']]);
    expect(fullTail.ownership.apiWrite({ kind: 'publish-recovery', jobId: 'full-tail', expectedState: 'publishing', at: RECOVERY, state: 'succeeded', evidence: recoveryEvidence('full-tail') }).ok).toBe(true);
    const mixed = await fixture('mixed-tail'); toPublishing(mixed.ownership, 'mixed-tail'); seedLogRanges(mixed.path, 'mixed-tail', [[0, 4, 'log'], [4, 6, 'log_orphan_tail']]);
    expect(mixed.ownership.apiWrite({ kind: 'publish-recovery', jobId: 'mixed-tail', expectedState: 'publishing', at: RECOVERY, state: 'succeeded', evidence: recoveryEvidence('mixed-tail') }).ok).toBe(true);
    const gap = await fixture('tail-gap'); toPublishing(gap.ownership, 'tail-gap'); seedLogUncoveredTail(gap.path, 'tail-gap');
    expect(gap.ownership.apiWrite({ kind: 'publish-recovery', jobId: 'tail-gap', expectedState: 'publishing', at: RECOVERY, state: 'succeeded', evidence: recoveryEvidence('tail-gap') })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
  });

  it('supports immutable runner operation begin/complete and no raw SQLite error taxonomy', async () => {
    let fail = true; const { ownership, path } = await fixture('job-1'); const injectedDb = openBuilderDatabase(path); const injected = new OwnershipStore(injectedDb, { now: () => NOW, failBeforeCommit: () => { if (fail) throw new Error('rollback injection'); } }); closers.push(() => injectedDb.close());
    expect(() => injected.apiWrite(dispatch())).toThrow(OwnershipTransactionError); fail = false; expect(ownership.apiWrite(dispatch()).ok).toBe(true);
    ownership.runnerWrite(lease()); const begin: RunnerWriteCommand = { ...runnerBase(), kind: 'operation-begin', expectedState: 'starting', operationId: 'activate-target', attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW }; expect(ownership.runnerWrite(begin).ok).toBe(true);
    const complete = { ...runnerBase(), kind: 'operation-complete' as const, expectedState: 'starting' as const, operationId: 'activate-target' as const, attempt: 1, input: { operationId: 'activate-target' as const, attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW, finishedAt: LATER, timedOut: false, lifecyclePhase: 'not_created' as const, containerMount: null, containerEnvironment: null, containerSecurity: null, inspection: null, exitCode: 1, signal: null, outcome: 'failed' as const, evidencePath: 'evidence/op', evidenceSha256: SHA64, errorCode: 'BUILD_FAILED' as const, error: { reason: 'process never created' } } };
    expect(ownership.runnerWrite(complete)).toMatchObject({ ok: true, kind: 'committed' });
    expect(ownership.runnerWrite(complete)).toMatchObject({ ok: true, kind: 'idempotent' });
    expect(ownership.runnerWrite({ ...complete, input: { ...complete.input, evidencePath: 'evidence/changed' } })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
    expect(ownership.runnerWrite({ ...runnerBase(), at: LATER, kind: 'operation-cleanup', expectedState: 'starting', operationId: 'activate-target', attempt: 1, proof: { kind: 'null-identity', container: absent(LATER), logs: { ...logs, verifiedAt: LATER } } })).toMatchObject({ ok: true });
    const verifyDb = openBuilderDatabase(path); try { expect(verifyDb.prepare('SELECT COUNT(*) AS count FROM job_events WHERE event_type=\'operation\'').get()).toBeDefined(); } finally { verifyDb.close(); }
  });

  it('retains started-container identity through operation result and clears only exact cleanup', async () => {
    const { ownership, store } = await fixture(); ownership.apiWrite(dispatch()); ownership.runnerWrite(lease());
    const begin: RunnerWriteCommand = { ...runnerBase(), kind: 'operation-begin', expectedState: 'starting', operationId: 'activate-target', attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW };
    expect(ownership.runnerWrite(begin).ok).toBe(true); expect(ownership.runnerWrite(container()).ok).toBe(true);
    const input = { operationId: 'activate-target' as const, attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW, finishedAt: LATER, timedOut: false, lifecyclePhase: 'started' as const, containerId: 'container-job-1', containerName: 'osi-job-1', containerImageDigest: SHA64_B, containerLabelJobId: 'job-1', containerLabelManifestSha: SHA64, containerMount: { source: '/tmp', destination: '/work' }, containerEnvironment: { CI: '1' }, containerSecurity: { user: '1000:1000' }, inspection: { running: true }, exitCode: 1, signal: null, outcome: 'failed' as const, evidencePath: 'evidence/op', evidenceSha256: SHA64, errorCode: 'BUILD_FAILED' as const, error: { reason: 'build failed' } };
    expect(ownership.runnerWrite({ ...runnerBase(), kind: 'operation-complete', expectedState: 'starting', operationId: 'activate-target', attempt: 1, input: { ...input, containerId: 'wrong' } })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
    expect(store.getJob('job-1').containerId).toBe('container-job-1'); expect(ownership.runnerWrite({ ...runnerBase(), kind: 'operation-complete', expectedState: 'starting', operationId: 'activate-target', attempt: 1, input }).ok).toBe(true);
    const resultEvents = store.listEvents('job-1').events.length;
    expect(ownership.runnerWrite({ ...runnerBase(), at: LATER, leaseExpiresAt: ACTIVE, kind: 'operation-begin', expectedState: 'starting', operationId: 'copy-feed-config', attempt: 1, argvHash: SHA64, argv: ['copy'], startedAt: LATER })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
    expect(store.listEvents('job-1').events).toHaveLength(resultEvents);
    expect(ownership.runnerWrite({ ...runnerBase(), at: LATER, kind: 'operation-cleanup', expectedState: 'starting', operationId: 'activate-target', attempt: 1, proof: { kind: 'container-removed', id: 'container-job-1', name: 'osi-job-1', imageDigest: SHA64_B, labels: { 'org.osi.image-builder.job-id': 'job-1', 'org.osi.image-builder.manifest-sha': SHA64 }, stoppedAt: NOW, removedAt: LATER, observedAt: LATER, globalLabelResult: 'no-match', logs } }).ok).toBe(true);
    expect(store.getJob('job-1').containerId).toBeNull();
  });

  it('reopens cleanly between an operation result and its container cleanup', async () => {
    const { ownership, path, store } = await fixture('operation-reopen'); ownership.apiWrite(dispatch('operation-reopen')); ownership.runnerWrite(lease(ACTIVE, 'operation-reopen'));
    ownership.runnerWrite({ ...runnerBase('operation-reopen'), kind: 'operation-begin', expectedState: 'starting', operationId: 'activate-target', attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW });
    ownership.runnerWrite({ ...container('operation-reopen'), leaseExpiresAt: ACTIVE, at: NOW });
    const input = { operationId: 'activate-target' as const, attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW, finishedAt: LATER, timedOut: false, lifecyclePhase: 'started' as const, containerId: 'container-operation-reopen', containerName: 'osi-operation-reopen', containerImageDigest: SHA64_B, containerLabelJobId: 'operation-reopen', containerLabelManifestSha: SHA64, containerMount: { source: '/tmp', destination: '/work' }, containerEnvironment: { CI: '1' }, containerSecurity: { user: '1000:1000' }, inspection: { running: true }, exitCode: 1, signal: null, outcome: 'failed' as const, evidencePath: 'evidence/op', evidenceSha256: SHA64, errorCode: 'BUILD_FAILED' as const, error: { reason: 'crash window' } };
    ownership.runnerWrite({ ...runnerBase('operation-reopen'), kind: 'operation-complete', expectedState: 'starting', operationId: 'activate-target', attempt: 1, input });
    const reopenedDb = openBuilderDatabase(path); const reopened = new OwnershipStore(reopenedDb, { now: () => NOW }); closers.push(() => reopenedDb.close());
    expect(store.getJob('operation-reopen').containerId).toBe('container-operation-reopen');
    expect(reopened.runnerWrite({ ...runnerBase('operation-reopen'), at: LATER, kind: 'operation-cleanup', expectedState: 'starting', operationId: 'activate-target', attempt: 1, proof: { kind: 'container-removed', id: 'container-operation-reopen', name: 'osi-operation-reopen', imageDigest: SHA64_B, labels: { 'org.osi.image-builder.job-id': 'operation-reopen', 'org.osi.image-builder.manifest-sha': SHA64 }, stoppedAt: NOW, removedAt: LATER, observedAt: LATER, globalLabelResult: 'no-match', logs } }).ok).toBe(true);
    const postCleanupDb = openBuilderDatabase(path); const postCleanup = new OwnershipStore(postCleanupDb, { now: () => NOW }); closers.push(() => postCleanupDb.close());
    expect(postCleanup.runnerWrite({ ...runnerBase('operation-reopen'), at: LATER, kind: 'operation-begin', expectedState: 'starting', operationId: 'copy-feed-config', attempt: 1, argvHash: SHA64_B, argv: ['copy'], startedAt: LATER }).ok).toBe(true);
    expect(store.getJob('operation-reopen').containerId).toBeNull(); expect(store.getOperation('operation-reopen', 'activate-target', 1)).toMatchObject({ outcome: 'failed' });
  });

  it('reopens after external exact absence before cleanup CAS and keeps the identity blocker', async () => {
    const { ownership, path, store } = await fixture('operation-external-absence'); ownership.apiWrite(dispatch('operation-external-absence')); ownership.runnerWrite(lease(ACTIVE, 'operation-external-absence'));
    ownership.runnerWrite({ ...runnerBase('operation-external-absence'), kind: 'operation-begin', expectedState: 'starting', operationId: 'activate-target', attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW });
    ownership.runnerWrite({ ...container('operation-external-absence'), leaseExpiresAt: ACTIVE, at: NOW });
    const input = { operationId: 'activate-target' as const, attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW, finishedAt: LATER, timedOut: false, lifecyclePhase: 'started' as const, containerId: 'container-operation-external-absence', containerName: 'osi-operation-external-absence', containerImageDigest: SHA64_B, containerLabelJobId: 'operation-external-absence', containerLabelManifestSha: SHA64, containerMount: { source: '/tmp', destination: '/work' }, containerEnvironment: { CI: '1' }, containerSecurity: { user: '1000:1000' }, inspection: { running: true }, exitCode: 1, signal: null, outcome: 'failed' as const, evidencePath: 'evidence/op', evidenceSha256: SHA64, errorCode: 'BUILD_FAILED' as const, error: { reason: 'external removal' } };
    ownership.runnerWrite({ ...runnerBase('operation-external-absence'), kind: 'operation-complete', expectedState: 'starting', operationId: 'activate-target', attempt: 1, input });

    const beforeCleanupDb = openBuilderDatabase(path); const beforeCleanup = new OwnershipStore(beforeCleanupDb, { now: () => NOW }); closers.push(() => beforeCleanupDb.close());
    expect(beforeCleanup.runnerWrite({ ...runnerBase('operation-external-absence'), at: LATER, kind: 'operation-begin', expectedState: 'starting', operationId: 'copy-feed-config', attempt: 1, argvHash: SHA64_B, argv: ['copy'], startedAt: LATER })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
    expect(beforeCleanup.runnerWrite({ ...runnerBase('operation-external-absence'), at: LATER, kind: 'stage', expectedState: 'starting', state: 'preflight', stage: 'preflight', outcome: 'running', startedAt: LATER })).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
    expect(store.getJob('operation-external-absence').containerId).toBe('container-operation-external-absence');

    const cleanupDb = openBuilderDatabase(path); const cleanup = new OwnershipStore(cleanupDb, { now: () => NOW }); closers.push(() => cleanupDb.close());
    expect(cleanup.runnerWrite({ ...runnerBase('operation-external-absence'), at: LATER, kind: 'operation-cleanup', expectedState: 'starting', operationId: 'activate-target', attempt: 1, proof: { kind: 'container-removed', id: 'container-operation-external-absence', name: 'osi-operation-external-absence', imageDigest: SHA64_B, labels: { 'org.osi.image-builder.job-id': 'operation-external-absence', 'org.osi.image-builder.manifest-sha': SHA64 }, stoppedAt: NOW, removedAt: LATER, observedAt: LATER, globalLabelResult: 'no-match', logs } }).ok).toBe(true);
    const afterCleanupDb = openBuilderDatabase(path); const afterCleanup = new OwnershipStore(afterCleanupDb, { now: () => NOW }); closers.push(() => afterCleanupDb.close());
    expect(afterCleanup.runnerWrite({ ...runnerBase('operation-external-absence'), at: LATER, kind: 'operation-begin', expectedState: 'starting', operationId: 'copy-feed-config', attempt: 1, argvHash: SHA64_B, argv: ['copy'], startedAt: LATER }).ok).toBe(true);
    expect(store.getJob('operation-external-absence').containerId).toBeNull();
  });

  it('wins once across two SQLite connections and emits no orphan event', async () => {
    const { path } = await fixture(); const dbA = openBuilderDatabase(path); const dbB = openBuilderDatabase(path); const a = new OwnershipStore(dbA, { now: () => NOW }); const b = new OwnershipStore(dbB, { now: () => NOW }); closers.push(() => dbA.close(), () => dbB.close());
    expect(a.apiWrite(dispatch()).ok).toBe(true); expect(b.apiWrite(dispatch())).toMatchObject({ ok: false, conflict: { kind: 'stale-predecessor' } }); const verify = openBuilderDatabase(path); expect((verify.prepare("SELECT COUNT(*) AS count FROM job_events WHERE event_type='dispatch'").get() as { count: number }).count).toBe(1); verify.close();
  });

  it('serializes runner-vs-fence and cleanup completion races without orphan events', async () => {
    const fenced = await fixture(); fenced.ownership.apiWrite(dispatch()); fenced.ownership.runnerWrite(lease()); fenced.ownership.runnerWrite(container());
    const dbB = openBuilderDatabase(fenced.path); const apiB = new OwnershipStore(dbB, { now: () => NOW }); closers.push(() => dbB.close());
    const admission = cleanupAdmission(snapshot()); expect(fenced.ownership.apiWrite(admission).ok).toBe(true);
    const before = eventCount(fenced.store); expect(apiB.runnerWrite({ ...runnerBase(), at: RECOVERY, leaseExpiresAt: ACTIVE, kind: 'stage', expectedState: 'starting', state: 'preflight', stage: 'preflight', outcome: 'running', startedAt: RECOVERY })).toMatchObject({ ok: false, conflict: { kind: 'fenced' } }); expect(eventCount(fenced.store)).toBe(before);
    const claim: CleanupWriteCommand = { kind: 'claim-lease', jobId: 'job-1', admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: snapshot(), at: RECOVERY }; expect(fenced.ownership.cleanupWrite(claim).ok).toBe(true);
    const complete: CleanupWriteCommand = { kind: 'complete', jobId: 'job-1', admissionId: admission.admissionId, owner: 'cleanup-a', unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: snapshot(), postcondition: postcondition(snapshot()), exactContainerId: 'container-job-1', containerAbsent: true, evidencePath: 'recovery/cleanup.json', evidenceSha256: SHA64, at: RECOVERY };
    expect(fenced.ownership.cleanupWrite(complete).ok).toBe(true); const after = eventCount(fenced.store); expect(apiB.cleanupWrite(complete)).toMatchObject({ ok: false }); expect(eventCount(fenced.store)).toBe(after);
  });

  it('classifies delayed runner writes against an existing fence without masking intrinsic chronology errors', async () => {
    const delayed = await fixture('delayed-runner-fence');
    delayed.ownership.apiWrite(dispatch('delayed-runner-fence'));
    delayed.ownership.runnerWrite(lease(ACTIVE, 'delayed-runner-fence'));
    expect(delayed.ownership.apiWrite(cleanupAdmission(snapshot('absent', 'delayed-runner-fence'), 'delayed-runner-fence')).ok).toBe(true);
    const before = delayed.store.listEvents('delayed-runner-fence').events.length;

    const validDelayedStage: RunnerWriteCommand = {
      ...runnerBase('delayed-runner-fence'), at: LATER, kind: 'stage', expectedState: 'starting', state: 'preflight',
      stage: 'preflight', outcome: 'running', startedAt: LATER,
    };
    expect(delayed.ownership.runnerWrite(validDelayedStage)).toMatchObject({ ok: false, conflict: { kind: 'fenced' } });
    expect(delayed.store.listEvents('delayed-runner-fence').events).toHaveLength(before);

    const malformedDelayedStage: RunnerWriteCommand = {
      ...validDelayedStage, at: AFTER, startedAt: LATER, finishedAt: NOW, outcome: 'passed',
      evidencePath: 'evidence/preflight', evidenceSha256: SHA64,
    };
    expect(() => delayed.ownership.runnerWrite(malformedDelayedStage)).toThrow(OwnershipValidationError);
    expect(delayed.store.listEvents('delayed-runner-fence').events).toHaveLength(before);
  });

  it('classifies delayed lease acquisition and renewal against a cleanup fence without mutation', async () => {
    const acquireCase = await fixture('delayed-acquire-fence');
    acquireCase.ownership.apiWrite(dispatch('delayed-acquire-fence'));
    expect(acquireCase.ownership.apiWrite(cleanupAdmission(nullLeaseSnapshot('delayed-acquire-fence'), 'delayed-acquire-fence')).ok).toBe(true);
    const acquireEvents = acquireCase.store.listEvents('delayed-acquire-fence').events.length;
    const acquireBefore = acquireCase.store.getJob('delayed-acquire-fence');
    expect(acquireCase.ownership.runnerWrite({ ...lease(ACTIVE, 'delayed-acquire-fence'), at: LATER })).toMatchObject({ ok: false, conflict: { kind: 'fenced' } });
    expect(acquireCase.store.listEvents('delayed-acquire-fence').events).toHaveLength(acquireEvents);
    expect(acquireCase.store.getJob('delayed-acquire-fence')).toEqual(acquireBefore);

    const renewCase = await fixture('delayed-renew-fence');
    renewCase.ownership.apiWrite(dispatch('delayed-renew-fence'));
    renewCase.ownership.runnerWrite(lease(ACTIVE, 'delayed-renew-fence'));
    renewCase.ownership.runnerWrite(container('delayed-renew-fence'));
    expect(renewCase.ownership.apiWrite(cleanupAdmission(snapshot('present', 'delayed-renew-fence'), 'delayed-renew-fence')).ok).toBe(true);
    const renewEvents = renewCase.store.listEvents('delayed-renew-fence').events.length;
    const renewBefore = renewCase.store.getJob('delayed-renew-fence');
    expect(renewCase.ownership.runnerWrite({
      kind: 'renew-lease', jobId: 'delayed-renew-fence', runnerUnit: 'osi-image-builder-runner@delayed-renew-fence.service', owner: 'runner-a',
      expectedExpiresAt: ACTIVE, expiresAt: '2026-07-23T10:02:30.000Z', at: LATER,
    })).toMatchObject({ ok: false, conflict: { kind: 'fenced' } });
    expect(renewCase.store.listEvents('delayed-renew-fence').events).toHaveLength(renewEvents);
    expect(renewCase.store.getJob('delayed-renew-fence')).toEqual(renewBefore);
  });

  it('rejects malformed lease timestamps before BEGIN', async () => {
    const acquireCase = await fixture('malformed-acquire-timestamp'); let acquireBegins = 0;
    const acquire = new OwnershipStore(acquireCase.db, { now: () => NOW, beforeBegin: () => { acquireBegins += 1; } });
    expect(() => acquire.runnerWrite({ ...lease(ACTIVE, 'malformed-acquire-timestamp'), at: 'not-an-instant' } as never)).toThrow(OwnershipValidationError);
    expect(acquireBegins).toBe(0); expect(acquireCase.store.listEvents('malformed-acquire-timestamp').events).toHaveLength(1);

    const renewCase = await fixture('malformed-renew-timestamp'); renewCase.ownership.apiWrite(dispatch('malformed-renew-timestamp')); renewCase.ownership.runnerWrite(lease(ACTIVE, 'malformed-renew-timestamp')); let renewBegins = 0;
    const renew = new OwnershipStore(renewCase.db, { now: () => NOW, beforeBegin: () => { renewBegins += 1; } });
    expect(() => renew.runnerWrite({ kind: 'renew-lease', jobId: 'malformed-renew-timestamp', runnerUnit: 'osi-image-builder-runner@malformed-renew-timestamp.service', owner: 'runner-a', expectedExpiresAt: 'not-an-instant', expiresAt: EXPIRY, at: LATER } as never)).toThrow(OwnershipValidationError);
    expect(renewBegins).toBe(0); expect(renewCase.store.listEvents('malformed-renew-timestamp').events).toHaveLength(3);
  });

  it('classifies delayed container writes after direct interruption and hand-back as stale predecessors', async () => {
    const handBackCase = await claimedCleanup('delayed-container-hand-back');
    const complete: CleanupWriteCommand = { kind: 'complete', jobId: 'delayed-container-hand-back', admissionId: handBackCase.admission.admissionId, owner: 'cleanup-a', unitName: handBackCase.admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: handBackCase.snapshot, postcondition: postcondition(handBackCase.snapshot), exactContainerId: 'container-delayed-container-hand-back', containerAbsent: true, evidencePath: 'recovery/cleanup.json', evidenceSha256: SHA64, at: RECOVERY };
    handBackCase.ownership.cleanupWrite(complete);
    handBackCase.ownership.apiWrite({ kind: 'hand-back', jobId: 'delayed-container-hand-back', admissionId: handBackCase.admission.admissionId, owner: 'cleanup-a', unitName: handBackCase.admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, at: RECOVERY, proof: { runner: handBackCase.snapshot.runner, container: absent(RECOVERY), blocker: 'none' } });
    const handBackEvents = handBackCase.store.listEvents('delayed-container-hand-back').events.length;
    const handBackBefore = handBackCase.store.getJob('delayed-container-hand-back');
    expect(handBackCase.ownership.runnerWrite({ ...container('delayed-container-hand-back'), at: LATER, occurredAt: LATER })).toMatchObject({ ok: false, conflict: { kind: 'stale-predecessor' } });
    expect(handBackCase.store.listEvents('delayed-container-hand-back').events).toHaveLength(handBackEvents);
    expect(handBackCase.store.getJob('delayed-container-hand-back')).toEqual(handBackBefore);

    const directCase = await fixture('delayed-container-direct');
    directCase.ownership.apiWrite(dispatch('delayed-container-direct')); directCase.ownership.runnerWrite(lease(ACTIVE, 'delayed-container-direct'));
    directCase.ownership.apiWrite({ kind: 'direct-interrupt', jobId: 'delayed-container-direct', expectedState: 'starting', at: RECOVERY, proof: direct('active', 'delayed-container-direct'), errorCode: 'RUNNER_DISAPPEARED', error: { reason: 'delayed container' } });
    const directEvents = directCase.store.listEvents('delayed-container-direct').events.length;
    const directBefore = directCase.store.getJob('delayed-container-direct');
    expect(directCase.ownership.runnerWrite({ ...container('delayed-container-direct'), at: LATER, occurredAt: LATER })).toMatchObject({ ok: false, conflict: { kind: 'stale-predecessor' } });
    expect(directCase.store.listEvents('delayed-container-direct').events).toHaveLength(directEvents);
    expect(directCase.store.getJob('delayed-container-direct')).toEqual(directBefore);
  });

  it('rejects malformed container lifecycle and derived chronology before a fence can mask them', async () => {
    const target = await fixture('malformed-container-fence');
    target.ownership.apiWrite(dispatch('malformed-container-fence')); target.ownership.runnerWrite(lease(ACTIVE, 'malformed-container-fence')); target.ownership.runnerWrite(container('malformed-container-fence'));
    expect(target.ownership.apiWrite(cleanupAdmission(snapshot('present', 'malformed-container-fence'), 'malformed-container-fence')).ok).toBe(true);
    const before = target.store.listEvents('malformed-container-fence').events.length;
    expect(() => target.ownership.runnerWrite({ ...container('malformed-container-fence'), lifecycle: 'not_created' } as never)).toThrow(OwnershipValidationError);
    expect(() => target.ownership.runnerWrite({ ...container('malformed-container-fence'), at: RECOVERY, occurredAt: AFTER })).toThrow(OwnershipValidationError);
    expect(target.store.listEvents('malformed-container-fence').events).toHaveLength(before);
  });

  it('returns one loser result under held two-connection dispatch, fence, and cleanup overlap', async () => {
    const dispatchRace = await fixture('dispatch-race'); const lock = openBuilderDatabase(dispatchRace.path); const dbB = openBuilderDatabase(dispatchRace.path, { busyTimeoutMs: 1 }); const b = new OwnershipStore(dbB, { now: () => NOW }); closers.push(() => lock.close(), () => dbB.close());
    lock.exec('BEGIN IMMEDIATE'); expect(b.apiWrite(dispatch('dispatch-race'))).toMatchObject({ ok: false, conflict: { kind: 'cas-lost' } }); lock.exec('ROLLBACK'); expect(dispatchRace.ownership.apiWrite(dispatch('dispatch-race')).ok).toBe(true); expect(dispatchRace.store.listEvents('dispatch-race').events).toHaveLength(2);

    const fenceRace = await fixture('fence-race'); fenceRace.ownership.apiWrite(dispatch('fence-race')); fenceRace.ownership.runnerWrite(lease(ACTIVE, 'fence-race')); fenceRace.ownership.runnerWrite(container('fence-race')); const admission = cleanupAdmission(snapshot('present', 'fence-race'), 'fence-race'); expect(fenceRace.ownership.apiWrite(admission).ok).toBe(true);
    const fenceLock = openBuilderDatabase(fenceRace.path); const fenceDbB = openBuilderDatabase(fenceRace.path, { busyTimeoutMs: 1 }); const fenceRunner = new OwnershipStore(fenceDbB, { now: () => NOW }); closers.push(() => fenceLock.close(), () => fenceDbB.close()); fenceLock.exec('BEGIN IMMEDIATE'); expect(fenceRunner.runnerWrite({ ...runnerBase('fence-race'), kind: 'stage', expectedState: 'starting', state: 'preflight', stage: 'preflight', outcome: 'running', startedAt: NOW })).toMatchObject({ ok: false, conflict: { kind: 'cas-lost' } }); fenceLock.exec('ROLLBACK');

    const cleanupRace = await claimedCleanup('cleanup-race'); const complete: CleanupWriteCommand = { kind: 'complete', jobId: 'cleanup-race', admissionId: cleanupRace.admission.admissionId, owner: 'cleanup-a', unitName: cleanupRace.admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: cleanupRace.snapshot, postcondition: postcondition(cleanupRace.snapshot), exactContainerId: 'container-cleanup-race', containerAbsent: true, evidencePath: 'recovery/cleanup.json', evidenceSha256: SHA64, at: RECOVERY };
    const cleanupLock = openBuilderDatabase(cleanupRace.path); const cleanupDbB = openBuilderDatabase(cleanupRace.path, { busyTimeoutMs: 1 }); const cleanupB = new OwnershipStore(cleanupDbB, { now: () => NOW }); closers.push(() => cleanupLock.close(), () => cleanupDbB.close()); cleanupLock.exec('BEGIN IMMEDIATE'); const loser = cleanupB.cleanupWrite(complete); expect(loser).toMatchObject({ ok: false, conflict: { kind: 'cas-lost' } }); cleanupLock.exec('ROLLBACK'); expect(cleanupRace.ownership.cleanupWrite(complete).ok).toBe(true); expect(cleanupRace.store.listEvents('cleanup-race').events).toHaveLength(7);
  });

  it('wins exactly once under true worker-thread overlap for dispatch, fence, and cleanup', async () => {
    const dispatchRace = await fixture('worker-dispatch');
    const dispatchResults = await synchronizedWorkers(dispatchRace.path, [['api', dispatch('worker-dispatch')], ['api', dispatch('worker-dispatch')]]) as Array<{ ok: boolean }>;
    expect(dispatchResults.filter((result) => result.ok)).toHaveLength(1); expect(dispatchRace.store.listEvents('worker-dispatch').events.filter((event) => event.eventType === 'dispatch')).toHaveLength(1);

    const fenceRace = await fixture('worker-fence'); fenceRace.ownership.apiWrite(dispatch('worker-fence')); fenceRace.ownership.runnerWrite(lease(ACTIVE, 'worker-fence'));
    const fenceSnapshot = snapshot('absent', 'worker-fence'); const fenceAdmission = cleanupAdmission(fenceSnapshot, 'worker-fence');
    const [runnerResult, admissionResult] = await synchronizedWorkers(fenceRace.path, [
      ['runner', { ...runnerBase('worker-fence'), kind: 'stage', expectedState: 'starting', state: 'preflight', stage: 'preflight', outcome: 'running', startedAt: NOW }],
      ['api', fenceAdmission],
    ]) as Array<{ ok: boolean }>;
    expect(runnerResult.ok === admissionResult.ok).toBe(false); expect(fenceRace.store.listEvents('worker-fence').events.filter((event) => event.eventType === 'stage' || event.eventType === 'cleanup_admission')).toHaveLength(1);

    const cleanupRace = await claimedCleanup('worker-cleanup'); const complete: CleanupWriteCommand = { kind: 'complete', jobId: 'worker-cleanup', admissionId: cleanupRace.admission.admissionId, owner: 'cleanup-a', unitName: cleanupRace.admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: cleanupRace.snapshot, postcondition: postcondition(cleanupRace.snapshot), exactContainerId: 'container-worker-cleanup', containerAbsent: true, evidencePath: 'recovery/cleanup.json', evidenceSha256: SHA64, at: RECOVERY };
    const cleanupResults = await synchronizedWorkers(cleanupRace.path, [['cleanup', complete], ['cleanup', complete]]) as Array<{ ok: boolean }>;
    expect(cleanupResults.filter((result) => result.ok)).toHaveLength(1); expect(cleanupRace.store.listEvents('worker-cleanup').events.filter((event) => event.eventType === 'cleanup_complete')).toHaveLength(1);
  });

  it('rolls back each recovery subcommand without partial rows or events', async () => {
    const rollback = (path: string) => failingOwnership(path);

    const admissionCase = await fixture('rollback-admission-each');
    admissionCase.ownership.apiWrite(dispatch('rollback-admission-each')); admissionCase.ownership.runnerWrite(lease(ACTIVE, 'rollback-admission-each'));
    const admissionSnapshot = snapshot('absent', 'rollback-admission-each'); const admission = cleanupAdmission(admissionSnapshot, 'rollback-admission-each');
    const admissionEvents = admissionCase.store.listEvents('rollback-admission-each').events.length;
    expect(() => rollback(admissionCase.path).apiWrite({ ...admission, at: RECOVERY })).toThrow(OwnershipTransactionError);
    expect(admissionCase.store.listEvents('rollback-admission-each').events).toHaveLength(admissionEvents);
    { const db = openBuilderDatabase(admissionCase.path); expect(db.prepare('SELECT cleanup_fence_generation, cleanup_admission_id FROM jobs WHERE job_id=?').get('rollback-admission-each')).toEqual({ cleanup_fence_generation: null, cleanup_admission_id: null }); db.close(); }

    const claimCase = await fixture('rollback-claim-each'); claimCase.ownership.apiWrite(dispatch('rollback-claim-each')); claimCase.ownership.runnerWrite(lease(ACTIVE, 'rollback-claim-each')); claimCase.ownership.runnerWrite(container('rollback-claim-each')); const claimSnapshot = snapshot('present', 'rollback-claim-each'); const claimAdmission = cleanupAdmission(claimSnapshot, 'rollback-claim-each'); claimCase.ownership.apiWrite(claimAdmission); const claim: CleanupWriteCommand = { kind: 'claim-lease', jobId: 'rollback-claim-each', admissionId: claimAdmission.admissionId, owner: 'cleanup-a', unitName: claimAdmission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: claimSnapshot, at: RECOVERY }; const claimEvents = claimCase.store.listEvents('rollback-claim-each').events.length;
    expect(() => rollback(claimCase.path).cleanupWrite(claim)).toThrow(OwnershipTransactionError);
    expect(claimCase.store.listEvents('rollback-claim-each').events).toHaveLength(claimEvents);
    { const db = openBuilderDatabase(claimCase.path); expect((db.prepare('SELECT cleanup_fence_generation FROM jobs WHERE job_id=?').get('rollback-claim-each') as { cleanup_fence_generation: number }).cleanup_fence_generation).toBe(1); db.close(); }

    const renewCase = await claimedCleanup('rollback-renew-each'); const renew: CleanupWriteCommand = { kind: 'renew-lease', jobId: 'rollback-renew-each', admissionId: renewCase.admission.admissionId, owner: 'cleanup-a', unitName: renewCase.admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, expectedExpiresAt: EXPIRY, expiresAt: '2026-07-23T10:05:00.000Z', snapshot: renewCase.snapshot, at: RECOVERY }; const renewEvents = renewCase.store.listEvents('rollback-renew-each').events.length;
    expect(() => rollback(renewCase.path).cleanupWrite(renew)).toThrow(OwnershipTransactionError);
    expect(renewCase.store.listEvents('rollback-renew-each').events).toHaveLength(renewEvents);
    { const db = openBuilderDatabase(renewCase.path); expect((db.prepare('SELECT expires_at FROM cleanup_leases WHERE admission_id=?').get(renewCase.admission.admissionId) as { expires_at: string }).expires_at).toBe(EXPIRY); db.close(); }

    const evidenceCase = await fixture('rollback-evidence-each'); evidenceCase.ownership.apiWrite(dispatch('rollback-evidence-each')); evidenceCase.ownership.runnerWrite(lease(ACTIVE, 'rollback-evidence-each')); evidenceCase.ownership.runnerWrite({ ...runnerBase('rollback-evidence-each'), kind: 'artifact', expectedState: 'starting', state: 'starting', stagingPath: 'staging/image', artifactSha256: SHA64, artifactSize: 10, artifactMtime: NOW, checksumPath: 'staging/sums', checksumSha256: checksumHash(), manifestPath: 'staging/manifest', manifestSha256: manifestHash('rollback-evidence-each'), verificationPath: 'staging/verify', verificationSha256: verificationHash('rollback-evidence-each') });
    const evidenceSnapshot = stagedSnapshot('rollback-evidence-each'); const evidenceAdmission = cleanupAdmission(evidenceSnapshot, 'rollback-evidence-each'); evidenceCase.ownership.apiWrite(evidenceAdmission);
    const evidenceClaim: CleanupWriteCommand = { kind: 'claim-lease', jobId: 'rollback-evidence-each', admissionId: evidenceAdmission.admissionId, owner: 'cleanup-a', unitName: evidenceAdmission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: evidenceSnapshot, at: RECOVERY }; evidenceCase.ownership.cleanupWrite(evidenceClaim);
    const evidenceEvents = evidenceCase.store.listEvents('rollback-evidence-each').events.length;
    const evidence: CleanupWriteCommand = { kind: 'evidence', jobId: 'rollback-evidence-each', admissionId: evidenceAdmission.admissionId, owner: 'cleanup-a', unitName: evidenceAdmission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: evidenceSnapshot, status: 'blocking', blockerCode: 'QUARANTINE_PENDING', blocker: { reason: 'rollback' }, at: RECOVERY };
    expect(() => rollback(evidenceCase.path).cleanupWrite(evidence)).toThrow(OwnershipTransactionError);
    expect(evidenceCase.store.listEvents('rollback-evidence-each').events).toHaveLength(evidenceEvents); { const db = openBuilderDatabase(evidenceCase.path); expect((db.prepare('SELECT cleanup_blocker_code FROM jobs WHERE job_id=?').get('rollback-evidence-each') as { cleanup_blocker_code: string | null }).cleanup_blocker_code).toBeNull(); db.close(); }

    const completeCase = await claimedCleanup('rollback-complete-each'); const complete: CleanupWriteCommand = { kind: 'complete', jobId: 'rollback-complete-each', admissionId: completeCase.admission.admissionId, owner: 'cleanup-a', unitName: completeCase.admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: completeCase.snapshot, postcondition: postcondition(completeCase.snapshot), exactContainerId: 'container-rollback-complete-each', containerAbsent: true, evidencePath: 'recovery/cleanup.json', evidenceSha256: SHA64, at: RECOVERY }; const completeEvents = completeCase.store.listEvents('rollback-complete-each').events.length;
    expect(() => rollback(completeCase.path).cleanupWrite(complete)).toThrow(OwnershipTransactionError);
    expect(completeCase.store.listEvents('rollback-complete-each').events).toHaveLength(completeEvents); expect(completeCase.store.getJob('rollback-complete-each').containerId).toBe('container-rollback-complete-each');

    completeCase.ownership.cleanupWrite(complete); const handBack: ApiWriteCommand = { kind: 'hand-back', jobId: 'rollback-complete-each', admissionId: completeCase.admission.admissionId, owner: 'cleanup-a', unitName: completeCase.admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, at: RECOVERY, proof: { runner: completeCase.snapshot.runner, container: absent(RECOVERY), blocker: 'none' } }; const handBackEvents = completeCase.store.listEvents('rollback-complete-each').events.length;
    expect(() => rollback(completeCase.path).apiWrite(handBack)).toThrow(OwnershipTransactionError);
    expect(completeCase.store.listEvents('rollback-complete-each').events).toHaveLength(handBackEvents); { const db = openBuilderDatabase(completeCase.path); expect((db.prepare('SELECT cleanup_fence_generation FROM jobs WHERE job_id=?').get('rollback-complete-each') as { cleanup_fence_generation: number }).cleanup_fence_generation).toBe(1); db.close(); }

    const cancellationCase = await fixture('rollback-cancellation'); cancellationCase.ownership.apiWrite(dispatch('rollback-cancellation')); cancellationCase.ownership.runnerWrite(lease(EXPIRY, 'rollback-cancellation')); cancellationCase.ownership.apiWrite({ kind: 'request-cancellation', jobId: 'rollback-cancellation', reason: 'stop', at: NOW }); cancellationCase.ownership.runnerWrite({ ...runnerBase('rollback-cancellation'), leaseExpiresAt: EXPIRY, kind: 'cancellation-transition', expectedState: 'starting' });
    const cancellationProof = { kind: 'pre-container' as const, runnerUnit: runnerBase('rollback-cancellation').runnerUnit, unitInactiveAt: LATER, container: absent(), staging, logs }; const cancellationCleanup: RunnerWriteCommand = { ...runnerBase('rollback-cancellation'), at: LATER, leaseExpiresAt: EXPIRY, kind: 'cancellation-cleanup', expectedState: 'cancel_requested', proof: cancellationProof }; const cancellationEvents = cancellationCase.store.listEvents('rollback-cancellation').events.length;
    expect(() => rollback(cancellationCase.path).runnerWrite(cancellationCleanup)).toThrow(OwnershipTransactionError);
    expect(cancellationCase.store.listEvents('rollback-cancellation').events).toHaveLength(cancellationEvents); expect(cancellationCase.store.getJob('rollback-cancellation').state).toBe('cancel_requested');
    const cleanupResult = cancellationCase.ownership.runnerWrite(cancellationCleanup); expect(cleanupResult.ok).toBe(true); const terminal: RunnerWriteCommand = { ...runnerBase('rollback-cancellation'), at: LATER, leaseExpiresAt: EXPIRY, kind: 'cancellation-terminal', expectedState: 'cancel_requested', terminalAt: LATER, cleanupEventSeq: eventSeq(cleanupResult) }; const terminalEvents = cancellationCase.store.listEvents('rollback-cancellation').events.length;
    expect(() => rollback(cancellationCase.path).runnerWrite(terminal)).toThrow(OwnershipTransactionError);
    expect(cancellationCase.store.listEvents('rollback-cancellation').events).toHaveLength(terminalEvents); expect(cancellationCase.store.getJob('rollback-cancellation').state).toBe('cancel_requested');

    const publishCase = await fixture('rollback-publish-recovery'); toPublishing(publishCase.ownership, 'rollback-publish-recovery'); seedLogs(publishCase.path, 'rollback-publish-recovery'); const publishEvents = publishCase.store.listEvents('rollback-publish-recovery').events.length;
    expect(() => rollback(publishCase.path).apiWrite({ kind: 'publish-recovery', jobId: 'rollback-publish-recovery', expectedState: 'publishing', at: RECOVERY, state: 'succeeded', evidence: recoveryEvidence('rollback-publish-recovery') })).toThrow(OwnershipTransactionError);
    expect(publishCase.store.listEvents('rollback-publish-recovery').events).toHaveLength(publishEvents); expect(publishCase.store.getJob('rollback-publish-recovery')).toMatchObject({ state: 'publishing', publishState: 'publishing' });

    const operationBeginCase = await fixture('rollback-operation-begin'); operationBeginCase.ownership.apiWrite(dispatch('rollback-operation-begin')); operationBeginCase.ownership.runnerWrite(lease(ACTIVE, 'rollback-operation-begin')); const begin: RunnerWriteCommand = { ...runnerBase('rollback-operation-begin'), kind: 'operation-begin', expectedState: 'starting', operationId: 'activate-target', attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW }; const beginEvents = operationBeginCase.store.listEvents('rollback-operation-begin').events.length;
    expect(() => rollback(operationBeginCase.path).runnerWrite(begin)).toThrow(OwnershipTransactionError); expect(operationBeginCase.store.getOperation('rollback-operation-begin', 'activate-target', 1)).toBeNull(); expect(operationBeginCase.store.listEvents('rollback-operation-begin').events).toHaveLength(beginEvents);

    const operationCompleteCase = await fixture('rollback-operation-complete'); operationCompleteCase.ownership.apiWrite(dispatch('rollback-operation-complete')); operationCompleteCase.ownership.runnerWrite(lease(ACTIVE, 'rollback-operation-complete')); operationCompleteCase.ownership.runnerWrite({ ...runnerBase('rollback-operation-complete'), kind: 'operation-begin', expectedState: 'starting', operationId: 'activate-target', attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW }); const operationInput = { operationId: 'activate-target' as const, attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW, finishedAt: LATER, timedOut: false, lifecyclePhase: 'not_created' as const, containerMount: null, containerEnvironment: null, containerSecurity: null, inspection: null, exitCode: 1, signal: null, outcome: 'failed' as const, evidencePath: 'evidence/op', evidenceSha256: SHA64, errorCode: 'BUILD_FAILED' as const, error: { reason: 'rollback' } }; const operationComplete: RunnerWriteCommand = { ...runnerBase('rollback-operation-complete'), kind: 'operation-complete', expectedState: 'starting', operationId: 'activate-target', attempt: 1, input: operationInput }; const operationCompleteEvents = operationCompleteCase.store.listEvents('rollback-operation-complete').events.length;
    expect(() => rollback(operationCompleteCase.path).runnerWrite(operationComplete)).toThrow(OwnershipTransactionError); expect(operationCompleteCase.store.getOperation('rollback-operation-complete', 'activate-target', 1)).toMatchObject({ outcome: null }); expect(operationCompleteCase.store.listEvents('rollback-operation-complete').events).toHaveLength(operationCompleteEvents);

    const operationCleanupCase = await fixture('rollback-operation-cleanup'); operationCleanupCase.ownership.apiWrite(dispatch('rollback-operation-cleanup')); operationCleanupCase.ownership.runnerWrite(lease(ACTIVE, 'rollback-operation-cleanup')); operationCleanupCase.ownership.runnerWrite({ ...runnerBase('rollback-operation-cleanup'), kind: 'operation-begin', expectedState: 'starting', operationId: 'activate-target', attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW }); operationCleanupCase.ownership.runnerWrite({ ...container('rollback-operation-cleanup'), leaseExpiresAt: ACTIVE, at: NOW }); const cleanupInput = { ...operationInput, containerId: 'container-rollback-operation-cleanup', containerName: 'osi-rollback-operation-cleanup', containerImageDigest: SHA64_B, containerLabelJobId: 'rollback-operation-cleanup', containerLabelManifestSha: SHA64, containerMount: { source: '/tmp', destination: '/work' }, containerEnvironment: { CI: '1' }, containerSecurity: { user: '1000:1000' }, inspection: { running: true }, lifecyclePhase: 'started' as const }; operationCleanupCase.ownership.runnerWrite({ ...runnerBase('rollback-operation-cleanup'), kind: 'operation-complete', expectedState: 'starting', operationId: 'activate-target', attempt: 1, input: cleanupInput });
    const operationCleanup: RunnerWriteCommand = { ...runnerBase('rollback-operation-cleanup'), at: LATER, kind: 'operation-cleanup', expectedState: 'starting', operationId: 'activate-target', attempt: 1, proof: { kind: 'container-removed', id: 'container-rollback-operation-cleanup', name: 'osi-rollback-operation-cleanup', imageDigest: SHA64_B, labels: { 'org.osi.image-builder.job-id': 'rollback-operation-cleanup', 'org.osi.image-builder.manifest-sha': SHA64 }, stoppedAt: NOW, removedAt: LATER, observedAt: LATER, globalLabelResult: 'no-match', logs } }; const operationCleanupEvents = operationCleanupCase.store.listEvents('rollback-operation-cleanup').events.length;
    expect(() => rollback(operationCleanupCase.path).runnerWrite(operationCleanup)).toThrow(OwnershipTransactionError); expect(operationCleanupCase.store.getJob('rollback-operation-cleanup').containerId).toBe('container-rollback-operation-cleanup'); expect(operationCleanupCase.store.listEvents('rollback-operation-cleanup').events).toHaveLength(operationCleanupEvents);
  });

  it('rolls back cancellation request, runner lease, container, artifact, live publish, and direct interruption independently', async () => {
    const cancellation = await fixture('rollback-cancellation-request'); cancellation.ownership.apiWrite(dispatch('rollback-cancellation-request')); const cancellationEvents = cancellation.store.listEvents('rollback-cancellation-request').events.length;
    expect(() => failingOwnership(cancellation.path).apiWrite({ kind: 'request-cancellation', jobId: 'rollback-cancellation-request', reason: 'rollback', at: NOW })).toThrow(OwnershipTransactionError);
    expect(cancellation.store.listEvents('rollback-cancellation-request').events).toHaveLength(cancellationEvents); expect(cancellation.store.getJob('rollback-cancellation-request').cancelRequestedAt).toBeNull();

    const runnerLeaseCase = await fixture('rollback-runner-lease'); runnerLeaseCase.ownership.apiWrite(dispatch('rollback-runner-lease')); const leaseEvents = runnerLeaseCase.store.listEvents('rollback-runner-lease').events.length;
    expect(() => failingOwnership(runnerLeaseCase.path).runnerWrite(lease(ACTIVE, 'rollback-runner-lease'))).toThrow(OwnershipTransactionError);
    { const db = openBuilderDatabase(runnerLeaseCase.path); expect(db.prepare('SELECT runner_lease_owner, runner_lease_expires_at FROM jobs WHERE job_id=?').get('rollback-runner-lease')).toEqual({ runner_lease_owner: null, runner_lease_expires_at: null }); db.close(); }
    expect(runnerLeaseCase.store.listEvents('rollback-runner-lease').events).toHaveLength(leaseEvents);

    const containerCase = await fixture('rollback-container'); containerCase.ownership.apiWrite(dispatch('rollback-container')); containerCase.ownership.runnerWrite(lease(ACTIVE, 'rollback-container')); const containerEvents = containerCase.store.listEvents('rollback-container').events.length;
    expect(() => failingOwnership(containerCase.path).runnerWrite(container('rollback-container'))).toThrow(OwnershipTransactionError);
    expect(containerCase.store.getJob('rollback-container').containerId).toBeNull(); expect(containerCase.store.listEvents('rollback-container').events).toHaveLength(containerEvents);

    const artifactCase = await fixture('rollback-artifact'); artifactCase.ownership.apiWrite(dispatch('rollback-artifact')); artifactCase.ownership.runnerWrite(lease(ACTIVE, 'rollback-artifact')); const artifactEvents = artifactCase.store.listEvents('rollback-artifact').events.length;
    expect(() => failingOwnership(artifactCase.path).runnerWrite({ ...runnerBase('rollback-artifact'), kind: 'artifact', expectedState: 'starting', state: 'starting', stagingPath: 'staging/image', artifactSha256: SHA64, artifactSize: 10, artifactMtime: NOW, checksumPath: 'staging/sums', checksumSha256: checksumHash(), manifestPath: 'staging/manifest', manifestSha256: manifestHash('rollback-artifact'), verificationPath: 'staging/verify', verificationSha256: verificationHash('rollback-artifact') })).toThrow(OwnershipTransactionError);
    expect(artifactCase.store.getJob('rollback-artifact').artifactStagingPath).toBeNull(); expect(artifactCase.store.listEvents('rollback-artifact').events).toHaveLength(artifactEvents);

    const publishCase = await fixture('rollback-live-publish'); toPublishing(publishCase.ownership, 'rollback-live-publish'); const publishEvents = publishCase.store.listEvents('rollback-live-publish').events.length;
    expect(() => failingOwnership(publishCase.path).runnerWrite({ ...runnerBase('rollback-live-publish'), kind: 'publish', expectedState: 'publishing', state: 'blocked', blockerCode: 'PUBLISH_FAILED', blocker: { reason: 'rollback' } })).toThrow(OwnershipTransactionError);
    expect(publishCase.store.getJob('rollback-live-publish').publishState).toBe('publishing'); expect(publishCase.store.listEvents('rollback-live-publish').events).toHaveLength(publishEvents);

    const directCase = await fixture('rollback-direct-interrupt'); directCase.ownership.apiWrite(dispatch('rollback-direct-interrupt')); const directEvents = directCase.store.listEvents('rollback-direct-interrupt').events.length;
    expect(() => failingOwnership(directCase.path).apiWrite({ kind: 'direct-interrupt', jobId: 'rollback-direct-interrupt', expectedState: 'starting', at: RECOVERY, proof: direct('start-failure', 'rollback-direct-interrupt'), errorCode: 'RUNNER_DISAPPEARED', error: { reason: 'rollback' } })).toThrow(OwnershipTransactionError);
    expect(directCase.store.getJob('rollback-direct-interrupt').state).toBe('starting'); expect(directCase.store.listEvents('rollback-direct-interrupt').events).toHaveLength(directEvents);
  });

  it('composes actor writes inside a caller transaction using an isolated savepoint', async () => {
    const { path, store } = await fixture();
    const db = openBuilderDatabase(path); const ownership = new OwnershipStore(db, { now: () => NOW }); closers.push(() => db.close());
    db.exec('BEGIN IMMEDIATE');
    expect(ownership.apiWrite({ kind: 'enqueue', input: {
      jobId: 'nested-job', requestId: 'nested-request', request: { branch: 'main' }, sourceRemote: 'git@example.com:osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main', expectedSha: SHA40, pinnedSha: SHA40, sourcePreparation: SOURCE_PREPARATION, targetId: 'rpi-5', rootId: 'release', targetManifestSha256: SHA64, sourceCommitTime: NOW, sourceAuthor: 'Phil', sourceSubject: 'nested', acceptedAt: NOW,
    } }).ok).toBe(true);
    expect(db.isTransaction).toBe(true); db.exec('COMMIT'); expect(store.getJob('nested-job').state).toBe('queued');
  });

  it('rolls back each actor command family without an orphan event', async () => {
    const inject = (path: string): OwnershipStore => { const db = openBuilderDatabase(path); const ownership = new OwnershipStore(db, { now: () => NOW, failBeforeCommit: () => { throw new Error('injected rollback'); } }); closers.push(() => db.close()); return ownership; };
    const enqueue = await fixture('rollback-enqueue'); const enqueueBefore = enqueue.store.listEvents('rollback-enqueue').events.length;
    expect(() => inject(enqueue.path).apiWrite({ kind: 'enqueue', input: { jobId: 'rollback-enqueued', requestId: 'rollback-enqueued', request: { branch: 'main' }, sourceRemote: 'git@example.com:osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main', expectedSha: SHA40, pinnedSha: SHA40, sourcePreparation: SOURCE_PREPARATION, targetId: 'rpi-5', rootId: 'release', targetManifestSha256: SHA64, sourceCommitTime: NOW, sourceAuthor: 'Phil', sourceSubject: 'rollback', acceptedAt: NOW } })).toThrow(OwnershipTransactionError); expect(enqueue.store.listEvents('rollback-enqueue').events).toHaveLength(enqueueBefore);

    const dispatchCase = await fixture('rollback-dispatch'); expect(() => inject(dispatchCase.path).apiWrite(dispatch('rollback-dispatch'))).toThrow(OwnershipTransactionError); expect(dispatchCase.store.getJob('rollback-dispatch').state).toBe('queued');
    const stageCase = await fixture('rollback-stage'); stageCase.ownership.apiWrite(dispatch('rollback-stage')); stageCase.ownership.runnerWrite(lease(ACTIVE, 'rollback-stage')); const stageEvents = stageCase.store.listEvents('rollback-stage').events.length; expect(() => inject(stageCase.path).runnerWrite({ ...runnerBase('rollback-stage'), kind: 'stage', expectedState: 'starting', state: 'preflight', stage: 'preflight', outcome: 'running', startedAt: NOW })).toThrow(OwnershipTransactionError); expect(stageCase.store.listEvents('rollback-stage').events).toHaveLength(stageEvents);
    const operationCase = await fixture('rollback-operation'); operationCase.ownership.apiWrite(dispatch('rollback-operation')); operationCase.ownership.runnerWrite(lease(ACTIVE, 'rollback-operation')); operationCase.ownership.runnerWrite({ ...runnerBase('rollback-operation'), kind: 'operation-begin', expectedState: 'starting', operationId: 'activate-target', attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW }); const operationInput = { operationId: 'activate-target' as const, attempt: 1, argvHash: SHA64, argv: ['make'], startedAt: NOW, finishedAt: LATER, timedOut: false, lifecyclePhase: 'not_created' as const, containerMount: null, containerEnvironment: null, containerSecurity: null, inspection: null, exitCode: 1, signal: null, outcome: 'failed' as const, evidencePath: 'evidence/op', evidenceSha256: SHA64, errorCode: 'BUILD_FAILED' as const, error: { reason: 'rollback' } }; expect(() => inject(operationCase.path).runnerWrite({ ...runnerBase('rollback-operation'), kind: 'operation-complete', expectedState: 'starting', operationId: 'activate-target', attempt: 1, input: operationInput })).toThrow(OwnershipTransactionError); expect(operationCase.store.getOperation('rollback-operation', 'activate-target', 1)).toMatchObject({ outcome: null });
    const terminalCase = await fixture('rollback-terminal'); terminalCase.ownership.apiWrite(dispatch('rollback-terminal')); terminalCase.ownership.runnerWrite(lease(ACTIVE, 'rollback-terminal')); terminalCase.ownership.runnerWrite({ ...runnerBase('rollback-terminal'), kind: 'stage', expectedState: 'starting', state: 'preflight', stage: 'preflight', outcome: 'running', startedAt: NOW }); expect(() => inject(terminalCase.path).runnerWrite({ ...runnerBase('rollback-terminal'), kind: 'normal-terminal', expectedState: 'preflight', state: 'failed', terminalAt: LATER, errorCode: 'BUILD_FAILED', error: { reason: 'rollback' } })).toThrow(OwnershipTransactionError); expect(terminalCase.store.getJob('rollback-terminal').state).toBe('preflight');
    const freshnessCase = await fixture('rollback-freshness'); freshnessCase.ownership.apiWrite({ kind: 'freshness-request', jobId: 'rollback-freshness', at: NOW }); expect(() => inject(freshnessCase.path).apiWrite({ kind: 'freshness-result', jobId: 'rollback-freshness', at: LATER, input: { status: 'fresh', pinnedSha: SHA40, observedSha: SHA40, checkedAt: LATER } })).toThrow(OwnershipTransactionError); expect(freshnessCase.store.getJob('rollback-freshness').freshnessStatus).toBeNull();
    const admissionCase = await fixture('rollback-admission'); admissionCase.ownership.apiWrite(dispatch('rollback-admission')); admissionCase.ownership.runnerWrite(lease(ACTIVE, 'rollback-admission')); const admissionSnapshot = snapshot('absent', 'rollback-admission'); expect(() => inject(admissionCase.path).apiWrite({ ...cleanupAdmission(admissionSnapshot, 'rollback-admission'), at: RECOVERY })).toThrow(OwnershipTransactionError); { const db = openBuilderDatabase(admissionCase.path); expect((db.prepare('SELECT cleanup_fence_generation FROM jobs WHERE job_id=?').get('rollback-admission') as { cleanup_fence_generation: number | null }).cleanup_fence_generation).toBeNull(); db.close(); }
    const completionCase = await claimedCleanup('rollback-completion'); const completion: CleanupWriteCommand = { kind: 'complete', jobId: 'rollback-completion', admissionId: completionCase.admission.admissionId, owner: 'cleanup-a', unitName: completionCase.admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: completionCase.snapshot, postcondition: postcondition(completionCase.snapshot), exactContainerId: 'container-rollback-completion', containerAbsent: true, evidencePath: 'recovery/cleanup.json', evidenceSha256: SHA64, at: RECOVERY }; expect(() => inject(completionCase.path).cleanupWrite(completion)).toThrow(OwnershipTransactionError); expect(completionCase.store.getJob('rollback-completion').containerId).toBe('container-rollback-completion');
    completionCase.ownership.cleanupWrite(completion); expect(() => inject(completionCase.path).apiWrite({ kind: 'hand-back', jobId: 'rollback-completion', admissionId: completionCase.admission.admissionId, owner: 'cleanup-a', unitName: completionCase.admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, at: RECOVERY, proof: { runner: completionCase.snapshot.runner, container: absent(RECOVERY), blocker: 'none' } })).toThrow(OwnershipTransactionError); { const db = openBuilderDatabase(completionCase.path); expect((db.prepare('SELECT cleanup_fence_generation FROM jobs WHERE job_id=?').get('rollback-completion') as { cleanup_fence_generation: number }).cleanup_fence_generation).toBe(1); db.close(); }
  });

  it('rolls back only the nested savepoint when a caller transaction write fails', async () => {
    const { path } = await fixture();
    const db = openBuilderDatabase(path); let fail = true; const ownership = new OwnershipStore(db, { now: () => NOW, failBeforeCommit: () => { if (fail) throw new Error('nested failure'); } }); closers.push(() => db.close());
    db.exec('BEGIN IMMEDIATE');
    expect(() => ownership.apiWrite({ kind: 'enqueue', input: { jobId: 'nested-fail', requestId: 'nested-fail', request: { branch: 'main' }, sourceRemote: 'git@example.com:osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main', expectedSha: SHA40, pinnedSha: SHA40, sourcePreparation: SOURCE_PREPARATION, targetId: 'rpi-5', rootId: 'release', targetManifestSha256: SHA64, sourceCommitTime: NOW, sourceAuthor: 'Phil', sourceSubject: 'nested', acceptedAt: NOW } })).toThrow(OwnershipTransactionError);
    expect(db.isTransaction).toBe(true); db.exec('COMMIT'); expect(db.prepare('SELECT 1 FROM jobs WHERE job_id=?').get('nested-fail')).toBeUndefined(); fail = false;
  });

  it('returns one conflict shape for duplicate admission, stale CAS, and busy locks', async () => {
    const { path, ownership } = await fixture();
    const duplicate = { kind: 'enqueue' as const, input: {
      jobId: 'duplicate', requestId: 'duplicate-request', request: { branch: 'main' }, sourceRemote: 'git@example.com:osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main', expectedSha: SHA40, pinnedSha: SHA40, sourcePreparation: SOURCE_PREPARATION, targetId: 'rpi-5' as const, rootId: 'release', targetManifestSha256: SHA64, sourceCommitTime: NOW, sourceAuthor: 'Phil', sourceSubject: 'duplicate', acceptedAt: NOW,
    } };
    expect(ownership.apiWrite(duplicate).ok).toBe(true); expect(ownership.apiWrite(duplicate)).toMatchObject({ ok: false, conflict: { kind: 'admission-mismatch' } });
    expect(ownership.apiWrite(dispatch('missing'))).toMatchObject({ ok: false });
    const db = openBuilderDatabase(path, { busyTimeoutMs: 1 }); const busy = new OwnershipStore(db, { now: () => NOW }); closers.push(() => db.close());
    const lock = openBuilderDatabase(path); lock.exec('BEGIN IMMEDIATE'); closers.push(() => lock.close());
    expect(busy.apiWrite(dispatch())).toMatchObject({ ok: false, conflict: { kind: 'cas-lost' } });
    lock.exec('ROLLBACK');
  });
});

describe('Task 7 recovery proof chronology', () => {
  it('rejects intrinsic recovery proof chronology before BEGIN', async () => {
    const { db, store } = await fixture('proof-chronology'); let beginAttempts = 0;
    const guarded = new OwnershipStore(db, { now: () => NOW, beforeBegin: () => { beginAttempts += 1; } });
    const expectPureReject = (command: object) => expect(() => {
      if ((command as { actor?: string }).actor === 'runner') guarded.runnerWrite(command as never);
      else guarded.apiWrite(command as never);
    }).toThrow(OwnershipValidationError);

    expectPureReject({ kind: 'direct-interrupt', jobId: 'proof-chronology', expectedState: 'starting', at: RECOVERY, proof: { ...direct('start-failure', 'proof-chronology'), startAttemptedAt: LATER, unitInactiveAt: NOW }, errorCode: 'RUNNER_DISAPPEARED', error: { reason: 'start' } });
    expectPureReject({ actor: 'runner', ...runnerBase('proof-chronology'), at: LATER, kind: 'operation-cleanup', expectedState: 'starting', operationId: 'activate-target', attempt: 1, proof: { kind: 'null-identity', container: absent(), logs: { ...logs, verifiedAt: RECOVERY } } });
    expectPureReject({ actor: 'runner', ...runnerBase('proof-chronology'), at: RECOVERY, kind: 'cancellation-cleanup', expectedState: 'cancel_requested', proof: { kind: 'container', runnerUnit: runnerBase('proof-chronology').runnerUnit, unitInactiveAt: LATER, container: { kind: 'removed', id: 'id', name: 'name', imageDigest: SHA64, labels: { 'org.osi.image-builder.job-id': 'proof-chronology', 'org.osi.image-builder.manifest-sha': SHA64 }, stoppedAt: LATER, removedAt: NOW, observedAt: LATER, globalLabelResult: 'no-match' }, staging, logs } });
    expectPureReject({ kind: 'publish-recovery', jobId: 'proof-chronology', expectedState: 'publishing', at: RECOVERY, state: 'succeeded', evidence: { ...recoveryEvidence('proof-chronology'), runner: { ...recoveryEvidence('proof-chronology').runner, inactiveAt: RECOVERY, observedAt: LATER } } });
    expectPureReject({ kind: 'cleanup-admission', jobId: 'proof-chronology', admissionId: 'cln_0123456789abcdefghjkmnpqrs', owner: 'cleanup-a', unitName: 'osi-image-builder-cleanup@cln_0123456789abcdefghjkmnpqrs.service', expiresAt: EXPIRY, credentialRelativePath: 'recovery/cleanup-credentials/cln_0123456789abcdefghjkmnpqrs.token', credentialSha256: SHA64, fenceTokenHash: SHA64_B, snapshot: { ...snapshot('absent', 'proof-chronology'), runner: { ...snapshot('absent', 'proof-chronology').runner, inactiveAt: RECOVERY, observedAt: LATER } }, at: RECOVERY });
    expect(beginAttempts).toBe(0);
    expect(store.listEvents('proof-chronology').events).toHaveLength(1);
  });

  it('rejects future-only nested observations before BEGIN for every recovery command', async () => {
    const cases: Array<readonly [string, (guarded: OwnershipStore) => void]> = [
      ['direct interruption container', (guarded) => guarded.apiWrite({ kind: 'direct-interrupt', jobId: 'proof-future-direct', expectedState: 'starting', at: RECOVERY, proof: { ...direct('start-failure', 'proof-future-direct'), container: absent(AFTER) }, errorCode: 'RUNNER_DISAPPEARED', error: { reason: 'future' } })],
      ['direct interruption logs', (guarded) => guarded.apiWrite({ kind: 'direct-interrupt', jobId: 'proof-future-direct-logs', expectedState: 'starting', at: RECOVERY, proof: { ...direct('start-failure', 'proof-future-direct-logs'), logs: { ...logs, verifiedAt: AFTER } }, errorCode: 'RUNNER_DISAPPEARED', error: { reason: 'future' } })],
      ['cancellation cleanup', (guarded) => guarded.runnerWrite({ ...runnerBase('proof-future-cancel'), kind: 'cancellation-cleanup', expectedState: 'cancel_requested', proof: { kind: 'pre-container', runnerUnit: runnerBase('proof-future-cancel').runnerUnit, unitInactiveAt: LATER, container: absent(AFTER), staging, logs } })],
      ['operation cleanup logs', (guarded) => guarded.runnerWrite({ ...runnerBase('proof-future-operation'), kind: 'operation-cleanup', expectedState: 'starting', operationId: 'activate-target', attempt: 1, proof: { kind: 'null-identity', container: absent(), logs: { ...logs, verifiedAt: AFTER } } })],
      ['cleanup admission snapshot', (guarded) => guarded.apiWrite(cleanupAdmission({ ...snapshot('absent', 'proof-future-admission'), container: absent(AFTER) }, 'proof-future-admission'))],
      ['cleanup completion postcondition', (guarded) => guarded.cleanupWrite({ kind: 'complete', jobId: 'proof-future-complete', admissionId: 'cln_0123456789abcdefghjkmnpqrs', owner: 'cleanup-a', unitName: 'osi-image-builder-cleanup@cln_0123456789abcdefghjkmnpqrs.service', fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: snapshot('present', 'proof-future-complete'), postcondition: { ...postcondition(snapshot('present', 'proof-future-complete')), container: { ...postcondition(snapshot('present', 'proof-future-complete')).container, observedAt: AFTER } }, exactContainerId: 'container-proof-future-complete', containerAbsent: true, evidencePath: 'recovery/cleanup.json', evidenceSha256: SHA64, at: RECOVERY })],
      ['hand-back proof', (guarded) => guarded.apiWrite({ kind: 'hand-back', jobId: 'proof-future-handback', admissionId: 'cln_0123456789abcdefghjkmnpqrs', owner: 'cleanup-a', unitName: 'osi-image-builder-cleanup@cln_0123456789abcdefghjkmnpqrs.service', fenceGeneration: 1, fenceTokenHash: SHA64_B, at: RECOVERY, proof: { runner: snapshot('absent', 'proof-future-handback').runner, container: absent(AFTER), blocker: 'none' } })],
      ['publish recovery container', (guarded) => guarded.apiWrite({ kind: 'publish-recovery', jobId: 'proof-future-publish', expectedState: 'publishing', at: RECOVERY, state: 'succeeded', evidence: { ...recoveryEvidence('proof-future-publish'), container: absent(AFTER) } })],
    ];
    for (const [name, invoke] of cases) {
      const jobId = name.replaceAll(' ', '-'); const { db, store } = await fixture(`future-${jobId}`); let beginAttempts = 0;
      const guarded = new OwnershipStore(db, { now: () => NOW, beforeBegin: () => { beginAttempts += 1; } });
      expect(() => invoke(guarded), name).toThrow(OwnershipValidationError);
      expect(beginAttempts, `${name} BEGIN attempts`).toBe(0);
      expect(store.listEvents(`future-${jobId}`).events).toHaveLength(1);
    }
  });

  it('enforces stale-lease chronology before BEGIN and accepts delayed stale writes', async () => {
    for (const leaseStaleAt of [AFTER, NOW]) {
      const fixtureId = `stale-lease-${leaseStaleAt === AFTER ? 'future' : 'before-expiry'}`; const { db, store } = await fixture(fixtureId); let beginAttempts = 0;
      const guarded = new OwnershipStore(db, { now: () => NOW, beforeBegin: () => { beginAttempts += 1; } });
      const proof = direct('active', fixtureId) as Extract<DirectInterruptionProof, { kind: 'active' }>;
      expect(() => guarded.apiWrite({ kind: 'direct-interrupt', jobId: fixtureId, expectedState: 'starting', at: RECOVERY, proof: { ...proof, leaseStaleAt }, errorCode: 'RUNNER_DISAPPEARED', error: { reason: 'stale' } })).toThrow(OwnershipValidationError);
      expect(beginAttempts).toBe(0); expect(store.listEvents(fixtureId).events).toHaveLength(1);
    }

    const delayed = await fixture('stale-lease-delayed'); delayed.ownership.apiWrite(dispatch('stale-lease-delayed')); delayed.ownership.runnerWrite(lease(ACTIVE, 'stale-lease-delayed')); let beginAttempts = 0;
    const guarded = new OwnershipStore(delayed.db, { now: () => NOW, beforeBegin: () => { beginAttempts += 1; } });
    const result = guarded.apiWrite({ kind: 'direct-interrupt', jobId: 'stale-lease-delayed', expectedState: 'starting', at: AFTER, proof: direct('active', 'stale-lease-delayed'), errorCode: 'RUNNER_DISAPPEARED', error: { reason: 'delayed stale observation' } });
    expect(result.ok).toBe(true); expect(beginAttempts).toBe(1);
  });

  it('bounds null-identity cleanup observations before BEGIN and accepts delayed completion', async () => {
    const future = await fixture('null-cleanup-future'); const futureSnapshot = snapshot('absent', 'null-cleanup-future'); let futureBegins = 0;
    const guardedFuture = new OwnershipStore(future.db, { now: () => NOW, beforeBegin: () => { futureBegins += 1; } });
    const futurePost = { ...postcondition(futureSnapshot), container: { ...postcondition(futureSnapshot).container, observedAt: AFTER } };
    expect(() => guardedFuture.cleanupWrite({ kind: 'complete', jobId: 'null-cleanup-future', admissionId: 'cln_0123456789abcdefghjkmnpqrs', owner: 'cleanup-a', unitName: 'osi-image-builder-cleanup@cln_0123456789abcdefghjkmnpqrs.service', fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: futureSnapshot, postcondition: futurePost, exactContainerId: null, containerAbsent: true, evidencePath: 'recovery/cleanup.json', evidenceSha256: SHA64, at: RECOVERY })).toThrow(OwnershipValidationError);
    expect(futureBegins).toBe(0); expect(future.store.listEvents('null-cleanup-future').events).toHaveLength(1);

    const delayed = await fixture('null-cleanup-delayed'); delayed.ownership.apiWrite(dispatch('null-cleanup-delayed')); delayed.ownership.runnerWrite(lease(ACTIVE, 'null-cleanup-delayed')); const delayedSnapshot = snapshot('absent', 'null-cleanup-delayed'); const admission = cleanupAdmission(delayedSnapshot, 'null-cleanup-delayed');
    delayed.ownership.apiWrite(admission); delayed.ownership.cleanupWrite({ kind: 'claim-lease', jobId: 'null-cleanup-delayed', admissionId: admission.admissionId, owner: admission.owner, unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: delayedSnapshot, at: RECOVERY });
    let delayedBegins = 0; const guardedDelayed = new OwnershipStore(delayed.db, { now: () => NOW, beforeBegin: () => { delayedBegins += 1; } });
    const result = guardedDelayed.cleanupWrite({ kind: 'complete', jobId: 'null-cleanup-delayed', admissionId: admission.admissionId, owner: admission.owner, unitName: admission.unitName, fenceGeneration: 1, fenceTokenHash: SHA64_B, snapshot: delayedSnapshot, postcondition: postcondition(delayedSnapshot), exactContainerId: null, containerAbsent: true, evidencePath: 'recovery/cleanup.json', evidenceSha256: SHA64, at: AFTER });
    expect(result.ok).toBe(true); expect(delayedBegins).toBe(1);
  });
});
