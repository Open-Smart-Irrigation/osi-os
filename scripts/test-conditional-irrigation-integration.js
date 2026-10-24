#!/usr/bin/env node
'use strict';

// Task 9a: one persistent SQLite integration harness for the conditional
// irrigation runtime.  The fixtures below deliberately stop at the durable
// seams (SQLite, worker, valve writer, observation and replication adapters);
// no gateway or cloud network is contacted by this script.

const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { executeFunction, loadNode } = require('./lib/scoped-access-harness');

const { tempDb, facade } = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/test-helpers');
const worker = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/worker');
const observations = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/observations');
const policyApi = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/api');
const lifecycle = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/lifecycle');
const replication = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/replication');
const dispatch = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/dispatch');
const effects = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/effects');
const valveWorkers = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/workers');
const push = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/push');

const DEVICE = '0016C001F1000001';
const NOW = '2026-10-19T06:05:00.000Z';

function clockOptions(now = NOW, { trusted = true, bootId = 'task9a-boot', uptimeMs = 100000 } = {}) {
  const files = new Map([
    ['/task9a/boot', `${bootId}\n`],
    ['/task9a/uptime', `${(uptimeMs / 1000).toFixed(3)} 0.00\n`],
    ['/task9a/marker', JSON.stringify({ boot_id: bootId, epoch_ms: Date.parse(now), uptime_ms: uptimeMs, stratum: trusted ? 1 : 0 })],
  ]);
  return {
    fs: {
      readFileSync(file) {
        if (files.has(file)) return files.get(file);
        const error = new Error(`missing fixture file: ${file}`);
        error.code = 'ENOENT';
        throw error;
      },
      unlinkSync(file) {
        if (files.delete(file)) return;
        const error = new Error(`missing fixture file: ${file}`);
        error.code = 'ENOENT';
        throw error;
      },
      mkdirSync() {}, writeFileSync(file, value) { files.set(file, value); },
      renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
      unlink(file, cb) { try { this.unlinkSync(file); cb(null); } catch (error) { cb(error); } },
    },
    bootPath: '/task9a/boot', uptimePath: '/task9a/uptime', markerPath: '/task9a/marker',
    rejectionPath: '/task9a/rejection', fallbackPath: '/task9a/rejection-fallback',
    now: Date.parse(now),
  };
}

function reopen(value) {
  value.raw.close();
  value.raw = new DatabaseSync(value.path);
  value.db = facade(value.raw);
}

function closeFixture(value) {
  value.raw.close();
  value.cleanup();
}

function transportRecorder({ queue = [], label = 'task9a' } = {}) {
  const calls = { get: 0, flush: 0, enqueue: [], labels: [] };
  return {
    calls,
    async getDeviceQueue(deviceEui) { calls.get += 1; calls.labels.push(`get:${deviceEui}`); return queue; },
    async flushDeviceQueue(deviceEui) { calls.flush += 1; calls.labels.push(`flush:${deviceEui}`); queue.length = 0; return { ok: true }; },
    async enqueueDownlink(item) {
      calls.enqueue.push(item);
      calls.labels.push(`enqueue:${label}`);
      return { id: `${label}-${calls.enqueue.length}` };
    },
  };
}

async function insertConditionalFixture(value, {
  condition = 'DENDRO',
  recommendation = { stress: 'mild', action: 'increase_10', usable_tree_count: 1 },
  enabled = 1,
  ready = true,
  policyUuid = 'policy-1',
  scheduleUuid = 'schedule-1',
  dueAt = NOW,
  durationMinutes = 5,
  legacyEnabled = null,
} = {}) {
  const due = new Date(dueAt);
  const weekday = 1 << due.getUTCDay();
  const computedAt = new Date(due.getTime() - 60 * 1000).toISOString();
  await value.db.run("INSERT INTO irrigation_zones(id,name,user_id,timezone,zone_uuid) VALUES (1,'North',1,'UTC','zone-1')");
  await value.db.run('UPDATE devices SET irrigation_zone_id=1 WHERE deveui=?', [DEVICE]);
  await value.db.run(`INSERT INTO irrigation_policies(
    policy_uuid,zone_uuid,condition_json,timezone,enabled,observation_window_minutes,
    min_interval_minutes,max_daily_minutes,delivery_settings_json,effective_from,sync_version
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
    policyUuid, 'zone-1', JSON.stringify(condition === 'SWT'
      ? { kind: 'SWT', swt_channel: 'swt_1', threshold_kpa: 20, response_mode: 'fixed' }
      : { kind: 'DENDRO', minimum_stress: 'mild', response_mode: 'fixed' }),
    'UTC', enabled, 60, 60, 240, JSON.stringify({ [DEVICE]: { delivery_interval_minutes: 10 } }),
    '2026-10-18T00:00:00.000Z', 1,
  ]);
  await value.db.run(`INSERT INTO valve_schedules(
    schedule_uuid,device_eui,kind,weekdays_mask,start_time,duration_minutes,timezone,enabled,
    sync_version,condition_policy_uuid,effective_from
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
    scheduleUuid, DEVICE, 'WEEKLY', weekday, due.toISOString().slice(11, 16), durationMinutes, 'UTC', 1, 1,
    policyUuid, '2026-10-18T00:00:00.000Z',
  ]);
  const raw = {
    raw_evidence: {
      version: 1,
      analysis: { computed_at: computedAt, ...recommendation },
    },
    raw_decision: { version: 1, computed_at: computedAt },
  };
  await value.db.run(`INSERT INTO zone_daily_recommendations(
    zone_id,date,zone_stress_summary,irrigation_action,recommendation_json,computed_at,usable_tree_count
  ) VALUES (?,?,?,?,?,?,?)`, [1, due.toISOString().slice(0, 10), recommendation.stress || null,
    recommendation.action || null, JSON.stringify(raw), computedAt, recommendation.usable_tree_count || null]);
  await value.db.run('INSERT INTO valve_settings(device_eui,strega_generation,conditional_control_json) VALUES (?,?,?)', [DEVICE, 'GEN2', JSON.stringify({
    desired_revision: 'rev-1', generation: 'GEN2', required_push_ids: ['push-1'], readiness: { state: ready ? 'READY' : 'PENDING' },
  })]);
  await value.db.run(`INSERT INTO valve_schedule_pushes(push_id,device_eui,purpose,weekday,fport,payload_hex,state)
    VALUES (?,?,?,?,?,?,?)`, ['push-1', DEVICE, 'DAYMASK_PLAN', null, 25, '80', ready ? 'ACKED' : 'QUEUED']);
  if (legacyEnabled !== null) {
    await value.db.run(`INSERT INTO irrigation_schedules(
      irrigation_zone_id,trigger_metric,threshold_kpa,enabled,created_at,updated_at,duration_minutes,response_mode,sync_version
    ) VALUES (?,?,?,?,?,?,?,?,?)`, [1, 'DENDRO', 20, legacyEnabled, dueAt, dueAt, durationMinutes, 'fixed', 1]);
  }
  return value;
}

