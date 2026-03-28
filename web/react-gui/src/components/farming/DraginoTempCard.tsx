import React, { useEffect, useRef, useState } from 'react';
import type { Device, Lsn50Mode } from '../../types/farming';
import { devicesAPI, lsn50API } from '../../services/api';
import { DendrometerMonitor } from './DendrometerMonitor';
import { SensorMonitor } from './SensorMonitor';

// ── Sensor config registry ────────────────────────────────────────────────────
const SENSOR_OPTIONS: Array<{
  key: keyof Device;
  label: string;
  toggle: (deveui: string, enabled: boolean) => Promise<void>;
}> = [
  { key: 'temp_enabled',        label: 'Temperature',  toggle: (id, e) => lsn50API.setTempEnabled(id, e)        },
  { key: 'dendro_enabled',      label: 'Dendrometer',  toggle: (id, e) => lsn50API.setDendroEnabled(id, e)      },
  { key: 'rain_gauge_enabled',  label: 'Rain Gauge',   toggle: (id, e) => lsn50API.setRainGaugeEnabled(id, e)   },
  { key: 'flow_meter_enabled',  label: 'Flow Meter',   toggle: (id, e) => lsn50API.setFlowMeterEnabled(id, e)   },
];

const LSN50_MODE_OPTIONS: Array<{ value: Lsn50Mode; description: string }> = [
  { value: 'MOD1', description: 'Default OSI mode with temperature probe and ADC support.' },
  { value: 'MOD2', description: 'Distance mode.' },
  { value: 'MOD3', description: 'Three ADC channels plus I2C mode.' },
  { value: 'MOD4', description: 'Three DS18B20 temperature channels mode.' },
  { value: 'MOD5', description: 'Weight mode.' },
  { value: 'MOD6', description: 'Counting mode.' },
  { value: 'MOD7', description: 'Three digital interrupt channels mode.' },
  { value: 'MOD8', description: 'Three ADC channels plus one DS18B20 mode.' },
  { value: 'MOD9', description: 'Rain gauge and flow counter mode.' },
];
const LSN50_INTERRUPT_MODE_OPTIONS = [
  { value: 0, label: 'Disabled' },
  { value: 1, label: 'Rising or falling edge' },
  { value: 2, label: 'Falling edge only' },
  { value: 3, label: 'Rising edge only' },
];
const MAX_LSN50_INTERVAL_MINUTES = Math.floor(0xFFFFFF / 60);
const MAX_LSN50_5V_WARMUP_MS = 65535;

function normaliseLsn50Mode(value: unknown): Lsn50Mode | null {
  const raw = String(value ?? '').trim().toUpperCase();
  return raw === 'MOD1' || raw === 'MOD2' || raw === 'MOD3' || raw === 'MOD4' || raw === 'MOD5' || raw === 'MOD6' || raw === 'MOD7' || raw === 'MOD8' || raw === 'MOD9'
    ? raw
    : null;
}

