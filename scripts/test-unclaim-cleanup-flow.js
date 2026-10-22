#!/usr/bin/env node
'use strict';

// AUTH-09 PR A (external review B3): both unclaim origins run the valve plan cleanup and
// report its real outcome.
//
// Before this, a cloud UNCLAIM_DEVICE went Route Command -> Build UPDATE SQL -> sqlite ->
// Route command ACK verification -> Build Schedule ACK: it nulled user_id and
// irrigation_zone_id and acknowledged SUCCESS, and clearValveOnUnclaim never ran, so an
// unclaimed STREGA kept executing the weekly plan stored in its firmware while the cloud
// recorded success. The local DELETE route did run the cleanup, but answered the same 200
// whether the helpers were missing, the actuator application was unset, or the clearing
// plans really went out.
//
// The harness runs the real function-node bodies from the canonical flows.json, the real
// osi-valve-control module and the bundled farming.db (through the module's own test
// facade). The Node-RED sqlite node is replaced by a direct execution of msg.topic.
//
// Run: node --test scripts/test-unclaim-cleanup-flow.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const flowsPath = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const vcDir = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control');
const VC = require(vcDir);
const push = require(path.join(vcDir, 'push'));
const { tempDb, facade } = require(path.join(vcDir, 'test-helpers'));

const EUI = '0016C001F1000001';
const SENSOR_EUI = '0016C001F1000002';
const GATEWAY_EUI = '0016C001F1000009';
const NOW = new Date('2026-09-17T06:00:00.000Z');

const UPDATE = '4f4a765f36cee6f3';
const ROUTER = 'command-postcondition-route';
const LEGACY_ACK = 'e2e139678c3ddded';
const CLEANUP = 'unclaim-cloud-valve-cleanup-fn';
const LOCAL_CLEANUP = 'delete-device-valve-cleanup-fn';

const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
function node(id) {
  const found = flows.find((candidate) => candidate.id === id);
  if (!found) throw new Error('missing node ' + id);
  return found;
}

function osiLibFor(rawDb, { missing } = {}) {
  return {
    require(name) {
      if (missing && missing.includes(name)) return { ok: false, error: 'Cannot find module ' + name };
      if (name === 'osi-db-helper') return { ok: true, value: { Database: function Database() { return Object.assign(facade(rawDb), { close: (cb) => cb && cb() }); } } };
      if (name === 'osi-valve-control') return { ok: true, value: VC };
      if (name === 'entity-name') return { ok: false, error: 'not needed here' };
      return { ok: false, error: 'unexpected helper ' + name };
    },
  };
}

function chirpstackStub(calls) {
  return {
    createProvisioningClientFromEnv() {
      return { flushDeviceQueue: async (eui) => { calls.push(eui); return { statusCode: 202 }; } };
    },
  };
}

async function run(flowNode, msg, { env = {}, osiLib, chirpstack, logs } = {}) {
  const fn = new vm.Script(
    `(async function(msg,node,flow,env,context,global,osiLib,chirpstack){${flowNode.func}\n})`
  ).runInNewContext({ Buffer, console, setTimeout, clearTimeout, Date, JSON, Promise });
  const record = (kind) => (m) => { if (logs) logs.push(kind + ': ' + m); };
  const nodeApi = { warn: record('warn'), error: record('error'), log: record('log'), status() {} };
  const envApi = { get: (key) => env[key] };
  const store = { get() { return undefined; }, set() {} };
  const out = await fn(msg, nodeApi, store, envApi, store, store, osiLib, chirpstack);
  return out === undefined ? msg : out;
}

function outputs(flowNode, returned) {
  const arr = Array.isArray(returned) ? returned : [returned];
  return arr.slice(0, (flowNode.wires || []).length);
}

