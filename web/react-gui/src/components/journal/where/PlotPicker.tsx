import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { parseStationRange, type RangeParseFailure } from '../../../journal/rangeSelection';
import { deriveStationModel, type StationModel } from '../../../journal/stationModel';
import type {
  JournalPlot,
  JournalPlotGroupWritePayload,
  PlotGroup,
} from '../../../types/journal';
import { PlotGroupChips } from './PlotGroupChips';
import { StationGrid } from './StationGrid';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]';
const TOUCH_CONTROL = 'min-h-[56px]';

export interface PlotSelection {
  plotUuids: string[];
  layoutCode: string | null;
  isMultiPlot: boolean;
}

export interface PlotPickerProps {
  plots: readonly JournalPlot[];
  activeGroups: readonly PlotGroup[];
  resolvedGroups: readonly PlotGroup[];
  allowNoPlot: boolean;
  maxPlots?: 100;
  value: PlotSelection;
  onChange: (selection: PlotSelection) => void;
  onCreateGroup: (payload: JournalPlotGroupWritePayload) => Promise<PlotGroup>;
  onUpdateGroup: (groupUuid: string, payload: JournalPlotGroupWritePayload) => Promise<PlotGroup>;
}

interface ErrorData {
  error: string;
  message: string;
  details: unknown;
}

interface GroupEditor {
  mode: 'create' | 'edit';
  group?: PlotGroup;
  groupUuid: string;
  label: string;
}

