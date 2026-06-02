import test from 'node:test';
import assert from 'node:assert/strict';
import { orientationFromQuery } from '../src/history/useOrientation';

test('maps matchMedia result to orientation', () => {
  assert.equal(orientationFromQuery(true), 'landscape');
  assert.equal(orientationFromQuery(false), 'portrait');
});
