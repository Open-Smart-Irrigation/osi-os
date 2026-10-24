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
  return {
    queue,
    calls,
    flushQueue: async () => { calls.flush += 1; queue.splice(0, queue.length); return { statusCode: 200 }; },
    readQueue: async () => queue.map((item) => Object.assign({}, item)),
    enqueue: async (item) => { calls.enqueued.push(item); queue.push(queueItem('re-' + calls.enqueued.length, item.fPort, [...Buffer.from(item.data, 'base64')], { confirmed: item.confirmed })); return {}; },
  };
}

test('cancelActuation takes the named actuation\'s open out, puts plan and configuration items back in order, never another open', async () => {
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
  const warnings = [];
  const out = await cancelActuation({ db, deviceEui: EUI, expectationId: 'e-a', reason: null, flushQueue: q.flushQueue, readQueue: q.readQueue, enqueue: q.enqueue, warn: (m) => warnings.push(m) });
  assert.equal(out.ok, true);
  assert.equal(out.queueScope, 'target_only');
  assert.equal(out.queueItemsKept, 2);
  assert.equal(out.queueItemsLost, 0);
  assert.deepEqual(q.queue.map((item) => [item.fPort, Buffer.from(item.data, 'base64').toString('hex'), item.confirmed]),
    [[10, '010203', false], [11, '000f0002', true]],
    'B\'s open may have been sent after the queue read; it is never queued again');
  assert.deepEqual(out.droppedOpens, { count: 1, expectationIds: ['e-b'] });
  assert.equal((await db.get("SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id='e-b'")).reconciliation_state,
    'PENDING_OBSERVATION', 'the dropped actuation is reported, not marked CANCELLED');
  assert.equal(warnings.filter((w) => /took out the queued open of actuation e-b/.test(w)).length, 1, 'one log line per dropped actuation');
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

// Fix round 3 (R3): a partial opening ([0x31, pct] on fPort 27) or a flushing (fPort 28) moves
// the valve open with no end time; like an open, it is never queued again after the flush.
test('cancelActuation never queues a partial opening or a flushing again, and counts it as dropped', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e-a', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });
  const q = fakeQueue([
    queueItem('q-a', 2, [0x41, 15]),
    queueItem('q-partial', 27, [0x31, 50]),
    queueItem('q-partial-close', 27, [0x30, 50]),
    queueItem('q-flush', 28, [0x30, 40]),
    queueItem('q-cfg', 11, [0x00, 0x0f, 0x00, 0x02]),
  ]);
  const warnings = [];
  const out = await cancelActuation({ db, deviceEui: EUI, expectationId: 'e-a', reason: null, flushQueue: q.flushQueue, readQueue: q.readQueue, enqueue: q.enqueue, warn: (m) => warnings.push(m) });
  assert.equal(out.ok, true);
  assert.equal(out.queueScope, 'target_only', 'partial opening and flushing do not count as opens for the full-flush rule');
  assert.deepEqual(q.queue.map((item) => [item.fPort, Buffer.from(item.data, 'base64').toString('hex')]), [[27, '3032'], [11, '000f0002']]);
  assert.deepEqual(out.droppedOpens, { count: 2, expectationIds: [] });
  assert.equal(warnings.filter((w) => /partial-opening or flushing/.test(w)).length, 2);
  db.close();
});

// Fix round (F3): an open the cancel cannot place in the queue is flushed, as main did,
// instead of being left queued under a CANCELLED actuation.
test('cancelActuation flushes the whole queue when the queue holds an open it cannot account for', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e-a', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });
  // e-a is 900 s = [0x41, 15]; the queued open is 20 minutes, from no known actuation.
  const q = fakeQueue([queueItem('q-x', 2, [0x41, 20]), queueItem('q-y', 2, [0x41, 21]), queueItem('q-plan', 10, [0x01])]);
  const out = await cancelActuation({ db, deviceEui: EUI, expectationId: 'e-a', reason: null, flushQueue: q.flushQueue, readQueue: q.readQueue, enqueue: q.enqueue });
  assert.equal(out.ok, true);
  assert.equal(out.queueScope, 'full_flush');
  assert.deepEqual(out.droppedOpens, { count: 2, expectationIds: [] }, 'opens of no known actuation are counted');
  assert.equal(q.calls.flush, 1);
  assert.equal(q.queue.length, 0);
  db.close();
});

// --- Night-run conformance fix (B-1, M-2, M-3; D19/Q01 = (a)). With a transport the
// cancel is a whole-queue flush. A flushed open is handed_off: the pre-flush queue read does
// not prove the open unsent, because ChirpStack may deliver it between the read and the flush
// (owner decision 2026-10-24, fail closed; Codex P1 on PR #515). Nothing is marked and the open
// keeps fencing the valve. Every other owner the flush touched is returned as structured
// collateral. devices.target_state is written CLOSED only for a proven cancel (an open that never
// reached ChirpStack). Never a CLOSE downlink.
const { cancelHttpResponse } = require('./cancel');

async function setTransport(db, table, idColumn, id, transport) {
  await db.run('UPDATE ' + table + ' SET transport_json=? WHERE ' + idColumn + '=?', [JSON.stringify(transport), id]);
}

function flushTransport(snapshot, { failFlush = false } = {}) {
  const calls = { read: 0, flush: 0 };
  return {
    calls,
    getDeviceQueue: async () => { calls.read += 1; return snapshot; },
    flushDeviceQueue: async () => {
      calls.flush += 1;
      if (failFlush) throw new Error('flush rpc timed out');
      return {};
    },
    enqueueDownlink: async () => { throw new Error('a cancel must never enqueue anything'); },
  };
}

