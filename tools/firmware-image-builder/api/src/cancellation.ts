import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import {
  ACTIVE_RECOVERY_STATES,
  TERMINAL_STATES,
  type ActiveRecoveryState,
  type JobState,
} from '../../domain/types.js';
import {
  CommandExecutionError,
  createCommandExecutor,
  type CommandExecutor,
  type CommandResult,
} from '../../runner/src/command-executor.js';
import type {
  ApiWriteCommand,
  OwnershipResult,
} from './ownership.js';
import type {
  BuilderStore,
  CancellationJobRecord,
  JsonObject,
} from './store.js';

const SYSTEMCTL = '/usr/bin/systemctl';
const RUNNER_UNIT = /^osi-image-builder-runner@([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.service$/u;
const DEFAULT_COOPERATIVE_TIMEOUT_MS = 30_000;
const DEFAULT_SYSTEMD_GRACE_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_OBSERVATION_TEXT_BYTES = 8_192;
const ACTIVE_STATES = new Set<JobState>(ACTIVE_RECOVERY_STATES);
const TERMINAL_STATE_SET = new Set<JobState>(TERMINAL_STATES);
const SYSTEMD_ENVIRONMENT_KEYS = new Set([
  'PATH', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
]);

export interface ApiCancellationClock {
  readonly now: () => string;
  readonly monotonicNow: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export interface ApiCancellationRequest {
  readonly jobId: string;
  readonly reason: string;
  readonly at: string;
}

export interface ApiCancellationSystemdObservation {
  readonly commandOutcome: 'completed' | 'timed-out' | 'transport-error';
  readonly activity: 'active' | 'inactive' | 'unknown';
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface ApiCancellationSystemd {
  readonly signalCancellation: (runnerUnit: string, deadlineMonotonic: number) => Promise<ApiCancellationSystemdObservation>;
  readonly stopRunner: (runnerUnit: string, deadlineMonotonic: number) => Promise<ApiCancellationSystemdObservation>;
  readonly inspectRunner: (runnerUnit: string, deadlineMonotonic: number) => Promise<ApiCancellationSystemdObservation>;
}

export interface ApiCancellationStore {
  readonly getJob: (jobId: string) => CancellationJobRecord;
  readonly getCancellationJob?: (jobId: string) => CancellationJobRecord;
}

export interface ApiCancellationOwnership {
  readonly apiWrite: (command: ApiWriteCommand) => OwnershipResult;
}

export interface ApiCancellationOptions {
  readonly store: ApiCancellationStore | Pick<BuilderStore, 'getJob' | 'getCancellationJob'>;
  readonly ownership: ApiCancellationOwnership;
  readonly systemd: ApiCancellationSystemd;
  readonly clock?: ApiCancellationClock;
  readonly cooperativeTimeoutMs?: number;
  readonly systemdGraceMs?: number;
  readonly pollIntervalMs?: number;
  readonly coordinatorId?: string;
}

export type ApiCancellationResult =
  | Readonly<{ readonly kind: 'queued-cancelled'; readonly jobId: string; readonly state: 'cancelled'; readonly requestPersisted: true }>
  | Readonly<{ readonly kind: 'late-publishing'; readonly jobId: string; readonly state: 'publishing'; readonly late: true; readonly requestPersisted: true }>
  | Readonly<{ readonly kind: 'runner-terminal'; readonly jobId: string; readonly state: Extract<JobState, 'succeeded' | 'failed' | 'cancelled' | 'interrupted'>; readonly runnerOwned: true }>
  | Readonly<{ readonly kind: 'already-terminal'; readonly jobId: string; readonly state: Extract<JobState, 'succeeded' | 'failed' | 'cancelled' | 'interrupted'>; readonly requestPersisted: false }>
  | Readonly<{ readonly kind: 'recovery-blocked'; readonly jobId: string; readonly state: ActiveRecoveryState; readonly blockerCode: 'RUNNER_DISAPPEARED'; readonly evidence: JsonObject; readonly requestPersisted: boolean }>
  | Readonly<{ readonly kind: 'request-not-accepted'; readonly jobId: string; readonly state: JobState; readonly evidence: JsonObject }>;

export interface SystemdCancellationAdapterOptions {
  readonly commandExecutor: Pick<CommandExecutor, 'run'>;
  readonly env: Readonly<Record<string, string>>;
  readonly monotonicNow?: () => number;
  readonly maxCaptureBytes?: number;
}

export interface ApiCancellationService {
  readonly requestCancellation: (request: ApiCancellationRequest) => Promise<ApiCancellationResult>;
}

export interface ApiCancellationServiceOptions {
  readonly store: ApiCancellationOptions['store'];
  readonly ownership: ApiCancellationOwnership;
  readonly systemdBusEnvironment: Readonly<{
    readonly XDG_RUNTIME_DIR: string;
    readonly DBUS_SESSION_BUS_ADDRESS: string;
  }>;
  readonly commandExecutor?: Pick<CommandExecutor, 'run'>;
  readonly clock?: ApiCancellationClock;
  readonly coordinatorId?: string;
}

const defaultClock: ApiCancellationClock = Object.freeze({
  now: () => new Date().toISOString(),
  monotonicNow: () => performance.now(),
  sleep: (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
});

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
}

function validateRunnerUnit(jobId: string, runnerUnit: string | null): runnerUnit is string {
  if (runnerUnit === null || runnerUnit.length === 0) return false;
  const match = RUNNER_UNIT.exec(runnerUnit);
  return match !== null && match[1] === jobId;
}

function exactRunnerUnit(jobId: string): string {
  const unit = `osi-image-builder-runner@${jobId}.service`;
  if (!validateRunnerUnit(jobId, unit)) throw new TypeError('job id cannot form an exact runner unit');
  return unit;
}

function boundedObservationText(value: string): string {
  if (value.length === 0) return '-';
  const bytes = Buffer.from(value, 'utf8');
  return bytes.length <= MAX_OBSERVATION_TEXT_BYTES
    ? value
    : `${bytes.subarray(0, MAX_OBSERVATION_TEXT_BYTES).toString('utf8')}[truncated]`;
}

function publicObservation(observation: ApiCancellationSystemdObservation): JsonObject {
  return {
    commandOutcome: observation.commandOutcome,
    activity: observation.activity,
    argv: [...observation.argv],
    exitCode: observation.exitCode,
    signal: observation.signal,
    stdout: boundedObservationText(observation.stdout),
    stderr: boundedObservationText(observation.stderr),
    timedOut: observation.timedOut,
  };
}

function commandObservation(
  action: 'signal' | 'stop' | 'inspect',
  argv: readonly string[],
  result: CommandResult | null,
  error?: unknown,
): ApiCancellationSystemdObservation {
  const message = error instanceof Error ? error.message : error === undefined ? '' : String(error);
  const output = result?.stdout.trim() ?? '';
  const activity = action !== 'inspect' || result?.timedOut === true
    ? 'unknown'
    : result?.exitCode === 0 && ['active', 'activating', 'reloading'].includes(output)
      ? 'active'
      : result?.exitCode === 3 && ['inactive', 'failed', 'deactivating'].includes(output)
        ? 'inactive'
        : 'unknown';
  return {
    commandOutcome: result?.timedOut === true
      ? 'timed-out'
      : error === undefined
        ? 'completed'
        : 'transport-error',
    activity,
    argv: [...argv],
    exitCode: result?.exitCode ?? null,
    signal: result?.signal ?? null,
    stdout: result?.stdout ?? '',
    stderr: result?.stderr ?? message,
    timedOut: result?.timedOut ?? false,
  };
}

function remainingTimeout(deadlineMonotonic: number, monotonicNow: () => number): number {
  return Math.max(1, Math.ceil(deadlineMonotonic - monotonicNow()));
}

function validateCommandAdapterUnit(runnerUnit: string): void {
  if (RUNNER_UNIT.exec(runnerUnit) === null) throw new TypeError('runner unit grammar is invalid');
}

function fixedSystemdArgv(action: 'signal' | 'stop' | 'inspect', runnerUnit: string): readonly string[] {
  return action === 'signal'
    ? [SYSTEMCTL, '--user', 'kill', '--kill-whom=main', '--signal=SIGUSR1', runnerUnit]
    : action === 'stop'
      ? [SYSTEMCTL, '--user', 'stop', runnerUnit]
      : [SYSTEMCTL, '--user', 'is-active', runnerUnit];
}

function failedSystemdObservation(action: 'signal' | 'stop' | 'inspect', runnerUnit: string, error: unknown): ApiCancellationSystemdObservation {
  const commandError = error instanceof CommandExecutionError ? error : null;
  return commandObservation(
    action,
    fixedSystemdArgv(action, runnerUnit),
    commandError?.result ?? null,
    error,
  );
}

export function createSystemdCancellationAdapter(options: SystemdCancellationAdapterOptions): ApiCancellationSystemd {
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const maxCaptureBytes = options.maxCaptureBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maxCaptureBytes) || maxCaptureBytes < 1) throw new TypeError('systemd observation capture limit is invalid');
  const environmentKeys = Object.keys(options.env);
  if (environmentKeys.some((key) => !SYSTEMD_ENVIRONMENT_KEYS.has(key))) {
    throw new TypeError('systemd cancellation environment contains an unsupported key');
  }
  if (
    options.env.PATH !== '/usr/bin:/bin'
    || options.env.LANG !== 'C'
    || options.env.LC_ALL !== 'C'
  ) throw new TypeError('systemd cancellation environment is not fixed');

  const run = async (
    runnerUnit: string,
    action: 'signal' | 'stop' | 'inspect',
    deadlineMonotonic: number,
  ): Promise<ApiCancellationSystemdObservation> => {
    validateCommandAdapterUnit(runnerUnit);
    if (!Number.isFinite(deadlineMonotonic)) throw new TypeError('systemd deadline is invalid');
    const argv = fixedSystemdArgv(action, runnerUnit);
    try {
      const result = await options.commandExecutor.run(argv, {
        env: { ...options.env },
        timeoutMs: remainingTimeout(deadlineMonotonic, monotonicNow),
        maxCaptureBytes,
      });
      return commandObservation(action, argv, result);
    } catch (error) {
      return failedSystemdObservation(action, runnerUnit, error);
    }
  };

  return Object.freeze({
    signalCancellation: (runnerUnit: string, deadlineMonotonic: number) => run(runnerUnit, 'signal', deadlineMonotonic),
    stopRunner: (runnerUnit: string, deadlineMonotonic: number) => run(runnerUnit, 'stop', deadlineMonotonic),
    inspectRunner: (runnerUnit: string, deadlineMonotonic: number) => run(runnerUnit, 'inspect', deadlineMonotonic),
  });
}

export function createApiCancellationService(options: ApiCancellationServiceOptions): ApiCancellationService {
  const busEnvironmentKeys = Object.keys(options.systemdBusEnvironment);
  if (
    busEnvironmentKeys.length !== 2
    || !busEnvironmentKeys.includes('XDG_RUNTIME_DIR')
    || !busEnvironmentKeys.includes('DBUS_SESSION_BUS_ADDRESS')
  ) throw new TypeError('systemd bus environment contains unsupported keys');
  const env = Object.freeze({
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    XDG_RUNTIME_DIR: options.systemdBusEnvironment.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: options.systemdBusEnvironment.DBUS_SESSION_BUS_ADDRESS,
  });
  const systemd = createSystemdCancellationAdapter({
    commandExecutor: options.commandExecutor ?? createCommandExecutor(),
    env,
    monotonicNow: options.clock?.monotonicNow,
  });
  return Object.freeze({
    requestCancellation: (request: ApiCancellationRequest) => requestCancellation({
      store: options.store,
      ownership: options.ownership,
      systemd,
      clock: options.clock,
      coordinatorId: options.coordinatorId,
    }, request),
  });
}

function readCancellationJob(store: ApiCancellationOptions['store'], jobId: string): CancellationJobRecord {
  return store.getCancellationJob?.(jobId) ?? store.getJob(jobId);
}

function isTerminal(job: CancellationJobRecord): job is CancellationJobRecord & { readonly state: Extract<JobState, 'succeeded' | 'failed' | 'cancelled' | 'interrupted'> } {
  return TERMINAL_STATE_SET.has(job.state);
}

function currentAt(clock: ApiCancellationClock, minimum: string): string {
  const observed = clock.now();
  return observed >= minimum ? observed : minimum;
}

function addMilliseconds(at: string, milliseconds: number): string {
  return new Date(Date.parse(at) + milliseconds).toISOString();
}

function monotonicDeadline(clock: ApiCancellationClock, deadlineAt: string): number {
  return clock.monotonicNow() + Math.max(0, Date.parse(deadlineAt) - Date.parse(clock.now()));
}

function isCanonicalInstant(value: string): boolean {
  try { return new Date(value).toISOString() === value; }
  catch { return false; }
}

function hasLiveRunnerLease(
  job: CancellationJobRecord,
  at: string,
): job is CancellationJobRecord & { readonly runnerLeaseOwner: string; readonly runnerLeaseExpiresAt: string } {
  return job.runnerLeaseOwner !== null
    && job.runnerLeaseOwner.length > 0
    && job.runnerLeaseExpiresAt !== null
    && isCanonicalInstant(job.runnerLeaseExpiresAt)
    && job.runnerLeaseExpiresAt > at;
}

function requestCommand(
  request: ApiCancellationRequest,
  late: boolean,
  cooperativeDeadlineAt: string,
): Extract<ApiWriteCommand, { readonly kind: 'request-cancellation' }> {
  return {
    kind: 'request-cancellation',
    jobId: request.jobId,
    reason: request.reason,
    at: request.at,
    cooperativeDeadlineAt: late ? undefined : cooperativeDeadlineAt,
    error: late ? { reason: request.reason, late: true } : { reason: request.reason },
  };
}

function outcomeForTerminal(jobId: string, job: CancellationJobRecord, requestPersisted: boolean): ApiCancellationResult {
  if (requestPersisted) return { kind: 'runner-terminal', jobId, state: job.state as Extract<JobState, 'succeeded' | 'failed' | 'cancelled' | 'interrupted'>, runnerOwned: true };
  return { kind: 'already-terminal', jobId, state: job.state as Extract<JobState, 'succeeded' | 'failed' | 'cancelled' | 'interrupted'>, requestPersisted: false };
}

function durableBlocker(
  options: ApiCancellationOptions,
  job: CancellationJobRecord,
  requestPersisted: boolean,
  requestedAt: string,
  evidence: JsonObject,
): ApiCancellationResult {
  let observed = job;
  let attemptedEvidence = evidence;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (observed.cleanupBlockerCode === 'RUNNER_DISAPPEARED' && observed.cleanupBlocker !== null) {
      return { kind: 'recovery-blocked', jobId: observed.jobId, state: observed.state as ActiveRecoveryState, blockerCode: 'RUNNER_DISAPPEARED', requestPersisted, evidence: observed.cleanupBlocker };
    }
    if (!ACTIVE_STATES.has(observed.state) || observed.cancelRequestedAt === null) {
      if (isTerminal(observed)) return outcomeForTerminal(job.jobId, observed, requestPersisted);
      return { kind: 'request-not-accepted', jobId: observed.jobId, state: observed.state, evidence: attemptedEvidence };
    }
    const at = currentAt(options.clock ?? defaultClock, observed.cancelRequestedAt);
    try {
      options.ownership.apiWrite({
        kind: 'cancellation-recovery-blocker',
        jobId: observed.jobId,
        expectedState: observed.state as ActiveRecoveryState,
        cancelRequestedAt: observed.cancelRequestedAt,
        observedRunnerUnit: observed.runnerUnit,
        observedOwner: observed.runnerLeaseOwner,
        observedLeaseExpiresAt: observed.runnerLeaseExpiresAt,
        blocker: attemptedEvidence,
        at,
      });
    } catch {
      // The durable re-read below is authoritative for conflicts and faults.
    }
    const latest = readCancellationJob(options.store, job.jobId);
    if (latest.cleanupBlockerCode === 'RUNNER_DISAPPEARED' && latest.cleanupBlocker !== null) {
      return { kind: 'recovery-blocked', jobId: latest.jobId, state: latest.state as ActiveRecoveryState, blockerCode: 'RUNNER_DISAPPEARED', requestPersisted, evidence: latest.cleanupBlocker };
    }
    if (isTerminal(latest)) return outcomeForTerminal(job.jobId, latest, requestPersisted);
    attemptedEvidence = {
      kind: 'api-cancellation-fail-closed',
      reason: 'runner identity changed while recovery blocker CAS was in progress',
      requestedAt,
      priorEvidence: attemptedEvidence,
      persistedRunnerUnit: latest.runnerUnit,
      observedOwner: latest.runnerLeaseOwner,
      observedLeaseExpiresAt: latest.runnerLeaseExpiresAt,
      state: latest.state,
    };
    observed = latest;
  }
  return {
    kind: 'request-not-accepted',
    jobId: observed.jobId,
    state: observed.state,
    evidence: {
      kind: 'cancellation-recovery-blocker-not-committed',
      requestedAt,
      attempted: attemptedEvidence,
      observedState: observed.state,
      observedRunnerUnit: observed.runnerUnit,
      observedOwner: observed.runnerLeaseOwner,
      observedLeaseExpiresAt: observed.runnerLeaseExpiresAt,
    },
  };
}

function failedClosed(
  options: ApiCancellationOptions,
  job: CancellationJobRecord,
  requestPersisted: boolean,
  requestedAt: string,
  reason: string,
): ApiCancellationResult {
  return durableBlocker(options, job, requestPersisted, requestedAt, {
    kind: 'api-cancellation-fail-closed',
    reason,
    requestedAt,
    persistedRunnerUnit: job.runnerUnit,
    expectedRunnerUnit: (() => { try { return exactRunnerUnit(job.jobId); } catch { return null; } })(),
    observedOwner: job.runnerLeaseOwner,
    observedLeaseExpiresAt: job.runnerLeaseExpiresAt,
    state: job.state,
  });
}

function writeRequest(
  options: ApiCancellationOptions,
  request: ApiCancellationRequest,
  late: boolean,
  cooperativeDeadlineAt: string,
): { readonly accepted: boolean; readonly requestPersisted: boolean } {
  try {
    const result = options.ownership.apiWrite(requestCommand(request, late, cooperativeDeadlineAt));
    if (result.ok) return { accepted: true, requestPersisted: true };
    return { accepted: false, requestPersisted: false };
  } catch {
    return { accepted: false, requestPersisted: false };
  }
}

function writeBlocker(
  options: ApiCancellationOptions,
  job: CancellationJobRecord,
  requestedAt: string,
  cooperativeDeadlineAt: string,
  graceDeadlineAt: string,
  signal: JsonObject | null,
  stop: JsonObject | null,
  inspections: JsonObject | null,
): ApiCancellationResult {
  const evidence: JsonObject = {
    kind: 'api-cancellation-escalation',
    reason: 'runner did not commit a terminal cancellation result before systemd grace expired',
    requestedAt,
    runnerUnit: job.runnerUnit,
    observedOwner: job.runnerLeaseOwner,
    observedLeaseExpiresAt: job.runnerLeaseExpiresAt,
    cooperativeDeadlineAt,
    graceDeadlineAt,
    systemd: {
      signal,
      stop,
      inspections,
    },
  };
  return durableBlocker(options, job, true, requestedAt, evidence);
}

async function waitForTerminal(
  options: ApiCancellationOptions,
  jobId: string,
  deadlineMonotonic: number,
): Promise<CancellationJobRecord | null> {
  const clock = options.clock ?? defaultClock;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  while (true) {
    const current = readCancellationJob(options.store, jobId);
    if (isTerminal(current) || current.state === 'publishing') return current;
    const remaining = deadlineMonotonic - clock.monotonicNow();
    if (remaining <= 0) return null;
    await clock.sleep(Math.min(pollIntervalMs, remaining));
  }
}

export async function requestCancellation(
  options: ApiCancellationOptions,
  request: ApiCancellationRequest,
): Promise<ApiCancellationResult> {
  const clock = options.clock ?? defaultClock;
  const cooperativeTimeoutMs = options.cooperativeTimeoutMs ?? DEFAULT_COOPERATIVE_TIMEOUT_MS;
  const systemdGraceMs = options.systemdGraceMs ?? DEFAULT_SYSTEMD_GRACE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  assertNonNegativeInteger(cooperativeTimeoutMs, 'cooperative cancellation timeout');
  assertNonNegativeInteger(systemdGraceMs, 'systemd grace timeout');
  assertNonNegativeInteger(pollIntervalMs, 'cancellation poll interval');
  if (pollIntervalMs === 0) throw new TypeError('cancellation poll interval must be greater than zero');
  const coordinatorId = options.coordinatorId ?? `api-cancellation-${randomUUID()}`;
  if (coordinatorId.length === 0 || coordinatorId.length > 128) throw new TypeError('cancellation coordinator id is invalid');
  const requestedCooperativeDeadlineAt = addMilliseconds(request.at, cooperativeTimeoutMs);

  let job = readCancellationJob(options.store, request.jobId);
  if (isTerminal(job)) return outcomeForTerminal(request.jobId, job, false);

  if (job.state === 'queued') {
    if (job.cancelRequestedAt === null) writeRequest(options, request, false, requestedCooperativeDeadlineAt);
    const queued = readCancellationJob(options.store, request.jobId);
    if (queued.state === 'cancelled') return { kind: 'queued-cancelled', jobId: request.jobId, state: 'cancelled', requestPersisted: true };
    if (isTerminal(queued)) return outcomeForTerminal(request.jobId, queued, true);
    return { kind: 'request-not-accepted', jobId: request.jobId, state: queued.state, evidence: { kind: 'queued-cancellation-not-committed', requestedAt: request.at } };
  }

  if (job.state === 'publishing') {
    if (job.cancelRequestedAt === null) writeRequest(options, request, true, requestedCooperativeDeadlineAt);
    job = readCancellationJob(options.store, request.jobId);
    if (job.state === 'publishing' && job.cancelRequestedAt !== null) return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
    if (isTerminal(job)) return outcomeForTerminal(request.jobId, job, true);
    return { kind: 'request-not-accepted', jobId: request.jobId, state: job.state, evidence: { kind: 'publishing-cancellation-not-committed', requestedAt: request.at } };
  }

  if (!ACTIVE_STATES.has(job.state)) return { kind: 'request-not-accepted', jobId: request.jobId, state: job.state, evidence: { kind: 'unsupported-cancellation-state', requestedAt: request.at } };

  let requestPersisted = job.cancelRequestedAt !== null;
  if (!requestPersisted) {
    writeRequest(options, request, false, requestedCooperativeDeadlineAt);
    job = readCancellationJob(options.store, request.jobId);
    requestPersisted = job.cancelRequestedAt !== null;
  }
  if (!requestPersisted || job.cancelRequestedAt === null) return failedClosed(options, job, false, request.at, 'cancellation request transaction was not observed durably');
  if (isTerminal(job)) return outcomeForTerminal(request.jobId, job, true);
  if (job.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
  if (!ACTIVE_STATES.has(job.state)) return failedClosed(options, job, true, request.at, 'job changed to an unsupported state after request persistence');
  if (job.cleanupBlockerCode === 'RUNNER_DISAPPEARED' && job.cleanupBlocker !== null) {
    return { kind: 'recovery-blocked', jobId: job.jobId, state: job.state as ActiveRecoveryState, blockerCode: 'RUNNER_DISAPPEARED', requestPersisted: true, evidence: job.cleanupBlocker };
  }
  if (job.cancellationCooperativeDeadlineAt === null) {
    const cancelRequestedAt = job.cancelRequestedAt;
    const cooperativeDeadlineAt = addMilliseconds(cancelRequestedAt, cooperativeTimeoutMs);
    try {
      options.ownership.apiWrite({
        kind: 'initialize-cancellation-coordination',
        jobId: job.jobId,
        expectedState: job.state as ActiveRecoveryState,
        cancelRequestedAt,
        cooperativeDeadlineAt,
        at: currentAt(clock, cancelRequestedAt),
      });
    } catch {
      // The re-read below resolves a concurrent initializer or a state race.
    }
    job = readCancellationJob(options.store, request.jobId);
  }
  if (isTerminal(job)) return outcomeForTerminal(request.jobId, job, true);
  if (job.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
  if (!ACTIVE_STATES.has(job.state)) return failedClosed(options, job, true, request.at, 'job changed while cancellation coordination was initialized');
  if (job.cancelRequestedAt === null) return failedClosed(options, job, false, request.at, 'durable cancellation request disappeared');
  if (job.cancellationCooperativeDeadlineAt === null) return failedClosed(options, job, true, request.at, 'durable cooperative cancellation deadline is missing');
  if (!validateRunnerUnit(request.jobId, job.runnerUnit)) return failedClosed(options, job, true, request.at, 'persisted runner unit is missing or mismatched');
  if (!hasLiveRunnerLease(job, currentAt(clock, request.at))) return failedClosed(options, job, true, request.at, 'persisted runner lease is missing or stale');
  const cancellationLeaseOwner = job.runnerLeaseOwner;
  const cancellationLeaseExpiresAt = job.runnerLeaseExpiresAt;
  const cancellationRequestedAt = job.cancelRequestedAt;
  const cancellationRunnerUnit = job.runnerUnit;
  const cooperativeDeadlineAt = job.cancellationCooperativeDeadlineAt;

  // Convert the durable wall-clock remainder once. All cooperative operations
  // share this monotonic deadline, and retries cannot create a new budget.
  const cooperativeDeadlineMonotonic = monotonicDeadline(clock, cooperativeDeadlineAt);
  let signalObservation: ApiCancellationSystemdObservation;
  try {
    signalObservation = await options.systemd.signalCancellation(cancellationRunnerUnit, cooperativeDeadlineMonotonic);
  } catch (error) {
    signalObservation = failedSystemdObservation('signal', cancellationRunnerUnit, error);
  }
  try {
    options.ownership.apiWrite({
      kind: 'record-cancellation-signal',
      jobId: job.jobId,
      expectedState: job.state as ActiveRecoveryState,
      cancelRequestedAt: cancellationRequestedAt,
      runnerUnit: cancellationRunnerUnit,
      observedOwner: cancellationLeaseOwner,
      observedLeaseExpiresAt: cancellationLeaseExpiresAt,
      observation: publicObservation(signalObservation),
      at: currentAt(clock, cancellationRequestedAt),
    });
  } catch {
    // A terminal/publishing race is resolved by the authoritative read below.
  }

  let terminal = readCancellationJob(options.store, request.jobId);
  if (isTerminal(terminal)) return outcomeForTerminal(request.jobId, terminal, true);
  if (terminal.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
  const cooperative = await waitForTerminal({ ...options, pollIntervalMs }, request.jobId, cooperativeDeadlineMonotonic);
  if (cooperative !== null) {
    if (isTerminal(cooperative)) return outcomeForTerminal(request.jobId, cooperative, true);
    if (cooperative.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
  }

  terminal = readCancellationJob(options.store, request.jobId);
  if (isTerminal(terminal)) return outcomeForTerminal(request.jobId, terminal, true);
  if (terminal.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
  if (
    !ACTIVE_STATES.has(terminal.state)
    || !validateRunnerUnit(request.jobId, terminal.runnerUnit)
    || terminal.runnerLeaseOwner !== cancellationLeaseOwner
    || terminal.runnerLeaseExpiresAt !== cancellationLeaseExpiresAt
  ) return failedClosed(options, terminal, true, request.at, 'runner lease identity changed before systemd escalation');

  const freshEscalationAt = currentAt(clock, request.at);
  if (!hasLiveRunnerLease(terminal, freshEscalationAt)) {
    return failedClosed(options, terminal, true, request.at, 'runner lease expired before systemd escalation');
  }
  let ownsStop = false;
  if (terminal.cancellationStopIntentAt === null) {
    const graceDeadlineAt = addMilliseconds(freshEscalationAt, systemdGraceMs);
    try {
      const claim = options.ownership.apiWrite({
        kind: 'claim-cancellation-escalation',
        jobId: terminal.jobId,
        expectedState: terminal.state as ActiveRecoveryState,
        cancelRequestedAt: terminal.cancelRequestedAt!,
        cooperativeDeadlineAt,
        runnerUnit: terminal.runnerUnit!,
        observedOwner: terminal.runnerLeaseOwner!,
        observedLeaseExpiresAt: terminal.runnerLeaseExpiresAt!,
        escalationOwner: coordinatorId,
        escalationLeaseExpiresAt: graceDeadlineAt,
        stopIntentAt: freshEscalationAt,
        graceDeadlineAt,
        at: freshEscalationAt,
      });
      ownsStop = claim.ok && claim.kind === 'committed';
    } catch {
      ownsStop = false;
    }
    terminal = readCancellationJob(options.store, request.jobId);
  }
  if (isTerminal(terminal)) return outcomeForTerminal(request.jobId, terminal, true);
  if (terminal.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
  if (!ACTIVE_STATES.has(terminal.state)) return failedClosed(options, terminal, true, request.at, 'runner state changed before systemd escalation claim');
  if (
    !validateRunnerUnit(request.jobId, terminal.runnerUnit)
    || terminal.runnerLeaseOwner !== cancellationLeaseOwner
    || terminal.runnerLeaseExpiresAt !== cancellationLeaseExpiresAt
    || terminal.cancellationStopIntentAt === null
    || terminal.cancellationGraceDeadlineAt === null
  ) return failedClosed(options, terminal, true, request.at, 'systemd escalation identity or durable stop intent is invalid');

  const escalationUnit = terminal.runnerUnit;
  const stopIntentAt = terminal.cancellationStopIntentAt;
  const graceDeadlineAt = terminal.cancellationGraceDeadlineAt;
  if (ownsStop) {
    const stopDeadlineMonotonic = monotonicDeadline(clock, graceDeadlineAt);
    let stopObservation: ApiCancellationSystemdObservation;
    try {
      stopObservation = await options.systemd.stopRunner(escalationUnit, stopDeadlineMonotonic);
    } catch (error) {
      stopObservation = failedSystemdObservation('stop', escalationUnit, error);
    }
    try {
      options.ownership.apiWrite({
        kind: 'record-cancellation-stop',
        jobId: terminal.jobId,
        expectedState: terminal.state as ActiveRecoveryState,
        cancelRequestedAt: terminal.cancelRequestedAt!,
        runnerUnit: escalationUnit,
        observedOwner: terminal.runnerLeaseOwner!,
        observedLeaseExpiresAt: terminal.runnerLeaseExpiresAt!,
        escalationOwner: coordinatorId,
        stopIntentAt,
        observation: publicObservation(stopObservation),
        at: currentAt(clock, stopIntentAt),
      });
    } catch {
      // A crash/race after intent is reconciled from the durable intent below.
    }
  }
  terminal = readCancellationJob(options.store, request.jobId);
  if (isTerminal(terminal)) return outcomeForTerminal(request.jobId, terminal, true);
  if (terminal.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };

  const graceDeadlineMonotonic = monotonicDeadline(clock, graceDeadlineAt);
  let inspected = false;
  while (!inspected || clock.monotonicNow() < graceDeadlineMonotonic) {
    const observed = readCancellationJob(options.store, request.jobId);
    if (isTerminal(observed)) return outcomeForTerminal(request.jobId, observed, true);
    if (observed.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
    try {
      const inspection = await options.systemd.inspectRunner(escalationUnit, graceDeadlineMonotonic);
      try {
        options.ownership.apiWrite({
          kind: 'record-cancellation-inspection',
          jobId: observed.jobId,
          expectedState: observed.state as ActiveRecoveryState,
          cancelRequestedAt: observed.cancelRequestedAt!,
          runnerUnit: escalationUnit,
          observedOwner: observed.runnerLeaseOwner!,
          observedLeaseExpiresAt: observed.runnerLeaseExpiresAt!,
          stopIntentAt,
          observation: publicObservation(inspection),
          at: currentAt(clock, stopIntentAt),
        });
      } catch {
        // Terminal and identity races are handled by the following re-read.
      }
    } catch (error) {
      const inspection = failedSystemdObservation('inspect', escalationUnit, error);
      try {
        options.ownership.apiWrite({
          kind: 'record-cancellation-inspection',
          jobId: observed.jobId,
          expectedState: observed.state as ActiveRecoveryState,
          cancelRequestedAt: observed.cancelRequestedAt!,
          runnerUnit: escalationUnit,
          observedOwner: observed.runnerLeaseOwner!,
          observedLeaseExpiresAt: observed.runnerLeaseExpiresAt!,
          stopIntentAt,
          observation: publicObservation(inspection),
          at: currentAt(clock, stopIntentAt),
        });
      } catch {
        // Terminal and identity races are handled by the following re-read.
      }
    }
    inspected = true;
    const afterInspect = readCancellationJob(options.store, request.jobId);
    if (isTerminal(afterInspect)) return outcomeForTerminal(request.jobId, afterInspect, true);
    if (afterInspect.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
    const remaining = graceDeadlineMonotonic - clock.monotonicNow();
    if (remaining <= 0) break;
    await clock.sleep(Math.min(pollIntervalMs, remaining));
  }

  terminal = readCancellationJob(options.store, request.jobId);
  if (isTerminal(terminal)) return outcomeForTerminal(request.jobId, terminal, true);
  if (terminal.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
  if (!ACTIVE_STATES.has(terminal.state)) return failedClosed(options, terminal, true, request.at, 'runner state changed before recovery blocker persistence');
  return writeBlocker(
    options,
    terminal,
    request.at,
    cooperativeDeadlineAt,
    graceDeadlineAt,
    terminal.cancellationSignalObservation,
    terminal.cancellationStopObservation,
    terminal.cancellationInspectionObservations,
  );
}

export { validateRunnerUnit };
