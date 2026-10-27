'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { facade } = require('./test-helpers');
const dispatch = require('./dispatch');

const SEED = path.resolve(__dirname, '../../db/farming.db');

async function dbFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'));
  const filename = path.join(dir, 'farming.db');
  fs.copyFileSync(SEED, filename);
  const raw = new DatabaseSync(filename);
  const db = facade(raw);
  await db.run("INSERT INTO users(id, username, password_hash, created_at) VALUES (1,'dispatch-test','x',datetime('now'))");
  await db.run("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES ('0016C001F1000001','Valve A','STREGA_VALVE',1,datetime('now'),datetime('now'))");
  return { db, raw, filename, cleanup: () => { try { raw.close(); } catch (_) {} fs.rmSync(dir, { recursive: true, force: true }); } };
}

function command(overrides = {}) {
  return {
    device_eui: '0016C001F1000001',
    command_id: 'cmd-1',
    action: 'OPEN_FOR_DURATION',
    duration_minutes: 5,
    commanded_at: '2026-10-17T10:00:00.000Z',
    timezone: 'UTC',
    ...overrides,
  };
}

test('reserveValveCommand returns one stable expectation and replays the command id', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  const first = await dispatch.reserveValveCommand({ db: fixture.db, command: command(), now: '2026-10-17T10:00:00.000Z' });
  const replay = await dispatch.reserveValveCommand({ db: fixture.db, command: command(), now: '2026-10-17T10:00:01.000Z' });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.send, false);
  assert.equal(first.expectation.expectation_id, replay.expectation.expectation_id);
  assert.equal((await fixture.db.all('SELECT count(*) AS n FROM valve_actuation_expectations')).at(0).n, 1);
});

test('reservation comparisons treat SQLite timestamps as UTC outside a UTC process', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  const priorTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => {
    if (priorTz == null) delete process.env.TZ;
    else process.env.TZ = priorTz;
  });
  const result = await dispatch.reserveValveCommand({
    db: fixture.db,
    command: command({ commanded_at: '2026-10-17 10:00:00' }),
    now: '2026-10-17 10:00:01',
  });
  assert.equal(result.expectation.expected_close_at, '2026-10-17T10:05:00.000Z');
  assert.equal(result.expectation.created_at, '2026-10-17T10:00:01.000Z');
});

test('conditional enqueue derives the immutable occurrence expiry and rejects caller disagreement', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, requested_duration_minutes, reservation_start_at, reservation_end_at, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    'expiry-schedule', '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'PENDING', '2026-10-17T10:10:00.000Z', 5, '2026-10-17T10:00:00.000Z', '2026-10-17T10:15:00.000Z', 5,
  ]);
  const reservation = await dispatch.reserveValveCommand({ db: fixture.db, command: command({ conditional: true, occurrence: { schedule_uuid: 'expiry-schedule', local_date: '2026-10-17', local_time: '10:00' } }), now: '2026-10-17T10:00:00.000Z' });
  const seen = [];
  const first = await dispatch.enqueueValveCommand({
    db: fixture.db, deviceEui: '0016C001F1000001', owner: { type: 'expectation', id: reservation.expectation.expectation_id },
    item: { fPort: 14, data: 'AQI=' }, transport: { enqueueDownlink: async (item) => { seen.push(item); return { id: 'q-expiry' }; } },
    now: '2026-10-17T10:00:01.000Z',
  });
  assert.equal(first.accepted, true);
  assert.equal(seen[0].expiresAt, '2026-10-17T10:10:00.000Z');
  const acceptedReplay = await dispatch.enqueueValveCommand({
    db: fixture.db, deviceEui: '0016C001F1000001', owner: { type: 'expectation', id: reservation.expectation.expectation_id },
    item: { fPort: 14, data: 'AQI=' }, transport: { enqueueDownlink: async () => { throw new Error('replay must not send'); } }, now: '2026-10-17T10:00:02.000Z',
  });
  assert.equal(acceptedReplay.replayed, true);
  assert.equal(acceptedReplay.accepted, true);
  assert.equal(acceptedReplay.phase, 'ACCEPTED');
  assert.equal(acceptedReplay.queue_id, 'q-expiry');

  const secondFixture = await dbFixture();
  t.after(secondFixture.cleanup);
  await secondFixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, requested_duration_minutes, reservation_start_at, reservation_end_at, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    'expiry-schedule', '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'PENDING', '2026-10-17T10:10:00.000Z', 5, '2026-10-17T10:00:00.000Z', '2026-10-17T10:15:00.000Z', 5,
  ]);
  const second = await dispatch.reserveValveCommand({ db: secondFixture.db, command: command({ conditional: true, occurrence: { schedule_uuid: 'expiry-schedule', local_date: '2026-10-17', local_time: '10:00' } }), now: '2026-10-17T10:00:00.000Z' });
  await assert.rejects(dispatch.enqueueValveCommand({
    db: secondFixture.db, deviceEui: '0016C001F1000001', owner: { type: 'expectation', id: second.expectation.expectation_id },
    item: { fPort: 14, data: 'AQI=', expiresAt: '2026-10-17T10:20:00.000Z' }, transport: { enqueueDownlink: async () => ({ id: 'should-not-send' }) },
    now: '2026-10-17T10:00:01.000Z',
  }), (error) => error.code === 'conditional_expiry_mismatch');
  const mismatchState = await secondFixture.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id=?', [second.expectation.expectation_id]);
  assert.equal(mismatchState.transport_json, null);

  const missingFixture = await dbFixture();
  t.after(missingFixture.cleanup);
  await missingFixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, requested_duration_minutes, reservation_start_at, reservation_end_at, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    'missing-expiry-schedule', '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'PENDING', '2026-10-17T10:10:00.000Z', 5, '2026-10-17T10:00:00.000Z', '2026-10-17T10:15:00.000Z', 5,
  ]);
  const missing = await dispatch.reserveValveCommand({ db: missingFixture.db, command: command({ conditional: true, occurrence: { schedule_uuid: 'missing-expiry-schedule', local_date: '2026-10-17', local_time: '10:00' } }), now: '2026-10-17T10:00:00.000Z' });
  await missingFixture.db.run('UPDATE irrigation_occurrences SET expires_at=NULL WHERE command_id=?', ['cmd-1']);
  await assert.rejects(dispatch.enqueueValveCommand({
    db: missingFixture.db, deviceEui: '0016C001F1000001', owner: { type: 'expectation', id: missing.expectation.expectation_id }, item: { fPort: 14, data: 'AQI=' }, transport: { enqueueDownlink: async () => ({ id: 'should-not-send' }) }, now: '2026-10-17T10:00:01.000Z',
  }), (error) => error.code === 'conditional_expiry_missing');
});

test('malformed supplied decision evidence is rejected without replacing persisted safety state', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, requested_duration_minutes, reservation_start_at, reservation_end_at, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    'malformed-evidence-schedule', '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'PENDING', '2026-10-17T10:10:00.000Z', 5, '2026-10-17T10:00:00.000Z', '2026-10-17T10:15:00.000Z', 5,
  ]);
  await assert.rejects(dispatch.reserveValveCommand({
    db: fixture.db,
    command: command({ conditional: true, occurrence: { schedule_uuid: 'malformed-evidence-schedule', local_date: '2026-10-17', local_time: '10:00' }, decision_evidence_json: '{bad-evidence' }),
    now: '2026-10-17T10:00:00.000Z',
  }), (error) => error.code === 'invalid_decision_evidence');
  const occurrence = await fixture.db.get('SELECT state, command_id, decision_evidence_json FROM irrigation_occurrences WHERE schedule_uuid=?', ['malformed-evidence-schedule']);
  assert.equal(occurrence.state, 'PENDING');
  assert.equal(occurrence.command_id, null);
  assert.equal(occurrence.decision_evidence_json, null);
});

test('ordinary ambiguous owner attempt is one-shot and replays without a second RPC', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  const reservation = await dispatch.reserveValveCommand({ db: fixture.db, command: command(), now: '2026-10-17T10:00:00.000Z' });
  let calls = 0;
  const transport = { enqueueDownlink: async () => { calls += 1; throw new Error('timeout'); } };
  const owner = { type: 'expectation', id: reservation.expectation.expectation_id };
  const first = await dispatch.enqueueValveCommand({ db: fixture.db, deviceEui: '0016C001F1000001', owner, item: { fPort: 14, data: 'AQI=' }, transport, now: '2026-10-17T10:00:01.000Z' });
  const second = await dispatch.enqueueValveCommand({ db: fixture.db, deviceEui: '0016C001F1000001', owner, item: { fPort: 14, data: 'AQI=' }, transport, now: '2026-10-17T10:00:02.000Z' });
  assert.equal(first.phase, 'UNKNOWN');
  assert.equal(second.replayed, true);
  assert.equal(calls, 1);
});

