'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { tempDb, facade } = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/test-helpers');
const plan = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/plan');
const push = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/push');
const store = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/store');
const dispatch = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/dispatch');
const workers = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/workers');
const { applyCloudCommand } = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/cloud-commands');
const { handleHttpRequest } = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/api');

const EUI = '0016C001F1000001';
const NOW = new Date('2026-10-18T10:00:00.000Z');
const API_SECRET = 'review-fix-secret';

function apiToken() {
  const payload = Buffer.from(JSON.stringify({ userId: 1, username: 'review', exp: Date.now() + 60000 })).toString('base64url');
  return 'Bearer ' + payload + '.' + crypto.createHmac('sha256', API_SECRET).update(payload).digest('base64url');
}

async function conditionalFixture({ generation = 'GEN2', policy = 'policy-1' } = {}) {
  const fixture = await tempDb();
  const { db } = fixture;
  await store.upsertSettings(db, EUI, { strega_generation: generation });
  await store.insertSchedule(db, {
    schedule_uuid: 'conditional-' + Math.random().toString(16).slice(2), device_eui: EUI,
    kind: 'WEEKLY', weekdays_mask: 127, start_time: '08:00', duration_minutes: 5,
    timezone: 'UTC', enabled: 1,
  });
  const schedule = await db.get('SELECT schedule_uuid FROM valve_schedules WHERE device_eui=? ORDER BY rowid DESC LIMIT 1', [EUI]);
  await db.run('UPDATE valve_schedules SET condition_policy_uuid=? WHERE schedule_uuid=?', [policy, schedule.schedule_uuid]);
  await db.run("INSERT INTO irrigation_policies(policy_uuid,zone_uuid,condition_json,timezone) VALUES (?, 'zone-1', '{}', 'UTC')", [policy]);
  return { fixture, db, scheduleUuid: schedule.schedule_uuid };
}

async function markAttempted(db, ids, at = '2026-10-18T10:00:00Z') {
  for (const id of ids) {
    await db.run('UPDATE valve_schedule_pushes SET transport_json=? WHERE push_id=?', [JSON.stringify({ phase: 'ATTEMPTED', attempted_at: at }), id]);
  }
}

test('disabled conditional rows do not force conditional mode and missing live policy fails closed', () => {
  const fixed = { schedule_uuid: 'fixed', kind: 'WEEKLY', enabled: 1, weekdays_mask: 1, start_time: '08:00', duration_minutes: 5 };
  const disabled = { schedule_uuid: 'disabled', kind: 'WEEKLY', enabled: 0, condition_policy_uuid: 'p-disabled', weekdays_mask: 1, start_time: '09:00', duration_minutes: 5 };
  assert.equal(plan.validateScheduleModes([fixed, disabled], [{ policy_uuid: 'p-disabled', deleted_at: null, enabled: 0 }]).mode, 'FIXED');
  const missing = plan.validateScheduleModes([{ ...disabled, enabled: 1 }], []);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'invalid_conditional_policy');
});

test('malformed readiness is rejected by the preparation seam', async () => {
  const { fixture, db } = await conditionalFixture();
  await db.run('UPDATE valve_settings SET conditional_control_json=? WHERE device_eui=?', [JSON.stringify({ readiness: [] }), EUI]);
  await assert.rejects(() => push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW }), (error) => error.code === 'conditional_control_malformed');
  fixture.cleanup();
});

test('same-revision control CAS reports only the actual competing writer as successful', async () => {
  const { fixture, db } = await conditionalFixture();
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  const base = await store.conditionalControl(db, EUI);
  const ready = { ...base, readiness: { state: 'READY', revision: prepared.revision, reason: 'test-a' } };
  const failed = { ...base, readiness: { state: 'FAILED', revision: prepared.revision, reason: 'test-b' } };
  const results = await Promise.all([
    store.writeConditionalControlIfRevision(db, EUI, prepared.revision, ready),
    store.writeConditionalControlIfRevision(db, EUI, prepared.revision, failed),
  ]);
  assert.equal(results.filter(Boolean).length, 1, JSON.stringify(results));
  assert.ok(['READY', 'FAILED'].includes((await store.conditionalControl(db, EUI)).readiness.state));
  fixture.cleanup();
});

test('transaction-scoped CAS composes without opening a nested transaction', async () => {
  const { fixture, db } = await conditionalFixture();
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  const base = await store.conditionalControl(db, EUI);
  const next = { ...base, readiness: { state: 'FAILED', revision: prepared.revision, reason: 'tx-test' } };
  const persisted = await db.transaction((tx) => store.writeConditionalControlIfRevisionTx(tx, EUI, prepared.revision, next));
  assert.equal(persisted, true);
  assert.equal((await store.conditionalControl(db, EUI)).readiness.state, 'FAILED');
  fixture.cleanup();
});