async function insertLegacyOnlyFixture(value) {
  await value.db.run("INSERT INTO irrigation_zones(id,name,user_id,timezone,zone_uuid) VALUES (1,'North',1,'UTC','zone-1')");
  await value.db.run('UPDATE devices SET irrigation_zone_id=1 WHERE deveui=?', [DEVICE]);
  await value.db.run(`INSERT INTO irrigation_schedules(
    irrigation_zone_id,trigger_metric,threshold_kpa,enabled,created_at,updated_at,duration_minutes,response_mode,sync_version
  ) VALUES (?,?,?,?,?,?,?,?,?)`, [1, 'DENDRO', 20, 1, '2026-10-18T00:00:00.000Z', '2026-10-18T00:00:00.000Z', 5, 'fixed', 1]);
  await value.db.run('INSERT INTO valve_settings(device_eui,strega_generation) VALUES (?,?)', [DEVICE, 'GEN2']);
  return value;
}

function workerOptions(value, {
  now = NOW, clock = () => ({ trusted: true, reason: 'fixture_trusted' }), qualificationProvider,
  transport, readEvidence,
} = {}) {
  return {
    db: value.db, now, clockOptions: clockOptions(now), clock,
    qualificationProvider, transport: transport || transportRecorder(),
    readEvidence: readEvidence || ((input) => observations.readEvidence(input)),
  };
}

async function runLegacySchedulerTick(value, transport) {
  const query = await executeFunction(loadNode('a0a61f4b7dca1c2e'), { msg: {}, db: value.raw });
  const zones = await value.db.all(query.result.topic);
  for (const zone of zones) {
    const evidenceQuery = await executeFunction(loadNode('d0b2b1c1a937e16d'), { msg: { payload: zone }, db: value.raw });
    const evidence = await value.db.all(evidenceQuery.result.topic);
    const decision = await executeFunction(loadNode('5f0d2b7e9b9b1b3a'), {
      msg: { ...evidenceQuery.result, payload: evidence }, db: value.raw,
    });
    const actuator = decision.result && decision.result[0];
    if (!actuator || !actuator.payload || !actuator.payload.data) continue;
    const data = actuator.payload.data;
    const durationMinutes = Number(data.duration_minutes);
    await dispatch.executeValveAttempt({
      db: value.db, deviceEui: zone.valve_deveui,
      command: {
        device_eui: zone.valve_deveui, command_id: `legacy-trigger-${zone.zone_id}`,
        action: data.action, duration_minutes: durationMinutes,
      },
      frame: timedFrame(durationMinutes), transport, now: NOW,
      trustedContext: trustedAttemptContext(NOW),
    });
  }
  return zones;
}

function timedFrame(durationMinutes = 5) {
  return {
    fPort: 2,
    data: Buffer.from([0x41, durationMinutes]).toString('base64'),
    confirmed: false,
    encrypted: false,
    provenance: { source: 'local_encoder', encoder: 'strega-v1' },
  };
}

function safeCloseFrame() {
  return { fPort: 1, data: 'MA==', confirmed: false, encrypted: false, provenance: { source: 'local_encoder' } };
}

function trustedAttemptContext(at = NOW) {
  return { runtimeNow: () => Date.parse(at), clockOptions: clockOptions(at) };
}

function untrustedAttemptContext(at = NOW) {
  return { runtimeNow: () => Date.parse(at), clockOptions: clockOptions(at, { trusted: false }) };
}

