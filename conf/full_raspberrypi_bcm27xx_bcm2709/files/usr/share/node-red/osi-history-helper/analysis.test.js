'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const analysisModule = require('./analysis.js');
const hh = require('./index.js');
const { zoneLocations } = require('../osi-weather-provider');

const REPO_ROOT = path.resolve(__dirname, '../../../../../../..');
const SEED = fs.readFileSync(path.join(REPO_ROOT, 'database/seed-blank.sql'), 'utf8');
const WEATHER_FIXTURE = fs.readFileSync(path.join(__dirname, '__fixtures__', 'weather-catalog.sql'), 'utf8');
const DEVICE_SNAPSHOT = JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', 'analysis-device-catalog.json'), 'utf8'));
const HUB = 'AA00000000000001';
const HOUR = 3600000;
const OPEN_METEO_KEY = 'open_meteo:46.80:6.95';
const METEOSWISS_KEY = 'meteoswiss:46.81:6.94';
const STATION = 'A840410000002120';

// A hand-built dbAll mock answers buildAnalysisCatalog's sqlite_master probe
// (final fix A4) with these four rows so the weather path it is testing
// still runs; content is never read, only rows.length.
const WEATHER_TABLES_PRESENT_ROWS = [
  { name: 'weather_locations' },
  { name: 'weather_provider_hours' },
  { name: 'weather_station_hours' },
  { name: 'zone_daily_agronomy' },
];

// The tz helpers a mocked catalogue needs; the fixture tests below use the
// real ones through index.js.
function utcDeps() {
  return {
    zoneLocations,
    zoneDateStartIso: (date) => `${date}T00:00:00.000Z`,
    normalizeTimezone: (value) => String(value || 'UTC').trim() || 'UTC',
    localDateKey: (value) => new Date(value).toISOString().slice(0, 10),
  };
}

function weatherDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SEED);
  raw.exec(WEATHER_FIXTURE);
  return raw;
}

function facade(raw) {
  return { all: (sql, params) => Promise.resolve(raw.prepare(sql).all(...(params || []))) };
}

