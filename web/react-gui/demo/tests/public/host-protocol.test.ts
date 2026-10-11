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
});

test('accepts only app messages with the exact channel shape and known language', () => {
  assert.equal(isAppMessage({channel, type: 'ready'}), true);
  assert.equal(isAppMessage({channel, type: 'language', value: 'de-CH'}), true);
  assert.equal(isAppMessage({channel, type: 'language', value: 'xx'}), false);
  assert.equal(isAppMessage({channel, type: 'ready', extra: true}), false);
  assert.equal(isAppMessage({channel, type: 'time', value: Number.NaN}), false);
  assert.equal(isAppMessage({channel, type: 'startup-error', message: 'failed', extra: true}), false);
});
