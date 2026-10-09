#!/usr/bin/env node
'use strict';

// The rolling 7-day rain of dendro-compute-fn covers the seven calendar days
// ending on the zone-local analytics date: the six prior days from stored
// recommendations plus the analytics day itself. A missing or unknown day adds
// nothing and is counted, so the sum is a lower bound, never a silent zero day.
// Unknown rain on the analytics day keeps the recommendation and marks it
// rain_unknown; it never starts dendro rain suppression.
//
// Runs the shipped function body against an in-memory database on
// seed-blank.sql, with a fixed clock and a stubbed HTTP module (the node never
// leaves the process).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { facadeDb, loadNode } = require('./lib/flow-node-harness');

const ROOT = path.resolve(__dirname, '..');
const SEED = path.join(ROOT, 'database/seed-blank.sql');
const PROFILES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share',
];
const NOW_ISO = '2026-10-09T03:00:00.000Z';
const TREE = 'A840410000000001';

function makeFixedDate(iso) {
  const RealDate = Date;
  return class FixedDate extends RealDate {
    constructor(...args) {
      super(args.length ? args[0] : iso);
    }
    static now() { return RealDate.parse(iso); }
    static parse(value) { return RealDate.parse(value); }
    static UTC(...args) { return RealDate.UTC(...args); }
  };
}

// Answers every request with one canned response; records the URLs asked for.
function stubHttp(weather, calls) {
  return {
    request(url, _options, onResponse) {
      calls.push(String(url));
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.write = () => {};
      req.destroy = (error) => process.nextTick(() => req.emit('error', error));
      req.end = () => {
        process.nextTick(() => {
          const res = new EventEmitter();
          res.statusCode = weather.status;
          onResponse(res);
          if (weather.body != null) res.emit('data', JSON.stringify(weather.body));
          res.emit('end');
        });
      };
      return req;
    },
  };
}

function openMeteoDay(rainTotalMm) {
  // 24 hourly values; only the first carries the day's total so rounding stays exact.
  const precipitation = Array.from({ length: 24 }, (_, i) => (i === 0 ? rainTotalMm : 0));
  return {
    status: 200,
    body: {
      hourly: {
        temperature_2m: Array(24).fill(18),
        relative_humidity_2m: Array(24).fill(70),
        precipitation,
      },
    },
  };
}

// A provider answer with temperature and humidity but no usable precipitation hour:
// the key absent, or present with only nulls.
function openMeteoTemperatureOnly({ nullPrecipitation = false } = {}) {
  const hourly = { temperature_2m: Array(24).fill(18), relative_humidity_2m: Array(24).fill(70) };
  if (nullPrecipitation) hourly.precipitation = Array(24).fill(null);
  return { status: 200, body: { hourly } };
}

function seedDb({ timezone = 'UTC', withLocation = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(SEED, 'utf8'));
  db.exec(`
    INSERT INTO users(id, username, password_hash, created_at)
    VALUES (1, 'fixture', 'not-a-real-password', '${NOW_ISO}');
    INSERT INTO irrigation_zones(id, name, user_id, created_at, updated_at, timezone, latitude, longitude)
    VALUES (1, 'Fixture Zone', 1, '${NOW_ISO}', '${NOW_ISO}', '${timezone}',
            ${withLocation ? '46.5' : 'NULL'}, ${withLocation ? '7.5' : 'NULL'});
    INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at, irrigation_zone_id, dendro_enabled, is_reference_tree)
    VALUES ('${TREE}', 'Fixture Tree', 'DRAGINO_LSN50', 1, '${NOW_ISO}', '${NOW_ISO}', 1, 1, 0);
  `);
  return db;
}

function addRecommendation(db, date, rainfallMm, extra = {}) {
  const stress = extra.stress || 'none';
  db.prepare(`
    INSERT INTO zone_daily_recommendations(zone_id, date, zone_stress_summary, rainfall_mm, irrigation_action, recommendation_json, computed_at)
    VALUES (1, ?, ?, ?, 'maintain', ?, ?)
  `).run(date, stress, rainfallMm, extra.raw != null ? extra.raw : (extra.json == null ? null : JSON.stringify(extra.json)), NOW_ISO);
}