test('owner recovery turns an interrupted attempt unknown without invoking transport', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  const reservation = await dispatch.reserveValveCommand({ db: fixture.db, command: command(), now: '2026-10-17T10:00:00.000Z' });
  await fixture.db.run('UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?', [JSON.stringify({ phase: 'ATTEMPTED', attempted_at: '2026-10-17T10:00:01.000Z' }), reservation.expectation.expectation_id]);
  const result = await dispatch.recoverValveCommand({ db: fixture.db, deviceEui: '0016C001F1000001', owner: { type: 'expectation', id: reservation.expectation.expectation_id }, now: '2026-10-17T10:01:00.000Z' });
  assert.equal(result.recovered, true);
  const row = await fixture.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id=?', [reservation.expectation.expectation_id]);
  assert.equal(JSON.parse(row.transport_json).phase, 'UNKNOWN');
});

test('owner recovery reconciles durable accepted evidence into the linked occurrence', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, requested_duration_minutes) VALUES (?,?,?,?,?,?,?,?)", [
    'recovery-gap', '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'PENDING', '2026-10-17T10:10:00.000Z', 5,
  ]);
  const reservation = await dispatch.reserveValveCommand({ db: fixture.db, command: command({ conditional: true, occurrence: { schedule_uuid: 'recovery-gap', local_date: '2026-10-17', local_time: '10:00' } }), now: '2026-10-17T10:00:00.000Z' });
  await fixture.db.run('UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?', [JSON.stringify({ phase: 'ACCEPTED', queue_id: 'q-gap', accepted_at: '2026-10-17T10:00:02.000Z' }), reservation.expectation.expectation_id]);
  await fixture.db.run('UPDATE irrigation_occurrences SET state=?, attempted_at=? WHERE command_id=?', ['ATTEMPTED', '2026-10-17T10:00:01.000Z', 'cmd-1']);
  const result = await dispatch.recoverValveCommand({ db: fixture.db, deviceEui: '0016C001F1000001', owner: { type: 'expectation', id: reservation.expectation.expectation_id }, now: '2026-10-17T10:01:00.000Z' });
  assert.equal(result.recovered, true);
  assert.equal(result.phase, 'ACCEPTED');
  const occurrence = await fixture.db.get('SELECT state, queue_id, sent_at FROM irrigation_occurrences WHERE command_id=?', ['cmd-1']);
  assert.equal(occurrence.state, 'SENT');
  assert.equal(occurrence.queue_id, 'q-gap');
  assert.equal(occurrence.sent_at, '2026-10-17T10:00:02.000Z');
});

test('schedule-push and opaque owners also claim one attempt', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run("INSERT INTO valve_schedule_pushes(push_id, device_eui, purpose, fport, payload_hex) VALUES (?,?,?,?,?)", ['push-attempt', '0016C001F1000001', 'CLOCK_SYNC', 12, '0102']);
  await fixture.db.run('INSERT INTO valve_settings(device_eui, conditional_control_json) VALUES (?,?)', ['0016C001F1000001', JSON.stringify({ opaque: [{ queue_id: 'opaque-attempt', fPort: 21, payload: 'AQI=' }] })]);
  let calls = 0;
  const transport = { enqueueDownlink: async () => { calls += 1; throw new Error('timeout'); } };
  for (const owner of [{ type: 'push', id: 'push-attempt' }, { type: 'opaque', id: 'opaque-attempt', device_eui: '0016C001F1000001' }]) {
    const first = await dispatch.enqueueValveCommand({ db: fixture.db, deviceEui: '0016C001F1000001', owner, item: { fPort: 21, data: 'AQI=' }, transport, now: '2026-10-17T10:00:01.000Z' });
    const second = await dispatch.enqueueValveCommand({ db: fixture.db, deviceEui: '0016C001F1000001', owner, item: { fPort: 21, data: 'AQI=' }, transport, now: '2026-10-17T10:00:02.000Z' });
    assert.equal(first.phase, 'UNKNOWN');
    assert.equal(second.replayed, true);
  }
  assert.equal(calls, 2);
});

test('string-only rejection labels cannot authorize pre-acceptance expiry', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, requested_duration_minutes, reservation_start_at, reservation_end_at, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    'proof-schedule', '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'PENDING', '2026-10-17T10:10:00.000Z', 5, '2026-10-17T10:00:00.000Z', '2026-10-17T10:15:00.000Z', 5,
  ]);
  const reservation = await dispatch.reserveValveCommand({ db: fixture.db, command: command({ conditional: true, occurrence: { schedule_uuid: 'proof-schedule', local_date: '2026-10-17', local_time: '10:00' } }), now: '2026-10-17T10:00:00.000Z' });
  const result = await dispatch.enqueueValveCommand({
    db: fixture.db, deviceEui: '0016C001F1000001', owner: { type: 'expectation', id: reservation.expectation.expectation_id }, item: { fPort: 14, data: 'AQI=' },
    transport: { enqueueDownlink: async () => { const error = new Error('copied label'); error.code = 'enqueue_rejected'; error.classification = 'enqueue_rejected'; throw error; } },
    now: '2026-10-17T10:00:01.000Z',
  });
  assert.equal(result.phase, 'UNKNOWN');
  const occurrence = await fixture.db.get('SELECT state FROM irrigation_occurrences WHERE command_id=?', ['cmd-1']);
  assert.equal(occurrence.state, 'ATTEMPTED');
});

test('a different timed open while a reservation is active is rejected as valve_busy', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await dispatch.reserveValveCommand({ db: fixture.db, command: command(), now: '2026-10-17T10:00:00.000Z' });
  await assert.rejects(
    dispatch.reserveValveCommand({ db: fixture.db, command: command({ command_id: 'cmd-2' }), now: '2026-10-17T10:00:01.000Z' }),
    (error) => error.code === 'valve_busy'
  );
});

test('withValveWriter serializes a delayed enqueue and flush on one device', async () => {
  const events = [];
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const first = dispatch.withValveWriter('0016C001F1000001', async () => {
    events.push('enqueue-start');
    await delayed;
    events.push('enqueue-end');
  });
  const second = dispatch.withValveWriter('0016C001F1000001', async () => events.push('flush'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['enqueue-start']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['enqueue-start', 'enqueue-end', 'flush']);
});

test('nested withValveWriter calls reuse the current gate', async () => {
  const result = await dispatch.withValveWriter('0016C001F1000001', async () =>
    dispatch.withValveWriter('0016C001F1000001', async () => 'inside'));
  assert.equal(result, 'inside');
});

test('compound writer scope keeps every held valve reentrant and sorts acquisition', async () => {
  const events = [];
  const result = await dispatch.withValveWriters([
    '0016C001F1000002',
    '0016C001F1000001',
  ], async () => {
    events.push('held');
    await dispatch.withValveWriter('0016C001F1000002', async () => events.push('b'));
    await dispatch.withValveWriter('0016C001F1000001', async () => events.push('a'));
    return 'done';
  });
  assert.equal(result, 'done');
  assert.deepEqual(events, ['held', 'b', 'a']);
});

test('reversed compound editors serialize on one canonical valve order without deadlock', async () => {
  const events = [];
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const first = dispatch.withValveWriters(['0016C001F1000002', '0016C001F1000001'], async () => {
    events.push('first-enter');
    await delayed;
    events.push('first-leave');
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = dispatch.withValveWriters(['0016C001F1000001', '0016C001F1000002'], async () => events.push('second-enter'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first-enter']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-enter', 'first-leave', 'second-enter']);
});

test('compound writer scope rejects an unheld expansion immediately', async () => {
  await assert.rejects(
    dispatch.withValveWriters(['0016C001F1000001', '0016C001F1000002'], () =>
      dispatch.withValveWriter('0016C001F1000003', async () => 'never')),
    (error) => error && error.code === 'valve_writer_expansion'
  );
});

test('reserveValveCommand can compose with an existing transaction scope', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  const result = await fixture.db.transaction((tx) => dispatch.reserveValveCommand({ db: fixture.db, tx, command: command(), now: '2026-10-17T10:00:00.000Z' }));
  assert.equal(result.expectation.command_id, 'cmd-1');
});

test('conditional effective duration is the persisted commanded, close, and budget value', async (t) => {
  for (const { requested, effective } of [{ requested: 5, effective: 10 }, { requested: 10, effective: 3 }, { requested: 5, effective: 1 }, { requested: 5, effective: 240 }]) {
    const fixture = await dbFixture();
    try {
      await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, requested_duration_minutes, reservation_start_at, reservation_end_at, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
        `adaptive-${requested}-${effective}`, '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'PENDING', '2026-10-17T10:10:00.000Z', requested, '2026-10-17T10:00:00.000Z', '2026-10-17T10:10:00.000Z', requested,
      ]);
      const reservation = await dispatch.reserveValveCommand({
        db: fixture.db,
        command: command({
          command_id: `adaptive-${requested}-${effective}`,
          duration_minutes: requested,
          effective_duration_minutes: effective,
          occurrence: { schedule_uuid: `adaptive-${requested}-${effective}`, local_date: '2026-10-17', local_time: '10:00' },
        }),
        now: '2026-10-17T10:00:00.000Z',
      });
      assert.equal(reservation.expectation.commanded_duration_seconds, effective * 60);
      assert.equal(reservation.expectation.expected_close_at, new Date(Date.parse('2026-10-17T10:00:00.000Z') + effective * 60000).toISOString());
      assert.equal(reservation.occurrence.requested_duration_minutes, requested);
      assert.equal(reservation.occurrence.effective_duration_minutes, effective);
      assert.equal(reservation.occurrence.reserved_minutes, effective);
    } finally {
      fixture.cleanup();
    }
  }
});

