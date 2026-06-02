import test from 'node:test';
import assert from 'node:assert/strict';
import { soilStatusVisual } from '../src/history/soilStatus';

test('maps statuses to colour + label tokens', () => {
  assert.deepEqual(soilStatusVisual('wet_excess'), {
    tone: 'wet',
    colorVar: 'var(--soil-wet)',
    labelKey: 'history.soil.state.wet',
  });
  assert.deepEqual(soilStatusVisual('optimal'), {
    tone: 'moist',
    colorVar: 'var(--soil-moist)',
    labelKey: 'history.soil.state.moist',
  });
  assert.deepEqual(soilStatusVisual('dry_stress'), {
    tone: 'dry',
    colorVar: 'var(--soil-dry)',
    labelKey: 'history.soil.state.dry',
  });
  assert.equal(soilStatusVisual('no_data'), null);
  assert.equal(soilStatusVisual('anything-else'), null);
});
