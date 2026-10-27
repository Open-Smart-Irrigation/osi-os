'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { tempDb } = require('./test-helpers');
const store = require('./store');
const push = require('./push');
const dispatch = require('./dispatch');
const { applyCloudCommand } = require('./cloud-commands');
const { handleHttpRequest } = require('./api');
const { DatabaseSync } = require('node:sqlite');
const { facade } = require('./test-helpers');

const EUI = '0016C001F1000001';
const NOW = '2026-10-19T12:00:00.000Z';

function TestDatabase(dbPath) { return facade(new DatabaseSync(dbPath)); }

function token(userId) {
  const payload = Buffer.from(JSON.stringify({ userId, username: 'u', exp: Date.now() + 60000 })).toString('base64url');
  return 'Bearer ' + payload + '.' + crypto.createHmac('sha256', 'test-secret').update(payload).digest('base64url');
}

function apiRequest(method, url, body) {
  return { req: { method, url, headers: { authorization: token(1) }, body, params: {} }, payload: body };
}

async function lifecycleBinding(db, generation = 'GEN1') {
  await db.run("INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, timezone) VALUES (42, 'Zone A', 1, 'zone-42', 'UTC')");
  await db.run("INSERT INTO irrigation_policies(policy_uuid, zone_uuid, condition_json, timezone, enabled, sync_version, deleted_at) VALUES ('policy-42', 'zone-42', '{}', 'UTC', 0, 3, '2026-10-19T11:00:00.000Z')");
  await db.run("UPDATE devices SET irrigation_zone_id=42 WHERE deveui=?", [EUI]);
  await store.insertSchedule(db, {
    schedule_uuid: 'schedule-42', device_eui: EUI, kind: 'WEEKLY', weekdays_mask: 1,
    start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 0,
  });
  await db.run("UPDATE valve_schedules SET condition_policy_uuid='policy-42', deleted_at='2026-10-19T11:00:00.000Z', sync_version=3 WHERE schedule_uuid='schedule-42'");
  await store.upsertSettings(db, EUI, { strega_generation: generation });
  return {
    device: await db.get('SELECT id, deveui, type_id, user_id, irrigation_zone_id, deleted_at FROM devices WHERE deveui=?', [EUI]),
    zone: await db.get('SELECT zone_uuid, sync_version, deleted_at FROM irrigation_zones WHERE id=42'),
    policy: await db.get('SELECT policy_uuid, sync_version, enabled, deleted_at FROM irrigation_policies WHERE policy_uuid=?', ['policy-42']),
    retiredSchedules: await db.all('SELECT schedule_uuid, device_eui, sync_version, enabled, deleted_at, condition_policy_uuid FROM valve_schedules WHERE schedule_uuid=?', ['schedule-42']),
    liveSchedules: [],
  };
}

async function addOtherUser(db) {
  await db.run("INSERT INTO users(id, username, password_hash, created_at) VALUES (2, 'other', 'x', datetime('now'))");
}

function transportProbe() {
  const calls = { get: 0, flush: 0, enqueue: [] };
  return {
    calls,
    transport: {
      async getDeviceQueue() { calls.get += 1; return []; },
      async flushDeviceQueue() { calls.flush += 1; },
      async enqueueDownlink(item) { calls.enqueue.push(item); return { id: 'queue-' + calls.enqueue.length }; },
    },
  };
}

test('prepareLifecycleClearRevisionTx binds the tombstoned post-state and tags every GEN1 clear row', async () => {
  const { db } = await tempDb();
  const binding = await lifecycleBinding(db);
  const prepared = await db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: EUI, reason: 'zone_delete', now: NOW, ...binding,
  }));
  assert.equal(prepared.mode, 'LIFECYCLE_CLEAR');
  assert.equal(prepared.rows.length, 7);
  assert.equal(prepared.lifecycle_clear.v, 1);
  assert.equal(prepared.lifecycle_clear.device.row_id, binding.device.id);
  assert.deepEqual(prepared.lifecycle_clear.live_schedule_snapshot, []);
  const control = await store.conditionalControl(db, EUI);
  assert.equal(control.mode, 'LIFECYCLE_CLEAR');
  assert.equal(control.lifecycle_clear.revision, prepared.revision);
  const rows = await db.all("SELECT purpose, fport, transport_json FROM valve_schedule_pushes WHERE push_id IN (" + prepared.required_push_ids.map(() => '?').join(',') + ')', prepared.required_push_ids);
  assert.equal(rows.length, 7);
  assert.ok(rows.every((row) => JSON.parse(row.transport_json).lifecycle_clear_revision === prepared.revision));
  db.close();
});

