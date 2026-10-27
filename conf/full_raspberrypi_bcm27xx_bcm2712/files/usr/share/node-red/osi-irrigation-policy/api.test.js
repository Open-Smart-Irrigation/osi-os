'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const api = require('./api');
const clock = require('./clock');
const dispatch = require('../osi-valve-control/dispatch');
const push = require('../osi-valve-control/push');
const scopeHelper = require('../osi-scope-helper');

const SEED = path.resolve(__dirname, '../../db/farming.db');
const VALVE = '0011223344556677';

function fixture() {
  const file = path.join(os.tmpdir(), `osi-policy-api-${process.pid}-${Math.random().toString(16).slice(2)}.db`);
  fs.copyFileSync(SEED, file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON');
  db.prepare("INSERT INTO users(id,username,password_hash,created_at,updated_at,role,user_uuid) VALUES (1,'policy-test','hash',datetime('now'),datetime('now'),'researcher','user-policy-test')").run();
  db.prepare("INSERT INTO irrigation_zones(id,name,user_id,created_at,updated_at,timezone,zone_uuid) VALUES (1,'Policy zone',1,datetime('now'),datetime('now'),'UTC','zone-policy-test')").run();
  db.prepare("INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id) VALUES (?,?,?,?,datetime('now'),datetime('now'),?)").run(VALVE, 'Policy valve', 'STREGA_VALVE', 1, 1);
  const adapt = (value) => value === undefined ? null : value;
  return {
    file,
    db: {
      async run(sql, params = []) { db.prepare(sql).run(...params.map(adapt)); },
      async get(sql, params = []) { return db.prepare(sql).get(...params.map(adapt)) || null; },
      async all(sql, params = []) { return db.prepare(sql).all(...params.map(adapt)); },
      async exec(sql) { db.exec(sql); },
      async transaction(fn) {
        db.exec('BEGIN IMMEDIATE');
        const tx = {
          run: async (sql, params = []) => { db.prepare(sql).run(...params.map(adapt)); },
          get: async (sql, params = []) => db.prepare(sql).get(...params.map(adapt)) || null,
          all: async (sql, params = []) => db.prepare(sql).all(...params.map(adapt)),
          exec: async (sql) => { db.exec(sql); },
        };
        try { const result = await fn(tx); db.exec('COMMIT'); return result; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      close() { db.close(); },
      prepare(sql) { return db.prepare(sql); },
    },
  };
}

function closeFixture(fixtureValue) {
  fixtureValue.db.close();
  try { fs.unlinkSync(fixtureValue.file); } catch (_) { /* best effort */ }
}

function request(enabled) {
  return {
    zone_uuid: 'zone-policy-test', expected_policy_version: null, condition: { kind: 'DENDRO', minimum_stress: 'moderate', response_mode: 'fixed' },
    timezone: 'UTC', enabled, observation_window_minutes: 60, min_interval_minutes: 60, max_daily_minutes: 240,
    schedules: [{ device_eui: VALVE, weekdays_mask: 127, start_time: '06:00', duration_minutes: 10, enabled: true, execution: 'conditional', expected_sync_version: null }],
  };
}

function scopedActor() {
  return { user_id: 1, user_uuid: 'user-policy-test', role: 'researcher', scope: scopeHelper, scopedMode: true };
}

async function savePreviewPolicy(f, { now, enabled = true, weekdaysMask = 127, startTime = '06:00', timezone = 'Europe/Zurich' }) {
  const edit = request(enabled);
  edit.timezone = timezone;
  edit.schedules[0].weekdays_mask = weekdaysMask;
  edit.schedules[0].start_time = startTime;
  return api.applyPolicyEdit({
    db: f.db,
    actor: { user_id: 1 },
    request: edit,
    now,
    runtimeClockStatus: () => ({ trusted: true, reason: 'trusted' }),
    qualificationProvider: () => ({ qualified: true, identity: 'preview-fixture', margin_seconds: 0 }),
  });
}

test('paused draft mutation is allowed with an untrusted runtime clock and materializes delivery defaults', async () => {
  const f = fixture();
  try {
    const result = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: request(false), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false, reason: 'clock_untrusted_missing_marker' }) });
    assert.equal(result.status, 202);
    assert.equal(result.policy.enabled, false);
    assert.equal(result.policy.effective_from, null);
    const policy = f.db.prepare('SELECT * FROM irrigation_policies').get();
    const schedule = f.db.prepare('SELECT * FROM valve_schedules WHERE device_eui=?').get(VALVE);
    assert.equal(policy.effective_from, null);
    assert.equal(JSON.parse(policy.delivery_settings_json)[VALVE].delivery_interval_minutes, 10);
    assert.equal(schedule.condition_policy_uuid, policy.policy_uuid);
    assert.equal(schedule.effective_from, null);
  } finally { closeFixture(f); }
});

// Owner decision 2026-10-24: no NTP-since-boot requirement. The injected status models the one
// clock refusal left: a clock behind data the gateway already holds (lower bound).
test('enabled mutation fails atomically when the runtime clock is behind stored data', async () => {
  const f = fixture();
  try {
    await assert.rejects(api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: request(true), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false, reason: 'clock_untrusted_lower_bound' }), qualificationProvider: () => ({ qualified: true, identity: 'fixture', margin_seconds: 0 }) }), (error) => error.code === 'clock_untrusted' && error.statusCode === 503);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM irrigation_policies').get().n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM valve_schedules').get().n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM valve_schedule_pushes').get().n, 0);
  } finally { closeFixture(f); }
});

test('recovered clock enables a paused policy with one shared future activation instant', async () => {
  const f = fixture();
  try {
    const first = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: request(false), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false, reason: 'clock_untrusted_missing_marker' }) });
    const secondRequest = request(true);
    secondRequest.expected_policy_version = first.policy.sync_version;
    secondRequest.schedules = [];
    const result = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: secondRequest, now: '2026-10-18T10:05:00Z', runtimeClockStatus: () => ({ trusted: true, reason: 'trusted' }), qualificationProvider: () => ({ qualified: true, identity: 'fixture', margin_seconds: 0 }) });
    assert.equal(result.policy.enabled, true);
    const policy = f.db.prepare('SELECT effective_from FROM irrigation_policies').get();
    const schedule = f.db.prepare('SELECT effective_from FROM valve_schedules WHERE device_eui=?').get(VALVE);
    assert.equal(policy.effective_from, schedule.effective_from);
    assert.equal(policy.effective_from, '2026-10-18T10:05:00.000Z');
  } finally { closeFixture(f); }
});

test('source options use the same resolver and report ineligible channels', async () => {
  const f = fixture();
  try {
    const result = await api.readSourceOptions(f.db, f.db.prepare('SELECT * FROM irrigation_zones WHERE id=1').get(), { condition: { kind: 'SWT', threshold_kpa: 10, sources: [] } }, Date.parse('2026-10-18T10:00:00Z'));
    assert.equal(result.length, 3);
    assert.ok(result.every((entry) => entry.eligible === false && entry.reason === 'sensor_not_enabled'));
  } finally { closeFixture(f); }
});

test('readPolicy previews a newly saved weekly check without materializing an occurrence', async () => {
  const f = fixture();
  try {
    const created = await savePreviewPolicy(f, { now: '2026-10-20T08:00:00.000Z', weekdaysMask: 1 << 2, startTime: '11:00' });
    assert.equal(created.policy.enabled, true);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM irrigation_occurrences').get().n, 0);
    const view = await api.readPolicy({ db: f.db, actor: { user_id: 1 }, zone: 'zone-policy-test', now: '2026-10-20T08:00:00.000Z' });
    assert.equal(view.next_check, '2026-10-20T09:00:00.000Z');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM irrigation_occurrences').get().n, 0);
  } finally { closeFixture(f); }
});

test('readPolicy does not preview a paused policy', async () => {
  const f = fixture();
  try {
    const created = await savePreviewPolicy(f, { now: '2026-10-20T08:00:00.000Z', enabled: false, weekdaysMask: 1 << 2, startTime: '11:00' });
    assert.equal(created.policy.enabled, false);
    const view = await api.readPolicy({ db: f.db, actor: { user_id: 1 }, zone: 'zone-policy-test', now: '2026-10-20T08:00:00.000Z' });
    assert.equal(view.next_check, null);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM irrigation_occurrences').get().n, 0);
  } finally { closeFixture(f); }
});

