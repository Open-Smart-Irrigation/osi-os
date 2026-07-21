import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { SWRConfig } from 'swr';

import { HistoryDesktopDetail } from '../desktop/HistoryDesktopDetail';
import type { HistoryCardSummary } from '../../../history/types';
import { useHistoryCardData } from '../../../history/useHistoryCardData';
import type { HistoryCardDataScope } from '../../../history/useHistoryCardData';

// Mock the translation hook
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        'history.viewMode.soil-profile': 'Soil Profile',
        'history.viewMode.line-chart': 'Line Chart',
        'history.viewMode.calendar': 'Calendar',
        'history.viewMode.irrigation-response': 'Irrigation Response',
        'history.viewMode.advanced': 'Advanced view',
        'history.viewMode.daily-min-max': 'Daily Min/Max',
        'history.viewMode.growth-timeline': 'Growth timeline',
      };
      if (labels[key]) return labels[key];
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

vi.mock('../../../history/useHistoryCardAdvancedData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../history/useHistoryCardAdvancedData')>();
  return {
    ...actual,
    useHistoryCardAdvancedData: vi.fn(() => ({
      data: { cardId: 'soil-card:root-zone', cardType: 'soil', advancedFields: {} },
      error: null,
      isLoading: false,
      refresh: vi.fn(),
    })),
  };
});

