import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { LegendProps } from 'recharts';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { parseCalendarDay, useDateFormat } from '../../../utils/datetime';
import { zoneHasFlowMeter, zoneHasRainGauge, zoneHasValve } from '../../../utils/zoneSoil';
import { cropById, normalizeStage, stageLengths } from '../../../agronomy/cropKc';
import { STAGE_FALLBACK } from '../../../agronomy/stageLabels';
import type { Device, WaterEnvironment } from '../../../types/farming';
import { HelpTip } from '../shared/HelpTip';
import { buildWaterChartRows, hasWaterTrendData, waterChartMaxMm, waterChartSeries, type WaterChartKey, type WaterChartRow, type WaterChartSeries } from './waterChart';

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
  /** Explanation behind a `?` beside the label; never a caption. */
  help?: { label: string; text: string } | null;
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
  rain_unknown: 'No rain measurement for today',
  demand_unknown: 'No water demand estimate for today',
};

type Translate = TFunction<'devices'>;
type LegendEntry = NonNullable<LegendProps['payload']>[number];

const RAIN_COLOR = '#38bdf8';
const MEASURED_COLOR = '#14b8a6';
const ESTIMATED_COLOR = '#22c55e';
const DEMAND_COLOR = '#f97316';

/**
 * The bar shape of the demand series: a horizontal tick across the day's slot at the
 * day's demand, solid for a calculated day and dashed for today's forecast. A day
 * without demand draws at 0 (see `demandDrawMm`) and gets a short grey dash on the
 * baseline, so a gap in the record shows as a gap rather than as a dry day.
 */
export interface DemandTickProps { x?: number; y?: number; width?: number; height?: number; payload?: WaterChartRow }

// recharts types a bar shape as `(props: unknown) => Element`.
export function DemandTick(rawProps: unknown): React.ReactElement {
  const { x = 0, y = 0, width = 0, height = 0, payload } = (rawProps ?? {}) as DemandTickProps;
  if (!payload) return <g />;
  if (payload.demandMm == null) {
    const baseline = y + height;
    return (
      <line
        data-testid="demand-tick-missing"
        x1={x + width * 0.35}
        x2={x + width * 0.65}
        y1={baseline}
        y2={baseline}
        stroke="var(--text-tertiary)"
        strokeWidth={2}
        strokeDasharray="3 2"
      />
    );
  }
  const forecast = payload.demandSource === 'forecast';
  return (
    <line
      data-testid={forecast ? 'demand-tick-forecast' : 'demand-tick'}
      x1={x + width * 0.1}
      x2={x + width * 0.9}
      y1={y}
      y2={y}
      stroke={DEMAND_COLOR}
      strokeWidth={3}
      strokeDasharray={forecast ? '5 3' : undefined}
    />
  );
}

/**
 * The demand value of one day with its kind, or why it has none. A day
 * without a stored row, or a row with no source at all, is "no weather
 * source"; only a partial day is "record incomplete"; today without a
 * forecast demand is the cloud's demand_unknown.
 */
export function demandText(t: Translate, row: Pick<WaterChartRow, 'demandMm' | 'demandSource' | 'nullReason'>): string {
  if (row.demandMm != null && Number.isFinite(row.demandMm)) {
    const value = row.demandMm.toFixed(1);
    return row.demandSource === 'forecast'
      ? t('environment.water.demandForecast', { value, defaultValue: '{{value}} mm (forecast)' })
      : t('environment.water.demandCalculated', { value, defaultValue: '{{value}} mm (calculated)' });
  }
  switch (row.nullReason) {
    case 'pending':
      return t('environment.water.demandPending', { defaultValue: 'pending' });
    case 'no_location':
      return t('environment.water.demandNoLocation', { defaultValue: 'no data (zone has no location)' });
    case 'demand_unknown':
      return t('environment.water.demandUnknownToday', { defaultValue: 'no estimate for today' });
    case 'mixed_station':
      return t('environment.water.demandMixedStation', { defaultValue: 'hours from two MeteoSwiss stations' });
    case 'unknown_station':
      return t('environment.water.demandUnknownStation', { defaultValue: 'MeteoSwiss station unknown for these hours' });
    case null:
    case undefined:
    case 'no_source':
      return t('environment.water.demandNoSource', { defaultValue: 'no weather source for this day' });
    default:
      return t('environment.water.demandNoData', { defaultValue: 'no data (weather record incomplete)' });
  }
}

