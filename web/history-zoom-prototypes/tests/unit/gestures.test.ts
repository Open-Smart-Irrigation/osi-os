import { afterEach, describe, expect, test, vi } from 'vitest';
import { FIXTURE_EXTENT, HOUR_MS, INITIAL_VIEWPORT, type ChartAdapter, type Viewport } from '../../src/shared/types';
import { createViewportStore } from '../../src/shared/viewport';
import { attachD3ViewportController, viewportZoomScaleExtent } from '../../src/shared/gestures';

function rect(left: number, top: number, width: number, height: number): DOMRectReadOnly {
  return new DOMRectReadOnly(left, top, width, height);
}

function harness() {
  const host = document.createElement('div');
  const layer = document.createElement('div');
  layer.className = 'gesture-layer';
  host.append(layer);
  document.body.append(host);
  let plot = rect(70, 40, 300, 280);
  let renderedViewport = INITIAL_VIEWPORT;
  const adapter: ChartAdapter = {
    setData: vi.fn(),
    setViewport: vi.fn((viewport: Viewport) => { renderedViewport = viewport; }),
    getViewport: () => renderedViewport,
    getPlotRect: () => plot, resize: vi.fn(), destroy: vi.fn(),
  };
  const store = createViewportStore(INITIAL_VIEWPORT, FIXTURE_EXTENT);
  return { host, layer, adapter, store, setPlot: (next: DOMRectReadOnly) => { plot = next; } };
}

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('D3 viewport controller', () => {
  test('uses an explicit maximum span while preserving the full-extent default', () => {
    const extent = { from: 0, to: 365 * 86_400_000 };
    expect(viewportZoomScaleExtent(extent, HOUR_MS, 90 * 86_400_000)[0]).toBeCloseTo(365 / 90);
    expect(viewportZoomScaleExtent(extent, HOUR_MS)[0]).toBe(1);
  });
  test('refreshGeometry anchors the layer to the live plot rect', () => {
    const h = harness();
    vi.spyOn(h.host, 'getBoundingClientRect').mockReturnValue(rect(50, 20, 390, 360));
    const controller = attachD3ViewportController(h.host, h.layer, h.adapter, h.store);
    expect(h.layer.style.left).toBe('20px');
    expect(h.layer.style.top).toBe('20px');
    expect(h.layer.style.width).toBe('300px');
    expect(h.layer.style.height).toBe('280px');
    h.setPlot(rect(90, 60, 240, 200));
    controller.refreshGeometry();
    expect(h.layer.style.left).toBe('40px');
    expect(h.layer.style.top).toBe('40px');
    expect(h.layer.style.width).toBe('240px');
    controller.destroy();
  });

  test('passive scroll refreshes position without resizing the adapter', () => {
    const h = harness();
    const hostRect = vi.spyOn(h.host, 'getBoundingClientRect').mockReturnValue(rect(50, 20, 390, 360));
    const controller = attachD3ViewportController(h.host, h.layer, h.adapter, h.store);
    hostRect.mockReturnValue(rect(30, 10, 390, 360));
    h.layer.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(h.layer.style.left).toBe('40px');
    expect(h.adapter.resize).not.toHaveBeenCalled();
    controller.destroy();
  });

  test('external sync updates D3 without notifying or rendering the store', () => {
    const h = harness();
    vi.spyOn(h.host, 'getBoundingClientRect').mockReturnValue(rect(50, 20, 390, 360));
    const notifications: Viewport[] = [];
    h.store.subscribe((viewport) => notifications.push(viewport));
    const controller = attachD3ViewportController(h.host, h.layer, h.adapter, h.store);
    const next = { from: INITIAL_VIEWPORT.from - 3 * 60_000, to: INITIAL_VIEWPORT.to - 3 * 60_000 };
    controller.sync(next);
    expect(notifications).toHaveLength(0);
    expect(h.adapter.setViewport).not.toHaveBeenCalled();
    controller.destroy();
  });

  test('touch zoom is coalesced to one frame and final state flushes on end', () => {
    const h = harness();
    vi.spyOn(h.host, 'getBoundingClientRect').mockReturnValue(rect(50, 20, 390, 360));
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 17);
    const controller = attachD3ViewportController(h.host, h.layer, h.adapter, h.store);
    const touch = new Event('touchstart', { bubbles: true });
    Object.defineProperty(touch, 'touches', { value: [{ identifier: 1, clientX: 100, clientY: 80 }] });
    Object.defineProperty(touch, 'changedTouches', { value: [{ identifier: 1, clientX: 100, clientY: 80 }] });
    h.layer.dispatchEvent(touch);
    const move1 = new Event('touchmove', { bubbles: true });
    Object.defineProperty(move1, 'changedTouches', { value: [{ identifier: 1, clientX: 130, clientY: 80 }] });
    h.layer.dispatchEvent(move1);
    const move2 = new Event('touchmove', { bubbles: true });
    Object.defineProperty(move2, 'changedTouches', { value: [{ identifier: 1, clientX: 160, clientY: 80 }] });
    h.layer.dispatchEvent(move2);
    expect(raf).toHaveBeenCalledTimes(1);
    const end = new Event('touchend', { bubbles: true });
    Object.defineProperty(end, 'changedTouches', { value: [{ identifier: 1, clientX: 160, clientY: 80 }] });
    h.layer.dispatchEvent(end);
    expect(h.adapter.setViewport).toHaveBeenCalledTimes(1);
    expect(h.store.get()).not.toEqual(INITIAL_VIEWPORT);
    expect(h.adapter.getViewport()).toEqual(h.store.get());
    controller.destroy();
  });

  test('double tap inspection does not zoom the viewport', () => {
    vi.useFakeTimers();
    const h = harness();
    vi.spyOn(h.host, 'getBoundingClientRect').mockReturnValue(rect(50, 20, 390, 360));
    const controller = attachD3ViewportController(h.host, h.layer, h.adapter, h.store);
    const tap = (identifier: number) => {
      const point = { identifier, clientX: 150, clientY: 120 };
      const start = new Event('touchstart', { bubbles: true });
      Object.defineProperty(start, 'touches', { value: [point] });
      Object.defineProperty(start, 'changedTouches', { value: [point] });
      h.layer.dispatchEvent(start);
      const end = new Event('touchend', { bubbles: true });
      Object.defineProperty(end, 'touches', { value: [] });
      Object.defineProperty(end, 'changedTouches', { value: [point] });
      h.layer.dispatchEvent(end);
    };

    try {
      tap(1);
      tap(2);
      vi.advanceTimersByTime(300);

      expect(h.store.get()).toEqual(INITIAL_VIEWPORT);
      expect(h.adapter.setViewport).not.toHaveBeenCalled();
    } finally {
      controller.destroy();
      vi.useRealTimers();
    }
  });

  test('destroy is idempotent and removes active gesture listeners', () => {
    const h = harness();
    vi.spyOn(h.host, 'getBoundingClientRect').mockReturnValue(rect(50, 20, 390, 360));
    const controller = attachD3ViewportController(h.host, h.layer, h.adapter, h.store);
    const unsubscribe = vi.spyOn(h.store, 'subscribe');
    controller.destroy();
    controller.destroy();
    expect(unsubscribe).not.toHaveBeenCalled();
    const event = new Event('touchstart', { bubbles: true });
    Object.defineProperty(event, 'touches', { value: [{ identifier: 1, clientX: 100, clientY: 80 }] });
    Object.defineProperty(event, 'changedTouches', { value: [{ identifier: 1, clientX: 100, clientY: 80 }] });
    h.layer.dispatchEvent(event);
    expect(h.adapter.setViewport).not.toHaveBeenCalled();
    const before = h.layer.style.transform;
    h.store.set({ from: INITIAL_VIEWPORT.from - 3 * 60_000, to: INITIAL_VIEWPORT.to - 3 * 60_000 }, 'external');
    expect(h.layer.style.transform).toBe(before);
    expect(h.adapter.setViewport).not.toHaveBeenCalled();
  });

  test('touchcancel discards an unflushed proposal and restores the store transform', () => {
    const h = harness();
    vi.spyOn(h.host, 'getBoundingClientRect').mockReturnValue(rect(50, 20, 390, 360));
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 11);
    const controller = attachD3ViewportController(h.host, h.layer, h.adapter, h.store);
    const start = new Event('touchstart', { bubbles: true });
    const touch = { identifier: 1, clientX: 100, clientY: 80 };
    Object.defineProperty(start, 'touches', { value: [touch] });
    Object.defineProperty(start, 'changedTouches', { value: [touch] });
    h.layer.dispatchEvent(start);
    const move = new Event('touchmove', { bubbles: true });
    Object.defineProperty(move, 'changedTouches', { value: [{ ...touch, clientX: 160 }] });
    h.layer.dispatchEvent(move);
    const cancel = new Event('touchcancel', { bubbles: true });
    Object.defineProperty(cancel, 'changedTouches', { value: [{ ...touch, clientX: 160 }] });
    h.layer.dispatchEvent(cancel);
    expect(h.store.get()).toEqual(INITIAL_VIEWPORT);
    expect(h.adapter.setViewport).not.toHaveBeenCalled();
    controller.destroy();
  });

  test('derives zoom limits from a supplied extent and minimum span', () => {
    const extent = { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 3, 1) };
    expect(viewportZoomScaleExtent(extent, HOUR_MS)).toEqual([1, (extent.to - extent.from) / HOUR_MS]);
    const h = harness();
    const store = createViewportStore({ from: extent.to - 24 * HOUR_MS, to: extent.to }, extent, HOUR_MS);
    vi.spyOn(h.host, 'getBoundingClientRect').mockReturnValue(rect(50, 20, 390, 360));
    const controller = attachD3ViewportController(h.host, h.layer, h.adapter, store, { extent, minSpanMs: HOUR_MS });
    const zoomBehavior = (h.layer as HTMLElement & { __zoom?: { k: number } }).__zoom;
    expect(zoomBehavior?.k).toBe((extent.to - extent.from) / (24 * HOUR_MS));
    controller.destroy();
  });
});
