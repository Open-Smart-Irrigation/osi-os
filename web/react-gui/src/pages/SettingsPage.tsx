import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { getApiErrorMessage, irrigationZonesAPI, supportRequestsAPI } from '../services/api';
import type {
  SupportRequestArea,
  SupportRequestCreateRequest,
  SupportRequestSeverity,
  SupportRequestType,
} from '../types/farming';
import {
  applyThemePreference,
  type DisplayPreferences,
  type JournalDetailLevel,
  type ModulePreferences,
  type ThemePreference,
  useDisplayPreferences,
  writeDisplayPreferences,
} from '../utils/displayPreferences';
import { formatSwtValue, type SwtUnit } from '../utils/swt';

type AutoRefreshPreference = DisplayPreferences['dashboardAutoRefresh'];
type UserRequestType = Extract<SupportRequestType, 'bug' | 'improvement'>;

interface Option<T extends string> {
  value: T;
  label: string;
}

const REQUEST_AREAS = [
  'dashboard',
  'history',
  'analysis',
  'watering',
  'devices',
  'sync',
  'system',
  'other',
] as const satisfies readonly SupportRequestArea[];

const REQUEST_IMPACTS = ['cant_work', 'workaround', 'annoying', 'idea'] as const satisfies readonly SupportRequestSeverity[];

