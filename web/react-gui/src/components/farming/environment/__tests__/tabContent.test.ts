// Content-availability rules behind the Environment card's default tab (#310):
// a source flag or a non-null but all-null section is not "data", a finite
// measured zero is, and timestamps or hour counts are metadata, not
// conditions. Pure-function tests only; the card behaviour they drive is
// covered in src/components/farming/__tests__/EnvironmentCardDefaultTab.test.tsx.
import { describe, expect, it } from 'vitest';
import {
  hasUsableAgronomicContent,
  hasUsableCurrentConditions,
  hasUsableForecastContent,
  hasUsableSensorsContent,
  hasUsableSoilContent,
  hasUsableWaterContent,
  preferredEnvironmentTab,
} from '../tabContent';
import type {
  AgronomicEnvironment,
  Device,
  ForecastEnvironment,
  LocalEnvironment,
  OnlineEnvironment,
  OnlineWeather,
  WaterEnvironment,
  ZoneEnvironmentSummary,
} from '../../../../types/farming';

const noOnline: OnlineEnvironment = {
  available: false, source: 'unavailable', cacheStatus: 'miss', observedAt: null, expiresAt: null, current: null,
};

const noForecast: ForecastEnvironment = {
  available: false, source: 'unavailable', cacheStatus: 'miss', observedAt: null, expiresAt: null, rainFocus: null,
};

function onlineWith(current: Partial<OnlineWeather> | null): OnlineEnvironment {
  return {
    ...noOnline,
    available: true,
    source: 'open_meteo',
    cacheStatus: 'live',
    current: current as OnlineWeather | null,
  };
}

function forecastWith(rainFocus: Partial<ForecastEnvironment['rainFocus']> | null): ForecastEnvironment {
  return {
    ...noForecast,
    available: true,
    source: 'open_meteo',
    cacheStatus: 'live',
    rainFocus: rainFocus == null
      ? null
      : {
        totalNext24hMm: null,
        totalNext72hMm: null,
        maxHourlyRainMm: 0,
        maxHourlyRainAt: null,
        nextRainEta: null,
        rainHoursNext24h: 0,
        daily: [],
        hourly: [],
        ...rainFocus,
      },
  };
}

const emptyWater: WaterEnvironment = {
  available: true,
  observedAt: null,
  areaM2: null,
  irrigationEfficiencyPct: null,
  rainTodayMm: null,
  irrigationTodayLiters: null,
  irrigationTodayNetMm: null,
  irrigationTodayMeasuredLiters: 0,
  irrigationTodayEstimatedLiters: 0,
  measuredIrrigationNetMm: null,
  estimatedIrrigationNetMm: null,
  waterNeededTodayMm: null,
  balanceTodayMm: null,
  next24hRainMm: null,
  action: null,
  daily: [],
  sensorHealth: { sensorCount: 0, freshSensorCount: 0, staleSensorCount: 0, rainGaugePresent: true, flowMeterPresent: false, warnings: [] },
};

const emptyLocal: LocalEnvironment = {
  available: false, observedAt: null, sensorCount: 0, freshSensorCount: 0, staleSensorCount: 0, metrics: [], devices: [],
};

const emptyAgronomic: AgronomicEnvironment = { preferredSource: 'local', current: null };

const noDevices: Device[] = [];

function summaryWith(overrides: {
  online?: OnlineEnvironment;
  forecast?: ForecastEnvironment;
  water?: WaterEnvironment;
  local?: LocalEnvironment;
  agronomic?: AgronomicEnvironment;
  devices?: Device[];
} = {}): { summary: ZoneEnvironmentSummary; devices: Device[] } {
  const { devices = noDevices, ...sections } = overrides;
  return {
    summary: {
      zoneId: 12,
      zoneName: 'Zone B',
      generatedAt: '2026-10-30T10:00:00.000Z',
      location: { latitude: 47.3769, longitude: 8.5417, timezone: 'Europe/Zurich', source: 'zone' },
      water: emptyWater,
      local: emptyLocal,
      online: noOnline,
      agronomic: emptyAgronomic,
      forecast: noForecast,
      display: null,
      drift: null,
      ...sections,
    },
    devices,
  };
}

