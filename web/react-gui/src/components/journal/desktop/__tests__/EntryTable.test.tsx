import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntryAggregate, EntryListFilters, JournalPlot } from '../../../../types/journal';

const mocks = vi.hoisted(() => ({
  useJournalEntries: vi.fn(),
  exportEntriesCsv: vi.fn(),
  exportEntriesJson: vi.fn(),
  exportEntriesResearchPackage: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: 'en-GB', language: 'en-GB' },
  }),
}));

vi.mock('../../../../journal/useJournalEntries', () => ({
  useJournalEntries: mocks.useJournalEntries,
}));

vi.mock('../../../../services/journalApi', () => ({
  journalApi: {
    exportEntriesCsv: mocks.exportEntriesCsv,
    exportEntriesJson: mocks.exportEntriesJson,
    exportEntriesResearchPackage: mocks.exportEntriesResearchPackage,
  },
}));

import { EntryTable } from '../EntryTable';

function plot(overrides: Partial<JournalPlot> = {}): JournalPlot {
  return {
    contract_version: 1,
    plot_uuid: 'plot-1',
    plot_code: 'N-1',
    name: 'North field',
    zone_uuid: null,
    station_code: null,
    crop_hint: null,
    area_m2: null,
    active: 1,
    sync_version: 0,
    owner_user_uuid: 'owner',
    gateway_device_eui: 'gateway',
    created_at: '2026-07-16T00:00:00.000Z',
    updated_at: '2026-07-16T00:00:00.000Z',
    deleted_at: null,
    settings: {
      layout_code: 'open_field',
      updated_at: '2026-07-16T00:00:00.000Z',
      updated_by_principal_uuid: 'author',
      sync_version: 0,
    },
    ...overrides,
  };
}

function entry(overrides: Partial<EntryAggregate> = {}): EntryAggregate {
  return {
    contract_version: 1,
    entry_uuid: 'e1',
    owner_user_uuid: 'owner',
    author_principal_uuid: 'author',
    author_label: null,
    gateway_device_eui: 'gateway',
    plot_uuid: 'plot-1',
    zone_uuid: null,
    device_eui: null,
    season_uuid: null,
    season_crop: null,
    season_variety: null,
    campaign_uuid: null,
    protocol_code: null,
    protocol_version: null,
    observation_unit_code: null,
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    catalog_version: 1,
    occurred_start: '2026-07-16T08:00:00.000Z',
    occurred_end: null,
    occurred_timezone: 'Europe/Zurich',
    occurred_utc_offset_minutes: 120,
    origin: 'edge-ui',
    status: 'final',
    batch_uuid: null,
    pass_uuid: null,
    voided_at: null,
    voided_by_principal_uuid: null,
    void_reason: null,
    note: null,
    context_json: null,
    sync_version: 1,
    recorded_at: '2026-07-16T08:00:05.000Z',
    created_at: '2026-07-16T08:00:05.000Z',
    updated_at: '2026-07-16T08:00:05.000Z',
    deleted_at: null,
    values: [],
    ...overrides,
  };
}

const FILTERS: EntryListFilters = { status: 'final' };

function mockEntries(overrides: {
  entries?: EntryAggregate[];
  loading?: boolean;
  error?: unknown;
  retry?: () => void;
  nextCursor?: string | null;
} = {}) {
  mocks.useJournalEntries.mockReturnValue({
    entries: overrides.entries ?? [],
    loading: overrides.loading ?? false,
    error: overrides.error,
    retry: overrides.retry ?? vi.fn(),
    nextCursor: overrides.nextCursor ?? null,
  });
}

function renderTable(overrides: {
  filters?: EntryListFilters;
  plots?: JournalPlot[];
  selectedEntryUuid?: string | null;
  onSelectEntry?: (uuid: string) => void;
} = {}) {
  const onSelectEntry = overrides.onSelectEntry ?? vi.fn();
  const utils = render(
    <EntryTable
      filters={overrides.filters ?? FILTERS}
      plots={overrides.plots ?? [plot()]}
      selectedEntryUuid={overrides.selectedEntryUuid ?? null}
      onSelectEntry={onSelectEntry}
    />,
  );
  return { ...utils, onSelectEntry };
}

function rows() {
  return screen.getAllByTestId(/^entry-row-/);
}

