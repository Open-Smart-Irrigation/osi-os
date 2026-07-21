import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HistoryCardFrame } from '../HistoryCardFrame';
import type { HistoryCardDataResponse, HistoryCardSummary } from '../../../history/types';

const useHistoryCardDataMock = vi.fn();

const { translateForTest } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'history.cardFrame.typeHistory': '{{cardType}} history',
    'history.cardFrame.viewModes': '{{title}} view modes',
    'history.cardFrame.unavailable': 'This card is not available for the selected zone.',
    'history.cardFrame.timelineBrush': 'Timeline viewport',
    'history.cardFrame.timelineBrushKeyboardHelp':
      'Use arrow keys to pan, plus or minus to zoom, and Home or Enter to reset.',
    'history.cardFrame.aggregationBadge': 'Aggregation: {{aggregation}}',
    'history.cardFrame.placeholderBody': 'Chart and calendar data will load here once card data is available.',
    'history.cardFrame.cardDataLoading': 'Loading card data...',
    'history.cardFrame.cardDataError': 'Card data failed to load: {{message}}',
    'history.cardType.soil': 'Soil',
    'history.source.multipleNamed': '{{count}} sources: {{names}}',
    'history.source.multiple': '{{count}} sources',
    'history.viewMode.soil-profile': 'Soil Profile',
    'history.viewMode.line-chart': 'Line Chart',
    'history.metadata.coverageUnknown': 'Coverage unknown',
    'history.metadata.coverageKnown': '{{coverage}}% coverage',
    'history.metadata.coverageConfidence.configured': 'Configured cadence',
    'history.metadata.syncState.local': 'Local',
    'history.metadata.aggregation.hourly': 'Hourly',
    'history.metadata.range.24h': '24 hours',
    'history.soilProfile.emptyTitle': 'No soil profile data',
    'history.soilProfile.emptyBody': 'Depth-aware profile readings are not available for this range.',
    'history.soilProfile.depthLabel': '{{depth}} cm',
    'history.soilProfile.depthUnknown': 'Depth not set',
    'history.soilProfile.labelUnknown': 'Soil layer {{index}}',
    'history.soilProfile.valueMissing': 'No reading',
    'history.soilProfile.status.dry_stress': 'Dry stress',
    'history.soilProfile.status.optimal': 'Optimal',
    'history.soil.state.wet': 'Wet',
    'history.soil.state.moist': 'Moist',
    'history.soil.state.dry': 'Dry',
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

vi.mock('../../../history/useHistoryCardData', () => ({
  useHistoryCardData: (...args: unknown[]) => useHistoryCardDataMock(...args),
}));

const card: HistoryCardSummary<'soil'> = {
  cardId: 'soil-zone-1',
  cardType: 'soil',
  scope: 'zone',
  title: 'Soil',
  subtitle: 'Root zone tension',
  defaultView: 'soil-profile',
  views: ['soil-profile', 'line-chart'],
  supportedRanges: ['24h', '7d'],
  defaultRange: '24h',
  metadata: {
    coveragePct: 96,
    coverageConfidence: 'configured',
    syncState: 'local',
  },
  sourceDeviceCount: 2,
  sourceLabels: ['Chameleon 1', 'Chameleon 2'],
  sourceDevices: [
    { name: 'Chameleon 1', typeId: 'DRAGINO_LSN50', role: 'soil' },
    { name: 'Chameleon 2', typeId: 'DRAGINO_LSN50', role: 'soil' },
  ],
  availability: { available: true, reasons: [] },
  ordering: { pinned: false, score: 10, recentRank: 1 },
};

