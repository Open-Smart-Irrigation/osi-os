import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { SWRConfig } from 'swr';

import App from '../../../App';
import { historyAPI, irrigationZonesAPI, systemAPI } from '../../../services/api';
import type { HistoryCardSummary } from '../../../history/types';

const { translateForTest } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'history.detail.backToHistory': 'Back to history',
    'history.detail.invalidRouteTitle': 'History card not available',
    'history.detail.invalidRouteBody': 'Return to History and choose an available card.',
    'history.detail.loading': 'Loading history card...',
    'history.detail.notFoundTitle': 'History card not available',
    'history.detail.notFoundBody': 'Return to History and choose an available card.',
    'history.detail.controlsPlaceholder': 'Date range',
    'history.detail.inspectorPlaceholder': 'Inspector',
    'history.detail.rangeControlLabel': 'Date range',
    'history.detail.viewControlLabel': 'View',
    'history.detail.visualizationLabel': 'History visualization',
    'history.detail.visualizationHelp': 'Drag to pan, pinch to zoom, double tap to reset, or long press to inspect.',
    'history.sourceFilter.label': 'Source',
    'history.sourceFilter.all': 'All',
    'history.rangeShort.12h': '12h',
    'history.rangeShort.24h': '24h',
    'history.rangeShort.7d': '7D',
    'history.rangeShort.30d': '30D',
    'history.rangeShort.season': 'Season',
    'history.source.multipleNamed': '{{count}} sources: {{names}}',
    'history.source.multiple': '{{count}} sources',
    'history.cardFrame.emptyTitle': 'Select a history card',
    'history.cardFrame.emptyBody': 'Choose a zone and thematic card to inspect local history.',
    'history.cardFrame.typeHistory': '{{cardType}} history',
    'history.cardFrame.viewModes': '{{title}} view modes',
    'history.cardFrame.unavailable': 'This card is not available for the selected zone.',
    'history.cardFrame.timelineBrush': 'Timeline viewport',
    'history.cardFrame.timelineBrushKeyboardHelp': 'Use arrow keys to pan, plus or minus to zoom, and Home or Enter to reset.',
    'history.cardFrame.aggregationBadge': 'Aggregation: {{aggregation}}',
    'history.cardFrame.placeholderBody': 'Chart and calendar data will load here when card data APIs are enabled.',
    'history.cardFrame.cardDataLoading': 'Loading card data...',
    'history.cardFrame.cardDataError': 'Card data failed to load: {{message}}',
    'history.cardFrame.cardDataUnknownError': 'Unknown error',
    'history.cardType.soil': 'Soil',
    'history.cardType.gateway': 'Gateway',
    'history.viewMode.soil-profile': 'Soil Profile',
    'history.viewMode.line-chart': 'Line Chart',
    'history.viewMode.calendar': 'Calendar',
    'history.viewMode.status-overview': 'Status Overview',
    'history.viewMode.advanced': 'Advanced View',
    'history.metadata.coverageUnknown': 'Coverage unknown',
    'history.metadata.coverageKnown': '{{coverage}}% coverage',
    'history.metadata.coverageConfidence.configured': 'Configured cadence',
    'history.metadata.coverageConfidence.unknown': 'Cadence unknown',
    'history.metadata.syncState.local': 'Local',
    'history.metadata.syncState.synced': 'Synced',
    'history.metadata.syncState.unknown': 'Unknown',
    'history.metadata.aggregation.raw': 'Raw',
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
    'history.calendar.marker.soil.dry_stress': 'Dry stress marker',
    'history.calendar.summary.soil.optimal': 'Root zone was optimal.',
    'history.calendar.summary.soil.dry_stress': 'Root zone was dry with {{sampleCount}} samples.',
    'history.soilProfile.emptyTitle': 'No soil profile data',
    'history.soilProfile.emptyBody': 'Depth-aware profile readings are not available for this range.',
    'history.gatewayStatus.title': 'Gateway status overview',
    'history.gatewayStatus.emptyTitle': 'Limited gateway status data',
    'history.gatewayStatus.emptyBody': 'Gateway status details will appear here as the hub reports them.',
    'history.gatewayStatus.eventsTitle': 'Recent gateway events',
    'history.gatewayStatus.noEvents': 'No gateway events in this range.',
    'history.gatewayStatus.value.unavailable': 'Not reported',
    'history.gatewayStatus.status.online': 'Online',
    'history.gatewayStatus.category.system': 'System',
    'history.gatewayStatus.metric.cpu': 'CPU',
  };

  return {
    translateForTest: (key: string, options?: Record<string, unknown>): string => {
      const template = translations[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''));
    },
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: translateForTest,
  }),
}));

