import { performance } from 'node:perf_hooks';
import {
  ACTIVE_RECOVERY_STATES,
  TERMINAL_STATES,
  type ActiveRecoveryState,
  type JobState,
} from '../../domain/types.js';
import {
  CommandExecutionError,
  type CommandExecutor,
  type CommandResult,
} from '../../runner/src/command-executor.js';
import type {
  ApiWriteCommand,
  OwnershipResult,
} from './ownership.js';
import type {
  BuilderStore,
  JobRecord,
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
  readonly active: boolean;
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
  readonly getJob: (jobId: string) => JobRecord;
}

export interface ApiCancellationOwnership {
  readonly apiWrite: (command: ApiWriteCommand) => OwnershipResult;
}

export interface ApiCancellationOptions {
  readonly store: ApiCancellationStore | Pick<BuilderStore, 'getJob'>;
  readonly ownership: ApiCancellationOwnership;
  readonly systemd: ApiCancellationSystemd;
  readonly clock?: ApiCancellationClock;
  readonly cooperativeTimeoutMs?: number;
  readonly systemdGraceMs?: number;
  readonly pollIntervalMs?: number;
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
    active: observation.active,
    argv: [...observation.argv],
    exitCode: observation.exitCode,
    signal: observation.signal,
    stdout: boundedObservationText(observation.stdout),
    stderr: boundedObservationText(observation.stderr),
    timedOut: observation.timedOut,
  };
}

function commandObservation(
  argv: readonly string[],
  result: CommandResult | null,
  active: boolean,
  error?: unknown,
): ApiCancellationSystemdObservation {
  const message = error instanceof Error ? error.message : error === undefined ? '' : String(error);
  return {
    active,
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
    ? [SYSTEMCTL, '--user', 'kill', '--signal=SIGUSR1', runnerUnit]
    : action === 'stop'
      ? [SYSTEMCTL, '--user', 'stop', runnerUnit]
      : [SYSTEMCTL, '--user', 'is-active', runnerUnit];
}

function failedSystemdObservation(action: 'signal' | 'stop' | 'inspect', runnerUnit: string, error: unknown): ApiCancellationSystemdObservation {
  const commandError = error instanceof CommandExecutionError ? error : null;
  return commandObservation(
    fixedSystemdArgv(action, runnerUnit),
    commandError?.result ?? null,
    action === 'inspect' && commandError?.result?.exitCode === 0,
    error,
  );
}

export function createSystemdCancellationAdapter(options: SystemdCancellationAdapterOptions): ApiCancellationSystemd {
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const maxCaptureBytes = options.maxCaptureBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maxCaptureBytes) || maxCaptureBytes < 1) throw new TypeError('systemd observation capture limit is invalid');

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
      return commandObservation(argv, result, action === 'inspect' ? result.exitCode === 0 : result.exitCode === 0);
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

function isTerminal(job: JobRecord): job is JobRecord & { readonly state: Extract<JobState, 'succeeded' | 'failed' | 'cancelled' | 'interrupted'> } {
  return TERMINAL_STATE_SET.has(job.state);
}

function currentAt(clock: ApiCancellationClock, minimum: string): string {
  const observed = clock.now();
  return observed >= minimum ? observed : minimum;
}

function hasLiveRunnerLease(job: JobRecord, at: string): boolean {
  return job.runnerLeaseOwner !== null
    && job.runnerLeaseOwner.length > 0
    && job.runnerLeaseExpiresAt !== null
    && job.runnerLeaseExpiresAt > at;
}

function requestCommand(request: ApiCancellationRequest, late: boolean): Extract<ApiWriteCommand, { readonly kind: 'request-cancellation' }> {
  return {
    kind: 'request-cancellation',
    jobId: request.jobId,
    reason: request.reason,
    at: request.at,
    error: late ? { reason: request.reason, late: true } : { reason: request.reason },
  };
}

