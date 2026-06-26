import useSWR from 'swr';
import { analysisAPI } from '../services/api';
import type { AnalysisViewRequest, AnalysisViewResponse } from './types';

export function useAnalysisViews(enabled: boolean = true) {
  const { data, error, isLoading, mutate } = useSWR<AnalysisViewResponse[]>(
    enabled ? '/api/analysis/views' : null,
    () => analysisAPI.listViews(),
  );

  const saveView = async (request: AnalysisViewRequest) => {
    const created = await analysisAPI.saveView(request);
    await mutate((current = []) => [created, ...current.filter((view) => view.id !== created.id)], {
      revalidate: false,
    });
    return created;
  };

  return { views: data ?? [], error, isLoading, saveView, refresh: mutate };
}