test('conditional effective duration enforces 1 to 240 minutes and rejects a mismatched charge', async (t) => {
  for (const effective of [0, 241]) {
    const fixture = await dbFixture();
    try {
      await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, requested_duration_minutes) VALUES (?,?,?,?,?,?,?,?)", [
        `adaptive-bound-${effective}`, '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'PENDING', '2026-10-17T10:10:00.000Z', 5,
      ]);
      await assert.rejects(dispatch.reserveValveCommand({
        db: fixture.db,
        command: command({ command_id: `adaptive-bound-${effective}`, effective_duration_minutes: effective, occurrence: { schedule_uuid: `adaptive-bound-${effective}`, local_date: '2026-10-17', local_time: '10:00' } }),
        now: '2026-10-17T10:00:00.000Z',
      }), (error) => error.code === 'invalid_effective_duration');
    } finally {
      fixture.cleanup();
    }
  }
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, requested_duration_minutes) VALUES (?,?,?,?,?,?,?,?)", [
    'adaptive-mismatch', '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'PENDING', '2026-10-17T10:10:00.000Z', 5,
  ]);
  await assert.rejects(dispatch.reserveValveCommand({
    db: fixture.db,
    command: command({ command_id: 'adaptive-mismatch', effective_duration_minutes: 10, reserved_minutes: 5, occurrence: { schedule_uuid: 'adaptive-mismatch', local_date: '2026-10-17', local_time: '10:00' } }),
    now: '2026-10-17T10:00:00.000Z',
  }), (error) => error.code === 'invalid_reserved_minutes');
});

test('flush keeps every accepted conditional owner unknown for present, pending and absent snapshots', async (t) => {
  for (const queue of [
    [{ id: 'q-1', fPort: 14, data: 'AQI=', confirmed: false, isPending: false }],
    [{ id: 'q-1', fPort: 14, data: 'AQI=', confirmed: false, isPending: true }],
    [],
  ]) {
    const fixture = await dbFixture();
    try {
      const reservation = await dispatch.reserveValveCommand({ db: fixture.db, command: command({ conditional: true }), now: '2026-10-17T10:00:00.000Z' });
      await fixture.db.run('UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?', [JSON.stringify({ phase: 'ACCEPTED', queue_id: 'q-1', attempted_at: '2026-10-17T10:00:00.100Z' }), reservation.expectation.expectation_id]);
      const outcome = await dispatch.flushValveQueue({
        db: fixture.db,
        deviceEui: '0016C001F1000001',
        reason: 'cancel',
        transport: { getDeviceQueue: async () => queue, flushDeviceQueue: async () => ({ devEui: '0016C001F1000001' }) },
        now: '2026-10-17T10:01:00.000Z',
      });
      assert.equal(outcome.ok, true);
      const row = await fixture.db.get('SELECT reconciliation_state, transport_json FROM valve_actuation_expectations WHERE expectation_id=?', [reservation.expectation.expectation_id]);
      assert.equal(row.reconciliation_state, 'PENDING_OBSERVATION');
      assert.equal(JSON.parse(row.transport_json).phase, 'UNKNOWN');
    } finally {
      fixture.cleanup();
    }
  }
});

test('flush remains unknown when the transport copied the frame before a later send', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  const reservation = await dispatch.reserveValveCommand({ db: fixture.db, command: command({ conditional: true }), now: '2026-10-17T10:00:00.000Z' });
  await fixture.db.run('UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?', [JSON.stringify({ phase: 'ACCEPTED', queue_id: 'q-copied-before-flush' }), reservation.expectation.expectation_id]);
  let copied = false;
  let sentAfterFlush = false;
  const outcome = await dispatch.flushValveQueue({
    db: fixture.db,
    deviceEui: '0016C001F1000001',
    reason: 'copy-race',
    transport: {
      getDeviceQueue: async () => {
        copied = true;
        return [{ id: 'q-copied-before-flush', fPort: 14, data: 'AQI=', isPending: false }];
      },
      flushDeviceQueue: async () => {
        assert.equal(copied, true);
        setImmediate(() => { sentAfterFlush = true; });
      },
    },
    now: '2026-10-17T10:01:00.000Z',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outcome.phase, 'UNKNOWN');
  assert.equal(sentAfterFlush, true);
  const row = await fixture.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id=?', [reservation.expectation.expectation_id]);
  assert.equal(JSON.parse(row.transport_json).phase, 'UNKNOWN');
});

test('flush captures queue-only opaque originals before deleting the remote queue', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  const remote = { id: 'q-remote-opaque', fPort: 21, data: 'AgM=', confirmed: true, expiresAt: '2026-10-17T10:15:00.000Z', isPending: true };
  await dispatch.flushValveQueue({
    db: fixture.db, deviceEui: '0016C001F1000001', reason: 'capture-opaque',
    transport: { getDeviceQueue: async () => [remote], flushDeviceQueue: async () => ({}) }, now: '2026-10-17T10:01:00.000Z',
  });
  const settings = await fixture.db.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', ['0016C001F1000001']);
  const control = JSON.parse(settings.conditional_control_json);
  const opaque = control.opaque.find((entry) => entry.queue_id === remote.id);
  assert.equal(opaque.fPort, 21);
  assert.equal(opaque.payload, remote.data);
  assert.equal(opaque.confirmed, true);
  assert.equal(opaque.expiresAt, remote.expiresAt);
  assert.equal(opaque.phase, 'UNKNOWN');
  assert.equal(control.flushes.length, 1);
  assert.equal(control.flushes[0].status, 'COMPLETE');
  assert.equal(control.flushes[0].capture_status, 'COMPLETE');
  assert.deepEqual(control.flushes[0].captured_snapshot, [remote]);
});

test('flush durably captures an empty snapshot before recording the attempt result', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  const outcome = await dispatch.flushValveQueue({
    db: fixture.db, deviceEui: '0016C001F1000001', reason: 'empty-capture',
    transport: { getDeviceQueue: async () => [], flushDeviceQueue: async () => ({}) }, now: '2026-10-17T10:01:00.000Z',
  });
  assert.equal(outcome.ok, true);
  const settings = await fixture.db.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', ['0016C001F1000001']);
  const flush = JSON.parse(settings.conditional_control_json).flushes.at(-1);
  assert.equal(flush.capture_status, 'COMPLETE');
  assert.ok(flush.captured_at);
  assert.deepEqual(flush.captured_snapshot, []);
  assert.equal(flush.attempt_status, 'COMPLETE');
  assert.equal(flush.result_status, 'COMPLETE');
});

test('settled ACKED push history does not block or get rewritten by a later flush', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run("INSERT INTO valve_schedule_pushes(push_id, device_eui, purpose, fport, payload_hex, state, queued_at, acked_at, transport_json) VALUES (?,?,?,?,?,?,?,?,?)", [
    'push-settled', '0016C001F1000001', 'CLOCK_SYNC', 12, '0102', 'ACKED', '2026-10-17T09:00:00.000Z', '2026-10-17T09:01:00.000Z', JSON.stringify({ phase: 'ACCEPTED', queue_id: 'q-old' }),
  ]);
  const reservation = await dispatch.reserveValveCommand({ db: fixture.db, command: command({ command_id: 'after-settled-push' }), now: '2026-10-17T10:00:00.000Z' });
  assert.equal(reservation.replayed, false);
  await dispatch.flushValveQueue({ db: fixture.db, deviceEui: '0016C001F1000001', reason: 'settled-history', transport: { getDeviceQueue: async () => [], flushDeviceQueue: async () => ({}) }, now: '2026-10-17T10:01:00.000Z' });
  const push = await fixture.db.get('SELECT state, transport_json FROM valve_schedule_pushes WHERE push_id=?', ['push-settled']);
  assert.equal(push.state, 'ACKED');
  assert.equal(JSON.parse(push.transport_json).phase, 'ACCEPTED');
  assert.equal(JSON.parse(push.transport_json).queue_id, 'q-old');
});

