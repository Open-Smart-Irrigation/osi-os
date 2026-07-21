import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  irrigationOutcomesAPI,
  type IrrigationActuation,
  type IrrigationActuationsResponse,
  type IrrigationActuationStatus,
} from '../../services/api';

const POLL_INTERVAL_MS = 60_000;
const ADVANCED_VIEW_STORAGE_KEY = 'osi.recentIrrigations.advancedView';
const RECENT_IRRIGATION_DISPLAY_LIMIT = 5;

export interface IrrigationOutcomeZoneContext {
  timeZone?: string | null;
  areaM2?: number | null;
  irrigationEfficiencyPct?: number | null;
}

interface Props {
  /** Polling can be disabled in tests. */
  pollIntervalMs?: number;
  response?: IrrigationActuationsResponse | null;
  loading?: boolean;
  error?: string | null;
  zoneContexts?: Map<number, IrrigationOutcomeZoneContext | null | undefined>;
  /** @deprecated Prefer zoneContexts so depth can use zone area and efficiency. */
  zoneTimezones?: Map<number, string | null | undefined>;
}

interface State {
  loading: boolean;
  error: string | null;
  generatedAt: string | null;
  actuations: IrrigationActuation[];
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

const INITIAL: State = { loading: true, error: null, generatedAt: null, actuations: [] };

function formatRelativeTime(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const deltaSec = (Date.now() - t) / 1000;
  if (deltaSec < -60) return `in ${Math.round(Math.abs(deltaSec) / 60)} min`;
  if (deltaSec < 0) return 'now';
  if (deltaSec < 60) return `${Math.round(deltaSec)}s ago`;
  if (deltaSec < 3600) return `${Math.round(deltaSec / 60)} min ago`;
  if (deltaSec < 86400) return `${Math.round(deltaSec / 3600)} h ago`;
  return `${Math.round(deltaSec / 86400)} d ago`;
}

function formatAbsoluteDateTime(iso: string | null, timeZone?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
  try {
    return new Intl.DateTimeFormat(undefined, timeZone ? { ...options, timeZone } : options).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(date);
  }
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

function toNonNegativeFiniteNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function toPositiveFiniteNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function formatLiters(value: number): string {
  return `${value.toFixed(0)} L`;
}

function formatIrrigationMm(value: number): string {
  return `${value.toFixed(1)} mm`;
}

function readStoredAdvancedView(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(ADVANCED_VIEW_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeStoredAdvancedView(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ADVANCED_VIEW_STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    // Preference persistence should not block rendering.
  }
}

interface IrrigationMetricDisplay {
  compactLabel: string | null;
  totalVolumeLabel: string | null;
  irrigatedLabel: string | null;
}

function buildIrrigationMetric(
  row: IrrigationActuation,
  zoneContext: IrrigationOutcomeZoneContext | null | undefined,
  t: Translate,
): IrrigationMetricDisplay {
  const liters = toNonNegativeFiniteNumber(row.estimatedGrossLiters);
  if (liters == null) {
    return { compactLabel: null, totalVolumeLabel: null, irrigatedLabel: null };
  }

  const totalVolumeLabel = t('irrigationOutcomes.totalVolume', {
    defaultValue: 'Total volume: {{liters}}',
    liters: formatLiters(liters),
  });
  const areaM2 = toPositiveFiniteNumber(zoneContext?.areaM2);
  if (areaM2 == null) {
    return { compactLabel: totalVolumeLabel, totalVolumeLabel, irrigatedLabel: null };
  }

  const efficiencyPct = toPositiveFiniteNumber(zoneContext?.irrigationEfficiencyPct);
  const depthMm = efficiencyPct != null ? liters * (efficiencyPct / 100) / areaM2 : liters / areaM2;
  const irrigatedLabel = t('irrigationOutcomes.irrigated', {
    defaultValue: 'Irrigated: {{depth}}',
    depth: formatIrrigationMm(depthMm),
  });
  return { compactLabel: irrigatedLabel, totalVolumeLabel, irrigatedLabel };
}

const STATUS_STYLES: Record<IrrigationActuationStatus, { bg: string; fg: string; border: string }> = {
  PENDING_OPEN: { bg: 'bg-[var(--warning-soft, #fef3c7)]', fg: 'text-[var(--warning-text, #92400e)]', border: 'border-[var(--warning, #f59e0b)]' },
  RUNNING:      { bg: 'bg-[var(--info-soft, #dbeafe)]',    fg: 'text-[var(--info-text, #1e40af)]',    border: 'border-[var(--info, #3b82f6)]' },
  COMPLETED:    { bg: 'bg-[var(--success-soft, #dcfce7)]', fg: 'text-[var(--success-text, #166534)]', border: 'border-[var(--success, #16a34a)]' },
  CANCELLED:    { bg: 'bg-[var(--card)]',                  fg: 'text-[var(--text-tertiary)]',         border: 'border-[var(--border)]' },
  COMMAND_FAILED:{bg: 'bg-[var(--error-soft, #fee2e2)]',   fg: 'text-[var(--error-text, #991b1b)]',   border: 'border-[var(--error, #dc2626)]' },
  OPEN_TIMEOUT: { bg: 'bg-[var(--error-soft, #fee2e2)]',   fg: 'text-[var(--error-text, #991b1b)]',   border: 'border-[var(--error, #dc2626)]' },
  CLOSE_TIMEOUT:{ bg: 'bg-[var(--error-soft, #fee2e2)]',   fg: 'text-[var(--error-text, #991b1b)]',   border: 'border-[var(--error, #dc2626)]' },
  UNKNOWN:      { bg: 'bg-[var(--card)]',                  fg: 'text-[var(--text-tertiary)]',         border: 'border-[var(--border)]' },
};

function statusLabel(status: IrrigationActuationStatus, t: (k: string, o?: Record<string, unknown>) => string): string {
  const fallbacks: Record<IrrigationActuationStatus, string> = {
    PENDING_OPEN:  'Pending open',
    RUNNING:       'Running',
    COMPLETED:     'Completed',
    CANCELLED:     'Canceled',
    COMMAND_FAILED:'Command failed',
    OPEN_TIMEOUT:  'Open timeout',
    CLOSE_TIMEOUT: 'Close timeout',
    UNKNOWN:       'Unknown',
  };
  return t(`irrigationOutcomes.status.${status}`, { defaultValue: fallbacks[status] });
}

const StatusBadge: React.FC<{ status: IrrigationActuationStatus }> = ({ status }) => {
  const { t } = useTranslation('devices');
  const style = STATUS_STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold ${style.bg} ${style.fg} ${style.border}`}>
      {statusLabel(status, t as Translate)}
    </span>
  );
};

const TimestampDetail: React.FC<{
  label: string;
  iso: string | null;
  timeZone?: string | null;
}> = ({ label, iso, timeZone }) => {
  const { t } = useTranslation('devices');
  const absolute = formatAbsoluteDateTime(iso, timeZone);
  const relative = formatRelativeTime(iso);
  const title = t('irrigationOutcomes.timestampTitle', {
    defaultValue: '{{label}}: {{absolute}} ({{relative}})',
    label,
    absolute,
    relative,
  });
  return (
    <span className="inline-flex min-w-[12rem] max-w-full flex-col gap-0.5" title={title}>
      <span>
        {label}: <time dateTime={iso ?? undefined}>{absolute}</time>
      </span>
      <span className="text-[11px] leading-tight text-[var(--text-tertiary)]">{relative}</span>
    </span>
  );
};

const CompactActuationRow: React.FC<{
  row: IrrigationActuation;
  zoneContext?: IrrigationOutcomeZoneContext | null;
}> = ({ row, zoneContext }) => {
  const { t } = useTranslation('devices');
  const metric = buildIrrigationMetric(row, zoneContext, t as Translate);
  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 flex flex-col gap-1.5">
      <div className="flex flex-col gap-1">
        <div className="text-sm font-semibold text-[var(--text)]">
          {row.zoneName ?? t('irrigationOutcomes.zoneUnknown', { defaultValue: 'Zone ?' })}
        </div>
        <div className="text-xs text-[var(--text-secondary)] flex flex-wrap gap-x-3 gap-y-0.5">
          <span>
            <time dateTime={row.commandedAt}>{formatAbsoluteDateTime(row.commandedAt, zoneContext?.timeZone)}</time>
          </span>
          <span>
            {t('irrigationOutcomes.duration', { defaultValue: 'Duration' })}: {formatDuration(row.commandedDurationSeconds)}
          </span>
          {metric.compactLabel && <span>{metric.compactLabel}</span>}
        </div>
      </div>
    </li>
  );
};

const AdvancedActuationRow: React.FC<{
  row: IrrigationActuation;
  zoneContext?: IrrigationOutcomeZoneContext | null;
}> = ({ row, zoneContext }) => {
  const { t } = useTranslation('devices');
  const isFailure = row.status === 'OPEN_TIMEOUT' || row.status === 'CLOSE_TIMEOUT' || row.status === 'COMMAND_FAILED';
  const metric = buildIrrigationMetric(row, zoneContext, t as Translate);
  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
          <span>{row.zoneName ?? t('irrigationOutcomes.zoneUnknown', { defaultValue: 'Zone ?' })}</span>
          <span className="text-[var(--text-tertiary)]">·</span>
          <span className="text-[var(--text-secondary)]">{row.deviceName ?? row.deviceEui}</span>
        </div>
        <StatusBadge status={row.status} />
      </div>
      <div className="text-xs text-[var(--text-secondary)] flex flex-wrap gap-x-3 gap-y-0.5">
        <span>
          {t('irrigationOutcomes.duration', { defaultValue: 'Duration' })}: {formatDuration(row.commandedDurationSeconds)}
        </span>
        <TimestampDetail
          label={t('irrigationOutcomes.commanded', { defaultValue: 'Commanded' })}
          iso={row.commandedAt}
          timeZone={zoneContext?.timeZone}
        />
        {row.observedOpenAt && (
          <TimestampDetail
            label={t('irrigationOutcomes.observedOpen', { defaultValue: 'Confirmed open' })}
            iso={row.observedOpenAt}
            timeZone={zoneContext?.timeZone}
          />
        )}
        {row.observedCloseAt && (
          <TimestampDetail
            label={t('irrigationOutcomes.observedClose', { defaultValue: 'Confirmed close' })}
            iso={row.observedCloseAt}
            timeZone={zoneContext?.timeZone}
          />
        )}
        {metric.totalVolumeLabel && <span>{metric.totalVolumeLabel}</span>}
        {metric.irrigatedLabel && <span>{metric.irrigatedLabel}</span>}
      </div>
      {isFailure && row.commandResultDetail && (
        <p className="text-xs text-[var(--error-text, #991b1b)] mt-1 italic">{row.commandResultDetail}</p>
      )}
      {row.status === 'CANCELLED' && row.cancelReason && (
        <p className="text-xs text-[var(--text-tertiary)] mt-1 italic">{row.cancelReason}</p>
      )}
    </li>
  );
};

export const IrrigationOutcomesPanel: React.FC<Props> = ({
  pollIntervalMs = POLL_INTERVAL_MS,
  response,
  loading,
  error,
  zoneContexts,
  zoneTimezones,
}) => {
  const { t } = useTranslation('devices');
  const [state, setState] = useState<State>(INITIAL);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [advancedView, setAdvancedView] = useState(readStoredAdvancedView);
  const isControlled = response !== undefined || loading !== undefined || error !== undefined;

  useEffect(() => {
    if (isControlled) return;

    let cancelled = false;

    const fetchOnce = async () => {
      try {
        const result = await irrigationOutcomesAPI.recentActuations();
        if (cancelled) return;
        setState({
          loading: false,
          error: null,
          generatedAt: result.generatedAt,
          actuations: result.actuations,
        });
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setState((prev) => ({ ...prev, loading: false, error: message }));
      }
    };

    fetchOnce();
    if (pollIntervalMs <= 0) {
      return () => { cancelled = true; };
    }
    const timer = setInterval(fetchOnce, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isControlled, pollIntervalMs]);

  const viewState: State = isControlled
    ? {
        loading: loading ?? false,
        error: error ?? null,
        generatedAt: response?.generatedAt ?? null,
        actuations: response?.actuations ?? [],
      }
    : state;
  const displayActuations = viewState.actuations.slice(0, RECENT_IRRIGATION_DISPLAY_LIMIT);

  const setAdvancedViewPreference = (value: boolean) => {
    setAdvancedView(value);
    writeStoredAdvancedView(value);
  };

  const zoneContextFor = (row: IrrigationActuation): IrrigationOutcomeZoneContext | null => {
    const configured = zoneContexts?.get(row.zoneId);
    if (configured) return configured;
    const timeZone = zoneTimezones?.get(row.zoneId);
    return timeZone ? { timeZone } : null;
  };

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-[var(--text)] text-base font-semibold">
          {t('irrigationOutcomes.title', { defaultValue: 'Recent irrigations' })}
        </h2>
        <div className="flex items-center gap-2">
          {viewState.generatedAt && (
            <span className="text-xs text-[var(--text-tertiary)]">
              {t('irrigationOutcomes.updated', { defaultValue: 'updated' })} {formatRelativeTime(viewState.generatedAt)}
            </span>
          )}
          <div className="relative">
            <button
              type="button"
              onClick={() => setSettingsOpen((open) => !open)}
              aria-label={t('irrigationOutcomes.settings', { defaultValue: 'Recent irrigations settings' })}
              title={t('irrigationOutcomes.settings', { defaultValue: 'Recent irrigations settings' })}
              className={`p-1.5 rounded-md transition-colors ${
                settingsOpen
                  ? 'bg-[var(--primary)] text-white'
                  : 'text-[var(--text-tertiary)] hover:bg-[var(--card)] hover:text-[var(--text)]'
              }`}
            >
              ⚙
            </button>
            {settingsOpen && (
              <div className="absolute right-0 top-full z-20 mt-2 min-w-48 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-sm shadow-xl">
                <label className="flex items-center gap-2 text-[var(--text)]">
                  <input
                    type="checkbox"
                    checked={advancedView}
                    onChange={(event) => setAdvancedViewPreference(event.currentTarget.checked)}
                    className="h-4 w-4"
                  />
                  <span>{t('irrigationOutcomes.advancedView', { defaultValue: 'Advanced view' })}</span>
                </label>
              </div>
            )}
          </div>
        </div>
      </div>

      {viewState.loading && (
        <p className="text-sm text-[var(--text-tertiary)]">
          {t('irrigationOutcomes.loading', { defaultValue: 'Loading recent actuations…' })}
        </p>
      )}

      {viewState.error && (
        <p className="text-sm text-[var(--error-text, #991b1b)]">
          {t('irrigationOutcomes.error', { defaultValue: 'Failed to load recent actuations' })}: {viewState.error}
        </p>
      )}

      {!viewState.loading && !viewState.error && displayActuations.length === 0 && (
        <p className="text-sm text-[var(--text-tertiary)]">
          {t('irrigationOutcomes.empty', { defaultValue: 'No recent irrigations recorded yet.' })}
        </p>
      )}

      {displayActuations.length > 0 && (
        <ul className="flex flex-col gap-2">
          {displayActuations.map((row) => {
            const zoneContext = zoneContextFor(row);
            return advancedView ? (
              <AdvancedActuationRow key={row.expectationId} row={row} zoneContext={zoneContext} />
            ) : (
              <CompactActuationRow key={row.expectationId} row={row} zoneContext={zoneContext} />
            );
          })}
        </ul>
      )}
    </section>
  );
};
