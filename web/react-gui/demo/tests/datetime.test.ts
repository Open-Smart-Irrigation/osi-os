import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatTime, createDateFormatter} from '../datetime';
test('demo time uses Kampala by default and preserves explicit timezone overrides', () => {
  const at = '2026-09-29T09:00:00Z';
  assert.equal(formatTime(at, 'en'), '12:00 PM');
  assert.equal(createDateFormatter('en').time(at), '12:00 PM');
  assert.equal(formatTime(at, 'en', {timeZone: 'UTC'}), '09:00 AM');
});
