'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { composeFingerprintRefresh } = require('../runner');

test('composeFingerprintRefresh wraps DELETE + INSERTs in one transaction', () => {
  const s = composeFingerprintRefresh([
    { object_type: 'table', object_name: 't', fingerprint: 'h1' },
    { object_type: 'trigger', object_name: 'g', fingerprint: 'h2' },
  ]);
  const iBegin = s.indexOf('BEGIN IMMEDIATE');
  const iDelete = s.indexOf('DELETE FROM schema_object_fingerprints');
  const iInsert = s.indexOf('INSERT INTO schema_object_fingerprints');
  const iCommit = s.indexOf('COMMIT');
  assert.ok(iBegin >= 0 && iDelete > iBegin, 'DELETE inside the transaction');
  assert.ok(iInsert > iDelete, 'INSERTs after DELETE');
  assert.ok(iCommit > iInsert, 'COMMIT after the INSERTs');
});

test('composeFingerprintRefresh with no rows still resets atomically', () => {
  const s = composeFingerprintRefresh([]);
  assert.ok(s.includes('BEGIN IMMEDIATE') && s.includes('DELETE FROM schema_object_fingerprints') && s.includes('COMMIT'));
});
