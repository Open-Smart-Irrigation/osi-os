import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HistoryCardVisualization } from '../HistoryCardVisualization';
import type { HistoryCardDataResponse, HistoryCardSummary, HistoryViewMode } from '../../../history/types';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverStub;

const { translateForTest } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'history.cardFrame.placeholderBody': 'Chart and calendar data will load here when card data APIs are enabled.',
    'history.cardFrame.cardDataLoading': 'Loading card data...',
    'history.viewMode.line-chart': 'Line Chart',
    'history.viewMode.irrigation-response': 'Irrigation Response',
    'history.viewMode.stress-events': 'Stress Events',
    'history.soilLineChart.title': 'Soil line chart',
    'history.soilLineChart.emptyTitle': 'No soil trend data',
    'history.soilLineChart.emptyBody': 'Soil tension readings will appear here when history data is available.',
    'history.soilIrrigationResponse.title': 'Soil irrigation response',
    'history.soilIrrigationResponse.emptyTitle': 'No irrigation response events',
    'history.soilIrrigationResponse.emptyBody': 'No irrigation response events in this range.',
    'history.soilIrrigationResponse.eventsCount': '{{count}} irrigation events',
    'history.dendroLineChart.title': 'Dendro line chart',
    'history.dendroLineChart.emptyTitle': 'No dendrometer line data',
    'history.dendroLineChart.emptyBody': 'Dendrometer readings will appear here when history data is available.',
    'history.dendroStressEvents.title': 'Dendro stress events',
    'history.dendroStressEvents.emptyTitle': 'No stress events',
    'history.dendroStressEvents.emptyBody': 'No stress events in this range.',
    'history.dendroStressEvents.eventsCount': '{{count}} stress events',
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

function card(
  cardType: 'soil' | 'dendro',
  selectedView: HistoryViewMode,
): HistoryCardSummary<'soil' | 'dendro'> {
  return {
    cardId: `zone-1:${cardType}:source`,
    cardType,
    scope: 'zone',
    title: cardType === 'soil' ? 'Soil' : 'Dendro',
    subtitle: '',
    defaultView: selectedView as any,
    views: [selectedView as any],
    supportedRanges: ['24h'],
    defaultRange: '24h',
    metadata: {
      coveragePct: null,
      coverageConfidence: 'unknown',
    },
    availability: { available: true, reasons: [] },
    ordering: { pinned: false, score: 0, recentRank: null },
  };
}

function data(
  cardType: 'soil' | 'dendro',
  view: HistoryViewMode,
  hasSeries = false,
): HistoryCardDataResponse<'soil' | 'dendro'> {
  return {
    cardId: `zone-1:${cardType}:source`,
    cardType,
    view: view as any,
    range: { label: '24h', from: '2026-05-30T00:00:00Z', to: '2026-05-31T00:00:00Z', timezone: 'UTC' },
    aggregation: {
      level: 'raw',
      bucketSizeSeconds: null,
      coveragePct: null,
      coverageConfidence: 'unknown',
      pointCount: 0,
    },
    limits: { maxPointsPerSeries: 1000, maxEvents: 100, maxInterpretations: 20, truncated: false },
    series: hasSeries
      ? [
          {
            id: 'soil-1',
            label: 'Soil 1',
            unit: 'kPa',
            points: [
              { t: '2026-05-30T06:00:00Z', value: 42, coverageConfidence: 'unknown' },
              { t: '2026-05-30T12:00:00Z', value: 48, coverageConfidence: 'unknown' },
            ],
          },
        ]
      : [],
    profiles: [],
    events: [],
    calendar: null,
    interpretations: [],
    freshness: { dataAsOf: null, syncState: 'local' },
    advancedFields: {},
  };
}

describe('History placeholder view replacements', () => {
  it.each([
    ['soil', 'line-chart', 'Soil line chart'],
    ['soil', 'irrigation-response', 'Soil irrigation response'],
    ['dendro', 'line-chart', 'Dendro line chart'],
    ['dendro', 'stress-events', 'Dendro stress events'],
  ] as const)('renders a concrete %s %s view instead of the generic placeholder', (cardType, selectedView, label) => {
    render(
      <HistoryCardVisualization
        card={card(cardType, selectedView)}
        data={data(cardType, selectedView)}
        selectedView={selectedView}
      />,
    );

    expect(screen.getByRole('region', { name: label })).toBeInTheDocument();
    expect(
      screen.queryByText('Chart and calendar data will load here when card data APIs are enabled.'),
    ).not.toBeInTheDocument();
  });

  it('keeps Soil Irrigation Response in its empty state for generic interpretations', () => {
    render(
      <HistoryCardVisualization
        card={card('soil', 'irrigation-response')}
        data={{
          ...data('soil', 'irrigation-response'),
          interpretations: [
            {
              id: 'coverage-gap',
              source: 'local-rule',
              severity: 'warning',
              title: 'Sensor data missing during selected period.',
              evidence: [{ type: 'coverage', coveragePct: 42 }],
              confidence: null,
            },
          ],
        }}
        selectedView="irrigation-response"
      />,
    );

    expect(screen.getByText('No irrigation response events')).toBeInTheDocument();
    expect(screen.queryByText('0 irrigation events')).not.toBeInTheDocument();
  });

  it('keeps Dendro Stress Events in its empty state for generic interpretations', () => {
    render(
      <HistoryCardVisualization
        card={card('dendro', 'stress-events')}
        data={{
          ...data('dendro', 'stress-events'),
          interpretations: [
            {
              id: 'coverage-gap',
              source: 'local-rule',
              severity: 'warning',
              title: 'Sensor data missing during selected period.',
              evidence: [{ type: 'coverage', coveragePct: 42 }],
              confidence: null,
            },
          ],
        }}
        selectedView="stress-events"
      />,
    );

    expect(screen.getByText('No stress events')).toBeInTheDocument();
    expect(screen.queryByText('0 stress events')).not.toBeInTheDocument();
  });

  it('keeps previous chart data mounted while a refetch is loading', () => {
    render(
      <HistoryCardVisualization
        card={card('soil', 'line-chart')}
        data={data('soil', 'line-chart', true)}
        selectedView="line-chart"
        isLoading
      />,
    );

    expect(screen.getByRole('region', { name: 'Soil line chart' })).toBeInTheDocument();
    expect(screen.queryByText('Loading card data...')).not.toBeInTheDocument();
  });

  it('does not render stale chart data from a different card while loading', () => {
    render(
      <HistoryCardVisualization
        card={card('soil', 'line-chart')}
        data={{
          ...data('soil', 'line-chart', true),
          cardId: 'zone-1:soil:other-source',
        }}
        selectedView="line-chart"
        isLoading
      />,
    );

    expect(screen.getByText('Loading card data...')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Soil line chart' })).not.toBeInTheDocument();
  });
});
