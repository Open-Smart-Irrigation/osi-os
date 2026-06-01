import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { SWRConfig } from 'swr';

import { HistoryDashboard } from '../../../pages/HistoryDashboard';
import { HistoryOverviewCard } from '../mobile/HistoryOverviewCard';
import { historyAPI, irrigationZonesAPI, systemAPI } from '../../../services/api';
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
    'history.mobile.actions': 'History actions',
    'history.mobile.openActions': 'Open history actions',
    'history.mobile.zoneLabel': 'Zone',
    'history.overview.empty': 'No history cards are available for this zone yet.',
    'history.overview.openCard': 'Open {{title}} history',
    'history.overview.cardTypeLabel': '{{cardType}} card',
    'history.overview.pinCard': 'Pin card',
    'history.overview.unpinCard': 'Unpin card',
    'history.overview.pinCardForTitle': 'Pin {{title}} card',
    'history.overview.unpinCardForTitle': 'Unpin {{title}} card',
    'history.overview.pinned': 'Pinned',
    'history.overview.alert': 'Attention',
    'history.source.multipleNamed': '{{count}} sources: {{names}}',
    'history.source.multiple': '{{count}} sources',
    'history.cardType.soil': 'Soil',
    'history.cardType.environment': 'Environment',
    'history.cardType.gateway': 'Gateway',
    'history.metadata.coverageUnknown': 'Coverage unknown',
    'history.metadata.coverageKnown': '{{coverage}}% coverage',
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

function renderWithProviders(ui: React.ReactElement, route = '/history') {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </SWRConfig>,
  );
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  window.dispatchEvent(new Event('resize'));
}

function renderHistoryAtMobileWidth(route = '/history') {
  setViewportWidth(390);
  return renderWithProviders(<HistoryDashboard />, route);
}

function zone(id: number, name: string) {
  return {
    id,
    name,
    device_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    schedule: null,
  };
}

function card(overrides: Partial<HistoryCardSummary> = {}): HistoryCardSummary {
  return {
    cardId: 'soil-card:root-zone',
    cardType: 'soil',
    scope: 'zone',
    title: 'Soil - Root Zone',
    subtitle: 'Root-zone tension',
    defaultView: 'soil-profile',
    views: ['soil-profile', 'line-chart'],
    supportedRanges: ['24h', '7d'],
    defaultRange: '24h',
    sourceDeviceCount: 2,
    sourceLabels: ['Chameleon 1', 'Chameleon 2'],
    sourceDevices: [
      { name: 'Chameleon 1', typeId: 'DRAGINO_LSN50', role: 'soil' },
      { name: 'Chameleon 2', typeId: 'DRAGINO_LSN50', role: 'soil' },
    ],
    metadata: {
      coveragePct: null,
      coverageConfidence: 'unknown',
      syncState: 'local',
      sourceDeviceEui: 'A84041A75D5E7CFB',
    },
    availability: {
      available: true,
      reasons: [],
    },
    ordering: {
      pinned: false,
      score: 10,
      recentRank: 1,
      criticalAlert: true,
    },
    ...overrides,
  };
}

