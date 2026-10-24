'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const policyApi = require('./api');
const lifecycle = require('./lifecycle');
const { tempDb } = require('../osi-valve-control/test-helpers');

const EUI = '0016C001F1000001';
const POLICY = 'policy-lifecycle-test';
const SCHEDULE = 'schedule-lifecycle-test';

async function seedPolicy(f) {
  await f.db.run("INSERT INTO irrigation_zones(id,name,user_id,created_at,updated_at,timezone,zone_uuid,sync_version) VALUES (1,'Lifecycle zone',1,?,?, 'UTC','zone-lifecycle-test',1)", ['2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z']);
  await f.db.run('UPDATE devices SET irrigation_zone_id=1, updated_at=? WHERE UPPER(deveui)=UPPER(?)', ['2026-10-19T00:00:00.000Z', EUI]);
  await f.db.run("INSERT INTO irrigation_policies(policy_uuid,zone_uuid,condition_json,timezone,enabled,observation_window_minutes,min_interval_minutes,max_daily_minutes,delivery_settings_json,effective_from,sync_version,created_at,updated_at) VALUES (?,?,?,'UTC',1,60,60,240,'{}',NULL,4,?,?)", [POLICY, 'zone-lifecycle-test', JSON.stringify({ kind: 'SWT', threshold_kpa: 10, sources: [{ device_eui: EUI, channel: 'swt_1' }] }), '2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z']);
  await f.db.run("INSERT INTO valve_schedules(schedule_uuid,device_eui,kind,label,weekdays_mask,start_time,duration_minutes,timezone,enabled,sync_version,created_at,updated_at,condition_policy_uuid) VALUES (?,?, 'WEEKLY','Conditional',127,'06:00',10,'UTC',1,7,?,?,?)", [SCHEDULE, EUI, '2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z', POLICY]);
  await f.db.run("INSERT INTO irrigation_occurrences(schedule_uuid,local_date,local_time,policy_uuid,zone_uuid,device_eui,due_at,policy_revision,schedule_revision,policy_sync_version,schedule_sync_version,state,created_at,updated_at) VALUES (?,?,? ,?,?,?,?,?,?,?,?, 'PENDING',?,?)", [SCHEDULE, '2026-10-20', '06:00', POLICY, 'zone-lifecycle-test', EUI, '2026-10-20T06:00:00.000Z', 1, 1, 4, 7, '2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z']);
}

test('retiring a policy keeps schedule identity and advances each version once', async () => {
  const f = await tempDb();
  try {
    await seedPolicy(f);
    const result = await f.db.transaction((tx) => policyApi.retirePolicyTx(tx, {
      zoneId: 1,
      actor: { user_id: 1 },
      now: '2026-10-19T01:00:00.000Z',
      reason: 'zone_deleted',
    }));
    assert.equal(result.policy.enabled, 0);
    assert.equal(result.policy.sync_version, 5);
    const schedule = await f.db.get('SELECT * FROM valve_schedules WHERE schedule_uuid=?', [SCHEDULE]);
    assert.equal(schedule.condition_policy_uuid, POLICY);
    assert.equal(schedule.deleted_at, '2026-10-19T01:00:00.000Z');
    assert.equal(schedule.sync_version, 8);
    const occurrence = await f.db.get('SELECT state,decision,decision_reason FROM irrigation_occurrences WHERE schedule_uuid=?', [SCHEDULE]);
    assert.equal(occurrence.state, 'SKIPPED');
    assert.equal(occurrence.decision, 'SKIPPED');
    assert.equal(occurrence.decision_reason, 'zone_deleted');

    await f.db.transaction((tx) => policyApi.retirePolicyTx(tx, {
      zoneId: 1,
      actor: { user_id: 1 },
      now: '2026-10-19T02:00:00.000Z',
      reason: 'zone_deleted',
    }));
    const afterReplay = await f.db.get('SELECT sync_version,deleted_at FROM valve_schedules WHERE schedule_uuid=?', [SCHEDULE]);
    assert.equal(afterReplay.sync_version, 8);
    assert.equal(afterReplay.deleted_at, '2026-10-19T01:00:00.000Z');
  } finally {
    f.cleanup();
  }
});

