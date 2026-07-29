import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  createPublishingRecoveryService,
  type PublishingRecoveryArtifactObservation,
  type PublishingRecoveryJob,
  type PublishingRecoveryLogService,
  type PublishingRecoveryInput,
  type PublishingRecoveryPublisher,
} from '../../api/src/publishing-recovery.js';
import { encodeJson } from '../../api/src/validation.js';

const NOW = '2026-07-29T12:00:00.000Z';
const LATER = '2026-07-29T12:05:00.000Z';
const STARTED = '2026-07-29T11:00:00.000Z';
const INACTIVE = '2026-07-29T11:59:00.000Z';
const LEASE_EXPIRES = '2026-07-29T11:30:00.000Z';
const SHA = 'a'.repeat(64);
const CHECKSUM = `${SHA} image\n`;
const CHECKSUM_SHA = createHash('sha256').update(CHECKSUM).digest('hex');
const MANIFEST = { artifactSha256: SHA, branch: 'main', jobId: 'job-1', pinnedSha: 'd'.repeat(40), targetId: 'rpi-5' };
const MANIFEST_BYTES = encodeJson(MANIFEST, 'manifest', true);
const MANIFEST_SHA = createHash('sha256').update(MANIFEST_BYTES).digest('hex');
const VERIFICATION = {
  artifactSha256: SHA,
  branch: 'main',
  jobId: 'job-1',
  pinnedSha: 'd'.repeat(40),
  targetId: 'rpi-5',
  observations: {
    publishEvidence: { path: 'jobs/job-1/evidence/09-publish.json' },
    stageEvidence: ['preflight', 'source', 'release-gates', 'frontend', 'target-setup', 'feeds', 'config', 'build', 'verify', 'publish'].map((stage, index) => ({
      outcome: 'passed',
      path: `${String(index).padStart(2, '0')}-${stage}.json`,
      stage,
    })),
  },
};
const VERIFICATION_BYTES = encodeJson(VERIFICATION, 'verification', true);
const VERIFICATION_SHA = createHash('sha256').update(VERIFICATION_BYTES).digest('hex');
const FINAL_DIRECTORY = `main/${'d'.repeat(40)}/rpi-5`;
const FINAL_PATH = `${FINAL_DIRECTORY}/image`;

function sidecar(bytes: string, path: string, sha256: string) {
  return { present: true as const, path, bytes, content: JSON.parse(bytes), sha256 };
}

function job(): PublishingRecoveryJob {
  return {
    jobId: 'job-1',
    state: 'publishing',
    publishState: 'publishing',
    runnerUnit: 'osi-image-builder-runner@job-1.service',
    runnerOwner: 'runner-a',
    runnerLeaseExpiresAt: LEASE_EXPIRES,
    runnerInactiveAt: INACTIVE,
    stageStartedAt: STARTED,
    rootId: 'images',
    branch: 'main',
    pinnedSha: 'd'.repeat(40),
    targetId: 'rpi-5',
    artifactStagingPath: 'staging/job-1/image',
    artifactSha256: SHA,
    artifactSize: 10,
    artifactMtime: STARTED,
    checksumPath: 'staging/job-1/sha256sums',
    checksumSha256: CHECKSUM_SHA,
    manifestPath: 'staging/job-1/build-manifest.json',
    manifestSha256: MANIFEST_SHA,
    verificationPath: 'staging/job-1/verification.json',
    verificationSha256: 'b'.repeat(64),
    finalDirectory: FINAL_DIRECTORY,
    finalPath: FINAL_PATH,
    artifactQuarantineIntentPath: '.osi-image-builder/quarantine/job-1',
    publishStartedAt: STARTED,
    publishedAt: null,
  };
}

