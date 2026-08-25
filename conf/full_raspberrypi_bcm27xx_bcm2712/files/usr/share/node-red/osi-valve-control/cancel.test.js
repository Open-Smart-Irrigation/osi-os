'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDb } = require('./test-helpers');
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
