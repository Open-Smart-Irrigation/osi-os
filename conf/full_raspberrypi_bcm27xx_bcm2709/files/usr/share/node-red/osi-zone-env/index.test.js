'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const ZE = require('./index.js');

const NOW_MS = Date.parse('2026-07-11T10:00:00.000Z');

test('numeric helpers preserve current Zone Env behavior', () => {
  assert.equal(ZE.trimToNull('  apple  '), 'apple');
  assert.equal(ZE.trimToNull('   '), null);
  assert.equal(ZE.normalizeTimezone('Europe/Zurich'), 'Europe/Zurich');
  assert.equal(ZE.normalizeTimezone('Not/AZone'), 'UTC');
  assert.equal(ZE.toFiniteNumber('12.5'), 12.5);
  assert.equal(ZE.toFiniteNumber(''), null);
  assert.equal(ZE.round(12.345, 2), 12.35);
  assert.equal(ZE.mean([1, null, 5, Number.NaN]), 3);
  assert.equal(ZE.median([4, 1, 9, 3]), 3.5);
  assert.equal(ZE.minValue([4, null, 2]), 2);
  assert.equal(ZE.maxValue([4, null, 2]), 4);
});

test('weather math helpers preserve current shipped formulas', () => {
  assert.equal(ZE.computeVPD(30, 50), 2.1215325293795066);
  assert.equal(ZE.computeDewPoint(30, 50), 18.422876054714354);
  assert.equal(ZE.computeHeatIndexC(32, 70), 40.409273679555774);
  assert.equal(ZE.computeTHI(30, 50), 25.737499999999997);
});

test('metric extraction and local environment assembly preserve current shape', () => {
  const rows = [
    {
      type_id: 'SENSECAP_S2120',
      temperature: 24.2,
      humidity: 61,
      pressure: 955,
      rain_mm_delta: 0.8,
      wind_speed: 2.3,
      recorded_at: '2026-07-11T09:50:00.000Z',
    },
    {
      type_id: 'KIWI_SENSOR',
      air_temp: 23.8,
      air_humidity: 63,
      recorded_at: '2026-07-11T09:40:00.000Z',
    },
  ];
  assert.deepEqual(ZE.extractFirstMetric(rows[0], { aliases: ['temperature', 'air_temp'] }), 24.2);
  assert.deepEqual(ZE.extractMetrics(rows[0]), {
    air_temperature_c: 24.2,
    relative_humidity_pct: 61,
    pressure_hpa: 955,
    wind_speed_mps: 2.3,
  });
  assert.deepEqual(ZE.aggregateMetric(
    { key: 'air_temperature_c', label: 'Air Temperature', unit: '°C', decimals: 2 },
    [{ metrics: { air_temperature_c: 24.2 } }, { metrics: { air_temperature_c: 23.8 } }],
  ), {
    key: 'air_temperature_c',
    label: 'Air Temperature',
    unit: '°C',
    mean: 24,
    median: 24,
    min: 23.8,
    max: 24.2,
    sampleCount: 2,
  });

  const local = ZE.buildLocalEnvironment(rows, '2026-07-11T10:00:00.000Z');
  assert.equal(local.available, true);
  assert.equal(local.sensorCount, 1);
  assert.equal(local.metrics[0].key, 'air_temperature_c');
  assert.equal(local.metrics[0].mean, 24.2);
  assert.equal(local.metrics[1].key, 'relative_humidity_pct');
  assert.equal(local.metrics[1].mean, 61);
  assert.equal(local.observedAt, '2026-07-11T09:50:00.000Z');
});

test('configuration, display, and drift helpers preserve current behavior', () => {
  assert.deepEqual(ZE.resolveLocation({
    latitude: 46.8,
    longitude: 8.2,
    timezone: 'Europe/Zurich',
  }), {
    latitude: 46.8,
    longitude: 8.2,
    timezone: 'Europe/Zurich',
    source: 'zone',
  });
  assert.equal(ZE.normalizeCloudServerUrl('server.opensmartirrigation.org'), 'server.opensmartirrigation.org');
  assert.equal(ZE.normalizeSchedulingMode('CLOUD'), 'local');
  assert.equal(ZE.normalizeDisplayMode('shared_server'), 'shared_server');
  assert.equal(ZE.absoluteDelta(10, 13), 3);
  assert.equal(ZE.isIrrigationActionConflict('increase_10', 'delay_irrigation'), true);
  assert.equal(ZE.bundleAgeMinutes('2026-07-11T09:30:00.000Z', '2026-07-11T10:00:00.000Z'), 30);

  assert.deepEqual(
    ZE.buildDisplayStatus('local_fallback', 'local', 'Local fallback', null, '2026-07-11T09:50:00.000Z', null, 'offline'),
    {
      mode: 'local_fallback',
      schedulingMode: 'local',
      sourceLabel: 'Local fallback',
      sharedGeneratedAt: null,
      sharedObservedAt: '2026-07-11T09:50:00.000Z',
      lastReceivedAt: null,
      fallbackReason: 'offline',
    },
  );
  assert.deepEqual(
    ZE.computeRecommendationDrift(
      { id: 7 },
      { action: { code: 'increase_10' }, waterNeededTodayMm: 2, next24hRainMm: 1, balanceTodayMm: -5 },
      { action: { code: 'delay_irrigation' }, waterNeededTodayMm: 5, next24hRainMm: 4, balanceTodayMm: -1 },
      'cloud',
    ),
    {
      active: true,
      severity: 'high',
      reason: 'Local and OSI Server recommendations disagree on whether to irrigate. Estimated water need differs by 3.0 mm. Forecast rain differs by 3.0 mm. Water balance differs by 4.0 mm.',
      localActionCode: 'increase_10',
      serverActionCode: 'delay_irrigation',
      waterNeededDeltaMm: 3,
      next24hRainDeltaMm: 3,
      balanceDeltaMm: 4,
      canSwitchScheduling: false,
    },
  );
});

