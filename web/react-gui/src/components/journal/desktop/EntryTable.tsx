import type { TFunction } from 'i18next';
import { useMemo, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useJournalEntries } from '../../../journal/useJournalEntries';
import { journalApi } from '../../../services/journalApi';
import type { EntryAggregate, EntryListFilters, JournalPlot } from '../../../types/journal';
import { formatOccurredDate } from '../JournalEntryRow';
import {
  initialPaginationState,
  paginationReducer,
} from './entryTablePagination';

const PAGE_SIZE = 50;

type ExportKind = 'csv' | 'json' | 'package';

const EXPORT_METHOD: Record<ExportKind, (filters: EntryListFilters) => Promise<void>> = {
  csv: journalApi.exportEntriesCsv,
  json: journalApi.exportEntriesJson,
  package: journalApi.exportEntriesResearchPackage,
};

type SortKey = 'occurred' | 'activity' | 'plot' | 'status';
interface SortState {
  key: SortKey;
  direction: 'asc' | 'desc';
}

const DEFAULT_SORT: SortState = { key: 'occurred', direction: 'desc' };

const STATUS_CLASS: Record<EntryAggregate['status'], string> = {
  final: 'bg-[var(--success-bg)] text-[var(--success-text)]',
  draft: 'bg-[var(--warn-bg)] text-[var(--warn-text)]',
  voided: 'bg-red-100 text-red-800',
};

export interface EntryTableProps {
  filters: EntryListFilters;
  plots: readonly JournalPlot[];
  selectedEntryUuid: string | null;
  onSelectEntry: (entryUuid: string) => void;
}

function plotLabelOf(
  entry: EntryAggregate,
  plotLabels: ReadonlyMap<string, string>,
  t: TFunction<'journal'>,
): string {
  if (!entry.plot_uuid) return t('row.farmLevel');
  return plotLabels.get(entry.plot_uuid) ?? t('row.unknownPlot');
}

