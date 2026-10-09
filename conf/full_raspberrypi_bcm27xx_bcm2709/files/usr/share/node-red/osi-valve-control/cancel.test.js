'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDb, linkCloud } = require('./test-helpers');
const { cancelActuation } = require('./cancel');

const EUI = '0016C001F1000001';

async function insertExpectation(db, { id, state, commandedAt, deviceEui }) {
  await db.run(
    "INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, trigger, created_at) " +
    "VALUES (?, ?, ?, 900, ?, 'unknown', ?, 'on_valve_schedule', ?)",
    [id, deviceEui || EUI, commandedAt, commandedAt, state, commandedAt]
  );
}

function countingFlush() {
  const calls = [];
  const fn = async (eui) => { calls.push(eui); return { statusCode: 202 }; };
  fn.calls = calls;
  return fn;
}

// #428: a cancel stops the actuation it names, never "the newest". Without a name it is
// accepted only while exactly one actuation is active.
test('cancelActuation without an expectation id refuses while two actuations are active: no flush, nothing changed', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e-old', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });
  await insertExpectation(db, { id: 'e-new', state: 'OBSERVED_RUNNING', commandedAt: '2026-08-25T10:05:00.000Z' });
  const flushQueue = countingFlush();

  const out = await cancelActuation({ db, deviceEui: EUI, reason: 'field_visit', flushQueue, now: new Date('2026-08-25T10:06:00.000Z') });

  assert.equal(out.ok, false);
  assert.equal(out.error, 'ambiguous_actuation');
  assert.equal(out.permanent, true, 'the refusal is final for this command');
  assert.equal(flushQueue.calls.length, 0, 'nothing is flushed');
  const states = (await db.all('SELECT reconciliation_state FROM valve_actuation_expectations ORDER BY expectation_id')).map((r) => r.reconciliation_state);
  assert.deepEqual(states, ['OBSERVED_RUNNING', 'PENDING_OBSERVATION']);
  db.close();
});

test('cancelActuation with an expectation id cancels that actuation, not the newest, and sets cancel_reason', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e-old', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });
  await insertExpectation(db, { id: 'e-new', state: 'OBSERVED_RUNNING', commandedAt: '2026-08-25T10:05:00.000Z' });
  const flushQueue = countingFlush();

  const out = await cancelActuation({ db, deviceEui: EUI, expectationId: 'e-old', reason: 'field_visit', flushQueue, now: new Date('2026-08-25T10:06:00.000Z') });

  assert.equal(out.ok, true);
  assert.equal(out.expectationId, 'e-old');
  assert.deepEqual(out.downlinks, []);
  const rows = await db.all('SELECT expectation_id, reconciliation_state, cancel_reason FROM valve_actuation_expectations');
  const byId = Object.fromEntries(rows.map((r) => [r.expectation_id, r]));
  assert.equal(byId['e-old'].reconciliation_state, 'CANCELLED');
  assert.equal(byId['e-old'].cancel_reason, 'field_visit');
  assert.equal(byId['e-new'].reconciliation_state, 'OBSERVED_RUNNING', 'the other actuation keeps running');
  const device = await db.get('SELECT target_state FROM devices WHERE deveui=?', [EUI]);
  assert.notEqual(device.target_state, 'CLOSED', 'a valve with another active actuation is not marked closed');
  db.close();
});

test('cancelActuation with the id of an actuation that already ended refuses actuation_not_active, permanently', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e-done', state: 'OBSERVED_COMPLETE', commandedAt: '2026-08-25T10:00:00.000Z' });
  await insertExpectation(db, { id: 'e-live', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:05:00.000Z' });
  const flushQueue = countingFlush();
  const out = await cancelActuation({ db, deviceEui: EUI, expectationId: 'e-done', reason: null, flushQueue });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'actuation_not_active');
  assert.equal(out.permanent, true);
  assert.equal(flushQueue.calls.length, 0);
  assert.equal((await db.get("SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id='e-live'")).reconciliation_state, 'PENDING_OBSERVATION');
  db.close();
});

test('cancelActuation with an id this gateway does not know answers no_active_actuation, not a permanent refusal', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e-live', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:05:00.000Z' });
  const out = await cancelActuation({ db, deviceEui: EUI, expectationId: 'e-unknown', reason: null, flushQueue: countingFlush() });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'no_active_actuation');
  assert.equal(out.permanent, false);
  db.close();
});

