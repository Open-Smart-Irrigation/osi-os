import React, { useEffect, useState } from 'react';
import useSWR from 'swr';
import { useTranslation } from 'react-i18next';
import type { StregaModel, ValveSummary } from '../../../types/farming';
import { devicesAPI, stregaAPI } from '../../../services/api';
import { getRecognizedStregaModel, normaliseStregaModel } from './valveCardHelpers';

export interface ValveServiceDialogProps {
  valve: ValveSummary;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

type TimedActionDirection = 'OPEN' | 'CLOSE';
type TimedActionUnit = 'seconds' | 'minutes' | 'hours';
type CommandKey = 'interval' | 'model' | 'timed' | 'magnet' | 'partial' | 'flush';

const MAX_INTERVAL_MINUTES = 255;
const MAX_TIMED_AMOUNT = 255;

const devicesFetcher = () => devicesAPI.getAll();

// Structural template: ValveSettingsDialog.tsx (header X, no Cancel button, 44px targets,
// var(--...) tokens only). This dialog carries the six stregaAPI commands that used to live
// only on the now-deleted StregaValveCard's control surface -- see docs/superpowers/specs/
// 2026-08-24-valve-advanced-controls-consolidation-design.md.
//
// The three water-moving commands (timed action, partial opening, flushing) require an
// explicit confirmation tap before the stregaAPI client is called: one tap must not move
// water, mirroring the rule ValveOpenDialog already applies to daily Open.
//
// Copy for partial opening/flushing never claims a lasting position: SET_PARTIAL_OPENING is
// a one-shot action and the valve's resting aperture is always 100% (E4, confirmed with the
// vendor 2026-08-24). "Open once to 40%" is honest; "Set opening to 40%" is not.
export const ValveServiceDialog: React.FC<ValveServiceDialogProps> = ({ valve, open, onClose, onChanged }) => {
  const { t } = useTranslation('valves');
  const { t: tc } = useTranslation('common');
  // motorizedLocked/motorizedNote are inline-defaultValue copy in the 'devices' namespace
  // (no matching keys in devices.json for any locale) -- carried over verbatim from the
  // deleted StregaValveCard rather than minting a near-duplicate string in valves.json.
  const { t: td } = useTranslation('devices');

  // strega_model lives on `devices`, not on ValveSummary (GET /api/valves does not carry
  // it) -- see spec §3b on the two-capability-flag split. devicesAPI.getAll() is the same
  // unaltered client + SWR key ('/api/devices') FarmingDashboard already uses, so this
  // dedupes against that poll rather than adding a new one.
  const { data: devices } = useSWR(open ? '/api/devices' : null, devicesFetcher);
  const device = (devices ?? []).find((d) => String(d.deveui ?? '').toUpperCase() === valve.deviceEui);
  const recognizedModel = device ? getRecognizedStregaModel(device) : 'UNKNOWN';
  const isMotorized = recognizedModel === 'MOTORIZED';

  const [closedMinutesInput, setClosedMinutesInput] = useState('');
  const [openedMinutesInput, setOpenedMinutesInput] = useState('2');
  const [tamperDisabled, setTamperDisabled] = useState(false);

  const [modelInput, setModelInput] = useState<StregaModel>('STANDARD');

  const [timedAction, setTimedAction] = useState<TimedActionDirection>('OPEN');
  const [timedUnit, setTimedUnit] = useState<TimedActionUnit>('minutes');
  const [timedAmountInput, setTimedAmountInput] = useState('');

  const [magnetEnabled, setMagnetEnabled] = useState(false);

  const [partialAction, setPartialAction] = useState<TimedActionDirection>('OPEN');
  const [partialPercentageInput, setPartialPercentageInput] = useState('');

  const [flushReturnPosition, setFlushReturnPosition] = useState<TimedActionDirection>('OPEN');
  const [flushPercentageInput, setFlushPercentageInput] = useState('');

  const [busyCommand, setBusyCommand] = useState<CommandKey | null>(null);
  const [confirmCommand, setConfirmCommand] = useState<'timed' | 'partial' | 'flush' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setClosedMinutesInput('');
      setOpenedMinutesInput('2');
      setTamperDisabled(false);
      setTimedAction('OPEN');
      setTimedUnit('minutes');
      setTimedAmountInput('');
      setMagnetEnabled(false);
      setPartialAction('OPEN');
      setPartialPercentageInput('');
      setFlushReturnPosition('OPEN');
      setFlushPercentageInput('');
      setConfirmCommand(null);
      setError(null);
      setInfo(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, valve.deviceEui]);

