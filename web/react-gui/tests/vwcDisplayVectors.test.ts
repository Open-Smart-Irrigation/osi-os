import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  VWC_PCT_RANGE,
  VWC_SERIES_COLORS,
  formatVwcPercent,
  summarizeZoneVwc,
  vwcChannelDepthCm,
  vwcDerivation,
  vwcProfileQualification,
  vwcReadingState,
  type VwcDeviceLike,
} from '../src/utils/vwc.ts';
import { SENSOR_FRESHNESS_WINDOW_MS } from '../src/utils/zoneSoil.ts';

interface Vector<I, E> { input: I; expected: E }

const contract = JSON.parse(readFileSync(
  join(import.meta.dirname, '..', '..', '..', 'docs', 'contracts', 'vwc-display', 'vectors.json'),
  'utf8',
)) as {
  contract: string;
  bounds: { min_pct: number; max_pct: number; freshness_window_ms: number; clock_skew_ms: number };
  series_colors: { vwc: string; soil_vic: string };
  reading_state: Vector<unknown, string>[];
  non_json_inputs: Record<string, string[]>;
  format: Vector<unknown, string | null>[];
  qualification: Vector<string | null, string | null>[];
  derivation: Vector<string | null, string>[];
  depth: Array<{ name: string; device: VwcDeviceLike; key: string; expected: number | null }>;
  zone_summary: { now: string; cases: Array<{ name: string; devices: VwcDeviceLike[]; expected: unknown }> };
};

const NON_JSON: Record<string, unknown> = {
  undefined,
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  '-Infinity': Number.NEGATIVE_INFINITY,
};

test('the contract is the one this test was written against', () => {
  assert.equal(contract.contract, 'vwc-display-v1');
  assert.deepEqual(VWC_PCT_RANGE, [contract.bounds.min_pct, contract.bounds.max_pct]);
  assert.equal(SENSOR_FRESHNESS_WINDOW_MS, contract.bounds.freshness_window_ms);
  assert.deepEqual(VWC_SERIES_COLORS, contract.series_colors);
});

for (const { input, expected } of contract.reading_state) {
  test(`vwcReadingState(${JSON.stringify(input)}) is ${expected}`, () => {
    assert.equal(vwcReadingState(input), expected);
  });
}

test('values JSON cannot carry have the reading state the contract names', () => {
  for (const [expected, names] of Object.entries(contract.non_json_inputs)) {
    for (const name of names) {
      assert.ok(name in NON_JSON, `unknown non-JSON input ${name}`);
      assert.equal(vwcReadingState(NON_JSON[name]), expected, name);
      assert.equal(formatVwcPercent(NON_JSON[name]), null, name);
    }
  }
});

for (const { input, expected } of contract.format) {
  test(`formatVwcPercent(${JSON.stringify(input)}) is ${JSON.stringify(expected)}`, () => {
    assert.equal(formatVwcPercent(input), expected);
  });
}

for (const { input, expected } of contract.qualification) {
  test(`vwcProfileQualification(${JSON.stringify(input)}) is ${expected}`, () => {
    assert.equal(vwcProfileQualification(input), expected);
  });
}

for (const { input, expected } of contract.derivation) {
  test(`vwcDerivation(${JSON.stringify(input)}) is ${expected}`, () => {
    assert.equal(vwcDerivation(input), expected);
  });
}

for (const { name, device, key, expected } of contract.depth) {
  test(`depth: ${name}`, () => {
    assert.equal(vwcChannelDepthCm(device, key), expected);
  });
}

const nowMs = Date.parse(contract.zone_summary.now);
for (const { name, devices, expected } of contract.zone_summary.cases) {
  test(`zone summary: ${name}`, () => {
    assert.deepEqual(summarizeZoneVwc(devices, nowMs), expected);
  });
}
