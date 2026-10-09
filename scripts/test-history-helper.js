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
  'analysisSeriesId',
  'buildAnalysisCatalog',
  'resolveAnalysisSeries',
  'listAnalysisViews',
  'saveAnalysisView',
  'deleteAnalysisView',
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
  'kpaToPf',
  'startOfLocalDayMs',
  'computeRollupBuckets',
  'upsertRollups',
  'runRollupJob',
  'resolveDeviceFieldRollupKey',
  'legacySensorHistory',
  'legacyRainDailyHistory',
  'resolveDeviceTimezones',
  'resolveDeviceTimezone',
  'rainDailyHistory',
  'buildZoneExportCsv',
  'buildAllZonesExportCsv',
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

const TIDY_CSV_COLUMNS = [
  'timestamp',
  'site',
  'zone',
  'series_label',
  'card_type',
  'source_key',
  'channel_key',
  'depth_cm',
  'array_id',
  'unit',
  'value',
];

const SQLITE_JSON_MAX_BUFFER = 16 * 1024 * 1024;

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
    queries: [],
    runSql(sql) {
      execFileSync('sqlite3', [dbPath], { input: sql });
    },
    run(sql, params, cb) {
      db.lastQuery = { sql, params: Array.isArray(params) ? params.slice() : [] };
      db.queries.push(db.lastQuery);
      let index = 0;
      const rendered = sql.replace(/\?/g, () => sqliteEscape(db.lastQuery.params[index++]));
      try {
        execFileSync('sqlite3', [dbPath], { input: rendered });
        if (typeof cb === 'function') cb.call({}, null);
      } catch (error) {
        if (typeof cb === 'function') cb(error);
        else throw error;
      }
    },
    all(sql, params, cb) {
      db.lastQuery = { sql, params: Array.isArray(params) ? params.slice() : [] };
      db.queries.push(db.lastQuery);
      let index = 0;
      const rendered = sql.replace(/\?/g, () => sqliteEscape(db.lastQuery.params[index++]));
      try {
        const output = execFileSync('sqlite3', ['-json', dbPath, rendered], { encoding: 'utf8', maxBuffer: SQLITE_JSON_MAX_BUFFER }).trim();
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

async function analysisFixtureDb() {
  const db = createCliSqliteDb();
  db.runSql(`
    INSERT INTO users(id, username, password_hash, created_at, updated_at, user_uuid)
    VALUES (1, 'analysis-user', 'x', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', 'user-uuid');
    INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, timezone, gateway_device_eui)
    VALUES (12, 'Analysis Zone', 1, 'analysis-zone', 'UTC', '0016C001F11766E7');
    INSERT INTO devices(deveui, name, type_id, user_id, irrigation_zone_id, chameleon_swt1_depth_cm, created_at, updated_at)
    VALUES ('AA00000000000001', 'Kiwi One', 'KIWI_SENSOR', 1, 12, 15, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
    INSERT INTO device_data(deveui, recorded_at, swt_1)
    VALUES
      ('AA00000000000001', '2026-06-01T00:00:00.000Z', 10),
      ('AA00000000000001', '2026-06-01T01:00:00.000Z', 20),
      ('AA00000000000001', '2026-06-01T02:00:00.000Z', 30);
  `);
  db.queries = [];
  return db;
}

async function multiUserAnalysisFixtureDb() {
  const db = createCliSqliteDb();
  db.runSql(`
    INSERT INTO users(id, username, password_hash, created_at, updated_at, user_uuid)
    VALUES
      (1, 'analysis-user-one', 'x', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', 'user-one-uuid'),
      (2, 'analysis-user-two', 'x', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', 'user-two-uuid');
    INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, timezone, gateway_device_eui)
    VALUES
      (12, 'User One Zone', 1, 'analysis-zone-one', 'UTC', '0016C001F11766E7'),
      (22, 'User Two Zone', 2, 'analysis-zone-two', 'UTC', '0016C001F11766E7');
    INSERT INTO devices(deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at)
    VALUES
      ('AA00000000000001', 'Kiwi One', 'KIWI_SENSOR', 1, 12, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
      ('BB00000000000002', 'Kiwi Two', 'KIWI_SENSOR', 2, 22, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
    INSERT INTO device_data(deveui, recorded_at, swt_1)
    VALUES
      ('AA00000000000001', '2026-06-01T00:00:00.000Z', 10),
      ('BB00000000000002', '2026-06-01T00:00:00.000Z', 20);
  `);
  db.queries = [];
  return db;
}

test('exports the history helper contract', () => {
  for (const name of expectedExports) {
    assert.strictEqual(typeof helper[name], 'function', `${name} export`);
  }
});

test('exports the zone CSV column contracts', () => {
  assert.deepStrictEqual(helper.RAW_CSV_COLUMNS, TIDY_CSV_COLUMNS);
  assert.deepStrictEqual(helper.AGG_CSV_COLUMNS, TIDY_CSV_COLUMNS);
});

test('exports the analysis views schema contract', () => {
  assert.match(helper.ANALYSIS_VIEWS_SCHEMA, /CREATE TABLE IF NOT EXISTS analysis_views/);
});

test('analysisSeriesId is a stable 16-hex hash of the tuple', () => {
  const id = helper.analysisSeriesId(12, 'soil', 'soil-1', 'swt_1');
  assert.match(id, /^[0-9a-f]{16}$/);
  const expected = crypto.createHash('sha256').update('12|soil|soil-1|swt_1').digest('hex').slice(0, 16);
  assert.strictEqual(id, expected);
  assert.strictEqual(helper.analysisSeriesId(12, 'soil', 'soil-1', 'swt_1'), id);
});

test('buildAnalysisCatalog enumerates metadata-only per-source-device channels with availability', async () => {
  const db = await analysisFixtureDb();
  try {
    const { channels, entriesById } = await helper.buildAnalysisCatalog(db, { deviceEui: '0016C001F11766E7', userId: 1 });
    const swt1 = channels.find((entry) => entry.channelKey === 'swt_1');
    assert.ok(swt1, 'has a swt_1 series');
    assert.strictEqual(swt1.hubEui, '0016C001F11766E7');
    assert.strictEqual(swt1.zoneId, 12);
    assert.strictEqual(swt1.zoneName, 'Analysis Zone');
    assert.strictEqual(swt1.cardType, 'soil');
    assert.strictEqual(swt1.deviceName, 'Kiwi One');
    assert.strictEqual(swt1.depthCm, 15);
    assert.strictEqual(swt1.availability, 'available');
    assert.strictEqual(swt1.seriesId, helper.analysisSeriesId(swt1.zoneId, 'soil', swt1.sourceKey, 'swt_1'));
    assert.strictEqual(entriesById.get(swt1.seriesId).deveui, 'AA00000000000001');
    assert.ok(channels.some((entry) => entry.channelKey === 'swt_2'), 'has the second canonical Kiwi SWT channel');
    assert.ok(!channels.some((entry) => entry.channelKey === 'swt_3'), 'does not invent a third Kiwi SWT channel');
    assert.ok(!channels.some((entry) => entry.channelKey === 'vwc'), 'does not advertise unsupported generic VWC');
    assert.ok(!db.queries.some((query) => /\bFROM\s+device_data\b/i.test(query.sql)), 'catalog must not scan history rows');
  } finally {
    db.close();
  }
});

test('buildAnalysisCatalog scopes zones and devices to the authenticated user', async () => {
  const db = await multiUserAnalysisFixtureDb();
  try {
    const { channels } = await helper.buildAnalysisCatalog(db, { deviceEui: '0016C001F11766E7', userId: 1 });
    const zoneNames = Array.from(new Set(channels.map((entry) => entry.zoneName))).sort();
    const deviceNames = Array.from(new Set(channels.filter((entry) => entry.sourceKind === 'device').map((entry) => entry.deviceName))).sort();
    assert.deepStrictEqual(zoneNames, ['User One Zone']);
    assert.deepStrictEqual(deviceNames, ['Kiwi One']);
    assert.ok(channels.some((entry) => entry.sourceKind === 'zone_daily_agronomy' && entry.deviceName === 'User One Zone daily agronomy'));
  } finally {
    db.close();
  }
});

test('resolveAnalysisSeries aggregates per-device points and drops unknown ids', async () => {
  const db = await analysisFixtureDb();
  try {
    const cat = await helper.buildAnalysisCatalog(db, { deviceEui: 'EUI', userId: 1 });
    const swt1 = cat.channels.find((entry) => entry.channelKey === 'swt_1');
    const res = await helper.resolveAnalysisSeries(db, {
      deviceEui: 'EUI',
      userId: 1,
      selectors: [{ seriesId: swt1.seriesId }, { seriesId: 'deadbeefdeadbeef' }],
      range: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' },
      aggregation: 'auto',
    });
    assert.strictEqual(res.series.length, 1);
    assert.strictEqual(res.series[0].resolved.channelKey, 'swt_1');
    assert.strictEqual(res.series[0].resolved.sourceKey, swt1.sourceKey);
    assert.strictEqual(res.series[0].points.length, 3);
    assert.deepStrictEqual(res.dropped, [{ seriesId: 'deadbeefdeadbeef', reason: 'unknown' }]);
  } finally {
    db.close();
  }
});

test('resolveAnalysisSeries drops series ids outside the authenticated user catalog', async () => {
  const db = await multiUserAnalysisFixtureDb();
  try {
    const userTwoCatalog = await helper.buildAnalysisCatalog(db, { deviceEui: 'EUI', userId: 2 });
    const userTwoSwt = userTwoCatalog.channels.find((entry) => entry.zoneName === 'User Two Zone' && entry.channelKey === 'swt_1');
    assert.ok(userTwoSwt, 'fixture has user two analysis series');
    const res = await helper.resolveAnalysisSeries(db, {
      deviceEui: 'EUI',
      userId: 1,
      selectors: [{ seriesId: userTwoSwt.seriesId }],
      range: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' },
      aggregation: 'auto',
    });
    assert.strictEqual(res.series.length, 0);
    assert.deepStrictEqual(res.dropped, [{ seriesId: userTwoSwt.seriesId, reason: 'unknown' }]);
  } finally {
    db.close();
  }
});

test('resolveAnalysisSeries rejects over the selected-series cap', async () => {
  const db = await analysisFixtureDb();
  try {
    const selectors = Array.from({ length: 26 }, (_, index) => ({ seriesId: `id${index}` }));
    await assert.rejects(
      () => helper.resolveAnalysisSeries(db, {
        deviceEui: 'EUI',
        userId: 1,
        selectors,
        range: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' },
        aggregation: 'auto',
      }),
      (error) => {
        assert.strictEqual(error.statusCode, 413);
        assert.match(String(error.suggestion), /fewer series/i);
        return true;
      }
    );
  } finally {
    db.close();
  }
});

test('resolveAnalysisSeries rejects ranges over four hundred days', async () => {
  const db = await analysisFixtureDb();
  try {
    const cat = await helper.buildAnalysisCatalog(db, { deviceEui: 'EUI', userId: 1 });
    const swt1 = cat.channels.find((entry) => entry.channelKey === 'swt_1');
    await assert.rejects(
      () => helper.resolveAnalysisSeries(db, {
        deviceEui: 'EUI',
        userId: 1,
        selectors: [{ seriesId: swt1.seriesId }],
        range: { from: '2025-01-01T00:00:00.000Z', to: '2026-06-15T00:00:00.000Z' },
        aggregation: 'auto',
      }),
      (error) => {
        assert.strictEqual(error.statusCode, 413);
        assert.match(String(error.suggestion), /range/i);
        return true;
      }
    );
  } finally {
    db.close();
  }
});

test('resolveAnalysisSeries rejects over the raw-row scan cap per request', async () => {
  const db = await analysisFixtureDb();
  try {
    db.runSql(`
      WITH RECURSIVE seq(n) AS (
        VALUES(0)
        UNION ALL
        SELECT n + 1 FROM seq WHERE n < 30000
      )
      INSERT INTO device_data(deveui, recorded_at, swt_1)
      SELECT
        'AA00000000000001',
        strftime('%Y-%m-%dT%H:%M:%fZ', '2026-06-01T00:00:00Z', '+' || n || ' seconds'),
        10
      FROM seq;
    `);
    const cat = await helper.buildAnalysisCatalog(db, { deviceEui: 'EUI', userId: 1 });
    const swt1 = cat.channels.find((entry) => entry.channelKey === 'swt_1');
    await assert.rejects(
      () => helper.resolveAnalysisSeries(db, {
        deviceEui: 'EUI',
        userId: 1,
        selectors: [{ seriesId: swt1.seriesId }],
        range: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' },
        aggregation: 'auto',
      }),
      (error) => {
        assert.strictEqual(error.statusCode, 413);
        assert.match(String(error.suggestion), /range|granularity/i);
        return true;
      }
    );
  } finally {
    db.close();
  }
});

test('resolveAnalysisSeries enforces raw-row cap on the data query', async () => {
  const db = await analysisFixtureDb();
  try {
    const cat = await helper.buildAnalysisCatalog(db, { deviceEui: 'EUI', userId: 1 });
    const swt1 = cat.channels.find((entry) => entry.channelKey === 'swt_1');
    await helper.resolveAnalysisSeries(db, {
      deviceEui: 'EUI',
      userId: 1,
      selectors: [{ seriesId: swt1.seriesId }],
      range: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' },
      aggregation: 'auto',
    });
    const dataQuery = db.queries.find((query) =>
      /\bSELECT\s+deveui,\s+recorded_at\b/i.test(query.sql) &&
      /\bFROM\s+device_data\b/i.test(query.sql)
    );
    assert.ok(dataQuery, 'series resolver runs a device_data query');
    assert.match(dataQuery.sql, /\bLIMIT\s+\?/i);
    assert.ok(!db.queries.some((query) => /SELECT 1 AS present FROM device_data/i.test(query.sql)), 'series resolver must not pre-scan with a separate cap probe');
  } finally {
    db.close();
  }
});

test('analysis_views round-trips per user and drops stale series ids on read', async () => {
  const db = await analysisFixtureDb();
  try {
    db.runSql(helper.ANALYSIS_VIEWS_SCHEMA);
    const cat = await helper.buildAnalysisCatalog(db, { deviceEui: 'EUI', userId: 1 });
    const live = cat.channels[0].seriesId;
    await helper.saveAnalysisView(db, { userId: 1, ownerUserUuid: 'u-1' }, {
      name: 'My view',
      selectors: [{ seriesId: live }, { seriesId: 'stalexxxxxxxxxx0' }],
      schemaVersion: 1,
    });
    const views = await helper.listAnalysisViews(db, { userId: 1, deviceEui: 'EUI' });
    assert.strictEqual(views.length, 1);
    assert.deepStrictEqual(views[0].selectors.map((selector) => selector.seriesId), [live]);
    assert.deepStrictEqual(views[0].droppedSeriesIds, ['stalexxxxxxxxxx0']);
  } finally {
    db.close();
  }
});

test('saveAnalysisView rejects an empty or oversized name', async () => {
  const db = await analysisFixtureDb();
  try {
    db.runSql(helper.ANALYSIS_VIEWS_SCHEMA);
    await assert.rejects(
      () => helper.saveAnalysisView(db, { userId: 1 }, { name: '', selectors: [] }),
      (error) => {
        assert.strictEqual(error.statusCode, 400);
        return true;
      }
    );
    await assert.rejects(
      () => helper.saveAnalysisView(db, { userId: 1 }, '{bad-json'),
      (error) => {
        assert.strictEqual(error.statusCode, 400);
        return true;
      }
    );
  } finally {
    db.close();
  }
});

test('deploy script delivers analysis_views through the migration runner', () => {
  const deploy = fs.readFileSync(path.join(repoRoot, 'deploy.sh'), 'utf8');
  assert.match(deploy, /run_schema_migration/);
  assert.match(deploy, /database\/migrations\/ordered\/\$migration/);
  assert.match(deploy, /migrate-cli\.js/);
  assert.doesNotMatch(deploy, /CREATE TABLE IF NOT EXISTS analysis_views/);
  assert.doesNotMatch(deploy, /Live analysis views schema repair/);
  assert.match(deploy, /osi-history-helper\/analysis\.js/);
});

test('toCsv neutralizes spreadsheet formulas in text cells', () => {
  const csv = helper.toCsv(['zone', 'source', 'array_id', 'value'], [{
    zone: '=Zone',
    source: '+Source',
    array_id: '@ARRAY',
    value: 12.5,
  }]);
  assert.strictEqual(csv, "zone,source,array_id,value\n'=Zone,'+Source,'@ARRAY,12.5\n");
});

test('toCsv also neutralizes text cells that start with a tab or a carriage return', () => {
  const csv = helper.toCsv(['zone', 'source', 'value'], [{ zone: '\tZone', source: '\r=cmd', value: -3 }]);
  assert.strictEqual(csv, "zone,source,value\n'\tZone,\"'\r=cmd\",-3\n");
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

test('startOfLocalDayMs returns the first instant of the local date across DST edges', () => {
  const start = (iso, tz) => new Date(helper.startOfLocalDayMs(Date.parse(iso), tz)).toISOString();
  // DST starts at 00:00 local: midnight does not exist, the day begins at 01:00 local.
  assert.strictEqual(start('2026-04-24T12:00:00Z', 'Africa/Cairo'), '2026-04-23T22:00:00.000Z');
  assert.strictEqual(start('2026-03-29T12:00:00Z', 'Asia/Beirut'), '2026-03-28T22:00:00.000Z');
  assert.strictEqual(start('2026-03-29T00:30:00Z', 'Asia/Beirut'), '2026-03-28T22:00:00.000Z');
  // Ordinary DST transitions at 02:00/03:00 (Zurich): 23-hour and 25-hour days.
  assert.strictEqual(start('2026-03-29T12:00:00Z', 'Europe/Zurich'), '2026-03-28T23:00:00.000Z');
  assert.strictEqual(start('2026-03-30T12:00:00Z', 'Europe/Zurich'), '2026-03-29T22:00:00.000Z');
  assert.strictEqual(start('2026-10-25T12:00:00Z', 'Europe/Zurich'), '2026-10-24T22:00:00.000Z');
  assert.strictEqual(start('2026-10-26T12:00:00Z', 'Europe/Zurich'), '2026-10-25T23:00:00.000Z');
  // Half-hour offset, no DST, UTC.
  assert.strictEqual(start('2026-06-02T10:00:00Z', 'Asia/Kolkata'), '2026-06-01T18:30:00.000Z');
  assert.strictEqual(start('2026-06-02T10:00:00Z', 'UTC'), '2026-06-02T00:00:00.000Z');
  // The 25-hour day: its length is the next day's start minus its start.
  const day = Date.parse('2026-10-25T12:00:00Z');
  const next = Date.parse('2026-10-26T12:00:00Z');
  assert.strictEqual((helper.startOfLocalDayMs(next, 'Europe/Zurich') - helper.startOfLocalDayMs(day, 'Europe/Zurich')) / 3600000, 25);
  // An instant inside the repeated hour and the last millisecond of a day.
  assert.strictEqual(start('2026-10-25T01:30:00Z', 'Europe/Zurich'), '2026-10-24T22:00:00.000Z');
  assert.strictEqual(start('2026-04-24T20:59:59.999Z', 'Africa/Cairo'), '2026-04-23T22:00:00.000Z');
});

test('startOfLocalDayMs returns the UTC instant of zone-local midnight', () => {
  const ms = helper.startOfLocalDayMs(Date.parse('2026-06-02T10:00:00Z'), 'Europe/Zurich');
  assert.strictEqual(new Date(ms).toISOString(), '2026-06-01T22:00:00.000Z');

  const utc = helper.startOfLocalDayMs(Date.parse('2026-06-02T10:00:00Z'), 'UTC');
  assert.strictEqual(new Date(utc).toISOString(), '2026-06-02T00:00:00.000Z');

  // Regression: the sub-second remainder of `nowMs` must not leak into the boundary,
  // otherwise daily/weekly bucket_start jitters per run and breaks upsert idempotency.
  assert.strictEqual(
    new Date(helper.startOfLocalDayMs(Date.parse('2026-06-02T13:58:28.070Z'), 'UTC')).toISOString(),
    '2026-06-02T00:00:00.000Z'
  );
  assert.strictEqual(
    new Date(helper.startOfLocalDayMs(Date.parse('2026-06-02T13:58:28.910Z'), 'Europe/Zurich')).toISOString(),
    '2026-06-01T22:00:00.000Z'
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

test('computeRollupBuckets bucket_start is stable across run-times (idempotent key)', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at) VALUES('AA00000000000001','Soil','KIWI_SENSOR',1,7,'2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES
        ('AA00000000000001','2026-06-01T08:30:00.000Z',10),
        ('AA00000000000001','2026-06-02T08:30:00.000Z',20);
    `);
    const scope = {
      zoneId: 7, cardType: 'soil', logicalSourceKey: 'root-zone',
      channels: [{ id: 'swt_1', field: 'swt_1', unit: 'kPa' }],
      deveuis: ['AA00000000000001'], timezone: 'UTC',
    };
    // Two runs at the same clock-day but different sub-second instants must yield identical keys.
    const r1 = await helper.computeRollupBuckets(db, scope, 'daily', 120 * 24 * 3600 * 1000, Date.parse('2026-06-03T02:00:01.111Z'));
    const r2 = await helper.computeRollupBuckets(db, scope, 'daily', 120 * 24 * 3600 * 1000, Date.parse('2026-06-03T02:05:09.777Z'));
    const starts1 = r1.map((row) => row.bucket_start).sort();
    const starts2 = r2.map((row) => row.bucket_start).sort();
    assert.ok(starts1.length >= 2, 'has daily buckets');
    assert.deepStrictEqual(starts1, starts2);
    assert.ok(starts1.every((s) => s.endsWith('T00:00:00.000Z')), 'daily bucket_start is clean midnight');
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

test('writeZoneCsv emits tidy long-format raw and daily files with depth', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-csv-'));
  try {
    const zone = { id: 7, name: 'Zone B', zone_uuid: 'zu', timezone: 'Europe/Zurich' };
    const rawRows = [
      {
        timestamp: '2026-06-02T14:03:21.000Z',
        site: 'HUB-1',
        series_label: 'Chameleon 1 - Soil tension (S1)',
        card_type: 'soil',
        source_key: 'soil-src-abc123',
        channel_key: 'swt_1',
        depth_cm: 5,
        array_id: 'ARR-009',
        unit: 'kPa',
        value: 6.24,
      },
    ];
    const dailyRows = [
      {
        timestamp: '2026-06-02T00:00:00.000Z',
        site: 'HUB-1',
        series_label: 'Chameleon 1 - Soil tension (S1)',
        card_type: 'soil',
        source_key: 'soil-src-abc123',
        channel_key: 'swt_1',
        depth_cm: 5,
        array_id: 'ARR-009',
        unit: 'kPa',
        value: 6.3,
      },
    ];

    await helper.writeZoneCsv({ exportDir: dir, zone, day: '2026-06-02', rawRows, dailyRows });
    const raw = fs.readFileSync(path.join(dir, 'zu', 'raw', '2026-06-02.csv'), 'utf8').trim().split('\n');
    assert.strictEqual(raw[0], TIDY_CSV_COLUMNS.join(','));
    assert.strictEqual(raw[1], '2026-06-02T14:03:21.000Z,HUB-1,Zone B,Chameleon 1 - Soil tension (S1),soil,soil-src-abc123,swt_1,5,ARR-009,kPa,6.24');
    const daily = fs.readFileSync(path.join(dir, 'zu', 'daily.csv'), 'utf8').trim().split('\n');
    assert.strictEqual(daily[0], TIDY_CSV_COLUMNS.join(','));
    assert.strictEqual(daily[1], '2026-06-02T00:00:00.000Z,HUB-1,Zone B,Chameleon 1 - Soil tension (S1),soil,soil-src-abc123,swt_1,5,ARR-009,kPa,6.3');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildZoneExportCsv raw emits tidy rows with depth and source', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(12,'Zone B',1,'zb','UTC','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,chameleon_enabled,chameleon_swt1_depth_cm,created_at,updated_at)
        VALUES('AA00000000000001','Chameleon 1','DRAGINO_LSN50',1,12,1,5,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES
        ('AA00000000000001','2026-06-01T08:00:00.000Z',6.2),
        ('AA00000000000001','2026-06-01T09:00:00.000Z',6.4);
      INSERT INTO chameleon_readings(deveui,recorded_at,array_id) VALUES
        ('AA00000000000001','2026-06-01T08:00:00.000Z','ARR-001'),
        ('AA00000000000001','2026-06-01T09:00:00.000Z','ARR-001');
    `);
    const res = await helper.buildZoneExportCsv(db, {
      zoneId: 12,
      from: '2026-06-01',
      to: '2026-06-01',
      granularity: 'raw',
      nowMs: Date.parse('2026-06-03T00:00:00.000Z'),
    });
    assert.deepStrictEqual(res.columns, TIDY_CSV_COLUMNS);
    assert.strictEqual(res.rows.length, 4);
    const expectedSourceKey = `soil-src-${crypto.createHash('sha256').update('AA00000000000001').digest('hex').slice(0, 12)}`;
    const swt1 = res.rows.find((row) => row.channel_key === 'swt_1' && row.value === 6.2);
    assert.ok(swt1);
    assert.strictEqual(swt1.timestamp, '2026-06-01T08:00:00.000Z');
    assert.strictEqual(swt1.site, 'UNKNOWN');
    assert.strictEqual(swt1.zone, 'Zone B');
    assert.strictEqual(swt1.series_label, 'Chameleon 1 - Soil tension (S1)');
    assert.strictEqual(swt1.card_type, 'soil');
    assert.strictEqual(swt1.source_key, expectedSourceKey);
    assert.strictEqual(swt1.channel_key, 'swt_1');
    assert.strictEqual(swt1.depth_cm, 5);
    assert.strictEqual(swt1.array_id, 'ARR-001');
    assert.strictEqual(swt1.unit, 'kPa');
    assert.ok(!res.rows.some((row) => /[A-F0-9]{16}/.test(String(row.series_label))), 'no raw DevEUI');
  } finally {
    db.close();
  }
});

test('buildZoneExportCsv channels filter keeps only requested canonical channel keys', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(12,'Zone B',1,'zb','UTC','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,chameleon_enabled,chameleon_swt1_depth_cm,chameleon_swt2_depth_cm,created_at,updated_at)
        VALUES('AA00000000000001','Chameleon 1','DRAGINO_LSN50',1,12,1,5,15,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,swt_1,swt_2) VALUES
        ('AA00000000000001','2026-06-01T08:00:00.000Z',6.2,8.4);
    `);
    const res = await helper.buildZoneExportCsv(db, {
      zoneId: 12,
      from: '2026-06-01',
      to: '2026-06-01',
      granularity: 'raw',
      channels: ['swt_1'],
      nowMs: Date.parse('2026-06-03T00:00:00.000Z'),
    });
    assert.ok(res.rows.length > 0);
    assert.deepStrictEqual(Array.from(new Set(res.rows.map((row) => row.channel_key))).sort(), ['swt_1', 'swt_1_pf']);
  } finally {
    db.close();
  }
});

test('buildZoneExportCsv accepts legacy aliases but emits canonical channel keys', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(12,'Zone B',1,'zb','UTC','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,chameleon_enabled,chameleon_swt1_depth_cm,created_at,updated_at)
        VALUES('AA00000000000001','Chameleon 1','DRAGINO_LSN50',1,12,1,5,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,swt_1,swt_wm1) VALUES
        ('AA00000000000001','2026-06-01T08:00:00.000Z',6.2,61.2);
    `);
    const res = await helper.buildZoneExportCsv(db, {
      zoneId: 12,
      from: '2026-06-01',
      to: '2026-06-01',
      granularity: 'raw',
      channels: ['swt_wm1'],
      nowMs: Date.parse('2026-06-03T00:00:00.000Z'),
    });
    assert.ok(res.rows.length > 0);
    assert.ok(res.rows.every((row) => row.channel_key === 'swt_1' || row.channel_key === 'swt_1_pf'));
  } finally {
    db.close();
  }
});

test('kpaToPf matches the contract golden vectors', () => {
  assert.ok(Math.abs(helper.kpaToPf(10) - 2) < 1e-12);
  assert.ok(Math.abs(helper.kpaToPf(30) - 2.4771212547196626) < 1e-12);
  assert.ok(Math.abs(helper.kpaToPf(60) - 2.7781512503836436) < 1e-12);
  assert.ok(Math.abs(helper.kpaToPf(300) - 3.4771212547196626) < 1e-12);
  assert.strictEqual(helper.kpaToPf(0.1), 0);
  assert.strictEqual(helper.kpaToPf(0.05), 0);
  assert.strictEqual(helper.kpaToPf(0), 0);
  assert.strictEqual(helper.kpaToPf(-4), 0);
  assert.strictEqual(helper.kpaToPf(null), null);
  assert.strictEqual(helper.kpaToPf('nope'), null);
});

test('raw zone export pairs every SWT kPa row with a derived pF row', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(12,'Zone B',1,'zb','UTC','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,chameleon_enabled,chameleon_swt1_depth_cm,created_at,updated_at)
        VALUES('AA00000000000001','Chameleon 1','DRAGINO_LSN50',1,12,1,5,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES
        ('AA00000000000001','2026-06-01T08:00:00.000Z',6.2);
    `);
    const res = await helper.buildZoneExportCsv(db, {
      zoneId: 12,
      from: '2026-06-01',
      to: '2026-06-01',
      granularity: 'raw',
      nowMs: Date.parse('2026-06-03T00:00:00.000Z'),
    });
    assert.strictEqual(res.rows.length, 2);
    const kpaRow = res.rows.find((row) => row.channel_key === 'swt_1');
    const pfRow = res.rows.find((row) => row.channel_key === 'swt_1_pf');
    assert.ok(kpaRow, 'kPa row present');
    assert.ok(pfRow, 'pF row present');
    assert.strictEqual(pfRow.unit, 'pF');
    assert.strictEqual(pfRow.value, 1.7924);
    assert.strictEqual(pfRow.timestamp, kpaRow.timestamp);
    assert.strictEqual(pfRow.depth_cm, kpaRow.depth_cm);
    assert.strictEqual(pfRow.source_key, kpaRow.source_key);
    assert.strictEqual(pfRow.series_label, `${kpaRow.series_label} (pF)`);
  } finally {
    db.close();
  }
});

// Before the pF floor rule, 0 kPa had no pF row and 0.05 kPa wrote -0.301.
test('zone export writes the 0 pF floor for kPa at or below 0.1', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(12,'Zone B',1,'zb','UTC','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,chameleon_enabled,created_at,updated_at)
        VALUES('AA00000000000001','Chameleon 1','DRAGINO_LSN50',1,12,1,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES
        ('AA00000000000001','2026-06-01T08:00:00.000Z',0),
        ('AA00000000000001','2026-06-01T08:10:00.000Z',0.05),
        ('AA00000000000001','2026-06-01T08:20:00.000Z',0.1),
        ('AA00000000000001','2026-06-01T08:30:00.000Z',0.11),
        ('AA00000000000001','2026-06-01T08:40:00.000Z',-2),
        ('AA00000000000001','2026-06-01T08:50:00.000Z',NULL);
    `);
    const res = await helper.buildZoneExportCsv(db, {
      zoneId: 12,
      from: '2026-06-01',
      to: '2026-06-01',
      granularity: 'raw',
      nowMs: Date.parse('2026-06-03T00:00:00.000Z'),
    });
    const values = (channelKey) => res.rows
      .filter((row) => row.channel_key === channelKey)
      .map((row) => [row.timestamp.slice(11, 16), row.value]);
    assert.deepStrictEqual(values('swt_1'), [['08:00', 0], ['08:10', 0.05], ['08:20', 0.1], ['08:30', 0.11], ['08:40', -2]],
      'kPa rows unchanged, missing reading has no row');
    assert.deepStrictEqual(values('swt_1_pf'), [['08:00', 0], ['08:10', 0], ['08:20', 0], ['08:30', 0.0414], ['08:40', 0]],
      'pF rows floored at 0, never negative');
    assert.ok(res.rows.filter((row) => row.channel_key === 'swt_1_pf').every((row) => row.unit === 'pF'));
    const csv = helper.toCsv(res.columns, res.rows);
    assert.match(csv, /,swt_1_pf,[^,]*,[^,]*,pF,0\n/, 'floored pF written as 0 in the CSV body');
    assert.ok(!/,pF,-/.test(csv), 'no negative pF in the CSV body');
  } finally {
    db.close();
  }
});

test('aggregate zone export derives pF from the aggregated kPa mean', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(12,'Zone B',1,'zb','UTC','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,chameleon_enabled,created_at,updated_at)
        VALUES('AA00000000000001','Chameleon 1','DRAGINO_LSN50',1,12,1,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES
        ('AA00000000000001','2026-06-01T08:10:00.000Z',6.2),
        ('AA00000000000001','2026-06-01T08:20:00.000Z',6.4);
    `);
    const res = await helper.buildZoneExportCsv(db, {
      zoneId: 12,
      from: '2026-06-01',
      to: '2026-06-01',
      granularity: 'hourly',
      nowMs: Date.parse('2026-06-03T00:00:00.000Z'),
    });
    const pfRow = res.rows.find((row) => row.channel_key === 'swt_1_pf');
    assert.ok(pfRow, 'aggregate pF row present');
    assert.strictEqual(pfRow.unit, 'pF');
    assert.strictEqual(pfRow.value, 1.7993);
  } finally {
    db.close();
  }
});

test('buildZoneExportCsv rejects unknown channels with a structured 400', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(12,'Zone B',1,'zb','UTC','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
    `);
    await assert.rejects(
      () => helper.buildZoneExportCsv(db, {
        zoneId: 12,
        from: '2026-06-01',
        to: '2026-06-01',
        granularity: 'raw',
        channels: ['not_in_manifest'],
        nowMs: Date.parse('2026-06-03T00:00:00.000Z'),
      }),
      (error) => {
        assert.strictEqual(error.statusCode, 400);
        assert.match(error.message, /unknown channel/i);
        return true;
      }
    );
  } finally {
    db.close();
  }
});

