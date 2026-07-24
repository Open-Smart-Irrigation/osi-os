import { CommandExecutionError, createCommandExecutor, type CommandResult, type CommandRunOptions } from './command-executor.js';
import { createOperationArgv, hashOperationArgv, type OperationArgvContext } from './operation-registry.js';
import { parseCanonicalBuilderImageReference, selectExactRepositoryDigest } from '../../builder/validate-builder.js';
import type { JobState, TrustedOperationId } from '../../domain/types.js';
import type { LogCleanupProof, OperationCleanupProof, RunnerWriteCommand } from '../../api/src/ownership.js';
import type { JobRecord, JsonObject, OperationInput } from '../../api/src/store.js';

const IMAGE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const JOB_LABEL = 'org.osi.image-builder.job-id';
const MANIFEST_LABEL = 'org.osi.image-builder.manifest-sha';
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const SAFE_ABSOLUTE_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const DOCKER_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*docker$/u;
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
  readonly evidence: (value: JsonObject) => Promise<{ readonly path: string; readonly sha256: string }>;
  readonly finalizeLogs: (input: LogFinalizeInput) => Promise<LogCleanupProof>;
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

function fail(message: string): never { throw new DockerLifecycleError(message); }

function now(options: DockerExecutorOptions): string {
  return canonicalInstant(options.clock?.() ?? new Date().toISOString(), 'runner timestamp');
}

function env(sourceDateEpoch: string): Readonly<Record<string, string>> {
  return { HOME: '/workdir/.builder-home', PATH: IMAGE_PATH, CARGO_BUILD_JOBS: '2', TZ: 'UTC', SOURCE_DATE_EPOCH: sourceDateEpoch };
}

function dockerEnv(): Readonly<Record<string, string>> {
  return { HOME: '/tmp/osi-image-builder-docker-home', PATH: IMAGE_PATH, LANG: 'C', LC_ALL: 'C' };
}