describe('hasUsableCurrentConditions', () => {
  it('rejects an availability flag around a non-null but empty current object', () => {
    expect(hasUsableCurrentConditions(onlineWith({}))).toBe(false);
  });

  it('rejects values the Weather tab never renders (pressure, cloud cover)', () => {
    expect(hasUsableCurrentConditions(onlineWith({ pressureHpa: 1013, cloudCoverPct: 40, rainMm: null }))).toBe(false);
  });

  it('accepts a description or a weather code alone: both render', () => {
    expect(hasUsableCurrentConditions(onlineWith({ description: 'partly cloudy' }))).toBe(true);
    expect(hasUsableCurrentConditions(onlineWith({ weatherCode: 2 }))).toBe(true);
  });

  it('accepts a finite measured zero temperature', () => {
    expect(hasUsableCurrentConditions(onlineWith({ airTemperatureC: 0 }))).toBe(true);
  });

  it('rejects an unavailable section regardless of payload', () => {
    expect(hasUsableCurrentConditions(noOnline)).toBe(false);
  });
});

describe('hasUsableForecastContent', () => {
  it('rejects an availability flag with no rain focus at all', () => {
    expect(hasUsableForecastContent(forecastWith(null))).toBe(false);
  });

  it('rejects timestamps and hour counts as content', () => {
    expect(hasUsableForecastContent(forecastWith({
      nextRainEta: '2026-10-30T14:00:00Z',
      maxHourlyRainAt: '2026-10-30T14:00:00Z',
      rainHoursNext24h: 3,
      next24hCoverage: { coveredHours: 24, expectedHours: 24 },
    }))).toBe(false);
  });

  it('rejects daily and hourly entries that carry only their timestamps', () => {
    expect(hasUsableForecastContent(forecastWith({
      daily: [{ date: '2026-10-30', description: null, weatherCode: null, maxTempC: null, minTempC: null, rainMm: null, rainProbabilityPct: null, windSpeedMps: null, et0MmDay: null, etcMmDay: null }],
      hourly: [{ time: '2026-10-30T14:00', rainMm: null, rainProbabilityPct: null, tempC: null, windSpeedMps: null }],
    }))).toBe(false);
  });

  it('accepts finite zero totals: a forecast dry period is data', () => {
    expect(hasUsableForecastContent(forecastWith({ totalNext24hMm: 0, totalNext72hMm: 0 }))).toBe(true);
  });

  it('accepts a daily card by weather code and an hourly point by probability', () => {
    expect(hasUsableForecastContent(forecastWith({
      daily: [{ date: '2026-10-30', description: null, weatherCode: 3, maxTempC: null, minTempC: null, rainMm: null, rainProbabilityPct: null, windSpeedMps: null, et0MmDay: null, etcMmDay: null }],
    }))).toBe(true);
    expect(hasUsableForecastContent(forecastWith({
      hourly: [{ time: new Date(Date.now() + 60 * 60 * 1000).toISOString(), rainMm: null, rainProbabilityPct: 0, tempC: null, windSpeedMps: null }],
    }))).toBe(true);
  });

  it('rejects hourly-only values outside the chart horizon or without a valid time', () => {
    for (const time of ['invalid', new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()]) {
      expect(hasUsableForecastContent(forecastWith({
        hourly: [{ time, rainMm: 1, rainProbabilityPct: null, tempC: null, windSpeedMps: null }],
      }))).toBe(false);
    }
  });
});

