'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('crypto');
const analysisModule = require('./analysis.js');

test('analysisSeriesId is a deterministic sha256-based id', () => {
  const idA = analysisModule.analysisSeriesId(1, 'soil', 'soil-src-abc123', 'swt_1');
  const idB = analysisModule.analysisSeriesId(1, 'soil', 'soil-src-abc123', 'swt_1');
  assert.equal(idA, idB);
  assert.match(idA, /^[0-9a-f]{16}$/);

  const expected = crypto
    .createHash('sha256')
    .update('1|soil|soil-src-abc123|swt_1')
    .digest('hex')
    .slice(0, 16);
  assert.equal(idA, expected);

  const idDifferentChannel = analysisModule.analysisSeriesId(1, 'soil', 'soil-src-abc123', 'swt_2');
  assert.notEqual(idA, idDifferentChannel);

  const idDifferentZone = analysisModule.analysisSeriesId(2, 'soil', 'soil-src-abc123', 'swt_1');
  assert.notEqual(idA, idDifferentZone);
});

test('createAnalysis returns the expected API surface bound to injected deps', () => {
  const deps = {
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: async () => [],
    deriveCardsForZone: () => [],
    displayDeviceName: () => 'Device',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: () => null,
    sourceDevicesForCard: () => [],
    sourceKeyForCsv: () => 'source-key',
  };
  const analysis = analysisModule.createAnalysis(deps);

  assert.equal(typeof analysis.buildAnalysisCatalog, 'function');
  assert.equal(typeof analysis.resolveAnalysisSeries, 'function');
  assert.equal(typeof analysis.listAnalysisViews, 'function');
  assert.equal(typeof analysis.saveAnalysisView, 'function');
  assert.equal(analysis.analysisSeriesId, analysisModule.analysisSeriesId);
  assert.equal(analysis.ANALYSIS_VIEWS_SCHEMA, analysisModule.ANALYSIS_VIEWS_SCHEMA);
  assert.match(analysis.ANALYSIS_VIEWS_SCHEMA, /CREATE TABLE IF NOT EXISTS analysis_views/);
});

test('createAnalysis works without deps supplied (pure structural check)', () => {
  const analysis = analysisModule.createAnalysis();
  assert.equal(typeof analysis.buildAnalysisCatalog, 'function');
  assert.equal(typeof analysis.resolveAnalysisSeries, 'function');
  assert.equal(typeof analysis.listAnalysisViews, 'function');
  assert.equal(typeof analysis.saveAnalysisView, 'function');
});

test('buildAnalysisCatalog filters zones by supplied owned-plus-granted UUIDs', async () => {
  const calls = [];
  const analysis = analysisModule.createAnalysis({
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: async (_db, sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM irrigation_zones')) {
        return [{ id: 2, zone_uuid: 'z-granted', name: 'Granted' }];
      }
      return [];
    },
    deriveCardsForZone: () => [],
    displayDeviceName: () => 'Device',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: () => null,
    sourceDevicesForCard: () => [],
    sourceKeyForCsv: () => 'source-key',
  });

  await analysis.buildAnalysisCatalog({}, {
    userId: 2,
    zoneUuids: ['z-owned', 'z-granted'],
  });

  assert.match(calls[0].sql, /zone_uuid IN \(\?,\?\)/);
  assert.deepEqual(calls[0].params, ['z-owned', 'z-granted']);
  assert.doesNotMatch(calls[1].sql, /user_id = \?/);
  assert.deepEqual(calls[1].params, [2]);
});

test('buildAnalysisCatalog preserves the legacy owner filter without a scope list', async () => {
  const calls = [];
  const analysis = analysisModule.createAnalysis({
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: async (_db, sql, params) => {
      calls.push({ sql, params });
      return [];
    },
    deriveCardsForZone: () => [],
    displayDeviceName: () => 'Device',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: () => null,
    sourceDevicesForCard: () => [],
    sourceKeyForCsv: () => 'source-key',
  });

  await analysis.buildAnalysisCatalog({}, { userId: 7 });

  assert.match(calls[0].sql, /user_id = \?/);
  assert.deepEqual(calls[0].params, [7]);
});

test('buildAnalysisCatalog exposes only configured Sentek soil channels', async () => {
  const sentek = {
    deveui: '0011223344556677',
    type_id: 'DRAGINO_SDI12',
    sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
    soil_moisture_probe_depths_json: JSON.stringify({ vwc_1: 0, vwc_8: 80 }),
  };
  const analysis = analysisModule.createAnalysis({
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: async (_db, sql) => sql.includes('FROM irrigation_zones')
      ? [{ id: 2, zone_uuid: 'zone-2', name: 'Sentek block' }]
      : [sentek],
    deriveCardsForZone: () => [{ cardType: 'soil' }],
    displayDeviceName: () => 'Sentek-01',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: () => null,
    sourceDevicesForCard: () => [sentek],
    sourceKeyForCsv: () => 'sentek-01',
  });

  const catalog = await analysis.buildAnalysisCatalog({}, { userId: 7 });

  assert.deepEqual(catalog.channels.map((entry) => entry.channelKey), [
    'vwc_1',
    'vwc_8',
  ]);
  assert.ok(catalog.channels.every((entry) => !entry.channelKey.startsWith('swt_')));
});

test('buildAnalysisCatalog keeps explicit Chameleon SWT capability ahead of other configuration', async () => {
  const chameleon = {
    deveui: '8899AABBCCDDEEFF',
    type_id: 'KIWI_SENSOR',
    chameleon_enabled: 1,
    soil_moisture_probe_depths_json: JSON.stringify({ vwc_1: 12.5 }),
  };
  const analysis = analysisModule.createAnalysis({
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: async (_db, sql) => sql.includes('FROM irrigation_zones')
      ? [{ id: 3, zone_uuid: 'zone-3', name: 'Chameleon block' }]
      : [chameleon],
    deriveCardsForZone: () => [{ cardType: 'soil' }],
    displayDeviceName: () => 'Chameleon',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: () => null,
    sourceDevicesForCard: () => [chameleon],
    sourceKeyForCsv: () => 'chameleon',
  });

  const catalog = await analysis.buildAnalysisCatalog({}, { userId: 7 });

  assert.deepEqual(catalog.channels.map((entry) => entry.channelKey), ['swt_1', 'swt_2', 'swt_3']);
});

test('buildAnalysisCatalog uses the two canonical Kiwi SWT channels without state', async () => {
  const kiwi = { deveui: '1020304050607080', type_id: 'KIWI_SENSOR' };
  const analysis = analysisModule.createAnalysis({
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: async (_db, sql) => sql.includes('FROM irrigation_zones')
      ? [{ id: 4, zone_uuid: 'zone-4', name: 'Kiwi block' }]
      : [kiwi],
    deriveCardsForZone: () => [{ cardType: 'soil' }],
    displayDeviceName: () => 'Kiwi',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: () => null,
    sourceDevicesForCard: () => [kiwi],
    sourceKeyForCsv: () => 'kiwi',
  });

  const catalog = await analysis.buildAnalysisCatalog({}, { userId: 7 });

  assert.deepEqual(catalog.channels.map((entry) => entry.channelKey), ['swt_1', 'swt_2']);
});