// B-4 (W8 proposal, R11): plan, status and clock push owners are configuration. They stay
// tracked for flush capture, readiness and surfacing, but they never refuse a manual, ONCE or
// cloud open as valve_busy, whatever their state or transport phase (before this, every
// unsettled push fenced every open forever: two quick edits left the valve refusing manual
// opens permanently).
test('B-4: unsettled plan, status and clock pushes never refuse an open as valve_busy', async () => {
  for (const purpose of ['WEEKDAY_PLAN', 'DAYMASK_PLAN', 'SCHEDULER_STATUS', 'CLOCK_SYNC']) {
    for (const state of ['QUEUED', 'FAILED', 'SUPERSEDED']) {
      for (const phase of ['INTENT', 'ATTEMPTED', 'ACCEPTED', 'UNKNOWN']) {
        const fixture = await dbFixture();
        try {
          await fixture.db.run('INSERT INTO valve_schedule_pushes(push_id, device_eui, purpose, weekday, fport, payload_hex, state, queued_at, transport_json) VALUES (?,?,?,?,?,?,?,?,?)', [
            `push-${purpose}-${state}-${phase}`, '0016C001F1000001', purpose, purpose === 'WEEKDAY_PLAN' ? 1 : null, purpose === 'CLOCK_SYNC' ? 12 : 15, '0102', state, '2026-10-17T09:00:00.000Z',
            JSON.stringify({ phase, ...(phase === 'ACCEPTED' || phase === 'UNKNOWN' ? { queue_id: `q-${state}` } : {}), attempted_at: '2026-10-17T09:00:00.000Z' }),
          ]);
          const reservation = await dispatch.reserveValveCommand({ db: fixture.db, command: command({ command_id: `after-${purpose}-${state}-${phase}` }), now: '2026-10-17T12:00:00.000Z' });
          assert.equal(reservation.send, true, `${purpose}/${state}/${phase} must not fence a manual open`);
        } finally {
          fixture.cleanup();
        }
      }
    }
  }
});

test('B-4: an 8-day-old FAILED clock sync that was ACCEPTED does not block an open (W3 probe)', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run('INSERT INTO valve_schedule_pushes(push_id, device_eui, purpose, fport, payload_hex, state, error, queued_at, transport_json) VALUES (?,?,?,?,?,?,?,?,?)', [
    'old-clock', '0016C001F1000001', 'CLOCK_SYNC', 12, '0102', 'FAILED', 'no_ack_24h', '2026-10-09 09:00:00', JSON.stringify({ phase: 'ACCEPTED', queue_id: 'q-old-clock' }),
  ]);
  const reservation = await dispatch.reserveValveCommand({ db: fixture.db, command: command({ command_id: 'after-old-clock' }), now: '2026-10-17T12:00:00.000Z' });
  assert.equal(reservation.send, true);
});

test('B-4: water-moving opaque queue owners still fence an open; opaque configuration does not', async () => {
  const cases = [
    [{ fPort: 2, data: Buffer.from('410F', 'hex').toString('base64') }, true],
    [{ fPort: 27, data: Buffer.from('3105', 'hex').toString('base64') }, true],
    [{ fPort: 28, data: Buffer.from('01', 'hex').toString('base64') }, true],
    [{ fPort: 27, data: Buffer.from('3005', 'hex').toString('base64') }, false],
    [{ fPort: 15, data: Buffer.from('00'.repeat(24), 'hex').toString('base64') }, false],
    [{ fPort: 21, data: Buffer.from('32', 'hex').toString('base64') }, false],
  ];
  for (const [item, blocks] of cases) {
    const fixture = await dbFixture();
    try {
      const control = { opaque: [{ owner_id: 'q-opaque', queue_id: 'q-opaque', device_eui: '0016C001F1000001', phase: 'ACCEPTED', fPort: item.fPort, data: item.data, payload: item.data }] };
      await fixture.db.run('INSERT INTO valve_settings(device_eui, conditional_control_json) VALUES (?,?)', ['0016C001F1000001', JSON.stringify(control)]);
      const attempt = dispatch.reserveValveCommand({ db: fixture.db, command: command({ command_id: `after-opaque-${item.fPort}` }), now: '2026-10-17T12:00:00.000Z' });
      if (blocks) await assert.rejects(attempt, (error) => error.code === 'valve_busy', `fPort ${item.fPort} must fence`);
      else assert.equal((await attempt).send, true, `fPort ${item.fPort} must not fence`);
    } finally {
      fixture.cleanup();
    }
  }
});

test('B-4: a conditional open on a valve whose conditional clear is not READY is refused as conditional_not_ready', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, requested_duration_minutes, reservation_start_at, reservation_end_at, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    'unready-schedule', '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'PENDING', '2026-10-17T10:10:00.000Z', 5, '2026-10-17T10:00:00.000Z', '2026-10-17T10:15:00.000Z', 5,
  ]);
  await fixture.db.run('INSERT INTO valve_settings(device_eui, conditional_control_json) VALUES (?,?)', ['0016C001F1000001',
    JSON.stringify({ mode: 'CONDITIONAL', desired_revision: 'rev-1', required_push_ids: ['clear-1'], readiness: { state: 'PENDING', revision: 'rev-1', reason: 'awaiting_clear_ack' } })]);
  await assert.rejects(
    dispatch.reserveValveCommand({ db: fixture.db, command: command({ conditional: true, occurrence: { schedule_uuid: 'unready-schedule', local_date: '2026-10-17', local_time: '10:00' } }), now: '2026-10-17T10:00:00.000Z' }),
    (error) => error.code === 'conditional_not_ready',
  );
});

test('positive ACK settles an UNKNOWN push for conflict checking', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run('INSERT INTO valve_schedule_pushes(push_id, device_eui, purpose, fport, payload_hex, state, queued_at, acked_at, transport_json) VALUES (?,?,?,?,?,?,?,?,?)', [
    'push-acked-unknown', '0016C001F1000001', 'CLOCK_SYNC', 12, '0102', 'ACKED', '2026-10-17T09:00:00.000Z', '2026-10-17T09:01:00.000Z', JSON.stringify({ phase: 'UNKNOWN', error: 'response lost' }),
  ]);
  const result = await dispatch.reserveValveCommand({ db: fixture.db, command: command({ command_id: 'after-acked-unknown' }), now: '2026-10-17T12:00:00.000Z' });
  assert.equal(result.replayed, false);
});

test('positive ACK keeps an UNKNOWN push out of later flush ownership', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run('INSERT INTO valve_schedule_pushes(push_id, device_eui, purpose, fport, payload_hex, state, queued_at, acked_at, transport_json) VALUES (?,?,?,?,?,?,?,?,?)', [
    'push-acked-unknown-flush', '0016C001F1000001', 'CLOCK_SYNC', 12, '0102', 'ACKED', '2026-10-17T09:00:00.000Z', '2026-10-17T09:01:00.000Z', JSON.stringify({ phase: 'UNKNOWN', error: 'response lost' }),
  ]);
  await dispatch.flushValveQueue({ db: fixture.db, deviceEui: '0016C001F1000001', reason: 'positive-ack', transport: { getDeviceQueue: async () => [], flushDeviceQueue: async () => ({}) }, now: '2026-10-17T12:00:00.000Z' });
  const push = await fixture.db.get('SELECT transport_json FROM valve_schedule_pushes WHERE push_id=?', ['push-acked-unknown-flush']);
  assert.deepEqual(JSON.parse(push.transport_json), { phase: 'UNKNOWN', error: 'response lost' });
});

test('complete observations settle interrupted expectation transport for conflict checking', async (t) => {
  for (const phase of ['INTENT', 'ATTEMPTED']) {
    const fixture = await dbFixture();
    try {
      await fixture.db.run('INSERT INTO valve_actuation_expectations(expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds, expected_close_at, observed_open_at, observed_close_at, volume_source, reconciliation_state, created_at, transport_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [
        `observed-${phase}`, '0016C001F1000001', `observed-${phase}`, '2026-10-17T10:00:00.000Z', 300, '2026-10-17T10:05:00.000Z', '2026-10-17T10:01:00.000Z', '2026-10-17T10:03:00.000Z', 'unknown', 'OBSERVED_CLOSED', '2026-10-17T10:00:00.000Z', JSON.stringify({ phase }),
      ]);
      const result = await dispatch.reserveValveCommand({ db: fixture.db, command: command({ command_id: `after-observed-${phase}` }), now: '2026-10-17T12:00:00.000Z' });
      assert.equal(result.replayed, false);
    } finally {
      fixture.cleanup();
    }
  }
});