test('buildZoneExportCsv accepts manifest-valid channels with no local edge source', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(12,'Zone B',1,'zb','UTC','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,chameleon_enabled,chameleon_swt1_depth_cm,created_at,updated_at)
        VALUES('AA00000000000001','Chameleon 1','DRAGINO_LSN50',1,12,1,5,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES
        ('AA00000000000001','2026-06-01T08:00:00.000Z',6.2);
    `);
    const res = await helper.buildZoneExportCsv(db, {
      zoneId: 12,
      from: '2026-06-01',
      to: '2026-06-01',
      granularity: 'raw',
      channels: ['vwc'],
      nowMs: Date.parse('2026-06-03T00:00:00.000Z'),
    });
    assert.deepStrictEqual(res.rows, []);
  } finally {
    db.close();
  }
});

test('buildZoneExportCsv aggregate keeps per-source rows with depth for merged cards', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(12,'Zone B',1,'zb','UTC','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,chameleon_enabled,chameleon_swt1_depth_cm,created_at,updated_at)
        VALUES
          ('AA00000000000001','Chameleon 1','DRAGINO_LSN50',1,12,1,5,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z'),
          ('AA00000000000002','Chameleon 2','DRAGINO_LSN50',1,12,1,15,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES
        ('AA00000000000001','2026-06-01T08:00:00.000Z',6.0),
        ('AA00000000000001','2026-06-01T09:00:00.000Z',6.4),
        ('AA00000000000002','2026-06-01T08:00:00.000Z',7.0),
        ('AA00000000000002','2026-06-01T09:00:00.000Z',7.4);
      INSERT INTO chameleon_readings(deveui,recorded_at,array_id) VALUES
        ('AA00000000000001','2026-06-01T08:00:00.000Z','ARR-001'),
        ('AA00000000000001','2026-06-01T09:00:00.000Z','ARR-001'),
        ('AA00000000000002','2026-06-01T08:00:00.000Z','ARR-002'),
        ('AA00000000000002','2026-06-01T09:00:00.000Z','ARR-002');
    `);
    const res = await helper.buildZoneExportCsv(db, {
      zoneId: 12,
      from: '2026-06-01',
      to: '2026-06-01',
      granularity: 'daily',
      nowMs: Date.parse('2026-06-03T00:00:00.000Z'),
    });
    assert.deepStrictEqual(res.columns, TIDY_CSV_COLUMNS);
    const swt1Rows = res.rows.filter((row) => row.channel_key === 'swt_1');
    assert.strictEqual(swt1Rows.length, 2);
    assert.ok(!swt1Rows.some((row) => row.series_label === '2 sources'), 'no blended source label');
    assert.ok(!swt1Rows.some((row) => row.depth_cm === '' || row.depth_cm === null || row.depth_cm === undefined), 'no blank soil depth');
    const c1 = swt1Rows.find((row) => row.series_label === 'Chameleon 1 - Soil tension (S1)');
    const c2 = swt1Rows.find((row) => row.series_label === 'Chameleon 2 - Soil tension (S1)');
    assert.ok(c1, 'Chameleon 1 row present');
    assert.ok(c2, 'Chameleon 2 row present');
    assert.strictEqual(c1.array_id, 'ARR-001');
    assert.strictEqual(c2.array_id, 'ARR-002');
    assert.strictEqual(c1.zone, 'Zone B');
    assert.strictEqual(c1.card_type, 'soil');
    assert.strictEqual(c1.channel_key, 'swt_1');
    assert.strictEqual(c1.depth_cm, 5);
    assert.strictEqual(c1.unit, 'kPa');
    assert.strictEqual(c1.value, 6.2);
    assert.strictEqual(c2.depth_cm, 15);
    assert.strictEqual(c2.value, 7.2);
    assert.ok(!res.rows.some((row) => /[A-F0-9]{16}/.test(String(row.series_label))), 'no raw DevEUI');
  } finally {
    db.close();
  }
});

