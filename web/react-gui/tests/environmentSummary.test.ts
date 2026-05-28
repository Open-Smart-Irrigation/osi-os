import test from 'node:test';
import assert from 'node:assert/strict';
import { formatForecastHighLow } from '../src/utils/forecastFormat';

test('formats high/low when both finite', () => {
  assert.equal(formatForecastHighLow(28.4, 14.6), '28°/15°');
});

test('returns Unavailable when either side is null', () => {
  assert.equal(formatForecastHighLow(null, 14.6), 'Unavailable');
  assert.equal(formatForecastHighLow(28.4, null), 'Unavailable');
  assert.equal(formatForecastHighLow(undefined, null), 'Unavailable');
});

test('treats 0 as a valid value, not Unavailable', () => {
  assert.equal(formatForecastHighLow(0, -3), '0°/-3°');
});
