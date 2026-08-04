import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRUSTED_OPERATION_IDS } from '../../domain/types.js';
import {
  DockerCancellationRequestedError,
  DockerLifecycleError,
  createDockerContainerName,
  createDockerCancellationControls,
  createDockerExecutor,
  type DockerCommandExecutor,
  type DockerExecutorOptions,
  type DockerInspection,
  type PersistedContainerIdentity,
} from '../../runner/src/docker-executor.js';
import { CancellationBlockedError } from '../../runner/src/cancellation.js';
import { createOperationArgv, createOperationDefinition, assertOperationRegistryCoverage, INTERNAL_EXECUTION_GUARD_PATH, INTERNAL_OPERATION_TOOL_PATH } from '../../runner/src/operation-registry.js';
import { CommandExecutionError, createCommandExecutor, type CommandResult, type CommandRunOptions } from '../../runner/src/command-executor.js';
import type { JsonObject, OperationInput } from '../../api/src/store.js';
import type { OperationCleanupProof, RunnerWriteCommand } from '../../api/src/ownership.js';
import { encodeJson, normalizeCommand } from '../../api/src/validation.js';
import { assertActiveTargetLinks } from '../../runner/src/target-setup.js';
import {
  DEPENDENCY_EGRESS_CREDENTIAL_PATH,
  type DependencyEgressNetwork,
} from '../../runner/src/dependency-egress-proxy.js';
import { operationNetworkPolicy } from '../../runner/src/network-policy.js';

const DIGEST = 'a'.repeat(64);
const MANIFEST = 'b'.repeat(64);
const NOW = '2026-07-24T10:00:00.000Z';
const PI5_ENV = 'full_raspberrypi_bcm27xx_bcm2712';
const EGRESS_CREDENTIAL = Object.freeze({
  hostPath: '/tmp/credentials/build-image-1.proxy-credential',
  containerPath: DEPENDENCY_EGRESS_CREDENTIAL_PATH,
  sha256: 'd'.repeat(64),
});
const EGRESS_TLS_DIRECTORY_METADATA = Object.freeze({ mode: 0o700, uid: 1000, gid: 1000, device: 1, inode: 2 });
const egressTlsFileMetadata = (mode: number, hash: string, inode: number) => Object.freeze({ ...EGRESS_TLS_DIRECTORY_METADATA, mode, inode, sha256: hash.repeat(64), bytes: 1024, links: 1 });
const EGRESS_TLS = Object.freeze({
  hostDirectory: '/tmp/credentials/build-image-1.proxy-tls',
  directoryMetadata: EGRESS_TLS_DIRECTORY_METADATA,
  caCertificateHostPath: '/tmp/credentials/build-image-1.proxy-tls/ca.pem',
  caCertificateMetadata: egressTlsFileMetadata(0o444, '1', 3),
  leafCertificates: Object.freeze(Object.fromEntries(operationNetworkPolicy('build-image').allowedHosts.map((host, index) => [host, Object.freeze({ certificateHostPath: `/tmp/credentials/build-image-1.proxy-tls/${host.replaceAll('.', '_')}.pem`, keyHostPath: `/tmp/credentials/build-image-1.proxy-tls/${host.replaceAll('.', '_')}.key`, certificateMetadata: egressTlsFileMetadata(0o444, '2', 4 + index * 2), keyMetadata: egressTlsFileMetadata(0o400, '3', 5 + index * 2) })]))),
});
const EGRESS_RESOURCES: DependencyEgressNetwork = Object.freeze({
  network: Object.freeze({
    id: '2'.repeat(64),
    name: 'osi-image-builder-egress-caffb9743bde969d',
    internal: true,
    labels: Object.freeze({
      'org.osi.image-builder.egress-job-id': 'job-1',
      'org.osi.image-builder.egress-manifest-sha': MANIFEST,
      'org.osi.image-builder.egress-operation-id': 'build-image',
      'org.osi.image-builder.egress-attempt': '1',
      'org.osi.image-builder.egress-credential-sha': 'd'.repeat(64),
      'org.osi.image-builder.egress-role': 'network',
    }),
    proxyEndpointId: '3'.repeat(64),
    proxyAddress: '172.28.0.2',
  }),
  proxy: Object.freeze({
    id: '4'.repeat(64),
    name: 'osi-image-builder-egress-proxy-caffb9743bde969d',
    imageReference: `registry.example/builder@sha256:${DIGEST}`,
    imageId: `sha256:${'e'.repeat(64)}`,
    imageDigest: DIGEST,
    user: '1000:1000',
    labels: Object.freeze({
      'org.osi.image-builder.egress-job-id': 'job-1',
      'org.osi.image-builder.egress-manifest-sha': MANIFEST,
      'org.osi.image-builder.egress-operation-id': 'build-image',
      'org.osi.image-builder.egress-attempt': '1',
      'org.osi.image-builder.egress-credential-sha': 'd'.repeat(64),
      'org.osi.image-builder.egress-role': 'proxy',
    }),
    command: Object.freeze([
      'node',
      '/opt/osi-image-builder/operations/osi-dependency-egress-proxy.cjs',
    ]),
    internalEndpointId: '3'.repeat(64),
    internalAddress: '172.28.0.2',
    bridgeNetworkId: '5'.repeat(64),
    bridgeEndpointId: '6'.repeat(64),
    bridgeAddress: '172.17.0.8',
  }),
  credential: EGRESS_CREDENTIAL,
  tls: EGRESS_TLS,
  readiness: Object.freeze({
    authenticated: true,
    unauthenticatedStatus: 407,
    authenticatedStatus: 204,
    bridgeEndpointDenied: true,
  }),
  allowedHosts: operationNetworkPolicy('build-image').allowedHosts,
  networkName: 'osi-image-builder-egress-caffb9743bde969d',
  proxyName: 'osi-image-builder-egress-proxy-caffb9743bde969d',
});

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
    mounts: [{ type: 'bind', source: '/tmp/worktree', destination: '/workdir', readOnly: true }],
    user: '1000:1000',
    workingDir: '/workdir',
    networkMode: 'none',
    capDrop: ['ALL'],
    capAdd: [],
    privileged: false,
    devices: [],
    securityOpt: ['no-new-privileges:true'],
    pidsLimit: 4096,
    nanoCpus: 8_000_000_000,
    memoryBytes: 16 * 1024 * 1024 * 1024,
    memorySwapBytes: 16 * 1024 * 1024 * 1024,
    ulimits: [{ name: 'nofile', soft: 1024, hard: 4096 }],
    environment: {
      HOME: '/workdir/.builder-home',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      CARGO_BUILD_JOBS: '2',
      TZ: 'UTC',
      SOURCE_DATE_EPOCH: '1784887200',
    },
    readonlyRootfs: true,
    running: false,
    status: 'created',
    createdAt: '2026-07-24T09:59:59.000Z',
    startedAt: null,
    finishedAt: null,
    exitCode: 0,
    command: [
      'node',
      '/opt/osi-image-builder/operations/osi-image-builder-exec-guard.js',
      '--workspace-dev=35',
      '--workspace-ino=25383430',
      '--active-target-environment=root',
      '--operation-id=verify-image',
      `--operation-environment=${PI5_ENV}`,
      '--working-directory=/workdir',
      '--',
      'node',
      INTERNAL_OPERATION_TOOL_PATH,
      'verify-image',
    ],
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
      Cmd: inspection().command,
      Labels: {
        'org.osi.image-builder.job-id': 'job-1',
        'org.osi.image-builder.manifest-sha': MANIFEST,
      },
    },
    HostConfig: {
      NetworkMode: 'none',
      CapDrop: ['ALL'],
      CapAdd: null,
      Privileged: false,
      Devices: null,
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      PidsLimit: 4096,
      NanoCpus: 8_000_000_000,
      Memory: 16 * 1024 * 1024 * 1024,
      MemorySwap: 16 * 1024 * 1024 * 1024,
      Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 4096 }],
    },
    Mounts: [{ Type: 'bind', Source: '/tmp/worktree', Destination: '/workdir', RW: false }],
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

function rawInspectionWithContract(
  state: 'created' | 'exited',
  networkMode: 'bridge' | 'none',
  readOnly: boolean,
): Record<string, unknown> {
  const value = state === 'created' ? realisticCreatedRawInspection() : realisticRawInspection();
  const host = value.HostConfig as Record<string, unknown>;
  host.NetworkMode = networkMode;
  host.ReadonlyRootfs = readOnly;
  const mounts = value.Mounts as Array<Record<string, unknown>>;
  mounts[0]!.RW = !readOnly;
  return value;
}

function dependencyEgressRawInspection(state: 'created' | 'exited'): Record<string, unknown> {
  const value = rawInspectionWithContract(state, 'bridge', false);
  const host = value.HostConfig as Record<string, unknown>;
  host.NetworkMode = EGRESS_RESOURCES.network.name;
  const mounts = value.Mounts as Array<Record<string, unknown>>;
  mounts.push(
    { Type: 'bind', Source: EGRESS_CREDENTIAL.hostPath, Destination: EGRESS_CREDENTIAL.containerPath, RW: false },
    { Type: 'bind', Source: EGRESS_TLS.caCertificateHostPath, Destination: '/run/osi-image-builder/ca.pem', RW: false },
  );
  const config = value.Config as Record<string, unknown>;
  config.Env = [
    ...(config.Env as string[]),
    'HTTP_PROXY=http://osi-egress-proxy:3128',
    'HTTPS_PROXY=http://osi-egress-proxy:3128',
    'ALL_PROXY=http://osi-egress-proxy:3128',
    'NO_PROXY=',
    'http_proxy=http://osi-egress-proxy:3128',
    'https_proxy=http://osi-egress-proxy:3128',
    'all_proxy=http://osi-egress-proxy:3128',
    'no_proxy=',
    `OSI_EGRESS_PROXY_CREDENTIAL_FILE=${DEPENDENCY_EGRESS_CREDENTIAL_PATH}`,
    'OSI_EGRESS_CA_CERT_FILE=/run/osi-image-builder/ca.pem',
  ];
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
  const result: DockerExecutorOptions = {
    commandExecutor: executor,
    dockerPath: '/usr/bin/docker',
    imageReference: `registry.example/builder@sha256:${DIGEST}`,
    imageId: `sha256:${'e'.repeat(64)}`,
    imageDigest: DIGEST,
    jobId: 'job-1',
    manifestSha256: MANIFEST,
    attempt: 1,
    worktreePath: '/tmp/worktree',
    dependencyEgressCredentialDirectory: '/tmp/credentials',
    workspaceIdentity: { device: 35, inode: 25383430 },
    activeTargetEnvironment: null,
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
    authorizeContainerCreate: async (input) => {
      const authorization = ownershipWriter({
        kind: 'operation-begin',
        jobId: 'job-1',
        owner: input.lease.owner,
        runnerUnit: input.lease.unit,
        leaseExpiresAt: input.lease.leaseExpiresAt,
        at: input.startedAt,
        expectedState: input.lease.expectedState,
        operationId: input.operationId,
        attempt: input.attempt,
        argvHash: input.argvHash,
        argv: input.argv,
        startedAt: input.startedAt,
      });
      if (!authorization.ok) throw new Error('test create authorization was rejected');
      return { authorized: true };
    },
    ...rest,
  };
  if (result.cancellationBudget !== undefined && result.authorizeCancellation === undefined) {
    return {
      ...result,
      authorizeCancellation: async () => {
        const budget = result.cancellationBudget!();
        if (!budget.requested || budget.deadline === null) throw new Error('test cancellation authorization has no deadline');
        return { containerId: '1'.repeat(64), deadline: budget.deadline, running: true };
      },
    };
  }
  return result;
}

