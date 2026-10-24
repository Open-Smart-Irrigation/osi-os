import { describe, expect, test } from 'vitest';
import { classifyMobileAnalysisFailure, normalizeMobileAnalysisResponse, normalizeMobileSeries, selectMobileTensionSources, toMobileAnalysisWindow, validateMobileCloudGrid, validateMobileEdgeGrid, visibleMobileAnalysisEmpty } from '../src/mobile/mobileTensionPolicy';
import type { HistoryWindowRequest, HistoryWindowResponse, MobileAnalysisResponseDto, MobileTensionSource } from '../src/shared/types';

const source = (id: string, overrides: Partial<MobileTensionSource> = {}): MobileTensionSource => ({ seriesId: id, sourceKey: id, channelKey: 'swt_1', label: id, unit: 'kPa', zoneId: 'z', available: true, measurementKind: 'soil', ...overrides });
const response = (series: HistoryWindowResponse['series']): HistoryWindowResponse => ({ request: { from: 0, to: 3_600_000, rangeLabel: '24h', aggregation: 'hourly' }, coverage: { from: 0, to: 3_600_000 }, series, unitGroups: [], aggregation: { level: 'hourly', pointCount: 1 }, limits: { maxPointsPerSeries: 2_000, truncated: false } });
const dto = (value: number | null = 1): MobileAnalysisResponseDto => ({ readPolicy: 'edge-hourly', coverage: { from: 0, to: 3_600_000 }, appliedAggregation: 'hourly', truncated: false, dropped: [], grid: { platform: 'edge', from: 0, to: 3_600_000 }, series: ['a', 'b'].map((seriesId) => ({ seriesId, label: seriesId, unit: 'kPa', truncated: false, points: [{ at: 0, value, count: value === null ? 0 : 1, quality: value === null ? 'missing' : 'ok' }] })) });
const request: HistoryWindowRequest = { from: 0, to: 3_600_000, rangeLabel: '24h', aggregation: 'hourly', readPolicy: 'edge-hourly' };

describe('mobile tension policy', () => {
  test('sorts eligible sources and excludes unavailable, legacy and other-supported rows', () => {
    expect(selectMobileTensionSources([source('b'), source('a'), source('x', { available: false }), source('legacy', { legacy: true }), source('other', { status: 'other_supported' })], 'z').map((item) => item.seriesId)).toEqual(['a', 'b']);
  });
  test('preserves measured zero and counts invalid hourly averages', () => {
    const invalid = { count: 0 };
    expect(normalizeMobileSeries({ id: 'a', label: 'A', unit: 'kPa', points: [], buckets: [{ from: 0, to: 3_600_000, value: 0, count: 1, quality: 'ok' }, { from: 3_600_000, to: 7_200_000, value: 1_000_001, count: 1, quality: 'ok' }] }, invalid).buckets.map((bucket) => bucket.value)).toEqual([0, null]);
    expect(invalid.count).toBe(1);
  });
  test('sanitizes invalid averages in both response points and buckets while preserving zero and mixed means', () => {
    const input = { ...dto(), series: dto().series.map((series, index) => ({ ...series, points: [{ at: 0, value: index === 0 ? 1_000_001 : index === 1 ? 500_015.5 : 0, count: 2, quality: 'ok' }] })) };
    const normalized = normalizeMobileAnalysisResponse(input, request, ['a', 'b']);
    expect(normalized.response.series[0].points[0].value).toBeNull();
    expect(normalized.window.series[0].buckets[0].value).toBeNull();
    expect(normalized.response.series[1].points[0].value).toBe(500_015.5);
    expect(normalized.response.series[1]?.buckets?.[0]?.count).toBe(2);
  });
  test('visible empty requires complete coverage and no finite overlap', () => {
    const window = toMobileAnalysisWindow(normalizeMobileAnalysisResponse(dto(null), request, ['a', 'b']).response, ['a', 'b']);
    expect(visibleMobileAnalysisEmpty(window, { from: 0, to: 100 }, ['a'])).toBe(true);
    expect(visibleMobileAnalysisEmpty({ ...window, complete: false }, { from: 0, to: 100 }, ['a'])).toBe(false);
    expect(visibleMobileAnalysisEmpty(window, { from: -100, to: 100 }, ['a'])).toBe(false);
  });
  test('preserves supplied bucket intervals, counts and quality', () => {
    const item = normalizeMobileSeries({ id: 'a', label: 'A', unit: 'kPa', points: [], buckets: [{ from: 0, to: 3_600_000, value: 0, count: 0, quality: 'partial' }] }, { count: 0 });
    expect(item.buckets).toEqual([{ from: 0, to: 3_600_000, value: 0, count: 0, quality: 'partial' }]);
  });
  test('rejects duplicate, missing and extra response IDs', () => {
    expect(() => normalizeMobileAnalysisResponse({ ...dto(), series: [dto().series[0], { ...dto().series[0] }] }, request, ['a', 'b'])).toThrow(/duplicate/);
  });
  test('classifies auth, size and transient failures', () => {
    expect(classifyMobileAnalysisFailure({ kind: 'http', status: 401, code: null, message: 'expired' }).kind).toBe('auth');
    expect(classifyMobileAnalysisFailure({ kind: 'http', status: 413, code: null, message: 'large' }).kind).toBe('size');
    expect(classifyMobileAnalysisFailure({ kind: 'http', status: 503, code: null, message: 'down' }).kind).toBe('transient');
  });
  test('rejects malformed hourly grids instead of filling gaps', () => {
    const series = [{ id: 'a', label: 'A', unit: 'kPa', points: [{ t: 0, value: 1 }, { t: 7_200_000, value: 2 }] }];
    expect(() => validateMobileCloudGrid({ from: 0, to: 7_200_000, stepSeconds: 3600, bucketCount: 2 }, series)).toThrow(/anchor/);
    expect(() => validateMobileEdgeGrid({ from: 0, to: 7_200_000 }, series)).toThrow(/hourly/);
  });
});
