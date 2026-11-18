'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { tempDb, facade, linkCloud } = require('./test-helpers');
const store = require('./store');
const P = require('./plan');
const W = require('./workers');
const push = require('./push');

let runtimeFixtureId = 0;
function controlledRuntime(sequence, { untrustedSample } = {}) {
  const id = ++runtimeFixtureId;
  const start = Date.parse('2026-08-19T10:00:00.000Z');
  const bootId = `workers-fix2-${id}`;
  let index = 0;
  let active = sequence[0];
  const fs = {
    readFileSync(file) {
      if (file === '/proc/sys/kernel/random/boot_id') return `${bootId}\n`;
      if (file === '/proc/uptime') return `${(active - start) / 1000} 0\n`;
      if (file === `/tmp/task4c2-fix2-clock-${id}.json`) {
        if (typeof untrustedSample === 'function' && untrustedSample(index)) throw Object.assign(new Error('marker unavailable'), { code: 'ENOENT' });
        return JSON.stringify({ boot_id: bootId, epoch_ms: start, uptime_ms: 0, stratum: 1 });
      }
      if (file.includes(`task4c2-fix2-rejection-${id}`)) throw Object.assign(new Error('missing rejection'), { code: 'ENOENT' });
      throw Object.assign(new Error('missing runtime fixture path'), { code: 'ENOENT' });
    },
  };
  return {
    clockOptions: {
      fs, bootPath: '/proc/sys/kernel/random/boot_id', uptimePath: '/proc/uptime',
      markerPath: `/tmp/task4c2-fix2-clock-${id}.json`,
      rejectionPath: `/tmp/task4c2-fix2-rejection-${id}.json`,
      fallbackPath: `/tmp/task4c2-fix2-rejection-fallback-${id}.json`,
    },
    runtimeNow() {
      active = sequence[Math.min(index++, sequence.length - 1)];
      return active;
    },
  };
}

function sharedQueueFacade(raw, shared) {
  const direct = facade(raw);
  const enqueue = (operation) => {
    const scheduled = shared.tail.then(operation);
    shared.tail = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  };
  return {
    get(sql, params) { return enqueue(() => direct.get(sql, params)); },
    all(sql, params) { return enqueue(() => direct.all(sql, params)); },
    run(sql, params) { return enqueue(() => direct.run(sql, params)); },
    transaction(executor) { return enqueue(() => direct.transaction(executor)); },
  };
}

function reopenFixture(fixture) {
  fixture.raw.close();
  fixture.db = facade(new DatabaseSync(fixture.path));
}

async function assignZone(db) {
  await db.run("INSERT INTO irrigation_zones(name, user_id, timezone) VALUES ('Fix2 Zone', 1, 'UTC')");
  const zone = await db.get("SELECT id FROM irrigation_zones WHERE name='Fix2 Zone'");
  await db.run("UPDATE devices SET irrigation_zone_id=? WHERE deveui='0016C001F1000001'", [zone.id]);
}

async function conditionalObservationFixture() {
  const fixture = await tempDb();
  const deviceEui = '0016C001F1000001';
  await assignZone(fixture.db);
  await store.upsertSettings(fixture.db, deviceEui, { strega_generation: 'GEN1' });
  await fixture.db.run('UPDATE valve_settings SET conditional_control_json=? WHERE device_eui=?', [JSON.stringify({ mode: 'CONDITIONAL', desired_revision: 'rev-5b2', required_push_ids: ['push-5b2'] }), deviceEui]);
  await store.insertPushes(fixture.db, [{ push_id: 'push-5b2', device_eui: deviceEui, purpose: 'WEEKDAY_PLAN', weekday: 2, fport: 16, payload_hex: 'FF'.repeat(24), plan_hash: 'clear' }]);
  await fixture.db.run('UPDATE valve_schedule_pushes SET transport_json=? WHERE push_id=?', [JSON.stringify({ phase: 'ATTEMPTED', attempted_at: '2026-08-19T10:00:00.000Z' }), 'push-5b2']);
  const open = await W.recordValveObservation({ db: fixture.db, deviceEui, observedState: 'OPEN', observedAt: '2026-08-19T10:00:01.000Z', runtimeContext: controlledRuntime([Date.parse('2026-08-19T10:00:02.000Z')]) });
  const retry = await push.retryClearRevision({ db: fixture.db, deviceEui, generation: 'GEN1', now: new Date('2026-08-19T10:00:03.000Z') });
  await fixture.db.run('UPDATE valve_schedule_pushes SET transport_json=? WHERE push_id=?', [JSON.stringify({ phase: 'ATTEMPTED', attempted_at: '2026-08-19T10:00:05.000Z' }), retry.required_push_ids[0]]);
  const remaining = retry.required_push_ids.slice(1);
  if (remaining.length) await fixture.db.run("UPDATE valve_schedule_pushes SET state='ACKED', ack_status=0, acked_at=? WHERE push_id IN (" + remaining.map(() => '?').join(',') + ')', ['2026-08-19T10:00:04.000Z'].concat(remaining));
  return { fixture, deviceEui, physicalRunId: open.physical_run_id, ackFport: 14 };
}

test('actual ACK and CLOSED flows finalize the same conditional incident in either order', async () => {
  const first = await conditionalObservationFixture();
  const ackFirst = await W.handleUplink({ db: first.fixture.db, deviceEui: first.deviceEui, decoded: { Schl_Port: first.ackFport, Schl_status: '00' }, fPort: 2, receivedAt: '2026-08-19T10:00:10.000Z', warn: () => {} });
  assert.equal(ackFirst.acked, 1);
  reopenFixture(first.fixture);
  const closedFirst = await W.recordValveObservation({ db: first.fixture.db, deviceEui: first.deviceEui, observedState: 'CLOSED', observedAt: '2026-08-19T10:00:20.000Z', runtimeContext: controlledRuntime([Date.parse('2026-08-19T10:00:21.000Z')]) });
  assert.equal(closedFirst.physical_run_id, first.physicalRunId);
  assert.equal((await store.conditionalControl(first.fixture.db, first.deviceEui)).incident.state, 'RECONCILED');
  assert.equal((await first.fixture.db.all('SELECT id FROM irrigation_events WHERE valve_deveui=?', [first.deviceEui])).length, 1);
  first.fixture.cleanup();

  const second = await conditionalObservationFixture();
  const closedSecond = await W.recordValveObservation({ db: second.fixture.db, deviceEui: second.deviceEui, observedState: 'CLOSED', observedAt: '2026-08-19T10:00:20.000Z', runtimeContext: controlledRuntime([Date.parse('2026-08-19T10:00:21.000Z')]) });
  assert.equal(closedSecond.physical_run_id, second.physicalRunId);
  assert.equal((await store.conditionalControl(second.fixture.db, second.deviceEui)).incident.state, 'ENDED');
  reopenFixture(second.fixture);
  const ackSecond = await W.handleUplink({ db: second.fixture.db, deviceEui: second.deviceEui, decoded: { Schl_Port: second.ackFport, Schl_status: '00' }, fPort: 2, receivedAt: '2026-08-19T10:00:30.000Z', warn: () => {} });
  assert.equal(ackSecond.acked, 1);
  assert.equal((await store.conditionalControl(second.fixture.db, second.deviceEui)).incident.state, 'RECONCILED');
  assert.equal((await second.fixture.db.all('SELECT id FROM irrigation_events WHERE valve_deveui=?', [second.deviceEui])).length, 1);
  second.fixture.cleanup();
});

test('handleUplink acks the newest queued weekday push and records RTC ack', async () => {
  const { db } = await tempDb();
  await store.insertPushes(db, [{ push_id: 'p1', device_eui: '0016C001F1000001', purpose: 'WEEKDAY_PLAN', weekday: 2, fport: 16, payload_hex: 'FF'.repeat(24), plan_hash: 'h' }, { push_id: 'p2', device_eui: '0016C001F1000001', purpose: 'CLOCK_SYNC', weekday: null, fport: 12, payload_hex: '00', plan_hash: null }]);
  await db.run("UPDATE valve_schedule_pushes SET transport_json=?", [JSON.stringify({ phase: 'ATTEMPTED', attempted_at: '2026-08-19T09:59:00.000Z' })]);
  const r = await W.handleUplink({ db, deviceEui: '0016C001F1000001', decoded: { Schl_Port: 16, Schl_status: '00' }, fPort: 2, rawBytes: null, receivedAt: '2026-08-19T10:00:00.000Z', warn: () => {} });
  assert.equal(r.acked, 1);
  await W.handleUplink({ db, deviceEui: '0016C001F1000001', decoded: { RTC_Port: 12, RTC_status: '00' }, fPort: 2, receivedAt: '2026-08-19T10:01:00.000Z', warn: () => {} });
  const rows = await db.all('SELECT push_id, state FROM valve_schedule_pushes ORDER BY push_id');
  // node:sqlite returns null-prototype row objects; spread into plain objects before deepEqual (strict).
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ push_id: 'p1', state: 'ACKED' }, { push_id: 'p2', state: 'ACKED' }]);
  assert.equal((await store.getSettings(db, '0016C001F1000001')).last_clock_sync_acked_at, '2026-08-19T10:01:00.000Z');
});

// P3-E1: handleUplink's ack loop is one of the code seams that changes ValveRuntime's derived
// state (push_state), but only for a WEEKDAY_PLAN/DAYMASK_PLAN ack -- a CLOCK_SYNC ack alone
// (as in the "records RTC ack" half of the test above) does not change that resource.
test('handleUplink (P3-E1) emits VALVE_RUNTIME_CHANGED on a linked gateway when a WEEKDAY_PLAN ack lands, not on a CLOCK_SYNC-only ack', async () => {
  const { db } = await tempDb();
  await linkCloud(db);
  await store.insertPushes(db, [{ push_id: 'p1', device_eui: '0016C001F1000001', purpose: 'WEEKDAY_PLAN', weekday: 2, fport: 16, payload_hex: 'FF'.repeat(24), plan_hash: 'h' }, { push_id: 'p2', device_eui: '0016C001F1000001', purpose: 'CLOCK_SYNC', weekday: null, fport: 12, payload_hex: '00', plan_hash: null }]);
  await db.run("UPDATE valve_schedule_pushes SET transport_json=?", [JSON.stringify({ phase: 'ATTEMPTED', attempted_at: '2026-08-19T09:59:00.000Z' })]);

  await W.handleUplink({ db, deviceEui: '0016C001F1000001', decoded: { RTC_Port: 12, RTC_status: '00' }, fPort: 2, receivedAt: '2026-08-19T10:00:00.000Z', warn: () => {} });
  assert.equal((await db.all("SELECT op FROM sync_outbox WHERE op='VALVE_RUNTIME_CHANGED'")).length, 0, 'a CLOCK_SYNC-only ack must not touch ValveRuntime');

  await W.handleUplink({ db, deviceEui: '0016C001F1000001', decoded: { Schl_Port: 16, Schl_status: '00' }, fPort: 2, receivedAt: '2026-08-19T10:00:01.000Z', warn: () => {} });
  const rows = await db.all("SELECT op, aggregate_key FROM sync_outbox WHERE op='VALVE_RUNTIME_CHANGED'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].aggregate_key, '0016C001F1000001');
});

test('runOnceTick fires due ONCE rows within grace and skips stale ones', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'due', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  await store.insertSchedule(db, { schedule_uuid: 'old', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T09:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  await store.insertSchedule(db, { schedule_uuid: 'future', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T12:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  const r = await W.runOnceTick({ db, now: new Date('2026-08-19T10:03:00Z'), warn: () => {} });
  assert.deepEqual(r.fired.map((f) => f.schedule_uuid), ['due']);
  assert.deepEqual(r.skipped.map((f) => f.schedule_uuid), ['old']);
  assert.equal(r.fired[0].actuator_command.data.action, 'OPEN_FOR_DURATION');
  assert.equal(r.fired[0].actuator_command.data.duration_minutes, 20);
  assert.equal(r.fired[0].actuator_command.data.reason, 'one_time_open');
  const states = await db.all('SELECT schedule_uuid, once_state FROM valve_schedules ORDER BY schedule_uuid');
  assert.deepEqual(states.map((s) => ({ ...s })), [{ schedule_uuid: 'due', once_state: 'FIRED' }, { schedule_uuid: 'future', once_state: 'PENDING' }, { schedule_uuid: 'old', once_state: 'SKIPPED' }]);
  const again = await W.runOnceTick({ db, now: new Date('2026-08-19T10:04:00Z'), warn: () => {} });
  assert.equal(again.fired.length + again.skipped.length, 0, 'idempotent');
});

test('runOnceTick leaves a pending dispatch intent before the attempt marker and resumes it after restart', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'intent-before', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  await assert.rejects(() => W.runOnceTick({ db, now: new Date('2026-08-19T10:03:00Z'), beforeAttempt: () => { throw new Error('simulated restart'); }, warn: () => {} }), /simulated restart/);
  const pending = await db.get("SELECT state, command_id FROM valve_once_dispatch_intents WHERE schedule_uuid='intent-before'");
  assert.equal(pending.state, 'PENDING');
  const resumed = await W.runOnceTick({ db, now: new Date('2026-08-19T10:04:00Z'), warn: () => {} });
  assert.equal(resumed.fired[0].command_id, pending.command_id);
  assert.equal((await db.get("SELECT once_state FROM valve_schedules WHERE schedule_uuid='intent-before'")).once_state, 'FIRED');
});

test('runOnceTick marks an attempted intent unknown and never resends it after restart', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'intent-after', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  const first = await W.runOnceTick({ db, now: new Date('2026-08-19T10:03:00Z'), afterAttempt: () => { throw new Error('simulated restart'); }, warn: () => {} }).catch((e) => e);
  assert.equal(first.message, 'simulated restart');
  const row = await db.get("SELECT state, command_id FROM valve_once_dispatch_intents WHERE schedule_uuid='intent-after'");
  assert.equal(row.state, 'ATTEMPTED');
  const resumed = await W.runOnceTick({ db, now: new Date('2026-08-19T10:04:00Z'), warn: () => {} });
  assert.equal(resumed.fired.length, 0);
  assert.equal((await db.get("SELECT state FROM valve_once_dispatch_intents WHERE schedule_uuid='intent-after'")).state, 'UNKNOWN');
});

test('runOnceTick records an overdue unsent intent as skipped', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'intent-overdue', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T09:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  await W.runOnceTick({ db, now: new Date('2026-08-19T10:03:00Z'), warn: () => {} });
  const row = await db.get("SELECT state FROM valve_once_dispatch_intents WHERE schedule_uuid='intent-overdue'");
  assert.equal(row.state, 'SKIPPED');
});

test('runOnceTick claims a pending intent once even when the tick repeats', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'intent-race', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  const first = await W.runOnceTick({ db, now: new Date('2026-08-19T10:03:00Z'), warn: () => {} });
  const second = await W.runOnceTick({ db, now: new Date('2026-08-19T10:03:00Z'), warn: () => {} });
  assert.equal(first.fired.length + second.fired.length, 1);
  assert.equal((await db.all("SELECT * FROM valve_once_dispatch_intents WHERE schedule_uuid='intent-race'")).length, 1);
});

