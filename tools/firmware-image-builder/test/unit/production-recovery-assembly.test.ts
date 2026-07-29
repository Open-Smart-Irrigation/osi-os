import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  createPublishingRecoveryStartupService,
  adoptPublishingRecoveryFailureEvidence,
  physicalRecoveryProbe,
  publishingFailureObservation,
  revalidatePublishingRecoveryCommit,
  recoveryContainerObservation,
  recoveryLogObservation,
} from '../../api/src/production.js';
import { createProductionRecoveryInspector } from '../../api/src/production-recovery-inspector.js';
import type { JobRecord, RecoveryJobRecord } from '../../api/src/store.js';
import { encodeJson } from '../../api/src/validation.js';

const AT = '2026-07-26T13:00:00.000Z';

function recoveryJob(overrides: Partial<RecoveryJobRecord> = {}): RecoveryJobRecord {
  return {
    jobId: 'job-production-recovery',
    state: 'building',
    queueState: 'running',
    queuePosition: null,
    terminalAt: null,
    terminalErrorCode: null,
    terminalError: null,
    cleanupFenceGeneration: null,
    cleanupAdmissionId: null,
    cleanupBlockerCode: null,
    cleanupBlocker: null,
    cleanupLeaseStatus: null,
    cleanupLeaseExpiresAt: null,
    cleanupLeaseBlockerCode: null,
    cleanupLeaseBlocker: null,
    ...overrides,
  };
}

