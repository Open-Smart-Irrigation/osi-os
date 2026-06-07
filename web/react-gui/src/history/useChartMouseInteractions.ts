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
  const dragRef = useRef<{ startX: number; startVp: HistoryViewport } | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<HistoryViewport | null>(null);

  const commit = useCallback((vp: HistoryViewport) => {
    pending.current = vp;
    if (frame.current != null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (pending.current) onViewportChange(pending.current);
    });
  }, [onViewportChange]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const anchor = pixelToTime(rect, viewport, e.clientX);
      commit(zoomViewport(viewport, bounds, anchor, wheelZoomFactor(e.deltaY)));
    };
    const onDown = (e: MouseEvent) => { dragRef.current = { startX: e.clientX, startVp: viewport }; };
    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      setHoverMs(pixelToTime(rect, viewport, e.clientX));
      const drag = dragRef.current;
      if (!drag) return;
      const span = drag.startVp.toMs - drag.startVp.fromMs;
      const deltaMs = -((e.clientX - drag.startX) / rect.width) * span;
      commit(panViewport(drag.startVp, bounds, deltaMs));
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
      if (frame.current != null) cancelAnimationFrame(frame.current);
    };
  }, [viewport, bounds, commit, onReset]);

  return { ref, hoverMs };
}
