import { CommandExecutionError, createCommandExecutor, type CommandResult, type CommandRunOptions } from './command-executor.js';
import { createOperationDefinition, hashOperationDefinition, type OperationArgvContext, type OperationDefinition } from './operation-registry.js';
import { OFFLINE_OPERATION_IDS, parseCanonicalBuilderImageReference, READ_ONLY_OPERATION_IDS, selectExactRepositoryDigest } from '../../builder/validate-builder.js';
import type { BuilderErrorCode, JobState, TrustedOperationId } from '../../domain/types.js';
import type { LogCleanupProof, OperationCleanupProof, RunnerWriteCommand } from '../../api/src/ownership.js';
import type { JobRecord, JsonObject, OperationInput, StoredOperation } from '../../api/src/store.js';
import type { ActiveOperationCancellationAuthorization, CancellationBudget } from './cancellation.js';

const IMAGE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const JOB_LABEL = 'org.osi.image-builder.job-id';
const MANIFEST_LABEL = 'org.osi.image-builder.manifest-sha';
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;
const SAFE_ABSOLUTE_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const DOCKER_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*docker$/u;
const CONTAINER_NAME = /^osi-image-builder-[a-z0-9-]{8,64}$/u;
const DOCKER_CONTROL_TIMEOUT_MS = 30_000;

export interface DockerCommandExecutor {
  run(argv: readonly string[], options: CommandRunOptions): Promise<CommandResult>;
}

export interface DockerMount {
  readonly type: string;
  readonly source: string;
  readonly destination: string;
  readonly readOnly: boolean;
}

export interface DockerInspection {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly imageId: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly mounts: readonly DockerMount[];
  readonly user: string;
  readonly workingDir: string;
  readonly networkMode: string;
  readonly capDrop: readonly string[];
  readonly capAdd: readonly string[];
  readonly privileged: boolean;
  readonly devices: readonly JsonObject[];
  readonly securityOpt: readonly string[];
  readonly readonlyRootfs: boolean;
  readonly pidsLimit: number;
  readonly ulimits: readonly { readonly name: string; readonly soft: number; readonly hard: number }[];
  readonly environment: Readonly<Record<string, string>>;
  readonly running: boolean;
  readonly status: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly exitCode: number | null;
}

export interface ImageIdentity {
  readonly imageId: string;
  readonly imageDigest: string;
  readonly repoDigests: readonly string[];
  readonly architecture: 'amd64';
  readonly os: 'linux';
}

export interface DockerJobRead extends Pick<JobRecord,
  'sourceCommitTime' | 'containerId' | 'containerName' | 'containerImageDigest' | 'containerLabelJobId' |
  'containerLabelManifestSha' | 'containerLabels' | 'containerMount' | 'containerEnvironment' |
  'containerSecurity' | 'containerInspection' | 'containerCreatedAt' | 'containerStartedAt' |
  'containerStoppedAt' | 'containerRemovedAt' | 'containerCleanupOutcome'> {}

export interface BuilderStoreLike {
  getJob(jobId: string): DockerJobRead;
  getOperation?(jobId: string, operationId: TrustedOperationId, attempt: number): StoredOperation | OperationInput | null;
}

export interface OwnershipStoreLike {
  runnerWrite(command: RunnerWriteCommand): { readonly ok: boolean; readonly kind?: string; readonly eventSeq?: number };
}

export interface RunnerLeaseSnapshot {
  readonly owner: string;
  readonly unit: string;
  readonly leaseExpiresAt: string;
  readonly expectedState: JobState;
}

export interface LogFinalizeInput {
  readonly operationFinishedAt: string;
}

export interface PersistedContainerIdentity {
  readonly containerId: string | null;
  readonly containerName: string | null;
  readonly containerImageDigest: string | null;
  readonly containerLabelJobId: string | null;
  readonly containerLabelManifestSha: string | null;
  readonly containerLabels: JsonObject | null;
  readonly containerMount: JsonObject | null;
  readonly containerEnvironment: JsonObject | null;
  readonly containerSecurity: JsonObject | null;
  readonly containerInspection: JsonObject | null;
  readonly containerCreatedAt: string | null;
  readonly containerStartedAt: string | null;
  readonly containerStoppedAt: string | null;
  readonly containerRemovedAt: string | null;
  readonly containerCleanupOutcome: 'passed' | 'failed' | 'blocking' | null;
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
  readonly operationId: TrustedOperationId;
  readonly operationContext: OperationArgvContext;
  readonly operationTimeoutMs: number;
  readonly maxCaptureBytes: number;
  readonly containerName: string;
  readonly store: BuilderStoreLike;
  readonly ownership: OwnershipStoreLike;
  readonly leaseSnapshot: () => RunnerLeaseSnapshot;
  readonly clock?: () => string;
  readonly monotonicNow?: () => number;
  readonly evidence: (value: JsonObject) => Promise<{ readonly path: string; readonly sha256: string }>;
  readonly finalizeLogs: (input: LogFinalizeInput) => Promise<LogCleanupProof>;
  readonly cancellationBudget?: () => CancellationBudget;
  readonly authorizeCancellation?: () => Promise<ActiveOperationCancellationAuthorization>;
  readonly persistCancellationBlocker?: (reason: string) => Promise<void>;
  readonly classifyAcceptedResult?: (
    result: CommandResult,
  ) => 'expected-rootfs-already-present' | null;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}

export interface DockerCancellationControlOptions {
  readonly commandExecutor?: DockerCommandExecutor;
  readonly dockerPath: string;
  readonly expectedImageDigest: string;
  readonly maxCaptureBytes: number;
  readonly clock?: () => string;
  readonly monotonicNow?: () => number;
}

export interface DockerCancellationContainer {
  readonly id: string;
  readonly name: string;
  readonly imageDigest: string;
  readonly labels: JsonObject;
  readonly running: boolean;
  readonly status: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly stoppedAt: string | null;
}

export type DockerExecutionResult =
  | { readonly available: true; readonly outcome: 'passed' | 'failed' | 'accepted'; readonly containerId: string; readonly exitCode: number | null; readonly mutationCount: number }
  | { readonly available: false; readonly mutationCount: 0; readonly reason: 'docker-unavailable' };

export class DockerLifecycleError extends Error {
  readonly code = 'DOCKER_EXECUTION_DEFINITION_MISMATCH';
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'DockerLifecycleError'; }
}

export class DockerCancellationRequestedError extends Error {
  readonly code: 'CANCELLED' | 'DOCKER_CONTAINER_ORPHANED';
  readonly recoveryRequired: boolean;
  readonly recoveryPersisted: boolean;
  readonly blockerCode: 'RUNNER_DISAPPEARED' | 'DOCKER_CONTAINER_ORPHANED';

  constructor(
    message = 'Docker operation stopped cooperatively for cancellation',
    options: Readonly<{
      recoveryRequired?: boolean;
      recoveryPersisted?: boolean;
      blockerCode?: 'RUNNER_DISAPPEARED' | 'DOCKER_CONTAINER_ORPHANED';
    }> = {},
  ) {
    super(message);
    this.name = 'DockerCancellationRequestedError';
    this.recoveryRequired = options.recoveryRequired ?? false;
    this.recoveryPersisted = options.recoveryPersisted ?? false;
    this.blockerCode = options.blockerCode ?? 'DOCKER_CONTAINER_ORPHANED';
    this.code = this.recoveryRequired ? 'DOCKER_CONTAINER_ORPHANED' : 'CANCELLED';
  }
}

function cancellationControlBlocker(error: unknown): 'RUNNER_DISAPPEARED' | 'DOCKER_CONTAINER_ORPHANED' {
  return error !== null
    && typeof error === 'object'
    && (error as { readonly blockerCode?: unknown }).blockerCode === 'RUNNER_DISAPPEARED'
    ? 'RUNNER_DISAPPEARED'
    : 'DOCKER_CONTAINER_ORPHANED';
}

function fail(message: string): never { throw new DockerLifecycleError(message); }

function now(options: DockerExecutorOptions): string {
  return canonicalInstant(options.clock?.() ?? new Date().toISOString(), 'runner timestamp');
}

function monotonicNow(options: Pick<DockerExecutorOptions, 'monotonicNow'> | Pick<DockerCancellationControlOptions, 'monotonicNow'>): number {
  const value = options.monotonicNow?.() ?? performance.now();
  if (!Number.isFinite(value) || value < 0) fail('Docker monotonic clock is invalid');
  return value;
}

