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
const CASE_NAME = 'local-openmeteo-water';
const FIXED_NOW_ISO = '2026-07-11T10:00:00.000Z';
const FIXED_NOW_MS = Date.parse(FIXED_NOW_ISO);
const AUTH_SECRET = 'zone-env-vector-secret';

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

function seedDb(dbPath) {
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
  db.close();
}

function responseFor(url) {
  if (url.includes('current=')) {
    return {
      current: {
        time: '2026-07-11T10:00',
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
      hourly: {
        time: ['2026-07-11T10:00', '2026-07-11T13:00', '2026-07-11T16:00'],
        temperature_2m: [25.1, 27.2, 26.5],
        relative_humidity_2m: [58, 54, 57],
        precipitation: [0.2, 1.4, 0],
        precipitation_probability: [30, 80, 20],
        wind_speed_10m: [2.8, 3.4, 2.1],
        wind_direction_10m: [175, 190, 160],
      },
      daily: {
        time: ['2026-07-11', '2026-07-12'],
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

function makeHttpStub() {
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
            res.emit('data', JSON.stringify(responseFor(String(url))));
            res.emit('end');
          });
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

async function runCase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zone-env-vector-'));
  const dbPath = path.join(dir, 'farming.db');
  seedDb(dbPath);

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
  const httpStub = makeHttpStub();
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
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

function inputFixture() {
  return {
    schemaVersion: 1,
    case: CASE_NAME,
    fixedNow: FIXED_NOW_ISO,
    request: { zone_id: 1, userId: 1 },
    seed: {
      user: 'fixture-user',
      zone: 'Vector Zone',
      devices: ['S2120VECTOR0001', 'KIWIVECTOR00001'],
      waterDates: ['2026-07-09', '2026-07-10', '2026-07-11'],
      estimatedValveLiters: 12,
    },
    httpStubs: {
      provider: 'open-meteo',
      currentTime: '2026-07-11T10:00',
      forecastHours: ['2026-07-11T10:00', '2026-07-11T13:00', '2026-07-11T16:00'],
    },
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function capture() {
  const result = await runCase();
  writeJson(path.join(CONTRACT_ROOT, 'MANIFEST.json'), {
    schemaVersion: 1,
    cases: [CASE_NAME],
  });
  writeJson(path.join(CONTRACT_ROOT, 'cases', `${CASE_NAME}.input.json`), inputFixture());
  writeJson(path.join(CONTRACT_ROOT, 'cases', `${CASE_NAME}.expected.json`), result.payload);
  console.log(`Captured zone-env vector ${CASE_NAME}`);
}

async function verify() {
  const result = await runCase();
  const expected = readJson(path.join(CONTRACT_ROOT, 'cases', `${CASE_NAME}.expected.json`));
  assert.deepEqual(result.payload, expected);
  console.log(`Verified zone-env vector ${CASE_NAME}`);
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
