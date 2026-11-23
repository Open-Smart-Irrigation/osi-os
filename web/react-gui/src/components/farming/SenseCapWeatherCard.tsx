import React, { useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useDismissOnPointerDown } from '../../hooks/useDismissOnPointerDown';
import { devicesAPI, getApiErrorMessage, s2120API } from '../../services/api';
import type { Device } from '../../types/farming';
import { formatWindDirection } from '../../utils/wind';
import { RainMonitor } from './RainMonitor';
import { SensorMonitor } from './SensorMonitor';
import { WindMonitor } from './WindMonitor';
import { DeviceCardFooter } from './shared/DeviceCardFooter';
import { EditableName } from './shared/EditableName';
import { RainTodayTile } from './shared/RainTodayTile';
import { DeviceRemoveConfirm, deviceRemoveButtonLabel } from './DeviceRemoveConfirm';
import { useDeviceRemoval, type DeviceRemoveContext } from './useDeviceRemoval';

interface Props {
  device: Device;
  onRemove?: () => void;
  onUpdate?: () => void;
  allZones?: Array<{ id: number; name: string }>;
  readOnly?: boolean;
  /** Required: 'zone' detaches from the zone only, 'farm' unlinks from the account. */
  removeContext: DeviceRemoveContext;
}

type SensorMonitorConfig = {
  field: string;
  labelKey: 'environment.metrics.air_temperature_c' | 'environment.metrics.relative_humidity_pct' | 'environment.metrics.pressure_hpa' | 'environment.metrics.light_lux' | 'environment.metrics.uv_index';
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

function formatCounterInterval(seconds: number | null | undefined, t: TFunction<'devices'>): string | null {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  const minutes = value / 60;
  if (minutes >= 1 && Math.abs(minutes - Math.round(minutes)) < 1e-9) {
    return t('weatherCard.minuteInterval', { value: Math.round(minutes), defaultValue: '{{value}} min interval' });
  }
  if (minutes >= 1) {
    return t('weatherCard.minuteInterval', { value: minutes.toFixed(minutes >= 10 ? 1 : 2), defaultValue: '{{value}} min interval' });
  }
  return t('weatherCard.secondInterval', { value: Math.round(value), defaultValue: '{{value}} s interval' });
}

function formatCounterStatus(status: string | null | undefined, t: TFunction<'devices'>): string | null {
  switch (status) {
    case 'first_sample':
      return t('weatherCard.counterStatus.first_sample', { defaultValue: 'Waiting for the next uplink to calculate a delta.' });
    case 'duplicate_timestamp':
      return t('weatherCard.counterStatus.duplicate_timestamp', { defaultValue: 'Skipped duplicate uplink timestamp.' });
    case 'out_of_order':
      return t('weatherCard.counterStatus.out_of_order', { defaultValue: 'Skipped out-of-order uplink.' });
    case 'counter_reset':
      return t('weatherCard.counterStatus.counter_reset', { defaultValue: 'Counter reset detected; interval delta skipped.' });
    case 'invalid_interval':
      return t('weatherCard.counterStatus.invalid_interval', { defaultValue: 'Invalid uplink interval; delta skipped.' });
    case 'cumulative_baseline':
      return t('weatherCard.counterStatus.cumulative_baseline', { defaultValue: 'Rain counter baseline set; waiting for the next uplink to calculate a delta.' });
    case 'intensity_only':
      return t('weatherCard.counterStatus.intensity_only', { defaultValue: 'Rain amount unknown for this interval; only the intensity was reported.' });
    default:
      return null;
  }
}

function formatPerTenMinuteValue(value: number | null | undefined, unit: string, t: TFunction<'devices'>, digits = 1): string | null {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }
  return t('weatherCard.perTenMinutes', { value: value.toFixed(digits), unit, defaultValue: '{{value}} {{unit}} per 10 min' });
}

const ZonePickerPanel: React.FC<{
  device: Device;
  allZones: Array<{ id: number; name: string }>;
  onClose: () => void;
  onUpdate?: () => void;
}> = ({ device, allZones, onClose, onUpdate }) => {
  const { t } = useTranslation('devices');
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
      setError(getApiErrorMessage(err, t('weatherCard.saveFailed', { defaultValue: 'Failed to save' })));
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
        {t('weatherCard.zoneAssignments', { defaultValue: 'Zone assignments' })}
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
          <p className="text-xs text-[var(--text-tertiary)]">{t('weatherCard.noZones', { defaultValue: 'No zones available' })}</p>
        )}
      </div>
      {error && <p className="mb-2 text-xs text-[var(--error-text)]">{error}</p>}
      <button
        onClick={save}
        disabled={busy}
        className="w-full rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm font-semibold text-[var(--on-primary)] disabled:opacity-60"
      >
        {busy ? t('weatherCard.saving', { defaultValue: 'Saving…' }) : t('weatherCard.save', { defaultValue: 'Save' })}
      </button>
    </div>
  );
};