test('runOnceTick marks a successfully emitted command SENT', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'intent-sent', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  let emitted = 0;
  await W.runOnceTick({ db, now: new Date('2026-08-19T10:03:00Z'), emit: async () => { emitted += 1; }, warn: () => {} });
  assert.equal(emitted, 1);
  assert.equal((await db.get("SELECT state FROM valve_once_dispatch_intents WHERE schedule_uuid='intent-sent'")).state, 'SENT');
  const next = await W.runOnceTick({ db, now: new Date('2026-08-19T10:04:00Z'), emit: async () => { emitted += 1; }, warn: () => {} });
  assert.equal(next.fired.length, 0);
  assert.equal(emitted, 1);
});

test('runOnceTick leaves an attempted intent UNKNOWN after a handoff crash', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'intent-handoff-crash', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  await assert.rejects(() => W.runOnceTick({ db, now: new Date('2026-08-19T10:03:00Z'), emit: async () => { throw new Error('handoff crashed'); }, warn: () => {} }), /handoff crashed/);
  const next = await W.runOnceTick({ db, now: new Date('2026-08-19T10:04:00Z'), emit: async () => { throw new Error('must not resend'); }, warn: () => {} });
  assert.equal(next.fired.length, 0);
  assert.equal((await db.get("SELECT state FROM valve_once_dispatch_intents WHERE schedule_uuid='intent-handoff-crash'")).state, 'UNKNOWN');
});

// Owner decision 2026-10-24: an untrusted (NTP) clock no longer stops a ONCE open, so the
// pre-claim failure these resume tests need is a crash at the final runtime sample instead.
function crashAtSample(base, sample) {
  let calls = 0;
  return { ...base, runtimeNow() { calls += 1; if (calls === sample) throw Object.assign(new Error('pre-claim crash'), { code: 'pre_claim_crash' }); return base.runtimeNow(); } };
}

test('runOnceTick retries a pre-claim failure with the same command, fire_at, and cutoff', async () => {
  const { db } = await tempDb();
  await assignZone(db);
  await store.insertSchedule(db, { schedule_uuid: 'fix2-preclaim-retry', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 2, timezone: 'UTC', enabled: 1 });
  let rpcCalls = 0;
  const transport = { async enqueueDownlink() { rpcCalls += 1; return { id: 'fix2-retry-q1' }; } };
  const failed = await W.runOnceTick({ db, now: new Date('2026-08-19T10:03:00Z'), transport,
    trustedContext: crashAtSample(controlledRuntime([Date.parse('2026-08-19T10:03:00Z'), Date.parse('2026-08-19T10:03:00Z')]), 2), warn: () => {} }).catch((error) => ({ fired: [], error }));
  assert.equal(failed.fired.length, 0);
  assert.equal(rpcCalls, 0, 'a pre-claim failure must not hand off');
  const before = await db.get("SELECT i.command_id, i.state, vs.fire_at, vae.transport_json FROM valve_once_dispatch_intents i JOIN valve_schedules vs ON vs.schedule_uuid=i.schedule_uuid LEFT JOIN valve_actuation_expectations vae ON vae.command_id=i.command_id WHERE i.schedule_uuid='fix2-preclaim-retry'");
  assert.equal(before.state, 'UNKNOWN');
  const beforeState = JSON.parse(before.transport_json);
  assert.equal(beforeState.phase, undefined);
  assert.ok(beforeState.effect_snapshot);
  const cutoff = beforeState.effect_snapshot.queue_expires_at;
  const recovered = await W.runOnceTick({ db, now: new Date('2026-08-19T10:04:00Z'), transport,
    trustedContext: controlledRuntime([Date.parse('2026-08-19T10:04:00Z'), Date.parse('2026-08-19T10:04:00Z')]), warn: () => {} });
  assert.equal(recovered.fired.length, 1);
  assert.equal(rpcCalls, 1);
  const after = await db.get("SELECT i.command_id, i.state, vs.fire_at, vs.once_state, vae.transport_json FROM valve_once_dispatch_intents i JOIN valve_schedules vs ON vs.schedule_uuid=i.schedule_uuid JOIN valve_actuation_expectations vae ON vae.command_id=i.command_id WHERE i.schedule_uuid='fix2-preclaim-retry'");
  const afterState = JSON.parse(after.transport_json);
  assert.equal(after.command_id, before.command_id);
  assert.equal(after.fire_at, '2026-08-19T10:00:00.000Z');
  assert.equal(after.once_state, 'FIRED');
  assert.equal(afterState.effect_snapshot.queue_expires_at, cutoff);
  assert.equal((await db.all("SELECT * FROM actuator_log WHERE reason='one_time_open:fix2-preclaim-retry:2026-08-19T10:00:00.000Z'")).length, 1);
  assert.equal((await db.all("SELECT * FROM irrigation_events WHERE reason='one_time_open' AND payload_json LIKE '%fix2-preclaim-retry%'")).length, 1);
});

test('runOnceTick skips an unclaimed snapshot after its stricter immutable cutoff without RPC or audit duplication', async () => {
  const { db } = await tempDb();
  await assignZone(db);
  await store.insertSchedule(db, { schedule_uuid: 'fix2-expired-unclaimed', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 2, timezone: 'UTC', enabled: 1 });
  let rpcCalls = 0;
  const transport = { async enqueueDownlink() { rpcCalls += 1; throw new Error('expired unclaimed must not enqueue'); } };
  await W.runOnceTick({ db, now: new Date('2026-08-19T10:03:00Z'), transport,
    trustedContext: crashAtSample(controlledRuntime([Date.parse('2026-08-19T10:03:00Z'), Date.parse('2026-08-19T10:03:00Z')]), 2), warn: () => {} }).catch(() => null);
  const before = await db.get("SELECT transport_json FROM valve_actuation_expectations WHERE command_id=(SELECT command_id FROM valve_once_dispatch_intents WHERE schedule_uuid='fix2-expired-unclaimed')");
  const cutoff = JSON.parse(before.transport_json).effect_snapshot.queue_expires_at;
  assert.equal(cutoff, '2026-08-19T10:31:00.000Z');
  const skipped = await W.runOnceTick({ db, now: new Date('2026-08-19T10:32:00Z'), transport,
    trustedContext: controlledRuntime([Date.parse('2026-08-19T10:32:00Z'), Date.parse('2026-08-19T10:32:00Z')]), warn: () => {} });
  assert.deepEqual(skipped.skipped.map((row) => row.schedule_uuid), ['fix2-expired-unclaimed']);
  assert.equal(rpcCalls, 0);
  assert.equal((await db.get("SELECT state FROM valve_once_dispatch_intents WHERE schedule_uuid='fix2-expired-unclaimed'")).state, 'SKIPPED');
  assert.equal((await db.get("SELECT once_state FROM valve_schedules WHERE schedule_uuid='fix2-expired-unclaimed'")).once_state, 'SKIPPED');
  assert.equal((await db.all("SELECT * FROM actuator_log WHERE reason LIKE 'one_time_open:fix2-expired-unclaimed:%'")).length, 0);
  assert.equal((await db.all("SELECT * FROM irrigation_events WHERE reason='one_time_missed' AND payload_json LIKE '%fix2-expired-unclaimed%'")).length, 1);
  const again = await W.runOnceTick({ db, now: new Date('2026-08-19T10:33:00Z'), transport, warn: () => {} });
  assert.equal(again.skipped.length, 0);
  assert.equal((await db.all("SELECT * FROM irrigation_events WHERE reason='one_time_missed' AND payload_json LIKE '%fix2-expired-unclaimed%'")).length, 1);
});

async function uncertainOnceFixture(t) {
  const fixture = await tempDb();
  t.after(fixture.cleanup);
  const { db } = fixture;
  const deviceEui = 'A840410000000001';
  const scheduleUuid = 'uncertain-once';
  await db.run("INSERT INTO irrigation_zones(name,user_id,timezone) VALUES ('Once Zone',1,'UTC')");
  const zone = await db.get("SELECT id FROM irrigation_zones WHERE name='Once Zone'");
  await db.run("INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at) VALUES (?,'Once Valve','STREGA_VALVE',1,?,datetime('now'),datetime('now'))", [deviceEui, zone.id]);
  await store.insertSchedule(db, { schedule_uuid: scheduleUuid, device_eui: deviceEui, kind: 'ONCE', fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 2, timezone: 'UTC', enabled: 1 });
  const calls = { enqueue: 0, queue: 0 };
  const warnings = [];
  let queue = [];
  const transport = {
    async enqueueDownlink() { calls.enqueue += 1; throw new Error('gateway handoff uncertain'); },
    async getDeviceQueue(devEui) { assert.equal(devEui, deviceEui); calls.queue += 1; return queue; },
  };
  const tick = (at, extra = {}) => W.runOnceTick({ db, now: new Date(at), transport, warn: (message) => warnings.push(message), ...extra });
  const first = await tick('2026-08-19T10:03:00Z', {
    trustedContext: controlledRuntime([Date.parse('2026-08-19T10:03:00Z'), Date.parse('2026-08-19T10:03:00Z')]),
  });
  assert.equal(first.transportFailures.length, 1);
  assert.equal(calls.enqueue, 1);
  const intent = await db.get('SELECT * FROM valve_once_dispatch_intents WHERE schedule_uuid=?', [scheduleUuid]);
  const expectation = await db.get('SELECT * FROM valve_actuation_expectations WHERE command_id=?', [intent.command_id]);
  return { ...fixture, deviceEui, scheduleUuid, calls, warnings, tick, transport, intent, expectation, setQueue(value) { queue = value; } };
}

function uplinkHistory(intervalMinutes, count = 10, end = '2026-08-19T10:00:00Z') {
  return Array.from({ length: count }, (_, i) => new Date(Date.parse(end) - i * intervalMinutes * 60000).toISOString());
}

for (const [interval, minutes] of [[10, 25], [15, 35], [30, 65], [2, 15], [120, 180]]) {
  test(`confirmationDeadline derives ${minutes} minutes from a ${interval}-minute history`, () => {
    const result = W.confirmationDeadline({ attemptedAt: '2026-08-19T10:03:00Z', fireAt: '2026-08-19T10:00:00Z', uplinkTimes: uplinkHistory(interval) });
    assert.deepEqual(result, { confirmBy: new Date(Date.parse('2026-08-19T10:03:00Z') + minutes * 60000).toISOString(), interval });
  });
}