test('buildZoneExportCsv daily keeps Europe Zurich DST samples in the correct local day', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(12,'Zone B',1,'zb','Europe/Zurich','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,chameleon_enabled,chameleon_swt1_depth_cm,created_at,updated_at)
        VALUES('AA00000000000001','Chameleon 1','DRAGINO_LSN50',1,12,1,5,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES
        ('AA00000000000001','2026-03-29T00:30:00.000Z',10),
        ('AA00000000000001','2026-03-29T22:30:00.000Z',20),
        ('AA00000000000001','2026-03-30T00:30:00.000Z',22),
        ('AA00000000000001','2026-10-25T20:30:00.000Z',30),
        ('AA00000000000001','2026-10-25T22:30:00.000Z',40),
        ('AA00000000000001','2026-10-25T23:30:00.000Z',50);
    `);

    const spring = await helper.buildZoneExportCsv(db, {
      zoneId: 12,
      from: '2026-03-29',
      to: '2026-03-30',
      granularity: 'daily',
      nowMs: Date.parse('2026-11-01T00:00:00.000Z'),
    });
    assert.deepStrictEqual(
      spring.rows.filter((row) => row.channel_key === 'swt_1').map((row) => ({
        timestamp: row.timestamp,
        value: row.value,
      })),
      [
        { timestamp: '2026-03-28T23:00:00.000Z', value: 10 },
        { timestamp: '2026-03-29T22:00:00.000Z', value: 21 },
      ]
    );

    const fall = await helper.buildZoneExportCsv(db, {
      zoneId: 12,
      from: '2026-10-25',
      to: '2026-10-26',
      granularity: 'daily',
      nowMs: Date.parse('2026-11-01T00:00:00.000Z'),
    });
    assert.deepStrictEqual(
      fall.rows.filter((row) => row.channel_key === 'swt_1').map((row) => ({
        timestamp: row.timestamp,
        value: row.value,
      })),
      [
        { timestamp: '2026-10-24T22:00:00.000Z', value: 35 },
        { timestamp: '2026-10-25T23:00:00.000Z', value: 50 },
      ]
    );
  } finally {
    db.close();
  }
});

test('buildZoneExportCsv rejects over-large raw ranges with a coarser granularity suggestion', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(12,'Zone B',1,'zb','UTC','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    `);
    await assert.rejects(
      () => helper.buildZoneExportCsv(db, {
        zoneId: 12,
        from: '2026-01-01',
        to: '2026-04-15',
        granularity: 'raw',
        nowMs: Date.parse('2026-06-03T00:00:00.000Z'),
      }),
      (error) => {
        assert.strictEqual(error.code, 'RANGE_TOO_LARGE');
        assert.strictEqual(error.statusCode, 413);
        assert.match(error.suggestion, /coarser granularity/);
        return true;
      }
    );
  } finally {
    db.close();
  }
});