test('forecast helpers preserve deterministic provider normalization', () => {
  const openAgri = ZE.parseOpenAgriForecast([
    { timestamp: '2026-07-11T12:00:00Z', measurement_type: 'ambient_temperature', value: 28 },
    { timestamp: '2026-07-11T12:00:00Z', measurement_type: 'ambient_humidity', value: 55 },
    { timestamp: '2026-07-11T12:00:00Z', measurement_type: 'rainfall_3h', value: 1.2 },
    { timestamp: '2026-07-11T12:00:00Z', measurement_type: 'precipitation', value: 0.8 },
    { timestamp: '2026-07-11T12:00:00Z', measurement_type: 'wind_speed', value: 3.5 },
  ], { observedAtMs: NOW_MS });
  assert.equal(openAgri.source, 'openagri');
  assert.equal(openAgri.observedAt, '2026-07-11T10:00:00.000Z');
  assert.equal(openAgri.hours[0].precipitationProbabilityPct, 80);

  const merged = ZE.mergeForecasts(openAgri, {
    source: 'open-meteo',
    observedAt: '2026-07-11T09:59:00.000Z',
    hours: [{ time: '2026-07-11T13:00:00.000Z', precipitationProbabilityPct: 50, rainMm: 0.5 }],
    days: [{ date: '2026-07-11', rainMm: 2.1, et0MmDay: 5 }],
  }, { nowMs: NOW_MS });
  assert.equal(merged.source, 'openagri');
  assert.equal(merged.hours.length, 1);
  assert.equal(ZE.normalizePrecipitationProbability(0.72), 72);
  assert.deepEqual(ZE.findMetric({ metrics: [{ key: 'rainMm', mean: 1.2 }] }, 'rainMm'), { key: 'rainMm', mean: 1.2 });
  assert.equal(ZE.deriveCropCoefficient, undefined);
  assert.equal(ZE.estimateStepHours([
    { time: '2026-07-11T12:00:00.000Z' },
    { time: '2026-07-11T18:00:00.000Z' },
  ]), 6);
  assert.equal(ZE.sumRain(merged.hours, NOW_MS, 24), 1.2);
  assert.equal(ZE.localDateIso(null, 'UTC', NOW_MS), '2026-07-11');
  assert.equal(ZE.addUtcDays('2026-07-11', 2), '2026-07-13');

  const section = ZE.buildForecastSection(merged, 'live', '2026-07-11T10:15:00.000Z', { cropType: null, phenologicalStage: 'fruit_maturation' }, '2026-07-11T10:00:00.000Z');
  assert.equal(section.available, true);
  assert.equal(section.cacheStatus, 'live');
  assert.equal(section.rainFocus.totalNext24hMm, 1.2);
  assert.equal(section.rainFocus.daily[0].cropCoefficientKc, 0.9);
});

test('agronomic and water helpers preserve current assembly behavior', () => {
  const local = {
    available: true,
    metrics: [
      { key: 'air_temperature_c', mean: 28 },
      { key: 'relative_humidity_pct', mean: 58 },
    ],
    vpd: { kpa: 1.6 },
  };
  const online = {
    available: true,
    current: { airTemperatureC: 29, relativeHumidityPct: 54, vpdKpa: 1.85 },
  };
  const forecast = {
    available: true,
    cacheStatus: 'live',
    rainFocus: { totalNext24hMm: 4.2, totalNext72hMm: 12.3, daily: [{ date: '2026-07-11', et0MmDay: 5 }] },
  };
  const agronomic = ZE.buildAgronomic(local, online, forecast, { cropType: null, phenologicalStage: 'fruit_maturation', todayIso: '2026-07-11', forecastFetchedAt: null, timezone: 'UTC' });
  assert.equal(agronomic.current.vpdKpa, 1.843);
  assert.equal(agronomic.current.cropCoefficientKc, 0.9);
  assert.equal(agronomic.current.etcMmDay, 4.5);

  assert.equal(ZE.toEffectiveIrrigationMm(100, 50, 75), 1.5);
  assert.deepEqual(ZE.resolveWaterAction('2026-07-11', null, -8, 0), {
    code: 'irrigate_today',
    source: 'heuristic',
    reasonCode: 'demand_exceeds_supply',
    recommendationDate: '2026-07-11',
  });
  assert.deepEqual(
    ZE.mergeDailyIrrigationSplit(
      [{ date: '2026-07-11', rainMm: 1 }],
      [{
        date: '2026-07-11',
        irrigationLiters: 10,
        irrigationNetMm: 1.5,
        measuredIrrigationLiters: 6,
        estimatedIrrigationLiters: 4,
        measuredIrrigationNetMm: 0.9,
        estimatedIrrigationNetMm: 0.6,
        estimatedTotalWaterMm: 2.5,
      }],
    ),
    [{
      date: '2026-07-11',
      rainMm: 1,
      irrigationLiters: 10,
      irrigationNetMm: 1.5,
      measuredIrrigationLiters: 6,
      estimatedIrrigationLiters: 4,
      measuredIrrigationNetMm: 0.9,
      estimatedIrrigationNetMm: 0.6,
      estimatedTotalWaterMm: 2.5,
    }],
  );
  const waterOverlay = ZE.overlayLocalWaterIrrigationSplit(
    { daily: [{ date: '2026-07-11' }], today: { date: '2026-07-11' }, action: { code: 'maintain' } },
    { daily: [{ date: '2026-07-11', irrigationNetMm: 1.5 }], today: { date: '2026-07-11', irrigationNetMm: 1.5 }, action: { code: 'irrigate_today' } },
  );
  assert.equal(waterOverlay.daily[0].irrigationNetMm, 1.5);
  assert.deepEqual(waterOverlay.today, { date: '2026-07-11' });
  assert.deepEqual(waterOverlay.action, { code: 'maintain' });
});

test('sensor health helper preserves counter warning behavior', () => {
  assert.deepEqual(
    ZE.buildSensorHealth([
      { type_id: 'SENSECAP_S2120', rain_gauge_enabled: 1, flow_meter_enabled: 0, recorded_at: '2026-07-11T09:50:00.000Z' },
      { type_id: 'KIWI_SENSOR', recorded_at: '2026-07-10T09:50:00.000Z' },
    ], { sensorCount: 2, freshSensorCount: 1, staleSensorCount: 1 }),
    {
      sensorCount: 2,
      freshSensorCount: 1,
      staleSensorCount: 1,
      rainGaugePresent: true,
      flowMeterPresent: false,
      warnings: ['1 sensor is stale'],
    },
  );
});

