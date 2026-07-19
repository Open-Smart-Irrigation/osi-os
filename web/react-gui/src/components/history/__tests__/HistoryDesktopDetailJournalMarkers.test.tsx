import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SWRConfig } from 'swr';

// Unlike HistoryDesktopDetail.test.tsx, this file deliberately does NOT mock
// HistoryCardVisualization — it proves the marker lane is really wired
// end-to-end through both integration points named in the task brief:
// HistoryCardVisualization (renders the lane) and HistoryDesktopDetail (the
// desktop host that mounts it, unmodified, because the zone UUID already
// flows through `selectedCard.metadata.zoneUuid`).

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const { listEntries } = vi.hoisted(() => ({ listEntries: vi.fn() }));

vi.mock('../../../services/journalApi', () => ({
  journalApi: { listEntries: (filters: any) => listEntries(filters) },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts?.defaultValue) return opts.defaultValue as string;
      return key;
    },
  }),
}));

vi.mock('../../../history/useHistoryCardData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../history/useHistoryCardData')>();
  return {
    ...actual,
    useHistoryCardData: vi.fn(() => ({ data: undefined, error: null, isLoading: false, refresh: vi.fn() })),
  };
});

vi.mock('../../../history/useHistoryCardAdvancedData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../history/useHistoryCardAdvancedData')>();
  return {
    ...actual,
    useHistoryCardAdvancedData: vi.fn(() => ({ data: undefined, error: null, isLoading: false, refresh: vi.fn() })),
  };
});

import { HistoryDesktopDetail } from '../desktop/HistoryDesktopDetail';
import type { HistoryCardSummary } from '../../../history/types';
import type { HistoryCardDataScope } from '../../../history/useHistoryCardData';

function makeCard(overrides: Partial<HistoryCardSummary> = {}): HistoryCardSummary {
  return {
    cardId: 'soil-card:root-zone',
    cardType: 'soil',
    scope: 'zone',
    title: 'Soil Moisture',
    subtitle: 'North Block',
    defaultView: 'line-chart',
    views: ['line-chart', 'soil-profile'],
    supportedRanges: ['24h'],
    defaultRange: '24h',
    metadata: { coveragePct: 96, coverageConfidence: 'configured' },
    availability: { available: true, reasons: [] },
    ordering: { pinned: false, score: 10, recentRank: 1 },
    ...overrides,
  };
}

const scope: HistoryCardDataScope = { type: 'zone', zoneId: 12 };

function renderDesktopDetail(card: HistoryCardSummary) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <HistoryDesktopDetail
        cards={[card]}
        selectedCard={card}
        zoneName="North Block"
        scope={scope}
        onCardSelect={vi.fn()}
      />
    </SWRConfig>,
  );
}

describe('HistoryDesktopDetail journal marker integration', () => {
  beforeEach(() => listEntries.mockReset());

  it('does not mount the journal marker lane when the card carries no zone UUID', () => {
    renderDesktopDetail(makeCard());

    expect(listEntries).not.toHaveBeenCalled();
    expect(screen.queryByTestId('journal-marker-lane')).not.toBeInTheDocument();
  });

  it('mounts the journal marker lane inside the desktop chart surface when a zone UUID is present', async () => {
    listEntries.mockResolvedValue({ entries: [], next_cursor: null });

    const card = makeCard({ metadata: { coveragePct: 96, coverageConfidence: 'configured', zoneUuid: 'zone-xyz' } });
    renderDesktopDetail(card);

    const surface = screen.getByTestId('desktop-chart-surface');
    const lane = await screen.findByTestId('journal-marker-lane');
    expect(surface).toContainElement(lane);
    expect(listEntries).toHaveBeenCalledWith(expect.objectContaining({ zone_uuid: 'zone-xyz' }));
  });
});
