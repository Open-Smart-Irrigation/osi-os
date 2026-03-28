import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalEnvironment, LocalMetric } from '../../../types/farming';

interface Props {
  local: LocalEnvironment;
}

// ── Metric display config ─────────────────────────────────────────────────────

const METRIC_ICON: Record<string, string> = {
  air_temperature_c:    '🌡',
  relative_humidity_pct:'💧',
  probe_temperature_c:  '🌡',
  pressure_hpa:         '◉',
  wind_speed_mps:       '🌬',
  wind_direction_deg:   '🧭',
  rainfall_mm:          '🌧',
  light_lux:            '☀',
  uv_index:             '🔆',
  soil_temperature_c:   '🌱',
  soil_moisture_pct:    '🌿',
};

const METRIC_COLOR: Record<string, string> = {
  air_temperature_c:    '#f97316',
  relative_humidity_pct:'#06b6d4',
  probe_temperature_c:  '#fb923c',
  pressure_hpa:         '#64748b',
  wind_speed_mps:       '#6366f1',
  wind_direction_deg:   '#8b5cf6',
  rainfall_mm:          '#3b82f6',
  light_lux:            '#f59e0b',
  uv_index:             '#eab308',
  soil_temperature_c:   '#22c55e',
  soil_moisture_pct:    '#16a34a',
};

function fmtValue(value: number, unit: string): string {
  const decimals = unit === 'lux' || unit === 'hPa' ? 0 : 1;
  return `${value.toFixed(decimals)} ${unit}`;
}

function fmtRelative(isoStr: string | null): string {
  if (!isoStr) return '—';
  const diffMin = Math.round((Date.now() - new Date(isoStr).getTime()) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  return `${Math.floor(diffMin / 60)}h ago`;
}

// ── MetricCard ────────────────────────────────────────────────────────────────

const MetricCard: React.FC<{ metric: LocalMetric }> = ({ metric }) => {
  const { t } = useTranslation('devices');
  const icon  = METRIC_ICON[metric.key] ?? '📊';
  const color = METRIC_COLOR[metric.key] ?? '#64748b';
  const label = t(`environment.metrics.${metric.key}`, { defaultValue: metric.label });

  return (
    <div className="bg-[var(--card)] rounded-xl p-3 flex flex-col gap-1 border border-[var(--border)]">
      <div className="flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
        <span>{icon}</span>
        <span className="font-medium uppercase tracking-wide">{label}</span>
        {metric.sampleCount > 1 && (
          <span className="ml-auto text-[var(--text-tertiary)]">×{metric.sampleCount}</span>
        )}
      </div>
      <div className="text-2xl font-bold tabular-nums" style={{ color }}>
        {fmtValue(metric.mean, metric.unit)}
      </div>
      {metric.min !== metric.max && (
        <div className="text-xs text-[var(--text-tertiary)] tabular-nums">
          {metric.min.toFixed(1)}–{metric.max.toFixed(1)} {metric.unit}
        </div>
      )}
    </div>
  );
};

// ── Device breakdown ──────────────────────────────────────────────────────────

const DEVICE_TYPE_BADGE: Record<string, string> = {
  KIWI_SENSOR:  'bg-emerald-100 text-emerald-800',
  DRAGINO_LSN50:'bg-sky-100 text-sky-800',
  STREGA_VALVE: 'bg-purple-100 text-purple-800',
};

const DeviceBreakdown: React.FC<{ local: LocalEnvironment }> = ({ local }) => {
  const { t } = useTranslation('devices');
  const [open, setOpen] = useState(false);

  if (local.devices.length === 0) return null;

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text)] transition-colors"
      >
        <span
          className="text-[var(--text-tertiary)] transition-transform duration-150"
          style={{ display: 'inline-block', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
        >
          ▾
        </span>
        {t('environment.local.perDevice', { defaultValue: 'Per-device readings' })}
      </button>

      {open && (
        <div className="mt-2 rounded-xl border border-[var(--border)] overflow-hidden">
          {local.devices.map((dev, i) => {
            const badgeCls = DEVICE_TYPE_BADGE[dev.type] ?? 'bg-slate-100 text-slate-700';
            return (
              <div
                key={dev.deviceEui}
                className={`px-3 py-2 flex flex-col gap-1 text-xs ${i > 0 ? 'border-t border-[var(--border)]' : ''}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[var(--text)] truncate max-w-[140px]">{dev.name}</span>
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${badgeCls}`}>
                    {dev.type.replace('_', ' ')}
                  </span>
                  <span className="ml-auto text-[var(--text-tertiary)]">{fmtRelative(dev.observedAt)}</span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[var(--text-secondary)]">
                  {Object.entries(dev.metrics).map(([key, val]) => {
                    const color = METRIC_COLOR[key] ?? '#64748b';
                    const label = t(`environment.metrics.${key}`, { defaultValue: key });
                    return (
                      <span key={key}>
                        {label}:{' '}
                        <span className="font-semibold tabular-nums" style={{ color }}>
                          {typeof val === 'number' ? val.toFixed(1) : val}
                        </span>
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ── Main ──────────────────────────────────────────────────────────────────────

export const LocalTab: React.FC<Props> = ({ local }) => {
  const { t } = useTranslation('devices');

  if (!local.available || local.metrics.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-sm text-[var(--text-secondary)] text-center">
        {t('environment.local.noData', { defaultValue: 'No local sensor data available' })}
      </div>
    );
  }

  const freshCls  = local.freshSensorCount > 0  ? 'bg-emerald-100 text-emerald-800' : '';
  const staleCls  = local.staleSensorCount > 0   ? 'bg-amber-100 text-amber-800'   : '';

  return (
    <div className="flex flex-col gap-3">
      {/* Freshness header */}
      <div className="flex items-center gap-2 text-xs flex-wrap">
        {local.freshSensorCount > 0 && (
          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-semibold ${freshCls}`}>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            {t('environment.local.freshSensors', { count: local.freshSensorCount, defaultValue: `${local.freshSensorCount} fresh` })}
          </span>
        )}
        {local.staleSensorCount > 0 && (
          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-semibold ${staleCls}`}>
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            {t('environment.local.staleSensors_other', { count: local.staleSensorCount, defaultValue: `${local.staleSensorCount} stale` })}
          </span>
        )}
        {local.observedAt && (
          <span className="text-[var(--text-tertiary)] ml-auto">
            {t('environment.local.observedAt', { time: fmtRelative(local.observedAt), defaultValue: `Observed ${fmtRelative(local.observedAt)}` })}
          </span>
        )}
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-2 gap-2">
        {local.metrics.map(m => <MetricCard key={m.key} metric={m} />)}
      </div>

      {/* Per-device breakdown */}
      <DeviceBreakdown local={local} />
    </div>
  );
};
