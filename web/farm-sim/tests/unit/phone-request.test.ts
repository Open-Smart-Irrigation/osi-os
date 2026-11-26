import assert from 'node:assert/strict';
import {test} from 'node:test';
import {wrapPhoneRequest} from '../../src/phone/request';

const path = '/api/irrigation-zones/1/environment-summary';
const ok = <T>(data: T) => ({status: 200, headers: {}, data});
const refusal = () => 'game notice';

test('the phone wrapper rewrites weather text and day icons without mutating the cached answer', () => {
  const description = 'Weather conditions';
  const data = {
    online: {current: {description, airTemperatureC: 31}},
    forecast: {rainFocus: {daily: [0, 0.01, 0.05, 3.2, null].map(rainMm => ({rainMm, description, weatherCode: null}))}},
  };
  const before = structuredClone(data);
  const wrap = wrapPhoneRequest(() => ok(data), () => 'Illustrative current conditions (game)', refusal);
  const result = wrap('GET', path + '?days=7').data as typeof data;
  assert.equal(result.online.current.description, 'Illustrative current conditions (game)');
  assert.equal(result.online.current.airTemperatureC, 31);
  assert.deepEqual(result.forecast.rainFocus.daily.map(row => row.description), ['clear', 'clear', 'rain', 'rain', description]);
  assert.deepEqual(data, before);
});

test('a T1 summary with no current weather or forecast passes through intact', () => {
  const data = {online: {current: null}, forecast: {rainFocus: null}};
  const wrap = wrapPhoneRequest(() => ok(data), () => assert.fail('Absent weather must stay absent'), refusal);
  assert.deepEqual(wrap('GET', path), ok(data));
});

test('a refusal includes localized game text while simulator-handled answers pass through', () => {
  for (const error of ['game_refused', 'game_tier', 'phone_asleep', 'actuation_handed_off'] as const) {
    const response = {
      status: error === 'actuation_handed_off' ? 409 : 403, headers: {}, data: {error, message: 'parent text'},
    };
    const wrap = wrapPhoneRequest(() => response, () => assert.fail('Refusal is not a summary'), code => code + ' notice');
    assert.deepEqual(wrap('PUT', '/api/system/settings'), {
      ...response, data: {error, message: error.startsWith('game_') ? error + ' notice' : 'parent text'},
    });
    assert.equal(response.data.message, 'parent text');
  }
});
