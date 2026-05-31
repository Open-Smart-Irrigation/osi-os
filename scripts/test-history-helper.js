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
  'classifyEnvironmentStatus',
  'classifyDendroStatus',
  'classifyIrrigationStatus',
  'classifyGatewayStatus',
  'deriveExpectedCadenceSeconds',
  'aggregateRows',
  'aggregateDeviceData',
  'buildAdvancedMetadataPlaceholder',
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
    ]
  );
  assert.deepStrictEqual(cards.map((card) => card.cardType).sort(), ['dendro', 'environment', 'irrigation', 'soil']);
  assert(cards.some((card) => card.id === 'zone-uuid:soil:root-zone'));
  assert(cards.some((card) => card.id === 'zone-uuid:environment:microclimate'));
  assert(cards.some((card) => card.id === 'zone-uuid:irrigation:zone-valves'));
});

test('derives the hub-scoped gateway card id', () => {
  const gateway = helper.deriveGatewayCard('aa-bb-cc-dd-ee-ff-00-11');
  assert.strictEqual(gateway.id, 'AABBCCDDEEFF0011:gateway:hub');
  assert.strictEqual(gateway.cardType, 'gateway');
  assert.strictEqual(gateway.logicalSourceKey, 'hub');
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
      deveuis: ['AA00000000000001', 'AA00000000000002'],
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
  } finally {
    db.close();
  }
});

test('verify-sync-flow chains SQL-backed history helper regression tests', () => {
  const verifySource = fs.readFileSync(path.join(repoRoot, 'scripts', 'verify-sync-flow.js'), 'utf8');
  assert.match(verifySource, /test-history-helper\.js/);
  assert(!/execFileSync\(process\.execPath,\s*\[path\.resolve\(__dirname,\s*['"]verify-sync-flow\.js['"]\)/.test(verifySource), 'verify-sync-flow must not recursively execute itself');
});