function stamp(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// values(i) returns the row's measurements; { skip: true } leaves the hour out.
function insertProviderHours(raw, locationKey, fromIso, hours, values = () => ({})) {
  const insert = raw.prepare('INSERT INTO weather_provider_hours (location_key, hour_start, air_temperature_c, relative_humidity_pct, rain_mm, wind_speed_mps, global_radiation_wm2, et0_mm, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const start = Date.parse(fromIso);
  for (let i = 0; i < hours; i += 1) {
    const v = { temp: 10, rh: 80, rain: 0.5, wind: 2, radiation: 100, et0: 0.1, ...values(i) };
    if (v.skip) continue;
    insert.run(locationKey, stamp(start + i * HOUR), v.temp, v.rh, v.rain, v.wind, v.radiation, v.et0, '2026-09-26T00:00:00Z');
  }
}

function insertStationHours(raw, deveui, fromIso, hours, values = () => ({})) {
  const insert = raw.prepare('INSERT INTO weather_station_hours (deveui, hour_start, air_temperature_c, relative_humidity_pct, wind_speed_mps, pressure_hpa, light_lux, global_radiation_wm2, rain_mm, sample_count, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const start = Date.parse(fromIso);
  for (let i = 0; i < hours; i += 1) {
    const v = { temp: 12, rh: 70, wind: 1, pressure: 1000, lux: 12000, radiation: 100, rain: 0.2, ...values(i) };
    if (v.skip) continue;
    insert.run(deveui, stamp(start + i * HOUR), v.temp, v.rh, v.wind, v.pressure, v.lux, v.radiation, v.rain, 6, '2026-09-26T00:00:00Z');
  }
}

function insertAgronomyDays(raw, zoneId, days) {
  const insert = raw.prepare('INSERT INTO zone_daily_agronomy (zone_id, date, et0_mm, etc_mm, computed_at) VALUES (?, ?, ?, ?, ?)');
  for (const day of days) insert.run(zoneId, day.date, day.et0, day.etc, '2026-10-28T00:00:00Z');
}

async function catalog(raw, options = {}) {
  return hh.buildAnalysisCatalog(facade(raw), { userId: 1, deviceEui: HUB, weatherProviderDefault: 'open_meteo', ...options });
}

function entry(result, zoneId, sourceKind, channelKey) {
  const found = result.channels.find((c) => c.zoneId === zoneId && c.sourceKind === sourceKind && c.channelKey === channelKey);
  assert.ok(found, `no ${sourceKind} ${channelKey} entry in zone ${zoneId}`);
  return found;
}

async function series(raw, selected, range, aggregation, options = {}) {
  return hh.resolveAnalysisSeries(facade(raw), {
    userId: 1,
    deviceEui: HUB,
    weatherProviderDefault: 'open_meteo',
    selectors: selected.map((e) => ({ seriesId: e.seriesId })),
    range,
    aggregation,
    ...options,
  });
}

function sha12(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

test('analysisSeriesId is a deterministic sha256-based id', () => {
  const idA = analysisModule.analysisSeriesId(1, 'soil', 'soil-src-abc123', 'swt_1');
  const idB = analysisModule.analysisSeriesId(1, 'soil', 'soil-src-abc123', 'swt_1');
  assert.equal(idA, idB);
  assert.match(idA, /^[0-9a-f]{16}$/);

  const expected = crypto
    .createHash('sha256')
    .update('1|soil|soil-src-abc123|swt_1')
    .digest('hex')
    .slice(0, 16);
  assert.equal(idA, expected);

  const idDifferentChannel = analysisModule.analysisSeriesId(1, 'soil', 'soil-src-abc123', 'swt_2');
  assert.notEqual(idA, idDifferentChannel);

  const idDifferentZone = analysisModule.analysisSeriesId(2, 'soil', 'soil-src-abc123', 'swt_1');
  assert.notEqual(idA, idDifferentZone);
});

test('createAnalysis returns the expected API surface bound to injected deps', () => {
  const deps = {
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: async () => [],
    deriveCardsForZone: () => [],
    displayDeviceName: () => 'Device',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: () => null,
    sourceDevicesForCard: () => [],
    sourceKeyForCsv: () => 'source-key',
    ...utcDeps(),
  };
  const analysis = analysisModule.createAnalysis(deps);

  assert.equal(typeof analysis.buildAnalysisCatalog, 'function');
  assert.equal(typeof analysis.resolveAnalysisSeries, 'function');
  assert.equal(typeof analysis.listAnalysisViews, 'function');
  assert.equal(typeof analysis.saveAnalysisView, 'function');
  assert.equal(analysis.analysisSeriesId, analysisModule.analysisSeriesId);
  assert.equal(analysis.ANALYSIS_VIEWS_SCHEMA, analysisModule.ANALYSIS_VIEWS_SCHEMA);
  assert.match(analysis.ANALYSIS_VIEWS_SCHEMA, /CREATE TABLE IF NOT EXISTS analysis_views/);
});

test('createAnalysis works without deps supplied (pure structural check)', () => {
  const analysis = analysisModule.createAnalysis();
  assert.equal(typeof analysis.buildAnalysisCatalog, 'function');
  assert.equal(typeof analysis.resolveAnalysisSeries, 'function');
  assert.equal(typeof analysis.listAnalysisViews, 'function');
  assert.equal(typeof analysis.saveAnalysisView, 'function');
});

test('buildAnalysisCatalog filters zones by supplied owned-plus-granted UUIDs', async () => {
  const calls = [];
  const analysis = analysisModule.createAnalysis({
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: async (_db, sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('sqlite_master')) return WEATHER_TABLES_PRESENT_ROWS;
      if (sql.includes('FROM irrigation_zones')) {
        return [{ id: 2, zone_uuid: 'z-granted', name: 'Granted' }];
      }
      return [];
    },
    deriveCardsForZone: () => [],
    displayDeviceName: () => 'Device',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: () => null,
    sourceDevicesForCard: () => [],
    sourceKeyForCsv: () => 'source-key',
    ...utcDeps(),
  });

  await analysis.buildAnalysisCatalog({}, {
    userId: 2,
    zoneUuids: ['z-owned', 'z-granted'],
  });

  assert.match(calls[0].sql, /zone_uuid IN \(\?,\?\)/);
  assert.deepEqual(calls[0].params, ['z-owned', 'z-granted']);
  assert.match(calls[1].sql, /sqlite_master/);
  // zoneLocations reads every live zone once, through the dbAll adapter.
  assert.match(calls[2].sql, /LEFT JOIN gateway_locations/);
  // One batched station query for every zone of the catalogue, ahead of the
  // per-zone device query (final review, queue T3 N1: one query, not one
  // per zone).
  assert.match(calls[3].sql, /FROM weather_station_zones/);
  assert.doesNotMatch(calls[3].sql, /user_id = \?/);
  assert.deepEqual(calls[3].params, [2]);
  assert.doesNotMatch(calls[4].sql, /user_id = \?/);
  assert.deepEqual(calls[4].params, [2]);
});

test('buildAnalysisCatalog preserves the legacy owner filter without a scope list', async () => {
  const calls = [];
  const analysis = analysisModule.createAnalysis({
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: async (_db, sql, params) => {
      calls.push({ sql, params });
      return [];
    },
    deriveCardsForZone: () => [],
    displayDeviceName: () => 'Device',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: () => null,
    sourceDevicesForCard: () => [],
    sourceKeyForCsv: () => 'source-key',
    ...utcDeps(),
  });

  await analysis.buildAnalysisCatalog({}, { userId: 7 });

  assert.match(calls[0].sql, /user_id = \?/);
  assert.deepEqual(calls[0].params, [7]);
  assert.equal(calls.length, 1, 'no zone, so no location, device or station query');
});

// Station and location queries answer [] so only the device path and the
// daily agronomy source (always listed) remain.
function sentekLikeDbAll(zoneRow, device) {
  return async (_db, sql) => {
    if (sql.includes('sqlite_master')) return WEATHER_TABLES_PRESENT_ROWS;
    if (sql.includes('FROM weather_station_zones') || sql.includes('FROM weather_locations')) return [];
    return sql.includes('FROM irrigation_zones') ? [zoneRow] : [device];
  };
}

test('buildAnalysisCatalog exposes only configured Sentek soil channels', async () => {
  const sentek = {
    deveui: '0011223344556677',
    type_id: 'DRAGINO_SDI12',
    sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
    soil_moisture_probe_depths_json: JSON.stringify({ vwc_1: 0, vwc_8: 80 }),
  };
  const analysis = analysisModule.createAnalysis({
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: sentekLikeDbAll({ id: 2, zone_uuid: 'zone-2', name: 'Sentek block' }, sentek),
    deriveCardsForZone: () => [{ cardType: 'soil' }],
    displayDeviceName: () => 'Sentek-01',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: () => null,
    sourceDevicesForCard: () => [sentek],
    sourceKeyForCsv: () => 'sentek-01',
    ...utcDeps(),
  });

  const catalog = await analysis.buildAnalysisCatalog({}, { userId: 7 });

  assert.deepEqual(catalog.channels.map((entry) => entry.channelKey), [
    'vwc_1',
    'vwc_8',
    'et0_mm',
    'etc_mm',
  ]);
  assert.ok(catalog.channels.every((entry) => !entry.channelKey.startsWith('swt_')));
});

test('buildAnalysisCatalog keeps explicit Chameleon SWT capability ahead of other configuration', async () => {
  const chameleon = {
    deveui: '8899AABBCCDDEEFF',
    type_id: 'KIWI_SENSOR',
    chameleon_enabled: 1,
    soil_moisture_probe_depths_json: JSON.stringify({ vwc_1: 12.5 }),
  };
  const analysis = analysisModule.createAnalysis({
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: sentekLikeDbAll({ id: 3, zone_uuid: 'zone-3', name: 'Chameleon block' }, chameleon),
    deriveCardsForZone: () => [{ cardType: 'soil' }],
    displayDeviceName: () => 'Chameleon',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: () => null,
    sourceDevicesForCard: () => [chameleon],
    sourceKeyForCsv: () => 'chameleon',
    ...utcDeps(),
  });

  const catalog = await analysis.buildAnalysisCatalog({}, { userId: 7 });

  assert.deepEqual(catalog.channels.map((entry) => entry.channelKey), ['swt_1', 'swt_2', 'swt_3', 'et0_mm', 'etc_mm']);
});

test('buildAnalysisCatalog uses the two canonical Kiwi SWT channels without state', async () => {
  const kiwi = { deveui: '1020304050607080', type_id: 'KIWI_SENSOR' };
  const analysis = analysisModule.createAnalysis({
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: sentekLikeDbAll({ id: 4, zone_uuid: 'zone-4', name: 'Kiwi block' }, kiwi),
    deriveCardsForZone: () => [{ cardType: 'soil' }],
    displayDeviceName: () => 'Kiwi',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: () => null,
    sourceDevicesForCard: () => [kiwi],
    sourceKeyForCsv: () => 'kiwi',
    ...utcDeps(),
  });

  const catalog = await analysis.buildAnalysisCatalog({}, { userId: 7 });

  assert.deepEqual(catalog.channels.map((entry) => entry.channelKey), ['swt_1', 'swt_2', 'et0_mm', 'etc_mm']);
});

test('buildAnalysisCatalog exposes assigned non-Chameleon LSN50 as canonical SWT1/SWT2 with generic depths', async () => {
  const watermark = {
    deveui: '1020304050607081',
    type_id: 'DRAGINO_LSN50',
    chameleon_enabled: 0,
    soil_moisture_probe_depths_json: JSON.stringify({ swt_1: 12, swt_2: 34, swt_3: 56 }),
  };
  const analysis = analysisModule.createAnalysis({
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: sentekLikeDbAll({ id: 5, zone_uuid: 'zone-5', name: 'Watermark block' }, watermark),
    deriveCardsForZone: () => [{ cardType: 'soil' }],
    displayDeviceName: () => 'Watermark',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: hh.soilDepthCm,
    sourceDevicesForCard: () => [watermark],
    sourceKeyForCsv: () => 'watermark',
    ...utcDeps(),
  });

  const catalog = await analysis.buildAnalysisCatalog({}, { userId: 7 });
  const deviceChannels = catalog.channels.filter((entry) => entry.sourceKind === 'device');

  assert.deepEqual(deviceChannels.map((entry) => entry.channelKey), ['swt_1', 'swt_2']);
  assert.deepEqual(deviceChannels.map((entry) => entry.depthCm), [12, 34]);
});

test('device entries keep their pre-weather catalogue and never list a weather-only channel', async () => {
  const raw = weatherDb();
  try {
    const result = await catalog(raw);
    const devices = result.channels.filter((c) => c.sourceKind === 'device').map(({ sourceKind, ...rest }) => rest);
    assert.deepEqual(devices, DEVICE_SNAPSHOT);
    for (const c of result.channels.filter((e) => e.sourceKind === 'device')) {
      assert.ok(!analysisModule.DEVICE_EXCLUDED_CHANNELS.has(c.channelKey), `device source lists ${c.channelKey}`);
    }
  } finally {
    raw.close();
  }
});

test('a located zone lists its provider, station and daily agronomy sources in order', async () => {
  const raw = weatherDb();
  try {
    const result = await catalog(raw);
    const north = result.channels.filter((c) => c.zoneId === 1 && c.sourceKind !== 'device');
    assert.deepEqual(north.map((c) => [c.sourceKind, c.sourceKey, c.deviceName, c.channelKey]), [
      ...['ambient_temperature', 'relative_humidity', 'rain_mm_per_hour', 'wind_speed_mps', 'global_radiation_wm2', 'et0_mm']
        .map((k) => ['weather_provider', `weather-src-${sha12(OPEN_METEO_KEY)}`, 'Open-Meteo 46.80°N 6.95°E', k]),
      ...['ambient_temperature', 'relative_humidity', 'wind_speed_mps', 'barometric_pressure_hpa', 'light_lux', 'global_radiation_wm2', 'rain_mm_per_hour']
        .map((k) => ['weather_station', `station-src-${sha12(STATION)}`, 'demo-s2120 (hourly)', k]),
      ['zone_daily_agronomy', 'agronomy-src-zone', 'North daily agronomy', 'et0_mm'],
      ['zone_daily_agronomy', 'agronomy-src-zone', 'North daily agronomy', 'etc_mm'],
    ]);
    for (const c of north) {
      assert.equal(c.cardType, 'environment');
      assert.equal(c.availability, 'available');
      assert.equal(c.depthCm, null);
      assert.equal(c.hubEui, HUB);
      assert.ok(c.displayName.startsWith(`${c.deviceName} - `), c.displayName);
      assert.equal(c.seriesId, analysisModule.analysisSeriesId(1, 'environment', c.sourceKey, c.channelKey));
    }
    assert.equal(entry(result, 1, 'zone_daily_agronomy', 'etc_mm').displayName, 'North daily agronomy - Crop water demand (ETc)');
    assert.equal(entry(result, 5, 'weather_provider', 'et0_mm').deviceName, 'MeteoSwiss PAY Payerne (12 km)');
    const firstWeather = result.channels.findIndex((c) => c.zoneId === 1 && c.sourceKind !== 'device');
    assert.ok(result.channels.slice(0, firstWeather).every((c) => c.zoneId === 1 && c.sourceKind === 'device'));
  } finally {
    raw.close();
  }
});

test('local zones and zones without a location row get no provider source', async () => {
  const raw = weatherDb();
  try {
    const result = await catalog(raw);
    for (const zoneId of [3, 4]) {
      assert.ok(!result.channels.some((c) => c.zoneId === zoneId && c.sourceKind === 'weather_provider'), `zone ${zoneId}`);
      assert.ok(result.channels.some((c) => c.zoneId === zoneId && c.sourceKind === 'zone_daily_agronomy'), `zone ${zoneId} agronomy`);
    }
    raw.prepare("UPDATE irrigation_zones SET latitude = NULL, longitude = NULL WHERE id = 2").run();
    const noCoordinates = await catalog(raw);
    assert.ok(!noCoordinates.channels.some((c) => c.zoneId === 2 && c.sourceKind === 'weather_provider'));
    assert.equal(entry(noCoordinates, 2, 'zone_daily_agronomy', 'et0_mm').deviceName, 'South daily agronomy');
  } finally {
    raw.close();
  }
});

test('two zones on one location get their own series ids and the same points', async () => {
  const raw = weatherDb();
  try {
    insertProviderHours(raw, OPEN_METEO_KEY, '2026-09-24T21:00:00Z', 6, (i) => ({ temp: 10 + i }));
    const result = await catalog(raw);
    const north = entry(result, 1, 'weather_provider', 'ambient_temperature');
    const south = entry(result, 2, 'weather_provider', 'ambient_temperature');
    assert.equal(north.sourceKey, south.sourceKey);
    assert.notEqual(north.seriesId, south.seriesId);
    const out = await series(raw, [north, south], { from: '2026-09-24T22:00:00.000Z', to: '2026-09-25T02:00:00.000Z' }, 'raw');
    assert.equal(out.series.length, 2);
    assert.deepEqual(out.series[0].points, out.series[1].points);
    assert.equal(out.series[0].points.length, 4);
  } finally {
    raw.close();
  }
});

test('raw provider points sit at hour_start, Open-Meteo readings one hour later, MeteoSwiss at hour_start', async () => {
  const raw = weatherDb();
  try {
    insertProviderHours(raw, OPEN_METEO_KEY, '2026-09-24T21:00:00Z', 5, (i) => ({ temp: 21 + i, rain: i }));
    insertProviderHours(raw, METEOSWISS_KEY, '2026-09-24T21:00:00Z', 5, (i) => ({ temp: 31 + i }));
    const result = await catalog(raw);
    const out = await series(raw, [
      entry(result, 1, 'weather_provider', 'rain_mm_per_hour'),
      entry(result, 1, 'weather_provider', 'ambient_temperature'),
      entry(result, 5, 'weather_provider', 'ambient_temperature'),
    ], { from: '2026-09-24T22:00:00.000Z', to: '2026-09-25T02:00:00.000Z' }, 'raw');
    const [rain, openMeteoTemp, meteoSwissTemp] = out.series;
    assert.deepEqual(rain.points.map((p) => [p.t, p.value]), [
      ['2026-09-24T22:00:00.000Z', 1], ['2026-09-24T23:00:00.000Z', 2], ['2026-09-25T00:00:00.000Z', 3], ['2026-09-25T01:00:00.000Z', 4],
    ]);
    assert.deepEqual(rain.points[0], { t: '2026-09-24T22:00:00.000Z', value: 1, count: 1, expected: null, quality: null });
    assert.deepEqual(openMeteoTemp.points.map((p) => [p.t, p.value]), [
      ['2026-09-24T22:00:00.000Z', 21], ['2026-09-24T23:00:00.000Z', 22], ['2026-09-25T00:00:00.000Z', 23], ['2026-09-25T01:00:00.000Z', 24],
    ]);
    assert.deepEqual(meteoSwissTemp.points.map((p) => [p.t, p.value]), [
      ['2026-09-24T22:00:00.000Z', 32], ['2026-09-24T23:00:00.000Z', 33], ['2026-09-25T00:00:00.000Z', 34], ['2026-09-25T01:00:00.000Z', 35],
    ]);
    assert.equal(rain.unit, 'mm/h');
    assert.equal(rain.cadence, 'hourly');
    assert.equal(rain.timezone, 'Europe/Zurich');
    assert.equal(out.aggregation.applied, 'raw');
  } finally {
    raw.close();
  }
});

// Final fix A5 (queue T3 M2, T1 nit): a stored null value on a hour_start row
// that DOES exist is a null point at that hour, distinct from a missing row
// (which rowsToPoints bridges with an inserted gap point at the previous
// step). No test previously stored a real weather-hours null.
test('a raw hourly point with a stored null value is a null point, not a bridged gap', async () => {
  const raw = weatherDb();
  try {
    insertProviderHours(raw, OPEN_METEO_KEY, '2026-09-24T22:00:00Z', 3, (i) => (i === 1 ? { et0: null } : {}));
    const result = await catalog(raw);
    const et0 = entry(result, 1, 'weather_provider', 'et0_mm');
    const out = await series(raw, [et0], { from: '2026-09-24T22:00:00.000Z', to: '2026-09-25T01:00:00.000Z' }, 'raw');
    assert.deepEqual(out.series[0].points.map((p) => [p.t, p.value, p.count]), [
      ['2026-09-24T22:00:00.000Z', 0.1, 1],
      ['2026-09-24T23:00:00.000Z', null, 0],
      ['2026-09-25T00:00:00.000Z', 0.1, 1],
    ]);
  } finally {
    raw.close();
  }
});

// Final fix A5 (queue T3 M2): the '15m' level is at or below the hourly
// kinds' native step (rowsArePoints), so it must return the same points as
// 'hourly' -- rows, unsplit -- and not fail or silently sub-bucket them.
test('a 15m request for an hourly weather kind returns the stored hourly points unsplit', async () => {
  const raw = weatherDb();
  try {
    insertProviderHours(raw, OPEN_METEO_KEY, '2026-09-24T22:00:00Z', 3);
    const result = await catalog(raw);
    const et0 = entry(result, 1, 'weather_provider', 'et0_mm');
    const range = { from: '2026-09-24T22:00:00.000Z', to: '2026-09-25T01:00:00.000Z' };
    const hourly = await series(raw, [et0], range, 'hourly');
    const fifteenMin = await series(raw, [et0], range, '15m');
    assert.deepEqual(fifteenMin.series[0].points, hourly.series[0].points);
    assert.equal(fifteenMin.series[0].points.length, 3);
  } finally {
    raw.close();
  }
});

// Final fix A5 (queue T3 M2): the router relies on process.env, not an
// option, for the deployment default -- every other test passes
// weatherProviderDefault explicitly, so a broken env read would pass every
// other suite (final review, "test suites that would pass with the feature
// broken").
test('the deployment default falls back to process.env.OSI_WEATHER_PROVIDER_DEFAULT when the option is omitted', async () => {
  const raw = weatherDb();
  try {
    raw.prepare("UPDATE irrigation_zones SET weather_source = 'auto' WHERE id = 1").run();
    raw.prepare("INSERT INTO weather_locations (location_key, provider, latitude, longitude) VALUES ('meteoswiss:46.80:6.95', 'meteoswiss', 46.8, 6.95)").run();
    const previous = process.env.OSI_WEATHER_PROVIDER_DEFAULT;
    process.env.OSI_WEATHER_PROVIDER_DEFAULT = 'meteoswiss';
    try {
      const result = await hh.buildAnalysisCatalog(facade(raw), { userId: 1, deviceEui: HUB });
      assert.equal(entry(result, 1, 'weather_provider', 'et0_mm').deviceName, 'MeteoSwiss 46.80°N 6.95°E');
    } finally {
      if (previous === undefined) delete process.env.OSI_WEATHER_PROVIDER_DEFAULT;
      else process.env.OSI_WEATHER_PROVIDER_DEFAULT = previous;
    }
  } finally {
    raw.close();
  }
});

test('daily provider buckets are Zurich days: rain and ET0 summed, temperature averaged', async () => {
  const raw = weatherDb();
  try {
    // 2026-09-24T22:00Z is 00:00 on 25 September in Zurich (CEST).
    insertProviderHours(raw, OPEN_METEO_KEY, '2026-09-23T21:00:00Z', 49, (i) => ({ rain: i === 25 ? 1 : 0 }));
    const result = await catalog(raw);
    const out = await series(raw, [
      entry(result, 1, 'weather_provider', 'rain_mm_per_hour'),
      entry(result, 1, 'weather_provider', 'et0_mm'),
      entry(result, 1, 'weather_provider', 'ambient_temperature'),
    ], { from: '2026-09-23T22:00:00.000Z', to: '2026-09-25T22:00:00.000Z' }, 'daily');
    const [rain, et0, temp] = out.series;
    assert.deepEqual(rain.points.map((p) => [p.t, p.value, p.count, p.expected, p.quality]), [
      ['2026-09-23T22:00:00.000Z', 0, 24, 24, null],
      ['2026-09-24T22:00:00.000Z', 1, 24, 24, null],
    ]);
    assert.deepEqual(et0.points.map((p) => p.value), [2.4, 2.4]);
    // A mean channel (final review I2) is marked partial the same as a sum:
    // full days here, so expected is set but quality stays null.
    assert.deepEqual(temp.points.map((p) => [p.value, p.expected, p.quality]), [[10, 24, null], [10, 24, null]]);
    assert.equal(rain.unit, 'mm/d');
    assert.equal(temp.unit, '°C');
    assert.equal(rain.cadence, 'daily');
  } finally {
    raw.close();
  }
});

test('series units name the period and device series keep theirs', async () => {
  const raw = weatherDb();
  try {
    insertProviderHours(raw, OPEN_METEO_KEY, '2026-09-11T21:00:00Z', 14 * 24 + 1);
    const result = await catalog(raw);
    const rain = entry(result, 1, 'weather_provider', 'rain_mm_per_hour');
    const deviceRain = result.channels.find((c) => c.zoneId === 1 && c.sourceKind === 'device' && c.deviceName === 'demo-s2120' && c.channelKey === 'rain_mm_per_hour');
    const twoDays = { from: '2026-09-23T22:00:00.000Z', to: '2026-09-25T22:00:00.000Z' };
    const hourly = await series(raw, [rain, deviceRain], twoDays, 'hourly');
    assert.deepEqual(hourly.series.map((s) => [s.unit, s.cadence]), [['mm/h', 'hourly'], ['mm/h', 'hourly']]);
    const daily = await series(raw, [rain, deviceRain], twoDays, 'daily');
    assert.deepEqual(daily.series.map((s) => [s.unit, s.cadence]), [['mm/d', 'daily'], ['mm/h', 'hourly']]);
    const weekly = await series(raw, [rain], { from: '2026-09-11T22:00:00.000Z', to: '2026-09-25T22:00:00.000Z' }, 'weekly');
    assert.equal(weekly.series[0].unit, 'mm/wk');
    assert.equal(weekly.series[0].cadence, 'hourly');
    assert.deepEqual(weekly.series[0].points.map((p) => [p.value, p.count, p.expected, p.quality]), [[84, 168, 168, null], [84, 168, 168, null]]);
    assert.equal(daily.series[1].points[0].expected, undefined, 'device points carry no expected key');
  } finally {
    raw.close();
  }
});

test('summed buckets with missing rows are partial', async () => {
  const raw = weatherDb();
  try {
    insertProviderHours(raw, OPEN_METEO_KEY, '2026-09-23T21:00:00Z', 49, (i) => (i === 6 ? { skip: true } : {}));
    const result = await catalog(raw);
    const et0 = entry(result, 1, 'weather_provider', 'et0_mm');
    const daily = await series(raw, [et0], { from: '2026-09-23T22:00:00.000Z', to: '2026-09-25T22:00:00.000Z' }, 'daily');
    assert.deepEqual(daily.series[0].points.map((p) => [p.value, p.count, p.expected, p.quality]), [
      [2.3, 23, 24, 'partial'],
      [2.4, 24, 24, null],
    ]);
    // A range starting at 06:00 local: its first day has 18 hours.
    const late = await series(raw, [et0], { from: '2026-09-24T04:00:00.000Z', to: '2026-09-25T22:00:00.000Z' }, 'daily');
    assert.deepEqual(late.series[0].points.map((p) => [p.t, p.count, p.quality]), [
      ['2026-09-24T04:00:00.000Z', 18, 'partial'],
      ['2026-09-24T22:00:00.000Z', 24, null],
    ]);

    insertAgronomyDays(raw, 1, Array.from({ length: 14 }, (_, i) => {
      const date = `2026-09-${String(14 + i).padStart(2, '0')}`;
      return { date, et0: date === '2026-09-16' ? null : 1, etc: 1 };
    }));
    const agronomy = await series(raw, [entry(result, 1, 'zone_daily_agronomy', 'et0_mm')], { from: '2026-09-13T22:00:00.000Z', to: '2026-09-27T22:00:00.000Z' }, 'weekly');
    assert.deepEqual(agronomy.series[0].points.map((p) => [p.value, p.count, p.expected, p.quality]), [
      [6, 6, 7, 'partial'],
      [7, 7, 7, null],
    ]);
    assert.equal(agronomy.series[0].unit, 'mm/wk');
  } finally {
    raw.close();
  }
});

// Final fix A3 (review I2): a mean channel is marked partial exactly like a
// sum channel; before this fix aggToPoints set expected/quality for 'sum'
// channels only, so a 9-of-24-hour mean looked like a full day's mean.
test('a mean channel is marked partial too, not only a sum', async () => {
  const raw = weatherDb();
  try {
    // Zurich day 2026-09-24 (hour_start 2026-09-23T22:00Z..2026-09-24T21:00Z
    // after the Open-Meteo +1h plot offset) keeps only its first 9 hours;
    // 2026-09-25 is left whole.
    insertProviderHours(raw, OPEN_METEO_KEY, '2026-09-23T21:00:00Z', 49, (i) => (i >= 9 && i < 24 ? { skip: true } : {}));
    const result = await catalog(raw);
    const temp = entry(result, 1, 'weather_provider', 'ambient_temperature');
    const daily = await series(raw, [temp], { from: '2026-09-23T22:00:00.000Z', to: '2026-09-25T22:00:00.000Z' }, 'daily');
    assert.deepEqual(daily.series[0].points.map((p) => [p.value, p.count, p.expected, p.quality]), [
      [10, 9, 24, 'partial'],
      [10, 24, 24, null],
    ]);
  } finally {
    raw.close();
  }
});

// Final fix A2 (review T3 I1): weekly buckets of the zone_daily_agronomy
// kind step by seven zone-local dates, not a fixed 168-hour span, so a week
// across the spring clock change still holds exactly seven dates.
test('weekly agronomy buckets across the spring clock change are seven local days, not a fixed 168-hour span', async () => {
  const raw = weatherDb();
  try {
    const dates = Array.from({ length: 14 }, (_, i) => new Date(Date.parse('2026-03-23T00:00:00.000Z') + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
    insertAgronomyDays(raw, 1, dates.map((date) => ({ date, et0: 1, etc: 1 })));
    const result = await catalog(raw);
    // 2026-03-22T23:00Z is Zurich midnight of 23 March (CET); 2026-04-05T22:00Z
    // is Zurich midnight of 6 April (CEST, after the 29 March change) -- two
    // exact weeks. A fixed 168h span pulls an eighth date into the first
    // bucket here (count 8, final review I3 probe); local-date stepping
    // keeps both buckets at exactly seven.
    const out = await series(raw, [entry(result, 1, 'zone_daily_agronomy', 'et0_mm')], { from: '2026-03-22T23:00:00.000Z', to: '2026-04-05T22:00:00.000Z' }, 'weekly');
    assert.deepEqual(out.series[0].points.map((p) => [p.count, p.expected, p.quality]), [
      [7, 7, null],
      [7, 7, null],
    ]);

    // A range that does not divide into whole weeks: the trailing partial
    // week is still marked partial, not silently over- or under-counted.
    const partial = await series(raw, [entry(result, 1, 'zone_daily_agronomy', 'et0_mm')], { from: '2026-03-22T23:00:00.000Z', to: '2026-04-01T22:00:00.000Z' }, 'weekly');
    assert.deepEqual(partial.series[0].points.map((p) => [p.count, p.expected, p.quality]), [
      [7, 7, null],
      [3, 7, 'partial'],
    ]);
  } finally {
    raw.close();
  }
});

// Final fix A4 (review T3 M1): a database missing a weather table degrades
// to a device-only catalogue with one process warning instead of a 500, and
// a weather selector that can no longer resolve is reported as dropped with
// a distinct reason.
test('missing weather tables degrade to a device-only catalogue with one process warning, not a 500', async () => {
  const raw = weatherDb();
  try {
    for (const name of ['weather_provider_hours', 'weather_station_hours', 'zone_daily_agronomy', 'weather_locations']) {
      raw.exec(`DROP TABLE ${name}`);
    }
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    let first;
    let second;
    try {
      first = await catalog(raw);
      second = await catalog(raw);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1, 'one warning for the process, not one per request');
    assert.ok(first.channels.length > 0, 'device sources are still listed');
    assert.ok(first.channels.every((c) => c.sourceKind === 'device'));
    assert.equal(first.weatherAvailable, false);
    assert.deepEqual(second.channels.map((c) => c.seriesId), first.channels.map((c) => c.seriesId));

    const missing = await series(raw, [{ seriesId: 'deadbeefdeadbeef00' }], { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' }, 'raw');
    assert.deepEqual(missing.dropped, [{ seriesId: 'deadbeefdeadbeef00', reason: 'source_unavailable' }]);
  } finally {
    raw.close();
  }
});

test('station hours: a five-hour hole breaks the raw line once; rain summed, pressure averaged', async () => {
  const raw = weatherDb();
  try {
    insertStationHours(raw, STATION, '2026-09-24T22:00:00Z', 9, (i) => (i >= 2 && i <= 6 ? { skip: true } : { temp: 10 + i }));
    const result = await catalog(raw);
    const temp = entry(result, 1, 'weather_station', 'ambient_temperature');
    const rawOut = await series(raw, [temp], { from: '2026-09-24T22:00:00.000Z', to: '2026-09-25T07:00:00.000Z' }, 'raw');
    assert.deepEqual(rawOut.series[0].points.map((p) => [p.t, p.value]), [
      ['2026-09-24T22:00:00.000Z', 10],
      ['2026-09-24T23:00:00.000Z', 11],
      ['2026-09-25T00:00:00.000Z', null],
      ['2026-09-25T05:00:00.000Z', 17],
      ['2026-09-25T06:00:00.000Z', 18],
    ]);

    raw.prepare('DELETE FROM weather_station_hours').run();
    insertStationHours(raw, STATION, '2026-09-23T22:00:00Z', 48, (i) => ({ pressure: i % 2 ? 1010 : 1000 }));
    const daily = await series(raw, [
      entry(result, 1, 'weather_station', 'rain_mm_per_hour'),
      entry(result, 1, 'weather_station', 'barometric_pressure_hpa'),
    ], { from: '2026-09-23T22:00:00.000Z', to: '2026-09-25T22:00:00.000Z' }, 'daily');
    assert.deepEqual(daily.series[0].points.map((p) => p.value), [4.8, 4.8]);
    assert.deepEqual(daily.series[1].points.map((p) => p.value), [1005, 1005]);
    assert.equal(daily.series[1].unit, 'hPa');
  } finally {
    raw.close();
  }
});

test('daily agronomy points sit at Zurich midnight across the October clock change', async () => {
  const raw = weatherDb();
  try {
    insertAgronomyDays(raw, 1, [
      { date: '2026-10-23', et0: 1.2, etc: 0.9 },
      { date: '2026-10-24', et0: null, etc: null },
      { date: '2026-10-25', et0: 1.1, etc: 0.8 },
      { date: '2026-10-27', et0: 0.9, etc: 0.7 },
    ]);
    const result = await catalog(raw);
    const out = await series(raw, [entry(result, 1, 'zone_daily_agronomy', 'et0_mm')], { from: '2026-10-22T22:00:00.000Z', to: '2026-10-27T23:00:00.000Z' }, 'daily');
    assert.deepEqual(out.series[0].points, [
      { t: '2026-10-22T22:00:00.000Z', value: 1.2, count: 1, expected: null, quality: null },
      { t: '2026-10-23T22:00:00.000Z', value: null, count: 0, expected: null, quality: null },
      { t: '2026-10-24T22:00:00.000Z', value: 1.1, count: 1, expected: null, quality: null },
      { t: '2026-10-25T23:00:00.000Z', value: null, count: 0, expected: null, quality: null },
      { t: '2026-10-26T23:00:00.000Z', value: 0.9, count: 1, expected: null, quality: null },
    ]);
    assert.equal(out.series[0].unit, 'mm/d');
    assert.equal(out.series[0].cadence, 'daily');
  } finally {
    raw.close();
  }
});

test('scope: listed zones bound the weather entries; legacy mode filters the station by owner', async () => {
  const raw = weatherDb();
  try {
    const scoped = await catalog(raw, { zoneUuids: ['z-south'] });
    assert.deepEqual([...new Set(scoped.channels.map((c) => c.zoneId))], [2]);
    assert.ok(scoped.channels.some((c) => c.sourceKind === 'weather_provider'));
    const scopedNorth = await catalog(raw, { zoneUuids: ['z-north'] });
    assert.deepEqual([...new Set(scopedNorth.channels.filter((c) => c.sourceKind === 'weather_station').map((c) => c.deviceName))], ['demo-s2120 (hourly)', 'foreign-s2120 (hourly)']);
    const legacy = await catalog(raw);
    assert.deepEqual([...new Set(legacy.channels.filter((c) => c.sourceKind === 'weather_station').map((c) => c.deviceName))], ['demo-s2120 (hourly)']);
    assert.ok(!legacy.channels.some((c) => c.zoneId === 6), 'the other user\'s zone stays out');
  } finally {
    raw.close();
  }
});

test('the 30 000-row cap counts provider, station and device rows together', async () => {
  const raw = weatherDb();
  try {
    const from = '2025-08-22T00:00:00.000Z';
    const to = '2026-09-26T00:00:00.000Z';
    raw.exec('BEGIN');
    insertProviderHours(raw, OPEN_METEO_KEY, from, 9600);
    insertStationHours(raw, STATION, from, 9600);
    const insert = raw.prepare('INSERT INTO device_data (deveui, recorded_at, rain_mm_per_hour) VALUES (?, ?, ?)');
    for (let i = 0; i < 12000; i += 1) insert.run(STATION, new Date(Date.parse(from) + i * 48 * 60000).toISOString(), 0);
    raw.exec('COMMIT');
    const result = await catalog(raw);
    const provider = entry(result, 1, 'weather_provider', 'rain_mm_per_hour');
    const station = entry(result, 1, 'weather_station', 'rain_mm_per_hour');
    const device = result.channels.find((c) => c.zoneId === 1 && c.sourceKind === 'device' && c.deviceName === 'demo-s2120' && c.channelKey === 'rain_mm_per_hour');
    const under = await series(raw, [provider, station], { from, to }, 'weekly');
    assert.equal(under.series.length, 2);
    await assert.rejects(
      series(raw, [provider, station, device], { from, to }, 'weekly'),
      (error) => error.statusCode === 413 && error.suggestion === 'Narrow the date range or pick a coarser granularity.'
    );
  } finally {
    raw.close();
  }
});

test('a failing zoneLocations makes the catalogue reject with its error', async () => {
  const analysis = analysisModule.createAnalysis({
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: async (_db, sql) => {
      if (sql.includes('sqlite_master')) return WEATHER_TABLES_PRESENT_ROWS;
      return sql.includes('FROM irrigation_zones') ? [{ id: 1, zone_uuid: 'z-1', name: 'North' }] : [];
    },
    deriveCardsForZone: () => [],
    displayDeviceName: () => 'Device',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: () => null,
    sourceDevicesForCard: () => [],
    sourceKeyForCsv: () => 'source-key',
    ...utcDeps(),
    zoneLocations: async () => { throw new Error('weather store broken'); },
  });
  await assert.rejects(analysis.buildAnalysisCatalog({}, { userId: 1 }), /weather store broken/);
});

// The router hands buildAnalysisCatalog an osi-db-helper handle; this run
// binds the real facade (sqlite3 swapped for node:sqlite, as in
// ../osi-weather-provider/facade-contract.test.js) so the zoneLocations
// adapter is exercised as the router exercises it.
const DB_HELPER_PATH = path.join(__dirname, '..', 'osi-db-helper', 'index.js');
// BEGIN copied verbatim from ../osi-weather-provider/facade-contract.test.js lines 31-103
function sqlite3Adapter() {
  class Database {
    constructor(filename, mode, callback) {
      if (typeof mode === 'function') {
        callback = mode;
        mode = undefined;
      }
      this.native = new DatabaseSync(filename, { readOnly: mode === 1 });
      queueMicrotask(() => callback && callback.call(this, null));
    }

    all(sql, params, callback) {
      if (typeof params === 'function') {
        callback = params;
        params = [];
      }
      try {
        const rows = this.native.prepare(sql).all(...(params || []));
        callback.call(this, null, rows);
      } catch (error) {
        callback.call(this, error);
      }
    }

    run(sql, params, callback) {
      if (typeof params === 'function') {
        callback = params;
        params = [];
      }
      try {
        const result = this.native.prepare(sql).run(...(params || []));
        callback.call({ changes: Number(result.changes) }, null);
      } catch (error) {
        callback.call(this, error);
      }
    }

    exec(sql, callback) {
      try {
        this.native.exec(sql);
        callback.call(this, null);
      } catch (error) {
        callback.call(this, error);
      }
    }

    close(callback) {
      try {
        this.native.close();
        callback.call(this, null);
      } catch (error) {
        callback.call(this, error);
      }
    }
  }
  return { Database, OPEN_READONLY: 1, OPEN_READWRITE: 2, OPEN_CREATE: 4 };
}

function loadOsiDbHelper() {
  const original = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'sqlite3' && parent && parent.filename === DB_HELPER_PATH) {
      return sqlite3Adapter();
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(DB_HELPER_PATH)];
    return require(DB_HELPER_PATH);
  } finally {
    Module._load = original;
  }
}
// END copied

test('the catalogue reads weather sources through a real osi-db-helper handle', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-facade-'));
  const dbPath = path.join(dir, 'farming.db');
  const seed = new DatabaseSync(dbPath);
  seed.exec(SEED);
  seed.exec(WEATHER_FIXTURE);
  seed.close();
  const osiDb = loadOsiDbHelper();
  const db = new osiDb.Database(dbPath);
  try {
    const result = await hh.buildAnalysisCatalog(db, { userId: 1, deviceEui: HUB, weatherProviderDefault: 'open_meteo' });
    assert.equal(entry(result, 1, 'weather_provider', 'et0_mm').deviceName, 'Open-Meteo 46.80°N 6.95°E');
    assert.equal(entry(result, 1, 'weather_station', 'light_lux').deviceName, 'demo-s2120 (hourly)');
  } finally {
    await new Promise((resolve) => db.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Review Focus 1: the clock-change days of a Zurich zone.
test('the 23-hour spring day is marked partial and the 25-hour autumn day is not', async () => {
  const raw = weatherDb();
  try {
    // 29 March 2026 runs 28T23:00Z..29T22:00Z (23 h); 25 October 2026 runs 24T22:00Z..25T23:00Z (25 h).
    insertProviderHours(raw, OPEN_METEO_KEY, '2026-03-28T22:00:00Z', 25);
    insertProviderHours(raw, OPEN_METEO_KEY, '2026-10-24T21:00:00Z', 27);
    const result = await catalog(raw);
    const et0 = entry(result, 1, 'weather_provider', 'et0_mm');
    const spring = await series(raw, [et0], { from: '2026-03-28T23:00:00.000Z', to: '2026-03-29T22:00:00.000Z' }, 'daily');
    assert.deepEqual(spring.series[0].points.map((p) => [p.t, p.count, p.expected, p.quality]), [['2026-03-28T23:00:00.000Z', 23, 24, 'partial']]);
    const autumn = await series(raw, [et0], { from: '2026-10-24T22:00:00.000Z', to: '2026-10-25T23:00:00.000Z' }, 'daily');
    assert.deepEqual(autumn.series[0].points.map((p) => [p.t, p.count, p.expected, p.quality]), [['2026-10-24T22:00:00.000Z', 25, 24, null]]);
  } finally {
    raw.close();
  }
});

// Review Focus 2: a provider change drops the old provider series from a saved view.
test('a saved view reports the provider series a provider change dropped', async () => {
  const raw = weatherDb();
  try {
    const before = await catalog(raw);
    const oldRain = entry(before, 1, 'weather_provider', 'rain_mm_per_hour');
    const kept = before.channels.find((c) => c.zoneId === 1 && c.sourceKind === 'device');
    raw.exec(analysisModule.ANALYSIS_VIEWS_SCHEMA);
    raw.prepare('INSERT INTO analysis_views (user_id, name, view_json) VALUES (1, ?, ?)')
      .run('weather-acceptance', JSON.stringify({ schemaVersion: 1, name: 'weather-acceptance', selectors: [{ seriesId: oldRain.seriesId }, { seriesId: kept.seriesId }] }));
    raw.prepare("UPDATE irrigation_zones SET weather_source = 'meteoswiss' WHERE id = 1").run();
    raw.prepare("INSERT INTO weather_locations (location_key, provider, latitude, longitude) VALUES ('meteoswiss:46.80:6.95', 'meteoswiss', 46.8, 6.95)").run();
    const [view] = await hh.listAnalysisViews(facade(raw), { userId: 1, deviceEui: HUB, weatherProviderDefault: 'open_meteo' });
    assert.deepEqual(view.droppedSeriesIds, [oldRain.seriesId]);
    assert.deepEqual(view.selectors.map((s) => s.seriesId), [kept.seriesId]);
    const after = await catalog(raw);
    assert.equal(entry(after, 1, 'weather_provider', 'rain_mm_per_hour').deviceName, 'MeteoSwiss 46.80°N 6.95°E');
  } finally {
    raw.close();
  }
});

// Review Focus 3: a zone timezone Intl does not know falls back to UTC.
test('an invalid zone timezone places daily points at UTC midnight', async () => {
  const raw = weatherDb();
  try {
    raw.prepare("UPDATE irrigation_zones SET timezone = 'Mars/Olympus' WHERE id = 1").run();
    insertAgronomyDays(raw, 1, [{ date: '2026-09-24', et0: 2, etc: 1.5 }, { date: '2026-09-25', et0: 3, etc: 2 }]);
    const result = await catalog(raw);
    const out = await series(raw, [entry(result, 1, 'zone_daily_agronomy', 'et0_mm')], { from: '2026-09-24T00:00:00.000Z', to: '2026-09-26T00:00:00.000Z' }, 'daily');
    assert.equal(out.series[0].timezone, 'UTC');
    assert.deepEqual(out.series[0].points.map((p) => [p.t, p.value]), [['2026-09-24T00:00:00.000Z', 2], ['2026-09-25T00:00:00.000Z', 3]]);
  } finally {
    raw.close();
  }
});

// Review Focus 4: coordinates south of the equator and west of Greenwich.
test('a provider source south and west of zero names its hemispheres', async () => {
  const raw = weatherDb();
  try {
    raw.prepare('UPDATE irrigation_zones SET latitude = -1.2833, longitude = -36.8167 WHERE id = 2').run();
    raw.prepare("INSERT INTO weather_locations (location_key, provider, latitude, longitude) VALUES ('open_meteo:-1.28:-36.82', 'open_meteo', -1.28, -36.82)").run();
    const result = await catalog(raw);
    assert.equal(entry(result, 2, 'weather_provider', 'et0_mm').deviceName, 'Open-Meteo 1.28°S 36.82°W');
  } finally {
    raw.close();
  }
});

// Review Focus 5: a re-resolved MeteoSwiss station keeps the series and takes the new name.
test('a re-resolved MeteoSwiss station keeps the series ids and shows the new station', async () => {
  const raw = weatherDb();
  try {
    const before = entry(await catalog(raw), 5, 'weather_provider', 'rain_mm_per_hour');
    raw.prepare("UPDATE weather_locations SET station_id = 'MAH', station_name = 'Mathod', station_distance_km = NULL WHERE location_key = ?").run(METEOSWISS_KEY);
    const after = entry(await catalog(raw), 5, 'weather_provider', 'rain_mm_per_hour');
    assert.equal(after.seriesId, before.seriesId);
    assert.equal(after.deviceName, 'MeteoSwiss MAH Mathod');
    raw.prepare("UPDATE irrigation_zones SET name = '  ' WHERE id = 5").run();
    assert.equal(entry(await catalog(raw), 5, 'zone_daily_agronomy', 'et0_mm').deviceName, 'Zone 5 daily agronomy');
  } finally {
    raw.close();
  }
});

// Final fix A1 (review I3, queue T3 I2): a 399-day daily request over 13
// weather series must resolve under 1.5s on this workstation. Skipped by
// default (it inserts ~19k rows and is a timing assertion, not a behaviour
// one); set OSI_BENCH=1 to run it. Before the fix (measured against the
// pre-fix index.js/analysis.js from this branch's HEAD, three runs): ~3.8s.
// After: ~0.6s (see the final fix report for the full before/after numbers).
test('benchmark: 399 days, daily, 13 weather series, Europe/Zurich', { skip: process.env.OSI_BENCH === '1' ? false : 'set OSI_BENCH=1 to run' }, async () => {
  const raw = weatherDb();
  try {
    const days = 399;
    const hours = days * 24;
    raw.exec('BEGIN');
    insertProviderHours(raw, OPEN_METEO_KEY, '2025-08-20T00:00:00Z', hours);
    insertStationHours(raw, STATION, '2025-08-20T00:00:00Z', hours);
    raw.exec('COMMIT');
    const result = await catalog(raw);
    const selected = result.channels.filter((c) => c.zoneId === 1 && (c.sourceKind === 'weather_provider' || c.sourceKind === 'weather_station'));
    assert.equal(selected.length, 13, 'six provider + seven station channels');
    const to = Date.parse('2025-08-20T00:00:00Z') + hours * HOUR;
    const from = to - days * 24 * HOUR;
    const range = { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
    const startedAt = Date.now();
    const out = await series(raw, selected, range, 'daily');
    const elapsedMs = Date.now() - startedAt;
    assert.equal(out.series.length, 13);
    console.log(`[benchmark] 399 days, daily, 13 weather series, Europe/Zurich: ${elapsedMs} ms`);
    assert.ok(elapsedMs < 1500, `expected under 1500ms, got ${elapsedMs}ms`);
  } finally {
    raw.close();
  }
});