function addLocalRain(db, date, rainfallMm) {
  db.prepare(`
    INSERT INTO zone_daily_environment(zone_id, date, rainfall_mm, flow_liters, rain_source, computed_at)
    VALUES (1, ?, ?, 0, 'aquascope_lorain', ?)
  `).run(date, rainfallMm, NOW_ISO);
}

// One tree with a complete, unstressed analytics day, so the zone reaches the
// rolling-rain rule of irrDecision (the readings mirror the dendro golden vectors).
function addUnstressedTreeDay(db, date) {
  db.exec(`
    INSERT INTO dendro_baselines(deveui, mds_max_reference_um, mds_mean_um, baseline_days, baseline_complete, computed_at)
    VALUES ('${TREE}', 45, 38, 14, 1, '${NOW_ISO}');
  `);
  const readings = [
    [121, '05:05:00'], [124, '05:35:00'], [122, '06:10:00'], [108, '09:00:00'],
    [92, '13:05:00'], [90, '14:00:00'], [93, '15:30:00'], [101, '18:00:00'],
  ];
  const insert = db.prepare('INSERT INTO dendrometer_readings(deveui, position_um, is_valid, recorded_at) VALUES (?, ?, 1, ?)');
  for (const [position, time] of readings) insert.run(TREE, position, `${date}T${time}.000Z`);
}

async function runDendro(db, { weather = { status: 500, body: null }, profile = PROFILES[0], envVars = {}, now = NOW_ISO } = {}) {
  const flowsPath = path.join(ROOT, profile, 'flows.json');
  const moduleDir = path.join(ROOT, profile, 'node-red/osi-dendro-analytics');
  const node = loadNode('dendro-compute-fn', flowsPath);
  const facade = facadeDb(db);
  const calls = [];
  const errors = [];
  const warnings = [];
  const fakeNode = {
    error: (value) => errors.push(String(value)),
    warn: (value) => warnings.push(String(value)),
    log: () => {},
    status: () => {},
  };
  const osiDb = { Database: function Database() { return facade; } };
  const osiLib = {
    require(name) {
      if (name !== 'dendro-analytics') return { ok: false, error: `unexpected helper ${name}` };
      return { ok: true, value: require(moduleDir) }; // eslint-disable-line global-require
    },
  };
  const http = stubHttp(weather, calls);
  const fakeRequire = (name) => (name === 'http' || name === 'https' ? http : require(name)); // eslint-disable-line global-require
  const env = { get: (key) => (Object.prototype.hasOwnProperty.call(envVars, key) ? envVars[key] : '') };
  // eslint-disable-next-line no-new-func
  const fn = new Function('osiDb', 'osiLib', 'env', 'node', 'msg', 'require', 'Date', node.func);
  const result = await fn(osiDb, osiLib, env, fakeNode, {}, fakeRequire, makeFixedDate(now));
  assert.deepEqual(errors, [], 'dendro-compute-fn reported errors');
  return { result, calls, warnings };
}

function recommendation(db, date) {
  const row = db.prepare('SELECT * FROM zone_daily_recommendations WHERE zone_id = 1 AND date = ?').get(date);
  assert.ok(row, `a recommendation row exists for ${date}`);
  return { row, json: JSON.parse(row.recommendation_json) };
}