test('an unknown water balance yields insufficient data, not "delay irrigation"', () => {
  // The zone a new customer sees first: no area, no irrigation efficiency, so
  // no balance can be computed, and no forecast because the gateway is not
  // linked. Coercing both to 0 made `0 >= |min(0, 0)|` true and returned
  // delay_irrigation unconditionally.
  assert.deepEqual(ZE.resolveWaterAction('2026-07-11', null, null, null), {
    code: null,
    source: 'insufficient_data',
    reasonCode: 'balance_unknown',
    recommendationDate: '2026-07-11',
  });
  assert.deepEqual(ZE.resolveWaterAction('2026-07-11', null, null, 4.2), {
    code: null,
    source: 'insufficient_data',
    reasonCode: 'balance_unknown',
    recommendationDate: '2026-07-11',
  });
});

test('a deficit with no forecast cannot be resolved either way', () => {
  // -3 mm today: whether that deficit needs the valve tonight depends on rain
  // the gateway has no forecast for. Treating the missing forecast as 0 mm is
  // an assertion the edge cannot make.
  assert.deepEqual(ZE.resolveWaterAction('2026-07-11', null, -3, null), {
    code: null,
    source: 'insufficient_data',
    reasonCode: 'forecast_unknown',
    recommendationDate: '2026-07-11',
  });
});

test('known balances keep their shipped verdicts and carry a reason code, not prose', () => {
  assert.deepEqual(ZE.resolveWaterAction('2026-07-11', null, 2.5, null), {
    code: 'delay_irrigation',
    source: 'heuristic',
    reasonCode: 'supply_covers_demand',
    recommendationDate: '2026-07-11',
  });
  assert.deepEqual(ZE.resolveWaterAction('2026-07-11', null, -8, 10), {
    code: 'delay_irrigation',
    source: 'heuristic',
    reasonCode: 'forecast_rain_covers_demand',
    recommendationDate: '2026-07-11',
  });
  // The boundary the branch order turns on: a balance between 0 and 1 mm is
  // settled by the balance alone, so no forecast is consulted and the verdict
  // is the same one the shipped `>= 1 || forecast >= |min(balance, 0)|` guard
  // produced for it. Narrowing this to `>= 1` sends it down the forecast path.
  assert.deepEqual(ZE.resolveWaterAction('2026-07-11', null, 0.5, 0), {
    code: 'delay_irrigation',
    source: 'heuristic',
    reasonCode: 'supply_covers_demand',
    recommendationDate: '2026-07-11',
  });
  assert.deepEqual(ZE.resolveWaterAction('2026-07-11', null, 0.5, null), {
    code: 'delay_irrigation',
    source: 'heuristic',
    reasonCode: 'supply_covers_demand',
    recommendationDate: '2026-07-11',
  });
  assert.deepEqual(ZE.resolveWaterAction('2026-07-11', null, -0.5, 0), {
    code: 'monitor_today',
    source: 'heuristic',
    reasonCode: 'balance_neutral',
    recommendationDate: '2026-07-11',
  });
  // The dendrometer branch keeps the reasoning the analytics run stored.
  assert.deepEqual(
    ZE.resolveWaterAction('2026-07-11', {
      irrigation_action: 'increase_10',
      action_reasoning: 'Stress rose for three consecutive days.',
      date: '2026-07-10',
    }, null, null),
    {
      code: 'increase_10',
      source: 'dendro',
      reasonCode: null,
      reasoning: 'Stress rose for three consecutive days.',
      recommendationDate: '2026-07-10',
    },
  );
});

test('a weather station and a LoRain gauge count as rain sources', () => {
  // rain_gauge_enabled is the opt-in LSN50 MOD9 input. A SenseCAP S2120 and an
  // Aqua-Scope LoRain measure rain without it, and the zone summary reported
  // rainGaugePresent: false for a station that had just delivered a 1.6 mm
  // delta — so any GUI gate built on the flag would hide a real measurement.
  const health = (rows) => ZE.buildSensorHealth(rows, { sensorCount: 1, freshSensorCount: 1, staleSensorCount: 0 });
  assert.equal(health([{ type_id: 'SENSECAP_S2120', rain_gauge_enabled: 0 }]).rainGaugePresent, true);
  assert.equal(health([{ type_id: 'AQUASCOPE_LORAIN', rain_gauge_enabled: 0 }]).rainGaugePresent, true);
  assert.equal(health([{ type_id: 'DRAGINO_LSN50', rain_gauge_enabled: 1 }]).rainGaugePresent, true);
  assert.equal(health([{ type_id: 'DRAGINO_LSN50', rain_gauge_enabled: 0 }]).rainGaugePresent, false);
  assert.equal(health([{ type_id: 'KIWI_SENSOR' }]).rainGaugePresent, false);
});

const kcRows = (overrides = {}) => ({ date: '2026-09-24', et0_mm: 4, et0_source: 'station_fao56', et0_tier: 'station_fao56', et0_station_id: 'S2120AAAA00000001', kc: 1.2, kc_source: 'fao56_crop', crop_type: 'maize', phenological_stage: 'mid_season', etc_mm: 4.8, hours_present: 24, expected_hours: 24, null_reason: null, ...overrides });
const forecastFor = (dates, cacheStatus = 'live') => ({ available: true, cacheStatus, rainFocus: { daily: dates.map((date, i) => ({ date, et0MmDay: 3 + i })) } });

test('KC_BY_STAGE and deriveCropCoefficient are gone', () => {
  assert.equal(ZE.KC_BY_STAGE, undefined);
  assert.equal(ZE.deriveCropCoefficient, undefined);
});

test('buildAgronomic takes the forecast day dated today and the FAO-56 Kc', () => {
  const a = ZE.buildAgronomic(null, null, forecastFor(['2026-09-24', '2026-09-25']), { cropType: 'maize', phenologicalStage: 'mid_season', todayIso: '2026-09-25', forecastFetchedAt: '2026-09-25T05:00:00Z', timezone: 'Europe/Zurich' });
  assert.deepEqual([a.current.referenceEt0MmDay, a.current.cropCoefficientKc, a.current.cropCoefficientSource, a.current.etcMmDay, a.current.cropId, a.current.stage], [4, 1.2, 'fao56_crop', 4.8, 'maize', 'mid_season']);
});

