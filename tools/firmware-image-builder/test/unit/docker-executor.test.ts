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
import { createOperationArgv, createOperationDefinition, assertOperationRegistryCoverage, INTERNAL_OPERATION_TOOL_PATH } from '../../runner/src/operation-registry.js';
import { CommandExecutionError, createCommandExecutor, type CommandResult, type CommandRunOptions } from '../../runner/src/command-executor.js';
import type { JsonObject, OperationInput } from '../../api/src/store.js';
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
    status: 'created',
    createdAt: '2026-07-24T09:59:59.000Z',
    startedAt: null,
    finishedAt: null,
    exitCode: 0,
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
    Created: '2026-07-24T09:59:59.000000000Z',
    State: { Status: 'exited', Running: false, StartedAt: '2026-07-24T10:00:01.500000000Z', FinishedAt: '2026-07-24T10:00:02.500000000Z', ExitCode: 0 },
  };
}

function realisticCreatedRawInspection(): Record<string, unknown> {
  const value = realisticRawInspection();
  value.Created = '2026-07-24T09:59:59.000000000Z';
  value.State = { Status: 'created', Running: false, StartedAt: '0001-01-01T00:00:00.000000000Z', FinishedAt: '0001-01-01T00:00:00.000000000Z', ExitCode: 0 };
  return value;
}

