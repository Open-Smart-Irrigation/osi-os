import type { ApiProcess, ApiProcessStartResult } from './main.js';
import type { StartupBootstrap } from './startup-order.js';

const DEFAULT_DISPATCH_INTERVAL_MS = 1_000;
const DEFAULT_RECONCILIATION_INTERVAL_MS = 30_000;

export interface DispatchingApiProcessOptions {
  readonly process: ApiProcess;
  readonly bootstrap: Pick<StartupBootstrap, 'start' | 'reconcile' | 'dispatch'>;
  readonly dispatchIntervalMs?: number;
  readonly reconciliationIntervalMs?: number;
  readonly monotonicNow?: () => number;
  readonly reportError?: (error: unknown) => void;
}

function positiveInterval(value: number | undefined, fallback: number, name: string): number {
  const interval = value ?? fallback;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 60 * 60 * 1_000) {
    throw new TypeError(`${name} must be a positive bounded interval`);
  }
  return interval;
}

export function createDispatchingApiProcess(options: DispatchingApiProcessOptions): ApiProcess {
  const dispatchIntervalMs = positiveInterval(
    options.dispatchIntervalMs,
    DEFAULT_DISPATCH_INTERVAL_MS,
    'dispatch interval',
  );
  const reconciliationIntervalMs = positiveInterval(
    options.reconciliationIntervalMs,
    DEFAULT_RECONCILIATION_INTERVAL_MS,
    'reconciliation interval',
  );
  if (reconciliationIntervalMs < dispatchIntervalMs) {
    throw new TypeError('reconciliation interval cannot be shorter than dispatch interval');
  }
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const reportError = options.reportError ?? ((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`queue pump failed: ${message.replace(/[\r\n\t]+/gu, ' ').slice(0, 512)}\n`);
  });
  let timer: ReturnType<typeof setInterval> | null = null;
  let nextReconciliationAt = 0;
  let work: Promise<void> | null = null;
  let stopped = false;
  let started: Promise<ApiProcessStartResult> | null = null;
  let stopping: Promise<void> | null = null;

  const tick = (): void => {
    if (stopped || work !== null) return;
    const reconcile = monotonicNow() >= nextReconciliationAt;
    if (reconcile) nextReconciliationAt = monotonicNow() + reconciliationIntervalMs;
    work = Promise.resolve()
      .then(async () => {
        if (reconcile) await options.bootstrap.reconcile();
        else await options.bootstrap.dispatch();
      })
      .catch(reportError)
      .finally(() => {
        work = null;
      });
  };

  const start = (): Promise<ApiProcessStartResult> => {
    if (started !== null) return started;
    if (stopped) return Promise.reject(new Error('dispatching API process is stopped'));
    started = options.process.start().then((result) => {
      nextReconciliationAt = monotonicNow() + reconciliationIntervalMs;
      timer = setInterval(tick, dispatchIntervalMs);
      timer.unref?.();
      return result;
    });
    return started;
  };

  const stop = (): Promise<void> => {
    if (stopping !== null) return stopping;
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    stopping = (async () => {
      await work;
      await options.process.stop();
    })();
    return stopping;
  };

  return Object.freeze({ start, stop });
}