test('confirmationDeadline defaults to ten minutes with fewer than two usable gaps and falls back to fire_at', () => {
  for (const uplinkTimes of [[], uplinkHistory(30, 2), ['invalid']]) {
    assert.deepEqual(W.confirmationDeadline({ fireAt: '2026-08-19T10:00:00Z', uplinkTimes }), { confirmBy: '2026-08-19T10:25:00.000Z', interval: 10 });
  }
});

test('confirmationDeadline ignores bursts under 30 seconds and uses the median, including even gap counts', () => {
  const base = Date.parse('2026-08-19T09:00:00Z');
  // Gaps: 15 min, 10 s burst, 15 min, 30 min, 60 min. Median is (15 + 30) / 2.
  const uplinkTimes = [0, 900, 910, 1810, 3610, 7210].map((seconds) => new Date(base + seconds * 1000).toISOString());
  const result = W.confirmationDeadline({ attemptedAt: '2026-08-19T12:00:00Z', uplinkTimes });
  assert.equal(result.interval, 22.5);
  assert.equal(result.confirmBy, '2026-08-19T12:50:00.000Z');
  assert.equal(W.confirmationDeadline({ attemptedAt: '2026-08-19T10:00:00Z', uplinkTimes: uplinkHistory(0.5) }).interval, 0.5, '30-second gaps are usable');
});

test('confirmationDeadline uses only the last ten uplinks within 48 hours and excludes future rows', () => {
  const attemptedAt = '2026-08-19T10:03:00Z';
  const uplinkTimes = [...uplinkHistory(15), ...uplinkHistory(60, 10, '2026-08-19T07:00:00Z'), ...uplinkHistory(120, 10, '2026-08-16T10:00:00Z'), ...uplinkHistory(1, 10, '2026-08-20T10:00:00Z')];
  assert.equal(W.confirmationDeadline({ attemptedAt, uplinkTimes }).interval, 15);
  assert.equal(W.confirmationDeadline({ attemptedAt, uplinkTimes: uplinkHistory(120, 10, '2026-08-16T10:00:00Z') }).interval, 10);
});

async function addUplinkHistory(fixture, interval = 15) {
  for (const at of uplinkHistory(interval)) await fixture.db.run('INSERT INTO device_data(deveui,recorded_at) VALUES (?,?)', [fixture.deviceEui, at]);
}

async function recordOnceOpen(fixture, at) {
  return W.recordValveObservation({ db: fixture.db, deviceEui: fixture.deviceEui, observedState: 'OPEN', observedAt: at,
    runtimeContext: controlledRuntime([Date.parse(at) + 1000]) });
}

test('runOnceTick waits for a 15-minute valve and accepts its OPEN at minute 16 without a SKIP or resend', async (t) => {
  const f = await uncertainOnceFixture(t);
  await addUplinkHistory(f);
  assert.deepEqual(await f.tick('2026-08-19T10:11:00Z'), { fired: [], skipped: [], transportFailures: [] });
  const observation = await recordOnceOpen(f, '2026-08-19T10:16:00Z');
  assert.equal(observation.kind, 'owner');
  assert.equal((await f.tick('2026-08-19T10:16:01Z')).fired.length, 1);
  assert.equal((await f.db.get('SELECT once_state FROM valve_schedules')).once_state, 'FIRED');
  assert.equal((await f.db.all("SELECT * FROM irrigation_events WHERE action='SKIP'")).length, 0);
  assert.equal(f.calls.enqueue, 1);
});

test('runOnceTick skips a 15-minute valve only after confirm_by, once, with the deadline and interval', async (t) => {
  const f = await uncertainOnceFixture(t);
  await addUplinkHistory(f);
  assert.equal((await f.tick('2026-08-19T10:38:00Z')).skipped.length, 0);
  assert.equal((await f.tick('2026-08-19T10:38:00.001Z')).skipped.length, 1);
  await f.tick('2026-08-19T10:39:00Z');
  const events = await f.db.all('SELECT * FROM irrigation_events');
  assert.equal(events.length, 1);
  const payload = JSON.parse(events[0].payload_json);
  assert.equal(payload.confirm_by, '2026-08-19T10:38:00.000Z');
  assert.equal(payload.interval, 15);
  assert.equal(f.calls.enqueue, 1);
});

for (const racing of [false, true]) {
  test(`runOnceTick corrects a late physical OPEN exactly once (${racing ? 'racing' : 'repeated'} ticks) without resending`, async (t) => {
    const f = await uncertainOnceFixture(t);
    await addUplinkHistory(f);
    await f.tick('2026-08-19T10:38:00.001Z');
    const observed = await recordOnceOpen(f, '2026-08-19T10:39:00Z');
    assert.equal(observed.kind, 'synthetic', 'late OPEN is outside the immutable command window, so reconciliation records a physical run');
    if (racing) {
      const shared = { tail: Promise.resolve() };
      await Promise.all([1, 2].map(() => f.tick('2026-08-19T10:39:01Z', { db: sharedQueueFacade(f.raw, shared) })));
    } else await f.tick('2026-08-19T10:39:01Z');
    await f.tick('2026-08-19T10:39:02Z');
    await f.tick('2026-08-19T10:39:03Z');
    const events = await f.db.all("SELECT * FROM irrigation_events WHERE reason='one_time_open_confirmed_late'");
    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'IRRIGATE');
    assert.deepEqual(JSON.parse(events[0].payload_json), { schedule_uuid: f.scheduleUuid, fire_at: '2026-08-19T10:00:00.000Z', observed_open_at: '2026-08-19T10:39:00.000Z', attempted_at: f.intent.attempted_at });
    const schedule = await f.db.get('SELECT once_state,once_fired_at FROM valve_schedules');
    assert.deepEqual({ ...schedule }, { once_state: 'FIRED', once_fired_at: '2026-08-19T10:00:00.000Z' });
    assert.equal((await f.db.get('SELECT state FROM valve_once_dispatch_intents')).state, 'SKIPPED');
    assert.equal((await f.db.all("SELECT * FROM irrigation_events WHERE reason='one_time_uncertain'")).length, 1);
    assert.equal((await f.db.all('SELECT * FROM actuator_log')).length, 1);
    assert.equal(f.calls.enqueue, 1);
  });
}

for (const scenario of ['other attempt', 'OPEN after window', 'OPEN before attempt', 'expired correction window', 'untrusted OPEN', 'malformed physical run']) {
  test(`runOnceTick does not correct a late skip with ${scenario}`, async (t) => {
    const f = await uncertainOnceFixture(t);
    await addUplinkHistory(f);
    await f.tick('2026-08-19T10:38:00.001Z');
    if (scenario === 'other attempt') await insertOtherExpectation(f.db, f.deviceEui, 'other-open', { phase: 'UNKNOWN', attempted_at: '2026-08-19T10:20:00Z' });
    const at = scenario === 'OPEN after window' ? '2026-08-19T10:40:00.001Z'
      : scenario === 'OPEN before attempt' ? '2026-08-19T10:02:59.999Z' : '2026-08-19T10:39:00Z';
    if (scenario === 'untrusted OPEN') await W.recordValveObservation({ db: f.db, deviceEui: f.deviceEui, observedState: 'OPEN', observedAt: at,
      runtimeContext: controlledRuntime([Date.parse(at) + 1000], { untrustedSample: () => true }) });
    else await recordOnceOpen(f, at);
    if (scenario === 'malformed physical run') {
      const physical = await f.db.get('SELECT expectation_id,transport_json FROM valve_actuation_expectations WHERE command_id IS NULL AND device_eui=?', [f.deviceEui]);
      const state = JSON.parse(physical.transport_json);
      state.physical_run.earliest_possible_start_at = 'invalid';
      await f.db.run('UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?', [JSON.stringify(state), physical.expectation_id]);
    }
    await f.tick(scenario === 'expired correction window' ? '2026-08-19T10:40:00.001Z' : '2026-08-19T10:39:01Z');
    assert.equal((await f.db.get('SELECT once_state FROM valve_schedules')).once_state, 'SKIPPED');
    assert.equal((await f.db.all("SELECT * FROM irrigation_events WHERE reason='one_time_open_confirmed_late'")).length, 0);
    assert.equal((await f.db.all('SELECT * FROM actuator_log')).length, 0);
    assert.equal(f.calls.enqueue, 1);
  });
}

test('runOnceTick keeps the never-attempted ten-minute missed deadline', async (t) => {
  const f = await tempDb();
  t.after(f.cleanup);
  await assignZone(f.db);
  await store.insertSchedule(f.db, { schedule_uuid: 'never-attempted', device_eui: '0016C001F1000001', kind: 'ONCE', fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 2, timezone: 'UTC', enabled: 1 });
  let enqueues = 0;
  const result = await W.runOnceTick({ db: f.db, now: new Date('2026-08-19T10:10:00.001Z'), transport: { async enqueueDownlink() { enqueues++; } } });
  assert.equal(result.skipped.length, 1);
  assert.equal((await f.db.get('SELECT reason FROM irrigation_events')).reason, 'one_time_missed');
  assert.equal(enqueues, 0);
  const [schedule] = await store.listSchedules(f.db, '0016C001F1000001');
  assert.equal(schedule.once_outcome, 'missed');
  assert.equal(schedule.awaiting_confirmation_until, null);
});

test('runOnceTick skips an uncertain open after its confirmation deadline exactly once without resending', async (t) => {
  const { db, tick, calls, intent, expectation } = await uncertainOnceFixture(t);
  const resumed = await tick('2026-08-19T10:28:00.001Z');
  assert.equal(resumed.fired.length, 0);
  assert.equal(resumed.skipped.length, 1);
  assert.equal(resumed.transportFailures.length, 0);
  assert.equal((await db.get('SELECT state FROM valve_once_dispatch_intents')).state, 'SKIPPED');
  assert.equal((await db.get('SELECT once_state FROM valve_schedules')).once_state, 'SKIPPED');
  const events = await db.all('SELECT * FROM irrigation_events');
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'SKIP');
  assert.equal(events[0].reason, 'one_time_uncertain');
  const payload = JSON.parse(events[0].payload_json);
  assert.equal(payload.schedule_uuid, 'uncertain-once');
  assert.equal(payload.fire_at, '2026-08-19T10:00:00.000Z');
  assert.equal(payload.attempted_at, intent.attempted_at);
  assert.equal(payload.confirm_by, '2026-08-19T10:28:00.000Z');
  assert.equal(payload.interval, 10);
  assert.equal(payload.phase, JSON.parse(expectation.transport_json).phase);
  assert.match(payload.note, /attempted.*not confirmed/);
  const afterSkip = await db.get('SELECT transport_json FROM valve_actuation_expectations WHERE command_id=?', [intent.command_id]);
  assert.equal(afterSkip.transport_json, expectation.transport_json, 'settling never rewrites the transport state');
  await tick('2026-08-19T10:29:00Z');
  await tick('2026-08-19T10:30:00Z');
  assert.equal((await db.all('SELECT * FROM irrigation_events')).length, 1);
  assert.equal((await db.all('SELECT * FROM actuator_log')).length, 0);
  assert.equal(calls.enqueue, 1);
});

test('runOnceTick leaves an uncertain open pending through the exact confirmation boundary without resending', async (t) => {
  const { db, tick, calls, setQueue } = await uncertainOnceFixture(t);
  // Neither a different port nor a different duration proves this open was queued.
  setQueue([{ fPort: 3, data: 'QQI=' }, { fPort: 2, data: 'QQM=' }]);
  for (const at of ['2026-08-19T10:04:00Z', '2026-08-19T10:05:00Z', '2026-08-19T10:28:00Z']) {
    assert.deepEqual(await tick(at), { fired: [], skipped: [], transportFailures: [] });
  }
  assert.equal((await db.get('SELECT state FROM valve_once_dispatch_intents')).state, 'UNKNOWN');
  assert.equal((await db.get('SELECT once_state FROM valve_schedules')).once_state, 'PENDING');
  assert.equal((await db.all('SELECT * FROM irrigation_events')).length, 0);
  assert.equal(calls.queue, 3);
  assert.equal(calls.enqueue, 1);
});

// Another command's expectation on the same valve, with its own transport state.
async function insertOtherExpectation(db, deviceEui, commandId, transport) {
  await db.run("INSERT INTO valve_actuation_expectations(expectation_id,device_eui,zone_id,command_id,effect_key,commanded_at,commanded_duration_seconds,expected_close_at,volume_source,observed_open_at,reconciliation_state,created_at,trigger,transport_json) SELECT ?,UPPER(d.deveui),d.irrigation_zone_id,?,NULL,?,120,?,'unknown',NULL,'PENDING_OBSERVATION',?,'manual',? FROM devices d WHERE UPPER(d.deveui)=UPPER(?)",
    ['other-' + commandId, commandId, '2026-08-19T10:02:00.000Z', '2026-08-19T10:04:00.000Z', '2026-08-19T10:02:00.000Z', JSON.stringify(transport), deviceEui]);
}

