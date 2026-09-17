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
import { parseCalendarDay, useDateFormat } from '../../../utils/datetime';
import { zoneHasFlowMeter, zoneHasRainGauge, zoneHasValve } from '../../../utils/zoneSoil';
import type { Device, WaterEnvironment } from '../../../types/farming';

interface Props {
  water: WaterEnvironment;
  /** The zone's devices, so each tile can be gated on a source that exists. */
  devices?: Device[];
}

function formatValue(value: number | null | undefined, unit: string, digits = 1): string {
  if (value == null || !Number.isFinite(value)) {
    return '—';
  }
  return `${value.toFixed(digits)} ${unit}`;
}

interface WaterTile {
  key: string;
  label: string;
  value: string;
  detail?: string | null;
  tone: string;
}

/** Tailwind needs the column count as a literal class, not a template. */
const TILE_GRID: Record<number, string> = {
  1: 'lg:grid-cols-1',
  2: 'lg:grid-cols-2',
  3: 'lg:grid-cols-3',
  4: 'lg:grid-cols-4',
  5: 'lg:grid-cols-5',
};

/**
 * The same recommendation codes the zone card resolves, through the same
 * `zone.water.action.*` keys — this file used to carry its own English copy of
 * the table, so the tab printed "Delay irrigation" under a card that printed
 * "Retarder l'irrigation".
 */
const ACTION_LABELS: Record<string, string> = {
  delay_irrigation: 'Delay irrigation',
  irrigate_today: 'Irrigate today',
  monitor_today: 'Monitor today',
  maintain: 'Maintain current irrigation',
  maintain_rain_suppression: 'Rain suppression active',
  maintain_recovery_hold: 'Recovery hold active',
  increase_10: 'Increase irrigation slightly',
  increase_20: 'Increase irrigation',
  decrease_10: 'Decrease irrigation slightly',
  decrease_20: 'Decrease irrigation',
  emergency_irrigate: 'Emergency irrigation',
};

// Same duplication as ACTION_LABELS above, and for the same reason: this tab
// has its own render path and its own English fallback table, through the
// same `zone.water.reason.*` keys the zone card resolves.
const REASON_LABELS: Record<string, string> = {
  supply_covers_demand: "Rain and irrigation cover today's demand",
  forecast_rain_covers_demand: "Forecast rain covers today's shortfall",
  demand_exceeds_supply: "Demand exceeds today's rain and irrigation",
  balance_neutral: 'Water balance is close to neutral',
  balance_unknown: 'Set zone area and irrigation efficiency',
  forecast_unknown: 'No rain forecast available',
};

