import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAnalysisCatalog } from '../analysis/useAnalysisCatalog';
import { useAnalysisSeries } from '../analysis/useAnalysisSeries';
import { useAnalysisViews } from '../analysis/useAnalysisViews';
import { axisQuantityLabel, channelMetaFromCatalog } from '../analysis/channelLabels';
import { applyLabelOverrides } from '../analysis/labelOverrides';
import { loadWorkspace, migrateWorkspaceSeriesIds, saveWorkspace } from '../analysis/analysisWorkspaceStorage';
import {
  addSeries,
  clearLabelOverride,
  clearAxisLabelOverride,
  createDefaultWorkspace,
  fromViewJson,
  removeSeries,
  setAxisLabelOverride,
  setLabelOverride,
  setLayout,
  setMode,
  setRange,
  setToggle,
  toViewJson,
  type AnalysisWorkspaceState,
} from '../analysis/workspaceModel';
import type { AnalysisRange, AnalysisSeriesRequest } from '../analysis/types';
import { canonicalize } from '../channels/registry';
import { AnalysisSeriesTray } from '../components/analysis/AnalysisSeriesTray';
import { AnalysisControls } from '../components/analysis/AnalysisControls';
import { AnalysisChartPanel } from '../components/analysis/AnalysisChartPanel';
import { AnalysisExportMenu } from '../components/analysis/AnalysisExportMenu';
import { AnalysisViewsMenu } from '../components/analysis/AnalysisViewsMenu';
import { AnalysisChartLegend } from '../components/analysis/AnalysisChartLegend';
import { MetricAcrossZonesPicker } from '../components/analysis/MetricAcrossZonesPicker';
import type { EChartHandle } from '../components/analysis/EChart';
import { useAuth } from '../contexts/AuthContext';

function toRequest(ws: AnalysisWorkspaceState): AnalysisSeriesRequest | null {
  if (ws.selectors.length === 0) return null;
  return { selectors: ws.selectors, range: ws.range, aggregation: 'auto' };
}

