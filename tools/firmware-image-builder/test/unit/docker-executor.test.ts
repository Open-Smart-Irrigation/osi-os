import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRUSTED_OPERATION_IDS } from '../../domain/types.js';
import {
  DockerLifecycleError,
  createDockerExecutor,
  type DockerCommandExecutor,
  type DockerExecutorOptions,
  type DockerInspection,
  type PersistedContainerIdentity,
} from '../../runner/src/docker-executor.js';
import { createOperationArgv, assertOperationRegistryCoverage, INTERNAL_OPERATION_TOOL_PATH } from '../../runner/src/operation-registry.js';
import { CommandExecutionError, createCommandExecutor, type CommandResult, type CommandRunOptions } from '../../runner/src/command-executor.js';
import type { OperationInput } from '../../api/src/store.js';
import type { OperationCleanupProof, RunnerWriteCommand } from '../../api/src/ownership.js';

const DIGEST = 'a'.repeat(64);
const MANIFEST = 'b'.repeat(64);
const NOW = '2026-07-24T10:00:00.000Z';

function inspection(overrides: Partial<DockerInspection> = {}): DockerInspection {
  return {
    id: '1'.repeat(64),
    name: 'osi-image-builder-job-1-attempt-1',
    image: `registry.example/builder@sha256:${DIGEST}`,
    imageId: `sha256:${'e'.repeat(64)}`,
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
      SOURCE_DATE_EPOCH: '1784887200',
    },
    readonlyRootfs: false,
    running: false,
    ...overrides,
  };
}

function realisticRawInspection(): Record<string, unknown> {
  return {
    Id: '1'.repeat(64),
    Name: '/osi-image-builder-job-1-attempt-1',
    Image: `sha256:${'e'.repeat(64)}`,
    Config: {
      Image: `registry.example/builder@sha256:${DIGEST}`,
      User: '1000:1000',
      WorkingDir: '/workdir',
      Env: [
        'HOME=/workdir/.builder-home',
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'CARGO_BUILD_JOBS=2',
        'TZ=UTC',
        'SOURCE_DATE_EPOCH=1784887200',
      ],
      Labels: {
        'org.osi.image-builder.job-id': 'job-1',
        'org.osi.image-builder.manifest-sha': MANIFEST,
      },
    },
    HostConfig: {
      NetworkMode: 'bridge',
      CapDrop: ['ALL'],
      CapAdd: null,
      Privileged: false,
      Devices: null,
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: false,
      PidsLimit: 4096,
      Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 4096 }],
    },
    Mounts: [{ Type: 'bind', Source: '/tmp/worktree', Destination: '/workdir', RW: true }],
    State: { Running: false },
  };
}

function options(executor: DockerCommandExecutor, overrides: Partial<DockerExecutorOptions> & { readonly ownership?: { readonly runnerWrite: DockerExecutorOptions['ownership']['runnerWrite']; readonly getJob?: () => ReturnType<typeof emptyIdentityForTest> } } = {}): DockerExecutorOptions {
  const { ownership: suppliedOwnership, store: suppliedStore, ...rest } = overrides;
  const activeIdentity = { ...emptyIdentityForTest() };
  const suppliedWriter = suppliedOwnership?.runnerWrite ?? vi.fn(() => ({ ok: true, kind: 'committed', eventSeq: 1 }));
  const ownershipWriter = (command: RunnerWriteCommand) => {
    const result = suppliedWriter(command);
    if (result.ok && command.kind === 'container') {
      Object.assign(activeIdentity, { containerId: command.containerId, containerName: command.containerName, containerImageDigest: command.imageDigest, containerLabelJobId: command.labels['org.osi.image-builder.job-id'], containerLabelManifestSha: command.labels['org.osi.image-builder.manifest-sha'], containerLabels: command.labels, containerMount: command.mount, containerEnvironment: command.environment, containerSecurity: command.security, containerInspection: command.inspection, containerCreatedAt: command.createdAt, containerStartedAt: command.startedAt ?? null, containerStoppedAt: command.stoppedAt ?? null });
    }
    if (result.ok && command.kind === 'operation-cleanup') Object.assign(activeIdentity, { containerId: null, containerName: null, containerImageDigest: null, containerLabelJobId: null, containerLabelManifestSha: null, containerLabels: null, containerMount: null, containerEnvironment: null, containerSecurity: null, containerInspection: null, containerCreatedAt: null, containerStartedAt: null, containerStoppedAt: null, containerRemovedAt: null, containerCleanupOutcome: null });
    return result;
  };
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
    operationId: 'verify-image',
    operationContext: { environment: 'full_raspberrypi_bcm27xx_bcm2712' },
    operationTimeoutMs: 60_000,
    maxCaptureBytes: 16 * 1024,
    containerName: 'osi-image-builder-job-1-attempt-1',
    store: suppliedStore ?? { getJob: suppliedOwnership?.getJob ?? (() => activeIdentity) },
    ownership: { runnerWrite: ownershipWriter },
    leaseSnapshot: () => ({ owner: 'runner-a', unit: 'osi-image-builder-runner@job-1.service', leaseExpiresAt: '2026-07-24T10:10:00.000Z', expectedState: 'starting' }),
    clock: () => NOW,
    evidence: async () => ({ path: 'evidence/operation-1.json', sha256: 'c'.repeat(64) }),
    finalizeLogs: async () => ({ runner: 'absent', docker: 'absent', verifiedAt: NOW }),
    ...rest,
  };
}

