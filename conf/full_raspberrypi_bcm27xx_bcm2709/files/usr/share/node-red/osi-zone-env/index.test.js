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
  assert.equal(ZE.deriveCropCoefficient('fruit_maturation'), 0.85);
  assert.equal(ZE.estimateStepHours([
    { time: '2026-07-11T12:00:00.000Z' },
    { time: '2026-07-11T18:00:00.000Z' },
  ]), 6);
  assert.equal(ZE.sumRain(merged.hours, NOW_MS, 24), 1.2);
  assert.equal(ZE.localDateIso(null, 'UTC', NOW_MS), '2026-07-11');
  assert.equal(ZE.addUtcDays('2026-07-11', 2), '2026-07-13');

  const section = ZE.buildForecastSection(merged, 'live', '2026-07-11T10:15:00.000Z', 'fruit_maturation', '2026-07-11T10:00:00.000Z');
  assert.equal(section.available, true);
  assert.equal(section.cacheStatus, 'live');
  assert.equal(section.rainFocus.totalNext24hMm, 1.2);
  assert.equal(section.rainFocus.daily[0].cropCoefficientKc, 0.85);
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
    rainFocus: { totalNext24hMm: 4.2, totalNext72hMm: 12.3, daily: [{ et0MmDay: 5 }] },
  };
  const agronomic = ZE.buildAgronomic(local, online, forecast, 'fruit_maturation');
  assert.equal(agronomic.current.vpdKpa, 1.843);
  assert.equal(agronomic.current.cropCoefficientKc, 0.85);
  assert.equal(agronomic.current.etcMmDay, 4.25);

  assert.equal(ZE.toEffectiveIrrigationMm(100, 50, 75), 1.5);
  assert.deepEqual(ZE.resolveWaterAction('2026-07-11', null, -8, 0), {
    code: 'irrigate_today',
    source: 'heuristic',
    reasoning: 'Estimated demand exceeds effective rain and irrigation for today.',
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
