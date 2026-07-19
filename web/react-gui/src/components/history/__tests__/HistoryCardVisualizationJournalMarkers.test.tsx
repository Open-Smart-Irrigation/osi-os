import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SWRConfig } from 'swr';

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
      if (!opts) return key;
      return `${key}[${Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(',')}]`;
    },
  }),
}));

import { HistoryCardVisualization } from '../HistoryCardVisualization';
import type { HistoryCardSummary } from '../../../history/types';
import type { HistoryVisualWindow } from '../../../history/useTimeViewport';

const FROM_MS = Date.parse('2026-07-01T00:00:00.000Z');
const TO_MS = Date.parse('2026-07-02T00:00:00.000Z');
const WINDOW: HistoryVisualWindow = { fromMs: FROM_MS, toMs: TO_MS };

function soilCard(overrides: Partial<HistoryCardSummary<'soil'>> = {}): HistoryCardSummary<'soil'> {
  return {
    cardId: 'soil-card:root-zone',
    cardType: 'soil',
    scope: 'zone',
    title: 'Soil Moisture',
    subtitle: '',
    defaultView: 'line-chart',
    views: ['line-chart', 'soil-profile', 'calendar'],
    supportedRanges: ['24h'],
    defaultRange: '24h',
    metadata: { coveragePct: null, coverageConfidence: 'unknown' },
    availability: { available: true, reasons: [] },
    ordering: { pinned: false, score: 0, recentRank: null },
    ...overrides,
  };
}

function renderVisualization(props: Partial<React.ComponentProps<typeof HistoryCardVisualization>> = {}) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <HistoryCardVisualization
        card={soilCard()}
        data={undefined}
        selectedView="line-chart"
        window={WINDOW}
        {...props}
      />
    </SWRConfig>,
  );
}

describe('HistoryCardVisualization journal marker integration', () => {
  beforeEach(() => listEntries.mockReset());

  it('does not request journal entries when the card has no zone UUID', () => {
    renderVisualization({ card: soilCard() });

    expect(listEntries).not.toHaveBeenCalled();
    expect(screen.queryByTestId('journal-marker-lane')).not.toBeInTheDocument();
  });

  it('fetches and renders markers through the single data-layer hook when a zone UUID is present', async () => {
    listEntries.mockResolvedValue({
      entries: [
        {
          entry_uuid: 'e1',
          activity_code: 'irrigation',
          occurred_start: '2026-07-01T06:00:00.000Z',
          occurred_end: null,
          plot_uuid: 'plot-1',
          zone_uuid: 'zone-abc',
          note: null,
          status: 'final',
        },
      ],
      next_cursor: null,
    });

    renderVisualization({ card: soilCard({ metadata: { coveragePct: null, coverageConfidence: 'unknown', zoneUuid: 'zone-abc' } }) });

    const lane = await screen.findByTestId('journal-marker-lane');
    expect(lane).toBeInTheDocument();
    expect(listEntries).toHaveBeenCalledWith(
      expect.objectContaining({ zone_uuid: 'zone-abc', status: 'final' }),
    );
  });

  it('does not request journal entries for a non-time-axis view (soil profile) even with a zone UUID', () => {
    renderVisualization({
      card: soilCard({ metadata: { coveragePct: null, coverageConfidence: 'unknown', zoneUuid: 'zone-abc' } }),
      selectedView: 'soil-profile',
      data: {
        cardId: 'soil-card:root-zone',
        cardType: 'soil',
        view: 'soil-profile',
        range: { label: '24h', from: null, to: null, timezone: 'UTC' },
        aggregation: { level: 'raw', bucketSizeSeconds: null, coveragePct: null, coverageConfidence: 'unknown', pointCount: 0 },
        limits: { maxPointsPerSeries: 1000, maxEvents: 100, maxInterpretations: 20, truncated: false },
        series: [],
        profiles: [],
        events: [],
        calendar: null,
        interpretations: [],
        freshness: { dataAsOf: null, syncState: 'local' },
        advancedFields: {},
      },
    });

    expect(listEntries).not.toHaveBeenCalled();
    expect(screen.queryByTestId('journal-marker-lane')).not.toBeInTheDocument();
  });

  it('does not request journal entries when no visual window is available', () => {
    renderVisualization({
      card: soilCard({ metadata: { coveragePct: null, coverageConfidence: 'unknown', zoneUuid: 'zone-abc' } }),
      window: undefined,
    });

    expect(listEntries).not.toHaveBeenCalled();
  });

  it('the chart view itself never calls the journal API — only the shared hook does', async () => {
    listEntries.mockResolvedValue({ entries: [], next_cursor: null });

    renderVisualization({ card: soilCard({ metadata: { coveragePct: null, coverageConfidence: 'unknown', zoneUuid: 'zone-abc' } }) });

    await screen.findByTestId('journal-marker-lane');
    // Exactly one request path: one call for the one mounted lane, regardless
    // of how many chart sub-components exist in the render tree.
    expect(listEntries).toHaveBeenCalledTimes(1);
  });
});