test('buildZoneExportCsv rejects impossible calendar dates', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(12,'Zone B',1,'zb','UTC','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    `);
    await assert.rejects(
      () => helper.buildZoneExportCsv(db, {
        zoneId: 12,
        from: '2026-02-31',
        to: '2026-02-31',
        granularity: 'raw',
        nowMs: Date.parse('2026-06-03T00:00:00.000Z'),
      }),
      (error) => {
        assert.strictEqual(error.statusCode, 400);
        assert.match(error.message, /from must be YYYY-MM-DD/);
        return true;
      }
    );
  } finally {
    db.close();
  }
});

test('buildZoneExportCsv returns header-only row sets for empty valid ranges', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-06-01T00:00:00.000Z','2026-06-01T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(12,'Zone B',1,'zb','UTC','2026-06-01T00:00:00.000Z','2026-06-01T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,chameleon_enabled,chameleon_swt1_depth_cm,created_at,updated_at)
        VALUES('AA00000000000001','Chameleon 1','DRAGINO_LSN50',1,12,1,5,'2026-06-01T00:00:00.000Z','2026-06-01T00:00:00.000Z');
    `);
    const res = await helper.buildZoneExportCsv(db, {
      zoneId: 12,
      from: '2026-06-01',
      to: '2026-06-01',
      granularity: 'raw',
      nowMs: Date.parse('2026-06-03T00:00:00.000Z'),
    });
    assert.deepStrictEqual(res.columns, helper.RAW_CSV_COLUMNS);
    assert.deepStrictEqual(res.rows, []);
    assert.strictEqual(helper.toCsv(res.columns, res.rows), `${TIDY_CSV_COLUMNS.join(',')}\n`);
  } finally {
    db.close();
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
      INSERT INTO chameleon_readings(deveui,recorded_at,array_id) VALUES
        ('AA00000000000001','2026-06-02T08:10:00.000Z','ARR-007'),
        ('AA00000000000001','2026-06-02T08:40:00.000Z','ARR-007');
    `);

    const summary = await helper.runRollupJob(db, {
      nowMs: Date.parse('2026-06-03T02:00:00.000Z'),
      exportDir: dir,
      retentionDays: 90,
    });
    assert.strictEqual(summary.csvZonesWritten, 1);
    const raw = fs.readFileSync(path.join(dir, 'zu', 'raw', '2026-06-02.csv'), 'utf8');
    assert.match(raw, /^timestamp,site,zone,series_label,card_type,source_key,channel_key,depth_cm,array_id,unit,value/m);
    assert.match(raw, /2026-06-02T08:10:00.000Z,UNKNOWN,Zone B,Chameleon 1 - Soil tension \(S1\),soil,soil-src-[0-9a-f]{12},swt_1,5,ARR-007,kPa,10/);
    const hourly = fs.readFileSync(path.join(dir, 'zu', 'hourly', '2026-06-02.csv'), 'utf8');
    assert.match(hourly, /2026-06-02T08:00:00.000Z,UNKNOWN,Zone B,Chameleon 1 - Soil tension \(S1\),soil,soil-src-[0-9a-f]{12},swt_1,5,ARR-007,kPa,15/);
    const daily = fs.readFileSync(path.join(dir, 'zu', 'daily.csv'), 'utf8');
    assert.match(daily, /2026-06-02T00:00:00.000Z,UNKNOWN,Zone B,Chameleon 1 - Soil tension \(S1\),soil,soil-src-[0-9a-f]{12},swt_1,5,ARR-007,kPa,15/);
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

test('legacySensorHistory returns raw 24h points and aggregated long-range points', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(7,'Zone B',1,'zu','UTC','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at)
        VALUES('AA00000000000001','Soil','KIWI_SENSOR',1,7,'2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,swt_1,flow_liters_today) VALUES
        ('AA00000000000001','2026-06-02T09:00:00.000Z',42,8.5);
      INSERT INTO history_channel_rollups(
        zone_id, card_type, logical_source_key, channel_id, bucket_level, bucket_start, bucket_end,
        min_value, max_value, mean_value, median_value, latest_value, dominant_status,
        coverage_pct, coverage_confidence, sample_count, unit
      ) VALUES (
        7, 'soil', 'root-zone', 'swt_1', 'daily', '2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z',
        20, 35, 28, 29, 33, 'optimal', 87.5, 'derived', 12, 'kPa'
      );
    `);

    const raw = await helper.legacySensorHistory(db, {
      deveui: 'AA00000000000001',
      field: 'swt_1',
      hours: 24,
      nowMs: Date.parse('2026-06-02T12:00:00.000Z'),
    });
    assert.deepStrictEqual(raw, [{ t: '2026-06-02T09:00:00.000Z', value: 42 }]);

    const aggregate = await helper.legacySensorHistory(db, {
      deveui: 'AA00000000000001',
      field: 'swt_1',
      hours: 720,
      nowMs: Date.parse('2026-06-02T12:00:00.000Z'),
    });
    assert.deepStrictEqual(aggregate.map((point) => point.value), [33, 42]);
    assert.deepStrictEqual(aggregate.map((point) => point.t), [
      '2026-06-01T00:00:00.000Z',
      '2026-06-02T00:00:00.000Z',
    ]);

    const fallback = await helper.legacySensorHistory(db, {
      deveui: 'AA00000000000001',
      field: 'flow_liters_today',
      hours: 720,
      nowMs: Date.parse('2026-06-02T12:00:00.000Z'),
    });
    assert.deepStrictEqual(fallback, [{ t: '2026-06-02T09:00:00.000Z', value: 8.5 }]);
  } finally {
    db.close();
  }
});

test('mixed Watermark and Chameleon exports isolate SWT3 per device', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(7,'Mixed Zone',1,'mixed-zone','UTC','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,chameleon_enabled,created_at,updated_at)
        VALUES
          ('A84041A171000001','Watermark','DRAGINO_LSN50',1,7,0,'2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z'),
          ('A84041A171000002','Chameleon','DRAGINO_LSN50',1,7,1,'2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z'),
          ('A84041A171000003','SDI12','DRAGINO_SDI12',1,7,0,'2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,swt_1,swt_2,swt_3) VALUES
        ('A84041A171000001','2026-06-02T09:00:00.000Z',10,20,30),
        ('A84041A171000002','2026-06-02T09:00:00.000Z',11,21,31),
        ('A84041A171000003','2026-06-02T09:00:00.000Z',12,22,41);
    `);

    const options = {
      zoneId: 7,
      from: '2026-06-02',
      to: '2026-06-02',
      channels: 'swt_1,swt_3',
      nowMs: Date.parse('2026-06-03T00:00:00.000Z'),
    };
    const raw = await helper.buildZoneExportCsv(db, { ...options, granularity: 'raw' });
    const hourly = await helper.buildZoneExportCsv(db, { ...options, granularity: 'hourly' });
    const assertSwt3Isolation = (result) => {
      const swt3 = result.rows.filter((row) => row.channel_key === 'swt_3');
      assert.deepStrictEqual(swt3.map((row) => [row.source_key, row.value]), [
        ['soil-src-0c689a161d62', 41],
        ['soil-src-8b90b370f237', 31],
      ]);
    };
    assertSwt3Isolation(raw);
    assertSwt3Isolation(hourly);

    assert.strictEqual(await helper.resolveDeviceFieldRollupKey(db, 'A84041A171000001', 'swt_3'), null);
    assert.strictEqual((await helper.resolveDeviceFieldRollupKey(db, 'A84041A171000002', 'swt_3')).channelId, 'swt_3');
    assert.strictEqual((await helper.resolveDeviceFieldRollupKey(db, 'A84041A171000003', 'swt_3')).channelId, 'swt_3');
  } finally {
    db.close();
  }
});

