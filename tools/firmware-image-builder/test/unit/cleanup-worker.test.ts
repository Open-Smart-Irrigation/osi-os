import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRecoveryFileSystem } from '../../api/src/recovery.js';
import { OwnershipStore, type CleanupSnapshot } from '../../api/src/ownership.js';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import type { JsonObject } from '../../api/src/validation.js';
import { createCleanupWorker, type CleanupDockerContainer, type CleanupWorkerOptions } from '../../cleanup-worker/src/main.js';

const NOW = '2026-07-27T12:00:00.000Z';
const STOPPED = NOW;
const EXPIRED = '2026-07-27T11:59:30.000Z';
const ADMISSION_EXPIRES = '2026-07-27T12:05:00.000Z';
const RUNNER_EXPIRES = '2026-07-27T11:55:00.000Z';
const RUNNER_ACTIVE_EXPIRES = '2026-07-27T12:05:00.000Z';
const MANIFEST_SHA = 'a'.repeat(64);
const IMAGE_DIGEST = 'b'.repeat(64);
const SHA256 = 'c'.repeat(64);
const OWNER_UID = process.getuid?.() ?? 0;
const LABEL_JOB = 'org.osi.image-builder.job-id';
const LABEL_MANIFEST = 'org.osi.image-builder.manifest-sha';

type Db = ReturnType<typeof openBuilderDatabase>;
type Scenario = 'present' | 'absent' | 'staging-log' | 'physical-staging';

const paths: string[] = [];
const databases: Db[] = [];

function labels(jobId: string): JsonObject {
  return { [LABEL_JOB]: jobId, [LABEL_MANIFEST]: MANIFEST_SHA };
}

function container(jobId: string, id = `container-${jobId}`, running = true, stoppedAt: string | null = null): CleanupDockerContainer {
  return {
    id,
    name: `osi-${jobId}`,
    imageDigest: IMAGE_DIGEST,
    labels: labels(jobId),
    running,
    stoppedAt,
  };
}

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

function snapshot(jobId: string, scenario: Scenario, runnerExpiresAt = RUNNER_EXPIRES): CleanupSnapshot {
  const present = scenario === 'present' || scenario === 'absent';
  return {
    runner: {
      unit: `osi-image-builder-runner@${jobId}.service`,
      owner: 'runner-owner',
      leaseExpiresAt: runnerExpiresAt,
      inactiveAt: NOW,
      observedAt: NOW,
    },
    state: 'starting',
    container: present
      ? {
          kind: 'present',
          id: `container-${jobId}`,
          name: `osi-${jobId}`,
          imageDigest: IMAGE_DIGEST,
          labels: labels(jobId),
          globalLabelResult: 'single-exact-match',
          observedAt: NOW,
        }
      : { kind: 'absent', globalLabelResult: 'no-match', observedAt: NOW },
    staging: scenario === 'physical-staging'
      ? { kind: 'physical-present', path: `staging/${jobId}`, sha256: null, size: null, observedAt: NOW }
      : { kind: 'absent', path: null },
    logs: scenario === 'staging-log'
      ? { runner: 'unsealed', docker: 'unsealed', verifiedAt: NOW }
      : { runner: 'absent', docker: 'absent', verifiedAt: NOW },
    blocker: present ? 'container' : scenario === 'staging-log' || scenario === 'physical-staging' ? 'staging-or-log' : 'none',
  };
}

function seedJob(db: Db, jobId: string, scenario: Scenario, state = 'starting'): void {
  db.prepare(`INSERT INTO jobs (
    job_id, request_id, request_json, source_remote, source_ref, source_branch, branch,
    expected_sha, pinned_sha, source_preparation_json, offline_feed_preparation_json, target_id, root_id, target_manifest_sha256,
    source_commit_time, source_author, source_subject, accepted_at, state, queue_state,
    queue_position, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatched', NULL, ?, ?)`).run(
    jobId,
    `request-${jobId}`,
    JSON.stringify({ branch: 'main', target: 'rpi-5' }),
    'git@example.com:osi-os.git',
    'refs/remotes/origin/main',
    'main',
    'main',
    'd'.repeat(40),
    'd'.repeat(40),
    JSON.stringify(sourcePreparation()),
    JSON.stringify(offlineFeedPreparation(jobId)),
    'rpi-5',
    'release',
    MANIFEST_SHA,
    NOW,
    'test',
    'cleanup test',
    NOW,
    state,
    NOW,
    NOW,
  );
  db.prepare(`UPDATE jobs SET dispatched_at=?, runner_unit=?, runner_lease_owner='runner-owner', runner_lease_expires_at=?, runner_started_at=? WHERE job_id=?`).run(
    NOW,
    `osi-image-builder-runner@${jobId}.service`,
    RUNNER_EXPIRES,
    NOW,
    jobId,
  );
  if (scenario === 'present' || scenario === 'absent') {
    const stoppedAt = scenario === 'absent' ? STOPPED : null;
    db.prepare(`UPDATE jobs SET
      container_id=?, container_name=?, container_image_digest=?, container_label_job_id=?,
      container_label_manifest_sha=?, container_labels_json=?, container_mount_json=?,
      container_env_json=?, container_security_json=?, container_inspection_json=?,
      container_created_at=?, container_started_at=?, container_stopped_at=?
      WHERE job_id=?`).run(
      `container-${jobId}`,
      `osi-${jobId}`,
      IMAGE_DIGEST,
      jobId,
      MANIFEST_SHA,
      JSON.stringify(labels(jobId)),
      JSON.stringify({ source: '/tmp/worktree', destination: '/work' }),
      JSON.stringify({ CI: '1' }),
      JSON.stringify({ noNewPrivileges: true }),
      JSON.stringify({ running: scenario === 'present' }),
      NOW,
      NOW,
      stoppedAt,
      jobId,
    );
  }
  if (scenario === 'staging-log') {
    for (const stream of ['runner', 'docker'] as const) {
      db.prepare(`INSERT INTO job_log_generations (job_id, stream, generation, path, started_at, size_bytes)
        VALUES (?, ?, 0, ?, ?, 0)`).run(jobId, stream, `logs/${stream}-0.log`, NOW);
    }
    db.prepare('UPDATE jobs SET cleanup_blocker_code=?, cleanup_blocker_json=? WHERE job_id=?').run(
      'RECOVERY_LOG_GAP',
      JSON.stringify({ code: 'RECOVERY_LOG_GAP', observedAt: NOW }),
      jobId,
    );
  }
  if (scenario === 'physical-staging') {
    db.prepare(`UPDATE jobs SET publish_state='not_started', cleanup_blocker_code=?, cleanup_blocker_json=? WHERE job_id=?`).run(
      'QUARANTINE_PENDING',
      JSON.stringify({ code: 'QUARANTINE_PENDING', observedAt: NOW }),
      jobId,
    );
  }
}

