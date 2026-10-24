import { useEffect, useMemo, useRef, useState } from 'react';
import { ChartHost } from '../ChartHost';
import { mountUplot } from '../adapters/uplot';
import type { HistoryWindowResult } from '../history/useHistoryWindow';
import { getSeriesAppearance } from '../shared/seriesAppearance';
import type { HistoryUnitGroup, MountAdapter, SensorSeries, SeriesAppearance } from '../shared/types';
import { SeriesLegend, SeriesSwatch, type SeriesLegendLabels } from './SeriesLegend';
import './styles.css';

export interface MobileSoilHistoryLabels {
  ranges: { day: string; week: string; month: string; ninetyDays: string };
  back: string;
  forward: string;
  latest: string;
  sensors: string;
  unitNotReported: string;
  loading: string;
  updating: string;
  noData: string;
  allHidden: string;
  unavailable: string;
  pinnedReading: string;
  close: string;
  aggregation: string;
  points: string;
  loadedRange: string;
  truncated: string;
  showDay: string;
  retry: string;
  failure: string;
  coverage: string;
  freshness: string;
  notLoaded: string;
  /** Accessible name of the range button group. */
  rangesGroup: string;
  /** Accessible name of the chart's visible-window readout. */
  visibleWindow: string;
  seriesLegend: SeriesLegendLabels;
}

export interface MobileSoilHistoryProps {
  model: HistoryWindowResult;
  contextKey: string;
  mountAdapter?: MountAdapter;
  labels: MobileSoilHistoryLabels;
  formatDate?: (timestamp: number) => string;
  formatAggregation?: (level: string) => string;
}

interface Metadata { contextKey: string; series: readonly SensorSeries[]; unitGroups: readonly HistoryUnitGroup[]; }