export function EntryTable({ filters, plots, selectedEntryUuid, onSelectEntry }: EntryTableProps) {
  const { t, i18n } = useTranslation('journal');
  const locale = i18n.resolvedLanguage || i18n.language;

  const [pagination, dispatchPagination] = useReducer(paginationReducer, initialPaginationState);
  const filtersKey = useMemo(() => JSON.stringify(filters), [filters]);
  // Adjust pagination state during render (not in an effect) so a stale,
  // filter-mismatched cursor is never sent to the edge for even one request:
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  let activePagination = pagination;
  if (activePagination.filtersKey !== filtersKey) {
    dispatchPagination({ type: 'sync', filtersKey });
    activePagination = { filtersKey, cursor: null, history: [] };
  }

  const queryFilters: EntryListFilters = useMemo(() => {
    const next: EntryListFilters = { ...filters, limit: PAGE_SIZE };
    if (activePagination.cursor) next.cursor = activePagination.cursor;
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey, activePagination.cursor]);

  const { entries, loading, error, nextCursor, retry } = useJournalEntries(queryFilters, true);

  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [pendingExport, setPendingExport] = useState<ExportKind | null>(null);
  const [exportError, setExportError] = useState<ExportKind | null>(null);

  const plotLabels = useMemo(
    () => new Map(plots.map((plot) => [plot.plot_uuid, plot.name?.trim() || plot.plot_code])),
    [plots],
  );

  const sortedEntries = useMemo(
    () => sortEntries(entries, sort, plotLabels, t),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, sort, plotLabels],
  );

  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

  const activeIndex = useMemo(() => {
    const idx = sortedEntries.findIndex((entry) => entry.entry_uuid === selectedEntryUuid);
    return idx === -1 ? 0 : idx;
  }, [sortedEntries, selectedEntryUuid]);

  const handleNext = () => {
    if (!nextCursor) return;
    dispatchPagination({ type: 'next', filtersKey, nextCursor });
  };
  const handlePrevious = () => {
    dispatchPagination({ type: 'previous', filtersKey });
  };

  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>, index: number) => {
    const nothingSelected = selectedEntryUuid == null;
    let target = index;
    switch (event.key) {
      case 'ArrowDown':
        target = nothingSelected ? index : Math.min(index + 1, sortedEntries.length - 1);
        break;
      case 'ArrowUp':
        target = nothingSelected ? index : Math.max(index - 1, 0);
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = sortedEntries.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (target === index && !nothingSelected) return;
    onSelectEntry(sortedEntries[target].entry_uuid);
    rowRefs.current[target]?.focus();
  };

  const handleExport = async (kind: ExportKind) => {
    setPendingExport(kind);
    setExportError(null);
    try {
      // `filters` — never `queryFilters` — so an export always carries exactly
      // the caller's active scope: no cursor/limit (a full export, not one
      // page) and nothing added or dropped relative to what the table itself
      // is showing.
      await EXPORT_METHOD[kind](filters);
    } catch {
      setExportError(kind);
    } finally {
      setPendingExport(null);
    }
  };

  const toggleSort = (key: SortKey) => {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }));
  };

  const headerCell = (key: SortKey) => {
    const active = sort.key === key;
    const ariaSort = active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';
    return (
      <th key={key} scope="col" aria-sort={ariaSort} className="px-3 py-2 text-left font-semibold">
        <button
          type="button"
          onClick={() => toggleSort(key)}
          className="flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
        >
          {t(`workspace.table.column.${key}`)}
          {active && <span aria-hidden="true">{sort.direction === 'asc' ? '▲' : '▼'}</span>}
        </button>
      </th>
    );
  };

  let body: React.ReactNode;
  if (loading && entries.length === 0) {
    body = (
      <p role="status" className="p-4 text-[var(--text-secondary)]">
        {t('workspace.table.loading')}
      </p>
    );
  } else if (error) {
    body = (
      <div role="alert" className="flex items-center justify-between gap-3 p-4 text-sm">
        <span>{t('workspace.table.error')}</span>
        <button
          type="button"
          onClick={() => retry()}
          className="rounded-lg border border-[var(--border)] px-3 py-2 font-bold"
        >
          {t('workspace.table.retry')}
        </button>
      </div>
    );
  } else if (sortedEntries.length === 0) {
    body = (
      <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-center text-[var(--text-secondary)]">
        {t('workspace.table.empty')}
      </div>
    );
  } else {
    body = (
      <table className="min-w-full text-left text-sm">
        <thead className="bg-[var(--surface)] text-xs uppercase text-[var(--text-secondary)]">
          <tr>
            {headerCell('occurred')}
            {headerCell('activity')}
            {headerCell('plot')}
            {headerCell('status')}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border)]">
          {sortedEntries.map((entry, index) => (
            <tr
              key={entry.entry_uuid}
              ref={(el) => {
                rowRefs.current[index] = el;
              }}
              data-testid={`entry-row-${entry.entry_uuid}`}
              role="row"
              aria-selected={entry.entry_uuid === selectedEntryUuid}
              tabIndex={index === activeIndex ? 0 : -1}
              onClick={() => onSelectEntry(entry.entry_uuid)}
              onKeyDown={(event) => handleRowKeyDown(event, index)}
              className={`cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-inset ${
                entry.entry_uuid === selectedEntryUuid ? 'bg-[var(--secondary-bg)]' : ''
              }`}
            >
              <td className="px-3 py-2">
                <time dateTime={entry.occurred_start}>
                  {formatOccurredDate(entry.occurred_start, entry.occurred_timezone, locale)}
                </time>
              </td>
              <td className="px-3 py-2">{t(`activity.${entry.activity_code}`, entry.activity_code)}</td>
              <td className="px-3 py-2">{plotLabelOf(entry, plotLabels, t)}</td>
              <td className="px-3 py-2">
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-bold ${STATUS_CLASS[entry.status]}`}
                >
                  {t(`row.status.${entry.status}`)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <section
      aria-label={t('workspace.table.heading')}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)]"
    >
      <div className="flex flex-wrap items-center justify-end gap-2 border-b border-[var(--border)] px-4 py-3">
        <button
          type="button"
          onClick={() => void handleExport('csv')}
          disabled={pendingExport !== null}
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('workspace.table.exportCsv')}
        </button>
        <button
          type="button"
          onClick={() => void handleExport('json')}
          disabled={pendingExport !== null}
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('workspace.table.exportJson')}
        </button>
        <button
          type="button"
          onClick={() => void handleExport('package')}
          disabled={pendingExport !== null}
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('workspace.table.exportPackage')}
        </button>
      </div>
      {exportError && (
        <div role="alert" className="px-4 py-2 text-sm font-semibold text-[var(--error-text)]">
          {t('workspace.table.exportError')}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
      <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-3">
        <button
          type="button"
          onClick={handlePrevious}
          disabled={activePagination.history.length === 0}
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('workspace.table.previousPage')}
        </button>
        <button
          type="button"
          onClick={handleNext}
          disabled={!nextCursor}
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('workspace.table.nextPage')}
        </button>
      </div>
    </section>
  );
}

function sortEntries(
  entries: readonly EntryAggregate[],
  sort: SortState,
  plotLabels: ReadonlyMap<string, string>,
  t: TFunction<'journal'>,
): EntryAggregate[] {
  const keyOf = (entry: EntryAggregate): string => {
    switch (sort.key) {
      case 'occurred':
        return entry.occurred_start;
      case 'activity':
        return t(`activity.${entry.activity_code}`, entry.activity_code);
      case 'plot':
        return plotLabelOf(entry, plotLabels, t);
      case 'status':
        return t(`row.status.${entry.status}`);
      default:
        return '';
    }
  };
  // Negate the comparator rather than sorting ascending and reversing the
  // array: reversing would also flip the relative order of tied entries
  // (e.g. two entries with the same occurred_start), breaking Array.sort's
  // stability guarantee for descending order.
  const direction = sort.direction === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => direction * keyOf(a).localeCompare(keyOf(b)));
}
