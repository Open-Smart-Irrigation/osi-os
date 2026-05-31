import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    'history.cardType.irrigation': 'Irrigation',
    'history.viewMode.soil-profile': 'Soil Profile',
    'history.viewMode.line-chart': 'Line Chart',
    'history.viewMode.event-timeline': 'Event Timeline',
    'history.viewMode.calendar': 'Calendar',
    'history.viewMode.irrigation-response': 'Irrigation Response',
    'history.viewMode.advanced': 'Advanced View',
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
    'history.irrigationTimeline.title': 'Irrigation event timeline',
    'history.irrigationTimeline.emptyTitle': 'No irrigation events',
    'history.irrigationTimeline.emptyBody': 'Irrigation actions and response windows will appear here when history data is available.',
    'history.irrigationTimeline.eventsCount': '{{count}} events',
    'history.irrigationTimeline.eventLabel.irrigation': 'Irrigation event',
    'history.irrigationTimeline.eventLabel.scheduled': 'Scheduled irrigation',
    'history.irrigationTimeline.eventLabel.manualOverride': 'Manual override',
    'history.irrigationTimeline.eventLabel.possibleIneffective': 'Possible ineffective irrigation',
    'history.irrigationTimeline.eventLabel.responseWindow': 'Response window',
    'history.irrigationTimeline.detail.duration': 'Duration: {{value}}',
    'history.irrigationTimeline.detail.responseWindow': 'Response window: {{value}}',
    'history.irrigationTimeline.detail.observedResponse': 'Observed response: {{value}}',
    'history.irrigationTimeline.severity.info': 'Info',
    'history.irrigationTimeline.severity.warning': 'Warning',
    'history.irrigationTimeline.severity.critical': 'Critical',
    'history.irrigationTimeline.severity.success': 'Success',
    'history.irrigationTimeline.severity.unknown': 'Info',
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

function irrigationCard(): HistoryCardSummary<'irrigation'> {
  return {
    cardId: 'zone-1:irrigation:zone-valves',
    cardType: 'irrigation',
    scope: 'zone',
    title: 'Irrigation',
    subtitle: 'Valve actions',
    defaultView: 'event-timeline',
    views: ['event-timeline', 'calendar', 'irrigation-response', 'advanced'],
    supportedRanges: ['24h', '7d'],
    defaultRange: '24h',
    metadata: {
      coveragePct: 80,
      coverageConfidence: 'configured',
      syncState: 'local',
      sourceDeviceEui: 'A84041FFFFABCDEF',
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

function historyData(overrides: Partial<HistoryCardDataResponse<'irrigation'>> = {}): HistoryCardDataResponse<'irrigation'> {
  return {
    cardId: 'zone-1:irrigation:zone-valves',
    cardType: 'irrigation',
    view: 'event-timeline',
    range: { label: '24h', from: '2026-05-30T00:00:00Z', to: '2026-05-31T00:00:00Z', timezone: 'UTC' },
    aggregation: {
      level: 'hourly',
      bucketSizeSeconds: 3600,
      coveragePct: 80,
      coverageConfidence: 'configured',
      pointCount: 2,
    },
    limits: { maxPointsPerSeries: 1000, maxEvents: 100, maxInterpretations: 20, truncated: false },
    series: [],
    profiles: [],
    events: [
      {
        id: 'evt-scheduled',
        type: 'irrigation_event_raw',
        t: '2026-05-31T06:00:00Z',
        end: '2026-05-31T06:20:00Z',
        label: 'irrigation_event_raw_A84041FFFFABCDEF',
        severity: 'info',
        metadata: {
          sourceDeviceEui: 'A84041FFFFABCDEF',
          source: 'schedule',
          durationMinutes: 20,
          responseWindowMinutes: 180,
        },
      },
      {
        id: 'evt-manual',
        type: 'manual_override',
        t: '2026-05-31T11:15:00Z',
        label: 'manual_override',
        severity: 'success',
        metadata: {
          source: 'manual',
          durationSeconds: 900,
          observedResponse: 'moisture increased',
        },
      },
      {
        id: 'evt-ineffective',
        type: 'possible_ineffective_irrigation',
        t: '2026-05-31T14:00:00Z',
        label: 'possible_ineffective_irrigation',
        severity: 'warning',
        metadata: {
          expectedResponseWindowMinutes: 240,
        },
      },
    ],
    calendar: null,
    interpretations: [],
    freshness: { dataAsOf: '2026-05-31T15:00:00Z', syncState: 'local' },
    advancedFields: {},
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('HistoryCardFrame irrigation event timeline', () => {
  it('renders safe irrigation event labels, times, severity, duration, and response windows', () => {
    cardData.current = historyData();

    render(<HistoryCardFrame card={irrigationCard()} scope={{ type: 'zone', zoneId: 1 }} />);

    const timeline = screen.getByRole('region', { name: 'Irrigation event timeline' });
    expect(within(timeline).getByText('Irrigation event timeline')).toBeInTheDocument();
    expect(within(timeline).getByText('3 events')).toBeInTheDocument();
    expect(within(timeline).getByText('Scheduled irrigation')).toBeInTheDocument();
    expect(within(timeline).getByText('Manual override')).toBeInTheDocument();
    expect(within(timeline).getByText('Possible ineffective irrigation')).toBeInTheDocument();
    expect(within(timeline).getByText('Info')).toBeInTheDocument();
    expect(within(timeline).getByText('Success')).toBeInTheDocument();
    expect(within(timeline).getByText('Warning')).toBeInTheDocument();
    expect(within(timeline).getByText('Duration: 20 min')).toBeInTheDocument();
    expect(within(timeline).getByText('Duration: 15 min')).toBeInTheDocument();
    expect(within(timeline).getByText('Response window: 3 h')).toBeInTheDocument();
    expect(within(timeline).getByText('Response window: 4 h')).toBeInTheDocument();
    expect(within(timeline).getByText('Observed response: moisture increased')).toBeInTheDocument();
    expect(timeline.querySelector('time[dateTime="2026-05-31T06:00:00Z"]')).toBeInTheDocument();
    expect(screen.queryByText(/irrigation_event_raw|manual_override|possible_ineffective_irrigation/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/A84041FFFFABCDEF|sourceDeviceEui/i)).not.toBeInTheDocument();
  });

  it('renders a stable empty state when irrigation events are missing or malformed', () => {
    cardData.current = historyData({
      events: [
        {
          id: 'evt-invalid',
          type: 'irrigation_event_raw',
          t: 'not-a-date',
          label: undefined,
          severity: 'warning',
          metadata: { durationMinutes: Number.NaN },
        } as unknown as HistoryCardDataResponse<'irrigation'>['events'][number],
      ],
    });

    render(<HistoryCardFrame card={irrigationCard()} scope={{ type: 'zone', zoneId: 1 }} />);

    expect(screen.getByText('No irrigation events')).toBeInTheDocument();
    expect(screen.getByText('Irrigation actions and response windows will appear here when history data is available.')).toBeInTheDocument();
    expect(screen.queryByText(/undefined/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not-a-date|irrigation_event_raw/i)).not.toBeInTheDocument();
  });

  it('keeps non-irrigation cards on the existing placeholder surface', () => {
    cardData.current = undefined;

    render(<HistoryCardFrame card={soilCard()} scope={{ type: 'zone', zoneId: 1 }} />);

    expect(screen.getByText('Chart and calendar data will load here when card data APIs are enabled.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Irrigation event timeline' })).not.toBeInTheDocument();
  });
});
