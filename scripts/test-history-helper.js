'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const helperPath = path.join(
  repoRoot,
  'conf',
  'full_raspberrypi_bcm27xx_bcm2712',
  'files',
  'usr',
  'share',
  'node-red',
  'osi-history-helper'
);

const helper = require(helperPath);

const expectedExports = [
  'normalizeDeveui',
  'deriveCardId',
  'deriveCardsForZone',
  'deriveGatewayCard',
  'resolveAggregation',
  'classifySoilStatus',
  'classifySoilDay',
  'classifyEnvironmentStatus',
  'classifyDendroStatus',
  'classifyIrrigationStatus',
  'classifyGatewayStatus',
  'deriveExpectedCadenceSeconds',
  'startOfLocalDayMs',
  'computeRollupBuckets',
  'upsertRollups',
  'runRollupJob',
  'resolveDeviceFieldRollupKey',
  'toCsv',
  'writeZoneCsv',
  'rotateZoneCsv',
  'aggregateRows',
  'aggregateDeviceData',
  'buildAdvancedMetadataPlaceholder',
  'buildAdvancedDiagnostics',
  'buildCalendar',
  'buildLocalInterpretations',
];

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`OK ${name}`))
    .catch((error) => {
      console.error(`FAIL ${name}`);
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
    });
}

function iso(minutes) {
  return new Date(Date.UTC(2026, 4, 31, 0, minutes, 0)).toISOString();
}

function isoDay(day) {
  return new Date(Date.UTC(2026, 4, 31 + day, 0, 0, 0)).toISOString();
}

function sqliteEscape(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createCliSqliteDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-history-helper-'));
  const dbPath = path.join(dir, 'history-helper.sqlite');
  const schema = fs.readFileSync(path.join(repoRoot, 'database', 'seed-blank.sql'), 'utf8');
  execFileSync('sqlite3', [dbPath], { input: schema });

  const db = {
    path: dbPath,
    lastQuery: null,
    runSql(sql) {
      execFileSync('sqlite3', [dbPath], { input: sql });
    },
    all(sql, params, cb) {
      db.lastQuery = { sql, params: Array.isArray(params) ? params.slice() : [] };
      let index = 0;
      const rendered = sql.replace(/\?/g, () => sqliteEscape(db.lastQuery.params[index++]));
      try {
        const output = execFileSync('sqlite3', ['-json', dbPath, rendered], { encoding: 'utf8' }).trim();
        cb(null, output ? JSON.parse(output) : []);
      } catch (error) {
        cb(error);
      }
    },
    run(sql, params, cb) {
      db.lastQuery = { sql, params: Array.isArray(params) ? params.slice() : [] };
      let index = 0;
      const rendered = sql.replace(/\?/g, () => sqliteEscape(db.lastQuery.params[index++]));
      try {
        execFileSync('sqlite3', [dbPath], { input: rendered });
        cb(null);
      } catch (error) {
        cb(error);
      }
    },
    close() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return db;
}

test('exports the history helper contract', () => {
  for (const name of expectedExports) {
    assert.strictEqual(typeof helper[name], 'function', `${name} export`);
  }
});

test('classifySoilStatus uses 22/50 kPa thresholds', () => {
  assert.strictEqual(helper.classifySoilStatus({ value: 10 }).status, 'wet_excess');
  assert.strictEqual(helper.classifySoilStatus({ value: 22 }).status, 'optimal');
  assert.strictEqual(helper.classifySoilStatus({ value: 35 }).status, 'optimal');
  assert.strictEqual(helper.classifySoilStatus({ value: 50 }).status, 'optimal');
  assert.strictEqual(helper.classifySoilStatus({ value: 51 }).status, 'dry_stress');
});

test('classifySoilDay averages tension values and never returns mixed', () => {
  assert.strictEqual(helper.classifySoilDay([{ value: 10 }, { value: 60 }]), 'optimal');
  assert.strictEqual(helper.classifySoilDay([{ value: 5 }, { value: 15 }]), 'wet_excess');
  assert.strictEqual(helper.classifySoilDay([{ value: 80 }, { value: 60 }]), 'dry_stress');
  assert.strictEqual(helper.classifySoilDay([]), 'no_data');
});

test('derives stable card identifiers without exposing raw dendro DevEUI', () => {
  assert.strictEqual(helper.normalizeDeveui('aa-bb cc:dd:ee:ff:00:11'), 'AABBCCDDEEFF0011');
  assert.strictEqual(helper.normalizeDeveui('not-a-deveui'), null);

  assert.strictEqual(
    helper.deriveCardId({ zoneUuid: 'zone-uuid', cardType: 'soil' }),
    'zone-uuid:soil:root-zone'
  );
  assert.strictEqual(
    helper.deriveCardId({ zoneUuid: 'zone-uuid', cardType: 'environment' }),
    'zone-uuid:environment:microclimate'
  );
  assert.strictEqual(
    helper.deriveCardId({ zoneUuid: 'zone-uuid', cardType: 'irrigation' }),
    'zone-uuid:irrigation:zone-valves'
  );

  const normalized = 'AABBCCDDEEFF0011';
  const dendroSource = `dendro-src-${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
  const dendroCardId = helper.deriveCardId({
    zoneUuid: 'zone-uuid',
    cardType: 'dendro',
    deveui: 'aa:bb:cc:dd:ee:ff:00:11',
  });
  assert.strictEqual(dendroCardId, `zone-uuid:dendro:${dendroSource}`);
  assert(!dendroCardId.includes(normalized), 'dendro card id must not include raw DevEUI');

  const cards = helper.deriveCardsForZone(
    { id: 7, zone_uuid: 'zone-uuid' },
    [
      { deveui: 'AA00000000000001', type_id: 'KIWI_SENSOR', irrigation_zone_id: 7, swt_1: 30, ambient_temperature: 22 },
      { deveui: 'AA00000000000002', type_id: 'DRAGINO_LSN50', irrigation_zone_id: 7, dendro_enabled: 1 },
      { deveui: 'AA00000000000003', type_id: 'STREGA_VALVE', irrigation_zone_id: 7 },
      { deveui: 'AA00000000000004', type_id: 'KIWI_SENSOR', irrigation_zone_id: null, swt_1: 90 },
      { deveui: 'AA00000000000005', type_id: 'SENSECAP_S2120', irrigation_zone_id: 99, ambient_temperature: 35 },
    ]
  );
  assert.deepStrictEqual(cards.map((card) => card.cardType).sort(), ['dendro', 'environment', 'irrigation', 'soil']);
  assert(cards.some((card) => card.id === 'zone-uuid:soil:root-zone'));
  assert(cards.some((card) => card.id === 'zone-uuid:environment:microclimate'));
  assert(cards.some((card) => card.id === 'zone-uuid:irrigation:zone-valves'));

  const dendroCards = helper.deriveCardsForZone(
    { id: 7, zone_uuid: 'zone-uuid' },
    [
      { deveui: 'AA00000000000009', type_id: 'DRAGINO_LSN50', irrigation_zone_id: 7, dendro_enabled: 1 },
      { deveui: 'AA00000000000002', type_id: 'DRAGINO_LSN50', irrigation_zone_id: 7, dendro_enabled: 1 },
    ]
  ).filter((card) => card.cardType === 'dendro');
  const reversedDendroCards = helper.deriveCardsForZone(
    { id: 7, zone_uuid: 'zone-uuid' },
    [
      { deveui: 'AA00000000000002', type_id: 'DRAGINO_LSN50', irrigation_zone_id: 7, dendro_enabled: 1 },
      { deveui: 'AA00000000000009', type_id: 'DRAGINO_LSN50', irrigation_zone_id: 7, dendro_enabled: 1 },
    ]
  ).filter((card) => card.cardType === 'dendro');
  assert.deepStrictEqual(dendroCards.map((card) => card.id), reversedDendroCards.map((card) => card.id));
});

test('derives the hub-scoped gateway card id', () => {
  const gateway = helper.deriveGatewayCard('aa-bb-cc-dd-ee-ff-00-11');
  assert.strictEqual(gateway.id, 'AABBCCDDEEFF0011:gateway:hub');
  assert.strictEqual(gateway.cardType, 'gateway');
  assert.strictEqual(gateway.logicalSourceKey, 'hub');
});

test('derives display-safe source keys for merged soil and environment cards', () => {
  const cards = helper.deriveCardsForZone(
    { id: 7, zone_uuid: 'zone-uuid' },
    [
      {
        deveui: 'A84041A75D5E7CFB',
        type_id: 'DRAGINO_LSN50',
        name: 'Chameleon 1',
        irrigation_zone_id: 7,
        chameleon_enabled: 1,
        temp_enabled: 1,
      },
      {
        deveui: 'A84041CE3F5ECF52',
        type_id: 'DRAGINO_LSN50',
        name: 'Chameleon 2',
        irrigation_zone_id: 7,
        chameleon_enabled: 1,
        temp_enabled: 1,
      },
    ]
  );

  const soilCard = cards.find((card) => card.cardType === 'soil');
  const environmentCard = cards.find((card) => card.cardType === 'environment');
  assert(soilCard, 'soil card');
  assert(environmentCard, 'environment card');
  assert.deepStrictEqual(soilCard.sourceDevices.map((device) => device.name), ['Chameleon 1', 'Chameleon 2']);
  assert.deepStrictEqual(environmentCard.sourceDevices.map((device) => device.name), ['Chameleon 1', 'Chameleon 2']);
  for (const device of soilCard.sourceDevices.concat(environmentCard.sourceDevices)) {
    assert.match(device.sourceKey, /^(soil|environment)-src-[0-9a-f]{12}$/);
    assert(!device.sourceKey.includes('A84041A75D5E7CFB'));
    assert(!device.sourceKey.includes('A84041CE3F5ECF52'));
  }
});

test('repair script backfills current season only for zones without an active/default season', () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id, username, password_hash, created_at, user_uuid)
      VALUES (1, 'tester', 'x', '2026-01-01T00:00:00Z', 'user-uuid');
      INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, timezone)
      VALUES
        (11, 'No Season Zone', 1, 'zone-no-season', 'Europe/Zurich'),
        (12, 'Existing Season Zone', 1, 'zone-existing-season', 'Europe/Zurich');
      INSERT INTO zone_seasons(zone_id, name, starts_on, ends_on, is_active, is_default)
      VALUES (12, 'Custom season', '2026-03-01', '2026-09-30', 1, 1);
    `);

    execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'repair-pi-schema.js'), db.path], {
      encoding: 'utf8',
    });

    const output = execFileSync('sqlite3', [
      '-json',
      db.path,
      `SELECT zone_id, name, starts_on, ends_on, is_active, is_default
       FROM zone_seasons
       ORDER BY zone_id, id`,
    ], { encoding: 'utf8' }).trim();
    const seasons = JSON.parse(output);
    const currentYear = new Date().getUTCFullYear();
    assert.deepStrictEqual(seasons, [
      {
        zone_id: 11,
        name: 'Current season',
        starts_on: `${currentYear}-01-01`,
        ends_on: `${currentYear}-12-31`,
        is_active: 1,
        is_default: 1,
      },
      {
        zone_id: 12,
        name: 'Custom season',
        starts_on: '2026-03-01',
        ends_on: '2026-09-30',
        is_active: 1,
        is_default: 1,
      },
    ]);
  } finally {
    db.close();
  }
});

