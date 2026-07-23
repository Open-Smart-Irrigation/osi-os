import React, { useState } from 'react';

import { devicesAPI, getApiErrorMessage } from '../../services/api';
import type { Device } from '../../types/farming';
import { SensorMonitor } from './SensorMonitor';
import { DeviceCardFooter } from './shared/DeviceCardFooter';

interface LoRainGaugeCardProps {
  device: Device;
  onRemove?: () => void;
  readOnly?: boolean;
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

const FOCUS_VISIBLE_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]';

function formatNumber(value: number | null | undefined, decimals: number, unit: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return `${numeric.toFixed(decimals)} ${unit}`;
}

function lastSeenLabel(lastSeen: string | null | undefined): string {
  if (!lastSeen) return 'Never seen';
  const timestamp = new Date(lastSeen).getTime();
  if (!Number.isFinite(timestamp)) return 'Never seen';
  const diff = Math.floor((Date.now() - timestamp) / 60000);
  if (diff < 1) return 'Last seen: just now';
  if (diff < 60) return `Last seen: ${diff} minutes ago`;
  return `Last seen: ${Math.floor(diff / 60)} hours ago`;
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
    case 'duplicate_or_out_of_order':
      return 'Skipped duplicate or out-of-order uplink.';
    case 'error':
      return 'Rain delta could not be calculated for this uplink.';
    case 'no_rain_sensor':
      return 'No rain value in the last uplink.';
    default:
      return null;
  }
}

export const LoRainGaugeCard: React.FC<LoRainGaugeCardProps> = ({
  device,
  onRemove,
  readOnly = false,
}) => {
  const data = device.latest_data ?? {};
  const [showConfirm, setShowConfirm] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sensorMonitor, setSensorMonitor] = useState<SensorMonitorConfig | null>(null);

  const intervalLabel = formatCounterInterval(data.counter_interval_seconds);
  const statusLabel = formatCounterStatus(data.rain_delta_status);
  const rateLabel = data.rain_mm_per_10min != null
    ? `${data.rain_mm_per_10min.toFixed(1)} mm / 10 min`
    : (data.rain_mm_per_hour != null && intervalLabel ? `${data.rain_mm_per_hour.toFixed(3)} mm/h over ${intervalLabel}` : '—');

  const openRainHistory = () => setSensorMonitor({
    field: 'rain_mm_delta',
    initialField: 'rain_mm_delta',
    label: 'Rainfall',
    unit: 'mm',
    color: '#0ea5e9',
    decimals: 1,
    seriesOptions: [
      { field: 'rain_mm_delta', label: 'This interval', unit: 'mm', color: '#0ea5e9', decimals: 1 },
      { field: 'rain_mm_per_10min', label: 'Per 10 min', unit: 'mm', color: '#0369a1', decimals: 1 },
      { field: 'rain_mm_today', label: 'Today', unit: 'mm', color: '#0284c7', decimals: 1 },
    ],
  });

  const handleRemove = async () => {
    setIsRemoving(true);
    setError(null);
    try {
      await devicesAPI.remove(device.deveui);
      onRemove?.();
      setShowConfirm(false);
      setIsRemoving(false);
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Failed to remove device'));
      setIsRemoving(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm transition-colors hover:border-[var(--focus)]">
      <div className="mb-0.5 flex items-center justify-between gap-2">
        <h3 className="truncate text-base font-semibold leading-tight text-[var(--text)]">{device.name}</h3>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="rounded-md bg-cyan-100 px-2 py-0.5 text-xs font-semibold tracking-wide text-cyan-800">
            LoRain
          </span>
          {!readOnly && <button
            type="button"
            onClick={() => setShowConfirm(true)}
            disabled={isRemoving}
            aria-label={isRemoving ? 'Removing device' : 'Remove device'}
            title="Remove device"
            className={`rounded-md bg-[var(--error-bg)] p-1.5 text-[var(--error-text)] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_VISIBLE_RING}`}
          >
            x
          </button>}
        </div>
      </div>

      <p className="mb-3 truncate font-mono text-xs text-[var(--text-tertiary)]">{device.deveui}</p>

      {error && (
        <div className="mb-3 rounded-lg bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error-text)]">
          {error}
        </div>
      )}

      {!readOnly && showConfirm && (
        <div className="mb-4 rounded-lg border-2 border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-3 text-[var(--warn-text)]">
          <p className="mb-2 font-bold">Remove rain gauge?</p>
          <p className="mb-3 text-sm">This will delete the local device record and stored readings.</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void handleRemove()}
              disabled={isRemoving}
              className={`rounded-lg bg-[var(--error-bg)] px-4 py-2 font-bold text-[var(--error-text)] disabled:cursor-not-allowed ${FOCUS_VISIBLE_RING}`}
            >
              {isRemoving ? 'Removing...' : 'Yes, remove'}
            </button>
            <button
              type="button"
              onClick={() => setShowConfirm(false)}
              disabled={isRemoving}
              className={`rounded-lg bg-[var(--secondary-bg)] px-4 py-2 font-bold text-[var(--text)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed ${FOCUS_VISIBLE_RING}`}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">This interval</p>
          <button
            type="button"
            onClick={openRainHistory}
            className={`cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)] ${FOCUS_VISIBLE_RING}`}
            title="View history"
          >
            {formatNumber(data.rain_mm_delta, 1, 'mm')}
          </button>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">
            {data.rain_tips_delta != null ? `${data.rain_tips_delta} tips` : 'Tip count unavailable'}
          </p>
        </div>

        <div className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Today</p>
          <button
            type="button"
            onClick={openRainHistory}
            className={`cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)] ${FOCUS_VISIBLE_RING}`}
            title="View history"
          >
            {formatNumber(data.rain_mm_today, 1, 'mm')}
          </button>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">{statusLabel ?? 'Accumulated locally'}</p>
        </div>

        <div className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Rate</p>
          <button
            type="button"
            onClick={openRainHistory}
            className={`cursor-pointer text-left text-xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)] ${FOCUS_VISIBLE_RING}`}
            title="View history"
          >
            {rateLabel}
          </button>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">{intervalLabel ?? 'Waiting for interval'}</p>
        </div>

        <div className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Temperature</p>
          <p className="text-2xl font-bold tabular-nums text-[var(--text)]">
            {formatNumber(data.ambient_temperature, 1, '°C')}
          </p>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">
            Battery {formatNumber(data.bat_v, 1, 'V')}
          </p>
        </div>
      </div>

      <DeviceCardFooter
        lastSeenLabel={lastSeenLabel(device.last_seen)}
        batteryVoltage={data.bat_v}
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
    </div>
  );
};
