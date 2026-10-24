import { describe, expect, it, vi, beforeEach } from 'vitest';
vi.hoisted(() => { if (typeof window !== 'undefined' && !window.matchMedia) window.matchMedia = (() => ({ matches: false, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })) as typeof window.matchMedia; });
import axios from 'axios';
import { MobileAnalysisValidationError, HistoryAuthError, type HistoryLoadContext } from '@osi/history-uplot';
import type { AnalysisSeriesResponse } from '../../analysis/types';
import { adaptMobileAnalysisResponse, buildMobileAnalysisRequest, createMobileAnalysisLoader, toMobileFailureInput } from '../mobileAnalysisHistoryAdapter';
import { analysisAPI } from '../../services/api';

vi.mock('../../services/api', () => ({ analysisAPI: { getSeries: vi.fn(), getChannels: vi.fn() } }));

const logical = { from: Date.parse('2026-01-01T00:30:00.000Z'), to: Date.parse('2026-01-02T00:30:00.000Z'), rangeLabel: '24h' as const, aggregation: 'hourly' as const };
const raw = (overrides: Partial<AnalysisSeriesResponse> = {}): AnalysisSeriesResponse => ({
  range: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T01:00:00.000Z' },
  aggregation: { requested: 'hourly', applied: 'hourly' },
  series: [{ seriesId: 'opaque-1', resolved: { hubEui: null, zoneId: 7, cardType: 'soil', sourceKey: 'device-1', channelKey: 'swt_1' }, label: 'Probe', unit: 'kPa', points: Array.from({ length: 25 }, (_, index) => ({ t: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 3_600_000).toISOString(), value: index === 0 ? 0 : null, count: 0, quality: null })), truncated: false, cadence: 'hourly', timezone: 'UTC', coveragePct: null }],
  dropped: [],
  ...overrides,
});

