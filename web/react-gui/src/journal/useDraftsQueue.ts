import useSWR from 'swr';
import { journalApi } from '../services/journalApi';
import type { EntryAggregate } from '../types/journal';

export type DraftsQueueStatus = 'loading' | 'error' | 'stale' | 'empty' | 'ready';

export interface UseDraftsQueueResult {
  drafts: EntryAggregate[];
  status: DraftsQueueStatus;
  error: unknown;
  retry: () => Promise<void>;
}

const DRAFTS_QUEUE_LIMIT = 100;

/**
 * "Needs completion" drafts queue: driven ONLY by server status=draft truth
 * (no localStorage, no client-only flag). SWR keeps the last successful
 * `data` around when a revalidation fails, which is what lets this hook
 * distinguish "stale" (had drafts, a refresh just failed) from "error"
 * (never successfully loaded).
 */
export function useDraftsQueue(enabled = true): UseDraftsQueueResult {
  const { data, error, isLoading, mutate } = useSWR(
    enabled ? ['journal:drafts-queue'] : null,
    () => journalApi.listEntries({ status: 'draft', limit: DRAFTS_QUEUE_LIMIT }),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );

  const drafts = data?.entries ?? [];
  const status: DraftsQueueStatus = !enabled || isLoading
    ? 'loading'
    : error != null
      ? (data != null ? 'stale' : 'error')
      : drafts.length === 0
        ? 'empty'
        : 'ready';

  return {
    drafts,
    status,
    error,
    retry: async () => {
      await mutate();
    },
  };
}