export function MobileSoilHistory({ model, contextKey, mountAdapter = mountUplot, labels, formatDate = (timestamp) => new Date(timestamp).toLocaleString(), formatAggregation = (level) => level }: MobileSoilHistoryProps) {
  const [unit, setUnit] = useState('');
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const metadata = useRef<Metadata | null>(null);
  const previousContext = useRef(contextKey);
  const initializedKey = useRef<string | null>(null);
  const knownSeries = useRef(new Map<string, Set<string>>());
  const appearanceRegistries = useRef(new Map<string, Map<string, SeriesAppearance>>());
  const [focusedSeriesId, setFocusedSeriesId] = useState<string | null>(null);
  const [sensorsOpen, setSensorsOpen] = useState(false);
  const accepted = model.accepted;
  useEffect(() => {
    if (previousContext.current === contextKey) return;
    previousContext.current = contextKey;
    metadata.current = null;
    setUnit('');
    setEnabled(new Set());
    initializedKey.current = null;
    knownSeries.current.clear();
    appearanceRegistries.current.clear();
    setFocusedSeriesId(null);
    setSensorsOpen(false);
  }, [contextKey]);
  useEffect(() => {
    if (!accepted || accepted.series.length === 0) return;
    metadata.current = { contextKey, series: accepted.series.map((item) => ({ ...item, points: [] })), unitGroups: accepted.unitGroups };
  }, [accepted, contextKey]);
  const empty = !!accepted && accepted.series.length === 0;
  const descriptors = empty && metadata.current?.contextKey === contextKey ? metadata.current.series : accepted?.series ?? [];
  const groups = empty && metadata.current?.contextKey === contextKey ? metadata.current.unitGroups : accepted?.unitGroups ?? [];
  useEffect(() => {
    if (groups.some((group) => group.unit === unit)) return;
    const groupWithValues = groups.find((group) => descriptors.some((item) => item.unit === group.unit && item.points.some((point) => typeof point.value === 'number' && Number.isFinite(point.value))));
    setUnit(groupWithValues?.unit ?? groups[0]?.unit ?? '');
  }, [groups, unit]);
  const available = useMemo(() => descriptors.filter((item) => item.unit === unit), [descriptors, unit]);
  useEffect(() => {
    if (!accepted) return;
    const key = `${contextKey}:${unit}`;
    const priorKey = initializedKey.current;
    const priorKnown = knownSeries.current.get(key) ?? new Set<string>();
    const currentIds = new Set(available.map((item) => item.id));
    if (priorKey === key && priorKnown.size === currentIds.size && [...currentIds].every((id) => priorKnown.has(id))) return;
    initializedKey.current = key;
    knownSeries.current.set(key, currentIds);
    setEnabled((previous) => {
      if (priorKey !== key) return new Set(currentIds);
      const next = new Set([...previous].filter((id) => currentIds.has(id)));
      currentIds.forEach((id) => { if (!priorKnown.has(id)) next.add(id); });
      return next;
    });
  }, [accepted, available, contextKey, unit]);
  const appearanceRegistry = useMemo(() => {
    const key = `${contextKey}:${unit}`;
    let registry = appearanceRegistries.current.get(key);
    if (!registry) { registry = new Map(); appearanceRegistries.current.set(key, registry); }
    available.forEach((item) => { if (!registry!.has(item.id)) registry!.set(item.id, item.appearance ?? getSeriesAppearance(registry!.size)); });
    return registry;
  }, [available, contextKey, unit]);
  const styledAvailable = useMemo(() => available.map((item) => ({ ...item, appearance: appearanceRegistry.get(item.id)! })), [available, appearanceRegistry]);
  const visibleSeries = useMemo(() => empty ? [] : styledAvailable.filter((item) => enabled.has(item.id)), [empty, styledAvailable, enabled]);
  const panelResetKey = `${contextKey}:${unit}:${[...enabled].sort().join(',')}`;
  const range = accepted ? `${formatDate(accepted.coverage.from)} – ${formatDate(accepted.coverage.to)}` : '';
  const toggle = (id: string) => { setFocusedSeriesId(null); setEnabled((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); if (next.size === 0) setSensorsOpen(true); return next; }); };
  const changeUnit = (nextUnit: string) => { if (nextUnit !== unit) { setFocusedSeriesId(null); setSensorsOpen(false); } setUnit(nextUnit); };
  const focusSeries = (id: string) => setFocusedSeriesId((previous) => previous === id ? null : id);
  useEffect(() => {
    if (focusedSeriesId && !available.some((item) => item.id === focusedSeriesId)) setFocusedSeriesId(null);
  }, [available, focusedSeriesId]);

  return <section className="mobile-soil-history" data-testid="mobile-soil-history">
    <div className="history-ranges" aria-label={labels.rangesGroup}>
      <button type="button" onClick={() => model.selectPreset('24h')}>{labels.ranges.day}</button>
      <button type="button" onClick={() => model.selectPreset('7d')}>{labels.ranges.week}</button>
      <button type="button" onClick={() => model.selectPreset('30d')}>{labels.ranges.month}</button>
      <button type="button" onClick={() => model.selectPreset('90d')}>{labels.ranges.ninetyDays}</button>
      <button type="button" onClick={() => model.moveWindow('back')}>{labels.back}</button>
      <button type="button" onClick={() => model.moveWindow('forward')}>{labels.forward}</button>
      <button type="button" onClick={model.showLatest}>{labels.latest}</button>
    </div>
    {model.status === 'loading' && !accepted && <p role="status">{labels.loading}</p>}
    <p className="mobile-history-refresh" role="status" aria-live="off" aria-hidden={!model.refreshing || !accepted}>{model.refreshing && accepted ? labels.updating : '\u00a0'}</p>
    {model.error !== null && <p role="alert">{labels.failure}: {model.error instanceof Error ? model.error.message : String(model.error)} <button type="button" onClick={model.retry}>{labels.retry}</button></p>}
    {accepted && <div className="history-metadata"><span>{labels.loadedRange}: {range}</span><span>{labels.aggregation}: {formatAggregation(accepted.aggregation.level)}</span><span>{labels.points}: {accepted.aggregation.pointCount.toLocaleString()}</span>{accepted.aggregation.coveragePct != null && <span>{labels.coverage}: {accepted.aggregation.coveragePct}%</span>}{accepted.freshness?.dataAsOf && <span>{labels.freshness}: {accepted.freshness.dataAsOf}</span>}{accepted.limits.truncated && <span>{labels.truncated} <button type="button" onClick={() => model.selectPreset('24h')}>{labels.showDay}</button></span>}</div>}
    {accepted && <>
      <label className="mobile-history-unit">{labels.sensors}<select value={unit} onChange={(event) => changeUnit(event.target.value)} disabled={!groups.length}>{groups.map((group) => <option key={group.unit} value={group.unit}>{group.label}</option>)}</select></label>
      {available.length > 3 ? <details open={sensorsOpen || (!empty && visibleSeries.length === 0)} className="mobile-history-sensors-disclosure"><summary onClick={(event) => { event.preventDefault(); setSensorsOpen((value) => !value); }}>{labels.sensors} ({available.length})</summary><fieldset><legend>{labels.sensors} ({groups.find((group) => group.unit === unit)?.label ?? labels.unitNotReported})</legend>{styledAvailable.map((item) => <label key={item.id}><input type="checkbox" checked={enabled.has(item.id)} onChange={() => toggle(item.id)} /><SeriesSwatch appearance={item.appearance} /><span>{item.label}</span><small>{item.unit || labels.unitNotReported}</small></label>)}</fieldset></details> : <fieldset><legend>{labels.sensors} ({groups.find((group) => group.unit === unit)?.label ?? labels.unitNotReported})</legend>{styledAvailable.map((item) => <label key={item.id}><input type="checkbox" checked={enabled.has(item.id)} onChange={() => toggle(item.id)} /><SeriesSwatch appearance={item.appearance} /><span>{item.label}</span><small>{item.unit || labels.unitNotReported}</small></label>)}</fieldset>}
      <div className="history-chart-wrapper">
        <ChartHost mountAdapter={mountAdapter} series={visibleSeries} focusedSeriesId={focusedSeriesId} store={model.viewportStore} extent={model.horizon} coverage={accepted.coverage} notLoadedLabel={labels.notLoaded} maxSpanMs={90 * 24 * 60 * 60 * 1_000} minSpanMs={60 * 60 * 1_000} yRange="auto" labels={{ pinnedReading: labels.pinnedReading, close: labels.close, unavailable: labels.unavailable, visibleWindow: labels.visibleWindow }} />
        <SeriesLegend series={styledAvailable.filter((item) => enabled.has(item.id))} focusedSeriesId={focusedSeriesId} onFocus={focusSeries} onShowAll={() => setFocusedSeriesId(null)} labels={labels.seriesLegend} resetKey={panelResetKey} />
        <p className="mobile-series-legend-announcement" role="status" aria-live="polite">{focusedSeriesId ? labels.seriesLegend.focusAnnouncement(styledAvailable.find((item) => item.id === focusedSeriesId)?.label ?? '') : labels.seriesLegend.allSeriesAnnouncement}</p>
        {empty && <p className="history-empty" role="status">{labels.noData}</p>}
        {!empty && visibleSeries.length === 0 && <p>{labels.allHidden}</p>}
      </div>
    </>}
  </section>;
}