test('fully acknowledged current revision persists READY and rejects generation drift', async () => {
  const { fixture, db } = await conditionalFixture({ generation: 'GEN2' });
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  await markAttempted(db, prepared.required_push_ids);
  await workers.handleUplink({ db, deviceEui: EUI, decoded: { Ack_Port: 25, Ack_Value: 1 }, receivedAt: '2026-10-18T10:00:01Z', warn: () => {} });
  assert.equal((await store.conditionalControl(db, EUI)).readiness.state, 'READY', 'the real uplink handler must persist readiness');
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN1' });
  assert.equal((await push.conditionalReadiness(db, EUI)).ready, false);
  fixture.cleanup();
});

test('healthy current conditional ACK keeps the same READY revision without reconciliation', async () => {
  const { fixture, db } = await conditionalFixture({ generation: 'GEN2' });
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  await markAttempted(db, prepared.required_push_ids);
  await workers.handleUplink({ db, deviceEui: EUI, decoded: { Ack_Port: 25, Ack_Value: 1 }, receivedAt: '2026-10-18T10:00:01Z', warn: () => {} });
  const before = await store.conditionalControl(db, EUI);
  assert.equal(before.readiness.state, 'READY');
  assert.equal(await push.conditionalReconciliationNeeded(db, EUI, { profileId: 'gen2-profile', generationProfileId: 'gen2-profile' }), false);
  const after = await store.conditionalControl(db, EUI);
  assert.equal(after.desired_revision, prepared.revision);
  assert.deepEqual(after.required_push_ids, prepared.required_push_ids);
  fixture.cleanup();
});

test('conditional reconciliation retries only a failed or unattempted current row', async () => {
  const { fixture, db } = await conditionalFixture({ generation: 'GEN2' });
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  assert.equal(await push.conditionalReconciliationNeeded(db, EUI, { profileId: 'p2', generationProfileId: 'p2' }), true);
  await markAttempted(db, prepared.required_push_ids);
  assert.equal(await push.conditionalReconciliationNeeded(db, EUI, { profileId: 'p2', generationProfileId: 'p2' }), true);
  await db.run("UPDATE valve_schedule_pushes SET state='FAILED', error='negative_ack' WHERE push_id=?", [prepared.required_push_ids[0]]);
  assert.equal(await push.conditionalReconciliationNeeded(db, EUI, { profileId: 'p2', generationProfileId: 'p2' }), false);
  await db.run("UPDATE valve_schedule_pushes SET state='FAILED', error='malformed_ack' WHERE push_id=?", [prepared.required_push_ids[0]]);
  assert.equal(await push.conditionalReconciliationNeeded(db, EUI, { profileId: 'p2', generationProfileId: 'p2' }), false);
  await db.run("UPDATE valve_schedule_pushes SET state='FAILED', error='no_ack_24h' WHERE push_id=?", [prepared.required_push_ids[0]]);
  assert.equal(await push.conditionalReconciliationNeeded(db, EUI, { profileId: 'p2', generationProfileId: 'p2' }), true);
  fixture.cleanup();
});

test('GEN1 to GEN2 uplink records a pending fixed generation transition until its compile is applied', async () => {
  const fixture = await tempDb();
  const { db } = fixture;
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN1' });
  const incident = {
    incident_id: 'incident-promotion', physical_run_reference: 'physical-run-promotion', ended: false,
    ended_at: null, reconciled_at: null, state: 'OPEN',
  };
  await store.writeConditionalControl(db, EUI, { incident, opaque: [{ owner_id: 'opaque-promotion' }] });
  const promoted = await workers.handleUplink({ db, deviceEui: EUI, decoded: { Ack_Port: 25, Ack_Value: 1 }, receivedAt: '2026-10-18T10:00:01Z', warn: () => {} });
  assert.equal(promoted.generationPromoted, true);
  const pending = await store.conditionalControl(db, EUI);
  assert.deepEqual(pending.incident, incident);
  assert.deepEqual(pending.opaque, [{ owner_id: 'opaque-promotion' }]);
  assert.equal(pending.fixed_generation_transition.state, 'PENDING');
  assert.equal(pending.fixed_generation_transition.from, 'GEN1');
  assert.equal(pending.fixed_generation_transition.to, 'GEN2');
  assert.equal(await push.conditionalReconciliationNeeded(db, EUI, { profileId: 'gen2-profile', generationProfileId: 'gen2-profile' }), true);
  const prepared = await push.prepareFixedGenerationTransition({ db, deviceEui: EUI, now: NOW });
  await push.markGenerationTransitionApplied(db, EUI, { generation: 'GEN2', transitionId: prepared.transition_id, planRevision: prepared.plan_revision, requiredPushIds: prepared.required_push_ids, complete: true, now: NOW });
  const applied = await store.conditionalControl(db, EUI);
  assert.equal(applied.fixed_generation_transition.state, 'APPLIED');
  assert.equal(await push.conditionalReconciliationNeeded(db, EUI, { profileId: 'gen2-profile', generationProfileId: 'gen2-profile' }), false);
  fixture.cleanup();
});

