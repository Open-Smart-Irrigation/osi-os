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

function compareExpectedSeries(expectedSeries, actualSeries, tolerance) {
  const mismatches = [];
  if (actualSeries.length !== expectedSeries.length) {
    mismatches.push(`series count: expected ${expectedSeries.length}, got ${actualSeries.length}`);
  }
  const metadataKeys = [
    'id',
    'deviceSourceId',
    'sourceKey',
    'channelKey',
    'sourceLabel',
    'label',
    'unit',
    'depthCm',
    'metadataBasis',
  ];
  for (let index = 0; index < expectedSeries.length; index += 1) {
    const expected = expectedSeries[index];
    const actual = actualSeries.find((series) => series.id === expected.id) || actualSeries[index];
    if (!actual) {
      mismatches.push(`series ${expected.id}: missing`);
      continue;
    }
    const expectedMetadata = {
      id: expected.id,
      deviceSourceId: expected.deviceSourceId,
      sourceKey: expected.sourceKey,
      channelKey: expected.channelKey,
      sourceLabel: expected.sourceLabel,
      label: expected.label,
      unit: expected.unit,
      depthCm: expected.depthCm,
      metadataBasis: expected.metadataBasis,
    };
    for (const key of metadataKeys) {
      if (actual[key] !== expectedMetadata[key]) {
        mismatches.push(`series ${expected.id}.${key}: expected ${JSON.stringify(expectedMetadata[key])}, got ${JSON.stringify(actual[key])}`);
      }
    }
    const actualPoints = Array.isArray(actual.points) ? actual.points : [];
    if (actualPoints.length !== expected.points.length) {
      mismatches.push(`series ${expected.id}.points count: expected ${expected.points.length}, got ${actualPoints.length}`);
    }
    for (let pointIndex = 0; pointIndex < expected.points.length; pointIndex += 1) {
      const expectedPoint = expected.points[pointIndex];
      const actualPoint = actualPoints[pointIndex];
      if (!actualPoint) {
        mismatches.push(`series ${expected.id}.points[${pointIndex}]: missing`);
        continue;
      }
      for (const key of ['t', 'bucketStart', 'bucketEnd']) {
        const actualTime = new Date(actualPoint[key]).toISOString();
        const expectedTime = new Date(expectedPoint[key]).toISOString();
        if (actualTime !== expectedTime) {
          mismatches.push(`series ${expected.id}.points[${pointIndex}].${key}: expected ${expectedTime}, got ${actualTime}`);
        }
      }
      if (expectedPoint.value === null || actualPoint.value === null) {
        if (actualPoint.value !== expectedPoint.value) {
          mismatches.push(`series ${expected.id}.points[${pointIndex}].value: expected ${expectedPoint.value}, got ${actualPoint.value}`);
        }
      } else if (Math.abs(actualPoint.value - expectedPoint.value) > tolerance) {
        mismatches.push(`series ${expected.id}.points[${pointIndex}].value: expected ${expectedPoint.value}, got ${actualPoint.value}`);
      }
    }
  }
  return mismatches;
}

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

      const responseSeries = router.buildSeriesFromAggregate(
        { cardType: 'soil' },
        result,
        fixture.devices.map((device) => ({
          deveui: device.deveui,
          name: device.name,
          type_id: 'KIWI_SENSOR',
          chameleon_enabled: 0,
          soil_moisture_probe_depths_json: JSON.stringify({ swt_1: device.depthCm }),
          irrigation_zone_id: 1,
        }))
      );
      // buildSeriesFromAggregate is a series projection helper, not the HTTP
      // response boundary. The boundary marker is asserted by Task 2/3 route
      // tests; adding it here would make this series-only test fabricate it.
      const expectedResponseSeries = fixture.expectedResponses.edge.series;
      const mismatches = compareExpectedSeries(
        expectedResponseSeries,
        responseSeries,
        fixture.edgeAggregateToleranceKpa
      );

      const rawResult = await helper.aggregateDeviceData(facade(raw), {
        device_euis: fixture.devices.map((device) => device.deveui),
        start: fixture.request.from,
        end: fixture.request.to,
        aggregation: 'raw',
        timezone: fixture.request.timezone,
        sourceFilterActive: true,
        useRollups: false,
        channels: [{ id: fixture.channelKey, field: fixture.channelKey, unit: fixture.unit }],
      });
      const rawSeries = router.buildSeriesFromAggregate(
        { cardType: 'soil' },
        rawResult,
        fixture.devices.map((device) => ({
          deveui: device.deveui,
          name: device.name,
          type_id: 'KIWI_SENSOR',
          chameleon_enabled: 0,
          soil_moisture_probe_depths_json: JSON.stringify({ swt_1: device.depthCm }),
          irrigation_zone_id: 1,
        }))
      );
      const actualRawPoints = rawSeries
        .flatMap((series) => series.points.map((point) => ({ t: point.t, value: point.value })))
        .sort((left, right) => left.t.localeCompare(right.t));
      const expectedRawPoints = fixture.devices
        .flatMap((device) => device.observations.map((observation) => ({
          t: new Date(observation.recordedAt).toISOString(),
          value: observation.value,
        })))
        .sort((left, right) => left.t.localeCompare(right.t));
      assert.deepEqual(actualRawPoints, expectedRawPoints);
      assert.deepEqual(mismatches, [], JSON.stringify({ result, responseSeries, expectedResponseSeries }));
    } finally {
      raw.close();
    }
  });
}
