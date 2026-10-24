import { describe, expect, test } from 'vitest';
import { classifyMobileAnalysisFailure, normalizeMobileSeries, selectMobileTensionSources, toMobileAnalysisWindow, validateMobileCloudGrid, validateMobileEdgeGrid, validateMobileResponse, visibleMobileAnalysisEmpty } from '../src/mobile/mobileTensionPolicy';
import type { HistoryWindowResponse, MobileTensionSource } from '../src/shared/types';

const source = (id: string, overrides: Partial<MobileTensionSource> = {}): MobileTensionSource => ({ seriesId: id, sourceKey: id, channelKey: 'swt_1', label: id, unit: 'kPa', zoneId: 'z', available: true, measurementKind: 'soil', ...overrides });
const response = (series: HistoryWindowResponse['series']): HistoryWindowResponse => ({ request: { from: 0, to: 3_600_000, rangeLabel: '24h', aggregation: 'hourly' }, coverage: { from: 0, to: 3_600_000 }, series, unitGroups: [], aggregation: { level: 'hourly', pointCount: 1 }, limits: { maxPointsPerSeries: 2_000, truncated: false } });

describe('mobile tension policy', () => {
  test('sorts eligible sources and excludes unavailable, legacy and other-supported rows', () => {
    expect(selectMobileTensionSources([source('b'), source('a'), source('x', { available: false }), source('legacy', { legacy: true }), source('other', { status: 'other_supported' })], 'z').map((item) => item.seriesId)).toEqual(['a', 'b']);
  });
  test('preserves measured zero and counts invalid hourly averages', () => {
    const invalid = { count: 0 };
    expect(normalizeMobileSeries({ id: 'a', label: 'A', unit: 'kPa', points: [{ t: 0, value: 0 }, { t: 3_600_000, value: 1_000_001 }] }, invalid).buckets.map((bucket) => bucket.value)).toEqual([0, null]);
    expect(invalid.count).toBe(1);
  });
  test('visible empty requires complete coverage and no finite overlap', () => {
    const window = toMobileAnalysisWindow(response([{ id: 'a', label: 'A', unit: 'kPa', points: [{ t: 0, value: null }] }]), ['a']);
    expect(visibleMobileAnalysisEmpty(window, { from: 0, to: 100 }, ['a'])).toBe(true);
    expect(visibleMobileAnalysisEmpty({ ...window, complete: false }, { from: 0, to: 100 }, ['a'])).toBe(false);
    expect(visibleMobileAnalysisEmpty(window, { from: -100, to: 100 }, ['a'])).toBe(false);
  });
  test('preserves supplied bucket intervals, counts and quality', () => {
    const item = normalizeMobileSeries({ id: 'a', label: 'A', unit: 'kPa', points: [], buckets: [{ from: 0, to: 3_600_000, value: 0, count: 0, quality: 'partial' }] }, { count: 0 });
    expect(item.buckets).toEqual([{ from: 0, to: 3_600_000, value: 0, count: 0, quality: 'partial' }]);
  });
  test('rejects duplicate, missing and extra response IDs', () => {
    expect(() => validateMobileResponse(response([{ id: 'a', label: 'A', unit: 'kPa', points: [{ t: 0, value: 1 }] }]), { from: 0, to: 3_600_000, rangeLabel: '24h', aggregation: 'hourly' }, ['a', 'b'])).toThrow(/missing/);
  });
  test('classifies auth, size and transient failures', () => {
    expect(classifyMobileAnalysisFailure({ status: 401 }).kind).toBe('auth');
    expect(classifyMobileAnalysisFailure({ status: 413 }).kind).toBe('size');
    expect(classifyMobileAnalysisFailure({ status: 503 }).kind).toBe('transient');
  });
  test('rejects malformed hourly grids instead of filling gaps', () => {
    const series = [{ id: 'a', label: 'A', unit: 'kPa', points: [{ t: 0, value: 1 }, { t: 7_200_000, value: 2 }] }];
    expect(() => validateMobileCloudGrid({ from: 0, to: 7_200_000, stepSeconds: 3600, bucketCount: 2 }, series)).toThrow(/anchor/);
    expect(() => validateMobileEdgeGrid({ from: 0, to: 7_200_000 }, series)).toThrow(/hourly/);
  });
});
