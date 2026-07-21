import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntryListFilters, JournalPlot } from '../../../../types/journal';

// P1-c: a live re-test found that clicking Export JSON / Export research
// package produced no network request at all, while Export CSV worked.
// EntryTable.test.tsx mocks the whole `journalApi` module, so it only proves
// EntryTable calls `journalApi.exportEntriesX` — it never exercises
// journalApi's own `downloadJournalExport` -> `api.get` call.
// journalApi.test.ts exercises that, but calls `journalApi.exportEntriesX`
// directly, bypassing the button entirely. Neither test's mock boundary
// covers the actual button-click -> request path, so both stayed green
// while the live behavior failed. This file mocks only the transport
// (`services/api`'s `api.get`) and renders the real EntryTable with the
// real journalApi, so a click has to travel the full
// EXPORT_METHOD -> journalApi.exportEntriesX -> downloadJournalExport ->
// api.get chain to pass.
const { get } = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: 'en-GB', language: 'en-GB' },
  }),
}));

vi.mock('../../../../journal/useJournalEntries', () => ({
  useJournalEntries: () => ({
    entries: [],
    loading: false,
    error: undefined,
    retry: vi.fn(),
    nextCursor: null,
  }),
}));

vi.mock('../../../../services/api', () => ({ api: { get } }));

import { EntryTable } from '../EntryTable';

const FILTERS: EntryListFilters = { status: 'final' };

beforeEach(() => {
  get.mockReset().mockResolvedValue({ data: 'x' });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:x') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

describe('EntryTable real wiring (real journalApi, mocked transport only)', () => {
  it.each([
    ['workspace.table.exportCsv', '/api/journal/export.csv'],
    ['workspace.table.exportJson', '/api/journal/export.json'],
    ['workspace.table.exportPackage', '/api/journal/export.package'],
  ])('clicking %s actually issues a GET to %s and shows the success status', async (buttonName, expectedPath) => {
    render(
      <EntryTable
        filters={FILTERS}
        plots={[] as JournalPlot[]}
        selectedEntryUuid={null}
        onSelectEntry={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: buttonName }));

    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(get).toHaveBeenCalledWith(expectedPath, expect.objectContaining({ params: FILTERS }));
    await waitFor(() => expect(screen.getByText('workspace.table.exportSuccess')).toBeInTheDocument());
  });

  it.each([
    ['workspace.table.exportCsv'],
    ['workspace.table.exportJson'],
    ['workspace.table.exportPackage'],
  ])('surfaces a real transport failure for %s instead of staying silent', async (buttonName) => {
    get.mockReset().mockRejectedValue(new Error('network down'));
    render(
      <EntryTable
        filters={FILTERS}
        plots={[] as JournalPlot[]}
        selectedEntryUuid={null}
        onSelectEntry={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: buttonName }));

    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('workspace.table.exportError'));
  });
});
