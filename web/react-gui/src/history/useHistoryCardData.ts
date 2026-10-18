import useSWR from 'swr';
import { historyAPI } from '../services/api';
import type {
  HistoryCardDataRequest,
  HistoryCardDataResponse,
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

function canonicalIsoMinute(value: string | null | undefined): string {
  if (!value) return '';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
}

function getHistoryCardDataKey(options: UseHistoryCardDataOptions): string | null {
  if (!options.enabled || !options.scope || !options.cardId) return null;

  const { range } = options;
  return [
    'history-card-data-v2',
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

function requestSignature(scope: HistoryCardDataScope, cardId: string, request: HistoryCardDataRequest): string {
  const range = request.range.label === 'custom'
    ? request.range
    : { label: request.range.label, timezone: request.range.timezone };
  return JSON.stringify([scopeKey(scope), cardId, request.view, range, request.aggregation, [...request.overlays].sort(), request.sourceKey ?? null]);
}

async function fetchHistoryCardData(
  scope: HistoryCardDataScope,
  cardId: string,
  request: HistoryCardDataRequest,
): Promise<HistoryCardDataResponse> {
  const response = scope.type === 'zone'
    ? await historyAPI.getZoneCardData(scope.zoneId, cardId, request)
    : await historyAPI.getGatewayCardData(scope.gatewayEui, cardId, request);
  if (response.seriesIdentityVersion !== undefined && response.seriesIdentityVersion !== 2) {
    throw new Error('History data needs an updated gateway or server response (series identity v2).');
  }
  return { ...response, __historyRequestSignature: requestSignature(scope, cardId, request) } as HistoryCardDataResponse;
}

export function useHistoryCardData(options: UseHistoryCardDataOptions) {
  const swrKey = getHistoryCardDataKey(options);
  const request: HistoryCardDataRequest = {
    view: options.view,
    range: options.range,
    aggregation: options.aggregation,
    overlays: options.overlays,
    ...(options.sourceKey === undefined ? {} : { sourceKey: options.sourceKey }),
  };
  const expectedSignature = options.scope && options.cardId ? requestSignature(options.scope, options.cardId, request) : null;
  const { data, error, isLoading, mutate } = useSWR<HistoryCardDataResponse>(
    swrKey,
    () =>
      fetchHistoryCardData(options.scope as HistoryCardDataScope, options.cardId as string, {
        ...request,
      }),
    {
      keepPreviousData: true,
      revalidateOnFocus: false,
      dedupingInterval: 1_500,
    },
  );

  const visibleData = data && ((data as HistoryCardDataResponse & { __historyRequestSignature?: string }).__historyRequestSignature === expectedSignature || !(data as HistoryCardDataResponse & { __historyRequestSignature?: string }).__historyRequestSignature) ? data : undefined;
  return {
    data: visibleData,
    error,
    isLoading,
    refresh: mutate,
  };
}
