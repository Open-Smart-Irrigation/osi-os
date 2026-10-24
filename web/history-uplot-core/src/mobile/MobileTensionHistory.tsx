import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChartHost, type ChartHostInternalDiagnosticsReader } from '../ChartHost';
import { mountUplot } from '../adapters/uplot';
import { createHistoryLoader } from '../history/historyLoader';
import { useHistoryWindow, type HistoryWindowResult } from '../history/useHistoryWindow';
import { HistoryAuthError, type HistoryContext, type HistoryLoader } from '../history/types';
import { analysisHourlyRangeStrategy } from '../history/rangeStrategy';
import { DAY_MS, HOUR_MS, type HistoryWindowOptions, type MobileTensionSource, type MountAdapter, type Viewport } from '../shared/types';
import { getSeriesAppearance } from '../shared/seriesAppearance';
import { SeriesLegend, type LegendSeries } from './SeriesLegend';
import { MobileHistoryError } from './mobileHistoryError';
import './styles.css';
import './mobileTension.css';

export interface MobileTensionHistoryLabels {
  title: string;
  chart: string;
  waterTension: string;
  controls: string;
  time: string;
  timeRange: string;
  range24h: string;
  range7d: string;
  latest: string;
  hourlyAverages: string;
  hourlyAverage: string;
  loading: string;
  refreshing: string;
  emptyInterval: string;
  showLatest24h: string;
  unavailableValue: string;
  notLoaded: string;
  chooseSources: string;
  historicalUnverified: string;
  sources: string;
  chartSources: string;
  openSources: string;
  sourceDiscoveryIncomplete: string;
  catalogFailed: string;
  unavailableSources: string;
  requestTooLarge: string;
  fewerSourcesOrShorterWindow: string;
  accessDenied: string;
  incompleteResponse: string;
  transientFailure: string;
  retry: string;
  details: string;
  close: string;
  pinnedReading: string;
  visibleWindow: string;
  sourceCap(limit: number): string;
  sourceCount(selected: number, total: number): string;
  invalidHourlyAverages(count: number): string;
  removedSources(names: string): string;
  removeSource(name: string): string;
  transportCoverage(from: string, to: string): string;
  bucketInterval(from: string, to: string): string;
  latestBucket(at: string): string;
  seriesLegend: {
    legend: string;
    showAll: string;
    plottedSeries: string;
    seriesCount(count: number): string;
    focusAnnouncement(label: string): string;
    allSeriesAnnouncement: string;
  };
}

export interface MobileHistoryDiagnosticSnapshot {
  requestedViewport: Viewport;
  renderedViewport: Viewport | null;
  plotRect: { left: number; top: number; width: number; height: number } | null;
  loader: { foregroundActive: boolean; prefetchActive: boolean; entries: number; points: number };
  shell: {
    status: 'idle' | 'loading' | 'ready' | 'empty' | 'error';
    refreshing: boolean;
    errorKind: null | 'auth-401' | 'auth-403' | 'sources' | 'size' | 'transient' | 'protocol';
  };
}

export interface MobileHistoryDiagnostics { snapshot(): MobileHistoryDiagnosticSnapshot; }

export interface MobileTensionHistoryProps {
  sources: readonly MobileTensionSource[];
  defaultSelectedIds: readonly string[];
  catalogError: MobileHistoryError | HistoryAuthError | null;
  catalogLoading: boolean;
  context: HistoryContext;
  readPolicy(request: import('../shared/types').HistoryWindowRequest): import('../shared/types').HistoryReadPolicy;
  locale: string;
  timeZone: string;
  zoneLabel: string;
  labels: MobileTensionHistoryLabels;
  load: HistoryWindowOptions['load'];
  refreshCatalogForGeneration(generation: number): Promise<void>;
  onAuthError(error: HistoryAuthError): void;
  mountAdapter?: MountAdapter;
  registerInternalDiagnostics?: (diagnostics: MobileHistoryDiagnostics | null) => void;
}

