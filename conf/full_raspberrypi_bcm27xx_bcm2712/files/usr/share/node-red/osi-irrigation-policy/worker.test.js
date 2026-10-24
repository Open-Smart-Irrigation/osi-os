'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { tempDb, facade } = require('../osi-valve-control/test-helpers');
const dispatch = require('../osi-valve-control/dispatch');
const observations = require('./observations');
const policyApi = require('./api');
const worker = require('./worker');

const DEVICE = '0016C001F1000001';
const NOW = '2026-10-19T06:05:00.000Z';

function fixtureClockOptions(now = NOW) {
  const files = new Map([
    ['/fixture/boot', 'boot-1\n'],
    ['/fixture/uptime', '100.000 0.00\n'],
    ['/fixture/marker', JSON.stringify({ boot_id: 'boot-1', epoch_ms: Date.parse(now), uptime_ms: 100000, stratum: 1 })],
  ]);
  return {
    fs: {
      readFileSync(path) {
        if (files.has(path)) return files.get(path);
        const error = new Error('missing fixture file');
        error.code = 'ENOENT';
        throw error;
      },
      unlinkSync(path) {
        if (files.delete(path)) return;
        const error = new Error('missing fixture file');
        error.code = 'ENOENT';
        throw error;
      },
      mkdirSync() {},
      writeFileSync(path, value) { files.set(path, value); },
      renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
      unlink(path, callback) { try { this.unlinkSync(path); callback(null); } catch (error) { callback(error); } },
    },
    bootPath: '/fixture/boot',
    uptimePath: '/fixture/uptime',
    markerPath: '/fixture/marker',
    rejectionPath: '/fixture/rejection',
    fallbackPath: '/fixture/rejection-fallback',
  };
}

async function fixture({ policyEffectiveFrom = '2026-10-18T00:00:00.000Z', scheduleEffectiveFrom = '2026-10-18T00:00:00.000Z', ready = true } = {}) {
  const value = await tempDb();
  const { db } = value;
  await db.run(
    "INSERT INTO irrigation_zones(id,name,user_id,timezone,zone_uuid) VALUES (1,'North',1,'UTC','zone-1')",
  );
  await db.run(
    'UPDATE devices SET irrigation_zone_id=1 WHERE deveui=?',
    [DEVICE],
  );
  await db.run(
    `INSERT INTO irrigation_policies(
      policy_uuid,zone_uuid,condition_json,timezone,enabled,observation_window_minutes,
      min_interval_minutes,max_daily_minutes,delivery_settings_json,effective_from,sync_version
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      'policy-1', 'zone-1', JSON.stringify({ kind: 'DENDRO', minimum_stress: 'mild', response_mode: 'fixed' }),
      'UTC', 1, 60, 60, 240, JSON.stringify({ [DEVICE]: { delivery_interval_minutes: 10 } }),
      policyEffectiveFrom, 1,
    ],
  );
  await db.run(
    `INSERT INTO valve_schedules(
      schedule_uuid,device_eui,kind,weekdays_mask,start_time,duration_minutes,timezone,enabled,
      sync_version,condition_policy_uuid,effective_from
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      'schedule-1', DEVICE, 'WEEKLY', 2, '06:00', 5, 'UTC', 1, 1, 'policy-1',
      scheduleEffectiveFrom,
    ],
  );
  const recommendation = {
    raw_evidence: {
      version: 1,
      analysis: {
        computed_at: '2026-10-19T05:59:00.000Z',
        stress: 'mild',
        action: 'increase_10',
        usable_tree_count: 1,
      },
    },
    raw_decision: { version: 1, computed_at: '2026-10-19T05:59:00.000Z' },
  };
  await db.run(
    `INSERT INTO zone_daily_recommendations(
      zone_id,date,zone_stress_summary,irrigation_action,recommendation_json,computed_at,usable_tree_count
    ) VALUES (?,?,?,?,?,?,?)`,
    [1, '2026-10-19', 'mild', 'increase_10', JSON.stringify(recommendation), '2026-10-19T05:59:00.000Z', 1],
  );
  await db.run(
    'INSERT INTO valve_settings(device_eui,conditional_control_json) VALUES (?,?)',
    [DEVICE, JSON.stringify({ desired_revision: 'rev-1', generation: 'GEN1', required_push_ids: ['push-1'], readiness: { state: ready ? 'READY' : 'PENDING' } })],
  );
  await db.run(
    `INSERT INTO valve_schedule_pushes(push_id,device_eui,purpose,weekday,fport,payload_hex,state)
     VALUES (?,?,?,?,?,?,?)`,
    ['push-1', DEVICE, 'WEEKDAY_PLAN', 1, 14, '00', ready ? 'ACKED' : 'QUEUED'],
  );
  return value;
}

function workerOptions(value, { sends, evidenceReads, now = NOW, currentNow, clock = () => ({ trusted: true, reason: 'trusted' }), qualificationProvider, transport, readEvidence } = {}) {
  return {
    db: value.db,
    now,
    currentNow,
    clockOptions: fixtureClockOptions(now),
    clock,
    qualificationProvider,
    transport: transport || {
      async enqueueDownlink() {
        if (sends) sends.count += 1;
        return { id: 'queue-1' };
      },
    },
    readEvidence: readEvidence || (async (input) => {
      if (evidenceReads) evidenceReads.count += 1;
      return observations.readEvidence(input);
    }),
  };
}

function reopenValue(value) {
  try { value.raw.close(); } catch (_) { /* already closed */ }
  value.raw = new DatabaseSync(value.path);
  value.db = facade(value.raw);
}

function serializeTransactions(db) {
  const original = db.transaction.bind(db);
  let tail = Promise.resolve();
  db.transaction = (executor) => {
    const next = tail.then(() => original(executor));
    tail = next.catch(() => undefined);
    return next;
  };
}

async function configureDue(value, {
  dueAt,
  localDate,
  startTime,
  weekdaysMask,
  timezone = 'UTC',
  durationMinutes = 5,
  minIntervalMinutes = 60,
  maxDailyMinutes = 240,
  effectiveFrom,
} = {}) {
  const dueMs = Date.parse(dueAt);
  const computedAt = new Date(dueMs - 60 * 1000).toISOString();
  await value.db.run(
    'UPDATE irrigation_zones SET timezone=? WHERE id=1',
    [timezone],
  );
  await value.db.run(
    'UPDATE irrigation_policies SET timezone=?, min_interval_minutes=?, max_daily_minutes=? WHERE policy_uuid=?',
    [timezone, minIntervalMinutes, maxDailyMinutes, 'policy-1'],
  );
  if (effectiveFrom) {
    await value.db.run('UPDATE irrigation_policies SET effective_from=? WHERE policy_uuid=?', [effectiveFrom, 'policy-1']);
    await value.db.run('UPDATE valve_schedules SET effective_from=? WHERE schedule_uuid=?', [effectiveFrom, 'schedule-1']);
  }
  await value.db.run(
    'UPDATE valve_schedules SET weekdays_mask=?, start_time=?, duration_minutes=?, timezone=? WHERE schedule_uuid=?',
    [weekdaysMask, startTime, durationMinutes, timezone, 'schedule-1'],
  );
  const recommendation = {
    raw_evidence: {
      version: 1,
      analysis: { computed_at: computedAt, stress: 'mild', action: 'increase_10', usable_tree_count: 1 },
    },
    raw_decision: { version: 1, computed_at: computedAt },
  };
  await value.db.run(
    'UPDATE zone_daily_recommendations SET date=?, recommendation_json=?, computed_at=? WHERE zone_id=1',
    [localDate, JSON.stringify(recommendation), computedAt],
  );
}

