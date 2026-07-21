import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { SWRConfig } from 'swr';

import App from '../../../App';
import { historyAPI, irrigationZonesAPI, systemAPI, zoneExportAPI } from '../../../services/api';
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
    'history.settings.open': 'Open card settings',
    'history.settings.menuLabel': 'Card settings',
    'history.settings.advancedView': 'Advanced view',
    'history.settings.cardSettings': 'Card settings',
    'history.settings.cardSettingsUnavailable': 'Card settings are not available yet.',
    'history.settings.resetRange': 'Reset range',
    'history.settings.refresh': 'Refresh',
    'history.export.open': 'Export',
    'history.export.title': 'Export CSV',
    'history.inspector.title': 'Inspector',
    'history.inspector.context': 'Selected point',
    'history.inspector.close': 'Close',
    'history.inspector.timestamp': 'Timestamp',
    'history.inspector.date': 'Date',
    'history.inspector.source': 'Source',
    'history.inspector.coverage': 'Coverage',
    'history.inspector.syncState': 'Sync state',
    'history.inspector.dataAsOf': 'Data as of',
    'history.inspector.events': 'Events',
    'history.inspector.eventFallback': 'History event',
    'history.inspector.noInterpretation': 'No local interpretation for this selection.',
    'history.sourceFilter.label': 'Source',
    'history.sourceFilter.all': 'All',
    'history.sources.button': 'Sources',
    'history.sources.menuLabel': 'Card sources',
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
    'history.desktop.modeLabel': 'View mode',
    'history.desktop.modeFocus': 'Focus',
    'history.desktop.modeCompare': 'Compare',
    'history.desktop.viewSelectorLabel': 'Card view',
    'history.desktop.compareViewSelectorLabel': 'Compare view',
    'history.desktop.sourceSelectorLabel': 'Sources',
    'history.desktop.chartSurfaceLabel': 'History chart, use arrow keys to pan and plus or minus to zoom',
    'history.desktop.zoomIn': 'Zoom in',
    'history.desktop.zoomOut': 'Zoom out',
    'history.desktop.resetZoom': 'Reset zoom',
    'history.desktop.railLabel': 'History cards',
    'history.viewMode.soil-profile': 'Soil Profile',
    'history.viewMode.line-chart': 'Line Chart',
    'history.viewMode.daily-min-max': 'Daily Min/Max',
    'history.viewMode.calendar': 'Calendar',
    'history.viewMode.status-overview': 'Status Overview',
    'history.viewMode.advanced': 'Advanced view',
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
    'history.irrigationTimeline.eventLabel.irrigation': 'Irrigation event',
    'history.irrigationTimeline.eventLabel.manualOverride': 'Manual override',
    'history.interpretation.title': 'Local interpretation',
    'history.interpretation.rootZoneDry.title': 'Root zone dry',
    'history.interpretation.rootZoneDry.body': 'Dry for {{hoursDry}} hours',
    'history.advanced.title': 'Advanced diagnostics',
    'history.advanced.loading': 'Loading advanced diagnostics...',
    'history.advanced.emptyTitle': 'No advanced diagnostics',
    'history.advanced.field.primaryDeveui': 'Device EUI',
    'history.advanced.field.rssi': 'RSSI',
    'history.advanced.availability.collected': 'Collected',
    'history.advanced.availability.unknown_now': 'Unknown now',
    'history.advanced.value.unavailable': 'Unavailable',
    'zone.export.title': 'Export data',
    'zone.export.selectRange': 'Select range',
    'zone.export.granularity': 'Granularity',
    'zone.export.raw': 'Raw',
    'zone.export.hourly': 'Hourly',
    'zone.export.daily': 'Daily',
    'zone.export.download': 'Download',
    'zone.export.downloading': 'Downloading',
    'zone.export.fullExport': 'Full export',
    'zone.export.rangeSummary': '{{from}} to {{to}}',
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
    getZoneCardAdvanced: vi.fn(),
    getGatewayCardAdvanced: vi.fn(),
    markZoneCardOpened: vi.fn(),
  },
  irrigationZonesAPI: {
    getAll: vi.fn(),
  },
  zoneExportAPI: {
    download: vi.fn(),
  },
  authAPI: {
    login: vi.fn(),
    register: vi.fn(),
  },
}));