function errorData(error: unknown): ErrorData | null {
  if (typeof error !== 'object' || error === null) return null;
  const response = (error as { response?: unknown }).response;
  if (typeof response !== 'object' || response === null) return null;
  const data = (response as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const candidate = data as Partial<ErrorData>;
  if (typeof candidate.error !== 'string' || typeof candidate.message !== 'string') return null;
  return {
    error: candidate.error,
    message: candidate.message,
    details: 'details' in candidate ? candidate.details : null,
  };
}

function domainError(data: ErrorData): { response: { data: ErrorData } } {
  return { response: { data } };
}

function ErrorAlert({ error, fallback }: { error: unknown; fallback: string }) {
  const data = errorData(error);
  const message = data?.message ?? (error instanceof Error ? error.message : fallback);

  return (
    <div role="alert" className="min-w-0 whitespace-pre-wrap break-words rounded-xl bg-[var(--error-bg)] px-3 py-2 text-sm font-semibold text-[var(--error-text)]">
      {data ? (
        <>
          <strong>{data.error}</strong>
          <span>{`: ${message}`}</span>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs">{JSON.stringify(data)}</pre>
        </>
      ) : message}
    </div>
  );
}

function humanPlotLabel(plot: JournalPlot): string {
  return plot.name?.trim() || plot.plot_code;
}

function PlotOptionList({
  plots,
  selectedPlotUuids,
  onTogglePlot,
}: {
  plots: readonly JournalPlot[];
  selectedPlotUuids: ReadonlySet<string>;
  onTogglePlot: (plotUuid: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {plots.map((plot) => (
        <button
          key={plot.plot_uuid}
          type="button"
          aria-pressed={selectedPlotUuids.has(plot.plot_uuid)}
          onClick={() => onTogglePlot(plot.plot_uuid)}
          className={`rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold text-[var(--text)] hover:border-[var(--primary)] ${TOUCH_CONTROL} ${FOCUS_RING} ${selectedPlotUuids.has(plot.plot_uuid) ? 'bg-[var(--secondary-bg)]' : 'bg-[var(--surface)]'}`}
        >
          {humanPlotLabel(plot)}
        </button>
      ))}
    </div>
  );
}

export function PlotPicker({
  plots,
  activeGroups,
  resolvedGroups,
  allowNoPlot,
  maxPlots = 100,
  value,
  onChange,
  onCreateGroup,
  onUpdateGroup,
}: PlotPickerProps) {
  const { t } = useTranslation('journal');
  const [rangeText, setRangeText] = useState<Record<string, string>>({});
  const [rangeErrors, setRangeErrors] = useState<Record<string, RangeParseFailure | null>>({});
  const [pickerError, setPickerError] = useState<unknown | null>(null);
  const [groupEditor, setGroupEditor] = useState<GroupEditor | null>(null);
  const [groupPending, setGroupPending] = useState(false);
  const groupPendingRef = useRef(false);

  const activePlotByUuid = new Map(
    plots
      .filter((plot) => plot.active === 1 && plot.deleted_at === null)
      .map((plot) => [plot.plot_uuid, plot]),
  );
  const visiblePlots = [...activePlotByUuid.values()];
  const suppliedPlotUuids = [...new Set(value.plotUuids)];
  const validSelectedPlotUuids = suppliedPlotUuids
    .filter((plotUuid) => activePlotByUuid.has(plotUuid))
    .sort();
  const staleSelectedPlotUuids = suppliedPlotUuids.filter((plotUuid) => !activePlotByUuid.has(plotUuid));
  const selectedPlotUuids = new Set(validSelectedPlotUuids);
  const resolvedGroupIds = new Set(resolvedGroups.map((group) => group.group_uuid));
  const pickerGroups = activeGroups.filter((group) =>
    group.deleted_at === null
      && group.resolved_at === null
      && !resolvedGroupIds.has(group.group_uuid),
  );
  const stationCodes = [...new Set(
    visiblePlots
      .map((plot) => plot.station_code)
      .filter((stationCode): stationCode is string => stationCode !== null),
  )].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const stationModels = stationCodes.map((stationCode) => ({
    stationCode,
    model: deriveStationModel(stationCode, visiblePlots),
  }));
  const unstationedPlots = visiblePlots.filter((plot) => plot.station_code === null);

  const setRange = (stationCode: string, nextValue: string) => {
    setRangeText((current) => ({ ...current, [stationCode]: nextValue }));
    setRangeErrors((current) => ({ ...current, [stationCode]: null }));
  };

  const commitSelection = (candidate: readonly string[]): boolean => {
    const plotUuids = [...new Set(candidate)].sort();
    if (plotUuids.some((plotUuid) => !activePlotByUuid.has(plotUuid))) {
      setPickerError(domainError({
        error: 'stale_plot_membership',
        message: t('where.staleSelection', {
          defaultValue: 'Some selected plots are no longer available. Choose an active plot to update the selection.',
        }),
        details: null,
      }));
      return false;
    }

    if (plotUuids.length > maxPlots) {
      setPickerError(domainError({
        error: 'batch_too_large',
        message: t('where.maxPlotsError', {
          count: maxPlots,
          defaultValue: 'Select no more than {{count}} plots.',
        }),
        details: null,
      }));
      return false;
    }

    const layouts = [...new Set(plotUuids.map(
      (plotUuid) => activePlotByUuid.get(plotUuid)?.settings.layout_code,
    ))];
    if (layouts.length > 1) {
      setPickerError(domainError({
        error: 'heterogeneous_group',
        message: t('where.mixedLayout', { defaultValue: 'Selected plots use different layouts.' }),
        details: null,
      }));
      return false;
    }

    setPickerError(null);
    onChange({
      plotUuids,
      layoutCode: layouts[0] ?? null,
      isMultiPlot: plotUuids.length > 1,
    });
    return true;
  };

  const togglePlot = (plotUuid: string) => {
    const candidate = new Set(validSelectedPlotUuids);
    if (candidate.has(plotUuid)) candidate.delete(plotUuid);
    else candidate.add(plotUuid);
    commitSelection([...candidate]);
  };

  const selectGroup = (group: PlotGroup) => {
    if (group.members.some((plotUuid) => !activePlotByUuid.has(plotUuid))) {
      commitSelection([...validSelectedPlotUuids, ...group.members]);
      return;
    }

    const candidate = new Set(validSelectedPlotUuids);
    const allSelected = group.members.length > 0
      && group.members.every((plotUuid) => candidate.has(plotUuid));
    for (const plotUuid of group.members) {
      if (allSelected) candidate.delete(plotUuid);
      else candidate.add(plotUuid);
    }
    commitSelection([...candidate]);
  };

  const stationPlotIds = (model: StationModel): Set<string> => new Set([
    ...model.gridPlots.map(({ plot }) => plot.plot_uuid),
    ...model.namedFallbackPlots.map((plot) => plot.plot_uuid),
  ]);

  const selectAll = (model: StationModel) => {
    const ids = stationPlotIds(model);
    commitSelection([...validSelectedPlotUuids.filter((plotUuid) => !ids.has(plotUuid)), ...ids]);
  };

  const invert = (model: StationModel) => {
    const ids = stationPlotIds(model);
    const candidate = validSelectedPlotUuids.filter((plotUuid) => !ids.has(plotUuid));
    for (const plotUuid of ids) {
      if (!selectedPlotUuids.has(plotUuid)) candidate.push(plotUuid);
    }
    commitSelection(candidate);
  };

  const applyRange = (stationCode: string, model: StationModel) => {
    const result = parseStationRange(
      rangeText[stationCode] ?? '',
      new Set(model.gridPlots.map(({ sourceNumber }) => sourceNumber)),
    );
    if (!result.ok) {
      setRangeErrors((current) => ({ ...current, [stationCode]: result }));
      return;
    }

    setRangeErrors((current) => ({ ...current, [stationCode]: null }));
    const numericIds = new Set(model.gridPlots.map(({ plot }) => plot.plot_uuid));
    const selectedNumbers = new Set(result.values);
    const candidate = validSelectedPlotUuids.filter((plotUuid) => !numericIds.has(plotUuid));
    for (const { plot, sourceNumber } of model.gridPlots) {
      if (selectedNumbers.has(sourceNumber)) candidate.push(plot.plot_uuid);
    }
    commitSelection(candidate);
  };

  const saveGroup = async () => {
    if (groupEditor === null || groupEditor.label.trim() === '' || groupPendingRef.current) return;
    groupPendingRef.current = true;
    setGroupPending(true);
    const members = (groupEditor.mode === 'create'
      ? validSelectedPlotUuids
      : groupEditor.group?.members ?? []).slice().sort();
    const payload: JournalPlotGroupWritePayload = {
      group_uuid: groupEditor.groupUuid,
      base_sync_version: groupEditor.mode === 'create'
        ? 0
        : groupEditor.group?.sync_version ?? 0,
      label: groupEditor.label.trim(),
      members,
      resolved: groupEditor.mode === 'edit' && groupEditor.group?.resolved_at !== null,
    };

    try {
      if (groupEditor.mode === 'create') await onCreateGroup(payload);
      else await onUpdateGroup(payload.group_uuid, payload);
      setGroupEditor(null);
      setPickerError(null);
    } catch (error) {
      setPickerError(error);
    } finally {
      groupPendingRef.current = false;
      setGroupPending(false);
    }
  };

  const selectionCount = t('where.selectionCount', {
    count: validSelectedPlotUuids.length,
    defaultValue: '{{count}} plots selected',
  });

  return (
    <section className="w-full min-w-0 space-y-4" aria-label={t('where.station', { defaultValue: 'Station' })}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-semibold text-[var(--text-secondary)]">{selectionCount}</p>
        {allowNoPlot && (
          <button
            type="button"
            aria-pressed={validSelectedPlotUuids.length === 0}
            onClick={() => commitSelection([])}
            className={`rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2 font-bold text-[var(--text)] hover:border-[var(--primary)] ${TOUCH_CONTROL} ${FOCUS_RING}`}
          >
            {t('where.noPlot', { defaultValue: 'No plot' })}
          </button>
        )}
      </div>

      <PlotGroupChips
        groups={pickerGroups}
        plots={visiblePlots}
        selectedPlotUuids={selectedPlotUuids}
        onSelectGroup={selectGroup}
        onTogglePlot={togglePlot}
        disabled={groupPending}
        onEditGroup={(group) => {
          setPickerError(null);
          setGroupEditor({ mode: 'edit', group, groupUuid: group.group_uuid, label: group.label });
        }}
      />

      {staleSelectedPlotUuids.length > 0 && (
        <div role="alert" className="rounded-xl bg-[var(--error-bg)] px-3 py-2 text-sm font-semibold text-[var(--error-text)]">
          {t('where.staleSelection', {
            defaultValue: 'Some selected plots are no longer available. Choose an active plot to update the selection.',
          })}
        </div>
      )}

      {pickerError !== null && (
        <ErrorAlert
          error={pickerError}
          fallback={t('group.error', { defaultValue: 'Could not save the plot group.' })}
        />
      )}

      <div className="w-full min-w-0 space-y-3">
        {stationModels.map(({ stationCode, model }) => (
          <StationGrid
            key={stationCode}
            stationCode={stationCode}
            stationLabel={stationCode}
            plots={model.gridPlots}
            namedFallbackPlots={model.namedFallbackPlots}
            selectedPlotUuids={selectedPlotUuids}
            rangeText={rangeText[stationCode] ?? ''}
            rangeError={rangeErrors[stationCode] ?? null}
            onTogglePlot={togglePlot}
            onSelectAll={() => selectAll(model)}
            onInvert={() => invert(model)}
            onRangeTextChange={(nextValue) => setRange(stationCode, nextValue)}
            onApplyRange={() => applyRange(stationCode, model)}
          />
        ))}

        {unstationedPlots.length > 0 && (
          <section className="w-full min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4" aria-label={t('where.unstationed', { defaultValue: 'Unstationed plots' })}>
            <h2 className="mb-3 text-base font-bold text-[var(--text)]">
              {t('where.unstationed', { defaultValue: 'Unstationed plots' })}
            </h2>
            <PlotOptionList
              plots={unstationedPlots}
              selectedPlotUuids={selectedPlotUuids}
              onTogglePlot={togglePlot}
            />
          </section>
        )}
      </div>

      {validSelectedPlotUuids.length > 1 && groupEditor === null && (
        <button
          type="button"
          onClick={() => {
            setPickerError(null);
            setGroupEditor({ mode: 'create', groupUuid: crypto.randomUUID(), label: '' });
          }}
          className={`rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2 font-bold text-[var(--text)] hover:border-[var(--primary)] ${TOUCH_CONTROL} ${FOCUS_RING}`}
        >
          {t('where.createGroup', { defaultValue: 'Create group' })}
        </button>
      )}

      {groupEditor !== null && (
        <form
          className="w-full min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void saveGroup();
          }}
        >
          <label htmlFor="journal-group-label" className="mb-2 block text-sm font-bold text-[var(--text)]">
            {t('where.groupLabel', { defaultValue: 'Group label' })}
          </label>
          <input
            id="journal-group-label"
            type="text"
            value={groupEditor.label}
            disabled={groupPending}
            onChange={(event) => setGroupEditor({ ...groupEditor, label: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            className={`w-full ${TOUCH_CONTROL} rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] outline-none ${FOCUS_RING}`}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={groupPending || groupEditor.label.trim() === ''}
              className={`rounded-xl bg-[var(--primary)] px-4 py-2 font-bold text-white hover:opacity-90 ${TOUCH_CONTROL} ${FOCUS_RING}`}
            >
              {t('where.saveGroup', { defaultValue: 'Save group' })}
            </button>
            <button
              type="button"
              disabled={groupPending}
              onClick={() => setGroupEditor(null)}
              className={`rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2 font-bold text-[var(--text)] hover:border-[var(--primary)] ${TOUCH_CONTROL} ${FOCUS_RING}`}
            >
              {t('where.cancel', { defaultValue: 'Cancel' })}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
