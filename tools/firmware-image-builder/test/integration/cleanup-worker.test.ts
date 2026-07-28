import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRecoveryFileSystem } from '../../api/src/recovery.js';
import { OwnershipStore, type CleanupSnapshot } from '../../api/src/ownership.js';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { createCleanupWorker, type CleanupDockerContainer } from '../../cleanup-worker/src/main.js';

const NOW = '2026-07-27T12:00:00.000Z';
const EXPIRES = '2026-07-27T12:05:00.000Z';
const RUNNER_EXPIRES = '2026-07-27T11:55:00.000Z';
const MANIFEST_SHA = 'a'.repeat(64);
const IMAGE_DIGEST = 'b'.repeat(64);
const SHA256 = 'c'.repeat(64);
const UID = process.getuid?.() ?? 0;
const LABEL_JOB = 'org.osi.image-builder.job-id';
const LABEL_MANIFEST = 'org.osi.image-builder.manifest-sha';
const roots: string[] = [];
const databases: Array<ReturnType<typeof openBuilderDatabase>> = [];

function labels(jobId: string) { return { [LABEL_JOB]: jobId, [LABEL_MANIFEST]: MANIFEST_SHA }; }

function sourcePreparation() {
  return {
    schemaVersion: 1,
    sourceSha: 'd'.repeat(40),
    gitmodulesBlobSha: 'e'.repeat(40),
    preparedAt: NOW,
    components: [
      { path: 'feeds/chirpstack-openwrt-feed', mode: '040000', type: 'tree', objectId: 'f'.repeat(40), provenanceUrl: 'https://github.com/chirpstack/chirpstack-openwrt-feed.git' },
      { path: 'openwrt', mode: '040000', type: 'tree', objectId: 'a'.repeat(40), provenanceUrl: 'https://github.com/openwrt/openwrt.git' },
    ],
  };
}

function offlineFeedPreparation(jobId: string) {
  const recursiveSubmoduleStatusSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  return {
    schemaVersion: 1,
    boundary: 'api-prepared-pinned-feeds-v1',
    networkPolicy: 'runner-offline',
    jobId,
    sourceSha: 'd'.repeat(40),
    preparedAt: NOW,
    feeds: [
      { name: 'packages', location: 'https://git.openwrt.org/feed/packages.git', commit: '1'.repeat(40), detached: true, clean: true, recursiveSubmodulesPrepared: true, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: '1'.repeat(64) },
      { name: 'luci', location: 'https://git.openwrt.org/project/luci.git', commit: '2'.repeat(40), detached: true, clean: true, recursiveSubmodulesPrepared: true, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: '2'.repeat(64) },
      { name: 'routing', location: 'https://git.openwrt.org/feed/routing.git', commit: '3'.repeat(40), detached: true, clean: true, recursiveSubmodulesPrepared: true, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: '3'.repeat(64) },
    ],
  };
}

function seed(db: ReturnType<typeof openBuilderDatabase>, jobId: string, staging: boolean): CleanupSnapshot {
  db.prepare(`INSERT INTO jobs (
    job_id, request_id, request_json, source_remote, source_ref, source_branch, branch,
    expected_sha, pinned_sha, source_preparation_json, offline_feed_preparation_json, target_id, root_id, target_manifest_sha256,
    source_commit_time, source_author, source_subject, accepted_at, state, queue_state,
    queue_position, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', 'dispatched', NULL, ?, ?)`).run(
    jobId, `request-${jobId}`, JSON.stringify({ branch: 'main' }), 'git@example.com:osi-os.git',
    'refs/remotes/origin/main', 'main', 'main', 'd'.repeat(40), 'd'.repeat(40), JSON.stringify(sourcePreparation()), JSON.stringify(offlineFeedPreparation(jobId)), 'rpi-5',
    'release', MANIFEST_SHA, NOW, 'test', 'integration', NOW, NOW, NOW,
  );
  db.prepare(`UPDATE jobs SET dispatched_at=?, runner_unit=?, runner_lease_owner='runner-owner', runner_lease_expires_at=?, runner_started_at=? WHERE job_id=?`).run(
    NOW,
    `osi-image-builder-runner@${jobId}.service`, RUNNER_EXPIRES, NOW, jobId,
  );
  if (!staging) {
    db.prepare(`UPDATE jobs SET
      container_id=?, container_name=?, container_image_digest=?, container_label_job_id=?,
      container_label_manifest_sha=?, container_labels_json=?, container_mount_json=?,
      container_env_json=?, container_security_json=?, container_inspection_json=?,
      container_created_at=?, container_started_at=? WHERE job_id=?`).run(
      `container-${jobId}`, `osi-${jobId}`, IMAGE_DIGEST, jobId, MANIFEST_SHA,
      JSON.stringify(labels(jobId)), JSON.stringify({ source: '/tmp/worktree', destination: '/work' }),
      JSON.stringify({ CI: '1' }), JSON.stringify({ noNewPrivileges: true }), JSON.stringify({ running: true }),
      NOW, NOW, jobId,
    );
  }
  if (staging) {
    db.prepare(`UPDATE jobs SET publish_state='not_started', artifact_staging_path=?, artifact_sha256=?, artifact_size=10,
      artifact_mtime=?, checksum_path=?, checksum_sha256=?, manifest_path=?, manifest_sha256=?, verification_path=?, verification_sha256=?
      WHERE job_id=?`).run(
      `staging/${jobId}/image`, SHA256, NOW, `staging/${jobId}/sha256sums`, SHA256,
      `staging/${jobId}/build-manifest.json`, SHA256, `staging/${jobId}/verification.json`, SHA256, jobId,
    );
  }
  return {
    runner: { unit: `osi-image-builder-runner@${jobId}.service`, owner: 'runner-owner', leaseExpiresAt: RUNNER_EXPIRES, inactiveAt: NOW, observedAt: NOW },
    state: 'starting',
    container: staging
      ? { kind: 'absent', globalLabelResult: 'no-match', observedAt: NOW }
      : { kind: 'present', id: `container-${jobId}`, name: `osi-${jobId}`, imageDigest: IMAGE_DIGEST, labels: labels(jobId), globalLabelResult: 'single-exact-match', observedAt: NOW },
    staging: staging ? { kind: 'present', path: `staging/${jobId}/image`, sha256: SHA256, size: 10 } : { kind: 'absent', path: null },
    logs: { runner: 'absent', docker: 'absent', verifiedAt: NOW },
    blocker: staging ? 'staging-or-log' : 'container',
  };
}

