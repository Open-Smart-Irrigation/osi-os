#!/usr/bin/env node
// PR-G / consult Q6 (docs/superpowers/reviews/2026-09-16-readiness-fable-consult.md
// "Recommended change"; external-consult-codex-2026-09-16.md Q6, whose
// q6-ack-harness.js is this file's starting point -- extended with the
// per-entry outcome matrix, a real SQLite-backed osiDb seam so the shipped
// SQL (including the retry-cap CASE expressions) actually executes, and
// command-ack-build-batch/sync-pending-split coverage).
//
// Extracts the SHIPPED command-ack-build-batch, command-ack-mark-delivered
// and sync-pending-split function bodies from flows.json and runs them
// against a real in-memory SQLite command_ack_outbox table (node:sqlite) via
// a recording osiDb seam. Asserts the CORRECT per-entry behaviour, so this is
// RED on origin/main (whole-batch marking) for the reason stated in each
// assertion, and GREEN once command-ack-mark-delivered is rewritten per-entry.
//
// Run: node scripts/test-command-ack-mark-delivered.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const FLOWS_PATH = path.resolve(__dirname, '..', 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const flows = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));

function nodeById(id) {
  const found = flows.find((n) => n.id === id);
  assert.ok(found, 'missing flow node ' + id);
  return found;
}

// --- A real sqlite-backed osiDb seam --------------------------------------
// The node's own SQL (UPDATE ... CASE ... WHEN retry_count + 1 >= N) runs for
// real against an in-memory command_ack_outbox table, rather than being
// pattern-matched as text: this is the only way to trust the retry-cap logic.

function makeOsiDb(sqliteDb) {
  class Database {
    run(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      try {
        sqliteDb.prepare(sql).run(...(params || []));
        callback(null);
      } catch (error) {
        callback(error);
      }
    }
    all(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      try {
        callback(null, sqliteDb.prepare(sql).all(...(params || [])));
      } catch (error) {
        callback(error, null);
      }
    }
    close(callback) { callback(); }
  }
  return { Database };
}

