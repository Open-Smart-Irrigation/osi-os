import { createCommandExecutor, type CommandExecutor, type CommandResult } from './command-executor.js';
import { hashOperationArgv } from './operation-registry.js';
import type { JobState, TrustedOperationId } from '../../domain/types.js';
import type { OwnershipStore, RunnerWriteCommand } from '../../api/src/ownership.js';
import type { JobRecord, JsonObject } from '../../api/src/store.js';

const IMAGE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const JOB_LABEL = 'org.osi.image-builder.job-id';
const MANIFEST_LABEL = 'org.osi.image-builder.manifest-sha';
const CONTAINER_ENV_KEYS = ['HOME', 'PATH', 'CARGO_BUILD_JOBS', 'TZ', 'SOURCE_DATE_EPOCH'] as const;
const ABSENT_LOGS = { runner: 'absent' as const, docker: 'absent' as const, verifiedAt: '2026-01-01T00:00:00.000Z', generationIdentity: { runner: [], docker: [] } };

export interface DockerCommandExecutor {
  run(argv: readonly string[], options?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>>; readonly onStdout?: (chunk: string) => void; readonly onStderr?: (chunk: string) => void }): Promise<CommandResult>;
}

export interface DockerInspection {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly imageDigest: string;
  readonly architecture: string;
  readonly os: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly mounts: readonly { readonly type: string; readonly source: string; readonly destination: string; readonly readOnly: boolean }[];
  readonly user: string;
  readonly workingDir: string;
  readonly networkMode: string;
  readonly capDrop: readonly string[];
  readonly capAdd: readonly string[];
  readonly privileged: boolean;
  readonly devices: readonly unknown[];
  readonly securityOpt: readonly string[];
  readonly pidsLimit: number;
  readonly ulimits: readonly { readonly name: string; readonly soft: number; readonly hard: number }[];
  readonly environment: Readonly<Record<string, string>>;
  readonly running: boolean;
}

export interface OwnershipLike {
  getJob(jobId: string): JobRecord;
  runnerWrite(command: RunnerWriteCommand): { readonly ok: boolean; readonly kind?: string; readonly eventSeq?: number };
}

export interface DockerExecutorOptions {
  readonly commandExecutor?: DockerCommandExecutor;
  readonly dockerPath: string;
  readonly imageReference: string;
  readonly imageDigest: string;
  readonly jobId: string;
  readonly manifestSha256: string;
  readonly attempt: number;
  readonly worktreePath: string;
  readonly uid: number;
  readonly gid: number;
  readonly sourceDateEpoch: string;
  readonly operationId: TrustedOperationId;
  readonly operationArgv: readonly string[];
  readonly containerName: string;
  readonly runner?: { readonly owner: string; readonly unit: string; readonly leaseExpiresAt: string; readonly expectedState: JobState };
  readonly ownership?: OwnershipLike;
  readonly clock?: () => string;
  readonly evidence?: (value: JsonObject) => Promise<{ readonly path: string; readonly sha256: string }>;
  readonly logs?: { readonly runner: 'absent' | 'sealed'; readonly docker: 'absent' | 'sealed'; readonly verifiedAt: string; readonly generationIdentity: { readonly runner: readonly unknown[]; readonly docker: readonly unknown[] } };
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}

export type DockerExecutionResult =
  | { readonly available: true; readonly outcome: 'passed' | 'failed'; readonly containerId: string; readonly exitCode: number | null; readonly mutationCount: number }
  | { readonly available: false; readonly mutationCount: 0; readonly reason: 'docker-unavailable' };

export class DockerLifecycleError extends Error {
  readonly code = 'DOCKER_EXECUTION_DEFINITION_MISMATCH';
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'DockerLifecycleError'; }
}

function env(options: DockerExecutorOptions): Readonly<Record<string, string>> {
  return { HOME: '/workdir/.builder-home', PATH: IMAGE_PATH, CARGO_BUILD_JOBS: '2', TZ: 'UTC', SOURCE_DATE_EPOCH: options.sourceDateEpoch };
}

function dockerEnv(): Readonly<Record<string, string>> {
  return { HOME: '/tmp/osi-image-builder-docker-home', PATH: IMAGE_PATH, LANG: 'C', LC_ALL: 'C' };
}