test('a failed fixed generation compile leaves the transition pending for the next matching-profile ACK', async () => {
  const fixture = await tempDb();
  const { db } = fixture;
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN1' });
  await workers.handleUplink({ db, deviceEui: EUI, decoded: { Ack_Port: 25, Ack_Value: 1 }, receivedAt: '2026-10-18T10:00:01Z', warn: () => {} });
  assert.equal(await push.conditionalReconciliationNeeded(db, EUI, { profileId: 'gen2-profile', generationProfileId: 'gen2-profile' }), true);
  assert.equal(await push.conditionalReconciliationNeeded(db, EUI, { profileId: 'gen2-profile', generationProfileId: 'gen2-profile' }), true);
  const prepared = await push.prepareFixedGenerationTransition({ db, deviceEui: EUI, now: NOW });
  await push.markGenerationTransitionApplied(db, EUI, { generation: 'GEN2', transitionId: prepared.transition_id, planRevision: prepared.plan_revision, requiredPushIds: prepared.required_push_ids, complete: true, now: NOW });
  assert.equal(await push.conditionalReconciliationNeeded(db, EUI, { profileId: 'gen2-profile', generationProfileId: 'gen2-profile' }), false);
  fixture.cleanup();
});

test('fixed transition application leaves the marker pending on a transport failure', async () => {
  const fixture = await tempDb();
  const { db } = fixture;
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN1' });
  await workers.handleUplink({ db, deviceEui: EUI, decoded: { Ack_Port: 25, Ack_Value: 1 }, receivedAt: '2026-10-18T10:00:01Z', warn: () => {} });
  const prepared = await push.prepareFixedGenerationTransition({ db, deviceEui: EUI, now: NOW });
  assert.equal(await push.applyGenerationTransition(db, EUI, {
    generation: 'GEN2', transition_id: prepared.transition_id, plan_revision: prepared.plan_revision,
    required_push_ids: prepared.required_push_ids, complete: false, readiness: { state: 'FAILED', reason: 'enqueue_failed' },
  }), false);
  assert.equal((await store.conditionalControl(db, EUI)).fixed_generation_transition.state, 'PENDING');
  assert.equal(await push.applyGenerationTransition(db, EUI, {
    generation: 'GEN2', transition_id: prepared.transition_id, plan_revision: prepared.plan_revision,
    required_push_ids: prepared.required_push_ids, complete: true,
  }, NOW), true);
  assert.equal((await store.conditionalControl(db, EUI)).fixed_generation_transition.state, 'APPLIED');
  fixture.cleanup();
});

test('actual ACK caller reports readiness CAS loss and leaves the current row pending', async () => {
  const { fixture, db } = await conditionalFixture({ generation: 'GEN2' });
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  await markAttempted(db, prepared.required_push_ids);
  const original = store.writeConditionalControlIfRevisionTx;
  store.writeConditionalControlIfRevisionTx = async () => false;
  try {
    const result = await workers.handleUplink({ db, deviceEui: EUI, decoded: { Ack_Port: 25, Ack_Value: 1 }, receivedAt: '2026-10-18T10:00:01Z', warn: () => {} });
    assert.equal(result.readinessPersisted, false);
    assert.equal(result.rolledBack, true);
    assert.equal((await store.conditionalControl(db, EUI)).readiness.state, 'PENDING');
    assert.equal((await db.get('SELECT state FROM valve_schedule_pushes WHERE push_id=?', [prepared.required_push_ids[0]])).state, 'QUEUED');
  } finally {
    store.writeConditionalControlIfRevisionTx = original;
    fixture.cleanup();
  }
});

