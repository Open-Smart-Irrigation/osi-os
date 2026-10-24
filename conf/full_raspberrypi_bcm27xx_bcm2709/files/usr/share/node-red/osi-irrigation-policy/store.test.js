'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const store = require('./store');

const ROOT = path.resolve(__dirname, '../../../../../../../');
const SEED = path.join(ROOT, 'database/seed-blank.sql');

function openDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conditional-store-'));
  const db = new DatabaseSync(path.join(dir, 'farming.db'));
  db.exec(fs.readFileSync(SEED, 'utf8'));
  return db;
}

function facade(native) {
  const adapt = (value) => value === undefined ? null : value;
  return {
    async run(sql, params = []) { native.prepare(sql).run(...params.map(adapt)); },
    async get(sql, params = []) { return native.prepare(sql).get(...params.map(adapt)) || null; },
    async all(sql, params = []) { return native.prepare(sql).all(...params.map(adapt)); },
    async exec(sql) { native.exec(sql); },
    async transaction(fn) {
      native.exec('BEGIN IMMEDIATE');
      const tx = {
        run: async (sql, params = []) => { native.prepare(sql).run(...params.map(adapt)); },
        get: async (sql, params = []) => native.prepare(sql).get(...params.map(adapt)) || null,
        all: async (sql, params = []) => native.prepare(sql).all(...params.map(adapt)),
        exec: async (sql) => { native.exec(sql); },
      };
      try { const result = await fn(tx); native.exec('COMMIT'); return result; }
      catch (error) { native.exec('ROLLBACK'); throw error; }
    },
  };
}

const POLICY = {
  policy_uuid: 'policy-1', zone_uuid: 'zone-1', timezone: 'Europe/Zurich',
  condition_json: JSON.stringify({ kind: 'SWT', threshold_kpa: 50, sources: [] }),
  delivery_settings_json: JSON.stringify({ 'VALVE-1': { delivery_interval_minutes: 10 } }),
  observation_window_minutes: 60, min_interval_minutes: 60, max_daily_minutes: 240,
  effective_from: '2026-10-17T05:00:00Z', enabled: 1,
};

test('policy writes enforce expected version and preserve rollback', async () => {
  const db = facade(openDb());
  const created = await store.upsertPolicy(db, POLICY, { expectedSyncVersion: null });
  assert.equal(created.sync_version, 1);
  await assert.rejects(
    store.upsertPolicy(db, { ...POLICY, condition_json: JSON.stringify({ kind: 'VWC', threshold_percent: 0, sources: [] }) }, { expectedSyncVersion: 99 }),
    (error) => error.code === 'version_conflict',
  );
  const current = await store.getPolicy(db, 'policy-1');
  assert.equal(current.sync_version, 1);
  assert.match(current.condition_json, /SWT/);
});

test('duplicate occurrence claim is replayed by composite identity and evidence stays immutable', async () => {
  const db = facade(openDb());
  await store.insertOccurrence(db, {
    schedule_uuid: 'schedule-1', local_date: '2026-10-17', local_time: '06:00',
    policy_uuid: 'policy-1', device_eui: 'VALVE-1', zone_uuid: 'zone-1',
    due_at: '2026-10-17T04:00:00Z', expires_at: '2026-10-17T04:31:00Z',
    policy_sync_version: 4, schedule_sync_version: 7,
  });
  const first = await store.claimOccurrence(db, {
    schedule_uuid: 'schedule-1', local_date: '2026-10-17', local_time: '06:00',
  }, { policySyncVersion: 4, scheduleSyncVersion: 7 });
  assert.equal(first.claimed, true);
  await store.transitionOccurrence(db, first.occurrence, {
    state: 'SKIPPED', decision: 'NOT_MET', decision_reason: 'condition_not_met',
    decision_evidence_json: JSON.stringify({ value: 20, threshold: 50 }),
  });
  const replay = await store.claimOccurrence(db, {
    schedule_uuid: 'schedule-1', local_date: '2026-10-17', local_time: '06:00',
  }, { policySyncVersion: 999, scheduleSyncVersion: 999 });
  assert.equal(replay.claimed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.occurrence.decision_evidence_json, JSON.stringify({ value: 20, threshold: 50 }));
  await assert.rejects(
    store.transitionOccurrence(db, replay.occurrence, { decision_evidence_json: JSON.stringify({ value: 99 }) }),
    (error) => error.code === 'decision_evidence_immutable',
  );
});