function lastQueryFilters(): EntryListFilters {
  const calls = mocks.useJournalEntries.mock.calls;
  return calls[calls.length - 1]?.[0];
}

beforeEach(() => {
  mocks.useJournalEntries.mockReset();
  mocks.exportEntriesCsv.mockReset().mockResolvedValue(undefined);
  mocks.exportEntriesJson.mockReset().mockResolvedValue(undefined);
  mocks.exportEntriesResearchPackage.mockReset().mockResolvedValue(undefined);
  mockEntries();
});

describe('EntryTable', () => {
  it('renders one dense row per entry with occurred, activity, plot, and status cells', () => {
    mockEntries({
      entries: [entry({ entry_uuid: 'e1', plot_uuid: 'plot-1', activity_code: 'irrigation', status: 'final' })],
    });

    renderTable({ plots: [plot({ plot_uuid: 'plot-1', name: 'North field' })] });

    const row = screen.getByTestId('entry-row-e1');
    expect(within(row).getByText('activity.irrigation')).toBeInTheDocument();
    expect(within(row).getByText(/North field/)).toBeInTheDocument();
    expect(within(row).getByText('row.status.final')).toBeInTheDocument();
  });

  it('labels a farm-level entry (no plot) distinctly from a plot with an unresolved label', () => {
    mockEntries({
      entries: [
        entry({ entry_uuid: 'e-farm', plot_uuid: null }),
        entry({ entry_uuid: 'e-unknown', plot_uuid: 'plot-missing' }),
      ],
    });

    renderTable({ plots: [] });

    expect(within(screen.getByTestId('entry-row-e-farm')).getByText('row.farmLevel')).toBeInTheDocument();
    expect(within(screen.getByTestId('entry-row-e-unknown')).getByText('row.unknownPlot')).toBeInTheDocument();
  });

  it('shows a loading state before the first page of entries arrives', () => {
    mockEntries({ loading: true, entries: [] });

    renderTable();

    expect(screen.getByRole('status')).toHaveTextContent('workspace.table.loading');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows a retryable error state distinct from an empty result', () => {
    const retry = vi.fn();
    mockEntries({ error: new Error('offline'), entries: [], retry });

    renderTable();

    expect(screen.getByRole('alert')).toHaveTextContent('workspace.table.error');
    fireEvent.click(screen.getByRole('button', { name: 'workspace.table.retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when no entries match the filters', () => {
    mockEntries({ entries: [], loading: false, error: undefined });

    renderTable();

    expect(screen.getByText('workspace.table.empty')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('selects a row on click', () => {
    mockEntries({ entries: [entry({ entry_uuid: 'e1' }), entry({ entry_uuid: 'e2' })] });
    const { onSelectEntry } = renderTable();

    fireEvent.click(screen.getByTestId('entry-row-e1'));

    expect(onSelectEntry).toHaveBeenCalledWith('e1');
  });

  it('sorts rows by the activity column when its header is activated, and flips direction on a second activation', () => {
    mockEntries({
      entries: [
        entry({ entry_uuid: 'e-new', occurred_start: '2026-07-16T08:00:00.000Z', activity_code: 'irrigation' }),
        entry({ entry_uuid: 'e-old', occurred_start: '2026-07-10T08:00:00.000Z', activity_code: 'harvest' }),
      ],
    });
    renderTable();

    // Default: occurred_start descending (server order) -> newest first.
    expect(rows().map((row) => row.dataset.testid)).toEqual(['entry-row-e-new', 'entry-row-e-old']);

    fireEvent.click(screen.getByRole('button', { name: /workspace\.table\.column\.activity/ }));
    expect(rows().map((row) => row.dataset.testid)).toEqual(['entry-row-e-old', 'entry-row-e-new']);

    fireEvent.click(screen.getByRole('button', { name: /workspace\.table\.column\.activity/ }));
    expect(rows().map((row) => row.dataset.testid)).toEqual(['entry-row-e-new', 'entry-row-e-old']);
  });

  it('moves the selection down/up with Arrow keys, clamped at the last/first row', () => {
    mockEntries({
      entries: [
        entry({ entry_uuid: 'e1', occurred_start: '2026-07-16T08:00:00.000Z' }),
        entry({ entry_uuid: 'e2', occurred_start: '2026-07-15T08:00:00.000Z' }),
      ],
    });
    const onSelectEntry = vi.fn();
    renderTable({ selectedEntryUuid: 'e1', onSelectEntry });

    fireEvent.keyDown(screen.getByTestId('entry-row-e1'), { key: 'ArrowDown' });
    expect(onSelectEntry).toHaveBeenLastCalledWith('e2');

    onSelectEntry.mockClear();
    fireEvent.keyDown(screen.getByTestId('entry-row-e2'), { key: 'ArrowDown' });
    expect(onSelectEntry).not.toHaveBeenCalled(); // already at the last row

    fireEvent.keyDown(screen.getByTestId('entry-row-e2'), { key: 'ArrowUp' });
    expect(onSelectEntry).toHaveBeenLastCalledWith('e1');
  });

  it('jumps to the first/last row with Home/End', () => {
    mockEntries({
      entries: [
        entry({ entry_uuid: 'e1', occurred_start: '2026-07-16T08:00:00.000Z' }),
        entry({ entry_uuid: 'e2', occurred_start: '2026-07-15T08:00:00.000Z' }),
        entry({ entry_uuid: 'e3', occurred_start: '2026-07-14T08:00:00.000Z' }),
      ],
    });
    const onSelectEntry = vi.fn();
    renderTable({ selectedEntryUuid: 'e2', onSelectEntry });

    fireEvent.keyDown(screen.getByTestId('entry-row-e2'), { key: 'End' });
    expect(onSelectEntry).toHaveBeenLastCalledWith('e3');

    fireEvent.keyDown(screen.getByTestId('entry-row-e2'), { key: 'Home' });
    expect(onSelectEntry).toHaveBeenLastCalledWith('e1');
  });

  it('moves DOM focus to the row Arrow/Home/End navigation targets', () => {
    mockEntries({
      entries: [entry({ entry_uuid: 'e1' }), entry({ entry_uuid: 'e2' })],
    });
    renderTable({ selectedEntryUuid: 'e1' });

    fireEvent.keyDown(screen.getByTestId('entry-row-e1'), { key: 'ArrowDown' });

    expect(document.activeElement).toBe(screen.getByTestId('entry-row-e2'));
  });

  it('selects the focused first row on the first Arrow press when nothing is selected yet', () => {
    mockEntries({
      entries: [entry({ entry_uuid: 'e1' }), entry({ entry_uuid: 'e2' })],
    });
    const onSelectEntry = vi.fn();
    renderTable({ selectedEntryUuid: null, onSelectEntry });

    fireEvent.keyDown(screen.getByTestId('entry-row-e1'), { key: 'ArrowDown' });

    expect(onSelectEntry).toHaveBeenCalledWith('e1');
  });

  it('requests the first page without a cursor, then a subsequent page with the returned cursor', () => {
    mockEntries({ entries: [entry({ entry_uuid: 'e1' })], nextCursor: 'cursor-2' });
    renderTable({ filters: FILTERS });

    expect(mocks.useJournalEntries).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'final' }),
      true,
    );
    expect(lastQueryFilters()).not.toHaveProperty('cursor');

    fireEvent.click(screen.getByRole('button', { name: 'workspace.table.nextPage' }));

    expect(mocks.useJournalEntries).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'final', cursor: 'cursor-2' }),
      true,
    );
  });

  it('disables Previous on the first page and Next when there is no further cursor', () => {
    mockEntries({ entries: [entry()], nextCursor: null });
    renderTable();

    expect(screen.getByRole('button', { name: 'workspace.table.previousPage' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'workspace.table.nextPage' })).toBeDisabled();
  });

  it('is defensive: changing filters resets pagination instead of sending a cursor from the old filter set', () => {
    mockEntries({ entries: [entry({ entry_uuid: 'e1' })], nextCursor: 'cursor-2' });
    const { rerender } = renderTable({ filters: { status: 'final' } });

    fireEvent.click(screen.getByRole('button', { name: 'workspace.table.nextPage' }));
    expect(lastQueryFilters()).toMatchObject({ cursor: 'cursor-2' });

    mockEntries({ entries: [entry({ entry_uuid: 'e2' })], nextCursor: null });
    rerender(
      <EntryTable
        filters={{ status: 'draft' }}
        plots={[plot()]}
        selectedEntryUuid={null}
        onSelectEntry={vi.fn()}
      />,
    );

    expect(lastQueryFilters()).toMatchObject({ status: 'draft' });
    expect(lastQueryFilters()).not.toHaveProperty('cursor');
  });

  describe('filter-scoped exports', () => {
    const scopedFilters: EntryListFilters = {
      plot_uuid: 'plot-1',
      status: 'final',
      activity_code: 'irrigation',
      occurred_from: '2026-07-01',
    };

    it('puts exactly three export controls in the table header: CSV, JSON, and research package (never ADAPT)', () => {
      renderTable();

      expect(screen.getByRole('button', { name: 'workspace.table.exportCsv' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'workspace.table.exportJson' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'workspace.table.exportPackage' })).toBeInTheDocument();
      expect(screen.queryByText(/adapt/i)).not.toBeInTheDocument();
    });

    it('keeps export controls available in loading, error, and empty states, not only when rows are present', () => {
      mockEntries({ loading: true, entries: [] });
      const { unmount } = renderTable();
      expect(screen.getByRole('button', { name: 'workspace.table.exportCsv' })).toBeInTheDocument();
      unmount();

      mockEntries({ error: new Error('offline'), entries: [] });
      const errorRender = renderTable();
      expect(screen.getByRole('button', { name: 'workspace.table.exportCsv' })).toBeInTheDocument();
      errorRender.unmount();

      mockEntries({ entries: [] });
      renderTable();
      expect(screen.getByRole('button', { name: 'workspace.table.exportCsv' })).toBeInTheDocument();
    });

    it('exports CSV using exactly the active filters — combining with, not escaping, the active scope', async () => {
      renderTable({ filters: scopedFilters });

      fireEvent.click(screen.getByRole('button', { name: 'workspace.table.exportCsv' }));

      await waitFor(() => expect(mocks.exportEntriesCsv).toHaveBeenCalledTimes(1));
      expect(mocks.exportEntriesCsv).toHaveBeenCalledWith(scopedFilters);
    });

    it('exports JSON using exactly the active filters', async () => {
      renderTable({ filters: scopedFilters });

      fireEvent.click(screen.getByRole('button', { name: 'workspace.table.exportJson' }));

      await waitFor(() => expect(mocks.exportEntriesJson).toHaveBeenCalledTimes(1));
      expect(mocks.exportEntriesJson).toHaveBeenCalledWith(scopedFilters);
    });

    it('exports the research package using exactly the active filters', async () => {
      renderTable({ filters: scopedFilters });

      fireEvent.click(screen.getByRole('button', { name: 'workspace.table.exportPackage' }));

      await waitFor(() => expect(mocks.exportEntriesResearchPackage).toHaveBeenCalledTimes(1));
      expect(mocks.exportEntriesResearchPackage).toHaveBeenCalledWith(scopedFilters);
    });

    it('never sends the pagination cursor/limit along with a filter-scoped export', async () => {
      mockEntries({ entries: [entry()], nextCursor: 'cursor-2' });
      renderTable({ filters: scopedFilters });
      fireEvent.click(screen.getByRole('button', { name: 'workspace.table.nextPage' }));

      fireEvent.click(screen.getByRole('button', { name: 'workspace.table.exportCsv' }));

      await waitFor(() => expect(mocks.exportEntriesCsv).toHaveBeenCalledTimes(1));
      expect(mocks.exportEntriesCsv).toHaveBeenCalledWith(scopedFilters);
      expect(mocks.exportEntriesCsv.mock.calls[0][0]).not.toHaveProperty('cursor');
      expect(mocks.exportEntriesCsv.mock.calls[0][0]).not.toHaveProperty('limit');
    });

    it('shows a retryable error message when an export fails, without disturbing the table', async () => {
      mocks.exportEntriesCsv.mockRejectedValueOnce(new Error('network down'));
      renderTable({ filters: scopedFilters });

      fireEvent.click(screen.getByRole('button', { name: 'workspace.table.exportCsv' }));

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('workspace.table.exportError'));

      mocks.exportEntriesCsv.mockResolvedValueOnce(undefined);
      fireEvent.click(screen.getByRole('button', { name: 'workspace.table.exportCsv' }));

      await waitFor(() => expect(mocks.exportEntriesCsv).toHaveBeenCalledTimes(2));
    });
  });
});