test('GEN2 lifecycle clear uses the single empty daymask frame and strict control parsing rejects malformed bindings', async () => {
  const { db } = await tempDb();
  const binding = await lifecycleBinding(db, 'GEN2');
  const prepared = await db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...binding,
  }));
  assert.equal(prepared.generation, 'GEN2');
  assert.equal(prepared.rows.length, 1);
  assert.equal(prepared.rows[0].fport, 25);
  assert.equal(prepared.rows[0].payload_hex, '80');
  assert.throws(() => store.parseControl(JSON.stringify({ mode: 'LIFECYCLE_CLEAR', lifecycle_clear: { v: 1, revision: prepared.revision, state: 'PENDING' } })), /conditional_control_malformed/);
  db.close();
});

test('lifecycle sender ignores telemetry sync_version drift but obsoletes a changed stable owner binding', async () => {
  const { db } = await tempDb();
  const binding = await lifecycleBinding(db);
  const prepared = await db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...binding,
  }));
  await db.run("UPDATE devices SET current_state='CLOSED', sync_version=sync_version+1 WHERE deveui=?", [EUI]);
  const first = transportProbe();
  const sent = await push.sendPreparedLifecycleClear({ db, deviceEui: EUI, revision: prepared.revision, transport: first.transport, now: NOW });
  assert.equal(sent.obsolete, undefined);
  assert.equal(first.calls.enqueue.length, 7);

  const binding2 = binding;
  const prepared2 = await db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...binding2,
  }));
  await db.run("UPDATE devices SET user_id=NULL WHERE deveui=?", [EUI]);
  const second = transportProbe();
  const stale = await push.sendPreparedLifecycleClear({ db, deviceEui: EUI, revision: prepared2.revision, transport: second.transport, now: NOW });
  assert.equal(stale.obsolete, true);
  assert.equal(second.calls.flush, 0);
  assert.equal(second.calls.enqueue.length, 0);
  const staleControl = await store.conditionalControl(db, EUI);
  assert.equal(staleControl.lifecycle_clear.state, 'SUPERSEDED');
  const states = await db.all('SELECT state FROM valve_schedule_pushes WHERE push_id IN (' + prepared2.required_push_ids.map(() => '?').join(',') + ')', prepared2.required_push_ids);
  assert.ok(states.every((row) => row.state === 'SUPERSEDED'));
  db.close();
});

test('lifecycle sender fences generation and schedule binding drift before any transport call', async () => {
  const generationDb = await tempDb();
  const generationBinding = await lifecycleBinding(generationDb.db);
  const generationPrepared = await generationDb.db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...generationBinding,
  }));
  await store.upsertSettings(generationDb.db, EUI, { strega_generation: 'GEN2' });
  const generationProbe = transportProbe();
  const generationStale = await push.sendPreparedLifecycleClear({ db: generationDb.db, deviceEui: EUI, revision: generationPrepared.revision, transport: generationProbe.transport, now: NOW });
  assert.equal(generationStale.obsolete, true);
  assert.equal(generationProbe.calls.flush, 0);
  assert.equal(generationProbe.calls.enqueue.length, 0);
  generationDb.db.close();

  const scheduleDb = await tempDb();
  const scheduleBinding = await lifecycleBinding(scheduleDb.db);
  const schedulePrepared = await scheduleDb.db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...scheduleBinding,
  }));
  await scheduleDb.db.run('UPDATE valve_schedules SET sync_version=sync_version+1 WHERE schedule_uuid=?', ['schedule-42']);
  const scheduleProbe = transportProbe();
  const scheduleStale = await push.sendPreparedLifecycleClear({ db: scheduleDb.db, deviceEui: EUI, revision: schedulePrepared.revision, transport: scheduleProbe.transport, now: NOW });
  assert.equal(scheduleStale.obsolete, true);
  assert.equal(scheduleProbe.calls.flush, 0);
  assert.equal(scheduleProbe.calls.enqueue.length, 0);
  scheduleDb.db.close();
});