// Rewritten with the farm-timezone change: the deprecated wrapper now takes
// its days from rainDailyHistory (the device's zone timezone, here Zurich in
// summer, +120) and ignores tzOffsetMin; it still answers the old array of
// days that have samples. The old offset clamp is gone; the days clamp stays.
test('legacyRainDailyHistory keeps the old array shape, with the farm timezone and no offset', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,timezone) VALUES(1,'A',1,'Europe/Zurich');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at)
        VALUES('AA00000000000002','Weather','SENSECAP_S2120',1,1,'2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,rain_mm_delta) VALUES
        ('AA00000000000002','2026-06-20T12:00:00.000Z',9.9),
        ('AA00000000000002','2026-06-30T22:30:00.000Z',1.2),
        ('AA00000000000002','2026-07-01T05:00:00.000Z',0.4),
        ('AA00000000000002','2026-07-01T23:00:00.000Z',2.0),
        ('AA00000000000002','2026-07-02T10:00:00.000Z',0),
        ('AA00000000000002','2026-07-02T11:00:00.000Z',NULL);
    `);

    // In Zurich (CEST): 06-30T22:30Z and 07-01T05:00Z land on 2026-07-01;
    // 07-01T23:00Z and 07-02T10:00Z land on 2026-07-02. NULL deltas are
    // excluded; the 06-20 row is outside the 7-day window (window start =
    // 2026-06-25T22:00:00Z for now=07-02T12:00Z). A viewer offset of -600
    // changes nothing.
    const week = await helper.legacyRainDailyHistory(db, {
      deveui: 'AA00000000000002',
      days: 7,
      tzOffsetMin: -600,
      userId: 1,
      nowMs: Date.parse('2026-07-02T12:00:00.000Z'),
    });
    assert.deepStrictEqual(week, [
      { day: '2026-07-01', total_mm: 1.6, samples: 2 },
      { day: '2026-07-02', total_mm: 2, samples: 2 },
    ]);

    const today = await helper.legacyRainDailyHistory(db, {
      deveui: 'AA00000000000002',
      days: 1,
      userId: 1,
      nowMs: Date.parse('2026-07-02T12:00:00.000Z'),
    });
    assert.deepStrictEqual(today, [{ day: '2026-07-02', total_mm: 2, samples: 2 }]);

    const otherUser = await helper.legacyRainDailyHistory(db, {
      deveui: 'AA00000000000002',
      days: 7,
      userId: 999,
      nowMs: Date.parse('2026-07-02T12:00:00.000Z'),
    });
    assert.deepStrictEqual(otherUser, []);

    // Clamping: days -> 366; the window starts at Zurich midnight 365 days back.
    const clamped = await helper.legacyRainDailyHistory(db, {
      deveui: 'AA00000000000002',
      days: 99999,
      tzOffsetMin: 99999,
      userId: 1,
      nowMs: Date.parse('2026-07-02T12:00:00.000Z'),
    });
    assert.deepStrictEqual(clamped.map((d) => d.day), ['2026-06-20', '2026-07-01', '2026-07-02']);
    assert.ok(db.lastQuery.params.includes('2025-07-01T22:00:00.000Z'), JSON.stringify(db.lastQuery.params));
    assert.ok(db.lastQuery.params.includes('2026-07-02T12:00:00.000Z'), JSON.stringify(db.lastQuery.params));
  } finally {
    db.close();
  }
});

test('resolveDeviceTimezones: zone, weather-station zone, unassigned, abbreviation, invalid, foreign', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-01-01','2026-01-01'),(2,'o','h','2026-01-01','2026-01-01');
      INSERT INTO irrigation_zones(id,name,user_id,timezone) VALUES(1,'A',1,'Europe/Zurich'),(2,'B',1,'CET'),(3,'C',1,'Mars/Olympus'),(4,'D',1,'America/Chicago');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at) VALUES
        ('A840410000000001','g1','AQUASCOPE_LORAIN',1,1,'2026-01-01','2026-01-01'),
        ('A840410000000002','g2','AQUASCOPE_LORAIN',1,2,'2026-01-01','2026-01-01'),
        ('A840410000000003','g3','AQUASCOPE_LORAIN',1,3,'2026-01-01','2026-01-01'),
        ('A840410000000004','wx','SENSECAP_S2120',1,NULL,'2026-01-01','2026-01-01'),
        ('A840410000000005','g5','AQUASCOPE_LORAIN',1,NULL,'2026-01-01','2026-01-01'),
        ('A840410000000006','g6','AQUASCOPE_LORAIN',2,4,'2026-01-01','2026-01-01');
      INSERT INTO weather_station_zones(deveui,zone_id) VALUES('A840410000000004',4),('A840410000000004',1);
    `);
    const map = await helper.resolveDeviceTimezones(db, [
      'A840410000000001', 'A840410000000002', 'A840410000000003', 'A840410000000004', 'A840410000000005', 'A840410000000006'], { userId: 1 });
    assert.deepStrictEqual(map.get('A840410000000001'), { timezone: 'Europe/Zurich', basis: 'zone' });
    assert.deepStrictEqual(map.get('A840410000000002'), { timezone: 'CET', basis: 'abbreviation' });
    assert.deepStrictEqual(map.get('A840410000000003'), { timezone: 'UTC', basis: 'invalid' });
    assert.deepStrictEqual(map.get('A840410000000004'), { timezone: 'Europe/Zurich', basis: 'weather_station_zone' });
    assert.deepStrictEqual(map.get('A840410000000005'), { timezone: 'UTC', basis: 'unassigned_default' });
    assert.deepStrictEqual(map.get('A840410000000006'), { timezone: 'UTC', basis: 'unassigned_default' }, 'no leak for a foreign device');

    // The single-device form answers the same, and a deleted zone no longer counts.
    assert.deepStrictEqual(await helper.resolveDeviceTimezone(db, 'a8:40:41:00:00:00:00:01', { userId: 1 }),
      { timezone: 'Europe/Zurich', basis: 'zone' });
    db.runSql(`UPDATE irrigation_zones SET deleted_at='2026-02-01' WHERE id=1;`);
    assert.deepStrictEqual(await helper.resolveDeviceTimezone(db, 'A840410000000001', { userId: 1 }),
      { timezone: 'UTC', basis: 'unassigned_default' });
    assert.deepStrictEqual(await helper.resolveDeviceTimezone(db, 'A840410000000004', { userId: 1 }),
      { timezone: 'America/Chicago', basis: 'weather_station_zone' }, 'lowest-id non-deleted station zone');
    assert.deepStrictEqual(await helper.resolveDeviceTimezone(db, 'not-a-eui', { userId: 1 }),
      { timezone: 'UTC', basis: 'unassigned_default' });
  } finally {
    db.close();
  }
});

