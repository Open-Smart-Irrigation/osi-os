// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import enCommon from '../../../../../public/locales/en/common.json';
import enDevices from '../../../../../public/locales/en/devices.json';
import type { WaterDay, WaterEnvironment } from '../../../../types/farming';
import { DemandTick, WaterDayTooltip, WaterTab } from '../WaterTab';
import { buildWaterChartRows, type WaterChartRow, type WaterChartSeries } from '../waterChart';

/**
 * The "Last 7 days" plot draws measured rain, measured and estimated effective irrigation,
 * and a crop-demand tick per day: solid for a calculated day, dashed for today's forecast,
 * a grey dash on the baseline for a day without demand. A zone without a gauge can carry
 * rain measured at the nearest MeteoSwiss station; the station, the distance and the
 * licence credit live in tooltips, never in a caption under the plot.
 *
 * Runs against the shipped English locale, so a missing key shows up as missing copy.
 */

// recharts' ResponsiveContainer observes its box; jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

function buildTestI18n() {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: 'devices',
    ns: ['common', 'devices'],
    resources: { en: { common: enCommon, devices: enDevices } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
  return instance;
}

const TREND_TITLE = enDevices.environment.water.lastSevenDays;
const NEXT_RAIN_LABEL = enDevices.environment.water.nextRain;
const DEMAND_EXCEEDS_SUPPLY = enDevices.zone.water.reason.demand_exceeds_supply;
const TODAY = '2026-09-18';

function week(overrides: (index: number) => Partial<WaterDay>): WaterDay[] {
  return Array.from({ length: 7 }, (_, index) => ({
    date: `2026-09-${String(12 + index).padStart(2, '0')}`,
    rainMm: null,
    irrigationLiters: 0,
    irrigationNetMm: 0,
    measuredIrrigationLiters: 0,
    measuredIrrigationNetMm: 0,
    estimatedIrrigationLiters: 0,
    estimatedIrrigationNetMm: 0,
    totalWaterMm: null,
    ...overrides(index),
  }));
}

function buildWater(overrides: Partial<WaterEnvironment> = {}): WaterEnvironment {
  return {
    available: true,
    observedAt: null,
    areaM2: 7000,
    irrigationEfficiencyPct: 80,
    rainTodayMm: 0,
    rainSource: 'weather_service',
    irrigationTodayLiters: 0,
    irrigationTodayNetMm: 0,
    waterNeededTodayMm: 2.2,
    balanceTodayMm: -2.2,
    next24hRainMm: 0,
    action: {
      code: 'irrigate_today',
      source: 'heuristic',
      reasonCode: 'demand_exceeds_supply',
      reasoning: null,
      recommendationDate: '2026-09-18',
    },
    todayDate: TODAY,
    daily: week(() => ({})),
    sensorHealth: {
      sensorCount: 0,
      freshSensorCount: 0,
      staleSensorCount: 0,
      rainGaugePresent: false,
      flowMeterPresent: false,
      warnings: [],
    },
    ...overrides,
  };
}

function withI18n(node: React.ReactNode) {
  return render(<I18nextProvider i18n={buildTestI18n()}>{node}</I18nextProvider>);
}

function renderTab(water: WaterEnvironment) {
  return withI18n(<WaterTab water={water} />);
}

function tooltipFor(row: WaterChartRow, water: WaterEnvironment, isToday = false, series?: WaterChartSeries) {
  return withI18n(<WaterDayTooltip row={row} label={row.date} water={water} isToday={isToday} series={series} />);
}

/** Six calculated past days and today's forecast. */
function demandWeek(extra: (index: number) => Partial<WaterDay> = () => ({})): WaterDay[] {
  return week((index) => ({
    ...(index === 6 ? { demandMm: 4.1, demandSource: 'forecast', kcSource: 'local' } : { demandMm: 4.8, demandSource: 'calculated' }),
    ...extra(index),
  }));
}

// The chart needs a measured box to draw. A fresh rect per call: recharts' Legend writes
// `offsetWidth` (0 in jsdom) into the object it gets back, so a shared object would shrink
// the ResponsiveContainer to 0 x 0 on its next read.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    width: 640, height: 288, top: 0, left: 0, right: 640, bottom: 288, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('WaterTab 7-day trend', () => {
  it('hides the plot and its heading for a zone with no rain gauge and no flow meter', () => {
    renderTab(buildWater());

    expect(screen.queryByText(TREND_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByTestId('water-trend-chart')).not.toBeInTheDocument();
  });

  it('keeps the verdict sentence and the next-24-h rain when the plot is hidden', () => {
    renderTab(buildWater());

    expect(screen.queryByText(DEMAND_EXCEEDS_SUPPLY)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'About the last 7 days' }));
    expect(screen.getByText(DEMAND_EXCEEDS_SUPPLY)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`${NEXT_RAIN_LABEL}: 0\\.0 mm`))).toBeInTheDocument();
  });

  it('shows the plot for a gauge zone in a dry week: a measured zero is a value', () => {
    const base = buildWater();
    renderTab({
      ...base,
      daily: week(() => ({ rainMm: 0, totalWaterMm: 0 })),
      sensorHealth: { ...base.sensorHealth, rainGaugePresent: true },
    });

    expect(screen.getByText(TREND_TITLE)).toBeInTheDocument();
    expect(screen.getByTestId('water-trend-chart')).toBeInTheDocument();
  });

  it('does not take a rain value for a measurement when the zone has no gauge', () => {
    renderTab(buildWater({ daily: week(() => ({ rainMm: 1.5 })) }));

    expect(screen.queryByTestId('water-trend-chart')).not.toBeInTheDocument();
  });

  it('shows the plot for a flow-meter zone that did not irrigate this week', () => {
    const base = buildWater();
    renderTab({ ...base, sensorHealth: { ...base.sensorHealth, flowMeterPresent: true } });

    expect(screen.getByTestId('water-trend-chart')).toBeInTheDocument();
  });

  it('shows the plot when a day carries irrigation even though no meter is configured now', () => {
    renderTab(buildWater({
      daily: week((index) => (index === 3 ? { estimatedIrrigationLiters: 4200, estimatedIrrigationNetMm: 0.48 } : {})),
    }));

    expect(screen.getByTestId('water-trend-chart')).toBeInTheDocument();
  });

  it('hides the plot when irrigation exists but area and efficiency are not set: no bar could be drawn', () => {
    renderTab(buildWater({
      areaM2: null,
      irrigationEfficiencyPct: null,
      // The irrigation bars themselves are gated on the setup, whatever the day rows carry.
      daily: week((index) => (index === 3 ? { estimatedIrrigationLiters: 4200, estimatedIrrigationNetMm: 0.48 } : {})),
    }));

    expect(screen.queryByTestId('water-trend-chart')).not.toBeInTheDocument();
  });
});