test('offline across midnight: a stale forecast fetched yesterday gives no demand for today', () => {
  const a = ZE.buildAgronomic(null, null, forecastFor(['2026-09-24', '2026-09-25'], 'stale'), { cropType: 'maize', phenologicalStage: 'mid_season', todayIso: '2026-09-25', forecastFetchedAt: '2026-09-24T20:00:00Z', timezone: 'Europe/Zurich' });
  assert.equal(a.current.etcMmDay, null);
  assert.equal(a.current.evapotranspirationSource, 'unavailable');
  const fetchedToday = ZE.buildAgronomic(null, null, forecastFor(['2026-09-25'], 'stale'), { cropType: 'maize', phenologicalStage: 'mid_season', todayIso: '2026-09-25', forecastFetchedAt: '2026-09-24T22:30:00Z', timezone: 'Europe/Zurich' });
  assert.equal(fetchedToday.current.referenceEt0MmDay, 3, '22:30Z is 00:30 local on the 25th');
});

test('buildForecastSection: every day carries the resolved Kc', () => {
  const f = ZE.buildForecastSection({ days: [{ date: '2026-09-25', et0MmDay: 5 }], hours: [] }, 'live', null, { cropType: 'grapevine', phenologicalStage: 'veraison' }, '2026-09-25T08:00:00Z');
  assert.deepEqual([f.rainFocus.daily[0].cropCoefficientKc, f.rainFocus.daily[0].etcMmDay], [0.7, 3.5]);
});

test('buildWaterDaily: seven rows, null rain for a day without a row, calculated days, today as forecast', () => {
  const daily = ZE.buildWaterDaily({
    envRows: [{ date: '2026-09-24', rainfall_mm: 1.2, flow_liters: 0 }],
    estimatedByDate: {},
    agronomyRows: [kcRows(), kcRows({ date: '2026-09-23', et0_mm: null, etc_mm: null, kc: null, kc_source: null, crop_type: null, phenological_stage: null, et0_tier: null, et0_source: null, et0_station_id: null, hours_present: 20, null_reason: 'partial_day' }), kcRows({ date: '2026-09-22', et0_tier: 'provider_hourly_sum', et0_source: 'meteoswiss_hourly_sum', et0_station_id: 'PAY' })],
    zone: { area_m2: 100, irrigation_efficiency_pct: 80 },
    todayIso: '2026-09-25', waterNeededTodayMm: 4.1, kcSourceToday: 'fao56_crop',
    stationNames: { S2120AAAA00000001: 'demo-s2120' },
  });
  assert.equal(daily.length, 7);
  assert.equal(daily[0].date, '2026-09-19');
  const byDate = Object.fromEntries(daily.map((d) => [d.date, d]));
  assert.equal(byDate['2026-09-23'].rainMm, null);
  assert.equal(byDate['2026-09-24'].rainMm, 1.2);
  assert.deepEqual([byDate['2026-09-24'].demandMm, byDate['2026-09-24'].demandSource, byDate['2026-09-24'].et0StationId, byDate['2026-09-24'].et0StationName, byDate['2026-09-24'].kc], [4.8, 'calculated', 'S2120AAAA00000001', 'demo-s2120', 1.2]);
  assert.deepEqual([byDate['2026-09-22'].et0StationId, byDate['2026-09-22'].et0StationName], ['PAY', 'PAY']);
  assert.deepEqual([byDate['2026-09-23'].demandMm, byDate['2026-09-23'].demandSource, byDate['2026-09-23'].nullReason, byDate['2026-09-23'].hoursPresent], [null, null, 'partial_day', 20]);
  assert.deepEqual([byDate['2026-09-21'].demandMm, byDate['2026-09-21'].demandSource, byDate['2026-09-21'].nullReason], [null, null, null]);
  assert.deepEqual([byDate['2026-09-25'].demandMm, byDate['2026-09-25'].demandSource, byDate['2026-09-25'].kcSource], [4.1, 'forecast', 'fao56_crop']);
});

test('overlay: past days take the local demand fields; today keeps the cloud value only while the bundle is current', () => {
  const local = { available: true, waterNeededTodayMm: 4.1, todayDate: '2026-09-25', daily: ZE.buildWaterDaily({ envRows: [], estimatedByDate: {}, agronomyRows: [kcRows()], zone: {}, todayIso: '2026-09-25', waterNeededTodayMm: 4.1, kcSourceToday: 'fao56_crop', stationNames: {} }) };
  const cloudDays = (last) => Array.from({ length: 7 }, (_, i) => ({ date: new Date(Date.parse(last + 'T00:00:00Z') - (6 - i) * 86400000).toISOString().slice(0, 10), rainMm: 0.5 }));
  const current = ZE.overlayLocalWaterIrrigationSplit({ available: true, waterNeededTodayMm: 3.3, daily: cloudDays('2026-09-25') }, local, '2026-09-25');
  const today = current.daily.find((d) => d.date === '2026-09-25');
  assert.deepEqual([today.demandMm, today.demandSource, today.kcSource, current.waterNeededTodayMm, current.todayDate], [3.3, 'forecast', 'server', 3.3, '2026-09-25']);
  assert.equal(current.daily.find((d) => d.date === '2026-09-24').demandMm, 4.8);
  assert.equal(current.daily.find((d) => d.date === '2026-09-24').rainMm, 0.5);
  const stale = ZE.overlayLocalWaterIrrigationSplit({ available: true, waterNeededTodayMm: 3.3, daily: cloudDays('2026-09-24') }, local, '2026-09-25');
  assert.equal(stale.daily.length, 7);
  assert.equal(stale.daily.at(-1).date, '2026-09-25');
  assert.deepEqual([stale.daily.at(-1).demandMm, stale.daily.at(-1).demandSource, stale.daily.at(-1).kcSource, stale.waterNeededTodayMm], [4.1, 'forecast', 'local', 4.1]);
});