// User 1, zone 1 in `timezone`, LoRain A840410000000001 in zone 1 owned by
// user 1, and device_data(recorded_at, rain_mm_delta) rows.
function seededRainDb(timezone, rows) {
  const db = createCliSqliteDb();
  const values = rows.map(([recordedAt, mm]) => `('A840410000000001',${sqliteEscape(recordedAt)},${sqliteEscape(mm)})`);
  db.runSql(`
    INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-01-01','2026-01-01');
    INSERT INTO irrigation_zones(id,name,user_id,timezone) VALUES(1,'A',1,${sqliteEscape(timezone)});
    INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at)
      VALUES('A840410000000001','g1','AQUASCOPE_LORAIN',1,1,'2026-01-01','2026-01-01');
    ${values.length ? `INSERT INTO device_data(deveui,recorded_at,rain_mm_delta) VALUES ${values.join(',')};` : ''}
  `);
  return db;
}

function rainDays(history) {
  return history.days.map((d) => [d.day, d.total_mm, d.samples]);
}

test('rainDailyHistory: Zurich days with the summer offset, whatever the viewer', async () => {
  // A sample at 2026-07-01T22:30Z is 00:30 on 2026-07-02 in Zurich (CEST, +120).
  // finding 9: a winter offset of +60 put it on 07-01.
  const db = seededRainDb('Europe/Zurich', [['2026-07-01T22:30:00.000Z', 1.0], ['2026-07-01T21:30:00.000Z', 0.5]]);
  try {
    const h = await helper.rainDailyHistory(db, { deveui: 'A840410000000001', days: 2, userId: 1, nowMs: Date.parse('2026-07-02T10:00:00Z') });
    assert.strictEqual(h.version, 2);
    assert.strictEqual(h.deveui, 'A840410000000001');
    assert.strictEqual(h.timezone, 'Europe/Zurich');
    assert.strictEqual(h.timezone_basis, 'zone');
    assert.deepStrictEqual(rainDays(h), [['2026-07-01', 0.5, 1], ['2026-07-02', 1, 1]]);
    assert.strictEqual(h.days[0].so_far, false);
    assert.strictEqual(h.days[1].so_far, true);
    assert.strictEqual(h.days[0].period_start, '2026-06-30T22:00:00.000Z');
    assert.strictEqual(h.days[0].period_end, '2026-07-01T22:00:00.000Z');
    assert.strictEqual(h.days[1].period_start, '2026-07-01T22:00:00.000Z');
    assert.strictEqual(h.days[1].period_end, '2026-07-02T10:00:00.000Z', 'the last day ends at the request time');
    assert.strictEqual(h.period_start, '2026-06-30T22:00:00.000Z');
    assert.strictEqual(h.period_end, '2026-07-02T10:00:00.000Z');
  } finally {
    db.close();
  }
});

