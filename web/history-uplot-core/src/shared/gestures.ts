import { select } from 'd3-selection';
import { zoom, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import { HOUR_MS, type ChartAdapter, type Viewport } from './types';
import { sameViewport, transformToViewport, viewportToTransform, type ViewportStore } from './viewport';

export interface D3ViewportController {
  sync(viewport: Viewport): void;
  updateExtent?(extent: Viewport): void;
  refreshGeometry(): void;
  destroy(): void;
}
export function viewportZoomScaleExtent(extent: Viewport, minSpanMs: number, maxSpanMs = extent.to - extent.from): [number, number] {
  return [Math.max(1, (extent.to - extent.from) / maxSpanMs), Math.max(1, (extent.to - extent.from) / minSpanMs)];
}

export function attachD3ViewportController(
  host: HTMLElement,
  layer: HTMLElement,
  adapter: ChartAdapter,
  store: ViewportStore,
  options: { extent?: Viewport; minSpanMs?: number; maxSpanMs?: number } = {},
): D3ViewportController {
  const selection = select(layer);
  let extent = options.extent ?? { from: 0, to: Date.now() };
  const minSpanMs = options.minSpanMs ?? HOUR_MS;
  let maxSpanMs = Math.min(extent.to - extent.from, options.maxSpanMs ?? extent.to - extent.from);
  let width = 0;
  let height = 0;
  let destroyed = false;
  let syncing = false;
  let pendingViewport: Viewport | null = null;
  let frameId: number | null = null;

  const behavior: ZoomBehavior<HTMLElement, unknown> = zoom<HTMLElement, unknown>()
    .scaleExtent(viewportZoomScaleExtent(extent, minSpanMs, maxSpanMs))
    .filter((event: Event) => event.type.startsWith('touch'))
    .touchable(() => true)
    .on('zoom', (event) => {
      if (syncing || destroyed) return;
      const transform = event.transform as ZoomTransform;
      pendingViewport = transformToViewport(transform, extent, width, store.get(), minSpanMs, maxSpanMs);
      if (frameId === null) frameId = window.requestAnimationFrame(flushPending);
    })
    .on('end', (event) => {
      if (destroyed || syncing) return;
      if (event.sourceEvent?.type === 'touchcancel') {
        if (frameId !== null) window.cancelAnimationFrame(frameId);
        frameId = null;
        pendingViewport = null;
        sync(store.get());
      } else {
        if (frameId !== null) window.cancelAnimationFrame(frameId);
        frameId = null;
        flushPending();
      }
    });

  function flushPending(): void {
    frameId = null;
    if (destroyed || !pendingViewport) return;
    const proposal = pendingViewport;
    pendingViewport = null;
    const before = store.get();
    const accepted = store.set(proposal, 'gesture');
    if (!sameViewport(before, accepted)) adapter.setViewport(accepted);
  }

  function refreshGeometry(): void {
    if (destroyed) return;
    const hostRect = host.getBoundingClientRect();
    const plotRect = adapter.getPlotRect();
    width = Math.max(0, plotRect.width);
    height = Math.max(0, plotRect.height);
    layer.style.position = 'absolute';
    layer.style.left = `${plotRect.left - hostRect.left}px`;
    layer.style.top = `${plotRect.top - hostRect.top}px`;
    layer.style.width = `${width}px`;
    layer.style.height = `${height}px`;
    layer.style.touchAction = 'none';
    layer.style.userSelect = 'none';
    behavior.extent([[0, 0], [width, height]]).translateExtent([[0, 0], [width, height]]);
    selection.call(behavior).on('dblclick.zoom', null);
  }

  function sync(viewport: Viewport): void {
    if (destroyed || width <= 0) return;
    syncing = true;
    try {
      selection.call(behavior.transform, viewportToTransform(viewport, extent, width));
    } finally {
      syncing = false;
    }
  }

  function updateExtent(nextExtent: Viewport): void {
    extent = { ...nextExtent };
    maxSpanMs = Math.min(extent.to - extent.from, options.maxSpanMs ?? extent.to - extent.from);
    behavior.scaleExtent(viewportZoomScaleExtent(extent, minSpanMs, maxSpanMs));
    refreshGeometry();
    sync(store.get());
  }

  const onScroll = () => refreshGeometry();
  window.addEventListener('scroll', onScroll, { passive: true });
  const unsubscribe = store.subscribe((_viewport, source) => {
    if (source === 'external') sync(store.get());
  });

  let observedWidth = 0;
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    if (destroyed) return;
    adapter.resize();
    const previous = observedWidth;
    refreshGeometry();
    observedWidth = width;
    if (previous !== width) sync(store.get());
  });
  observer?.observe(host);

  refreshGeometry();
  observedWidth = width;
  sync(store.get());

  return {
    sync,
    updateExtent,
    refreshGeometry,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      frameId = null;
      pendingViewport = null;
      unsubscribe();
      observer?.disconnect();
      window.removeEventListener('scroll', onScroll);
      selection.on('.zoom', null);
    },
  };
}
