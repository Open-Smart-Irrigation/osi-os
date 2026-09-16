#!/usr/bin/env node
// Guard for edge sync-health honesty (osi-os T09).
//
// Three defects this pins closed, all observed on the Silvan gateway
// (2026-09-16 harness run C1: 17,996 terminally rejected sync_outbox rows
// spanning 2026-07-07 -> 2026-09-16, invisible to every operator surface):
//
//   1. `sync-outbox-mark` counted terminally REJECTED events toward
//      `lastOutboxDeliverySuccessAt` and cleared `lastError` whenever the
//      protocol-issue list was empty, so a batch the cloud rejected in full
//      reported perfect sync health.
//   2. `sync-state-build` (GET /api/sync/state) counted only rows with
//      `delivered_at IS NULL AND rejected_at IS NULL`, so `rejection_reason`
//      -- written at two sites -- was read by nothing.
//   3. `prune-sync-outbox` had no window for rejected rows, which are never
//      retried and never re-selected, so the pile grew without bound.
//
// Everything below runs the SHIPPED node bodies / SHIPPED SQL extracted from
// flows.json against the real seed schema; nothing here re-implements them.
// Run: node --test scripts/test-sync-health-honesty.js
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

const TOUCHED = ['sync-outbox-mark', 'sync-state-build', 'prune-sync-outbox', 'sync-force-build'];

function nodeById(flowPath, id) {
  const found = JSON.parse(fs.readFileSync(flowPath, 'utf8')).find((n) => n.id === id);
  assert.ok(found, `${id} missing in ${flowPath}`);
  return found;
}
function seedDb() {
  const db = new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-health-')), 's.db'));
  db.exec(fs.readFileSync(SEED, 'utf8'));
  return db;
}
function insertRow(db, uuid, opts = {}) {
  db.prepare(`INSERT INTO sync_outbox
      (event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version,
       occurred_at, delivered_at, rejected_at, rejection_reason, retry_count)
      VALUES (?,?,?,?,?,0,?,?,?,?,?)`)
    .run(
      uuid,
      opts.aggregateType || 'ZONE_ENVIRONMENT',
      opts.aggregateKey || uuid,
      opts.op || 'ZONE_ENVIRONMENT_APPENDED',
      '{}',
      opts.occurredAt || '2026-01-01T00:00:00.000Z',
      opts.deliveredAt != null ? opts.deliveredAt : null,
      opts.rejectedAt != null ? opts.rejectedAt : null,
      opts.rejectionReason != null ? opts.rejectionReason : null,
      opts.retryCount || 0
    );
}

// A promise-shaped stand-in for osi-db-helper's Database facade, backed by the
// real seed schema: run(sql, cb) / all(sql, cb) / close(cb), exactly the shapes
// the shipped nodes call.
function osiDbStub(db) {
  return {
    Database: function () {
      return {
        run(sql, cb) { try { db.exec(sql); cb(null); } catch (e) { cb(e); } },
        all(sql, cb) { try { cb(null, db.prepare(sql).all()); } catch (e) { cb(e); } },
        close(cb) { cb(); },
      };
    },
  };
}

// Run the SHIPPED sync-outbox-mark body verbatim.
async function runOutboxMark({ db, results, requestedIds, initialState }) {
  const func = nodeById(FLOW_PATHS[0], 'sync-outbox-mark').func;
  const warnings = [];
  let state = initialState ? { ...initialState } : {};
  const flow = {
    get: (k) => (k === 'sync_state' ? state : undefined),
    set: (k, v) => { if (k === 'sync_state') state = v; },
  };
  const node = { warn: (m) => warnings.push(String(m)), error: (m) => warnings.push('ERROR ' + m) };
  const msg = { statusCode: 200, _syncEventIds: requestedIds, payload: { results } };
  // eslint-disable-next-line no-new-func
  const fn = new Function('msg', 'flow', 'node', 'osiDb', func);
  await fn(msg, flow, node, osiDbStub(db));
  return { state, warnings };
}

// =====================================================================
// Structural pins
// =====================================================================

test('touched nodes exist in both profiles with byte-identical bodies', () => {
  for (const id of TOUCHED) {
    assert.equal(nodeById(FLOW_PATHS[0], id).func, nodeById(FLOW_PATHS[1], id).func, id);
    assert.equal(nodeById(FLOW_PATHS[0], id).type, 'function');
  }
});

