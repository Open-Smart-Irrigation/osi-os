import React, { useEffect, useRef, useState } from 'react';
import type { Device, Lsn50Mode } from '../../types/farming';
import { devicesAPI, lsn50API } from '../../services/api';
import { useDismissOnPointerDown } from '../../hooks/useDismissOnPointerDown';
import { DendrometerMonitor } from './DendrometerMonitor';
import { SensorMonitor } from './SensorMonitor';

const SENSOR_OPTIONS: Array<{
  key: 'temp_enabled' | 'dendro_enabled' | 'rain_gauge_enabled' | 'flow_meter_enabled';
  label: string;
  toggle: (deveui: string, enabled: boolean) => Promise<void>;
}> = [
  { key: 'temp_enabled', label: 'Temperature', toggle: (id, enabled) => lsn50API.setTempEnabled(id, enabled) },
  { key: 'dendro_enabled', label: 'Dendrometer', toggle: (id, enabled) => lsn50API.setDendroEnabled(id, enabled) },
  { key: 'rain_gauge_enabled', label: 'Rain Gauge', toggle: (id, enabled) => lsn50API.setRainGaugeEnabled(id, enabled) },
  { key: 'flow_meter_enabled', label: 'Flow Meter', toggle: (id, enabled) => lsn50API.setFlowMeterEnabled(id, enabled) },
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

const MAX_LSN50_INTERVAL_MINUTES = Math.floor(0xffffff / 60);
const MAX_LSN50_5V_WARMUP_MS = 65535;

function requiresMod9Counter(
  key: 'temp_enabled' | 'dendro_enabled' | 'rain_gauge_enabled' | 'flow_meter_enabled',
): boolean {
  return key === 'rain_gauge_enabled' || key === 'flow_meter_enabled';
}

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

function formatCounterInterval(seconds: number | null | undefined): string | null {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  const minutes = value / 60;
  if (minutes >= 1 && Math.abs(minutes - Math.round(minutes)) < 1e-9) {
    return `${Math.round(minutes)} min interval`;
  }
  if (minutes >= 1) {
    return `${minutes.toFixed(minutes >= 10 ? 1 : 2)} min interval`;
  }
  return `${Math.round(value)} s interval`;
}

function formatCounterStatus(status: string | null | undefined): string | null {
  switch (status) {
    case 'first_sample':
      return 'Waiting for the next uplink to calculate a delta.';
    case 'duplicate_timestamp':
      return 'Skipped duplicate uplink timestamp.';
    case 'out_of_order':
      return 'Skipped out-of-order uplink.';
    case 'counter_reset':
      return 'Counter reset detected; interval delta skipped.';
    case 'invalid_interval':
      return 'Invalid uplink interval; delta skipped.';
    default:
      return null;
  }
}

function formatPerTenMinuteValue(value: number | null | undefined, unit: string, digits = 1): string | null {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }
  return `${value.toFixed(digits)} ${unit} per 10 min`;
}

function formatDendroModeUsed(value: unknown): string | null {
  if (value === 'ratio_mod3') return 'Ratio MOD3';
  if (value === 'legacy_single_adc') return 'Legacy ADC';
  return null;
}

function isRatioDendroMode(value: unknown): boolean {
  return value === 'ratio_mod3';
}