test('blocked sender reports readiness CAS loss instead of claiming BLOCKED', async () => {
  const { fixture, db } = await conditionalFixture();
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  const control = await store.conditionalControl(db, EUI);
  control.opaque = [{ owner_id: 'opaque-open', queue_id: 'opaque-open', device_eui: EUI, phase: 'ACCEPTED' }];
  await store.writeConditionalControl(db, EUI, control);
  const original = store.writeConditionalControlIfRevision;
  store.writeConditionalControlIfRevision = async () => false;
  try {
    const result = await push.sendPreparedRevision({ db, deviceEui: EUI, revision: prepared.revision, transport: { async getDeviceQueue() { return []; } }, now: NOW });
    assert.equal(result.casLost, true);
    assert.equal(result.blocked, true);
  } finally {
    store.writeConditionalControlIfRevision = original;
    fixture.cleanup();
  }
});

test('flush failure reports readiness CAS loss instead of claiming FAILED', async () => {
  const { fixture, db } = await conditionalFixture();
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  const original = store.writeConditionalControlIfRevision;
  store.writeConditionalControlIfRevision = async () => false;
  try {
    const result = await push.sendPreparedRevision({ db, deviceEui: EUI, revision: prepared.revision, transport: { async getDeviceQueue() { throw new Error('queue read failed'); } }, now: NOW });
    assert.equal(result.casLost, true);
    assert.equal(result.readiness.state, 'FAILED');
  } finally {
    store.writeConditionalControlIfRevision = original;
    fixture.cleanup();
  }
});

test('negative current ACK is terminal until a fresh retry revision', async () => {
  const { fixture, db } = await conditionalFixture();
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  const id = prepared.required_push_ids[0];
  await markAttempted(db, [id]);
  await workers.handleUplink({ db, deviceEui: EUI, decoded: { Ack_Port: 25, Ack_Value: 0 }, receivedAt: '2026-10-18T10:00:01Z', warn: () => {} });
  assert.equal(await store.ackPush(db, EUI, 'DAYMASK_PLAN', 25, null, 1, '2026-10-18T10:00:02Z'), 0);
  assert.equal((await db.get('SELECT state,error FROM valve_schedule_pushes WHERE push_id=?', [id])).state, 'FAILED');
  fixture.cleanup();
});

test('actual Gen1 conditional ACK caller accepts the exact clear row but preserves the incident until all rows arrive', async () => {
  const { fixture, db } = await conditionalFixture({ generation: 'GEN1' });
  const incident = {
    incident_id: 'incident-gen1', physical_run_reference: 'physical-run-gen1', ended: false,
    ended_at: null, reconciled_at: null, state: 'OPEN',
  };
  await store.writeConditionalControl(db, EUI, { incident });
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN1', now: NOW });
  await markAttempted(db, prepared.required_push_ids);

  const result = await workers.handleUplink({
    db, deviceEui: EUI, decoded: { Schl_Port: 14, Schl_status: '00' },
    receivedAt: '2026-10-18T10:00:01Z', warn: () => {},
  });
  assert.equal(result.acked, 1, 'the exact empty Gen1 clear row is a qualifying ACK');
  const first = await db.get('SELECT state, error, ack_status FROM valve_schedule_pushes WHERE push_id=?', [prepared.required_push_ids[0]]);
  assert.deepEqual({ ...first }, { state: 'ACKED', error: null, ack_status: 0 });
  const control = await store.conditionalControl(db, EUI);
  assert.deepEqual(control.incident, incident);
  assert.equal(control.readiness.state, 'PENDING');
  fixture.cleanup();
});

test('actual ordinary Gen1 ACK caller advances only the acknowledged plan rows and keeps incident metadata', async () => {
  const { fixture, db } = await conditionalFixture({ generation: 'GEN1' });
  const incident = {
    incident_id: 'incident-partial-gen1', physical_run_reference: 'physical-run-partial-gen1', ended: false,
    ended_at: null, reconciled_at: null, state: 'OPEN',
  };
  await store.writeConditionalControl(db, EUI, { incident });
  await db.run('UPDATE valve_schedules SET condition_policy_uuid=NULL WHERE device_eui=?', [EUI]);
  const queued = await push.compileAndQueue({ db, deviceEui: EUI, now: NOW });
  // Design C (CMD-04 PR0): the snapshot leaves with the valve tick after the debounce window;
  // markAttempted below stands in for the transport send that follows.
  await push.emitPendingSnapshots({ db, now: new Date(NOW.getTime() + push.SNAPSHOT_DEBOUNCE_MS), appId: 'app', warn: () => {} });
  const weekday = queued.rows
    .filter((row) => row.purpose === 'WEEKDAY_PLAN')
    .sort((left, right) => left.weekday - right.weekday);
  assert.equal(weekday.length, 7);
  await markAttempted(db, weekday.slice(0, 2).map((row) => row.push_id));

  const first = await workers.handleUplink({
    db, deviceEui: EUI, decoded: { Schl_Port: weekday[0].fport, Schl_status: '00' },
    receivedAt: '2026-10-18T10:00:01Z', warn: () => {},
  });
  const second = await workers.handleUplink({
    db, deviceEui: EUI, decoded: { Schl_Port: weekday[1].fport, Schl_status: '00' },
    receivedAt: '2026-10-18T10:00:02Z', warn: () => {},
  });
  assert.equal(first.acked, 1);
  assert.equal(second.acked, 1);
  const rows = await db.all("SELECT push_id, state FROM valve_schedule_pushes WHERE purpose='WEEKDAY_PLAN' ORDER BY weekday");
  assert.deepEqual(rows.map((row) => ({ ...row })), weekday.map((row, index) => ({ push_id: row.push_id, state: index < 2 ? 'ACKED' : 'QUEUED' })));
  assert.deepEqual((await store.conditionalControl(db, EUI)).incident, incident);
  fixture.cleanup();
});