vi.mock('../../../components/LanguageSwitcher', () => ({
  LanguageSwitcher: () => React.createElement('div', null, 'Language'),
}));

vi.mock('../../../services/api', () => ({
  systemAPI: {
    getFeatures: vi.fn(),
  },
  historyAPI: {
    getZoneCards: vi.fn(),
    getGatewayCards: vi.fn(),
    getZoneCardData: vi.fn(),
    getGatewayCardData: vi.fn(),
    markZoneCardOpened: vi.fn(),
  },
  irrigationZonesAPI: {
    getAll: vi.fn(),
  },
  authAPI: {
    login: vi.fn(),
    register: vi.fn(),
  },
}));

const historyAPIMock = historyAPI as typeof historyAPI & {
  getGatewayCards: Mock;
  getZoneCardData: Mock;
};

function firstZoneCardDataRequest() {
  return historyAPIMock.getZoneCardData.mock.calls[0]?.[2];
}

function preparePointerTarget(element: HTMLElement, scrollTop = 0) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      width: 320,
      height: 240,
      right: 320,
      bottom: 240,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    writable: true,
    value: scrollTop,
  });
  element.setPointerCapture = vi.fn();
  element.releasePointerCapture = vi.fn();
}

function pointerDrag(
  element: HTMLElement,
  {
    fromX = 160,
    toX = fromX,
    fromY,
    toY,
    pointerType = 'touch',
  }: { fromX?: number; toX?: number; fromY: number; toY: number; pointerType?: string },
) {
  fireEvent.pointerDown(element, { pointerId: 1, pointerType, clientX: fromX, clientY: fromY });
  fireEvent.pointerMove(element, { pointerId: 1, pointerType, clientX: toX, clientY: toY });
  fireEvent.pointerUp(element, { pointerId: 1, pointerType, clientX: toX, clientY: toY });
}

function renderAppAtRoute(hashRoute: string) {
  window.history.replaceState(null, '', `#${hashRoute}`);

  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <App />
    </SWRConfig>,
  );
}

function zoneCard(overrides: Partial<HistoryCardSummary> = {}): HistoryCardSummary {
  return {
    cardId: 'soil-card:root-zone',
    cardType: 'soil',
    scope: 'zone',
    title: 'Soil - Root Zone',
    subtitle: 'North Block',
    defaultView: 'soil-profile',
    views: ['soil-profile'],
    supportedRanges: ['24h', '7d'],
    defaultRange: '24h',
    sourceLabels: ['Chameleon 1'],
    metadata: {
      coveragePct: 96,
      coverageConfidence: 'configured',
      sourceDeviceEui: 'ABCDEF0123456789',
    },
    availability: {
      available: true,
      reasons: [],
    },
    ordering: {
      pinned: false,
      score: 10,
      recentRank: 1,
    },
    ...overrides,
  };
}

function gatewayCard(overrides: Partial<HistoryCardSummary> = {}): HistoryCardSummary {
  return {
    cardId: '0016C001F11766E7:gateway:hub',
    cardType: 'gateway',
    scope: 'gateway',
    title: 'Gateway',
    subtitle: 'Hub status',
    defaultView: 'status-overview',
    views: ['status-overview'],
    supportedRanges: ['24h', '7d'],
    defaultRange: '24h',
    metadata: {
      coveragePct: 100,
      coverageConfidence: 'unknown',
      gatewayDeviceEui: '0016C001F11766E7',
      syncState: 'synced',
    },
    availability: {
      available: true,
      reasons: [],
    },
    ordering: {
      pinned: false,
      score: 10,
      recentRank: 1,
    },
    ...overrides,
  };
}