test('complete observations keep interrupted expectations out of later flush ownership', async (t) => {
  for (const phase of ['INTENT', 'ATTEMPTED']) {
    const fixture = await dbFixture();
    try {
      await fixture.db.run('INSERT INTO valve_actuation_expectations(expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds, expected_close_at, observed_open_at, observed_close_at, volume_source, reconciliation_state, created_at, transport_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [
        `observed-flush-${phase}`, '0016C001F1000001', `observed-flush-${phase}`, '2026-10-17T10:00:00.000Z', 300, '2026-10-17T10:05:00.000Z', '2026-10-17T10:01:00.000Z', '2026-10-17T10:03:00.000Z', 'unknown', 'OBSERVED_CLOSED', '2026-10-17T10:00:00.000Z', JSON.stringify({ phase }),
      ]);
      await dispatch.flushValveQueue({ db: fixture.db, deviceEui: '0016C001F1000001', reason: 'observed-settlement', transport: { getDeviceQueue: async () => [], flushDeviceQueue: async () => ({}) }, now: '2026-10-17T12:00:00.000Z' });
      const row = await fixture.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id=?', [`observed-flush-${phase}`]);
      assert.deepEqual(JSON.parse(row.transport_json), { phase });
    } finally {
      fixture.cleanup();
    }
  }
});

test('CANCELLED and STALE_NO_OBSERVATION labels do not settle UNKNOWN transport', async (t) => {
  for (const reconciliation_state of ['CANCELLED', 'STALE_NO_OBSERVATION']) {
    const fixture = await dbFixture();
    try {
      await fixture.db.run('INSERT INTO valve_actuation_expectations(expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, created_at, transport_json) VALUES (?,?,?,?,?,?,?,?,?,?)', [
        `uncertain-${reconciliation_state}`, '0016C001F1000001', `uncertain-${reconciliation_state}`, '2026-10-17T10:00:00.000Z', 300, '2026-10-17T10:05:00.000Z', 'unknown', reconciliation_state, '2026-10-17T10:00:00.000Z', JSON.stringify({ phase: 'UNKNOWN', queue_id: 'q-uncertain' }),
      ]);
      await assert.rejects(dispatch.reserveValveCommand({ db: fixture.db, command: command({ command_id: `after-${reconciliation_state}` }), now: '2026-10-17T12:00:00.000Z' }), (error) => error.code === 'valve_busy');
    } finally {
      fixture.cleanup();
    }
  }
});

test('orphan conditional occurrence stays blocked through its captured exclusion horizon', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, reservation_end_at, command_id, decision_evidence_json, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    'orphan-schedule', '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'SENT', '2026-10-17T10:10:00.000Z', '2026-10-17T10:15:00.000Z', 'orphan-command', JSON.stringify({ minimum_gap_minutes: 60, exclusion_end_at: '2026-10-17T11:15:00.000Z' }), 5,
  ]);
  await assert.rejects(dispatch.reserveValveCommand({ db: fixture.db, command: command({ command_id: 'orphan-follow-up' }), now: '2026-10-17T10:16:00.000Z' }), (error) => error.code === 'valve_busy');
});

test('malformed persisted safety JSON fails closed without overwriting the bytes', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  const rawControl = '{bad-control';
  await fixture.db.run('INSERT INTO valve_settings(device_eui, conditional_control_json) VALUES (?,?)', ['0016C001F1000001', rawControl]);
  await assert.rejects(dispatch.reserveValveCommand({ db: fixture.db, command: command({ command_id: 'malformed-control' }), now: '2026-10-17T10:00:00.000Z' }), (error) => error.code === 'conditional_control_malformed');
  const unchanged = await fixture.db.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', ['0016C001F1000001']);
  assert.equal(unchanged.conditional_control_json, rawControl);
});

test('conditional replay returns both the expectation and linked occurrence', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, requested_duration_minutes, reservation_start_at, reservation_end_at, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    'replay-schedule', '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'PENDING', '2026-10-17T10:10:00.000Z', 5, '2026-10-17T10:00:00.000Z', '2026-10-17T10:15:00.000Z', 5,
  ]);
  const first = await dispatch.reserveValveCommand({ db: fixture.db, command: command({ conditional: true, occurrence: { schedule_uuid: 'replay-schedule', local_date: '2026-10-17', local_time: '10:00' } }), now: '2026-10-17T10:00:00.000Z' });
  const replay = await dispatch.reserveValveCommand({ db: fixture.db, command: command({ conditional: true, occurrence: { schedule_uuid: 'replay-schedule', local_date: '2026-10-17', local_time: '10:00' } }), now: '2026-10-17T10:00:01.000Z' });
  assert.ok(first.occurrence);
  assert.ok(replay.occurrence);
  assert.equal(replay.occurrence.command_id, first.occurrence.command_id);
});

test('owner device identity is checked before transport intent is persisted', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  const reservation = await dispatch.reserveValveCommand({ db: fixture.db, command: command(), now: '2026-10-17T10:00:00.000Z' });
  await assert.rejects(dispatch.enqueueValveCommand({
    db: fixture.db, deviceEui: '0016C001F1000002', owner: { type: 'expectation', id: reservation.expectation.expectation_id }, item: { fPort: 14, data: 'AQI=' }, transport: { enqueueDownlink: async () => ({ id: 'wrong-device' }) }, now: '2026-10-17T10:00:01.000Z',
  }), (error) => error.code === 'transport_owner_device_mismatch');
  const row = await fixture.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id=?', [reservation.expectation.expectation_id]);
  assert.equal(row.transport_json, null);
});

test('enqueueValveCommand persists intent and accepted queue id before a concurrent flush can run', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  const reservation = await dispatch.reserveValveCommand({ db: fixture.db, command: command({ conditional: true }), now: '2026-10-17T10:00:00.000Z' });
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const order = [];
  const enqueue = dispatch.enqueueValveCommand({
    db: fixture.db,
    deviceEui: '0016C001F1000001',
    owner: { type: 'expectation', id: reservation.expectation.expectation_id },
    item: { fPort: 14, data: 'AQI=', confirmed: false, expiresAt: '2026-10-17T10:10:00.000Z' },
    conditional: true,
    transport: { enqueueDownlink: async () => { order.push('enqueue-start'); await waiting; order.push('enqueue-end'); return { id: 'q-accepted' }; } },
    now: '2026-10-17T10:00:01.000Z',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const flush = dispatch.flushValveQueue({
    db: fixture.db, deviceEui: '0016C001F1000001', reason: 'cancel',
    transport: { getDeviceQueue: async () => { order.push('get-queue'); return []; }, flushDeviceQueue: async () => { order.push('flush'); } },
    now: '2026-10-17T10:00:02.000Z',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['enqueue-start']);
  release();
  const [sent, flushed] = await Promise.all([enqueue, flush]);
  assert.equal(sent.accepted, true);
  assert.equal(flushed.ok, true);
  assert.deepEqual(order, ['enqueue-start', 'enqueue-end', 'get-queue', 'flush']);
  const row = await fixture.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id=?', [reservation.expectation.expectation_id]);
  const transport = JSON.parse(row.transport_json);
  assert.equal(transport.phase, 'UNKNOWN');
  assert.equal(transport.queue_id, 'q-accepted');
});

test('enqueueValveCommand records pre-acceptance and ambiguous failures without replaying', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  const reservation = await dispatch.reserveValveCommand({ db: fixture.db, command: command(), now: '2026-10-17T10:00:00.000Z' });
  const pre = await dispatch.enqueueValveCommand({
    db: fixture.db, deviceEui: '0016C001F1000001', owner: { type: 'expectation', id: reservation.expectation.expectation_id },
    item: { fPort: 14, data: 'AQI=' }, transport: { enqueueDownlink: async () => { const e = new Error('bad request'); e.code = 'enqueue_rejected'; e.classification = 'enqueue_rejected'; e.grpcCode = 3; e.step = 'enqueueDownlink'; e.provenance = 'chirpstack_enqueue_preacceptance'; throw e; } },
    now: '2026-10-17T10:00:01.000Z',
  });
  assert.equal(pre.phase, 'enqueue_rejected');
  const state = await fixture.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id=?', [reservation.expectation.expectation_id]);
  assert.equal(JSON.parse(state.transport_json).phase, 'enqueue_rejected');

  const second = await dispatch.reserveValveCommand({ db: fixture.db, command: command({ command_id: 'cmd-2' }), now: '2026-10-17T10:00:02.000Z' }).catch((error) => error);
  assert.equal(second.code, 'valve_busy', 'a failed ordinary command still blocks a conditional conversion until reconciled');
});

test('flush failure remains durable and does not claim queue absence as non-delivery', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  const reservation = await dispatch.reserveValveCommand({ db: fixture.db, command: command(), now: '2026-10-17T10:00:00.000Z' });
  await fixture.db.run('UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?', [JSON.stringify({ phase: 'ACCEPTED', queue_id: 'q-1' }), reservation.expectation.expectation_id]);
  const outcome = await dispatch.flushValveQueue({ db: fixture.db, deviceEui: '0016C001F1000001', reason: 'failed-flush', transport: { getDeviceQueue: async () => [{ id: 'q-1', isPending: false }], flushDeviceQueue: async () => { throw new Error('offline'); } }, now: '2026-10-17T10:01:00.000Z' });
  assert.equal(outcome.ok, false);
  const settings = await fixture.db.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', ['0016C001F1000001']);
  const latest = JSON.parse(settings.conditional_control_json).flushes.at(-1);
  assert.equal(latest.status, 'UNKNOWN');
  assert.equal(latest.capture_status, 'COMPLETE');
  assert.equal(latest.attempt_status, 'UNKNOWN');
  assert.equal(latest.result_status, 'UNKNOWN');
  assert.deepEqual(latest.owners.map((owner) => owner.queue_id), ['q-1']);
});

