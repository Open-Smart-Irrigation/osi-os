import { act, renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { useHistoryWindow } from '../src/history/useHistoryWindow';
import { HistoryAuthError } from '../src/history/types';
import type { HistoryWindowContext, HistoryWindowRequest, HistoryWindowResponse } from '../src/shared/types';

const context: HistoryWindowContext = { sessionKey: 'session-1', scopeKey: 'zone:7', cardId: 'soil', sourceKey: 'swt' };
const response = (request: HistoryWindowRequest, overrides: Partial<HistoryWindowResponse> = {}): HistoryWindowResponse => ({
  request,
  coverage: { from: request.from, to: request.to },
  series: [{ id: 'swt-1', label: 'Probe 1', unit: 'kPa', points: [{ t: request.from, value: 0 }, { t: request.to, value: null }] }],
  unitGroups: [{ unit: 'kPa', label: 'kPa', seriesIds: ['swt-1'] }],
  aggregation: { level: request.aggregation, pointCount: 2 },
  limits: { maxPointsPerSeries: 2_000, truncated: false },
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('useHistoryWindow', () => {
  test('does not load while disabled or without a host context', () => {
    const load = vi.fn();
    const { result } = renderHook(() => useHistoryWindow({ enabled: false, context: null, load }));
    expect(result.current.status).toBe('idle');
    expect(load).not.toHaveBeenCalled();
  });

  test('accepts a partial direct response while the visible demand is still current', async () => {
    const pending = deferred<HistoryWindowResponse>();
    const load = vi.fn((_request: HistoryWindowRequest) => pending.promise);
    const { result } = renderHook(() => useHistoryWindow({ enabled: true, context, now: () => 10 * 86_400_000, load }));
    await act(async () => {
      const request = load.mock.calls[0][0];
      pending.resolve(response(request, { coverage: { from: request.from + 1, to: request.to - 1 }, limits: { maxPointsPerSeries: 2_000, truncated: true } }));
      await pending.promise;
    });
    expect(result.current.accepted?.series).toHaveLength(1);
    expect(result.current.status).toBe('ready');
  });

  test('old context responses cannot repopulate a new session or source', async () => {
    const first = deferred<HistoryWindowResponse>();
    const second = deferred<HistoryWindowResponse>();
    const load = vi.fn()
      .mockImplementationOnce((request: HistoryWindowRequest) => first.promise)
      .mockImplementationOnce((request: HistoryWindowRequest) => second.promise);
    const { result, rerender } = renderHook((value: HistoryWindowContext) => useHistoryWindow({ enabled: true, context: value, now: () => 10 * 86_400_000, load }), { initialProps: context });
    const oldRequest = load.mock.calls[0][0];
    const nextContext = { ...context, sessionKey: 'session-2', sourceKey: 'temp' };
    rerender(nextContext);
    const newRequest = load.mock.calls[1][0];
    await act(async () => {
      first.resolve(response(oldRequest));
      await Promise.resolve();
      expect(result.current.accepted).toBeNull();
      second.resolve(response(newRequest));
      await second.promise;
    });
    expect(result.current.accepted?.request).toEqual(newRequest);
  });

  test('returns auth failures to the host even when the request is current', async () => {
    const auth = new HistoryAuthError(401, 'expired');
    const onAuthError = vi.fn();
    const { result } = renderHook(() => useHistoryWindow({ enabled: true, context, now: () => 10 * 86_400_000, onAuthError, load: async () => { throw auth; } }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(onAuthError).toHaveBeenCalledWith(auth);
    expect(result.current.accepted).toBeNull();
  });

  test('does not report an auth failure from an obsolete session', async () => {
    const first = deferred<HistoryWindowResponse>();
    const second = deferred<HistoryWindowResponse>();
    const onAuthError = vi.fn();
    const load = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { result, rerender } = renderHook((value: HistoryWindowContext) => useHistoryWindow({ enabled: true, context: value, now: () => 10 * 86_400_000, onAuthError, load }), { initialProps: context });
    const oldRequest = load.mock.calls[0][0];
    rerender({ ...context, sessionKey: 'session-2' });
    const newRequest = load.mock.calls[1][0];
    await act(async () => {
      first.reject(new HistoryAuthError(401, 'old session'));
      await Promise.resolve();
      expect(onAuthError).not.toHaveBeenCalled();
      second.resolve(response(newRequest));
      await second.promise;
    });
    expect(result.current.accepted?.request).toEqual(newRequest);
    void oldRequest;
  });

  test('reports current-session auth after a newer visible intent supersedes it', async () => {
    const first = deferred<HistoryWindowResponse>();
    const second = deferred<HistoryWindowResponse>();
    const onAuthError = vi.fn();
    const load = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce((request: HistoryWindowRequest) => second.promise.then(() => response(request)));
    const { result } = renderHook(() => useHistoryWindow({ enabled: true, context, now: () => 10 * 86_400_000, onAuthError, load }));
    act(() => result.current.moveWindow('back'));
    await act(async () => { first.reject(new HistoryAuthError(401, 'current session')); await Promise.resolve(); });
    expect(onAuthError).toHaveBeenCalledTimes(1);
    second.resolve(response(load.mock.calls[1][0]));
  });

  test('keeps accepted data visible during a Latest horizon refresh', async () => {
    let clock = 10 * 86_400_000;
    const first = deferred<HistoryWindowResponse>();
    const latest = deferred<HistoryWindowResponse>();
    const load = vi.fn()
      .mockImplementationOnce((request: HistoryWindowRequest) => first.promise.then(() => response(request)))
      .mockImplementationOnce((request: HistoryWindowRequest) => latest.promise.then(() => response(request)));
    const { result } = renderHook(() => useHistoryWindow({ enabled: true, context, now: () => clock, load }));
    await act(async () => { first.resolve(response(load.mock.calls[0][0])); await first.promise; });
    expect(result.current.accepted).not.toBeNull();
    clock += 60 * 60_000;
    act(() => result.current.showLatest());
    expect(result.current.accepted).not.toBeNull();
    expect(result.current.refreshing).toBe(true);
    await act(async () => { latest.resolve(response(load.mock.calls[1][0])); await latest.promise; });
    expect(result.current.accepted).not.toBeNull();
  });
});
