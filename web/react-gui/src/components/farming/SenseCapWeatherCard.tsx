import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDismissOnPointerDown } from '../../hooks/useDismissOnPointerDown';
import { devicesAPI, getApiErrorMessage, s2120API } from '../../services/api';
import type { Device } from '../../types/farming';
import { formatWindDirection } from '../../utils/wind';
import { SensorMonitor } from './SensorMonitor';
import { WindMonitor } from './WindMonitor';
import { DeviceCardFooter } from './shared/DeviceCardFooter';

interface Props {
  device: Device;
  onRemove?: () => void;
  onUpdate?: () => void;
  allZones?: Array<{ id: number; name: string }>;
}

type SensorMonitorConfig = {
  field: string;
  label: string;
  unit: string;
  color: string;
  decimals: number;
  initialField?: string;
  seriesOptions?: Array<{ field: string; label: string; unit: string; color?: string; decimals?: number }>;
};

function fmtNum(value: number | null | undefined, decimals: number, unit: string): string {
  if (value == null) return '—';
  return `${value.toFixed(decimals)} ${unit}`;
}

function fmtLux(value: number | null | undefined): string {
  if (value == null) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k lux` : `${Math.round(value)} lux`;
}

function lastSeenLabel(lastSeen: string | null | undefined): string {
  if (!lastSeen) return 'never';
  const diff = Math.floor((Date.now() - new Date(lastSeen).getTime()) / 60000);
  if (diff < 1) return 'just now';
  if (diff < 60) return `${diff} min ago`;
  return `${Math.floor(diff / 60)}h ago`;
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

const ZonePickerPanel: React.FC<{
  device: Device;
  allZones: Array<{ id: number; name: string }>;
  onClose: () => void;
  onUpdate?: () => void;
}> = ({ device, allZones, onClose, onUpdate }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set(device.zone_ids ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useDismissOnPointerDown(ref, onClose);

  const toggle = (id: number) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await s2120API.setZoneAssignments(device.deveui, Array.from(selected));
      onUpdate?.();
      onClose();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Failed to save'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={ref}
      className="absolute right-0 top-8 z-20 w-56 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 shadow-lg"
    >
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
        Zone Assignments
      </p>
      <div className="mb-3 flex max-h-40 flex-col gap-1 overflow-y-auto">
        {allZones.map((zone) => (
          <label key={zone.id} className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.has(zone.id)}
              onChange={() => toggle(zone.id)}
              className="rounded"
            />
            <span className="truncate">{zone.name}</span>
          </label>
        ))}
        {allZones.length === 0 && (
          <p className="text-xs text-[var(--text-tertiary)]">No zones available</p>
        )}
      </div>
      {error && <p className="mb-2 text-xs text-[var(--error-text)]">{error}</p>}
      <button
        onClick={save}
        disabled={busy}
        className="w-full rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
      >
        {busy ? 'Saving...' : 'Save'}
      </button>
    </div>
  );
};

export const SenseCapWeatherCard: React.FC<Props> = ({ device, onRemove, onUpdate, allZones = [] }) => {
  const { t: tc } = useTranslation('common');
  const data = device.latest_data ?? {};
  const [showConfig, setShowConfig] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sensorMonitor, setSensorMonitor] = useState<SensorMonitorConfig | null>(null);
  const [showWindMonitor, setShowWindMonitor] = useState(false);

  const intervalLabel = formatCounterInterval(data.counter_interval_seconds);
  const rainStatusLabel = formatCounterStatus(data.rain_delta_status);
  const rainRateSummary =
    formatPerTenMinuteValue(data.rain_mm_per_10min, 'mm', 1)
    ?? (data.rain_mm_per_hour != null && intervalLabel
      ? `${data.rain_mm_per_hour.toFixed(3)} mm/h over ${intervalLabel}`
      : null)
    ?? (intervalLabel ? `this ${intervalLabel.toLowerCase()}` : 'this interval');

  const handleRemove = async () => {
    setIsRemoving(true);
    setError(null);
    try {
      await devicesAPI.remove(device.deveui);
      onRemove?.();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Failed to remove device'));
      setIsRemoving(false);
    }
  };

  const zoneLabel = device.zone_names?.length
    ? device.zone_names.join(' · ')
    : 'No zones assigned';

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm transition-colors hover:border-[var(--focus)]">
      <div className="mb-0.5 flex items-center justify-between gap-2">
        <h3 className="truncate text-base font-semibold leading-tight text-[var(--text)]">
          {device.name}
        </h3>
        <div className="relative flex shrink-0 items-center gap-1.5">
          <span className="rounded-md bg-sky-100 px-2 py-0.5 text-xs font-semibold tracking-wide text-sky-800">
            S2120
          </span>
          <button
            onClick={() => setShowConfig((visible) => !visible)}
            className={`rounded-md p-1.5 transition-colors ${
              showConfig
                ? 'bg-[var(--primary)] text-white'
                : 'text-[var(--text-tertiary)] hover:bg-[var(--card)] hover:text-[var(--text)]'
            }`}
            title="Manage zone assignments"
          >
            ⚙
          </button>
          {showConfig && (
            <ZonePickerPanel
              device={device}
              allZones={allZones}
              onClose={() => setShowConfig(false)}
              onUpdate={onUpdate}
            />
          )}
          <button
            onClick={() => setShowConfirm(true)}
            disabled={isRemoving}
            className="rounded-md bg-[var(--error-bg)] p-1.5 text-[var(--error-text)] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
            title="Remove device"
          >
            ✕
          </button>
        </div>
      </div>

      <p className="mb-3 truncate text-xs font-mono text-[var(--text-tertiary)]">{device.deveui}</p>

      {error && (
        <div className="mb-3 rounded-lg bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error-text)]">
          {error}
        </div>
      )}

      {showConfirm && (
        <div className="mb-4 rounded-lg border-2 border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-3 text-[var(--warn-text)]">
          <p className="mb-2 font-bold">Remove weather station?</p>
          <p className="mb-3 text-sm">This will delete all stored readings and zone assignments.</p>
          <div className="flex gap-2">
            <button
              onClick={handleRemove}
              disabled={isRemoving}
              className="rounded-lg bg-[var(--error-bg)] px-4 py-2 font-bold text-[var(--error-text)] disabled:cursor-not-allowed"
            >
              {isRemoving ? 'Removing...' : 'Yes, remove'}
            </button>
            <button
              onClick={() => setShowConfirm(false)}
              disabled={isRemoving}
              className="rounded-lg bg-[var(--secondary-bg)] px-4 py-2 font-bold text-[var(--text)] hover:bg-[var(--border)]"
            >
              {tc('cancel')}
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Air Temperature</p>
          <button
            onClick={() => setSensorMonitor({ field: 'ambient_temperature', label: 'Air Temperature', unit: '°C', color: '#ea580c', decimals: 1 })}
            className="cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]"
            title="View history"
            style={{ color: '#ea580c' }}
          >
            {fmtNum(data.ambient_temperature, 1, '°C')}
          </button>
        </div>

        <div className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Humidity</p>
          <button
            onClick={() => setSensorMonitor({ field: 'relative_humidity', label: 'Humidity', unit: '%', color: '#0891b2', decimals: 0 })}
            className="cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]"
            title="View history"
            style={{ color: '#0891b2' }}
          >
            {fmtNum(data.relative_humidity, 0, '%')}
          </button>
        </div>

        <div className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Wind Speed</p>
          <button
            onClick={() => setShowWindMonitor(true)}
            className="cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]"
            title="View history"
            style={{ color: '#4f46e5' }}
          >
            {fmtNum(data.wind_speed_mps, 1, 'm/s')}
          </button>
          {data.wind_gust_mps != null && (
            <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">gust {data.wind_gust_mps.toFixed(1)} m/s</p>
          )}
        </div>

        <div className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Wind Direction</p>
          <button
            onClick={() => setShowWindMonitor(true)}
            className="cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]"
            title="View history"
            style={{ color: '#7c3aed' }}
          >
            {formatWindDirection(data.wind_direction_deg)}
          </button>
        </div>

        <div className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Rain Today</p>
          <button
            onClick={() => setSensorMonitor({
              field: 'rain_mm_delta',
              initialField: 'rain_mm_delta',
              label: 'Rainfall',
              unit: 'mm',
              color: '#2563eb',
              decimals: 1,
              seriesOptions: [
                { field: 'rain_mm_delta', label: 'This interval', unit: 'mm', color: '#2563eb', decimals: 1 },
                { field: 'rain_mm_per_10min', label: 'Per 10 min (rate)', unit: 'mm', color: '#1d4ed8', decimals: 1 },
              ],
            })}
            className="cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]"
            title="View history"
            style={{ color: '#2563eb' }}
          >
            {fmtNum(data.rain_mm_today, 1, 'mm')}
          </button>
          <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
            {rainRateSummary}
            {' · '}
            tap to view history
          </p>
          {rainStatusLabel && rainStatusLabel !== rainRateSummary && (
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">{rainStatusLabel}</p>
          )}
          {data.rain_mm_delta != null && data.rain_mm_delta > 0 && (
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">Last uplink: {data.rain_mm_delta.toFixed(1)} mm</p>
          )}
        </div>

        <div className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Pressure</p>
          <button
            onClick={() => setSensorMonitor({ field: 'barometric_pressure_hpa', label: 'Pressure', unit: 'hPa', color: '#475569', decimals: 0 })}
            className="cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]"
            title="View history"
            style={{ color: '#475569' }}
          >
            {fmtNum(data.barometric_pressure_hpa, 0, 'hPa')}
          </button>
        </div>

        <div className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Light Intensity</p>
          <button
            onClick={() => setSensorMonitor({ field: 'light_lux', label: 'Light Intensity', unit: 'lux', color: '#d97706', decimals: 0 })}
            className="cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]"
            title="View history"
            style={{ color: '#d97706' }}
          >
            {fmtLux(data.light_lux)}
          </button>
        </div>

        <div className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">UV Index</p>
          <button
            onClick={() => setSensorMonitor({ field: 'uv_index', label: 'UV Index', unit: 'UVI', color: '#ca8a04', decimals: 1 })}
            className="cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]"
            title="View history"
            style={{ color: '#ca8a04' }}
          >
            {fmtNum(data.uv_index, 1, 'UVI')}
          </button>
        </div>
      </div>

      <DeviceCardFooter
        lastSeenLabel={lastSeenLabel(device.last_seen)}
        batteryPercent={data.bat_pct}
        leftContent={(
          <p className="max-w-[60%] truncate">
            Zones: <span className="font-medium text-[var(--text)]">{zoneLabel}</span>
          </p>
        )}
      />

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
      {showWindMonitor && (
        <WindMonitor
          deveui={device.deveui}
          deviceName={device.name}
          onClose={() => setShowWindMonitor(false)}
        />
      )}
    </div>
  );
};
