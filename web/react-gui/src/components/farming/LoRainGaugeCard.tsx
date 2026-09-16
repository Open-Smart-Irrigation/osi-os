import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Device } from '../../types/farming';
import { SensorMonitor } from './SensorMonitor';
import { DeviceCardFooter } from './shared/DeviceCardFooter';
import { DeviceRemoveConfirm, deviceRemoveButtonLabel } from './DeviceRemoveConfirm';
import { useDeviceRemoval, type DeviceRemoveContext } from './useDeviceRemoval';

interface LoRainGaugeCardProps {
  device: Device;
  onRemove?: () => void;
  readOnly?: boolean;
  /** Required: 'zone' detaches from the zone only, 'farm' unlinks from the account. */
  removeContext: DeviceRemoveContext;
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
  removeContext,
}) => {
  const { t } = useTranslation('devices');
  const data = device.latest_data ?? {};
  const removal = useDeviceRemoval({ deveui: device.deveui, removeContext, onRemove });
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
            onClick={removal.openConfirm}
            disabled={removal.isRemoving}
            aria-label={deviceRemoveButtonLabel(removeContext, removal.isRemoving, t)}
            title={deviceRemoveButtonLabel(removeContext, removal.isRemoving, t)}
            className={`rounded-md bg-[var(--error-bg)] p-1.5 text-[var(--error-text)] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_VISIBLE_RING}`}
          >
            ✕
          </button>}
        </div>
      </div>

      <p className="mb-3 truncate font-mono text-xs text-[var(--text-tertiary)]">{device.deveui}</p>

      {removal.error && (
        <div className="mb-3 rounded-lg bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error-text)]">
          {removal.error}
        </div>
      )}

      {!readOnly && removal.showConfirm && (
        <DeviceRemoveConfirm
          removeContext={removeContext}
          isRemoving={removal.isRemoving}
          onConfirm={() => void removal.confirmRemove()}
          onCancel={removal.cancelConfirm}
        />
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">This interval</p>
          <button
            type="button"
            onClick={openRainHistory}
            className={`cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)] ${FOCUS_VISIBLE_RING}`}
            title={t('common.viewHistory', { defaultValue: 'View history' })}
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
            title={t('common.viewHistory', { defaultValue: 'View history' })}
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
            title={t('common.viewHistory', { defaultValue: 'View history' })}
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
