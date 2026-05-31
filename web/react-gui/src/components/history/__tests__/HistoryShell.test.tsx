import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { SWRConfig } from 'swr';

import { HistoryDashboard } from '../../../pages/HistoryDashboard';
import { ThematicCardCarousel } from '../ThematicCardCarousel';
import { systemAPI, historyAPI, irrigationZonesAPI } from '../../../services/api';
import type { HistoryCardSummary } from '../../../history/types';

const { translateForTest } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'history.nav.legacyDashboard': 'Legacy dashboard',
    'history.nav.logout': 'Logout',
    'history.shell.title': 'History',
    'history.shell.subtitle': 'Local gateway history for {{username}}',
    'history.shell.loadingLocalCards': 'Loading local history cards...',
    'history.shell.unavailableTitle': 'History is unavailable',
    'history.shell.unavailableBody': 'Runtime feature flags keep the new history shell off until the local gateway enables it.',
    'history.shell.featureFlagFailed': 'The feature flag request failed. The legacy dashboard is still available.',
    'history.shell.zonesFailedTitle': 'History zones failed to load',
    'history.shell.noZonesTitle': 'No zones yet',
    'history.shell.noZonesBody': 'Create an irrigation zone from the legacy dashboard before opening thematic history.',
    'history.shell.cardsFailed': 'History cards failed to load.',
    'history.shell.retryCards': 'Retry cards',
    'history.desktop.toolbarTitle': 'Toolbar',
    'history.desktop.toolbarPlaceholder': 'Date range, aggregation, export, and sync controls land here in the visualization slice.',
    'history.desktop.maxPanels': 'Up to {{count}} comparison panels',
    'history.desktop.inspectorTitle': 'Inspector',
    'history.desktop.inspectorPlaceholder': 'Select a timestamp or calendar cell to see interpretation, events, data quality, and advanced metadata.',
    'history.mobile.zoneLabel': 'Zone',
    'history.sidebar.zones': 'Zones',
    'history.sidebar.pinnedCards': 'Pinned cards',
    'history.sidebar.availableCards': 'Available cards',
    'history.sidebar.savedWorkspaces': 'Saved workspaces',
    'history.sidebar.workspaceDisabled': 'Workspace saving is not enabled on this slice.',
    'history.sidebar.none': 'None',
    'history.carousel.empty': 'No history cards are available for this zone yet.',
    'history.carousel.ariaLabel': 'History card carousel',
    'history.carousel.cardAriaLabel': '{{title}} card',
    'history.carousel.cardTypeLabel': '{{cardType}} card',
    'history.carousel.pinned': 'Pinned',
    'history.cardFrame.emptyTitle': 'Select a history card',
    'history.cardFrame.emptyBody': 'Choose a zone and thematic card to inspect local history.',
    'history.cardFrame.typeHistory': '{{cardType}} history',
    'history.cardFrame.viewModes': '{{title}} view modes',
    'history.cardFrame.unavailable': 'This card is not available for the selected zone.',
    'history.cardFrame.timelineBrush': 'Timeline viewport',
    'history.cardFrame.aggregationBadge': 'Aggregation: {{aggregation}}',
    'history.cardFrame.placeholderBody': 'Chart and calendar data will load here when card data APIs are enabled.',
    'history.cardType.soil': 'Soil',
    'history.cardType.dendro': 'Dendro',
    'history.cardType.environment': 'Environment',
    'history.cardType.irrigation': 'Irrigation',
    'history.cardType.gateway': 'Gateway',
    'history.viewMode.soil-profile': 'Soil Profile',
    'history.viewMode.line-chart': 'Line Chart',
    'history.viewMode.growth-timeline': 'Growth Timeline',
    'history.viewMode.stress-events': 'Stress Events',
    'history.metadata.coverageUnknown': 'Coverage unknown',
    'history.metadata.coverageKnown': '{{coverage}}% coverage',
    'history.metadata.coverageConfidence.configured': 'Configured cadence',
    'history.metadata.coverageConfidence.derived': 'Derived cadence',
    'history.metadata.coverageConfidence.unknown': 'Cadence unknown',
    'history.metadata.syncState.local': 'Local',
    'history.metadata.syncState.synced': 'Synced',
    'history.metadata.syncState.stale': 'Stale',
    'history.metadata.syncState.degraded': 'Degraded',
    'history.metadata.syncState.unknown': 'Unknown',
    retry: 'Retry',
  };

  return {
    translateForTest: (key: string, options?: Record<string, unknown>): string => {
      const template = translations[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''));
    },
  };
});

vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({
    username: 'operator',
    logout: vi.fn(),
  }),
}));

vi.mock('../../../components/LanguageSwitcher', () => ({
  LanguageSwitcher: () => React.createElement('div', null, 'Language'),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translateForTest,
  }),
}));

vi.mock('../../../services/api', () => ({
  systemAPI: {
    getFeatures: vi.fn(),
  },
  historyAPI: {
    getZoneCards: vi.fn(),
    getZoneCardData: vi.fn(),
    getGatewayCardData: vi.fn(),
  },
  irrigationZonesAPI: {
    getAll: vi.fn(),
  },
}));

function renderWithProviders(ui: React.ReactElement) {
  return render(
    React.createElement(
      SWRConfig,
      { value: { provider: () => new Map(), dedupingInterval: 0 } },
      React.createElement(MemoryRouter, null, ui),
    ),
  );
}

function card(overrides: Partial<HistoryCardSummary> = {}): HistoryCardSummary {
  return {
    cardId: 'soil-zone-1',
    cardType: 'soil',
    scope: 'zone',
    title: 'Soil',
    subtitle: 'North Block',
    defaultView: 'soil-profile',
    views: ['soil-profile', 'line-chart'],
    supportedRanges: ['24h', '7d'],
    defaultRange: '24h',
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
      recentRank: 2,
    },
    ...overrides,
  };
}

describe('History shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(irrigationZonesAPI.getAll).mockResolvedValue([
      {
        id: 1,
        name: 'North Block',
        device_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        schedule: null,
      },
    ]);
    vi.mocked(historyAPI.getZoneCards).mockResolvedValue({
      zoneId: 1,
      generatedAt: '2026-05-31T10:00:00Z',
      cards: [card()],
    });
    vi.mocked(historyAPI.getZoneCardData).mockResolvedValue({
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
  });

  it('keeps history unavailable and retryable when runtime feature flags fail', async () => {
    vi.mocked(systemAPI.getFeatures).mockRejectedValue(new Error('feature endpoint missing'));

    renderWithProviders(React.createElement(HistoryDashboard));

    expect(screen.getByRole('heading', { level: 1, name: 'History' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /legacy dashboard/i })).toHaveAttribute('href', '/dashboard');

    await screen.findByText(/history is unavailable/i);
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(historyAPI.getZoneCards).not.toHaveBeenCalled();
  });

  it('loads zone cards only after the history flag is enabled', async () => {
    vi.mocked(systemAPI.getFeatures).mockResolvedValue({
      historyUxEnabled: true,
      historyComparisonEnabled: false,
      historyWorkspacesEnabled: false,
      historyAdvancedOverlaysEnabled: false,
      historyCloudAiEnabled: false,
    });

    renderWithProviders(React.createElement(HistoryDashboard));

    await waitFor(() => {
      expect(historyAPI.getZoneCards).toHaveBeenCalledWith(1);
    });
    expect(await screen.findByRole('button', { name: 'Soil card' })).toBeInTheDocument();
    expect(screen.queryByText('ABCDEF0123456789')).not.toBeInTheDocument();
  });

  it('orders pinned cards first in the mobile carousel without rendering raw hardware ids', () => {
    const onSelect = vi.fn();
    const cards = [
      card({
        cardId: 'environment-zone-1',
        cardType: 'environment',
        title: 'Environment',
        subtitle: 'Canopy weather',
        defaultView: 'line-chart',
        views: ['line-chart', 'calendar'],
        ordering: { pinned: false, score: 90, recentRank: 1 },
      }),
      card({
        cardId: 'dendro-zone-1',
        cardType: 'dendro',
        title: 'Dendro',
        subtitle: 'Reference tree',
        defaultView: 'growth-timeline',
        views: ['growth-timeline', 'stress-events'],
        ordering: { pinned: true, score: 20, recentRank: 3 },
      }),
    ];

    render(
      React.createElement(ThematicCardCarousel, {
        cards,
        selectedCardId: 'dendro-zone-1',
        onSelectCard: onSelect,
      }),
    );

    const buttons = screen.getAllByRole('button', { name: /card$/i });
    expect(buttons[0]).toHaveTextContent('Dendro');
    expect(buttons[1]).toHaveTextContent('Environment');
    expect(screen.queryByText('ABCDEF0123456789')).not.toBeInTheDocument();

    fireEvent.click(buttons[1]);
    expect(onSelect).toHaveBeenCalledWith('environment-zone-1');
  });
});
