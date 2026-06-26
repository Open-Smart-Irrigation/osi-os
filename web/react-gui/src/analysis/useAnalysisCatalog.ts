import useSWR from 'swr';
import { analysisAPI } from '../services/api';
import type { AnalysisCatalogResponse } from './types';

export function useAnalysisCatalog(enabled: boolean = true) {
  const { data, error, isLoading, mutate } = useSWR<AnalysisCatalogResponse>(
    enabled ? 'analysis-catalog' : null,
    () => analysisAPI.getChannels(),
  );
  return { catalog: data, error, isLoading, refresh: mutate };
}
