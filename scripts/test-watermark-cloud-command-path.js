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
const capabilityBase = [
  'linked_auth_sync_v1',
  'force_edge_sync_v1',
  'installation_recovery_v1',
  'installation_locations_v1',
  'entity_name_commands_v1',
  'zone_config_weather_source_v1',
  'zone_config_stage_started_on_v1',
  'watermark_v1',
  'chameleon_config_commands_v1',
  'device_soil_depth_commands_v1',
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
assert.match(helper.func, /applyLegacySoilDepthsCommand/, 'legacy soil-depth compatibility path is shipped');
assert.match(helper.func, /isExactLegacySoilDepthsPayload/, 'legacy classifier is consulted before protected apply');
assert.doesNotMatch(helper.func, /\bcapabilities\s*:/, 'protected applier does not inject runtime capability metadata');

function capabilityBaseFrom(source, builderId) {
  const match = String(source).match(/const syncCapabilities = \[([^\]]*)\];/);
  assert.ok(match, `${builderId} has an unconditional capability base`);
  const values = [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
  assert.deepEqual(values, capabilityBase, `${builderId} advertises the canonical capability base`);
  assert.equal(new Set(values).size, values.length, `${builderId} capability base has no duplicates`);
  return values;
}

for (const profile of ['bcm2712', 'bcm2709']) {
  const profileFlowPath = path.join(ROOT, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`);
  const profileFlows = JSON.parse(fs.readFileSync(profileFlowPath, 'utf8'));
  const profileById = Object.fromEntries(profileFlows.map((node) => [node.id, node]));
  const profileApplier = profileById['watermark-config-command-apply-fn'];
  assert.ok(profileApplier, `${profile} protected applier is shipped`);
  assert.doesNotMatch(profileApplier.func, /\bcapabilities\s*:/, `${profile} protected applier supplies no runtime capability metadata`);
  const bases = ['sync-bootstrap-build', 'al-link-build-req', 'sync-force-build'].map((id) => capabilityBaseFrom(profileById[id].func, `${profile}/${id}`));
  assert.deepEqual(bases[0], bases[1], `${profile} bootstrap/link capability bases match`);
  assert.deepEqual(bases[0], bases[2], `${profile} bootstrap/force capability bases match`);
  assert.match(profileById['sync-bootstrap-build'].func, /if \(journalAdvertisement\) syncCapabilities\.push\('field_journal_v1'\);/, `${profile} bootstrap keeps journal conditional capability`);
  assert.match(profileById['sync-force-build'].func, /if \(journalAdvertisement\) syncCapabilities\.push\('field_journal_v1'\);/, `${profile} force keeps journal conditional capability`);
  assert.doesNotMatch(profileById['al-link-build-req'].func, /field_journal_v1/, `${profile} link keeps journal capability distinction`);
}

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
