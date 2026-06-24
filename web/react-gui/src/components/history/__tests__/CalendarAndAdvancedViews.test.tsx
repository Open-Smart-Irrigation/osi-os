import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdvancedViewPanel } from '../AdvancedViewPanel';
import { CalendarView } from '../CalendarView';
import { HistoryCardFrame } from '../HistoryCardFrame';
import type {
  HistoryAdvancedResponse,
  HistoryCalendar,
  HistoryCardDataResponse,
  HistoryCardSummary,
} from '../../../history/types';

const useHistoryCardDataMock = vi.fn();
const useHistoryCardAdvancedDataMock = vi.fn();

const { translateForTest } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'history.cardFrame.typeHistory': '{{cardType}} history',
    'history.cardFrame.viewModes': '{{title}} view modes',
    'history.cardFrame.unavailable': 'This card is not available for the selected zone.',
    'history.cardFrame.timelineBrush': 'Timeline viewport',
    'history.cardFrame.timelineBrushKeyboardHelp':
      'Use arrow keys to pan, plus or minus to zoom, and Home or Enter to reset.',
    'history.cardFrame.aggregationBadge': 'Aggregation: {{aggregation}}',
    'history.cardFrame.placeholderBody': 'Chart and calendar data will load here when card data APIs are enabled.',
    'history.cardType.soil': 'Soil',
    'history.viewMode.calendar': 'Calendar',
    'history.viewMode.advanced': 'Advanced View',
    'history.metadata.coverageKnown': '{{coverage}}% coverage',
    'history.metadata.coverageUnknown': 'Coverage unknown',
    'history.metadata.coverageConfidence.configured': 'Configured cadence',
    'history.metadata.syncState.local': 'Local',
    'history.metadata.aggregation.daily': 'Daily',
    'history.calendar.title': 'Calendar',
    'history.calendar.emptyTitle': 'No calendar data',
    'history.calendar.weekday.mon': 'Mon',
    'history.calendar.weekday.tue': 'Tue',
    'history.calendar.weekday.wed': 'Wed',
    'history.calendar.weekday.thu': 'Thu',
    'history.calendar.weekday.fri': 'Fri',
    'history.calendar.weekday.sat': 'Sat',
    'history.calendar.weekday.sun': 'Sun',
    'history.calendar.state.no_data': 'No data',
    'history.calendar.state.dry_stress': 'Dry stress',
    'history.calendar.state.optimal': 'Optimal',
    'history.calendar.summary.soil.no_data': 'No soil data',
    'history.calendar.summary.soil.dry_stress': '{{sampleCount}} samples showed dry stress',
    'history.calendar.summary.soil.optimal': '{{sampleCount}} samples looked optimal',
    'history.calendar.marker.soil.dry_stress': 'Dry stress marker',
    'history.interpretation.title': 'Local interpretation',
    'history.interpretation.rootZoneDry.title': 'Root zone dry',
    'history.interpretation.rootZoneDry.body': 'Dry for {{hoursDry}} hours',
    'history.advanced.title': 'Advanced diagnostics',
    'history.advanced.loading': 'Loading advanced diagnostics...',
    'history.advanced.emptyTitle': 'No advanced diagnostics',
    'history.advanced.field.primaryDeveui': 'Device EUI',
    'history.advanced.field.rssi': 'RSSI',
    'history.advanced.field.rawPayload': 'Raw payload',
    'history.advanced.availability.collected': 'Collected',
    'history.advanced.availability.not_collected_at_time': 'Not collected then',
    'history.advanced.availability.unknown_now': 'Unknown now',
    'history.advanced.availability.unsupported': 'Unsupported',
    'history.advanced.value.unavailable': 'Unavailable',
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

vi.mock('../../../history/useHistoryCardData', () => ({
  useHistoryCardData: (...args: unknown[]) => useHistoryCardDataMock(...args),
}));

vi.mock('../../../history/useHistoryCardAdvancedData', () => ({
  useHistoryCardAdvancedData: (...args: unknown[]) => useHistoryCardAdvancedDataMock(...args),
}));

function calendar(): HistoryCalendar {
  return {
    timezone: 'Europe/Zurich',
    days: [
      {
        date: '2026-05-31',
        state: 'dry_stress',
        coveragePct: 92,
        coverageConfidence: 'configured',
        summary: {
          key: 'history.calendar.summary.soil.dry_stress',
          params: { sampleCount: 8 },
        },
        metrics: { sampleCount: 8, eventCount: 1 },
        markers: [
          {
            type: 'state',
            severity: 'warning',
            labelKey: 'history.calendar.marker.soil.dry_stress',
            params: {},
          },
        ],
      },
      {
        date: '2026-05-30',
        state: 'optimal',
        coveragePct: null,
        coverageConfidence: 'unknown',
        summary: {
          key: 'history.calendar.summary.soil.optimal',
          params: { sampleCount: 3 },
        },
        metrics: { sampleCount: 3, eventCount: 0 },
        markers: [],
      },
    ],
  };
}

function card(): HistoryCardSummary<'soil'> {
  return {
    cardId: 'zone-1:soil:root-zone',
    cardType: 'soil',
    scope: 'zone',
    title: 'Soil',
    subtitle: 'Root zone tension',
    defaultView: 'calendar',
    views: ['calendar', 'advanced'],
    supportedRanges: ['7d'],
    defaultRange: '7d',
    metadata: { coveragePct: 90, coverageConfidence: 'configured', syncState: 'local' },
    availability: { available: true, reasons: [] },
    ordering: { pinned: false, score: 0, recentRank: null },
  };
}