test('readPolicy uses strict gap and first-fold weekly resolution', async () => {
  for (const entry of [
    { now: '2026-03-28T23:00:00.000Z', expected: '2026-04-05T00:30:00.000Z' },
    { now: '2026-10-24T23:00:00.000Z', expected: '2026-10-25T00:30:00.000Z' },
  ]) {
    const f = fixture();
    try {
      await savePreviewPolicy(f, { now: entry.now, weekdaysMask: 1, startTime: '02:30' });
      const view = await api.readPolicy({ db: f.db, actor: { user_id: 1 }, zone: 'zone-policy-test', now: entry.now });
      assert.equal(view.next_check, entry.expected);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM irrigation_occurrences').get().n, 0);
    } finally { closeFixture(f); }
  }
});

test('local route wrapper dispatches the policy resource and decision subroute', async () => {
  const f = fixture();
  try {
    const msg = { req: { method: 'GET', path: '/api/irrigation-zones/1/irrigation-policy', headers: {} } };
    const view = await api.handleHttpRequest({ msg, db: f.db, actor: { user_id: 1 } });
    assert.equal(view.statusCode, 200);
    assert.equal(view.payload.policy, null);
    const decisions = await api.handleHttpRequest({ msg: { req: { method: 'GET', path: '/api/irrigation-zones/1/irrigation-policy/decisions', headers: {} } }, db: f.db, actor: { user_id: 1 } });
    assert.equal(decisions.statusCode, 200);
    assert.deepEqual(decisions.payload.decisions, []);
  } finally { closeFixture(f); }
});

test('edit rejects a role revoked while the valve writer is being acquired', async () => {
  const f = fixture();
  const originalWithValveWriters = dispatch.withValveWriters;
  let revoked = false;
  try {
    scopeHelper.invalidateScope('user-policy-test');
    dispatch.withValveWriters = async (keys, fn) => {
      if (!revoked) {
        revoked = true;
        f.db.prepare("UPDATE users SET role='viewer' WHERE id=1").run();
        scopeHelper.invalidateScope('user-policy-test');
      }
      return originalWithValveWriters(keys, fn);
    };
    await assert.rejects(api.applyPolicyEdit({ db: f.db, actor: scopedActor(), request: request(false), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false }) }), (error) => error.statusCode === 403);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM irrigation_policies').get().n, 0);
  } finally {
    dispatch.withValveWriters = originalWithValveWriters;
    scopeHelper.invalidateScope('user-policy-test');
    closeFixture(f);
  }
});

test('pause rejects a role revoked while the valve writer is being acquired', async () => {
  const f = fixture();
  const originalWithValveWriters = dispatch.withValveWriters;
  let revoked = false;
  try {
    const created = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: request(false), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false }) });
    scopeHelper.invalidateScope('user-policy-test');
    dispatch.withValveWriters = async (keys, fn) => {
      if (!revoked) {
        revoked = true;
        f.db.prepare("UPDATE users SET role='viewer' WHERE id=1").run();
        scopeHelper.invalidateScope('user-policy-test');
      }
      return originalWithValveWriters(keys, fn);
    };
    await assert.rejects(api.pausePolicy({ db: f.db, actor: scopedActor(), zone: 'zone-policy-test', request: { expected_policy_version: created.policy.sync_version }, now: '2026-10-18T10:01:00Z' }), (error) => error.statusCode === 403);
    assert.equal(f.db.prepare('SELECT sync_version FROM irrigation_policies').get().sync_version, created.policy.sync_version);
  } finally {
    dispatch.withValveWriters = originalWithValveWriters;
    scopeHelper.invalidateScope('user-policy-test');
    closeFixture(f);
  }
});

test('retry rejects a role revoked while the valve writer is being acquired', async () => {
  const f = fixture();
  const originalWithValveWriter = dispatch.withValveWriter;
  let revoked = false;
  try {
    await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: request(false), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false }) });
    scopeHelper.invalidateScope('user-policy-test');
    dispatch.withValveWriter = async (key, fn) => {
      if (!revoked) {
        revoked = true;
        f.db.prepare("UPDATE users SET role='viewer' WHERE id=1").run();
        scopeHelper.invalidateScope('user-policy-test');
      }
      return originalWithValveWriter(key, fn);
    };
    await assert.rejects(api.retryValve({ db: f.db, actor: scopedActor(), zone: 'zone-policy-test', request: { device_eui: VALVE }, now: '2026-10-18T10:01:00Z' }), (error) => error.statusCode === 403);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM valve_schedule_pushes').get().n, 7);
  } finally {
    dispatch.withValveWriter = originalWithValveWriter;
    scopeHelper.invalidateScope('user-policy-test');
    closeFixture(f);
  }
});

test('nested policy zone identity conflicts are rejected before mutation', async () => {
  const f = fixture();
  try {
    f.db.prepare("INSERT INTO irrigation_zones(id,name,user_id,created_at,updated_at,timezone,zone_uuid) VALUES (2,'Other zone',1,datetime('now'),datetime('now'),'UTC','zone-other')").run();
    const invalid = request(false);
    invalid.policy = { zone_uuid: 'zone-other' };
    await assert.rejects(api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: invalid, now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false }) }), (error) => error.code === 'zone_identity_conflict' && error.statusCode === 409);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM irrigation_policies').get().n, 0);
  } finally { closeFixture(f); }
});

test('HTTP policy and schedule enabled fields require JSON booleans', async () => {
  for (const invalid of [
    { policy: { enabled: '0' } },
    { policy: { enabled: 0 } },
    { schedule: { enabled: '1' } },
    { schedule: { enabled: 1 } },
  ]) {
    const f = fixture();
    try {
      const invalidRequest = request(false);
      if (invalid.policy) invalidRequest.enabled = invalid.policy.enabled;
      if (invalid.schedule) invalidRequest.schedules[0].enabled = invalid.schedule.enabled;
      await assert.rejects(api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: invalidRequest, now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false }) }), (error) => error.code === 'invalid_enabled' && error.statusCode === 422);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM irrigation_policies').get().n, 0);
    } finally { closeFixture(f); }
  }
});

test('transaction membership discovery includes every valve touched by a live legacy trigger', async () => {
  const f = fixture();
  const lowerValve = '0000112233445566';
  try {
    f.db.prepare('INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id) VALUES (?,?,?,?,datetime(\'now\'),datetime(\'now\'),?)').run(lowerValve, 'Legacy valve', 'STREGA_VALVE', 1, 1);
    f.db.prepare("INSERT INTO irrigation_schedules(irrigation_zone_id,trigger_metric,threshold_kpa,enabled,duration_minutes,response_mode) VALUES (1,'DENDRO',10,1,10,'fixed')").run();
    const membership = await f.db.transaction((tx) => api.discoverPolicyMembershipTx(tx, 1));
    assert.deepEqual(membership.legacy_valve_euis, [lowerValve, VALVE].sort());
    assert.deepEqual(membership.valve_euis, [lowerValve, VALVE].sort());
  } finally { closeFixture(f); }
});

test('membership drift releases the old set before retrying with a newly discovered lower EUI', async () => {
  const f = fixture();
  const lowerValve = '0000112233445566';
  const originalWithValveWriters = dispatch.withValveWriters;
  const calls = [];
  try {
    f.db.prepare('INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id) VALUES (?,?,?,?,datetime(\'now\'),datetime(\'now\'),?)').run(lowerValve, 'Lower valve', 'STREGA_VALVE', 1, 1);
    const created = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: request(false), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false }) });
    const update = request(false);
    update.expected_policy_version = created.policy.sync_version;
    update.schedules = [];
    update.delivery_settings = { [lowerValve]: { delivery_interval_minutes: 10 } };
    dispatch.withValveWriters = async (keys, fn) => {
      calls.push([...keys]);
      if (calls.length === 1) f.db.prepare('UPDATE valve_schedules SET device_eui=? WHERE device_eui=?').run(lowerValve, VALVE);
      return originalWithValveWriters(keys, fn);
    };
    const result = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: update, now: '2026-10-18T10:01:00Z', runtimeClockStatus: () => ({ trusted: false }) });
    assert.equal(result.policy.sync_version, created.policy.sync_version + 1);
    assert.deepEqual(calls, [[VALVE], [lowerValve]]);
    assert.equal(f.db.prepare('SELECT device_eui FROM valve_schedules LIMIT 1').get().device_eui, lowerValve);
  } finally {
    dispatch.withValveWriters = originalWithValveWriters;
    closeFixture(f);
  }
});