export function CrossZoneAnalysisPage() {
  const { t } = useTranslation();
  const { username } = useAuth();
  const [workspace, setWorkspace] = useState<AnalysisWorkspaceState>(() => loadWorkspace() ?? createDefaultWorkspace());
  const [viewSaveError, setViewSaveError] = useState<unknown>(null);
  const chartRef = useRef<EChartHandle>(null);
  const { catalog, isLoading: catalogLoading, error: catalogError } = useAnalysisCatalog();
  const { views, saveView, error: viewsError } = useAnalysisViews();

  const activeWorkspace = useMemo(
    () => (catalog ? migrateWorkspaceSeriesIds(workspace, catalog.channels) : workspace),
    [catalog, workspace],
  );

  useEffect(() => {
    if (activeWorkspace !== workspace) {
      setWorkspace(activeWorkspace);
    }
  }, [activeWorkspace, workspace]);

  useEffect(() => { saveWorkspace(activeWorkspace); }, [activeWorkspace]);

  const request = useMemo(
    () => (catalog ? toRequest(activeWorkspace) : null),
    [activeWorkspace, catalog],
  );
  const { data, isLoading: seriesLoading, error: seriesError } = useAnalysisSeries(request);
  const channelMeta = useMemo(() => channelMetaFromCatalog(catalog?.channels ?? []), [catalog]);
  const catalogById = useMemo(
    () => new Map((catalog?.channels ?? []).map((c) => [c.seriesId, c])),
    [catalog],
  );
  const zoneNameById = useMemo(
    () => new Map((catalog?.channels ?? []).map((c) => [c.zoneId, c.zoneName])),
    [catalog],
  );
  const displayedSeries = useMemo(
    () => applyLabelOverrides(data?.series ?? [], activeWorkspace.labelOverrides),
    [activeWorkspace.labelOverrides, data],
  );
  const updateWorkspace = (mutate: (workspace: AnalysisWorkspaceState) => AnalysisWorkspaceState) => {
    setWorkspace((currentWorkspace) => mutate(catalog ? migrateWorkspaceSeriesIds(currentWorkspace, catalog.channels) : currentWorkspace));
  };
  const saveCurrentView = async (name: string) => {
    setViewSaveError(null);
    try {
      await saveView({ name, viewJson: toViewJson(activeWorkspace), isDefault: false });
    } catch (error) {
      setViewSaveError(error);
    }
  };
  const loadView = (view: (typeof views)[number]) => {
    setViewSaveError(null);
    setWorkspace(
      catalog
        ? migrateWorkspaceSeriesIds(fromViewJson(view.viewJson), catalog.channels)
        : fromViewJson(view.viewJson),
    );
  };

  const selectedIds = activeWorkspace.selectors.map((s) => s.seriesId);
  const renameSeries = (seriesId: string, label: string | null) =>
    updateWorkspace((currentWorkspace) => (
      label === null
        ? clearLabelOverride(currentWorkspace, seriesId)
        : setLabelOverride(currentWorkspace, seriesId, label)
    ));
  const resolveAxisLabel = (channelKey: string, unit: string | null) =>
    activeWorkspace.axisLabelOverrides[canonicalize(channelKey)] ?? axisQuantityLabel(channelKey, unit);
  const renameAxis = (channelKey: string, label: string | null) =>
    updateWorkspace((currentWorkspace) => (
      label === null
        ? clearAxisLabelOverride(currentWorkspace, channelKey)
        : setAxisLabelOverride(currentWorkspace, channelKey, label)
    ));
  const applyMetricPreset = (channelKey: string) => {
    const canonicalChannelKey = canonicalize(channelKey);
    const selectors = (catalog?.channels ?? [])
      .filter((channel) => (
        channel.availability === 'available'
        && canonicalize(channel.channelKey) === canonicalChannelKey
      ))
      .map((channel) => ({ seriesId: channel.seriesId }));
    updateWorkspace((currentWorkspace) => ({ ...currentWorkspace, selectors }));
  };
  const aggregationLabel = (applied: string) => {
    switch (applied) {
      case 'raw':
        return t('analysis.aggregation.raw');
      case '15m':
        return t('analysis.aggregation.fifteenMinute');
      case 'hourly':
        return t('analysis.aggregation.hourly');
      case 'daily':
        return t('analysis.aggregation.daily');
      case 'weekly':
        return t('analysis.aggregation.weekly');
      default:
        return applied;
    }
  };

  return (
    <div className="analysis-page flex h-screen flex-col bg-[var(--bg)] text-[var(--text)]">
      <header className="shrink-0 border-b border-[var(--border)] bg-[var(--header-bg)] text-[var(--header-text)]">
        <div className="mx-auto max-w-[1600px] px-4 py-4">
          <div>
            <Link to="/dashboard" className="text-sm font-medium text-[var(--header-subtext)] hover:text-[var(--header-text)]">{t('analysis.backToDashboard')}</Link>
            <h1 className="mt-2 text-3xl font-semibold">{t('analysis.title')}</h1>
          </div>
        </div>
      </header>

      {(catalogError || seriesError || viewsError || viewSaveError) && (
        <div className="border-b border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-3 text-sm text-[var(--warn-text)]">
          {t('analysis.loadError')}
        </div>
      )}

      <div className="analysis-layout mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col gap-4 overflow-hidden px-4 py-4 lg:flex-row">
        <aside className="analysis-sidebar overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm lg:w-[320px] lg:shrink-0">
          <AnalysisSeriesTray
            channels={catalog?.channels ?? []}
            selectedIds={selectedIds}
            onAdd={(id) => updateWorkspace((currentWorkspace) => addSeries(currentWorkspace, id))}
            onRemove={(id) => updateWorkspace((currentWorkspace) => removeSeries(currentWorkspace, id))}
          />
          {catalogLoading && <p className="mt-3 text-sm text-[var(--text-tertiary)]">{t('analysis.catalog.loading')}</p>}
          <div className="mt-4 border-t border-[var(--border)] pt-4">
            <AnalysisViewsMenu
              views={views}
              onSave={(name) => {
                void saveCurrentView(name);
              }}
              onLoad={loadView}
            />
          </div>
        </aside>
        <main className="analysis-main flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
            <div className="flex flex-col gap-2">
              <AnalysisControls
                rangeLabel={activeWorkspace.range.label}
                range={activeWorkspace.range}
                mode={activeWorkspace.mode}
                layout={activeWorkspace.layout}
                toggles={activeWorkspace.toggles}
                onRangeChange={(range) => updateWorkspace((currentWorkspace) => setRange(
                  currentWorkspace,
                  typeof range === 'string'
                    ? { mode: 'relative', label: range, from: null, to: null } satisfies AnalysisRange
                    : range,
                ))}
                onModeChange={(mode) => updateWorkspace((currentWorkspace) => setMode(currentWorkspace, mode))}
                onLayoutChange={(layout) => updateWorkspace((currentWorkspace) => setLayout(currentWorkspace, layout))}
                onToggle={(key, value) => updateWorkspace((currentWorkspace) => setToggle(currentWorkspace, key, value))}
              />
              {data?.aggregation.applied ? (
                <div className="inline-flex w-fit items-center gap-1.5 rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-xs text-[var(--text-secondary)]">
                  <span className="font-medium">{t('analysis.aggregation.label')}</span>
                  <span>
                    {aggregationLabel(data.aggregation.applied)}
                  </span>
                </div>
              ) : null}
              {activeWorkspace.mode === 'timeline' && activeWorkspace.layout === 'overlaid' ? (
                <MetricAcrossZonesPicker
                  channels={catalog?.channels ?? []}
                  onApply={applyMetricPreset}
                />
              ) : null}
            </div>
            <AnalysisExportMenu
              series={displayedSeries}
              catalogById={catalogById}
              chartRef={chartRef}
              username={username}
            />
          </div>
          {seriesLoading && <p className="mt-4 text-sm text-[var(--text-tertiary)]">{t('analysis.series.loading')}</p>}
          {data?.dropped && data.dropped.length > 0 && (
            <div className="mt-2 rounded border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-1.5 text-xs text-[var(--warn-text)]" role="alert">
              {t('analysis.droppedNotice', { count: data.dropped.length, defaultValue: '{{count}} series could not be loaded' })}
            </div>
          )}
          <div data-testid="analysis-chart-shell" className="mt-4 min-h-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
            <AnalysisChartPanel
              series={displayedSeries}
              mode={activeWorkspace.mode}
              layout={activeWorkspace.layout}
              toggles={activeWorkspace.toggles}
              channelMeta={channelMeta}
              zoneNameById={zoneNameById}
              chartRef={chartRef}
              resolveAxisLabel={resolveAxisLabel}
              onAxisRename={renameAxis}
            />
          </div>
          {activeWorkspace.mode !== 'correlation' && (
            <AnalysisChartLegend
              series={displayedSeries.map((s) => ({ seriesId: s.seriesId, label: s.label }))}
              onRename={renameSeries}
            />
          )}
        </main>
      </div>
    </div>
  );
}
