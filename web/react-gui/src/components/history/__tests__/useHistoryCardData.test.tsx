import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { SWRConfig } from 'swr';

import { useHistoryCardData } from '../../../history/useHistoryCardData';
import { historyAPI } from '../../../services/api';
import type { HistoryOverlayId, HistoryRangeSelection } from '../../../history/types';

vi.mock('../../../services/api', () => ({
  historyAPI: {
    getZoneCardData: vi.fn(),
    getGatewayCardData: vi.fn(),
  },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, errorRetryCount: 0 }}>
    {children}
  </SWRConfig>
);

const range: HistoryRangeSelection = {
  label: '7d',
  from: '2026-05-24T12:00:00.000Z',
  to: '2026-05-31T12:00:00.000Z',
  timezone: 'UTC',
};

function makeResponse(
  responseRange: HistoryRangeSelection,
  pointCount: number,
): Awaited<ReturnType<typeof historyAPI.getZoneCardData>> {
  return {
    cardId: 'soil-zone-1',
    cardType: 'soil',
    view: 'soil-profile',
    range: responseRange,
    aggregation: {
      level: 'hourly',
      bucketSizeSeconds: 3600,
      coveragePct: 91,
      coverageConfidence: 'configured',
      pointCount,
    },
    limits: {
      maxPointsPerSeries: 1000,
      maxEvents: 100,
      maxInterpretations: 20,
      truncated: false,
    },
    series: [],
    profiles: [],
    events: [],
    calendar: null,
    interpretations: [],
    freshness: { dataAsOf: responseRange.to ?? null, syncState: 'local' },
    advancedFields: {},
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('useHistoryCardData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(historyAPI.getZoneCardData).mockResolvedValue(makeResponse(range, 42));
  });

  it('keys card data by zone scope, card, view, range, aggregation, and overlays', async () => {
    const { result, rerender } = renderHook(
      ({ overlays, sourceKey }: { overlays: readonly HistoryOverlayId[]; sourceKey?: string | null }) =>
        useHistoryCardData({
          scope: { type: 'zone', zoneId: 1 },
          cardId: 'soil-zone-1',
          view: 'soil-profile',
          range,
          aggregation: 'hourly',
          overlays,
          sourceKey,
          enabled: true,
        }),
      {
        wrapper,
        initialProps: { overlays: ['data-gaps'] },
      },
    );

    await waitFor(() => expect(result.current.data?.aggregation.level).toBe('hourly'));
    expect(historyAPI.getZoneCardData).toHaveBeenCalledWith(1, 'soil-zone-1', {
      view: 'soil-profile',
      range,
      aggregation: 'hourly',
      overlays: ['data-gaps'],
    });

    rerender({ overlays: ['data-gaps', 'rain-events'], sourceKey: undefined });
    await waitFor(() => expect(historyAPI.getZoneCardData).toHaveBeenCalledTimes(2));
  });

  it('keys and requests card data by selected source key', async () => {
    const { rerender } = renderHook(
      ({ sourceKey }: { sourceKey?: string | null }) =>
        useHistoryCardData({
          scope: { type: 'zone', zoneId: 1 },
          cardId: 'soil-zone-1',
          view: 'soil-profile',
          range,
          aggregation: 'hourly',
          overlays: [],
          sourceKey,
          enabled: true,
        }),
      {
        wrapper,
        initialProps: { sourceKey: 'soil-source-1' },
      },
    );

    await waitFor(() => expect(historyAPI.getZoneCardData).toHaveBeenCalledTimes(1));
    expect(historyAPI.getZoneCardData).toHaveBeenLastCalledWith(1, 'soil-zone-1', {
      view: 'soil-profile',
      range,
      aggregation: 'hourly',
      overlays: [],
      sourceKey: 'soil-source-1',
    });

    rerender({ sourceKey: 'soil-source-2' });

    await waitFor(() => expect(historyAPI.getZoneCardData).toHaveBeenCalledTimes(2));
    expect(historyAPI.getZoneCardData).toHaveBeenLastCalledWith(1, 'soil-zone-1', {
      view: 'soil-profile',
      range,
      aggregation: 'hourly',
      overlays: [],
      sourceKey: 'soil-source-2',
    });
  });

  it('does not request card data outside an enabled scope', () => {
    renderHook(
      () =>
        useHistoryCardData({
          scope: null,
          cardId: 'soil-zone-1',
          view: 'soil-profile',
          range,
          aggregation: 'hourly',
          overlays: [],
          enabled: true,
        }),
      { wrapper },
    );

    expect(historyAPI.getZoneCardData).not.toHaveBeenCalled();
    expect(historyAPI.getGatewayCardData).not.toHaveBeenCalled();
  });

  it('keeps previous data visible while a changed range refetches', async () => {
    const nextRange: HistoryRangeSelection = {
      label: 'custom',
      from: '2026-05-30T00:00:00.000Z',
      to: '2026-05-31T00:00:00.000Z',
      timezone: 'UTC',
    };
    const pendingSecondFetch = deferred<Awaited<ReturnType<typeof historyAPI.getZoneCardData>>>();
    vi.mocked(historyAPI.getZoneCardData)
      .mockResolvedValueOnce(makeResponse(range, 42))
      .mockReturnValueOnce(pendingSecondFetch.promise);

    const { result, rerender } = renderHook(
      ({ selectedRange }: { selectedRange: HistoryRangeSelection }) =>
        useHistoryCardData({
          scope: { type: 'zone', zoneId: 1 },
          cardId: 'soil-zone-1',
          view: 'soil-profile',
          range: selectedRange,
          aggregation: 'hourly',
          overlays: [],
          enabled: true,
        }),
      {
        wrapper,
        initialProps: { selectedRange: range },
      },
    );

    await waitFor(() => expect(result.current.data?.aggregation.pointCount).toBe(42));

    rerender({ selectedRange: nextRange });

    await waitFor(() => expect(historyAPI.getZoneCardData).toHaveBeenCalledTimes(2));
    expect(result.current.data?.aggregation.pointCount).toBe(42);

    pendingSecondFetch.resolve(makeResponse(nextRange, 7));
    await waitFor(() => expect(result.current.data?.aggregation.pointCount).toBe(7));
  });
});