async function seedProgrammedValve() {
  const t = await tempDb();
  await t.db.run(
    "INSERT INTO valve_schedules(schedule_uuid, device_eui, kind, label, weekdays_mask, start_time, duration_minutes, timezone, enabled) " +
    "VALUES ('11111111-1111-4111-8111-111111111111', ?, 'WEEKLY', 'Morning', 127, '04:00', 30, 'UTC', 1)", [EUI]);
  await push.compileAndQueue({ db: t.db, deviceEui: EUI, appId: 'app', force: false, now: NOW, flushQueue: async () => ({}), warn() {} });
  await t.db.run("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES (?, 'Soil probe', 'DRAGINO_LSN50', 1, datetime('now'), datetime('now'))", [SENSOR_EUI]);
  return t;
}

// Route command (already decided UNCLAIM_DEVICE) -> Build UPDATE SQL -> sqlite ->
// Route command ACK verification -> [cleanup] -> Build Schedule ACK.
async function cloudUnclaim(t, deviceEui, opts = {}) {
  const { env, missing } = opts;
  const fullEnv = Object.assign({ DEVICE_EUI: GATEWAY_EUI, CHIRPSTACK_APP_ACTUATORS: 'actuators-app' }, env || {});
  const flushCalls = [];
  const logs = [];
  const osiLib = (opts && opts.osiLib) || osiLibFor(t.raw, { missing });
  const cmd = { commandId: 41, commandType: 'UNCLAIM_DEVICE', deviceEui, gatewayDeviceEui: GATEWAY_EUI, syncVersion: 3, aggregateType: 'DEVICE', aggregateKey: deviceEui };
  const built = await run(node(UPDATE), { payload: cmd }, { env: fullEnv, osiLib });
  // The Node-RED sqlite node (msg.topic mode) runs the statement with all() and puts the
  // rows on msg.payload: the guarded UPDATE's RETURNING row is what decides the ACK.
  built.payload = t.raw.prepare(built.topic).all().map((row) => Object.assign({}, row));
  const routed = outputs(node(ROUTER), await run(node(ROUTER), built, { env: fullEnv }));
  assert.equal(routed[0], null, 'UNCLAIM_DEVICE has no postcondition query');
  assert.equal(routed[1], null, 'UNCLAIM_DEVICE must not take the direct ACK path that skips the cleanup');
  assert.ok(routed[2], 'UNCLAIM_DEVICE must reach the cleanup node');
  const cleaned = outputs(node(CLEANUP), await run(node(CLEANUP), routed[2], { env: fullEnv, osiLib, chirpstack: chirpstackStub(flushCalls), logs }));
  assert.ok(cleaned[0], 'the cleanup node must always forward the ACK');
  const ackMsg = await run(node(LEGACY_ACK), cleaned[0], { env: fullEnv });
  return { ack: JSON.parse(ackMsg.payload), ackTopic: ackMsg.topic, downlinks: cleaned[1] || [], flushCalls, logs };
}

function assertNoValveAction(downlinks) {
  for (const m of downlinks) {
    assert.notEqual(m.payload.fPort, 1, 'unclaim must never send a valve action');
    assert.notEqual(m.payload.fPort, 2, 'unclaim must never send a CLOSE (D04)');
  }
}

test('wiring: UNCLAIM_DEVICE ACKs go through the cleanup node to the existing ACK and downlink outputs', () => {
  assert.deepEqual(node(ROUTER).wires, [['command-postcondition-build'], [LEGACY_ACK], [CLEANUP]]);
  assert.equal(node(ROUTER).outputs, 3);
  assert.deepEqual(node(CLEANUP).wires, [[LEGACY_ACK], ['9fae49d9ba22b793']]);
  assert.equal(node(CLEANUP).z, node(ROUTER).z, 'same tab as the router');
  assert.deepEqual(node(CLEANUP).libs, [{ var: 'osiLib', module: 'osi-lib' }, { var: 'chirpstack', module: 'osi-chirpstack-helper' }]);
});