for (const profile of PROFILES) {
  const tag = profile.includes('bcm2709') ? 'bcm2709' : 'bcm2712';

  test(`[${tag}] seven prior 1 mm days plus a 1 mm analytics day sum to 7 mm over seven calendar days`, async () => {
    const db = seedDb();
    for (const date of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']) {
      addRecommendation(db, date, 1);
    }
    addLocalRain(db, '2026-10-08', 1);
    const { calls } = await runDendro(db, { weather: openMeteoDay(0), profile });
    assert.ok(calls.length >= 1, 'the weather provider was asked (stubbed)');
    const { json } = recommendation(db, '2026-10-08');
    assert.equal(json.rain.daily_mm, 1);
    assert.equal(json.rain.rolling7d, 7);
    assert.equal(json.rain.rolling7d_days_present, 7);
    assert.deepEqual(json.rain.rolling7d_window, { from: '2026-10-02', to: '2026-10-08' });
    db.close();
  });

  test(`[${tag}] sparse history never reaches outside the seven-day window`, async () => {
    const db = seedDb();
    for (const date of ['2026-09-01', '2026-09-15', '2026-10-06']) addRecommendation(db, date, 1);
    addLocalRain(db, '2026-10-08', 1);
    await runDendro(db, { weather: openMeteoDay(0), profile });
    const { json } = recommendation(db, '2026-10-08');
    assert.equal(json.rain.rolling7d, 2);
    assert.equal(json.rain.rolling7d_days_present, 2);
    db.close();
  });

  test(`[${tag}] the window follows the zone-local analytics date`, async () => {
    // 03:00Z on 9 October is the evening of 8 October in Los Angeles, so the
    // analytics date is 7 October and the window is 1..7 October.
    const db = seedDb({ timezone: 'America/Los_Angeles' });
    for (const date of ['2026-09-30', '2026-10-01', '2026-10-04', '2026-10-06']) addRecommendation(db, date, 2);
    await runDendro(db, { weather: openMeteoDay(0.5), profile });
    const { json } = recommendation(db, '2026-10-07');
    assert.deepEqual(json.rain.rolling7d_window, { from: '2026-10-01', to: '2026-10-07' });
    assert.equal(json.rain.daily_mm, 0.5);
    assert.equal(json.rain.rolling7d, 6.5);
    assert.equal(json.rain.rolling7d_days_present, 4);
    db.close();
  });

  test(`[${tag}] a stored null day or a day whose rain was unknown is missing, not a zero day`, async () => {
    const db = seedDb();
    addRecommendation(db, '2026-10-02', 1);
    addRecommendation(db, '2026-10-03', 1);
    addRecommendation(db, '2026-10-04', null);
    addRecommendation(db, '2026-10-05', 0, { json: { rain: { daily_mm: 0, daily_status: 'unknown' } } });
    addRecommendation(db, '2026-10-06', 0, { json: { rain: { daily_mm: 0, daily_status: 'observed' } } });
    addRecommendation(db, '2026-10-07', 1, { raw: 'not json' });
    addLocalRain(db, '2026-10-08', 1);
    await runDendro(db, { weather: openMeteoDay(0), profile });
    const { json } = recommendation(db, '2026-10-08');
    assert.equal(json.rain.rolling7d, 4);
    // 02, 03, 06 (a known zero), 07 and the analytics day; 04 and 05 are missing.
    assert.equal(json.rain.rolling7d_days_present, 5);
    db.close();
  });

  test(`[${tag}] unknown rain keeps the recommendation, warns rain_unknown and never starts rain suppression`, async () => {
    const db = seedDb();
    for (const date of ['2026-10-05', '2026-10-06', '2026-10-07']) addRecommendation(db, date, 1);
    const { warnings } = await runDendro(db, { weather: { status: 500, body: null }, profile });
    assert.ok(warnings.some((w) => /Weather API failed/.test(w)), 'the provider failure is reported');
    const { row, json } = recommendation(db, '2026-10-08');
    assert.ok(row.irrigation_action, 'a recommendation is still written');
    assert.notEqual(row.irrigation_action, 'maintain_rain_suppression');
    assert.equal(json.rain.daily_status, 'unknown');
    assert.deepEqual(json.rain.warnings, ['rain_unknown']);
    assert.equal(json.rain.rolling7d, 3);
    assert.equal(json.rain.rolling7d_days_present, 3);
    const state = db.prepare('SELECT rain_suppression_active FROM zone_irrigation_state WHERE zone_id = 1').get();
    assert.equal(state.rain_suppression_active, 0);
    db.close();
  });

  test(`[${tag}] known rain carries no warning`, async () => {
    const db = seedDb();
    addLocalRain(db, '2026-10-08', 1);
    await runDendro(db, { weather: openMeteoDay(0), profile });
    const { json } = recommendation(db, '2026-10-08');
    assert.equal(json.rain.daily_status, 'observed');
    assert.deepEqual(json.rain.warnings, []);
    db.close();
  });

  test(`[${tag}] 20.8 mm over eight days but 18.2 mm over seven moves the zone from decrease_20 to decrease_10`, async () => {
    const db = seedDb();
    for (const date of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']) {
      addRecommendation(db, date, 2.6);
    }
    addLocalRain(db, '2026-10-08', 2.6);
    addUnstressedTreeDay(db, '2026-10-08');
    await runDendro(db, { weather: openMeteoDay(0), profile });
    const { row, json } = recommendation(db, '2026-10-08');
    assert.equal(row.irrigation_action, 'decrease_10');
    assert.equal(json.rain.rolling7d, 18.2);
    db.close();
  });
  for (const variant of [{ nullPrecipitation: false, label: 'no precipitation key' }, { nullPrecipitation: true, label: 'only null precipitation' }]) {
    test(`[${tag}] an Open-Meteo day with ${variant.label} is unknown rain, not 0 mm`, async () => {
      const db = seedDb();
      addRecommendation(db, '2026-10-07', 1);
      await runDendro(db, { weather: openMeteoTemperatureOnly(variant), profile });
      const { row, json } = recommendation(db, '2026-10-08');
      assert.equal(json.rain.daily_status, 'unknown');
      assert.deepEqual(json.rain.warnings, ['rain_unknown']);
      assert.equal(json.rain.source, 'none');
      assert.equal(json.rain.rolling7d_days_present, 1);
      // The temperature data still serves VPD.
      assert.equal(json.vpd.vpd_source, 'open_meteo');
      assert.equal(row.rain_suppression_active, 0);
      db.close();
    });
  }

  test(`[${tag}] an OpenAgri day without precipitation values is unknown rain, not 0 mm`, async () => {
    const db = seedDb();
    const weather = {
      status: 200,
      body: { data: [{ values: { temperature_2m: 18, relative_humidity_2m: 70 } }, { values: { temperature_2m: 21, relative_humidity_2m: 60, precipitation: null } }] },
    };
    const { calls } = await runDendro(db, {
      weather,
      profile,
      envVars: { OPENAGRI_WEATHER_URL: 'https://weather.example.invalid', OPENAGRI_WEATHER_BEARER_TOKEN: 'test-token' },
    });
    assert.ok(calls.some((url) => url.includes('/api/v1/history/hourly/')), 'the OpenAgri history route was asked (stubbed)');
    const { json } = recommendation(db, '2026-10-08');
    assert.equal(json.rain.daily_status, 'unknown');
    assert.deepEqual(json.rain.warnings, ['rain_unknown']);
    assert.equal(json.vpd.vpd_source, 'openagri');
    db.close();
  });

  test(`[${tag}] a provider day with a precipitation value of 0 is a known dry day`, async () => {
    const db = seedDb();
    await runDendro(db, { weather: openMeteoDay(0), profile });
    const { json } = recommendation(db, '2026-10-08');
    assert.equal(json.rain.daily_status, 'observed');
    assert.equal(json.rain.source, 'open_meteo');
    assert.equal(json.rain.rolling7d_days_present, 1);
    db.close();
  });

  // Zurich DST: the analytics date is zone-local and the window is seven calendar days,
  // whatever the length of the analytics day (23 h in spring, 25 h in autumn).
  for (const dst of [
    { label: 'spring (23-hour day)', now: '2026-03-30T01:00:00.000Z', date: '2026-03-29', from: '2026-03-23', outside: '2026-03-22', inside: ['2026-03-23', '2026-03-28'] },
    { label: 'autumn (25-hour day)', now: '2026-10-26T03:00:00.000Z', date: '2026-10-25', from: '2026-10-19', outside: '2026-10-18', inside: ['2026-10-19', '2026-10-24'] },
  ]) {
    test(`[${tag}] Europe/Zurich DST ${dst.label}: the window is the seven calendar days ending on the local analytics date`, async () => {
      const db = seedDb({ timezone: 'Europe/Zurich' });
      addRecommendation(db, dst.outside, 5);
      for (const date of dst.inside) addRecommendation(db, date, 2);
      addLocalRain(db, dst.date, 1);
      await runDendro(db, { weather: openMeteoDay(0), profile, now: dst.now });
      const { json } = recommendation(db, dst.date);
      assert.deepEqual(json.rain.rolling7d_window, { from: dst.from, to: dst.date });
      assert.equal(json.rain.rolling7d, 5);
      assert.equal(json.rain.rolling7d_days_present, 3);
      db.close();
    });
  }
}
