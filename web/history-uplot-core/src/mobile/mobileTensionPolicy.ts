import type {
  HistoryWindowRequest,
  HistoryWindowResponse,
  MobileAnalysisSeries,
  MobileAnalysisWindow,
  MobileBucket,
  MobileHistoryFailure,
  MobileTensionSource,
  MobileNormalizedResponse,
  SensorSeries,
  Viewport,
} from '../shared/types';
import { HOUR_MS } from '../shared/types';

export const MOBILE_SOURCE_CAP = 25;

export function isEligibleMobileTensionSource(source: MobileTensionSource, zoneId?: string): boolean {
  return source.available && source.legacy !== true && source.unit === 'kPa' && source.measurementKind === 'soil' && /^swt_[123]$/.test(source.channelKey) && (zoneId === undefined || source.zoneId === zoneId) && source.status !== 'other_supported';
}

export function selectMobileTensionSources(catalog: readonly MobileTensionSource[], zoneId: string): MobileTensionSource[] {
  return catalog.filter((source) => isEligibleMobileTensionSource(source, zoneId)).sort((a, b) => a.sourceKey.localeCompare(b.sourceKey) || a.channelKey.localeCompare(b.channelKey) || a.seriesId.localeCompare(b.seriesId)).slice(0, 8);
}

export function reconcileMobileSelection(selectedIds: readonly string[], catalog: readonly MobileTensionSource[], zoneId: string): { selectedIds: string[]; unavailableIds: string[] } {
  const selectable = new Set(catalog.filter((source) => source.available && source.legacy !== true && source.unit === 'kPa' && source.measurementKind === 'soil' && /^swt_[123]$/.test(source.channelKey) && source.zoneId === zoneId).map((source) => source.seriesId));
  return { selectedIds: selectedIds.filter((id) => selectable.has(id)).slice(0, MOBILE_SOURCE_CAP), unavailableIds: selectedIds.filter((id) => !selectable.has(id)) };
}

export function normalizeMobileSeries(series: SensorSeries, invalid: { count: number }): MobileAnalysisSeries {
  const buckets: MobileBucket[] = series.buckets ? series.buckets.map((bucket) => {
    if (bucket.value !== null && (!Number.isFinite(bucket.value) || bucket.value < 0 || bucket.value > 1_000_000)) {
      invalid.count += 1;
      return { ...bucket, value: null, quality: 'invalid' };
    }
    return { ...bucket };
  }) : series.points.map((point, index) => {
    const next = series.points[index + 1]?.t ?? point.t + HOUR_MS;
    const value = point.value;
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1_000_000)) {
      invalid.count += 1;
      return { from: point.t, to: next, value: null, count: 0, quality: 'invalid' };
    }
    return { from: point.t, to: next, value, count: 0, quality: null };
  });
  const finite = buckets.filter((bucket) => bucket.value !== null);
  return { seriesId: series.id, buckets, latestFiniteBucket: finite.length ? finite[finite.length - 1].from : null };
}

export function toMobileAnalysisWindow(response: HistoryWindowResponse, selectedIds: readonly string[] = response.series.map((series) => series.id)): MobileAnalysisWindow {
  const invalid = { count: 0 };
  const selected = new Set(selectedIds);
  return { series: response.series.filter((series) => selected.has(series.id)).map((series) => normalizeMobileSeries(series, invalid)), coverage: response.coverage, complete: !response.limits.truncated && selectedIds.every((id) => response.series.some((series) => series.id === id)), invalidHourlyAverageCount: invalid.count };
}

export function visibleMobileAnalysisEmpty(window: MobileAnalysisWindow, visible: Viewport, selectedIds: readonly string[]): boolean {
  if (!window.complete || selectedIds.length === 0 || window.coverage.from > visible.from || window.coverage.to < visible.to) return false;
  return selectedIds.every((id) => {
    const series = window.series.find((candidate) => candidate.seriesId === id);
    return !series || !series.buckets.some((bucket) => bucket.to > visible.from && bucket.from < visible.to && bucket.value !== null);
  });
}

export function validateMobileResponse(response: HistoryWindowResponse, request: HistoryWindowRequest, selectedIds: readonly string[] = response.series.map((series) => series.id)): HistoryWindowResponse {
  const expected = new Set(selectedIds);
  const actual = response.series.map((series) => series.id);
  if (new Set(actual).size !== actual.length || actual.some((id) => !expected.has(id)) || selectedIds.some((id) => !actual.includes(id))) throw new Error('missing/dropped/unrequested series');
  if (response.limits.truncated || response.aggregation.level !== 'hourly' || response.coverage.from > request.from || response.coverage.to < request.to) throw new Error('invalid mobile history response');
  if (response.series.some((series) => series.unit !== 'kPa' || series.points.some((point) => !Number.isFinite(point.t)))) throw new Error('protocol response');
  return response;
}

export function validateMobileCloudGrid(grid: { from: number; to: number; stepSeconds: number; bucketCount: number }, series: readonly SensorSeries[]): void {
  if (grid.stepSeconds !== 3600 || !Number.isInteger(grid.bucketCount) || grid.bucketCount <= 0 || grid.to !== grid.from + grid.bucketCount * HOUR_MS) throw new Error('invalid cloud hourly grid');
  for (const item of series) {
    if (item.points.length !== grid.bucketCount) throw new Error('invalid cloud bucket count');
    item.points.forEach((point, index) => { if (point.t !== grid.from + index * HOUR_MS) throw new Error('invalid cloud bucket anchor'); });
  }
}

export function validateMobileEdgeGrid(range: { from: number; to: number }, series: readonly SensorSeries[]): void {
  for (const item of series) {
    if (!item.points.length || item.points[0].t !== range.from) throw new Error('invalid edge first anchor');
    for (let index = 1; index < item.points.length; index += 1) {
      const delta = item.points[index].t - item.points[index - 1].t;
      if (delta !== HOUR_MS) throw new Error('invalid edge hourly anchors');
    }
    const finalWidth = range.to - item.points[item.points.length - 1].t;
    if (!(finalWidth > 0 && finalWidth <= HOUR_MS)) throw new Error('invalid edge final bucket');
  }
}

export function normalizeMobileAnalysisResponse(response: HistoryWindowResponse, request: HistoryWindowRequest, selectedIds: readonly string[] = response.series.map((series) => series.id)): MobileNormalizedResponse {
  const normalized = validateMobileResponse(response, request, selectedIds);
  return { response: normalized, window: toMobileAnalysisWindow(normalized, selectedIds) };
}

export function classifyMobileAnalysisFailure(error: unknown): MobileHistoryFailure {
  const candidate = error as { status?: number; code?: string; message?: string } | null;
  if (candidate?.status === 401 || candidate?.status === 403) return { kind: 'auth', status: candidate.status, reason: candidate.status === 401 ? 'authentication expired' : 'access denied' };
  if (candidate?.status === 413 || (candidate?.status === 400 && candidate.code === 'range_too_large')) return { kind: 'size', status: candidate.status, reason: 'range too large' };
  if (candidate?.code === 'missing_id' || candidate?.code === 'dropped_id') return { kind: 'missing', reason: candidate.code };
  if (candidate?.status && candidate.status >= 500) return { kind: 'transient', status: candidate.status, reason: candidate.message ?? 'server unavailable' };
  return { kind: 'protocol', status: candidate?.status, reason: candidate?.message ?? 'invalid history response' };
}