function queueItem(id, fPort, bytes, extra) {
  return Object.assign({ id, fPort, data: Buffer.from(bytes).toString('base64'), confirmed: false, isPending: false, isEncrypted: false }, extra || {});
}

function fakeQueue(items) {
  const queue = items.slice();
  const calls = { flush: 0, enqueued: [] };
  const counters = { nFCntDown: 0, aFCntDown: 40 };
  return {
    queue,
    calls,
    counters,
    readFrameCounter: async () => Object.assign({}, counters),
    flushQueue: async () => { calls.flush += 1; queue.splice(0, queue.length); return { statusCode: 200 }; },
    readQueue: async () => queue.map((item) => Object.assign({}, item)),
    enqueue: async (item) => { calls.enqueued.push(item); queue.push(queueItem('re-' + calls.enqueued.length, item.fPort, [...Buffer.from(item.data, 'base64')], { confirmed: item.confirmed })); return {}; },
  };
}

test('cancelActuation takes only the named actuation\'s open out of the queue and puts the rest back in order', async () => {
  const { db } = await tempDb();
  // Both opens are 900 s = [0x41, 15]; A was commanded first, so its open is the first one queued.
  await insertExpectation(db, { id: 'e-a', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });
  await insertExpectation(db, { id: 'e-b', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:01:00.000Z' });
  const q = fakeQueue([
    queueItem('q-a', 2, [0x41, 15]),
    queueItem('q-plan', 10, [0x01, 0x02, 0x03]),
    queueItem('q-b', 2, [0x41, 15]),
    queueItem('q-cfg', 11, [0x00, 0x0f, 0x00, 0x02], { confirmed: true }),
  ]);
  const out = await cancelActuation({ db, deviceEui: EUI, expectationId: 'e-a', reason: null, flushQueue: q.flushQueue, readQueue: q.readQueue, enqueue: q.enqueue, readFrameCounter: q.readFrameCounter });
  assert.equal(out.ok, true);
  assert.equal(out.queueScope, 'target_only');
  assert.equal(out.queueItemsKept, 3);
  assert.equal(out.queueItemsLost, 0);
  assert.deepEqual(q.queue.map((item) => [item.fPort, Buffer.from(item.data, 'base64').toString('hex'), item.confirmed]),
    [[10, '010203', false], [2, '410f', false], [11, '000f0002', true]]);
  db.close();
});

test('cancelActuation does not touch the queue when the named actuation\'s open has already been sent', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e-a', state: 'OBSERVED_RUNNING', commandedAt: '2026-08-25T10:00:00.000Z' });
  await insertExpectation(db, { id: 'e-b', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:01:00.000Z' });
  // Only one matching open is still queued: first in, first out, so it is B's.
  const q = fakeQueue([queueItem('q-b', 2, [0x41, 15]), queueItem('q-plan', 10, [0x01])]);
  const out = await cancelActuation({ db, deviceEui: EUI, expectationId: 'e-a', reason: null, flushQueue: q.flushQueue, readQueue: q.readQueue, enqueue: q.enqueue });
  assert.equal(out.ok, true);
  assert.equal(out.queueScope, 'not_queued');
  assert.equal(q.calls.flush, 0, 'B\'s open and the plan push stay queued');
  assert.equal(q.queue.length, 2);
  assert.equal((await db.get("SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id='e-a'")).reconciliation_state, 'CANCELLED');
  db.close();
});

test('cancelActuation still stops the actuation when the queue cannot be read: it flushes the whole queue and says so', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e-a', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });
  const q = fakeQueue([queueItem('q-a', 2, [0x41, 15])]);
  const warnings = [];
  const out = await cancelActuation({
    db, deviceEui: EUI, reason: null, flushQueue: q.flushQueue, enqueue: q.enqueue,
    readQueue: async () => { throw new Error('unavailable'); }, warn: (m) => warnings.push(m),
  });
  assert.equal(out.ok, true);
  assert.equal(out.queueScope, 'full_flush');
  assert.equal(q.calls.flush, 1);
  assert.equal(q.queue.length, 0);
  assert.ok(warnings.some((w) => /device queue unreadable/.test(w)));
  db.close();
});

// P3-E1: cancelActuation is one of the code seams that changes ValveRuntime's derived state
// (the CANCELLED row drops out of active_actuation).
test('cancelActuation emits a VALVE_RUNTIME_CHANGED sync_outbox row on a linked gateway, and none on an unlinked one', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e1', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });
  await cancelActuation({ db, deviceEui: EUI, reason: null, flushQueue: countingFlush(), now: new Date('2026-08-25T10:05:00.000Z') });
  assert.equal((await db.all('SELECT * FROM sync_outbox')).length, 0, 'unlinked gateway must not enqueue anything');

  await insertExpectation(db, { id: 'e2', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:10:00.000Z' });
  await linkCloud(db);
  await cancelActuation({ db, deviceEui: EUI, reason: null, flushQueue: countingFlush(), now: new Date('2026-08-25T10:15:00.000Z') });
  const rows = await db.all('SELECT op, aggregate_key, payload_json FROM sync_outbox');
  const runtimeRow = rows.find((r) => r.op === 'VALVE_RUNTIME_CHANGED');
  assert.ok(runtimeRow);
  assert.equal(runtimeRow.aggregate_key, EUI);
  assert.equal(JSON.parse(runtimeRow.payload_json).active_actuation, null, 'the just-cancelled row must not appear as active');
  db.close();
});

// cloud full-parity Task P4-E1: CANCELLED is a terminal reconciliation_state -- cancelActuation
// is the ONLY code seam that ever writes it, so it must also archive it.
test('cancelActuation emits a VALVE_ACTUATION_ARCHIVED sync_outbox row (status=CANCELLED) on a linked gateway, and none on an unlinked one', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e1', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });
  await cancelActuation({ db, deviceEui: EUI, reason: 'field_visit', flushQueue: countingFlush(), now: new Date('2026-08-25T10:05:00.000Z') });
  assert.equal((await db.all('SELECT * FROM sync_outbox')).length, 0, 'unlinked gateway must not enqueue anything');

  await insertExpectation(db, { id: 'e2', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:10:00.000Z' });
  await linkCloud(db);
  await cancelActuation({ db, deviceEui: EUI, reason: 'field_visit', flushQueue: countingFlush(), now: new Date('2026-08-25T10:15:00.000Z') });
  const rows = await db.all('SELECT op, aggregate_key, payload_json FROM sync_outbox');
  const archiveRow = rows.find((r) => r.op === 'VALVE_ACTUATION_ARCHIVED');
  assert.ok(archiveRow, 'a VALVE_ACTUATION_ARCHIVED row must be enqueued alongside VALVE_RUNTIME_CHANGED');
  assert.equal(archiveRow.aggregate_key, 'e2', 'aggregate_key is the expectation_id, not the device_eui');
  const payload = JSON.parse(archiveRow.payload_json);
  assert.equal(payload.expectation_id, 'e2');
  assert.equal(payload.status, 'CANCELLED');
  assert.equal(payload.cancel_reason, 'field_visit');
  db.close();
});

test('cancelActuation: an emit failure in emitActuationArchived is isolated the same way emitRuntimeChanged is -- ok:true, cancel committed, warn visible', async () => {
  const { db } = await tempDb();
  await linkCloud(db);
  await insertExpectation(db, { id: 'e1', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });
  const warnings = [];
  let insertCount = 0;
  const failingDb = {
    get: (...args) => db.get(...args),
    all: (...args) => db.all(...args),
    run: (sql, params) => {
      if (/insert into sync_outbox/i.test(sql)) {
        insertCount += 1;
        // Let the first insert (VALVE_RUNTIME_CHANGED) through; fail the second (the archive).
        if (insertCount === 2) return Promise.reject(new Error('boom'));
      }
      return db.run(sql, params);
    },
    transaction: (...args) => db.transaction(...args),
    close: (...args) => db.close(...args),
  };

  const out = await cancelActuation({ db: failingDb, deviceEui: EUI, reason: null, flushQueue: countingFlush(), now: new Date('2026-08-25T10:05:00.000Z'), warn: (m) => warnings.push(m) });

  assert.equal(out.ok, true, 'an archive-emission failure must not turn a successful cancel into ok:false');
  const row = await db.get('SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id=?', ['e1']);
  assert.equal(row.reconciliation_state, 'CANCELLED', 'the cancel itself must still have committed');
  assert.equal((await db.all("SELECT * FROM sync_outbox WHERE op='VALVE_RUNTIME_CHANGED'")).length, 1, 'the runtime emit that succeeded must still have committed');
  assert.ok(warnings.some((w) => /actuation-archive emit failed/.test(w)), 'the failure must still be visible via warn');
  db.close();
});

// P3-E1 review fix (IMPORTANT 4): the emit used to be uncaught -- a failure there converted an
// already-successful cancel (expectation CANCELLED, ChirpStack queue already flushed) into a
// reported failure, and a retry afterward would find no_active_actuation and report a confusing
// false error on an operation that had, in truth, fully succeeded the first time.
test('cancelActuation still reports ok:true (and still committed the cancel) even when the runtime emission itself fails', async () => {
  const { db } = await tempDb();
  await linkCloud(db);
  await insertExpectation(db, { id: 'e1', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });
  const warnings = [];
  const failingDb = {
    get: (...args) => db.get(...args),
    all: (...args) => db.all(...args),
    run: (sql, params) => (/insert into sync_outbox/i.test(sql) ? Promise.reject(new Error('boom')) : db.run(sql, params)),
    transaction: (...args) => db.transaction(...args),
    close: (...args) => db.close(...args),
  };

  const out = await cancelActuation({ db: failingDb, deviceEui: EUI, reason: null, flushQueue: countingFlush(), now: new Date('2026-08-25T10:05:00.000Z'), warn: (m) => warnings.push(m) });

  assert.equal(out.ok, true, 'a runtime-emission failure must not turn a successful cancel into ok:false');
  const row = await db.get('SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id=?', ['e1']);
  assert.equal(row.reconciliation_state, 'CANCELLED', 'the cancel itself must still have committed');
  assert.ok(warnings.some((w) => /runtime emit failed/.test(w)), 'the failure must still be visible via warn');
  db.close();
});

test('cancelActuation with no active expectation matches the REST route: no flush, ok:false, no_active_actuation', async () => {
  const { db } = await tempDb();
  const flushQueue = countingFlush();

  const out = await cancelActuation({ db, deviceEui: EUI, reason: 'operator_cancel', flushQueue, now: new Date() });

  assert.equal(out.ok, false);
  assert.equal(out.error, 'no_active_actuation');
  assert.deepEqual(out.downlinks, []);
  assert.equal(flushQueue.calls.length, 0, 'the REST route never flushes when there is nothing active to cancel');
  db.close();
});

test('cancelActuation on an unknown EUI returns not_found', async () => {
  const { db } = await tempDb();
  const flushQueue = countingFlush();
  const out = await cancelActuation({ db, deviceEui: 'FFFFFFFFFFFFFFFF', reason: null, flushQueue, now: new Date() });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'not_found');
  assert.equal(flushQueue.calls.length, 0);
  db.close();
});

test('cancelActuation on a non-valve device returns not_a_valve', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES ('0016C001F1000099','Sensor','DRAGINO_LSN50',1,datetime('now'),datetime('now'))");
  const flushQueue = countingFlush();
  const out = await cancelActuation({ db, deviceEui: '0016C001F1000099', reason: null, flushQueue, now: new Date() });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'not_a_valve');
  assert.equal(flushQueue.calls.length, 0);
  db.close();
});

test('cancelActuation treats an explicit null reason the same as absence: defaults to operator_cancel', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e1', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });
  const flushQueue = countingFlush();

  const out = await cancelActuation({ db, deviceEui: EUI, reason: null, flushQueue, now: new Date() });

  assert.equal(out.ok, true);
  const row = await db.get('SELECT cancel_reason FROM valve_actuation_expectations WHERE expectation_id=?', ['e1']);
  assert.equal(row.cancel_reason, 'operator_cancel');
  db.close();
});