async function seedTransportCancel(db) {
  await insertExpectation(db, { id: 'e-target', state: 'PENDING_OBSERVATION', commandedAt: '2026-10-19T08:00:00.000Z' });
  await insertExpectation(db, { id: 'e-other', state: 'PENDING_OBSERVATION', commandedAt: '2026-10-19T08:01:00.000Z' });
  await setTransport(db, 'valve_actuation_expectations', 'expectation_id', 'e-target', { phase: 'ACCEPTED', queue_id: 'q-open', attempted_at: '2026-10-19T08:00:00.100Z' });
  await setTransport(db, 'valve_actuation_expectations', 'expectation_id', 'e-other', { phase: 'ACCEPTED', queue_id: 'q-other', attempted_at: '2026-10-19T08:01:00.100Z' });
  await db.run("INSERT INTO valve_schedule_pushes(push_id, device_eui, purpose, weekday, fport, payload_hex, plan_hash, state, transport_json) VALUES ('p-mon', ?, 'WEEKDAY_PLAN', 1, 15, '00', 'h-mon', 'QUEUED', ?)",
    [EUI, JSON.stringify({ phase: 'ACCEPTED', queue_id: 'q-plan', attempted_at: '2026-10-19T07:59:00.000Z' })]);
  await db.run("UPDATE devices SET target_state='OPEN' WHERE deveui=?", [EUI]);
}

test('transport cancel: a target still listed unsent before the flush is handed_off (fail closed), and the flushed collateral is returned as a structured list', async () => {
  const { db } = await tempDb();
  await seedTransportCancel(db);
  const transport = flushTransport([
    { id: 'q-plan', fPort: 15, data: 'AA==', isPending: false },
    { id: 'q-open', fPort: 2, data: 'QQ8=', isPending: false },
    { id: 'q-other', fPort: 2, data: 'QQ8=', isPending: false },
    { id: 'q-cfg', fPort: 11, data: 'AA8AAg==', isPending: false },
  ]);
  const out = await cancelActuation({ db, deviceEui: EUI, expectationId: 'e-target', reason: 'field_visit', transport, now: new Date('2026-10-19T08:02:00.000Z') });

  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.error, 'actuation_handed_off');
  assert.equal(out.outcome, 'handed_off');
  assert.equal(out.pending, true);
  assert.deepEqual(out.downlinks, []);
  assert.equal(transport.calls.flush, 1);
  const rows = Object.fromEntries((await db.all('SELECT expectation_id, reconciliation_state FROM valve_actuation_expectations')).map((r) => [r.expectation_id, r.reconciliation_state]));
  assert.equal(rows['e-target'], 'PENDING_OBSERVATION', 'a possibly delivered open stays observed');
  assert.equal(rows['e-other'], 'PENDING_OBSERVATION', 'another actuation flushed as collateral is not marked cancelled');

  const byOwner = Object.fromEntries(out.collateral.map((c) => [c.owner_type + ':' + c.owner_id, c]));
  assert.equal(byOwner['expectation:e-target'], undefined, 'the target is not its own collateral');
  assert.deepEqual({ ...byOwner['expectation:e-other'] }, { owner_type: 'expectation', owner_id: 'e-other', expectation_id: 'e-other', queue_id: 'q-other', phase_before: 'ACCEPTED', in_queue: true });
  assert.deepEqual({ ...byOwner['push:p-mon'] }, { owner_type: 'push', owner_id: 'p-mon', purpose: 'WEEKDAY_PLAN', weekday: 1, queue_id: 'q-plan', phase_before: 'ACCEPTED', in_queue: true });
  assert.deepEqual({ ...byOwner['opaque:q-cfg'] }, { owner_type: 'opaque', owner_id: 'q-cfg', fport: 11, queue_id: 'q-cfg', phase_before: 'ACCEPTED', in_queue: true });
  assert.deepEqual({ ...out.droppedOpens }, { count: 1, expectationIds: ['e-other'] });
  const device = await db.get('SELECT target_state FROM devices WHERE deveui=?', [EUI]);
  assert.equal(device.target_state, 'OPEN', 'another actuation is still active, so the target state stays');
  db.close();
});

test('transport cancel: a lone flushed open is handed_off and leaves target_state alone (fail closed)', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e-target', state: 'PENDING_OBSERVATION', commandedAt: '2026-10-19T08:00:00.000Z' });
  await setTransport(db, 'valve_actuation_expectations', 'expectation_id', 'e-target', { phase: 'ACCEPTED', queue_id: 'q-open', attempted_at: '2026-10-19T08:00:00.100Z' });
  await db.run("UPDATE devices SET target_state='OPEN' WHERE deveui=?", [EUI]);
  const out = await cancelActuation({ db, deviceEui: EUI, transport: flushTransport([{ id: 'q-open', fPort: 2, data: 'QQ8=', isPending: false }]), now: new Date('2026-10-19T08:02:00.000Z') });
  assert.equal(out.ok, false);
  assert.equal(out.outcome, 'handed_off');
  assert.deepEqual(out.collateral, []);
  assert.equal((await db.get('SELECT target_state FROM devices WHERE deveui=?', [EUI])).target_state, 'OPEN');
  db.close();
});

