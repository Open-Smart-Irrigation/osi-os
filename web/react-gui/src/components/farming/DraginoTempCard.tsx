import React, { useState } from 'react';
import type { Device } from '../../types/farming';
import { devicesAPI } from '../../services/api';
import { DendrometerMonitor } from './DendrometerMonitor';
import { DraginoSettingsModal } from './DraginoSettingsModal';
import { SensorMonitor } from './SensorMonitor';
import { DeviceCardFooter } from './shared/DeviceCardFooter';

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

function formatStemChangeUm(value: number | null | undefined): string | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.round(numeric);
  return `${rounded > 0 ? '+' : ''}${rounded} µm`;
}

function formatDepthLabel(value: number | null | undefined): string | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return `${Number.isInteger(numeric) ? numeric.toFixed(0) : numeric.toFixed(1)} cm`;
}

function formatKpa(value: number | null | undefined): string {
  if (value == null) return '—';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${numeric.toFixed(1)} kPa` : '—';
}

function formatDendroRangeState(saturationSide: string | null | undefined): string {
  if (saturationSide === 'low') return 'Below retracted';
  if (saturationSide === 'high') return 'Above extended';
  return 'In range';
}

const FOCUS_VISIBLE_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]';

interface DraginoTempCardProps {
  device: Device;
  onRemove?: () => void;
  onUpdate?: () => void;
}

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
  const dendroBaselinePending = dendroEnabled && device.dendro_baseline_pending === 1;
  const dendroSaturated = dendroEnabled && data?.dendro_saturated === 1;
  const dendroHasPosition = dendroEnabled && data?.dendro_valid === 1 && data?.dendro_position_raw_mm != null;
  const dendroHasStemChange = dendroEnabled
    && !dendroBaselinePending
    && !dendroSaturated
    && data?.dendro_valid === 1
    && data?.dendro_stem_change_um != null;
  const dendroNeedsCalibration = dendroEnabled
    && data?.dendro_mode_used === 'ratio_mod3'
    && data?.dendro_valid !== 0
    && data?.dendro_position_raw_mm == null
    && data?.dendro_ratio != null;
  const dendroSensorError = dendroEnabled && data?.dendro_valid === 0;
  const dendroAwaitingBaseline = dendroEnabled
    && !dendroNeedsCalibration
    && !dendroSensorError
    && !dendroSaturated
    && (dendroBaselinePending || (dendroHasPosition && data?.dendro_stem_change_um == null));
  const dendroStemChangeLabel = formatStemChangeUm(data?.dendro_stem_change_um);
  const dendroCardVisible = dendroEnabled
    && (dendroHasStemChange || dendroAwaitingBaseline || dendroNeedsCalibration || dendroSensorError || dendroSaturated);
  const chameleonEnabled = device.chameleon_enabled === 1;
  const chameleonDataInvalid = data?.chameleon_i2c_missing === 1 || data?.chameleon_timeout === 1;
  const chameleonChannels = [
    { field: 'swt_1', label: 'SWT1', value: data?.swt_1, depth: device.chameleon_swt1_depth_cm, color: '#0f766e' },
    { field: 'swt_2', label: 'SWT2', value: data?.swt_2, depth: device.chameleon_swt2_depth_cm, color: '#2563eb' },
    { field: 'swt_3', label: 'SWT3', value: data?.swt_3, depth: device.chameleon_swt3_depth_cm, color: '#7c3aed' },
  ] as const;

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
            type="button"
            onClick={() => setShowConfig((value) => !value)}
            aria-label={showConfig ? 'Close device settings' : 'Device settings'}
            title={showConfig ? 'Close device settings' : 'Device settings'}
            className={`p-1.5 rounded-md transition-colors ${
              showConfig
                ? 'bg-[var(--primary)] text-white'
                : 'text-[var(--text-tertiary)] hover:bg-[var(--card)] hover:text-[var(--text)]'
            } ${FOCUS_VISIBLE_RING}`}
          >
            ⚙
          </button>
          {showConfig && <DraginoSettingsModal device={device} dendroNeedsCalibration={dendroNeedsCalibration} onUpdate={() => { onUpdate?.(); }} onClose={() => setShowConfig(false)} />}
          <button
            type="button"
            onClick={() => setShowConfirm(true)}
            disabled={isRemoving}
            aria-label={isRemoving ? 'Removing device' : 'Remove device'}
            title={isRemoving ? 'Removing device' : 'Remove device'}
            className={`p-1.5 rounded-md bg-[var(--error-bg)] text-[var(--error-text)] hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed ${FOCUS_VISIBLE_RING}`}
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
              type="button"
              onClick={() => void handleRemove()}
              disabled={isRemoving}
              className={`flex items-center gap-2 rounded-lg bg-[var(--error-bg)] px-4 py-2 font-bold text-[var(--error-text)] transition-colors disabled:cursor-not-allowed disabled:bg-[var(--border)] disabled:text-[var(--text-disabled)] ${FOCUS_VISIBLE_RING}`}
            >
              {isRemoving ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Removing…
                </>
              ) : 'Yes, Remove'}
            </button>
            <button
              type="button"
              onClick={() => setShowConfirm(false)}
              disabled={isRemoving}
              className={`rounded-lg bg-[var(--secondary-bg)] px-4 py-2 font-bold text-[var(--text)] transition-colors disabled:cursor-not-allowed disabled:bg-[var(--border)] disabled:text-[var(--text-disabled)] ${FOCUS_VISIBLE_RING}`}
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
                className={`cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)] ${FOCUS_VISIBLE_RING}`}
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
              className={`cursor-pointer text-left text-2xl font-bold tabular-nums underline decoration-dotted underline-offset-4 transition-opacity hover:opacity-75 ${FOCUS_VISIBLE_RING}`}
              style={{ color: batColour }}
              title="View history"
            >
              {data.bat_v.toFixed(2)} V
            </button>
          </div>
        )}

        {chameleonEnabled && (
          <div className="rounded-lg bg-[var(--card)] p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Chameleon SWT</p>
            {chameleonDataInvalid ? (
              <p className="text-base font-bold text-[var(--warn-text)]">No valid Chameleon sample</p>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {chameleonChannels.map((channel) => (
                  <button
                    key={channel.field}
                    type="button"
                    onClick={() => setSensorMonitor({
                      field: channel.field,
                      initialField: channel.field,
                      label: channel.label,
                      unit: 'kPa',
                      color: channel.color,
                      decimals: 1,
                      seriesOptions: chameleonChannels.map((option) => ({
                        field: option.field,
                        label: option.label,
                        unit: 'kPa',
                        color: option.color,
                        decimals: 1,
                      })),
                    })}
                    className={`flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left transition-colors hover:border-[var(--focus)] ${FOCUS_VISIBLE_RING}`}
                    title="View SWT history"
                  >
                    <span>
                      <span className="block text-sm font-semibold text-[var(--text)]">{channel.label}</span>
                      <span className="block text-xs text-[var(--text-tertiary)]">{formatDepthLabel(channel.depth) || 'Depth unset'}</span>
                    </span>
                    <span className="text-lg font-bold tabular-nums text-[var(--text)]">{formatKpa(channel.value)}</span>
                  </button>
                ))}
              </div>
            )}
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
              className={`cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)] ${FOCUS_VISIBLE_RING}`}
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
              className={`cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)] ${FOCUS_VISIBLE_RING}`}
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
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Stem change</p>
            {dendroHasStemChange && dendroStemChangeLabel ? (
              <button
                onClick={() => setShowMonitor(true)}
                className={`cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)] ${FOCUS_VISIBLE_RING}`}
                title="View stem change history"
              >
                {dendroStemChangeLabel}
              </button>
            ) : dendroAwaitingBaseline ? (
              <button
                onClick={() => setShowMonitor(true)}
                className={`cursor-pointer text-left text-base font-bold text-[var(--warn-text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)] ${FOCUS_VISIBLE_RING}`}
                title="View mechanical history while the new baseline is being established"
              >
                Awaiting baseline
              </button>
            ) : dendroSaturated ? (
              <button
                onClick={() => setShowMonitor(true)}
                className={`cursor-pointer text-left text-base font-bold text-[var(--warn-text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)] ${FOCUS_VISIBLE_RING}`}
                title="View mechanical history and calibration range details"
              >
                Out of range
              </button>
            ) : dendroNeedsCalibration ? (
              <p className="text-base font-bold text-[var(--warn-text)]">Calibration required</p>
            ) : dendroSensorError ? (
              <p className="text-base font-bold text-[var(--error-text)]">SENSOR ERROR</p>
            ) : (
              <p className="text-2xl font-bold tabular-nums text-[var(--text)]">—</p>
            )}
            {dendroHasStemChange && (
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">Tap to monitor stem change over time</p>
            )}
            {dendroAwaitingBaseline && (
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                The next valid calibrated uplink will establish the new zero point for stem change.
              </p>
            )}
            {dendroSaturated && (
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                The current raw position is {data?.dendro_saturation_side === 'high' ? 'above the extended' : 'below the retracted'} calibration endpoint. Review the dendrometer calibration range.
              </p>
            )}
            {dendroNeedsCalibration && (
              <>
                <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                  Ratio mode is active, but this device still needs ratio calibration values.
                </p>
                <button
                  type="button"
                  onClick={() => setShowConfig(true)}
                  className={`mt-3 rounded-lg border border-[var(--warn-border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--warn-text)] transition-colors hover:bg-[var(--warn-bg)] ${FOCUS_VISIBLE_RING}`}
                >
                  Open calibration
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <DeviceCardFooter
        lastSeenLabel={minutesAgo !== null ? `Last seen: ${minutesAgo} minutes ago` : 'Never seen'}
        batteryPercent={device.latest_data?.bat_pct}
      />

      {showMonitor && (
        <DendrometerMonitor
          deveui={device.deveui}
          deviceName={device.name}
          strokeMm={device.dendro_stroke_mm ?? null}
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
