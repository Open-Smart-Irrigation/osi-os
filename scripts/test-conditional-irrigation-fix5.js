#!/usr/bin/env node
'use strict';

// Task 5a fix-round 5 behavioral pin.  These cases execute the shipped valve ACK
// function against a real SQLite fixture and the real worker/compiler/dispatch
// modules.  Only the ChirpStack client and environment are controlled.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { tempDb, facade } = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/test-helpers');
const store = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/store');
const push = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/push');
const workers = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/workers');

const EUI = '0016C001F1000001';
const GEN2_PROFILE = 'gen2-profile';
const FLOW_PATH = path.resolve(__dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const FLOW = JSON.parse(fs.readFileSync(FLOW_PATH, 'utf8')).find((node) => node.id === 'valve-ack-fn').func;
const VC = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control');

function envStub() {
  const vars = {
    CHIRPSTACK_APP_ACTUATORS: 'APP1',
    CHIRPSTACK_PROFILE_STREGA: 'gen1-profile',
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_PROFILE,
  };
  return { get: (key) => (key in vars ? vars[key] : null) };
}

function wrapDatabase(raw, { failApply = false, failAttemptPersistence = false } = {}) {
  const base = facade(raw);
  const wrap = (scope) => ({
    get: scope.get.bind(scope),
    all: scope.all.bind(scope),
    run: async (sql, params) => {
      if (failAttemptPersistence && sql.includes('UPDATE valve_schedule_pushes SET transport_json=?')
          && Array.isArray(params) && typeof params[0] === 'string' && params[0].includes('"phase":"UNKNOWN"')) {
        throw new Error('injected crash after ATTEMPTED');
      }
      if (failApply && sql.includes('UPDATE valve_settings SET conditional_control_json=?')
          && Array.isArray(params) && typeof params[0] === 'string' && params[0].includes('"state":"APPLIED"')) {
        throw new Error('injected crash after fixed transport');
      }
      return scope.run(sql, params);
    },
    transaction: scope.transaction ? (fn) => scope.transaction((tx) => fn(wrap(tx))) : undefined,
    close: scope.close ? scope.close.bind(scope) : undefined,
  });
  return wrap(base);
}

function makeFlowDb(dbPath, options) {
  const raw = new DatabaseSync(dbPath);
  const db = wrapDatabase(raw, options);
  // The actual node closes its Database in finally.  Keep this connection alive
  // so a second extracted-flow invocation can model restart recovery.
  db.close = (callback) => { if (callback) callback(); };
  return db;
}

async function runAckFlow(dbPath, options = {}) {
  const calls = { enqueue: [], flush: [], getQueue: 0, profile: [] };
  const client = {
    async getDeviceQueue() { calls.getQueue += 1; return []; },
    async flushDeviceQueue(device) { calls.flush.push(device); },
    async enqueueDownlink(item) {
      calls.enqueue.push(item);
      const injected = typeof options.enqueueError === 'function' ? options.enqueueError(calls.enqueue.length, item) : options.enqueueError;
      if (injected) throw injected;
      return { id: 'queue-' + calls.enqueue.length };
    },
    async setDeviceProfile(device, profile) { calls.profile.push([device, profile]); return true; },
  };
  const db = makeFlowDb(dbPath, options);
  const nodeCalls = { warns: [], logs: [], errors: [] };
  const node = {
    warn: (message) => nodeCalls.warns.push(message),
    log: (message) => nodeCalls.logs.push(message),
    error: (message) => nodeCalls.errors.push(message),
    status: () => {},
  };
  const execute = new Function('osiLib', 'chirpstack', 'env', 'node', 'msg', 'global', FLOW);
  const osiLib = {
    require(name) {
      if (name === 'osi-db-helper') return { ok: true, value: { Database: function Database() { return db; } } };
      if (name === 'osi-valve-control') return { ok: true, value: VC };
      throw new Error('unexpected require ' + name);
    },
  };
  const chirpstack = { createProvisioningClientFromEnv: () => client };
  const msg = {
    payload: {
      deviceInfo: { devEui: EUI, deviceProfileId: GEN2_PROFILE, deviceProfileName: 'STREGA Gen2' },
      object: { Ack_Port: 25, Ack_Value: 1 },
      fPort: 25,
      time: '2026-10-18T10:00:01.000Z',
    },
  };
  const output = await execute(osiLib, chirpstack, envStub(), node, msg, { get: () => undefined });
  return { calls, nodeCalls, output };
}

async function conditionalFixture(phase) {
  const fixture = await tempDb();
  const { db } = fixture;
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN2' });
  await store.insertSchedule(db, {
    schedule_uuid: 'fix5-conditional-' + phase,
    device_eui: EUI,
    kind: 'WEEKLY',
    weekdays_mask: 127,
    start_time: '08:00',
    duration_minutes: 5,
    timezone: 'UTC',
    enabled: 1,
  });
  await db.run("INSERT INTO irrigation_policies(policy_uuid,zone_uuid,condition_json,timezone) VALUES ('fix5-policy','zone-fix5','{}','UTC')");
  await db.run("UPDATE valve_schedules SET condition_policy_uuid='fix5-policy' WHERE schedule_uuid=?", ['fix5-conditional-' + phase]);
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: new Date('2026-10-18T10:00:00.000Z') });
  const transport = phase === 'malformed' ? '{bad json'
    : phase === 'missing' ? null
      : JSON.stringify({ phase: phase.toUpperCase(), attempted_at: '2026-10-18T09:00:00.000Z', queue_id: phase === 'accepted' ? 'old-queue' : undefined });
  await db.run("UPDATE valve_schedule_pushes SET state='FAILED', error='no_ack_24h', transport_json=? WHERE push_id=?", [transport, prepared.required_push_ids[0]]);
  return { fixture, prepared };
}