test('transport cancel: a target whose open was no longer in the queue is handed_off, not CANCELLED, and target_state is untouched', async () => {
  for (const snapshot of [[], [{ id: 'q-open', fPort: 2, data: 'QQ8=', isPending: true }]]) {
    const { db } = await tempDb();
    await seedTransportCancel(db);
    const out = await cancelActuation({ db, deviceEui: EUI, expectationId: 'e-target', reason: null, transport: flushTransport(snapshot), now: new Date('2026-10-19T08:02:00.000Z') });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'actuation_handed_off');
    assert.equal(out.permanent, true, 'a retry would only flush again');
    assert.equal(out.outcome, 'handed_off');
    assert.ok(Array.isArray(out.collateral));
    const row = await db.get("SELECT reconciliation_state, cancel_reason FROM valve_actuation_expectations WHERE expectation_id='e-target'");
    assert.equal(row.reconciliation_state, 'PENDING_OBSERVATION', 'the reconciler keeps observing a possibly-sent open');
    assert.equal(row.cancel_reason, null);
    assert.equal((await db.get('SELECT target_state FROM devices WHERE deveui=?', [EUI])).target_state, 'OPEN');
    db.close();
  }
});

test('transport cancel: a failed flush is transport_uncertain, marks nothing CANCELLED, and still reports collateral', async () => {
  const { db } = await tempDb();
  await seedTransportCancel(db);
  const transport = flushTransport([{ id: 'q-open', fPort: 2, data: 'QQ8=', isPending: false }], { failFlush: true });
  const out = await cancelActuation({ db, deviceEui: EUI, expectationId: 'e-target', reason: null, transport, now: new Date('2026-10-19T08:02:00.000Z') });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'transport_uncertain');
  assert.equal(out.outcome, 'uncertain');
  assert.ok(out.collateral.some((c) => c.owner_id === 'p-mon'));
  assert.equal((await db.get("SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id='e-target'")).reconciliation_state, 'PENDING_OBSERVATION');
  assert.equal((await db.get('SELECT target_state FROM devices WHERE deveui=?', [EUI])).target_state, 'OPEN');
  db.close();
});

test('transport cancel: a running actuation has no pending command, so nothing is flushed and nothing is marked', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e-run', state: 'OBSERVED_RUNNING', commandedAt: '2026-10-19T08:00:00.000Z' });
  await db.run("UPDATE devices SET target_state='OPEN' WHERE deveui=?", [EUI]);
  const transport = flushTransport([]);
  const out = await cancelActuation({ db, deviceEui: EUI, transport, now: new Date('2026-10-19T08:02:00.000Z') });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'actuation_handed_off');
  assert.equal(out.outcome, 'already_running');
  assert.deepEqual(out.collateral, []);
  assert.equal(transport.calls.read + transport.calls.flush, 0, 'no flush, so no collateral');
  assert.equal((await db.get("SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id='e-run'")).reconciliation_state, 'OBSERVED_RUNNING');
  assert.equal((await db.get('SELECT target_state FROM devices WHERE deveui=?', [EUI])).target_state, 'OPEN');
  db.close();
});

test('cancelHttpResponse maps each cancel outcome to an honest status and passes the collateral through', () => {
  const collateral = [{ owner_type: 'push', owner_id: 'p-mon', purpose: 'WEEKDAY_PLAN', weekday: 1, queue_id: 'q-plan', phase_before: 'ACCEPTED', in_queue: true }];
  const ok = cancelHttpResponse({ ok: true, outcome: 'cancelled', expectationId: 'e1', previousState: 'PENDING_OBSERVATION', reason: 'r', queueScope: 'full_flush', droppedOpens: { count: 0, expectationIds: [] }, collateral, timestamp: 't' }, 'DEV');
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.payload.status, 'cancelled');
  assert.equal(ok.payload.outcome, 'cancelled');
  assert.deepEqual(ok.payload.collateral, collateral);
  const handed = cancelHttpResponse({ ok: false, error: 'actuation_handed_off', outcome: 'handed_off', collateral }, 'DEV');
  assert.equal(handed.statusCode, 409);
  assert.equal(handed.payload.outcome, 'handed_off');
  assert.equal(handed.payload.error, 'actuation_handed_off');
  assert.deepEqual(handed.payload.collateral, collateral);
  assert.match(handed.payload.message, /does not close a valve that is already open/);
  const uncertain = cancelHttpResponse({ ok: false, error: 'transport_uncertain', outcome: 'uncertain', collateral }, 'DEV');
  assert.equal(uncertain.statusCode, 503);
  assert.deepEqual(uncertain.payload.collateral, collateral);
  assert.equal(cancelHttpResponse({ ok: false, error: 'ambiguous_actuation' }, 'DEV').statusCode, 409);
  assert.equal(cancelHttpResponse({ ok: false, error: 'no_active_actuation' }, 'DEV').statusCode, 404);
  assert.equal(cancelHttpResponse({ ok: false, error: 'something_else' }, 'DEV').statusCode, 500);
});