export const SenseCapWeatherCard: React.FC<Props> = ({
  device,
  onRemove,
  onUpdate,
  allZones = [],
  readOnly = false,
  removeContext,
}) => {
  const { t } = useTranslation('devices');

  const handleRename = async (nextName: string) => {
    await devicesAPI.rename(device.deveui, nextName);
    onUpdate?.();
  };
  const data = device.latest_data ?? {};
  const [showConfig, setShowConfig] = useState(false);
  const removal = useDeviceRemoval({ deveui: device.deveui, removeContext, onRemove });
  const [sensorMonitor, setSensorMonitor] = useState<SensorMonitorConfig | null>(null);
  const [showWindMonitor, setShowWindMonitor] = useState(false);
  const [showRainMonitor, setShowRainMonitor] = useState(false);

  const intervalLabel = formatCounterInterval(data.counter_interval_seconds, t);
  const rainStatusLabel = formatCounterStatus(data.rain_delta_status, t);
  const rainRateSummary =
    formatPerTenMinuteValue(data.rain_mm_per_10min, 'mm', t, 1)
    ?? (data.rain_mm_per_hour != null && intervalLabel
      ? t('weatherCard.rateOverInterval', { value: data.rain_mm_per_hour.toFixed(3), interval: intervalLabel, defaultValue: '{{value}} mm/h over {{interval}}' })
      : null)
    ?? (intervalLabel ?? t('weatherCard.thisInterval', { defaultValue: 'This interval' }));

  const zoneLabel = device.zone_names?.length
    ? device.zone_names.join(' · ')
    : t('deviceCard.noZones');

  return (
    <div className="flex h-full flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm transition-colors hover:border-[var(--focus)]">
      <div className="mb-0.5 flex items-center justify-between gap-2">
        <EditableName
          name={device.name}
          canEdit={!readOnly}
          onSave={handleRename}
          renameLabel={t('rename.device')}
          inputLabel={t('rename.deviceInputLabel')}
          headingClassName="truncate text-base font-semibold leading-tight text-[var(--text)]"
        />
        <div className="relative flex shrink-0 items-center gap-1.5">
          <span className="rounded-md bg-[var(--info-bg)] px-2 py-0.5 text-xs font-semibold tracking-wide text-[var(--info-text)]">
            S2120
          </span>
          {!readOnly && <button
            onClick={() => setShowConfig((visible) => !visible)}
            className={`touch-target rounded-md p-1.5 transition-colors ${
              showConfig
                ? 'bg-[var(--primary)] text-[var(--on-primary)]'
                : 'text-[var(--text-tertiary)] hover:bg-[var(--card)] hover:text-[var(--text)]'
            }`}
            title={t('weatherCard.manageZones', { defaultValue: 'Manage zone assignments' })}
            aria-label={t('weatherCard.manageZones', { defaultValue: 'Manage zone assignments' })}
          >
            ⚙
          </button>}
          {!readOnly && showConfig && (
            <ZonePickerPanel
              device={device}
              allZones={allZones}
              onClose={() => setShowConfig(false)}
              onUpdate={onUpdate}
            />
          )}
          {!readOnly && <button
            onClick={removal.openConfirm}
            disabled={removal.isRemoving}
            className="touch-target rounded-md bg-[var(--error-bg)] p-1.5 text-[var(--error-text)] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={deviceRemoveButtonLabel(removeContext, removal.isRemoving, t)}
            title={deviceRemoveButtonLabel(removeContext, removal.isRemoving, t)}
          >
            ✕
          </button>}
        </div>
      </div>

      <p className="mb-3 truncate text-xs font-mono text-[var(--text-tertiary)]">{device.deveui}</p>

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
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('environment.metrics.air_temperature_c', { defaultValue: 'Air Temp' })}</p>
          <button
            onClick={() => setSensorMonitor({ field: 'ambient_temperature', labelKey: 'environment.metrics.air_temperature_c', unit: '°C', color: '#ea580c', decimals: 1 })}
            className="cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]"
            title={t('common.viewHistory', { defaultValue: 'View history' })}
            style={{ color: 'var(--text)' }}
          >
            {fmtNum(data.ambient_temperature, 1, '°C')}
          </button>
        </div>

        <div className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('environment.metrics.relative_humidity_pct', { defaultValue: 'Humidity' })}</p>
          <button
            onClick={() => setSensorMonitor({ field: 'relative_humidity', labelKey: 'environment.metrics.relative_humidity_pct', unit: '%', color: '#0891b2', decimals: 0 })}
            className="cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]"
            title={t('common.viewHistory', { defaultValue: 'View history' })}
            style={{ color: 'var(--text)' }}
          >
            {fmtNum(data.relative_humidity, 0, '%')}
          </button>
        </div>

        <div className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('environment.metrics.wind_speed_mps', { defaultValue: 'Wind' })}</p>
          <button
            onClick={() => setShowWindMonitor(true)}
            className="cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]"
            title={t('common.viewHistory', { defaultValue: 'View history' })}
            style={{ color: 'var(--text)' }}
          >
            {fmtNum(data.wind_speed_mps, 1, 'm/s')}
          </button>
          {data.wind_gust_mps != null && (
            <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">{t('weatherCard.gust', { value: data.wind_gust_mps.toFixed(1), defaultValue: 'Gust {{value}} m/s' })}</p>
          )}
        </div>

        <div className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('environment.metrics.wind_direction_deg', { defaultValue: 'Wind Dir' })}</p>
          <button
            onClick={() => setShowWindMonitor(true)}
            className="cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]"
            title={t('common.viewHistory', { defaultValue: 'View history' })}
            style={{ color: 'var(--text)' }}
          >
            {formatWindDirection(data.wind_direction_deg)}
          </button>
        </div>

        <RainTodayTile data={data} onOpenHistory={() => setShowRainMonitor(true)} valueStyle={{ color: 'var(--text)' }}>
          {/* The button already carries a "View history" title; the hint
              said "tap" on a 1366 px desktop screen. */}
          <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
            {rainRateSummary}
          </p>
          {rainStatusLabel && rainStatusLabel !== rainRateSummary && (
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">{rainStatusLabel}</p>
          )}
          {data.rain_mm_delta != null && data.rain_mm_delta > 0 && (
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">{t('weatherCard.lastUplink', { value: data.rain_mm_delta.toFixed(1), defaultValue: 'Last uplink: {{value}} mm' })}</p>
          )}
        </RainTodayTile>

        <div className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('environment.metrics.pressure_hpa', { defaultValue: 'Pressure' })}</p>
          <button
            onClick={() => setSensorMonitor({ field: 'barometric_pressure_hpa', labelKey: 'environment.metrics.pressure_hpa', unit: 'hPa', color: '#475569', decimals: 0 })}
            className="cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]"
            title={t('common.viewHistory', { defaultValue: 'View history' })}
            style={{ color: 'var(--text)' }}
          >
            {fmtNum(data.barometric_pressure_hpa, 0, 'hPa')}
          </button>
        </div>

        <div className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('environment.metrics.light_lux', { defaultValue: 'Light' })}</p>
          <button
            onClick={() => setSensorMonitor({ field: 'light_lux', labelKey: 'environment.metrics.light_lux', unit: 'lux', color: '#d97706', decimals: 0 })}
            className="cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]"
            title={t('common.viewHistory', { defaultValue: 'View history' })}
            style={{ color: 'var(--text)' }}
          >
            {fmtLux(data.light_lux)}
          </button>
        </div>

        <div className="rounded-lg bg-[var(--card)] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('environment.metrics.uv_index', { defaultValue: 'UV Index' })}</p>
          <button
            onClick={() => setSensorMonitor({ field: 'uv_index', labelKey: 'environment.metrics.uv_index', unit: 'UVI', color: '#ca8a04', decimals: 1 })}
            className="cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]"
            title={t('common.viewHistory', { defaultValue: 'View history' })}
            style={{ color: 'var(--text)' }}
          >
            {fmtNum(data.uv_index, 1, 'UVI')}
          </button>
        </div>
      </div>

      <p className="mt-3 truncate text-xs text-[var(--text-tertiary)]">
        {t('deviceCard.zones')} <span className="font-medium text-[var(--text)]">{zoneLabel}</span>
      </p>

      <DeviceCardFooter lastSeen={device.last_seen} batteryPercent={data.bat_pct} rawBatteryVoltage={data.bat_v} />

      {sensorMonitor && (
        <SensorMonitor
          deveui={device.deveui}
          deviceName={device.name}
          field={sensorMonitor.field}
          label={t(sensorMonitor.labelKey)}
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
      {showRainMonitor && (
        <RainMonitor
          deveui={device.deveui}
          deviceName={device.name}
          onClose={() => setShowRainMonitor(false)}
        />
      )}
    </div>
  );
};
