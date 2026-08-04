import { createHash, randomUUID } from 'node:crypto';
import { readFile, statfs, writeFile, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { loadConfig, withStateRootSnapshot, type LoadedConfig } from '../../config/load.js';
import { loadManifest } from '../../manifest/validate.js';
import type { LoadedManifest } from '../../manifest/schema.js';
import { validateBuilderLock, type BuilderLock } from '../../domain/builder-lock.js';
import { parseBuilderIdentity, type BuilderIdentity } from '../../domain/builder-identity.js';
import { createInstalledLockReader } from '../../domain/installed-lock.js';
import { encodeBranchSlug } from '../../domain/paths.js';
import type { BuilderErrorCode, BuilderErrorContract } from '../../domain/types.js';
import { createPublisherClient, type PublisherClient } from '../../publisher/client.js';
import { BuilderStore, type JobRecord, type JsonObject } from './store.js';
import {
  OwnershipStore,
  type ApiWriteCommand,
  type CleanupSnapshot,
  type DirectInterruptionProof,
  type DirectLogProof,
} from './ownership.js';
import { MIGRATION_REGISTRY, openBuilderDatabase } from './store-schema.js';
import { BranchCache } from './branch-cache.js';
import { SourceResolver } from './git/source-resolver.js';
import { createReadOnlyPreflightDefaults, PreflightService } from './preflight.js';
import { createProductionEnqueueService } from './enqueue.js';
import {
  createStartupBootstrap,
  type QueueBlocker,
  type QueueSafetyChecks,
  type QueueSystemd,
} from './queue.js';
import { createApiCancellationService, type ApiCancellationService } from './cancellation.js';
import {
  createCleanupAdmissionRecovery,
  type RecoveryPersistedLogEvent,
  type RecoveryPersistedLogGeneration,
} from './recovery.js';
import { createApiRecoveryService } from './recovery-service.js';
import { createProductionRecoveryInspector } from './production-recovery-inspector.js';
import { createRecoveryPhysicalVerification, type RecoveryPhysicalVerification } from './recovery-production.js';
import { createPublishBlockerFinalVerifier } from './publish-blocker-verifier.js';
import { createPublishBlockerRecheckService } from './publish-blocker-recheck.js';
import {
  createPublishingRecoveryService,
  type PublishingRecoveryArtifactObservation,
  type PublishingRecoveryJob,
  type PublishingRecoveryPublisherObservation,
  type PublishingRecoveryStageEvidenceInput,
} from './publishing-recovery.js';
import { createIndexedEvidenceReader } from './evidence-reader.js';
import { createSseService } from './sse-service.js';
import { DurableLogStream } from './log-stream.js';
import { collectHealthSnapshot } from './health.js';
import {
  createApiFreshnessServer,
  type ApiFreshnessServer,
} from './freshness-server.js';
import type {
  ApiFreshnessErrorEvidenceWriter,
  ApiFreshnessProtocolStore,
  ApiFreshnessResolver,
} from './freshness-protocol.js';
import { createStaticUiService, type StaticUiService } from './static-ui.js';
import { createRetentionStartupHook } from './retention.js';
import {
  createApiRouteHandler,
  type ApiJobStore,
  type ApiTargetConfig,
  type JobPage,
} from './routes.js';
import { createHttpServer } from './server.js';
import {
  createCommandExecutor,
  type CommandExecutor,
  type CommandResult,
} from '../../runner/src/command-executor.js';
import {
  createEvidenceWriter,
  type EvidencePublication,
  type StageEvidenceInput,
} from '../../runner/src/evidence.js';
import { completeRecoveredPublication } from '../../runner/src/main.js';
import { canonicalInstant, encodeJson } from './validation.js';
import { deriveSystemdBusEnvironment } from './preflight.js';
import { createDockerCancellationControls } from '../../runner/src/docker-executor.js';
import { loadInstalledDependencyEgressPolicy } from '../../runner/src/network-policy.js';
import {
  createApiProcess,
  type ApiProcess,
  type ApiProcessDependencies,
} from './main.js';
import { createDispatchingApiProcess } from './dispatching-process.js';
import type { StartupService } from './startup-order.js';

const DEFAULT_PORT = 43120;
const FIXED_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C',
});
const SYSTEMD_EXECUTABLE = '/usr/bin/systemctl';
const SYSTEMD_RUN_EXECUTABLE = '/usr/bin/systemd-run';
const DOCKER_EXECUTABLE = '/usr/bin/docker';
const RUNNER_UNIT = /^osi-image-builder-runner@[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.service$/u;
const HASH64 = /^[0-9a-f]{64}$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_JOB_PAGE_SIZE = 100;
const CLEANUP_UNIT = /^osi-image-builder-cleanup@(cln_[0-7][0-9a-hj-km-np-tv-z]{25})\.service$/u;
const SYSTEMD_SAFE_PATH = /^\/[A-Za-z0-9._/ -]+$/u;

export interface CleanupSystemdSandbox {
  readonly configRoot: string;
  readonly stateRoot: string;
  readonly repositoryPath: string;
  readonly approvedOutputRoots: readonly string[];
}

export interface ProductionApiAssemblyOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly port?: number;
  readonly loadedConfig?: LoadedConfig;
  readonly versionRoot?: string;
  readonly executablePath?: string;
  readonly locateVersionRoot?: (executablePath: string) => string;
  readonly commandExecutor?: CommandExecutor;
  readonly now?: () => string;
}

export interface ProductionApiAssemblySeams {
  readonly loadedConfig: LoadedConfig;
  readonly versionRoot: string;
  readonly manifest: LoadedManifest;
  readonly database: DatabaseSync;
  readonly store: BuilderStore;
  readonly ownership: OwnershipStore;
}

interface DockerContainer {
  readonly id: string;
  readonly labels: Readonly<Record<string, string>>;
}

interface DockerRecoveryAdapter {
  readonly inspect: (id: string) => Promise<{
    readonly container: DockerContainer | null;
    readonly observedAt: string;
  }>;
  readonly listByLabels: (labels: Readonly<Record<string, unknown>>) => Promise<{
    readonly containers: readonly DockerContainer[];
    readonly observedAt: string;
  }>;
  readonly listBuilderContainers: () => Promise<{
    readonly containers: readonly DockerContainer[];
    readonly observedAt: string;
  }>;
}

type DockerCancellationControls = ReturnType<typeof createDockerCancellationControls>;

function canonicalVersionRoot(executablePath: string): string {
  const root = resolve(dirname(dirname(executablePath)));
  if (!root.startsWith('/') || root === '/') {
    throw new Error('installed API executable has no version root');
  }
  return root;
}

function installedVersion(root: string): string {
  const value = root.split('/').at(-1);
  if (
    value === undefined
    || !/^(?:v?\d+\.\d+\.\d+|\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)$/u.test(value)
  ) {
    throw new Error('installed API version is invalid');
  }
  return value;
}

async function readLock(path: string, version: string): Promise<Readonly<{ lock: BuilderLock; sha256: string }>> {
  const directory = dirname(path);
  const installed = await createInstalledLockReader().read(directory);
  if (installed.identity.lockPath !== path) {
    throw new Error('installed builder lock path differs from the selected installation');
  }
  const raw: unknown = JSON.parse(installed.text);
  const validated = validateBuilderLock(raw, version);
  if (!validated.ok) throw new Error(`installed builder lock is invalid: ${validated.reason}`);
  return Object.freeze({
    lock: validated.lock,
    sha256: createHash('sha256').update(installed.bytes).digest('hex'),
  });
}

function commandEnvironment(
  bus?: Readonly<{ XDG_RUNTIME_DIR: string; DBUS_SESSION_BUS_ADDRESS: string }>,
): Readonly<Record<string, string>> {
  return Object.freeze({ ...FIXED_ENV, ...(bus ?? {}) });
}

function requireSuccessful(result: CommandResult, operation: string): CommandResult {
  if (
    result.exitCode !== 0
    || result.timedOut
    || result.signal !== null
  ) {
    throw new Error(`${operation} failed`);
  }
  return result;
}

function resultJson(stdout: string, operation: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${operation} returned malformed JSON`, { cause: error });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${operation} returned a non-object JSON value`);
  }
  return value as Record<string, unknown>;
}

