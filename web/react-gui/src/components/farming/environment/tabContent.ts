import type {
  AgronomicEnvironment,
  Device,
  DailyForecast,
  ForecastEnvironment,
  HourlyForecast,
  LocalEnvironment,
  OnlineEnvironment,
  WaterDay,
  WaterEnvironment,
  ZoneEnvironmentSummary,
} from '../../../types/farming';
import { collectDeviceSwtValues } from '../../../utils/swt';

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

/**
 * Fields the edge fills with 0 when nothing was measured (the daily
 * aggregation writes 0 for a day without a sample, and today's flow/estimated
 * litres default to 0 without a row) only count above zero. Fields with a
 * null-when-unknown contract keep their zero as a real measurement.
 */
function positive(value: number | null | undefined): boolean {
  return finite(value) && value > 0;
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

function hasUsableHourlyForecast(hour: HourlyForecast): boolean {
  // The hourly chart draws rain and probability; `time` alone is a timestamp.
  return finite(hour.rainMm) || finite(hour.rainProbabilityPct);
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

function hasUsableWaterDay(day: WaterDay): boolean {
  return positive(day.rainMm)
    || finite(day.rainReceivedMm)
    || finite(day.demandMm)
    || finite(day.et0Mm)
    || positive(day.measuredIrrigationLiters)
    || positive(day.estimatedIrrigationLiters)
    || positive(day.measuredIrrigationNetMm)
    || positive(day.estimatedIrrigationNetMm);
}

/**
 * Whether the Water tab has a value to render. The edge sets
 * `water.available` as soon as any section has anything, so the flag alone is
 * not content; the check is on the fields the tab draws. Rain, demand,
 * balance and the forecast total are null when unknown, so their zero is a
 * real value; the litre and daily-rain fields are 0-by-default on the edge
 * and only count above zero.
 */
export function hasUsableWaterContent(water: WaterEnvironment): boolean {
  if (!water) return false;
  if (finite(water.rainTodayMm)
    || finite(water.rainTodayReceivedMm)
    || finite(water.waterNeededTodayMm)
    || finite(water.balanceTodayMm)
    || finite(water.next24hRainMm)) return true;
  if (positive(water.irrigationTodayMeasuredLiters) || positive(water.irrigationTodayEstimatedLiters)) return true;
  return water.daily.some(hasUsableWaterDay);
}

/**
 * Whether the Soil tab renders a reading: its two metric tiles come from the
 * local rollups and its SWT value from the zone's devices, through the same
 * collector SoilTab uses.
 */
export function hasUsableSoilContent(
  local: LocalEnvironment,
  devices: Array<Pick<Device, 'latest_data'>>,
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
  devices: Array<Pick<Device, 'latest_data'>>,
): EnvironmentTabId | null {
  if (hasUsableWeatherContent(summary.online, summary.forecast)) return 'weather';
  if (hasUsableWaterContent(summary.water)) return 'water';
  if (hasUsableSoilContent(summary.local, devices)) return 'soil';
  if (hasUsableSensorsContent(summary.local)) return 'sensors';
  if (hasUsableAgronomicContent(summary.agronomic)) return 'agronomic';
  return null;
}