for (const [label, other, queueId] of [
  ['owned by another command', { phase: 'ACCEPTED', queue_id: 'manual-queued' }, 'manual-queued'],
  ['unowned while another open on the valve is unconfirmed', { phase: 'UNKNOWN' }, 'unowned-queued'],
]) {
  test(`runOnceTick does not take an identical queued item ${label} as proof`, async (t) => {
    const { db, tick, calls, setQueue, deviceEui } = await uncertainOnceFixture(t);
    await insertOtherExpectation(db, deviceEui, 'manual-open', other);
    // A manual open builds the same frame as the one-time open.
    setQueue([{ id: queueId, fPort: 2, data: Buffer.from([0x41, 2]).toString('base64') }]);
    assert.deepEqual(await tick('2026-08-19T10:04:00Z'), { fired: [], skipped: [], transportFailures: [] });
    assert.equal((await db.get('SELECT once_state FROM valve_schedules')).once_state, 'PENDING');
    assert.equal((await db.all('SELECT * FROM actuator_log')).length, 0);
    const late = await tick('2026-08-19T10:28:00.001Z');
    assert.equal(late.skipped.length, 1);
    assert.equal((await db.get('SELECT once_state FROM valve_schedules')).once_state, 'SKIPPED');
    assert.equal((await db.get('SELECT reason FROM irrigation_events')).reason, 'one_time_uncertain');
    assert.equal(calls.enqueue, 1);
  });
}

test('runOnceTick still accepts a queued match whose id no other command owns', async (t) => {
  const { db, tick, calls, setQueue, deviceEui } = await uncertainOnceFixture(t);
  await insertOtherExpectation(db, deviceEui, 'manual-open', { phase: 'ACCEPTED', queue_id: 'manual-queued' });
  const data = Buffer.from([0x41, 2]).toString('base64');
  setQueue([{ id: 'manual-queued', fPort: 2, data }, { id: 'once-queued', fPort: 2, data }]);
  const out = await tick('2026-08-19T10:04:00Z');
  assert.equal(out.fired.length, 1);
  assert.equal((await db.get('SELECT once_state FROM valve_schedules')).once_state, 'FIRED');
  assert.equal(calls.enqueue, 1);
});

test('runOnceTick finalizes an uncertain queued match through the accepted bookkeeping', async (t) => {
  const { db, tick, calls, setQueue, warnings } = await uncertainOnceFixture(t);
  setQueue([{ id: 'once-queued', fPort: 2, data: Buffer.from([0x41, 2]).toString('base64') }]);
  const out = await tick('2026-08-19T10:04:00Z');
  assert.equal(out.fired.length, 1);
  assert.equal(out.skipped.length, 0);
  assert.equal((await db.get('SELECT state FROM valve_once_dispatch_intents')).state, 'SENT');
  assert.equal((await db.get('SELECT once_state FROM valve_schedules')).once_state, 'FIRED');
  assert.equal((await db.get('SELECT reason FROM actuator_log')).reason, 'one_time_open:uncertain-once:2026-08-19T10:00:00.000Z');
  assert.equal((await db.get('SELECT reason FROM irrigation_events')).reason, 'one_time_open');
  await tick('2026-08-19T10:05:00Z');
  assert.equal((await db.all('SELECT * FROM actuator_log')).length, 1);
  assert.equal((await db.all('SELECT * FROM irrigation_events')).length, 1);
  assert.equal(calls.enqueue, 1);
  assert.ok(warnings.some((message) => /queue/i.test(message)));
});

for (const evidence of ['observed_open_at', 'OBSERVED_RUNNING']) {
  test(`runOnceTick finalizes an uncertain open from ${evidence} at the attempt time`, async (t) => {
    const { db, tick, calls, intent, expectation } = await uncertainOnceFixture(t);
    const state = JSON.parse(expectation.transport_json);
    if (evidence === 'observed_open_at') {
      await db.run('UPDATE valve_actuation_expectations SET observed_open_at=? WHERE command_id=?', [intent.attempted_at, intent.command_id]);
    } else {
      state.observation = { source: 'explicit_report', observed_at: intent.attempted_at };
      await db.run("UPDATE valve_actuation_expectations SET reconciliation_state='OBSERVED_RUNNING', transport_json=? WHERE command_id=?", [JSON.stringify(state), intent.command_id]);
    }
    const out = await tick('2026-08-19T10:04:00Z');
    assert.equal(out.fired.length, 1);
    assert.equal(out.skipped.length, 0);
    assert.equal((await db.get('SELECT once_state FROM valve_schedules')).once_state, 'FIRED');
    assert.equal((await db.get('SELECT state FROM valve_once_dispatch_intents')).state, 'SENT');
    assert.equal((await db.all("SELECT * FROM irrigation_events WHERE action='SKIP'")).length, 0);
    assert.equal((await db.all("SELECT * FROM irrigation_events WHERE reason='one_time_open'")).length, 1);
    await tick('2026-08-19T10:05:00Z');
    assert.equal(calls.enqueue, 1);
  });
}

test('runOnceTick rejects OPEN evidence older than the attempted open', async (t) => {
  const { db, tick, calls, intent, expectation } = await uncertainOnceFixture(t);
  const state = JSON.parse(expectation.transport_json);
  state.observation = { observed_at: '2026-08-19T10:02:59.999Z' };
  await db.run("UPDATE valve_actuation_expectations SET observed_open_at=?, reconciliation_state='OBSERVED_RUNNING', transport_json=? WHERE command_id=?", [state.observation.observed_at, JSON.stringify(state), intent.command_id]);
  assert.deepEqual(await tick('2026-08-19T10:04:00Z'), { fired: [], skipped: [], transportFailures: [] });
  assert.equal((await db.get('SELECT once_state FROM valve_schedules')).once_state, 'PENDING');
  assert.equal((await db.all('SELECT * FROM irrigation_events')).length, 0);
  assert.equal(calls.enqueue, 1);
});

test('runOnceTick races uncertain expiry on live-shaped facades without duplicate SKIP events', async (t) => {
  const fixture = await uncertainOnceFixture(t);
  const shared = { tail: Promise.resolve() };
  const outcomes = await Promise.all([1, 2].map(() => fixture.tick('2026-08-19T10:29:00Z', { db: sharedQueueFacade(fixture.raw, shared) })));
  assert.equal(outcomes.reduce((sum, out) => sum + out.skipped.length, 0), 1);
  assert.equal((await fixture.db.all("SELECT * FROM irrigation_events WHERE reason='one_time_uncertain'")).length, 1);
  assert.equal(fixture.calls.enqueue, 1);
});

test('runOnceTick warns on queue lookup failure, waits through the confirmation deadline, then skips without resending', async (t) => {
  const { db, tick, calls, transport, warnings } = await uncertainOnceFixture(t);
  transport.getDeviceQueue = async () => { throw new Error('queue unavailable'); };
  assert.deepEqual(await tick('2026-08-19T10:04:00Z'), { fired: [], skipped: [], transportFailures: [] });
  assert.equal((await tick('2026-08-19T10:29:00Z')).skipped.length, 1);
  assert.equal((await db.get('SELECT reason FROM irrigation_events')).reason, 'one_time_uncertain');
  assert.ok(warnings.some((message) => /queue lookup failed: queue unavailable/.test(message)));
  assert.equal(calls.enqueue, 1);
});

test('runOnceTick settles uncertainty without a queue API and omits the SKIP event when the zone is unknown', async (t) => {
  const { db, tick, calls, transport, deviceEui } = await uncertainOnceFixture(t);
  delete transport.getDeviceQueue;
  await db.run('UPDATE devices SET irrigation_zone_id=NULL WHERE deveui=?', [deviceEui]);
  assert.equal((await tick('2026-08-19T10:29:00Z')).skipped.length, 1);
  assert.equal((await db.get('SELECT once_state FROM valve_schedules')).once_state, 'SKIPPED');
  assert.equal((await db.all('SELECT * FROM irrigation_events')).length, 0);
  assert.equal(calls.enqueue, 1);
});

test('runOnceTick leaves an uncertain schedule disabled during the queue lookup untouched', async (t) => {
  const { db, tick, calls, transport, scheduleUuid } = await uncertainOnceFixture(t);
  transport.getDeviceQueue = async () => {
    await db.run('UPDATE valve_schedules SET enabled=0 WHERE schedule_uuid=?', [scheduleUuid]);
    return [{ fPort: 2, data: 'QQI=' }];
  };
  assert.deepEqual(await tick('2026-08-19T10:11:00Z'), { fired: [], skipped: [], transportFailures: [] });
  assert.equal((await db.get('SELECT once_state FROM valve_schedules')).once_state, 'PENDING');
  assert.equal((await db.all('SELECT * FROM irrigation_events')).length, 0);
  assert.equal(calls.enqueue, 1);
});

