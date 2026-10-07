'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { deviceSourceId, describeDeviceSource, DEVICE_TYPE_IDS } = require('./device-sources');
const analysis = require('./analysis');

const REPO_ROOT = path.resolve(__dirname, '../../../../../../..');
const SEED = fs.readFileSync(path.join(REPO_ROOT, 'database/seed-blank.sql'), 'utf8');
const GUI_CATALOGUE = fs.readFileSync(path.join(REPO_ROOT, 'web/react-gui/src/types/farming.ts'), 'utf8');

function seedDeviceTypes() {
  const match = SEED.match(/type_id\s+TEXT NOT NULL CHECK\(type_id IN \(\s*([\s\S]*?)\)\),/);
  assert.ok(match, 'seed devices CHECK must remain discoverable');
  return Array.from(match[1].matchAll(/'([A-Z0-9_]+)'/g), (m) => m[1]);
}

function guiDeviceTypes() {
  const match = GUI_CATALOGUE.match(/export type DeviceType\s*=\s*([^;]+);/);
  assert.ok(match, 'GUI DeviceType must remain discoverable');
  return Array.from(match[1].matchAll(/'([A-Z0-9_]+)'/g), (m) => m[1]);
}

test('source policy covers every seeded device type', () => {
  const seeded = seedDeviceTypes().sort();
  assert.deepEqual(guiDeviceTypes().sort(), seeded);
  assert.deepEqual([...DEVICE_TYPE_IDS].sort(), seeded);
  for (const typeId of seeded) {
    const source = describeDeviceSource({ type_id: typeId, deveui: `001122334455${String(seeded.indexOf(typeId) + 1).padStart(4, '0')}` });
    assert.match(deviceSourceId({ deveui: 'A840410000000077' }), /^device-[0-9a-f]{12}$/);
    assert.ok(source.presentation === 'specialized' || source.families.some((family) => family.channelKeys.length), typeId);
  }
});

test('LoRain declares exactly its persisted environment channels', () => {
  const source = describeDeviceSource({ type_id: 'AQUASCOPE_LORAIN', deveui: 'A840410000000077' });
  assert.deepEqual(source.families.flatMap((family) => family.channelKeys).sort(), [
    'ambient_temperature', 'rain_tips_delta', 'rain_mm_delta', 'rain_mm_today',
    'rain_mm_per_hour', 'rain_mm_per_10min', 'bat_v',
  ].sort());
});

test('source identity is stable across names, case and renames', () => {
  const first = { deveui: 'a8404100000000bb', name: 'Same name', type_id: 'KIWI_SENSOR' };
  assert.equal(deviceSourceId(first), deviceSourceId({ ...first, name: 'Renamed' }));
  assert.equal(deviceSourceId(first), deviceSourceId({ ...first, deveui: 'A8404100000000BB' }));
  assert.throws(() => deviceSourceId({ name: 'missing eui' }), /empty EUI/);
});

test('LSN50 and SDI12 preserve finite historical candidates', () => {
  const lsn50 = describeDeviceSource({ type_id: 'DRAGINO_LSN50', deveui: 'A840410000000066', temp_enabled: 0, rain_gauge_enabled: 0, flow_meter_enabled: 0 });
  assert.ok(lsn50.currentChannelKeys.includes('swt_1'));
  assert.ok(lsn50.currentChannelKeys.includes('bat_v'));
  assert.ok(!lsn50.families.flatMap((family) => family.channelKeys).includes('bat_pct'));
  assert.ok(lsn50.families.some((family) => family.channelKeys.includes('swt_3')));
  assert.ok(lsn50.families.some((family) => family.channelKeys.includes('rain_mm_delta')));

  const sdi12 = describeDeviceSource({
    type_id: 'DRAGINO_SDI12',
    deveui: 'A840410000000067',
    soil_moisture_probe_depths_json: JSON.stringify({ vwc_1: 10 }),
  });
  assert.ok(sdi12.families.some((family) => family.channelKeys.includes('vwc_8')));
  assert.ok(sdi12.families.some((family) => family.channelKeys.includes('soil_ec_2')));
  assert.ok(!sdi12.families.some((family) => family.channelKeys.includes('soil_ec_3')));
  assert.ok(sdi12.currentChannelKeys.includes('vwc_1'));
  assert.ok(sdi12.currentChannelKeys.includes('bat_v'));
});

test('SDI12 battery remains current for unconfigured and malformed profiles', () => {
  for (const device of [
    { type_id: 'DRAGINO_SDI12', deveui: 'A840410000000070' },
    { type_id: 'DRAGINO_SDI12', deveui: 'A840410000000071', sdi12_probe_profile: 'UNKNOWN' },
    { type_id: 'DRAGINO_SDI12', deveui: 'A840410000000072', sdi12_channel_layout_json: '{bad json' },
  ]) {
    const source = describeDeviceSource(device);
    assert.deepEqual(source.currentChannelKeys, ['bat_v']);
    assert.deepEqual(source.families.find((family) => family.cardType === 'device_health').channelKeys, ['bat_v']);
  }
});

test('UC512 and STREGA expose numeric health while keeping textual states out', () => {
  const uc512 = describeDeviceSource({ type_id: 'MILESIGHT_UC512', deveui: 'A840410000000068' });
  const ucKeys = uc512.families.flatMap((family) => family.channelKeys);
  assert.ok(ucKeys.includes('pipe_pressure_kpa'));
  assert.ok(ucKeys.includes('valve_1_pulse'));
  assert.ok(!ucKeys.includes('valve_1_state'));

  const gen2 = describeDeviceSource({ type_id: 'STREGA_VALVE', deveui: 'A840410000000069', valve_generation: 'GEN2' });
  assert.ok(gen2.families.flatMap((family) => family.channelKeys).includes('bat_v'));
  assert.ok(gen2.families.flatMap((family) => family.channelKeys).includes('ambient_temperature'));
  assert.equal(gen2.limitation, 'valve_events');
});

test('every declared source key has manifest metadata and an allowed edge field', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'web/react-gui/src/channels/channels.json'), 'utf8'));
  const metadata = new Map([
    ...analysis.CHANNELS,
    ...analysis.DEVICE_HEALTH_CHANNELS,
  ].map((channel) => [channel.key, channel]));
  for (const typeId of DEVICE_TYPE_IDS) {
    const source = describeDeviceSource({ type_id: typeId, deveui: 'A840410000000066' });
    for (const key of source.families.flatMap((family) => family.channelKeys)) {
      const meta = metadata.get(key);
      assert.ok(meta, `${typeId} declares ${key} without analysis metadata`);
      assert.ok(meta.edgeField && analysis.ANALYSIS_EDGE_FIELDS.has(meta.edgeField), `${typeId} declares ${key} without an allowed persisted field`);
      const manifestEntry = manifest.find((entry) => entry.key === key);
      assert.ok(manifestEntry, `${key} is absent from channels.json`);
      assert.equal(manifestEntry.edgeField, meta.edgeField, `${key} edge field differs from channels.json`);
    }
  }
});
