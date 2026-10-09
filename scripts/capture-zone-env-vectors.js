#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..');
const SEED = path.join(REPO, 'database/seed-blank.sql');
const FLOWS = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const CONTRACT_ROOT = path.join(REPO, 'docs/contracts/zone-env');
const CASES = ['local-openmeteo-water', 'provider-unavailable', 'crop-table-kc', 'crop-curve-kc', 'shared-server', 'shared-server-stale'];
const FIXED_NOW_ISO = '2026-07-11T10:00:00.000Z';
const FIXED_NOW_MS = Date.parse(FIXED_NOW_ISO);
const AUTH_SECRET = 'zone-env-vector-secret';

// Per-case database rows on top of the base seed. Each case's input.json
// carries its seed rows, and --verify replays the committed input.
const SEEDED_AT = '2026-07-11T08:00:00.000Z';
const AGRONOMY_SNAPSHOT_NULL = {
  et0_mm: null, et0_source: null, et0_tier: null, et0_station_id: null, location_key: null,
  kc: null, kc_source: null, crop_type: null, phenological_stage: null, etc_mm: null,
};
const MAIZE_MID = { kc: 1.2, kc_source: 'fao56_crop', crop_type: 'maize', phenological_stage: 'mid_season' };
function agronomyRow(date, fields) {
  return { zone_id: 1, date, ...AGRONOMY_SNAPSHOT_NULL, hours_present: 24, expected_hours: 24, null_reason: null, ...fields, computed_at: SEEDED_AT };
}
const STATION_DAY_ROW = agronomyRow('2026-07-08', {
  et0_mm: 5.0, et0_source: 'station_fao56', et0_tier: 'station_fao56', et0_station_id: 'S2120VECTOR0001', ...MAIZE_MID, etc_mm: 6.0,
});
// The 24 station hours behind the 2026-07-08 station_fao56 day.
const STATION_DAY_HOURS = Array.from({ length: 24 }, (_, hour) => ({
  deveui: 'S2120VECTOR0001',
  hour_start: `2026-07-08T${String(hour).padStart(2, '0')}:00:00Z`,
  air_temperature_c: 20,
  air_temperature_min_c: 14,
  air_temperature_max_c: 26,
  relative_humidity_pct: 60,
  wind_speed_mps: 1.5,
  global_radiation_wm2: hour >= 6 && hour <= 17 ? 600 : 0,
  sample_count: 4,
  computed_at: SEEDED_AT,
}));
function cloudBundle(lastDate, waterExtra = {}) {
  const daily = Array.from({ length: 7 }, (_, i) => ({
    date: new Date(Date.parse(`${lastDate}T00:00:00Z`) - (6 - i) * 86400000).toISOString().slice(0, 10),
    rainMm: 0.4,
    irrigationLiters: 0,
    irrigationNetMm: 0,
    totalWaterMm: 0.4,
  }));
  return {
    zoneId: 1,
    zoneName: 'Vector Zone',
    water: { available: true, waterNeededTodayMm: 3.1, rainTodayMm: 0.8, rainSource: 'gauge', ...waterExtra, daily },
  };
}
function sharedServerSeed(lastDate, waterExtra) {
  const bundle = cloudBundle(lastDate, waterExtra);
  return {
    userUpdate: { auth_mode: 'server', server_url: 'https://cloud.example.test', server_sync_token: 'vector-token' },
    rows: {
      zone_daily_agronomy: [STATION_DAY_ROW],
      // Two minutes old, so the node uses it without an HTTP fetch.
      zone_shared_environment: [{
        zone_uuid: 'zone-env-vector-zone',
        zone_id: 1,
        gateway_device_eui: '0016C001F1000001',
        summary_json: JSON.stringify(bundle),
        shared_generated_at: '2026-07-11T09:57:00.000Z',
        shared_observed_at: '2026-07-11T09:57:00.000Z',
        last_received_at: '2026-07-11T09:58:00.000Z',
      }],
    },
    cloudBundle: bundle,
  };
}
const CASE_SEEDS = {
  'local-openmeteo-water': { rows: {} },
  'provider-unavailable': { rows: {} },
  'crop-table-kc': {
    zoneUpdate: { crop_type: 'maize', phenological_stage: 'mid_season' },
    rows: {
      weather_station_hours: STATION_DAY_HOURS,
      zone_daily_agronomy: [
        agronomyRow('2026-07-05', { et0_mm: 4.6, et0_source: 'open_meteo_hourly_sum', et0_tier: 'provider_hourly_sum', location_key: 'open_meteo:46.80:8.20', ...MAIZE_MID, etc_mm: 5.52 }),
        agronomyRow('2026-07-06', { et0_mm: 4.2, et0_source: 'open_meteo_hourly_sum', et0_tier: 'provider_hourly_sum', location_key: 'open_meteo:46.80:8.20', ...MAIZE_MID, etc_mm: 5.04 }),
        agronomyRow('2026-07-07', { hours_present: 20, null_reason: 'partial_day' }),
        STATION_DAY_ROW,
        agronomyRow('2026-07-09', { et0_mm: 3.9, et0_source: 'meteoswiss_hourly_sum', et0_tier: 'provider_hourly_sum', et0_station_id: 'PAY', location_key: 'meteoswiss:46.80:8.20', kc: 0.75, kc_source: 'fao56_crop', crop_type: 'maize', phenological_stage: 'development', etc_mm: 2.93 }),
        agronomyRow('2026-07-10', { hours_present: 22, null_reason: 'pending' }),
      ],
    },
  },
  // Contract v2: a maize zone in development since 2026-06-21, so today (2026-07-11)
  // is day 21 of 40 on the FAO-56 curve (Kc 0.77) and the stored 2026-07-09 row
  // keeps the Kc it froze with (day 19, 0.73).
  'crop-curve-kc': {
    zoneUpdate: { crop_type: 'maize', phenological_stage: 'development', stage_started_on: '2026-06-21' },
    rows: {
      zone_daily_agronomy: [
        agronomyRow('2026-07-09', { et0_mm: 4.1, et0_source: 'open_meteo_hourly_sum', et0_tier: 'provider_hourly_sum', location_key: 'open_meteo:46.80:8.20', kc: 0.73, kc_source: 'fao56_curve', crop_type: 'maize', phenological_stage: 'development', stage_started_on: '2026-06-21', kc_stage_day: 19, stage_overrun: 0, etc_mm: 2.99 }),
      ],
    },
  },
  'shared-server': sharedServerSeed('2026-07-11'),
  // Yesterday's bundle carries its own rain, balance, forecast and verdict; the
  // expected output shows the gateway's values for every one of them (one day).
  'shared-server-stale': sharedServerSeed('2026-07-10', {
    rainTodayMm: 7.4,
    rainSource: 'meteoswiss_station',
    balanceTodayMm: 4.3,
    next24hRainMm: 12.5,
    action: { code: 'delay_irrigation', source: 'heuristic', reasonCode: 'supply_covers_demand', recommendationDate: '2026-07-10' },
  }),
};
const SEED_TABLE_ORDER = ['weather_station_hours', 'zone_daily_agronomy', 'zone_shared_environment'];
let currentBundle = null;