function data(overrides: Partial<HistoryCardDataResponse<'soil'>> = {}): HistoryCardDataResponse<'soil'> {
  return {
    cardId: 'soil-zone-1',
    cardType: 'soil',
    view: 'soil-profile',
    range: {
      label: '24h',
      from: '2026-05-30T10:00:00.000Z',
      to: '2026-05-31T10:00:00.000Z',
      timezone: 'UTC',
    },
    aggregation: {
      level: 'hourly',
      bucketSizeSeconds: 3600,
      coveragePct: 96,
      coverageConfidence: 'configured',
      pointCount: 12,
    },
    limits: {
      maxPointsPerSeries: 1000,
      maxEvents: 100,
      maxInterpretations: 20,
      truncated: false,
    },
    series: [],
    profiles: [],
    events: [],
    calendar: null,
    interpretations: [],
    freshness: { dataAsOf: '2026-05-31T10:00:00.000Z', syncState: 'local' },
    advancedFields: {},
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('HistoryCardFrame soil profile', () => {
  it('renders display-safe source names in the card header', () => {
    useHistoryCardDataMock.mockReturnValue({
      data: data(),
      isLoading: false,
      error: null,
    });

    render(<HistoryCardFrame card={card} scope={{ type: 'zone', zoneId: 1 }} />);

    expect(screen.getByText('2 sources: Chameleon 1, Chameleon 2')).toBeInTheDocument();
  });

  it('renders depth-aware profile labels, values, and localized status labels', () => {
    useHistoryCardDataMock.mockReturnValue({
      data: data({
        profiles: [
          { id: 'swt-2', label: 'SWT 2', depthCm: 45, value: 55, unit: 'kPa', status: 'dry_stress' },
          { id: 'swt-1', label: 'Soil 1', depthCm: 15, value: 10, unit: 'kPa', status: 'wet_excess' },
        ],
      }),
      error: undefined,
      isLoading: false,
      refresh: vi.fn(),
    });

    render(<HistoryCardFrame card={card} scope={{ type: 'zone', zoneId: 1 }} />);

    expect(screen.getByText('Soil layer 1')).toBeInTheDocument();
    expect(screen.queryByText('Soil 1')).not.toBeInTheDocument();
    expect(screen.getByText('15 cm')).toBeInTheDocument();
    expect(screen.getByText('10 kPa')).toBeInTheDocument();
    expect(screen.getByText('Wet')).toBeInTheDocument();
    expect(screen.getByTestId('soil-profile-row-0')).toHaveStyle('--soil-row-color: var(--soil-wet)');
    expect(screen.getByText('SWT 2')).toBeInTheDocument();
    expect(screen.getByText('45 cm')).toBeInTheDocument();
    expect(screen.getByText('55 kPa')).toBeInTheDocument();
    expect(screen.getByText('Dry')).toBeInTheDocument();
    expect(screen.getByTestId('soil-profile-row-1')).toHaveStyle('--soil-row-color: var(--soil-dry)');
    expect(screen.queryByText('dry_stress')).not.toBeInTheDocument();
    expect(screen.getByText('Aggregation: Hourly')).toBeInTheDocument();
    expect(screen.queryByText('Aggregation: hourly')).not.toBeInTheDocument();
    expect(screen.getAllByText('24 hours').length).toBeGreaterThan(0);
    expect(screen.queryByText('24h')).not.toBeInTheDocument();
  });

  it('renders an empty profile state when the backend returns no profile points', () => {
    useHistoryCardDataMock.mockReturnValue({
      data: data({ profiles: [] }),
      error: undefined,
      isLoading: false,
      refresh: vi.fn(),
    });

    render(<HistoryCardFrame card={card} scope={{ type: 'zone', zoneId: 1 }} />);

    expect(screen.getByText('No soil profile data')).toBeInTheDocument();
    expect(screen.getByText('Depth-aware profile readings are not available for this range.')).toBeInTheDocument();
  });

  it('renders sparse profile points with safe fallbacks', () => {
    useHistoryCardDataMock.mockReturnValue({
      data: data({
        profiles: [
          {
            id: 'sparse-depth',
            label: '',
            depthCm: undefined,
            value: undefined,
            unit: undefined,
            status: undefined,
          } as unknown as HistoryCardDataResponse<'soil'>['profiles'][number],
          {
            id: '',
            label: 'Deep sensor',
            depthCm: 60,
            value: Number.NaN,
            unit: 'kPa',
            status: '',
          } as unknown as HistoryCardDataResponse<'soil'>['profiles'][number],
        ],
      }),
      error: undefined,
      isLoading: false,
      refresh: vi.fn(),
    });

    render(<HistoryCardFrame card={card} scope={{ type: 'zone', zoneId: 1 }} />);

    expect(screen.getByText('Soil layer 2')).toBeInTheDocument();
    expect(screen.getByText('Depth not set')).toBeInTheDocument();
    expect(screen.getAllByText('No reading').length).toBe(2);
    expect(screen.getByText('Deep sensor')).toBeInTheDocument();
    expect(screen.queryByText(/undefined/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN/i)).not.toBeInTheDocument();
  });

  it('renders card-data loading and error states before the soil profile view', () => {
    useHistoryCardDataMock.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
      refresh: vi.fn(),
    });

    const { rerender } = render(<HistoryCardFrame card={card} scope={{ type: 'zone', zoneId: 1 }} />);

    expect(screen.getByText('Loading card data...')).toBeInTheDocument();

    useHistoryCardDataMock.mockReturnValue({
      data: undefined,
      error: new Error('network unavailable'),
      isLoading: false,
      refresh: vi.fn(),
    });

    rerender(<HistoryCardFrame card={card} scope={{ type: 'zone', zoneId: 1 }} />);

    expect(screen.getByText('Card data failed to load: network unavailable')).toBeInTheDocument();
  });
});