test('rainDailyHistory: the 25-hour day of 2026-10-25 and the 23-hour day of 2026-03-29', async () => {
  const db = seededRainDb('Europe/Zurich', [['2026-10-25T23:30:00.000Z', 0.5], ['2026-03-28T23:30:00.000Z', 0.5]]);
  try {
    const oct = await helper.rainDailyHistory(db, { deveui: 'A840410000000001', days: 3, userId: 1, nowMs: Date.parse('2026-10-26T12:00:00Z') });
    assert.deepStrictEqual(oct.days.map((d) => d.day), ['2026-10-24', '2026-10-25', '2026-10-26']);
    const d25 = oct.days.find((d) => d.day === '2026-10-25');
    assert.strictEqual(d25.period_start, '2026-10-24T22:00:00.000Z', 'summer side: CEST, +120');
    assert.strictEqual(d25.period_end, '2026-10-25T23:00:00.000Z', 'winter side: CET, +60');
    assert.strictEqual(Date.parse(d25.period_end) - Date.parse(d25.period_start), 25 * 3600000);
    assert.strictEqual(oct.days.find((d) => d.day === '2026-10-26').total_mm, 0.5, '23:30Z on the 25th is 00:30 on the 26th (CET)');
    assert.strictEqual(d25.total_mm, null);
    const mar = await helper.rainDailyHistory(db, { deveui: 'A840410000000001', days: 3, userId: 1, nowMs: Date.parse('2026-03-30T12:00:00Z') });
    const d29 = mar.days.find((d) => d.day === '2026-03-29');
    assert.strictEqual(d29.period_start, '2026-03-28T23:00:00.000Z', 'winter side: CET, +60');
    assert.strictEqual(d29.period_end, '2026-03-29T22:00:00.000Z', 'summer side: CEST, +120');
    assert.strictEqual(Date.parse(d29.period_end) - Date.parse(d29.period_start), 23 * 3600000);
    assert.strictEqual(d29.total_mm, 0.5);
    assert.strictEqual(mar.days.find((d) => d.day === '2026-03-28').total_mm, null, '23:30Z on the 28th is 00:30 on the 29th (CET)');
  } finally {
    db.close();
  }
});

test('rainDailyHistory: Kampala, Sao Paulo and Kolkata days', async () => {
  const cases = [
    // Kampala: UTC+3, no DST. 21:30Z is 00:30 the next day.
    ['Africa/Kampala', '2026-07-01T21:30:00.000Z', '2026-07-01T20:30:00.000Z', '2026-06-30T21:00:00.000Z'],
    // Sao Paulo: UTC-3, no DST. 02:30Z on 07-02 is 23:30 on 07-01.
    ['America/Sao_Paulo', '2026-07-02T03:30:00.000Z', '2026-07-02T02:30:00.000Z', '2026-07-01T03:00:00.000Z'],
    // Kolkata: UTC+5:30. 18:45Z is 00:15 the next day, 18:15Z is 23:45.
    ['Asia/Kolkata', '2026-07-01T18:45:00.000Z', '2026-07-01T18:15:00.000Z', '2026-06-30T18:30:00.000Z'],
  ];
  for (const [timezone, secondDayRow, firstDayRow, firstDayStart] of cases) {
    const db = seededRainDb(timezone, [[secondDayRow, 2], [firstDayRow, 0.25]]);
    try {
      const h = await helper.rainDailyHistory(db, { deveui: 'A840410000000001', days: 2, userId: 1, nowMs: Date.parse('2026-07-02T12:00:00Z') });
      assert.strictEqual(h.timezone, timezone);
      assert.deepStrictEqual(rainDays(h), [['2026-07-01', 0.25, 1], ['2026-07-02', 2, 1]], timezone);
      assert.strictEqual(h.days[0].period_start, firstDayStart, timezone);
      assert.strictEqual(Date.parse(h.days[0].period_end) - Date.parse(h.days[0].period_start), 24 * 3600000, timezone);
    } finally {
      db.close();
    }
  }
});

test('rainDailyHistory: empty days are null, not zero; dry days are zero', async () => {
  const db = seededRainDb('UTC', [['2026-07-01T10:00:00.000Z', 0]]);
  try {
    const h = await helper.rainDailyHistory(db, { deveui: 'A840410000000001', days: 3, userId: 1, nowMs: Date.parse('2026-07-02T10:00:00Z') });
    assert.deepStrictEqual(h.days.map((d) => [d.day, d.total_mm, d.samples, d.quality]),
      [['2026-06-30', null, 0, 'received_only'], ['2026-07-01', 0, 1, 'received_only'], ['2026-07-02', null, 0, 'received_only']]);
  } finally {
    db.close();
  }
});

test('rainDailyHistory: a SQLite-shaped recorded_at is read as UTC, not the host zone', async () => {
  const db = seededRainDb('Europe/Zurich', [['2026-07-01 22:30:00', 1.5], ['2026-07-01T22:10:00.000+01:00', 0.5]]);
  try {
    const h = await helper.rainDailyHistory(db, { deveui: 'A840410000000001', days: 2, userId: 1, nowMs: Date.parse('2026-07-02T10:00:00Z') });
    assert.deepStrictEqual(rainDays(h), [['2026-07-01', 0.5, 1], ['2026-07-02', 1.5, 1]]);
  } finally {
    db.close();
  }
});

test('rainDailyHistory: a foreign device leaks nothing', async () => {
  const db = seededRainDb('Europe/Zurich', [['2026-07-01T10:00:00.000Z', 3]]);
  try {
    const h = await helper.rainDailyHistory(db, { deveui: 'A840410000000001', days: 2, userId: 999, nowMs: Date.parse('2026-07-02T10:00:00Z') });
    assert.strictEqual(h.timezone, 'UTC');
    assert.strictEqual(h.timezone_basis, 'unassigned_default');
    assert.strictEqual(h.days.length, 2);
    assert.ok(h.days.every((d) => d.samples === 0 && d.total_mm === null));
  } finally {
    db.close();
  }
});

test('rainDailyHistory: an abbreviation zone keeps its value and its flag; days clamp to 1..366', async () => {
  const db = seededRainDb('CET', [['2026-07-01T22:30:00.000Z', 1]]);
  try {
    const h = await helper.rainDailyHistory(db, { deveui: 'A840410000000001', days: 99999, userId: 1, nowMs: Date.parse('2026-07-02T10:00:00Z') });
    assert.strictEqual(h.timezone, 'CET');
    assert.strictEqual(h.timezone_basis, 'abbreviation');
    assert.strictEqual(h.days.length, 366);
    assert.strictEqual(h.days[0].day, '2025-07-02');
    assert.strictEqual(h.days[365].day, '2026-07-02');
    assert.strictEqual(h.days[365].total_mm, 1);
    const one = await helper.rainDailyHistory(db, { deveui: 'A840410000000001', days: 0, userId: 1, nowMs: Date.parse('2026-07-02T10:00:00Z') });
    assert.strictEqual(one.days.length, 1);
  } finally {
    db.close();
  }
});

