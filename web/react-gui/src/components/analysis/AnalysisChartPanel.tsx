import { lazy, Suspense, useCallback, useMemo, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnalysisPoint, AnalysisSeries, AnalysisWorkspaceMode, TimelineLayout } from '../../analysis/types';
import { groupByUnit } from '../../analysis/unitGrouping';
import { buildSmallMultiplesOption, buildTimeSeriesOption, formatPointNote } from '../../analysis/echartsOptions';
import type { ChannelMeta } from '../../analysis/channelLabels';
import type { EChartHandle } from './EChart';
import { CHART_SIZE_STEP, smallMultiplesColumns, type ChartViewport } from '../../analysis/chartGeometry';
import { useElementSize } from '../../hooks/useElementSize';
import { shouldAutoStack } from '../../analysis/axisBands';

const EChart = lazy(() => import('./EChart').then((module) => ({ default: module.EChart })));
const CorrelationPanel = lazy(() => import('./CorrelationPanel').then((module) => ({ default: module.CorrelationPanel })));

type AnalysisTranslate = (key: string, options?: Record<string, unknown>) => string;

interface AnalysisChartPanelProps {
  series: AnalysisSeries[];
  mode: AnalysisWorkspaceMode;
  layout: TimelineLayout;
  toggles: { normalize: boolean };
  channelMeta: ChannelMeta;
  zoneNameById?: Map<number, string>;
  chartRef?: Ref<EChartHandle>;
  resolveAxisLabel?: (channelKey: string, unit: string | null) => string;
  onAxisRename?: (channelKey: string, label: string | null) => void;
}

const SINGLE_PANEL_MIN = 360;
const STACKED_PANEL_MIN = 240;
const SMALL_MULTIPLE_CELL_MIN = 220;

export function chartMinHeight(layout: TimelineLayout, panelCount: number, width?: number): number {
  const count = Math.max(1, panelCount);
  if (layout === 'small-multiples') {
    const columns = smallMultiplesColumns(count, width);
    const rows = Math.ceil(count / columns);
    return rows * SMALL_MULTIPLE_CELL_MIN;
  }
  if (layout === 'stacked' && count > 1) {
    return count * STACKED_PANEL_MIN;
  }
  return SINGLE_PANEL_MIN;
}

