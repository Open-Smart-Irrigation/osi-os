import React, { useEffect, useRef, useState } from 'react';
import type { Device, StregaModel } from '../../types/farming';
import { devicesAPI, stregaAPI } from '../../services/api';
import { useTranslation } from 'react-i18next';

interface StregaValveCardProps {
  device: Device;
  onUpdate: () => void;
  onRemove?: () => void;
}

const MAX_STREGA_INTERVAL_MINUTES = 255;
const MAX_STREGA_TIMED_ACTION_AMOUNT = 255;
const STREGA_MODE_OPTIONS: Array<{ value: StregaModel; label: string }> = [
  { value: 'STANDARD', label: 'Standard / Solenoid' },
  { value: 'MOTORIZED', label: 'Motorized valve' },
];

type RecognizedStregaModel = StregaModel | 'UNKNOWN';
type TimedActionUnit = 'seconds' | 'minutes' | 'hours';

function getApiMessage(error: any, fallback: string): string {
  return error?.response?.data?.message || error?.response?.data?.error || fallback;
}

function normaliseStregaModel(value: unknown): StregaModel | null {
  const raw = String(value ?? '').trim().toUpperCase();
  return raw === 'STANDARD' || raw === 'MOTORIZED' ? raw : null;
}

function getRecognizedStregaModel(device: Device): RecognizedStregaModel {
  const explicit = normaliseStregaModel(device.strega_model);
  if (explicit) return explicit;
  const name = String(device.name || '').toLowerCase();
  if (name.includes('motor')) return 'MOTORIZED';
  if (name.includes('solenoid') || name.includes('lite') || name.includes('standard')) return 'STANDARD';
  return 'UNKNOWN';
}