test('sender checks all owners and blocks an opaque owner beside a predecessor', async () => {
  const { fixture, db } = await conditionalFixture();
  const old = { push_id: 'old-known-plan', device_eui: EUI, purpose: 'WEEKDAY_PLAN', weekday: 0, fport: 14, payload_hex: 'FF'.repeat(24), plan_hash: 'old' };
  await store.insertPushes(db, [old]);
  await db.run('UPDATE valve_schedule_pushes SET transport_json=? WHERE push_id=?', [JSON.stringify({ phase: 'UNKNOWN', attempted_at: '2026-10-18T09:00:00Z' }), old.push_id]);
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  const control = await store.conditionalControl(db, EUI);
  control.predecessor_push_ids = [old.push_id];
  control.opaque = [{ owner_id: 'opaque-open', queue_id: 'opaque-open', device_eui: EUI, phase: 'ACCEPTED', queue_id: 'opaque-open' }];
  await store.writeConditionalControl(db, EUI, control);
  let enqueues = 0;
  const result = await push.sendPreparedRevision({ db, deviceEui: EUI, revision: prepared.revision, transport: {
    async getDeviceQueue() { return []; }, async flushDeviceQueue() {}, async enqueueDownlink() { enqueues += 1; return { id: 'q' + enqueues }; },
  }, now: NOW });
  assert.equal(result.blocked, true);
  assert.equal(enqueues, 0);
  fixture.cleanup();
});

test('stale sender cannot enqueue an obsolete revision prepared during its transport wait', async () => {
  const { fixture, db } = await conditionalFixture({ generation: 'GEN1' });
  const first = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN1', now: NOW });
  let release;
  const entered = new Promise((resolve) => { release = resolve; });
  let continueQueue;
  const queueStarted = new Promise((resolve) => { continueQueue = resolve; });
  let enqueues = 0;
  const transport = { async getDeviceQueue() { continueQueue(); await entered; return []; }, async flushDeviceQueue() {}, async enqueueDownlink() { enqueues += 1; return { id: 'q' + enqueues }; } };
  const sending = push.sendPreparedRevision({ db, deviceEui: EUI, revision: first.revision, transport, now: NOW });
  await queueStarted;
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN2' });
  const second = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  release();
  const result = await sending;
  assert.equal(result.obsolete, true);
  assert.equal(enqueues, 0);
  assert.equal((await store.conditionalControl(db, EUI)).desired_revision, second.revision);
  fixture.cleanup();
});

test('public retry serializes revision preparation behind an in-flight sender', async () => {
  const { fixture, db } = await conditionalFixture({ generation: 'GEN1' });
  const first = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN1', now: NOW });
  let releaseEnqueue;
  const enqueuePaused = new Promise((resolve) => { releaseEnqueue = resolve; });
  let enqueueStarted;
  const started = new Promise((resolve) => { enqueueStarted = resolve; });
  let enqueues = 0;
  const transport = {
    async getDeviceQueue() { return []; },
    async flushDeviceQueue() {},
    async enqueueDownlink() {
      enqueues += 1;
      enqueueStarted();
      await enqueuePaused;
      return { id: 'retry-race-' + enqueues };
    },
  };
  const sending = push.sendPreparedRevision({ db, deviceEui: EUI, revision: first.revision, transport, now: NOW });
  await started;
  const retrying = push.retryClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await store.conditionalControl(db, EUI)).desired_revision, first.revision, 'public retry must wait behind the active sender writer');
  releaseEnqueue();
  const [sent, retried] = await Promise.all([sending, retrying]);
  assert.equal(sent.obsolete, undefined);
  assert.equal(retried.generation, 'GEN2');
  assert.equal(enqueues, first.required_push_ids.length, 'the old sender completed before public retry could replace it');
  fixture.cleanup();
});

