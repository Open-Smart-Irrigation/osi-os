import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { if (typeof window !== 'undefined' && !window.matchMedia) window.matchMedia = (() => ({ matches: false, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })) as typeof window.matchMedia; });
import { MobileHistoryError } from '@osi/history-uplot';
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
      seriesIdentityVersion: 2, cardId: 'soil-1', cardType: 'soil', view: 'line-chart', range: { label: '7d', from: '2026-01-01T00:00:00Z', to: '2026-01-08T00:00:00Z', timezone: 'UTC' },
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
      expect(() => normalizeEdgeHistoryResponse({ seriesIdentityVersion: 2, range, series: [], aggregation: {}, limits: {}, freshness: {} } as never, request)).toThrow(/invalid range/i);
    }
  });
  const weekRequest = { from: Date.parse('2026-01-01T00:00:00Z'), to: Date.parse('2026-01-08T00:00:00Z'), rangeLabel: '7d', aggregation: 'daily' } as const;
  function edgeResponse(overrides: Record<string, unknown> = {}) {
    return {
      seriesIdentityVersion: 2, cardId: 'soil-1', cardType: 'soil', view: 'line-chart',
      range: { label: '7d', from: '2026-01-01T00:00:00Z', to: '2026-01-08T00:00:00Z', timezone: 'UTC' },
      availability: { available: true, reasons: [] },
      aggregation: { level: 'daily', bucketSizeSeconds: 86400, coveragePct: 100, coverageConfidence: 'configured', pointCount: 2 },
      limits: { maxPointsPerSeries: 2000, maxEvents: 0, maxInterpretations: 0, truncated: false },
      series: [
        { id: 'swt_1:soil-src-aaaaaaaaaaaa', deviceSourceId: 'device-aaaaaaaaaaaa', sourceKey: 'soil-src-aaaaaaaaaaaa', channelKey: 'swt_1', sourceLabel: 'Kiwi North', label: 'SWT 1', unit: 'kPa', points: [{ t: '2026-01-01T00:00:00Z', value: 12 }] },
        { id: 'swt_1:soil-src-bbbbbbbbbbbb', deviceSourceId: 'device-bbbbbbbbbbbb', sourceKey: 'soil-src-bbbbbbbbbbbb', channelKey: 'swt_1', sourceLabel: 'Kiwi South', label: 'SWT 1', unit: 'kPa', points: [{ t: '2026-01-01T00:00:00Z', value: 30 }] },
      ],
      profiles: [], events: [], calendar: null, interpretations: [], freshness: { dataAsOf: '2026-01-08T00:00:00Z', syncState: 'local' }, advancedFields: {},
      ...overrides,
    } as never;
  }
  it('labels each physical source distinctly instead of repeating the channel label', () => {
    const normalized = normalizeEdgeHistoryResponse(edgeResponse(), weekRequest);
    const labels = normalized.series.map((series) => series.label);
    expect(labels).toEqual(['Kiwi North · SWT 1', 'Kiwi South · SWT 1']);
    expect(new Set(labels).size).toBe(2);
  });
  it('throws a MobileHistoryError carrying the reasons when the host reports the card unavailable', () => {
    const response = edgeResponse({
      availability: { available: false, reasons: ['point_budget_exceeded', 'select_fewer_sources_or_coarser_aggregation'] },
      series: [],
    });
    let caught: unknown = null;
    try {
      normalizeEdgeHistoryResponse(response, weekRequest);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MobileHistoryError);
    expect((caught as MobileHistoryError).message).toMatch(/point_budget_exceeded/);
    expect((caught as MobileHistoryError).message).toMatch(/select_fewer_sources_or_coarser_aggregation/);
  });
  it('rejects a response without series identity v2', () => {
    for (const version of [undefined, 1]) {
      const response = edgeResponse({ seriesIdentityVersion: version });
      expect(() => normalizeEdgeHistoryResponse(response, weekRequest)).toThrow(/series identity v2/);
    }
  });
});