for (const [label, transport, patch] of [
  ['old UNKNOWN without a live queue item', { phase: 'UNKNOWN', attempted_at: '2026-08-18T10:02:59Z' }, null],
  ['expired snapshot', { phase: 'UNKNOWN', attempted_at: '2026-08-19T10:03:00Z', effect_snapshot: { queue_expires_at: '2026-08-19T10:03:59Z' } }, null],
  ['explicit expiry', { phase: 'UNKNOWN', explicit_expiry_at: '2026-08-19T10:03:59Z' }, null],
  ['accepted item already delivered', { phase: 'ACCEPTED', queue_id: 'gone-queue-id' }, null],
  ['rejected enqueue', { phase: 'enqueue_rejected' }, null],
  ['cancelled unsent', { phase: 'UNKNOWN', cancelled_unsent_at: '2026-08-19T10:03:00Z' }, 'CANCELLED'],
  ['invalidated by a completed flush', { phase: 'UNKNOWN', invalidated_by_flush: 'flush-1', first_invalidated_by_flush: 'flush-1' }, null],
]) {
  test(`runOnceTick queue proof ignores ${label}`, async (t) => {
    const f = await uncertainOnceFixture(t);
    await insertOtherExpectation(f.db, f.deviceEui, 'old-owner', transport);
    if (patch) await f.db.run('UPDATE valve_actuation_expectations SET reconciliation_state=? WHERE command_id=?', [patch, 'old-owner']);
    f.setQueue([{ id: 'once-queue', fPort: 2, data: Buffer.from([0x41, 2]).toString('base64') }]);
    assert.equal((await f.tick('2026-08-19T10:04:00Z')).fired.length, 1);
    const state = JSON.parse((await f.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE command_id=?', [f.intent.command_id])).transport_json);
    assert.equal(state.queue_id, 'once-queue');
    assert.equal(state.phase, 'UNKNOWN', 'queue proof never rewrites a terminal transport phase');
    assert.equal(f.calls.enqueue, 1);
  });
}

for (const [label, other, queueId] of [
  ['recent UNKNOWN', { phase: 'UNKNOWN', attempted_at: '2026-08-19T10:03:00Z' }, 'new-queue'],
  ['UNKNOWN at the 24-hour boundary', { phase: 'UNKNOWN', attempted_at: '2026-08-18T10:03:00Z' }, 'new-queue'],
  ['old UNKNOWN with a live id', { phase: 'UNKNOWN', attempted_at: '2026-08-18T09:00:00Z', queue_id: 'old-live' }, 'old-live'],
]) {
  test(`runOnceTick queue proof still refuses ${label}`, async (t) => {
    const f = await uncertainOnceFixture(t);
    await insertOtherExpectation(f.db, f.deviceEui, 'other-owner', other);
    f.setQueue([{ id: queueId, fPort: 2, data: Buffer.from([0x41, 2]).toString('base64') }]);
    assert.equal((await f.tick('2026-08-19T10:04:00Z')).fired.length, 0);
    assert.equal(f.calls.enqueue, 1);
  });
}

test('a queue-confirmed UNKNOWN owns its id and does not block the next uncertain once open', async (t) => {
  const f = await uncertainOnceFixture(t);
  const firstTransport = JSON.parse(f.expectation.transport_json);
  f.setQueue([{ id: 'first-queue', fPort: 2, data: Buffer.from([0x41, 2]).toString('base64') }]);
  assert.equal((await f.tick('2026-08-19T10:04:00Z')).fired.length, 1);
  await store.insertSchedule(f.db, { schedule_uuid: 'second-once', device_eui: f.deviceEui, kind: 'ONCE', fire_at: '2026-08-19T10:05:00.000Z', duration_minutes: 2, timezone: 'UTC', enabled: 1 });
  await f.db.run("INSERT INTO valve_once_dispatch_intents(schedule_uuid,device_eui,command_id,state,attempted_at) VALUES (?,?,?,'UNKNOWN',?)", ['second-once', f.deviceEui, 'second-command', '2026-08-19T10:05:00Z']);
  await insertOtherExpectation(f.db, f.deviceEui, 'second-command', { ...firstTransport, attempted_at: '2026-08-19T10:05:00Z' });
  f.setQueue([{ id: 'first-queue', fPort: 2, data: Buffer.from([0x41, 2]).toString('base64') }, { id: 'second-queue', fPort: 2, data: Buffer.from([0x41, 2]).toString('base64') }]);
  assert.equal((await f.tick('2026-08-19T10:06:00Z')).fired.length, 1);
  const second = JSON.parse((await f.db.get("SELECT transport_json FROM valve_actuation_expectations WHERE command_id='second-command'")).transport_json);
  assert.equal(second.queue_id, 'second-queue');
  assert.equal(f.calls.enqueue, 1);
});

for (const source of ['actuator log', 'local physical run']) {
  test(`runOnceTick refuses late correction with another recorded open in the ${source}`, async (t) => {
    const f = await uncertainOnceFixture(t);
    await addUplinkHistory(f);
    await f.tick('2026-08-19T10:38:00.001Z');
    await recordOnceOpen(f, '2026-08-19T10:39:00Z');
    if (source === 'actuator log') await f.db.run("INSERT INTO actuator_log(deveui,irrigation_zone_id,action,duration_minutes,reason,created_at) SELECT deveui,irrigation_zone_id,'OPEN_FOR_DURATION',2,'manual_open','2026-08-19T10:20:00Z' FROM devices WHERE deveui=?", [f.deviceEui]);
    else await f.db.run("UPDATE valve_actuation_expectations SET trigger='service_action' WHERE command_id IS NULL AND device_eui=?", [f.deviceEui]);
    await f.tick('2026-08-19T10:39:01Z');
    assert.equal((await f.db.get('SELECT once_state FROM valve_schedules')).once_state, 'SKIPPED');
    assert.equal((await f.db.all("SELECT * FROM irrigation_events WHERE reason='one_time_open_confirmed_late'")).length, 0);
    assert.equal(f.calls.enqueue, 1);
  });
}

for (const evidence of ['observed_open_at', 'OBSERVED_RUNNING']) {
  test(`late correction reuses the command's ${evidence} at the inclusive window end`, async (t) => {
    const f = await uncertainOnceFixture(t);
    await addUplinkHistory(f);
    await f.tick('2026-08-19T10:38:00.001Z');
    const state = JSON.parse(f.expectation.transport_json);
    if (evidence === 'observed_open_at') await f.db.run('UPDATE valve_actuation_expectations SET observed_open_at=? WHERE command_id=?', ['2026-08-19T10:40:00Z', f.intent.command_id]);
    else {
      state.observation = { observed_at: '2026-08-19T10:40:00Z' };
      await f.db.run("UPDATE valve_actuation_expectations SET reconciliation_state='OBSERVED_RUNNING',transport_json=? WHERE command_id=?", [JSON.stringify(state), f.intent.command_id]);
    }
    await f.tick('2026-08-19T10:40:00Z');
    assert.equal((await f.db.get('SELECT once_state FROM valve_schedules')).once_state, 'FIRED');
    assert.equal((await f.db.all("SELECT * FROM irrigation_events WHERE reason='one_time_open_confirmed_late'")).length, 1);
    assert.equal(f.calls.enqueue, 1);
  });
}

test('expired uncertain skips open no correction transactions, and never enqueue again', async (t) => {
  const f = await uncertainOnceFixture(t);
  await addUplinkHistory(f);
  await f.tick('2026-08-19T10:38:00.001Z');
  await recordOnceOpen(f, '2026-08-19T10:39:00Z');
  let transactions = 0;
  const db = { ...f.db, transaction: async (fn) => { transactions++; return f.db.transaction(fn); } };
  await f.tick('2026-08-19T10:40:00.001Z', { db });
  await f.tick('2026-08-21T10:00:00Z', { db });
  assert.equal(transactions, 0);
  assert.equal(f.calls.enqueue, 1);
});

test('waiting deadlines use SQLite timestamp uplinks and exclude future rows before taking ten reports', async (t) => {
  const f = await uncertainOnceFixture(t);
  for (const at of [...uplinkHistory(15), ...uplinkHistory(1, 10, '2026-08-19T11:09:00Z')]) {
    await f.db.run('INSERT INTO device_data(deveui,recorded_at) VALUES (?,?)', [f.deviceEui, at.replace('T', ' ').replace('.000Z', '')]);
  }
  const [schedule] = await store.listSchedules(f.db, f.deviceEui, { now: new Date('2026-08-19T10:11:00Z') });
  assert.equal(schedule.awaiting_confirmation_until, '2026-08-19T10:38:00.000Z');
  assert.equal((await f.tick('2026-08-19T10:29:00Z')).skipped.length, 0);
  assert.equal(f.calls.enqueue, 1);
});

test('schedule listing returns the shared waiting deadline, uncertain outcome, and fired state after correction', async (t) => {
  const f = await uncertainOnceFixture(t);
  await addUplinkHistory(f);
  const list = (at) => store.listSchedules(f.db, f.deviceEui, { now: new Date(at) });
  let [schedule] = await list('2026-08-19T10:11:00Z');
  assert.equal(schedule.awaiting_confirmation_until, '2026-08-19T10:38:00.000Z');
  assert.equal(schedule.once_outcome, null);
  await f.tick('2026-08-19T10:38:00.001Z');
  [schedule] = await list('2026-08-19T10:39:00Z');
  assert.equal(schedule.awaiting_confirmation_until, null);
  assert.equal(schedule.once_outcome, 'uncertain');
  await recordOnceOpen(f, '2026-08-19T10:39:00Z');
  await f.tick('2026-08-19T10:39:01Z');
  [schedule] = await list('2026-08-19T10:39:02Z');
  assert.equal(schedule.once_state, 'FIRED');
  assert.equal(schedule.awaiting_confirmation_until, null);
  assert.equal(schedule.once_outcome, null);
  assert.equal(f.calls.enqueue, 1);
});

test('runOnceTick opens no transactions for SENT intents of fired schedules and still dispatches a pending schedule', async (t) => {
  const fixture = await tempDb();
  t.after(fixture.cleanup);
  const { db } = fixture;
  const deviceEui = 'A840410000000001';
  await db.run("INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at) VALUES (?,'Once Valve','STREGA_VALVE',1,datetime('now'),datetime('now'))", [deviceEui]);
  for (let n = 0; n < 8; n += 1) {
    await store.insertSchedule(db, { schedule_uuid: `fired-${n}`, device_eui: deviceEui, kind: 'ONCE', fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 2, timezone: 'UTC', enabled: 1 });
    await store.updateSchedule(db, `fired-${n}`, { once_state: 'FIRED' }, deviceEui);
    await db.run("INSERT INTO valve_once_dispatch_intents(schedule_uuid,device_eui,command_id,state) VALUES (?,?,?,'SENT')", [`fired-${n}`, deviceEui, `sent-command-${n}`]);
  }
  let transactions = 0;
  let enqueues = 0;
  const originalTransaction = db.transaction;
  db.transaction = (executor) => { transactions += 1; return originalTransaction(executor); };
  const transport = { async enqueueDownlink() { enqueues += 1; return { id: 'pending-queue' }; } };
  const claimed = [];
  const options = { db, transport, now: new Date('2026-08-19T10:04:00Z'), beforeAttempt: (intent) => claimed.push(intent.schedule_uuid), warn: () => {} };
  assert.deepEqual(await W.runOnceTick(options), { fired: [], skipped: [], transportFailures: [] });
  assert.equal(transactions, 0);
  await store.insertSchedule(db, { schedule_uuid: 'pending-due', device_eui: deviceEui, kind: 'ONCE', fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 2, timezone: 'UTC', enabled: 1 });
  const out = await W.runOnceTick({ ...options, trustedContext: controlledRuntime([Date.parse('2026-08-19T10:04:00Z')]) });
  assert.deepEqual(claimed, ['pending-due']);
  assert.equal(out.fired.length, 1);
  assert.equal(enqueues, 1);
  assert.ok(transactions > 0);
});

test('runOnceTick replays an accepted owner to finish interrupted bookkeeping exactly once', async () => {
  const { db } = await tempDb();
  await assignZone(db);
  await store.insertSchedule(db, { schedule_uuid: 'fix2-accepted-replay', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 2, timezone: 'UTC', enabled: 1 });
  let rpcCalls = 0;
  const transport = { async enqueueDownlink() { rpcCalls += 1; return { id: 'fix2-accepted-q1' }; } };
  const originalUpdateSchedule = store.updateSchedule;
  let failBookkeeping = true;
  store.updateSchedule = async function (...args) {
    if (failBookkeeping) { failBookkeeping = false; throw new Error('simulated bookkeeping crash'); }
    return originalUpdateSchedule.apply(this, args);
  };
  try {
    await assert.rejects(W.runOnceTick({ db, now: new Date('2026-08-19T10:03:00Z'), transport,
      trustedContext: controlledRuntime([Date.parse('2026-08-19T10:03:00Z'), Date.parse('2026-08-19T10:03:00Z')]), warn: () => {} }), /bookkeeping crash/);
  } finally {
    store.updateSchedule = originalUpdateSchedule;
  }
  assert.equal(rpcCalls, 1);
  assert.equal((await db.get("SELECT state FROM valve_once_dispatch_intents WHERE schedule_uuid='fix2-accepted-replay'")).state, 'ATTEMPTED');
  assert.equal((await db.get("SELECT once_state FROM valve_schedules WHERE schedule_uuid='fix2-accepted-replay'")).once_state, 'PENDING');
  const replay = await W.runOnceTick({ db, now: new Date('2026-08-19T10:04:00Z'), transport,
    trustedContext: controlledRuntime([Date.parse('2026-08-19T10:04:00Z'), Date.parse('2026-08-19T10:04:00Z')]), warn: () => {} });
  assert.equal(replay.fired.length, 1);
  assert.equal(rpcCalls, 1, 'accepted replay must not physically enqueue again');
  assert.equal((await db.get("SELECT once_state FROM valve_schedules WHERE schedule_uuid='fix2-accepted-replay'")).once_state, 'FIRED');
  assert.equal((await db.all("SELECT * FROM actuator_log WHERE reason='one_time_open:fix2-accepted-replay:2026-08-19T10:00:00.000Z'")).length, 1);
  assert.equal((await db.all("SELECT * FROM irrigation_events WHERE reason='one_time_open' AND payload_json LIKE '%fix2-accepted-replay%'")).length, 1);
  const again = await W.runOnceTick({ db, now: new Date('2026-08-19T10:05:00Z'), transport, warn: () => {} });
  assert.equal(again.fired.length, 0);
  assert.equal(rpcCalls, 1);
  assert.equal((await db.all("SELECT * FROM actuator_log WHERE reason='one_time_open:fix2-accepted-replay:2026-08-19T10:00:00.000Z'")).length, 1);
});

test('runOnceTick serializes overlapping actual transport ticks to one RPC and one audit', async () => {
  const { db } = await tempDb();
  await assignZone(db);
  await store.insertSchedule(db, { schedule_uuid: 'fix2-overlap', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 2, timezone: 'UTC', enabled: 1 });
  let rpcCalls = 0;
  const transport = { async enqueueDownlink() { rpcCalls += 1; await new Promise((resolve) => setTimeout(resolve, 15)); return { id: 'fix2-overlap-q1' }; } };
  const context = controlledRuntime([Date.parse('2026-08-19T10:03:00Z')]);
  const results = await Promise.all([
    W.runOnceTick({ db, now: new Date('2026-08-19T10:03:00Z'), transport, trustedContext: context, warn: () => {} }),
    W.runOnceTick({ db, now: new Date('2026-08-19T10:03:01Z'), transport, trustedContext: context, warn: () => {} }),
  ]);
  assert.equal(rpcCalls, 1);
  assert.equal(results[0].fired.length + results[1].fired.length, 1);
  assert.equal((await db.all("SELECT * FROM actuator_log WHERE reason='one_time_open:fix2-overlap:2026-08-19T10:00:00.000Z'")).length, 1);
  assert.equal((await db.all("SELECT * FROM irrigation_events WHERE reason='one_time_open' AND payload_json LIKE '%fix2-overlap%'")).length, 1);
});

test('runOnceTick reports one new fire across two live-shaped facades sharing one operation queue', async () => {
  const fixture = await tempDb();
  const shared = { tail: Promise.resolve() };
  const db1 = sharedQueueFacade(fixture.raw, shared);
  const db2 = sharedQueueFacade(fixture.raw, shared);
  await assignZone(db1);
  await store.insertSchedule(db1, { schedule_uuid: 'fix3-two-facades', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 2, timezone: 'UTC', enabled: 1 });
  let rpcCalls = 0;
  const transport = { async enqueueDownlink() { rpcCalls += 1; await new Promise((resolve) => setTimeout(resolve, 15)); return { id: 'fix3-two-facades-q1' }; } };
  const [first, second] = await Promise.all([
    W.runOnceTick({ db: db1, now: new Date('2026-08-19T10:03:00Z'), transport, trustedContext: controlledRuntime([Date.parse('2026-08-19T10:03:00Z')]), warn: () => {} }),
    W.runOnceTick({ db: db2, now: new Date('2026-08-19T10:03:01Z'), transport, trustedContext: controlledRuntime([Date.parse('2026-08-19T10:03:01Z')]), warn: () => {} }),
  ]);
  assert.equal(rpcCalls, 1);
  assert.equal(first.fired.length + second.fired.length, 1, 'only the durable acceptance transition reports a new fire');
  assert.equal((await db1.all("SELECT * FROM actuator_log WHERE reason='one_time_open:fix3-two-facades:2026-08-19T10:00:00.000Z'")).length, 1);
  assert.equal((await db1.all("SELECT * FROM irrigation_events WHERE reason='one_time_open' AND payload_json LIKE '%fix3-two-facades%'")).length, 1);
  fixture.cleanup();
});

test('runOnceTick finalizes a slow handoff as SENT after an overlapping tick marks it UNKNOWN', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'intent-slow-handoff', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  let resolveEmit;
  let emitted = 0;
  const first = W.runOnceTick({ db, now: new Date('2026-08-19T10:03:00Z'), emit: () => { emitted += 1; return new Promise((resolve) => { resolveEmit = resolve; }); }, warn: () => {} });
  while (!resolveEmit) await new Promise((resolve) => setImmediate(resolve));
  await W.runOnceTick({ db, now: new Date('2026-08-19T10:04:00Z'), warn: () => {} });
  assert.equal((await db.get("SELECT state FROM valve_once_dispatch_intents WHERE schedule_uuid='intent-slow-handoff'")).state, 'UNKNOWN');
  resolveEmit();
  await first;
  assert.equal((await db.get("SELECT state FROM valve_once_dispatch_intents WHERE schedule_uuid='intent-slow-handoff'")).state, 'SENT');
  assert.equal(emitted, 1);
});

test('runOnceTick rereads eligibility at claim and leaves a disabled schedule pending', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'claim-disabled', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  await db.run("INSERT INTO valve_once_dispatch_intents(schedule_uuid,device_eui,command_id,state) VALUES ('claim-disabled','0016C001F1000001','cmd-disabled','PENDING')");
  await db.run("UPDATE valve_schedules SET enabled=0 WHERE schedule_uuid='claim-disabled'");
  const r = await W.runOnceTick({ db, now: new Date('2026-08-19T10:03:00Z'), warn: () => {} });
  assert.equal(r.fired.length, 0);
  assert.equal((await db.get("SELECT state FROM valve_once_dispatch_intents WHERE schedule_uuid='claim-disabled'")).state, 'PENDING');
});