async function fixedFixture(label) {
  const fixture = await tempDb();
  const { db } = fixture;
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN1' });
  await store.insertSchedule(db, {
    schedule_uuid: 'fix5-fixed-' + label, device_eui: EUI, kind: 'WEEKLY', weekdays_mask: 127,
    start_time: '08:00', duration_minutes: 5, timezone: 'UTC', enabled: 1,
  });
  return fixture;
}

for (const phase of ['attempted', 'accepted', 'unknown', 'malformed', 'contradictory', 'missing']) {
  test('conditional ' + phase + ' stale row keeps current revision and IDs', async () => {
    const { fixture, prepared } = await conditionalFixture(phase);
    const before = await fixture.db.all('SELECT push_id FROM valve_schedule_pushes WHERE device_eui=? ORDER BY rowid', [EUI]);
    const flow = await runAckFlow(fixture.path);
    const after = await fixture.db.all('SELECT push_id FROM valve_schedule_pushes WHERE device_eui=? ORDER BY rowid', [EUI]);
    assert.equal(flow.calls.enqueue.length, 0);
    assert.equal(flow.calls.flush.length, 0);
    assert.deepEqual(after.map((row) => row.push_id), before.map((row) => row.push_id));
    assert.deepEqual((await store.conditionalControl(fixture.db, EUI)).required_push_ids, prepared.required_push_ids);
    fixture.cleanup();
  });
}

test('terminal current ACK blocks the whole automatic flow until explicit retry', async () => {
  const { fixture, prepared } = await conditionalFixture('terminal');
  await fixture.db.run("UPDATE valve_schedule_pushes SET state='FAILED', error='negative_ack' WHERE push_id=?", [prepared.required_push_ids[0]]);
  const before = await fixture.db.all('SELECT push_id FROM valve_schedule_pushes WHERE device_eui=? ORDER BY rowid', [EUI]);
  const flow = await runAckFlow(fixture.path);
  const after = await fixture.db.all('SELECT push_id FROM valve_schedule_pushes WHERE device_eui=? ORDER BY rowid', [EUI]);
  assert.equal(flow.calls.enqueue.length, 0);
  assert.equal(flow.calls.flush.length, 0);
  assert.deepEqual(after.map((row) => row.push_id), before.map((row) => row.push_id));
  assert.deepEqual((await store.conditionalControl(fixture.db, EUI)).required_push_ids, prepared.required_push_ids);
  fixture.cleanup();
});