test('repair script does not let inactive default seasons keep Season disabled', () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id, username, password_hash, created_at, user_uuid)
      VALUES (1, 'tester', 'x', '2026-01-01T00:00:00Z', 'user-uuid');
      INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, timezone)
      VALUES (21, 'Inactive Default Zone', 1, 'zone-inactive-default', 'Europe/Zurich');
      INSERT INTO zone_seasons(zone_id, name, starts_on, ends_on, is_active, is_default)
      VALUES (21, 'Old inactive season', '2025-03-01', '2025-09-30', 0, 1);
    `);

    execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'repair-pi-schema.js'), db.path], {
      encoding: 'utf8',
    });

    const output = execFileSync('sqlite3', [
      '-json',
      db.path,
      `SELECT name, is_active, is_default
       FROM zone_seasons
       WHERE zone_id = 21
       ORDER BY id`,
    ], { encoding: 'utf8' }).trim();
    const seasons = JSON.parse(output);
    assert.deepStrictEqual(seasons, [
      { name: 'Old inactive season', is_active: 0, is_default: 1 },
      { name: 'Current season', is_active: 1, is_default: 0 },
    ]);
  } finally {
    db.close();
  }
});

test('classifies soil, environment, and dendro status with shared thresholds', () => {
  assert.strictEqual(helper.classifySoilStatus({ swtKpa: 9 }).status, 'wet_excess');
  assert.strictEqual(helper.classifySoilStatus({ swtKpa: 35 }).status, 'optimal');
  assert.strictEqual(helper.classifySoilStatus({ swtKpa: 88 }).status, 'dry_stress');
  assert.strictEqual(helper.classifySoilStatus({ swtKpa: null }).status, 'no_data');

  assert.strictEqual(helper.classifyEnvironmentStatus({ ambientTemperature: 36, relativeHumidity: 45 }).status, 'heat_stress');
  assert.strictEqual(helper.classifyEnvironmentStatus({ ambientTemperature: 4, relativeHumidity: 45 }).status, 'cold_stress');
  assert.strictEqual(helper.classifyEnvironmentStatus({ ambientTemperature: 20, relativeHumidity: 93 }).status, 'high_humidity');
  assert.strictEqual(helper.classifyEnvironmentStatus({ rainMm: 3 }).status, 'rain_day');

  assert.strictEqual(helper.classifyDendroStatus({ recoveryRatio: 0.32 }).status, 'incomplete_night_recovery');
  assert.strictEqual(helper.classifyDendroStatus({ mdsUm: 460, recoveryRatio: 0.8 }).status, 'high_shrinkage_stress');
  assert.strictEqual(helper.classifyDendroStatus({ growthUm: 40, recoveryRatio: 0.8 }).status, 'normal_growth');
});

test('classifies irrigation and gateway status deterministically', () => {
  assert.strictEqual(helper.classifyIrrigationStatus({ eventCount: 0 }).status, 'no_irrigation');
  assert.strictEqual(helper.classifyIrrigationStatus({ eventCount: 1 }).status, 'irrigation_event');
  assert.strictEqual(helper.classifyIrrigationStatus({ eventCount: 4 }).status, 'high_irrigation_frequency');
  assert.strictEqual(helper.classifyIrrigationStatus({ possibleIneffectiveIrrigation: true }).status, 'possible_ineffective_irrigation');
  assert.strictEqual(helper.classifyIrrigationStatus({ manualOverride: true }).status, 'manual_override');

  assert.strictEqual(helper.classifyGatewayStatus({ generatedAt: iso(60) }).status, 'no_data');
  assert.strictEqual(helper.classifyGatewayStatus({ lastSeenAt: iso(55), generatedAt: iso(60), offlineAfterSeconds: 600 }).status, 'normal');
  assert.strictEqual(helper.classifyGatewayStatus({ lastSeenAt: iso(0), generatedAt: iso(60), offlineAfterSeconds: 600 }).status, 'offline');
});

test('derives expected cadence as configured, derived, or unknown', () => {
  assert.deepStrictEqual(
    helper.deriveExpectedCadenceSeconds({ configuredCadenceSeconds: 900 }),
    { seconds: 900, confidence: 'configured' }
  );

  assert.deepStrictEqual(
    helper.deriveExpectedCadenceSeconds({
      rows: [{ recorded_at: iso(0) }, { recorded_at: iso(30) }, { recorded_at: iso(60) }, { recorded_at: iso(90) }],
    }),
    { seconds: 1800, confidence: 'derived' }
  );

  const shiftedRows = [];
  for (let minutes = 0; minutes < 23 * 24 * 60; minutes += 60) {
    shiftedRows.push({ recorded_at: iso(minutes) });
  }
  for (let minutes = 23 * 24 * 60; minutes <= 30 * 24 * 60; minutes += 24 * 60) {
    shiftedRows.push({ recorded_at: iso(minutes) });
  }
  assert.deepStrictEqual(
    helper.deriveExpectedCadenceSeconds({
      rows: shiftedRows,
      end: iso(30 * 24 * 60),
    }),
    { seconds: 86400, confidence: 'derived' }
  );

  assert.deepStrictEqual(
    helper.deriveExpectedCadenceSeconds({ rows: [{ recorded_at: iso(0) }] }),
    { seconds: null, confidence: 'unknown' }
  );
});

test('startOfLocalDayMs returns the UTC instant of zone-local midnight', () => {
  const ms = helper.startOfLocalDayMs(Date.parse('2026-06-02T10:00:00Z'), 'Europe/Zurich');
  assert.strictEqual(new Date(ms).toISOString(), '2026-06-01T22:00:00.000Z');

  const utc = helper.startOfLocalDayMs(Date.parse('2026-06-02T10:00:00Z'), 'UTC');
  assert.strictEqual(new Date(utc).toISOString(), '2026-06-02T00:00:00.000Z');
});

test('resolves automatic aggregation from range and reports the actual level', () => {
  assert.deepStrictEqual(
    helper.resolveAggregation({ aggregation: 'auto', range: '12h' }),
    { requested: 'auto', level: 'raw', bucketSizeSeconds: null }
  );
  assert.deepStrictEqual(
    helper.resolveAggregation({ range: '7d', cardType: 'soil' }),
    { requested: 'auto', level: 'hourly', bucketSizeSeconds: 3600 }
  );
  assert.deepStrictEqual(
    helper.resolveAggregation({ aggregation: 'auto', range: '30d', cardType: 'environment' }),
    { requested: 'auto', level: 'daily', bucketSizeSeconds: 86400 }
  );
  assert.deepStrictEqual(
    helper.resolveAggregation({ aggregation: 'auto', range: 'season', start: isoDay(0), end: isoDay(160) }),
    { requested: 'auto', level: 'weekly', bucketSizeSeconds: 604800 }
  );
  assert.deepStrictEqual(
    helper.resolveAggregation({ aggregation: '15m', range: '7d' }),
    { requested: '15m', level: '15m', bucketSizeSeconds: 900 }
  );
});

test('aggregates rows into raw, 15m, hourly, daily, and weekly buckets', () => {
  const rows = [
    { recorded_at: iso(0), swt_1: 10 },
    { recorded_at: iso(15), swt_1: 20 },
    { recorded_at: iso(30), swt_1: 40 },
    { recorded_at: iso(75), swt_1: 80 },
  ];
  const base = {
    channels: [{ id: 'swt_1', field: 'swt_1', unit: 'kPa' }],
    start: iso(0),
    end: iso(120),
    expectedCadenceSeconds: 900,
  };

  const raw = helper.aggregateRows(rows, { ...base, aggregation: 'raw', expectedCadenceSeconds: null });
  assert.strictEqual(raw.aggregation, 'raw');
  assert.strictEqual(raw.coveragePct, null);
  assert.strictEqual(raw.coverageConfidence, 'unknown');
  assert.strictEqual(raw.series.swt_1.points.length, 4);

  const hourly = helper.aggregateRows(rows, { ...base, aggregation: 'hourly' });
  assert.strictEqual(hourly.coverageConfidence, 'configured');
  assert.strictEqual(hourly.buckets.length, 2);
  assert.strictEqual(hourly.buckets[0].series.swt_1.min, 10);
  assert.strictEqual(hourly.buckets[0].series.swt_1.max, 40);
  assert.strictEqual(hourly.buckets[0].series.swt_1.mean, 23.333);
  assert.strictEqual(hourly.buckets[0].series.swt_1.median, 20);
  assert.strictEqual(hourly.buckets[0].series.swt_1.latest, 40);
  assert.strictEqual(hourly.buckets[0].coveragePct, 75);

  const derived = helper.aggregateRows(rows, { ...base, aggregation: '15m', expectedCadenceSeconds: null });
  assert.strictEqual(derived.coverageConfidence, 'derived');
  assert.strictEqual(derived.expectedCadenceSeconds, 900);

  for (const aggregation of ['15m', 'daily', 'weekly']) {
    const result = helper.aggregateRows(rows, { ...base, aggregation });
    assert.strictEqual(result.aggregation, aggregation);
    assert(result.buckets.length >= 1, `${aggregation} bucket output`);
  }

  const automatic = helper.aggregateRows(rows, { ...base, aggregation: 'auto', range: '7d' });
  assert.strictEqual(automatic.aggregation, 'hourly');
  assert.strictEqual(automatic.aggregationRequested, 'auto');

  const omitted = helper.aggregateRows(rows, { ...base, range: '7d' });
  assert.strictEqual(omitted.aggregation, 'hourly');
  assert.strictEqual(omitted.aggregationRequested, 'auto');
});

test('computeRollupBuckets returns completed buckets for a scope/level', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(7,'Z',1,'zu','UTC','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at) VALUES('AA00000000000001','Soil','KIWI_SENSOR',1,7,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES
        ('AA00000000000001','2026-06-01T08:10:00.000Z',10),
        ('AA00000000000001','2026-06-01T08:40:00.000Z',20);
    `);
    const scope = {
      zoneId: 7,
      cardType: 'soil',
      logicalSourceKey: 'root-zone',
      channels: [{ id: 'swt_1', field: 'swt_1', unit: 'kPa' }],
      deveuis: ['AA00000000000001'],
      timezone: 'UTC',
    };
    const nowMs = Date.parse('2026-06-02T00:00:00.000Z');
    const rows = await helper.computeRollupBuckets(db, scope, 'hourly', 24 * 3600 * 1000, nowMs);
    const hour = rows.find((row) => row.channel_id === 'swt_1' && row.bucket_start === '2026-06-01T08:00:00.000Z');
    assert.ok(hour, 'has the 08:00 bucket');
    assert.strictEqual(hour.mean_value, 15);
    assert.strictEqual(hour.bucket_level, 'hourly');
    assert.ok(rows.every((row) => row.bucket_end <= new Date(helper.startOfLocalDayMs(nowMs, 'UTC')).toISOString()));
  } finally {
    db.close();
  }
});

