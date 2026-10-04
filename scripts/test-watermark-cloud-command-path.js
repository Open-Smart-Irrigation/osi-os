'use strict';

// Task 9 RED contract: the protected command path must be visible in the
// shipped flow, not merely in the helper unit tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const flowPath = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const flows = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
const byId = Object.fromEntries(flows.map((node) => [node.id, node]));

const protectedTypes = [
  'SET_WATERMARK_CALIBRATION',
  'DELETE_WATERMARK_CALIBRATION',
  'SET_CHAMELEON_CONFIG',
  'UPSERT_DEVICE_SOIL_DEPTHS'
];
const registry = byId['cmd-type-registry'];
const route = byId['934bf2bc19a8ce22'];
const helper = flows.find((node) => node.name === 'Apply WATERMARK Protected Command');
const replayGate = byId['reject-indefinite-open'];
assert.ok(registry, 'command registry is shipped');
assert.ok(route, 'Route Command is shipped');
assert.ok(replayGate, 'pending-command replay gate is shipped');
for (const type of protectedTypes) {
  assert.match(registry.func, new RegExp(type + '\\s*:'), `${type} is registered`);
  assert.match(registry.func, new RegExp(type + ".*dispatch: 'watermark_config_apply'"), `${type} has the protected dispatch`);
  assert.match(replayGate.func, new RegExp(type + ".*dispatch: 'watermark_config_apply'"), `${type} is fail-closed in the replay fallback registry`);
  assert.doesNotMatch(route.func, new RegExp("commandType === ['\\\"]" + type + "['\\\"]"), `${type} does not have a raw Route Command branch`);
}
assert.ok(helper, 'thin watermark-config-command-apply-fn exists');
assert.equal(helper.type, 'function');
assert.deepEqual(helper.wires, [['934bf2bc19a8ce22'], ['9d5e3035c3d069c4']]);
assert.match(helper.func, /applyWatermarkCommand/);
assert.match(helper.func, /_pendingCommandEnvelope/);
assert.match(helper.func, /gateway_device_eui/);
assert.match(helper.func, /command_type_recognized/);
assert.match(helper.func, /return \[msg, null\]/);
assert.match(helper.func, /return \[null, \{/);

const buildSql = byId['4f4a765f36cee6f3'];
assert.ok(buildSql, 'legacy SQL builder is shipped');
assert.doesNotMatch(buildSql.func, /if \(commandType === 'UPSERT_DEVICE_SOIL_DEPTHS'\)/, 'depths do not fall through raw SQL');
assert.doesNotMatch(buildSql.func, /if \(commandType === 'SET_WATERMARK_CALIBRATION'\)/, 'watermark SET does not fall through raw SQL');
assert.doesNotMatch(buildSql.func, /if \(commandType === 'DELETE_WATERMARK_CALIBRATION'\)/, 'watermark DELETE does not fall through raw SQL');

const deferred = flows.find((node) => node.name === 'Replay Pending Commands');
assert.ok(deferred, 'pending command replay is shipped');
for (const type of ['SET_WATERMARK_CALIBRATION', 'DELETE_WATERMARK_CALIBRATION']) {
  assert.doesNotMatch(deferred.func, new RegExp("['\\\"]" + type + "['\\\"]"), `${type} is not edge-deferred`);
}

console.log('WATERMARK cloud-command path checks passed');
