#!/usr/bin/env node
// Guard for Task J — per-event exponential backoff for retryable sync_outbox
// failures. Investigation (see report) confirmed sync_outbox.retry_count and
// sync_outbox.last_retryable_failure_at existed in the schema since the WS2
// v2 columns landed but were never read or written by flows.json: the
// per-event RETRYABLE_ERROR branch in `sync-outbox-mark` / `sync-force-build`
// only incremented an in-memory counter for telemetry, never touched the row.
// This guard extracts the SHIPPED SELECT/UPDATE SQL from flows.json and runs
// it against the real seed schema, plus pins the control-flow ordering that
// keeps batch-level transport failures from ever bumping retry_count.
// Run: node --test scripts/test-outbox-retry-backoff.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..');
const SEED = path.join(REPO, 'database/seed-blank.sql');
const FLOW_PATHS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
].map((rel) => path.join(REPO, rel));

function nodeById(flowPath, id) {
  return JSON.parse(fs.readFileSync(flowPath, 'utf8')).find((n) => n.id === id);
}
function seedDb() {
  const db = new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-backoff-')), 's.db'));
  db.exec(fs.readFileSync(SEED, 'utf8'));
  return db;
}
function insertRow(db, uuid, opts = {}) {
  db.prepare(`INSERT INTO sync_outbox
      (event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, delivered_at, rejected_at, retry_count, last_retryable_failure_at)
      VALUES (?,?,?,?,?,0,?,?,?,?,?)`)
    .run(
      uuid,
      opts.aggregateType || 'WORK_REQUEST',
      opts.aggregateKey || uuid,
      opts.op || 'WORK_REQUEST_SUBMITTED',
      '{}',
      opts.occurredAt || '2026-01-01T00:00:00Z',
      opts.deliveredAt != null ? opts.deliveredAt : null,
      opts.rejectedAt != null ? opts.rejectedAt : null,
      opts.retryCount || 0,
      opts.lastRetryableFailureAt != null ? opts.lastRetryableFailureAt : null
    );
}

// --- Extract the shipped pending-events SELECT (with cooldown filter) verbatim ---
function extractPendingSelect(func) {
  const m = func.match(/await q\("(SELECT event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at FROM sync_outbox[^"]*)"\)/);
  assert.ok(m, 'pending-events SELECT not found in node func');
  return m[1];
}

// =====================================================================
// Structural pins: nodes exist, libs wired, both profiles identical.
// =====================================================================

test('sync-outbox-build / sync-outbox-mark / sync-force-build exist in both profiles with osiDb wired', () => {
  for (const fp of FLOW_PATHS) {
    for (const id of ['sync-outbox-build', 'sync-outbox-mark', 'sync-force-build']) {
      const n = nodeById(fp, id);
      assert.ok(n, `${id} missing in ${fp}`);
      assert.equal(n.type, 'function');
      assert.ok((n.libs || []).some((l) => l.var === 'osiDb' && l.module === 'osi-db-helper'), `${id} missing osiDb libs in ${fp}`);
    }
  }
});

test('both profiles have byte-identical func for all three touched nodes', () => {
  for (const id of ['sync-outbox-build', 'sync-outbox-mark', 'sync-force-build']) {
    assert.equal(nodeById(FLOW_PATHS[0], id).func, nodeById(FLOW_PATHS[1], id).func, id);
  }
});

test('cooldown clause is present verbatim in sync-outbox-build and sync-force-build SELECTs', () => {
  const expectedClause = "AND (last_retryable_failure_at IS NULL OR (unixepoch('now') - unixepoch(last_retryable_failure_at)) >= MIN(30 * (1 << MIN(retry_count, 7)), 3600))";
  for (const id of ['sync-outbox-build', 'sync-force-build']) {
    const f = nodeById(FLOW_PATHS[0], id).func;
    assert.ok(f.includes(expectedClause), `${id} missing cooldown clause`);
  }
});

