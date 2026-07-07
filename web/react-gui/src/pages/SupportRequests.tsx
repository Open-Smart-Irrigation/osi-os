import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getApiErrorMessage, supportRequestsAPI } from '../services/api';
import type {
  SupportDiagnosticsValue,
  SupportRequest,
  SupportRequestArea,
  SupportRequestCloudStatus,
  SupportRequestCreateRequest,
  SupportRequestLocalStatus,
  SupportRequestSeverity,
  SupportRequestType,
} from '../types/farming';

const REQUEST_TYPES: SupportRequestType[] = ['bug', 'improvement', 'feedback'];
const REQUEST_AREAS: SupportRequestArea[] = [
  'dashboard',
  'history',
  'analysis',
  'copy',
  'watering',
  'sync',
  'devices',
  'system',
  'other',
];
const REQUEST_SEVERITIES: SupportRequestSeverity[] = ['cant_work', 'workaround', 'annoying', 'idea'];

const STATUS_TONE: Record<string, string> = {
  QUEUED: 'border-amber-300 bg-amber-50 text-amber-900',
  SUBMITTED: 'border-sky-300 bg-sky-50 text-sky-900',
  SYNCED: 'border-sky-300 bg-sky-50 text-sky-900',
  TRIAGED: 'border-sky-300 bg-sky-50 text-sky-900',
  BEING_REVIEWED: 'border-sky-300 bg-sky-50 text-sky-900',
  NEEDS_INFO: 'border-orange-300 bg-orange-50 text-orange-900',
  ISSUE_ONLY: 'border-slate-300 bg-slate-50 text-slate-900',
  ISSUE_OPEN: 'border-sky-300 bg-sky-50 text-sky-900',
  NOT_PLANNED: 'border-slate-300 bg-slate-50 text-slate-900',
  REJECTED: 'border-slate-300 bg-slate-50 text-slate-900',
  DUPLICATE: 'border-slate-300 bg-slate-50 text-slate-900',
  AWAITING_APPROVAL: 'border-amber-300 bg-amber-50 text-amber-900',
  AGENT_RUNNING: 'border-sky-300 bg-sky-50 text-sky-900',
  VERIFYING: 'border-sky-300 bg-sky-50 text-sky-900',
  PR_OPEN: 'border-sky-300 bg-sky-50 text-sky-900',
  IN_REVIEW: 'border-sky-300 bg-sky-50 text-sky-900',
  MERGED: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  RELEASED: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  CLOSED: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  AGENT_FAILED: 'border-red-300 bg-red-50 text-red-900',
  FAILED_RETRYABLE: 'border-red-300 bg-red-50 text-red-900',
  FAILED_PERMANENT: 'border-red-300 bg-red-50 text-red-900',
};

const RAW_EUI_PATTERN = /\b[0-9A-Fa-f]{16}\b/g;
const RAW_APP_KEY_PATTERN = /\b[0-9A-Fa-f]{32}\b/g;
const JWT_PATTERN = /\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b(password|passwd|pwd|token|secret|api[_-]?key|app[_-]?key)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;{}[\]]+)/gi;

