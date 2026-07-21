import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { SWRConfig } from 'swr';

import { HistoryDashboard } from '../../../pages/HistoryDashboard';
import { ThematicCardCarousel } from '../ThematicCardCarousel';
import { systemAPI, historyAPI, irrigationZonesAPI } from '../../../services/api';
import type { HistoryCardSummary, HistoryWorkspace, HistoryWorkspaceRecord } from '../../../history/types';

const { translateForTest } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'history.nav.legacyDashboard': 'Legacy dashboard',
    'history.nav.logout': 'Logout',
    'history.shell.title': 'History',
    'history.shell.subtitle': 'Local gateway history for {{username}}',
    'history.shell.loadingLocalCards': 'Loading local history cards...',
    'history.shell.unavailableTitle': 'History is unavailable',
    'history.shell.unavailableBody': 'History is switched off on this gateway and will appear here once it is enabled.',
    'history.shell.featureFlagFailed': 'Could not check whether History is enabled. The legacy dashboard is still available.',
    'history.shell.zonesFailedTitle': 'History zones failed to load',
    'history.shell.noZonesTitle': 'No zones yet',
    'history.shell.noZonesBody': 'Create a zone from the legacy dashboard before opening history.',
    'history.shell.cardsFailed': 'History cards failed to load.',
    'history.shell.retryCards': 'Retry cards',
    'history.desktop.toolbarTitle': 'Toolbar',
    'history.desktop.maxPanels': 'Up to {{count}} comparison panels',
    'history.desktop.singleMode': 'Single',
    'history.desktop.comparisonMode': 'Comparison',
    'history.desktop.addPanel': 'Add panel {{title}}',
    'history.desktop.removePanel': 'Remove panel',
    'history.desktop.panelLimitWarning': 'Only {{count}} comparison panels can be shown on this gateway.',
    'history.desktop.selectedTimestampNone': 'No timestamp selected',
    'history.desktop.selectedTimestamp': 'Selected timestamp: {{timestamp}}',
    'history.desktop.inspectorTitle': 'Inspector',
    'history.desktop.inspectorPlaceholder': 'Select a timestamp or calendar cell to see interpretation, events, data quality, and advanced metadata.',
    'history.mobile.zoneLabel': 'Zone',
    'history.sidebar.zones': 'Zones',
    'history.sidebar.pinnedCards': 'Pinned cards',
    'history.sidebar.availableCards': 'Available cards',
    'history.sidebar.savedWorkspaces': 'Saved workspaces',
    'history.sidebar.workspaceDisabled': 'Workspace saving is not enabled yet.',
    'history.sidebar.workspaceName': 'Workspace name',
    'history.sidebar.saveWorkspace': 'Save workspace',
    'history.sidebar.updateWorkspace': 'Update workspace',
    'history.sidebar.loadWorkspace': 'Load {{name}}',
    'history.sidebar.deleteWorkspace': 'Delete {{name}}',
    'history.sidebar.defaultWorkspaceName': 'Local workspace',
    'history.sidebar.pinCard': 'Pin',
    'history.sidebar.unpinCard': 'Unpin',
    'history.sidebar.none': 'None',
    'history.carousel.empty': 'No history cards are available for this zone yet.',
    'history.carousel.ariaLabel': 'History card carousel',
    'history.carousel.cardAriaLabel': '{{title}} card',
    'history.carousel.cardTypeLabel': '{{cardType}} card',
    'history.carousel.pinned': 'Pinned',
    'history.source.multipleNamed': '{{count}} sources: {{names}}',
    'history.source.multiple': '{{count}} sources',
    'history.cardFrame.emptyTitle': 'Select a history card',
    'history.cardFrame.emptyBody': 'Choose a zone and a history card to inspect local history.',
    'history.cardFrame.typeHistory': '{{cardType}} history',
    'history.cardFrame.viewModes': '{{title}} view modes',
    'history.cardFrame.unavailable': 'This card is not available for the selected zone.',
    'history.cardFrame.timelineBrush': 'Timeline viewport',
    'history.cardFrame.timelineBrushKeyboardHelp': 'Use arrow keys to pan, plus or minus to zoom, and Home or Enter to reset.',
    'history.cardFrame.aggregationBadge': 'Aggregation: {{aggregation}}',
    'history.cardFrame.placeholderBody': 'Chart and calendar data will load here once card data is available.',
    'history.cardFrame.cardDataLoading': 'Loading card data...',
    'history.cardFrame.cardDataError': 'Card data failed to load: {{message}}',
    'history.cardFrame.cardDataUnknownError': 'Unknown error',
    'history.workspace.unavailablePanel': 'Unavailable panel',
    'history.workspace.repairPanel': 'Remove unavailable panel',
    'history.cardType.soil': 'Soil',
    'history.cardType.dendro': 'Dendrometer',
    'history.cardType.environment': 'Environment',
    'history.cardType.irrigation': 'Irrigation',
    'history.cardType.gateway': 'Gateway',
    'history.viewMode.soil-profile': 'Soil Profile',
    'history.viewMode.line-chart': 'Line Chart',
    'history.viewMode.growth-timeline': 'Growth timeline',
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
    markZoneCardOpened: vi.fn(),
    setZoneCardPreference: vi.fn(),
    getWorkspaces: vi.fn(),
    createWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
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

