import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { refreshDraftsQueue } from '../../../journal/useDraftsQueue';
import { useJournalEntries } from '../../../journal/useJournalEntries';
import type { JournalPlotGroupResourceActions } from '../../../journal/useJournalPlotGroups';
import type { JournalPlotResourceActions } from '../../../journal/useJournalPlots';
import type { IrrigationZone } from '../../../types/farming';
import type {
  EntryAggregate,
  EntryListFilters,
  JournalCatalog,
  JournalPlot,
  JournalVocabRow,
  PlotGroup,
} from '../../../types/journal';
import { JournalCaptureFlow, type JournalSavedReceipt } from '../capture/JournalCaptureFlow';
import { DraftsQueue } from '../DraftsQueue';
import { DetailPanel } from './DetailPanel';
import { EntryTable, PAGE_SIZE } from './EntryTable';
import {
  DEFAULT_SCOPE_RAIL_FILTERS,
  ScopeRail,
  type ScopeRailFilters,
  type ScopeSelection,
} from './ScopeRail';

export interface JournalWorkspaceProps {
  plots: readonly JournalPlot[];
  activeGroups: readonly PlotGroup[];
  zones: readonly IrrigationZone[];
  activities: readonly JournalVocabRow[];
  catalog: JournalCatalog;
  // Capture-flow dependencies. JournalPage already assembles every one of
  // these for the mobile <JournalCaptureFlow> branch — the desktop "Log
  // activity" modal below reuses the exact same values rather than
  // duplicating any of the plot/group/zone enrichment logic.
  plotGroups: PlotGroup[];
  recentEntries: EntryAggregate[];
  initialTimezone?: string;
  zoneCrops?: Readonly<Record<string, string>>;
  zoneTimezones?: Readonly<Record<string, string>>;
  plotState: Pick<JournalPlotResourceActions, 'createPlot' | 'updatePlot' | 'revalidate'>;
  groupState: Pick<JournalPlotGroupResourceActions, 'createPlotGroup' | 'updatePlotGroup'>;
}

type ZoneLike = Pick<IrrigationZone, 'zone_uuid' | 'zoneUuid' | 'device_count' | 'deviceCount'>;

function zoneUuidOf(zone: ZoneLike): string | null {
  return zone.zone_uuid ?? zone.zoneUuid ?? null;
}

function zoneDeviceCount(zone: ZoneLike): number {
  return zone.device_count ?? zone.deviceCount ?? 0;
}

// Combines the rail's scope selection and filter fields into the
// EntryListFilters the shipped `/api/journal/entries` (and export) routes
// accept, so the entry table's active scope is exactly what the rail shows.
//
// Station and group scope span multiple plots, but the edge API only accepts
// a single plot_uuid/zone_uuid filter (osi-journal/api.js
// `normalizeEntryFilters`) — there is no multi-plot filter to send without
// inventing a new endpoint. Narrowing the entry list to a station's or
// group's plots is left unfiltered here as a known, deliberate gap; only
// single-plot scope narrows the query.
function toEntryListFilters(scope: ScopeSelection, filters: ScopeRailFilters): EntryListFilters {
  const result: EntryListFilters = { status: filters.status };
  if (scope.kind === 'plot') result.plot_uuid = scope.plotUuid;
  if (filters.activityCode) result.activity_code = filters.activityCode;
  if (filters.occurredFrom) result.occurred_from = filters.occurredFrom;
  if (filters.occurredTo) result.occurred_to = filters.occurredTo;
  if (filters.campaignUuid) result.campaign_uuid = filters.campaignUuid;
  if (filters.protocolCode) result.protocol_code = filters.protocolCode;
  return result;
}

function savedEntryUuid(receipt: JournalSavedReceipt): string | null {
  if ('entry_uuid' in receipt) return receipt.entry_uuid;
  // A batch receipt covers several plots at once; there's no single "the"
  // entry to open, so land on the first member as a reasonable default
  // rather than guessing further or leaving nothing selected.
  return receipt.entries[0]?.entry_uuid ?? null;
}

function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      [
        'button:not([disabled])',
        '[href]',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])',
      ].join(', '),
    ),
  ).filter(
    (element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true',
  );
}

interface CaptureModalProps {
  accessibleName: string;
  onRequestClose: () => void;
  children: ReactNode;
}