// Design (C) (adjudicated night run): LOST is reserved for latest-compile rows the 24-hour sweep
// catches, so a plan the cancel flush removed keeps its row (QUEUED, transport UNKNOWN) and is
// listed as collateral; nothing re-sends it.
test('transport cancel: a queued plan the flush removed is reported as collateral and is not re-sent', async () => {
  const { db } = await tempDb();
  await seedTransportCancel(db);
  const transport = flushTransport([{ id: 'q-plan', fPort: 15, data: 'AA==', isPending: false }, { id: 'q-open', fPort: 2, data: 'QQ8=', isPending: false }]);
  const out = await cancelActuation({ db, deviceEui: EUI, expectationId: 'e-target', reason: null, transport, now: new Date('2026-10-19T08:02:00.000Z') });
  assert.equal(out.outcome, 'handed_off');
  assert.equal(out.queueScope, 'full_flush');
  const plan = await db.get("SELECT state, error, transport_json FROM valve_schedule_pushes WHERE push_id='p-mon'");
  // CMD-04 PR0 (R5 H1): the flushed plan row is LOST at once (surfaced, never re-sent).
  assert.equal(plan.state, 'FAILED');
  assert.equal(plan.error, 'not_resent_q02c');
  assert.equal(JSON.parse(plan.transport_json).phase, 'UNKNOWN');
  assert.ok(out.collateral.some((c) => c.owner_id === 'p-mon' && c.in_queue === true));
  db.close();
});

// --- R3-M4 (night run): a cancel flushes only when the target's open was handed to ChirpStack
// with a queue id and no earlier flush already settled it. Otherwise nothing is flushed.
async function soleTarget(db, transport) {
  await insertExpectation(db, { id: 'e-t', state: 'PENDING_OBSERVATION', commandedAt: '2026-10-19T08:00:00.000Z' });
  if (transport !== undefined) await setTransport(db, 'valve_actuation_expectations', 'expectation_id', 'e-t', transport);
  await db.run("UPDATE devices SET target_state='OPEN' WHERE deveui=?", [EUI]);
}

for (const [label, transport] of [
  ['a reservation that never reached the network (no phase)', { effect_snapshot: null }],
  ['a claim that was never attempted (INTENT)', { phase: 'INTENT', intent_at: '2026-10-19T08:00:00.000Z' }],
  ['an enqueue ChirpStack refused before accepting it', { phase: 'enqueue_rejected', attempted_at: '2026-10-19T08:00:00.100Z' }],
]) {
  test(`R3-M4: ${label} is cancelled locally, without a flush`, async () => {
    const { db } = await tempDb();
    await soleTarget(db, transport);
    const cs = flushTransport([{ id: 'q-other', fPort: 11, data: 'AA==', isPending: false }]);
    const out = await cancelActuation({ db, deviceEui: EUI, transport: cs, now: new Date('2026-10-19T08:02:00.000Z') });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.outcome, 'cancelled');
    assert.deepEqual(out.collateral, []);
    assert.equal(cs.calls.read + cs.calls.flush, 0);
    assert.equal((await db.get("SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id='e-t'")).reconciliation_state, 'CANCELLED');
    assert.equal((await db.get('SELECT target_state FROM devices WHERE deveui=?', [EUI])).target_state, 'CLOSED');
    db.close();
  });
}

test('R3-M4: an attempted open without a queue id is handed_off, without a flush', async () => {
  const { db } = await tempDb();
  await soleTarget(db, { phase: 'ATTEMPTED', attempted_at: '2026-10-19T08:00:00.100Z' });
  const cs = flushTransport([]);
  const out = await cancelActuation({ db, deviceEui: EUI, transport: cs, now: new Date('2026-10-19T08:02:00.000Z') });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'actuation_handed_off');
  assert.equal(cs.calls.flush, 0, 'an empty queue holds nothing to stop (M4b reads it, never flushes it)');
  assert.equal((await db.get("SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id='e-t'")).reconciliation_state, 'PENDING_OBSERVATION');
  db.close();
});

test('R3-M4: an open an earlier flush removed is handed_off without another flush, even with a snapshot unsent stamp (fail closed)', async () => {
  const { db } = await tempDb();
  await soleTarget(db, { phase: 'UNKNOWN', queue_id: 'q-open', attempted_at: '2026-10-19T08:00:00.100Z', invalidated_by_flush: 'f1', first_invalidated_by_flush: 'f1', unsent_in_snapshot: true });
  const cs = flushTransport([]);
  const out = await cancelActuation({ db, deviceEui: EUI, transport: cs, now: new Date('2026-10-19T08:02:00.000Z') });
  assert.equal(out.ok, false);
  assert.equal(out.outcome, 'handed_off');
  assert.equal(cs.calls.read + cs.calls.flush, 0);
  assert.equal((await db.get("SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id='e-t'")).reconciliation_state, 'PENDING_OBSERVATION');
  db.close();
});

test('R3 m1: the already_running refusal says the valve is open', () => {
  const r = cancelHttpResponse({ ok: false, error: 'actuation_handed_off', outcome: 'already_running', collateral: [] }, 'DEV');
  assert.equal(r.statusCode, 409);
  assert.match(r.payload.message, /already open/);
  assert.doesNotMatch(r.payload.message, /may already have been sent/);
});

test('R3-M4: a locally cancelled reservation is stamped terminal, so a replay of its command cannot resume it', async () => {
  const { db } = await tempDb();
  await soleTarget(db, { effect_snapshot: null });
  const out = await cancelActuation({ db, deviceEui: EUI, transport: flushTransport([]), now: new Date('2026-10-19T08:02:00.000Z') });
  assert.equal(out.outcome, 'cancelled');
  const t = JSON.parse((await db.get("SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id='e-t'")).transport_json);
  assert.equal(t.phase, 'enqueue_failed_before_acceptance');
  assert.equal(t.cancelled_before_send_at, '2026-10-19T08:02:00.000Z');
  db.close();
});