test('device lifecycle adapter is exposed for route integration', async () => {
  assert.equal(typeof lifecycle.applyLifecycleMutation, 'function');
});

test('lifecycle transaction seams fence every policy-affecting operation during a pending link', async (t) => {
  const cases = [
    ['zone_delete', { zoneId: 1 }],
    ['disable_all', { zoneIds: [1] }],
    ['legacy_schedule_write', { zoneId: 1, patch: { enabled: false } }],
    ['device_assign', { deviceEui: EUI, zoneId: 2, gatewayDeviceEui: '0016C001F10000FF' }],
    ['device_unassign', { deviceEui: EUI, zoneId: 1 }],
    ['device_unclaim', { deviceEui: EUI, gatewayDeviceEui: '0016C001F10000FF' }],
  ];
  for (const [operation, input] of cases) {
    await t.test(operation, async () => {
      const f = await tempDb();
      try {
        await seedPolicy(f);
        if (operation === 'device_assign') {
          await f.db.run("INSERT INTO irrigation_zones(id,name,user_id,created_at,updated_at,timezone,zone_uuid,sync_version) VALUES (2,'Target',1,?,?, 'UTC','zone-lifecycle-target',1)", ['2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z']);
        }
        await f.db.run("INSERT INTO sync_link_state(peer_node,linked,updated_at,link_attempt_json) VALUES ('cloud',0,'2026-10-19T00:00:00.000Z','{\"nonce\":\"pending\"}')");
        const before = await f.db.get('SELECT enabled,deleted_at,sync_version FROM irrigation_policies WHERE policy_uuid=?', [POLICY]);
        await assert.rejects(
          f.db.transaction((tx) => lifecycle.applyLifecycleMutationTx(tx, operation, { ...input, now: '2026-10-19T07:00:00.000Z' })),
          (error) => error.code === 'link_in_progress' && error.statusCode === 409,
        );
        assert.deepEqual(await f.db.get('SELECT enabled,deleted_at,sync_version FROM irrigation_policies WHERE policy_uuid=?', [POLICY]), before);
        assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM sync_outbox')).n, 0);
      } finally { f.cleanup(); }
    });
  }
});

test('direct lifecycle pause and retire helpers also enforce the link fence', async () => {
  const f = await tempDb();
  try {
    await seedPolicy(f);
    await f.db.run("INSERT INTO sync_link_state(peer_node,linked,updated_at,link_attempt_json) VALUES ('cloud',0,'2026-10-19T00:00:00.000Z','{\"nonce\":\"pending\"}')");
    const policy = await f.db.get('SELECT * FROM irrigation_policies WHERE policy_uuid=?', [POLICY]);
    await assert.rejects(
      f.db.transaction((tx) => lifecycle.pausePolicyTx(tx, policy, '2026-10-19T07:00:00.000Z', 'test')),
      (error) => error.code === 'link_in_progress',
    );
    await assert.rejects(
      f.db.transaction((tx) => lifecycle.retirePolicyAndSchedulesTx(tx, policy, '2026-10-19T07:00:00.000Z', 'test')),
      (error) => error.code === 'link_in_progress',
    );
  } finally { f.cleanup(); }
});

