import React, { useState } from 'react';
import type { Device } from '../../types/farming';
import { devicesAPI } from '../../services/api';
import { useTranslation } from 'react-i18next';
import { SensorMonitor } from './SensorMonitor';

interface KiwiSensorCardProps {
  device: Device;
  onRemove?: () => void;
}

// ── Sensor monitor config ─────────────────────────────────────────────────────
interface SensorDef {
  field: string;
  label: string;  // used as the monitor drawer title (English)
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

export const KiwiSensorCard: React.FC<KiwiSensorCardProps> = ({ device, onRemove }) => {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation('common');
  const { swt_wm1, swt_wm2, light_lux, ambient_temperature, relative_humidity } = device.latest_data;
  const lastSeen = new Date(device.last_seen);
  const now = new Date();
  const minutesAgo = Math.floor((now.getTime() - lastSeen.getTime()) / (1000 * 60));
  const [isRemoving, setIsRemoving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [monitor, setMonitor] = useState<SensorDef | null>(null);

  const handleRemove = async () => {
    setIsRemoving(true);
    setError(null);
    try {
      await devicesAPI.remove(device.deveui);
      if (onRemove) {
        onRemove();
      }
    } catch (err: any) {
      setError(err.response?.data?.message || t('kiwiSensor.failedToRemove'));
      setIsRemoving(false);
    }
  };

  // Helper: render a sensor value as a clickable button (if non-null) or plain text
  const renderValue = (field: string, formatted: string | null) => {
    const sensor = SENSOR_BY_FIELD[field];
    if (!formatted || !sensor) {
      return <p className="text-4xl font-bold text-[var(--text)]">{formatted ?? tc('na')}</p>;
    }
    return (
      <button
        onClick={() => setMonitor(sensor)}
        className="text-4xl font-bold text-[var(--text)] hover:text-[var(--primary)] transition-colors text-left underline decoration-dotted underline-offset-4 cursor-pointer"
        title="View history"
      >
        {formatted}
      </button>
    );
  };

  return (
    <div className="rounded-xl p-6 border-2 shadow-lg transition-all bg-[var(--surface)] border-[var(--border)] hover:border-[var(--focus)]">
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <h3 className="text-2xl font-bold text-[var(--text)] mb-1 high-contrast-text">
            {device.name}
          </h3>
          <p className="text-[var(--text-secondary)] text-sm">{device.deveui}</p>
        </div>
        <div className="flex items-start gap-2">
          <div className="bg-[var(--primary)] text-white px-3 py-1 rounded-lg text-sm font-semibold">
            {t('kiwiSensor.badge')}
          </div>
          <button
            onClick={() => setShowConfirm(true)}
            disabled={isRemoving}
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

      <div className="grid grid-cols-1 gap-4">
        {/* Soil Water Tension 1 */}
        <div className="bg-[var(--card)] rounded-lg p-4">
          <p className="text-[var(--text-tertiary)] text-sm font-semibold mb-1">
            {t('kiwiSensor.soilWaterTension1')}
          </p>
          {renderValue('swt_wm1', swt_wm1 !== undefined ? `${swt_wm1.toFixed(1)} kPa` : null)}
        </div>

        {/* Soil Water Tension 2 */}
        {swt_wm2 !== undefined && (
          <div className="bg-[var(--card)] rounded-lg p-4">
            <p className="text-[var(--text-tertiary)] text-sm font-semibold mb-1">
              {t('kiwiSensor.soilWaterTension2')}
            </p>
            {renderValue('swt_wm2', `${swt_wm2.toFixed(1)} kPa`)}
          </div>
        )}

        {/* Light */}
        {light_lux !== undefined && (
          <div className="bg-[var(--card)] rounded-lg p-4">
            <p className="text-[var(--text-tertiary)] text-sm font-semibold mb-1">
              {t('kiwiSensor.lightIntensity')}
            </p>
            {renderValue('light_lux', `${light_lux.toFixed(0)} lux`)}
          </div>
        )}

        <div className="bg-[var(--card)] rounded-lg p-4">
          <p className="text-[var(--text-tertiary)] text-sm font-semibold mb-1">{t('kiwiSensor.ambientTemperature')}</p>
          {renderValue(
            'ambient_temperature',
            ambient_temperature !== undefined && ambient_temperature !== null
              ? `${ambient_temperature.toFixed(1)} °C`
              : null,
          )}
        </div>

        <div className="bg-[var(--card)] rounded-lg p-4">
          <p className="text-[var(--text-tertiary)] text-sm font-semibold mb-1">{t('kiwiSensor.relativeHumidity')}</p>
          {renderValue(
            'relative_humidity',
            relative_humidity !== undefined && relative_humidity !== null
              ? `${relative_humidity.toFixed(0)} %`
              : null,
          )}
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-[var(--border)]">
        <p className="text-[var(--text-tertiary)] text-sm">
          {t('kiwiSensor.lastSeen', { minutes: minutesAgo })}
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
