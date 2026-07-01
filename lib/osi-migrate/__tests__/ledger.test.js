'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { cliRunner } = require('../runner-iface');
const { ensureLedger, getApplied, recordSuccess, recordFailure, sqlQuote } = require('../ledger');

function tmpDb() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-led-')), 't.db'); }

test('ensureLedger is idempotent and getApplied starts empty', async () => {
  const r = cliRunner(tmpDb());
  await ensureLedger(r); await ensureLedger(r);
  assert.deepEqual(await getApplied(r), []);
});

test('recordSuccess and recordFailure persist with status', async () => {
  const r = cliRunner(tmpDb());
  await ensureLedger(r);
  await recordSuccess(r, { version: 1, name: '0001__a.sql', checksum: 'abc', appVersion: '0.6', backupPath: '' });
  await recordFailure(r, { version: 2, name: '0002__b.sql', checksum: 'def', appVersion: '0.6', error: "it's broken" });
  const rows = await getApplied(r);
  assert.deepEqual(rows.map((x) => [x.version, x.status]), [[1, 'applied'], [2, 'failed']]);
});

test('sqlQuote escapes single quotes', () => {
  assert.equal(sqlQuote("a'b"), "'a''b'");
});