test('device unclaim retires policy authority and preserves an auditable clear intent', async () => {
  const f = await tempDb();
  try {
    await seedPolicy(f);
    const result = await lifecycle.applyLifecycleMutation({
      db: f.db,
      operation: 'device_unclaim',
      deviceEui: EUI,
      gatewayDeviceEui: '0016C001F10000FF',
      now: '2026-10-19T03:00:00.000Z',
    });
    assert.equal(result.status, 202);
    const device = await f.db.get('SELECT user_id,irrigation_zone_id,gateway_device_eui,sync_version FROM devices WHERE UPPER(deveui)=UPPER(?)', [EUI]);
    assert.equal(device.user_id, null);
    assert.equal(device.irrigation_zone_id, null);
    assert.equal(device.gateway_device_eui, '0016C001F10000FF');
    assert.equal(device.sync_version, 2);
    const schedule = await f.db.get('SELECT enabled,deleted_at,condition_policy_uuid FROM valve_schedules WHERE schedule_uuid=?', [SCHEDULE]);
    assert.equal(schedule.enabled, 0);
    assert.equal(schedule.deleted_at, '2026-10-19T03:00:00.000Z');
    assert.equal(schedule.condition_policy_uuid, POLICY);
    const policy = await f.db.get('SELECT enabled,deleted_at,sync_version FROM irrigation_policies WHERE policy_uuid=?', [POLICY]);
    assert.equal(policy.enabled, 0);
    assert.equal(policy.deleted_at, null);
    assert.equal(policy.sync_version, 5);
    assert.equal(result.clear_results.length, 1);
  } finally {
    f.cleanup();
  }
});

test('managed legacy disable accepts the validated numeric false and counts one changed zone', async () => {
  const f = await tempDb();
  try {
    await seedPolicy(f);
    await f.db.run(
      "INSERT INTO irrigation_schedules(irrigation_zone_id,trigger_metric,threshold_kpa,duration_minutes,enabled,response_mode,sync_version,created_at,updated_at) VALUES (1,'SWT_WM1',25,20,0,'proportional',3,?,?)",
      ['2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z']
    );
    const first = await lifecycle.applyLifecycleMutation({
      db: f.db,
      operation: 'legacy_schedule_write',
      zoneId: 1,
      patch: { enabled: 0, trigger_metric: 'DENDRO', threshold_kpa: 4, duration_minutes: 90 },
      now: '2026-10-19T04:00:00.000Z',
    });
    assert.equal(first.status, 202);
    assert.equal(first.disabledSchedules, 1);
    assert.equal((await f.db.get('SELECT enabled,sync_version FROM irrigation_policies WHERE policy_uuid=?', [POLICY])).enabled, 0);
    assert.equal((await f.db.get('SELECT sync_version FROM irrigation_policies WHERE policy_uuid=?', [POLICY])).sync_version, 5);

    const replay = await lifecycle.applyLifecycleMutation({
      db: f.db,
      operation: 'legacy_schedule_write',
      zoneId: 1,
      patch: { enabled: 0 },
      now: '2026-10-19T05:00:00.000Z',
    });
    assert.equal(replay.disabledSchedules, 0);
    assert.equal((await f.db.get('SELECT sync_version FROM irrigation_policies WHERE policy_uuid=?', [POLICY])).sync_version, 5);
  } finally {
    f.cleanup();
  }
});

test('a clear transport exception stays pending after the committed authority retirement', async () => {
  const f = await tempDb();
  try {
    await seedPolicy(f);
    const result = await lifecycle.applyLifecycleMutation({
      db: f.db,
      operation: 'device_unclaim',
      deviceEui: EUI,
      gatewayDeviceEui: '0016C001F10000FF',
      now: '2026-10-19T06:00:00.000Z',
      sendPreparedLifecycleClear: async () => {
        throw Object.assign(new Error('queue unavailable'), { code: 'transport_failed' });
      },
    });
    assert.equal(result.status, 202);
    assert.equal(result.clear_results.length, 1);
    assert.equal(result.clear_results[0].transport_uncertain, true);
    assert.equal((await f.db.get('SELECT sync_version FROM irrigation_policies WHERE policy_uuid=?', [POLICY])).sync_version, 5);
    assert.equal((await f.db.get('SELECT user_id,irrigation_zone_id FROM devices WHERE UPPER(deveui)=UPPER(?)', [EUI])).user_id, null);
  } finally {
    f.cleanup();
  }
});