const ConfigPanel: React.FC<{
  device: Device;
  onUpdate: () => void;
  onClose: () => void;
}> = ({ device, onUpdate, onClose }) => {
  const { t } = useTranslation('devices');
  const ref = useRef<HTMLDivElement>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [closedIntervalInput, setClosedIntervalInput] = useState('');
  const [openedIntervalInput, setOpenedIntervalInput] = useState('2');
  const [tamperDisabled, setTamperDisabled] = useState(false);
  const [modelInput, setModelInput] = useState<StregaModel>(normaliseStregaModel(device.strega_model) ?? 'STANDARD');
  const [timedAction, setTimedAction] = useState<'OPEN' | 'CLOSE'>('OPEN');
  const [timedUnit, setTimedUnit] = useState<TimedActionUnit>('minutes');
  const [timedAmountInput, setTimedAmountInput] = useState('');
  const [magnetEnabled, setMagnetEnabled] = useState(false);
  const [partialAction, setPartialAction] = useState<'OPEN' | 'CLOSE'>('OPEN');
  const [partialPercentageInput, setPartialPercentageInput] = useState('');
  const [flushReturnPosition, setFlushReturnPosition] = useState<'OPEN' | 'CLOSE'>('OPEN');
  const [flushPercentageInput, setFlushPercentageInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const recognizedModel = getRecognizedStregaModel(device);
  const isMotorized = recognizedModel === 'MOTORIZED';

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const applyInterval = async () => {
    const closedMinutes = Number(closedIntervalInput);
    const openedMinutes = Number(openedIntervalInput);
    if (!Number.isInteger(closedMinutes) || closedMinutes < 1 || closedMinutes > MAX_STREGA_INTERVAL_MINUTES) {
      setError(t('stregaValve.invalidInterval', { defaultValue: 'Enter a closed-box interval between 1 and 255 minutes.' }));
      setInfo(null);
      return;
    }
    if (!Number.isInteger(openedMinutes) || openedMinutes < 1 || openedMinutes > MAX_STREGA_INTERVAL_MINUTES) {
      setError(t('stregaValve.invalidOpenInterval', { defaultValue: 'Enter an opened-box interval between 1 and 255 minutes.' }));
      setInfo(null);
      return;
    }

    setBusyAction('interval');
    setError(null);
    setInfo(null);
    try {
      await stregaAPI.setUplinkInterval(device.deveui, {
        closedMinutes,
        openedMinutes,
        tamperDisabled,
      });
      setInfo(t('stregaValve.intervalPending', {
        defaultValue: 'Interval change requested for {{closed}} min closed / {{opened}} min opened.',
        closed: closedMinutes,
        opened: openedMinutes,
      }));
      onUpdate();
    } catch (err: any) {
      setError(getApiMessage(err, t('stregaValve.failedToSetInterval', { defaultValue: 'Failed to change Strega interval' })));
    } finally {
      setBusyAction(null);
    }
  };

  const applyModel = async () => {
    setBusyAction('model');
    setError(null);
    setInfo(null);
    try {
      await stregaAPI.setModel(device.deveui, modelInput);
      setInfo(t('stregaValve.modelPending', {
        defaultValue: 'Model update requested. The valve will be treated as {{model}} after sync confirms it.',
        model: modelInput === 'MOTORIZED' ? 'motorized' : 'standard',
      }));
      onUpdate();
    } catch (err: any) {
      setError(getApiMessage(err, t('stregaValve.failedToSetModel', { defaultValue: 'Failed to update the Strega model' })));
    } finally {
      setBusyAction(null);
    }
  };

  const applyTimedAction = async () => {
    const amount = Number(timedAmountInput);
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_STREGA_TIMED_ACTION_AMOUNT) {
      setError(t('stregaValve.invalidTimedAction', { defaultValue: 'Timed actions require a value between 1 and 255.' }));
      setInfo(null);
      return;
    }

    setBusyAction('timed');
    setError(null);
    setInfo(null);
    try {
      await stregaAPI.setTimedAction(device.deveui, {
        action: timedAction,
        unit: timedUnit,
        amount,
      });
      setInfo(t('stregaValve.timedActionPending', {
        defaultValue: '{{action}} requested for {{amount}} {{unit}}.',
        action: timedAction === 'OPEN' ? 'Open' : 'Close',
        amount,
        unit: timedUnit,
      }));
      onUpdate();
    } catch (err: any) {
      setError(getApiMessage(err, t('stregaValve.failedTimedAction', { defaultValue: 'Failed to queue the timed valve action' })));
    } finally {
      setBusyAction(null);
    }
  };

  const applyMagnetMode = async () => {
    setBusyAction('magnet');
    setError(null);
    setInfo(null);
    try {
      await stregaAPI.setMagnetEnabled(device.deveui, magnetEnabled);
      setInfo(t('stregaValve.magnetPending', {
        defaultValue: 'Magnet control will be {{state}} after the next downlink.',
        state: magnetEnabled ? 'enabled' : 'disabled',
      }));
      onUpdate();
    } catch (err: any) {
      setError(getApiMessage(err, t('stregaValve.failedMagnet', { defaultValue: 'Failed to change magnet control' })));
    } finally {
      setBusyAction(null);
    }
  };

  const applyPartialOpening = async () => {
    const percentage = Number(partialPercentageInput);
    if (!Number.isInteger(percentage) || percentage < 1 || percentage > 100) {
      setError(t('stregaValve.invalidPercentage', { defaultValue: 'Enter a percentage between 1 and 100.' }));
      setInfo(null);
      return;
    }

    setBusyAction('partial');
    setError(null);
    setInfo(null);
    try {
      await stregaAPI.setPartialOpening(device.deveui, {
        action: partialAction,
        percentage,
      });
      setInfo(t('stregaValve.partialPending', {
        defaultValue: 'Partial {{action}} requested at {{percentage}}%.',
        action: partialAction === 'OPEN' ? 'open' : 'close',
        percentage,
      }));
      onUpdate();
    } catch (err: any) {
      setError(getApiMessage(err, t('stregaValve.failedPartial', { defaultValue: 'Failed to queue partial opening' })));
    } finally {
      setBusyAction(null);
    }
  };

  const applyFlushing = async () => {
    const percentage = Number(flushPercentageInput);
    if (!Number.isInteger(percentage) || percentage < 1 || percentage > 100) {
      setError(t('stregaValve.invalidPercentage', { defaultValue: 'Enter a percentage between 1 and 100.' }));
      setInfo(null);
      return;
    }

    setBusyAction('flush');
    setError(null);
    setInfo(null);
    try {
      await stregaAPI.setFlushing(device.deveui, {
        returnPosition: flushReturnPosition,
        percentage,
      });
      setInfo(t('stregaValve.flushPending', {
        defaultValue: 'Flushing turn requested at {{percentage}}%, returning to {{state}}.',
        percentage,
        state: flushReturnPosition === 'OPEN' ? 'open' : 'closed',
      }));
      onUpdate();
    } catch (err: any) {
      setError(getApiMessage(err, t('stregaValve.failedFlush', { defaultValue: 'Failed to queue anti-sediment flushing' })));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 z-20 bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-xl p-3 min-w-[360px] max-w-[420px]"
    >
      <p className="text-[var(--text-tertiary)] text-xs font-semibold mb-2 px-1">{t('stregaValve.settings', { defaultValue: 'STREGA SETTINGS' })}</p>

      <div className="px-1 space-y-4">
        <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <p className="text-[var(--text)] text-sm font-semibold">{t('stregaValve.quickAction', { defaultValue: 'Quick timed action' })}</p>
          <p className="text-[var(--text-tertiary)] text-xs mt-1">
            {t('stregaValve.quickActionNote', { defaultValue: 'Queue a one-off open or close for seconds, minutes, or hours.' })}
          </p>
          <div className="grid grid-cols-3 gap-2 mt-3">
            <select
              value={timedAction}
              disabled={busyAction === 'timed'}
              onChange={(event) => setTimedAction(event.target.value as 'OPEN' | 'CLOSE')}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
            >
              <option value="OPEN">{t('stregaValve.open', { defaultValue: 'Open' })}</option>
              <option value="CLOSE">{t('stregaValve.closed', { defaultValue: 'Closed' })}</option>
            </select>
            <input
              type="number"
              min={1}
              max={MAX_STREGA_TIMED_ACTION_AMOUNT}
              step={1}
              inputMode="numeric"
              value={timedAmountInput}
              disabled={busyAction === 'timed'}
              onChange={(event) => setTimedAmountInput(event.target.value)}
              placeholder="10"
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
            />
            <select
              value={timedUnit}
              disabled={busyAction === 'timed'}
              onChange={(event) => setTimedUnit(event.target.value as TimedActionUnit)}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
            >
              <option value="seconds">{t('stregaValve.seconds', { defaultValue: 'seconds' })}</option>
              <option value="minutes">{t('stregaValve.minutes', { defaultValue: 'minutes' })}</option>
              <option value="hours">{t('stregaValve.hours', { defaultValue: 'hours' })}</option>
            </select>
          </div>
          <button
            type="button"
            onClick={applyTimedAction}
            disabled={busyAction !== null}
            className="mt-3 w-full rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busyAction === 'timed'
              ? t('stregaValve.applyingTimedAction', { defaultValue: 'Queueing timed action...' })
              : t('stregaValve.applyTimedAction', { defaultValue: 'Queue timed action' })}
          </button>
        </section>

        <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <p className="text-[var(--text)] text-sm font-semibold">{t('stregaValve.intervalHeading', { defaultValue: 'Uplink intervals' })}</p>
          <div className="grid grid-cols-2 gap-2 mt-3">
            <input
              id={`strega-closed-interval-${device.deveui}`}
              type="number"
              min={1}
              max={MAX_STREGA_INTERVAL_MINUTES}
              step={1}
              inputMode="numeric"
              value={closedIntervalInput}
              disabled={busyAction === 'interval'}
              onChange={(event) => setClosedIntervalInput(event.target.value)}
              placeholder={t('stregaValve.closedBoxInterval', { defaultValue: 'Closed-box min' })}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
            />
            <input
              type="number"
              min={1}
              max={MAX_STREGA_INTERVAL_MINUTES}
              step={1}
              inputMode="numeric"
              value={openedIntervalInput}
              disabled={busyAction === 'interval'}
              onChange={(event) => setOpenedIntervalInput(event.target.value)}
              placeholder={t('stregaValve.openedBoxInterval', { defaultValue: 'Opened-box min' })}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
            />
          </div>
          <label className="mt-3 flex items-center gap-3 text-sm text-[var(--text)]">
            <input
              type="checkbox"
              checked={tamperDisabled}
              disabled={busyAction === 'interval'}
              onChange={(event) => setTamperDisabled(event.target.checked)}
              className="w-4 h-4 accent-[var(--primary)]"
            />
            <span>{t('stregaValve.disableTamper', { defaultValue: 'Disable tamper-triggered wakeups' })}</span>
          </label>
          <button
            type="button"
            onClick={applyInterval}
            disabled={busyAction !== null}
            className="mt-3 w-full rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busyAction === 'interval'
              ? t('stregaValve.applyingInterval', { defaultValue: 'Applying interval...' })
              : t('stregaValve.applyInterval', { defaultValue: 'Apply intervals' })}
          </button>
        </section>

        <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[var(--text)] text-sm font-semibold">{t('stregaValve.modelHeading', { defaultValue: 'Model recognition' })}</p>
              <p className="text-[var(--text-tertiary)] text-xs mt-1">
                {t('stregaValve.modelDetected', {
                  defaultValue: 'Recognized as {{model}}.',
                  model: recognizedModel === 'UNKNOWN' ? 'unknown' : recognizedModel.toLowerCase(),
                })}
              </p>
            </div>
            <select
              value={modelInput}
              disabled={busyAction === 'model'}
              onChange={(event) => setModelInput(event.target.value as StregaModel)}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
            >
              {STREGA_MODE_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={applyModel}
            disabled={busyAction !== null}
            className="mt-3 w-full rounded-lg bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busyAction === 'model'
              ? t('stregaValve.applyingModel', { defaultValue: 'Saving model...' })
              : t('stregaValve.applyModel', { defaultValue: 'Save valve model' })}
          </button>
        </section>

        <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <p className="text-[var(--text)] text-sm font-semibold">{t('stregaValve.maintenance', { defaultValue: 'Maintenance' })}</p>
          <p className="text-[var(--text-tertiary)] text-xs mt-1">
            {t('stregaValve.magnetNote', { defaultValue: 'Magnet control resets to disabled after a device reboot.' })}
          </p>
          <label className="mt-3 flex items-center gap-3 text-sm text-[var(--text)]">
            <input
              type="checkbox"
              checked={magnetEnabled}
              disabled={busyAction === 'magnet'}
              onChange={(event) => setMagnetEnabled(event.target.checked)}
              className="w-4 h-4 accent-[var(--primary)]"
            />
            <span>{t('stregaValve.enableMagnet', { defaultValue: 'Enable external magnet control' })}</span>
          </label>
          <button
            type="button"
            onClick={applyMagnetMode}
            disabled={busyAction !== null}
            className="mt-3 w-full rounded-lg bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busyAction === 'magnet'
              ? t('stregaValve.applyingMagnet', { defaultValue: 'Updating magnet control...' })
              : t('stregaValve.applyMagnet', { defaultValue: 'Apply magnet setting' })}
          </button>
        </section>

        {isMotorized ? (
          <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 space-y-3">
            <div>
              <p className="text-[var(--text)] text-sm font-semibold">{t('stregaValve.motorizedHeading', { defaultValue: 'Motorized valve controls' })}</p>
              <p className="text-[var(--text-tertiary)] text-xs mt-1">
                {t('stregaValve.motorizedNote', { defaultValue: 'Partial opening and anti-sediment flushing are only supported for motorized valves.' })}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <select
                value={partialAction}
                disabled={busyAction === 'partial'}
                onChange={(event) => setPartialAction(event.target.value as 'OPEN' | 'CLOSE')}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
              >
                <option value="OPEN">{t('stregaValve.partialOpen', { defaultValue: 'Partial open' })}</option>
                <option value="CLOSE">{t('stregaValve.partialClose', { defaultValue: 'Partial close' })}</option>
              </select>
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                inputMode="numeric"
                value={partialPercentageInput}
                disabled={busyAction === 'partial'}
                onChange={(event) => setPartialPercentageInput(event.target.value)}
                placeholder="50"
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
              />
            </div>
            <button
              type="button"
              onClick={applyPartialOpening}
              disabled={busyAction !== null}
              className="w-full rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busyAction === 'partial'
                ? t('stregaValve.applyingPartial', { defaultValue: 'Queueing partial move...' })
                : t('stregaValve.applyPartial', { defaultValue: 'Queue partial move' })}
            </button>
            <div className="grid grid-cols-2 gap-2">
              <select
                value={flushReturnPosition}
                disabled={busyAction === 'flush'}
                onChange={(event) => setFlushReturnPosition(event.target.value as 'OPEN' | 'CLOSE')}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
              >
                <option value="OPEN">{t('stregaValve.returnOpen', { defaultValue: 'Return open' })}</option>
                <option value="CLOSE">{t('stregaValve.returnClosed', { defaultValue: 'Return closed' })}</option>
              </select>
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                inputMode="numeric"
                value={flushPercentageInput}
                disabled={busyAction === 'flush'}
                onChange={(event) => setFlushPercentageInput(event.target.value)}
                placeholder="30"
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
              />
            </div>
            <button
              type="button"
              onClick={applyFlushing}
              disabled={busyAction !== null}
              className="w-full rounded-lg bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busyAction === 'flush'
                ? t('stregaValve.applyingFlush', { defaultValue: 'Queueing flush...' })
                : t('stregaValve.applyFlush', { defaultValue: 'Queue anti-sediment flush' })}
            </button>
          </section>
        ) : (
          <p className="text-[var(--text-tertiary)] text-xs px-1">
            {t('stregaValve.motorizedLocked', { defaultValue: 'Set the valve model to motorized to unlock partial opening and flushing commands.' })}
          </p>
        )}
      </div>
      {info && <p className="text-[var(--text-tertiary)] text-xs mt-3 px-1">{info}</p>}
      {error && <p className="text-[var(--error-text)] text-xs mt-2 px-1">{error}</p>}
    </div>
  );
};

