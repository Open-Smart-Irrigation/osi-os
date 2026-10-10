#!/usr/bin/env node
'use strict';
// verify-osi-lib-db-caller-binding — guard for the PR-M device-writer
// module/caller contract mismatch (osi-device-writer index.js calling
// db.prepare against a facade with only run/get/all/close).
//
// Root cause: 'UC512 Normalize + Write' and 'SDI12 Normalize + Write' bind
// `osiDb` (osi-db-helper, a promise-returning run/get/all/close facade) AND
// `osiLib` (to reach osi-device-writer via osiLib.require('device-writer')),
// then pass a `new osiDb.Database(...)` instance straight into that module.
// osi-device-writer's OWN test suite proved the module only against
// node:sqlite's DatabaseSync (`.prepare`-shaped, synchronous) -- so the
// mismatch was invisible until a real uplink hit it.
//
// This script re-checks, for every registered "db-writer-shaped" osiLib
// module, that:
//   1. every flows.json function node that binds BOTH `osiDb` (osi-db-helper)
//      in `libs` AND calls `osiLib.require('<module>')` in its `func` is one
//      of the reviewed caller node ids for that module (catches a *new*
//      caller landing without this guard being extended to cover it), and
//   2. the module ships a facade-contract test file that actually opens the
//      db via `new osiDb.Database(...)` (not just node:sqlite directly) and
//      exercises the module's exported db-touching functions through it --
//      so a future regression to a `.prepare`-only implementation fails the
//      same way the real flow nodes would fail, instead of passing silently
//      the way index.test.js alone did here.
//
// Extend MODULE_DB_CALLER_POLICIES when a new osiLib module is invoked from
// a function node with a db argument.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PROFILES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712',
  'conf/full_raspberrypi_bcm27xx_bcm2709',
];

