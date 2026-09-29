import type { WaterDay, WaterEnvironment } from '../../../types/farming';

/** The y axis never drops below this, so a dry week does not zoom into drizzle. */
export const WATER_CHART_MIN_MM = 10;

export interface WaterChartRow extends WaterDay {
  /**
   * Crop demand (ETc) for the day, taken from the day's own row: calculated on the gateway
   * for a completed day, the forecast for today. Null when the day has none; `nullReason`
   * says why.
   */
  demandMm: number | null;
  demandSource: 'calculated' | 'forecast' | null;
  nullReason: string | null;
  /**
   * The height the demand tick is drawn at: the demand, floored at 0. A day without demand
   * draws at 0 so the tick shape can put its grey dash on the baseline, and a negative
   * daily ET0 draws at 0 while the tooltip shows the value.
   */
  demandDrawMm: number;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function buildWaterChartRows(water: WaterEnvironment): WaterChartRow[] {
  return water.daily.map((day) => {
    const demandMm = finite(day.demandMm) ? day.demandMm : null;
    return {
      ...day,
      demandMm,
      demandSource: day.demandSource ?? null,
      nullReason: day.nullReason ?? null,
      demandDrawMm: demandMm != null ? Math.max(0, demandMm) : 0,
    };
  });
}

export type WaterChartKey = 'rainMm' | 'measuredIrrigationNetMm' | 'estimatedIrrigationNetMm' | 'demandDrawMm';

/** Upper bound of the y axis: the floor, or the largest drawn value rounded up to a whole mm. */
export function waterChartMaxMm(rows: WaterChartRow[], drawnKeys: WaterChartKey[]): number {
  let max = 0;
  for (const row of rows) {
    for (const key of drawnKeys) {
      const value = row[key];
      if (finite(value) && value > max) {
        max = value;
      }
    }
  }
  return Math.max(WATER_CHART_MIN_MM, Math.ceil(max));
}

export interface WaterChartSeries {
  rain: boolean;
  measuredIrrigation: boolean;
  estimatedIrrigation: boolean;
  demand: boolean;
}

/**
 * Which series the plot draws, and therefore which the legend lists. Each needs something
 * behind it: rain a source (the zone's gauge, or the station the server names) and at least
 * one day with a value; measured irrigation the zone setup and either a flow meter (a
 * measured zero is a value) or a day above zero; estimated irrigation the zone setup and a
 * day above zero; demand one day that carries it (no zone area needed).
 */
export function waterChartSeries(
  water: WaterEnvironment,
  rows: WaterChartRow[],
  { hasRainGauge, hasFlowMeter }: { hasRainGauge: boolean; hasFlowMeter?: boolean },
): WaterChartSeries {
  const hasSetup = water.areaM2 != null && water.irrigationEfficiencyPct != null;
  const rainSourcePresent = hasRainGauge || water.dailyRainSource === 'meteoswiss_station';
  const flowMeterPresent = hasFlowMeter ?? water.sensorHealth?.flowMeterPresent ?? false;
  return {
    rain: rainSourcePresent && water.daily.some((day) => day.rainMm != null),
    measuredIrrigation: hasSetup && water.daily.some((day) =>
      day.measuredIrrigationNetMm != null && (flowMeterPresent || day.measuredIrrigationNetMm > 0)),
    estimatedIrrigation: hasSetup && water.daily.some((day) =>
      day.estimatedIrrigationNetMm != null && day.estimatedIrrigationNetMm > 0),
    demand: rows.some((row) => row.demandMm != null),
  };
}

/**
 * Whether the "Last 7 days" plot is drawn: rain, measured or estimated
 * irrigation, or at least one calculated day of demand. Today's forecast
 * demand alone is not a week of history.
 */
export function hasWaterTrendData(series: WaterChartSeries, rows: WaterChartRow[]): boolean {
  return series.rain || series.measuredIrrigation || series.estimatedIrrigation
    || rows.some((row) => row.demandMm != null && row.demandSource === 'calculated');
}
