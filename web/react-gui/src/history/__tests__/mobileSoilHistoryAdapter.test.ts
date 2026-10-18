import { describe, expect, it } from 'vitest';
import { normalizeEdgeHistoryResponse, toEdgeHistoryRequest } from '../mobileSoilHistoryAdapter';

describe('edge mobile history adapter', () => {
  it('preserves bounds and forwards the abort signal', () => {
    const signal = new AbortController().signal;
    const request = toEdgeHistoryRequest({ from: Date.parse('2026-01-01T00:00:00Z'), to: Date.parse('2026-01-02T00:00:00Z'), rangeLabel: '24h', aggregation: '15m' }, signal);
    expect(request.range.label).toBe('24h');
    expect(request.range.from).toBe('2026-01-01T00:00:00.000Z');
    expect(request.signal).toBe(signal);
  });
  it('normalizes timestamps while preserving nulls, units, coverage and truncation', () => {
    const normalized = normalizeEdgeHistoryResponse({
      cardId: 'soil-1', cardType: 'soil', view: 'line-chart', range: { label: '7d', from: '2026-01-01T00:00:00Z', to: '2026-01-08T00:00:00Z', timezone: 'UTC' },
      aggregation: { level: 'daily', bucketSizeSeconds: 86400, coveragePct: 87, coverageConfidence: 'derived', pointCount: 2 }, limits: { maxPointsPerSeries: 1000, maxEvents: 0, maxInterpretations: 0, truncated: true },
      series: [{ id: 'swt-1', label: 'Probe 1', unit: 'kPa', points: [{ t: '2026-01-01T00:00:00Z', value: 12, coverageConfidence: 'derived' }, { t: '2026-01-02T00:00:00Z', value: null, coverageConfidence: 'derived' }] }], profiles: [], events: [], calendar: null, interpretations: [], freshness: { dataAsOf: '2026-01-08T00:00:00Z', syncState: 'synced' }, advancedFields: {},
    }, { from: Date.parse('2026-01-01T00:00:00Z'), to: Date.parse('2026-01-08T00:00:00Z'), rangeLabel: '7d', aggregation: 'daily' });
    expect(normalized.coverage).toEqual({ from: Date.parse('2026-01-01T00:00:00Z'), to: Date.parse('2026-01-08T00:00:00Z') });
    expect(normalized.series[0].points).toEqual([{ t: Date.parse('2026-01-01T00:00:00Z'), value: 12 }, { t: Date.parse('2026-01-02T00:00:00Z'), value: null }]);
    expect(normalized.unitGroups).toEqual([{ unit: 'kPa', label: 'kPa', seriesIds: ['swt-1'] }]);
    expect(normalized.aggregation.coveragePct).toBe(87);
    expect(normalized.limits.truncated).toBe(true);
  });
  it('rejects malformed or reversed server ranges instead of inventing coverage', () => {
    const request = { from: 1, to: 2, rangeLabel: '24h', aggregation: 'raw' } as const;
    for (const range of [{}, { from: null, to: '1970-01-01T00:00:02Z' }, { from: '', to: '1970-01-01T00:00:02Z' }, { from: 'bad', to: 'bad' }, { from: '1970-01-01T00:00:02Z', to: '1970-01-01T00:00:01Z' }]) {
      expect(() => normalizeEdgeHistoryResponse({ range, series: [], aggregation: {}, limits: {}, freshness: {} } as never, request)).toThrow(/invalid range/i);
    }
  });
});
