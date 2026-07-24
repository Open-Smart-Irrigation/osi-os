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
import { CommandExecutionError, createCommandExecutor, type CommandResult, type CommandRunOptions } from '../../runner/src/command-executor.js';

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
      SOURCE_DATE_EPOCH: '1782208800',
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
        'SOURCE_DATE_EPOCH=1782208800',
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
    operationContext: { environment: 'full_raspberrypi_bcm27xx_bcm2712', installedToolPath: '/usr/local/libexec/osi-image-builder-tool' },
    operationTimeoutMs: 60_000,
    maxCaptureBytes: 16 * 1024,
    containerName: 'osi-image-builder-job-1-attempt-1',
    runner: { owner: 'runner-a', unit: 'osi-image-builder-runner@job-1.service', leaseExpiresAt: '2026-07-24T10:10:00.000Z', expectedState: 'starting' },
    ownership: { runnerWrite: vi.fn(() => ({ ok: true, kind: 'committed', eventSeq: 1 })), getJob: vi.fn(() => ({ containerId: null, containerName: null, containerImageDigest: null, containerLabelJobId: null, containerLabelManifestSha: null, containerLabels: null, containerMount: null, containerEnvironment: null, containerSecurity: null, containerInspection: null, containerCreatedAt: null })) },
    clock: () => NOW,
    evidence: async () => ({ path: 'evidence/operation-1.json', sha256: 'c'.repeat(64) }),
    logs: { runner: 'absent', docker: 'absent', verifiedAt: NOW },
    ...overrides,
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

