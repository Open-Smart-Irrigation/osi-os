// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import React from 'react';
import { useAnalysisSeries } from '../useAnalysisSeries';
import { analysisAPI } from '../../services/api';
import type { AnalysisSeriesResponse } from '../types';

vi.mock('../../services/api', () => ({
  analysisAPI: { getSeries: vi.fn() },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

describe('useAnalysisSeries', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not fetch when request is null', () => {
    renderHook(() => useAnalysisSeries(null), { wrapper });
    expect(analysisAPI.getSeries).not.toHaveBeenCalled();
  });

  it('fetches series for a request', async () => {
    const response: AnalysisSeriesResponse = {
      generatedAt: 'now',
      range: { label: '7d', from: 'a', to: 'b', timezone: 'UTC' },
      aggregation: { requested: 'auto', applied: 'hourly', bucketSizeSeconds: 3600 },
      grid: { stepSeconds: 3600, from: 'a', to: 'b', bucketCount: 1 },
      series: [], dropped: [],
    };
    (analysisAPI.getSeries as ReturnType<typeof vi.fn>).mockResolvedValue(response);

    const { result } = renderHook(
      () => useAnalysisSeries({
        selectors: [{ seriesId: 'x' }],
        range: { mode: 'relative', label: '7d', from: null, to: null },
        aggregation: 'auto',
      }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toEqual(response));
    expect(analysisAPI.getSeries).toHaveBeenCalledWith({
      selectors: [{ seriesId: 'x' }],
      range: expect.objectContaining({
        mode: 'absolute',
        label: '7d',
        from: expect.any(String),
        to: expect.any(String),
      }),
      aggregation: 'auto',
    });
    expect(analysisAPI.getSeries).toHaveBeenCalledTimes(1);
  });
});
