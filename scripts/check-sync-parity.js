#!/usr/bin/env node
'use strict';
const { execFileSync } = require('node:child_process');

function q(db, sql) {
  const out = execFileSync('sqlite3', ['-readonly', '-json', db, sql], { encoding: 'utf8' }).trim();
  return out ? JSON.parse(out) : [];
}

function checkSyncParity(dbPath, { maxPendingAgeSec = 3600 } = {}) {
  const linkRow = q(dbPath, "SELECT linked FROM sync_link_state WHERE peer_node='cloud'")[0];
  const linked = !!(linkRow && linkRow.linked);
  const pending = q(dbPath, "SELECT COUNT(*) c FROM sync_outbox WHERE delivered_at IS NULL AND rejected_at IS NULL")[0].c;
  const rejected = q(dbPath, "SELECT COUNT(*) c FROM sync_outbox WHERE rejected_at IS NOT NULL")[0].c;
  const pendingHistory = q(dbPath, "SELECT COUNT(*) c FROM sync_history_dirty_keys WHERE status='pending'")[0].c;
  const oldest = q(dbPath,
    "SELECT CAST((julianday('now') - julianday(MIN(occurred_at))) * 86400 AS INTEGER) s " +
    "FROM sync_outbox WHERE delivered_at IS NULL AND rejected_at IS NULL");
  const lastDelivered = q(dbPath, "SELECT MAX(delivered_at) d FROM sync_outbox")[0].d || null;
  // NULL oldest (no pending) -> 0; NULL/garbage occurred_at would make julianday NULL -> treat
  // as MAX (fail-safe, not fail-open).
  const rawOldest = oldest[0] ? oldest[0].s : 0;
  const oldestPendingSec = (pending > 0 && (rawOldest === null || rawOldest === undefined))
    ? Number.MAX_SAFE_INTEGER : (rawOldest || 0);
  const healthy = linked && rejected === 0 && pendingHistory === 0 && oldestPendingSec <= maxPendingAgeSec;
  return { linked, pending, pendingHistory, oldestPendingSec, rejected, lastDelivered, healthy };
}

if (require.main === module) {
  const res = checkSyncParity(process.argv[2] || '/data/db/farming.db', {});
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.healthy ? 0 : 1);
}

module.exports = { checkSyncParity };