test('a busy manual owner rolls back the whole policy, legacy disable and clear preparation', async () => {
  const f = fixture();
  try {
    const created = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: request(false), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false }) });
    const pushCount = f.db.prepare('SELECT COUNT(*) AS n FROM valve_schedule_pushes').get().n;
    f.db.prepare("INSERT INTO irrigation_schedules(irrigation_zone_id,trigger_metric,threshold_kpa,enabled,duration_minutes,response_mode) VALUES (1,'DENDRO',10,1,10,'fixed')").run();
    f.db.prepare("INSERT INTO valve_actuation_expectations(expectation_id,device_eui,command_id,commanded_at,commanded_duration_seconds,expected_close_at,volume_source,reconciliation_state,trigger,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run('busy-policy-test', VALVE, 'manual-owner', '2026-10-18T10:00:00.000Z', 600, '2026-10-18T10:10:00.000Z', 'unknown', 'PENDING_OBSERVATION', 'manual', '2026-10-18T10:00:00.000Z');
    const update = request(false);
    update.expected_policy_version = created.policy.sync_version;
    update.schedules = [];
    await assert.rejects(api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: update, now: '2026-10-18T10:01:00Z', runtimeClockStatus: () => ({ trusted: false }) }), (error) => error.code === 'valve_busy' && error.statusCode === 409);
    assert.equal(f.db.prepare('SELECT sync_version FROM irrigation_policies').get().sync_version, created.policy.sync_version);
    assert.equal(f.db.prepare('SELECT enabled FROM irrigation_schedules WHERE irrigation_zone_id=1').get().enabled, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM valve_schedule_pushes').get().n, pushCount);
  } finally { closeFixture(f); }
});

test('a stale schedule target rejects without changing policy or any schedule row', async () => {
  const f = fixture();
  try {
    const created = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: request(false), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false }) });
    const current = f.db.prepare('SELECT * FROM valve_schedules WHERE device_eui=?').get(VALVE);
    const update = request(false);
    update.expected_policy_version = created.policy.sync_version;
    update.schedules = [{ schedule_uuid: current.schedule_uuid, expected_sync_version: Number(current.sync_version) + 1, start_time: '07:00', execution: 'conditional' }];
    await assert.rejects(api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: update, now: '2026-10-18T10:01:00Z', runtimeClockStatus: () => ({ trusted: false }) }), (error) => error.code === 'version_conflict' && error.statusCode === 409);
    assert.equal(f.db.prepare('SELECT sync_version FROM irrigation_policies').get().sync_version, created.policy.sync_version);
    assert.equal(f.db.prepare('SELECT start_time FROM valve_schedules WHERE schedule_uuid=?').get(current.schedule_uuid).start_time, current.start_time);
  } finally { closeFixture(f); }
});

test('a superseded prepared sender exits obsolete before transport I/O', async () => {
  const f = fixture();
  try {
    const created = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: request(false), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false }) });
    const scheduleRows = await f.db.all('SELECT * FROM valve_schedules WHERE device_eui=? AND deleted_at IS NULL', [VALVE]);
    const first = await f.db.transaction((tx) => push.prepareClearRevisionTx(tx, { deviceEui: VALVE, generation: 'GEN1', schedules: scheduleRows, now: '2026-10-18T10:01:00.000Z', reason: 'conversion', force: true }));
    const second = await f.db.transaction((tx) => push.prepareClearRevisionTx(tx, { deviceEui: VALVE, generation: 'GEN1', schedules: scheduleRows, now: '2026-10-18T10:02:00.000Z', reason: 'conversion', force: true }));
    assert.notEqual(first.revision, second.revision);
    let transportCalls = 0;
    const stale = await push.sendPreparedRevision({ db: f.db, deviceEui: VALVE, revision: first.revision, transport: { flushQueue: async () => { transportCalls += 1; }, enqueueDownlink: async () => { transportCalls += 1; } }, now: new Date('2026-10-18T10:03:00.000Z') });
    assert.equal(stale.obsolete, true);
    assert.equal(transportCalls, 0);
    f.db.prepare("INSERT INTO valve_actuation_expectations(expectation_id,device_eui,command_id,commanded_at,commanded_duration_seconds,expected_close_at,volume_source,reconciliation_state,trigger,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run('manual-race-test', VALVE, 'manual-race-owner', '2026-10-18T10:03:00.000Z', 600, '2026-10-18T10:13:00.000Z', 'unknown', 'PENDING_OBSERVATION', 'manual', '2026-10-18T10:03:00.000Z');
    const blocked = await push.sendPreparedRevision({ db: f.db, deviceEui: VALVE, revision: second.revision, transport: { flushQueue: async () => { transportCalls += 1; }, enqueueDownlink: async () => { transportCalls += 1; } }, now: new Date('2026-10-18T10:04:00.000Z') });
    assert.equal(blocked.blocked, true);
    assert.equal(transportCalls, 0);
    assert.equal(created.policy.enabled, false);
  } finally { closeFixture(f); }
});

test('expected policy and schedule versions are required and stale edits remain atomic', async () => {
  const f = fixture();
  try {
    await assert.rejects(api.applyPolicyEdit({
      db: f.db,
      actor: { user_id: 1 },
      request: { ...request(false), expected_policy_version: undefined },
      now: '2026-10-18T10:00:00Z',
      runtimeClockStatus: () => ({ trusted: false }),
    }), (error) => error.code === 'expected_policy_version_required' && error.statusCode === 400);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM irrigation_policies').get().n, 0);

    const created = await api.applyPolicyEdit({
      db: f.db,
      actor: { user_id: 1 },
      request: request(false),
      now: '2026-10-18T10:00:00Z',
      runtimeClockStatus: () => ({ trusted: false }),
    });
    const before = f.db.prepare('SELECT * FROM valve_schedules WHERE device_eui=?').get(VALVE);
    const update = request(false);
    update.expected_policy_version = created.policy.sync_version;
    update.schedules = [{
      schedule_uuid: before.schedule_uuid,
      expected_sync_version: undefined,
      start_time: '07:00',
      execution: 'conditional',
    }];
    await assert.rejects(api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: update, now: '2026-10-18T10:01:00Z', runtimeClockStatus: () => ({ trusted: false }) }), (error) => error.code === 'expected_schedule_version_required' && error.statusCode === 400);
    const after = f.db.prepare('SELECT * FROM valve_schedules WHERE device_eui=?').get(VALVE);
    assert.equal(after.start_time, before.start_time);
    assert.equal(f.db.prepare('SELECT sync_version FROM irrigation_policies').get().sync_version, created.policy.sync_version);
  } finally { closeFixture(f); }
});

test('timezone changes require explicit schedule re-expression and report affected rows', async () => {
  const f = fixture();
  try {
    const created = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: request(false), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false }) });
    const update = request(false);
    update.expected_policy_version = created.policy.sync_version;
    update.timezone = 'Europe/Zurich';
    update.schedules = [];
    await assert.rejects(api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: update, now: '2026-10-18T10:01:00Z', runtimeClockStatus: () => ({ trusted: false }) }), (error) => error.code === 'timezone_mismatch' && error.statusCode === 422 && error.affected_ids.includes(f.db.prepare('SELECT schedule_uuid FROM valve_schedules').get().schedule_uuid));
    assert.equal(f.db.prepare('SELECT timezone FROM irrigation_policies').get().timezone, 'UTC');
  } finally { closeFixture(f); }
});

test('unversioned detach shortcut is rejected before any write', async () => {
  const f = fixture();
  try {
    const created = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: request(false), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false }) });
    const scheduleUuid = f.db.prepare('SELECT schedule_uuid FROM valve_schedules').get().schedule_uuid;
    const update = request(false);
    update.expected_policy_version = created.policy.sync_version;
    const scheduleVersion = f.db.prepare('SELECT sync_version FROM valve_schedules WHERE schedule_uuid=?').get(scheduleUuid).sync_version;
    update.schedules = [{ schedule_uuid: scheduleUuid, expected_sync_version: scheduleVersion, start_time: '06:00', execution: 'conditional' }];
    update.detach_schedule_uuids = [scheduleUuid];
    await assert.rejects(api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: update, now: '2026-10-18T10:01:00Z', runtimeClockStatus: () => ({ trusted: false }) }), (error) => error.code === 'unknown_policy_field' && error.statusCode === 400);
    assert.equal(f.db.prepare('SELECT deleted_at FROM valve_schedules WHERE schedule_uuid=?').get(scheduleUuid).deleted_at, null);
  } finally { closeFixture(f); }
});

test('typed schedule edits reject destructive aliases, non-boolean detach, and ONCE conversion before SQL', async () => {
  for (const invalidPatch of [
    { delete: true, expectedCode: 'unknown_schedule_field' },
    { detach: 'false', expectedCode: 'invalid_detach' },
    { kind: 'ONCE', expectedCode: 'schedule_kind_immutable' },
  ]) {
    const f = fixture();
    try {
      const created = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: request(false), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false }) });
      const row = f.db.prepare('SELECT * FROM valve_schedules WHERE device_eui=?').get(VALVE);
      const update = request(false);
      update.expected_policy_version = created.policy.sync_version;
      update.schedules = [{ schedule_uuid: row.schedule_uuid, expected_sync_version: Number(row.sync_version), execution: 'conditional', ...invalidPatch }];
      delete update.schedules[0].expectedCode;
      await assert.rejects(api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: update, now: '2026-10-18T10:01:00Z', runtimeClockStatus: () => ({ trusted: false }) }), (error) => error.code === invalidPatch.expectedCode && error.statusCode >= 400 && error.statusCode < 500);
      const after = f.db.prepare('SELECT * FROM valve_schedules WHERE schedule_uuid=?').get(row.schedule_uuid);
      assert.equal(after.sync_version, row.sync_version);
      assert.equal(after.deleted_at, row.deleted_at);
      assert.equal(after.kind, 'WEEKLY');
    } finally { closeFixture(f); }
  }
});

