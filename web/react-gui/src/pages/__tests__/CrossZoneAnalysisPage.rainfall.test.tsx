// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisCatalogEntry, AnalysisSeries } from '../../analysis/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ username: 'farmer' }) }));

const entry = (seriesId: string, channelKey: string, label: string, unit: string, extra: Partial<AnalysisCatalogEntry> = {}): AnalysisCatalogEntry => ({
  seriesId, hubEui: null, zoneId: 1, zoneName: 'North', cardType: 'environment', sourceKey: 'environment-src-1',
  channelKey, displayName: `Gauge - ${label}`, unit, availability: 'available', deviceName: 'Gauge', depthCm: null,
  sourceKind: 'device', deviceSourceId: 'device-gauge', configurationState: 'current', ...extra,
});
const amount = entry('amount', 'rain_mm_delta', 'Rainfall amount', 'mm');
const rate = entry('rate', 'rain_mm_per_hour', 'Rain rate', 'mm/h', { legacy: true });

const seriesOf = (e: AnalysisCatalogEntry): AnalysisSeries => ({
  seriesId: e.seriesId,
  resolved: { hubEui: null, zoneId: 1, cardType: e.cardType, sourceKey: e.sourceKey, channelKey: e.channelKey, deviceSourceId: 'device-gauge' },
  label: e.displayName, unit: e.unit, coveragePct: null,
  points: [{ t: '2026-06-01T06:00:00.000Z', value: 1.5, count: 2, expected: null, quality: null }],
  truncated: false, cadence: 'hourly', timezone: 'UTC',
});

const state = vi.hoisted(() => ({ applied: 'raw', series: [] as unknown[] }));
vi.mock('../../analysis/useAnalysisCatalog', () => ({
  useAnalysisCatalog: () => ({ catalog: { channels: [amount, rate] }, isLoading: false, error: undefined }),
}));
vi.mock('../../analysis/useAnalysisViews', () => ({
  useAnalysisViews: () => ({ views: [], saveView: vi.fn(), deleteView: vi.fn() }),
}));
vi.mock('../../analysis/useAnalysisSeries', () => ({
  useAnalysisSeries: () => ({ data: { series: state.series, dropped: [], aggregation: { requested: 'auto', applied: state.applied } }, isLoading: false, error: undefined }),
}));
vi.mock('../../components/analysis/AnalysisChartPanel', () => ({ AnalysisChartPanel: () => <div data-testid="chart" /> }));

import { CrossZoneAnalysisPage } from '../CrossZoneAnalysisPage';

afterEach(() => { cleanup(); localStorage.clear(); });

describe('CrossZoneAnalysisPage rain amounts', () => {
  it('names raw rain samples "this interval" and summed buckets "amount"', () => {
    state.series = [seriesOf(amount)];
    state.applied = 'raw';
    const { unmount } = render(<CrossZoneAnalysisPage />, { wrapper: MemoryRouter });
    expect(screen.getByRole('button', { name: 'Gauge - Rainfall this interval' })).toBeInTheDocument();
    unmount();

    state.applied = 'daily';
    render(<CrossZoneAnalysisPage />, { wrapper: MemoryRouter });
    expect(screen.getByRole('button', { name: 'Gauge - Rainfall amount' })).toBeInTheDocument();
    expect(screen.queryByText(/Rain delta/)).not.toBeInTheDocument();
  });

  it('a saved view holding a legacy rate still opens and marks it', () => {
    state.series = [seriesOf(amount), seriesOf(rate)];
    state.applied = 'hourly';
    render(<CrossZoneAnalysisPage />, { wrapper: MemoryRouter });
    expect(screen.getByRole('button', { name: 'Gauge - Rainfall amount' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Gauge - Rain rate (analysis.legacyEstimate)' })).toBeInTheDocument();
  });
});
