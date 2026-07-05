import { useEffect, useState } from 'react';

import type { SwtUnit } from './swt';

const SWT_UNIT_KEY = 'osi.display.swtUnit';
const PREFERENCES_EVENT = 'osi-display-preferences';

export interface DisplayPreferences {
  swtUnit: SwtUnit;
}

export function readDisplayPreferences(): DisplayPreferences {
  let swtUnit: SwtUnit = 'kPa';
  try {
    if (window.localStorage.getItem(SWT_UNIT_KEY) === 'pF') swtUnit = 'pF';
  } catch {
    // Storage can be unavailable in private mode or non-browser test contexts.
  }
  return { swtUnit };
}

export function writeDisplayPreferences(next: Partial<DisplayPreferences>): void {
  try {
    if (next.swtUnit) window.localStorage.setItem(SWT_UNIT_KEY, next.swtUnit);
    window.dispatchEvent(new Event(PREFERENCES_EVENT));
  } catch {
    // Keep the default session behavior when storage is unavailable.
  }
}

export function useDisplayPreferences(): DisplayPreferences {
  const [preferences, setPreferences] = useState<DisplayPreferences>(readDisplayPreferences);

  useEffect(() => {
    const onChange = () => setPreferences(readDisplayPreferences());
    window.addEventListener(PREFERENCES_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(PREFERENCES_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  return preferences;
}
