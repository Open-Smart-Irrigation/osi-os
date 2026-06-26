import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { buildNumericRows, DendroGrowthTimelineView, isGrowthSeries } from '../visualizations/DendroGrowthTimelineView';
import type { HistoryCardDataResponse } from '../../../history/types';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverStub;

const { translateForTest } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'history.dendroTimeline.title': 'Growth timeline',
    'history.dendroTimeline.emptyTitle': 'No dendrometer growth data',
    'history.dendroTimeline.emptyBody': 'Dendrometer readings will appear here when history data is available.',
    'history.dendroTimeline.pointsCount': '{{count}} readings',
    'history.dendroTimeline.eventsTitle': 'Timeline events',
    'history.dendroTimeline.noEvents': 'No events in this range',
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
    view: 'growth-timeline',
    range: { label: '7d', from: '2026-05-26T00:00:00Z', to: '2026-06-02T00:00:00Z', timezone: 'UTC' },
    aggregation: {
      level: 'hourly',
      bucketSizeSeconds: 3600,
      coveragePct: 94,
      coverageConfidence: 'configured',
      pointCount: 2,
    },
    limits: { maxPointsPerSeries: 1000, maxEvents: 100, maxInterpretations: 20, truncated: false },
    series: [
      {
        id: 'dendro-stem-change',
        label: 'Stem Change',
        unit: 'um',
        points: [
          { t: '2026-05-30T06:00:00Z', value: 2327, coverageConfidence: 'configured' },
          { t: '2026-06-01T12:00:00Z', value: 2450, coverageConfidence: 'configured' },
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

describe('DendroGrowthTimelineView', () => {
  it('rows carry epoch-ms timestamps for numeric axis clipping', () => {
    const rows = buildNumericRows([
      {
        key: 'growth',
        sourceId: 'growth',
        label: 'Growth',
        unit: 'um',
        points: [{ t: '2026-06-01T00:00:00Z', value: 3 }],
      },
    ]);

    expect(rows[0].tMs).toBe(Date.parse('2026-06-01T00:00:00Z'));
  });

  it('keeps only the growth (µm / stem) series and drops ratio, position, and delta', () => {
    expect(isGrowthSeries({ sourceId: 'dendro_stem_change_um', label: 'Stem Change', unit: 'um' })).toBe(true);
    expect(isGrowthSeries({ sourceId: 'growth', label: 'Growth', unit: 'um' })).toBe(true);
    expect(isGrowthSeries({ sourceId: 'dendro_ratio', label: 'Ratio', unit: '' })).toBe(false);
    expect(isGrowthSeries({ sourceId: 'dendro_position_mm', label: 'Position', unit: 'mm' })).toBe(false);
    expect(isGrowthSeries({ sourceId: 'dendro_delta_mm', label: 'Delta', unit: 'mm' })).toBe(false);
  });

  it('renders only the chart, without title, reading count, stat cards, or events list', () => {
    render(<DendroGrowthTimelineView data={data()} />);

    const chart = screen.getByRole('region', { name: 'Growth timeline' });
    expect(within(chart).queryByText('Growth timeline')).not.toBeInTheDocument();
    expect(within(chart).queryByText(/\breadings\b/i)).not.toBeInTheDocument();
    expect(within(chart).queryByText('Timeline events')).not.toBeInTheDocument();
    expect(within(chart).queryByText('No events in this range')).not.toBeInTheDocument();
    // The view fills its container instead of using a fixed-height chart box.
    expect(chart.className).toMatch(/flex-1/);
  });
});