const MAX_SOURCES = 25;
const sourceOrder = (left: MobileTensionSource, right: MobileTensionSource) => left.sourceKey.localeCompare(right.sourceKey) || left.channelKey.localeCompare(right.channelKey) || left.seriesId.localeCompare(right.seriesId);
const dateText = (timestamp: number, locale: string, timeZone: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(timestamp);

function errorKind(error: unknown): MobileHistoryDiagnosticSnapshot['shell']['errorKind'] {
  if (error instanceof HistoryAuthError) return error.status === 401 ? 'auth-401' : 'auth-403';
  if (error instanceof MobileHistoryError) return error.failure.kind;
  return null;
}

function ViewportDateSummary({ store, locale, timeZone }: { store: HistoryWindowResult['viewportStore']; locale: string; timeZone: string }) {
  const [viewport, setViewport] = useState(store.get);
  useEffect(() => store.subscribe((next) => setViewport(next)), [store]);
  return <span className="mobile-tension-date-summary" aria-live="polite">{dateText(viewport.from, locale, timeZone)} – {dateText(viewport.to, locale, timeZone)}</span>;
}

function BottomSheet({ title, open, triggerRef, onClose, children, closeLabel }: { title: string; open: boolean; triggerRef: React.MutableRefObject<HTMLElement | null>; onClose: () => void; children: ReactNode; closeLabel: string }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const focusable = () => [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') ?? [])];
  useEffect(() => {
    if (!open) return undefined;
    const dialog = dialogRef.current;
    const prior = triggerRef.current;
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (elements.length === 0) { event.preventDefault(); return; }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    const containFocus = (event: FocusEvent) => { if (dialog && !dialog.contains(event.target as Node)) focusable()[0]?.focus(); };
    document.addEventListener('focusin', containFocus);
    return () => { document.removeEventListener('keydown', onKeyDown); document.removeEventListener('focusin', containFocus); prior?.focus(); triggerRef.current = null; };
  }, [open, onClose, triggerRef]);
  if (!open) return null;
  return <div className="mobile-tension-sheet-backdrop" data-testid="mobile-tension-sheet-backdrop">
    <div className="mobile-tension-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef} onFocusCapture={(event) => { if (!dialogRef.current?.contains(event.target as Node)) focusable()[0]?.focus(); }}>
      <div className="mobile-tension-sheet-heading"><h2 id={titleId}>{title}</h2><button type="button" onClick={onClose}>{closeLabel}</button></div>
      <div className="mobile-tension-sheet-content">{children}</div>
    </div>
  </div>;
}

function statusMessage(model: HistoryWindowResult, catalogError: MobileTensionHistoryProps['catalogError'], authError: HistoryAuthError | null, labels: MobileTensionHistoryLabels): ReactNode {
  if (catalogError instanceof HistoryAuthError) return <p role="alert">{labels.accessDenied}</p>;
  if (authError?.status === 403) return <p role="alert">{labels.accessDenied}</p>;
  if (catalogError instanceof MobileHistoryError) {
    if (catalogError.failure.kind === 'transient') return <p role="alert">{labels.sourceDiscoveryIncomplete}</p>;
    return <p role="alert">{labels.catalogFailed}</p>;
  }
  if (!(model.error instanceof MobileHistoryError)) return null;
  switch (model.error.failure.kind) {
    case 'sources': return <p role="alert">{labels.unavailableSources}</p>;
    case 'size': return <p role="alert">{labels.requestTooLarge} {labels.fewerSourcesOrShorterWindow}</p>;
    case 'transient': return <p role="alert">{labels.transientFailure}</p>;
    case 'protocol': return <p role="alert">{labels.incompleteResponse}</p>;
    default: return null;
  }
}

export function MobileTensionHistory({ sources, defaultSelectedIds, catalogError, catalogLoading, context, readPolicy, locale, timeZone, zoneLabel, labels, load, refreshCatalogForGeneration, onAuthError, mountAdapter = mountUplot, registerInternalDiagnostics }: MobileTensionHistoryProps) {
  const loaderRef = useRef<HistoryLoader | null>(null);
  if (!loaderRef.current) loaderRef.current = createHistoryLoader();
  const loader = loaderRef.current;
  const contextIdentity = `${context.sessionKey}|${context.scopeKey}`;
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [selectionContext, setSelectionContext] = useState(contextIdentity);
  const initializedContext = useRef<string | null>(null);
  const selectionInitialized = useRef<string | null>(null);
  const deliberateEmpty = useRef(false);
  const deniedIds = useRef(new Set<string>());
  const [activeSheet, setActiveSheet] = useState<'time' | 'sources' | null>(null);
  const sheetTrigger = useRef<HTMLElement | null>(null);
  const [authError, setAuthError] = useState<HistoryAuthError | null>(null);
  const [removedSourceNames, setRemovedSourceNames] = useState<readonly string[]>([]);
  const refreshGeneration = useRef(0);
  const handledFailure = useRef<unknown>(null);
  const readerRef = useRef<ChartHostInternalDiagnosticsReader | null>(null);
  const modelRef = useRef<HistoryWindowResult | null>(null);
  const errorRef = useRef<unknown>(null);

  const catalog = useMemo(() => [...sources].sort(sourceOrder), [sources]);
  const sourceById = useMemo(() => new Map(catalog.map((item) => [item.seriesId, item])), [catalog]);
  const selectableIds = useMemo(() => new Set(catalog.filter((item) => item.available && item.legacy !== true && item.measurementKind === 'soil' && /^swt_[123]$/.test(item.channelKey)).map((item) => item.seriesId)), [catalog]);
  const defaultEligibleIds = useMemo(() => new Set(catalog.filter((item) => selectableIds.has(item.seriesId) && item.status !== 'other_supported').map((item) => item.seriesId)), [catalog, selectableIds]);

  useEffect(() => {
    if (initializedContext.current === contextIdentity) return;
    initializedContext.current = contextIdentity;
    setSelectionContext(contextIdentity);
    selectionInitialized.current = null;
    deliberateEmpty.current = false;
    deniedIds.current = new Set();
    setSelectedIds([]);
    setAuthError(null);
    setRemovedSourceNames([]);
  }, [contextIdentity]);

  useEffect(() => {
    if (catalogLoading || initializedContext.current !== contextIdentity || deliberateEmpty.current || (catalogError && selectionInitialized.current !== contextIdentity)) return;
    if (selectionInitialized.current === contextIdentity) {
      setSelectedIds((current) => current.filter((id) => selectableIds.has(id) && !deniedIds.current.has(id)));
      return;
    }
    selectionInitialized.current = contextIdentity;
    setSelectedIds(() => {
      return [...new Set(defaultSelectedIds)].filter((id) => defaultEligibleIds.has(id) && !deniedIds.current.has(id)).slice(0, MAX_SOURCES);
    });
  }, [catalog, catalogError, catalogLoading, contextIdentity, defaultEligibleIds, defaultSelectedIds, selectableIds]);

  useEffect(() => {
    if (catalogLoading) return;
    setSelectedIds((current) => current.filter((id) => selectableIds.has(id) && !deniedIds.current.has(id)));
  }, [catalogLoading, selectableIds]);

  const onAuth = useCallback((value: unknown) => {
    if (!(value instanceof HistoryAuthError)) return;
    const error = value;
    setAuthError(error);
    onAuthError(error);
  }, [onAuthError]);
  const selectionReady = selectionContext === contextIdentity;
  const activeSelectedIds = selectionReady ? selectedIds : [];
  const model = useHistoryWindow({
    enabled: !authError && !(catalogError instanceof HistoryAuthError),
    context,
    load,
    loader,
    selectedIds: activeSelectedIds,
    onAuthError: onAuth,
    rangeStrategy: analysisHourlyRangeStrategy,
    maxSpanMs: 7 * DAY_MS,
    minSpanMs: HOUR_MS,
    navigationStartMs: 0,
    viewportIdentity: [context.sessionKey, context.scopeKey.replace(/^zone:/, ''), 'water-tension'].join('|'),
    readPolicy,
  });
  modelRef.current = model;
  errorRef.current = authError ?? catalogError ?? model.error;

  useEffect(() => () => loader.destroy(), [loader]);

  const setChartReader = useCallback((reader: ChartHostInternalDiagnosticsReader | null) => { readerRef.current = reader; }, []);
  useEffect(() => {
    if (!registerInternalDiagnostics) return undefined;
    const diagnostics: MobileHistoryDiagnostics = {
      snapshot: () => {
        const current = modelRef.current;
        const reader = readerRef.current;
        let renderedViewport: Viewport | null = null;
        let plotRect: MobileHistoryDiagnosticSnapshot['plotRect'] = null;
        if (reader) { const value = reader(); renderedViewport = value.renderedViewport; plotRect = value.plotRect; }
        return {
          requestedViewport: current?.viewportStore.get() ?? { from: 0, to: 0 }, renderedViewport, plotRect, loader: loader.diagnostics(),
          shell: { status: current?.status ?? 'idle', refreshing: current?.refreshing ?? false, errorKind: errorKind(errorRef.current) },
        };
      },
    };
    registerInternalDiagnostics(diagnostics);
    return () => registerInternalDiagnostics(null);
  }, [loader, registerInternalDiagnostics]);

  useEffect(() => {
    const failure = model.error;
    if (!(failure instanceof MobileHistoryError) || handledFailure.current === failure) return;
    handledFailure.current = failure;
    const generation = ++refreshGeneration.current;
    const sourceFailure = failure.failure.kind === 'sources' ? failure.failure : null;
    if (sourceFailure) {
      if (sourceFailure.accessDeniedIds.length) {
        sourceFailure.accessDeniedIds.forEach((id) => deniedIds.current.add(id));
        setRemovedSourceNames(sourceFailure.accessDeniedIds.map((id) => sourceById.get(id)?.label ?? id));
        setSelectedIds((current) => current.filter((id) => !sourceFailure.accessDeniedIds.includes(id)));
        model.evictSeries?.(sourceFailure.accessDeniedIds);
      }
      void refreshCatalogForGeneration(generation);
    }
  }, [model.error, refreshCatalogForGeneration, model, sourceById]);

  useEffect(() => {
    if (!(catalogError instanceof HistoryAuthError) || handledFailure.current === catalogError) return;
    handledFailure.current = catalogError;
    onAuth(catalogError);
  }, [catalogError, onAuth]);

  const appearanceById = useMemo(() => new Map(catalog.map((item, index) => [item.seriesId, getSeriesAppearance(index)])), [catalog]);
  const chartSeries = useMemo<LegendSeries[]>(() => {
    const accepted = model.accepted;
    if (!accepted) return [];
    const acceptedById = new Map(accepted.series.map((item) => [item.id, item]));
    return catalog.filter((item) => activeSelectedIds.includes(item.seriesId)).map((item) => {
      const itemData = acceptedById.get(item.seriesId);
      if (!itemData) return null;
      return { ...itemData, id: item.seriesId, label: item.label || itemData.label, unit: 'kPa', appearance: appearanceById.get(item.seriesId)! };
    }).filter((item): item is LegendSeries => item !== null);
  }, [catalog, activeSelectedIds, model.accepted, appearanceById]);
  const [focusedSeriesId, setFocusedSeriesId] = useState<string | null>(null);
  useEffect(() => { if (focusedSeriesId && !activeSelectedIds.includes(focusedSeriesId)) setFocusedSeriesId(null); }, [focusedSeriesId, activeSelectedIds]);

  const toggleSource = (id: string) => {
    if (deniedIds.current.has(id) || !selectableIds.has(id)) return;
    setSelectedIds((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : current.length >= MAX_SOURCES ? current : [...current, id];
      deliberateEmpty.current = next.length === 0;
      return next;
    });
  };
  const removeSource = (id: string) => { deliberateEmpty.current = selectedIds.length === 1; setSelectedIds((current) => current.filter((item) => item !== id)); };
  const openSheet = (sheet: 'time' | 'sources', event: React.MouseEvent<HTMLButtonElement>) => { sheetTrigger.current = event.currentTarget; setActiveSheet(sheet); };
  const closeSheet = useCallback(() => setActiveSheet(null), []);
  const retryCatalog = () => { const generation = ++refreshGeneration.current; void refreshCatalogForGeneration(generation); };

  const sourceFailure = model.error instanceof MobileHistoryError && model.error.failure.kind === 'sources' ? model.error.failure : null;
  const accepted = model.accepted;
  const noSelection = activeSelectedIds.length === 0;
  const hideChart = authError !== null || catalogError instanceof HistoryAuthError;

  return <section className="mobile-soil-history mobile-tension-history" data-testid="mobile-tension-history" aria-labelledby="mobile-tension-history-title">
    <div className="mobile-tension-eyebrow">{zoneLabel}</div>
    <div className="mobile-tension-title-row">
      <h1 id="mobile-tension-history-title">{labels.title}</h1>
      <button type="button" aria-label={labels.time} onClick={(event) => openSheet('time', event)}>{labels.time}</button>
      <ViewportDateSummary store={model.viewportStore} locale={locale} timeZone={timeZone} />
    </div>
    <div className="mobile-tension-controls" role="group" aria-label={labels.controls}>
      <button type="button" aria-label={labels.openSources} onClick={(event) => openSheet('sources', event)}>{labels.sources}: {labels.sourceCount(activeSelectedIds.length, catalog.length)}</button>
    </div>
    {catalogLoading && <p role="status">{labels.loading}</p>}
    {model.status === 'loading' && !accepted && <p role="status">{labels.loading}</p>}
    {model.refreshing && <p role="status" aria-live="polite">{labels.refreshing}</p>}
    {statusMessage(model, catalogError, authError, labels)}
    {removedSourceNames.length > 0 && <p role="alert">{labels.removedSources(removedSourceNames.join(', '))}</p>}
    {catalogError instanceof MobileHistoryError && catalogError.failure.kind === 'transient' && <button type="button" onClick={retryCatalog}>{labels.retry}</button>}
    {model.error instanceof MobileHistoryError && model.error.failure.kind === 'transient' && <button type="button" onClick={model.retry}>{labels.retry}</button>}
    {!hideChart && <>
      <h2 className="mobile-tension-chart-title">{labels.hourlyAverages}</h2>
      <div className="mobile-tension-unit-row"><span>{labels.waterTension}</span><strong>kPa</strong></div>
      {noSelection && <p role="status">{labels.chooseSources}</p>}
      {!catalogLoading && model.status === 'empty' && !noSelection && <><p role="status">{labels.emptyInterval}</p><button type="button" onClick={model.showLatest}>{labels.showLatest24h}</button></>}
      <div className="mobile-tension-chart-frame" aria-label={labels.chart}>
        <ChartHost mountAdapter={mountAdapter} series={chartSeries} store={model.viewportStore} extent={model.horizon} minSpanMs={HOUR_MS} maxSpanMs={7 * DAY_MS} inspectionMode="containing-bucket" locale={locale} timeZone={timeZone} focusedSeriesId={focusedSeriesId} coverage={accepted?.coverage} notLoadedLabel={labels.notLoaded} registerInternalDiagnostics={setChartReader} labels={{ pinnedReading: labels.pinnedReading, close: labels.close, unavailable: labels.unavailableValue, visibleWindow: labels.visibleWindow, hourlyAverage: labels.hourlyAverage, bucketInterval: (from, to) => labels.bucketInterval(dateText(from, locale, timeZone), dateText(to, locale, timeZone)) }} />
      </div>
      <SeriesLegend series={chartSeries} focusedSeriesId={focusedSeriesId} onFocus={(id) => setFocusedSeriesId((current) => current === id ? null : id)} onShowAll={() => setFocusedSeriesId(null)} labels={labels.seriesLegend} resetKey={`${contextIdentity}:${activeSelectedIds.join(',')}`} />
      <p className="mobile-series-legend-announcement" role="status" aria-live="polite">{focusedSeriesId ? labels.seriesLegend.focusAnnouncement(sourceById.get(focusedSeriesId)?.label ?? focusedSeriesId) : labels.seriesLegend.allSeriesAnnouncement}</p>
      {accepted && <details className="mobile-tension-details"><summary>{labels.details}</summary><div className="mobile-tension-details-body">
        {model.accepted && <p>{labels.invalidHourlyAverages(accepted.series.reduce((count, item) => count + (item.buckets?.filter((bucket) => bucket.quality === 'invalid').length ?? 0), 0))}</p>}
        <p>{labels.transportCoverage(dateText(accepted.coverage.from, locale, timeZone), dateText(accepted.coverage.to, locale, timeZone))}</p>
        {activeSelectedIds.map((id) => {
          const item = chartSeries.find((candidate) => candidate.id === id);
          const finiteBuckets = item?.buckets?.filter((bucket) => bucket.value !== null) ?? [];
          const latest = finiteBuckets[finiteBuckets.length - 1]?.from;
          return <p key={id}>{sourceById.get(id)?.label ?? id}: {labels.latestBucket(latest == null ? labels.unavailableValue : dateText(latest, locale, timeZone))}</p>;
        })}
      </div></details>}
      {sourceFailure && <div className="mobile-tension-source-failure" role="alert">
        <p>{sourceFailure.accessDeniedIds.length ? labels.removedSources(sourceFailure.accessDeniedIds.map((id) => sourceById.get(id)?.label ?? id).join(', ')) : labels.unavailableSources}</p>
        {sourceFailure.missingIds.concat(sourceFailure.dropped.map((item) => item.seriesId).filter((id): id is string => !!id)).filter((id, index, all) => all.indexOf(id) === index).map((id) => <button type="button" key={id} onClick={() => removeSource(id)}>{labels.removeSource(sourceById.get(id)?.label ?? id)}</button>)}
      </div>}
    </>}
    <BottomSheet title={labels.timeRange} open={activeSheet === 'time'} triggerRef={sheetTrigger} onClose={closeSheet} closeLabel={labels.close}>
      <button type="button" onClick={() => { model.selectPreset('24h'); closeSheet(); }}>{labels.range24h}</button>
      <button type="button" onClick={() => { model.selectPreset('7d'); closeSheet(); }}>{labels.range7d}</button>
      <button type="button" onClick={() => { model.showLatest(); closeSheet(); }}>{labels.latest}</button>
    </BottomSheet>
    <BottomSheet title={labels.chartSources} open={activeSheet === 'sources'} triggerRef={sheetTrigger} onClose={closeSheet} closeLabel={labels.close}>
      <p>{labels.sourceCount(activeSelectedIds.length, catalog.length)}</p>
      {activeSelectedIds.length >= MAX_SOURCES && <p>{labels.sourceCap(MAX_SOURCES)}</p>}
      <fieldset><legend>{labels.sources}</legend>{catalog.map((item) => {
        const checked = activeSelectedIds.includes(item.seriesId);
        const disabled = deniedIds.current.has(item.seriesId) || (!checked && activeSelectedIds.length >= MAX_SOURCES) || !selectableIds.has(item.seriesId);
        return <label key={item.seriesId} className={disabled ? 'is-disabled' : ''}><input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggleSource(item.seriesId)} /><span>{item.label}</span>{item.depthCm != null && <small>{item.depthCm} cm</small>}{item.status === 'other_supported' && <small>{labels.historicalUnverified}</small>}</label>;
      })}</fieldset>
    </BottomSheet>
  </section>;
}