test('cloud unclaim of a programmed valve clears its plan the local way and says the plan may still be held', async () => {
  const t = await seedProgrammedValve();
  try {
    const out = await cloudUnclaim(t, EUI);
    assert.equal(out.ackTopic, 'devices/' + GATEWAY_EUI + '/command_ack');
    assert.equal(out.ack.result, 'SUCCESS', 'the ownership detach did apply; a FAILED would read as FAILED_EDGE_REMOVAL in the cloud');
    assert.equal(out.ack.commandType, 'UNCLAIM_DEVICE');
    assert.equal(out.ack.commandId, 41);
    assert.equal(out.ack.valveCleanup.outcome, 'clearing_sent');
    assert.equal(out.ack.valveCleanup.may_still_hold_plan, true);
    assert.equal(out.ack.valveCleanup.plan_clear_confirmed, false);
    assert.equal(out.ack.valveCleanup.whole_queue_flushed, true);
    assert.match(out.ack.reason, /^valve_cleanup_clearing_sent/);
    assert.ok(out.downlinks.length >= 7, 'the clearing plans go to ChirpStack');
    assertNoValveAction(out.downlinks);
    assert.ok(out.flushCalls.includes(EUI));
    const device = t.raw.prepare('SELECT user_id, irrigation_zone_id FROM devices WHERE deveui = ?').get(EUI);
    assert.equal(device.user_id, null);
    const live = t.raw.prepare('SELECT COUNT(*) AS n FROM valve_schedules WHERE device_eui = ? AND deleted_at IS NULL').get(EUI);
    assert.equal(live.n, 0, 'the schedules are tombstoned as on the local delete');
  } finally { t.cleanup(); }
});

test('cloud unclaim of a sensor keeps the old ACK shape apart from the not-applicable cleanup record', async () => {
  const t = await seedProgrammedValve();
  try {
    const out = await cloudUnclaim(t, SENSOR_EUI);
    assert.equal(out.ack.result, 'SUCCESS');
    assert.equal(out.ack.valveCleanup.outcome, 'not_applicable');
    assert.equal(out.ack.valveCleanup.reason, 'not_a_valve');
    assert.equal(Object.prototype.hasOwnProperty.call(out.ack, 'reason'), false, 'no detail text for a sensor');
    assert.deepEqual(out.downlinks, []);
    assert.deepEqual(out.flushCalls, []);
  } finally { t.cleanup(); }
});

test('cloud unclaim with the valve helper missing still ACKs, and says the cleanup was not attempted', async () => {
  const t = await seedProgrammedValve();
  try {
    const out = await cloudUnclaim(t, EUI, { missing: ['osi-valve-control'] });
    assert.equal(out.ack.result, 'SUCCESS');
    assert.equal(out.ack.valveCleanup.outcome, 'not_attempted');
    assert.match(out.ack.valveCleanup.reason, /^helpers_unavailable/);
    assert.match(out.ack.reason, /^valve_cleanup_not_attempted/);
    assert.deepEqual(out.downlinks, []);
    assert.ok(out.logs.some((line) => line.startsWith('error:')), 'a skipped cleanup is logged as an error');
  } finally { t.cleanup(); }
});

test('cloud unclaim with CHIRPSTACK_APP_ACTUATORS unset reports the clearing as not sent', async () => {
  const t = await seedProgrammedValve();
  try {
    const out = await cloudUnclaim(t, EUI, { env: { CHIRPSTACK_APP_ACTUATORS: '' } });
    assert.equal(out.ack.valveCleanup.outcome, 'clearing_not_sent');
    assert.equal(out.ack.valveCleanup.reason, 'actuator_application_unset');
    assert.match(out.ack.reason, /actuator_application_unset/);
    assert.deepEqual(out.downlinks, []);
  } finally { t.cleanup(); }
});

test('other direct-ACK commands keep their ACK payload byte shape', async () => {
  const msg = { syncAck: { commandType: 'UPSERT_ZONE', commandId: 7, result: 'SUCCESS' } };
  const routed = outputs(node(ROUTER), await run(node(ROUTER), msg));
  assert.ok(routed[1] && !routed[0] && !routed[2]);
  const ack = JSON.parse((await run(node(LEGACY_ACK), routed[1], { env: { DEVICE_EUI: GATEWAY_EUI } })).payload);
  assert.deepEqual(Object.keys(ack), ['commandId', 'eventUuid', 'aggregateType', 'aggregateKey', 'result', 'state', 'commandType', 'appliedSyncVersion', 'error']);
});

