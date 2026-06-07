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

  it('clicking zoom-in (+) narrows the overview-window width', () => {
    const card = makeCard();
    renderDesktopDetail([card], card);

    const window = screen.getByTestId('overview-window');
    const widthBefore = window.style.width;

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));

    const widthAfter = window.style.width;
    // After zooming in the viewport span shrinks, so the overview window becomes narrower.
    // Both values are percentage strings like "50%"; compare as floats.
    const parsePct = (s: string) => parseFloat(s);
    expect(parsePct(widthAfter)).toBeLessThan(parsePct(widthBefore));
  });

  // --- Keyboard controls ---

  it('has aria-label on chart surface describing keyboard controls', () => {
    const card = makeCard();
    renderDesktopDetail([card], card);
    const surface = screen.getByTestId('desktop-chart-surface');
    expect(surface).toHaveAttribute('aria-label');
    // label must mention arrows and zoom/plus/minus so screen-reader users understand
    const label = surface.getAttribute('aria-label') ?? '';
    expect(label.toLowerCase()).toMatch(/arrow/);
    expect(label.toLowerCase()).toMatch(/pan|zoom/);
  });

  it('ArrowRight keydown pans the viewport later in time (overview-window left% increases)', () => {
    const card = makeCard();
    renderDesktopDetail([card], card);

    // The initial viewport sits at the right edge of bounds (resetViewport anchors to maxMs),
    // so panning right would be clamped. Pan left first to create headroom.
    const surface = screen.getByTestId('desktop-chart-surface');
    fireEvent.keyDown(surface, { key: 'ArrowLeft' });

    const overviewWindow = screen.getByTestId('overview-window');
    const leftAfterLeft = parseFloat(overviewWindow.style.left);

    fireEvent.keyDown(surface, { key: 'ArrowRight' });
    const leftAfterRight = parseFloat(overviewWindow.style.left);

    expect(leftAfterRight).toBeGreaterThan(leftAfterLeft);
  });

  it('ArrowLeft keydown pans the viewport earlier in time (overview-window left% decreases)', () => {
    const card = makeCard();
    renderDesktopDetail([card], card);

    // First pan right so there is room to pan back left
    const surface = screen.getByTestId('desktop-chart-surface');
    fireEvent.keyDown(surface, { key: 'ArrowRight' });

    const overviewWindow = screen.getByTestId('overview-window');
    const leftAfterRight = parseFloat(overviewWindow.style.left);

    fireEvent.keyDown(surface, { key: 'ArrowLeft' });
    const leftAfterLeft = parseFloat(overviewWindow.style.left);

    expect(leftAfterLeft).toBeLessThan(leftAfterRight);
  });

  it('+ keydown narrows the overview-window width (zoom in)', () => {
    const card = makeCard();
    renderDesktopDetail([card], card);

    const overviewWindow = screen.getByTestId('overview-window');
    const widthBefore = parseFloat(overviewWindow.style.width);

    const surface = screen.getByTestId('desktop-chart-surface');
    fireEvent.keyDown(surface, { key: '+' });

    const widthAfter = parseFloat(overviewWindow.style.width);
    expect(widthAfter).toBeLessThan(widthBefore);
  });

  it('= keydown also narrows the overview-window width (zoom in, unshifted + key)', () => {
    const card = makeCard();
    renderDesktopDetail([card], card);

    const overviewWindow = screen.getByTestId('overview-window');
    const widthBefore = parseFloat(overviewWindow.style.width);

    const surface = screen.getByTestId('desktop-chart-surface');
    fireEvent.keyDown(surface, { key: '=' });

    const widthAfter = parseFloat(overviewWindow.style.width);
    expect(widthAfter).toBeLessThan(widthBefore);
  });

  it('- keydown widens the overview-window width (zoom out)', () => {
    // First zoom in so we have room to zoom out
    const card = makeCard();
    renderDesktopDetail([card], card);

    const surface = screen.getByTestId('desktop-chart-surface');
    fireEvent.keyDown(surface, { key: '+' });
    fireEvent.keyDown(surface, { key: '+' });

    const overviewWindow = screen.getByTestId('overview-window');
    const widthAfterZoomIn = parseFloat(overviewWindow.style.width);

    fireEvent.keyDown(surface, { key: '-' });
    const widthAfterZoomOut = parseFloat(overviewWindow.style.width);

    expect(widthAfterZoomOut).toBeGreaterThan(widthAfterZoomIn);
  });

  it('0 keydown resets the viewport to the default span', () => {
    const card = makeCard();
    renderDesktopDetail([card], card);

    const overviewWindow = screen.getByTestId('overview-window');
    const widthInitial = parseFloat(overviewWindow.style.width);

    // Zoom in several times to change the viewport
    const surface = screen.getByTestId('desktop-chart-surface');
    fireEvent.keyDown(surface, { key: '+' });
    fireEvent.keyDown(surface, { key: '+' });
    fireEvent.keyDown(surface, { key: '+' });

    const widthZoomed = parseFloat(overviewWindow.style.width);
    expect(widthZoomed).toBeLessThan(widthInitial);

    // Reset
    fireEvent.keyDown(surface, { key: '0' });
    const widthAfterReset = parseFloat(overviewWindow.style.width);

    // After reset the width should be back close to the initial value
    expect(widthAfterReset).toBeCloseTo(widthInitial, 0);
  });
});