describe('operation registry', () => {
  it('covers every trusted execution-definition operation and rejects unknown IDs', () => {
    expect(assertOperationRegistryCoverage(TRUSTED_OPERATION_IDS)).toBe(true);
    for (const operationId of TRUSTED_OPERATION_IDS) {
      const argv = createOperationArgv(operationId, { environment: 'full_raspberrypi_bcm27xx_bcm2712', installedToolPath: '/usr/local/libexec/osi-image-builder-tool' });
      expect(argv.length).toBeGreaterThan(0);
      expect(argv.some((part) => part.includes('&&') || part.includes(';') || part.includes('\n'))).toBe(false);
    }
    expect(() => createOperationArgv('unknown-operation' as 'verify-image', { environment: 'x', installedToolPath: '/tool' })).toThrow(/unknown operation/i);
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
      { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
      { exitCode: 1, signal: null, stdout: '', stderr: 'No such container: container-1\n', timedOut: false },
      { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
    ], trace);
    let persistedId: string | null = null;
    let clockTick = 0;
    const lifecycleCommands: Array<{ lifecycle: string; occurredAt: string; startedAt?: string | null; stoppedAt?: string | null }> = [];
    const ownership = { runnerWrite: vi.fn((command: { kind: string; containerId?: string; lifecycle?: string; occurredAt?: string; startedAt?: string | null; stoppedAt?: string | null }) => { trace.push(command.kind); if (command.kind === 'container') { persistedId = command.containerId ?? null; lifecycleCommands.push({ lifecycle: command.lifecycle ?? '', occurredAt: command.occurredAt ?? '', startedAt: command.startedAt, stoppedAt: command.stoppedAt }); } return { ok: true, kind: 'committed', eventSeq: 1 }; }), getJob: vi.fn(() => ({ containerId: persistedId, containerName: persistedId ? 'osi-image-builder-job-1-attempt-1' : null, containerImageDigest: persistedId ? DIGEST : null, containerLabelJobId: persistedId ? 'job-1' : null, containerLabelManifestSha: persistedId ? MANIFEST : null, containerLabels: persistedId ? { 'org.osi.image-builder.job-id': 'job-1', 'org.osi.image-builder.manifest-sha': MANIFEST } : null, containerMount: persistedId ? {} : null, containerEnvironment: persistedId ? {} : null, containerSecurity: persistedId ? {} : null, containerInspection: persistedId ? {} : null, containerCreatedAt: persistedId ? NOW : null })) };
    const result = await createDockerExecutor(options(docker, { ownership, clock: () => new Date(Date.parse(NOW) + clockTick++ * 1000).toISOString(), evidence: async () => { trace.push('evidence'); return { path: 'evidence/operation-1.json', sha256: 'c'.repeat(64) }; } })).run();

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
    expect(create?.filter((value) => value.startsWith('--mount=')).length).toBe(1);
    expect(create).toContain('--user=1000:1000');
    expect(create).toContain(`registry.example/builder@sha256:${DIGEST}`);
    expect(create).not.toContain('/var/run/docker.sock');
    const startIndex = docker.calls.findIndex((call) => call[1] === 'start');
    expect(docker.runOptions[startIndex]).toMatchObject({ timeoutMs: 60_000, maxCaptureBytes: 16 * 1024 });
    expect(docker.calls.map((call) => call[1])).toEqual(['version', 'image', 'ps', 'create', 'inspect', 'start', 'rm', 'inspect', 'ps']);
    expect(docker.calls.findIndex((call) => call[1] === 'rm')).toBeGreaterThan(docker.calls.findIndex((call) => call[1] === 'start'));
    expect(trace).toEqual(['docker:version', 'docker:image', 'docker:ps', 'operation-begin', 'docker:create', 'docker:inspect', 'container', 'docker:start', 'container', 'container', 'evidence', 'operation-complete', 'docker:rm', 'docker:inspect', 'docker:ps', 'operation-cleanup']);
    expect(trace.indexOf('operation-complete')).toBeLessThan(trace.indexOf('docker:rm'));
    expect(trace.indexOf('docker:inspect', trace.indexOf('docker:rm'))).toBeGreaterThan(trace.indexOf('docker:rm'));
    expect(trace.indexOf('docker:ps', trace.indexOf('docker:rm'))).toBeGreaterThan(trace.indexOf('docker:inspect', trace.indexOf('docker:rm')));
    expect(trace.indexOf('operation-cleanup')).toBeGreaterThan(trace.indexOf('docker:ps', trace.indexOf('docker:rm')));
    expect(lifecycleCommands.map((command) => command.lifecycle)).toEqual(['created', 'started', 'stopped']);
    expect(lifecycleCommands[1]).toMatchObject({ startedAt: '2026-07-24T10:00:01.500Z' });
    expect(lifecycleCommands[2]).toMatchObject({ startedAt: '2026-07-24T10:00:01.500Z', stoppedAt: '2026-07-24T10:00:02.500Z' });
    expect(Date.parse(lifecycleCommands[1]!.occurredAt)).toBeGreaterThanOrEqual(Date.parse(lifecycleCommands[1]!.startedAt!));
    expect(Date.parse(lifecycleCommands[2]!.occurredAt)).toBeGreaterThanOrEqual(Date.parse(lifecycleCommands[2]!.stoppedAt!));
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
      const ownership = { runnerWrite: vi.fn(() => ({ ok: true, kind: 'committed', eventSeq: 1 })), getJob: vi.fn(() => ({ containerId: null, containerName: null, containerImageDigest: null, containerLabelJobId: null, containerLabelManifestSha: null, containerLabels: null, containerMount: null, containerEnvironment: null, containerSecurity: null, containerInspection: null, containerCreatedAt: null })) };
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

  it('derives and executes registry argv, rejecting injected argv and noncanonical context', async () => {
    const docker = fakeDocker([
      { exitCode: 0, signal: null, stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}', stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }), stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: `${'1'.repeat(64)}\n`, stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: JSON.stringify([inspection()]), stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
      { exitCode: 1, signal: null, stdout: '', stderr: 'No such container: one\n', timedOut: false },
      { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
    ]);
    const injected = { ...options(docker), operationArgv: ['sh', '-c', 'echo injected'] };
    let persistedId: string | null = null;
    const ownership = { runnerWrite: vi.fn((command: { kind: string; containerId?: string }) => { if (command.kind === 'container') persistedId = command.containerId ?? null; return { ok: true, kind: 'committed', eventSeq: 1 }; }), getJob: vi.fn(() => ({ containerId: persistedId, containerName: persistedId ? 'osi-image-builder-job-1-attempt-1' : null, containerImageDigest: persistedId ? DIGEST : null, containerLabelJobId: persistedId ? 'job-1' : null, containerLabelManifestSha: persistedId ? MANIFEST : null, containerLabels: persistedId ? { 'org.osi.image-builder.job-id': 'job-1', 'org.osi.image-builder.manifest-sha': MANIFEST } : null, containerMount: persistedId ? {} : null, containerEnvironment: persistedId ? {} : null, containerSecurity: persistedId ? {} : null, containerInspection: persistedId ? {} : null, containerCreatedAt: persistedId ? NOW : null })) };
    await createDockerExecutor({ ...injected, ownership }).run();
    const create = docker.calls.find((call) => call[1] === 'create')!;
    expect(create.slice(-4)).toEqual([`registry.example/builder@sha256:${DIGEST}`, 'node', '/usr/local/libexec/osi-image-builder-tool', 'verify-image']);
    expect(() => createOperationArgv('verify-image', { environment: '../branch', installedToolPath: '/usr/local/../bin/tool' })).toThrow();
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
    const missingLogs = { ...options(docker) } as { logs?: DockerExecutorOptions['logs'] };
    delete missingLogs.logs;
    await expect(createDockerExecutor(missingEvidence as DockerExecutorOptions).run()).rejects.toThrow(/evidence/i);
    await expect(createDockerExecutor(missingLogs as DockerExecutorOptions).run()).rejects.toThrow(/log proof/i);
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
    const emptyIdentity = { containerId: null, containerName: null, containerImageDigest: null, containerLabelJobId: null, containerLabelManifestSha: null, containerLabels: null, containerMount: null, containerEnvironment: null, containerSecurity: null, containerInspection: null, containerCreatedAt: null };
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
    const ownership = { runnerWrite: vi.fn(() => ({ ok: true, kind: 'committed', eventSeq: 1 })), getJob: vi.fn(() => ({ containerId: null, containerName: null, containerImageDigest: null, containerLabelJobId: null, containerLabelManifestSha: null, containerLabels: null, containerMount: null, containerEnvironment: null, containerSecurity: null, containerInspection: null, containerCreatedAt: null })) };
    await expect(createDockerExecutor(options(docker, { ownership })).run()).rejects.toThrow(DockerLifecycleError);
    expect(docker.calls.map((call) => call[1])).toEqual(['version', 'image', 'ps', 'create', 'inspect', 'rm', 'inspect', 'ps']);
    expect(docker.calls.some((call) => call[1] === 'start')).toBe(false);
  });

  it('rejects with a controlled command error when an output callback throws', async () => {
    await expect(createCommandExecutor().run([process.execPath, '-e', 'process.stdout.write("output"); setTimeout(() => {}, 1000)'], { env: { PATH: process.env.PATH ?? '', HOME: '/tmp' }, timeoutMs: 5_000, onStdout: () => { throw new Error('observer failed'); } })).rejects.toMatchObject({ name: 'CommandExecutionError', result: expect.objectContaining({ stdout: 'output' }) });
  });
});

function emptyIdentityForTest() {
  return { containerId: null, containerName: null, containerImageDigest: null, containerLabelJobId: null, containerLabelManifestSha: null, containerLabels: null, containerMount: null, containerEnvironment: null, containerSecurity: null, containerInspection: null, containerCreatedAt: null };
}
