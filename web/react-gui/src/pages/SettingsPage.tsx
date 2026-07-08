import { useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { LanguageSwitcher } from '../components/LanguageSwitcher';
import {
  applyThemePreference,
  type DashboardDensity,
  type DisplayPreferences,
  type ThemePreference,
  useDisplayPreferences,
  writeDisplayPreferences,
} from '../utils/displayPreferences';
import { formatSwtValue, type SwtUnit } from '../utils/swt';

type AutoRefreshPreference = DisplayPreferences['dashboardAutoRefresh'];

interface Option<T extends string> {
  value: T;
  label: string;
}

function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<Option<T>>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold text-[var(--text-secondary)]">{label}</p>
      <div className="inline-flex flex-wrap overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(option.value)}
              className={`min-h-11 px-4 py-2 text-sm font-bold transition-colors ${
                selected
                  ? 'bg-[var(--primary)] text-white'
                  : 'text-[var(--text)] hover:bg-[var(--secondary-bg)]'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-[var(--border)] py-6 last:border-b-0">
      <h2 className="text-xl font-bold text-[var(--text)]">{title}</h2>
      <div className="mt-4 grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(16rem,24rem)] md:items-start">
        {children}
      </div>
    </section>
  );
}

export function SettingsPage() {
  const { t } = useTranslation('settings');
  const preferences = useDisplayPreferences();

  const themeOptions = useMemo<Array<Option<ThemePreference>>>(
    () => [
      { value: 'light', label: t('light') },
      { value: 'dark', label: t('dark') },
      { value: 'system', label: t('system') },
    ],
    [t],
  );
  const swtOptions = useMemo<Array<Option<SwtUnit>>>(
    () => [
      { value: 'kPa', label: t('kpa') },
      { value: 'pF', label: t('pf') },
    ],
    [t],
  );
  const densityOptions = useMemo<Array<Option<DashboardDensity>>>(
    () => [
      { value: 'comfortable', label: t('comfortable') },
      { value: 'compact', label: t('compact') },
    ],
    [t],
  );
  const refreshOptions = useMemo<Array<Option<AutoRefreshPreference>>>(
    () => [
      { value: 'on', label: t('on') },
      { value: 'off', label: t('off') },
    ],
    [t],
  );

  const updateTheme = (theme: ThemePreference) => {
    writeDisplayPreferences({ theme });
    applyThemePreference(theme);
  };

  const updateSwtUnit = (swtUnit: SwtUnit) => writeDisplayPreferences({ swtUnit });
  const updateDensity = (dashboardDensity: DashboardDensity) => writeDisplayPreferences({ dashboardDensity });
  const updateRefresh = (dashboardAutoRefresh: AutoRefreshPreference) => writeDisplayPreferences({ dashboardAutoRefresh });

  useEffect(() => {
    applyThemePreference(preferences.theme);
  }, [preferences.theme]);

  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
        <Link
          to="/dashboard"
          className="inline-flex min-h-11 items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-bold text-[var(--text)] hover:bg-[var(--secondary-bg)]"
        >
          {t('backToDashboard')}
        </Link>

        <header className="mt-6 border-b border-[var(--border)] pb-5">
          <h1 className="text-3xl font-bold text-[var(--text)]">{t('title')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--text-secondary)]">{t('subtitle')}</p>
        </header>

        <Section title={t('languageTitle')}>
          <div>
            <p className="text-sm text-[var(--text-secondary)]">{t('languageDescription')}</p>
          </div>
          <div className="md:justify-self-end">
            <LanguageSwitcher triggerClassName="w-full justify-center px-5 py-3 text-base md:w-auto" />
          </div>
        </Section>

        <Section title={t('appearanceTitle')}>
          <SegmentedControl
            label={t('theme')}
            value={preferences.theme}
            options={themeOptions}
            onChange={updateTheme}
          />
          <p className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--text-secondary)]">
            {t('appearanceDescription')}
          </p>
        </Section>

        <Section title={t('unitsTitle')}>
          <div className="space-y-5">
            <SegmentedControl
              label={t('swtUnit')}
              value={preferences.swtUnit}
              options={swtOptions}
              onChange={updateSwtUnit}
            />
            <SegmentedControl
              label={t('density')}
              value={preferences.dashboardDensity}
              options={densityOptions}
              onChange={updateDensity}
            />
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
            <p className="text-xs font-bold uppercase tracking-wide text-[var(--text-tertiary)]">{t('swtSample')}</p>
            <p className="mt-2 text-2xl font-bold text-[var(--text)]">
              {formatSwtValue(30, preferences.swtUnit)}
            </p>
          </div>
        </Section>

        <Section title={t('dataTitle')}>
          <SegmentedControl
            label={t('autoRefresh')}
            value={preferences.dashboardAutoRefresh}
            options={refreshOptions}
            onChange={updateRefresh}
          />
          <p className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--text-secondary)]">
            {t('autoRefreshDescription')}
          </p>
        </Section>
      </div>
    </main>
  );
}