describe('hasUsableWaterContent', () => {
  it('rejects an availability flag around all-null fields (litre defaults are zero, not data)', () => {
    expect(hasUsableWaterContent(emptyWater)).toBe(false);
  });

  it('accepts a measured zero in a null-when-unknown field', () => {
    expect(hasUsableWaterContent({ ...emptyWater, rainTodayMm: 0 })).toBe(true);
  });

  it('accepts a computed balance or a forecast total', () => {
    expect(hasUsableWaterContent({ ...emptyWater, balanceTodayMm: -1.5 })).toBe(true);
    expect(hasUsableWaterContent({ ...emptyWater, next24hRainMm: 0 })).toBe(true);
  });

  it('counts irrigation only when a configured source makes its tile visible', () => {
    expect(hasUsableWaterContent({ ...emptyWater, irrigationTodayMeasuredLiters: 0, measuredIrrigationNetMm: 0 })).toBe(false);
    expect(hasUsableWaterContent({ ...emptyWater, irrigationTodayEstimatedLiters: 12.5 })).toBe(false);
    expect(hasUsableWaterContent({ ...emptyWater, irrigationTodayEstimatedLiters: 12.5 }, [{ type_id: 'STREGA_VALVE' } as Device])).toBe(true);
    expect(hasUsableWaterContent(emptyWater, [{ flow_meter_enabled: 1 } as Device])).toBe(true);
  });

  it('counts source-supported historical rain, including measured zero', () => {
    expect(hasUsableWaterContent({ ...emptyWater, daily: [
      { date: '2026-10-24', rainMm: null, irrigationLiters: null, irrigationNetMm: null, totalWaterMm: null, demandMm: 0, demandSource: 'calculated' },
    ] })).toBe(true);
    expect(hasUsableWaterContent({ ...emptyWater, daily: [
      { date: '2026-10-24', rainMm: 0, irrigationLiters: null, irrigationNetMm: null, totalWaterMm: null, demandMm: null },
    ] })).toBe(true);
    expect(hasUsableWaterContent({ ...emptyWater, daily: [
      { date: '2026-10-24', rainMm: 4.2, irrigationLiters: null, irrigationNetMm: null, totalWaterMm: null, demandMm: null },
    ] })).toBe(true);
  });

  it('rejects unavailable Water and historical fields without a rendered series', () => {
    const daily = [{ date: '2026-10-24', rainMm: 0, irrigationLiters: null, irrigationNetMm: null, totalWaterMm: null }];
    expect(hasUsableWaterContent({ ...emptyWater, available: false, daily })).toBe(false);
    expect(hasUsableWaterContent({ ...emptyWater, sensorHealth: { ...emptyWater.sensorHealth, rainGaugePresent: false }, daily })).toBe(false);
    expect(hasUsableWaterContent({ ...emptyWater, daily: [{ ...daily[0], rainMm: null, rainReceivedMm: 2, et0Mm: 3 }] })).toBe(false);
    expect(hasUsableWaterContent({ ...emptyWater, daily: [{ ...daily[0], rainMm: null, demandMm: 3, demandSource: 'forecast' }] })).toBe(false);
    expect(hasUsableWaterContent({ ...emptyWater, daily: [{ ...daily[0], rainMm: null, measuredIrrigationNetMm: 3 }] })).toBe(false);
    expect(hasUsableWaterContent({ ...emptyWater, areaM2: 100, irrigationEfficiencyPct: 80, daily: [{ ...daily[0], rainMm: null, measuredIrrigationNetMm: 3 }] })).toBe(true);
  });
});

describe('hasUsableSoilContent', () => {
  const soilMetric = (key: string) => ({
    key, label: key, unit: '%', mean: 31, median: 31, min: 30, max: 32, sampleCount: 4,
  });

  it('accepts the two soil rollup metrics', () => {
    expect(hasUsableSoilContent({ ...emptyLocal, metrics: [soilMetric('soil_moisture_pct')] }, noDevices)).toBe(true);
    expect(hasUsableSoilContent({ ...emptyLocal, metrics: [soilMetric('soil_temperature_c')] }, noDevices)).toBe(true);
    expect(hasUsableSoilContent({ ...emptyLocal, metrics: [soilMetric('air_temperature_c')] }, noDevices)).toBe(false);
  });

  it('accepts SWT readings from the zone\'s devices', () => {
    const device = { latest_data: { swt_1: 25 } } as Device;
    expect(hasUsableSoilContent(emptyLocal, [device])).toBe(true);
  });
});

