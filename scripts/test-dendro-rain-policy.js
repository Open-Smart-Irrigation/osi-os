#!/usr/bin/env node
'use strict';

// dendro-compute-fn under the rain-resolution policy
// (docs/contracts/rainfall/rain-resolution-policy.md, osi-rain.resolveAdviceRain):
// the zone's certified gauge day wins over provider rain, a certified 0 mm
// included; an uncertified day's received amount is a lower bound that may
// start rain suppression but never fills the amount or the rolling sum;
// unknown rain is null, stored as NULL, and never starts suppression. Legacy
// rows keep the earlier reading (a positive local amount).
//
// Runs the shipped function body (both profiles) against an in-memory database
// on seed-blank.sql, with a fixed clock and a stubbed HTTP module.
//
// Run: node --test scripts/test-dendro-rain-policy.js

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
const DAY = '2026-10-08'; // the analytics date (yesterday in UTC)
const TREE = 'A840410000000001';
const GAUGE = 'A840410000000002';
const GATEWAY = '0016C001F1000001';

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

// answer(url) -> { status, body }; records the URLs asked for.
function stubHttp(answer, calls) {
  return {
    request(url, _options, onResponse) {
      calls.push(String(url));
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.write = () => {};
      req.destroy = (error) => process.nextTick(() => req.emit('error', error));
      req.end = () => {
        process.nextTick(() => {
          const weather = answer(String(url));
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
  const precipitation = Array.from({ length: 24 }, (_, i) => (i === 0 ? rainTotalMm : 0));
  return {
    status: 200,
    body: { hourly: { temperature_2m: Array(24).fill(18), relative_humidity_2m: Array(24).fill(70), precipitation } },
  };
}
const FAILED = { status: 500, body: null };

function seedDb({ linked = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(SEED, 'utf8'));
  db.exec(`
    INSERT INTO users(id, username, password_hash, created_at) VALUES (1, 'fixture', 'not-a-real-password', '${NOW_ISO}');
    INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, created_at, updated_at, timezone, latitude, longitude)
    VALUES (1, 'Fixture Zone', 1, 'z-1', '${NOW_ISO}', '${NOW_ISO}', 'UTC', 46.5, 7.5);
    INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at, irrigation_zone_id, dendro_enabled, is_reference_tree)
    VALUES ('${TREE}', 'Fixture Tree', 'DRAGINO_LSN50', 1, '${NOW_ISO}', '${NOW_ISO}', 1, 1, 0);
  `);
  if (linked) {
    db.prepare("INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) VALUES ('cloud', 1, ?, ?)").run(GATEWAY, NOW_ISO);
  }
  return db;
}

// A policy-1 zone day as the R-ZONE projection writes it.
function zoneDay(db, { coverage, rainfallMm = null, receivedMm = null, reasons = [], deveui = GAUGE, source = 'aquascope_lorain', date = DAY }) {
  db.prepare(`INSERT INTO zone_daily_environment(zone_id, date, rainfall_mm, flow_liters, rain_source, computed_at, rain_coverage,
      rain_selected_deveui, rain_policy_version, rain_quality_reasons, rain_received_mm) VALUES (1, ?, ?, 0, ?, ?, ?, ?, 1, ?, ?)`)
    .run(date, rainfallMm, source, NOW_ISO, coverage, deveui, JSON.stringify(reasons), receivedMm);
}
// A zone day written before policy version 1 (no coverage columns).
function legacyZoneDay(db, { rainfallMm, source }) {
  db.prepare('INSERT INTO zone_daily_environment(zone_id, date, rainfall_mm, flow_liters, rain_source, computed_at) VALUES (1, ?, ?, 0, ?, ?)')
    .run(DAY, rainfallMm, source, NOW_ISO);
}
function addRecommendation(db, date, rainfallMm) {
  db.prepare(`INSERT INTO zone_daily_recommendations(zone_id, date, zone_stress_summary, rainfall_mm, irrigation_action, recommendation_json, computed_at)
    VALUES (1, ?, 'none', ?, 'maintain', NULL, ?)`).run(date, rainfallMm, NOW_ISO);
}
// One tree with a complete, unstressed analytics day (as test-dendro-rolling-7d-rain.js).
function addUnstressedTreeDay(db, date = DAY) {
  db.exec(`INSERT INTO dendro_baselines(deveui, mds_max_reference_um, mds_mean_um, baseline_days, baseline_complete, computed_at)
    VALUES ('${TREE}', 45, 38, 14, 1, '${NOW_ISO}');`);
  const readings = [
    [121, '05:05:00'], [124, '05:35:00'], [122, '06:10:00'], [108, '09:00:00'],
    [92, '13:05:00'], [90, '14:00:00'], [93, '15:30:00'], [101, '18:00:00'],
  ];
  const insert = db.prepare('INSERT INTO dendrometer_readings(deveui, position_um, is_valid, recorded_at) VALUES (?, ?, 1, ?)');
  for (const [position, time] of readings) insert.run(TREE, position, `${date}T${time}.000Z`);
}

async function runDendro(db, { weather = FAILED, profile = PROFILES[0], envVars = {} } = {}) {
  const share = path.join(ROOT, profile);
  const node = loadNode('dendro-compute-fn', path.join(share, 'flows.json'));
  const facade = facadeDb(db);
  const calls = [];
  const errors = [];
  const warnings = [];
  const fakeNode = { error: (v) => errors.push(String(v)), warn: (v) => warnings.push(String(v)), log: () => {}, status: () => {} };
  const osiDb = { Database: function Database() { return facade; } };
  const modules = { 'dendro-analytics': 'osi-dendro-analytics', rain: 'osi-rain' };
  const osiLib = {
    require(name) {
      if (!modules[name]) return { ok: false, error: `unexpected helper ${name}` };
      return { ok: true, value: require(path.join(share, 'node-red', modules[name])) }; // eslint-disable-line global-require
    },
  };
  const answer = typeof weather === 'function' ? weather : () => weather;
  const http = stubHttp(answer, calls);
  const fakeRequire = (name) => (name === 'http' || name === 'https' ? http : require(name)); // eslint-disable-line global-require
  const env = { get: (key) => (Object.prototype.hasOwnProperty.call(envVars, key) ? envVars[key] : '') };
  // eslint-disable-next-line no-new-func
  const fn = new Function('osiDb', 'osiLib', 'env', 'node', 'msg', 'require', 'Date', node.func);
  const result = await fn(osiDb, osiLib, env, fakeNode, {}, fakeRequire, makeFixedDate(NOW_ISO));
  assert.deepEqual(errors, [], 'dendro-compute-fn reported errors');
  return { result, calls, warnings };
}

function recommendation(db, date = DAY) {
  const row = db.prepare('SELECT * FROM zone_daily_recommendations WHERE zone_id = 1 AND date = ?').get(date);
  assert.ok(row, `a recommendation row exists for ${date}`);
  return { row, json: JSON.parse(row.recommendation_json) };
}
function suppression(db) {
  return { ...db.prepare('SELECT rain_suppression_active, rain_suppression_timeout_h FROM zone_irrigation_state WHERE zone_id = 1').get() };
}

for (const profile of PROFILES) {
  const tag = profile.includes('bcm2709') ? 'bcm2709' : 'bcm2712';

  test(`[${tag}] (a) a certified local 0 mm outranks a provider's 6 mm: no rain suppression (A33)`, async () => {
    const db = seedDb();
    zoneDay(db, { coverage: 'complete', rainfallMm: 0 });
    await runDendro(db, { weather: openMeteoDay(6), profile });
    const { row, json } = recommendation(db);
    assert.equal(json.rain.daily_mm, 0);
    assert.equal(json.rain.daily_status, 'observed');
    assert.equal(json.rain.source, 'local_gauge');
    assert.equal(json.rain.coverage, 'complete');
    assert.equal(json.rain.deveui, GAUGE);
    assert.equal(json.rain.lower_bound_mm, null);
    assert.equal(json.rain.policy_version, 1);
    assert.notEqual(row.irrigation_action, 'maintain_rain_suppression');
    assert.equal(row.rainfall_mm, 0);
    assert.equal(suppression(db).rain_suppression_active, 0);
    db.close();
  });

  test(`[${tag}] a certified local 10 mm starts suppression against a dry provider (A34)`, async () => {
    const db = seedDb();
    zoneDay(db, { coverage: 'complete', rainfallMm: 10, source: 'sensecap_s2120' });
    await runDendro(db, { weather: openMeteoDay(0), profile });
    const { row, json } = recommendation(db);
    assert.equal(row.irrigation_action, 'maintain_rain_suppression');
    assert.equal(row.action_reasoning, 'New rain: 10mm');
    assert.equal(json.rain.daily_mm, 10);
    assert.equal(json.rain.source, 'local_gauge');
    assert.deepEqual(suppression(db), { rain_suppression_active: 1, rain_suppression_timeout_h: 48 });
    db.close();
  });

  test(`[${tag}] (b) a partial local day that received 7 mm starts suppression on the lower bound; the amount stays the provider's`, async () => {
    const db = seedDb();
    addRecommendation(db, '2026-10-06', 1);
    zoneDay(db, { coverage: 'partial', receivedMm: 7, reasons: ['frame_gap'] });
    await runDendro(db, { weather: openMeteoDay(0), profile });
    const { row, json } = recommendation(db);
    assert.equal(row.irrigation_action, 'maintain_rain_suppression');
    assert.match(row.action_reasoning, /at least 7(\.0)?\s?mm received by the local gauge/);
    assert.equal(json.rain.daily_mm, 0);
    assert.equal(json.rain.source, 'open_meteo');
    assert.equal(json.rain.lower_bound_mm, 7);
    assert.equal(json.rain.suppression_mm, 7);
    assert.equal(json.rain.deveui, GAUGE);
    assert.deepEqual(json.rain.reasons, ['frame_gap', 'local_partial']);
    assert.equal(json.rain.covered_hours, 24);
    assert.equal(json.rain.expected_hours, 24);
    // The lower bound never enters the rolling sum or the stored amount.
    assert.equal(json.rain.rolling7d, 1);
    assert.equal(row.rainfall_mm, 0);
    assert.deepEqual(suppression(db), { rain_suppression_active: 1, rain_suppression_timeout_h: 48 });
    db.close();
  });

  test(`[${tag}] a lower bound of 15 mm or more picks the 72-hour timeout; a lower bound under 5 mm does not suppress`, async () => {
    const heavy = seedDb();
    zoneDay(heavy, { coverage: 'unknown', receivedMm: 16, reasons: ['received_only', 'build_unpinned'] });
    await runDendro(heavy, { weather: FAILED, profile });
    assert.equal(recommendation(heavy).row.irrigation_action, 'maintain_rain_suppression');
    assert.equal(recommendation(heavy).json.rain.daily_mm, null);
    assert.deepEqual(suppression(heavy), { rain_suppression_active: 1, rain_suppression_timeout_h: 72 });
    heavy.close();
    const light = seedDb();
    zoneDay(light, { coverage: 'partial', receivedMm: 3, reasons: ['frame_gap'] });
    await runDendro(light, { weather: FAILED, profile });
    assert.notEqual(recommendation(light).row.irrigation_action, 'maintain_rain_suppression');
    assert.equal(suppression(light).rain_suppression_active, 0);
    light.close();
  });

  test(`[${tag}] (c) everything unknown: rain null, rainfall_mm NULL (key kept in the sync payload), no suppression, stress logic unchanged`, async () => {
    const db = seedDb({ linked: true });
    addUnstressedTreeDay(db);
    await runDendro(db, { weather: FAILED, profile });
    const { row, json } = recommendation(db);
    assert.equal(json.rain.daily_mm, null);
    assert.equal(json.rain.daily_status, 'unknown');
    assert.equal(json.rain.source, 'none');
    assert.equal(json.rain.coverage, 'unknown');
    assert.deepEqual(json.rain.warnings, ['rain_unknown']);
    assert.deepEqual(json.rain.reasons, ['no_gauge', 'rain_unknown']);
    assert.equal(json.rain.suppression_mm, null);
    assert.equal(row.rainfall_mm, null);
    assert.equal(row.irrigation_action, 'decrease_10', 'the no-stress rule still answers');
    assert.equal(suppression(db).rain_suppression_active, 0);
    const outbox = db.prepare("SELECT payload_json FROM sync_outbox WHERE aggregate_type = 'ZONE_RECOMMENDATION' ORDER BY rowid DESC LIMIT 1").get();
    assert.ok(outbox, 'the recommendation is queued for the cloud');
    const payload = JSON.parse(outbox.payload_json);
    assert.ok(Object.prototype.hasOwnProperty.call(payload, 'rainfall_mm'), 'rainfall_mm is sent');
    assert.equal(payload.rainfall_mm, null, 'as an explicit null');
    db.close();
  });

  // r-r7d-review.md, measured dry day: a certified gauge 0 without a provider is observed.
  test(`[${tag}] a certified gauge 0 mm with no provider value is observed, without a warning, and counted present`, async () => {
    const db = seedDb();
    zoneDay(db, { coverage: 'complete', rainfallMm: 0, source: 'sensecap_s2120' });
    await runDendro(db, { weather: FAILED, profile });
    const { json } = recommendation(db);
    assert.equal(json.rain.daily_mm, 0);
    assert.equal(json.rain.daily_status, 'observed');
    assert.deepEqual(json.rain.warnings, []);
    assert.equal(json.rain.source, 'local_gauge');
    assert.equal(json.rain.rolling7d_days_present, 1);
    db.close();
  });

  // r-r7d-review.md: an LSN50 flow-only local_gauge/0 row is not proof of a dry day.
  test(`[${tag}] an LSN50 flow-only zone day (legacy local_gauge 0, or policy-1 unknown) with no provider is unknown`, async () => {
    const legacy = seedDb();
    legacyZoneDay(legacy, { rainfallMm: 0, source: 'local_gauge' });
    await runDendro(legacy, { weather: FAILED, profile });
    const l = recommendation(legacy).json.rain;
    assert.equal(l.daily_status, 'unknown');
    assert.equal(l.daily_mm, null);
    assert.deepEqual(l.reasons, ['legacy_row', 'rain_unknown']);
    assert.equal(l.rolling7d_days_present, 0);
    legacy.close();
    const policy = seedDb();
    zoneDay(policy, { coverage: 'unknown', reasons: ['frame_gap'], source: 'local_gauge', deveui: TREE });
    await runDendro(policy, { weather: FAILED, profile });
    const p = recommendation(policy).json.rain;
    assert.equal(p.daily_status, 'unknown');
    assert.equal(p.daily_mm, null);
    assert.deepEqual(p.reasons, ['frame_gap', 'local_unknown', 'rain_unknown']);
    policy.close();
  });

  test(`[${tag}] a legacy positive local amount keeps the earlier reading (local before provider)`, async () => {
    const db = seedDb();
    legacyZoneDay(db, { rainfallMm: 6, source: 'aquascope_lorain' });
    await runDendro(db, { weather: openMeteoDay(0), profile });
    const { row, json } = recommendation(db);
    assert.equal(json.rain.daily_mm, 6);
    assert.equal(json.rain.source, 'local_gauge');
    assert.equal(json.rain.coverage, 'legacy_unvalidated');
    assert.deepEqual(json.rain.warnings, []);
    assert.equal(row.irrigation_action, 'maintain_rain_suppression');
    db.close();
  });

  test(`[${tag}] a provider without rain values passes to the next provider (OpenAgri temperature-only, then Open-Meteo)`, async () => {
    const db = seedDb();
    const weather = (url) => (url.includes('/api/v1/')
      ? { status: 200, body: { data: [{ values: { temperature_2m: 18, relative_humidity_2m: 70 } }] } }
      : openMeteoDay(3));
    const { calls } = await runDendro(db, {
      weather,
      profile,
      envVars: { OPENAGRI_WEATHER_URL: 'https://weather.example.invalid', OPENAGRI_WEATHER_BEARER_TOKEN: 'test-token' },
    });
    assert.ok(calls.some((u) => u.includes('archive-api.open-meteo.com')), 'Open-Meteo was asked for rain');
    const { json } = recommendation(db);
    assert.equal(json.rain.daily_mm, 3);
    assert.equal(json.rain.source, 'open_meteo');
    assert.equal(json.vpd.vpd_source, 'openagri', 'VPD stays the first provider\'s');
    db.close();
  });
}