async function insertBoundedHistory(value, {
  reservationStartAt,
  reservationEndAt,
  reservedMinutes,
  capturedTimezone = 'UTC',
  capturedLocalDays = ['2026-10-17'],
  exclusionEndAt,
} = {}) {
  await value.db.run(
    `INSERT INTO irrigation_occurrences(
      schedule_uuid,local_date,local_time,policy_uuid,zone_uuid,device_eui,due_at,
      policy_sync_version,schedule_sync_version,decision,decision_reason,decision_evidence_json,
      decision_at,requested_duration_minutes,effective_duration_minutes,command_id,queue_id,state,
      reservation_start_at,reservation_end_at,reserved_minutes,sent_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      'old-schedule', '2026-10-17', '00:10', 'old-policy', 'zone-1', DEVICE,
      reservationStartAt, 1, 1, 'IRRIGATE', 'condition_met', JSON.stringify({
        timezone: capturedTimezone,
        accounting: { timezone: capturedTimezone, local_days: capturedLocalDays },
        minimum_gap_minutes: 60,
        exclusion_end_at: exclusionEndAt,
      }), reservationStartAt, reservedMinutes, reservedMinutes, 'old-command', 'old-queue', 'SENT',
      reservationStartAt, reservationEndAt, reservedMinutes, reservationStartAt,
    ],
  );
  await value.db.run(
    `INSERT INTO valve_actuation_expectations(
      expectation_id,device_eui,command_id,commanded_at,commanded_duration_seconds,
      expected_close_at,volume_source,reconciliation_state,created_at,transport_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      'old-expectation', DEVICE, 'old-command', reservationStartAt, reservedMinutes * 60,
      reservationEndAt, 'unknown', 'OBSERVED_CLOSED', reservationStartAt, null,
    ],
  );
}

async function insertReportOnly(value, {
  expectationId = 'report-only-1',
  earliestPossibleStartAt,
  latestPossibleEndAt,
  reconciliationState = 'OBSERVED_CLOSED',
} = {}) {
  await value.db.run(
    `INSERT INTO valve_actuation_expectations(
      expectation_id,device_eui,command_id,commanded_at,commanded_duration_seconds,
      expected_close_at,volume_source,reconciliation_state,created_at,transport_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      expectationId, DEVICE, null, latestPossibleEndAt || earliestPossibleStartAt || NOW, -1,
      latestPossibleEndAt || '', 'unknown', reconciliationState, NOW,
      JSON.stringify({ physical_run: {
        version: 1, source: 'explicit_report',
        earliest_possible_start_at: earliestPossibleStartAt || null,
        latest_possible_end_at: latestPossibleEndAt || null,
      } }),
    ],
  );
}

test('due worker claims and sends one MET occurrence, then replays without reading or sending', async () => {
  const value = await fixture();
  let evidenceReads = 0;
  let sends = 0;
  const transport = {
    async enqueueDownlink(item) {
      sends += 1;
      assert.equal(item.devEui, DEVICE);
      return { id: 'queue-1' };
    },
  };
  const options = workerOptions(value, {
    qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
    transport,
    readEvidence: async (input) => {
      evidenceReads += 1;
      return observations.readEvidence(input);
    },
  });

  try {
    const first = await worker.runDue(options);
    assert.equal(first.dispatched, 1);
    assert.equal(sends, 1);
    assert.equal(evidenceReads, 1);
    const occurrence = await value.db.get('SELECT * FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
    assert.equal(occurrence.state, 'SENT');
    assert.equal(occurrence.decision, 'IRRIGATE');
    assert.equal(occurrence.queue_id, 'queue-1');
    const evidence = JSON.parse(occurrence.decision_evidence_json);

    delete require.cache[require.resolve('./worker')];
    const restartedWorker = require('./worker');
    const second = await restartedWorker.runDue(options);
    assert.equal(second.dispatched, 0);
    assert.equal(sends, 1);
    assert.equal(evidenceReads, 1);
    const replay = await value.db.get('SELECT decision_evidence_json FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
    assert.equal(replay.decision_evidence_json, occurrence.decision_evidence_json);
    assert.deepEqual(JSON.parse(replay.decision_evidence_json), evidence);
  } finally {
    value.cleanup();
  }
});

test('production qualification remains false and records an explicit skip', async () => {
  const value = await fixture();
  let evidenceReads = 0;
  let sends = 0;
  try {
    const result = await worker.runDue(workerOptions(value, {
      readEvidence: async (input) => {
        evidenceReads += 1;
        return observations.readEvidence(input);
      },
      transport: { async enqueueDownlink() { sends += 1; return { id: 'queue-qualification' }; } },
    }));
    assert.equal(result.skipped, 1);
    assert.equal(result.dispatched, 0);
    assert.equal(evidenceReads, 1);
    assert.equal(sends, 0);
    const row = await value.db.get('SELECT state, decision, decision_reason FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
    assert.equal(row.state, 'SKIPPED');
    assert.equal(row.decision, 'SKIPPED');
    assert.equal(row.decision_reason, 'qualification_unavailable');
  } finally {
    value.cleanup();
  }
});

test('untrusted clock rejects the tick before source history or occurrence writes', async () => {
  const value = await fixture();
  let evidenceReads = 0;
  try {
    const result = await worker.runDue(workerOptions(value, {
      clock: () => ({ trusted: false, reason: 'clock_untrusted_jump' }),
      readEvidence: async (input) => {
        evidenceReads += 1;
        return observations.readEvidence(input);
      },
    }));
    assert.equal(result.trusted, false);
    assert.equal(result.reason, 'clock_untrusted_jump');
    assert.equal(result.processed, 0);
    assert.equal(evidenceReads, 0);
    assert.equal((await value.db.get('SELECT COUNT(*) AS count FROM irrigation_occurrences')).count, 0);
  } finally {
    value.cleanup();
  }
});

test('clock recovery reopens the bounded due audit and dispatches once', async () => {
  const value = await fixture();
  let trusted = false;
  let evidenceReads = 0;
  let sends = 0;
  try {
    const options = workerOptions(value, {
      clock: () => trusted ? ({ trusted: true, reason: 'trusted' }) : ({ trusted: false, reason: 'clock_untrusted_jump' }),
      qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
      readEvidence: async (input) => {
        evidenceReads += 1;
        return observations.readEvidence(input);
      },
      transport: { async enqueueDownlink() { sends += 1; return { id: 'recovery-queue' }; } },
    });
    const rejected = await worker.runDue(options);
    assert.equal(rejected.trusted, false);
    assert.equal(rejected.processed, 0);
    assert.equal(evidenceReads, 0);
    trusted = true;
    const recovered = await worker.runDue(options);
    assert.equal(recovered.trusted, true);
    assert.equal(recovered.dispatched, 1);
    assert.equal(evidenceReads, 1);
    assert.equal(sends, 1);
    assert.equal((await value.db.get('SELECT state FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1'])).state, 'SENT');
  } finally {
    value.cleanup();
  }
});

test('policy and schedule activation equality excludes the due instant', async (t) => {
  for (const [label, options] of [
    ['policy', { policyEffectiveFrom: '2026-10-19T06:00:00.000Z' }],
    ['schedule', { scheduleEffectiveFrom: '2026-10-19T06:00:00.000Z' }],
  ]) {
    await t.test(label, async () => {
      const value = await fixture(options);
      let evidenceReads = 0;
      try {
        const result = await worker.runDue(workerOptions(value, {
          readEvidence: async (input) => {
            evidenceReads += 1;
            return observations.readEvidence(input);
          },
        }));
        assert.equal(result.processed, 0);
        assert.equal(result.skipped, 0);
        assert.equal(evidenceReads, 0);
        assert.equal((await value.db.get('SELECT COUNT(*) AS count FROM irrigation_occurrences')).count, 0);
      } finally {
        value.cleanup();
      }
    });
  }
});

test('readiness failure is persisted as a plan-update skip without transport I/O', async () => {
  const value = await fixture({ ready: false });
  let sends = 0;
  try {
    const result = await worker.runDue(workerOptions(value, {
      qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
      transport: { async enqueueDownlink() { sends += 1; return { id: 'queue-readiness' }; } },
    }));
    assert.equal(result.skipped, 1);
    assert.equal(sends, 0);
    const row = await value.db.get('SELECT state, decision_reason FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
    assert.equal(row.state, 'SKIPPED');
    assert.equal(row.decision_reason, 'plan_update_pending');
  } finally {
    value.cleanup();
  }
});

test('concurrent ticks serialize one occurrence and never enqueue twice', async () => {
  const value = await fixture();
  let sends = 0;
  let evidenceReads = 0;
  serializeTransactions(value.db);
  const options = workerOptions(value, {
    qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
    transport: { async enqueueDownlink() { sends += 1; return { id: 'queue-concurrent' }; } },
    readEvidence: async (input) => {
      evidenceReads += 1;
      return observations.readEvidence(input);
    },
  });
  try {
    const [left, right] = await Promise.all([worker.runDue(options), worker.runDue(options)]);
    assert.equal(left.dispatched + right.dispatched, 1);
    assert.equal(sends, 1);
    assert.equal(evidenceReads, 1);
    assert.equal((await value.db.get('SELECT state FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1'])).state, 'SENT');
  } finally {
    value.cleanup();
  }
});

test('revision drift while waiting for the valve writer records a stale occurrence and does not send', async () => {
  const value = await fixture();
  let releaseWriter;
  let discovered;
  const discoveredPromise = new Promise((resolve) => { discovered = resolve; });
  const held = dispatch.withValveWriters([DEVICE], () => new Promise((resolve) => { releaseWriter = resolve; }));
  let sends = 0;
  const options = workerOptions(value, {
    qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
    transport: { async enqueueDownlink() { sends += 1; return { id: 'queue-drift' }; } },
    discoverCandidates: undefined,
  });
  options.discoverCandidates = async (db, runtime, nowMs) => {
    const result = await worker.discoverCandidates(db, runtime, nowMs);
    discovered();
    return result;
  };
  try {
    const running = worker.runDue(options);
    await discoveredPromise;
    await value.db.run('UPDATE irrigation_policies SET sync_version=2 WHERE policy_uuid=?', ['policy-1']);
    releaseWriter();
    await held;
    const result = await running;
    assert.equal(result.skipped, 1);
    assert.equal(sends, 0);
    const row = await value.db.get('SELECT state, decision_reason, policy_sync_version FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
    assert.equal(row.state, 'SKIPPED');
    assert.equal(row.decision_reason, 'revision_conflict');
    assert.equal(row.policy_sync_version, 1);
  } finally {
    if (releaseWriter) releaseWriter();
    value.cleanup();
  }
});

test('reopened RESERVED snapshot resumes on the subsequent tick after a deferred attempt', async () => {
  const value = await fixture();
  let clockCalls = 0;
  let sends = 0;
  const options = workerOptions(value, {
    qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
    clock: () => {
      clockCalls += 1;
      return clockCalls === 3 ? { trusted: false, reason: 'clock_untrusted_after_snapshot' } : { trusted: true, reason: 'trusted' };
    },
    transport: { async enqueueDownlink() { sends += 1; return { id: 'reopened-reserved' }; } },
  });
  try {
    const first = await worker.runDue(options);
    assert.equal(first.deferred, 1);
    assert.equal(sends, 0);
    const reserved = await value.db.get('SELECT state, command_id FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
    assert.equal(reserved.state, 'RESERVED');
    assert.ok(reserved.command_id);
    reopenValue(value);
    const second = await worker.runDue({ ...options, db: value.db, clock: () => ({ trusted: true, reason: 'trusted' }) });
    assert.equal(second.dispatched, 1);
    assert.equal(sends, 1);
    const sent = await value.db.get('SELECT state, queue_id FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
    assert.equal(sent.state, 'SENT');
    assert.equal(sent.queue_id, 'reopened-reserved');
  } finally {
    try { value.raw.close(); } catch (_) { /* already closed */ }
    value.cleanup();
  }
});

test('production discovery retries an errored occurrence after the audit overlap and a same-time sibling completes', async () => {
  const value = await fixture();
  let clockCalls = 0;
  let evidenceReads = 0;
  try {
    await value.db.run("UPDATE valve_schedules SET start_time='05:30' WHERE schedule_uuid='schedule-1'");
    await value.db.run(
      `INSERT INTO valve_schedules(
        schedule_uuid,device_eui,kind,weekdays_mask,start_time,duration_minutes,timezone,enabled,
        sync_version,condition_policy_uuid,effective_from
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ['schedule-2', DEVICE, 'WEEKLY', 2, '05:30', 5, 'UTC', 1, 1, 'policy-1', '2026-10-18T00:00:00.000Z'],
    );
    const first = await worker.runDue(workerOptions(value, {
      now: '2026-10-19T06:05:00.000Z',
      clock: () => {
        clockCalls += 1;
        return clockCalls === 2 ? { trusted: false, reason: 'injected-before-occurrence' } : { trusted: true, reason: 'trusted' };
      },
      qualificationProvider: () => ({ qualified: false, reason: 'fixture_unqualified' }),
      readEvidence: async (input) => { evidenceReads += 1; return observations.readEvidence(input); },
    }));
    assert.equal(first.errors.length, 1);
    assert.equal(first.skipped, 1);
    assert.equal(evidenceReads, 0);
    assert.equal((await value.db.get('SELECT COUNT(*) AS count FROM irrigation_occurrences')).count, 1);
    assert.equal((await value.db.get('SELECT last_trusted_tick_at FROM irrigation_runtime_state WHERE singleton_id=1')).last_trusted_tick_at, null);
    reopenValue(value);

    const retry = await worker.runDue(workerOptions(value, {
      now: '2026-10-19T06:20:00.000Z',
      clock: () => ({ trusted: true, reason: 'trusted' }),
      readEvidence: async (input) => { evidenceReads += 1; return observations.readEvidence(input); },
    }));
    assert.equal(retry.processed, 2);
    assert.equal(retry.skipped, 1);
    assert.equal(evidenceReads, 0);
    const row = await value.db.get('SELECT state, decision, decision_reason FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
    assert.equal(row.state, 'SKIPPED');
    assert.equal(row.decision, 'SKIPPED');
    assert.equal(row.decision_reason, 'missed_start');
  } finally {
    try { value.raw.close(); } catch (_) { /* already closed */ }
    value.cleanup();
  }
});