describe('edge mobile analysis adapter', () => {
  beforeEach(() => vi.mocked(analysisAPI.getSeries).mockReset());
  it('builds an hourly request with UTC floor/ceil bounds and preserves selector order', () => {
    expect(buildMobileAnalysisRequest(['b', 'a'], logical)).toEqual({
      selectors: [{ seriesId: 'b' }, { seriesId: 'a' }],
      range: { mode: 'custom', label: '24h', from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T01:00:00.000Z' },
      aggregation: 'hourly',
    });
  });

  it('returns null for no IDs and rejects duplicates or over-cap selections', () => {
    expect(buildMobileAnalysisRequest([], logical)).toBeNull();
    expect(() => buildMobileAnalysisRequest(['a', 'a'], logical)).toThrow(MobileAnalysisValidationError);
    expect(() => buildMobileAnalysisRequest(Array.from({ length: 26 }, (_, index) => `s${index}`), logical)).toThrow(MobileAnalysisValidationError);
  });

  it('normalizes raw DTO points through the shared response contract', () => {
    const normalized = adaptMobileAnalysisResponse(raw(), logical, { selectedIds: ['opaque-1'], selectionKey: '["opaque-1"]', requestRevision: 1, readPolicy: 'edge-hourly' });
    expect(normalized.response.series[0]?.points[0]).toEqual({ t: Date.parse('2026-01-01T00:00:00.000Z'), value: 0 });
    expect(normalized.response.series[0]?.buckets?.[0]).toEqual({ from: Date.parse('2026-01-01T00:00:00.000Z'), to: Date.parse('2026-01-01T01:00:00.000Z'), value: 0, count: 0, quality: null });
  });

  it('sanitizes an invalid hourly average in both points and buckets', () => {
    const normalized = adaptMobileAnalysisResponse(raw({
      series: [
        { ...raw().series[0], points: raw().series[0].points.map((point, index) => index === 0 ? { ...point, value: 1_000_001 } : point) },
      ],
    }), logical, { selectedIds: ['opaque-1'], selectionKey: 'opaque-1', requestRevision: 1, readPolicy: 'edge-hourly' });
    expect(normalized.response.series[0]?.points[0]?.value).toBeNull();
    expect(normalized.response.series[0]?.buckets?.[0]).toMatchObject({ value: null, quality: 'invalid' });
    expect(normalized.window.invalidHourlyAverageCount).toBe(1);
  });

  it('extracts cloud-compatible machine codes and preserves auth status', () => {
    const error = Object.assign(new Error('Request failed'), { isAxiosError: true, response: { status: 400, data: { title: 'Bad Request', detail: 'range_too_large', error: 'Bad Request' } } });
    expect(toMobileFailureInput(error)).toEqual({ kind: 'http', status: 400, code: 'range_too_large', message: 'range_too_large' });
    expect(toMobileFailureInput(Object.assign(new Error('offline'), { isAxiosError: true }))).toEqual({ kind: 'network', message: 'offline' });
    expect(() => { throw new HistoryAuthError(401, 'expired'); }).toThrow(HistoryAuthError);
  });

  it('forwards the caller signal and normalizes the loader response', async () => {
    vi.mocked(analysisAPI.getSeries).mockResolvedValue(raw());
    const signal = new AbortController().signal;
    const context: HistoryLoadContext = { selectedIds: ['opaque-1'], selectionKey: 'opaque-1', requestRevision: 1, readPolicy: 'edge-hourly' };
    const response = await createMobileAnalysisLoader()(logical, signal, context);
    expect(response.series[0]?.id).toBe('opaque-1');
    expect(vi.mocked(analysisAPI.getSeries)).toHaveBeenCalledWith(expect.objectContaining({ selectors: [{ seriesId: 'opaque-1' }] }), { signal });
  });

  it('keeps typed validation, HTTP and cancellation failures at the shared boundary', async () => {
    const loader = createMobileAnalysisLoader();
    const context: HistoryLoadContext = { selectedIds: ['opaque-1'], selectionKey: 'opaque-1', requestRevision: 1, readPolicy: 'edge-hourly' };
    vi.mocked(analysisAPI.getSeries).mockResolvedValue({ ...raw(), series: [] });
    await expect(loader(logical, new AbortController().signal, context)).rejects.toMatchObject({ failure: { kind: 'sources', missingIds: ['opaque-1'] } });

    const tooLarge = Object.assign(new Error('bad request'), { isAxiosError: true, response: { status: 413, data: { error: 'too large' } } });
    vi.mocked(analysisAPI.getSeries).mockRejectedValueOnce(tooLarge);
    await expect(loader(logical, new AbortController().signal, context)).rejects.toMatchObject({ failure: { kind: 'size', status: 413 } });

    const unauthorized = Object.assign(new Error('expired'), { isAxiosError: true, response: { status: 401, data: { detail: 'expired' } } });
    vi.mocked(analysisAPI.getSeries).mockRejectedValueOnce(unauthorized);
    await expect(loader(logical, new AbortController().signal, context)).rejects.toBeInstanceOf(HistoryAuthError);

    const forbidden = Object.assign(new Error('denied'), { isAxiosError: true, response: { status: 403, data: { detail: 'denied' } } });
    vi.mocked(analysisAPI.getSeries).mockRejectedValueOnce(forbidden);
    await expect(loader(logical, new AbortController().signal, context)).rejects.toMatchObject({ status: 403 });

    const unavailable = Object.assign(new Error('server down'), { isAxiosError: true, response: { status: 503, data: { message: 'server down' } } });
    vi.mocked(analysisAPI.getSeries).mockRejectedValueOnce(unavailable);
    await expect(loader(logical, new AbortController().signal, context)).rejects.toMatchObject({ failure: { kind: 'transient', status: 503 } });

    const cancellation = new axios.CanceledError('cancelled');
    vi.mocked(analysisAPI.getSeries).mockRejectedValueOnce(cancellation);
    await expect(loader(logical, new AbortController().signal, context)).rejects.toBe(cancellation);

    vi.mocked(analysisAPI.getSeries).mockRejectedValueOnce(new Error('unexpected'));
    await expect(loader(logical, new AbortController().signal, context)).rejects.toMatchObject({ failure: { kind: 'protocol', code: 'http-error', reason: 'unexpected' } });

    vi.mocked(analysisAPI.getSeries).mockRejectedValueOnce(Object.assign(new Error('offline'), { isAxiosError: true }));
    await expect(loader(logical, new AbortController().signal, context)).rejects.toMatchObject({ failure: { kind: 'transient', status: null } });

    vi.mocked(analysisAPI.getSeries).mockClear();
    await expect(loader(logical, new AbortController().signal, { ...context, selectedIds: [] })).rejects.toMatchObject({ failure: { kind: 'protocol', code: 'invalid-selection-count' } });
    expect(analysisAPI.getSeries).not.toHaveBeenCalled();

    for (const dropped of [{ seriesId: null, reason: 'missing' }, { seriesId: ' ', reason: 'missing' }]) {
      await expect(Promise.resolve().then(() => adaptMobileAnalysisResponse(raw({ dropped: [dropped] }), logical, context))).rejects.toMatchObject({ failure: { kind: 'protocol', code: 'unrequested-series' } });
    }
  });
});
