import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HistoryCardFrame } from '../HistoryCardFrame';
import type { HistoryCardDataResponse, HistoryCardSummary } from '../../../history/types';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverStub;

const { translateForTest } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'history.cardFrame.emptyTitle': 'Select a history card',
    'history.cardFrame.emptyBody': 'Choose a zone and thematic card to inspect local history.',
    'history.cardFrame.typeHistory': '{{cardType}} history',
    'history.cardFrame.viewModes': '{{title}} view modes',
    'history.cardFrame.unavailable': 'This card is not available for the selected zone.',
    'history.cardFrame.timelineBrush': 'Timeline viewport',
    'history.cardFrame.timelineBrushKeyboardHelp': 'Use arrow keys to pan, plus or minus to zoom, and Home or Enter to reset.',
    'history.cardFrame.aggregationBadge': 'Aggregation: {{aggregation}}',
    'history.cardFrame.placeholderBody': 'Chart and calendar data will load here when card data APIs are enabled.',
    'history.cardType.soil': 'Soil',
    'history.cardType.environment': 'Environment',
    'history.viewMode.soil-profile': 'Soil Profile',
    'history.viewMode.line-chart': 'Line Chart',
    'history.metadata.coverageKnown': '{{coverage}}% coverage',
    'history.metadata.coverageUnknown': 'Coverage unknown',
    'history.metadata.coverageConfidence.configured': 'Configured cadence',
    'history.metadata.coverageConfidence.derived': 'Derived cadence',
    'history.metadata.coverageConfidence.unknown': 'Cadence unknown',
    'history.metadata.syncState.local': 'Local',
    'history.metadata.syncState.synced': 'Synced',
    'history.metadata.syncState.stale': 'Stale',
    'history.metadata.syncState.degraded': 'Degraded',
    'history.metadata.syncState.unknown': 'Unknown',
    'history.metadata.aggregation.hourly': 'Hourly',
    'history.environmentLineChart.title': 'Environment trend',
    'history.environmentLineChart.emptyTitle': 'No environment trend data',
    'history.environmentLineChart.emptyBody': 'Environment readings will appear here when history data is available.',
    'history.environmentLineChart.pointsCount': '{{count}} readings',
    'history.environmentLineChart.axisLabel': '{{unit}} axis',
    'history.environmentLineChart.axisNoUnit': 'Unitless axis',
    'history.environmentLineChart.series.airTemperature': 'Air temperature',
    'history.environmentLineChart.series.humidity': 'Relative humidity',
    'history.environmentLineChart.series.rain': 'Rain',
    'history.environmentLineChart.series.light': 'Light',
    'history.environmentLineChart.series.pressure': 'Pressure',
    'history.environmentLineChart.series.wind': 'Wind',
    'history.environmentLineChart.series.uv': 'UV index',
    'history.environmentLineChart.series.environment': 'Environment',
  };

  return {
    translateForTest: (key: string, options?: Record<string, unknown>): string => {
      const template = translations[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''));
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translateForTest,
  }),
}));

vi.mock('../TimelineBrush', () => ({
  TimelineBrush: () => <div aria-label="Timeline viewport" />,
}));

const cardData = vi.hoisted(() => ({
  current: undefined as HistoryCardDataResponse | undefined,
}));

vi.mock('../../../history/useHistoryCardData', () => ({
  useHistoryCardData: () => ({
    data: cardData.current,
    error: undefined,
    isLoading: false,
    refresh: vi.fn(),
  }),
}));

function environmentCard(): HistoryCardSummary<'environment'> {
  return {
    cardId: 'zone-1:environment:microclimate',
    cardType: 'environment',
    scope: 'zone',
    title: 'Environment',
    subtitle: 'Local microclimate',
    defaultView: 'line-chart',
    views: ['line-chart', 'calendar'],
    supportedRanges: ['24h', '7d'],
    defaultRange: '24h',
    metadata: {
      coveragePct: 76,
      coverageConfidence: 'configured',
      sourceDeviceEui: 'A84041FFFF654321',
    },
    availability: { available: true, reasons: [] },
    ordering: { pinned: true, score: 90, recentRank: 1 },
  };
}

function soilCard(): HistoryCardSummary<'soil'> {
  return {
    cardId: 'zone-1:soil:root-zone',
    cardType: 'soil',
    scope: 'zone',
    title: 'Soil',
    subtitle: 'Root zone tension',
    defaultView: 'soil-profile',
    views: ['soil-profile', 'line-chart'],
    supportedRanges: ['24h', '7d'],
    defaultRange: '24h',
    metadata: {
      coveragePct: 82,
      coverageConfidence: 'configured',
    },
    availability: { available: true, reasons: [] },
    ordering: { pinned: false, score: 50, recentRank: 2 },
  };
}

