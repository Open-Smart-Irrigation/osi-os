'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('./requeue-rejected-outbox-policy');

function receipt(overrides = {}) {
  return {
    cloudReplayRequest: {
      eventUuid: 'event-1',
      expectedGatewayEui: 'AABBCCDDEEFF0011',
      expectedReason: 'ownership_precondition_missing',
    },
    cloudReplayResponse: {
      eventUuid: 'event-1',
      outcome: 'APPLIED',
      reason: null,
      replayAttemptCount: 1,
      attemptedAt: '2026-09-23T10:00:00.000Z',
    },
    ...overrides,
  };
}

test('validates the repairable receipt and exact event identity', () => {
  assert.doesNotThrow(() => policy.validateReceipt(receipt(), {
    eventUuid: 'event-1',
    gatewayDeviceEui: 'AABBCCDDEEFF0011',
    rejectionCode: 'ownership_precondition_missing',
    rejectionClass: 'REPAIRABLE',
  }));
  assert.throws(() => policy.validateReceipt(receipt({
    cloudReplayResponse: { ...receipt().cloudReplayResponse, eventUuid: 'event-2' },
  }), { eventUuid: 'event-1', gatewayDeviceEui: 'AABBCCDDEEFF0011' }), /eventUuid/);
  const aliased = receipt();
  aliased.request = aliased.cloudReplayRequest;
  aliased.response = aliased.cloudReplayResponse;
  delete aliased.cloudReplayRequest;
  delete aliased.cloudReplayResponse;
  assert.doesNotThrow(() => policy.validateReceipt(aliased, {
    eventUuid: 'event-1', gatewayDeviceEui: 'AABBCCDDEEFF0011',
  }));
});

test('only APPLIED and ALREADY_APPLIED can clear a rejected row', () => {
  for (const outcome of ['STILL_REJECTED', 'RETRYABLE_ERROR']) {
    assert.throws(() => policy.validateReceipt(receipt({
      cloudReplayResponse: { ...receipt().cloudReplayResponse, outcome },
    }), { eventUuid: 'event-1', gatewayDeviceEui: 'AABBCCDDEEFF0011' }), /outcome/);
  }
  assert.doesNotThrow(() => policy.validateReceipt(receipt({
    cloudReplayResponse: { ...receipt().cloudReplayResponse, outcome: 'ALREADY_APPLIED' },
  }), { eventUuid: 'event-1', gatewayDeviceEui: 'AABBCCDDEEFF0011' }));
});

test('event UUID selection is bounded and rejects duplicates or broad filters', () => {
  assert.deepEqual(policy.parseEventUuidList(['event-1', 'event-2']), ['event-1', 'event-2']);
  assert.throws(() => policy.parseEventUuidList(['event-1', 'event-1']), /duplicate/);
  assert.throws(() => policy.parseEventUuidList(['event-1 OR 1=1']), /invalid/);
  assert.throws(() => policy.parseEventUuidList(Array.from({ length: policy.MAX_EVENT_UUIDS + 1 }, (_, i) => `e-${i}`)), /at most/);
  assert.throws(() => policy.parseEventUuidList([]), /at least one/);
});