// --- R3 re-review (night run). M4b: an ATTEMPTED open whose enqueue answer was lost has no
// queue id, but its frame is persisted in the effect snapshot. The cancel reads the queue: a
// matching unsent item is flushed and the cancel is proven; another unsent water-moving item is
// flushed too (the operator asked for the open to stop) and answered handed_off; otherwise
// nothing is flushed.
const OPEN_15_MIN = { fPort: 2, bytes_hex: '410F' };
async function attemptedWithoutQueueId(db) {
  await soleTarget(db, { phase: 'ATTEMPTED', attempted_at: '2026-10-19T08:00:00.100Z', effect_snapshot: OPEN_15_MIN });
}

test('R3-M4b: the lost-answer open still listed unsent in the queue: flush, handed_off (fail closed), collateral reported', async () => {
  const { db } = await tempDb();
  await attemptedWithoutQueueId(db);
  const cs = flushTransport([{ id: 'q-lost', fPort: 2, data: Buffer.from('410F', 'hex').toString('base64'), isPending: false }, { id: 'q-cfg', fPort: 11, data: 'AA8AAg==', isPending: false }]);
  const out = await cancelActuation({ db, deviceEui: EUI, transport: cs, now: new Date('2026-10-19T08:02:00.000Z') });
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.outcome, 'handed_off');
  assert.equal(cs.calls.flush, 1);
  assert.ok(out.collateral.some((c) => c.owner_id === 'q-cfg'));
  assert.equal((await db.get("SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id='e-t'")).reconciliation_state, 'PENDING_OBSERVATION');
  db.close();
});

test('R3-M4b: another unsent open in the queue is flushed, answered handed_off with collateral', async () => {
  const { db } = await tempDb();
  await attemptedWithoutQueueId(db);
  const cs = flushTransport([{ id: 'q-x', fPort: 2, data: Buffer.from('4114', 'hex').toString('base64'), isPending: false }]);
  const out = await cancelActuation({ db, deviceEui: EUI, transport: cs, now: new Date('2026-10-19T08:02:00.000Z') });
  assert.equal(out.ok, false);
  assert.equal(out.outcome, 'handed_off');
  assert.equal(cs.calls.flush, 1);
  assert.ok(out.collateral.some((c) => c.owner_id === 'q-x'));
  assert.equal((await db.get("SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id='e-t'")).reconciliation_state, 'PENDING_OBSERVATION');
  db.close();
});

test('R3-M4b: no matching and no water-moving item: handed_off without a flush', async () => {
  const { db } = await tempDb();
  await attemptedWithoutQueueId(db);
  const cs = flushTransport([{ id: 'q-cfg', fPort: 11, data: 'AA8AAg==', isPending: false }, { id: 'q-sent', fPort: 2, data: Buffer.from('410F', 'hex').toString('base64'), isPending: true }]);
  const out = await cancelActuation({ db, deviceEui: EUI, transport: cs, now: new Date('2026-10-19T08:02:00.000Z') });
  assert.equal(out.outcome, 'handed_off');
  assert.equal(cs.calls.read, 1);
  assert.equal(cs.calls.flush, 0);
  db.close();
});

// R3-M5: a flush that did not complete leaves no record, so a cancel retried after the 503
// flushes again (and answers handed_off: fail closed).
test('R3-M5: a cancel retried after a failed flush flushes again', async () => {
  const { db } = await tempDb();
  await soleTarget(db, { phase: 'ACCEPTED', queue_id: 'q-open', attempted_at: '2026-10-19T08:00:00.100Z' });
  const queue = [{ id: 'q-open', fPort: 2, data: 'QQ8=', isPending: false }];
  const first = await cancelActuation({ db, deviceEui: EUI, transport: flushTransport(queue, { failFlush: true }), now: new Date('2026-10-19T08:02:00.000Z') });
  assert.equal(first.error, 'transport_uncertain');
  const t = JSON.parse((await db.get("SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id='e-t'")).transport_json);
  assert.equal(t.first_invalidated_by_flush, undefined, 'an incomplete flush leaves no proof');
  const retry = flushTransport(queue);
  const second = await cancelActuation({ db, deviceEui: EUI, transport: retry, now: new Date('2026-10-19T08:03:00.000Z') });
  assert.equal(retry.calls.flush, 1, 'the retry flushes again');
  assert.equal(second.outcome, 'handed_off', JSON.stringify(second));
  assert.equal((await db.get("SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id='e-t'")).reconciliation_state, 'PENDING_OBSERVATION');
  db.close();
});

// Re-review minor: a reservation the cancel stamped terminal is refused by the sender as a
// replay (no throw, nothing enqueued): the intended "cancelled before send" refusal.
test('R3 minor: a sender meeting a cancelled reservation gets a replay refusal and sends nothing', async () => {
  const dispatch = require('./dispatch');
  const { db } = await tempDb();
  await soleTarget(db, { effect_snapshot: null });
  await cancelActuation({ db, deviceEui: EUI, transport: flushTransport([]), now: new Date('2026-10-19T08:02:00.000Z') });
  let sent = 0;
  const result = await dispatch.enqueueValveCommand({ db, deviceEui: EUI, owner: { type: 'expectation', id: 'e-t' },
    item: { devEui: EUI, fPort: 2, data: 'QQ8=', confirmed: false }, transport: { enqueueDownlink: async () => { sent += 1; return { id: 'q' }; } } });
  assert.equal(result.replayed, true);
  assert.equal(sent, 0);
  db.close();
});