test('device assignment retires only source policies that lose the moved device', async () => {
  const f = await tempDb();
  try {
    const at = '2026-10-19T00:00:00.000Z';
    await f.db.run(
      "INSERT INTO irrigation_zones(id,name,user_id,created_at,updated_at,timezone,zone_uuid,sync_version) VALUES (1,'Source',1,?,?, 'UTC','zone-source',1), (2,'Target',1,?,?, 'UTC','zone-target',1)",
      [at, at, at, at]
    );
    await f.db.run('UPDATE devices SET irrigation_zone_id=2, updated_at=? WHERE UPPER(deveui)=UPPER(?)', [at, EUI]);
    await f.db.run(
      "INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at) VALUES ('0016C001F10000AA','Source sensor','KIWI_SENSOR',1,1,?,?)",
      [at, at]
    );
    const sourceJson = JSON.stringify({ kind: 'SWT', sources: [{ device_eui: '0016C001F10000AA', channel: 'swt_1' }] });
    for (const [policyUuid, zoneUuid] of [['policy-source', 'zone-source'], ['policy-target', 'zone-target']]) {
      await f.db.run(
        "INSERT INTO irrigation_policies(policy_uuid,zone_uuid,condition_json,timezone,enabled,observation_window_minutes,min_interval_minutes,max_daily_minutes,delivery_settings_json,sync_version,created_at,updated_at) VALUES (?,?,?,'UTC',1,60,60,240,'{}',1,?,?)",
        [policyUuid, zoneUuid, sourceJson, at, at]
      );
    }
    await f.db.run(
      "INSERT INTO valve_schedules(schedule_uuid,device_eui,kind,label,weekdays_mask,start_time,duration_minutes,timezone,enabled,sync_version,created_at,updated_at,condition_policy_uuid) VALUES ('schedule-target',?,'WEEKLY','Target',127,'06:00',10,'UTC',1,1,?,?,?)",
      [EUI, at, at, 'policy-target']
    );

    const result = await lifecycle.applyLifecycleMutation({
      db: f.db,
      operation: 'device_assign',
      deviceEui: '0016C001F10000AA',
      zoneId: 2,
      gatewayDeviceEui: '0016C001F10000FF',
      now: '2026-10-19T07:00:00.000Z',
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.changed_policies.sort(), ['policy-source']);
    assert.equal((await f.db.get("SELECT enabled FROM irrigation_policies WHERE policy_uuid='policy-source'")).enabled, 0);
    assert.equal((await f.db.get("SELECT enabled FROM irrigation_policies WHERE policy_uuid='policy-target'")).enabled, 1);
    const schedule = await f.db.get("SELECT enabled,deleted_at,condition_policy_uuid FROM valve_schedules WHERE schedule_uuid='schedule-target'");
    assert.equal(schedule.enabled, 1);
    assert.equal(schedule.deleted_at, null);
    assert.equal(schedule.condition_policy_uuid, 'policy-target');
    assert.equal((await f.db.get("SELECT irrigation_zone_id FROM devices WHERE deveui='0016C001F10000AA'")).irrigation_zone_id, 2);
    assert.equal(result.clear_results.length, 0);
  } finally {
    f.cleanup();
  }
});

// S6 (owner decision 2026-10-22): the lifecycle service owns unclaim on both paths and reports
// W1's AUTH-09 cleanup outcome. Same keys and vocabulary as osi-valve-control
// runUnclaimCleanup; a clear prepared for the next snapshot is clearing_scheduled.
const CLEANUP_KEYS = ['attempted', 'clearing_downlinks_sent', 'device_eui', 'final', 'in_flight_cancel', 'in_flight_cancel_error',
  'may_still_hold_plan', 'outcome', 'plan_clear_confirmed', 'reason', 'schedules_cleared', 'whole_queue_flushed'];

test('unclaim cleanup outcome: a programmed valve reports clearing_scheduled, never a confirmed clear', async () => {
  const f = await tempDb();
  try {
    await seedPolicy(f);
    const result = await lifecycle.applyLifecycleMutation({
      db: f.db, operation: 'device_unclaim', deviceEui: EUI, gatewayDeviceEui: '0016C001F1000002', now: '2026-10-19T03:00:00.000Z',
    });
    assert.equal(result.schedules_cleared, 1);
    const cleanup = lifecycle.unclaimValveCleanup({ deviceEui: EUI, mutation: result });
    assert.deepEqual(Object.keys(cleanup).sort(), CLEANUP_KEYS);
    assert.equal(cleanup.outcome, 'clearing_scheduled');
    assert.equal(cleanup.attempted, true);
    assert.equal(cleanup.device_eui, EUI);
    assert.equal(cleanup.schedules_cleared, 1);
    assert.equal(cleanup.may_still_hold_plan, true);
    assert.equal(cleanup.plan_clear_confirmed, false);
    assert.equal(cleanup.clearing_downlinks_sent, 0, 'no transport here: the clear waits for the snapshot emitter');
  } finally {
    f.cleanup();
  }
});

test('unclaim cleanup outcome: a valve with nothing programmed reports no_plan_to_clear', async () => {
  const f = await tempDb();
  try {
    const result = await lifecycle.applyLifecycleMutation({
      db: f.db, operation: 'device_unclaim', deviceEui: EUI, gatewayDeviceEui: '0016C001F1000002', now: '2026-10-19T03:00:00.000Z',
    });
    assert.equal(result.clears.length, 0);
    const cleanup = lifecycle.unclaimValveCleanup({ deviceEui: EUI, mutation: result });
    assert.equal(cleanup.outcome, 'no_plan_to_clear');
    assert.equal(cleanup.attempted, true);
    assert.equal(cleanup.schedules_cleared, 0);
    assert.equal(cleanup.may_still_hold_plan, null, 'a plan set another way cannot be ruled out');
    assert.equal(cleanup.plan_clear_confirmed, false);
  } finally {
    f.cleanup();
  }
});

test('unclaim cleanup outcome: sensors, refusals, unknown devices and failures use the W1 vocabulary', () => {
  const sensor = lifecycle.unclaimValveCleanup({ deviceEui: 'DENDRO1', mutation: { device: { deveui: 'DENDRO1', type_id: 'DRAGINO_LSN50' }, clears: [] } });
  assert.deepEqual(Object.keys(sensor).sort(), CLEANUP_KEYS);
  assert.equal(sensor.outcome, 'not_applicable');
  assert.equal(sensor.reason, 'not_a_valve');
  assert.equal(sensor.may_still_hold_plan, false);
  assert.equal(sensor.attempted, false);

  const unknown = lifecycle.unclaimValveCleanup({ deviceEui: EUI, refused: { code: 'device_not_found' } });
  assert.equal(unknown.outcome, 'not_applicable');
  assert.equal(unknown.reason, 'not_found');
  assert.equal(unknown.may_still_hold_plan, null);

  const stale = lifecycle.unclaimValveCleanup({ deviceEui: EUI, refused: { code: 'stale_sync_version' } });
  assert.deepEqual(Object.keys(stale).sort(), CLEANUP_KEYS);
  assert.equal(stale.outcome, 'not_attempted');
  assert.equal(stale.reason, 'stale_sync_version');
  assert.equal(stale.attempted, false);
  assert.equal(stale.plan_clear_confirmed, false);

  const failed = lifecycle.unclaimValveCleanup({ deviceEui: EUI, error: new Error('disk I/O error'), mutation: { device: { deveui: EUI, type_id: 'STREGA_VALVE' } } });
  assert.deepEqual(Object.keys(failed).sort(), CLEANUP_KEYS);
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.reason, 'error: disk I/O error');
  assert.equal(failed.attempted, true);
  assert.equal(failed.may_still_hold_plan, true);
});