export function createProductionSystemdAdapter(
  executor: CommandExecutor,
  bus: Readonly<{ XDG_RUNTIME_DIR: string; DBUS_SESSION_BUS_ADDRESS: string }>,
  now: () => string,
  cleanupSandbox?: CleanupSystemdSandbox,
): QueueSystemd & {
  readonly isActive: (unit: string) => Promise<boolean>;
  readonly stop: (unit: string) => Promise<void>;
  readonly startCleanup: (unit: string, identity: BuilderIdentity) => Promise<Readonly<{
    unit: string;
    argv: readonly string[];
    exitCode: number | null;
    timedOut: boolean;
    signal: NodeJS.Signals | null;
  }>>;
  readonly inspectRecovery: (
    unit: string,
  ) => Promise<{ readonly unit: string; readonly active: boolean; readonly observedAt: string }>;
} {
  const run = (
    argv: readonly string[],
    timeoutMs = 15_000,
  ): Promise<CommandResult> => executor.run(argv, {
    env: commandEnvironment(bus),
    timeoutMs,
    maxCaptureBytes: 64 * 1024,
  });

  const inspect: QueueSystemd['inspect'] = async (unit) => {
    const result = requireSuccessful(await run([
      SYSTEMD_EXECUTABLE,
      '--user',
      'show',
      unit,
      '--property=ActiveState,SubState,JobRunning,JobQueued',
      '--no-pager',
    ]), 'systemd unit inspection');
    const values: Record<string, string> = {};
    for (const line of result.stdout.split(/\r?\n/u).filter(Boolean)) {
      const index = line.indexOf('=');
      if (index <= 0) throw new Error('systemd unit inspection returned malformed output');
      values[line.slice(0, index)] = line.slice(index + 1);
    }
    const activeState = values.ActiveState;
    if (typeof activeState !== 'string') {
      throw new Error('systemd unit inspection omitted ActiveState');
    }
    return Object.freeze({
      unit,
      active: activeState === 'active',
      pending: activeState === 'activating'
        || values.JobRunning === 'yes'
        || values.JobQueued === 'yes',
      observedAt: now(),
    });
  };

  const start: QueueSystemd['start'] = async (unit) => {
    const result = await run([SYSTEMD_EXECUTABLE, '--user', 'start', unit]);
    return Object.freeze({
      unit,
      argv: ['systemctl', '--user', 'start', unit],
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      signal: result.signal,
    });
  };

  const startCleanup = async (unit: string, identityValue: BuilderIdentity) => {
    const match = unit.match(CLEANUP_UNIT);
    if (match === null || cleanupSandbox === undefined) {
      throw new Error('cleanup systemd admission sandbox is unavailable');
    }
    const identity = parseBuilderIdentity(identityValue);
    const canonicalPath = (path: string, field: string): string => {
      if (!SYSTEMD_SAFE_PATH.test(path) || resolve(path) !== path) {
        throw new Error(`cleanup systemd ${field} is invalid`);
      }
      return path;
    };
    const unitPath = (path: string, prefix = ''): string => `"${prefix}${path}"`;
    const configRoot = canonicalPath(cleanupSandbox.configRoot, 'config root');
    const stateRoot = canonicalPath(cleanupSandbox.stateRoot, 'state root');
    const repositoryPath = canonicalPath(cleanupSandbox.repositoryPath, 'repository path');
    const runtimeRoot = canonicalPath(bus.XDG_RUNTIME_DIR, 'runtime root');
    if (cleanupSandbox.approvedOutputRoots.length === 0) {
      throw new Error('cleanup systemd approved output roots are unavailable');
    }
    const outputRoots = cleanupSandbox.approvedOutputRoots.map((path) => canonicalPath(path, 'output root'));
    if (new Set(outputRoots).size !== outputRoots.length) {
      throw new Error('cleanup systemd approved output roots are not unique');
    }
    const outputWorkRoots = outputRoots.map((path) => join(path, '.osi-image-builder'));
    const cleanupExecutable = join(identity.packageRoot, 'bin', 'osi-image-builder-cleanup');
    const publisherExecutable = join(identity.packageRoot, 'bin', 'osi-image-publish');
    const visibleReadOnly = [identity.packageRoot, configRoot, ...outputRoots, runtimeRoot]
      .map((path) => unitPath(path)).join(' ');
    const visibleWritable = [stateRoot, ...outputWorkRoots]
      .map((path) => unitPath(path)).join(' ');
    const executablePaths = [
      cleanupExecutable,
      publisherExecutable,
      '/usr/bin/env',
      '/usr/bin/node',
      '/usr/bin/systemctl',
      '/usr/bin/docker',
      '/usr/lib',
      '/usr/lib64',
    ].map((path) => unitPath(path)).join(' ');
    const args = [
      '--user',
      `--unit=${unit}`,
      '--expand-environment=no',
      '--collect',
      '--no-block',
      '--service-type=exec',
      '--property=KillMode=control-group',
      '--property=Restart=no',
      '--property=NoNewPrivileges=yes',
      '--property=PrivateTmp=yes',
      '--property=ProtectSystem=strict',
      '--property=ProtectHome=tmpfs',
      `--property=BindReadOnlyPaths=${visibleReadOnly}`,
      `--property=BindPaths=${visibleWritable}`,
      `--property=InaccessiblePaths=${unitPath(repositoryPath, '-')}`,
      '--property=NoExecPaths=/',
      `--property=ExecPaths=${executablePaths}`,
      '--property=PrivateDevices=yes',
      '--property=ProtectControlGroups=yes',
      '--property=ProtectKernelModules=yes',
      '--property=ProtectKernelTunables=yes',
      '--property=ProtectKernelLogs=yes',
      '--property=RestrictAddressFamilies=AF_UNIX',
      '--property=RestrictNamespaces=yes',
      '--property=RestrictRealtime=yes',
      '--property=RestrictSUIDSGID=yes',
      '--property=LockPersonality=yes',
      '--property=CapabilityBoundingSet=',
      '--property=UMask=0077',
      `--setenv=XDG_CONFIG_HOME=${dirname(configRoot)}`,
      `--setenv=XDG_STATE_HOME=${dirname(stateRoot)}`,
      '--',
      cleanupExecutable,
      match[1]!,
    ] as const;
    const result = await run([SYSTEMD_RUN_EXECUTABLE, ...args]);
    return Object.freeze({
      unit,
      argv: ['systemd-run', ...args],
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      signal: result.signal,
    });
  };

  const listActive: NonNullable<QueueSystemd['listActive']> = async () => {
    const result = requireSuccessful(await run([
      SYSTEMD_EXECUTABLE,
      '--user',
      'list-units',
      '--type=service',
      '--state=active,activating',
      '--no-legend',
      'osi-image-builder-runner@*.service',
    ]), 'systemd runner listing');
    const units = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u)[0])
      .filter((unit): unit is string => typeof unit === 'string' && unit.length > 0);
    if (units.some((unit) => !RUNNER_UNIT.test(unit))) {
      throw new Error('systemd runner listing returned an unexpected unit');
    }
    return Object.freeze(units);
  };

  const stop = async (unit: string): Promise<void> => {
    requireSuccessful(
      await run([SYSTEMD_EXECUTABLE, '--user', 'stop', unit]),
      'systemd unit stop',
    );
  };

  return Object.freeze({
    inspect,
    start,
    startCleanup,
    listActive,
    isActive: async (unit: string) => {
      const observation = await inspect(unit);
      return observation.active || observation.pending;
    },
    stop,
    inspectRecovery: async (unit: string) => {
      const observation = await inspect(unit);
      return Object.freeze({
        unit,
        active: observation.active || observation.pending,
        observedAt: observation.observedAt,
      });
    },
  });
}

export function createProductionCleanupSystemd(
  systemd: Pick<ReturnType<typeof createProductionSystemdAdapter>, 'startCleanup' | 'isActive' | 'stop' | 'inspectRecovery'>,
  resolveIdentity: (unit: string) => Promise<BuilderIdentity>,
): {
  readonly start: (unit: string) => Promise<void>;
  readonly isActive: (unit: string) => Promise<boolean>;
  readonly stop: (unit: string) => Promise<void>;
  readonly inspect: (unit: string) => Promise<{ readonly unit: string; readonly active: boolean; readonly observedAt: string }>;
} {
  return Object.freeze({
    start: async (unit: string): Promise<void> => {
      const identity = await resolveIdentity(unit);
      const result = await systemd.startCleanup(unit, identity);
      if (result.exitCode !== 0 || result.timedOut || result.signal !== null) {
        throw new Error('cleanup systemd unit start failed');
      }
    },
    isActive: systemd.isActive,
    stop: systemd.stop,
    inspect: systemd.inspectRecovery,
  });
}

function dockerRecoveryAdapter(
  executor: CommandExecutor,
  now: () => string,
): DockerRecoveryAdapter {
  const run = (argv: readonly string[]): Promise<CommandResult> => executor.run(argv, {
    env: { ...FIXED_ENV, HOME: '/tmp/osi-image-builder-docker-home' },
    timeoutMs: 15_000,
    maxCaptureBytes: 128 * 1024,
  });

  const decode = (value: Record<string, unknown>): DockerContainer => {
    const id = value.Id;
    const config = value.Config;
    const labels = config !== null
      && typeof config === 'object'
      && !Array.isArray(config)
      && (config as Record<string, unknown>).Labels !== null
      && typeof (config as Record<string, unknown>).Labels === 'object'
      && !Array.isArray((config as Record<string, unknown>).Labels)
      ? (config as Record<string, unknown>).Labels as Record<string, unknown>
      : {};
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('Docker inspection omitted the container ID');
    }
    if (Object.values(labels).some((value) => typeof value !== 'string')) {
      throw new Error('Docker inspection returned non-string labels');
    }
    return Object.freeze({
      id,
      labels: Object.freeze(labels as Record<string, string>),
    });
  };

  const inspect = async (id: string): Promise<{
    readonly container: DockerContainer | null;
    readonly observedAt: string;
  }> => {
    const result = await run([
      DOCKER_EXECUTABLE,
      'inspect',
      '--format',
      '{{json .}}',
      id,
    ]);
    const observedAt = now();
    if (result.exitCode !== 0 || result.timedOut || result.signal !== null) {
      if (
        !result.timedOut
        && result.signal === null
        && /No such (?:object|container)/iu.test(result.stderr)
      ) {
        return Object.freeze({ container: null, observedAt });
      }
      throw new Error('Docker container inspection failed');
    }
    return Object.freeze({
      container: decode(resultJson(result.stdout, 'Docker container inspection')),
      observedAt,
    });
  };

  const listIds = async (filters: readonly string[]): Promise<readonly string[]> => {
    const result = requireSuccessful(await run([
      DOCKER_EXECUTABLE,
      'ps',
      '-aq',
      '--no-trunc',
      ...filters.flatMap((filter) => ['--filter', filter]),
    ]), 'Docker container listing');
    const ids = result.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    if (ids.some((id) => !/^sha256:[0-9a-f]{64}$|^[0-9a-f]{64}$/u.test(id))) {
      throw new Error('Docker container listing returned an invalid ID');
    }
    return Object.freeze(ids);
  };

  const listAndInspect = async (
    filters: readonly string[],
  ): Promise<{ readonly containers: readonly DockerContainer[]; readonly observedAt: string }> => {
    const ids = await listIds(filters);
    const containers: DockerContainer[] = [];
    for (const id of ids) {
      const observation = await inspect(id);
      if (observation.container === null) {
        throw new Error('Docker container disappeared during inspection');
      }
      containers.push(observation.container);
    }
    return Object.freeze({ containers: Object.freeze(containers), observedAt: now() });
  };

  return Object.freeze({
    inspect,
    listByLabels: async (labels: Readonly<Record<string, unknown>>) => listAndInspect(
      Object.entries(labels).map(([key, value]) => `label=${key}=${String(value)}`),
    ),
    listBuilderContainers: async () => listAndInspect([
      'label=org.osi.image-builder.job-id',
    ]),
  });
}

function queueSafety(docker: DockerRecoveryAdapter): QueueSafetyChecks {
  return Object.freeze({
    inspect: async ({
      phase,
      jobId,
    }: Parameters<QueueSafetyChecks['inspect']>[0]) => {
      const observation = await docker.listBuilderContainers();
      if (observation.containers.length === 0) return null;
      return Object.freeze({
        code: 'LIVE_BUILDER_CONTAINER',
        details: {
          phase,
          ...(jobId === undefined ? {} : { jobId }),
          containerId: observation.containers[0]!.id,
        },
      });
    },
  });
}

function encodeJobCursor(job: JobRecord): string {
  return Buffer.from(JSON.stringify({
    acceptedAt: job.acceptedAt,
    jobId: job.jobId,
  }), 'utf8').toString('base64url');
}

