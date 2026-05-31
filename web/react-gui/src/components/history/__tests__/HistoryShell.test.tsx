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

vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({
    username: 'operator',
    logout: vi.fn(),
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
