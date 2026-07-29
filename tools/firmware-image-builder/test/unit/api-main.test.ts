import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  createApiProcess,
  type ApiProcessDependencies,
  type ApiProcessHttpServer,
} from '../../api/src/main.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture(
  overrides: Partial<ApiProcessDependencies> = {},
  behavior: Readonly<{ listenError?: Error }> = {},
) {
  const trace: string[] = [];
  const signals = new EventEmitter();
  const staticUi = {
    resolve: vi.fn(async () => null),
    close: vi.fn(() => { trace.push('static:close'); }),
  };
  const freshness = {
    socketPath: '/state/api.sock',
    settled: Promise.resolve(),
    close: vi.fn(async () => { trace.push('freshness:close'); }),
  };
  let listening = false;
  const emitter = new EventEmitter();
  const http = Object.assign(emitter, {
    get listening() { return listening; },
    listen: vi.fn((port: number, callback?: () => void) => {
      trace.push(`http:listen:${port}`);
      if (behavior.listenError !== undefined) {
        queueMicrotask(() => emitter.emit('error', behavior.listenError));
        return http;
      }
      listening = true;
      queueMicrotask(() => callback?.());
      return http;
    }),
    close: vi.fn((callback?: (error?: Error) => void) => {
      trace.push('http:close');
      listening = false;
      queueMicrotask(() => callback?.());
      return http;
    }),
  }) as ApiProcessHttpServer & EventEmitter;
  const dependencies: ApiProcessDependencies = {
    port: 43129,
    createStaticUi: vi.fn(() => {
      trace.push('static:create');
      return staticUi;
    }),
    bootstrap: {
      start: vi.fn(async () => {
        trace.push('bootstrap:start');
        return { dispatched: true, blockers: [] };
      }),
    },
    startFreshness: vi.fn(async () => {
      trace.push('freshness:start');
      return freshness;
    }),
    createHttp: vi.fn(() => {
      trace.push('http:create');
      return http;
    }),
    closeDatabase: vi.fn(() => { trace.push('database:close'); }),
    signals: {
      on: (signal, listener) => { signals.on(signal, listener); },
      off: (signal, listener) => { signals.off(signal, listener); },
    },
    onSignalError: vi.fn(),
    ...overrides,
  };
  return { dependencies, trace, signals, staticUi, freshness, http };
}

