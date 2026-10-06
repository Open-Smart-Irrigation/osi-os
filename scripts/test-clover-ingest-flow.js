#!/usr/bin/env node
'use strict';

// TEKTELIC Clover uplink, end to end on the edge, with a synthetic device:
//   shipped Tektelic codec (what the "OSI CLOVER Sensor" profile runs in
//   ChirpStack) -> Process Data -> the Build SQL INSERT it is wired to
//   -> device_data on the seed schema
//   -> the DEVICE_DATA_APPENDED outbox event the cloud sync sends
//   -> GET /api/devices (format-devices + merge-device-data), as the GUI reads it.
// A second case pins the defect this replaces: the same frame without a
// decoded object (a Clover on the codec-less field-tester profile) is dropped.
//
// Run: node scripts/test-clover-ingest-flow.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { executeFunction, loadNode, seedTestDb } = require('./lib/flow-node-harness');

const ROOT = path.resolve(__dirname, '..');
const NR = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const CODEC = path.join(NR, 'codecs/tektelic_agriculture_decoder.js');
const dedupGuard = require(path.join(NR, 'osi-uplink-dedup-guard'));
const FLOWS = JSON.parse(fs.readFileSync(path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'), 'utf8'));

// Nodes are found by name and wiring, so the test follows the real chain.
function processDataNode() {
  const matches = FLOWS.filter((n) => n.type === 'function' && n.name === 'Process Data');
  assert.equal(matches.length, 1, 'exactly one Process Data node');
  return loadNode(matches[0].id);
}
function buildSqlInsertNode() {
  const targets = processDataNode().wires.flat().map((id) => FLOWS.find((n) => n.id === id));
  const matches = targets.filter((n) => n && n.type === 'function' && n.name === 'Build SQL INSERT');
  assert.equal(matches.length, 1, 'Process Data is wired to exactly one Build SQL INSERT');
  return loadNode(matches[0].id);
}

const DEVEUI = 'A840410000000001';
const GATEWAY_EUI = '0016C001F1000001';
const CLOVER_PROFILE = '0b6f3c1e-1d2a-4c5b-8e9f-000000000001';
const RAK_PROFILE = '0b6f3c1e-1d2a-4c5b-8e9f-000000000002';
const KIWI_PROFILE = '0b6f3c1e-1d2a-4c5b-8e9f-000000000003';
const SENSORS_APP = '0b6f3c1e-1d2a-4c5b-8e9f-0000000000a1';
const FIELD_TESTER_APP = '0b6f3c1e-1d2a-4c5b-8e9f-0000000000a2';
const ENV = Object.freeze({
  CHIRPSTACK_PROFILE_CLOVER: CLOVER_PROFILE,
  CHIRPSTACK_PROFILE_RAK10701: RAK_PROFILE,
  CHIRPSTACK_PROFILE_KIWI: KIWI_PROFILE,
  CHIRPSTACK_APP_SENSORS: SENSORS_APP,
  CHIRPSTACK_APP_FIELD_TESTER: FIELD_TESTER_APP,
  DEVICE_EUI: GATEWAY_EUI,
});
// The upstream example frame of the codec (t00059xx-codec.yaml): soil moisture
// and soil temperature inputs, light, ambient temperature, humidity.
const CLOVER_FRAME = [0x01, 0x04, 0x05, 0x6E, 0x02, 0x02, 0x03, 0x5C, 0x09, 0x65, 0x0D, 0x57, 0x0B, 0x67, 0x00, 0xAD, 0x0B, 0x68, 0xA5];

function decode(bytes, fPort) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CODEC, 'utf8'), sandbox, { filename: CODEC });
  return JSON.parse(JSON.stringify(sandbox.decodeUplink({ bytes, fPort })));
}

function chirpstackEvent({ object, time, fCnt }) {
  const event = {
    deduplicationId: `dedup-${fCnt}`,
    time,
    deviceInfo: {
      tenantId: '0b6f3c1e-1d2a-4c5b-8e9f-0000000000t1',
      applicationId: SENSORS_APP,
      deviceProfileId: CLOVER_PROFILE,
      deviceProfileName: 'OSI CLOVER Sensor',
      deviceName: 'Clover row 1',
      devEui: DEVEUI.toLowerCase(),
    },
    devAddr: '01020304',
    fCnt,
    fPort: 10,
    data: Buffer.from(CLOVER_FRAME).toString('base64'),
  };
  if (object !== undefined) event.object = object;
  return event;
}

function freshDb() {
  const db = seedTestDb();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, gateway_device_eui, created_at, updated_at) VALUES (?, 'Clover row 1', 'TEKTELIC_CLOVER', 1, 2, ?, ?, ?)"
  ).run(DEVEUI, GATEWAY_EUI, now, now);
  db.prepare(
    "INSERT INTO sync_link_state (peer_node, linked, server_url, gateway_device_eui, updated_at) VALUES ('cloud', 1, 'https://cloud.invalid', ?, ?)"
  ).run(GATEWAY_EUI, now);
  return db;
}

async function processData(event) {
  return executeFunction(processDataNode(), {
    msg: { payload: event },
    env: ENV,
    osiLibModules: { 'uplink-dedup': dedupGuard },
  });
}