test('unclaim cleanup outcome: a sent clear counts its downlinks and its queue flush', () => {
  const mutation = {
    device: { deveui: EUI, type_id: 'STREGA_VALVE' },
    schedules_cleared: 2,
    clears: [{ device_eui: EUI, revision: 3 }],
    clear_results: [{ sent: 7, revision: 3, flush: { ok: true, flush_id: 'f1' }, readiness: { state: 'PENDING', reason: 'awaiting_clear_ack' } }],
  };
  const cleanup = lifecycle.unclaimValveCleanup({ deviceEui: EUI, mutation });
  assert.equal(cleanup.outcome, 'clearing_scheduled');
  assert.equal(cleanup.clearing_downlinks_sent, 7);
  assert.equal(cleanup.whole_queue_flushed, true);
  assert.equal(cleanup.may_still_hold_plan, true);

  const skipped = lifecycle.unclaimValveCleanup({ deviceEui: EUI, mutation: { ...mutation, clear_results: [{ sent: 0, revision: 3, flush: { ok: true, skipped: true, phase: 'SKIPPED_ACTIVE_OWNER' }, blocked: true }] } });
  assert.equal(skipped.whole_queue_flushed, false);
  assert.equal(skipped.outcome, 'clearing_scheduled', 'the durable clear intent is retried on the next snapshot');
  assert.equal(skipped.reason, 'clear_waits_for: SKIPPED_ACTIVE_OWNER');
});