test('runOnceTick emits earlier claimed commands when a later row fails', async () => {
  const { db } = await tempDb();
  for (const uuid of ['claim-first', 'claim-second']) await store.insertSchedule(db, { schedule_uuid: uuid, device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  const emitted = [];
  const errors = [];
  const r = await W.runOnceTick({ db, now: new Date('2026-08-19T10:03:00Z'), emit: (command) => { if (command.schedule_uuid === 'claim-second') throw new Error('later row failed'); emitted.push(command.schedule_uuid); }, onError: (error) => errors.push(error.message), warn: () => {} });
  assert.deepEqual(emitted, ['claim-first']);
  assert.deepEqual(r.fired.map((row) => row.schedule_uuid), ['claim-first']);
  assert.deepEqual(errors, ['later row failed']);
  assert.equal((await db.get("SELECT state FROM valve_once_dispatch_intents WHERE schedule_uuid='claim-second'")).state, 'ATTEMPTED');
});

test('runOnceTick (I3) ignores PENDING ONCE rows on a soft-deleted device and leaves the row untouched', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'gone', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  // devices.deleted_at is always written as an ISO instant in production (flows.json writes
  // `new Date().toISOString()` throughout).
  await db.run("UPDATE devices SET deleted_at=? WHERE deveui='0016C001F1000001'", [new Date().toISOString()]);
  const r = await W.runOnceTick({ db, now: new Date('2026-08-19T10:03:00Z'), warn: () => {} });
  assert.equal(r.fired.length, 0);
  assert.equal(r.skipped.length, 0);
  const row = await db.get("SELECT once_state FROM valve_schedules WHERE schedule_uuid='gone'");
  assert.equal(row.once_state, 'PENDING');
});

test('runObserveTick recovers only durable explicit observation state', async () => {
  const { db } = await tempDb();
  // runObserveTick resolves local time via the device's irrigation zone timezone (d.zone_timezone),
  // not the schedule row's own timezone column, so the device must be assigned to a zone with the
  // matching IANA timezone for the window-hit check below to use Europe/Zurich local time.
  await db.run("INSERT INTO irrigation_zones(name, user_id, timezone) VALUES ('Zone Z', 1, 'Europe/Zurich')");
  const zone = await db.get("SELECT id FROM irrigation_zones WHERE name='Zone Z'");
  await db.run('UPDATE devices SET irrigation_zone_id=? WHERE deveui=?', [zone.id, '0016C001F1000001']);
  // valve reports OPEN at 06:10 local (Europe/Zurich) on a Wednesday; window Wed 06:00-06:30 exists
  await store.insertSchedule(db, { schedule_uuid: 'w', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: 'Morning', weekdays_mask: 1 << 3, start_time: '06:00', duration_minutes: 30, timezone: 'Europe/Zurich', enabled: 1 });
  await db.run("UPDATE devices SET current_state='OPEN' WHERE deveui='0016C001F1000001'");
  await db.run("INSERT INTO device_data(deveui, recorded_at) VALUES ('0016C001F1000001','2026-08-19T04:10:00.000Z')");
  const r = await W.runObserveTick({ db, now: new Date('2026-08-19T04:10:30Z'), warn: () => {} });
  assert.equal(r.created, 0);
  assert.equal((await db.get("SELECT COUNT(*) AS count FROM valve_actuation_expectations WHERE device_eui='0016C001F1000001'")).count, 0);
  assert.equal((await W.runObserveTick({ db, now: new Date('2026-08-19T04:11:30Z'), warn: () => {} })).created, 0);
});

test('runObserveTick does not emit runtime state from generic current_state', async () => {
  const { db } = await tempDb();
  await linkCloud(db);
  await db.run("UPDATE devices SET current_state='OPEN' WHERE deveui='0016C001F1000001'");
  await db.run("INSERT INTO device_data(deveui, recorded_at) VALUES ('0016C001F1000001','2026-08-19T15:00:00.000Z')");
  await W.runObserveTick({ db, now: new Date('2026-08-19T15:00:30Z'), warn: () => {} });
  const rows = await db.all("SELECT op, aggregate_key FROM sync_outbox WHERE op='VALVE_RUNTIME_CHANGED'");
  assert.equal(rows.length, 0);
});

test('runObserveTick: OPEN outside any window remains unresolved without a durable report', async () => {
  const { db } = await tempDb();
  await db.run("UPDATE devices SET current_state='OPEN' WHERE deveui='0016C001F1000001'");
  await db.run("INSERT INTO device_data(deveui, recorded_at) VALUES ('0016C001F1000001','2026-08-19T15:00:00.000Z')");
  await W.runObserveTick({ db, now: new Date('2026-08-19T15:00:30Z'), warn: () => {} });
  assert.equal((await db.get("SELECT COUNT(*) AS count FROM valve_actuation_expectations WHERE device_eui='0016C001F1000001'")).count, 0);
});

test('runObserveTick ignores service logs without an explicit report watermark', async () => {
  const { db } = await tempDb();
  // Task 4's actuator_log write composes 'SET_PARTIAL_OPENING <pct>%' - assert the classifier
  // matches on the stable command prefix, not the percentage suffix.
  await db.run("INSERT INTO actuator_log(deveui, action, created_at) VALUES ('0016C001F1000001','SET_PARTIAL_OPENING 40%','2026-08-19T14:58:00.000Z')");
  await db.run("UPDATE devices SET current_state='OPEN' WHERE deveui='0016C001F1000001'");
  await db.run("INSERT INTO device_data(deveui, recorded_at) VALUES ('0016C001F1000001','2026-08-19T15:00:00.000Z')");
  await W.runObserveTick({ db, now: new Date('2026-08-19T15:00:30Z'), warn: () => {} });
  assert.equal((await db.get("SELECT COUNT(*) AS count FROM valve_actuation_expectations WHERE device_eui='0016C001F1000001'")).count, 0);
});

test('runObserveTick ignores flushing logs without an explicit report watermark', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO actuator_log(deveui, action, created_at) VALUES ('0016C001F1000001','SET_FLUSHING 40% -> OPEN','2026-08-19T14:59:00.000Z')");
  await db.run("UPDATE devices SET current_state='OPEN' WHERE deveui='0016C001F1000001'");
  await db.run("INSERT INTO device_data(deveui, recorded_at) VALUES ('0016C001F1000001','2026-08-19T15:00:00.000Z')");
  await W.runObserveTick({ db, now: new Date('2026-08-19T15:00:30Z'), warn: () => {} });
  assert.equal((await db.get("SELECT COUNT(*) AS count FROM valve_actuation_expectations WHERE device_eui='0016C001F1000001'")).count, 0);
});

test('runObserveTick ignores stale service logs without an explicit report watermark', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO actuator_log(deveui, action, created_at) VALUES ('0016C001F1000001','SET_PARTIAL_OPENING 40%','2026-08-18T14:00:00.000Z')");
  await db.run("UPDATE devices SET current_state='OPEN' WHERE deveui='0016C001F1000001'");
  await db.run("INSERT INTO device_data(deveui, recorded_at) VALUES ('0016C001F1000001','2026-08-19T15:00:00.000Z')");
  await W.runObserveTick({ db, now: new Date('2026-08-19T15:00:30Z'), warn: () => {} });
  assert.equal((await db.get("SELECT COUNT(*) AS count FROM valve_actuation_expectations WHERE device_eui='0016C001F1000001'")).count, 0);
});

test('runObserveTick ignores unrelated actuator logs without an explicit report watermark', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO actuator_log(deveui, action, created_at) VALUES ('0016C001F1000001','OPEN_FOR_DURATION','2026-08-19T14:59:00.000Z')");
  await db.run("UPDATE devices SET current_state='OPEN' WHERE deveui='0016C001F1000001'");
  await db.run("INSERT INTO device_data(deveui, recorded_at) VALUES ('0016C001F1000001','2026-08-19T15:00:00.000Z')");
  await W.runObserveTick({ db, now: new Date('2026-08-19T15:00:30Z'), warn: () => {} });
  assert.equal((await db.get("SELECT COUNT(*) AS count FROM valve_actuation_expectations WHERE device_eui='0016C001F1000001'")).count, 0);
});

test('runObserveTick preserves a stale durable observation without creating a duplicate', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, trigger, created_at) VALUES ('stale1','0016C001F1000001','2026-08-19T04:00:00.000Z',1800,'2026-08-19T04:30:00.000Z','unknown','STALE_OPEN_OBSERVED','on_valve_schedule','2026-08-19T04:00:00.000Z')");
  await db.run("UPDATE devices SET current_state='OPEN' WHERE deveui='0016C001F1000001'");
  await db.run("INSERT INTO device_data(deveui, recorded_at) VALUES ('0016C001F1000001','2026-08-19T04:40:00.000Z')");
  const r = await W.runObserveTick({ db, now: new Date('2026-08-19T04:40:30Z'), warn: () => {} });
  assert.equal(r.created, 0);
  assert.equal((await db.get("SELECT COUNT(*) AS count FROM valve_actuation_expectations WHERE device_eui='0016C001F1000001'")).count, 1);
});

test('runObserveTick does not use zone or gateway schedule windows as observation authority', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO app_settings(key, value) VALUES ('gateway_timezone', 'UTC')");
  await db.run("INSERT INTO irrigation_zones(name, user_id, timezone) VALUES ('Zone Z', 1, 'Europe/Zurich')");
  const zone = await db.get("SELECT id FROM irrigation_zones WHERE name='Zone Z'");
  await db.run('UPDATE devices SET irrigation_zone_id=? WHERE deveui=?', [zone.id, '0016C001F1000001']);
  await store.insertSchedule(db, { schedule_uuid: 'w', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 1 << 3, start_time: '06:00', duration_minutes: 30, timezone: 'Europe/Zurich', enabled: 1 });
  await db.run("UPDATE devices SET current_state='OPEN' WHERE deveui='0016C001F1000001'");
  await db.run("INSERT INTO device_data(deveui, recorded_at) VALUES ('0016C001F1000001','2026-08-19T04:10:00.000Z')");
  const r = await W.runObserveTick({ db, now: new Date('2026-08-19T04:10:30Z'), warn: () => {} });
  assert.equal(r.created, 0);
  assert.equal((await db.get("SELECT COUNT(*) AS count FROM valve_actuation_expectations WHERE device_eui='0016C001F1000001'")).count, 0);
});

