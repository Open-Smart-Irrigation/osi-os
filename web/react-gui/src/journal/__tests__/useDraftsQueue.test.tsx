import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listEntries } = vi.hoisted(() => ({ listEntries: vi.fn() }));

vi.mock('../../services/journalApi', () => ({
  journalApi: { listEntries: (filters: any) => listEntries(filters) },
}));

import { useDraftsQueue } from '../useDraftsQueue';

const wrapper = ({ children }: React.PropsWithChildren) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    {children}
  </SWRConfig>
);

describe('useDraftsQueue', () => {
  beforeEach(() => listEntries.mockReset());

  it('does not fetch when disabled', () => {
    const { result } = renderHook(() => useDraftsQueue(false), { wrapper });

    expect(listEntries).not.toHaveBeenCalled();
    expect(result.current.status).toBe('loading');
    expect(result.current.drafts).toEqual([]);
  });

  it('reports loading before the first response resolves', () => {
    listEntries.mockResolvedValue({ entries: [], next_cursor: null });

    const { result } = renderHook(() => useDraftsQueue(true), { wrapper });

    expect(result.current.status).toBe('loading');
  });

  it('requests only server-truth draft-status entries', async () => {
    listEntries.mockResolvedValue({ entries: [], next_cursor: null });

    renderHook(() => useDraftsQueue(true), { wrapper });

    await waitFor(() => expect(listEntries).toHaveBeenCalledWith({ status: 'draft', limit: 100 }));
  });

  it('reports empty when the server has no drafts', async () => {
    listEntries.mockResolvedValue({ entries: [], next_cursor: null });

    const { result } = renderHook(() => useDraftsQueue(true), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('empty'));
    expect(result.current.drafts).toEqual([]);
  });

  it('reports ready with the server drafts once loaded', async () => {
    const draft = { entry_uuid: 'd1', status: 'draft' } as any;
    listEntries.mockResolvedValue({ entries: [draft], next_cursor: null });

    const { result } = renderHook(() => useDraftsQueue(true), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.drafts).toEqual([draft]);
  });

  it('reports error with no drafts when the first load fails', async () => {
    const failure = new Error('offline');
    listEntries.mockRejectedValueOnce(failure).mockResolvedValue({ entries: [], next_cursor: null });

    const { result } = renderHook(() => useDraftsQueue(true), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.drafts).toEqual([]);
    expect(result.current.error).toBe(failure);
  });

  it('reports stale when a refresh fails after a successful load, keeping the cached drafts', async () => {
    const draft = { entry_uuid: 'd1', status: 'draft' } as any;
    const failure = new Error('offline');
    listEntries.mockResolvedValueOnce({ entries: [draft], next_cursor: null });

    const { result } = renderHook(() => useDraftsQueue(true), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    listEntries.mockRejectedValueOnce(failure);
    await act(async () => {
      await result.current.retry().catch(() => undefined);
    });

    await waitFor(() => expect(result.current.status).toBe('stale'));
    expect(result.current.drafts).toEqual([draft]);
    expect(result.current.error).toBe(failure);
  });

  it('recovers to ready after a retry succeeds', async () => {
    const failure = new Error('offline');
    const draft = { entry_uuid: 'd1', status: 'draft' } as any;
    listEntries
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ entries: [draft], next_cursor: null });

    const { result } = renderHook(() => useDraftsQueue(true), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('error'));

    await act(async () => {
      await result.current.retry();
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.drafts).toEqual([draft]);
  });
});