function data(): HistoryCardDataResponse<'soil'> {
  return {
    cardId: 'zone-1:soil:root-zone',
    cardType: 'soil',
    view: 'calendar',
    range: {
      label: '7d',
      from: '2026-05-25T00:00:00.000Z',
      to: '2026-06-01T00:00:00.000Z',
      timezone: 'Europe/Zurich',
    },
    aggregation: {
      level: 'daily',
      bucketSizeSeconds: 86400,
      coveragePct: 90,
      coverageConfidence: 'configured',
      pointCount: 2,
    },
    limits: { maxPointsPerSeries: 1000, maxEvents: 100, maxInterpretations: 20, truncated: false },
    series: [],
    profiles: [],
    events: [],
    calendar: calendar(),
    interpretations: [
      {
        id: 'root-zone-dry',
        ruleId: 'root-zone-dry',
        source: 'local-rule',
        severity: 'warning',
        titleKey: 'history.interpretation.rootZoneDry.title',
        bodyKey: 'history.interpretation.rootZoneDry.body',
        params: { hoursDry: 9 },
        evidence: [],
        confidence: null,
      },
    ],
    freshness: { dataAsOf: '2026-05-31T09:00:00.000Z', syncState: 'local' },
    advancedFields: {},
  };
}

function advanced(): HistoryAdvancedResponse<'soil'> {
  return {
    generatedAt: '2026-05-31T09:00:00.000Z',
    cardId: 'zone-1:soil:root-zone',
    cardType: 'soil',
    range: data().range,
    freshness: data().freshness,
    aggregation: data().aggregation,
    placeholder: { schemaVersion: 1, cardType: 'soil', placeholder: true, generatedAt: '2026-05-31T09:00:00.000Z' },
    advancedFields: {
      primaryDeveui: {
        field: 'primaryDeveui',
        value: 'A84041FFFF123456',
        unit: null,
        availability: 'collected',
      },
      rssi: { field: 'rssi', value: -113, unit: 'dBm', availability: 'collected' },
      rawPayload: { field: 'rawPayload', value: null, unit: null, availability: 'not_collected_at_time' },
    },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CalendarView', () => {
  it('renders backend-provided states in a month grid without recomputing labels', () => {
    const onInspectDate = vi.fn();
    render(<CalendarView cardType="soil" calendar={calendar()} onInspectDate={onInspectDate} />);

    const region = screen.getByRole('region', { name: 'Calendar' });
    expect(within(region).getByRole('grid', { name: /May 2026/i })).toBeInTheDocument();
    expect(within(region).getByRole('columnheader', { name: 'Mon' })).toBeInTheDocument();
    expect(within(region).getByText('Europe/Zurich')).toBeInTheDocument();
    expect(within(region).getByRole('gridcell', { name: /Dry stress/i })).toHaveAttribute('data-state', 'dry_stress');
    expect(within(region).getByRole('gridcell', { name: /Optimal/i })).toHaveAttribute('data-state', 'optimal');
    expect(within(region).queryByText('dry_stress')).not.toBeInTheDocument();
    const may31 = within(region).getByRole('gridcell', { name: /May 31/i });
    expect(may31).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(may31);
    expect(may31).toHaveAttribute('aria-selected', 'true');
    expect(onInspectDate).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-05-31' }));
  });
});

describe('AdvancedViewPanel', () => {
  it('renders raw diagnostics and availability labels only inside the advanced panel', () => {
    render(<AdvancedViewPanel data={advanced()} isLoading={false} />);

    const region = screen.getByRole('region', { name: 'Advanced diagnostics' });
    expect(within(region).getByText('Device EUI')).toBeInTheDocument();
    expect(within(region).getByText('A84041FFFF123456')).toBeInTheDocument();
    expect(within(region).getByText('RSSI')).toBeInTheDocument();
    expect(within(region).getByText('-113 dBm')).toBeInTheDocument();
    expect(within(region).getByText('Raw payload')).toBeInTheDocument();
    expect(within(region).getByText('Not collected then')).toBeInTheDocument();
  });
});

describe('HistoryCardFrame calendar and advanced views', () => {
  it('renders calendar and interpretations by default without exposing advanced diagnostics', () => {
    useHistoryCardDataMock.mockReturnValue({ data: data(), error: undefined, isLoading: false, refresh: vi.fn() });
    useHistoryCardAdvancedDataMock.mockReturnValue({ data: undefined, error: undefined, isLoading: false, refresh: vi.fn() });

    render(<HistoryCardFrame card={card()} scope={{ type: 'zone', zoneId: 1 }} />);

    expect(screen.getByText('Dry stress')).toBeInTheDocument();
    expect(screen.getByText('Root zone dry')).toBeInTheDocument();
    expect(screen.getByText('Dry for 9 hours')).toBeInTheDocument();
    expect(screen.queryByText('A84041FFFF123456')).not.toBeInTheDocument();
    expect(useHistoryCardAdvancedDataMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('fetches and renders advanced diagnostics only after Advanced View is selected', () => {
    useHistoryCardDataMock.mockReturnValue({ data: data(), error: undefined, isLoading: false, refresh: vi.fn() });
    useHistoryCardAdvancedDataMock.mockReturnValue({ data: advanced(), error: undefined, isLoading: false, refresh: vi.fn() });

    render(<HistoryCardFrame card={card()} scope={{ type: 'zone', zoneId: 1 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Advanced View' }));

    expect(useHistoryCardAdvancedDataMock).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
    expect(screen.getByRole('region', { name: 'Advanced diagnostics' })).toBeInTheDocument();
    expect(screen.getByText('A84041FFFF123456')).toBeInTheDocument();
  });
});
