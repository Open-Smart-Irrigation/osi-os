import React, { useEffect, useRef, useState } from 'react';
import type { Device } from '../../types/farming';
import { devicesAPI, lsn50API } from '../../services/api';
import { DendrometerMonitor } from './DendrometerMonitor';
import { SensorMonitor } from './SensorMonitor';

// ── Sensor config registry ───────────────────────────────────────────────────
// Add future sensors (rain gauge, flow meter …) here only — no other UI changes
// needed when the corresponding DB column and API endpoint are wired up.
const SENSOR_OPTIONS: Array<{
  key: keyof Device;
  label: string;
  toggle: (deveui: string, enabled: boolean) => Promise<void>;
}> = [
  { key: 'temp_enabled',   label: 'Temperature',  toggle: (id, e) => lsn50API.setTempEnabled(id, e)   },
  { key: 'dendro_enabled', label: 'Dendrometer',  toggle: (id, e) => lsn50API.setDendroEnabled(id, e) },
];

// ── Props ────────────────────────────────────────────────────────────────────
interface DraginoTempCardProps {
  device: Device;
  onRemove?: () => void;
  onUpdate?: () => void;
}

// ── Gear-icon config panel ───────────────────────────────────────────────────
const ConfigPanel: React.FC<{
  device: Device;
  onUpdate: () => void;
  onClose: () => void;
}> = ({ device, onUpdate, onClose }) => {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const toggle = async (opt: typeof SENSOR_OPTIONS[0]) => {
    const current = device[opt.key] === 1;
    setBusy(opt.key as string);
    setError(null);
    try {
      await opt.toggle(device.deveui, !current);
      onUpdate();
    } catch {
      setError(`Failed to update ${opt.label}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 z-20 bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-xl p-3 min-w-[180px]"
    >
      <p className="text-[var(--text-tertiary)] text-xs font-semibold mb-2 px-1">ACTIVE SENSORS</p>
      {SENSOR_OPTIONS.map(opt => {
        const enabled = device[opt.key] === 1;
        const loading  = busy === (opt.key as string);
        return (
          <label
            key={opt.key as string}
            className="flex items-center gap-3 px-1 py-2 rounded-lg hover:bg-[var(--card)] cursor-pointer select-none"
          >
            <input
              type="checkbox"
              checked={enabled}
              disabled={loading}
              onChange={() => toggle(opt)}
              className="w-4 h-4 accent-[var(--primary)] cursor-pointer disabled:opacity-50"
            />
            <span className="text-[var(--text)] text-sm font-medium flex-1">{opt.label}</span>
            {loading && (
              <span className="w-3 h-3 border-2 border-[var(--primary)] border-t-transparent rounded-full animate-spin" />
            )}
          </label>
        );
      })}
      {error && <p className="text-[var(--error-text)] text-xs mt-2 px-1">{error}</p>}
    </div>
  );
};

// ── Main card ────────────────────────────────────────────────────────────────
export const DraginoTempCard: React.FC<DraginoTempCardProps> = ({ device, onRemove, onUpdate }) => {
  const { ext_temperature_c, bat_v, adc_ch0v, dendro_position_mm, dendro_valid, dendro_delta_mm } = device.latest_data;
  const lastSeen   = new Date(device.last_seen);
  const minutesAgo = Math.floor((Date.now() - lastSeen.getTime()) / (1000 * 60));

  const [isRemoving,   setIsRemoving]   = useState(false);
  const [showConfirm,  setShowConfirm]  = useState(false);
  const [showConfig,   setShowConfig]   = useState(false);
  const [showMonitor,  setShowMonitor]  = useState(false);
  const [sensorMonitor, setSensorMonitor] = useState<{ field: string; label: string; unit: string; color: string; decimals: number } | null>(null);
  const [error,        setError]        = useState<string | null>(null);

  const dendroEnabled = device.dendro_enabled === 1;
  const tempEnabled   = device.temp_enabled   === 1;

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

  const batColour =
    bat_v === undefined ? 'var(--text-tertiary)' :
    bat_v >= 3.2 ? '#22c55e' :
    bat_v >= 2.9 ? '#f59e0b' :
    '#ef4444';

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
        <div className="flex items-start gap-2 relative">
          <div className="bg-[var(--primary)] text-white px-3 py-1 rounded-lg text-sm font-semibold">
            LSN50
          </div>
          {/* Gear / sensor config */}
          <button
            onClick={() => setShowConfig(v => !v)}
            title="Configure active sensors"
            className={`px-3 py-1 rounded-lg text-sm font-semibold transition-colors ${
              showConfig
                ? 'bg-[var(--primary)] text-white'
                : 'bg-[var(--card)] text-[var(--text-tertiary)] hover:bg-[var(--border)]'
            }`}
          >
            ⚙
          </button>
          {showConfig && (
            <ConfigPanel
              device={device}
              onUpdate={() => { setShowConfig(false); if (onUpdate) onUpdate(); }}
              onClose={() => setShowConfig(false)}
            />
          )}
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

      <div className="grid grid-cols-1 gap-4">

        {/* Temperature — only when enabled */}
        {tempEnabled && (
          <div className="bg-[var(--card)] rounded-lg p-4">
            <p className="text-[var(--text-tertiary)] text-sm font-semibold mb-1">TEMPERATURE</p>
            {ext_temperature_c !== undefined && ext_temperature_c !== null ? (
              <button
                onClick={() => setSensorMonitor({ field: 'ext_temperature_c', label: 'Temperature', unit: '°C', color: '#f97316', decimals: 1 })}
                className="text-4xl font-bold text-[var(--text)] hover:text-[var(--primary)] transition-colors text-left underline decoration-dotted underline-offset-4 cursor-pointer"
                title="View history"
              >
                {ext_temperature_c.toFixed(1)} °C
              </button>
            ) : (
              <p className="text-4xl font-bold text-[var(--text)]">—</p>
            )}
          </div>
        )}

        {/* Battery */}
        {bat_v !== undefined && (
          <div className="bg-[var(--card)] rounded-lg p-4">
            <p className="text-[var(--text-tertiary)] text-sm font-semibold mb-1">BATTERY</p>
            <button
              onClick={() => setSensorMonitor({ field: 'bat_v', label: 'Battery Voltage', unit: 'V', color: '#22c55e', decimals: 2 })}
              className="text-4xl font-bold hover:opacity-75 transition-opacity text-left underline decoration-dotted underline-offset-4 cursor-pointer"
              style={{ color: batColour }}
              title="View history"
            >
              {bat_v.toFixed(2)} V
            </button>
          </div>
        )}

        {/* Dendrometer — only when enabled */}
        {dendroEnabled && dendro_position_mm !== undefined && dendro_position_mm !== null && (
          <div className={`rounded-lg p-4 ${dendro_valid ? 'bg-[var(--card)]' : 'bg-[var(--error-bg)]'}`}>
            <p className="text-[var(--text-tertiary)] text-sm font-semibold mb-1">DENDROMETER POSITION</p>
            {dendro_valid ? (
              <>
                <button
                  onClick={() => setShowMonitor(true)}
                  className="text-4xl font-bold text-[var(--text)] hover:text-[var(--primary)] transition-colors text-left underline decoration-dotted underline-offset-4 cursor-pointer"
                  title="View history"
                >
                  {dendro_position_mm.toFixed(2)} mm
                </button>
                {dendro_delta_mm !== undefined && dendro_delta_mm !== null && (
                  <p className={`text-sm font-semibold mt-1 ${dendro_delta_mm >= 0 ? 'text-[#22c55e]' : 'text-[var(--error-text)]'}`}>
                    {dendro_delta_mm >= 0 ? '+' : ''}{dendro_delta_mm.toFixed(3)} mm
                  </p>
                )}
                <p className="text-[var(--text-tertiary)] text-xs mt-1">ADC: {adc_ch0v?.toFixed(3)} V · tap to monitor</p>
              </>
            ) : (
              <p className="text-lg font-bold text-[var(--error-text)]">SENSOR ERROR</p>
            )}
          </div>
        )}

        {/* ADC raw — shown when dendro is disabled and ADC is non-trivial */}
        {!dendroEnabled && adc_ch0v !== undefined && adc_ch0v !== null && adc_ch0v > 0.01 && (
          <div className="bg-[var(--card)] rounded-lg p-4">
            <p className="text-[var(--text-tertiary)] text-sm font-semibold mb-1">ADC INPUT</p>
            <button
              onClick={() => setSensorMonitor({ field: 'adc_ch0v', label: 'ADC Input', unit: 'V', color: '#8b5cf6', decimals: 3 })}
              className="text-4xl font-bold text-[var(--text)] hover:text-[var(--primary)] transition-colors text-left underline decoration-dotted underline-offset-4 cursor-pointer"
              title="View history"
            >
              {adc_ch0v.toFixed(3)} V
            </button>
          </div>
        )}

      </div>

      {/* Footer */}
      <div className="mt-4 pt-4 border-t border-[var(--border)]">
        <p className="text-[var(--text-tertiary)] text-sm">
          Last seen: <span className="text-[var(--text)] font-semibold">{minutesAgo} minutes ago</span>
        </p>
      </div>

      {showMonitor && (
        <DendrometerMonitor
          deveui={device.deveui}
          deviceName={device.name}
          onClose={() => setShowMonitor(false)}
        />
      )}
      {sensorMonitor && (
        <SensorMonitor
          deveui={device.deveui}
          deviceName={device.name}
          field={sensorMonitor.field}
          label={sensorMonitor.label}
          unit={sensorMonitor.unit}
          color={sensorMonitor.color}
          decimals={sensorMonitor.decimals}
          onClose={() => setSensorMonitor(null)}
        />
      )}
    </div>
  );
};
