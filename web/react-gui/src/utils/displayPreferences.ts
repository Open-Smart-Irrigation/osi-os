import { useEffect, useState } from 'react';

import type { SwtUnit } from './swt';

const SWT_UNIT_KEY = 'osi.display.swtUnit';
const THEME_KEY = 'osi.display.theme';
const DASHBOARD_DENSITY_KEY = 'osi.display.dashboardDensity';
const DASHBOARD_AUTO_REFRESH_KEY = 'osi.display.dashboardAutoRefresh';
const DEFAULT_TIMEZONE_KEY = 'osi.defaults.timezone';
const JOURNAL_DETAIL_LEVEL_KEY = 'osi.journal.detailLevel';
const MODULE_KEYS = {
  predictionAdvisory: 'osi.modules.predictionAdvisory',
  environment: 'osi.modules.environment',
  waterCard: 'osi.modules.waterCard',
  schedulerUi: 'osi.modules.schedulerUi',
} as const;
const PREFERENCES_EVENT = 'osi-display-preferences';

export type ThemePreference = 'light' | 'dark' | 'system';
export type DashboardDensity = 'comfortable' | 'compact';
// Owner decision (2026-07): the user-selectable setting only ever offers
// Quick or Full — "Research" is not a choice a farmer/user makes here. The
// capture flow's `research_observation` template still exists and is still
// reachable as a per-layout FLOOR (a researcher-only layout forces it
// regardless of this preference — see JournalCaptureFlow's
// effectiveTemplateCode, which is untyped against this setting on purpose),
// so removing it from this type only removes it as a settable preference.
export type JournalDetailLevel = 'farmer_quick' | 'full_record';

const JOURNAL_DETAIL_LEVELS: readonly JournalDetailLevel[] = ['farmer_quick', 'full_record'];
const DEFAULT_JOURNAL_DETAIL_LEVEL: JournalDetailLevel = 'farmer_quick';
// A pre-dropped-Research install may still have this in localStorage; map it
// to the closest surviving option instead of falling all the way back to the
// default (Quick), which would silently downgrade a user who had chosen the
// most detail available.
const LEGACY_RESEARCH_DETAIL_LEVEL = 'research_observation';

function isJournalDetailLevel(value: string | null): value is JournalDetailLevel {
  return value != null && (JOURNAL_DETAIL_LEVELS as readonly string[]).includes(value);
}

function normalizeJournalDetailLevel(value: string | null): JournalDetailLevel {
  if (value === LEGACY_RESEARCH_DETAIL_LEVEL) return 'full_record';
  return isJournalDetailLevel(value) ? value : DEFAULT_JOURNAL_DETAIL_LEVEL;
}

export interface ModulePreferences {
  predictionAdvisory: boolean;
  environment: boolean;
  waterCard: boolean;
  schedulerUi: boolean;
}

export interface DisplayPreferences {
  swtUnit: SwtUnit;
  theme: ThemePreference;
  dashboardDensity: DashboardDensity;
  dashboardAutoRefresh: 'on' | 'off';
  defaultTimezone: string | null;
  journalDetailLevel: JournalDetailLevel;
  modules: ModulePreferences;
}

const DEFAULT_MODULES: ModulePreferences = {
  predictionAdvisory: false,
  environment: true,
  waterCard: true,
  schedulerUi: true,
};

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Keep the default session behavior when storage is unavailable.
  }
}

function readBooleanPreference(key: string, fallback: boolean): boolean {
  const stored = readStorage(key);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return fallback;
}

function normalizeStoredString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function dispatchPreferencesEvent(): void {
  try {
    window.dispatchEvent(new Event(PREFERENCES_EVENT));
  } catch {
    // Non-browser contexts can read defaults without a live event target.
  }
}

function resolveSystemTheme(): 'light' | 'dark' {
  if (typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function readDisplayPreferences(): DisplayPreferences {
  const swtUnit: SwtUnit = readStorage(SWT_UNIT_KEY) === 'pF' ? 'pF' : 'kPa';
  const storedTheme = readStorage(THEME_KEY);
  const theme: ThemePreference = storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : 'system';
  const storedDensity = readStorage(DASHBOARD_DENSITY_KEY);
  const dashboardDensity: DashboardDensity = storedDensity === 'compact' ? 'compact' : 'comfortable';
  const dashboardAutoRefresh = readStorage(DASHBOARD_AUTO_REFRESH_KEY) === 'off' ? 'off' : 'on';
  const storedTimezone = normalizeStoredString(readStorage(DEFAULT_TIMEZONE_KEY));
  const storedDetailLevel = readStorage(JOURNAL_DETAIL_LEVEL_KEY);
  const journalDetailLevel: JournalDetailLevel = normalizeJournalDetailLevel(storedDetailLevel);

  return {
    swtUnit,
    theme,
    dashboardDensity,
    dashboardAutoRefresh,
    defaultTimezone: storedTimezone,
    journalDetailLevel,
    modules: {
      predictionAdvisory: readBooleanPreference(MODULE_KEYS.predictionAdvisory, DEFAULT_MODULES.predictionAdvisory),
      environment: readBooleanPreference(MODULE_KEYS.environment, DEFAULT_MODULES.environment),
      waterCard: readBooleanPreference(MODULE_KEYS.waterCard, DEFAULT_MODULES.waterCard),
      schedulerUi: readBooleanPreference(MODULE_KEYS.schedulerUi, DEFAULT_MODULES.schedulerUi),
    },
  };
}

export function writeDisplayPreferences(next: Partial<DisplayPreferences>): void {
  if (next.swtUnit === 'kPa' || next.swtUnit === 'pF') writeStorage(SWT_UNIT_KEY, next.swtUnit);
  if (next.theme === 'light' || next.theme === 'dark' || next.theme === 'system') writeStorage(THEME_KEY, next.theme);
  if (next.dashboardDensity === 'comfortable' || next.dashboardDensity === 'compact') {
    writeStorage(DASHBOARD_DENSITY_KEY, next.dashboardDensity);
  }
  if (next.dashboardAutoRefresh === 'on' || next.dashboardAutoRefresh === 'off') {
    writeStorage(DASHBOARD_AUTO_REFRESH_KEY, next.dashboardAutoRefresh);
  }
  if (Object.prototype.hasOwnProperty.call(next, 'defaultTimezone')) {
    writeStorage(DEFAULT_TIMEZONE_KEY, normalizeStoredString(next.defaultTimezone));
  }
  if (isJournalDetailLevel(next.journalDetailLevel ?? null)) {
    writeStorage(JOURNAL_DETAIL_LEVEL_KEY, next.journalDetailLevel as JournalDetailLevel);
  }
  if (next.modules) {
    writeStorage(MODULE_KEYS.predictionAdvisory, String(next.modules.predictionAdvisory));
    writeStorage(MODULE_KEYS.environment, String(next.modules.environment));
    writeStorage(MODULE_KEYS.waterCard, String(next.modules.waterCard));
    writeStorage(MODULE_KEYS.schedulerUi, String(next.modules.schedulerUi));
  }
  dispatchPreferencesEvent();
}

export function applyThemePreference(theme: ThemePreference): void {
  document.documentElement.dataset.theme = theme === 'system' ? resolveSystemTheme() : theme;
}

export function resolvePreferredTimezone(): string {
  const stored = normalizeStoredString(readStorage(DEFAULT_TIMEZONE_KEY));
  if (stored) return stored;

  try {
    const browserTimezone = normalizeStoredString(Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (browserTimezone) return browserTimezone;
  } catch {
    // Fall through to the explicit default.
  }

  return 'UTC';
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
