'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');

const wp = require('./index');

const FIXTURES = path.join(__dirname, '__fixtures__');
function fixture(name) { return fs.readFileSync(path.join(FIXTURES, name)); }

// The h_recent throttle and the silent-station exclusions are module state;
// every test starts from a clean process as far as they are concerned.
test.beforeEach(() => wp.resetMeteoSwissThrottle());

const REPO = path.resolve(__dirname, '../../../../../../..');
const SEED = fs.readFileSync(path.join(REPO, 'database/seed-blank.sql'), 'utf8');

function scratchDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SEED);
  return {
    raw,
    all: async (sql, params) => raw.prepare(sql).all(...(params || [])),
    run: async (sql, params) => { raw.prepare(sql).run(...(params || [])); },
  };
}

function seedZone(db, { id, name, lat, lon, weatherSource, gatewayEui }) {
  // users: username, password_hash and created_at are NOT NULL (seed-blank.sql line 20-42).
  db.raw.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'x', '2026-09-25T00:00:00Z') ON CONFLICT DO NOTHING").run();
  // irrigation_zones: name and user_id are NOT NULL; zone_uuid is nullable but unique, so give each zone one.
  db.raw.prepare('INSERT INTO irrigation_zones (id, user_id, name, latitude, longitude, timezone, weather_source, gateway_device_eui, zone_uuid) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, lat, lon, 'Europe/Zurich', weatherSource || 'auto', gatewayEui || null, '00000000-0000-4000-8000-' + String(id).padStart(12, '0'));
}

function openMeteoOnlyDeps(log) {
  const payload = JSON.parse(fixture('open_meteo_past2.json').toString('utf8'));
  return {
    requestJson: async (url) => { log.push(url); return payload; },
    requestBuffer: async (url) => { throw new Error('offline: ' + url); },
  };
}

test('exports the two providers', () => {
  assert.deepEqual([...wp.PROVIDERS], ['open_meteo', 'meteoswiss']);
});

test('resolveProvider: zone override, deployment default, local skip, unknown values', () => {
  assert.equal(wp.resolveProvider('meteoswiss', 'open_meteo'), 'meteoswiss');
  assert.equal(wp.resolveProvider('auto', 'meteoswiss'), 'meteoswiss');
  assert.equal(wp.resolveProvider('auto', null), 'open_meteo');
  assert.equal(wp.resolveProvider(null, 'bogus'), 'open_meteo');
  assert.equal(wp.resolveProvider('openagri', 'meteoswiss'), 'meteoswiss');
  assert.equal(wp.resolveProvider('local', 'open_meteo'), null);
  assert.equal(wp.resolveProvider(' Open_Meteo ', 'meteoswiss'), 'open_meteo');
});

test('locationKey rounds to 2 decimals and shares a key across a farm', () => {
  assert.equal(wp.locationKey('open_meteo', 46.8004, 6.9499), 'open_meteo:46.80:6.95');
  assert.equal(wp.locationKey('open_meteo', 46.7996, 6.9501), 'open_meteo:46.80:6.95');
  assert.equal(wp.locationKey('meteoswiss', 46.8004, 6.9499), 'meteoswiss:46.80:6.95');
  assert.equal(wp.locationKey('open_meteo', -0.001, -0.004), 'open_meteo:0.00:0.00');
  assert.equal(wp.locationKey('open_meteo', -33.8688, 151.2093), 'open_meteo:-33.87:151.21');
});

test('locationKey refuses coordinates that are not finite numbers', () => {
  // Number(null) is 0: without the check a zone with no coordinates would
  // share the key of a farm at 0.00, 0.00.
  for (const [lat, lon] of [[null, 6.95], [46.8, undefined], [NaN, 6.95], [46.8, Infinity], ['', 6.95], ['abc', 6.95]]) {
    assert.throws(() => wp.locationKey('open_meteo', lat, lon), /locationKey requires finite coordinates/);
  }
  assert.equal(wp.locationKey('open_meteo', '46.8004', '6.9499'), 'open_meteo:46.80:6.95');
});

test('hourStartIso floors to the hour in UTC and rejects garbage', () => {
  assert.equal(wp.hourStartIso('2026-09-25T15:20:33.123Z'), '2026-09-25T15:00:00Z');
  assert.equal(wp.hourStartIso('2026-09-25T15:00'), '2026-09-25T15:00:00Z'); // naive string = UTC, whatever TZ the process runs in
  assert.equal(wp.hourStartIso('2026-09-25T17:00:00+02:00'), '2026-09-25T15:00:00Z');
  assert.equal(wp.hourStartIso(Date.UTC(2026, 0, 1, 0, 59)), '2026-01-01T00:00:00Z');
  assert.equal(wp.hourStartIso('not a date'), null);
  // new Date(null) is the epoch; a missing value is not 1970-01-01T00:00:00Z.
  assert.equal(wp.hourStartIso(null), null);
  assert.equal(wp.hourStartIso(undefined), null);
  assert.equal(wp.hourStartIso(''), null);
  assert.equal(wp.addHours('2026-09-25T15:00:00Z', -3), '2026-09-25T12:00:00Z');
  assert.equal(wp.addHours('2026-01-01T01:00:00Z', -2), '2025-12-31T23:00:00Z');
});

test('fetchWindow throws without a usable clock', () => {
  assert.throws(() => wp.fetchWindow({ provider: 'open_meteo', newestStoredHour: null, nowIso: null }), /nowIso is not a date/);
  assert.throws(() => wp.fetchWindow({ provider: 'open_meteo', newestStoredHour: null, nowIso: 'garbage' }), /nowIso is not a date/);
});

test('fetchWindow: normal tick re-reads three hours, first fetch backfills per provider', () => {
  const nowIso = '2026-09-25T15:20:00Z';
  assert.deepEqual(wp.fetchWindow({ provider: 'open_meteo', newestStoredHour: '2026-09-25T13:00:00Z', nowIso }), {
    fromUtc: '2026-09-25T10:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: false,
  });
  assert.deepEqual(wp.fetchWindow({ provider: 'open_meteo', newestStoredHour: null, nowIso }), {
    fromUtc: '2026-06-25T15:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: true,
  });
  assert.deepEqual(wp.fetchWindow({ provider: 'meteoswiss', newestStoredHour: null, nowIso }), {
    fromUtc: '2026-01-01T00:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: true,
  });
  // A gap of several days: the window still starts 3 h before the newest row.
  assert.deepEqual(wp.fetchWindow({ provider: 'meteoswiss', newestStoredHour: '2026-09-20T09:00:00Z', nowIso }), {
    fromUtc: '2026-09-20T06:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: false,
  });
  // A newest row in the future (written before the clock was set back) does
  // not push the window past the clock: re-read from toUtc - 3 h, so the
  // future rows are overwritten as real time reaches them.
  assert.deepEqual(wp.fetchWindow({ provider: 'open_meteo', newestStoredHour: '2026-09-25T22:00:00Z', nowIso }), {
    fromUtc: '2026-09-25T12:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: false,
  });
});

