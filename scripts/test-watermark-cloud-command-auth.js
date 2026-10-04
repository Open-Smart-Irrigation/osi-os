#!/usr/bin/env node
'use strict';
// Kept as a separate executable gate so CI exercises the authorization matrix
// without relying on process environment or a GUI flow.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const commands = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/commands');
assert.ok(commands);
assert.equal(typeof commands.isExactLegacySoilDepthsPayload, 'function');
const legacyBase = {
  deviceEui: 'A84041A171000001',
  gatewayDeviceEui: '0016C001F1000001',
  soilMoistureProbeDepthsJson: { swt_1: 20 },
  soilMoistureProbeDepthsConfigured: true,
  syncVersion: 1,
};
assert.equal(commands.isExactLegacySoilDepthsPayload({
  commandId: 41,
  commandType: 'UPSERT_DEVICE_SOIL_DEPTHS',
  payload: legacyBase,
}, { gateway_device_eui: legacyBase.gatewayDeviceEui }), true);
assert.equal(commands.isExactLegacySoilDepthsPayload({
  commandId: 47,
  commandType: 'UPSERT_DEVICE_SOIL_DEPTHS',
  effectKey: 'device_soil_depths:set:0016C001F1000001:A84041A171000001:0',
  payload: legacyBase,
}, { gateway_device_eui: legacyBase.gatewayDeviceEui }), false);
assert.equal(commands.isExactLegacySoilDepthsPayload({
  commandId: 48,
  commandType: 'UPSERT_DEVICE_SOIL_DEPTHS',
  protected_context: null,
  payload: legacyBase,
}, { gateway_device_eui: legacyBase.gatewayDeviceEui }), false);
assert.equal(commands.isExactLegacySoilDepthsPayload({
  commandId: 46,
  commandType: 'UPSERT_DEVICE_SOIL_DEPTHS',
  appliedSyncVersion: 7,
  payload: { ...legacyBase, syncVersion: 6 },
}, { gateway_device_eui: legacyBase.gatewayDeviceEui }), true);
assert.equal(commands.isExactLegacySoilDepthsPayload({
  commandId: 42,
  commandType: 'UPSERT_DEVICE_SOIL_DEPTHS',
  payload: { ...legacyBase, soilMoistureProbeDepthsJson: {}, soilMoistureProbeDepthsConfigured: false },
}, { gateway_device_eui: legacyBase.gatewayDeviceEui }), true);
assert.equal(commands.isExactLegacySoilDepthsPayload({
  commandId: 43,
  commandType: 'UPSERT_DEVICE_SOIL_DEPTHS',
  payload: { ...legacyBase, values: {} },
}, { gateway_device_eui: legacyBase.gatewayDeviceEui }), false);
assert.equal(commands.isExactLegacySoilDepthsPayload({
  commandId: 44,
  commandType: 'UPSERT_DEVICE_SOIL_DEPTHS',
  payload: { ...legacyBase, gatewayDeviceEui: '0016C001F1000002' },
}, { gateway_device_eui: legacyBase.gatewayDeviceEui }), false);
assert.equal(commands.isExactLegacySoilDepthsPayload({
  commandId: 45,
  commandType: 'UPSERT_DEVICE_SOIL_DEPTHS',
  payload: { ...legacyBase, commandType: 'UPSERT_DEVICE_SOIL_DEPTHS' },
}, { gateway_device_eui: legacyBase.gatewayDeviceEui }), true);
assert.equal(commands.isExactLegacySoilDepthsPayload({
  commandId: 49,
  commandType: 'UPSERT_DEVICE_SOIL_DEPTHS',
  payload: { ...legacyBase, commandType: 'SET_CHAMELEON_CONFIG' },
}, { gateway_device_eui: legacyBase.gatewayDeviceEui }), false);
assert.deepEqual(commands.COMMAND_TYPES, [
  'SET_WATERMARK_CALIBRATION',
  'DELETE_WATERMARK_CALIBRATION',
  'SET_CHAMELEON_CONFIG',
  'UPSERT_DEVICE_SOIL_DEPTHS',
]);
const suite = spawnSync(process.execPath, ['--test', path.join(
  __dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/commands.test.js'
)], { encoding: 'utf8' });
assert.equal(suite.status, 0, suite.stderr || suite.stdout);
console.log('OK: WATERMARK cloud command authorization cases are executable');
