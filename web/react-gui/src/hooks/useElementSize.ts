import { useCallback, useEffect, useRef, useState } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

export interface ElementSizeOptions {
  /**
   * Quantum in px. Sizes are floored to a multiple of it, so a resize smaller
   * than the step keeps the previous object and does not re-render. Charts use
   * 16 px: every new size rebuilds the chart option. Default 1 (whole pixels).
   */
  step?: number;
}

/**
 * Tracks an element's content box with ResizeObserver. Returns `null` until the
 * first non-zero measurement (and always where ResizeObserver is missing), so
 * callers can fall back to default geometry instead of laying out for 0 px.
 */
export function useElementSize<T extends HTMLElement>(options: ElementSizeOptions = {}): [(node: T | null) => void, ElementSize | null] {
  const step = Math.max(1, Math.floor(options.step ?? 1));
  const [size, setSize] = useState<ElementSize | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const lastRef = useRef<ElementSize | null>(null);

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (!rect || !(rect.width > 0)) return;
      const quantise = (value: number) => (step === 1 ? Math.round(value) : Math.max(step, Math.floor(value / step) * step));
      const next = { width: quantise(rect.width), height: quantise(rect.height) };
      const last = lastRef.current;
      if (last && last.width === next.width && last.height === next.height) return;
      lastRef.current = next;
      setSize(next);
    });
    observer.observe(node);
    observerRef.current = observer;
  }, [step]);

  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
  }, []);

  return [ref, size];
}
