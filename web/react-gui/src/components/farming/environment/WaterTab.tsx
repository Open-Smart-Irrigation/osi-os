import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useTranslation } from 'react-i18next';
import type { WaterEnvironment } from '../../../types/farming';

interface Props {
  water: WaterEnvironment;
}

function formatValue(value: number | null | undefined, unit: string, digits = 1): string {
  if (value == null || !Number.isFinite(value)) {
    return '—';
  }
  return `${value.toFixed(digits)} ${unit}`;
}

function formatAction(code: string | null | undefined): string {
  switch (code) {
    case 'delay_irrigation':
      return 'Delay irrigation';
    case 'irrigate_today':
      return 'Irrigate today';
    case 'monitor_today':
      return 'Monitor today';
    case 'maintain':
      return 'Maintain current irrigation';
    case 'maintain_rain_suppression':
      return 'Rain suppression active';
    case 'maintain_recovery_hold':
      return 'Recovery hold active';
    case 'increase_10':
      return 'Increase irrigation slightly';
    case 'increase_20':
      return 'Increase irrigation';
    case 'decrease_10':
      return 'Decrease irrigation slightly';
    case 'decrease_20':
      return 'Decrease irrigation';
    case 'emergency_irrigate':
      return 'Emergency irrigation';
    default:
      return 'Monitor water status';
  }
}

export const WaterTab: React.FC<Props> = ({ water }) => {
  const { t } = useTranslation('devices');
  const hasSetup = water.areaM2 != null && water.irrigationEfficiencyPct != null;
  const chartData = water.daily.map((day) => ({
    ...day,
    shortDate: new Date(day.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
  }));

  if (!water.available) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-center text-sm text-[var(--text-secondary)]">
        {t('environment.water.noData', { defaultValue: 'No water summary is available yet.' })}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {[
          {
            key: 'rain',
            label: t('environment.water.rainToday', { defaultValue: 'Rain today' }),
            value: formatValue(water.rainTodayMm, 'mm', 1),
            tone: 'text-sky-700',
          },
          {
            key: 'irrigation',
            label: t('environment.water.irrigationToday', { defaultValue: 'Irrigation today' }),
            value: formatValue(water.irrigationTodayLiters, 'L', 0),
            detail: hasSetup ? formatValue(water.irrigationTodayNetMm, 'mm', 1) : 'Needs area + efficiency',
            tone: 'text-teal-700',
          },
          {
            key: 'needed',
            label: t('environment.water.waterNeededToday', { defaultValue: 'Water needed today' }),
            value: hasSetup ? formatValue(water.waterNeededTodayMm, 'mm', 1) : 'Setup required',
            tone: 'text-amber-700',
          },
          {
            key: 'balance',
            label: t('environment.water.balance', { defaultValue: 'Balance' }),
            value: hasSetup ? formatValue(water.balanceTodayMm, 'mm', 1) : 'Setup required',
            detail: water.action ? formatAction(water.action.code) : null,
            tone: water.balanceTodayMm != null && water.balanceTodayMm >= 0 ? 'text-emerald-700' : 'text-orange-700',
          },
        ].map((item) => (
          <div key={item.key} className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{item.label}</p>
            <p className={`mt-2 text-2xl font-bold ${item.tone}`}>{item.value}</p>
            {item.detail && (
              <p className="mt-1 text-xs text-[var(--text-secondary)]">{item.detail}</p>
            )}
          </div>
        ))}
      </div>

      {!hasSetup && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {t('environment.water.setupRequired', {
            defaultValue: 'Add zone area and irrigation efficiency in zone settings to calculate effective irrigation and water balance.',
          })}
        </div>
      )}

      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
              {t('environment.water.weeklyTrend', { defaultValue: '7-day water trend' })}
            </p>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">
              {water.action?.reasoning ?? t('environment.water.trendNote', { defaultValue: 'Compare rainfall against effective irrigation over the last week.' })}
            </p>
          </div>
          <div className="text-xs text-[var(--text-tertiary)]">
            {t('environment.water.nextRain', { defaultValue: 'Next 24 h rain' })}: {formatValue(water.next24hRainMm, 'mm', 1)}
          </div>
        </div>
        <div className="mt-4 h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="shortDate"
                tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                axisLine={{ stroke: 'var(--border)' }}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                axisLine={false}
                tickLine={false}
                width={52}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const row = payload[0].payload as (typeof chartData)[number];
                  return (
                    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 text-sm shadow-xl">
                      <p className="mb-1 text-[var(--text-tertiary)]">{label}</p>
                      <p className="font-semibold text-sky-700">Rain: {formatValue(row.rainMm, 'mm', 1)}</p>
                      <p className="font-semibold text-teal-700">Irrigation: {formatValue(row.irrigationLiters, 'L', 0)}</p>
                      {row.irrigationNetMm != null && (
                        <p className="text-[var(--text-secondary)]">Effective irrigation: {formatValue(row.irrigationNetMm, 'mm', 1)}</p>
                      )}
                    </div>
                  );
                }}
              />
              <Bar dataKey="rainMm" name="Rain" fill="#38bdf8" radius={[6, 6, 0, 0]} />
              {hasSetup && <Bar dataKey="irrigationNetMm" name="Effective irrigation" fill="#14b8a6" radius={[6, 6, 0, 0]} />}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-xs text-[var(--text-secondary)]">
        {water.sensorHealth.rainGaugePresent && (
          <span className="rounded-full bg-sky-50 px-2.5 py-1 text-sky-800">Rain gauge reporting</span>
        )}
        {water.sensorHealth.flowMeterPresent && (
          <span className="rounded-full bg-teal-50 px-2.5 py-1 text-teal-800">Flow meter reporting</span>
        )}
        {water.sensorHealth.warnings.map((warning) => (
          <span key={warning} className="rounded-full bg-amber-50 px-2.5 py-1 text-amber-900">
            {warning}
          </span>
        ))}
      </div>
    </div>
  );
};
