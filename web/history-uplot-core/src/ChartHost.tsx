import { useEffect, useRef, useState } from 'react';
import { attachD3ViewportController, type D3ViewportController } from './shared/gestures';
import { inspectAtTime, inspectBucketAtTime, type Inspection } from './shared/inspection';
import type { ChartAdapter, ChartRenderOptions, CoverageWindow, MountAdapter, SensorSeries, Viewport } from './shared/types';
import { sameViewport, type ViewportStore } from './shared/viewport';

interface ChartHostBaseProps {
  mountAdapter: MountAdapter;
  series: readonly SensorSeries[];
  store: ViewportStore;
  extent: Viewport;
  minSpanMs?: number;
  maxSpanMs?: number;
  yRange?: ChartRenderOptions['yRange'];
  coverage?: CoverageWindow;
  notLoadedLabel?: string;
  labels?: { pinnedReading: string; close: string; unavailable: string; visibleWindow?: string; hourlyAverage?: string; bucketInterval?: (from: number, to: number) => string };
  focusedSeriesId?: string | null;
}
export type ChartHostProps = ChartHostBaseProps & (
  | { inspectionMode?: 'nearest-point'; locale?: never; timeZone?: never }
  | { inspectionMode: 'containing-bucket'; locale: string; timeZone: string }
);

interface Pin { targetTime: number; rows: readonly (Inspection | ReturnType<typeof inspectBucketAtTime>)[]; }

const DEFAULT_LABELS = { pinnedReading: 'Pinned reading', close: 'Close', unavailable: 'Unavailable at this sample', visibleWindow: 'Visible time window' };