test('lifecycle tagged queued rows are not carried by the generic queue path', async () => {
  // Design C (CMD-04 PR0) removed the generic re-emission path (store.listQueued and the
  // "carried" rows after a flush). The only generic sender left is the debounced snapshot
  // emitter, and it never sends a lifecycle-tagged row, even one named in its marker.
  const { db } = await tempDb();
  await store.insertPushes(db, [
    { push_id: 'lifecycle-row', device_eui: EUI, purpose: 'WEEKDAY_PLAN', weekday: 0, fport: 14, payload_hex: 'FF'.repeat(24), plan_hash: 'clear', transport_json: { lifecycle_clear_revision: 'rev-1' } },
    { push_id: 'ordinary-row', device_eui: EUI, purpose: 'WEEKDAY_PLAN', weekday: 1, fport: 15, payload_hex: '00'.repeat(24), plan_hash: 'ordinary' },
  ]);
  assert.equal(typeof store.listQueued, 'undefined');
  await store.setSnapshotPending(db, EUI, { edited_at: '2026-01-01T00:00:00.000Z', first_edited_at: '2026-01-01T00:00:00.000Z', push_ids: ['lifecycle-row', 'ordinary-row'] });
  const out = await push.emitPendingSnapshots({ db, now: new Date('2026-01-01T01:00:00.000Z'), appId: 'app', warn: () => {} });
  assert.deepEqual(out.messages.map((m) => m.payload.fPort), [15]);
  db.close();
});

test('local and cloud scheduler ACTIVE adapters reject a current lifecycle clear without FPort 21', async () => {
  const { path, db } = await tempDb();
  await store.writeConditionalControl(db, EUI, { mode: 'LIFECYCLE_CLEAR', desired_revision: 'rev-status', lifecycle_clear: {
    v: 1, revision: 'rev-status', state: 'PENDING', reason: 'device_unclaim', prepared_at: NOW,
    device: { row_id: 1, device_eui: EUI, type_id: 'STREGA_VALVE', user_id: null, irrigation_zone_id: null, deleted_at: null },
    generation: 'GEN1', zone: null, policy: null, retired_schedules: [], live_schedule_snapshot: [],
  } });
  const localMessages = [];
  const local = await handleHttpRequest({ msg: apiRequest('POST', '/api/valves/' + EUI + '/scheduler-status', { status: 'ACTIVE' }), Database: TestDatabase,
    environment: { authTokenSecret: 'test-secret', dbPath: path }, warn: () => {}, appId: 'app',
    flushQueue: async () => {}, transport: { async getDeviceQueue() { return []; }, async flushDeviceQueue() {}, async enqueueDownlink(item) { localMessages.push(item); return { id: 'local' }; } } });
  assert.equal(local.statusCode, 409);
  assert.equal(localMessages.length, 0);
  const cloudMessages = [];
  const cloud = await applyCloudCommand({ db, cmd: { commandType: 'SET_VALVE_SCHEDULER_STATUS', device_eui: EUI, status: 'ACTIVE' }, appId: 'app',
    flushQueue: async () => {}, warn: () => {}, now: new Date(NOW), transport: { async getDeviceQueue() { return []; }, async flushDeviceQueue() {}, async enqueueDownlink(item) { cloudMessages.push(item); return { id: 'cloud' }; } } });
  assert.equal(cloud.ok, false);
  assert.equal(cloud.error, 'conditional_readiness_pending');
  assert.equal(cloudMessages.length, 0);
  db.close();
});

