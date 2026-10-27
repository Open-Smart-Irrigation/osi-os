import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  buildNumericRows,
  HistorySeriesTooltip,
  SoilLineChartView,
  soilSeriesDisplayLabel,
  soilSeriesMarkerIndices,
  soilSeriesShouldShowDots,
} from '../visualizations/SoilLineChartView';
import type { HistoryCardDataResponse } from '../../../history/types';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverStub;

const { translateForTest } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'history.soilLineChart.title': 'Soil line chart',
    'history.soilLineChart.emptyTitle': 'No soil trend data',
    'history.soilLineChart.emptyBody': 'Soil tension readings will appear here when history data is available.',
    'history.soilLineChart.pointsCount': '{{count}} readings',
    'history.soilLineChart.axisLabel': '{{unit}} axis',
    'history.soilLineChart.series.soil1': 'Soil 1',
    'history.soilLineChart.series.soil2': 'Soil 2',
    'history.soilLineChart.series.soil3': 'Soil 3',
    'history.soilLineChart.series.soil': 'Soil',
    'history.soilLineChart.series.sensor': 'Sensor {{index}}',
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

function soilData(overrides: Partial<HistoryCardDataResponse<'soil'>> = {}): HistoryCardDataResponse<'soil'> {
  return {
    cardId: 'zone-b:soil:root-zone',
    cardType: 'soil',
    view: 'line-chart',
    range: { label: '24h', from: '2026-06-01T00:00:00Z', to: '2026-06-02T00:00:00Z', timezone: 'UTC' },
    aggregation: {
      level: 'raw',
      bucketSizeSeconds: null,
      coveragePct: 95,
      coverageConfidence: 'configured',
      pointCount: 4,
    },
    limits: { maxPointsPerSeries: 1000, maxEvents: 100, maxInterpretations: 20, truncated: false },
    series: [
      {
        id: 'soil-source-A84041A75D5E7CFB-swt_1',
        label: 'A84041A75D5E7CFB_swt_1',
        unit: 'kPa',
        points: [
          { t: '2026-06-01T06:00:00Z', value: 6.2, coverageConfidence: 'configured' },
          { t: '2026-06-01T12:00:00Z', value: 7.4, coverageConfidence: 'configured' },
        ],
      },
      {
        id: 'swt_2',
        label: 'SWT 2',
        unit: 'kPa',
        points: [
          { t: '2026-06-01T06:00:00Z', value: 8.1, coverageConfidence: 'configured' },
          { t: '2026-06-01T12:00:00Z', value: 9.3, coverageConfidence: 'configured' },
        ],
      },
    ],
    profiles: [],
    events: [],
    calendar: null,
    interpretations: [],
    freshness: { dataAsOf: '2026-06-01T12:00:00Z', syncState: 'local' },
    advancedFields: {},
    ...overrides,
  };
}