function finalArtifacts(): PublishingRecoveryArtifactObservation {
  return {
    final: { present: true, held: true, path: FINAL_PATH, size: 10, sha256: SHA },
    checksum: { present: true, path: `${FINAL_DIRECTORY}/sha256sums`, contents: CHECKSUM, sha256: CHECKSUM_SHA },
    manifest: sidecar(MANIFEST_BYTES, `${FINAL_DIRECTORY}/build-manifest.json`, MANIFEST_SHA),
    verification: sidecar(VERIFICATION_BYTES, `${FINAL_DIRECTORY}/verification.json`, VERIFICATION_SHA),
    staging: { state: 'absent', path: null, sha256: null, size: null, held: false },
    quarantine: { state: 'absent', path: null, held: false, artifactPath: null, artifactSize: null, artifactSha256: null },
  };
}

function stagingArtifacts(): PublishingRecoveryArtifactObservation {
  return {
    final: { present: false, held: false, path: FINAL_PATH, size: null, sha256: null },
    checksum: { present: false, path: 'staging/job-1/sha256sums', contents: null, sha256: null },
    manifest: { present: false, path: 'staging/job-1/build-manifest.json', bytes: null, content: null, sha256: null },
    verification: { present: false, path: 'staging/job-1/verification.json', bytes: null, content: null, sha256: null },
    staging: { state: 'present', path: 'staging/job-1/image', sha256: SHA, size: 10, held: true },
    quarantine: { state: 'absent', path: null, held: false, artifactPath: null, artifactSize: null, artifactSha256: null },
  };
}

function quarantinedArtifacts(): PublishingRecoveryArtifactObservation {
  return {
    ...stagingArtifacts(),
    staging: { state: 'absent', path: null, sha256: null, size: null, held: false },
    quarantine: {
      state: 'present',
      path: '.osi-image-builder/quarantine/job-1',
      held: true,
      artifactPath: '.osi-image-builder/quarantine/job-1/image',
      artifactSize: 10,
      artifactSha256: SHA,
    },
  };
}

function absentArtifacts(): PublishingRecoveryArtifactObservation {
  return {
    ...stagingArtifacts(),
    staging: { state: 'absent', path: null, sha256: null, size: null, held: false },
    quarantine: {
      state: 'absent',
      path: null,
      held: false,
      artifactPath: null,
      artifactSize: null,
      artifactSha256: null,
    },
  };
}