// Integration with the policy pause route (owner tip): a caller that must know whether the
// actuation may still run reads `pending`. It is true whenever the open was not proven deleted.
test('cancel results say whether the actuation may still run (pending)', async () => {
  const cases = [
    [{ phase: 'INTENT', intent_at: '2026-10-19T08:00:00.000Z' }, [], {}, 'cancelled', false],
    [{ phase: 'ACCEPTED', queue_id: 'q-open', attempted_at: '2026-10-19T08:00:00.100Z' }, [{ id: 'q-open', fPort: 2, data: 'QQ8=', isPending: false }], {}, 'handed_off', true],
    [{ phase: 'ACCEPTED', queue_id: 'q-open', attempted_at: '2026-10-19T08:00:00.100Z' }, [], {}, 'handed_off', true],
    [{ phase: 'ACCEPTED', queue_id: 'q-open', attempted_at: '2026-10-19T08:00:00.100Z' }, [], { failFlush: true }, 'uncertain', true],
    [undefined, [], {}, 'handed_off', true],
  ];
  for (const [transport, queue, opts, outcome, pending] of cases) {
    const { db } = await tempDb();
    await soleTarget(db, transport);
    const out = await cancelActuation({ db, deviceEui: EUI, transport: flushTransport(queue, opts), now: new Date('2026-10-19T08:02:00.000Z') });
    assert.equal(out.outcome, outcome);
    assert.equal(out.pending, pending, outcome);
    db.close();
  }
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e-run', state: 'OBSERVED_RUNNING', commandedAt: '2026-10-19T08:00:00.000Z' });
  const running = await cancelActuation({ db, deviceEui: EUI, transport: flushTransport([]), now: new Date('2026-10-19T08:02:00.000Z') });
  assert.equal(running.outcome, 'already_running');
  assert.equal(running.pending, true);
  db.close();
});

// W29 (W38 F6): a permanent CLOSE is reserved as its own owner (commanded_duration_seconds 0) so
// fresh CLOSED evidence can settle it. It is not an open: a cancel never targets it (D04: cancel
// deletes a pending open), never flushes it away, and it does not make an id-less cancel of the
// one real open ambiguous.
test('a pending CLOSE owner is not a cancellable actuation', async () => {
  const { db } = await tempDb();
  await db.run(
    "INSERT INTO valve_actuation_expectations(expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, created_at) " +
    "VALUES ('close-owner', ?, 'close:1', '2026-10-19T08:00:00.000Z', 0, '2026-10-19T08:00:00.000Z', 'unknown', 'PENDING_OBSERVATION', '2026-10-19T08:00:00.000Z')", [EUI]);
  const onlyClose = flushTransport([]);
  const refused = await cancelActuation({ db, deviceEui: EUI, transport: onlyClose, now: new Date('2026-10-19T08:01:00.000Z') });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'no_active_actuation');
  assert.equal(onlyClose.calls.flush, 0, 'the pending close is never flushed by a cancel');
  const named = await cancelActuation({ db, deviceEui: EUI, expectationId: 'close-owner', transport: onlyClose, now: new Date('2026-10-19T08:01:00.000Z') });
  assert.equal(named.error, 'actuation_not_active');

  await insertExpectation(db, { id: 'open-1', state: 'PENDING_OBSERVATION', commandedAt: '2026-10-19T08:00:30.000Z' });
  await db.run('UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?', [JSON.stringify({ phase: 'ACCEPTED', queue_id: 'q-open', attempted_at: '2026-10-19T08:00:30.100Z' }), 'open-1']);
  const out = await cancelActuation({ db, deviceEui: EUI, transport: flushTransport([{ id: 'q-open', fPort: 2, data: 'QQo=', isPending: false }]), now: new Date('2026-10-19T08:01:00.000Z') });
  assert.equal(out.outcome, 'handed_off', JSON.stringify(out));
  assert.equal(out.expectationId, 'open-1', 'the one real open is the target, not ambiguous');
  db.close();
});

// Owner decision 2026-10-22 (S6 follow-up): the lifecycle unclaim cancels queued opens through the
// D19(a) cancel path, never sends a CLOSE, lets a running open run out its bounded duration, and
// reports the real outcome.
const { cancelForUnclaim } = require('./cancel');

test('unclaim cancel: every queued open is stopped through one whole-queue flush, answered handed_off (fail closed), nothing is enqueued', async () => {
  const { db } = await tempDb();
  await seedTransportCancel(db);
  const transport = flushTransport([
    { id: 'q-plan', fPort: 15, data: 'AA==', isPending: false },
    { id: 'q-open', fPort: 2, data: 'QQ8=', isPending: false },
    { id: 'q-other', fPort: 2, data: 'QQ8=', isPending: false },
  ]);
  const out = await cancelForUnclaim({ db, deviceEui: EUI, transport, now: new Date('2026-10-19T08:02:00.000Z') });
  assert.equal(out.state, 'handed_off', JSON.stringify(out));
  assert.equal(out.error, null);
  assert.equal(out.whole_queue_flushed, true);
  assert.equal(transport.calls.flush, 1, 'one D19(a) flush covers every queued open');
  assert.deepEqual(out.results.map((r) => [r.expectation_id, r.outcome]), [['e-target', 'handed_off'], ['e-other', 'handed_off']]);
  const rows = await db.all("SELECT reconciliation_state, cancel_reason FROM valve_actuation_expectations ORDER BY expectation_id");
  assert.deepEqual(rows.map((r) => r.reconciliation_state), ['PENDING_OBSERVATION', 'PENDING_OBSERVATION'], 'possibly delivered opens stay observed');
  assert.ok(Array.isArray(out.collateral));
  db.close();
});

