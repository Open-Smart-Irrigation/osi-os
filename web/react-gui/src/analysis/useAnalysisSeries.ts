import useSWR from 'swr';
import { analysisAPI } from '../services/api';
import type { AnalysisSeriesRequest, AnalysisSeriesResponse } from './types';
import { resolveAnalysisRangeForRequest } from './range';

function seriesKey(request: AnalysisSeriesRequest | null): string | null {
  if (!request || request.selectors.length === 0) return null;
  return [
    'analysis-series',
    request.selectors.map((s) => s.seriesId).sort().join(','),
    request.range.label,
    request.range.from ?? '',
    request.range.to ?? '',
    request.aggregation,
  ].join('|');
}

export function useAnalysisSeries(request: AnalysisSeriesRequest | null) {
  const { data, error, isLoading } = useSWR<AnalysisSeriesResponse>(
    seriesKey(request),
    () => analysisAPI.getSeries({
      ...(request as AnalysisSeriesRequest),
      range: resolveAnalysisRangeForRequest((request as AnalysisSeriesRequest).range),
    }),
    { revalidateOnFocus: false },
  );
  return { data, error, isLoading };
}
