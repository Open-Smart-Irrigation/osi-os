import { describe, expect, it } from 'vitest';
import type { WaterDay, WaterEnvironment } from '../../../../types/farming';
import { WATER_CHART_MIN_MM, buildWaterChartRows, waterChartMaxMm, waterChartSeries } from '../waterChart';

/**
 * The "Last 7 days" plot carries a crop-demand tick beside the measured rain and the
 * measured and estimated irrigation. Each completed day's demand comes from that day's
 * row (calculated on the gateway); today's row carries the forecast. The y axis never
 * drops below 10 mm, so a dry week does not zoom into drizzle, and it grows to the
 * largest drawn value.
 */

function week(rainMm: (index: number) => number | null, demand: (index: number) => Partial<WaterDay> = (index) => (
  index === 6 ? { demandMm: 2.2, demandSource: 'forecast' } : {}
)): WaterDay[] {
  return Array.from({ length: 7 }, (_, index) => ({
    date: `2026-09-${String(12 + index).padStart(2, '0')}`,
    rainMm: rainMm(index),
    irrigationLiters: 0,
    irrigationNetMm: 0,
    measuredIrrigationLiters: 0,
    measuredIrrigationNetMm: 0,
    estimatedIrrigationLiters: 0,
    estimatedIrrigationNetMm: 0,
    totalWaterMm: null,
    ...demand(index),
  }));
}

function water(overrides: Partial<WaterEnvironment> = {}): WaterEnvironment {
  return {
    available: true,
    observedAt: null,
    areaM2: 7000,
    irrigationEfficiencyPct: 80,
    rainTodayMm: 0,
    rainSource: 'meteoswiss_station',
    irrigationTodayLiters: 0,
    irrigationTodayNetMm: 0,
    waterNeededTodayMm: 2.2,
    balanceTodayMm: -2.2,
    next24hRainMm: 0,
    action: null,
    todayDate: '2026-09-18',
    daily: week(() => 0),
    sensorHealth: { sensorCount: 0, freshSensorCount: 0, staleSensorCount: 0, rainGaugePresent: false, flowMeterPresent: false, warnings: [] },
    ...overrides,
  };
}

const NO_GAUGE = { hasRainGauge: false };
const GAUGE = { hasRainGauge: true };

describe('buildWaterChartRows', () => {
  it("takes each day's demand from its row", () => {
    const values = [1.1, 1.6, 2.2, 2.7, 3.3, 3.8, 4.4];
    const rows = buildWaterChartRows(water({ daily: week(() => 0, (index) => ({ demandMm: values[index], demandSource: index === 6 ? 'forecast' : 'calculated' })) }));

    expect(rows).toHaveLength(7);
    expect(rows.map((row) => row.demandMm)).toEqual(values);
    expect(rows[0].date).toBe('2026-09-12');
    expect(rows[6].rainMm).toBe(0);
  });

  it('leaves the demand empty when the server has none', () => {
    const rows = buildWaterChartRows(water({ waterNeededTodayMm: null, daily: week(() => 0, () => ({})) }));
    expect(rows.every((row) => row.demandMm === null)).toBe(true);
  });

  it("keeps each day's demand without area or efficiency: demand needs no zone area", () => {
    const daily = week(() => 0, (index) => ({ demandMm: 3 + index / 10, demandSource: 'calculated' }));
    expect(buildWaterChartRows(water({ areaM2: null, daily })).map((row) => row.demandMm)).toEqual(daily.map((day) => day.demandMm));
    expect(buildWaterChartRows(water({ irrigationEfficiencyPct: null, daily })).map((row) => row.demandMm)).toEqual(daily.map((day) => day.demandMm));
  });

  it('carries the demand source and the null reason of each row', () => {
    const rows = buildWaterChartRows(water({
      waterNeededTodayMm: 9.9,
      daily: week(() => 0, (index) => (index === 0
        ? { demandMm: null, nullReason: 'partial_day' }
        : index === 6 ? { demandMm: 4.1, demandSource: 'forecast' } : { demandMm: 4.8, demandSource: 'calculated' })),
    }));

    expect(rows[0]).toMatchObject({ demandMm: null, demandSource: null, nullReason: 'partial_day' });
    expect(rows[3]).toMatchObject({ demandMm: 4.8, demandSource: 'calculated', nullReason: null });
    expect(rows[6]).toMatchObject({ demandMm: 4.1, demandSource: 'forecast' });
  });

  it("uses today's water need only through today's own row: the other days stay null", () => {
    const rows = buildWaterChartRows(water({ waterNeededTodayMm: 5.5 }));

    expect(rows.map((row) => row.demandMm)).toEqual([null, null, null, null, null, null, 2.2]);
  });

  it('draws a day without demand at 0, so the tick shape puts its dash on the baseline', () => {
    const rows = buildWaterChartRows(water());

    expect(rows[0].demandMm).toBeNull();
    expect(rows[0].demandDrawMm).toBe(0);
    expect(rows[6].demandDrawMm).toBe(2.2);
  });

  it('draws a negative day at 0 and keeps its value for the tooltip', () => {
    const rows = buildWaterChartRows(water({ daily: week(() => 0, (index) => (index === 2 ? { demandMm: -0.2, demandSource: 'calculated' } : {})) }));

    expect(rows[2].demandMm).toBe(-0.2);
    expect(rows[2].demandDrawMm).toBe(0);
  });
});

