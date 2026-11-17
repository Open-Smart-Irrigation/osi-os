'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDb, FIXTURE_EUI } = require('./test-helpers');
const dispatch = require('./dispatch');

const AT = '2026-10-18T10:00:00.000Z';
const FRAME = { fPort: 2, data: Buffer.from([0x41, 2]).toString('base64'), confirmed: false, encrypted: false,
  provenance: { source: 'local_encoder', encoder: 'strega-v1' } };
const busy = () => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });

// Inject after the transaction body so the real fixture must roll back every
// partial write, including reservation/snapshot and INTENT/ATTEMPTED changes.
async function harness(t, { transaction = 4, failures = 2, error = busy(), busyMs = 0, enqueueMs = 0 } = {}) {
  const fixture = await tempDb();
  t.after(fixture.cleanup);
  let elapsed = 0;
  let committed = 0;
  let injections = 0;
  let enqueueCalls = 0;
  const sleeps = [];
  const warnings = [];
  const phases = [];
  const db = { ...fixture.db, async transaction(callback) {
    const inject = committed + 1 === transaction;
    const result = await fixture.db.transaction(async (tx) => {
      const value = await callback({ ...tx, run(sql, params) {
        if (sql.startsWith('UPDATE valve_actuation_expectations SET transport_json=')) phases.push(JSON.parse(params[0]).phase);
        return tx.run(sql, params);
      } });
      if (inject) {
        injections += 1;
        if (injections <= failures) { elapsed += busyMs; throw error; }
      }
      return value;
    });
    committed += 1;
    return result;
  } };
  const args = {
    db, deviceEui: FIXTURE_EUI,
    command: { device_eui: FIXTURE_EUI, command_id: 'busy-command', action: 'OPEN_FOR_DURATION', duration_minutes: 2, timezone: 'UTC' },
    frame: FRAME, now: AT, trustedContext: { runtimeNow: () => Date.parse(AT) },
    retryClock: () => elapsed,
    sleep: async (ms) => { sleeps.push(ms); elapsed += ms; },
    warn: (message) => warnings.push(message),
    transport: { async enqueueDownlink() { enqueueCalls += 1; elapsed += enqueueMs; return { id: 'busy-queue' }; } },
  };
  return { fixture, args, sleeps, warnings, phases, error,
    get elapsed() { return elapsed; }, get injections() { return injections; }, get enqueueCalls() { return enqueueCalls; },
    async state() {
      const row = await fixture.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE command_id=?', ['busy-command']);
      return row ? JSON.parse(row.transport_json) : null;
    },
  };
}

for (const [stage, transaction] of [['reservation', 1], ['before claim', 2], ['claim', 3]]) {
  test(`${stage} retries a whole rolled-back busy transaction, then enqueues once`, async (t) => {
    const h = await harness(t, { transaction, failures: 1 });
    const result = await dispatch.executeValveAttempt(h.args);
    assert.equal(result.accepted, true);
    assert.equal(result.phase, 'ACCEPTED');
    assert.equal(result.queue_id, 'busy-queue');
    assert.equal(h.enqueueCalls, 1);
    assert.equal(h.injections, 2);
    assert.equal(h.sleeps.length, 1);
    assert.equal(h.warnings.length, 0);
    assert.equal((await h.fixture.db.get('SELECT count(*) AS n FROM valve_actuation_expectations')).n, 1);
  });

  test(`${stage} persistent busy refuses with the original error and no enqueue`, async (t) => {
    const h = await harness(t, { transaction, failures: Infinity });
    await assert.rejects(dispatch.executeValveAttempt(h.args), (error) => error === h.error);
    assert.equal(h.enqueueCalls, 0);
    assert.equal(h.injections, 3);
    assert.equal(h.sleeps.length, 2);
    assert.ok(h.elapsed < 9000);
    const state = await h.state();
    assert.ok(state === null || !state.phase, 'failed transactions must leave no transport claim');
  });
}

test('post-enqueue busy retries ACCEPTED bookkeeping without another enqueue', async (t) => {
  const h = await harness(t);
  const result = await dispatch.executeValveAttempt(h.args);
  assert.equal(result.accepted, true);
  assert.equal(result.phase, 'ACCEPTED');
  assert.equal(result.queue_id, 'busy-queue');
  assert.equal(h.enqueueCalls, 1);
  assert.equal(h.injections, 3);
  assert.equal(h.sleeps.length, 2);
  assert.equal(h.warnings.length, 0);
  assert.equal((await h.state()).phase, 'ACCEPTED');
  assert.ok(!h.phases.includes('UNKNOWN'));
});

