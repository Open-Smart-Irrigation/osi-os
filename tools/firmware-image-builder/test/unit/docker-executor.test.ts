import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRUSTED_OPERATION_IDS } from '../../domain/types.js';
import {
  DockerLifecycleError,
  createDockerExecutor,
  type DockerCommandExecutor,
  type DockerExecutorOptions,
  type DockerInspection,
} from '../../runner/src/docker-executor.js';
import { createOperationArgv, assertOperationRegistryCoverage } from '../../runner/src/operation-registry.js';

const DIGEST = 'a'.repeat(64);
const MANIFEST = 'b'.repeat(64);
const NOW = '2026-07-24T10:00:00.000Z';

function inspection(overrides: Partial<DockerInspection> = {}): DockerInspection {
  return {
    id: '1'.repeat(64),
    name: 'osi-image-builder-job-1-attempt-1',
    image: `registry.example/builder@sha256:${DIGEST}`,
    imageDigest: DIGEST,
    architecture: 'amd64',
    os: 'linux',
    labels: {
      'org.osi.image-builder.job-id': 'job-1',
      'org.osi.image-builder.manifest-sha': MANIFEST,
    },
    mounts: [{ type: 'bind', source: '/tmp/worktree', destination: '/workdir', readOnly: false }],
    user: '1000:1000',
    workingDir: '/workdir',
    networkMode: 'bridge',
    capDrop: ['ALL'],
    capAdd: [],
    privileged: false,
    devices: [],
    securityOpt: ['no-new-privileges:true'],
    pidsLimit: 4096,
    ulimits: [{ name: 'nofile', soft: 1024, hard: 4096 }],
    environment: {
      HOME: '/workdir/.builder-home',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      CARGO_BUILD_JOBS: '2',
      TZ: 'UTC',
      SOURCE_DATE_EPOCH: '1782208800',
    },
    running: false,
    ...overrides,
  };
}

function options(executor: DockerCommandExecutor, overrides: Partial<DockerExecutorOptions> = {}): DockerExecutorOptions {
  return {
    commandExecutor: executor,
    dockerPath: '/usr/bin/docker',
    imageReference: `registry.example/builder@sha256:${DIGEST}`,
    imageDigest: DIGEST,
    jobId: 'job-1',
    manifestSha256: MANIFEST,
    attempt: 1,
    worktreePath: '/tmp/worktree',
    uid: 1000,
    gid: 1000,
    sourceDateEpoch: '1782208800',
    operationId: 'verify-image',
    operationArgv: ['node', 'tools/verify-image.js', 'verify-image'],
    containerName: 'osi-image-builder-job-1-attempt-1',
    runner: { owner: 'runner-a', unit: 'osi-image-builder-runner@job-1.service', leaseExpiresAt: '2026-07-24T10:10:00.000Z', expectedState: 'starting' },
    clock: () => NOW,
    evidence: async () => ({ path: 'evidence/operation-1.json', sha256: 'c'.repeat(64) }),
    logs: { runner: 'absent', docker: 'absent', verifiedAt: NOW, generationIdentity: { runner: [], docker: [] } },
    ...overrides,
  };
}

function fakeDocker(responses: ReadonlyArray<unknown>): DockerCommandExecutor & { calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;
  return {
    calls,
    run: vi.fn(async (argv: readonly string[]) => {
      calls.push([...argv]);
      const response = responses[index++];
      if (response instanceof Error) throw response;
      return response as never;
    }),
  };
}

describe('operation registry', () => {
  it('covers every trusted execution-definition operation and rejects unknown IDs', () => {
    expect(assertOperationRegistryCoverage(TRUSTED_OPERATION_IDS)).toBe(true);
    for (const operationId of TRUSTED_OPERATION_IDS) {
      const argv = createOperationArgv(operationId, { environment: 'full_raspberrypi_bcm27xx_bcm2712', installedToolPath: '/usr/local/libexec/osi-image-builder-tool' });
      expect(argv.length).toBeGreaterThan(0);
      expect(argv.some((part) => part.includes('&&') || part.includes(';') || part.includes('\n'))).toBe(false);
    }
    expect(() => createOperationArgv('unknown-operation' as never, { environment: 'x', installedToolPath: '/tool' })).toThrow(/unknown operation/i);
  });
});