test('firstMissingHour returns the first hour absent from the stored set, else null', () => {
  const have = ['2026-09-25T10:00:00Z', '2026-09-25T11:00:00Z', '2026-09-25T13:00:00Z'];
  assert.equal(wp.firstMissingHour(have, '2026-09-25T10:00:00Z', '2026-09-25T14:00:00Z'), '2026-09-25T12:00:00Z');
  assert.equal(wp.firstMissingHour(new Set(have), '2026-09-25T10:00:00Z', '2026-09-25T12:00:00Z'), null);
  assert.equal(wp.firstMissingHour(have, '2026-09-25T09:00:00Z', '2026-09-25T12:00:00Z'), '2026-09-25T09:00:00Z');
  // toUtc is exclusive: an empty range has nothing missing.
  assert.equal(wp.firstMissingHour([], '2026-09-25T10:00:00Z', '2026-09-25T10:00:00Z'), null);
  assert.equal(wp.firstMissingHour([], '2026-09-25T10:00:00Z', '2026-09-25T11:00:00Z'), '2026-09-25T10:00:00Z');
});

test('buildOpenMeteoUrl carries the six hourly variables, UTC, past_hours and one forecast hour', () => {
  const url = wp.buildOpenMeteoUrl({ latitude: 46.8, longitude: 6.95 }, 2208);
  assert.match(url, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
  assert.match(url, /latitude=46\.8&longitude=6\.95/);
  assert.match(url, /hourly=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,shortwave_radiation,et0_fao_evapotranspiration/);
  assert.match(url, /&timezone=UTC/);
  // past_hours/forecast_hours end the response at the server's current hour;
  // past_days/forecast_days ran to the end of the day, so a gateway clock
  // ahead of real time would have stored forecast hours.
  assert.match(url, /&past_hours=2208&forecast_hours=1$/);
  assert.doesNotMatch(url, /past_days|forecast_days/);
});

test('normalizeOpenMeteo maps the fixture, shifts stamps to hour_start, converts wind to m/s, cuts the window', () => {
  const payload = JSON.parse(fixture('open_meteo_past2.json').toString('utf8'));
  // The fixture runs from stamp 2026-09-23T00:00 to 2026-09-25T23:00. Stamp T
  // describes the hour T-1h..T, so the first stamp (hour 22:00-23:00 on the
  // 22nd) is before fromUtc and stamp 15:00 (hour 14:00-15:00) is the last kept.
  const rows = wp.normalizeOpenMeteo(payload, '2026-09-23T00:00:00Z', '2026-09-25T15:00:00Z');
  assert.equal(rows.length, 63);
  assert.equal(rows[0].hour_start, '2026-09-23T00:00:00Z');
  assert.equal(rows[rows.length - 1].hour_start, '2026-09-25T14:00:00Z');
  const first = rows[0]; // = payload index 1 (stamp 2026-09-23T01:00)
  assert.equal(payload.hourly.time[1], '2026-09-23T01:00');
  assert.equal(first.air_temperature_c, payload.hourly.temperature_2m[1]);
  assert.equal(first.relative_humidity_pct, payload.hourly.relative_humidity_2m[1]);
  assert.equal(first.rain_mm, payload.hourly.precipitation[1]);
  assert.equal(first.wind_speed_mps, Math.round(payload.hourly.wind_speed_10m[1] / 3.6 * 100) / 100);
  assert.equal(first.global_radiation_wm2, payload.hourly.shortwave_radiation[1]);
  assert.equal(first.et0_mm, payload.hourly.et0_fao_evapotranspiration[1]);
  // A daytime hour, so radiation and ET0 are checked against non-zero values:
  // stamp 2026-09-24T12:00 = hour_start 11:00.
  const noon = payload.hourly.time.indexOf('2026-09-24T12:00');
  assert.deepEqual(rows.find((r) => r.hour_start === '2026-09-24T11:00:00Z'), {
    hour_start: '2026-09-24T11:00:00Z',
    air_temperature_c: 21.2,
    relative_humidity_pct: 50,
    rain_mm: 0,
    wind_speed_mps: 0.69, // 2.5 km/h
    global_radiation_wm2: 498,
    et0_mm: 0.32,
  });
  assert.equal(payload.hourly.shortwave_radiation[noon], 498);
  // The fixture has no rain at all; a synthetic hour checks precipitation
  // passes through as a non-zero value.
  const wet = wp.normalizeOpenMeteo({ hourly: { time: ['2026-09-25T10:00'], temperature_2m: [9], relative_humidity_2m: [95], precipitation: [1.7], wind_speed_10m: [3.6], shortwave_radiation: [40], et0_fao_evapotranspiration: [0.02] } }, '2026-09-25T00:00:00Z', '2026-09-25T15:00:00Z');
  assert.equal(wet[0].rain_mm, 1.7);
  assert.equal(wet[0].wind_speed_mps, 1);
});

test('normalizeOpenMeteo stores a null array entry as null, keeps the row, drops an all-null hour', () => {
  const payload = {
    hourly: {
      time: ['2026-09-25T10:00', '2026-09-25T11:00', '2026-09-25T12:00'],
      temperature_2m: [12.5, null, null],
      relative_humidity_2m: [80, 81, null],
      precipitation: [null, 0, null],
      wind_speed_10m: [7.2, null, null],
      shortwave_radiation: [100, 120, null],
      et0_fao_evapotranspiration: [0.05, null, null],
    },
  };
  const rows = wp.normalizeOpenMeteo(payload, '2026-09-25T00:00:00Z', '2026-09-25T15:00:00Z');
  // Stamps 10:00 and 11:00 become hour_start 09:00 and 10:00; stamp 12:00 is
  // all null (Open-Meteo serves nulls for hours older than about 60 days in a
  // 92-day request) and is not a row at all.
  assert.deepEqual(rows.map((r) => r.hour_start), ['2026-09-25T09:00:00Z', '2026-09-25T10:00:00Z']);
  assert.equal(rows[0].rain_mm, null);
  assert.equal(rows[1].air_temperature_c, null);
  assert.equal(rows[1].wind_speed_mps, null);
  assert.equal(rows[1].et0_mm, null);
  assert.equal(rows[1].rain_mm, 0);
});

test('normalizeOpenMeteo returns no rows for a payload without hourly data', () => {
  assert.deepEqual(wp.normalizeOpenMeteo(null, '2026-09-25T00:00:00Z', '2026-09-25T15:00:00Z'), []);
  assert.deepEqual(wp.normalizeOpenMeteo({ hourly: { time: [] } }, '2026-09-25T00:00:00Z', '2026-09-25T15:00:00Z'), []);
});

test('openMeteoPastHours covers the window: 2208 on a first fetch, 48 normally, window + 24 after an outage', () => {
  assert.equal(wp.openMeteoPastHours({ fromUtc: '2026-06-25T15:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: true }), 2208);
  assert.equal(wp.openMeteoPastHours({ fromUtc: '2026-09-25T10:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: false }), 48);
  // 129 hours from 2026-09-20T06:00 to 2026-09-25T15:00, plus 24.
  assert.equal(wp.openMeteoPastHours({ fromUtc: '2026-09-20T06:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: false }), 153);
  assert.equal(wp.openMeteoPastHours({ fromUtc: '2026-01-01T00:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: false }), 2208);
});

test('fetchOpenMeteoHours asks for 2208 past hours on a first fetch and 48 otherwise', async () => {
  const urls = [];
  const payload = JSON.parse(fixture('open_meteo_past2.json').toString('utf8'));
  const deps = { requestJson: async (url) => { urls.push(url); return payload; } };
  const location = { latitude: 46.8, longitude: 6.95 };
  await wp.fetchOpenMeteoHours(location, { fromUtc: '2026-06-25T15:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: true }, deps);
  const result = await wp.fetchOpenMeteoHours(location, { fromUtc: '2026-09-25T10:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: false }, deps);
  assert.match(urls[0], /past_hours=2208&forecast_hours=1/);
  assert.match(urls[1], /past_hours=48&forecast_hours=1/);
  // hour_start 10:00 .. 14:00 = stamps 11:00 .. 15:00
  assert.equal(result.rows.length, 5);
  assert.equal(result.rows[0].hour_start, '2026-09-25T10:00:00Z');
});

test('decodeCsv/splitCsvLine handle Windows-1252 and quoted separators', () => {
  assert.equal(wp.decodeCsv(Buffer.from([0x50, 0x41, 0x59, 0x3b, 0xe9])), 'PAY;é');
  assert.deepEqual(wp.splitCsvLine('a;"b;c";;d'), ['a', 'b;c', '', 'd']);
  assert.deepEqual(wp.parseCsv('﻿h1;h2\n1;2\n\n'), [['h1', 'h2'], ['1', '2']]);
});

test('decodeCsv strips a UTF-8 byte-order mark before Windows-1252 decoding', () => {
  assert.equal(
    wp.decodeCsv(Buffer.from([0xef, 0xbb, 0xbf, 0x73, 0x74, 0x61, 0x74, 0x69, 0x6f, 0x6e, 0x5f, 0x61, 0x62, 0x62, 0x72, 0x3b, 0x78])),
    'station_abbr;x',
  );
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fixture('meta_stations_trimmed.csv')]);
  assert.equal(wp.parseStations(wp.decodeCsv(withBom)).length, 7);
});

test('withinSwissCoverage and haversineKm', () => {
  assert.equal(wp.withinSwissCoverage(46.8, 6.95), true);
  assert.equal(wp.withinSwissCoverage(48.9, 2.3), false);
  assert.equal(wp.withinSwissCoverage(NaN, 6.95), false);
  assert.equal(Math.round(wp.haversineKm(46.811581, 6.942469, 46.7714, 7.113736) * 10) / 10, 13.8);
});

test('parseStations + nearestStations pick Payerne first for a farm near Payerne', () => {
  const stations = wp.parseStations(wp.decodeCsv(fixture('meta_stations_trimmed.csv')));
  assert.equal(stations.length, 7);
  const near = wp.nearestStations(stations, 46.8, 6.95, { maxKm: 15, limit: 3 });
  assert.deepEqual(near.map((s) => s.id), ['PAY', 'GRA']);
  assert.equal(near[0].distanceKm, 1.4);
  assert.equal(near[0].name, 'Payerne');
  assert.deepEqual(wp.nearestStations(stations, 47.5, 8.5, { maxKm: 15, limit: 3 }), []);
});

test('parseDailyRain reads rka150d0 by date and measuresRain needs a value in the last 14 days', () => {
  const daily = wp.parseDailyRain(wp.decodeCsv(fixture('pay_d_recent.csv')));
  assert.equal(daily.size, 20);
  assert.equal(daily.has('2026-09-24'), true);
  assert.equal(typeof daily.get('2026-09-24'), 'number');
  assert.equal(wp.measuresRain(daily, '2026-09-25'), true);
  assert.equal(wp.measuresRain(daily, '2026-10-20'), false);
  assert.equal(wp.measuresRain(new Map(), '2026-09-25'), false);
});

test('normalizeMeteoSwiss shifts end-of-hour stamps, maps six columns by name, nulls empties', () => {
  const rows = wp.normalizeMeteoSwiss(wp.decodeCsv(fixture('pay_h_now.csv')), '2026-09-25T00:00:00Z', '2026-09-25T15:00:00Z');
  // Rows stamped 01:00 .. 15:00 (end of hour) become hour_start 00:00 .. 14:00; the 00:00 row is 2026-09-24T23:00 and falls before fromUtc.
  assert.equal(rows[0].hour_start, '2026-09-25T00:00:00Z');
  assert.equal(rows[rows.length - 1].hour_start, '2026-09-25T14:00:00Z');
  assert.equal(rows.length, 15);
  // The row stamped 25.09.2026 01:00 in the fixture, by header name (NOT by
  // position: fkl010h1 = 0.7 sits two columns before fkl010h0 = 0.2):
  // tre200h0=10.7 ure200h0=87.8 rre150h0=0 fkl010h0=0.2 gre000h0=0 erefaoh0=-0.024
  assert.deepEqual(rows[0], {
    hour_start: '2026-09-25T00:00:00Z',
    air_temperature_c: 10.7,
    relative_humidity_pct: 87.8,
    rain_mm: 0,
    wind_speed_mps: 0.2,
    global_radiation_wm2: 0,
    et0_mm: -0.024, // MeteoSwiss reports a small negative reference evaporation at night (dew); stored as delivered
  });
  const withEmpty = wp.normalizeMeteoSwiss('station_abbr;reference_timestamp;tre200h0;ure200h0;rre150h0;fkl010h0;gre000h0;erefaoh0\nPAY;25.09.2026 03:00;;55;;1.1;;\n', '2026-09-25T00:00:00Z', '2026-09-25T15:00:00Z');
  assert.deepEqual(withEmpty, [{ hour_start: '2026-09-25T02:00:00Z', air_temperature_c: null, relative_humidity_pct: 55, rain_mm: null, wind_speed_mps: 1.1, global_radiation_wm2: null, et0_mm: null }]);
  // A file without the ET0 column still yields rows, with et0_mm null.
  const noEt0 = wp.normalizeMeteoSwiss('station_abbr;reference_timestamp;tre200h0;ure200h0;rre150h0;fkl010h0;gre000h0\nPAY;25.09.2026 03:00;9;55;0;1.1;0\n', '2026-09-25T00:00:00Z', '2026-09-25T15:00:00Z');
  assert.equal(noEt0.length, 1);
  assert.equal(noEt0[0].et0_mm, null);
  assert.equal(noEt0[0].air_temperature_c, 9);
});

test('normalizeMeteoSwiss drops a row whose six values are all empty', () => {
  // An all-empty row is an absent hour, as in normalizeOpenMeteo: stored, it
  // would become the newest hour and overwrite good values on the re-read.
  const header = 'station_abbr;reference_timestamp;tre200h0;ure200h0;rre150h0;fkl010h0;gre000h0;erefaoh0';
  assert.deepEqual(wp.normalizeMeteoSwiss(header + '\nPAY;25.09.2026 03:00;;;;;;\n', '2026-09-25T00:00:00Z', '2026-09-25T15:00:00Z'), []);
});

test('mergeRows: later lists win on the same hour and the result is sorted', () => {
  const merged = wp.mergeRows(
    [{ hour_start: '2026-09-24T22:00:00Z', rain_mm: 1 }, { hour_start: '2026-09-24T23:00:00Z', rain_mm: 2 }],
    [{ hour_start: '2026-09-24T23:00:00Z', rain_mm: 3 }, { hour_start: '2026-09-25T00:00:00Z', rain_mm: 4 }],
  );
  assert.deepEqual(merged.map((r) => [r.hour_start, r.rain_mm]), [['2026-09-24T22:00:00Z', 1], ['2026-09-24T23:00:00Z', 3], ['2026-09-25T00:00:00Z', 4]]);
});

test('meteoSwissUrl builds the documented file names', () => {
  assert.equal(wp.meteoSwissUrl('stations'), 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ogd-smn_meta_stations.csv');
  assert.equal(wp.meteoSwissUrl('h_now', 'PAY'), 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/pay/ogd-smn_pay_h_now.csv');
  assert.equal(wp.meteoSwissUrl('d_recent', 'GRA'), 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/gra/ogd-smn_gra_d_recent.csv');
});

test('meteoSwissUrl and parseStations accept only 2-8 letter or digit station ids', () => {
  for (const bad of ['', 'P', 'ABCDEFGHI', '../x', 'PA Y', 'PAY?a=1', null, undefined]) {
    assert.throws(() => wp.meteoSwissUrl('h_now', bad), /invalid MeteoSwiss station id/);
  }
  assert.equal(wp.meteoSwissUrl('h_now', 'Ab12'), 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ab12/ogd-smn_ab12_h_now.csv');
  const csv = 'station_abbr;station_name;station_coordinates_wgs84_lat;station_coordinates_wgs84_lon\n' +
    'PAY;Payerne;46.811581;6.942469\n../x;Bad;46.8;6.9\nP Y;Bad;46.8;6.9\nABCDEFGHI;Bad;46.8;6.9\n';
  assert.deepEqual(wp.parseStations(csv).map((s) => s.id), ['PAY']);
});

function meteoSwissDeps(log) {
  return {
    requestBuffer: async (url) => {
      log.push(url);
      if (url.endsWith('_meta_stations.csv')) return fixture('meta_stations_trimmed.csv');
      if (url.endsWith('_d_recent.csv')) return fixture('pay_d_recent.csv');
      if (url.endsWith('_h_now.csv')) return fixture('pay_h_now.csv');
      // pay_h_now.csv with every stamp moved one day back (25.09 -> 24.09):
      // hour_start 2026-09-23T23:00 .. 2026-09-24T19:00.
      if (url.endsWith('_h_recent.csv')) return fixture('pay_h_recent_tail.csv');
      throw new Error('unexpected url ' + url);
    },
  };
}

test('resolveMeteoSwissStation picks the nearest station with rain evidence', async () => {
  const log = [];
  const station = await wp.resolveMeteoSwissStation({ latitude: 46.8, longitude: 6.95 }, '2026-09-25T15:20:00Z', meteoSwissDeps(log));
  assert.equal(station.id, 'PAY');
  assert.equal(station.distanceKm, 1.4);
  await assert.rejects(
    wp.resolveMeteoSwissStation({ latitude: 48.9, longitude: 2.3 }, '2026-09-25T15:20:00Z', meteoSwissDeps([])),
    /outside MeteoSwiss coverage/,
  );
  await assert.rejects(
    wp.resolveMeteoSwissStation({ latitude: 47.5, longitude: 8.5 }, '2026-09-25T15:20:00Z', meteoSwissDeps([])),
    /no MeteoSwiss station with rain data within 15 km/,
  );
});

const PAY_CACHED = { latitude: 46.8, longitude: 6.95, station_id: 'PAY', station_name: 'Payerne', station_distance_km: 1.4 };
const H_NOW = 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/pay/ogd-smn_pay_h_now.csv';
const H_RECENT = 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/pay/ogd-smn_pay_h_recent.csv';

test('fetchMeteoSwissHours reuses a cached station and reads only h_now while the window is today', async () => {
  const log = [];
  const normal = await wp.fetchMeteoSwissHours(PAY_CACHED, { fromUtc: '2026-09-25T10:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: false }, meteoSwissDeps(log), '2026-09-25T15:20:00Z');
  assert.deepEqual(log, [H_NOW]);
  assert.equal(normal.rows.length, 5);
  assert.equal(normal.station.id, 'PAY');
});

test('fetchMeteoSwissHours after midnight without a gap reads only h_now', async () => {
  const log = [];
  // Newest stored hour 02:00, window from 23:00 yesterday: h_now's first row
  // (stamped 25.09.2026 00:00) is hour_start 2026-09-24T23:00, so h_now alone
  // covers the window and the 1 MB h_recent file is not needed.
  const result = await wp.fetchMeteoSwissHours(PAY_CACHED, { fromUtc: '2026-09-24T23:00:00Z', toUtc: '2026-09-25T03:00:00Z', firstFetch: false }, meteoSwissDeps(log), '2026-09-25T03:20:00Z');
  assert.deepEqual(log, [H_NOW]);
  assert.deepEqual(result.rows.map((r) => r.hour_start), ['2026-09-24T23:00:00Z', '2026-09-25T00:00:00Z', '2026-09-25T01:00:00Z', '2026-09-25T02:00:00Z']);
});

test('fetchMeteoSwissHours reads h_recent after h_now when the window reaches hours h_now lacks, then throttles it for 2 hours', async () => {
  const log = [];
  const deps = meteoSwissDeps(log);
  const window = { fromUtc: '2026-09-24T10:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: false };
  const gap = await wp.fetchMeteoSwissHours(PAY_CACHED, window, deps, '2026-09-25T15:20:00Z');
  assert.deepEqual(log, [H_NOW, H_RECENT]);
  assert.equal(gap.recentSkipped, undefined);
  // Tail fixture hour_start 2026-09-24T10:00 .. 19:00 (10) + h_now 2026-09-24T23:00 .. 2026-09-25T14:00 (16).
  assert.equal(gap.rows.length, 26);
  assert.equal(gap.rows[0].hour_start, '2026-09-24T10:00:00Z');
  // The 24th's hours come from the tail fixture, whose 24.09 11:00 row carries
  // the values of h_now's 25.09 11:00 row.
  const hNow = wp.normalizeMeteoSwiss(wp.decodeCsv(fixture('pay_h_now.csv')), '2026-09-25T10:00:00Z', '2026-09-25T11:00:00Z')[0];
  assert.deepEqual({ ...gap.rows[0], hour_start: null }, { ...hNow, hour_start: null });
  assert.equal(gap.rows.some((r) => r.hour_start === '2026-09-24T23:00:00Z'), true);

  // Same gap 50 minutes later: h_recent was read less than 2 hours ago.
  log.length = 0;
  const again = await wp.fetchMeteoSwissHours(PAY_CACHED, { ...window, toUtc: '2026-09-25T16:00:00Z' }, deps, '2026-09-25T16:10:00Z');
  assert.deepEqual(log, [H_NOW]);
  assert.equal(again.recentSkipped, true);
  assert.equal(again.rows.length, 17); // h_now only: 2026-09-24T23:00 .. 2026-09-25T15:00

  // Two hours after the first read the gap is read again.
  log.length = 0;
  await wp.fetchMeteoSwissHours(PAY_CACHED, { ...window, toUtc: '2026-09-25T17:00:00Z' }, deps, '2026-09-25T17:20:00Z');
  assert.deepEqual(log, [H_NOW, H_RECENT]);
});

test('fetchMeteoSwissHours on a first fetch resolves the station and reads both files, throttle or not', async () => {
  const log = [];
  const deps = meteoSwissDeps(log);
  // An h_recent read a moment ago for the same station (another location).
  await wp.fetchMeteoSwissHours(PAY_CACHED, { fromUtc: '2026-09-24T10:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: false }, deps, '2026-09-25T15:10:00Z');
  log.length = 0;
  const first = await wp.fetchMeteoSwissHours({ latitude: 46.8, longitude: 6.95 }, { fromUtc: '2026-01-01T00:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: true }, deps, '2026-09-25T15:20:00Z');
  assert.equal(log[0], wp.meteoSwissUrl('stations'));
  assert.deepEqual(log.slice(-2), [H_NOW, H_RECENT]);
  assert.equal(first.recentSkipped, undefined);
  // Tail 2026-09-23T23:00 .. 2026-09-24T19:00 (21) + h_now 2026-09-24T23:00 .. 2026-09-25T14:00 (16).
  assert.equal(first.rows.length, 37);
});

test('runTick stores completed hours for one location shared by two zones, and records success', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'A', lat: 46.8004, lon: 6.9499 });
  seedZone(db, { id: 2, name: 'B', lat: 46.7996, lon: 6.9501 });
  const log = [];
  const summary = await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps: openMeteoOnlyDeps(log), warn: () => {} });
  // A first fetch's window.fromUtc is 92 days back (well before the fixture's
  // earliest stamp), so every one of the fixture's 72 hourly stamps that maps
  // to an hour_start before toUtc (15:00) is in range: hour_start 2026-09-22T23:00
  // .. 2026-09-25T14:00 inclusive = 64 rows (unlike the direct normalizeOpenMeteo
  // test above, which passes an explicit fromUtc of 2026-09-23T00:00 and so
  // excludes that first hour, landing on 63).
  assert.deepEqual(summary, { zones: 2, locations: 1, stored: 64, failed: 0 });
  assert.equal(log.length, 1);
  assert.match(log[0], /past_hours=2208&forecast_hours=1/);
  const loc = db.raw.prepare('SELECT * FROM weather_locations').all();
  assert.equal(loc.length, 1);
  assert.equal(loc[0].location_key, 'open_meteo:46.80:6.95');
  assert.equal(loc[0].timezone, 'Europe/Zurich');
  assert.equal(loc[0].last_error, null);
  assert.equal(loc[0].last_success_at, '2026-09-25T15:20:00Z');
  const newest = db.raw.prepare('SELECT MAX(hour_start) AS h FROM weather_provider_hours').get().h;
  assert.equal(newest, '2026-09-25T14:00:00Z');
});

test('runTick requests the rounded key coordinates whichever zone of the key comes first', async () => {
  const db = scratchDb();
  // Inserted in reverse id order; ZONE_SQL orders by id, so zone 1 sets the timezone.
  seedZone(db, { id: 2, name: 'B', lat: 46.7996, lon: 6.9501 });
  seedZone(db, { id: 1, name: 'A', lat: 46.8004, lon: 6.9499 });
  db.raw.prepare("UPDATE irrigation_zones SET timezone = 'UTC' WHERE id = 2").run();
  const log = [];
  await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps: openMeteoOnlyDeps(log), warn: () => {} });
  assert.match(log[0], /latitude=46\.8&longitude=6\.95&/);
  const loc = { ...db.raw.prepare('SELECT latitude, longitude, timezone FROM weather_locations').get() };
  assert.deepEqual(loc, { latitude: 46.8, longitude: 6.95, timezone: 'Europe/Zurich' });
});

test('runTick on a second tick asks for 48 past hours and overwrites the last three hours', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'A', lat: 46.8, lon: 6.95 });
  const log = [];
  const deps = openMeteoOnlyDeps(log);
  await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps, warn: () => {} });
  db.raw.prepare("UPDATE weather_provider_hours SET air_temperature_c = -99 WHERE hour_start = '2026-09-25T12:00:00Z'").run();
  const summary = await wp.runTick({ db, nowIso: '2026-09-25T15:50:00Z', deploymentDefault: 'open_meteo', deps, warn: () => {} });
  assert.match(log[1], /past_hours=48&forecast_hours=1/);
  // newest stored hour is 14:00; the window re-reads 11:00, 12:00, 13:00 and 14:00.
  assert.equal(summary.stored, 4);
  const fixed = db.raw.prepare("SELECT air_temperature_c FROM weather_provider_hours WHERE hour_start = '2026-09-25T12:00:00Z'").get();
  assert.notEqual(fixed.air_temperature_c, -99);
});

function seedStoredHours(db, key, fromUtc, toUtc, skip) {
  db.raw.prepare("INSERT INTO weather_locations (location_key, provider, latitude, longitude, timezone) VALUES (?, 'open_meteo', 46.8, 6.95, 'Europe/Zurich')").run(key);
  const insert = db.raw.prepare('INSERT INTO weather_provider_hours (location_key, hour_start, air_temperature_c, fetched_at) VALUES (?, ?, -99, ?)');
  for (let h = fromUtc; h < toUtc; h = wp.addHours(h, 1)) if (!skip(h)) insert.run(key, h, '2026-09-18T00:00:00Z');
}

test('runTick starts the window at the first missing hour of the last 7 days and fills the hole', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'A', lat: 46.8, lon: 6.95 });
  const key = 'open_meteo:46.80:6.95';
  // Every hour of the last 7 days is stored except a 6-hour hole two days ago
  // (hour_start 2026-09-23T10:00 .. 15:00). The newest row is 14:00 today, so
  // the old rule (newest - 3 h = 11:00) would never read the hole again.
  const holeStart = '2026-09-23T10:00:00Z';
  const holeEnd = '2026-09-23T16:00:00Z';
  seedStoredHours(db, key, '2026-09-18T15:00:00Z', '2026-09-25T15:00:00Z', (h) => h >= holeStart && h < holeEnd);
  const log = [];
  const summary = await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps: openMeteoOnlyDeps(log), warn: () => {} });
  assert.equal(log.length, 1);
  // The request covers the window: past_hours = hours(fromUtc..toUtc) + 24,
  // so the window it was built from starts at the hole's first hour.
  const pastHours = Number(/past_hours=(\d+)/.exec(log[0])[1]);
  assert.equal(wp.addHours('2026-09-25T15:00:00Z', -(pastHours - 24)), holeStart);
  // The fixture has every hour_start from 2026-09-22T23:00, so the stored
  // count pins the window: hour_start 2026-09-23T10:00 .. 2026-09-25T14:00 is
  // 53 hours. One hour earlier would store 54; one hour later leaves 10:00 empty.
  assert.equal(summary.stored, 53);
  const hole = db.raw.prepare('SELECT hour_start, air_temperature_c FROM weather_provider_hours WHERE location_key = ? AND hour_start >= ? AND hour_start < ? ORDER BY hour_start').all(key, holeStart, holeEnd);
  assert.equal(hole.length, 6);
  assert.equal(hole.every((r) => r.air_temperature_c !== -99 && r.air_temperature_c != null), true);
  // The hour before the hole is outside the window and keeps its stored value.
  assert.equal(db.raw.prepare("SELECT air_temperature_c FROM weather_provider_hours WHERE hour_start = '2026-09-23T09:00:00Z'").get().air_temperature_c, -99);
});

test('runTick ignores hours before the first stored hour when it looks for a gap', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'A', lat: 46.8, lon: 6.95 });
  const key = 'open_meteo:46.80:6.95';
  // Only one day stored (a location created yesterday): the six days before it
  // were never in scope, so they are not a hole and the window stays newest - 3 h.
  seedStoredHours(db, key, '2026-09-24T15:00:00Z', '2026-09-25T15:00:00Z', () => false);
  const summary = await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps: openMeteoOnlyDeps([]), warn: () => {} });
  assert.equal(summary.stored, 4); // hour_start 11:00 .. 14:00
});

test('runTick records the error and stores nothing when the provider is unreachable, then recovers', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'A', lat: 46.8, lon: 6.95 });
  const warnings = [];
  const failing = { requestJson: async () => { throw new Error('getaddrinfo ENOTFOUND api.open-meteo.com'); }, requestBuffer: async () => { throw new Error('offline'); } };
  const summary = await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps: failing, warn: (m) => warnings.push(m) });
  assert.deepEqual(summary, { zones: 1, locations: 1, stored: 0, failed: 1 });
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM weather_provider_hours').get().n, 0);
  const loc = db.raw.prepare('SELECT last_fetch_at, last_success_at, last_error FROM weather_locations').get();
  assert.equal(loc.last_fetch_at, '2026-09-25T15:20:00Z');
  assert.equal(loc.last_success_at, null);
  assert.match(loc.last_error, /ENOTFOUND/);
  assert.equal(warnings.length, 1);
  const ok = await wp.runTick({ db, nowIso: '2026-09-25T15:40:00Z', deploymentDefault: 'open_meteo', deps: openMeteoOnlyDeps([]), warn: () => {} });
  assert.equal(ok.failed, 0);
  assert.equal(db.raw.prepare('SELECT last_error FROM weather_locations').get().last_error, null);
});