function decodeJobCursor(cursor: string): Readonly<{ acceptedAt: string; jobId: string }> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch (error) {
    throw new Error('job cursor is invalid', { cause: error });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('job cursor is invalid');
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(',') !== 'acceptedAt,jobId'
    || typeof candidate.acceptedAt !== 'string'
    || !Number.isFinite(Date.parse(candidate.acceptedAt))
    || typeof candidate.jobId !== 'string'
    || !JOB_ID.test(candidate.jobId)
  ) {
    throw new Error('job cursor is invalid');
  }
  return Object.freeze({
    acceptedAt: candidate.acceptedAt,
    jobId: candidate.jobId,
  });
}

function createApiStore(
  database: DatabaseSync,
  store: BuilderStore,
): ApiJobStore {
  const listJobs = ({ cursor, limit }: {
    readonly cursor: string | null;
    readonly limit: number;
  }): JobPage => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_JOB_PAGE_SIZE) {
      throw new Error('job page limit is invalid');
    }
    const boundary = cursor === null ? null : decodeJobCursor(cursor);
    const rows = boundary === null
      ? database.prepare(
        'SELECT job_id FROM jobs ORDER BY accepted_at DESC, job_id DESC LIMIT ?',
      ).all(limit + 1)
      : database.prepare(`SELECT job_id FROM jobs
          WHERE accepted_at < ? OR (accepted_at = ? AND job_id < ?)
          ORDER BY accepted_at DESC, job_id DESC LIMIT ?`)
        .all(boundary.acceptedAt, boundary.acceptedAt, boundary.jobId, limit + 1);
    const jobIds = rows.map((row) => (row as { job_id?: unknown }).job_id);
    if (jobIds.some((jobId) => typeof jobId !== 'string' || !JOB_ID.test(jobId))) {
      throw new Error('job page query returned an invalid identity');
    }
    const jobs = jobIds.slice(0, limit).map((jobId) => store.getJob(jobId as string));
    const last = jobs.at(-1);
    return Object.freeze({
      jobs: Object.freeze(jobs),
      nextCursor: jobIds.length > limit && last !== undefined ? encodeJobCursor(last) : null,
    });
  };

  const apiStore: ApiJobStore = {
    getJob: (jobId: string) => store.getJob(jobId),
    getRecoveryJob: (jobId: string) => store.getRecoveryJob(jobId),
    getStage: (jobId: string, stage: Parameters<BuilderStore['getStage']>[1]) => (
      store.getStage(jobId, stage)
    ),
    listEvents: (
      jobId: string,
      options: Parameters<BuilderStore['listEvents']>[1],
    ) => store.listEvents(jobId, options),
    getTerminalEvent: (jobId: string) => store.getTerminalEvent(jobId),
    getPublishStartEvent: (jobId: string, terminalSeq: number) => (
      store.getPublishStartEvent(jobId, terminalSeq)
    ),
    getPublishBlockerRecheck: (jobId: string, eventSeq: number) => (
      store.getPublishBlockerRecheck(jobId, eventSeq)
    ),
    listJobs: listJobs,
  };
  return Object.freeze(apiStore);
}

function createFreshnessProtocolStore(
  store: BuilderStore,
  ownership: OwnershipStore,
): ApiFreshnessProtocolStore {
  const freshnessProtocolStore: ApiFreshnessProtocolStore = {
    getJob: (jobId: string) => store.getJob(jobId),
    request: (jobId: string, at: string) => ownership.apiWrite({
      kind: 'freshness-request',
      jobId,
      at,
    }),
    result: (
      jobId: string,
      input: Parameters<ApiFreshnessProtocolStore['result']>[1],
      at: string,
    ) => ownership.apiWrite({
      kind: 'freshness-result',
      jobId,
      input,
      at,
    }),
  };
  return Object.freeze(freshnessProtocolStore);
}

async function createPublisher(
  packageDirectory: string,
  lock: BuilderLock,
  loaded: LoadedConfig,
  executor: CommandExecutor,
): Promise<PublisherClient> {
  const executable = join(packageDirectory, 'bin', 'osi-image-publish');
  if (lock.publisherSha256 === undefined) {
    throw new Error('installed builder lock omits the publisher digest');
  }
  const binarySha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
  if (binarySha256 !== lock.publisherSha256) {
    throw new Error('installed publisher digest does not match the builder lock');
  }
  const versionResult = requireSuccessful(await executor.run([executable, '--version'], {
    env: FIXED_ENV,
    timeoutMs: 15_000,
    maxCaptureBytes: 64 * 1024,
  }), 'publisher version inspection');
  const version = resultJson(versionResult.stdout, 'publisher version inspection');
  if (
    version.available !== true
    || version.version !== lock.packageVersion
    || typeof version.sourceSha256 !== 'string'
    || !HASH64.test(version.sourceSha256)
  ) {
    throw new Error('installed publisher version evidence is invalid');
  }
  const selfTest = requireSuccessful(await executor.run([executable, '--self-test'], {
    env: FIXED_ENV,
    timeoutMs: 120_000,
    maxCaptureBytes: 64 * 1024,
  }), 'publisher self-test');
  const selfTestResult = resultJson(selfTest.stdout, 'publisher self-test');
  if (
    selfTestResult.available !== true
    || selfTestResult.selfTest !== true
    || selfTestResult.mutationCount !== 0
  ) {
    throw new Error('installed publisher self-test evidence is invalid');
  }
  return createPublisherClient({
    executable,
    approvedRoots: loaded.config.approvedOutputRoots,
    expectedVersion: lock.packageVersion,
    expectedSourceSha256: version.sourceSha256,
    commandExecutor: executor,
  });
}

