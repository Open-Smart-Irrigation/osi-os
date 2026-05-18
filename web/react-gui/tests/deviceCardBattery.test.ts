import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDeviceFooterMeta,
  getBatteryPercentFromVoltage,
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

test('rejects values that would otherwise coerce missing battery state to zero', () => {
  assert.equal(getValidBatteryPercent(' '), null);
  assert.equal(getValidBatteryPercent('\t'), null);
  assert.equal(getValidBatteryPercent(false), null);
  assert.equal(getValidBatteryPercent(true), null);
});

test('rejects out-of-range percentages', () => {
  assert.equal(getValidBatteryPercent(-1), null);
  assert.equal(getValidBatteryPercent(101), null);
});

test('formats footer copy without a fake battery prefix', () => {
  assert.equal(buildDeviceFooterMeta({ batPct: null, lastSeenLabel: '5 min ago' }), '5 min ago');
  assert.equal(buildDeviceFooterMeta({ batPct: 84, lastSeenLabel: '5 min ago' }), '🔋 84% · 5 min ago');
});

test('derives LSN50 battery percent from the usable voltage range', () => {
  assert.equal(getBatteryPercentFromVoltage(3.6), 100);
  assert.equal(getBatteryPercentFromVoltage(3.5), 93);
  assert.equal(getBatteryPercentFromVoltage(3.3), 80);
  assert.equal(getBatteryPercentFromVoltage(2.45), 23);
  assert.equal(getBatteryPercentFromVoltage(2.1), 0);
});

test('clamps and rejects invalid LSN50 voltage-derived battery percent', () => {
  assert.equal(getBatteryPercentFromVoltage(3.7), 100);
  assert.equal(getBatteryPercentFromVoltage(1.9), 0);
  assert.equal(getBatteryPercentFromVoltage(null), null);
  assert.equal(getBatteryPercentFromVoltage(''), null);
  assert.equal(getBatteryPercentFromVoltage('abc'), null);
});

test('uses explicit battery percent before voltage-derived LSN50 percent', () => {
  assert.equal(buildDeviceFooterMeta({ batPct: 55, batV: 3.6, lastSeenLabel: '5 min ago' }), '🔋 55% · 5 min ago');
  assert.equal(buildDeviceFooterMeta({ batPct: null, batV: 3.5, lastSeenLabel: '5 min ago' }), '🔋 93% · 5 min ago');
});