test('single-valve compile callers serialize prepare and send under the device writer', async () => {
  const { fixture, db } = await conditionalFixture({ generation: 'GEN1' });
  let release;
  const entered = new Promise((resolve) => { release = resolve; });
  let firstQueueRead;
  const firstQueue = new Promise((resolve) => { firstQueueRead = resolve; });
  let enqueues = 0;
  const transport = { async getDeviceQueue() { firstQueueRead(); await entered; return []; }, async flushDeviceQueue() {}, async enqueueDownlink() { enqueues += 1; return { id: 'caller-q-' + enqueues }; } };
  const first = push.compileAndQueue({ db, deviceEui: EUI, transport, now: NOW });
  await firstQueue;
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN2' });
  const second = push.compileAndQueue({ db, deviceEui: EUI, transport, now: NOW });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(enqueues, 0);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(enqueues, 8, JSON.stringify(results));
  assert.equal((await store.conditionalControl(db, EUI)).generation, 'GEN2');
  fixture.cleanup();
});

test('flush failure preserves the durable flush audit in control JSON', async () => {
  const { fixture, db } = await conditionalFixture();
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  const result = await push.sendPreparedRevision({ db, deviceEui: EUI, revision: prepared.revision, transport: {
    async getDeviceQueue() { throw new Error('queue read failed'); },
  }, now: NOW });
  assert.equal(result.readiness.state, 'FAILED');
  const control = await store.conditionalControl(db, EUI);
  assert.ok(Array.isArray(control.flushes) && control.flushes.length > 0);
  fixture.cleanup();
});

test('cloud generation change reconciles the current clear through the durable sender', async () => {
  const { fixture, db } = await conditionalFixture({ generation: 'GEN1' });
  let enqueues = 0;
  const transport = {
    async getDeviceQueue() { return []; }, async flushDeviceQueue() {},
    async enqueueDownlink() { enqueues += 1; return { id: 'gen-q-' + enqueues }; },
  };
  const result = await applyCloudCommand({ db, transport, appId: 'app', warn: () => {}, now: NOW, cmd: {
    commandType: 'UPSERT_VALVE_SETTINGS', device_eui: EUI, strega_generation: 'GEN2',
  } });
  assert.equal(result.ok, true);
  assert.equal(enqueues, 1);
  const control = await store.conditionalControl(db, EUI);
  assert.equal(control.generation, 'GEN2');
  fixture.cleanup();
});

test('incident shape survives retry and finalization requires exact current ACK evidence', async () => {
  const { fixture, db } = await conditionalFixture();
  const incident = {
    incident_id: 'incident-1', physical_run_reference: 'physical-run-1', ended: false,
    ended_at: null, reconciled_at: null, state: 'OPEN',
  };
  await store.writeConditionalControl(db, EUI, { incident });
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  assert.deepEqual((await store.conditionalControl(db, EUI)).incident, incident);
  await assert.rejects(() => db.transaction((tx) => push.finalizeConditionalIncidentTx(tx, EUI, {
    revision: prepared.revision, physical_run_reference: 'physical-run-1',
    ended_at: '2026-10-18T10:01:00Z', reconciled_at: '2026-10-18T10:01:00Z',
  })), (error) => error.code === 'conditional_incident_retry_required');
  const retried = await push.retryClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  assert.notEqual(retried.revision, prepared.revision);
  assert.deepEqual((await store.conditionalControl(db, EUI)).incident, { ...incident, retry_revision: retried.revision });
  await db.run("UPDATE valve_schedule_pushes SET state='ACKED', ack_status=1, acked_at=? WHERE push_id IN (" + retried.required_push_ids.map(() => '?').join(',') + ')', [NOW.toISOString(), ...retried.required_push_ids]);
  await assert.rejects(() => db.transaction((tx) => push.finalizeConditionalIncidentTx(tx, EUI, {
    revision: retried.revision, physical_run_reference: 'physical-run-1',
    ended_at: '2026-10-18T10:01:00Z', reconciled_at: '2026-10-18T10:01:01Z',
  })), (error) => error.code === 'conditional_incident_evidence_required');
  await store.writeConditionalControl(db, EUI, {
    ...(await store.conditionalControl(db, EUI)),
    incident: { ...(await store.conditionalControl(db, EUI)).incident, ended: true, ended_at: '2026-10-18T10:01:00Z', state: 'ENDED' },
  });
  const finalized = await db.transaction((tx) => push.finalizeConditionalIncidentTx(tx, EUI, {
    revision: retried.revision, physical_run_reference: 'physical-run-1',
    reconciled_at: '2026-10-18T10:01:01Z',
  }));
  assert.equal(finalized.state, 'RECONCILED');
  assert.equal(finalized.ended, true);
  assert.equal(finalized.physical_run_reference, 'physical-run-1');
  fixture.cleanup();
});