test('runTick warns once per problem and once on recovery', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'A', lat: 46.8, lon: 6.95 });
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const failing = { requestJson: async () => { throw new Error('getaddrinfo ENOTFOUND api.open-meteo.com'); }, requestBuffer: async () => { throw new Error('offline'); } };
  await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps: failing, warn });
  await wp.runTick({ db, nowIso: '2026-09-25T15:50:00Z', deploymentDefault: 'open_meteo', deps: failing, warn });
  assert.deepEqual(warnings, ['open_meteo:46.80:6.95: getaddrinfo ENOTFOUND api.open-meteo.com']);
  await wp.runTick({ db, nowIso: '2026-09-25T16:20:00Z', deploymentDefault: 'open_meteo', deps: openMeteoOnlyDeps([]), warn });
  await wp.runTick({ db, nowIso: '2026-09-25T16:50:00Z', deploymentDefault: 'open_meteo', deps: openMeteoOnlyDeps([]), warn });
  assert.deepEqual(warnings, ['open_meteo:46.80:6.95: getaddrinfo ENOTFOUND api.open-meteo.com', 'open_meteo:46.80:6.95: recovered']);
  // A different error after recovery is a new problem.
  const other = { requestJson: async () => { throw new Error('HTTP 503 from x'); }, requestBuffer: async () => { throw new Error('offline'); } };
  await wp.runTick({ db, nowIso: '2026-09-25T17:20:00Z', deploymentDefault: 'open_meteo', deps: other, warn });
  assert.equal(warnings.length, 3);
  assert.equal(warnings[2], 'open_meteo:46.80:6.95: HTTP 503 from x');
});