test('production discovery retains RESERVED owners beyond the audit overlap', async (t) => {
  for (const [label, finalAt, expected] of [
    ['within captured expiry', '2026-10-19T06:25:00.000Z', 'SENT'],
    ['after captured expiry', '2026-10-19T06:40:00.000Z', 'EXPIRED'],
  ]) {
    await t.test(label, async () => {
      const value = await fixture();
      let sends = 0;
      try {
        const first = await worker.runDue(workerOptions(value, {
          now: '2026-10-19T06:05:00.000Z',
          qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
          clock: (() => {
            let calls = 0;
            return () => {
              calls += 1;
              return calls === 3 ? { trusted: false, reason: 'defer-after-snapshot' } : { trusted: true, reason: 'trusted' };
            };
          })(),
          transport: { async enqueueDownlink() { sends += 1; return { id: 'durable-reserved-queue' }; } },
        }));
        assert.equal(first.deferred, 1);
        assert.equal((await value.db.get('SELECT last_trusted_tick_at FROM irrigation_runtime_state WHERE singleton_id=1'))?.last_trusted_tick_at ?? null, null);
        reopenValue(value);

        const deferred = await worker.runDue(workerOptions(value, {
          now: '2026-10-19T06:20:00.000Z',
          qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
          clock: (() => {
            let calls = 0;
            return () => {
              calls += 1;
              return calls === 3 ? { trusted: false, reason: 'defer-past-grace' } : { trusted: true, reason: 'trusted' };
            };
          })(),
          transport: { async enqueueDownlink() { sends += 1; return { id: 'should-not-send-yet' }; } },
        }));
        assert.equal(deferred.deferred, 1);
        assert.equal((await value.db.get('SELECT last_trusted_tick_at FROM irrigation_runtime_state WHERE singleton_id=1'))?.last_trusted_tick_at ?? null, null);
        const reservedBeforeCursor = await value.db.get(
          'SELECT schedule_uuid, local_date, local_time, due_at, expires_at, reservation_end_at, command_id, decision_evidence_json FROM irrigation_occurrences WHERE schedule_uuid=?',
          ['schedule-1'],
        );
        const ownerBeforeCursor = await value.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE command_id=?', [reservedBeforeCursor.command_id]);
        const snapshotBeforeCursor = JSON.parse(ownerBeforeCursor.transport_json).effect_snapshot;
        await value.db.run(
          `INSERT INTO irrigation_runtime_state(singleton_id, last_trusted_tick_at, last_decided_due_at, updated_at)
           VALUES (1, ?, NULL, ?)
           ON CONFLICT(singleton_id) DO UPDATE SET last_trusted_tick_at=excluded.last_trusted_tick_at, updated_at=excluded.updated_at`,
          ['2026-10-19T06:20:00.000Z', '2026-10-19T06:20:00.000Z'],
        );
        reopenValue(value);
        assert.equal(
          (await value.db.get('SELECT last_trusted_tick_at FROM irrigation_runtime_state WHERE singleton_id=1')).last_trusted_tick_at,
          '2026-10-19T06:20:00.000Z',
        );

        const final = await worker.runDue(workerOptions(value, {
          now: finalAt,
          qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
          clock: () => ({ trusted: true, reason: 'trusted' }),
          transport: { async enqueueDownlink() { sends += 1; return { id: 'durable-reserved-queue' }; } },
        }));
        assert.equal(final.processed, 1);
        if (expected === 'SENT') {
          assert.equal(final.dispatched, 1);
          assert.equal(sends, 1);
        } else {
          assert.equal(final.skipped, 1);
          assert.equal(sends, 0);
        }
        const after = await value.db.get(
          'SELECT state, queue_id, schedule_uuid, local_date, local_time, due_at, expires_at, reservation_end_at, command_id, decision_evidence_json FROM irrigation_occurrences WHERE schedule_uuid=?',
          ['schedule-1'],
        );
        assert.equal(after.state, expected);
        assert.deepEqual({
          schedule_uuid: after.schedule_uuid,
          local_date: after.local_date,
          local_time: after.local_time,
          due_at: after.due_at,
          expires_at: after.expires_at,
          reservation_end_at: after.reservation_end_at,
          command_id: after.command_id,
          decision_evidence_json: after.decision_evidence_json,
        }, {
          schedule_uuid: reservedBeforeCursor.schedule_uuid,
          local_date: reservedBeforeCursor.local_date,
          local_time: reservedBeforeCursor.local_time,
          due_at: reservedBeforeCursor.due_at,
          expires_at: reservedBeforeCursor.expires_at,
          reservation_end_at: reservedBeforeCursor.reservation_end_at,
          command_id: reservedBeforeCursor.command_id,
          decision_evidence_json: reservedBeforeCursor.decision_evidence_json,
        });
        const ownerAfter = await value.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE command_id=?', [after.command_id]);
        assert.deepEqual(JSON.parse(ownerAfter.transport_json).effect_snapshot, snapshotBeforeCursor);
        if (expected === 'SENT') assert.equal(after.queue_id, 'durable-reserved-queue');
        else assert.equal(after.queue_id, null);
      } finally {
        try { value.raw.close(); } catch (_) { /* already closed */ }
        value.cleanup();
      }
    });
  }
});