// F96: valve_actuation_expectations.cancel_reason (SQLite TEXT, unbounded) is shipped
// verbatim as ValveActuation.cancel_reason by sync-bootstrap-build/sync-force-build's
// `vae.cancel_reason` column read, and the cloud's mirror column is varchar(255) -- an
// oversized reason (e.g. free text forwarded from a cloud CANCEL_VALVE_ACTUATION command)
// would 500 the gateway's whole cloud bootstrap the same way F96's result_detail overflow
// did. Capped at the writer here (defense in depth alongside the sync-bootstrap-build/
// sync-force-build payload boundary, which also caps this field).
test('cancelActuation caps an oversized reason at 255 chars with a truncation marker (F96)', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e1', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });
  const longReason = 'cloud-forwarded cancellation note: ' + 'x'.repeat(300);
  assert.ok(longReason.length > 255, 'fixture must actually exceed the cloud column width');
  const warnings = [];

  const out = await cancelActuation({
    db, deviceEui: EUI, reason: longReason, flushQueue: countingFlush(), now: new Date(),
    warn: (msg) => warnings.push(msg),
  });

  assert.equal(out.ok, true);
  const row = await db.get('SELECT cancel_reason FROM valve_actuation_expectations WHERE expectation_id=?', ['e1']);
  assert.ok(
    row.cancel_reason.length <= 255,
    'valve_actuation_expectations.cancel_reason must never exceed the cloud mirror\'s varchar(255) width: got ' +
      row.cancel_reason.length
  );
  assert.ok(row.cancel_reason.includes('…[truncated]'), 'truncation must be marked, never silent');
  assert.ok(longReason.startsWith(row.cancel_reason.replace('…[truncated]', '')), 'must be a prefix truncation, not garbled');
  assert.ok(
    warnings.some((w) => w.includes(longReason)),
    'the full untruncated reason must still be logged, not just discarded'
  );
  db.close();
});

