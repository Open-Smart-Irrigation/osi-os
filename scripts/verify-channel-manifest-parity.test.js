'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const VERIFY = path.join(__dirname, 'verify-channel-manifest-parity.js');
const CANONICAL_ANALYSIS = path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.js'
);

function runVerifier() {
  return cp.spawnSync(process.execPath, [VERIFY], { cwd: ROOT, encoding: 'utf8' });
}

function withAnalysisMutation(mutate, callback) {
  const original = fs.readFileSync(CANONICAL_ANALYSIS, 'utf8');
  try {
    fs.writeFileSync(CANONICAL_ANALYSIS, mutate(original));
    return callback();
  } finally {
    fs.writeFileSync(CANONICAL_ANALYSIS, original);
  }
}

test('channel parity verifier accepts the four declared device-health keys', () => {
  const result = runVerifier();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /DEVICE_HEALTH_CHANNELS exactly matches/);
});

test('channel parity verifier rejects a device-health key mutation', () => {
  const result = withAnalysisMutation(
    (source) => source.replace("key: 'bat_v'", "key: 'bat_v_mutated'"),
    runVerifier
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /DEVICE_HEALTH_CHANNELS|bat_v/);
});

test('channel parity verifier rejects a device-health edge-field mutation', () => {
  const result = withAnalysisMutation(
    (source) => source.replace("edgeField: 'bat_v'", "edgeField: 'bat_v_mutated'"),
    runVerifier
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /DEVICE_HEALTH_CHANNELS|bat_v/);
});
