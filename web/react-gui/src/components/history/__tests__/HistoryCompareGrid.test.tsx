import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { SWRConfig } from 'swr';

import { HistoryCompareGrid } from '../desktop/HistoryCompareGrid';
import type { HistoryCardSummary } from '../../../history/types';
import type { HistoryCardDataScope } from '../../../history/useHistoryCardData';
import type { HistoryViewport } from '../../../history/historyViewport';

// Mock translation hook
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.defaultValue ? (opts.defaultValue as string) : key,
  }),
}));

// Mock useHistoryCardData — returns a small fixture so panels can render
vi.mock('../../../history/useHistoryCardData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../history/useHistoryCardData')>();
  return {
    ...actual,
    useHistoryCardData: vi.fn(() => ({
      data: {
        series: [
          {
            id: 'swt_1',
            label: 'SWT 1',
            unit: 'kPa',
            points: [
              { t: '2026-06-01T10:00:00Z', value: 42, coverageConfidence: 'configured' },
            ],
          },
        ],
      },
      error: null,
      isLoading: false,
      refresh: vi.fn(),
    })),
  };
});

// Stub HistoryCardVisualization so we don't need Recharts in jsdom
vi.mock('../HistoryCardVisualization', () => ({
  HistoryCardVisualization: ({
    card,
    window: chartWindow,
  }: {
    card: HistoryCardSummary;
    window?: { fromMs: number; toMs: number };
  }) =>
    React.createElement(
      'div',
      {
        'data-testid': 'card-visualization',
        'data-card-id': card.cardId,
        'data-from-ms': chartWindow?.fromMs,
        'data-to-ms': chartWindow?.toMs,
      },
      `Visualization: ${card.cardId}`,
    ),
}));

// ---------- helpers ----------

function makeCard(overrides: Partial<HistoryCardSummary> = {}): HistoryCardSummary {
  return {
    cardId: 'soil-card:root-zone',
    cardType: 'soil',
    scope: 'zone',
    title: 'Soil Moisture',
    subtitle: 'Root Zone',
    defaultView: 'soil-profile',
    views: ['soil-profile', 'line-chart'],
    supportedRanges: ['24h', '7d'],
    defaultRange: '24h',
    sourceLabels: ['Chameleon 1'],
    metadata: { coveragePct: 96, coverageConfidence: 'configured' },
    availability: { available: true, reasons: [] },
    ordering: { pinned: false, score: 10, recentRank: 1 },
    ...overrides,
  };
}

const baseScope: HistoryCardDataScope = { type: 'zone', zoneId: 12 };

const sharedViewport: HistoryViewport = { fromMs: 1_000_000, toMs: 2_000_000 };

const baseRangeRequest = {
  label: 'custom' as const,
  from: new Date(sharedViewport.fromMs).toISOString(),
  to: new Date(sharedViewport.toMs).toISOString(),
  timezone: 'UTC',
};

function makeCards(count: number): HistoryCardSummary[] {
  return Array.from({ length: count }, (_, i) =>
    makeCard({
      cardId: `card-${i}`,
      title: `Card ${i}`,
      cardType: i % 2 === 0 ? 'soil' : 'environment',
    }),
  );
}

function renderGrid(cards: HistoryCardSummary[], viewport = sharedViewport) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <HistoryCompareGrid
        cards={cards}
        scope={baseScope}
        viewport={viewport}
        rangeRequest={baseRangeRequest}
      />
    </SWRConfig>,
  );
}

// ---------- tests ----------

describe('HistoryCompareGrid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a checklist containing all zone cards', () => {
    const cards = makeCards(4);
    renderGrid(cards);

    // Each card should appear as a labelled checkbox
    for (const card of cards) {
      expect(screen.getByRole('checkbox', { name: card.title })).toBeInTheDocument();
    }
  });

  it('selecting 2 cards renders exactly 2 compare panels', () => {
    const cards = makeCards(4);
    renderGrid(cards);

    // Default: first 2 are selected.  Confirm 2 panels exist.
    const panels = screen.getAllByTestId('compare-panel');
    expect(panels).toHaveLength(2);
  });

  it('toggling a third card on renders 3 compare panels', () => {
    const cards = makeCards(4);
    renderGrid(cards);

    // card-2 is not selected by default; select it
    const cb = screen.getByRole('checkbox', { name: 'Card 2' });
    fireEvent.click(cb);

    expect(screen.getAllByTestId('compare-panel')).toHaveLength(3);
  });

  it('all compare panels share the same viewport window', () => {
    const cards = makeCards(4);
    renderGrid(cards, sharedViewport);

    // Default 2 panels are shown; both must carry the shared fromMs/toMs
    const visualizations = screen.getAllByTestId('card-visualization');
    expect(visualizations.length).toBeGreaterThanOrEqual(2);

    for (const viz of visualizations) {
      expect(viz.getAttribute('data-from-ms')).toBe(String(sharedViewport.fromMs));
      expect(viz.getAttribute('data-to-ms')).toBe(String(sharedViewport.toMs));
    }
  });

  it('wraps each panel visualization in a flex height container', () => {
    const cards = makeCards(2);
    renderGrid(cards);
    const panels = screen.getAllByTestId('compare-panel');
    for (const panel of panels) {
      const wrapper = panel.querySelector('[data-testid="compare-panel-visualization"]');
      expect(wrapper).toHaveClass('min-h-0');
      expect(wrapper).toHaveClass('flex-1');
    }
  });

  it('disables the checkbox for unselected cards when 4 are already selected', () => {
    const cards = makeCards(5);
    renderGrid(cards);

    // Select cards 2 and 3 in addition to the default first 2 (cards 0 and 1)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Card 2' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Card 3' }));

    // Now 4 are selected; card 4 (unselected) must be disabled
    const disabledCb = screen.getByRole('checkbox', { name: 'Card 4' });
    expect(disabledCb).toBeDisabled();
  });

  it('selecting a 5th card does not add a 5th panel', () => {
    const cards = makeCards(6);
    renderGrid(cards);

    // Select up to 4
    fireEvent.click(screen.getByRole('checkbox', { name: 'Card 2' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Card 3' }));

    // Try to select a 5th — it should be disabled and stay at 4 panels
    const fifthCb = screen.getByRole('checkbox', { name: 'Card 4' });
    expect(fifthCb).toBeDisabled();
    // Attempting a click on a disabled input should have no effect
    fireEvent.click(fifthCb);

    expect(screen.getAllByTestId('compare-panel')).toHaveLength(4);
  });

  it('deselecting a card removes its panel', () => {
    const cards = makeCards(3);
    renderGrid(cards);

    // Default: cards 0 and 1 are selected. Deselect card 0.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Card 0' }));

    const panels = screen.getAllByTestId('compare-panel');
    expect(panels).toHaveLength(1);
    // Only card 1's visualization should remain
    expect(screen.queryByText('Visualization: card-0')).not.toBeInTheDocument();
    expect(screen.getByText('Visualization: card-1')).toBeInTheDocument();
  });
});
