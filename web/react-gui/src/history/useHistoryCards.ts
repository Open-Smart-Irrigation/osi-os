import useSWR from 'swr';
import { historyAPI } from '../services/api';
import type { HistoryCardSummary, HistoryCardSummaryResponse } from './types';

function cardOrderValue(card: HistoryCardSummary): number {
  return card.ordering.manualOrder ?? card.ordering.recentRank ?? Number.MAX_SAFE_INTEGER;
}

export function orderHistoryCards(cards: HistoryCardSummary[]): HistoryCardSummary[] {
  return [...cards].sort((a, b) => {
    if (a.ordering.pinned !== b.ordering.pinned) {
      return a.ordering.pinned ? -1 : 1;
    }
    if (!a.ordering.pinned && a.ordering.criticalAlert !== b.ordering.criticalAlert) {
      return a.ordering.criticalAlert ? -1 : 1;
    }
    const orderDelta = cardOrderValue(a) - cardOrderValue(b);
    if (orderDelta !== 0) return orderDelta;
    return b.ordering.score - a.ordering.score;
  });
}

export function useHistoryCards(zoneId: number | null, enabled: boolean) {
  const swrKey = enabled && zoneId !== null ? `/api/history/zones/${zoneId}/cards` : null;
  const { data, error, isLoading, mutate } = useSWR<HistoryCardSummaryResponse>(
    swrKey,
    () => historyAPI.getZoneCards(zoneId as number),
    {
      revalidateOnFocus: true,
    },
  );

  const cards = orderHistoryCards(data?.cards ?? []);

  return {
    response: data,
    cards,
    error,
    isLoading,
    refresh: () => mutate(),
  };
}
