#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');

const {
  seedFixtureDb,
  runNodeForRoute,
  readNodeFunc,
} = require('./capture-history-router-vectors');

function setupFixture() {
  const dir = fs.mkdtempSync(path.join('/var/tmp', 'osi-history-soil-e1-'));
  const dbPath = path.join(dir, 'fixture.db');
  seedFixtureDb(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec('DELETE FROM device_data; DELETE FROM devices;');
  db.exec(`
    INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at, irrigation_zone_id,
      dendro_enabled, temp_enabled, rain_gauge_enabled, flow_meter_enabled,
      chameleon_enabled, gateway_device_eui)
    VALUES ('A84041A171000001', 'Excluded LSN50', 'DRAGINO_LSN50', 1, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z', 1,
      1, 0, 0, 0, 0, '0016C001F1000001');
    INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at, irrigation_zone_id,
      dendro_enabled, temp_enabled, rain_gauge_enabled, flow_meter_enabled,
      chameleon_enabled, soil_moisture_probe_depths_json, gateway_device_eui)
    VALUES ('A84041A171000002', 'Plain LSN50', 'DRAGINO_LSN50', 1, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z', 1,
      0, 0, 0, 0, 0, '{"swt_1":11,"swt_2":12,"swt_3":13}', '0016C001F1000001');
    INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at, irrigation_zone_id,
      dendro_enabled, temp_enabled, rain_gauge_enabled, flow_meter_enabled,
      chameleon_enabled, chameleon_swt1_depth_cm, chameleon_swt2_depth_cm, chameleon_swt3_depth_cm, gateway_device_eui)
    VALUES ('A84041A171000003', 'Chameleon LSN50', 'DRAGINO_LSN50', 1, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z', 1,
      1, 1, 1, 1, 1, 21, 31, 41, '0016C001F1000001');
    INSERT INTO device_data (deveui, recorded_at, swt_1, swt_2, swt_3)
    VALUES
      ('A84041A171000001', '2026-07-10T11:30:00.000Z', 888, NULL, 777),
      ('A84041A171000002', '2026-07-10T11:00:00.000Z', 30, NULL, 999),
      ('A84041A171000003', '2026-07-10T10:00:00.000Z', NULL, 30, 40),
      ('A84041A171000003', '2026-07-10T11:15:00.000Z', NULL, NULL, NULL);
    INSERT INTO history_channel_rollups (
      zone_id, card_type, logical_source_key, channel_id, bucket_level, bucket_start, bucket_end,
      min_value, max_value, mean_value, median_value, latest_value, coverage_pct, coverage_confidence, sample_count, unit)
    VALUES (1, 'soil', 'root-zone', 'swt_3', 'daily', '2026-07-09T00:00:00.000Z', '2026-07-10T00:00:00.000Z',
      999, 999, 999, 999, 999, 100, 'configured', 1, 'kPa');
  `);
  db.close();
  return { dir, dbPath };
}

test('shipped history router filters stale plain-LSN50 SWT3 per device and keeps contributor depths', async () => {
  const fixture = setupFixture();
  try {
    const result = await runNodeForRoute(readNodeFunc(), fixture.dbPath, {
      name: 'soil-projection',
      method: 'GET',
      path: '/api/history/zones/1/cards/test-zone-uuid-1:soil:root-zone/data',
      params: { zoneId: '1', cardId: 'test-zone-uuid-1:soil:root-zone' },
      query: { range: '30d', aggregation: 'daily' },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.payload.aggregation.source, 'device_data');
    const byId = Object.fromEntries(result.payload.series.map((entry) => [entry.id, entry]));
    assert.equal(byId.swt_3.points[0].mean, 40);
    assert.equal(byId.swt_3.depthCm, 41);
    assert.ok(!byId.swt_3.points.some((point) => point.value === 999));
    const profiles = Object.fromEntries(result.payload.profiles.map((entry) => [entry.id, entry]));
    assert.deepEqual(profiles.swt_1, { id: 'swt_1', label: 'Soil 1', depthCm: 11, value: 30, unit: 'kPa', status: 'optimal' });
    assert.deepEqual(profiles.swt_2, { id: 'swt_2', label: 'Soil 2', depthCm: 31, value: 30, unit: 'kPa', status: 'optimal' });
    assert.deepEqual(profiles.swt_3, { id: 'swt_3', label: 'Soil 3', depthCm: 41, value: 40, unit: 'kPa', status: 'optimal' });

    const cards = await runNodeForRoute(readNodeFunc(), fixture.dbPath, {
      name: 'soil-summary',
      method: 'GET',
      path: '/api/history/zones/1/cards',
      params: { zoneId: '1' },
      query: {},
    });
    const soilCard = cards.payload.cards.find((card) => card.cardType === 'soil');
    assert.equal(soilCard.sourceDeviceCount, 2);
    assert.deepEqual(soilCard.sourceDevices.map((device) => device.name), ['Plain LSN50', 'Chameleon LSN50']);
    assert.equal(soilCard.ordering.criticalAlert, false);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