async function setup(staging = false) {
  const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-worker-integration-')); roots.push(root);
  const db = openBuilderDatabase(join(root, 'state.sqlite')); databases.push(db);
  const jobId = staging ? 'integration-staging' : 'integration-present';
  const admissionId = staging ? 'cln_0123456789abcdefghjkmnpqrt' : 'cln_0123456789abcdefghjkmnpqrs';
  const token = `token-${jobId}-0123456789abcdef`;
  const proof = seed(db, jobId, staging);
  const tokenHash = createHash('sha256').update(token).digest('hex');
  db.prepare(`INSERT INTO cleanup_leases (
    admission_id, job_id, unit_name, owner, expires_at, status, credential_relative_path,
    credential_sha256, fence_generation, fence_token_hash, stale_runner_unit, stale_runner_owner,
    stale_runner_lease_expires_at, stale_state, stale_container_id, stale_container_name,
    stale_container_labels_json, proof_json, admitted_at
  ) VALUES (?, ?, ?, 'cleanup-worker', ?, 'admitted', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    admissionId, jobId, `osi-image-builder-cleanup@${admissionId}.service`, EXPIRES,
    `recovery/cleanup-credentials/${admissionId}.token`, SHA256, tokenHash,
    proof.runner.unit, proof.runner.owner, proof.runner.leaseExpiresAt, proof.state,
    proof.container.kind === 'present' ? proof.container.id : null,
    proof.container.kind === 'present' ? proof.container.name : null,
    proof.container.kind === 'present' ? JSON.stringify(proof.container.labels) : null,
    JSON.stringify({
      ...proof,
      logs: {
        ...proof.logs,
        generationIdentity: { runner: [], docker: [] },
      },
    }), NOW,
  );
  db.prepare(`UPDATE jobs SET cleanup_generation=1, cleanup_fence_generation=1, cleanup_fence_token_hash=?, cleanup_admission_id=? WHERE job_id=?`).run(tokenHash, admissionId, jobId);
  const credentialDirectory = join(root, 'jobs', jobId, 'recovery', 'cleanup-credentials');
  await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
  const credentialPath = join(credentialDirectory, `${admissionId}.token`);
  const credentialBytes = Buffer.from(`${JSON.stringify({ admissionId, generation: 1, token })}\n`);
  await writeFile(credentialPath, credentialBytes, { mode: 0o600, flag: 'wx' });
  db.prepare('UPDATE cleanup_leases SET credential_sha256=? WHERE admission_id=?').run(createHash('sha256').update(credentialBytes).digest('hex'), admissionId);

  let present = !staging;
  const calls: string[] = [];
  const inspect = vi.fn(async (id: string) => { calls.push(`inspect:${id}`); return present ? { id, name: `osi-${jobId}`, imageDigest: IMAGE_DIGEST, labels: labels(jobId), running: true, stoppedAt: null } : null; });
  const docker = {
    inspect,
    stop: vi.fn(async (id: string) => { calls.push(`stop:${id}`); }),
    waitForStopped: vi.fn(async (id: string) => { calls.push(`wait:${id}`); return { id, name: `osi-${jobId}`, imageDigest: IMAGE_DIGEST, labels: labels(jobId), running: false, stoppedAt: NOW }; }),
    remove: vi.fn(async (id: string) => { calls.push(`remove:${id}`); present = false; }),
    hasByJobId: vi.fn(async () => { calls.push('has'); return false; }),
    listByJobId: vi.fn(async () => { calls.push('list'); return []; }),
  };
  const quarantine = vi.fn(async () => staging
    ? ({ kind: 'quarantined' as const, sourcePath: `staging/${jobId}`, destinationPath: `quarantine/${jobId}`, sourceAbsent: true as const, destinationPresent: true as const, sha256: SHA256, size: 10, verifiedAt: NOW })
    : ({ kind: 'absent' as const, path: null, sourcePath: `staging/${jobId}`, sourceAbsent: true as const, verifiedAt: NOW }));
  const evidence = vi.fn(async () => ({ path: `jobs/${jobId}/evidence/cleanup.json`, sha256: SHA256 }));
  const worker = createCleanupWorker({
    db,
    stateRoot: root,
    ownerUid: UID,
    workerOwner: 'cleanup-worker',
    clock: { now: () => NOW },
    ownership: new OwnershipStore(db, { now: () => NOW }),
    fileSystem: createRecoveryFileSystem(),
    systemd: {
      inspect: vi.fn(async (unit: string) => ({ unit, active: false, observedAt: NOW })),
    },
    docker,
    logSealer: { seal: vi.fn(async ({ at }: { at: string }) => ({ runner: 'absent' as const, docker: 'absent' as const, verifiedAt: at, contiguous: true as const })) },
    quarantine: { quarantine },
    evidenceWriter: { write: evidence },
    timeouts: { dockerMs: 1_000, systemdMs: 1_000 },
  });
  return { root, db, jobId, admissionId, credentialPath, docker, quarantine, evidence, worker };
}

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('cleanup worker real SQLite integration', () => {
  it('serializes the admission claim and leaves the recovery fence for API hand-back', async () => {
    const value = await setup(false);
    const first = await value.worker.run([value.admissionId]);
    expect(first.status).toBe('completed');
    await expect(value.worker.run([value.admissionId])).rejects.toThrow();
    expect(value.docker.stop).toHaveBeenCalledOnce();
    expect(value.docker.remove).toHaveBeenCalledOnce();
    expect(value.docker.hasByJobId).toHaveBeenCalledWith(value.jobId, 1_000);
    expect((value.db.prepare(`SELECT status, cleanup_fence_generation, cleanup_admission_id, state, queue_state, terminal_at
      FROM cleanup_leases JOIN jobs USING (job_id) WHERE admission_id=?`).get(value.admissionId) as Record<string, unknown>)).toMatchObject({ status: 'completed', cleanup_fence_generation: 1, cleanup_admission_id: value.admissionId, state: 'starting', queue_state: 'dispatched', terminal_at: null });
    await expect(readFile(value.credentialPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the native no-overwrite quarantine adapter for staging and records no normal publication mutation', async () => {
    const value = await setup(true);
    const before = value.db.prepare(`SELECT state, queue_state, terminal_at, publish_state, artifact_final_directory, artifact_final_path,
      artifact_staging_path, artifact_quarantine_path FROM jobs WHERE job_id=?`).get(value.jobId);
    const result = await value.worker.run([value.admissionId]);
    expect(result.status).toBe('completed');
    expect(value.docker.inspect).not.toHaveBeenCalled();
    expect(value.docker.stop).not.toHaveBeenCalled();
    expect(value.docker.remove).not.toHaveBeenCalled();
    expect(value.docker.hasByJobId).toHaveBeenCalledWith(value.jobId, 1_000);
    expect(value.quarantine).toHaveBeenCalledWith({
      rootId: 'release',
      jobId: value.jobId,
      admittedStaging: {
        kind: 'present',
        path: `staging/${value.jobId}/image`,
        sha256: SHA256,
        size: 10,
      },
      stagingPath: `staging/${value.jobId}/image`,
      artifactSha256: SHA256,
      artifactSize: 10,
    });
    const after = value.db.prepare(`SELECT state, queue_state, terminal_at, publish_state, artifact_final_directory, artifact_final_path,
      artifact_staging_path, artifact_quarantine_path FROM jobs WHERE job_id=?`).get(value.jobId) as Record<string, unknown>;
    expect(after).toEqual(before);
    expect(value.evidence).toHaveBeenCalledOnce();
  });
});
