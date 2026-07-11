import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { buildNumericRows, DendroLineChartView, selectPlottedSeries } from '../visualizations/DendroLineChartView';
import type { HistoryCardDataResponse } from '../../../history/types';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverStub;

const { translateForTest } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'history.dendroLineChart.title': 'Dendro line chart',
    'history.dendroLineChart.emptyTitle': 'No dendrometer line data',
    'history.dendroLineChart.emptyBody': 'Dendrometer readings will appear here when history data is available.',
    'history.dendroLineChart.pointsCount': '{{count}} readings',
    'history.dendroLineChart.series.stemChange': 'Stem change',
    'history.dendroLineChart.series.growth': 'Growth',
    'history.dendroLineChart.series.shrinkage': 'Shrinkage',
    'history.dendroLineChart.series.position': 'Position',
    'history.dendroLineChart.series.dendrometer': 'Dendrometer',
  };

  return {
    translateForTest: (key: string, options?: Record<string, unknown>): string => {
      const template = translations[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''));
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translateForTest }),
}));

function data(): HistoryCardDataResponse<'dendro'> {
  return {
    cardId: 'zone-1:dendro:growth',
    cardType: 'dendro',
    view: 'line-chart',
    range: { label: '24h', from: '2026-06-01T00:00:00Z', to: '2026-06-02T00:00:00Z', timezone: 'UTC' },
    aggregation: {
      level: 'raw',
      bucketSizeSeconds: null,
      coveragePct: 94,
      coverageConfidence: 'configured',
      pointCount: 2,
    },
    limits: { maxPointsPerSeries: 1000, maxEvents: 100, maxInterpretations: 20, truncated: false },
    series: [
      {
        id: 'dendro-src-A84041FFFF123456-stem-change',
        label: 'A84041FFFF123456',
        unit: 'um',
        points: [
          { t: '2026-06-01T06:00:00Z', value: 12, coverageConfidence: 'configured' },
          { t: '2026-06-01T12:00:00Z', value: 16, coverageConfidence: 'configured' },
        ],
      },
    ],
    profiles: [],
    events: [],
    calendar: null,
    interpretations: [],
    freshness: { dataAsOf: '2026-06-01T12:00:00Z', syncState: 'local' },
    advancedFields: {},
  };
}

describe('DendroLineChartView', () => {
  it('rows carry epoch-ms timestamps for numeric axis clipping', () => {
    const rows = buildNumericRows([
      {
        key: 'stem',
        label: 'Stem change',
        unit: 'um',
        source: 'stem',
        points: [{ t: '2026-06-01T00:00:00Z', value: 12 }],
      },
    ]);

    expect(rows[0].tMs).toBe(Date.parse('2026-06-01T00:00:00Z'));
  });

  describe('selectPlottedSeries', () => {
    const series = (source: string) => ({
      key: source, label: source, unit: 'um', source,
      points: [{ t: '2026-07-10T00:00:00.000Z', value: 1 }],
    });

    it('keeps only stem-change series when one exists', () => {
      const picked = selectPlottedSeries([
        series('stem_change_um Stem Change'),
        series('position_mm Position'),
        series('dendro_ratio Ratio'),
        series('delta_mm Delta'),
      ]);
      expect(picked.map((entry) => entry.source)).toEqual(['stem_change_um Stem Change']);
    });

    it('falls back to all series when no stem series exists', () => {
      const input = [series('position_mm Position'), series('dendro_ratio Ratio')];
      expect(selectPlottedSeries(input)).toEqual(input);
    });
  });

  it('renders the line chart without title, reading count, or legend cards', () => {
    render(<DendroLineChartView data={data()} />);

    const chart = screen.getByRole('region', { name: 'Dendro line chart' });
    expect(within(chart).queryByText('Dendro line chart')).not.toBeInTheDocument();
    expect(within(chart).queryByText(/\breadings\b/i)).not.toBeInTheDocument();
    expect(within(chart).queryByText('Stem change')).not.toBeInTheDocument();
    expect(screen.queryByText(/dendro-src-|A84041FFFF123456/i)).not.toBeInTheDocument();
  });
});