export function ChartHost({ mountAdapter, series, store, extent, minSpanMs, maxSpanMs, yRange, coverage, notLoadedLabel = 'Not loaded', labels = DEFAULT_LABELS, focusedSeriesId = null, locale, timeZone, inspectionMode = 'nearest-point' }: ChartHostProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const adapterRef = useRef<ChartAdapter | null>(null);
  const controllerRef = useRef<D3ViewportController | null>(null);
  const [pin, setPin] = useState<Pin | null>(null);
  const [, setViewportVersion] = useState(0);
  const suppressClick = useRef(false);
  const touch = useRef({ moved: false, multi: false, cancelled: false, started: 0, x: 0, y: 0 });
  const viewport = store.get();
  const loadedFrom = coverage ? Math.max(viewport.from, Math.min(viewport.to, coverage.from)) : viewport.from;
  const loadedTo = coverage ? Math.max(viewport.from, Math.min(viewport.to, coverage.to)) : viewport.to;
  const leftCoverage = coverage ? Math.max(0, (loadedFrom - viewport.from) / (viewport.to - viewport.from)) * 100 : 0;
  const rightCoverage = coverage ? Math.max(0, (viewport.to - loadedTo) / (viewport.to - viewport.from)) * 100 : 0;

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
    const frame = frameRef.current;
    const renderer = rendererRef.current;
    const overlay = overlayRef.current;
    if (!frame || !renderer || !overlay) return undefined;
    let live = true;
    const onViewportChange = (viewport: Viewport) => {
      if (!live) return;
      const accepted = store.set(viewport, 'gesture');
      if (!sameViewport(viewport, accepted)) adapterRef.current?.setViewport(accepted);
    };
    const adapter = mountAdapter(renderer, store.get(), onViewportChange, { extent, minSpanMs, maxSpanMs, yRange, ...(inspectionMode === 'containing-bucket' ? { locale, timeZone } : {}) });
    adapterRef.current = adapter;
    adapter.setData(series);
    adapter.setViewport(store.get());
    adapter.resize();
    controllerRef.current = attachD3ViewportController(frame, overlay, adapter, store, { extent, minSpanMs, maxSpanMs });
    const resize = () => {
      if (!live) return;
      adapter.resize();
      controllerRef.current?.refreshGeometry();
      const currentPin = pinRef.current;
      if (currentPin) projectGuide(currentPin.targetTime, store.get());
    };
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    observer?.observe(frame);
    window.addEventListener('resize', resize);
    return () => {
      live = false;
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      controllerRef.current?.destroy();
      controllerRef.current = null;
      adapter.destroy();
      adapterRef.current = null;
    };
  }, [mountAdapter, store, minSpanMs, maxSpanMs, yRange, inspectionMode, locale, timeZone]);

  useEffect(() => {
    controllerRef.current?.updateExtent?.(extent);
    adapterRef.current?.setViewport(store.get());
  }, [extent.from, extent.to, minSpanMs, maxSpanMs, store]);

  const pinRef = useRef<Pin | null>(null);
  pinRef.current = pin;
  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter) return;
    adapter.setData(series);
    adapter.setViewport(store.get());
    adapter.setFocusedSeries?.(focusedSeriesId && series.some((item) => item.id === focusedSeriesId) ? focusedSeriesId : null);
    setPin(null);
  }, [series, store]); // focus is reapplied after data reconciliation below

  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter) return;
    adapter.setFocusedSeries?.(focusedSeriesId && series.some((item) => item.id === focusedSeriesId) ? focusedSeriesId : null);
  }, [focusedSeriesId, series]);

  useEffect(() => {
    const unsubscribe = store.subscribe((viewport, source) => {
      adapterRef.current?.setViewport(viewport);
      setViewportVersion((value) => value + 1);
      if (readoutRef.current) readoutRef.current.textContent = `${formatDate(viewport.from, locale, timeZone, inspectionMode === 'containing-bucket')} – ${formatDate(viewport.to, locale, timeZone, inspectionMode === 'containing-bucket')}`;
      if (pinRef.current) projectGuide(pinRef.current.targetTime, viewport);
      void source;
    });
    return unsubscribe;
  }, [store, locale, timeZone, inspectionMode]);

  useEffect(() => {
    return () => { pinRef.current = null; };
  }, [store]);

  const tap = (event: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    const adapter = adapterRef.current;
    const frame = frameRef.current;
    if (!adapter || !frame || series.length === 0) return;
    const plot = adapter.getPlotRect();
    if (event.clientX < plot.left || event.clientX > plot.left + plot.width || event.clientY < plot.top || event.clientY > plot.top + plot.height) return;
    const viewport = store.get();
    const targetTime = viewport.from + ((event.clientX - plot.left) / plot.width) * (viewport.to - viewport.from);
    const rows = inspectionMode === 'containing-bucket'
      ? series.map((item) => item.buckets ? inspectBucketAtTime(item.id, item.unit, item.buckets, targetTime) : { kind: 'bucket-unavailable' as const, from: targetTime, to: targetTime, count: 0, quality: null, unit: item.unit, seriesId: item.id })
      : inspectAtTime(series, targetTime, viewport);
    const nextPin = { targetTime, rows };
    pinRef.current = nextPin;
    setPin(nextPin);
    projectGuide(targetTime, viewport);
  };
  const touchStart = (event: React.TouchEvent) => {
    const point = event.touches[0];
    touch.current = { moved: false, multi: event.touches.length > 1, cancelled: false, started: Date.now(), x: point?.clientX ?? 0, y: point?.clientY ?? 0 };
  };
  const touchMove = (event: React.TouchEvent) => {
    const state = touch.current;
    const point = event.touches[0];
    state.multi ||= event.touches.length > 1;
    state.moved ||= !!point && Math.hypot(point.clientX - state.x, point.clientY - state.y) > 4;
  };
  const touchEnd = () => {
    const state = touch.current;
    suppressClick.current = state.cancelled || state.multi || state.moved || Date.now() - state.started >= 500;
  };

  return <div className="chart-host" data-testid="chart-host" ref={frameRef} onClick={tap} onTouchStartCapture={touchStart} onTouchMoveCapture={touchMove} onTouchEndCapture={touchEnd} onTouchCancelCapture={() => { touch.current.cancelled = true; touchEnd(); }}>
    <div className="renderer-host" ref={rendererRef} />
    <div className="gesture-layer" ref={overlayRef} aria-hidden="true" />
    <div className="inspector-guide" ref={guideRef} aria-hidden="true" hidden />
    <span className="window-readout" role="group" aria-label={labels.visibleWindow ?? DEFAULT_LABELS.visibleWindow} ref={readoutRef}>{formatDate(store.get().from, locale, timeZone, inspectionMode === 'containing-bucket')} – {formatDate(store.get().to, locale, timeZone, inspectionMode === 'containing-bucket')}</span>
    {coverage && leftCoverage > 0 && <div className="not-loaded not-loaded-left" style={{ width: `${leftCoverage}%` }} role="img" aria-label={notLoadedLabel} />}
    {coverage && rightCoverage > 0 && <div className="not-loaded not-loaded-right" style={{ width: `${rightCoverage}%` }} role="img" aria-label={notLoadedLabel} />}
      {pin && <aside className="inspector" data-testid="inspector" aria-label={labels.pinnedReading}>
      <time data-testid="inspector-target" dateTime={new Date(pin.targetTime).toISOString()}>{labels.pinnedReading}: {formatDate(pin.targetTime, locale, timeZone, inspectionMode === 'containing-bucket')}</time>
      {pin.rows.map((row, index) => row.kind === 'value' ? <div key={row.seriesId}><strong>{series[index]?.label}: {formatValue(row.value, locale)} {row.unit}</strong><time dateTime={new Date(row.sampledAt).toISOString()}>{formatDate(row.sampledAt, locale, timeZone)}</time></div> : row.kind === 'bucket' ? <div key={row.seriesId}><strong>{series[index]?.label}: {formatValue(row.value, locale)} {row.unit}</strong><span>{labels.hourlyAverage ?? 'Hourly average'} {labels.bucketInterval?.(row.from, row.to) ?? `${formatDate(row.from, locale, timeZone)} – ${formatDate(row.to, locale, timeZone)}`}</span></div> : <div key={series[index]?.id ?? index}><strong>{series[index]?.label}</strong><span>{labels.unavailable}</span></div>)}
      <button type="button" data-testid="inspector-close" onClick={(event) => { event.stopPropagation(); pinRef.current = null; setPin(null); if (guideRef.current) guideRef.current.hidden = true; }}>{labels.close}</button>
    </aside>}
  </div>;
}

function formatDate(timestamp: number, locale?: string, timeZone?: string, explicit = false): string {
  if (!explicit) return new Date(timestamp).toLocaleString();
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone }).format(timestamp);
}

function formatValue(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumSignificantDigits: 6 }).format(value);
}
