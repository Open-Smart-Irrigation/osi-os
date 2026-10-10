#!/usr/bin/env node
'use strict';

// Regression test for the S2120 wind-gust field mixup.
//
// The former `s2120-process-fn` ("Process S2120") used to compute:
//   windGustMps: measurements['4213'] ?? measurements['4191'] ?? null
//
// measurementId 4213 is "Rain Accumulation" (per SENSECAP_S2120 measurement
// catalog, also see scripts/verify-codec-robustness.js's own fixture labelling
// 4191 " Peak Wind Gust" and 4213 "Rain Accumulation"), so any uplink carrying
// both ids silently reported the rain accumulation total as the wind gust
// speed. Only measurementId 4191 is Peak Wind Gust and must be the sole
// source for windGustMps.
//
// The measurement mapping now lives in osi-rain's parseS2120Measurements and
// the one S2120 writer is the `s2120-ingest-fn` node. This runs the shipped
// module, then the shipped node body (osi-flows-json-editing skill: never
// re-derive the logic by hand, exercise the shipped source) against a
// synthetic ChirpStack-decoded uplink carrying both measurement ids with
// different values, and asserts the stored wind_gust_mps is the 4191 value.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { facadeDb } = require('./lib/flow-node-harness');

const root = path.resolve(__dirname, '..');
const share = path.join(root, 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share');
const R = require(path.join(share, 'node-red', 'osi-rain', 'index.js'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const DEV_EUI = 'A840410000000001';

function buildObject(group) {
  return { messages: [group] };
}

async function storeThroughNode(object) {
  const flows = JSON.parse(fs.readFileSync(path.join(share, 'flows.json'), 'utf8'));
  const node = flows.find((entry) => entry.id === 's2120-ingest-fn');
  assert.ok(node && typeof node.func === 'string', 'missing Node-RED function node s2120-ingest-fn');
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(root, 'database', 'seed-blank.sql'), 'utf8'));
  db.exec(`INSERT INTO users (username, password_hash, created_at, user_uuid) VALUES ('owner', 'h', '2026-01-01', 'u-owner');
    INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at)
      VALUES ('${DEV_EUI}', 'Station', 'SENSECAP_S2120', 1, '2026-01-01', '2026-01-01');`);
  const facade = facadeDb(db);
  const errors = [];
  const fn = new AsyncFunction('msg', 'osiDb', 'osiLib', 'node', 'context', node.func);
  await fn(
    { payload: { deviceInfo: { devEui: DEV_EUI }, deduplicationId: 'gust-1', time: '2026-09-16T12:00:00.000Z', object } },
    { Database: function Database() { return facade; } },
    { require: (name) => (name === 'rain' ? { ok: true, value: R } : { ok: false, error: name }) },
    { status() {}, warn() {}, error(message) { errors.push(String(message)); } },
    { get() { return undefined; }, set() {} }
  );
  assert.deepEqual(errors, [], 's2120-ingest-fn reported no error');
  const row = db.prepare('SELECT wind_gust_mps, rain_gauge_cumulative_mm FROM device_data WHERE deveui = ?').get(DEV_EUI);
  db.close();
  return row;
}

async function main() {
  const gustValue = 7.6; // 4191 "Peak Wind Gust"
  const rainValue = 12.4; // 4213 "Rain Accumulation" -- must NOT be read as gust
  const both = buildObject([
    { measurementId: '4191', measurementValue: gustValue, type: ' Peak Wind Gust' },
    { measurementId: '4213', measurementValue: rainValue, type: 'Rain Accumulation' },
  ]);

  const parsed = R.parseS2120Measurements(both);
  assert.equal(
    parsed.windGustMps,
    gustValue,
    `windGustMps must equal measurementId 4191 (Peak Wind Gust)=${gustValue}, not 4213 (Rain Accumulation)=${rainValue}`
  );
  assert.notEqual(parsed.windGustMps, rainValue, 'windGustMps must never equal the Rain Accumulation (4213) value');

  const stored = await storeThroughNode(both);
  assert.ok(stored, 's2120-ingest-fn must write a device_data row');
  assert.equal(stored.wind_gust_mps, gustValue, 'the stored wind_gust_mps must be the 4191 value');
  assert.equal(stored.rain_gauge_cumulative_mm, rainValue, '4213 is stored as the cumulative rainfall');

  // A gust-only uplink (no 4213 present at all) must still populate windGustMps
  // from 4191 -- guards against a fix that drops 4191 entirely instead of just
  // dropping the 4213 fallback.
  const gustOnly = R.parseS2120Measurements(buildObject([
    { measurementId: '4191', measurementValue: 5.1, type: ' Peak Wind Gust' },
  ]));
  assert.equal(gustOnly.windGustMps, 5.1, 'windGustMps must still read 4191 when 4213 is absent');

  console.log('OK S2120 windGustMps reads measurementId 4191 (Peak Wind Gust) only, ignoring 4213 (Rain Accumulation)');
}

main().catch((error) => {
  console.error(`FAIL: ${error.stack || error.message}`);
  process.exitCode = 1;
});