function workspace(overrides: Partial<HistoryWorkspace> = {}): HistoryWorkspace {
  return {
    schemaVersion: 1,
    farmId: null,
    hubId: null,
    zoneId: 1,
    zoneUuid: null,
    selectedCards: ['soil-zone-1'],
    panelOrder: ['soil-zone-1'],
    collapsedPanels: [],
    dateRange: { mode: 'relative', label: '24h', from: null, to: null },
    aggregation: 'raw',
    viewModesByCard: {},
    enabledOverlays: {},
    advancedOverlaySettings: {},
    limits: { platform: 'edge', maxPanels: 4 },
    inspector: { selectedTimestamp: null, open: true },
    pinnedCards: [],
    layout: 'single',
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
    vi.mocked(historyAPI.markZoneCardOpened).mockResolvedValue({
      cardId: 'soil-zone-1',
      scope: 'zone',
      pinned: false,
      manualOrder: null,
      openCount: 1,
      lastOpenedAt: '2026-05-31T10:01:00.000Z',
      lastViewMode: null,
      hidden: false,
      updatedAt: '2026-05-31T10:01:00.000Z',
    });
    vi.mocked(historyAPI.setZoneCardPreference).mockResolvedValue({
      cardId: 'soil-zone-1',
      scope: 'zone',
      pinned: true,
      manualOrder: null,
      openCount: 1,
      lastOpenedAt: '2026-05-31T10:01:00.000Z',
      lastViewMode: null,
      hidden: false,
      updatedAt: '2026-05-31T10:01:00.000Z',
    });
    vi.mocked(historyAPI.getWorkspaces).mockResolvedValue({
      generatedAt: '2026-05-31T10:00:00Z',
      workspaces: [],
    });
    vi.mocked(historyAPI.createWorkspace).mockResolvedValue({
      id: 1,
      userId: 1,
      ownerUserUuid: null,
      zoneId: 1,
      name: 'Local workspace',
      isDefault: false,
      workspace: {
        schemaVersion: 1,
        farmId: null,
        hubId: null,
        zoneId: 1,
        zoneUuid: null,
        selectedCards: ['soil-zone-1'],
        panelOrder: ['soil-zone-1'],
        collapsedPanels: [],
        dateRange: { mode: 'relative', label: '24h', from: null, to: null },
        aggregation: 'raw',
        viewModesByCard: {},
        enabledOverlays: {},
        advancedOverlaySettings: {},
        limits: { platform: 'edge', maxPanels: 4 },
        inspector: { selectedTimestamp: null, open: true },
        pinnedCards: [],
        layout: 'single',
      },
      createdAt: '2026-05-31T10:00:00Z',
      updatedAt: '2026-05-31T10:00:00Z',
    });
    vi.mocked(historyAPI.updateWorkspace).mockImplementation(async (workspaceId, payload) => {
      return {
        id: workspaceId,
        userId: 1,
        ownerUserUuid: null,
        zoneId: payload.zoneId,
        name: payload.name,
        isDefault: false,
        workspace: payload.workspace,
        createdAt: '2026-05-31T10:00:00Z',
        updatedAt: '2026-05-31T10:02:00Z',
      } as unknown as HistoryWorkspaceRecord;
    });
  });

  it('keeps history unavailable and retryable when runtime feature flags fail', async () => {
    vi.mocked(systemAPI.getFeatures).mockRejectedValue(new Error('feature endpoint missing'));

    renderWithProviders(React.createElement(HistoryDashboard));

    expect(screen.getByRole('heading', { level: 1, name: 'History' })).toBeInTheDocument();
    // Navigation is the shared AppHeader now: the Zones tab replaces the old
    // inline "legacy dashboard" link.
    expect(screen.queryByRole('link', { name: /legacy dashboard/i })).not.toBeInTheDocument();

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

  it('does not render implementation placeholder copy in the desktop toolbar', async () => {
    vi.mocked(systemAPI.getFeatures).mockResolvedValue({
      historyUxEnabled: true,
      historyComparisonEnabled: true,
      historyWorkspacesEnabled: false,
      historyAdvancedOverlaysEnabled: false,
      historyCloudAiEnabled: false,
    });

    renderWithProviders(React.createElement(HistoryDashboard));

    await screen.findByText('Toolbar');
    await screen.findByText('Aggregation: raw');
    expect(screen.queryByText(/land here in the visualization slice/i)).not.toBeInTheDocument();
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

  it('shows display-safe source names for merged cards without rendering raw hardware ids', () => {
    render(
      React.createElement(ThematicCardCarousel, {
        cards: [
          card({
            sourceDeviceCount: 2,
            sourceLabels: ['Chameleon 1', 'Chameleon 2'],
            sourceDevices: [
              { name: 'Chameleon 1', typeId: 'DRAGINO_LSN50', role: 'soil' },
              { name: 'Chameleon 2', typeId: 'DRAGINO_LSN50', role: 'soil' },
            ],
            metadata: {
              coveragePct: 96,
              coverageConfidence: 'configured',
              sourceDeviceEui: 'ABCDEF0123456789',
            },
          }),
        ],
        selectedCardId: 'soil-zone-1',
        onSelectCard: vi.fn(),
      }),
    );

    expect(screen.getByText('2 sources: Chameleon 1, Chameleon 2')).toBeInTheDocument();
    expect(screen.queryByText('ABCDEF0123456789')).not.toBeInTheDocument();
  });

  it('marks cards opened so the edge can update open count and last opened ordering hints', async () => {
    vi.mocked(systemAPI.getFeatures).mockResolvedValue({
      historyUxEnabled: true,
      historyComparisonEnabled: false,
      historyWorkspacesEnabled: false,
      historyAdvancedOverlaysEnabled: false,
      historyCloudAiEnabled: false,
    });
    vi.mocked(historyAPI.getZoneCards).mockResolvedValue({
      zoneId: 1,
      generatedAt: '2026-05-31T10:00:00Z',
      cards: [
        card(),
        card({
          cardId: 'environment-zone-1',
          cardType: 'environment',
          title: 'Environment',
          defaultView: 'line-chart',
          views: ['line-chart'],
          ordering: { pinned: false, score: 20, recentRank: 1 },
        }),
      ],
    });

    renderWithProviders(React.createElement(HistoryDashboard));

    await waitFor(() => {
      expect(historyAPI.markZoneCardOpened).toHaveBeenCalledWith(1, 'environment-zone-1');
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Soil card' }));

    await waitFor(() => {
      expect(historyAPI.markZoneCardOpened).toHaveBeenCalledWith(1, 'soil-zone-1');
    });
  });

  it('renders stacked comparison panels with the edge cap and a warning when the cap is exceeded', async () => {
    vi.mocked(systemAPI.getFeatures).mockResolvedValue({
      historyUxEnabled: true,
      historyComparisonEnabled: true,
      historyWorkspacesEnabled: true,
      historyAdvancedOverlaysEnabled: false,
      historyCloudAiEnabled: false,
    });
    vi.mocked(historyAPI.getZoneCards).mockResolvedValue({
      zoneId: 1,
      generatedAt: '2026-05-31T10:00:00Z',
      cards: ['soil-1', 'soil-2', 'soil-3', 'soil-4', 'soil-5'].map((cardId, index) =>
        card({
          cardId,
          title: `Soil ${index + 1}`,
          ordering: { pinned: false, score: 50 - index, recentRank: index + 1 },
        }),
      ),
    });

    renderWithProviders(React.createElement(HistoryDashboard));

    fireEvent.click(await screen.findByRole('button', { name: 'Comparison' }));
    for (const name of ['Soil 2', 'Soil 3', 'Soil 4', 'Soil 5']) {
      fireEvent.click(await screen.findByRole('button', { name: `Add panel ${name}` }));
    }

    await waitFor(() => {
      expect(screen.getAllByTestId('history-comparison-panel')).toHaveLength(4);
    });
    expect(screen.getByText('Only 4 comparison panels can be shown on this gateway.')).toBeInTheDocument();
    expect(screen.getByText('No timestamp selected')).toBeInTheDocument();
  });

  it('loads saved workspaces and renders dangling card IDs as unavailable panels', async () => {
    vi.mocked(systemAPI.getFeatures).mockResolvedValue({
      historyUxEnabled: true,
      historyComparisonEnabled: true,
      historyWorkspacesEnabled: true,
      historyAdvancedOverlaysEnabled: false,
      historyCloudAiEnabled: false,
    });
    vi.mocked(historyAPI.getWorkspaces).mockResolvedValue({
      generatedAt: '2026-05-31T10:00:00Z',
      workspaces: [
        {
          id: 8,
          userId: 1,
          ownerUserUuid: null,
          zoneId: 1,
          name: 'Morning check',
          isDefault: false,
          workspace: {
            schemaVersion: 1,
            farmId: null,
            hubId: null,
            zoneId: 1,
            zoneUuid: null,
            selectedCards: ['missing-card', 'soil-zone-1'],
            panelOrder: ['missing-card', 'soil-zone-1'],
            collapsedPanels: [],
            dateRange: { mode: 'relative', label: '24h', from: null, to: null },
            aggregation: 'raw',
            viewModesByCard: {},
            enabledOverlays: {},
            advancedOverlaySettings: {},
            limits: { platform: 'edge', maxPanels: 4 },
            inspector: { selectedTimestamp: null, open: true },
            pinnedCards: [],
            layout: 'stacked',
          },
          createdAt: '2026-05-31T10:00:00Z',
          updatedAt: '2026-05-31T10:00:00Z',
        },
      ],
    });

    renderWithProviders(React.createElement(HistoryDashboard));

    fireEvent.click(await screen.findByRole('button', { name: 'Load Morning check' }));

    expect(await screen.findByText('Unavailable panel')).toBeInTheDocument();
    expect(screen.queryByText('missing-card')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('history-comparison-panel')).toHaveLength(2);
  });

  it('does not expose saved workspaces from other zones in the selected zone shell', async () => {
    vi.mocked(systemAPI.getFeatures).mockResolvedValue({
      historyUxEnabled: true,
      historyComparisonEnabled: true,
      historyWorkspacesEnabled: true,
      historyAdvancedOverlaysEnabled: false,
      historyCloudAiEnabled: false,
    });
    vi.mocked(irrigationZonesAPI.getAll).mockResolvedValue([
      {
        id: 1,
        name: 'North Block',
        device_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        schedule: null,
      },
      {
        id: 2,
        name: 'South Block',
        device_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        schedule: null,
      },
    ]);
    vi.mocked(historyAPI.getWorkspaces).mockResolvedValue({
      generatedAt: '2026-05-31T10:00:00Z',
      workspaces: [
        {
          id: 11,
          userId: 1,
          ownerUserUuid: null,
          zoneId: 1,
          name: 'North workspace',
          isDefault: false,
          workspace: workspace(),
          createdAt: '2026-05-31T10:00:00Z',
          updatedAt: '2026-05-31T10:00:00Z',
        },
        {
          id: 12,
          userId: 1,
          ownerUserUuid: null,
          zoneId: 2,
          name: 'South workspace',
          isDefault: false,
          workspace: workspace({ zoneId: 2, selectedCards: ['soil-zone-2'], panelOrder: ['soil-zone-2'] }),
          createdAt: '2026-05-31T10:00:00Z',
          updatedAt: '2026-05-31T10:00:00Z',
        },
      ],
    });

    renderWithProviders(React.createElement(HistoryDashboard));

    expect(await screen.findByRole('button', { name: 'Load North workspace' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load South workspace' })).not.toBeInTheDocument();
  });

  it('saves and updates workspaces against the currently selected zone after switching zones', async () => {
    vi.mocked(systemAPI.getFeatures).mockResolvedValue({
      historyUxEnabled: true,
      historyComparisonEnabled: true,
      historyWorkspacesEnabled: true,
      historyAdvancedOverlaysEnabled: false,
      historyCloudAiEnabled: false,
    });
    vi.mocked(irrigationZonesAPI.getAll).mockResolvedValue([
      {
        id: 1,
        name: 'North Block',
        device_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        schedule: null,
      },
      {
        id: 2,
        name: 'South Block',
        device_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        schedule: null,
      },
    ]);
    vi.mocked(historyAPI.getZoneCards).mockImplementation(async (zoneId) => ({
      zoneId,
      generatedAt: '2026-05-31T10:00:00Z',
      cards: [
        card({
          cardId: `soil-zone-${zoneId}`,
          title: zoneId === 2 ? 'South Soil' : 'North Soil',
          subtitle: zoneId === 2 ? 'South Block' : 'North Block',
        }),
      ],
    }));
    vi.mocked(historyAPI.getWorkspaces).mockResolvedValue({
      generatedAt: '2026-05-31T10:00:00Z',
      workspaces: [
        {
          id: 21,
          userId: 1,
          ownerUserUuid: null,
          zoneId: 1,
          name: 'North workspace',
          isDefault: false,
          workspace: workspace({ zoneId: 1, selectedCards: ['soil-zone-1'], panelOrder: ['soil-zone-1'] }),
          createdAt: '2026-05-31T10:00:00Z',
          updatedAt: '2026-05-31T10:00:00Z',
        },
        {
          id: 22,
          userId: 1,
          ownerUserUuid: null,
          zoneId: 2,
          name: 'South workspace',
          isDefault: false,
          workspace: workspace({ zoneId: 2, selectedCards: ['soil-zone-2'], panelOrder: ['soil-zone-2'] }),
          createdAt: '2026-05-31T10:00:00Z',
          updatedAt: '2026-05-31T10:00:00Z',
        },
      ],
    });

    renderWithProviders(React.createElement(HistoryDashboard));

    fireEvent.click((await screen.findAllByRole('button', { name: 'South Block' }))[0]);
    await waitFor(() => {
      expect(historyAPI.getZoneCards).toHaveBeenCalledWith(2);
    });
    expect(await screen.findByRole('button', { name: 'Load South workspace' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load North workspace' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load South workspace' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Update workspace' })).not.toBeDisabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update workspace' }));
    await waitFor(() => {
      expect(historyAPI.updateWorkspace).toHaveBeenCalledWith(
        22,
        expect.objectContaining({ name: 'South workspace', zoneId: 2 }),
      );
    });
    expect(vi.mocked(historyAPI.updateWorkspace).mock.calls[0][1].workspace!.zoneId).toBe(2);

    fireEvent.click(screen.getByRole('button', { name: 'Save workspace' }));
    await waitFor(() => {
      expect(historyAPI.createWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'South workspace', zoneId: 2 }),
      );
    });
    expect(vi.mocked(historyAPI.createWorkspace).mock.calls[0][0].workspace.zoneId).toBe(2);
  });

  it('updates saved workspaces with live view and viewport state without dropping workspace fields', async () => {
    vi.mocked(systemAPI.getFeatures).mockResolvedValue({
      historyUxEnabled: true,
      historyComparisonEnabled: true,
      historyWorkspacesEnabled: true,
      historyAdvancedOverlaysEnabled: true,
      historyCloudAiEnabled: false,
    });
    const savedWorkspace: HistoryWorkspace = {
      schemaVersion: 1,
      farmId: null,
      hubId: null,
      zoneId: 1,
      zoneUuid: 'zone-north',
      selectedCards: ['soil-zone-1'],
      panelOrder: ['soil-zone-1'],
      collapsedPanels: ['soil-zone-1'],
      dateRange: {
        mode: 'absolute',
        label: 'custom',
        from: '2026-05-30T00:00:00.000Z',
        to: '2026-05-31T00:00:00.000Z',
      },
      aggregation: 'hourly',
      viewModesByCard: { 'soil-zone-1': 'soil-profile' },
      enabledOverlays: { 'soil-zone-1': ['data-gaps', 'threshold-lines'] },
      advancedOverlaySettings: {
        'soil-zone-1': { normalize: true, separateYAxes: true },
      },
      limits: { platform: 'edge', maxPanels: 4 },
      inspector: { selectedTimestamp: '2026-05-30T12:00:00.000Z', open: false },
      pinnedCards: ['soil-zone-1'],
      layout: 'single',
      futurePanelState: { preserved: true },
    };
    vi.mocked(historyAPI.getWorkspaces).mockResolvedValue({
      generatedAt: '2026-05-31T10:00:00Z',
      workspaces: [
        {
          id: 9,
          userId: 1,
          ownerUserUuid: null,
          zoneId: 1,
          name: 'Detailed soil',
          isDefault: false,
          workspace: savedWorkspace,
          createdAt: '2026-05-31T10:00:00Z',
          updatedAt: '2026-05-31T10:00:00Z',
        },
      ],
    });

    renderWithProviders(React.createElement(HistoryDashboard));

    await screen.findByRole('button', { name: 'Soil card' });
    fireEvent.click(await screen.findByRole('button', { name: 'Load Detailed soil' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Update workspace' })).not.toBeDisabled();
    });
    const lineChartButtons = await screen.findAllByRole('button', { name: 'Line Chart' });
    fireEvent.click(lineChartButtons[0]);
    fireEvent.wheel(screen.getAllByRole('region', { name: 'Timeline viewport' })[0], { deltaY: -100 });
    fireEvent.click(screen.getByRole('button', { name: 'Update workspace' }));

    await waitFor(() => {
      expect(historyAPI.updateWorkspace).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ name: 'Detailed soil', zoneId: 1 }),
      );
    });
    const payload = vi.mocked(historyAPI.updateWorkspace).mock.calls[0][1];
    const assertWorkspaceState = (persistedWorkspace: HistoryWorkspace) => {
      expect(persistedWorkspace.viewModesByCard).toMatchObject({ 'soil-zone-1': 'line-chart' });
      expect(persistedWorkspace.dateRange).toMatchObject({
        mode: 'absolute',
        label: 'custom',
      });
      expect(persistedWorkspace.dateRange.from).not.toBe(savedWorkspace.dateRange.from);
      expect(persistedWorkspace.aggregation).toBe('auto');
      expect(persistedWorkspace.enabledOverlays).toEqual(savedWorkspace.enabledOverlays);
      expect(persistedWorkspace.advancedOverlaySettings).toEqual(savedWorkspace.advancedOverlaySettings);
      expect(persistedWorkspace.collapsedPanels).toEqual(savedWorkspace.collapsedPanels);
      expect(persistedWorkspace.inspector).toEqual(savedWorkspace.inspector);
      expect(persistedWorkspace.futurePanelState).toEqual(savedWorkspace.futurePanelState);
    };
    assertWorkspaceState(payload.workspace!);

    fireEvent.click(screen.getByRole('button', { name: 'Save workspace' }));
    await waitFor(() => {
      expect(historyAPI.createWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Detailed soil', zoneId: 1 }),
      );
    });
    const createPayload = vi.mocked(historyAPI.createWorkspace).mock.calls[0][0];
    assertWorkspaceState(createPayload.workspace);
  });
});