test('upsertRollups is idempotent on the unique bucket key', async () => {
  const db = createCliSqliteDb();
  try {
    const base = {
      zone_id: 7,
      card_type: 'soil',
      logical_source_key: 'root-zone',
      channel_id: 'swt_1',
      bucket_level: 'hourly',
      bucket_start: '2026-06-01T08:00:00.000Z',
      bucket_end: '2026-06-01T09:00:00.000Z',
      min_value: 10,
      max_value: 20,
      mean_value: 15,
      median_value: 15,
      latest_value: 20,
      dominant_status: null,
      coverage_pct: 100,
      coverage_confidence: 'derived',
      sample_count: 2,
      event_count: 0,
      threshold_crossing_count: 0,
      unit: 'kPa',
    };
    await helper.upsertRollups(db, [base]);
    await helper.upsertRollups(db, [{ ...base, mean_value: 16, sample_count: 3 }]);
    const rows = await new Promise((resolve, reject) => {
      db.all('SELECT mean_value, sample_count FROM history_channel_rollups', [], (error, result) => error ? reject(error) : resolve(result));
    });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].mean_value, 16);
    assert.strictEqual(rows[0].sample_count, 3);
  } finally {
    db.close();
  }
});

test('runRollupJob populates hourly and daily rollups for a zone', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(7,'Z',1,'zu','UTC','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at) VALUES('AA00000000000001','Soil','KIWI_SENSOR',1,7,'2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
    `);
    let sql = '';
    for (let day = 1; day <= 2; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const timestamp = `2026-06-0${day}T${String(hour).padStart(2, '0')}:30:00.000Z`;
        sql += `INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES('AA00000000000001','${timestamp}',${10 + hour});\n`;
      }
    }
    db.runSql(sql);

    const summary = await helper.runRollupJob(db, { nowMs: Date.parse('2026-06-03T02:00:00.000Z'), exportDir: null });
    assert.ok(summary.bucketsUpserted > 0);
    const daily = await new Promise((resolve, reject) => {
      db.all("SELECT * FROM history_channel_rollups WHERE bucket_level='daily'", [], (error, rows) => error ? reject(error) : resolve(rows));
    });
    assert.ok(daily.length >= 2, 'has daily buckets for the two days');
    const hourly = await new Promise((resolve, reject) => {
      db.all("SELECT * FROM history_channel_rollups WHERE bucket_level='hourly'", [], (error, rows) => error ? reject(error) : resolve(rows));
    });
    assert.ok(hourly.length >= 24);
  } finally {
    db.close();
  }
});

test('writeZoneCsv emits tidy long-format raw and daily files with depth', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-csv-'));
  try {
    const zone = { id: 7, name: 'Zone B', zone_uuid: 'zu', timezone: 'Europe/Zurich' };
    const rawRows = [
      {
        timestamp: '2026-06-02T14:03:21.000Z',
        source: 'Chameleon 1',
        card: 'soil',
        variable: 'swt_1',
        depth_cm: 5,
        value: 6.24,
        unit: 'kPa',
      },
    ];
    const dailyRows = [
      {
        bucket_start: '2026-06-02T00:00:00.000Z',
        bucket_end: '2026-06-03T00:00:00.000Z',
        source: 'Chameleon 1',
        card: 'soil',
        variable: 'swt_1',
        depth_cm: 5,
        unit: 'kPa',
        n: 96,
        coverage_pct: 100,
        mean: 6.3,
        min: 6.1,
        max: 6.5,
        median: 6.3,
        latest: 6.24,
      },
    ];

    await helper.writeZoneCsv({ exportDir: dir, zone, day: '2026-06-02', rawRows, dailyRows });
    const raw = fs.readFileSync(path.join(dir, 'zu', 'raw', '2026-06-02.csv'), 'utf8').trim().split('\n');
    assert.strictEqual(raw[0], 'timestamp,timezone,zone,card,source,variable,depth_cm,value,unit');
    assert.match(raw[1], /Europe\/Zurich,Zone B,soil,Chameleon 1,swt_1,5,6.24,kPa/);
    const daily = fs.readFileSync(path.join(dir, 'zu', 'daily.csv'), 'utf8').trim().split('\n');
    assert.strictEqual(daily[0], 'bucket_start,bucket_end,timezone,zone,card,source,variable,depth_cm,unit,n,coverage_pct,mean,min,max,median,latest');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rotateZoneCsv removes old raw and hourly files but keeps daily.csv', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-csv-rotate-'));
  try {
    const zone = { id: 7, name: 'Zone B', zone_uuid: 'zu', timezone: 'UTC' };
    const rawDir = path.join(dir, 'zu', 'raw');
    const hourlyDir = path.join(dir, 'zu', 'hourly');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.mkdirSync(hourlyDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, '2026-02-01.csv'), 'old\n');
    fs.writeFileSync(path.join(rawDir, '2026-06-01.csv'), 'new\n');
    fs.writeFileSync(path.join(hourlyDir, '2026-02-01.csv'), 'old\n');
    fs.writeFileSync(path.join(hourlyDir, '2026-06-01.csv'), 'new\n');
    fs.writeFileSync(path.join(dir, 'zu', 'daily.csv'), 'daily\n');

    await helper.rotateZoneCsv({ exportDir: dir, zone, nowMs: Date.parse('2026-06-02T00:00:00.000Z'), retentionDays: 90 });
    assert.strictEqual(fs.existsSync(path.join(rawDir, '2026-02-01.csv')), false);
    assert.strictEqual(fs.existsSync(path.join(hourlyDir, '2026-02-01.csv')), false);
    assert.strictEqual(fs.existsSync(path.join(rawDir, '2026-06-01.csv')), true);
    assert.strictEqual(fs.existsSync(path.join(hourlyDir, '2026-06-01.csv')), true);
    assert.strictEqual(fs.existsSync(path.join(dir, 'zu', 'daily.csv')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runRollupJob writes per-source CSV exports for the completed local day', async () => {
  const db = createCliSqliteDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-csv-job-'));
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(7,'Zone B',1,'zu','UTC','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,chameleon_enabled,chameleon_swt1_depth_cm,created_at,updated_at)
        VALUES('AA00000000000001','Chameleon 1','DRAGINO_LSN50',1,7,1,5,'2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES
        ('AA00000000000001','2026-06-02T08:10:00.000Z',10),
        ('AA00000000000001','2026-06-02T08:40:00.000Z',20);
    `);

    const summary = await helper.runRollupJob(db, {
      nowMs: Date.parse('2026-06-03T02:00:00.000Z'),
      exportDir: dir,
      retentionDays: 90,
    });
    assert.strictEqual(summary.csvZonesWritten, 1);
    const raw = fs.readFileSync(path.join(dir, 'zu', 'raw', '2026-06-02.csv'), 'utf8');
    assert.match(raw, /2026-06-02T08:10:00.000Z,UTC,Zone B,soil,Chameleon 1,swt_1,5,10,kPa/);
    const hourly = fs.readFileSync(path.join(dir, 'zu', 'hourly', '2026-06-02.csv'), 'utf8');
    assert.match(hourly, /soil,Chameleon 1,swt_1,5,kPa,2,/);
    const daily = fs.readFileSync(path.join(dir, 'zu', 'daily.csv'), 'utf8');
    assert.match(daily, /soil,Chameleon 1,swt_1,5,kPa,2,/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolves a legacy device field to the matching thematic rollup key', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(7,'Zone B',1,'zu','Europe/Zurich','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,chameleon_enabled,temp_enabled,created_at,updated_at)
        VALUES
          ('AA00000000000001','Chameleon 1','DRAGINO_LSN50',1,7,1,1,'2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z'),
          ('AA00000000000002','Chameleon 2','DRAGINO_LSN50',1,7,1,1,'2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
    `);

    const soil = await helper.resolveDeviceFieldRollupKey(db, 'aa-0000-0000-0000-01', 'swt_1');
    assert.strictEqual(soil.zoneId, 7);
    assert.strictEqual(soil.zoneUuid, 'zu');
    assert.strictEqual(soil.cardType, 'soil');
    assert.strictEqual(soil.logicalSourceKey, 'root-zone');
    assert.strictEqual(soil.channelId, 'swt_1');
    assert.deepStrictEqual(soil.deveuis, ['AA00000000000001', 'AA00000000000002']);
    assert.strictEqual(soil.timezone, 'Europe/Zurich');

    const environment = await helper.resolveDeviceFieldRollupKey(db, 'AA00000000000001', 'ext_temperature_c');
    assert.strictEqual(environment.cardType, 'environment');
    assert.strictEqual(environment.logicalSourceKey, 'microclimate');

    const unmapped = await helper.resolveDeviceFieldRollupKey(db, 'AA00000000000001', 'flow_liters_today');
    assert.strictEqual(unmapped, null);
  } finally {
    db.close();
  }
});

test('computes coverage from source-aware cadence instead of one mixed median', () => {
  const rows = [
    { deveui: 'AA00000000000001', recorded_at: iso(0), swt_1: 10 },
    { deveui: 'AA00000000000001', recorded_at: iso(15), swt_1: 20 },
    { deveui: 'AA00000000000001', recorded_at: iso(30), swt_1: 30 },
    { deveui: 'AA00000000000001', recorded_at: iso(45), swt_1: 40 },
    { deveui: 'BB00000000000002', recorded_at: iso(0), ambient_temperature: 24 },
    { deveui: 'BB00000000000002', recorded_at: iso(60), ambient_temperature: 25 },
    { deveui: 'BB00000000000002', recorded_at: iso(120), ambient_temperature: 26 },
    { deveui: 'BB00000000000002', recorded_at: iso(180), ambient_temperature: 27 },
  ];
  const result = helper.aggregateRows(rows, {
    aggregation: 'hourly',
    channels: ['swt_1', 'ambient_temperature'],
    start: iso(0),
    end: iso(240),
  });

  assert.strictEqual(result.coverageConfidence, 'derived');
  assert.strictEqual(result.sourceCadences['AA00000000000001|swt_1'].seconds, 900);
  assert.strictEqual(result.sourceCadences['BB00000000000002|ambient_temperature'].seconds, 3600);
  assert.strictEqual(result.buckets[0].sampleCount, 5);
  assert.strictEqual(result.buckets[0].coveragePct, 100);

  const configured = helper.aggregateRows(rows.slice(0, 5), {
    aggregation: 'hourly',
    channels: ['swt_1', 'ambient_temperature'],
    start: iso(0),
    end: iso(60),
    expectedCadences: {
      'AA00000000000001|swt_1': 900,
      'BB00000000000002|ambient_temperature': 3600,
    },
  });
  assert.strictEqual(configured.coverageConfidence, 'configured');
  assert.strictEqual(configured.buckets[0].coveragePct, 100);
});

test('derives source cadence from the previous 7 days of a long selected range', () => {
  const rows = [];
  for (let minutes = 0; minutes < 23 * 24 * 60; minutes += 60) {
    rows.push({ deveui: 'AA00000000000001', recorded_at: iso(minutes), swt_1: 20 });
  }
  for (let minutes = 23 * 24 * 60; minutes <= 30 * 24 * 60; minutes += 24 * 60) {
    rows.push({ deveui: 'AA00000000000001', recorded_at: iso(minutes), swt_1: 20 });
  }

  const result = helper.aggregateRows(rows, {
    aggregation: 'daily',
    channels: ['swt_1'],
    start: iso(0),
    end: iso(30 * 24 * 60),
  });

  assert.strictEqual(result.coverageConfidence, 'derived');
  assert.strictEqual(result.sourceCadences['AA00000000000001|swt_1'].seconds, 86400);
});

test('counts configured or requested silent source channels in coverage', () => {
  const rows = [
    { deveui: 'AA00000000000001', recorded_at: iso(0), swt_1: 10 },
    { deveui: 'AA00000000000001', recorded_at: iso(15), swt_1: 20 },
    { deveui: 'AA00000000000001', recorded_at: iso(30), swt_1: 30 },
    { deveui: 'AA00000000000001', recorded_at: iso(45), swt_1: 40 },
  ];
  const base = {
    aggregation: 'hourly',
    channels: ['swt_1'],
    start: iso(0),
    end: iso(60),
  };

  const configuredSilent = helper.aggregateRows(rows, {
    ...base,
    expectedCadences: {
      'AA00000000000001|swt_1': 900,
      'BB00000000000002|swt_1': 900,
    },
  });
  assert.strictEqual(configuredSilent.coverageConfidence, 'configured');
  assert.strictEqual(configuredSilent.sourceCadences['BB00000000000002|swt_1'].seconds, 900);
  assert.strictEqual(configuredSilent.buckets[0].coveragePct, 50);
  assert.strictEqual(configuredSilent.coveragePct, 50);

  const requestedSilent = helper.aggregateRows(rows, {
    ...base,
    sourceKeys: ['AA00000000000001', 'BB00000000000002'],
    expectedCadenceSeconds: 900,
  });
  assert.strictEqual(requestedSilent.coverageConfidence, 'configured');
  assert.strictEqual(requestedSilent.sourceCadences['BB00000000000002|swt_1'].seconds, 900);
  assert.strictEqual(requestedSilent.buckets[0].coveragePct, 50);
  assert.strictEqual(requestedSilent.coveragePct, 50);

  const snakeCaseConfigured = helper.aggregateRows(rows, {
    ...base,
    source_keys: ['AA00000000000001', 'BB00000000000002'],
    configured_cadence_seconds: 900,
  });
  assert.strictEqual(snakeCaseConfigured.coverageConfidence, 'configured');
  assert.strictEqual(snakeCaseConfigured.sourceCadences['BB00000000000002|swt_1'].seconds, 900);
  assert.strictEqual(snakeCaseConfigured.buckets[0].coveragePct, 50);
  assert.strictEqual(snakeCaseConfigured.coveragePct, 50);

  const snakeCaseSourceMap = helper.aggregateRows(rows, {
    ...base,
    expected_cadence_seconds_by_source: {
      aa00000000000001: 900,
      'bb00-0000-0000-0002': 900,
    },
  });
  assert.strictEqual(snakeCaseSourceMap.coverageConfidence, 'configured');
  assert.strictEqual(snakeCaseSourceMap.sourceCadences['BB00000000000002|swt_1'].seconds, 900);
  assert.strictEqual(snakeCaseSourceMap.buckets[0].coveragePct, 50);
  assert.strictEqual(snakeCaseSourceMap.coveragePct, 50);
});

test('builds deterministic advanced metadata placeholders', () => {
  const metadata = helper.buildAdvancedMetadataPlaceholder({
    cardType: 'gateway',
    generatedAt: '2026-05-31T00:00:00.000Z',
    sourceDevices: [
      { deveui: 'aa-bb-cc-dd-ee-ff-00-11', type_id: 'GATEWAY', firmware_version: '1.2.3' },
    ],
    availableFields: ['rssi', 'snr'],
  });

  assert.strictEqual(metadata.schemaVersion, 1);
  assert.strictEqual(metadata.cardType, 'gateway');
  assert.strictEqual(metadata.placeholder, true);
  assert.strictEqual(metadata.generatedAt, '2026-05-31T00:00:00.000Z');
  assert.deepStrictEqual(metadata.availableFields, ['rssi', 'snr']);
  assert.deepStrictEqual(metadata.sections.map((section) => section.id), ['source-devices', 'radio-diagnostics', 'raw-payloads']);
  assert.strictEqual(metadata.sourceDevices[0].deveui, 'AABBCCDDEEFF0011');
  assert.strictEqual(metadata.sourceDevices[0].typeId, 'GATEWAY');
});

test('builds theme-specific calendar cells with local timezone dates and summaries', () => {
  const range = {
    from: '2026-05-30T22:00:00.000Z',
    to: '2026-06-02T22:00:00.000Z',
    timezone: 'Europe/Zurich',
  };

  const soil = helper.buildCalendar({
    cardType: 'soil',
    range,
    rows: [
      { recorded_at: '2026-05-31T01:00:00.000Z', swt_1: 82 },
      { recorded_at: '2026-05-31T02:00:00.000Z', swt_1: 28 },
      { recorded_at: '2026-06-01T12:00:00.000Z', swt_1: 9 },
    ],
    coverageByDate: {
      '2026-05-31': { coveragePct: 90, coverageConfidence: 'configured' },
      '2026-06-01': { coveragePct: 40, coverageConfidence: 'derived' },
    },
  });
  assert.strictEqual(soil.timezone, 'Europe/Zurich');
  assert.deepStrictEqual(soil.days.map((day) => day.date), ['2026-05-31', '2026-06-01', '2026-06-02']);
  assert.strictEqual(soil.days[0].state, 'dry_stress');
  assert.strictEqual(soil.days[0].coveragePct, 90);
  assert.strictEqual(soil.days[0].summary.key, 'history.calendar.summary.soil.dry_stress');
  assert.strictEqual(soil.days[0].metrics.sampleCount, 2);
  assert(soil.days[0].markers.some((marker) => marker.labelKey === 'history.calendar.marker.soil.dry_stress'));
  assert.strictEqual(soil.days[1].state, 'wet_excess');
  assert.strictEqual(soil.days[2].state, 'no_data');

  const dendro = helper.buildCalendar({
    cardType: 'dendro',
    timezone: 'UTC',
    rows: [
      { recorded_at: '2026-05-31T06:00:00.000Z', dendro_ratio: 0.31 },
      { recorded_at: '2026-06-01T06:00:00.000Z', dendro_stem_change_um: -5 },
    ],
  });
  assert.strictEqual(dendro.days[0].state, 'incomplete_night_recovery');
  assert.strictEqual(dendro.days[1].state, 'reduced_growth');

  const environment = helper.buildCalendar({
    cardType: 'environment',
    timezone: 'UTC',
    rows: [
      { recorded_at: '2026-05-31T14:00:00.000Z', ambient_temperature: 36, relative_humidity: 40 },
      { recorded_at: '2026-06-01T14:00:00.000Z', ambient_temperature: 21, relative_humidity: 91 },
      { recorded_at: '2026-06-02T14:00:00.000Z', rain_mm_per_hour: 3 },
    ],
  });
  assert.deepStrictEqual(environment.days.map((day) => day.state), ['heat_stress', 'high_humidity', 'rain_day']);

  const irrigation = helper.buildCalendar({
    cardType: 'irrigation',
    timezone: 'UTC',
    events: [
      { t: '2026-05-31T06:00:00.000Z', type: 'irrigation', metadata: { durationMinutes: 20 } },
      { t: '2026-06-01T06:00:00.000Z', type: 'manual_override', metadata: {} },
      { t: '2026-06-02T06:00:00.000Z', type: 'irrigation', metadata: {} },
      { t: '2026-06-02T08:00:00.000Z', type: 'irrigation', metadata: {} },
      { t: '2026-06-02T10:00:00.000Z', type: 'irrigation', metadata: {} },
    ],
  });
  assert.deepStrictEqual(irrigation.days.map((day) => day.state), [
    'irrigation_event',
    'manual_override',
    'high_irrigation_frequency',
  ]);
});

test('builds advanced diagnostics with collected, absent, unknown, and unsupported availability', () => {
  const diagnostics = helper.buildAdvancedDiagnostics({
    cardType: 'soil',
    generatedAt: '2026-05-31T00:00:00.000Z',
    sourceDevices: [
      { deveui: 'aa-bb-cc-dd-ee-ff-00-11', type_id: 'KIWI_SENSOR', firmware_version: '1.2.3' },
    ],
    latestRows: [
      {
        recorded_at: '2026-05-31T00:00:00.000Z',
        rssi: null,
        snr: 7.5,
      },
    ],
    collectedFields: ['rssi'],
    rowCount: 5,
    logicalSourceKey: 'root-zone',
    gatewayEui: '0011223344556677',
    calibrationStatus: null,
  });

  assert.strictEqual(diagnostics.placeholder.placeholder, true);
  assert.strictEqual(diagnostics.fields.sourceDeviceCount.availability, 'collected');
  assert.strictEqual(diagnostics.fields.primaryDeveui.availability, 'collected');
  assert.strictEqual(diagnostics.fields.rssi.availability, 'collected');
  assert.strictEqual(diagnostics.fields.rssi.value, null);
  assert.strictEqual(diagnostics.fields.snr.availability, 'collected');
  assert.strictEqual(diagnostics.fields.batteryVoltage.availability, 'not_collected_at_time');
  assert.strictEqual(diagnostics.fields.rawPayload.availability, 'not_collected_at_time');
  assert.strictEqual(diagnostics.fields.pendingCommands.availability, 'unsupported');
  assert.strictEqual(diagnostics.fields.calibrationStatus.availability, 'unknown_now');

  const gateway = helper.buildAdvancedDiagnostics({
    cardType: 'gateway',
    sourceDevices: [],
    latestRows: [],
    rowCount: 0,
    pendingCommandCount: null,
  });
  assert.strictEqual(gateway.fields.primaryDeveui.availability, 'unknown_now');
  assert.strictEqual(gateway.fields.pendingCommands.availability, 'unknown_now');
  assert.strictEqual(gateway.fields.calibrationStatus.availability, 'unsupported');
});

test('builds deterministic local interpretations', () => {
  const interpretations = helper.buildLocalInterpretations({
    cardType: 'soil',
    status: 'dry_stress',
    statusSince: '2026-05-30T15:00:00.000Z',
    generatedAt: '2026-05-31T00:00:00.000Z',
    coveragePct: 42,
    coverageConfidence: 'configured',
    dendroStatus: 'incomplete_night_recovery',
  });

  assert(interpretations.some((item) => item.ruleId === 'root-zone-dry'));
  assert(interpretations.some((item) => item.ruleId === 'data-coverage-gap'));
  assert(interpretations.some((item) => item.ruleId === 'incomplete-night-recovery'));
  for (const item of interpretations) {
    assert.strictEqual(item.source, 'local-rule');
    assert(item.titleKey && item.bodyKey, 'interpretation uses locale keys');
    assert(!item.title && !item.body, 'interpretation prose stays in locale files');
    assert(!item.body || item.body.length < 120, 'structured output should not depend on long prose');
  }
});

test('aggregates SQL-backed device_data with parameterized range queries and rollups', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id, username, password_hash, created_at, updated_at) VALUES(1, 'user', 'hash', '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, created_at, updated_at) VALUES(7, 'Zone', 1, 'zone-uuid', '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z');
      INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at, irrigation_zone_id) VALUES
        ('AA00000000000001', 'Soil', 'KIWI_SENSOR', 1, '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z', 7),
        ('AA00000000000002', 'Weather', 'SENSECAP_S2120', 1, '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z', 7);
      INSERT INTO device_data(deveui, recorded_at, swt_1, ambient_temperature) VALUES
        ('AA00000000000001', '${iso(0)}', 10, NULL),
        ('AA00000000000001', '${iso(15)}', 20, NULL),
        ('AA00000000000001', '${iso(30)}', 30, NULL),
        ('AA00000000000002', '${iso(30)}', NULL, 24);
      INSERT INTO history_channel_rollups(
        zone_id, card_type, logical_source_key, channel_id, bucket_level, bucket_start, bucket_end,
        min_value, max_value, mean_value, median_value, latest_value, dominant_status,
        coverage_pct, coverage_confidence, sample_count, unit
      ) VALUES (
        7, 'soil', 'root-zone', 'swt_1', 'daily', '2026-05-31T00:00:00.000Z', '2026-06-01T00:00:00.000Z',
        10, 30, 20, 20, 30, 'optimal', 12.5, 'configured', 3, 'kPa'
      );
    `);

    const raw = await helper.aggregateDeviceData(db, {
      device_euis: ['aa-00000000000001', 'AA00000000000002'],
      start: iso(0),
      end: iso(60),
      aggregation: 'hourly',
      channels: ['swt_1', 'ambient_temperature'],
      expectedCadenceSeconds: 900,
    });
    assert.strictEqual(raw.aggregation, 'hourly');
    assert.strictEqual(raw.buckets[0].series.swt_1.sampleCount, 3);
    assert.match(db.lastQuery.sql, /deveui IN \(\?,\?\)/);
    assert.match(db.lastQuery.sql, /recorded_at BETWEEN \? AND \?/);
    assert.match(db.lastQuery.sql, /ORDER BY deveui ASC, recorded_at ASC/);
    assert(!/ORDER BY recorded_at ASC\b/.test(db.lastQuery.sql), 'query must not sort by recorded_at alone');
    assert(!db.lastQuery.sql.includes('AA00000000000001'), 'query must keep DevEUIs in params');
    assert.deepStrictEqual(db.lastQuery.params.slice(0, 4), ['AA00000000000001', 'AA00000000000002', iso(0), iso(60)]);

    const rollup = await helper.aggregateDeviceData(db, {
      zoneId: 7,
      cardType: 'soil',
      logicalSourceKey: 'root-zone',
      start: '2026-05-31T00:00:00.000Z',
      end: '2026-06-01T00:00:00.000Z',
      aggregation: 'daily',
      channels: ['swt_1'],
    });
    assert.strictEqual(rollup.source, 'history_channel_rollups');
    assert.strictEqual(rollup.buckets[0].series.swt_1.mean, 20);
    assert.strictEqual(rollup.buckets[0].coveragePct, 12.5);
    assert.match(db.lastQuery.sql, /FROM history_channel_rollups/);

    const snakeCaseRollup = await helper.aggregateDeviceData(db, {
      zone_id: 7,
      card_type: 'soil',
      logical_source_key: 'root-zone',
      start: '2026-05-31T00:00:00.000Z',
      end: '2026-06-01T00:00:00.000Z',
      aggregation: 'daily',
      channels: ['swt_1'],
    });
    assert.strictEqual(snakeCaseRollup.source, 'history_channel_rollups');
    assert.strictEqual(snakeCaseRollup.buckets[0].series.swt_1.mean, 20);
    assert.match(db.lastQuery.sql, /FROM history_channel_rollups/);
    assert.deepStrictEqual(db.lastQuery.params.slice(0, 6), [7, 'soil', 'root-zone', 'daily', '2026-05-31T00:00:00.000Z', '2026-06-01T00:00:00.000Z']);

    const autoRollup = await helper.aggregateDeviceData(db, {
      zoneId: 7,
      cardType: 'soil',
      logicalSourceKey: 'root-zone',
      start: '2026-05-31T00:00:00.000Z',
      end: '2026-06-30T00:00:00.000Z',
      range: '30d',
      aggregation: 'auto',
      channels: ['swt_1'],
    });
    assert.strictEqual(autoRollup.aggregation, 'daily');
    assert.strictEqual(autoRollup.aggregationRequested, 'auto');
    assert.strictEqual(autoRollup.source, 'history_channel_rollups');
    assert.match(db.lastQuery.sql, /FROM history_channel_rollups/);

    const unfilteredScopedRollup = await helper.aggregateDeviceData(db, {
      zoneId: 7,
      cardType: 'soil',
      logicalSourceKey: 'root-zone',
      sourceKeys: ['AA00000000000001'],
      start: '2026-05-31T00:00:00.000Z',
      end: '2026-06-01T00:00:00.000Z',
      aggregation: 'daily',
      channels: ['swt_1'],
    });
    assert.strictEqual(unfilteredScopedRollup.source, 'history_channel_rollups');
    assert.match(db.lastQuery.sql, /FROM history_channel_rollups/);

    const filteredLongRange = await helper.aggregateDeviceData(db, {
      zoneId: 7,
      cardType: 'soil',
      logicalSourceKey: 'root-zone',
      device_euis: ['AA00000000000001'],
      start: '2026-05-31T00:00:00.000Z',
      end: '2026-06-30T00:00:00.000Z',
      range: '30d',
      aggregation: 'auto',
      channels: ['swt_1'],
      sourceFilterActive: true,
    });
    assert.strictEqual(filteredLongRange.aggregation, 'daily');
    assert.strictEqual(filteredLongRange.source, 'device_data');
    assert.match(db.lastQuery.sql, /FROM device_data/);
    assert.deepStrictEqual(db.lastQuery.params.slice(0, 3), ['AA00000000000001', '2026-05-31T00:00:00.000Z', '2026-06-30T00:00:00.000Z']);
  } finally {
    db.close();
  }
});