test('runTick returns at once while an earlier tick is still running', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'A', lat: 46.8, lon: 6.95 });
  const payload = JSON.parse(fixture('open_meteo_past2.json').toString('utf8'));
  const slow = { requestJson: () => new Promise((resolve) => setTimeout(() => resolve(payload), 20)), requestBuffer: async () => { throw new Error('offline'); } };
  let secondDbCalls = 0;
  const counting = { all: async (...a) => { secondDbCalls += 1; return db.all(...a); }, run: async (...a) => { secondDbCalls += 1; return db.run(...a); } };
  const args = { nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps: slow, warn: () => {} };
  const [first, second] = await Promise.all([wp.runTick({ db, ...args }), wp.runTick({ db: counting, ...args })]);
  assert.equal(first.stored, 64);
  assert.deepEqual(second, { zones: 0, locations: 0, stored: 0, failed: 0, skipped: 'in_flight' });
  assert.equal(secondDbCalls, 0);
  const third = await wp.runTick({ db: counting, ...args, nowIso: '2026-09-25T15:50:00Z' });
  assert.equal(third.skipped, undefined);
  assert.equal(third.locations, 1);
  assert.ok(secondDbCalls > 0);
});

test('runTick skips zones without coordinates or with weather_source=local, and falls back to the gateway location', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'no coords', lat: null, lon: null });
  seedZone(db, { id: 2, name: 'half coords', lat: 46.8, lon: null, gatewayEui: 'AABBCCDDEEFF0011' });
  seedZone(db, { id: 3, name: 'local', lat: 46.8, lon: 6.95, weatherSource: 'local' });
  // gateway_locations.updated_at is NOT NULL (seed-blank.sql line 2058-2075).
  db.raw.prepare("INSERT INTO gateway_locations (gateway_device_eui, latitude, longitude, updated_at) VALUES ('AABBCCDDEEFF0011', 46.2, 7.4, '2026-09-25T00:00:00Z')").run();
  const log = [];
  const summary = await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps: openMeteoOnlyDeps(log), warn: () => {} });
  assert.equal(summary.locations, 1);
  assert.equal(db.raw.prepare('SELECT location_key FROM weather_locations').get().location_key, 'open_meteo:46.20:7.40');
});

