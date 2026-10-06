#!/usr/bin/env node
'use strict';

// Verifies the shipped TEKTELIC KIWI / CLOVER agriculture codec
// (codecs/tektelic_agriculture_decoder.js), which chirpstack-bootstrap.js puts
// on the "OSI CLOVER Sensor" device profile:
//   1. the body below the provenance header is the upstream file, unmodified
//      (digest of brocaar/lorawan-devices@277e69a7
//      vendor/tektelic/decoder_agriculture_sensor.js);
//   2. it decodes the upstream example frame (t00059xx-codec.yaml) to the
//      upstream expected output;
//   3. it decodes the fields Process Data reads (light_intensity,
//      ambient_temperature, relative_humidity; input5/input6_frequency for a
//      KIWI watermark frame) from synthetic frames;
//   4. empty, truncated and foreign frames never throw;
//   5. both hardware profiles ship the same bytes.
//
// Run: node scripts/verify-tektelic-agriculture-codec.js

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const REL = 'files/usr/share/node-red/codecs/tektelic_agriculture_decoder.js';
const CANONICAL = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712', REL);
const MIRROR = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709', REL);
const UPSTREAM_SHA256 = '2bc5da7358aa885d7b2494017d931c30400c1f3d1531dac73c9474499faeb6c0';

function upstreamBody(source) {
  const marker = source.indexOf('function decodeUplink(input)');
  assert.ok(marker > 0, 'provenance header followed by the upstream decodeUplink');
  const header = source.slice(0, marker);
  assert.ok(header.split('\n').filter(Boolean).every((line) => line.startsWith('//')), 'header holds comments only');
  return source.slice(marker);
}

function loadDecoder(source) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: CANONICAL });
  assert.equal(typeof sandbox.decodeUplink, 'function', 'decodeUplink is defined');
  // Results cross the vm realm boundary; compare them as plain JSON values.
  return (input) => JSON.parse(JSON.stringify(sandbox.decodeUplink(input)));
}

function main() {
  const source = fs.readFileSync(CANONICAL, 'utf8');
  const digest = crypto.createHash('sha256').update(upstreamBody(source), 'utf8').digest('hex');
  assert.equal(digest, UPSTREAM_SHA256, 'codec body differs from the pinned upstream file');
  console.log('OK upstream body digest', digest);

  assert.equal(fs.readFileSync(MIRROR, 'utf8'), source, 'bcm2709 copy differs from bcm2712');
  console.log('OK bcm2709 copy is byte-identical');

  const decodeUplink = loadDecoder(source);

  // Upstream example (vendor/tektelic/t00059xx-codec.yaml, "All metrics").
  const example = decodeUplink({
    fPort: 10,
    bytes: [0x01, 0x04, 0x05, 0x6E, 0x02, 0x02, 0x03, 0x5C, 0x09, 0x65, 0x0D, 0x57, 0x0B, 0x67, 0x00, 0xAD, 0x0B, 0x68, 0xA5],
  });
  assert.deepEqual(example, {
    data: {
      raw: '[01, 04, 05, 6E, 02, 02, 03, 5C, 09, 65, 0D, 57, 0B, 67, 00, AD, 0B, 68, A5]',
      port: '10',
      input1_frequency: 1390,
      input2_voltage: 860,
      light_intensity: 3415,
      ambient_temperature: 17.3,
      relative_humidity: 82.5,
    },
    warnings: [],
    errors: [],
  });
  console.log('OK upstream example frame decodes to the upstream expected output');

  // Synthetic KIWI frame: watermark 1/2 frequency, light, negative ambient
  // temperature, RH, battery.
  const kiwi = decodeUplink({
    fPort: 10,
    bytes: [0x05, 0x04, 0x07, 0xD0, 0x06, 0x04, 0x09, 0xC4, 0x09, 0x65, 0x00, 0x7B, 0x0B, 0x67, 0xFF, 0xF6, 0x0B, 0x68, 0x6E, 0x00, 0xBA, 0x5A],
  }).data;
  assert.equal(kiwi.input5_frequency, 2000);
  assert.equal(kiwi.input6_frequency, 2500);
  assert.equal(kiwi.light_intensity, 123);
  assert.equal(kiwi.ambient_temperature, -1);
  assert.equal(kiwi.relative_humidity, 55);
  assert.deepEqual(kiwi['Battery Status'], { level: 3.4, eos_alert: 0 });
  console.log('OK KIWI watermark frame decodes input5/input6 frequency, light, temperature, humidity');

  for (const [name, input] of Object.entries({
    empty: { fPort: 10, bytes: [] },
    truncated: { fPort: 10, bytes: [0x0B, 0x67] },
    unknownHeader: { fPort: 10, bytes: [0x7F, 0x7F, 0x01] },
    configPort: { fPort: 100, bytes: [0x00, 0x01] },
    foreignPort: { fPort: 99, bytes: [0x01, 0x02] },
  })) {
    let decoded;
    assert.doesNotThrow(() => { decoded = decodeUplink(input); }, `${name} frame must not throw`);
    assert.ok(decoded && decoded.data && typeof decoded.data === 'object', `${name} frame returns a data object`);
  }
  console.log('OK empty, truncated and foreign frames do not throw');
  console.log('verify-tektelic-agriculture-codec: OK');
}

main();
