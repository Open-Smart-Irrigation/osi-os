import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useHistoryWindow } from '../src/history/useHistoryWindow';
import { analysisHourlyRangeStrategy } from '../src/history/rangeStrategy';
import { createHistoryLoader } from '../src/history/historyLoader';
import type { HistoryLoadContext, HistoryWindowRequest, HistoryWindowResponse } from '../src/shared/types';
const now = () => Date.UTC(2026, 9, 24, 12);
const context = { sessionKey: 'root-session', scopeKey: 'zone:1', cardId: 'mobile-water-tension' };
function data(request: HistoryWindowRequest, ids: readonly string[], count = 24): HistoryWindowResponse {
  return {
    request, readPolicy: 'edge-hourly', coverage: { from: request.from, to: request.to },
    series: ids.map(id => ({ id, label: id, unit: 'kPa',
      points: Array.from({ length: count }, (_, i) => ({ t: request.from + i * (request.to - request.from) / count, value: id === 'null' ? null : 1 })),
      buckets: [{ from: request.from, to: request.to, value: id === 'null' ? null : 1, count, quality: 'ok' }],
    })),
    unitGroups: [{ unit: 'kPa', label: 'kPa', seriesIds: [...ids] }],
    aggregation: { level: 'hourly', pointCount: ids.length * count },
    limits: { maxPointsPerSeries: count, truncated: false },
  };
}
const base = { enabled: true, context, now, navigationStartMs: 0, rangeStrategy: analysisHourlyRangeStrategy, readPolicy: () => 'edge-hourly' as const };
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
afterEach(() => vi.useRealTimers());
describe('root correction verification', () => {
  test('controlled props remove a loaded source immediately without loading', async () => {
    const load = vi.fn(async (r: HistoryWindowRequest, _s: AbortSignal, c?: HistoryLoadContext) => data(r, c!.selectedIds!));
    const { result, rerender } = renderHook(({ ids }) => useHistoryWindow({ ...base, selectedIds: ids, load }), { initialProps: { ids: ['a', 'b'] } });
    await flush(); rerender({ ids: ['a'] });
    expect(load.mock.calls[0][2]?.selectedIds).toEqual(['a', 'b']);
    expect(result.current.accepted?.series.map(s => s.id)).toEqual(['a']);
    expect(load).toHaveBeenCalledTimes(1);
  });
  test('wrong read policy cannot commit a direct response', async () => {
    const load = vi.fn(async (r: HistoryWindowRequest) => ({ ...data(r, ['a']), readPolicy: 'cloud-rollup-hourly' as const }));
    const { result } = renderHook(() => useHistoryWindow({ ...base, selectedIds: ['a'], load }));
    await flush(); expect(result.current.accepted).toBeNull();
  });
  test('zero selection stays request-free through range controls', async () => {
    const load = vi.fn(async (r: HistoryWindowRequest) => data(r, []));
    const { result } = renderHook(() => useHistoryWindow({ ...base, selectedIds: [], load }));
    act(() => result.current.selectPreset('7d')); await flush();
    expect(load).not.toHaveBeenCalled(); expect(result.current.emptyReason).toBe('no-selection');
  });
  test('8-to-7-to-8 retains more than 20000 points after debounce fires', async () => {
    vi.useFakeTimers();
    const ids = Array.from({ length: 8 }, (_, i) => String(i));
    const loader = createHistoryLoader({ now });
    const load = vi.fn(async (r: HistoryWindowRequest, _s: AbortSignal, c?: HistoryLoadContext) => data(r, c!.selectedIds!, 2600));
    const { result } = renderHook(() => useHistoryWindow({ ...base, loader, selectedIds: ids, load }));
    await flush();
    expect(result.current.accepted?.series.reduce((n, s) => n + s.points.length, 0)).toBe(20800);
    expect(loader.diagnostics().entries).toBe(0);
    act(() => result.current.selectSources?.(ids.slice(0, 7)));
    act(() => result.current.selectSources?.(ids));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(load).toHaveBeenCalledTimes(1);
  });
  test('removing the last finite source reveals the loaded empty interval', async () => {
    const load = vi.fn(async (r: HistoryWindowRequest, _s: AbortSignal, c?: HistoryLoadContext) => data(r, c!.selectedIds!));
    const { result } = renderHook(() => useHistoryWindow({ ...base, selectedIds: ['a', 'null'], load }));
    await flush(); act(() => result.current.selectSources?.(['null']));
    expect(result.current.status).toBe('empty'); expect(result.current.emptyReason).toBe('no-finite-data');
  });
  test('removing a pending addition settles loading when retained backing satisfies the selection', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async (r: HistoryWindowRequest, _s: AbortSignal, c?: HistoryLoadContext) => data(r, c!.selectedIds!));
    const { result } = renderHook(() => useHistoryWindow({ ...base, selectedIds: ['a'], load }));
    await flush();
    load.mockImplementationOnce(() => new Promise(() => {}));
    act(() => result.current.selectSources?.(['a', 'b']));
    await act(async () => { await vi.advanceTimersByTimeAsync(151); });
    expect(result.current.refreshing).toBe(true);
    act(() => result.current.selectSources?.(['a']));
    expect(result.current.refreshing).toBe(false);
    expect(result.current.loadingRequest).toBeNull();
  });
  test('excluding a failed addition clears the error when retained backing satisfies the selection', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async (r: HistoryWindowRequest, _s: AbortSignal, c?: HistoryLoadContext) => data(r, c!.selectedIds!));
    const { result } = renderHook(() => useHistoryWindow({ ...base, selectedIds: ['a'], load }));
    await flush();
    load.mockRejectedValueOnce(new Error('source b unavailable'));
    act(() => result.current.selectSources?.(['a', 'b']));
    await act(async () => { await vi.advanceTimersByTimeAsync(151); });
    expect(result.current.error).toBeInstanceOf(Error);
    act(() => result.current.selectSources?.(['a']));
    expect(result.current.error).toBeNull();
    expect(result.current.failedRequest).toBeNull();
  });
  test('zero selection clears a failed addition state', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async (r: HistoryWindowRequest, _s: AbortSignal, c?: HistoryLoadContext) => data(r, c!.selectedIds!));
    const { result } = renderHook(() => useHistoryWindow({ ...base, selectedIds: ['a'], load }));
    await flush();
    load.mockRejectedValueOnce(new Error('source b unavailable'));
    act(() => result.current.selectSources?.(['a', 'b']));
    await act(async () => { await vi.advanceTimersByTimeAsync(151); });
    expect(result.current.failedRequest).not.toBeNull();
    act(() => result.current.selectSources?.([]));
    expect(result.current.status).toBe('empty');
    expect(result.current.emptyReason).toBe('no-selection');
    expect(result.current.error).toBeNull();
    expect(result.current.failedRequest).toBeNull();
  });

});