describe('SoilLineChartView', () => {
  it('rows carry epoch-ms timestamps for numeric axis clipping', () => {
    const rows = buildNumericRows([
      {
        key: 'swt_1',
        label: 'Layer 1',
        unit: 'kPa',
        depthCm: null,
        points: [{ t: '2026-06-01T00:00:00Z', value: 6 }],
      },
    ]);

    expect(rows[0].tMs).toBe(Date.parse('2026-06-01T00:00:00Z'));
  });

  it('does not infer outages from sparse continuous timestamps', () => {
    expect(soilSeriesShouldShowDots({
      key: 'swt_1',
      label: 'Layer 1',
      unit: 'kPa',
      depthCm: null,
      points: [
        { t: '2026-06-24T06:00:00Z', value: 5 },
        { t: '2026-06-29T20:00:00Z', value: 20 },
        { t: '2026-06-29T21:00:00Z', value: 21 },
      ],
    })).toBe(false);
  });

  it('shows isolated observations on both sides of an explicit null gap', () => {
    expect(soilSeriesShouldShowDots({
      key: 'device-a:swt_1',
      label: 'Probe A',
      unit: 'kPa',
      depthCm: 20,
      points: [
        { t: '2026-06-24T06:00:00Z', value: 5 },
        { t: '2026-06-24T07:00:00Z', value: null },
        { t: '2026-06-24T08:00:00Z', value: 7 },
      ],
    })).toBe(true);
  });

  it('omits alignment-absent sources while retaining explicit null entries', () => {
    const hovered = Date.parse('2026-10-03T00:15:00Z');
    render(<HistorySeriesTooltip
      active
      label={hovered}
      byKey={new Map([
        ['source-a', { key: 'source-a', label: 'Source A', unit: 'kPa', depthCm: null, points: [] }],
        ['source-b', { key: 'source-b', label: 'Source B', unit: 'kPa', depthCm: null, points: [] }],
        ['source-c', { key: 'source-c', label: 'Source C', unit: 'kPa', depthCm: null, points: [] }],
      ])}
      rows={[{ timestamp: '2026-10-03T00:15:00Z', tMs: hovered, 'source-a': null, 'source-b': 9, __seriesMeta: {
        'source-a': { statisticAvailability: { latest: 'latest_missing' } },
        'source-b': {},
      } }]}
      payload={[{ dataKey: 'source-b', value: 9, payload: { tMs: hovered } }]}
    />);
    expect(screen.getByText(/Source A/)).toBeInTheDocument();
    expect(screen.getByText(/latest_missing/)).toBeInTheDocument();
    expect(screen.getByText(/Source B/)).toBeInTheDocument();
    expect(screen.queryByText(/Source C/)).not.toBeInTheDocument();
  });

  it('keeps dots hidden for continuous hourly soil series', () => {
    expect(soilSeriesShouldShowDots({
      key: 'swt_1',
      label: 'Layer 1',
      unit: 'kPa',
      depthCm: null,
      points: [
        { t: '2026-06-24T06:00:00Z', value: 5 },
        { t: '2026-06-24T07:00:00Z', value: 6 },
        { t: '2026-06-24T08:00:00Z', value: 7 },
      ],
    })).toBe(false);
  });

  it('keeps dots hidden for sparse but continuous soil series', () => {
    const points = Array.from({ length: 2000 }, (_, index) => ({
      t: new Date(Date.parse('2026-06-24T00:00:00Z') + index * 2 * 60 * 60 * 1000).toISOString(),
      value: index,
    }));
    expect(soilSeriesShouldShowDots({
      key: 'swt_1', label: 'Layer 1', unit: 'kPa', depthCm: null, points,
    })).toBe(false);
  });

  it('marks only isolated observations and explicit-null gap endpoints', () => {
    const series = {
      key: 'a', label: 'A', unit: 'kPa', depthCm: 10,
      points: [
        { t: '2026-10-03T00:00:00Z', value: 1 },
        { t: '2026-10-03T00:15:00Z', value: 2 },
        { t: '2026-10-03T00:30:00Z', value: null },
        { t: '2026-10-03T00:45:00Z', value: 3 },
        { t: '2026-10-03T01:00:00Z', value: 4 },
      ],
    };
    expect([...soilSeriesMarkerIndices(series)]).toEqual([1, 3]);
  });

  it('prefers soil depth labels and disambiguates duplicate depths', () => {
    expect(soilSeriesDisplayLabel(translateForTest, { id: 'swt_1', label: 'SWT 1', depthCm: 5 }, 0)).toBe('5 cm');
    expect(soilSeriesDisplayLabel(translateForTest, { id: 'swt_2', label: 'SWT 2', depthCm: 5 }, 1, true)).toBe('5 cm - Sensor 2');
    expect(soilSeriesDisplayLabel(translateForTest, { id: 'swt_3', label: 'SWT 3' }, 2)).toBe('Sensor 3');
  });

  it('renders soil tension chart without label chrome or source identifiers', () => {
    render(<SoilLineChartView data={soilData()} />);

    const chart = screen.getByRole('region', { name: 'Soil line chart' });
    expect(within(chart).queryByText('Soil line chart')).not.toBeInTheDocument();
    expect(within(chart).queryByText(/\breadings\b/i)).not.toBeInTheDocument();
    expect(within(chart).queryByText('Soil 1')).not.toBeInTheDocument();
    expect(within(chart).queryByText('Soil 2')).not.toBeInTheDocument();
    expect(screen.queryByText(/[A-F0-9]{16}/)).not.toBeInTheDocument();
    expect(screen.queryByText(/swt_1|soil-source|A84041A75D5E7CFB/i)).not.toBeInTheDocument();
  });

  it('renders a soil-specific empty state when no visible points exist', () => {
    render(<SoilLineChartView data={soilData({ series: [] })} />);

    expect(screen.getByRole('region', { name: 'Soil line chart' })).toBeInTheDocument();
    expect(screen.getByText('No soil trend data')).toBeInTheDocument();
    expect(screen.getByText('Soil tension readings will appear here when history data is available.')).toBeInTheDocument();
  });
});