function stageWriter(input: { readonly outcome: 'passed' | 'failed'; readonly observations: object; readonly error: object | null }) {
  const bytes = `${encodeJson({
    schemaVersion: 1,
    jobId: 'job-1',
    stage: 'publish',
    startedAt: STARTED,
    finishedAt: NOW,
    outcome: input.outcome,
    error: input.error,
    inputs: { branch: 'main', pinnedSha: 'd'.repeat(40), rootId: 'images', targetId: 'rpi-5' },
    observations: input.observations,
  }, 'publish stage evidence', true)}\n`;
  return {
    present: true as const,
    path: 'jobs/job-1/evidence/09-publish.json',
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function publisher(): PublishingRecoveryPublisher {
  const observation = { destination: 'candidate' as const, staging: 'absent' as const, mutationCount: 0 as const };
  return {
    recheck: vi.fn(async () => observation),
    quarantine: vi.fn(async () => ({ outcome: 'failed' as const, mutationCount: 0 })),
  };
}

function logs(): PublishingRecoveryLogService {
  return {
    sealOrphanTail: vi.fn(async () => undefined),
    verify: vi.fn(async () => ({ runner: 'sealed' as const, docker: 'sealed' as const, verifiedAt: NOW, noGap: true as const })),
  };
}

describe('publishing recovery', () => {
  it('emits a succeeded publish-recovery write only after exact held final proof', async () => {
    const publisherClient = publisher();
    const logService = logs();
    const service = createPublishingRecoveryService({ publisher: publisherClient, logs: logService });

    const result = await service.recover({
      job: job(),
      at: NOW,
      container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: NOW },
      observeArtifacts: vi.fn(async () => {
        throw new Error('failure observation must not inspect a candidate final');
      }),
      completeDestination: vi.fn(async ({ logs }) => {
        const observed = finalArtifacts();
        const stageObservations = {
          final: { verificationSha256: observed.verification.sha256 },
          checksum: observed.checksum,
          manifest: observed.manifest,
          verification: observed.verification,
          staging: observed.staging,
          logs,
        };
        return {
          observed,
          stageEvidence: stageWriter({
            outcome: 'passed',
            observations: stageObservations,
            error: null,
          }),
        };
      }),
      writeStageEvidence: vi.fn(async (input) => stageWriter(input)),
    });

    if (result.kind === 'blocked') throw new Error(JSON.stringify(result));
    expect(result.kind).toBe('succeeded');
    if (result.kind !== 'succeeded') return;
    expect(result.command.kind).toBe('publish-recovery');
    expect(result.command.state).toBe('succeeded');
    expect(result.command.evidence.observed.final).toEqual(finalArtifacts().final);
    expect(logService.sealOrphanTail).toHaveBeenCalledWith('runner', expect.anything());
    expect(logService.sealOrphanTail).toHaveBeenCalledWith('docker', expect.anything());
    expect(publisherClient.recheck).toHaveBeenCalledTimes(2);
  });

  it('records failed recovery and leaves staging explicit when quarantine cannot prove a move', async () => {
    const publisherClient: PublishingRecoveryPublisher = {
      recheck: vi.fn(async () => ({ destination: 'absent', staging: 'present', mutationCount: 0 } as const)),
      quarantine: vi.fn(async () => ({ outcome: 'failed', mutationCount: 0, errorCode: 'QUARANTINE_PENDING' } as const)),
    };
    const service = createPublishingRecoveryService({ publisher: publisherClient, logs: logs() });

    const result = await service.recover({
      job: job(),
      at: NOW,
      container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: NOW },
      observeArtifacts: vi.fn(async () => stagingArtifacts()),
      writeStageEvidence: vi.fn(async (input) => stageWriter(input)),
    });

    if (result.kind === 'blocked') throw new Error(JSON.stringify(result));
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.command.errorCode).toBe('QUARANTINE_PENDING');
    expect(result.command.evidence.observed.staging).toEqual({
      state: 'present',
      path: 'staging/job-1/image',
      sha256: SHA,
      size: 10,
      held: true,
    });
    expect(publisherClient.quarantine).toHaveBeenCalledOnce();
  });

  it('records failed recovery when final and staging are absent but an exact quarantine remains', async () => {
    const publisherClient: PublishingRecoveryPublisher = {
      recheck: vi.fn(async () => ({ destination: 'absent', staging: 'absent', mutationCount: 0 } as const)),
      quarantine: vi.fn(async () => ({ outcome: 'failed', mutationCount: 0 } as const)),
    };
    const service = createPublishingRecoveryService({ publisher: publisherClient, logs: logs() });

    const result = await service.recover({
      job: job(),
      at: NOW,
      container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: NOW },
      observeArtifacts: vi.fn(async () => quarantinedArtifacts()),
      writeStageEvidence: vi.fn(async (input) => stageWriter(input)),
    });

    if (result.kind === 'blocked') throw new Error(JSON.stringify(result));
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.command.errorCode).toBe('PUBLISH_RECOVERY_FAILED');
    expect(result.command.evidence.observed.quarantine?.artifactSha256).toBe(SHA);
    expect(publisherClient.quarantine).not.toHaveBeenCalled();
  });

  it('rechecks publisher state before proving a completed quarantine', async () => {
    let rechecks = 0;
    const publisherClient: PublishingRecoveryPublisher = {
      recheck: vi.fn(async () => {
        rechecks += 1;
        return rechecks < 3
          ? { destination: 'absent', staging: 'present', mutationCount: 0 } as const
          : { destination: 'absent', staging: 'absent', mutationCount: 0 } as const;
      }),
      quarantine: vi.fn(async () => ({ outcome: 'quarantined', mutationCount: 1 } as const)),
    };
    const service = createPublishingRecoveryService({ publisher: publisherClient, logs: logs() });

    const result = await service.recover({
      job: job(),
      at: NOW,
      container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: NOW },
      observeArtifacts: vi.fn(async () => {
        if (rechecks < 3) return stagingArtifacts();
        if (rechecks === 3) return quarantinedArtifacts();
        throw new Error('unexpected publisher recheck count');
      }),
      writeStageEvidence: vi.fn(async (input) => stageWriter(input)),
    });

    if (result.kind === 'blocked') throw new Error(JSON.stringify(result));
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.command.evidence.observed.quarantine?.state).toBe('present');
  });

  it('persists quarantine pending after a mutating quarantine cannot prove the move', async () => {
    const recheck = vi.fn(async () => ({
      destination: 'absent',
      staging: 'present',
      mutationCount: 0,
    } as const));
    const publisherClient: PublishingRecoveryPublisher = {
      recheck,
      quarantine: vi.fn(async () => ({
        outcome: 'failed',
        mutationCount: 1,
        errorCode: 'QUARANTINE_PENDING',
      } as const)),
    };
    const service = createPublishingRecoveryService({ publisher: publisherClient, logs: logs() });
    const observeArtifacts = vi.fn(async () => stagingArtifacts());

    const result = await service.recover({
      job: job(),
      at: NOW,
      container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: NOW },
      observeArtifacts,
      writeStageEvidence: vi.fn(async (input) => stageWriter(input)),
    });

    if (result.kind === 'blocked') throw new Error(JSON.stringify(result));
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.command.errorCode).toBe('QUARANTINE_PENDING');
    expect(result.command.evidence.observed.staging).toEqual({
      state: 'present',
      path: 'staging/job-1/image',
      sha256: SHA,
      size: 10,
      held: true,
    });
    expect(result.command.evidence.observed.quarantine).toEqual({
      state: 'absent',
      path: null,
      held: false,
      artifactPath: null,
      artifactSize: null,
      artifactSha256: null,
    });
    expect(recheck).toHaveBeenCalledTimes(3);
    expect(observeArtifacts).toHaveBeenCalledTimes(2);
  });

  it('records failed recovery when final, staging, and quarantine are all absent', async () => {
    const publisherClient: PublishingRecoveryPublisher = {
      recheck: vi.fn(async () => ({ destination: 'absent', staging: 'absent', mutationCount: 0 } as const)),
      quarantine: vi.fn(async () => ({ outcome: 'failed', mutationCount: 0 } as const)),
    };
    const service = createPublishingRecoveryService({ publisher: publisherClient, logs: logs() });

    const result = await service.recover({
      job: job(),
      at: NOW,
      container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: NOW },
      observeArtifacts: vi.fn(async () => absentArtifacts()),
      writeStageEvidence: vi.fn(async (input) => stageWriter(input)),
    });

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.command.errorCode).toBe('PUBLISH_RECOVERY_FAILED');
    expect(result.command.evidence.observed.staging.state).toBe('absent');
    expect(result.command.evidence.observed.quarantine?.state).toBe('absent');
  });

  it('commits the finishedAt stored in adopted failed evidence on a later retry', async () => {
    const publisherClient: PublishingRecoveryPublisher = {
      recheck: vi.fn(async () => ({ destination: 'absent', staging: 'absent', mutationCount: 0 } as const)),
      quarantine: vi.fn(async () => ({ outcome: 'failed', mutationCount: 0 } as const)),
    };
    const service = createPublishingRecoveryService({ publisher: publisherClient, logs: logs() });

    const result = await service.recover({
      job: job(),
      at: LATER,
      container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: LATER },
      observeArtifacts: vi.fn(async () => absentArtifacts()),
      writeStageEvidence: vi.fn(async (input) => stageWriter(input)),
    });

    if (result.kind === 'blocked') throw new Error(JSON.stringify(result));
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.command.at).toBe(LATER);
    expect(result.command.evidence.stage.finishedAt).toBe(NOW);
  });

  it('records a final-path blocker without mutating a mismatched final', async () => {
    const publisherClient: PublishingRecoveryPublisher = {
      recheck: vi.fn(async () => ({ destination: 'mismatched', staging: 'present', mutationCount: 0 } as const)),
      quarantine: vi.fn(async () => ({ outcome: 'failed', mutationCount: 0 } as const)),
    };
    const observeArtifacts = vi.fn(async () => ({
      ...stagingArtifacts(),
      final: { present: true, held: false, path: FINAL_PATH, size: null, sha256: null },
    }));
    const service = createPublishingRecoveryService({ publisher: publisherClient, logs: logs() });

    const result = await service.recover({
      job: job(),
      at: NOW,
      container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: NOW },
      observeArtifacts,
      writeStageEvidence: vi.fn(async (input) => stageWriter(input)),
    });

    if (result.kind === 'blocked') throw new Error(JSON.stringify(result));
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.command.errorCode).toBe('UNVERIFIED_FINAL_PATH_BLOCKER');
    expect(result.command.error).toEqual({
      code: 'UNVERIFIED_FINAL_PATH_BLOCKER',
      reason: 'publisher reports a mismatched final destination',
      binding: {
        jobId: 'job-1',
        rootId: 'images',
        branch: 'main',
        branchSlug: 'main',
        pinnedSha: 'd'.repeat(40),
        targetId: 'rpi-5',
        stagingDirectory: 'staging/job-1',
        stagingPath: 'staging/job-1/image',
        finalDirectory: FINAL_DIRECTORY,
        finalPath: FINAL_PATH,
        artifactSha256: SHA,
        artifactSize: 10,
      },
    });
    expect(result.command.evidence.observed.final.present).toBe(true);
    expect(observeArtifacts).toHaveBeenCalledOnce();
    expect(publisherClient.quarantine).not.toHaveBeenCalled();
  });

  it('returns a typed blocker when either orphan log tail cannot be sealed', async () => {
    const logService: PublishingRecoveryLogService = {
      sealOrphanTail: vi.fn(async (stream) => {
        if (stream === 'docker') throw new Error('fsync failed');
      }),
      verify: vi.fn(async () => ({ runner: 'sealed', docker: 'sealed', verifiedAt: NOW, noGap: true } as const)),
    };
    const publisherClient = publisher();
    const service = createPublishingRecoveryService({ publisher: publisherClient, logs: logService });

    const result = await service.recover({
      job: job(),
      at: NOW,
      container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: NOW },
      observeArtifacts: vi.fn(async () => finalArtifacts()),
      writeStageEvidence: vi.fn(async (input) => stageWriter(input)),
    });

    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(result.code).toBe('RECOVERY_PROOF_INSUFFICIENT');
    expect(publisherClient.recheck).not.toHaveBeenCalled();
  });

  it('returns a typed blocker when the publisher CAS recheck changes state', async () => {
    const recheck = vi.fn()
      .mockResolvedValueOnce({ destination: 'candidate' as const, staging: 'absent' as const, mutationCount: 0 as const })
      .mockResolvedValueOnce({ destination: 'mismatched' as const, staging: 'present' as const, mutationCount: 0 as const });
    const publisherClient: PublishingRecoveryPublisher = {
      recheck,
      quarantine: vi.fn(async () => ({ outcome: 'failed', mutationCount: 0 } as const)),
    };
    const writeStageEvidence = vi.fn(async (input: Parameters<PublishingRecoveryInput['writeStageEvidence']>[0]) => stageWriter(input));
    const service = createPublishingRecoveryService({ publisher: publisherClient, logs: logs() });

    const result = await service.recover({
      job: job(),
      at: NOW,
      container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: NOW },
      observeArtifacts: vi.fn(async () => finalArtifacts()),
      writeStageEvidence,
    });

    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(result.code).toBe('RECOVERY_PROOF_INSUFFICIENT');
    expect(writeStageEvidence).not.toHaveBeenCalled();
  });
});
