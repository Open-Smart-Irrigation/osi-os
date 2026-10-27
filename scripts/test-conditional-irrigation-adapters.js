#!/usr/bin/env node
'use strict';

// Executes the shipped pending-command adapter against SQLite for both Pi
// profiles.  The fixture uses valid wire UUIDs so the ledger's effect-key
// grammar, the policy service, and the durable ACK path are exercised together.

const assert = require('node:assert/strict');
const test = require('node:test');
const { executeFunction, loadNode, profilePaths, seedScopedDb } = require('./lib/scoped-access-harness');

const PROFILES = ['bcm2712', 'bcm2709'];
const GATEWAY = '0016C001F1000002';
const VALVE = '0016C001F1000001';
const ZONE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const POLICY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SCHEDULE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACTOR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const AT = '2026-10-20T10:00:00.000Z';

function uuid(number) {
  return `11111111-1111-4111-8111-${String(number).padStart(12, '0')}`;
}

function policyFixture(db) {
  // The cloud command creator is a delegated edge user. Keep the zone owned
  // by another user so deleting this assignment below proves fresh scope
  // enforcement rather than falling back to owner access.
  db.prepare('UPDATE users SET user_uuid=? WHERE id=2').run(ACTOR);
  db.prepare('UPDATE user_zone_assignments SET user_uuid=? WHERE user_uuid=?').run(ACTOR, 'u-res1');
  db.prepare('UPDATE irrigation_zones SET user_id=1 WHERE id=1').run();
  db.prepare('UPDATE irrigation_zones SET zone_uuid=?, gateway_device_eui=? WHERE id=1').run(ZONE, GATEWAY);
  db.prepare('UPDATE user_zone_assignments SET zone_uuid=? WHERE user_uuid=? AND zone_uuid=?').run(ZONE, ACTOR, 'z-1');
  db.prepare('UPDATE devices SET gateway_device_eui=? WHERE UPPER(deveui)=UPPER(?)').run(GATEWAY, VALVE);
  db.prepare(`INSERT INTO irrigation_policies(
    policy_uuid,zone_uuid,condition_json,timezone,enabled,observation_window_minutes,
    min_interval_minutes,max_daily_minutes,delivery_settings_json,effective_from,sync_version,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    POLICY, ZONE, JSON.stringify({ kind: 'DENDRO', minimum_stress: 'moderate', response_mode: 'fixed' }),
    'UTC', 1, 60, 60, 240, '{}', AT, 4, AT, AT,
  );
  db.prepare(`INSERT INTO valve_schedules(
    schedule_uuid,device_eui,kind,label,weekdays_mask,start_time,duration_minutes,timezone,
    enabled,sync_version,condition_policy_uuid,effective_from,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    SCHEDULE, VALVE, 'WEEKLY', 'Conditional adapter fixture', 127, '06:00', 10, 'UTC',
    1, 7, POLICY, AT, AT, AT,
  );
}

function envelope(commandId, commandType, requestId, payload = {}) {
  const effectKey = `irrigation_policy:${commandType.toLowerCase()}:${ACTOR}:${GATEWAY}:${ZONE}:${requestId}`;
  const appliedSyncVersion = commandType === 'UPSERT_IRRIGATION_POLICY'
    ? 5
    : commandType === 'PAUSE_IRRIGATION_POLICY' ? 6 : null;
  return {
    commandId,
    commandType,
    eventUuid: uuid(commandId),
    aggregateType: 'IRRIGATION_POLICY',
    aggregateKey: ZONE,
    effectKey,
    appliedSyncVersion,
    actorUserUuid: ACTOR,
    payload: {
      ...payload,
      commandType,
      effect_key: effectKey,
      request_id: requestId,
      gateway_device_eui: GATEWAY,
      zone_uuid: ZONE,
    },
  };
}

function transportRecorder() {
  const calls = [];
  return {
    calls,
    async getDeviceQueue() { calls.push('get'); return []; },
    async flushDeviceQueue() { calls.push('flush'); return { ok: true }; },
    async enqueueDownlink() { calls.push('enqueue'); return { id: `adapter-${calls.length}` }; },
  };
}

async function runCommand(profile, db, command, transport) {
  const paths = profilePaths(profile);
  return executeFunction(loadNode('conditional-lifecycle-command-adapter', paths.flowsPath), {
    msg: { payload: { _pendingCommandEnvelope: command }, _commandTypeRecognized: true },
    env: { DEVICE_EUI: GATEWAY },
    db,
    libOverrides: { chirpstack: { createProvisioningClientFromEnv: () => transport } },
  });
}

for (const profile of PROFILES) {
  test(`${profile}: all conditional policy commands use the protected ledger and replay safely`, async () => {
    const db = seedScopedDb(VALVE);
    const transport = transportRecorder();
    try {
      policyFixture(db);
      const upsertRequest = {
        policy_uuid: POLICY,
        expected_policy_version: 4,
        condition: { kind: 'DENDRO', minimum_stress: 'moderate', response_mode: 'fixed' },
        timezone: 'UTC',
        enabled: false,
        observation_window_minutes: 60,
        min_interval_minutes: 60,
        max_daily_minutes: 240,
        delivery_settings: {},
        schedules: [{
          schedule_uuid: SCHEDULE,
          device_eui: VALVE,
          expected_sync_version: 7,
          weekdays_mask: 127,
          start_time: '06:00',
          duration_minutes: 10,
          enabled: true,
          execution: 'conditional',
        }],
      };
      const upsert = envelope(701, 'UPSERT_IRRIGATION_POLICY', uuid(701), upsertRequest);
      const applied = await runCommand(profile, db, upsert, transport);
      const appliedAck = applied.result[1].payload;
      assert.equal(appliedAck.result, 'APPLIED');
      assert.equal(appliedAck.appliedSyncVersion, 5, 'ACK must preserve the trusted envelope target version');
      assert.equal(db.prepare('SELECT enabled,sync_version FROM irrigation_policies WHERE policy_uuid=?').get(POLICY).enabled, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?').get('701').n, 1);

      const replay = await runCommand(profile, db, { ...upsert, commandId: 702, eventUuid: uuid(702) }, transport);
      assert.equal(replay.result[1].payload.result, 'APPLIED');
      assert.equal(replay.result[1].payload.duplicate, true);
      assert.equal(replay.result[1].payload.appliedSyncVersion, 5, 'replay ACK must retain the terminal target version');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM applied_commands WHERE effect_key=?').get(upsert.effectKey).n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox').get().n, 2);
      assert.equal(db.prepare('SELECT enabled,sync_version FROM irrigation_policies WHERE policy_uuid=?').get(POLICY).sync_version, 5);

      const pause = envelope(703, 'PAUSE_IRRIGATION_POLICY', uuid(703), { expected_policy_version: 5 });
      const paused = await runCommand(profile, db, pause, transport);
      assert.equal(paused.result[1].payload.result, 'APPLIED');
      assert.equal(db.prepare('SELECT enabled,sync_version FROM irrigation_policies WHERE policy_uuid=?').get(POLICY).sync_version, 6);

      const stalePause = envelope(704, 'PAUSE_IRRIGATION_POLICY', uuid(704), { expected_policy_version: 5 });
      const rejected = await runCommand(profile, db, stalePause, transport);
      assert.equal(rejected.result[1].payload.result, 'REJECTED_PERMANENT');
      // The command ledger intentionally exposes the service error text in
      // both reason/detail for a durable wire ACK.  The service code remains
      // available on the in-process error; this is the shipped ACK contract.
      assert.equal(rejected.result[1].payload.reason, 'policy version conflict');
      assert.equal(db.prepare('SELECT enabled,sync_version FROM irrigation_policies WHERE policy_uuid=?').get(POLICY).sync_version, 6);

      const retry = envelope(705, 'RETRY_IRRIGATION_VALVE', uuid(705), { device_eui: VALVE });
      const retried = await runCommand(profile, db, retry, transport);
      assert.equal(retried.result[1].payload.result, 'APPLIED');
      assert.ok(transport.calls.includes('enqueue'), 'retry must use the post-commit valve transport');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?').get('705').n, 1);
      assert.ok(db.prepare('SELECT COUNT(*) AS n FROM conditional_irrigation_sync_projections').get().n >= 1, 'post-commit key notification must publish a projection');

      db.prepare('DELETE FROM user_zone_assignments WHERE user_uuid=? AND zone_uuid=?').run(ACTOR, ZONE);
      for (const [commandType, commandId, request, expectedReason] of [
        ['UPSERT_IRRIGATION_POLICY', 706, { ...upsertRequest, enabled: true, expected_policy_version: 6 }, 'zone not found'],
        ['PAUSE_IRRIGATION_POLICY', 707, { expected_policy_version: 6 }, 'zone not found'],
        ['RETRY_IRRIGATION_VALVE', 708, { device_eui: VALVE }, 'zone not found'],
      ]) {
        const revoked = await runCommand(profile, db, envelope(commandId, commandType, uuid(commandId), request), transport);
        assert.equal(revoked.result[1].payload.result, 'REJECTED_PERMANENT', commandType + ' must recheck revoked scope');
        assert.equal(revoked.result[1].payload.reason, expectedReason, commandType + ' rejection reason');
      }
      assert.equal(db.prepare('SELECT enabled,sync_version FROM irrigation_policies WHERE policy_uuid=?').get(POLICY).sync_version, 6);
    } finally {
      db.close();
    }
  });
}

