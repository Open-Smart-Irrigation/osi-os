#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

function sourceKey(cardType, deveui) {
  return `${cardType}-src-${crypto.createHash('sha256').update(deveui).digest('hex').slice(0, 12)}`;
}

function databaseForPartialRollup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(seed);
  raw.exec(`
    INSERT INTO users (id, username, password_hash, created_at, updated_at, user_uuid)
    VALUES (1, 'partial-rollup', 'fixture', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'partial-rollup-user');
    INSERT INTO irrigation_zones (id, name, user_id, timezone, created_at, updated_at)
    VALUES (1, 'Partial Rollup', 1, 'UTC', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at)
    VALUES
      ('A8404100000000A1', 'Synthetic A', 'KIWI_SENSOR', 1, 1, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
      ('A8404100000000B1', 'Synthetic B', 'KIWI_SENSOR', 1, 1, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
  `);
  raw.prepare('INSERT INTO device_data (deveui, recorded_at, swt_1) VALUES (?, ?, ?)').run('A8404100000000A1', '2026-10-02T12:00:00Z', 22);
  raw.prepare('INSERT INTO device_data (deveui, recorded_at, swt_1) VALUES (?, ?, ?)').run('A8404100000000B1', '2026-10-01T12:00:00Z', 0);
  raw.prepare(`
    INSERT INTO history_channel_rollups (
      zone_id, card_type, logical_source_key, channel_id, bucket_level, bucket_start, bucket_end,
      min_value, max_value, mean_value, median_value, latest_value, coverage_pct,
      coverage_confidence, sample_count, event_count, threshold_crossing_count, unit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    1, 'soil', sourceKey('soil', 'A8404100000000A1'), 'swt_1', 'daily',
    '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z',
    10, 10, 10, 10, 10, 100, 'configured', 1, 0, 0, 'kPa'
  );
  return raw;
}

function databaseForLegacyBoundaries() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(seed);
  raw.exec(`
    INSERT INTO users (id, username, password_hash, created_at, updated_at, user_uuid)
    VALUES (1, 'legacy-boundaries', 'fixture', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'legacy-boundaries-user');
    INSERT INTO irrigation_zones (id, name, user_id, timezone, created_at, updated_at)
    VALUES (1, 'Legacy boundaries', 1, 'UTC', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at)
    VALUES
      ('A8404100000000A1', 'Legacy A', 'KIWI_SENSOR', 1, 1, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
      ('A8404100000000B1', 'Legacy B', 'KIWI_SENSOR', 1, 1, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
  `);
  raw.prepare('INSERT INTO device_data (deveui, recorded_at, swt_1) VALUES (?, ?, ?)').run('A8404100000000A1', '2026-10-02T12:00:00Z', 48);
  raw.prepare('INSERT INTO device_data (deveui, recorded_at, swt_1) VALUES (?, ?, ?)').run('A8404100000000A1', '2026-10-03T12:00:00Z', 24);
  raw.prepare('INSERT INTO device_data (deveui, recorded_at, swt_1) VALUES (?, ?, ?)').run('A8404100000000A1', '2026-10-03T13:00:00Z', 23);
  raw.prepare('INSERT INTO device_data (deveui, recorded_at, swt_1) VALUES (?, ?, ?)').run('A8404100000000B1', '2026-10-03T13:00:00Z', 99);
  return raw;
}

function alternatingRollupDatabase() {
  const startMs = Date.parse('2020-01-01T00:00:00Z');
  const endMs = startMs + (2000 * 24 * 60 * 60 * 1000);
  const logicalSourceKey = sourceKey('soil', 'A8404100000000A1');
  const rollups = [];
  for (let index = 0; index < 2000; index += 2) {
    const bucketStart = new Date(startMs + (index * 24 * 60 * 60 * 1000)).toISOString();
    const bucketEnd = new Date(startMs + ((index + 1) * 24 * 60 * 60 * 1000)).toISOString();
    rollups.push({
      logical_source_key: logicalSourceKey,
      channel_id: 'swt_1',
      bucket_start: bucketStart,
      bucket_end: bucketEnd,
      min_value: 10,
      max_value: 10,
      mean_value: 10,
      median_value: 10,
      latest_value: 10,
      coverage_pct: 100,
      coverage_confidence: 'configured',
      sample_count: 1,
      event_count: 0,
      threshold_crossing_count: 0,
      unit: 'kPa',
    });
  }
  let rawQueries = 0;
  return {
    range: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
    facade: {
      all(sql) {
        if (sql.includes('history_channel_rollups')) return rollups;
        rawQueries += 1;
        return [];
      },
    },
    rawQueryCount: () => rawQueries,
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

  test(`${profile}: equal-time row identity is selected before validity and point budget is explicit`, async () => {
    const helper = loadHelper(profile);
    const sourceA = 'A8404100000000A1';
    const sourceB = 'A8404100000000B1';
    const channel = { id: 'swt_1', field: 'swt_1', unit: 'kPa' };
    const rows = [
      { id: 1, deveui: sourceA, recorded_at: '2026-10-01T00:00:00Z', swt_1: 10 },
      { id: 2, deveui: sourceA, recorded_at: '2026-10-01T00:00:00Z', swt_1: null },
      { id: 3, deveui: sourceB, recorded_at: '2026-10-01T00:00:00Z', swt_1: 0 },
      { id: 4, deveui: sourceB, recorded_at: '2026-10-01T00:00:00Z', swt_1: 999 },
    ];
    const sourceDevices = [
      { deveui: sourceA, type_id: 'KIWI_SENSOR' },
      { deveui: sourceB, type_id: 'KIWI_SENSOR' },
    ];
    const result = helper.aggregateRows(rows, {
      aggregation: 'raw',
      channels: [channel],
      sourceDevices,
      start: '2026-10-01T00:00:00Z',
      end: '2026-10-01T01:00:00Z',
    });
    const bySource = new Map(result.sourceAggregates.map((entry) => [entry.sourceKey, entry]));
    assert.deepEqual(bySource.get(sourceA).series.swt_1.points, []);
    assert.deepEqual(bySource.get(sourceB).series.swt_1.points.map((point) => point.value), [999]);

    const unavailable = await helper.aggregateDeviceData({}, {
      deveuis: [sourceA],
      sourceDevices: [sourceDevices[0]],
      cardType: 'soil',
      channels: [channel],
      start: '2026-10-01T00:00:00Z',
      end: '2026-10-04T00:00:00Z',
      aggregation: 'hourly',
      maxPointsPerSeries: 2,
    });
    assert.deepEqual(unavailable.availability, {
      available: false,
      reasons: ['point_budget_exceeded', 'select_fewer_sources_or_coarser_aggregation'],
    });
    assert.equal(unavailable.sourceAggregates.length, 1);
    assert.deepEqual(unavailable.sourceAggregates[0].series.swt_1.points, []);

    const emptyAuthorized = await helper.aggregateDeviceData({
      all() {
        throw new Error('authoritative empty source list must not query pooled history');
      },
    }, {
      deveuis: [sourceA],
      sourceDevices: [],
      cardType: 'soil',
      channels: [channel],
      start: '2026-10-01T00:00:00Z',
      end: '2026-10-01T01:00:00Z',
      aggregation: 'hourly',
      logicalSourceKey: 'root-zone',
    });
    assert.deepEqual(emptyAuthorized.availability, {
      available: false,
      reasons: ['no_authorized_sources'],
    });
    assert.deepEqual(emptyAuthorized.sourceAggregates, []);

    const overflow = await helper.aggregateDeviceData({
      all(sql, params, callback) {
        callback(null, Array.from({ length: 30001 }, (_, index) => ({
          id: index + 1,
          deveui: sourceA,
          recorded_at: new Date(Date.parse('2026-10-01T00:00:00Z') + index * 1000).toISOString(),
          swt_1: 1,
        })));
      },
    }, {
      deveuis: [sourceA],
      sourceDevices: [sourceDevices[0]],
      channels: [channel],
      start: '2026-10-01T00:00:00Z',
      end: '2026-10-02T00:00:00Z',
      aggregation: 'raw',
      maxPointsPerSeries: 2000,
    });
    assert.deepEqual(overflow.availability, {
      available: false,
      reasons: ['raw_read_limit_exceeded', 'select_fewer_sources_or_shorter_interval'],
    });
  });

  test(`${profile}: partial source rollups recover older buckets and retain null gaps`, async () => {
    const helper = loadHelper(profile);
    const router = loadRouter(profile);
    const raw = databaseForPartialRollup();
    const devices = [
      { deveui: 'A8404100000000A1', name: 'Synthetic A', type_id: 'KIWI_SENSOR' },
      { deveui: 'A8404100000000B1', name: 'Synthetic B', type_id: 'KIWI_SENSOR' },
    ];
    try {
      const aggregate = await helper.aggregateDeviceData(facade(raw), {
        zoneId: 1,
        cardType: 'soil',
        logicalSourceKey: 'root-zone',
        deveuis: devices.map((device) => device.deveui),
        sourceDevices: devices,
        start: '2026-10-01T00:00:00Z',
        end: '2026-10-03T00:00:00Z',
        aggregation: 'daily',
        useRollups: true,
        nowMs: Date.parse('2026-10-04T00:00:00Z'),
        channels: [{ id: 'swt_1', field: 'swt_1', unit: 'kPa' }],
      });
      const bySource = new Map(aggregate.sourceAggregates.map((entry) => [entry.sourceKey, entry]));
      const sourceA = bySource.get(devices[0].deveui);
      const sourceB = bySource.get(devices[1].deveui);
      assert.deepEqual(sourceA.buckets.map((bucket) => bucket.series.swt_1.latest), [10, 22]);
      assert.deepEqual(sourceB.buckets.map((bucket) => bucket.series.swt_1.latest), [0, null]);
      const series = router.buildSeriesFromAggregate({ cardType: 'soil' }, aggregate, devices);
      assert.equal(series.filter((entry) => entry.deviceSourceId === helper.deviceSourceId(devices[0])).length, 1);
      assert.ok(series.some((entry) => entry.deviceSourceId === helper.deviceSourceId(devices[1]) && entry.points.some((point) => point.quality === 'gap')));
    } finally {
      raw.close();
    }
  });

  test(`${profile}: alternating rollup gaps use one bounded source range`, async () => {
    const helper = loadHelper(profile);
    const database = alternatingRollupDatabase();
    const aggregate = await helper.aggregateDeviceData(database.facade, {
      zoneId: 1,
      cardType: 'soil',
      logicalSourceKey: 'root-zone',
      deveuis: ['A8404100000000A1'],
      sourceDevices: [{ deveui: 'A8404100000000A1', type_id: 'KIWI_SENSOR' }],
      start: database.range.start,
      end: database.range.end,
      aggregation: 'daily',
      useRollups: true,
      nowMs: Date.parse('2026-10-04T00:00:00Z'),
      channels: [{ id: 'swt_1', field: 'swt_1', unit: 'kPa' }],
    });
    assert.equal(database.rawQueryCount(), 1);
    assert.equal(aggregate.sourceAggregates[0].buckets.length, 2000);
    assert.equal(aggregate.availability, undefined);
  });

  test(`${profile}: live-tail raw overflow returns actionable availability`, async () => {
    const helper = loadHelper(profile);
    let rawQuery = 0;
    const aggregate = await helper.aggregateDeviceData({
      all(sql) {
        if (sql.includes('history_channel_rollups')) return [];
        rawQuery += 1;
        if (rawQuery === 1) return [];
        return Array.from({ length: 30001 }, (_, index) => ({
          id: index + 1,
          deveui: 'A8404100000000A1',
          recorded_at: new Date(Date.parse('2026-10-04T00:00:00Z') + index * 1000).toISOString(),
          swt_1: 1,
        }));
      },
    }, {
      zoneId: 1,
      cardType: 'soil',
      logicalSourceKey: 'root-zone',
      deveuis: ['A8404100000000A1'],
      sourceDevices: [{ deveui: 'A8404100000000A1', type_id: 'KIWI_SENSOR' }],
      start: '2026-10-02T00:00:00Z',
      end: '2026-10-05T00:00:00Z',
      aggregation: 'daily',
      useRollups: true,
      nowMs: Date.parse('2026-10-04T12:00:00Z'),
      channels: [{ id: 'swt_1', field: 'swt_1', unit: 'kPa' }],
    });
    assert.deepEqual(aggregate.availability, {
      available: false,
      reasons: ['raw_read_limit_exceeded', 'select_fewer_sources_or_shorter_interval'],
    });
  });

  test(`${profile}: legacy 24h and 48h boundaries stay source isolated`, async () => {
    const helper = loadHelper(profile);
    const raw = databaseForLegacyBoundaries();
    try {
      const exact24 = await helper.legacySensorHistory(facade(raw), {
        deveui: 'A8404100000000A1', field: 'swt_1', hours: 24, nowMs: Date.parse('2026-10-04T12:00:00Z'),
      });
      assert.deepEqual(exact24.map((point) => point.value), [24, 23]);
      const exact48 = await helper.legacySensorHistory(facade(raw), {
        deveui: 'A8404100000000A1', field: 'swt_1', hours: 48, nowMs: Date.parse('2026-10-04T12:00:00Z'),
      });
      assert.deepEqual(exact48.map((point) => point.value), [48, 24, 23]);
      assert.ok(exact48.every((point) => point.value !== 99));
    } finally {
      raw.close();
    }
  });

  test(`${profile}: legacy raw entry rejects the 30001st row`, async () => {
    const helper = loadHelper(profile);
    const oversized = (dendro) => helper.legacySensorHistory({
      all(sql, params, callback) {
        callback(null, Array.from({ length: 30001 }, (_, index) => ({
          id: index + 1,
          recorded_at: new Date(Date.parse(params[params.length - 2]) + index * 1000).toISOString(),
          value: 1,
          ...(dendro ? { dendro_position_mm: 1 } : {}),
        })));
      },
    }, {
      deveui: 'A8404100000000A1', field: 'swt_1', hours: 24, nowMs: Date.parse('2026-10-04T12:00:00Z'),
    });
    const error = await oversized(false).then(() => null, (caught) => caught);
    assert.equal(error.statusCode, 413);
    assert.equal(error.code, 'HISTORY_RAW_LIMIT_EXCEEDED');
    const dendroError = await helper.legacySensorHistory({
      all(sql, params, callback) {
        callback(null, Array.from({ length: 30001 }, (_, index) => ({
          id: index + 1,
          recorded_at: new Date(Date.parse(params[params.length - 2]) + index * 1000).toISOString(),
          dendro_position_mm: 1,
        })));
      },
    }, {
      deveui: 'A8404100000000A1', mode: 'dendro', hours: 24, nowMs: Date.parse('2026-10-04T12:00:00Z'),
    }).then(() => null, (caught) => caught);
    assert.equal(dendroError.statusCode, 413);
    assert.equal(dendroError.code, 'HISTORY_RAW_LIMIT_EXCEEDED');
  });
}