  useEffect(() => {
    if (open && device) {
      setModelInput(normaliseStregaModel(device.strega_model) ?? 'STANDARD');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, device?.strega_model]);

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

  const titleId = `valve-service-title-${valve.deviceEui}`;

  const closedMinutes = Number(closedMinutesInput);
  const openedMinutes = Number(openedMinutesInput);
  const isIntervalValid =
    Number.isInteger(closedMinutes) && closedMinutes >= 1 && closedMinutes <= MAX_INTERVAL_MINUTES &&
    Number.isInteger(openedMinutes) && openedMinutes >= 1 && openedMinutes <= MAX_INTERVAL_MINUTES;

  const timedAmount = Number(timedAmountInput);
  const isTimedAmountValid = Number.isInteger(timedAmount) && timedAmount >= 1 && timedAmount <= MAX_TIMED_AMOUNT;

  const partialPercentage = Number(partialPercentageInput);
  const isPartialPercentageValid = Number.isInteger(partialPercentage) && partialPercentage >= 1 && partialPercentage <= 100;

  const flushPercentage = Number(flushPercentageInput);
  const isFlushPercentageValid = Number.isInteger(flushPercentage) && flushPercentage >= 1 && flushPercentage <= 100;

  const runCommand = async (key: CommandKey, action: () => Promise<void>, pendingMessage: string, failedMessage: string) => {
    setBusyCommand(key);
    setError(null);
    setInfo(null);
    try {
      await action();
      setInfo(pendingMessage);
      onChanged();
    } catch {
      setError(failedMessage);
    } finally {
      setBusyCommand(null);
      setConfirmCommand(null);
    }
  };

  const applyInterval = () => {
    if (!isIntervalValid || busyCommand) {
      setError(t('serviceDialog.interval.invalid'));
      return;
    }
    void runCommand(
      'interval',
      () => stregaAPI.setUplinkInterval(valve.deviceEui, { closedMinutes, openedMinutes, tamperDisabled }),
      t('serviceDialog.interval.pending'),
      t('serviceDialog.interval.failed'),
    );
  };

  const applyModel = () => {
    if (busyCommand) return;
    void runCommand(
      'model',
      () => stregaAPI.setModel(valve.deviceEui, modelInput),
      t('serviceDialog.model.pending'),
      t('serviceDialog.model.failed'),
    );
  };

  const sendTimedAction = () => {
    if (!isTimedAmountValid || busyCommand) {
      setError(t('serviceDialog.timed.invalid'));
      return;
    }
    void runCommand(
      'timed',
      () => stregaAPI.setTimedAction(valve.deviceEui, { action: timedAction, unit: timedUnit, amount: timedAmount }),
      t('serviceDialog.timed.pending'),
      t('serviceDialog.timed.failed'),
    );
  };

  const applyMagnet = () => {
    if (busyCommand) return;
    void runCommand(
      'magnet',
      () => stregaAPI.setMagnetEnabled(valve.deviceEui, magnetEnabled),
      t('serviceDialog.magnet.pending'),
      t('serviceDialog.magnet.failed'),
    );
  };

  const sendPartialOpening = () => {
    if (!isMotorized || !isPartialPercentageValid || busyCommand) {
      setError(t('serviceDialog.partial.invalid'));
      return;
    }
    void runCommand(
      'partial',
      () => stregaAPI.setPartialOpening(valve.deviceEui, { action: partialAction, percentage: partialPercentage }),
      partialAction === 'OPEN'
        ? t('serviceDialog.partial.pendingOpen', { percentage: partialPercentage })
        : t('serviceDialog.partial.pendingClose', { percentage: partialPercentage }),
      t('serviceDialog.partial.failed'),
    );
  };

  const sendFlushing = () => {
    if (!isMotorized || !isFlushPercentageValid || busyCommand) {
      setError(t('serviceDialog.flush.invalid'));
      return;
    }
    void runCommand(
      'flush',
      () => stregaAPI.setFlushing(valve.deviceEui, { returnPosition: flushReturnPosition, percentage: flushPercentage }),
      t('serviceDialog.flush.pending', {
        percentage: flushPercentage,
        state: flushReturnPosition === 'OPEN' ? t('serviceDialog.flush.returnOpen') : t('serviceDialog.flush.returnClose'),
      }),
      t('serviceDialog.flush.failed'),
    );
  };

  const eui = valve.deviceEui;
  const motorizedLockedCopy = td('stregaValve.motorizedLocked', {
    defaultValue: 'Set the valve model to motorized to unlock partial opening and flushing commands.',
  });
  const motorizedNoteCopy = td('stregaValve.motorizedNote', {
    defaultValue: 'Partial opening and anti-sediment flushing are only supported for motorized valves.',
  });

  const busy = busyCommand !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-[var(--text)]">{t('serviceDialog.title')}</h2>
            <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">{t('serviceDialog.subtitle', { name: valve.name })}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={tc('close')}
            className="-mr-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-xl leading-none text-[var(--text-tertiary)] transition-colors hover:bg-[var(--secondary-bg)] hover:text-[var(--text)]"
          >
            &times;
          </button>
        </div>

        {error && <p className="mt-3 text-sm text-[var(--warn-text)]">{error}</p>}
        {info && !error && <p className="mt-3 text-sm text-[var(--text-secondary)]">{info}</p>}

        <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
          {t('serviceDialog.configSection')}
        </p>

        <section className="mt-2 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <p className="text-sm font-semibold text-[var(--text)]">{t('serviceDialog.interval.label')}</p>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label className="text-xs text-[var(--text-tertiary)]" htmlFor={`service-interval-closed-${eui}`}>
                {t('serviceDialog.interval.closedLabel')}
              </label>
              <input
                id={`service-interval-closed-${eui}`}
                type="number"
                min={1}
                max={MAX_INTERVAL_MINUTES}
                step={1}
                inputMode="numeric"
                value={closedMinutesInput}
                disabled={busy}
                onChange={(event) => setClosedMinutesInput(event.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
              />
            </div>
            <div>
              <label className="text-xs text-[var(--text-tertiary)]" htmlFor={`service-interval-opened-${eui}`}>
                {t('serviceDialog.interval.openedLabel')}
              </label>
              <input
                id={`service-interval-opened-${eui}`}
                type="number"
                min={1}
                max={MAX_INTERVAL_MINUTES}
                step={1}
                inputMode="numeric"
                value={openedMinutesInput}
                disabled={busy}
                onChange={(event) => setOpenedMinutesInput(event.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
              />
            </div>
          </div>
          <label className="mt-2 flex min-h-[44px] items-center gap-2 text-sm text-[var(--text)]">
            <input
              type="checkbox"
              checked={tamperDisabled}
              disabled={busy}
              onChange={(event) => setTamperDisabled(event.target.checked)}
              className="h-4 w-4"
            />
            {t('serviceDialog.interval.tamperLabel')}
          </label>
          <button
            type="button"
            onClick={applyInterval}
            disabled={busy}
            className="mt-2 flex min-h-[44px] items-center gap-2 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busyCommand === 'interval' && <Spinner />}
            {t('serviceDialog.interval.apply')}
          </button>
        </section>

        <section className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <label className="text-sm font-semibold text-[var(--text)]" htmlFor={`service-model-${eui}`}>
            {t('serviceDialog.model.label')}
          </label>
          <select
            id={`service-model-${eui}`}
            value={modelInput}
            disabled={busy}
            onChange={(event) => setModelInput(event.target.value as StregaModel)}
            className="mt-2 min-h-[44px] w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
          >
            <option value="STANDARD">{t('serviceDialog.model.standard')}</option>
            <option value="MOTORIZED">{t('serviceDialog.model.motorized')}</option>
          </select>
          <button
            type="button"
            onClick={applyModel}
            disabled={busy}
            className="mt-2 flex min-h-[44px] items-center gap-2 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busyCommand === 'model' && <Spinner />}
            {t('serviceDialog.model.apply')}
          </button>
        </section>

        <section className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <label className="text-sm font-semibold text-[var(--text)]" htmlFor={`service-magnet-${eui}`}>
            {t('serviceDialog.magnet.label')}
          </label>
          <label className="mt-2 flex min-h-[44px] items-center gap-2 text-sm text-[var(--text)]" htmlFor={`service-magnet-${eui}`}>
            <input
              id={`service-magnet-${eui}`}
              type="checkbox"
              checked={magnetEnabled}
              disabled={busy}
              onChange={(event) => setMagnetEnabled(event.target.checked)}
              className="h-4 w-4"
            />
            {t('serviceDialog.magnet.enableLabel')}
          </label>
          <button
            type="button"
            onClick={applyMagnet}
            disabled={busy}
            className="mt-2 flex min-h-[44px] items-center gap-2 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busyCommand === 'magnet' && <Spinner />}
            {t('serviceDialog.magnet.apply')}
          </button>
        </section>

        <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
          {t('serviceDialog.actionsSection')}
        </p>

        <section className="mt-2 rounded-xl border border-[var(--warn-border)] bg-[var(--card)] p-3">
          <p className="text-sm font-semibold text-[var(--text)]">{t('serviceDialog.timed.label')}</p>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <select
              value={timedAction}
              disabled={busy}
              onChange={(event) => setTimedAction(event.target.value as TimedActionDirection)}
              aria-label={t('serviceDialog.timed.label')}
              className="min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
            >
              <option value="OPEN">{t('serviceDialog.timed.actionOpen')}</option>
              <option value="CLOSE">{t('serviceDialog.timed.actionClose')}</option>
            </select>
            <select
              value={timedUnit}
              disabled={busy}
              onChange={(event) => setTimedUnit(event.target.value as TimedActionUnit)}
              aria-label={t('serviceDialog.timed.unitMinutes')}
              className="min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
            >
              <option value="seconds">{t('serviceDialog.timed.unitSeconds')}</option>
              <option value="minutes">{t('serviceDialog.timed.unitMinutes')}</option>
              <option value="hours">{t('serviceDialog.timed.unitHours')}</option>
            </select>
            <div>
              <label className="sr-only" htmlFor={`service-timed-amount-${eui}`}>{t('serviceDialog.timed.amountLabel')}</label>
              <input
                id={`service-timed-amount-${eui}`}
                type="number"
                min={1}
                max={MAX_TIMED_AMOUNT}
                step={1}
                inputMode="numeric"
                value={timedAmountInput}
                disabled={busy}
                placeholder={t('serviceDialog.timed.amountLabel')}
                onChange={(event) => setTimedAmountInput(event.target.value)}
                aria-label={t('serviceDialog.timed.amountLabel')}
                className="min-h-[44px] w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
              />
            </div>
          </div>
          {confirmCommand === 'timed' ? (
            <div className="mt-2 rounded-lg bg-[var(--warn-bg)] px-3 py-2">
              <p className="text-xs font-semibold text-[var(--warn-text)]">{t('serviceDialog.timed.confirmTitle')}</p>
              <p className="mt-0.5 text-xs text-[var(--warn-text)]">{t('serviceDialog.timed.confirmBody')}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={sendTimedAction}
                  disabled={busy}
                  className="flex min-h-[44px] items-center gap-2 rounded-lg bg-[var(--warn-border)] px-4 py-2 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busyCommand === 'timed' && <Spinner />}
                  {t('serviceDialog.timed.confirmButton')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmCommand(null)}
                  disabled={busy}
                  className="min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {t('cancel')}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmCommand('timed')}
              disabled={busy}
              className="mt-2 min-h-[44px] rounded-lg border border-[var(--warn-border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--warn-text)] transition-colors hover:bg-[var(--warn-bg)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('serviceDialog.timed.send')}
            </button>
          )}
        </section>

        <section className="mt-3 rounded-xl border border-[var(--warn-border)] bg-[var(--card)] p-3">
          <p className="text-sm font-semibold text-[var(--text)]">{t('serviceDialog.partial.label')}</p>
          {!isMotorized && <p className="mt-1 text-xs text-[var(--text-tertiary)]">{motorizedLockedCopy}</p>}
          {isMotorized && <p className="mt-1 text-xs text-[var(--text-tertiary)]">{motorizedNoteCopy}</p>}
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <select
              value={partialAction}
              disabled={busy || !isMotorized}
              onChange={(event) => setPartialAction(event.target.value as TimedActionDirection)}
              aria-label={t('serviceDialog.partial.label')}
              className="min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] disabled:opacity-60"
            >
              <option value="OPEN">{t('serviceDialog.partial.actionOpen')}</option>
              <option value="CLOSE">{t('serviceDialog.partial.actionClose')}</option>
            </select>
            <div>
              <label className="text-xs text-[var(--text-tertiary)]" htmlFor={`service-partial-percentage-${eui}`}>
                {t('serviceDialog.partial.percentageLabel')}
              </label>
              <input
                id={`service-partial-percentage-${eui}`}
                type="number"
                min={1}
                max={100}
                step={1}
                inputMode="numeric"
                value={partialPercentageInput}
                disabled={busy || !isMotorized}
                onChange={(event) => setPartialPercentageInput(event.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] disabled:opacity-60"
              />
            </div>
          </div>
          {confirmCommand === 'partial' ? (
            <div className="mt-2 rounded-lg bg-[var(--warn-bg)] px-3 py-2">
              <p className="text-xs font-semibold text-[var(--warn-text)]">{t('serviceDialog.partial.confirmTitle')}</p>
              <p className="mt-0.5 text-xs text-[var(--warn-text)]">{t('serviceDialog.partial.confirmBody')}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={sendPartialOpening}
                  disabled={busy}
                  className="flex min-h-[44px] items-center gap-2 rounded-lg bg-[var(--warn-border)] px-4 py-2 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busyCommand === 'partial' && <Spinner />}
                  {t('serviceDialog.partial.confirmButton')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmCommand(null)}
                  disabled={busy}
                  className="min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {t('cancel')}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmCommand('partial')}
              disabled={busy || !isMotorized}
              className="mt-2 min-h-[44px] rounded-lg border border-[var(--warn-border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--warn-text)] transition-colors hover:bg-[var(--warn-bg)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('serviceDialog.partial.send')}
            </button>
          )}
        </section>

        <section className="mt-3 rounded-xl border border-[var(--warn-border)] bg-[var(--card)] p-3">
          <p className="text-sm font-semibold text-[var(--text)]">{t('serviceDialog.flush.label')}</p>
          {!isMotorized && <p className="mt-1 text-xs text-[var(--text-tertiary)]">{motorizedLockedCopy}</p>}
          {isMotorized && <p className="mt-1 text-xs text-[var(--text-tertiary)]">{motorizedNoteCopy}</p>}
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label className="text-xs text-[var(--text-tertiary)]" htmlFor={`service-flush-return-${eui}`}>
                {t('serviceDialog.flush.returnLabel')}
              </label>
              <select
                id={`service-flush-return-${eui}`}
                value={flushReturnPosition}
                disabled={busy || !isMotorized}
                onChange={(event) => setFlushReturnPosition(event.target.value as TimedActionDirection)}
                className="mt-1 min-h-[44px] w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] disabled:opacity-60"
              >
                <option value="OPEN">{t('serviceDialog.flush.returnOpen')}</option>
                <option value="CLOSE">{t('serviceDialog.flush.returnClose')}</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-[var(--text-tertiary)]" htmlFor={`service-flush-percentage-${eui}`}>
                {t('serviceDialog.flush.percentageLabel')}
              </label>
              <input
                id={`service-flush-percentage-${eui}`}
                type="number"
                min={1}
                max={100}
                step={1}
                inputMode="numeric"
                value={flushPercentageInput}
                disabled={busy || !isMotorized}
                onChange={(event) => setFlushPercentageInput(event.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] disabled:opacity-60"
              />
            </div>
          </div>
          {confirmCommand === 'flush' ? (
            <div className="mt-2 rounded-lg bg-[var(--warn-bg)] px-3 py-2">
              <p className="text-xs font-semibold text-[var(--warn-text)]">{t('serviceDialog.flush.confirmTitle')}</p>
              <p className="mt-0.5 text-xs text-[var(--warn-text)]">{t('serviceDialog.flush.confirmBody')}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={sendFlushing}
                  disabled={busy}
                  className="flex min-h-[44px] items-center gap-2 rounded-lg bg-[var(--warn-border)] px-4 py-2 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busyCommand === 'flush' && <Spinner />}
                  {t('serviceDialog.flush.confirmButton')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmCommand(null)}
                  disabled={busy}
                  className="min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {t('cancel')}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmCommand('flush')}
              disabled={busy || !isMotorized}
              className="mt-2 min-h-[44px] rounded-lg border border-[var(--warn-border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--warn-text)] transition-colors hover:bg-[var(--warn-bg)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('serviceDialog.flush.send')}
            </button>
          )}
        </section>
      </div>
    </div>
  );
};

const Spinner: React.FC = () => (
  <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
);

export default ValveServiceDialog;
