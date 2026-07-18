import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { RangeParseFailure } from '../../../journal/rangeSelection';
import type { StationPlotPosition } from '../../../journal/stationModel';
import type { JournalPlot } from '../../../types/journal';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]';
const TOUCH_CONTROL = 'min-h-[56px]';

const RANGE_ERROR_KEYS: Record<RangeParseFailure['code'], string> = {
  empty: 'where.rangeEmpty',
  malformed: 'where.rangeMalformed',
  duplicate: 'where.rangeDuplicate',
  out_of_station: 'where.rangeOutOfStation',
  reversed: 'where.rangeReversed',
  non_integer: 'where.rangeNonInteger',
  non_positive: 'where.rangeNonPositive',
};
const RANGE_SUMMARY_DEFAULT = '{{label}} · {{plotCount}} · {{selectedCount}}';

export interface StationGridProps {
  stationCode: string;
  stationLabel: string;
  plots: readonly StationPlotPosition[];
  namedFallbackPlots: readonly JournalPlot[];
  selectedPlotUuids: ReadonlySet<string>;
  rangeText: string;
  rangeError: RangeParseFailure | null;
  onTogglePlot: (plotUuid: string) => void;
  onSelectAll: () => void;
  onInvert: () => void;
  onRangeTextChange: (value: string) => void;
  onApplyRange: () => void;
}

