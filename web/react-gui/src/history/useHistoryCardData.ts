import useSWR from 'swr';
import { historyAPI } from '../services/api';
import type {
  HistoryAggregationLevel,
  HistoryCardDataRequest,
  HistoryCardDataResponse,
  HistoryOverlayId,
  HistoryRangeSelection,
  HistoryViewMode,
} from './types';

export type HistoryCardDataScope =
  | { type: 'zone'; zoneId: number }
  | { type: 'gateway'; gatewayEui: string };

export interface UseHistoryCardDataOptions extends HistoryCardDataRequest {
  scope: HistoryCardDataScope | null;
  cardId: string | null;
  enabled?: boolean;
}

function scopeKey(scope: HistoryCardDataScope): string {
  return scope.type === 'zone' ? `zone:${scope.zoneId}` : `gateway:${scope.gatewayEui}`;
}

function getHistoryCardDataKey(options: UseHistoryCardDataOptions): string | null {
  if (!options.enabled || !options.scope || !options.cardId) return null;

  const { range } = options;
  return [
    'history-card-data',
    scopeKey(options.scope),
    options.cardId,
    options.view,
    range.label,
    range.from ?? '',
    range.to ?? '',
    range.timezone,
    options.aggregation,
    [...options.overlays].sort().join(','),
    options.sourceKey ?? '',
  ].join('|');
}

function fetchHistoryCardData(
  scope: HistoryCardDataScope,
  cardId: string,
  request: HistoryCardDataRequest,
): Promise<HistoryCardDataResponse> {
  if (scope.type === 'zone') {
    return historyAPI.getZoneCardData(scope.zoneId, cardId, request);
  }

  return historyAPI.getGatewayCardData(scope.gatewayEui, cardId, request);
}

export function useHistoryCardData(options: UseHistoryCardDataOptions) {
  const swrKey = getHistoryCardDataKey(options);
  const { data, error, isLoading, mutate } = useSWR<HistoryCardDataResponse>(
    swrKey,
    () =>
      fetchHistoryCardData(options.scope as HistoryCardDataScope, options.cardId as string, {
        view: options.view,
        range: options.range,
        aggregation: options.aggregation,
        overlays: options.overlays,
        sourceKey: options.sourceKey,
      }),
    {
      keepPreviousData: true,
      revalidateOnFocus: true,
    },
  );

  return {
    data,
    error,
    isLoading,
    refresh: mutate,
  };
}
