import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDeviceFooterMeta,
  getValidBatteryPercent,
} from '../src/components/farming/shared/deviceCardBattery.ts';

test('accepts finite battery percentages from 0 to 100', () => {
  assert.equal(getValidBatteryPercent(84), 84);
  assert.equal(getValidBatteryPercent('12.6'), 13);
  assert.equal(getValidBatteryPercent(0), 0);
  assert.equal(getValidBatteryPercent(100), 100);
});

test('rejects nullish and invalid values instead of coercing them to zero', () => {
  assert.equal(getValidBatteryPercent(null), null);
  assert.equal(getValidBatteryPercent(undefined), null);
  assert.equal(getValidBatteryPercent(''), null);
  assert.equal(getValidBatteryPercent('abc'), null);
});

test('rejects out-of-range percentages', () => {
  assert.equal(getValidBatteryPercent(-1), null);
  assert.equal(getValidBatteryPercent(101), null);
});

test('formats footer copy without a fake battery prefix', () => {
  assert.equal(buildDeviceFooterMeta({ batPct: null, lastSeenLabel: '5 min ago' }), '5 min ago');
  assert.equal(buildDeviceFooterMeta({ batPct: 84, lastSeenLabel: '5 min ago' }), '🔋 84% · 5 min ago');
});
