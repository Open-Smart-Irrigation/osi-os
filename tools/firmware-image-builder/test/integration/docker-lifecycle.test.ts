import { lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { BuilderStore } from '../../api/src/store.js';
import { OwnershipStore } from '../../api/src/ownership.js';
import { createDockerExecutor, type DockerCommandExecutor, type WorkspaceIdentity } from '../../runner/src/docker-executor.js';
import { INTERNAL_EXECUTION_GUARD_PATH } from '../../runner/src/operation-registry.js';
import type { CommandResult, CommandRunOptions } from '../../runner/src/command-executor.js';
import { createTestBuilderIdentity } from '../helpers/builder-identity.js';

const NOW = '2026-07-24T10:00:00.000Z';
const DIGEST = 'a'.repeat(64);
const SHA40 = 'b'.repeat(40);
const MANIFEST = 'c'.repeat(64);
const IMAGE_ID = `sha256:${'e'.repeat(64)}`;
const CONTAINER_ID = '1'.repeat(64);
const ACTIVE_TARGET_ENVIRONMENT = 'full_raspberrypi_bcm27xx_bcm2712';
const tempPaths: string[] = [];

interface WorkspaceFixture {
  readonly path: string;
  readonly workspaceIdentity: WorkspaceIdentity;
  readonly activeTargetEnvironment: string;
  readonly command: readonly string[];
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createWorkspaceFixture(): Promise<WorkspaceFixture> {
  const path = await mkdtemp(join(tmpdir(), 'osi-image-builder-docker-worktree-'));
  tempPaths.push(path);
  await mkdir(join(path, 'conf', ACTIVE_TARGET_ENVIRONMENT, 'files'), { recursive: true });
  await mkdir(join(path, 'conf', ACTIVE_TARGET_ENVIRONMENT, 'patches'), { recursive: true });
  await mkdir(join(path, 'openwrt'), { recursive: true });
  await symlink(`${ACTIVE_TARGET_ENVIRONMENT}/.config`, join(path, 'conf/.config'));
  await symlink(`${ACTIVE_TARGET_ENVIRONMENT}/files`, join(path, 'conf/files'));
  await symlink(`${ACTIVE_TARGET_ENVIRONMENT}/patches`, join(path, 'conf/patches'));
  await symlink('../conf/.config', join(path, 'openwrt/.config'));
  await symlink('../conf/files', join(path, 'openwrt/files'));
  await symlink('../conf/patches', join(path, 'openwrt/patches'));
  const identity = await lstat(path, { bigint: true });
  const workspaceIdentity = { device: Number(identity.dev), inode: Number(identity.ino) };
  const command = [
    'node', INTERNAL_EXECUTION_GUARD_PATH,
    `--workspace-dev=${String(workspaceIdentity.device)}`,
    `--workspace-ino=${String(workspaceIdentity.inode)}`,
    `--active-target-environment=${ACTIVE_TARGET_ENVIRONMENT}`,
    '--operation-id=verify-image',
    `--operation-environment=${ACTIVE_TARGET_ENVIRONMENT}`,
    '--working-directory=/workdir', '--',
    'node', '/opt/osi-image-builder/operations/osi-image-builder-tool.js', 'verify-image',
  ];
  return { path, workspaceIdentity, activeTargetEnvironment: ACTIVE_TARGET_ENVIRONMENT, command };
}

function rawInspection(workspace: WorkspaceFixture): Record<string, unknown> {
  return {
    Id: CONTAINER_ID,
    Name: '/osi-image-builder-integration-job-attempt-1',
    Image: IMAGE_ID,
    Config: { Image: `registry.example/builder@sha256:${DIGEST}`, User: '1000:1000', WorkingDir: '/workdir', Entrypoint: [], Cmd: workspace.command, Env: ['HOME=/workdir/.builder-home', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'CARGO_BUILD_JOBS=2', 'TZ=UTC', 'SOURCE_DATE_EPOCH=1784887200'], Labels: { 'org.osi.image-builder.job-id': 'integration-job', 'org.osi.image-builder.manifest-sha': MANIFEST } },
    HostConfig: { NetworkMode: 'none', CapDrop: ['ALL'], CapAdd: null, Privileged: false, Devices: null, SecurityOpt: ['no-new-privileges:true'], ReadonlyRootfs: true, PidsLimit: 4096, NanoCpus: 8_000_000_000, Memory: 16 * 1024 * 1024 * 1024, MemorySwap: 16 * 1024 * 1024 * 1024, Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 4096 }] },
    Mounts: [{ Type: 'bind', Source: workspace.path, Destination: '/workdir', RW: false }],
    Created: '2026-07-24T10:00:03.000000000Z',
    State: { Status: 'exited', Running: false, StartedAt: '2026-07-24T10:00:03.000000000Z', FinishedAt: '2026-07-24T10:00:04.000000000Z', ExitCode: 0 },
  };
}