function sqlString(value) {
  return value == null ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`;
}

function toBase64Url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bearerToken() {
  const payloadB64 = toBase64Url(JSON.stringify({
    userId: 1,
    username: 'fixture-user',
    exp: FIXED_NOW_MS + 3600000,
  }));
  const sig = toBase64Url(crypto.createHmac('sha256', AUTH_SECRET).update(payloadB64).digest());
  return `Bearer ${payloadB64}.${sig}`;
}

function flowFunctionText() {
  const node = JSON.parse(fs.readFileSync(FLOWS, 'utf8')).find((entry) => entry.id === 'zone-env-fn');
  if (!node || node.name !== 'Get Zone Environment Summary') {
    throw new Error('zone-env-fn not found');
  }
  return node.func;
}

function makeFacadeShim(dbPath) {
  const db = new DatabaseSync(dbPath);
  const call = (kind) => (sql, cb) => {
    try {
      let result;
      if (kind === 'run') {
        db.exec(sql);
        result = undefined;
      } else {
        result = db.prepare(sql).all();
      }
      if (typeof cb === 'function') {
        process.nextTick(() => cb(null, result));
        return undefined;
      }
      return Promise.resolve(result);
    } catch (error) {
      if (typeof cb === 'function') {
        process.nextTick(() => cb(error));
        return undefined;
      }
      return Promise.reject(error);
    }
  };
  return {
    all: call('all'),
    run: call('run'),
    close(cb) {
      try { db.close(); } catch (_) {}
      if (typeof cb === 'function') cb();
    },
  };
}

function seedDb(dbPath, seedRows) {
  const db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(SEED, 'utf8'));
  db.exec(`
    INSERT INTO users(id,username,password_hash,created_at,updated_at,auth_mode,server_url,server_sync_token)
    VALUES(1,'fixture-user','x','${FIXED_NOW_ISO}','${FIXED_NOW_ISO}','local',NULL,NULL);

    INSERT INTO irrigation_zones(
      id,name,user_id,created_at,updated_at,deleted_at,timezone,zone_uuid,gateway_device_eui,
      area_m2,irrigation_efficiency_pct,scheduling_mode,latitude,longitude,phenological_stage
    ) VALUES(
      1,'Vector Zone',1,'${FIXED_NOW_ISO}','${FIXED_NOW_ISO}',NULL,'UTC','zone-env-vector-zone','0016C001F1000001',
      50,75,'local',46.8,8.2,'fruit_maturation'
    );

    INSERT INTO irrigation_schedules(id,irrigation_zone_id,trigger_metric,threshold_kpa,enabled,created_at,updated_at)
    VALUES(1,1,'DENDRO',3,1,'${FIXED_NOW_ISO}','${FIXED_NOW_ISO}');

    INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id,rain_gauge_enabled,flow_meter_enabled)
    VALUES
      ('S2120VECTOR0001','Weather Station','SENSECAP_S2120',1,'${FIXED_NOW_ISO}','${FIXED_NOW_ISO}',1,1,0),
      ('KIWIVECTOR00001','Kiwi Sensor','KIWI_SENSOR',1,'${FIXED_NOW_ISO}','${FIXED_NOW_ISO}',1,0,0);

    INSERT INTO device_data(
      deveui,recorded_at,ambient_temperature,relative_humidity,barometric_pressure_hpa,
      wind_speed_mps,wind_direction_deg,rain_mm_delta,rain_delta_status
    ) VALUES(
      'S2120VECTOR0001','2026-07-11T09:50:00.000Z',24.2,61,955,2.3,180,0.8,'ok'
    );
    INSERT INTO device_data(deveui,recorded_at,ambient_temperature,relative_humidity)
    VALUES('KIWIVECTOR00001','2026-07-11T09:40:00.000Z',23.8,63);

    INSERT INTO zone_daily_environment(zone_id,date,rainfall_mm,flow_liters,rain_source,computed_at)
    VALUES
      (1,'2026-07-09',0.5,0,'aquascope_lorain','2026-07-09T23:55:00.000Z'),
      (1,'2026-07-10',1.1,20,'aquascope_lorain','2026-07-10T23:55:00.000Z'),
      (1,'2026-07-11',0.8,15,'aquascope_lorain','2026-07-11T09:55:00.000Z');

    INSERT INTO zone_daily_recommendations(zone_id,date,irrigation_action,action_reasoning,computed_at)
    VALUES(1,'2026-07-11','irrigate_today','Fixture dendro recommendation','2026-07-11T09:58:00.000Z');

    INSERT INTO valve_actuation_expectations(
      expectation_id,device_eui,zone_id,command_id,effect_key,commanded_at,commanded_duration_seconds,
      expected_close_at,estimated_gross_liters,volume_source,reconciliation_state,created_at
    ) VALUES(
      'exp-zone-env-1','VALVEVECTOR0001',1,'cmd-zone-env-1','open:VALVEVECTOR0001',
      '2026-07-11T08:00:00.000Z',1800,'2026-07-11T08:30:00.000Z',
      12,'fixture','OBSERVED_RUNNING','2026-07-11T08:00:00.000Z'
    );
  `);
  const seed = seedRows || { rows: {} };
  const setClause = (update) => Object.keys(update).map((column) => `${column}=${sqlString(update[column])}`).join(',');
  if (seed.userUpdate) db.exec(`UPDATE users SET ${setClause(seed.userUpdate)} WHERE id = 1`);
  if (seed.zoneUpdate) db.exec(`UPDATE irrigation_zones SET ${setClause(seed.zoneUpdate)} WHERE id = 1`);
  const rows = seed.rows || {};
  for (const table of Object.keys(rows)) {
    if (!SEED_TABLE_ORDER.includes(table)) throw new Error(`unsupported seed table ${table}`);
  }
  for (const table of SEED_TABLE_ORDER) {
    for (const row of rows[table] || []) {
      const keys = Object.keys(row);
      db.exec(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((key) => sqlString(row[key])).join(',')})`);
    }
  }
  db.close();
}