test('runObserveTick does not use gateway timezone as observation authority', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO app_settings(key, value) VALUES ('gateway_timezone', 'Europe/Zurich')");
  // device is left zoneless (no irrigation_zone_id) — the default shape from tempDb().
  await store.insertSchedule(db, { schedule_uuid: 'w', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 1 << 3, start_time: '06:00', duration_minutes: 30, timezone: 'Europe/Zurich', enabled: 1 });
  await db.run("UPDATE devices SET current_state='OPEN' WHERE deveui='0016C001F1000001'");
  await db.run("INSERT INTO device_data(deveui, recorded_at) VALUES ('0016C001F1000001','2026-08-19T04:10:00.000Z')");
  const r = await W.runObserveTick({ db, now: new Date('2026-08-19T04:10:30Z'), warn: () => {} });
  assert.equal(r.created, 0);
  assert.equal((await db.get("SELECT COUNT(*) AS count FROM valve_actuation_expectations WHERE device_eui='0016C001F1000001'")).count, 0);
});

test('runObserveTick does not use UTC schedule windows as observation authority', async () => {
  const { db } = await tempDb();
  // No app_settings row at all: getGatewaySetting must return null (table exists, key absent),
  // not throw, leaving 'UTC' as the final fallback.
  await store.insertSchedule(db, { schedule_uuid: 'w', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 1 << 3, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  await db.run("UPDATE devices SET current_state='OPEN' WHERE deveui='0016C001F1000001'");
  await db.run("INSERT INTO device_data(deveui, recorded_at) VALUES ('0016C001F1000001','2026-08-19T06:10:00.000Z')");
  const r = await W.runObserveTick({ db, now: new Date('2026-08-19T06:10:30Z'), warn: () => {} });
  assert.equal(r.created, 0);
  assert.equal((await db.get("SELECT COUNT(*) AS count FROM valve_actuation_expectations WHERE device_eui='0016C001F1000001'")).count, 0);
});

test('runClockTick queues a weekly GEN1 clock push and fails >24h queued pushes', async () => {
  const { db } = await tempDb();
  // runClockTick only considers valves with at least one active schedule (its valves query joins
  // on EXISTS valve_schedules); without this the device is invisible to the tick.
  await store.insertSchedule(db, { schedule_uuid: 's1', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  await store.upsertSettings(db, '0016C001F1000001', { last_clock_sync_queued_at: '2026-08-01T00:00:00.000Z' });
  await store.insertPushes(db, [{ push_id: 'stale', device_eui: '0016C001F1000001', purpose: 'WEEKDAY_PLAN', weekday: 0, fport: 14, payload_hex: 'FF'.repeat(24), plan_hash: 'h' }]);
  // queued_at is backdated with SQLite datetime() arithmetic from the suite's own FIXED clock
  // (not the real 'now') so this stays deterministic forever — using real wall-clock 'now' here
  // made the assertion below true only while the real clock was within 48h of 2026-08-19T10:00Z,
  // and would have inverted permanently once that window passed. The space-separated output of
  // datetime() still matches how failStalePushes' own comparison reads this column (see store.test.js C2).
  await db.run("UPDATE valve_schedule_pushes SET queued_at = datetime('2026-08-19 10:00:00', '-3 days') WHERE push_id='stale'");
  const r = await W.runClockTick({ db, now: new Date('2026-08-19T10:00:00Z'), appId: 'app', warn: () => {} });
  assert.equal(r.messages.length, 1); assert.equal(r.messages[0].payload.fPort, 12);
  assert.equal((await db.get("SELECT state FROM valve_schedule_pushes WHERE push_id='stale'")).state, 'FAILED');
});

test('runClockTick does not create a fresh clock owner after an UNKNOWN enqueue', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'clock-unknown', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  await store.upsertSettings(db, '0016C001F1000001', { last_clock_sync_queued_at: '2026-08-01T00:00:00.000Z' });
  let enqueues = 0;
  const transport = { async enqueueDownlink() { enqueues += 1; throw new Error('ambiguous gateway timeout'); } };
  const first = await W.runClockTick({ db, now: new Date('2026-08-19T10:00:00Z'), appId: 'app', transport, warn: () => {} });
  const second = await W.runClockTick({ db, now: new Date('2026-08-19T10:10:00Z'), appId: 'app', transport, warn: () => {} });
  assert.equal(first.transportFailures[0].phase, 'UNKNOWN');
  assert.equal(second.transportFailures.length, 1);
  assert.equal(enqueues, 1, 'an ambiguous clock attempt must not be retried under a fresh owner');
  const rows = await db.all("SELECT push_id, state, transport_json FROM valve_schedule_pushes WHERE purpose='CLOCK_SYNC'");
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].transport_json).phase, 'UNKNOWN');
  db.close();
});

// P3-E1 review fix (IMPORTANT 1): failStalePushes flips QUEUED -> FAILED fleet-wide with no
// emission of its own -- without the pre-SELECT + per-device emit in runClockTick, the cloud
// would show this valve's plan as permanently "queued" even after the edge gave up on it.
test('runClockTick (P3-E1) emits VALVE_RUNTIME_CHANGED for a device whose WEEKDAY_PLAN push just aged out unacked, on a linked gateway; not for one whose stale push is CLOCK_SYNC-only', async () => {
  const { db } = await tempDb();
  await linkCloud(db);
  await store.insertSchedule(db, { schedule_uuid: 's1', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1 });
  await store.upsertSettings(db, '0016C001F1000001', { last_clock_sync_queued_at: '2026-08-01T00:00:00.000Z' });
  await store.insertPushes(db, [{ push_id: 'stale-plan', device_eui: '0016C001F1000001', purpose: 'WEEKDAY_PLAN', weekday: 0, fport: 14, payload_hex: 'FF'.repeat(24), plan_hash: 'h' }]);
  await db.run("UPDATE valve_schedule_pushes SET queued_at = datetime('2026-08-19 10:00:00', '-3 days') WHERE push_id='stale-plan'");

  await W.runClockTick({ db, now: new Date('2026-08-19T10:00:00Z'), appId: 'app', warn: () => {} });

  const rows = await db.all("SELECT op, aggregate_key FROM sync_outbox WHERE op='VALVE_RUNTIME_CHANGED'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].aggregate_key, '0016C001F1000001');
  const payload = JSON.parse((await db.get("SELECT payload_json FROM sync_outbox WHERE op='VALVE_RUNTIME_CHANGED'")).payload_json);
  assert.equal(payload.push_state.failed, 1, 'the snapshot must reflect the just-failed push');
});

test('runClockTick (I2) uses the schedule timezone, not the zone timezone, for the FPort 12 wall-clock payload', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO irrigation_zones(name, user_id, timezone) VALUES ('Zone UTC', 1, 'UTC')");
  const zone = await db.get("SELECT id FROM irrigation_zones WHERE name='Zone UTC'");
  await db.run('UPDATE devices SET irrigation_zone_id=? WHERE deveui=?', [zone.id, '0016C001F1000001']);
  await store.insertSchedule(db, { schedule_uuid: 'w', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, timezone: 'Europe/Zurich', enabled: 1 });
  const now = new Date('2026-08-19T10:00:00Z');
  const r = await W.runClockTick({ db, now, appId: 'app', warn: () => {} });
  assert.equal(r.messages.length, 1);
  const msg = r.messages[0];
  assert.equal(msg.payload.fPort, 12);
  const expected = P.gen1ClockPayload(now, 'Europe/Zurich').toString('base64');
  assert.equal(msg.payload.data, expected, 'must encode Europe/Zurich wall clock, not UTC (the zone tz)');
});

test('runHousekeeping resets SKIP_TODAY once the valve local date has moved past skip_today_date', async () => {
  const { db } = await tempDb();
  W._resetHousekeepingForTests();
  await store.upsertSettings(db, '0016C001F1000001', { scheduler_status: 'SKIP_TODAY', skip_today_date: '2026-08-19' });
  const same = await W.runHousekeeping({ db, now: new Date('2026-08-19T12:00:00Z'), appId: 'app', warn: () => {} });
  assert.equal(same.resets, 0);
  assert.equal((await store.getSettings(db, '0016C001F1000001')).scheduler_status, 'SKIP_TODAY');
  const next = await W.runHousekeeping({ db, now: new Date('2026-08-20T00:30:00Z'), appId: 'app', warn: () => {} });
  assert.equal(next.resets, 1);
  const s = await store.getSettings(db, '0016C001F1000001');
  assert.equal(s.scheduler_status, 'ACTIVE');
  assert.equal(s.skip_today_date, null);
});

test('runHousekeeping (C1) clock-jump detector tolerates the real 10-min tick cadence and only trips on a backward jump or a >6h forward gap', async () => {
  const { db } = await tempDb();
  W._resetHousekeepingForTests();
  const t0 = new Date('2026-08-19T10:00:00Z');
  const t1 = new Date('2026-08-19T10:10:00Z'); // +10 min: the real production tick period
  const r0 = await W.runHousekeeping({ db, now: t0, appId: 'app', warn: () => {} });
  assert.equal(r0.clockJump, false, 'first tick ever: nothing to compare against');
  const r1 = await W.runHousekeeping({ db, now: t1, appId: 'app', warn: () => {} });
  assert.equal(r1.clockJump, false, 'consecutive 10-min ticks must never trip the detector');
  const forward = new Date(t1.getTime() + 7 * 3600000);
  const r2 = await W.runHousekeeping({ db, now: forward, appId: 'app', warn: () => {} });
  assert.equal(r2.clockJump, true, 'a 7h forward gap exceeds any normal tick delay');
  const backward = new Date(forward.getTime() - 2 * 60000);
  const r3 = await W.runHousekeeping({ db, now: backward, appId: 'app', warn: () => {} });
  assert.equal(r3.clockJump, true, 'now moving 2min before the last tick is a backward jump');
});

test('runHousekeeping decommission sweep: soft-deleted device with an ACKED non-empty plan gets 7 empty pushes + FPort 21 "2"; second run is a no-op', async () => {
  const { db } = await tempDb();
  W._resetHousekeepingForTests();
  await store.insertPushes(db, [{ push_id: 'acked1', device_eui: '0016C001F1000001', purpose: 'WEEKDAY_PLAN', weekday: 2, fport: 16, payload_hex: '00'.repeat(24), plan_hash: 'a-real-plan-hash' }]);
  await db.run("UPDATE valve_schedule_pushes SET state='ACKED' WHERE push_id='acked1'");
  // deleted_at must be ISO on the SAME calendar day the sweep runs (not a fixed past-date
  // literal): the sweep's own newly-queued pushes get queued_at from the DB's datetime('now')
  // default (space-separated), so a deleted_at from a prior day would let the date portion
  // alone mask the 'T' vs ' ' string-comparison bug this test is meant to catch (C4). Backdated
  // a couple seconds (not exactly "now") only so this test's own deleted_at write and the
  // sweep's queued_at write can't land in the SAME whole second — SQLite's datetime() has
  // 1-second resolution, so an exact tie there would read as "not yet swept" on a technicality
  // that never happens in production (housekeeping ticks run 10 minutes apart, never in the
  // same second a device was just soft-deleted).
  const deletedAtIso = new Date(Date.now() - 2000).toISOString();
  await db.run("UPDATE devices SET deleted_at=? WHERE deveui='0016C001F1000001'", [deletedAtIso]);
  const now = new Date();
  const r1 = await W.runHousekeeping({ db, now, appId: 'app', warn: () => {} });
  assert.equal(r1.decommissioned, 1);
  assert.equal(r1.messages.length, 8);
  const weekdayMsgs = r1.messages.filter((m) => m.payload.fPort >= 14 && m.payload.fPort <= 20);
  assert.equal(weekdayMsgs.length, 7);
  const statusMsgs = r1.messages.filter((m) => m.payload.fPort === 21);
  assert.equal(statusMsgs.length, 1);
  assert.equal(Buffer.from(statusMsgs[0].payload.data, 'base64').toString('ascii'), '2');
  const r2 = await W.runHousekeeping({ db, now: new Date(now.getTime() + 3600000), appId: 'app', warn: () => {} });
  assert.equal(r2.decommissioned, 0);
  assert.equal(r2.messages.length, 0);
});

