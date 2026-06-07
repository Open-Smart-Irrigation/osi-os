import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { SWRConfig } from 'swr';

import { HistoryDesktopDetail } from '../desktop/HistoryDesktopDetail';
import type { HistoryCardSummary } from '../../../history/types';
import type { HistoryCardDataScope } from '../../../history/useHistoryCardData';

// Mock the translation hook
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts?.defaultValue) return opts.defaultValue as string;
      return key;
    },
  }),
}));

// Mock useHistoryCardData to avoid network calls
vi.mock('../../../history/useHistoryCardData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../history/useHistoryCardData')>();
  return {
    ...actual,
    useHistoryCardData: vi.fn(() => ({
      data: undefined,
      error: null,
      isLoading: false,
      refresh: vi.fn(),
    })),
  };
});

// HistoryCardVisualization makes Recharts calls that don't work in jsdom; stub lightly
vi.mock('../HistoryCardVisualization', () => ({
  HistoryCardVisualization: ({ card }: { card: HistoryCardSummary }) =>
    React.createElement('div', { 'data-testid': 'card-visualization' }, `Visualization: ${card.cardId}`),
}));

function makeCard(overrides: Partial<HistoryCardSummary> = {}): HistoryCardSummary {
  return {
    cardId: 'soil-card:root-zone',
    cardType: 'soil',
    scope: 'zone',
    title: 'Soil Moisture',
    subtitle: 'North Block',
    defaultView: 'soil-profile',
    views: ['soil-profile', 'line-chart'],
    supportedRanges: ['24h', '7d'],
    defaultRange: '24h',
    sourceLabels: ['Chameleon 1'],
    metadata: {
      coveragePct: 96,
      coverageConfidence: 'configured',
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

const baseScope: HistoryCardDataScope = { type: 'zone', zoneId: 12 };

function renderDesktopDetail(
  cards: HistoryCardSummary[],
  selectedCard: HistoryCardSummary,
  zoneName: string | null = 'North Block',
  scope: HistoryCardDataScope = baseScope,
  onCardSelect = vi.fn(),
) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <HistoryDesktopDetail
        cards={cards}
        selectedCard={selectedCard}
        zoneName={zoneName}
        scope={scope}
        onCardSelect={onCardSelect}
      />
    </SWRConfig>,
  );
}

describe('HistoryDesktopDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a desktop-chart-surface with correct testid', () => {
    const card = makeCard();
    renderDesktopDetail([card], card);
    expect(screen.getByTestId('desktop-chart-surface')).toBeInTheDocument();
  });

  it('renders display-safe card titles in the rail (no raw 16-hex DevEUI)', () => {
    const soil = makeCard({ cardId: 'soil-card:root-zone', title: 'Soil Moisture' });
    const env = makeCard({
      cardId: 'env-card:microclimate',
      cardType: 'environment',
      title: 'Environment',
      defaultView: 'line-chart',
    });
    renderDesktopDetail([soil, env], soil);

    expect(screen.getByRole('button', { name: 'Soil Moisture' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Environment' })).toBeInTheDocument();
  });

  it('does not render raw 16-char hex DevEUI titles in the rail', () => {
    const rawEuiTitle = 'A84041A75D5E7CFB';
    const card = makeCard({ title: rawEuiTitle });
    renderDesktopDetail([card], card);

    // raw DevEUI must not appear in any rail button
    expect(screen.queryByRole('button', { name: rawEuiTitle })).not.toBeInTheDocument();
    // Should fall back to cardType
    expect(screen.getByRole('button', { name: 'soil' })).toBeInTheDocument();
  });

  it('marks the currently selected card with aria-current in the rail', () => {
    const soil = makeCard({ cardId: 'soil-card:root-zone', title: 'Soil Moisture' });
    const env = makeCard({
      cardId: 'env-card:microclimate',
      cardType: 'environment',
      title: 'Environment',
      defaultView: 'line-chart',
    });
    renderDesktopDetail([soil, env], soil);

    expect(screen.getByRole('button', { name: 'Soil Moisture' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Environment' })).not.toHaveAttribute('aria-current');
  });

  it('calls onCardSelect when a rail card is clicked', () => {
    const soil = makeCard({ cardId: 'soil-card:root-zone', title: 'Soil Moisture' });
    const env = makeCard({
      cardId: 'env-card:microclimate',
      cardType: 'environment',
      title: 'Environment',
      defaultView: 'line-chart',
    });
    const onCardSelect = vi.fn();
    renderDesktopDetail([soil, env], soil, 'North Block', baseScope, onCardSelect);

    fireEvent.click(screen.getByRole('button', { name: 'Environment' }));
    expect(onCardSelect).toHaveBeenCalledWith(env);
  });

  it('renders zoom-in (+), zoom-out (−), and reset (↺) controls', () => {
    const card = makeCard();
    renderDesktopDetail([card], card);

    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toBeInTheDocument();
  });

  it('renders range preset buttons 24h, 7D, 30D, Season', () => {
    const card = makeCard();
    renderDesktopDetail([card], card);

    expect(screen.getByRole('button', { name: '24h' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '7D' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30D' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Season' })).toBeInTheDocument();
  });

  it('renders the overview strip', () => {
    const card = makeCard();
    renderDesktopDetail([card], card);
    expect(screen.getByTestId('overview-window')).toBeInTheDocument();
  });

  it('renders a composed header title (card title + zone name) without raw EUI', async () => {
    const card = makeCard({ title: 'Soil Moisture', scope: 'zone' });
    renderDesktopDetail([card], card, 'North Block');

    // composeDetailTitle appends zone if not already in title
    await waitFor(() => {
      expect(screen.getByText('Soil Moisture North Block')).toBeInTheDocument();
    });
  });

  it('renders chart visualization inside the desktop-chart-surface', () => {
    const card = makeCard();
    renderDesktopDetail([card], card);
    const surface = screen.getByTestId('desktop-chart-surface');
    expect(surface).toContainElement(screen.getByTestId('card-visualization'));
  });
});