// Owner decision 2026-10-22: the unclaim cancels queued opens (D19(a) path), never sends a CLOSE,
// lets a running open run out, and in_flight_cancel reports what happened.
async function insertOpen(f, id, state, transport) {
  await f.db.run("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, trigger, created_at, transport_json) VALUES (?, ?, '2026-10-19T02:50:00.000Z', 900, '2026-10-19T03:05:00.000Z', 'unknown', ?, 'manual', '2026-10-19T02:50:00.000Z', ?)",
    [id, EUI, state, transport ? JSON.stringify(transport) : null]);
}

function recordingTransport(queue) {
  const calls = { flush: 0, enqueued: [] };
  return {
    calls,
    getDeviceQueue: async () => queue,
    flushDeviceQueue: async () => { calls.flush += 1; return {}; },
    enqueueDownlink: async (item) => { calls.enqueued.push(item); return { id: 'q-' + calls.enqueued.length }; },
  };
}

// Owner decision 2026-10-24 (fail closed, Codex P1 on PR #515): the D19(a) flush stops a queued
// open, but the pre-flush read cannot prove it was not delivered, so the cancel is handed_off and
// the open stays observed (and keeps the valve fenced) until its bounded duration has passed.
test('unclaim with a queued open flushes it through D19(a) and reports in_flight_cancel handed_off', async () => {
  const f = await tempDb();
  try {
    await seedPolicy(f);
    await insertOpen(f, 'e-queued', 'PENDING_OBSERVATION', { phase: 'ACCEPTED', queue_id: 'q-open', attempted_at: '2026-10-19T02:50:00.100Z' });
    const transport = recordingTransport([{ id: 'q-open', fPort: 2, data: 'QQ8=', isPending: false }]);
    const result = await lifecycle.applyLifecycleMutation({
      db: f.db, operation: 'device_unclaim', deviceEui: EUI, gatewayDeviceEui: '0016C001F1000002', transport, now: '2026-10-19T03:00:00.000Z',
    });
    assert.equal(result.in_flight_cancel.state, 'handed_off', JSON.stringify(result.in_flight_cancel));
    assert.equal((await f.db.get("SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id='e-queued'")).reconciliation_state, 'PENDING_OBSERVATION');
    const cleanup = lifecycle.unclaimValveCleanup({ deviceEui: EUI, mutation: result });
    assert.equal(cleanup.in_flight_cancel, 'handed_off');
    assert.equal(cleanup.whole_queue_flushed, true);
    assert.equal(cleanup.outcome, 'clearing_scheduled');
    assert.match(cleanup.reason, /queued_open_may_have_been_sent/);
    assert.equal(cleanup.may_still_hold_plan, true);
    assert.ok(transport.calls.enqueued.every((item) => Number(item.fPort) !== 1), 'no CLOSE (or any valve action) is ever enqueued');
  } finally {
    f.cleanup();
  }
});

