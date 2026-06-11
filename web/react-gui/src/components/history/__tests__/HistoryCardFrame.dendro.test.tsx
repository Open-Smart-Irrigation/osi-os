import '@testing-library/jest-dom';
import React from 'react';
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
    'history.cardType.dendro': 'Dendro',
    'history.viewMode.soil-profile': 'Soil Profile',
    'history.viewMode.line-chart': 'Line Chart',
    'history.viewMode.growth-timeline': 'Growth Timeline',
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
    'history.dendroTimeline.title': 'Growth timeline',
    'history.dendroTimeline.emptyTitle': 'No dendrometer timeline data',
    'history.dendroTimeline.emptyBody': 'Dendrometer readings will appear here when history data is available.',
    'history.dendroTimeline.eventsTitle': 'Timeline events',
    'history.dendroTimeline.eventFallback': 'Dendrometer event',
    'history.dendroTimeline.noEvents': 'No events in this range',
    'history.dendroTimeline.pointsCount': '{{count}} readings',
    'history.dendroTimeline.series.stemChange': 'Stem change',
    'history.dendroTimeline.series.growth': 'Growth',
    'history.dendroTimeline.series.shrinkage': 'Shrinkage',
    'history.dendroTimeline.series.dendrometer': 'Dendrometer',
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