// The fixture zone is UTC, so Open-Meteo's response offset is 0 and a label
// is UTC. Times come back as Unix seconds when the request asks for them.
function openMeteoTime(url, label) {
  if (!url.includes('timeformat=unixtime')) return label;
  return Date.parse(label.length === 10 ? `${label}T00:00:00Z` : `${label}:00Z`) / 1000;
}

function responseFor(url) {
  if (url.includes('/environment-bundles')) {
    if (!currentBundle) throw new Error(`unexpected HTTP URL in zone-env vector harness: ${url}`);
    return [{ zoneUuid: 'zone-env-vector-zone', summary: currentBundle }];
  }
  if (url.includes('current=')) {
    return {
      utc_offset_seconds: 0,
      current: {
        time: openMeteoTime(url, '2026-07-11T10:00'),
        temperature_2m: 25.1,
        relative_humidity_2m: 58,
        precipitation: 0.2,
        cloud_cover: 35,
        pressure_msl: 958.2,
        wind_speed_10m: 2.8,
        wind_direction_10m: 175,
      },
    };
  }
  if (url.includes('hourly=')) {
    return {
      utc_offset_seconds: 0,
      hourly: {
        time: ['2026-07-11T10:00', '2026-07-11T13:00', '2026-07-11T16:00'].map((label) => openMeteoTime(url, label)),
        temperature_2m: [25.1, 27.2, 26.5],
        relative_humidity_2m: [58, 54, 57],
        precipitation: [0.2, 1.4, 0],
        precipitation_probability: [30, 80, 20],
        wind_speed_10m: [2.8, 3.4, 2.1],
        wind_direction_10m: [175, 190, 160],
      },
      daily: {
        time: ['2026-07-11', '2026-07-12'].map((label) => openMeteoTime(url, label)),
        weather_code: [61, 3],
        precipitation_sum: [1.6, 0.4],
        precipitation_probability_max: [80, 35],
        et0_fao_evapotranspiration: [5.0, 4.4],
        temperature_2m_min: [16.2, 15.9],
        temperature_2m_max: [27.2, 26.4],
      },
    };
  }
  throw new Error(`unexpected HTTP URL in zone-env vector harness: ${url}`);
}

