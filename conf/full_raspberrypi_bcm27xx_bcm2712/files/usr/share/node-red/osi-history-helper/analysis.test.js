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