test('resolveWaterAction: no demand for today is demand_unknown; a missing zone setup stays balance_unknown', () => {
  assert.equal(ZE.resolveWaterAction('2026-09-25', null, null, 2, null).reasonCode, 'demand_unknown');
  assert.equal(ZE.resolveWaterAction('2026-09-25', null, null, 2, null).source, 'insufficient_data');
  assert.equal(ZE.resolveWaterAction('2026-09-25', null, null, 2, 4.1).reasonCode, 'balance_unknown');
  // A caller that does not pass the demand keeps the old code.
  assert.equal(ZE.resolveWaterAction('2026-09-25', null, null, 2).reasonCode, 'balance_unknown');
  assert.equal(ZE.resolveWaterAction('2026-09-25', null, 0.5, 2, 4.1).reasonCode, 'supply_covers_demand');
});

test('buildWaterDaily: today carries ET0, Kc, crop and stage from the agronomic block, and demand_unknown without a forecast', () => {
  const todayAgronomic = { referenceEt0MmDay: 3.42, cropCoefficientKc: 1.2, cropCoefficientSource: 'fao56_crop', cropId: 'maize', stage: 'mid_season' };
  const withDemand = ZE.buildWaterDaily({ envRows: [], estimatedByDate: {}, agronomyRows: [], zone: {}, todayIso: '2026-09-25', waterNeededTodayMm: 4.1, todayAgronomic, stationNames: {} }).at(-1);
  assert.deepEqual(
    [withDemand.et0Mm, withDemand.kc, withDemand.kcSource, withDemand.cropType, withDemand.phenologicalStage, withDemand.nullReason],
    [3.42, 1.2, 'fao56_crop', 'maize', 'mid_season', null],
  );
  const noDemand = ZE.buildWaterDaily({ envRows: [], estimatedByDate: {}, agronomyRows: [], zone: {}, todayIso: '2026-09-25', waterNeededTodayMm: null, todayAgronomic: { ...todayAgronomic, referenceEt0MmDay: null }, stationNames: {} }).at(-1);
  assert.deepEqual([noDemand.demandMm, noDemand.demandSource, noDemand.et0Mm, noDemand.kc, noDemand.nullReason], [null, null, null, 1.2, 'demand_unknown']);
});

test('overlay: a stale bundle takes every "today" field from the gateway, so the tile shows one day', () => {
  const localAction = { code: null, source: 'insufficient_data', reasonCode: 'demand_unknown', recommendationDate: '2026-09-25' };
  const local = {
    available: true, waterNeededTodayMm: null, rainTodayMm: 0, balanceTodayMm: null, next24hRainMm: 1.4, action: localAction, todayDate: '2026-09-25',
    daily: ZE.buildWaterDaily({ envRows: [], estimatedByDate: {}, agronomyRows: [kcRows()], zone: {}, todayIso: '2026-09-25', waterNeededTodayMm: null, stationNames: {} }),
  };
  const cloudDays = (last) => Array.from({ length: 7 }, (_, i) => ({ date: new Date(Date.parse(last + 'T00:00:00Z') - (6 - i) * 86400000).toISOString().slice(0, 10), rainMm: 0.5 }));
  const cloudAction = { code: 'delay_irrigation', source: 'heuristic', reasonCode: 'supply_covers_demand', recommendationDate: '2026-09-24' };
  const bundle = (last) => ({ available: true, waterNeededTodayMm: 3.3, rainTodayMm: 6.2, rainSource: 'meteoswiss_station', balanceTodayMm: 2.9, next24hRainMm: 0, action: cloudAction, daily: cloudDays(last) });
  const stale = ZE.overlayLocalWaterIrrigationSplit(bundle('2026-09-24'), local, '2026-09-25');
  assert.deepEqual(
    [stale.rainTodayMm, stale.rainSource, stale.balanceTodayMm, stale.next24hRainMm, stale.action, stale.waterNeededTodayMm],
    [0, null, null, 1.4, localAction, null],
  );
  assert.equal(stale.daily.at(-1).nullReason, 'demand_unknown');
  const current = ZE.overlayLocalWaterIrrigationSplit(bundle('2026-09-25'), local, '2026-09-25');
  assert.deepEqual(
    [current.rainTodayMm, current.rainSource, current.balanceTodayMm, current.next24hRainMm, current.action, current.waterNeededTodayMm],
    [6.2, 'meteoswiss_station', 2.9, 0, cloudAction, 3.3],
  );
  const today = current.daily.at(-1);
  assert.deepEqual([today.demandMm, today.kcSource, today.kc, today.et0Mm, today.nullReason], [3.3, 'server', null, null, null]);
});

// Contract v2 in the Water tab (spec 2026-09-27-daily-agronomy-parity B7).
test('buildAgronomic: a dated development zone takes today\'s place on the FAO-56 curve', () => {
  const a = ZE.buildAgronomic(null, null, forecastFor(['2026-09-25']), { cropType: 'maize', phenologicalStage: 'development', stageStartedOn: '2026-09-05', todayIso: '2026-09-25', forecastFetchedAt: '2026-09-25T05:00:00Z', timezone: 'Europe/Zurich' });
  assert.deepEqual([a.current.cropCoefficientKc, a.current.cropCoefficientSource, a.current.stageOverrun, a.current.etcMmDay], [0.77, 'fao56_curve', false, 2.31]);
  const undated = ZE.buildAgronomic(null, null, forecastFor(['2026-09-25']), { cropType: 'maize', phenologicalStage: 'development', todayIso: '2026-09-25', forecastFetchedAt: '2026-09-25T05:00:00Z', timezone: 'Europe/Zurich' });
  assert.deepEqual([undated.current.cropCoefficientKc, undated.current.cropCoefficientSource, undated.current.stageOverrun], [1.2, 'fao56_crop', null]);
});