test('cancelActuation applied twice (command replay) is harmless: second call finds nothing active and does not throw', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e1', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });
  const flushQueue = countingFlush();

  const first = await cancelActuation({ db, deviceEui: EUI, reason: 'operator_cancel', flushQueue, now: new Date() });
  assert.equal(first.ok, true);

  const second = await cancelActuation({ db, deviceEui: EUI, reason: 'operator_cancel', flushQueue, now: new Date() });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'no_active_actuation');
  assert.equal(flushQueue.calls.length, 1, 'the replay must not flush again since nothing is active');

  const row = await db.get('SELECT reconciliation_state, cancel_reason FROM valve_actuation_expectations WHERE expectation_id=?', ['e1']);
  assert.equal(row.reconciliation_state, 'CANCELLED');
  assert.equal(row.cancel_reason, 'operator_cancel', 'replay must not have overwritten the original cancel_reason');
  db.close();
});

test('cancelActuation sets devices.target_state to CLOSED, matching the REST route side effect', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e1', state: 'OBSERVED_RUNNING', commandedAt: '2026-08-25T10:00:00.000Z' });
  const flushQueue = countingFlush();

  await cancelActuation({ db, deviceEui: EUI, reason: null, flushQueue, now: new Date() });

  const row = await db.get('SELECT target_state FROM devices WHERE UPPER(deveui)=?', [EUI]);
  assert.equal(row.target_state, 'CLOSED');
  db.close();
});

