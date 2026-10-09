#!/usr/bin/env node
'use strict';

// Behavioural test for today's rain in GET /api/zones/:id/environment
// (zone-env-fn, "Get Zone Environment Summary").
//
// Unknown rain is not measured zero. A zone with no zone_daily_environment
// row for today, or with a row no rain gauge wrote, used to report
// rainTodayMm 0, a balance of minus the demand and "irrigate today": the
// gateway advised as if it had measured a dry day. A measured zero from a
// configured gauge stays an observed zero.
//
// Run: node --test scripts/test-zone-env-unknown-rain.js

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { executeFunction, loadNode, makeAuthHeader, seedTestDb } = require('./lib/flow-node-harness');

const SECRET = 'zone-env-unknown-rain-secret';
const NOW_ISO = '2026-10-08T10:30:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const HOUR_MS = 3600000;
const RAIN_GAUGE_EUI = 'A840410000000001';

// 'dry': every forecast hour has 0 mm. 'no-rain-values': the provider sent no
// precipitation, so no hour of the horizon is covered.
let forecastRain = 'dry';

function openMeteoStub(url) {
  const params = new URL(url).searchParams;
  const unixtime = params.get('timeformat') === 'unixtime';
  const label = (ms) => (unixtime ? ms / 1000 : new Date(ms).toISOString().slice(0, 16));
  if (params.has('current')) {
    return {
      utc_offset_seconds: 0,
      current: { time: label(NOW_MS), temperature_2m: 22, relative_humidity_2m: 50, precipitation: 0, cloud_cover: 10, pressure_msl: 1012, wind_speed_10m: 2, wind_direction_10m: 200 },
    };
  }
  const dayStarts = [0, 1, 2].map((d) => Date.UTC(2026, 9, 8 + d));
  const hours = Array.from({ length: 72 }, (_, i) => dayStarts[0] + (i + 1) * HOUR_MS);
  return {
    utc_offset_seconds: 0,
    hourly: {
      time: hours.map(label),
      temperature_2m: hours.map(() => 22),
      relative_humidity_2m: hours.map(() => 50),
      precipitation: hours.map(() => (forecastRain === 'dry' ? 0 : null)),
      precipitation_probability: hours.map(() => 5),
      wind_speed_10m: hours.map(() => 2),
      wind_direction_10m: hours.map(() => 200),
    },
    daily: {
      time: dayStarts.map((ms) => (unixtime ? ms / 1000 : new Date(ms).toISOString().slice(0, 10))),
      weather_code: [0, 0, 0],
      precipitation_sum: forecastRain === 'dry' ? [0, 0, 0] : [null, null, null],
      precipitation_probability_max: [5, 5, 5],
      et0_fao_evapotranspiration: [4.5, 4.5, 4.5],
      temperature_2m_min: [12, 12, 12],
      temperature_2m_max: [26, 26, 26],
    },
  };
}

function httpStub() {
  return {
    request(url, _options, callback) {
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.write = () => {};
      req.destroy = (error) => req.emit('error', error);
      req.end = () => {
        process.nextTick(() => {
          const res = new EventEmitter();
          res.statusCode = 200;
          callback(res);
          process.nextTick(() => {
            res.emit('data', JSON.stringify(openMeteoStub(String(url))));
            res.emit('end');
          });
        });
      };
      return req;
    },
  };
}

function fixedDate(RealDate) {
  return class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [NOW_MS])); }
    static now() { return NOW_MS; }
  };
}

async function zoneWater({ rainGauge = false, todayRow = null } = {}) {
  const db = seedTestDb();
  db.prepare('UPDATE irrigation_zones SET latitude = 47.37, longitude = 8.54, area_m2 = 100, irrigation_efficiency_pct = 90 WHERE id = 1').run();
  if (rainGauge) {
    db.prepare("INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at) VALUES (?, 'Rain', 'AQUASCOPE_LORAIN', 2, 1, '2026-01-01', '2026-01-01')").run(RAIN_GAUGE_EUI);
  }
  if (todayRow) {
    db.prepare('INSERT INTO zone_daily_environment(zone_id,date,rainfall_mm,flow_liters,rain_source,computed_at) VALUES(1,?,?,?,?,?)')
      .run('2026-10-08', todayRow.rainfall_mm, todayRow.flow_liters, todayRow.rain_source, NOW_ISO);
  }
  const stub = httpStub();
  const RealDate = global.Date;
  global.Date = fixedDate(RealDate);
  try {
    const out = await executeFunction(loadNode('zone-env-fn'), {
      db,
      env: { AUTH_TOKEN_SECRET: SECRET },
      msg: {
        req: {
          headers: { authorization: makeAuthHeader({ userId: 2, username: 'res1', secret: SECRET, expiresAt: NOW_MS + HOUR_MS }) },
          params: { zone_id: '1' },
          query: {},
        },
      },
      libOverrides: { httpLib: stub, httpsLib: stub },
    });
    const response = out.result && out.result.payload ? out.result : null;
    assert.ok(response, 'the node answers');
    assert.equal(response.statusCode, 200, JSON.stringify(response.payload));
    return response.payload;
  } finally {
    global.Date = RealDate;
    db.close();
  }
}

test('no rain observation at all: today\'s rain and balance are unknown, not 0 and minus the demand', async () => {
  forecastRain = 'dry';
  const payload = await zoneWater({ rainGauge: true });
  const water = payload.water;
  assert.ok(water.waterNeededTodayMm >= 1, 'the probe has a demand of at least 1 mm: ' + water.waterNeededTodayMm);
  assert.equal(water.irrigationTodayNetMm, 0, 'irrigation is known (nothing irrigated)');
  assert.equal(water.rainTodayMm, null);
  assert.equal(water.rainTodayStatus, 'unknown');
  assert.equal(water.balanceTodayMm, null);
  assert.equal(water.daily.at(-1).rainMm, null, 'the tile and today\'s history row agree');
});

test('a flow-only zero row without a rain gauge is unknown rain; its flow still counts', async () => {
  forecastRain = 'dry';
  const water = (await zoneWater({ todayRow: { rainfall_mm: 0, flow_liters: 100, rain_source: 'local_gauge' } })).water;
  assert.equal(water.rainTodayMm, null);
  assert.equal(water.rainTodayStatus, 'unknown');
  assert.equal(water.balanceTodayMm, null);
  assert.equal(water.irrigationTodayMeasuredLiters, 100);
  assert.equal(water.irrigationTodayNetMm, 0.9);
});

test('a measured dry day from a configured gauge is an observed zero', async () => {
  forecastRain = 'dry';
  const water = (await zoneWater({ rainGauge: true, todayRow: { rainfall_mm: 0, flow_liters: 0, rain_source: 'aquascope_lorain' } })).water;
  assert.equal(water.rainTodayMm, 0);
  assert.equal(water.rainTodayStatus, 'observed');
  assert.equal(water.balanceTodayMm, -water.waterNeededTodayMm);
  assert.deepEqual([water.action.code, water.action.source, water.action.reasonCode], ['irrigate_today', 'heuristic', 'demand_exceeds_supply']);
  assert.equal(water.daily.at(-1).rainMm, 0);
});

test('measured rain is observed even without a configured gauge', async () => {
  forecastRain = 'dry';
  const water = (await zoneWater({ todayRow: { rainfall_mm: 6.4, flow_liters: 0, rain_source: 'sensecap_s2120' } })).water;
  assert.equal(water.rainTodayMm, 6.4);
  assert.equal(water.rainTodayStatus, 'observed');
  assert.equal(water.balanceTodayMm, Math.round((6.4 - water.waterNeededTodayMm) * 100) / 100);
});