describe('History mobile overview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setViewportWidth(1024);
    vi.mocked(systemAPI.getFeatures).mockResolvedValue({
      historyUxEnabled: true,
      historyComparisonEnabled: true,
      historyWorkspacesEnabled: true,
      historyAdvancedOverlaysEnabled: false,
      historyCloudAiEnabled: false,
    });
    vi.mocked(irrigationZonesAPI.getAll).mockResolvedValue([
      zone(1, 'North Block'),
      zone(2, 'South Block'),
    ]);
    vi.mocked(historyAPI.getZoneCards).mockResolvedValue({
      zoneId: 1,
      generatedAt: '2026-06-01T14:20:31.473Z',
      cards: [card()],
    });
    vi.mocked(historyAPI.getZoneCardData).mockResolvedValue({
      cardId: 'soil-card:root-zone',
      cardType: 'soil',
      view: 'soil-profile',
      range: {
        label: '24h',
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-02T00:00:00.000Z',
        timezone: 'UTC',
      },
      aggregation: {
        level: 'raw',
        bucketSizeSeconds: null,
        coveragePct: null,
        coverageConfidence: 'unknown',
        pointCount: 0,
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
      freshness: { dataAsOf: null, syncState: 'local' },
      advancedFields: {},
    });
    vi.mocked(historyAPI.markZoneCardOpened).mockResolvedValue({
      cardId: 'soil-card:root-zone',
      scope: 'zone',
      pinned: false,
      manualOrder: null,
      openCount: 1,
      lastOpenedAt: '2026-06-01T14:21:00.000Z',
      lastViewMode: null,
      hidden: false,
      updatedAt: '2026-06-01T14:21:00.000Z',
    });
    vi.mocked(historyAPI.setZoneCardPreference).mockResolvedValue({
      cardId: 'soil-card:root-zone',
      scope: 'zone',
      pinned: true,
      manualOrder: null,
      openCount: 1,
      lastOpenedAt: null,
      lastViewMode: null,
      hidden: false,
      updatedAt: '2026-06-01T14:21:00.000Z',
    });
    vi.mocked(historyAPI.getWorkspaces).mockResolvedValue({
      generatedAt: '2026-06-01T14:20:31.473Z',
      workspaces: [],
    });
  });

  afterEach(() => {
    setViewportWidth(1024);
  });

  it('shows title, source, freshness, coverage, and status without chart controls', () => {
    renderWithProviders(
      <HistoryOverviewCard zoneId={12} card={card()} onTogglePinned={vi.fn()} />,
    );

    expect(screen.getByRole('link', { name: /Soil - Root Zone/i })).toHaveAttribute(
      'href',
      '/history/zones/12/cards/soil-card%3Aroot-zone',
    );
    expect(screen.getByText('2 sources: Chameleon 1, Chameleon 2')).toBeInTheDocument();
    expect(screen.getByText('Coverage unknown')).toBeInTheDocument();
    expect(screen.getByText('Local')).toBeInTheDocument();
    expect(screen.getByText('Attention')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pin Soil - Root Zone card' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Line Chart/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/[A-F0-9]{16}/)).not.toBeInTheDocument();
  });

  it('does not expose an EUI-like source label in normal overview', () => {
    renderWithProviders(
      <HistoryOverviewCard
        zoneId={12}
        card={card({
          sourceDeviceCount: undefined,
          sourceLabels: [],
          sourceDevices: [],
          sourceLabel: 'A84041A75D5E7CFB',
        })}
        onTogglePinned={vi.fn()}
      />,
    );

    expect(screen.getByRole('link', { name: /Soil - Root Zone/i })).toBeInTheDocument();
    expect(screen.queryByText('A84041A75D5E7CFB')).not.toBeInTheDocument();
  });

  it('keeps the overview card pin button from navigating', () => {
    const onTogglePinned = vi.fn();
    renderWithProviders(
      <HistoryOverviewCard zoneId={12} card={card()} onTogglePinned={onTogglePinned} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Pin Soil - Root Zone card' }));

    expect(onTogglePinned).toHaveBeenCalledWith('soil-card:root-zone', true);
  });

  it('renders compact mobile cards linking to encoded detail routes without inline full history detail', async () => {
    renderHistoryAtMobileWidth('/history');

    await screen.findByRole('heading', { name: 'History' });
    expect(screen.getByRole('link', { name: /Soil - Root Zone/i })).toHaveAttribute(
      'href',
      '/history/zones/1/cards/soil-card%3Aroot-zone',
    );
    expect(screen.queryByRole('region', { name: 'Timeline viewport' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Soil Profile' })).not.toBeInTheDocument();
    expect(screen.queryByText(/[A-F0-9]{16}/)).not.toBeInTheDocument();
  });

  it('does not mark the first card opened when mobile overview renders', async () => {
    renderHistoryAtMobileWidth('/history');

    await screen.findByRole('link', { name: /Soil - Root Zone/i });

    expect(historyAPI.markZoneCardOpened).not.toHaveBeenCalled();
  });

  it('does not show workspace or comparison controls on mobile overview', async () => {
    renderHistoryAtMobileWidth('/history');

    await screen.findByRole('heading', { name: 'History' });
    expect(screen.queryByRole('button', { name: 'Single' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Comparison' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save workspace' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update workspace' })).not.toBeInTheDocument();
  });

  it('keeps mobile utility actions behind one compact overflow button', async () => {
    renderHistoryAtMobileWidth('/history');

    await screen.findByRole('heading', { name: 'History' });
    expect(screen.getByRole('button', { name: 'Open history actions' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Legacy dashboard' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open history actions' }));

    expect(screen.getByRole('link', { name: 'Legacy dashboard' })).toHaveAttribute('href', '/dashboard');
    expect(screen.getByRole('button', { name: 'Logout' })).toBeInTheDocument();
  });

  it('toggles pinned card preference through the existing history API path', async () => {
    renderHistoryAtMobileWidth('/history');

    fireEvent.click(await screen.findByRole('button', { name: 'Pin Soil - Root Zone card' }));

    await waitFor(() => {
      expect(historyAPI.setZoneCardPreference).toHaveBeenCalledWith(
        1,
        'soil-card:root-zone',
        { pinned: true },
      );
    });
  });
});
