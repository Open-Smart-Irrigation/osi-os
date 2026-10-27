#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const edgeRoot = path.resolve(__dirname, '..');
const cloudRoot = process.env.HISTORY_SOURCE_CLOUD_ROOT
  ? path.resolve(process.env.HISTORY_SOURCE_CLOUD_ROOT)
  : path.resolve(edgeRoot, '../osi-server');
const edgeFixtureRoot = path.join(edgeRoot, 'docs/contracts/history-source-v2');
const cloudFixtureRoot = path.join(cloudRoot, 'backend/src/test/resources/history-source-v2');
const manifest = JSON.parse(fs.readFileSync(path.join(edgeFixtureRoot, 'MANIFEST.json'), 'utf8'));
const synthetic = JSON.parse(fs.readFileSync(path.join(edgeFixtureRoot, 'synthetic-cases.json'), 'utf8'));

function verifyResponseFixture(host, response, expectedValues) {
  assert.equal(response.seriesIdentityVersion, 2, `${host} response marker`);
  assert.equal(response.series.length, expectedValues.length, `${host} series count`);
  const requiredSeriesFields = [
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
  for (const [index, series] of response.series.entries()) {
    for (const field of requiredSeriesFields) {
      assert.ok(Object.prototype.hasOwnProperty.call(series, field), `${host} series[${index}] has ${field}`);
    }
    assert.equal(series.metadataBasis, 'current_configuration', `${host} series[${index}] metadata basis`);
    assert.equal(series.points.length, 3, `${host} series[${index}] point count`);
    for (const [pointIndex, point] of series.points.entries()) {
      for (const field of ['t', 'bucketStart', 'bucketEnd', 'value']) {
        assert.ok(Object.prototype.hasOwnProperty.call(point, field), `${host} series[${index}].points[${pointIndex}] has ${field}`);
      }
    }
  }
  for (const [index, values] of expectedValues.entries()) {
    assert.deepEqual(
      response.series[index].points.map((point) => point.value),
      values,
      `${host} series[${index}] values`
    );
  }
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

for (const relativePath of manifest.files) {
  const edgePath = path.join(edgeFixtureRoot, relativePath);
  const cloudPath = path.join(cloudFixtureRoot, relativePath);
  assert.equal(fs.existsSync(edgePath), true, `edge fixture exists: ${relativePath}`);
  assert.equal(fs.existsSync(cloudPath), true, `cloud fixture exists: ${relativePath}`);
  assert.equal(sha256(cloudPath), sha256(edgePath), `fixture bytes match: ${relativePath}`);
}

const fixtureCase = synthetic.fiveObservationCase;
assert.equal(synthetic.schemaVersion, 2, 'synthetic fixture schema version');
const expectedValues = fixtureCase.expectedSeries.map((series) => series.values);
verifyResponseFixture('edge', fixtureCase.expectedResponses.edge, expectedValues);
verifyResponseFixture('cloud', fixtureCase.expectedResponses.cloud, expectedValues);

console.log(`history-source-v2 fixture parity PASS (${manifest.files.length} files)`);
