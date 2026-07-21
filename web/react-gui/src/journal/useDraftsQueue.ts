import useSWR, { mutate as globalMutate } from 'swr';
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

// Exported so any component that changes draft state from OUTSIDE this
// hook's own SWR subscription (see refreshDraftsQueue below) can invalidate
// the exact same cache entry, rather than duplicating the key literal.
export const DRAFTS_QUEUE_SWR_KEY = ['journal:drafts-queue'] as const;

// P2-d: the drafts queue owns its own independent SWR cache (by design — see
// the hook doc below), so nothing tells it to refetch when a draft is
// created or finalized elsewhere on the page (e.g. the desktop capture-flow
// modal, whose own save/close only revalidates the entry TABLE's separate
// query — see JournalWorkspace.tsx's retryEntries). Left alone, a newly
// autosaved draft never appears here until an unrelated revalidation (a
// fresh page load), which reads as "the queue is broken". Call this after
// any capture-flow session ends so a fresh draft — or a draft that just got
// finalized and should now disappear — shows up without a reload.
export function refreshDraftsQueue(): Promise<unknown> {
  return globalMutate(DRAFTS_QUEUE_SWR_KEY).catch(() => undefined);
}

/**
 * "Needs completion" drafts queue: driven ONLY by server status=draft truth
 * (no localStorage, no client-only flag). SWR keeps the last successful
 * `data` around when a revalidation fails, which is what lets this hook
 * distinguish "stale" (had drafts, a refresh just failed) from "error"
 * (never successfully loaded).
 */
export function useDraftsQueue(enabled = true): UseDraftsQueueResult {
  const { data, error, isLoading, mutate } = useSWR(
    enabled ? DRAFTS_QUEUE_SWR_KEY : null,
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