test('enabled save supplies parsed persisted due and source lower bounds to the clock gate', async () => {
  const f = fixture();
  try {
    const created = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: request(false), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false }) });
    f.db.prepare('INSERT INTO irrigation_runtime_state(singleton_id,last_decided_due_at,updated_at) VALUES (1,?,?)').run('2026-10-18 11:00:00', '2026-10-18 10:00:00.000Z');
    const dendro = '0011223344556688';
    f.db.prepare("INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id,dendro_enabled) VALUES (?,?,?,?,datetime('now'),datetime('now'),?,1)").run(dendro, 'Dendrometer', 'DRAGINO_LSN50', 1, 1);
    f.db.prepare('INSERT INTO dendrometer_readings(deveui,position_um,recorded_at) VALUES (?,?,?)').run(dendro, 100, '2026-10-18T10:30:00.000Z');
    const update = request(true);
    update.expected_policy_version = created.policy.sync_version;
    update.schedules = [];
    let gateArgs;
    await assert.rejects(api.applyPolicyEdit({
      db: f.db,
      actor: { user_id: 1 },
      request: update,
      now: '2026-10-18T10:00:00Z',
      runtimeClockStatus: (args) => {
        gateArgs = args;
        return clock.clockStatus({
          ...args,
          bootId: 'fixture-boot',
          marker: { boot_id: 'fixture-boot', epoch_ms: Date.parse('2026-10-18T10:00:00Z'), uptime_ms: 1000, stratum: 1 },
          uptime: 1000,
        });
      },
      qualificationProvider: () => ({ qualified: true, identity: 'fixture', margin_seconds: 0 }),
    }), (error) => error.code === 'clock_untrusted' && error.statusCode === 503);
    assert.equal(gateArgs.lastDue, '2026-10-18 11:00:00');
    assert.equal(gateArgs.latestSample, '2026-10-18T10:30:00.000Z');
    assert.equal(f.db.prepare('SELECT enabled FROM irrigation_policies').get().enabled, 0);
    assert.equal(f.db.prepare('SELECT sync_version FROM irrigation_policies').get().sync_version, created.policy.sync_version);
  } finally { closeFixture(f); }
});

test('enabled DENDRO policy uses the latest raw observation as a clock lower bound', async () => {
  const f = fixture();
  const dendro = '0011223344556688';
  try {
    f.db.prepare("INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id,dendro_enabled) VALUES (?,?,?,?,datetime('now'),datetime('now'),?,1)").run(dendro, 'Dendrometer', 'DRAGINO_LSN50', 1, 1);
    f.db.prepare('INSERT INTO dendrometer_readings(deveui,position_um,recorded_at) VALUES (?,?,?)').run(dendro, 100, '2026-10-18T11:00:00.000Z');
    const enabled = request(true);
    let gateArgs;
    await assert.rejects(api.applyPolicyEdit({
      db: f.db,
      actor: { user_id: 1 },
      request: enabled,
      now: '2026-10-18T10:00:00Z',
      runtimeClockStatus: (args) => {
        gateArgs = args;
        return clock.clockStatus({
          ...args,
          bootId: 'fixture-boot',
          marker: { boot_id: 'fixture-boot', epoch_ms: Date.parse('2026-10-18T10:00:00Z'), uptime_ms: 1000, stratum: 1 },
          uptime: 1000,
        });
      },
      qualificationProvider: () => ({ qualified: true, identity: 'fixture', margin_seconds: 0 }),
    }), (error) => error.code === 'clock_untrusted' && error.statusCode === 503);
    assert.equal(gateArgs.latestSample, '2026-10-18T11:00:00.000Z');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM irrigation_policies').get().n, 0);
  } finally { closeFixture(f); }
});

test('raw clock lookup keeps the latest valid mixed timestamp ahead of malformed text', async () => {
  const f = fixture();
  const dendro = '0011223344556688';
  try {
    f.db.prepare("INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id,dendro_enabled) VALUES (?,?,?,?,datetime('now'),datetime('now'),?,1)").run(dendro, 'Dendrometer', 'DRAGINO_LSN50', 1, 1);
    const insert = f.db.prepare('INSERT INTO dendrometer_readings(deveui,position_um,recorded_at) VALUES (?,?,?)');
    insert.run(dendro, 100, '2026-10-18 10:30:00');
    insert.run(dendro, 101, '2026-99-99T23:59:59Z');
    let gateArgs;
    await assert.rejects(api.applyPolicyEdit({
      db: f.db,
      actor: { user_id: 1 },
      request: request(true),
      now: '2026-10-18T10:00:00Z',
      runtimeClockStatus: (args) => {
        gateArgs = args;
        return clock.clockStatus({
          ...args,
          bootId: 'fixture-boot',
          marker: { boot_id: 'fixture-boot', epoch_ms: Date.parse('2026-10-18T10:00:00Z'), uptime_ms: 1000, stratum: 1 },
          uptime: 1000,
        });
      },
      qualificationProvider: () => ({ qualified: true, identity: 'fixture', margin_seconds: 0 }),
    }), (error) => error.code === 'clock_untrusted' && error.statusCode === 503);
    assert.equal(gateArgs.latestSample, '2026-10-18T10:30:00.000Z');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM irrigation_policies').get().n, 0);
  } finally { closeFixture(f); }
});

test('raw clock lookup uses bounded keyset pages with the shared parser', async () => {
  const f = fixture();
  const dendro = '0011223344556688';
  try {
    f.db.prepare("INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id,dendro_enabled) VALUES (?,?,?,?,datetime('now'),datetime('now'),?,1)").run(dendro, 'Dendrometer', 'DRAGINO_LSN50', 1, 1);
    const insert = f.db.prepare('INSERT INTO dendrometer_readings(deveui,position_um,recorded_at) VALUES (?,?,?)');
    const firstDay = Date.parse('2026-01-01T00:00:00.000Z');
    for (let index = 0; index < 260; index += 1) {
      insert.run(dendro, index, new Date(firstDay + index * 86400000).toISOString());
    }
    insert.run(dendro, 260, '2026-01-01T00:00:00.000Z');
    insert.run(dendro, 100, ' 2026-10-18T10:00:00.9+01:00 ');
    insert.run(dendro, 101, '2026-10-18T09:30:00.10Z');
    insert.run(dendro, 102, '2026-99-99T23:59:59Z');
    const originalAll = f.db.all;
    let pageCalls = 0;
    f.db.all = async (sql, params = []) => {
      if (sql.includes('SELECT DISTINCT recorded_at')) pageCalls += 1;
      return originalAll(sql, params);
    };
    const originalTransaction = f.db.transaction;
    let transactionPageCalls = 0;
    f.db.transaction = async (fn) => originalTransaction(async (tx) => {
      const originalTxAll = tx.all;
      tx.all = async (sql, params = []) => {
        if (sql.includes('SELECT DISTINCT recorded_at')) transactionPageCalls += 1;
        return originalTxAll(sql, params);
      };
      return fn(tx);
    });
    let gateArgs;
    await assert.rejects(api.applyPolicyEdit({
      db: f.db,
      actor: { user_id: 1 },
      request: request(true),
      now: '2026-10-18T13:00:00Z',
      runtimeClockStatus: (args) => {
        gateArgs = args;
        return clock.clockStatus({
          ...args,
          bootId: 'fixture-boot',
          marker: { boot_id: 'fixture-boot', epoch_ms: Date.parse('2026-10-18T13:00:00Z'), uptime_ms: 1000, stratum: 1 },
          uptime: 1000,
        });
      },
      qualificationProvider: () => ({ qualified: true, identity: 'fixture', margin_seconds: 0 }),
    }), (error) => error.code === 'clock_untrusted' && error.statusCode === 503);
    assert.equal(gateArgs.latestSample, '2026-10-18T09:30:00.100Z');
    assert.ok(pageCalls >= 2);
    assert.ok(transactionPageCalls >= 2);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM irrigation_policies').get().n, 0);
  } finally { closeFixture(f); }
});

