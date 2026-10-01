'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const flowPath = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const flows = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
const byId = Object.fromEntries(flows.map((node) => [node.id, node]));
const expectedCaps = ['watermark_v1', 'chameleon_config_commands_v1', 'device_soil_depth_commands_v1'];

for (const id of ['sync-bootstrap-build', 'sync-force-build']) {
  const node = byId[id];
  assert.ok(node, `${id} exists`);
  assert.match(node.func, /watermark_calibrations/);
  assert.match(node.func, /deleted_at/);
  assert.match(node.func, /effective_op/);
  assert.ok(node.func.indexOf('devices') < node.func.indexOf('watermark_calibrations'), `${id} emits calibration after devices`);
  assert.doesNotMatch(node.func, /watermark_readings/, `${id} does not ship raw watermark readings`);
  for (const cap of expectedCaps) assert.match(node.func, new RegExp(cap), `${id} advertises ${cap}`);
}

const link = byId['al-link-build-req'];
assert.ok(link, 'link builder exists');
for (const cap of expectedCaps) assert.match(link.func, new RegExp(cap), `link advertises ${cap}`);
const capabilityLists = [
  ...flows.filter((node) => /sync-bootstrap-build|sync-force-build|Build server auth request/.test(node.id + ' ' + node.name))
    .map((node) => [...node.func.matchAll(/['"]([a-z][a-z0-9_]+_v1)['"]/g)].map((m) => m[1]).filter((v) => expectedCaps.includes(v)))
];
assert.ok(capabilityLists.length >= 3, 'all three builders expose capability tokens');
for (const list of capabilityLists) assert.deepEqual(list, expectedCaps, 'capability order is stable');

console.log('WATERMARK calibration bootstrap checks passed');
