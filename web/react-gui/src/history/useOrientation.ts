import { useEffect, useState } from 'react';

export type ViewportOrientation = 'landscape' | 'portrait';

const LANDSCAPE_QUERY = '(orientation: landscape)';

export function orientationFromQuery(isLandscape: boolean): ViewportOrientation {
  return isLandscape ? 'landscape' : 'portrait';
}

function currentOrientation(): ViewportOrientation {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'portrait';
  return orientationFromQuery(window.matchMedia(LANDSCAPE_QUERY).matches);
}

export function useOrientation(): ViewportOrientation {
  const [orientation, setOrientation] = useState<ViewportOrientation>(currentOrientation);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(LANDSCAPE_QUERY);
    const update = () => setOrientation(orientationFromQuery(query.matches));
    update();

    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', update);
      return () => query.removeEventListener('change', update);
    }

    query.addListener?.(update);
    return () => query.removeListener?.(update);
  }, []);

  return orientation;
}
