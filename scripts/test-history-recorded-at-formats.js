#!/usr/bin/env node
'use strict';

// device_data.recorded_at is TEXT. Gateways hold more than one shape in it:
// ISO-8601 UTC with `Z` and milliseconds (toISOString), the uplink's own
// RFC 3339 time with nanoseconds and `+00:00`, the same without a fraction,
// and SQLite's `YYYY-MM-DD HH:MM:SS` (UTC). The history readers must select
// and order rows by the instant, not by the text, so that a table holding
// the same instants in mixed shapes gives exactly the output of a table
// holding them all as toISOString. Both hardware profiles.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { facadeDb } = require('./lib/scoped-access-harness');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = ['full_raspberrypi_bcm27xx_bcm2712', 'full_raspberrypi_bcm27xx_bcm2709'];
const NOW_MS = Date.parse('2025-11-20T12:00:00.000Z');
const DEVEUI = 'A840410000000001';
const FIRST_MS = Date.parse('2025-09-25T00:00:00.000Z');
const STEP_MS = 20 * 60 * 1000;
const STEPS = 41 * 72; // 2025-09-25 .. 2025-11-04, every 20 min

// Every instant is stored in one of these shapes. Each names the same
// millisecond; the nanosecond shape adds 0.5 ms below the millisecond.
const SHAPES = {
  isoZ: (ms) => new Date(ms).toISOString(),
  nanosOffset: (ms) => new Date(ms).toISOString().replace(/Z$/, '500000+00:00'),
  secondsOffset: (ms) => (ms % 1000 === 0 ? new Date(ms).toISOString().replace(/\.000Z$/, '+00:00') : new Date(ms).toISOString()),
  sqliteSpace: (ms) => (ms % 1000 === 0 ? new Date(ms).toISOString().replace('T', ' ').replace(/\.000Z$/, '') : new Date(ms).toISOString()),
  plusTwo: (ms) => new Date(ms + 2 * 3600000).toISOString().replace(/Z$/, '+02:00'),
  minusFive: (ms) => new Date(ms - 5 * 3600000).toISOString().replace(/Z$/, '-05:00'),
};
const SHAPE_NAMES = Object.keys(SHAPES);

function modulesRoot(profile) {
  return path.join(ROOT, 'conf', profile, 'files/usr/share/node-red');
}

// The default series crosses Zurich's autumn DST change and two local
// month starts; SPRING crosses the spring change and 1 April.
const SPRING_FIRST_MS = Date.parse('2026-03-20T00:00:00.000Z');

function instants(firstMs = FIRST_MS) {
  const out = [];
  for (let step = 0; step < STEPS; step += 1) out.push(firstMs + step * STEP_MS);
  return out;
}

// The shape of row `step`: rotates per day, so the rows at local midnight
// and at the local month starts (22:00Z / 23:00Z) take every shape.
function shapeFor(step) {
  return SHAPE_NAMES[(step + Math.floor(step / 72)) % SHAPE_NAMES.length];
}

function seedDb(mode, firstMs = FIRST_MS) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  raw.exec(`
    INSERT INTO users(id, username, password_hash, created_at, updated_at, user_uuid, role, sync_version) VALUES
      (1, 'owner-one', 'h', '2025-09-01', '2025-09-01', 'u-one', 'admin', 1);
    INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, timezone, created_at, updated_at) VALUES
      (12, 'Zurich', 1, 'z-zurich', 'Europe/Zurich', '2025-09-01', '2025-09-01');
    INSERT INTO devices(deveui, name, type_id, user_id, irrigation_zone_id, chameleon_enabled, created_at, updated_at) VALUES
      ('${DEVEUI}', 'Zurich sensor', 'DRAGINO_LSN50', 1, 12, 0, 'x', 'x');
  `);
  const insert = raw.prepare(
    'INSERT INTO device_data(deveui, recorded_at, swt_1, swt_2, dendro_position_mm, rain_mm_delta) VALUES (?, ?, ?, ?, ?, ?)'
  );
  raw.exec('BEGIN');
  instants(firstMs).forEach((ms, step) => {
    const shape = mode === 'iso' ? 'isoZ' : shapeFor(step);
    insert.run(DEVEUI, SHAPES[shape](ms), 10 + (step % 37), 20 + (step % 11), 5 + (step % 13) / 100, step % 5 === 0 ? 0.2 : 0);
  });
  raw.exec('COMMIT');
  return raw;
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

async function withBoth(fn, firstMs = FIRST_MS) {
  const iso = seedDb('iso', firstMs);
  const mixed = seedDb('mixed', firstMs);
  try {
    return { iso: await fn(facadeDb(iso)), mixed: await fn(facadeDb(mixed)) };
  } finally {
    iso.close();
    mixed.close();
  }
}