test('buildForecastSection: each forecast day resolves Kc for its own date', () => {
  const f = ZE.buildForecastSection({ days: [{ date: '2026-09-25', et0MmDay: 5 }, { date: '2026-09-26', et0MmDay: 5 }, { date: '2026-09-27', et0MmDay: 5 }], hours: [] }, 'live', null, { cropType: 'maize', phenologicalStage: 'development', stageStartedOn: '2026-09-05' }, '2026-09-25T08:00:00Z');
  assert.deepEqual(f.rainFocus.daily.map((d) => d.cropCoefficientKc), [0.77, 0.8, 0.82]);
  assert.deepEqual(f.rainFocus.daily.map((d) => d.etcMmDay), [3.85, 4, 4.1]);
});

test('buildWaterDaily: stageOverrun from the stored row or today\'s resolution; demandComputedBy is edge for a stored demand', () => {
  const daily = ZE.buildWaterDaily({
    envRows: [], estimatedByDate: {},
    agronomyRows: [kcRows({ stage_overrun: 1 }), kcRows({ date: '2026-09-23', stage_overrun: 0 }), kcRows({ date: '2026-09-22', et0_mm: null, etc_mm: null, kc: null, null_reason: 'partial_day', stage_overrun: null })],
    zone: {}, todayIso: '2026-09-25', waterNeededTodayMm: 4.1,
    todayAgronomic: { referenceEt0MmDay: 3.42, cropCoefficientKc: 0.77, cropCoefficientSource: 'fao56_curve', cropId: 'maize', stage: 'development', stageOverrun: false },
    stationNames: {},
  });
  const byDate = Object.fromEntries(daily.map((d) => [d.date, d]));
  assert.deepEqual([byDate['2026-09-24'].stageOverrun, byDate['2026-09-24'].demandComputedBy], [true, 'edge']);
  assert.deepEqual([byDate['2026-09-23'].stageOverrun, byDate['2026-09-23'].demandComputedBy], [false, 'edge']);
  assert.deepEqual([byDate['2026-09-22'].stageOverrun, byDate['2026-09-22'].demandComputedBy], [null, null]);
  assert.deepEqual([byDate['2026-09-21'].stageOverrun, byDate['2026-09-21'].demandComputedBy], [null, null]);
  assert.deepEqual([byDate['2026-09-25'].stageOverrun, byDate['2026-09-25'].demandComputedBy, byDate['2026-09-25'].kcSource], [false, null, 'fao56_curve']);
});

test('shared mode: the gateway\'s day replaces the cloud\'s where it has a demand; a cloud day fills a day it has none for; an older cloud still gets the gateway\'s fields', () => {
  const local = { available: true, waterNeededTodayMm: 4.1, todayDate: '2026-09-25', daily: ZE.buildWaterDaily({ envRows: [], estimatedByDate: {}, agronomyRows: [kcRows()], zone: {}, todayIso: '2026-09-25', waterNeededTodayMm: 4.1, stationNames: {} }) };
  const cloudDay = (date) => ({ date, rainMm: 0.5, demandMm: 2.2, demandSource: 'calculated', demandComputedBy: 'cloud', et0Mm: 3.1, et0Tier: 'open_meteo_daily', et0Source: 'provider_native', kc: 0.71, kcSource: 'fao56_crop', stageOverrun: null, nullReason: null });
  const days = Array.from({ length: 7 }, (_, i) => cloudDay(new Date(Date.parse('2026-09-19T00:00:00Z') + i * 86400000).toISOString().slice(0, 10)));
  const merged = ZE.overlayLocalWaterIrrigationSplit({ available: true, waterNeededTodayMm: 3.3, daily: days }, local, '2026-09-25');
  const byDate = Object.fromEntries(merged.daily.map((d) => [d.date, d]));
  assert.deepEqual([byDate['2026-09-24'].demandMm, byDate['2026-09-24'].demandComputedBy, byDate['2026-09-24'].et0Tier], [4.8, 'edge', 'station_fao56']);
  assert.deepEqual([byDate['2026-09-23'].demandMm, byDate['2026-09-23'].demandComputedBy, byDate['2026-09-23'].et0Tier], [2.2, 'cloud', 'open_meteo_daily']);
  const older = ZE.overlayLocalWaterIrrigationSplit({ available: true, waterNeededTodayMm: 3.3, daily: days.map((d) => ({ date: d.date, rainMm: d.rainMm })) }, local, '2026-09-25');
  assert.deepEqual([older.daily.find((d) => d.date === '2026-09-23').demandMm, older.daily.find((d) => d.date === '2026-09-23').demandComputedBy], [null, null]);
});

// Open-Meteo forecast times. With a named timezone, Open-Meteo labels every
// time of one response with a single fixed offset (`utc_offset_seconds`, the
// zone's offset at the start of the response), also across a DST change; with
// `timeformat=unixtime` it returns instants. A label is never UTC, and it is
// not the zone's wall-clock time after a DST change inside the response.
const HOUR_S = 3600;
const unix = (iso) => Date.parse(iso) / 1000;
function openMeteoResponse({ offsetSeconds, timezone, hourTimes, rain, dayTimes = [] }) {
  return {
    utc_offset_seconds: offsetSeconds,
    timezone,
    hourly: {
      time: hourTimes,
      temperature_2m: hourTimes.map(() => 12.5),
      relative_humidity_2m: hourTimes.map(() => 80),
      precipitation: rain,
      precipitation_probability: hourTimes.map(() => 50),
      wind_speed_10m: hourTimes.map(() => 3),
      wind_direction_10m: hourTimes.map(() => 200),
    },
    daily: {
      time: dayTimes,
      weather_code: dayTimes.map(() => 61),
      precipitation_sum: dayTimes.map(() => 4.2),
      precipitation_probability_max: dayTimes.map(() => 70),
      et0_fao_evapotranspiration: dayTimes.map(() => 1.1),
      temperature_2m_min: dayTimes.map(() => 6),
      temperature_2m_max: dayTimes.map(() => 14),
    },
  };
}

