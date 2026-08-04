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
const MAX_CLOCK_OBSERVATION_ATTEMPTS = 3;
const MAX_POST_CLAIM_ATTEMPTS = 3;
const MAX_STOP_AUTHORIZATION_ATTEMPTS = 3;
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
  readonly listPendingCancellations?: () => readonly CancellationJobRecord[];
}

export interface ApiCancellationOwnership {
  readonly apiWrite: (command: ApiWriteCommand) => OwnershipResult;
}

export interface ApiCancellationOptions {
  readonly store: ApiCancellationStore | Pick<BuilderStore, 'getJob' | 'getCancellationJob' | 'listPendingCancellations'>;
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
  | Readonly<{ readonly kind: 'coordination-pending'; readonly jobId: string; readonly state: ActiveRecoveryState; readonly requestPersisted: true; readonly cancellationClockHighWaterAt: string; readonly cooperativeDeadlineAt: string }>
  | Readonly<{ readonly kind: 'request-not-accepted'; readonly jobId: string; readonly state: JobState; readonly evidence: JsonObject }>;

export interface SystemdCancellationAdapterOptions {
  readonly commandExecutor: Pick<CommandExecutor, 'run'>;
  readonly env: Readonly<Record<string, string>>;
  readonly monotonicNow?: () => number;
  readonly maxCaptureBytes?: number;
}

export interface ApiCancellationService {
  readonly admitCancellation: (request: ApiCancellationRequest) => Promise<ApiCancellationResult>;
  readonly requestCancellation: (request: ApiCancellationRequest) => Promise<ApiCancellationResult>;
  readonly resumePending: () => Promise<ApiCancellationResumeReport>;
}

export interface ApiCancellationResumeReport {
  readonly examined: number;
  readonly resumed: number;
  readonly failures: readonly Readonly<{
    readonly jobId: string;
    readonly kind: 'coordinator-rejected' | 'coordination-pending' | 'recovery-blocked' | 'request-not-accepted';
  }>[];
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
  readonly schedule?: (work: () => void) => void;
  readonly reportError?: (error: unknown) => void;
}

export class CancellationCoordinationAuditError extends Error {
  readonly jobId: string;
  readonly phase: 'scheduler' | 'coordinator';