/**
 * A zone without a gauge can carry rain measured at the nearest MeteoSwiss station. It is a
 * measurement, so it may be plotted; it is not the zone's own, so the station and its
 * distance are named in the rain tile's tooltip, and the licence (CC BY) credit sits in the
 * day tooltip.
 */
describe('WaterTab rain from a MeteoSwiss station', () => {
  const payerne = { id: 'PAY', name: 'Payerne', distanceKm: 1.2, network: 'ogd-smn' };
  const RAIN_HELP = 'Where this rain value comes from';

  function stationWater(overrides: Partial<WaterEnvironment> = {}): WaterEnvironment {
    return buildWater({
      rainTodayMm: 0,
      rainSource: 'meteoswiss_station',
      rainStation: payerne,
      dailyRainSource: 'meteoswiss_station',
      daily: week((index) => (index === 1 ? { rainMm: 1.2 } : index === 4 ? { rainMm: 0.3 } : index === 5 ? {} : { rainMm: 0 })),
      ...overrides,
    });
  }

  it('is titled "Last 7 days": it looks back, it does not forecast', () => {
    renderTab(stationWater());

    expect(TREND_TITLE).toBe('Last 7 days');
    expect(screen.getByText('Last 7 days')).toBeInTheDocument();
  });

  it('plots the station rain and credits MeteoSwiss in the day tooltip, not under the plot', () => {
    const w = stationWater();
    const { unmount } = renderTab(w);

    expect(screen.getByText(TREND_TITLE)).toBeInTheDocument();
    expect(screen.getByTestId('water-trend-chart')).toBeInTheDocument();
    expect(screen.queryByTestId('water-trend-station-credit')).not.toBeInTheDocument();
    expect(screen.queryByText('Source: MeteoSwiss')).not.toBeInTheDocument();
    unmount();

    tooltipFor(buildWaterChartRows(w)[1], w);
    expect(screen.getByText('Source: MeteoSwiss')).toBeInTheDocument();
  });

  it('does not credit MeteoSwiss in the tooltip of a plot that draws the zone\'s own gauge', () => {
    const base = buildWater();
    const w: WaterEnvironment = {
      ...base,
      dailyRainSource: 'gauge',
      rainSource: 'gauge',
      rainStation: null,
      daily: week(() => ({ rainMm: 0 })),
      sensorHealth: { ...base.sensorHealth, rainGaugePresent: true },
    };
    const { unmount } = renderTab(w);

    expect(screen.getByTestId('water-trend-chart')).toBeInTheDocument();
    unmount();
    tooltipFor(buildWaterChartRows(w)[2], w);
    expect(screen.queryByText(/Source: MeteoSwiss/)).not.toBeInTheDocument();
  });

  it('shows today\'s rain tile with the station behind it', () => {
    renderTab(stationWater());

    expect(screen.getByText(enDevices.environment.water.rainToday)).toBeInTheDocument();
    expect(screen.queryByText('Measured at MeteoSwiss Payerne (1.2 km away)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: RAIN_HELP }));
    expect(screen.getByText('Measured at MeteoSwiss Payerne (1.2 km away)')).toBeInTheDocument();
  });

  it('labels modelled rain on the tile and never credits a station for it', () => {
    renderTab(buildWater({ rainTodayMm: 3.2, rainSource: 'weather_service' }));

    fireEvent.click(screen.getByRole('button', { name: RAIN_HELP }));
    expect(screen.getByText(enDevices.zone.water.rainFromWeather)).toBeInTheDocument();
    expect(screen.queryByText(/Source: MeteoSwiss/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('water-trend-station-credit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('water-trend-chart')).not.toBeInTheDocument();
  });

  it('keeps the plot hidden when the station has no value in the window', () => {
    renderTab(stationWater({ daily: week(() => ({})) }));

    expect(screen.queryByTestId('water-trend-chart')).not.toBeInTheDocument();
    expect(screen.queryByTestId('water-trend-station-credit')).not.toBeInTheDocument();
    expect(screen.queryByText(/Source: MeteoSwiss/)).not.toBeInTheDocument();
  });

  it('falls back to the station id when the list carried no name', () => {
    renderTab(stationWater({ rainStation: { ...payerne, name: null } }));

    fireEvent.click(screen.getByRole('button', { name: RAIN_HELP }));
    expect(screen.getByText('Measured at MeteoSwiss PAY (1.2 km away)')).toBeInTheDocument();
  });
});

describe('WaterTab per-day crop demand', () => {
  it("draws six calculated ticks and today's forecast tick dashed", () => {
    const { container } = renderTab(buildWater({ daily: demandWeek() }));

    expect(container.querySelectorAll('[data-testid="demand-tick"]')).toHaveLength(6);
    const forecast = container.querySelectorAll('[data-testid="demand-tick-forecast"]');
    expect(forecast).toHaveLength(1);
    expect(forecast[0]).toHaveAttribute('stroke-dasharray', '5 3');
  });

  it('labels today on the x axis "Today"', () => {
    const { container } = renderTab(buildWater({ daily: demandWeek() }));

    // The spied box makes every label measure 640 px, so recharts' default interval
    // ('preserveEnd') keeps only the last tick: today's.
    const ticks = Array.from(container.querySelectorAll('.recharts-xAxis .recharts-cartesian-axis-tick-value')).map((node) => node.textContent);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[ticks.length - 1]).toBe('Today');
    expect(ticks.filter((text) => text === 'Today')).toHaveLength(1);
  });

  it('marks a past day without demand with a grey dash on the baseline', () => {
    const { container } = renderTab(buildWater({
      daily: demandWeek((index) => (index === 2 ? { demandMm: null, demandSource: null, nullReason: 'partial_day' } : {})),
    }));

    expect(container.querySelectorAll('[data-testid="demand-tick"]')).toHaveLength(5);
    expect(container.querySelectorAll('[data-testid="demand-tick-missing"]')).toHaveLength(1);
  });

  it('draws the plot for a zone with neither gauge nor meter once a day carries demand', () => {
    renderTab(buildWater({ areaM2: null, irrigationEfficiencyPct: null, daily: demandWeek() }));

    expect(screen.getByText(TREND_TITLE)).toBeInTheDocument();
    expect(screen.getByTestId('water-trend-chart')).toBeInTheDocument();
  });

  it('lists calculated demand and today\'s forecast in the legend', () => {
    renderTab(buildWater({ daily: demandWeek() }));

    expect(screen.getByText('Crop demand (calculated)')).toBeInTheDocument();
    expect(screen.getByText('Crop demand today (forecast)')).toBeInTheDocument();
  });

  it('DemandTick draws a dashed grey line on the baseline for a day without demand', () => {
    const { container } = render(
      <svg>
        {DemandTick({ x: 10, y: 50, width: 40, height: 100, payload: { demandMm: null } as WaterChartRow })}
      </svg>,
    );

    const line = container.querySelector('[data-testid="demand-tick-missing"]');
    expect(line).not.toBeNull();
    expect(line).toHaveAttribute('y1', '150');
    expect(line).toHaveAttribute('y2', '150');
    expect(line).toHaveAttribute('stroke', 'var(--text-tertiary)');
    expect(line).toHaveAttribute('stroke-dasharray', '3 2');
  });

  it('shows a calculated station day with its demand, station and Kc in the tooltip', () => {
    const w = buildWater({
      daily: demandWeek((index) => (index === 3 ? {
        demandMm: 4.8,
        demandSource: 'calculated',
        et0Mm: 4,
        et0Source: 'station_fao56',
        et0Tier: 'station_fao56',
        et0StationId: 'STATION-S2120-1',
        et0StationName: 'demo-s2120',
        kc: 1.2,
        kcSource: 'fao56_crop',
        cropType: 'maize',
        phenologicalStage: 'mid_season',
      } : {})),
    });
    tooltipFor(buildWaterChartRows(w)[3], w);

    expect(screen.getByText('Crop demand: 4.8 mm (calculated)')).toBeInTheDocument();
    expect(screen.getByText('Station demo-s2120 · FAO-56 · ET0 4.0 mm · Kc 1.20 (Maize (grain), Mid-season)')).toBeInTheDocument();
    expect(screen.queryByText(/so far/)).not.toBeInTheDocument();
  });

  it("shows today's demand as the forecast for the whole day", () => {
    const w = buildWater({ daily: demandWeek() });
    tooltipFor(buildWaterChartRows(w)[6], w, true);

    expect(screen.getByText('Crop demand: 4.1 mm (forecast)')).toBeInTheDocument();
    expect(screen.getByText('Rain and irrigation so far; demand is the forecast for the whole day')).toBeInTheDocument();
  });

  it('says a day still being collected is pending', () => {
    const w = buildWater({ daily: demandWeek((index) => (index === 5 ? { demandMm: null, demandSource: null, nullReason: 'pending' } : {})) });
    tooltipFor(buildWaterChartRows(w)[5], w);

    expect(screen.getByText('Crop demand: pending')).toBeInTheDocument();
  });

  it('says a zone without a location has no demand data', () => {
    const w = buildWater({ daily: demandWeek((index) => (index === 1 ? { demandMm: null, demandSource: null, nullReason: 'no_location' } : {})) });
    tooltipFor(buildWaterChartRows(w)[1], w);

    expect(screen.getByText('Crop demand: no data (zone has no location)')).toBeInTheDocument();
  });

  it('says an incomplete weather record gives no data', () => {
    const w = buildWater({ daily: demandWeek((index) => (index === 1 ? { demandMm: null, demandSource: null, nullReason: 'partial_day' } : {})) });
    tooltipFor(buildWaterChartRows(w)[1], w);

    expect(screen.getByText('Crop demand: no data (weather record incomplete)')).toBeInTheDocument();
  });

  it('credits Open-Meteo in the tooltip of a day whose ET0 came from Open-Meteo', () => {
    const w = buildWater({
      daily: demandWeek((index) => (index === 4 ? {
        et0Source: 'open_meteo_hourly_sum', et0Tier: 'provider_hourly_sum', kc: 0.75, kcSource: 'heuristic_phenology', phenologicalStage: null,
      } : {})),
    });
    tooltipFor(buildWaterChartRows(w)[4], w);

    expect(screen.getByText('Open-Meteo model · Kc 0.75 (no crop from the FAO-56 list, stage not set)')).toBeInTheDocument();
    expect(screen.getByText('Weather data by Open-Meteo.com, CC BY 4.0')).toBeInTheDocument();
  });

  it('names the MeteoSwiss station behind a provider day and credits MeteoSwiss', () => {
    const w = buildWater({
      daily: demandWeek((index) => (index === 4 ? {
        et0Source: 'meteoswiss_hourly_sum', et0Tier: 'provider_hourly_sum', et0StationId: 'PAY', et0StationName: 'PAY',
        kc: 0.75, kcSource: 'fao56_crop_stage_unset', cropType: 'maize',
      } : {})),
    });
    tooltipFor(buildWaterChartRows(w)[4], w);

    expect(screen.getByText('MeteoSwiss PAY · Kc 0.75 (Maize (grain), stage not set)')).toBeInTheDocument();
    expect(screen.getByText('Source: MeteoSwiss')).toBeInTheDocument();
  });

  it('carries no title attribute anywhere: every explanation is a tooltip', () => {
    const { container } = renderTab(buildWater({
      rainSource: 'meteoswiss_station',
      rainStation: { id: 'PAY', name: 'Payerne', distanceKm: 1.2, network: 'ogd-smn' },
      dailyRainSource: 'meteoswiss_station',
      areaM2: null,
      daily: demandWeek((index) => ({ rainMm: index === 2 ? 1.2 : 0 })),
    }));

    expect(screen.getByTestId('water-trend-chart')).toBeInTheDocument();
    expect(container.querySelectorAll('[title]')).toHaveLength(0);
  });
});

describe('WaterTab final fix wave: render rule, tooltip lines, reasons, sources', () => {
  it("does not draw the plot on today's forecast alone; a calculated day draws it", () => {
    const todayOnly = week((index) => (index === 6 ? { demandMm: 4.1, demandSource: 'forecast', kcSource: 'local' } : {}));
    const { unmount } = renderTab(buildWater({ areaM2: null, irrigationEfficiencyPct: null, daily: todayOnly }));
    expect(screen.queryByTestId('water-trend-chart')).not.toBeInTheDocument();
    unmount();
    renderTab(buildWater({ areaM2: null, irrigationEfficiencyPct: null, daily: week((index) => (index === 6 ? { demandMm: 4.1, demandSource: 'forecast' } : index === 5 ? { demandMm: 3.9, demandSource: 'calculated' } : {})) }));
    expect(screen.getByTestId('water-trend-chart')).toBeInTheDocument();
  });

  it('draws the dashed boundary before today', () => {
    const { container } = renderTab(buildWater({ daily: demandWeek() }));
    expect(container.querySelector('.recharts-reference-line')).not.toBeNull();
  });

  it('shows a negative daily value as it is, while the tick draws at 0', () => {
    const w = buildWater({ daily: demandWeek((index) => (index === 2 ? { demandMm: -0.2, demandSource: 'calculated' } : {})) });
    const row = buildWaterChartRows(w)[2];
    expect(row.demandDrawMm).toBe(0);
    tooltipFor(row, w);
    expect(screen.getByText('Crop demand: -0.2 mm (calculated)')).toBeInTheDocument();
  });

  it('shows only the supply lines of the series the plot draws', () => {
    const w = buildWater({ daily: demandWeek() });
    const row = buildWaterChartRows(w)[3];
    tooltipFor(row, w, false, { rain: false, measuredIrrigation: false, estimatedIrrigation: true, demand: true });
    expect(screen.queryByText(/^Rain:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Measured \(flow meter\):/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Measured effective:/)).not.toBeInTheDocument();
    expect(screen.getByText(/^Estimated \(valve time × calibration\):/)).toBeInTheDocument();
    cleanup();
    tooltipFor(row, w, false, { rain: true, measuredIrrigation: true, estimatedIrrigation: false, demand: true });
    expect(screen.getByText(/^Rain:/)).toBeInTheDocument();
    expect(screen.getByText(/^Measured \(flow meter\):/)).toBeInTheDocument();
    expect(screen.queryByText(/^Estimated \(valve time × calibration\):/)).not.toBeInTheDocument();
  });

  it("names the crop, Kc and ET0 in today's source line", () => {
    const w = buildWater({
      daily: demandWeek((index) => (index === 6 ? { et0Mm: 3.42, kc: 1.2, kcSource: 'fao56_crop', cropType: 'maize', phenologicalStage: 'mid_season' } : {})),
    });
    tooltipFor(buildWaterChartRows(w)[6], w, true);
    expect(screen.getByText('Weather forecast · ET0 3.4 mm · Kc 1.20 (Maize (grain), Mid-season)')).toBeInTheDocument();
  });

  it("names the crop beside a demand the cloud computed for today", () => {
    const w = buildWater({ daily: demandWeek((index) => (index === 6 ? { kcSource: 'server', cropType: 'maize' } : {})) });
    tooltipFor(buildWaterChartRows(w)[6], w, true);
    expect(screen.getByText('Weather forecast · OSI Cloud, Maize (grain)')).toBeInTheDocument();
  });

  it('says a day without a row or without a source has no weather source', () => {
    const w = buildWater({
      daily: demandWeek((index) => (index === 1 ? { demandMm: null, demandSource: null, nullReason: 'no_source' } : index === 2 ? { demandMm: null, demandSource: null, nullReason: null } : {})),
    });
    tooltipFor(buildWaterChartRows(w)[1], w);
    expect(screen.getByText('Crop demand: no weather source for this day')).toBeInTheDocument();
    cleanup();
    tooltipFor(buildWaterChartRows(w)[2], w);
    expect(screen.getByText('Crop demand: no weather source for this day')).toBeInTheDocument();
  });

  it('names the MeteoSwiss station reasons and a today without a demand estimate', () => {
    const w = buildWater({
      daily: demandWeek((index) => (index === 1 ? { demandMm: null, demandSource: null, nullReason: 'mixed_station' }
        : index === 2 ? { demandMm: null, demandSource: null, nullReason: 'unknown_station' }
          : index === 6 ? { demandMm: null, demandSource: null, nullReason: 'demand_unknown' } : {})),
    });
    const rows = buildWaterChartRows(w);
    tooltipFor(rows[1], w);
    expect(screen.getByText('Crop demand: hours from two MeteoSwiss stations')).toBeInTheDocument();
    cleanup();
    tooltipFor(rows[2], w);
    expect(screen.getByText('Crop demand: MeteoSwiss station unknown for these hours')).toBeInTheDocument();
    cleanup();
    tooltipFor(rows[6], w, true);
    expect(screen.getByText('Crop demand: no estimate for today')).toBeInTheDocument();
  });
});

describe('WaterTab contract v2 lines', () => {
  it('names a day on the FAO-56 curve and flags a stage past its typical length', () => {
    const w = buildWater({
      daily: demandWeek((index) => (index === 3 ? {
        demandMm: 3.1, demandSource: 'calculated', et0Mm: 4, et0Source: 'open_meteo_hourly_sum', et0Tier: 'provider_hourly_sum',
        kc: 0.77, kcSource: 'fao56_curve', cropType: 'maize', phenologicalStage: 'development', stageOverrun: true,
      } : {})),
    });
    tooltipFor(buildWaterChartRows(w)[3], w);
    expect(screen.getByText('Open-Meteo model · ET0 4.0 mm · Kc 0.77 (Maize (grain), Crop development (FAO-56 curve))')).toBeInTheDocument();
    expect(screen.getByText("Past this stage's typical length (40 days, FAO-56 Table 11): the stage may be out of date; choose the next stage when the crop reaches it.")).toBeInTheDocument();
  });

  it('says nothing about an overrun when the crop has no typical length for the stage', () => {
    const w = buildWater({
      daily: demandWeek((index) => (index === 3 ? {
        demandMm: 3.1, demandSource: 'calculated', kc: 1, kcSource: 'fao56_crop', cropType: 'grass', phenologicalStage: 'late_season', stageOverrun: true,
      } : {})),
    });
    tooltipFor(buildWaterChartRows(w)[3], w);
    expect(screen.queryByText(/Past this stage's typical length/)).not.toBeInTheDocument();
  });

  it('marks a shared-mode day OSI Cloud computed from model ET0, with the accuracy note', () => {
    const w = buildWater({
      daily: demandWeek((index) => (index === 2 ? {
        demandMm: 2.2, demandSource: 'calculated', demandComputedBy: 'cloud', et0Mm: 3.1, et0Source: 'provider_native', et0Tier: 'open_meteo_daily',
        kc: 0.71, kcSource: 'fao56_crop', cropType: 'maize', phenologicalStage: 'development',
      } : {})),
    });
    tooltipFor(buildWaterChartRows(w)[2], w);
    expect(screen.getByText(/^Open-Meteo weather model, daily FAO-56 · ET0 3\.1 mm/)).toBeInTheDocument();
    expect(screen.getByText('ET0 from the Open-Meteo weather model (not measured at this farm); OSI Cloud applies the crop coefficient')).toBeInTheDocument();
    expect(screen.getByText(/Model-based ET0 can differ from a local station by 10-20 % on a single day/)).toBeInTheDocument();
    expect(screen.getByText('Weather data by Open-Meteo.com, CC BY 4.0')).toBeInTheDocument();
  });

  it('shows neither cloud line on a day the gateway computed', () => {
    const w = buildWater({ daily: demandWeek((index) => (index === 2 ? { demandComputedBy: 'edge', kc: 1.2, kcSource: 'fao56_crop', cropType: 'maize', phenologicalStage: 'mid_season' } : {})) });
    tooltipFor(buildWaterChartRows(w)[2], w);
    expect(screen.queryByText(/OSI Cloud applies the crop coefficient/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Model-based ET0/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Past this stage's typical length/)).not.toBeInTheDocument();
  });
});