function historyData(overrides: Partial<HistoryCardDataResponse<'environment'>> = {}): HistoryCardDataResponse<'environment'> {
  return {
    cardId: 'zone-1:environment:microclimate',
    cardType: 'environment',
    view: 'line-chart',
    range: { label: '24h', from: '2026-05-30T00:00:00Z', to: '2026-05-31T00:00:00Z', timezone: 'UTC' },
    aggregation: {
      level: 'hourly',
      bucketSizeSeconds: 3600,
      coveragePct: 76,
      coverageConfidence: 'configured',
      pointCount: 6,
    },
    limits: { maxPointsPerSeries: 1000, maxEvents: 100, maxInterpretations: 20, truncated: false },
    series: [
      {
        id: 'env-src-A84041FFFF654321-air-temperature',
        label: 'env-src-A84041FFFF654321_air_temperature',
        unit: 'A84041FFFF654321_raw_rssi',
        points: [
          { t: '2026-05-30T00:00:00Z', value: 21.4, coverageConfidence: 'configured' },
          { t: '2026-05-30T12:00:00Z', value: 27.2, coverageConfidence: 'configured' },
        ],
      },
      {
        id: 'env-src-A84041FFFF654321-relative-humidity',
        label: 'relative_humidity',
        unit: '%',
        points: [
          { t: '2026-05-30T00:00:00Z', value: 71, coverageConfidence: 'configured' },
          { t: '2026-05-30T12:00:00Z', value: 54, coverageConfidence: 'configured' },
        ],
      },
      {
        id: 'env-src-A84041FFFF654321-rain',
        label: 'Rain',
        unit: 'mm',
        points: [{ t: '2026-05-30T12:00:00Z', value: 3.5, coverageConfidence: 'configured' }],
      },
      {
        id: 'env-src-A84041FFFF654321-light',
        label: 'light_lux',
        unit: null,
        points: [{ t: '2026-05-30T12:00:00Z', value: 53000, coverageConfidence: 'configured' }],
      },
    ],
    profiles: [],
    events: [
      {
        id: 'evt-raw',
        type: 'environment_threshold',
        t: '2026-05-30T12:00:00Z',
        label: 'env-src-A84041FFFF654321_temperature_threshold',
        severity: 'warning',
        metadata: { sourceDeviceEui: 'A84041FFFF654321' },
      },
    ],
    calendar: null,
    interpretations: [],
    freshness: { dataAsOf: '2026-05-31T00:00:00Z', syncState: 'local' },
    advancedFields: {},
    ...overrides,
  };
}

describe('HistoryCardFrame environment line chart', () => {
  it('renders readable environment series labels and units without exposing source identifiers', () => {
    cardData.current = historyData();

    render(<HistoryCardFrame card={environmentCard()} scope={{ type: 'zone', zoneId: 1 }} />);

    const chart = screen.getByRole('region', { name: 'Environment trend' });
    expect(within(chart).queryByText('Environment trend')).not.toBeInTheDocument();
    expect(within(chart).queryByText(/\breadings\b/i)).not.toBeInTheDocument();
    expect(within(chart).queryByText('Air temperature')).not.toBeInTheDocument();
    expect(within(chart).queryByText('Relative humidity')).not.toBeInTheDocument();
    expect(within(chart).queryByText('Rain')).not.toBeInTheDocument();
    expect(within(chart).queryByText('Light')).not.toBeInTheDocument();
    expect(within(chart).getByText('°C axis')).toBeInTheDocument();
    expect(within(chart).getByText('% axis')).toBeInTheDocument();
    expect(within(chart).getByText('mm axis')).toBeInTheDocument();
    expect(within(chart).getByText('lx axis')).toBeInTheDocument();
    expect(screen.queryByText(/env-src-/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/A84041FFFF654321/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/air_temperature|relative_humidity|light_lux|environment_threshold|raw_rssi|rssi/i)).not.toBeInTheDocument();
  });

  it('renders a stable empty state when environment series are sparse or missing', () => {
    cardData.current = historyData({
      series: [
        {
          id: 'env-src-A84041FFFF654321-air-temperature',
          label: 'air_temperature',
          unit: 'C',
          points: [
            null,
            { t: '', value: 12, coverageConfidence: 'unknown' },
            { t: 'A84041FFFF654321', value: 20, coverageConfidence: 'unknown' },
            { t: '2026-05-30T00:00:00Z', value: 'not-a-number', coverageConfidence: 'unknown' },
            { t: '2026-05-30T01:00:00Z', value: null, coverageConfidence: 'configured' },
          ],
        },
      ] as unknown as HistoryCardDataResponse<'environment'>['series'],
      events: [],
    });

    render(<HistoryCardFrame card={environmentCard()} scope={{ type: 'zone', zoneId: 1 }} />);

    expect(screen.getByText('No environment trend data')).toBeInTheDocument();
    expect(screen.getByText('Environment readings will appear here when history data is available.')).toBeInTheDocument();
    expect(screen.queryByText(/A84041FFFF654321/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/air_temperature/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/undefined|NaN/i)).not.toBeInTheDocument();
  });

  it('keeps non-environment cards on the existing placeholder surface', () => {
    cardData.current = undefined;

    render(<HistoryCardFrame card={soilCard()} scope={{ type: 'zone', zoneId: 1 }} />);

    expect(screen.getByText('Chart and calendar data will load here when card data APIs are enabled.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Environment trend' })).not.toBeInTheDocument();
  });
});