test('runTick keeps two providers at one place as two locations and isolates a failing one', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'om', lat: 48.9, lon: 2.3, weatherSource: 'open_meteo' });
  seedZone(db, { id: 2, name: 'ms', lat: 48.9, lon: 2.3, weatherSource: 'meteoswiss' });
  const summary = await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps: openMeteoOnlyDeps([]), warn: () => {} });
  // Same 64-row first-fetch count as the test above (the meteoswiss location
  // fails outside coverage and stores nothing).
  assert.deepEqual(summary, { zones: 2, locations: 2, stored: 64, failed: 1 });
  const rows = db.raw.prepare('SELECT location_key, provider, last_error FROM weather_locations ORDER BY location_key').all();
  assert.deepEqual(rows.map((r) => r.provider), ['meteoswiss', 'open_meteo']);
  assert.match(rows[0].last_error, /outside MeteoSwiss coverage/);
  assert.equal(rows[1].last_error, null);
});

test('runTick with MeteoSwiss stores the station on the location and reads h_now next time', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'ms', lat: 46.8, lon: 6.95 });
  const log = [];
  const deps = { requestJson: async () => { throw new Error('should not call Open-Meteo'); }, ...meteoSwissDeps(log) };
  const first = await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'meteoswiss', deps, warn: () => {} });
  assert.equal(first.failed, 0);
  // node:sqlite rows have a null prototype; spread them before a deep-equal.
  const loc = { ...db.raw.prepare('SELECT station_id, station_name, station_distance_km, station_resolved_at FROM weather_locations').get() };
  assert.deepEqual(loc, { station_id: 'PAY', station_name: 'Payerne', station_distance_km: 1.4, station_resolved_at: '2026-09-25T15:20:00Z' });
  assert.deepEqual(log.slice(-2), [wp.meteoSwissUrl('h_now', 'PAY'), wp.meteoSwissUrl('h_recent', 'PAY')]);
  log.length = 0;
  await wp.runTick({ db, nowIso: '2026-09-25T15:50:00Z', deploymentDefault: 'meteoswiss', deps, warn: () => {} });
  // The fixtures leave hour_start 2026-09-24T20:00 .. 22:00 empty, which the
  // gap rule would read from h_recent again, but h_recent was read 30 minutes
  // ago: the throttle keeps this tick to h_now.
  assert.deepEqual(log, [wp.meteoSwissUrl('h_now', 'PAY')]);
  // The fixture row stamped 11:00 (hour_start 10:00) carries erefaoh0 as delivered.
  assert.equal(typeof db.raw.prepare("SELECT et0_mm FROM weather_provider_hours WHERE hour_start = '2026-09-25T10:00:00Z'").get().et0_mm, 'number');
});

