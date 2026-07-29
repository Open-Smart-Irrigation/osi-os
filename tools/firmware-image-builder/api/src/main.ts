import type { StaticUiService } from './static-ui.js';
import type {
  StartupBootstrap,
  StartupResult,
} from './startup-order.js';
import type { ApiFreshnessServer } from './freshness-server.js';

export interface ApiProcessHttpServer {
  readonly listening: boolean;
  readonly listen: (port: number, callback?: () => void) => ApiProcessHttpServer;
  readonly close: (callback?: (error?: Error) => void) => ApiProcessHttpServer;
  readonly once: (event: 'error', listener: (error: Error) => void) => unknown;
  readonly off: (event: 'error', listener: (error: Error) => void) => unknown;
}

export interface ApiProcessSignals {
  readonly on: (signal: 'SIGTERM' | 'SIGINT', listener: () => void) => void;
  readonly off: (signal: 'SIGTERM' | 'SIGINT', listener: () => void) => void;
}

export interface ApiProcessDependencies {
  readonly port: number;
  readonly createStaticUi: () => StaticUiService;
  readonly bootstrap: Pick<StartupBootstrap, 'start'>;
  readonly startFreshness: () => Promise<ApiFreshnessServer>;
  readonly createHttp: (staticUi: Pick<StaticUiService, 'resolve'>) => ApiProcessHttpServer;
  readonly closeDatabase: () => void | Promise<void>;
  readonly signals?: ApiProcessSignals;
  readonly onSignalError?: (error: unknown) => void;
}

export interface ApiProcessStartResult {
  readonly port: number;
  readonly freshnessSocketPath: string;
  readonly startup: StartupResult;
}

export interface ApiProcess {
  readonly start: () => Promise<ApiProcessStartResult>;
  readonly stop: () => Promise<void>;
}

function assertDependencies(options: ApiProcessDependencies): void {
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new TypeError('API process port must be an explicit TCP port');
  }
  for (const [name, value] of [
    ['createStaticUi', options.createStaticUi],
    ['bootstrap.start', options.bootstrap?.start],
    ['startFreshness', options.startFreshness],
    ['createHttp', options.createHttp],
    ['closeDatabase', options.closeDatabase],
  ] as const) {
    if (typeof value !== 'function') throw new TypeError(`API process ${name} dependency is required`);
  }
}

function listen(server: ApiProcessHttpServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      server.off('error', onError);
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    server.once('error', onError);
    try {
      server.listen(port, onListening);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function closeHttp(server: ApiProcessHttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error !== undefined && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    };
    try {
      server.close(finish);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ERR_SERVER_NOT_RUNNING') {
        finish();
        return;
      }
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function createApiProcess(options: ApiProcessDependencies): ApiProcess {
  assertDependencies(options);
  let staticUi: StaticUiService | null = null;
  let freshness: ApiFreshnessServer | null = null;
  let http: ApiProcessHttpServer | null = null;
  let databaseOpen = true;
  let stopping = false;
  let startPromise: Promise<ApiProcessStartResult> | null = null;
  let stopPromise: Promise<void> | null = null;
  let sigtermRegistered = false;
  let sigintRegistered = false;

  const reportSignalError = options.onSignalError ?? (() => undefined);
  const stopFromSignal = (): void => {
    void stop().catch(reportSignalError);
  };

  const unregisterSignals = (): void => {
    if (options.signals === undefined) return;
    if (sigtermRegistered) {
      sigtermRegistered = false;
      options.signals.off('SIGTERM', stopFromSignal);
    }
    if (sigintRegistered) {
      sigintRegistered = false;
      options.signals.off('SIGINT', stopFromSignal);
    }
  };

  const closeResources = async (): Promise<void> => {
    unregisterSignals();
    let failure: unknown;
    const capture = async (work: () => void | Promise<void>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        failure ??= error;
      }
    };
    const heldHttp = http;
    http = null;
    if (heldHttp !== null) await capture(() => closeHttp(heldHttp));
    const heldFreshness = freshness;
    freshness = null;
    if (heldFreshness !== null) await capture(() => heldFreshness.close());
    const heldStaticUi = staticUi;
    staticUi = null;
    if (heldStaticUi !== null) await capture(() => heldStaticUi.close());
    if (databaseOpen) {
      databaseOpen = false;
      await capture(options.closeDatabase);
    }
    if (failure !== undefined) throw failure;
  };

  function stop(): Promise<void> {
    if (stopPromise !== null) return stopPromise;
    stopping = true;
    const pendingStart = startPromise;
    stopPromise = (async () => {
      if (pendingStart !== null) {
        try {
          await pendingStart;
        } catch {
          // Startup owns its unwind before stop performs the final idempotent pass.
        }
      }
      await closeResources();
    })();
    return stopPromise;
  }

  function start(): Promise<ApiProcessStartResult> {
    if (startPromise !== null) return startPromise;
    if (stopping) return Promise.reject(new Error('API process is stopping or stopped'));
    startPromise = (async () => {
      try {
        const assertRunning = (): void => {
          if (stopping) throw new Error('API process is stopping or stopped');
        };
        staticUi = options.createStaticUi();
        const startup = await options.bootstrap.start();
        assertRunning();
        freshness = await options.startFreshness();
        assertRunning();
        http = options.createHttp(staticUi);
        assertRunning();
        await listen(http, options.port);
        assertRunning();
        if (options.signals !== undefined) {
          sigtermRegistered = true;
          options.signals.on('SIGTERM', stopFromSignal);
          assertRunning();
          sigintRegistered = true;
          options.signals.on('SIGINT', stopFromSignal);
          assertRunning();
        }
        return Object.freeze({
          port: options.port,
          freshnessSocketPath: freshness.socketPath,
          startup,
        });
      } catch (error) {
        stopping = true;
        try {
          await closeResources();
        } catch {
          // The startup error remains the primary failure.
        }
        throw error;
      }
    })();
    return startPromise;
  }

  return Object.freeze({ start, stop });
}