function outcomeForTerminal(jobId: string, job: JobRecord, requestPersisted: boolean): ApiCancellationResult {
  if (requestPersisted) return { kind: 'runner-terminal', jobId, state: job.state as Extract<JobState, 'succeeded' | 'failed' | 'cancelled' | 'interrupted'>, runnerOwned: true };
  return { kind: 'already-terminal', jobId, state: job.state as Extract<JobState, 'succeeded' | 'failed' | 'cancelled' | 'interrupted'>, requestPersisted: false };
}

function failedClosed(
  job: JobRecord,
  requestPersisted: boolean,
  requestedAt: string,
  reason: string,
): ApiCancellationResult {
  return {
    kind: 'recovery-blocked',
    jobId: job.jobId,
    state: job.state as ActiveRecoveryState,
    blockerCode: 'RUNNER_DISAPPEARED',
    requestPersisted,
    evidence: {
      kind: 'api-cancellation-fail-closed',
      reason,
      requestedAt,
      persistedRunnerUnit: job.runnerUnit,
      expectedRunnerUnit: (() => { try { return exactRunnerUnit(job.jobId); } catch { return null; } })(),
      observedOwner: job.runnerLeaseOwner,
      observedLeaseExpiresAt: job.runnerLeaseExpiresAt,
      state: job.state,
    },
  };
}

function writeRequest(
  options: ApiCancellationOptions,
  request: ApiCancellationRequest,
  late: boolean,
): { readonly accepted: boolean; readonly requestPersisted: boolean } {
  try {
    const result = options.ownership.apiWrite(requestCommand(request, late));
    if (result.ok) return { accepted: true, requestPersisted: true };
    return { accepted: false, requestPersisted: false };
  } catch {
    return { accepted: false, requestPersisted: false };
  }
}

function writeBlocker(
  options: ApiCancellationOptions,
  job: JobRecord,
  requestedAt: string,
  cooperativeDeadlineMonotonic: number,
  graceDeadlineMonotonic: number,
  signal: ApiCancellationSystemdObservation,
  stop: ApiCancellationSystemdObservation,
  inspections: readonly ApiCancellationSystemdObservation[],
): ApiCancellationResult {
  const evidence: JsonObject = {
    kind: 'api-cancellation-escalation',
    reason: 'runner did not commit a terminal cancellation result before systemd grace expired',
    requestedAt,
    runnerUnit: job.runnerUnit,
    observedOwner: job.runnerLeaseOwner,
    observedLeaseExpiresAt: job.runnerLeaseExpiresAt,
    cooperativeDeadlineMonotonic,
    graceDeadlineMonotonic,
    systemd: {
      signal: publicObservation(signal),
      stop: publicObservation(stop),
      inspections: inspections.map(publicObservation),
    },
  };
  if (!validateRunnerUnit(job.jobId, job.runnerUnit)) return failedClosed(job, true, requestedAt, 'runner unit changed or is not exact before blocker persistence');
  const at = currentAt(options.clock ?? defaultClock, job.cancelRequestedAt ?? requestedAt);
  try {
    const result = options.ownership.apiWrite({
      kind: 'runner-recovery-blocker',
      jobId: job.jobId,
      expectedState: job.state as ActiveRecoveryState,
      runnerUnit: job.runnerUnit,
      observedOwner: job.runnerLeaseOwner,
      observedLeaseExpiresAt: job.runnerLeaseExpiresAt,
      blocker: evidence,
      at,
    });
    if (!result.ok) {
      const latest = options.store.getJob(job.jobId);
      if (latest.cleanupBlockerCode === 'RUNNER_DISAPPEARED' && latest.cleanupBlocker !== null) {
        return { kind: 'recovery-blocked', jobId: latest.jobId, state: latest.state as ActiveRecoveryState, blockerCode: 'RUNNER_DISAPPEARED', requestPersisted: true, evidence: latest.cleanupBlocker };
      }
      if (isTerminal(latest)) return outcomeForTerminal(job.jobId, latest, true);
      return failedClosed(latest, true, requestedAt, `recovery blocker write rejected: ${result.conflict.kind}`);
    }
  } catch {
    const latest = options.store.getJob(job.jobId);
    if (latest.cleanupBlockerCode === 'RUNNER_DISAPPEARED' && latest.cleanupBlocker !== null) {
      return { kind: 'recovery-blocked', jobId: latest.jobId, state: latest.state as ActiveRecoveryState, blockerCode: 'RUNNER_DISAPPEARED', requestPersisted: true, evidence: latest.cleanupBlocker };
    }
    if (isTerminal(latest)) return outcomeForTerminal(job.jobId, latest, true);
    return failedClosed(latest, true, requestedAt, 'recovery blocker write failed');
  }
  return { kind: 'recovery-blocked', jobId: job.jobId, state: job.state as ActiveRecoveryState, blockerCode: 'RUNNER_DISAPPEARED', requestPersisted: true, evidence };
}