test('writer wait uses a fresh runtime instant at the inclusive grace boundary', async (t) => {
  for (const [label, freshNow, expected] of [
    ['exactly due plus ten minutes', '2026-10-19T06:10:00.000Z', 'dispatched'],
    ['one millisecond after due plus ten minutes', '2026-10-19T06:10:00.001Z', 'missed_start'],
  ]) {
    await t.test(label, async () => {
      const value = await fixture();
      let releaseWriter;
      let discovered;
      const discoveredPromise = new Promise((resolve) => { discovered = resolve; });
      const held = dispatch.withValveWriters([DEVICE], () => new Promise((resolve) => { releaseWriter = resolve; }));
      let evidenceReads = 0;
      let sends = 0;
      const options = workerOptions(value, {
        now: '2026-10-19T06:09:59.000Z',
        currentNow: () => freshNow,
        qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
        readEvidence: async (input) => { evidenceReads += 1; return observations.readEvidence(input); },
        transport: { async enqueueDownlink() { sends += 1; return { id: `grace-${label}` }; } },
      });
      options.discoverCandidates = async (db, runtime, nowMs) => {
        const candidates = await worker.discoverCandidates(db, runtime, nowMs);
        discovered();
        return candidates;
      };
      try {
        const running = worker.runDue(options);
        await discoveredPromise;
        releaseWriter();
        await held;
        const result = await running;
        if (expected === 'dispatched') {
          assert.equal(result.dispatched, 1);
          assert.equal(evidenceReads, 1);
          assert.equal(sends, 1);
        } else {
          assert.equal(result.skipped, 1);
          assert.equal(evidenceReads, 0);
          assert.equal(sends, 0);
          const row = await value.db.get('SELECT state, decision_reason, decision_evidence_json FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
          assert.equal(row.state, 'SKIPPED');
          assert.equal(row.decision_reason, 'missed_start');
          assert.equal(JSON.parse(row.decision_evidence_json).due_at, '2026-10-19T06:00:00.000Z');
        }
      } finally {
        if (releaseWriter) releaseWriter();
        try { await held; } catch (_) { /* held callback already released */ }
        value.cleanup();
      }
    });
  }
});

test('the asynchronous clock gate is outside the claim transaction', async () => {
  const value = await fixture();
  let releaseGate;
  let gateStarted;
  const gateStartedPromise = new Promise((resolve) => { gateStarted = resolve; });
  const gateRelease = new Promise((resolve) => { releaseGate = resolve; });
  let clockCalls = 0;
  let sends = 0;
  let probe;
  try {
    const options = workerOptions(value, {
      qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
      clock: async () => {
        clockCalls += 1;
        if (clockCalls === 2) {
          gateStarted();
          await gateRelease;
        }
        return { trusted: true, reason: 'trusted' };
      },
      transport: { async enqueueDownlink() { sends += 1; return { id: 'clock-gate-queue' }; } },
    });
    const running = worker.runDue(options);
    await gateStartedPromise;
    probe = new DatabaseSync(value.path);
    const probeDb = facade(probe);
    await assert.doesNotReject(() => probeDb.run("UPDATE users SET username='independent-writer' WHERE id=1"));
    releaseGate();
    const result = await running;
    assert.equal(result.dispatched, 1);
    assert.equal(sends, 1);
  } finally {
    if (releaseGate) releaseGate();
    try { if (probe) probe.close(); } catch (_) { /* already closed */ }
    value.cleanup();
  }
});

test('reopened INTENT, ATTEMPTED and ACCEPTED owners recover without another enqueue or live policy admission', async (t) => {
  for (const phase of ['INTENT', 'ATTEMPTED', 'ACCEPTED']) {
    await t.test(phase, async () => {
      const value = await fixture();
      let clockCalls = 0;
      let sends = 0;
      const options = workerOptions(value, {
        qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
        clock: () => {
          clockCalls += 1;
          return clockCalls === 3 ? { trusted: false, reason: 'defer-after-snapshot' } : { trusted: true, reason: 'trusted' };
        },
        transport: { async enqueueDownlink() { sends += 1; return { id: 'should-not-enqueue' }; } },
      });
      try {
        const first = await worker.runDue(options);
        assert.equal(first.deferred, 1);
        const runtime = await value.db.get('SELECT * FROM irrigation_runtime_state WHERE singleton_id=1');
        const candidates = await worker.discoverCandidates(value.db, runtime, Date.parse(NOW));
        assert.equal(candidates.length, 1);
        const occurrence = await value.db.get('SELECT * FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
        const expectation = await value.db.get('SELECT * FROM valve_actuation_expectations WHERE command_id=?', [occurrence.command_id]);
        const beforeEvidence = occurrence.decision_evidence_json;
        const beforeSnapshot = JSON.parse(expectation.transport_json).effect_snapshot;
        const transport = JSON.parse(expectation.transport_json);
        transport.phase = phase;
        transport.attempted_at = '2026-10-19T06:05:01.000Z';
        if (phase === 'ACCEPTED') {
          transport.queue_id = 'accepted-before-finalization';
          transport.accepted_at = '2026-10-19T06:05:02.000Z';
        }
        await value.db.run('UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?', [JSON.stringify(transport), expectation.expectation_id]);
        await value.db.run('UPDATE irrigation_occurrences SET state=?, attempted_at=? WHERE command_id=?', ['ATTEMPTED', transport.attempted_at, occurrence.command_id]);
        reopenValue(value);
        await value.db.run("UPDATE irrigation_policies SET enabled=0 WHERE policy_uuid='policy-1'");
        const recovered = await worker.runDue({
          ...options,
          db: value.db,
          clock: () => ({ trusted: true, reason: 'trusted' }),
          discoverCandidates: async () => candidates,
        });
        assert.equal(recovered.recovered, 1);
        assert.equal(sends, 0);
        const after = await value.db.get('SELECT state, queue_id, decision_evidence_json FROM irrigation_occurrences WHERE command_id=?', [occurrence.command_id]);
        const ownerAfter = await value.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id=?', [expectation.expectation_id]);
        const afterTransport = JSON.parse(ownerAfter.transport_json);
        if (phase === 'INTENT' || phase === 'ATTEMPTED') {
          assert.equal(after.state, 'UNKNOWN');
          assert.equal(afterTransport.phase, 'UNKNOWN');
        } else {
          assert.equal(after.state, 'SENT');
          assert.equal(after.queue_id, 'accepted-before-finalization');
          assert.equal(afterTransport.phase, 'ACCEPTED');
        }
        assert.equal(after.decision_evidence_json, beforeEvidence);
        assert.deepEqual(afterTransport.effect_snapshot, beforeSnapshot);
      } finally {
        try { value.raw.close(); } catch (_) { /* already closed */ }
        value.cleanup();
      }
    });
  }
});

test('production discovery recovers durable owners after policy and schedule removal', async (t) => {
  for (const [phase, mutate] of [
    ['INTENT', async (value) => {
      await value.db.run("UPDATE irrigation_policies SET enabled=0 WHERE policy_uuid='policy-1'");
      await value.db.run("UPDATE valve_schedules SET enabled=0 WHERE schedule_uuid='schedule-1'");
    }],
    ['ATTEMPTED', async (value) => {
      await value.db.run('UPDATE irrigation_policies SET deleted_at=? WHERE policy_uuid=?', [NOW, 'policy-1']);
      await value.db.run('UPDATE valve_schedules SET deleted_at=? WHERE schedule_uuid=?', [NOW, 'schedule-1']);
    }],
    ['ACCEPTED', async (value) => {
      await value.db.run("UPDATE irrigation_policies SET enabled=0 WHERE policy_uuid='policy-1'");
      await value.db.run('UPDATE valve_schedules SET deleted_at=? WHERE schedule_uuid=?', [NOW, 'schedule-1']);
    }],
  ]) {
    await t.test(phase, async () => {
      const value = await fixture();
      let sends = 0;
      let evidenceReads = 0;
      try {
        const first = await worker.runDue(workerOptions(value, {
          qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
          clock: (() => {
            let calls = 0;
            return () => {
              calls += 1;
              return calls === 3 ? { trusted: false, reason: 'defer-before-recovery-fixture' } : { trusted: true, reason: 'trusted' };
            };
          })(),
          transport: { async enqueueDownlink() { sends += 1; return { id: 'should-not-enqueue' }; } },
        }));
        assert.equal(first.deferred, 1);
        const occurrence = await value.db.get('SELECT * FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
        const expectation = await value.db.get('SELECT * FROM valve_actuation_expectations WHERE command_id=?', [occurrence.command_id]);
        const beforeEvidence = occurrence.decision_evidence_json;
        const beforeSnapshot = JSON.parse(expectation.transport_json).effect_snapshot;
        const transport = JSON.parse(expectation.transport_json);
        transport.phase = phase;
        transport.attempted_at = '2026-10-19T06:05:01.000Z';
        if (phase === 'ACCEPTED') {
          transport.queue_id = 'production-accepted-queue';
          transport.accepted_at = '2026-10-19T06:05:02.000Z';
        }
        await value.db.run('UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?', [JSON.stringify(transport), expectation.expectation_id]);
        await value.db.run('UPDATE irrigation_occurrences SET state=?, attempted_at=? WHERE command_id=?', ['ATTEMPTED', transport.attempted_at, occurrence.command_id]);
        await mutate(value);
        reopenValue(value);

        const recovered = await worker.runDue(workerOptions(value, {
          qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
          clock: () => ({ trusted: true, reason: 'trusted' }),
          readEvidence: async (input) => { evidenceReads += 1; return observations.readEvidence(input); },
          transport: { async enqueueDownlink() { sends += 1; return { id: 'unexpected-enqueue' }; } },
        }));
        assert.equal(recovered.recovered, 1);
        assert.equal(evidenceReads, 0);
        assert.equal(sends, 0);
        const after = await value.db.get('SELECT state, queue_id, decision_evidence_json FROM irrigation_occurrences WHERE command_id=?', [occurrence.command_id]);
        const ownerAfter = await value.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id=?', [expectation.expectation_id]);
        const afterTransport = JSON.parse(ownerAfter.transport_json);
        if (phase === 'ACCEPTED') {
          assert.equal(after.state, 'SENT');
          assert.equal(after.queue_id, 'production-accepted-queue');
          assert.equal(afterTransport.phase, 'ACCEPTED');
        } else {
          assert.equal(after.state, 'UNKNOWN');
          assert.equal(afterTransport.phase, 'UNKNOWN');
        }
        assert.equal(after.decision_evidence_json, beforeEvidence);
        assert.deepEqual(afterTransport.effect_snapshot, beforeSnapshot);

        const repeated = await worker.runDue(workerOptions(value, {
          qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
          clock: () => ({ trusted: true, reason: 'trusted' }),
          readEvidence: async (input) => { evidenceReads += 1; return observations.readEvidence(input); },
          transport: { async enqueueDownlink() { sends += 1; return { id: 'second-unexpected-enqueue' }; } },
        }));
        assert.equal(repeated.recovered, 0);
        assert.equal(evidenceReads, 0);
        assert.equal(sends, 0);
      } finally {
        try { value.raw.close(); } catch (_) { /* already closed */ }
        value.cleanup();
      }
    });
  }
});

test('reopened audit keeps a due occurrence that was never claimed', async () => {
  const value = await fixture();
  try {
    await value.db.run(
      "UPDATE irrigation_runtime_state SET last_trusted_tick_at=?, last_decided_due_at=?, updated_at=? WHERE singleton_id=1",
      [NOW, NOW, NOW],
    );
    reopenValue(value);
    let evidenceReads = 0;
    const result = await worker.runDue(workerOptions(value, {
      readEvidence: async (input) => { evidenceReads += 1; return observations.readEvidence(input); },
    }));
    assert.equal(result.processed, 1);
    assert.equal(result.skipped, 1);
    assert.equal(evidenceReads, 1);
    assert.equal((await value.db.get('SELECT state FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1'])).state, 'SKIPPED');
  } finally {
    try { value.raw.close(); } catch (_) { /* already closed */ }
    value.cleanup();
  }
});

test('reopened equal-time sibling remains discoverable by its composite occurrence key', async () => {
  const value = await fixture();
  const sibling = 'schedule-2';
  try {
    await value.db.run(
      `INSERT INTO valve_schedules(
        schedule_uuid,device_eui,kind,weekdays_mask,start_time,duration_minutes,timezone,enabled,
        sync_version,condition_policy_uuid,effective_from
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [sibling, DEVICE, 'WEEKLY', 2, '06:00', 5, 'UTC', 1, 1, 'policy-1', '2026-10-18T00:00:00.000Z'],
    );
    await value.db.run(
      `INSERT INTO irrigation_occurrences(
        schedule_uuid,local_date,local_time,policy_uuid,zone_uuid,device_eui,due_at,
        policy_revision,schedule_revision,policy_sync_version,schedule_sync_version,
        state,decision,decision_reason,decision_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        'schedule-1', '2026-10-19', '06:00', 'policy-1', 'zone-1', DEVICE,
        '2026-10-19T06:00:00.000Z', 1, 1, 1, 1, 'SKIPPED', 'SKIPPED', 'qualification_unavailable', NOW,
      ],
    );
    await value.db.run(
      "UPDATE irrigation_runtime_state SET last_trusted_tick_at=?, last_decided_due_at=?, updated_at=? WHERE singleton_id=1",
      ['2026-10-19T06:00:00.000Z', '2026-10-19T06:00:00.000Z', NOW],
    );
    reopenValue(value);
    const result = await worker.runDue(workerOptions(value));
    assert.equal(result.processed, 2);
    assert.equal(result.skipped, 1);
    assert.equal((await value.db.get('SELECT state FROM irrigation_occurrences WHERE schedule_uuid=?', [sibling])).state, 'SKIPPED');
  } finally {
    try { value.raw.close(); } catch (_) { /* already closed */ }
    value.cleanup();
  }
});

test('scope loss after discovery records explicit source and target skips', async (t) => {
  for (const [label, mutate] of [
    ['source policy zone', async (value) => value.db.run("UPDATE irrigation_policies SET zone_uuid='zone-gone' WHERE policy_uuid='policy-1'")],
    ['target valve assignment', async (value) => value.db.run('UPDATE devices SET irrigation_zone_id=NULL WHERE deveui=?', [DEVICE])],
  ]) {
    await t.test(label, async () => {
      const value = await fixture();
      let sends = 0;
      const options = workerOptions(value, {
        qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
        transport: { async enqueueDownlink() { sends += 1; return { id: 'scope-queue' }; } },
      });
      const discover = options.discoverCandidates;
      options.discoverCandidates = async (db, runtime, nowMs) => {
        const candidates = await worker.discoverCandidates(db, runtime, nowMs);
        await mutate(value);
        return candidates;
      };
      try {
        const result = await worker.runDue(options);
        assert.equal(result.errors.length, 0);
        assert.equal(result.skipped, 1);
        assert.equal(sends, 0);
        const row = await value.db.get('SELECT state, decision_reason FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
        assert.equal(row.state, 'SKIPPED');
        assert.equal(row.decision_reason, 'scope_lost');
      } finally {
        options.discoverCandidates = discover;
        value.cleanup();
      }
    });
  }
});

test('actual selected VWC source reassignment agrees across listing, save validation, and execution', async () => {
  const value = await fixture();
  const source = '0016C001F1000002';
  const condition = { kind: 'VWC', threshold_percent: 22, sources: [{ device_eui: source, channel: 'vwc_1' }] };
  try {
    await value.db.run("INSERT INTO app_settings(key, value, updated_at) VALUES ('conditional_irrigation_vwc_enabled', '1', datetime('now'))"); // R17-M1: these exercise VWC with the gate on
    await value.db.run(
      `INSERT INTO devices(
        deveui,name,type_id,user_id,irrigation_zone_id,sdi12_probe_profile,sdi12_probe_status,
        sdi12_value_count,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [source, 'Soil source', 'DRAGINO_SDI12', 1, 1, 'GENERIC_VWC', 'manual', 1, NOW, NOW],
    );
    const policyUuid = '11111111-1111-4111-8111-111111111111';
    await value.db.run('UPDATE irrigation_policies SET policy_uuid=? WHERE policy_uuid=?', [policyUuid, 'policy-1']);
    await value.db.run('UPDATE valve_schedules SET condition_policy_uuid=? WHERE condition_policy_uuid=?', [policyUuid, 'policy-1']);
    const zone = await value.db.get('SELECT * FROM irrigation_zones WHERE id=1');
    const initialOptions = await policyApi.readSourceOptions(value.db, zone, { condition }, Date.parse(NOW));
    const listed = initialOptions.find((entry) => entry.device_eui === source && entry.channel === 'vwc_1');
    assert.equal(listed.eligible, true);

    const saved = await policyApi.applyPolicyEdit({
      db: value.db,
      actor: { user_id: 1 },
      now: '2026-10-18T00:00:00.000Z',
      runtimeClockStatus: () => ({ trusted: true, reason: 'trusted' }),
      qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
      request: {
        policy_uuid: policyUuid, zone_uuid: 'zone-1', expected_policy_version: 1, condition, timezone: 'UTC', enabled: true,
        observation_window_minutes: 60, min_interval_minutes: 60, max_daily_minutes: 240,
        delivery_settings: { [DEVICE]: { delivery_interval_minutes: 10 } }, schedules: [],
      },
    });
    assert.equal(saved.policy.condition.kind, 'VWC');

    await value.db.run('UPDATE devices SET irrigation_zone_id=NULL WHERE deveui=?', [source]);
    const afterOptions = await policyApi.readSourceOptions(value.db, zone, { condition }, Date.parse(NOW));
    assert.equal(afterOptions.some((entry) => entry.device_eui === source), false);
    const resolver = await observations.resolveSourceEligibility(value.db, condition.sources[0], condition, 1, Date.parse(NOW));
    assert.equal(resolver.eligible, false);
    assert.equal(resolver.reason, 'device_not_assigned_to_zone');

    await assert.rejects(
      policyApi.applyPolicyEdit({
        db: value.db,
        actor: { user_id: 1 },
        now: '2026-10-18T00:01:00.000Z',
        runtimeClockStatus: () => ({ trusted: true, reason: 'trusted' }),
        qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
        request: {
          policy_uuid: policyUuid, zone_uuid: 'zone-1', expected_policy_version: saved.policy.sync_version, condition, timezone: 'UTC', enabled: true,
          observation_window_minutes: 60, min_interval_minutes: 60, max_daily_minutes: 240,
          delivery_settings: { [DEVICE]: { delivery_interval_minutes: 10 } }, schedules: [],
        },
      }),
      (error) => error.code === 'source_ineligible' && error.details && error.details.reason === resolver.reason,
    );

    let sends = 0;
    const options = workerOptions(value, {
      qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
      transport: { async enqueueDownlink() { sends += 1; return { id: 'source-scope-queue' }; } },
    });
    options.discoverCandidates = async (db, runtime, nowMs) => {
      const candidates = await worker.discoverCandidates(db, runtime, nowMs);
      await value.db.run('UPDATE devices SET irrigation_zone_id=NULL WHERE deveui=?', [source]);
      return candidates;
    };
    const execution = await worker.runDue(options);
    assert.equal(execution.skipped, 1);
    assert.equal(sends, 0);
    const row = await value.db.get('SELECT state, decision, decision_reason, decision_evidence_json FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
    assert.equal(row.state, 'SKIPPED');
    assert.equal(row.decision, 'UNKNOWN');
    assert.equal(row.decision_reason, 'scope_lost');
    const evidence = JSON.parse(row.decision_evidence_json);
    assert.equal(evidence.observation.sources[0].reason, resolver.reason);
  } finally {
    value.cleanup();
  }
});

test('deleted and decommissioned selected sources retain resolver reasons as scope_lost', async (t) => {
  for (const [label, mutate, expectedReason] of [
    ['deleted identity', async (value, source) => value.db.run('UPDATE devices SET deleted_at=? WHERE deveui=?', [NOW, source]), 'device_not_found'],
    ['removed commissioned channel', async (value, source) => value.db.run('UPDATE devices SET sdi12_value_count=NULL WHERE deveui=?', [source]), 'channel_not_commissioned'],
    ['disabled probe configuration', async (value, source) => value.db.run("UPDATE devices SET sdi12_probe_status='pending_identify' WHERE deveui=?", [source]), 'channel_not_commissioned'],
  ]) {
    await t.test(label, async () => {
      const value = await fixture();
      const source = '0016C001F1000002';
      const policyUuid = '22222222-2222-4222-8222-222222222222';
      const condition = { kind: 'VWC', threshold_percent: 22, sources: [{ device_eui: source, channel: 'vwc_1' }] };
      try {
      await value.db.run("INSERT INTO app_settings(key, value, updated_at) VALUES ('conditional_irrigation_vwc_enabled', '1', datetime('now'))"); // R17-M1: these exercise VWC with the gate on
        await value.db.run(
          `INSERT INTO devices(
            deveui,name,type_id,user_id,irrigation_zone_id,sdi12_probe_profile,sdi12_probe_status,
            sdi12_value_count,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [source, 'Soil source', 'DRAGINO_SDI12', 1, 1, 'GENERIC_VWC', 'manual', 1, NOW, NOW],
        );
        await value.db.run('UPDATE irrigation_policies SET policy_uuid=?, condition_json=? WHERE policy_uuid=?', [policyUuid, JSON.stringify(condition), 'policy-1']);
        await value.db.run('UPDATE valve_schedules SET condition_policy_uuid=? WHERE condition_policy_uuid=?', [policyUuid, 'policy-1']);
        const zone = await value.db.get('SELECT * FROM irrigation_zones WHERE id=1');
        const before = await policyApi.readSourceOptions(value.db, zone, { condition }, Date.parse(NOW));
        assert.equal(before.find((entry) => entry.device_eui === source && entry.channel === 'vwc_1').eligible, true);
        const runtime = await value.db.get('SELECT * FROM irrigation_runtime_state WHERE singleton_id=1');
        const candidates = await worker.discoverCandidates(value.db, runtime, Date.parse(NOW));
        assert.equal(candidates.length, 1);
        await mutate(value, source);
        const after = await policyApi.readSourceOptions(value.db, zone, { condition }, Date.parse(NOW));
        assert.equal(after.some((entry) => entry.device_eui === source && entry.channel === 'vwc_1'), false);
        const resolver = await observations.resolveSourceEligibility(value.db, condition.sources[0], condition, 1, Date.parse(NOW));
        assert.equal(resolver.reason, expectedReason);
        await assert.rejects(
          policyApi.applyPolicyEdit({
            db: value.db, actor: { user_id: 1 }, now: '2026-10-18T00:01:00.000Z',
            runtimeClockStatus: () => ({ trusted: true, reason: 'trusted' }),
            qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
            request: {
              policy_uuid: policyUuid, zone_uuid: 'zone-1', expected_policy_version: 1, condition,
              timezone: 'UTC', enabled: true, observation_window_minutes: 60, min_interval_minutes: 60,
              max_daily_minutes: 240, delivery_settings: { [DEVICE]: { delivery_interval_minutes: 10 } }, schedules: [],
            },
          }),
          (error) => error.code === 'source_ineligible' && error.details && error.details.reason === expectedReason,
        );
        let sends = 0;
        const result = await worker.runDue(workerOptions(value, {
          qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
          transport: { async enqueueDownlink() { sends += 1; return { id: 'scope-matrix-queue' }; } },
          discoverCandidates: async () => candidates,
        }));
        assert.equal(result.skipped, 1);
        assert.equal(sends, 0);
        const row = await value.db.get('SELECT state, decision, decision_reason, decision_evidence_json FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
        assert.equal(row.state, 'SKIPPED');
        assert.equal(row.decision, 'UNKNOWN');
        assert.equal(row.decision_reason, 'scope_lost');
        assert.equal(JSON.parse(row.decision_evidence_json).observation.sources[0].reason, expectedReason);
      } finally {
        value.cleanup();
      }
    });
  }
});

test('missing and malformed dendro evidence become explicit sensor skips', async (t) => {
  for (const [label, mutate] of [
    ['missing source row', async (value) => value.db.run('DELETE FROM zone_daily_recommendations WHERE zone_id=1')],
    ['unknown raw analysis', async (value) => value.db.run('UPDATE zone_daily_recommendations SET recommendation_json=? WHERE zone_id=1', ['{"raw_evidence":{"version":1},"raw_decision":{"version":1}}'])],
  ]) {
    await t.test(label, async () => {
      const value = await fixture();
      let sends = 0;
      try {
        await mutate(value);
        const result = await worker.runDue(workerOptions(value, {
          qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
          transport: { async enqueueDownlink() { sends += 1; return { id: 'evidence-queue' }; } },
        }));
        assert.equal(result.skipped, 1);
        assert.equal(sends, 0);
        const row = await value.db.get('SELECT state, decision, decision_reason, decision_evidence_json FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
        assert.equal(row.state, 'SKIPPED');
        assert.equal(row.decision, 'UNKNOWN');
        assert.equal(row.decision_reason, 'sensor_unavailable');
        const evidence = JSON.parse(row.decision_evidence_json);
        assert.equal(evidence.evaluation.status, 'UNKNOWN');
      } finally {
        value.cleanup();
      }
    });
  }
});

test('skip-today is an explicit decision before evidence or transport', async () => {
  const value = await fixture();
  let evidenceReads = 0;
  let sends = 0;
  try {
    await value.db.run("UPDATE valve_settings SET scheduler_status='SKIP_TODAY', skip_today_date='2026-10-19' WHERE device_eui=?", [DEVICE]);
    const result = await worker.runDue(workerOptions(value, {
      readEvidence: async (input) => { evidenceReads += 1; return observations.readEvidence(input); },
      qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
      transport: { async enqueueDownlink() { sends += 1; return { id: 'skip-queue' }; } },
    }));
    assert.equal(result.skipped, 1);
    assert.equal(evidenceReads, 0);
    assert.equal(sends, 0);
    const row = await value.db.get('SELECT state, decision_reason FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
    assert.equal(row.state, 'SKIPPED');
    assert.equal(row.decision_reason, 'skip_today');
  } finally {
    value.cleanup();
  }
});

// R13-M1: Pause (scheduler_status DEACTIVATED) on a conditional valve stops conditional opens
// until Resume, like skip-today, before evidence or transport.
test('a paused conditional valve gets no open; resume restores openings', async () => {
  for (const [status, expectSkip] of [['DEACTIVATED', true], ['ACTIVE', false]]) {
    const value = await fixture();
    let sends = 0;
    try {
      await value.db.run("UPDATE valve_settings SET scheduler_status=?, skip_today_date=NULL WHERE device_eui=?", [status, DEVICE]);
      await worker.runDue(workerOptions(value, {
        qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
        transport: { async getDeviceQueue() { return []; }, async flushDeviceQueue() {}, async enqueueDownlink() { sends += 1; return { id: 'pause-queue-' + sends }; } },
      }));
      const row = await value.db.get('SELECT state, decision_reason FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
      if (expectSkip) {
        assert.equal(row.state, 'SKIPPED', status);
        assert.equal(row.decision_reason, 'scheduler_paused');
        assert.equal(sends, 0, 'nothing is sent while paused');
      } else {
        assert.equal(row.state, 'SENT', 'after resume the due occurrence opens');
        assert.equal(sends, 1);
      }
    } finally {
      value.cleanup();
    }
  }
});

test('historical bounded watering is reprojected into the changed policy timezone', async () => {
  const value = await fixture();
  const now = '2026-10-17T01:05:00.000Z';
  try {
    await configureDue(value, {
      dueAt: '2026-10-17T01:00:00.000Z',
      localDate: '2026-10-16',
      startTime: '18:00',
      weekdaysMask: 32,
      timezone: 'America/Los_Angeles',
      durationMinutes: 20,
      maxDailyMinutes: 40,
      effectiveFrom: '2026-10-16T00:00:00.000Z',
    });
    await insertBoundedHistory(value, {
      reservationStartAt: '2026-10-17T00:10:00.000Z',
      reservationEndAt: '2026-10-17T00:40:00.000Z',
      reservedMinutes: 30,
      capturedTimezone: 'UTC',
      capturedLocalDays: ['2026-10-17'],
      exclusionEndAt: '2026-10-17T00:50:00.000Z',
    });

    const accounting = await dispatch.getDailyAccounting({ db: value.db, deviceEui: DEVICE, timezone: 'America/Los_Angeles' });
    assert.deepEqual(accounting.days, { '2026-10-16': 30 });
    assert.equal(accounting.runs.length, 1);
    assert.deepEqual(accounting.runs[0].captured_local_days, ['2026-10-17']);
    assert.equal(accounting.runs[0].source, 'conservative');

    let sends = 0;
    const result = await worker.runDue(workerOptions(value, {
      now,
      qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
      transport: { async enqueueDownlink() { sends += 1; return { id: 'timezone-queue' }; } },
    }));
    assert.equal(result.skipped, 1);
    assert.equal(sends, 0);
    const row = await value.db.get('SELECT state, decision_reason FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
    assert.equal(row.state, 'SKIPPED');
    assert.equal(row.decision_reason, 'daily_limit');
  } finally {
    value.cleanup();
  }
});

test('report-only intervals filter by candidate day while retaining the midnight gap', async () => {
  const value = await fixture();
  try {
    await configureDue(value, {
      dueAt: '2026-10-19T00:25:00.000Z',
      localDate: '2026-10-19',
      startTime: '00:25',
      weekdaysMask: 2,
      timezone: 'UTC',
      durationMinutes: 5,
      minIntervalMinutes: 60,
      effectiveFrom: '2026-10-18T00:00:00.000Z',
    });
    await insertReportOnly(value, {
      earliestPossibleStartAt: '2026-10-18T23:50:00.000Z',
      latestPossibleEndAt: '2026-10-18T23:59:00.000Z',
    });
    const accounting = await dispatch.getDailyAccounting({ db: value.db, deviceEui: DEVICE, timezone: 'UTC' });
    assert.deepEqual(accounting.unknown_intervals[0].affected_local_days, ['2026-10-18']);

    let sends = 0;
    const result = await worker.runDue(workerOptions(value, {
      now: '2026-10-19T00:30:00.000Z',
      qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
      transport: { async enqueueDownlink() { sends += 1; return { id: 'report-queue' }; } },
    }));
    assert.equal(result.skipped, 1);
    assert.equal(sends, 0);
    const row = await value.db.get('SELECT state, decision_reason FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
    assert.equal(row.state, 'SKIPPED');
    assert.equal(row.decision_reason, 'recent_irrigation');
  } finally {
    value.cleanup();
  }
});

test('report-only interval ended on the prior local day permits a later candidate after the gap', async () => {
  const value = await fixture();
  try {
    await configureDue(value, {
      dueAt: '2026-10-19T01:00:00.000Z',
      localDate: '2026-10-19',
      startTime: '01:00',
      weekdaysMask: 2,
      timezone: 'UTC',
      durationMinutes: 5,
      minIntervalMinutes: 60,
      effectiveFrom: '2026-10-18T00:00:00.000Z',
    });
    await insertReportOnly(value, {
      earliestPossibleStartAt: '2026-10-18T23:50:00.000Z',
      latestPossibleEndAt: '2026-10-18T23:59:00.000Z',
      expectationId: 'report-only-prior-day',
    });
    let sends = 0;
    const result = await worker.runDue(workerOptions(value, {
      now: '2026-10-19T01:05:00.000Z',
      qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
      transport: { async enqueueDownlink() { sends += 1; return { id: 'report-later-queue' }; } },
    }));
    assert.equal(result.dispatched, 1);
    assert.equal(sends, 1);
    const row = await value.db.get('SELECT state FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
    assert.equal(row.state, 'SENT');
  } finally {
    value.cleanup();
  }
});

// R17-M1 / D18 (W29): while the edge VWC gate (app_settings conditional_irrigation_vwc_enabled,
// default off) is off, a VWC-condition policy never opens: the occurrence is SKIPPED with reason
// vwc_condition_disabled before any evidence is read or anything is sent (surfaced, never
// treated as satisfied).
test('R17-M1: a VWC policy does not open while the VWC gate is off; turning the gate on lets it evaluate', async () => {
  for (const [gate, expectDisabled] of [[null, true], ['0', true], ['1', false]]) {
    const value = await fixture();
    let sends = 0; let evidenceReads = 0;
    try {
      const condition = { kind: 'VWC', threshold_percent: 22, sources: [{ device_eui: '0016C001F1000002', channel: 'vwc_1' }] };
      await value.db.run('UPDATE irrigation_policies SET condition_json=? WHERE policy_uuid=?', [JSON.stringify(condition), 'policy-1']);
      if (gate != null) await value.db.run("INSERT INTO app_settings(key, value, updated_at) VALUES ('conditional_irrigation_vwc_enabled', ?, datetime('now'))", [gate]);
      await worker.runDue(workerOptions(value, {
        readEvidence: async () => { evidenceReads += 1; return { sources: [], due_at: NOW, observation_window_minutes: 60 }; },
        qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
        transport: { async getDeviceQueue() { return []; }, async flushDeviceQueue() {}, async enqueueDownlink() { sends += 1; return { id: 'vwc-q' }; } },
      }));
      const row = await value.db.get('SELECT state, decision_reason FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
      if (expectDisabled) {
        assert.deepEqual({ state: row.state, reason: row.decision_reason }, { state: 'SKIPPED', reason: 'vwc_condition_disabled' }, String(gate));
        assert.equal(evidenceReads, 0);
        assert.equal(sends, 0);
      } else {
        assert.notEqual(row.decision_reason, 'vwc_condition_disabled');
        assert.equal(evidenceReads, 1, 'with the gate on the condition is evaluated');
      }
    } finally {
      value.cleanup();
    }
  }
});

// Owner decision 2026-10-24: a conditional open no longer needs an NTP sync since boot. With the
// production clock gate (no injected clock) and no NTP marker, a due occurrence still opens.
test('NTP removal: a due conditional occurrence opens without an NTP marker', async () => {
  const value = await fixture();
  let sends = 0;
  try {
    const options = workerOptions(value, {
      qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
      transport: { async getDeviceQueue() { return []; }, async flushDeviceQueue() {}, async enqueueDownlink() { sends += 1; return { id: 'no-ntp-' + sends }; } },
    });
    delete options.clock;
    const clockOptions = options.clockOptions;
    const read = clockOptions.fs.readFileSync.bind(clockOptions.fs);
    clockOptions.fs.readFileSync = (path) => {
      if (path === clockOptions.markerPath) throw Object.assign(new Error('no NTP marker'), { code: 'ENOENT' });
      return read(path);
    };
    await worker.runDue(options);
    const row = await value.db.get('SELECT state FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
    assert.equal(row && row.state, 'SENT', JSON.stringify(row));
    assert.equal(sends, 1);
  } finally {
    value.cleanup();
  }
});

// R19 finding 9 (low): a RESERVED occurrence resumed after a crash re-runs the dispatch gates
// (pause, skip today, readiness, VWC gate, incidents) instead of sending straight away. A failed
// gate expires the reservation and releases the valve; nothing is sent.
test('R19-9: a resumed RESERVED occurrence is not sent when the valve was paused in between', async () => {
  const value = await fixture();
  let clockCalls = 0;
  let sends = 0;
  const options = workerOptions(value, {
    qualificationProvider: () => ({ qualified: true, identity: 'fixture-gen1', margin_seconds: 0 }),
    clock: () => {
      clockCalls += 1;
      return clockCalls === 3 ? { trusted: false, reason: 'clock_untrusted_lower_bound' } : { trusted: true, reason: 'trusted' };
    },
    transport: { async enqueueDownlink() { sends += 1; return { id: 'resumed-after-pause' }; } },
  });
  try {
    await worker.runDue(options);
    const reserved = await value.db.get('SELECT state, command_id FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
    assert.equal(reserved.state, 'RESERVED');
    reopenValue(value);
    await value.db.run("UPDATE valve_settings SET scheduler_status='DEACTIVATED' WHERE device_eui=?", [DEVICE]);
    await worker.runDue({ ...options, db: value.db, clock: () => ({ trusted: true, reason: 'trusted' }) });
    assert.equal(sends, 0, 'nothing is sent after the pause');
    const after = await value.db.get('SELECT state, decision_reason FROM irrigation_occurrences WHERE schedule_uuid=?', ['schedule-1']);
    assert.equal(after.state, 'EXPIRED');
    const expectation = await value.db.get('SELECT reconciliation_state, cancel_reason FROM valve_actuation_expectations WHERE command_id=?', [reserved.command_id]);
    assert.equal(expectation.reconciliation_state, 'CANCELLED', 'the reservation no longer fences the valve');
    assert.equal(expectation.cancel_reason, 'scheduler_paused');
  } finally {
    try { value.raw.close(); } catch (_) { /* already closed */ }
    value.cleanup();
  }
});
