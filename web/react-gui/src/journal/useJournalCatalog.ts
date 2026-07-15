import useSWR from 'swr';
import { journalApi, isJournalUnavailable } from '../services/journalApi';
import type { JournalCatalog } from '../types/journal';

type JournalCatalogLoader = () => Promise<JournalCatalog | null>;

export async function loadJournalCatalog(): Promise<JournalCatalog | null> {
  try {
    return await journalApi.getCatalog();
  } catch (error) {
    if (isJournalUnavailable(error)) return null;
    throw error;
  }
}

export function useJournalCatalog(loader: JournalCatalogLoader = loadJournalCatalog) {
  const { data, error, isLoading, mutate } = useSWR<JournalCatalog | null>(
    'journal:catalog',
    loader,
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const unavailable = data === null;
  return {
    catalog: data ?? undefined,
    available: data != null,
    unavailable,
    loading: isLoading,
    error,
    retry: async () => (await mutate()) ?? undefined,
  };
}
