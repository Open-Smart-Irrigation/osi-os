import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

const { getCatalog, isJournalUnavailable } = vi.hoisted(() => ({
  getCatalog: vi.fn(),
  isJournalUnavailable: vi.fn((e: any) => [404, 501].includes(e?.response?.status)),
}));
vi.mock('../../services/journalApi', () => ({
  journalApi: { getCatalog: () => getCatalog() },
  isJournalUnavailable,
}));

import { loadJournalCatalog, useJournalCatalog } from '../useJournalCatalog';

const wrapper = ({ children }: React.PropsWithChildren) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    {children}
  </SWRConfig>
);

describe('useJournalCatalog', () => {
  beforeEach(() => getCatalog.mockReset());

  it('reports available with the catalog when the probe succeeds', async () => {
    getCatalog.mockResolvedValue({ catalog_version: 1, vocab: [] });
    const { result } = renderHook(() => useJournalCatalog(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.available).toBe(true);
    expect(result.current.unavailable).toBe(false);
    expect(result.current.catalog?.catalog_version).toBe(1);
  });

  it.each([404, 501])('reports unavailable on a %s capability response', async (status) => {
    getCatalog.mockRejectedValueOnce({ response: { status } });
    await expect(loadJournalCatalog()).resolves.toBeNull();

    const { result } = renderHook(
      () => useJournalCatalog(() => Promise.resolve(null)),
      { wrapper },
    );
    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(result.current.available).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  it('keeps operational failures distinct and exposes retry', async () => {
    const failure = { response: { status: 500 } };
    getCatalog.mockRejectedValueOnce(failure).mockResolvedValueOnce({ catalog_version: 1 });
    const { result } = renderHook(() => useJournalCatalog(), { wrapper });
    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(result.current.unavailable).toBe(false);
    await act(async () => { await result.current.retry(); });
    await waitFor(() => expect(result.current.available).toBe(true));
  });
});