// --- Review fix (Task 1.4, finding 1): fail closed when there is no way to flush the
// ChirpStack queue, instead of silently skipping the flush and still marking the
// expectation CANCELLED / closing target_state -- a queued OPEN_FOR_DURATION could
// otherwise still reach the valve while both sides believe it was cancelled. ---

test('cancelActuation fails closed with chirpstack_unavailable when flushQueue is not a function (bridge could not build a ChirpStack client): no row mutated, no flush', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e1', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });

  const outNull = await cancelActuation({ db, deviceEui: EUI, reason: 'operator_cancel', flushQueue: null, now: new Date() });
  assert.equal(outNull.ok, false);
  assert.equal(outNull.error, 'chirpstack_unavailable');
  assert.deepEqual(outNull.downlinks, []);

  const outUndefined = await cancelActuation({ db, deviceEui: EUI, reason: 'operator_cancel', now: new Date() });
  assert.equal(outUndefined.ok, false);
  assert.equal(outUndefined.error, 'chirpstack_unavailable');

  const row = await db.get('SELECT reconciliation_state, cancel_reason FROM valve_actuation_expectations WHERE expectation_id=?', ['e1']);
  assert.equal(row.reconciliation_state, 'PENDING_OBSERVATION', 'the expectation must not be mutated when the queue cannot be flushed');
  assert.equal(row.cancel_reason, null);
  const device = await db.get('SELECT target_state FROM devices WHERE UPPER(deveui)=?', [EUI]);
  assert.notEqual(device.target_state, 'CLOSED', 'target_state must not be closed when the queue cannot be flushed');
  db.close();
});

