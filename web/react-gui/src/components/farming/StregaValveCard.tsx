import React, { useEffect, useRef, useState } from 'react';
import type { Device } from '../../types/farming';
import { devicesAPI, stregaAPI } from '../../services/api';
import { useTranslation } from 'react-i18next';

interface StregaValveCardProps {
  device: Device;
  onUpdate: () => void;
  onRemove?: () => void;
}

const MAX_STREGA_INTERVAL_MINUTES = 255;

const ConfigPanel: React.FC<{
  device: Device;
  onUpdate: () => void;
  onClose: () => void;
}> = ({ device, onUpdate, onClose }) => {
  const { t } = useTranslation('devices');
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [intervalMinutesInput, setIntervalMinutesInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const applyInterval = async () => {
    const minutes = Number(intervalMinutesInput);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_STREGA_INTERVAL_MINUTES) {
      setError(t('stregaValve.invalidInterval'));
      setInfo(null);
      return;
    }

    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await stregaAPI.setUplinkInterval(device.deveui, minutes);
      setIntervalMinutesInput(String(minutes));
      setInfo(t('stregaValve.intervalPending', { minutes }));
      onUpdate();
    } catch (err: any) {
      setError(err.response?.data?.message || t('stregaValve.failedToSetInterval'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 z-20 bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-xl p-3 min-w-[300px]"
    >
      <p className="text-[var(--text-tertiary)] text-xs font-semibold mb-2 px-1">{t('stregaValve.settings')}</p>
      <div className="px-1">
        <label
          className="block text-[var(--text-secondary)] text-xs font-semibold mb-1"
          htmlFor={`strega-interval-${device.deveui}`}
        >
          {t('stregaValve.intervalLabel')}
        </label>
        <input
          id={`strega-interval-${device.deveui}`}
          type="number"
          min={1}
          max={MAX_STREGA_INTERVAL_MINUTES}
          step={1}
          inputMode="numeric"
          value={intervalMinutesInput}
          disabled={busy}
          onChange={(event) => setIntervalMinutesInput(event.target.value)}
          placeholder={t('stregaValve.intervalPlaceholder')}
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--text)]"
        />
        <p className="text-[var(--text-tertiary)] text-xs mt-2">
          {t('stregaValve.intervalNote')}
        </p>
        <button
          type="button"
          onClick={applyInterval}
          disabled={busy}
          className="mt-3 w-full rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? t('stregaValve.applyingInterval') : t('stregaValve.applyInterval')}
        </button>
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
