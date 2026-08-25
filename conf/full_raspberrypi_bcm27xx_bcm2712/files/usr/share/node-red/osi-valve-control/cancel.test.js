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

test('cancelActuation cancels the newest active expectation, sets cancel_reason, and flushes the queue exactly once', async () => {
  const { db } = await tempDb();
  await insertExpectation(db, { id: 'e-old', state: 'PENDING_OBSERVATION', commandedAt: '2026-08-25T10:00:00.000Z' });
  await insertExpectation(db, { id: 'e-new', state: 'OBSERVED_RUNNING', commandedAt: '2026-08-25T10:05:00.000Z' });
  const flushQueue = countingFlush();

  const out = await cancelActuation({ db, deviceEui: EUI, reason: 'field_visit', flushQueue, now: new Date('2026-08-25T10:06:00.000Z') });

  assert.equal(out.ok, true);
  assert.deepEqual(out.downlinks, []);
  assert.equal(flushQueue.calls.length, 1, 'flushQueue must be called exactly once');
  assert.equal(flushQueue.calls[0], EUI);

  const rows = await db.all('SELECT expectation_id, reconciliation_state, cancel_reason FROM valve_actuation_expectations ORDER BY expectation_id');
  const byId = Object.fromEntries(rows.map((r) => [r.expectation_id, r]));
  assert.equal(byId['e-new'].reconciliation_state, 'CANCELLED', 'the newest active row must be cancelled');
  assert.equal(byId['e-new'].cancel_reason, 'field_visit');
  assert.equal(byId['e-old'].reconciliation_state, 'PENDING_OBSERVATION', 'an older row must not be touched');
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

// Bovey cloud full-parity Task P4-E1: CANCELLED is a terminal reconciliation_state -- cancelActuation
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