describe('waterChartMaxMm', () => {
  it('is 10 mm for a dry week', () => {
    const rows = buildWaterChartRows(water());

    expect(WATER_CHART_MIN_MM).toBe(10);
    expect(waterChartMaxMm(rows, ['rainMm', 'measuredIrrigationNetMm', 'estimatedIrrigationNetMm', 'demandDrawMm'])).toBe(10);
  });

  it('grows to the largest drawn value, rounded up to a whole millimetre', () => {
    const rows = buildWaterChartRows(water({ daily: week((index) => (index === 3 ? 23.4 : 0)) }));

    expect(waterChartMaxMm(rows, ['rainMm', 'demandDrawMm'])).toBe(24);
  });

  it('ignores a series that is not drawn', () => {
    const rows = buildWaterChartRows(water({ daily: week((index) => (index === 3 ? 23.4 : 0)) }));

    expect(waterChartMaxMm(rows, ['demandDrawMm'])).toBe(10);
  });

  it('ignores unknown days and stays at the floor', () => {
    const rows = buildWaterChartRows(water({ daily: week(() => null, () => ({})), waterNeededTodayMm: null }));

    expect(waterChartMaxMm(rows, ['rainMm', 'demandDrawMm'])).toBe(10);
  });
});

// The plot carries a legend, so a series that is listed must have something behind it.
// Each irrigation series needs the zone setup: measured irrigation a flow meter (a measured
// zero is a value) or a day above zero, estimated irrigation a day above zero.
describe('waterChartSeries', () => {
  const meter = { sensorCount: 0, freshSensorCount: 0, staleSensorCount: 0, rainGaugePresent: false, flowMeterPresent: true, warnings: [] };

  it('lists no irrigation series when nothing measures or estimates irrigation', () => {
    const w = water({ dailyRainSource: 'meteoswiss_station' });
    expect(waterChartSeries(w, buildWaterChartRows(w), NO_GAUGE)).toEqual({
      rain: true, measuredIrrigation: false, estimatedIrrigation: false, demand: true,
    });
  });

  it('lists estimated irrigation without a meter once a day carries an estimated amount', () => {
    const days = week(() => 0).map((day, index) => (index === 3 ? { ...day, estimatedIrrigationNetMm: 1.4 } : day));
    const w = water({ dailyRainSource: 'meteoswiss_station', daily: days });
    const series = waterChartSeries(w, buildWaterChartRows(w), NO_GAUGE);
    expect(series.estimatedIrrigation).toBe(true);
    expect(series.measuredIrrigation).toBe(false);
  });

  it('counts a measured zero: a meter that saw no irrigation still has a series', () => {
    const w = water({ sensorHealth: meter });
    const series = waterChartSeries(w, buildWaterChartRows(w), NO_GAUGE);
    expect(series.measuredIrrigation).toBe(true);
    expect(series.estimatedIrrigation).toBe(false);
  });

  it('lists no irrigation series without area and efficiency, meter or not', () => {
    const days = week(() => 0).map((day, index) => (index === 3 ? { ...day, estimatedIrrigationNetMm: 1.4 } : day));
    const w = water({ sensorHealth: meter, areaM2: null, daily: days });
    const series = waterChartSeries(w, buildWaterChartRows(w), NO_GAUGE);
    expect(series.measuredIrrigation).toBe(false);
    expect(series.estimatedIrrigation).toBe(false);
  });

  it('lists rain only when a source stands behind it and a day has a value', () => {
    const noSource = water({ dailyRainSource: null });
    expect(waterChartSeries(noSource, buildWaterChartRows(noSource), NO_GAUGE).rain).toBe(false);
    const gaugeAllNull = water({ dailyRainSource: null, daily: week(() => null) });
    expect(waterChartSeries(gaugeAllNull, buildWaterChartRows(gaugeAllNull), GAUGE).rain).toBe(false);
    const gaugeDryWeek = water({ dailyRainSource: 'gauge' });
    expect(waterChartSeries(gaugeDryWeek, buildWaterChartRows(gaugeDryWeek), GAUGE).rain).toBe(true);
  });

  it('lists the demand series whenever a day carries demand, balance or not', () => {
    const w = water({ areaM2: null, balanceTodayMm: null, dailyRainSource: 'meteoswiss_station' });
    expect(waterChartSeries(w, buildWaterChartRows(w), NO_GAUGE).demand).toBe(true);
    const none = water({ daily: week(() => 0, () => ({})) });
    expect(waterChartSeries(none, buildWaterChartRows(none), NO_GAUGE).demand).toBe(false);
  });
});
