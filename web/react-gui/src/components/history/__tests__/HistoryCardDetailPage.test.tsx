import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    'history.viewMode.status-overview': 'Status Overview',
    'history.metadata.coverageUnknown': 'Coverage unknown',
    'history.metadata.coverageKnown': '{{coverage}}% coverage',
    'history.metadata.coverageConfidence.configured': 'Configured cadence',
    'history.metadata.coverageConfidence.unknown': 'Cadence unknown',
    'history.metadata.syncState.local': 'Local',
    'history.metadata.syncState.synced': 'Synced',
    'history.metadata.syncState.unknown': 'Unknown',
    'history.metadata.aggregation.raw': 'Raw',
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
};

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
});