// A generic, self-contained role="dialog" overlay: backdrop, Escape-to-close,
// initial focus into the dialog, and a Tab focus trap. Deliberately renders
// no header/title chrome of its own — JournalCaptureFlow already renders its
// own heading (which self-focuses on mount) and its own "Close" button, so
// this wrapper only needs to supply the modal semantics around it.
function CaptureModal({ accessibleName, onRequestClose, children }: CaptureModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onRequestCloseRef = useRef(onRequestClose);

  useEffect(() => {
    onRequestCloseRef.current = onRequestClose;
  }, [onRequestClose]);

  useEffect(() => {
    // Runs after children have mounted (and, for the real JournalCaptureFlow,
    // after its own heading-focus effect), so this only steps in when focus
    // hasn't already landed inside the dialog.
    const node = dialogRef.current;
    if (node && !node.contains(document.activeElement)) {
      const focusable = getFocusableElements(node);
      (focusable[0] ?? node).focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        // Known limitation: this force-closes the whole flow even while
        // JournalCaptureFlow is mid-finalize (its own closeLocked) or
        // showing a nested sub-view (plot editor, layout-transition review
        // sheet), where Escape arguably should dismiss just the sub-view.
        // This wrapper has no visibility into the flow's internal state
        // without reaching into its internals, so it isn't handled here.
        onRequestCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = getFocusableElements(dialogRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const activeElement = document.activeElement as HTMLElement | null;
      const currentIndex = activeElement ? focusable.indexOf(activeElement) : -1;
      const lastIndex = focusable.length - 1;
      let nextIndex = currentIndex;

      if (event.shiftKey) {
        nextIndex = currentIndex <= 0 ? lastIndex : currentIndex - 1;
      } else {
        nextIndex = currentIndex === -1 || currentIndex >= lastIndex ? 0 : currentIndex + 1;
      }

      if (nextIndex !== currentIndex) {
        event.preventDefault();
        focusable[nextIndex]?.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4"
      onClick={() => onRequestClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={accessibleName}
        tabIndex={-1}
        className="my-8 max-h-[calc(100vh-4rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function JournalWorkspace({
  plots,
  activeGroups,
  zones,
  activities,
  catalog,
  plotGroups,
  recentEntries,
  initialTimezone,
  zoneCrops,
  zoneTimezones,
  plotState,
  groupState,
}: JournalWorkspaceProps) {
  const { t } = useTranslation('journal');
  const [scope, setScope] = useState<ScopeSelection>({ kind: 'all' });
  const [filters, setFilters] = useState<ScopeRailFilters>(DEFAULT_SCOPE_RAIL_FILTERS);
  const [search, setSearch] = useState('');
  const [selectedEntryUuid, setSelectedEntryUuid] = useState<string | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const logActivityButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasCaptureOpenRef = useRef(false);

  // The focus-return seam: EntryTable (Task 29) renders each row with a
  // stable `entry-row-<uuid>` testid/DOM node it also uses for its own
  // roving tabIndex. DetailPanel has no ref into EntryTable's internals, so
  // it asks the workspace to hand focus back to the row it came from after a
  // correction/void is saved or cancelled, rather than losing focus into the
  // document body.
  const focusSelectedRow = useCallback(() => {
    if (!selectedEntryUuid) return;
    document
      .querySelector<HTMLElement>(`[data-testid="entry-row-${selectedEntryUuid}"]`)
      ?.focus();
  }, [selectedEntryUuid]);

  const sensorCountByZoneUuid = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const zone of zones) {
      const uuid = zoneUuidOf(zone);
      if (uuid) counts[uuid] = zoneDeviceCount(zone);
    }
    return counts;
  }, [zones]);

  const entryListFilters = useMemo(
    () => toEntryListFilters(scope, filters),
    [scope, filters],
  );

  // Station and group scope cannot be sent to the shipped single-plot_uuid
  // API (see toEntryListFilters above), so the list and every export are
  // silently unfiltered for those two scopes. Surface that honestly instead
  // of leaving it as an undisclosed gap.
  const scopeNotNarrowed = scope.kind === 'station' || scope.kind === 'group';

  // Own the post-save refresh. EntryTable manages its own paginated
  // useJournalEntries call internally; this instance mirrors its unpaginated
  // (first-page, no cursor) query exactly — same filters, same PAGE_SIZE —
  // so calling retry() after a save revalidates the same SWR cache entry
  // EntryTable reads from when the user is on page 1, which is the common
  // desktop case (save while looking at the table, see the new entry appear).
  // A page 2+ view isn't invalidated by this; a known, accepted gap, the same
  // shape as the scopeNotNarrowed gap documented above.
  const { retry: retryEntries } = useJournalEntries({ ...entryListFilters, limit: PAGE_SIZE }, true);

  useEffect(() => {
    if (wasCaptureOpenRef.current && !captureOpen) {
      logActivityButtonRef.current?.focus();
    }
    wasCaptureOpenRef.current = captureOpen;
  }, [captureOpen]);

  const openCapture = useCallback(() => setCaptureOpen(true), []);
  // Wired to every "plain" dismiss path — the modal's own Escape/backdrop
  // handling, and JournalCaptureFlow's onClose (fired by its close() after
  // onSaved, or directly when there's nothing to save). A saved entry only
  // reaches the server once the flow shows its success state; the flow only
  // fires onSaved from its own in-body Close button, so Escape/backdrop must
  // refresh here or a finalized entry silently won't appear in the table. A
  // double retry when onSaved's own retry already ran is harmless (SWR
  // mutate is idempotent).
  //
  // P2-d: also revalidate the drafts queue's own independent SWR cache here.
  // The capture flow autosaves a draft well before this fires (see
  // useCaptureDraft's saveDraft), so leaving early without finalizing — the
  // exact path that reaches this handler — is exactly when a fresh draft
  // needs to show up in "Needs completion" without a page reload.
  //
  // B1 (Slice D hardening pre-deploy review): also revalidate the plots
  // cache (`journal:plots`, plotState.revalidate). A save that changed a
  // crop cycle (seeding/harvest/reseed/manual-close) writes an entry AND
  // opens/closes a cycle server-side, but active_crop_cycles is only ever
  // refreshed by re-fetching plots — without this, the Where-step's
  // crop-required gate and the inherited-crop banner keep reading the
  // pre-save snapshot for the rest of the session, same-session, until a
  // full page reload.
  const closeCapture = useCallback(() => {
    setCaptureOpen(false);
    void retryEntries();
    void refreshDraftsQueue();
    void plotState.revalidate();
  }, [plotState, retryEntries]);

  // Also revalidates the drafts queue: finalizing turns a draft final, which
  // must make it disappear from "Needs completion" just as promptly as a new
  // draft must appear there (see closeCapture above). Also revalidates plots
  // (see closeCapture's B1 comment) — a save is exactly the case a
  // cycle-changing entry needs the plots cache refreshed.
  const handleCaptureSaved = useCallback(async (receipt: JournalSavedReceipt) => {
    await retryEntries();
    void refreshDraftsQueue();
    void plotState.revalidate();
    setCaptureOpen(false);
    const entryUuid = savedEntryUuid(receipt);
    if (entryUuid) setSelectedEntryUuid(entryUuid);
  }, [plotState, retryEntries]);

  const handleCaptureOpenExisting = useCallback((entryUuid: string) => {
    setCaptureOpen(false);
    setSelectedEntryUuid(entryUuid);
  }, []);

  const logActivityButton = (
    <button
      ref={logActivityButtonRef}
      type="button"
      className="btn-liquid rounded-lg px-4 py-2 text-sm font-bold"
      onClick={openCapture}
    >
      {t('logActivity')}
    </button>
  );

  return (
    <div className="mx-auto grid w-full max-w-[1600px] grid-cols-1 gap-4 px-4 py-6 lg:grid-cols-[320px_1fr_360px]">
      <div className="flex flex-col gap-4">
        <ScopeRail
          plots={plots}
          activeGroups={activeGroups}
          activities={activities}
          sensorCountByZoneUuid={sensorCountByZoneUuid}
          scope={scope}
          onScopeChange={setScope}
          filters={filters}
          onFiltersChange={setFilters}
          search={search}
          onSearchChange={setSearch}
        />
        <DraftsQueue />
      </div>

      <div className="flex h-full min-h-0 flex-col gap-2">
        {scopeNotNarrowed && (
          <p className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--text-secondary)]">
            {t('workspace.table.scopeNotNarrowed')}
          </p>
        )}
        <div className="min-h-0 flex-1">
          <EntryTable
            filters={entryListFilters}
            plots={plots}
            selectedEntryUuid={selectedEntryUuid}
            onSelectEntry={setSelectedEntryUuid}
            headerStart={logActivityButton}
          />
        </div>
      </div>

      <DetailPanel
        catalog={catalog}
        plots={plots}
        selectedEntryUuid={selectedEntryUuid}
        onFocusReturn={focusSelectedRow}
      />

      {captureOpen && (
        <CaptureModal accessibleName={t('capture.title')} onRequestClose={closeCapture}>
          <JournalCaptureFlow
            catalog={catalog}
            // JournalCaptureFlow reads (find/map/filter) but never mutates
            // plots; JournalWorkspace's own `plots` prop is readonly (shared
            // with ScopeRail/EntryTable/DetailPanel), so this is a type-only
            // widening, not a behavior change.
            plots={plots as JournalPlot[]}
            plotGroups={plotGroups}
            recentEntries={recentEntries}
            initialTimezone={initialTimezone}
            zoneCrops={zoneCrops}
            zoneTimezones={zoneTimezones}
            plotState={plotState}
            groupState={groupState}
            onClose={closeCapture}
            onOpenExisting={handleCaptureOpenExisting}
            onSaved={handleCaptureSaved}
          />
        </CaptureModal>
      )}
    </div>
  );
}