function makeHttpStub(mode) {
  return {
    request(url, _options, callback) {
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.write = () => {};
      req.destroy = (error) => req.emit('error', error);
      req.end = () => {
        process.nextTick(() => {
          const res = new EventEmitter();
          if (mode === 'fail') {
            res.statusCode = 503;
            callback(res);
            process.nextTick(() => {
              res.emit('data', 'Service Unavailable');
              res.emit('end');
            });
          } else {
            res.statusCode = 200;
            callback(res);
            process.nextTick(() => {
              res.emit('data', JSON.stringify(responseFor(String(url))));
              res.emit('end');
            });
          }
        });
      };
      return req;
    },
  };
}

function fixedDateClass(RealDate) {
  return class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [FIXED_NOW_MS]));
    }
    static now() { return FIXED_NOW_MS; }
    static parse(value) { return RealDate.parse(value); }
    static UTC(...args) { return RealDate.UTC(...args); }
  };
}

async function runCase(caseName, seedRows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zone-env-vector-'));
  const dbPath = path.join(dir, 'farming.db');
  seedDb(dbPath, seedRows);
  currentBundle = seedRows && seedRows.cloudBundle ? seedRows.cloudBundle : null;

  const errors = [];
  const statuses = [];
  const logs = [];
  const node = {
    error(message) { errors.push(String(message && message.message ? message.message : message)); },
    warn(message) { logs.push(String(message && message.message ? message.message : message)); },
    log(message) { logs.push(String(message)); },
    status(status) { statuses.push(status); },
  };
  const msg = {
    req: {
      headers: { authorization: bearerToken() },
      params: { zone_id: '1' },
      query: {},
    },
  };
  const env = {
    get(key) {
      if (key === 'AUTH_TOKEN_SECRET' || key === 'JWT_SECRET') return AUTH_SECRET;
      if (key === 'OPENAGRI_WEATHER_CURRENT_CACHE_MINUTES') return '30';
      if (key === 'OPENAGRI_WEATHER_FORECAST_CACHE_MINUTES') return '120';
      return '';
    },
  };
  const osiDb = { Database: function Database() { return makeFacadeShim(dbPath); } };
  const httpMode = caseName === 'provider-unavailable' ? 'fail' : 'ok';
  const httpStub = makeHttpStub(httpMode);
  const osiLib = {
    require(name) {
      if (name === 'zone-env') {
        return { ok: true, value: require(path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env')) };
      }
      return { ok: false, error: `unknown module ${name}` };
    },
  };

  const RealDate = global.Date;
  global.Date = fixedDateClass(RealDate);
  try {
    const fn = new Function('osiDb', 'crypto', 'httpLib', 'httpsLib', 'env', 'node', 'msg', 'osiLib', flowFunctionText());
    const result = await fn(osiDb, crypto, httpStub, httpStub, env, node, msg, osiLib);
    const response = result && result.payload ? result : msg;
    if (response.statusCode !== 200) {
      throw new Error(`unexpected status ${response.statusCode}: ${JSON.stringify(response.payload)}`);
    }
    return { payload: response.payload, errors, statuses, logs };
  } finally {
    global.Date = RealDate;
    currentBundle = null;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

function inputFixture(caseName) {
  const base = {
    schemaVersion: 1,
    case: caseName,
    fixedNow: FIXED_NOW_ISO,
    request: { zone_id: 1, userId: 1 },
    seed: {
      user: 'fixture-user',
      zone: 'Vector Zone',
      devices: ['S2120VECTOR0001', 'KIWIVECTOR00001'],
      waterDates: ['2026-07-09', '2026-07-10', '2026-07-11'],
      estimatedValveLiters: 12,
    },
  };
  if (caseName === 'provider-unavailable') {
    base.httpStubs = { provider: 'open-meteo', behaviour: '503-all-requests' };
  } else {
    base.httpStubs = {
      provider: 'open-meteo',
      currentTime: '2026-07-11T10:00',
      forecastHours: ['2026-07-11T10:00', '2026-07-11T13:00', '2026-07-11T16:00'],
    };
  }
  base.seedRows = CASE_SEEDS[caseName];
  return base;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function capture() {
  writeJson(path.join(CONTRACT_ROOT, 'MANIFEST.json'), {
    schemaVersion: 1,
    cases: CASES,
  });
  for (const caseName of CASES) {
    const result = await runCase(caseName, CASE_SEEDS[caseName]);
    writeJson(path.join(CONTRACT_ROOT, 'cases', `${caseName}.input.json`), inputFixture(caseName));
    writeJson(path.join(CONTRACT_ROOT, 'cases', `${caseName}.expected.json`), result.payload);
    console.log(`Captured zone-env vector ${caseName}`);
  }
}

async function verify() {
  for (const caseName of CASES) {
    const input = readJson(path.join(CONTRACT_ROOT, 'cases', `${caseName}.input.json`));
    const result = await runCase(caseName, input.seedRows);
    const expected = readJson(path.join(CONTRACT_ROOT, 'cases', `${caseName}.expected.json`));
    assert.deepEqual(result.payload, expected);
    console.log(`Verified zone-env vector ${caseName}`);
  }
}

async function main() {
  const mode = process.argv[2];
  if (mode === '--capture') return capture();
  if (mode === '--verify') return verify();
  throw new Error('Usage: node scripts/capture-zone-env-vectors.js --capture|--verify');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