function getCurrentLsn50Mode(device: Device): Lsn50Mode | null {
  const observed = normaliseLsn50Mode(device.latest_data?.lsn50_mode_label);
  if (observed) return observed;
  const configured = Number(device.device_mode ?? 0);
  return configured >= 1 && configured <= 9 ? (`MOD${configured}` as Lsn50Mode) : null;
}

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
  const [selectedMode, setSelectedMode] = useState<Lsn50Mode>(getCurrentLsn50Mode(device) ?? 'MOD1');
  const [pendingMode, setPendingMode] = useState<Lsn50Mode | null>(null);
  const [modeInfo, setModeInfo] = useState<string | null>(null);
  const [intervalMinutesInput, setIntervalMinutesInput] = useState('');
  const [intervalInfo, setIntervalInfo] = useState<string | null>(null);
  const [interruptModeInput, setInterruptModeInput] = useState('0');
  const [warmupMillisecondsInput, setWarmupMillisecondsInput] = useState('');
  const [advancedInfo, setAdvancedInfo] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const currentMode = getCurrentLsn50Mode(device);
  const observedAt = device.latest_data?.lsn50_mode_observed_at ?? null;
  const selectedModeDescription = LSN50_MODE_OPTIONS.find(option => option.value === selectedMode)?.description ?? '';

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  useEffect(() => {
    if (!pendingMode) {
      setSelectedMode(currentMode ?? 'MOD1');
    }
  }, [currentMode, pendingMode]);

  useEffect(() => {
    if (pendingMode && currentMode === pendingMode) {
      setModeInfo(`Mode ${pendingMode} confirmed on the latest uplink.`);
      setPendingMode(null);
    }
  }, [currentMode, pendingMode]);

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

  const applyMode = async () => {
    if (selectedMode === currentMode && !pendingMode) {
      setModeInfo(`LSN50 is already using ${selectedMode}.`);
      return;
    }
    if (
      selectedMode !== 'MOD1' &&
      (device.dendro_enabled === 1 || device.temp_enabled === 1) &&
      !window.confirm('Switching away from MOD1 can change the telemetry OSI receives from this node. Continue?')
    ) {
      return;
    }

    setBusy('mode');
    setError(null);
    setModeInfo(null);
    try {
      await lsn50API.setMode(device.deveui, selectedMode);
      setPendingMode(selectedMode);
      setModeInfo(`Mode change requested; waiting for the next uplink to confirm ${selectedMode}.`);
      onUpdate();
    } catch {
      setPendingMode(null);
      setError('Failed to change LSN50 mode');
    } finally {
      setBusy(null);
    }
  };

  const applyInterval = async () => {
    const parsed = Number(intervalMinutesInput);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LSN50_INTERVAL_MINUTES) {
      setError(`Enter a whole number of minutes between 1 and ${MAX_LSN50_INTERVAL_MINUTES}.`);
      setIntervalInfo(null);
      return;
    }

    setBusy('interval');
    setError(null);
    setIntervalInfo(null);
    try {
      await lsn50API.setUplinkInterval(device.deveui, parsed);
      setIntervalMinutesInput(String(parsed));
      setIntervalInfo(`Uplink interval change requested for ${parsed} minute${parsed === 1 ? '' : 's'}. The device applies this after it receives the downlink.`);
      onUpdate();
    } catch {
      setError('Failed to change LSN50 uplink interval');
    } finally {
      setBusy(null);
    }
  };

  const applyInterruptMode = async () => {
    const parsed = Number(interruptModeInput);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3) {
      setError('Interrupt mode must be between 0 and 3.');
      setAdvancedInfo(null);
      return;
    }

    setBusy('interrupt');
    setError(null);
    setAdvancedInfo(null);
    try {
      await lsn50API.setInterruptMode(device.deveui, parsed);
      setAdvancedInfo(`Interrupt mode ${parsed} requested. This affects external interrupt-driven sensor inputs.`);
      onUpdate();
    } catch {
      setError('Failed to change the LSN50 interrupt mode');
    } finally {
      setBusy(null);
    }
  };

  const applyFiveVoltWarmup = async () => {
    const parsed = Number(warmupMillisecondsInput);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_LSN50_5V_WARMUP_MS) {
      setError(`Enter a warm-up time between 0 and ${MAX_LSN50_5V_WARMUP_MS} ms.`);
      setAdvancedInfo(null);
      return;
    }

    setBusy('warmup');
    setError(null);
    setAdvancedInfo(null);
    try {
      await lsn50API.setFiveVoltWarmup(device.deveui, parsed);
      setAdvancedInfo(`5V warm-up request queued for ${parsed} ms.`);
      onUpdate();
    } catch {
      setError('Failed to change the 5V warm-up time');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 z-20 bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-xl p-3 min-w-[280px] max-w-[calc(100vw-2rem)]"
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
      <div className="mt-3 pt-3 border-t border-[var(--border)]">
        <p className="text-[var(--text-tertiary)] text-xs font-semibold mb-2 px-1">DEVICE MODE</p>
        <div className="px-1">
          <div className="flex items-center justify-between gap-3 text-sm mb-2">
            <span className="text-[var(--text-secondary)]">Current mode</span>
            <span className="rounded-full bg-[var(--card)] px-2 py-1 font-semibold text-[var(--text)]">
              {currentMode ?? 'Unknown'}
            </span>
          </div>
          {observedAt && (
            <p className="text-[var(--text-tertiary)] text-xs mb-3">
              Observed {new Date(observedAt).toLocaleString()}
            </p>
          )}
          <label className="block text-[var(--text-secondary)] text-xs font-semibold mb-1">
            Requested mode
          </label>
          <select
            value={selectedMode}
            disabled={busy === 'mode'}
            onChange={(event) => setSelectedMode(event.target.value as Lsn50Mode)}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--text)]"
          >
            {LSN50_MODE_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>
                {option.value}
              </option>
            ))}
          </select>
          <p className="text-[var(--text-tertiary)] text-xs mt-2">{selectedModeDescription}</p>
          <p className="text-[var(--text-tertiary)] text-xs mt-2">
            Mode changes are confirmed after the next uplink.
          </p>
          <button
            type="button"
            onClick={applyMode}
            disabled={busy === 'mode'}
            className="mt-3 w-full rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === 'mode' ? 'Applying mode...' : 'Apply mode'}
          </button>
          {modeInfo && <p className="text-[var(--text-tertiary)] text-xs mt-2">{modeInfo}</p>}
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-[var(--border)]">
        <p className="text-[var(--text-tertiary)] text-xs font-semibold mb-2 px-1">UPLINK INTERVAL</p>
        <div className="px-1">
          <label className="block text-[var(--text-secondary)] text-xs font-semibold mb-1" htmlFor={`lsn50-interval-${device.deveui}`}>
            Desired interval (minutes)
          </label>
          <input
            id={`lsn50-interval-${device.deveui}`}
            type="number"
            min={1}
            max={MAX_LSN50_INTERVAL_MINUTES}
            step={1}
            inputMode="numeric"
            value={intervalMinutesInput}
            disabled={busy === 'interval'}
            onChange={(event) => setIntervalMinutesInput(event.target.value)}
            placeholder="e.g. 20"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--text)]"
          />
          <p className="text-[var(--text-tertiary)] text-xs mt-2">
            Enter whole minutes. Normal LSN50 uplinks do not report the active interval back to OSI.
          </p>
          <button
            type="button"
            onClick={applyInterval}
            disabled={busy === 'interval'}
            className="mt-3 w-full rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === 'interval' ? 'Applying interval...' : 'Apply interval'}
          </button>
          {intervalInfo && <p className="text-[var(--text-tertiary)] text-xs mt-2">{intervalInfo}</p>}
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-[var(--border)]">
        <button
          type="button"
          onClick={() => setShowAdvanced(v => !v)}
          className="w-full flex items-center justify-between px-1 py-1 text-xs font-semibold text-[var(--text-tertiary)] hover:text-[var(--text)] transition-colors"
        >
          <span>ADVANCED SENSOR I/O</span>
          <span>{showAdvanced ? '▲' : '▼'}</span>
        </button>
        {showAdvanced && <div className="px-1 mt-2 space-y-3">
          <div>
            <label className="block text-[var(--text-secondary)] text-xs font-semibold mb-1">
              Interrupt trigger mode
            </label>
            <select
              value={interruptModeInput}
              disabled={busy === 'interrupt'}
              onChange={(event) => setInterruptModeInput(event.target.value)}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--text)]"
            >
              {LSN50_INTERRUPT_MODE_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={applyInterruptMode}
              disabled={busy !== null}
              className="mt-2 w-full rounded-lg bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === 'interrupt' ? 'Applying interrupt mode...' : 'Apply interrupt mode'}
            </button>
          </div>
          <div>
            <label className="block text-[var(--text-secondary)] text-xs font-semibold mb-1" htmlFor={`lsn50-warmup-${device.deveui}`}>
              5V warm-up time (ms)
            </label>
            <input
              id={`lsn50-warmup-${device.deveui}`}
              type="number"
              min={0}
              max={MAX_LSN50_5V_WARMUP_MS}
              step={1}
              inputMode="numeric"
              value={warmupMillisecondsInput}
              disabled={busy === 'warmup'}
              onChange={(event) => setWarmupMillisecondsInput(event.target.value)}
              placeholder="1000"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--text)]"
            />
            <p className="text-[var(--text-tertiary)] text-xs mt-2">
              Useful for probes that need sensor power to settle before sampling.
            </p>
            <button
              type="button"
              onClick={applyFiveVoltWarmup}
              disabled={busy !== null}
              className="mt-2 w-full rounded-lg bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === 'warmup' ? 'Applying 5V warm-up...' : 'Apply 5V warm-up'}
            </button>
          </div>
          <p className="text-[var(--warn-text)] text-xs">
            These controls are intended for external sensors and non-default LSN50 integrations.
          </p>
          {advancedInfo && <p className="text-[var(--text-tertiary)] text-xs">{advancedInfo}</p>}
        </div>}
      </div>
      {error && <p className="text-[var(--error-text)] text-xs mt-2 px-1">{error}</p>}
    </div>
  );
};

