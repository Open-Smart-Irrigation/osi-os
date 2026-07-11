'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const analytics = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-analytics');

const CONTRACT_ROOT = path.join(__dirname, '../docs/contracts/dendro');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(CONTRACT_ROOT, relativePath), 'utf8'));
}

function loadCase(caseName) {
  return {
    input: readJson(`cases/${caseName}.input.json`),
    expected: readJson(`cases/${caseName}.expected.json`),
  };
}

function normalizeOutput(input, output) {
  return output.map((point, index) => ({
    date: input.points[index].date,
    envelope_ref_um: point.envelopeRef,
    twd_night_um: point.twdNight,
    twd_day_um: point.twdDay,
    mds_um: point.mds,
  }));
}

test('edge dendro analytics matches shared DailyPoint contract fixtures', () => {
  const manifest = readJson('MANIFEST.json');
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(Array.isArray(manifest.cases));
  assert.notEqual(manifest.cases.length, 0);

  for (const caseName of manifest.cases) {
    const { input, expected } = loadCase(caseName);
    const sequence = input.points.map((point) => ({
      date: point.date,
      dMax: point.d_max_um,
      dMin: point.d_min_um,
    }));
    const output = analytics.computeEnvelope(sequence, input.method || 'stepwise');
    assert.deepEqual(
      { results: normalizeOutput(input, output) },
      expected,
      `shared dendro contract case failed: ${caseName}`,
    );
  }
});
