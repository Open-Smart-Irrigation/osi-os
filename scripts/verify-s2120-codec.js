#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const codecPath = path.join(
  __dirname,
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/sensecap_s2120_decoder.js'
);

function loadCodec() {
  const source = fs.readFileSync(codecPath, 'utf8');
  const sandbox = {
    Buffer,
    console: {
      log() {},
      warn() {},
      error() {},
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: codecPath });
  assert.strictEqual(typeof sandbox.decodeUplink, 'function', 'decodeUplink is exported');
  return sandbox.decodeUplink;
}

function flattenMessages(decoded) {
  assert.ok(decoded, 'decodeUplink returns a result');
  assert.ok(decoded.data, 'decodeUplink returns decoded data');
  assert.ok(Array.isArray(decoded.data.messages), 'S2120 data.messages is an array');
  return decoded.data.messages.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));
}

function assertContainsMeasurement(messages, expected) {
  const match = messages.find((message) => (
    String(message.measurementId) === String(expected.measurementId) &&
    message.type === expected.type &&
    Object.is(message.measurementValue, expected.value)
  ));
  assert.ok(
    match,
    `expected S2120 measurement ${expected.measurementId} ${expected.type}=${expected.value}`
  );
}

function assertBattery(messages, expectedPercent) {
  const match = messages.find((message) => Object.is(message['Battery(%)'], expectedPercent));
  assert.ok(match, `expected S2120 Battery(%)=${expectedPercent}`);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(match, 'measurementId'),
    false,
    'S2120 battery entries do not carry a measurementId'
  );
}

function main() {
  const decodeUplink = loadCodec();
  const sample = [
    0x01, 0x00, 0xb6, 0x42, 0x00, 0x00, 0x04, 0xd2, 0x1b, 0x00, 0x20,
    0x02, 0x00, 0xb6, 0x00, 0x00, 0x30, 0x70, 0x27, 0x67,
    0x03, 0x54,
    0x4c, 0x00, 0x4c, 0x00, 0x00, 0x30, 0x70,
  ];
  const messages = flattenMessages(decodeUplink({ fPort: 5, bytes: sample }));

  [
    { measurementId: 4097, type: 'Air Temperature', value: 18.2 },
    { measurementId: 4098, type: 'Air Humidity', value: 66 },
    { measurementId: 4099, type: 'Light Intensity', value: 1234 },
    { measurementId: 4101, type: 'Barometric Pressure', value: 100870 },
    { measurementId: 4104, type: 'Wind Direction Sensor', value: 182 },
    { measurementId: 4105, type: 'Wind Speed', value: 3.2 },
    { measurementId: 4113, type: 'Rain Gauge', value: 12.4 },
    { measurementId: 4190, type: 'UV Index', value: 2.7 },
    { measurementId: 4213, type: 'Rain Accumulation', value: 12.4 },
  ].forEach((expected) => assertContainsMeasurement(messages, expected));

  // The platform treats S2120 battery as its 4103/bat_pct input, but the vendor
  // decoder emits only Battery(%) without a measurementId.
  assertBattery(messages, 84);

  const errorMessages = flattenMessages(decodeUplink({ fPort: 5, bytes: [0x06, 0x0c] }));
  assertContainsMeasurement(errorMessages, {
    measurementId: 4101,
    type: 'sensor_error_event',
    value: undefined,
  });
  const errorEvent = errorMessages.find((message) => (
    String(message.measurementId) === '4101' && message.type === 'sensor_error_event'
  ));
  assert.strictEqual(errorEvent.errCode, '0C', 'S2120 sensor error event preserves the error code');
  assert.strictEqual(
    errorEvent.descZh,
    'CCL_SENSOR_DATA_VALUE_HI',
    'S2120 sensor error event preserves the vendor description'
  );

  console.log('S2120 codec verification passed');
}

main();