test('local and cloud scheduler ACTIVE recheck lifecycle mode after waiting for the valve writer', async () => {
  const local = await tempDb();
  const localBinding = await lifecycleBinding(local.db);
  const localProbe = transportProbe();
  let localRelease;
  let localEnteredResolve;
  const localEntered = new Promise((resolve) => { localEnteredResolve = resolve; });
  const localGate = new Promise((resolve) => { localRelease = resolve; });
  const localHolder = dispatch.withValveWriter(EUI, async () => {
    localEnteredResolve();
    await localGate;
  });
  await localEntered;
  const localRequest = handleHttpRequest({ msg: apiRequest('POST', '/api/valves/' + EUI + '/scheduler-status', { status: 'ACTIVE' }), Database: TestDatabase,
    environment: { authTokenSecret: 'test-secret', dbPath: local.path }, warn: () => {}, appId: 'app',
    flushQueue: async () => {}, transport: localProbe.transport });
  await new Promise((resolve) => setImmediate(resolve));
  await local.db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...localBinding,
  }));
  localRelease();
  await localHolder;
  const localResult = await localRequest;
  assert.equal(localResult.statusCode, 409);
  assert.equal(localProbe.calls.flush, 0);
  assert.equal(localProbe.calls.enqueue.length, 0);
  local.db.close();

  const cloud = await tempDb();
  const cloudBinding = await lifecycleBinding(cloud.db);
  const cloudProbe = transportProbe();
  let cloudRelease;
  let cloudEnteredResolve;
  const cloudEntered = new Promise((resolve) => { cloudEnteredResolve = resolve; });
  const cloudGate = new Promise((resolve) => { cloudRelease = resolve; });
  const cloudHolder = dispatch.withValveWriter(EUI, async () => {
    cloudEnteredResolve();
    await cloudGate;
  });
  await cloudEntered;
  const cloudRequest = applyCloudCommand({ db: cloud.db, cmd: {
    commandType: 'SET_VALVE_SCHEDULER_STATUS', device_eui: EUI, status: 'ACTIVE',
  }, appId: 'app', flushQueue: async () => {}, warn: () => {}, now: new Date(NOW), transport: cloudProbe.transport });
  await new Promise((resolve) => setImmediate(resolve));
  await cloud.db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...cloudBinding,
  }));
  cloudRelease();
  await cloudHolder;
  const cloudResult = await cloudRequest;
  assert.equal(cloudResult.ok, false);
  assert.equal(cloudResult.error, 'conditional_readiness_pending');
  assert.equal(cloudProbe.calls.flush, 0);
  assert.equal(cloudProbe.calls.enqueue.length, 0);
  cloud.db.close();
});

test('explicit local and cloud plan resend dispatch the persisted lifecycle revision after tombstones', async () => {
  const localDb = await tempDb();
  const localBinding = await lifecycleBinding(localDb.db);
  const localPrepared = await localDb.db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...localBinding,
  }));
  localDb.db.close();
  const localProbe = transportProbe();
  const local = await handleHttpRequest({ msg: apiRequest('POST', '/api/valves/' + EUI + '/plan/resend', {}), Database: TestDatabase,
    environment: { authTokenSecret: 'test-secret', dbPath: localDb.path }, warn: () => {}, appId: 'app', flushQueue: async () => {}, transport: localProbe.transport });
  assert.equal(local.statusCode, 202);
  assert.equal(local.payload.pushes_queued, localPrepared.required_push_ids.length);
  assert.equal(localProbe.calls.enqueue.length, 7);

  const cloud = await tempDb();
  const cloudBinding = await lifecycleBinding(cloud.db);
  const cloudPrepared = await cloud.db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...cloudBinding,
  }));
  const cloudProbe = transportProbe();
  const cloudResult = await applyCloudCommand({ db: cloud.db, cmd: { commandType: 'RESEND_VALVE_PLAN', device_eui: EUI }, appId: 'app',
    flushQueue: async () => {}, warn: () => {}, now: new Date(NOW), transport: cloudProbe.transport });
  assert.equal(cloudResult.ok, true);
  assert.equal(cloudResult.downlinks.length, 0);
  assert.equal(cloudResult._revision || cloudPrepared.revision, cloudPrepared.revision);
  assert.equal(cloudProbe.calls.enqueue.length, 7);
  cloud.db.close();
});