test('unclaim cancel: a running open is left to run out its bounded duration: no flush, no CLOSE, outcome already_running', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e-run', state: 'OBSERVED_RUNNING', commandedAt: '2026-10-19T08:00:00.000Z' });
  await db.run("UPDATE devices SET target_state='OPEN' WHERE deveui=?", [EUI]);
  const transport = flushTransport([]);
  const out = await cancelForUnclaim({ db, deviceEui: EUI, transport, now: new Date('2026-10-19T08:02:00.000Z') });
  assert.equal(out.state, 'already_running');
  assert.equal(out.whole_queue_flushed, false);
  assert.deepEqual(out.results, [{ expectation_id: 'e-run', outcome: 'already_running', error: null, expected_close_at: '2026-10-19T08:00:00.000Z' }]);
  assert.equal(transport.calls.read + transport.calls.flush, 0);
  assert.equal((await db.get("SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id='e-run'")).reconciliation_state, 'OBSERVED_RUNNING');
  db.close();
});

test('unclaim cancel: a queued open beside a running one is flushed and handed_off; the running one is reported first', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e-run', state: 'OBSERVED_RUNNING', commandedAt: '2026-10-19T07:50:00.000Z' });
  await insertExpectation(db, { id: 'e-queued', state: 'PENDING_OBSERVATION', commandedAt: '2026-10-19T08:00:00.000Z' });
  await setTransport(db, 'valve_actuation_expectations', 'expectation_id', 'e-queued', { phase: 'ACCEPTED', queue_id: 'q-open', attempted_at: '2026-10-19T08:00:00.100Z' });
  const transport = flushTransport([{ id: 'q-open', fPort: 2, data: 'QQ8=', isPending: false }]);
  const out = await cancelForUnclaim({ db, deviceEui: EUI, transport, now: new Date('2026-10-19T08:02:00.000Z') });
  assert.equal(out.state, 'handed_off');
  assert.deepEqual(out.results.map((r) => [r.expectation_id, r.outcome]), [['e-run', 'already_running'], ['e-queued', 'handed_off']]);
  assert.equal(transport.calls.flush, 1);
  const rows = Object.fromEntries((await db.all('SELECT expectation_id, reconciliation_state FROM valve_actuation_expectations')).map((r) => [r.expectation_id, r.reconciliation_state]));
  assert.deepEqual(rows, { 'e-run': 'OBSERVED_RUNNING', 'e-queued': 'PENDING_OBSERVATION' });
  db.close();
});

test('unclaim cancel: nothing active is none_active; no transport is not_attempted; a failed flush is uncertain', async () => {
  const { db } = await tempDb();
  const none = await cancelForUnclaim({ db, deviceEui: EUI, transport: flushTransport([]), now: new Date('2026-10-19T08:02:00.000Z') });
  assert.equal(none.state, 'none_active');
  await insertExpectation(db, { id: 'e-target', state: 'PENDING_OBSERVATION', commandedAt: '2026-10-19T08:00:00.000Z' });
  await setTransport(db, 'valve_actuation_expectations', 'expectation_id', 'e-target', { phase: 'ACCEPTED', queue_id: 'q-open', attempted_at: '2026-10-19T08:00:00.100Z' });
  const noTransport = await cancelForUnclaim({ db, deviceEui: EUI, transport: null, now: new Date('2026-10-19T08:02:00.000Z') });
  assert.equal(noTransport.state, 'not_attempted');
  assert.equal(noTransport.error, 'transport_unavailable');
  const failed = await cancelForUnclaim({ db, deviceEui: EUI, transport: flushTransport([{ id: 'q-open', fPort: 2, data: 'QQ8=', isPending: false }], { failFlush: true }), now: new Date('2026-10-19T08:02:00.000Z') });
  assert.equal(failed.state, 'uncertain');
  assert.match(failed.error, /e-target: transport_uncertain/);
  assert.equal((await db.get("SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id='e-target'")).reconciliation_state, 'PENDING_OBSERVATION');
  db.close();
});

