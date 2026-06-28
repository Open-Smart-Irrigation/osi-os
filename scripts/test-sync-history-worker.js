#!/usr/bin/env node
const assert = require('assert');
const helper = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper');

const row = {
  id: 123,
  deveui: 'A84041CAFECAFE01',
  recorded_at: '2026-06-28T10:00:00Z',
  swt_1: 1,
  swt_2: null,
  dendro_valid: 1
};

assert.strictEqual(helper.historyKey('device_data', '0016C001F11715E2', row), 'DEVICE_DATA|0016C001F11715E2|123');
assert.strictEqual(helper.nextRawQuery('device_data'), 'SELECT * FROM device_data WHERE id > ? ORDER BY id ASC LIMIT ?');
assert.deepStrictEqual(helper.buildCanonicalColumns('device_data', row), [
  ['id', 'INTEGER', '123'],
  ['deveui', 'TEXT', 'A84041CAFECAFE01'],
  ['recorded_at', 'TIMESTAMP', '2026-06-28T10:00:00.000Z'],
  ['swt_1', 'REAL', '3ff0000000000000'],
  ['swt_2', 'REAL', null],
  ['dendro_valid', 'BOOLEAN', true]
]);
assert.strictEqual(
  helper.hashHistoryRow('device_data', 'DEVICE_DATA|0016C001F11715E2|123', row),
  '39eb29940bfb23a1d5b84a573daf646e48c5e4e768d2068385fa5083fd62a371'
);

assert.deepStrictEqual(helper.cursorPatchFromResponse({
  ackedThroughId: 123,
  results: [{ historyKey: 'DEVICE_DATA|0016C001F11715E2|123', status: 'APPLIED' }]
}), { last_acked_id: 123, last_error: null, retry_count: 0 });

assert.deepStrictEqual(helper.cursorPatchFromResponse({
  results: [{ historyKey: 'DEVICE_DATA|0016C001F11715E2|124', status: 'REJECTED_PERMANENT', reason: 'unsupported_hash_version' }]
}), { last_error: 'permanent: unsupported_hash_version', next_attempt_at: '9999-12-31T00:00:00.000Z' });

console.log('OK sync history worker helper');
