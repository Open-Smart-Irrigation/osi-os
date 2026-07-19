import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listEntries } = vi.hoisted(() => ({ listEntries: vi.fn() }));

vi.mock('../../../services/journalApi', () => ({
  journalApi: { listEntries: (filters: any) => listEntries(filters) },
}));

import { useJournalMarkers } from '../useJournalMarkers';

const wrapper = ({ children }: React.PropsWithChildren) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    {children}
  </SWRConfig>
);

const FROM_MS = Date.parse('2026-07-01T00:00:00.000Z');
const TO_MS = Date.parse('2026-07-02T00:00:00.000Z');

function baseEntry(overrides: Record<string, unknown> = {}) {
  return {
    entry_uuid: 'e1',
    activity_code: 'irrigation',
    occurred_start: '2026-07-01T06:00:00.000Z',
    occurred_end: null,
    plot_uuid: 'plot-1',
    zone_uuid: 'zone-1',
    note: null,
    status: 'final',
    ...overrides,
  };
}

describe('useJournalMarkers', () => {
  beforeEach(() => listEntries.mockReset());

  it('does not fetch when disabled', () => {
    renderHook(
      () => useJournalMarkers({ zoneUuid: 'zone-1', fromMs: FROM_MS, toMs: TO_MS, enabled: false }),
      { wrapper },
    );

    expect(listEntries).not.toHaveBeenCalled();
  });

  it('does not fetch when zoneUuid is missing, even if enabled', () => {
    renderHook(
      () => useJournalMarkers({ zoneUuid: null, fromMs: FROM_MS, toMs: TO_MS, enabled: true }),
      { wrapper },
    );

    expect(listEntries).not.toHaveBeenCalled();
  });

  it('requests only FINAL entries scoped to the zone and the visible window', async () => {
    listEntries.mockResolvedValue({ entries: [], next_cursor: null });

    renderHook(
      () => useJournalMarkers({ zoneUuid: 'zone-1', fromMs: FROM_MS, toMs: TO_MS, enabled: true }),
      { wrapper },
    );

    await waitFor(() => expect(listEntries).toHaveBeenCalled());
    expect(listEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        zone_uuid: 'zone-1',
        status: 'final',
        occurred_from: new Date(FROM_MS).toISOString(),
        occurred_to: new Date(TO_MS).toISOString(),
      }),
    );
  });

  it('normalizes a returned entry into a marker with parsed timestamps', async () => {
    listEntries.mockResolvedValue({
      entries: [baseEntry({ entry_uuid: 'e1', activity_code: 'fertigation', note: 'Top-dressed north block' })],
      next_cursor: null,
    });

    const { result } = renderHook(
      () => useJournalMarkers({ zoneUuid: 'zone-1', fromMs: FROM_MS, toMs: TO_MS, enabled: true }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.markers).toEqual([
      expect.objectContaining({
        entryUuid: 'e1',
        activityCode: 'fertigation',
        occurredAtMs: Date.parse('2026-07-01T06:00:00.000Z'),
        note: 'Top-dressed north block',
        plotUuid: 'plot-1',
      }),
    ]);
  });

  it('drops entries whose occurred_start cannot be parsed', async () => {
    listEntries.mockResolvedValue({
      entries: [baseEntry({ entry_uuid: 'bad', occurred_start: 'not-a-date' })],
      next_cursor: null,
    });

    const { result } = renderHook(
      () => useJournalMarkers({ zoneUuid: 'zone-1', fromMs: FROM_MS, toMs: TO_MS, enabled: true }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.markers).toEqual([]);
  });

  it('keyset-pages through every cursor and combines all entries into one marker list', async () => {
    listEntries
      .mockResolvedValueOnce({ entries: [baseEntry({ entry_uuid: 'e1' })], next_cursor: 'cursor-1' })
      .mockResolvedValueOnce({ entries: [baseEntry({ entry_uuid: 'e2' })], next_cursor: 'cursor-2' })
      .mockResolvedValueOnce({ entries: [baseEntry({ entry_uuid: 'e3' })], next_cursor: null });

    const { result } = renderHook(
      () => useJournalMarkers({ zoneUuid: 'zone-1', fromMs: FROM_MS, toMs: TO_MS, enabled: true }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(listEntries).toHaveBeenCalledTimes(3);
    expect(listEntries.mock.calls[1][0]).toEqual(expect.objectContaining({ cursor: 'cursor-1' }));
    expect(listEntries.mock.calls[2][0]).toEqual(expect.objectContaining({ cursor: 'cursor-2' }));
    expect(result.current.markers.map((m) => m.entryUuid)).toEqual(['e1', 'e2', 'e3']);
  });

  it('stops paging at a bounded number of requests even if the server keeps returning a cursor', async () => {
    let callCount = 0;
    listEntries.mockImplementation(() => {
      callCount += 1;
      return Promise.resolve({
        entries: [baseEntry({ entry_uuid: `e-${callCount}` })],
        next_cursor: `cursor-${callCount}`,
      });
    });

    const { result } = renderHook(
      () => useJournalMarkers({ zoneUuid: 'zone-1', fromMs: FROM_MS, toMs: TO_MS, enabled: true }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    // A runaway server must not cause an unbounded number of requests or an unbounded marker list.
    expect(listEntries.mock.calls.length).toBeLessThan(100);
    expect(result.current.markers.length).toBeLessThan(10_000);
  });

  it('keeps a failed request distinct from an empty result and retries', async () => {
    const failure = new Error('offline');
    listEntries
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ entries: [], next_cursor: null });

    const { result } = renderHook(
      () => useJournalMarkers({ zoneUuid: 'zone-1', fromMs: FROM_MS, toMs: TO_MS, enabled: true }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(result.current.markers).toEqual([]);

    await act(async () => {
      await result.current.retry();
    });
    await waitFor(() => expect(result.current.error).toBeUndefined());
  });

  it('re-fetches when the zone changes', async () => {
    listEntries.mockResolvedValue({ entries: [], next_cursor: null });

    const { rerender } = renderHook(
      ({ zoneUuid }: { zoneUuid: string }) =>
        useJournalMarkers({ zoneUuid, fromMs: FROM_MS, toMs: TO_MS, enabled: true }),
      { wrapper, initialProps: { zoneUuid: 'zone-1' } },
    );

    await waitFor(() => expect(listEntries).toHaveBeenCalledTimes(1));

    rerender({ zoneUuid: 'zone-2' });

    await waitFor(() => expect(listEntries).toHaveBeenCalledTimes(2));
    expect(listEntries.mock.calls[1][0]).toEqual(expect.objectContaining({ zone_uuid: 'zone-2' }));
  });
});
