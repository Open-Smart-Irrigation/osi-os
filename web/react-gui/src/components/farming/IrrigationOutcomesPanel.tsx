import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  irrigationOutcomesAPI,
  type IrrigationActuation,
  type IrrigationActuationStatus,
} from '../../services/api';

const POLL_INTERVAL_MS = 60_000;

interface Props {
  /** Polling can be disabled in tests. */
  pollIntervalMs?: number;
}

interface State {
  loading: boolean;
  error: string | null;
  generatedAt: string | null;
  actuations: IrrigationActuation[];
}

const INITIAL: State = { loading: true, error: null, generatedAt: null, actuations: [] };

function formatRelativeTime(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const deltaSec = (Date.now() - t) / 1000;
  if (deltaSec < 60) return `${Math.round(deltaSec)}s ago`;
  if (deltaSec < 3600) return `${Math.round(deltaSec / 60)} min ago`;
  if (deltaSec < 86400) return `${Math.round(deltaSec / 3600)} h ago`;
  return `${Math.round(deltaSec / 86400)} d ago`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
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
    CANCELLED:     'Cancelled',
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
      {statusLabel(status, t)}
    </span>
  );
};

const ActuationRow: React.FC<{ row: IrrigationActuation }> = ({ row }) => {
  const { t } = useTranslation('devices');
  const isFailure = row.status === 'OPEN_TIMEOUT' || row.status === 'CLOSE_TIMEOUT' || row.status === 'COMMAND_FAILED';
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
          {t('irrigationOutcomes.commanded', { defaultValue: 'Commanded' })}: {formatDuration(row.commandedDurationSeconds)} · {formatRelativeTime(row.commandedAt)}
        </span>
        {row.observedOpenAt && (
          <span>
            {t('irrigationOutcomes.observedOpen', { defaultValue: 'Opened' })}: {formatRelativeTime(row.observedOpenAt)}
          </span>
        )}
        {row.observedCloseAt && (
          <span>
            {t('irrigationOutcomes.observedClose', { defaultValue: 'Closed' })}: {formatRelativeTime(row.observedCloseAt)}
          </span>
        )}
        {row.estimatedGrossLiters != null && (
          <span>
            {t('irrigationOutcomes.estLiters', { defaultValue: '~' })} {row.estimatedGrossLiters.toFixed(0)} L
          </span>
        )}
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

export const IrrigationOutcomesPanel: React.FC<Props> = ({ pollIntervalMs = POLL_INTERVAL_MS }) => {
  const { t } = useTranslation('devices');
  const [state, setState] = useState<State>(INITIAL);

  useEffect(() => {
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
  }, [pollIntervalMs]);

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[var(--text)] text-base font-semibold">
          {t('irrigationOutcomes.title', { defaultValue: 'Recent irrigations' })}
        </h2>
        {state.generatedAt && (
          <span className="text-xs text-[var(--text-tertiary)]">
            {t('irrigationOutcomes.updated', { defaultValue: 'updated' })} {formatRelativeTime(state.generatedAt)}
          </span>
        )}
      </div>

      {state.loading && (
        <p className="text-sm text-[var(--text-tertiary)]">
          {t('irrigationOutcomes.loading', { defaultValue: 'Loading recent actuations…' })}
        </p>
      )}

      {state.error && (
        <p className="text-sm text-[var(--error-text, #991b1b)]">
          {t('irrigationOutcomes.error', { defaultValue: 'Failed to load recent actuations' })}: {state.error}
        </p>
      )}

      {!state.loading && !state.error && state.actuations.length === 0 && (
        <p className="text-sm text-[var(--text-tertiary)]">
          {t('irrigationOutcomes.empty', { defaultValue: 'No recent irrigations recorded yet.' })}
        </p>
      )}

      {state.actuations.length > 0 && (
        <ul className="flex flex-col gap-2">
          {state.actuations.map((row) => (
            <ActuationRow key={row.expectationId} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
};
