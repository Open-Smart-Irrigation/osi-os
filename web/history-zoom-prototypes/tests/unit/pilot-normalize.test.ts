import { describe, expect, test } from 'vitest';
import { normalizeCardData, normalizeCards, normalizeZones } from '../../src/pilot/normalize';
import { PilotResponseError } from '../../src/pilot/types';
import type { PilotRangeRequest } from '../../src/pilot/types';

const request: PilotRangeRequest = { from: Date.parse('2026-10-01T00:00:00Z'), to: Date.parse('2026-10-02T00:00:00Z'), rangeLabel: '24h', aggregation: 'raw' };

describe('pilot response normalization', () => {
  test('normalizes wrapped and array zones, dropping invalid rows', () => {
    expect(normalizeZones({ zones: [{ id: 2, name: ' North ' }, { id: 0, name: 'bad' }, { id: 3, name: '  ' }] })).toEqual([{ id: 2, name: 'North' }]);
    expect(normalizeZones([{ zoneId: 4, zoneName: 'South' }])).toEqual([{ id: 4, name: 'South' }]);
  });

  test('keeps cards but marks only available line charts as available', () => {
    expect(normalizeCards({ cards: [{ cardId: 'soil-a', cardType: 'soil', views: ['line-chart'], availability: { available: true } }, { card_id: 'event', views: ['event'], availability: { available: true } }] })).toEqual([
      expect.objectContaining({ cardId: 'soil-a', available: true }),
      expect.objectContaining({ cardId: 'event', available: false }),
    ]);
  });

  test('preserves zero and explicit null and falls back only for omitted values', () => {
    const accepted = normalizeCardData({ cardId: 'soil-a', range: { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' }, aggregation: { level: 'raw', pointCount: 4 }, limits: { maxPointsPerSeries: 2000, truncated: false }, series: [{ id: 's1', label: 'S1', unit: ' kPa ', points: [{ t: '2026-10-01T00:00:00Z', value: 0 }, { t: '2026-10-01T01:00:00Z', value: null, mean: 12 }, { t: '2026-10-01T02:00:00Z', latest: null, mean: 13 }, { t: '2026-10-01T03:00:00Z', mean: 14 }, { t: 'bad', value: 4 }, { t: '2026-10-01T01:00:00Z', value: 15 }] }] }, request);
    expect(accepted.series[0].points.map((point) => point.value)).toEqual([0, 15, 13, 14]);
    expect(accepted.series[0].unit).toBe('kPa');
  });

  test('uses response range for sparse coverage, groups missing units, and clips to request', () => {
    const accepted = normalizeCardData({ cardId: 'soil-a', range: { from: '2026-09-30T00:00:00Z', to: '2026-10-03T00:00:00Z' }, aggregation: { level: 'hourly', pointCount: 1 }, limits: { maxPointsPerSeries: 2000, truncated: true }, series: [{ id: 'a', label: 'A', points: [{ t: '2026-10-01T12:00:00Z', value: 1 }] }, { id: 'b', label: 'B', unit: 'kPa', points: [] }] }, request);
    expect(accepted.coverage).toEqual({ from: request.from, to: request.to });
    expect(accepted.unitGroups).toEqual(expect.arrayContaining([{ unit: '', label: 'Unit not reported', seriesIds: ['a'] }, { unit: 'kPa', label: 'kPa', seriesIds: ['b'] }]));
    expect(accepted.limits.truncated).toBe(true);
  });

  test.each([
    { maxPointsPerSeries: 2000, truncated: 'true' },
    { truncated: false },
    { maxPointsPerSeries: 0, truncated: false },
  ])('rejects malformed limits metadata: %j', (limits) => {
    expect(() => normalizeCardData({ cardId: 'soil-a', range: {}, aggregation: {}, limits, series: [] }, request)).toThrow(PilotResponseError);
  });
});
