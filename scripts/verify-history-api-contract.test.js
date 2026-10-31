'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  verifyAnalysisRouterImplementation,
  verifyHistoryRouterImplementation,
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

test('gateway history contract requires the fresh token-bound admin call', () => {
  const flows = loadFlows();
  const moduleSource = fs.readFileSync(path.resolve(__dirname, '..',
    'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-router/index.js'),
    'utf8');
  const freshCall = "await scope.assertAuthenticatedRole(db, principal, 'admin', { scopedMode: true });";
  const oldCall = "await scope.assertRole(db, user.user_uuid, 'admin', { scopedMode: true });";
  const router = flows.find((node) => node.id === 'history-api-router-fn');
  assert.ok(router);
  assert.equal(router.func.split(freshCall).length - 1, 1);
  const failures = [];
  verifyHistoryRouterImplementation(flows, failures, moduleSource);
  assert.ok(!failures.some((failure) =>
    failure.includes('gateway history uses fresh token-bound admin role (P2)')),
  failures.join('\n'));

  router.func = router.func.replace(freshCall, oldCall);
  const revertedFailures = [];
  verifyHistoryRouterImplementation(flows, revertedFailures, moduleSource);
  assert.ok(revertedFailures.some((failure) =>
    failure.includes('gateway history uses fresh token-bound admin role (P2)')),
  revertedFailures.join('\n'));
});