test('reverse conversion blocks fixed pushes while a live timed owner remains', async () => {
  const { fixture, db, scheduleUuid } = await conditionalFixture();
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  await db.run("UPDATE valve_schedule_pushes SET state='ACKED', ack_status=1, acked_at=? WHERE push_id=?", [NOW.toISOString(), prepared.required_push_ids[0]]);
  await db.run('UPDATE valve_schedules SET condition_policy_uuid=NULL WHERE schedule_uuid=?', [scheduleUuid]);
  await dispatch.reserveValveCommand({ db, command: { device_eui: EUI, command_id: 'timed-reverse-owner', action: 'OPEN_FOR_DURATION', duration_minutes: 5 }, now: NOW });
  let enqueues = 0;
  const result = await push.compileAndQueue({ db, deviceEui: EUI, now: NOW, transport: {
    async getDeviceQueue() { return []; }, async flushDeviceQueue() {}, async enqueueDownlink() { enqueues += 1; return { id: 'fixed-q' }; },
  } });
  // R13-M4 (W29): the conversion is no longer silently blocked (202, nothing written, the fixed
  // plan never programmed). The control becomes FIXED and the full snapshot is pending; nothing is
  // sent now, and the emitter holds the snapshot while the open awaits observation (5-minute cap).
  assert.notEqual(result.blocked, true);
  assert.equal(result.conversion_waits_for, 'timed-reverse-owner');
  assert.equal(enqueues, 0);
  assert.equal((await store.conditionalControl(db, EUI)).mode, 'FIXED');
  assert.ok((await store.getSnapshotPending(db, EUI)).push_ids.length > 0, 'the fixed snapshot is pending, not lost');
  fixture.cleanup();
});

test('profile reconciliation caller passes the durable transport to conversion sender', () => {
  for (const profile of ['bcm2712', 'bcm2709']) {
    const path = `../conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`;
    const flow = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, path), 'utf8'));
    const node = flow.find((entry) => entry.id === '13324' || entry.id === 'valve-ack-fn' || (entry.func || '').includes('compileAndQueue') && (entry.func || '').includes('Gen2 profile'));
    assert.ok(node, `${profile}: profile reconciliation node exists`);
    assert.match(node.func, /compileAndQueue\(\{[\s\S]*transport:\s*client/);
  }
});

test('local settings generation change reconciles through the actual API transport', async () => {
  const { fixture, db } = await conditionalFixture({ generation: 'GEN1' });
  const path = fixture.path;
  db.close();
  let enqueues = 0;
  const warnings = [];
  class TestDatabase { constructor(pathValue) { return facade(new DatabaseSync(pathValue)); } }
  const result = await handleHttpRequest({
    msg: { req: { method: 'PUT', url: `/api/valves/${EUI}/settings`, headers: { authorization: apiToken() }, body: { strega_generation: 'GEN2' } } },
    Database: TestDatabase,
    environment: { authTokenSecret: API_SECRET, dbPath: path }, warn: (message) => warnings.push(message), appId: 'app',
    transport: { async getDeviceQueue() { return []; }, async flushDeviceQueue() {}, async enqueueDownlink() { enqueues += 1; return { id: 'api-q-' + enqueues }; } },
    flushQueue: async () => {},
  });
  assert.equal(result.statusCode, 200, JSON.stringify({ result, warnings }));
  assert.equal(enqueues, 1);
  fixture.cleanup();
});

test('local settings reports nested conditional transport failure', async () => {
  const { fixture, db } = await conditionalFixture({ generation: 'GEN1' });
  const path = fixture.path;
  db.close();
  class TestDatabase { constructor(pathValue) { return facade(new DatabaseSync(pathValue)); } }
  const result = await handleHttpRequest({
    msg: { req: { method: 'PUT', url: `/api/valves/${EUI}/settings`, headers: { authorization: apiToken() }, body: { strega_generation: 'GEN2' } } },
    Database: TestDatabase,
    environment: { authTokenSecret: API_SECRET, dbPath: path }, warn: () => {}, appId: 'app',
    transport: { async getDeviceQueue() { throw new Error('queue read failed'); } },
    flushQueue: async () => {},
  });
  assert.equal(result.statusCode, 503, JSON.stringify(result));
  assert.equal(result.payload.error, 'transport_uncertain');
  fixture.cleanup();
});