test('cancelActuation flushes BEFORE marking CANCELLED: a flush failure propagates and leaves the expectation untouched (fail-closed ordering)', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e1', state: 'OBSERVED_RUNNING', commandedAt: '2026-08-25T10:00:00.000Z' });
  const failingFlush = async () => { throw new Error('chirpstack unreachable'); };

  await assert.rejects(
    cancelActuation({ db, deviceEui: EUI, reason: 'operator_cancel', flushQueue: failingFlush, now: new Date() }),
    /chirpstack unreachable/
  );

  const row = await db.get('SELECT reconciliation_state, cancel_reason FROM valve_actuation_expectations WHERE expectation_id=?', ['e1']);
  assert.equal(row.reconciliation_state, 'OBSERVED_RUNNING', 'a failed flush must leave the expectation unmutated - flush happens before the write');
  assert.equal(row.cancel_reason, null);
  const device = await db.get('SELECT target_state FROM devices WHERE UPPER(deveui)=?', [EUI]);
  assert.notEqual(device.target_state, 'CLOSED');
  db.close();
});

// Fix round (F2): ChirpStack may send a queued item between the cancel's queue read and its
// flush. The item is still in the list read before, so queueing it again would send it
// twice; for another actuation's open that is a second watering the ledger never sees.
function racingQueue(items, sendDuringFlush) {
  const q = fakeQueue(items);
  const flush = q.flushQueue;
  q.flushQueue = async (eui) => {
    if (sendDuringFlush) q.counters.aFCntDown += 1;
    return flush(eui);
  };
  return q;
}

test('cancelActuation does not queue another open again when a downlink was sent during the cancel', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e-a', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });
  await insertExpectation(db, { id: 'e-b', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:01:00.000Z' });
  const q = racingQueue([
    queueItem('q-a', 2, [0x41, 15]),
    queueItem('q-plan', 10, [0x01, 0x02, 0x03]),
    queueItem('q-b', 2, [0x41, 15]),
  ], true);
  const warnings = [];
  const out = await cancelActuation({
    db, deviceEui: EUI, expectationId: 'e-a', reason: null, warn: (m) => warnings.push(m),
    flushQueue: q.flushQueue, readQueue: q.readQueue, enqueue: q.enqueue, readFrameCounter: q.readFrameCounter,
  });
  assert.equal(out.ok, true);
  assert.equal(out.queueScope, 'target_only_degraded');
  assert.deepEqual(q.queue.map((item) => [item.fPort, Buffer.from(item.data, 'base64').toString('hex')]), [[10, '010203']],
    'the plan push is queued again; B\'s open, possibly already sent, is not');
  assert.ok(warnings.some((w) => /not queued again/.test(w)));
  db.close();
});

test('cancelActuation queues other opens again only when the frame counter can be compared', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e-a', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });
  await insertExpectation(db, { id: 'e-b', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:01:00.000Z' });
  const q = racingQueue([queueItem('q-a', 2, [0x41, 15]), queueItem('q-b', 2, [0x41, 15])], false);
  const out = await cancelActuation({ db, deviceEui: EUI, expectationId: 'e-a', reason: null, flushQueue: q.flushQueue, readQueue: q.readQueue, enqueue: q.enqueue });
  assert.equal(out.queueScope, 'target_only_degraded', 'no counter reader: the safe side');
  assert.equal(q.queue.length, 0);
  db.close();
});

// Fix round (F3): an open the cancel cannot place in the queue is flushed, as main did,
// instead of being left queued under a CANCELLED actuation.
test('cancelActuation flushes the whole queue when the queue holds an open it cannot account for', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e-a', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });
  // e-a is 900 s = [0x41, 15]; the queued open is 20 minutes, from no known actuation.
  const q = fakeQueue([queueItem('q-x', 2, [0x41, 20]), queueItem('q-y', 2, [0x41, 21]), queueItem('q-plan', 10, [0x01])]);
  const out = await cancelActuation({ db, deviceEui: EUI, expectationId: 'e-a', reason: null, flushQueue: q.flushQueue, readQueue: q.readQueue, enqueue: q.enqueue, readFrameCounter: q.readFrameCounter });
  assert.equal(out.ok, true);
  assert.equal(out.queueScope, 'full_flush');
  assert.equal(q.calls.flush, 1);
  assert.equal(q.queue.length, 0);
  db.close();
});
