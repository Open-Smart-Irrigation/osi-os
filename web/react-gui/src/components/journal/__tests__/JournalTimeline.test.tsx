import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { EntryAggregate, JournalPlot } from '../../../types/journal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: 'en-GB', language: 'en-GB' },
  }),
}));

import { JournalTimeline } from '../JournalTimeline';

describe('JournalTimeline', () => {
  it('shows the loading state while entries are pending', () => {
    render(<JournalTimeline entries={[]} plots={[]} loading />);

    expect(screen.getByText('timeline.loading')).toBeInTheDocument();
  });

  it('shows the empty state when there are no entries', () => {
    render(<JournalTimeline entries={[]} plots={[]} loading={false} />);

    expect(screen.getByText('timeline.empty')).toBeInTheDocument();
  });

  it('renders a row per entry with human plot labels', () => {
    const entries = [
      {
        entry_uuid: 'e1',
        activity_code: 'irrigation',
        plot_uuid: 'p1',
        status: 'final',
        occurred_start: '2026-07-10T08:00:00.000Z',
        occurred_timezone: 'Europe/Zurich',
        values: [],
      },
      {
        entry_uuid: 'e2',
        activity_code: 'harvest',
        plot_uuid: null,
        status: 'final',
        occurred_start: '2026-07-09T08:00:00.000Z',
        occurred_timezone: 'Europe/Zurich',
        values: [],
      },
    ] as unknown as EntryAggregate[];
    const plots = [
      { plot_uuid: 'p1', plot_code: 'N-1', name: 'North field' },
    ] as unknown as JournalPlot[];

    render(<JournalTimeline entries={entries} plots={plots} loading={false} />);

    const rows = screen.getAllByText(/^activity\./);
    expect(rows.map((row) => row.textContent)).toEqual([
      'activity.irrigation',
      'activity.harvest',
    ]);
    expect(screen.getByText(/North field/)).toBeInTheDocument();
    expect(screen.queryByText(/p1/)).not.toBeInTheDocument();
  });
});
