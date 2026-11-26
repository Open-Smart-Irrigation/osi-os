import assert from 'node:assert/strict';
import test from 'node:test';
import {namedStream, sfc32} from '../../src/core/rng';

test('sfc32 matches the four-word reference sequence', () => {
  const draw = sfc32(1, 2, 3, 4);
  assert.deepEqual(Array.from({length: 8}, () => draw() * 2 ** 32),
    [7, 34, 56623200, 188882296, 3431242869, 399395954, 785775158, 3843710725]);
});

test('stream keys isolate systems and forecast date pairs', () => {
  const baseline = namedStream(41, 'weather');
  const weather = namedStream(41, 'weather');
  const crop = namedStream(41, 'crop');
  const firstDay = '2027-01-11';
  const secondDay = '2027-01-12';
  const thirdDay = '2027-01-13';
  const first = namedStream(41, 'forecast', firstDay, thirdDay);
  const second = namedStream(41, 'forecast', secondDay, thirdDay);
  for (let i = 0; i < 30; i++) {
    crop();
    assert.equal(weather(), baseline());
  }
  assert.notEqual(first(), second());
  assert.notEqual(namedStream(41, 'forecast', firstDay, secondDay)(), namedStream(41, 'forecast', firstDay, thirdDay)());
  assert.notEqual(namedStream(42, 'weather')(), namedStream(41, 'weather')());
});
