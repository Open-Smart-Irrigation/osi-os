import { useEffect, useMemo, useRef, useState } from 'react';
import { ChartHost } from '../ChartHost';
import { loadAdapter } from '../routes';
import { SERIES_COLORS, type MountAdapter, type SensorSeries } from '../shared/types';
import { platformConfig } from './platform';
import { coverageContains, HISTORY_MAX_VIEWPORT_SPAN_MS, requestForViewport } from './range';
import { usePilotHistory } from './usePilotHistory';
import type { PilotPlatform } from './types';

export function PilotApp({ platform }: { platform: PilotPlatform }) {
  const history = usePilotHistory({ platform });
  const [adapter, setAdapter] = useState<MountAdapter | null>(null);
  const [adapterError, setAdapterError] = useState<string | null>(null);
  const [probeVersion, setProbeVersion] = useState(0);
  const [unit, setUnit] = useState<string>('');
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const notLoadedLeftRef = useRef<HTMLDivElement>(null);
  const notLoadedRightRef = useRef<HTMLDivElement>(null);
  const initializedKey = useRef<string | null>(null);
  const knownSeries = useRef(new Map<string, Set<string>>());
  const metadataBySelection = useRef<{ selectionKey: string; series: readonly SensorSeries[]; unitGroups: readonly { unit: string; label: string; seriesIds: readonly string[] }[] } | null>(null);
  const contextRef = useRef(history.contextKey);
  useEffect(() => { let live = true; void loadAdapter('uplot').then((next) => { if (live) setAdapter(() => next); }).catch((cause: unknown) => { if (live) setAdapterError(cause instanceof Error ? cause.message : 'Chart renderer failed to load'); }); return () => { live = false; }; }, []);
  const selectionKey = `${history.contextKey}:${history.selectedZoneId ?? ''}:${history.selectedCardId ?? ''}`;
  const acceptedEmpty = !!history.accepted && history.accepted.series.length === 0;
  const rememberedMetadata = metadataBySelection.current?.selectionKey === selectionKey ? metadataBySelection.current : null;
  const displaySeries = acceptedEmpty ? rememberedMetadata?.series ?? [] : history.accepted?.series ?? [];
  const groups = acceptedEmpty ? rememberedMetadata?.unitGroups ?? [] : history.accepted?.unitGroups ?? [];
  useEffect(() => {
    if (contextRef.current === history.contextKey) return;
    contextRef.current = history.contextKey;
    setUnit(''); setEnabled(new Set()); initializedKey.current = null; knownSeries.current.clear(); metadataBySelection.current = null;
  }, [history.contextKey]);
  useEffect(() => {
    if (!history.accepted || history.accepted.series.length === 0) return;
    metadataBySelection.current = {
      selectionKey,
      series: history.accepted.series.map((item) => ({ ...item, points: [] })),
      unitGroups: history.accepted.unitGroups,
    };
  }, [history.accepted, selectionKey]);
  useEffect(() => {
    if (!groups.some((group) => group.unit === unit)) {
      const usable = groups.find((group) => history.accepted?.series.some((item) => item.unit === group.unit && item.points.some((point) => typeof point.value === 'number' && Number.isFinite(point.value))));
      setUnit(usable?.unit ?? groups[0]?.unit ?? '');
    }
  }, [groups, unit]);
  const availableSeries = useMemo(() => displaySeries.filter((item) => item.unit === unit), [displaySeries, unit]);
  useEffect(() => {
    if (!history.accepted) return;
    const key = `${history.contextKey}:${history.selectedZoneId ?? ''}:${history.selectedCardId ?? ''}:${unit}`;
    const priorKey = initializedKey.current;
    const priorKnown = knownSeries.current.get(key) ?? new Set<string>();
    const currentIds = new Set(availableSeries.map((item) => item.id));
    if (priorKey === key && priorKnown.size === currentIds.size && [...currentIds].every((id) => priorKnown.has(id))) return;
    initializedKey.current = key;
    knownSeries.current.set(key, currentIds);
    setEnabled((previous) => {
      const valid = new Set(availableSeries.map((item) => item.id));
      if (priorKey !== key) return new Set(availableSeries.map((item) => item.id));
      if (previous.size === 0) return new Set();
      const next = new Set([...previous].filter((id) => valid.has(id)));
      currentIds.forEach((id) => { if (!priorKnown.has(id)) next.add(id); });
      return next;
    });
  }, [history.contextKey, history.selectedZoneId, history.selectedCardId, unit, availableSeries]);
  const series = useMemo(() => availableSeries.filter((item) => enabled.has(item.id)), [availableSeries, enabled]);
  const chartSeries = acceptedEmpty ? [] : series;
  const config = platformConfig(platform);
  const selectedCard = history.cards.find((card) => card.cardId === history.selectedCardId) ?? null;
  const accepted = history.accepted;
  const initialLoading = history.status === 'loading' && !history.accepted;
  const backgroundLoading = history.refreshing && !!history.accepted;
  const aggregation = accepted?.aggregation.level && accepted.aggregation.level !== 'unknown' ? accepted.aggregation.level : '—';
  const unitLabel = groups.find((group) => group.unit === unit)?.label ?? 'Unit not reported';
  const hasSelection = history.selectedZoneId !== null && history.selectedCardId !== null;
  const unsupported = !!selectedCard && !selectedCard.available;
  const toggle = (id: string) => setEnabled((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  useEffect(() => {
    const update = () => {
      const left = notLoadedLeftRef.current;
      const right = notLoadedRightRef.current;
      if (!left || !right || !accepted) { left?.setAttribute('aria-hidden', 'true'); right?.setAttribute('aria-hidden', 'true'); return; }
      const visible = history.store.get();
      const probe = typeof window !== 'undefined' ? window.__historyZoomProbe : null;
      const frame = left.parentElement?.getBoundingClientRect();
      const plot = probe?.plotRect;
      if (!frame || !plot || visible.to <= visible.from) { left.setAttribute('aria-hidden', 'true'); right.setAttribute('aria-hidden', 'true'); return; }
      left.style.top = `${plot.top - frame.top}px`; left.style.height = `${plot.height}px`; left.style.bottom = 'auto';
      right.style.top = `${plot.top - frame.top}px`; right.style.height = `${plot.height}px`; right.style.bottom = 'auto';
      const fromFraction = Math.max(0, Math.min(1, (accepted.coverage.from - visible.from) / (visible.to - visible.from)));
      const toFraction = Math.max(0, Math.min(1, (accepted.coverage.to - visible.from) / (visible.to - visible.from)));
      const plotLeft = ((plot.left - frame.left) / frame.width) * 100;
      const plotWidth = (plot.width / frame.width) * 100;
      const leftWidth = Math.max(0, plotWidth * fromFraction);
      const rightWidth = Math.max(0, plotWidth * (1 - toFraction));
      left.style.left = `${plotLeft}%`; left.style.width = `${leftWidth}%`; left.style.opacity = leftWidth > 0 ? '1' : '0'; left.setAttribute('aria-hidden', leftWidth > 0 ? 'false' : 'true');
      right.style.left = `${plotLeft + plotWidth * toFraction}%`; right.style.width = `${rightWidth}%`; right.style.opacity = rightWidth > 0 ? '1' : '0'; right.setAttribute('aria-hidden', rightWidth > 0 ? 'false' : 'true');
    };
    update();
    const unsubscribe = history.store.subscribe(update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { unsubscribe(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [accepted, history.store, adapter, probeVersion]);
  const rangeText = accepted ? `${new Date(accepted.coverage.from).toLocaleString()} – ${new Date(accepted.coverage.to).toLocaleString()}` : '—';
  return <main className="app-shell pilot-shell" data-testid="pilot-shell">
    <header className="page-header"><p className="eyebrow">Authenticated history pilot · {platform}</p><h1>Real sensor history</h1><p className="lede">Pinch to zoom. Drag to move through time.</p></header>
    {history.status === 'auth-required' && <section className="pilot-login" data-testid="pilot-login-required"><h2>Login required</h2><p>Sign in to the {platform} host, then return to this pilot.</p><a data-testid="pilot-login-link" className="button-link" href={config.loginPath}>Open login</a></section>}
    {history.status !== 'auth-required' && <>
      <section className="controls pilot-controls" aria-label="History selection">
        <label>Zone<select data-testid="pilot-zone-select" value={history.selectedZoneId ?? ''} onChange={(event) => history.selectZone(Number(event.target.value))}><option value="" disabled>Select a zone</option>{history.zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>
        <label>History card<select data-testid="pilot-card-select" value={history.selectedCardId ?? ''} onChange={(event) => history.selectCard(event.target.value)}><option value="" disabled>Select a card</option>{history.cards.map((card) => <option key={card.cardId} value={card.cardId}>{card.title}</option>)}</select></label>
        <label>Unit<select data-testid="pilot-unit-select" value={unit} onChange={(event) => setUnit(event.target.value)} disabled={!groups.length}><option value="">Unit not reported</option>{groups.map((group) => <option key={group.unit} value={group.unit}>{group.label}</option>)}</select></label>
      </section>
      <section className="pilot-ranges" aria-label="History ranges">
        {(['24h', '7d', '30d', '90d'] as const).map((span) => <button key={span} type="button" data-testid={`pilot-range-${span}`} onClick={() => history.selectPreset(span)}>{span === '24h' ? '24 h' : span === '7d' ? '7 d' : span === '30d' ? '30 d' : '90 d'}</button>)}
        <button type="button" data-testid="pilot-window-back" onClick={() => history.moveWindow('back')}>Back</button><button type="button" data-testid="pilot-window-forward" onClick={() => history.moveWindow('forward')}>Forward</button><button type="button" data-testid="pilot-window-latest" onClick={() => history.showLatest()}>Latest</button>
      </section>
      <p className="load-status" role="status" data-testid="pilot-load-status" aria-live="polite">{initialLoading ? `Loading history${history.loadingRequest ? ` · ${new Date(history.loadingRequest.from).toLocaleString()} – ${new Date(history.loadingRequest.to).toLocaleString()}` : ''}…` : history.status === 'ready' ? 'Ready' : history.status === 'empty' ? 'Ready · no data' : history.status === 'error' ? (accepted ? 'Ready · refresh failed' : 'Unable to load history') : 'Ready'}</p>
      <p className="pilot-refresh-status" data-testid="pilot-refresh-status" aria-live="off" aria-hidden={!backgroundLoading}>{backgroundLoading ? 'Updating nearby history…' : ''}</p>
      {history.error && <p className={`pilot-error${!accepted ? ' pilot-error-full' : ''}`} data-testid="pilot-error" role="alert">{history.error} {history.failedRequest && `(${new Date(history.failedRequest.from).toLocaleString()} – ${new Date(history.failedRequest.to).toLocaleString()})`} <button type="button" data-testid="pilot-retry" onClick={history.retry}>Retry</button></p>}
      {history.status === 'empty' && !accepted && <p data-testid="pilot-empty" className="pilot-empty">{history.zones.length === 0 ? 'No zones are available for this account' : history.cards.length === 0 ? 'No history cards are available for this zone' : unsupported ? 'No numeric line series in this pilot' : 'No history data is available for this interval'}</p>}
      {selectedCard && unsupported && <p className="pilot-empty">No numeric line series in this pilot</p>}
      {accepted && <section className="pilot-metadata" aria-label="Accepted history details"><span data-testid="pilot-accepted-range">Accepted range: {rangeText}</span><span data-testid="pilot-aggregation">Aggregation: {aggregation}</span><span data-testid="pilot-point-count">Points: {accepted.aggregation.pointCount.toLocaleString()}</span>{accepted.limits.truncated && <span data-testid="pilot-truncated" role="status">The server limited this result; the chart may be incomplete. <button type="button" data-testid="pilot-show-24h" onClick={() => history.selectPreset('24h')}>Show 24 h</button></span>}</section>}
      {adapterError && <p className="pilot-error" data-testid="pilot-error" role="alert">Unable to load chart renderer: {adapterError} <button type="button" data-testid="pilot-retry" onClick={() => window.location.reload()}>Reload</button></p>}
      {accepted && !unsupported && <>
        <fieldset className="pilot-series"><legend> Sensors ({unitLabel})</legend>{availableSeries.map((item, index) => <label key={item.id}><input type="checkbox" data-testid={`pilot-series-toggle-${encodeURIComponent(item.id)}`} checked={enabled.has(item.id)} onChange={() => toggle(item.id)} /> <span style={{ borderColor: SERIES_COLORS[index % SERIES_COLORS.length] }}>{item.label}</span><small>{item.unit || 'Unit not reported'}</small></label>)}</fieldset>
        <section className="legend" data-testid="pilot-legend" aria-label="Enabled series legend">{series.map((item, index) => <span key={item.id}><i style={{ backgroundColor: SERIES_COLORS[index % SERIES_COLORS.length] }} />{item.label} ({item.unit || 'Unit not reported'})</span>)}</section>
        <section className="chart-section pilot-chart-wrap">{adapter && <ChartHost key={`${history.contextKey}:${history.selectedZoneId}:${history.selectedCardId}`} route="uplot" mountAdapter={adapter} series={chartSeries} store={history.store} extent={history.horizon} maxSpanMs={HISTORY_MAX_VIEWPORT_SPAN_MS} minSpanMs={3_600_000} yRange="auto" onDiagnostics={() => setProbeVersion((value) => value + 1)} />}{initialLoading && <div className="pilot-loading-overlay" aria-hidden="true">Loading…</div>}<div ref={notLoadedLeftRef} className="pilot-not-loaded" data-testid="pilot-not-loaded" role="img" aria-label="Not loaded" aria-hidden="true">Not loaded</div><div ref={notLoadedRightRef} className="pilot-not-loaded" role="img" aria-label="Not loaded" aria-hidden="true">Not loaded</div>{acceptedEmpty ? <p data-testid="pilot-empty" className="pilot-empty pilot-empty-overlay">No data for this card in this interval. Pinch, drag, Back, Forward, or Latest to try another interval.</p> : series.length === 0 && <p className="pilot-empty">All series are hidden. Select a sensor to show it.</p>}</section>
        <p className="pilot-scope-hint" data-testid="pilot-scope-hint">Each view shows up to 90 days. Pan back for older dates. Available detail can differ between the Pi and cloud.</p>
      </>}
    </>}
  </main>;
}
