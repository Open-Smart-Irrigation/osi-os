'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  verifyAnalysisRouterImplementation,
  verifyZoneCsvResponseContract,
} = require('./verify-history-api-contract');

const FLOW_PATH = path.resolve(
  __dirname,
  '..',
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);

function loadFlows() {
  return JSON.parse(fs.readFileSync(FLOW_PATH, 'utf8'));
}

test('analysis contract accepts the maintained scoped router', () => {
  const failures = [];
  verifyAnalysisRouterImplementation(loadFlows(), failures);
  assert.deepEqual(failures, []);
});

test('analysis contract rejects removal of zone-scope propagation', () => {
  const flows = loadFlows();
  const router = flows.find((node) => node.id === 'analysis-api-router-fn');
  assert.ok(router);
  router.func = router.func.replace(
    'zoneUuids: scopeZoneUuids, unassignedAccess: unassignedAccess',
    'zoneUuids: null'
  );

  const failures = [];
  verifyAnalysisRouterImplementation(flows, failures);
  assert.ok(
    failures.some((failure) => failure.includes('analysis /channels')),
    failures.join('\n')
  );
});


test('per-zone CSV response contract accepts the candidate graph', () => {
  const failures = [];
  verifyZoneCsvResponseContract(loadFlows(), failures);
  assert.deepEqual(failures, []);
});

test('per-zone CSV response contract rejects a fixed JSON type in memory', () => {
  const flows = loadFlows();
  flows.find((node) => node.id === 'history-api-response').headers['Content-Type'] = 'application/json';
  const failures = [];
  verifyZoneCsvResponseContract(flows, failures);
  assert.ok(failures.includes('per-zone CSV response: fixed Content-Type overrides CSV message'), failures.join('\n'));
});

test('per-zone CSV response contract rejects a broken route wire in memory', () => {
  const flows = loadFlows();
  flows.find((node) => node.id === 'history-zone-export-csv-http').wires = [[]];
  const failures = [];
  verifyZoneCsvResponseContract(flows, failures);
  assert.ok(failures.includes('per-zone CSV response: route/router/response wiring changed'), failures.join('\n'));
});

test('per-zone CSV response contract rejects a broken router wire in memory', () => {
  const flows = loadFlows();
  flows.find((node) => node.id === 'history-api-router-fn').wires = [[]];
  const failures = [];
  verifyZoneCsvResponseContract(flows, failures);
  assert.ok(failures.includes('per-zone CSV response: route/router/response wiring changed'), failures.join('\n'));
});