test('local resend rechecks ownership after waiting for the valve writer', async () => {
  const { path, db } = await tempDb();
  await addOtherUser(db);
  const binding = await lifecycleBinding(db);
  await db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...binding,
  }));
  const probe = transportProbe();
  let release;
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const holder = dispatch.withValveWriter(EUI, async () => {
    enteredResolve();
    await gate;
  });
  await entered;
  const resend = handleHttpRequest({ msg: apiRequest('POST', '/api/valves/' + EUI + '/plan/resend', {}), Database: TestDatabase,
    environment: { authTokenSecret: 'test-secret', dbPath: path }, warn: () => {}, appId: 'app',
    flushQueue: async () => {}, transport: probe.transport });
  await new Promise((resolve) => setImmediate(resolve));
  await db.run('UPDATE devices SET user_id=2 WHERE deveui=?', [EUI]);
  release();
  await holder;
  const response = await resend;
  assert.equal(response.statusCode, 403);
  assert.equal(probe.calls.flush, 0);
  assert.equal(probe.calls.enqueue.length, 0);
  db.close();
});

test('local schedule creation rechecks ownership after waiting for the valve writer', async () => {
  const { path, db } = await tempDb();
  await addOtherUser(db);
  const probe = transportProbe();
  let release;
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const holder = dispatch.withValveWriter(EUI, async () => {
    enteredResolve();
    await gate;
  });
  await entered;
  const create = handleHttpRequest({ msg: apiRequest('POST', '/api/valves/' + EUI + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1,
  }), Database: TestDatabase, environment: { authTokenSecret: 'test-secret', dbPath: path }, warn: () => {}, appId: 'app',
    flushQueue: async () => {}, transport: probe.transport });
  await new Promise((resolve) => setImmediate(resolve));
  await db.run('UPDATE devices SET user_id=2 WHERE deveui=?', [EUI]);
  release();
  await holder;
  const response = await create;
  assert.equal(response.statusCode, 403);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM valve_schedules WHERE UPPER(device_eui)=UPPER(?) AND deleted_at IS NULL', [EUI])).n, 0);
  assert.equal(probe.calls.flush, 0);
  assert.equal(probe.calls.enqueue.length, 0);
  db.close();
});

test('active/report-only owners preserve the remote queue while lifecycle clear remains pending', async () => {
  const { db } = await tempDb();
  const binding = await lifecycleBinding(db);
  const prepared = await db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...binding,
  }));
  await db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, created_at, reconciliation_state, trigger) VALUES ('active-owner', ?, ?, 600, ?, 'unknown', ?, 'PENDING_OBSERVATION', 'manual')", [EUI, NOW, '2026-10-19T12:10:00.000Z', NOW]);
  const probe = transportProbe();
  const result = await push.sendPreparedLifecycleClear({ db, deviceEui: EUI, revision: prepared.revision, transport: probe.transport, now: NOW });
  assert.equal(result.blocked, true);
  assert.equal(result.flush.phase, 'SKIPPED_ACTIVE_OWNER');
  assert.equal(probe.calls.flush, 0);
  assert.equal(probe.calls.enqueue.length, 7, 'clear frames may queue behind the preserved owner');
  assert.equal(result.readiness.state, 'PENDING');
  db.close();
});

