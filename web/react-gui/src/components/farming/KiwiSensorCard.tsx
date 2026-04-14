import React, { useRef, useState } from 'react';
import type { Device } from '../../types/farming';
import { devicesAPI, kiwiAPI } from '../../services/api';
import { useDismissOnPointerDown } from '../../hooks/useDismissOnPointerDown';
import { useTranslation } from 'react-i18next';
import { SensorMonitor } from './SensorMonitor';

interface KiwiSensorCardProps {
  device: Device;
  onRemove?: () => void;
  onUpdate?: () => void;
}

interface SensorDef {
  field: string;
  label: string;
  unit: string;
  color: string;
  decimals: number;
}

const SENSORS: SensorDef[] = [
  { field: 'swt_wm1',             label: 'Soil Water Tension 1', unit: 'kPa', color: '#3b82f6', decimals: 1 },
  { field: 'swt_wm2',             label: 'Soil Water Tension 2', unit: 'kPa', color: '#6366f1', decimals: 1 },
  { field: 'light_lux',           label: 'Light Intensity',      unit: 'lux', color: '#f59e0b', decimals: 0 },
  { field: 'ambient_temperature', label: 'Ambient Temperature',  unit: '°C',  color: '#f97316', decimals: 1 },
  { field: 'relative_humidity',   label: 'Relative Humidity',    unit: '%',   color: '#06b6d4', decimals: 0 },
];

const SENSOR_BY_FIELD = Object.fromEntries(SENSORS.map(s => [s.field, s]));
const MAX_KIWI_INTERVAL_MINUTES = 1440;