test('unclaim during a running open sends no CLOSE, leaves the open bounded and says so', async () => {
  const f = await tempDb();
  try {
    await seedPolicy(f);
    await insertOpen(f, 'e-run', 'OBSERVED_RUNNING', { phase: 'ACCEPTED', queue_id: 'q-open', attempted_at: '2026-10-19T02:50:00.100Z' });
    const transport = recordingTransport([]);
    const result = await lifecycle.applyLifecycleMutation({
      db: f.db, operation: 'device_unclaim', deviceEui: EUI, gatewayDeviceEui: '0016C001F1000002', transport, now: '2026-10-19T03:00:00.000Z',
    });
    assert.equal(result.in_flight_cancel.state, 'already_running');
    assert.equal(result.in_flight_cancel.results[0].expected_close_at, '2026-10-19T03:05:00.000Z');
    const row = await f.db.get("SELECT reconciliation_state, commanded_duration_seconds FROM valve_actuation_expectations WHERE expectation_id='e-run'");
    assert.equal(row.reconciliation_state, 'OBSERVED_RUNNING', 'the bounded open runs out on its own');
    assert.equal(row.commanded_duration_seconds, 900);
    assert.ok(transport.calls.enqueued.every((item) => Number(item.fPort) !== 1), 'no CLOSE is ever enqueued');
    const cleanup = lifecycle.unclaimValveCleanup({ deviceEui: EUI, mutation: result });
    assert.equal(cleanup.in_flight_cancel, 'already_running');
    assert.match(cleanup.reason, /open_running: closes by itself at 2026-10-19T03:05:00.000Z/);
    assert.equal(cleanup.may_still_hold_plan, true);
  } finally {
    f.cleanup();
  }
});

test('unclaim without a transport reports the in-flight cancel as not attempted', async () => {
  const f = await tempDb();
  try {
    await insertOpen(f, 'e-queued', 'PENDING_OBSERVATION', { phase: 'ACCEPTED', queue_id: 'q-open', attempted_at: '2026-10-19T02:50:00.100Z' });
    const result = await lifecycle.applyLifecycleMutation({
      db: f.db, operation: 'device_unclaim', deviceEui: EUI, gatewayDeviceEui: '0016C001F1000002', now: '2026-10-19T03:00:00.000Z',
    });
    const cleanup = lifecycle.unclaimValveCleanup({ deviceEui: EUI, mutation: result });
    assert.equal(cleanup.in_flight_cancel, 'not_attempted');
    assert.equal(cleanup.in_flight_cancel_error, 'transport_unavailable');
    assert.match(cleanup.reason, /in_flight_cancel_not_attempted: transport_unavailable/);
    assert.equal((await f.db.get("SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id='e-queued'")).reconciliation_state, 'PENDING_OBSERVATION');
  } finally {
    f.cleanup();
  }
});

test('unclaim cleanup outcome: final is true unless the caller marks a commit-time outcome provisional', () => {
  const mutation = { device: { deveui: EUI, type_id: 'STREGA_VALVE' }, clears: [], schedules_cleared: 0 };
  assert.equal(lifecycle.unclaimValveCleanup({ deviceEui: EUI, mutation }).final, true);
  assert.equal(lifecycle.unclaimValveCleanup({ deviceEui: EUI, mutation, final: false }).final, false);
  assert.equal(lifecycle.unclaimValveCleanup({ deviceEui: EUI, refused: { code: 'stale_sync_version' } }).final, true);
});