it('rejects an inspected image ID that differs from the admitted identity before container discovery', async () => {
  const docker = fakeDocker([
    { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
    { stdout: JSON.stringify({
      Id: `sha256:${'f'.repeat(64)}`,
      RepoDigests: [`registry.example/builder@sha256:${DIGEST}`],
      Architecture: 'amd64',
      Os: 'linux',
    }) },
  ]);
  const getJob = vi.fn(() => { throw new Error('store must not be read'); });

  await expect(createDockerExecutor(options(docker, {
    store: { getJob },
  })).run()).rejects.toThrow(/image ID|admitted identity/iu);

  expect(docker.calls.map((argv) => argv[1])).toEqual(['version', 'image']);
  expect(getJob).not.toHaveBeenCalled();
});

function cancellationBudgetWhen(
  requested: () => boolean,
  monotonic: () => number = () => performance.now(),
): () => Readonly<{ requested: boolean; deadline: number | null; remainingMs: number | null }> {
  let deadline: number | null = null;
  return () => {
    if (!requested()) return { requested: false, deadline: null, remainingMs: null };
    deadline ??= monotonic() + 30_000;
    return {
      requested: true,
      deadline,
      remainingMs: Math.max(0, Math.ceil(deadline - monotonic())),
    };
  };
}

interface FakeDockerResponseFields {
  readonly stdoutChunks?: readonly (Buffer | string)[];
  readonly stderrChunks?: readonly (Buffer | string)[];
}

type FakeDockerResponse = Error | (Partial<CommandResult> & FakeDockerResponseFields);

function fakeDocker(responses: ReadonlyArray<FakeDockerResponse>, trace?: string[]): DockerCommandExecutor & { calls: string[][]; runOptions: CommandRunOptions[] } {
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
      const result = {
        argv: [...argv],
        exitCode: response.exitCode === undefined ? 0 : response.exitCode,
        signal: response.signal === undefined ? null : response.signal,
        stdout: response.stdout ?? '',
        stderr: response.stderr ?? '',
        timedOut: response.timedOut ?? false,
        startedAt: response.startedAt ?? NOW,
        finishedAt: response.finishedAt ?? NOW,
      };
      if (argv[1] === 'inspect' && typeof result.stdout === 'string' && result.stdout.length > 0) {
        try {
          const inspected = JSON.parse(result.stdout) as { readonly Config?: Record<string, unknown> };
          if (inspected.Config !== undefined) {
            const create = calls.find((call) => call[1] === 'create' && call.includes('registry.example/builder@sha256:' + DIGEST) && !call.includes('--network=bridge'));
            const imageIndex = create?.findIndex((part) => part.startsWith('registry.example/builder@sha256:')) ?? -1;
            if (create !== undefined && imageIndex >= 0) {
              (inspected.Config as Record<string, unknown>).Cmd = create.slice(imageIndex + 1);
              result.stdout = JSON.stringify(inspected);
            }
          }
        } catch {
          // Non-JSON Docker responses are handled by the executor.
        }
      }
      const stdoutChunks = response.stdoutChunks ?? (response.stdout === undefined ? [] : [response.stdout]);
      const stderrChunks = response.stderrChunks ?? (response.stderr === undefined ? [] : [response.stderr]);
      for (const chunk of stdoutChunks) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
        try { options.onStdoutBytes?.(bytes); } catch (error) { throw new CommandExecutionError('fake Docker stdout observer failed', { result, cause: error }); }
        try { options.onStdout?.(bytes.toString('utf8')); } catch (error) { throw new CommandExecutionError('fake Docker stdout observer failed', { result, cause: error }); }
      }
      for (const chunk of stderrChunks) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
        try { options.onStderrBytes?.(bytes); } catch (error) { throw new CommandExecutionError('fake Docker stderr observer failed', { result, cause: error }); }
        try { options.onStderr?.(bytes.toString('utf8')); } catch (error) { throw new CommandExecutionError('fake Docker stderr observer failed', { result, cause: error }); }
      }
      return result;
    }),
  };
}