/**
 * Where a day's demand comes from: the ET0 source ("Station demo-s2120 · FAO-56",
 * "Open-Meteo model", "MeteoSwiss PAY", or the forecast for today), the day's
 * ET0 and the crop coefficient behind it with its crop and stage. Null when
 * the row names none of them.
 */
export function sourceText(
  t: Translate,
  row: Pick<WaterChartRow, 'demandSource' | 'et0Source' | 'et0Tier' | 'et0StationId' | 'et0StationName' | 'et0Mm' | 'kc' | 'kcSource' | 'cropType' | 'phenologicalStage'> | null | undefined,
): string | null {
  if (!row) return null;
  const station = row.et0StationName ?? row.et0StationId ?? '';
  let et0: string | null = null;
  if (row.demandSource === 'forecast') {
    et0 = t('environment.water.et0Tier.forecast', { defaultValue: 'Weather forecast' });
  } else if (row.et0Tier === 'station_fao56') {
    et0 = t('environment.water.et0Tier.station_fao56', { station, defaultValue: 'Station {{station}} · FAO-56' });
  } else if (row.et0Tier === 'hargreaves_station') {
    et0 = t('environment.water.et0Tier.hargreaves_station', { station, defaultValue: 'Station {{station}} · Hargreaves' });
  } else if (row.et0Tier === 'open_meteo_daily') {
    // A day OSI Cloud computed from Open-Meteo's daily ET0 (shared mode, plan CC).
    et0 = t('environment.water.et0Tier.open_meteo_daily', { defaultValue: 'Open-Meteo weather model, daily FAO-56' });
  } else if (row.et0Source === 'meteoswiss_hourly_sum') {
    et0 = t('environment.water.et0Tier.provider_meteoswiss', { station, defaultValue: 'MeteoSwiss {{station}}' });
  } else if (row.et0Source === 'open_meteo_hourly_sum') {
    et0 = t('environment.water.et0Tier.provider_open_meteo', { defaultValue: 'Open-Meteo model' });
  }
  const et0Mm = row.et0Mm != null && Number.isFinite(row.et0Mm)
    ? t('environment.water.et0Line', { et0: row.et0Mm.toFixed(1), defaultValue: 'ET0 {{et0}} mm' })
    : null;
  const crop = cropById(row.cropType)?.label ?? row.cropType ?? '';
  // Today's forecast demand is computed by the cloud bundle ('server') or by
  // this gateway ('local'); the zone's crop is named beside it when known.
  const computedBy = row.kcSource === 'server' || row.kcSource === 'local'
    ? (crop
      ? t('environment.water.kcSourceByCrop', { source: t(`environment.water.kcSource.${row.kcSource}`), crop, defaultValue: '{{source}}, {{crop}}' })
      : t(`environment.water.kcSource.${row.kcSource}`))
    : null;
  let kc: string | null = null;
  if (row.kc != null && Number.isFinite(row.kc)) {
    const stage = normalizeStage(row.phenologicalStage);
    const stageLabel = stage
      ? t(`zoneConfig.stage.${stage}`, { defaultValue: STAGE_FALLBACK[stage] })
      : t('environment.water.stageNotSet', { defaultValue: 'stage not set' });
    const source = computedBy ?? (row.kcSource
      ? t(`environment.water.kcSource.${row.kcSource}`, { crop, stage: stageLabel, defaultValue: row.kcSource })
      : null);
    kc = source
      ? t('environment.water.kcLine', { kc: row.kc.toFixed(2), source, defaultValue: 'Kc {{kc}} ({{source}})' })
      : `Kc ${row.kc.toFixed(2)}`;
  } else {
    kc = computedBy;
  }
  const parts = [et0, et0Mm, kc].filter((part): part is string => !!part);
  return parts.length ? parts.join(' · ') : null;
}