test('cloud settings reports nested conditional transport failure', async () => {
  const { fixture, db } = await conditionalFixture({ generation: 'GEN1' });
  const result = await applyCloudCommand({ db, transport: {
    async getDeviceQueue() { throw new Error('queue read failed'); },
  }, appId: 'app', warn: () => {}, now: NOW, cmd: {
    commandType: 'UPSERT_VALVE_SETTINGS', device_eui: EUI, strega_generation: 'GEN2',
  } });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error, 'transport_uncertain');
  fixture.cleanup();
});

test('ACK predicates require the exact current attempted row, timestamp boundary, and Gen1 rule', async () => {
  const { fixture, db } = await conditionalFixture({ generation: 'GEN2' });
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  const id = prepared.required_push_ids[0];
  await db.run('UPDATE valve_schedule_pushes SET transport_json=? WHERE push_id=?', [JSON.stringify({ phase: 'ATTEMPTED', attempted_at: '2026-10-18 10:00:00' }), id]);
  assert.equal(await store.ackPush(db, EUI, 'DAYMASK_PLAN', 25, null, 1, '2026-10-18 09:59:59'), 0);
  assert.equal(await store.ackPush(db, EUI, 'DAYMASK_PLAN', 25, null, 1, '2026-10-18 10:00:00'), 1);
  assert.equal((await push.conditionalReadiness(db, EUI)).ready, true);
  const second = await push.retryClearRevision({ db, deviceEui: EUI, generation: 'GEN1', now: NOW });
  await markAttempted(db, second.required_push_ids);
  assert.equal(await store.ackPush(db, EUI, 'WEEKDAY_PLAN', 14, 0, 0, '2026-10-18T10:00:01Z'), 0);
  assert.equal((await db.get('SELECT error FROM valve_schedule_pushes WHERE push_id=?', [second.required_push_ids[0]])).error, 'ack_protocol_unverified');
  fixture.cleanup();
});

test('fixed ACK matching uses current settings generation when control generation is stale', async () => {
  const fixture = await tempDb();
  const { db } = fixture;
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN1' });
  await store.insertSchedule(db, {
    schedule_uuid: 'fixed-current-generation', device_eui: EUI, kind: 'WEEKLY', weekdays_mask: 1,
    start_time: '08:00', duration_minutes: 5, timezone: 'UTC', enabled: 1,
  });
  const queued = await push.compileAndQueue({ db, deviceEui: EUI, now: NOW });
  // Design C (CMD-04 PR0): emitted by the valve tick after the debounce window; markAttempted
  // below stands in for the transport send.
  await push.emitPendingSnapshots({ db, now: new Date(NOW.getTime() + push.SNAPSHOT_DEBOUNCE_MS), appId: 'app', warn: () => {} });
  const row = queued.rows.find((candidate) => candidate.purpose === 'WEEKDAY_PLAN' && candidate.weekday === 0);
  await store.writeConditionalControl(db, EUI, { mode: 'FIXED', generation: 'GEN2', readiness: { state: 'INVALID', reason: 'fixed_mode' } });
  await markAttempted(db, [row.push_id]);
  assert.equal(await store.ackPush(db, EUI, 'WEEKDAY_PLAN', row.fport, row.weekday, 0, '2026-10-18T10:00:01Z'), 1);
  assert.equal((await db.get('SELECT state FROM valve_schedule_pushes WHERE push_id=?', [row.push_id])).state, 'ACKED');
  fixture.cleanup();
});

test('retry creates fresh IDs after enqueue uncertainty and does not resend an attempted row', async () => {
  const { fixture, db } = await conditionalFixture();
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  let attempts = 0;
  const sent = await push.sendPreparedRevision({ db, deviceEui: EUI, revision: prepared.revision, transport: {
    async getDeviceQueue() { return []; }, async flushDeviceQueue() {}, async enqueueDownlink() { attempts += 1; throw new Error('enqueue lost'); },
  }, now: NOW });
  assert.equal(sent.sent, prepared.required_push_ids.length);
  const attemptedRows = await db.all("SELECT push_id,transport_json FROM valve_schedule_pushes WHERE state<>'ACKED'");
  assert.ok(attemptedRows.some((row) => /ATTEMPTED|UNKNOWN/.test(row.transport_json || '')));
  const retry = await push.retryClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: new Date(NOW.getTime() + 1000) });
  assert.notDeepEqual(retry.required_push_ids, prepared.required_push_ids);
  assert.equal(attempts, 1);
  fixture.cleanup();
});