test('UNKNOWN lifecycle push evidence is never replayed and proven pre-acceptance failure creates one new revision', async () => {
  const { db } = await tempDb();
  const binding = await lifecycleBinding(db);
  const prepared = await db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...binding,
  }));
  const unknownProbe = transportProbe();
  unknownProbe.transport.enqueueDownlink = async (item) => {
    unknownProbe.calls.enqueue.push(item);
    const error = new Error('network outcome unknown');
    throw error;
  };
  const unknown = await push.sendPreparedLifecycleClear({ db, deviceEui: EUI, revision: prepared.revision, transport: unknownProbe.transport, now: NOW });
  assert.equal(unknown.readiness.state, 'PENDING');
  const unknownAttemptCount = unknownProbe.calls.enqueue.length;
  assert.equal(unknownAttemptCount, 7);
  const retriedUnknown = await push.retryLifecycleClear({ db, deviceEui: EUI, transport: unknownProbe.transport, now: NOW });
  assert.equal(retriedUnknown.revision, prepared.revision);
  assert.equal(unknownProbe.calls.enqueue.length, unknownAttemptCount, 'UNKNOWN owner must never be replayed');

  let first = true;
  const preacceptProbe = transportProbe();
  preacceptProbe.transport.enqueueDownlink = async (item) => {
    preacceptProbe.calls.enqueue.push(item);
    if (first) {
      first = false;
      const error = new Error('invalid payload');
      error.code = 'enqueue_failed_before_acceptance'; error.provenance = 'local_preflight'; error.step = 'enqueueDownlink';
      throw error;
    }
    return { id: 'retry-queue-' + preacceptProbe.calls.enqueue.length };
  };
  const prepared2 = await db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...binding,
  }));
  const failed = await push.sendPreparedLifecycleClear({ db, deviceEui: EUI, revision: prepared2.revision, transport: preacceptProbe.transport, now: NOW });
  assert.equal(failed.readiness.state, 'FAILED');
  const ordinarySecondSend = await push.sendPreparedLifecycleClear({ db, deviceEui: EUI, revision: prepared2.revision, transport: preacceptProbe.transport, now: NOW });
  assert.equal(ordinarySecondSend.revision, prepared2.revision);
  assert.equal(ordinarySecondSend.sent, 0, 'ordinary sender must not call the enqueue path for a proven pre-acceptance failure');
  assert.equal(ordinarySecondSend.readiness.state, 'FAILED');
  assert.equal(preacceptProbe.calls.enqueue.length, 7, 'ordinary sender must not retry a proven pre-acceptance failure');
  const retried = await push.retryLifecycleClear({ db, deviceEui: EUI, transport: preacceptProbe.transport, now: NOW });
  assert.notEqual(retried.revision, prepared2.revision);
  assert.equal(retried.send.readiness.state, 'PENDING');
  db.close();
});

test('report-only owners skip destructive flush while the clear remains pending', async () => {
  const { db } = await tempDb();
  const binding = await lifecycleBinding(db);
  const prepared = await db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...binding,
  }));
  await db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, created_at, reconciliation_state, trigger, transport_json) VALUES ('report-owner', ?, ?, 600, ?, 'unknown', ?, 'PENDING_OBSERVATION', 'on_valve_schedule', ?)", [EUI, NOW, '2026-10-19T12:10:00.000Z', NOW, JSON.stringify({ physical_run: { version: 1, source: 'explicit_report', earliest_possible_start_at: NOW, latest_possible_end_at: '2026-10-19T12:10:00.000Z' } })]);
  const probe = transportProbe();
  const result = await push.sendPreparedLifecycleClear({ db, deviceEui: EUI, revision: prepared.revision, transport: probe.transport, now: NOW });
  assert.equal(result.blocked, true);
  assert.equal(result.flush.phase, 'SKIPPED_ACTIVE_OWNER');
  assert.equal(probe.calls.flush, 0);
  assert.equal(probe.calls.enqueue.length, 7);
  assert.equal(result.readiness.state, 'PENDING');
  assert.equal((await db.get("SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id='report-owner'")).reconciliation_state, 'PENDING_OBSERVATION');
  db.close();
});

test('partial ACK and ACCEPTED lifecycle rows are preserved and never replayed; an old sender cannot affect a replacement revision', async () => {
  const { db } = await tempDb();
  const binding = await lifecycleBinding(db);
  const prepared = await db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...binding,
  }));
  const acked = prepared.required_push_ids[0];
  const accepted = prepared.required_push_ids[1];
  await db.run("UPDATE valve_schedule_pushes SET state='ACKED', ack_status=1, acked_at=? WHERE push_id=?", [NOW, acked]);
  await db.run("UPDATE valve_schedule_pushes SET transport_json=? WHERE push_id=?", [JSON.stringify({ lifecycle_clear_revision: prepared.revision, phase: 'ACCEPTED', queue_id: 'already-q', accepted_at: NOW }), accepted]);
  const probe = transportProbe();
  const sent = await push.sendPreparedLifecycleClear({ db, deviceEui: EUI, revision: prepared.revision, transport: probe.transport, now: NOW });
  assert.equal(sent.flush.phase, 'SKIPPED_UNCERTAIN_TRANSPORT');
  assert.equal(sent.sent, 5);
  assert.equal(probe.calls.flush, 0);
  assert.equal(probe.calls.enqueue.length, 5);
  assert.equal((await db.get('SELECT state FROM valve_schedule_pushes WHERE push_id=?', [acked])).state, 'ACKED');
  assert.equal(JSON.parse((await db.get('SELECT transport_json FROM valve_schedule_pushes WHERE push_id=?', [accepted])).transport_json).phase, 'ACCEPTED');

  const replacement = await db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: EUI, reason: 'explicit_retry', now: NOW, ...binding,
  }));
  assert.notEqual(replacement.revision, prepared.revision);
  const staleProbe = transportProbe();
  const stale = await push.sendPreparedLifecycleClear({ db, deviceEui: EUI, revision: prepared.revision, transport: staleProbe.transport, now: NOW });
  assert.equal(stale.obsolete, true);
  assert.equal(staleProbe.calls.flush, 0);
  assert.equal(staleProbe.calls.enqueue.length, 0);
  assert.equal((await store.conditionalControl(db, EUI)).desired_revision, replacement.revision);
  db.close();
});

