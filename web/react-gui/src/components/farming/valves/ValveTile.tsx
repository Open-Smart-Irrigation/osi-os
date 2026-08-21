import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ValveSummary } from '../../../types/farming';
import { deriveValveGlyphState } from './valveState';
import { ValveGlyph, valveGlyphLabel, type Translate } from './ValveGlyph';
import { useDismissOnPointerDown } from '../../../hooks/useDismissOnPointerDown';

export interface ValveTileProps {
  valve: ValveSummary;
  nowMs: number;
  onOpen: () => void;
  onSchedule: () => void;
  onCancel: () => void;
  onSkipToday: () => void;
  onPause: () => void;
  onResume: () => void;
  onResend: () => void;
  onSettings: () => void;
  busy: boolean;
}

function formatClock(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '—';
  const options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(date);
  }
}

function formatRelativePast(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const deltaSec = Math.max(0, (nowMs - then) / 1000);
  if (deltaSec < 60) return `${Math.round(deltaSec)}s`;
  if (deltaSec < 3600) return `${Math.round(deltaSec / 60)} min`;
  if (deltaSec < 86400) return `${Math.round(deltaSec / 3600)} h`;
  return `${Math.round(deltaSec / 86400)} d`;
}

const Spinner: React.FC = () => (
  <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
);

export const ValveTile: React.FC<ValveTileProps> = ({
  valve,
  nowMs,
  onOpen,
  onSchedule,
  onCancel,
  onSkipToday,
  onPause,
  onResume,
  onResend,
  onSettings,
  busy,
}) => {
  const { t } = useTranslation('valves');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissOnPointerDown(menuRef, () => setMenuOpen(false));

  const glyph = deriveValveGlyphState(valve, nowMs);
  const stateLabel = valveGlyphLabel(glyph.state, t as Translate);
  const isPendingCommand = valve.activeActuation?.reconciliationState === 'PENDING_OBSERVATION';

  const statusDetails: string[] = [];
  if (glyph.state === 'open' && glyph.remainingSeconds !== null) {
    statusDetails.push(t('remaining', { minutes: Math.max(0, Math.ceil(glyph.remainingSeconds / 60)) }));
    if (glyph.closesAt) statusDetails.push(t('closesAt', { time: formatClock(glyph.closesAt, valve.timezone) }));
  }
  if (glyph.state === 'pending') {
    statusDetails.push(t('pendingHint'));
    if (valve.lastUplinkAt) {
      statusDetails.push(t('lastContact', { when: formatRelativePast(valve.lastUplinkAt, nowMs) }));
    }
  }

  let nextRunLine: string;
  if (valve.schedulerStatus === 'DEACTIVATED') {
    nextRunLine = t('schedulerPaused');
  } else if (valve.schedulerStatus === 'SKIP_TODAY') {
    nextRunLine = t('skippedToday');
  } else if (!valve.nextRun) {
    nextRunLine = t('noSchedule');
  } else {
    const when = formatClock(valve.nextRun.at, valve.timezone);
    nextRunLine = valve.nextRun.kind === 'ONCE'
      ? t('nextRunOnce', { when, minutes: valve.nextRun.minutes })
      : t('nextRun', { when, minutes: valve.nextRun.minutes });
  }

  let planLine: string | null = null;
  if (valve.pushState.queued > 0) {
    planLine = t('planDelivery', { acked: valve.pushState.acked, total: valve.pushState.acked + valve.pushState.queued });
  } else if (valve.pushState.failed > 0) {
    planLine = t('planFailed', { count: valve.pushState.failed });
  }

  const isPaused = valve.schedulerStatus === 'DEACTIVATED';
  const alreadySkipped = valve.schedulerStatus === 'SKIP_TODAY';

  const primaryAction = isPendingCommand
    ? { label: t('cancel'), onClick: onCancel }
    : { label: t('open'), onClick: onOpen };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-start gap-3">
        <ValveGlyph state={glyph.state} progress={glyph.progress} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-[var(--text)]">{valve.name}</h3>
            <span className="shrink-0 rounded-full bg-[var(--card)] px-2 py-0.5 text-xs text-[var(--text-secondary)]">
              {valve.zoneName ?? t('unassignedZone')}
            </span>
          </div>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            {stateLabel}
            {statusDetails.length > 0 && <span className="text-[var(--text-tertiary)]"> · {statusDetails.join(' · ')}</span>}
          </p>
          <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">{nextRunLine}</p>
          {planLine && (
            <p className={`mt-0.5 text-xs ${valve.pushState.failed > 0 && valve.pushState.queued === 0 ? 'text-[var(--warn-text)]' : 'text-[var(--text-tertiary)]'}`}>
              {planLine}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={primaryAction.onClick}
          disabled={busy}
          className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy && <Spinner />}
          {primaryAction.label}
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSchedule}
            disabled={busy}
            className="flex min-h-[44px] flex-1 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('schedule')}
          </button>
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              disabled={busy}
              aria-label={t('more')}
              title={t('more')}
              className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-[var(--border)] px-2.5 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                menuOpen ? 'bg-[var(--primary)] text-white' : 'bg-[var(--card)] text-[var(--text)] hover:bg-[var(--secondary-bg)]'
              }`}
            >
              ⋯
            </button>
            {menuOpen && (
              <div
                ref={menuRef}
                role="menu"
                className="absolute right-0 top-full z-20 mt-1 w-52 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 shadow-xl"
              >
                <MenuItem
                  label={t('skipToday')}
                  disabled={alreadySkipped}
                  onClick={() => { setMenuOpen(false); onSkipToday(); }}
                />
                <MenuItem
                  label={isPaused ? t('resumeSchedules') : t('pauseSchedules')}
                  onClick={() => { setMenuOpen(false); isPaused ? onResume() : onPause(); }}
                />
                <MenuItem
                  label={t('resendPlan')}
                  onClick={() => { setMenuOpen(false); onResend(); }}
                />
                <MenuItem
                  label={t('settings')}
                  onClick={() => { setMenuOpen(false); onSettings(); }}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const MenuItem: React.FC<{ label: string; onClick: () => void; disabled?: boolean }> = ({ label, onClick, disabled }) => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    disabled={disabled}
    className="flex min-h-[44px] w-full items-center rounded-md px-3 py-2 text-left text-sm text-[var(--text)] transition-colors hover:bg-[var(--card)] disabled:cursor-not-allowed disabled:opacity-50"
  >
    {label}
  </button>
);

export default ValveTile;
