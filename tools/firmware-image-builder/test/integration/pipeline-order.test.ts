import { describe, expect, it } from 'vitest';

import { loadManifest } from '../../manifest/validate.js';
import { createOperationDefinition } from '../../runner/src/operation-registry.js';
import { createPipeline, type PipelineInput } from '../../runner/src/pipeline.js';
import type { JobRecord } from '../../api/src/store.js';

const manifest = loadManifest(new URL('../../manifest/targets.json', import.meta.url).pathname).manifest;
const target = manifest.targets[0]!;
const sha = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const job = { jobId: 'job-order', sourceRemote: 'git@github.com:Open-Smart-Irrigation/osi-os.git', sourceRef: 'refs/remotes/origin/main', sourceBranch: 'main', branch: 'main', pinnedSha: sha, targetId: target.id, targetManifestSha256: digest, acceptedAt: '2026-07-26T09:00:00.000Z', state: 'starting', runnerUnit: 'osi-image-builder-runner@job-order.service', artifactStagingPath: 'staging', artifactSha256: digest, artifactSize: 1, artifactMtime: '2026-07-26T09:10:00.000Z', checksumPath: 'sha', checksumSha256: digest, manifestPath: 'manifest', manifestSha256: digest, verificationPath: 'verification', verificationSha256: digest, publishState: 'staged' } as unknown as JobRecord;

describe('pipeline integration order fixture', () => {
  it('uses registry argv and never overlaps operations', async () => {
    const calls: string[] = [];
    let active = false;
    const value = {
      jobId: job.jobId, runnerUnit: job.runnerUnit!, owner: 'owner', leaseExpiresAt: '2026-07-26T12:00:00.000Z', clock: { now: () => '2026-07-26T10:00:00.000Z' },
      store: { getJob: () => job, runnerWrite: () => ({ ok: true, kind: 'committed', eventSeq: 1, value: undefined }) }, manifest, target, targetManifestSha256: digest,
      builderLock: { schemaVersion: 1, packageVersion: '2026.07.22.1', imageRepository: 'registry.example/builder', imageDigest: digest, baseImage: `debian@sha256:${'c'.repeat(64)}`, baseImageDigest: 'c'.repeat(64), dockerfileSha256: 'd'.repeat(64), packageSet: ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libpolly-19-dev', 'libzstd-dev'], rustConfig: { llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.85.0', llvmMajor: 19 }, nodeVersion: '22.5.0', executionDefinitionSha256: 'e'.repeat(64), validationEvidenceSha256: 'f'.repeat(64), installable: true }, builderLockSha256: '9'.repeat(64), configMetadata: { selectedTarget: target.openwrtTarget, profile: target.profile, rootfsPartSize: target.rootfsPartSize }, toolMetadata: { nodeVersion: '22.5.0' },
      operationRunner: { run: async ({ operationId, definition }: { operationId: Parameters<PipelineInput['operationRunner']['run']>[0]['operationId']; definition: Parameters<PipelineInput['operationRunner']['run']>[0]['definition'] }) => { expect(active).toBe(false); active = true; calls.push(`${operationId}:${definition.argv.join(' ')}`); active = false; return { result: { argv: definition.argv, exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: '2026-07-26T10:00:00.000Z', finishedAt: '2026-07-26T10:00:01.000Z' }, outcome: 'passed', lifecyclePhase: 'not_created' as const }; } },
      evidenceWriter: { write: async () => ({ path: 'evidence', sha256: digest }) }, operationEvidenceWriter: { write: async () => ({ path: 'operation', sha256: digest }) }, metadataWriter: { write: async () => ({ manifestPath: 'manifest', manifestSha256: digest, verificationPath: 'verification', verificationSha256: digest, checksumPath: 'sha', checksumSha256: digest }) }, publisher: { publish: async () => ({ available: true, published: true, quarantined: false, selfTest: false, mutationCount: 1, renameResult: 'RENAMED' as const }) }, publisherRequest: { rootId: 'release', jobId: job.jobId, branchSlug: 'main', sourceSha: sha, targetId: target.id }, postRenameVerify: async () => ({ verified: true as const, finalPath: 'final' }), hooks: { verify: async () => ({ artifact: { stagingPath: 'staging', artifactSha256: digest, artifactSize: 1, artifactMtime: '2026-07-26T10:00:00.000Z' }, verification: {} }) },
    } satisfies PipelineInput;
    const result = await createPipeline(value).run();
    expect(result.state).toBe('succeeded');
    expect(calls[0]).toContain('verify-profile-parity');
    expect(calls).toContain('frontend-install:npm ci');
    expect(calls).toContain(`activate-target:make switch-env ENV=${target.environment}`);
    expect(calls.at(-1)).toContain('verify-image');
  });
});
