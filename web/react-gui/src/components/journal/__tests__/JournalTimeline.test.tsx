import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntryAggregate, JournalCatalog, JournalPlot, JournalVocabRow } from '../../../types/journal';
import type { BatchMembershipPage } from '../../../journal/hydrateBatchMembership';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; defaultValue?: string }) => {
      if (options?.defaultValue) {
        return options.defaultValue.replace('{{count}}', String(options.count ?? ''));
      }
      return key;
    },
    i18n: { resolvedLanguage: 'en-GB', language: 'en-GB' },
  }),
}));

vi.mock('../JournalEntryRow', () => ({
  JournalEntryRow: ({ entry, plotLabel }: { entry: EntryAggregate; plotLabel: string | null }) => (
    <div data-testid="mock-journal-entry-row">
      <span>{entry.entry_uuid}</span>
      <span>{entry.status}</span>
      <span>{entry.sync_version}</span>
      <span>{plotLabel}</span>
    </div>
  ),
}));

import { JournalTimeline, groupJournalTimelineEntries } from '../JournalTimeline';

function entry(
  entry_uuid: string,
  overrides: Partial<EntryAggregate> = {},
): EntryAggregate {
  return {
    entry_uuid,
    activity_code: 'irrigation',
    plot_uuid: 'p1',
    season_crop: 'barley',
    batch_uuid: null,
    status: 'final',
    sync_version: 7,
    occurred_start: '2026-07-10T08:00:00.000Z',
    occurred_timezone: 'Europe/Zurich',
    values: [],
    ...overrides,
  } as unknown as EntryAggregate;
}

