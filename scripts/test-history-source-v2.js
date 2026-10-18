#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_PATH = path.join(ROOT, 'docs/contracts/history-source-v2/synthetic-cases.json');
const SEED_PATH = path.join(ROOT, 'database/seed-blank.sql');
const PROFILES = [
  'full_raspberrypi_bcm27xx_bcm2712',
  'full_raspberrypi_bcm27xx_bcm2709',
];

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')).fiveObservationCase;
const seed = fs.readFileSync(SEED_PATH, 'utf8');

function databaseForFixture() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(seed);
  raw.exec(`
    INSERT INTO users (id, username, password_hash, created_at, updated_at, user_uuid)
    VALUES (1, 'history-source-v2', 'fixture', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'history-source-v2-user');
    INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at)
    VALUES
      ('A8404100000000A1', 'Synthetic A', 'KIWI_SENSOR', 1, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
      ('A8404100000000B1', 'Synthetic B', 'KIWI_SENSOR', 1, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
  `);
  const insert = raw.prepare('INSERT INTO device_data (deveui, recorded_at, swt_1) VALUES (?, ?, ?)');
  for (const device of fixture.devices) {
    for (const observation of device.observations) {
      insert.run(device.deveui, observation.recordedAt, observation.value);
    }
  }
  return raw;
}

function facade(raw) {
  return {
    all(sql, params) {
      return raw.prepare(sql).all(...(params || []));
    },
  };
}

function loadHelper(profile) {
  return require(path.join(
    ROOT,
    'conf',
    profile,
    'files/usr/share/node-red/osi-history-helper'
  ));
}

function loadRouter(profile) {
  return require(path.join(
    ROOT,
    'conf',
    profile,
    'files/usr/share/node-red/osi-history-router'
  ));
}

for (const profile of PROFILES) {
  test(`${profile}: five observations keep one series per physical source`, async () => {
    const helper = loadHelper(profile);
    const router = loadRouter(profile);
    const raw = databaseForFixture();
    try {
      const result = await helper.aggregateDeviceData(facade(raw), {
        device_euis: fixture.devices.map((device) => device.deveui),
        start: fixture.request.from,
        end: fixture.request.to,
        aggregation: fixture.request.aggregation,
        timezone: fixture.request.timezone,
        sourceFilterActive: true,
        useRollups: false,
        channels: [{ id: fixture.channelKey, field: fixture.channelKey, unit: fixture.unit }],
      });

      const expectedSeriesIds = fixture.expectedSeries.map((series) => `${series.deviceSourceId}:${series.channelKey}`);
      const responseSeries = router.buildSeriesFromAggregate(
        { cardType: 'soil' },
        result,
        fixture.devices.map((device) => ({
          deveui: device.deveui,
          name: device.name,
          type_id: 'KIWI_SENSOR',
          chameleon_enabled: 0,
          irrigation_zone_id: 1,
        }))
      );
      const actualSeriesIds = responseSeries.map((series) => series.id);
      assert.deepEqual(actualSeriesIds.sort(), expectedSeriesIds.sort(), JSON.stringify(result));
    } finally {
      raw.close();
    }
  });
}