describe('API process lifecycle', () => {
  it('finishes fail-closed startup before opening the loopback HTTP listener', async () => {
    const value = fixture();
    const process = createApiProcess(value.dependencies);

    await expect(process.start()).resolves.toEqual({
      port: 43129,
      freshnessSocketPath: '/state/api.sock',
      startup: { dispatched: true, blockers: [] },
    });
    expect(value.trace).toEqual([
      'static:create',
      'bootstrap:start',
      'freshness:start',
      'http:create',
      'http:listen:43129',
    ]);
    expect(value.dependencies.createHttp).toHaveBeenCalledWith(value.staticUi);
  });

  it('serves recovery blockers without opening the queue early', async () => {
    const value = fixture({
      bootstrap: {
        start: vi.fn(async () => ({
          dispatched: false,
          blockers: [{ code: 'CLEANUP_UNIT_STOP_FAILED' }],
        })),
      },
    });
    const process = createApiProcess(value.dependencies);

    await expect(process.start()).resolves.toMatchObject({
      startup: {
        dispatched: false,
        blockers: [{ code: 'CLEANUP_UNIT_STOP_FAILED' }],
      },
    });
    expect(value.http.listen).toHaveBeenCalledOnce();
  });

  it('single-flights concurrent starts and never listens twice', async () => {
    const startup = deferred<{ dispatched: boolean; blockers: never[] }>();
    const value = fixture({
      bootstrap: { start: vi.fn(() => startup.promise) },
    });
    const process = createApiProcess(value.dependencies);

    const first = process.start();
    const second = process.start();
    expect(second).toBe(first);
    startup.resolve({ dispatched: true, blockers: [] });
    await Promise.all([first, second]);
    expect(value.http.listen).toHaveBeenCalledOnce();
  });

  it('requires the built UI before running startup recovery', async () => {
    const value = fixture({
      createStaticUi: vi.fn(() => {
        throw new Error('ui/dist is unavailable');
      }),
    });
    const process = createApiProcess(value.dependencies);

    await expect(process.start()).rejects.toThrow('ui/dist is unavailable');
    expect(value.dependencies.bootstrap.start).not.toHaveBeenCalled();
    expect(value.dependencies.startFreshness).not.toHaveBeenCalled();
    expect(value.dependencies.createHttp).not.toHaveBeenCalled();
    expect(value.dependencies.closeDatabase).toHaveBeenCalledOnce();
  });

  it('unwinds opened resources in reverse order after a listener failure', async () => {
    const value = fixture({}, { listenError: new Error('address in use') });
    const process = createApiProcess(value.dependencies);

    await expect(process.start()).rejects.toThrow('address in use');
    expect(value.trace).toEqual([
      'static:create',
      'bootstrap:start',
      'freshness:start',
      'http:create',
      'http:listen:43129',
      'http:close',
      'freshness:close',
      'static:close',
      'database:close',
    ]);
  });

  it('closes every resource exactly once in reverse order', async () => {
    const value = fixture();
    const process = createApiProcess(value.dependencies);
    await process.start();

    const first = process.stop();
    const second = process.stop();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await process.stop();

    expect(value.http.close).toHaveBeenCalledOnce();
    expect(value.freshness.close).toHaveBeenCalledOnce();
    expect(value.staticUi.close).toHaveBeenCalledOnce();
    expect(value.dependencies.closeDatabase).toHaveBeenCalledOnce();
    expect(value.trace.slice(-4)).toEqual([
      'http:close',
      'freshness:close',
      'static:close',
      'database:close',
    ]);
  });

  it('waits for in-flight startup and closes a resource that resolves after stop is requested', async () => {
    const pendingFreshness = deferred<ReturnType<typeof fixture>['freshness']>();
    const value = fixture({
      startFreshness: vi.fn(() => pendingFreshness.promise),
    });
    const process = createApiProcess(value.dependencies);
    const starting = process.start();
    await vi.waitFor(() => expect(value.dependencies.startFreshness).toHaveBeenCalledOnce());

    const stopping = process.stop();
    expect(value.dependencies.closeDatabase).not.toHaveBeenCalled();
    pendingFreshness.resolve(value.freshness);

    await expect(starting).rejects.toThrow('stopping or stopped');
    await expect(stopping).resolves.toBeUndefined();
    expect(value.dependencies.createHttp).not.toHaveBeenCalled();
    expect(value.freshness.close).toHaveBeenCalledOnce();
    expect(value.staticUi.close).toHaveBeenCalledOnce();
    expect(value.dependencies.closeDatabase).toHaveBeenCalledOnce();
  });

  it('aborts startup when a shutdown signal arrives during listener registration', async () => {
    let delivered = false;
    const signalListeners = new Map<string, () => void>();
    const value = fixture({
      signals: {
        on: (signal, listener) => {
          signalListeners.set(signal, listener);
          if (signal === 'SIGTERM' && !delivered) {
            delivered = true;
            listener();
          }
        },
        off: (signal, listener) => {
          if (signalListeners.get(signal) === listener) signalListeners.delete(signal);
        },
      },
    });
    const process = createApiProcess(value.dependencies);

    await expect(process.start()).rejects.toThrow('stopping or stopped');
    await process.stop();
    expect(value.http.close).toHaveBeenCalledOnce();
    expect(value.freshness.close).toHaveBeenCalledOnce();
    expect(value.staticUi.close).toHaveBeenCalledOnce();
    expect(value.dependencies.closeDatabase).toHaveBeenCalledOnce();
    expect(signalListeners.size).toBe(0);
  });

  it.each(['SIGTERM', 'SIGINT'] as const)('delegates %s to idempotent shutdown without exiting', async (signal) => {
    const value = fixture();
    const process = createApiProcess(value.dependencies);
    await process.start();

    value.signals.emit(signal);
    value.signals.emit(signal);
    await vi.waitFor(() => expect(value.dependencies.closeDatabase).toHaveBeenCalledOnce());

    expect(value.http.close).toHaveBeenCalledOnce();
    expect(value.freshness.close).toHaveBeenCalledOnce();
    expect(value.staticUi.close).toHaveBeenCalledOnce();
    expect(value.dependencies.onSignalError).not.toHaveBeenCalled();
  });
});
