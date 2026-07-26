import { describe, expect, it } from 'vitest';

import { loadManifest } from '../../manifest/validate.js';
import { createPipeline, recoverPublishing, type PipelineInput } from '../../runner/src/pipeline.js';
import type { JobRecord, JsonObject } from '../../api/src/store.js';
import type { RunnerWriteCommand } from '../../api/src/ownership.js';

const manifest = loadManifest(new URL('../../manifest/targets.json', import.meta.url).pathname).manifest;
const target = manifest.targets[0]!;
const SHA40 = 'a'.repeat(40);
const SHA256 = 'b'.repeat(64);
const lock = {
  schemaVersion: 1 as const, packageVersion: '2026.07.22.1', imageRepository: 'registry.example/osi-builder', imageDigest: SHA256,
  baseImage: `debian@sha256:${'c'.repeat(64)}`, baseImageDigest: 'c'.repeat(64), dockerfileSha256: 'd'.repeat(64),
  packageSet: ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libpolly-19-dev', 'libzstd-dev'],
  rustConfig: { llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.85.0', llvmMajor: 19 }, nodeVersion: '22.5.0', executionDefinitionSha256: 'e'.repeat(64), validationEvidenceSha256: 'f'.repeat(64), installable: true,
};

const job = {
  jobId: 'job-pipeline', requestId: 'request', request: {}, sourceRemote: 'git@github.com:Open-Smart-Irrigation/osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main', expectedSha: SHA40, pinnedSha: SHA40, sourceCommitTime: '2026-07-26T09:00:00.000Z', sourceAuthor: 'builder', sourceSubject: 'subject', targetId: 'rpi-5', rootId: 'release', targetManifestSha256: SHA256, acceptedAt: '2026-07-26T09:01:00.000Z', state: 'starting', currentStage: null, queueState: 'dispatched', queuePosition: null, cancelRequestedAt: null, cancelReason: null, dispatchedAt: '2026-07-26T09:02:00.000Z', runnerUnit: 'osi-image-builder-runner@job-pipeline.service', runnerLeaseOwner: null, runnerLeaseExpiresAt: null, containerId: null, containerName: null, containerImageDigest: null, containerLabelJobId: null, containerLabelManifestSha: null, containerLabels: null, containerMount: null, containerEnvironment: null, containerSecurity: null, containerInspection: null, containerCreatedAt: null, containerStartedAt: null, containerStoppedAt: null, containerRemovedAt: null, containerCleanupOutcome: null, terminalErrorCode: null, terminalError: null, terminalAt: null, artifactStagingPath: 'root/.osi-image-builder/staging/job-pipeline', artifactQuarantinePath: null, artifactFinalDirectory: null, artifactFinalPath: null, artifactSha256: '1'.repeat(64), artifactSize: 100, artifactMtime: '2026-07-26T09:10:00.000Z', checksumPath: 'root/sha256sums', checksumSha256: '2'.repeat(64), manifestPath: 'root/build-manifest.json', manifestSha256: '3'.repeat(64), verificationPath: 'root/verification.json', verificationSha256: '4'.repeat(64), publishState: 'staged', publishStartedAt: null, publishedAt: null, freshnessStatus: null, freshnessObservedSha: null, newerSourceAvailable: null, freshnessRequestedAt: null, freshnessCheckedAt: null, freshnessErrorCode: null, freshnessError: null, freshnessErrorEvidencePath: null, freshnessErrorEvidenceSha256: null,
} as unknown as JobRecord;

function input(overrides: Partial<PipelineInput> = {}): PipelineInput {
  const writes: RunnerWriteCommand[] = [];
  let current = job;
  const base: PipelineInput = {
    jobId: job.jobId, runnerUnit: job.runnerUnit!, owner: 'runner-owner', leaseExpiresAt: '2026-07-26T12:00:00.000Z', clock: { now: () => '2026-07-26T10:00:00.000Z' },
    store: { getJob: () => current, runnerWrite: (command) => { writes.push(command); if (command.kind === 'publish' && command.state === 'publishing') current = { ...current, state: 'publishing', publishState: 'publishing' }; if (command.kind === 'publish' && command.state === 'published') current = { ...current, publishState: 'published', artifactStagingPath: null, artifactFinalPath: command.finalPath ?? null, artifactFinalDirectory: command.finalDirectory ?? null, publishedAt: command.publishedAt ?? null }; return { ok: true, kind: 'committed', eventSeq: writes.length, value: undefined }; } },
    manifest, target, targetManifestSha256: SHA256, builderLock: lock, builderLockSha256: '9'.repeat(64), configMetadata: { selectedTarget: target.openwrtTarget, profile: target.profile, rootfsPartSize: target.rootfsPartSize }, toolMetadata: { nodeVersion: '22.5.0', npmVersion: '10.8.2' },
    operationRunner: { run: async ({ operationId, definition }) => ({ result: { argv: definition.argv, exitCode: 0, signal: null, stdout: operationId, stderr: '', timedOut: false, startedAt: '2026-07-26T10:00:00.000Z', finishedAt: '2026-07-26T10:00:01.000Z' }, outcome: 'passed', lifecyclePhase: 'not_created' }) },
    evidenceWriter: { write: async ({ stage }) => ({ path: `jobs/${job.jobId}/evidence/${stage}.json`, sha256: SHA256 }) },
    operationEvidenceWriter: { write: async () => ({ path: `jobs/${job.jobId}/operations.json`, sha256: SHA256 }) },
    metadataWriter: { write: async () => ({ manifestPath: 'root/build-manifest.json', manifestSha256: '3'.repeat(64), verificationPath: 'root/verification.json', verificationSha256: '4'.repeat(64), checksumPath: 'root/sha256sums', checksumSha256: '2'.repeat(64) }) },
    publisher: { publish: async () => ({ available: true, published: true, quarantined: false, selfTest: false, mutationCount: 1, renameResult: 'RENAMED' as const }) } as PipelineInput['publisher'],
    publisherRequest: { rootId: 'release', jobId: job.jobId, branchSlug: 'main', sourceSha: SHA40, targetId: 'rpi-5' },
    postRenameVerify: async () => ({ verified: true as const, finalPath: 'main/a/rpi-5/image.img.gz' }),
    hooks: { verify: async () => ({ artifact: { stagingPath: job.artifactStagingPath!, artifactSha256: job.artifactSha256!, artifactSize: job.artifactSize!, artifactMtime: job.artifactMtime! }, verification: { ok: true } }) },
  };
  void writes;
  return { ...base, ...overrides };
}

describe('normal runner pipeline', () => {
  it('runs the ten stages in order and persists metadata before success', async () => {
    const events: string[] = [];
    const value = input({
      evidenceWriter: { write: async ({ stage }) => { events.push(`evidence:${stage}`); return { path: `evidence/${stage}`, sha256: SHA256 }; } },
      store: { getJob: () => job, runnerWrite: (command) => { events.push(`${command.kind}:${command.kind === 'stage' ? command.stage : command.kind === 'publish' ? command.state : ''}`); return { ok: true, kind: 'committed', eventSeq: events.length, value: undefined }; } },
    });
    const result = await createPipeline(value).run();
    expect(result.state).toBe('succeeded');
    expect(result.buildManifest).toMatchObject({ schemaVersion: 1, packageVersion: lock.packageVersion, imageRepository: lock.imageRepository, imageDigest: lock.imageDigest, baseImage: lock.baseImage, baseImageDigest: lock.baseImageDigest, dockerfileSha256: lock.dockerfileSha256, packageSet: lock.packageSet, rustConfig: lock.rustConfig, nodeVersion: lock.nodeVersion, executionDefinitionSha256: lock.executionDefinitionSha256, validationEvidenceSha256: lock.validationEvidenceSha256, builderLockSha256: '9'.repeat(64), imageReference: `${lock.imageRepository}@sha256:${lock.imageDigest}`, targetManifestSha256: SHA256, config: { profile: target.profile }, tool: { nodeVersion: '22.5.0' } });
    expect(events.indexOf('evidence:preflight')).toBeLessThan(events.indexOf('stage:source'));
    expect(events.indexOf('evidence:publish')).toBeLessThan(events.indexOf('normal-terminal:'));
    expect(value.manifest.stages).toEqual(['preflight', 'source', 'release-gates', 'frontend', 'target-setup', 'feeds', 'config', 'build', 'verify', 'publish']);
  });

  it('keeps an EEXIST publication as an explicit collision and never claims success', async () => {
    const writes: RunnerWriteCommand[] = [];
    const value = input({
      store: { getJob: () => job, runnerWrite: (command) => { writes.push(command); return { ok: true, kind: 'committed', eventSeq: writes.length, value: undefined }; } },
      publisher: { publish: async () => ({ available: true, published: false, quarantined: false, selfTest: false, mutationCount: 1, errorCode: 'OUTPUT_COLLISION' as const, renameResult: 'EEXIST' as const }) } as PipelineInput['publisher'],
    });
    const result = await createPipeline(value).run();
    expect(result).toMatchObject({ state: 'failed', blockerCode: 'OUTPUT_COLLISION' });
    expect(writes.some((command) => command.kind === 'publish' && command.state === 'blocked' && command.blockerCode === 'OUTPUT_COLLISION')).toBe(true);
    expect(writes.some((command) => command.kind === 'normal-terminal' && command.state === 'succeeded')).toBe(false);
  });
});

describe('publish recovery record', () => {
  const artifact = { stagingPath: 'staging/job', artifactSha256: '1'.repeat(64), artifactSize: 1, artifactMtime: '2026-07-26T10:00:00.000Z', checksumPath: 'sha256sums', checksumSha256: '2'.repeat(64), manifestPath: 'manifest', manifestSha256: '3'.repeat(64), verificationPath: 'verification', verificationSha256: '4'.repeat(64) };
  const metadata = { manifestPath: 'manifest', manifestSha256: artifact.manifestSha256, verificationPath: 'verification', verificationSha256: artifact.verificationSha256, checksumPath: 'sha256sums', checksumSha256: artifact.checksumSha256 };
  it('distinguishes complete, surviving staging, mismatched, and collision records', async () => {
    await expect(recoverPublishing({ response: { available: true, published: false, quarantined: false, selfTest: false, mutationCount: 0, destination: 'candidate', staging: 'absent' }, artifact, metadata, verifyFinal: async () => ({ verified: true, finalPath: 'final' }) })).resolves.toEqual({ kind: 'complete', finalPath: 'final' });
    await expect(recoverPublishing({ response: { available: true, published: false, quarantined: false, selfTest: false, mutationCount: 0, destination: 'absent', staging: 'present' }, artifact, metadata, verifyFinal: async () => ({ verified: true, finalPath: 'final' }) })).resolves.toEqual({ kind: 'staging-survives', code: 'PUBLISH_RECOVERY_FAILED' });
    await expect(recoverPublishing({ response: { available: true, published: false, quarantined: false, selfTest: false, mutationCount: 0, destination: 'mismatched', staging: 'present' }, artifact, metadata, verifyFinal: async () => ({ verified: true, finalPath: 'final' }) })).resolves.toEqual({ kind: 'mismatched', code: 'UNVERIFIED_FINAL_PATH_BLOCKER' });
    await expect(recoverPublishing({ response: { available: true, published: false, quarantined: false, selfTest: false, mutationCount: 0, renameResult: 'EEXIST' }, artifact, metadata, verifyFinal: async () => ({ verified: true, finalPath: 'final' }) })).resolves.toEqual({ kind: 'collision', code: 'OUTPUT_COLLISION' });
  });
});