test('ambiguous flush remains durable and retry recovers without repeating flush or enqueue', async () => {
  const { db } = await tempDb();
  const binding = await lifecycleBinding(db);
  const prepared = await db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...binding,
  }));
  const probe = transportProbe();
  probe.transport.flushDeviceQueue = async () => { probe.calls.flush += 1; throw new Error('flush outcome unknown'); };
  const failed = await push.sendPreparedLifecycleClear({ db, deviceEui: EUI, revision: prepared.revision, transport: probe.transport, now: NOW });
  assert.equal(failed.readiness.state, 'FAILED');
  assert.equal(failed.flush.phase, 'UNKNOWN');
  assert.equal(probe.calls.get, 1);
  assert.equal(probe.calls.flush, 1);
  assert.equal(probe.calls.enqueue.length, 0);
  const retry = await push.retryLifecycleClear({ db, deviceEui: EUI, transport: probe.transport, now: NOW });
  assert.equal(retry.revision, prepared.revision);
  assert.equal(retry.send.readiness.state, 'FAILED');
  assert.equal(retry.send.flush.phase, 'UNKNOWN');
  assert.equal(probe.calls.get, 1);
  assert.equal(probe.calls.flush, 1);
  assert.equal(probe.calls.enqueue.length, 0);
  db.close();
});

test('claim ABA invalidation under the writer cannot restore an old lifecycle sender', async () => {
  const { db } = await tempDb();
  const binding = await lifecycleBinding(db);
  const prepared = await db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...binding,
  }));
  await dispatch.withValveWriter(EUI, () => db.transaction((tx) => push.invalidateLifecycleClearTx(tx, EUI, { revision: prepared.revision, reason: 'claim_changed', now: NOW })));
  await db.run('UPDATE devices SET user_id=1 WHERE deveui=?', [EUI]);
  await db.run('UPDATE devices SET user_id=NULL WHERE deveui=?', [EUI]);
  const probe = transportProbe();
  const stale = await push.sendPreparedLifecycleClear({ db, deviceEui: EUI, revision: prepared.revision, transport: probe.transport, now: NOW });
  assert.equal(stale.obsolete, true);
  assert.equal(probe.calls.flush, 0);
  assert.equal(probe.calls.enqueue.length, 0);
  assert.equal((await store.conditionalControl(db, EUI)).mode, 'FIXED');
  db.close();
});