test('multi-page valid future DENDRO bound rejects activation without partial writes', async () => {
  const f = fixture();
  const dendro = '0011223344556688';
  try {
    f.db.prepare("INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id,dendro_enabled) VALUES (?,?,?,?,datetime('now'),datetime('now'),?,1)").run(dendro, 'Dendrometer', 'DRAGINO_LSN50', 1, 1);
    const insert = f.db.prepare('INSERT INTO dendrometer_readings(deveui,position_um,recorded_at) VALUES (?,?,?)');
    const firstDay = Date.parse('2026-01-01T00:00:00.000Z');
    for (let index = 0; index < 260; index += 1) {
      insert.run(dendro, index, new Date(firstDay + index * 86400000).toISOString());
    }
    insert.run(dendro, 260, '2026-10-18T11:00:00.100Z');
    const originalAll = f.db.all;
    let pageCalls = 0;
    f.db.all = async (sql, params = []) => {
      if (sql.includes('SELECT DISTINCT recorded_at')) pageCalls += 1;
      return originalAll(sql, params);
    };
    const originalTransaction = f.db.transaction;
    let transactionPageCalls = 0;
    f.db.transaction = async (fn) => originalTransaction(async (tx) => {
      const originalTxAll = tx.all;
      tx.all = async (sql, params = []) => {
        if (sql.includes('SELECT DISTINCT recorded_at')) transactionPageCalls += 1;
        return originalTxAll(sql, params);
      };
      return fn(tx);
    });
    let gateArgs;
    await assert.rejects(api.applyPolicyEdit({
      db: f.db,
      actor: { user_id: 1 },
      request: request(true),
      now: '2026-10-18T10:00:00Z',
      runtimeClockStatus: (args) => {
        gateArgs = args;
        return { trusted: true, reason: 'trusted' };
      },
      qualificationProvider: () => ({ qualified: true, identity: 'fixture', margin_seconds: 0 }),
    }), (error) => error.code === 'clock_untrusted'
      && error.statusCode === 503
      && error.details.reason === 'clock_untrusted_lower_bound'
      && error.details.bound === 'latestSample');
    assert.equal(gateArgs.latestSample, '2026-10-18T11:00:00.100Z');
    assert.ok(pageCalls >= 2);
    assert.ok(transactionPageCalls >= 2);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM irrigation_policies').get().n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM valve_schedules').get().n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM valve_schedule_pushes').get().n, 0);
  } finally { closeFixture(f); }
});

test('multi-page all-valid past DENDRO bound permits activation', async () => {
  const f = fixture();
  const dendro = '0011223344556688';
  try {
    f.db.prepare("INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id,dendro_enabled) VALUES (?,?,?,?,datetime('now'),datetime('now'),?,1)").run(dendro, 'Dendrometer', 'DRAGINO_LSN50', 1, 1);
    const insert = f.db.prepare('INSERT INTO dendrometer_readings(deveui,position_um,recorded_at) VALUES (?,?,?)');
    const firstDay = Date.parse('2026-01-01T00:00:00.000Z');
    for (let index = 0; index < 260; index += 1) {
      insert.run(dendro, index, new Date(firstDay + index * 86400000).toISOString());
    }
    insert.run(dendro, 260, '2026-10-18T09:00:00.100Z');
    const originalAll = f.db.all;
    let pageCalls = 0;
    f.db.all = async (sql, params = []) => {
      if (sql.includes('SELECT DISTINCT recorded_at')) pageCalls += 1;
      return originalAll(sql, params);
    };
    let gateArgs;
    const result = await api.applyPolicyEdit({
      db: f.db,
      actor: { user_id: 1 },
      request: request(true),
      now: '2026-10-18T10:00:00Z',
      runtimeClockStatus: (args) => {
        gateArgs = args;
        return { trusted: true, reason: 'trusted' };
      },
      qualificationProvider: () => ({ qualified: true, identity: 'fixture', margin_seconds: 0 }),
    });
    assert.equal(result.policy.enabled, true);
    assert.equal(gateArgs.latestSample, '2026-10-18T09:00:00.100Z');
    assert.ok(pageCalls >= 2);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM irrigation_policies').get().n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM valve_schedules WHERE deleted_at IS NULL').get().n, 1);
  } finally { closeFixture(f); }
});

test('enabled policy revalidates raw clock bounds after the asynchronous gate', async () => {
  const f = fixture();
  const dendro = '0011223344556688';
  try {
    f.db.prepare("INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id,dendro_enabled) VALUES (?,?,?,?,datetime('now'),datetime('now'),?,1)").run(dendro, 'Dendrometer', 'DRAGINO_LSN50', 1, 1);
    const enabled = request(true);
    let gateArgs;
    await assert.rejects(api.applyPolicyEdit({
      db: f.db,
      actor: { user_id: 1 },
      request: enabled,
      now: '2026-10-18T10:00:00Z',
      runtimeClockStatus: (args) => {
        gateArgs = args;
        f.db.prepare('INSERT INTO dendrometer_readings(deveui,position_um,recorded_at) VALUES (?,?,?)').run(dendro, 100, '2026-10-18T11:00:00.000Z');
        return clock.clockStatus({
          ...args,
          bootId: 'fixture-boot',
          marker: { boot_id: 'fixture-boot', epoch_ms: Date.parse('2026-10-18T10:00:00Z'), uptime_ms: 1000, stratum: 1 },
          uptime: 1000,
        });
      },
      qualificationProvider: () => ({ qualified: true, identity: 'fixture', margin_seconds: 0 }),
    }), (error) => error.code === 'clock_untrusted' && error.statusCode === 503);
    assert.equal(gateArgs.latestSample, null);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM irrigation_policies').get().n, 0);
  } finally { closeFixture(f); }
});

test('pause re-discovers membership after releasing the first writer set', async () => {
  const f = fixture();
  const lowerValve = '0000112233445566';
  const originalWithValveWriters = dispatch.withValveWriters;
  const held = [];
  try {
    f.db.prepare('INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id) VALUES (?,?,?,?,datetime(\'now\'),datetime(\'now\'),?)').run(lowerValve, 'Lower valve', 'STREGA_VALVE', 1, 1);
    const created = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: request(false), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false }) });
    dispatch.withValveWriters = async (keys, fn) => {
      held.push([...keys]);
      if (held.length === 1) f.db.prepare('UPDATE valve_schedules SET device_eui=? WHERE device_eui=?').run(lowerValve, VALVE);
      return originalWithValveWriters(keys, fn);
    };
    const paused = await api.pausePolicy({ db: f.db, actor: { user_id: 1 }, zone: 'zone-policy-test', request: { expected_policy_version: created.policy.sync_version }, now: '2026-10-18T10:01:00Z' });
    assert.equal(paused.policy.enabled, false);
    assert.deepEqual(held, [[VALVE], [lowerValve]]);
    assert.equal(f.db.prepare('SELECT device_eui FROM valve_schedules WHERE schedule_uuid=?').get(f.db.prepare('SELECT schedule_uuid FROM valve_schedules').get().schedule_uuid).device_eui, lowerValve);
  } finally {
    dispatch.withValveWriters = originalWithValveWriters;
    closeFixture(f);
  }
});

test('retry rejects caller generation and checks the pending-link fence inside preparation', async () => {
  const f = fixture();
  try {
    const created = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: request(false), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false }) });
    await assert.rejects(api.retryValve({ db: f.db, actor: { user_id: 1 }, zone: 'zone-policy-test', request: { device_eui: VALVE, generation: 'GEN2' }, now: '2026-10-18T10:01:00Z' }), (error) => error.code === 'unsupported_generation' && error.statusCode === 400);
    const pushCount = f.db.prepare('SELECT COUNT(*) AS n FROM valve_schedule_pushes').get().n;
    f.db.prepare("INSERT INTO sync_link_state(peer_node,linked,updated_at,link_attempt_json) VALUES ('cloud',0,'2026-10-18T10:00:00.000Z','{}')").run();
    await assert.rejects(api.retryValve({ db: f.db, actor: { user_id: 1 }, zone: 'zone-policy-test', request: { device_eui: VALVE }, now: '2026-10-18T10:01:00Z' }), (error) => error.code === 'link_in_progress' && error.statusCode === 409);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM valve_schedule_pushes').get().n, pushCount);
    assert.equal(f.db.prepare('SELECT sync_version FROM irrigation_policies').get().sync_version, created.policy.sync_version);
  } finally { closeFixture(f); }
});