// R13 re-review R1, narrowed by the owner decision of 2026-10-24 (fail closed): a cancel that
// proves the open never reached ChirpStack settles it, so the next manual open is not refused
// valve_busy. A flushed open, even one the pre-flush read listed unsent, may have been delivered
// and keeps fencing until its bounded duration has passed.
test('only an open that never reached ChirpStack stops fencing after a cancel; a flushed one still fences', async () => {
  const dispatch = require('./dispatch');
  const { tempDb: freshDb, FIXTURE_EUI, fakeChirpStack } = require('./test-helpers');
  const T0 = Date.parse('2026-08-19T10:00:00Z');
  const at = (s) => new Date(T0 + s * 1000);
  const outcomes = {};
  for (const scenario of ['never_sent', 'listed_unsent', 'drained']) {
    const { db, cleanup } = await freshDb();
    try {
      const cs = fakeChirpStack();
      const first = await dispatch.reserveValveCommand({ db, command: { device_eui: FIXTURE_EUI, command_id: 'm1', action: 'OPEN_FOR_DURATION', duration_minutes: 5, commanded_at: at(0).toISOString(), timezone: 'UTC' }, now: at(0).toISOString() });
      if (scenario === 'never_sent') {
        // The reservation's claim was written but never attempted (crash before the RPC).
        await db.run('UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?', [JSON.stringify({ phase: 'INTENT', intent_at: at(0).toISOString() }), first.expectation.expectation_id]);
      } else {
        await dispatch.enqueueValveCommand({ db, deviceEui: FIXTURE_EUI, owner: { type: 'expectation', id: first.expectation.expectation_id }, item: { devEui: FIXTURE_EUI, fPort: 2, data: Buffer.from([0x41, 5]).toString('base64'), confirmed: false }, transport: cs.transport, now: at(0) });
      }
      if (scenario === 'drained') cs.drain();
      const cancel = await cancelActuation({ db, deviceEui: FIXTURE_EUI, expectationId: first.expectation.expectation_id, reason: 'operator', transport: cs.transport, now: at(10), warn: () => {} });
      outcomes[scenario] = { cancel: cancel.outcome };
      const tryReserve = async (s) => {
        try {
          const next = await dispatch.reserveValveCommand({ db, command: { device_eui: FIXTURE_EUI, command_id: 'm2-' + s, action: 'OPEN_FOR_DURATION', duration_minutes: 5, commanded_at: at(s).toISOString(), timezone: 'UTC' }, now: at(s).toISOString() });
          return next && next.expectation ? 'reserved' : 'none';
        } catch (error) {
          return 'refused ' + error.code;
        }
      };
      outcomes[scenario].soon = await tryReserve(20);
    } finally {
      cleanup();
    }
  }
  assert.deepEqual(outcomes.never_sent, { cancel: 'cancelled', soon: 'reserved' }, 'a proven cancel frees the valve');
  // Release after the bounded duration is the effect horizon (effects.canReleaseByHorizon, trusted
  // clock only), covered in effects.test.js; here the valve is still inside that duration.
  assert.deepEqual(outcomes.listed_unsent, { cancel: 'handed_off', soon: 'refused valve_busy' }, 'a flushed open keeps fencing the valve');
  assert.deepEqual(outcomes.drained, { cancel: 'handed_off', soon: 'refused valve_busy' });
});

// Release review (Codex P1 on PR #515), owner decision 2026-10-24 = fail closed: the pre-flush
// queue read is a separate RPC from the flush, and ChirpStack may hand the open to the radio
// between the two. A snapshot that still lists the open unsent therefore proves nothing: the
// cancel answers handed_off, nothing is marked CANCELLED, and the valve stays fenced until the
// open's bounded duration has passed. D04: no CLOSE is ever sent.
test('fail closed: an open delivered between the queue read and the flush is handed_off and keeps fencing the valve', async () => {
  const dispatch = require('./dispatch');
  const { tempDb: freshDb, FIXTURE_EUI, fakeChirpStack } = require('./test-helpers');
  const T0 = Date.parse('2026-08-19T10:00:00Z');
  const at = (s) => new Date(T0 + s * 1000);
  const { db, cleanup } = await freshDb();
  try {
    const cs = fakeChirpStack();
    const first = await dispatch.reserveValveCommand({ db, command: { device_eui: FIXTURE_EUI, command_id: 'm1', action: 'OPEN_FOR_DURATION', duration_minutes: 5, commanded_at: at(0).toISOString(), timezone: 'UTC' }, now: at(0).toISOString() });
    await dispatch.enqueueValveCommand({ db, deviceEui: FIXTURE_EUI, owner: { type: 'expectation', id: first.expectation.expectation_id }, item: { devEui: FIXTURE_EUI, fPort: 2, data: Buffer.from([0x41, 5]).toString('base64'), confirmed: false }, transport: cs.transport, now: at(0) });
    // The probe: the read still sees the open unsent, then an uplink delivers it before the flush.
    const transport = {
      ...cs.transport,
      async getDeviceQueue(eui) { const snapshot = await cs.transport.getDeviceQueue(eui); cs.drain(); return snapshot; },
      async enqueueDownlink() { throw new Error('a cancel must never enqueue anything (D04: no CLOSE)'); },
    };
    const cancel = await cancelActuation({ db, deviceEui: FIXTURE_EUI, expectationId: first.expectation.expectation_id, reason: 'operator', transport, now: at(10), warn: () => {} });
    assert.equal(cancel.outcome, 'handed_off', JSON.stringify(cancel));
    assert.equal(cancel.ok, false);
    assert.equal(cancel.pending, true);
    assert.deepEqual(cancel.downlinks, []);
    const row = await db.get('SELECT reconciliation_state, transport_json FROM valve_actuation_expectations WHERE expectation_id=?', [first.expectation.expectation_id]);
    assert.equal(row.reconciliation_state, 'PENDING_OBSERVATION', 'the possibly delivered open is still observed');
    const stamped = JSON.parse(row.transport_json);
    // unsent_in_snapshot may be stamped for ACK correlation (store.provenUndelivered); it is never
    // a cancel proof, so no cancelled_unsent_at and no CANCELLED state follow from it.
    assert.equal(stamped.cancelled_unsent_at, undefined, 'no unsent stamp from the snapshot');
    await assert.rejects(
      dispatch.reserveValveCommand({ db, command: { device_eui: FIXTURE_EUI, command_id: 'm2', action: 'OPEN_FOR_DURATION', duration_minutes: 5, commanded_at: at(20).toISOString(), timezone: 'UTC' }, now: at(20).toISOString() }),
      (error) => error.code === 'valve_busy',
      'the valve stays fenced while the open may be running');
    // A second cancel finds the earlier flush and still cannot prove the open unsent.
    const again = await cancelActuation({ db, deviceEui: FIXTURE_EUI, expectationId: first.expectation.expectation_id, reason: 'operator', transport, now: at(30), warn: () => {} });
    assert.equal(again.outcome, 'handed_off');
  } finally {
    cleanup();
  }
});