function env(sourceDateEpoch: string): Readonly<Record<string, string>> {
  return { HOME: '/workdir/.builder-home', PATH: IMAGE_PATH, CARGO_BUILD_JOBS: '2', TZ: 'UTC', SOURCE_DATE_EPOCH: sourceDateEpoch };
}

function dockerEnv(): Readonly<Record<string, string>> {
  return { HOME: '/tmp/osi-image-builder-docker-home', PATH: IMAGE_PATH, LANG: 'C', LC_ALL: 'C' };
}

function runDocker(options: DockerExecutorOptions, args: readonly string[], callbacks: { readonly onStdout?: (chunk: string) => void; readonly onStderr?: (chunk: string) => void } = {}, commandOptions: Pick<CommandRunOptions, 'timeoutMs' | 'timeoutDisarmSignal'> & { readonly control?: boolean } = {}): Promise<CommandResult> {
  const executor = options.commandExecutor ?? createCommandExecutor();
  return executor.run([options.dockerPath, ...args], {
    env: dockerEnv(),
    maxCaptureBytes: options.maxCaptureBytes,
    timeoutMs: commandOptions.timeoutMs ?? DOCKER_CONTROL_TIMEOUT_MS,
    timeoutDisarmSignal: commandOptions.timeoutDisarmSignal,
    onStdout: callbacks.onStdout,
    onStderr: callbacks.onStderr,
  }).catch((error) => {
    if (commandOptions.control !== false && error instanceof CommandExecutionError && error.result?.timedOut) throw new DockerLifecycleError('Docker control command timed out', { cause: error });
    throw error;
  });
}

