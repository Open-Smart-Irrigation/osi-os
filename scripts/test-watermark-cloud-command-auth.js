#!/usr/bin/env node
'use strict';
// Kept as a separate executable gate so CI exercises the authorization matrix
// without relying on process environment or a GUI flow.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const commands = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/commands');
assert.ok(commands);
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
