import type {
  HistoryWindowRequest,
  HistoryWindowResponse,
  MobileAnalysisSeries,
  MobileAnalysisWindow,
  MobileBucket,
  MobileHistoryFailure,
  MobileTensionSource,
  MobileNormalizedResponse,
  MobileAnalysisResponseDto,
  MobileProtocolFailureCode,
  MobileAnalysisFailureInput,
  SensorSeries,
  Viewport,
} from '../shared/types';
import { MobileAnalysisValidationError } from '../shared/types';
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
  const buckets: MobileBucket[] = (series.buckets ?? []).map((bucket) => {
    if (bucket.value !== null && (!Number.isFinite(bucket.value) || bucket.value < 0 || bucket.value > 1_000_000)) {
      invalid.count += 1;
      return { ...bucket, value: null, quality: 'invalid' };
    }
    if (bucket.value === null && bucket.quality === 'invalid') invalid.count += 1;
    return { ...bucket };
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

function protocol(code: MobileProtocolFailureCode, reason: string): never { throw new MobileAnalysisValidationError({ kind: 'protocol', code, reason }); }

/** Compatibility guard for callers that already hold a normalized history response. */
export function validateMobileResponse(response: HistoryWindowResponse, request: HistoryWindowRequest, selectedIds: readonly string[] = response.series.map((series) => series.id)): HistoryWindowResponse {
  const expected = new Set(selectedIds);
  const actual = response.series.map((series) => series.id);
  if (new Set(actual).size !== actual.length) protocol('duplicate-series', 'response contains duplicate series');
  if (actual.some((id) => !expected.has(id))) protocol('unrequested-series', 'response contains an unrequested series');
  if (selectedIds.some((id) => !actual.includes(id))) protocol('missing-series', 'response is missing a selected series');
  if (response.limits.truncated || response.aggregation.level !== 'hourly' || response.coverage.from > request.from || response.coverage.to < request.to) protocol('invalid-coverage', 'response coverage or completeness is invalid');
  if (response.series.some((series) => series.unit !== 'kPa' || series.points.some((point) => !Number.isFinite(point.t)))) protocol('invalid-timestamp', 'response contains an invalid point');
  return response;
}

export function normalizeMobileAnalysisResponse(dto: MobileAnalysisResponseDto, request: HistoryWindowRequest, selectedIds: readonly string[]): MobileNormalizedResponse {
  if (selectedIds.length < 1 || selectedIds.length > 25) protocol('invalid-selection-count', 'selected source count must be between 1 and 25');
  const policy = request.readPolicy;
  if (policy !== dto.readPolicy) protocol('unexpected-read-policy', 'response read policy does not match request');
  if (dto.appliedAggregation !== 'hourly') protocol('invalid-aggregation', 'response aggregation is not hourly');
  if (dto.truncated || dto.series.some((series) => series.truncated)) protocol('response-truncated', 'response is truncated');
  if (![dto.coverage.from, dto.coverage.to, dto.grid.from, dto.grid.to].every(Number.isFinite) || dto.coverage.from > request.from || dto.coverage.to < request.to || dto.grid.from > request.from || dto.grid.to < request.to) protocol('invalid-coverage', 'response coverage does not enclose request');
  const expected = new Set(selectedIds);
  const actual = dto.series.map((series) => series.seriesId);
  if (dto.dropped.some((item) => typeof item.seriesId !== 'string' || item.seriesId.trim() === '')) protocol('unrequested-series', 'response contains a dropped series without a series ID');
  const duplicates = new Set(actual.filter((id, index) => actual.indexOf(id) !== index));
  if (duplicates.size) protocol('duplicate-series', 'response contains duplicate series');
  if (actual.some((id) => !expected.has(id))) protocol('unrequested-series', 'response contains an unrequested series');
  const missing = selectedIds.filter((id) => !actual.includes(id));
  const dropped = dto.dropped as Array<{ seriesId: string; reason: string }>;
  const selectedDropped = dropped.filter((item) => expected.has(item.seriesId));
  if (missing.length || selectedDropped.length) {
    const accessDeniedIds = selectedDropped.filter((item) => item.reason === 'access_denied').map((item) => item.seriesId);
    const failure: Extract<MobileHistoryFailure, { kind: 'sources' }> = { kind: 'sources', missingIds: missing, dropped: selectedDropped, accessDeniedIds, reason: 'selected sources are missing or dropped' };
    throw new MobileAnalysisValidationError(failure);
  }
  if (dto.grid.platform === 'cloud') {
    if (dto.grid.stepSeconds !== 3600 || !Number.isInteger(dto.grid.bucketCount) || dto.grid.bucketCount <= 0 || dto.grid.to !== dto.grid.from + dto.grid.bucketCount * HOUR_MS) protocol('invalid-cloud-grid', 'cloud hourly grid is malformed');
  }
  const invalid = { count: 0 };
  const series = dto.series.map((item) => {
    if (item.unit !== 'kPa') protocol('invalid-unit', 'response unit is not kPa');
    const points: Array<{ t: number; value: number | null }> = [];
    const buckets: MobileBucket[] = [];
    item.points.forEach((point, index) => {
      if (!Number.isFinite(point.at)) protocol('invalid-timestamp', 'response timestamp is not finite');
      if (!Number.isInteger(point.count) || point.count < 0) protocol('invalid-timestamp', 'response point count is invalid');
      const from = point.at;
      const to = dto.grid.platform === 'cloud' ? from + HOUR_MS : (item.points[index + 1]?.at ?? dto.grid.to);
      if (!(to > from && to - from <= HOUR_MS)) protocol(dto.grid.platform === 'cloud' ? 'invalid-cloud-grid' : 'invalid-edge-grid', 'response bucket interval is malformed');
      let value = point.value;
      let quality = point.quality;
      if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1_000_000)) { value = null; quality = 'invalid'; invalid.count += 1; }
      points.push({ t: from, value });
      buckets.push({ from, to, value, count: point.count, quality });
    });
    if (dto.grid.platform === 'cloud') {
      if (item.points.length !== dto.grid.bucketCount || item.points.some((point, index) => point.at !== dto.grid.from + index * HOUR_MS)) protocol('invalid-cloud-grid', 'cloud grid anchors are malformed');
    } else if (!item.points.length || item.points[0].at !== dto.grid.from || item.points.some((point, index) => index > 0 && point.at !== item.points[index - 1].at + HOUR_MS) || buckets[buckets.length - 1]?.to !== dto.grid.to) protocol('invalid-edge-grid', 'edge grid anchors are malformed');
    return { id: item.seriesId, label: item.label, unit: item.unit, points, buckets };
  });
  const response: HistoryWindowResponse = { request: { ...request, readPolicy: dto.readPolicy }, coverage: dto.coverage, series, unitGroups: [], aggregation: { level: 'hourly', pointCount: series.reduce((sum, item) => sum + item.points.length, 0) }, limits: { maxPointsPerSeries: 2_000, truncated: false }, readPolicy: dto.readPolicy };
  return { response, window: toMobileAnalysisWindow(response, selectedIds) };
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

export function classifyMobileAnalysisFailure(input: MobileAnalysisFailureInput | MobileAnalysisValidationError): MobileHistoryFailure {
  if (input instanceof MobileAnalysisValidationError) return input.failure;
  if (input.kind === 'network') return { kind: 'transient', status: null, reason: input.message };
  if (input.status === 401 || input.status === 403) return { kind: 'auth', status: input.status, reason: input.message };
  if (input.status === 413 || (input.status === 400 && input.code === 'range_too_large')) return { kind: 'size', status: input.status, reason: input.message };
  if (input.status >= 500) return { kind: 'transient', status: input.status, reason: input.message };
  return { kind: 'protocol', code: 'http-error', reason: input.message };
}