function successfulResponses(start: Partial<CommandResult> & FakeDockerResponseFields = {}): Array<FakeDockerResponse> {
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

  it.each(['copy-feed-config', 'update-feeds', 'verify-image', 'mirror-gui'] as const)('cannot derive %s helper argv from caller or worktree input', (operationId) => {
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
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('accepts the underscore job ID shape issued by the production API', async () => {
    const jobId = `job_${'a'.repeat(32)}`;
    const containerName = createDockerContainerName(jobId, 'verify-image', 1);
    const created = realisticCreatedRawInspection();
    const exited = realisticRawInspection();
    for (const value of [created, exited]) {
      value.Name = `/${containerName}`;
      const config = value.Config as Record<string, unknown>;
      const labels = config.Labels as Record<string, string>;
      labels['org.osi.image-builder.job-id'] = jobId;
    }
    const docker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
      { stdout: '' },
      { stdout: `${'1'.repeat(64)}\n` },
      { stdout: JSON.stringify(created) },
      { stdout: 'build output\n' },
      { stdout: JSON.stringify(exited) },
      { stdout: '' },
      { exitCode: 1, stderr: 'No such container: one\n' },
      { stdout: '' },
    ]);

    await expect(createDockerExecutor(options(docker, { jobId, containerName })).run())
      .resolves.toMatchObject({ available: true, outcome: 'passed' });
    expect(docker.calls.some((call) => call.includes(`--name=${containerName}`))).toBe(true);
    expect(docker.calls.some((call) => call.includes(`--label=org.osi.image-builder.job-id=${jobId}`)))
      .toBe(true);
  });

  it.each([
    `/proc/${String(process.pid)}/fd/29`,
    `/proc/${String(process.pid)}/fd/29/source`,
    '/proc/self/fd/29/source/openwrt',
    '/proc/thread-self/fd/29/source',
  ])('rejects runner-owned proc-fd path or descendant %s before Docker lifecycle mutation', async (procFdPath) => {
    const docker = fakeDocker([]);

    await expect(createDockerExecutor(options(docker, { worktreePath: procFdPath })).run())
      .rejects.toThrow(/canonical host pathname|worktree path/i);
    expect(docker.calls).toEqual([]);
  });

  it('runs the full Docker lifecycle with a normalized canonical worktree path containing spaces', async () => {
    const worktreePath = '/tmp/OSI image builder/release..candidate';
    const created = realisticCreatedRawInspection();
    const exited = realisticRawInspection();
    for (const value of [created, exited]) {
      const mounts = value.Mounts as Array<Record<string, unknown>>;
      mounts[0]!.Source = worktreePath;
    }
    const docker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
      { stdout: '' },
      { stdout: `${'1'.repeat(64)}\n` },
      { stdout: JSON.stringify(created) },
      { stdout: 'build output\n' },
      { stdout: JSON.stringify(exited) },
      { stdout: '' },
      { exitCode: 1, stderr: 'No such container: one\n' },
      { stdout: '' },
    ]);

    await expect(createDockerExecutor(options(docker, { worktreePath })).run())
      .resolves.toMatchObject({ available: true, outcome: 'passed' });
    expect(docker.calls.find((call) => call[1] === 'create')).toContain(
      `--mount=type=bind,source=${worktreePath},destination=/workdir,readonly`,
    );
  });

  it.each([
    ['relative', 'tmp/worktree'],
    ['NUL', '/tmp/work\0tree'],
    ['mount delimiter', '/tmp/work,tree'],
    ['duplicate slash', '/tmp//worktree'],
    ['dot segment', '/tmp/./worktree'],
    ['parent segment', '/tmp/child/../worktree'],
    ['trailing slash', '/tmp/worktree/'],
  ])('rejects %s worktree path before Docker lifecycle mutation', async (_name, worktreePath) => {
    const docker = fakeDocker([]);

    await expect(createDockerExecutor(options(docker, { worktreePath })).run())
      .rejects.toThrow(/canonical host pathname|worktree path/i);
    expect(docker.calls).toEqual([]);
  });

  it('stops cooperatively when cancellation arrives during attached Docker execution and waits for the child', async () => {
    const calls: string[][] = [];
    const trace: string[] = [];
    let inspectCount = 0;
    let attachStarted = false;
    let stopIssued = false;
    let removed = false;
    let releaseAttach: (() => void) | undefined;
    const commandExecutor: DockerCommandExecutor = {
      run: vi.fn(async (argv: readonly string[]) => {
        calls.push([...argv]);
        switch (argv[1]) {
          case 'version': return { argv: [...argv], exitCode: 0, signal: null, stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'image': return { argv: [...argv], exitCode: 0, signal: null, stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }), stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'ps': return { argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'create': return { argv: [...argv], exitCode: 0, signal: null, stdout: `${'1'.repeat(64)}\n`, stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'inspect': {
            if (removed) return { argv: [...argv], exitCode: 1, signal: null, stdout: '', stderr: 'No such container', timedOut: false, startedAt: NOW, finishedAt: NOW };
            const value = inspectCount++ === 0 ? realisticCreatedRawInspection() : realisticRawInspection();
            return { argv: [...argv], exitCode: 0, signal: null, stdout: JSON.stringify(value), stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          }
          case 'start':
            attachStarted = true;
            await new Promise<void>((resolve) => { releaseAttach = resolve; });
            trace.push('attach-resolved');
            return { argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'stop':
            stopIssued = true;
            trace.push('stop-resolved');
            releaseAttach?.();
            return { argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'rm':
            removed = true;
            return { argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          default: throw new Error(`unexpected Docker command ${argv.join(' ')}`);
        }
      }),
    };
    const writes: RunnerWriteCommand[] = [];
    const ownership = { runnerWrite: vi.fn((command: RunnerWriteCommand) => { writes.push(command); return { ok: true, kind: 'committed', eventSeq: writes.length }; }) };
    const cancellationBudget = cancellationBudgetWhen(() => attachStarted);
    const authorizeCancellation = vi.fn(async () => {
      trace.push('cancellation-authorized');
      const budget = cancellationBudget();
      if (budget.deadline === null) throw new Error('test cancellation deadline is unavailable');
      return { containerId: '1'.repeat(64), deadline: budget.deadline, running: true };
    });
    const run = createDockerExecutor(options(commandExecutor, {
      ownership,
      clock: () => '2026-07-24T10:00:10.000Z',
      cancellationBudget,
      authorizeCancellation,
      finalizeLogs: async ({ operationFinishedAt }) => ({ runner: 'absent', docker: 'absent', verifiedAt: operationFinishedAt }),
    })).run();

    await expect(run).rejects.toBeInstanceOf(DockerCancellationRequestedError);
    expect(stopIssued).toBe(true);
    expect(trace).toEqual(['cancellation-authorized', 'stop-resolved', 'attach-resolved']);
    expect(authorizeCancellation).toHaveBeenCalledOnce();
    expect(calls.map((call) => call[1])).toEqual(['version', 'image', 'ps', 'create', 'inspect', 'start', 'stop', 'inspect', 'rm', 'inspect', 'ps']);
    expect(calls.find((call) => call[1] === 'stop')).toEqual(['/usr/bin/docker', 'stop', '--time=30', '1'.repeat(64)]);
    expect(calls.some((call) => call[1] === 'kill')).toBe(false);
    expect(writes.map((command) => command.kind)).toContain('operation-complete');
    expect(writes.map((command) => command.kind)).toContain('operation-cleanup');
    expect(writes.findIndex((command) => command.kind === 'operation-complete'))
      .toBeLessThan(writes.findIndex((command) => command.kind === 'operation-cleanup'));
    const complete = writes.find((command): command is Extract<RunnerWriteCommand, { kind: 'operation-complete' }> => command.kind === 'operation-complete');
    expect(complete?.input).toMatchObject({ outcome: 'failed', errorCode: 'CANCELLED' });
  });

  it('removes dependency egress before committing cooperative cancellation cleanup', async () => {
    const calls: string[][] = [];
    const trace: string[] = [];
    const persistedIdentity = emptyIdentityForTest();
    const writes: RunnerWriteCommand[] = [];
    let createArgv: string[] = [];
    let inspectCount = 0;
    let attachStarted = false;
    let removed = false;
    let releaseAttach: (() => void) | undefined;
    const result = (argv: readonly string[], fields: Partial<CommandResult> = {}): CommandResult => ({
      argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false,
      startedAt: NOW, finishedAt: NOW, ...fields,
    });
    const inspected = (state: 'created' | 'exited'): string => {
      const value = dependencyEgressRawInspection(state);
      const imageIndex = createArgv.findIndex((part) => part === `registry.example/builder@sha256:${DIGEST}`);
      (value.Config as Record<string, unknown>).Cmd = createArgv.slice(imageIndex + 1);
      return JSON.stringify(value);
    };
    const commandExecutor: DockerCommandExecutor = {
      run: vi.fn(async (argv: readonly string[]) => {
        calls.push([...argv]);
        trace.push(`docker:${argv[1] ?? ''}`);
        switch (argv[1]) {
          case 'version': return result(argv, { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' });
          case 'image': return result(argv, { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) });
          case 'ps': return result(argv);
          case 'create':
            createArgv = [...argv];
            return result(argv, { stdout: `${'1'.repeat(64)}\n` });
          case 'inspect':
            if (removed) return result(argv, { exitCode: 1, stderr: 'No such container' });
            return result(argv, { stdout: inspected(inspectCount++ === 0 ? 'created' : 'exited') });
          case 'start':
            attachStarted = true;
            await new Promise<void>((resolve) => { releaseAttach = resolve; });
            return result(argv);
          case 'stop':
            releaseAttach?.();
            return result(argv);
          case 'rm':
            removed = true;
            return result(argv);
          default: throw new Error(`unexpected Docker command ${argv.join(' ')}`);
        }
      }),
    };
    const ownership = {
      runnerWrite: vi.fn((command: RunnerWriteCommand) => {
        writes.push(command);
        trace.push(`write:${command.kind}`);
        persistContainerWriteForTest(persistedIdentity, command);
        return { ok: true, kind: 'committed', eventSeq: writes.length };
      }),
    };
    const lifecycle = {
      recoverDocker: vi.fn(async () => ({ docker: [], credentials: [], globalLabelResult: 'no-match' as const })),
      discoverCredentials: vi.fn(async () => []),
      createCredential: vi.fn(async () => EGRESS_CREDENTIAL),
      createNetwork: vi.fn(async () => EGRESS_RESOURCES),
      destroyNetwork: vi.fn(async () => {
        trace.push('egress:destroy-network');
        return {
          proxy: { id: EGRESS_RESOURCES.proxy.id, absent: true as const },
          network: { id: EGRESS_RESOURCES.network.id, absent: true as const },
          tls: { hostDirectory: EGRESS_RESOURCES.tls.hostDirectory, absent: true as const },
          globalLabelResult: 'no-match' as const,
        };
      }),
      destroyCredential: vi.fn(async () => {
        trace.push('egress:destroy-credential');
        return { kind: 'normal' as const, hostPath: EGRESS_CREDENTIAL.hostPath, expectedSha256: EGRESS_CREDENTIAL.sha256, observedSha256: EGRESS_CREDENTIAL.sha256, tls: { hostDirectory: EGRESS_RESOURCES.tls.hostDirectory, absent: true as const }, absent: true as const };
      }),
    };

    await expect(createDockerExecutor(options(commandExecutor, {
      operationId: 'build-image',
      ownership,
      store: { getJob: () => persistedIdentity },
      dependencyEgressLifecycle: lifecycle,
      cancellationBudget: cancellationBudgetWhen(() => attachStarted),
    })).run()).rejects.toMatchObject({ recoveryRequired: false });

    expect(calls.map((call) => call[1])).toEqual(['version', 'image', 'ps', 'create', 'inspect', 'start', 'stop', 'inspect', 'rm', 'inspect', 'ps']);
    expect(trace.indexOf('write:operation-complete')).toBeLessThan(trace.indexOf('docker:rm'));
    expect(trace.indexOf('docker:rm')).toBeLessThan(trace.indexOf('egress:destroy-network'));
    expect(trace.indexOf('egress:destroy-network')).toBeLessThan(trace.indexOf('egress:destroy-credential'));
    expect(trace.indexOf('egress:destroy-credential')).toBeLessThan(trace.indexOf('write:operation-cleanup'));
    expect(writes.find((write) => write.kind === 'operation-cleanup')).toMatchObject({
      proof: {
        egress: {
          proxy: { id: EGRESS_RESOURCES.proxy.id, absent: true },
          network: { id: EGRESS_RESOURCES.network.id, absent: true },
          credential: { hostPath: EGRESS_CREDENTIAL.hostPath, sha256: EGRESS_CREDENTIAL.sha256, absent: true },
        },
      },
    });
    expect(persistedIdentity).toEqual(emptyIdentityForTest());
  });

  it('does not remove dependency egress when cooperative cancellation cannot prove builder absence', async () => {
    const persistedIdentity = emptyIdentityForTest();
    const writes: RunnerWriteCommand[] = [];
    let createArgv: string[] = [];
    let inspectCount = 0;
    let attachStarted = false;
    let removed = false;
    let releaseAttach: (() => void) | undefined;
    const result = (argv: readonly string[], fields: Partial<CommandResult> = {}): CommandResult => ({
      argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false,
      startedAt: NOW, finishedAt: NOW, ...fields,
    });
    const commandExecutor: DockerCommandExecutor = {
      run: vi.fn(async (argv: readonly string[]) => {
        switch (argv[1]) {
          case 'version': return result(argv, { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' });
          case 'image': return result(argv, { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) });
          case 'ps': return result(argv);
          case 'create':
            createArgv = [...argv];
            return result(argv, { stdout: `${'1'.repeat(64)}\n` });
          case 'inspect': {
            const value = dependencyEgressRawInspection(removed ? 'exited' : inspectCount++ === 0 ? 'created' : 'exited');
            const imageIndex = createArgv.findIndex((part) => part === `registry.example/builder@sha256:${DIGEST}`);
            (value.Config as Record<string, unknown>).Cmd = createArgv.slice(imageIndex + 1);
            return result(argv, { stdout: JSON.stringify(value) });
          }
          case 'start':
            attachStarted = true;
            await new Promise<void>((resolve) => { releaseAttach = resolve; });
            return result(argv);
          case 'stop':
            releaseAttach?.();
            return result(argv);
          case 'rm':
            removed = true;
            return result(argv);
          default: throw new Error(`unexpected Docker command ${argv.join(' ')}`);
        }
      }),
    };
    const ownership = {
      runnerWrite: vi.fn((command: RunnerWriteCommand) => {
        writes.push(command);
        persistContainerWriteForTest(persistedIdentity, command);
        return { ok: true, kind: 'committed', eventSeq: writes.length };
      }),
    };
    const destroyNetwork = vi.fn(async () => ({
      proxy: { id: EGRESS_RESOURCES.proxy.id, absent: true as const },
      network: { id: EGRESS_RESOURCES.network.id, absent: true as const },
      tls: { hostDirectory: EGRESS_RESOURCES.tls.hostDirectory, absent: true as const },
      globalLabelResult: 'no-match' as const,
    }));
    const destroyCredential = vi.fn(async () => ({ kind: 'normal' as const, hostPath: EGRESS_CREDENTIAL.hostPath, expectedSha256: EGRESS_CREDENTIAL.sha256, observedSha256: EGRESS_CREDENTIAL.sha256, tls: { hostDirectory: EGRESS_RESOURCES.tls.hostDirectory, absent: true as const }, absent: true as const }));

    await expect(createDockerExecutor(options(commandExecutor, {
      operationId: 'build-image',
      ownership,
      store: { getJob: () => persistedIdentity },
      dependencyEgressLifecycle: {
        recoverDocker: vi.fn(async () => ({ docker: [], credentials: [], globalLabelResult: 'no-match' as const })),
        discoverCredentials: vi.fn(async () => []),
        createCredential: vi.fn(async () => EGRESS_CREDENTIAL),
        createNetwork: vi.fn(async () => EGRESS_RESOURCES),
        destroyNetwork,
        destroyCredential,
      },
      cancellationBudget: cancellationBudgetWhen(() => attachStarted),
    })).run()).rejects.toThrow(/did not prove exact container absence/i);

    expect(destroyNetwork).not.toHaveBeenCalled();
    expect(destroyCredential).not.toHaveBeenCalled();
    expect(writes.some((write) => write.kind === 'operation-complete')).toBe(true);
    expect(writes.some((write) => write.kind === 'operation-cleanup')).toBe(false);
    expect(persistedIdentity).toMatchObject({
      containerId: '1'.repeat(64),
      containerSecurity: { egress: EGRESS_RESOURCES },
    });
  });

  it('issues no Docker stop or remove when active-operation authorization is denied', async () => {
    let attachStarted = false;
    let releaseAttach: (() => void) | undefined;
    let inspectCount = 0;
    const calls: string[][] = [];
    const commandExecutor: DockerCommandExecutor = {
      run: vi.fn(async (argv: readonly string[]) => {
        calls.push([...argv]);
        switch (argv[1]) {
          case 'version': return { argv: [...argv], exitCode: 0, signal: null, stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'image': return { argv: [...argv], exitCode: 0, signal: null, stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }), stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'ps': return { argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'create': return { argv: [...argv], exitCode: 0, signal: null, stdout: `${'1'.repeat(64)}\n`, stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'inspect': return { argv: [...argv], exitCode: 0, signal: null, stdout: JSON.stringify(inspectCount++ === 0 ? realisticCreatedRawInspection() : realisticRawInspection()), stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'start':
            attachStarted = true;
            await new Promise<void>((resolve) => { releaseAttach = resolve; });
            return { argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          default: throw new Error(`unexpected Docker command ${argv.join(' ')}`);
        }
      }),
    };
    const cancellationBudget = cancellationBudgetWhen(() => attachStarted);
    const authorizeCancellation = vi.fn(async () => {
      releaseAttach?.();
      throw new CancellationBlockedError('runner cancellation transition lost its CAS', 'RUNNER_DISAPPEARED');
    });

    await expect(createDockerExecutor(options(commandExecutor, {
      cancellationBudget,
      authorizeCancellation,
    })).run()).rejects.toMatchObject({
      recoveryRequired: true,
      blockerCode: 'RUNNER_DISAPPEARED',
    });
    expect(authorizeCancellation).toHaveBeenCalledOnce();
    expect(calls.some((call) => call[1] === 'stop' || call[1] === 'rm')).toBe(false);
  });

  it('starts the full cooperative budget when cancellation arrives after an operation has run longer than 30 seconds', async () => {
    let monotonic = 0;
    let attachStarted = false;
    let releaseAttach: (() => void) | undefined;
    let inspectCount = 0;
    let removed = false;
    const commandExecutor: DockerCommandExecutor = {
      run: vi.fn(async (argv: readonly string[]) => {
        switch (argv[1]) {
          case 'version': return { argv: [...argv], exitCode: 0, signal: null, stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'image': return { argv: [...argv], exitCode: 0, signal: null, stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }), stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'ps': return { argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'create': return { argv: [...argv], exitCode: 0, signal: null, stdout: `${'1'.repeat(64)}\n`, stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'inspect': return removed
            ? { argv: [...argv], exitCode: 1, signal: null, stdout: '', stderr: 'No such container', timedOut: false, startedAt: NOW, finishedAt: NOW }
            : { argv: [...argv], exitCode: 0, signal: null, stdout: JSON.stringify(inspectCount++ === 0 ? realisticCreatedRawInspection() : realisticRawInspection()), stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'start':
            attachStarted = true;
            monotonic = 120_000;
            await new Promise<void>((resolve) => { releaseAttach = resolve; });
            return { argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'stop':
            releaseAttach?.();
            return { argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'rm':
            removed = true;
            return { argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          default: throw new Error(`unexpected Docker command ${argv.join(' ')}`);
        }
      }),
    };

    const cancellationBudget = cancellationBudgetWhen(() => attachStarted, () => monotonic);
    const run = createDockerExecutor(options(commandExecutor, {
      monotonicNow: () => monotonic,
      cancellationBudget,
      authorizeCancellation: async () => {
        const budget = cancellationBudget();
        if (budget.deadline === null) throw new Error('test cancellation deadline is unavailable');
        monotonic += 10_000;
        return { containerId: '1'.repeat(64), deadline: budget.deadline, running: true };
      },
    })).run();

    await expect(run).rejects.toBeInstanceOf(DockerCancellationRequestedError);
    const stopCallIndex = vi.mocked(commandExecutor.run).mock.calls.findIndex(([argv]) => argv[1] === 'stop');
    expect(vi.mocked(commandExecutor.run).mock.calls[stopCallIndex]?.[1]).toMatchObject({ timeoutMs: 20_000 });
  });

  it('leaves a cancellation first observed after attach completion to the operation boundary', async () => {
    const cancellationRequested = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const docker = fakeDocker(successfulResponses());

    await expect(createDockerExecutor(options(docker, {
      cancellationBudget: cancellationBudgetWhen(cancellationRequested),
    })).run()).resolves.toMatchObject({
      available: true,
      outcome: 'passed',
    });
    expect(docker.calls.some((call) => call[1] === 'stop')).toBe(false);
    expect(docker.calls.some((call) => call[1] === 'rm')).toBe(true);
  });

  it('returns cancellation recovery-required evidence when the attached Docker child exceeds the shared deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let attachStarted = false;
    let inspectCount = 0;
    let startOptions: CommandRunOptions | undefined;
    let releaseAttach: (() => void) | undefined;
    const writes: RunnerWriteCommand[] = [];
    const onStdout = vi.fn();
    const onStdoutBytes = vi.fn();
    const persistCancellationBlocker = vi.fn(async () => undefined);
    const commandExecutor: DockerCommandExecutor = {
      run: vi.fn(async (argv: readonly string[], runOptions: CommandRunOptions) => {
        switch (argv[1]) {
          case 'version': return { argv: [...argv], exitCode: 0, signal: null, stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'image': return { argv: [...argv], exitCode: 0, signal: null, stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }), stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'ps': return { argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'create': return { argv: [...argv], exitCode: 0, signal: null, stdout: `${'1'.repeat(64)}\n`, stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'inspect': return { argv: [...argv], exitCode: 0, signal: null, stdout: JSON.stringify(inspectCount++ === 0 ? realisticCreatedRawInspection() : realisticRawInspection()), stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'start':
            attachStarted = true;
            startOptions = runOptions;
            runOptions.onStdoutBytes?.(Buffer.from([0xff, 0x00]));
            await new Promise<void>((resolve) => { releaseAttach = resolve; });
            return { argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'stop':
            return { argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          default: throw new Error(`unexpected Docker command ${argv.join(' ')}`);
        }
      }),
    };
    const run = createDockerExecutor(options(commandExecutor, {
      cancellationBudget: () => ({
        requested: attachStarted,
        deadline: attachStarted ? 30_000 : null,
        remainingMs: attachStarted ? 30_000 : null,
      }),
      monotonicNow: () => Date.now(),
      onStdout,
      onStdoutBytes,
      persistCancellationBlocker,
      ownership: { runnerWrite: vi.fn((command: RunnerWriteCommand) => { writes.push(command); return { ok: true, kind: 'committed', eventSeq: writes.length }; }) },
    })).run();
    let settled = false;
    void run.then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(30_100);
    await Promise.resolve();

    expect(onStdoutBytes).toHaveBeenCalledWith(Buffer.from([0xff, 0x00]));
    expect(vi.mocked(commandExecutor.run).mock.calls.filter(([, runOptions]) => runOptions.onStdoutBytes !== undefined).map(([argv]) => argv[1])).toEqual(['start']);
    onStdoutBytes.mockClear();
    expect(settled).toBe(false);
    expect(writes).toContainEqual(expect.objectContaining({
      kind: 'operation-complete',
      input: expect.objectContaining({ outcome: 'failed', errorCode: 'DOCKER_CONTAINER_ORPHANED' }),
    }));
    expect(writes.filter((write) => write.kind === 'operation-complete')).toHaveLength(1);
    expect(persistCancellationBlocker).toHaveBeenCalledOnce();
    expect(vi.mocked(commandExecutor.run).mock.calls.some(([argv]) => argv[1] === 'kill')).toBe(false);
    expect(vi.mocked(commandExecutor.run).mock.calls.some(([argv]) => argv[1] === 'rm')).toBe(false);
    expect(writes.some((write) => write.kind === 'operation-cleanup')).toBe(false);
    startOptions?.onStdout?.('late child output');
    startOptions?.onStdoutBytes?.(Buffer.from([0xff]));
    expect(onStdout).not.toHaveBeenCalled();
    expect(onStdoutBytes).not.toHaveBeenCalled();
    releaseAttach?.();
    await expect(run).rejects.toMatchObject({
      code: 'DOCKER_CONTAINER_ORPHANED',
      recoveryRequired: true,
      recoveryPersisted: true,
    });
    expect(writes.filter((write) => write.kind === 'operation-complete')).toHaveLength(1);
    expect(persistCancellationBlocker).toHaveBeenCalledOnce();
  });

  it('still awaits the attached child when deadline blocker persistence fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let attachStarted = false;
    let inspectCount = 0;
    let releaseAttach: (() => void) | undefined;
    const commandExecutor: DockerCommandExecutor = {
      run: vi.fn(async (argv: readonly string[]) => {
        switch (argv[1]) {
          case 'version': return { argv: [...argv], exitCode: 0, signal: null, stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'image': return { argv: [...argv], exitCode: 0, signal: null, stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }), stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'ps': return { argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'create': return { argv: [...argv], exitCode: 0, signal: null, stdout: `${'1'.repeat(64)}\n`, stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'inspect': return { argv: [...argv], exitCode: 0, signal: null, stdout: JSON.stringify(inspectCount++ === 0 ? realisticCreatedRawInspection() : realisticRawInspection()), stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'start':
            attachStarted = true;
            await new Promise<void>((resolve) => { releaseAttach = resolve; });
            return { argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'stop':
            return { argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          default: throw new Error(`unexpected Docker command ${argv.join(' ')}`);
        }
      }),
    };
    const persistCancellationBlocker = vi.fn(async () => {
      throw new Error('blocker persistence unavailable');
    });
    const run = createDockerExecutor(options(commandExecutor, {
      cancellationBudget: () => ({
        requested: attachStarted,
        deadline: attachStarted ? 30_000 : null,
        remainingMs: attachStarted ? Math.max(0, 30_000 - Date.now()) : null,
      }),
      monotonicNow: () => Date.now(),
      persistCancellationBlocker,
    })).run();
    let settled = false;
    void run.then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(30_100);
    await Promise.resolve();

    expect(persistCancellationBlocker).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    releaseAttach?.();
    await expect(run).rejects.toMatchObject({
      code: 'DOCKER_CONTAINER_ORPHANED',
      recoveryRequired: true,
      recoveryPersisted: false,
    });
  });

  it('commits operation evidence and returns Docker orphan recovery when cooperative stop fails', async () => {
    const trace: string[] = [];
    let attachStarted = false;
    let releaseAttach: (() => void) | undefined;
    let inspectCount = 0;
    const writes: RunnerWriteCommand[] = [];
    const commandExecutor: DockerCommandExecutor = {
      run: vi.fn(async (argv: readonly string[]) => {
        trace.push(`docker:${argv[1]}`);
        switch (argv[1]) {
          case 'version': return { argv: [...argv], exitCode: 0, signal: null, stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'image': return { argv: [...argv], exitCode: 0, signal: null, stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }), stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'ps': return { argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'create': return { argv: [...argv], exitCode: 0, signal: null, stdout: `${'1'.repeat(64)}\n`, stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'inspect': return { argv: [...argv], exitCode: 0, signal: null, stdout: JSON.stringify(inspectCount++ === 0 ? realisticCreatedRawInspection() : realisticRawInspection()), stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'start':
            attachStarted = true;
            await new Promise<void>((resolve) => { releaseAttach = resolve; });
            return { argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'stop':
            releaseAttach?.();
            return { argv: [...argv], exitCode: 1, signal: null, stdout: '', stderr: 'daemon stop failed', timedOut: false, startedAt: NOW, finishedAt: NOW };
          default: throw new Error(`unexpected Docker command ${argv.join(' ')}`);
        }
      }),
    };
    const run = createDockerExecutor(options(commandExecutor, {
      cancellationBudget: cancellationBudgetWhen(() => attachStarted),
      ownership: {
        runnerWrite: vi.fn((command: RunnerWriteCommand) => {
          writes.push(command);
          trace.push(`ownership:${command.kind}`);
          return { ok: true, kind: 'committed', eventSeq: writes.length };
        }),
      },
    })).run();

    await expect(run).rejects.toMatchObject({
      code: 'DOCKER_CONTAINER_ORPHANED',
      recoveryRequired: true,
    });
    const completion = writes.find(
      (command): command is Extract<RunnerWriteCommand, { kind: 'operation-complete' }> => command.kind === 'operation-complete',
    );
    expect(completion?.input).toMatchObject({
      outcome: 'failed',
      errorCode: 'DOCKER_CONTAINER_ORPHANED',
      lifecyclePhase: 'stopped',
    });
    expect(trace.indexOf('docker:stop')).toBeLessThan(trace.lastIndexOf('docker:inspect'));
    expect(trace.lastIndexOf('docker:inspect')).toBeLessThan(trace.indexOf('ownership:operation-complete'));
    expect(trace.some((entry) => entry === 'docker:kill' || entry === 'docker:rm')).toBe(false);
  });

  it('rejects cancellation control inspection when the exact image digest differs', async () => {
    const raw = realisticRawInspection();
    (raw.Config as Record<string, unknown>).Image = `registry.example/builder@sha256:${'f'.repeat(64)}`;
    const docker = fakeDocker([{ stdout: JSON.stringify(raw) }]);
    const controls = createDockerCancellationControls({
      commandExecutor: docker,
      dockerPath: '/usr/bin/docker',
      expectedImageDigest: DIGEST,
      maxCaptureBytes: 16 * 1024,
    });

    await expect(controls.inspect('1'.repeat(64), performance.now() + 30_000)).rejects.toThrow(/image digest/i);
  });

  it.each([
    ['an extra label', [
      {
        id: '1'.repeat(64),
        labels: {
          'org.osi.image-builder.job-id': 'job-1',
          'org.osi.image-builder.manifest-sha': MANIFEST,
          'org.example.unexpected': 'present',
        },
      },
    ]],
    ['a wrong manifest label', [
      {
        id: '1'.repeat(64),
        labels: {
          'org.osi.image-builder.job-id': 'job-1',
          'org.osi.image-builder.manifest-sha': 'f'.repeat(64),
        },
      },
    ]],
    ['multiple job-labeled objects', [
      {
        id: '1'.repeat(64),
        labels: {
          'org.osi.image-builder.job-id': 'job-1',
          'org.osi.image-builder.manifest-sha': MANIFEST,
        },
      },
      {
        id: '2'.repeat(64),
        labels: {
          'org.osi.image-builder.job-id': 'job-1',
          'org.osi.image-builder.manifest-sha': 'f'.repeat(64),
          'org.example.unexpected': 'present',
        },
      },
    ]],
  ] as const)('returns every container carrying the job label when it has %s', async (_case, values) => {
    const calls: string[][] = [];
    const commandExecutor: DockerCommandExecutor = {
      run: vi.fn(async (argv: readonly string[]) => {
        calls.push([...argv]);
        if (argv[1] === 'ps') {
          return {
            argv: [...argv],
            exitCode: 0,
            signal: null,
            stdout: `${values.map(({ id }) => id).join('\n')}\n`,
            stderr: '',
            timedOut: false,
            startedAt: NOW,
            finishedAt: NOW,
          };
        }
        if (argv[1] === 'inspect') {
          const id = argv.at(-1);
          const item = values.find((candidate) => candidate.id === id);
          if (item === undefined) throw new Error(`unexpected inspect ID ${String(id)}`);
          const raw = realisticRawInspection();
          raw.Id = item.id;
          (raw.Config as Record<string, unknown>).Labels = item.labels;
          return {
            argv: [...argv],
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify(raw),
            stderr: '',
            timedOut: false,
            startedAt: NOW,
            finishedAt: NOW,
          };
        }
        throw new Error(`unexpected Docker cancellation command: ${argv.join(' ')}`);
      }),
    };
    const controls = createDockerCancellationControls({
      commandExecutor,
      dockerPath: '/usr/bin/docker',
      expectedImageDigest: DIGEST,
      maxCaptureBytes: 16 * 1024,
    });
    const expectedLabels = {
      'org.osi.image-builder.job-id': 'job-1',
      'org.osi.image-builder.manifest-sha': MANIFEST,
    };

    await expect(controls.listByLabels(expectedLabels, performance.now() + 30_000)).resolves.toHaveLength(values.length);
    const list = calls.find((argv) => argv[1] === 'ps');
    expect(list).toContain('--filter=label=org.osi.image-builder.job-id=job-1');
    expect(list).not.toContain(`--filter=label=org.osi.image-builder.manifest-sha=${MANIFEST}`);
  });

  it('uses one supplied absolute deadline after time spent in label and inspect controls', async () => {
    let monotonic = 5_000;
    const calls: Array<{ argv: readonly string[]; timeoutMs: number }> = [];
    const commandExecutor: DockerCommandExecutor = {
      run: vi.fn(async (argv: readonly string[], runOptions: CommandRunOptions) => {
        calls.push({ argv: [...argv], timeoutMs: runOptions.timeoutMs ?? -1 });
        if (argv[1] === 'ps') {
          monotonic += 7_000;
          return {
            argv: [...argv],
            exitCode: 0,
            signal: null,
            stdout: `${'1'.repeat(64)}\n`,
            stderr: '',
            timedOut: false,
            startedAt: NOW,
            finishedAt: NOW,
          };
        }
        if (argv[1] === 'inspect') {
          return {
            argv: [...argv],
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify(realisticRawInspection()),
            stderr: '',
            timedOut: false,
            startedAt: NOW,
            finishedAt: NOW,
          };
        }
        if (argv[1] === 'stop') {
          return {
            argv: [...argv],
            exitCode: 0,
            signal: null,
            stdout: '',
            stderr: '',
            timedOut: false,
            startedAt: NOW,
            finishedAt: NOW,
          };
        }
        throw new Error(`unexpected Docker cancellation command: ${argv.join(' ')}`);
      }),
    };
    const controls = createDockerCancellationControls({
      commandExecutor,
      dockerPath: '/usr/bin/docker',
      expectedImageDigest: DIGEST,
      maxCaptureBytes: 16 * 1024,
      monotonicNow: () => monotonic,
    });
    const labels = {
      'org.osi.image-builder.job-id': 'job-1',
      'org.osi.image-builder.manifest-sha': MANIFEST,
    };
    const deadline = 35_000;
    const listByDeadline = controls.listByLabels as unknown as (
      value: JsonObject,
      absoluteDeadline: number,
    ) => ReturnType<typeof controls.listByLabels>;
    const waitByDeadline = controls.waitForStopped as unknown as (
      containerId: string,
      absoluteDeadline: number,
    ) => ReturnType<typeof controls.waitForStopped>;

    await expect(listByDeadline(labels, deadline)).resolves.toHaveLength(1);
    await expect(controls.stop('1'.repeat(64), deadline)).resolves.toBeUndefined();
    await expect(waitByDeadline('1'.repeat(64), deadline)).resolves.toMatchObject({
      running: false,
    });
    expect(calls.map(({ argv, timeoutMs }) => [argv[1], timeoutMs])).toEqual([
      ['ps', 30_000],
      ['inspect', 23_000],
      ['stop', 23_000],
      ['inspect', 23_000],
    ]);
  });

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
    expect(create).toContain('--network=none');
    expect(create).toContain('--cap-drop=ALL');
    expect(create).toContain('--security-opt=no-new-privileges:true');
    expect(create).toContain('--pids-limit=4096');
    expect(create).toContain('--cpus=8');
    expect(create).toContain('--memory=16g');
    expect(create).toContain('--memory-swap=16g');
    expect(create).toContain('--ulimit=nofile=1024:4096');
    const mountArg = create?.find((value) => value.startsWith('--mount='));
    expect(mountArg).toBe('--mount=type=bind,source=/tmp/worktree,destination=/workdir,readonly');
    expect(mountArg).toBeDefined();
    const mountSegments = mountArg!.slice('--mount='.length).split(',');
    expect(mountSegments).toEqual([
      'type=bind',
      'source=/tmp/worktree',
      'destination=/workdir',
      'readonly',
    ]);
    expect(mountSegments).not.toContain('rw');
    expect(create).toContain('--read-only');
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

  it('commits bounded output evidence when a successful Docker command emits more than the JSON limit', async () => {
    const fullStdout = 'x'.repeat(70_000);
    const fullStderr = 'y'.repeat(70_000);
    const stdoutTail = Buffer.from(fullStdout).subarray(fullStdout.length - 16 * 1024).toString('utf8');
    const stderrTail = Buffer.from(fullStderr).subarray(fullStderr.length - 16 * 1024).toString('utf8');
    const responses = successfulResponses({
      stdout: stdoutTail,
      stderr: stderrTail,
      stdoutChunks: [fullStdout],
      stderrChunks: [fullStderr],
    });
    const docker = fakeDocker(responses);
    let evidenceValue: JsonObject | undefined;
    let encodedEvidence = '';
    const writes: RunnerWriteCommand[] = [];
    const durableStdout = vi.fn();
    const durableStderr = vi.fn();
    const ownership = {
      runnerWrite: vi.fn((command: RunnerWriteCommand) => {
        writes.push(command);
        return { ok: true, kind: 'committed', eventSeq: writes.length };
      }),
    };

    await expect(createDockerExecutor(options(docker, {
      ownership,
      evidence: async (value) => {
        evidenceValue = value;
        encodedEvidence = encodeJson(value, 'operation evidence', true);
        return { path: 'evidence/operation-large-output.json', sha256: 'c'.repeat(64) };
      },
      onStdoutBytes: durableStdout,
      onStderrBytes: durableStderr,
    })).run()).resolves.toMatchObject({ outcome: 'passed' });

    const command = evidenceValue?.command as Record<string, unknown>;
    expect(Buffer.byteLength(encodedEvidence, 'utf8')).toBeLessThanOrEqual(65_536);
    expect(encodedEvidence).not.toContain(fullStdout);
    expect(encodedEvidence).not.toContain(fullStderr);
    expect(command.stdout).toMatchObject({
      bytes: Buffer.byteLength(fullStdout),
      sha256: createHash('sha256').update(fullStdout).digest('hex'),
      capturedBytes: Buffer.byteLength(stdoutTail),
      capturedSha256: createHash('sha256').update(stdoutTail).digest('hex'),
      captureLimitBytes: 16 * 1024,
      complete: true,
      truncated: true,
    });
    expect(command.stderr).toMatchObject({
      bytes: Buffer.byteLength(fullStderr),
      sha256: createHash('sha256').update(fullStderr).digest('hex'),
      capturedBytes: Buffer.byteLength(stderrTail),
      capturedSha256: createHash('sha256').update(stderrTail).digest('hex'),
      captureLimitBytes: 16 * 1024,
      complete: true,
      truncated: true,
    });
    expect(durableStdout).toHaveBeenCalledWith(Buffer.from(fullStdout));
    expect(durableStderr).toHaveBeenCalledWith(Buffer.from(fullStderr));
    expect(writes.some((write) => write.kind === 'operation-complete')).toBe(true);
    expect(writes.some((write) => write.kind === 'operation-cleanup')).toBe(true);
  });

  it('records complete empty output with stable empty hashes', async () => {
    const docker = fakeDocker(successfulResponses({ stdout: '', stderr: '', stdoutChunks: [], stderrChunks: [] }));
    let evidenceValue: JsonObject | undefined;

    await expect(createDockerExecutor(options(docker, {
      evidence: async (value) => {
        evidenceValue = value;
        encodeJson(value, 'operation evidence', true);
        return { path: 'evidence/operation-empty-output.json', sha256: 'c'.repeat(64) };
      },
    })).run()).resolves.toMatchObject({ outcome: 'passed' });

    const command = evidenceValue?.command as Record<string, unknown>;
    expect(command.stdout).toEqual({
      bytes: 0,
      sha256: createHash('sha256').update('').digest('hex'),
      capturedBytes: 0,
      capturedSha256: createHash('sha256').update('').digest('hex'),
      captureLimitBytes: 16 * 1024,
      complete: true,
      truncated: false,
    });
    expect(command.stderr).toEqual(command.stdout);
  });

  it('hashes exact streamed bytes when UTF-8 output arrives in split chunks', async () => {
    const euro = Buffer.from('\u20ac', 'utf8');
    const docker = fakeDocker(successfulResponses({
      stdout: '\u20ac',
      stdoutChunks: [euro.subarray(0, 1), euro.subarray(1, 2), euro.subarray(2)],
      stderr: '',
      stderrChunks: [],
    }));
    let evidenceValue: JsonObject | undefined;
    const durableBytes: Buffer[] = [];

    await expect(createDockerExecutor(options(docker, {
      evidence: async (value) => {
        evidenceValue = value;
        encodeJson(value, 'operation evidence', true);
        return { path: 'evidence/operation-split-utf8.json', sha256: 'c'.repeat(64) };
      },
      onStdoutBytes: (chunk) => { durableBytes.push(chunk); },
    })).run()).resolves.toMatchObject({ outcome: 'passed' });

    const command = evidenceValue?.command as Record<string, unknown>;
    expect(command.stdout).toMatchObject({
      bytes: euro.byteLength,
      sha256: createHash('sha256').update(euro).digest('hex'),
      capturedBytes: Buffer.byteLength('\u20ac'),
      capturedSha256: createHash('sha256').update('\u20ac').digest('hex'),
      complete: true,
      truncated: false,
    });
    expect(Buffer.concat(durableBytes)).toEqual(euro);
  });

  it('marks output incomplete and truncated after the cancellation deadline cuts streaming off', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let attachStarted = false;
    let releaseAttach: (() => void) | undefined;
    let inspectCount = 0;
    const writes: RunnerWriteCommand[] = [];
    let evidenceValue: JsonObject | undefined;
    const commandExecutor: DockerCommandExecutor = {
      run: vi.fn(async (argv: readonly string[], runOptions: CommandRunOptions) => {
        switch (argv[1]) {
          case 'version': return { argv: [...argv], exitCode: 0, signal: null, stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'image': return { argv: [...argv], exitCode: 0, signal: null, stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }), stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'ps': return { argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'create': return { argv: [...argv], exitCode: 0, signal: null, stdout: `${'1'.repeat(64)}\n`, stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'inspect': return { argv: [...argv], exitCode: 0, signal: null, stdout: JSON.stringify(inspectCount++ === 0 ? realisticCreatedRawInspection() : realisticRawInspection()), stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'start':
            attachStarted = true;
            runOptions.onStdoutBytes?.(Buffer.from('partial output'));
            await new Promise<void>((resolve) => { releaseAttach = resolve; });
            return { argv: [...argv], exitCode: 0, signal: null, stdout: 'partial output', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          case 'stop': return { argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: NOW, finishedAt: NOW };
          default: throw new Error(`unexpected Docker command ${argv.join(' ')}`);
        }
      }),
    };
    const run = createDockerExecutor(options(commandExecutor, {
      cancellationBudget: () => ({ requested: attachStarted, deadline: attachStarted ? 30_000 : null, remainingMs: attachStarted ? 30_000 : null }),
      monotonicNow: () => Date.now(),
      ownership: { runnerWrite: vi.fn((command: RunnerWriteCommand) => { writes.push(command); return { ok: true, kind: 'committed', eventSeq: writes.length }; }) },
      evidence: async (value) => {
        evidenceValue = value;
        encodeJson(value, 'operation evidence', true);
        return { path: 'evidence/operation-cutoff.json', sha256: 'c'.repeat(64) };
      },
    })).run();

    await vi.advanceTimersByTimeAsync(30_100);
    await Promise.resolve();
    const command = evidenceValue?.command as Record<string, unknown>;
    expect(command.stdout).toMatchObject({ complete: false, truncated: true, bytes: Buffer.byteLength('partial output') });
    expect(command.stderr).toMatchObject({ complete: false, truncated: true });
    releaseAttach?.();
    await expect(run).rejects.toMatchObject({ code: 'DOCKER_CONTAINER_ORPHANED' });
  });

  it('marks output incomplete and truncated when a durable output observer fails', async () => {
    const responses = successfulResponses({ stdout: 'partial output', stdoutChunks: ['partial output'] });
    const docker = fakeDocker(responses);
    let evidenceValue: JsonObject | undefined;
    const durableObserver = vi.fn(() => { throw new Error('durable log unavailable'); });

    await expect(createDockerExecutor(options(docker, {
      onStdoutBytes: durableObserver,
      evidence: async (value) => {
        evidenceValue = value;
        encodeJson(value, 'operation evidence', true);
        return { path: 'evidence/operation-observer-failure.json', sha256: 'c'.repeat(64) };
      },
    })).run()).resolves.toMatchObject({ outcome: 'failed' });

    expect(evidenceValue?.command).toMatchObject({
      stdout: expect.objectContaining({ complete: false, truncated: true }),
      stderr: expect.objectContaining({ complete: false, truncated: true }),
    });
    expect(durableObserver).toHaveBeenCalledOnce();
  });

  it('revalidates the worktree immediately before create and after created inspection before start', async () => {
    const trace: string[] = [];
    const docker = fakeDocker(successfulResponses(), trace);
    const executorOptions = {
      ...options(docker),
      revalidateWorktreeBeforeCreate: async () => { trace.push('revalidate:before-create'); },
      revalidateWorktreeBeforeStart: async () => { trace.push('revalidate:before-start'); },
    } as DockerExecutorOptions & {
      readonly revalidateWorktreeBeforeCreate: () => Promise<void>;
      readonly revalidateWorktreeBeforeStart: () => Promise<void>;
    };

    await expect(createDockerExecutor(executorOptions).run()).resolves.toMatchObject({
      available: true,
      outcome: 'passed',
    });
    expect(trace).toEqual([
      'docker:version',
      'docker:image',
      'docker:ps',
      'revalidate:before-create',
      'docker:create',
      'docker:inspect',
      'revalidate:before-start',
      'docker:start',
      'docker:inspect',
      'docker:rm',
      'docker:inspect',
      'docker:ps',
    ]);
  });

  it('does not expose the removed accepted-result classifier contract', async () => {
    const source = await readFile(new URL('../../runner/src/docker-executor.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('classifyAcceptedResult');
    expect(source).not.toContain('expected-rootfs-already-present');
    expect(source).not.toMatch(/outcome[^\n]*accepted/u);
  });

  it.each([
    ['before create', 'create'],
    ['before start', 'start'],
  ] as const)(
    'rejects each mutated active target link at the %s Docker boundary',
    async (_boundary, boundary) => {
      const root = await mkdtemp(join(tmpdir(), 'osi-docker-link-boundary-'));
      try {
        await mkdir(join(root, 'conf'), { recursive: true });
        await mkdir(join(root, 'openwrt'), { recursive: true });
        const links = [
          ['conf/.config', `${PI5_ENV}/.config`],
          ['conf/files', `${PI5_ENV}/files`],
          ['conf/patches', `${PI5_ENV}/patches`],
          ['openwrt/.config', '../conf/.config'],
          ['openwrt/files', '../conf/files'],
          ['openwrt/patches', '../conf/patches'],
        ] as const;
        for (const [path, target] of links) {
          await symlink(target, join(root, path));
        }
        const mutateAndAssert = async (path: string) => {
          await unlink(join(root, path));
          await writeFile(join(root, path), 'raced regular file\n');
          await assertActiveTargetLinks(root, PI5_ENV);
        };
        for (const [path] of links) {
          const docker = fakeDocker(successfulResponses());
          const optionsForBoundary = options(docker, {
            revalidateWorktreeBeforeCreate: async () => {
              if (boundary === 'create') await mutateAndAssert(path);
            },
            revalidateWorktreeBeforeStart: async () => {
              if (boundary === 'start') await mutateAndAssert(path);
            },
          });
          await expect(createDockerExecutor(optionsForBoundary).run()).rejects.toThrow();
          expect(docker.calls.some((call) => call[1] === (boundary === 'create' ? 'create' : 'start'))).toBe(false);
          expect((await readFile(join(root, path), 'utf8'))).toBe('raced regular file\n');
          await rm(join(root, path));
          const [, target] = links.find(([candidate]) => candidate === path)!;
          await symlink(target, join(root, path));
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('commits null-identity failure evidence when pre-create worktree revalidation fails', async () => {
    const docker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
      { stdout: '' },
      { stdout: '' },
    ]);
    const writes: RunnerWriteCommand[] = [];
    let evidenceValue: JsonObject | undefined;
    const executorOptions = {
      ...options(docker, {
        ownership: {
          runnerWrite: (command) => {
            writes.push(command);
            return { ok: true, kind: 'committed', eventSeq: writes.length };
          },
        },
        evidence: async (value) => {
          evidenceValue = value;
          return { path: 'evidence/pre-create-revalidation.json', sha256: 'c'.repeat(64) };
        },
      }),
      revalidateWorktreeBeforeCreate: async () => { throw new Error('workspace replaced before create'); },
      revalidateWorktreeBeforeStart: async () => undefined,
    } as DockerExecutorOptions & {
      readonly revalidateWorktreeBeforeCreate: () => Promise<void>;
      readonly revalidateWorktreeBeforeStart: () => Promise<void>;
    };

    await expect(createDockerExecutor(executorOptions).run()).rejects.toMatchObject({
      code: 'DOCKER_EXECUTION_DEFINITION_MISMATCH',
    });
    expect(docker.calls.map((call) => call[1])).toEqual(['version', 'image', 'ps', 'ps']);
    expect(writes.map((write) => write.kind)).toEqual([
      'operation-begin',
      'operation-complete',
      'operation-cleanup',
    ]);
    expect(evidenceValue).toMatchObject({
      lifecyclePhase: 'not_created',
      outcome: 'failed',
      error: { code: 'DOCKER_EXECUTION_DEFINITION_MISMATCH' },
      cleanup: { kind: 'null-identity' },
    });
  });

  it('removes the inspected container and commits failure evidence when pre-start worktree revalidation fails', async () => {
    const docker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
      { stdout: '' },
      { stdout: `${'1'.repeat(64)}\n` },
      { stdout: JSON.stringify(realisticCreatedRawInspection()) },
      { stdout: '' },
      { exitCode: 1, stderr: 'No such container: one\n' },
      { stdout: '' },
    ]);
    const writes: RunnerWriteCommand[] = [];
    let evidenceValue: JsonObject | undefined;
    const executorOptions = {
      ...options(docker, {
        ownership: {
          runnerWrite: (command) => {
            writes.push(command);
            return { ok: true, kind: 'committed', eventSeq: writes.length };
          },
        },
        evidence: async (value) => {
          evidenceValue = value;
          return { path: 'evidence/pre-start-revalidation.json', sha256: 'c'.repeat(64) };
        },
      }),
      revalidateWorktreeBeforeCreate: async () => undefined,
      revalidateWorktreeBeforeStart: async () => { throw new Error('workspace replaced before start'); },
    } as DockerExecutorOptions & {
      readonly revalidateWorktreeBeforeCreate: () => Promise<void>;
      readonly revalidateWorktreeBeforeStart: () => Promise<void>;
    };

    await expect(createDockerExecutor(executorOptions).run()).rejects.toMatchObject({
      code: 'DOCKER_EXECUTION_DEFINITION_MISMATCH',
    });
    expect(docker.calls.map((call) => call[1])).toEqual([
      'version',
      'image',
      'ps',
      'create',
      'inspect',
      'rm',
      'inspect',
      'ps',
    ]);
    expect(docker.calls.some((call) => call[1] === 'start')).toBe(false);
    expect(writes.map((write) => write.kind)).toEqual([
      'operation-begin',
      'operation-begin',
      'operation-complete',
      'operation-cleanup',
    ]);
    expect(evidenceValue).toMatchObject({
      lifecyclePhase: 'not_created',
      outcome: 'failed',
      error: { code: 'DOCKER_EXECUTION_DEFINITION_MISMATCH' },
      cleanup: {
        kind: 'container-removed',
        id: '1'.repeat(64),
        exactIdAbsent: true,
      },
    });
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

  it('recovers and attests persisted proxy, network, and credential identities before crash cleanup CAS', async () => {
    const trace: string[] = [];
    const docker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
      { exitCode: 1, stderr: 'No such container: retained\n' },
      { stdout: '' },
    ], trace);
    const labels = {
      'org.osi.image-builder.job-id': 'job-1',
      'org.osi.image-builder.manifest-sha': MANIFEST,
    };
    const identity = {
      ...emptyIdentityForTest(),
      containerId: '1'.repeat(64),
      containerName: 'osi-image-builder-job-1-attempt-1',
      containerImageDigest: DIGEST,
      containerLabelJobId: 'job-1',
      containerLabelManifestSha: MANIFEST,
      containerLabels: labels,
      containerMount: {},
      containerEnvironment: {},
      containerSecurity: { egress: JSON.parse(JSON.stringify(EGRESS_RESOURCES)) as JsonObject },
      containerInspection: {},
      containerCreatedAt: NOW,
      containerStoppedAt: NOW,
    };
    const operation = {
      operationId: 'build-image' as const,
      attempt: 1,
      outcome: 'passed' as const,
      finishedAt: NOW,
      exitCode: 0,
      containerId: identity.containerId,
      containerName: identity.containerName,
      containerImageDigest: DIGEST,
      containerLabelJobId: 'job-1',
      containerLabelManifestSha: MANIFEST,
    };
    const lifecycle = {
      recoverDocker: vi.fn(),
      discoverCredentials: vi.fn(),
      createCredential: vi.fn(),
      createNetwork: vi.fn(),
      destroyNetwork: vi.fn(async (_input, resources: DependencyEgressNetwork) => {
        trace.push('egress:destroy-network');
        expect(resources).toEqual(EGRESS_RESOURCES);
        return {
          proxy: { id: resources.proxy.id, absent: true as const },
          network: { id: resources.network.id, absent: true as const },
          tls: { hostDirectory: resources.tls.hostDirectory, absent: true as const },
          globalLabelResult: 'no-match' as const,
        };
      }),
      destroyCredential: vi.fn(async () => {
        trace.push('egress:destroy-credential');
        return { kind: 'normal' as const, hostPath: EGRESS_CREDENTIAL.hostPath, expectedSha256: EGRESS_CREDENTIAL.sha256, observedSha256: EGRESS_CREDENTIAL.sha256, tls: { hostDirectory: EGRESS_RESOURCES.tls.hostDirectory, absent: true as const }, absent: true as const };
      }),
    };
    const writes: RunnerWriteCommand[] = [];
    const ownership = {
      runnerWrite: vi.fn((command: RunnerWriteCommand) => {
        writes.push(command);
        trace.push(`write:${command.kind}`);
        return { ok: true };
      }),
    };

    await expect(createDockerExecutor(options(docker, {
      operationId: 'build-image',
      store: { getJob: () => identity, getOperation: () => operation as OperationInput },
      ownership,
      dependencyEgressLifecycle: lifecycle,
    })).run()).resolves.toMatchObject({ available: true, outcome: 'passed' });

    expect(lifecycle.createCredential).not.toHaveBeenCalled();
    expect(lifecycle.createNetwork).not.toHaveBeenCalled();
    expect(trace.indexOf('egress:destroy-network')).toBeLessThan(trace.indexOf('write:operation-cleanup'));
    expect(trace.indexOf('egress:destroy-credential')).toBeLessThan(trace.indexOf('write:operation-cleanup'));
    expect(writes.at(-1)).toMatchObject({
      kind: 'operation-cleanup',
      proof: { egress: {
        proxy: { id: EGRESS_RESOURCES.proxy.id, absent: true },
        network: { id: EGRESS_RESOURCES.network.id, absent: true },
        credential: { hostPath: EGRESS_CREDENTIAL.hostPath, sha256: EGRESS_CREDENTIAL.sha256, absent: true },
      } },
    });
  });

  it('runs verify-image with an offline read-only worktree and container rootfs', async () => {
    const writes: RunnerWriteCommand[] = [];
    const docker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}\n' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
      { stdout: '' },
      { stdout: `${'1'.repeat(64)}\n` },
      { stdout: JSON.stringify(rawInspectionWithContract('created', 'none', true)) },
      { stdout: '', startedAt: '2026-07-24T10:00:01.500Z', finishedAt: '2026-07-24T10:00:02.500Z' },
      { stdout: JSON.stringify(rawInspectionWithContract('exited', 'none', true)) },
      { stdout: '' },
      { exitCode: 1, stderr: 'No such container\n' },
      { stdout: '' },
    ]);

    await createDockerExecutor(options(docker, {
      operationId: 'verify-image',
      ownership: {
        runnerWrite: vi.fn((command: RunnerWriteCommand) => {
          writes.push(command);
          return { ok: true };
        }),
      },
    })).run();

    const create = docker.calls.find((call) => call[1] === 'create');
    expect(create).toContain('--network=none');
    expect(create).not.toContain('--network=bridge');
    expect(create).toContain('--read-only');
    expect(create).toContain(
      '--mount=type=bind,source=/tmp/worktree,destination=/workdir,readonly',
    );
    const created = writes.find((
      command,
    ): command is Extract<RunnerWriteCommand, { kind: 'container' }> => (
      command.kind === 'container' && command.lifecycle === 'created'
    ));
    expect(created?.mount).toEqual({
      type: 'bind',
      source: '/tmp/worktree',
      destination: '/workdir',
      readOnly: true,
    });
    expect(created?.security).toMatchObject({
      network: 'none',
      readonlyRootfs: true,
    });
    expect(created?.inspection).toMatchObject({
      container: {
        mounts: [{
          type: 'bind',
          source: '/tmp/worktree',
          destination: '/workdir',
          readOnly: true,
        }],
        readonlyRootfs: true,
      },
    });
    const completed = writes.find((
      command,
    ): command is Extract<RunnerWriteCommand, { kind: 'operation-complete' }> => (
      command.kind === 'operation-complete'
    ));
    expect(completed?.input.containerMount).toMatchObject({ readOnly: true });
    expect(completed?.input.containerSecurity).toMatchObject({ readonlyRootfs: true });
    expect(completed?.input.inspection).toMatchObject({
      container: { mounts: [{ readOnly: true }], readonlyRootfs: true },
    });
  });

  it('keeps a mutating operation worktree and container rootfs writable', async () => {
    const writes: RunnerWriteCommand[] = [];
    const docker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}\n' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
      { stdout: '' },
      { stdout: `${'1'.repeat(64)}\n` },
      { stdout: JSON.stringify(rawInspectionWithContract('created', 'none', false)) },
      { stdout: '', startedAt: '2026-07-24T10:00:01.500Z', finishedAt: '2026-07-24T10:00:02.500Z' },
      { stdout: JSON.stringify(rawInspectionWithContract('exited', 'none', false)) },
      { stdout: '' },
      { exitCode: 1, stderr: 'No such container\n' },
      { stdout: '' },
    ]);

    await createDockerExecutor(options(docker, {
      operationId: 'update-feeds',
      ownership: {
        runnerWrite: vi.fn((command: RunnerWriteCommand) => {
          writes.push(command);
          return { ok: true };
        }),
      },
    })).run();

    const create = docker.calls.find((call) => call[1] === 'create');
    expect(create).toContain('--network=none');
    expect(create).not.toContain('--read-only');
    expect(create).toContain('--mount=type=bind,source=/tmp/worktree,destination=/workdir');
    expect(create).not.toContain(
      '--mount=type=bind,source=/tmp/worktree,destination=/workdir,readonly',
    );
    const created = writes.find((
      command,
    ): command is Extract<RunnerWriteCommand, { kind: 'container' }> => (
      command.kind === 'container' && command.lifecycle === 'created'
    ));
    expect(created?.mount).toMatchObject({ readOnly: false });
    expect(created?.security).toMatchObject({ readonlyRootfs: false });
    expect(created?.inspection).toMatchObject({
      container: { mounts: [{ readOnly: false }], readonlyRootfs: false },
    });
  });

  it('admits dependency-fetching branch operations only through an internal proxy network', async () => {
    const trace: string[] = [];
    const buildImageRaw = (state: 'created' | 'exited'): Record<string, unknown> => {
      const value = rawInspectionWithContract(state, 'none', false);
      const host = value.HostConfig as Record<string, unknown>;
      host.NetworkMode = EGRESS_RESOURCES.network.name;
      (value.Mounts as Array<Record<string, unknown>>).push({
        Type: 'bind',
        Source: EGRESS_CREDENTIAL.hostPath,
        Destination: EGRESS_CREDENTIAL.containerPath,
        RW: false,
      });
      (value.Mounts as Array<Record<string, unknown>>).push({
        Type: 'bind',
        Source: EGRESS_TLS.caCertificateHostPath,
        Destination: '/run/osi-image-builder/ca.pem',
        RW: false,
      });
      const config = value.Config as Record<string, unknown>;
      config.Env = [
        ...(config.Env as string[]),
        'HTTP_PROXY=http://osi-egress-proxy:3128',
        'HTTPS_PROXY=http://osi-egress-proxy:3128',
        'ALL_PROXY=http://osi-egress-proxy:3128',
        'NO_PROXY=',
        'http_proxy=http://osi-egress-proxy:3128',
        'https_proxy=http://osi-egress-proxy:3128',
        'all_proxy=http://osi-egress-proxy:3128',
        'no_proxy=',
        `OSI_EGRESS_PROXY_CREDENTIAL_FILE=${DEPENDENCY_EGRESS_CREDENTIAL_PATH}`,
        'OSI_EGRESS_CA_CERT_FILE=/run/osi-image-builder/ca.pem',
      ];
      return value;
    };
    const docker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
      { stdout: '' },
      { stdout: `${'1'.repeat(64)}\n` },
      { stdout: JSON.stringify(buildImageRaw('created')) },
      { stdout: 'build output\n' },
      { stdout: JSON.stringify(buildImageRaw('exited')) },
      { stdout: '' },
      { exitCode: 1, stderr: 'No such container: one\n' },
      { stdout: '' },
    ], trace);
    const writes: RunnerWriteCommand[] = [];
    const persistedIdentity = emptyIdentityForTest();
    const ownership = {
      runnerWrite: vi.fn((command: RunnerWriteCommand) => {
        writes.push(command);
        trace.push(`write:${command.kind}`);
        const persisted = JSON.parse(JSON.stringify(normalizeCommand(command, 'runner write'))) as RunnerWriteCommand;
        if (persisted.kind === 'container') Object.assign(persistedIdentity, {
          containerId: persisted.containerId,
          containerName: persisted.containerName,
          containerImageDigest: persisted.imageDigest,
          containerLabelJobId: persisted.labels['org.osi.image-builder.job-id'],
          containerLabelManifestSha: persisted.labels['org.osi.image-builder.manifest-sha'],
          containerLabels: persisted.labels,
          containerMount: persisted.mount,
          containerEnvironment: persisted.environment,
          containerSecurity: persisted.security,
          containerInspection: persisted.inspection,
          containerCreatedAt: persisted.createdAt,
          containerStartedAt: persisted.startedAt ?? null,
          containerStoppedAt: persisted.stoppedAt ?? null,
        });
        return { ok: true };
      }),
    };
    const lifecycle = {
      recoverDocker: vi.fn(async () => {
        trace.push('egress:recover-docker');
        return { docker: [], credentials: [], globalLabelResult: 'no-match' as const };
      }),
      discoverCredentials: vi.fn(async () => {
        trace.push('egress:discover-credentials');
        return [];
      }),
      createCredential: vi.fn(async () => {
        trace.push('egress:create-credential');
        return EGRESS_CREDENTIAL;
      }),
      createNetwork: vi.fn(async () => {
        trace.push('egress:create-network');
        return EGRESS_RESOURCES;
      }),
      destroyNetwork: vi.fn(async () => {
        trace.push('egress:destroy-network');
        return {
          proxy: { id: EGRESS_RESOURCES.proxy.id, absent: true as const },
          network: { id: EGRESS_RESOURCES.network.id, absent: true as const },
          tls: { hostDirectory: EGRESS_RESOURCES.tls.hostDirectory, absent: true as const },
          globalLabelResult: 'no-match' as const,
        };
      }),
      destroyCredential: vi.fn(async () => {
        trace.push('egress:destroy-credential');
        return { kind: 'normal' as const, hostPath: EGRESS_CREDENTIAL.hostPath, expectedSha256: EGRESS_CREDENTIAL.sha256, observedSha256: EGRESS_CREDENTIAL.sha256, tls: { hostDirectory: EGRESS_RESOURCES.tls.hostDirectory, absent: true as const }, absent: true as const };
      }),
    };

    await expect(createDockerExecutor(options(docker, {
      operationId: 'build-image',
      ownership,
      store: { getJob: () => persistedIdentity },
      dependencyEgressLifecycle: lifecycle,
    })).run()).resolves.toMatchObject({ available: true, outcome: 'passed' });

    expect(lifecycle.createCredential).toHaveBeenCalledBefore(lifecycle.createNetwork);
    expect(lifecycle.recoverDocker).toHaveBeenCalledBefore(lifecycle.createCredential);
    expect(lifecycle.discoverCredentials).toHaveBeenCalledBefore(lifecycle.createCredential);
    expect(lifecycle.createNetwork).toHaveBeenCalledWith(expect.objectContaining({
      imageId: `sha256:${'e'.repeat(64)}`,
      imageDigest: DIGEST,
      operationId: 'build-image',
      credential: EGRESS_CREDENTIAL,
    }));
    const builderCreate = docker.calls.find((argv) => argv[1] === 'create');
    expect(builderCreate).toContain(`--network=${EGRESS_RESOURCES.network.name}`);
    expect(builderCreate).toContain(`--mount=type=bind,source=${EGRESS_CREDENTIAL.hostPath},destination=${DEPENDENCY_EGRESS_CREDENTIAL_PATH},readonly`);
    expect(builderCreate?.join(' ')).not.toContain(EGRESS_CREDENTIAL.sha256);
    const created = writes.find((command): command is Extract<RunnerWriteCommand, { kind: 'container' }> => command.kind === 'container' && command.lifecycle === 'created');
    expect(created?.security).toMatchObject({ egress: EGRESS_RESOURCES });
    expect(created?.inspection).toMatchObject({ container: { mounts: [
      { source: '/tmp/worktree', destination: '/workdir', readOnly: false },
      { source: EGRESS_CREDENTIAL.hostPath, destination: DEPENDENCY_EGRESS_CREDENTIAL_PATH, readOnly: true },
      { source: EGRESS_TLS.caCertificateHostPath, destination: '/run/osi-image-builder/ca.pem', readOnly: true },
    ] } });
    expect(trace.indexOf('egress:destroy-network')).toBeLessThan(trace.indexOf('write:operation-cleanup'));
    expect(trace.indexOf('egress:destroy-credential')).toBeLessThan(trace.indexOf('write:operation-cleanup'));
    const cleanup = writes.find((command): command is Extract<RunnerWriteCommand, { kind: 'operation-cleanup' }> => command.kind === 'operation-cleanup');
    expect(cleanup?.proof).toMatchObject({
      egress: {
        proxy: { id: EGRESS_RESOURCES.proxy.id, absent: true },
        network: { id: EGRESS_RESOURCES.network.id, absent: true },
        credential: { hostPath: EGRESS_CREDENTIAL.hostPath, sha256: EGRESS_CREDENTIAL.sha256, absent: true },
      },
    });
  });

  it('rejects an unexpected persisted dependency egress leaf before destructive cleanup', async () => {
    const docker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
      { stdout: '' },
      { stdout: `${'1'.repeat(64)}\n` },
      { stdout: JSON.stringify(dependencyEgressRawInspection('created')) },
      { stdout: 'build output\n' },
      { stdout: JSON.stringify(dependencyEgressRawInspection('exited')) },
      { stdout: '' },
      { exitCode: 1, stderr: 'No such container: one\n' },
      { stdout: '' },
    ]);
    const writes: RunnerWriteCommand[] = [];
    const persistedIdentity = emptyIdentityForTest();
    const ownership = {
      runnerWrite: vi.fn((command: RunnerWriteCommand) => {
        writes.push(command);
        const persisted = JSON.parse(JSON.stringify(normalizeCommand(command, 'runner write'))) as RunnerWriteCommand;
        if (persisted.kind === 'container') {
          const originalSecurity = JSON.parse(JSON.stringify(persisted.security)) as JsonObject;
          const egress = originalSecurity.egress as JsonObject;
          const tls = egress.tls as JsonObject;
          const leaves = tls.leafCertificates as JsonObject;
          const firstAllowedLeaf = leaves[operationNetworkPolicy('build-image').allowedHosts[0]!];
          const security = {
            ...originalSecurity,
            egress: {
              ...egress,
              tls: { ...tls, leafCertificates: { ...leaves, 'evil.example': firstAllowedLeaf } },
            },
          } satisfies JsonObject;
          Object.assign(persistedIdentity, {
            containerId: persisted.containerId,
            containerName: persisted.containerName,
            containerImageDigest: persisted.imageDigest,
            containerLabelJobId: persisted.labels['org.osi.image-builder.job-id'],
            containerLabelManifestSha: persisted.labels['org.osi.image-builder.manifest-sha'],
            containerLabels: persisted.labels,
            containerMount: persisted.mount,
            containerEnvironment: persisted.environment,
            containerSecurity: security,
            containerInspection: persisted.inspection,
            containerCreatedAt: persisted.createdAt,
            containerStartedAt: persisted.startedAt ?? null,
            containerStoppedAt: persisted.stoppedAt ?? null,
          });
        }
        return { ok: true };
      }),
    };
    const destroyNetwork = vi.fn(async () => ({
      proxy: { id: EGRESS_RESOURCES.proxy.id, absent: true as const },
      network: { id: EGRESS_RESOURCES.network.id, absent: true as const },
      tls: { hostDirectory: EGRESS_RESOURCES.tls.hostDirectory, absent: true as const },
      globalLabelResult: 'no-match' as const,
    }));
    const lifecycle = {
      recoverDocker: vi.fn(async () => ({ docker: [], credentials: [], globalLabelResult: 'no-match' as const })),
      discoverCredentials: vi.fn(async () => []),
      createCredential: vi.fn(async () => EGRESS_CREDENTIAL),
      createNetwork: vi.fn(async () => EGRESS_RESOURCES),
      destroyNetwork,
      destroyCredential: vi.fn(async () => ({ kind: 'normal' as const, hostPath: EGRESS_CREDENTIAL.hostPath, expectedSha256: EGRESS_CREDENTIAL.sha256, observedSha256: EGRESS_CREDENTIAL.sha256, tls: { hostDirectory: EGRESS_RESOURCES.tls.hostDirectory, absent: true as const }, absent: true as const })),
    };

    await expect(createDockerExecutor(options(docker, {
      operationId: 'build-image',
      ownership,
      store: { getJob: () => persistedIdentity },
      dependencyEgressLifecycle: lifecycle,
    })).run()).rejects.toBeInstanceOf(DockerLifecycleError);
    expect(docker.calls.some((call) => call[1] === 'rm')).toBe(false);
    expect(destroyNetwork).not.toHaveBeenCalled();
    expect(writes.some((write) => write.kind === 'operation-cleanup')).toBe(false);
  });

  it('removes a discovered TLS-only remnant during dependency startup cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-docker-tls-only-startup-'));
    try {
      const hostDirectory = join(root, 'build-image-1.proxy-tls');
      await mkdir(hostDirectory, { mode: 0o700 });
      const docker = fakeDocker([
        { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
        { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
        { stdout: '' },
      ]);
      const lifecycle = {
        recoverDocker: vi.fn(async () => ({ docker: [], credentials: [], globalLabelResult: 'no-match' as const })),
        discoverCredentials: vi.fn(async () => [{
          kind: 'tls-only' as const,
          operationId: 'build-image' as const,
          attempt: 1,
          credentialHostPath: join(root, 'build-image-1.proxy-credential'),
          hostDirectory,
        }]),
        createCredential: vi.fn(async () => EGRESS_CREDENTIAL),
        createNetwork: vi.fn(async () => EGRESS_RESOURCES),
        destroyNetwork: vi.fn(async () => ({
          proxy: { id: EGRESS_RESOURCES.proxy.id, absent: true as const },
          network: { id: EGRESS_RESOURCES.network.id, absent: true as const },
          tls: { hostDirectory, absent: true as const },
          globalLabelResult: 'no-match' as const,
        })),
        destroyCredential: vi.fn(async () => ({
          kind: 'credential-only' as const,
          hostPath: EGRESS_CREDENTIAL.hostPath,
          expectedSha256: EGRESS_CREDENTIAL.sha256,
          observedSha256: null,
          tls: { hostDirectory, absent: true as const },
          absent: true as const,
        })),
      };
      const authorizeContainerCreate = vi.fn(async () => {
        throw new Error('stop after startup cleanup');
      });

      await expect(createDockerExecutor(options(docker, {
        operationId: 'build-image',
        dependencyEgressCredentialDirectory: root,
        dependencyEgressLifecycle: lifecycle,
        authorizeContainerCreate,
      })).run()).rejects.toThrow('stop after startup cleanup');

      expect(lifecycle.recoverDocker).toHaveBeenCalledBefore(lifecycle.discoverCredentials);
      expect(lifecycle.discoverCredentials).toHaveBeenCalledWith(root);
      expect(lifecycle.destroyCredential).not.toHaveBeenCalled();
      expect(docker.calls.map((call) => call[1])).toEqual(['version', 'image', 'ps']);
      await expect(readdir(root)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects every inspected security or identity mismatch before starting the container', async () => {
    const mismatches: Array<[string, Partial<DockerInspection>]> = [
      ['container ID', { id: '2'.repeat(64) }],
      ['container name', { name: 'osi-image-builder-other-job-attempt-1' }],
      ['image ID', { imageId: `sha256:${'f'.repeat(64)}` }],
      ['image ref', { image: `registry.example/other@sha256:${DIGEST}` }],
      ['label', { labels: { 'org.osi.image-builder.job-id': 'other', 'org.osi.image-builder.manifest-sha': MANIFEST } }],
      ['mount', { mounts: [] }],
      ['mount read-only', { mounts: [{ type: 'bind', source: '/tmp/worktree', destination: '/workdir', readOnly: false }] }],
      ['user', { user: '0:0' }],
      ['workdir', { workingDir: '/wrong' }],
      ['network', { networkMode: 'host' }],
      ['capability', { capDrop: [] }],
      ['security', { privileged: true }],
      ['readonly rootfs', { readonlyRootfs: false }],
      ['pids', { pidsLimit: 1 }],
      ['CPU limit', { nanoCpus: 1 }],
      ['memory limit', { memoryBytes: 1 }],
      ['swap limit', { memorySwapBytes: 1 }],
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
    const imageIndex = create.indexOf(`registry.example/builder@sha256:${DIGEST}`);
    expect(create.slice(imageIndex + 1)).toEqual([
      'node',
      '/opt/osi-image-builder/operations/osi-image-builder-exec-guard.js',
      '--workspace-dev=35',
      '--workspace-ino=25383430',
      '--active-target-environment=root',
      '--operation-id=verify-image',
      `--operation-environment=${PI5_ENV}`,
      '--working-directory=/workdir',
      '--',
      'node',
      INTERNAL_OPERATION_TOOL_PATH,
      'verify-image',
    ]);
    expect(() => createOperationArgv('verify-image', { environment: '../branch' })).toThrow();
  });

  it('uses a fixed root-owned guard wrapper with the held workspace identity and active target', async () => {
    const docker = fakeDocker(successfulResponses());
    await createDockerExecutor(options(docker, {
      activeTargetEnvironment: PI5_ENV,
      operationId: 'verify-image',
    })).run();
    const create = docker.calls.find((call) => call[1] === 'create')!;
    const imageIndex = create.indexOf(`registry.example/builder@sha256:${DIGEST}`);
    expect(create.slice(imageIndex + 1)).toEqual([
      'node',
      '/opt/osi-image-builder/operations/osi-image-builder-exec-guard.js',
      '--workspace-dev=35',
      '--workspace-ino=25383430',
      `--active-target-environment=${PI5_ENV}`,
      '--operation-id=verify-image',
      '--operation-environment=' + PI5_ENV,
      '--working-directory=/workdir',
      '--',
      'node',
      INTERNAL_OPERATION_TOOL_PATH,
      'verify-image',
    ]);
    expect(create.some((part) => part.includes('proc/') || part === 'sh' || part === '/bin/sh')).toBe(false);
  });

  it('uses the registry frontend definition for create, inspection, security, and executed argv', async () => {
    const frontendRaw = (): Record<string, unknown> => {
      const value = realisticRawInspection();
      (value.Config as Record<string, unknown>).WorkingDir = '/workdir/web/react-gui';
      (value.Config as Record<string, unknown>).Cmd = [
        'node',
        INTERNAL_EXECUTION_GUARD_PATH,
        '--workspace-dev=35',
        '--workspace-ino=25383430',
        '--active-target-environment=root',
        '--operation-id=frontend-test',
        `--operation-environment=${PI5_ENV}`,
        '--working-directory=/workdir/web/react-gui',
        '--',
        'npm',
        'run',
        'test:unit',
      ];
      const host = value.HostConfig as Record<string, unknown>;
      host.NetworkMode = 'none';
      host.ReadonlyRootfs = false;
      const mounts = value.Mounts as Array<Record<string, unknown>>;
      mounts[0]!.RW = true;
      (value.Config as Record<string, unknown>).Env = [
        'HOME=/workdir/.builder-home',
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'CARGO_BUILD_JOBS=2',
        'TZ=UTC',
        'SOURCE_DATE_EPOCH=1784887200',
      ];
      return value;
    };
    const frontendCreatedRaw = (): Record<string, unknown> => ({ ...frontendRaw(), State: { Status: 'created', Running: false, StartedAt: '0001-01-01T00:00:00.000000000Z', FinishedAt: '0001-01-01T00:00:00.000000000Z', ExitCode: 0 } });
    const docker = fakeDocker([
      { stdout: '{"Server":{"Os":"linux","Arch":"amd64"}}' },
      { stdout: JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [`registry.example/builder@sha256:${DIGEST}`], Architecture: 'amd64', Os: 'linux' }) },
      { stdout: '' },
      { stdout: `${'1'.repeat(64)}\n` }, { stdout: JSON.stringify(frontendCreatedRaw()) }, { stdout: '' }, { stdout: JSON.stringify(frontendRaw()) }, { stdout: '' }, { exitCode: 1, stderr: 'No such container: one\n' }, { stdout: '' },
    ]);
    const writes: RunnerWriteCommand[] = [];
    const ownership = { runnerWrite: vi.fn((command: RunnerWriteCommand) => { writes.push(command); return { ok: true }; }) };
    await createDockerExecutor(options(docker, { operationId: 'frontend-test', ownership })).run();
    const create = docker.calls.find((call) => call[1] === 'create' && call.includes(`registry.example/builder@sha256:${DIGEST}`) && !call.includes('--network=bridge'))!;
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

  it('does not create a container when cancellation commits during pre-create setup', async () => {
    const baseDocker = fakeDocker(successfulResponses());
    let releaseLabelProof!: () => void;
    let labelProofStarted!: () => void;
    const labelProofReached = new Promise<void>((resolve) => {
      labelProofStarted = resolve;
    });
    const labelProofRelease = new Promise<void>((resolve) => {
      releaseLabelProof = resolve;
    });
    let cancellationRequested = false;
    const docker: DockerCommandExecutor & { calls: string[][] } = {
      calls: baseDocker.calls,
      run: vi.fn(async (argv, runOptions) => {
        if (argv[1] === 'ps') {
          labelProofStarted();
          await labelProofRelease;
        }
        return baseDocker.run(argv, runOptions);
      }),
    };
    const writes: RunnerWriteCommand[] = [];
    const authorizeContainerCreate = vi.fn(async () => cancellationRequested
      ? {
          authorized: false as const,
          observation: {
            requested: true as const,
            handled: true as const,
            state: 'cancelled' as const,
            evidencePath: 'jobs/job-1/evidence/cancellation.json',
            evidenceSha256: 'f'.repeat(64),
          },
        }
      : { authorized: true as const });
    const run = createDockerExecutor({
      ...options(docker, {
        ownership: {
          runnerWrite: (command) => {
            writes.push(command);
            return { ok: true, kind: 'committed', eventSeq: 1 };
          },
        },
      }),
      authorizeContainerCreate,
    } as DockerExecutorOptions).run();

    await labelProofReached;
    cancellationRequested = true;
    releaseLabelProof();

    await expect(run).rejects.toMatchObject({
      code: 'CANCELLED',
      observation: {
        requested: true,
        handled: true,
        state: 'cancelled',
      },
    });
    expect(authorizeContainerCreate).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
    expect(docker.calls.some((call) => ['create', 'start', 'stop', 'rm'].includes(call[1] ?? ''))).toBe(false);
  });

  it('uses the immediate coordinator checkpoint as the final boundary before create', async () => {
    const docker = fakeDocker(successfulResponses());
    const writes: RunnerWriteCommand[] = [];
    const authorizeContainerCreate = vi.fn(async () => ({
      authorized: false as const,
      observation: {
        requested: true as const,
        handled: true as const,
        state: 'cancelled' as const,
        evidencePath: 'jobs/job-1/evidence/cancellation.json',
        evidenceSha256: 'f'.repeat(64),
      },
    }));

    await expect(createDockerExecutor({
      ...options(docker, {
        ownership: {
          runnerWrite: (command) => {
            writes.push(command);
            return { ok: true, kind: 'committed', eventSeq: 1 };
          },
        },
      }),
      authorizeContainerCreate,
    } as DockerExecutorOptions).run()).rejects.toMatchObject({
      code: 'CANCELLED',
      observation: { state: 'cancelled' },
    });

    expect(docker.calls.map((call) => call[1])).toEqual(['version', 'image', 'ps']);
    expect(writes).toEqual([]);
  });

  it('rechecks coordinator cancellation after async worktree revalidation before create', async () => {
    const docker = fakeDocker(successfulResponses());
    const writes: RunnerWriteCommand[] = [];
    let cancellationRequested = false;
    let cancellationCleanupCommitted = false;
    const authorizeContainerCreate = vi.fn(async () => {
      if (!cancellationRequested) return { authorized: true as const };
      cancellationCleanupCommitted = true;
      return {
        authorized: false as const,
        observation: {
          requested: true as const,
          handled: true as const,
          state: 'cancelled' as const,
          evidencePath: 'jobs/job-1/evidence/cancellation.json',
          evidenceSha256: 'f'.repeat(64),
        },
      };
    });
    const revalidateWorktreeBeforeCreate = vi.fn(async () => {
      await Promise.resolve();
      cancellationRequested = true;
    });

    await expect(createDockerExecutor({
      ...options(docker, {
        ownership: {
          runnerWrite: (command) => {
            writes.push(command);
            return { ok: true, kind: 'committed', eventSeq: 1 };
          },
        },
      }),
      authorizeContainerCreate,
      revalidateWorktreeBeforeCreate,
    } as DockerExecutorOptions).run()).rejects.toMatchObject({
      code: 'CANCELLED',
      observation: {
        requested: true,
        handled: true,
        state: 'cancelled',
        evidencePath: 'jobs/job-1/evidence/cancellation.json',
        evidenceSha256: 'f'.repeat(64),
      },
    });

    expect(authorizeContainerCreate).toHaveBeenCalledTimes(2);
    expect(revalidateWorktreeBeforeCreate).toHaveBeenCalledOnce();
    expect(cancellationCleanupCommitted).toBe(true);
    expect(docker.calls.map((call) => call[1])).toEqual(['version', 'image', 'ps']);
    expect(writes).toEqual([]);
  });

  it('surfaces pre-create cancellation recovery without Docker mutation', async () => {
    const docker = fakeDocker(successfulResponses());
    const authorizeContainerCreate = vi.fn(async () => {
      throw new CancellationBlockedError(
        'pre-container cancellation ownership was lost',
        'RUNNER_DISAPPEARED',
      );
    });

    await expect(createDockerExecutor({
      ...options(docker),
      authorizeContainerCreate,
    } as DockerExecutorOptions).run()).rejects.toMatchObject({
      code: 'DOCKER_CONTAINER_ORPHANED',
      recoveryRequired: true,
      blockerCode: 'RUNNER_DISAPPEARED',
    });
    expect(docker.calls.map((call) => call[1])).toEqual(['version', 'image', 'ps']);
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

  it('delivers exact stdout and stderr bytes before their decoded observers', async () => {
    const order: string[] = [];
    const stdoutBytes: Buffer[] = [];
    const stderrBytes: Buffer[] = [];
    const result = await createCommandExecutor().run([
      process.execPath,
      '-e',
      'process.stdout.write(Buffer.from([0xff, 0x00, 0xfe])); process.stderr.write(Buffer.from([0x80, 0x01, 0xfd]));',
    ], {
      env: { PATH: process.env.PATH ?? '', HOME: '/tmp' },
      onStdoutBytes: (chunk) => { order.push('stdout-bytes'); stdoutBytes.push(chunk); },
      onStdout: () => { order.push('stdout-text'); },
      onStderrBytes: (chunk) => { order.push('stderr-bytes'); stderrBytes.push(chunk); },
      onStderr: () => { order.push('stderr-text'); },
    });

    expect(stdoutBytes).toEqual([Buffer.from([0xff, 0x00, 0xfe])]);
    expect(stderrBytes).toEqual([Buffer.from([0x80, 0x01, 0xfd])]);
    expect(result.stdout).toBe('\ufffd\u0000\ufffd');
    expect(result.stderr).toBe('\ufffd\u0001\ufffd');
    expect(order).toEqual(['stdout-bytes', 'stdout-text', 'stderr-bytes', 'stderr-text']);
  });

  it('kills the command and preserves the result when a byte observer fails', async () => {
    await expect(createCommandExecutor().run([
      process.execPath,
      '-e',
      'process.stdout.write(Buffer.from([0xff])); setTimeout(() => {}, 1000);',
    ], {
      env: { PATH: process.env.PATH ?? '', HOME: '/tmp' },
      timeoutMs: 5_000,
      onStdoutBytes: () => { throw new Error('byte observer failed'); },
      onStdout: () => { throw new Error('text observer must not run'); },
    })).rejects.toMatchObject({
      name: 'CommandExecutionError',
      result: expect.objectContaining({ stdout: '\ufffd' }),
    });
  });
});

function emptyIdentityForTest(): PersistedContainerIdentity & { readonly sourceCommitTime: string } {
  return { sourceCommitTime: NOW, containerId: null, containerName: null, containerImageDigest: null, containerLabelJobId: null, containerLabelManifestSha: null, containerLabels: null, containerMount: null, containerEnvironment: null, containerSecurity: null, containerInspection: null, containerCreatedAt: null, containerStartedAt: null, containerStoppedAt: null, containerRemovedAt: null, containerCleanupOutcome: null };
}

function persistContainerWriteForTest(
  identity: PersistedContainerIdentity,
  command: RunnerWriteCommand,
): void {
  if (command.kind === 'container') {
    Object.assign(identity, {
      containerId: command.containerId,
      containerName: command.containerName,
      containerImageDigest: command.imageDigest,
      containerLabelJobId: command.labels['org.osi.image-builder.job-id'],
      containerLabelManifestSha: command.labels['org.osi.image-builder.manifest-sha'],
      containerLabels: command.labels,
      containerMount: command.mount,
      containerEnvironment: command.environment,
      containerSecurity: command.security,
      containerInspection: command.inspection,
      containerCreatedAt: command.createdAt ?? null,
      containerStartedAt: command.startedAt ?? null,
      containerStoppedAt: command.stoppedAt ?? null,
      containerRemovedAt: command.removedAt ?? null,
      containerCleanupOutcome: command.cleanupOutcome ?? null,
    });
  }
  if (command.kind === 'operation-cleanup') {
    Object.assign(identity, emptyIdentityForTest());
  }
}
