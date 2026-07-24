import { describe, expect, it } from 'vitest';
import { createDockerExecutor } from '../../runner/src/docker-executor.js';

describe('Docker lifecycle integration capability', () => {
  it('reports typed unavailable and zero mutation when Docker is unavailable instead of skipping', async () => {
    const ownership = { runnerWrite: () => { throw new Error('must not mutate'); }, getJob: () => { throw new Error('must not read'); } };
    const result = await createDockerExecutor({
      dockerPath: '/definitely/missing/docker',
      imageReference: 'registry.example/builder@sha256:' + 'a'.repeat(64),
      imageDigest: 'a'.repeat(64),
      jobId: 'integration-job',
      manifestSha256: 'b'.repeat(64),
      attempt: 1,
      worktreePath: '/tmp/worktree',
      uid: 1000,
      gid: 1000,
      sourceDateEpoch: '1782208800',
      operationId: 'verify-image',
      operationContext: { environment: 'full_raspberrypi_bcm27xx_bcm2712', installedToolPath: '/usr/local/libexec/osi-image-builder-tool' },
      operationTimeoutMs: 60_000,
      maxCaptureBytes: 16 * 1024,
      containerName: 'osi-image-builder-integration-job-attempt-1',
      runner: { owner: 'runner', unit: 'osi-image-builder-runner@integration-job.service', leaseExpiresAt: '2026-07-24T10:10:00.000Z', expectedState: 'starting' },
      ownership,
      evidence: async () => ({ path: 'evidence/integration.json', sha256: 'c'.repeat(64) }),
      logs: { runner: 'absent', docker: 'absent', verifiedAt: '2026-07-24T10:00:00.000Z' },
    }).run();
    expect(result.available).toBe(false);
    expect(result.mutationCount).toBe(0);
  });
});
