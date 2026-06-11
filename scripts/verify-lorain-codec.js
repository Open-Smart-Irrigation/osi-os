#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const codecPath = path.join(
  __dirname,
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/aquascope_lorain_decoder.js'
);

function loadCodec() {
  const source = fs.readFileSync(codecPath, 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: codecPath });
  assert.strictEqual(typeof sandbox.decodeUplink, 'function', 'decodeUplink is exported');
  return sandbox.decodeUplink;
}

function assertSampleDecode(decoded) {
  assert.ok(decoded, 'decodeUplink returns a result');
  assert.ok(decoded.data, 'decodeUplink returns decoded data');
  assert.strictEqual((decoded.errors || []).length, 0, 'sample decodes without errors');
  assert.strictEqual(decoded.data.rain_tips_delta, 3, 'rain tip count is decoded');
  assert.strictEqual(decoded.data.rainlevel, 3, 'vendor-compatible rainlevel remains raw 0.5 mm steps');
  assert.strictEqual(decoded.data.rain_mm_delta, 1.5, 'rain delta is normalized to millimeters');
  assert.strictEqual(decoded.data.ambient_temperature, 20.5, 'ambient temperature is normalized');
  assert.strictEqual(decoded.data.temperature_C, 20.5, 'temperature_C alias is normalized');
  assert.strictEqual(decoded.data.uptime_days, 12, 'uptime is decoded in days');
  assert.strictEqual(decoded.data.bat_v, 3.3, 'battery voltage is normalized');
  assert.strictEqual(decoded.data.bat_mAh, 10, 'battery capacity estimate is decoded');
}

function main() {
  const decodeUplink = loadCodec();
  const sample = [
    0x03, 0x01, 0x00, 0x03,
    0x04, 0x04, 0x03, 0x84,
    0x06, 0x03, 0x00, 0x0c,
    0x06, 0x81, 0x00, 0x03,
    0x06, 0x01, 0x00, 0xcd,
    0x0a, 0x00, 0x00, 0x00, 0x2a,
    0x0b, 0x01, 0x03, 0x00, 0x0f,
    0x12, 0x21, 0x00, 0x0a,
  ];

  assertSampleDecode(decodeUplink({ fPort: 10, bytes: sample }));
  assertSampleDecode(decodeUplink({ fPort: 2, bytes: sample }));

  const decoded = decodeUplink({ fPort: 10, bytes: sample });
  assert.strictEqual(decoded.data.hw_version, 1, 'hardware version command is decoded');
  assert.strictEqual(decoded.data.capabilities, 3, 'capabilities bitmap is decoded');
  assert.strictEqual(decoded.data.conf_interval, 900, 'configuration command is decoded');
  assert.strictEqual(decoded.data.fw_version, 42, 'firmware version command is decoded');
  assert.strictEqual(decoded.data.alarm_status, 1, 'alarm status is decoded');
  assert.strictEqual(decoded.data.alarm_type, 3, 'alarm type is decoded');
  assert.strictEqual(decoded.data.alarm_value, 15, 'alarm value is decoded');

  const configSample = decodeUplink({
    fPort: 10,
    bytes: [
      0x04, 0x02, 0x00, 0x18,
      0x04, 0x03, 0x00, 0x78,
      0x04, 0x04, 0x03, 0x84,
      0x04, 0x05, 0x00, 0x64,
    ],
  });
  assert.strictEqual(configSample.data.conf_heartbeat, 24, 'heartbeat config command is decoded');
  assert.strictEqual(configSample.data.conf_heavyrain, 120, 'heavy rain config command is decoded');
  assert.strictEqual(configSample.data.conf_interval, 900, 'measurement interval config command is decoded');
  assert.strictEqual(
    configSample.data.conf_temperature_calibration,
    100,
    'temperature calibration config command is decoded'
  );

  const negativeTemp = decodeUplink({ fPort: 10, bytes: [0x06, 0x01, 0xff, 0xea] });
  assert.strictEqual(negativeTemp.data.ambient_temperature, -2.2, 'signed temperature is decoded as int16 tenths');

  const wrongPort = decodeUplink({ fPort: 5, bytes: sample });
  assert.ok(Array.isArray(wrongPort.errors), 'wrong FPort returns errors');
  assert.ok(wrongPort.errors.length > 0, 'wrong FPort is rejected');

  console.log('LoRain codec verification passed');
}

main();