test('decision cursor preserves a tied ordering group across pages', async () => {
  const f = fixture();
  try {
    const created = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: request(false), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false }) });
    const insert = f.db.prepare('INSERT INTO irrigation_occurrences(schedule_uuid,local_date,local_time,policy_uuid,zone_uuid,device_eui,due_at,decision,decision_at,state) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (let index = 0; index < 101; index += 1) {
      const suffix = String(index).padStart(3, '0');
      insert.run(`00000000-0000-4000-8000-${suffix}000000000`, '2026-10-18', `06:${suffix.slice(1)}`, created.policy.policy_uuid, 'zone-policy-test', VALVE, '2026-10-18T06:00:00.000Z', 'SKIP', '2026-10-18T06:00:00.000Z', 'SKIPPED');
    }
    const first = await api.listDecisions({ db: f.db, actor: { user_id: 1 }, zone: 'zone-policy-test', limit: 100 });
    assert.equal(first.decisions.length, 100);
    assert.ok(first.next_cursor);
    const second = await api.listDecisions({ db: f.db, actor: { user_id: 1 }, zone: 'zone-policy-test', limit: 100, before: first.next_cursor });
    assert.equal(second.decisions.length, 1);
    assert.equal(new Set(first.decisions.concat(second.decisions).map((row) => row.schedule_uuid)).size, 101);
    await assert.rejects(api.listDecisions({ db: f.db, actor: { user_id: 1 }, zone: 'zone-policy-test', limit: 100, before: 'not-a-cursor' }), (error) => error.code === 'invalid_cursor' && error.statusCode === 422);
    await assert.rejects(api.listDecisions({ db: f.db, actor: { user_id: 1 }, zone: 'zone-policy-test', limit: 100, before: `${first.next_cursor}!` }), (error) => error.code === 'invalid_cursor' && error.statusCode === 422);
  } finally { closeFixture(f); }
});

test('GET exposes creation source choices and unavailable reasons before a policy exists', async () => {
  const f = fixture();
  try {
    const sensor = '0011223344556688';
    f.db.prepare('INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id,chameleon_enabled) VALUES (?,?,?,?,datetime(\'now\'),datetime(\'now\'),?,0)').run(sensor, 'Soil sensor', 'KIWI_SENSOR', 1, 1);
    const view = await api.readPolicy({ db: f.db, actor: { user_id: 1 }, zone: 'zone-policy-test', now: '2026-10-18T10:00:00Z' });
    assert.equal(view.policy, null);
    assert.deepEqual(Object.keys(view.source_choices), ['SWT', 'VWC', 'DENDRO']);
    assert.equal(view.source_choices.SWT.length, 6);
    assert.equal(view.source_choices.SWT.filter((choice) => choice.eligible).length, 2);
    assert.deepEqual(
      view.source_choices.SWT.filter((choice) => choice.eligible).map((choice) => choice.channel).sort(),
      ['swt_1', 'swt_2']
    );
    assert.ok(view.source_choices.SWT.filter((choice) => !choice.eligible).every((choice) =>
      choice.kind === 'SWT' && ['channel_not_declared', 'sensor_not_enabled'].includes(choice.reason)
    ));
    assert.equal(view.source_choices.DENDRO[0].state, 'unavailable');
    assert.equal(view.eligible_sources.length, 7);
  } finally { closeFixture(f); }
});

test('reversed concurrent two-valve policy editors commit one complete version and reject the other without partial rows', async () => {
  const f = fixture();
  const secondValve = '0011223344556678';
  try {
    f.db.prepare("INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id) VALUES (?,?,?,?,datetime('now'),datetime('now'),?)").run(secondValve, 'Second policy valve', 'STREGA_VALVE', 1, 1);
    const initial = request(false);
    initial.schedules.push({ device_eui: secondValve, weekdays_mask: 127, start_time: '06:05', duration_minutes: 11, enabled: true, execution: 'conditional', expected_sync_version: null });
    const created = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: initial, now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false }) });
    f.db.prepare("INSERT INTO irrigation_schedules(irrigation_zone_id,trigger_metric,threshold_kpa,enabled,duration_minutes,response_mode) VALUES (1,'DENDRO',10,1,10,'fixed')").run();
    const beforeRows = f.db.prepare('SELECT * FROM valve_schedules WHERE device_eui IN (?,?) ORDER BY device_eui').all(VALVE, secondValve);
    const beforeLegacy = f.db.prepare('SELECT id,enabled,sync_version,deleted_at FROM irrigation_schedules WHERE irrigation_zone_id=1').get();
    const beforePushCount = f.db.prepare('SELECT COUNT(*) AS n FROM valve_schedule_pushes').get().n;
    const beforeControls = f.db.prepare('SELECT device_eui,conditional_control_json FROM valve_settings WHERE UPPER(device_eui) IN (?,?) ORDER BY device_eui').all(VALVE, secondValve);
    const edits = (firstStart, secondStart, rows = beforeRows) => {
      const update = request(false);
      update.expected_policy_version = created.policy.sync_version;
      update.schedules = rows.map((row) => ({
        schedule_uuid: row.schedule_uuid,
        expected_sync_version: Number(row.sync_version),
        start_time: row.device_eui === VALVE ? firstStart : secondStart,
        execution: 'conditional',
      }));
      return update;
    };
    const first = edits('06:10', '06:11', [...beforeRows].reverse());
    const second = edits('06:20', '06:21');
    const scheduleDeviceOrder = (edit) => edit.schedules.map((schedule) => beforeRows.find((row) => row.schedule_uuid === schedule.schedule_uuid).device_eui);
    assert.deepEqual(scheduleDeviceOrder(first), [secondValve, VALVE]);
    assert.deepEqual(scheduleDeviceOrder(second), [VALVE, secondValve]);
    const outcomes = await Promise.allSettled([
      api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: first, now: '2026-10-18T10:01:00Z', runtimeClockStatus: () => ({ trusted: false }) }),
      api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: second, now: '2026-10-18T10:01:01Z', runtimeClockStatus: () => ({ trusted: false }) }),
    ]);
    assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((item) => item.status === 'rejected').length, 1);
    assert.equal(outcomes.find((item) => item.status === 'rejected').reason.code, 'version_conflict');
    const afterRows = f.db.prepare('SELECT * FROM valve_schedules WHERE device_eui IN (?,?) ORDER BY device_eui').all(VALVE, secondValve);
    const validPairs = new Set(['06:10|06:11', '06:20|06:21']);
    assert.ok(validPairs.has(afterRows.map((row) => row.start_time).join('|')));
    assert.deepEqual(afterRows.map((row) => Number(row.sync_version)), beforeRows.map((row) => Number(row.sync_version) + 1));
    assert.equal(f.db.prepare('SELECT sync_version FROM irrigation_policies').get().sync_version, Number(created.policy.sync_version) + 1);
    const afterLegacy = f.db.prepare('SELECT id,enabled,sync_version,deleted_at FROM irrigation_schedules WHERE irrigation_zone_id=1').get();
    assert.equal(afterLegacy.id, beforeLegacy.id);
    assert.equal(afterLegacy.enabled, 0);
    assert.equal(afterLegacy.sync_version, beforeLegacy.sync_version);
    assert.equal(afterLegacy.deleted_at, beforeLegacy.deleted_at);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM valve_schedule_pushes').get().n, beforePushCount + 14);
    const afterControls = f.db.prepare('SELECT device_eui,conditional_control_json FROM valve_settings WHERE UPPER(device_eui) IN (?,?) ORDER BY device_eui').all(VALVE, secondValve);
    assert.equal(afterControls.length, beforeControls.length);
    assert.ok(afterControls.every((row) => row.conditional_control_json));
  } finally { closeFixture(f); }
});

test('reassignment between discovery and the in-lock reread rolls back the whole edit', async () => {
  const f = fixture();
  const originalWithValveWriters = dispatch.withValveWriters;
  let changed = false;
  try {
    f.db.prepare("INSERT INTO irrigation_zones(id,name,user_id,created_at,updated_at,timezone,zone_uuid) VALUES (2,'Other zone',1,datetime('now'),datetime('now'),'UTC','zone-other')").run();
    const created = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: request(false), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false }) });
    const before = f.db.prepare('SELECT * FROM valve_schedules WHERE device_eui=?').get(VALVE);
    const update = request(false); update.expected_policy_version = created.policy.sync_version; update.schedules = [];
    dispatch.withValveWriters = async (keys, fn) => {
      if (!changed) {
        changed = true;
        f.db.prepare('UPDATE devices SET irrigation_zone_id=2 WHERE deveui=?').run(VALVE);
      }
      return originalWithValveWriters(keys, fn);
    };
    await assert.rejects(api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: update, now: '2026-10-18T10:01:00Z', runtimeClockStatus: () => ({ trusted: false }) }), (error) => error.code === 'foreign_delivery_settings_key' && error.statusCode === 422);
    const after = f.db.prepare('SELECT start_time,device_eui,sync_version,deleted_at FROM valve_schedules WHERE schedule_uuid=?').get(before.schedule_uuid);
    assert.equal(after.start_time, before.start_time);
    assert.equal(after.device_eui, before.device_eui);
    assert.equal(after.sync_version, before.sync_version);
    assert.equal(after.deleted_at, before.deleted_at);
    assert.equal(f.db.prepare('SELECT sync_version FROM irrigation_policies').get().sync_version, created.policy.sync_version);
  } finally {
    dispatch.withValveWriters = originalWithValveWriters;
    closeFixture(f);
  }
});

