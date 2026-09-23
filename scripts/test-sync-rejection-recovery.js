'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const flowPath = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';
const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
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
  const start = source.indexOf('const SYNC_REJECTION_POLICY');
  const end = source.indexOf('\nsummary.outbox.selected = 0;', start);
  assert.ok(start >= 0 && end > start, 'isolated classification function is present');
  const classify = new Function(`${source.slice(start, end)}\nreturn classifySyncResults;`)();
  const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((event_uuid) => ({ event_uuid }));
  const result = classify(rows, [
    { eventUuid: 'a', status: 'APPLIED' },
    { eventUuid: 'b', status: 'ALREADY_APPLIED' },
    { eventUuid: 'c', status: 'REJECTED', rejectionCode: 'stale_sync_version', rejectionClass: 'PERMANENT', reason: 'diagnostic' },
    { eventUuid: 'd', status: 'REJECTED', rejectionCode: 'invented_code', rejectionClass: 'PERMANENT', reason: 'diagnostic' },
    { eventUuid: 'e', status: 'RETRYABLE_ERROR' },
    { eventUuid: 'g', status: 'APPLIED' },
    { eventUuid: 'g', status: 'APPLIED' },
    { eventUuid: 'unsolicited', status: 'APPLIED' },
  ]);
  assert.equal(result.selected, 7);
  assert.deepEqual(result.applied, ['a']);
  assert.deepEqual(result.duplicate, ['b']);
  assert.deepEqual(result.retryable, ['e', 'f', 'g']);
  assert.deepEqual(result.rejected.map(({ eventUuid, code, rejectionClass, eligible }) => ({ eventUuid, code, rejectionClass, eligible })), [
    { eventUuid: 'c', code: 'stale_sync_version', rejectionClass: 'PERMANENT', eligible: false },
    { eventUuid: 'd', code: 'LEGACY_UNCLASSIFIED', rejectionClass: 'LEGACY_UNCLASSIFIED', eligible: false },
  ]);
  assert.equal(result.protocolErrors, 3);
});

test('both maintained flow profiles are byte-identical', () => {
  const mirrorPath = 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json';
  assert.equal(fs.readFileSync(flowPath, 'utf8'), fs.readFileSync(mirrorPath, 'utf8'));
});
