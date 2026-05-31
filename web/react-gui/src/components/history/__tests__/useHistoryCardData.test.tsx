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

describe('useHistoryCardData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(historyAPI.getZoneCardData).mockResolvedValue({
      cardId: 'soil-zone-1',
      cardType: 'soil',
      view: 'soil-profile',
      range,
      aggregation: {
        level: 'hourly',
        bucketSizeSeconds: 3600,
        coveragePct: 91,
        coverageConfidence: 'configured',
        pointCount: 42,
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
      freshness: { dataAsOf: '2026-05-31T12:00:00.000Z', syncState: 'local' },
      advancedFields: {},
    });
  });

  it('keys card data by zone scope, card, view, range, aggregation, and overlays', async () => {
    const { result, rerender } = renderHook(
      ({ overlays }: { overlays: readonly HistoryOverlayId[] }) =>
        useHistoryCardData({
          scope: { type: 'zone', zoneId: 1 },
          cardId: 'soil-zone-1',
          view: 'soil-profile',
          range,
          aggregation: 'hourly',
          overlays,
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

    rerender({ overlays: ['data-gaps', 'rain-events'] });
    await waitFor(() => expect(historyAPI.getZoneCardData).toHaveBeenCalledTimes(2));
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
});
