import { useEffect, useRef, useState } from 'react';
import { attachD3ViewportController, type D3ViewportController } from './shared/gestures';
import { inspectAtTime, type Inspection } from './shared/inspection';
import { startFrameSampler } from './shared/metrics';
import { FIXTURE_EXTENT, type ChartAdapter, type Candidate, type ChartRenderOptions, type HistoryZoomProbe, type MountAdapter, type SensorSeries, type Viewport } from './shared/types';
import { sameViewport, type ViewportStore } from './shared/viewport';

interface ChartHostProps {
  route: Candidate;
  mountAdapter: MountAdapter | null;
  series: readonly SensorSeries[];
  store: ViewportStore;
  extent?: Viewport;
  minSpanMs?: number;
  maxSpanMs?: number;
  yRange?: ChartRenderOptions['yRange'];
  onDiagnostics?: (probe: HistoryZoomProbe) => void;
}

interface Pin { targetTime: number; rows: readonly Inspection[]; }

export function ChartHost({ route, mountAdapter, series, store, extent = FIXTURE_EXTENT, minSpanMs, maxSpanMs, yRange, onDiagnostics }: ChartHostProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<ChartAdapter | null>(null);
  const controllerRef = useRef<D3ViewportController | null>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const [pin, setPin] = useState<Pin | null>(null);
  const [diagnosticVersion, setDiagnosticVersion] = useState(0);
  const renderCount = useRef(0);
  const viewportNotifications = useRef(0);
  const setViewportCalls = useRef(0);
  const requestedRef = useRef(store.get());
  const samplerRef = useRef<ReturnType<typeof startFrameSampler> | null>(null);
  const frameSamplesRef = useRef<HistoryZoomProbe['frameSamples']>([]);
  const suppressionRef = useRef(false);
  const diagnosticTimer = useRef<number | null>(null);
  const lastSeriesRef = useRef<readonly SensorSeries[] | null>(null);
  const liveRef = useRef(false);
  const probeRef = useRef<HistoryZoomProbe | null>(null);
  const ownsProbeRef = useRef(false);
  const onDiagnosticsRef = useRef(onDiagnostics);
  const touchRef = useRef({ moved: false, multi: false, cancelled: false, started: 0, x: 0, y: 0 });
  onDiagnosticsRef.current = onDiagnostics;
  renderCount.current += 1;
  void diagnosticVersion;

  const requireAdapter = (): ChartAdapter => {
    if (!adapterRef.current || !liveRef.current) throw new Error('Chart adapter is not live');
    return adapterRef.current;
  };

  const buildProbe = (): HistoryZoomProbe => {
    const probe = {
      route,
      get requestedViewport() { return { ...requestedRef.current }; },
      get renderedViewport() { return { ...requireAdapter().getViewport() }; },
      get plotRect() {
        const rect = requireAdapter().getPlotRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      },
      get adapterSetViewportCalls() { return setViewportCalls.current; },
      get viewportNotifications() { return viewportNotifications.current; },
      get reactRenderCount() { return renderCount.current; },
      get frameSamples() { return frameSamplesRef.current; },
      startFrameSampling() {
        samplerRef.current?.stop();
        samplerRef.current = startFrameSampler();
      },
      stopFrameSampling() {
        const sampler = samplerRef.current;
        if (!sampler) return { sampleCount: 0, meanMs: 0, p95Ms: 0, maxMs: 0, over16_7: 0, over33_3: 0 };
        const result = sampler.stop();
        frameSamplesRef.current = [...frameSamplesRef.current, result];
        samplerRef.current = null;
        return result;
      },
    } as HistoryZoomProbe;
    probeRef.current = probe;
    return probe;
  };

  const publishDiagnostics = () => {
    if (!liveRef.current) return;
    const previousProbe = probeRef.current;
    const probe = buildProbe();
    onDiagnosticsRef.current?.(probe);
    if (typeof window !== 'undefined') {
      if (!window.__historyZoomProbe || window.__historyZoomProbe === previousProbe || ownsProbeRef.current || window.__historyZoomProbe === probe) {
        window.__historyZoomProbe = probe;
        ownsProbeRef.current = true;
      }
    }
  };

  const projectGuide = (targetTime: number, viewport: Viewport) => {
    const guide = guideRef.current;
    const frame = frameRef.current;
    const adapter = adapterRef.current;
    if (!guide || !frame || !adapter) return;
    const plot = adapter.getPlotRect();
    const frameRect = frame.getBoundingClientRect();
    const fraction = (targetTime - viewport.from) / (viewport.to - viewport.from);
    const visible = Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 && plot.width > 0;
    guide.hidden = !visible;
    if (visible) guide.style.left = `${plot.left - frameRect.left + fraction * plot.width}px`;
  };

  useEffect(() => {
    const renderer = rendererRef.current;
    const frame = frameRef.current;
    if (!renderer || !frame || !mountAdapter) return undefined;
    let alive = true;
    liveRef.current = false;
    setPin(null);
    if (guideRef.current) guideRef.current.hidden = true;
    const onViewportChange = (viewport: Viewport) => {
      if (!alive) return;
      const accepted = store.set(viewport, 'gesture');
      if (!sameViewport(viewport, accepted)) adapterRef.current?.setViewport(accepted);
    };
    const adapter = mountAdapter(renderer, store.get(), onViewportChange, { extent, minSpanMs, yRange });
    const countedAdapter: ChartAdapter = {
      setData: (value) => adapter.setData(value),
      setViewport: (value) => { setViewportCalls.current += 1; adapter.setViewport(value); },
      getViewport: () => adapter.getViewport(), getPlotRect: () => adapter.getPlotRect(),
      resize: () => adapter.resize(), destroy: () => adapter.destroy(),
    };
    adapterRef.current = countedAdapter;
    liveRef.current = true;
    countedAdapter.setData(series);
    lastSeriesRef.current = series;
    requestedRef.current = store.get();
    countedAdapter.setViewport(requestedRef.current);
    countedAdapter.resize();
    if (overlayRef.current) controllerRef.current = attachD3ViewportController(frame, overlayRef.current, countedAdapter, store, { extent, minSpanMs, maxSpanMs });
    publishDiagnostics();
    return () => {
      alive = false;
      liveRef.current = false;
      controllerRef.current?.destroy();
      controllerRef.current = null;
      samplerRef.current?.stop();
      samplerRef.current = null;
      countedAdapter.destroy();
      adapterRef.current = null;
      if (diagnosticTimer.current !== null) window.clearTimeout(diagnosticTimer.current);
      diagnosticTimer.current = null;
      if (typeof window !== 'undefined' && window.__historyZoomProbe === probeRef.current) {
        delete window.__historyZoomProbe;
        ownsProbeRef.current = false;
      }
    };
  }, [mountAdapter, route, store, extent.from, extent.to, minSpanMs, maxSpanMs, yRange]);

  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter || lastSeriesRef.current === series) return;
    adapter.setData(series);
    lastSeriesRef.current = series;
    setPin(null);
    if (guideRef.current) guideRef.current.hidden = true;
    const viewport = store.get();
    requestedRef.current = viewport;
    adapter.setViewport(viewport);
  }, [series, store]);

  useEffect(() => {
    const unsubscribe = store.subscribe((viewport, source) => {
      requestedRef.current = viewport;
      viewportNotifications.current += 1;
      if (source === 'external') adapterRef.current?.setViewport(viewport);
      if (pin) projectGuide(pin.targetTime, viewport);
      if (readoutRef.current) readoutRef.current.textContent = `${formatDate(viewport.from)} – ${formatDate(viewport.to)}`;
      if (diagnosticTimer.current === null) {
        diagnosticTimer.current = window.setTimeout(() => {
          diagnosticTimer.current = null;
          if (liveRef.current) { setDiagnosticVersion((value) => value + 1); publishDiagnostics(); }
        }, 100);
      }
    });
    return unsubscribe;
  }, [store, pin?.targetTime]);

  useEffect(() => {
    const onResize = () => {
      if (!adapterRef.current) return;
      adapterRef.current.resize();
      controllerRef.current?.refreshGeometry();
      if (pin) projectGuide(pin.targetTime, store.get());
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [pin, store]);

  const tap = (event: React.MouseEvent<HTMLDivElement>) => {
    if (suppressionRef.current) { suppressionRef.current = false; return; }
    const adapter = adapterRef.current;
    const frame = frameRef.current;
    if (!adapter || !frame || series.length === 0) return;
    const plot = adapter.getPlotRect();
    if (event.clientX < plot.left || event.clientX > plot.left + plot.width || event.clientY < plot.top || event.clientY > plot.top + plot.height) return;
    const viewport = store.get();
    const targetTime = viewport.from + ((event.clientX - plot.left) / plot.width) * (viewport.to - viewport.from);
    setPin({ targetTime, rows: inspectAtTime(series, targetTime, viewport) });
    projectGuide(targetTime, viewport);
  };
  const touchStart = (event: React.TouchEvent) => {
    const point = event.touches[0];
    suppressionRef.current = false;
    touchRef.current = { moved: false, multi: event.touches.length > 1, cancelled: false, started: Date.now(), x: point?.clientX ?? 0, y: point?.clientY ?? 0 };
  };
  const touchMove = (event: React.TouchEvent) => {
    const state = touchRef.current; const point = event.touches[0];
    state.multi ||= event.touches.length > 1;
    state.moved ||= !!point && Math.hypot(point.clientX - state.x, point.clientY - state.y) > 4;
  };
  const touchEnd = () => {
    const state = touchRef.current;
    suppressionRef.current = state.cancelled || state.multi || state.moved || Date.now() - state.started >= 500;
  };
  const touchCancel = () => { touchRef.current.cancelled = true; touchEnd(); };

  return <div className="chart-host" data-testid="chart-host" ref={frameRef} onClick={tap} onTouchStartCapture={touchStart} onTouchMoveCapture={touchMove} onTouchEndCapture={touchEnd} onTouchCancelCapture={touchCancel}>
    <div className="renderer-host" ref={rendererRef} />
    <div className="gesture-layer" ref={overlayRef} aria-hidden="true" />
    <div className="inspector-guide" ref={guideRef} aria-hidden="true" hidden />
    <span className="window-readout" aria-label="Visible time window" ref={readoutRef}>{formatDate(store.get().from)} – {formatDate(store.get().to)}</span>
    {pin && <aside className="inspector" data-testid="inspector" aria-label="Pinned reading">
      <time data-testid="inspector-target" dateTime={new Date(pin.targetTime).toISOString()}>Pinned: {new Date(pin.targetTime).toLocaleString()}</time>
      {pin.rows.map((row, index) => row.kind === 'value' ? <div key={row.seriesId}><strong>{series[index]?.label}: {row.value} {row.unit}</strong><time dateTime={new Date(row.sampledAt).toISOString()}>{new Date(row.sampledAt).toLocaleString()}</time></div> : <div key={series[index]?.id ?? index}><strong>{series[index]?.label}</strong><span>Unavailable at this sample</span></div>)}
      <button type="button" data-testid="inspector-close" onClick={(event) => { event.stopPropagation(); setPin(null); if (guideRef.current) guideRef.current.hidden = true; }}>Close</button>
    </aside>}
  </div>;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}