export const WaterTab: React.FC<Props> = ({ water, devices = [] }) => {
  const { t } = useTranslation('devices');
  const actionLabel = (code: string | null | undefined): string => {
    const fallback = code ? ACTION_LABELS[code] : undefined;
    return fallback
      ? t(`zone.water.action.${code}`, { defaultValue: fallback })
      : t('zone.water.action.default', { defaultValue: 'Monitor water status' });
  };
  const reasonLabel = (reasonCode: string | null | undefined): string => {
    const fallback = reasonCode ? REASON_LABELS[reasonCode] : undefined;
    return fallback
      ? t(`zone.water.reason.${reasonCode}`, { defaultValue: fallback })
      : t('zone.water.reason.default', { defaultValue: 'Waiting for more data' });
  };
  // Mirrors IrrigationZoneCard's water-balance subtitle (formatWaterSubtitle):
  // a `reasonCode` is always preferred; only dendrometer-sourced `reasoning`
  // is prose this tab may show verbatim, since it is a stored per-zone
  // analytics sentence rather than a template written for the screen. Any
  // other `reasoning` — most concretely the cloud's own fabricated English
  // sentence for a linked gateway (F100/X-01) — is logged at debug and
  // replaced with the neutral generic reason key.
  const trendNote = (() => {
    if (water.action?.reasonCode) return reasonLabel(water.action.reasonCode);
    if (water.action?.source === 'dendro' && water.action.reasoning) return water.action.reasoning;
    if (water.action?.reasoning) {
      // eslint-disable-next-line no-console
      console.debug('[WaterTab] suppressed non-dendro action.reasoning prose', water.action.reasoning);
      return reasonLabel(null);
    }
    return t('environment.water.trendNote', {
      defaultValue: 'Compare rainfall against measured and estimated effective irrigation over the last week.',
    });
  })();
  const effective = (value: string) => t('environment.water.effective', {
    value,
    defaultValue: '{{value}} effective',
  });
  const fmt = useDateFormat();
  const hasSetup = water.areaM2 != null && water.irrigationEfficiencyPct != null;
  // Each tile needs something that measures or computes it. The daily
  // aggregation writes 0 for a day with no sample, so an ungated tile reports
  // an invented dry day as a measurement — the zone card two rows above
  // already gates its own tiles this way.
  const hasRainGauge = zoneHasRainGauge(devices) || water.sensorHealth.rainGaugePresent;
  const hasFlowMeter = zoneHasFlowMeter(devices) || water.sensorHealth.flowMeterPresent;
  const hasValve = zoneHasValve(devices);
  const hasWaterSource = hasRainGauge || hasFlowMeter || hasValve;
  const measuredLiters = water.irrigationTodayMeasuredLiters ?? null;
  const estimatedLiters = water.irrigationTodayEstimatedLiters ?? null;
  const measuredNetMm = water.measuredIrrigationNetMm ?? null;
  const estimatedNetMm = water.estimatedIrrigationNetMm ?? null;
  const chartData = water.daily.map((day) => ({
    ...day,
    measuredIrrigationLiters: day.measuredIrrigationLiters ?? null,
    measuredIrrigationNetMm: day.measuredIrrigationNetMm ?? null,
    estimatedIrrigationLiters: day.estimatedIrrigationLiters ?? null,
    estimatedIrrigationNetMm: day.estimatedIrrigationNetMm ?? null,
    // `day.date` is a bare YYYY-MM-DD: parse it as a calendar day, not as
    // UTC midnight, or the label slips to the previous day west of Greenwich.
    shortDate: fmt.date(parseCalendarDay(day.date)) ?? day.date,
  }));

  if (!water.available) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-center text-sm text-[var(--text-secondary)]">
        {t('environment.water.noData', { defaultValue: 'No water summary is available yet.' })}
      </div>
    );
  }

  const tiles: WaterTile[] = [];
  if (hasRainGauge) {
    tiles.push({
      key: 'rain',
      label: t('environment.water.rainToday', { defaultValue: 'Rain today' }),
      value: formatValue(water.rainTodayMm, 'mm', 1),
      tone: 'text-sky-700',
    });
  }
  if (hasFlowMeter) {
    tiles.push({
      key: 'measured-irrigation',
      label: t('environment.water.measuredIrrigationToday', { defaultValue: 'Measured (flow meter)' }),
      value: formatValue(measuredLiters, 'L', 0),
      detail: hasSetup ? effective(formatValue(measuredNetMm, 'mm', 1)) : null,
      tone: 'text-teal-700',
    });
  }
  if (hasValve) {
    tiles.push({
      key: 'estimated-irrigation',
      label: t('environment.water.estimatedIrrigationToday', { defaultValue: 'Estimated (valve time × calibration)' }),
      value: formatValue(estimatedLiters, 'L', 0),
      detail: hasSetup ? effective(formatValue(estimatedNetMm, 'mm', 1)) : null,
      tone: 'text-emerald-700',
    });
  }
  // Crop demand and the balance are computed, not measured: an absent one is
  // an empty tile, and the amber banner below says what to fill in.
  if (water.waterNeededTodayMm != null) {
    tiles.push({
      key: 'needed',
      label: t('environment.water.waterNeededToday', { defaultValue: 'Water needed today' }),
      value: formatValue(water.waterNeededTodayMm, 'mm', 1),
      tone: 'text-amber-700',
    });
  }
  if (water.balanceTodayMm != null) {
    tiles.push({
      key: 'balance',
      label: t('environment.water.balance', { defaultValue: 'Balance' }),
      value: formatValue(water.balanceTodayMm, 'mm', 1),
      // A cloud bundle flagging `source: 'insufficient_data'` (F100/T05j)
      // gets no verb here either, even if it still carries a stale `code`.
      detail: water.action?.code && water.action.source !== 'insufficient_data' ? actionLabel(water.action.code) : null,
      tone: water.balanceTodayMm >= 0 ? 'text-emerald-700' : 'text-orange-700',
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {tiles.length > 0 && (
        <div className={`grid grid-cols-2 gap-2 ${TILE_GRID[tiles.length]}`}>
          {tiles.map((item) => (
            <div key={item.key} className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{item.label}</p>
              <p className={`mt-2 text-2xl font-bold ${item.tone}`}>{item.value}</p>
              {item.detail && (
                <p className="mt-1 text-xs text-[var(--text-secondary)]">{item.detail}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {!hasSetup && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {t('environment.water.setupRequired', {
            defaultValue: 'Add zone area and irrigation efficiency in zone settings to calculate effective irrigation and water balance.',
          })}
        </div>
      )}

      {/* A week of zeros on a zone that has never had a sensor is a chart of
          nothing; it needs a source before it means anything. */}
      {hasWaterSource && (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
              {t('environment.water.weeklyTrend', { defaultValue: '7-day water trend' })}
            </p>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">
              {trendNote}
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
                      <p className="font-semibold text-sky-700">
                        {t('environment.water.tooltipRain', { defaultValue: 'Rain' })}: {formatValue(row.rainMm, 'mm', 1)}
                      </p>
                      <p className="font-semibold text-teal-700">
                        {t('environment.water.measuredIrrigationToday', { defaultValue: 'Measured (flow meter)' })}: {formatValue(row.measuredIrrigationLiters, 'L', 0)}
                      </p>
                      <p className="font-semibold text-emerald-700">
                        {t('environment.water.estimatedIrrigationToday', { defaultValue: 'Estimated (valve time x calibration)' })}: {formatValue(row.estimatedIrrigationLiters, 'L', 0)}
                      </p>
                      {row.measuredIrrigationNetMm != null && (
                        <p className="text-[var(--text-secondary)]">
                          {t('environment.water.tooltipMeasuredEffective', { defaultValue: 'Measured effective' })}: {formatValue(row.measuredIrrigationNetMm, 'mm', 1)}
                        </p>
                      )}
                      {row.estimatedIrrigationNetMm != null && (
                        <p className="text-[var(--text-secondary)]">
                          {t('environment.water.tooltipEstimatedEffective', { defaultValue: 'Estimated effective' })}: {formatValue(row.estimatedIrrigationNetMm, 'mm', 1)}
                        </p>
                      )}
                    </div>
                  );
                }}
              />
              <Bar dataKey="rainMm" name="Rain" fill="#38bdf8" radius={[6, 6, 0, 0]} />
              {hasSetup && <Bar dataKey="measuredIrrigationNetMm" name="Measured effective irrigation" fill="#14b8a6" radius={[6, 6, 0, 0]} />}
              {hasSetup && <Bar dataKey="estimatedIrrigationNetMm" name="Estimated effective irrigation" fill="#22c55e" radius={[6, 6, 0, 0]} />}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      )}

      <div className="flex flex-wrap gap-2 text-xs text-[var(--text-secondary)]">
        {water.sensorHealth.rainGaugePresent && (
          <span className="rounded-full bg-sky-50 px-2.5 py-1 text-sky-800">
            {t('environment.water.rainGaugeReporting', { defaultValue: 'Rain gauge reporting' })}
          </span>
        )}
        {water.sensorHealth.flowMeterPresent && (
          <span className="rounded-full bg-teal-50 px-2.5 py-1 text-teal-800">
            {t('environment.water.flowMeterReporting', { defaultValue: 'Flow meter reporting' })}
          </span>
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