test('runTriggerBackfill: an actuator_log scheduler_ reason within +/-2 min -> trigger_based', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, created_at) VALUES ('e1','0016C001F1000001','2026-08-19T06:00:00.000Z',900,'2026-08-19T06:15:00.000Z','unknown','2026-08-19T06:00:00.000Z')");
  // actuator_log.created_at is ALWAYS written as an ISO instant in production (both writers in
  // flows.json use `new Date().toISOString()`; there is no code path that writes the DB's
  // space-separated datetime('now') form to this column), so the regression test must too.
  await db.run("INSERT INTO actuator_log(deveui, action, reason, created_at) VALUES ('0016C001F1000001','OPEN','scheduler_threshold','2026-08-19T06:01:00.000Z')");
  const r = await W.runTriggerBackfill({ db, warn: () => {} });
  assert.equal(r.updated, 1);
  assert.equal((await db.get("SELECT trigger FROM valve_actuation_expectations WHERE expectation_id='e1'")).trigger, 'trigger_based');
});

test('runTriggerBackfill: no evidence at all -> manual', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, created_at) VALUES ('e2','0016C001F1000001','2026-08-19T06:00:00.000Z',900,'2026-08-19T06:15:00.000Z','unknown','2026-08-19T06:00:00.000Z')");
  const r = await W.runTriggerBackfill({ db, warn: () => {} });
  assert.equal(r.updated, 1);
  assert.equal((await db.get("SELECT trigger FROM valve_actuation_expectations WHERE expectation_id='e2'")).trigger, 'manual');
});

test('runTriggerBackfill: command_id present in a one_time_open irrigation_events payload -> one_time', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO irrigation_zones(name, user_id) VALUES ('Zone A', 1)");
  const zone = await db.get("SELECT id FROM irrigation_zones WHERE name='Zone A'");
  await db.run("INSERT INTO irrigation_events(user_id, irrigation_zone_id, action, reason, duration_minutes, valve_deveui, payload_json, created_at) VALUES (1, ?, 'IRRIGATE', 'one_time_open', 20, '0016C001F1000001', ?, '2026-08-19T06:00:00.000Z')", [zone.id, JSON.stringify({ command_id: 'cmd-123' })]);
  await db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, created_at) VALUES ('e3','0016C001F1000001','cmd-123','2026-08-19T06:00:00.000Z',900,'2026-08-19T06:15:00.000Z','unknown','2026-08-19T06:00:00.000Z')");
  const r = await W.runTriggerBackfill({ db, warn: () => {} });
  assert.equal(r.updated, 1);
  assert.equal((await db.get("SELECT trigger FROM valve_actuation_expectations WHERE expectation_id='e3'")).trigger, 'one_time');
});

test('runTriggerBackfill: unknown-volume row backfilled from zone calibration flow rate (12.5 L/min x 1800s -> 375 L)', async () => {
  const { db } = await tempDb();
  await db.run("INSERT INTO irrigation_zones(name, user_id) VALUES ('Zone B', 1)");
  const zone = await db.get("SELECT id FROM irrigation_zones WHERE name='Zone B'");
  await db.run("INSERT INTO zone_irrigation_calibration(zone_id, measured_flow_rate_lpm, measurement_method, measured_at, created_at, updated_at) VALUES (?, 12.5, 'meter', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')", [zone.id]);
  await db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, zone_id, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, trigger, created_at) VALUES ('e4','0016C001F1000001', ?, '2026-08-19T06:00:00.000Z',1800,'2026-08-19T06:32:00.000Z','unknown','OBSERVED_RUNNING','on_valve_schedule','2026-08-19T06:00:00.000Z')", [zone.id]);
  await W.runTriggerBackfill({ db, warn: () => {} });
  const row = await db.get("SELECT flow_rate_lpm, flow_rate_source, estimated_gross_liters, volume_source FROM valve_actuation_expectations WHERE expectation_id='e4'");
  assert.equal(row.flow_rate_lpm, 12.5);
  assert.equal(row.flow_rate_source, 'zone_calibration');
  assert.equal(row.estimated_gross_liters, 375);
  assert.equal(row.volume_source, 'estimated_duration_flow_rate');
});

// cloud full-parity Task P4-E1 review fix (Important 2): the volume-backfill loop above
// mutates estimated_gross_liters on ALREADY-TERMINAL rows with no state filter -- a shipped
// VALVE_ACTUATION_ARCHIVED payload can be carrying the stale 'unknown' figure. This pins that a
// correction to an already-archived row re-emits with the corrected liters.
test('runTriggerBackfill: a volume correction on an already-terminal (archived) row re-emits VALVE_ACTUATION_ARCHIVED with the corrected liters', async () => {
  const { db } = await tempDb();
  await linkCloud(db);
  await db.run("INSERT INTO irrigation_zones(name, user_id) VALUES ('Zone B', 1)");
  const zone = await db.get("SELECT id FROM irrigation_zones WHERE name='Zone B'");
  await db.run("INSERT INTO zone_irrigation_calibration(zone_id, measured_flow_rate_lpm, measurement_method, measured_at, created_at, updated_at) VALUES (?, 12.5, 'meter', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')", [zone.id]);
  await db.run(
    "INSERT INTO valve_actuation_expectations(expectation_id, device_eui, zone_id, commanded_at, commanded_duration_seconds, expected_close_at, observed_open_at, observed_close_at, volume_source, reconciliation_state, trigger, created_at) " +
    "VALUES ('e5','0016C001F1000001', ?, '2026-08-19T06:00:00.000Z',1800,'2026-08-19T06:32:00.000Z','2026-08-19T06:00:05.000Z','2026-08-19T06:30:03.000Z','unknown','OBSERVED_COMPLETE','on_valve_schedule','2026-08-19T06:00:00.000Z')",
    [zone.id]
  );

  await W.runTriggerBackfill({ db, warn: () => {} });

  const rows = await db.all("SELECT op, aggregate_key, payload_json FROM sync_outbox WHERE op='VALVE_ACTUATION_ARCHIVED' AND aggregate_key='e5'");
  assert.equal(rows.length, 1, 'the correction must re-emit an archive event for the touched expectation');
  const payload = JSON.parse(rows[0].payload_json);
  assert.equal(payload.status, 'COMPLETED');
  assert.equal(payload.estimated_gross_liters, 375, 'the payload must carry the CORRECTED liters, not the stale unknown-volume value it archived with originally');
  assert.equal(payload.volume_source, 'estimated_duration_flow_rate');
});

test('runTriggerBackfill: a trigger correction on an already-terminal (archived) row also re-emits VALVE_ACTUATION_ARCHIVED (trigger is part of the payload too)', async () => {
  const { db } = await tempDb();
  await linkCloud(db);
  await db.run(
    "INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, observed_open_at, observed_close_at, volume_source, reconciliation_state, trigger, created_at) " +
    "VALUES ('e6','0016C001F1000001','2026-08-19T06:00:00.000Z',900,'2026-08-19T06:15:00.000Z','2026-08-19T06:00:05.000Z','2026-08-19T06:15:03.000Z','unknown','OBSERVED_COMPLETE',NULL,'2026-08-19T06:00:00.000Z')"
  );

  await W.runTriggerBackfill({ db, warn: () => {} });

  const rows = await db.all("SELECT payload_json FROM sync_outbox WHERE op='VALVE_ACTUATION_ARCHIVED' AND aggregate_key='e6'");
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].payload_json).trigger, 'manual');
});

test('runOnceTick exposes an UNKNOWN transport result without counting the command as fired', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'transport-unknown', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  const errors = [];
  const out = await W.runOnceTick({
    db, now: new Date('2026-08-19T10:03:00Z'),
    transport: { async enqueueDownlink() { throw new Error('delayed gateway timeout'); } },
    trustedContext: controlledRuntime([Date.parse('2026-08-19T10:03:00Z')]),
    onError: (error) => errors.push(error), warn: () => {},
  });
  assert.equal(out.fired.length, 0);
  assert.equal(out.transportFailures.length, 1);
  assert.equal(out.transportFailures[0].phase, 'UNKNOWN');
  assert.equal(errors.length, 1);
  assert.equal((await db.get("SELECT state FROM valve_once_dispatch_intents WHERE schedule_uuid='transport-unknown'")).state, 'UNKNOWN');
});

// Night-run conformance fix (B-2): an ACK the superseded fixed plan may own does not make the
// conditional clear READY through the real uplink path.
test('handleUplink: an ambiguous GEN2 ACK leaves conditional readiness PENDING', async () => {
  const { db } = await tempDb();
  const eui = (await db.get("SELECT deveui FROM devices WHERE type_id='STREGA_VALVE' LIMIT 1")).deveui;
  await store.upsertSettings(db, eui, { strega_generation: 'GEN2' });
  await db.run("INSERT INTO valve_schedule_pushes(push_id, device_eui, purpose, weekday, fport, payload_hex, plan_hash, state, transport_json) VALUES ('A', ?, 'DAYMASK_PLAN', NULL, 25, '0299151930', 'h-A', 'SUPERSEDED', ?)",
    [eui, JSON.stringify({ phase: 'UNKNOWN', queue_id: 'q-A', attempted_at: '2026-10-19T08:00:00.000Z', invalidated_by_flush: 'f1' })]);
  await db.run("INSERT INTO valve_schedule_pushes(push_id, device_eui, purpose, weekday, fport, payload_hex, plan_hash, state, transport_json) VALUES ('C', ?, 'DAYMASK_PLAN', NULL, 25, '80', 'h-C', 'QUEUED', ?)",
    [eui, JSON.stringify({ phase: 'ACCEPTED', queue_id: 'q-C', attempted_at: '2026-10-19T08:05:00.000Z' })]);
  await store.writeConditionalControl(db, eui, { mode: 'CONDITIONAL', generation: 'GEN2', desired_revision: 'rev-1', required_push_ids: ['C'], predecessor_push_ids: ['A'],
    readiness: { state: 'PENDING', revision: 'rev-1', reason: 'awaiting_clear_ack' }, flushes: [{ flush_id: 'f1', status: 'COMPLETE', captured_snapshot: [] }] });
  const out = await W.handleUplink({ db, deviceEui: eui, decoded: { Ack_Port: 25, Ack_Value: 1 }, fPort: 2, receivedAt: '2026-10-19T08:06:00.000Z', warn: () => {} });
  assert.equal(out.acked, 0);
  assert.equal(out.readiness.ready, false);
  assert.equal((await store.conditionalControl(db, eui)).readiness.state, 'PENDING');
  db.close();
});

// W29 F1: the ONCE inject (every 60 s) builds its ChirpStack client lazily, only when a one-time
// open is actually dispatched, and closes it, also after a failure. Before, liveValveOnce built a
// client on every run and never closed it.
test('F1: runOnceTickLazy builds the ChirpStack client only when a ONCE dispatch is due and closes it', async () => {
  // dispatch checks the attempt against the runtime clock, so the fixture follows the real clock.
  const base = Date.now();
  const iso = (min) => new Date(base + min * 60000).toISOString();
  const { db } = await tempDb();
  const stats = { created: 0, closed: 0, enqueued: 0 };
  const factory = (behaviour) => () => {
    stats.created += 1;
    return {
      async getDeviceQueue() { return []; },
      async flushDeviceQueue() {},
      async enqueueDownlink() { stats.enqueued += 1; if (behaviour === 'fail') throw new Error('unavailable'); return { id: 'once-q-' + stats.enqueued }; },
      close() { stats.closed += 1; return []; },
    };
  };
  await W.runOnceTickLazy({ db, now: new Date(iso(0)), warn: () => {}, transportFactory: factory() });
  assert.deepEqual({ created: stats.created, closed: stats.closed }, { created: 0, closed: 0 }, 'nothing due: no client');
  await store.insertSchedule(db, { schedule_uuid: 'f1-future', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: iso(60), duration_minutes: 5, timezone: 'UTC', enabled: 1 });
  await W.runOnceTickLazy({ db, now: new Date(iso(0)), warn: () => {}, transportFactory: factory() });
  assert.equal(stats.created, 0, 'a ONCE that is not due yet: no client');
  await db.run("UPDATE valve_schedules SET fire_at=? WHERE schedule_uuid='f1-future'", [iso(-1)]);
  const due = await W.runOnceTickLazy({ db, now: new Date(iso(0)), warn: () => {}, transportFactory: factory(), trustedContext: controlledRuntime([Date.parse(iso(0)), Date.parse(iso(0))]) });
  assert.equal(due.fired.length, 1);
  assert.deepEqual({ created: stats.created, closed: stats.closed, enqueued: stats.enqueued }, { created: 1, closed: 1, enqueued: 1 });
  const second = await tempDb();
  await store.insertSchedule(second.db, { schedule_uuid: 'f1-fail', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: iso(-1), duration_minutes: 5, timezone: 'UTC', enabled: 1 });
  await W.runOnceTickLazy({ db: second.db, now: new Date(iso(0)), warn: () => {}, transportFactory: factory('fail'), trustedContext: controlledRuntime([Date.parse(iso(0)), Date.parse(iso(0))]) }).catch(() => null);
  assert.deepEqual({ created: stats.created, closed: stats.closed }, { created: 2, closed: 2 }, 'closed after a failure too');
});