// HistoryCardVisualization makes Recharts calls that don't work in jsdom; stub lightly
vi.mock('../HistoryCardVisualization', () => ({
  HistoryCardVisualization: ({ card, selectedView }: { card: HistoryCardSummary; selectedView: string }) =>
    React.createElement(
      'div',
      {
        'data-testid': 'card-visualization',
        'data-card-id': card.cardId,
        'data-selected-view': selectedView,
      },
      `Visualization: ${card.cardId}:${selectedView}`,
    ),
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

function lastHistoryCardDataRequest() {
  const calls = vi.mocked(useHistoryCardData).mock.calls;
  return calls[calls.length - 1]?.[0];
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

  it('provides a flex height contract for Recharts visualizations', () => {
    const card = makeCard();
    renderDesktopDetail([card], card);
    const surface = screen.getByTestId('desktop-chart-surface');
    expect(surface).toHaveClass('flex');
    expect(surface).toHaveClass('flex-col');
    expect(surface.firstElementChild).toHaveClass('min-h-0');
    expect(surface.firstElementChild).toHaveClass('flex-1');
    expect(surface.firstElementChild).toHaveClass('flex');
    expect(surface.firstElementChild).toHaveClass('flex-col');
  });

  it('renders card-specific view buttons for the selected Soil card', () => {
    const card = makeCard({
      views: ['soil-profile', 'line-chart', 'calendar', 'irrigation-response', 'advanced'],
    });
    renderDesktopDetail([card], card);

    expect(screen.getByRole('button', { name: 'Soil Profile' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Line Chart' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Calendar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Irrigation Response' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Advanced view' })).toBeInTheDocument();
  });

  it('switches the selected view without changing card route state', () => {
    const card = makeCard({
      views: ['soil-profile', 'line-chart', 'calendar', 'irrigation-response', 'advanced'],
    });
    renderDesktopDetail([card], card);

    fireEvent.click(screen.getByRole('button', { name: 'Line Chart' }));

    expect(screen.getByTestId('card-visualization')).toHaveAttribute('data-selected-view', 'line-chart');
    expect(screen.getByRole('button', { name: 'Line Chart' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('resets the selected view when the selected card changes', () => {
    const soil = makeCard({
      cardId: 'soil',
      defaultView: 'soil-profile',
      views: ['soil-profile', 'line-chart', 'calendar'],
    });
    const env = makeCard({
      cardId: 'env',
      cardType: 'environment',
      title: 'Environment - Microclimate',
      defaultView: 'line-chart',
      views: ['line-chart', 'daily-min-max', 'calendar', 'advanced'],
    });
    const onCardSelect = vi.fn();
    const { rerender } = render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <HistoryDesktopDetail cards={[soil, env]} selectedCard={soil} zoneName="Zone A" scope={baseScope} onCardSelect={onCardSelect} />
      </SWRConfig>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    expect(screen.getByTestId('card-visualization')).toHaveAttribute('data-selected-view', 'calendar');

    rerender(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <HistoryDesktopDetail cards={[soil, env]} selectedCard={env} zoneName="Zone A" scope={baseScope} onCardSelect={onCardSelect} />
      </SWRConfig>,
    );

    expect(screen.getByTestId('card-visualization')).toHaveAttribute('data-selected-view', 'line-chart');
    expect(screen.getByRole('button', { name: 'Daily Min/Max' })).toBeInTheDocument();
  });

  it('does not request the previous card view while switching cards', () => {
    const dendro = makeCard({
      cardId: 'dendro',
      cardType: 'dendro',
      title: 'Dendro - Growth Timeline',
      defaultView: 'growth-timeline',
      views: ['growth-timeline', 'line-chart', 'stress-events', 'calendar', 'advanced'],
    });
    const env = makeCard({
      cardId: 'env',
      cardType: 'environment',
      title: 'Environment - Microclimate',
      defaultView: 'line-chart',
      views: ['line-chart', 'daily-min-max', 'calendar', 'advanced'],
    });
    const onCardSelect = vi.fn();
    const { rerender } = render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <HistoryDesktopDetail cards={[dendro, env]} selectedCard={dendro} zoneName="Zone A" scope={baseScope} onCardSelect={onCardSelect} />
      </SWRConfig>,
    );

    rerender(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <HistoryDesktopDetail cards={[dendro, env]} selectedCard={env} zoneName="Zone A" scope={baseScope} onCardSelect={onCardSelect} />
      </SWRConfig>,
    );

    const envRequests = vi.mocked(useHistoryCardData).mock.calls
      .map((call) => call[0])
      .filter((request) => request.cardId === 'env');
    expect(envRequests).not.toContainEqual(expect.objectContaining({ view: 'growth-timeline' }));
    expect(envRequests[envRequests.length - 1]).toEqual(expect.objectContaining({ view: 'line-chart' }));
  });

  it('uses Advanced View when the card-specific Advanced button is selected', () => {
    const card = makeCard({
      views: ['soil-profile', 'line-chart', 'calendar', 'irrigation-response', 'advanced'],
    });
    renderDesktopDetail([card], card);

    fireEvent.click(screen.getByRole('button', { name: 'Advanced view' }));

    expect(screen.getByTestId('card-visualization')).toHaveAttribute('data-selected-view', 'advanced');
  });

  it('requests daily aggregation when Daily Min/Max is selected', () => {
    const card = makeCard({
      cardType: 'environment',
      title: 'Environment - Microclimate',
      defaultView: 'line-chart',
      views: ['line-chart', 'daily-min-max', 'calendar', 'advanced'],
    });
    renderDesktopDetail([card], card);

    fireEvent.click(screen.getByRole('button', { name: 'Daily Min/Max' }));

    expect(screen.getByTestId('card-visualization')).toHaveAttribute('data-selected-view', 'daily-min-max');
    expect(lastHistoryCardDataRequest()).toEqual(
      expect.objectContaining({ view: 'daily-min-max', aggregation: 'daily' }),
    );
  });

  it('renders All plus display-safe source buttons for a merged Soil card', () => {
    const card = makeCard({
      sourceDeviceCount: 2,
      sourceLabels: ['Chameleon 1', 'Chameleon 2'],
      sourceDevices: [
        { name: 'Chameleon 1', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'soil-src-one' },
        { name: 'Chameleon 2', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'soil-src-two' },
      ],
    });
    renderDesktopDetail([card], card);

    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Chameleon 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chameleon 2' })).toBeInTheDocument();
  });

  it('passes the selected source key into desktop card data requests', () => {
    const card = makeCard({
      sourceDeviceCount: 2,
      sourceLabels: ['Chameleon 1', 'Chameleon 2'],
      sourceDevices: [
        { name: 'Chameleon 1', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'soil-src-one' },
        { name: 'Chameleon 2', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'soil-src-two' },
      ],
    });
    renderDesktopDetail([card], card);

    fireEvent.click(screen.getByRole('button', { name: 'Chameleon 2' }));

    const lastCall = lastHistoryCardDataRequest();
    expect(lastCall).toEqual(expect.objectContaining({ sourceKey: 'soil-src-two' }));
    expect(screen.getByRole('button', { name: 'Chameleon 2' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('resets the selected source to All when the selected card changes', () => {
    const soil = makeCard({
      cardId: 'soil',
      sourceDeviceCount: 2,
      sourceLabels: ['Chameleon 1', 'Chameleon 2'],
      sourceDevices: [
        { name: 'Chameleon 1', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'soil-src-one' },
        { name: 'Chameleon 2', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'soil-src-two' },
      ],
    });
    const env = makeCard({
      cardId: 'env',
      cardType: 'environment',
      title: 'Environment - Microclimate',
      defaultView: 'line-chart',
      views: ['line-chart', 'daily-min-max', 'calendar', 'advanced'],
      sourceDeviceCount: 1,
      sourceLabels: ['Weather station'],
      sourceDevices: [
        { name: 'Weather station', typeId: 'SENSECAP_S2120', role: 'environment', sourceKey: 'env-src-one' },
      ],
    });
    const onCardSelect = vi.fn();
    const { rerender } = render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <HistoryDesktopDetail cards={[soil, env]} selectedCard={soil} zoneName="Zone A" scope={baseScope} onCardSelect={onCardSelect} />
      </SWRConfig>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Chameleon 2' }));
    expect(lastHistoryCardDataRequest()).toEqual(expect.objectContaining({ sourceKey: 'soil-src-two' }));

    rerender(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <HistoryDesktopDetail cards={[soil, env]} selectedCard={env} zoneName="Zone A" scope={baseScope} onCardSelect={onCardSelect} />
      </SWRConfig>,
    );

    expect(screen.queryByRole('button', { name: 'Chameleon 2' })).not.toBeInTheDocument();
    expect(lastHistoryCardDataRequest()).toEqual(expect.objectContaining({ sourceKey: null }));
  });

  it('uses each selected compare card own data scope', () => {
    const soil = makeCard({
      cardId: 'soil',
      cardType: 'soil',
      scope: 'zone',
      title: 'Soil Moisture',
      defaultView: 'line-chart',
      views: ['line-chart'],
    });
    const gateway = makeCard({
      cardId: '0016C001F11766E7:gateway:hub',
      cardType: 'gateway',
      scope: 'gateway',
      title: 'Gateway',
      defaultView: 'status-overview',
      views: ['status-overview'],
      metadata: {
        coverageConfidence: 'unknown',
        gatewayDeviceEui: '0016C001F11766E7',
      },
    });
    renderDesktopDetail([soil, gateway], soil, 'Zone A', { type: 'zone', zoneId: 12 });

    fireEvent.click(screen.getByTestId('mode-compare'));

    const compareRequests = vi.mocked(useHistoryCardData).mock.calls
      .map((call) => call[0])
      .filter((request) => request.cardId === soil.cardId || request.cardId === gateway.cardId);

    expect(compareRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ cardId: soil.cardId, scope: { type: 'zone', zoneId: 12 } }),
      expect.objectContaining({ cardId: gateway.cardId, scope: { type: 'gateway', gatewayEui: '0016C001F11766E7' } }),
    ]));
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
