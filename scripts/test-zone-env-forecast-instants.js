#!/usr/bin/env node
'use strict';

// Behavioural test for the Open-Meteo forecast in GET /api/zones/:id/environment
// (zone-env-fn, "Get Zone Environment Summary").
//
// The node asks Open-Meteo for the zone's named timezone. Open-Meteo then
// labels every time with one fixed offset (`utc_offset_seconds`, the zone's
// offset at the start of the response) and no suffix, or returns instants when
// `timeformat=unixtime` is requested. The node used to read those labels as
// UTC, so a Zurich forecast hour labelled 12:00 became 12:00Z instead of
// 10:00Z: rain onset moved by the zone offset and the next-24-hour sum took
// the wrong hours.
//
// The stub below answers like Open-Meteo, in whichever form the node asks for,
// from one fixed set of true instants. The summary must therefore be the same
// for every zone timezone.
//
// Run: node --test scripts/test-zone-env-forecast-instants.js

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { executeFunction, loadNode, makeAuthHeader, seedTestDb } = require('./lib/flow-node-harness');

const SECRET = 'zone-env-forecast-instants-secret';
const NOW_ISO = '2026-10-08T10:30:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const HOUR_MS = 3600000;

// True instants (end of each hourly interval) with rain in mm. A zone with a
// half-hour offset has its provider hours on the half hour in UTC.
const WHOLE_HOUR = {
  rainAt: {
    '2026-10-08T10:00:00.000Z': 3, // ended before now: not in the next 24 hours
    '2026-10-08T11:00:00.000Z': 1,
    '2026-10-09T10:00:00.000Z': 2, // ends before now + 24 h
    '2026-10-09T11:00:00.000Z': 4, // ends after now + 24 h
  },
  eta: '2026-10-08T11:00:00.000Z', maxAt: '2026-10-09T11:00:00.000Z', first: '2026-10-08T11:00:00.000Z', last: '2026-10-09T10:00:00.000Z',
};
const HALF_HOUR = {
  rainAt: {
    '2026-10-08T09:30:00.000Z': 3,
    '2026-10-08T11:30:00.000Z': 1,
    '2026-10-09T09:30:00.000Z': 2,
    '2026-10-09T10:30:00.000Z': 4, // ends exactly at now + 24 h: outside
  },
  eta: '2026-10-08T11:30:00.000Z', maxAt: '2026-10-09T10:30:00.000Z', first: '2026-10-08T10:30:00.000Z', last: '2026-10-09T09:30:00.000Z',
};
let currentCase = WHOLE_HOUR;

function offsetSecondsAt(timezone, ms) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(ms)).find((part) => part.type === 'timeZoneName').value;
  const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
  if (!m || !m[1]) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60);
}

function openMeteoStub(url) {
  const params = new URL(url).searchParams;
  const timezone = params.get('timezone') || 'GMT';
  const unixtime = params.get('timeformat') === 'unixtime';
  // One offset for the whole response, as Open-Meteo does.
  const offset = offsetSecondsAt(timezone, Date.UTC(2026, 9, 8));
  const label = (ms) => (unixtime ? ms / 1000 : new Date(ms + offset * 1000).toISOString().slice(0, 16));
  if (params.has('current')) {
    return {
      utc_offset_seconds: offset,
      current: { time: label(NOW_MS), temperature_2m: 14, relative_humidity_2m: 70, precipitation: 0, cloud_cover: 50, pressure_msl: 1012, wind_speed_10m: 2, wind_direction_10m: 200 },
    };
  }
  const dayStarts = [0, 1, 2].map((d) => Date.UTC(2026, 9, 8 + d) - offset * 1000);
  const hours = Array.from({ length: 72 }, (_, i) => dayStarts[0] + (i + 1) * HOUR_MS);
  return {
    utc_offset_seconds: offset,
    hourly: {
      time: hours.map(label),
      temperature_2m: hours.map(() => 14),
      relative_humidity_2m: hours.map(() => 70),
      precipitation: hours.map((ms) => currentCase.rainAt[new Date(ms).toISOString()] || 0),
      precipitation_probability: hours.map(() => 40),
      wind_speed_10m: hours.map(() => 2),
      wind_direction_10m: hours.map(() => 200),
    },
    daily: {
      time: dayStarts.map((ms) => (unixtime ? ms / 1000 : new Date(ms + offset * 1000).toISOString().slice(0, 10))),
      weather_code: [61, 61, 3],
      precipitation_sum: [4, 6, 0],
      precipitation_probability_max: [80, 80, 10],
      et0_fao_evapotranspiration: [1.2, 1.1, 1.4],
      temperature_2m_min: [8, 7, 6],
      temperature_2m_max: [15, 14, 16],
    },
  };
}