function fakeDocker(responses: ReadonlyArray<Error | Partial<CommandResult>>, trace?: string[]): DockerCommandExecutor & { calls: string[][]; runOptions: CommandRunOptions[] } {
  const calls: string[][] = [];
  const runOptions: CommandRunOptions[] = [];
  let index = 0;
  return {
    calls,
    runOptions,
    run: vi.fn(async (argv: readonly string[], options: CommandRunOptions) => {
      calls.push([...argv]);
      runOptions.push(options);
      trace?.push(`docker:${argv[1] ?? ''}`);
      const response = responses[index++];
      if (!response) throw new Error(`missing fake response for ${argv.join(' ')}`);
      if (response instanceof Error) throw response;
      return {
        argv: [...argv],
        exitCode: response.exitCode ?? 0,
        signal: response.signal ?? null,
        stdout: response.stdout ?? '',
        stderr: response.stderr ?? '',
        timedOut: response.timedOut ?? false,
        startedAt: response.startedAt ?? NOW,
        finishedAt: response.finishedAt ?? NOW,
      };
    }),
  };
}

function successfulResponses(start: Partial<CommandResult> = {}): Array<Error | Partial<CommandResult>> {
  return [
    { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
    { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
    { stdout: '' },
    { stdout: `${'1'.repeat(64)}\n` },
    { stdout: JSON.stringify(realisticRawInspection()) },
    { stdout: 'build output\n', ...start },
    { stdout: JSON.stringify(realisticRawInspection()) },
    { stdout: '' },
    { exitCode: 1, stderr: 'No such container: one\n' },
    { stdout: '' },
  ];
}

describe('operation registry', () => {
  it('covers every trusted execution-definition operation and rejects unknown IDs', () => {
    expect(assertOperationRegistryCoverage(TRUSTED_OPERATION_IDS)).toBe(true);
    for (const operationId of TRUSTED_OPERATION_IDS) {
      const argv = createOperationArgv(operationId, { environment: 'full_raspberrypi_bcm27xx_bcm2712' });
      expect(argv.length).toBeGreaterThan(0);
      expect(argv.some((part) => part.includes('&&') || part.includes(';') || part.includes('\n'))).toBe(false);
    }
    expect(() => createOperationArgv('unknown-operation' as 'verify-image', { environment: 'x' })).toThrow(/unknown operation/i);
  });

  it.each(['copy-feed-config', 'verify-image', 'mirror-gui'] as const)('cannot derive %s helper argv from caller or worktree input', (operationId) => {
    const trusted = createOperationArgv(operationId, { environment: 'full_raspberrypi_bcm27xx_bcm2712' });
    expect(trusted).toEqual(['node', INTERNAL_OPERATION_TOOL_PATH, operationId]);
    expect(trusted.join(' ')).not.toContain('/workdir');
    expect(trusted.join(' ')).not.toContain('evil.js');
    expect(() => createOperationArgv(operationId, { environment: '/workdir/evil.js' })).toThrow();
  });
});

describe('DockerExecutor', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates an inspected stopped container with the locked lifecycle contract and cleans the exact ID after committing evidence', async () => {
    const trace: string[] = [];
    const docker = fakeDocker([
      { exitCode: 0, signal: null, stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}\n', stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }), stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: `${'1'.repeat(64)}\n`, stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: JSON.stringify(realisticRawInspection()), stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: 'build output\n', stderr: '', timedOut: false, startedAt: '2026-07-24T10:00:01.500Z', finishedAt: '2026-07-24T10:00:02.500Z' },
      { exitCode: 0, signal: null, stdout: JSON.stringify(realisticRawInspection()), stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
      { exitCode: 1, signal: null, stdout: '', stderr: 'No such container: container-1\n', timedOut: false },
      { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
    ], trace);
    let persistedId: string | null = null;
    let clockTick = 0;
    let evidenceValue: Record<string, unknown> | undefined;
    const lifecycleCommands: Array<{ lifecycle: string; occurredAt: string; startedAt?: string | null; stoppedAt?: string | null }> = [];
    let cleanupProof: Extract<OperationCleanupProof, { kind: 'container-removed' }> | undefined;
    const ownership = { runnerWrite: vi.fn((command: RunnerWriteCommand) => { trace.push(command.kind); if (command.kind === 'container') { persistedId = command.containerId; lifecycleCommands.push({ lifecycle: command.lifecycle, occurredAt: command.occurredAt, startedAt: command.startedAt, stoppedAt: command.stoppedAt }); } if (command.kind === 'operation-cleanup' && command.proof.kind === 'container-removed') cleanupProof = command.proof; return { ok: true, kind: 'committed', eventSeq: 1 }; }), getJob: vi.fn(() => ({ ...emptyIdentityForTest(), containerId: persistedId, containerName: persistedId ? 'osi-image-builder-job-1-attempt-1' : null, containerImageDigest: persistedId ? DIGEST : null, containerLabelJobId: persistedId ? 'job-1' : null, containerLabelManifestSha: persistedId ? MANIFEST : null, containerLabels: persistedId ? { 'org.osi.image-builder.job-id': 'job-1', 'org.osi.image-builder.manifest-sha': MANIFEST } : null, containerMount: persistedId ? {} : null, containerEnvironment: persistedId ? {} : null, containerSecurity: persistedId ? {} : null, containerInspection: persistedId ? {} : null, containerCreatedAt: persistedId ? NOW : null })) };
    const result = await createDockerExecutor(options(docker, { ownership, clock: () => new Date(Date.parse(NOW) + clockTick++ * 1000).toISOString(), finalizeLogs: async ({ operationFinishedAt }) => ({ runner: 'absent', docker: 'absent', verifiedAt: operationFinishedAt }), evidence: async (value) => { trace.push('evidence'); evidenceValue = value; return { path: 'evidence/operation-1.json', sha256: 'c'.repeat(64) }; } })).run();

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('Docker should be available in fake lifecycle');
    expect(result.outcome).toBe('passed');
    expect(ownership.runnerWrite).toHaveBeenCalled();
    const create = docker.calls.find((call) => call[1] === 'create');
    expect(create).toBeDefined();
    expect(create).not.toContain('--rm');
    expect(create).toContain('--pull=never');
    expect(create).toContain('--platform=linux/amd64');
    expect(create).toContain('--network=bridge');
    expect(create).toContain('--cap-drop=ALL');
    expect(create).toContain('--security-opt=no-new-privileges:true');
    expect(create).toContain('--pids-limit=4096');
    expect(create).toContain('--ulimit=nofile=1024:4096');
    const mountArg = create?.find((value) => value.startsWith('--mount='));
    expect(mountArg).toBe('--mount=type=bind,source=/tmp/worktree,destination=/workdir');
    expect(mountArg).toBeDefined();
    const mountSegments = mountArg!.slice('--mount='.length).split(',');
    expect(mountSegments.every((segment) => /^(type|source|destination)=[^,]+$/u.test(segment))).toBe(true);
    expect(mountSegments).not.toContain('rw');
    expect(create).toContain('--user=1000:1000');
    expect(create).toContain(`registry.example/builder@sha256:${DIGEST}`);
    expect(create).not.toContain('/var/run/docker.sock');
    const startIndex = docker.calls.findIndex((call) => call[1] === 'start');
    expect(docker.runOptions[startIndex]).toMatchObject({ timeoutMs: 60_000, maxCaptureBytes: 16 * 1024 });
    expect(docker.runOptions.every((runOptions, index) => docker.calls[index]![1] === 'start' ? runOptions.timeoutMs === 60_000 : runOptions.timeoutMs === 30_000 && runOptions.maxCaptureBytes === 16 * 1024)).toBe(true);
    expect(docker.calls.map((call) => call[1])).toEqual(['version', 'image', 'ps', 'create', 'inspect', 'start', 'inspect', 'rm', 'inspect', 'ps']);
    expect(docker.calls.findIndex((call) => call[1] === 'rm')).toBeGreaterThan(docker.calls.findIndex((call) => call[1] === 'start'));
    expect(trace).toEqual(['docker:version', 'docker:image', 'docker:ps', 'operation-begin', 'docker:create', 'docker:inspect', 'container', 'docker:start', 'docker:inspect', 'container', 'container', 'evidence', 'operation-complete', 'docker:rm', 'docker:inspect', 'docker:ps', 'operation-cleanup']);
    expect(trace.indexOf('operation-complete')).toBeLessThan(trace.indexOf('docker:rm'));
    expect(trace.indexOf('docker:inspect', trace.indexOf('docker:rm'))).toBeGreaterThan(trace.indexOf('docker:rm'));
    expect(trace.indexOf('docker:ps', trace.indexOf('docker:rm'))).toBeGreaterThan(trace.indexOf('docker:inspect', trace.indexOf('docker:rm')));
    expect(trace.indexOf('operation-cleanup')).toBeGreaterThan(trace.indexOf('docker:ps', trace.indexOf('docker:rm')));
    expect(lifecycleCommands.map((command) => command.lifecycle)).toEqual(['created', 'started', 'stopped']);
    expect(lifecycleCommands[1]).toMatchObject({ startedAt: '2026-07-24T10:00:01.500Z' });
    expect(lifecycleCommands[2]).toMatchObject({ startedAt: '2026-07-24T10:00:01.500Z' });
    expect(lifecycleCommands[2]!.stoppedAt).toBe('2026-07-24T10:00:04.000Z');
    expect(cleanupProof?.stoppedAt).toBe(lifecycleCommands[2]!.stoppedAt);
    expect(Date.parse(lifecycleCommands[2]!.stoppedAt!)).toBeLessThanOrEqual(Date.parse(cleanupProof!.observedAt!));
    expect(Date.parse(lifecycleCommands[1]!.occurredAt)).toBeGreaterThanOrEqual(Date.parse(lifecycleCommands[1]!.startedAt!));
    expect(Date.parse(lifecycleCommands[2]!.occurredAt)).toBeGreaterThanOrEqual(Date.parse(lifecycleCommands[2]!.stoppedAt!));
    expect(evidenceValue?.inspection).toEqual(expect.objectContaining({ imagePreflight: expect.objectContaining({ architecture: 'amd64', os: 'linux' }), container: expect.objectContaining({ rootImageId: `sha256:${'e'.repeat(64)}` }) }));
  });

  it('rejects every inspected security or identity mismatch before starting the container', async () => {
    const mismatches: Array<[string, Partial<DockerInspection>]> = [
      ['container ID', { id: '2'.repeat(64) }],
      ['container name', { name: 'osi-image-builder-other-job-attempt-1' }],
      ['image ID', { imageId: `sha256:${'f'.repeat(64)}` }],
      ['image ref', { image: `registry.example/other@sha256:${DIGEST}` }],
      ['label', { labels: { 'org.osi.image-builder.job-id': 'other', 'org.osi.image-builder.manifest-sha': MANIFEST } }],
      ['mount', { mounts: [] }],
      ['user', { user: '0:0' }],
      ['workdir', { workingDir: '/wrong' }],
      ['network', { networkMode: 'host' }],
      ['capability', { capDrop: [] }],
      ['security', { privileged: true }],
      ['readonly rootfs', { readonlyRootfs: true }],
      ['pids', { pidsLimit: 1 }],
      ['ulimit', { ulimits: [{ name: 'nofile', soft: 1, hard: 1 }] }],
      ['running', { running: true }],
      ['environment', { environment: { INHERITED: '1' } }],
    ];
    for (const [name, mismatch] of mismatches) {
      const docker = fakeDocker([
        { exitCode: 0, signal: null, stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}', stderr: '', timedOut: false },
        { exitCode: 0, signal: null, stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }), stderr: '', timedOut: false },
        { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
        { exitCode: 0, signal: null, stdout: `${'1'.repeat(64)}\n`, stderr: '', timedOut: false },
        { exitCode: 0, signal: null, stdout: JSON.stringify([inspection(mismatch)]), stderr: '', timedOut: false },
        { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
        { exitCode: 1, signal: null, stdout: '', stderr: 'No such container: one\n', timedOut: false },
        { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
      ]);
      const ownership = { runnerWrite: vi.fn(() => ({ ok: true, kind: 'committed', eventSeq: 1 })), getJob: vi.fn(() => emptyIdentityForTest()) };
      await expect(createDockerExecutor(options(docker, { ownership })).run()).rejects.toThrow(DockerLifecycleError);
      expect(docker.calls.some((call) => call[1] === 'create')).toBe(true);
      expect(docker.calls.some((call) => call[1] === 'inspect')).toBe(true);
      expect(docker.calls.some((call) => call[1] === 'start')).toBe(false);
      expect(name).toBeTruthy();
    }
  });

  it('returns typed unavailable with zero ownership mutation when Docker cannot be reached', async () => {
    const docker = fakeDocker([Object.assign(new Error('docker unavailable'), { code: 'ENOENT' })]);
    const ownership = { runnerWrite: vi.fn(), getJob: vi.fn() };
    const result = await createDockerExecutor(options(docker, { ownership })).run();
    expect(result).toMatchObject({ available: false, mutationCount: 0 });
    expect(ownership.runnerWrite).not.toHaveBeenCalled();
    expect(ownership.getJob).not.toHaveBeenCalled();
  });

  it('returns typed unavailable with zero mutation when the Docker version control call times out', async () => {
    const docker = fakeDocker([{ timedOut: true }]);
    const ownership = { runnerWrite: vi.fn(), getJob: vi.fn() };
    const result = await createDockerExecutor(options(docker, { ownership })).run();
    expect(result).toEqual({ available: false, mutationCount: 0, reason: 'docker-unavailable' });
    expect(ownership.runnerWrite).not.toHaveBeenCalled();
    expect(ownership.getJob).not.toHaveBeenCalled();
    expect(docker.runOptions[0]).toMatchObject({ timeoutMs: 30_000, maxCaptureBytes: 16 * 1024 });
  });

  it('returns a typed lifecycle failure and retains identity when a later control call times out', async () => {
    const docker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
      { stdout: '' },
      { stdout: `${'1'.repeat(64)}\n` },
      { stdout: JSON.stringify(realisticRawInspection()) },
      { timedOut: true },
      { stdout: JSON.stringify(realisticRawInspection()) },
      { stdout: '' },
      { exitCode: 1, stderr: 'No such container: one\n' },
      { stdout: '' },
    ]);
    let persistedId: string | null = null;
    const ownership = { runnerWrite: vi.fn((command: { kind: string; containerId?: string }) => { if (command.kind === 'container') persistedId = command.containerId ?? null; return { ok: true }; }), getJob: vi.fn(() => ({ ...emptyIdentityForTest(), containerId: persistedId, containerName: persistedId ? 'osi-image-builder-job-1-attempt-1' : null })) };
    const result = await createDockerExecutor(options(docker, { ownership })).run();
    expect(result).toMatchObject({ available: true, outcome: 'failed' });
    expect(persistedId).toBe('1'.repeat(64));
    expect(docker.calls.map((call) => call[1])).toEqual(['version', 'image', 'ps', 'create', 'inspect', 'start', 'inspect', 'rm', 'inspect', 'ps']);
    expect(docker.runOptions.at(-1)).toMatchObject({ timeoutMs: 30_000, maxCaptureBytes: 16 * 1024 });
  });

  it('accepts the spec production job ID with an independently validated lowercase container name', async () => {
    const docker = fakeDocker([Object.assign(new Error('docker unavailable'), { code: 'ENOENT' })]);
    const result = await createDockerExecutor(options(docker, { jobId: '20260722T120000Z-01J4D5YQG7M9R2C6N8P0S1T3V', containerName: 'osi-image-builder-job-1-attempt-1' })).run();
    expect(result).toMatchObject({ available: false, mutationCount: 0 });
  });

  it('derives and executes registry argv, rejecting injected argv and noncanonical context', async () => {
    const docker = fakeDocker([
      { exitCode: 0, signal: null, stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}', stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }), stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: `${'1'.repeat(64)}\n`, stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: JSON.stringify([inspection()]), stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: JSON.stringify([inspection()]), stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
      { exitCode: 1, signal: null, stdout: '', stderr: 'No such container: one\n', timedOut: false },
      { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
    ]);
    const injected = { ...options(docker), operationArgv: ['sh', '-c', 'echo injected'] };
    let persistedId: string | null = null;
    const ownership = { runnerWrite: vi.fn((command: { kind: string; containerId?: string }) => { if (command.kind === 'container') persistedId = command.containerId ?? null; return { ok: true, kind: 'committed', eventSeq: 1 }; }), getJob: vi.fn(() => ({ ...emptyIdentityForTest(), containerId: persistedId, containerName: persistedId ? 'osi-image-builder-job-1-attempt-1' : null, containerImageDigest: persistedId ? DIGEST : null, containerLabelJobId: persistedId ? 'job-1' : null, containerLabelManifestSha: persistedId ? MANIFEST : null, containerLabels: persistedId ? { 'org.osi.image-builder.job-id': 'job-1', 'org.osi.image-builder.manifest-sha': MANIFEST } : null, containerMount: persistedId ? {} : null, containerEnvironment: persistedId ? {} : null, containerSecurity: persistedId ? {} : null, containerInspection: persistedId ? {} : null, containerCreatedAt: persistedId ? NOW : null })) };
    await createDockerExecutor({ ...options(docker, { ownership }), operationArgv: injected.operationArgv } as DockerExecutorOptions).run();
    const create = docker.calls.find((call) => call[1] === 'create')!;
    expect(create.slice(-4)).toEqual([`registry.example/builder@sha256:${DIGEST}`, 'node', INTERNAL_OPERATION_TOOL_PATH, 'verify-image']);
    expect(() => createOperationArgv('verify-image', { environment: '../branch' })).toThrow();
  });

  it('rejects an unknown runtime operation before any Docker command', async () => {
    const docker = fakeDocker([]);
    const invalid = options(docker, { operationId: 'unknown-operation' as DockerExecutorOptions['operationId'] });
    await expect(createDockerExecutor(invalid).run()).rejects.toThrow(/operation ID|unknown/i);
    expect(docker.calls).toHaveLength(0);
  });

  it('requires evidence and real log proof before Docker mutation', async () => {
    const docker = fakeDocker([{ exitCode: 0, signal: null, stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}', stderr: '', timedOut: false }]);
    const missingEvidence = { ...options(docker) } as { evidence?: DockerExecutorOptions['evidence'] };
    delete missingEvidence.evidence;
    const missingLogs = { ...options(docker) } as { finalizeLogs?: DockerExecutorOptions['finalizeLogs'] };
    delete missingLogs.finalizeLogs;
    await expect(createDockerExecutor(missingEvidence as DockerExecutorOptions).run()).rejects.toThrow(/evidence/i);
    await expect(createDockerExecutor(missingLogs as DockerExecutorOptions).run()).rejects.toThrow(/log finalizer/i);
    expect(docker.calls).toHaveLength(0);
  });

  it('rejects a non-linux-amd64 Docker server before database mutation', async () => {
    const docker = fakeDocker([{ exitCode: 0, signal: null, stdout: '{"Server":{"Os":"linux","Arch":"arm64"}}', stderr: '', timedOut: false }]);
    const ownership = { runnerWrite: vi.fn(), getJob: vi.fn() };
    await expect(createDockerExecutor(options(docker, { ownership })).run()).rejects.toThrow(/linux\/amd64|server/i);
    expect(ownership.runnerWrite).not.toHaveBeenCalled();
  });

  it('rejects wrong preflight image ID, RepoDigest, architecture, OS, and ambiguous image results', async () => {
    const imageCases: Array<[string, unknown]> = [
      ['image ID', [{ Id: 'not-an-image-id', RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }]],
      ['RepoDigest', [{ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${'d'.repeat(64)}`], Architecture: 'amd64', Os: 'linux' }]],
      ['architecture', [{ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'arm64', Os: 'linux' }]],
      ['OS', [{ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'windows' }]],
      ['ambiguous result', [{ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }, { Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }]],
    ];
    for (const [name, image] of imageCases) {
      const docker = fakeDocker([
        { exitCode: 0, signal: null, stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}', stderr: '', timedOut: false },
        { exitCode: 0, signal: null, stdout: JSON.stringify(image), stderr: '', timedOut: false },
      ]);
      const ownership = { runnerWrite: vi.fn(() => ({ ok: true, kind: 'committed', eventSeq: 1 })), getJob: vi.fn() };
      await expect(createDockerExecutor(options(docker, { ownership })).run()).rejects.toThrow(DockerLifecycleError);
      expect(docker.calls.map((call) => call[1])).toEqual(['version', 'image']);
      expect(ownership.runnerWrite).not.toHaveBeenCalled();
      expect(name).toBeTruthy();
    }
  });

  it('performs all read-only preflight checks before operation-begin', async () => {
    const emptyIdentity = emptyIdentityForTest();
    const imageDocker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
      { stdout: JSON.stringify([{ Id: 'not-an-image-id', RepoDigests: [], Architecture: 'amd64', Os: 'linux' }]) },
    ]);
    const imageOwnership = { runnerWrite: vi.fn(() => ({ ok: true })), getJob: vi.fn(() => emptyIdentity) };
    await expect(createDockerExecutor(options(imageDocker, { ownership: imageOwnership })).run()).rejects.toThrow(DockerLifecycleError);
    expect(imageOwnership.runnerWrite).not.toHaveBeenCalled();

    const identityDocker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
    ]);
    const identityOwnership = { runnerWrite: vi.fn(() => ({ ok: true })), getJob: vi.fn(() => ({ ...emptyIdentity, containerId: 'already-owned' })) };
    await expect(createDockerExecutor(options(identityDocker, { ownership: identityOwnership })).run()).rejects.toThrow(/identity/i);
    expect(identityOwnership.runnerWrite).not.toHaveBeenCalled();

    const labelDocker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
      { stdout: 'existing-container\n' },
    ]);
    const labelOwnership = { runnerWrite: vi.fn(() => ({ ok: true })), getJob: vi.fn(() => emptyIdentity) };
    await expect(createDockerExecutor(options(labelDocker, { ownership: labelOwnership })).run()).rejects.toThrow(/label/i);
    expect(labelOwnership.runnerWrite).not.toHaveBeenCalled();
    expect(labelDocker.calls.map((call) => call[1])).toEqual(['version', 'image', 'ps']);
  });

  it.each(['containerStartedAt', 'containerStoppedAt', 'containerRemovedAt', 'containerCleanupOutcome'] as const)('rejects stale %s before create with no ownership write', async (field) => {
    const docker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
    ]);
    const ownership = { runnerWrite: vi.fn(() => ({ ok: true })), getJob: vi.fn(() => ({ ...emptyIdentityForTest(), [field]: field === 'containerCleanupOutcome' ? 'passed' : NOW })) };
    await expect(createDockerExecutor(options(docker, { ownership })).run()).rejects.toThrow(/identity/i);
    expect(ownership.runnerWrite).not.toHaveBeenCalled();
    expect(docker.calls.map((call) => call[1])).toEqual(['version', 'image']);
    expect(docker.calls.some((call) => call[1] === 'create')).toBe(false);
  });

  it('retains only created identity when start/attach cannot spawn', async () => {
    const docker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
      { stdout: '' },
      { stdout: `${'1'.repeat(64)}\n` },
      { stdout: JSON.stringify([inspection()]) },
      new CommandExecutionError('start could not spawn'),
    ]);
    let persistedId: string | null = null;
    const lifecycles: string[] = [];
    const ownership = { runnerWrite: vi.fn((command: { kind: string; lifecycle?: string; containerId?: string; startedAt?: string | null; stoppedAt?: string | null }) => { if (command.kind === 'container') { lifecycles.push(command.lifecycle ?? ''); persistedId = command.containerId ?? null; } return { ok: true }; }), getJob: vi.fn(() => ({ ...emptyIdentityForTest(), containerId: persistedId, containerName: persistedId ? 'osi-image-builder-job-1-attempt-1' : null })) };
    await expect(createDockerExecutor(options(docker, { ownership })).run()).rejects.toBeInstanceOf(CommandExecutionError);
    expect(lifecycles).toEqual(['created']);
    expect(docker.calls.some((call) => call[1] === 'rm')).toBe(false);
  });

  it('rejects an invalid operation timeout before any Docker command', async () => {
    const docker = fakeDocker([]);
    await expect(createDockerExecutor(options(docker, { operationTimeoutMs: 0 })).run()).rejects.toThrow(/timeout/i);
    expect(docker.calls).toHaveLength(0);
  });

  it('derives SOURCE_DATE_EPOCH from the persisted source commit time and ignores caller overrides', async () => {
    const docker = fakeDocker(successfulResponses());
    const untrusted = { ...options(docker), sourceDateEpoch: '1' } as DockerExecutorOptions & { readonly sourceDateEpoch: string };
    await createDockerExecutor(untrusted).run();
    const create = docker.calls.find((call) => call[1] === 'create')!;
    expect(create).toContain('--env=SOURCE_DATE_EPOCH=1784887200');
    expect(create).not.toContain('--env=SOURCE_DATE_EPOCH=1');
  });

  it('uses a fresh coordinated lease snapshot for every ownership CAS', async () => {
    const docker = fakeDocker(successfulResponses());
    const expiries = [
      '2026-07-24T10:10:00.000Z', '2026-07-24T10:11:00.000Z', '2026-07-24T10:12:00.000Z',
      '2026-07-24T10:13:00.000Z', '2026-07-24T10:14:00.000Z', '2026-07-24T10:15:00.000Z',
    ];
    let index = 0;
    const writes: Array<{ kind: string; leaseExpiresAt?: string }> = [];
    const ownership = { runnerWrite: vi.fn((command: { kind: string; leaseExpiresAt?: string }) => { writes.push(command); return { ok: true }; }) };
    await createDockerExecutor(options(docker, { ownership, leaseSnapshot: () => ({ owner: 'runner-a', unit: 'osi-image-builder-runner@job-1.service', leaseExpiresAt: expiries[index++]!, expectedState: 'starting' }) })).run();
    expect(writes.map((write) => write.leaseExpiresAt)).toEqual(expiries);
  });

  it('stops an exact still-running container after attach timeout before persisting stopped evidence', async () => {
    const running = { ...realisticRawInspection(), State: { Running: true } };
    const responses = successfulResponses({ timedOut: true, exitCode: null });
    responses[5] = new CommandExecutionError('attach timed out', { result: { argv: ['/usr/bin/docker', 'start', '--attach', '1'.repeat(64)], exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true, startedAt: '2026-07-24T10:00:01.000Z', finishedAt: '2026-07-24T10:00:02.000Z' } });
    responses.splice(6, 4, { stdout: JSON.stringify(running) }, { stdout: '' }, { stdout: JSON.stringify(realisticRawInspection()) }, { stdout: '' }, { exitCode: 1, stderr: 'No such container: one\n' }, { stdout: '' });
    const docker = fakeDocker(responses);
    const writes: RunnerWriteCommand[] = [];
    const ownership = { runnerWrite: vi.fn((command: RunnerWriteCommand) => { writes.push(command); return { ok: true }; }) };
    let clockTick = 3;
    const result = await createDockerExecutor(options(docker, { ownership, clock: () => new Date(Date.parse(NOW) + clockTick++ * 1000).toISOString(), finalizeLogs: async ({ operationFinishedAt }) => ({ runner: 'absent', docker: 'absent', verifiedAt: operationFinishedAt }) })).run();
    expect(result).toMatchObject({ available: true, outcome: 'failed' });
    expect(docker.calls.map((call) => call[1])).toContain('stop');
    expect(docker.calls.find((call) => call[1] === 'stop')).toEqual(['/usr/bin/docker', 'stop', '--time=10', '1'.repeat(64)]);
    expect(writes.filter((write): write is Extract<RunnerWriteCommand, { kind: 'container' }> => write.kind === 'container').map((write) => write.lifecycle)).toEqual(['created', 'started', 'stopped']);
    const stopped = writes.find((write): write is Extract<RunnerWriteCommand, { kind: 'container' }> => write.kind === 'container' && write.lifecycle === 'stopped')!;
    const cleanup = writes.find((write): write is Extract<RunnerWriteCommand, { kind: 'operation-cleanup' }> => write.kind === 'operation-cleanup')!;
    if (cleanup.proof.kind !== 'container-removed') throw new Error('expected container cleanup proof');
    expect(stopped.stoppedAt).toBe('2026-07-24T10:00:08.000Z');
    expect(cleanup.proof.stoppedAt).toBe(stopped.stoppedAt);
    expect(Date.parse(stopped.stoppedAt!)).toBeLessThanOrEqual(Date.parse(cleanup.proof.observedAt));
  });

  it('retains created identity when stop and kill cannot prove the exact container stopped', async () => {
    const running = { ...realisticRawInspection(), State: { Running: true } };
    const responses = successfulResponses({ timedOut: true, exitCode: null });
    responses[5] = new CommandExecutionError('attach timed out', { result: { argv: ['/usr/bin/docker', 'start', '--attach', '1'.repeat(64)], exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true, startedAt: '2026-07-24T10:00:01.000Z', finishedAt: '2026-07-24T10:00:02.000Z' } });
    responses.splice(6, 4, { stdout: JSON.stringify(running) }, { exitCode: 1, stderr: 'stop failed' }, { stdout: JSON.stringify(running) }, { exitCode: 1, stderr: 'kill failed' }, { stdout: JSON.stringify(running) });
    const docker = fakeDocker(responses);
    const writes: Array<{ kind: string; lifecycle?: string }> = [];
    const ownership = { runnerWrite: vi.fn((command: { kind: string; lifecycle?: string }) => { writes.push(command); return { ok: true }; }) };
    await expect(createDockerExecutor(options(docker, { ownership })).run()).rejects.toBeInstanceOf(AggregateError);
    expect(writes.filter((write) => write.lifecycle !== undefined).map((write) => write.lifecycle)).toEqual(['created']);
    expect(docker.calls.some((call) => call[1] === 'rm')).toBe(false);
    expect(writes.some((write) => write.kind === 'operation-complete')).toBe(false);
  });

  it('recovers an observer failure with its real command result and records a failed operation only after stop proof', async () => {
    const startArgv = ['/usr/bin/docker', 'start', '--attach', '1'.repeat(64)];
    const responses = successfulResponses();
    responses[5] = new CommandExecutionError('output observer failed', { result: { argv: startArgv, exitCode: null, signal: 'SIGTERM', stdout: 'partial', stderr: '', timedOut: false, startedAt: '2026-07-24T10:00:01.000Z', finishedAt: '2026-07-24T10:00:02.000Z' } });
    const docker = fakeDocker(responses);
    const writes: Array<{ kind: string; lifecycle?: string }> = [];
    const ownership = { runnerWrite: vi.fn((command: { kind: string; lifecycle?: string }) => { writes.push(command); return { ok: true }; }) };
    const result = await createDockerExecutor(options(docker, { ownership })).run();
    expect(result).toMatchObject({ available: true, outcome: 'failed' });
    expect(writes.filter((write) => write.lifecycle !== undefined).map((write) => write.lifecycle)).toEqual(['created', 'started', 'stopped']);
  });

  it('finalizes a safe create failure as immutable not_created evidence with null cleanup', async () => {
    const trace: string[] = [];
    const docker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
      { stdout: '' },
      { exitCode: 1, stderr: 'create failed' },
      { stdout: '' },
    ]);
    const writes: RunnerWriteCommand[] = [];
    const ownership = { runnerWrite: vi.fn((command: RunnerWriteCommand) => { writes.push(command); return { ok: true }; }) };
    let clockTick = 0;
    const result = await createDockerExecutor(options(docker, { ownership, clock: () => new Date(Date.parse(NOW) + clockTick++ * 1000).toISOString(), finalizeLogs: async ({ operationFinishedAt }) => { trace.push('logs'); return { runner: 'absent', docker: 'absent', verifiedAt: operationFinishedAt }; }, evidence: async (value) => { trace.push('evidence'); return { path: 'evidence/failure.json', sha256: 'c'.repeat(64) }; } })).run().catch((error) => error);
    expect(result).toBeInstanceOf(DockerLifecycleError);
    expect(writes.map((write) => write.kind)).toEqual(['operation-begin', 'operation-complete', 'operation-cleanup']);
    const completion = writes.find((write): write is Extract<RunnerWriteCommand, { kind: 'operation-complete' }> => write.kind === 'operation-complete')!;
    const cleanup = writes.find((write): write is Extract<RunnerWriteCommand, { kind: 'operation-cleanup' }> => write.kind === 'operation-cleanup')!;
    expect(completion.input).toMatchObject({ lifecyclePhase: 'not_created', outcome: 'failed', errorCode: 'DOCKER_EXECUTION_DEFINITION_MISMATCH', error: { code: 'DOCKER_EXECUTION_DEFINITION_MISMATCH' } });
    expect(completion.input).not.toHaveProperty('containerId');
    if (cleanup.proof.kind !== 'null-identity') throw new Error('expected null identity cleanup proof');
    expect(cleanup.proof.container.observedAt).toBe('2026-07-24T10:00:02.000Z');
    expect(Date.parse(cleanup.proof.container.observedAt)).toBeLessThanOrEqual(Date.parse(cleanup.at));
    expect(trace).toEqual(['logs', 'evidence']);
  });

  it.each([
    ['stale', '2026-07-24T09:59:59.999Z'],
    ['future', '2026-07-24T11:00:00.000Z'],
  ] as const)('rejects %s log proof and does not claim cleanup', async (label, verifiedAt) => {
    const docker = fakeDocker(successfulResponses());
    const writes: Array<{ kind: string }> = [];
    const ownership = { runnerWrite: vi.fn((command: { kind: string }) => { writes.push(command); return { ok: true }; }) };
    await expect(createDockerExecutor(options(docker, { ownership, finalizeLogs: async () => ({ runner: 'absent', docker: 'absent', verifiedAt }) })).run()).rejects.toThrow(/log proof/i);
    expect(label).toBeTruthy();
    expect(writes.some((write) => write.kind === 'operation-cleanup')).toBe(false);
  });

  it('proves orphan cleanup and lifecycle ordering after an inspected mismatch', async () => {
    const docker = fakeDocker([
      { exitCode: 0, signal: null, stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}', stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }), stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: `${'1'.repeat(64)}\n`, stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: JSON.stringify([inspection({ imageId: `sha256:${'f'.repeat(64)}` })]), stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
      { exitCode: 1, signal: null, stdout: '', stderr: 'No such container: one\n', timedOut: false },
      { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
    ]);
    const writes: Array<{ kind: string; input?: OperationInput }> = [];
    const ownership = { runnerWrite: vi.fn((command: { kind: string; input?: OperationInput }) => { writes.push(command); return { ok: true, kind: 'committed', eventSeq: 1 }; }), getJob: vi.fn(() => emptyIdentityForTest()) };
    await expect(createDockerExecutor(options(docker, { ownership })).run()).rejects.toThrow(DockerLifecycleError);
    expect(docker.calls.map((call) => call[1])).toEqual(['version', 'image', 'ps', 'create', 'inspect', 'rm', 'inspect', 'ps']);
    expect(docker.calls.some((call) => call[1] === 'start')).toBe(false);
    expect(writes.map((write) => write.kind)).toEqual(['operation-begin', 'operation-complete', 'operation-cleanup']);
    expect(writes[1]!.input).toMatchObject({ lifecyclePhase: 'not_created', outcome: 'failed', errorCode: 'DOCKER_EXECUTION_DEFINITION_MISMATCH', error: { code: 'DOCKER_EXECUTION_DEFINITION_MISMATCH' } });
  });

  it('retains the unfinished operation when rejected-container cleanup cannot prove removal', async () => {
    const docker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
      { stdout: '' },
      { stdout: `${'1'.repeat(64)}\n` },
      { stdout: JSON.stringify([inspection({ imageId: `sha256:${'f'.repeat(64)}` })]) },
      { exitCode: 1, stderr: 'rm failed' },
    ]);
    const writes: Array<{ kind: string }> = [];
    const ownership = { runnerWrite: vi.fn((command: { kind: string }) => { writes.push(command); return { ok: true }; }), getJob: vi.fn(() => emptyIdentityForTest()) };
    await expect(createDockerExecutor(options(docker, { ownership })).run()).rejects.toBeInstanceOf(AggregateError);
    expect(writes.map((write) => write.kind)).toEqual(['operation-begin']);
    expect(docker.calls.some((call) => call[1] === 'start')).toBe(false);
  });

  it('rejects with a controlled command error when an output callback throws', async () => {
    await expect(createCommandExecutor().run([process.execPath, '-e', 'process.stdout.write("output"); setTimeout(() => {}, 1000)'], { env: { PATH: process.env.PATH ?? '', HOME: '/tmp' }, timeoutMs: 5_000, onStdout: () => { throw new Error('observer failed'); } })).rejects.toMatchObject({ name: 'CommandExecutionError', result: expect.objectContaining({ stdout: 'output' }) });
  });
});

function emptyIdentityForTest(): PersistedContainerIdentity & { readonly sourceCommitTime: string } {
  return { sourceCommitTime: NOW, containerId: null, containerName: null, containerImageDigest: null, containerLabelJobId: null, containerLabelManifestSha: null, containerLabels: null, containerMount: null, containerEnvironment: null, containerSecurity: null, containerInspection: null, containerCreatedAt: null, containerStartedAt: null, containerStoppedAt: null, containerRemovedAt: null, containerCleanupOutcome: null };
}