test('flush recovery never retries a mutation after its attempt marker is durable', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  let flushCalls = 0;
  const first = await dispatch.flushValveQueue({
    db: fixture.db, deviceEui: '0016C001F1000001', reason: 'ambiguous-flush',
    transport: {
      getDeviceQueue: async () => [{ id: 'q-ambiguous', fPort: 21, data: 'AgM=', isPending: true }],
      flushDeviceQueue: async () => { flushCalls += 1; throw new Error('flush response lost'); },
    }, now: '2026-10-17T10:01:00.000Z',
  });
  assert.equal(first.ok, false);
  const recovered = await dispatch.recoverValveFlush({
    db: fixture.db, deviceEui: '0016C001F1000001', flushId: first.flush_id,
    transport: {
      getDeviceQueue: async () => { throw new Error('capture must already be durable'); },
      flushDeviceQueue: async () => { flushCalls += 1; },
    }, now: '2026-10-17T10:02:00.000Z',
  });
  assert.equal(recovered.phase, 'UNKNOWN');
  assert.equal(flushCalls, 1);
  const settings = await fixture.db.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', ['0016C001F1000001']);
  const control = JSON.parse(settings.conditional_control_json);
  assert.equal(control.flushes.at(-1).attempt_status, 'UNKNOWN');
  assert.equal(control.opaque.find((entry) => entry.queue_id === 'q-ambiguous').phase, 'UNKNOWN');
});

test('flush recovery finishes a missing read-only capture before the one mutation attempt', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  let getCalls = 0;
  let flushCalls = 0;
  const first = await dispatch.flushValveQueue({
    db: fixture.db, deviceEui: '0016C001F1000001', reason: 'capture-crash',
    transport: {
      getDeviceQueue: async () => { getCalls += 1; throw new Error('read interrupted'); },
      flushDeviceQueue: async () => { flushCalls += 1; },
    }, now: '2026-10-17T10:01:00.000Z',
  });
  assert.equal(first.ok, false);
  const recovered = await dispatch.recoverValveFlush({
    db: fixture.db, deviceEui: '0016C001F1000001', flushId: first.flush_id,
    transport: {
      getDeviceQueue: async () => { getCalls += 1; return [{ id: 'q-captured-on-recovery', fPort: 21, data: 'AgM=', isPending: true }]; },
      flushDeviceQueue: async () => { flushCalls += 1; },
    }, now: '2026-10-17T10:02:00.000Z',
  });
  assert.equal(recovered.ok, true);
  assert.equal(getCalls, 2);
  assert.equal(flushCalls, 1);
  const settings = await fixture.db.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', ['0016C001F1000001']);
  const control = JSON.parse(settings.conditional_control_json);
  assert.equal(control.flushes.at(-1).capture_status, 'COMPLETE');
  assert.equal(control.opaque.find((entry) => entry.queue_id === 'q-captured-on-recovery').phase, 'UNKNOWN');
});

test('flush updates one durable intent and recovery consumes its captured set', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  const first = await dispatch.flushValveQueue({ db: fixture.db, deviceEui: '0016C001F1000001', reason: 'single-intent', transport: { getDeviceQueue: async () => [], flushDeviceQueue: async () => ({}) }, now: '2026-10-17T10:01:00.000Z' });
  const settings = await fixture.db.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', ['0016C001F1000001']);
  const flushes = JSON.parse(settings.conditional_control_json).flushes;
  assert.equal(flushes.filter((entry) => entry.flush_id === first.flush_id).length, 1);
  assert.equal(flushes[0].status, 'COMPLETE');

  let flushCalls = 0;
  const recovered = await dispatch.recoverValveFlush({
    db: fixture.db, deviceEui: '0016C001F1000001', flushId: first.flush_id,
    transport: { getDeviceQueue: async () => [], flushDeviceQueue: async () => { flushCalls += 1; } }, now: '2026-10-17T10:02:00.000Z',
  });
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.flush_id, first.flush_id);
  assert.equal(flushCalls, 0);
});

test('opaque flush owners retain payload, port and original expiry', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run('INSERT INTO valve_settings(device_eui, conditional_control_json) VALUES (?,?)', ['0016C001F1000001', JSON.stringify({ opaque: [{ queue_id: 'opaque-1', phase: 'ACCEPTED', fPort: 21, payload: 'AQI=', expiresAt: '2026-10-17T10:15:00.000Z' }] })]);
  await dispatch.flushValveQueue({ db: fixture.db, deviceEui: '0016C001F1000001', reason: 'opaque', transport: { getDeviceQueue: async () => [], flushDeviceQueue: async () => ({}) }, now: '2026-10-17T10:01:00.000Z' });
  const settings = await fixture.db.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', ['0016C001F1000001']);
  const opaque = JSON.parse(settings.conditional_control_json).opaque[0];
  assert.equal(opaque.fPort, 21);
  assert.equal(opaque.payload, 'AQI=');
  assert.equal(opaque.expiresAt, '2026-10-17T10:15:00.000Z');
  assert.equal(opaque.phase, 'UNKNOWN');
});

test('an accepted owner without a queue id remains an unresolved blocker', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  // B-4: only a water-moving opaque owner fences an open; this one is an FPort 2 open (it was an
  // FPort 21 status frame before, which no longer fences: see the B-4 opaque test).
  await fixture.db.run('INSERT INTO valve_settings(device_eui, conditional_control_json) VALUES (?,?)', ['0016C001F1000001', JSON.stringify({ opaque: [{ phase: 'ACCEPTED', fPort: 2, payload: 'QQ8=' }] })]);
  await assert.rejects(
    dispatch.reserveValveCommand({ db: fixture.db, command: command({ command_id: 'blocked-by-malformed-accepted' }), now: '2026-10-17T10:01:00.000Z' }),
    (error) => error.code === 'valve_busy'
  );
});

test('conditional occurrence advances RESERVED to ATTEMPTED once and accepted transport to SENT', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, requested_duration_minutes, reservation_start_at, reservation_end_at, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    'schedule-1', '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'PENDING', '2026-10-17T10:10:00.000Z', 5, '2026-10-17T10:00:00.000Z', '2026-10-17T10:15:00.000Z', 5,
  ]);
  const reservation = await dispatch.reserveValveCommand({ db: fixture.db, command: command({ conditional: true, occurrence: { schedule_uuid: 'schedule-1', local_date: '2026-10-17', local_time: '10:00' }, expires_at: '2026-10-17T10:10:00.000Z' }), now: '2026-10-17T10:00:00.000Z' });
  const result = await dispatch.enqueueValveCommand({ db: fixture.db, deviceEui: '0016C001F1000001', owner: { type: 'expectation', id: reservation.expectation.expectation_id }, item: { fPort: 14, data: 'AQI=', expiresAt: '2026-10-17T10:10:00.000Z' }, conditional: true, transport: { enqueueDownlink: async () => ({ id: 'queue-accepted' }) }, now: '2026-10-17T10:00:01.000Z' });
  assert.equal(result.accepted, true);
  const occurrence = await fixture.db.get('SELECT state, attempted_at, sent_at, queue_id FROM irrigation_occurrences WHERE command_id=?', ['cmd-1']);
  assert.equal(occurrence.state, 'SENT');
  assert.equal(occurrence.queue_id, 'queue-accepted');
  assert.ok(occurrence.attempted_at);
  assert.ok(occurrence.sent_at);
});