export function AnalysisChartPanel({ series, mode, layout, toggles, channelMeta, zoneNameById, chartRef, resolveAxisLabel, onAxisRename }: AnalysisChartPanelProps) {
  const { t: translate } = useTranslation();
  const t = translate as AnalysisTranslate;
  const [editing, setEditing] = useState<{ channelKey: string; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [frameRef, frameSize] = useElementSize<HTMLDivElement>({ step: CHART_SIZE_STEP });
  const viewport: ChartViewport | undefined = frameSize ?? undefined;
  // Session-only: never written to the saved view (this panel cannot write it).
  const [showOverlaidAnyway, setShowOverlaidAnyway] = useState(false);

  const commitAxis = () => {
    if (!editing) return;
    const v = draft.trim();
    onAxisRename?.(editing.channelKey, v.length ? v : null);
    setEditing(null);
  };

  // A summed weather bucket with missing rows: " (23 of 24 h)", or days for
  // a weekly bucket of daily agronomy; a rain amount: " · 2 reports received".
  const formatPartial = useCallback(
    (point: AnalysisPoint, item: AnalysisSeries) => formatPointNote(point, item, t),
    [t],
  );

  const timeSeriesPanels = useMemo(() => {
    if (series.length === 0 || mode === 'correlation' || layout === 'small-multiples') return [];
    return groupByUnit(series);
  }, [mode, layout, series]);

  // An overlaid chart whose unit axes crowd out the plot renders stacked.
  const autoStacked = useMemo(() => mode !== 'correlation' && shouldAutoStack({
    layout,
    normalize: toggles.normalize,
    panels: timeSeriesPanels,
    series,
    width: viewport?.width,
  }), [mode, layout, toggles.normalize, timeSeriesPanels, series, viewport?.width]);
  const effectiveLayout: TimelineLayout = autoStacked && !showOverlaidAnyway ? 'stacked' : layout;

  const option = useMemo(() => {
    if (series.length === 0 || mode === 'correlation') return null;
    if (effectiveLayout === 'small-multiples') return buildSmallMultiplesOption(series, toggles.normalize, resolveAxisLabel, formatPartial, viewport);
    return buildTimeSeriesOption({
      panels: timeSeriesPanels,
      series,
      normalize: toggles.normalize,
      multiAxis: effectiveLayout === 'overlaid',
      resolveAxisLabel,
      formatPartial,
      viewport,
    });
  }, [series, mode, effectiveLayout, toggles.normalize, timeSeriesPanels, resolveAxisLabel, formatPartial, viewport]);

  const exportOption = useMemo(() => {
    if (series.length === 0 || mode === 'correlation' || effectiveLayout === 'small-multiples') return undefined;
    return buildTimeSeriesOption({
      panels: timeSeriesPanels,
      series,
      normalize: toggles.normalize,
      multiAxis: effectiveLayout === 'overlaid',
      includeLegend: true,
      resolveAxisLabel,
      formatPartial,
      // The export renders off-screen at the live chart's width and at least 320 px tall.
      viewport: viewport ? { width: viewport.width, height: Math.max(320, viewport.height) } : undefined,
    });
  }, [series, mode, effectiveLayout, toggles.normalize, timeSeriesPanels, resolveAxisLabel, formatPartial, viewport]);

  const heightPanelCount = effectiveLayout === 'small-multiples'
    ? series.length
    : effectiveLayout === 'stacked'
      ? timeSeriesPanels.length
      : 1;
  const minHeight = chartMinHeight(effectiveLayout, heightPanelCount, viewport?.width);

  if (series.length === 0) return <div className="analysis-empty">{t('analysis.empty')}</div>;
  if (mode === 'correlation') return (
    <Suspense fallback={<div className="analysis-loading">{t('loading')}</div>}>
      <CorrelationPanel series={series} channelMeta={channelMeta} zoneNameById={zoneNameById} chartRef={chartRef} />
    </Suspense>
  );
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {autoStacked && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs text-[var(--text-secondary)]">
          {!showOverlaidAnyway && <p role="status" className="min-w-0">{t('analysis.autoStack.note')}</p>}
          <button
            type="button"
            aria-pressed={showOverlaidAnyway}
            onClick={() => setShowOverlaidAnyway((value) => !value)}
            className={`shrink-0 rounded border px-2 py-0.5 font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${
              showOverlaidAnyway
                ? 'border-[var(--text-secondary)] bg-[var(--secondary-bg)] text-[var(--text)]'
                : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:bg-[var(--secondary-bg)]'
            }`}
          >
            {t('analysis.autoStack.showOverlaid')}
          </button>
        </div>
      )}
      <div
        ref={frameRef}
        data-testid="analysis-chart-frame"
        data-requested-layout={layout}
        data-effective-layout={effectiveLayout}
        className="analysis-chart-frame min-h-0 flex-1"
        style={{ minHeight, position: 'relative' }}
      >
        <Suspense fallback={<div className="analysis-loading">{t('loading')}</div>}>
          <EChart
            ref={chartRef}
            option={option as Record<string, unknown>}
            exportOption={exportOption as Record<string, unknown> | undefined}
            className="analysis-chart h-full"
            onAxisNameClick={(channelKey, pos) => { setEditing({ channelKey, ...pos }); setDraft(''); }}
          />
        </Suspense>
        {editing && (
          <input
            autoFocus
            aria-label={t('analysis.axis.rename')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commitAxis()}
            onKeyDown={(e) => { if (e.key==='Enter') commitAxis(); if (e.key==='Escape') setEditing(null); }}
            className="absolute z-10 w-48 rounded border border-[var(--border)] bg-[var(--surface)] px-1 py-0.5 text-xs text-[var(--text)]"
            // Keep the 12rem field inside the frame when the clicked title is a right-hand axis.
            style={{ left: viewport ? Math.max(0, Math.min(editing.x, viewport.width - 196)) : editing.x, top: editing.y }}
          />
        )}
      </div>
    </div>
  );
}