describe('production recovery assembly', () => {
  it('adopts exact failed evidence across a later recovery clock and log observation', () => {
    const observations = {
      final: { present: false, path: 'main/sha/rpi-5/image', held: false, size: null, sha256: null },
      checksum: { present: false, path: 'staging/job/sha256sums', contents: null, sha256: null },
      manifest: { present: false, path: 'staging/job/build-manifest.json', bytes: null, content: null, sha256: null },
      verification: { present: false, path: 'staging/job/verification.json', bytes: null, content: null, sha256: null },
      staging: { state: 'present', path: 'staging/job/image', sha256: 'a'.repeat(64), size: 10, held: true },
      quarantine: { state: 'absent', path: null, held: false, artifactPath: null, artifactSize: null, artifactSha256: null },
      logs: { runner: 'sealed', docker: 'sealed', noGap: true, verifiedAt: AT },
    };
    const content = {
      schemaVersion: 1,
      jobId: 'job',
      stage: 'publish',
      startedAt: '2026-07-26T12:30:00.000Z',
      finishedAt: AT,
      outcome: 'failed',
      operationId: null,
      commands: [],
      inputs: { targetId: 'rpi-5', rootId: 'images', branch: 'main', pinnedSha: 'b'.repeat(40) },
      observations,
      error: { code: 'QUARANTINE_PENDING', reason: 'pending' },
    };
    const bytes = `${encodeJson(content, 'failed recovery evidence fixture', true)}\n`;
    const existing = {
      present: true as const,
      path: 'jobs/job/evidence/09-publish.json',
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };

    expect(adoptPublishingRecoveryFailureEvidence({
      publication: existing,
      job: {
        jobId: 'job',
        targetId: 'rpi-5',
        rootId: 'images',
        branch: 'main',
        pinnedSha: 'b'.repeat(40),
      } as JobRecord,
      stageStartedAt: '2026-07-26T12:30:00.000Z',
      recoveryAt: '2026-07-26T13:05:00.000Z',
      expected: {
        outcome: 'failed',
        observations: {
          ...observations,
          logs: {
            runner: 'sealed',
            docker: 'sealed',
            noGap: true,
            verifiedAt: '2026-07-26T13:05:00.000Z',
          },
        },
        error: { code: 'QUARANTINE_PENDING', reason: 'pending' },
      },
    })).toEqual(existing);
  });

  it('defers the final publishing recovery commit when runner activity reappears', async () => {
    const inspect = vi.fn(async () => ({ active: true, pending: false, observedAt: AT }));
    const command = {
      kind: 'publish-recovery',
      jobId: 'job-production-recovery',
      expectedState: 'publishing',
      state: 'failed',
      at: AT,
      evidence: {
        runner: {
          unit: 'osi-image-builder-runner@job-production-recovery.service',
          owner: 'runner-old',
          leaseExpiresAt: '2026-07-26T12:50:00.000Z',
          inactiveAt: AT,
          observedAt: AT,
        },
        container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: AT },
      },
    } as unknown as Parameters<typeof revalidatePublishingRecoveryCommit>[1];
    const result = await revalidatePublishingRecoveryCommit({
      store: {
        getJob: () => ({
          jobId: 'job-production-recovery',
          state: 'publishing',
          publishState: 'publishing',
          runnerUnit: 'osi-image-builder-runner@job-production-recovery.service',
          runnerLeaseOwner: 'runner-new',
          runnerLeaseExpiresAt: '2026-07-26T12:59:00.000Z',
        }),
      } as unknown as Parameters<typeof revalidatePublishingRecoveryCommit>[0]['store'],
      systemd: { inspect } as unknown as Parameters<typeof revalidatePublishingRecoveryCommit>[0]['systemd'],
      globalDocker: { listBuilderContainers: vi.fn() } as unknown as Parameters<typeof revalidatePublishingRecoveryCommit>[0]['globalDocker'],
      docker: {} as Parameters<typeof revalidatePublishingRecoveryCommit>[0]['docker'],
      now: () => AT,
    }, command);

    expect(result).toEqual({
      kind: 'deferred',
      code: 'PUBLISH_RECOVERY_LIVENESS_CHANGED',
      details: { jobId: 'job-production-recovery', reason: 'runner-unit-live' },
    });
    expect(inspect).toHaveBeenCalledOnce();
  });

  it('rebinds the recovery command to the final liveness observation timestamps', async () => {
    const committedAt = '2026-07-26T13:00:02.000Z';
    const command = {
      kind: 'publish-recovery',
      jobId: 'job-production-recovery',
      expectedState: 'publishing',
      state: 'failed',
      at: AT,
      evidence: {
        runner: {
          unit: 'osi-image-builder-runner@job-production-recovery.service',
          owner: 'runner-old',
          leaseExpiresAt: '2026-07-26T12:50:00.000Z',
          inactiveAt: AT,
          observedAt: AT,
        },
        container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: AT },
      },
    } as unknown as Parameters<typeof revalidatePublishingRecoveryCommit>[1];
    const latestJob = {
      jobId: 'job-production-recovery',
      state: 'publishing',
      publishState: 'publishing',
      runnerUnit: 'osi-image-builder-runner@job-production-recovery.service',
      runnerLeaseOwner: 'runner-final',
      runnerLeaseExpiresAt: '2026-07-26T12:59:00.000Z',
      targetManifestSha256: 'a'.repeat(64),
      containerId: null,
      containerName: null,
      containerImageDigest: null,
      containerLabelJobId: null,
      containerLabelManifestSha: null,
      containerLabels: null,
    } as unknown as JobRecord;

    const result = await revalidatePublishingRecoveryCommit({
      store: { getJob: () => latestJob } as unknown as Parameters<typeof revalidatePublishingRecoveryCommit>[0]['store'],
      systemd: {
        inspect: async () => ({
          active: false,
          pending: false,
          observedAt: '2026-07-26T13:00:00.500Z',
        }),
      } as unknown as Parameters<typeof revalidatePublishingRecoveryCommit>[0]['systemd'],
      globalDocker: {
        listBuilderContainers: async () => ({
          containers: [],
          observedAt: '2026-07-26T13:00:01.000Z',
        }),
      } as unknown as Parameters<typeof revalidatePublishingRecoveryCommit>[0]['globalDocker'],
      docker: {
        listByLabels: vi.fn(async () => []),
        inspect: vi.fn(),
      } as unknown as Parameters<typeof revalidatePublishingRecoveryCommit>[0]['docker'],
      now: vi.fn()
        .mockReturnValueOnce('2026-07-26T13:00:00.750Z')
        .mockReturnValueOnce(committedAt),
    }, command);

    expect(result).toMatchObject({
      kind: 'ready',
      command: {
        at: committedAt,
        evidence: {
          runner: {
            owner: 'runner-final',
            leaseExpiresAt: '2026-07-26T12:59:00.000Z',
            inactiveAt: '2026-07-26T13:00:00.500Z',
            observedAt: committedAt,
          },
          container: {
            kind: 'absent',
            globalLabelResult: 'no-match',
            observedAt: committedAt,
          },
        },
      },
    });
  });

  it('derives present staging identity only from held physical verification', async () => {
    const sha256 = 'c'.repeat(64);
    const verify = vi.fn(async () => ({
      kind: 'present' as const,
      path: 'staging/job-production-recovery/image.img.gz',
      held: true as const,
      size: 4096,
      sha256,
      verifiedAt: AT,
    }));
    const job = {
      jobId: 'job-production-recovery',
      rootId: 'images',
      publishState: 'publishing',
      artifactStagingPath: 'staging/job-production-recovery/image.img.gz',
      artifactSha256: sha256,
      artifactSize: 4096,
      artifactMtime: AT,
      checksumPath: 'staging/job-production-recovery/sha256sums',
      checksumSha256: 'd'.repeat(64),
      manifestPath: 'staging/job-production-recovery/build-manifest.json',
      manifestSha256: 'e'.repeat(64),
      verificationPath: 'staging/job-production-recovery/verification.json',
      verificationSha256: 'f'.repeat(64),
      artifactFinalPath: `main/${'a'.repeat(40)}/rpi-5/image.img.gz`,
    } as unknown as JobRecord;

    await expect(publishingFailureObservation(
      job,
      { destination: 'absent', staging: 'present', mutationCount: 0 },
      { staging: { verify } } as unknown as Parameters<typeof publishingFailureObservation>[2],
      AT,
    )).resolves.toMatchObject({
      staging: {
        state: 'present',
        path: 'staging/job-production-recovery/image.img.gz',
        held: true,
        size: 4096,
        sha256,
      },
    });
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({
      postcondition: {
        kind: 'present',
        sourcePath: 'staging/job-production-recovery',
        sourcePresent: true,
        destinationPath: 'quarantine/job-production-recovery',
        destinationAbsent: true,
        sha256,
        size: 4096,
        verifiedAt: AT,
      },
    }));
  });

  it('defers publishing recovery for live units and unexpired leases', async () => {
    for (const [active, leaseExpiresAt] of [
      [true, '2026-07-26T12:59:00.000Z'],
      [false, '2026-07-26T13:01:00.000Z'],
    ] as const) {
      const apiWrite = vi.fn();
      const service = createPublishingRecoveryStartupService({
        database: {
          prepare: () => ({ all: () => [{ job_id: 'job-production-recovery' }] }),
        } as unknown as Parameters<typeof createPublishingRecoveryStartupService>[0]['database'],
        store: {
          getJob: () => ({
            jobId: 'job-production-recovery',
            runnerUnit: 'osi-image-builder-runner@job-production-recovery.service',
            runnerLeaseExpiresAt: leaseExpiresAt,
          }),
          getStage: vi.fn(),
        } as unknown as Parameters<typeof createPublishingRecoveryStartupService>[0]['store'],
        ownership: { apiWrite } as unknown as Parameters<typeof createPublishingRecoveryStartupService>[0]['ownership'],
        systemd: {
          inspect: async () => ({ active, pending: false, observedAt: AT }),
        } as unknown as Parameters<typeof createPublishingRecoveryStartupService>[0]['systemd'],
        docker: {} as Parameters<typeof createPublishingRecoveryStartupService>[0]['docker'],
        globalDocker: {} as Parameters<typeof createPublishingRecoveryStartupService>[0]['globalDocker'],
        publisher: {} as Parameters<typeof createPublishingRecoveryStartupService>[0]['publisher'],
        physical: {} as Parameters<typeof createPublishingRecoveryStartupService>[0]['physical'],
        loaded: {} as Parameters<typeof createPublishingRecoveryStartupService>[0]['loaded'],
        now: () => AT,
      });

      await expect(service()).resolves.toEqual({ blockers: [] });
      expect(apiWrite).not.toHaveBeenCalled();
    }
  });

  it('blocks an inactive stale publishing row whose durable stage proof is incomplete', async () => {
    const service = createPublishingRecoveryStartupService({
      database: {
        prepare: () => ({ all: () => [{ job_id: 'job-production-recovery' }] }),
      } as unknown as Parameters<typeof createPublishingRecoveryStartupService>[0]['database'],
      store: {
        getJob: () => ({
          jobId: 'job-production-recovery',
          runnerUnit: 'osi-image-builder-runner@job-production-recovery.service',
          runnerLeaseExpiresAt: '2026-07-26T12:59:00.000Z',
        }),
        getStage: () => null,
      } as unknown as Parameters<typeof createPublishingRecoveryStartupService>[0]['store'],
      ownership: { apiWrite: vi.fn() } as unknown as Parameters<typeof createPublishingRecoveryStartupService>[0]['ownership'],
      systemd: {
        inspect: async () => ({ active: false, pending: false, observedAt: AT }),
      } as unknown as Parameters<typeof createPublishingRecoveryStartupService>[0]['systemd'],
      docker: {} as Parameters<typeof createPublishingRecoveryStartupService>[0]['docker'],
      globalDocker: {} as Parameters<typeof createPublishingRecoveryStartupService>[0]['globalDocker'],
      publisher: {} as Parameters<typeof createPublishingRecoveryStartupService>[0]['publisher'],
      physical: {} as Parameters<typeof createPublishingRecoveryStartupService>[0]['physical'],
      loaded: {} as Parameters<typeof createPublishingRecoveryStartupService>[0]['loaded'],
      now: () => AT,
    });

    await expect(service()).resolves.toEqual({
      blockers: [{
        code: 'PUBLISH_RECOVERY_PROOF_UNAVAILABLE',
        details: {
          jobId: 'job-production-recovery',
          reason: 'publishing stage is not durably running',
        },
      }],
    });
  });

  it('physically verifies an absent log postcondition before returning direct proof', async () => {
    const verify = vi.fn(async () => true as const);
    const database = {
      prepare: (sql: string) => ({
        all: () => {
          if (sql.includes('job_log_generations') || sql.includes('job_events')) return [];
          throw new Error(`unexpected query: ${sql}`);
        },
        get: () => ({ seq: 0 }),
      }),
    } as unknown as DatabaseSync;

    await expect(recoveryLogObservation(
      database,
      { logs: { verify } } as unknown as Parameters<typeof recoveryLogObservation>[1],
      'job-production-recovery',
      AT,
    )).resolves.toMatchObject({
      snapshot: { runner: 'absent', docker: 'absent', verifiedAt: AT },
      direct: { runner: 'absent', docker: 'absent', verifiedAt: AT },
    });
    expect(verify).toHaveBeenCalledWith({
      jobId: 'job-production-recovery',
      completedAt: AT,
      completionEventSeq: 0,
      postcondition: { runner: 'absent', docker: 'absent', verifiedAt: AT },
      generations: [],
      events: [],
    });
  });

  it('does not generate unused proofs while a fenced cleanup unit is active', async () => {
    const admissionId = `cln_0${'0'.repeat(25)}`;
    const job = recoveryJob({
      cleanupFenceGeneration: 1,
      cleanupAdmissionId: admissionId,
      cleanupLeaseStatus: 'admitted',
      cleanupLeaseExpiresAt: '2026-07-26T13:05:00.000Z',
    });
    const inspectRecovery = vi.fn(async (unit: string) => ({
      unit,
      active: unit.includes('cleanup@'),
      observedAt: AT,
    }));
    const probe = physicalRecoveryProbe(
      { inspectRecovery } as unknown as Parameters<typeof physicalRecoveryProbe>[0],
      {} as DatabaseSync,
      { getJob: () => ({}) } as unknown as Parameters<typeof physicalRecoveryProbe>[2],
      {} as Parameters<typeof physicalRecoveryProbe>[3],
      {} as Parameters<typeof physicalRecoveryProbe>[4],
      {} as Parameters<typeof physicalRecoveryProbe>[5],
    );
    const inspector = createProductionRecoveryInspector({ physical: probe });

    await expect(inspector.inspect({ job, retry: false, at: AT })).resolves.toEqual({
      kind: 'cleanup-in-progress',
      jobId: job.jobId,
      state: job.state,
      at: AT,
      admissionId,
      generation: 1,
    });
    expect(inspectRecovery).toHaveBeenCalledTimes(2);
  });

  it('rejects a primary-label container with a missing manifest label for an unpersisted identity', async () => {
    const job = {
      jobId: 'job-production-recovery',
      targetManifestSha256: 'a'.repeat(64),
      containerId: null,
      containerName: null,
      containerImageDigest: null,
      containerLabelJobId: null,
      containerLabelManifestSha: null,
      containerLabels: null,
    } as unknown as JobRecord;

    await expect(recoveryContainerObservation(
      job,
      {
        inspect: vi.fn(),
        listByLabels: vi.fn(async () => [{
          id: 'container-id',
          name: 'osi-image-builder-job-production-recovery',
          imageDigest: 'b'.repeat(64),
          labels: { 'org.osi.image-builder.job-id': job.jobId },
        }]),
      } as unknown as Parameters<typeof recoveryContainerObservation>[1],
      AT,
    )).rejects.toThrow('primary-label container set is not absent');
  });

  it('rejects a primary-label container with a wrong manifest label for an unpersisted identity', async () => {
    const job = {
      jobId: 'job-production-recovery',
      targetManifestSha256: 'a'.repeat(64),
      containerId: null,
      containerName: null,
      containerImageDigest: null,
      containerLabelJobId: null,
      containerLabelManifestSha: null,
      containerLabels: null,
    } as unknown as JobRecord;

    await expect(recoveryContainerObservation(
      job,
      {
        inspect: vi.fn(),
        listByLabels: vi.fn(async () => [{
          id: 'container-id',
          name: 'osi-image-builder-job-production-recovery',
          imageDigest: 'b'.repeat(64),
          labels: {
            'org.osi.image-builder.job-id': job.jobId,
            'org.osi.image-builder.manifest-sha': 'c'.repeat(64),
          },
        }]),
      } as unknown as Parameters<typeof recoveryContainerObservation>[1],
      AT,
    )).rejects.toThrow('primary-label container set is not absent');
  });

  it('rejects duplicate primary-label containers for a persisted identity', async () => {
    const labels = {
      'org.osi.image-builder.job-id': 'job-production-recovery',
      'org.osi.image-builder.manifest-sha': 'a'.repeat(64),
    };
    const job = {
      jobId: 'job-production-recovery',
      targetManifestSha256: 'a'.repeat(64),
      containerId: 'container-id',
      containerName: 'osi-image-builder-job-production-recovery',
      containerImageDigest: 'b'.repeat(64),
      containerLabelJobId: labels['org.osi.image-builder.job-id'],
      containerLabelManifestSha: labels['org.osi.image-builder.manifest-sha'],
      containerLabels: labels,
    } as unknown as JobRecord;
    const exact = {
      id: 'container-id',
      name: job.containerName,
      imageDigest: job.containerImageDigest,
      labels,
    };

    await expect(recoveryContainerObservation(
      job,
      {
        inspect: vi.fn(async () => exact),
        listByLabels: vi.fn(async () => [exact, { ...exact, id: 'duplicate-container-id' }]),
      } as unknown as Parameters<typeof recoveryContainerObservation>[1],
      AT,
    )).rejects.toThrow('physical recovery container does not match durable identity');
  });

  it('retains persisted identity when the physical container and all primary labels are absent', async () => {
    const labels = {
      'org.osi.image-builder.job-id': 'job-production-recovery',
      'org.osi.image-builder.manifest-sha': 'a'.repeat(64),
    };
    const job = {
      jobId: 'job-production-recovery',
      targetManifestSha256: 'a'.repeat(64),
      containerId: 'container-id',
      containerName: 'osi-image-builder-job-production-recovery',
      containerImageDigest: 'b'.repeat(64),
      containerLabelJobId: labels['org.osi.image-builder.job-id'],
      containerLabelManifestSha: labels['org.osi.image-builder.manifest-sha'],
      containerLabels: labels,
    } as unknown as JobRecord;

    await expect(recoveryContainerObservation(
      job,
      {
        inspect: vi.fn(async () => null),
        listByLabels: vi.fn(async () => []),
      } as unknown as Parameters<typeof recoveryContainerObservation>[1],
      AT,
    )).resolves.toMatchObject({
      kind: 'present',
      id: job.containerId,
      globalLabelResult: 'no-match',
      observedAt: AT,
    });
  });

  it('accepts the single exact primary-label container for a persisted identity', async () => {
    const labels = {
      'org.osi.image-builder.job-id': 'job-production-recovery',
      'org.osi.image-builder.manifest-sha': 'a'.repeat(64),
    };
    const job = {
      jobId: 'job-production-recovery',
      targetManifestSha256: 'a'.repeat(64),
      containerId: 'container-id',
      containerName: 'osi-image-builder-job-production-recovery',
      containerImageDigest: 'b'.repeat(64),
      containerLabelJobId: labels['org.osi.image-builder.job-id'],
      containerLabelManifestSha: labels['org.osi.image-builder.manifest-sha'],
      containerLabels: labels,
    } as unknown as JobRecord;
    const exact = {
      id: job.containerId,
      name: job.containerName,
      imageDigest: job.containerImageDigest,
      labels,
    };

    await expect(recoveryContainerObservation(
      job,
      {
        inspect: vi.fn(async () => exact),
        listByLabels: vi.fn(async () => [exact]),
      } as unknown as Parameters<typeof recoveryContainerObservation>[1],
      AT,
    )).resolves.toMatchObject({
      kind: 'present',
      id: job.containerId,
      name: job.containerName,
      imageDigest: job.containerImageDigest,
      labels,
      globalLabelResult: 'single-exact-match',
      observedAt: AT,
    });
  });

  it('admits cleanup for retained identity after the exact container is already absent', async () => {
    const labels = {
      'org.osi.image-builder.job-id': 'job-production-recovery',
      'org.osi.image-builder.manifest-sha': 'a'.repeat(64),
    };
    const job = {
      jobId: 'job-production-recovery',
      targetManifestSha256: 'a'.repeat(64),
      containerId: 'container-id',
      containerName: 'osi-job-production-recovery',
      containerImageDigest: 'b'.repeat(64),
      containerLabelJobId: 'job-production-recovery',
      containerLabelManifestSha: 'a'.repeat(64),
      containerLabels: labels,
    } as unknown as JobRecord;
    const inspect = vi.fn(async () => null);
    const listByLabels = vi.fn(async () => []);

    await expect(recoveryContainerObservation(
      job,
      { inspect, listByLabels } as unknown as Parameters<typeof recoveryContainerObservation>[1],
      AT,
    )).resolves.toEqual({
      kind: 'present',
      id: 'container-id',
      name: 'osi-job-production-recovery',
      imageDigest: 'b'.repeat(64),
      labels,
      globalLabelResult: 'no-match',
      observedAt: AT,
    });
  });
});
