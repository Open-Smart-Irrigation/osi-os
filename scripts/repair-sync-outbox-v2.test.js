'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { repairSyncOutboxV2 } = require('./repair-sync-outbox-v2');

const V1_OUTBOX = `
CREATE TABLE sync_outbox (
  event_uuid TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_key TEXT NOT NULL,
  op TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  sync_version INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  delivered_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  gateway_device_eui TEXT
);`;

async function makeDb(sql) {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sov2-')), 'f.db');
  await cliRunner(db).exec(sql);
  return db;
}

test('repairs a v1-shaped sync_outbox (adds all three TEXT columns)', async () => {
  const db = await makeDb(V1_OUTBOX);
  const { added } = await repairSyncOutboxV2(db);
  assert.deepEqual(added, ['rejected_at', 'rejection_reason', 'last_retryable_failure_at']);
  const cols = await cliRunner(db).all('PRAGMA table_xinfo(sync_outbox)');
  for (const name of added) {
    const col = cols.find((c) => c.name === name);
    assert.ok(col, `${name} missing after repair`);
    assert.equal(col.type.toUpperCase(), 'TEXT');
  }
});

test('re-run is a clean no-op', async () => {
  const db = await makeDb(V1_OUTBOX);
  await repairSyncOutboxV2(db);
  const second = await repairSyncOutboxV2(db);
  assert.deepEqual(second.added, []);
});

test('partial subset present: adds only the missing ones', async () => {
  const db = await makeDb(V1_OUTBOX + '\nALTER TABLE sync_outbox ADD COLUMN rejected_at TEXT;');
  const { added } = await repairSyncOutboxV2(db);
  assert.deepEqual(added, ['rejection_reason', 'last_retryable_failure_at']);
});

test('refuses a missing db path (anti-typo)', async () => {
  await assert.rejects(() => repairSyncOutboxV2('/nonexistent/nope.db'), /does not exist/);
});

test('refuses when sync_outbox is missing entirely (the #87 whole-table gap)', async () => {
  const db = await makeDb('CREATE TABLE other (x TEXT);');
  await assert.rejects(() => repairSyncOutboxV2(db), /whole-table gap/);
});
