import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatWeatherValue } from '../../../utils/forecastFormat';
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

function fmtValue(value: number, unit: string, locale: string): string {
  const decimals = unit === 'lux' || unit === 'hPa' ? 0 : 1;
  return formatWeatherValue(value, locale, decimals, unit === 'UVI' ? '' : unit);
}

function fmtRelative(isoStr: string | null, locale: string): string {
  if (!isoStr || !Number.isFinite(Date.parse(isoStr))) return '—';
  const diffMin = Math.max(0, Math.round((Date.now() - new Date(isoStr).getTime()) / 60000));
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  return diffMin < 60 ? fmt.format(-diffMin, 'minute') : fmt.format(-Math.floor(diffMin / 60), 'hour');
}

// ── MetricCard ────────────────────────────────────────────────────────────────

const MetricCard: React.FC<{ metric: LocalMetric }> = ({ metric }) => {
  const { t, i18n } = useTranslation('devices');
  const icon  = METRIC_ICON[metric.key] ?? '📊';
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
      <div className="text-2xl font-bold tabular-nums" style={{ color: 'var(--text)' }}>
        {fmtValue(metric.mean, metric.unit, i18n.language)}
      </div>
      {metric.min !== metric.max && (
        <div className="text-xs text-[var(--text-tertiary)] tabular-nums">
          {formatWeatherValue(metric.min, i18n.language, 1)}–{formatWeatherValue(metric.max, i18n.language, 1, metric.unit === 'UVI' ? '' : metric.unit)}
        </div>
      )}
    </div>
  );
};

// ── Device breakdown ──────────────────────────────────────────────────────────

const DEVICE_TYPE_BADGE: Record<string, string> = Object.fromEntries([
  'KIWI_SENSOR', 'TEKTELIC_CLOVER', 'DRAGINO_LSN50', 'STREGA_VALVE',
  'SENSECAP_S2120', 'AQUASCOPE_LORAIN', 'MILESIGHT_UC512',
].map(type => [type, 'bg-[var(--info-bg)] text-[var(--info-text)]']));

const DeviceBreakdown: React.FC<{ local: LocalEnvironment }> = ({ local }) => {
  const { t, i18n } = useTranslation('devices');
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
            const badgeCls = DEVICE_TYPE_BADGE[dev.type] ?? 'bg-[var(--card)] text-[var(--text)]';
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
                  <span className="ml-auto text-[var(--text-tertiary)]">{fmtRelative(dev.observedAt, i18n.language)}</span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[var(--text-secondary)]">
                  {Object.entries(dev.metrics).map(([key, val]) => {
                    const label = t(`environment.metrics.${key}`, { defaultValue: key });
                    return (
                      <span key={key}>
                        {label}:{' '}
                        <span className="font-semibold tabular-nums" style={{ color: 'var(--text)' }}>
                          {typeof val === 'number' ? formatWeatherValue(val, i18n.language, 1) : val}
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
  const { t, i18n } = useTranslation('devices');

  if (!local.available || local.metrics.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-sm text-[var(--text-secondary)] text-center">
        {t('environment.local.noData', { defaultValue: 'No local sensor data available' })}
      </div>
    );
  }

  const freshCls  = local.freshSensorCount > 0  ? 'bg-[var(--success-bg)] text-[var(--success-text)]' : '';
  const staleCls  = local.staleSensorCount > 0   ? 'bg-[var(--warn-bg)] text-[var(--warn-text)]'   : '';

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
            {t('environment.local.observedAt', { time: fmtRelative(local.observedAt, i18n.language), defaultValue: `Observed ${fmtRelative(local.observedAt, i18n.language)}` })}
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
