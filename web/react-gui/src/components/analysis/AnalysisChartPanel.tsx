import { useMemo, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnalysisSeries, AnalysisWorkspaceMode, TimelineLayout } from '../../analysis/types';
import { groupByUnit } from '../../analysis/unitGrouping';
import { buildSmallMultiplesOption, buildTimeSeriesOption } from '../../analysis/echartsOptions';
import type { ChannelMeta } from '../../analysis/channelLabels';
import { EChart, type EChartHandle } from './EChart';
import { CorrelationPanel } from './CorrelationPanel';

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

export function chartMinHeight(layout: TimelineLayout, panelCount: number): number {
  const count = Math.max(1, panelCount);
  if (layout === 'small-multiples') {
    const columns = Math.ceil(Math.sqrt(count));
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

  const commitAxis = () => {
    if (!editing) return;
    const v = draft.trim();
    onAxisRename?.(editing.channelKey, v.length ? v : null);
    setEditing(null);
  };

  const timeSeriesPanels = useMemo(() => {
    if (series.length === 0 || mode === 'correlation' || layout === 'small-multiples') return [];
    return groupByUnit(series);
  }, [mode, layout, series]);

  const option = useMemo(() => {
    if (series.length === 0 || mode === 'correlation') return null;
    if (layout === 'small-multiples') return buildSmallMultiplesOption(series, toggles.normalize, resolveAxisLabel);
    return buildTimeSeriesOption({
      panels: timeSeriesPanels,
      series,
      normalize: toggles.normalize,
      multiAxis: layout === 'overlaid',
      resolveAxisLabel,
    });
  }, [series, mode, layout, toggles.normalize, timeSeriesPanels, resolveAxisLabel]);

  const exportOption = useMemo(() => {
    if (series.length === 0 || mode === 'correlation' || layout === 'small-multiples') return undefined;
    return buildTimeSeriesOption({
      panels: timeSeriesPanels,
      series,
      normalize: toggles.normalize,
      multiAxis: layout === 'overlaid',
      includeLegend: true,
      resolveAxisLabel,
    });
  }, [series, mode, layout, toggles.normalize, timeSeriesPanels, resolveAxisLabel]);

  const heightPanelCount = layout === 'small-multiples'
    ? series.length
    : layout === 'stacked'
      ? timeSeriesPanels.length
      : 1;
  const minHeight = chartMinHeight(layout, heightPanelCount);

  if (series.length === 0) return <div className="analysis-empty">{t('analysis.empty')}</div>;
  if (mode === 'correlation') return <CorrelationPanel series={series} channelMeta={channelMeta} zoneNameById={zoneNameById} chartRef={chartRef} />;
  return (
    <div
      data-testid="analysis-chart-frame"
      className="analysis-chart-frame h-full"
      style={{ minHeight, position: 'relative' }}
    >
      <EChart
        ref={chartRef}
        option={option as Record<string, unknown>}
        exportOption={exportOption as Record<string, unknown> | undefined}
        className="analysis-chart h-full"
        onAxisNameClick={(channelKey, pos) => { setEditing({ channelKey, ...pos }); setDraft(''); }}
      />
      {editing && (
        <input
          autoFocus
          aria-label={t('analysis.axis.rename')}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commitAxis()}
          onKeyDown={(e) => { if (e.key==='Enter') commitAxis(); if (e.key==='Escape') setEditing(null); }}
          className="absolute z-10 w-48 rounded border border-[var(--border)] bg-[var(--surface)] px-1 py-0.5 text-xs text-[var(--text)]"
          style={{ left: editing.x, top: editing.y }}
        />
      )}
    </div>
  );
}
