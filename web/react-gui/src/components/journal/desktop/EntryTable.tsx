import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { buildCatalogModel, vocabLabelOrCode } from '../../../journal/catalogModel';
import { groupEntryTablePassRows, type EntryTablePassRow } from '../../../journal/groupEntryTablePassRows';
import { useJournalEntries } from '../../../journal/useJournalEntries';
import { journalApi } from '../../../services/journalApi';
import type { EntryAggregate, EntryListFilters, JournalCatalog, JournalPlot } from '../../../types/journal';
import type { JournalCaptureCatalogModel } from '../../../types/journalCapture';
import { formatOccurredDate } from '../JournalEntryRow';
import { statusBadgeClass } from '../statusBadgeClass';
import {
  initialPaginationState,
  paginationReducer,
} from './entryTablePagination';

export const PAGE_SIZE = 50;

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

export interface EntryTableProps {
  filters: EntryListFilters;
  plots: readonly JournalPlot[];
  selectedEntryUuid: string | null;
  onSelectEntry: (entryUuid: string) => void;
  // Rendered at the start of the table's own header row, to the left of the
  // export buttons — the seam JournalWorkspace uses to place its "Log
  // activity" trigger in the same row without EntryTable knowing anything
  // about capture.
  headerStart?: ReactNode;
  // P1 fix (live UX pass): resolves entry.activity_code via the catalog's own
  // label (see journal/catalogModel.ts's vocabLabelOrCode) instead of the
  // incomplete client-side `journal.json` activity.* map. Optional/absent in
  // narrow test-only render paths — same additive convention JournalTimeline
  // already established for its own `catalog` prop; falls back to the raw
  // activity code when omitted.
  catalog?: JournalCatalog;
}

function plotLabelOf(
  entry: EntryAggregate,
  plotLabels: ReadonlyMap<string, string>,
  t: TFunction<'journal'>,
): string {
  if (!entry.plot_uuid) return t('row.farmLevel');
  return plotLabels.get(entry.plot_uuid) ?? t('row.unknownPlot');
}