test('runTick re-resolves a MeteoSwiss station after 24 hours', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'ms', lat: 46.8, lon: 6.95 });
  const log = [];
  const deps = { requestJson: async () => { throw new Error('should not call Open-Meteo'); }, ...meteoSwissDeps(log) };
  // The fixture is dated 2026-09-25, so both ticks run on that day (an earlier
  // day would make the station look silent); the age of the resolution is
  // simulated by moving station_resolved_at back 25 hours.
  await wp.runTick({ db, nowIso: '2026-09-25T10:20:00Z', deploymentDefault: 'meteoswiss', deps, warn: () => {} });
  assert.equal(db.raw.prepare('SELECT station_resolved_at FROM weather_locations').get().station_resolved_at, '2026-09-25T10:20:00Z');
  db.raw.prepare("UPDATE weather_locations SET station_resolved_at = '2026-09-24T09:20:00Z'").run();
  log.length = 0;
  await wp.runTick({ db, nowIso: '2026-09-25T10:50:00Z', deploymentDefault: 'meteoswiss', deps, warn: () => {} });
  assert.equal(log.some((u) => u.endsWith('_meta_stations.csv')), true, 'station list re-read after a day');
  assert.equal(db.raw.prepare('SELECT station_resolved_at FROM weather_locations').get().station_resolved_at, '2026-09-25T10:50:00Z');
});

