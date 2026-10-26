import axios from 'axios';
import {
  HistoryAbortError,
  HistoryAuthError,
  MobileAnalysisValidationError,
  MobileHistoryError,
  mobileHistoryFailureError,
  normalizeMobileAnalysisResponse,
  type HistoryLoadContext,
  type HistoryWindowOptions,
  type HistoryWindowRequest,
  type MobileAnalysisFailureInput,
  type MobileNormalizedResponse,
  type MobileAnalysisResponseDto,
} from '@osi/history-uplot';
import type { AnalysisSeriesRequest, AnalysisSeriesResponse } from '../analysis/types';
import { analysisAPI } from '../services/api';

const HOUR_MS = 60 * 60 * 1000;

function validation(reason: string): MobileAnalysisValidationError {
  return new MobileAnalysisValidationError({ kind: 'protocol', code: 'invalid-selection-count', reason });
}

export function buildMobileAnalysisRequest(
  ids: readonly string[],
  logical: HistoryWindowRequest,
): AnalysisSeriesRequest | null {
  if (ids.length === 0) return null;
  if (ids.length > 25 || new Set(ids).size !== ids.length) throw validation('mobile tension selection must contain between 1 and 25 distinct sources');
  const from = Math.floor(logical.from / HOUR_MS) * HOUR_MS;
  const to = Math.ceil(logical.to / HOUR_MS) * HOUR_MS;
  return {
    selectors: ids.map((seriesId) => ({ seriesId })),
    range: { mode: 'custom', label: logical.to - logical.from <= 24 * HOUR_MS ? '24h' : '7d', from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    aggregation: 'hourly',
  };
}

function toDto(raw: AnalysisSeriesResponse, load: HistoryLoadContext): MobileAnalysisResponseDto {
  return {
    readPolicy: load.readPolicy as Exclude<HistoryLoadContext['readPolicy'], 'card-default'>,
    coverage: { from: Date.parse(raw.range.from), to: Date.parse(raw.range.to) },
    appliedAggregation: raw.aggregation.applied,
    truncated: raw.series.some((series) => series.truncated),
    dropped: raw.dropped.map((item) => ({ seriesId: item.seriesId, reason: item.reason })),
    grid: { platform: 'edge', from: Date.parse(raw.range.from), to: Date.parse(raw.range.to) },
    series: raw.series.map((series) => ({
      seriesId: series.seriesId,
      label: series.label,
      unit: series.unit ?? '',
      truncated: series.truncated,
      points: series.points.map((point) => ({ at: Date.parse(point.t), value: point.value, count: point.count, quality: point.quality })),
    })),
  };
}

export function adaptMobileAnalysisResponse(
  raw: AnalysisSeriesResponse,
  logical: HistoryWindowRequest,
  load: HistoryLoadContext,
): MobileNormalizedResponse {
  const dto = toDto(raw, load);
  return normalizeMobileAnalysisResponse(dto, { ...logical, readPolicy: load.readPolicy }, load.selectedIds ?? []);
}

function nonblank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function toMobileFailureInput(error: unknown): MobileAnalysisFailureInput {
  if (axios.isAxiosError(error)) {
    const response = error.response;
    if (!response) return { kind: 'network', message: error.message || 'network request failed' };
    const data = response.data && typeof response.data === 'object' ? response.data as Record<string, unknown> : {};
    const code = nonblank(data.code) ?? nonblank(data.detail) ?? nonblank(data.error);
    const message = nonblank(data.detail) ?? nonblank(data.message) ?? nonblank(data.error) ?? error.message;
    return { kind: 'http', status: response.status, code, message: message || 'HTTP request failed' };
  }
  return { kind: 'network', message: error instanceof Error && error.message ? error.message : 'network request failed' };
}

function isAxiosCancellation(error: unknown): boolean {
  return axios.isCancel(error) || (axios.isAxiosError(error) && error.code === 'ERR_CANCELED');
}

function rethrowMobileAnalysisError(error: unknown, signal: AbortSignal): never {
  if (signal.aborted || error instanceof HistoryAbortError || isAxiosCancellation(error)) throw error;
  if (error instanceof HistoryAuthError || error instanceof MobileHistoryError) throw error;
  if (error instanceof MobileAnalysisValidationError) throw mobileHistoryFailureError(error);
  if (axios.isAxiosError(error)) throw mobileHistoryFailureError(toMobileFailureInput(error), error);
  const reason = error instanceof Error && error.message ? error.message : 'unexpected mobile Analysis failure';
  throw new MobileHistoryError({ kind: 'protocol', code: 'http-error', reason }, error);
}

function requireLoadContext(load: HistoryLoadContext | undefined): HistoryLoadContext & { selectedIds: readonly string[]; readPolicy: Exclude<HistoryLoadContext['readPolicy'], 'card-default'> } {
  if (!load || load.selectedIds === undefined) throw validation('mobile tension loader requires selected source IDs');
  if (load.selectedIds.length === 0) throw validation('no mobile tension sources selected');
  if (load.readPolicy !== 'edge-hourly') throw new MobileAnalysisValidationError({ kind: 'protocol', code: 'unexpected-read-policy', reason: 'edge mobile analysis requires edge-hourly read policy' });
  return load as HistoryLoadContext & { selectedIds: readonly string[]; readPolicy: Exclude<HistoryLoadContext['readPolicy'], 'card-default'> };
}

export function createMobileAnalysisLoader(): HistoryWindowOptions['load'] {
  return async (logical, signal, loadContext) => {
    try {
      const load = requireLoadContext(loadContext);
      const request = buildMobileAnalysisRequest(load.selectedIds, logical);
      if (!request) throw validation('no mobile tension sources selected');
      const raw = await analysisAPI.getSeries(request, { signal });
      return adaptMobileAnalysisResponse(raw, logical, load).response;
    } catch (error) {
      rethrowMobileAnalysisError(error, signal);
    }
  };
}
