'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-rejection-recovery');

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
  assert.doesNotThrow(() => policy.validateReceipt(receipt({
    cloudReplayResponse: { ...receipt().cloudReplayResponse, replayAttemptCount: 0 },
  }), { eventUuid: 'event-1', gatewayDeviceEui: 'AABBCCDDEEFF0011' }));
});

test('event UUID selection is bounded and rejects duplicates or broad filters', () => {
  assert.deepEqual(policy.parseEventUuidList(['event-1', 'event-2']), ['event-1', 'event-2']);
  assert.throws(() => policy.parseEventUuidList(['event-1', 'event-1']), /duplicate/);
  assert.throws(() => policy.parseEventUuidList(['event-1 OR 1=1']), /invalid/);
  assert.throws(() => policy.parseEventUuidList(Array.from({ length: policy.MAX_EVENT_UUIDS + 1 }, (_, i) => `e-${i}`)), /at most/);
  assert.throws(() => policy.parseEventUuidList([]), /at least one/);
});

test('recovery requires a complete exact envelope before receipt validation', () => {
  const row = {
    event_uuid: 'event-1', aggregate_type: 'DEVICE_DATA', aggregate_key: 'k1',
    op: 'DEVICE_DATA_APPENDED', payload_json: '{"value":1}', sync_version: 2,
    occurred_at: '2026-09-23T09:00:00Z', gateway_device_eui: 'AABBCCDDEEFF0011',
    delivered_at: null, rejected_at: '2026-09-23T09:30:00Z', rejection_code: 'ownership_precondition_missing',
    rejection_class: 'REPAIRABLE', recovery_generation: 0,
  };
  assert.doesNotThrow(() => policy.validateRecoverableRow(row, 'event-1'));
  for (const field of ['event_uuid', 'aggregate_type', 'aggregate_key', 'op', 'occurred_at', 'gateway_device_eui']) {
    assert.throws(() => policy.validateRecoverableRow({ ...row, [field]: '' }, 'event-1'), /non-empty|incomplete/);
  }
  assert.throws(() => policy.validateRecoverableRow({ ...row, sync_version: -1 }, 'event-1'), /incomplete/);
});