function rawInspectionWithNetwork(
  state: 'created' | 'exited',
  networkMode: 'bridge' | 'none',
): Record<string, unknown> {
  const value = state === 'created' ? realisticCreatedRawInspection() : realisticRawInspection();
  (value.HostConfig as Record<string, unknown>).NetworkMode = networkMode;
  return value;
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
        exitCode: response.exitCode === undefined ? 0 : response.exitCode,
        signal: response.signal === undefined ? null : response.signal,
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
    { stdout: JSON.stringify(realisticCreatedRawInspection()) },
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

  it.each(['activate-target', 'copy-feed-config', 'update-feeds', 'install-feeds', 'resolve-config', 'build-image', 'verify-image', 'verify-profile-parity', 'verify-chameleon', 'verify-db-schema', 'verify-sync-flow', 'verify-strega', 'verify-communication', 'check-mqtt-topics', 'mirror-gui'] as const)('uses /workdir for normal operation %s', (operationId) => {
    expect(createOperationDefinition(operationId, { environment: 'full_raspberrypi_bcm27xx_bcm2712' }).workingDirectory).toBe('/workdir');
  });

  it.each(['frontend-install', 'frontend-test', 'frontend-typecheck', 'frontend-build'] as const)('uses the fixed frontend cwd for %s', (operationId) => {
    const definition = createOperationDefinition(operationId, { environment: 'full_raspberrypi_bcm27xx_bcm2712' });
    expect(definition.workingDirectory).toBe('/workdir/web/react-gui');
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.argv)).toBe(true);
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
      { exitCode: 0, signal: null, stdout: JSON.stringify(realisticCreatedRawInspection()), stderr: '', timedOut: false },
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
    expect(result.mutationCount).toBe(6);

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
    const complete = ownership.runnerWrite.mock.calls.map(([command]) => command).find((command): command is Extract<RunnerWriteCommand, { kind: 'operation-complete' }> => command.kind === 'operation-complete');
    expect(complete).toBeDefined();
    expect(Date.parse(complete!.at)).toBeGreaterThan(Date.parse(complete!.input.finishedAt!));
    expect(trace.indexOf('evidence')).toBeLessThan(trace.indexOf('operation-complete'));
    expect(lifecycleCommands.map((command) => command.lifecycle)).toEqual(['created', 'started', 'stopped']);
    expect(lifecycleCommands[1]).toMatchObject({ startedAt: '2026-07-24T10:00:01.500Z' });
    expect(lifecycleCommands[2]).toMatchObject({ startedAt: '2026-07-24T10:00:01.500Z' });
    expect(lifecycleCommands[2]!.stoppedAt).toBe('2026-07-24T10:00:02.500Z');
    expect(cleanupProof?.stoppedAt).toBe(lifecycleCommands[2]!.stoppedAt);
    expect(Date.parse(lifecycleCommands[2]!.stoppedAt!)).toBeLessThanOrEqual(Date.parse(cleanupProof!.observedAt!));
    expect(Date.parse(lifecycleCommands[1]!.occurredAt)).toBeGreaterThanOrEqual(Date.parse(lifecycleCommands[1]!.startedAt!));
    expect(Date.parse(lifecycleCommands[2]!.occurredAt)).toBeGreaterThanOrEqual(Date.parse(lifecycleCommands[2]!.stoppedAt!));
    expect(evidenceValue?.inspection).toEqual(expect.objectContaining({ imagePreflight: expect.objectContaining({ architecture: 'amd64', os: 'linux' }), container: expect.objectContaining({ rootImageId: `sha256:${'e'.repeat(64)}` }) }));
  });

  it('recovers retained exact identity when rm completed before cleanup CAS', async () => {
    const docker = fakeDocker([
      ...successfulResponses(),
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
      { exitCode: 1, stderr: 'No such container: retained\n' },
      { stdout: '' },
    ]);
    const identity = {
      ...emptyIdentityForTest(),
      containerId: null as string | null,
      containerName: null as string | null,
      containerImageDigest: null as string | null,
      containerLabelJobId: null as string | null,
      containerLabelManifestSha: null as string | null,
      containerLabels: null as JsonObject | null,
      containerStoppedAt: null as string | null,
    };
    let operation: OperationInput | null = null;
    let rejectCleanup = true;
    const ownership = {
      runnerWrite: vi.fn((command: RunnerWriteCommand) => {
        if (command.kind === 'container') {
          Object.assign(identity, {
            containerId: command.containerId,
            containerName: command.containerName,
            containerImageDigest: command.imageDigest,
            containerLabelJobId: command.labels['org.osi.image-builder.job-id'],
            containerLabelManifestSha: command.labels['org.osi.image-builder.manifest-sha'],
            containerLabels: command.labels,
            containerStoppedAt: command.stoppedAt ?? identity.containerStoppedAt,
          });
        }
        if (command.kind === 'operation-complete') operation = command.input;
        if (command.kind === 'operation-cleanup') {
          if (rejectCleanup) return { ok: false, kind: 'cas-lost' };
          Object.assign(identity, emptyIdentityForTest());
        }
        return { ok: true, kind: 'committed', eventSeq: 1 };
      }),
    };
    const store = {
      getJob: () => identity,
      getOperation: () => operation,
    };
    const first = createDockerExecutor(options(docker, { ownership, store }));
    await expect(first.run()).rejects.toThrow(/ownership write was not committed/i);
    expect(identity.containerId).toBe('1'.repeat(64));

    rejectCleanup = false;
    const second = createDockerExecutor(options(docker, { ownership, store }));
    await expect(second.run()).resolves.toMatchObject({
      available: true,
      outcome: 'passed',
      containerId: '1'.repeat(64),
    });
    expect(docker.calls.filter((call) => call[1] === 'create')).toHaveLength(1);
    const recovered = ownership.runnerWrite.mock.calls
      .map(([command]) => command)
      .find((command): command is Extract<RunnerWriteCommand, { kind: 'operation-cleanup' }> => (
        command.kind === 'operation-cleanup' && command.proof.kind === 'container-absent'
      ));
    expect(recovered?.proof).toMatchObject({
      kind: 'container-absent',
      id: '1'.repeat(64),
      name: 'osi-image-builder-job-1-attempt-1',
      imageDigest: DIGEST,
      globalLabelResult: 'no-match',
    });
    expect(identity.containerId).toBeNull();
  });

  it('runs target-setup feed operations with Docker network disabled', async () => {
    const docker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}\n' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
      { stdout: '' },
      { stdout: `${'1'.repeat(64)}\n` },
      { stdout: JSON.stringify(rawInspectionWithNetwork('created', 'none')) },
      { stdout: '', startedAt: '2026-07-24T10:00:01.500Z', finishedAt: '2026-07-24T10:00:02.500Z' },
      { stdout: JSON.stringify(rawInspectionWithNetwork('exited', 'none')) },
      { stdout: '' },
      { exitCode: 1, stderr: 'No such container\n' },
      { stdout: '' },
    ]);

    await createDockerExecutor(options(docker, { operationId: 'update-feeds' })).run();

    const create = docker.calls.find((call) => call[1] === 'create');
    expect(create).toContain('--network=none');
    expect(create).not.toContain('--network=bridge');
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
      { stdout: JSON.stringify(realisticCreatedRawInspection()) },
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
      { exitCode: 0, signal: null, stdout: JSON.stringify([inspection({ status: 'exited', startedAt: '2026-07-24T10:00:01.500Z', finishedAt: '2026-07-24T10:00:02.500Z' })]), stderr: '', timedOut: false },
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

  it('uses the registry frontend definition for create, inspection, security, and executed argv', async () => {
    const frontendRaw = (): Record<string, unknown> => {
      const value = realisticRawInspection();
      (value.Config as Record<string, unknown>).WorkingDir = '/workdir/web/react-gui';
      return value;
    };
    const frontendCreatedRaw = (): Record<string, unknown> => ({ ...frontendRaw(), State: { Status: 'created', Running: false, StartedAt: '0001-01-01T00:00:00.000000000Z', FinishedAt: '0001-01-01T00:00:00.000000000Z', ExitCode: 0 } });
    const docker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
      { stdout: '' }, { stdout: `${'1'.repeat(64)}\n` }, { stdout: JSON.stringify(frontendCreatedRaw()) }, { stdout: '' }, { stdout: JSON.stringify(frontendRaw()) }, { stdout: '' }, { exitCode: 1, stderr: 'No such container: one\n' }, { stdout: '' },
    ]);
    const writes: RunnerWriteCommand[] = [];
    const ownership = { runnerWrite: vi.fn((command: RunnerWriteCommand) => { writes.push(command); return { ok: true }; }) };
    await createDockerExecutor(options(docker, { operationId: 'frontend-test', ownership })).run();
    const create = docker.calls.find((call) => call[1] === 'create')!;
    expect(create).toContain('--workdir=/workdir/web/react-gui');
    expect(create.slice(-3)).toEqual(['npm', 'run', 'test:unit']);
    const container = writes.find((command): command is Extract<RunnerWriteCommand, { kind: 'container' }> => command.kind === 'container')!;
    expect(container.security).toMatchObject({ workdir: '/workdir/web/react-gui' });
    const operation = writes.find((command): command is Extract<RunnerWriteCommand, { kind: 'operation-complete' }> => command.kind === 'operation-complete')!;
    expect(operation.input.argv).toEqual(['npm', 'run', 'test:unit']);
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
    const running = { ...realisticRawInspection(), State: { Status: 'running', Running: true, StartedAt: '2026-07-24T10:00:01.500000000Z', FinishedAt: '0001-01-01T00:00:00.000000000Z', ExitCode: null } };
    const responses = successfulResponses({ timedOut: true, exitCode: null });
    responses[5] = new CommandExecutionError('attach timed out', { result: { argv: ['/usr/bin/docker', 'start', '--attach', '1'.repeat(64)], exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true, startedAt: '2026-07-24T10:00:01.000Z', finishedAt: '2026-07-24T10:00:02.000Z' } });
    const stoppedRaw = realisticRawInspection();
    stoppedRaw.State = { Status: 'exited', Running: false, StartedAt: '2026-07-24T10:00:01.500000000Z', FinishedAt: '2026-07-24T10:00:08.000000000Z', ExitCode: 143 };
    responses.splice(6, 4, { stdout: JSON.stringify(running) }, { stdout: '' }, { stdout: JSON.stringify(stoppedRaw) }, { stdout: '' }, { exitCode: 1, stderr: 'No such container: one\n' }, { stdout: '' });
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
    const running = { ...realisticRawInspection(), State: { Status: 'running', Running: true, StartedAt: '2026-07-24T10:00:01.500000000Z', FinishedAt: '0001-01-01T00:00:00.000000000Z', ExitCode: null } };
    const responses = successfulResponses({ timedOut: true, exitCode: null });
    responses[5] = new CommandExecutionError('attach timed out', { result: { argv: ['/usr/bin/docker', 'start', '--attach', '1'.repeat(64)], exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true, startedAt: '2026-07-24T10:00:01.000Z', finishedAt: '2026-07-24T10:00:02.000Z' } });
    responses.splice(6, 4, { stdout: JSON.stringify(running) }, { exitCode: 1, stderr: 'stop failed' }, { stdout: JSON.stringify(running) }, { exitCode: 1, stderr: 'kill failed' }, { stdout: JSON.stringify(running) });
    const docker = fakeDocker(responses);
    const writes: Array<{ kind: string; lifecycle?: string }> = [];
    const ownership = { runnerWrite: vi.fn((command: { kind: string; lifecycle?: string }) => { writes.push(command); return { ok: true }; }) };
    await expect(createDockerExecutor(options(docker, { ownership })).run()).rejects.toSatisfy((error: unknown) => error instanceof AggregateError && error.errors.some((cause) => cause instanceof CommandExecutionError) && error.errors.length >= 3);
    expect(writes.filter((write) => write.lifecycle !== undefined).map((write) => write.lifecycle)).toEqual(['created']);
    expect(docker.calls.some((call) => call[1] === 'rm')).toBe(false);
    expect(writes.some((write) => write.kind === 'operation-complete')).toBe(false);
  });

  it('retains the timeout command result when stopped-state recovery also fails', async () => {
    const running = { ...realisticRawInspection(), State: { Status: 'running', Running: true, StartedAt: '2026-07-24T10:00:01.500000000Z', FinishedAt: '0001-01-01T00:00:00.000000000Z', ExitCode: null } };
    const responses = successfulResponses({ timedOut: true, exitCode: null });
    responses[5] = { stdout: '', stderr: '', exitCode: null, signal: 'SIGKILL', timedOut: true, startedAt: '2026-07-24T10:00:01.000Z', finishedAt: '2026-07-24T10:00:02.000Z' };
    responses.splice(6, 4, { stdout: JSON.stringify(running) }, { exitCode: 1, stderr: 'stop failed' }, { stdout: JSON.stringify(running) }, { exitCode: 1, stderr: 'kill failed' }, { stdout: JSON.stringify(running) });
    const docker = fakeDocker(responses);
    const writes: RunnerWriteCommand[] = [];
    const ownership = { runnerWrite: vi.fn((command: RunnerWriteCommand) => { writes.push(command); return { ok: true }; }), getJob: vi.fn(() => emptyIdentityForTest()) };
    await expect(createDockerExecutor(options(docker, { ownership })).run()).rejects.toSatisfy((error: unknown) => error instanceof AggregateError && error.errors.some((cause) => cause instanceof CommandExecutionError) && error.errors.length >= 3);
    expect(docker.calls.some((call) => call[1] === 'rm')).toBe(false);
    expect(writes.map((command) => command.kind)).toEqual(['operation-begin', 'container']);
  });

  it('retains the observer command result when stopped-state recovery also fails', async () => {
    const running = { ...realisticRawInspection(), State: { Status: 'running', Running: true, StartedAt: '2026-07-24T10:00:01.000000000Z', FinishedAt: '0001-01-01T00:00:00.000000000Z', ExitCode: null } };
    const startArgv = ['/usr/bin/docker', 'start', '--attach', '1'.repeat(64)];
    const responses = successfulResponses();
    responses[5] = new CommandExecutionError('output observer failed', { result: { argv: startArgv, exitCode: null, signal: 'SIGTERM', stdout: 'partial', stderr: '', timedOut: false, startedAt: '2026-07-24T10:00:01.000Z', finishedAt: '2026-07-24T10:00:02.000Z' } });
    responses.splice(6, 4, { stdout: JSON.stringify(running) }, { exitCode: 1, stderr: 'stop failed' }, { stdout: JSON.stringify(running) }, { exitCode: 1, stderr: 'kill failed' }, { stdout: JSON.stringify(running) });
    const docker = fakeDocker(responses);
    const writes: RunnerWriteCommand[] = [];
    const ownership = { runnerWrite: vi.fn((command: RunnerWriteCommand) => { writes.push(command); return { ok: true }; }), getJob: vi.fn(() => emptyIdentityForTest()) };
    await expect(createDockerExecutor(options(docker, { ownership })).run()).rejects.toSatisfy((error: unknown) => error instanceof AggregateError && error.errors.some((cause) => cause instanceof CommandExecutionError) && error.errors.length >= 3);
    expect(docker.calls.some((call) => call[1] === 'rm')).toBe(false);
    expect(writes.map((command) => command.kind)).toEqual(['operation-begin', 'container']);
  });

  it('does not emit a started lifecycle when Docker reports a failed start without a start instant', async () => {
    const stopped = { ...realisticRawInspection(), State: { Status: 'created', Running: false, StartedAt: '0001-01-01T00:00:00.000000000Z', FinishedAt: '0001-01-01T00:00:00.000000000Z', ExitCode: 0 } };
    const responses = successfulResponses({ exitCode: 1 });
    responses[5] = { exitCode: 1, signal: null, stdout: '', stderr: 'start failed', timedOut: false, startedAt: '2026-07-24T10:00:01.000Z', finishedAt: '2026-07-24T10:00:02.000Z' };
    responses[6] = { stdout: JSON.stringify(stopped) };
    const docker = fakeDocker(responses);
    const writes: RunnerWriteCommand[] = [];
    const ownership = { runnerWrite: vi.fn((command: RunnerWriteCommand) => { writes.push(command); return { ok: true }; }) };
    const result = await createDockerExecutor(options(docker, { ownership })).run();
    expect(result).toMatchObject({ available: true, outcome: 'failed' });
    expect(writes.filter((command): command is Extract<RunnerWriteCommand, { kind: 'container' }> => command.kind === 'container').map((command) => command.lifecycle)).toEqual(['created']);
    const completion = writes.find((command): command is Extract<RunnerWriteCommand, { kind: 'operation-complete' }> => command.kind === 'operation-complete')!;
    expect(completion.input).toMatchObject({ lifecyclePhase: 'created', errorCode: 'DOCKER_EXECUTION_DEFINITION_MISMATCH' });
    const cleanup = writes.find((command): command is Extract<RunnerWriteCommand, { kind: 'operation-cleanup' }> => command.kind === 'operation-cleanup')!;
    if (cleanup.proof.kind !== 'container-removed') throw new Error('expected container cleanup proof');
    expect(cleanup.proof.stoppedAt).toBe(cleanup.proof.observedAt);
  });

  it('allows a failed stop when a later exact inspect proves the container stopped', async () => {
    const running = { ...realisticRawInspection(), State: { Status: 'running', Running: true, StartedAt: '2026-07-24T10:00:01.500000000Z', FinishedAt: '0001-01-01T00:00:00.000000000Z', ExitCode: null } };
    const stopped = { ...realisticRawInspection(), State: { Status: 'exited', Running: false, StartedAt: '2026-07-24T10:00:01.500000000Z', FinishedAt: '2026-07-24T10:00:08.000000000Z', ExitCode: 143 } };
    const responses = successfulResponses({ timedOut: true, exitCode: null });
    responses[5] = { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true, startedAt: '2026-07-24T10:00:01.000Z', finishedAt: '2026-07-24T10:00:02.000Z' };
    responses.splice(6, 4, { stdout: JSON.stringify(running) }, { exitCode: 1, stderr: 'stop failed' }, { stdout: JSON.stringify(stopped) }, { stdout: '' }, { exitCode: 1, stderr: 'No such container: one\n' }, { stdout: '' });
    const docker = fakeDocker(responses);
    const result = await createDockerExecutor(options(docker)).run();
    expect(result).toMatchObject({ available: true, outcome: 'failed' });
    expect(docker.calls.some((call) => call[1] === 'kill')).toBe(false);
  });

  it('records stop and intermediate inspect failures when kill escalation proves stopped', async () => {
    const running = { ...realisticRawInspection(), State: { Status: 'running', Running: true, StartedAt: '2026-07-24T10:00:01.500000000Z', FinishedAt: '0001-01-01T00:00:00.000000000Z', ExitCode: null } };
    const stopped = { ...realisticRawInspection(), State: { Status: 'exited', Running: false, StartedAt: '2026-07-24T10:00:01.500000000Z', FinishedAt: '2026-07-24T10:00:08.000000000Z', ExitCode: 143 } };
    const responses = successfulResponses({ timedOut: true, exitCode: null });
    responses[5] = { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true, startedAt: '2026-07-24T10:00:01.000Z', finishedAt: '2026-07-24T10:00:02.000Z' };
    responses.splice(6, 4, { stdout: JSON.stringify(running) }, { exitCode: 1, stderr: 'stop failed' }, { stdout: JSON.stringify(running) }, { stdout: '' }, { stdout: JSON.stringify(stopped) }, { stdout: '' }, { exitCode: 1, stderr: 'No such container: one\n' }, { stdout: '' });
    const docker = fakeDocker(responses);
    const writes: RunnerWriteCommand[] = [];
    const ownership = { runnerWrite: vi.fn((command: RunnerWriteCommand) => { writes.push(command); return { ok: true }; }) };
    const result = await createDockerExecutor(options(docker, { ownership })).run();
    expect(result).toMatchObject({ available: true, outcome: 'failed' });
    expect(docker.calls.map((call) => call[1])).toEqual(expect.arrayContaining(['stop', 'kill']));
    const stoppedWrite = writes.find((write): write is Extract<RunnerWriteCommand, { kind: 'container' }> => write.kind === 'container' && write.lifecycle === 'stopped')!;
    expect(stoppedWrite.inspection).toMatchObject({ recoveryFailures: [{ code: 'DOCKER_EXECUTION_DEFINITION_MISMATCH' }] });
    expect(writes.some((write) => write.kind === 'operation-cleanup')).toBe(true);
  });

  it('fails a clean attach when the first exact post-attach inspect still reports running', async () => {
    const running = { ...realisticRawInspection(), State: { Status: 'running', Running: true, StartedAt: '2026-07-24T10:00:01.500000000Z', FinishedAt: '0001-01-01T00:00:00.000000000Z', ExitCode: null } };
    const stopped = { ...realisticRawInspection(), State: { Status: 'exited', Running: false, StartedAt: '2026-07-24T10:00:01.500000000Z', FinishedAt: '2026-07-24T10:00:02.500000000Z', ExitCode: 0 } };
    const responses = successfulResponses({ exitCode: 0 });
    responses.splice(6, 4, { stdout: JSON.stringify(running) }, { stdout: '' }, { stdout: JSON.stringify(stopped) }, { stdout: '' }, { exitCode: 1, stderr: 'No such container: one\n' }, { stdout: '' });
    const docker = fakeDocker(responses);
    const writes: RunnerWriteCommand[] = [];
    const ownership = { runnerWrite: vi.fn((command: RunnerWriteCommand) => { writes.push(command); return { ok: true }; }) };
    const result = await createDockerExecutor(options(docker, { ownership })).run();
    expect(result).toMatchObject({ available: true, outcome: 'failed' });
    const completion = writes.find((write): write is Extract<RunnerWriteCommand, { kind: 'operation-complete' }> => write.kind === 'operation-complete')!;
    expect(completion.input).toMatchObject({ errorCode: 'DOCKER_EXECUTION_DEFINITION_MISMATCH', error: { code: 'DOCKER_EXECUTION_DEFINITION_MISMATCH' } });
    expect(completion.input.inspection).toMatchObject({ recoveryAttempted: true, recoveryActions: ['inspect', 'stop', 'inspect'] });
    expect(writes.some((write) => write.kind === 'operation-cleanup')).toBe(true);
  });

  it.each([
    ['nonzero', { exitCode: 7, signal: null }],
    ['signal', { exitCode: null, signal: 'SIGTERM' as const }],
  ] as const)('retains a returned %s start result with every recovery failure', (_label, startResult) => {
    const running = { ...realisticRawInspection(), State: { Status: 'running', Running: true, StartedAt: '2026-07-24T10:00:01.500000000Z', FinishedAt: '0001-01-01T00:00:00.000000000Z', ExitCode: null } };
    const responses = successfulResponses();
    responses[5] = { ...startResult, stdout: 'partial output', stderr: 'start failure', timedOut: false, startedAt: '2026-07-24T10:00:01.000Z', finishedAt: '2026-07-24T10:00:02.000Z' };
    responses.splice(6, 4, { stdout: JSON.stringify(running) }, { exitCode: 1, stderr: 'stop failed' }, { stdout: JSON.stringify(running) }, { exitCode: 1, stderr: 'kill failed' }, { stdout: JSON.stringify(running) });
    const docker = fakeDocker(responses);
    return createDockerExecutor(options(docker)).run().then(() => { throw new Error('expected recovery failure'); }, (error: unknown) => {
      expect(error).toBeInstanceOf(AggregateError);
      const primary = error instanceof AggregateError ? error.errors.find((cause) => cause instanceof CommandExecutionError) : undefined;
      expect(primary).toBeInstanceOf(CommandExecutionError);
      expect((primary as CommandExecutionError).result).toMatchObject({ exitCode: startResult.exitCode, signal: startResult.signal, stdout: 'partial output', stderr: 'start failure' });
      expect(error instanceof AggregateError ? error.errors.length : 0).toBeGreaterThanOrEqual(4);
    });
  });

  it('rejects an already-executed immediate post-create inspection', async () => {
    const responses = successfulResponses();
    responses[4] = { stdout: JSON.stringify(realisticRawInspection()) };
    const docker = fakeDocker(responses);
    await expect(createDockerExecutor(options(docker)).run()).rejects.toSatisfy((error: unknown) => error instanceof AggregateError && error.errors.some((cause) => cause instanceof DockerLifecycleError));
  });

  it('rejects a zero Docker Created instant instead of normalizing it to null', async () => {
    const created = realisticCreatedRawInspection();
    created.Created = '0001-01-01T00:00:00.000000000Z';
    const responses = successfulResponses();
    responses[4] = { stdout: JSON.stringify(created) };
    const docker = fakeDocker(responses);
    await expect(createDockerExecutor(options(docker)).run()).rejects.toSatisfy((error: unknown) => error instanceof AggregateError && error.errors.some((cause) => cause instanceof DockerLifecycleError));
  });

  it('rejects a zero Created instant in normalized inspection input too', async () => {
    const created = inspection({ createdAt: '0001-01-01T00:00:00.000Z' });
    const responses = successfulResponses();
    responses[4] = { stdout: JSON.stringify(created) };
    const docker = fakeDocker(responses);
    await expect(createDockerExecutor(options(docker)).run()).rejects.toSatisfy((error: unknown) => error instanceof AggregateError && error.errors.some((cause) => cause instanceof DockerLifecycleError));
  });

  it('rejects a started final inspection with no Docker FinishedAt', async () => {
    const missingFinished = realisticRawInspection();
    missingFinished.State = { Status: 'exited', Running: false, StartedAt: '2026-07-24T10:00:01.500000000Z', FinishedAt: '0001-01-01T00:00:00.000000000Z', ExitCode: 0 };
    const responses = successfulResponses();
    responses[6] = { stdout: JSON.stringify(missingFinished) };
    const docker = fakeDocker(responses);
    await expect(createDockerExecutor(options(docker)).run()).rejects.toBeInstanceOf(DockerLifecycleError);
  });

  it('rejects an apparent successful exit when Docker proves the container never started', async () => {
    const stopped = { ...realisticRawInspection(), State: { Status: 'created', Running: false, StartedAt: '0001-01-01T00:00:00.000000000Z', FinishedAt: '0001-01-01T00:00:00.000000000Z', ExitCode: 0 } };
    const responses = successfulResponses({ exitCode: 0 });
    responses[4] = { stdout: JSON.stringify(realisticCreatedRawInspection()) };
    responses[6] = { stdout: JSON.stringify(stopped) };
    const docker = fakeDocker(responses);
    const result = await createDockerExecutor(options(docker)).run();
    expect(result).toMatchObject({ available: true, outcome: 'failed', mutationCount: 4 });
    const writes: RunnerWriteCommand[] = [];
    const ownership = { runnerWrite: vi.fn((command: RunnerWriteCommand) => { writes.push(command); return { ok: true }; }) };
    await createDockerExecutor(options(fakeDocker(responses), { ownership })).run();
    expect(writes.find((write): write is Extract<RunnerWriteCommand, { kind: 'operation-complete' }> => write.kind === 'operation-complete')?.input).toMatchObject({ errorCode: 'DOCKER_EXECUTION_DEFINITION_MISMATCH', error: { code: 'DOCKER_EXECUTION_DEFINITION_MISMATCH' } });
  });

  it('accounts for a real Docker created-state exec failure with exit 127', async () => {
    const failedCreated = realisticCreatedRawInspection();
    failedCreated.State = {
      Status: 'created',
      Running: false,
      ExitCode: 127,
      Error: 'OCI runtime exec failed: exec failed: unable to start container process: exec: "node": executable file not found in $PATH: unknown',
      StartedAt: '0001-01-01T00:00:00Z',
      FinishedAt: '0001-01-01T00:00:00Z',
    };
    const responses = successfulResponses({ exitCode: 1 });
    responses[5] = { exitCode: 1, signal: null, stdout: '', stderr: 'exec: "node": executable file not found in $PATH', timedOut: false, startedAt: '2026-07-24T10:00:01.000Z', finishedAt: '2026-07-24T10:00:01.100Z' };
    responses[6] = { stdout: JSON.stringify(failedCreated) };
    const docker = fakeDocker(responses);
    const writes: RunnerWriteCommand[] = [];
    let evidenceValue: Record<string, unknown> | undefined;
    const ownership = { runnerWrite: vi.fn((command: RunnerWriteCommand) => { writes.push(command); return { ok: true }; }) };
    const result = await createDockerExecutor(options(docker, { ownership, evidence: async (value) => { evidenceValue = value; return { path: 'evidence/operation-1.json', sha256: 'c'.repeat(64) }; } })).run();
    expect(result).toMatchObject({ available: true, outcome: 'failed', exitCode: 1, mutationCount: 4 });
    expect(writes.map((write) => write.kind)).toEqual(['operation-begin', 'container', 'operation-complete', 'operation-cleanup']);
    expect(writes.filter((write): write is Extract<RunnerWriteCommand, { kind: 'container' }> => write.kind === 'container').map((write) => write.lifecycle)).toEqual(['created']);
    const completion = writes.find((write): write is Extract<RunnerWriteCommand, { kind: 'operation-complete' }> => write.kind === 'operation-complete');
    expect(completion?.input).toMatchObject({ lifecyclePhase: 'created', outcome: 'failed', errorCode: 'DOCKER_EXECUTION_DEFINITION_MISMATCH' });
    expect(evidenceValue).toMatchObject({ inspection: { container: { dockerExitCode: 127 } }, command: { exitCode: 1 } });
    expect(writes.some((write) => write.kind === 'operation-cleanup')).toBe(true);
  });

  it('rejects a successful operation when Docker exit code differs from attach result', async () => {
    const stopped = { ...realisticRawInspection(), State: { Status: 'exited', Running: false, StartedAt: '2026-07-24T10:00:01.500000000Z', FinishedAt: '2026-07-24T10:00:02.500000000Z', ExitCode: 7 } };
    const responses = successfulResponses({ exitCode: 0 });
    responses[4] = { stdout: JSON.stringify(realisticCreatedRawInspection()) };
    responses[6] = { stdout: JSON.stringify(stopped) };
    const docker = fakeDocker(responses);
    const result = await createDockerExecutor(options(docker)).run();
    expect(result).toMatchObject({ available: true, outcome: 'failed' });
    const writes: RunnerWriteCommand[] = [];
    const ownership = { runnerWrite: vi.fn((command: RunnerWriteCommand) => { writes.push(command); return { ok: true }; }) };
    await createDockerExecutor(options(fakeDocker(responses), { ownership })).run();
    expect(writes.find((write): write is Extract<RunnerWriteCommand, { kind: 'operation-complete' }> => write.kind === 'operation-complete')?.input).toMatchObject({ errorCode: 'DOCKER_EXECUTION_DEFINITION_MISMATCH', error: { code: 'DOCKER_EXECUTION_DEFINITION_MISMATCH' } });
  });

  it.each([
    ['created-after-started', { Created: '2026-07-24T10:00:03.000000000Z', State: { Status: 'exited', Running: false, StartedAt: '2026-07-24T10:00:01.000000000Z', FinishedAt: '2026-07-24T10:00:02.000000000Z', ExitCode: 0 } }],
    ['finished-before-started', { Created: '2026-07-24T10:00:00.000000000Z', State: { Status: 'exited', Running: false, StartedAt: '2026-07-24T10:00:03.000000000Z', FinishedAt: '2026-07-24T10:00:02.000000000Z', ExitCode: 0 } }],
  ] as const)('rejects invalid Docker lifecycle chronology: %s', (_name, raw) => {
    const docker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
      { stdout: '' }, { stdout: `${'1'.repeat(64)}\n` }, { stdout: JSON.stringify({ ...realisticRawInspection(), ...raw }) },
    ]);
    return expect(createDockerExecutor(options(docker)).run()).rejects.toSatisfy((error: unknown) => error instanceof AggregateError && error.errors.some((cause) => cause instanceof DockerLifecycleError));
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