function humanPlotLabel(plot: JournalPlot): string {
  return plot.name?.trim() || plot.plot_code;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

export function StationGrid({
  stationCode,
  stationLabel,
  plots,
  namedFallbackPlots,
  selectedPlotUuids,
  rangeText,
  rangeError,
  onTogglePlot,
  onSelectAll,
  onInvert,
  onRangeTextChange,
  onApplyRange,
}: StationGridProps) {
  const { t } = useTranslation('journal');
  const [expanded, setExpanded] = useState(false);
  const generatedId = useId().replace(/:/g, '');
  const stationId = `station-grid-${safeId(stationCode)}-${generatedId}`;
  const rangeInputId = `${stationId}-range`;
  const rangeErrorId = `${rangeInputId}-error`;
  const totalCount = plots.length + namedFallbackPlots.length;
  const selectedCount = [...plots.map(({ plot }) => plot), ...namedFallbackPlots]
    .filter((plot) => selectedPlotUuids.has(plot.plot_uuid)).length;

  const plotCountLabel = t('where.rangePlotCount', {
    count: totalCount,
    defaultValue: totalCount === 1 ? '{{count}} plot' : '{{count}} plots',
  });
  const selectedCountLabel = t('where.rangeSelectedCount', {
    count: selectedCount,
    defaultValue: '{{count}} selected',
  });
  const summary = t('where.rangeSummary', {
    defaultValue: RANGE_SUMMARY_DEFAULT,
    label: stationLabel,
    count: totalCount,
    selected: selectedCount,
    plotCount: plotCountLabel,
    selectedCount: selectedCountLabel,
  });

  const toggleButton = (plotUuid: string, label: string, number?: number) => {
    const selected = selectedPlotUuids.has(plotUuid);

    return (
      <button
        key={plotUuid}
        type="button"
        aria-pressed={selected}
        onClick={() => onTogglePlot(plotUuid)}
        className={`flex ${TOUCH_CONTROL} min-w-0 flex-1 basis-36 flex-col items-start justify-center rounded-xl border px-3 py-2 text-left text-sm font-semibold transition-colors hover:border-[var(--primary)] ${
          selected
            ? 'border-[var(--primary)] bg-[var(--secondary-bg)] text-[var(--text)]'
            : 'border-[var(--border)] bg-[var(--card)] text-[var(--text)]'
        } ${FOCUS_RING}`}
      >
        <span className="flex min-w-0 max-w-full flex-col">
          {number != null && (
            <span className="text-xs font-bold text-[var(--text-secondary)]">{number}</span>
          )}
          {number != null && ' '}
          <span className="min-w-0 max-w-full truncate">{label}</span>
        </span>
      </button>
    );
  };

  const applyRange = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onApplyRange();
  };

  return (
    <details open={expanded} className="w-full rounded-2xl border border-[var(--border)] bg-[var(--card)]">
      <summary
        aria-controls={stationId}
        aria-expanded={expanded}
        onClick={(event) => {
          event.preventDefault();
          setExpanded((current) => !current);
        }}
        className={`flex ${TOUCH_CONTROL} w-full cursor-pointer list-none flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left text-[var(--text)] marker:hidden ${FOCUS_RING}`}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-bold">{stationLabel}</span>
          <span className="block text-sm text-[var(--text-secondary)]">{summary}</span>
        </span>
        <span aria-hidden="true" className="shrink-0 text-lg text-[var(--text-secondary)]">
          {expanded ? '−' : '+'}
        </span>
      </summary>

      {expanded && (
        <div id={stationId} className="space-y-4 border-t border-[var(--border)] p-4">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onSelectAll}
              className={`rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-bold text-[var(--text)] hover:border-[var(--primary)] ${TOUCH_CONTROL} ${FOCUS_RING}`}
            >
              {t('where.selectAll', { defaultValue: 'Select all' })}
            </button>
            <button
              type="button"
              onClick={onInvert}
              className={`rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-bold text-[var(--text)] hover:border-[var(--primary)] ${TOUCH_CONTROL} ${FOCUS_RING}`}
            >
              {t('where.invert', { defaultValue: 'Invert selection' })}
            </button>
          </div>

          <form onSubmit={applyRange} className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 basis-48">
              <label htmlFor={rangeInputId} className="mb-2 block text-sm font-bold text-[var(--text)]">
                {t('where.range', { defaultValue: 'Station range' })}
              </label>
              <input
                id={rangeInputId}
                type="text"
                inputMode="text"
                value={rangeText}
                aria-invalid={rangeError != null}
                aria-describedby={rangeError ? rangeErrorId : undefined}
                onChange={(event) => onRangeTextChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  onApplyRange();
                }}
                className={`w-full ${TOUCH_CONTROL} min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] outline-none ${FOCUS_RING}`}
              />
            </div>
            <button
              type="submit"
              className={`rounded-xl bg-[var(--primary)] px-4 py-2 font-bold text-white hover:opacity-90 ${TOUCH_CONTROL} ${FOCUS_RING}`}
            >
              {t('where.applyRange', { defaultValue: 'Apply range' })}
            </button>
          </form>

          {rangeError && (
            <p id={rangeErrorId} role="alert" className="min-w-0 whitespace-pre-wrap break-words rounded-xl bg-[var(--error-bg)] px-3 py-2 text-sm font-semibold text-[var(--error-text)]">
              {t(RANGE_ERROR_KEYS[rangeError.code], {
                defaultValue: 'The station range is invalid.',
              })}
              {' '}
              <code className="whitespace-pre-wrap break-all">{rangeError.code}: {rangeError.token || '∅'}</code>
            </p>
          )}

          <div role="group" aria-label={stationLabel} className="flex flex-wrap gap-2">
            {plots.map(({ plot, gridNumber }) => toggleButton(
              plot.plot_uuid,
              humanPlotLabel(plot),
              gridNumber,
            ))}
          </div>

          {namedFallbackPlots.length > 0 && (
            <div role="group" aria-label={t('where.namedPlots', { defaultValue: 'Named plots' })} className="space-y-2">
              <h3 className="text-sm font-bold text-[var(--text-secondary)]">
                {t('where.namedPlots', { defaultValue: 'Named plots' })}
              </h3>
              <div className="flex flex-wrap gap-2">
                {namedFallbackPlots.map((plot) => toggleButton(
                  plot.plot_uuid,
                  humanPlotLabel(plot),
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </details>
  );
}