// Pinned from the builder at 5506e841e (before this change) on the pure
// toISOString table: the change must not move a single byte there.
const PURE_ISO_EXPORT_SHA256 = {
  raw: 'e4d2cd16b01317fd686c6aa9a9eaa63b23ef08090223082e2ce94514973d42ed',
  hourly: '4543e19f58d8df6b090d04e8ad4d02e8d09cc60c9885b6c416da00b3dadbfbc0',
  daily: 'bd72fec0f19bb32689586919f1c3a80f6e2e8fc79eb8ce367456f822c0d2c840',
};

test('the mixed table really mixes shapes at the boundaries it is meant to test', () => {
  const zurichMonthStarts = [Date.parse('2025-09-30T22:00:00.000Z'), Date.parse('2025-10-31T23:00:00.000Z')];
  const shapes = zurichMonthStarts.map((ms) => shapeFor((ms - FIRST_MS) / STEP_MS));
  assert.ok(shapes.every((shape) => shape !== 'isoZ'), `month starts stored as ${shapes}`);
  const midnightShapes = new Set();
  for (let day = 0; day < 41; day += 1) midnightShapes.add(shapeFor(day * 72 + 66)); // 22:00Z
  assert.equal(midnightShapes.size, SHAPE_NAMES.length);
});

for (const profile of PROFILES) {
  const helper = require(path.join(modulesRoot(profile), 'osi-history-helper'));
  const label = profile.replace('full_raspberrypi_bcm27xx_', '');

  for (const granularity of ['raw', 'hourly', 'daily']) {
    test(`${label}: ${granularity} zone export of mixed shapes equals the pure ISO export`, async () => {
      const run = (db) => helper.buildZoneExportCsv(db, {
        zoneId: 12, from: '2025-09-26', to: '2025-11-03', granularity, channels: 'swt_1,swt_2', nowMs: NOW_MS,
      });
      const { iso, mixed } = await withBoth(run);
      assert.ok(iso.rows.length > 0);
      assert.equal(mixed.rows.length, iso.rows.length, 'row count');
      assert.deepEqual(mixed.rows, iso.rows);
      if (granularity === 'raw') {
        // 2025-09-26 .. 2025-11-03 in Zurich, both channels, no row lost or doubled.
        const startMs = Date.parse('2025-09-25T22:00:00.000Z');
        const endMs = Date.parse('2025-11-03T23:00:00.000Z');
        const expected = instants().filter((ms) => ms >= startMs && ms < endMs).length;
        assert.equal(mixed.rows.filter((row) => row.channel_key === 'swt_1').length, expected);
        assert.ok(mixed.rows.every((row) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.timestamp)),
          'raw timestamps are ISO UTC');
      }
    });

    test(`${label}: ${granularity} all-zones export of a pure ISO table is byte-identical to the builder before this change`, async () => {
      const raw = seedDb('iso');
      try {
        const result = await helper.buildAllZonesExportCsv(facadeDb(raw), {
          zoneIds: [12], from: '2025-09-26', to: '2025-11-03', granularity, site: '0016C001F1000001', nowMs: NOW_MS,
        });
        assert.equal(sha256(result.csv), PURE_ISO_EXPORT_SHA256[granularity]);
      } finally {
        raw.close();
      }
    });
  }

  test(`${label}: hourly and daily exports across the spring DST change and 1 April equal the pure ISO exports`, async () => {
    for (const granularity of ['hourly', 'daily']) {
      const { iso, mixed } = await withBoth((db) => helper.buildZoneExportCsv(db, {
        zoneId: 12, from: '2026-03-21', to: '2026-04-28', granularity, channels: 'swt_1', nowMs: Date.parse('2026-06-01T00:00:00.000Z'),
      }), SPRING_FIRST_MS);
      assert.ok(iso.rows.length > 0, granularity);
      assert.deepEqual(mixed.rows, iso.rows, granularity);
    }
  });

  test(`${label}: monthly export windows keep every mixed-shape row once (sample counts equal the whole-range reference)`, async () => {
    const channel = { id: 'swt_1', field: 'swt_1', unit: 'kPa' };
    const startIso = '2025-09-25T22:00:00.000Z';
    const endIso = '2025-11-03T23:00:00.000Z';
    const { iso, mixed } = await withBoth((db) => helper.aggregateDeviceData(db, {
      device_euis: [DEVEUI], sourceFilterActive: true, aggregation: 'hourly', channels: [channel],
      start: startIso, end: endIso, timezone: 'Europe/Zurich', nowMs: NOW_MS,
    }));
    const count = (result) => result.buckets.reduce((sum, bucket) => sum + bucket.series.swt_1.sampleCount, 0);
    const expected = instants().filter((ms) => ms >= Date.parse(startIso) && ms < Date.parse(endIso)).length;
    assert.equal(count(iso), expected);
    assert.equal(count(mixed), expected);
    assert.deepEqual(mixed.buckets, iso.buckets);
  });

  test(`${label}: rows exactly on the month start belong to the new month, once`, async () => {
    // One row per shape, each exactly at Zurich's 1 November local midnight.
    const boundaryMs = Date.parse('2025-10-31T23:00:00.000Z');
    const raw = seedDb('iso');
    try {
      raw.exec(`DELETE FROM device_data`);
      const insert = raw.prepare('INSERT INTO device_data(deveui, recorded_at, swt_1) VALUES (?, ?, ?)');
      SHAPE_NAMES.forEach((name, index) => insert.run(DEVEUI, SHAPES[name](boundaryMs), 40 + index));
      insert.run(DEVEUI, SHAPES.isoZ(boundaryMs - 1), 30);
      // Below the millisecond: SQLite rounds these, Date.parse truncates;
      // the row stays in the month its truncated instant names.
      insert.run(DEVEUI, '2025-10-31T22:59:59.999600000+00:00', 32);
      insert.run(DEVEUI, '2025-10-31T23:00:00.000600000+00:00', 46);
      const result = await helper.buildZoneExportCsv(facadeDb(raw), {
        zoneId: 12, from: '2025-10-31', to: '2025-11-01', granularity: 'daily', channels: 'swt_1', nowMs: NOW_MS,
      });
      const swt1 = result.rows.filter((row) => row.channel_key === 'swt_1');
      assert.deepEqual(swt1.map((row) => [row.timestamp, row.value]), [
        ['2025-10-30T23:00:00.000Z', 31], // mean of 30 and 32
        ['2025-10-31T23:00:00.000Z', 43], // mean of 40..46: all seven rows
      ]);
    } finally {
      raw.close();
    }
  });

  test(`${label}: raw sensor and dendrometer series of mixed shapes equal the pure ISO series`, async () => {
    // 24 h ending inside Zurich's 1 November (a month start inside the range).
    const nowMs = Date.parse('2025-11-01T10:00:00.000Z');
    const sensor = await withBoth((db) => helper.legacySensorHistory(db, { deveui: DEVEUI, field: 'swt_1', hours: 24, nowMs }));
    assert.equal(sensor.iso.length, 72);
    assert.deepEqual(sensor.mixed, sensor.iso);
    const dendro = await withBoth((db) => helper.legacySensorHistory(db, { deveui: DEVEUI, mode: 'dendro', hours: 24, nowMs }));
    assert.equal(dendro.iso.length, 72);
    assert.deepEqual(dendro.mixed, dendro.iso);
  });

  test(`${label}: daily rain totals of mixed shapes equal the pure ISO totals`, async () => {
    const nowMs = Date.parse('2025-11-04T23:59:00.000Z');
    const rain = await withBoth((db) => helper.legacyRainDailyHistory(db, { deveui: DEVEUI, days: 40, tzOffsetMin: 60, nowMs }));
    assert.ok(rain.iso.length >= 39);
    assert.deepEqual(rain.mixed, rain.iso);
  });

  test(`${label}: data view series of mixed shapes equal the pure ISO series`, async () => {
    const run = async (db) => {
      const catalog = await helper.buildAnalysisCatalog(db, { userId: 1, deviceEui: '0016C001F1000001', weatherProviderDefault: 'open_meteo' });
      const selectors = catalog.channels
        .filter((entry) => entry.sourceKind === 'device' && entry.zoneId === 12)
        .map((entry) => ({ seriesId: entry.seriesId }));
      const out = {};
      for (const aggregation of ['raw', 'hourly', 'daily']) {
        out[aggregation] = await helper.resolveAnalysisSeries(db, {
          userId: 1, deviceEui: '0016C001F1000001', weatherProviderDefault: 'open_meteo', selectors,
          range: { from: '2025-10-30T23:00:00.000Z', to: '2025-11-02T23:00:00.000Z' }, aggregation,
        });
      }
      return out;
    };
    const { iso, mixed } = await withBoth(run);
    // Source-first discovery retains the finite historical LSN50 candidates,
    // so a configuration-only fixture resolves more than the two channels
    // that older history-card discovery returned.
    assert.ok(iso.raw.series.length > 2);
    assert.equal(iso.raw.series[0].points.length, 3 * 72);
    assert.deepEqual(mixed, iso);
  });

  test(`${label}: rollup buckets of mixed shapes equal the pure ISO buckets`, async () => {
    const scope = {
      zoneId: 12, cardType: 'soil', logicalSourceKey: 'soil:test', timezone: 'Europe/Zurich',
      deveuis: [DEVEUI], channels: [{ id: 'swt_1', field: 'swt_1', unit: 'kPa' }],
    };
    for (const level of ['hourly', 'daily']) {
      const nowMs = Date.parse('2025-11-02T09:00:00.000Z');
      const out = await withBoth((db) => helper.computeRollupBuckets(db, scope, level, 3 * 86400000, nowMs));
      assert.ok(out.iso.length > 0, level);
      assert.deepEqual(out.mixed, out.iso, level);
    }
  });
}