function command(options: DockerExecutorOptions, args: readonly string[], callbacks: { readonly onStdout?: (chunk: string) => void; readonly onStderr?: (chunk: string) => void } = {}): Promise<CommandResult> {
  const executor = options.commandExecutor ?? createCommandExecutor();
  return executor.run([options.dockerPath, ...args], { env: dockerEnv(), onStdout: callbacks.onStdout, onStderr: callbacks.onStderr });
}

function requireSuccess(result: CommandResult, action: string): string {
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut) throw new DockerLifecycleError(`${action} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function noLabel(stdout: string): boolean {
  return stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).length === 0;
}

function exactRecord(actual: Readonly<Record<string, string>>, expected: Readonly<Record<string, string>>): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) && expectedKeys.every((key) => actual[key] === expected[key]);
}

function parseContainerId(stdout: string): string {
  const values = stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  if (values.length !== 1 || !/^[a-f0-9]{12,64}$/u.test(values[0]!)) throw new DockerLifecycleError('docker create returned an invalid container ID');
  return values[0]!;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DockerLifecycleError(`${field} is not an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new DockerLifecycleError(`${field} is not a string`);
  return value;
}

function normalizedEnvironment(value: unknown): Readonly<Record<string, string>> {
  if (Array.isArray(value)) {
    const result: Record<string, string> = {};
    for (const item of value) { const text = string(item, 'container environment entry'); const index = text.indexOf('='); if (index < 1) throw new DockerLifecycleError('container environment entry is malformed'); result[text.slice(0, index)] = text.slice(index + 1); }
    return result;
  }
  const record = object(value, 'container environment');
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, string(item, `container environment ${key}`)]));
}