  constructor(jobId: string, phase: 'scheduler' | 'coordinator', cause: unknown) {
    super(`${phase} cancellation coordination audit persistence failed`, { cause });
    this.name = 'CancellationCoordinationAuditError';
    this.jobId = jobId;
    this.phase = phase;
  }
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
  const cancellationOptions: ApiCancellationOptions = {
    store: options.store,
    ownership: options.ownership,
    systemd,
    clock: options.clock,
    coordinatorId: options.coordinatorId,
  };
  const scheduled = new Set<string>();
  const inFlight = new Map<string, Promise<ApiCancellationResult>>();
  const schedule = options.schedule ?? ((work: () => void) => setImmediate(work));
  const reportError = options.reportError ?? ((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cancellation coordination failed: ${message.replace(/[\r\n\t]+/gu, ' ').slice(0, 512)}\n`);
  });
  const coordinate = (request: ApiCancellationRequest): Promise<ApiCancellationResult> => {
    const existing = inFlight.get(request.jobId);
    if (existing !== undefined) return existing;
    let work: Promise<ApiCancellationResult>;
    work = requestCancellation(cancellationOptions, request)
      .catch((error: unknown) => {
        recordCoordinationFailure(cancellationOptions, request, 'coordinator', reportError);
        throw error;
      })
      .finally(() => {
        if (inFlight.get(request.jobId) === work) inFlight.delete(request.jobId);
      });
    inFlight.set(request.jobId, work);
    return work;
  };
  return Object.freeze({
    async admitCancellation(request: ApiCancellationRequest): Promise<ApiCancellationResult> {
      const result = admitCancellation(cancellationOptions, request);
      if (result.kind === 'coordination-pending' && !scheduled.has(request.jobId)) {
        scheduled.add(request.jobId);
        try {
          schedule(() => {
            void coordinate(request)
              .catch(() => undefined)
              .finally(() => scheduled.delete(request.jobId));
          });
        } catch {
          try {
            recordCoordinationFailure(cancellationOptions, request, 'scheduler', reportError);
          } finally {
            scheduled.delete(request.jobId);
          }
        }
      }
      return result;
    },
    requestCancellation: coordinate,
    async resumePending(): Promise<ApiCancellationResumeReport> {
      if (options.store.listPendingCancellations === undefined) throw new TypeError('cancellation store cannot enumerate pending cancellations');
      const pending = options.store.listPendingCancellations();
      let resumed = 0;
      const failures: Array<ApiCancellationResumeReport['failures'][number]> = [];
      for (const job of pending) {
        if (job.cancelRequestedAt === null || job.cancelReason === null) {
          failures.push({ jobId: job.jobId, kind: 'coordinator-rejected' });
          continue;
        }
        try {
          const outcome = await coordinate({
            jobId: job.jobId,
            reason: job.cancelReason,
            at: currentAt(options.clock ?? defaultClock, job.cancelRequestedAt),
          });
          if (
            outcome.kind === 'coordination-pending'
            || outcome.kind === 'recovery-blocked'
            || outcome.kind === 'request-not-accepted'
          ) {
            failures.push({ jobId: job.jobId, kind: outcome.kind });
          } else {
            resumed += 1;
          }
        } catch {
          failures.push({ jobId: job.jobId, kind: 'coordinator-rejected' });
        }
      }
      return Object.freeze({ examined: pending.length, resumed, failures: Object.freeze(failures) });
    },
  });
}

function readCancellationJob(store: ApiCancellationOptions['store'], jobId: string): CancellationJobRecord {
  if (store.getCancellationJob !== undefined) return store.getCancellationJob(jobId);
  return (store as ApiCancellationStore).getJob(jobId);
}

function recordCoordinationFailure(
  options: ApiCancellationOptions,
  request: ApiCancellationRequest,
  phase: 'scheduler' | 'coordinator',
  reportError: (error: unknown) => void,
): void {
  try {
    const job = readCancellationJob(options.store, request.jobId);
    if (!ACTIVE_STATES.has(job.state) || job.cancelRequestedAt === null) return;
    const result = options.ownership.apiWrite({
      kind: 'record-cancellation-coordination-failure',
      jobId: job.jobId,
      expectedState: job.state as ActiveRecoveryState,
      cancelRequestedAt: job.cancelRequestedAt,
      phase,
      failure: { kind: phase === 'scheduler' ? 'scheduler-rejected' : 'coordinator-rejected' },
      at: currentAt(options.clock ?? defaultClock, job.cancelRequestedAt),
    });
    if (!result.ok) throw new Error('cancellation coordination audit ownership CAS failed');
  } catch (cause) {
    reportError(new CancellationCoordinationAuditError(request.jobId, phase, cause));
  }
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

function monotonicDeadline(clock: ApiCancellationClock, deadlineAt: string, observedAt: string): number {
  return clock.monotonicNow() + Math.max(0, Date.parse(deadlineAt) - Date.parse(observedAt));
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

function runnerIdentityIssue(
  jobId: string,
  job: CancellationJobRecord,
  expectedUnit: string,
  expectedOwner: string,
  minimumLeaseExpiresAt: string,
  observedAt: string,
): string | null {
  if (!validateRunnerUnit(jobId, job.runnerUnit) || job.runnerUnit !== expectedUnit) {
    return 'runner unit changed before systemd stop authorization';
  }
  if (job.runnerLeaseOwner !== expectedOwner) {
    return 'runner lease identity owner changed before systemd stop authorization';
  }
  if (job.runnerLeaseExpiresAt === null || !isCanonicalInstant(job.runnerLeaseExpiresAt)) {
    return 'runner lease expiry is malformed before systemd stop authorization';
  }
  if (job.runnerLeaseExpiresAt < minimumLeaseExpiresAt) {
    return 'runner lease expiry regressed before systemd stop authorization';
  }
  if (job.runnerLeaseExpiresAt <= observedAt) {
    return 'runner lease expired before systemd stop authorization';
  }
  return null;
}

function clockContentionIdentityIssue(
  jobId: string,
  job: CancellationJobRecord,
  expectedUnit: string | null,
  expectedOwner: string | null,
  minimumLeaseExpiresAt: string | null,
): string | null {
  if (
    expectedUnit === null
    || !validateRunnerUnit(jobId, expectedUnit)
    || job.runnerUnit !== expectedUnit
  ) return 'runner unit changed during cancellation clock contention';
  if (
    expectedOwner === null
    || expectedOwner.length === 0
    || job.runnerLeaseOwner !== expectedOwner
  ) return 'runner lease owner changed during cancellation clock contention';
  if (
    minimumLeaseExpiresAt === null
    || !isCanonicalInstant(minimumLeaseExpiresAt)
    || job.runnerLeaseExpiresAt === null
    || !isCanonicalInstant(job.runnerLeaseExpiresAt)
  ) return 'runner lease expiry is malformed during cancellation clock contention';
  if (job.runnerLeaseExpiresAt < minimumLeaseExpiresAt) {
    return 'runner lease expiry regressed during cancellation clock contention';
  }
  if (
    job.cancellationClockHighWaterAt === null
    || job.runnerLeaseExpiresAt <= job.cancellationClockHighWaterAt
  ) return 'runner lease expired during cancellation clock contention';
  return null;
}

function postClaimRereadIssue(
  jobId: string,
  observed: CancellationJobRecord,
  latest: CancellationJobRecord,
  requireLiveLease: boolean,
): string | null {
  if (!ACTIVE_STATES.has(latest.state) || latest.state !== observed.state) {
    return 'runner state changed after the cancellation escalation claim CAS';
  }
  if (latest.cancelRequestedAt !== observed.cancelRequestedAt) {
    return 'cancellation request identity changed after the cancellation escalation claim CAS';
  }
  if (latest.cancellationCooperativeDeadlineAt !== observed.cancellationCooperativeDeadlineAt) {
    return 'cooperative cancellation deadline changed after the cancellation escalation claim CAS';
  }
  if (
    !validateRunnerUnit(jobId, observed.runnerUnit)
    || !validateRunnerUnit(jobId, latest.runnerUnit)
    || latest.runnerUnit !== observed.runnerUnit
  ) return 'runner unit changed after the cancellation escalation claim CAS';
  if (
    observed.runnerLeaseOwner === null
    || observed.runnerLeaseOwner.length === 0
    || latest.runnerLeaseOwner !== observed.runnerLeaseOwner
  ) return 'runner lease owner changed after the cancellation escalation claim CAS';
  if (
    observed.runnerLeaseExpiresAt === null
    || !isCanonicalInstant(observed.runnerLeaseExpiresAt)
    || latest.runnerLeaseExpiresAt === null
    || !isCanonicalInstant(latest.runnerLeaseExpiresAt)
  ) return 'runner lease expiry is malformed after the cancellation escalation claim CAS';
  if (latest.runnerLeaseExpiresAt < observed.runnerLeaseExpiresAt) {
    return 'runner lease expiry regressed after the cancellation escalation claim CAS';
  }
  if (
    observed.cancellationClockHighWaterAt === null
    || !isCanonicalInstant(observed.cancellationClockHighWaterAt)
    || latest.cancellationClockHighWaterAt === null
    || !isCanonicalInstant(latest.cancellationClockHighWaterAt)
  ) return 'cancellation clock high-water is malformed after the cancellation escalation claim CAS';
  if (latest.cancellationClockHighWaterAt < observed.cancellationClockHighWaterAt) {
    return 'cancellation clock high-water regressed after the cancellation escalation claim CAS';
  }
  if (requireLiveLease && latest.runnerLeaseExpiresAt <= latest.cancellationClockHighWaterAt) {
    return 'runner lease is stale after the cancellation escalation claim CAS';
  }
  if (
    latest.cleanupBlockerCode !== null
    || latest.cleanupBlocker !== null
    || latest.cleanupFenceGeneration !== null
    || latest.cleanupAdmissionId !== null
  ) return 'cancellation escalation claim CAS reread is fenced for cleanup recovery';
  return null;
}

function postClaimNoIntentIssue(job: CancellationJobRecord): string | null {
  if (job.cancellationStopIntentAt !== null) return 'durable cancellation stop intent appeared during claim classification';
  if (
    job.cancellationEscalationOwner !== null
    || job.cancellationEscalationLeaseExpiresAt !== null
    || job.cancellationGraceDeadlineAt !== null
    || job.cancellationStopAuthorizedAt !== null
    || job.cancellationStopAuthorizedLeaseExpiresAt !== null
    || job.cancellationStopObservation !== null
    || job.cancellationInspectionObservations !== null
  ) return 'cancellation escalation identity changed without a durable stop intent';
  return null;
}

function coordinationPending(job: CancellationJobRecord): ApiCancellationResult {
  if (
    job.cancellationClockHighWaterAt === null
    || job.cancellationCooperativeDeadlineAt === null
  ) throw new TypeError('healthy cancellation contention is missing durable coordination fields');
  return {
    kind: 'coordination-pending',
    jobId: job.jobId,
    state: job.state as ActiveRecoveryState,
    requestPersisted: true,
    cancellationClockHighWaterAt: job.cancellationClockHighWaterAt,
    cooperativeDeadlineAt: job.cancellationCooperativeDeadlineAt,
  };
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

type CancellationEscalationFence = Readonly<{
  escalationOwner: string;
  escalationLeaseExpiresAt: string;
  stopIntentAt: string;
}>;

function matchesEscalationFence(job: CancellationJobRecord, fence: CancellationEscalationFence): boolean {
  return job.cancellationEscalationOwner === fence.escalationOwner
    && job.cancellationEscalationLeaseExpiresAt === fence.escalationLeaseExpiresAt
    && job.cancellationStopIntentAt === fence.stopIntentAt;
}

function escalationContention(job: CancellationJobRecord, evidence: JsonObject): ApiCancellationResult {
  if (
    ACTIVE_STATES.has(job.state)
    && job.cancelRequestedAt !== null
    && job.cancellationClockHighWaterAt !== null
    && job.cancellationCooperativeDeadlineAt !== null
  ) return coordinationPending(job);
  return { kind: 'request-not-accepted', jobId: job.jobId, state: job.state, evidence };
}

function durableBlocker(
  options: ApiCancellationOptions,
  job: CancellationJobRecord,
  requestPersisted: boolean,
  requestedAt: string,
  evidence: JsonObject,
  escalationFence?: CancellationEscalationFence,
): ApiCancellationResult {
  let observed = job;
  const expectedState = job.state;
  const expectedCancelRequestedAt = job.cancelRequestedAt;
  const expectedRunnerUnit = job.runnerUnit;
  const expectedRunnerOwner = job.runnerLeaseOwner;
  let minimumLeaseExpiresAt = job.runnerLeaseExpiresAt;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!ACTIVE_STATES.has(observed.state) || observed.cancelRequestedAt === null) {
      if (isTerminal(observed)) return outcomeForTerminal(job.jobId, observed, requestPersisted);
      return { kind: 'request-not-accepted', jobId: observed.jobId, state: observed.state, evidence };
    }
    if (escalationFence !== undefined && !matchesEscalationFence(observed, escalationFence)) {
      return escalationContention(observed, evidence);
    }
    if (observed.cleanupBlockerCode === 'RUNNER_DISAPPEARED' && observed.cleanupBlocker !== null) {
      return { kind: 'recovery-blocked', jobId: observed.jobId, state: observed.state as ActiveRecoveryState, blockerCode: 'RUNNER_DISAPPEARED', requestPersisted, evidence: observed.cleanupBlocker };
    }
    const minimum = observed.cancellationClockHighWaterAt !== null
      && observed.cancellationClockHighWaterAt > observed.cancelRequestedAt
      ? observed.cancellationClockHighWaterAt
      : observed.cancelRequestedAt;
    const at = currentAt(options.clock ?? defaultClock, minimum);
    try {
      options.ownership.apiWrite({
        kind: 'cancellation-recovery-blocker',
        jobId: observed.jobId,
        expectedState: observed.state as ActiveRecoveryState,
        cancelRequestedAt: observed.cancelRequestedAt,
        observedRunnerUnit: observed.runnerUnit,
        observedOwner: observed.runnerLeaseOwner,
        observedLeaseExpiresAt: observed.runnerLeaseExpiresAt,
        expectedEscalationOwner: escalationFence?.escalationOwner,
        expectedEscalationLeaseExpiresAt: escalationFence?.escalationLeaseExpiresAt,
        expectedStopIntentAt: escalationFence?.stopIntentAt,
        blocker: evidence,
        at,
      });
    } catch {
      // The durable re-read below is authoritative for conflicts and faults.
    }
    const latest = readCancellationJob(options.store, job.jobId);
    if (isTerminal(latest)) return outcomeForTerminal(job.jobId, latest, requestPersisted);
    if (escalationFence !== undefined && !matchesEscalationFence(latest, escalationFence)) {
      return escalationContention(latest, evidence);
    }
    if (latest.cleanupBlockerCode === 'RUNNER_DISAPPEARED' && latest.cleanupBlocker !== null) {
      return { kind: 'recovery-blocked', jobId: latest.jobId, state: latest.state as ActiveRecoveryState, blockerCode: 'RUNNER_DISAPPEARED', requestPersisted, evidence: latest.cleanupBlocker };
    }
    const retryMinimum = latest.cancellationClockHighWaterAt !== null
      && expectedCancelRequestedAt !== null
      && latest.cancellationClockHighWaterAt > expectedCancelRequestedAt
      ? latest.cancellationClockHighWaterAt
      : expectedCancelRequestedAt;
    if (
      latest.state !== expectedState
      || latest.cancelRequestedAt !== expectedCancelRequestedAt
      || latest.runnerUnit !== expectedRunnerUnit
      || latest.runnerLeaseOwner !== expectedRunnerOwner
      || (escalationFence !== undefined && (
        latest.cancellationEscalationOwner !== escalationFence.escalationOwner
        || latest.cancellationEscalationLeaseExpiresAt !== escalationFence.escalationLeaseExpiresAt
        || latest.cancellationStopIntentAt !== escalationFence.stopIntentAt
      ))
      || latest.cleanupFenceGeneration !== null
      || latest.cleanupAdmissionId !== null
      || minimumLeaseExpiresAt === null
      || !isCanonicalInstant(minimumLeaseExpiresAt)
      || latest.runnerLeaseExpiresAt === null
      || !isCanonicalInstant(latest.runnerLeaseExpiresAt)
      || latest.runnerLeaseExpiresAt < minimumLeaseExpiresAt
      || retryMinimum === null
      || latest.runnerLeaseExpiresAt <= retryMinimum
    ) {
      return { kind: 'request-not-accepted', jobId: latest.jobId, state: latest.state, evidence };
    }
    minimumLeaseExpiresAt = latest.runnerLeaseExpiresAt;
    observed = latest;
  }
  return {
    kind: 'request-not-accepted',
    jobId: observed.jobId,
    state: observed.state,
    evidence: {
      kind: 'cancellation-recovery-blocker-not-committed',
      requestedAt,
      attempted: evidence,
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
  escalationFence?: CancellationEscalationFence,
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
  }, escalationFence);
}

type ClockBoundary =
  | Readonly<{ readonly kind: 'observed'; readonly job: CancellationJobRecord; readonly observedAt: string }>
  | Readonly<{ readonly kind: 'outcome'; readonly outcome: ApiCancellationResult }>;

function clockRegression(
  options: ApiCancellationOptions,
  job: CancellationJobRecord,
  requestPersisted: boolean,
  requestedAt: string,
  observedAt: string,
  highWaterAt: string,
  phase: string,
  escalationFence?: CancellationEscalationFence,
): ClockBoundary {
  return {
    kind: 'outcome',
    outcome: durableBlocker(options, job, requestPersisted, requestedAt, {
      kind: 'api-cancellation-clock-regression',
      reason: 'wall clock regressed below the durable cancellation coordination high-water',
      phase,
      requestedAt,
      observedAt,
      highWaterAt,
      state: job.state,
      persistedRunnerUnit: job.runnerUnit,
      observedOwner: job.runnerLeaseOwner,
      observedLeaseExpiresAt: job.runnerLeaseExpiresAt,
    }, escalationFence),
  };
}

function observeCancellationClock(
  options: ApiCancellationOptions,
  job: CancellationJobRecord,
  requestPersisted: boolean,
  requestedAt: string,
  phase: string,
  escalationFence?: CancellationEscalationFence,
): ClockBoundary {
  let current = job;
  const contentionRunnerUnit = job.runnerUnit;
  const contentionRunnerOwner = job.runnerLeaseOwner;
  let contentionMinimumLeaseExpiresAt = job.runnerLeaseExpiresAt;
  for (let attempt = 0; attempt < MAX_CLOCK_OBSERVATION_ATTEMPTS; attempt += 1) {
    if (isTerminal(current)) {
      return { kind: 'outcome', outcome: outcomeForTerminal(current.jobId, current, requestPersisted) };
    }
    if (current.state === 'publishing') {
      return {
        kind: 'outcome',
        outcome: { kind: 'late-publishing', jobId: current.jobId, state: 'publishing', late: true, requestPersisted: true },
      };
    }
    if (escalationFence !== undefined && !matchesEscalationFence(current, escalationFence)) {
      return { kind: 'outcome', outcome: escalationContention(current, { kind: 'cancellation-escalation-contention', phase }) };
    }
    if (current.cleanupBlockerCode === 'RUNNER_DISAPPEARED' && current.cleanupBlocker !== null) {
      return {
        kind: 'outcome',
        outcome: {
          kind: 'recovery-blocked',
          jobId: current.jobId,
          state: current.state as ActiveRecoveryState,
          blockerCode: 'RUNNER_DISAPPEARED',
          requestPersisted,
          evidence: current.cleanupBlocker,
        },
      };
    }
    if (
      !ACTIVE_STATES.has(current.state)
      || current.cancelRequestedAt === null
      || current.cancellationClockHighWaterAt === null
      || !isCanonicalInstant(current.cancellationClockHighWaterAt)
    ) {
      return {
        kind: 'outcome',
        outcome: failedClosed(options, current, requestPersisted, requestedAt, 'durable cancellation clock high-water is missing or invalid', escalationFence),
      };
    }
    if (current.cleanupFenceGeneration !== null || current.cleanupAdmissionId !== null) {
      return {
        kind: 'outcome',
        outcome: failedClosed(options, current, requestPersisted, requestedAt, 'cancellation clock observation is fenced for cleanup recovery', escalationFence),
      };
    }

    const observedAt = (options.clock ?? defaultClock).now();
    if (!isCanonicalInstant(observedAt)) {
      return {
        kind: 'outcome',
        outcome: durableBlocker(options, current, requestPersisted, requestedAt, {
          kind: 'api-cancellation-clock-regression',
          reason: 'wall clock observation is not a canonical UTC instant',
          phase,
          requestedAt,
          observedAt,
          highWaterAt: current.cancellationClockHighWaterAt,
        }, escalationFence),
      };
    }
    if (observedAt < current.cancellationClockHighWaterAt) {
      return clockRegression(
        options,
        current,
        requestPersisted,
        requestedAt,
        observedAt,
        current.cancellationClockHighWaterAt,
        phase,
        escalationFence,
      );
    }

    const expectedState = current.state;
    const cancelRequestedAt = current.cancelRequestedAt;
    try {
      options.ownership.apiWrite({
        kind: 'observe-cancellation-clock',
        jobId: current.jobId,
        expectedState: expectedState as ActiveRecoveryState,
        cancelRequestedAt,
        expectedHighWaterAt: current.cancellationClockHighWaterAt,
        expectedEscalationOwner: escalationFence?.escalationOwner,
        expectedEscalationLeaseExpiresAt: escalationFence?.escalationLeaseExpiresAt,
        expectedStopIntentAt: escalationFence?.stopIntentAt,
        observedAt,
        at: observedAt,
      });
    } catch {
      // The durable re-read below distinguishes a concurrent advance from a state race.
    }
    const latest = readCancellationJob(options.store, current.jobId);
    if (isTerminal(latest)) {
      return { kind: 'outcome', outcome: outcomeForTerminal(current.jobId, latest, requestPersisted) };
    }
    if (latest.state === 'publishing') {
      return {
        kind: 'outcome',
        outcome: { kind: 'late-publishing', jobId: latest.jobId, state: 'publishing', late: true, requestPersisted: true },
      };
    }
    if (escalationFence !== undefined && !matchesEscalationFence(latest, escalationFence)) {
      return { kind: 'outcome', outcome: escalationContention(latest, { kind: 'cancellation-escalation-contention', phase }) };
    }
    if (latest.cleanupBlockerCode === 'RUNNER_DISAPPEARED' && latest.cleanupBlocker !== null) {
      return {
        kind: 'outcome',
        outcome: {
          kind: 'recovery-blocked',
          jobId: latest.jobId,
          state: latest.state as ActiveRecoveryState,
          blockerCode: 'RUNNER_DISAPPEARED',
          requestPersisted,
          evidence: latest.cleanupBlocker,
        },
      };
    }
    if (
      !ACTIVE_STATES.has(latest.state)
      || latest.state !== expectedState
      || latest.cancelRequestedAt !== cancelRequestedAt
      || latest.cancellationClockHighWaterAt === null
      || !isCanonicalInstant(latest.cancellationClockHighWaterAt)
      || latest.cleanupFenceGeneration !== null
      || latest.cleanupAdmissionId !== null
    ) {
      return {
        kind: 'outcome',
        outcome: failedClosed(options, latest, requestPersisted, requestedAt, 'cancellation clock observation lost durable state ownership', escalationFence),
      };
    }
    if (latest.cancellationClockHighWaterAt === observedAt) {
      return { kind: 'observed', job: latest, observedAt };
    }
    if (latest.cancellationClockHighWaterAt > observedAt) {
      const identityIssue = clockContentionIdentityIssue(
        latest.jobId,
        latest,
        contentionRunnerUnit,
        contentionRunnerOwner,
        contentionMinimumLeaseExpiresAt,
      );
      if (identityIssue !== null) {
        return {
          kind: 'outcome',
          outcome: failedClosed(options, latest, requestPersisted, requestedAt, identityIssue, escalationFence),
        };
      }
      contentionMinimumLeaseExpiresAt = latest.runnerLeaseExpiresAt;
      current = latest;
      continue;
    }
    return {
      kind: 'outcome',
      outcome: failedClosed(options, latest, requestPersisted, requestedAt, 'cancellation clock high-water did not advance durably', escalationFence),
    };
  }
  return {
    kind: 'outcome',
    outcome: {
      kind: 'coordination-pending',
      jobId: current.jobId,
      state: current.state as ActiveRecoveryState,
      requestPersisted: true,
      cancellationClockHighWaterAt: current.cancellationClockHighWaterAt!,
      cooperativeDeadlineAt: current.cancellationCooperativeDeadlineAt!,
    },
  };
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
  escalationFence: CancellationEscalationFence,
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
  return durableBlocker(options, job, true, requestedAt, evidence, escalationFence);
}

export function admitCancellation(
  options: ApiCancellationOptions,
  request: ApiCancellationRequest,
): ApiCancellationResult {
  const clock = options.clock ?? defaultClock;
  const cooperativeTimeoutMs = options.cooperativeTimeoutMs ?? DEFAULT_COOPERATIVE_TIMEOUT_MS;
  assertNonNegativeInteger(cooperativeTimeoutMs, 'cooperative cancellation timeout');
  const requestedCooperativeDeadlineAt = addMilliseconds(request.at, cooperativeTimeoutMs);

  let job = readCancellationJob(options.store, request.jobId);
  if (isTerminal(job)) return outcomeForTerminal(request.jobId, job, false);

  if (job.state === 'queued') {
    if (job.cancelRequestedAt === null) writeRequest(options, request, false, requestedCooperativeDeadlineAt);
    const queued = readCancellationJob(options.store, request.jobId);
    if (queued.state === 'cancelled') return { kind: 'queued-cancelled', jobId: request.jobId, state: 'cancelled', requestPersisted: true };
    if (isTerminal(queued)) return outcomeForTerminal(request.jobId, queued, true);
    if (queued.state === 'publishing' && queued.cancelRequestedAt !== null) {
      return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
    }
    if (!ACTIVE_STATES.has(queued.state) || queued.cancelRequestedAt === null) {
      return { kind: 'request-not-accepted', jobId: request.jobId, state: queued.state, evidence: { kind: 'queued-cancellation-not-committed', requestedAt: request.at } };
    }
    job = queued;
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
  if (job.cancellationCooperativeDeadlineAt === null || job.cancellationClockHighWaterAt === null) {
    return failedClosed(options, job, true, request.at, 'durable cancellation coordination state is incomplete');
  }
  return {
    kind: 'coordination-pending',
    jobId: job.jobId,
    state: job.state as ActiveRecoveryState,
    requestPersisted: true,
    cancellationClockHighWaterAt: job.cancellationClockHighWaterAt,
    cooperativeDeadlineAt: job.cancellationCooperativeDeadlineAt,
  };
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
  const admission = admitCancellation(options, request);
  if (admission.kind !== 'coordination-pending') return admission;
  let job = readCancellationJob(options.store, request.jobId);
  if (job.cancelRequestedAt === null || job.cancellationCooperativeDeadlineAt === null) {
    return failedClosed(options, job, true, request.at, 'durable cancellation coordination state is incomplete');
  }
  const initialClock = observeCancellationClock(options, job, true, request.at, 'cooperative-deadline-conversion');
  if (initialClock.kind === 'outcome') return initialClock.outcome;
  job = initialClock.job;
  if (!validateRunnerUnit(request.jobId, job.runnerUnit)) return failedClosed(options, job, true, request.at, 'persisted runner unit is missing or mismatched');
  if (!hasLiveRunnerLease(job, initialClock.observedAt)) return failedClosed(options, job, true, request.at, 'persisted runner lease is missing or stale');
  const cancellationLeaseOwner = job.runnerLeaseOwner;
  const cancellationLeaseExpiresAt = job.runnerLeaseExpiresAt;
  const cancellationRequestedAt = job.cancelRequestedAt!;
  const cancellationRunnerUnit = job.runnerUnit;
  const cooperativeDeadlineAt = job.cancellationCooperativeDeadlineAt!;

  // Convert the durable wall-clock remainder once. All cooperative operations
  // share this monotonic deadline, and retries cannot create a new budget.
  const cooperativeDeadlineMonotonic = monotonicDeadline(clock, cooperativeDeadlineAt, initialClock.observedAt);
  let signalObservation: ApiCancellationSystemdObservation;
  try {
    signalObservation = await options.systemd.signalCancellation(cancellationRunnerUnit, cooperativeDeadlineMonotonic);
  } catch (error) {
    signalObservation = failedSystemdObservation('signal', cancellationRunnerUnit, error);
  }
  let terminal = readCancellationJob(options.store, request.jobId);
  if (isTerminal(terminal)) return outcomeForTerminal(request.jobId, terminal, true);
  if (terminal.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
  const afterSignalClock = observeCancellationClock(options, terminal, true, request.at, 'after-runner-signal');
  if (afterSignalClock.kind === 'outcome') return afterSignalClock.outcome;
  terminal = afterSignalClock.job;
  const signalIdentityIssue = runnerIdentityIssue(
    request.jobId,
    terminal,
    cancellationRunnerUnit,
    cancellationLeaseOwner,
    cancellationLeaseExpiresAt,
    afterSignalClock.observedAt,
  );
  if (signalIdentityIssue !== null) {
    return failedClosed(options, terminal, true, request.at, signalIdentityIssue.replace('systemd stop authorization', 'runner signal observation'));
  }
  try {
    options.ownership.apiWrite({
      kind: 'record-cancellation-signal',
      jobId: terminal.jobId,
      expectedState: terminal.state as ActiveRecoveryState,
      cancelRequestedAt: cancellationRequestedAt,
      runnerUnit: cancellationRunnerUnit,
      observedOwner: terminal.runnerLeaseOwner!,
      observedLeaseExpiresAt: terminal.runnerLeaseExpiresAt!,
      observation: publicObservation(signalObservation),
      at: afterSignalClock.observedAt,
    });
  } catch {
    // A terminal, publishing, or lease-renewal race is resolved by later reads.
  }

  while (clock.monotonicNow() < cooperativeDeadlineMonotonic) {
    const remaining = cooperativeDeadlineMonotonic - clock.monotonicNow();
    await clock.sleep(Math.min(pollIntervalMs, remaining));
    terminal = readCancellationJob(options.store, request.jobId);
    if (isTerminal(terminal)) return outcomeForTerminal(request.jobId, terminal, true);
    if (terminal.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
    const cooperativeClock = observeCancellationClock(options, terminal, true, request.at, 'cooperative-wait');
    if (cooperativeClock.kind === 'outcome') return cooperativeClock.outcome;
    terminal = cooperativeClock.job;
  }

  let ownsStop = false;
  let claimLeaseExpiresAt!: string;
  let freshEscalationAt: string;
  let escalationFence: CancellationEscalationFence | undefined;
  for (let postClaimAttempt = 0; postClaimAttempt < MAX_POST_CLAIM_ATTEMPTS; postClaimAttempt += 1) {
    terminal = readCancellationJob(options.store, request.jobId);
    if (isTerminal(terminal)) return outcomeForTerminal(request.jobId, terminal, true);
    if (terminal.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
    const preClaimClock = observeCancellationClock(options, terminal, true, request.at, 'pre-escalation-claim');
    if (preClaimClock.kind === 'outcome') return preClaimClock.outcome;
    terminal = preClaimClock.job;
    if (!ACTIVE_STATES.has(terminal.state)) return failedClosed(options, terminal, true, request.at, 'runner state changed before systemd escalation');
    const preClaimObserved = terminal;
    const preClaimIdentityIssue = runnerIdentityIssue(
      request.jobId,
      terminal,
      cancellationRunnerUnit,
      cancellationLeaseOwner,
      cancellationLeaseExpiresAt,
      preClaimClock.observedAt,
    );
    if (preClaimIdentityIssue !== null) {
      return failedClosed(
        options,
        terminal,
        true,
        request.at,
        preClaimIdentityIssue.replace('systemd stop authorization', 'systemd escalation'),
      );
    }

    freshEscalationAt = preClaimClock.observedAt;
    claimLeaseExpiresAt = terminal.runnerLeaseExpiresAt!;
    ownsStop = false;
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
        if (ownsStop) {
          escalationFence = {
            escalationOwner: coordinatorId,
            escalationLeaseExpiresAt: graceDeadlineAt,
            stopIntentAt: freshEscalationAt,
          };
        }
      } catch {
        ownsStop = false;
      }
      terminal = readCancellationJob(options.store, request.jobId);
      if (!ownsStop && terminal.cancellationStopIntentAt === null) {
        const rereadIssue = postClaimRereadIssue(request.jobId, preClaimObserved, terminal, true);
        const noIntentIssue = postClaimNoIntentIssue(terminal);
        const higherHighWater = preClaimObserved.cancellationClockHighWaterAt !== null
          && terminal.cancellationClockHighWaterAt !== null
          && terminal.cancellationClockHighWaterAt > preClaimObserved.cancellationClockHighWaterAt;
        if (rereadIssue !== null || noIntentIssue !== null || !higherHighWater) {
          return failedClosed(
            options,
            terminal,
            true,
            request.at,
            rereadIssue ?? noIntentIssue ?? 'cancellation escalation claim was lost without a canonical higher clock high-water',
          );
        }
        const retryAt = (options.clock ?? defaultClock).now();
        if (!isCanonicalInstant(retryAt)) {
          return failedClosed(options, terminal, true, request.at, 'wall clock observation is not canonical during cancellation escalation contention');
        }
        if (retryAt < terminal.cancellationClockHighWaterAt!) return coordinationPending(terminal);
        if (postClaimAttempt === MAX_POST_CLAIM_ATTEMPTS - 1) return coordinationPending(terminal);
        continue;
      }
    } else {
      const previousEscalationOwner = terminal.cancellationEscalationOwner;
      const previousEscalationLeaseExpiresAt = terminal.cancellationEscalationLeaseExpiresAt;
      if (
        previousEscalationOwner === null
        || previousEscalationOwner.length === 0
        || previousEscalationLeaseExpiresAt === null
        || !isCanonicalInstant(previousEscalationLeaseExpiresAt)
        || terminal.cancellationGraceDeadlineAt !== previousEscalationLeaseExpiresAt
      ) {
        return failedClosed(options, terminal, true, request.at, 'persisted cancellation escalation ownership is incomplete');
      }
      if (previousEscalationOwner === coordinatorId && previousEscalationLeaseExpiresAt > freshEscalationAt) {
        ownsStop = true;
        escalationFence = {
          escalationOwner: coordinatorId,
          escalationLeaseExpiresAt: previousEscalationLeaseExpiresAt,
          stopIntentAt: terminal.cancellationStopIntentAt,
        };
      } else if (previousEscalationLeaseExpiresAt <= freshEscalationAt) {
        const replacementGraceDeadlineAt = addMilliseconds(freshEscalationAt, systemdGraceMs);
        try {
          const takeover = options.ownership.apiWrite({
            kind: 'takeover-cancellation-escalation',
            jobId: terminal.jobId,
            expectedState: terminal.state as ActiveRecoveryState,
            cancelRequestedAt: terminal.cancelRequestedAt!,
            cooperativeDeadlineAt,
            runnerUnit: terminal.runnerUnit!,
            observedOwner: terminal.runnerLeaseOwner!,
            observedLeaseExpiresAt: terminal.runnerLeaseExpiresAt!,
            previousEscalationOwner,
            previousEscalationLeaseExpiresAt,
            stopIntentAt: terminal.cancellationStopIntentAt,
            escalationOwner: coordinatorId,
            escalationLeaseExpiresAt: replacementGraceDeadlineAt,
            graceDeadlineAt: replacementGraceDeadlineAt,
            at: freshEscalationAt,
          });
          ownsStop = takeover.ok && takeover.kind === 'committed';
          if (ownsStop) {
            escalationFence = {
              escalationOwner: coordinatorId,
              escalationLeaseExpiresAt: replacementGraceDeadlineAt,
              stopIntentAt: terminal.cancellationStopIntentAt,
            };
          }
        } catch {
          ownsStop = false;
        }
        terminal = readCancellationJob(options.store, request.jobId);
        if (!ownsStop) {
          if (
            terminal.cancellationStopIntentAt === preClaimObserved.cancellationStopIntentAt
            && terminal.cancellationEscalationOwner !== null
            && terminal.cancellationEscalationLeaseExpiresAt !== null
            && terminal.cancellationEscalationLeaseExpiresAt > freshEscalationAt
          ) return coordinationPending(terminal);
          return failedClosed(options, terminal, true, request.at, 'expired cancellation escalation takeover CAS was lost');
        }
      } else {
        return coordinationPending(terminal);
      }
    }
    break;
  }
  if (isTerminal(terminal)) return outcomeForTerminal(request.jobId, terminal, true);
  if (terminal.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
  if (!ownsStop || escalationFence === undefined) {
    if (
      ACTIVE_STATES.has(terminal.state)
      && terminal.cancellationStopIntentAt !== null
      && terminal.cancellationEscalationOwner !== null
      && terminal.cancellationEscalationLeaseExpiresAt !== null
    ) return coordinationPending(terminal);
    return failedClosed(options, terminal, true, request.at, 'systemd escalation ownership was not acquired');
  }
  if (!ACTIVE_STATES.has(terminal.state)) return failedClosed(options, terminal, true, request.at, 'runner state changed before systemd escalation claim', escalationFence);
  if (
    !validateRunnerUnit(request.jobId, terminal.runnerUnit)
    || terminal.runnerUnit !== cancellationRunnerUnit
    || terminal.runnerLeaseOwner !== cancellationLeaseOwner
    || terminal.runnerLeaseExpiresAt === null
    || !isCanonicalInstant(terminal.runnerLeaseExpiresAt)
    || terminal.cancellationStopIntentAt === null
    || terminal.cancellationGraceDeadlineAt === null
    || terminal.cancellationEscalationOwner !== coordinatorId
  ) return failedClosed(options, terminal, true, request.at, 'systemd escalation identity or durable stop intent is invalid', escalationFence);

  const escalationUnit = terminal.runnerUnit;
  const stopIntentAt = escalationFence.stopIntentAt;
  const graceDeadlineAt = escalationFence.escalationLeaseExpiresAt;
  if (ownsStop) {
    const escalationState = terminal.state;
    let ownsAuthorization = false;
    let authorizationObservedAt: string | null = null;
    let stopBudgetObservedAt: string | null = null;
    let authorizedLeaseExpiresAt = claimLeaseExpiresAt;
    let minimumLeaseExpiresAt = claimLeaseExpiresAt;
    for (let attempt = 0; attempt < MAX_STOP_AUTHORIZATION_ATTEMPTS; attempt += 1) {
      terminal = readCancellationJob(options.store, request.jobId);
      if (isTerminal(terminal)) return outcomeForTerminal(request.jobId, terminal, true);
      if (terminal.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
      const preAuthorizationClock = observeCancellationClock(options, terminal, true, request.at, 'pre-stop-authorization', escalationFence);
      if (preAuthorizationClock.kind === 'outcome') return preAuthorizationClock.outcome;
      terminal = preAuthorizationClock.job;
      const authorizationIdentityIssue = runnerIdentityIssue(
        request.jobId,
        terminal,
        escalationUnit,
        cancellationLeaseOwner,
        minimumLeaseExpiresAt,
        preAuthorizationClock.observedAt,
      );
      if (
        authorizationIdentityIssue !== null
        || terminal.state !== escalationState
        || terminal.cancelRequestedAt !== cancellationRequestedAt
        || terminal.cancellationEscalationOwner !== coordinatorId
        || terminal.cancellationStopIntentAt !== stopIntentAt
        || terminal.cleanupBlockerCode !== null
        || terminal.cleanupBlocker !== null
        || terminal.cleanupFenceGeneration !== null
        || terminal.cleanupAdmissionId !== null
      ) {
        return failedClosed(
          options,
          terminal,
          true,
          request.at,
          authorizationIdentityIssue ?? 'systemd stop authorization ownership changed before the stop boundary',
          escalationFence,
        );
      }
      const attemptedLeaseExpiresAt = terminal.runnerLeaseExpiresAt!;
      let authorizationReturned = false;
      try {
        const authorization = options.ownership.apiWrite({
          kind: 'authorize-cancellation-stop',
          jobId: terminal.jobId,
          expectedState: terminal.state as ActiveRecoveryState,
          cancelRequestedAt: terminal.cancelRequestedAt,
          runnerUnit: escalationUnit,
          observedOwner: terminal.runnerLeaseOwner!,
          observedLeaseExpiresAt: attemptedLeaseExpiresAt,
          escalationOwner: coordinatorId,
          stopIntentAt,
          expectedHighWaterAt: preAuthorizationClock.observedAt,
          authorizedAt: preAuthorizationClock.observedAt,
          at: preAuthorizationClock.observedAt,
        });
        authorizationReturned = true;
        ownsAuthorization = authorization.ok && authorization.kind === 'committed';
      } catch {
        authorizationReturned = false;
        ownsAuthorization = false;
      }
      terminal = readCancellationJob(options.store, request.jobId);
      if (isTerminal(terminal)) return outcomeForTerminal(request.jobId, terminal, true);
      if (terminal.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
      if (ownsAuthorization) {
        authorizationObservedAt = preAuthorizationClock.observedAt;
        stopBudgetObservedAt = preAuthorizationClock.observedAt;
        authorizedLeaseExpiresAt = attemptedLeaseExpiresAt;
        break;
      }
      if (
        terminal.cancellationStopAuthorizedAt !== null
        || terminal.cancellationStopAuthorizedLeaseExpiresAt !== null
      ) {
        if (
          terminal.cancellationStopAuthorizedAt === null
          || terminal.cancellationStopAuthorizedLeaseExpiresAt === null
        ) return failedClosed(options, terminal, true, request.at, 'durable systemd stop authorization is incomplete', escalationFence);
        ownsAuthorization = true;
        authorizationObservedAt = terminal.cancellationStopAuthorizedAt;
        stopBudgetObservedAt = preAuthorizationClock.observedAt;
        authorizedLeaseExpiresAt = terminal.cancellationStopAuthorizedLeaseExpiresAt;
        break;
      }
      if (!authorizationReturned) {
        return failedClosed(options, terminal, true, request.at, 'systemd stop authorization outcome is ambiguous', escalationFence);
      }
      const retryIdentityIssue = runnerIdentityIssue(
        request.jobId,
        terminal,
        escalationUnit,
        cancellationLeaseOwner,
        attemptedLeaseExpiresAt,
        preAuthorizationClock.observedAt,
      );
      if (
        retryIdentityIssue !== null
        || terminal.state !== escalationState
        || terminal.cancelRequestedAt !== cancellationRequestedAt
        || terminal.cancellationEscalationOwner !== coordinatorId
        || terminal.cancellationStopIntentAt !== stopIntentAt
        || terminal.cleanupBlockerCode !== null
        || terminal.cleanupBlocker !== null
        || terminal.cleanupFenceGeneration !== null
        || terminal.cleanupAdmissionId !== null
      ) {
        return failedClosed(
          options,
          terminal,
          true,
          request.at,
          retryIdentityIssue ?? 'systemd stop authorization ownership changed during CAS retry',
          escalationFence,
        );
      }
      minimumLeaseExpiresAt = attemptedLeaseExpiresAt;
      if (attempt === MAX_STOP_AUTHORIZATION_ATTEMPTS - 1) {
        return failedClosed(options, terminal, true, request.at, 'systemd stop authorization retry budget was exhausted by same-owner lease churn', escalationFence);
      }
    }
    if (
      ownsAuthorization
      && (
        authorizationObservedAt === null
        || stopBudgetObservedAt === null
        || terminal.cancellationStopAuthorizedAt !== authorizationObservedAt
        || terminal.cancellationStopAuthorizedLeaseExpiresAt !== authorizedLeaseExpiresAt
        || terminal.state !== escalationState
        || terminal.cancelRequestedAt !== cancellationRequestedAt
        || terminal.cancellationEscalationOwner !== coordinatorId
        || terminal.cancellationStopIntentAt !== stopIntentAt
        || terminal.runnerUnit !== escalationUnit
        || terminal.runnerLeaseOwner !== cancellationLeaseOwner
        || terminal.runnerLeaseExpiresAt === null
        || !isCanonicalInstant(terminal.runnerLeaseExpiresAt)
        || terminal.runnerLeaseExpiresAt < authorizedLeaseExpiresAt
        || terminal.runnerLeaseExpiresAt <= authorizationObservedAt
        || terminal.cleanupBlockerCode !== null
        || terminal.cleanupBlocker !== null
        || terminal.cleanupFenceGeneration !== null
        || terminal.cleanupAdmissionId !== null
      )
    ) {
      return failedClosed(options, terminal, true, request.at, 'durable systemd stop authorization does not match the immediate runner observation', escalationFence);
    }
    if (ownsAuthorization && terminal.cancellationStopObservation === null) {
      const stopDeadlineMonotonic = monotonicDeadline(clock, graceDeadlineAt, stopBudgetObservedAt!);
      let stopObservation: ApiCancellationSystemdObservation;
      try {
        stopObservation = await options.systemd.stopRunner(escalationUnit, stopDeadlineMonotonic);
      } catch (error) {
        stopObservation = failedSystemdObservation('stop', escalationUnit, error);
      }
      terminal = readCancellationJob(options.store, request.jobId);
      if (isTerminal(terminal)) return outcomeForTerminal(request.jobId, terminal, true);
      if (terminal.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
      const afterStopClock = observeCancellationClock(options, terminal, true, request.at, 'after-systemd-stop', escalationFence);
      if (afterStopClock.kind === 'outcome') return afterStopClock.outcome;
      terminal = afterStopClock.job;
      const postStopIdentityIssue = runnerIdentityIssue(
        request.jobId,
        terminal,
        escalationUnit,
        cancellationLeaseOwner,
        authorizedLeaseExpiresAt,
        afterStopClock.observedAt,
      );
      if (postStopIdentityIssue !== null) {
        return failedClosed(options, terminal, true, request.at, postStopIdentityIssue, escalationFence);
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
          at: afterStopClock.observedAt,
        });
      } catch {
        // A crash/race after intent is reconciled from the durable intent below.
      }
    }
  }
  terminal = readCancellationJob(options.store, request.jobId);
  if (isTerminal(terminal)) return outcomeForTerminal(request.jobId, terminal, true);
  if (terminal.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };

  const graceClock = observeCancellationClock(options, terminal, true, request.at, 'grace-deadline-conversion', escalationFence);
  if (graceClock.kind === 'outcome') return graceClock.outcome;
  terminal = graceClock.job;
  const graceDeadlineMonotonic = monotonicDeadline(clock, graceDeadlineAt, graceClock.observedAt);
  let inspected = false;
  while (!inspected || clock.monotonicNow() < graceDeadlineMonotonic) {
    let observed = readCancellationJob(options.store, request.jobId);
    if (isTerminal(observed)) return outcomeForTerminal(request.jobId, observed, true);
    if (observed.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
    const beforeInspectionClock = observeCancellationClock(options, observed, true, request.at, 'before-systemd-inspection', escalationFence);
    if (beforeInspectionClock.kind === 'outcome') return beforeInspectionClock.outcome;
    observed = beforeInspectionClock.job;
    let inspection: ApiCancellationSystemdObservation;
    try {
      inspection = await options.systemd.inspectRunner(escalationUnit, graceDeadlineMonotonic);
    } catch (error) {
      inspection = failedSystemdObservation('inspect', escalationUnit, error);
    }
    observed = readCancellationJob(options.store, request.jobId);
    if (isTerminal(observed)) return outcomeForTerminal(request.jobId, observed, true);
    if (observed.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
    const afterInspectionClock = observeCancellationClock(options, observed, true, request.at, 'after-systemd-inspection', escalationFence);
    if (afterInspectionClock.kind === 'outcome') return afterInspectionClock.outcome;
    observed = afterInspectionClock.job;
    try {
      options.ownership.apiWrite({
        kind: 'record-cancellation-inspection',
        jobId: observed.jobId,
        expectedState: observed.state as ActiveRecoveryState,
        cancelRequestedAt: observed.cancelRequestedAt!,
        runnerUnit: escalationUnit,
        observedOwner: observed.runnerLeaseOwner!,
        observedLeaseExpiresAt: observed.runnerLeaseExpiresAt!,
        escalationOwner: coordinatorId,
        escalationLeaseExpiresAt: graceDeadlineAt,
        stopIntentAt,
        observation: publicObservation(inspection),
        at: afterInspectionClock.observedAt,
      });
    } catch {
      // Terminal and identity races are handled by the following re-read.
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
  if (!ACTIVE_STATES.has(terminal.state)) return failedClosed(options, terminal, true, request.at, 'runner state changed before recovery blocker persistence', escalationFence);
  const blockerClock = observeCancellationClock(options, terminal, true, request.at, 'recovery-blocker-persistence', escalationFence);
  if (blockerClock.kind === 'outcome') return blockerClock.outcome;
  terminal = blockerClock.job;
  return writeBlocker(
    options,
    terminal,
    request.at,
    cooperativeDeadlineAt,
    graceDeadlineAt,
    terminal.cancellationSignalObservation,
    terminal.cancellationStopObservation,
    terminal.cancellationInspectionObservations,
    escalationFence,
  );
}

export { validateRunnerUnit };