export function EntryTable({
  filters, plots, selectedEntryUuid, onSelectEntry, headerStart, catalog,
}: EntryTableProps) {
  const { t, i18n } = useTranslation('journal');
  const locale = i18n.resolvedLanguage || i18n.language;
  const modelResult = useMemo(() => (catalog ? buildCatalogModel(catalog) : null), [catalog]);
  const model = modelResult?.ok ? modelResult.model : null;

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
  // P1-c: every export attempt — CSV included — now reports its outcome
  // here, success or failure, so none of the three can ever look like a
  // silent no-op. Only the most recent attempt's status is kept.
  const [exportStatus, setExportStatus] = useState<{ kind: ExportKind; result: 'success' | 'error' } | null>(null);

  // A completed-export banner names a specific attempt; once the caller
  // moves to a different scope/filter set, that attempt no longer describes
  // what "export" would do now, so don't let it linger.
  useEffect(() => {
    setExportStatus(null);
  }, [filtersKey]);

  const plotLabels = useMemo(
    () => new Map(plots.map((plot) => [plot.plot_uuid, plot.name?.trim() || plot.plot_code])),
    [plots],
  );

  const sortedEntries = useMemo(
    () => sortEntries(entries, sort, plotLabels, t, model, locale),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, sort, plotLabels, model, locale],
  );

  // P2 (live UX pass): group a tank-mix pass (N entries sharing one
  // pass_uuid) into a single collapsible row — see
  // journal/groupEntryTablePassRows.ts for why pass_uuid, not batch_uuid, is
  // the grouping key. Grouping runs over the already-sorted list, so a
  // group's table position is wherever its first (in sort order) member
  // landed; every OTHER member collapses into that same row regardless of
  // where the sort would otherwise have placed it, mirroring how
  // groupJournalTimelineEntries groups over its own entries prop rather than
  // resorting the result.
  const tableRows = useMemo(() => groupEntryTablePassRows(sortedEntries), [sortedEntries]);

  const [expandedPasses, setExpandedPasses] = useState<Set<string>>(() => new Set());

  const toggleExpandedPass = (passUuid: string) => {
    setExpandedPasses((current) => {
      const next = new Set(current);
      if (next.has(passUuid)) next.delete(passUuid);
      else next.add(passUuid);
      return next;
    });
  };

  // Known, accepted gap (same shape as the module's other documented gaps,
  // e.g. scopeNotNarrowed): unlike JournalTimeline's cross-plot batch
  // grouping, this never hydrates a pass's full membership from the edge —
  // it only groups whatever page of `entries` is already loaded. A pass is
  // created atomically (buildTankMixPassBatchPayload) with every member
  // sharing one occurred_start, so in practice all its members land on the
  // same page/sort position; a pass split across a page boundary would show
  // as two partial groups instead of failing, the same tradeoff
  // groupJournalTimelineEntries's own un-hydrated initial render already
  // accepts.
  //
  // Arrow/Home/End roving-tabIndex navigation (below) and row selection only
  // ever operate over entries the operator can actually select right now: a
  // standalone entry, or a pass member once its group is expanded. A
  // collapsed pass row is a pure disclosure control (its "Expand" button)
  // with no entry of its own to select, exactly like JournalTimeline's
  // batch card has no whole-card click-to-select either.
  const selectableEntries = useMemo(() => tableRows.flatMap((row) => (
    row.kind === 'entry' ? [row.entry] : (expandedPasses.has(row.passUuid) ? row.entries : [])
  )), [tableRows, expandedPasses]);

  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

  const activeIndex = useMemo(() => {
    const idx = selectableEntries.findIndex((entry) => entry.entry_uuid === selectedEntryUuid);
    return idx === -1 ? 0 : idx;
  }, [selectableEntries, selectedEntryUuid]);

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
        target = nothingSelected ? index : Math.min(index + 1, selectableEntries.length - 1);
        break;
      case 'ArrowUp':
        target = nothingSelected ? index : Math.max(index - 1, 0);
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = selectableEntries.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (target === index && !nothingSelected) return;
    onSelectEntry(selectableEntries[target].entry_uuid);
    rowRefs.current[target]?.focus();
  };

  const handleExport = async (kind: ExportKind) => {
    setPendingExport(kind);
    setExportStatus(null);
    try {
      // `filters` — never `queryFilters` — so an export always carries exactly
      // the caller's active scope: no cursor/limit (a full export, not one
      // page) and nothing added or dropped relative to what the table itself
      // is showing.
      await EXPORT_METHOD[kind](filters);
      setExportStatus({ kind, result: 'success' });
    } catch {
      setExportStatus({ kind, result: 'error' });
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

  // Shared row renderer: used for every standalone entry AND for each member
  // of an expanded pass group, so the two look and behave identically (same
  // roving-tabIndex/selection wiring) — only a pass member additionally
  // receives `nested` (indents the occurred cell) so it visually reads as
  // belonging to the summary row above it.
  const renderEntryRow = (entry: EntryAggregate, index: number, nested = false) => (
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
      <td className={`px-3 py-2 ${nested ? 'pl-8' : ''}`}>
        <time dateTime={entry.occurred_start}>
          {formatOccurredDate(entry.occurred_start, entry.occurred_timezone, locale)}
        </time>
      </td>
      <td className="px-3 py-2">{vocabLabelOrCode(entry.activity_code, model, locale)}</td>
      <td className="px-3 py-2">{plotLabelOf(entry, plotLabels, t)}</td>
      <td className="px-3 py-2">
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-bold ${statusBadgeClass(entry.status)}`}
        >
          {t(`row.status.${entry.status}`)}
        </span>
      </td>
    </tr>
  );

  // P2: a pass group's own row — the activity + product count once, with an
  // expand/collapse affordance in the status column (a pass group has no
  // single status of its own to show there; every member's actual status is
  // visible once expanded via renderEntryRow above, same as
  // JournalTimeline's batch card only shows member status post-expansion).
  const renderPassRow = (row: Extract<EntryTablePassRow, { kind: 'pass' }>) => {
    const representative = row.entries[0];
    const count = row.entries.length;
    const expanded = expandedPasses.has(row.passUuid);
    return (
      <tr
        key={`pass:${row.passUuid}`}
        data-testid={`entry-pass-row-${row.passUuid}`}
        className="bg-[var(--surface)]"
      >
        <td className="px-3 py-2">
          <time dateTime={representative.occurred_start}>
            {formatOccurredDate(representative.occurred_start, representative.occurred_timezone, locale)}
          </time>
        </td>
        <td className="px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{vocabLabelOrCode(representative.activity_code, model, locale)}</span>
            <span className="rounded-full bg-[var(--secondary-bg)] px-2 py-0.5 text-xs font-bold text-[var(--text-secondary)]">
              {t('workspace.table.pass.count', {
                count,
                defaultValue: `${count} product${count === 1 ? '' : 's'}`,
              })}
            </span>
          </div>
        </td>
        <td className="px-3 py-2">{plotLabelOf(representative, plotLabels, t)}</td>
        <td className="px-3 py-2">
          <button
            type="button"
            // No aria-controls: this button's expanded content is a set of
            // sibling <tr>s, only ever mounted once expanded (no
            // always-present container to name unlike JournalTimeline's own
            // hidden div, which isn't valid markup as a <tbody> child here).
            // aria-expanded on its own already communicates the toggle state.
            aria-expanded={expanded}
            onClick={() => toggleExpandedPass(row.passUuid)}
            className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-bold"
          >
            {t(expanded ? 'workspace.table.pass.collapse' : 'workspace.table.pass.expand', {
              defaultValue: expanded ? 'Collapse pass' : 'Expand pass',
            })}
          </button>
        </td>
      </tr>
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
    let selectableIndex = 0;
    const rows: React.ReactNode[] = [];
    for (const row of tableRows) {
      if (row.kind === 'entry') {
        rows.push(renderEntryRow(row.entry, selectableIndex));
        selectableIndex += 1;
        continue;
      }
      rows.push(renderPassRow(row));
      if (expandedPasses.has(row.passUuid)) {
        for (const member of row.entries) {
          rows.push(renderEntryRow(member, selectableIndex, true));
          selectableIndex += 1;
        }
      }
    }
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
        <tbody className="divide-y divide-[var(--border)]">{rows}</tbody>
      </table>
    );
  }

  return (
    <section
      aria-label={t('workspace.table.heading')}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">{headerStart}</div>
        <div className="flex flex-wrap items-center gap-2">
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
      </div>
      {exportStatus?.result === 'error' && (
        // bg-[var(--error-bg)] is load-bearing, not decorative: --error-text
        // is white-on-light-theme (#FFFFFF), meant to sit on the red
        // --error-bg exactly like every other error surface in this app
        // (see StationGrid's range-error banner). Without it this text was
        // white-on-white — invisible — so a failed export looked exactly
        // like a silent no-op even though the request had actually run.
        <div role="alert" className="bg-[var(--error-bg)] px-4 py-2 text-sm font-semibold text-[var(--error-text)]">
          {t('workspace.table.exportError')}
        </div>
      )}
      {exportStatus?.result === 'success' && (
        <div role="status" className="bg-[var(--success-bg)] px-4 py-2 text-sm font-semibold text-[var(--success-text)]">
          {t('workspace.table.exportSuccess')}
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
  model: JournalCaptureCatalogModel | null,
  locale: string,
): EntryAggregate[] {
  const keyOf = (entry: EntryAggregate): string => {
    switch (sort.key) {
      case 'occurred':
        return entry.occurred_start;
      case 'activity':
        return vocabLabelOrCode(entry.activity_code, model, locale);
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