function selectedClasses(selected: boolean): string {
  return selected
    ? 'bg-[var(--primary)] text-white'
    : 'text-[var(--text)] hover:bg-[var(--secondary-bg)]';
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
              className={`min-h-11 px-4 py-2 text-sm font-bold transition-colors ${selectedClasses(selected)}`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OnOffControl({
  enabled,
  disabled,
  onChange,
  onLabel,
  offLabel,
}: {
  enabled: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
  onLabel: string;
  offLabel: string;
}) {
  return (
    <div className="inline-flex shrink-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <button
        type="button"
        aria-pressed={enabled}
        disabled={disabled}
        onClick={() => onChange(true)}
        className={`min-h-10 px-4 py-2 text-sm font-bold transition-colors disabled:cursor-wait disabled:opacity-70 ${selectedClasses(enabled)}`}
      >
        {onLabel}
      </button>
      <button
        type="button"
        aria-pressed={!enabled}
        disabled={disabled}
        onClick={() => onChange(false)}
        className={`min-h-10 px-4 py-2 text-sm font-bold transition-colors disabled:cursor-wait disabled:opacity-70 ${selectedClasses(!enabled)}`}
      >
        {offLabel}
      </button>
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
    <section aria-label={title} className="border-b border-[var(--border)] py-5 last:border-b-0">
      <h2 className="text-xl font-bold text-[var(--text)]">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function ModuleRow({
  label,
  warning,
  enabled,
  disabled,
  onChange,
  onLabel,
  offLabel,
}: {
  label: string;
  warning?: string;
  enabled: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
  onLabel: string;
  offLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <p className="font-semibold text-[var(--text)]">{label}</p>
        {warning && (
          <span
            title={warning}
            className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-900"
          >
            {warning}
          </span>
        )}
      </div>
      <OnOffControl
        enabled={enabled}
        disabled={disabled}
        onChange={onChange}
        onLabel={onLabel}
        offLabel={offLabel}
      />
    </div>
  );
}

function FieldLabel({
  htmlFor,
  children,
}: {
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-semibold text-[var(--text)]">
      {children}
    </label>
  );
}

export function SettingsPage() {
  const { t } = useTranslation('settings');
  const preferences = useDisplayPreferences();
  const [moduleNotice, setModuleNotice] = useState<string | null>(null);
  const [moduleError, setModuleError] = useState<string | null>(null);
  const [schedulerBusy, setSchedulerBusy] = useState(false);
  const [requestType, setRequestType] = useState<UserRequestType>('improvement');
  const [requestTitle, setRequestTitle] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [requestArea, setRequestArea] = useState<SupportRequestArea>('dashboard');
  const [requestImpact, setRequestImpact] = useState<SupportRequestSeverity>('idea');
  const [requestDescription, setRequestDescription] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [shareConsent, setShareConsent] = useState(false);
  const [requestNotice, setRequestNotice] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requestSubmitting, setRequestSubmitting] = useState(false);

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
  const refreshOptions = useMemo<Array<Option<AutoRefreshPreference>>>(
    () => [
      { value: 'on', label: t('on') },
      { value: 'off', label: t('off') },
    ],
    [t],
  );
  const requestTypeOptions = useMemo<Array<Option<UserRequestType>>>(
    () => [
      { value: 'bug', label: t('bugFix') },
      { value: 'improvement', label: t('featureRequest') },
    ],
    [t],
  );
  const journalDetailOptions = useMemo<Array<Option<JournalDetailLevel>>>(
    () => [
      { value: 'farmer_quick', label: t('journalDetailQuick') },
      { value: 'full_record', label: t('journalDetailFull') },
      { value: 'research_observation', label: t('journalDetailResearch') },
    ],
    [t],
  );

  const updateTheme = (theme: ThemePreference) => {
    writeDisplayPreferences({ theme });
    applyThemePreference(theme);
  };

  const updateSwtUnit = (swtUnit: SwtUnit) => writeDisplayPreferences({ swtUnit });
  const updateJournalDetailLevel = (journalDetailLevel: JournalDetailLevel) =>
    writeDisplayPreferences({ journalDetailLevel });
  const updateRefresh = (dashboardAutoRefresh: AutoRefreshPreference) => writeDisplayPreferences({ dashboardAutoRefresh });
  const writeModules = (modules: ModulePreferences) => writeDisplayPreferences({ modules });
  const updateModule = (key: keyof ModulePreferences, enabled: boolean) => {
    setModuleNotice(null);
    setModuleError(null);
    writeModules({ ...preferences.modules, [key]: enabled });
  };
  const updateScheduler = async (enabled: boolean) => {
    setModuleNotice(null);
    setModuleError(null);
    if (enabled) {
      writeModules({ ...preferences.modules, schedulerUi: true });
      return;
    }

    if (!preferences.modules.schedulerUi) return;
    if (!window.confirm(t('schedulerDisableConfirm'))) return;

    setSchedulerBusy(true);
    try {
      const result = await irrigationZonesAPI.disableAllSchedules();
      writeModules({ ...preferences.modules, schedulerUi: false });
      const count = result.disabledSchedules;
      setModuleNotice(t(
        count === 1 ? 'schedulerDisableSuccess_one' : 'schedulerDisableSuccess_other',
        { count },
      ));
    } catch (error) {
      setModuleError(getApiErrorMessage(error, t('schedulerDisableError')));
    } finally {
      setSchedulerBusy(false);
    }
  };

  const canSubmitRequest =
    requestTitle.trim().length >= 3
    && requestDescription.trim().length >= 10
    && shareConsent
    && !requestSubmitting;

  const resetRequestForm = () => {
    setRequestType('improvement');
    setRequestTitle('');
    setContactEmail('');
    setRequestArea('dashboard');
    setRequestImpact('idea');
    setRequestDescription('');
    setIncludeDiagnostics(true);
    setShareConsent(false);
  };

  const submitUserRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmitRequest) return;

    const payload: SupportRequestCreateRequest = {
      type: requestType,
      title: requestTitle.trim(),
      contact_email: contactEmail.trim() || null,
      description: requestDescription.trim(),
      expected: null,
      actual: null,
      steps: null,
      area: requestArea,
      severity: requestImpact,
      consent_public: true,
      consent_diagnostics: includeDiagnostics,
      route: '/settings',
      current_route: '/settings',
    };

    setRequestSubmitting(true);
    setRequestNotice(null);
    setRequestError(null);
    try {
      await supportRequestsAPI.create(payload);
      setRequestNotice(t('requestSaved'));
      resetRequestForm();
    } catch (error) {
      setRequestError(getApiErrorMessage(error, t('requestError')));
    } finally {
      setRequestSubmitting(false);
    }
  };

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

        <header className="mt-6 border-b border-[var(--border)] pb-4">
          <h1 className="text-3xl font-bold text-[var(--text)]">{t('title')}</h1>
        </header>

        <Section title={t('languageTitle')}>
          <LanguageSwitcher
            menuAlign="left"
            triggerClassName="justify-start px-5 py-3 text-base"
          />
        </Section>

        <Section title={t('appearanceTitle')}>
          <SegmentedControl
            label={t('theme')}
            value={preferences.theme}
            options={themeOptions}
            onChange={updateTheme}
          />
        </Section>

        <Section title={t('unitsTitle')}>
          <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-end">
            <SegmentedControl
              label={t('swtUnit')}
              value={preferences.swtUnit}
              options={swtOptions}
              onChange={updateSwtUnit}
            />
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
              <p className="text-xs font-bold uppercase tracking-wide text-[var(--text-tertiary)]">{t('swtSample')}</p>
              <p className="mt-2 text-2xl font-bold text-[var(--text)]">
                {formatSwtValue(30, preferences.swtUnit)}
              </p>
            </div>
          </div>
        </Section>

        <Section title={t('modulesTitle')}>
          <div className="grid gap-3">
            <ModuleRow
              label={t('predictionAdvisory')}
              warning={t('predictionAdvisoryWarning')}
              enabled={preferences.modules.predictionAdvisory}
              onChange={(enabled) => updateModule('predictionAdvisory', enabled)}
              onLabel={t('on')}
              offLabel={t('off')}
            />
            <ModuleRow
              label={t('waterCard')}
              enabled={preferences.modules.waterCard}
              onChange={(enabled) => updateModule('waterCard', enabled)}
              onLabel={t('on')}
              offLabel={t('off')}
            />
            <ModuleRow
              label={t('irrigationSchedule')}
              enabled={preferences.modules.schedulerUi}
              disabled={schedulerBusy}
              onChange={(enabled) => {
                void updateScheduler(enabled);
              }}
              onLabel={t('on')}
              offLabel={t('off')}
            />
            <ModuleRow
              label={t('environmentCard')}
              enabled={preferences.modules.environment}
              onChange={(enabled) => updateModule('environment', enabled)}
              onLabel={t('on')}
              offLabel={t('off')}
            />
          </div>
          {moduleNotice && (
            <p role="status" className="mt-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-semibold text-green-900">
              {moduleNotice}
            </p>
          )}
          {moduleError && (
            <p role="alert" className="mt-3 rounded-lg border border-[var(--error-bg)] bg-[var(--error-bg)] px-4 py-3 text-sm font-semibold text-[var(--error-text)]">
              {moduleError}
            </p>
          )}
        </Section>

        <Section title={t('dataTitle')}>
          <SegmentedControl
            label={t('autoRefresh')}
            value={preferences.dashboardAutoRefresh}
            options={refreshOptions}
            onChange={updateRefresh}
          />
        </Section>

        <Section title={t('journalTitle')}>
          <SegmentedControl
            label={t('journalDetailLevel')}
            value={preferences.journalDetailLevel}
            options={journalDetailOptions}
            onChange={updateJournalDetailLevel}
          />
          <p className="mt-3 max-w-prose text-sm text-[var(--text-secondary)]">
            {t('journalDetailLevelHelp')}
          </p>
        </Section>

        <Section title={t('userRequestTitle')}>
          <form onSubmit={submitUserRequest} className="space-y-4 rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
            <div className="grid gap-4 lg:grid-cols-[minmax(12rem,16rem)_minmax(12rem,1fr)_minmax(12rem,1fr)]">
              <SegmentedControl
                label={t('requestType')}
                value={requestType}
                options={requestTypeOptions}
                onChange={setRequestType}
              />
              <div>
                <FieldLabel htmlFor="user-request-title">{t('requestTitle')}</FieldLabel>
                <input
                  id="user-request-title"
                  value={requestTitle}
                  onChange={(event) => setRequestTitle(event.target.value)}
                  maxLength={80}
                  required
                  className="mt-2 min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
                />
              </div>
              <div>
                <FieldLabel htmlFor="user-request-email">{t('contactEmail')}</FieldLabel>
                <input
                  id="user-request-email"
                  type="email"
                  value={contactEmail}
                  onChange={(event) => setContactEmail(event.target.value)}
                  maxLength={254}
                  className="mt-2 min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <FieldLabel htmlFor="user-request-area">{t('requestArea')}</FieldLabel>
                <select
                  id="user-request-area"
                  value={requestArea}
                  onChange={(event) => setRequestArea(event.target.value as SupportRequestArea)}
                  className="mt-2 min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
                >
                  {REQUEST_AREAS.map((area) => (
                    <option key={area} value={area}>{t(`area_${area}`)}</option>
                  ))}
                </select>
              </div>
              <div>
                <FieldLabel htmlFor="user-request-impact">{t('requestImpact')}</FieldLabel>
                <select
                  id="user-request-impact"
                  value={requestImpact}
                  onChange={(event) => setRequestImpact(event.target.value as SupportRequestSeverity)}
                  className="mt-2 min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
                >
                  {REQUEST_IMPACTS.map((impact) => (
                    <option key={impact} value={impact}>{t(`impact_${impact}`)}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <FieldLabel htmlFor="user-request-description">{t('requestDescription')}</FieldLabel>
              <textarea
                id="user-request-description"
                value={requestDescription}
                onChange={(event) => setRequestDescription(event.target.value)}
                rows={7}
                maxLength={4000}
                required
                className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
              />
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
                  <input
                    type="checkbox"
                    checked={includeDiagnostics}
                    onChange={(event) => setIncludeDiagnostics(event.target.checked)}
                  />
                  {t('requestIncludeDiagnostics')}
                </label>
                <label className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
                  <input
                    type="checkbox"
                    checked={shareConsent}
                    onChange={(event) => setShareConsent(event.target.checked)}
                    required
                  />
                  {t('requestShareConsent')}
                </label>
              </div>

              <button
                type="submit"
                disabled={!canSubmitRequest}
                className="min-h-11 rounded-lg bg-[var(--primary)] px-5 py-3 text-sm font-bold text-white transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {requestSubmitting ? t('requestSubmitting') : t('requestSubmit')}
              </button>
            </div>

            {requestNotice && (
              <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
                {requestNotice}
              </p>
            )}
            {requestError && (
              <p role="alert" className="rounded-lg border border-[var(--error-bg)] bg-[var(--error-bg)] px-4 py-3 text-sm font-semibold text-[var(--error-text)]">
                {requestError}
              </p>
            )}
          </form>
        </Section>
      </div>
    </main>
  );
}