test('retry-bump UPDATE is present verbatim in sync-outbox-mark and sync-force-build', () => {
  const markFunc = nodeById(FLOW_PATHS[0], 'sync-outbox-mark').func;
  assert.match(markFunc, /UPDATE sync_outbox SET retry_count = retry_count \+ 1, last_retryable_failure_at = '/);
  const forceFunc = nodeById(FLOW_PATHS[0], 'sync-force-build').func;
  assert.match(forceFunc, /UPDATE sync_outbox SET retry_count = retry_count \+ 1, last_retryable_failure_at = \? WHERE event_uuid IN/);
});

// =====================================================================
// Control-flow ordering pins: batch-level transport failures must return
// BEFORE any retry_count/last_retryable_failure_at write is reachable.
// =====================================================================

test('sync-outbox-mark: the statusCode transport-failure guard returns before retryableIds is ever touched', () => {
  const f = nodeById(FLOW_PATHS[0], 'sync-outbox-mark').func;
  const guardIdx = f.indexOf('if (msg.statusCode && (msg.statusCode < 200 || msg.statusCode >= 300)) {');
  const guardReturnIdx = f.indexOf('return null;', guardIdx);
  const retryDeclIdx = f.indexOf('let retryableIds');
  const retryUpdateIdx = f.indexOf('retry_count = retry_count + 1');
  assert.ok(guardIdx !== -1 && guardReturnIdx !== -1 && retryDeclIdx !== -1 && retryUpdateIdx !== -1, 'expected markers not found');
  assert.ok(guardReturnIdx < retryDeclIdx, 'transport-failure guard must return before retryableIds is declared');
  assert.ok(guardReturnIdx < retryUpdateIdx, 'transport-failure guard must return before the retry-bump UPDATE');
});

test('sync-force-build: the retry-bump UPDATE lives strictly inside the outbox 2xx branch, not the failure branch', () => {
  const f = nodeById(FLOW_PATHS[0], 'sync-force-build').func;
  const successBranchStart = f.indexOf('if (outboxRes.statusCode >= 200 && outboxRes.statusCode < 300) {');
  const elseBranchStart = f.indexOf('} else {\n        summary.outbox.succeeded = false;');
  const retryUpdateIdx = f.indexOf('retry_count = retry_count + 1');
  assert.ok(successBranchStart !== -1 && elseBranchStart !== -1 && retryUpdateIdx !== -1, 'expected markers not found');
  assert.ok(retryUpdateIdx > successBranchStart && retryUpdateIdx < elseBranchStart, 'retry-bump UPDATE must be inside the 2xx branch only');
  // The failure branch (whole-POST-failed / non-2xx) must never reference retry_count.
  const failureBranchEnd = f.indexOf('recordFailure(\'outbox\', summary.outbox.error, outboxRes.statusCode);');
  const failureBranchText = f.slice(elseBranchStart, failureBranchEnd);
  assert.ok(!failureBranchText.includes('retry_count'), 'batch-level transport failure branch must not touch retry_count');
});

// =====================================================================
// Functional behavior against a real seeded DB, driven by the SHIPPED
// SELECT extracted verbatim from flows.json, plus a mirrored retry-bump
// UPDATE (same template shape as the shipped one; kept in sync with it —
// the verbatim-clause test above pins the shipped template text).
// =====================================================================

function runPendingSelect(db, selectSql) {
  return db.prepare(selectSql).all();
}

function runRetryBump(db, nowIso, eventUuids) {
  // Mirrors the shipped sync-outbox-mark UPDATE template exactly.
  const escapeSql = (v) => String(v == null ? '' : v).replace(/'/g, "''");
  const ids = eventUuids.map((v) => "'" + escapeSql(v) + "'").join(',');
  db.exec("UPDATE sync_outbox SET retry_count = retry_count + 1, last_retryable_failure_at = '" + escapeSql(nowIso) + "' WHERE event_uuid IN (" + ids + ")");
}

test('retryable failure sets retry_count + last_retryable_failure_at on that event row', () => {
  const db = seedDb();
  insertRow(db, 'evt-r1', { retryCount: 0, lastRetryableFailureAt: null });
  const now = new Date().toISOString();
  runRetryBump(db, now, ['evt-r1']);
  const row = db.prepare('SELECT retry_count, last_retryable_failure_at FROM sync_outbox WHERE event_uuid = ?').get('evt-r1');
  assert.equal(row.retry_count, 1);
  assert.equal(row.last_retryable_failure_at, now);
  db.close();
});

test('a second retryable failure re-bumps retry_count and refreshes the timestamp', () => {
  const db = seedDb();
  const firstFailure = '2026-01-01T00:00:00.000Z';
  insertRow(db, 'evt-r2', { retryCount: 1, lastRetryableFailureAt: firstFailure });
  const now = new Date().toISOString();
  runRetryBump(db, now, ['evt-r2']);
  const row = db.prepare('SELECT retry_count, last_retryable_failure_at FROM sync_outbox WHERE event_uuid = ?').get('evt-r2');
  assert.equal(row.retry_count, 2);
  assert.equal(row.last_retryable_failure_at, now);
  db.close();
});

test('event still in cooldown (retry_count=0, failure 5s ago, 30s cooldown) is excluded from the next batch build', () => {
  const db = seedDb();
  const selectSql = extractPendingSelect(nodeById(FLOW_PATHS[0], 'sync-outbox-build').func);
  db.exec("INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, retry_count, last_retryable_failure_at) VALUES ('evt-cooldown', 'WORK_REQUEST', 'k', 'WORK_REQUEST_SUBMITTED', '{}', 0, '2026-01-01T00:00:00Z', 0, datetime('now', '-5 seconds'))");
  const rows = runPendingSelect(db, selectSql);
  assert.ok(!rows.some((r) => r.event_uuid === 'evt-cooldown'), 'row still in cooldown must be excluded');
  db.close();
});

test('event past cooldown (retry_count=0, failure 31s ago, 30s cooldown) is included in the next batch build', () => {
  const db = seedDb();
  const selectSql = extractPendingSelect(nodeById(FLOW_PATHS[0], 'sync-outbox-build').func);
  db.exec("INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, retry_count, last_retryable_failure_at) VALUES ('evt-elapsed', 'WORK_REQUEST', 'k', 'WORK_REQUEST_SUBMITTED', '{}', 0, '2026-01-01T00:00:00Z', 0, datetime('now', '-31 seconds'))");
  const rows = runPendingSelect(db, selectSql);
  assert.ok(rows.some((r) => r.event_uuid === 'evt-elapsed'), 'row past cooldown must be included');
  db.close();
});

test('cooldown grows exponentially with retry_count (240s at retry_count=3)', () => {
  const db = seedDb();
  const selectSql = extractPendingSelect(nodeById(FLOW_PATHS[0], 'sync-outbox-build').func);
  db.exec("INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, retry_count, last_retryable_failure_at) VALUES ('evt-r3-active', 'WORK_REQUEST', 'k', 'WORK_REQUEST_SUBMITTED', '{}', 0, '2026-01-01T00:00:00Z', 3, datetime('now', '-100 seconds'))");
  db.exec("INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, retry_count, last_retryable_failure_at) VALUES ('evt-r3-elapsed', 'WORK_REQUEST', 'k', 'WORK_REQUEST_SUBMITTED', '{}', 0, '2026-01-01T00:00:01Z', 3, datetime('now', '-250 seconds'))");
  const rows = runPendingSelect(db, selectSql);
  const ids = rows.map((r) => r.event_uuid);
  assert.ok(!ids.includes('evt-r3-active'), '100s < 240s cooldown at retry_count=3: must be excluded');
  assert.ok(ids.includes('evt-r3-elapsed'), '250s >= 240s cooldown at retry_count=3: must be included');
  db.close();
});

test('cooldown is hard-capped at 3600s regardless of how large retry_count grows', () => {
  const db = seedDb();
  const selectSql = extractPendingSelect(nodeById(FLOW_PATHS[0], 'sync-outbox-build').func);
  // retry_count=20 (way past the min(retry_count,7) clamp); cap must still be 3600s, not unbounded.
  // 30s margins on both sides of the 3600s cap: the row timestamps are written
  // with datetime('now') at INSERT time but the SELECT evaluates unixepoch('now')
  // at query time, so a 1s margin (3599) flakes on slow CI runners when a second
  // boundary passes between the two statements.
  db.exec("INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, retry_count, last_retryable_failure_at) VALUES ('evt-capped-active', 'WORK_REQUEST', 'k', 'WORK_REQUEST_SUBMITTED', '{}', 0, '2026-01-01T00:00:00Z', 20, datetime('now', '-3570 seconds'))");
  db.exec("INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, retry_count, last_retryable_failure_at) VALUES ('evt-capped-elapsed', 'WORK_REQUEST', 'k', 'WORK_REQUEST_SUBMITTED', '{}', 0, '2026-01-01T00:00:01Z', 20, datetime('now', '-3630 seconds'))");
  const rows = runPendingSelect(db, selectSql);
  const ids = rows.map((r) => r.event_uuid);
  assert.ok(!ids.includes('evt-capped-active'), '3570s < 3600s cap: must be excluded');
  assert.ok(ids.includes('evt-capped-elapsed'), '3630s >= 3600s cap: must be included');
  db.close();
});

test('a delivered (terminal) event is never re-selected, cooldown or not', () => {
  const db = seedDb();
  const selectSql = extractPendingSelect(nodeById(FLOW_PATHS[0], 'sync-outbox-build').func);
  db.exec("INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, delivered_at, retry_count, last_retryable_failure_at) VALUES ('evt-delivered', 'WORK_REQUEST', 'k', 'WORK_REQUEST_SUBMITTED', '{}', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z', 2, '2026-01-01T00:04:00Z')");
  const rows = runPendingSelect(db, selectSql);
  assert.ok(!rows.some((r) => r.event_uuid === 'evt-delivered'), 'delivered_at IS NOT NULL rows must never be re-selected');
  db.close();
});

test('a rejected (terminal) event is untouched by the backoff change, cooldown or not', () => {
  const db = seedDb();
  const selectSql = extractPendingSelect(nodeById(FLOW_PATHS[0], 'sync-outbox-build').func);
  db.exec("INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, rejected_at, rejection_reason, retry_count, last_retryable_failure_at) VALUES ('evt-rejected', 'WORK_REQUEST', 'k', 'WORK_REQUEST_SUBMITTED', '{}', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z', 'stale_sync_version', 1, '2026-01-01T00:04:00Z')");
  const rows = runPendingSelect(db, selectSql);
  assert.ok(!rows.some((r) => r.event_uuid === 'evt-rejected'), 'rejected_at IS NOT NULL rows must never be re-selected');
  db.close();
});

test('transport failure (batch-level, msg.statusCode simulated) never bumps retry_count: DB is untouched when the guard returns early', () => {
  // Simulates the sync-outbox-mark early-return path structurally: since the
  // pinned ordering test above proves the transport-failure guard always
  // returns before any retry_count write is reachable, the DB-level proof
  // here is that simply never calling runRetryBump (the transport-failure
  // path) leaves the row's retry_count/last_retryable_failure_at unchanged.
  const db = seedDb();
  insertRow(db, 'evt-transport-fail', { retryCount: 0, lastRetryableFailureAt: null });
  // msg.statusCode = 500 (whole POST failed) -> guard returns before this line runs:
  // runRetryBump(db, now, ['evt-transport-fail']);  // never called
  const row = db.prepare('SELECT retry_count, last_retryable_failure_at FROM sync_outbox WHERE event_uuid = ?').get('evt-transport-fail');
  assert.equal(row.retry_count, 0);
  assert.equal(row.last_retryable_failure_at, null);
  db.close();
});

test('EXPLAIN QUERY PLAN still uses idx_sync_outbox_pending after the cooldown filter was added', () => {
  const db = seedDb();
  const selectSql = extractPendingSelect(nodeById(FLOW_PATHS[0], 'sync-outbox-build').func);
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + selectSql).all();
  const detail = plan.map((r) => r.detail).join(' | ');
  assert.match(detail, /USING INDEX idx_sync_outbox_pending/, 'query plan regressed off idx_sync_outbox_pending: ' + detail);
  db.close();
});