function httpStub(requests) {
  return {
    request(url, _options, callback) {
      requests.push(String(url));
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

async function zoneEnvironment(timezone, { preUpgradeCache = false } = {}) {
  const db = seedTestDb();
  db.prepare('UPDATE irrigation_zones SET timezone = ?, latitude = 47.37, longitude = 8.54 WHERE id = 1').run(timezone);
  if (preUpgradeCache) {
    // Live entries under the keys of builds that read local labels as UTC.
    const shifted = { source: 'open_meteo', observedAt: NOW_ISO, hours: [{ time: '2026-10-08T12:00:00.000Z', rainMm: 9 }], days: [] };
    const insert = db.prepare('INSERT INTO zone_weather_cache(zone_id,cache_key,source,payload_json,observed_at,fetched_at,expires_at) VALUES(1,?,?,?,?,?,?)');
    insert.run('forecast', 'open_meteo', JSON.stringify(shifted), NOW_ISO, NOW_ISO, '2026-10-08T12:00:00.000Z');
    insert.run('online_current', 'open_meteo', JSON.stringify({ observedAt: '2026-10-08T12:30:00.000Z' }), '2026-10-08T12:30:00.000Z', NOW_ISO, '2026-10-08T12:00:00.000Z');
  }
  const requests = [];
  const stub = httpStub(requests);
  const RealDate = global.Date;
  global.Date = fixedDate(RealDate);
  try {
    const out = await executeFunction(loadNode('zone-env-fn'), {
      db,
      env: { AUTH_TOKEN_SECRET: SECRET, OPENAGRI_WEATHER_CURRENT_CACHE_MINUTES: '30', OPENAGRI_WEATHER_FORECAST_CACHE_MINUTES: '120' },
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
    return { payload: response.payload, requests };
  } finally {
    global.Date = RealDate;
    db.close();
  }
}

const CASES = [
  ['UTC', WHOLE_HOUR],
  ['Europe/Zurich', WHOLE_HOUR],
  ['Africa/Kampala', WHOLE_HOUR],
  ['America/Sao_Paulo', WHOLE_HOUR],
  ['Asia/Kolkata', HALF_HOUR],
];

for (const [timezone, expected] of CASES) {
  test(`${timezone}: forecast hours, rain onset and next-24-hour rain are true instants`, async () => {
    currentCase = expected;
    const { payload, requests } = await zoneEnvironment(timezone);
    const forecastRequest = requests.find((url) => url.includes('hourly='));
    assert.ok(forecastRequest, 'the node requested the Open-Meteo forecast');
    assert.ok(forecastRequest.includes('timezone=' + encodeURIComponent(timezone)), 'daily values stay in the zone timezone');
    const rf = payload.forecast.rainFocus;
    assert.equal(payload.forecast.available, true);
    assert.equal(rf.nextRainEta, expected.eta);
    assert.equal(rf.totalNext24hMm, 3);
    assert.equal(rf.maxHourlyRainAt, expected.maxAt);
    assert.equal(rf.hourly[0].time, expected.first);
    assert.equal(rf.hourly.at(-1).time, expected.last);
    assert.equal(rf.hourly.length, 24);
    assert.deepEqual(rf.daily.map((day) => [day.date, day.rainMm]), [['2026-10-08', 4], ['2026-10-09', 6], ['2026-10-10', 0]]);
    assert.equal(payload.online.observedAt, NOW_ISO);
  });
}

test('a forecast cached before the upgrade (local times read as UTC) is never served', async () => {
  currentCase = WHOLE_HOUR;
  const { payload, requests } = await zoneEnvironment('Europe/Zurich', { preUpgradeCache: true });
  assert.ok(requests.some((url) => url.includes('hourly=')), 'the forecast is fetched again');
  assert.ok(requests.some((url) => url.includes('current=')), 'current weather is fetched again');
  assert.equal(payload.forecast.rainFocus.nextRainEta, WHOLE_HOUR.eta);
  assert.equal(payload.forecast.rainFocus.totalNext24hMm, 3);
  assert.equal(payload.online.observedAt, NOW_ISO);
});
