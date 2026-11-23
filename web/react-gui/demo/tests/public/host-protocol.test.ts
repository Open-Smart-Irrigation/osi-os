import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isAppMessage, isHostCommand} from '../../protocol';

const channel = 'osi-mobile-simulator-v1';

test('accepts only the exact next-event host command', () => {
  assert.equal(isHostCommand({channel, type: 'next-event'}), true);
  assert.equal(isHostCommand({channel, type: 'next-event', value: true}), false);
  assert.equal(isHostCommand({channel, type: 'next-event', extra: 'ignored'}), false);
  assert.equal(isHostCommand({channel, type: 'speed', value: 60}), true);
  assert.equal(isHostCommand({channel, type: 'speed', value: 30}), false);
  assert.equal(isHostCommand({channel, type: 'active', value: false, extra: 'ignored'}), false);
  assert.equal(isHostCommand({channel, type: 'guide', step: 'inspect-plot'}), true);
  assert.equal(isHostCommand({channel, type: 'guide', step: 'make-it-rain'}), false);
  assert.equal(isHostCommand({channel, type: 'clear-guide'}), true);
});

test('accepts only app messages with the exact channel shape and known language', () => {
  assert.equal(isAppMessage({channel, type: 'ready'}), true);
  assert.equal(isAppMessage({channel, type: 'language', value: 'de-CH'}), true);
  assert.equal(isAppMessage({channel, type: 'language', value: 'xx'}), false);
  assert.equal(isAppMessage({channel, type: 'ready', extra: true}), false);
  assert.equal(isAppMessage({channel, type: 'time', value: 0, timeZone: 'Africa/Kampala'}), true);
  assert.equal(isAppMessage({channel, type: 'time', value: 0, timeZone: 'not-a-zone'}), false);
  assert.equal(isAppMessage({channel, type: 'next-event', at: null, kind: null}), true);
  assert.equal(isAppMessage({channel, type: 'guide-result', step: 'schedule', status: 'ready'}), true);
  assert.equal(isAppMessage({channel, type: 'guide-result', step: 'schedule', status: 'unsupported'}), false);
  assert.equal(isAppMessage({channel, type: 'startup-error', message: 'failed', extra: true}), false);
});