async function ingest(db, event) {
  const processed = await processData(event);
  assert.deepEqual(processed.errors, [], 'Process Data errors');
  assert.ok(processed.result && processed.result.formattedData, 'Process Data passes the Clover uplink on');
  const built = await executeFunction(buildSqlInsertNode(), { msg: processed.result, env: ENV });
  assert.deepEqual(built.errors, [], 'Build SQL INSERT errors');
  db.exec(built.result.topic);
  return processed.result.formattedData;
}

async function deviceList(db) {
  const deviceRows = db.prepare('SELECT * FROM devices ORDER BY deveui').all();
  const formatted = await executeFunction(loadNode('format-devices'), { msg: { payload: deviceRows } });
  assert.deepEqual(formatted.errors, [], 'format-devices errors');
  const latest = db.prepare(formatted.result.topic).all();
  const merged = await executeFunction(loadNode('merge-device-data'), {
    msg: { devices_to_format: formatted.result.devices_to_format, payload: latest },
    db,
    osiLibModules: { 'sdi12-commissioning': { projectDeployment: () => null } },
  });
  assert.deepEqual(merged.errors, [], 'merge-device-data errors');
  return new Map(JSON.parse(JSON.stringify(merged.result.payload)).map((device) => [device.deveui, device]));
}

const CASES = [];

CASES.push({
  name: 'the shipped codec decodes the Clover frame into the fields Process Data reads',
  async run() {
    const decoded = decode(CLOVER_FRAME, 10);
    assert.deepEqual(decoded.errors, []);
    assert.equal(decoded.data.ambient_temperature, 17.3);
    assert.equal(decoded.data.relative_humidity, 82.5);
    assert.equal(decoded.data.light_intensity, 3415);
  },
});

CASES.push({
  name: 'a decoded Clover uplink lands in device_data, the sync outbox and the device list',
  async run() {
    const db = freshDb();
    try {
      const time = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const formatted = await ingest(db, chirpstackEvent({ object: decode(CLOVER_FRAME, 10).data, time, fCnt: 41 }));
      assert.equal(formatted.devEui, DEVEUI);

      const rows = db.prepare('SELECT * FROM device_data WHERE deveui = ?').all(DEVEUI);
      assert.equal(rows.length, 1, 'one device_data row');
      const [row] = rows;
      assert.equal(row.recorded_at, time);
      assert.equal(row.ambient_temperature, 17.3);
      assert.equal(row.relative_humidity, 82.5);
      assert.equal(row.light_lux, 3415);
      // A Clover has no watermark inputs: soil tension stays null, never 0.
      for (const column of ['swt_1', 'swt_2', 'swt_3', 'swt_wm1', 'swt_wm2']) {
        assert.equal(row[column], null, `${column} stays null`);
      }

      const outbox = db.prepare("SELECT * FROM sync_outbox WHERE op = 'DEVICE_DATA_APPENDED'").all();
      assert.equal(outbox.length, 1, 'one DEVICE_DATA_APPENDED event for the cloud');
      assert.equal(outbox[0].aggregate_key, `${DEVEUI}|${time}`);
      assert.equal(outbox[0].gateway_device_eui, GATEWAY_EUI);
      const payload = JSON.parse(outbox[0].payload_json);
      assert.equal(payload.device_eui, DEVEUI);
      assert.equal(payload.device_type, 'TEKTELIC_CLOVER');
      assert.equal(payload.recorded_at, time);
      assert.equal(payload.ambient_temperature, 17.3);
      assert.equal(payload.relative_humidity, 82.5);
      assert.equal(payload.light_lux, 3415);
      assert.equal(payload.swt_1, null);

      const device = (await deviceList(db)).get(DEVEUI);
      assert.ok(device, 'the Clover is in GET /api/devices');
      assert.equal(device.type_id, 'TEKTELIC_CLOVER');
      assert.equal(device.last_seen, time);
      assert.equal(device.latest_data.ambient_temperature, 17.3);
      assert.equal(device.latest_data.relative_humidity, 82.5);
      assert.equal(device.latest_data.light_lux, 3415);
      assert.equal(device.latest_data.swt_1, null);
    } finally {
      db.close();
    }
  },
});

CASES.push({
  name: 'the same frame without a decoded object (codec-less field-tester profile) is dropped',
  async run() {
    const processed = await processData(chirpstackEvent({ time: new Date().toISOString(), fCnt: 42 }));
    assert.equal(processed.result, null);
    assert.deepEqual(processed.errors, ['Unexpected payload structure']);
  },
});

CASES.push({
  name: 'the field-tester application stays fenced even on the Clover profile id',
  async run() {
    const event = chirpstackEvent({ object: decode(CLOVER_FRAME, 10).data, time: new Date().toISOString(), fCnt: 43 });
    event.deviceInfo.applicationId = FIELD_TESTER_APP;
    const processed = await processData(event);
    assert.equal(processed.result, null);
    assert.deepEqual(processed.errors, []);
  },
});

(async () => {
  let failed = 0;
  for (const testCase of CASES) {
    try {
      await testCase.run();
      console.log(`OK   ${testCase.name}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${testCase.name}\n     ${String(error && error.stack ? error.stack : error).split('\n').slice(0, 6).join('\n     ')}`);
    }
  }
  console.log(failed ? `\n${failed} of ${CASES.length} case(s) failed` : `\nAll ${CASES.length} Clover ingest cases passed`);
  process.exit(failed ? 1 : 0);
})();