async function createCredential(root: string, jobId: string, admissionId: string, generation: number, token: string): Promise<{ path: string; sha256: string }> {
  const directory = join(root, 'jobs', jobId, 'recovery', 'cleanup-credentials');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${admissionId}.token`);
  const bytes = Buffer.from(`${JSON.stringify({ admissionId, generation, token })}\n`, 'utf8');
  await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function addAdmission(db: Db, jobId: string, scenario: Scenario, admissionId: string, token: string, status = 'admitted', expiresAt = ADMISSION_EXPIRES, runnerExpiresAt = RUNNER_EXPIRES): void {
  const proof = snapshot(jobId, scenario, runnerExpiresAt);
  const generationIdentity = { runner: [], docker: [] } as {
    runner: Array<{ generation: number; path: string; startedAt: string }>;
    docker: Array<{ generation: number; path: string; startedAt: string }>;
  };
  for (const stream of ['runner', 'docker'] as const) {
    generationIdentity[stream] = db.prepare(
      'SELECT generation, path, started_at AS startedAt FROM job_log_generations WHERE job_id=? AND stream=? ORDER BY generation',
    ).all(jobId, stream) as Array<{ generation: number; path: string; startedAt: string }>;
  }
  const persistedProof = { ...proof, logs: { ...proof.logs, generationIdentity } };
  const tokenHash = createHash('sha256').update(token).digest('hex');
  db.prepare(`INSERT INTO cleanup_leases (
    admission_id, job_id, unit_name, owner, expires_at, status, credential_relative_path,
    credential_sha256, fence_generation, fence_token_hash, stale_runner_unit,
    stale_runner_owner, stale_runner_lease_expires_at, stale_state, stale_container_id,
    stale_container_name, stale_container_labels_json, proof_json, admitted_at, claim_at
  ) VALUES (?, ?, ?, 'cleanup-worker', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    admissionId,
    jobId,
    `osi-image-builder-cleanup@${admissionId}.service`,
    expiresAt,
    status,
    `recovery/cleanup-credentials/${admissionId}.token`,
    SHA256,
    tokenHash,
    proof.runner.unit,
    proof.runner.owner,
    proof.runner.leaseExpiresAt,
    proof.state,
    proof.container.kind === 'present' ? proof.container.id : null,
    proof.container.kind === 'present' ? proof.container.name : null,
    proof.container.kind === 'present' ? JSON.stringify(proof.container.labels) : null,
    JSON.stringify(persistedProof),
    NOW,
    status === 'claimed' ? NOW : null,
  );
  db.prepare(`UPDATE jobs SET cleanup_generation=1, cleanup_fence_generation=1, cleanup_fence_token_hash=?, cleanup_admission_id=? WHERE job_id=?`).run(tokenHash, admissionId, jobId);
}