function redactDiagnosticText(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, '[REDACTED_BEARER_TOKEN]')
    .replace(JWT_PATTERN, '[REDACTED_JWT]')
    .replace(RAW_APP_KEY_PATTERN, '[REDACTED_APPKEY]')
    .replace(RAW_EUI_PATTERN, '[REDACTED_EUI]')
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=[REDACTED_SECRET]`);
}

function formatDiagnosticKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusCode(request: SupportRequest): string {
  return request.cloud_status ?? request.local_status;
}

function hasKnownStatus(code: string): code is SupportRequestCloudStatus | SupportRequestLocalStatus {
  return Object.prototype.hasOwnProperty.call(STATUS_TONE, code);
}

function sortDiagnosticsEntries(value: Record<string, SupportDiagnosticsValue>) {
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}

const DiagnosticsValue: React.FC<{ value: SupportDiagnosticsValue; depth?: number }> = ({ value, depth = 0 }) => {
  if (value === null || value === undefined) {
    return <span className="text-[var(--text-secondary)]">N/A</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-[var(--text-secondary)]">None</span>;
    return (
      <ul className="mt-1 space-y-1">
        {value.map((entry, index) => (
          <li key={index} className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1">
            <DiagnosticsValue value={entry} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  }

  if (typeof value === 'object') {
    const entries = sortDiagnosticsEntries(value as Record<string, SupportDiagnosticsValue>);
    if (entries.length === 0) return <span className="text-[var(--text-secondary)]">None</span>;
    return (
      <dl className={`${depth === 0 ? 'space-y-3' : 'mt-2 space-y-2'}`}>
        {entries.map(([key, nested]) => (
          <div key={key} className="grid gap-1 sm:grid-cols-[180px_1fr]">
            <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
              {formatDiagnosticKey(redactDiagnosticText(key))}
            </dt>
            <dd className="min-w-0 break-words text-sm text-[var(--text)]">
              <DiagnosticsValue value={nested} depth={depth + 1} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  if (typeof value === 'boolean') return <span>{value ? 'true' : 'false'}</span>;
  return <span>{redactDiagnosticText(String(value))}</span>;
};

export const SupportRequests: React.FC = () => {
  const { t } = useTranslation('support');
  const [requests, setRequests] = useState<SupportRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [requestsError, setRequestsError] = useState('');
  const [diagnostics, setDiagnostics] = useState<Record<string, SupportDiagnosticsValue> | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(true);
  const [submitError, setSubmitError] = useState('');
  const [submitNotice, setSubmitNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [expected, setExpected] = useState('');
  const [actual, setActual] = useState('');
  const [steps, setSteps] = useState('');
  const [requestType, setRequestType] = useState<SupportRequestType>('improvement');
  const [area, setArea] = useState<SupportRequestArea>('dashboard');
  const [severity, setSeverity] = useState<SupportRequestSeverity>('workaround');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [consentPublic, setConsentPublic] = useState(false);

  const canSubmit = title.trim().length >= 3 && description.trim().length >= 10 && consentPublic && !submitting;

  const loadRequests = async () => {
    setRequestsError('');
    try {
      const rows = await supportRequestsAPI.list();
      setRequests(rows);
    } catch (error) {
      setRequestsError(getApiErrorMessage(error, t('myRequests.loadError')));
    } finally {
      setRequestsLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;

    supportRequestsAPI.diagnosticsPreview('/support-requests')
      .then((preview) => {
        if (!cancelled) setDiagnostics(preview.diagnostics ?? null);
      })
      .catch(() => {
        if (!cancelled) setDiagnostics(null);
      })
      .finally(() => {
        if (!cancelled) setDiagnosticsLoading(false);
      });

    loadRequests();

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const orderedRequests = useMemo(
    () => [...requests].sort((left, right) => String(right.submitted_at ?? right.updated_at ?? '').localeCompare(String(left.submitted_at ?? left.updated_at ?? ''))),
    [requests],
  );

  const resetForm = () => {
    setTitle('');
    setDescription('');
    setExpected('');
    setActual('');
    setSteps('');
    setRequestType('improvement');
    setArea('dashboard');
    setSeverity('workaround');
    setIncludeDiagnostics(true);
    setConsentPublic(false);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;

    const payload: SupportRequestCreateRequest = {
      type: requestType,
      title: title.trim(),
      description: description.trim(),
      expected: expected.trim() || null,
      actual: actual.trim() || null,
      steps: steps.trim() || null,
      area,
      severity,
      consent_public: true,
      consent_diagnostics: includeDiagnostics,
      route: '/support-requests',
      current_route: '/support-requests',
    };

    setSubmitting(true);
    setSubmitError('');
    setSubmitNotice('');
    try {
      await supportRequestsAPI.create(payload);
      setSubmitNotice(t('status.QUEUED'));
      resetForm();
      setRequestsLoading(true);
      await loadRequests();
    } catch {
      setSubmitError(t('banners.retryable'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] px-4 py-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6">
          <Link
            to="/dashboard"
            className="text-sm font-semibold text-[var(--primary)] hover:text-[var(--primary-hover)]"
          >
            {t('backToDashboard')}
          </Link>
        </div>

        <header className="mb-6">
          <h1 className="text-3xl font-bold text-[var(--text)]">{t('title')}</h1>
        </header>

        {submitError && (
          <div className="mb-5 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm font-semibold text-red-900">
            {submitError}
          </div>
        )}

        {submitNotice && (
          <div className="mb-5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
            {submitNotice}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
          <form
            onSubmit={handleSubmit}
            className="space-y-5 rounded-lg border border-[var(--border)] bg-[var(--card)] p-5 shadow-lg"
          >
            <section aria-labelledby="support-step-request" className="space-y-4">
              <h2 id="support-step-request" className="text-lg font-bold text-[var(--text)]">
                {t('form.stepRequest')}
              </h2>

              <div>
                <label htmlFor="support-title" className="block text-sm font-semibold text-[var(--text)]">
                  {t('form.summary')}
                </label>
                <input
                  id="support-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={80}
                  className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
                />
              </div>

              <div>
                <label htmlFor="support-description" className="block text-sm font-semibold text-[var(--text)]">
                  {t('form.description')}
                </label>
                <textarea
                  id="support-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={5}
                  maxLength={4000}
                  className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
                />
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <label htmlFor="support-expected" className="block text-sm font-semibold text-[var(--text)]">
                    {t('form.expected')}
                  </label>
                  <textarea
                    id="support-expected"
                    value={expected}
                    onChange={(event) => setExpected(event.target.value)}
                    rows={3}
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
                  />
                </div>
                <div>
                  <label htmlFor="support-actual" className="block text-sm font-semibold text-[var(--text)]">
                    {t('form.actual')}
                  </label>
                  <textarea
                    id="support-actual"
                    value={actual}
                    onChange={(event) => setActual(event.target.value)}
                    rows={3}
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
                  />
                </div>
                <div>
                  <label htmlFor="support-steps" className="block text-sm font-semibold text-[var(--text)]">
                    {t('form.steps')}
                  </label>
                  <textarea
                    id="support-steps"
                    value={steps}
                    onChange={(event) => setSteps(event.target.value)}
                    rows={3}
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
                  />
                </div>
              </div>
            </section>

            <section aria-labelledby="support-step-area" className="space-y-4 border-t border-[var(--border)] pt-5">
              <h2 id="support-step-area" className="text-lg font-bold text-[var(--text)]">
                {t('form.stepArea')}
              </h2>

              <fieldset>
                <legend className="text-sm font-semibold text-[var(--text)]">{t('form.requestType')}</legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  {REQUEST_TYPES.map((type) => (
                    <label key={type} className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]">
                      <input
                        type="radio"
                        name="support-request-type"
                        value={type}
                        checked={requestType === type}
                        onChange={() => setRequestType(type)}
                      />
                      {t(`types.${type}`)}
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="support-area" className="block text-sm font-semibold text-[var(--text)]">
                    {t('form.area')}
                  </label>
                  <select
                    id="support-area"
                    value={area}
                    onChange={(event) => setArea(event.target.value as SupportRequestArea)}
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
                  >
                    {REQUEST_AREAS.map((option) => (
                      <option key={option} value={option}>{t(`areas.${option}`)}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="support-severity" className="block text-sm font-semibold text-[var(--text)]">
                    {t('form.severity')}
                  </label>
                  <select
                    id="support-severity"
                    value={severity}
                    onChange={(event) => setSeverity(event.target.value as SupportRequestSeverity)}
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
                  >
                    {REQUEST_SEVERITIES.map((option) => (
                      <option key={option} value={option}>{t(`severity.${option}`)}</option>
                    ))}
                  </select>
                </div>
              </div>
            </section>

            <section aria-labelledby="support-step-diagnostics" className="space-y-4 border-t border-[var(--border)] pt-5">
              <h2 id="support-step-diagnostics" className="text-lg font-bold text-[var(--text)]">
                {t('form.stepDiagnostics')}
              </h2>

              <details open className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
                <summary className="cursor-pointer text-sm font-bold text-[var(--text)]">
                  {t('form.diagnostics')}
                </summary>
                <div className="mt-3">
                  {diagnosticsLoading ? (
                    <p className="text-sm text-[var(--text-secondary)]">{t('diagnostics.loading')}</p>
                  ) : diagnostics ? (
                    <DiagnosticsValue value={diagnostics} />
                  ) : (
                    <p className="text-sm text-[var(--text-secondary)]">{t('diagnostics.unavailable')}</p>
                  )}
                </div>
              </details>

              <div className="space-y-3">
                <label className="flex items-start gap-3 text-sm text-[var(--text)]">
                  <input
                    type="checkbox"
                    checked={includeDiagnostics}
                    onChange={(event) => setIncludeDiagnostics(event.target.checked)}
                    className="mt-1"
                  />
                  <span>{t('form.includeDiagnostics')}</span>
                </label>

                <label className="flex items-start gap-3 text-sm font-semibold text-[var(--text)]">
                  <input
                    type="checkbox"
                    checked={consentPublic}
                    onChange={(event) => setConsentPublic(event.target.checked)}
                    className="mt-1"
                  />
                  <span>{t('form.consentPublic')}</span>
                </label>
              </div>

              <button
                type="submit"
                disabled={!canSubmit}
                className="rounded-lg bg-[var(--primary)] px-5 py-3 text-sm font-bold text-white transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? t('form.submitting') : t('form.submit')}
              </button>
            </section>
          </form>

          <section
            aria-labelledby="support-my-requests"
            className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-5 shadow-lg"
          >
            <h2 id="support-my-requests" className="text-xl font-bold text-[var(--text)]">
              {t('myRequests.title')}
            </h2>

            {requestsError && (
              <div className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
                {requestsError}
              </div>
            )}

            {requestsLoading ? (
              <p className="mt-4 text-sm text-[var(--text-secondary)]">{t('myRequests.loading')}</p>
            ) : orderedRequests.length === 0 ? (
              <p className="mt-4 text-sm text-[var(--text-secondary)]">{t('empty')}</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {orderedRequests.map((request) => {
                  const code = statusCode(request);
                  return (
                    <li key={request.request_id} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <h3 className="font-bold text-[var(--text)]">{request.title}</h3>
                          {request.description_preview && (
                            <p className="mt-1 text-sm text-[var(--text-secondary)]">{request.description_preview}</p>
                          )}
                        </div>
                        <span className={`inline-flex w-fit rounded-full border px-3 py-1 text-xs font-bold ${STATUS_TONE[code] ?? STATUS_TONE.SUBMITTED}`}>
                          {hasKnownStatus(code) ? t(`status.${code}`) : t('status.UNKNOWN')}
                        </span>
                      </div>

                      <dl className="mt-3 grid gap-2 text-xs text-[var(--text-secondary)] sm:grid-cols-2">
                        <div>
                          <dt className="font-semibold">{t('myRequests.area')}</dt>
                          <dd>{t(`areas.${request.area}`)}</dd>
                        </div>
                        <div>
                          <dt className="font-semibold">{t('myRequests.submitted')}</dt>
                          <dd>{request.submitted_at ? new Date(request.submitted_at).toLocaleString() : 'N/A'}</dd>
                        </div>
                      </dl>

                      {request.cloud_human_message && (
                        <div className="mt-3 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm text-orange-950">
                          {request.cloud_human_message}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