// Local DELETE /api/devices/:deveui: Format Response (200) -> Clear Valve Plan On Unclaim.
async function localDelete(t, deviceEui, { env, missing } = {}) {
  t.raw.prepare('UPDATE devices SET user_id = NULL WHERE deveui = ?').run(deviceEui);
  const msg = { statusCode: 200, payload: { message: 'Device removed successfully', device_eui: deviceEui } };
  const logs = [];
  const out = outputs(node(LOCAL_CLEANUP), await run(node(LOCAL_CLEANUP), msg, {
    env: Object.assign({ CHIRPSTACK_APP_ACTUATORS: 'actuators-app' }, env || {}),
    osiLib: osiLibFor(t.raw, { missing }), chirpstack: chirpstackStub([]), logs,
  }));
  return { response: out[0], downlinks: out[1] || [], logs };
}

test('local delete: the 200 response carries the cleanup outcome when the clearing was sent', async () => {
  const t = await seedProgrammedValve();
  try {
    const out = await localDelete(t, EUI);
    assert.equal(out.response.statusCode, 200);
    assert.equal(out.response.payload.message, 'Device removed successfully');
    assert.equal(out.response.payload.valve_cleanup.outcome, 'clearing_sent');
    assert.equal(out.response.payload.valve_cleanup.may_still_hold_plan, true);
    assert.ok(out.downlinks.length >= 7);
    assertNoValveAction(out.downlinks);
  } finally { t.cleanup(); }
});

test('local delete: missing helpers no longer read as plain success', async () => {
  const t = await seedProgrammedValve();
  try {
    const out = await localDelete(t, EUI, { missing: ['osi-valve-control'] });
    assert.equal(out.response.statusCode, 200, 'the unclaim itself applied; HTTP semantics stay compatible');
    assert.equal(out.response.payload.valve_cleanup.outcome, 'not_attempted');
    assert.match(out.response.payload.valve_cleanup.reason, /^helpers_unavailable/);
    assert.deepEqual(out.downlinks, []);
  } finally { t.cleanup(); }
});

test('local delete: an unset actuator application is reported, not hidden', async () => {
  const t = await seedProgrammedValve();
  try {
    const out = await localDelete(t, EUI, { env: { CHIRPSTACK_APP_ACTUATORS: '' } });
    assert.equal(out.response.payload.valve_cleanup.outcome, 'clearing_not_sent');
    assert.equal(out.response.payload.valve_cleanup.reason, 'actuator_application_unset');
    assert.deepEqual(out.downlinks, []);
  } finally { t.cleanup(); }
});

test('local delete: failures on the delete wire pass through untouched', async () => {
  const t = await seedProgrammedValve();
  try {
    const msg = { statusCode: 404, payload: { message: 'Device not found or access denied' } };
    const out = outputs(node(LOCAL_CLEANUP), await run(node(LOCAL_CLEANUP), msg, { osiLib: osiLibFor(t.raw), chirpstack: chirpstackStub([]) }));
    assert.equal(out[0].statusCode, 404);
    assert.deepEqual(out[0].payload, { message: 'Device not found or access denied' });
    assert.equal(out[1], null);
  } finally { t.cleanup(); }
});