test('runtime last decided dueAt is a monotonic lower bound', async () => {
  const db = facade(openDb());
  await store.updateRuntimeState(db, {
    last_trusted_tick_at: '2026-10-17T06:10:00Z',
    last_decided_due_at: '2026-10-17T06:00:00Z',
  });
  await store.updateRuntimeState(db, {
    last_trusted_tick_at: '2026-10-17T06:11:00Z',
    last_decided_due_at: '2026-10-17T05:00:00Z',
  });
  const state = await store.getRuntimeState(db);
  assert.equal(state.last_trusted_tick_at, '2026-10-17T06:11:00Z');
  assert.equal(state.last_decided_due_at, '2026-10-17T06:00:00Z');
});

test('policy versions validate explicit create and advance on update', async () => {
  const db = facade(openDb());
  await assert.rejects(
    store.upsertPolicy(db, { ...POLICY, policy_uuid: 'bad-create', sync_version: 0 }),
    (error) => error.code === 'invalid_sync_version',
  );
  const created = await store.upsertPolicy(db, { ...POLICY, policy_uuid: 'versioned', sync_version: 4 });
  assert.equal(created.sync_version, 4);
  await assert.rejects(
    store.upsertPolicy(db, { policy_uuid: 'versioned', sync_version: 4, condition_json: '{"changed":true}' }),
    (error) => error.code === 'version_conflict',
  );
  await assert.rejects(
    store.upsertPolicy(db, { policy_uuid: 'versioned', sync_version: 3, condition_json: '{"changed":true}' }),
    (error) => error.code === 'version_conflict',
  );
  const versionOnly = await store.upsertPolicy(db, { policy_uuid: 'versioned', sync_version: 5 });
  assert.equal(versionOnly.sync_version, 5);
});

test('caller-scoped writes roll back after a later failure', async () => {
  const db = facade(openDb());
  await assert.rejects(
    db.transaction(async (tx) => {
      await store.upsertPolicyTx(tx, { ...POLICY, policy_uuid: 'rolled-back' });
      throw new Error('caller failure');
    }),
    /caller failure/,
  );
  assert.equal(await store.getPolicy(db, 'rolled-back'), null);
});

async function reservedOccurrence(db, key, commandId) {
  await store.insertOccurrence(db, {
    ...key, policy_uuid: 'policy-1', device_eui: 'VALVE-1', zone_uuid: 'zone-1',
    due_at: '2026-10-17T04:00:00Z', expires_at: '2026-10-17T04:31:00Z',
    policy_sync_version: 4, schedule_sync_version: 7,
  });
  await store.claimOccurrence(db, key, { policySyncVersion: 4, scheduleSyncVersion: 7 });
  return store.transitionOccurrence(db, key, {
    state: 'RESERVED', decision: 'IRRIGATE', decision_reason: 'selected',
    decision_evidence_json: null, requested_duration_minutes: 10,
    effective_duration_minutes: 10, command_id: commandId,
    reservation_start_at: '2026-10-17T04:00:00Z', reservation_end_at: '2026-10-17T04:10:00Z',
    reserved_minutes: 10,
  });
}

