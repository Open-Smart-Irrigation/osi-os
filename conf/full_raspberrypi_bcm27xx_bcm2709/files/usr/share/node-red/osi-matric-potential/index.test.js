'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vectors = require('../../../../../../../docs/contracts/matric-potential/vectors.json');
const { kpaToPf, pfToKpa } = require('./index');

function assertClose(actual, expected) {
  if (expected === null) {
    assert.equal(actual, null);
    return;
  }
  const error = Math.abs(actual - expected);
  const scale = Math.max(1, Math.abs(expected));
  assert.ok(error <= vectors.absolute_tolerance || error / scale <= vectors.relative_tolerance,
    `${actual} is not within tolerance of ${expected}`);
}

test('kPa to pF follows the signed-potential magnitude vectors', () => {
  for (const vector of vectors.kpa_to_pf) assertClose(kpaToPf(vector.input), vector.expected);
});

test('pF to kPa follows the finite positive inverse vectors', () => {
  for (const vector of vectors.pf_to_kpa) assertClose(pfToKpa(vector.input), vector.expected);
});

test('matric-potential inputs are strict finite numbers', () => {
  for (const value of [null, undefined, '', '10', true, false, NaN, Infinity, -Infinity]) {
    assert.equal(kpaToPf(value), null, `kpaToPf(${String(value)})`);
    assert.equal(pfToKpa(value), null, `pfToKpa(${String(value)})`);
  }
  assert.equal(kpaToPf(0), null);
  assert.equal(kpaToPf(-0), null);
  assert.equal(pfToKpa(-400), null);
  assert.equal(pfToKpa(400), null);
});