describe('DockerExecutor', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates an inspected stopped container with the locked lifecycle contract and cleans the exact ID after committing evidence', async () => {
    const docker = fakeDocker([
      { exitCode: 0, signal: null, stdout: '{"ServerVersion":"27.0"}\n', stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: `${'1'.repeat(64)}\n`, stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: JSON.stringify([inspection()]), stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: 'build output\n', stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
      { exitCode: 1, signal: null, stdout: '', stderr: 'No such container: container-1\n', timedOut: false },
      { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
    ]);
    let persistedId: string | null = null;
    const ownership = { runnerWrite: vi.fn((command: { kind: string; containerId?: string }) => { if (command.kind === 'container') persistedId = command.containerId ?? null; return { ok: true, kind: 'committed', eventSeq: 1 }; }), getJob: vi.fn(() => ({ containerId: persistedId, containerName: persistedId ? 'osi-image-builder-job-1-attempt-1' : null, containerImageDigest: persistedId ? DIGEST : null, containerLabelJobId: persistedId ? 'job-1' : null, containerLabelManifestSha: persistedId ? MANIFEST : null, containerLabels: persistedId ? { 'org.osi.image-builder.job-id': 'job-1', 'org.osi.image-builder.manifest-sha': MANIFEST } : null, containerMount: persistedId ? {} : null, containerEnvironment: persistedId ? {} : null, containerSecurity: persistedId ? {} : null, containerInspection: persistedId ? {} : null, containerCreatedAt: persistedId ? NOW : null })) };
    const result = await createDockerExecutor(options(docker, { ownership: ownership as never })).run();

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('Docker should be available in fake lifecycle');
    expect(result.outcome).toBe('passed');
    expect(ownership.runnerWrite).toHaveBeenCalled();
    const create = docker.calls.find((call) => call[1] === 'create');
    expect(create).toBeDefined();
    expect(create).not.toContain('--rm');
    expect(create).toContain('--pull=never');
    expect(create).toContain('--network=bridge');
    expect(create).toContain('--cap-drop=ALL');
    expect(create).toContain('--security-opt=no-new-privileges:true');
    expect(create).toContain('--pids-limit=4096');
    expect(create).toContain('--ulimit=nofile=1024:4096');
    expect(create?.filter((value) => value.startsWith('--mount=')).length).toBe(1);
    expect(create).toContain('--user=1000:1000');
    expect(create).toContain(`registry.example/builder@sha256:${DIGEST}`);
    expect(create).not.toContain('/var/run/docker.sock');
    expect(docker.calls.map((call) => call[1])).toEqual(['version', 'ps', 'create', 'inspect', 'start', 'rm', 'inspect', 'ps']);
    expect(docker.calls.findIndex((call) => call[1] === 'rm')).toBeGreaterThan(docker.calls.findIndex((call) => call[1] === 'start'));
  });

  it('rejects every inspected security or identity mismatch before starting the container', async () => {
    const mismatches: Array<[string, Partial<DockerInspection>]> = [
      ['image', { imageDigest: 'd'.repeat(64) }],
      ['label', { labels: { 'org.osi.image-builder.job-id': 'other', 'org.osi.image-builder.manifest-sha': MANIFEST } }],
      ['mount', { mounts: [] }],
      ['user', { user: '0:0' }],
      ['capability', { capDrop: [] }],
      ['security', { privileged: true }],
      ['environment', { environment: { INHERITED: '1' } }],
    ];
    for (const [name, mismatch] of mismatches) {
      const docker = fakeDocker([
        { exitCode: 0, signal: null, stdout: '{}', stderr: '', timedOut: false },
        { exitCode: 0, signal: null, stdout: `${'1'.repeat(64)}\n`, stderr: '', timedOut: false },
        { exitCode: 0, signal: null, stdout: JSON.stringify([inspection(mismatch)]), stderr: '', timedOut: false },
      ]);
      const ownership = { runnerWrite: vi.fn(), getJob: vi.fn(() => ({ containerId: null, containerName: null, containerImageDigest: null, containerLabelJobId: null, containerLabelManifestSha: null })) };
      await expect(createDockerExecutor(options(docker, { ownership: ownership as never })).run()).rejects.toThrow(DockerLifecycleError);
      expect(docker.calls.some((call) => call[1] === 'start')).toBe(false);
      expect(name).toBeTruthy();
    }
  });

  it('returns typed unavailable with zero ownership mutation when Docker cannot be reached', async () => {
    const docker = fakeDocker([Object.assign(new Error('docker unavailable'), { code: 'ENOENT' })]);
    const ownership = { runnerWrite: vi.fn(), getJob: vi.fn() };
    const result = await createDockerExecutor(options(docker, { ownership: ownership as never })).run();
    expect(result).toMatchObject({ available: false, mutationCount: 0 });
    expect(ownership.runnerWrite).not.toHaveBeenCalled();
    expect(ownership.getJob).not.toHaveBeenCalled();
  });
});
