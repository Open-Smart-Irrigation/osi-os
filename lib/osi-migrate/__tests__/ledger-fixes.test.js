'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { cliRunner } = require('../runner-iface');
const { ensureLedger, recordSuccess, recordFailure, markRepairRequired, successInsertSql } = require('../ledger');

function tmpDb() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-lf-')), 't.db'); }

test('recordFailure stores backup_path and leaves applied_at NULL', async () => {
  const r = cliRunner(tmpDb()); await ensureLedger(r);
  await recordFailure(r, { version: 1, name: '0001__a.sql', checksum: 'x', appVersion: '0.6', backupPath: '/data/b.bak', error: 'boom' });
  const [row] = await r.all('SELECT status, applied_at, finished_at, backup_path FROM schema_migrations WHERE version=1');
  assert.equal(row.status, 'failed');
  assert.equal(row.applied_at, null, 'failed rows must not look applied');
  assert.equal(row.backup_path, '/data/b.bak');
  assert.ok(row.finished_at, 'finished_at records the failure time');
});

test('markRepairRequired flips an applied row to repair_required', async () => {
  const r = cliRunner(tmpDb()); await ensureLedger(r);
  await recordSuccess(r, { version: 1, name: '0001__a.sql', checksum: 'x', appVersion: '0.6', backupPath: '' });
  await markRepairRequired(r, { version: 1, error: 'postflight integrity_check failed' });
  const [row] = await r.all('SELECT status, error FROM schema_migrations WHERE version=1');
  assert.equal(row.status, 'repair_required');
  assert.match(row.error, /postflight/);
});

test('successInsertSql is a composable statement that records applied', async () => {
  const r = cliRunner(tmpDb()); await ensureLedger(r);
  await r.exec(`BEGIN IMMEDIATE;\nCREATE TABLE t (id INTEGER);\n${successInsertSql({ version: 2, name: '0002__t.sql', checksum: 'y', appVersion: '0.6', backupPath: '' })}\nCOMMIT;`);
  const [row] = await r.all('SELECT version, status FROM schema_migrations WHERE version=2');
  assert.deepEqual([row.version, row.status], [2, 'applied']);
});
