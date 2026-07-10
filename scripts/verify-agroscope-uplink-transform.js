#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const transformPath = path.join(
  __dirname,
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/agroscope_uplink_transform.js'
);

const { toAgroscopeUplink } = require(transformPath);

const flowPath = path.join(
  __dirname,
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const deployPath = path.join(__dirname, '../deploy.sh');
const nodeRedInitPath = path.join(
  __dirname,
  '../feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init'
);

const rawPayload = Buffer.from('0d3e0001', 'hex');
const dendroUplink = {
  deviceInfo: {
    devEui: 'a840413a10601d75',
    deviceProfileName: 'OSI Dragino LSN50',
  },
  time: '2026-07-07T09:48:32.101+02:00',
  fPort: 2,
  data: rawPayload.toString('base64'),
  object: {
    BatV: 3.39,
    ADC_CH0V: 1.234,
    Work_mode: 'IIC',
  },
};

assert.deepStrictEqual(toAgroscopeUplink(dendroUplink), {
  topic: 'OSI_dendro/A840413A10601D75/uplink',
  payload: {
    DevEUI_uplink: {
      Time: '2026-07-07T09:48:32.101+02:00',
      DevEUI: 'A840413A10601D75',
      FPort: '2',
      payload_hex: '0d3e0001',
      payload: {
        Bat_V: 3.39,
        VDC_intput_V: 1.234,
      },
    },
  },
});

const untimedDendroUplink = JSON.parse(JSON.stringify(dendroUplink));
delete untimedDendroUplink.time;
assert.strictEqual(
  toAgroscopeUplink(untimedDendroUplink),
  null,
  'dendrometer uplinks without ChirpStack time are dropped'
);

assert.strictEqual(
  toAgroscopeUplink({
    deviceInfo: {
      devEui: '70b3d57ed006abcd',
      deviceProfileName: 'OSI Aqua-Scope LoRain',
    },
    time: '2026-07-07T09:49:00.000+02:00',
    fPort: 10,
    data: Buffer.from('060100cd', 'hex').toString('base64'),
    object: { rain_mm_delta: 1.5 },
  }),
  null
);

assert.strictEqual(
  toAgroscopeUplink({
    deviceInfo: {
      devEui: 'a840413a1060cafe',
      deviceProfileName: 'OSI Dragino LSN50',
    },
    time: '2026-07-07T09:50:00.000+02:00',
    fPort: 2,
    data: Buffer.from('01020304', 'hex').toString('base64'),
    object: {
      Chameleon_Payload_Version: 1,
      ADC_CH0V: 1.111,
      BatV: 3.42,
    },
  }),
  null,
  'Chameleon payloads share the LSN50 profile but must not be forwarded as dendrometers'
);

const flows = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
const findNode = (id) => flows.find((node) => node && node.id === id);
const localUplink = findNode('e73a11a2a36aab22');
const forwardFn = findNode('agroscope-forward-fn');
const mqttOut = findNode('agroscope-mqtt-out');
const broker = findNode('agroscope-mqtt-broker');
const agroscopeInboundNodes = flows.filter((node) => node && node.type === 'mqtt in' && (
  node.broker === 'agroscope-mqtt-broker'
    || /agroscope|ags\//i.test(String(node.name || '') + ' ' + String(node.topic || ''))
    || /actuator/i.test(String(node.topic || ''))
));

assert.ok(localUplink, 'local ChirpStack uplink node exists');
assert.strictEqual(localUplink.topic, 'application/+/device/+/event/up');
assert.ok(
  Array.isArray(localUplink.wires) && Array.isArray(localUplink.wires[0]) && localUplink.wires[0].includes('agroscope-forward-fn'),
  'local uplink node fans out to the Agroscope forward branch'
);

assert.ok(forwardFn, 'Agroscope forward function exists');
assert.match(forwardFn.func, /AGROSCOPE_FORWARD_ENABLED/, 'forward branch is opt-in gated');
assert.match(forwardFn.func, /deviceProfileName/, 'forward branch has a deviceProfileName guard');
assert.ok(
  forwardFn.func.includes("osiLib.require('agroscope-uplink-transform')"),
  'forward branch loads the pure transform via osi-lib'
);
assert.ok(
  (forwardFn.libs || []).some((lib) => lib && lib.var === 'osiLib' && lib.module === 'osi-lib'),
  'forward node declares osiLib in libs'
);
assert.match(forwardFn.func, /toAgroscopeUplink/, 'forward branch calls toAgroscopeUplink');

assert.ok(mqttOut, 'Agroscope MQTT-out node exists');
assert.strictEqual(mqttOut.broker, 'agroscope-mqtt-broker');
assert.strictEqual(mqttOut.qos, '1');

assert.ok(broker, 'Agroscope MQTT broker config exists');
assert.strictEqual(broker.broker, '127.0.0.1');
assert.strictEqual(broker.port, '1883');
assert.strictEqual(broker.usetls, false);
assert.deepStrictEqual(
  agroscopeInboundNodes.map((node) => ({ id: node.id, name: node.name, topic: node.topic, broker: node.broker })),
  [],
  'Agroscope integration is publish-only with no inbound MQTT subscription'
);

const deploySource = fs.readFileSync(deployPath, 'utf8');
assert.match(
  deploySource,
  /agroscope_uplink_transform\.js/,
  'deploy.sh copies the Agroscope transform codec to /srv/node-red/codecs'
);

const nodeRedInitSource = fs.readFileSync(nodeRedInitPath, 'utf8');
assert.match(
  nodeRedInitSource,
  /resolve_chirpstack_value osi-server\.cloud\.agroscope_forward_enabled AGROSCOPE_FORWARD_ENABLED/,
  'node-red.init resolves the Agroscope forwarding opt-in flag'
);
assert.match(
  nodeRedInitSource,
  /resolve_chirpstack_value osi-server\.cloud\.agroscope_mqtt_host AGROSCOPE_MQTT_HOST/,
  'node-red.init resolves the Agroscope broker host override'
);
assert.match(
  nodeRedInitSource,
  /resolve_chirpstack_value osi-server\.cloud\.agroscope_mqtt_port AGROSCOPE_MQTT_PORT/,
  'node-red.init resolves the Agroscope broker port override'
);
assert.match(
  nodeRedInitSource,
  /agroscope-mqtt-broker/,
  'node-red.init provisions credentials for the Agroscope broker node'
);
assert.match(
  nodeRedInitSource,
  /AGROSCOPE_FORWARD_ENABLED="\$agroscope_forward_enabled"/,
  'node-red.init exports the Agroscope opt-in flag to Node-RED'
);
assert.match(
  nodeRedInitSource,
  /agroscope_runtime_mqtt_host="127\.0\.0\.1"/,
  'node-red.init keeps the Agroscope broker target local when forwarding is disabled'
);
assert.match(
  nodeRedInitSource,
  /agroscope_forward_normalized.*\n[\s\S]*1\|true\|yes\|on\)[\s\S]*agroscope_runtime_mqtt_host="\$agroscope_mqtt_host"/,
  'node-red.init only rewrites the real Agroscope broker host when forwarding is enabled'
);
assert.match(
  nodeRedInitSource,
  /AGROSCOPE_MQTT_HOST_VALUE="\$agroscope_runtime_mqtt_host"/,
  'node-red.init rewrites the flow broker with the gated runtime host'
);
assert.match(
  nodeRedInitSource,
  /AGROSCOPE_MQTT_PORT="\$agroscope_runtime_mqtt_port"/,
  'node-red.init exports the gated Agroscope broker port to Node-RED'
);

console.log('Agroscope uplink transform checks passed');