// R1 M1: the cloud ACK of UNCLAIM_DEVICE goes out over MQTT and never reaches the command
// ledger, so a lost ACK makes the cloud lease the same command again (up to 5 times, 300 s
// apart). The UPDATE is fenced on sync_version, like ASSIGN/REMOVE, so a replay older than a
// re-claim neither detaches the device nor clears the plan the operator built since.
test('a replayed UNCLAIM_DEVICE after a re-claim does not detach, tombstone or clear the new plan', async () => {
  const t = await seedProgrammedValve();
  try {
    const first = await cloudUnclaim(t, EUI);
    assert.equal(first.ack.result, 'SUCCESS');
    // Re-claim as post-devices-insert does (sync_version + 1), then a new weekly plan.
    t.raw.prepare('UPDATE devices SET user_id = 1, sync_version = sync_version + 1 WHERE deveui = ?').run(EUI);
    await t.db.run(
      "INSERT INTO valve_schedules(schedule_uuid, device_eui, kind, label, weekdays_mask, start_time, duration_minutes, timezone, enabled) " +
      "VALUES ('33333333-3333-4333-8333-333333333333', ?, 'WEEKLY', 'New plan', 127, '05:00', 20, 'UTC', 1)", [EUI]);
    await push.compileAndQueue({ db: t.db, deviceEui: EUI, appId: 'app', force: false, now: NOW, flushQueue: async () => ({}), warn() {} });
    const pushesBefore = t.raw.prepare("SELECT COUNT(*) AS n FROM valve_schedule_pushes WHERE device_eui = ?").get(EUI).n;

    const replay = await cloudUnclaim(t, EUI);

    const device = t.raw.prepare('SELECT user_id FROM devices WHERE deveui = ?').get(EUI);
    assert.equal(device.user_id, 1, 'the replay must not detach the re-claimed device');
    const live = t.raw.prepare('SELECT COUNT(*) AS n FROM valve_schedules WHERE device_eui = ? AND deleted_at IS NULL').get(EUI);
    assert.equal(live.n, 1, 'the new schedule must survive the replay');
    assert.equal(t.raw.prepare("SELECT COUNT(*) AS n FROM valve_schedule_pushes WHERE device_eui = ?").get(EUI).n, pushesBefore, 'no clearing plan is queued');
    assert.deepEqual(replay.downlinks, []);
    assert.deepEqual(replay.flushCalls, []);
    assert.equal(replay.ack.valveCleanup.outcome, 'not_attempted');
    assert.equal(replay.ack.valveCleanup.reason, 'still_claimed');
    assert.equal(replay.ack.result, 'REJECTED_PERMANENT', 'a detach that did not apply is not acknowledged as applied');
    assert.equal(replay.ack.error, 'stale_sync_version');
  } finally { t.cleanup(); }
});

test('a replayed UNCLAIM_DEVICE on a valve that stayed unclaimed is a no-op on the wire', async () => {
  const t = await seedProgrammedValve();
  try {
    await cloudUnclaim(t, EUI);
    const replay = await cloudUnclaim(t, EUI);
    assert.equal(replay.ack.result, 'SUCCESS');
    assert.equal(replay.ack.valveCleanup.outcome, 'no_plan_to_clear');
    assert.deepEqual(replay.downlinks, []);
    assert.deepEqual(replay.flushCalls, []);
  } finally { t.cleanup(); }
});

// R1 L1: a cleanup that cannot start (here the database cannot be opened) reports the module's
// own failed shape, with the same keys as every other module outcome.
test('cloud unclaim: a database that cannot be opened is reported as failed, ACK still sent', async () => {
  const t = await seedProgrammedValve();
  try {
    const base = osiLibFor(t.raw);
    const osiLib = { require(name) {
      if (name === 'osi-db-helper') return { ok: true, value: { Database: function Database() { throw new Error('SQLITE_CANTOPEN'); } } };
      return base.require(name);
    } };
    const out = await cloudUnclaim(t, EUI, { osiLib });
    assert.equal(out.ack.valveCleanup.outcome, 'failed');
    assert.match(out.ack.valveCleanup.reason, /SQLITE_CANTOPEN/);
    const reference = (await VC.runUnclaimCleanup({ db: t.db, deviceEui: SENSOR_EUI, appId: 'a', flushQueue: null, warn() {} })).cleanup;
    assert.deepEqual(Object.keys(out.ack.valveCleanup).sort(), Object.keys(reference).sort());
  } finally { t.cleanup(); }
});

// R1 L1: only a valve-control module that did not load uses the nodes' inline shape. It is a
// documented subset: every key it omits means "unknown" (null) in the full contract.
test('a valve-control module that did not load reports the documented subset of keys', async () => {
  const t = await seedProgrammedValve();
  try {
    const out = await cloudUnclaim(t, EUI, { missing: ['osi-valve-control'] });
    assert.deepEqual(Object.keys(out.ack.valveCleanup).sort(),
      ['attempted', 'device_eui', 'may_still_hold_plan', 'outcome', 'plan_clear_confirmed', 'reason']);
    const local = await localDelete(t, SENSOR_EUI, { missing: ['osi-valve-control'] });
    assert.deepEqual(Object.keys(local.response.payload.valve_cleanup).sort(),
      ['attempted', 'device_eui', 'may_still_hold_plan', 'outcome', 'plan_clear_confirmed', 'reason']);
  } finally { t.cleanup(); }
});