test('prepared sender transport waits until the policy transaction is closed', async () => {
  const f = fixture();
  const originalTransaction = f.db.transaction;
  let transactionDepth = 0;
  const transportEvents = [];
  try {
    f.db.transaction = async (fn) => {
      transactionDepth += 1;
      try { return await originalTransaction(fn); } finally { transactionDepth -= 1; }
    };
    const result = await api.applyPolicyEdit({
      db: f.db,
      actor: { user_id: 1 },
      request: request(false),
      now: '2026-10-18T10:00:00Z',
      runtimeClockStatus: () => ({ trusted: false }),
      transport: {
        async getDeviceQueue() { transportEvents.push({ phase: 'read', depth: transactionDepth }); return []; },
        async flushDeviceQueue() { transportEvents.push({ phase: 'flush', depth: transactionDepth }); return { statusCode: 204 }; },
        async enqueueDownlink(item) { transportEvents.push({ phase: 'enqueue', depth: transactionDepth, fPort: item.fPort }); return { id: 'post-commit-queue' }; },
      },
    });
    assert.equal(result.status, 202);
    assert.ok(transportEvents.length > 0);
    assert.ok(transportEvents.every((event) => event.depth === 0));
  } finally {
    f.db.transaction = originalTransaction;
    closeFixture(f);
  }
});

test('post-commit projection notification failure does not change a completed policy mutation', async () => {
  const f = fixture();
  try {
    const result = await api.applyPolicyEdit({
      db: f.db,
      actor: { user_id: 1 },
      request: request(false),
      now: '2026-10-18T10:00:00Z',
      runtimeClockStatus: () => ({ trusted: false }),
      notifyProjection: async () => { throw new Error('projection_fixture_failure'); },
    });
    assert.equal(result.policy.enabled, false);
    assert.equal(f.db.prepare('SELECT enabled FROM irrigation_policies WHERE zone_uuid=?').get('zone-policy-test').enabled, 0);
  } finally { closeFixture(f); }
});

// R17 M1 / D18 (W29): VWC as a control input waits for the owner. The edge gate is the app_settings
// key conditional_irrigation_vwc_enabled, default OFF (absent = off), matching the cloud flag
// conditional-irrigation.vwc-condition-enabled (default false).
function vwcRequest(enabled) {
  const edit = request(enabled);
  edit.condition = { kind: 'VWC', threshold_percent: 22, sources: [] };
  return edit;
}

test('R17-M1: with the VWC gate off (absent), creating or activating a VWC-condition policy is refused with vwc_condition_disabled', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: vwcRequest(true), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: true, reason: 'trusted' }), qualificationProvider: () => ({ qualified: true, identity: 'fixture', margin_seconds: 0 }) }),
      (error) => error.code === 'vwc_condition_disabled' && error.statusCode === 422,
    );
    assert.equal(await f.db.get('SELECT 1 AS x FROM irrigation_policies'), null, 'nothing is written');
    const view = await api.readPolicy({ db: f.db, actor: { user_id: 1 }, zone: 'zone-policy-test', now: '2026-10-18T10:00:00Z' });
    assert.equal(view.vwc_condition_enabled, false);
    assert.deepEqual(view.source_choices.VWC, [], 'the editor is offered no VWC sources');
  } finally { closeFixture(f); }
});

test('R17-M1: with the gate on, the VWC policy validates as before (sources still required)', async () => {
  const f = fixture();
  try {
    await f.db.run("INSERT INTO app_settings(key, value, updated_at) VALUES ('conditional_irrigation_vwc_enabled', '1', datetime('now'))");
    await assert.rejects(
      api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: vwcRequest(true), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: true, reason: 'trusted' }), qualificationProvider: () => ({ qualified: true, identity: 'fixture', margin_seconds: 0 }) }),
      (error) => error.code !== 'vwc_condition_disabled',
    );
    const view = await api.readPolicy({ db: f.db, actor: { user_id: 1 }, zone: 'zone-policy-test', now: '2026-10-18T10:00:00Z' });
    assert.equal(view.vwc_condition_enabled, true);
  } finally { closeFixture(f); }
});

test('R17-M1: a paused (disabled) VWC policy may still be saved while the gate is off; it cannot be activated', async () => {
  const f = fixture();
  try {
    const saved = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: vwcRequest(false), now: '2026-10-18T10:00:00Z', runtimeClockStatus: () => ({ trusted: false, reason: 'clock_untrusted' }) }).catch((e) => e);
    assert.notEqual(saved && saved.code, 'vwc_condition_disabled');
  } finally { closeFixture(f); }
});

// R19 finding 2: an edit of a fixed ("always") row through the policy API must reach the valve
// exactly like the valve schedule route: the valve stays FIXED, so it gets a forced compile.
test('R19-2: disabling a fixed row through the policy API compiles and queues the fixed plan', async () => {
  const f = fixture();
  try {
    for (const [id, time] of [['11111111-1111-4111-8111-111111111111', '06:00'], ['22222222-2222-4222-8222-222222222222', '18:00']]) {
      await f.db.run("INSERT INTO valve_schedules(schedule_uuid,device_eui,kind,weekdays_mask,start_time,duration_minutes,timezone,enabled,sync_version) VALUES (?,?,'WEEKLY',127,?,30,'UTC',1,1)", [id, VALVE, time]);
    }
    const compiled = [];
    const result = await api.applyPolicyEdit({
      db: f.db, actor: { user_id: 1 },
      transport: { enqueueDownlink: async () => ({ id: 'q1' }), flushDeviceQueue: async () => ({}), getDeviceQueue: async () => [] },
      compileAndQueue: async (args) => { compiled.push(args); return { rows: [], messages: [] }; },
      runtimeClockStatus: () => ({ trusted: true }),
      request: { zone_uuid: 'zone-policy-test', expected_policy_version: null, condition: { kind: 'DENDRO', minimum_stress: 'moderate', response_mode: 'fixed' }, timezone: 'UTC', enabled: false,
        schedules: [{ schedule_uuid: '11111111-1111-4111-8111-111111111111', expected_sync_version: 1, execution: 'always', enabled: false }] },
    });
    assert.equal(result.mode, 'FIXED');
    assert.deepEqual(result.fixed_conversions, [VALVE], 'the edited fixed valve is compiled');
    assert.equal(compiled.length, 1, 'one forced compile');
    assert.equal(compiled[0].deviceEui, VALVE);
    assert.equal(compiled[0].force, true);
  } finally {
    closeFixture(f);
  }
});