test('post-enqueue persistent busy warns, stays claimed for recovery, and still answers ACCEPTED', async (t) => {
  const h = await harness(t, { failures: Infinity });
  const result = await dispatch.executeValveAttempt(h.args);
  assert.equal(result.accepted, true);
  assert.equal(result.phase, 'ACCEPTED');
  assert.equal(result.queue_id, 'busy-queue');
  assert.equal(h.enqueueCalls, 1);
  assert.equal(h.injections, 3);
  assert.equal(h.sleeps.length, 2);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /bookkeeping.*database is locked/i);
  assert.equal((await h.state()).phase, 'ATTEMPTED');
  assert.ok(!h.phases.includes('UNKNOWN'));
  const recovered = await dispatch.recoverValveCommand({ db: h.fixture.db, deviceEui: FIXTURE_EUI, owner: result.owner, now: AT });
  assert.equal(recovered.phase, 'UNKNOWN');
  const replay = await dispatch.executeValveAttempt({ ...h.args, db: h.fixture.db });
  assert.equal(replay.replayed, true);
  assert.equal(h.enqueueCalls, 1);
});

test('busy message without a SQLite code is retried', async (t) => {
  const h = await harness(t, { transaction: 1, failures: 1, error: new Error('SQLITE_BUSY: database is locked') });
  assert.equal((await dispatch.executeValveAttempt(h.args)).accepted, true);
  assert.equal(h.sleeps.length, 1);
});

test('a full 5 s busy wait leaves no room for another reservation attempt', async (t) => {
  const h = await harness(t, { transaction: 1, failures: Infinity, busyMs: 5000 });
  await assert.rejects(dispatch.executeValveAttempt(h.args), (error) => error === h.error);
  assert.equal(h.injections, 1);
  assert.equal(h.enqueueCalls, 0);
  assert.deepEqual(h.sleeps, []);
  assert.equal(h.elapsed, 5000);
});

test('the dispatch deadline starts before waiting for the valve writer', async (t) => {
  const h = await harness(t, { transaction: 1, failures: Infinity });
  let release;
  let entered;
  const held = new Promise((resolve) => { entered = resolve; });
  const writer = dispatch.withValveWriter(FIXTURE_EUI, async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
  });
  await held;
  let clock = 0;
  h.args.retryClock = () => clock;
  const pending = dispatch.executeValveAttempt(h.args);
  clock = 5000;
  release();
  await writer;
  await assert.rejects(pending, (error) => error === h.error);
  assert.equal(h.injections, 1);
  assert.equal(h.enqueueCalls, 0);
  assert.deepEqual(h.sleeps, []);
});

test('one shared deadline includes reservation, claim, and enqueue time', async (t) => {
  const h = await harness(t, { transaction: 1, failures: 1, busyMs: 3000, enqueueMs: 1000 });
  const result = await dispatch.executeValveAttempt(h.args);
  assert.equal(result.accepted, true);
  assert.equal(h.enqueueCalls, 1);
  assert.equal(h.sleeps.length, 1);
  assert.ok(h.elapsed < 9000);
  assert.deepEqual(h.warnings, [], 'the first bookkeeping attempt always runs');
  assert.equal((await h.state()).phase, 'ACCEPTED');
  assert.equal((await h.state()).queue_id, 'busy-queue');
});

test('a slow enqueue with no busy error still records ACCEPTED and the queue id', async (t) => {
  // A command that waited behind other helper work reaches the bookkeeping
  // late; with no lock contention its first attempt must still be written.
  const h = await harness(t, { failures: 0, enqueueMs: 8500 });
  const result = await dispatch.executeValveAttempt(h.args);
  assert.deepEqual({ accepted: result.accepted, phase: result.phase, queue_id: result.queue_id },
    { accepted: true, phase: 'ACCEPTED', queue_id: 'busy-queue' });
  assert.equal(h.enqueueCalls, 1);
  assert.deepEqual(h.warnings, []);
  assert.deepEqual(h.sleeps, []);
  const state = await h.state();
  assert.equal(state.phase, 'ACCEPTED');
  assert.equal(state.queue_id, 'busy-queue');
});

test('past the deadline a busy bookkeeping attempt runs once, is not retried, and names the command', async (t) => {
  const h = await harness(t, { failures: Infinity, enqueueMs: 8500 });
  const result = await dispatch.executeValveAttempt(h.args);
  assert.equal(result.accepted, true);
  assert.equal(result.queue_id, 'busy-queue');
  assert.equal(h.enqueueCalls, 1);
  assert.equal(h.injections, 1, 'one first attempt, no retry past the deadline');
  assert.deepEqual(h.sleeps, []);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], new RegExp('device ' + FIXTURE_EUI + ' owner expectation:'));
  assert.match(h.warnings[0], /queue busy-queue/);
  assert.equal((await h.state()).phase, 'ATTEMPTED');
});

test('enqueueValveCommand keeps its async contract for invalid arguments', async () => {
  const pending = dispatch.enqueueValveCommand(null);
  assert.ok(pending instanceof Promise);
  await assert.rejects(pending, TypeError);
});

test('post-enqueue busy waits consume the deadline and stop further retries', async (t) => {
  const h = await harness(t, { failures: Infinity, busyMs: 5000 });
  const result = await dispatch.executeValveAttempt(h.args);
  assert.equal(result.accepted, true);
  assert.equal(result.queue_id, 'busy-queue');
  assert.equal(h.injections, 1);
  assert.equal(h.elapsed, 5000);
  assert.equal(h.enqueueCalls, 1);
  assert.equal(h.warnings.length, 1);
  assert.deepEqual(h.sleeps, []);
  assert.ok(!h.phases.includes('UNKNOWN'));
});

