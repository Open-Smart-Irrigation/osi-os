import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { BuilderStore } from '../../api/src/store.js';
import { OwnershipStore } from '../../api/src/ownership.js';
import { createDockerExecutor, type DockerCommandExecutor } from '../../runner/src/docker-executor.js';
import type { CommandResult, CommandRunOptions } from '../../runner/src/command-executor.js';

const NOW = '2026-07-24T10:00:00.000Z';
const DIGEST = 'a'.repeat(64);
const SHA40 = 'b'.repeat(40);
const MANIFEST = 'c'.repeat(64);
const IMAGE_ID = `sha256:${'e'.repeat(64)}`;
const CONTAINER_ID = '1'.repeat(64);
const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function rawInspection(): Record<string, unknown> {
  return {
    Id: CONTAINER_ID,
    Name: '/osi-image-builder-integration-job-attempt-1',
    Image: IMAGE_ID,
    Config: { Image: `registry.example/builder@sha256:${DIGEST}`, User: '1000:1000', WorkingDir: '/workdir', Env: ['HOME=/workdir/.builder-home', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'CARGO_BUILD_JOBS=2', 'TZ=UTC', 'SOURCE_DATE_EPOCH=1784887200'], Labels: { 'org.osi.image-builder.job-id': 'integration-job', 'org.osi.image-builder.manifest-sha': MANIFEST } },
    HostConfig: { NetworkMode: 'bridge', CapDrop: ['ALL'], CapAdd: null, Privileged: false, Devices: null, SecurityOpt: ['no-new-privileges:true'], ReadonlyRootfs: false, PidsLimit: 4096, Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 4096 }] },
    Mounts: [{ Type: 'bind', Source: '/tmp/worktree', Destination: '/workdir', RW: true }],
    Created: '2026-07-24T10:00:03.000000000Z',
    State: { Status: 'exited', Running: false, StartedAt: '2026-07-24T10:00:03.000000000Z', FinishedAt: '2026-07-24T10:00:04.000000000Z', ExitCode: 0 },
  };
}

function createdInspection(): Record<string, unknown> {
  const value = rawInspection();
  value.Created = '2026-07-24T10:00:03.000000000Z';
  value.State = { Status: 'created', Running: false, StartedAt: '0001-01-01T00:00:00.000000000Z', FinishedAt: '0001-01-01T00:00:00.000000000Z', ExitCode: 0 };
  return value;
}

