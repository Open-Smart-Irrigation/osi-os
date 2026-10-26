import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { if (typeof window !== 'undefined' && !window.matchMedia) window.matchMedia = (() => ({ matches: false, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })) as typeof window.matchMedia; });
import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { useMobileTensionCatalog } from '../useMobileTensionCatalog';
import { analysisAPI } from '../../services/api';
import { HistoryAuthError, MobileHistoryError } from '@osi/history-uplot';

vi.mock('../../services/api', () => ({ analysisAPI: { getChannels: vi.fn() } }));

const sourceResponse = (seriesId: string) => ({
  generatedAt: 'now',
  channels: [{ seriesId, hubEui: 'AA', zoneId: 7, zoneName: 'North', cardType: 'soil', sourceKey: `source-${seriesId}`, channelKey: 'swt_1', displayName: seriesId, unit: 'kPa', availability: 'available' as const, deviceName: 'Probe', depthCm: 30, sourceKind: 'device' }],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('edge mobile tension catalog hook', () => {
  beforeEach(() => vi.mocked(analysisAPI.getChannels).mockReset());
  it('fetches one session and zone keyed catalog and refreshes once per generation', async () => {
    vi.mocked(analysisAPI.getChannels).mockResolvedValue({ generatedAt: 'now', channels: [] });
    const wrapper = ({ children }: { children: React.ReactNode }) => <SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false }}>{children}</SWRConfig>;
    const { result } = renderHook(() => useMobileTensionCatalog({ enabled: true, zoneId: '7', sessionKey: 'session-1' }), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await result.current.refreshForGeneration(1);
    await result.current.refreshForGeneration(1);
    expect(analysisAPI.getChannels).toHaveBeenCalledTimes(2);
  });

  it('keeps refreshForGeneration stable across rerenders with the same key', async () => {
    vi.mocked(analysisAPI.getChannels).mockResolvedValue({ generatedAt: 'now', channels: [] });
    const wrapper = ({ children }: { children: React.ReactNode }) => <SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false }}>{children}</SWRConfig>;
    const { result, rerender } = renderHook(() => useMobileTensionCatalog({ enabled: true, zoneId: '7', sessionKey: 'stable' }), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const first = result.current.refreshForGeneration;
    rerender();
    expect(result.current.refreshForGeneration).toBe(first);
  });

  it('returns the shared transient, auth and protocol errors without retrying', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => <SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false }}>{children}</SWRConfig>;
    vi.mocked(analysisAPI.getChannels).mockRejectedValueOnce(Object.assign(new Error('offline'), { isAxiosError: true }));
    const offline = renderHook(() => useMobileTensionCatalog({ enabled: true, zoneId: '7', sessionKey: 'offline' }), { wrapper });
    await waitFor(() => expect(offline.result.current.error).toMatchObject({ failure: { kind: 'transient' } }));
    expect(analysisAPI.getChannels).toHaveBeenCalledTimes(1);

    vi.mocked(analysisAPI.getChannels).mockRejectedValueOnce(Object.assign(new Error('expired'), { isAxiosError: true, response: { status: 401, data: { detail: 'expired' } } }));
    const auth = renderHook(() => useMobileTensionCatalog({ enabled: true, zoneId: '7', sessionKey: 'auth' }), { wrapper });
    await waitFor(() => expect(auth.result.current.error).toBeInstanceOf(HistoryAuthError));

    vi.mocked(analysisAPI.getChannels).mockResolvedValueOnce({ generatedAt: 'now' } as never);
    const malformed = renderHook(() => useMobileTensionCatalog({ enabled: true, zoneId: '7', sessionKey: 'malformed' }), { wrapper });
    await waitFor(() => expect(malformed.result.current.error).toBeInstanceOf(MobileHistoryError));
    expect(malformed.result.current.error).toMatchObject({ failure: { kind: 'protocol', code: 'http-error' } });
  });

  it('deduplicates same-key consumers while separating zone and session keys', async () => {
    const pending = deferred<ReturnType<typeof sourceResponse>>();
    vi.mocked(analysisAPI.getChannels).mockReturnValueOnce(pending.promise);
    const cache = new Map();
    const wrapper = ({ children }: { children: React.ReactNode }) => <SWRConfig value={{ provider: () => cache, revalidateOnFocus: false }}>{children}</SWRConfig>;
    const consumers = renderHook(() => [
      useMobileTensionCatalog({ enabled: true, zoneId: '7', sessionKey: 'same' }),
      useMobileTensionCatalog({ enabled: true, zoneId: '7', sessionKey: 'same' }),
    ], { wrapper });
    expect(analysisAPI.getChannels).toHaveBeenCalledTimes(1);
    pending.resolve(sourceResponse('shared'));
    await waitFor(() => expect(consumers.result.current[0].sources[0]?.seriesId).toBe('shared'));

    vi.mocked(analysisAPI.getChannels).mockResolvedValueOnce(sourceResponse('zone-8'));
    consumers.rerender();
    const zone = renderHook(() => useMobileTensionCatalog({ enabled: true, zoneId: '8', sessionKey: 'same' }), { wrapper });
    await waitFor(() => expect(zone.result.current.isLoading).toBe(false));
    vi.mocked(analysisAPI.getChannels).mockResolvedValueOnce(sourceResponse('session-2'));
    const session = renderHook(() => useMobileTensionCatalog({ enabled: true, zoneId: '7', sessionKey: 'other' }), { wrapper });
    await waitFor(() => expect(session.result.current.isLoading).toBe(false));
    expect(analysisAPI.getChannels).toHaveBeenCalledTimes(3);
  });

  it('keeps a late old-key response out and does not fetch when disabled', async () => {
    const old = deferred<ReturnType<typeof sourceResponse>>();
    const current = deferred<ReturnType<typeof sourceResponse>>();
    vi.mocked(analysisAPI.getChannels).mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise);
    const wrapper = ({ children }: { children: React.ReactNode }) => <SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false }}>{children}</SWRConfig>;
    const hook = renderHook(({ sessionKey }: { sessionKey: string }) => useMobileTensionCatalog({ enabled: true, zoneId: '7', sessionKey }), { initialProps: { sessionKey: 'old' }, wrapper });
    hook.rerender({ sessionKey: 'new' });
    current.resolve(sourceResponse('current'));
    await waitFor(() => expect(hook.result.current.sources[0]?.seriesId).toBe('current'));
    await act(async () => {
      old.resolve(sourceResponse('old'));
      await Promise.resolve();
    });
    await waitFor(() => expect(hook.result.current.sources[0]?.seriesId).toBe('current'));

    const callsBeforeDisabled = vi.mocked(analysisAPI.getChannels).mock.calls.length;
    const disabled = renderHook(() => useMobileTensionCatalog({ enabled: false, zoneId: '7', sessionKey: 'disabled' }), { wrapper });
    expect(disabled.result.current.isLoading).toBe(false);
    expect(disabled.result.current.sources).toEqual([]);
    expect(vi.mocked(analysisAPI.getChannels)).toHaveBeenCalledTimes(callsBeforeDisabled);
  });

  it('resets generation refresh state when the session key changes', async () => {
    vi.mocked(analysisAPI.getChannels).mockResolvedValue({ generatedAt: 'now', channels: [] });
    const wrapper = ({ children }: { children: React.ReactNode }) => <SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false }}>{children}</SWRConfig>;
    const hook = renderHook(({ sessionKey }: { sessionKey: string }) => useMobileTensionCatalog({ enabled: true, zoneId: '7', sessionKey }), { initialProps: { sessionKey: 'one' }, wrapper });
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
    await hook.result.current.refreshForGeneration(3);
    await hook.result.current.refreshForGeneration(3);
    expect(analysisAPI.getChannels).toHaveBeenCalledTimes(2);
    hook.rerender({ sessionKey: 'two' });
    await waitFor(() => expect(analysisAPI.getChannels).toHaveBeenCalledTimes(3));
    await hook.result.current.refreshForGeneration(3);
    await hook.result.current.refreshForGeneration(3);
    expect(analysisAPI.getChannels).toHaveBeenCalledTimes(4);
  });
});
