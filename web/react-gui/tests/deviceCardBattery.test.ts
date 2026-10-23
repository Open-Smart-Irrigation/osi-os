import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isDerivedBatteryPercent,
  getBatteryPercentFromVoltage,
  getValidBatteryPercent,
} from '../src/components/farming/shared/deviceCardBattery.ts';
import { footerBattery } from '../src/components/farming/shared/deviceCardFooterModel.ts';

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

test('shows no footer battery rather than a fake one', () => {
  assert.equal(footerBattery(null), null);
  assert.deepEqual(footerBattery(84), { percent: 84, low: false, derived: false });
});

test('marks a footer battery below 20 % as low', () => {
  assert.equal(footerBattery(20)?.low, false);
  assert.equal(footerBattery(19)?.low, true);
  assert.equal(footerBattery(0)?.low, true);
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
  assert.deepEqual(footerBattery(55, 3.6), { percent: 55, low: false, derived: false });
  // Derived from voltage, so it is marked as an estimate: an LSN50's LiSOCl2
  // cell holds ~3.6 V across most of its life and then falls off a cliff, so a
  // flat "100%" beside a real bat_pct two rows below reads as a measurement.
  assert.deepEqual(footerBattery(null, 3.5), { percent: 93, low: false, derived: true });
  assert.equal(isDerivedBatteryPercent({ batPct: null, batV: 3.5 }), true);
  assert.equal(isDerivedBatteryPercent({ batPct: 55, batV: 3.6 }), false);
  assert.equal(isDerivedBatteryPercent({ batPct: null, batV: null }), false);
});
