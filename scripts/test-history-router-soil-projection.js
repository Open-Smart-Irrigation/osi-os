#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');

const {
  seedFixtureDb,
  runNodeForRoute,
  readNodeFunc,
} = require('./capture-history-router-vectors');

function sourceKey(cardType, deveui) {
  return `${cardType}-src-${crypto.createHash('sha256').update(deveui).digest('hex').slice(0, 12)}`;
}

function deviceSourceId(deveui) {
  return `device-${crypto.createHash('sha256').update(deveui).digest('hex').slice(0, 12)}`;
}

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

function setupOverflowFixture({ liveTail = false } = {}) {
  const dir = fs.mkdtempSync(path.join('/var/tmp', 'osi-history-overflow-e1-'));
  const dbPath = path.join(dir, 'fixture.db');
  seedFixtureDb(dbPath);
  const db = new DatabaseSync(dbPath);
  const eui = 'A840410000000011';
  const sourceKey = `soil-src-${crypto.createHash('sha256').update(eui).digest('hex').slice(0, 12)}`;
  db.exec('DELETE FROM device_data; DELETE FROM devices;');
  db.exec(`
    INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at, irrigation_zone_id,
      dendro_enabled, temp_enabled, rain_gauge_enabled, flow_meter_enabled, chameleon_enabled, gateway_device_eui)
    VALUES ('${eui}', 'Overflow source', 'KIWI_SENSOR', 1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 1,
      0, 0, 0, 0, 0, '0016C001F1000001');
    INSERT INTO history_channel_rollups (
      zone_id, card_type, logical_source_key, channel_id, bucket_level, bucket_start, bucket_end,
      min_value, max_value, mean_value, median_value, latest_value, coverage_pct, coverage_confidence, sample_count, unit)
    VALUES (1, 'soil', '${sourceKey}', 'swt_1', 'daily', '2026-07-09T00:00:00.000Z', '2026-07-10T00:00:00.000Z',
      5, 5, 5, 5, 5, 100, 'configured', 1, 'kPa');
  `);
  db.exec('BEGIN');
  const insert = db.prepare('INSERT INTO device_data (deveui, recorded_at, swt_1) VALUES (?, ?, ?)');
  const rowStart = liveTail ? '2026-07-10T00:00:00.000Z' : '2026-07-08T00:00:00.000Z';
  for (let index = 0; index < 30001; index += 1) {
    insert.run(eui, new Date(Date.parse(rowStart) + index * 1000).toISOString(), 1);
  }
  db.exec('COMMIT');
  db.close();
  return {
    dir,
    dbPath,
    query: liveTail
      ? { from: '2026-07-09T00:00:00.000Z', to: '2026-07-11T00:00:00.000Z' }
      : { from: '2026-07-08T00:00:00.000Z', to: '2026-07-10T00:00:00.000Z' },
  };
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
    const swt3 = result.payload.series.find((entry) => entry.channelKey === 'swt_3');
    assert.ok(swt3, 'the Chameleon source retains SWT3');
    assert.equal(swt3.sourceLabel, 'Chameleon LSN50');
    assert.equal(swt3.points.at(-1).mean, 40);
    assert.equal(swt3.depthCm, 41);
    assert.ok(!result.payload.series.filter((entry) => entry.channelKey === 'swt_3').some((entry) => entry.sourceLabel === 'Plain LSN50'));
    const profiles = result.payload.profiles;
    const profileFields = (entry) => ({ id: entry.id, label: entry.label, depthCm: entry.depthCm, value: entry.value, unit: entry.unit, status: entry.status });
    const plainSourceId = deviceSourceId('A84041A171000002');
    const chameleonSourceId = deviceSourceId('A84041A171000003');
    assert.deepEqual(profiles.map((entry) => entry.id), ['swt_1', 'swt_2', 'swt_3']);
    const profileIdentity = (entry) => `${entry.deviceSourceId}:${entry.channelKey}`;
    assert.deepEqual(profileFields(profiles.find((entry) => profileIdentity(entry) === `${plainSourceId}:swt_1`)), { id: 'swt_1', label: 'Soil 1', depthCm: 11, value: 30, unit: 'kPa', status: 'optimal' });
    assert.deepEqual(profileFields(profiles.find((entry) => profileIdentity(entry) === `${chameleonSourceId}:swt_2`)), { id: 'swt_2', label: 'Soil 2', depthCm: 31, value: 30, unit: 'kPa', status: 'optimal' });
    assert.deepEqual(profileFields(profiles.find((entry) => profileIdentity(entry) === `${chameleonSourceId}:swt_3`)), { id: 'swt_3', label: 'Soil 3', depthCm: 41, value: 40, unit: 'kPa', status: 'optimal' });
    assert.equal(new Set(profiles.map(profileIdentity)).size, profiles.length);

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

test('shipped history router clears retained rollups and derived projections after raw overflow', async () => {
  const fixture = setupOverflowFixture();
  try {
    const result = await runNodeForRoute(readNodeFunc(), fixture.dbPath, {
      name: 'mixed-overflow',
      method: 'GET',
      path: '/api/history/zones/1/cards/test-zone-uuid-1:soil:root-zone/data',
      params: { zoneId: '1', cardId: 'test-zone-uuid-1:soil:root-zone' },
      query: {
        range: 'custom',
        ...fixture.query,
        aggregation: 'daily',
      },
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.payload.availability, {
      available: false,
      reasons: ['raw_read_limit_exceeded', 'select_fewer_sources_or_shorter_interval'],
    });
    assert.ok(result.payload.series.length >= 1, 'authorized source descriptors remain visible');
    assert.ok(result.payload.series.every((entry) => entry.points.length === 0));
    assert.deepEqual(result.payload.profiles, []);
    assert.equal(result.payload.calendar, null);
    assert.deepEqual(result.payload.interpretations, []);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('shipped history router clears retained rollups and derived projections after live-tail raw overflow', async () => {
  const fixture = setupOverflowFixture({ liveTail: true });
  try {
    const result = await runNodeForRoute(readNodeFunc(), fixture.dbPath, {
      name: 'live-tail-overflow',
      method: 'GET',
      path: '/api/history/zones/1/cards/test-zone-uuid-1:soil:root-zone/data',
      params: { zoneId: '1', cardId: 'test-zone-uuid-1:soil:root-zone' },
      query: {
        range: 'custom',
        ...fixture.query,
        aggregation: 'daily',
      },
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.payload.availability, {
      available: false,
      reasons: ['raw_read_limit_exceeded', 'select_fewer_sources_or_shorter_interval'],
    });
    assert.ok(result.payload.series.length >= 1, 'authorized source descriptors remain visible');
    assert.ok(result.payload.series.every((entry) => entry.points.length === 0));
    assert.deepEqual(result.payload.profiles, []);
    assert.equal(result.payload.calendar, null);
    assert.deepEqual(result.payload.interpretations, []);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// I2: the raw-path bypass exists only because a merged soil rollup can carry a
// plain LSN50's stale SWT3. A soil card whose sources are all SWT3-eligible
// (here a KIWI sensor beside a dendrometer LSN50 that is no soil source)
// reads history_channel_rollups exactly as on main.
test('shipped history router keeps soil rollups for a zone without a plain LSN50 source', async () => {
  const dir = fs.mkdtempSync(path.join('/var/tmp', 'osi-history-soil-rollup-'));
  const dbPath = path.join(dir, 'fixture.db');
  try {
    seedFixtureDb(dbPath);
    const db = new DatabaseSync(dbPath);
    db.exec(`
      INSERT INTO history_channel_rollups (
        zone_id, card_type, logical_source_key, channel_id, bucket_level, bucket_start, bucket_end,
        min_value, max_value, mean_value, median_value, latest_value, coverage_pct, coverage_confidence, sample_count, unit)
      VALUES (1, 'soil', '${sourceKey('soil', 'AAAA000000000001')}', 'swt_1', 'daily', '2026-07-08T00:00:00.000Z', '2026-07-09T00:00:00.000Z',
        321, 321, 321, 321, 321, 100, 'configured', 1, 'kPa');
    `);
    db.close();
    const result = await runNodeForRoute(readNodeFunc(), dbPath, {
      name: 'soil-rollup',
      method: 'GET',
      path: '/api/history/zones/1/cards/test-zone-uuid-1:soil:root-zone/data',
      params: { zoneId: '1', cardId: 'test-zone-uuid-1:soil:root-zone' },
      query: { range: '30d', aggregation: 'daily' },
    });
    assert.equal(result.statusCode, 200);
    assert.match(result.payload.aggregation.source, /rollups/);
    const swt1 = result.payload.series.find((entry) => entry.channelKey === 'swt_1');
    assert.ok(swt1.points.some((point) => point.mean === 321), 'the stored rollup bucket is served');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Owner rule: an LSN50 with WATERMARK evidence (a retained calibration or any
// stored reading) is a soil source whatever its temperature flag says. Its
// temperature is soil temperature on that source, not an Environment leaf
// (docs/superpowers/plans/2026-10-16-matric-potential-precision.md, Task 4:
// exclude the WATERMARK temperature from environmental sources to avoid a
// duplicate leaf). A temperature-only LSN50 without evidence stays an
// Environment source; it and a dendrometer LSN50 with an old calibration row
// stay out of the Soil card.
test('shipped history router keeps a temperature-enabled WATERMARK node as a soil source', async () => {
  const dir = fs.mkdtempSync(path.join('/var/tmp', 'osi-history-soil-watermark-'));
  const dbPath = path.join(dir, 'fixture.db');
  try {
    seedFixtureDb(dbPath);
    const db = new DatabaseSync(dbPath);
    db.exec('DELETE FROM device_data; DELETE FROM devices;');
    db.exec(`
      INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at, irrigation_zone_id,
        dendro_enabled, temp_enabled, rain_gauge_enabled, flow_meter_enabled, chameleon_enabled, gateway_device_eui)
      VALUES
        ('A840410000000011', 'Watermark LSN50', 'DRAGINO_LSN50', 1, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z', 1, 0, 1, 0, 0, 0, '0016C001F1000001'),
        ('A840410000000012', 'Temperature LSN50', 'DRAGINO_LSN50', 1, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z', 1, 0, 1, 0, 0, 0, '0016C001F1000001'),
        ('A840410000000013', 'Dendro LSN50', 'DRAGINO_LSN50', 1, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z', 1, 1, 0, 0, 0, 0, '0016C001F1000001');
      INSERT INTO watermark_calibrations (deveui, pullup_1_ohm, pulldown_1_ohm, series_fwd_1_ohm, series_rev_1_ohm,
        pullup_2_ohm, pulldown_2_ohm, series_fwd_2_ohm, series_rev_2_ohm)
      VALUES
        ('A840410000000011', 41670, 41260, 130, 112, 42530, 42070, 46, 27),
        ('A840410000000013', 41670, 41260, 130, 112, 42530, 42070, 46, 27);
      INSERT INTO device_data (deveui, recorded_at, swt_1, swt_2, ext_temperature_c)
      VALUES
        ('A840410000000011', '2026-07-10T11:00:00.000Z', 25, 35, 18.5),
        ('A840410000000012', '2026-07-10T11:00:00.000Z', 999, 998, 19.5),
        ('A840410000000013', '2026-07-10T11:00:00.000Z', 888, 887, NULL);
    `);
    db.close();

    const cards = await runNodeForRoute(readNodeFunc(), dbPath, {
      name: 'watermark-cards', method: 'GET', path: '/api/history/zones/1/cards',
      params: { zoneId: '1' }, query: {},
    });
    assert.equal(cards.statusCode, 200);
    const byType = Object.fromEntries(cards.payload.cards.map((card) => [card.cardType, card]));
    assert.deepEqual(byType.soil.sourceDevices.map((device) => device.name), ['Watermark LSN50']);
    assert.deepEqual(byType.environment.sourceDevices.map((device) => device.name).sort(),
      ['Temperature LSN50']);

    const data = await runNodeForRoute(readNodeFunc(), dbPath, {
      name: 'watermark-soil', method: 'GET',
      path: '/api/history/zones/1/cards/test-zone-uuid-1:soil:root-zone/data',
      params: { zoneId: '1', cardId: 'test-zone-uuid-1:soil:root-zone' },
      query: { range: '24h', aggregation: 'hourly' },
    });
    assert.equal(data.statusCode, 200);
    const series = data.payload.series;
    assert.deepEqual(series.find((entry) => entry.channelKey === 'swt_1').points.filter((point) => point.mean !== null).map((point) => point.mean), [25]);
    assert.deepEqual(series.find((entry) => entry.channelKey === 'swt_2').points.filter((point) => point.mean !== null).map((point) => point.mean), [35]);
    assert.equal(series.some((entry) => entry.channelKey === 'swt_3'), false, 'a non-Chameleon LSN50 exposes no SWT3');

    const csv = await runNodeForRoute(readNodeFunc(), dbPath, {
      name: 'watermark-export', method: 'GET', path: '/api/history/zones/1/export.csv',
      params: { zoneId: '1' }, query: { granularity: 'raw', from: '2026-07-10', to: '2026-07-10' },
    });
    assert.equal(csv.statusCode, 200);
    const soilLines = String(csv.payload).split('\n').filter((line) => line.includes(',soil,'));
    assert.ok(soilLines.some((line) => line.includes('Watermark LSN50') && line.includes(',swt_1,') && line.endsWith(',25')));
    assert.ok(!soilLines.some((line) => /Temperature LSN50|Dendro LSN50/.test(line)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