test('persistent conditional conversion clears the legacy plan once and settles the GEN2 ACK', async () => {
  const value = await tempDb();
  const transport = transportRecorder({ label: 'clear' });
  try {
    await insertConditionalFixture(value, { legacyEnabled: 0 });
    const prepared = await push.prepareClearRevision({ db: value.db, deviceEui: DEVICE, generation: 'GEN2', now: '2026-10-19T06:00:00.000Z', reason: 'conversion' });
    assert.equal(prepared.rows.length, 1);
    assert.equal(prepared.rows[0].payload_hex, '80');
    const transportNow = new Date().toISOString();
    const sent = await push.sendPreparedRevision({ db: value.db, deviceEui: DEVICE, revision: prepared.revision, transport, now: transportNow });
    assert.equal(sent.sent, 1);
    assert.equal(transport.calls.enqueue.length, 1);
    reopen(value);
    const attempted = await value.db.get("SELECT transport_json FROM valve_schedule_pushes WHERE state='QUEUED' AND purpose='DAYMASK_PLAN' ORDER BY rowid DESC LIMIT 1");
    const ackAt = JSON.parse(attempted.transport_json).attempted_at;
    const ack = await valveWorkers.handleUplink({ db: value.db, deviceEui: DEVICE, decoded: { Ack_Port: 25, Ack_Value: 1 }, receivedAt: ackAt });
    assert.equal(ack.acked, 1);
    reopen(value);
    const control = JSON.parse((await value.db.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', [DEVICE])).conditional_control_json);
    assert.equal(control.readiness.state, 'READY');
    assert.equal((await value.db.get("SELECT COUNT(*) AS n FROM valve_schedule_pushes WHERE state='ACKED'", [])).n, 2);
    assert.equal((await value.db.get('SELECT enabled FROM irrigation_schedules WHERE irrigation_zone_id=1')).enabled, 0);
  } finally {
    closeFixture(value);
  }
});

test('actual policy edit conversion disables legacy scheduling, settles the clear, then executes and reconciles on the same reopened DB', async () => {
  const value = await tempDb();
  const conversionTransport = transportRecorder({ label: 'api-conversion' });
  try {
    await insertLegacyOnlyFixture(value);
    const conversion = await policyApi.applyPolicyEdit({
      db: value.db,
      actor: { user_id: 1 },
      now: '2026-10-19T05:00:00.000Z',
      runtimeClockStatus: () => ({ trusted: true, reason: 'fixture_trusted' }),
      qualificationProvider: () => ({ qualified: true, identity: 'task9a-qualified', margin_seconds: 0 }),
      transport: conversionTransport,
      request: {
        zone_uuid: 'zone-1', expected_policy_version: null,
        condition: { kind: 'DENDRO', minimum_stress: 'mild', response_mode: 'fixed' },
        timezone: 'UTC', enabled: true, observation_window_minutes: 60,
        min_interval_minutes: 60, max_daily_minutes: 240,
        schedules: [{ device_eui: DEVICE, weekdays_mask: 2, start_time: '06:00', duration_minutes: 5, enabled: true, execution: 'conditional', expected_sync_version: null }],
      },
    });
    assert.equal(conversion.status, 202);
    assert.equal(conversion.revision_results.length, 1);
    assert.equal(conversionTransport.calls.enqueue.length, 1);
    const policy = await value.db.get('SELECT policy_uuid,sync_version,enabled FROM irrigation_policies WHERE zone_uuid=?', ['zone-1']);
    const schedule = await value.db.get('SELECT schedule_uuid,condition_policy_uuid,enabled FROM valve_schedules WHERE device_eui=?', [DEVICE]);
    assert.equal(policy.enabled, 1);
    assert.equal(schedule.condition_policy_uuid, policy.policy_uuid);
    assert.equal((await value.db.get('SELECT enabled FROM irrigation_schedules WHERE irrigation_zone_id=1')).enabled, 0);
    const pendingPush = await value.db.get("SELECT transport_json FROM valve_schedule_pushes WHERE state='QUEUED' AND purpose='DAYMASK_PLAN' ORDER BY rowid DESC LIMIT 1");
    const ackAt = JSON.parse(pendingPush.transport_json).attempted_at;
    const ack = await valveWorkers.handleUplink({ db: value.db, deviceEui: DEVICE, decoded: { Ack_Port: 25, Ack_Value: 1 }, receivedAt: ackAt });
    assert.equal(ack.acked, 1);
    reopen(value);
    const recommendation = { raw_evidence: { version: 1, analysis: { computed_at: '2026-10-19T05:59:00.000Z', stress: 'mild', action: 'increase_10', usable_tree_count: 1 } }, raw_decision: { version: 1, computed_at: '2026-10-19T05:59:00.000Z' } };
    await value.db.run(`INSERT INTO zone_daily_recommendations(zone_id,date,zone_stress_summary,irrigation_action,recommendation_json,computed_at,usable_tree_count)
      VALUES (?,?,?,?,?,?,?)`, [1, '2026-10-19', 'mild', 'increase_10', JSON.stringify(recommendation), '2026-10-19T05:59:00.000Z', 1]);
    const dueTransport = transportRecorder({ label: 'converted-open' });
    const due = await worker.runDue(workerOptions(value, {
      transport: dueTransport,
      qualificationProvider: () => ({ qualified: true, identity: 'task9a-qualified', margin_seconds: 0 }),
    }));
    assert.equal(due.dispatched, 1);
    assert.equal(dueTransport.calls.enqueue.length, 1);
    const occurrence = await value.db.get('SELECT command_id,state,expires_at,decision_at,decision_evidence_json FROM irrigation_occurrences WHERE schedule_uuid=?', [schedule.schedule_uuid]);
    assert.equal(occurrence.state, 'SENT');
    assert.ok(occurrence.decision_at);
    assert.ok(JSON.parse(occurrence.decision_evidence_json));
    const downlink = dueTransport.calls.enqueue[0];
    assert.equal(downlink.devEui, DEVICE);
    assert.equal(downlink.fPort, 2);
    assert.equal(downlink.data, Buffer.from([0x41, 0x05]).toString('base64'));
    assert.equal(downlink.expiresAt, occurrence.expires_at);
    const owner = await value.db.get('SELECT expectation_id,command_id,commanded_at,commanded_duration_seconds,expected_close_at,reconciliation_state FROM valve_actuation_expectations WHERE command_id=?', [occurrence.command_id]);
    assert.ok(owner);
    assert.equal(owner.command_id, occurrence.command_id);
    assert.equal(owner.commanded_duration_seconds, 300);
    assert.equal(Date.parse(owner.expected_close_at) - Date.parse(owner.commanded_at), 300000);
    assert.equal(owner.reconciliation_state, 'PENDING_OBSERVATION');
    const legacyZones = await runLegacySchedulerTick(value, dueTransport);
    assert.equal(legacyZones.length, 0);
    assert.equal(dueTransport.calls.enqueue.length, 1);
    const openAt = '2026-10-19T06:05:30.000Z';
    const closeAt = '2026-10-19T06:10:30.000Z';
    await valveWorkers.recordValveObservation({ db: value.db, deviceEui: DEVICE, observedState: 'OPEN', observedAt: openAt, event_identity: { uplink: 'converted-open' }, runtimeContext: trustedAttemptContext(openAt) });
    reopen(value);
    await valveWorkers.recordValveObservation({ db: value.db, deviceEui: DEVICE, observedState: 'CLOSED', observedAt: closeAt, event_identity: { uplink: 'converted-close' }, runtimeContext: trustedAttemptContext(closeAt) });
    reopen(value);
    const final = await value.db.get('SELECT observed_open_at,observed_close_at FROM irrigation_occurrences WHERE schedule_uuid=?', [schedule.schedule_uuid]);
    assert.equal(final.observed_open_at, openAt);
    assert.equal(final.observed_close_at, closeAt);
    const history = await policyApi.listDecisions({ db: value.db, actor: { user_id: 1 }, zone: 'zone-1', limit: 100 });
    assert.equal(history.decisions.length, 1);
    assert.equal(history.decisions[0].command_id, occurrence.command_id);
    assert.equal(history.decisions[0].decision, 'IRRIGATE');
    assert.equal(history.decisions[0].decision_evidence.evaluation.status, 'MET');
  } finally {
    closeFixture(value);
  }
});

test('one due conditional decision survives restart, dispatches once, records both endpoints, and replays idempotently', async () => {
  const value = await tempDb();
  const transport = transportRecorder({ label: 'open' });
  try {
    await insertConditionalFixture(value, { dueAt: '2026-10-19T06:00:00.000Z', ready: true });
    const result = await worker.runDue(workerOptions(value, {
      qualificationProvider: () => ({ qualified: true, identity: 'task9a-qualified', margin_seconds: 0 }),
      transport,
    }));
    assert.equal(result.dispatched, 1);
    assert.equal(transport.calls.enqueue.length, 1);
    const sent = await value.db.get('SELECT * FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
    assert.equal(sent.state, 'SENT');
    assert.equal(sent.decision, 'IRRIGATE');
    assert.ok(sent.decision_at);
    assert.ok(JSON.parse(sent.decision_evidence_json));
    assert.ok(sent.command_id);
    reopen(value);
    const replay = await worker.runDue(workerOptions(value, {
      qualificationProvider: () => ({ qualified: true, identity: 'task9a-qualified', margin_seconds: 0 }),
      transport,
    }));
    assert.equal(replay.dispatched, 0);
    assert.equal(transport.calls.enqueue.length, 1);
    const openAt = '2026-10-19T06:05:30.000Z';
    const closeAt = '2026-10-19T06:10:30.000Z';
    const runtimeContext = (at) => ({ runtimeNow: () => Date.parse(at), clockOptions: clockOptions(at) });
    const opened = await valveWorkers.recordValveObservation({ db: value.db, deviceEui: DEVICE, observedState: 'OPEN', observedAt: openAt, event_identity: { uplink: 'open-1' }, runtimeContext: runtimeContext(openAt) });
    assert.equal(opened.kind, 'owner');
    reopen(value);
    const closed = await valveWorkers.recordValveObservation({ db: value.db, deviceEui: DEVICE, observedState: 'CLOSED', observedAt: closeAt, event_identity: { uplink: 'close-1' }, runtimeContext: runtimeContext(closeAt) });
    assert.equal(closed.kind, 'closed');
    reopen(value);
    const finalOccurrence = await value.db.get('SELECT state,decision,observed_open_at,observed_close_at FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
    const expectation = await value.db.get('SELECT reconciliation_state,observed_open_at,observed_close_at FROM valve_actuation_expectations WHERE command_id=?', [sent.command_id]);
    assert.equal(finalOccurrence.state, 'SENT');
    assert.equal(finalOccurrence.decision, 'IRRIGATE');
    assert.equal(finalOccurrence.observed_open_at, openAt);
    assert.equal(finalOccurrence.observed_close_at, closeAt);
    assert.equal(expectation.reconciliation_state, 'OBSERVED_COMPLETE');
  } finally {
    closeFixture(value);
  }
});

test('false, missing, and DENDRO hold evidence persist a non-actuating decision', async (t) => {
  const cases = [
    ['false condition', { stress: 'mild', action: 'maintain_rain_suppression', usable_tree_count: 1 }, 'dendro_hold', 'NOT_MET'],
    ['missing evidence', { stress: 'mild', action: 'increase_10', usable_tree_count: 0 }, 'sensor_unavailable', 'UNKNOWN'],
    ['recovery hold', { stress: 'mild', action: 'maintain_recovery_hold', usable_tree_count: 1 }, 'dendro_hold', 'NOT_MET'],
  ];
  for (const [label, recommendation, expectedReason, expectedDecision] of cases) {
    await t.test(label, async () => {
      const value = await tempDb();
      const transport = transportRecorder({ label: `skip-${label}` });
      try {
        await insertConditionalFixture(value, { dueAt: '2026-10-19T06:00:00.000Z', recommendation });
        const result = await worker.runDue(workerOptions(value, {
          qualificationProvider: () => ({ qualified: true, identity: 'task9a-qualified', margin_seconds: 0 }),
          transport,
        }));
        assert.equal(result.dispatched, 0);
        assert.equal(result.skipped, 1);
        assert.equal(transport.calls.enqueue.length, 0);
        const row = await value.db.get('SELECT state,decision,decision_reason,decision_evidence_json FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
        assert.equal(row.state, 'SKIPPED');
        assert.equal(row.decision, expectedDecision);
        assert.equal(row.decision_reason, expectedReason);
        assert.ok(JSON.parse(row.decision_evidence_json));
        reopen(value);
        const reopened = await value.db.get('SELECT state,decision,decision_reason,decision_evidence_json FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
        assert.equal(reopened.state, 'SKIPPED');
        assert.equal(reopened.decision, expectedDecision);
        assert.equal(reopened.decision_reason, expectedReason);
        const reopenedEvidence = JSON.parse(reopened.decision_evidence_json);
        assert.equal(reopenedEvidence.evaluation.status, expectedDecision);
        assert.equal(reopenedEvidence.reason, expectedReason);
        const replay = await worker.runDue(workerOptions(value, {
          qualificationProvider: () => ({ qualified: true, identity: 'task9a-qualified', margin_seconds: 0 }),
          transport,
        }));
        assert.equal(replay.dispatched, 0);
        assert.equal(transport.calls.enqueue.length, 0);
      } finally {
        closeFixture(value);
      }
    });
  }
});

test('soil evidence accepts both SQLite space and UTC ISO recorded_at forms', async () => {
  const value = await tempDb();
  const sensor = '0016C001F1000002';
  const transport = transportRecorder({ label: 'swt' });
  try {
    await insertConditionalFixture(value, { condition: 'SWT', dueAt: '2026-10-19T06:00:00.000Z' });
    await value.db.run(`INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`, [sensor, 'Kiwi soil sensor', 'KIWI_SENSOR', 1, 1, NOW, NOW]);
    await value.db.run('UPDATE irrigation_policies SET condition_json=? WHERE policy_uuid=?', [JSON.stringify({
      kind: 'SWT', threshold_kpa: 20, sources: [{ device_eui: sensor, channel: 'swt_1' }],
    }), 'policy-1']);
    await value.db.run('INSERT INTO device_data(deveui,swt_1,recorded_at) VALUES (?,?,?)', [sensor, 25, '2026-10-19 05:59:00']);
    await value.db.run('INSERT INTO device_data(deveui,swt_1,recorded_at) VALUES (?,?,?)', [sensor, 25, '2026-10-19T06:00:00.000Z']);
    const result = await worker.runDue(workerOptions(value, {
      qualificationProvider: () => ({ qualified: true, identity: 'task9a-qualified', margin_seconds: 0 }),
      transport,
    }));
    assert.equal(result.dispatched, 1);
    assert.equal(transport.calls.enqueue.length, 1);
    const row = await value.db.get('SELECT decision_evidence_json FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
    const evidence = JSON.stringify(JSON.parse(row.decision_evidence_json));
    assert.match(evidence, /2026-10-19T05:59:00\.000Z/);
    assert.match(evidence, /2026-10-19T06:00:00\.000Z/);
  } finally {
    closeFixture(value);
  }
});

test('untrusted clock leaves no claim, restart recovery dispatches once, and the immutable cutoff rejects a late start', async (t) => {
  await t.test('clock recovery after close/reopen', async () => {
    const value = await tempDb();
    const transport = transportRecorder({ label: 'clock-recovery' });
    try {
      await insertConditionalFixture(value, { dueAt: '2026-10-19T06:00:00.000Z' });
      const rejected = await worker.runDue(workerOptions(value, {
        clock: () => ({ trusted: false, reason: 'clock_untrusted_reboot' }),
        qualificationProvider: () => ({ qualified: true, identity: 'task9a-qualified', margin_seconds: 0 }),
        transport,
      }));
      assert.equal(rejected.trusted, false);
      assert.equal(rejected.processed, 0);
      assert.equal(transport.calls.enqueue.length, 0);
      assert.equal((await value.db.get('SELECT COUNT(*) AS n FROM irrigation_occurrences')).n, 0);
      reopen(value);
      const recovered = await worker.runDue(workerOptions(value, {
        clock: () => ({ trusted: true, reason: 'clock_recovered' }),
        qualificationProvider: () => ({ qualified: true, identity: 'task9a-qualified', margin_seconds: 0 }),
        transport,
      }));
      assert.equal(recovered.dispatched, 1);
      assert.equal(transport.calls.enqueue.length, 1);
    } finally {
      closeFixture(value);
    }
  });

  await t.test('one millisecond after the ten minute window is missed', async () => {
    const value = await tempDb();
    const transport = transportRecorder({ label: 'missed-start' });
    try {
      await insertConditionalFixture(value, { dueAt: '2026-10-19T06:00:00.000Z' });
      const result = await worker.runDue(workerOptions(value, {
        now: '2026-10-19T06:10:00.001Z',
        clock: () => ({ trusted: true, reason: 'clock_trusted' }),
        qualificationProvider: () => ({ qualified: true, identity: 'task9a-qualified', margin_seconds: 0 }),
        transport,
      }));
      assert.equal(result.dispatched, 0);
      assert.equal(result.skipped, 1);
      assert.equal(transport.calls.enqueue.length, 0);
      const row = await value.db.get('SELECT state,decision,decision_reason,decision_evidence_json FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
      assert.equal(row.state, 'SKIPPED');
      assert.equal(row.decision, 'SKIPPED');
      assert.equal(row.decision_reason, 'missed_start');
      assert.equal(JSON.parse(row.decision_evidence_json).reason, 'missed_start');
      reopen(value);
      const reopened = await value.db.get('SELECT state,decision,decision_reason,decision_evidence_json FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
      assert.equal(reopened.state, 'SKIPPED');
      assert.equal(reopened.decision, 'SKIPPED');
      assert.equal(reopened.decision_reason, 'missed_start');
      assert.equal(JSON.parse(reopened.decision_evidence_json).reason, 'missed_start');
    } finally {
      closeFixture(value);
    }
  });
});

test('pending timed owner blocks destructive queue flush, manual races stay fenced, and replay does not enqueue twice', async () => {
  const value = await tempDb();
  const openTransport = transportRecorder({ label: 'manual-open' });
  const clearTransport = transportRecorder({ label: 'clear-with-pending-open' });
  try {
    await insertConditionalFixture(value, { dueAt: '2026-10-19T06:00:00.000Z' });
    const frame = timedFrame(5);
    const command = { device_eui: DEVICE, command_id: 'manual-race-1', action: 'OPEN_FOR_DURATION', duration_minutes: 5 };
    const first = await dispatch.executeValveAttempt({
      db: value.db, deviceEui: DEVICE, command, frame, transport: openTransport, now: NOW,
      trustedContext: trustedAttemptContext(),
    });
    assert.equal(first.accepted, true);
    assert.equal(openTransport.calls.enqueue.length, 1);
    const replay = await dispatch.executeValveAttempt({
      db: value.db, deviceEui: DEVICE, command, frame, transport: openTransport, now: NOW,
      trustedContext: trustedAttemptContext(),
    });
    assert.equal(replay.replayed, true);
    assert.equal(openTransport.calls.enqueue.length, 1);
    await assert.rejects(() => dispatch.executeValveAttempt({
      db: value.db, deviceEui: DEVICE,
      command: { device_eui: DEVICE, command_id: 'manual-race-2', action: 'OPEN_FOR_DURATION', duration_minutes: 5 },
      frame, transport: openTransport, now: NOW, trustedContext: trustedAttemptContext(),
    }), (error) => error && error.code === 'valve_busy');
    const prepared = await push.prepareClearRevision({ db: value.db, deviceEui: DEVICE, generation: 'GEN2', now: NOW, reason: 'pending-owner-clear' });
    const cleared = await push.sendPreparedRevision({ db: value.db, deviceEui: DEVICE, revision: prepared.revision, transport: clearTransport, now: NOW });
    assert.equal(cleared.sent, 0);
    assert.equal(cleared.readiness.state, 'BLOCKED');
    assert.equal(clearTransport.calls.flush, 0);
    assert.equal(clearTransport.calls.enqueue.length, 0);
    const owner = await value.db.get('SELECT reconciliation_state FROM valve_actuation_expectations WHERE command_id=?', ['manual-race-1']);
    assert.equal(owner.reconciliation_state, 'PENDING_OBSERVATION');
  } finally {
    closeFixture(value);
  }
});

test('effect timing contracts require endpoints or a trusted bounded horizon, while safe CLOSE stays unbounded', async () => {
  const frame = timedFrame(5);
  const qualified = { qualified: true, identity: 'task9a-qualified', margin_seconds: 30 };
  const snapshot = effects.buildEffectSnapshot({
    frame, device_eui: DEVICE, anchor_at: NOW, interval_minutes: 10, interval_source: 'policy',
    capturedQualification: qualified, minimum_gap_minutes: 5,
  });
  assert.equal(snapshot.effect_class, effects.EFFECTS.SELF_CLOSING_OPEN);
  assert.equal(snapshot.allowance_minutes, 31);
  assert.equal(snapshot.queue_expires_at, '2026-10-19T06:35:30.000Z');
  const beforeHorizon = effects.observationState(snapshot, {
    now: '2026-10-19T06:06:00.000Z', current_state: 'CLOSED', current_state_at: '2026-10-19T06:06:00.000Z',
    clockOptions: clockOptions('2026-10-19T06:06:00.000Z'), qualificationProvider: () => qualified,
  });
  assert.equal(beforeHorizon.blocks, true);
  const afterHorizonAt = snapshot.exclusion_end_at;
  assert.equal(effects.canReleaseByHorizon(snapshot, {
    now: afterHorizonAt, clockOptions: clockOptions(afterHorizonAt), qualificationProvider: () => qualified,
  }), true);
  const afterHorizon = effects.observationState(snapshot, {
    now: afterHorizonAt, current_state: 'CLOSED', current_state_at: afterHorizonAt,
    clockOptions: clockOptions(afterHorizonAt), qualificationProvider: () => qualified,
  });
  assert.equal(afterHorizon.blocks, false);
  assert.equal(effects.observationState(snapshot, {
    now: afterHorizonAt, current_state: 'CLOSED', current_state_at: afterHorizonAt,
    clockOptions: clockOptions(afterHorizonAt), qualificationProvider: () => ({ qualified: false, reason: 'revoked' }),
  }).blocks, true);
  const explicit = effects.buildEffectSnapshot({
    frame, device_eui: DEVICE, anchor_at: NOW, interval_minutes: 10, interval_source: 'policy',
    capturedQualification: qualified, explicit_expiry_at: '2026-10-19T06:20:00.000Z',
  });
  assert.equal(explicit.timing_contract, undefined);
  assert.equal(explicit.explicit_expiry_at, '2026-10-19T06:20:00.000Z');

  const safeFrame = { fPort: 1, data: 'MA==', confirmed: false, encrypted: false, provenance: { source: 'local_encoder' } };
  const safe = effects.buildUnboundedSafeCloseSnapshot({ frame: safeFrame, device_eui: DEVICE, reservation_receipt: { boot_id: 'task9a-boot', uptime_ms: 100000 } });
  assert.equal(safe.timing_contract, effects.UNBOUNDED_SAFE_CLOSE_V1);
  assert.equal(safe.finite_release, false);
  assert.equal(effects.canReleaseByHorizon(safe, { now: '2030-01-01T00:00:00.000Z', clockOptions: clockOptions('2030-01-01T00:00:00.000Z'), qualificationProvider: () => qualified }), false);
  assert.equal(effects.buildEffectSnapshot({ frame: safeFrame, device_eui: DEVICE, anchor_at: NOW, explicit_expiry_at: '2026-10-19T06:20:00.000Z' }).timing_contract, undefined);

  const value = await tempDb();
  try {
    const openTransport = transportRecorder({ label: 'hazard-owner' });
    await dispatch.executeValveAttempt({ db: value.db, deviceEui: DEVICE,
      command: { device_eui: DEVICE, command_id: 'hazard-owner-1', action: 'OPEN_FOR_DURATION', duration_minutes: 5 },
      frame, transport: openTransport, now: NOW, trustedContext: trustedAttemptContext() });
    const closeTransport = transportRecorder({ label: 'safe-close' });
    const closeResult = await dispatch.executeValveAttempt({ db: value.db, deviceEui: DEVICE,
      command: { device_eui: DEVICE, command_id: 'safe-close-1', action: 'CLOSE' },
      frame: safeFrame, transport: closeTransport, now: NOW, trustedContext: untrustedAttemptContext() });
    assert.equal(closeResult.accepted, true);
    const safeOwner = await value.db.get("SELECT transport_json FROM valve_actuation_expectations WHERE command_id='safe-close-1'");
    assert.equal(JSON.parse(safeOwner.transport_json).effect_snapshot.timing_contract, effects.UNBOUNDED_SAFE_CLOSE_V1);
    const closedAt = '2026-10-19T06:06:00.000Z';
    const observed = await dispatch.observeClosedEvidence({ db: value.db, deviceEui: DEVICE, observedState: 'CLOSED', observedAt: closedAt, event_identity: { uplink: 'safe-close-1' }, runtimeContext: trustedAttemptContext(closedAt) });
    assert.equal(observed.observed, true);
    assert.equal(observed.quiesced.length, 1);
    const hazardous = await value.db.get("SELECT reconciliation_state FROM valve_actuation_expectations WHERE command_id='hazard-owner-1'");
    const safeState = await value.db.get("SELECT reconciliation_state FROM valve_actuation_expectations WHERE command_id='safe-close-1'");
    assert.equal(hazardous.reconciliation_state, 'PENDING_OBSERVATION');
    assert.equal(safeState.reconciliation_state, 'OBSERVED_CLOSED');
  } finally {
    closeFixture(value);
  }
});

test('real dispatch and observation producers retain endpoint, cutoff, receipt, and incident contracts', async (t) => {
  await t.test('missing, open-only, and close-only timed endpoints remain unresolved after reopen', async () => {
    for (const [label, observation] of [
      ['missing', null],
      ['open-only', 'OPEN'],
      ['close-only', 'CLOSED'],
    ]) {
      const value = await tempDb();
      const transport = transportRecorder({ label: `endpoint-${label}` });
      try {
        const commandId = `endpoint-${label}`;
        const sent = await dispatch.executeValveAttempt({
          db: value.db, deviceEui: DEVICE,
          command: { device_eui: DEVICE, command_id: commandId, action: 'OPEN_FOR_DURATION', duration_minutes: 5 },
          frame: timedFrame(5), transport, now: NOW, trustedContext: trustedAttemptContext(NOW),
        });
        assert.equal(sent.accepted, true);
        assert.equal(transport.calls.enqueue.length, 1);
        if (observation) {
          const observedAt = observation === 'OPEN' ? '2026-10-19T06:05:30.000Z' : '2026-10-19T06:05:31.000Z';
          const result = await valveWorkers.recordValveObservation({
            db: value.db, deviceEui: DEVICE, observedState: observation, observedAt,
            event_identity: { uplink: `${commandId}-observation` }, runtimeContext: trustedAttemptContext(observedAt),
          });
          assert.equal(result.kind, observation === 'OPEN' ? 'owner' : 'closed');
        }
        reopen(value);
        const owner = await value.db.get('SELECT observed_open_at,observed_close_at,reconciliation_state FROM valve_actuation_expectations WHERE command_id=?', [commandId]);
        assert.ok(owner);
        if (label === 'missing') {
          assert.equal(owner.observed_open_at, null);
          assert.equal(owner.observed_close_at, null);
          assert.equal(owner.reconciliation_state, 'PENDING_OBSERVATION');
        } else if (label === 'open-only') {
          assert.equal(owner.observed_open_at, '2026-10-19T06:05:30.000Z');
          assert.equal(owner.observed_close_at, null);
          assert.equal(owner.reconciliation_state, 'OBSERVED_RUNNING');
        } else {
          assert.equal(owner.observed_open_at, null);
          assert.equal(owner.observed_close_at, null);
          assert.equal(owner.reconciliation_state, 'PENDING_OBSERVATION');
        }
      } finally {
        closeFixture(value);
      }
    }
  });

  await t.test('explicit-expiry CLOSE is produced by real dispatch without the unbounded variant', async () => {
    const value = await tempDb();
    const transport = transportRecorder({ label: 'explicit-close' });
    try {
      const result = await dispatch.executeValveAttempt({
        db: value.db, deviceEui: DEVICE,
        command: { device_eui: DEVICE, command_id: 'explicit-close', action: 'CLOSE', expires_at: '2026-10-19T06:20:00.000Z' },
        frame: safeCloseFrame(), transport, now: NOW, trustedContext: trustedAttemptContext(NOW),
      });
      assert.equal(result.accepted, true);
      assert.equal(result.snapshot.timing_contract, undefined);
      assert.equal(result.snapshot.explicit_expiry_at, '2026-10-19T06:20:00.000Z');
      assert.notEqual(result.snapshot.timing_contract, effects.UNBOUNDED_SAFE_CLOSE_V1);
      assert.equal(transport.calls.enqueue[0].fPort, 1);
      assert.equal(transport.calls.enqueue[0].data, 'MA==');
      assert.equal(transport.calls.enqueue[0].expiresAt, '2026-10-19T06:20:00.000Z');
      reopen(value);
      const persisted = await value.db.get("SELECT transport_json FROM valve_actuation_expectations WHERE command_id='explicit-close'");
      const transportState = JSON.parse(persisted.transport_json);
      assert.equal(transportState.effect_snapshot.timing_contract, undefined);
      assert.equal(transportState.effect_snapshot.explicit_expiry_at, '2026-10-19T06:20:00.000Z');
    } finally {
      closeFixture(value);
    }
  });

  await t.test('safe CLOSE receipt attribution rejects stale and wrong-boot events, then quiesces both owners after reopen', async () => {
    const value = await tempDb();
    const transport = transportRecorder({ label: 'receipt-close' });
    const closeAt = '2026-10-19T06:05:00.000Z';
    const closeContext = (at, options) => ({ runtimeNow: () => Date.parse(at), clockOptions: clockOptions(at, options) });
    try {
      for (const [commandId, at, uptimeMs] of [
        ['safe-close-a', closeAt, 100000],
        ['safe-close-b', '2026-10-19T06:05:01.000Z', 101000],
      ]) {
        const result = await dispatch.executeValveAttempt({
          db: value.db, deviceEui: DEVICE,
          command: { device_eui: DEVICE, command_id: commandId, action: 'CLOSE' },
          frame: safeCloseFrame(), transport, now: at,
          trustedContext: closeContext(at, { trusted: false, bootId: 'task9a-close-boot', uptimeMs }),
        });
        assert.equal(result.accepted, true);
      }
      reopen(value);
      const stale = await dispatch.observeClosedEvidence({
        db: value.db, deviceEui: DEVICE, observedState: 'CLOSED', observedAt: '2026-10-19T06:04:00.000Z',
        event_identity: { uplink: 'stale-close' },
        runtimeContext: closeContext('2026-10-19T06:05:02.000Z', { trusted: true, bootId: 'task9a-close-boot', uptimeMs: 102000 }),
      });
      assert.equal(stale.observed, true);
      assert.equal(stale.quiesced.length, 0);
      reopen(value);
      const staleRows = await value.db.all("SELECT reconciliation_state FROM valve_actuation_expectations WHERE command_id LIKE 'safe-close-%' ORDER BY command_id");
      assert.deepEqual(staleRows.map((row) => row.reconciliation_state), ['PENDING_OBSERVATION', 'PENDING_OBSERVATION']);
      const wrongBoot = await dispatch.observeClosedEvidence({
        db: value.db, deviceEui: DEVICE, observedState: 'CLOSED', observedAt: '2026-10-19T06:05:02.000Z',
        event_identity: { uplink: 'wrong-boot-close' },
        runtimeContext: closeContext('2026-10-19T06:05:02.000Z', { trusted: true, bootId: 'task9a-wrong-boot', uptimeMs: 102000 }),
      });
      assert.equal(wrongBoot.observed, true);
      assert.equal(wrongBoot.quiesced.length, 0);
      reopen(value);
      const correct = await dispatch.observeClosedEvidence({
        db: value.db, deviceEui: DEVICE, observedState: 'CLOSED', observedAt: '2026-10-19T06:05:03.000Z',
        event_identity: { uplink: 'same-boot-close' },
        runtimeContext: closeContext('2026-10-19T06:05:03.000Z', { trusted: true, bootId: 'task9a-close-boot', uptimeMs: 103000 }),
      });
      assert.equal(correct.observed, true);
      assert.equal(correct.quiesced.length, 2);
      reopen(value);
      const closedRows = await value.db.all("SELECT reconciliation_state,observed_close_at FROM valve_actuation_expectations WHERE command_id LIKE 'safe-close-%' ORDER BY command_id");
      assert.deepEqual(closedRows.map((row) => row.reconciliation_state), ['OBSERVED_CLOSED', 'OBSERVED_CLOSED']);
      assert.deepEqual(closedRows.map((row) => row.observed_close_at), ['2026-10-19T06:05:03.000Z', '2026-10-19T06:05:03.000Z']);
    } finally {
      closeFixture(value);
    }
  });

  await t.test('report-only observation creates one incident and reconciles it across reopen', async () => {
    const value = await tempDb();
    try {
      await insertConditionalFixture(value, { legacyEnabled: 0 });
      const opened = await valveWorkers.recordValveObservation({
        db: value.db, deviceEui: DEVICE, observedState: 'OPEN', observedAt: '2026-10-19T06:05:00.000Z',
        event_identity: { uplink: 'incident-open' }, runtimeContext: trustedAttemptContext('2026-10-19T06:05:00.000Z'),
      });
      assert.equal(opened.kind, 'synthetic');
      reopen(value);
      const openControl = JSON.parse((await value.db.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', [DEVICE])).conditional_control_json);
      assert.equal(openControl.incident.state, 'OPEN');
      const reportOnly = await value.db.get("SELECT reconciliation_state,trigger FROM valve_actuation_expectations WHERE device_eui=? AND command_id IS NULL ORDER BY rowid DESC LIMIT 1", [DEVICE]);
      assert.equal(reportOnly.reconciliation_state, 'OBSERVED_RUNNING');
      assert.equal(reportOnly.trigger, 'unexplained');
      const closed = await valveWorkers.recordValveObservation({
        db: value.db, deviceEui: DEVICE, observedState: 'CLOSED', observedAt: '2026-10-19T06:06:00.000Z',
        event_identity: { uplink: 'incident-close' }, runtimeContext: trustedAttemptContext('2026-10-19T06:06:00.000Z'),
      });
      assert.equal(closed.kind, 'closed');
      const retryTransport = transportRecorder({ label: 'incident-retry' });
      const retry = await push.prepareClearRevision({
        db: value.db, deviceEui: DEVICE, generation: 'GEN2', now: '2026-10-19T06:06:30.000Z', reason: 'retry', force: true,
      });
      const sent = await push.sendPreparedRevision({
        db: value.db, deviceEui: DEVICE, revision: retry.revision,
        transport: retryTransport, now: '2026-10-19T06:06:30.000Z',
      });
      assert.equal(sent.sent, 1);
      const retryPush = await value.db.get("SELECT transport_json FROM valve_schedule_pushes WHERE push_id=?", [retry.required_push_ids[0]]);
      const ack = await valveWorkers.handleUplink({
        db: value.db, deviceEui: DEVICE, decoded: { Ack_Port: 25, Ack_Value: 1 },
        receivedAt: JSON.parse(retryPush.transport_json).attempted_at,
      });
      assert.equal(ack.acked, 1);
      reopen(value);
      const closedControl = JSON.parse((await value.db.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', [DEVICE])).conditional_control_json);
      assert.equal(closedControl.incident.state, 'RECONCILED');
      const events = await value.db.all("SELECT action,reason FROM irrigation_events WHERE valve_deveui=?", [DEVICE]);
      assert.equal(events.length, 1);
      assert.equal(events[0].action, 'IRRIGATE');
      assert.equal(events[0].reason, 'unexplained_on_valve_run');
    } finally {
      closeFixture(value);
    }
  });
});

test('disable-all retires policy authority once and preserves a replayable clear intent', async () => {
  const value = await tempDb();
  const transport = transportRecorder({ label: 'disable-all' });
  try {
    await insertConditionalFixture(value, { dueAt: '2026-10-19T06:00:00.000Z', legacyEnabled: 0 });
    const first = await lifecycle.applyLifecycleMutation({
      db: value.db, operation: 'disable_all', zoneIds: [1], now: NOW, transport,
    });
    assert.equal(first.status, 202);
    assert.equal(first.clear_results.length, 1);
    assert.equal((await value.db.get('SELECT enabled,sync_version FROM irrigation_policies WHERE policy_uuid=?', ['policy-1'])).enabled, 0);
    const schedule = await value.db.get('SELECT enabled,deleted_at,sync_version FROM valve_schedules WHERE schedule_uuid=?', ['schedule-1']);
    assert.equal(schedule.enabled, 1);
    assert.equal(schedule.deleted_at, null);
    const policyVersion = (await value.db.get('SELECT sync_version FROM irrigation_policies WHERE policy_uuid=?', ['policy-1'])).sync_version;
    reopen(value);
    const afterDisableTransport = transportRecorder({ label: 'disabled-policy' });
    const afterDisable = await worker.runDue(workerOptions(value, {
      transport: afterDisableTransport,
      qualificationProvider: () => ({ qualified: true, identity: 'task9a-qualified', margin_seconds: 0 }),
    }));
    assert.equal(afterDisable.processed, 0);
    assert.equal(afterDisableTransport.calls.enqueue.length, 0);
    assert.equal((await value.db.get('SELECT sync_version FROM irrigation_policies WHERE policy_uuid=?', ['policy-1'])).sync_version, policyVersion);
  } finally {
    closeFixture(value);
  }
});

test('device reassignment and zone deletion retire the old conditional owner before any new due command', async (t) => {
  await t.test('device unassign then assigns a second zone without reviving the old owner after reopen', async () => {
    const value = await tempDb();
    try {
      await insertConditionalFixture(value, { dueAt: '2026-10-19T06:00:00.000Z' });
      const result = await lifecycle.applyLifecycleMutation({
        db: value.db, operation: 'device_unassign', deviceEui: DEVICE, zoneId: 1, now: NOW,
        transport: transportRecorder({ label: 'unassign' }),
      });
      assert.equal(result.status, 202);
      const device = await value.db.get('SELECT irrigation_zone_id FROM devices WHERE deveui=?', [DEVICE]);
      const policy = await value.db.get('SELECT enabled,deleted_at FROM irrigation_policies WHERE policy_uuid=?', ['policy-1']);
      const schedule = await value.db.get('SELECT enabled,deleted_at FROM valve_schedules WHERE schedule_uuid=?', ['schedule-1']);
      assert.equal(device.irrigation_zone_id, null);
      assert.equal(policy.enabled, 0);
      assert.equal(policy.deleted_at, null);
      assert.equal(schedule.enabled, 0);
      assert.equal(schedule.deleted_at, NOW);
      await value.db.run("INSERT INTO irrigation_zones(id,name,user_id,timezone,zone_uuid) VALUES (2,'South',1,'UTC','zone-2')");
      const assigned = await lifecycle.applyLifecycleMutation({
        db: value.db, operation: 'device_assign', deviceEui: DEVICE, zoneId: 2,
        requireUnassigned: true, now: '2026-10-19T06:01:00.000Z',
        transport: transportRecorder({ label: 'assign-second-zone' }),
      });
      assert.equal(assigned.status, 200);
      assert.equal((await value.db.get('SELECT irrigation_zone_id FROM devices WHERE deveui=?', [DEVICE])).irrigation_zone_id, 2);
      reopen(value);
      const afterReopen = transportRecorder({ label: 'old-owner-after-reopen' });
      const due = await worker.runDue(workerOptions(value, {
        transport: afterReopen,
        qualificationProvider: () => ({ qualified: true, identity: 'task9a-qualified', margin_seconds: 0 }),
      }));
      assert.equal(due.processed, 0);
      assert.equal(due.dispatched, 0);
      assert.equal(afterReopen.calls.enqueue.length, 0);
      assert.equal((await value.db.get('SELECT irrigation_zone_id FROM devices WHERE deveui=?', [DEVICE])).irrigation_zone_id, 2);
      const oldSchedule = await value.db.get('SELECT enabled,deleted_at FROM valve_schedules WHERE schedule_uuid=?', ['schedule-1']);
      assert.equal(oldSchedule.enabled, 0);
      assert.equal(oldSchedule.deleted_at, NOW);
    } finally {
      closeFixture(value);
    }
  });

  await t.test('zone delete keeps a durable tombstone and no dispatch', async () => {
    const value = await tempDb();
    try {
      await insertConditionalFixture(value, { dueAt: '2026-10-19T06:00:00.000Z' });
      const result = await lifecycle.applyLifecycleMutation({
        db: value.db, operation: 'zone_delete', zoneId: 1, now: NOW,
        transport: transportRecorder({ label: 'zone-delete' }),
      });
      assert.equal(result.status, 202);
      const zone = await value.db.get('SELECT deleted_at FROM irrigation_zones WHERE id=1');
      const policy = await value.db.get('SELECT enabled,deleted_at FROM irrigation_policies WHERE policy_uuid=?', ['policy-1']);
      const schedule = await value.db.get('SELECT enabled,deleted_at FROM valve_schedules WHERE schedule_uuid=?', ['schedule-1']);
      assert.equal(zone.deleted_at, NOW);
      assert.equal(policy.enabled, 0);
      assert.equal(policy.deleted_at, NOW);
      assert.equal(schedule.enabled, 0);
      assert.equal(schedule.deleted_at, NOW);
      reopen(value);
      const afterReopen = transportRecorder({ label: 'deleted-zone-after-reopen' });
      const after = await worker.runDue(workerOptions(value, {
        qualificationProvider: () => ({ qualified: true, identity: 'task9a-qualified', margin_seconds: 0 }),
        transport: afterReopen,
      }));
      assert.equal(after.processed, 0);
      assert.equal(after.dispatched, 0);
      assert.equal(afterReopen.calls.enqueue.length, 0);
      assert.equal((await value.db.get('SELECT deleted_at FROM irrigation_zones WHERE id=1')).deleted_at, NOW);
    } finally {
      closeFixture(value);
    }
  });
});

test('old peer capability negotiation fails closed, then edge projection revisions remain durable across replay', async () => {
  const value = await tempDb();
  const context = {
    server_url: 'https://cloud.task9a.invalid', cloud_user_id: 'cloud-user-9a',
    gateway_device_eui: 'AABBCCDDEEFF0021', installation_uuid: '12345678-1234-4234-8234-123456789abc',
  };
  try {
    await insertConditionalFixture(value, { dueAt: '2026-10-19T06:00:00.000Z' });
    await value.db.run(`INSERT INTO installation_identity(singleton_id,installation_uuid,current_gateway_device_eui,created_at,updated_at)
      VALUES (1,?,?,?,?)`, [context.installation_uuid, context.gateway_device_eui, NOW, NOW]);
    const oldAttempt = await replication.beginLinkAttempt({ db: value.db, context, nonce: 'old-server-attempt', now: NOW });
    assert.equal(oldAttempt.route, 'conditional');
    const unsupported = await replication.finalizePeerContext({ db: value.db, nonce: oldAttempt.nonce, context, capabilities: [], now: NOW });
    assert.equal(unsupported.finalized, false);
    assert.equal(unsupported.reason, 'conditional_capability_missing');
    const afterUnsupported = await replication.readPeerContext(value.db);
    assert.equal(afterUnsupported.linked, false);
    assert.equal(afterUnsupported.row.link_attempt_json, null);
    const acceptedAttempt = await replication.beginLinkAttempt({ db: value.db, context, nonce: 'new-server-attempt', now: NOW });
    const accepted = await replication.finalizePeerContext({ db: value.db, nonce: acceptedAttempt.nonce, context, capabilities: ['conditional_irrigation_v1'], now: NOW });
    assert.equal(accepted.finalized, true);
    const first = await replication.publishProjection({
      db: value.db, kind: 'POLICY_RUNTIME', key: 'zone-1', now: NOW,
      clockStatus: { trusted: true, reason: 'fixture_trusted' },
      qualificationProvider: () => ({ qualified: true, identity: 'task9a-qualified', margin_seconds: 0 }),
    });
    assert.equal(first.changed, true);
    await value.db.run(`INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`, ['0016C001F1000002', 'Projection sensor', 'KIWI_SENSOR', 1, 1, NOW, NOW]);
    const second = await replication.publishProjection({
      db: value.db, kind: 'POLICY_RUNTIME', key: 'zone-1', now: '2026-10-19T06:06:00.000Z',
      clockStatus: { trusted: true, reason: 'fixture_trusted' },
      qualificationProvider: () => ({ qualified: true, identity: 'task9a-qualified', margin_seconds: 0 }),
    });
    assert.equal(second.changed, true);
    assert.equal(second.projection.projection_revision, 2);
    reopen(value);
    const projection = await replication.readProjection({ db: value.db, kind: 'POLICY_RUNTIME', key: 'zone-1' });
    assert.equal(projection.projection_revision, 2);
    const events = await value.db.all("SELECT sync_version FROM sync_outbox WHERE aggregate_type='IRRIGATION_POLICY_RUNTIME' ORDER BY sync_version");
    assert.deepEqual(events.map((row) => row.sync_version), [1, 2]);
    const replay = await replication.reconcileProjections({
      db: value.db, kind: 'POLICY_RUNTIME', now: '2026-10-19T06:06:00.000Z',
      clockStatus: { trusted: true, reason: 'fixture_trusted' },
      qualificationProvider: () => ({ qualified: true, identity: 'task9a-qualified', margin_seconds: 0 }),
    });
    assert.equal(replay.length, 1);
    assert.equal((await replication.readProjection({ db: value.db, kind: 'POLICY_RUNTIME', key: 'zone-1' })).projection_revision, 2);
    assert.equal((await value.db.get("SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type='IRRIGATION_POLICY_RUNTIME'")).n, 2);
  } finally {
    closeFixture(value);
  }
});
