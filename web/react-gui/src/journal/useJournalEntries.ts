import useSWR from 'swr';
import { journalApi } from '../services/journalApi';
import type { EntryAggregate, EntryListFilters } from '../types/journal';

export function useJournalEntries(filters: EntryListFilters, enabled: boolean) {
  const key = enabled ? ['journal:entries', filters] : null;
  const { data, error, isLoading, mutate } = useSWR(
    key,
    () => journalApi.listEntries(filters),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const entries: EntryAggregate[] = data?.entries ?? [];

  return { entries, loading: enabled && isLoading, error, retry: mutate };
}
