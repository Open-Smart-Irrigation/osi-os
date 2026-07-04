'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checkSyncParity } = require('./check-sync-parity');

function mkDb(linked) {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'par-')), 'farming.db');
  execFileSync('sqlite3', ['-bail', db], { input:
    'CREATE TABLE sync_link_state (peer_node TEXT PRIMARY KEY, linked INTEGER NOT NULL DEFAULT 0);' +
    'CREATE TABLE sync_outbox (event_uuid TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, delivered_at TEXT, rejected_at TEXT);' +
    'CREATE TABLE sync_history_dirty_keys (peer_node TEXT, table_name TEXT, row_key TEXT, changed_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'pending\', PRIMARY KEY(peer_node,table_name,row_key));' +
    `INSERT INTO sync_link_state(peer_node,linked) VALUES ('cloud',${linked});` });
  return db;
}

test('unlinked gateway is UNHEALTHY even with an empty outbox (no fail-open)', () => {
  const res = checkSyncParity(mkDb(0), { maxPendingAgeSec: 3600 });
  assert.strictEqual(res.linked, false);
  assert.strictEqual(res.healthy, false);
});

test('linked + delivered + no pending history = healthy; a reject or pending history flips it', () => {
  const db = mkDb(1);
  execFileSync('sqlite3', ['-bail', db], { input:
    "INSERT INTO sync_outbox VALUES ('a','2026-07-03T00:00:00Z','2026-07-03T00:00:01Z',NULL);" });
  assert.strictEqual(checkSyncParity(db, { maxPendingAgeSec: 3600 }).healthy, true);

  execFileSync('sqlite3', ['-bail', db], { input:
    "INSERT INTO sync_history_dirty_keys VALUES ('cloud','device_data','k','2026-07-03T00:00:00Z','pending');" });
  const res = checkSyncParity(db, { maxPendingAgeSec: 3600 });
  assert.strictEqual(res.pendingHistory, 1);
  assert.strictEqual(res.healthy, false);
});
