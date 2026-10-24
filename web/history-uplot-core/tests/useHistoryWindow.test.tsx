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
  test('removing a source during the initial load aborts it and requests the reduced selection', async () => {
    const first = deferred<HistoryWindowResponse>();
    const second = deferred<HistoryWindowResponse>();
    const load = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce((request: HistoryWindowRequest) => second.promise.then(() => response(request)));
    const { result } = renderHook(() => useHistoryWindow({ enabled: true, context, selectedIds: ['swt-1', 'swt-2'], now: () => 10 * 86_400_000, load }));
    act(() => result.current.selectSources?.(['swt-1']));
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => { second.resolve(response(load.mock.calls[1][0])); await second.promise; });
    expect(result.current.accepted?.series.map((item) => item.id)).toEqual(['swt-1']);
    first.resolve(response(load.mock.calls[0][0]));
  });

  test('retains oversized backing data through 8 to 7 to 8 selection changes', async () => {
    const ids = Array.from({ length: 8 }, (_, index) => `swt-${index + 1}`);
    const load = vi.fn(async (request: HistoryWindowRequest) => response(request, { series: ids.map((id) => ({ id, label: id, unit: 'kPa', points: [{ t: request.from, value: 1 }] })) }));
    const { result } = renderHook(() => useHistoryWindow({ enabled: true, context, selectedIds: ids, now: () => 10 * 86_400_000, load }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const calls = load.mock.calls.length;
    act(() => result.current.selectSources?.(ids.slice(0, 7)));
    act(() => result.current.selectSources?.(ids));
    expect(load).toHaveBeenCalledTimes(calls);
    expect(result.current.accepted?.series).toHaveLength(8);
  });
  test('marks denied sources unavailable and does not resurrect them on re-selection', async () => {
    const load = vi.fn(async (request: HistoryWindowRequest) => response(request, { series: [
      { id: 'swt-1', label: 'Probe 1', unit: 'kPa', points: [{ t: request.from, value: 1 }] },
      { id: 'swt-2', label: 'Probe 2', unit: 'kPa', points: [{ t: request.from, value: 2 }] },
    ] }));
    const { result } = renderHook(() => useHistoryWindow({ enabled: true, context, selectedIds: ['swt-1', 'swt-2'], now: () => 10 * 86_400_000, load }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => result.current.evictSeries?.(['swt-2']));
    act(() => result.current.selectSources?.(['swt-1', 'swt-2']));
    expect(result.current.selectedIds).toEqual(['swt-1']);
    expect(result.current.displayedIds).toEqual(['swt-1']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('replaces accepted backing data instead of unioning a later response', async () => {
    const first = deferred<HistoryWindowResponse>();
    const second = deferred<HistoryWindowResponse>();
    const load = vi.fn()
      .mockImplementationOnce((request: HistoryWindowRequest) => first.promise.then(() => response(request, { series: [{ id: 'swt-1', label: 'one', unit: 'kPa', points: [{ t: request.from, value: 1 }] }] })))
      .mockImplementationOnce((request: HistoryWindowRequest) => second.promise.then(() => response(request, { series: [{ id: 'swt-2', label: 'two', unit: 'kPa', points: [{ t: request.from, value: 2 }] }] })));
    const { result } = renderHook(() => useHistoryWindow({ enabled: true, context, now: () => 10 * 86_400_000, load }));
    await act(async () => { first.resolve(response(load.mock.calls[0][0])); await first.promise; });
    act(() => result.current.moveWindow('back'));
    await act(async () => { second.resolve(response(load.mock.calls[1][0])); await second.promise; });
    expect(result.current.accepted?.series.map((item) => item.id)).toEqual(['swt-2']);
  });
  test('treats intentional empty selection as a no-request state', async () => {
    const load = vi.fn();
    const { result } = renderHook(() => useHistoryWindow({ enabled: true, context, selectedIds: [], now: () => 10 * 86_400_000, load }));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.status).toBe('empty');
    expect(load).not.toHaveBeenCalled();
  });
  test('reports no-finite-data only after complete all-null coverage', async () => {
    const load = vi.fn(async (request: HistoryWindowRequest) => response(request, { series: [{ id: 'swt-1', label: 'Probe 1', unit: 'kPa', points: [{ t: request.from, value: null }, { t: request.to, value: null }] }] }));
    const { result } = renderHook(() => useHistoryWindow({ enabled: true, context, selectedIds: ['swt-1'], now: () => 10 * 86_400_000, load }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.status).toBe('empty');
    expect(result.current.emptyReason).toBe('no-finite-data');
  });
  test('clamps the initial analysis viewport to the supplied seven-day maximum', () => {
    const { result } = renderHook(() => useHistoryWindow({ enabled: false, context, maxSpanMs: 7 * 86_400_000, now: () => 10 * 86_400_000, load: vi.fn() }));
    expect(result.current.viewportStore.get().to - result.current.viewportStore.get().from).toBe(86_400_000);
    result.current.selectPreset('90d');
    expect(result.current.viewportStore.get().to - result.current.viewportStore.get().from).toBe(7 * 86_400_000);
  });
  test('removes a selected series immediately and restores it from backing cache without a request', async () => {
    const load = vi.fn(async (request: HistoryWindowRequest) => response(request, { series: [
      { id: 'swt-1', label: 'Probe 1', unit: 'kPa', points: [{ t: request.from, value: 0 }] },
      { id: 'swt-2', label: 'Probe 2', unit: 'kPa', points: [{ t: request.from, value: 1 }] },
    ] }));
    const { result } = renderHook(() => useHistoryWindow({ enabled: true, context, selectedIds: ['swt-1', 'swt-2'], now: () => 10 * 86_400_000, load }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const calls = load.mock.calls.length;
    act(() => result.current.selectSources?.(['swt-1']));
    expect(result.current.accepted?.series.map((item) => item.id)).toEqual(['swt-1']);
    expect(load).toHaveBeenCalledTimes(calls);
    act(() => result.current.selectSources?.(['swt-1', 'swt-2']));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    expect(result.current.accepted?.series.map((item) => item.id)).toEqual(['swt-1', 'swt-2']);
  });
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

  test('passes ordered selection context to the foreground lane', async () => {
    vi.useFakeTimers();
    try {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      const contexts: unknown[] = [];
      const load = vi.fn(async (request: HistoryWindowRequest, _signal: AbortSignal, loadContext?: { selectedIds: readonly string[] | undefined }) => {
        contexts.push(loadContext?.selectedIds);
        return response(request, { series: ['b', 'a'].map((id) => ({ id, label: id, unit: 'kPa', points: [{ t: request.from, value: 1 }] })) });
      });
      renderHook(() => useHistoryWindow({ enabled: true, context, selectedIds: ['b', 'a'], now: () => 10 * 86_400_000, load }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(contexts).toEqual([['b', 'a']]);
    } finally {
      vi.useRealTimers();
    }
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