test('a successful flush moves an accepted SENT occurrence to UNKNOWN without clearing markers', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, requested_duration_minutes, reservation_start_at, reservation_end_at, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    'schedule-1', '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'PENDING', '2026-10-17T10:10:00.000Z', 5, '2026-10-17T10:00:00.000Z', '2026-10-17T10:15:00.000Z', 5,
  ]);
  const reservation = await dispatch.reserveValveCommand({ db: fixture.db, command: command({ conditional: true, occurrence: { schedule_uuid: 'schedule-1', local_date: '2026-10-17', local_time: '10:00' }, expires_at: '2026-10-17T10:10:00.000Z' }), now: '2026-10-17T10:00:00.000Z' });
  await dispatch.enqueueValveCommand({ db: fixture.db, deviceEui: '0016C001F1000001', owner: { type: 'expectation', id: reservation.expectation.expectation_id }, item: { fPort: 14, data: 'AQI=', expiresAt: '2026-10-17T10:10:00.000Z' }, conditional: true, transport: { enqueueDownlink: async () => ({ id: 'queue-accepted' }) }, now: '2026-10-17T10:00:01.000Z' });
  await dispatch.flushValveQueue({ db: fixture.db, deviceEui: '0016C001F1000001', reason: 'cancel', transport: { getDeviceQueue: async () => [], flushDeviceQueue: async () => ({}) }, now: '2026-10-17T10:00:02.000Z' });
  const occurrence = await fixture.db.get('SELECT state, queue_id, sent_at, reservation_end_at FROM irrigation_occurrences WHERE command_id=?', ['cmd-1']);
  assert.equal(occurrence.state, 'UNKNOWN');
  assert.equal(occurrence.queue_id, 'queue-accepted');
  assert.ok(occurrence.sent_at);
  assert.equal(occurrence.reservation_end_at, '2026-10-17T10:15:00.000Z');
});

test('a conditional SENT reservation blocks through captured exclusion horizon and then stops excluding without changing state', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, requested_duration_minutes, reservation_start_at, reservation_end_at, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    'schedule-1', '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'PENDING', '2026-10-17T10:10:00.000Z', 5, '2026-10-17T10:00:00.000Z', '2026-10-17T10:15:00.000Z', 5,
  ]);
  const first = await dispatch.reserveValveCommand({ db: fixture.db, command: command({ conditional: true, minimum_gap_minutes: 5, occurrence: { schedule_uuid: 'schedule-1', local_date: '2026-10-17', local_time: '10:00' }, expires_at: '2026-10-17T10:10:00.000Z', reservation_end_at: '2026-10-17T10:15:00.000Z' }), now: '2026-10-17T10:00:00.000Z' });
  await fixture.db.run('UPDATE irrigation_occurrences SET state=?, command_id=?, decision_evidence_json=? WHERE schedule_uuid=? AND local_date=? AND local_time=?', ['SENT', 'cmd-1', JSON.stringify({ minimum_gap_minutes: 5, exclusion_end_at: '2026-10-17T10:20:00.000Z' }), 'schedule-1', '2026-10-17', '10:00']);
  await assert.rejects(dispatch.reserveValveCommand({ db: fixture.db, command: command({ command_id: 'later-1' }), now: '2026-10-17T10:19:59.999Z' }), (error) => error.code === 'valve_busy');
  const after = await dispatch.reserveValveCommand({ db: fixture.db, command: command({ command_id: 'later-2' }), now: '2026-10-17T10:20:00.000Z' });
  assert.equal(after.replayed, false);
  const old = await fixture.db.get('SELECT state, command_id, decision_evidence_json FROM irrigation_occurrences WHERE schedule_uuid=? AND local_date=? AND local_time=?', ['schedule-1', '2026-10-17', '10:00']);
  assert.equal(old.state, 'SENT');
  assert.equal(old.command_id, 'cmd-1');
  assert.equal(JSON.parse(old.decision_evidence_json).minimum_gap_minutes, 5);
  assert.equal(first.expectation.command_id, 'cmd-1');
});

test('captured gap controls a prior reservation after later policy values change', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, reservation_end_at, command_id, decision_evidence_json, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    'captured-gap-schedule', '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'SENT', '2026-10-17T10:10:00.000Z', '2026-10-17T10:15:00.000Z', 'captured-gap-command', JSON.stringify({ minimum_gap_minutes: 5, exclusion_end_at: '2026-10-17T10:20:00.000Z', accounting: { timezone: 'UTC', local_days: ['2026-10-17'] } }), 5,
  ]);
  await fixture.db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, created_at) VALUES (?,?,?,?,?,?,?,?,?)", ['captured-gap-expectation', '0016C001F1000001', 'captured-gap-command', '2026-10-17T10:00:00.000Z', 300, '2026-10-17T10:05:00.000Z', 'unknown', 'PENDING_OBSERVATION', '2026-10-17T10:00:00.000Z']);
  const next = await dispatch.reserveValveCommand({ db: fixture.db, command: command({ command_id: 'after-policy-change', minimum_gap_minutes: 60 }), now: '2026-10-17T10:20:00.000Z' });
  assert.equal(next.replayed, false);
});

test('incomplete linked observations remain blockers after the conservative horizon', async (t) => {
  for (const observation of [
    { observed_open_at: '2026-10-17T10:01:00.000Z', observed_close_at: null, reconciliation_state: 'PENDING_OBSERVATION' },
    { observed_open_at: null, observed_close_at: '2026-10-17T10:03:00.000Z', reconciliation_state: 'PENDING_OBSERVATION' },
    { observed_open_at: '2026-10-17T10:01:00.000Z', observed_close_at: null, reconciliation_state: 'STALE_OPEN_OBSERVED' },
  ]) {
    const fixture = await dbFixture();
    try {
      await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, reservation_end_at, command_id, decision_evidence_json, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
        'incomplete-schedule', '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'UNKNOWN', '2026-10-17T10:10:00.000Z', '2026-10-17T10:15:00.000Z', 'incomplete-command', JSON.stringify({ minimum_gap_minutes: 5, exclusion_end_at: '2026-10-17T10:20:00.000Z', accounting: { timezone: 'UTC', local_days: ['2026-10-17'] } }), 5,
      ]);
      await fixture.db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds, expected_close_at, observed_open_at, observed_close_at, volume_source, reconciliation_state, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
        'incomplete-expectation', '0016C001F1000001', 'incomplete-command', '2026-10-17T10:00:00.000Z', 300, '2026-10-17T10:05:00.000Z', observation.observed_open_at, observation.observed_close_at, 'unknown', observation.reconciliation_state, '2026-10-17T10:00:00.000Z',
      ]);
      await assert.rejects(dispatch.reserveValveCommand({ db: fixture.db, command: command({ command_id: 'after-incomplete' }), now: '2026-10-17T10:20:00.000Z' }), (error) => error.code === 'valve_busy');
    } finally {
      fixture.cleanup();
    }
  }
});

test('complete linked observations refine exclusion and accounting once', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, reservation_end_at, command_id, decision_evidence_json, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    'complete-schedule', '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'UNKNOWN', '2026-10-17T10:10:00.000Z', '2026-10-17T10:15:00.000Z', 'complete-command', JSON.stringify({ minimum_gap_minutes: 5, exclusion_end_at: '2026-10-17T10:20:00.000Z', accounting: { timezone: 'UTC', local_days: ['2026-10-17'] } }), 5,
  ]);
  await fixture.db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds, expected_close_at, observed_open_at, observed_close_at, volume_source, reconciliation_state, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    'complete-expectation', '0016C001F1000001', 'complete-command', '2026-10-17T10:00:00.000Z', 300, '2026-10-17T10:05:00.000Z', '2026-10-17T10:01:00.000Z', '2026-10-17T10:03:00.000Z', 'unknown', 'OBSERVED_CLOSED', '2026-10-17T10:00:00.000Z',
  ]);
  const next = await dispatch.reserveValveCommand({ db: fixture.db, command: command({ command_id: 'after-complete' }), now: '2026-10-17T10:10:00.000Z' });
  assert.equal(next.replayed, false);
  const accounting = await dispatch.getDailyAccounting({ db: fixture.db, deviceEui: '0016C001F1000001', timezone: 'UTC' });
  assert.deepEqual(accounting.days, { '2026-10-17': 2 });
  assert.equal(accounting.runs.filter((run) => run.command_id === 'complete-command').length, 1);
});

test('partial, malformed, and reversed linked observations remain unknown-duration accounting blockers', async (t) => {
  for (const [label, open, close] of [
    ['open-only', '2026-10-17T10:01:00.000Z', null],
    ['close-only', null, '2026-10-17T10:03:00.000Z'],
    ['malformed', 'not-a-time', '2026-10-17T10:03:00.000Z'],
    ['reversed', '2026-10-17T10:04:00.000Z', '2026-10-17T10:03:00.000Z'],
  ]) {
    const fixture = await dbFixture();
    try {
      await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, reservation_end_at, command_id, decision_evidence_json, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
        `partial-${label}`, '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'UNKNOWN', '2026-10-17T10:10:00.000Z', '2026-10-17T10:15:00.000Z', `partial-${label}`, JSON.stringify({ minimum_gap_minutes: 5, exclusion_end_at: '2026-10-17T10:20:00.000Z', accounting: { timezone: 'UTC', local_days: ['2026-10-17'] } }), 5,
      ]);
      await fixture.db.run('INSERT INTO valve_actuation_expectations(expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds, expected_close_at, observed_open_at, observed_close_at, volume_source, reconciliation_state, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [
        `partial-${label}`, '0016C001F1000001', `partial-${label}`, '2026-10-17T10:00:00.000Z', 300, '2026-10-17T10:05:00.000Z', open, close, 'unknown', 'STALE_OPEN_OBSERVED', '2026-10-17T10:00:00.000Z',
      ]);
      const accounting = await dispatch.getDailyAccounting({ db: fixture.db, deviceEui: '0016C001F1000001', timezone: 'UTC' });
      assert.deepEqual(accounting.days, {});
      assert.deepEqual(accounting.unknown_duration_command_ids, [`partial-${label}`]);
      assert.equal(accounting.runs[0].source, 'unknown_duration');
    } finally {
      fixture.cleanup();
    }
  }
});