function createFreshnessErrorEvidence(
  loaded: LoadedConfig,
): ApiFreshnessErrorEvidenceWriter {
  return Object.freeze({
    write: async ({
      jobId,
      checkedAt,
    }: Parameters<ApiFreshnessErrorEvidenceWriter['write']>[0]) => withStateRootSnapshot(
      loaded.pathAuthorities.stateRoot,
      async ({ snapshot }) => {
        if (!JOB_ID.test(jobId) || snapshot.path !== loaded.stateRoot) {
          throw new Error('freshness evidence state authority is invalid');
        }
        const relativePath = `jobs/${jobId}/evidence/freshness-error.json`;
        const path = join(snapshot.path, relativePath);
        const parent = dirname(path);
        const temporary = join(parent, `.freshness-error-${randomUUID()}.tmp`);
        const bytes = Buffer.from(`${JSON.stringify({
          jobId,
          checkedAt,
          reason: 'resolver-unavailable-or-malformed',
        })}\n`, 'utf8');
        await mkdir(parent, { recursive: true, mode: 0o700 });
        let renamed = false;
        try {
          await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
          const file = await open(temporary, 'r');
          try {
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(temporary, path);
          renamed = true;
          const directory = await open(parent, 'r');
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        } finally {
          if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
        }
        return Object.freeze({
          error: {
            code: 'FRESHNESS_UNKNOWN',
            reason: 'api-error',
          },
          path: relativePath,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      },
    ),
  });
}

function createFreshnessResolver(
  source: SourceResolver,
  now: () => string,
): ApiFreshnessResolver {
  return Object.freeze({
    resolve: async ({
      branch,
      pinnedSha,
    }: Parameters<ApiFreshnessResolver['resolve']>[0]) => {
      const value = await source.requestFreshness(branch, pinnedSha);
      const checkedAt = now();
      if (value.status === 'unknown') {
        throw new Error('remote source freshness is unavailable');
      }
      return Object.freeze({
        status: value.status,
        observedSha: value.observedSha,
        checkedAt,
      });
    },
  });
}

function migrationStartupService(database: DatabaseSync): StartupService {
  return async () => {
    const rows = database.prepare(
      'SELECT version, filename, sha256 FROM schema_migrations ORDER BY version',
    ).all() as unknown as readonly Readonly<{
      version: number;
      filename: string;
      sha256: string;
    }>[];
    const valid = rows.length === MIGRATION_REGISTRY.length
      && rows.every((row, index) => {
        const expected = MIGRATION_REGISTRY[index];
        return expected !== undefined
          && row.version === expected.version
          && row.filename === expected.filename
          && row.sha256 === expected.sha256;
      });
    return valid
      ? Object.freeze({ blockers: Object.freeze([]) })
      : Object.freeze({
        blockers: Object.freeze([{
          code: 'MIGRATION_STATE_INVALID',
          details: { applied: rows.length, expected: MIGRATION_REGISTRY.length },
        }]),
      });
  };
}

function cleanupAdmissionsStartupService(
  recovery: Readonly<{
    readonly openAdmissions: () => Promise<unknown>;
    readonly reconcileCompletedAdmissions: () => Promise<unknown>;
  }>,
): StartupService {
  return async () => {
    await recovery.openAdmissions();
    await recovery.reconcileCompletedAdmissions();
    return Object.freeze({ blockers: Object.freeze([]) });
  };
}

function reportCancellationProcessError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`cancellation coordination failed: ${message.replace(/[\r\n\t]+/gu, ' ').slice(0, 512)}\n`);
}

function liveRunnerStartupService(
  database: DatabaseSync,
  systemd: QueueSystemd,
  now: () => string,
): StartupService {
  return async () => {
    const units = await systemd.listActive?.() ?? [];
    const activeRows = database.prepare(`SELECT job_id, runner_unit, runner_lease_expires_at
      FROM jobs
      WHERE state IN (
        'starting','preflight','source','release_gates','frontend',
        'target_setup','feeds','config','building','verifying','cancel_requested'
      )`).all() as readonly Readonly<Record<string, unknown>>[];
    const rowsByUnit = new Map(
      activeRows
        .filter((row) => typeof row.runner_unit === 'string')
        .map((row) => [row.runner_unit as string, row]),
    );
    const blockers: QueueBlocker[] = [];
    for (const unit of units) {
      const row = rowsByUnit.get(unit);
      if (row === undefined) {
        blockers.push({ code: 'UNOWNED_LIVE_RUNNER', details: { unit } });
        continue;
      }
      if (
        typeof row.runner_lease_expires_at !== 'string'
        || Date.parse(row.runner_lease_expires_at) <= Date.parse(now())
      ) {
        blockers.push({
          code: 'STALE_LIVE_RUNNER_LEASE',
          details: { unit, jobId: String(row.job_id) },
        });
      }
    }
    return Object.freeze({ blockers: Object.freeze(blockers) });
  };
}

function cancellationCoordinationStartupService(
  cancellation: Pick<ApiCancellationService, 'resumePending'>,
): StartupService {
  return async () => {
    const report = await cancellation.resumePending();
    return Object.freeze({
      blockers: Object.freeze(report.failures.map((failure) => ({
        code: 'CANCELLATION_COORDINATION_PENDING',
        details: { jobId: failure.jobId, reason: failure.kind },
      }))),
    });
  };
}

function publishingRecoveryJob(
  job: JobRecord,
  stageStartedAt: string,
  runnerInactiveAt: string,
): PublishingRecoveryJob {
  if (
    job.state !== 'publishing'
    || job.publishState !== 'publishing'
    || job.runnerUnit === null
    || job.runnerLeaseOwner === null
    || job.runnerLeaseExpiresAt === null
    || job.artifactStagingPath === null
    || job.artifactSha256 === null
    || job.artifactSize === null
    || job.artifactMtime === null
    || job.checksumPath === null
    || job.checksumSha256 === null
    || job.manifestPath === null
    || job.manifestSha256 === null
    || job.verificationPath === null
    || job.verificationSha256 === null
    || job.artifactFinalDirectory === null
    || job.artifactFinalPath === null
    || job.publishStartedAt === null
    || job.publishedAt !== null
  ) {
    throw new Error('persisted publishing recovery state is incomplete');
  }
  return Object.freeze({
    jobId: job.jobId,
    state: 'publishing',
    publishState: 'publishing',
    runnerUnit: job.runnerUnit,
    runnerOwner: job.runnerLeaseOwner,
    runnerLeaseExpiresAt: job.runnerLeaseExpiresAt,
    runnerInactiveAt,
    stageStartedAt,
    rootId: job.rootId,
    branch: job.branch,
    pinnedSha: job.pinnedSha,
    targetId: job.targetId,
    artifactStagingPath: job.artifactStagingPath,
    artifactSha256: job.artifactSha256,
    artifactSize: job.artifactSize,
    artifactMtime: job.artifactMtime,
    checksumPath: job.checksumPath,
    checksumSha256: job.checksumSha256,
    manifestPath: job.manifestPath,
    manifestSha256: job.manifestSha256,
    verificationPath: job.verificationPath,
    verificationSha256: job.verificationSha256,
    finalDirectory: job.artifactFinalDirectory,
    finalPath: job.artifactFinalPath,
    artifactQuarantineIntentPath: job.artifactQuarantineIntentPath
      ?? `.osi-image-builder/quarantine/${job.jobId}`,
    publishStartedAt: job.publishStartedAt,
    publishedAt: null,
  });
}

async function publishingRecoveryDisposition(
  job: JobRecord,
  physical: RecoveryPhysicalVerification,
  at: string,
): Promise<PublishingRecoveryArtifactObservation['quarantine']> {
  const common = {
    jobId: job.jobId,
    admissionId: `publishing-${job.jobId}`,
    rootId: job.rootId,
    publishState: job.publishState,
    artifactStagingPath: job.artifactStagingPath,
    artifactSha256: job.artifactSha256,
    artifactSize: job.artifactSize,
    artifactMtime: job.artifactMtime,
    checksumPath: job.checksumPath,
    checksumSha256: job.checksumSha256,
    manifestPath: job.manifestPath,
    manifestSha256: job.manifestSha256,
    verificationPath: job.verificationPath,
    verificationSha256: job.verificationSha256,
  } as const;
  let quarantineError: unknown;
  try {
    await physical.staging.verify({
      ...common,
      postcondition: {
        kind: 'quarantined',
        sourcePath: `staging/${job.jobId}`,
        destinationPath: `quarantine/${job.jobId}`,
        sourceAbsent: true,
        destinationPresent: true,
        sha256: job.artifactSha256,
        size: job.artifactSize,
        verifiedAt: at,
      },
    });
    const name = job.artifactStagingPath?.split('/').at(-1);
    if (name === undefined) throw new Error('quarantined artifact basename is unavailable');
    return Object.freeze({
      state: 'present',
      path: `.osi-image-builder/quarantine/${job.jobId}`,
      held: true,
      artifactPath: `.osi-image-builder/quarantine/${job.jobId}/${name}`,
      artifactSize: job.artifactSize,
      artifactSha256: job.artifactSha256,
    });
  } catch (error) {
    quarantineError = error;
  }
  try {
    await physical.staging.verify({
      ...common,
      postcondition: {
        kind: 'absent',
        path: null,
        sourcePath: `staging/${job.jobId}`,
        sourceAbsent: true,
        verifiedAt: at,
      },
    });
    return Object.freeze({
      state: 'absent',
      path: null,
      held: false,
      artifactPath: null,
      artifactSize: null,
      artifactSha256: null,
    });
  } catch (error) {
    throw new Error('publishing recovery could not prove absent or quarantined staging', {
      cause: error instanceof Error ? error : quarantineError,
    });
  }
}

export function adoptPublishingRecoveryFailureEvidence(input: Readonly<{
  readonly publication: EvidencePublication;
  readonly job: Pick<JobRecord, 'jobId' | 'targetId' | 'rootId' | 'branch' | 'pinnedSha'>;
  readonly stageStartedAt: string;
  readonly recoveryAt: string;
  readonly expected: PublishingRecoveryStageEvidenceInput;
}>): EvidencePublication {
  const expectedPath = `jobs/${input.job.jobId}/evidence/09-publish.json`;
  if (
    input.publication.path !== expectedPath
    || createHash('sha256').update(input.publication.bytes).digest('hex') !== input.publication.sha256
    || !input.publication.bytes.endsWith('\n')
    || input.publication.bytes.slice(0, -1).includes('\n')
  ) {
    throw new Error('stored failed publish evidence identity is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.publication.bytes);
  } catch (error) {
    throw new Error('stored failed publish evidence is not JSON', { cause: error });
  }
  if (
    parsed === null
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || `${encodeJson(parsed, 'stored failed publish evidence', true)}\n` !== input.publication.bytes
  ) {
    throw new Error('stored failed publish evidence is not canonical');
  }
  const stage = parsed as Record<string, unknown>;
  const exactKeys = [
    'schemaVersion', 'jobId', 'stage', 'startedAt', 'finishedAt', 'outcome',
    'operationId', 'commands', 'inputs', 'observations', 'error',
  ].sort().join('\0');
  if (
    Object.keys(stage).sort().join('\0') !== exactKeys
    || stage.schemaVersion !== 1
    || stage.jobId !== input.job.jobId
    || stage.stage !== 'publish'
    || stage.startedAt !== input.stageStartedAt
    || stage.outcome !== 'failed'
    || stage.operationId !== null
    || !Array.isArray(stage.commands)
    || stage.commands.length !== 0
  ) {
    throw new Error('stored failed publish evidence does not bind the job');
  }
  if (typeof stage.finishedAt !== 'string') {
    throw new Error('stored failed publish evidence finishedAt is missing');
  }
  const startedAt = canonicalInstant(input.stageStartedAt, 'publish stage start');
  const finishedAt = canonicalInstant(stage.finishedAt, 'stored failed publish evidence finishedAt');
  const recoveryAt = canonicalInstant(input.recoveryAt, 'publishing recovery time');
  if (finishedAt < startedAt || finishedAt > recoveryAt) {
    throw new Error('stored failed publish evidence chronology is invalid');
  }
  const expectedInputs = {
    targetId: input.job.targetId,
    rootId: input.job.rootId,
    branch: input.job.branch,
    pinnedSha: input.job.pinnedSha,
  };
  if (
    encodeJson(stage.inputs, 'stored failed publish inputs', true)
      !== encodeJson(expectedInputs, 'expected failed publish inputs', true)
    || encodeJson(stage.error, 'stored failed publish error', true)
      !== encodeJson(input.expected.error, 'expected failed publish error', true)
    || stage.observations === null
    || typeof stage.observations !== 'object'
    || Array.isArray(stage.observations)
  ) {
    throw new Error('stored failed publish evidence inputs or error changed');
  }
  const observations = stage.observations as Record<string, unknown>;
  const expectedObservations = input.expected.observations as Record<string, unknown>;
  const observationKeys = ['final', 'checksum', 'manifest', 'verification', 'staging', 'quarantine', 'logs'];
  if (
    Object.keys(observations).sort().join('\0') !== [...observationKeys].sort().join('\0')
    || Object.keys(expectedObservations).sort().join('\0') !== [...observationKeys].sort().join('\0')
  ) {
    throw new Error('stored failed publish observations have an invalid shape');
  }
  for (const field of observationKeys.filter((field) => field !== 'logs')) {
    if (
      encodeJson(observations[field], `stored failed publish ${field}`, true)
        !== encodeJson(expectedObservations[field], `expected failed publish ${field}`, true)
    ) {
      throw new Error(`stored failed publish ${field} changed`);
    }
  }
  const logs = observations.logs;
  if (
    logs === null
    || typeof logs !== 'object'
    || Array.isArray(logs)
    || Object.keys(logs).sort().join('\0') !== 'docker\0noGap\0runner\0verifiedAt'
    || (logs as Record<string, unknown>).runner !== 'sealed'
    || (logs as Record<string, unknown>).docker !== 'sealed'
    || (logs as Record<string, unknown>).noGap !== true
    || typeof (logs as Record<string, unknown>).verifiedAt !== 'string'
  ) {
    throw new Error('stored failed publish log proof is incomplete');
  }
  const logsVerifiedAt = canonicalInstant(
    (logs as Record<string, string>).verifiedAt!,
    'stored failed publish log verification time',
  );
  if (logsVerifiedAt < startedAt || logsVerifiedAt > recoveryAt) {
    throw new Error('stored failed publish log chronology is invalid');
  }
  return input.publication;
}

export async function publishingFailureObservation(
  job: JobRecord,
  publisher: PublishingRecoveryPublisherObservation,
  physical: RecoveryPhysicalVerification,
  at: string,
): Promise<PublishingRecoveryArtifactObservation> {
  if (publisher.destination === 'candidate' || publisher.destination === 'unknown' || publisher.staging === 'unknown') {
    throw new Error('publisher failure observation is not terminal');
  }
  const stagingPresent = publisher.staging === 'present';
  const quarantine = stagingPresent
    ? Object.freeze({
        state: 'absent' as const,
        path: null,
        held: false,
        artifactPath: null,
        artifactSize: null,
        artifactSha256: null,
      })
    : await publishingRecoveryDisposition(job, physical, at);
  if (
    job.artifactStagingPath === null
    || job.artifactSha256 === null
    || job.artifactSize === null
    || job.checksumPath === null
    || job.manifestPath === null
    || job.verificationPath === null
  ) {
    throw new Error('publishing failure paths are incomplete');
  }
  const staging = stagingPresent
    ? await physical.staging.verify({
        jobId: job.jobId,
        admissionId: `publishing-${job.jobId}`,
        rootId: job.rootId,
        publishState: job.publishState,
        artifactStagingPath: job.artifactStagingPath,
        artifactSha256: job.artifactSha256,
        artifactSize: job.artifactSize,
        artifactMtime: job.artifactMtime,
        checksumPath: job.checksumPath,
        checksumSha256: job.checksumSha256,
        manifestPath: job.manifestPath,
        manifestSha256: job.manifestSha256,
        verificationPath: job.verificationPath,
        verificationSha256: job.verificationSha256,
        postcondition: {
          kind: 'present',
          sourcePath: `staging/${job.jobId}`,
          sourcePresent: true,
          destinationPath: `quarantine/${job.jobId}`,
          destinationAbsent: true,
          sha256: job.artifactSha256,
          size: job.artifactSize,
          verifiedAt: at,
        },
      })
    : null;
  if (stagingPresent && (staging === null || staging === true || staging.kind !== 'present')) {
    throw new Error('publishing recovery staging-present proof is incomplete');
  }
  return Object.freeze({
    final: Object.freeze({
      present: publisher.destination === 'mismatched',
      path: job.artifactFinalPath!,
      held: false,
      size: null,
      sha256: null,
    }),
    checksum: Object.freeze({
      present: false,
      path: job.checksumPath,
      contents: null,
      sha256: null,
    }),
    manifest: Object.freeze({
      present: false,
      path: job.manifestPath,
      bytes: null,
      content: null,
      sha256: null,
    }),
    verification: Object.freeze({
      present: false,
      path: job.verificationPath,
      bytes: null,
      content: null,
      sha256: null,
    }),
    staging: stagingPresent && staging !== null && staging !== true
      ? Object.freeze({
          state: 'present' as const,
          path: staging.path,
          sha256: staging.sha256,
          size: staging.size,
          held: staging.held,
        })
      : Object.freeze({
          state: 'absent' as const,
          path: null,
          sha256: null,
          size: null,
          held: false,
        }),
    quarantine,
  });
}

type PublishRecoveryCommand = Extract<ApiWriteCommand, { readonly kind: 'publish-recovery' }>;

export async function revalidatePublishingRecoveryCommit(
  options: Readonly<{
    readonly store: Pick<BuilderStore, 'getJob'>;
    readonly systemd: Pick<QueueSystemd, 'inspect'>;
    readonly globalDocker: DockerRecoveryAdapter;
    readonly docker: DockerCancellationControls;
    readonly now: () => string;
  }>,
  command: PublishRecoveryCommand,
): Promise<
  | Readonly<{ readonly kind: 'ready'; readonly command: PublishRecoveryCommand }>
  | Readonly<{
      readonly kind: 'deferred';
      readonly code: 'PUBLISH_RECOVERY_LIVENESS_CHANGED';
      readonly details: JsonObject;
    }>
> {
  const deferred = (reason: string) => Object.freeze({
    kind: 'deferred' as const,
    code: 'PUBLISH_RECOVERY_LIVENESS_CHANGED' as const,
    details: Object.freeze({ jobId: command.jobId, reason }),
  });
  const job = options.store.getJob(command.jobId);
  if (
    job.state !== 'publishing'
    || job.publishState !== 'publishing'
    || job.runnerUnit === null
    || job.runnerLeaseOwner === null
    || job.runnerLeaseExpiresAt === null
  ) return deferred('persisted-state-changed');
  const unit = await options.systemd.inspect(job.runnerUnit);
  const afterUnit = options.now();
  if (unit.active || unit.pending) return deferred('runner-unit-live');
  if (job.runnerLeaseExpiresAt >= afterUnit) return deferred('runner-lease-live');
  const globallyLabeled = await options.globalDocker.listBuilderContainers();
  if (globallyLabeled.containers.some(
    (candidate) => candidate.labels['org.osi.image-builder.job-id'] === command.jobId,
  )) return deferred('globally-labeled-container-live');
  const exact = await recoveryContainerObservation(job, options.docker, globallyLabeled.observedAt);
  if (exact.kind !== 'absent') return deferred('exact-container-identity-live');
  const committedAt = options.now();
  return Object.freeze({
    kind: 'ready' as const,
    command: Object.freeze({
      ...command,
      at: committedAt,
      evidence: Object.freeze({
        ...command.evidence,
        runner: Object.freeze({
          unit: job.runnerUnit,
          owner: job.runnerLeaseOwner,
          leaseExpiresAt: job.runnerLeaseExpiresAt,
          inactiveAt: unit.observedAt,
          observedAt: committedAt,
        }),
        container: Object.freeze({
          kind: 'absent' as const,
          globalLabelResult: 'no-match' as const,
          observedAt: committedAt,
        }),
      }),
    }),
  });
}

export function createPublishingRecoveryStartupService(
  options: Readonly<{
    readonly database: DatabaseSync;
    readonly store: BuilderStore;
    readonly ownership: OwnershipStore;
    readonly systemd: QueueSystemd;
    readonly docker: DockerCancellationControls;
    readonly globalDocker: DockerRecoveryAdapter;
    readonly publisher: PublisherClient;
    readonly physical: RecoveryPhysicalVerification;
    readonly loaded: LoadedConfig;
    readonly now: () => string;
  }>,
): StartupService {
  return async () => {
    const rows = options.database.prepare(`SELECT job_id
      FROM jobs
      WHERE state='publishing' AND publish_state='publishing'
      ORDER BY accepted_at, job_id`).all() as readonly Readonly<Record<string, unknown>>[];
    const blockers: QueueBlocker[] = [];
    for (const row of rows) {
      if (typeof row.job_id !== 'string') {
        blockers.push({ code: 'PUBLISH_RECOVERY_STATE_INVALID' });
        continue;
      }
      const job = options.store.getJob(row.job_id);
      try {
        if (job.runnerUnit === null || job.runnerLeaseExpiresAt === null) {
          throw new Error('publishing runner identity is incomplete');
        }
        const unit = await options.systemd.inspect(job.runnerUnit);
        const at = options.now();
        if (unit.active || unit.pending || job.runnerLeaseExpiresAt >= at) continue;
        const stage = options.store.getStage(job.jobId, 'publish');
        if (stage?.outcome !== 'running' || stage.startedAt === null) {
          throw new Error('publishing stage is not durably running');
        }
        const globallyLabeled = await options.globalDocker.listBuilderContainers();
        if (globallyLabeled.containers.some(
          (candidate) => candidate.labels['org.osi.image-builder.job-id'] === job.jobId,
        )) {
          blockers.push({
            code: 'PUBLISH_RECOVERY_LIVE_LABELED_CONTAINER',
            details: { jobId: job.jobId },
          });
          continue;
        }
        const container = await recoveryContainerObservation(job, options.docker, at);
        if (container.kind !== 'absent') {
          blockers.push({
            code: 'PUBLISH_RECOVERY_CONTAINER_IDENTITY',
            details: { jobId: job.jobId },
          });
          continue;
        }
        const recoveryJob = publishingRecoveryJob(job, stage.startedAt, unit.observedAt);
        let latestPublisher: PublishingRecoveryPublisherObservation | null = null;
        const recheck = async (): Promise<PublishingRecoveryPublisherObservation> => {
          const response = await options.publisher.recheck({
            rootId: job.rootId,
            jobId: job.jobId,
            branchSlug: encodeBranchSlug(job.branch),
            sourceSha: job.pinnedSha,
            targetId: job.targetId,
          });
          if (response.mutationCount !== 0) {
            throw new Error('publisher recheck reported a mutation');
          }
          const observed: PublishingRecoveryPublisherObservation = Object.freeze({
            destination: response.destination ?? 'unknown',
            staging: response.staging ?? 'unknown',
            mutationCount: 0,
          });
          latestPublisher = observed;
          return observed;
        };
        const logStream = (): DurableLogStream => new DurableLogStream({
          db: options.database,
          root: join(options.loaded.stateRoot, 'jobs', job.jobId),
          jobId: job.jobId,
          now: () => at,
        });
        const service = createPublishingRecoveryService({
          publisher: {
            recheck: async () => recheck(),
            quarantine: async () => {
              const response = await options.publisher.quarantine({
                rootId: job.rootId,
                jobId: job.jobId,
              });
              return Object.freeze({
                outcome: response.quarantined ? 'quarantined' as const : 'failed' as const,
                mutationCount: response.mutationCount,
                ...(response.errorCode === 'QUARANTINE_PENDING'
                  ? { errorCode: 'QUARANTINE_PENDING' as const }
                  : {}),
              });
            },
          },
          logs: {
            sealOrphanTail: async (stream, proof) => {
              const opened = logStream();
              try {
                opened.sealOrphanTailSync(stream, proof);
              } finally {
                opened.close();
              }
            },
            verify: async () => {
              const proof = await recoveryLogObservation(
                options.database,
                options.physical,
                job.jobId,
                at,
              );
              if (
                proof.direct === null
                || proof.direct.runner !== 'sealed'
                || proof.direct.docker !== 'sealed'
              ) {
                throw new Error('publishing recovery logs are not sealed without gaps');
              }
              return Object.freeze({
                runner: 'sealed' as const,
                docker: 'sealed' as const,
                verifiedAt: proof.direct.verifiedAt,
                noGap: true as const,
              });
            },
          },
        });
        const recoveryEvidenceWriter = createEvidenceWriter({
          stateRoot: options.loaded.pathAuthorities.stateRoot,
        });
        const writeStageEvidence = async (input: PublishingRecoveryStageEvidenceInput) => {
          const code = String(input.error?.code ?? 'PUBLISH_RECOVERY_FAILED') as BuilderErrorCode;
          const reason = String(input.error?.reason ?? 'publishing recovery failed');
          const evidenceInput: StageEvidenceInput = {
            jobId: job.jobId,
            stage: 'publish',
            startedAt: stage.startedAt!,
            finishedAt: at,
            outcome: input.outcome,
            operationId: null,
            commands: [],
            inputs: {
              targetId: job.targetId,
              rootId: job.rootId,
              branch: job.branch,
              pinnedSha: job.pinnedSha,
            },
            observations: input.observations,
            error: input.outcome === 'passed'
              ? null
              : {
                  code,
                  stage: 'publish',
                  details: {
                    reason,
                    recoveryError: input.error,
                  } as unknown as BuilderErrorContract['details'],
                  retryable: false,
                  requestId: job.requestId,
                  diagnosis: reason,
                  recovery: 'Resolve the recorded publication blocker before retrying.',
                },
          };
          const prepared = recoveryEvidenceWriter.prepare(evidenceInput);
          const existing = await recoveryEvidenceWriter.read(prepared.path);
          const evidence = existing === null
            ? await recoveryEvidenceWriter.write(evidenceInput)
            : adoptPublishingRecoveryFailureEvidence({
                publication: existing,
                job,
                stageStartedAt: stage.startedAt!,
                recoveryAt: at,
                expected: {
                  ...input,
                  error: evidenceInput.error === null
                    ? null
                    : JSON.parse(encodeJson(
                        evidenceInput.error,
                        'expected failed publish error',
                        true,
                      )) as JsonObject,
                },
              });
          return Object.freeze({
            present: true as const,
            path: evidence.path,
            bytes: evidence.bytes,
            sha256: evidence.sha256,
          });
        };
        const result = await service.recover({
          job: recoveryJob,
          at,
          container,
          observeArtifacts: async () => {
            if (latestPublisher === null) {
              throw new Error('publisher observation is unavailable');
            }
            return publishingFailureObservation(
              job,
              latestPublisher,
              options.physical,
              at,
            );
          },
          completeDestination: async ({ logs }) => completeRecoveredPublication({
            loaded: options.loaded,
            job,
            stageStartedAt: stage.startedAt!,
            at,
            logs,
          }),
          writeStageEvidence,
        });
        if (result.kind === 'blocked') {
          blockers.push({
            code: result.code,
            details: { jobId: job.jobId, reason: result.reason },
          });
          continue;
        }
        const finalLiveness = await revalidatePublishingRecoveryCommit({
          store: options.store,
          systemd: options.systemd,
          globalDocker: options.globalDocker,
          docker: options.docker,
          now: options.now,
        }, result.command);
        if (finalLiveness.kind === 'deferred') {
          blockers.push({
            code: finalLiveness.code,
            details: finalLiveness.details,
          });
          continue;
        }
        const written = options.ownership.apiWrite(finalLiveness.command);
        if (!written.ok) {
          blockers.push({
            code: 'PUBLISH_RECOVERY_CAS_CONFLICT',
            details: { jobId: job.jobId, conflict: written.conflict.kind },
          });
        }
      } catch (error) {
        blockers.push({
          code: 'PUBLISH_RECOVERY_PROOF_UNAVAILABLE',
          details: {
            jobId: job.jobId,
            reason: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    return Object.freeze({ blockers: Object.freeze(blockers) });
  };
}

function nonPublishingRecoveryStartupService(
  database: DatabaseSync,
  systemd: QueueSystemd,
  recovery: ReturnType<typeof createApiRecoveryService>,
  now: () => string,
): StartupService {
  return async () => {
    const rows = database.prepare(`SELECT job_id, runner_unit
      FROM jobs
      WHERE state IN (
        'starting','preflight','source','release_gates','frontend',
        'target_setup','feeds','config','building','verifying','cancel_requested'
      )
      ORDER BY accepted_at, job_id`).all() as readonly Readonly<Record<string, unknown>>[];
    const blockers: QueueBlocker[] = [];
    for (const row of rows) {
      if (typeof row.job_id !== 'string' || typeof row.runner_unit !== 'string') {
        blockers.push({ code: 'RECOVERY_STATE_INVALID' });
        continue;
      }
      const unit = await systemd.inspect(row.runner_unit);
      if (unit.active || unit.pending) continue;
      try {
        const result = await recovery.recover({
          jobId: row.job_id,
          retry: false,
          at: now(),
        });
        if (
          result.kind === 'direct-recovered'
          || result.kind === 'handed-back'
          || result.kind === 'not-eligible'
        ) continue;
        blockers.push({
          code: result.kind === 'retry-blocked'
            ? 'CLEANUP_RECOVERY_BLOCKED'
            : 'CLEANUP_RECOVERY_PENDING',
          details: { jobId: row.job_id },
        });
      } catch {
        blockers.push({
          code: 'RECOVERY_PROOF_UNAVAILABLE',
          details: { jobId: row.job_id },
        });
      }
    }
    return Object.freeze({ blockers: Object.freeze(blockers) });
  };
}

function freeBytes(stateRoot: string): Promise<number> {
  return statfs(stateRoot).then((capacity) => {
    const value = capacity.bavail * capacity.bsize;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('state filesystem capacity is invalid');
    }
    return value;
  });
}

function exactJson(left: JsonObject, right: JsonObject): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && left[key] === right[key]
    ));
}

export function recoveryLogObservation(
  database: DatabaseSync,
  physical: RecoveryPhysicalVerification,
  jobId: string,
  at: string,
): Promise<Readonly<{
  readonly snapshot: CleanupSnapshot['logs'];
  readonly direct: DirectLogProof | null;
}>> {
  const rawGenerations = database.prepare(`SELECT
      stream, generation, path, started_at, sealed_at, size_bytes, sha256
    FROM job_log_generations
    WHERE job_id=?
    ORDER BY stream, generation`).all(jobId) as readonly Readonly<Record<string, unknown>>[];
  const rawEvents = database.prepare(`SELECT
      stream, file_generation, seq, event_type, at, byte_offset, byte_length, partial
    FROM job_events
    WHERE job_id=? AND stream IS NOT NULL
    ORDER BY stream, file_generation, seq`).all(jobId) as readonly Readonly<Record<string, unknown>>[];
  const completion = database.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS seq FROM job_events WHERE job_id=?',
  ).get(jobId) as Readonly<{ seq?: unknown }> | undefined;
  if (
    completion === undefined
    || typeof completion.seq !== 'number'
    || !Number.isSafeInteger(completion.seq)
    || completion.seq < 0
  ) throw new Error('log completion sequence is invalid');
  if (rawGenerations.length === 0) {
    if (rawEvents.length !== 0) throw new Error('log events exist without generations');
    const snapshot = Object.freeze({
      runner: 'absent' as const,
      docker: 'absent' as const,
      verifiedAt: at,
    });
    return physical.logs.verify({
      jobId,
      completedAt: at,
      completionEventSeq: completion.seq,
      postcondition: snapshot,
      generations: [],
      events: [],
    }).then(() => Object.freeze({
      snapshot: Object.freeze({ runner: 'absent', docker: 'absent', verifiedAt: at }),
      direct: Object.freeze({
        runner: 'absent',
        docker: 'absent',
        verifiedAt: at,
        generationIdentity: Object.freeze({
          runner: Object.freeze([]),
          docker: Object.freeze([]),
        }),
      }),
    }));
  }

  const streams = ['runner', 'docker'] as const;
  const state: Record<(typeof streams)[number], 'absent' | 'sealed' | 'unsealed'> = {
    runner: 'absent',
    docker: 'absent',
  };
  for (const stream of streams) {
    const generations = rawGenerations.filter((row) => row.stream === stream);
    if (generations.length === 0) continue;
    state[stream] = generations.every((row, index) => (
      row.generation === index
      && typeof row.path === 'string'
      && typeof row.started_at === 'string'
      && typeof row.sealed_at === 'string'
      && typeof row.size_bytes === 'number'
      && Number.isSafeInteger(row.size_bytes)
      && row.size_bytes >= 0
      && typeof row.sha256 === 'string'
      && HASH64.test(row.sha256)
      && row.sealed_at <= at
    )) ? 'sealed' : 'unsealed';
  }
  if (
    (state.runner === 'absent') !== (state.docker === 'absent')
    || rawEvents.some((row) => row.event_type === 'log-gap')
  ) {
    if (state.runner === 'absent') state.runner = 'unsealed';
    if (state.docker === 'absent') state.docker = 'unsealed';
    if (rawEvents.some((row) => row.event_type === 'log-gap')) {
      state.runner = 'unsealed';
      state.docker = 'unsealed';
    }
  }
  const snapshot = Object.freeze({
    runner: state.runner,
    docker: state.docker,
    verifiedAt: at,
  });
  if (state.runner !== 'sealed' || state.docker !== 'sealed') {
    return Promise.resolve(Object.freeze({ snapshot, direct: null }));
  }

  const generations: RecoveryPersistedLogGeneration[] = rawGenerations.map((row) => {
    if (
      (row.stream !== 'runner' && row.stream !== 'docker')
      || typeof row.generation !== 'number'
      || typeof row.path !== 'string'
      || typeof row.started_at !== 'string'
      || typeof row.sealed_at !== 'string'
      || typeof row.size_bytes !== 'number'
      || typeof row.sha256 !== 'string'
    ) throw new Error('sealed log generation is malformed');
    return Object.freeze({
      stream: row.stream,
      generation: row.generation,
      path: row.path,
      startedAt: row.started_at,
      sealedAt: row.sealed_at,
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
    });
  });
  const events: RecoveryPersistedLogEvent[] = rawEvents.map((row) => {
    if (
      (row.stream !== 'runner' && row.stream !== 'docker')
      || typeof row.file_generation !== 'number'
      || typeof row.seq !== 'number'
      || (
        row.event_type !== 'log'
        && row.event_type !== 'log_orphan_tail'
        && row.event_type !== 'log-truncated'
      )
      || typeof row.at !== 'string'
      || typeof row.byte_offset !== 'number'
      || typeof row.byte_length !== 'number'
      || (row.partial !== 0 && row.partial !== 1)
    ) throw new Error('sealed log event is malformed');
    return Object.freeze({
      stream: row.stream,
      fileGeneration: row.file_generation,
      seq: row.seq,
      eventType: row.event_type,
      at: row.at,
      byteOffset: row.byte_offset,
      byteLength: row.byte_length,
      partial: row.partial,
    });
  });
  return physical.logs.verify({
    jobId,
    completedAt: at,
    completionEventSeq: completion.seq,
    postcondition: { runner: 'sealed', docker: 'sealed', verifiedAt: at },
    generations,
    events,
  }).then(() => {
    const generationIdentity = {
      runner: Object.freeze(generations
        .filter((row) => row.stream === 'runner')
        .map((row) => Object.freeze({
          generation: row.generation,
          path: row.path,
          startedAt: row.startedAt,
        }))),
      docker: Object.freeze(generations
        .filter((row) => row.stream === 'docker')
        .map((row) => Object.freeze({
          generation: row.generation,
          path: row.path,
          startedAt: row.startedAt,
        }))),
    };
    return Object.freeze({
      snapshot,
      direct: Object.freeze({
        runner: 'sealed',
        docker: 'sealed',
        verifiedAt: at,
        generationIdentity: Object.freeze(generationIdentity),
      }),
    });
  });
}

export async function recoveryContainerObservation(
  job: JobRecord,
  docker: DockerCancellationControls,
  at: string,
): Promise<CleanupSnapshot['container']> {
  const labels: JsonObject = {
    'org.osi.image-builder.job-id': job.jobId,
    'org.osi.image-builder.manifest-sha': job.targetManifestSha256,
  };
  const identityFields = [
    job.containerId,
    job.containerName,
    job.containerImageDigest,
    job.containerLabelJobId,
    job.containerLabelManifestSha,
    job.containerLabels,
  ];
  const anyIdentity = identityFields.some((value) => value !== null);
  const completeIdentity = identityFields.every((value) => value !== null);
  const deadline = performance.now() + 15_000;
  const matches = await docker.listByLabels(labels, deadline);
  const exactMatches = matches.filter((container) => exactJson(container.labels, labels));
  if (!anyIdentity) {
    if (matches.length !== 0) {
      throw new Error('primary-label container set is not absent');
    }
    return Object.freeze({
      kind: 'absent',
      globalLabelResult: 'no-match',
      observedAt: at,
    });
  }
  if (!completeIdentity || !exactJson(job.containerLabels!, labels)) {
    throw new Error('persisted recovery container identity is incomplete');
  }
  const observed = await docker.inspect(job.containerId!, deadline);
  if (observed === null) {
    if (matches.length !== 0) {
      throw new Error('persisted recovery container is absent but a primary-label match remains');
    }
    return Object.freeze({
      kind: 'present',
      id: job.containerId!,
      name: job.containerName!,
      imageDigest: job.containerImageDigest!,
      labels,
      globalLabelResult: 'no-match',
      observedAt: at,
    });
  }
  if (
    observed.id !== job.containerId
    || observed.name !== job.containerName
    || observed.imageDigest !== job.containerImageDigest
    || !exactJson(observed.labels, labels)
    || matches.length !== 1
    || exactMatches.length !== 1
    || exactMatches[0]!.id !== observed.id
    || exactMatches[0]!.name !== observed.name
    || exactMatches[0]!.imageDigest !== observed.imageDigest
  ) {
    throw new Error('physical recovery container does not match durable identity');
  }
  return Object.freeze({
    kind: 'present',
    id: observed.id,
    name: observed.name,
    imageDigest: observed.imageDigest,
    labels,
    globalLabelResult: 'single-exact-match',
    observedAt: at,
  });
}

async function recoveryStagingObservation(
  job: JobRecord,
  publisher: PublisherClient,
  at: string,
): Promise<CleanupSnapshot['staging']> {
  const observation = await publisher.recheck({
    rootId: job.rootId,
    jobId: job.jobId,
    branchSlug: encodeBranchSlug(job.branch),
    sourceSha: job.pinnedSha,
    targetId: job.targetId,
  });
  if (
    observation.available !== true
    || observation.mutationCount !== 0
    || observation.staging === undefined
    || observation.staging === 'unknown'
  ) {
    throw new Error('publisher could not prove recovery staging state');
  }
  if (observation.staging === 'absent') {
    return Object.freeze({ kind: 'absent', path: null });
  }
  if (job.artifactStagingPath === null) {
    return Object.freeze({
      kind: 'physical-present',
      path: `staging/${job.jobId}`,
      sha256: null,
      size: null,
      observedAt: at,
    });
  }
  return Object.freeze({
    kind: 'present',
    path: job.artifactStagingPath,
    sha256: job.artifactSha256,
    size: job.artifactSize,
  });
}

async function directRecoveryProof(
  job: JobRecord,
  runnerUnit: string,
  unitInactiveAt: string,
  database: DatabaseSync,
  docker: DockerCancellationControls,
  publisher: PublisherClient,
  physical: RecoveryPhysicalVerification,
  at: string,
): Promise<Extract<DirectInterruptionProof, { readonly kind: 'active' }> | null> {
  if (
    job.runnerLeaseOwner === null
    || job.runnerLeaseExpiresAt === null
    || job.runnerLeaseExpiresAt >= at
    || job.runnerUnit !== runnerUnit
    || job.publishState !== null
  ) return null;
  const container = await recoveryContainerObservation(job, docker, at);
  const staging = await recoveryStagingObservation(job, publisher, at);
  const logs = await recoveryLogObservation(database, physical, job.jobId, at);
  if (
    container.kind !== 'absent'
    || staging.kind !== 'absent'
    || logs.direct === null
  ) return null;
  return Object.freeze({
    kind: 'active',
    runnerUnit,
    runnerLeaseOwner: job.runnerLeaseOwner,
    runnerLeaseExpiresAt: job.runnerLeaseExpiresAt,
    leaseStaleAt: at,
    unitInactiveAt,
    container,
    staging,
    logs: logs.direct,
    blocker: 'none',
    cleanupAdmission: null,
    cleanupFence: null,
  });
}

async function startFailureRecoveryProof(
  jobId: string,
  runnerUnit: string,
  startAttemptedAt: string,
  database: DatabaseSync,
  store: BuilderStore,
  docker: DockerCancellationControls,
  publisher: PublisherClient,
  physical: RecoveryPhysicalVerification,
  now: () => string,
): Promise<Extract<DirectInterruptionProof, { readonly kind: 'start-failure' }> | null> {
  const at = now();
  const job = store.getJob(jobId);
  if (
    job.state !== 'starting'
    || job.runnerUnit !== runnerUnit
    || job.runnerLeaseOwner !== null
    || job.runnerLeaseExpiresAt !== null
    || job.publishState !== null
    || at < startAttemptedAt
  ) return null;
  const container = await recoveryContainerObservation(job, docker, at);
  const staging = await recoveryStagingObservation(job, publisher, at);
  const logs = await recoveryLogObservation(database, physical, jobId, at);
  if (
    container.kind !== 'absent'
    || staging.kind !== 'absent'
    || logs.direct === null
  ) return null;
  return Object.freeze({
    kind: 'start-failure',
    runnerUnit,
    startAttemptedAt,
    unitInactiveAt: at,
    runnerLeaseOwner: null,
    runnerLeaseExpiresAt: null,
    container,
    staging,
    logs: logs.direct,
    blocker: 'none',
    cleanupAdmission: null,
    cleanupFence: null,
  });
}

export function physicalRecoveryProbe(
  systemd: ReturnType<typeof createProductionSystemdAdapter>,
  database: DatabaseSync,
  store: BuilderStore,
  docker: DockerCancellationControls,
  publisher: PublisherClient,
  physical: RecoveryPhysicalVerification,
): Parameters<typeof createProductionRecoveryInspector>[0]['physical'] {
  return Object.freeze({
    inspect: async ({
      job,
      at,
    }: Parameters<Parameters<typeof createProductionRecoveryInspector>[0]['physical']['inspect']>[0]) => {
      const startedAt = at;
      const fullJob = store.getJob(job.jobId);
      const runnerObservation = await systemd.inspectRecovery(
        `osi-image-builder-runner@${job.jobId}.service`,
      );
      const runner = Object.freeze({ ...runnerObservation, observedAt: at });
      const cleanup = job.cleanupAdmissionId === null
        ? null
        : {
          ...await systemd.inspectRecovery(
            `osi-image-builder-cleanup@${job.cleanupAdmissionId}.service`,
          ),
          observedAt: at,
          admissionId: job.cleanupAdmissionId,
          generation: job.cleanupFenceGeneration ?? 0,
        };
      const finishedAt = at;
      let directProof: DirectInterruptionProof | null = null;
      let cleanupSnapshot: CleanupSnapshot | null = null;
      const cleanupInProgress = cleanup?.active === true
        && (job.cleanupLeaseStatus === 'admitted' || job.cleanupLeaseStatus === 'claimed')
        && job.cleanupLeaseExpiresAt !== null
        && job.cleanupLeaseExpiresAt > at;
      if (!runner.active && !cleanupInProgress) {
        directProof = await directRecoveryProof(
          fullJob,
          runner.unit,
          runner.observedAt,
          database,
          docker,
          publisher,
          physical,
          finishedAt,
        );
        if (directProof === null) {
          const container = await recoveryContainerObservation(fullJob, docker, finishedAt);
          const staging = await recoveryStagingObservation(fullJob, publisher, finishedAt);
          const logs = (await recoveryLogObservation(
            database,
            physical,
            fullJob.jobId,
            finishedAt,
          )).snapshot;
          const preparationIntent = fullJob.publishState === 'not_started'
            && fullJob.artifactStagingPath !== null;
          const stagingOrLogWork = staging.kind !== 'absent'
            || logs.runner === 'unsealed'
            || logs.docker === 'unsealed'
            || preparationIntent;
          cleanupSnapshot = Object.freeze({
            runner: Object.freeze({
              unit: runner.unit,
              owner: fullJob.runnerLeaseOwner,
              leaseExpiresAt: fullJob.runnerLeaseExpiresAt,
              inactiveAt: runner.observedAt,
              observedAt: runner.observedAt,
            }),
            state: fullJob.state as CleanupSnapshot['state'],
            container,
            staging,
            logs,
            blocker: container.kind === 'present'
              ? 'container'
              : stagingOrLogWork ? 'staging-or-log' : 'none',
          });
        }
      }
      return Object.freeze({
        jobId: job.jobId,
        state: job.state,
        startedAt,
        finishedAt,
        runner: {
          ...runner,
          activity: runner.active ? 'active' as const : 'inactive' as const,
        },
        cleanup: cleanup === null
          ? null
          : {
            ...cleanup,
            activity: cleanup.active ? 'active' as const : 'inactive' as const,
          },
        directProof,
        cleanupSnapshot,
      });
    },
  });
}

function recoveryHandBack(
  docker: DockerRecoveryAdapter,
  physical: RecoveryPhysicalVerification,
): Parameters<typeof createCleanupAdmissionRecovery>[0]['handBack'] {
  return Object.freeze({ docker, ...physical });
}

export async function assembleProductionApi(
  options: ProductionApiAssemblyOptions = {},
): Promise<{ readonly process: ApiProcess; readonly seams: ProductionApiAssemblySeams }> {
  const now = options.now ?? (() => new Date().toISOString());
  const loaded = options.loadedConfig ?? await loadConfig({ env: options.env });
  const executable = options.executablePath ?? process.argv[1] ?? process.execPath;
  const versionRoot = resolve(
    options.versionRoot
      ?? options.locateVersionRoot?.(executable)
      ?? canonicalVersionRoot(executable),
  );
  const version = installedVersion(versionRoot);
  const packageDirectory = versionRoot;
  const lockPath = join(packageDirectory, 'builder.lock.json');
  if (resolve(loaded.config.builderLockPath) !== lockPath) {
    throw new Error('configured builder lock does not match the selected installation');
  }
  const lockAuthority = await readLock(lockPath, version);
  const lock = lockAuthority.lock;
  await loadInstalledDependencyEgressPolicy(packageDirectory, lock.dependencyEgressProxySha256);
  const manifest = loadManifest(join(packageDirectory, 'manifest', 'targets.json'));
  const [executionDefinitionBytes, runnerBytes, cleanupWorkerBytes] = await Promise.all([
    readFile(join(packageDirectory, 'execution-definition.json')),
    readFile(join(packageDirectory, 'bin', 'osi-image-builder-runner')),
    readFile(join(packageDirectory, 'bin', 'osi-image-builder-cleanup')),
  ]);
  const executionDefinitionSha256 = createHash('sha256').update(executionDefinitionBytes).digest('hex');
  if (executionDefinitionSha256 !== lock.executionDefinitionSha256 || lock.imageId === undefined) {
    throw new Error('selected installation has no complete admitted builder identity');
  }
  const database = openBuilderDatabase(join(loaded.stateRoot, 'jobs.sqlite'), {
    migrationsDirectory: join(packageDirectory, 'api', 'migrations'),
  });
  try {
  const store = new BuilderStore(database);
  const apiStore = createApiStore(database, store);
  const ownership = new OwnershipStore(database, { now, stateRoot: loaded.stateRoot });
  const executor = options.commandExecutor ?? createCommandExecutor();
  const publisher = await createPublisher(packageDirectory, lock, loaded, executor);
  const source = new SourceResolver({
    repositoryPath: loaded.config.repository.path,
    remote: loaded.config.repository.remote,
    now,
  });
  const branches = new BranchCache(source);
  const defaults = createReadOnlyPreflightDefaults();
  const preflight = new PreflightService({
    loadedConfig: loaded,
    manifest,
    capabilities: {
      ...defaults,
      clock: { now: () => new Date(now()) },
      sourceResolver: source,
    },
    idFactory: () => `pf_${randomUUID().replaceAll('-', '')}`,
  });
  const enqueue = createProductionEnqueueService({
    manifest,
    builderIdentity: {
      packageVersion: lock.packageVersion,
      packageRoot: packageDirectory,
      lockSha256: lockAuthority.sha256,
      executionDefinitionSha256,
      targetManifestSha256: manifest.sha256,
      runnerSha256: createHash('sha256').update(runnerBytes).digest('hex'),
      cleanupWorkerSha256: createHash('sha256').update(cleanupWorkerBytes).digest('hex'),
      dependencyEgressProxySha256: lock.dependencyEgressProxySha256,
      imageReference: `${lock.imageRepository}@sha256:${lock.imageDigest}`,
      imageId: `sha256:${lock.imageId}`,
      imageDigest: lock.imageDigest,
    },
    preflight,
    ownership,
    store,
  });
  const bus = await deriveSystemdBusEnvironment();
  const systemd = createProductionSystemdAdapter(executor, bus, now, {
    configRoot: loaded.configRoot,
    stateRoot: loaded.stateRoot,
    repositoryPath: loaded.config.repository.path,
    approvedOutputRoots: loaded.config.approvedOutputRoots.map((root) => root.path),
  });
  const docker = dockerRecoveryAdapter(executor, now);
  const recoveryDocker = createDockerCancellationControls({
    commandExecutor: executor,
    dockerPath: DOCKER_EXECUTABLE,
    expectedImageDigest: lock.imageDigest,
    maxCaptureBytes: 128 * 1024,
  });
  const physical = createRecoveryPhysicalVerification({
    stateRootAuthority: loaded.pathAuthorities.stateRoot,
    approvedRootRegistry: loaded.pathAuthorities.approvedRoots,
  });
  const recovery = createCleanupAdmissionRecovery({
    stateRoot: loaded.stateRoot,
    db: database,
    ownership,
    systemd: createProductionCleanupSystemd(systemd, async (unit) => {
      const match = unit.match(CLEANUP_UNIT);
      if (match === null) throw new Error('cleanup systemd unit is invalid');
      const row = database.prepare(`SELECT lease.unit_name, lease.status,
        job.builder_identity_status, job.builder_package_version, job.builder_package_root,
        job.builder_lock_sha256, job.builder_execution_definition_sha256,
        job.builder_target_manifest_sha256, job.builder_runner_sha256,
        job.builder_cleanup_worker_sha256, job.builder_image_reference,
        job.builder_dependency_egress_proxy_sha256,
        job.builder_image_id, job.builder_image_digest
        FROM cleanup_leases AS lease
        JOIN jobs AS job ON job.job_id=lease.job_id
        WHERE lease.admission_id=?`).get(match[1]!) as Record<string, unknown> | undefined;
      if (
        row === undefined
        || row.unit_name !== unit
        || (row.status !== 'admitted' && row.status !== 'claimed')
        || row.builder_identity_status !== 'admitted'
      ) throw new Error('cleanup admission has no complete admitted builder identity');
      return parseBuilderIdentity({
        packageVersion: row.builder_package_version,
        packageRoot: row.builder_package_root,
        lockSha256: row.builder_lock_sha256,
        executionDefinitionSha256: row.builder_execution_definition_sha256,
        targetManifestSha256: row.builder_target_manifest_sha256,
        runnerSha256: row.builder_runner_sha256,
        cleanupWorkerSha256: row.builder_cleanup_worker_sha256,
        dependencyEgressProxySha256: row.builder_dependency_egress_proxy_sha256,
        imageReference: row.builder_image_reference,
        imageId: row.builder_image_id,
        imageDigest: row.builder_image_digest,
      });
    }),
    handBack: recoveryHandBack(docker, physical),
  });
  const recoveryService = createApiRecoveryService({
    store,
    ownership,
    recovery,
    inspector: createProductionRecoveryInspector({
      physical: physicalRecoveryProbe(
        systemd,
        database,
        store,
        recoveryDocker,
        publisher,
        physical,
      ),
    }),
  });
  const cancellation = createApiCancellationService({
    store,
    ownership,
    systemdBusEnvironment: bus,
    commandExecutor: executor,
    reportError: reportCancellationProcessError,
  });
  const blockerVerifier = createPublishBlockerFinalVerifier(
    loaded.pathAuthorities.approvedRoots,
  );
  const blockers = createPublishBlockerRecheckService({
    store,
    ownership,
    verifier: blockerVerifier,
    publisher,
    clock: { now },
  });
  const evidenceReader = createIndexedEvidenceReader({
    stateRoot: loaded.pathAuthorities.stateRoot,
  });
  const sse = createSseService({
    openStream: (jobId) => new DurableLogStream({
      db: database,
      root: join(loaded.stateRoot, 'jobs', jobId),
      jobId,
      now,
    }),
  });
  const health = async () => collectHealthSnapshot({
    db: database,
    now: now(),
    diskFreeBytes: await freeBytes(loaded.stateRoot),
    builderImage: {
      id: lock.imageId ?? null,
      digest: lock.imageDigest,
    },
  });
  const freshnessProtocolStore = createFreshnessProtocolStore(store, ownership);
  const freshnessResolver = createFreshnessResolver(source, now);
  const freshnessErrorEvidence = createFreshnessErrorEvidence(loaded);
  const createFreshness = (): Promise<ApiFreshnessServer> => createApiFreshnessServer({
    stateRoot: loaded.pathAuthorities.stateRoot,
    store: freshnessProtocolStore,
    resolver: freshnessResolver,
    errorEvidence: freshnessErrorEvidence,
    now,
  });
  const retention = createRetentionStartupHook({
    paths: {
      stateRoot: loaded.stateRoot,
      builderOwnedRoots: [loaded.stateRoot],
      approvedQuarantineRoots: loaded.config.approvedOutputRoots.map(
        (root) => root.quarantinePath,
      ),
      approvedReleaseRoots: loaded.config.approvedOutputRoots.map((root) => root.path),
    },
    db: database,
    freeBytes: () => freeBytes(loaded.stateRoot),
    clock: { now },
  });
  const migrations = migrationStartupService(database);
  const cleanupAdmissions = cleanupAdmissionsStartupService(recovery);
  const liveRunnerClassification = liveRunnerStartupService(database, systemd, now);
  const cancellationCoordination = cancellationCoordinationStartupService(cancellation);
  const stalePublishingRecovery = createPublishingRecoveryStartupService({
    database,
    store,
    ownership,
    systemd,
    docker: recoveryDocker,
    globalDocker: docker,
    publisher,
    physical,
    loaded,
    now,
  });
  const nonPublishingInterruption = nonPublishingRecoveryStartupService(
    database,
    systemd,
    recoveryService,
    now,
  );
  const startup = createStartupBootstrap({
    queue: {
      db: database,
      ownership,
      systemd,
      safety: queueSafety(docker),
      directInterrupt: async ({ jobId, runnerUnit, startAttemptedAt }) => (
        startFailureRecoveryProof(
          jobId,
          runnerUnit,
          startAttemptedAt,
          database,
          store,
          recoveryDocker,
          publisher,
          physical,
          now,
        )
      ),
      clock: { now },
    },
    services: {
      migrations: migrations,
      cleanupAdmissions: cleanupAdmissions,
      liveRunnerClassification: liveRunnerClassification,
      cancellationCoordination: cancellationCoordination,
      stalePublishingRecovery: stalePublishingRecovery,
      nonPublishingInterruption: nonPublishingInterruption,
      retention,
    },
  });
  const targets: readonly ApiTargetConfig[] = manifest.manifest.targets.map(
    (target) => ({
      ...target,
      operations: target.operations,
      configSymbols: target.configSymbols,
    }),
  );
  const routeHandler = createApiRouteHandler({
    version,
    config: loaded.config,
    targets,
    health,
    branches,
    preflight,
    enqueue,
    now,
    cancellation,
    recovery: recoveryService,
    publishBlockerRecheck: blockers,
    eventStream: sse,
    store: apiStore,
    evidenceReader,
  });
  const createHttp: ApiProcessDependencies['createHttp'] = (
    staticUi: Pick<StaticUiService, 'resolve'>,
  ) => createHttpServer({
    origin: `http://127.0.0.1:${options.port ?? DEFAULT_PORT}`,
    routeHandler,
    staticUi,
  });
  const dependencies: ApiProcessDependencies = {
    port: options.port ?? DEFAULT_PORT,
    createStaticUi: () => createStaticUiService(join(packageDirectory, 'ui')),
    bootstrap: startup,
    startFreshness: createFreshness,
    createHttp,
    closeDatabase: () => database.close(),
    signals: process,
  };
  const apiProcess = createDispatchingApiProcess({
    process: createApiProcess(dependencies),
    bootstrap: startup,
  });
  return {
    process: apiProcess,
    seams: {
      loadedConfig: loaded,
      versionRoot,
      manifest,
      database,
      store,
      ownership,
    },
  };
  } catch (error) {
    database.close();
    throw error;
  }
}

export async function createProductionApiProcess(
  options: ProductionApiAssemblyOptions = {},
): Promise<ApiProcess> {
  return (await assembleProductionApi(options)).process;
}