describe('History card detail route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem('auth_token', 'test-token');
    window.localStorage.setItem('username', 'operator');
    vi.mocked(systemAPI.getFeatures).mockResolvedValue({
      historyUxEnabled: true,
      historyComparisonEnabled: false,
      historyWorkspacesEnabled: false,
      historyAdvancedOverlaysEnabled: false,
      historyCloudAiEnabled: false,
    });
    vi.mocked(irrigationZonesAPI.getAll).mockResolvedValue([
      {
        id: 12,
        name: 'North Block',
        device_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        schedule: null,
      },
    ]);
    vi.mocked(historyAPI.getZoneCards).mockResolvedValue({
      zoneId: 12,
      generatedAt: '2026-05-31T10:00:00Z',
      cards: [zoneCard()],
    });
    vi.mocked(historyAPIMock.getGatewayCards).mockResolvedValue({
      gatewayEui: '0016C001F11766E7',
      generatedAt: '2026-05-31T10:00:00Z',
      cards: [
        gatewayCard({
          title: 'Gateway 0016C001F11766E7',
          subtitle: 'Hub 0016C001F11766E7',
          sourceLabels: ['0016C001F11766E7'],
        }),
      ],
    });
    vi.mocked(historyAPI.getZoneCardData).mockResolvedValue({
      cardId: 'soil-card:root-zone',
      cardType: 'soil',
      view: 'soil-profile',
      range: {
        label: '24h',
        from: '2026-05-30T10:00:00.000Z',
        to: '2026-05-31T10:00:00.000Z',
        timezone: 'UTC',
      },
      aggregation: {
        level: 'raw',
        bucketSizeSeconds: null,
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
    });
    vi.mocked(historyAPI.getGatewayCardData).mockResolvedValue({
      cardId: 'gateway:hub',
      cardType: 'gateway',
      view: 'status-overview',
      range: {
        label: '24h',
        from: '2026-05-30T10:00:00.000Z',
        to: '2026-05-31T10:00:00.000Z',
        timezone: 'UTC',
      },
      aggregation: {
        level: 'raw',
        bucketSizeSeconds: null,
        coveragePct: 100,
        coverageConfidence: 'unknown',
        pointCount: 1,
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
      freshness: { dataAsOf: '2026-05-31T10:00:00.000Z', syncState: 'synced' },
      advancedFields: {},
    });
    vi.mocked(historyAPI.markZoneCardOpened).mockResolvedValue({
      cardId: 'soil-card:root-zone',
      scope: 'zone',
      pinned: false,
      manualOrder: null,
      openCount: 1,
      lastOpenedAt: '2026-05-31T10:01:00.000Z',
      lastViewMode: null,
      hidden: false,
      updatedAt: '2026-05-31T10:01:00.000Z',
    });
  });

  it('loads the route-backed full-screen detail by zone and encoded card id', async () => {
    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    expect(await screen.findByRole('heading', { level: 1, name: 'Soil - Root Zone' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to history/i })).toHaveAttribute('href', '#/history');
    expect(screen.getAllByText('Chameleon 1').length).toBeGreaterThan(0);
    expect(screen.queryByText('ABCDEF0123456789')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(historyAPI.markZoneCardOpened).toHaveBeenCalledWith(12, 'soil-card:root-zone');
    });
  });

  it('shows a safe not-found state when the card id is not in the selected zone', async () => {
    renderAppAtRoute('/history/zones/12/cards/missing-card');

    expect(await screen.findByText(/History card not available/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to history/i })).toHaveAttribute('href', '#/history');
    expect(screen.queryByText(/[A-F0-9]{16}/)).not.toBeInTheDocument();
    expect(historyAPI.markZoneCardOpened).not.toHaveBeenCalled();
  });

  it('uses gateway card data when a zone card resolves to gateway scope', async () => {
    vi.mocked(historyAPI.getZoneCards).mockResolvedValue({
      zoneId: 12,
      generatedAt: '2026-05-31T10:00:00Z',
      cards: [
        zoneCard({
          cardId: 'gateway:hub',
          cardType: 'gateway',
          scope: 'gateway',
          title: 'Gateway',
          subtitle: 'Hub status',
          defaultView: 'status-overview',
          views: ['status-overview'],
          sourceLabels: [],
          metadata: {
            coveragePct: 100,
            coverageConfidence: 'unknown',
            gatewayDeviceEui: '0016C001F11766E7',
            syncState: 'synced',
          },
        }),
      ],
    });

    renderAppAtRoute('/history/zones/12/cards/gateway%3Ahub');

    expect(await screen.findByRole('heading', { level: 1, name: 'Gateway' })).toBeInTheDocument();
    await waitFor(() => {
      expect(historyAPI.getGatewayCardData).toHaveBeenCalled();
    });
    expect(screen.queryByText(/[A-F0-9]{16}/)).not.toBeInTheDocument();
  });

  it('loads a hub-scoped gateway card through the gateway route without requiring a zone', async () => {
    renderAppAtRoute('/history/gateways/0016C001F11766E7/cards/0016C001F11766E7%3Agateway%3Ahub');

    expect(await screen.findByRole('heading', { level: 1, name: 'Gateway' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to history/i })).toHaveAttribute('href', '#/history');
    await waitFor(() => {
      expect(historyAPIMock.getGatewayCards).toHaveBeenCalledWith('0016C001F11766E7');
      expect(historyAPI.getGatewayCardData).toHaveBeenCalled();
    });
    expect(irrigationZonesAPI.getAll).not.toHaveBeenCalled();
    expect(historyAPI.getZoneCards).not.toHaveBeenCalled();
    expect(historyAPI.markZoneCardOpened).not.toHaveBeenCalled();
    expect(screen.queryByText('0016C001F11766E7')).not.toBeInTheDocument();
  });

  it('shows required range controls and refetches card data when a supported range is selected', async () => {
    vi.mocked(historyAPI.getZoneCards).mockResolvedValue({
      zoneId: 12,
      generatedAt: '2026-05-31T10:00:00Z',
      cards: [
        zoneCard({
          supportedRanges: ['12h', '24h', '7d'],
          defaultRange: '24h',
        }),
      ],
    });

    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    const rangeControl = await screen.findByRole('group', { name: 'Date range' });
    const twelveHour = screen.getByRole('button', { name: '12h' });
    const twentyFourHour = screen.getByRole('button', { name: '24h' });
    const sevenDay = screen.getByRole('button', { name: '7D' });
    const thirtyDay = screen.getByRole('button', { name: '30D' });
    const season = screen.getByRole('button', { name: 'Season' });

    expect(rangeControl).toContainElement(twelveHour);
    expect(rangeControl).toContainElement(twentyFourHour);
    expect(rangeControl).toContainElement(sevenDay);
    expect(rangeControl).toContainElement(thirtyDay);
    expect(rangeControl).toContainElement(season);
    expect(twentyFourHour).toHaveAttribute('aria-pressed', 'true');
    expect(thirtyDay).toBeDisabled();
    expect(season).toBeDisabled();

    await waitFor(() => {
      expect(firstZoneCardDataRequest()).toEqual(
        expect.objectContaining({
          view: 'soil-profile',
          range: expect.objectContaining({ label: '24h' }),
        }),
      );
    });
    historyAPIMock.getZoneCardData.mockClear();

    fireEvent.click(sevenDay);

    await waitFor(() => {
      expect(sevenDay).toHaveAttribute('aria-pressed', 'true');
      expect(historyAPI.getZoneCardData).toHaveBeenCalledWith(
        12,
        'soil-card:root-zone',
        expect.objectContaining({
          range: expect.objectContaining({ label: '7d' }),
          aggregation: 'hourly',
        }),
      );
    });
  });

  it('shows card-specific mobile view controls without exposing Advanced as a primary view', async () => {
    vi.mocked(historyAPI.getZoneCards).mockResolvedValue({
      zoneId: 12,
      generatedAt: '2026-05-31T10:00:00Z',
      cards: [
        zoneCard({
          views: ['soil-profile', 'line-chart', 'advanced'],
          defaultView: 'soil-profile',
        }),
      ],
    });

    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    const viewControl = await screen.findByRole('group', { name: 'View' });
    const soilProfile = screen.getByRole('button', { name: 'Soil Profile' });
    const lineChart = screen.getByRole('button', { name: 'Line Chart' });

    expect(viewControl).toContainElement(soilProfile);
    expect(viewControl).toContainElement(lineChart);
    expect(screen.queryByRole('button', { name: 'Advanced View' })).not.toBeInTheDocument();
    expect(soilProfile).toHaveAttribute('aria-pressed', 'true');

    await waitFor(() => {
      expect(firstZoneCardDataRequest()).toEqual(
        expect.objectContaining({ view: 'soil-profile' }),
      );
    });
    historyAPIMock.getZoneCardData.mockClear();

    fireEvent.click(lineChart);

    await waitFor(() => {
      expect(lineChart).toHaveAttribute('aria-pressed', 'true');
      expect(historyAPI.getZoneCardData).toHaveBeenCalledWith(
        12,
        'soil-card:root-zone',
        expect.objectContaining({ view: 'line-chart' }),
      );
    });
  });

  it('shows display-safe source chips for merged cards and refetches with sourceKey', async () => {
    vi.mocked(historyAPI.getZoneCards).mockResolvedValue({
      zoneId: 12,
      generatedAt: '2026-05-31T10:00:00Z',
      cards: [
        zoneCard({
          sourceDeviceCount: 2,
          sourceLabels: ['Chameleon 1', 'Chameleon 2'],
          sourceDevices: [
            { name: 'Chameleon 1', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'soil-source-1' },
            { name: 'Chameleon 2', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'soil-source-2' },
          ],
        }),
      ],
    });

    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    const sourceFilter = await screen.findByRole('group', { name: 'Source' });
    const all = screen.getByRole('button', { name: 'All' });
    const chameleonOne = screen.getByRole('button', { name: 'Chameleon 1' });
    const chameleonTwo = screen.getByRole('button', { name: 'Chameleon 2' });

    expect(sourceFilter).toContainElement(all);
    expect(sourceFilter).toContainElement(chameleonOne);
    expect(sourceFilter).toContainElement(chameleonTwo);
    expect(all).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => {
      expect(historyAPI.getZoneCardData).toHaveBeenCalled();
      expect(firstZoneCardDataRequest()).toEqual(expect.not.objectContaining({ sourceKey: expect.anything() }));
    });
    historyAPIMock.getZoneCardData.mockClear();

    fireEvent.click(chameleonTwo);

    await waitFor(() => {
      expect(chameleonTwo).toHaveAttribute('aria-pressed', 'true');
      expect(historyAPI.getZoneCardData).toHaveBeenCalledWith(
        12,
        'soil-card:root-zone',
        expect.objectContaining({ sourceKey: 'soil-source-2' }),
      );
    });
    expect(screen.queryByText(/[A-F0-9]{16}/)).not.toBeInTheDocument();
  });

  it('does not render raw sourceLabel values in the normal detail header', async () => {
    vi.mocked(historyAPI.getZoneCards).mockResolvedValue({
      zoneId: 12,
      generatedAt: '2026-05-31T10:00:00Z',
      cards: [
        zoneCard({
          sourceLabels: [],
          sourceDevices: [],
          sourceLabel: 'A84041A75D5E7CFB',
          sourceDeviceCount: 1,
        }),
      ],
    });

    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    await screen.findByRole('heading', { name: 'Soil - Root Zone' });
    expect(screen.queryByText('A84041A75D5E7CFB')).not.toBeInTheDocument();
  });

  it('uses the card default range for the first detail data fetch when it is not 24h', async () => {
    vi.mocked(historyAPI.getZoneCards).mockResolvedValue({
      zoneId: 12,
      generatedAt: '2026-05-31T10:00:00Z',
      cards: [
        zoneCard({
          supportedRanges: ['12h', '24h', '7d'],
          defaultRange: '12h',
          defaultView: 'soil-profile',
          views: ['soil-profile', 'line-chart'],
        }),
      ],
    });

    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    await screen.findByRole('group', { name: 'Date range' });

    await waitFor(() => {
      expect(firstZoneCardDataRequest()).toEqual(
        expect.objectContaining({
          view: 'soil-profile',
          range: expect.objectContaining({ label: '12h' }),
          aggregation: 'raw',
        }),
      );
    });
    expect(screen.getByRole('button', { name: '12h' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders the selected visualization inside the gesture surface without the desktop timeline brush', async () => {
    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    expect(await screen.findByRole('heading', { level: 1, name: 'Soil - Root Zone' })).toBeInTheDocument();
    const surface = screen.getByTestId('history-visualization-surface');

    expect(surface).toHaveTextContent('No soil profile data');
    expect(surface).toHaveStyle({ touchAction: 'none' });
    expect(screen.queryByRole('region', { name: 'Timeline viewport' })).not.toBeInTheDocument();
    expect(screen.getByTestId('history-detail-scroll-root')).not.toHaveStyle({ touchAction: 'none' });
  });

  it('renders tappable calendar dates on the detail route', async () => {
    vi.mocked(historyAPI.getZoneCards).mockResolvedValue({
      zoneId: 12,
      generatedAt: '2026-05-31T10:00:00Z',
      cards: [
        zoneCard({
          defaultView: 'calendar',
          views: ['calendar'],
          supportedRanges: ['30d'],
          defaultRange: '30d',
        }),
      ],
    });
    vi.mocked(historyAPI.getZoneCardData).mockResolvedValue({
      cardId: 'soil-card:root-zone',
      cardType: 'soil',
      view: 'calendar',
      range: {
        label: '30d',
        from: '2026-05-01T00:00:00.000Z',
        to: '2026-05-31T23:59:59.999Z',
        timezone: 'Europe/Zurich',
      },
      aggregation: {
        level: 'daily',
        bucketSizeSeconds: 86400,
        coveragePct: 96,
        coverageConfidence: 'configured',
        pointCount: 1,
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
      calendar: {
        timezone: 'Europe/Zurich',
        days: [
          {
            date: '2026-05-12',
            state: 'dry_stress',
            coveragePct: 96,
            coverageConfidence: 'configured',
            summary: {
              key: 'history.calendar.summary.soil.dry_stress',
              params: { sampleCount: 8 },
            },
            markers: [
              {
                type: 'state',
                severity: 'warning',
                labelKey: 'history.calendar.marker.soil.dry_stress',
              },
            ],
          },
        ],
      },
      interpretations: [],
      freshness: { dataAsOf: '2026-05-12T10:00:00.000Z', syncState: 'local' },
      advancedFields: {},
    });

    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    const may12 = await screen.findByRole('gridcell', { name: /May 12/i });
    expect(may12).toHaveAttribute('data-history-calendar-date', '2026-05-12');
  });

  it('refreshes selected card data on touch pull-down outside the visualization surface at the scroll top', async () => {
    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    await waitFor(() => expect(historyAPI.getZoneCardData).toHaveBeenCalledTimes(1));
    historyAPIMock.getZoneCardData.mockClear();

    const scrollRoot = screen.getByTestId('history-detail-scroll-root');
    preparePointerTarget(scrollRoot);
    pointerDrag(scrollRoot, { fromY: 40, toY: 180 });

    await waitFor(() => {
      expect(historyAPI.getZoneCardData).toHaveBeenCalledTimes(1);
    });
  });

  it('does not refresh detail data on mouse drag outside the visualization surface', async () => {
    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    await waitFor(() => expect(historyAPI.getZoneCardData).toHaveBeenCalledTimes(1));
    historyAPIMock.getZoneCardData.mockClear();

    const scrollRoot = screen.getByTestId('history-detail-scroll-root');
    preparePointerTarget(scrollRoot);
    pointerDrag(scrollRoot, { fromY: 40, toY: 180, pointerType: 'mouse' });

    expect(historyAPI.getZoneCardData).not.toHaveBeenCalled();
  });

  it('does not refresh detail data on touch pull-down when the scroll root is not at the top', async () => {
    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    await waitFor(() => expect(historyAPI.getZoneCardData).toHaveBeenCalledTimes(1));
    historyAPIMock.getZoneCardData.mockClear();

    const scrollRoot = screen.getByTestId('history-detail-scroll-root');
    preparePointerTarget(scrollRoot, 40);
    pointerDrag(scrollRoot, { fromY: 40, toY: 180, pointerType: 'touch' });

    expect(historyAPI.getZoneCardData).not.toHaveBeenCalled();
  });

  it('does not refresh detail data on pull-down inside the visualization surface', async () => {
    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    await waitFor(() => expect(historyAPI.getZoneCardData).toHaveBeenCalledTimes(1));
    historyAPIMock.getZoneCardData.mockClear();

    const surface = screen.getByTestId('history-visualization-surface');
    preparePointerTarget(surface);
    pointerDrag(surface, { fromY: 40, toY: 180, pointerType: 'touch' });

    expect(historyAPI.getZoneCardData).not.toHaveBeenCalled();
  });
});
