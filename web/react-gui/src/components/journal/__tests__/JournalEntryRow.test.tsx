import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { EntryAggregate, EntryStatus } from '../../../types/journal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: 'en-GB', language: 'en-GB' },
  }),
}));

import { formatOccurredDate, JournalEntryRow } from '../JournalEntryRow';

const entry = {
  entry_uuid: 'e1',
  activity_code: 'irrigation',
  plot_uuid: 'p1',
  status: 'final',
  sync_version: 11,
  occurred_start: '2026-07-10T08:00:00.000Z',
  occurred_timezone: 'Europe/Zurich',
  values: [],
} as unknown as EntryAggregate;

describe('JournalEntryRow', () => {
  it('shows localized activity and status keys with a human plot label', () => {
    render(<JournalEntryRow entry={entry} plotLabel="North field" />);

    expect(screen.getByText('activity.irrigation')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('row.status.final');
    expect(screen.getByText(/North field/)).toBeInTheDocument();
    expect(screen.queryByText(/p1/)).not.toBeInTheDocument();
  });

  it('never exposes a raw plot UUID when its human label is unavailable', () => {
    render(<JournalEntryRow entry={entry} plotLabel={null} />);

    expect(screen.getByText(/row.unknownPlot/)).toBeInTheDocument();
    expect(screen.queryByText(/p1/)).not.toBeInTheDocument();
  });

  it('labels entries without a plot as farm-level', () => {
    render(<JournalEntryRow entry={{ ...entry, plot_uuid: null }} plotLabel={null} />);

    expect(screen.getByText(/row.farmLevel/)).toBeInTheDocument();
  });

  it.each([
    ['final', 'bg-[var(--success-bg)]', 'text-[var(--success-text)]'],
    ['draft', 'bg-[var(--warn-bg)]', 'text-[var(--warn-text)]'],
    ['voided', 'bg-red-100', 'text-red-800'],
  ] satisfies Array<[EntryStatus, string, string]>) (
    'renders %s with its status treatment',
    (status, backgroundClass, textClass) => {
      render(<JournalEntryRow entry={{ ...entry, status }} plotLabel="North field" />);

      expect(screen.getByRole('status'))
        .toHaveTextContent(`row.status.${status}`);
      expect(screen.getByRole('status')).toHaveClass(backgroundClass, textClass);
    },
  );

  it('formats the occurrence in its recorded timezone', () => {
    expect(formatOccurredDate(
      '2026-07-10T23:30:00.000Z',
      'Pacific/Auckland',
      'en-GB',
    )).toContain('11 Jul 2026');
  });

  it('falls back to the local timezone when the recorded timezone is invalid', () => {
    const value = '2026-07-10T12:00:00.000Z';
    const expected = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' })
      .format(new Date(value));

    expect(formatOccurredDate(value, 'Invalid/Timezone', 'en-GB')).toBe(expected);
  });
});