function dendroCard(): HistoryCardSummary<'dendro'> {
  return {
    cardId: 'zone-1:dendro:growth',
    cardType: 'dendro',
    scope: 'zone',
    title: 'Dendrometer',
    subtitle: 'North Block tree growth',
    defaultView: 'growth-timeline',
    views: ['growth-timeline', 'line-chart'],
    supportedRanges: ['24h', '7d'],
    defaultRange: '7d',
    metadata: {
      coveragePct: 82,
      coverageConfidence: 'configured',
      sourceDeviceEui: 'A84041FFFF123456',
    },
    availability: { available: true, reasons: [] },
    ordering: { pinned: true, score: 100, recentRank: 1 },
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

function historyData(overrides: Partial<HistoryCardDataResponse<'dendro'>> = {}): HistoryCardDataResponse<'dendro'> {
  return {
    cardId: 'zone-1:dendro:growth',
    cardType: 'dendro',
    view: 'growth-timeline',
    range: { label: '7d', from: '2026-05-24T00:00:00Z', to: '2026-05-31T00:00:00Z', timezone: 'UTC' },
    aggregation: {
      level: 'hourly',
      bucketSizeSeconds: 3600,
      coveragePct: 82,
      coverageConfidence: 'configured',
      pointCount: 3,
    },
    limits: { maxPointsPerSeries: 1000, maxEvents: 100, maxInterpretations: 20, truncated: false },
    series: [
      {
        id: 'dendro-src-A84041FFFF123456-stem-change',
        label: 'A84041FFFF123456',
        unit: 'um',
        points: [
          { t: '2026-05-30T00:00:00Z', value: 12, coverageConfidence: 'configured' },
          { t: '2026-05-30T12:00:00Z', value: null, coverageConfidence: 'configured' },
          { t: '2026-05-31T00:00:00Z', value: 28, coverageConfidence: 'configured' },
        ],
      },
      {
        id: 'dendro-src-A84041FFFF123456-growth',
        label: 'dendro-src-A84041FFFF123456-growth',
        unit: 'um',
        points: [
          { t: '2026-05-30T00:00:00Z', value: 4, coverageConfidence: 'configured' },
          { t: '2026-05-31T00:00:00Z', value: 7, coverageConfidence: 'configured' },
        ],
      },
      {
        id: 'dendro-src-A84041FFFF123456-shrinkage',
        label: 'shrinkage_raw',
        unit: 'um',
        points: [{ t: '2026-05-30T12:00:00Z', value: -3, coverageConfidence: 'configured' }],
      },
    ],
    profiles: [],
    events: [
      {
        id: 'evt-1',
        type: 'dendro_stress_window',
        t: '2026-05-30T12:00:00Z',
        label: 'Midday shrinkage',
        severity: 'warning',
        metadata: { sourceDeviceEui: 'A84041FFFF123456' },
      },
    ],
    calendar: null,
    interpretations: [],
    freshness: { dataAsOf: '2026-05-31T00:00:00Z', syncState: 'local' },
    advancedFields: {},
    ...overrides,
  };
}

describe('HistoryCardFrame Dendro growth timeline', () => {
  it('renders the dendrometer growth chart without exposing raw hardware identifiers', () => {
    cardData.current = historyData();

    render(<HistoryCardFrame card={dendroCard()} scope={{ type: 'zone', zoneId: 1 }} />);

    // The decluttered growth view is chart-only (event markers render without text).
    expect(screen.getByRole('region', { name: 'Growth timeline' })).toBeInTheDocument();
    expect(screen.queryByText(/dendro-src-/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/A84041FFFF123456/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/dendro_stress_window/i)).not.toBeInTheDocument();
  });

  it('renders a stable empty state when dendrometer series are missing', () => {
    cardData.current = historyData({ series: [], events: [] });

    render(<HistoryCardFrame card={dendroCard()} scope={{ type: 'zone', zoneId: 1 }} />);

    expect(screen.getByText('No dendrometer timeline data')).toBeInTheDocument();
    expect(screen.getByText('Dendrometer readings will appear here when history data is available.')).toBeInTheDocument();
  });

  it('renders a stable empty state when dendrometer series payloads are sparse', () => {
    const sparseSeries = [
      {
        id: 'dendro-src-A84041FFFF123456-stem-change',
        label: 'A84041FFFF123456',
        unit: 'um',
        points: null,
      },
      {
        id: 'bad',
        label: 'raw_label',
        points: [
          null,
          { t: '', value: 18, coverageConfidence: 'unknown' },
          { t: 'A84041FFFF123456', value: 22, coverageConfidence: 'unknown' },
          { t: '2026-05-30T00:00:00Z', value: 'not-a-number', coverageConfidence: 'unknown' },
        ],
      },
    ] as unknown as HistoryCardDataResponse<'dendro'>['series'];
    cardData.current = historyData({ series: sparseSeries, events: [] });

    render(<HistoryCardFrame card={dendroCard()} scope={{ type: 'zone', zoneId: 1 }} />);

    expect(screen.getByText('No dendrometer timeline data')).toBeInTheDocument();
    expect(screen.queryByText(/A84041FFFF123456/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/raw_label/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/undefined/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN/i)).not.toBeInTheDocument();
  });

  it('does not leak raw identifiers from sparse dendrometer events', () => {
    cardData.current = historyData({
      events: [
        null,
        {
          id: 'evt-raw',
          type: 'dendro_stress_window',
          t: '2026-05-30T12:00:00Z',
          label: 'dendro-src-A84041FFFF123456-growth',
          severity: 'warning',
          metadata: { sourceDeviceEui: 'A84041FFFF123456' },
        },
        {
          id: 'evt-invalid-time',
          type: 'dendro_stress_window',
          t: 'A84041FFFF123456',
          label: 'Raw invalid time',
          severity: 'warning',
          metadata: {},
        },
      ] as unknown as HistoryCardDataResponse<'dendro'>['events'],
    });

    render(<HistoryCardFrame card={dendroCard()} scope={{ type: 'zone', zoneId: 1 }} />);

    expect(screen.getByRole('region', { name: 'Growth timeline' })).toBeInTheDocument();
    expect(screen.queryByText(/dendro-src-/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/A84041FFFF123456/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Raw invalid time/i)).not.toBeInTheDocument();
  });

  it('keeps non-dendro cards on the existing placeholder surface', () => {
    cardData.current = undefined;

    render(
      <HistoryCardFrame
        card={soilCard()}
        scope={{ type: 'zone', zoneId: 1 }}
      />,
    );

    expect(screen.getByText('Chart and calendar data will load here when card data APIs are enabled.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Growth timeline' })).not.toBeInTheDocument();
  });
});
