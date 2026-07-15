import useSWR from 'swr';
import { journalApi } from '../services/journalApi';
import type { JournalPlot } from '../types/journal';

export function useJournalPlots(enabled: boolean) {
  const { data, error, isLoading, mutate } = useSWR<JournalPlot[]>(
    enabled ? 'journal:plots' : null,
    () => journalApi.listPlots(),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );

  return {
    plots: data ?? [],
    loading: enabled && isLoading,
    error,
    retry: mutate,
  };
}
