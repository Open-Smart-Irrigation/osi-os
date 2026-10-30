import type {
  AgronomicEnvironment,
  Device,
  DailyForecast,
  ForecastEnvironment,
  HourlyForecast,
  LocalEnvironment,
  OnlineEnvironment,
  WaterEnvironment,
  ZoneEnvironmentSummary,
} from '../../../types/farming';
import { collectDeviceSwtValues } from '../../../utils/swt';
import { buildWaterChartRows, hasWaterTrendData, waterChartSeries, waterSourceVisibility } from './waterChart';

/**
 * Content-availability rules for the Environment card's tab selection (#310
 * follow-up). One rule above all: a section is content only when it carries a
 * value the tab actually renders. An `available` flag, or a non-null section
 * whose values are all null, is a provider reply with nothing usable in it;
 * a finite measured zero IS usable (a dry forecast or a frost reading is
 * data); timestamps, hour counts and coverage metadata are not conditions.
 *
 * Each check mirrors the fields its tab renders, so the default tab and the
 * tab's own output cannot disagree about what counts as data.
 */

export type EnvironmentTabId = 'water' | 'soil' | 'weather' | 'agronomic' | 'sensors';

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonEmptyText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Whether the online section carries a current condition the Weather tab's
 * conditions bar renders: icon or description, temperature, humidity, wind.
 * Pressure, cloud cover and rain stay unrendered there and so do not count.
 */
export function hasUsableCurrentConditions(online: OnlineEnvironment): boolean {
  if (!online?.available || !online.current) return false;
  const current = online.current;
  return nonEmptyText(current.description)
    || finite(current.weatherCode)
    || finite(current.airTemperatureC)
    || finite(current.relativeHumidityPct)
    || finite(current.windSpeedMps);
}

function hasUsableDailyForecast(day: DailyForecast): boolean {
  return finite(day.weatherCode)
    || nonEmptyText(day.description)
    || finite(day.maxTempC)
    || finite(day.minTempC)
    || finite(day.rainMm)
    || finite(day.rainProbabilityPct);
}

/** Match the hourly plot's upper time boundary; an invalid time is not plotted. */
export function isForecastHourVisible(time: string, nowMs = Date.now()): boolean {
  const instant = new Date(time).getTime();
  return Number.isFinite(instant) && instant <= nowMs + 24 * 60 * 60 * 1000;
}

function hasUsableHourlyForecast(hour: HourlyForecast): boolean {
  // The hourly chart draws rain and probability; `time` alone is a timestamp.
  return isForecastHourVisible(hour.time) && (finite(hour.rainMm) || finite(hour.rainProbabilityPct));
}

/**
 * Whether the forecast section carries content the Weather tab renders: a
 * rain pill (24 h / 72 h total), a daily card, or an hourly chart point.
 * `nextRainEta` and `maxHourlyRainAt` are timestamps, `rainHoursNext24h` a
 * count and `next24hCoverage` bookkeeping; none is a condition on its own.
 */
export function hasUsableForecastContent(forecast: ForecastEnvironment): boolean {
  if (!forecast?.available || !forecast.rainFocus) return false;
  const rainFocus = forecast.rainFocus;
  if (finite(rainFocus.totalNext24hMm) || finite(rainFocus.totalNext72hMm)) return true;
  if (rainFocus.daily.some(hasUsableDailyForecast)) return true;
  return rainFocus.hourly.some(hasUsableHourlyForecast);
}

export function hasUsableWeatherContent(
  online: OnlineEnvironment,
  forecast: ForecastEnvironment,
): boolean {
  return hasUsableCurrentConditions(online) || hasUsableForecastContent(forecast);
}

/** Count only values behind a visible Water tile, forecast line or trend. */
export function hasUsableWaterContent(water: WaterEnvironment, devices: Device[] = []): boolean {
  if (!water?.available) return false;
  const visibility = waterSourceVisibility(water, devices);
  if (finite(water.waterNeededTodayMm)
    || finite(water.balanceTodayMm)
    || finite(water.next24hRainMm)) return true;
  if (visibility.showRainTile && (finite(water.rainTodayMm) || finite(water.rainTodayReceivedMm))) return true;
  if (visibility.hasFlowMeter && (finite(water.irrigationTodayMeasuredLiters)
    || (visibility.hasSetup && finite(water.measuredIrrigationNetMm)))) return true;
  if (visibility.hasValve && (finite(water.irrigationTodayEstimatedLiters)
    || (visibility.hasSetup && finite(water.estimatedIrrigationNetMm)))) return true;
  const rows = buildWaterChartRows(water);
  return hasWaterTrendData(waterChartSeries(water, rows, visibility), rows);
}

/**
 * Whether the Soil tab renders a reading: its two metric tiles come from the
 * local rollups and its SWT value from the zone's devices, through the same
 * collector SoilTab uses.
 */
export function hasUsableSoilContent(
  local: LocalEnvironment,
  devices: Device[],
): boolean {
  if (collectDeviceSwtValues(devices ?? []).length > 0) return true;
  const metrics = local?.metrics ?? [];
  return metrics.some((metric) => metric.key === 'soil_moisture_pct' || metric.key === 'soil_temperature_c');
}

/** The Sensors tab's own gate: available with at least one metric behind it. */
export function hasUsableSensorsContent(local: LocalEnvironment): boolean {
  return local?.available === true && (local.metrics?.length ?? 0) > 0;
}

/**
 * Whether the Agronomy tab shows a measured or derived condition. A non-null
 * `current` of all-null values only renders the FAO-56 Kc reference table,
 * which is not zone data.
 */
export function hasUsableAgronomicContent(agronomic: AgronomicEnvironment): boolean {
  const current = agronomic?.current;
  if (!current) return false;
  return finite(current.airTemperatureC)
    || finite(current.relativeHumidityPct)
    || finite(current.vpdKpa)
    || finite(current.dewPointC)
    || finite(current.heatIndexC)
    || finite(current.thi)
    || finite(current.referenceEt0MmDay)
    || finite(current.cropCoefficientKc)
    || finite(current.etcMmDay);
}

/**
 * The tab the card opens on: Weather when the zone has current conditions or
 * forecast content, then the first of Water/Soil/Sensors/Agronomy that has
 * something. Null when none does — the card then shows its explicit no-data
 * state instead of pretending a tab has content.
 */
export function preferredEnvironmentTab(
  summary: ZoneEnvironmentSummary,
  devices: Device[],
): EnvironmentTabId | null {
  if (hasUsableWeatherContent(summary.online, summary.forecast)) return 'weather';
  if (hasUsableWaterContent(summary.water, devices)) return 'water';
  if (hasUsableSoilContent(summary.local, devices)) return 'soil';
  if (hasUsableSensorsContent(summary.local)) return 'sensors';
  if (hasUsableAgronomicContent(summary.agronomic)) return 'agronomic';
  return null;
}
