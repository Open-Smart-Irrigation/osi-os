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

function vocabRow(code: string, labelEn: string) {
  return {
    code,
    kind: 'activity' as const,
    parent_code: null,
    value_type: null,
    quantity_kind: null,
    basis: null,
    default_unit_code: null,
    icon_key: null,
    scope: 'core' as const,
    owner_user_uuid: null,
    gateway_device_eui: null,
    custom_field_uuid: null,
    active: 1,
    sort_order: 0,
    sync_version: 0,
    created_at: '2026-07-16T00:00:00.000Z',
    deleted_at: null,
    catalog_errors: [],
    labels: { en: labelEn },
    constraints: null,
  };
}

describe('JournalEntryRow', () => {
  // P1 fix (live UX pass): without a catalog model this falls back to the
  // raw activity code — the client-side journal.json activity.* map only
  // ever covered 6 of the 16 shipped codes, so this row no longer reads
  // through it at all (see vocabLabelOrCode in journal/catalogModel.ts).
  it('falls back to the raw activity code with no catalog model', () => {
    render(<JournalEntryRow entry={entry} plotLabel="North field" />);

    expect(screen.getByText('irrigation')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('row.status.final');
    expect(screen.getByText(/North field/)).toBeInTheDocument();
    expect(screen.queryByText(/p1/)).not.toBeInTheDocument();
  });

  // P1 fix: an activity code outside the 6-key journal.json activity.* map
  // (e.g. plant_protection_application) must show its catalog label, not the
  // raw snake_case code — this is the mobile counterpart to
  // DetailPanel.test.tsx's "shows the catalog-provided activity label" test.
  it('shows the catalog label for an activity outside the 6-key i18n map when a model is supplied', () => {
    const model = {
      vocabByCode: new Map([['plant_protection_application', vocabRow('plant_protection_application', 'Plant protection')]]),
      templates: new Map(),
      layouts: new Map(),
    };

    render(
      <JournalEntryRow
        entry={{ ...entry, activity_code: 'plant_protection_application' }}
        plotLabel="North field"
        model={model}
      />,
    );

    expect(screen.getByText('Plant protection')).toBeInTheDocument();
    expect(screen.queryByText('plant_protection_application')).not.toBeInTheDocument();
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