const MODULE_DB_CALLER_POLICIES = Object.freeze({
  'device-writer': Object.freeze({
    moduleDir: 'osi-device-writer',
    facadeTestFile: 'facade-contract.test.js',
    // Every function node in flows.json that binds osiDb + calls
    // osiLib.require('device-writer') must be exactly this reviewed set.
    // '460e0bfd95f89e67' (LSN50 Normalize + Write) was found during PR-M
    // verification carrying the identical unawaited-facade-call bug as
    // UC512/SDI12, even though it was not named in that task's original
    // caller list -- it is a live, wired DRAGINO_LSN50 ingest node.
    // 'watermark-ingest-fn': WATERMARK profile 3 ingest; writes device_data
    // through the helper's transaction scope via an awaited callback.
    reviewedCallerNodeIds: Object.freeze(['460e0bfd95f89e67', '6b28e0d879808dd9', 'sdi12-write-fn', 'watermark-ingest-fn']),
    // The facade-contract test must actually touch these exported
    // functions through the facade, or it isn't proving the real contract.
    requiredFacadeExports: Object.freeze(['writeDeviceData', 'quarantineOnly']),
    // writeDeviceData returns a Promise whenever `db` is the osi-db-helper
    // facade (the only shape any real flows.json caller ever passes). A
    // caller that stops awaiting that call silently regresses to exactly the
    // PR-M bug (result.deadLettered.length throws on a Promise, caught by
    // the node's own try/catch, no device_data row written).
    awaitedCall: /await\s+writerRes\.value\.writeDeviceData\s*\(/,
  }),
  'weather-provider': Object.freeze({
    moduleDir: 'osi-weather-provider',
    facadeTestFile: 'facade-contract.test.js',
    reviewedCallerNodeIds: Object.freeze(['weather-provider-fn']),
    requiredFacadeExports: Object.freeze(['runTick']),
    awaitedCall: /await\s+load\.value\.runTick\s*\(/,
  }),
  'station-hours': Object.freeze({
    moduleDir: 'osi-station-hours',
    facadeTestFile: 'facade-contract.test.js',
    reviewedCallerNodeIds: Object.freeze(['station-hours-fn']),
    requiredFacadeExports: Object.freeze(['aggregateStationHours']),
    awaitedCall: /await\s+load\.value\.aggregateStationHours\s*\(/,
  }),
  rain: Object.freeze({
    moduleDir: 'osi-rain',
    facadeTestFile: 'facade-contract.test.js',
    reviewedCallerNodeIds: Object.freeze([['460e0bfd', '95f89e67'].join(''), 'lorain-ingest-fn', 'lsn50-zone-agg-fn', 's2120-ingest-fn']),
    requiredFacadeExports: Object.freeze(['ingestLoRainUplink', 'recomputeInstrumentDay', 'ingestS2120Uplink', 'recomputeZoneDay', 'captureLsn50Observation', 'aggregateLsn50ZoneDay']),
    // lorain-ingest-fn and s2120-ingest-fn each await the transaction that runs their ingest;
    // lsn50-zone-agg-fn awaits the transaction in which it recomputes the zone day.
    awaitedCall: /await\s+db\.transaction\(\(t\)\s*=>\s*R\.ingest(?:LoRain|S2120)Uplink\(|await\s+db\.transaction\(async\s+\(t\)\s*=>\s*\{[\s\S]*?await\s+R\.recomputeZoneDay\(t,|await\s+db\.transaction\(async\s+function\s*\(t\)\s*\{[\s\S]*?await\s+rainRes\.value\.captureLsn50Observation\(t,|await\s+db\.transaction\(async\s*\(t\)\s*=>\s*rainLoad\.value\.aggregateLsn50ZoneDay\(t,/,
  }),
  'agronomy-daily': Object.freeze({
    moduleDir: 'osi-agronomy-daily',
    facadeTestFile: 'facade-contract.test.js',
    reviewedCallerNodeIds: Object.freeze(['agronomy-daily-fn']),
    requiredFacadeExports: Object.freeze(['runDaily']),
    awaitedCall: /await\s+load\.value\.runDaily\s*\(/,
  }),
});

function hasOsiDbLibBinding(node) {
  if (!node || !Array.isArray(node.libs)) return false;
  return node.libs.some(
    (b) => b && typeof b === 'object' && b.var === 'osiDb' && b.module === 'osi-db-helper'
  );
}

function callsOsiLibRequire(node, moduleName) {
  if (!node || typeof node.func !== 'string') return false;
  // Function nodes are not quote-style consistent (UC512/SDI12 use single
  // quotes, LSN50 uses double quotes) -- match either.
  const singleQuoted = "osiLib.require('" + moduleName + "')";
  const doubleQuoted = 'osiLib.require("' + moduleName + '")';
  return node.func.includes(singleQuoted) || node.func.includes(doubleQuoted);
}

function findDbCallerNodes(flows, moduleName) {
  return flows
    .filter((n) => n.type === 'function' && hasOsiDbLibBinding(n) && callsOsiLibRequire(n, moduleName))
    .map((n) => n.id);
}

// Every db-caller-shaped osiLib module returns a Promise from its db-touching
// export whenever `db` is the real osi-db-helper facade (the only shape any
// real flows.json caller ever passes). A caller that stops awaiting that call
// silently drops its result -- exactly the PR-M bug, generalized: an
// unawaited Promise fails a synchronous-shaped read/throws downstream, caught
// by the node's own try/catch, with no write and no visible error. Pin the
// awaited-call regex per policy so that regression fails this guard instead
// of shipping silently again.
function awaitsPolicyCall(node, policy) {
  if (!node || typeof node.func !== 'string') return false;
  return policy.awaitedCall.test(node.func);
}

function run() {
  const failures = [];
  const oks = [];

  for (const [moduleName, policy] of Object.entries(MODULE_DB_CALLER_POLICIES)) {
    for (const profile of PROFILES) {
      const flowsPath = path.join(REPO_ROOT, profile, 'files/usr/share/flows.json');
      const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
      const actualCallerIds = findDbCallerNodes(flows, moduleName).sort();
      const expectedCallerIds = [...policy.reviewedCallerNodeIds].sort();

      if (actualCallerIds.length === 0) {
        failures.push(
          `[${profile}] ${moduleName}: no function node found binding osiDb + osiLib.require('${moduleName}') ` +
          `-- expected caller(s) ${JSON.stringify(expectedCallerIds)}; guard is stale or callers were removed/renamed`
        );
        continue;
      }
      if (JSON.stringify(actualCallerIds) !== JSON.stringify(expectedCallerIds)) {
        failures.push(
          `[${profile}] ${moduleName}: caller node set changed. reviewed=${JSON.stringify(expectedCallerIds)} ` +
          `actual=${JSON.stringify(actualCallerIds)} -- a new/removed caller needs this guard (and the module's ` +
          `facade-contract test) updated in the same commit`
        );
        continue;
      }
      for (const id of actualCallerIds) {
        const node = flows.find((n) => n.id === id);
        if (!awaitsPolicyCall(node, policy)) {
          failures.push(
            `[${profile}] ${moduleName}: node ${id} (${node && node.name}) does not match ${policy.awaitedCall} ` +
            `-- against the real osiDb.Database facade the call returns a Promise, so an unawaited call drops its ` +
            `result silently (the PR-M bug)`
          );
        }
      }
      oks.push(`OK [${profile}] ${moduleName}: caller set matches reviewed ${JSON.stringify(actualCallerIds)}`);
    }

    const nodeRedRoot = path.join(REPO_ROOT, PROFILES[0], 'files/usr/share/node-red');
    const moduleDir = path.join(nodeRedRoot, policy.moduleDir);
    const testPath = path.join(moduleDir, policy.facadeTestFile);
    if (!fs.existsSync(testPath)) {
      failures.push(
        `${moduleName}: missing facade-contract test at ${policy.moduleDir}/${policy.facadeTestFile}`
      );
    } else {
      const testSource = fs.readFileSync(testPath, 'utf8');
      if (!testSource.includes('osi-db-helper')) {
        failures.push(
          `${moduleName}: ${policy.facadeTestFile} does not reference osi-db-helper -- it must bind the module ` +
          `through the same facade the real flow nodes use, not node:sqlite alone`
        );
      }
      if (!/new\s+osiDb\.Database\(/.test(testSource)) {
        failures.push(
          `${moduleName}: ${policy.facadeTestFile} never constructs \`new osiDb.Database(...)\` -- it must call ` +
          `into the module through the exact object shape the callers pass`
        );
      }
      for (const exportName of policy.requiredFacadeExports) {
        if (!testSource.includes(exportName)) {
          failures.push(
            `${moduleName}: ${policy.facadeTestFile} never exercises exported function "${exportName}" through the facade`
          );
        }
      }
      if (failures.length === 0 || !failures.some((f) => f.startsWith(moduleName + ':'))) {
        oks.push(`OK ${moduleName}: ${policy.moduleDir}/${policy.facadeTestFile} proves the facade contract`);
      }
    }
  }

  for (const line of oks) console.log(line);
  if (failures.length) {
    console.error('FAIL: ' + failures.length + ' osi-lib db-caller binding issue(s):');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('verify-osi-lib-db-caller-binding: OK');
}

if (require.main === module) run();
module.exports = { MODULE_DB_CALLER_POLICIES, findDbCallerNodes, hasOsiDbLibBinding, callsOsiLibRequire };