function createdInspection(workspace: WorkspaceFixture): Record<string, unknown> {
  const value = rawInspection(workspace);
  value.Created = '2026-07-24T10:00:03.000000000Z';
  value.State = { Status: 'created', Running: false, StartedAt: '0001-01-01T00:00:00.000000000Z', FinishedAt: '0001-01-01T00:00:00.000000000Z', ExitCode: 0 };
  return value;
}

function fakeDocker(workspace: WorkspaceFixture): DockerCommandExecutor & { readonly calls: readonly (readonly string[])[] } {
  const responses: Array<Partial<CommandResult>> = [
    { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
    { stdout: JSON.stringify({ Id: IMAGE_ID, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
    { stdout: '' },
    { stdout: `${CONTAINER_ID}\n` },
    { stdout: JSON.stringify(createdInspection(workspace)) },
    { stdout: 'build output', startedAt: '2026-07-24T10:00:03.000Z', finishedAt: '2026-07-24T10:00:04.000Z' },
    { stdout: JSON.stringify(rawInspection(workspace)) },
    { stdout: '' },
    { exitCode: 1, stderr: 'No such container: integration\n' },
    { stdout: '' },
  ];
  const calls: string[][] = [];
  let index = 0;
  return { calls, run: vi.fn(async (argv: readonly string[], _options: CommandRunOptions) => { calls.push([...argv]); const response = responses[index++]; if (!response) throw new Error(`missing fake response for ${argv.join(' ')}`); return { argv: [...argv], exitCode: response.exitCode ?? 0, signal: response.signal ?? null, stdout: response.stdout ?? '', stderr: response.stderr ?? '', timedOut: response.timedOut ?? false, startedAt: response.startedAt ?? NOW, finishedAt: response.finishedAt ?? NOW }; }) };
}

function sourcePreparation() {
  return {
    schemaVersion: 1,
    sourceSha: SHA40,
    gitmodulesBlobSha: 'd'.repeat(40),
    preparedAt: NOW,
    components: [
      { path: 'feeds/chirpstack-openwrt-feed', mode: '040000', type: 'tree', objectId: 'e'.repeat(40), provenanceUrl: 'https://github.com/chirpstack/chirpstack-openwrt-feed.git' },
      { path: 'openwrt', mode: '040000', type: 'tree', objectId: 'f'.repeat(40), provenanceUrl: 'https://github.com/openwrt/openwrt.git' },
    ],
  };
}

function offlineFeedPreparation() {
  const recursiveSubmoduleStatusSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  return {
    schemaVersion: 1,
    boundary: 'api-prepared-pinned-feeds-v1',
    networkPolicy: 'runner-offline',
    jobId: 'integration-job',
    sourceSha: SHA40,
    preparedAt: NOW,
    feeds: [
      { name: 'packages', location: 'https://git.openwrt.org/feed/packages.git', commit: 'd8cd30f4e281d6853b3de134c4f147a807583e43', detached: true, clean: true, recursiveSubmodulesPrepared: true, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: '1'.repeat(64) },
      { name: 'luci', location: 'https://git.openwrt.org/project/luci.git', commit: '2ac26e56cc55102cb10e7b0867c2b78e0f6d5fd8', detached: true, clean: true, recursiveSubmodulesPrepared: true, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: '2'.repeat(64) },
      { name: 'routing', location: 'https://git.openwrt.org/feed/routing.git', commit: '3'.repeat(40), detached: true, clean: true, recursiveSubmodulesPrepared: true, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: '3'.repeat(64) },
    ],
  };
}

async function openRealStores(): Promise<{ readonly store: BuilderStore; readonly ownership: OwnershipStore; readonly db: ReturnType<typeof openBuilderDatabase>; readonly path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'osi-image-builder-docker-real-store-'));
  tempPaths.push(directory);
  const path = join(directory, 'builder.sqlite');
  const db = openBuilderDatabase(path);
  const identity = Object.freeze({
    ...createTestBuilderIdentity(MANIFEST),
    imageReference: `registry.example/builder@sha256:${DIGEST}`,
    imageId: IMAGE_ID,
    imageDigest: DIGEST,
  });
  db.prepare(`INSERT INTO jobs (
    job_id, request_id, request_json, source_remote, source_ref, source_branch, branch,
    expected_sha, pinned_sha, source_preparation_json, offline_feed_preparation_json,
    target_id, root_id, target_manifest_sha256,
    builder_identity_status, builder_package_version, builder_package_root, builder_lock_sha256,
    builder_execution_definition_sha256, builder_target_manifest_sha256, builder_runner_sha256,
    builder_cleanup_worker_sha256, builder_dependency_egress_proxy_sha256,
    builder_image_reference, builder_image_id, builder_image_digest,
    source_commit_time, source_author,
    source_subject, accepted_at, state, queue_state, queue_position, created_at, updated_at
  ) VALUES (
    'integration-job', 'integration-request', ?, 'git@example.com:osi-os.git',
    'refs/remotes/origin/main', 'main', 'main', ?, ?, ?, ?,
    'rpi-5', 'release', ?, 'admitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Phil', 'integration', ?,
    'queued', 'queued', 0, ?, ?
  )`).run(
    JSON.stringify({ branch: 'main' }),
    SHA40,
    SHA40,
    JSON.stringify(sourcePreparation()),
    JSON.stringify(offlineFeedPreparation()),
    MANIFEST,
    identity.packageVersion,
    identity.packageRoot,
    identity.lockSha256,
    identity.executionDefinitionSha256,
    identity.targetManifestSha256,
    identity.runnerSha256,
    identity.cleanupWorkerSha256,
    identity.dependencyEgressProxySha256,
    identity.imageReference,
    identity.imageId,
    identity.imageDigest,
    NOW,
    NOW,
    NOW,
    NOW,
  );
  db.prepare("INSERT INTO queue_entries (job_id, fifo_seq, enqueued_at) VALUES ('integration-job', 0, ?)").run(NOW);
  db.prepare("INSERT INTO job_events (job_id, seq, event_type, state, stage, payload_json, at) VALUES ('integration-job', 0, 'enqueue', 'queued', NULL, ?, ?)").run(JSON.stringify({ requestId: 'integration-request' }), NOW);
  const store = new BuilderStore(db);
  const ownership = new OwnershipStore(db, { now: () => NOW });
  ownership.apiWrite({ kind: 'dispatch', jobId: 'integration-job', runnerUnit: 'osi-image-builder-runner@integration-job.service', claimOwner: 'dispatcher-integration-job', claimExpiresAt: '2026-07-24T10:10:00.000Z', at: NOW });
  ownership.apiWrite({ kind: 'dispatch-start', jobId: 'integration-job', runnerUnit: 'osi-image-builder-runner@integration-job.service', claimOwner: 'dispatcher-integration-job', expectedClaimExpiresAt: '2026-07-24T10:10:00.000Z', claimExpiresAt: '2026-07-24T10:10:00.000Z', unitInactiveAt: NOW, startAttemptedAt: NOW, at: NOW });
  ownership.runnerWrite({ kind: 'acquire-lease', jobId: 'integration-job', runnerUnit: 'osi-image-builder-runner@integration-job.service', owner: 'runner-a', expiresAt: '2026-07-24T10:20:00.000Z', at: NOW });
  return { store, ownership, db, path };
}

describe('Docker lifecycle integration capability', () => {
  it('reports typed unavailable and zero mutation when Docker is unavailable instead of skipping', async () => {
    const workspace = await createWorkspaceFixture();
    const ownership = { runnerWrite: () => { throw new Error('must not mutate'); } };
    const result = await createDockerExecutor({
      dockerPath: '/definitely/missing/docker',
      imageReference: 'registry.example/builder@sha256:' + 'a'.repeat(64),
      imageId: IMAGE_ID,
      imageDigest: 'a'.repeat(64),
      jobId: 'integration-job',
      manifestSha256: 'b'.repeat(64),
      attempt: 1,
      worktreePath: workspace.path,
      dependencyEgressCredentialDirectory: '/tmp/osi-image-builder-test-credentials',
      workspaceIdentity: workspace.workspaceIdentity,
      activeTargetEnvironment: workspace.activeTargetEnvironment,
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
    const workspace = await createWorkspaceFixture();
    const { store, ownership } = await openRealStores();
    const docker = fakeDocker(workspace);
    const result = await createDockerExecutor({
      commandExecutor: docker,
      dockerPath: '/usr/bin/docker',
      imageReference: `registry.example/builder@sha256:${DIGEST}`,
      imageId: IMAGE_ID,
      imageDigest: DIGEST,
      jobId: 'integration-job',
      manifestSha256: MANIFEST,
      attempt: 1,
      worktreePath: workspace.path,
      dependencyEgressCredentialDirectory: '/tmp/osi-image-builder-test-credentials',
      workspaceIdentity: workspace.workspaceIdentity,
      activeTargetEnvironment: workspace.activeTargetEnvironment,
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
    expect(operation?.inspection).toMatchObject({
      executionGuard: {
        path: INTERNAL_EXECUTION_GUARD_PATH,
        workspace: workspace.workspaceIdentity,
        activeTargetEnvironment: workspace.activeTargetEnvironment,
        command: workspace.command,
      },
    });
    const create = docker.calls.find((call) => call[1] === 'create');
    expect(create?.find((value) => value.startsWith('--mount='))).toBe(
      `--mount=type=bind,source=${workspace.path},destination=/workdir,readonly`,
    );
    expect(create?.some((value) => value.includes('/proc/'))).toBe(false);
    expect(docker.calls.map((call) => call[1])).toEqual(['version', 'image', 'ps', 'create', 'inspect', 'start', 'inspect', 'rm', 'inspect', 'ps']);
    store.close();
  });
});