// R19 finding 4: on GEN2, a conversion clear whose enqueue ChirpStack rejected (pre-acceptance)
// must not make every uplink flush the whole queue for nothing; once ChirpStack recovers, the
// valve tick retries it as a fresh revision (a pre-acceptance failure never reached the valve).
test('R19-4: a rejected GEN2 clear causes no flush per uplink and is retried by the tick after recovery', async () => {
  const workers = require('../osi-valve-control/workers');
  const f = fixture();
  try {
    await f.db.run("INSERT INTO valve_settings(device_eui,strega_generation) VALUES (?,'GEN2')", [VALVE]);
    let flushes = 0; let enq = 0; let rejectEnqueue = true; const planPorts = [];
    const transport = { getDeviceQueue: async () => [], flushDeviceQueue: async () => { flushes += 1; return {}; },
      enqueueDownlink: async (item) => { enq += 1; if (Number(item.fPort) === 25) planPorts.push(item.fPort); if (rejectEnqueue) throw Object.assign(new Error('unauthenticated'), { grpcCode: 16, provenance: 'chirpstack_enqueue_preacceptance', step: 'enqueueDownlink' }); return { id: 'q' + enq }; } };
    const saved = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, transport, runtimeClockStatus: () => ({ trusted: true }), now: '2026-10-24T10:00:00.000Z',
      request: { zone_uuid: 'zone-policy-test', expected_policy_version: null, condition: { kind: 'DENDRO', minimum_stress: 'moderate', response_mode: 'fixed' }, timezone: 'UTC', enabled: false,
        schedules: [{ device_eui: VALVE, weekdays_mask: 127, start_time: '06:00', duration_minutes: 10, enabled: true, execution: 'conditional', expected_sync_version: null }] } });
    assert.equal(saved.revision_results[0].readiness.state, 'FAILED', JSON.stringify(saved.revision_results));
    rejectEnqueue = false;
    const flushesBefore = flushes;
    const attemptsBefore = enq;
    const planBefore = planPorts.length;
    for (let i = 0; i < 3; i += 1) {
      const needs = await push.conditionalReconciliationNeeded(f.db, VALVE, { profileId: 'gen2', generationProfileId: 'gen2' });
      if (needs) await push.compileAndQueue({ db: f.db, deviceEui: VALVE, appId: 'a', force: true, auto: 1, now: new Date('2026-10-24T10:01:00.000Z'), transport, warn: () => {} });
    }
    assert.equal(flushes, flushesBefore, 'no whole-queue flush on uplinks while nothing would be sent');
    assert.equal(enq, attemptsBefore);
    workers._resetHousekeepingForTests();
    await workers.runValveTick({ db: f.db, now: new Date('2026-10-24T10:10:00.000Z'), appId: 'a', transport, warn: () => {} });
    assert.equal(planPorts.length, planBefore, 'no clear retry inside the backoff window');
    await workers.runValveTick({ db: f.db, now: new Date('2026-10-24T10:40:00.000Z'), appId: 'a', transport, warn: () => {} });
    assert.ok(planPorts.length > planBefore, 'the tick retried the clear after ChirpStack recovered');
    const control = JSON.parse((await f.db.get('SELECT conditional_control_json c FROM valve_settings WHERE device_eui=?', [VALVE])).c);
    assert.equal(control.readiness.state, 'PENDING', JSON.stringify(control.readiness));
    assert.equal(control.readiness.reason, 'awaiting_clear_ack');
    const planAfterRetry = planPorts.length;
    await workers.runValveTick({ db: f.db, now: new Date('2026-10-24T11:41:00.000Z'), appId: 'a', transport, warn: () => {} });
    assert.equal(planPorts.length, planAfterRetry, 'an accepted clear is never sent again');
  } finally {
    closeFixture(f);
  }
});

// R19 finding 6: on a gateway linked to a cloud that has not confirmed conditional_irrigation_v1,
// a policy save that creates or keeps conditional rows is refused (the 0077 triggers would
// withhold those rows from the cloud, which would keep stale fixed copies).
test('R19-6: a linked gateway without known cloud support refuses a conditional conversion', async () => {
  const f = fixture();
  try {
    await f.db.run("INSERT INTO sync_link_state(peer_node,linked,updated_at) VALUES ('cloud',1,datetime('now'))");
    await f.db.run("INSERT INTO valve_schedules(schedule_uuid,device_eui,kind,weekdays_mask,start_time,duration_minutes,timezone,enabled,sync_version) VALUES (?,?,'WEEKLY',127,'06:00',30,'UTC',1,1)", ['11111111-1111-4111-8111-111111111111', VALVE]);
    const req = request(false);
    req.schedules = [{ schedule_uuid: '11111111-1111-4111-8111-111111111111', expected_sync_version: 1, execution: 'conditional', enabled: true }];
    await assert.rejects(
      api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: req, now: '2026-10-24T10:00:00Z', runtimeClockStatus: () => ({ trusted: true }) }),
      (error) => error.code === 'conditional_irrigation_unsupported' && error.statusCode === 503);
    const row = await f.db.get("SELECT condition_policy_uuid, sync_version FROM valve_schedules WHERE schedule_uuid='11111111-1111-4111-8111-111111111111'");
    assert.equal(row.condition_policy_uuid, null, 'nothing was converted');
    assert.equal(row.sync_version, 1);
    assert.equal(await f.db.get('SELECT 1 AS x FROM irrigation_policies'), null, 'no policy was stored');
  } finally {
    closeFixture(f);
  }
});

// Owner decision 2026-10-24: enabling a conditional policy no longer needs an NTP sync since boot.
test('NTP removal: the default clock gate enables a policy without an NTP marker', async () => {
  const f = fixture();
  const missing = (path) => { throw Object.assign(new Error('missing ' + path), { code: 'ENOENT' }); };
  try {
    const result = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: request(true), now: '2026-10-18T10:00:00Z',
      clockOptions: { fs: { readFileSync: missing, writeFileSync() {}, renameSync() {}, mkdirSync() {}, unlinkSync() {} }, markerPath: '/nonexistent/marker.json', rejectionPath: '/nonexistent/rejection.json', fallbackPath: '/nonexistent/fallback.json' },
      qualificationProvider: () => ({ qualified: true, identity: 'fixture', margin_seconds: 0 }) });
    assert.equal(result.policy.enabled, true);
  } finally { closeFixture(f); }
});

// Cloud fix (osi-server PR #389): a paused or disabled policy may keep zero enabled weekly rows,
// so a policy can be retired; no_targets applies only when the policy ends up enabled.
test('no_targets: a disabled policy may keep no enabled weekly row; an enabled one may not', async () => {
  const f = fixture();
  try {
    await f.db.run("INSERT INTO valve_schedules(schedule_uuid,device_eui,kind,weekdays_mask,start_time,duration_minutes,timezone,enabled,sync_version) VALUES (?,?,'WEEKLY',127,'06:00',30,'UTC',1,1)", ['11111111-1111-4111-8111-111111111111', VALVE]);
    const base = { zone_uuid: 'zone-policy-test', expected_policy_version: null, condition: { kind: 'DENDRO', minimum_stress: 'moderate', response_mode: 'fixed' }, timezone: 'UTC',
      schedules: [{ schedule_uuid: '11111111-1111-4111-8111-111111111111', expected_sync_version: 1, execution: 'always', enabled: false }] };
    await assert.rejects(api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: { ...base, enabled: true }, now: '2026-10-24T10:00:00Z', runtimeClockStatus: () => ({ trusted: true }), qualificationProvider: () => ({ qualified: true, identity: 'fixture', margin_seconds: 0 }) }),
      (error) => error.code === 'no_targets');
    const result = await api.applyPolicyEdit({ db: f.db, actor: { user_id: 1 }, request: { ...base, enabled: false }, now: '2026-10-24T10:00:00Z', runtimeClockStatus: () => ({ trusted: true }) });
    assert.equal(result.policy.enabled, false);
    const row = await f.db.get("SELECT enabled FROM valve_schedules WHERE schedule_uuid='11111111-1111-4111-8111-111111111111'");
    assert.equal(Number(row.enabled), 0);
  } finally {
    closeFixture(f);
  }
});

// Cloud stop path: PAUSE_IRRIGATION_POLICY may carry expected_policy_version null. A null-version
// pause applies to the current version, also while the latest edit is still pending on the valve
// (its plan rows are queued, not ACKed) and after the version moved past the caller's view.
test('a null-version pause pauses the current version while an edit is still pending', async () => {
  const f = fixture();
  try {
    const first = await savePreviewPolicy(f, { now: '2026-10-18T10:00:00Z', timezone: 'UTC' });
    const edit = request(true);
    edit.timezone = 'UTC';
    edit.expected_policy_version = first.policy.sync_version;
    edit.schedules[0] = {
      schedule_uuid: f.db.prepare('SELECT schedule_uuid FROM valve_schedules WHERE device_eui=?').get(VALVE).schedule_uuid,
      expected_sync_version: f.db.prepare('SELECT sync_version FROM valve_schedules WHERE device_eui=?').get(VALVE).sync_version,
      duration_minutes: 25,
    };
    const edited = await api.applyPolicyEdit({
      db: f.db, actor: { user_id: 1 }, request: edit, now: '2026-10-18T10:01:00Z',
      runtimeClockStatus: () => ({ trusted: true, reason: 'trusted' }),
      qualificationProvider: () => ({ qualified: true, identity: 'fixture', margin_seconds: 0 }),
    });
    assert.equal(edited.policy.enabled, true);
    assert.ok(edited.policy.sync_version > first.policy.sync_version);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM valve_schedule_pushes WHERE state='ACKED'").get().n, 0,
      'no plan row of the edit is confirmed by the valve');
    const paused = await api.pausePolicy({
      db: f.db, actor: { user_id: 1 }, zone: 'zone-policy-test',
      request: { expected_policy_version: null }, now: '2026-10-18T10:02:00Z',
    });
    assert.equal(paused.policy.enabled, false);
    assert.equal(paused.policy.sync_version, edited.policy.sync_version + 1, 'the pause applies to the current version');
    // A stale integer version is still a conflict; null is the only "whatever is current" form.
    await assert.rejects(api.pausePolicy({
      db: f.db, actor: { user_id: 1 }, zone: 'zone-policy-test',
      request: { expected_policy_version: first.policy.sync_version }, now: '2026-10-18T10:03:00Z',
    }), (error) => error.code === 'version_conflict' && error.statusCode === 409);
  } finally { closeFixture(f); }
});
