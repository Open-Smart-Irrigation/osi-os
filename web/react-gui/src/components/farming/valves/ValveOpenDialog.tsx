import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ValveSummary } from '../../../types/farming';
import { estimateLiters } from './valveState';

export interface ValveOpenDialogProps {
  valve: ValveSummary;
  open: boolean;
  onClose: () => void;
  onSubmit: (minutes: number) => Promise<void>;
}

const MIN_MINUTES = 1;
const MAX_MINUTES = 255;
const QUICK_CHIPS = [15, 30, 60];

function formatClosesAt(minutes: number, timeZone: string): string {
  const at = new Date(Date.now() + minutes * 60_000);
  const options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(at);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(at);
  }
}

export const ValveOpenDialog: React.FC<ValveOpenDialogProps> = ({ valve, open, onClose, onSubmit }) => {
  const { t } = useTranslation('valves');
  const { t: tc } = useTranslation('common');
  const [minutesInput, setMinutesInput] = useState(String(valve.defaultOpenMinutes ?? 5));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setMinutesInput(String(valve.defaultOpenMinutes ?? 5));
      setError(null);
    }
    // Reset the form whenever the dialog is (re-)opened for a valve.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, valve.deviceEui]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const minutes = Number(minutesInput);
  const isValid = Number.isInteger(minutes) && minutes >= MIN_MINUTES && minutes <= MAX_MINUTES;
  const liters = isValid ? estimateLiters(valve.flowRateLpm, minutes) : null;
  const closesAtLabel = isValid ? formatClosesAt(minutes, valve.timezone) : null;
  const titleId = `valve-open-title-${valve.deviceEui}`;

  const handleSubmit = async () => {
    if (!isValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(minutes);
      onClose();
    } catch {
      setError(t('openDialog.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold text-[var(--text)]">
            {t('openDialog.title', { name: valve.name })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={tc('close')}
            className="-mr-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-xl leading-none text-[var(--text-tertiary)] transition-colors hover:bg-[var(--secondary-bg)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            &times;
          </button>
        </div>

        <div className="mt-4 flex gap-2">
          {QUICK_CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => setMinutesInput(String(chip))}
              disabled={busy}
              className={`flex min-h-[44px] flex-1 items-center justify-center rounded-lg border px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                minutes === chip
                  ? 'border-[var(--primary)] bg-[var(--primary)] text-white'
                  : 'border-[var(--border)] bg-[var(--card)] text-[var(--text)] hover:bg-[var(--secondary-bg)]'
              }`}
            >
              {chip}
            </button>
          ))}
        </div>

        <div className="mt-3">
          <label htmlFor={`valve-open-minutes-${valve.deviceEui}`} className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            {t('openDialog.custom')}
          </label>
          <input
            id={`valve-open-minutes-${valve.deviceEui}`}
            type="number"
            min={MIN_MINUTES}
            max={MAX_MINUTES}
            step={1}
            inputMode="numeric"
            value={minutesInput}
            disabled={busy}
            onChange={(event) => setMinutesInput(event.target.value)}
            className="mt-1 min-h-[44px] w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--text)]"
            aria-label={t('openDialog.duration')}
          />
          {!isValid && (
            <p className="mt-1 text-xs text-[var(--warn-text)]">{t('openDialog.durationHint')}</p>
          )}
        </div>

        {isValid && (
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 rounded-lg bg-[var(--card)] px-3 py-2 text-sm text-[var(--text-secondary)]">
            <span>{t('openDialog.summary', { time: closesAtLabel })}</span>
            {liters !== null && <span>{t('openDialog.liters', { liters })}</span>}
          </div>
        )}

        {error && <p className="mt-3 text-sm text-[var(--warn-text)]">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!isValid || busy}
            className="flex min-h-[44px] items-center gap-2 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy && <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />}
            {t('openDialog.confirm', { minutes: isValid ? minutes : minutesInput })}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ValveOpenDialog;