const historyAPIMock = historyAPI as typeof historyAPI & {
  getGatewayCards: Mock;
  getZoneCardData: Mock;
  getZoneCardAdvanced: Mock;
};
const zoneExportAPIMock = zoneExportAPI as typeof zoneExportAPI & {
  download: Mock;
};

function firstZoneCardDataRequest() {
  return historyAPIMock.getZoneCardData.mock.calls[0]?.[2];
}

function calendarFixtureDateForRange(from: string | null | undefined, to: string | null | undefined): string {
  const parsed = Date.parse(from ?? to ?? '');
  const base = Number.isFinite(parsed) ? new Date(parsed) : new Date('2026-06-01T00:00:00.000Z');
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 12)).toISOString().slice(0, 10);
}

function calendarMonthLabelForDate(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`));
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

function dispatchTouch(
  element: HTMLElement,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  touches: Array<{ clientX: number; clientY: number }>,
) {
  const touchList = touches.map((touch, index) => ({
    identifier: index,
    target: element,
    clientX: touch.clientX,
    clientY: touch.clientY,
  }));
  const event =
    typeof TouchEvent === 'function'
      ? new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: Array.from(touchList as unknown as TouchList),
          changedTouches: Array.from(touchList as unknown as TouchList),
        })
      : new Event(type, { bubbles: true, cancelable: true });

  if (typeof TouchEvent !== 'function' || !(event instanceof TouchEvent)) {
    Object.defineProperty(event, 'touches', { value: touchList });
    Object.defineProperty(event, 'changedTouches', { value: touchList });
  }

  act(() => {
    element.dispatchEvent(event);
  });
}

function renderAppAtRoute(hashRoute: string) {
  window.history.replaceState(null, '', `#${hashRoute}`);

  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <App />
    </SWRConfig>,
  );
}

