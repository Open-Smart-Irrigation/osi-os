'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  verifyAnalysisRouterImplementation,
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
    'zoneUuids: scopeZoneUuids',
    'zoneUuids: null'
  );

  const failures = [];
  verifyAnalysisRouterImplementation(flows, failures);
  assert.ok(
    failures.some((failure) => failure.includes('owned-plus-granted zones')),
    failures.join('\n')
  );
});