function requireSuccess(result: CommandResult, action: string): string {
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut) fail(`${action} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function cancellationCommand(options: DockerCancellationControlOptions, args: readonly string[], timeoutMs = DOCKER_CONTROL_TIMEOUT_MS): Promise<CommandResult> {
  const executor = options.commandExecutor ?? createCommandExecutor();
  return executor.run([options.dockerPath, ...args], {
    env: dockerEnv(),
    maxCaptureBytes: options.maxCaptureBytes,
    timeoutMs,
  });
}

function cancellationInspection(stdout: string, expectedImageDigest: string): DockerCancellationContainer {
  const parsed = parseJson(stdout, 'Docker cancellation inspect');
  const root = Array.isArray(parsed) ? parsed.length === 1 ? record(parsed[0], 'Docker cancellation inspect') : fail('Docker cancellation inspect returned an invalid number of containers') : record(parsed, 'Docker cancellation inspect');
  const config = record(root.Config ?? root.config, 'Docker cancellation Config');
  const state = record(root.State ?? root.state, 'Docker cancellation State');
  const rawLabels = record(config.Labels ?? root.labels, 'Docker cancellation labels');
  const labels: JsonObject = Object.fromEntries(Object.entries(rawLabels).map(([key, value]) => [key, requiredString(value, `Docker cancellation label ${key}`)]));
  const image = requiredString(config.Image ?? root.image, 'Docker cancellation image');
  const match = /@sha256:([0-9a-f]{64})$/u.exec(image);
  if (match === null || match[1] !== expectedImageDigest) fail('Docker cancellation image digest does not match the locked image');
  const finishedAt = normalizeDockerInstant(state.FinishedAt ?? state.finishedAt, 'Docker cancellation FinishedAt', false);
  const createdAt = normalizeDockerInstant(root.Created ?? root.created, 'Docker cancellation Created', true);
  const startedAt = normalizeDockerInstant(state.StartedAt ?? state.startedAt, 'Docker cancellation StartedAt', false);
  return {
    id: requiredString(root.Id ?? root.id, 'Docker cancellation ID'),
    name: requiredString(root.Name ?? root.name, 'Docker cancellation name').replace(/^\//u, ''),
    imageDigest: match[1],
    labels,
    running: requiredBoolean(state.Running ?? state.running, 'Docker cancellation Running'),
    status: requiredString(state.Status ?? state.status, 'Docker cancellation Status'),
    createdAt: createdAt!,
    startedAt,
    stoppedAt: finishedAt,
  };
}

export function createDockerCancellationControls(options: DockerCancellationControlOptions) {
  const remainingBudget = (deadline: number, action: string): number => {
    if (!Number.isFinite(deadline) || deadline < 0) fail(`${action} deadline is invalid`);
    const remaining = Math.max(0, Math.ceil(deadline - monotonicNow(options)));
    if (remaining < 1) throw new DockerLifecycleError(`${action} exceeded the cooperative deadline`);
    if (remaining > DOCKER_CONTROL_TIMEOUT_MS) fail(`${action} deadline exceeds the cooperative budget`);
    return remaining;
  };
  const inspect = async (containerId: string, deadline: number): Promise<DockerCancellationContainer | null> => {
    const timeoutMs = remainingBudget(deadline, 'Docker cancellation inspect');
    const response = await cancellationCommand(options, ['inspect', '--type=container', '--format={{json .}}', containerId], timeoutMs);
    if (response.exitCode !== 0 && /no such container/iu.test(`${response.stderr}\n${response.stdout}`)) return null;
    return cancellationInspection(requireSuccess(response, 'Docker cancellation inspect'), options.expectedImageDigest);
  };
  const listByLabels = async (labels: JsonObject, deadline: number): Promise<readonly DockerCancellationContainer[]> => {
    const jobId = requiredString(labels[JOB_LABEL], `Docker cancellation filter ${JOB_LABEL}`);
    const response = await cancellationCommand(
      options,
      ['ps', '--all', `--filter=label=${JOB_LABEL}=${jobId}`, '--format={{.ID}}'],
      remainingBudget(deadline, 'Docker cancellation label query'),
    );
    const ids = requireSuccess(response, 'Docker cancellation label query').split(/\r?\n/u).map((value) => value.trim()).filter((value) => value.length > 0);
    const containers: Array<DockerCancellationContainer | null> = [];
    for (const id of ids) containers.push(await inspect(id, deadline));
    return containers.filter((value): value is DockerCancellationContainer => value !== null);
  };
  const stop = async (containerId: string, deadline: number): Promise<void> => {
    const timeoutMs = remainingBudget(deadline, 'Docker cooperative stop');
    const graceSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
    requireSuccess(await cancellationCommand(options, ['stop', `--time=${graceSeconds}`, containerId], timeoutMs), 'Docker cooperative stop');
  };
  const waitForStopped = async (containerId: string, deadline: number): Promise<DockerCancellationContainer> => {
    while (true) {
      remainingBudget(deadline, 'Docker stopped proof');
      const value = await inspect(containerId, deadline);
      if (value === null) throw new DockerLifecycleError('Docker container disappeared while waiting for cooperative stop');
      if (!value.running) return value;
      if (monotonicNow(options) >= deadline) throw new DockerLifecycleError('Docker container did not stop within the cooperative deadline');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const remove = async (containerId: string, deadline: number): Promise<void> => {
    const response = await cancellationCommand(options, ['rm', containerId], remainingBudget(deadline, 'Docker cancellation rm'));
    if (response.exitCode !== 0 && !/no such container/iu.test(`${response.stderr}\n${response.stdout}`)) requireSuccess(response, 'Docker cancellation rm');
  };
  return Object.freeze({ inspect, stop, waitForStopped, remove, listByLabels });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${field} is not an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${field} is missing`);
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(`${field} is missing or invalid`);
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${field} is missing or invalid`);
  return value;
}

function exactRecord(actual: Readonly<Record<string, string>>, expected: Readonly<Record<string, string>>): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) && expectedKeys.every((key) => actual[key] === expected[key]);
}

function parseJson(stdout: string, action: string): unknown {
  try { return JSON.parse(stdout); } catch (error) { throw new DockerLifecycleError(`${action} returned invalid JSON`, { cause: error }); }
}

function normalizeEnvironment(value: unknown): Readonly<Record<string, string>> {
  if (!Array.isArray(value)) {
    const objectValue = record(value, 'container environment');
    return Object.fromEntries(Object.entries(objectValue).map(([key, item]) => [key, requiredString(item, `container environment ${key}`)]));
  }
  const result: Record<string, string> = {};
  for (const item of value) {
    const text = requiredString(item, 'container environment entry');
    const index = text.indexOf('=');
    if (index < 1) fail('container environment entry is malformed');
    const key = text.slice(0, index);
    if (key in result) fail(`container environment contains duplicate ${key}`);
    result[key] = text.slice(index + 1);
  }
  return result;
}

function normalizeMounts(value: unknown): readonly DockerMount[] {
  if (!Array.isArray(value)) fail('container mounts are missing');
  return value.map((item) => {
    const mount = record(item, 'container mount');
    const rw = mount.RW;
    return {
      type: requiredString(mount.Type ?? mount.type, 'container mount type'),
      source: requiredString(mount.Source ?? mount.source, 'container mount source'),
      destination: requiredString(mount.Destination ?? mount.destination, 'container mount destination'),
      readOnly: rw === undefined ? requiredBoolean(mount.readOnly, 'container mount readOnly') : !requiredBoolean(rw, 'container mount RW'),
    };
  });
}

function normalizeNullableStringArray(value: unknown, field: string): readonly string[] {
  if (value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) fail(`${field} is missing or invalid`);
  return value;
}

function normalizeNullableDevices(value: unknown): readonly JsonObject[] {
  if (value === null) return [];
  if (!Array.isArray(value)) fail('container devices are missing or invalid');
  return value.map((item) => record(item, 'container device') as JsonObject);
}

function normalizeDockerInstant(value: unknown, field: string, required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required) fail(`${field} is missing`);
    return null;
  }
  const text = requiredString(value, field);
  if (/^0001-01-01T00:00:00(?:\.0+)?Z$/u.test(text)) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(text)) fail(`${field} is not an RFC3339 instant`);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) fail(`${field} is not a valid instant`);
  return new Date(parsed).toISOString();
}

function normalizeExitCode(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail('container exit code is missing or invalid');
  return Number(value);
}

function normalizeInspection(value: unknown): DockerInspection {
  const root = Array.isArray(value) ? (value.length === 1 ? record(value[0], 'docker inspect result') : fail('docker inspect must return exactly one container')) : record(value, 'docker inspect result');
  if (root.Config === undefined && root.config === undefined && root.imageId !== undefined) {
    const direct = root as unknown as DockerInspection;
    if (!Array.isArray(direct.mounts) || !Array.isArray(direct.capDrop) || !Array.isArray(direct.capAdd) || !Array.isArray(direct.devices) || !Array.isArray(direct.securityOpt) || !Array.isArray(direct.ulimits) || !direct.environment || typeof direct.readonlyRootfs !== 'boolean' || typeof direct.pidsLimit !== 'number' || !Number.isFinite(direct.pidsLimit) || typeof direct.status !== 'string' || typeof direct.createdAt !== 'string' || (direct.startedAt !== null && typeof direct.startedAt !== 'string') || (direct.finishedAt !== null && typeof direct.finishedAt !== 'string') || (direct.exitCode !== null && !Number.isSafeInteger(direct.exitCode)) || direct.ulimits.some((limit) => typeof limit !== 'object' || limit === null || typeof limit.name !== 'string' || typeof limit.soft !== 'number' || typeof limit.hard !== 'number' || !Number.isFinite(limit.soft) || !Number.isFinite(limit.hard))) fail('normalized Docker inspection is incomplete');
    if (normalizeDockerInstant(direct.createdAt, 'normalized Docker Created', true) === null) fail('normalized Docker Created cannot be a zero instant');
    if (direct.startedAt !== null) canonicalInstant(direct.startedAt, 'normalized Docker StartedAt');
    if (direct.finishedAt !== null) canonicalInstant(direct.finishedAt, 'normalized Docker FinishedAt');
    return direct;
  }
  const config = record(root.Config ?? root.config, 'docker inspect Config');
  const host = record(root.HostConfig ?? root.hostConfig, 'docker inspect HostConfig');
  const state = record(root.State ?? root.state, 'docker inspect State');
  const rawLabels = config.Labels ?? root.labels;
  const labels = record(rawLabels, 'container labels') as Record<string, string>;
  for (const value of Object.values(labels)) requiredString(value, 'container label');
  const rawUlimits = host.Ulimits ?? root.ulimits;
  if (!Array.isArray(rawUlimits)) fail('container ulimits are missing');
  const createdAt = normalizeDockerInstant(root.Created ?? root.createdAt, 'container Created', true);
  if (createdAt === null) fail('container Created cannot be a zero instant');
  return {
    id: requiredString(root.Id ?? root.id, 'container ID'),
    name: requiredString(root.Name ?? root.name, 'container name').replace(/^\//u, ''),
    image: requiredString(config.Image ?? root.image, 'container Config.Image'),
    imageId: requiredString(root.Image ?? root.imageId, 'container image ID'),
    labels,
    mounts: normalizeMounts(root.Mounts ?? root.mounts),
    user: requiredString(config.User ?? root.user, 'container user'),
    workingDir: requiredString(config.WorkingDir ?? root.workingDir, 'container workdir'),
    networkMode: requiredString(host.NetworkMode ?? root.networkMode, 'container network'),
    capDrop: normalizeNullableStringArray(host.CapDrop === undefined ? root.capDrop : host.CapDrop, 'container cap-drop'),
    capAdd: normalizeNullableStringArray(host.CapAdd === undefined ? root.capAdd : host.CapAdd, 'container cap-add'),
    privileged: requiredBoolean(host.Privileged ?? root.privileged, 'container privileged'),
    devices: normalizeNullableDevices(host.Devices === undefined ? root.devices : host.Devices),
    securityOpt: Array.isArray(host.SecurityOpt ?? root.securityOpt) ? (host.SecurityOpt ?? root.securityOpt) as string[] : fail('container security options are missing'),
    readonlyRootfs: requiredBoolean(host.ReadonlyRootfs ?? root.readonlyRootfs, 'container readonly rootfs'),
    pidsLimit: requiredNumber(host.PidsLimit ?? root.pidsLimit, 'container pids limit'),
    ulimits: rawUlimits.map((item) => { const limit = record(item, 'container ulimit'); return { name: requiredString(limit.Name ?? limit.name, 'container ulimit name'), soft: requiredNumber(limit.Soft ?? limit.soft, 'container ulimit soft'), hard: requiredNumber(limit.Hard ?? limit.hard, 'container ulimit hard') }; }),
    environment: normalizeEnvironment(config.Env ?? root.environment),
    running: requiredBoolean(state.Running ?? root.running, 'container running state'),
    status: requiredString(state.Status ?? state.status ?? root.status, 'container status'),
    createdAt,
    startedAt: normalizeDockerInstant(state.StartedAt ?? state.startedAt ?? root.startedAt, 'container State.StartedAt', false),
    finishedAt: normalizeDockerInstant(state.FinishedAt ?? state.finishedAt ?? root.finishedAt, 'container State.FinishedAt', false),
    exitCode: normalizeExitCode(state.ExitCode ?? state.exitCode ?? root.exitCode),
  };
}

function canonicalInstant(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || new Date(value).toISOString() !== value) fail(`${field} is not a canonical instant`);
  return value;
}

function sourceDateEpoch(sourceCommitTime: string): string {
  const instant = canonicalInstant(sourceCommitTime, 'source commit time');
  const seconds = Math.floor(Date.parse(instant) / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) fail('source commit time cannot become SOURCE_DATE_EPOCH');
  return String(seconds);
}

function validateOptions(options: DockerExecutorOptions): OperationDefinition {
  if (!DOCKER_PATH.test(options.dockerPath) || options.dockerPath.includes('..')) fail('docker path is not canonical');
  if (!SAFE_ID.test(options.jobId) || !HASH.test(options.manifestSha256) || !Number.isSafeInteger(options.attempt) || options.attempt < 1) fail('job identity is invalid');
  if (!SAFE_ABSOLUTE_PATH.test(options.worktreePath) || options.worktreePath.includes('..') || options.worktreePath.includes('//') || options.worktreePath.includes(',')) fail('worktree path is not a safe canonical absolute path');
  if (!Number.isSafeInteger(options.uid) || options.uid < 0 || options.uid > 65535 || !Number.isSafeInteger(options.gid) || options.gid < 0 || options.gid > 65535) fail('UID/GID is invalid');
  if (!CONTAINER_NAME.test(options.containerName)) fail('container name is invalid');
  if (!Number.isSafeInteger(options.operationTimeoutMs) || options.operationTimeoutMs < 1) fail('operation timeout is invalid');
  if (!Number.isSafeInteger(options.maxCaptureBytes) || options.maxCaptureBytes < 1 || options.maxCaptureBytes > 16 * 1024 * 1024) fail('operation capture limit is invalid');
  if (typeof options.evidence !== 'function') fail('immutable evidence writer is required');
  if (typeof options.finalizeLogs !== 'function') fail('internal log finalizer is required');
  if (
    options.classifyAcceptedResult !== undefined
    && (
      typeof options.classifyAcceptedResult !== 'function'
      || options.operationId !== 'activate-target'
    )
  ) fail('accepted operation classifier is outside the trusted activate-target contract');
  if (typeof options.store?.getJob !== 'function' || typeof options.ownership?.runnerWrite !== 'function' || typeof options.leaseSnapshot !== 'function') fail('typed builder store, ownership store, and lease provider are required');
  let canonical;
  try { canonical = parseCanonicalBuilderImageReference(options.imageReference); } catch (error) { throw new DockerLifecycleError('image reference is not canonical', { cause: error }); }
  if (canonical.imageDigest !== options.imageDigest || !HASH.test(options.imageDigest)) fail('image digest does not match canonical image reference');
  try { return createOperationDefinition(options.operationId, options.operationContext); }
  catch (error) { throw new DockerLifecycleError('operation ID or context is not trusted and canonical', { cause: error }); }
}

function parseServer(stdout: string): void {
  const root = record(parseJson(stdout, 'docker version'), 'docker version response');
  const server = record(root.Server ?? root.server, 'docker server response');
  if (server.Os !== 'linux' || server.Arch !== 'amd64') fail('Docker server is not reachable as linux/amd64');
}

function inspectImage(stdout: string, options: DockerExecutorOptions): ImageIdentity {
  const values = parseJson(stdout, 'docker image inspect');
  if (Array.isArray(values)) fail('docker image inspect must return exactly one image object');
  const image = record(values, 'docker image inspect result');
  const imageId = requiredString(image.Id, 'Docker image ID');
  if (!IMAGE_ID.test(imageId)) fail('Docker image ID is invalid');
  const repoDigests = image.RepoDigests;
  if (!Array.isArray(repoDigests) || repoDigests.some((item) => typeof item !== 'string')) fail('Docker image RepoDigests are invalid');
  let selected: string;
  try { selected = selectExactRepositoryDigest(options.imageReference, repoDigests); } catch (error) { throw new DockerLifecycleError('Docker image RepoDigest is not the exact locked digest', { cause: error }); }
  if (selected !== options.imageDigest || image.Architecture !== 'amd64' || image.Os !== 'linux') fail('Docker image preflight is not exact linux/amd64');
  return { imageId, imageDigest: selected, repoDigests: [...repoDigests], architecture: 'amd64', os: 'linux' };
}

function noLabel(stdout: string): boolean { return stdout.split(/\r?\n/u).every((line) => line.trim().length === 0); }

function operationNetworkMode(options: DockerExecutorOptions): 'bridge' | 'none' {
  return (OFFLINE_OPERATION_IDS as readonly string[]).includes(options.operationId) ? 'none' : 'bridge';
}

function operationReadOnly(options: DockerExecutorOptions): boolean {
  return (READ_ONLY_OPERATION_IDS as readonly string[]).includes(options.operationId);
}

function worktreeMount(options: DockerExecutorOptions): JsonObject {
  return {
    type: 'bind',
    source: options.worktreePath,
    destination: '/workdir',
    readOnly: operationReadOnly(options),
  };
}

function worktreeMountArgument(options: DockerExecutorOptions): string {
  return `--mount=type=bind,source=${options.worktreePath},destination=/workdir${
    operationReadOnly(options) ? ',readonly' : ''
  }`;
}

function validateStartResult(result: CommandResult, expectedArgv: readonly string[]): { readonly startedAt: string; readonly finishedAt: string } {
  if (!Array.isArray(result.argv) || JSON.stringify(result.argv) !== JSON.stringify(expectedArgv) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || typeof result.timedOut !== 'boolean' || (typeof result.exitCode !== 'number' && result.exitCode !== null) || (typeof result.signal !== 'string' && result.signal !== null)) fail('Docker start returned an incomplete command result');
  const startedAt = canonicalInstant(result.startedAt, 'Docker start startedAt');
  const finishedAt = canonicalInstant(result.finishedAt, 'Docker start finishedAt');
  if (Date.parse(finishedAt) < Date.parse(startedAt)) fail('Docker start command timestamps are not chronological');
  return { startedAt, finishedAt };
}

function startFailure(result: CommandResult): CommandExecutionError | null {
  if (!result.timedOut && result.signal === null && result.exitCode === 0) return null;
  return new CommandExecutionError('Docker start --attach returned an unsuccessful result', { result });
}

function containerId(stdout: string): string {
  const values = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (values.length !== 1 || !/^[a-f0-9]{12,64}$/u.test(values[0]!)) fail('docker create returned an invalid container ID');
  return values[0]!;
}

type InspectionPhase = 'created' | 'recovery';

function validateInspection(actual: DockerInspection, createdId: string, image: ImageIdentity, definition: OperationDefinition, options: DockerExecutorOptions, sourceEpoch: string, phase: InspectionPhase): void {
  const labels = { [JOB_LABEL]: options.jobId, [MANIFEST_LABEL]: options.manifestSha256 };
  if (actual.id !== createdId || actual.name !== options.containerName || actual.image !== options.imageReference || actual.imageId !== image.imageId) fail('Docker container identity or image proof does not match the locked definition');
  if (!exactRecord(actual.labels, labels)) fail('Docker container labels do not match');
  if (actual.mounts.length !== 1 || actual.mounts[0]!.type !== 'bind' || actual.mounts[0]!.source !== options.worktreePath || actual.mounts[0]!.destination !== '/workdir' || actual.mounts[0]!.readOnly !== operationReadOnly(options)) fail('Docker container mount does not match the locked worktree bind');
  if (actual.user !== `${options.uid}:${options.gid}` || actual.workingDir !== definition.workingDirectory || actual.networkMode !== operationNetworkMode(options)) fail('Docker container user, workdir, or network does not match');
  if (JSON.stringify(actual.capDrop) !== JSON.stringify(['ALL']) || actual.capAdd.length !== 0 || actual.privileged || actual.devices.length !== 0 || actual.securityOpt.length !== 1 || actual.securityOpt[0] !== 'no-new-privileges:true' || actual.readonlyRootfs !== operationReadOnly(options) || actual.pidsLimit !== 4096 || JSON.stringify(actual.ulimits) !== JSON.stringify([{ name: 'nofile', soft: 1024, hard: 4096 }])) fail('Docker container security does not match the locked definition');
  if (!exactRecord(actual.environment, env(sourceEpoch))) fail('Docker container environment is not the exact fixed environment');
  if (phase === 'created') {
    if (actual.running || actual.status !== 'created' || actual.startedAt !== null || actual.finishedAt !== null || (actual.exitCode !== null && actual.exitCode !== 0)) fail('Docker create did not produce a pristine created container');
  } else if (actual.running) {
    if (actual.status !== 'running' || actual.startedAt === null || actual.finishedAt !== null) fail('running Docker inspection is incoherent');
  } else if (actual.status === 'created') {
    if (actual.startedAt !== null || actual.finishedAt !== null) fail('created Docker inspection shows execution evidence');
  } else if (actual.status !== 'exited' || actual.startedAt === null || actual.finishedAt === null || actual.exitCode === null) {
    fail('stopped Docker inspection lacks coherent execution evidence');
  }
  if (actual.startedAt !== null && Date.parse(actual.startedAt) < Date.parse(actual.createdAt)) fail('Docker lifecycle timestamps are not chronological');
  if (actual.finishedAt !== null && (actual.startedAt === null || Date.parse(actual.finishedAt) < Date.parse(actual.startedAt))) fail('Docker lifecycle timestamps are not chronological');
}

function inspectionJson(actual: DockerInspection, image: ImageIdentity): JsonObject {
  const mounts: readonly JsonObject[] = actual.mounts.map((mount) => ({ type: mount.type, source: mount.source, destination: mount.destination, readOnly: mount.readOnly }));
  const ulimits: readonly JsonObject[] = actual.ulimits.map((limit) => ({ name: limit.name, soft: limit.soft, hard: limit.hard }));
  const imageEvidence: JsonObject = { imageId: image.imageId, imageDigest: image.imageDigest, repoDigests: image.repoDigests, architecture: image.architecture, os: image.os };
  return { container: { id: actual.id, name: actual.name, configImage: actual.image, rootImageId: actual.imageId, labels: actual.labels, mounts, user: actual.user, workingDir: actual.workingDir, networkMode: actual.networkMode, capDrop: actual.capDrop, capAdd: actual.capAdd, privileged: actual.privileged, devices: actual.devices, securityOpt: actual.securityOpt, readonlyRootfs: actual.readonlyRootfs, pidsLimit: actual.pidsLimit, ulimits, environment: actual.environment, running: actual.running, status: actual.status, dockerCreatedAt: actual.createdAt, dockerStartedAt: actual.startedAt, dockerFinishedAt: actual.finishedAt, dockerExitCode: actual.exitCode }, imagePreflight: imageEvidence };
}

function lease(options: DockerExecutorOptions): RunnerLeaseSnapshot {
  const value = options.leaseSnapshot();
  if (!value || typeof value.owner !== 'string' || typeof value.unit !== 'string' || typeof value.leaseExpiresAt !== 'string' || !value.expectedState) fail('lease provider returned an invalid snapshot');
  canonicalInstant(value.leaseExpiresAt, 'runner lease expiry');
  return value;
}

function runner(options: DockerExecutorOptions, build: (snapshot: RunnerLeaseSnapshot) => RunnerWriteCommand): void {
  const result = options.ownership.runnerWrite(build(lease(options)));
  if (!result.ok) fail(`runner ownership write was not committed: ${result.kind ?? 'unknown'}`);
}

function security(options: DockerExecutorOptions, definition: OperationDefinition): JsonObject {
  return { capDrop: ['ALL'], capAdd: [], devices: [], sockets: [], privileged: false, noNewPrivileges: true, readonlyRootfs: operationReadOnly(options), pidsLimit: 4096, ulimit: 'nofile=1024:4096', user: `${options.uid}:${options.gid}`, workdir: definition.workingDirectory, network: operationNetworkMode(options) };
}

function containerCommand(options: DockerExecutorOptions, definition: OperationDefinition, sourceEpoch: string, snapshot: RunnerLeaseSnapshot, lifecycle: 'created' | 'started' | 'stopped', id: string, labels: JsonObject, inspection: JsonObject, occurredAt: string, createdAt: string, startedAt?: string | null, stoppedAt?: string | null): RunnerWriteCommand {
  return { kind: 'container', jobId: options.jobId, owner: snapshot.owner, runnerUnit: snapshot.unit, leaseExpiresAt: snapshot.leaseExpiresAt, at: occurredAt, lifecycle, containerId: id, containerName: options.containerName, imageDigest: options.imageDigest, labels, mount: worktreeMount(options), environment: env(sourceEpoch), security: security(options, definition), inspection, occurredAt, createdAt, startedAt, stoppedAt };
}

function identityIsNull(job: DockerJobRead): boolean {
  return [job.containerId, job.containerName, job.containerImageDigest, job.containerLabelJobId, job.containerLabelManifestSha, job.containerLabels, job.containerMount, job.containerEnvironment, job.containerSecurity, job.containerInspection, job.containerCreatedAt, job.containerStartedAt, job.containerStoppedAt, job.containerRemovedAt, job.containerCleanupOutcome].every((value) => value === null);
}

async function proveLabelAbsent(options: DockerExecutorOptions): Promise<string> {
  const labels = await runDocker(options, ['ps', '--all', `--filter=label=${JOB_LABEL}=${options.jobId}`, '--format={{.ID}}']);
  if (!noLabel(requireSuccess(labels, 'Docker label verification'))) fail('a Docker container still owns this job label');
  return now(options);
}

async function proveAbsent(options: DockerExecutorOptions, id: string): Promise<string> {
  const exact = await runDocker(options, ['inspect', '--type=container', '--format={{json .}}', id]);
  if (exact.exitCode === 0 || !/no such container/iu.test(`${exact.stderr}\n${exact.stdout}`)) fail('Docker rm did not prove exact container absence');
  return proveLabelAbsent(options);
}

function exactPersistedIdentity(options: DockerExecutorOptions, job: DockerJobRead): {
  readonly id: string;
  readonly labels: JsonObject;
  readonly stoppedAt: string;
} {
  const labels = {
    [JOB_LABEL]: options.jobId,
    [MANIFEST_LABEL]: options.manifestSha256,
  };
  if (
    job.containerId === null
    || job.containerName !== options.containerName
    || job.containerImageDigest !== options.imageDigest
    || job.containerLabelJobId !== options.jobId
    || job.containerLabelManifestSha !== options.manifestSha256
    || JSON.stringify(job.containerLabels) !== JSON.stringify(labels)
    || job.containerStoppedAt === null
  ) {
    fail('persisted Docker identity does not match the trusted operation');
  }
  return {
    id: job.containerId,
    labels,
    stoppedAt: canonicalInstant(job.containerStoppedAt, 'persisted container stoppedAt'),
  };
}

async function recoverRemovedContainer(
  options: DockerExecutorOptions,
  job: DockerJobRead,
): Promise<DockerExecutionResult> {
  const identity = exactPersistedIdentity(options, job);
  const operation = options.store.getOperation?.(
    options.jobId,
    options.operationId,
    options.attempt,
  );
  const operationFinishedAt = operation?.finishedAt;
  const operationOutcome = operation?.outcome;
  if (
    operation === undefined
    || operation === null
    || operation.operationId !== options.operationId
    || operation.attempt !== options.attempt
    || operationOutcome === undefined
    || operationOutcome === null
    || operationFinishedAt === undefined
    || operationFinishedAt === null
    || operation.containerId !== identity.id
    || operation.containerName !== options.containerName
    || operation.containerImageDigest !== options.imageDigest
    || operation.containerLabelJobId !== options.jobId
    || operation.containerLabelManifestSha !== options.manifestSha256
  ) {
    fail('persisted Docker operation does not bind retained cleanup identity');
  }
  const observedAt = await proveAbsent(options, identity.id);
  const logs = validateLogProof(
    await options.finalizeLogs({ operationFinishedAt }),
    operationFinishedAt,
  );
  if (logs.verifiedAt > observedAt) fail('log proof is from the future relative to recovered cleanup');
  const proof: OperationCleanupProof = {
    kind: 'container-absent',
    id: identity.id,
    name: options.containerName,
    imageDigest: options.imageDigest,
    labels: identity.labels,
    stoppedAt: identity.stoppedAt,
    observedAt,
    globalLabelResult: 'no-match',
    logs,
  };
  runner(options, (snapshot) => ({
    kind: 'operation-cleanup',
    jobId: options.jobId,
    owner: snapshot.owner,
    runnerUnit: snapshot.unit,
    leaseExpiresAt: snapshot.leaseExpiresAt,
    at: observedAt,
    expectedState: snapshot.expectedState,
    operationId: options.operationId,
    attempt: options.attempt,
    proof,
  }));
  return {
    available: true,
    outcome: operationOutcome,
    containerId: identity.id,
    exitCode: operation.exitCode ?? null,
    mutationCount: 1,
  };
}

async function cleanupOrphan(options: DockerExecutorOptions, id: string): Promise<{ readonly removedAt: string; readonly observedAt: string }> {
  const removed = await runDocker(options, ['rm', id]);
  requireSuccess(removed, 'Docker orphan cleanup');
  const removedAt = now(options);
  const observedAt = await proveAbsent(options, id);
  return { removedAt, observedAt };
}

async function inspectContainer(options: DockerExecutorOptions, definition: OperationDefinition, id: string, image: ImageIdentity, sourceEpoch: string, phase: InspectionPhase, timeoutMs?: number): Promise<{ readonly inspection: DockerInspection; readonly observedAt: string }> {
  const response = await runDocker(options, ['inspect', '--type=container', '--format={{json .}}', id], {}, { timeoutMs });
  const observedAt = now(options);
  const inspected = normalizeInspection(parseJson(requireSuccess(response, 'Docker inspect'), 'Docker inspect'));
  validateInspection(inspected, id, image, definition, options, sourceEpoch, phase);
  return { inspection: inspected, observedAt };
}

type RecoveryAction = 'inspect' | 'stop' | 'kill';

async function recoverStopped(options: DockerExecutorOptions, definition: OperationDefinition, id: string, image: ImageIdentity, sourceEpoch: string, primaryFailure: unknown | null, allowKill = true): Promise<{ readonly inspection: DockerInspection; readonly observedAt: string; readonly recoveryAttempted: boolean; readonly recoveryActions: readonly RecoveryAction[]; readonly recoveryFailures: readonly unknown[] }> {
  try {
    const actions: RecoveryAction[] = ['inspect'];
    let inspected = await inspectContainer(options, definition, id, image, sourceEpoch, 'recovery');
    if (!inspected.inspection.running) return { ...inspected, recoveryAttempted: false, recoveryActions: actions, recoveryFailures: [] };
    const failures: unknown[] = [];
    actions.push('stop');
    try { requireSuccess(await runDocker(options, ['stop', '--time=10', id]), 'Docker stop'); } catch (error) { failures.push(error); }
    actions.push('inspect');
    try {
      inspected = await inspectContainer(options, definition, id, image, sourceEpoch, 'recovery');
      if (!inspected.inspection.running) return { ...inspected, recoveryAttempted: true, recoveryActions: actions, recoveryFailures: failures };
    } catch (error) { failures.push(error); }
    if (!allowKill) {
      throw new AggregateError([...(primaryFailure === null ? [] : [primaryFailure]), ...failures], 'Docker attach ended and cooperative stop did not prove a stopped container');
    }
    actions.push('kill');
    try { requireSuccess(await runDocker(options, ['kill', id]), 'Docker kill escalation'); } catch (error) { failures.push(error); }
    actions.push('inspect');
    try {
      inspected = await inspectContainer(options, definition, id, image, sourceEpoch, 'recovery');
    } catch (error) {
      failures.push(error);
      throw new AggregateError([...(primaryFailure === null ? [] : [primaryFailure]), ...failures], 'Docker attach ended and recovery could not prove a final container state');
    }
    if (!inspected.inspection.running) return { ...inspected, recoveryAttempted: true, recoveryActions: actions, recoveryFailures: failures };
    failures.push(new DockerLifecycleError('Docker attach ended but the exact container could not be stopped'));
    throw new AggregateError([...(primaryFailure === null ? [] : [primaryFailure]), ...failures], 'Docker attach ended and recovery did not prove a stopped container');
  } catch (error) {
    if (primaryFailure !== null && !(error instanceof AggregateError)) throw new AggregateError([primaryFailure, error], 'Docker attach failed and stopped-state recovery failed');
    throw error;
  }
}

function failureCode(error: unknown): BuilderErrorCode {
  if (error instanceof DockerCancellationRequestedError) return error.code;
  return error instanceof DockerLifecycleError ? 'DOCKER_EXECUTION_DEFINITION_MISMATCH' : 'BUILD_FAILED';
}

function errorJson(error: unknown): JsonObject {
  return { code: failureCode(error), message: error instanceof Error ? error.message : String(error) };
}

function recoveryEvidence(errors: readonly unknown[]): readonly JsonObject[] {
  return errors.map((error) => errorJson(error));
}

function validateLogProof(proof: LogCleanupProof, operationFinishedAt: string): LogCleanupProof {
  if (!proof || !['absent', 'sealed'].includes(proof.runner) || !['absent', 'sealed'].includes(proof.docker)) fail('internal log finalizer returned incomplete proof');
  const verifiedAt = canonicalInstant(proof.verifiedAt, 'log proof verifiedAt');
  if (verifiedAt < operationFinishedAt) fail('log proof is stale');
  return { ...proof, verifiedAt };
}

async function completeNotCreated(options: DockerExecutorOptions, definition: OperationDefinition, sourceEpoch: string, argv: readonly string[], argvHash: string, startedAt: string, primary: unknown, cleanupEvidence: JsonObject | null, observedAt: string): Promise<void> {
  const finishedAt = now(options);
  const logs = validateLogProof(await options.finalizeLogs({ operationFinishedAt: finishedAt }), finishedAt);
  const evidence = await options.evidence({ operationId: options.operationId, attempt: options.attempt, argv, argvHash, workingDirectory: definition.workingDirectory, lifecyclePhase: 'not_created', outcome: 'failed', error: errorJson(primary), cleanup: cleanupEvidence ?? {} });
  const completionAt = now(options);
  if (logs.verifiedAt > completionAt) fail('log proof is from the future relative to operation completion');
  const input: OperationInput = { operationId: options.operationId, attempt: options.attempt, argvHash, argv, startedAt, finishedAt, timedOut: primary instanceof CommandExecutionError ? Boolean(primary.result?.timedOut) : false, lifecyclePhase: 'not_created', exitCode: primary instanceof CommandExecutionError ? primary.result?.exitCode ?? null : null, signal: primary instanceof CommandExecutionError ? primary.result?.signal ?? null : null, outcome: 'failed', evidencePath: evidence.path, evidenceSha256: evidence.sha256, errorCode: failureCode(primary), error: errorJson(primary) };
  runner(options, (snapshot) => ({ kind: 'operation-complete', jobId: options.jobId, owner: snapshot.owner, runnerUnit: snapshot.unit, leaseExpiresAt: snapshot.leaseExpiresAt, at: completionAt, expectedState: snapshot.expectedState, operationId: options.operationId, attempt: options.attempt, input }));
  const cleanupAt = now(options);
  if (observedAt > cleanupAt) fail('Docker null-identity observation is from the future relative to cleanup');
  if (logs.verifiedAt > cleanupAt) fail('log proof is from the future relative to cleanup');
  const proof: OperationCleanupProof = { kind: 'null-identity', container: { kind: 'absent', globalLabelResult: 'no-match', observedAt }, logs };
  runner(options, (snapshot) => ({ kind: 'operation-cleanup', jobId: options.jobId, owner: snapshot.owner, runnerUnit: snapshot.unit, leaseExpiresAt: snapshot.leaseExpiresAt, at: cleanupAt, expectedState: snapshot.expectedState, operationId: options.operationId, attempt: options.attempt, proof }));
  void sourceEpoch;
}

export function createDockerExecutor(options: DockerExecutorOptions) {
  return {
    async run(): Promise<DockerExecutionResult> {
      const definition = validateOptions(options);
      const argv = definition.argv;
      const executor = options.commandExecutor ?? createCommandExecutor();
      let version: CommandResult;
      try {
        version = await executor.run([options.dockerPath, 'version', '--format', '{{json .}}'], { env: dockerEnv(), maxCaptureBytes: options.maxCaptureBytes, timeoutMs: DOCKER_CONTROL_TIMEOUT_MS });
      } catch (error) {
        if ((error instanceof CommandExecutionError && error.result?.timedOut) || ['ENOENT', 'EACCES', 'ECONNREFUSED'].includes(String((error as { code?: string }).code))) return { available: false, mutationCount: 0, reason: 'docker-unavailable' };
        throw error;
      }
      if (version.exitCode !== 0 || version.signal !== null || version.timedOut) return { available: false, mutationCount: 0, reason: 'docker-unavailable' };
      parseServer(version.stdout);
      const image = inspectImage(requireSuccess(await runDocker(options, ['image', 'inspect', '--format={{json .}}', options.imageReference]), 'Docker image inspect'), options);
      const job = options.store.getJob(options.jobId);
      const sourceEpoch = sourceDateEpoch(job.sourceCommitTime);
      if (!identityIsNull(job)) return recoverRemovedContainer(options, job);
      await proveLabelAbsent(options);
      const startedAt = now(options);
      const argvHash = hashOperationDefinition(definition);
      runner(options, (snapshot) => ({ kind: 'operation-begin', jobId: options.jobId, owner: snapshot.owner, runnerUnit: snapshot.unit, leaseExpiresAt: snapshot.leaseExpiresAt, at: startedAt, expectedState: snapshot.expectedState, operationId: options.operationId, attempt: options.attempt, argvHash, argv, startedAt }));
      let id: string | null = null;
      let persisted = false;
      try {
        const labels: JsonObject = { [JOB_LABEL]: options.jobId, [MANIFEST_LABEL]: options.manifestSha256 };
        const created = await runDocker(options, ['create', `--name=${options.containerName}`, `--label=${JOB_LABEL}=${options.jobId}`, `--label=${MANIFEST_LABEL}=${options.manifestSha256}`, worktreeMountArgument(options), ...(operationReadOnly(options) ? ['--read-only'] : []), `--user=${options.uid}:${options.gid}`, `--workdir=${definition.workingDirectory}`, `--network=${operationNetworkMode(options)}`, '--platform=linux/amd64', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--pids-limit=4096', '--ulimit=nofile=1024:4096', '--pull=never', ...Object.entries(env(sourceEpoch)).map(([key, value]) => `--env=${key}=${value}`), options.imageReference, ...argv]);
        id = containerId(requireSuccess(created, 'Docker create'));
        const inspectedResult = await inspectContainer(options, definition, id, image, sourceEpoch, 'created');
        const inspected = inspectedResult.inspection;
        const inspectedJson = inspectionJson(inspected, image);
        const createdWriteAt = now(options);
        runner(options, (snapshot) => containerCommand(options, definition, sourceEpoch, snapshot, 'created', id!, labels, inspectedJson, createdWriteAt, inspected.createdAt));
        persisted = true;
        const startArgv = [options.dockerPath, 'start', '--attach', id];
        const attachTimeout = new AbortController();
        let cancellationControl: Promise<void> | null = null;
        let cancellationControlSettled = false;
        let cancellationControlError: unknown = null;
        let cancellationStopped: Awaited<ReturnType<typeof inspectContainer>> | null = null;
        let cancellationDeadline: number | null = null;
        let cancellationDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
        let resolveCancellationDeadline: (() => void) | null = null;
        const cancellationDeadlineReached = new Promise<void>((resolve) => {
          resolveCancellationDeadline = resolve;
        });
        const remainingCancellationBudget = (): number => {
          if (cancellationDeadline === null) return 0;
          return Math.max(0, Math.ceil(cancellationDeadline - monotonicNow(options)));
        };
        const requestCooperativeStop = (budget: CancellationBudget): void => {
          if (cancellationControl !== null) return;
          if (!budget.requested || budget.deadline === null || budget.remainingMs === null) {
            throw new DockerLifecycleError('coordinator cancellation budget is incomplete');
          }
          cancellationDeadline = budget.deadline;
          attachTimeout.abort();
          const initialBudget = remainingCancellationBudget();
          if (initialBudget < 1) resolveCancellationDeadline?.();
          cancellationDeadlineTimer = setTimeout(() => resolveCancellationDeadline?.(), initialBudget);
          cancellationDeadlineTimer.unref?.();
          cancellationControl = (async () => {
            let authorization: ActiveOperationCancellationAuthorization;
            try {
              if (options.authorizeCancellation === undefined) {
                throw new DockerLifecycleError('coordinator cancellation authorization is unavailable');
              }
              authorization = await options.authorizeCancellation();
              if (authorization.containerId !== id || authorization.deadline !== cancellationDeadline) {
                throw new DockerLifecycleError('coordinator cancellation authorization does not bind the attached container and deadline');
              }
            } catch (error) {
              cancellationControlError = error;
              return;
            }
            let stopError: unknown = null;
            if (authorization.running) {
              try {
                const stopBudget = remainingCancellationBudget();
                if (stopBudget < 1) throw new DockerLifecycleError('cooperative cancellation deadline expired before Docker stop');
                const graceSeconds = Math.max(1, Math.ceil(stopBudget / 1_000));
                requireSuccess(await runDocker(
                  options,
                  ['stop', `--time=${graceSeconds}`, id!],
                  {},
                  { timeoutMs: stopBudget },
                ), 'Docker cooperative stop');
              } catch (error) {
                stopError = error;
              }
            }
            try {
              const inspectBudget = remainingCancellationBudget();
              if (inspectBudget < 1) throw new DockerLifecycleError('cooperative cancellation deadline expired before stopped-state proof');
              const observed = await inspectContainer(options, definition, id!, image, sourceEpoch, 'recovery', inspectBudget);
              if (observed.inspection.running) throw new DockerLifecycleError('Docker cooperative stop did not prove a stopped container');
              cancellationStopped = observed;
            } catch (error) {
              cancellationControlError = stopError === null ? error : new AggregateError([stopError, error], 'Docker cooperative stop and stopped-state proof failed');
              return;
            }
            if (stopError !== null) cancellationControlError = stopError;
          })().finally(() => {
            cancellationControlSettled = true;
          });
        };
        const initialCancellation = options.cancellationBudget?.();
        if (initialCancellation?.requested === true) requestCooperativeStop(initialCancellation);
        const cancellationPoll = setInterval(() => {
          const budget = options.cancellationBudget?.();
          if (budget?.requested === true) requestCooperativeStop(budget);
        }, 50);
        cancellationPoll.unref();
        let acceptAttachOutput = true;
        const attach = runDocker(
          options,
          startArgv.slice(1),
          {
            onStdout: (chunk) => { if (acceptAttachOutput) options.onStdout?.(chunk); },
            onStderr: (chunk) => { if (acceptAttachOutput) options.onStderr?.(chunk); },
          },
          { timeoutMs: options.operationTimeoutMs, control: false, timeoutDisarmSignal: attachTimeout.signal },
        ).then(
          (result) => ({ kind: 'completed' as const, result, error: null }),
          (error: unknown) => {
            if (!(error instanceof CommandExecutionError) || !error.result) return { kind: 'failed' as const, error };
            return { kind: 'completed' as const, result: error.result, error };
          },
        );
        let attachOutcome: Extract<Awaited<typeof attach>, { readonly kind: 'completed' }> | null = null;
        let childWaitWithinDeadline = true;
        try {
          const first = await Promise.race([
            attach,
            cancellationDeadlineReached.then(() => ({ kind: 'deadline' as const })),
          ]);
          if (first.kind === 'completed') {
            attachOutcome = first;
          } else if (first.kind === 'failed') {
            throw first.error;
          } else {
            childWaitWithinDeadline = false;
            acceptAttachOutput = false;
          }
          const controlPromise = cancellationControl as Promise<void> | null;
          if (controlPromise !== null && !cancellationControlSettled) {
            const control = await Promise.race([
              controlPromise.then(() => 'settled' as const),
              cancellationDeadlineReached.then(() => 'deadline' as const),
            ]);
            if (control === 'deadline') childWaitWithinDeadline = false;
          }
        } finally {
          clearInterval(cancellationPoll);
          if (cancellationDeadlineTimer !== null && attachOutcome !== null) clearTimeout(cancellationDeadlineTimer);
        }
        const cancellationObserved = cancellationControl !== null;
        if (attachOutcome === null && !cancellationObserved) throw new DockerLifecycleError('Docker attach ended without a result');
        const cancellationBlockerCode = cancellationControlBlocker(cancellationControlError);
        if (cancellationObserved && cancellationControlError !== null && cancellationBlockerCode === 'RUNNER_DISAPPEARED') {
          if (attachOutcome === null) await attach;
          throw new DockerCancellationRequestedError(
            cancellationControlError instanceof Error
              ? cancellationControlError.message
              : String(cancellationControlError),
            {
              recoveryRequired: true,
              blockerCode: 'RUNNER_DISAPPEARED',
            },
          );
        }
        let result: CommandResult;
        let attachError: unknown = null;
        if (attachOutcome === null) {
          const finishedAt = now(options);
          result = {
            argv: startArgv,
            exitCode: null,
            signal: null,
            stdout: '',
            stderr: '',
            timedOut: true,
            startedAt,
            finishedAt,
          };
          attachError = new DockerCancellationRequestedError('Docker attached child exceeded the cooperative cancellation deadline', { recoveryRequired: true });
        } else {
          result = attachOutcome.result;
          attachError = attachOutcome.error;
        }
        validateStartResult(result, startArgv);
        const primaryFailure = attachError ?? startFailure(result);
        const cooperativeStopped = cancellationStopped as Awaited<ReturnType<typeof inspectContainer>> | null;
        const stoppedInspection = cancellationObserved
          ? cooperativeStopped === null
            ? {
                inspection: inspected,
                observedAt: inspectedResult.observedAt,
                recoveryAttempted: true,
                recoveryActions: ['stop', 'inspect'] as const,
                recoveryFailures: cancellationControlError === null ? [] : [cancellationControlError],
              }
            : {
                ...cooperativeStopped,
                recoveryAttempted: true,
                recoveryActions: ['stop', 'inspect'] as const,
                recoveryFailures: cancellationControlError === null ? [] : [cancellationControlError],
              }
          : await recoverStopped(options, definition, id, image, sourceEpoch, primaryFailure);
        const stoppedJsonBase = inspectionJson(stoppedInspection.inspection, image);
        const stoppedJson: JsonObject = { ...stoppedJsonBase, recoveryAttempted: stoppedInspection.recoveryAttempted, recoveryActions: stoppedInspection.recoveryActions, ...(stoppedInspection.recoveryFailures.length > 0 ? { recoveryFailures: recoveryEvidence(stoppedInspection.recoveryFailures) } : {}) };
        const createdAt = inspected.createdAt;
        const hasStarted = stoppedInspection.inspection.startedAt !== null;
        const hasStopped = hasStarted && !stoppedInspection.inspection.running && stoppedInspection.inspection.finishedAt !== null;
        if (hasStarted) {
          const startedWriteAt = now(options);
          runner(options, (snapshot) => containerCommand(options, definition, sourceEpoch, snapshot, 'started', id!, labels, stoppedJson, startedWriteAt, createdAt, stoppedInspection.inspection.startedAt));
        }
        if (hasStopped) {
          const stoppedWriteAt = now(options);
          runner(options, (snapshot) => containerCommand(options, definition, sourceEpoch, snapshot, 'stopped', id!, labels, stoppedJson, stoppedWriteAt, createdAt, stoppedInspection.inspection.startedAt, stoppedInspection.inspection.finishedAt));
        }
        const protocolMismatch = !hasStopped || (!cancellationObserved && !attachError && !result.timedOut && stoppedInspection.recoveryAttempted);
        const coherentResult = !protocolMismatch
          && !attachError
          && result.signal === null
          && !result.timedOut
          && stoppedInspection.inspection.exitCode === result.exitCode;
        let acceptedDisposition: 'expected-rootfs-already-present' | null = null;
        if (coherentResult && result.exitCode !== 0 && options.classifyAcceptedResult !== undefined) {
          try {
            acceptedDisposition = options.classifyAcceptedResult({
              ...result,
              argv,
            });
          } catch {
            acceptedDisposition = null;
          }
        }
        const outcome: 'passed' | 'failed' | 'accepted' = !cancellationObserved && coherentResult && result.exitCode === 0
          ? 'passed'
          : !cancellationObserved && coherentResult && acceptedDisposition !== null
            ? 'accepted'
            : 'failed';
        const commandEvidence: JsonObject = { argv: result.argv, exitCode: result.exitCode, signal: result.signal, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut, startedAt: result.startedAt, finishedAt: result.finishedAt, ...(attachError ? { attachError: errorJson(attachError) } : {}) };
        const operationFinishedAt = now(options);
        const logs = validateLogProof(await options.finalizeLogs({ operationFinishedAt }), operationFinishedAt);
        const lifecycleMismatch = !hasStopped || (!cancellationObserved && !attachError && !result.timedOut && stoppedInspection.recoveryAttempted) || (!attachError && !result.timedOut && result.exitCode !== null && stoppedInspection.inspection.exitCode !== result.exitCode);
        const cancellationRecoveryRequired = cancellationObserved && (!childWaitWithinDeadline || cancellationControlError !== null || !hasStopped);
        const operationError = outcome === 'failed' ? cancellationObserved ? {
          code: cancellationRecoveryRequired ? 'DOCKER_CONTAINER_ORPHANED' : 'CANCELLED',
          message: !childWaitWithinDeadline
            ? 'Docker attached child exceeded the cooperative cancellation deadline'
            : cancellationControlError !== null
              ? `Docker cooperative stop failed: ${cancellationControlError instanceof Error ? cancellationControlError.message : String(cancellationControlError)}`
              : 'Docker operation stopped cooperatively for cancellation',
        } as const : { code: lifecycleMismatch ? 'DOCKER_EXECUTION_DEFINITION_MISMATCH' : 'BUILD_FAILED', message: lifecycleMismatch ? 'Docker lifecycle inspection contradicts the attach result' : attachError ? 'Docker attach failed' : 'Docker operation exited unsuccessfully' } as const : null;
        const evidenceValue: JsonObject = { operationId: options.operationId, attempt: options.attempt, argv, argvHash, workingDirectory: definition.workingDirectory, containerId: id, inspection: stoppedJson, command: commandEvidence, outcome, ...(acceptedDisposition === null ? {} : { acceptedDisposition }), ...(operationError === null ? {} : { errorCode: operationError.code, error: operationError }) };
        const evidence = await options.evidence(evidenceValue);
        const input: OperationInput = { operationId: options.operationId, attempt: options.attempt, argvHash, argv, startedAt, finishedAt: operationFinishedAt, containerId: id, containerName: options.containerName, containerImageDigest: options.imageDigest, containerLabelJobId: options.jobId, containerLabelManifestSha: options.manifestSha256, containerMount: worktreeMount(options), containerEnvironment: env(sourceEpoch), containerSecurity: security(options, definition), inspection: stoppedJson, timedOut: result.timedOut, lifecyclePhase: hasStopped ? 'stopped' : hasStarted ? 'started' : 'created', exitCode: result.exitCode, signal: result.signal, outcome, ...(acceptedDisposition === null ? {} : { acceptedDisposition }), evidencePath: evidence.path, evidenceSha256: evidence.sha256, ...(operationError === null ? {} : { errorCode: operationError.code, error: operationError }) };
        const completionAt = now(options);
        if (logs.verifiedAt > completionAt) fail('log proof is from the future relative to operation completion');
        runner(options, (snapshot) => ({ kind: 'operation-complete', jobId: options.jobId, owner: snapshot.owner, runnerUnit: snapshot.unit, leaseExpiresAt: snapshot.leaseExpiresAt, at: completionAt, expectedState: snapshot.expectedState, operationId: options.operationId, attempt: options.attempt, input }));
        if (cancellationObserved) {
          let recoveryPersisted = false;
          let blockerPersistenceError: unknown = null;
          if (!childWaitWithinDeadline && options.persistCancellationBlocker !== undefined) {
            try {
              await options.persistCancellationBlocker(
                operationError?.message ?? 'Docker attached child exceeded the cooperative cancellation deadline',
              );
              recoveryPersisted = true;
            } catch (error) {
              blockerPersistenceError = error;
            }
          }
          if (!childWaitWithinDeadline) await attach;
          const message = blockerPersistenceError === null
            ? operationError?.message
            : `${operationError?.message ?? 'Docker cancellation recovery required'}; blocker persistence failed: ${blockerPersistenceError instanceof Error ? blockerPersistenceError.message : String(blockerPersistenceError)}`;
          throw new DockerCancellationRequestedError(message, {
            recoveryRequired: cancellationRecoveryRequired,
            recoveryPersisted,
            blockerCode: cancellationBlockerCode,
          });
        }
        const persistedIdentity = options.store.getJob(options.jobId);
        if (persistedIdentity.containerId !== id || persistedIdentity.containerName !== options.containerName) fail('persisted Docker identity changed before cleanup');
        const removed = await runDocker(options, ['rm', id]);
        requireSuccess(removed, 'Docker rm');
        const removedAt = now(options);
        const observedAt = await proveAbsent(options, id);
        if (logs.verifiedAt > observedAt) fail('log proof is from the future relative to cleanup');
        const stoppedAt = stoppedInspection.inspection.finishedAt ?? stoppedInspection.observedAt;
        const proof: OperationCleanupProof = { kind: 'container-removed', id, name: options.containerName, imageDigest: options.imageDigest, labels, stoppedAt, removedAt, observedAt, globalLabelResult: 'no-match', logs };
        runner(options, (snapshot) => ({ kind: 'operation-cleanup', jobId: options.jobId, owner: snapshot.owner, runnerUnit: snapshot.unit, leaseExpiresAt: snapshot.leaseExpiresAt, at: observedAt, expectedState: snapshot.expectedState, operationId: options.operationId, attempt: options.attempt, proof }));
        return { available: true, outcome, containerId: id, exitCode: result.exitCode, mutationCount: hasStarted ? 6 : 4 };
      } catch (error) {
        if (!persisted) {
          let cleanupEvidence: JsonObject | null = null;
          let cleanupObservedAt: string | null = null;
          try {
            if (id !== null) {
              const cleanup = await cleanupOrphan(options, id);
              cleanupObservedAt = cleanup.observedAt;
              cleanupEvidence = { kind: 'container-removed', id, removedAt: cleanup.removedAt, observedAt: cleanup.observedAt, exactIdAbsent: true, globalLabelResult: 'no-match' };
              const current = options.store.getJob(options.jobId);
              if (!identityIsNull(current)) fail('orphan cleanup did not leave null persisted identity');
            } else {
              const current = options.store.getJob(options.jobId);
              if (!identityIsNull(current)) fail('failed create left persisted container identity');
              cleanupObservedAt = await proveLabelAbsent(options);
              cleanupEvidence = { kind: 'null-identity', exactIdAbsent: true, globalLabelResult: 'no-match', observedAt: cleanupObservedAt };
            }
            if (cleanupObservedAt === null) fail('safe failure cleanup did not produce an observation timestamp');
            await completeNotCreated(options, definition, sourceEpoch, argv, argvHash, startedAt, error, cleanupEvidence, cleanupObservedAt);
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Docker operation failed and failure cleanup could not be committed');
          }
        }
        throw error;
      }
    },
  };
}
