import { historyAPI } from '../services/api';
import type { HistoryWindowRequest, HistoryWindowResponse } from '@osi/history-uplot';
import type {
  HistoryCardDataRequest,
  HistoryCardDataResponse,
  HistoryRangeLabel,
} from './types';
import type { HistoryCardDataScope } from './useHistoryCardData';

export type MobileHistoryRequest = HistoryWindowRequest;

export type MobileHistoryResponse = HistoryWindowResponse;

export interface MobileSoilHistoryAdapterOptions {
  scope: HistoryCardDataScope;
  cardId: string;
  sourceKey?: string | null;
}

const rangeLabels: Record<MobileHistoryRequest['rangeLabel'], HistoryRangeLabel> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function toEdgeHistoryRequest(request: MobileHistoryRequest, signal: AbortSignal): HistoryCardDataRequest {
  return {
    view: 'line-chart',
    range: { label: rangeLabels[request.rangeLabel], from: iso(request.from), to: iso(request.to), timezone: 'UTC' },
    aggregation: request.aggregation,
    overlays: [],
    signal,
  };
}

function pointTime(value: unknown): number {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function normalizeEdgeHistoryResponse(
  response: HistoryCardDataResponse,
  request: MobileHistoryRequest,
): MobileHistoryResponse {
  const series = response.series.map((item, index) => {
    const id = String(item.id ?? `series-${index}`);
    const label = String(item.label ?? id);
    const unit = String(item.unit ?? '');
    return {
      id,
      label,
      unit,
      points: item.points
        .map((point) => ({ t: pointTime(point.t), value: point.value }))
        .filter((point) => Number.isFinite(point.t)),
    };
  });
  const from = typeof response.range?.from === 'string' && response.range.from.trim() ? Date.parse(response.range.from) : NaN;
  const to = typeof response.range?.to === 'string' && response.range.to.trim() ? Date.parse(response.range.to) : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error('History response returned an invalid range');
  const unitGroups = [...new Set(series.map((item) => item.unit))].map((unit) => ({
    unit,
    label: unit || 'Unspecified',
    seriesIds: series.filter((item) => item.unit === unit).map((item) => item.id),
  }));
  return {
    request,
    coverage: { from, to },
    series,
    unitGroups,
    aggregation: {
      level: response.aggregation.level,
      pointCount: response.aggregation.pointCount,
      coveragePct: response.aggregation.coveragePct,
    },
    limits: { maxPointsPerSeries: response.limits.maxPointsPerSeries, truncated: response.limits.truncated },
    freshness: response.freshness,
  };
}

export function createMobileSoilHistoryLoader(options: MobileSoilHistoryAdapterOptions) {
  return async (request: MobileHistoryRequest, signal: AbortSignal): Promise<MobileHistoryResponse> => {
    const hostRequest = toEdgeHistoryRequest(request, signal);
    hostRequest.sourceKey = options.sourceKey ?? null;
    const response = options.scope.type === 'zone'
      ? await historyAPI.getZoneCardData(options.scope.zoneId, options.cardId, hostRequest)
      : await historyAPI.getGatewayCardData(options.scope.gatewayEui, options.cardId, hostRequest);
    return normalizeEdgeHistoryResponse(response, request);
  };
}