function normalizeInspection(value: unknown): DockerInspection {
  const root = Array.isArray(value) ? object(value[0], 'docker inspect result') : object(value, 'docker inspect result');
  const config = object(root.Config ?? root, 'docker inspect Config');
  const host = object(root.HostConfig ?? root, 'docker inspect HostConfig');
  const state = object(root.State ?? root, 'docker inspect State');
  const mounts = (root.Mounts ?? root.mounts ?? []) as unknown;
  const labels = object(config.Labels ?? root.labels, 'container labels') as Record<string, string>;
  const image = string(config.Image ?? root.image, 'container image');
  const imageDigest = string(root.ImageDigest ?? root.imageDigest ?? (image.match(/@sha256:([0-9a-f]{64})$/u)?.[1]), 'container image digest');
  const ulimits = (host.Ulimits ?? root.ulimits ?? []) as unknown[];
  return {
    id: string(root.Id ?? root.id, 'container ID'), name: string(String(root.Name ?? root.name).replace(/^\//u, ''), 'container name'), image, imageDigest,
    architecture: String(root.Architecture ?? root.architecture ?? 'amd64'), os: String(root.Os ?? root.os ?? 'linux'), labels,
    mounts: (Array.isArray(mounts) ? mounts : []).map((item) => { const mount = object(item, 'container mount'); return { type: String(mount.Type ?? mount.type), source: String(mount.Source ?? mount.source), destination: String(mount.Destination ?? mount.destination), readOnly: mount.RW === undefined ? Boolean(mount.readOnly) : !Boolean(mount.RW) }; }),
    user: string(config.User ?? root.user, 'container user'), workingDir: string(config.WorkingDir ?? root.workingDir, 'container workdir'),
    networkMode: string(host.NetworkMode ?? root.networkMode, 'container network'), capDrop: (host.CapDrop ?? root.capDrop ?? []) as string[], capAdd: (host.CapAdd ?? root.capAdd ?? []) as string[],
    privileged: Boolean(host.Privileged ?? root.privileged), devices: (host.Devices ?? root.devices ?? []) as unknown[], securityOpt: (host.SecurityOpt ?? root.securityOpt ?? []) as string[],
    pidsLimit: Number(host.PidsLimit ?? root.pidsLimit), ulimits: ulimits.map((item) => { const limit = object(item, 'container ulimit'); return { name: String(limit.Name ?? limit.name), soft: Number(limit.Soft ?? limit.soft), hard: Number(limit.Hard ?? limit.hard) }; }),
    environment: normalizedEnvironment(config.Env ?? root.environment), running: Boolean(state.Running ?? root.running),
  };
}

function validateInspection(actual: DockerInspection, options: DockerExecutorOptions): void {
  const expectedLabels = { [JOB_LABEL]: options.jobId, [MANIFEST_LABEL]: options.manifestSha256 };
  if (actual.id.length < 12 || actual.name !== options.containerName || actual.image !== options.imageReference || actual.imageDigest !== options.imageDigest) throw new DockerLifecycleError('Docker container identity or digest does not match the locked definition');
  if (!exactRecord(actual.labels, expectedLabels)) throw new DockerLifecycleError('Docker container labels do not match the locked definition');
  if (actual.architecture !== 'amd64' || actual.os !== 'linux') throw new DockerLifecycleError('Docker container architecture does not match linux/amd64');
  if (actual.mounts.length !== 1 || actual.mounts[0]!.type !== 'bind' || actual.mounts[0]!.source !== options.worktreePath || actual.mounts[0]!.destination !== '/workdir' || actual.mounts[0]!.readOnly) throw new DockerLifecycleError('Docker container mount does not match the locked worktree bind');
  if (actual.user !== `${options.uid}:${options.gid}` || actual.workingDir !== '/workdir' || actual.networkMode !== 'bridge') throw new DockerLifecycleError('Docker container user, workdir, or network does not match');
  if (JSON.stringify(actual.capDrop) !== JSON.stringify(['ALL']) || actual.capAdd.length !== 0 || actual.privileged || actual.devices.length !== 0 || actual.securityOpt.length !== 1 || actual.securityOpt[0] !== 'no-new-privileges:true' || actual.pidsLimit !== 4096 || JSON.stringify(actual.ulimits) !== JSON.stringify([{ name: 'nofile', soft: 1024, hard: 4096 }])) throw new DockerLifecycleError('Docker container security does not match the locked definition');
  const expectedEnvironment = env(options);
  if (Object.keys(actual.environment).length !== CONTAINER_ENV_KEYS.length || !exactRecord(actual.environment, expectedEnvironment)) throw new DockerLifecycleError('Docker container environment is not the exact fixed environment');
}

function runnerCommand(options: DockerExecutorOptions, commandValue: RunnerWriteCommand): void {
  if (!options.ownership || !options.runner) throw new DockerLifecycleError('Docker lifecycle needs runner ownership context');
  const result = options.ownership.runnerWrite(commandValue);
  if (!result.ok) throw new DockerLifecycleError(`runner ownership write was not committed: ${result.kind ?? 'unknown'}`);
}

function operationError(message: string): JsonObject { return { code: 'DOCKER_EXECUTION_DEFINITION_MISMATCH', message }; }

export function createDockerExecutor(options: DockerExecutorOptions) {
  return {
    async run(): Promise<DockerExecutionResult> {
      const executor = options.commandExecutor ?? createCommandExecutor();
      let version: CommandResult;
      try { version = await executor.run([options.dockerPath, 'version', '--format', '{{json .}}'], { env: dockerEnv() }); }
      catch (error) { if (['ENOENT', 'EACCES', 'ECONNREFUSED'].includes(String((error as { code?: string }).code))) return { available: false, mutationCount: 0, reason: 'docker-unavailable' }; throw error; }
      if (version.exitCode !== 0 || version.signal !== null || version.timedOut) return { available: false, mutationCount: 0, reason: 'docker-unavailable' };
      if (!options.ownership || !options.runner) throw new DockerLifecycleError('Docker lifecycle needs runner ownership context');
      const initial = options.ownership.getJob(options.jobId);
      if ([initial.containerId, initial.containerName, initial.containerImageDigest, initial.containerLabelJobId, initial.containerLabelManifestSha, initial.containerLabels, initial.containerMount, initial.containerEnvironment, initial.containerSecurity, initial.containerInspection, initial.containerCreatedAt].some((value) => value !== null)) throw new DockerLifecycleError('persisted Docker identity is not clear before create');
      const labelList = await command(options, ['ps', '--all', `--filter=label=${JOB_LABEL}=${options.jobId}`, '--format={{.ID}}']);
      if (!noLabel(requireSuccess(labelList, 'Docker label preflight'))) throw new DockerLifecycleError('a Docker container already owns this job label');
      const startedAt = options.clock?.() ?? new Date().toISOString();
      const argvHash = hashOperationArgv(options.operationArgv);
      runnerCommand(options, { kind: 'operation-begin', jobId: options.jobId, owner: options.runner.owner, runnerUnit: options.runner.unit, leaseExpiresAt: options.runner.leaseExpiresAt, at: startedAt, expectedState: options.runner.expectedState, operationId: options.operationId, attempt: options.attempt, argvHash, argv: options.operationArgv, startedAt });
      let containerId: string | null = null;
      let inspection: DockerInspection;
      let startResult: CommandResult | null = null;
      try {
        const labels = { [JOB_LABEL]: options.jobId, [MANIFEST_LABEL]: options.manifestSha256 };
        const createResult = await command(options, ['create', `--name=${options.containerName}`, `--label=${JOB_LABEL}=${options.jobId}`, `--label=${MANIFEST_LABEL}=${options.manifestSha256}`, `--mount=type=bind,source=${options.worktreePath},destination=/workdir,rw`, `--user=${options.uid}:${options.gid}`, '--workdir=/workdir', '--network=bridge', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--pids-limit=4096', '--ulimit=nofile=1024:4096', '--pull=never', ...Object.entries(env(options)).map(([key, value]) => `--env=${key}=${value}`), options.imageReference, ...options.operationArgv]);
        containerId = parseContainerId(requireSuccess(createResult, 'Docker create'));
        const inspectResult = await command(options, ['inspect', '--type=container', '--format={{json .}}', containerId]);
        inspection = normalizeInspection(JSON.parse(requireSuccess(inspectResult, 'Docker inspect')));
        validateInspection(inspection, options);
        const containerAt = options.clock?.() ?? new Date().toISOString();
        runnerCommand(options, { kind: 'container', jobId: options.jobId, owner: options.runner.owner, runnerUnit: options.runner.unit, leaseExpiresAt: options.runner.leaseExpiresAt, at: containerAt, lifecycle: 'created', containerId, containerName: options.containerName, imageDigest: options.imageDigest, labels, mount: { type: 'bind', source: options.worktreePath, destination: '/workdir', readOnly: false }, environment: env(options), security: { capDrop: ['ALL'], capAdd: [], devices: [], sockets: [], privileged: false, noNewPrivileges: true, pidsLimit: 4096, ulimit: 'nofile=1024:4096', user: `${options.uid}:${options.gid}`, workdir: '/workdir', network: 'bridge' }, inspection: inspection as unknown as JsonObject, occurredAt: containerAt, createdAt: containerAt });
        const startedAtContainer = options.clock?.() ?? new Date().toISOString();
        runnerCommand(options, { kind: 'container', jobId: options.jobId, owner: options.runner.owner, runnerUnit: options.runner.unit, leaseExpiresAt: options.runner.leaseExpiresAt, at: startedAtContainer, lifecycle: 'started', containerId, containerName: options.containerName, imageDigest: options.imageDigest, labels, mount: { type: 'bind', source: options.worktreePath, destination: '/workdir', readOnly: false }, environment: env(options), security: { capDrop: ['ALL'], capAdd: [], devices: [], sockets: [], privileged: false, noNewPrivileges: true, pidsLimit: 4096, ulimit: 'nofile=1024:4096', user: `${options.uid}:${options.gid}`, workdir: '/workdir', network: 'bridge' }, inspection: inspection as unknown as JsonObject, occurredAt: startedAtContainer, createdAt: containerAt, startedAt: startedAtContainer });
        startResult = await command(options, ['start', '--attach', containerId], { onStdout: options.onStdout, onStderr: options.onStderr });
        const stoppedAt = options.clock?.() ?? new Date().toISOString();
        runnerCommand(options, { kind: 'container', jobId: options.jobId, owner: options.runner.owner, runnerUnit: options.runner.unit, leaseExpiresAt: options.runner.leaseExpiresAt, at: stoppedAt, lifecycle: 'stopped', containerId, containerName: options.containerName, imageDigest: options.imageDigest, labels, mount: { type: 'bind', source: options.worktreePath, destination: '/workdir', readOnly: false }, environment: env(options), security: { capDrop: ['ALL'], capAdd: [], devices: [], sockets: [], privileged: false, noNewPrivileges: true, pidsLimit: 4096, ulimit: 'nofile=1024:4096', user: `${options.uid}:${options.gid}`, workdir: '/workdir', network: 'bridge' }, inspection: inspection as unknown as JsonObject, occurredAt: stoppedAt, createdAt: containerAt, startedAt: startedAtContainer, stoppedAt });
        const outcome = startResult.exitCode === 0 && startResult.signal === null && !startResult.timedOut ? 'passed' : 'failed';
        const evidenceValue = { operationId: options.operationId, attempt: options.attempt, argv: options.operationArgv, argvHash, containerId, inspection, command: startResult, outcome } as unknown as JsonObject;
        const evidence = options.evidence ? await options.evidence(evidenceValue) : { path: `evidence/${options.operationId}-${options.attempt}.json`, sha256: hashOperationArgv([JSON.stringify(evidenceValue)]) };
        const finishedAt = options.clock?.() ?? new Date().toISOString();
        const completedInput = { operationId: options.operationId, attempt: options.attempt, argvHash, argv: options.operationArgv, startedAt, finishedAt, containerId, containerName: options.containerName, containerImageDigest: options.imageDigest, containerLabelJobId: options.jobId, containerLabelManifestSha: options.manifestSha256, containerMount: { type: 'bind', source: options.worktreePath, destination: '/workdir', readOnly: false }, containerEnvironment: env(options), containerSecurity: { capDrop: ['ALL'], capAdd: [], devices: [], sockets: [], privileged: false, noNewPrivileges: true, pidsLimit: 4096, ulimit: 'nofile=1024:4096' }, inspection: inspection as unknown as JsonObject, timedOut: startResult.timedOut, lifecyclePhase: 'stopped', exitCode: startResult.exitCode, signal: startResult.signal, outcome, evidencePath: evidence.path, evidenceSha256: evidence.sha256, ...(outcome === 'failed' ? { errorCode: 'BUILD_FAILED' as const, error: operationError('Docker operation exited unsuccessfully') } : {}) } as never;
        runnerCommand(options, { kind: 'operation-complete', jobId: options.jobId, owner: options.runner.owner, runnerUnit: options.runner.unit, leaseExpiresAt: options.runner.leaseExpiresAt, at: finishedAt, expectedState: options.runner.expectedState, operationId: options.operationId, attempt: options.attempt, input: completedInput });
        const removedAt = options.clock?.() ?? new Date().toISOString();
        const persisted = options.ownership.getJob(options.jobId);
        if (persisted.containerId !== containerId || persisted.containerName !== options.containerName) throw new DockerLifecycleError('persisted Docker identity changed before cleanup');
        const removeResult = await command(options, ['rm', persisted.containerId]);
        requireSuccess(removeResult, 'Docker rm');
        const absence = await command(options, ['inspect', '--type=container', '--format={{json .}}', containerId]);
        if (!(absence.exitCode !== 0 && /no such container/iu.test(`${absence.stderr}\n${absence.stdout}`))) throw new DockerLifecycleError('Docker rm did not prove exact container absence');
        const globalLabels = await command(options, ['ps', '--all', `--filter=label=${JOB_LABEL}=${options.jobId}`, '--format={{.ID}}']);
        if (!noLabel(requireSuccess(globalLabels, 'Docker cleanup label verification'))) throw new DockerLifecycleError('Docker cleanup left a matching job label');
        const logs = options.logs ?? ABSENT_LOGS;
        runnerCommand(options, { kind: 'operation-cleanup', jobId: options.jobId, owner: options.runner.owner, runnerUnit: options.runner.unit, leaseExpiresAt: options.runner.leaseExpiresAt, at: removedAt, expectedState: options.runner.expectedState, operationId: options.operationId, attempt: options.attempt, proof: { kind: 'container-removed', id: containerId, name: options.containerName, imageDigest: options.imageDigest, labels: { [JOB_LABEL]: options.jobId, [MANIFEST_LABEL]: options.manifestSha256 }, stoppedAt: stoppedAt, removedAt, observedAt: options.clock?.() ?? new Date().toISOString(), globalLabelResult: 'no-match', logs } } as never);
        return { available: true, outcome, containerId, exitCode: startResult.exitCode, mutationCount: 6 };
      } catch (error) {
        if (error instanceof DockerLifecycleError) throw error;
        throw new DockerLifecycleError('Docker lifecycle failed', { cause: error });
      }
    },
  };
}