// W22 F1: the refusal comes from the guarded UPDATE's own result, not from the cleanup
// module, so a fenced replay is refused even when the helper modules fail to load.
for (const missing of [['osi-valve-control'], ['osi-db-helper'], ['osi-db-helper', 'osi-valve-control']]) {
  test('a fenced replay is REJECTED_PERMANENT even when ' + missing.join(' and ') + ' cannot load', async () => {
    const t = await seedProgrammedValve();
    try {
      await cloudUnclaim(t, EUI);
      t.raw.prepare('UPDATE devices SET user_id = 1, sync_version = sync_version + 1 WHERE deveui = ?').run(EUI);
      const replay = await cloudUnclaim(t, EUI, { missing });
      assert.equal(replay.ack.result, 'REJECTED_PERMANENT', 'a detach the fence refused must never be acknowledged as applied');
      assert.equal(replay.ack.error, 'stale_sync_version');
      assert.equal(t.raw.prepare('SELECT user_id FROM devices WHERE deveui = ?').get(EUI).user_id, 1);
      assert.deepEqual(replay.downlinks, []);
      assert.deepEqual(replay.flushCalls, []);
    } finally { t.cleanup(); }
  });
}

test('a refused detach never reaches the cleanup module', async () => {
  const t = await seedProgrammedValve();
  try {
    await cloudUnclaim(t, EUI);
    t.raw.prepare('UPDATE devices SET user_id = 1, sync_version = sync_version + 1 WHERE deveui = ?').run(EUI);
    const base = osiLibFor(t.raw);
    const calls = [];
    const osiLib = { require(name) { calls.push(name); return base.require(name); } };
    const replay = await cloudUnclaim(t, EUI, { osiLib });
    assert.equal(replay.ack.result, 'REJECTED_PERMANENT');
    assert.equal(replay.ack.valveCleanup.outcome, 'not_attempted');
    assert.equal(replay.ack.valveCleanup.reason, 'still_claimed');
    assert.ok(!calls.includes('osi-valve-control'), 'the cleanup must not run for a device that is still claimed');
  } finally { t.cleanup(); }
});

test('an unclaim for a device this gateway does not have stays a SUCCESS no-op', async () => {
  const t = await seedProgrammedValve();
  try {
    const out = await cloudUnclaim(t, '0016C001F10000AA');
    assert.equal(out.ack.result, 'SUCCESS');
    assert.equal(out.ack.valveCleanup.outcome, 'not_applicable');
    assert.equal(out.ack.valveCleanup.reason, 'not_found');
    assert.deepEqual(out.downlinks, []);
  } finally { t.cleanup(); }
});

// W22 F1: the refused UPDATE rewrites the row with its own values, so the devices sync
// trigger (which fires only on a changed column) emits nothing for it.
test('a refused detach emits no device sync event', async () => {
  const { linkCloud } = require(path.join(vcDir, 'test-helpers'));
  const t = await seedProgrammedValve();
  try {
    await linkCloud(t.db);
    await cloudUnclaim(t, EUI);
    t.raw.prepare('UPDATE devices SET user_id = 1, sync_version = sync_version + 1 WHERE deveui = ?').run(EUI);
    const count = () => t.raw.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type = 'DEVICE' AND aggregate_key = ?").get(EUI).n;
    const before = count();
    assert.ok(before >= 2, 'the applied unclaim and the re-claim each emitted their event');
    const replay = await cloudUnclaim(t, EUI);
    assert.equal(replay.ack.result, 'REJECTED_PERMANENT');
    assert.equal(count(), before, 'no DEVICE outbox event for a detach that did not happen');
  } finally { t.cleanup(); }
});
