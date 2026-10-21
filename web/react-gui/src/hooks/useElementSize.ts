import { useCallback, useEffect, useRef, useState } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * Tracks an element's content box with ResizeObserver. Returns `null` until the
 * first non-zero measurement (and always where ResizeObserver is missing), so
 * callers can fall back to default geometry instead of laying out for 0 px.
 */
export function useElementSize<T extends HTMLElement>(): [(node: T | null) => void, ElementSize | null] {
  const [size, setSize] = useState<ElementSize | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (!rect || !(rect.width > 0)) return;
      const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
      setSize((current) => (current && current.width === next.width && current.height === next.height ? current : next));
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
  }, []);

  return [ref, size];
}