function mockOrientation(isLandscape: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: isLandscape && query === '(orientation: landscape)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

function mockViewport({ isDesktop = false, isLandscape = false }: { isDesktop?: boolean; isLandscape?: boolean }) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: (isDesktop && query.includes('min-width')) || (isLandscape && query === '(orientation: landscape)'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

function zoneCard(overrides: Partial<HistoryCardSummary> = {}): HistoryCardSummary {
  return {
    cardId: 'soil-card:root-zone',
    cardType: 'soil',
    scope: 'zone',
    title: 'Soil Moisture',
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
    vi.mocked(historyAPI.getZoneCardAdvanced).mockResolvedValue({
      generatedAt: '2026-05-31T10:00:00.000Z',
      cardId: 'soil-card:root-zone',
      cardType: 'soil',
      range: {
        label: '24h',
        from: '2026-05-30T10:00:00.000Z',
        to: '2026-05-31T10:00:00.000Z',
        timezone: 'UTC',
      },
      freshness: { dataAsOf: '2026-05-31T10:00:00.000Z', syncState: 'local' },
      aggregation: {
        level: 'raw',
        bucketSizeSeconds: null,
        coveragePct: 96,
        coverageConfidence: 'configured',
        pointCount: 12,
      },
      placeholder: {
        schemaVersion: 1,
        cardType: 'soil',
        placeholder: false,
        generatedAt: '2026-05-31T10:00:00.000Z',
      },
      advancedFields: {
        primaryDeveui: {
          field: 'primaryDeveui',
          value: 'ABCDEF0123456789',
          unit: null,
          availability: 'collected',
        },
        rssi: {
          field: 'rssi',
          value: -110,
          unit: 'dBm',
          availability: 'collected',
        },
      },
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
    vi.mocked(zoneExportAPI.download).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  it('loads the route-backed full-screen detail by zone and encoded card id', async () => {
    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    expect(await screen.findByRole('heading', { level: 1, name: 'Soil Moisture North Block' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Back to history/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Chameleon 1')).not.toBeInTheDocument();
    expect(screen.queryByText('ABCDEF0123456789')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(historyAPI.markZoneCardOpened).toHaveBeenCalledWith(12, 'soil-card:root-zone');
    });
  });

  it('opens a mobile export sheet with canonical open-card channels', async () => {
    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    expect(await screen.findByRole('heading', { level: 1, name: 'Soil Moisture North Block' })).toBeInTheDocument();
    await waitFor(() => {
      expect(historyAPI.getZoneCardData).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByRole('dialog', { name: 'Export CSV' }, { timeout: 4000 })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => {
      expect(zoneExportAPIMock.download).toHaveBeenCalledWith(
        12,
        expect.objectContaining({ channels: ['swt_1', 'swt_2', 'swt_3', 'vwc'] }),
      );
    });
  });

  it('hides mobile export for gateway cards', async () => {
    renderAppAtRoute('/history/gateways/0016C001F11766E7/cards/0016C001F11766E7%3Agateway%3Ahub');

    expect(await screen.findByRole('heading', { level: 1, name: 'Gateway' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
  });

  it('resolves a zone route without card id to the first ordered card', async () => {
    renderAppAtRoute('/history/zones/12');

    expect(await screen.findByRole('heading', { level: 1, name: 'Soil Moisture North Block' })).toBeInTheDocument();
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
          cardId: '0016C001F11766E7:gateway:hub',
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

    renderAppAtRoute('/history/zones/12/cards/gateway-hub');

    expect(await screen.findByRole('heading', { level: 1, name: 'Gateway' })).toBeInTheDocument();
    await waitFor(() => {
      expect(historyAPI.getGatewayCardData).toHaveBeenCalledWith(
        '0016C001F11766E7',
        '0016C001F11766E7:gateway:hub',
        expect.objectContaining({ view: 'status-overview' }),
      );
      expect(historyAPI.markZoneCardOpened).toHaveBeenCalledWith(12, '0016C001F11766E7:gateway:hub');
    });
    expect(screen.queryByText(/[A-F0-9]{16}/)).not.toBeInTheDocument();
  });

  it('loads a hub-scoped gateway card through the gateway route without requiring a zone', async () => {
    renderAppAtRoute('/history/gateways/0016C001F11766E7/cards/0016C001F11766E7%3Agateway%3Ahub');

    expect(await screen.findByRole('heading', { level: 1, name: 'Gateway' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Back to history/i })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(historyAPIMock.getGatewayCards).toHaveBeenCalledWith('0016C001F11766E7');
      expect(historyAPI.getGatewayCardData).toHaveBeenCalled();
    });
    expect(irrigationZonesAPI.getAll).not.toHaveBeenCalled();
    expect(historyAPI.getZoneCards).not.toHaveBeenCalled();
    expect(historyAPI.markZoneCardOpened).not.toHaveBeenCalled();
    expect(screen.queryByText('0016C001F11766E7')).not.toBeInTheDocument();
  });

  it('keeps selected desktop gateway cards on the sanitized data path', async () => {
    mockViewport({ isDesktop: true });
    vi.mocked(historyAPIMock.getGatewayCards).mockResolvedValue({
      gatewayEui: '0016C001F11766E7',
      generatedAt: '2026-05-31T10:00:00Z',
      cards: [
        gatewayCard({
          cardId: '0016C001F11766E7:gateway:hub',
          title: 'Primary gateway',
          subtitle: 'Hub status',
        }),
        gatewayCard({
          cardId: '0016C001F11766E7:gateway:secondary',
          title: 'Gateway 0016C001F11766E7',
          subtitle: 'Hub 0016C001F11766E7',
          sourceLabels: ['0016C001F11766E7'],
        }),
      ],
    });

    renderAppAtRoute('/history/gateways/0016C001F11766E7/cards/0016C001F11766E7%3Agateway%3Ahub');

    await waitFor(() => {
      expect(screen.getAllByText('Primary gateway').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Gateway' }));

    await waitFor(() => {
      expect(screen.getAllByText('Gateway').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/0016C001F11766E7/)).not.toBeInTheDocument();
  });

  it('header shows source names without back button or visible History text', async () => {
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

    expect(await screen.findByRole('heading', { level: 1, name: 'Soil Moisture North Block' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /back to history/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /back to history/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/back to history/i)).not.toBeInTheDocument();
    expect(screen.getByText('2 sources: Chameleon 1, Chameleon 2')).toBeInTheDocument();
    expect(screen.queryByText(/\bhistory\b/i)).not.toBeInTheDocument();
  });

  it('does not render range controls and still fetches the default range', async () => {
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

    await screen.findByRole('heading', { level: 1, name: 'Soil Moisture North Block' });
    expect(screen.queryByRole('group', { name: 'Date range' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '12h' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '24h' })).not.toBeInTheDocument();
    expect(screen.getByTestId('view-mode-label')).toHaveTextContent(/Soil Profile/i);
    expect(screen.getByTestId('view-mode-label')).toHaveTextContent(/24h/i);

    await waitFor(() => {
      expect(firstZoneCardDataRequest()).toEqual(
        expect.objectContaining({
          view: 'soil-profile',
          range: expect.objectContaining({ label: '24h' }),
        }),
      );
    });
  });

  it('shows a passive card-specific view label without segmented view controls', async () => {
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

    await screen.findByRole('heading', { level: 1, name: 'Soil Moisture North Block' });
    expect(screen.queryByRole('group', { name: 'View' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Line Chart' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Advanced view' })).not.toBeInTheDocument();
    const overlay = screen.getByTestId('view-mode-label');
    expect(overlay).toHaveTextContent(/Soil Profile/i);
    expect(overlay.className).toMatch(/absolute/);

    await waitFor(() => {
      expect(firstZoneCardDataRequest()).toEqual(
        expect.objectContaining({ view: 'soil-profile' }),
      );
    });
  });

  it('renders the visualization in a single flex-fill container', async () => {
    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    const surface = await screen.findByTestId('history-visualization-surface');
    expect(surface.className).toMatch(/flex-1/);
    expect(surface.parentElement?.className ?? '').not.toMatch(/border /);
  });

  it('uses a compact persistent header in landscape orientation', async () => {
    mockOrientation(true);

    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    await screen.findByRole('heading', { level: 1, name: 'Soil Moisture North Block' });
    expect(screen.getByRole('banner').className).toMatch(/py-1/);
  });

  it('opens Advanced View from header settings and keeps raw identifiers out of normal mode', async () => {
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

    expect(await screen.findByRole('heading', { level: 1, name: 'Soil Moisture North Block' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole('group', { name: 'View' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Advanced view' })).not.toBeInTheDocument();
    expect(screen.queryByText('ABCDEF0123456789')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open card settings' }));
    const menu = screen.getByRole('menu', { name: 'Card settings' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Advanced view' }));

    expect(await screen.findByRole('region', { name: 'Advanced diagnostics' })).toBeInTheDocument();
    expect(historyAPI.getZoneCardAdvanced).toHaveBeenCalledWith(
      12,
      'soil-card:root-zone',
      expect.objectContaining({ view: 'advanced' }),
    );
    expect(screen.getByText('ABCDEF0123456789')).toBeInTheDocument();
  });

  it('hides Advanced View from settings when the card does not support advanced diagnostics', async () => {
    vi.mocked(historyAPI.getZoneCards).mockResolvedValue({
      zoneId: 12,
      generatedAt: '2026-05-31T10:00:00Z',
      cards: [
        zoneCard({
          views: ['soil-profile', 'line-chart'],
          defaultView: 'soil-profile',
        }),
      ],
    });

    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    await screen.findByRole('heading', { level: 1, name: 'Soil Moisture North Block' });
    fireEvent.click(screen.getByRole('button', { name: 'Open card settings' }));
    const menu = screen.getByRole('menu', { name: 'Card settings' });

    expect(within(menu).queryByRole('menuitem', { name: 'Advanced view' })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Card settings' })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('refreshes selected card data from the settings menu fallback', async () => {
    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    await waitFor(() => expect(historyAPI.getZoneCardData).toHaveBeenCalledTimes(1));
    historyAPIMock.getZoneCardData.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Open card settings' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Card settings' })).getByRole('menuitem', { name: 'Refresh' }));

    await waitFor(() => {
      expect(historyAPI.getZoneCardData).toHaveBeenCalledTimes(1);
    });
  });

  it('shows display-safe source popover for merged cards and refetches when narrowed', async () => {
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

    await screen.findByRole('heading', { level: 1, name: 'Soil Moisture North Block' });
    expect(screen.getByText('2 sources: Chameleon 1, Chameleon 2')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Source' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Sources/i }));
    const chameleonOne = screen.getByLabelText('Chameleon 1');
    const chameleonTwo = screen.getByLabelText('Chameleon 2');

    expect(chameleonOne).toBeChecked();
    expect(chameleonTwo).toBeChecked();
    await waitFor(() => {
      expect(historyAPI.getZoneCardData).toHaveBeenCalled();
      expect(firstZoneCardDataRequest()).toEqual(expect.not.objectContaining({ sourceKey: expect.anything() }));
    });
    historyAPIMock.getZoneCardData.mockClear();

    fireEvent.click(chameleonTwo);

    await waitFor(() => {
      expect(chameleonTwo).not.toBeChecked();
      expect(historyAPI.getZoneCardData).toHaveBeenCalledWith(
        12,
        'soil-card:root-zone',
        expect.objectContaining({ sourceKey: 'soil-source-1' }),
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

    await screen.findByRole('heading', { name: 'Soil Moisture North Block' });
    expect(screen.queryByText('A84041A75D5E7CFB')).not.toBeInTheDocument();
    // The raw DevEUI must not leak into the single-device overlay either.
    expect(screen.queryByTestId('single-device-label')).not.toBeInTheDocument();
  });

  it('shows the device name as a small overlay for single-device cards', async () => {
    vi.mocked(historyAPI.getZoneCards).mockResolvedValue({
      zoneId: 12,
      generatedAt: '2026-05-31T10:00:00Z',
      cards: [
        zoneCard({
          sourceDeviceCount: 1,
          sourceLabels: ['Dendro 3'],
          sourceDevices: [{ sourceKey: 'd1', name: 'Dendro 3', typeId: 'DRAGINO_LSN50', role: 'dendro' }],
        }),
      ],
    });

    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    await screen.findByRole('heading', { name: 'Soil Moisture North Block' });
    expect(screen.getByTestId('single-device-label')).toHaveTextContent('Dendro 3');
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

    await screen.findByRole('heading', { level: 1, name: 'Soil Moisture North Block' });

    await waitFor(() => {
      expect(firstZoneCardDataRequest()).toEqual(
        expect.objectContaining({
          view: 'soil-profile',
          range: expect.objectContaining({ label: '12h' }),
          aggregation: 'raw',
        }),
      );
    });
    expect(screen.queryByRole('button', { name: '12h' })).not.toBeInTheDocument();
    expect(screen.getByTestId('view-mode-label')).toHaveTextContent(/12h/i);
  });

  it('renders the selected visualization inside the gesture surface without the desktop timeline brush', async () => {
    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    expect(await screen.findByRole('heading', { level: 1, name: 'Soil Moisture North Block' })).toBeInTheDocument();
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
    expect(screen.getByTestId('view-mode-label')).toHaveTextContent('Calendar - May 2026');
  });

  it('changes the visible calendar month on inner horizontal calendar swipe (backward)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));

    vi.mocked(historyAPI.getZoneCards).mockResolvedValue({
      zoneId: 12,
      generatedAt: '2026-06-15T12:00:00Z',
      cards: [
        zoneCard({
          defaultView: 'calendar',
          views: ['calendar'],
          supportedRanges: ['30d'],
          defaultRange: '30d',
        }),
      ],
    });
    vi.mocked(historyAPI.getZoneCardData).mockImplementation(async (_zoneId, _cardId, request) => ({
      cardId: 'soil-card:root-zone',
      cardType: 'soil',
      view: 'calendar',
      range: request.range,
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
            date: calendarFixtureDateForRange(request.range.from, request.range.to),
            state: 'optimal',
            coveragePct: 96,
            coverageConfidence: 'configured',
            markers: [],
          },
        ],
      },
      interpretations: [],
      freshness: { dataAsOf: '2026-06-15T12:00:00.000Z', syncState: 'local' },
      advancedFields: {},
    }));

    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    expect(await screen.findByRole('grid')).toBeInTheDocument();
    const initialRequest = historyAPIMock.getZoneCardData.mock.calls[0]?.[2];
    const initialDate = calendarFixtureDateForRange(initialRequest?.range.from, initialRequest?.range.to);
    expect(screen.getByTestId('view-mode-label')).toHaveTextContent(`Calendar - ${calendarMonthLabelForDate(initialDate)}`);
    await act(async () => {
      await Promise.resolve();
    });
    const surface = screen.getByTestId('history-visualization-surface');
    preparePointerTarget(surface);
    dispatchTouch(surface, 'touchstart', [{ clientX: 120, clientY: 160 }]);
    dispatchTouch(surface, 'touchmove', [{ clientX: 250, clientY: 164 }]);
    dispatchTouch(surface, 'touchend', []);

    const initialFrom = Date.parse(initialRequest?.range.from ?? '');
    const initialMonth = new Date(initialFrom);
    const expectedPrevMonthStart = new Date(Date.UTC(
      initialMonth.getUTCFullYear(),
      initialMonth.getUTCMonth() - 1,
      1,
      0,
      0,
      0,
      0,
    ));
    const expectedPrevMonthEnd = new Date(Date.UTC(
      expectedPrevMonthStart.getUTCFullYear(),
      expectedPrevMonthStart.getUTCMonth() + 1,
      1,
      0,
      0,
      0,
      0,
    ) - 1);
    const nextDate = calendarFixtureDateForRange(expectedPrevMonthStart.toISOString(), expectedPrevMonthEnd.toISOString());

    await waitFor(() => {
      expect(historyAPI.getZoneCardData).toHaveBeenLastCalledWith(
        12,
        'soil-card:root-zone',
        expect.objectContaining({
          view: 'calendar',
          range: expect.objectContaining({
            label: 'custom',
            from: expectedPrevMonthStart.toISOString(),
            to: expectedPrevMonthEnd.toISOString(),
          }),
        }),
      );
    });
    expect(await screen.findByTestId(`calendar-cell-${nextDate}`)).toBeInTheDocument();
    expect(screen.getByTestId('view-mode-label')).toHaveTextContent(`Calendar - ${calendarMonthLabelForDate(nextDate)}`);
  });

  it('opens an inspector sheet on long press and returns focus to the visualization when closed', async () => {
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
      events: [
        {
          id: 'irrigation-1',
          type: 'irrigation',
          t: '2026-05-31T08:00:00.000Z',
          label: 'raw_payload ABCDEF0123456789',
          severity: 'info',
          metadata: {},
        },
      ],
      calendar: null,
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
      freshness: { dataAsOf: '2026-05-31T10:00:00.000Z', syncState: 'local' },
      advancedFields: {},
    });

    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    const surface = await screen.findByTestId('history-visualization-surface');
    preparePointerTarget(surface);
    dispatchTouch(surface, 'touchstart', [{ clientX: 120, clientY: 140 }]);

    await act(async () => {
      await new Promise((resolve) => {
        window.setTimeout(resolve, 550);
      });
    });

    const dialog = await screen.findByRole('dialog', { name: 'Inspector' });
    expect(dialog).toHaveTextContent('Root zone dry');
    expect(dialog).toHaveTextContent('Dry for 9 hours');
    expect(dialog).toHaveTextContent('96% coverage');
    expect(dialog).toHaveTextContent('Local');
    expect(dialog).toHaveTextContent('Irrigation event');
    expect(dialog).not.toHaveTextContent('raw_payload ABCDEF0123456789');
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Inspector' })).not.toBeInTheDocument();
      expect(surface).toHaveFocus();
    });
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

  it('refreshes Advanced View diagnostics on touch pull-down when Advanced View is active', async () => {
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

    await waitFor(() => expect(historyAPI.getZoneCardData).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Open card settings' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Card settings' })).getByRole('menuitem', { name: 'Advanced view' }));

    await waitFor(() => expect(historyAPI.getZoneCardAdvanced).toHaveBeenCalledTimes(1));
    historyAPIMock.getZoneCardData.mockClear();
    historyAPIMock.getZoneCardAdvanced.mockClear();

    const scrollRoot = screen.getByTestId('history-detail-scroll-root');
    preparePointerTarget(scrollRoot);
    pointerDrag(scrollRoot, { fromY: 40, toY: 180 });

    await waitFor(() => {
      expect(historyAPI.getZoneCardAdvanced).toHaveBeenCalledTimes(1);
    });
    expect(historyAPI.getZoneCardData).not.toHaveBeenCalled();
  });

  it('does not switch thematic cards on one-finger horizontal swipe outside the visualization surface', async () => {
    vi.mocked(historyAPI.getZoneCards).mockResolvedValue({
      zoneId: 12,
      generatedAt: '2026-05-31T10:00:00Z',
      cards: [
        zoneCard({
          cardId: 'soil-card:root-zone',
          title: 'Soil Moisture',
          ordering: { pinned: false, score: 10, recentRank: 1, criticalAlert: false },
        }),
        zoneCard({
          cardId: 'environment-card:microclimate',
          cardType: 'environment',
          title: 'Environment - Microclimate',
          subtitle: 'Microclimate',
          defaultView: 'line-chart',
          views: ['line-chart'],
          ordering: { pinned: false, score: 8, recentRank: 2, criticalAlert: false },
        }),
      ],
    });

    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    expect(await screen.findByRole('heading', { level: 1, name: 'Soil Moisture North Block' })).toBeInTheDocument();

    const scrollRoot = screen.getByTestId('history-detail-scroll-root');
    preparePointerTarget(scrollRoot);
    pointerDrag(scrollRoot, { fromX: 280, toX: 80, fromY: 160, toY: 168 });

    expect(screen.getByRole('heading', { level: 1, name: 'Soil Moisture North Block' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Environment - Microclimate North Block' })).not.toBeInTheDocument();
    expect(window.location.hash).toContain('/history/zones/12/cards/soil-card%3Aroot-zone');
  });

  it('switches to the next thematic card on two-finger horizontal swipe inside the visualization surface', async () => {
    vi.mocked(historyAPI.getZoneCards).mockResolvedValue({
      zoneId: 12,
      generatedAt: '2026-05-31T10:00:00Z',
      cards: [
        zoneCard({
          cardId: 'soil-card:root-zone',
          title: 'Soil Moisture',
          ordering: { pinned: false, score: 10, recentRank: 1, criticalAlert: false },
        }),
        zoneCard({
          cardId: 'environment-card:microclimate',
          cardType: 'environment',
          title: 'Environment - Microclimate',
          subtitle: 'Microclimate',
          defaultView: 'line-chart',
          views: ['line-chart'],
          ordering: { pinned: false, score: 8, recentRank: 2, criticalAlert: false },
        }),
      ],
    });

    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    expect(await screen.findByRole('heading', { level: 1, name: 'Soil Moisture North Block' })).toBeInTheDocument();

    const surface = screen.getByTestId('history-visualization-surface');
    preparePointerTarget(surface);
    dispatchTouch(surface, 'touchstart', [
      { clientX: 240, clientY: 160 },
      { clientX: 320, clientY: 160 },
    ]);
    dispatchTouch(surface, 'touchmove', [
      { clientX: 40, clientY: 168 },
      { clientX: 120, clientY: 168 },
    ]);
    dispatchTouch(surface, 'touchend', []);

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Environment - Microclimate North Block' })).toBeInTheDocument();
    });
    expect(window.location.hash).toContain('/history/zones/12/cards/environment-card%3Amicroclimate');
  });

  it('clips the chart during pinch without refetching until release', async () => {
    const frameQueue: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      frameQueue.push(callback);
      return frameQueue.length;
    });
    vi.mocked(historyAPI.getZoneCards).mockResolvedValue({
      zoneId: 12,
      generatedAt: '2026-05-31T10:00:00Z',
      cards: [
        zoneCard({
          views: ['line-chart'],
          defaultView: 'line-chart',
        }),
      ],
    });

    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    await waitFor(() => expect(historyAPI.getZoneCardData).toHaveBeenCalledTimes(1));
    historyAPIMock.getZoneCardData.mockClear();

    const surface = screen.getByTestId('history-visualization-surface');
    preparePointerTarget(surface);
    dispatchTouch(surface, 'touchstart', [
      { clientX: 120, clientY: 160 },
      { clientX: 200, clientY: 160 },
    ]);
    dispatchTouch(surface, 'touchmove', [
      { clientX: 80, clientY: 160 },
      { clientX: 240, clientY: 160 },
    ]);
    act(() => {
      frameQueue.shift()?.(0);
    });

    expect(historyAPI.getZoneCardData).not.toHaveBeenCalled();

    dispatchTouch(surface, 'touchend', []);

    await waitFor(() => expect(historyAPI.getZoneCardData).toHaveBeenCalledTimes(1));
    expect(historyAPI.getZoneCardData).toHaveBeenLastCalledWith(
      12,
      'soil-card:root-zone',
      expect.objectContaining({
        range: expect.objectContaining({ label: 'custom' }),
      }),
    );
  });

  it('switches to the next view mode on vertical swipe inside the visualization surface', async () => {
    vi.mocked(historyAPI.getZoneCards).mockResolvedValue({
      zoneId: 12,
      generatedAt: '2026-05-31T10:00:00Z',
      cards: [
        zoneCard({
          cardId: 'soil-card:root-zone',
          title: 'Soil Moisture',
          defaultView: 'soil-profile',
          views: ['soil-profile', 'line-chart', 'calendar', 'advanced'],
        }),
      ],
    });

    renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

    expect(await screen.findByTestId('view-mode-label')).toHaveTextContent('Soil Profile');

    const surface = screen.getByTestId('history-visualization-surface');
    preparePointerTarget(surface);
    dispatchTouch(surface, 'touchstart', [{ clientX: 160, clientY: 260 }]);
    dispatchTouch(surface, 'touchmove', [{ clientX: 164, clientY: 70 }]);
    dispatchTouch(surface, 'touchend', []);

    await waitFor(() => {
      expect(screen.getByTestId('view-mode-label')).toHaveTextContent('Line Chart');
    });
  });

  it('filters stale API view modes through the frontend selectable-view policy', async () => {
    vi.mocked(historyAPI.getZoneCards).mockResolvedValue({
      zoneId: 12,
      generatedAt: '2026-05-31T10:00:00Z',
      cards: [
        zoneCard({
          cardId: 'environment-card:microclimate',
          cardType: 'environment',
          title: 'Environment - Microclimate',
          subtitle: 'Microclimate',
          defaultView: 'line-chart',
          views: ['line-chart', 'daily-min-max', 'calendar', 'stress-events', 'advanced'],
        }),
      ],
    });

    renderAppAtRoute('/history/zones/12/cards/environment-card%3Amicroclimate');

    expect(await screen.findByTestId('view-mode-label')).toHaveTextContent('Line Chart');

    const surface = screen.getByTestId('history-visualization-surface');
    preparePointerTarget(surface);
    dispatchTouch(surface, 'touchstart', [{ clientX: 160, clientY: 260 }]);
    dispatchTouch(surface, 'touchmove', [{ clientX: 164, clientY: 70 }]);
    dispatchTouch(surface, 'touchend', []);
    await waitFor(() => {
      expect(screen.getByTestId('view-mode-label')).toHaveTextContent('Daily Min/Max');
    });
    await waitFor(() => {
      expect(historyAPI.getZoneCardData).toHaveBeenLastCalledWith(
        12,
        'environment-card:microclimate',
        expect.objectContaining({
          view: 'daily-min-max',
          aggregation: 'daily',
        }),
      );
    });

    dispatchTouch(surface, 'touchstart', [{ clientX: 160, clientY: 260 }]);
    dispatchTouch(surface, 'touchmove', [{ clientX: 164, clientY: 70 }]);
    dispatchTouch(surface, 'touchend', []);
    await waitFor(() => {
      expect(screen.getByTestId('view-mode-label')).toHaveTextContent('Calendar');
    });

    dispatchTouch(surface, 'touchstart', [{ clientX: 160, clientY: 260 }]);
    dispatchTouch(surface, 'touchmove', [{ clientX: 164, clientY: 70 }]);
    dispatchTouch(surface, 'touchend', []);
    await waitFor(() => {
      expect(screen.getByTestId('view-mode-label')).toHaveTextContent('Line Chart');
    });
    expect(screen.getByTestId('view-mode-label')).not.toHaveTextContent('stress-events');
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
