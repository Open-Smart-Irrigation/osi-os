#!/usr/bin/env node
'use strict';

// Today's rain on the zone water tile (zone-env-fn, GET /api/zones/:id/environment)
// under the rain-resolution policy (docs/contracts/rainfall/rain-resolution-policy.md,
// osi-rain.resolveAdviceRain). A policy-1 zone day counts only when the selected gauge
// certified it: complete_so_far today is "so far"; a partial or unknown day is unknown
// rain, with its received amount reported beside it (a lower bound, never balanced),
// and the verdict follows D2 warn mode (rain_unknown). A legacy row (written before
// policy version 1) reads exactly as before (resolveRainTodayMm). History days follow
// the same rule per day.
//
// Run: node --test scripts/test-zone-env-rain-policy.js

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { executeFunction, loadNode, makeAuthHeader, seedTestDb } = require('./lib/flow-node-harness');

const SECRET = 'zone-env-rain-policy-secret';
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

const TODAY = '2026-10-08';

// rows: [{ date, rainfall_mm, rain_source, policy, coverage, received, reasons }]
async function zoneWater({ rainGauge = true, rows = [] } = {}) {
  const db = seedTestDb();
  db.prepare('UPDATE irrigation_zones SET latitude = 47.37, longitude = 8.54, area_m2 = 100, irrigation_efficiency_pct = 90 WHERE id = 1').run();
  if (rainGauge) {
    db.prepare("INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at) VALUES (?, 'Rain', 'AQUASCOPE_LORAIN', 2, 1, '2026-01-01', '2026-01-01')").run(RAIN_GAUGE_EUI);
  }
  for (const r of rows) {
    const policy = r.policy !== false;
    db.prepare(`INSERT INTO zone_daily_environment(zone_id, date, rainfall_mm, flow_liters, rain_source, computed_at, rain_coverage,
        rain_selected_deveui, rain_policy_version, rain_quality_reasons, rain_received_mm) VALUES (1, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.date || TODAY, r.rainfall_mm ?? null, r.rain_source || 'aquascope_lorain', NOW_ISO, policy ? r.coverage : null,
        policy ? RAIN_GAUGE_EUI : null, policy ? 1 : null, policy ? JSON.stringify(r.reasons || []) : null, policy ? (r.received ?? null) : null);
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
    assert.deepEqual(out.errors, [], 'zone-env-fn reported errors');
    const response = out.result && out.result.payload ? out.result : null;
    assert.ok(response, 'the node answers');
    assert.equal(response.statusCode, 200, JSON.stringify(response.payload));
    return response.payload.water;
  } finally {
    global.Date = RealDate;
    db.close();
  }
}

test('today complete so far: the measured amount counts, labelled complete_so_far', async () => {
  const water = await zoneWater({ rows: [{ coverage: 'complete_so_far', received: 1.2, reasons: ['ongoing'] }] });
  assert.equal(water.rainTodayMm, 1.2);
  assert.equal(water.rainTodayStatus, 'observed');
  assert.equal(water.rainTodayCoverage, 'complete_so_far');
  assert.equal(water.rainTodayReceivedMm, null);
  assert.equal(water.balanceTodayMm, Math.round((1.2 - water.waterNeededTodayMm) * 100) / 100);
  assert.equal(water.daily.at(-1).rainMm, 1.2);
  assert.equal(water.daily.at(-1).rainCoverage, 'complete_so_far');
});

test('today partial: rain is unknown, the received amount is reported beside it, the verdict warns rain_unknown', async () => {
  const water = await zoneWater({ rows: [{ coverage: 'partial', received: 3, reasons: ['frame_gap', 'ongoing'] }] });
  assert.equal(water.rainTodayMm, null);
  assert.equal(water.rainTodayStatus, 'unknown');
  assert.equal(water.rainTodayReceivedMm, 3);
  assert.equal(water.rainTodayCoverage, 'unknown');
  assert.deepEqual(water.rainTodayReasons, ['frame_gap', 'ongoing', 'local_partial', 'rain_unknown']);
  assert.equal(water.balanceTodayMm, null, 'a received amount is never balanced');
  assert.deepEqual([water.action.code, water.action.source, water.action.reasonCode], ['irrigate_today', 'heuristic', 'rain_unknown']);
  assert.equal(water.daily.at(-1).rainMm, null);
  assert.equal(water.daily.at(-1).rainReceivedMm, 3);
  assert.equal(water.daily.at(-1).rainCoverage, 'partial');
});

test('today unknown (received only, not promoted): unknown rain with the received amount', async () => {
  const water = await zoneWater({ rows: [{ coverage: 'unknown', received: 2.5, reasons: ['received_only', 'build_unpinned', 'ongoing'] }] });
  assert.equal(water.rainTodayMm, null);
  assert.equal(water.rainTodayReceivedMm, 2.5);
  assert.equal(water.action.reasonCode, 'rain_unknown');
});

test('legacy rows read as before: a gauge zero is observed with a configured gauge, unknown without', async () => {
  const withGauge = await zoneWater({ rows: [{ policy: false, rainfall_mm: 0 }] });
  assert.equal(withGauge.rainTodayMm, 0);
  assert.equal(withGauge.rainTodayStatus, 'observed');
  assert.equal(withGauge.rainTodayCoverage, 'legacy_unvalidated');
  assert.equal(withGauge.rainTodayReceivedMm, null);
  assert.equal(withGauge.daily.at(-1).rainMm, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(withGauge.daily.at(-1), 'rainCoverage'), false, 'a legacy day carries no coverage');
  const without = await zoneWater({ rainGauge: false, rows: [{ policy: false, rainfall_mm: 0, rain_source: 'local_gauge' }] });
  assert.equal(without.rainTodayMm, null);
  assert.equal(without.rainTodayStatus, 'unknown');
  const measured = await zoneWater({ rainGauge: false, rows: [{ policy: false, rainfall_mm: 6.4, rain_source: 'sensecap_s2120' }] });
  assert.equal(measured.rainTodayMm, 6.4);
});

test('history days: a certified day counts, a partial day is unknown with its received amount, a legacy day as before', async () => {
  const water = await zoneWater({ rows: [
    { date: '2026-10-05', coverage: 'complete', rainfall_mm: 4.2 },
    { date: '2026-10-06', coverage: 'partial', received: 2, reasons: ['frame_gap'] },
    { date: '2026-10-07', policy: false, rainfall_mm: 1.5 },
    { date: '2026-10-04', coverage: 'complete', rainfall_mm: 0 },
  ] });
  const day = (date) => water.daily.find((d) => d.date === date);
  assert.equal(day('2026-10-04').rainMm, 0, 'a certified dry day is an observed zero');
  assert.equal(day('2026-10-05').rainMm, 4.2);
  assert.equal(day('2026-10-05').rainCoverage, 'complete');
  assert.equal(day('2026-10-06').rainMm, null);
  assert.equal(day('2026-10-06').rainReceivedMm, 2);
  assert.equal(day('2026-10-06').totalWaterMm, null);
  assert.equal(day('2026-10-07').rainMm, 1.5);
  assert.equal(day('2026-10-02').rainMm, null, 'a day without a row is unknown');
});