test('aggregateDeviceData merges completed rollups with a live trailing bucket', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO history_channel_rollups(
        zone_id,card_type,logical_source_key,channel_id,bucket_level,bucket_start,bucket_end,
        mean_value,latest_value,min_value,max_value,median_value,sample_count,coverage_confidence,unit
      ) VALUES (
        7,'soil','root-zone','swt_1','daily','2026-06-01T00:00:00.000Z','2026-06-02T00:00:00.000Z',
        30,30,28,32,30,12,'derived','kPa'
      );
      INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES ('AA00000000000001','2026-06-02T09:00:00.000Z',40);
    `);
    const result = await helper.aggregateDeviceData(db, {
      zoneId: 7,
      cardType: 'soil',
      logicalSourceKey: 'root-zone',
      device_euis: ['AA00000000000001'],
      start: '2026-06-01T00:00:00.000Z',
      end: '2026-06-03T00:00:00.000Z',
      range: '30d',
      aggregation: 'daily',
      channels: ['swt_1'],
      timezone: 'UTC',
      nowMs: Date.parse('2026-06-02T12:00:00.000Z'),
    });
    assert.strictEqual(result.source, 'rollups+live');
    const days = result.buckets.map((bucket) => bucket.bucketStart);
    assert.ok(days.includes('2026-06-01T00:00:00.000Z'), 'rollup day present');
    assert.ok(days.includes('2026-06-02T00:00:00.000Z'), 'live today present');
  } finally {
    db.close();
  }
});

test('uses live device_data for long-range source-filtered requests', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id, username, password_hash, created_at, updated_at) VALUES(1, 'user', 'hash', '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, created_at, updated_at) VALUES(7, 'Zone', 1, 'zone-uuid', '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z');
      INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at, irrigation_zone_id) VALUES
        ('AA00000000000001', 'Soil', 'KIWI_SENSOR', 1, '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z', 7);
      INSERT INTO device_data(deveui, recorded_at, swt_1) VALUES
        ('AA00000000000001', '2026-05-31T00:00:00.000Z', 10),
        ('AA00000000000001', '2026-05-31T12:00:00.000Z', 30);
    `);

    const result = await helper.aggregateDeviceData(db, {
      zoneId: 7,
      cardType: 'soil',
      logicalSourceKey: 'root-zone',
      device_euis: ['AA00000000000001'],
      start: '2026-05-31T00:00:00.000Z',
      end: '2026-06-30T00:00:00.000Z',
      range: '30d',
      aggregation: 'auto',
      channels: ['swt_1'],
      useRollups: true,
      sourceFilterActive: true,
    });

    assert.strictEqual(result.aggregation, 'daily');
    assert.strictEqual(result.source, 'device_data');
    assert.strictEqual(result.buckets[0].series.swt_1.sampleCount, 2);
    assert.strictEqual(result.buckets[0].series.swt_1.latest, 30);
  } finally {
    db.close();
  }
});

test('verify-sync-flow chains SQL-backed history helper regression tests', () => {
  const verifySource = fs.readFileSync(path.join(repoRoot, 'scripts', 'verify-sync-flow.js'), 'utf8');
  assert.match(verifySource, /test-history-helper\.js/);
  assert(!/execFileSync\(process\.execPath,\s*\[path\.resolve\(__dirname,\s*['"]verify-sync-flow\.js['"]\)/.test(verifySource), 'verify-sync-flow must not recursively execute itself');
});