test('forecast instants: a Zurich 12:00 label is 10:00Z, never 12:00Z (review probe)', () => {
  assert.equal(ZE.openMeteoInstantIso('2026-10-08T12:00', 7200), '2026-10-08T10:00:00.000Z');
  assert.equal(ZE.openMeteoInstantIso(unix('2026-10-08T10:00:00Z'), 7200), '2026-10-08T10:00:00.000Z');
  // The defect this replaces: the generic helper reads a label as UTC.
  assert.equal(ZE.toIsoTime('2026-10-08T12:00'), '2026-10-08T12:00:00.000Z');
  // A label without a known offset is an unknown instant, not UTC.
  assert.equal(ZE.openMeteoInstantIso('2026-10-08T12:00', null), null);
  assert.equal(ZE.openMeteoInstantIso('2026-10-08T12:00', undefined), null);
  assert.equal(ZE.openMeteoInstantIso('2026-10-08T12:00Z', null), '2026-10-08T12:00:00.000Z');
  assert.equal(ZE.openMeteoInstantIso('', 7200), null);
  assert.equal(ZE.openMeteoInstantIso(null, 7200), null);
  assert.equal(ZE.openMeteoInstantIso(Number.NaN, 7200), null);
  assert.equal(ZE.openMeteoInstantIso('garbage', 7200), null);

  const parsed = ZE.parseOpenMeteoForecast(openMeteoResponse({
    offsetSeconds: 7200, timezone: 'Europe/Zurich', hourTimes: [unix('2026-10-08T10:00:00Z')], rain: [1.2],
  }), { timezone: 'Europe/Zurich', observedAtMs: NOW_MS });
  // The stamp stays the end of the provider's interval: precipitation at T is the hour T-1h..T.
  assert.equal(parsed.hours[0].time, '2026-10-08T10:00:00.000Z');
  assert.equal(parsed.hours[0].rainMm, 1.2);
});

test('forecast instants: labels and unixtime of a recorded Zurich response across the 2025-10-26 DST end agree', () => {
  // Shape recorded from the Open-Meteo archive API for 2025-10-25..26,
  // timezone=Europe/Zurich: utc_offset_seconds 7200 for the whole response,
  // 48 consecutive labels with no repeated hour, and unixtime starting at
  // 1761343200 in steps of 3600.
  const labels = [];
  for (let i = 0; i < 48; i++) labels.push(`2025-10-${i < 24 ? 25 : 26}T${String(i % 24).padStart(2, '0')}:00`);
  const unixTimes = labels.map((_, i) => 1761343200 + i * HOUR_S);
  const rain = labels.map((_, i) => (i % 5) / 10);
  const fromLabels = ZE.parseOpenMeteoForecast(openMeteoResponse({ offsetSeconds: 7200, timezone: 'Europe/Zurich', hourTimes: labels, rain }), { timezone: 'Europe/Zurich', observedAtMs: NOW_MS });
  const fromUnix = ZE.parseOpenMeteoForecast(openMeteoResponse({ offsetSeconds: 7200, timezone: 'Europe/Zurich', hourTimes: unixTimes, rain }), { timezone: 'Europe/Zurich', observedAtMs: NOW_MS });
  assert.deepEqual(fromLabels.hours, fromUnix.hours);
  assert.equal(fromUnix.hours.length, 48);
  assert.equal(new Set(fromUnix.hours.map((h) => h.time)).size, 48);
  assert.equal(fromUnix.hours[0].time, '2025-10-24T22:00:00.000Z');
  // After the change the label runs one hour ahead of Zurich wall time:
  // '2025-10-26T12:00' is 10:00Z (12:00 GMT+2), which is 11:00 CET.
  assert.equal(fromLabels.hours[36].time, '2025-10-26T10:00:00.000Z');
});

test('forecast instants: hours stay one hour apart across the 2026-03-29 DST start', () => {
  // A response requested on 2026-03-28 for Europe/Zurich: offset +01:00 throughout.
  const unixTimes = Array.from({ length: 6 }, (_, i) => unix('2026-03-28T23:00:00Z') + i * HOUR_S);
  const parsed = ZE.parseOpenMeteoForecast(openMeteoResponse({ offsetSeconds: 3600, timezone: 'Europe/Zurich', hourTimes: unixTimes, rain: [0, 0, 0.4, 0, 0, 0] }), { timezone: 'Europe/Zurich', observedAtMs: NOW_MS });
  assert.deepEqual(parsed.hours.map((h) => h.time), [
    '2026-03-28T23:00:00.000Z', '2026-03-29T00:00:00.000Z', '2026-03-29T01:00:00.000Z',
    '2026-03-29T02:00:00.000Z', '2026-03-29T03:00:00.000Z', '2026-03-29T04:00:00.000Z',
  ]);
  // The label '2026-03-29T03:00' in this response is GMT+1, so 02:00Z (04:00 CEST).
  assert.equal(ZE.openMeteoInstantIso('2026-03-29T03:00', 3600), '2026-03-29T02:00:00.000Z');
});

test('forecast days: unixtime day starts map to the provider\'s dates across both DST changes', () => {
  // Day starts at local midnight under the response's fixed offset.
  const spring = [unix('2026-03-28T23:00:00Z'), unix('2026-03-29T23:00:00Z'), unix('2026-03-30T23:00:00Z')];
  const autumn = [unix('2026-10-24T22:00:00Z'), unix('2026-10-25T22:00:00Z'), unix('2026-10-26T22:00:00Z')];
  assert.deepEqual(spring.map((t) => ZE.openMeteoDateIso(t, 3600, 'Europe/Zurich')), ['2026-03-29', '2026-03-30', '2026-03-31']);
  assert.deepEqual(autumn.map((t) => ZE.openMeteoDateIso(t, 7200, 'Europe/Zurich')), ['2026-10-25', '2026-10-26', '2026-10-27']);
  // Without an offset, the requested zone dates a day start; an error of an
  // hour either way (fixed offset or wall-clock midnight) keeps the date.
  assert.deepEqual(autumn.map((t) => ZE.openMeteoDateIso(t, null, 'Europe/Zurich')), ['2026-10-25', '2026-10-26', '2026-10-27']);
  assert.deepEqual([unix('2026-03-29T22:00:00Z'), unix('2026-10-25T23:00:00Z')].map((t) => ZE.openMeteoDateIso(t, null, 'Europe/Zurich')), ['2026-03-30', '2026-10-26']);
  // A date label is already the provider's date.
  assert.equal(ZE.openMeteoDateIso('2026-10-25', 7200, 'Europe/Zurich'), '2026-10-25');
  assert.equal(ZE.openMeteoDateIso('', 7200, 'Europe/Zurich'), null);
  assert.equal(ZE.openMeteoDateIso(null, 7200, 'Europe/Zurich'), null);

  const parsed = ZE.parseOpenMeteoForecast(openMeteoResponse({ offsetSeconds: 7200, timezone: 'Europe/Zurich', hourTimes: [], rain: [], dayTimes: autumn }), { timezone: 'Europe/Zurich', observedAtMs: NOW_MS });
  assert.deepEqual(parsed.days.map((d) => d.date), ['2026-10-25', '2026-10-26', '2026-10-27']);
  assert.deepEqual(parsed.days[0], {
    date: '2026-10-25', description: null, weatherCode: 61, rainMm: 4.2, precipitationProbabilityPct: 70, rainProbabilityPct: 70,
    et0MmDay: 1.1, temperatureMinC: 6, temperatureMaxC: 14, minTempC: 6, maxTempC: 14,
  });
});

