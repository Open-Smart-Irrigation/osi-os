'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const flowPath = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';
const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
const policy = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-rejection-recovery');
const nodeById = (id) => {
  const node = flow.find((entry) => entry.id === id);
  assert.ok(node, `missing flow node ${id}`);
  return node;
};

test('force sync exposes exact outbox recovery counts and code groups', () => {
  const source = String(nodeById('sync-force-build').func);
  for (const key of ['selected', 'applied', 'duplicate', 'retryable', 'rejected', 'protocolErrors', 'pendingAfter']) {
    assert.match(source, new RegExp('\\b' + key + '\\b'), `missing force sync count ${key}`);
  }
  assert.match(source, /rejectedByCode/);
  assert.match(source, /fresh/i);
  assert.match(source, /exactly one|duplicate result|missing result/i);
});

test('force sync classifies results by UUID and exact rejection code/class pairs', () => {
  const source = String(nodeById('sync-force-build').func);
  const start = source.indexOf('const rejectionPolicyLoad');
  const end = source.indexOf('\nsummary.outbox.selected = 0;', start);
  assert.ok(start >= 0 && end > start, 'isolated classification function is present');
  const classify = new Function('osiLib', `${source.slice(start, end)}\nreturn classifySyncResults;`)({ require: () => ({ ok: true, value: policy }) });
  const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((event_uuid) => ({ event_uuid }));
  const result = classify(rows, [
    { eventUuid: 'a', status: 'APPLIED' },
    { eventUuid: 'b', status: 'DUPLICATE' },
    { eventUuid: 'c', status: 'REJECTED', rejectionCode: 'stale_sync_version', rejectionClass: 'PERMANENT', reason: 'diagnostic' },
    { eventUuid: 'd', status: 'REJECTED', rejectionCode: 'invented_code', rejectionClass: 'PERMANENT', reason: 'diagnostic' },
    { eventUuid: 'e', status: 'RETRYABLE_ERROR' },
    { eventUuid: 'g', status: 'ALREADY_APPLIED' },
    { eventUuid: 'h', status: 'REJECTED', rejectionCode: 'parent_missing', rejectionClass: 'RETRYABLE' },
    { eventUuid: 'unsolicited', status: 'APPLIED' },
    {},
  ]);
  assert.equal(result.selected, 8);
  assert.deepEqual(result.applied, ['a']);
  assert.deepEqual(result.duplicate, ['b']);
  assert.deepEqual(result.retryable, ['d', 'e', 'f', 'g', 'h']);
  assert.deepEqual(result.rejected.map(({ eventUuid, code, rejectionClass, eligible }) => ({ eventUuid, code, rejectionClass, eligible })), [
    { eventUuid: 'c', code: 'stale_sync_version', rejectionClass: 'PERMANENT', eligible: false },
  ]);
  assert.equal(result.protocolErrors, 6);
});

test('missing result arrays count one protocol error per selected UUID', () => {
  const source = String(nodeById('sync-force-build').func);
  const start = source.indexOf('const rejectionPolicyLoad');
  const end = source.indexOf('\nsummary.outbox.selected = 0;', start);
  const classify = new Function('osiLib', `${source.slice(start, end)}\nreturn classifySyncResults;`)({ require: () => ({ ok: true, value: policy }) });
  const result = classify([{ event_uuid: 'a' }, { event_uuid: 'b' }], null);
  assert.deepEqual(result.retryable, ['a', 'b']);
  assert.equal(result.protocolErrors, 2);
});

test('scheduled outbox marking persists typed rejection fields and rejects legacy terminal aliases', () => {
  const source = String(nodeById('sync-outbox-mark').func);
  assert.match(source, /osiLib\.require\('rejection-recovery'\)/);
  assert.match(source, /rejection_code/);
  assert.match(source, /rejection_class/);
  assert.doesNotMatch(source, /status === 'ALREADY_APPLIED'/);
  assert.match(source, /protocol_response_malformed_rejection/);
});

test('both maintained flow profiles are byte-identical', () => {
  const mirrorPath = 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json';
  assert.equal(fs.readFileSync(flowPath, 'utf8'), fs.readFileSync(mirrorPath, 'utf8'));
});
