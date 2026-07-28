import { createQueueCoordinator, type QueueBlocker, type QueueCoordinatorOptions, type QueueStartupGate } from './queue.js';

export const STARTUP_PHASES = [
  'migrations',
  'cleanup-admissions',
  'live-runner-classification',
  'stale-publishing-recovery',
  'non-publishing-interruption',
  'retention',
  'dispatch',
] as const;

export type StartupPhase = (typeof STARTUP_PHASES)[number];

export interface StartupPhaseResult {
  readonly blockers: readonly QueueBlocker[];
}

export interface StartupPhaseEvent {
  readonly phase: StartupPhase;
  readonly status: 'completed';
  readonly blockers: readonly QueueBlocker[];
}

export interface StartupCoordinatorPhases {
  readonly migrations: () => Promise<StartupPhaseResult>;
  readonly cleanupAdmissions: () => Promise<StartupPhaseResult>;
  readonly liveRunnerClassification: () => Promise<StartupPhaseResult>;
  readonly stalePublishingRecovery: () => Promise<StartupPhaseResult>;
  readonly nonPublishingInterruption: () => Promise<StartupPhaseResult>;
  /** Injected until the retention implementation is delivered by Task 27. */
  readonly retention: () => Promise<StartupPhaseResult>;
  readonly dispatch: () => Promise<StartupPhaseResult>;
}

export interface StartupCoordinatorOptions extends StartupCoordinatorPhases {
  readonly queueGate?: QueueStartupGate;
}

export type StartupService = () => Promise<StartupPhaseResult>;

/**
 * The API bootstrap owns the queue instance. Callers provide named production
 * services, while dispatch remains reachable only through the startup boundary.
 */
export interface StartupProductionServices {
  readonly migrations: StartupService;
  readonly cleanupAdmissions: StartupService;
  readonly liveRunnerClassification: StartupService;
  readonly stalePublishingRecovery: StartupService;
  readonly nonPublishingInterruption: StartupService;
  readonly retention: StartupService;
}

export interface StartupBootstrapOptions {
  readonly queue: Omit<QueueCoordinatorOptions, 'startupReady'>;
  readonly services: StartupProductionServices;
}

export interface StartupBootstrap {
  readonly start: () => Promise<StartupResult>;
  readonly events: () => readonly StartupPhaseEvent[];
}

export interface StartupResult {
  readonly dispatched: boolean;
  readonly blockers: readonly QueueBlocker[];
}

export interface StartupCoordinator {
  readonly start: () => Promise<StartupResult>;
  readonly events: () => readonly StartupPhaseEvent[];
}

function queueDispatchPhase(result: Awaited<ReturnType<ReturnType<typeof createQueueCoordinator>['dispatchNext']>>): StartupPhaseResult {
  if (result.kind === 'recovery-blocked') return { blockers: [result.blocker] };
  if (result.kind === 'blocked') return {
    blockers: [{ code: 'QUEUE_DISPATCH_BLOCKED', details: { reason: result.reason, ...(result.jobId === undefined ? {} : { jobId: result.jobId }) } }],
  };
  return { blockers: [] };
}

export function createStartupBootstrap(options: StartupBootstrapOptions): StartupBootstrap {
  const queue = createQueueCoordinator(options.queue);
  const coordinator = createStartupCoordinator({
    ...options.services,
    queueGate: queue,
    dispatch: async () => queueDispatchPhase(await queue.dispatchNext()),
  });
  return Object.freeze({ start: coordinator.start, events: coordinator.events });
}

function blockers(result: StartupPhaseResult): readonly QueueBlocker[] {
  if (!result || !Array.isArray(result.blockers)) throw new TypeError('startup phase returned an invalid result');
  return result.blockers;
}

export function createStartupCoordinator(options: StartupCoordinatorOptions): StartupCoordinator {
  const events: StartupPhaseEvent[] = [];

  async function start(): Promise<StartupResult> {
    options.queueGate?.beginStartupReconciliation();
    const results: QueueBlocker[] = [];
    const run = async (phase: StartupPhase, work: () => Promise<StartupPhaseResult>): Promise<void> => {
      const phaseBlockers = blockers(await work());
      results.push(...phaseBlockers);
      events.push({ phase, status: 'completed', blockers: phaseBlockers });
    };

    await run('migrations', options.migrations);
    await run('cleanup-admissions', options.cleanupAdmissions);
    await run('live-runner-classification', options.liveRunnerClassification);
    await run('stale-publishing-recovery', options.stalePublishingRecovery);
    await run('non-publishing-interruption', options.nonPublishingInterruption);
    await run('retention', options.retention);

    if (results.length > 0) {
      options.queueGate?.completeStartupReconciliation(results);
      return { dispatched: false, blockers: results };
    }

    options.queueGate?.completeStartupReconciliation([]);
    const dispatchResult = await options.dispatch();
    const dispatchBlockers = blockers(dispatchResult);
    events.push({ phase: 'dispatch', status: 'completed', blockers: dispatchBlockers });
    return { dispatched: dispatchBlockers.length === 0, blockers: dispatchBlockers };
  }

  return Object.freeze({ start, events: () => events.slice() });
}
