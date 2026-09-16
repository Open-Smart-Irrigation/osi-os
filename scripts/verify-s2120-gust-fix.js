#!/usr/bin/env node
'use strict';

// Regression test for the S2120 wind-gust field mixup.
//
// `s2120-process-fn` ("Process S2120") used to compute:
//   windGustMps: measurements['4213'] ?? measurements['4191'] ?? null
//
// measurementId 4213 is "Rain Accumulation" (per SENSECAP_S2120 measurement
// catalog, also see scripts/verify-codec-robustness.js's own fixture labelling
// 4191 " Peak Wind Gust" and 4213 "Rain Accumulation"), so any uplink carrying
// both ids silently reported the rain accumulation total as the wind gust
// speed. Only measurementId 4191 is Peak Wind Gust and must be the sole
// source for windGustMps.
//
// This extracts the real 's2120-process-fn' function node from the shipped
// flows.json and runs its actual body (osi-flows-json-editing skill: never
// re-derive the logic by hand, exercise the shipped source) against a
// synthetic ChirpStack-decoded uplink carrying both measurement ids with
// different values, then asserts windGustMps resolves to the 4191 value.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const flowPath = path.resolve(
  __dirname,
  '..',
  'conf',
  'full_raspberrypi_bcm27xx_bcm2712',
  'files',
  'usr',
  'share',
  'flows.json'
);

function loadJson(jsonPath) {
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

function getFunctionNodeById(flows, id) {
  const node = flows.find((entry) => entry.id === id);
  assert.ok(node, `missing Node-RED function node ${id}`);
  assert.equal(typeof node.func, 'string', `${id} must include executable source`);
  return node;
}

// Same wrapping convention as scripts/verify-sync-flow.js's executeFunctionNodeById:
// s2120-process-fn's body uses top-level `await` without its own `return (async
// () => {...})()` wrapper (Node-RED's real runtime evaluates function-node code as
// an AsyncFunction), so the harness must supply that wrapper explicitly.
function buildFunction(node) {
  const script = new vm.Script(
    `(async function(msg, node, osiDb) {${node.func}\n})`,
    { filename: `${node.id}.vm.js` }
  );
  return script.runInNewContext({
    Buffer,
    console,
  });
}

function buildMsg(devEui, group) {
  return {
    payload: {
      deviceInfo: { devEui },
      time: '2026-09-16T12:00:00.000Z',
      object: {
        messages: [group],
      },
    },
  };
}

class FakeDb {
  constructor(typeId) {
    this.typeId = typeId;
  }
  all(_sql, callback) {
    callback(null, [{ type_id: this.typeId }]);
  }
  close(callback) {
    callback();
  }
}

async function main() {
  const flows = loadJson(flowPath);
  const node = getFunctionNodeById(flows, 's2120-process-fn');
  const fn = buildFunction(node);

  const nodeApi = { status() {}, warn() {}, error() {} };
  const osiDb = { Database: class extends FakeDb { constructor() { super('SENSECAP_S2120'); } } };

  const gustValue = 7.6; // 4191 "Peak Wind Gust"
  const rainValue = 12.4; // 4213 "Rain Accumulation" -- must NOT be read as gust
  const msg = buildMsg('2CF7F1C0043A0001', [
    { measurementId: '4191', measurementValue: gustValue, type: ' Peak Wind Gust' },
    { measurementId: '4213', measurementValue: rainValue, type: 'Rain Accumulation' },
  ]);

  const result = await fn(msg, nodeApi, osiDb);

  assert.ok(Array.isArray(result), 's2120-process-fn must return a Node-RED output array');
  const outMsg = result[0];
  assert.ok(outMsg && outMsg.formattedData, 's2120-process-fn must attach formattedData to output 1');
  assert.equal(
    outMsg.formattedData.windGustMps,
    gustValue,
    `windGustMps must equal measurementId 4191 (Peak Wind Gust)=${gustValue}, not 4213 (Rain Accumulation)=${rainValue}`
  );
  assert.notEqual(
    outMsg.formattedData.windGustMps,
    rainValue,
    'windGustMps must never equal the Rain Accumulation (4213) value'
  );

  // A gust-only uplink (no 4213 present at all) must still populate windGustMps
  // from 4191 -- guards against a fix that drops 4191 entirely instead of just
  // dropping the 4213 fallback.
  const gustOnlyMsg = buildMsg('2CF7F1C0043A0001', [
    { measurementId: '4191', measurementValue: 5.1, type: ' Peak Wind Gust' },
  ]);
  const gustOnlyResult = await fn(gustOnlyMsg, nodeApi, osiDb);
  assert.equal(
    gustOnlyResult[0].formattedData.windGustMps,
    5.1,
    'windGustMps must still read 4191 when 4213 is absent'
  );

  console.log('OK S2120 windGustMps reads measurementId 4191 (Peak Wind Gust) only, ignoring 4213 (Rain Accumulation)');
}

main().catch((error) => {
  console.error(`FAIL: ${error.stack || error.message}`);
  process.exitCode = 1;
});