// ── Main card ────────────────────────────────────────────────────────────────
export const DraginoTempCard: React.FC<DraginoTempCardProps> = ({ device, onRemove, onUpdate }) => {
  const {
    ext_temperature_c, bat_v, adc_ch0v,
    dendro_position_mm, dendro_valid, dendro_delta_mm,
    rain_mm_delta, flow_liters_delta,
  } = device.latest_data;
  const rainEnabled = device.rain_gauge_enabled === 1;
  const flowEnabled = device.flow_meter_enabled === 1;
  const lastSeenStr = device.last_seen ?? null;
  const lastSeen = lastSeenStr ? new Date(lastSeenStr) : null;
  const minutesAgo = lastSeen
    ? Math.floor((Date.now() - lastSeen.getTime()) / (1000 * 60))
    : null;

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
              onUpdate={() => { if (onUpdate) onUpdate(); }}
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

        {/* Rain gauge (Davis 6466M) — shown when rain_gauge_enabled */}
        {rainEnabled && (
          <div className="bg-[var(--card)] rounded-lg p-4">
            <p className="text-[var(--text-tertiary)] text-sm font-semibold mb-1">RAIN GAUGE</p>
            {rain_mm_delta !== null && rain_mm_delta !== undefined ? (
              <button
                onClick={() => setSensorMonitor({ field: 'rain_mm_delta', label: 'Rainfall', unit: 'mm', color: '#38bdf8', decimals: 1 })}
                className="text-4xl font-bold text-[var(--text)] hover:text-[var(--primary)] transition-colors text-left underline decoration-dotted underline-offset-4 cursor-pointer"
                title="View history"
              >
                {rain_mm_delta.toFixed(1)} mm
              </button>
            ) : (
              <p className="text-4xl font-bold text-[var(--text-tertiary)]">—</p>
            )}
            <p className="text-[var(--text-tertiary)] text-xs mt-1">this interval · tap to view history</p>
          </div>
        )}

        {/* Flow meter (GWF Unico2) — shown when flow_meter_enabled */}
        {flowEnabled && (
          <div className="bg-[var(--card)] rounded-lg p-4">
            <p className="text-[var(--text-tertiary)] text-sm font-semibold mb-1">FLOW METER</p>
            {flow_liters_delta !== null && flow_liters_delta !== undefined ? (
              <button
                onClick={() => setSensorMonitor({ field: 'flow_liters_delta', label: 'Flow', unit: 'L', color: '#6366f1', decimals: 0 })}
                className="text-4xl font-bold text-[var(--text)] hover:text-[var(--primary)] transition-colors text-left underline decoration-dotted underline-offset-4 cursor-pointer"
                title="View history"
              >
                {flow_liters_delta.toFixed(0)} L
              </button>
            ) : (
              <p className="text-4xl font-bold text-[var(--text-tertiary)]">—</p>
            )}
            <p className="text-[var(--text-tertiary)] text-xs mt-1">this interval · tap to view history</p>
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
          Last seen:{' '}
          <span className="text-[var(--text)] font-semibold">
            {minutesAgo !== null ? `${minutesAgo} minutes ago` : 'Never seen'}
          </span>
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
