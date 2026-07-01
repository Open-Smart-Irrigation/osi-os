import { useCallback, useEffect, useRef, useState } from 'react';
import { panViewport, zoomViewport, type HistoryViewport, type ViewportBounds } from './historyViewport';

export function pixelToTime(rect: { left: number; width: number }, vp: HistoryViewport, clientX: number): number {
  if (rect.width <= 0) return vp.fromMs;
  const rel = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
  return vp.fromMs + rel * (vp.toMs - vp.fromMs);
}

export function wheelZoomFactor(deltaY: number): number {
  const step = Math.min(Math.max(deltaY / 1000, -0.2), 0.2);
  return 1 + step;
}

export interface ChartMouseOptions {
  viewport: HistoryViewport;
  bounds: ViewportBounds;
  onViewportChange: (vp: HistoryViewport) => void;
  onReset: () => void;
}

export function useChartMouseInteractions({ viewport, bounds, onViewportChange, onReset }: ChartMouseOptions) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const dragRef = useRef<{ lastX: number } | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<HistoryViewport | null>(null);
  const viewportRef = useRef(viewport);
  const boundsRef = useRef(bounds);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    boundsRef.current = bounds;
  }, [bounds]);

  const currentViewport = useCallback(() => pending.current ?? viewportRef.current, []);

  const commit = useCallback((vp: HistoryViewport) => {
    pending.current = vp;
    if (frame.current != null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (pending.current) {
        viewportRef.current = pending.current;
        onViewportChange(pending.current);
        pending.current = null;
      }
    });
  }, [onViewportChange]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const baseViewport = currentViewport();
      const anchor = pixelToTime(rect, baseViewport, e.clientX);
      commit(zoomViewport(baseViewport, boundsRef.current, anchor, wheelZoomFactor(e.deltaY)));
    };
    const onDown = (e: MouseEvent) => { dragRef.current = { lastX: e.clientX }; };
    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const baseViewport = currentViewport();
      setHoverMs(pixelToTime(rect, baseViewport, e.clientX));
      const drag = dragRef.current;
      if (!drag) return;
      const span = baseViewport.toMs - baseViewport.fromMs;
      const deltaMs = -((e.clientX - drag.lastX) / rect.width) * span;
      drag.lastX = e.clientX;
      commit(panViewport(baseViewport, boundsRef.current, deltaMs));
    };
    const onUp = () => { dragRef.current = null; };
    const onLeave = () => { setHoverMs(null); dragRef.current = null; };
    const onDouble = () => onReset();
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    el.addEventListener('mouseleave', onLeave);
    el.addEventListener('dblclick', onDouble);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      el.removeEventListener('mouseleave', onLeave);
      el.removeEventListener('dblclick', onDouble);
      if (frame.current != null) { cancelAnimationFrame(frame.current); frame.current = null; }
      pending.current = null;
    };
  }, [commit, currentViewport, onReset]);

  return { ref, hoverMs };
}