test('expired pre-acceptance occurrence suppresses its linked expectation accounting fallback', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, reservation_end_at, command_id, decision_reason, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    'expired-linked', '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'EXPIRED', '2026-10-17T10:10:00.000Z', '2026-10-17T10:15:00.000Z', 'expired-linked-command', 'command_expired', 5,
  ]);
  await fixture.db.run('INSERT INTO valve_actuation_expectations(expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, created_at, transport_json) VALUES (?,?,?,?,?,?,?,?,?,?)', [
    'expired-linked-expectation', '0016C001F1000001', 'expired-linked-command', '2026-10-17T10:00:00.000Z', 300, '2026-10-17T10:05:00.000Z', 'unknown', 'CANCELLED', '2026-10-17T10:00:00.000Z', JSON.stringify({ phase: 'enqueue_failed_before_acceptance' }),
  ]);
  const accounting = await dispatch.getDailyAccounting({ db: fixture.db, deviceEui: '0016C001F1000001', timezone: 'UTC' });
  assert.deepEqual(accounting.days, {});
  assert.deepEqual(accounting.runs, []);
  assert.deepEqual(accounting.unknown_duration_command_ids, []);
});

test('ordinary unresolved transport remains blocked well after expected close', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  const reservation = await dispatch.reserveValveCommand({ db: fixture.db, command: command(), now: '2026-10-17T10:00:00.000Z' });
  await fixture.db.run('UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?', [JSON.stringify({ phase: 'UNKNOWN' }), reservation.expectation.expectation_id]);
  await assert.rejects(dispatch.reserveValveCommand({ db: fixture.db, command: command({ command_id: 'after-ordinary-close' }), now: '2026-10-17T12:00:00.000Z' }), (error) => error.code === 'valve_busy');
});

test('missing or malformed conditional horizon remains a durable valve_busy blocker', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, reservation_end_at, command_id, decision_evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?)", [
    'schedule-1', '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'UNKNOWN', '2026-10-17T10:10:00.000Z', '2026-10-17T10:15:00.000Z', 'opaque-command', '{"minimum_gap_minutes":"5"}',
  ]);
  await fixture.db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, created_at) VALUES (?,?,?,?,?,?,?,?,?)", ['e-opaque', '0016C001F1000001', 'opaque-command', '2026-10-17T10:00:00.000Z', 300, '2026-10-17T10:05:00.000Z', 'unknown', 'PENDING_OBSERVATION', '2026-10-17T10:00:00.000Z']);
  await assert.rejects(dispatch.reserveValveCommand({ db: fixture.db, command: command({ command_id: 'later' }), now: '2026-10-17T12:00:00.000Z' }), (error) => error.code === 'valve_busy');
});

test('scoped daily accounting retains one conservative run past H and refines that same run once observed', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, requested_duration_minutes, reservation_start_at, reservation_end_at, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    'accounting-schedule', '2026-10-17', '10:00', '0016C001F1000001', '2026-10-17T10:00:00.000Z', 'PENDING', '2026-10-17T10:10:00.000Z', 5, '2026-10-17T10:00:00.000Z', '2026-10-17T10:15:00.000Z', 5,
  ]);
  const reservation = await dispatch.reserveValveCommand({
    db: fixture.db,
    command: command({ conditional: true, occurrence: { schedule_uuid: 'accounting-schedule', local_date: '2026-10-17', local_time: '10:00' }, minimum_gap_minutes: 5, decision_evidence_json: { accounting: { timezone: 'UTC', local_days: ['2026-10-17'] } } }),
    now: '2026-10-17T10:00:00.000Z',
  });
  await fixture.db.run('UPDATE irrigation_occurrences SET state=? WHERE command_id=?', ['UNKNOWN', 'cmd-1']);
  const conservative = await dispatch.getDailyAccounting({ db: fixture.db, deviceEui: '0016C001F1000001', timezone: 'UTC' });
  assert.deepEqual(conservative.days, { '2026-10-17': 5 });
  assert.equal(conservative.runs.length, 1);
  assert.equal(conservative.runs[0].source, 'conservative');
  const afterH = await dispatch.getDailyAccounting({ db: fixture.db, deviceEui: '0016C001F1000001', timezone: 'UTC', now: '2026-10-17T12:00:00.000Z' });
  assert.deepEqual(afterH.days, conservative.days);

  await fixture.db.run('UPDATE valve_actuation_expectations SET observed_open_at=?, observed_close_at=? WHERE expectation_id=?', ['2026-10-17T10:01:00.000Z', '2026-10-17T10:03:00.000Z', reservation.expectation.expectation_id]);
  const observed = await dispatch.getDailyAccounting({ db: fixture.db, deviceEui: '0016C001F1000001', timezone: 'UTC' });
  assert.deepEqual(observed.days, { '2026-10-17': 2 });
  assert.equal(observed.runs[0].source, 'observed');
  assert.equal(observed.runs.length, 1);
});

test('unknown-duration expectation is reported as blocked without a fabricated charge', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, created_at, transport_json) VALUES (?,?,?,?,?,?,?,?,?,?)", [
    'unknown-duration-expectation', '0016C001F1000001', 'unknown-duration-command', '2026-10-17T10:00:00.000Z', 300, '2026-10-17T10:05:00.000Z', 'unknown', 'STALE_OPEN_OBSERVED', '2026-10-17T10:00:00.000Z', JSON.stringify({ phase: 'UNKNOWN' }),
  ]);
  const accounting = await dispatch.getDailyAccounting({ db: fixture.db, deviceEui: '0016C001F1000001', timezone: 'UTC' });
  assert.deepEqual(accounting.days, {});
  assert.deepEqual(accounting.unknown_duration_command_ids, ['unknown-duration-command']);
});

test('daily accounting reprojects an old UTC reservation into the explicit current policy timezone', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await fixture.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, requested_duration_minutes, effective_duration_minutes, reservation_start_at, reservation_end_at, reserved_minutes, command_id, decision_evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
    'timezone-change-schedule', '2026-10-17', '00:10', '0016C001F1000001', '2026-10-17T00:10:00.000Z', 'UNKNOWN', '2026-10-17T00:41:00.000Z', 30, 30, '2026-10-17T00:10:00.000Z', '2026-10-17T01:11:00.000Z', 30, 'timezone-change-command', JSON.stringify({ minimum_gap_minutes: 0, exclusion_end_at: '2026-10-17T01:11:00.000Z', accounting: { timezone: 'UTC', local_days: ['2026-10-17'] } }),
  ]);
  await fixture.db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, created_at, transport_json) VALUES (?,?,?,?,?,?,?,?,?,?)", [
    'timezone-change-expectation', '0016C001F1000001', 'timezone-change-command', '2026-10-17T00:10:00.000Z', 1800, '2026-10-17T01:11:00.000Z', 'unknown', 'PENDING_OBSERVATION', '2026-10-17T00:10:00.000Z', JSON.stringify({ phase: 'UNKNOWN' }),
  ]);
  const accounting = await dispatch.getDailyAccounting({ db: fixture.db, deviceEui: '0016C001F1000001', timezone: 'America/Los_Angeles' });
  assert.deepEqual(accounting.days, { '2026-10-16': 30 });
  assert.equal(accounting.runs.length, 1);
  assert.deepEqual(accounting.runs[0].captured_local_days, ['2026-10-17']);
  assert.equal(accounting.days['2026-10-16'] + 20 > 40, true, 'the 20-minute candidate must hit the current 40-minute local-day limit');
});

test('daily accounting requires an explicit valid current policy timezone', async (t) => {
  const fixture = await dbFixture();
  t.after(fixture.cleanup);
  await assert.rejects(dispatch.getDailyAccounting({ db: fixture.db, deviceEui: '0016C001F1000001' }), (error) => error.code === 'accounting_timezone_required');
  await assert.rejects(dispatch.getDailyAccounting({ db: fixture.db, deviceEui: '0016C001F1000001', timezone: 'Not/AZone' }), (error) => error.code === 'invalid_timezone');
});