function createDocker(overrides: Partial<{
  inspect: (id: string, timeoutMs: number) => Promise<CleanupDockerContainer | null>;
  stop: (id: string, timeoutMs: number) => Promise<void>;
  waitForStopped: (id: string, timeoutMs: number) => Promise<CleanupDockerContainer>;
  remove: (id: string, timeoutMs: number) => Promise<void>;
  listByJobId: (jobId: string, timeoutMs: number) => Promise<readonly CleanupDockerContainer[]>;
}> = {}) {
  const calls: string[] = [];
  let present = true;
  const docker = {
    calls,
    inspect: vi.fn(async (id: string, timeoutMs: number) => { calls.push(`inspect:${id}:${timeoutMs}`); return present ? container('job-1', id, true) : null; }),
    stop: vi.fn(async (id: string, timeoutMs: number) => { calls.push(`stop:${id}:${timeoutMs}`); }),
    waitForStopped: vi.fn(async (id: string, timeoutMs: number) => { calls.push(`wait:${id}:${timeoutMs}`); return container('job-1', id, false, STOPPED); }),
    remove: vi.fn(async (id: string, timeoutMs: number) => { calls.push(`remove:${id}:${timeoutMs}`); present = false; }),
    listByJobId: vi.fn(async (_jobId: string, timeoutMs: number) => { calls.push(`list:${timeoutMs}`); return []; }),
    setPresent(value: boolean) { present = value; },
    ...overrides,
  };
  return docker;
}

function baseOptions(db: Db, root: string, docker: ReturnType<typeof createDocker>, jobId = 'job-1'): CleanupWorkerOptions {
  const logSealer = {
    seal: vi.fn(async ({ at }: { jobId: string; admissionId: string; at: string }) => {
      for (const stream of ['runner', 'docker'] as const) {
        db.prepare('UPDATE job_log_generations SET sealed_at=?, sha256=? WHERE job_id=? AND stream=? AND sealed_at IS NULL').run(at, SHA256, jobId, stream);
      }
      const state = (stream: 'runner' | 'docker') => {
        const row = db.prepare('SELECT COUNT(*) AS count FROM job_log_generations WHERE job_id=? AND stream=?').get(jobId, stream) as { count: number };
        return row.count === 0 ? 'absent' as const : 'sealed' as const;
      };
      return { runner: state('runner'), docker: state('docker'), verifiedAt: at, contiguous: true as const };
    }),
  };
  return {
    db,
    stateRoot: root,
    ownerUid: OWNER_UID,
    workerOwner: 'cleanup-worker',
    clock: { now: () => NOW },
    ownership: new OwnershipStore(db, { now: () => NOW }),
    fileSystem: createRecoveryFileSystem(),
    systemd: {
      inspect: vi.fn(async (unit: string) => ({ unit, active: false, observedAt: NOW })),
    },
    docker,
    logSealer,
    quarantine: {
      quarantine: vi.fn(async () => ({
        kind: 'absent' as const,
        path: null,
        sourcePath: `staging/${jobId}`,
        sourceAbsent: true as const,
        verifiedAt: NOW,
      })),
    },
    evidenceWriter: { write: vi.fn(async () => ({ path: `jobs/${jobId}/evidence/cleanup.json`, sha256: SHA256 })) },
    timeouts: { dockerMs: 1_000, systemdMs: 1_000 },
  };
}