test('sync-outbox-mark no longer counts rejected events toward delivery success', () => {
  const f = nodeById(FLOW_PATHS[0], 'sync-outbox-mark').func;
  assert.ok(
    !f.includes('if (deliveredIds.length + rejectedIds.length > 0) {\n    patch.lastOutboxDeliverySuccessAt = now;'),
    'the rejected-counts-as-delivered gate must be gone'
  );
  assert.ok(
    f.includes('if (deliveredIds.length > 0) {\n    patch.lastOutboxDeliverySuccessAt = now;'),
    'only accepted (APPLIED/DUPLICATE) events may advance the freshness clock'
  );
  assert.match(f, /function rejectionSummary\(rejected\)/);
  assert.ok(!/catch\s*\(\s*_?\s*\)\s*\{\s*\}/.test(f), 'no empty catch may remain in this node');
});

test('sync-force-build applies the same rule on the manual force-sync path', () => {
  const f = nodeById(FLOW_PATHS[0], 'sync-force-build').func;
  assert.ok(
    !f.includes('setSyncState({ lastOutboxDeliverySuccessAt: now, lastOutboxBatchCount:'),
    'force sync must not stamp delivery success unconditionally'
  );
  assert.match(f, /if \(deliveredIds\.length > 0\) forceOutboxPatch\.lastOutboxDeliverySuccessAt = now;/);
  assert.match(f, /recordFailure\('outbox', \(rejectedIds\.length \+ ' event\(s\) rejected by cloud: '/);
});

test('sync-state-build exposes rejected counters and the last rejection reason', () => {
  const f = nodeById(FLOW_PATHS[0], 'sync-state-build').func;
  assert.match(f, /rejectedOutboxCount: Number\(rejectedOutbox\.rejected_outbox_count \|\| 0\)/);
  assert.match(f, /rejectedLast24h: Number\(rejectedOutbox\.rejected_last_24h \|\| 0\)/);
  assert.match(f, /lastRejection: rejectedOutbox\.last_rejected_at \?/);
  assert.match(f, /rejection_reason AS last_rejection_reason/);
  // Flow-local DDL is forbidden by the no-stray-DDL ratchet: the new counters
  // must stay index-free rather than growing an index inside a function node.
  assert.ok(!/CREATE\s+INDEX/i.test(f), 'must not add schema DDL inside sync-state-build');
});

// =====================================================================
// sync-outbox-mark behavior, driven by the SHIPPED node body
// =====================================================================

test('mixed batch: accepted events advance delivery success, rejections keep lastError', async () => {
  const db = seedDb();
  insertRow(db, 'evt-ok');
  insertRow(db, 'evt-bad-1');
  insertRow(db, 'evt-bad-2');
  const { state } = await runOutboxMark({
    db,
    requestedIds: ['evt-ok', 'evt-bad-1', 'evt-bad-2'],
    results: [
      { eventUuid: 'evt-ok', status: 'APPLIED' },
      { eventUuid: 'evt-bad-1', status: 'REJECTED', reason: 'stale_sync_version' },
      { eventUuid: 'evt-bad-2', status: 'REJECTED', reason: 'stale_sync_version' },
    ],
    initialState: { lastError: { source: 'outbox', message: 'older failure' } },
  });

  assert.equal(state.lastOutboxRejectedCount, 2);
  assert.equal(state.lastOutboxBatchCount, 3);
  assert.ok(state.lastOutboxDeliverySuccessAt, 'one accepted event must advance the freshness clock');
  assert.ok(state.lastError, 'a batch with rejections must not clear lastError');
  assert.equal(state.lastError.source, 'outbox');
  assert.match(state.lastError.message, /^2 event\(s\) rejected by cloud: stale_sync_version x2$/);

  const rows = db.prepare('SELECT event_uuid, delivered_at, rejected_at, rejection_reason FROM sync_outbox ORDER BY event_uuid').all();
  assert.equal(rows.find((r) => r.event_uuid === 'evt-ok').rejected_at, null);
  assert.ok(rows.find((r) => r.event_uuid === 'evt-ok').delivered_at);
  for (const id of ['evt-bad-1', 'evt-bad-2']) {
    const row = rows.find((r) => r.event_uuid === id);
    assert.equal(row.delivered_at, null);
    assert.ok(row.rejected_at);
    assert.equal(row.rejection_reason, 'stale_sync_version');
  }
});

test('fully rejected batch does NOT report a delivery success', async () => {
  const db = seedDb();
  insertRow(db, 'evt-bad-1');
  insertRow(db, 'evt-bad-2');
  const { state } = await runOutboxMark({
    db,
    requestedIds: ['evt-bad-1', 'evt-bad-2'],
    results: [
      { eventUuid: 'evt-bad-1', status: 'REJECTED', reason: 'stale_sync_version' },
      { eventUuid: 'evt-bad-2', status: 'REJECTED', reason: 'equal_version_payload_conflict' },
    ],
    initialState: { lastOutboxDeliverySuccessAt: '2026-01-01T00:00:00.000Z' },
  });

  assert.equal(
    state.lastOutboxDeliverySuccessAt, '2026-01-01T00:00:00.000Z',
    'a 100%-rejected batch must leave the previous delivery-success timestamp untouched'
  );
  assert.equal(state.lastOutboxRejectedCount, 2);
  assert.ok(state.lastError);
  assert.match(state.lastError.message, /2 event\(s\) rejected by cloud: /);
  assert.match(state.lastError.message, /stale_sync_version x1/);
  assert.match(state.lastError.message, /equal_version_payload_conflict x1/);
});

test('an all-accepted batch still clears a stale outbox lastError', async () => {
  const db = seedDb();
  insertRow(db, 'evt-ok');
  const { state } = await runOutboxMark({
    db,
    requestedIds: ['evt-ok'],
    results: [{ eventUuid: 'evt-ok', status: 'APPLIED' }],
    initialState: { lastError: { source: 'outbox', message: 'older failure' } },
  });
  assert.equal(state.lastError, null);
  assert.ok(state.lastOutboxDeliverySuccessAt);
  assert.equal(state.lastOutboxRejectedCount, 0);
});

test('a protocol-level issue still outranks the rejection summary in lastError', async () => {
  const db = seedDb();
  insertRow(db, 'evt-bad-1');
  insertRow(db, 'evt-missing');
  const { state } = await runOutboxMark({
    db,
    requestedIds: ['evt-bad-1', 'evt-missing'],
    results: [{ eventUuid: 'evt-bad-1', status: 'REJECTED', reason: 'ownership_denied' }],
  });
  assert.ok(state.lastError);
  assert.match(state.lastError.message, /protocol_response_missing_result:evt-missing/);
});

// =====================================================================
// GET /api/sync/state rejected counters, driven by the SHIPPED SQL
// =====================================================================

function extractRejectedSelect(func, cutoff) {
  const m = func.match(
    /const rejectedRows = await q\("(SELECT COUNT\(\*\) AS rejected_outbox_count, SUM\(CASE WHEN rejected_at >= )'" \+ rejectedCutoff \+ "'( THEN 1 ELSE 0 END\) AS rejected_last_24h[^"]*)"\);/
  );
  assert.ok(m, 'rejected-counters SELECT not found in sync-state-build');
  return m[1] + "'" + cutoff + "'" + m[2];
}

test('rejected counters count every rejected row, the 24h window, and the newest reason', () => {
  const db = seedDb();
  const cutoff = '2026-09-16T00:00:00.000Z';
  insertRow(db, 'old-1', { rejectedAt: '2026-07-07T22:12:25.032Z', rejectionReason: 'stale_sync_version' });
  insertRow(db, 'old-2', { rejectedAt: '2026-08-01T00:00:00.000Z', rejectionReason: 'stale_sync_version' });
  insertRow(db, 'new-1', { rejectedAt: '2026-09-16T10:00:00.000Z', rejectionReason: 'equal_version_payload_conflict' });
  insertRow(db, 'new-2', { rejectedAt: '2026-09-16T23:29:07.634Z', rejectionReason: 'ownership_denied: nope', op: 'DEVICE_ASSIGNED' });
  insertRow(db, 'pending-1');
  insertRow(db, 'delivered-1', { deliveredAt: '2026-09-16T12:00:00.000Z' });

  const sql = extractRejectedSelect(nodeById(FLOW_PATHS[0], 'sync-state-build').func, cutoff);
  const row = db.prepare(sql).all()[0];

  assert.equal(row.rejected_outbox_count, 4, 'every terminally rejected row is counted, not just recent ones');
  assert.equal(row.rejected_last_24h, 2);
  assert.equal(row.last_rejected_at, '2026-09-16T23:29:07.634Z');
  // SQLite bare-column rule: with exactly one MAX() aggregate, op and
  // rejection_reason come from the row that produced MAX(rejected_at).
  assert.equal(row.last_rejected_op, 'DEVICE_ASSIGNED');
  assert.equal(row.last_rejection_reason, 'ownership_denied: nope');
});

test('rejected counters are zero/null on a gateway with no rejections', () => {
  const db = seedDb();
  insertRow(db, 'pending-1');
  const sql = extractRejectedSelect(nodeById(FLOW_PATHS[0], 'sync-state-build').func, '2026-09-16T00:00:00.000Z');
  const row = db.prepare(sql).all()[0];
  assert.equal(row.rejected_outbox_count, 0);
  assert.equal(row.rejected_last_24h, null); // SUM over no rows -> NULL; the node coerces with Number(x || 0)
  assert.equal(row.last_rejected_at, null);
  assert.equal(Number(row.rejected_last_24h || 0), 0);
});

// =====================================================================
// Retention of rejected rows, driven by the SHIPPED prune SQL
// =====================================================================

test('prune-sync-outbox declares a documented rejected-row window and never widens past rejected rows', () => {
  const f = nodeById(FLOW_PATHS[0], 'prune-sync-outbox').func;
  assert.match(f, /const REJECTED_RETENTION_DAYS = 14;/);
  assert.match(f, /DELETE FROM sync_outbox WHERE rejected_at IS NOT NULL AND rejected_at < \?/);
  assert.match(f, /OSI_OUTBOX_RETENTION_DAYS/, 'the delivered-row prune must be preserved');
  assert.ok(!/CREATE\s+INDEX/i.test(f), 'must not add schema DDL inside prune-sync-outbox');
  // The rejected DELETE must be keyed on rejected_at, never on delivered_at IS NULL:
  // undelivered, non-rejected rows are the real backlog and must never be pruned.
  assert.ok(
    !/DELETE FROM sync_outbox WHERE delivered_at IS NULL/.test(f),
    'no prune may ever delete undelivered, non-rejected rows'
  );
});

test('the rejected prune deletes only old rejected rows and leaves the live backlog intact', () => {
  const f = nodeById(FLOW_PATHS[0], 'prune-sync-outbox').func;
  const countSql = f.match(/const rejDelRows = await q\('([^']+)', \[rejectedCutoff\]\);/);
  const deleteSql = f.match(/await run\('(DELETE FROM sync_outbox WHERE rejected_at IS NOT NULL[^']+)', \[rejectedCutoff\]\);/);
  assert.ok(countSql && deleteSql, 'rejected prune SQL not found in prune-sync-outbox');

  const db = seedDb();
  const cutoff = '2026-09-03T00:00:00.000Z'; // 14 days before 2026-09-17
  insertRow(db, 'rejected-old', { rejectedAt: '2026-07-07T22:12:25.032Z', rejectionReason: 'stale_sync_version' });
  insertRow(db, 'rejected-old-2', { rejectedAt: '2026-08-31T00:00:00.000Z', rejectionReason: 'stale_sync_version' });
  insertRow(db, 'rejected-recent', { rejectedAt: '2026-09-16T00:00:00.000Z', rejectionReason: 'stale_sync_version' });
  insertRow(db, 'undelivered-ancient', { occurredAt: '2026-01-01T00:00:00.000Z' });
  insertRow(db, 'delivered-recent', { deliveredAt: '2026-09-16T00:00:00.000Z' });

  const toPrune = db.prepare(countSql[1]).all(cutoff)[0];
  assert.equal(Number(toPrune.count), 2);
  db.prepare(deleteSql[1]).run(cutoff);

  const remaining = db.prepare('SELECT event_uuid FROM sync_outbox ORDER BY event_uuid').all().map((r) => r.event_uuid);
  assert.deepEqual(remaining, ['delivered-recent', 'rejected-recent', 'undelivered-ancient']);
});
