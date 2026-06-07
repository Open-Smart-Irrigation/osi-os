import useSWR from 'swr';
import { historyAPI } from '../services/api';
import type {
  HistoryAdvancedResponse,
  HistoryCardDataRequest,
} from './types';
import type { HistoryCardDataScope } from './useHistoryCardData';

export interface UseHistoryCardAdvancedDataOptions extends HistoryCardDataRequest {
  scope: HistoryCardDataScope | null;
  cardId: string | null;
  enabled?: boolean;
}

function scopeKey(scope: HistoryCardDataScope): string {
  return scope.type === 'zone' ? `zone:${scope.zoneId}` : `gateway:${scope.gatewayEui}`;
}

function canonicalIsoMinute(value: string | null | undefined): string {
  if (!value) return '';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
}

function getHistoryCardAdvancedDataKey(options: UseHistoryCardAdvancedDataOptions): string | null {
  if (!options.enabled || !options.scope || !options.cardId) return null;

  const { range } = options;
  return [
    'history-card-advanced',
    scopeKey(options.scope),
    options.cardId,
    options.view,
    range.label,
    canonicalIsoMinute(range.from),
    canonicalIsoMinute(range.to),
    range.timezone,
    options.aggregation,
    [...options.overlays].sort().join(','),
    options.sourceKey ?? '',
  ].join('|');
}

function fetchHistoryCardAdvancedData(
  scope: HistoryCardDataScope,
  cardId: string,
  request: HistoryCardDataRequest,
): Promise<HistoryAdvancedResponse> {
  if (scope.type === 'zone') {
    return historyAPI.getZoneCardAdvanced(scope.zoneId, cardId, request);
  }

  return historyAPI.getGatewayCardAdvanced(scope.gatewayEui, cardId, request);
}

export function useHistoryCardAdvancedData(options: UseHistoryCardAdvancedDataOptions) {
  const swrKey = getHistoryCardAdvancedDataKey(options);
  const { data, error, isLoading, mutate } = useSWR<HistoryAdvancedResponse>(
    swrKey,
    () =>
      fetchHistoryCardAdvancedData(options.scope as HistoryCardDataScope, options.cardId as string, {
        view: options.view,
        range: options.range,
        aggregation: options.aggregation,
        overlays: options.overlays,
        sourceKey: options.sourceKey,
      }),
    {
      revalidateOnFocus: false,
      dedupingInterval: 1_500,
    },
  );

  return {
    data,
    error,
    isLoading,
    refresh: mutate,
  };
}
