import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyThemePreference,
  readDisplayPreferences,
  resolvePreferredTimezone,
  useDisplayPreferences,
  writeDisplayPreferences,
} from '../displayPreferences';

describe('display preferences', () => {
  const defaultPreferences = {
    swtUnit: 'kPa',
    theme: 'system',
    dashboardDensity: 'comfortable',
    dashboardAutoRefresh: 'on',
    defaultTimezone: null,
    journalDetailLevel: 'farmer_quick',
    modules: {
      predictionAdvisory: false,
      environment: true,
      waterCard: true,
      schedulerUi: true,
    },
  };

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('returns defaults when storage is empty', () => {
    expect(readDisplayPreferences()).toEqual(defaultPreferences);
  });

  it('persists and reloads the SWT unit', () => {
    writeDisplayPreferences({ swtUnit: 'pF' });
    expect(window.localStorage.getItem('osi.display.swtUnit')).toBe('pF');
    expect(readDisplayPreferences()).toEqual({ ...defaultPreferences, swtUnit: 'pF' });
  });

  it('persists and reloads the theme without changing other defaults', () => {
    writeDisplayPreferences({ theme: 'dark' });
    expect(window.localStorage.getItem('osi.display.theme')).toBe('dark');
    expect(readDisplayPreferences()).toEqual({ ...defaultPreferences, theme: 'dark' });
  });

  it('persists and reloads dashboard module preferences', () => {
    writeDisplayPreferences({
      modules: {
        predictionAdvisory: true,
        environment: false,
        waterCard: false,
        schedulerUi: false,
      },
    });

    expect(window.localStorage.getItem('osi.modules.fieldWorkRequests')).toBeNull();
    expect(readDisplayPreferences().modules).toEqual({
      predictionAdvisory: true,
      environment: false,
      waterCard: false,
      schedulerUi: false,
    });
  });

  it('treats unknown stored values as kPa', () => {
    window.localStorage.setItem('osi.display.swtUnit', 'bars');
    expect(readDisplayPreferences()).toEqual(defaultPreferences);
  });

  it('defaults the journal detail level to farmer_quick', () => {
    expect(readDisplayPreferences().journalDetailLevel).toBe('farmer_quick');
  });

  it.each(['farmer_quick', 'full_record', 'research_observation'] as const)(
    'persists and reloads the journal detail level %s',
    (journalDetailLevel) => {
      writeDisplayPreferences({ journalDetailLevel });
      expect(window.localStorage.getItem('osi.journal.detailLevel')).toBe(journalDetailLevel);
      expect(readDisplayPreferences()).toEqual({ ...defaultPreferences, journalDetailLevel });
    },
  );

  it('falls back to the default journal detail level for an unknown stored value', () => {
    window.localStorage.setItem('osi.journal.detailLevel', 'expert_mode');
    expect(readDisplayPreferences()).toEqual(defaultPreferences);
  });

  it('dispatches the preferences event when the journal detail level is written', () => {
    const { result } = renderHook(() => useDisplayPreferences());
    expect(result.current.journalDetailLevel).toBe('farmer_quick');
    act(() => {
      writeDisplayPreferences({ journalDetailLevel: 'research_observation' });
    });
    expect(result.current.journalDetailLevel).toBe('research_observation');
  });

  it('applies explicit and system theme preferences to the document element', () => {
    applyThemePreference('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    const originalMatchMedia = window.matchMedia;
    try {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: () => ({ matches: true }),
      });
      applyThemePreference('system');
      expect(document.documentElement.dataset.theme).toBe('dark');

      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: undefined,
      });
      applyThemePreference('system');
      expect(document.documentElement.dataset.theme).toBe('light');
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  it('resolves timezone from storage, browser Intl, then UTC', () => {
    window.localStorage.setItem('osi.defaults.timezone', 'Europe/Zurich');
    expect(resolvePreferredTimezone()).toBe('Europe/Zurich');

    window.localStorage.removeItem('osi.defaults.timezone');
    const browserTimezone = resolvePreferredTimezone();
    expect(browserTimezone.length).toBeGreaterThan(0);

    const originalDateTimeFormat = Intl.DateTimeFormat;
    try {
      Object.defineProperty(Intl, 'DateTimeFormat', {
        configurable: true,
        value: () => ({
          resolvedOptions: () => ({ timeZone: '' }),
        }),
      });
      expect(resolvePreferredTimezone()).toBe('UTC');
    } finally {
      Object.defineProperty(Intl, 'DateTimeFormat', {
        configurable: true,
        value: originalDateTimeFormat,
      });
    }
  });

  it('trims timezone values when storing, reading, and resolving preferences', () => {
    writeDisplayPreferences({ defaultTimezone: '  Europe/Zurich  ' });

    expect(window.localStorage.getItem('osi.defaults.timezone')).toBe('Europe/Zurich');
    expect(readDisplayPreferences().defaultTimezone).toBe('Europe/Zurich');
    expect(resolvePreferredTimezone()).toBe('Europe/Zurich');

    window.localStorage.setItem('osi.defaults.timezone', '  UTC  ');
    expect(readDisplayPreferences().defaultTimezone).toBe('UTC');
    expect(resolvePreferredTimezone()).toBe('UTC');
  });

  it('returns defaults when storage is unavailable', () => {
    const originalStorage = window.localStorage;
    try {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
          getItem: () => {
            throw new Error('storage unavailable');
          },
          setItem: () => {
            throw new Error('storage unavailable');
          },
        },
      });

      expect(readDisplayPreferences()).toEqual(defaultPreferences);
      expect(() => writeDisplayPreferences({ theme: 'dark' })).not.toThrow();
    } finally {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: originalStorage,
      });
    }
  });

  it('updates live consumers when the preference changes', () => {
    const { result } = renderHook(() => useDisplayPreferences());
    expect(result.current.swtUnit).toBe('kPa');
    act(() => {
      writeDisplayPreferences({ swtUnit: 'pF' });
    });
    expect(result.current.swtUnit).toBe('pF');
  });
});
