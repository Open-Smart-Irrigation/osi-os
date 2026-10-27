'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const routeCases = [
  ['conditional-policy-get-http', 'get', '/api/irrigation-zones/:id/irrigation-policy'],
  ['conditional-policy-put-http', 'put', '/api/irrigation-zones/:id/irrigation-policy'],
  ['conditional-policy-pause-http', 'post', '/api/irrigation-zones/:id/irrigation-policy/pause'],
  ['conditional-policy-retry-http', 'post', '/api/irrigation-zones/:id/irrigation-policy/retry-valve'],
  ['conditional-policy-decisions-http', 'get', '/api/irrigation-zones/:id/irrigation-policy/decisions'],
];

for (const profile of ['bcm2712', 'bcm2709']) {
  const flowPath = path.join(root, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`);
  const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
  const route = flow.find((node) => node.id === 'conditional-policy-route-fn');
  assert.ok(route, `${profile}: policy route function is installed`);
  assert.equal(route.type, 'function', `${profile}: policy route is a Function node`);
  assert.deepEqual(route.libs, [
    { var: 'osiDb', module: 'osi-db-helper' },
    { var: 'osiLib', module: 'osi-lib' },
    { var: 'chirpstack', module: 'osi-chirpstack-helper' },
  ], `${profile}: policy route binds loader libraries explicitly`);
  assert.match(route.func, /osiLib\.require\('osi-irrigation-policy'\)/);
  assert.match(route.func, /osiLib\.require\('osi-valve-control'\)/);
  assert.match(route.func, /createProvisioningClientFromEnv/);
  assert.match(route.func, /cancelActuation/);
  assert.match(route.func, /flushDeviceQueue/);
  assert.match(route.func, /handleHttpRequest/);
  assert.match(route.func, /db\.close/);
  const dueTick = flow.find((node) => node.id === 'conditional-due-tick');
  assert.ok(dueTick, `${profile}: conditional due tick is installed`);
  assert.equal(dueTick.type, 'inject', `${profile}: conditional due tick is an inject`);
  assert.equal(dueTick.repeat, '60', `${profile}: conditional due tick cadence`);
  assert.deepEqual(dueTick.wires, [['conditional-due-fn']], `${profile}: conditional due tick wiring`);
  const dueFn = flow.find((node) => node.id === 'conditional-due-fn');
  assert.ok(dueFn, `${profile}: conditional due function is installed`);
  assert.deepEqual(dueFn.libs, [{ var: 'osiLib', module: 'osi-lib' }], `${profile}: due wrapper uses the loader binding`);
  assert.match(dueFn.func, /osiLib\.require\('osi-irrigation-policy'\)/);
  assert.match(dueFn.func, /osiLib\.require\('osi-db-helper'\)/);
  assert.match(dueFn.func, /osiLib\.require\('chirpstack'\)/);
  assert.match(dueFn.func, /runDue/);
  assert.doesNotMatch(dueFn.func, /runDue\(\{[^}]*\bnow\s*:/s, `${profile}: due tick must use the worker's runtime clock`);
  assert.match(dueFn.func, /db\.close/);
  assert.match(dueFn.func, /createProvisioningClientFromEnv/);
  const legacyQuery = flow.find((node) => node.id === 'a0a61f4b7dca1c2e');
  assert.ok(legacyQuery, `${profile}: legacy schedule query is installed`);
  assert.match(legacyQuery.func, /NOT EXISTS[\s\S]*irrigation_policies[\s\S]*p\.deleted_at IS NULL/);
  assert.doesNotMatch(legacyQuery.func, /p\.enabled\s*=\s*1/);
  const lifecycleCommand = flow.find((node) => node.id === 'conditional-lifecycle-command-adapter');
  assert.ok(lifecycleCommand, `${profile}: cloud lifecycle adapter is installed`);
  assert.deepEqual(lifecycleCommand.wires, [['4f4a765f36cee6f3'], ['command-ack-queue-rest']], `${profile}: lifecycle adapter owns raw fallback and durable ACK outputs`);
  assert.match(lifecycleCommand.func, /routes\.conditionalLifecycleCommand/);
  assert.deepEqual(flow.find((node) => node.id === '934bf2bc19a8ce22').wires[1], ['conditional-lifecycle-command-adapter'], `${profile}: pending command mutations enter lifecycle adapter before raw SQL`);
  for (const id of ['delete-zone-unassign', 'assign-device-update', 'unassign-device-update', 'delete-device-unlink']) {
    const node = flow.find((candidate) => candidate.id === id);
    assert.ok(node, `${profile}: ${id} is installed`);
    assert.match(node.func, /osiLib\.require\('osi-irrigation-policy'\)/, `${profile}: ${id} delegates to lifecycle service`);
    assert.match(node.func, /routes\.(zoneDelete|deviceAssign|deviceUnassign|deviceUnclaim)/, `${profile}: ${id} invokes lifecycle route adapter`);
  }
  for (const [id, method, url] of routeCases) {
    const node = flow.find((candidate) => candidate.id === id);
    assert.ok(node, `${profile}: ${id} is installed`);
    assert.equal(node.type, 'http in', `${profile}: ${id} is an HTTP input`);
    assert.equal(node.method, method, `${profile}: ${id} method`);
    assert.equal(node.url, url, `${profile}: ${id} URL`);
    assert.deepEqual(node.wires, [['conditional-policy-route-fn']], `${profile}: ${id} wrapper wiring`);
  }
}

console.log('OK (conditional irrigation flow wrappers, both profiles)');