const ConfigPanel: React.FC<{
  device: Device;
  onUpdate?: () => void;
  onClose: () => void;
}> = ({ device, onUpdate, onClose }) => {
  const { t } = useTranslation('devices');
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<'interval' | 'enable' | null>(null);
  const [intervalMinutesInput, setIntervalMinutesInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useDismissOnPointerDown(ref, onClose);

  const parseMinutes = (): number | null => {
    if (!intervalMinutesInput.trim()) return null;
    const minutes = Number(intervalMinutesInput);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_KIWI_INTERVAL_MINUTES) {
      return null;
    }
    return minutes;
  };

  const applyInterval = async () => {
    const minutes = parseMinutes();
    if (minutes == null) {
      setError(t('kiwiSensor.invalidInterval'));
      setInfo(null);
      return;
    }

    setBusy('interval');
    setError(null);
    setInfo(null);
    try {
      await kiwiAPI.setUplinkInterval(device.deveui, minutes);
      setIntervalMinutesInput(String(minutes));
      setInfo(t('kiwiSensor.intervalPending', { minutes }));
      onUpdate?.();
    } catch (err: any) {
      setError(err.response?.data?.message || t('kiwiSensor.failedToSetInterval'));
    } finally {
      setBusy(null);
    }
  };

  const enableTemperatureHumidity = async () => {
    const minutes = parseMinutes();
    if (minutes == null) {
      setError(t('kiwiSensor.enableTempHumidityRequiresInterval', {
        defaultValue: 'Enter a whole number of minutes between 1 and 1440 before enabling ambient temperature and humidity.',
      }));
      setInfo(null);
      return;
    }

    setBusy('enable');
    setError(null);
    setInfo(null);
    try {
      await kiwiAPI.enableTemperatureHumidity(device.deveui, minutes);
      setIntervalMinutesInput(String(minutes));
      setInfo(t('kiwiSensor.enableTempHumidityPending', { minutes }));
      onUpdate?.();
    } catch (err: any) {
      setError(err.response?.data?.message || t('kiwiSensor.failedToEnableTempHumidity'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 z-20 bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-xl p-3 min-w-[280px] max-w-[calc(100vw-2rem)]"
    >
      <p className="text-[var(--text-tertiary)] text-xs font-semibold mb-2 px-1">{t('kiwiSensor.settings')}</p>
      <div className="px-1">
        <label
          className="block text-[var(--text-secondary)] text-xs font-semibold mb-1"
          htmlFor={`kiwi-interval-${device.deveui}`}
        >
          {t('kiwiSensor.intervalLabel')}
        </label>
        <input
          id={`kiwi-interval-${device.deveui}`}
          type="number"
          min={1}
          max={MAX_KIWI_INTERVAL_MINUTES}
          step={1}
          inputMode="numeric"
          value={intervalMinutesInput}
          disabled={busy !== null}
          onChange={(event) => setIntervalMinutesInput(event.target.value)}
          placeholder={t('kiwiSensor.intervalPlaceholder')}
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--text)]"
        />
        <p className="text-[var(--text-tertiary)] text-xs mt-2">
          {t('kiwiSensor.intervalNote')}
        </p>
        <button
          type="button"
          onClick={applyInterval}
          disabled={busy !== null}
          className="mt-3 w-full rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === 'interval' ? t('kiwiSensor.applyingInterval') : t('kiwiSensor.applyInterval')}
        </button>
      </div>
      <div className="mt-3 pt-3 border-t border-[var(--border)] px-1">
        <p className="text-[var(--text-secondary)] text-xs font-semibold mb-1">
          {t('kiwiSensor.enableTempHumidityTitle')}
        </p>
        <p className="text-[var(--text-tertiary)] text-xs">
          {t('kiwiSensor.enableTempHumidityNote', {
            defaultValue: 'Enables ambient temperature and humidity reporting using the interval entered above.',
          })}
        </p>
        <button
          type="button"
          onClick={enableTemperatureHumidity}
          disabled={busy !== null}
          className="mt-3 w-full rounded-lg bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === 'enable' ? t('kiwiSensor.enablingTempHumidity') : t('kiwiSensor.enableTempHumidity')}
        </button>
      </div>
      {info && <p className="text-[var(--text-tertiary)] text-xs mt-3 px-1">{info}</p>}
      {error && <p className="text-[var(--error-text)] text-xs mt-2 px-1">{error}</p>}
    </div>
  );
};

export const KiwiSensorCard: React.FC<KiwiSensorCardProps> = ({ device, onRemove, onUpdate }) => {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation('common');
  const { swt_wm1, swt_wm2, light_lux, ambient_temperature, relative_humidity } = device.latest_data;
  const lastSeenStr = device.last_seen ?? null;
  const lastSeen = lastSeenStr ? new Date(lastSeenStr) : null;
  const minutesAgo = lastSeen
    ? Math.floor((Date.now() - lastSeen.getTime()) / (1000 * 60))
    : null;
  const [isRemoving, setIsRemoving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [monitor, setMonitor] = useState<SensorDef | null>(null);

  const handleRemove = async () => {
    setIsRemoving(true);
    setError(null);
    try {
      await devicesAPI.remove(device.deveui);
      onRemove?.();
    } catch (err: any) {
      setError(err.response?.data?.message || t('kiwiSensor.failedToRemove'));
      setIsRemoving(false);
    }
  };

  const renderValue = (field: string, formatted: string | null) => {
    const sensor = SENSOR_BY_FIELD[field];
    if (!formatted || !sensor) {
      return <p className="text-2xl font-bold text-[var(--text)] tabular-nums">{formatted ?? tc('na')}</p>;
    }
    return (
      <button
        onClick={() => setMonitor(sensor)}
        className="text-2xl font-bold tabular-nums text-[var(--text)] hover:text-[var(--primary)] transition-colors text-left underline decoration-dotted underline-offset-4 cursor-pointer"
        title="View history"
      >
        {formatted}
      </button>
    );
  };

  return (
    <div className="rounded-xl p-4 border shadow-sm transition-colors bg-[var(--surface)] border-[var(--border)] hover:border-[var(--focus)]">
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <h3 className="text-base font-semibold text-[var(--text)] truncate leading-tight">
          {device.name}
        </h3>
        <div className="flex items-center gap-1.5 shrink-0 relative">
          <span className="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-md text-xs font-semibold tracking-wide">
            {t('kiwiSensor.badge')}
          </span>
          <button
            onClick={() => setShowConfig(v => !v)}
            className={`p-1.5 rounded-md transition-colors ${
              showConfig
                ? 'bg-[var(--primary)] text-white'
                : 'text-[var(--text-tertiary)] hover:bg-[var(--card)] hover:text-[var(--text)]'
            }`}
            title={t('kiwiSensor.settings')}
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
            disabled={isRemoving}
            className="p-1.5 rounded-md bg-[var(--error-bg)] text-[var(--error-text)] hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            title="Remove device"
          >
            ✕
          </button>
        </div>
      </div>
      <p className="text-xs text-[var(--text-tertiary)] font-mono mb-3 truncate">{device.deveui}</p>

      {error && (
        <div className="bg-[var(--error-bg)] border border-[var(--error-bg)] text-[var(--error-text)] px-3 py-2 rounded-lg mb-4 text-sm">
          {error}
        </div>
      )}

      {showConfirm && (
        <div className="bg-[var(--warn-bg)] border-2 border-[var(--warn-border)] text-[var(--warn-text)] px-4 py-3 rounded-lg mb-4">
          <p className="font-bold mb-2">{t('kiwiSensor.removeConfirm')}</p>
          <p className="text-sm mb-3">{t('kiwiSensor.removeSubtitle')}</p>
          <div className="flex gap-2">
            <button
              onClick={handleRemove}
              disabled={isRemoving}
              className="bg-[var(--error-bg)] hover:bg-[var(--error-bg)] disabled:bg-[var(--border)] text-[var(--error-text)] font-bold px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center gap-2 disabled:text-[var(--text-disabled)]"
            >
              {isRemoving ? (
                <>
                  <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                  {t('kiwiSensor.removing')}
                </>
              ) : (
                t('kiwiSensor.yesRemove')
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

      <div className="grid grid-cols-1 gap-3">
        <div className="bg-[var(--card)] rounded-lg p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-1">
            {t('kiwiSensor.soilWaterTension1')}
          </p>
          {renderValue('swt_wm1', swt_wm1 !== undefined ? `${swt_wm1.toFixed(1)} kPa` : null)}
        </div>

        {swt_wm2 !== undefined && (
          <div className="bg-[var(--card)] rounded-lg p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-1">
              {t('kiwiSensor.soilWaterTension2')}
            </p>
            {renderValue('swt_wm2', `${swt_wm2.toFixed(1)} kPa`)}
          </div>
        )}

        {light_lux !== undefined && (
          <div className="bg-[var(--card)] rounded-lg p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-1">
              {t('kiwiSensor.lightIntensity')}
            </p>
            {renderValue('light_lux', `${light_lux.toFixed(0)} lux`)}
          </div>
        )}

        <div className="bg-[var(--card)] rounded-lg p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-1">{t('kiwiSensor.ambientTemperature')}</p>
          {renderValue(
            'ambient_temperature',
            ambient_temperature !== undefined && ambient_temperature !== null
              ? `${ambient_temperature.toFixed(1)} °C`
              : null,
          )}
        </div>

        <div className="bg-[var(--card)] rounded-lg p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-1">{t('kiwiSensor.relativeHumidity')}</p>
          {renderValue(
            'relative_humidity',
            relative_humidity !== undefined && relative_humidity !== null
              ? `${relative_humidity.toFixed(0)} %`
              : null,
          )}
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-[var(--border)]">
        <p className="text-xs text-[var(--text-tertiary)]">
          {minutesAgo !== null
            ? t('kiwiSensor.lastSeen', { minutes: minutesAgo })
            : t('kiwiSensor.neverSeen', { defaultValue: 'Never seen' })}
        </p>
      </div>

      {monitor && (
        <SensorMonitor
          deveui={device.deveui}
          deviceName={device.name}
          field={monitor.field}
          label={monitor.label}
          unit={monitor.unit}
          color={monitor.color}
          decimals={monitor.decimals}
          onClose={() => setMonitor(null)}
        />
      )}
    </div>
  );
};