interface DraginoTempCardProps {
  device: Device;
  onRemove?: () => void;
  onUpdate?: () => void;
}

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
  const selectedModeDescription = LSN50_MODE_OPTIONS.find((option) => option.value === selectedMode)?.description ?? '';
  const counterModeReady = currentMode === 'MOD9' || pendingMode === 'MOD9';

  useDismissOnPointerDown(ref, onClose);

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

  const toggle = async (option: typeof SENSOR_OPTIONS[number]) => {
    const current = device[option.key] === 1;
    if (!current && requiresMod9Counter(option.key) && !counterModeReady) {
      setError('Rain gauge and flow meter require MOD9. Apply MOD9 before enabling these counters.');
      return;
    }
    setBusy(option.key);
    setError(null);
    try {
      await option.toggle(device.deveui, !current);
      onUpdate();
    } catch {
      setError(`Failed to update ${option.label}`);
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
      className="absolute right-0 top-full z-20 mt-1 min-w-[280px] max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-xl"
    >
      <p className="mb-2 px-1 text-xs font-semibold text-[var(--text-tertiary)]">ACTIVE SENSORS</p>
      {SENSOR_OPTIONS.map((option) => {
        const enabled = device[option.key] === 1;
        const loading = busy === option.key;
        const disabledByMode = !enabled && requiresMod9Counter(option.key) && !counterModeReady;
        return (
          <label
            key={option.key}
            className={`flex cursor-pointer select-none items-center gap-3 rounded-lg px-1 py-2 hover:bg-[var(--card)] ${disabledByMode ? 'opacity-70' : ''}`}
          >
            <input
              type="checkbox"
              checked={enabled}
              disabled={loading}
              onChange={() => void toggle(option)}
              className="h-4 w-4 rounded border-[var(--border)] text-[var(--primary)] focus:ring-[var(--primary)]"
            />
            <span className="flex-1 text-sm text-[var(--text)]">{option.label}</span>
            {loading && <span className="text-xs text-[var(--text-tertiary)]">…</span>}
          </label>
        );
      })}

      <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">LSN50 mode</p>
            <p className="text-sm font-semibold text-[var(--text)]">{currentMode ?? 'Unknown'}</p>
          </div>
          {observedAt && (
            <span className="text-xs text-[var(--text-tertiary)]">
              Seen {new Date(observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        <select
          value={selectedMode}
          disabled={busy === 'mode'}
          onChange={(event) => setSelectedMode(event.target.value as Lsn50Mode)}
          className="mt-3 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
        >
          {LSN50_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.value}</option>
          ))}
        </select>
        <p className="mt-2 text-xs text-[var(--text-tertiary)]">{selectedModeDescription}</p>
        <button
          type="button"
          onClick={() => void applyMode()}
          disabled={busy !== null}
          className="mt-3 w-full rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === 'mode' ? 'Applying mode...' : 'Apply mode'}
        </button>
        {modeInfo && <p className="mt-2 text-xs text-[var(--text-tertiary)]">{modeInfo}</p>}
        {!counterModeReady && (
          <p className="mt-2 text-xs text-[var(--warn-text)]">Rain gauge and flow meter can only be enabled after MOD9 is active.</p>
        )}
      </div>

      <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
        <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]" htmlFor={`lsn50-interval-${device.deveui}`}>
          Uplink interval (minutes)
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
          placeholder="60"
          className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
        />
        <p className="mt-2 text-xs text-[var(--text-tertiary)]">Minimum 1 minute. Maximum {MAX_LSN50_INTERVAL_MINUTES} minutes.</p>
        <button
          type="button"
          onClick={() => void applyInterval()}
          disabled={busy !== null}
          className="mt-2 w-full rounded-lg bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === 'interval' ? 'Applying interval...' : 'Apply uplink interval'}
        </button>
        {intervalInfo && <p className="mt-2 text-xs text-[var(--text-tertiary)]">{intervalInfo}</p>}
      </div>

      <div className="mt-3 border-t border-[var(--border)] pt-3">
        <button
          type="button"
          onClick={() => setShowAdvanced((value) => !value)}
          className="flex w-full items-center justify-between rounded-lg bg-[var(--card)] px-3 py-2 text-left text-sm font-semibold text-[var(--text)]"
        >
          <span>Advanced device settings</span>
          <span className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`}>▾</span>
        </button>
        {showAdvanced && (
          <div className="mt-3 space-y-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-[var(--text-secondary)]">Interrupt trigger mode</label>
              <select
                value={interruptModeInput}
                disabled={busy === 'interrupt'}
                onChange={(event) => setInterruptModeInput(event.target.value)}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
              >
                {LSN50_INTERRUPT_MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void applyInterruptMode()}
                disabled={busy !== null}
                className="mt-2 w-full rounded-lg bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy === 'interrupt' ? 'Applying interrupt mode...' : 'Apply interrupt mode'}
              </button>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-[var(--text-secondary)]" htmlFor={`lsn50-warmup-${device.deveui}`}>
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
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
              />
              <p className="mt-2 text-xs text-[var(--text-tertiary)]">Useful for probes that need sensor power to settle before sampling.</p>
              <button
                type="button"
                onClick={() => void applyFiveVoltWarmup()}
                disabled={busy !== null}
                className="mt-2 w-full rounded-lg bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy === 'warmup' ? 'Applying 5V warm-up...' : 'Apply 5V warm-up'}
              </button>
            </div>
            <p className="text-xs text-[var(--warn-text)]">These controls are intended for external sensors and non-default LSN50 integrations.</p>
            {advancedInfo && <p className="text-xs text-[var(--text-tertiary)]">{advancedInfo}</p>}
          </div>
        )}
      </div>

      {error && <p className="mt-2 px-1 text-xs text-[var(--error-text)]">{error}</p>}
    </div>
  );
};

export const DraginoTempCard: React.FC<DraginoTempCardProps> = ({ device, onRemove, onUpdate }) => {
  const data = device.latest_data;
  const lastSeenStr = device.last_seen ?? null;
  const lastSeen = lastSeenStr ? new Date(lastSeenStr) : null;
  const minutesAgo = lastSeen ? Math.floor((Date.now() - lastSeen.getTime()) / (1000 * 60)) : null;
  const dendroEnabled = device.dendro_enabled === 1;
  const tempEnabled = device.temp_enabled === 1;
  const rainEnabled = device.rain_gauge_enabled === 1;
  const flowEnabled = device.flow_meter_enabled === 1;
  const intervalLabel = formatCounterInterval(data?.counter_interval_seconds);
  const rainStatusLabel = formatCounterStatus(data?.rain_delta_status);
  const flowStatusLabel = formatCounterStatus(data?.flow_delta_status);
  const rainRateSummary =
    formatPerTenMinuteValue(data?.rain_mm_per_10min, 'mm', 1)
    ?? (data?.rain_mm_per_hour != null && intervalLabel
      ? `${data.rain_mm_per_hour.toFixed(3)} mm/h over ${intervalLabel}`
      : null)
    ?? (intervalLabel ? `this ${intervalLabel.toLowerCase()}` : 'this interval');
  const flowRateSummary =
    formatPerTenMinuteValue(data?.flow_liters_per_10min, 'L', 0)
    ?? (data?.flow_liters_per_min != null && intervalLabel
      ? `${data.flow_liters_per_min.toFixed(3)} L/min over ${intervalLabel}`
      : null)
    ?? (intervalLabel ? `this ${intervalLabel.toLowerCase()}` : 'this interval');
  const dendroSourceLabel = formatDendroModeUsed(data?.dendro_mode_used);
  const dendroShowsRatioDebug = isRatioDendroMode(data?.dendro_mode_used);
  const dendroHasPosition = dendroEnabled && data?.dendro_valid === 1 && data?.dendro_position_mm != null;
  const dendroNeedsCalibration = dendroEnabled
    && data?.dendro_mode_used === 'ratio_mod3'
    && data?.dendro_valid !== 0
    && data?.dendro_position_mm == null
    && data?.dendro_ratio != null;
  const dendroSensorError = dendroEnabled && data?.dendro_valid === 0;
  const dendroDebugParts = [
    data?.adc_ch0v != null ? `CH0 ${data.adc_ch0v.toFixed(3)} V` : null,
    dendroShowsRatioDebug && data?.adc_ch1v != null ? `CH1 ${data.adc_ch1v.toFixed(3)} V` : null,
    dendroShowsRatioDebug && data?.dendro_ratio != null ? `ratio ${data.dendro_ratio.toFixed(4)}` : null,
    dendroSourceLabel,
  ].filter(Boolean) as string[];
  const dendroCardVisible = dendroEnabled && (dendroHasPosition || dendroNeedsCalibration || dendroSensorError || dendroDebugParts.length > 0);

  const [isRemoving, setIsRemoving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [showMonitor, setShowMonitor] = useState(false);
  const [sensorMonitor, setSensorMonitor] = useState<{
    field: string;
    label: string;
    unit: string;
    color: string;
    decimals: number;
    initialField?: string;
    seriesOptions?: Array<{ field: string; label: string; unit: string; color?: string; decimals?: number }>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRemove = async () => {
    setIsRemoving(true);
    setError(null);
    try {
      await devicesAPI.remove(device.deveui);
      onRemove?.();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to remove device');
      setIsRemoving(false);
    }
  };

  const batColour =
    data?.bat_v === undefined ? 'var(--text-tertiary)' :
    data.bat_v >= 3.2 ? '#22c55e' :
    data.bat_v >= 2.9 ? '#f59e0b' :
    '#ef4444';

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm transition-colors hover:border-[var(--focus)]">
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <h3 className="text-base font-semibold text-[var(--text)] truncate leading-tight">{device.name}</h3>
        <div className="relative flex items-center gap-1.5 shrink-0">
          <span className="bg-sky-100 text-sky-800 px-2 py-0.5 rounded-md text-xs font-semibold tracking-wide">
            LSN50
          </span>
          <button
            onClick={() => setShowConfig((value) => !value)}
            title="Configure active sensors"
            className={`p-1.5 rounded-md transition-colors ${
              showConfig
                ? 'bg-[var(--primary)] text-white'
                : 'text-[var(--text-tertiary)] hover:bg-[var(--card)] hover:text-[var(--text)]'
            }`}
          >
            ⚙
          </button>
          {showConfig && (
            <ConfigPanel
              device={device}
              onUpdate={() => { onUpdate?.(); }}
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
        <div className="mb-4 rounded-lg border border-[var(--error-bg)] bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error-text)]">
          {error}
        </div>
      )}

      {showConfirm && (
        <div className="mb-4 rounded-lg border-2 border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-3 text-[var(--warn-text)]">
          <p className="mb-2 font-bold">Remove this device?</p>
          <p className="mb-3 text-sm">This will unlink the device from your account.</p>
          <div className="flex gap-2">
            <button
              onClick={() => void handleRemove()}
              disabled={isRemoving}
              className="flex items-center gap-2 rounded-lg bg-[var(--error-bg)] px-4 py-2 font-bold text-[var(--error-text)] transition-colors disabled:cursor-not-allowed disabled:bg-[var(--border)] disabled:text-[var(--text-disabled)]"
            >
              {isRemoving ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Removing...
                </>
              ) : 'Yes, Remove'}
            </button>
            <button
              onClick={() => setShowConfirm(false)}
              disabled={isRemoving}
              className="rounded-lg bg-[var(--secondary-bg)] px-4 py-2 font-bold text-[var(--text)] transition-colors disabled:cursor-not-allowed disabled:bg-[var(--border)] disabled:text-[var(--text-disabled)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3">
        {tempEnabled && (
          <div className="rounded-lg bg-[var(--card)] p-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">TEMPERATURE</p>
            {data?.ext_temperature_c != null ? (
              <button
                onClick={() => setSensorMonitor({ field: 'ext_temperature_c', label: 'Temperature', unit: '°C', color: '#f97316', decimals: 1 })}
                className="cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]"
                title="View history"
              >
                {data.ext_temperature_c.toFixed(1)} °C
              </button>
            ) : (
              <p className="text-2xl font-bold tabular-nums text-[var(--text)]">—</p>
            )}
          </div>
        )}

        {data?.bat_v != null && (
          <div className="rounded-lg bg-[var(--card)] p-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">BATTERY</p>
            <button
              onClick={() => setSensorMonitor({ field: 'bat_v', label: 'Battery Voltage', unit: 'V', color: '#22c55e', decimals: 2 })}
              className="cursor-pointer text-left text-2xl font-bold tabular-nums underline decoration-dotted underline-offset-4 transition-opacity hover:opacity-75"
              style={{ color: batColour }}
              title="View history"
            >
              {data.bat_v.toFixed(2)} V
            </button>
          </div>
        )}

        {rainEnabled && (
          <div className="rounded-lg bg-[var(--card)] p-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Rain Gauge</p>
            <p className="mb-2 text-xs text-[var(--text-secondary)]">
              Today:{' '}
              <span className="font-semibold text-[var(--text)]">
                {data?.rain_mm_today != null ? `${data.rain_mm_today.toFixed(1)} mm` : '—'}
              </span>
            </p>
            <button
              onClick={() => setSensorMonitor({
                field: 'rain_mm_delta',
                initialField: 'rain_mm_delta',
                label: 'Rainfall',
                unit: 'mm',
                color: '#38bdf8',
                decimals: 1,
                seriesOptions: [
                  { field: 'rain_mm_delta', label: 'This interval', unit: 'mm', color: '#38bdf8', decimals: 1 },
                  { field: 'rain_mm_per_10min', label: 'Per 10 min (rate)', unit: 'mm', color: '#0ea5e9', decimals: 1 },
                ],
              })}
              className="cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]"
              title="View history"
            >
              {data?.rain_mm_delta != null ? `${data.rain_mm_delta.toFixed(1)} mm` : '—'}
            </button>
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">
              {rainRateSummary}
              {' · '}
              tap to view history
            </p>
            {rainStatusLabel && rainStatusLabel !== rainRateSummary && (
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">{rainStatusLabel}</p>
            )}
          </div>
        )}

        {flowEnabled && (
          <div className="rounded-lg bg-[var(--card)] p-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Flow Meter</p>
            <p className="mb-2 text-xs text-[var(--text-secondary)]">
              Today:{' '}
              <span className="font-semibold text-[var(--text)]">
                {data?.flow_liters_today != null ? `${data.flow_liters_today.toFixed(0)} L` : '—'}
              </span>
            </p>
            <button
              onClick={() => setSensorMonitor({
                field: 'flow_liters_delta',
                initialField: 'flow_liters_delta',
                label: 'Flow',
                unit: 'L',
                color: '#6366f1',
                decimals: 0,
                seriesOptions: [
                  { field: 'flow_liters_delta', label: 'This interval', unit: 'L', color: '#6366f1', decimals: 0 },
                  { field: 'flow_liters_per_10min', label: 'Per 10 min (rate)', unit: 'L', color: '#4f46e5', decimals: 0 },
                ],
              })}
              className="cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]"
              title="View history"
            >
              {data?.flow_liters_delta != null ? `${data.flow_liters_delta.toFixed(0)} L` : '—'}
            </button>
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">
              {flowRateSummary}
              {' · '}
              tap to view history
            </p>
            {flowStatusLabel && flowStatusLabel !== flowRateSummary && (
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">{flowStatusLabel}</p>
            )}
          </div>
        )}

        {dendroCardVisible && (
          <div className={`rounded-lg p-3 ${dendroSensorError ? 'bg-[var(--error-bg)]' : 'bg-[var(--card)]'}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">DENDROMETER POSITION</p>
                {dendroHasPosition ? (
                  <button
                    onClick={() => setShowMonitor(true)}
                    className="cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]"
                    title="View history"
                  >
                    {data.dendro_position_mm!.toFixed(2)} mm
                  </button>
                ) : dendroNeedsCalibration ? (
                  <p className="text-base font-bold text-[var(--warn-text)]">Calibration required</p>
                ) : dendroSensorError ? (
                  <p className="text-base font-bold text-[var(--error-text)]">SENSOR ERROR</p>
                ) : (
                  <p className="text-2xl font-bold tabular-nums text-[var(--text)]">—</p>
                )}
                {dendroHasPosition && data?.dendro_delta_mm != null && (
                  <p className={`mt-1 text-xs font-semibold ${data.dendro_delta_mm >= 0 ? 'text-[#22c55e]' : 'text-[var(--error-text)]'}`}>
                    {data.dendro_delta_mm >= 0 ? '+' : ''}{data.dendro_delta_mm.toFixed(3)} mm
                  </p>
                )}
              </div>
              {dendroSourceLabel && (
                <span className="rounded-full bg-[var(--secondary-bg)] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                  {dendroSourceLabel}
                </span>
              )}
            </div>
            {dendroDebugParts.length > 0 && (
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                {dendroDebugParts.join(' · ')}
                {dendroHasPosition ? ' · tap to monitor' : ''}
              </p>
            )}
            {dendroNeedsCalibration && (
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                Ratio mode is active, but this device still needs ratio calibration values.
              </p>
            )}
          </div>
        )}

        {!dendroEnabled && data?.adc_ch0v != null && data.adc_ch0v > 0.01 && (
          <div className="rounded-lg bg-[var(--card)] p-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">ADC INPUT</p>
            <button
              onClick={() => setSensorMonitor({ field: 'adc_ch0v', label: 'ADC Input', unit: 'V', color: '#8b5cf6', decimals: 3 })}
              className="cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]"
              title="View history"
            >
              {data.adc_ch0v.toFixed(3)} V
            </button>
          </div>
        )}
      </div>

      <div className="mt-3 border-t border-[var(--border)] pt-3">
        <p className="text-xs text-[var(--text-tertiary)]">
          Last seen:{' '}
          <span className="font-semibold text-[var(--text)]">
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
          initialField={sensorMonitor.initialField}
          seriesOptions={sensorMonitor.seriesOptions}
          onClose={() => setSensorMonitor(null)}
        />
      )}
    </div>
  );
};