// P2-c (mobile): season_crop is a vocab choice code (e.g.
// agroscope.crop.potato); a catalog with a matching row lets the batch
// summary show its label instead of the raw code — mirrors DetailPanel's
// desktop fixture (DetailPanel.test.tsx's `row`/season_crop test).
function cropChoiceRow(code: string, labelEn: string): JournalVocabRow {
  return {
    code,
    kind: 'choice',
    parent_code: 'season_crop',
    value_type: null,
    quantity_kind: null,
    basis: null,
    default_unit_code: null,
    icon_key: null,
    scope: 'core',
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

function catalogWithCrop(code: string, labelEn: string): JournalCatalog {
  return {
    catalog_version: 1,
    catalog_hash: 'hash-1',
    vocab: [cropChoiceRow(code, labelEn)],
    templates: [],
    layouts: [],
    products: [],
    mappings: [],
  };
}

const listBatchEntries = vi.fn();

describe('JournalTimeline', () => {
  beforeEach(() => {
    listBatchEntries.mockReset();
  });

  it('groups final entries by first occurrence without mutating input and leaves null batches independent', () => {
    const entries = [
      entry('e2', { batch_uuid: 'batch-b', activity_code: 'harvest' }),
      entry('e1', { batch_uuid: null, activity_code: 'seeding' }),
      entry('e3', { batch_uuid: 'batch-a', activity_code: 'irrigation' }),
      entry('e4', { batch_uuid: 'batch-b', activity_code: 'harvest' }),
    ];
    const snapshot = entries.map((value) => ({ ...value }));

    expect(groupJournalTimelineEntries(entries)).toEqual([
      expect.objectContaining({ kind: 'batch', batchUuid: 'batch-b', count: 2 }),
      expect.objectContaining({ kind: 'entry', entry: entries[1] }),
      expect.objectContaining({ kind: 'batch', batchUuid: 'batch-a', count: 1 }),
    ]);
    expect(groupJournalTimelineEntries(entries)[0]).toMatchObject({
      activityCode: 'harvest',
      cropSummary: 'barley',
      entries: [entries[0], entries[3]],
    });
    expect(entries).toEqual(snapshot);
  });

  // P2-b (Slice D hardening): a harvest/manual-close/reseed entry that closed
  // a crop cycle keeps its OWN season_crop NULL by design — the timeline
  // must fall back to the edge's closed_crop_code/variety display
  // enrichment (osi-journal/lifecycle.js resolveClosedCropCycleOverrides) so
  // a harvest batch still shows what was harvested.
  it('falls back to closed_crop_code for a batch summary when season_crop is null (closing entries)', () => {
    const grouped = groupJournalTimelineEntries([
      entry('e1', {
        batch_uuid: 'batch-harvest', activity_code: 'harvest', season_crop: null,
        closed_crop_code: 'agroscope.crop.wheat_winter',
      }),
      entry('e2', {
        batch_uuid: 'batch-harvest', activity_code: 'harvest', season_crop: null,
        closed_crop_code: 'agroscope.crop.wheat_winter',
      }),
    ]);

    expect(grouped).toEqual([
      expect.objectContaining({ kind: 'batch', activityCode: 'harvest', cropSummary: 'agroscope.crop.wheat_winter' }),
    ]);
  });

  it('keeps null and blank batch IDs standalone while preserving opaque nonblank IDs', () => {
    const opaque = entry('opaque-entry', { batch_uuid: 'not-a-uuid' });
    const blank = entry('blank-entry', { batch_uuid: '  ' });

    expect(groupJournalTimelineEntries([opaque, blank])).toEqual([
      expect.objectContaining({ kind: 'batch', batchUuid: 'not-a-uuid' }),
      { kind: 'entry', entry: blank },
    ]);
  });

  it('exports neutral metadata when a batch has inconsistent activity or crop', () => {
    const grouped = groupJournalTimelineEntries([
      entry('e1', { batch_uuid: 'batch-1', activity_code: 'irrigation', season_crop: 'barley' }),
      entry('e2', { batch_uuid: 'batch-1', activity_code: 'harvest', season_crop: 'wheat' }),
    ]);

    expect(grouped).toEqual([
      expect.objectContaining({
        kind: 'batch',
        activityCode: '',
        cropSummary: null,
      }),
    ]);
  });

  it('omits inconsistent activity and crop details from a collapsed summary', () => {
    render(
      <JournalTimeline
        entries={[
          entry('e1', { batch_uuid: 'batch-1', activity_code: 'irrigation', season_crop: ' barley ' }),
          entry('e2', { batch_uuid: 'batch-1', activity_code: 'harvest', season_crop: 'wheat' }),
        ]}
        plots={[]}
        loading={false}
        listBatchEntries={listBatchEntries}
      />,
    );

    expect(screen.getByText('Batch activity')).toBeInTheDocument();
    expect(screen.queryByText(/activity\.irrigation/)).not.toBeInTheDocument();
    expect(screen.queryByText(/barley|wheat/)).not.toBeInTheDocument();
  });

  it('derives summary details from hydrated membership and shows a generic retry error for empty success', async () => {
    listBatchEntries.mockResolvedValueOnce({
      entries: [
        entry('e1', { batch_uuid: 'batch-1', activity_code: 'harvest', season_crop: ' wheat ' }),
        entry('e2', { batch_uuid: 'batch-1', activity_code: 'harvest', season_crop: 'wheat' }),
      ],
      next_cursor: null,
    });

    const { rerender } = render(
      <JournalTimeline
        entries={[entry('e1', { batch_uuid: 'batch-1', activity_code: 'irrigation', season_crop: 'barley' })]}
        plots={[]}
        loading={false}
        listBatchEntries={listBatchEntries}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expand batch' }));
    await waitFor(() => expect(screen.getByText(/activity\.harvest/)).toBeInTheDocument());
    expect(screen.getByText(/wheat/)).toBeInTheDocument();
    expect(screen.queryByText(/activity\.irrigation/)).not.toBeInTheDocument();

    listBatchEntries.mockResolvedValueOnce({ entries: [], next_cursor: null });
    rerender(
      <JournalTimeline
        entries={[entry('empty', { batch_uuid: 'batch-empty' })]}
        plots={[]}
        loading={false}
        listBatchEntries={listBatchEntries}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expand batch' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to load batch entries.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Error');
  });

  it('renders a collapsed batch summary without correction or apply-all controls', () => {
    render(
      <JournalTimeline
        entries={[
          entry('e1', { batch_uuid: 'batch-1' }),
          entry('e2', { batch_uuid: 'batch-1', plot_uuid: 'p2' }),
        ]}
        plots={[
          { plot_uuid: 'p1', plot_code: 'N-1', name: 'North field' },
          { plot_uuid: 'p2', plot_code: 'S-1', name: 'South field' },
        ] as unknown as JournalPlot[]}
        loading={false}
        listBatchEntries={listBatchEntries}
      />,
    );

    expect(screen.getByText('Batch activity')).toBeInTheDocument();
    expect(screen.queryByText(/2 plots/)).not.toBeInTheDocument();
    expect(screen.getByText(/barley/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /void|correct|apply/i })).not.toBeInTheDocument();
  });

  // P2-c (mobile): live re-test found the mobile batch card showing the raw
  // vocab code ("Harvest · agroscope.crop.potato") — desktop's DetailPanel
  // already resolves season_crop through the catalog (see its
  // vocabLabelOrCode test), this mobile summary card did not. Sibling test
  // to DetailPanel.test.tsx's "shows a localized crop label for
  // season_crop...".
  it('shows a localized crop label in the batch summary when the catalog has a matching choice row', () => {
    render(
      <JournalTimeline
        entries={[
          entry('e1', { batch_uuid: 'batch-1', activity_code: 'harvest', season_crop: 'agroscope.crop.potato' }),
          entry('e2', { batch_uuid: 'batch-1', activity_code: 'harvest', season_crop: 'agroscope.crop.potato' }),
        ]}
        plots={[]}
        loading={false}
        catalog={catalogWithCrop('agroscope.crop.potato', 'Potato')}
        listBatchEntries={listBatchEntries}
      />,
    );

    expect(screen.getByText(/Potato/)).toBeInTheDocument();
    expect(screen.queryByText(/agroscope\.crop\.potato/)).not.toBeInTheDocument();
  });

  // Without a matching catalog row (or no catalog at all — see the earlier
  // tests in this file), the summary must still fall back to the raw code
  // rather than rendering nothing.
  it('falls back to the raw crop code in the batch summary when the catalog has no matching row', () => {
    render(
      <JournalTimeline
        entries={[
          entry('e1', { batch_uuid: 'batch-1', activity_code: 'harvest', season_crop: 'agroscope.crop.potato' }),
        ]}
        plots={[]}
        loading={false}
        catalog={catalogWithCrop('agroscope.crop.wheat_winter', 'Winter wheat')}
        listBatchEntries={listBatchEntries}
      />,
    );

    expect(screen.getByText(/agroscope\.crop\.potato/)).toBeInTheDocument();
  });

  it('keeps the aria-controls target present and neutral through batch states', async () => {
    listBatchEntries
      .mockRejectedValueOnce(new Error('membership unavailable'))
      .mockResolvedValueOnce({
        entries: [entry('child', { batch_uuid: 'batch-1' })],
        next_cursor: null,
      });

    render(
      <JournalTimeline
        entries={[entry('e1', { batch_uuid: 'batch-1' })]}
        plots={[]}
        loading={false}
        listBatchEntries={listBatchEntries}
      />,
    );

    const expand = screen.getByRole('button', { name: 'Expand batch' });
    const contentId = expand.getAttribute('aria-controls');
    expect(contentId).toBeTruthy();
    const content = document.getElementById(contentId!);
    expect(content).toBeInTheDocument();
    expect(content).not.toHaveAttribute('role', 'list');

    fireEvent.click(expand);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(document.getElementById(contentId!)).toBe(content);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('child')).toBeInTheDocument());
    expect(document.getElementById(contentId!)).toBe(content);
  });

  it('shows hydrated count, all plot names, and actual child statuses after expansion', async () => {
    const voided = entry('voided-child', {
      batch_uuid: 'batch-1', plot_uuid: 'p2', status: 'voided', sync_version: 12,
    });
    listBatchEntries.mockResolvedValueOnce({
      entries: [entry('e1', { batch_uuid: 'batch-1' }), voided, entry('late-child', {
        batch_uuid: 'batch-1', plot_uuid: 'p3', status: 'final', sync_version: 13,
      })],
      next_cursor: null,
    });

    render(
      <JournalTimeline
        entries={[entry('e1', { batch_uuid: 'batch-1' })]}
        plots={[
          { plot_uuid: 'p1', plot_code: 'N-1', name: 'North field' },
          { plot_uuid: 'p2', plot_code: 'S-1', name: 'South field' },
          { plot_uuid: 'p3', plot_code: 'West field', name: 'West field' },
        ] as unknown as JournalPlot[]}
        loading={false}
        listBatchEntries={listBatchEntries}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Expand batch' }));

    await waitFor(() => expect(listBatchEntries).toHaveBeenCalledWith({
      batch_uuid: 'batch-1', status: 'all', limit: 100,
    }));
    expect(await screen.findByText(/3 plots/)).toBeInTheDocument();
    expect(screen.getByText(/North field/)).toBeInTheDocument();
    expect(screen.getByText(/South field/)).toBeInTheDocument();
    expect(screen.getByText(/West field/)).toBeInTheDocument();
    const voidedRow = screen.getByText('voided-child').parentElement?.parentElement;
    expect(voidedRow).toHaveTextContent('voided');
    expect(voidedRow).toHaveTextContent('12');
  });

  it('hides partial counts before hydration and keeps the complete count after collapse', async () => {
    let resolveMembership: ((page: BatchMembershipPage) => void) | undefined;
    listBatchEntries.mockReturnValueOnce(new Promise<BatchMembershipPage>((resolve) => {
      resolveMembership = resolve;
    }));

    render(
      <JournalTimeline
        entries={[entry('e1', { batch_uuid: 'batch-1' })]}
        plots={[]}
        loading={false}
        listBatchEntries={listBatchEntries}
      />,
    );

    expect(screen.queryByText(/1 plot/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand batch' }));
    expect(screen.getByText(/Loading batch entries/)).toBeInTheDocument();
    expect(screen.queryByText(/1 plot/)).not.toBeInTheDocument();

    resolveMembership?.({
      entries: [
        entry('e1', { batch_uuid: 'batch-1' }),
        entry('e2', { batch_uuid: 'batch-1', plot_uuid: 'p2' }),
        entry('e3', { batch_uuid: 'batch-1', plot_uuid: 'p3' }),
      ],
      next_cursor: null,
    });
    expect(await screen.findByText(/3 plots/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse batch' }));

    expect(screen.getByText(/3 plots/)).toBeInTheDocument();
    expect(screen.queryAllByTestId('mock-journal-entry-row')).toHaveLength(0);
  });

  it('keeps grouped items in first input order and preserves child order', async () => {
    const entries = [
      entry('batch-b-first', { batch_uuid: 'batch-b', activity_code: 'harvest' }),
      entry('standalone', { batch_uuid: null, activity_code: 'seeding' }),
      entry('batch-a-first', { batch_uuid: 'batch-a', activity_code: 'irrigation' }),
      entry('batch-b-second', { batch_uuid: 'batch-b', activity_code: 'harvest' }),
    ];
    const grouped = groupJournalTimelineEntries(entries);

    expect(grouped.map((item) => item.kind === 'batch' ? item.batchUuid : item.entry.entry_uuid))
      .toEqual(['batch-b', 'standalone', 'batch-a']);
    expect(grouped[0]).toMatchObject({
      entries: [entries[0], entries[3]],
    });
  });

  it('shows the loading state while entries are pending', () => {
    render(<JournalTimeline entries={[]} plots={[]} loading listBatchEntries={listBatchEntries} />);

    expect(screen.getByText('timeline.loading')).toBeInTheDocument();
  });

  it('shows the empty state when there are no entries', () => {
    render(<JournalTimeline entries={[]} plots={[]} loading={false} listBatchEntries={listBatchEntries} />);

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

    render(<JournalTimeline entries={entries} plots={plots} loading={false} listBatchEntries={listBatchEntries} />);

    expect(screen.getByText('e1')).toBeInTheDocument();
    expect(screen.getByText('e2')).toBeInTheDocument();
    expect(screen.getByText(/North field/)).toBeInTheDocument();
    expect(screen.queryByText(/p1/)).not.toBeInTheDocument();
  });

  it('renders loading, retryable error, and succeeds after a failed hydration retry without concurrent duplicates', async () => {
    let rejectFirst: ((reason?: unknown) => void) | undefined;
    listBatchEntries
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }))
      .mockRejectedValueOnce(new Error('membership unavailable'))
      .mockResolvedValueOnce({
        entries: [
          entry('e1', { batch_uuid: 'batch-1' }),
          entry('e2', { batch_uuid: 'batch-1', plot_uuid: 'p2' }),
          entry('e3', { batch_uuid: 'batch-1', plot_uuid: 'p3' }),
        ],
        next_cursor: null,
      });

    render(
      <JournalTimeline
        entries={[entry('e1', { batch_uuid: 'batch-1' })]}
        plots={[]}
        loading={false}
        listBatchEntries={listBatchEntries}
      />,
    );

    const expand = screen.getByRole('button', { name: 'Expand batch' });
    fireEvent.click(expand);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Collapse batch' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Collapse batch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand batch' }));
    expect(listBatchEntries).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Loading batch entries/)).toBeInTheDocument();
    rejectFirst?.(new Error('membership unavailable'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument());
    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(listBatchEntries).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Unable to load batch entries.'));
    expect(screen.getByRole('alert')).not.toHaveTextContent('membership unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(listBatchEntries).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(/3 plots/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse batch' }));
    expect(screen.getByText(/3 plots/)).toBeInTheDocument();
  });

  it('ignores an old response after the membership callback changes', async () => {
    let resolveOld: ((page: BatchMembershipPage) => void) | undefined;
    const oldListBatchEntries = vi.fn(() => new Promise<BatchMembershipPage>((resolve) => {
      resolveOld = resolve;
    }));
    const newListBatchEntries = vi.fn().mockResolvedValue({
      entries: [entry('new-child', { batch_uuid: 'batch-1' })],
      next_cursor: null,
    });
    const view = render(
      <JournalTimeline
        entries={[entry('initial', { batch_uuid: 'batch-1' })]}
        plots={[]}
        loading={false}
        listBatchEntries={oldListBatchEntries}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expand batch' }));

    view.rerender(
      <JournalTimeline
        entries={[entry('initial', { batch_uuid: 'batch-1' })]}
        plots={[]}
        loading={false}
        listBatchEntries={newListBatchEntries}
      />,
    );
    await waitFor(() => expect(newListBatchEntries).toHaveBeenCalledOnce());
    resolveOld?.({ entries: [entry('stale-child', { batch_uuid: 'batch-1' })], next_cursor: null });
    await waitFor(() => expect(screen.getByText('new-child')).toBeInTheDocument());
    expect(screen.queryByText('stale-child')).not.toBeInTheDocument();
  });

  it('invalidates collapsed ready hydration when the membership callback changes', async () => {
    const oldListBatchEntries = vi.fn().mockResolvedValue({
      entries: [entry('old-child', { batch_uuid: 'batch-1' })],
      next_cursor: null,
    });
    let resolveNew: ((page: BatchMembershipPage) => void) | undefined;
    const newListBatchEntries = vi.fn(() => new Promise<BatchMembershipPage>((resolve) => {
      resolveNew = resolve;
    }));
    const view = render(
      <JournalTimeline
        entries={[entry('initial', { batch_uuid: 'batch-1' })]}
        plots={[]}
        loading={false}
        listBatchEntries={oldListBatchEntries}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Expand batch' }));
    expect(await screen.findByText('old-child')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse batch' }));

    view.rerender(
      <JournalTimeline
        entries={[entry('initial', { batch_uuid: 'batch-1' })]}
        plots={[]}
        loading={false}
        listBatchEntries={newListBatchEntries}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expand batch' }));

    expect(newListBatchEntries).toHaveBeenCalledWith({
      batch_uuid: 'batch-1', status: 'all', limit: 100,
    });
    expect(screen.getByText(/Loading batch entries/)).toBeInTheDocument();
    expect(screen.queryByText('old-child')).not.toBeInTheDocument();

    resolveNew?.({
      entries: [entry('new-child', { batch_uuid: 'batch-1' })],
      next_cursor: null,
    });
    expect(await screen.findByText('new-child')).toBeInTheDocument();
  });

  it('handles same-tick expand/collapse without duplicate requests', () => {
    const pending = new Promise<BatchMembershipPage>(() => undefined);
    listBatchEntries.mockReturnValue(pending);
    render(
      <JournalTimeline
        entries={[entry('e1', { batch_uuid: 'batch-1' })]}
        plots={[]}
        loading={false}
        listBatchEntries={listBatchEntries}
      />,
    );
    const button = screen.getByRole('button', { name: 'Expand batch' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(listBatchEntries).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Expand batch' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('hydrates two batches independently', async () => {
    const resolvers = new Map<string, (page: BatchMembershipPage) => void>();
    listBatchEntries.mockImplementation(({ batch_uuid }: { batch_uuid: string }) => new Promise((resolve) => {
      resolvers.set(batch_uuid, resolve);
    }));
    render(
      <JournalTimeline
        entries={[
          entry('a', { batch_uuid: 'batch-a' }),
          entry('b', { batch_uuid: 'batch-b' }),
        ]}
        plots={[]}
        loading={false}
        listBatchEntries={listBatchEntries}
      />,
    );
    const expandButtons = screen.getAllByRole('button', { name: 'Expand batch' });
    fireEvent.click(expandButtons[0]);
    fireEvent.click(expandButtons[1]);

    expect(listBatchEntries).toHaveBeenCalledTimes(2);
    resolvers.get('batch-a')?.({ entries: [entry('a-child', { batch_uuid: 'batch-a' })], next_cursor: null });
    await waitFor(() => expect(screen.getByText('a-child')).toBeInTheDocument());
    expect(screen.queryByText('b-child')).not.toBeInTheDocument();
  });

  it('does not update after unmount under StrictMode', async () => {
    let resolvePending: ((page: BatchMembershipPage) => void) | undefined;
    const pendingList = vi.fn(() => new Promise<BatchMembershipPage>((resolve) => {
      resolvePending = resolve;
    }));
    const view = render(
      <StrictMode>
        <JournalTimeline
          entries={[entry('e1', { batch_uuid: 'batch-1' })]}
          plots={[]}
          loading={false}
          listBatchEntries={pendingList}
        />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expand batch' }));
    view.unmount();
    resolvePending?.({ entries: [entry('late-child', { batch_uuid: 'batch-1' })], next_cursor: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(pendingList).toHaveBeenCalledOnce();
  });
});