for (const phase of ['attempted', 'unknown', 'accepted']) {
  test('fixed transition recovery keeps one prepared set after ' + phase + ' interruption', async () => {
    const fixture = await fixedFixture(phase);
    const firstOptions = phase === 'accepted'
      ? { failApply: true }
      : { enqueueError: new Error('injected transport uncertainty'), failAttemptPersistence: phase === 'attempted' };
    const first = await runAckFlow(fixture.path, firstOptions);
    const firstRows = await fixture.db.all("SELECT push_id,state,transport_json FROM valve_schedule_pushes WHERE device_eui=? ORDER BY rowid", [EUI]);
    assert.ok(first.calls.enqueue.length > 0);
    assert.ok(firstRows.some((row) => row.transport_json));
    const firstIds = firstRows.map((row) => row.push_id);
    assert.equal((await store.conditionalControl(fixture.db, EUI)).fixed_generation_transition.state, 'PENDING');
    const second = await runAckFlow(fixture.path);
    const secondRows = await fixture.db.all("SELECT push_id FROM valve_schedule_pushes WHERE device_eui=? ORDER BY rowid", [EUI]);
    const unsent = firstRows.filter((row) => !row.transport_json).length;
    assert.equal(second.calls.enqueue.length, phase === 'attempted' ? unsent : 0);
    assert.deepEqual(secondRows.map((row) => row.push_id), firstIds);
    const control = await store.conditionalControl(fixture.db, EUI);
    assert.equal(control.fixed_generation_transition.state, phase === 'accepted' ? 'APPLIED' : 'PENDING');
    if (phase === 'accepted') {
      const healthy = await runAckFlow(fixture.path);
      assert.equal(healthy.calls.enqueue.length, 0);
      assert.equal((await store.conditionalControl(fixture.db, EUI)).fixed_generation_transition.state, 'APPLIED');
    }
    fixture.cleanup();
  });
}

test('fixed transition partial set sends only the still-unattempted member', async () => {
  const fixture = await fixedFixture('partial');
  await workers.handleUplink({ db: fixture.db, deviceEui: EUI, decoded: { Ack_Port: 25, Ack_Value: 1 }, receivedAt: '2026-10-18T10:00:01Z', warn: () => {} });
  await push.prepareFixedGenerationTransition({ db: fixture.db, deviceEui: EUI, now: new Date('2026-10-18T10:00:00.000Z') });
  const control = await store.conditionalControl(fixture.db, EUI);
  const rows = await fixture.db.all('SELECT push_id FROM valve_schedule_pushes WHERE device_eui=? ORDER BY rowid', [EUI]);
  await fixture.db.run("UPDATE valve_schedule_pushes SET transport_json=?, state='QUEUED' WHERE push_id=?", [JSON.stringify({ phase: 'ACCEPTED', queue_id: 'already-accepted', accepted_at: '2026-10-18T09:00:00.000Z' }), rows[0].push_id]);
  const flow = await runAckFlow(fixture.path);
  assert.equal(flow.calls.enqueue.length, rows.length - 1);
  assert.deepEqual((await store.conditionalControl(fixture.db, EUI)).fixed_generation_transition.required_push_ids, control.fixed_generation_transition.required_push_ids);
  assert.equal((await store.conditionalControl(fixture.db, EUI)).fixed_generation_transition.state, 'APPLIED');
  fixture.cleanup();
});

test('fixed transition completion rejects stale transition and plan revision results', async () => {
  const fixture = await fixedFixture('cas');
  await workers.handleUplink({ db: fixture.db, deviceEui: EUI, decoded: { Ack_Port: 25, Ack_Value: 1 }, receivedAt: '2026-10-18T10:00:01Z', warn: () => {} });
  await push.prepareFixedGenerationTransition({ db: fixture.db, deviceEui: EUI, now: new Date('2026-10-18T10:00:00.000Z') });
  const old = await store.conditionalControl(fixture.db, EUI);
  const oldTransition = old.fixed_generation_transition;
  const newer = { ...old, fixed_generation_transition: { ...oldTransition, transition_id: 'new-transition', plan_revision: 'new-plan', required_push_ids: ['new-push'] } };
  await store.writeConditionalControl(fixture.db, EUI, newer);
  assert.equal(await push.applyGenerationTransition(fixture.db, EUI, {
    generation: 'GEN2', transition_id: oldTransition.transition_id, plan_revision: oldTransition.plan_revision,
    required_push_ids: oldTransition.required_push_ids, complete: true,
  }), false);
  const afterTransition = await store.conditionalControl(fixture.db, EUI);
  assert.equal(afterTransition.fixed_generation_transition.state, 'PENDING');
  assert.equal(afterTransition.fixed_generation_transition.transition_id, 'new-transition');
  const sameTransitionNewRevision = { ...afterTransition, fixed_generation_transition: { ...afterTransition.fixed_generation_transition, plan_revision: 'newer-plan' } };
  await store.writeConditionalControl(fixture.db, EUI, sameTransitionNewRevision);
  assert.equal(await push.markGenerationTransitionApplied(fixture.db, EUI, {
    transitionId: 'new-transition', planRevision: 'new-plan', requiredPushIds: ['new-push'], generation: 'GEN2', now: new Date(),
  }), false);
  fixture.cleanup();
});
