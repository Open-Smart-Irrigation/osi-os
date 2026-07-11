import { useEffect, useState } from 'react';

const HOVER_QUERY = '(hover: hover) and (pointer: fine)';

function currentHoverCapability(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(HOVER_QUERY).matches;
}

export function useHoverCapable(): boolean {
  const [hoverCapable, setHoverCapable] = useState(currentHoverCapability);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mediaQuery = window.matchMedia(HOVER_QUERY);
    const onChange = (event: MediaQueryListEvent) => setHoverCapable(event.matches);
    mediaQuery.addEventListener?.('change', onChange);
    return () => mediaQuery.removeEventListener?.('change', onChange);
  }, []);

  return hoverCapable;
}
