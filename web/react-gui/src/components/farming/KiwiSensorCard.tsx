import React, { useState } from 'react';
import type { Device } from '../../types/farming';
import { devicesAPI } from '../../services/api';
import { SensorMonitor } from './SensorMonitor';

interface KiwiSensorCardProps {
  device: Device;
  onRemove?: () => void;
}

// ── Sensor display config ─────────────────────────────────────────────────────
interface SensorDef {
  key: keyof typeof KIWI_FIELDS;
  label: string;
  unit: string;
  color: string;
  decimals: number;
  field: string;
  format: (v: number) => string;
}

const KIWI_FIELDS = {
  swt_wm1: true, swt_wm2: true, light_lux: true,
  ambient_temperature: true, relative_humidity: true,
};

const SENSORS: SensorDef[] = [
  { key: 'swt_wm1',              field: 'swt_wm1',              label: 'Soil Water Tension 1', unit: 'kPa', color: '#3b82f6', decimals: 1, format: v => `${v.toFixed(1)} kPa` },
  { key: 'swt_wm2',              field: 'swt_wm2',              label: 'Soil Water Tension 2', unit: 'kPa', color: '#6366f1', decimals: 1, format: v => `${v.toFixed(1)} kPa` },
  { key: 'light_lux',            field: 'light_lux',            label: 'Light Intensity',      unit: 'lux', color: '#f59e0b', decimals: 0, format: v => `${v.toFixed(0)} lux` },
  { key: 'ambient_temperature',  field: 'ambient_temperature',  label: 'Ambient Temperature',  unit: '°C',  color: '#f97316', decimals: 1, format: v => `${v.toFixed(1)} °C`  },
  { key: 'relative_humidity',    field: 'relative_humidity',    label: 'Relative Humidity',    unit: '%',   color: '#06b6d4', decimals: 0, format: v => `${v.toFixed(0)} %`   },
];

export const KiwiSensorCard: React.FC<KiwiSensorCardProps> = ({ device, onRemove }) => {
  const { swt_wm1, swt_wm2, light_lux, ambient_temperature, relative_humidity } = device.latest_data;
  const lastSeen = new Date(device.last_seen);
  const minutesAgo = Math.floor((Date.now() - lastSeen.getTime()) / (1000 * 60));

  const [isRemoving, setIsRemoving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [monitor, setMonitor] = useState<SensorDef | null>(null);

  const dataValues: Record<string, number | undefined> = {
    swt_wm1, swt_wm2, light_lux, ambient_temperature, relative_humidity,
  };

  const handleRemove = async () => {
    setIsRemoving(true);
    setError(null);
    try {
      await devicesAPI.remove(device.deveui);
      if (onRemove) onRemove();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to remove device');
      setIsRemoving(false);
    }
  };

  // Only show sensors that have data
  const visibleSensors = SENSORS.filter(s => dataValues[s.field] !== undefined);

  return (
    <div className="rounded-xl p-6 border-2 shadow-lg transition-all bg-[var(--surface)] border-[var(--border)] hover:border-[var(--focus)]">

      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <h3 className="text-2xl font-bold text-[var(--text)] mb-1 high-contrast-text">
            {device.name}
          </h3>
          <p className="text-[var(--text-secondary)] text-sm">{device.deveui}</p>
        </div>
        <div className="flex items-start gap-2">
          <div className="bg-[var(--primary)] text-white px-3 py-1 rounded-lg text-sm font-semibold">
            KIWI SENSOR
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
          <p className="font-bold mb-2">Remove this device?</p>
          <p className="text-sm mb-3">This will unlink the device from your account.</p>
          <div className="flex gap-2">
            <button
              onClick={handleRemove}
              disabled={isRemoving}
              className="bg-[var(--error-bg)] hover:bg-[var(--error-bg)] disabled:bg-[var(--border)] text-[var(--error-text)] font-bold px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center gap-2 disabled:text-[var(--text-disabled)]"
            >
              {isRemoving ? (
                <><div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />Removing...</>
              ) : 'Yes, Remove'}
            </button>
            <button
              onClick={() => setShowConfirm(false)}
              disabled={isRemoving}
              className="bg-[var(--secondary-bg)] hover:bg-[var(--border)] disabled:bg-[var(--border)] text-[var(--text)] font-bold px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Sensor values — clickable to open monitor */}
      <div className="grid grid-cols-1 gap-4">
        {visibleSensors.map(sensor => {
          const val = dataValues[sensor.field];
          return (
            <div key={sensor.field} className="bg-[var(--card)] rounded-lg p-4">
              <p className="text-[var(--text-tertiary)] text-sm font-semibold mb-1 uppercase">
                {sensor.label}
              </p>
              {val !== undefined && val !== null ? (
                <button
                  onClick={() => setMonitor(sensor)}
                  className="text-4xl font-bold text-[var(--text)] hover:text-[var(--primary)] transition-colors text-left underline decoration-dotted underline-offset-4 cursor-pointer"
                  title="View history"
                >
                  {sensor.format(val)}
                </button>
              ) : (
                <p className="text-4xl font-bold text-[var(--text)]">—</p>
              )}
            </div>
          );
        })}

        {/* Fallback: show SWT1 as N/A if no data at all */}
        {visibleSensors.length === 0 && (
          <div className="bg-[var(--card)] rounded-lg p-4">
            <p className="text-[var(--text-tertiary)] text-sm font-semibold mb-1">SOIL WATER TENSION 1</p>
            <p className="text-4xl font-bold text-[var(--text)]">—</p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="mt-4 pt-4 border-t border-[var(--border)]">
        <p className="text-[var(--text-tertiary)] text-sm">
          Last seen: <span className="text-[var(--text)] font-semibold">{minutesAgo} minutes ago</span>
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