// R19 finding 5: the cloud policy command must take the valve writers before it opens its
// SQLite write transaction, as the lifecycle adapter does. A writer holder (a manual open or a
// cancel waiting on gRPC) must be able to run its own transaction when it resumes; the command
// waits for the writer instead of holding the write lock while it waits.
const path = require('node:path');
for (const profile of PROFILES) {
  test(`${profile}: R19-5 the cloud policy command takes the valve writer before its ledger transaction`, async () => {
    const db = seedScopedDb(VALVE);
    try {
      policyFixture(db);
      const dispatch = require(path.join(profilePaths('bcm2712').nodeRedModules, 'osi-valve-control/dispatch'));
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const events = [];
      const holder = dispatch.withValveWriter(VALVE, async () => {
        await gate;
        db.exec('BEGIN IMMEDIATE');
        db.prepare('UPDATE devices SET updated_at=? WHERE UPPER(deveui)=UPPER(?)').run(AT, VALVE);
        db.exec('COMMIT');
        events.push('holder-committed');
      });
      const command = runCommand(profile, db, envelope(721, 'PAUSE_IRRIGATION_POLICY', uuid(721), { expected_policy_version: 4 }), transportRecorder())
        .then((out) => { events.push('command-done'); return out; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      await holder;
      const out = await command;
      assert.deepEqual(events, ['holder-committed', 'command-done']);
      assert.equal(out.result[1].payload.result, 'APPLIED', JSON.stringify(out.result[1].payload));
    } finally {
      db.close();
    }
  });
}

// R19 finding 8 (low): a malformed cloud policy command that carries a command id is answered
// REJECTED_PERMANENT (durably) instead of being dropped and re-delivered until it expires.
for (const profile of PROFILES) {
  test(`${profile}: R19-8 a cloud policy command without an actor is ACKed REJECTED_PERMANENT`, async () => {
    const db = seedScopedDb(VALVE);
    try {
      policyFixture(db);
      const command = envelope(731, 'PAUSE_IRRIGATION_POLICY', uuid(731), { expected_policy_version: 4 });
      delete command.actorUserUuid;
      const out = await runCommand(profile, db, command, transportRecorder());
      const ack = out.result[1] && out.result[1].payload;
      assert.ok(ack, 'an ACK is emitted');
      assert.equal(ack.result, 'REJECTED_PERMANENT');
      assert.equal(ack.commandId, 731);
      const rows = db.prepare('SELECT payload_json FROM command_ack_outbox WHERE command_id=?').all('731');
      assert.equal(rows.length, 1, 'one durable ACK row');
      assert.equal(JSON.parse(rows[0].payload_json).result, 'REJECTED_PERMANENT');
      assert.equal(db.prepare('SELECT sync_version FROM irrigation_policies WHERE policy_uuid=?').get(POLICY).sync_version, 4, 'nothing applied');
    } finally {
      db.close();
    }
  });
}

// Cloud fix (osi-server PR #389): the cloud retires a policy with UPSERT_IRRIGATION_POLICY
// enabled:false and its last weekly row disabled; no_targets applies only to an enabled policy.
for (const profile of PROFILES) {
  test(`${profile}: a cloud UPSERT_IRRIGATION_POLICY may retire a policy to zero enabled rows`, async () => {
    const db = seedScopedDb(VALVE);
    try {
      policyFixture(db);
      const retire = envelope(741, 'UPSERT_IRRIGATION_POLICY', uuid(741), {
        policy_uuid: POLICY, expected_policy_version: 4,
        condition: { kind: 'DENDRO', minimum_stress: 'moderate', response_mode: 'fixed' },
        timezone: 'UTC', enabled: false, observation_window_minutes: 60, min_interval_minutes: 60, max_daily_minutes: 240, delivery_settings: {},
        schedules: [{ schedule_uuid: SCHEDULE, device_eui: VALVE, expected_sync_version: 7, weekdays_mask: 127, start_time: '06:00', duration_minutes: 10, enabled: false, execution: 'conditional' }],
      });
      const out = await runCommand(profile, db, retire, transportRecorder());
      assert.equal(out.result[1].payload.result, 'APPLIED', JSON.stringify(out.result[1].payload));
      assert.equal(db.prepare('SELECT enabled FROM irrigation_policies WHERE policy_uuid=?').get(POLICY).enabled, 0);
      assert.equal(db.prepare('SELECT enabled FROM valve_schedules WHERE schedule_uuid=?').get(SCHEDULE).enabled, 0);
    } finally {
      db.close();
    }
  });
}

// Cloud stop path (contract: PAUSE_IRRIGATION_POLICY.expected_policy_version may be null).
// A null-version PAUSE pauses the current policy version, also when a newer cloud edit was
// not applied on the edge (here: refused retryable) and when the edge's version moved on
// without the cloud knowing it.
for (const profile of PROFILES) {
  test(`${profile}: a null-version cloud PAUSE pauses the current version after an unapplied edit`, async () => {
    const db = seedScopedDb(VALVE);
    const transport = transportRecorder();
    try {
      policyFixture(db);
      const edit = envelope(741, 'UPSERT_IRRIGATION_POLICY', uuid(741), {
        policy_uuid: POLICY,
        expected_policy_version: 4,
        schedules: [{ schedule_uuid: SCHEDULE, expected_sync_version: 7, duration_minutes: 25 }],
      });
      const edited = await runCommand(profile, db, edit, transport);
      assert.equal(edited.result[1].payload.result, 'FAILED_RETRYABLE', 'the enabled edit is not applied on this gateway');
      assert.deepEqual({ ...db.prepare('SELECT enabled,sync_version FROM irrigation_policies WHERE policy_uuid=?').get(POLICY) },
        { enabled: 1, sync_version: 4 });

      const pause = envelope(742, 'PAUSE_IRRIGATION_POLICY', uuid(742), { expected_policy_version: null });
      const paused = await runCommand(profile, db, pause, transport);
      assert.equal(paused.result[1].payload.result, 'APPLIED', JSON.stringify(paused.result[1].payload));
      assert.deepEqual({ ...db.prepare('SELECT enabled,sync_version FROM irrigation_policies WHERE policy_uuid=?').get(POLICY) },
        { enabled: 0, sync_version: 5 }, 'the pause applies to the current version');

      // The edge version moved on (a local edit the cloud has not seen): a null pause still applies.
      db.prepare('UPDATE irrigation_policies SET enabled=1, sync_version=9 WHERE policy_uuid=?').run(POLICY);
      const again = await runCommand(profile, db, envelope(743, 'PAUSE_IRRIGATION_POLICY', uuid(743), { expected_policy_version: null }), transport);
      assert.equal(again.result[1].payload.result, 'APPLIED', JSON.stringify(again.result[1].payload));
      assert.deepEqual({ ...db.prepare('SELECT enabled,sync_version FROM irrigation_policies WHERE policy_uuid=?').get(POLICY) },
        { enabled: 0, sync_version: 10 });
    } finally {
      db.close();
    }
  });
}
