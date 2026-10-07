'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { assertDeviceHealthChannels } = require('./device-health-channel-contract');

const ROOT = path.resolve(__dirname, '..');
const VERIFY = path.join(__dirname, 'verify-channel-manifest-parity.js');

const manifestEntries = [
  { key: 'bat_v', unit: 'V', edgeField: 'bat_v', cardType: 'gateway', exportable: false },
  { key: 'bat_pct', unit: '%', edgeField: 'bat_pct', cardType: 'gateway', exportable: false },
  { key: 'valve_1_pulse', unit: 'count', edgeField: 'valve_1_pulse', cardType: 'gateway', exportable: false },
  { key: 'valve_2_pulse', unit: 'count', edgeField: 'valve_2_pulse', cardType: 'gateway', exportable: false },
];

const healthEntries = [
  { key: 'bat_v', unit: 'V', edgeField: 'bat_v', cardType: 'device_health', exportable: false, aggregation: 'mean' },
  { key: 'bat_pct', unit: '%', edgeField: 'bat_pct', cardType: 'device_health', exportable: false, aggregation: 'mean' },
  { key: 'valve_1_pulse', unit: 'count', edgeField: 'valve_1_pulse', cardType: 'device_health', exportable: false, aggregation: 'latest' },
  { key: 'valve_2_pulse', unit: 'count', edgeField: 'valve_2_pulse', cardType: 'device_health', exportable: false, aggregation: 'latest' },
];

function runVerifier() {
  return cp.spawnSync(process.execPath, [VERIFY], { cwd: ROOT, encoding: 'utf8' });
}

test('channel parity validator accepts the four declared device-health keys', () => {
  assert.equal(assertDeviceHealthChannels(healthEntries, manifestEntries, 'fixture'), 4);
  const result = runVerifier();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /DEVICE_HEALTH_CHANNELS exactly matches/);
});

test('channel parity validator rejects a device-health key mutation without touching production files', () => {
  const mutated = healthEntries.map((entry) => ({ ...entry }));
  mutated[0].key = 'bat_v_mutated';
  assert.throws(
    () => assertDeviceHealthChannels(mutated, manifestEntries, 'fixture'),
    /key mismatch/
  );
});

test('channel parity validator rejects a device-health edge-field mutation', () => {
  const mutated = healthEntries.map((entry) => ({ ...entry }));
  mutated[0].edgeField = 'bat_v_mutated';
  assert.throws(
    () => assertDeviceHealthChannels(mutated, manifestEntries, 'fixture'),
    /metadata mismatch for bat_v/
  );
});

test('channel parity validator rejects wrong device-health aggregation', () => {
  const mutated = healthEntries.map((entry) => ({ ...entry }));
  mutated[2].aggregation = 'mean';
  assert.throws(
    () => assertDeviceHealthChannels(mutated, manifestEntries, 'fixture'),
    /metadata mismatch for valve_1_pulse/
  );
});

test('channel parity CLI accepts the four declared device-health keys', () => {
  const result = runVerifier();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /DEVICE_HEALTH_CHANNELS exactly matches/);
});