async function fixture(scenario: Scenario = 'present', overrides: { status?: string; expiresAt?: string; runnerExpiresAt?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-worker-')); paths.push(root);
  const db = openBuilderDatabase(join(root, 'state.sqlite')); databases.push(db);
  const jobId = 'job-1';
  const admissionId = 'cln_0123456789abcdefghjkmnpqrs';
  const token = 'cleanup-token-0123456789';
  seedJob(db, jobId, scenario);
  addAdmission(db, jobId, scenario, admissionId, token, overrides.status, overrides.expiresAt, overrides.runnerExpiresAt);
  const credential = await createCredential(root, jobId, admissionId, 1, token);
  db.prepare('UPDATE cleanup_leases SET credential_sha256=? WHERE admission_id=?').run(credential.sha256, admissionId);
  const docker = createDocker();
  const options = baseOptions(db, root, docker, jobId);
  return { root, db, jobId, admissionId, token, credential, docker, options, worker: createCleanupWorker(options) };
}

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('cleanup worker argument and admission fence', () => {
  it('rejects malformed or extra dynamic arguments before DB, filesystem, Docker, publisher, or ownership actions', async () => {
    const prepare = vi.fn();
    const openDirectory = vi.fn();
    const cleanupWrite = vi.fn();
    const inspectRunner = vi.fn();
    const db = { prepare } as never;
    const fileSystem = { openDirectory } as never;
    const docker = createDocker();
    const ownership = { cleanupWrite } as never;
    const worker = createCleanupWorker({
      db,
      stateRoot: '/unused',
      ownerUid: OWNER_UID,
      workerOwner: 'cleanup-worker',
      clock: { now: () => NOW },
      ownership,
      fileSystem,
      systemd: { inspect: inspectRunner },
      docker,
      logSealer: { seal: vi.fn() },
      quarantine: { quarantine: vi.fn() },
      evidenceWriter: { write: vi.fn() },
      timeouts: { dockerMs: 1_000, systemdMs: 1_000 },
    });
    for (const argv of [[], ['bad'], ['cln_0123456789abcdefghjkmnpqrs', 'extra'], ['cln_8123456789abcdefghjkmnpqrs']]) {
      await expect(worker.run(argv)).rejects.toThrow();
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(openDirectory).not.toHaveBeenCalled();
    expect(inspectRunner).not.toHaveBeenCalled();
    expect(docker.inspect).not.toHaveBeenCalled();
    expect(cleanupWrite).not.toHaveBeenCalled();
  });

  it('claims an admitted-before-start admission and completes exact present-container cleanup', async () => {
    const value = await fixture('present');
    const result = await value.worker.run([value.admissionId]);
    expect(result.status).toBe('completed');
    expect(value.docker.calls).toEqual([
      'inspect:container-job-1:1000',
      'stop:container-job-1:1000',
      'wait:container-job-1:1000',
      'remove:container-job-1:1000',
      'inspect:container-job-1:1000',
      'list:1000',
    ]);
    expect(await readFile(value.credential.path).catch(() => null)).toBeNull();
    expect((value.db.prepare('SELECT status FROM cleanup_leases WHERE admission_id=?').get(value.admissionId) as { status: string }).status).toBe('completed');
    expect((value.db.prepare('SELECT container_id, cleanup_fence_generation, state, queue_state FROM jobs WHERE job_id=?').get(value.jobId) as Record<string, unknown>)).toMatchObject({ container_id: null, cleanup_fence_generation: 1, state: 'starting', queue_state: 'dispatched' });
  });

  it.each([
    ['claimed active/unexpired', 'claimed', ADMISSION_EXPIRES, RUNNER_ACTIVE_EXPIRES],
    ['claimed inactive/unexpired', 'claimed', ADMISSION_EXPIRES, RUNNER_EXPIRES],
    ['claimed inactive/expired', 'claimed', EXPIRED, RUNNER_EXPIRES],
    ['claimed active/expired', 'claimed', EXPIRED, RUNNER_ACTIVE_EXPIRES],
  ])('rejects %s before cleanup side effects', async (_name, status, expiresAt, runnerExpiresAt) => {
    const value = await fixture('present', { status, expiresAt, runnerExpiresAt });
    await expect(value.worker.run([value.admissionId])).rejects.toThrow();
    expect(value.docker.calls).toEqual([]);
    expect((value.db.prepare('SELECT status, container_id FROM cleanup_leases JOIN jobs USING (job_id) WHERE admission_id=?').get(value.admissionId) as Record<string, unknown>)).toMatchObject({ status: 'claimed', container_id: `container-${value.jobId}` });
  });

  it('rejects an admitted but expired lease before cleanup side effects', async () => {
    const value = await fixture('present', { expiresAt: EXPIRED });
    await expect(value.worker.run([value.admissionId])).rejects.toThrow();
    expect(value.docker.calls).toEqual([]);
    expect(value.options.logSealer.seal).not.toHaveBeenCalled();
    expect(value.options.quarantine.quarantine).not.toHaveBeenCalled();
  });

  it('rejects a mismatched persisted cleanup owner before cleanup side effects', async () => {
    const value = await fixture('present');
    value.db.prepare('UPDATE cleanup_leases SET owner=? WHERE admission_id=?').run('wrong-owner', value.admissionId);
    await expect(value.worker.run([value.admissionId])).rejects.toThrow();
    expect(value.docker.calls).toEqual([]);
  });

  it('blocks every cleanup side effect when the exact runner unit is active', async () => {
    const value = await fixture('present');
    vi.spyOn(value.options.systemd, 'inspect').mockImplementation(async (unit) => ({
      unit,
      active: true,
      observedAt: NOW,
    }));
    const before = value.db.prepare('SELECT container_id, state, queue_state FROM jobs WHERE job_id=?').get(value.jobId);
    await expect(value.worker.run([value.admissionId])).rejects.toThrow(/runner unit is not proven inactive/u);
    expect(value.docker.calls).toEqual([]);
    expect(value.options.logSealer.seal).not.toHaveBeenCalled();
    expect(value.options.quarantine.quarantine).not.toHaveBeenCalled();
    expect(value.options.evidenceWriter.write).not.toHaveBeenCalled();
    expect(value.db.prepare('SELECT container_id, state, queue_state FROM jobs WHERE job_id=?').get(value.jobId)).toEqual(before);
    await expect(readFile(value.credential.path)).resolves.toBeDefined();
  });

  it('rechecks runner inactivity after evidence and immediately before cleanup completion CAS', async () => {
    const value = await fixture('present');
    let evidenceWritten = false;
    vi.spyOn(value.options.evidenceWriter, 'write').mockImplementationOnce(async () => {
      evidenceWritten = true;
      return { path: `jobs/${value.jobId}/evidence/cleanup.json`, sha256: SHA256 };
    });
    vi.spyOn(value.options.systemd, 'inspect').mockImplementation(async (unit) => ({
      unit,
      active: evidenceWritten,
      observedAt: NOW,
    }));
    await expect(value.worker.run([value.admissionId])).rejects.toThrow(/runner unit is not proven inactive before cleanup completion CAS/u);
    expect(value.db.prepare('SELECT status FROM cleanup_leases WHERE admission_id=?').get(value.admissionId)).toEqual({ status: 'claimed' });
    expect(value.db.prepare('SELECT container_id, cleanup_fence_generation FROM jobs WHERE job_id=?').get(value.jobId)).toEqual({
      container_id: `container-${value.jobId}`,
      cleanup_fence_generation: 1,
    });
    expect(value.db.prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id=? AND event_type='cleanup_complete'").get(value.jobId)).toEqual({ count: 0 });
  });

  it('rechecks runner inactivity after blocked evidence and immediately before blocker CAS', async () => {
    const value = await fixture('staging-log');
    let evidenceWritten = false;
    vi.spyOn(value.options.logSealer, 'seal').mockRejectedValueOnce(new Error('seal failed'));
    vi.spyOn(value.options.evidenceWriter, 'write').mockImplementationOnce(async () => {
      evidenceWritten = true;
      return { path: `jobs/${value.jobId}/evidence/cleanup.json`, sha256: SHA256 };
    });
    vi.spyOn(value.options.systemd, 'inspect').mockImplementation(async (unit) => ({
      unit,
      active: evidenceWritten,
      observedAt: NOW,
    }));
    await expect(value.worker.run([value.admissionId])).rejects.toThrow(/runner unit is not proven inactive before cleanup blocker CAS/u);
    expect(value.db.prepare('SELECT status FROM cleanup_leases WHERE admission_id=?').get(value.admissionId)).toEqual({ status: 'claimed' });
    expect(value.db.prepare('SELECT cleanup_blocker_code, cleanup_fence_generation FROM jobs WHERE job_id=?').get(value.jobId)).toEqual({
      cleanup_blocker_code: 'RECOVERY_LOG_GAP',
      cleanup_fence_generation: 1,
    });
  });

  it('rejects a wrong credential token even when the credential file hash is exact', async () => {
    const value = await fixture('present');
    const bytes = Buffer.from(`${JSON.stringify({
      admissionId: value.admissionId,
      generation: 1,
      token: 'wrong-token-0123456789',
    })}\n`);
    await writeFile(value.credential.path, bytes, { mode: 0o600 });
    value.db.prepare('UPDATE cleanup_leases SET credential_sha256=? WHERE admission_id=?').run(
      createHash('sha256').update(bytes).digest('hex'),
      value.admissionId,
    );
    await expect(value.worker.run([value.admissionId])).rejects.toThrow();
    expect(value.docker.calls).toEqual([]);
  });

  it('rejects an unsafe credential mode before cleanup side effects', async () => {
    const value = await fixture('present');
    await chmod(value.credential.path, 0o640);
    await expect(value.worker.run([value.admissionId])).rejects.toThrow();
    expect(value.docker.calls).toEqual([]);
  });

  it('rejects wrong admission, wrong unit, wrong generation/token, wrong label, and non-listed state without Docker action', async () => {
    const wrongAdmission = await fixture('present');
    await expect(wrongAdmission.worker.run(['cln_00000000000000000000000000'])).rejects.toThrow();
    expect(wrongAdmission.docker.calls).toEqual([]);

    const wrongUnit = await fixture('present');
    wrongUnit.db.exec('PRAGMA ignore_check_constraints=ON');
    wrongUnit.db.prepare('UPDATE cleanup_leases SET unit_name=? WHERE admission_id=?').run('osi-image-builder-cleanup@wrong.service', wrongUnit.admissionId);
    await expect(wrongUnit.worker.run([wrongUnit.admissionId])).rejects.toThrow();
    expect(wrongUnit.docker.calls).toEqual([]);

    const wrongCredential = await fixture('present');
    await writeFile(wrongCredential.credential.path, JSON.stringify({ admissionId: wrongCredential.admissionId, generation: 2, token: wrongCredential.token }), { mode: 0o600 });
    await expect(wrongCredential.worker.run([wrongCredential.admissionId])).rejects.toThrow();
    expect(wrongCredential.docker.calls).toEqual([]);

    const wrongLabel = await fixture('present');
    const wrongProof = JSON.parse((wrongLabel.db.prepare('SELECT proof_json FROM cleanup_leases WHERE admission_id=?').get(wrongLabel.admissionId) as { proof_json: string }).proof_json) as CleanupSnapshot;
    if (wrongProof.container.kind !== 'present') throw new Error('expected present-container proof');
    (wrongProof.container.labels as Record<string, JsonObject[string]>)[LABEL_MANIFEST] = 'd'.repeat(64);
    wrongLabel.db.prepare('UPDATE cleanup_leases SET proof_json=? WHERE admission_id=?').run(JSON.stringify(wrongProof), wrongLabel.admissionId);
    await expect(wrongLabel.worker.run([wrongLabel.admissionId])).rejects.toThrow();
    expect(wrongLabel.docker.calls).toEqual([]);

    const wrongState = await fixture('present');
    wrongState.db.exec('PRAGMA ignore_check_constraints=ON');
    wrongState.db.prepare('UPDATE jobs SET state=? WHERE job_id=?').run('publishing', wrongState.jobId);
    await expect(wrongState.worker.run([wrongState.admissionId])).rejects.toThrow();
    expect(wrongState.docker.calls).toEqual([]);
  });
});

describe('cleanup worker exact container protocol', () => {
  it('handles an already-absent exact container without stop or remove', async () => {
    const value = await fixture('absent');
    value.docker.setPresent(false);
    const result = await value.worker.run([value.admissionId]);
    expect(result.status).toBe('completed');
    expect(value.docker.calls).toEqual(['inspect:container-job-1:1000', 'list:1000']);
    expect((value.db.prepare('SELECT status FROM cleanup_leases WHERE admission_id=?').get(value.admissionId) as { status: string }).status).toBe('completed');
  });

  it('records exact already-absent evidence without inventing stop or removal times', async () => {
    const value = await fixture('absent');
    value.db.prepare('UPDATE jobs SET container_stopped_at=NULL WHERE job_id=?').run(value.jobId);
    value.docker.setPresent(false);
    const result = await value.worker.run([value.admissionId]);
    expect(result.status).toBe('completed');
    const write = value.options.evidenceWriter.write as ReturnType<typeof vi.fn>;
    const evidence = write.mock.calls[0]?.[0].evidence as {
      postcondition: { container: Record<string, unknown> };
    };
    expect(evidence.postcondition.container).toMatchObject({
      kind: 'already-absent',
      id: `container-${value.jobId}`,
      exactIdAbsent: true,
      dockerAction: 'none',
      globalLabelResult: 'no-match',
      observedAt: NOW,
    });
    expect(evidence.postcondition.container).not.toHaveProperty('stoppedAt');
    expect(evidence.postcondition.container).not.toHaveProperty('removedAt');
    expect(value.docker.listByJobId).toHaveBeenCalledWith(value.jobId, 1000);
  });

  it.each([
    ['null identity', 'staging-log', { [LABEL_JOB]: 'job-1' }],
    ['null identity with wrong manifest', 'staging-log', { [LABEL_JOB]: 'job-1', [LABEL_MANIFEST]: 'd'.repeat(64) }],
    ['exact identity', 'absent', { [LABEL_JOB]: 'job-1' }],
    ['exact identity with wrong manifest', 'absent', { [LABEL_JOB]: 'job-1', [LABEL_MANIFEST]: 'd'.repeat(64) }],
  ] as const)('blocks %s when global discovery returns a job-labeled container', async (_case, fixtureKind, observedLabels) => {
    const value = await fixture(fixtureKind);
    if (fixtureKind === 'absent') value.docker.setPresent(false);
    vi.spyOn(value.docker, 'listByJobId').mockResolvedValueOnce([{
      ...container(value.jobId, 'unexpected-container'),
      labels: observedLabels,
    }]);
    await expect(value.worker.run([value.admissionId])).resolves.toMatchObject({
      status: 'blocked',
      blockerCode: 'DOCKER_CONTAINER_ORPHANED',
    });
    expect(value.docker.listByJobId).toHaveBeenCalledWith(value.jobId, 1000);
    expect(value.docker.stop).not.toHaveBeenCalled();
    expect(value.docker.remove).not.toHaveBeenCalled();
  });

  it('timestamps Docker absence and removal only after the corresponding observations complete', async () => {
    const nullIdentity = await fixture('staging-log');
    let nullNow = NOW;
    (nullIdentity.options.clock as { now: () => string }).now = () => nullNow;
    vi.spyOn(nullIdentity.docker, 'listByJobId').mockImplementationOnce(async (_jobId, timeoutMs) => {
      nullIdentity.docker.calls.push(`list:${timeoutMs}`);
      nullNow = '2026-07-27T12:00:01.000Z';
      return [];
    });
    await nullIdentity.worker.run([nullIdentity.admissionId]);
    const nullEvidence = (nullIdentity.options.evidenceWriter.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].evidence as {
      postcondition: { container: { observedAt: string } };
    };
    expect(nullEvidence.postcondition.container.observedAt).toBe('2026-07-27T12:00:01.000Z');

    const alreadyAbsent = await fixture('absent');
    let absentNow = NOW;
    (alreadyAbsent.options.clock as { now: () => string }).now = () => absentNow;
    alreadyAbsent.docker.setPresent(false);
    vi.spyOn(alreadyAbsent.docker, 'listByJobId').mockImplementationOnce(async (_jobId, timeoutMs) => {
      alreadyAbsent.docker.calls.push(`list:${timeoutMs}`);
      absentNow = '2026-07-27T12:00:02.000Z';
      return [];
    });
    await alreadyAbsent.worker.run([alreadyAbsent.admissionId]);
    const absentEvidence = (alreadyAbsent.options.evidenceWriter.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].evidence as {
      postcondition: { container: { observedAt: string } };
    };
    expect(absentEvidence.postcondition.container.observedAt).toBe('2026-07-27T12:00:02.000Z');

    const removed = await fixture('present');
    let removedNow = NOW;
    (removed.options.clock as { now: () => string }).now = () => removedNow;
    vi.spyOn(removed.docker, 'remove').mockImplementationOnce(async (id, timeoutMs) => {
      removed.docker.calls.push(`remove:${id}:${timeoutMs}`);
      removed.docker.setPresent(false);
      removedNow = '2026-07-27T12:00:03.000Z';
    });
    vi.spyOn(removed.docker, 'listByJobId').mockImplementationOnce(async (_jobId, timeoutMs) => {
      removed.docker.calls.push(`list:${timeoutMs}`);
      removedNow = '2026-07-27T12:00:04.000Z';
      return [];
    });
    await removed.worker.run([removed.admissionId]);
    const removedEvidence = (removed.options.evidenceWriter.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].evidence as {
      postcondition: { container: { removedAt: string; observedAt: string } };
    };
    expect(removedEvidence.postcondition.container).toMatchObject({
      removedAt: '2026-07-27T12:00:03.000Z',
      observedAt: '2026-07-27T12:00:04.000Z',
    });
  });

  it('accepts the exact Docker labels independent of object key order', async () => {
    const value = await fixture('present');
    vi.spyOn(value.docker, 'inspect').mockImplementationOnce(async (id, timeoutMs) => {
      value.docker.calls.push(`inspect:${id}:${timeoutMs}`);
      return {
        ...container(value.jobId, id),
        labels: {
          [LABEL_MANIFEST]: MANIFEST_SHA,
          [LABEL_JOB]: value.jobId,
        },
      };
    });
    const result = await value.worker.run([value.admissionId]);
    expect(result.status).toBe('completed');
  });

  it('does not stop or remove a Docker object with the wrong observed label', async () => {
    const value = await fixture('present');
    vi.spyOn(value.docker, 'inspect').mockImplementationOnce(async (id, timeoutMs) => {
      value.docker.calls.push(`inspect:${id}:${timeoutMs}`);
      return {
        ...container(value.jobId, id),
        labels: {
          [LABEL_JOB]: value.jobId,
          [LABEL_MANIFEST]: 'd'.repeat(64),
        },
      };
    });
    const result = await value.worker.run([value.admissionId]);
    expect(result).toMatchObject({ status: 'blocked', blockerCode: 'DOCKER_CONTAINER_ORPHANED' });
    expect(value.docker.stop).not.toHaveBeenCalled();
    expect(value.docker.remove).not.toHaveBeenCalled();
  });

  it('stops before the next side effect when the claimed cleanup lease expires', async () => {
    const value = await fixture('present');
    let now = NOW;
    (value.options.clock as { now: () => string }).now = () => now;
    vi.spyOn(value.docker, 'inspect').mockImplementationOnce(async (id, timeoutMs) => {
      value.docker.calls.push(`inspect:${id}:${timeoutMs}`);
      now = '2026-07-27T12:06:00.000Z';
      return container(value.jobId, id);
    });
    await expect(value.worker.run([value.admissionId])).rejects.toThrow();
    expect(value.docker.calls).toEqual(['inspect:container-job-1:1000']);
    expect(value.docker.stop).not.toHaveBeenCalled();
    expect(value.options.logSealer.seal).not.toHaveBeenCalled();
    expect(value.options.quarantine.quarantine).not.toHaveBeenCalled();
    expect(value.options.evidenceWriter.write).not.toHaveBeenCalled();
  });

  it('does not remove a container when Docker reports a future stop time', async () => {
    const value = await fixture('present');
    vi.spyOn(value.docker, 'waitForStopped').mockImplementationOnce(async (id, timeoutMs) => {
      value.docker.calls.push(`wait:${id}:${timeoutMs}`);
      return container(value.jobId, id, false, '2026-07-27T12:00:01.000Z');
    });
    const result = await value.worker.run([value.admissionId]);
    expect(result).toMatchObject({ status: 'blocked', blockerCode: 'DOCKER_CONTAINER_ORPHANED' });
    expect(value.docker.remove).not.toHaveBeenCalled();
    expect(value.docker.calls).toEqual([
      'inspect:container-job-1:1000',
      'stop:container-job-1:1000',
      'wait:container-job-1:1000',
    ]);
  });

  it('accepts log evidence produced during an advancing real-time operation', async () => {
    const value = await fixture('present');
    let now = NOW;
    (value.options.clock as { now: () => string }).now = () => now;
    vi.spyOn(value.options.logSealer, 'seal').mockImplementationOnce(async () => {
      now = '2026-07-27T12:00:01.000Z';
      return {
        runner: 'absent',
        docker: 'absent',
        verifiedAt: now,
        contiguous: true,
      };
    });
    const result = await value.worker.run([value.admissionId]);
    expect(result.status).toBe('completed');
  });

  it('rejects log verification observed before the sealing request', async () => {
    const value = await fixture('staging-log');
    vi.spyOn(value.options.logSealer, 'seal').mockResolvedValueOnce({
      runner: 'absent',
      docker: 'absent',
      verifiedAt: EXPIRED,
      contiguous: true,
    });
    await expect(value.worker.run([value.admissionId])).resolves.toMatchObject({
      status: 'blocked',
      blockerCode: 'RECOVERY_LOG_GAP',
    });
    expect(value.options.quarantine.quarantine).not.toHaveBeenCalled();
  });

  it('records typed log and quarantine collaborator failures', async () => {
    const logFailure = await fixture('staging-log');
    vi.spyOn(logFailure.options.logSealer, 'seal').mockRejectedValueOnce(new Error('seal unavailable'));
    await expect(logFailure.worker.run([logFailure.admissionId])).resolves.toMatchObject({
      status: 'blocked',
      blockerCode: 'RECOVERY_LOG_GAP',
    });
    expect(logFailure.options.quarantine.quarantine).not.toHaveBeenCalled();

    const quarantineFailure = await fixture('staging-log');
    vi.spyOn(quarantineFailure.options.quarantine, 'quarantine').mockRejectedValueOnce(new Error('publisher unavailable'));
    await expect(quarantineFailure.worker.run([quarantineFailure.admissionId])).resolves.toMatchObject({
      status: 'blocked',
      blockerCode: 'QUARANTINE_PENDING',
    });
  });

  it('retains the fence and records evidence when the exact active container cannot be stopped', async () => {
    const value = await fixture('present');
    vi.spyOn(value.options.docker, 'stop').mockRejectedValue(new Error('stop failed'));
    const result = await value.worker.run([value.admissionId]);
    expect(result.status).toBe('blocked');
    expect(value.docker.calls).toEqual(['inspect:container-job-1:1000']);
    expect((value.db.prepare('SELECT status, blocker_code FROM cleanup_leases WHERE admission_id=?').get(value.admissionId) as Record<string, unknown>)).toMatchObject({ status: 'blocking', blocker_code: 'DOCKER_CONTAINER_ORPHANED' });
    expect((value.db.prepare('SELECT cleanup_fence_generation, container_id FROM jobs WHERE job_id=?').get(value.jobId) as Record<string, unknown>)).toMatchObject({ cleanup_fence_generation: 1, container_id: `container-${value.jobId}` });
  });

  it('proves a staging/log-only blocker with null container identity and never calls Docker stop or remove', async () => {
    const value = await fixture('staging-log');
    const result = await value.worker.run([value.admissionId]);
    expect(result.status).toBe('completed');
    expect(value.docker.calls).toEqual(['list:1000']);
    expect(value.docker.listByJobId).toHaveBeenCalledWith(value.jobId, 1000);
    expect(value.options.quarantine.quarantine).toHaveBeenCalledOnce();
    expect((value.db.prepare('SELECT status, cleanup_blocker_code, container_id, state, queue_state FROM cleanup_leases JOIN jobs USING (job_id) WHERE admission_id=?').get(value.admissionId) as Record<string, unknown>)).toMatchObject({ status: 'completed', cleanup_blocker_code: null, container_id: null, state: 'starting', queue_state: 'dispatched' });
  });

  it('quarantines fixed physical staging with null persisted artifact identity', async () => {
    const value = await fixture('physical-staging');
    let now = NOW;
    (value.options.clock as { now: () => string }).now = () => now;
    vi.spyOn(value.options.quarantine, 'quarantine').mockImplementationOnce(async () => {
      now = '2026-07-27T12:00:01.000Z';
      return {
        kind: 'quarantined',
        sourcePath: `staging/${value.jobId}`,
        destinationPath: `quarantine/${value.jobId}`,
        sourceAbsent: true,
        destinationPresent: true,
        sha256: null,
        size: null,
        verifiedAt: now,
      };
    });
    const before = value.db.prepare('SELECT publish_state, artifact_staging_path, artifact_quarantine_path FROM jobs WHERE job_id=?').get(value.jobId);
    const result = await value.worker.run([value.admissionId]);
    expect(result.status).toBe('completed');
    expect(value.options.quarantine.quarantine).toHaveBeenCalledWith({
      rootId: 'release',
      jobId: value.jobId,
      admittedStaging: {
        kind: 'physical-present',
        path: `staging/${value.jobId}`,
        sha256: null,
        size: null,
        observedAt: NOW,
      },
      stagingPath: null,
      artifactSha256: null,
      artifactSize: null,
    });
    expect(value.db.prepare('SELECT publish_state, artifact_staging_path, artifact_quarantine_path FROM jobs WHERE job_id=?').get(value.jobId)).toEqual(before);
  });

  it('does not change state, terminal, queue, normal publish fields, stages, or immutable operations', async () => {
    const value = await fixture('present');
    const before = value.db.prepare(`SELECT state, terminal_at, terminal_error_code, terminal_error_json, queue_state, queue_position,
      publish_state, artifact_final_directory, artifact_final_path, current_stage FROM jobs WHERE job_id=?`).get(value.jobId);
    const result = await value.worker.run([value.admissionId]);
    expect(result.status).toBe('completed');
    const after = value.db.prepare(`SELECT state, terminal_at, terminal_error_code, terminal_error_json, queue_state, queue_position,
      publish_state, artifact_final_directory, artifact_final_path, current_stage FROM jobs WHERE job_id=?`).get(value.jobId);
    expect(after).toEqual(before);
    expect(value.db.prepare('SELECT COUNT(*) AS count FROM job_operations WHERE job_id=?').get(value.jobId)).toEqual({ count: 0 });
  });
});

describe('cleanup worker dependency boundaries', () => {
  it('passes the exact admission and quarantine contract to injected collaborators', async () => {
    const value = await fixture('staging-log');
    const publisher = value.options.quarantine.quarantine as ReturnType<typeof vi.fn>;
    await value.worker.run([value.admissionId]);
    expect(publisher).toHaveBeenCalledWith({
      rootId: 'release',
      jobId: value.jobId,
      admittedStaging: { kind: 'absent', path: null },
      stagingPath: null,
      artifactSha256: null,
      artifactSize: null,
    });
    expect(value.options.evidenceWriter.write).toHaveBeenCalledOnce();
    expect(value.options.logSealer.seal).toHaveBeenCalledWith(expect.objectContaining({ jobId: value.jobId, admissionId: value.admissionId, at: NOW }));
  });
});