test('attempt is one-shot, snapshots stay frozen, and proof controls expiry', async () => {
  const db = facade(openDb());
  const key = { schedule_uuid: 'schedule-attempt', local_date: '2026-10-17', local_time: '06:00' };
  await reservedOccurrence(db, key, 'command-attempt');
  const first = await store.transitionOccurrence(db, key, { state: 'ATTEMPTED' }, { now: '2026-10-17T04:01:00Z' });
  assert.equal(first.send, true);
  assert.equal(first.occurrence.attempted_at, '2026-10-17T04:01:00Z');
  const replay = await store.transitionOccurrence(db, key, { state: 'ATTEMPTED' }, { now: '2026-10-17T04:02:00Z' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.send, false);
  await store.transitionOccurrence(db, key, { state: 'SENT', sent_at: '2026-10-17T04:01:01Z' });
  const advancedReplay = await store.transitionOccurrence(db, key, { state: 'ATTEMPTED' });
  assert.equal(advancedReplay.replayed, true);
  await assert.rejects(
    store.transitionOccurrence(db, key, { state: 'SENT', due_at: '2026-10-17T05:00:00Z' }),
    (error) => error.code === 'occurrence_identity_immutable',
  );
  await assert.rejects(
    store.transitionOccurrence(db, key, { state: 'SENT', command_id: 'new-command' }),
    (error) => error.code === 'occurrence_snapshot_immutable',
  );
  await assert.rejects(
    store.transitionOccurrence(db, key, { state: 'EXPIRED' }, {
      authorization: 'conditional_irrigation_pre_acceptance_failure_v1',
      preAcceptanceFailure: { command_id: 'command-attempt', phase: 'pre_acceptance', failure_code: 'enqueue_rejected', accepted: false, queue_id: null },
    }),
    (error) => error.code === 'non_delivery_unavailable',
  );
});

test('only recognized pre-acceptance failure can expire ATTEMPTED', async () => {
  const db = facade(openDb());
  const key = { schedule_uuid: 'schedule-preaccept', local_date: '2026-10-17', local_time: '06:08' };
  await reservedOccurrence(db, key, 'command-preaccept');
  await store.transitionOccurrence(db, key, { state: 'ATTEMPTED' }, { now: '2026-10-17T04:01:00Z' });
  await assert.rejects(
    store.transitionOccurrence(db, key, { state: 'EXPIRED' }),
    (error) => error.code === 'pre_acceptance_proof_required',
  );
  await assert.rejects(
    store.transitionOccurrence(db, key, { state: 'EXPIRED' }, {
      authorization: 'conditional_irrigation_pre_acceptance_failure_v1',
      preAcceptanceFailure: { command_id: 'other-command', phase: 'pre_acceptance', failure_code: 'enqueue_rejected', accepted: false, queue_id: null },
    }),
    (error) => error.code === 'pre_acceptance_proof_invalid',
  );
  const expired = await store.transitionOccurrence(db, key, { state: 'EXPIRED' }, {
    authorization: 'conditional_irrigation_pre_acceptance_failure_v1',
    preAcceptanceFailure: { command_id: 'command-preaccept', phase: 'pre_acceptance', failure_code: 'enqueue_rejected', accepted: false, queue_id: null },
  });
  assert.equal(expired.occurrence.state, 'EXPIRED');
  assert.equal(expired.occurrence.decision_reason, 'command_expired');
});

test('all queue snapshot variants fail closed for pre-acceptance proof', async () => {
  const db = facade(openDb());
  const variants = [
    { command_id: 'command-queue-id', phase: 'pre_acceptance', failure_code: 'enqueue_rejected', accepted: false, queue_id: 'accepted-queue-id' },
    { command_id: 'command-queue-pending', phase: 'pre_acceptance', failure_code: 'enqueue_rejected', accepted: false, queue_id: null, queue_snapshot: { status: 'pending' } },
    { command_id: 'command-queue-absent', phase: 'pre_acceptance', failure_code: 'enqueue_rejected', accepted: false },
  ];
  for (const [index, evidence] of variants.entries()) {
    const key = { schedule_uuid: `schedule-queue-${index}`, local_date: '2026-10-17', local_time: `06:${11 + index}` };
    await reservedOccurrence(db, key, evidence.command_id);
    await store.transitionOccurrence(db, key, { state: 'ATTEMPTED' });
    await assert.rejects(
      store.transitionOccurrence(db, key, { state: 'EXPIRED' }, {
        authorization: 'conditional_irrigation_pre_acceptance_failure_v1',
        preAcceptanceFailure: evidence,
      }),
      (error) => error.code === 'pre_acceptance_proof_invalid',
    );
  }
});

test('durable acceptance markers block attempted expiry and remain intact', async () => {
  const cases = [
    { suffix: 'durable-queue', marker: { queue_id: 'accepted-queue' } },
    { suffix: 'durable-sent', marker: { sent_at: '2026-10-17T04:02:00Z' } },
  ];
  for (const item of cases) {
    const db = facade(openDb());
    const key = { schedule_uuid: `schedule-${item.suffix}`, local_date: '2026-10-17', local_time: '06:15' };
    await reservedOccurrence(db, key, `command-${item.suffix}`);
    await store.transitionOccurrence(db, key, { state: 'ATTEMPTED' });
    await store.transitionOccurrence(db, key, item.marker);
    const before = await store.getOccurrence(db, key);
    await assert.rejects(
      store.transitionOccurrence(db, key, { state: 'EXPIRED' }, {
        authorization: 'conditional_irrigation_pre_acceptance_failure_v1',
        preAcceptanceFailure: { command_id: `command-${item.suffix}`, phase: 'pre_acceptance', failure_code: 'enqueue_rejected', accepted: false, queue_id: null },
      }),
      (error) => error.code === 'acceptance_marker_present',
    );
    const after = await store.getOccurrence(db, key);
    assert.equal(after.state, 'ATTEMPTED');
    assert.equal(after.reservation_end_at, before.reservation_end_at);
    assert.equal(after.queue_id, before.queue_id);
    assert.equal(after.sent_at, before.sent_at);
  }
});

test('same-patch acceptance marker changes cannot claim pre-acceptance expiry', async () => {
  const db = facade(openDb());
  const key = { schedule_uuid: 'schedule-same-patch-marker', local_date: '2026-10-17', local_time: '06:16' };
  await reservedOccurrence(db, key, 'command-same-patch-marker');
  await store.transitionOccurrence(db, key, { state: 'ATTEMPTED' });
  await assert.rejects(
    store.transitionOccurrence(db, key, { state: 'EXPIRED', queue_id: 'accepted-in-same-write' }, {
      authorization: 'conditional_irrigation_pre_acceptance_failure_v1',
      preAcceptanceFailure: { command_id: 'command-same-patch-marker', phase: 'pre_acceptance', failure_code: 'enqueue_rejected', accepted: false, queue_id: null },
    }),
    (error) => error.code === 'acceptance_marker_present',
  );
  const row = await store.getOccurrence(db, key);
  assert.equal(row.state, 'ATTEMPTED');
  assert.equal(row.queue_id, null);
  assert.notEqual(row.reservation_end_at, null);
});

test('acceptance markers cannot be cleared before expiry', async () => {
  const db = facade(openDb());
  const key = { schedule_uuid: 'schedule-clear-marker', local_date: '2026-10-17', local_time: '06:17' };
  await reservedOccurrence(db, key, 'command-clear-marker');
  await store.transitionOccurrence(db, key, { state: 'ATTEMPTED', queue_id: 'accepted-queue' });
  await assert.rejects(
    store.transitionOccurrence(db, key, { queue_id: null }),
    (error) => error.code === 'acceptance_marker_immutable',
  );
  assert.equal((await store.getOccurrence(db, key)).queue_id, 'accepted-queue');
});

test('reserved expiry rejects contradictory durable acceptance markers', async () => {
  const db = facade(openDb());
  const key = { schedule_uuid: 'schedule-reserved-marker', local_date: '2026-10-17', local_time: '06:18' };
  await reservedOccurrence(db, key, 'command-reserved-marker');
  await store.transitionOccurrence(db, key, { queue_id: 'accepted-before-attempt' });
  await assert.rejects(
    store.transitionOccurrence(db, key, { state: 'EXPIRED' }),
    (error) => error.code === 'acceptance_marker_present',
  );
  const row = await store.getOccurrence(db, key);
  assert.equal(row.state, 'RESERVED');
  assert.equal(row.queue_id, 'accepted-before-attempt');
  assert.notEqual(row.reservation_end_at, null);
});

test('reserved expiry, unknown recovery, and invalid transitions are explicit', async () => {
  const db = facade(openDb());
  const reservedKey = { schedule_uuid: 'schedule-reserved', local_date: '2026-10-17', local_time: '06:01' };
  await reservedOccurrence(db, reservedKey, 'command-reserved');
  const reservedExpired = await store.transitionOccurrence(db, reservedKey, { state: 'EXPIRED' });
  assert.equal(reservedExpired.occurrence.decision_reason, 'command_expired');

  const unknownKey = { schedule_uuid: 'schedule-unknown', local_date: '2026-10-17', local_time: '06:02' };
  await reservedOccurrence(db, unknownKey, 'command-unknown');
  await store.transitionOccurrence(db, unknownKey, { state: 'ATTEMPTED' });
  await store.transitionOccurrence(db, unknownKey, { state: 'UNKNOWN' });
  await assert.rejects(
    store.transitionOccurrence(db, unknownKey, { state: 'EXPIRED' }, {
      authorization: 'conditional_irrigation_pre_acceptance_failure_v1',
      preAcceptanceFailure: { command_id: 'command-unknown', phase: 'pre_acceptance', failure_code: 'enqueue_rejected', accepted: false, queue_id: null },
    }),
    (error) => error.code === 'non_delivery_unavailable',
  );
  /* The v1 adapter cannot prove non-delivery from any queue snapshot. */
  await assert.rejects(
    store.transitionOccurrence(db, unknownKey, { state: 'EXPIRED' }, {
      authorization: 'conditional_irrigation_pre_acceptance_failure_v1',
      preAcceptanceFailure: { command_id: 'command-unknown', phase: 'pre_acceptance', failure_code: 'enqueue_rejected', accepted: false, queue_id: null },
    }),
    (error) => error.code === 'non_delivery_unavailable',
  );

  const invalidKey = { schedule_uuid: 'schedule-invalid', local_date: '2026-10-17', local_time: '06:03' };
  await store.insertOccurrence(db, { ...invalidKey, device_eui: 'VALVE-1', due_at: '2026-10-17T04:00:00Z' });
  await assert.rejects(
    store.transitionOccurrence(db, invalidKey, { state: 'ATTEMPTED' }),
    (error) => error.code === 'invalid_occurrence_transition',
  );
});

test('decision_at persists on insert and decision, then freezes', async () => {
  const db = facade(openDb());
  await assert.rejects(
    store.insertOccurrence(db, {
      schedule_uuid: 'schedule-invalid-decision-at', local_date: '2026-10-17', local_time: '06:14',
      device_eui: 'VALVE-1', due_at: '2026-10-17T04:00:00Z', decision_at: '2026-10-17 04:01:00Z',
    }),
    (error) => error.code === 'invalid_timestamp',
  );
  const insertedKey = { schedule_uuid: 'schedule-decision-at-insert', local_date: '2026-10-17', local_time: '06:09' };
  const inserted = await store.insertOccurrence(db, {
    ...insertedKey, device_eui: 'VALVE-1', due_at: '2026-10-17T04:00:00Z',
    decision: 'NOT_MET', decision_reason: 'condition_not_met', decision_at: '2026-10-17T04:01:00Z',
  });
  assert.equal(inserted.decision_at, '2026-10-17T04:01:00Z');
  const decidedKey = { schedule_uuid: 'schedule-decision-at-transition', local_date: '2026-10-17', local_time: '06:10' };
  await store.insertOccurrence(db, { ...decidedKey, device_eui: 'VALVE-1', due_at: '2026-10-17T04:00:00Z' });
  await store.claimOccurrence(db, decidedKey);
  const decided = await store.transitionOccurrence(db, decidedKey, {
    state: 'SKIPPED', decision: 'NOT_MET', decision_reason: 'condition_not_met', decision_at: '2026-10-17T04:02:00Z',
  });
  assert.equal(decided.occurrence.decision_at, '2026-10-17T04:02:00Z');
  await assert.rejects(
    store.transitionOccurrence(db, decidedKey, { decision_at: '2026-10-17T04:03:00Z' }),
    (error) => error.code === 'occurrence_snapshot_immutable',
  );
});

test('occurrence insert replays only the composite identity', async () => {
  const db = facade(openDb());
  const key = { schedule_uuid: 'schedule-insert', local_date: '2026-10-17', local_time: '06:04' };
  const original = await store.insertOccurrence(db, { ...key, device_eui: 'VALVE-1', due_at: '2026-10-17T04:00:00Z', command_id: 'command-original' });
  const replay = await store.insertOccurrence(db, { ...key, device_eui: 'VALVE-2', due_at: '2026-10-17T05:00:00Z', command_id: 'command-other' });
  assert.equal(replay.device_eui, original.device_eui);
  assert.equal(replay.due_at, original.due_at);
  await assert.rejects(
    store.insertOccurrence(db, { schedule_uuid: 'schedule-other', local_date: '2026-10-17', local_time: '06:05', device_eui: 'VALVE-1', due_at: '2026-10-17T04:00:00Z', command_id: 'command-original' }),
  );
  await assert.rejects(
    store.insertOccurrence(db, { schedule_uuid: 'schedule-bad-state', local_date: '2026-10-17', local_time: '06:06', device_eui: 'VALVE-1', due_at: '2026-10-17T04:00:00Z', state: 'BAD' }),
  );
  await assert.rejects(
    store.insertOccurrence(db, { schedule_uuid: 'schedule-missing-due', local_date: '2026-10-17', local_time: '06:07', device_eui: 'VALVE-1' }),
  );
});