test('runTick flags a silent MeteoSwiss station and forgets it so the next tick re-resolves', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'ms', lat: 46.8, lon: 6.95 });
  const log = [];
  const deps = { requestJson: async () => { throw new Error('should not call Open-Meteo'); }, ...meteoSwissDeps(log) };
  const warnings = [];
  // The fixture's newest stamp is 25.09.2026 20:00 (hour_start 19:00). At 23:50 the newest completed hour is 22:00, more than 3 h later.
  const summary = await wp.runTick({ db, nowIso: '2026-09-25T23:50:00Z', deploymentDefault: 'meteoswiss', deps, warn: (m) => warnings.push(m) });
  assert.equal(summary.failed, 0);
  // The rows it did publish are kept, all inside the 1 January window: h_now's
  // 21 rows (hour_start 2026-09-24T23:00 .. 2026-09-25T19:00) and the h_recent
  // tail's 21 rows (2026-09-23T23:00 .. 2026-09-24T19:00).
  assert.equal(summary.stored, 42);
  const loc = { ...db.raw.prepare('SELECT station_id, last_error, last_success_at FROM weather_locations').get() };
  assert.equal(loc.station_id, null);
  assert.match(loc.last_error, /station PAY silent since 2026-09-25T19:00:00Z/);
  assert.equal(loc.last_success_at, '2026-09-25T23:50:00Z');
  assert.equal(warnings.length, 1);
});

test('runTick skips a location whose newest hour is more than a day after the clock', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'A', lat: 46.8, lon: 6.95 });
  const key = 'open_meteo:46.80:6.95';
  seedStoredHours(db, key, '2026-09-27T09:00:00Z', '2026-09-27T11:00:00Z', () => false);
  const log = [];
  const warnings = [];
  const summary = await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps: openMeteoOnlyDeps(log), warn: (m) => warnings.push(m) });
  assert.deepEqual(summary, { zones: 1, locations: 1, stored: 0, failed: 1 });
  assert.deepEqual(log, []);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM weather_provider_hours').get().n, 2);
  const loc = db.raw.prepare('SELECT last_error, last_success_at FROM weather_locations').get();
  assert.equal(loc.last_error, 'clock behind the store: newest hour 2026-09-27T10:00:00Z is after 2026-09-25T15:00:00Z');
  assert.equal(loc.last_success_at, null);
  assert.deepEqual(warnings, [key + ': ' + loc.last_error]);
  // An hour later the message names a later toUtc but it is the same
  // problem: no second warning.
  await wp.runTick({ db, nowIso: '2026-09-25T16:20:00Z', deploymentDefault: 'open_meteo', deps: openMeteoOnlyDeps(log), warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1);
  assert.match(db.raw.prepare('SELECT last_error FROM weather_locations').get().last_error, /is after 2026-09-25T16:00:00Z$/);
  // Within a day ahead is left to the window rule instead (rows re-read and
  // overwritten as real time passes them).
  const near = scratchDb();
  seedZone(near, { id: 1, name: 'A', lat: 46.8, lon: 6.95 });
  seedStoredHours(near, key, '2026-09-25T09:00:00Z', '2026-09-25T23:00:00Z', () => false);
  const ok = await wp.runTick({ db: near, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps: openMeteoOnlyDeps([]), warn: () => {} });
  assert.equal(ok.failed, 0);
  assert.equal(ok.stored, 3); // hour_start 12:00 .. 14:00
});

test('runTick treats a station resolution dated in the future as stale', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'ms', lat: 46.8, lon: 6.95 });
  db.raw.prepare("INSERT INTO weather_locations (location_key, provider, latitude, longitude, timezone, station_id, station_name, station_distance_km, station_resolved_at) VALUES ('meteoswiss:46.80:6.95', 'meteoswiss', 46.8, 6.95, 'Europe/Zurich', 'GRA', 'Fribourg / Grangeneuve', 13.8, '2026-09-26T10:00:00Z')").run();
  const log = [];
  const deps = { requestJson: async () => { throw new Error('should not call Open-Meteo'); }, ...meteoSwissDeps(log) };
  await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'meteoswiss', deps, warn: () => {} });
  assert.equal(log[0], wp.meteoSwissUrl('stations'));
  const loc = { ...db.raw.prepare('SELECT station_id, station_resolved_at FROM weather_locations').get() };
  assert.deepEqual(loc, { station_id: 'PAY', station_resolved_at: '2026-09-25T15:20:00Z' });
});

test('resolveMeteoSwissStation skips an excluded station, but not down to no station', async () => {
  const station = await wp.resolveMeteoSwissStation({ latitude: 46.8, longitude: 6.95 }, '2026-09-25T15:20:00Z', meteoSwissDeps([]), { excludeIds: ['PAY'] });
  assert.equal(station.id, 'GRA');
  // GRA without rain evidence: the excluded PAY is still better than no station.
  const noGraRain = {
    requestBuffer: async (url) => (url.endsWith('gra_d_recent.csv') ? Buffer.from('station_abbr;reference_timestamp;rka150d0\n') : meteoSwissDeps([]).requestBuffer(url)),
  };
  assert.equal((await wp.resolveMeteoSwissStation({ latitude: 46.8, longitude: 6.95 }, '2026-09-25T15:20:00Z', noGraRain, { excludeIds: ['PAY'] })).id, 'PAY');
});