for (const [failures, expectedState] of [[2, 'SENT'], [Infinity, 'ATTEMPTED']]) {
  test(`conditional SENT bookkeeping busy (${failures} failures) preserves acceptance and recovery`, async (t) => {
    // A direct enqueue has beforeClaim, claim, persist, occurrence read, SENT.
    const h = await harness(t, { transaction: 5, failures });
    const occurrence = { schedule_uuid: 'busy-schedule', local_date: '2026-10-18', local_time: '10:00' };
    await h.fixture.db.run('INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, requested_duration_minutes, reservation_start_at, reservation_end_at, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [
      occurrence.schedule_uuid, occurrence.local_date, occurrence.local_time, FIXTURE_EUI, AT, 'PENDING', '2026-10-18T10:10:00.000Z', 2, AT, '2026-10-18T10:12:00.000Z', 2,
    ]);
    const reserved = await dispatch.reserveValveCommand({ db: h.fixture.db, command: {
      ...h.args.command, conditional: true, occurrence, expires_at: '2026-10-18T10:10:00.000Z',
    }, now: AT });
    const owner = { type: 'expectation', id: reserved.expectation.expectation_id };
    const result = await dispatch.enqueueValveCommand({ ...h.args, owner, item: FRAME });
    assert.deepEqual(result, { accepted: true, phase: 'ACCEPTED', queue_id: 'busy-queue' });
    assert.equal(h.enqueueCalls, 1);
    assert.equal(h.injections, 3);
    assert.equal(h.sleeps.length, 2);
    assert.equal((await h.state()).phase, 'ACCEPTED');
    assert.equal((await h.fixture.db.get('SELECT state FROM irrigation_occurrences WHERE command_id=?', ['busy-command'])).state, expectedState);
    assert.ok(!h.phases.includes('UNKNOWN'));
    assert.equal(h.warnings.length, failures === Infinity ? 1 : 0);
    if (failures === Infinity) {
      const recovery = await dispatch.recoverValveCommand({ db: h.fixture.db, deviceEui: FIXTURE_EUI, owner, now: AT });
      assert.equal(recovery.phase, 'ACCEPTED');
      const sent = await h.fixture.db.get('SELECT state, queue_id FROM irrigation_occurrences WHERE command_id=?', ['busy-command']);
      assert.equal(sent.state, 'SENT');
      assert.equal(sent.queue_id, 'busy-queue');
    }
  });
}

test('the deadline is rechecked after an oversleep before another transaction starts', async (t) => {
  const h = await harness(t, { transaction: 1, failures: Infinity, busyMs: 1000 });
  const clock = h.args.retryClock;
  let oversleep = 0;
  h.args.retryClock = () => clock() + oversleep;
  h.args.sleep = async () => { oversleep = 4000; };
  await assert.rejects(dispatch.executeValveAttempt(h.args), (error) => error === h.error);
  assert.equal(h.injections, 1);
  assert.equal(h.enqueueCalls, 0);
});

test('a non-busy reservation error is refused unchanged without retry', async (t) => {
  const h = await harness(t, { transaction: 1, error: Object.assign(new Error('disk failure'), { code: 'SQLITE_IOERR' }) });
  await assert.rejects(dispatch.executeValveAttempt(h.args), (error) => error === h.error);
  assert.equal(h.injections, 1);
  assert.equal(h.enqueueCalls, 0);
  assert.deepEqual(h.sleeps, []);
});

test('a non-busy bookkeeping error warns without retry and answers ACCEPTED', async (t) => {
  const h = await harness(t, { error: Object.assign(new Error('disk failure'), { code: 'SQLITE_IOERR' }) });
  assert.equal((await dispatch.executeValveAttempt(h.args)).accepted, true);
  assert.equal(h.injections, 1);
  assert.equal(h.enqueueCalls, 1);
  assert.deepEqual(h.sleeps, []);
  assert.equal(h.warnings.length, 1);
  assert.ok(!h.phases.includes('UNKNOWN'));
});

test('a throwing warning callback cannot turn an accepted enqueue into failure', async (t) => {
  const h = await harness(t, { failures: Infinity });
  const fallback = t.mock.method(console, 'warn', () => {});
  h.args.warn = () => { throw new Error('warning sink unavailable'); };
  assert.equal((await dispatch.executeValveAttempt(h.args)).accepted, true);
  assert.equal(h.enqueueCalls, 1);
  assert.equal(fallback.mock.callCount(), 1);
});

test('a real enqueue error retains the existing UNKNOWN result without retry', async (t) => {
  const h = await harness(t, { failures: 0 });
  const error = new Error('transport unavailable');
  let calls = 0;
  h.args.transport.enqueueDownlink = async () => { calls += 1; throw error; };
  const result = await dispatch.executeValveAttempt(h.args);
  assert.equal(result.accepted, false);
  assert.equal(result.phase, 'UNKNOWN');
  assert.equal(result.queue_id, null);
  assert.equal(result.error, error);
  assert.equal(calls, 1);
  assert.deepEqual(h.sleeps, []);
  assert.equal((await h.state()).phase, 'UNKNOWN');
});
