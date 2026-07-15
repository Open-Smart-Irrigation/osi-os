import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listEntries } = vi.hoisted(() => ({ listEntries: vi.fn() }));

vi.mock('../../services/journalApi', () => ({
  journalApi: { listEntries: (filters: any) => listEntries(filters) },
}));

import { useJournalEntries } from '../useJournalEntries';

const wrapper = ({ children }: React.PropsWithChildren) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    {children}
  </SWRConfig>
);

describe('useJournalEntries', () => {
  beforeEach(() => listEntries.mockReset());

  it('does not fetch when disabled', () => {
    renderHook(() => useJournalEntries({ status: 'final' }, false), { wrapper });

    expect(listEntries).not.toHaveBeenCalled();
  });

  it('returns entries when enabled', async () => {
    listEntries.mockResolvedValue({ entries: [{ entry_uuid: 'e1' }], next_cursor: null });
    const filters = { status: 'final' as const, limit: 50 };

    const { result } = renderHook(() => useJournalEntries(filters, true), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toHaveLength(1);
    expect(listEntries).toHaveBeenCalledWith(filters);
  });

  it('keeps a failed request distinct from an empty result and retries', async () => {
    const failure = new Error('offline');
    listEntries
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ entries: [], next_cursor: null });
    const { result } = renderHook(
      () => useJournalEntries({ status: 'final' }, true),
      { wrapper },
    );

    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(result.current.entries).toEqual([]);

    await act(async () => {
      await result.current.retry();
    });
    await waitFor(() => expect(result.current.error).toBeUndefined());
    expect(listEntries).toHaveBeenCalledTimes(2);
  });
});