test('schedule and generation writers invalidate lifecycle authority, while same-state replay leaves it current', async () => {
  const local = await tempDb();
  const localBinding = await lifecycleBinding(local.db);
  await local.db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, { deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...localBinding }));
  local.db.close();
  const unchanged = await handleHttpRequest({
    msg: apiRequest('PUT', '/api/valves/' + EUI + '/settings', { strega_generation: 'GEN1' }),
    Database: TestDatabase, environment: { authTokenSecret: 'test-secret', dbPath: local.path },
    warn: () => {}, appId: 'app', now: new Date(NOW), transport: transportProbe().transport,
  });
  assert.equal(unchanged.statusCode, 200);
  const unchangedDb = TestDatabase(local.path);
  assert.equal((await store.conditionalControl(unchangedDb, EUI)).mode, 'LIFECYCLE_CLEAR');
  unchangedDb.close();
  const changed = await handleHttpRequest({
    msg: apiRequest('PUT', '/api/valves/' + EUI + '/settings', { strega_generation: 'GEN2' }),
    Database: TestDatabase, environment: { authTokenSecret: 'test-secret', dbPath: local.path },
    warn: () => {}, appId: 'app', now: new Date(NOW), transport: transportProbe().transport,
  });
  assert.equal(changed.statusCode, 200);
  const changedDb = TestDatabase(local.path);
  assert.equal((await store.conditionalControl(changedDb, EUI)).mode, 'FIXED');
  changedDb.close();

  const cloud = await tempDb();
  const cloudBinding = await lifecycleBinding(cloud.db);
  await cloud.db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, { deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...cloudBinding }));
  const same = await applyCloudCommand({ db: cloud.db, cmd: {
    commandType: 'UPSERT_VALVE_SETTINGS', device_eui: EUI, strega_generation: 'GEN1',
  }, appId: 'app', flushQueue: async () => {}, warn: () => {}, now: new Date(NOW), transport: transportProbe().transport });
  assert.equal(same.ok, true);
  assert.equal((await store.conditionalControl(cloud.db, EUI)).mode, 'LIFECYCLE_CLEAR');
  const generation = await applyCloudCommand({ db: cloud.db, cmd: {
    commandType: 'UPSERT_VALVE_SETTINGS', device_eui: EUI, strega_generation: 'GEN2',
  }, appId: 'app', flushQueue: async () => {}, warn: () => {}, now: new Date(NOW), transport: transportProbe().transport });
  assert.equal(generation.ok, true);
  assert.equal((await store.conditionalControl(cloud.db, EUI)).mode, 'FIXED');
  cloud.db.close();
});

test('local and cloud schedule mutations invalidate a waiting lifecycle sender', async () => {
  const local = await tempDb();
  const localBinding = await lifecycleBinding(local.db);
  await local.db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, { deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...localBinding }));
  local.db.close();
  const localResult = await handleHttpRequest({
    msg: apiRequest('POST', '/api/valves/' + EUI + '/schedules', {
      kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1,
    }), Database: TestDatabase, environment: { authTokenSecret: 'test-secret', dbPath: local.path },
    warn: () => {}, appId: 'app', now: new Date(NOW), transport: transportProbe().transport,
  });
  assert.equal(localResult.statusCode, 201);
  const localVerify = TestDatabase(local.path);
  assert.equal((await store.conditionalControl(localVerify, EUI)).mode, 'FIXED');
  localVerify.close();

  const cloud = await tempDb();
  const cloudBinding = await lifecycleBinding(cloud.db);
  await cloud.db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, { deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...cloudBinding }));
  const cloudResult = await applyCloudCommand({ db: cloud.db, cmd: {
    commandType: 'UPSERT_VALVE_SCHEDULE', device_eui: EUI, schedule_uuid: 'schedule-replacement',
    kind: 'WEEKLY', weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, timezone: 'UTC', enabled: 1,
  }, appId: 'app', flushQueue: async () => {}, warn: () => {}, now: new Date(NOW), transport: transportProbe().transport });
  assert.equal(cloudResult.ok, true);
  assert.equal((await store.conditionalControl(cloud.db, EUI)).mode, 'FIXED');
  cloud.db.close();
});

test('sender waits behind a writer mutation and cannot enqueue after the revision is invalidated', async () => {
  const { db } = await tempDb();
  const binding = await lifecycleBinding(db);
  const prepared = await db.transaction((tx) => push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: EUI, reason: 'device_unclaim', now: NOW, ...binding,
  }));
  let release;
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const holder = dispatch.withValveWriter(EUI, async () => {
    await db.transaction((tx) => push.invalidateLifecycleClearTx(tx, EUI, { revision: prepared.revision, reason: 'schedule_changed', now: NOW }));
    enteredResolve();
    await gate;
  });
  await entered;
  const probe = transportProbe();
  const sending = push.sendPreparedLifecycleClear({ db, deviceEui: EUI, revision: prepared.revision, transport: probe.transport, now: NOW });
  release();
  await holder;
  const result = await sending;
  assert.equal(result.obsolete, true);
  assert.equal(probe.calls.flush, 0);
  assert.equal(probe.calls.enqueue.length, 0);
  db.close();
});
