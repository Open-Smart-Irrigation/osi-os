#!/usr/bin/env node
'use strict';

// The cloud-facing WATERMARK MQTT message is a contact signal only.  This
// executable fixture deliberately exercises every edge outcome that can be
// attributed after the FPort/profile gate without allowing raw bytes,
// conversion details, or diagnostics onto the telemetry topic.
const assert = require('node:assert/strict');
const { executeFunction, loadNode } = require('./lib/flow-node-harness');
const helper = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper');

const node = loadNode('watermark-ingest-fn');
const DEVICE = 'A84041A171000001';
const GATEWAY = '0016C001F1000003';
const forbidden = new Set([
  'rawPayloadB64', 'payload_hex', 'fCnt', 'supply_mv', 'status_byte',
  'soil_temp_c', 'die_temp_c', 'channels', 'statuses', 'calibration_status',
  'reject_reason', 'conversion_version', 'calibration_sync_version'
]);

function fakeDb() {
  return { close(callback) { callback(null); } };
}

async function run(reason) {
  const result = await executeFunction(node, {
    msg: {
      formattedData: {
        isWatermark: true,
        devEui: DEVICE,
        timestamp: '2026-09-25T10:00:00Z',
        rawPayloadB64: 'AAECAwQF',
        fCnt: 7,
      },
    },
    env: { DEVICE_EUI: GATEWAY },
    globals: { fs: { readFileSync: () => '{}' } },
    osiLibModules: {
      'watermark-helper': {
        buildContactPayload: helper.buildContactPayload,
        ingestProfile3: async () => reason === 'accepted'
          ? { accepted: true, statuses: ['ok', 'ok'] }
          : { accepted: false, reason },
      },
      'device-writer': {
        clampRecordedAt: (value) => ({ recordedAt: value }),
        writeDeviceData: async () => ({ inserted: false }),
      },
    },
    libOverrides: { osiDb: { Database: fakeDb } },
  });
  assert.deepEqual(result.errors, [], reason + ': flow errors');
  assert.ok(result.result, reason + ': no contact message');
  assert.equal(result.result.topic, 'devices/' + GATEWAY + '/telemetry');
  assert.equal(result.result.qos, 1);
  const payload = JSON.parse(result.result.payload);
  assert.deepEqual(Object.keys(payload).sort(), [
    'deviceEui', 'deviceType', 'fPort', 'gatewayDeviceEui', 'timestamp'
  ].sort(), reason + ': contact payload shape');
  assert.deepEqual(payload, {
    deviceEui: DEVICE,
    gatewayDeviceEui: GATEWAY,
    deviceType: 'DRAGINO_LSN50',
    fPort: 11,
    timestamp: '2026-09-25T10:00:00Z',
  });
  for (const key of Object.keys(payload)) assert.equal(forbidden.has(key), false, reason + ': forbidden key ' + key);
}

(async () => {
  for (const reason of ['accepted', 'calibration_missing', 'channel_invalid', 'frame_rejected']) await run(reason);
  console.log('PASS: WATERMARK contact payload is minimal for accepted and rejected attribution outcomes');
})().catch((error) => {
  console.error('FAIL: ' + error.stack);
  process.exitCode = 1;
});
