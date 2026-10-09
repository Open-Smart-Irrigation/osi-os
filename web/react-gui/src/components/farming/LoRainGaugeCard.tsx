import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Device } from '../../types/farming';
import { devicesAPI } from '../../services/api';
import { SensorMonitor } from './SensorMonitor';
import { DeviceCardFooter } from './shared/DeviceCardFooter';
import { EditableName } from './shared/EditableName';
import { RainTodayTile } from './shared/RainTodayTile';
import { DeviceRemoveConfirm, deviceRemoveButtonLabel } from './DeviceRemoveConfirm';
import { useDeviceRemoval, type DeviceRemoveContext } from './useDeviceRemoval';

interface LoRainGaugeCardProps {
  device: Device;
  onRemove?: () => void;
  onUpdate?: () => void;
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

/**
 * Reception time of the last report in the farm's timezone (the gateway's `rain_day_timezone`),
 * with the zone named ("UTC" when the gateway gave none), so a UTC time is not read as farm time.
 */
function formatReportTime(lastSeen: string | null | undefined, timeZone: unknown, locale: string | undefined): string {
  const timestamp = lastSeen ? new Date(lastSeen).getTime() : NaN;
  if (!Number.isFinite(timestamp)) return '—';
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' };
  try {
    return new Date(timestamp).toLocaleString(locale, { ...options, timeZone: typeof timeZone === 'string' && timeZone ? timeZone : 'UTC' });
  } catch {
    return new Date(timestamp).toLocaleString(locale, { ...options, timeZone: 'UTC' });
  }
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
  onUpdate,
  readOnly = false,
  removeContext,
}) => {
  const { t, i18n } = useTranslation('devices');

  const handleRename = async (nextName: string) => {
    await devicesAPI.rename(device.deveui, nextName);
    onUpdate?.();
  };
  const data = device.latest_data ?? {};
  const removal = useDeviceRemoval({ deveui: device.deveui, removeContext, onRemove });
  const [sensorMonitor, setSensorMonitor] = useState<SensorMonitorConfig | null>(null);

  const statusLabel = formatCounterStatus(data.rain_delta_status);
  const intervalRainfall = t('loRain.intervalRainfall', { defaultValue: 'Rainfall this interval' });
  const tipsLine = data.rain_tips_delta != null
    ? t('loRain.tips', { count: data.rain_tips_delta, defaultValue: '{{count}} tips' })
    : t('loRain.tipsUnavailable', { defaultValue: 'Tip count unavailable' });

  // Rain is shown as amounts (owner decision D4): the interval amount and the farm-day
  // total. The elapsed-time rate and 10-minute value stay in the Data view and export.
  const openRainHistory = (initialField: 'rain_mm_delta' | 'rain_mm_today') => setSensorMonitor({
    field: 'rain_mm_delta',
    initialField,
    label: 'Rainfall',
    unit: 'mm',
    color: '#0ea5e9',
    decimals: 1,
    seriesOptions: [
      { field: 'rain_mm_delta', label: intervalRainfall, unit: 'mm', color: '#0ea5e9', decimals: 1 },
      { field: 'rain_mm_today', label: t('rain.recordedToday', { defaultValue: 'Rain recorded today' }), unit: 'mm', color: '#0284c7', decimals: 1 },
    ],
  });

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm transition-colors hover:border-[var(--focus)]">
      <div className="mb-0.5 flex items-center justify-between gap-2">
        <EditableName
          name={device.name}
          canEdit={!readOnly}
          onSave={handleRename}
          renameLabel={t('rename.device')}
          inputLabel={t('rename.deviceInputLabel')}
          headingClassName="truncate text-base font-semibold leading-tight text-[var(--text)]"
        />
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
            className={`touch-target rounded-md bg-[var(--error-bg)] p-1.5 text-[var(--error-text)] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_VISIBLE_RING}`}
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
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{intervalRainfall}</p>
          <button
            type="button"
            onClick={() => openRainHistory('rain_mm_delta')}
            className={`cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)] ${FOCUS_VISIBLE_RING}`}
            title={t('common.viewHistory', { defaultValue: 'View history' })}
          >
            {formatNumber(data.rain_mm_delta, 1, 'mm')}
          </button>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">{tipsLine}</p>
        </div>

        <RainTodayTile
          data={data}
          onOpenHistory={() => openRainHistory('rain_mm_today')}
          valueClassName={`cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)] ${FOCUS_VISIBLE_RING}`}
        />

        <div data-testid="lorain-last-report" className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            {t('loRain.lastReport', { defaultValue: 'Last report' })}
          </p>
          <p data-testid="lorain-last-report-time" className="text-xl font-bold tabular-nums text-[var(--text)]">
            {formatReportTime(device.last_seen, data.rain_day_timezone, i18n?.language)}
          </p>
          {statusLabel && <p className="mt-1 text-xs text-[var(--text-tertiary)]">{statusLabel}</p>}
        </div>

        <div className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Temperature</p>
          {Number.isFinite(Number(data.ambient_temperature)) && data.ambient_temperature != null ? (
            <button
              type="button"
              onClick={() => setSensorMonitor({ field: 'ambient_temperature', label: 'Temperature', unit: '°C', color: '#f97316', decimals: 1 })}
              className={`cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)] ${FOCUS_VISIBLE_RING}`}
              title={t('common.viewHistory', { defaultValue: 'View history' })}
            >
              {formatNumber(data.ambient_temperature, 1, '°C')}
            </button>
          ) : (
            <p className="text-2xl font-bold tabular-nums text-[var(--text)]">—</p>
          )}
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
