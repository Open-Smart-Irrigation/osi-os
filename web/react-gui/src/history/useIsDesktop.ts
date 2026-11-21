import { useEffect, useState } from 'react';

export const DESKTOP_MIN_WIDTH = 1024;

export function useIsDesktop(): boolean {
  const query = `(min-width: ${DESKTOP_MIN_WIDTH}px)`;
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.(query).matches ?? window.innerWidth >= DESKTOP_MIN_WIDTH;
  });
  useEffect(() => {
    const mql = window.matchMedia?.(query);
    const onChange = () => setIsDesktop(mql?.matches ?? window.innerWidth >= DESKTOP_MIN_WIDTH);
    onChange();
    if (typeof mql?.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    if (typeof mql?.addListener === 'function') {
      mql.addListener(onChange);
      return () => mql.removeListener(onChange);
    }
    window.addEventListener('resize', onChange);
    return () => window.removeEventListener('resize', onChange);
  }, [query]);
  return isDesktop;
}