function fakeDocker(): DockerCommandExecutor & { readonly calls: readonly (readonly string[])[] } {
  const responses: Array<Partial<CommandResult>> = [
    { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
    { stdout: JSON.stringify({ Id: IMAGE_ID, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
    { stdout: '' },
    { stdout: `${CONTAINER_ID}\n` },
    { stdout: JSON.stringify(createdInspection()) },
    { stdout: 'build output', startedAt: '2026-07-24T10:00:03.000Z', finishedAt: '2026-07-24T10:00:04.000Z' },
    { stdout: JSON.stringify(rawInspection()) },
    { stdout: '' },
    { exitCode: 1, stderr: 'No such container: integration\n' },
    { stdout: '' },
  ];
  const calls: string[][] = [];
  let index = 0;
  return { calls, run: vi.fn(async (argv: readonly string[], _options: CommandRunOptions) => { calls.push([...argv]); const response = responses[index++]; if (!response) throw new Error(`missing fake response for ${argv.join(' ')}`); return { argv: [...argv], exitCode: response.exitCode ?? 0, signal: response.signal ?? null, stdout: response.stdout ?? '', stderr: response.stderr ?? '', timedOut: response.timedOut ?? false, startedAt: response.startedAt ?? NOW, finishedAt: response.finishedAt ?? NOW }; }) };
}

async function openRealStores(): Promise<{ readonly store: BuilderStore; readonly ownership: OwnershipStore; readonly db: ReturnType<typeof openBuilderDatabase>; readonly path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'osi-image-builder-docker-real-store-'));
  tempPaths.push(directory);
  const path = join(directory, 'builder.sqlite');
  const db = openBuilderDatabase(path);
  db.prepare(`INSERT INTO jobs (job_id, request_id, request_json, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, queue_position, created_at, updated_at) VALUES ('integration-job', 'integration-request', ?, 'git@example.com:osi-os.git', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'release', ?, ?, 'Phil', 'integration', ?, 'queued', 'queued', 0, ?, ?)`).run(JSON.stringify({ branch: 'main' }), SHA40, SHA40, MANIFEST, NOW, NOW, NOW, NOW);
  db.prepare("INSERT INTO queue_entries (job_id, fifo_seq, enqueued_at) VALUES ('integration-job', 0, ?)").run(NOW);
  db.prepare("INSERT INTO job_events (job_id, seq, event_type, state, stage, payload_json, at) VALUES ('integration-job', 0, 'enqueue', 'queued', NULL, ?, ?)").run(JSON.stringify({ requestId: 'integration-request' }), NOW);
  const store = new BuilderStore(db);
  const ownership = new OwnershipStore(db, { now: () => NOW });
  ownership.apiWrite({ kind: 'dispatch', jobId: 'integration-job', runnerUnit: 'osi-image-builder-runner@integration-job.service', at: NOW });
  ownership.runnerWrite({ kind: 'acquire-lease', jobId: 'integration-job', runnerUnit: 'osi-image-builder-runner@integration-job.service', owner: 'runner-a', expiresAt: '2026-07-24T10:20:00.000Z', at: NOW });
  return { store, ownership, db, path };
}

describe('Docker lifecycle integration capability', () => {
  it('reports typed unavailable and zero mutation when Docker is unavailable instead of skipping', async () => {
    const ownership = { runnerWrite: () => { throw new Error('must not mutate'); } };
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
      operationId: 'verify-image',
      operationContext: { environment: 'full_raspberrypi_bcm27xx_bcm2712' },
      operationTimeoutMs: 60_000,
      maxCaptureBytes: 16 * 1024,
      containerName: 'osi-image-builder-integration-job-attempt-1',
      store: { getJob: () => { throw new Error('must not read'); } },
      ownership,
      leaseSnapshot: () => ({ owner: 'runner', unit: 'osi-image-builder-runner@integration-job.service', leaseExpiresAt: '2026-07-24T10:10:00.000Z', expectedState: 'starting' }),
      evidence: async () => ({ path: 'evidence/integration.json', sha256: 'c'.repeat(64) }),
      finalizeLogs: async () => ({ runner: 'absent', docker: 'absent', verifiedAt: '2026-07-24T10:00:00.000Z' }),
      authorizeContainerCreate: async () => ({ authorized: true }),
    }).run();
    expect(result.available).toBe(false);
    expect(result.mutationCount).toBe(0);
  });

  it('runs the direct lifecycle through real SQLite stores and retains immutable operation history after cleanup', async () => {
    const { store, ownership } = await openRealStores();
    const docker = fakeDocker();
    const result = await createDockerExecutor({
      commandExecutor: docker,
      dockerPath: '/usr/bin/docker',
      imageReference: `registry.example/builder@sha256:${DIGEST}`,
      imageDigest: DIGEST,
      jobId: 'integration-job',
      manifestSha256: MANIFEST,
      attempt: 1,
      worktreePath: '/tmp/worktree',
      uid: 1000,
      gid: 1000,
      operationId: 'verify-image',
      operationContext: { environment: 'full_raspberrypi_bcm27xx_bcm2712' },
      operationTimeoutMs: 60_000,
      maxCaptureBytes: 16 * 1024,
      containerName: 'osi-image-builder-integration-job-attempt-1',
      store,
      ownership,
      leaseSnapshot: () => { const job = store.getJob('integration-job'); if (!job.runnerLeaseOwner || !job.runnerUnit || !job.runnerLeaseExpiresAt) throw new Error('lease missing'); return { owner: job.runnerLeaseOwner, unit: job.runnerUnit, leaseExpiresAt: job.runnerLeaseExpiresAt, expectedState: job.state }; },
      clock: (() => { let tick = 0; return () => new Date(Date.parse(NOW) + tick++ * 1000).toISOString(); })(),
      evidence: async () => ({ path: 'evidence/integration.json', sha256: 'd'.repeat(64) }),
      finalizeLogs: async ({ operationFinishedAt }) => ({ runner: 'absent', docker: 'absent', verifiedAt: operationFinishedAt }),
      authorizeContainerCreate: async (input) => {
        const job = store.getJob('integration-job');
        if (!job.runnerLeaseOwner || !job.runnerUnit || !job.runnerLeaseExpiresAt) {
          throw new Error('lease missing');
        }
        const authorization = ownership.runnerWrite({
          kind: 'operation-begin',
          jobId: 'integration-job',
          owner: job.runnerLeaseOwner,
          runnerUnit: job.runnerUnit,
          leaseExpiresAt: job.runnerLeaseExpiresAt,
          at: input.startedAt,
          expectedState: input.lease.expectedState,
          operationId: input.operationId,
          attempt: input.attempt,
          argvHash: input.argvHash,
          argv: input.argv,
          startedAt: input.startedAt,
        });
        if (!authorization.ok) throw new Error('operation authorization failed');
        return { authorized: true };
      },
    }).run();
    expect(result).toMatchObject({ available: true, outcome: 'passed', containerId: CONTAINER_ID });
    expect(store.getJob('integration-job')).toMatchObject({ containerId: null, containerName: null, containerStartedAt: null, containerStoppedAt: null, containerRemovedAt: null, containerCleanupOutcome: null });
    expect(store.getOperation('integration-job', 'verify-image', 1)).toMatchObject({ outcome: 'passed', lifecyclePhase: 'stopped', containerId: CONTAINER_ID, evidencePath: 'evidence/integration.json' });
    const operation = store.getOperation('integration-job', 'verify-image', 1);
    expect(operation?.inspection).toMatchObject({ imagePreflight: { imageId: IMAGE_ID, imageDigest: DIGEST, architecture: 'amd64', os: 'linux' } });
    expect(docker.calls.map((call) => call[1])).toEqual(['version', 'image', 'ps', 'create', 'inspect', 'start', 'inspect', 'rm', 'inspect', 'ps']);
    store.close();
  });
});
