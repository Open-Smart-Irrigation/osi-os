import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { if (typeof window !== 'undefined' && !window.matchMedia) window.matchMedia = (() => ({ matches: false, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })) as typeof window.matchMedia; });
import { renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { useMobileTensionCatalog } from '../useMobileTensionCatalog';
import { analysisAPI } from '../../services/api';
import { HistoryAuthError, MobileHistoryError } from '@osi/history-uplot';

vi.mock('../../services/api', () => ({ analysisAPI: { getChannels: vi.fn() } }));

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
});