test('forecast instants: offsets outside Europe, including a half hour and a negative offset', () => {
  assert.equal(ZE.openMeteoInstantIso('2026-10-08T12:00', 10800), '2026-10-08T09:00:00.000Z'); // Africa/Kampala +03:00
  assert.equal(ZE.openMeteoInstantIso('2026-10-08T12:00', 19800), '2026-10-08T06:30:00.000Z'); // Asia/Kolkata +05:30
  assert.equal(ZE.openMeteoInstantIso('2026-10-08T12:00', -10800), '2026-10-08T15:00:00.000Z'); // America/Sao_Paulo -03:00
  // Local midnight of 2026-10-08 is 2026-10-07T21:00Z in Kampala and 18:30Z in Kolkata.
  assert.equal(ZE.openMeteoDateIso(unix('2026-10-07T21:00:00Z'), 10800, 'Africa/Kampala'), '2026-10-08');
  assert.equal(ZE.openMeteoDateIso(unix('2026-10-07T18:30:00Z'), 19800, 'Asia/Kolkata'), '2026-10-08');
  assert.equal(ZE.openMeteoDateIso(unix('2026-10-07T18:30:00Z'), null, 'Asia/Kolkata'), '2026-10-08');
  assert.equal(ZE.openMeteoDateIso(unix('2026-10-08T03:00:00Z'), -10800, 'America/Sao_Paulo'), '2026-10-08');

  const kolkata = ZE.parseOpenMeteoForecast(openMeteoResponse({
    offsetSeconds: 19800, timezone: 'Asia/Kolkata', hourTimes: ['2026-10-08T12:00', '2026-10-08T13:00'], rain: [0.5, 0],
  }), { timezone: 'Asia/Kolkata', observedAtMs: NOW_MS });
  assert.deepEqual(kolkata.hours.map((h) => h.time), ['2026-10-08T06:30:00.000Z', '2026-10-08T07:30:00.000Z']);
});

test('forecast instants: next-24-hour rain and onset use true instants (Zurich, before and after)', () => {
  const nowIso = '2026-10-08T10:30:00.000Z'; // 12:30 in Zurich
  const labels = ['2026-10-08T12:00', '2026-10-08T13:00', '2026-10-09T12:00', '2026-10-09T13:00'];
  const rain = [3, 1, 2, 4];
  const response = openMeteoResponse({ offsetSeconds: 7200, timezone: 'Europe/Zurich', hourTimes: labels, rain });

  // Before: labels read as UTC. The 12:00 hour (ended 10:00Z, in the past)
  // counted and the next day's 12:00 hour (ends 10:00Z, inside 24 h) did not.
  const before = { source: 'open_meteo', observedAt: nowIso, days: [], hours: labels.map((label, i) => ({ time: ZE.toIsoTime(label), rainMm: rain[i] })) };
  const beforeSection = ZE.buildForecastSection(before, 'live', null, null, nowIso);
  assert.equal(beforeSection.rainFocus.totalNext24hMm, 4);
  assert.equal(beforeSection.rainFocus.nextRainEta, '2026-10-08T12:00:00.000Z');

  // After: the hour ending 11:00Z and the one ending 10:00Z tomorrow.
  for (const hourTimes of [labels, labels.map((label) => ZE.openMeteoInstantIso(label, 7200)).map((iso) => Date.parse(iso) / 1000)]) {
    const parsed = ZE.parseOpenMeteoForecast({ ...response, hourly: { ...response.hourly, time: hourTimes } }, { timezone: 'Europe/Zurich', observedAtMs: Date.parse(nowIso) });
    const section = ZE.buildForecastSection(parsed, 'live', null, null, nowIso);
    assert.equal(section.rainFocus.totalNext24hMm, 3);
    assert.equal(section.rainFocus.nextRainEta, '2026-10-08T11:00:00.000Z');
    assert.deepEqual(section.rainFocus.hourly.map((h) => h.time), ['2026-10-08T11:00:00.000Z', '2026-10-09T10:00:00.000Z']);
    assert.equal(section.rainFocus.maxHourlyRainAt, '2026-10-09T11:00:00.000Z');
  }
});

test('parseOpenMeteoForecast: empty or missing data gives null; hours without an instant are dropped', () => {
  assert.equal(ZE.parseOpenMeteoForecast(null, { timezone: 'UTC', observedAtMs: NOW_MS }), null);
  assert.equal(ZE.parseOpenMeteoForecast({}, { timezone: 'UTC', observedAtMs: NOW_MS }), null);
  const parsed = ZE.parseOpenMeteoForecast(openMeteoResponse({ offsetSeconds: undefined, timezone: 'Europe/Zurich', hourTimes: ['2026-10-08T12:00', unix('2026-10-08T11:00:00Z')], rain: [1, 2] }), { timezone: 'Europe/Zurich', observedAtMs: NOW_MS });
  assert.deepEqual(parsed.hours.map((h) => [h.time, h.rainMm]), [['2026-10-08T11:00:00.000Z', 2]]);
  assert.equal(parsed.source, 'open_meteo');
  assert.equal(parsed.observedAt, new Date(NOW_MS).toISOString());
});