function execute(node, msg, sqliteDb, opts) {
  opts = opts || {};
  const flowState = opts.flowState || {};
  const flow = {
    get(key) { return flowState[key]; },
    set(key, value) { flowState[key] = value; },
  };
  const env = { get(key) { return (opts.env || {})[key]; } };
  const globalCtx = { get(key) { return (opts.global || {})[key]; } };
  const warnings = [];
  const context = {
    msg, flow, env, global: globalCtx,
    osiDb: makeOsiDb(sqliteDb),
    node: { warn(m) { warnings.push(String(m)); }, error(m) { warnings.push(String(m)); }, status() {} },
    console, Date, Number, String, Array, Object, Map, Set, Boolean, Math, JSON, Promise,
    parseInt, parseFloat,
  };
  vm.createContext(context);
  const rawPromise = vm.runInContext('(async () => {\n' + node.func + '\n})()', context, { timeout: 5000 });
  // The vm context is a separate realm: arrays/objects it returns are not
  // `instanceof` this process's Array/Object, which trips assert.deepEqual's
  // reference-equality fast path. Round-trip through JSON to normalize into
  // plain outer-realm values -- every assertion below only inspects JSON-safe
  // shapes (numbers/strings/booleans/plain objects/arrays), so this is lossless.
  const resultPromise = rawPromise.then((value) => (value === undefined ? value : JSON.parse(JSON.stringify(value))));
  return { resultPromise, warnings, flowState };
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE command_ack_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_url TEXT, server_sync_token TEXT, server_linked_at TEXT
    );
  `);
  return db;
}

function seedAck(db, id, commandId, createdAtOffsetSeconds, retryCount) {
  db.prepare(
    'INSERT INTO command_ack_outbox (id, command_id, payload_json, created_at, retry_count) VALUES (?,?,?,?,?)'
  ).run(id, commandId, JSON.stringify({ commandId }), new Date(Date.now() - (createdAtOffsetSeconds || 0) * 1000).toISOString(), retryCount || 0);
}

function rowsById(db) {
  const out = {};
  for (const r of db.prepare('SELECT * FROM command_ack_outbox').all()) out[r.id] = r;
  return out;
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS: ' + name);
  } catch (error) {
    failures += 1;
    console.error('FAIL: ' + name);
    console.error('  ' + (error && error.message ? error.message : error));
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log('PASS: ' + name);
  } catch (error) {
    failures += 1;
    console.error('FAIL: ' + name);
    console.error('  ' + (error && error.message ? error.message : error));
  }
}

// ===========================================================================
// 1. command-ack-build-batch produces a per-commandId correlation map.
//    RED on origin/main: the shipped SELECT is `SELECT id, payload_json ...`
//    (no command_id column) and never sets msg._localAckCorrelation at all.
// ===========================================================================
async function testBuildBatchCorrelation() {
  const db = freshDb();
  db.prepare("INSERT INTO users (server_url, server_sync_token, server_linked_at) VALUES ('https://cloud.example', 'tok', '2026-01-01')").run();
  seedAck(db, 101, 'cmd-101', 50);
  seedAck(db, 102, 'cmd-102', 40);
  seedAck(db, 103, 'cmd-103', 30);
  const node = nodeById('command-ack-build-batch');
  const { resultPromise } = execute(node, {}, db, {
    env: { DEVICE_EUI: 'AABBCCDDEEFF0011', DEVICE_EUI_CONFIDENCE: 'confirmed' },
    global: { fs: { existsSync: () => false } },
    flowState: { sync_state: {} },
  });
  const out = await resultPromise;
  assert.ok(out, 'command-ack-build-batch must produce a message when acks are queued');
  assert.deepEqual(out._commandAckIds, [101, 102, 103]);
  assert.ok(out._localAckCorrelation && typeof out._localAckCorrelation === 'object',
    'command-ack-build-batch must set msg._localAckCorrelation so command-ack-mark-delivered can key its per-entry outcome by cloud commandId, not by local row id');
  assert.deepEqual(out._localAckCorrelation['cmd-101'], [101]);
  assert.deepEqual(out._localAckCorrelation['cmd-102'], [102]);
  assert.deepEqual(out._localAckCorrelation['cmd-103'], [103]);
  db.close();
}

// ===========================================================================
// 2. command-ack-mark-delivered: the exact scenario from the task brief.
//    HTTP 200 with results {101 ACKED, 102 UNKNOWN, 103 LEASE_MISMATCH,
//    104 CORRELATION_MISMATCH}, plus local row 105 which the response is
//    silent about entirely (no correlation entry).
//    Expected: 101 + 102 delivered; 103 + 105 retry_count+1 with last_error;
//    104 dead-lettered (delivered_at set, last_error names it a dead letter).
//    RED on origin/main: the shipped node has exactly one branch on
//    `msg.statusCode >= 200 && < 300` and marks EVERY id in _commandAckIds
//    delivered_at on any 2xx -- so 103, 104 and 105 all come back delivered
//    (105 doesn't even have a chance to be inspected: the shipped node never
//    looks at msg.payload.results at all).
// ===========================================================================
async function testMixedResultsPerEntry() {
  const db = freshDb();
  seedAck(db, 101, 'cmd-101');
  seedAck(db, 102, 'cmd-102');
  seedAck(db, 103, 'cmd-103');
  seedAck(db, 104, 'cmd-104');
  seedAck(db, 105, 'cmd-105'); // present locally, absent from the cloud response
  const node = nodeById('command-ack-mark-delivered');
  const { resultPromise, warnings } = execute(node, {
    statusCode: 200,
    _commandAckIds: [101, 102, 103, 104, 105],
    _localAckCorrelation: { 'cmd-101': [101], 'cmd-102': [102], 'cmd-103': [103], 'cmd-104': [104] },
    payload: {
      results: [
        { commandId: 'cmd-101', status: 'ACKED', terminal: true },
        { commandId: 'cmd-102', status: 'UNKNOWN', terminal: true, error: 'unknown command' },
        { commandId: 'cmd-103', status: 'LEASE_MISMATCH', terminal: false, error: 'command is not leased to gateway' },
        { commandId: 'cmd-104', status: 'CORRELATION_MISMATCH', terminal: false, error: 'edge/cloud commandId mismatch' },
      ],
    },
  }, db);
  await resultPromise;
  assert.deepEqual(warnings, [], 'no warnings expected on the happy mixed-result path');
  const rows = rowsById(db);

  assert.ok(rows[101].delivered_at, '101 ACKED must be delivered');
  assert.equal(rows[101].retry_count, 0);
  assert.equal(rows[101].last_error, null);

  assert.ok(rows[102].delivered_at, '102 UNKNOWN is terminal (a retry would reproduce the same business rejection) and must be delivered, not retried forever');
  assert.equal(rows[102].retry_count, 0);

  assert.equal(rows[103].delivered_at, null, '103 LEASE_MISMATCH is non-terminal and must stay pending for redelivery');
  assert.equal(rows[103].retry_count, 1);
  assert.ok(rows[103].last_error, '103 must record why it is being retried');

  assert.ok(rows[104].delivered_at, '104 CORRELATION_MISMATCH is an edge-side result-shape bug a retry cannot fix and must be dead-lettered (delivered_at set) rather than retried forever');
  assert.match(rows[104].last_error || '', /dead_letter/, '104 dead-letter marker must be visible in last_error since the schema has no dedicated terminal-marker column');

  assert.equal(rows[105].delivered_at, null, '105 has no entry in the cloud response at all and must be retried, never silently marked delivered');
  assert.equal(rows[105].retry_count, 1);
  assert.ok(rows[105].last_error, '105 must record that its result entry was missing');
  db.close();
}

// ===========================================================================
// 3. statusCode=0 (transport failure): every row is left pending. The cloud
//    never answered, so this must not consume any of the RETRY_CAP budget
//    (Codex P1 on PR #243: the cap must only count responses the cloud
//    actually sent per entry).
// ===========================================================================
async function testTransportFailureZeroRetriesAll() {
  const db = freshDb();
  seedAck(db, 201, 'cmd-201');
  seedAck(db, 202, 'cmd-202');
  const node = nodeById('command-ack-mark-delivered');
  const { resultPromise } = execute(node, {
    statusCode: 0,
    _commandAckIds: [201, 202],
    _localAckCorrelation: { 'cmd-201': [201], 'cmd-202': [202] },
    payload: { error: 'Command ACK REST IPv4 request failed', code: 'ECONNREFUSED' },
  }, db);
  await resultPromise;
  const rows = rowsById(db);
  assert.equal(rows[201].delivered_at, null);
  assert.equal(rows[201].retry_count, 0, 'a transport failure must never advance the RETRY_CAP counter');
  assert.equal(rows[202].delivered_at, null);
  assert.equal(rows[202].retry_count, 0, 'a transport failure must never advance the RETRY_CAP counter');
  db.close();
}

// ===========================================================================
// 4. HTTP 500: every row is left pending (non-2xx, no results array to
//    consult) and the RETRY_CAP counter must not advance -- same reasoning
//    as the transport-failure case above.
// ===========================================================================
async function testHttp500RetriesAll() {
  const db = freshDb();
  seedAck(db, 301, 'cmd-301');
  const node = nodeById('command-ack-mark-delivered');
  const { resultPromise } = execute(node, {
    statusCode: 500,
    _commandAckIds: [301],
    _localAckCorrelation: { 'cmd-301': [301] },
    payload: { error: 'Internal Server Error' },
  }, db);
  await resultPromise;
  const rows = rowsById(db);
  assert.equal(rows[301].delivered_at, null);
  assert.equal(rows[301].retry_count, 0, 'an HTTP 5xx response must never advance the RETRY_CAP counter');
  db.close();
}

// ===========================================================================
// F93 (2026-09-17 overnight, T13k): Silvan command_ack_outbox row 1 answered
// HTTP 400 (HttpMessageNotReadableException -- the cloud's CommandAckEntry
// commandId is a Long and cannot deserialize a UUID) and was bucketed as a
// transport failure, so it retried the SAME malformed batch every 30s
// forever, blocking every later ack behind it. A 4xx that names a permanent
// client-side rejection (400/404/409/413/415/422) must dead-letter the whole
// batch after ONE attempt; 401/403/429/5xx/0 must stay transport retries
// (401/403 need to survive long enough for a token refresh to fix them).
// RED on pre-fix code: every non-2xx response (including 400) falls into the
// single `transportReasons` bucket, which is never dead-lettered.
// ===========================================================================
async function testHttp400DeadLettersAfterOneAttempt() {
  const db = freshDb();
  seedAck(db, 901, 'cmd-901-uuid-not-long');
  const node = nodeById('command-ack-mark-delivered');
  const { resultPromise } = execute(node, {
    statusCode: 400,
    _commandAckIds: [901],
    _localAckCorrelation: { 'cmd-901-uuid-not-long': [901] },
    payload: { message: "Cannot deserialize value of type `java.lang.Long` from String \"cmd-901-uuid-not-long\"" },
  }, db);
  await resultPromise;
  const rows = rowsById(db);
  assert.ok(rows[901].delivered_at, 'a permanent 4xx client error must dead-letter the batch after one attempt, not retry it forever (F93)');
  assert.equal(rows[901].retry_count, 0, 'a batch-level permanent dead-letter is not a "retry" and must not consume the RETRY_CAP budget');
  assert.match(rows[901].last_error || '', /^dead_letter: http 400/, 'the dead-letter reason must name the permanent 4xx status');
  db.close();
}

async function testHttp503LeavesPendingForRetry() {
  const db = freshDb();
  seedAck(db, 902, 'cmd-902');
  const node = nodeById('command-ack-mark-delivered');
  const { resultPromise } = execute(node, {
    statusCode: 503,
    _commandAckIds: [902],
    _localAckCorrelation: { 'cmd-902': [902] },
    payload: { error: 'Service Unavailable' },
  }, db, { flowState: {} });
  await resultPromise;
  const rows = rowsById(db);
  assert.equal(rows[902].delivered_at, null, 'a transport 5xx must stay pending for redelivery, never dead-letter');
  assert.equal(rows[902].retry_count, 0, 'a transport failure must never advance the RETRY_CAP counter');
  db.close();
}

async function testPermanentClientErrorStatusesAllDeadLetter() {
  const statuses = [404, 409, 413, 415, 422];
  for (const statusCode of statuses) {
    const db = freshDb();
    const rowId = 910 + statusCode;
    seedAck(db, rowId, 'cmd-' + rowId);
    const node = nodeById('command-ack-mark-delivered');
    const { resultPromise } = execute(node, {
      statusCode,
      _commandAckIds: [rowId],
      _localAckCorrelation: { ['cmd-' + rowId]: [rowId] },
      payload: { message: 'rejected' },
    }, db, { flowState: {} });
    await resultPromise;
    const rows = rowsById(db);
    assert.ok(rows[rowId].delivered_at, 'HTTP ' + statusCode + ' must dead-letter the batch after one attempt (F93)');
    assert.match(rows[rowId].last_error || '', new RegExp('^dead_letter: http ' + statusCode), 'HTTP ' + statusCode + ' dead-letter reason must name the status');
    db.close();
  }
}

async function testAuthAndRateLimitStatusesStayTransport() {
  const statuses = [401, 403, 429];
  for (const statusCode of statuses) {
    const db = freshDb();
    const rowId = 920 + statusCode;
    seedAck(db, rowId, 'cmd-' + rowId);
    const node = nodeById('command-ack-mark-delivered');
    const { resultPromise } = execute(node, {
      statusCode,
      _commandAckIds: [rowId],
      _localAckCorrelation: { ['cmd-' + rowId]: [rowId] },
      payload: { message: statusCode === 429 ? 'rate limited' : 'unauthorized' },
    }, db, { flowState: {} });
    await resultPromise;
    const rows = rowsById(db);
    assert.equal(rows[rowId].delivered_at, null,
      'HTTP ' + statusCode + ' must stay a transport retry, never dead-letter (401/403 need the token-refresh path; 429 is inherently transient)');
    assert.equal(rows[rowId].retry_count, 0, 'HTTP ' + statusCode + ' must never advance the RETRY_CAP counter');
    db.close();
  }
}

// ===========================================================================
// 3b. Codex P1 (PR #243 review): 25 CONSECUTIVE statusCode=0 transport
//     failures (more than RETRY_CAP=20) must never dead-letter the row --
//     the cloud never answered any of these, so none of them may count
//     toward the cap. RED on pre-fix code: the shipped node buckets every
//     transport-failure id into the same capped retryReasons map used for
//     real per-entry cloud answers, so the 20th consecutive tick sets
//     delivered_at via the retry-cap CASE expression even though the cloud
//     was never reached.
// ===========================================================================
async function testTransportFailureRepeatedNeverDeadLetters() {
  const db = freshDb();
  seedAck(db, 501, 'cmd-501');
  const node = nodeById('command-ack-mark-delivered');
  for (let i = 0; i < 25; i += 1) {
    const { resultPromise } = execute(node, {
      statusCode: 0,
      _commandAckIds: [501],
      _localAckCorrelation: { 'cmd-501': [501] },
      payload: { error: 'Command ACK REST IPv4 request failed', code: 'ECONNREFUSED' },
    }, db);
    await resultPromise;
  }
  const rows = rowsById(db);
  assert.equal(rows[501].delivered_at, null,
    '25 consecutive transport failures must never dead-letter a row the cloud never answered');
  assert.equal(rows[501].retry_count, 0,
    'transport failures must never advance the RETRY_CAP counter, however many happen in a row');
  db.close();
}

// ===========================================================================
// 4b. Codex P1 (PR #243 review): 25 CONSECUTIVE HTTP 503 responses must also
//     never dead-letter the row. Same reasoning as 3b: a 5xx/429 response
//     means the cloud did not answer per entry, so it must not spend the
//     RETRY_CAP budget. RED on pre-fix code for the same reason as 3b.
// ===========================================================================
async function testHttp503RepeatedNeverDeadLetters() {
  const db = freshDb();
  seedAck(db, 601, 'cmd-601');
  const node = nodeById('command-ack-mark-delivered');
  for (let i = 0; i < 25; i += 1) {
    const { resultPromise } = execute(node, {
      statusCode: 503,
      _commandAckIds: [601],
      _localAckCorrelation: { 'cmd-601': [601] },
      payload: { error: 'Service Unavailable' },
    }, db);
    await resultPromise;
  }
  const rows = rowsById(db);
  assert.equal(rows[601].delivered_at, null,
    '25 consecutive HTTP 503 responses must never dead-letter a row the cloud never answered per entry');
  assert.equal(rows[601].retry_count, 0,
    'HTTP 5xx responses must never advance the RETRY_CAP counter, however many happen in a row');
  db.close();
}

// ===========================================================================
// 5b. Codex P1 (PR #243 review) control case: 20 CONSECUTIVE real 200
//     responses that each carry a per-entry LEASE_MISMATCH result for the
//     same row must still dead-letter on the 20th, exactly as before the
//     fix -- proving the fix narrows the cap to genuine per-entry answers
//     without breaking the cap itself. Uses repeated real node invocations
//     (not a pre-seeded retry_count) to exercise the same code path 3b/4b
//     exercise.
// ===========================================================================
async function testRepeatedLeaseMismatchStillDeadLettersAtCap() {
  const db = freshDb();
  seedAck(db, 701, 'cmd-701');
  const node = nodeById('command-ack-mark-delivered');
  let rows;
  for (let i = 0; i < 20; i += 1) {
    const { resultPromise } = execute(node, {
      statusCode: 200,
      _commandAckIds: [701],
      _localAckCorrelation: { 'cmd-701': [701] },
      payload: { results: [{ commandId: 'cmd-701', status: 'LEASE_MISMATCH', terminal: false }] },
    }, db);
    await resultPromise;
    rows = rowsById(db);
    if (i < 19) {
      assert.equal(rows[701].delivered_at, null, 'row must stay pending before the 20th LEASE_MISMATCH answer');
    }
  }
  assert.equal(rows[701].retry_count, 20, 'retry_count must reach RETRY_CAP after 20 genuine per-entry answers');
  assert.ok(rows[701].delivered_at, 'the 20th genuine LEASE_MISMATCH answer must still dead-letter, unchanged by the fix');
  assert.match(rows[701].last_error || '', /retry_cap_exceeded/);
  db.close();
}

// ===========================================================================
// 5. Retry cap: a row already at retry_count=19 (one more retry would be the
//    20th) is dead-lettered instead of retried forever.
// ===========================================================================
async function testRetryCapDeadLetters() {
  const db = freshDb();
  seedAck(db, 401, 'cmd-401', 0, 19);
  const node = nodeById('command-ack-mark-delivered');
  const { resultPromise } = execute(node, {
    statusCode: 200,
    _commandAckIds: [401],
    _localAckCorrelation: { 'cmd-401': [401] },
    payload: { results: [{ commandId: 'cmd-401', status: 'LEASE_MISMATCH', terminal: false }] },
  }, db);
  await resultPromise;
  const rows = rowsById(db);
  assert.equal(rows[401].retry_count, 20, 'retry_count must still increment on the capping retry');
  assert.ok(rows[401].delivered_at, 'the 20th retry must dead-letter instead of leaving the row retryable forever');
  assert.match(rows[401].last_error || '', /retry_cap_exceeded/);
  db.close();
}

// ===========================================================================
// 6. sync-pending-split: strict integer-2xx predicate reports a transport
//    failure (statusCode=0) as a transport failure, not the generic
//    "Unexpected pending command response" / statusCode: null fallback.
//    RED on origin/main: `msg.statusCode && (...)` treats 0 as falsy, so the
//    branch is skipped and the transport error payload falls through to the
//    array-shape check, misreporting itself with statusCode: null.
// ===========================================================================
function testPendingSplitTransportZero() {
  const db = freshDb();
  const node = nodeById('sync-pending-split');
  const { resultPromise, flowState } = execute(node, {
    statusCode: 0,
    payload: { error: 'Pending command REST IPv4 request failed', detail: 'connect ECONNREFUSED' },
  }, db);
  // sync-pending-split is synchronous (no `return (async()=>{...})()` wrapper);
  // still invoked through the async IIFE harness, so unwrap the resolved value.
  return resultPromise.then((out) => {
    assert.equal(out, null);
    assert.ok(flowState.sync_state && flowState.sync_state.lastError, 'sync_state.lastError must be set');
    assert.equal(flowState.sync_state.lastError.source, 'pending-commands');
    assert.equal(flowState.sync_state.lastError.message, 'Pending command poll failed',
      'a statusCode=0 transport failure must be reported as a poll failure, not fall through to the generic "Unexpected pending command response" branch');
    assert.equal(flowState.sync_state.lastError.statusCode, 0,
      'statusCode must be reported as the real transport sentinel 0, not null');
    db.close();
  });
}

function testPendingSplitHttp200StillReplays() {
  const db = freshDb();
  const node = nodeById('sync-pending-split');
  const { resultPromise } = execute(node, {
    statusCode: 200,
    payload: [{ commandId: 1, commandType: 'SET_STREGA_TIMED_ACTION', eventUuid: 'e1', aggregateType: 'DEVICE', aggregateKey: 'AABBCCDDEEFF0011' }],
  }, db);
  return resultPromise.then((out) => {
    assert.ok(Array.isArray(out), 'sync-pending-split must still return the split output arrays on a real 200');
    assert.equal(out[0].length, 1);
    db.close();
  });
}

(async () => {
  await checkAsync('command-ack-build-batch sets msg._localAckCorrelation from command_id', testBuildBatchCorrelation);
  await checkAsync('command-ack-mark-delivered: mixed 200 result set marks each row by its own outcome', testMixedResultsPerEntry);
  await checkAsync('command-ack-mark-delivered: statusCode=0 retries every row', testTransportFailureZeroRetriesAll);
  await checkAsync('command-ack-mark-delivered: HTTP 500 retries every row', testHttp500RetriesAll);
  await checkAsync('command-ack-mark-delivered: retry cap dead-letters instead of retrying forever', testRetryCapDeadLetters);
  await checkAsync('command-ack-mark-delivered: HTTP 400 dead-letters the batch after one attempt (F93)', testHttp400DeadLettersAfterOneAttempt);
  await checkAsync('command-ack-mark-delivered: HTTP 503 leaves the row pending for retry (F93)', testHttp503LeavesPendingForRetry);
  await checkAsync('command-ack-mark-delivered: 404/409/413/415/422 all dead-letter after one attempt (F93)', testPermanentClientErrorStatusesAllDeadLetter);
  await checkAsync('command-ack-mark-delivered: 401/403/429 stay transport retries (F93)', testAuthAndRateLimitStatusesStayTransport);
  await checkAsync('command-ack-mark-delivered: 25 consecutive transport failures never dead-letter (Codex P1)', testTransportFailureRepeatedNeverDeadLetters);
  await checkAsync('command-ack-mark-delivered: 25 consecutive HTTP 503 responses never dead-letter (Codex P1)', testHttp503RepeatedNeverDeadLetters);
  await checkAsync('command-ack-mark-delivered: 20 consecutive genuine LEASE_MISMATCH answers still dead-letter at the cap (Codex P1 control)', testRepeatedLeaseMismatchStillDeadLettersAtCap);
  await checkAsync('sync-pending-split: statusCode=0 reports itself as a transport failure', testPendingSplitTransportZero);
  await checkAsync('sync-pending-split: a real 200 still replays commands', testPendingSplitHttp200StillReplays);

  if (failures > 0) {
    console.error('\ntest-command-ack-mark-delivered: FAIL (' + failures + ' failing check(s))');
    process.exit(1);
  }
  console.log('\ntest-command-ack-mark-delivered: PASS');
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
