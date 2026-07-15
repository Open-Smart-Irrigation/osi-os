import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listPlots } = vi.hoisted(() => ({ listPlots: vi.fn() }));

vi.mock('../../services/journalApi', () => ({ journalApi: { listPlots } }));

import { useJournalPlots } from '../useJournalPlots';

const wrapper = ({ children }: React.PropsWithChildren) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    {children}
  </SWRConfig>
);

describe('useJournalPlots', () => {
  beforeEach(() => listPlots.mockReset());

  it('does not fetch when disabled', () => {
    renderHook(() => useJournalPlots(false), { wrapper });

    expect(listPlots).not.toHaveBeenCalled();
  });

  it('returns plots when enabled', async () => {
    const plots = [{ plot_uuid: 'p1', plot_code: 'N-1' }];
    listPlots.mockResolvedValue(plots);

    const { result } = renderHook(() => useJournalPlots(true), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.plots).toEqual(plots);
  });

  it('exposes and retries a failed request', async () => {
    const failure = new Error('offline');
    listPlots.mockRejectedValueOnce(failure).mockResolvedValueOnce([]);
    const { result } = renderHook(() => useJournalPlots(true), { wrapper });

    await waitFor(() => expect(result.current.error).toBe(failure));

    await act(async () => {
      await result.current.retry();
    });
    await waitFor(() => expect(result.current.error).toBeUndefined());
    expect(listPlots).toHaveBeenCalledTimes(2);
  });
});