export const StregaValveCard: React.FC<StregaValveCardProps> = ({ device, onUpdate, onRemove }) => {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation('common');
  const [loading, setLoading] = useState<'OPEN' | 'CLOSE' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const lastSeenStr = device.last_seen ?? null;
  const lastSeen = lastSeenStr ? new Date(lastSeenStr) : null;
  const minutesAgo = lastSeen
    ? Math.floor((Date.now() - lastSeen.getTime()) / (1000 * 60))
    : null;

  const isOpen = device.current_state === 'OPEN';

  const handleAction = async (action: 'OPEN' | 'CLOSE') => {
    setLoading(action);
    setError(null);
    try {
      await devicesAPI.controlValve(device.deveui, { action });
      onUpdate();
    } catch (err: any) {
      setError(err.response?.data?.message || `Failed to ${action.toLowerCase()} valve`);
    } finally {
      setLoading(null);
    }
  };

  const handleRemove = async () => {
    setIsRemoving(true);
    setError(null);
    try {
      await devicesAPI.remove(device.deveui);
      onRemove?.();
    } catch (err: any) {
      setError(err.response?.data?.message || t('stregaValve.failedToRemove'));
      setIsRemoving(false);
    }
  };

  return (
    <div className="bg-[var(--surface)] border-2 border-[var(--border)] hover:border-[var(--focus)] rounded-xl p-6 shadow-lg transition-all">
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <h3 className="text-2xl font-bold text-[var(--text)] mb-1 high-contrast-text">
            {device.name}
          </h3>
          <p className="text-[var(--text-secondary)] text-sm">{device.deveui}</p>
        </div>
        <div className="flex items-start gap-2 relative">
          <div className="bg-[var(--primary)] text-white px-3 py-1 rounded-lg text-sm font-semibold">
            {t('stregaValve.badge')}
          </div>
          <button
            onClick={() => setShowConfig(v => !v)}
            className={`px-3 py-1 rounded-lg text-sm font-semibold transition-colors ${
              showConfig
                ? 'bg-[var(--primary)] text-white'
                : 'bg-[var(--card)] text-[var(--text-tertiary)] hover:bg-[var(--border)]'
            }`}
            title={t('stregaValve.settings')}
          >
            ⚙
          </button>
          {showConfig && (
            <ConfigPanel
              device={device}
              onUpdate={onUpdate}
              onClose={() => setShowConfig(false)}
            />
          )}
          <button
            onClick={() => setShowConfirm(true)}
            disabled={isRemoving || loading !== null}
            className="bg-[var(--error-bg)] hover:bg-[var(--error-bg)] disabled:bg-[var(--border)] text-[var(--error-text)] px-3 py-1 rounded-lg text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
            title="Remove device"
          >
            ✕
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-[var(--error-bg)] border border-[var(--error-bg)] text-[var(--error-text)] px-3 py-2 rounded-lg mb-4 text-sm">
          {error}
        </div>
      )}

      {showConfirm && (
        <div className="bg-[var(--warn-bg)] border-2 border-[var(--warn-border)] text-[var(--warn-text)] px-4 py-3 rounded-lg mb-4">
          <p className="font-bold mb-2">{t('stregaValve.removeConfirm')}</p>
          <p className="text-sm mb-3">{t('stregaValve.removeSubtitle')}</p>
          <div className="flex gap-2">
            <button
              onClick={handleRemove}
              disabled={isRemoving}
              className="bg-[var(--error-bg)] hover:bg-[var(--error-bg)] disabled:bg-[var(--border)] text-[var(--error-text)] font-bold px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center gap-2 disabled:text-[var(--text-disabled)]"
            >
              {isRemoving ? (
                <>
                  <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                  {t('stregaValve.removing')}
                </>
              ) : (
                t('stregaValve.yesRemove')
              )}
            </button>
            <button
              onClick={() => setShowConfirm(false)}
              disabled={isRemoving}
              className="bg-[var(--secondary-bg)] hover:bg-[var(--border)] disabled:bg-[var(--border)] text-[var(--text)] font-bold px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
            >
              {tc('cancel')}
            </button>
          </div>
        </div>
      )}

      <div className="bg-[var(--card)] rounded-lg p-6 mb-6">
        <p className="text-[var(--text-tertiary)] text-sm font-semibold mb-3">{t('stregaValve.status')}</p>
        <div className="flex items-center gap-3">
          <div
            className={`w-6 h-6 rounded-full ${
              isOpen ? 'bg-[var(--toggle-on)] animate-pulse' : 'bg-[var(--toggle-off)]'
            }`}
          />
          <p
            className={`text-3xl font-bold ${
              isOpen ? 'text-[var(--toggle-on)]' : 'text-[var(--text-tertiary)]'
            }`}
          >
            {isOpen ? t('stregaValve.open') : t('stregaValve.closed')}
          </p>
        </div>
        {device.target_state && device.target_state !== device.current_state && (
          <p className="text-[var(--text-secondary)] text-sm mt-2">
            {t('stregaValve.target', { state: device.target_state })}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <button
          onClick={() => handleAction('OPEN')}
          disabled={loading !== null}
          className="bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:bg-[var(--border)] text-white font-bold text-lg py-4 touch-target rounded-lg transition-colors shadow-lg disabled:cursor-not-allowed disabled:text-[var(--text-disabled)] flex items-center justify-center gap-2"
        >
          {loading === 'OPEN' ? (
            <>
              <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full" />
              {t('stregaValve.opening')}
            </>
          ) : (
            t('stregaValve.open')
          )}
        </button>
        <button
          onClick={() => handleAction('CLOSE')}
          disabled={loading !== null}
          className="bg-[var(--secondary-bg)] hover:bg-[var(--border)] disabled:bg-[var(--border)] text-[var(--text)] font-bold text-lg py-4 touch-target rounded-lg transition-colors shadow-lg disabled:cursor-not-allowed disabled:text-[var(--text-disabled)] flex items-center justify-center gap-2"
        >
          {loading === 'CLOSE' ? (
            <>
              <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full" />
              {t('stregaValve.closing')}
            </>
          ) : (
            t('stregaValve.closed')
          )}
        </button>
      </div>

      <div className="mt-4 pt-4 border-t border-[var(--border)]">
        <p className="text-[var(--text-tertiary)] text-sm">
          {minutesAgo !== null
            ? t('stregaValve.lastSeen', { minutes: minutesAgo })
            : t('stregaValve.neverSeen', { defaultValue: 'Never seen' })}
        </p>
      </div>
    </div>
  );
};