test('legacySensorHistory keeps dendro history response fields stable', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(7,'Zone B',1,'zu','UTC','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,dendro_enabled,created_at,updated_at)
        VALUES('AA00000000000001','Dendro','DRAGINO_LSN50',1,7,1,'2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO device_data(
        deveui,recorded_at,dendro_position_raw_mm,dendro_position_mm,dendro_delta_mm,
        dendro_stem_change_um,adc_ch0v,adc_ch1v,dendro_ratio,dendro_mode_used,dendro_saturated,dendro_saturation_side,dendro_valid
      ) VALUES (
        'AA00000000000001','2026-06-02T09:00:00.000Z',11.2,10.9,0.4,120,0.77,0.42,1.83,'ratio',0,NULL,1
      );
    `);

    const points = await helper.legacySensorHistory(db, {
      deveui: 'AA00000000000001',
      mode: 'dendro',
      hours: 24,
      nowMs: Date.parse('2026-06-02T12:00:00.000Z'),
    });
    assert.deepStrictEqual(points, [{
      t: '2026-06-02T09:00:00.000Z',
      position_raw_mm: 11.2,
      position_mm: 10.9,
      delta_mm: 0.4,
      stem_change_um: 120,
      adc_v: 0.77,
      adc_ch0v: 0.77,
      adc_ch1v: 0.42,
      dendro_ratio: 1.83,
      dendro_mode_used: 'ratio',
      saturated: 0,
      saturation_side: null,
      valid: 1,
    }]);
  } finally {
    db.close();
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
    // Whole-date text bounds for the index, then each row's instant (strftime)
    // against the range, widened by a millisecond for SQLite's rounding.
    assert.match(db.lastQuery.sql, /recorded_at >= \? AND recorded_at < \? AND strftime\('%Y-%m-%dT%H:%M:%fZ', recorded_at\) >= \? AND strftime\('%Y-%m-%dT%H:%M:%fZ', recorded_at\) <= \?/);
    assert.match(db.lastQuery.sql, /ORDER BY deveui ASC, recorded_at ASC/);
    assert(!/ORDER BY recorded_at ASC\b/.test(db.lastQuery.sql), 'query must not sort by recorded_at alone');
    assert(!db.lastQuery.sql.includes('AA00000000000001'), 'query must keep DevEUIs in params');
    const dayMs = 24 * 60 * 60 * 1000;
    assert.deepStrictEqual(db.lastQuery.params.slice(0, 6), [
      'AA00000000000001', 'AA00000000000002',
      new Date(Date.parse(iso(0)) - dayMs).toISOString().slice(0, 10),
      new Date(Date.parse(iso(60)) + 2 * dayMs).toISOString().slice(0, 10),
      new Date(Date.parse(iso(0)) - 1).toISOString(),
      new Date(Date.parse(iso(60)) + 1).toISOString(),
    ]);

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
    assert.deepStrictEqual(db.lastQuery.params.slice(0, 5), [
      'AA00000000000001', '2026-05-30', '2026-07-02', '2026-05-30T23:59:59.999Z', '2026-06-30T00:00:00.001Z',
    ]);
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

// --- data-coverage-gap: future time must not count as missing data ---
test('data-coverage-gap interpretation ignores future time in window', () => {
  const base = {
    cardType: 'dendro',
    generatedAt: '2026-07-11T12:00:00.000Z',
    coverageConfidence: 'configured',
    rangeFrom: '2026-07-01T00:00:00.000Z',
    rangeTo: '2026-08-01T00:00:00.000Z',
  };
  const realGap = helper.buildLocalInterpretations({ ...base, coveragePct: 15 });
  assert(
    realGap.some((item) => item.ruleId === 'data-coverage-gap'),
    'coverage gap must still fire for genuinely low elapsed coverage',
  );

  const pastWindow = helper.buildLocalInterpretations({
    ...base,
    rangeFrom: '2026-06-01T00:00:00.000Z',
    rangeTo: '2026-06-30T00:00:00.000Z',
    coveragePct: 70,
  });
  assert(
    pastWindow.some((item) => item.ruleId === 'data-coverage-gap'),
    'past windows keep the plain <80% threshold',
  );

  const fullyFuture = helper.buildLocalInterpretations({
    ...base,
    rangeFrom: '2026-08-01T00:00:00.000Z',
    rangeTo: '2026-09-01T00:00:00.000Z',
    coveragePct: null,
    coverageConfidence: 'unknown',
  });
  assert(
    !fullyFuture.some((item) => item.ruleId === 'data-coverage-gap'),
    'fully-future windows must not warn about missing data',
  );
});

test('verify-sync-flow chains SQL-backed history helper regression tests', () => {
  const verifySource = fs.readFileSync(path.join(repoRoot, 'scripts', 'verify-sync-flow.js'), 'utf8');
  assert.match(verifySource, /test-history-helper\.js/);
  assert(!/execFileSync\(process\.execPath,\s*\[path\.resolve\(__dirname,\s*['"]verify-sync-flow\.js['"]\)/.test(verifySource), 'verify-sync-flow must not recursively execute itself');
});

test('rollupRowsToResult rejects rows spanning multiple logical source keys', () => {
  const row = (key, mean) => ({
    bucket_start: '2026-07-01T00:00:00.000Z',
    bucket_end: '2026-07-02T00:00:00.000Z',
    logical_source_key: key,
    channel_id: 'swt_1',
    min_value: mean, max_value: mean, mean_value: mean, median_value: mean, latest_value: mean,
    dominant_status: null, sample_count: 4, event_count: 0, threshold_crossing_count: 0,
    coverage_pct: 100, coverage_confidence: 'configured', unit: 'kPa',
  });
  assert.throws(
    () => helper.rollupRowsToResult(
      [row('root-zone', 10), row('src-aa01', 30)],
      { aggregation: 'daily' },
      [{ id: 'swt_1', field: 'swt_1', fields: ['swt_1'], unit: 'kPa' }],
    ),
    /single logical_source_key/,
  );
});

test('rollupRowsToResult builds buckets from single-key rows', () => {
  const rows = [{
    bucket_start: '2026-07-01T00:00:00.000Z',
    bucket_end: '2026-07-02T00:00:00.000Z',
    logical_source_key: 'root-zone',
    channel_id: 'swt_1',
    min_value: 5, max_value: 15, mean_value: 10, median_value: 10, latest_value: 15,
    dominant_status: null, sample_count: 4, event_count: 0, threshold_crossing_count: 0,
    coverage_pct: 100, coverage_confidence: 'configured', unit: 'kPa',
  }];
  const result = helper.rollupRowsToResult(rows, { aggregation: 'daily' }, [{ id: 'swt_1', field: 'swt_1', fields: ['swt_1'], unit: 'kPa' }]);
  assert.strictEqual(result.buckets.length, 1);
  assert.strictEqual(result.buckets[0].series.swt_1.mean, 10);
  // history_channel_rollups has no sum column (final fix A5): a rolled-up
  // bucket never reports a channel total, only a live aggregateRows call
  // over device_data can.
  assert.strictEqual(result.buckets[0].series.swt_1.sum, null);
  assert.strictEqual(result.buckets[0].sampleCount, 4);
});

test('computeRollupBuckets merges a multi-device scope into ONE combined row per bucket/channel', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(7,'Z',1,'zu','UTC','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at) VALUES
        ('AA00000000000001','Temp A','DRAGINO_LSN50',1,7,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z'),
        ('AA00000000000002','Temp B','DRAGINO_LSN50',1,7,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,ext_temperature_c) VALUES
        ('AA00000000000001','2026-06-01T08:10:00.000Z',10),
        ('AA00000000000002','2026-06-01T08:20:00.000Z',30),
        ('AA00000000000001','2026-06-01T08:40:00.000Z',20),
        ('AA00000000000002','2026-06-01T08:50:00.000Z',40);
    `);
    const scope = {
      zoneId: 7,
      cardType: 'environment',
      logicalSourceKey: 'microclimate',
      channels: [{ id: 'ext_temperature_c', field: 'ext_temperature_c', unit: 'C' }],
      deveuis: ['AA00000000000001', 'AA00000000000002'],
      timezone: 'UTC',
    };
    const rows = await helper.computeRollupBuckets(db, scope, 'hourly', 24 * 3600 * 1000, Date.parse('2026-06-02T00:00:00.000Z'));
    const hourRows = rows.filter((row) => row.channel_id === 'ext_temperature_c' && row.bucket_start === '2026-06-01T08:00:00.000Z');
    assert.strictEqual(hourRows.length, 1, 'exactly ONE combined row for the merged scope');
    assert.strictEqual(hourRows[0].logical_source_key, 'microclimate');
    assert.strictEqual(hourRows[0].mean_value, 25);
    assert.strictEqual(hourRows[0].min_value, 10);
    assert.strictEqual(hourRows[0].max_value, 40);
    assert.strictEqual(hourRows[0].sample_count, 4);
  } finally {
    db.close();
  }
});

test('aggregateRows clamps coverage denominators at now for in-progress windows', () => {
  const rows = [
    { deveui: 'AA00000000000001', recorded_at: '2026-07-11T00:10:00.000Z', ext_temperature_c: 20 },
    { deveui: 'AA00000000000001', recorded_at: '2026-07-11T05:50:00.000Z', ext_temperature_c: 22 },
  ];
  const result = helper.aggregateRows(rows, {
    aggregation: 'daily',
    channels: [{ id: 'ext_temperature_c', field: 'ext_temperature_c', unit: 'C' }],
    start: '2026-07-11T00:00:00.000Z',
    end: '2026-07-12T00:00:00.000Z',
    timezone: 'UTC',
    nowMs: Date.parse('2026-07-11T06:00:00.000Z'),
    expectedCadences: { AA00000000000001: { seconds: 1200, confidence: 'configured' } },
  });
  assert.ok(result.coveragePct > 10 && result.coveragePct < 12,
    `coverage must be computed over elapsed time only, got ${result.coveragePct}`);
  assert.strictEqual(result.buckets.length, 1);
  assert.ok(result.buckets[0].coveragePct > 10 && result.buckets[0].coveragePct < 12);
});

test('aggregateRows leaves completed-window coverage unchanged by the clamp', () => {
  const rows = [
    { deveui: 'AA00000000000001', recorded_at: '2026-07-10T00:10:00.000Z', ext_temperature_c: 20 },
  ];
  const result = helper.aggregateRows(rows, {
    aggregation: 'daily',
    channels: [{ id: 'ext_temperature_c', field: 'ext_temperature_c', unit: 'C' }],
    start: '2026-07-10T00:00:00.000Z',
    end: '2026-07-11T00:00:00.000Z',
    timezone: 'UTC',
    nowMs: Date.parse('2026-07-12T00:00:00.000Z'),
    expectedCadences: { AA00000000000001: { seconds: 1200, confidence: 'configured' } },
  });
  assert.ok(result.coveragePct < 2, `completed windows keep the full denominator, got ${result.coveragePct}`);
});

test('aggregateRows reports null coverage for fully-future windows and buckets', () => {
  const result = helper.aggregateRows([], {
    aggregation: 'daily',
    channels: [{ id: 'ext_temperature_c', field: 'ext_temperature_c', unit: 'C' }],
    start: '2026-07-12T00:00:00.000Z',
    end: '2026-07-13T00:00:00.000Z',
    timezone: 'UTC',
    nowMs: Date.parse('2026-07-11T06:00:00.000Z'),
    expectedCadences: { AA00000000000001: { seconds: 1200, confidence: 'configured' } },
  });
  assert.strictEqual(result.coveragePct, null);
  assert.strictEqual(result.buckets.length, 1);
  assert.strictEqual(result.buckets[0].coveragePct, null);
});