test('runTick does not pick a silent station again on the next tick when another has rain data', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'ms', lat: 46.8, lon: 6.95 });
  const log = [];
  // meteoSwissDeps serves the d_recent fixture for GRA too, so GRA has rain evidence.
  const deps = { requestJson: async () => { throw new Error('should not call Open-Meteo'); }, ...meteoSwissDeps(log) };
  await wp.runTick({ db, nowIso: '2026-09-25T23:50:00Z', deploymentDefault: 'meteoswiss', deps, warn: () => {} });
  assert.match(db.raw.prepare('SELECT last_error FROM weather_locations').get().last_error, /station PAY silent/);
  log.length = 0;
  await wp.runTick({ db, nowIso: '2026-09-26T00:20:00Z', deploymentDefault: 'meteoswiss', deps, warn: () => {} });
  assert.equal(log.includes(wp.meteoSwissUrl('h_now', 'GRA')), true);
  assert.equal(log.includes(wp.meteoSwissUrl('h_now', 'PAY')), false);
});

test('runTick keeps the only station in range even after it went silent', async () => {
  const db = scratchDb();
  // Samedan: SAM is the only station of the trimmed list within 15 km.
  seedZone(db, { id: 1, name: 'ms', lat: 46.53, lon: 9.88 });
  const log = [];
  const deps = { requestJson: async () => { throw new Error('should not call Open-Meteo'); }, ...meteoSwissDeps(log) };
  await wp.runTick({ db, nowIso: '2026-09-25T23:50:00Z', deploymentDefault: 'meteoswiss', deps, warn: () => {} });
  assert.match(db.raw.prepare('SELECT last_error FROM weather_locations').get().last_error, /station SAM silent/);
  log.length = 0;
  const summary = await wp.runTick({ db, nowIso: '2026-09-26T00:20:00Z', deploymentDefault: 'meteoswiss', deps, warn: () => {} });
  assert.equal(summary.failed, 0);
  assert.equal(log.includes(wp.meteoSwissUrl('h_now', 'SAM')), true);
});

test('runTick reports a missing table once and stores nothing', async () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE irrigation_zones (id INTEGER PRIMARY KEY, latitude REAL, longitude REAL, timezone TEXT, weather_source TEXT, gateway_device_eui TEXT, deleted_at TEXT)');
  const db = { all: async (sql, p) => raw.prepare(sql).all(...(p || [])), run: async (sql, p) => { raw.prepare(sql).run(...(p || [])); } };
  const warnings = [];
  const summary = await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps: openMeteoOnlyDeps([]), warn: (m) => warnings.push(m) });
  assert.deepEqual(summary, { zones: 0, locations: 0, stored: 0, failed: 0, error: 'weather tables missing (deploy the schema migration)' });
  assert.equal(warnings.length, 1);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('httpDeps requestBuffer rejects when the response is cut off mid-body', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('partial');
    res.socket.destroy();
  });
  try {
    const port = await listen(server);
    const deps = wp.httpDeps({ http, https: http });
    await assert.rejects(deps.requestBuffer('http://127.0.0.1:' + port + '/x'), /aborted|socket hang up|closed/);
  } finally {
    server.close();
  }
});

test('httpDeps requestBuffer rejects on the overall deadline when a server trickles data forever', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    const timer = setInterval(() => { try { res.write('x'); } catch (error) { /* socket already gone */ } }, 50);
    res.on('close', () => clearInterval(timer));
  });
  try {
    const port = await listen(server);
    const deps = wp.httpDeps({ http, https: http, timeoutMs: 1000, deadlineMs: 300 });
    const start = Date.now();
    await assert.rejects(deps.requestBuffer('http://127.0.0.1:' + port + '/x'), /deadline/);
    assert.ok(Date.now() - start < 1000, 'deadline must fire well before a second');
  } finally {
    server.close();
  }
});

test('httpDeps requestBuffer rejects on a non-2xx status', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(500);
    res.end('boom');
  });
  try {
    const port = await listen(server);
    const deps = wp.httpDeps({ http, https: http });
    await assert.rejects(deps.requestBuffer('http://127.0.0.1:' + port + '/x'), /HTTP 500/);
  } finally {
    server.close();
  }
});

test('httpDeps requestJson rejects when the body is not JSON', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('not json');
  });
  try {
    const port = await listen(server);
    const deps = wp.httpDeps({ http, https: http });
    await assert.rejects(deps.requestJson('http://127.0.0.1:' + port + '/x'));
  } finally {
    server.close();
  }
});

test('zoneLocations returns every zone with coordinates, ordered by id; local zones carry no provider', async () => {
  const db = scratchDb();
  seedZone(db, { id: 2, name: 'B', lat: 46.7996, lon: 6.9501 });
  seedZone(db, { id: 1, name: 'A', lat: 46.8004, lon: 6.9499, weatherSource: 'meteoswiss' });
  seedZone(db, { id: 3, name: 'C', lat: 46.81, lon: 6.96, weatherSource: 'local' });
  seedZone(db, { id: 4, name: 'D', lat: null, lon: null });
  const rows = await wp.zoneLocations(db, 'open_meteo');
  assert.deepEqual(rows.map((r) => [r.zone.id, r.provider, r.locationKey, r.latitude, r.longitude]), [
    [1, 'meteoswiss', 'meteoswiss:46.80:6.95', 46.8, 6.95],
    [2, 'open_meteo', 'open_meteo:46.80:6.95', 46.8, 6.95],
    [3, null, null, 46.81, 6.96],
  ]);
  assert.equal(rows[0].zone.timezone, 'Europe/Zurich');
  assert.equal(rows[0].timezone, 'Europe/Zurich');
});

test('runTick stores station_id on MeteoSwiss hours and refetches an hour that lacks it', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'ms', lat: 46.8, lon: 6.95 });
  const key = 'meteoswiss:46.80:6.95';
  await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'meteoswiss', deps: { requestJson: async () => { throw new Error('no'); }, ...meteoSwissDeps([]) }, warn: () => {} });
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM weather_provider_hours WHERE station_id = 'PAY'").get().n, db.raw.prepare('SELECT COUNT(*) AS n FROM weather_provider_hours').get().n);
  // The fixtures leave 2026-09-24T20:00-22:00 empty, which alone would move the
  // gap window back. Fill those hours so the null-station hour is the only gap.
  const fill = db.raw.prepare("INSERT INTO weather_provider_hours (location_key, hour_start, air_temperature_c, station_id, fetched_at) VALUES (?, ?, 15, 'PAY', '2026-09-25T15:20:00Z')");
  for (const h of ['2026-09-24T20:00:00Z', '2026-09-24T21:00:00Z', '2026-09-24T22:00:00Z']) fill.run(key, h);
  db.raw.prepare("UPDATE weather_provider_hours SET station_id = NULL WHERE hour_start = '2026-09-25T10:00:00Z'").run();
  const summary = await wp.runTick({ db, nowIso: '2026-09-25T15:50:00Z', deploymentDefault: 'meteoswiss', deps: { requestJson: async () => { throw new Error('no'); }, ...meteoSwissDeps([]) }, warn: () => {} });
  assert.equal(summary.stored, 5, 'hours 10:00 to 14:00: the null-station hour moved the window back from 11:00');
  assert.equal(db.raw.prepare("SELECT station_id FROM weather_provider_hours WHERE hour_start = '2026-09-25T10:00:00Z'").get().station_id, 'PAY');
});