describe('hasUsableSensorsContent', () => {
  it('mirrors the Sensors tab gate: available plus at least one metric', () => {
    const metric = { key: 'air_temperature_c', label: 'Air temperature', unit: '°C', mean: 20, median: 20, min: 19, max: 21, sampleCount: 2 };
    expect(hasUsableSensorsContent({ ...emptyLocal, available: true, metrics: [metric] })).toBe(true);
    expect(hasUsableSensorsContent({ ...emptyLocal, available: false, metrics: [metric] })).toBe(false);
    expect(hasUsableSensorsContent({ ...emptyLocal, available: true, metrics: [] })).toBe(false);
  });
});

describe('hasUsableAgronomicContent', () => {
  it('rejects a null current and a non-null current of all-null values', () => {
    expect(hasUsableAgronomicContent(emptyAgronomic)).toBe(false);
    expect(hasUsableAgronomicContent({
      preferredSource: 'local',
      current: {
        thermodynamicSource: 'open_meteo', evapotranspirationSource: 'open_meteo', cropCoefficientSource: 'fao56_curve',
        airTemperatureC: null, relativeHumidityPct: null, vpdKpa: null, dewPointC: null, heatIndexC: null,
        thi: null, referenceEt0MmDay: null, cropCoefficientKc: null, etcMmDay: null,
      },
    })).toBe(false);
  });

  it('accepts a finite zero VPD', () => {
    expect(hasUsableAgronomicContent({
      preferredSource: 'local',
      current: {
        thermodynamicSource: 'open_meteo', evapotranspirationSource: 'open_meteo', cropCoefficientSource: 'fao56_curve',
        airTemperatureC: null, relativeHumidityPct: null, vpdKpa: 0, dewPointC: null, heatIndexC: null,
        thi: null, referenceEt0MmDay: null, cropCoefficientKc: null, etcMmDay: null,
      },
    })).toBe(true);
  });
});

describe('preferredEnvironmentTab priority', () => {
  const agronomicCurrent = {
    thermodynamicSource: 'open_meteo', evapotranspirationSource: 'open_meteo', cropCoefficientSource: 'fao56_curve',
    airTemperatureC: null, relativeHumidityPct: null, vpdKpa: 1.1, dewPointC: null, heatIndexC: null,
    thi: null, referenceEt0MmDay: null, cropCoefficientKc: null, etcMmDay: null,
  };
  const sensorMetric = { key: 'air_temperature_c', label: 'Air temperature', unit: '°C', mean: 20, median: 20, min: 19, max: 21, sampleCount: 2 };
  const soilMetric = { ...sensorMetric, key: 'soil_moisture_pct' };

  it('prefers weather whenever current or forecast content exists', () => {
    expect(preferredEnvironmentTab(summaryWith({ online: onlineWith({ airTemperatureC: 21 }) }).summary, noDevices)).toBe('weather');
    expect(preferredEnvironmentTab(summaryWith({ forecast: forecastWith({ totalNext24hMm: 0 }) }).summary, noDevices)).toBe('weather');
  });

  it('falls back water, soil, sensors, agronomy in that order', () => {
    expect(preferredEnvironmentTab(summaryWith().summary, noDevices)).toBe(null);
    expect(preferredEnvironmentTab(summaryWith({ water: { ...emptyWater, waterNeededTodayMm: 2.5 } }).summary, noDevices)).toBe('water');
    expect(preferredEnvironmentTab(summaryWith({ local: { ...emptyLocal, available: true, metrics: [soilMetric, sensorMetric] } }).summary, noDevices)).toBe('soil');
    expect(preferredEnvironmentTab(summaryWith({ local: { ...emptyLocal, available: true, metrics: [sensorMetric] } }).summary, noDevices)).toBe('sensors');
    expect(preferredEnvironmentTab(summaryWith({ agronomic: { preferredSource: 'local', current: agronomicCurrent } }).summary, noDevices)).toBe('agronomic');
  });

  it('lets weather outrank a fully populated water section', () => {
    expect(preferredEnvironmentTab(summaryWith({
      online: onlineWith({ airTemperatureC: 21 }),
      water: { ...emptyWater, waterNeededTodayMm: 2.5 },
    }).summary, noDevices)).toBe('weather');
  });
});