interface WaterDayTooltipProps {
  row: WaterChartRow;
  label: string;
  water: WaterEnvironment;
  isToday?: boolean;
  /** The plot's series: a supply line shows only for a series the plot draws. Absent, every line shows. */
  series?: WaterChartSeries;
}

/** The body of the plot's day tooltip: supply, demand, its source and the data credits. */
export const WaterDayTooltip: React.FC<WaterDayTooltipProps> = ({ row, label, water, isToday = false, series }) => {
  const { t } = useTranslation('devices');
  const source = sourceText(t, row);
  // A supply the plot does not draw (no gauge, no flow meter, no valve) is no
  // line either: the tooltip would otherwise report an invented 0.
  const showRain = series ? series.rain : true;
  const showMeasured = series ? series.measuredIrrigation : true;
  const showEstimated = series ? series.estimatedIrrigation : true;
  const stage = normalizeStage(row.phenologicalStage);
  const overrunDays = row.stageOverrun === true && stage && stage !== 'dormancy'
    ? stageLengths(row.cropType)?.[stage] ?? null
    : null;
  // Only a shared-mode day the gateway has no demand for carries 'cloud'.
  const cloudDay = row.demandComputedBy === 'cloud' && row.demandMm != null && Number.isFinite(row.demandMm);
  const credits: string[] = [];
  if (row.et0Source === 'open_meteo_hourly_sum' || row.et0Tier === 'open_meteo_daily') {
    credits.push(t('environment.water.attribution.open_meteo', { defaultValue: 'Weather data by Open-Meteo.com, CC BY 4.0' }));
  }
  if (row.et0Source === 'meteoswiss_hourly_sum' || water.dailyRainSource === 'meteoswiss_station') {
    credits.push(t('environment.water.stationCredit', { defaultValue: 'Source: MeteoSwiss' }));
  }
  return (
    <div className="max-w-xs rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 text-sm shadow-xl">
      <p className="mb-1 text-[var(--text-tertiary)]">{label}</p>
      {showRain && (
        <p className="font-semibold text-sky-700">
          {t('environment.water.tooltipRain', { defaultValue: 'Rain' })}: {formatValue(row.rainMm, 'mm', 1)}
        </p>
      )}
      {showMeasured && (
        <p className="font-semibold text-teal-700">
          {t('environment.water.measuredIrrigationToday', { defaultValue: 'Measured (flow meter)' })}: {formatValue(row.measuredIrrigationLiters, 'L', 0)}
        </p>
      )}
      {showEstimated && (
        <p className="font-semibold text-emerald-700">
          {t('environment.water.estimatedIrrigationToday', { defaultValue: 'Estimated (valve time × calibration)' })}: {formatValue(row.estimatedIrrigationLiters, 'L', 0)}
        </p>
      )}
      {showMeasured && row.measuredIrrigationNetMm != null && (
        <p className="text-[var(--text-secondary)]">
          {t('environment.water.tooltipMeasuredEffective', { defaultValue: 'Measured effective' })}: {formatValue(row.measuredIrrigationNetMm, 'mm', 1)}
        </p>
      )}
      {showEstimated && row.estimatedIrrigationNetMm != null && (
        <p className="text-[var(--text-secondary)]">
          {t('environment.water.tooltipEstimatedEffective', { defaultValue: 'Estimated effective' })}: {formatValue(row.estimatedIrrigationNetMm, 'mm', 1)}
        </p>
      )}
      <p className="font-semibold text-orange-600">
        {`${t('environment.water.tooltipDemand', { defaultValue: 'Crop demand' })}: ${demandText(t, row)}`}
      </p>
      {source && <p className="text-xs text-[var(--text-secondary)]">{source}</p>}
      {cloudDay && (
        <p className="text-xs text-[var(--text-secondary)]">
          {t('environment.water.computedBy.cloud', { defaultValue: 'ET0 from the Open-Meteo weather model (not measured at this farm); OSI Cloud applies the crop coefficient' })}
        </p>
      )}
      {row.stageOverrun === true && overrunDays != null && (
        <p className="mt-1 text-xs text-amber-800">
          {t('environment.water.stageOverrun', { days: overrunDays, defaultValue: "Past this stage's typical length ({{days}} days, FAO-56 Table 11): the stage may be out of date; choose the next stage when the crop reaches it." })}
        </p>
      )}
      {cloudDay && (
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          {t('environment.water.modelAccuracyNote', { defaultValue: 'Model-based ET0 can differ from a local station by 10-20 % on a single day, most on cloudy, windy or mountain days; weekly totals agree better.' })}
        </p>
      )}
      {isToday && (
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          {t('environment.water.tooltipTodayNote', { defaultValue: 'Rain and irrigation so far; demand is the forecast for the whole day' })}
        </p>
      )}
      {credits.map((credit) => (
        <p key={credit} className="mt-1 text-xs text-[var(--text-tertiary)]">{credit}</p>
      ))}
    </div>
  );
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
  const measuredLiters = water.irrigationTodayMeasuredLiters ?? null;
  const estimatedLiters = water.irrigationTodayEstimatedLiters ?? null;
  const measuredNetMm = water.measuredIrrigationNetMm ?? null;
  const estimatedNetMm = water.estimatedIrrigationNetMm ?? null;
  // A linked gateway can carry rain for a zone without a gauge: measured at the
  // nearest MeteoSwiss station, or the weather service's rain for the hours of
  // today that have passed. The zone's own gauge always wins the label.
  const rainStationLabel = water.rainStation
    ? {
        station: water.rainStation.name ?? water.rainStation.id,
        distance: water.rainStation.distanceKm != null && Number.isFinite(water.rainStation.distanceKm)
          ? water.rainStation.distanceKm.toFixed(1)
          : '—',
      }
    : null;
  const rainSourceHelp = hasRainGauge
    ? null
    : water.rainSource === 'meteoswiss_station' && rainStationLabel
      ? t('zone.water.rainFromStation', { ...rainStationLabel, defaultValue: 'Measured at MeteoSwiss {{station}} ({{distance}} km away)' })
      : water.rainSource === 'weather_service'
        ? t('zone.water.rainFromWeather', { defaultValue: 'From weather data (not measured)' })
        : null;
  const showRainTile = hasRainGauge || (rainSourceHelp != null && water.rainTodayMm != null);
  const todayDate = water.todayDate ?? null;
  const chartData = buildWaterChartRows(water);
  // One decision for the bars, the axis and the legend (see waterChartSeries).
  const series = waterChartSeries(water, chartData, { hasRainGauge, hasFlowMeter });
  // Today's forecast alone draws no plot: it needs rain, irrigation or a
  // calculated day of demand (spec, Water tab).
  const hasTrendData = hasWaterTrendData(series, chartData);
  const forecastPresent = water.next24hRainMm != null;
  const drawnKeys: WaterChartKey[] = [
    ...(series.rain ? (['rainMm'] as const) : []),
    ...(series.measuredIrrigation ? (['measuredIrrigationNetMm'] as const) : []),
    ...(series.estimatedIrrigation ? (['estimatedIrrigationNetMm'] as const) : []),
    ...(series.demand ? (['demandDrawMm'] as const) : []),
  ];
  const yAxisMaxMm = waterChartMaxMm(chartData, drawnKeys);
  const todayRow = todayDate ? chartData.find((row) => row.date === todayDate) ?? null : null;
  // `day.date` is a bare YYYY-MM-DD: parse it as a calendar day, not as UTC
  // midnight, or the label slips to the previous day west of Greenwich.
  const dayLabel = (date: string): string => (date === todayDate
    ? t('environment.water.today', { defaultValue: 'Today' })
    : fmt.date(parseCalendarDay(date)) ?? date);
  const legendPayload: LegendEntry[] = [
    ...(series.rain ? [{ id: 'rain', value: t('environment.water.tooltipRain', { defaultValue: 'Rain' }), type: 'square' as const, color: RAIN_COLOR }] : []),
    ...(series.measuredIrrigation ? [{ id: 'measured', value: t('environment.water.tooltipMeasuredEffective', { defaultValue: 'Measured effective' }), type: 'square' as const, color: MEASURED_COLOR }] : []),
    ...(series.estimatedIrrigation ? [{ id: 'estimated', value: t('environment.water.tooltipEstimatedEffective', { defaultValue: 'Estimated effective' }), type: 'square' as const, color: ESTIMATED_COLOR }] : []),
    ...(series.demand ? [
      { id: 'demand', value: t('environment.water.legendDemand', { defaultValue: 'Crop demand (calculated)' }), type: 'plainline' as const, color: DEMAND_COLOR, payload: { strokeDasharray: '0' } },
      { id: 'demand-today', value: t('environment.water.legendDemandTodayForecast', { defaultValue: 'Crop demand today (forecast)' }), type: 'plainline' as const, color: DEMAND_COLOR, payload: { strokeDasharray: '5 3' } },
    ] : []),
  ];

  if (!water.available) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-center text-sm text-[var(--text-secondary)]">
        {t('environment.water.noData', { defaultValue: 'No water summary is available yet.' })}
      </div>
    );
  }

  const setupHelp = hasSetup ? null : {
    label: t('environment.water.setupRequiredHelpLabel', { defaultValue: 'Why effective irrigation is missing' }),
    text: t('environment.water.setupRequired', {
      defaultValue: 'Add zone area and irrigation efficiency in zone settings to calculate effective irrigation and water balance.',
    }),
  };
  const tiles: WaterTile[] = [];
  if (showRainTile) {
    tiles.push({
      key: 'rain',
      label: t('environment.water.rainToday', { defaultValue: 'Rain today' }),
      value: formatValue(water.rainTodayMm, 'mm', 1),
      help: rainSourceHelp
        ? { label: t('environment.water.rainSourceHelpLabel', { defaultValue: 'Where this rain value comes from' }), text: rainSourceHelp }
        : null,
      tone: 'text-sky-700',
    });
  }
  if (hasFlowMeter) {
    tiles.push({
      key: 'measured-irrigation',
      label: t('environment.water.measuredIrrigationToday', { defaultValue: 'Measured (flow meter)' }),
      value: formatValue(measuredLiters, 'L', 0),
      detail: hasSetup ? effective(formatValue(measuredNetMm, 'mm', 1)) : null,
      help: setupHelp,
      tone: 'text-teal-700',
    });
  }
  if (hasValve) {
    tiles.push({
      key: 'estimated-irrigation',
      label: t('environment.water.estimatedIrrigationToday', { defaultValue: 'Estimated (valve time × calibration)' }),
      value: formatValue(estimatedLiters, 'L', 0),
      detail: hasSetup ? effective(formatValue(estimatedNetMm, 'mm', 1)) : null,
      help: setupHelp,
      tone: 'text-emerald-700',
    });
  }
  // Crop demand and the balance are computed, not measured: an absent one is
  // no tile at all.
  if (water.waterNeededTodayMm != null) {
    const todaySource = sourceText(t, todayRow) ?? t('environment.water.et0Tier.forecast', { defaultValue: 'Weather forecast' });
    tiles.push({
      key: 'needed',
      label: t('environment.water.waterNeededToday', { defaultValue: 'Water needed today' }),
      value: formatValue(water.waterNeededTodayMm, 'mm', 1),
      help: {
        label: t('environment.water.neededTodayHelpLabel', { defaultValue: 'About water needed today' }),
        text: t('environment.water.neededTodayHelp', { source: todaySource, defaultValue: 'Forecast for the whole day · {{source}}' }),
      },
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
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{item.label}</p>
                {item.help && <HelpTip label={item.help.label}>{item.help.text}</HelpTip>}
              </div>
              <p className={`mt-2 text-2xl font-bold ${item.tone}`}>{item.value}</p>
              {item.detail && (
                <p className="mt-1 text-xs text-[var(--text-secondary)]">{item.detail}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* The plot needs something to draw: measured rain, measured or estimated
          irrigation, or a day of crop demand. Without any of them it is a week of
          zeros presented as history, so it is not drawn; the verdict and the
          forecast stay, because both still say something. */}
      {(hasTrendData || forecastPresent) && (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {hasTrendData && (
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                {t('environment.water.lastSevenDays', { defaultValue: 'Last 7 days' })}
              </p>
            )}
            <HelpTip label={t('environment.water.lastSevenDaysHelpLabel', { defaultValue: 'About the last 7 days' })}>
              {trendNote}
            </HelpTip>
          </div>
          {/* No location, or no provider reply, means no forecast at all; the line
              read "Next 24 h rain: —", which looks like a reading that failed. */}
          {forecastPresent && (
            <div className="text-xs text-[var(--text-tertiary)]">
              {t('environment.water.nextRain', { defaultValue: 'Next 24 h rain' })}: {formatValue(water.next24hRainMm, 'mm', 1)}
            </div>
          )}
        </div>
        {hasTrendData && (
        <div className="mt-4 h-72" data-testid="water-trend-chart">
          <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 288 }}>
            <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="date"
                tickFormatter={(date: string) => dayLabel(String(date))}
                tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                axisLine={{ stroke: 'var(--border)' }}
                tickLine={false}
              />
              {/* A band of its own for the demand tick, so the tick spans the whole
                  day slot whatever the rain and irrigation bars do. */}
              <XAxis xAxisId="demand" dataKey="date" hide />
              <YAxis
                domain={[0, yAxisMaxMm]}
                tickFormatter={(value: number) => `${value} mm`}
                tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                axisLine={false}
                tickLine={false}
                width={52}
              />
              <Legend payload={legendPayload} wrapperStyle={{ fontSize: 11 }} iconSize={10} />
              <Tooltip
                content={({ active, payload, label }) => (active && payload?.length
                  ? (
                    <WaterDayTooltip
                      row={payload[0].payload as WaterChartRow}
                      label={dayLabel(String(label))}
                      water={water}
                      isToday={String(label) === todayDate}
                      series={series}
                    />
                  )
                  : null)}
              />
              {series.rain && <Bar dataKey="rainMm" name={t('environment.water.tooltipRain', { defaultValue: 'Rain' })} fill={RAIN_COLOR} radius={[6, 6, 0, 0]} />}
              {series.measuredIrrigation && <Bar dataKey="measuredIrrigationNetMm" name={t('environment.water.tooltipMeasuredEffective', { defaultValue: 'Measured effective' })} fill={MEASURED_COLOR} radius={[6, 6, 0, 0]} />}
              {series.estimatedIrrigation && <Bar dataKey="estimatedIrrigationNetMm" name={t('environment.water.tooltipEstimatedEffective', { defaultValue: 'Estimated effective' })} fill={ESTIMATED_COLOR} radius={[6, 6, 0, 0]} />}
              {series.demand && (
                <Bar
                  xAxisId="demand"
                  dataKey="demandDrawMm"
                  name={t('environment.water.tooltipDemand', { defaultValue: 'Crop demand' })}
                  shape={DemandTick}
                  isAnimationActive={false}
                  legendType="none"
                />
              )}
              {todayDate && (
                <ReferenceLine x={todayDate} position="start" stroke="var(--text-tertiary)" strokeDasharray="4 3" ifOverflow="visible" />
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>
        )}
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