async function waitForTerminal(
  options: ApiCancellationOptions,
  jobId: string,
  deadlineMonotonic: number,
): Promise<JobRecord | null> {
  const clock = options.clock ?? defaultClock;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  while (true) {
    const current = options.store.getJob(jobId);
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

  let job = options.store.getJob(request.jobId);
  if (isTerminal(job)) return outcomeForTerminal(request.jobId, job, false);

  if (job.state === 'queued') {
    if (job.cancelRequestedAt === null) writeRequest(options, request, false);
    const queued = options.store.getJob(request.jobId);
    if (queued.state === 'cancelled') return { kind: 'queued-cancelled', jobId: request.jobId, state: 'cancelled', requestPersisted: true };
    if (isTerminal(queued)) return outcomeForTerminal(request.jobId, queued, true);
    return { kind: 'request-not-accepted', jobId: request.jobId, state: queued.state, evidence: { kind: 'queued-cancellation-not-committed', requestedAt: request.at } };
  }

  if (job.state === 'publishing') {
    if (job.cancelRequestedAt === null) writeRequest(options, request, true);
    job = options.store.getJob(request.jobId);
    if (job.state === 'publishing' && job.cancelRequestedAt !== null) return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
    if (isTerminal(job)) return outcomeForTerminal(request.jobId, job, true);
    return { kind: 'request-not-accepted', jobId: request.jobId, state: job.state, evidence: { kind: 'publishing-cancellation-not-committed', requestedAt: request.at } };
  }

  if (!ACTIVE_STATES.has(job.state)) return { kind: 'request-not-accepted', jobId: request.jobId, state: job.state, evidence: { kind: 'unsupported-cancellation-state', requestedAt: request.at } };

  let requestPersisted = job.cancelRequestedAt !== null;
  if (!requestPersisted) {
    writeRequest(options, request, false);
    job = options.store.getJob(request.jobId);
    requestPersisted = job.cancelRequestedAt !== null;
  }
  if (!requestPersisted) return failedClosed(job, false, request.at, 'cancellation request transaction was not observed durably');
  if (isTerminal(job)) return outcomeForTerminal(request.jobId, job, true);
  if (job.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
  if (!ACTIVE_STATES.has(job.state)) return failedClosed(job, true, request.at, 'job changed to an unsupported state after request persistence');
  if (!validateRunnerUnit(request.jobId, job.runnerUnit)) return failedClosed(job, true, request.at, 'persisted runner unit is missing or mismatched');
  if (!hasLiveRunnerLease(job, currentAt(clock, request.at))) return failedClosed(job, true, request.at, 'persisted runner lease is missing or stale');
  const cancellationLeaseOwner = job.runnerLeaseOwner;
  const cancellationLeaseExpiresAt = job.runnerLeaseExpiresAt;

  // The deadline is created once, before signal dispatch, and is shared by every
  // cooperative operation. No adapter is allowed to create a second budget.
  const cooperativeDeadlineMonotonic = clock.monotonicNow() + cooperativeTimeoutMs;
  let signalObservation: ApiCancellationSystemdObservation;
  try {
    signalObservation = await options.systemd.signalCancellation(job.runnerUnit, cooperativeDeadlineMonotonic);
  } catch (error) {
    signalObservation = failedSystemdObservation('signal', job.runnerUnit, error);
  }

  let terminal = options.store.getJob(request.jobId);
  if (isTerminal(terminal)) return outcomeForTerminal(request.jobId, terminal, true);
  if (terminal.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
  const cooperative = await waitForTerminal({ ...options, pollIntervalMs }, request.jobId, cooperativeDeadlineMonotonic);
  if (cooperative !== null) {
    if (isTerminal(cooperative)) return outcomeForTerminal(request.jobId, cooperative, true);
    if (cooperative.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
  }

  terminal = options.store.getJob(request.jobId);
  if (isTerminal(terminal)) return outcomeForTerminal(request.jobId, terminal, true);
  if (terminal.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
  if (
    !ACTIVE_STATES.has(terminal.state)
    || !validateRunnerUnit(request.jobId, terminal.runnerUnit)
    || terminal.runnerLeaseOwner !== cancellationLeaseOwner
    || terminal.runnerLeaseExpiresAt !== cancellationLeaseExpiresAt
  ) return failedClosed(terminal, true, request.at, 'runner lease identity changed before systemd escalation');

  const graceDeadlineMonotonic = clock.monotonicNow() + systemdGraceMs;
  const escalationUnit = terminal.runnerUnit;
  if (!validateRunnerUnit(request.jobId, escalationUnit)) return failedClosed(terminal, true, request.at, 'runner identity changed before systemd escalation');
  let stopObservation: ApiCancellationSystemdObservation;
  try {
    stopObservation = await options.systemd.stopRunner(escalationUnit, graceDeadlineMonotonic);
  } catch (error) {
    stopObservation = failedSystemdObservation('stop', escalationUnit, error);
  }
  terminal = options.store.getJob(request.jobId);
  if (isTerminal(terminal)) return outcomeForTerminal(request.jobId, terminal, true);
  if (terminal.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };

  const inspections: ApiCancellationSystemdObservation[] = [];
  while (clock.monotonicNow() < graceDeadlineMonotonic) {
    const observed = await options.store.getJob(request.jobId);
    if (isTerminal(observed)) return outcomeForTerminal(request.jobId, observed, true);
    if (observed.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
    try {
      inspections.push(await options.systemd.inspectRunner(escalationUnit, graceDeadlineMonotonic));
    } catch (error) {
      inspections.push(failedSystemdObservation('inspect', escalationUnit, error));
    }
    const afterInspect = options.store.getJob(request.jobId);
    if (isTerminal(afterInspect)) return outcomeForTerminal(request.jobId, afterInspect, true);
    if (afterInspect.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
    const remaining = graceDeadlineMonotonic - clock.monotonicNow();
    if (remaining <= 0) break;
    await clock.sleep(Math.min(pollIntervalMs, remaining));
  }

  terminal = options.store.getJob(request.jobId);
  if (isTerminal(terminal)) return outcomeForTerminal(request.jobId, terminal, true);
  if (terminal.state === 'publishing') return { kind: 'late-publishing', jobId: request.jobId, state: 'publishing', late: true, requestPersisted: true };
  if (!ACTIVE_STATES.has(terminal.state)) return failedClosed(terminal, true, request.at, 'runner state changed before recovery blocker persistence');
  return writeBlocker(options, terminal, request.at, cooperativeDeadlineMonotonic, graceDeadlineMonotonic, signalObservation, stopObservation, inspections);
}

export { validateRunnerUnit };
