import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { classifySwtWaterStatus, SWT_KPA_RANGE } from '../src/utils/swt.ts';

const contract = JSON.parse(readFileSync(
  join(import.meta.dirname, '..', '..', '..', 'docs', 'contracts', 'swt-water-status', 'vectors.json'),
  'utf8',
)) as {
  contract: string;
  bands: { max_kpa: number };
  implementations: Record<string, { max_kpa: number }>;
  classify: Array<{ input: unknown; expected: 'wet' | 'moist' | 'dry' | null }>;
  non_json_inputs: { expected: null; inputs: string[] };
};

const NON_JSON: Record<string, unknown> = {
  undefined,
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  '-Infinity': Number.NEGATIVE_INFINITY,
};

const edgeMaxKpa = contract.implementations['osi-os web/react-gui'].max_kpa;

test('the contract is the one this test was written against', () => {
  assert.equal(contract.contract, 'swt-water-status-v1');
  assert.equal(edgeMaxKpa, SWT_KPA_RANGE[1]);
  assert.ok(edgeMaxKpa <= contract.bands.max_kpa);
});

for (const { input, expected } of contract.classify) {
  // A vector above this GUI's declared cap is invalid here, not dry.
  const expectedHere = typeof input === 'number' && input > edgeMaxKpa ? null : expected;
  test(`classifySwtWaterStatus(${JSON.stringify(input)}) is ${expectedHere}`, () => {
    assert.equal(classifySwtWaterStatus(input), expectedHere);
  });
}

test('values JSON cannot carry classify as nothing', () => {
  for (const name of contract.non_json_inputs.inputs) {
    assert.ok(name in NON_JSON, `unknown non-JSON input ${name}`);
    assert.equal(classifySwtWaterStatus(NON_JSON[name]), contract.non_json_inputs.expected, name);
  }
});

test('the declared edge cap is the cap the classifier applies', () => {
  assert.equal(classifySwtWaterStatus(edgeMaxKpa), 'dry');
  assert.equal(classifySwtWaterStatus(edgeMaxKpa + 0.001), null);
});