function runDocker(options: DockerExecutorOptions, args: readonly string[], callbacks: { readonly onStdout?: (chunk: string) => void; readonly onStderr?: (chunk: string) => void } = {}, commandOptions: Pick<CommandRunOptions, 'timeoutMs'> & { readonly control?: boolean } = {}): Promise<CommandResult> {
  const executor = options.commandExecutor ?? createCommandExecutor();
  return executor.run([options.dockerPath, ...args], {
    env: dockerEnv(),
    maxCaptureBytes: options.maxCaptureBytes,
    timeoutMs: commandOptions.timeoutMs ?? DOCKER_CONTROL_TIMEOUT_MS,
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

function normalizeInspection(value: unknown): DockerInspection {
  const root = Array.isArray(value) ? (value.length === 1 ? record(value[0], 'docker inspect result') : fail('docker inspect must return exactly one container')) : record(value, 'docker inspect result');
  if (root.Config === undefined && root.config === undefined && root.imageId !== undefined) {
    const direct = root as unknown as DockerInspection;
    if (!Array.isArray(direct.mounts) || !Array.isArray(direct.capDrop) || !Array.isArray(direct.capAdd) || !Array.isArray(direct.devices) || !Array.isArray(direct.securityOpt) || !Array.isArray(direct.ulimits) || !direct.environment || typeof direct.readonlyRootfs !== 'boolean' || typeof direct.pidsLimit !== 'number' || !Number.isFinite(direct.pidsLimit) || direct.ulimits.some((limit) => typeof limit !== 'object' || limit === null || typeof limit.name !== 'string' || typeof limit.soft !== 'number' || typeof limit.hard !== 'number' || !Number.isFinite(limit.soft) || !Number.isFinite(limit.hard))) fail('normalized Docker inspection is incomplete');
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

function validateOptions(options: DockerExecutorOptions): readonly string[] {
  if (!DOCKER_PATH.test(options.dockerPath) || options.dockerPath.includes('..')) fail('docker path is not canonical');
  if (!SAFE_ID.test(options.jobId) || !HASH.test(options.manifestSha256) || !Number.isSafeInteger(options.attempt) || options.attempt < 1) fail('job identity is invalid');
  if (!SAFE_ABSOLUTE_PATH.test(options.worktreePath) || options.worktreePath.includes('..') || options.worktreePath.includes('//') || options.worktreePath.includes(',')) fail('worktree path is not a safe canonical absolute path');
  if (!Number.isSafeInteger(options.uid) || options.uid < 0 || options.uid > 65535 || !Number.isSafeInteger(options.gid) || options.gid < 0 || options.gid > 65535) fail('UID/GID is invalid');
  if (options.containerName !== `osi-image-builder-${options.jobId}-attempt-${options.attempt}`) fail('container name is invalid');
  if (!Number.isSafeInteger(options.operationTimeoutMs) || options.operationTimeoutMs < 1) fail('operation timeout is invalid');
  if (!Number.isSafeInteger(options.maxCaptureBytes) || options.maxCaptureBytes < 1 || options.maxCaptureBytes > 16 * 1024 * 1024) fail('operation capture limit is invalid');
  if (typeof options.evidence !== 'function') fail('immutable evidence writer is required');
  if (typeof options.finalizeLogs !== 'function') fail('internal log finalizer is required');
  if (typeof options.store?.getJob !== 'function' || typeof options.ownership?.runnerWrite !== 'function' || typeof options.leaseSnapshot !== 'function') fail('typed builder store, ownership store, and lease provider are required');
  let canonical;
  try { canonical = parseCanonicalBuilderImageReference(options.imageReference); } catch (error) { throw new DockerLifecycleError('image reference is not canonical', { cause: error }); }
  if (canonical.imageDigest !== options.imageDigest || !HASH.test(options.imageDigest)) fail('image digest does not match canonical image reference');
  try { return Object.freeze([...createOperationArgv(options.operationId, options.operationContext)]); }
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

function validateStartResult(result: CommandResult, expectedArgv: readonly string[]): { readonly startedAt: string; readonly finishedAt: string } {
  if (!Array.isArray(result.argv) || JSON.stringify(result.argv) !== JSON.stringify(expectedArgv) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || typeof result.timedOut !== 'boolean' || (typeof result.exitCode !== 'number' && result.exitCode !== null) || (typeof result.signal !== 'string' && result.signal !== null)) fail('Docker start returned an incomplete command result');
  const startedAt = canonicalInstant(result.startedAt, 'Docker start startedAt');
  const finishedAt = canonicalInstant(result.finishedAt, 'Docker start finishedAt');
  if (Date.parse(finishedAt) < Date.parse(startedAt)) fail('Docker start command timestamps are not chronological');
  return { startedAt, finishedAt };
}

function containerId(stdout: string): string {
  const values = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (values.length !== 1 || !/^[a-f0-9]{12,64}$/u.test(values[0]!)) fail('docker create returned an invalid container ID');
  return values[0]!;
}

function validateInspection(actual: DockerInspection, createdId: string, image: ImageIdentity, options: DockerExecutorOptions, sourceEpoch: string, requireStopped: boolean): void {
  const labels = { [JOB_LABEL]: options.jobId, [MANIFEST_LABEL]: options.manifestSha256 };
  if (actual.id !== createdId || actual.name !== options.containerName || actual.image !== options.imageReference || actual.imageId !== image.imageId) fail('Docker container identity or image proof does not match the locked definition');
  if (!exactRecord(actual.labels, labels)) fail('Docker container labels do not match');
  if (actual.mounts.length !== 1 || actual.mounts[0]!.type !== 'bind' || actual.mounts[0]!.source !== options.worktreePath || actual.mounts[0]!.destination !== '/workdir' || actual.mounts[0]!.readOnly) fail('Docker container mount does not match the locked worktree bind');
  if (actual.user !== `${options.uid}:${options.gid}` || actual.workingDir !== '/workdir' || actual.networkMode !== 'bridge') fail('Docker container user, workdir, or network does not match');
  if (JSON.stringify(actual.capDrop) !== JSON.stringify(['ALL']) || actual.capAdd.length !== 0 || actual.privileged || actual.devices.length !== 0 || actual.securityOpt.length !== 1 || actual.securityOpt[0] !== 'no-new-privileges:true' || actual.readonlyRootfs || actual.pidsLimit !== 4096 || JSON.stringify(actual.ulimits) !== JSON.stringify([{ name: 'nofile', soft: 1024, hard: 4096 }])) fail('Docker container security does not match the locked definition');
  if (requireStopped && actual.running) fail('Docker container is still running');
  if (!exactRecord(actual.environment, env(sourceEpoch))) fail('Docker container environment is not the exact fixed environment');
}

function inspectionJson(actual: DockerInspection, image: ImageIdentity): JsonObject {
  const mounts: readonly JsonObject[] = actual.mounts.map((mount) => ({ type: mount.type, source: mount.source, destination: mount.destination, readOnly: mount.readOnly }));
  const ulimits: readonly JsonObject[] = actual.ulimits.map((limit) => ({ name: limit.name, soft: limit.soft, hard: limit.hard }));
  const imageEvidence: JsonObject = { imageId: image.imageId, imageDigest: image.imageDigest, repoDigests: image.repoDigests, architecture: image.architecture, os: image.os };
  return { container: { id: actual.id, name: actual.name, configImage: actual.image, rootImageId: actual.imageId, labels: actual.labels, mounts, user: actual.user, workingDir: actual.workingDir, networkMode: actual.networkMode, capDrop: actual.capDrop, capAdd: actual.capAdd, privileged: actual.privileged, devices: actual.devices, securityOpt: actual.securityOpt, readonlyRootfs: actual.readonlyRootfs, pidsLimit: actual.pidsLimit, ulimits, environment: actual.environment, running: actual.running }, imagePreflight: imageEvidence };
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

function security(options: DockerExecutorOptions): JsonObject {
  return { capDrop: ['ALL'], capAdd: [], devices: [], sockets: [], privileged: false, noNewPrivileges: true, pidsLimit: 4096, ulimit: 'nofile=1024:4096', user: `${options.uid}:${options.gid}`, workdir: '/workdir', network: 'bridge' };
}

function containerCommand(options: DockerExecutorOptions, sourceEpoch: string, snapshot: RunnerLeaseSnapshot, lifecycle: 'created' | 'started' | 'stopped', id: string, labels: JsonObject, inspection: JsonObject, occurredAt: string, createdAt: string, startedAt?: string, stoppedAt?: string): RunnerWriteCommand {
  return { kind: 'container', jobId: options.jobId, owner: snapshot.owner, runnerUnit: snapshot.unit, leaseExpiresAt: snapshot.leaseExpiresAt, at: occurredAt, lifecycle, containerId: id, containerName: options.containerName, imageDigest: options.imageDigest, labels, mount: { type: 'bind', source: options.worktreePath, destination: '/workdir', readOnly: false }, environment: env(sourceEpoch), security: security(options), inspection, occurredAt, createdAt, startedAt, stoppedAt };
}

function identityIsNull(job: DockerJobRead): boolean {
  return [job.containerId, job.containerName, job.containerImageDigest, job.containerLabelJobId, job.containerLabelManifestSha, job.containerLabels, job.containerMount, job.containerEnvironment, job.containerSecurity, job.containerInspection, job.containerCreatedAt, job.containerStartedAt, job.containerStoppedAt, job.containerRemovedAt, job.containerCleanupOutcome].every((value) => value === null);
}

async function proveLabelAbsent(options: DockerExecutorOptions): Promise<void> {
  const labels = await runDocker(options, ['ps', '--all', `--filter=label=${JOB_LABEL}=${options.jobId}`, '--format={{.ID}}']);
  if (!noLabel(requireSuccess(labels, 'Docker label verification'))) fail('a Docker container still owns this job label');
}

async function proveAbsent(options: DockerExecutorOptions, id: string): Promise<string> {
  const exact = await runDocker(options, ['inspect', '--type=container', '--format={{json .}}', id]);
  if (exact.exitCode === 0 || !/no such container/iu.test(`${exact.stderr}\n${exact.stdout}`)) fail('Docker rm did not prove exact container absence');
  await proveLabelAbsent(options);
  return now(options);
}

async function cleanupOrphan(options: DockerExecutorOptions, id: string): Promise<{ readonly removedAt: string; readonly observedAt: string }> {
  const removed = await runDocker(options, ['rm', id]);
  requireSuccess(removed, 'Docker orphan cleanup');
  const removedAt = now(options);
  const observedAt = await proveAbsent(options, id);
  return { removedAt, observedAt };
}

async function inspectContainer(options: DockerExecutorOptions, id: string, image: ImageIdentity, sourceEpoch: string, requireStopped: boolean): Promise<DockerInspection> {
  const inspected = normalizeInspection(parseJson(requireSuccess(await runDocker(options, ['inspect', '--type=container', '--format={{json .}}', id]), 'Docker inspect'), 'Docker inspect'));
  validateInspection(inspected, id, image, options, sourceEpoch, requireStopped);
  return inspected;
}

async function recoverStopped(options: DockerExecutorOptions, id: string, image: ImageIdentity, sourceEpoch: string): Promise<DockerInspection> {
  let inspected = await inspectContainer(options, id, image, sourceEpoch, false);
  if (!inspected.running) return inspected;
  const failures: unknown[] = [];
  try { requireSuccess(await runDocker(options, ['stop', '--time=10', id]), 'Docker stop'); } catch (error) { failures.push(error); }
  inspected = await inspectContainer(options, id, image, sourceEpoch, false);
  if (!inspected.running) return inspected;
  try { requireSuccess(await runDocker(options, ['kill', id]), 'Docker kill escalation'); } catch (error) { failures.push(error); }
  inspected = await inspectContainer(options, id, image, sourceEpoch, false);
  if (inspected.running) throw new AggregateError(failures, 'Docker attach ended but the exact container could not be stopped');
  return inspected;
}

function errorJson(error: unknown): JsonObject {
  return { code: 'BUILD_FAILED', message: error instanceof Error ? error.message : String(error) };
}

function validateLogProof(proof: LogCleanupProof, operationFinishedAt: string): LogCleanupProof {
  if (!proof || !['absent', 'sealed'].includes(proof.runner) || !['absent', 'sealed'].includes(proof.docker)) fail('internal log finalizer returned incomplete proof');
  const verifiedAt = canonicalInstant(proof.verifiedAt, 'log proof verifiedAt');
  if (verifiedAt < operationFinishedAt) fail('log proof is stale');
  return { ...proof, verifiedAt };
}

async function completeNotCreated(options: DockerExecutorOptions, sourceEpoch: string, argv: readonly string[], argvHash: string, startedAt: string, primary: unknown, cleanupEvidence: JsonObject | null): Promise<void> {
  const finishedAt = now(options);
  const logs = validateLogProof(await options.finalizeLogs({ operationFinishedAt: finishedAt }), finishedAt);
  const evidence = await options.evidence({ operationId: options.operationId, attempt: options.attempt, argv, argvHash, lifecyclePhase: 'not_created', outcome: 'failed', error: errorJson(primary), cleanup: cleanupEvidence ?? {} });
  const input: OperationInput = { operationId: options.operationId, attempt: options.attempt, argvHash, argv, startedAt, finishedAt, timedOut: primary instanceof CommandExecutionError ? Boolean(primary.result?.timedOut) : false, lifecyclePhase: 'not_created', exitCode: primary instanceof CommandExecutionError ? primary.result?.exitCode ?? null : null, signal: primary instanceof CommandExecutionError ? primary.result?.signal ?? null : null, outcome: 'failed', evidencePath: evidence.path, evidenceSha256: evidence.sha256, errorCode: 'BUILD_FAILED', error: errorJson(primary) };
  runner(options, (snapshot) => ({ kind: 'operation-complete', jobId: options.jobId, owner: snapshot.owner, runnerUnit: snapshot.unit, leaseExpiresAt: snapshot.leaseExpiresAt, at: finishedAt, expectedState: snapshot.expectedState, operationId: options.operationId, attempt: options.attempt, input }));
  const cleanupAt = now(options);
  if (logs.verifiedAt > cleanupAt) fail('log proof is from the future relative to cleanup');
  const proof: OperationCleanupProof = { kind: 'null-identity', container: { kind: 'absent', globalLabelResult: 'no-match', observedAt: cleanupAt }, logs };
  runner(options, (snapshot) => ({ kind: 'operation-cleanup', jobId: options.jobId, owner: snapshot.owner, runnerUnit: snapshot.unit, leaseExpiresAt: snapshot.leaseExpiresAt, at: cleanupAt, expectedState: snapshot.expectedState, operationId: options.operationId, attempt: options.attempt, proof }));
  void sourceEpoch;
}

export function createDockerExecutor(options: DockerExecutorOptions) {
  return {
    async run(): Promise<DockerExecutionResult> {
      const argv = validateOptions(options);
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
      if (!identityIsNull(job)) fail('persisted Docker identity is not clear before create');
      await proveLabelAbsent(options);
      const startedAt = now(options);
      const argvHash = hashOperationArgv(argv);
      runner(options, (snapshot) => ({ kind: 'operation-begin', jobId: options.jobId, owner: snapshot.owner, runnerUnit: snapshot.unit, leaseExpiresAt: snapshot.leaseExpiresAt, at: startedAt, expectedState: snapshot.expectedState, operationId: options.operationId, attempt: options.attempt, argvHash, argv, startedAt }));
      let id: string | null = null;
      let persisted = false;
      try {
        const labels: JsonObject = { [JOB_LABEL]: options.jobId, [MANIFEST_LABEL]: options.manifestSha256 };
        const created = await runDocker(options, ['create', `--name=${options.containerName}`, `--label=${JOB_LABEL}=${options.jobId}`, `--label=${MANIFEST_LABEL}=${options.manifestSha256}`, `--mount=type=bind,source=${options.worktreePath},destination=/workdir`, `--user=${options.uid}:${options.gid}`, '--workdir=/workdir', '--network=bridge', '--platform=linux/amd64', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--pids-limit=4096', '--ulimit=nofile=1024:4096', '--pull=never', ...Object.entries(env(sourceEpoch)).map(([key, value]) => `--env=${key}=${value}`), options.imageReference, ...argv]);
        id = containerId(requireSuccess(created, 'Docker create'));
        const inspected = await inspectContainer(options, id, image, sourceEpoch, true);
        const inspectedJson = inspectionJson(inspected, image);
        const createdAt = now(options);
        runner(options, (snapshot) => containerCommand(options, sourceEpoch, snapshot, 'created', id!, labels, inspectedJson, createdAt, createdAt));
        persisted = true;
        const startArgv = [options.dockerPath, 'start', '--attach', id];
        let result: CommandResult;
        let attachError: unknown = null;
        try {
          result = await runDocker(options, startArgv.slice(1), { onStdout: options.onStdout, onStderr: options.onStderr }, { timeoutMs: options.operationTimeoutMs, control: false });
        } catch (error) {
          attachError = error;
          if (!(error instanceof CommandExecutionError) || !error.result) throw error;
          result = error.result;
        }
        const commandTimes = validateStartResult(result, startArgv);
        const stoppedInspection = await recoverStopped(options, id, image, sourceEpoch);
        const stoppedJson = inspectionJson(stoppedInspection, image);
        const startedWriteAt = now(options);
        runner(options, (snapshot) => containerCommand(options, sourceEpoch, snapshot, 'started', id!, labels, stoppedJson, startedWriteAt, createdAt, commandTimes.startedAt));
        const stoppedWriteAt = now(options);
        runner(options, (snapshot) => containerCommand(options, sourceEpoch, snapshot, 'stopped', id!, labels, stoppedJson, stoppedWriteAt, createdAt, commandTimes.startedAt, commandTimes.finishedAt));
        const outcome: 'passed' | 'failed' = !attachError && result.exitCode === 0 && result.signal === null && !result.timedOut ? 'passed' : 'failed';
        const commandEvidence: JsonObject = { argv: result.argv, exitCode: result.exitCode, signal: result.signal, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut, startedAt: result.startedAt, finishedAt: result.finishedAt, ...(attachError ? { attachError: errorJson(attachError) } : {}) };
        const operationFinishedAt = now(options);
        const logs = validateLogProof(await options.finalizeLogs({ operationFinishedAt }), operationFinishedAt);
        const evidenceValue: JsonObject = { operationId: options.operationId, attempt: options.attempt, argv, argvHash, containerId: id, inspection: stoppedJson, command: commandEvidence, outcome };
        const evidence = await options.evidence(evidenceValue);
        const input: OperationInput = { operationId: options.operationId, attempt: options.attempt, argvHash, argv, startedAt, finishedAt: operationFinishedAt, containerId: id, containerName: options.containerName, containerImageDigest: options.imageDigest, containerLabelJobId: options.jobId, containerLabelManifestSha: options.manifestSha256, containerMount: { type: 'bind', source: options.worktreePath, destination: '/workdir', readOnly: false }, containerEnvironment: env(sourceEpoch), containerSecurity: security(options), inspection: stoppedJson, timedOut: result.timedOut, lifecyclePhase: 'stopped', exitCode: result.exitCode, signal: result.signal, outcome, evidencePath: evidence.path, evidenceSha256: evidence.sha256, ...(outcome === 'failed' ? { errorCode: 'BUILD_FAILED', error: { code: 'BUILD_FAILED', message: attachError ? 'Docker attach failed' : 'Docker operation exited unsuccessfully' } } : {}) };
        runner(options, (snapshot) => ({ kind: 'operation-complete', jobId: options.jobId, owner: snapshot.owner, runnerUnit: snapshot.unit, leaseExpiresAt: snapshot.leaseExpiresAt, at: operationFinishedAt, expectedState: snapshot.expectedState, operationId: options.operationId, attempt: options.attempt, input }));
        const persistedIdentity = options.store.getJob(options.jobId);
        if (persistedIdentity.containerId !== id || persistedIdentity.containerName !== options.containerName) fail('persisted Docker identity changed before cleanup');
        const removed = await runDocker(options, ['rm', id]);
        requireSuccess(removed, 'Docker rm');
        const removedAt = now(options);
        const observedAt = await proveAbsent(options, id);
        if (logs.verifiedAt > observedAt) fail('log proof is from the future relative to cleanup');
        const proof: OperationCleanupProof = { kind: 'container-removed', id, name: options.containerName, imageDigest: options.imageDigest, labels, stoppedAt: commandTimes.finishedAt, removedAt, observedAt, globalLabelResult: 'no-match', logs };
        runner(options, (snapshot) => ({ kind: 'operation-cleanup', jobId: options.jobId, owner: snapshot.owner, runnerUnit: snapshot.unit, leaseExpiresAt: snapshot.leaseExpiresAt, at: observedAt, expectedState: snapshot.expectedState, operationId: options.operationId, attempt: options.attempt, proof }));
        return { available: true, outcome, containerId: id, exitCode: result.exitCode, mutationCount: 6 };
      } catch (error) {
        if (!persisted) {
          let cleanupEvidence: JsonObject | null = null;
          try {
            if (id !== null) {
              const cleanup = await cleanupOrphan(options, id);
              cleanupEvidence = { kind: 'container-removed', id, removedAt: cleanup.removedAt, observedAt: cleanup.observedAt, exactIdAbsent: true, globalLabelResult: 'no-match' };
              const current = options.store.getJob(options.jobId);
              if (!identityIsNull(current)) fail('orphan cleanup did not leave null persisted identity');
            } else {
              const current = options.store.getJob(options.jobId);
              if (!identityIsNull(current)) fail('failed create left persisted container identity');
              await proveLabelAbsent(options);
              cleanupEvidence = { kind: 'null-identity', exactIdAbsent: true, globalLabelResult: 'no-match' };
            }
            await completeNotCreated(options, sourceEpoch, argv, argvHash, startedAt, error, cleanupEvidence);
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Docker operation failed and failure cleanup could not be committed');
          }
        }
        throw error;
      }
    },
  };
}
