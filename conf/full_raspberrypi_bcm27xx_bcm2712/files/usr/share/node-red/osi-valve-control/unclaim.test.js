'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { tempDb, facade } = require('./test-helpers');
const { clearValveOnUnclaim } = require('./unclaim');
const { handleHttpRequest } = require('./api');
const crypto = require('node:crypto');
const push = require('./push');
const store = require('./store');

const EUI = '0016C001F1000001';
const EMPTY_DAY_HEX = 'FF'.repeat(24); // encodeGen1Day([]) -- the plan that clears a Gen1 valve
const NOW = new Date('2026-09-17T06:00:00.000Z');

function noop() {}
// api.js does `new Database(dbPath)`, so this has to be constructible -- an arrow function is not.
function TestDatabase(dbPath) { return facade(new DatabaseSync(dbPath)); }
function countingFlush() {
  const calls = [];
  const fn = async (eui) => { calls.push(eui); return { statusCode: 202 }; };
  fn.calls = calls;
  return fn;
}

// Two WEEKLY schedules plus the plan pushes that put them inside the valve, so the
// clearing path has something real to overwrite (an unprogrammed valve is a separate
// case, covered below).
async function seedProgrammedValve() {
  const t = await tempDb();
  await t.db.run(
    "INSERT INTO valve_schedules(schedule_uuid, device_eui, kind, label, weekdays_mask, start_time, duration_minutes, timezone, enabled) " +
    "VALUES ('11111111-1111-4111-8111-111111111111', ?, 'WEEKLY', 'Morning', 127, '04:00', 30, 'UTC', 1)", [EUI]);
  await t.db.run(
    "INSERT INTO valve_schedules(schedule_uuid, device_eui, kind, label, weekdays_mask, start_time, duration_minutes, timezone, enabled) " +
    "VALUES ('22222222-2222-4222-8222-222222222222', ?, 'WEEKLY', 'Evening', 3, '18:00', 20, 'UTC', 1)", [EUI]);
  await push.compileAndQueue({ db: t.db, deviceEui: EUI, appId: 'app', force: false, now: NOW, flushQueue: countingFlush(), warn: noop });
  return t;
}

async function queuedPushes(db) {
  return db.all("SELECT purpose, weekday, fport, payload_hex FROM valve_schedule_pushes WHERE state='QUEUED' ORDER BY purpose, fport, weekday, payload_hex");
}

// The plan-shaped assertions look only at the rows that carry the on-valve schedule (the
// snapshot also carries a SCHEDULER_STATUS row).
async function queuedPlanPushes(db) {
  return db.all("SELECT purpose, weekday, fport, payload_hex FROM valve_schedule_pushes WHERE state='QUEUED' AND purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') ORDER BY fport, weekday, payload_hex");
}

async function unclaim(db) {
  await db.run('UPDATE devices SET user_id = NULL WHERE deveui = ?', [EUI]);
}

test('unclaiming a valve tombstones every schedule and queues the clearing plan the valve needs', async () => {
  const t = await seedProgrammedValve();
  await unclaim(t.db);
  const flushQueue = countingFlush();

  const out = await clearValveOnUnclaim({ db: t.db, deviceEui: EUI, appId: 'app', flushQueue, now: NOW, warn: noop });

  assert.equal(out.applicable, true);
  assert.equal(out.schedules_cleared, 2, 'both schedules must be tombstoned');
  const live = await t.db.all('SELECT schedule_uuid, deleted_at FROM valve_schedules WHERE device_eui = ?', [EUI]);
  assert.equal(live.length, 2);
  for (const row of live) assert.ok(row.deleted_at, 'schedule ' + row.schedule_uuid + ' must carry deleted_at after the device is unclaimed');

  // The exact downlink kinds: a Gen1 valve is cleared by the seven all-FF weekday plans
  // on fPorts 14..20, one per weekday that still held a window.
  const queued = await queuedPlanPushes(t.db);
  assert.equal(queued.length, 7, 'every weekday that carried a window must get a clearing plan');
  for (const row of queued) {
    assert.equal(row.purpose, 'WEEKDAY_PLAN');
    assert.equal(row.payload_hex, EMPTY_DAY_HEX, 'the clearing plan is the all-FF day, not a partial one');
    assert.equal(row.fport, 14 + row.weekday);
  }
  // CMD-04 PR0 (C): the clearing is a full snapshot (7 empty days + scheduler status) that the
  // valve tick sends once the debounce window has passed, so the unclaim itself sends nothing.
  assert.equal(out.pushes_queued, 8);
  assert.deepEqual(out.messages, []);
  const marker = await store.getSnapshotPending(t.db, EUI);
  assert.equal((await store.queuedPushesById(t.db, EUI, marker.push_ids)).length, 8, 'the clearing snapshot is pending for the valve tick');
  t.db.close();
});

test('unclaiming a valve queues exactly the downlinks the explicit schedule delete queues', async () => {
  // Parity, not similarity: the device-delete route must not grow its own idea of what
  // clears a valve. Both fixtures start identical; one is emptied through the REST
  // schedule-delete route, the other through the unclaim path.
  const SECRET = 'test-secret';
  const payload = Buffer.from(JSON.stringify({ userId: 1, username: 'u', exp: Date.now() + 60000 })).toString('base64url');
  const authHeader = 'Bearer ' + payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

  const viaScheduleDelete = await seedProgrammedValve();
  for (const uuid of ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']) {
    const url = '/api/valves/' + EUI + '/schedules/' + uuid;
    const out = await handleHttpRequest({
      msg: { req: { method: 'DELETE', url, headers: { authorization: authHeader }, params: {} } },
      Database: TestDatabase,
      environment: { authTokenSecret: SECRET, dbPath: viaScheduleDelete.path },
      appId: 'app', flushQueue: countingFlush(), now: NOW, warn: noop,
    });
    assert.equal(out.statusCode, 200, 'explicit schedule delete must succeed: ' + JSON.stringify(out.payload));
  }

  const viaUnclaim = await seedProgrammedValve();
  await unclaim(viaUnclaim.db);
  await clearValveOnUnclaim({ db: viaUnclaim.db, deviceEui: EUI, appId: 'app', flushQueue: countingFlush(), now: NOW, warn: noop });

  // CMD-04 PR0 (C): every compile is a full snapshot, so after two deletes the queued rows are
  // the second delete's complete snapshot -- the same as the unclaim's single compile -- and the
  // first delete's snapshot is SUPERSEDED, not lost.
  assert.deepEqual(await queuedPushes(viaUnclaim.db), await queuedPushes(viaScheduleDelete.db),
    'the outstanding downlinks after an unclaim must equal the ones the explicit delete leaves');
  assert.equal((await viaScheduleDelete.db.all("SELECT 1 FROM valve_schedule_pushes WHERE state='FAILED'")).length, 0, 'nothing is LOST');
  viaUnclaim.db.close();
  viaScheduleDelete.db.close();
});

test('an in-flight actuation is cancelled through the shared cancel path, never with a CLOSE downlink', async () => {
  const t = await seedProgrammedValve();
  await t.db.run(
    "INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, trigger, created_at) " +
    "VALUES ('e-1', ?, '2026-09-17T05:50:00.000Z', 900, '2026-09-17T06:05:00.000Z', 'unknown', 'PENDING_OBSERVATION', 'manual', '2026-09-17T05:50:00.000Z')", [EUI]);
  await unclaim(t.db);
  const flushQueue = countingFlush();

  const out = await clearValveOnUnclaim({ db: t.db, deviceEui: EUI, appId: 'app', flushQueue, now: NOW, warn: noop });

  assert.equal(out.cancelled.ok, true);
  const row = await t.db.get("SELECT reconciliation_state, cancel_reason FROM valve_actuation_expectations WHERE expectation_id = 'e-1'");
  assert.equal(row.reconciliation_state, 'CANCELLED');
  assert.ok(row.cancel_reason, 'the cancel must record why it happened');
  assert.ok(flushQueue.calls.includes(EUI), 'the ChirpStack queue must be flushed so an undelivered open never lands');
  // Observed state is the valve's to report; the unclaim only retires the commanded intent.
  const device = await t.db.get('SELECT current_state, target_state FROM devices WHERE deveui = ?', [EUI]);
  assert.equal(device.target_state, 'CLOSED');
  // Nothing on the wire may be an actuation. STREGA opens and closes ride fPorts 1/2; the
  // only downlinks this path may produce are schedule plans (14..20 Gen1, 25 Gen2) and the
  // scheduler status port (21) the snapshot carries; clock sync (12/13) comes from the valve tick.
  const allowedPorts = new Set([12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 25]);
  const marker = await store.getSnapshotPending(t.db, EUI);
  const pendingPorts = (await store.queuedPushesById(t.db, EUI, marker.push_ids)).map((r) => r.fport);
  assert.ok(pendingPorts.length > 0);
  for (const fPort of out.messages.map((m) => m.payload.fPort).concat(pendingPorts)) {
    assert.ok(allowedPorts.has(fPort), 'unexpected downlink on fPort ' + fPort);
    assert.notEqual(fPort, 1, 'a valve action must never leave the unclaim path');
    assert.notEqual(fPort, 2, 'a valve action must never leave the unclaim path');
  }
  t.db.close();
});

// #428: a cancel that names no actuation is refused while two are active, but a valve that
// leaves this gateway keeps none of them: unclaim cancels every active actuation.
test('unclaiming a valve with two in-flight actuations cancels both and flushes the queue', async () => {
  const t = await seedProgrammedValve();
  for (const [id, at] of [['e-1', '2026-09-17T05:50:00.000Z'], ['e-2', '2026-09-17T05:51:00.000Z']]) {
    await t.db.run(
      "INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, trigger, created_at) " +
      "VALUES (?, ?, ?, 900, ?, 'unknown', 'PENDING_OBSERVATION', 'manual', ?)", [id, EUI, at, at, at]);
  }
  await unclaim(t.db);
  const flushQueue = countingFlush();
  const out = await clearValveOnUnclaim({ db: t.db, deviceEui: EUI, appId: 'app', flushQueue, now: NOW, warn: noop });
  assert.equal(out.cancelled.ok, true);
  const states = (await t.db.all('SELECT reconciliation_state FROM valve_actuation_expectations ORDER BY expectation_id')).map((r) => r.reconciliation_state);
  assert.deepEqual(states, ['CANCELLED', 'CANCELLED']);
  assert.ok(flushQueue.calls.includes(EUI));
  t.db.close();
});

test('unclaiming a non-valve device has no valve side effects', async () => {
  const t = await seedProgrammedValve();
  await t.db.run("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES ('0016C001F1000002','Soil probe','DRAGINO_LSN50',NULL,datetime('now'),datetime('now'))");
  const before = await queuedPushes(t.db);
  const flushQueue = countingFlush();

  const out = await clearValveOnUnclaim({ db: t.db, deviceEui: '0016C001F1000002', appId: 'app', flushQueue, now: NOW, warn: noop });

  assert.equal(out.applicable, false);
  assert.equal(out.reason, 'not_a_valve');
  assert.equal(flushQueue.calls.length, 0, 'a sensor delete must not touch the valve queue');
  assert.deepEqual(await queuedPushes(t.db), before, 'no push may be queued for a non-valve device');
  const live = await t.db.all('SELECT deleted_at FROM valve_schedules WHERE device_eui = ?', [EUI]);
  assert.equal(live.filter((r) => r.deleted_at).length, 0, 'another device\'s schedules must be untouched');
  t.db.close();
});

test('a still-claimed valve is refused: this path only ever runs behind a completed unclaim', async () => {
  const t = await seedProgrammedValve();
  const before = await queuedPushes(t.db);

  const out = await clearValveOnUnclaim({ db: t.db, deviceEui: EUI, appId: 'app', flushQueue: countingFlush(), now: NOW, warn: noop });

  assert.equal(out.applicable, false);
  assert.equal(out.reason, 'still_claimed');
  assert.deepEqual(await queuedPushes(t.db), before);
  t.db.close();
});

test('a second unclaim of the same valve is a no-op on the wire', async () => {
  const t = await seedProgrammedValve();
  await unclaim(t.db);
  await clearValveOnUnclaim({ db: t.db, deviceEui: EUI, appId: 'app', flushQueue: countingFlush(), now: NOW, warn: noop });
  const afterFirst = await queuedPushes(t.db);

  const second = await clearValveOnUnclaim({ db: t.db, deviceEui: EUI, appId: 'app', flushQueue: countingFlush(), now: NOW, warn: noop });

  assert.equal(second.applicable, true);
  assert.equal(second.schedules_cleared, 0);
  assert.equal(second.pushes_queued, 0, 'nothing is left to clear, so nothing may be re-sent');
  assert.deepEqual(await queuedPushes(t.db), afterFirst);
  t.db.close();
});

test('a valve this gateway never programmed is left alone on the wire', async () => {
  // ONCE schedules never reach compileWindows, so the valve holds no plan from us. Pushing
  // an all-FF plan here would wipe a Bluetooth-configured schedule we never saw -- the same
  // reason api.js only compiles on a WEEKLY mutation.
  const t = await tempDb();
  await t.db.run(
    "INSERT INTO valve_schedules(schedule_uuid, device_eui, kind, fire_at, duration_minutes, timezone, enabled, once_state) " +
    "VALUES ('33333333-3333-4333-8333-333333333333', ?, 'ONCE', '2026-09-18T04:00:00.000Z', 15, 'UTC', 1, 'PENDING')", [EUI]);
  await unclaim(t.db);

  const out = await clearValveOnUnclaim({ db: t.db, deviceEui: EUI, appId: 'app', flushQueue: countingFlush(), now: NOW, warn: noop });

  assert.equal(out.schedules_cleared, 1, 'the ONCE row is still tombstoned so it stops firing and the cloud mirrors the removal');
  assert.equal(out.pushes_queued, 0, 'but no plan is pushed to a valve we never programmed');
  assert.deepEqual(await queuedPushes(t.db), []);
  t.db.close();
});

test('an unreachable ChirpStack does not stop the plan from being cleared', async () => {
  const t = await seedProgrammedValve();
  await unclaim(t.db);

  const out = await clearValveOnUnclaim({ db: t.db, deviceEui: EUI, appId: 'app', flushQueue: null, now: NOW, warn: noop });

  assert.equal(out.applicable, true);
  assert.equal(out.cancelled.ok, false, 'the cancel fails closed when the queue cannot be flushed');
  assert.equal(out.pushes_queued, 8, 'the clearing snapshot is still queued and goes out when the valve is next reachable');
  assert.equal((await queuedPlanPushes(t.db)).length, 7);
  t.db.close();
});

test('the tombstones cross to the cloud as VALVE_SCHEDULE_UPSERTED carrying deleted_at', async () => {
  const t = await seedProgrammedValve();
  const { linkCloud } = require('./test-helpers');
  await linkCloud(t.db);
  await unclaim(t.db);

  await clearValveOnUnclaim({ db: t.db, deviceEui: EUI, appId: 'app', flushQueue: countingFlush(), now: NOW, warn: noop });

  const events = await t.db.all("SELECT aggregate_key, payload_json FROM sync_outbox WHERE aggregate_type='VALVE_SCHEDULE' AND op='VALVE_SCHEDULE_UPSERTED'");
  assert.equal(events.length, 2, 'one event per tombstoned schedule, on the same op the explicit delete uses');
  for (const e of events) assert.ok(JSON.parse(e.payload_json).deleted_at, 'the cloud must see deleted_at, not a silent disappearance');
  t.db.close();
});

test('deploy.sh ships unclaim.js, or a deployed gateway cannot load osi-valve-control at all', async () => {
  // index.js require()s this file at module load: a gateway that never receives it loses
  // schedules, pushes and ACKs wholesale, not just this fix. Same failure mode the
  // cloud-commands.js/cancel.js/runtime.js fetch lines already guard against by hand --
  // verify-helper-registration.js only checks whole modules, never files inside one.
  const deploySh = fs.readFileSync(path.resolve(__dirname, '../../../../../../../deploy.sh'), 'utf8');
  assert.ok(deploySh.includes('/srv/node-red/osi-valve-control/unclaim.js'),
    'deploy.sh must carry a fetch_required line for osi-valve-control/unclaim.js');
});

// AUTH-09 PR A: one outcome contract for both unclaim origins (the local DELETE route and
// the cloud UNCLAIM_DEVICE ACK). It reports what the cleanup did, never that the valve's
// plan is gone: the valve has no read-back, so a queued clearing plan is evidence pending,
// not proof, and plan_clear_confirmed is always false here.
const { runUnclaimCleanup, unclaimCleanupUnavailable } = require('./unclaim');

function assertNoValveAction(downlinks) {
  for (const m of downlinks) {
    assert.notEqual(m.payload.fPort, 1, 'unclaim must never send a valve action');
    assert.notEqual(m.payload.fPort, 2, 'unclaim must never send a CLOSE or an OPEN');
  }
}

test('outcome: a programmed valve reports the clearing as scheduled for the valve tick, the plan as possibly still held, and the whole-queue flush', async () => {
  const t = await seedProgrammedValve();
  await unclaim(t.db);
  const out = await runUnclaimCleanup({ db: t.db, deviceEui: EUI, appId: 'app', flushQueue: countingFlush(), now: NOW, warn: noop });
  assert.equal(out.cleanup.outcome, 'clearing_scheduled', 'PR0: the snapshot leaves with the valve tick, not with the request');
  assert.equal(out.cleanup.attempted, true);
  assert.equal(out.cleanup.device_eui, EUI);
  assert.equal(out.cleanup.schedules_cleared, 2);
  assert.equal(out.cleanup.clearing_downlinks_sent, 0);
  assert.deepEqual(out.downlinks, []);
  const marker = await store.getSnapshotPending(t.db, EUI);
  assert.ok(marker && (await store.queuedPushesById(t.db, EUI, marker.push_ids)).length >= 7, 'the clearing snapshot waits for the tick');
  assert.equal(out.cleanup.may_still_hold_plan, true, 'nothing confirms the valve dropped its plan yet');
  assert.equal(out.cleanup.plan_clear_confirmed, false);
  assert.equal(out.cleanup.in_flight_cancel, 'none_active');
  assert.equal(out.cleanup.whole_queue_flushed, true, 'D19(a): the whole device queue is flushed and that collateral is reported');
  assertNoValveAction(out.downlinks);
  t.db.close();
});

test('outcome: an unset actuator application is reported as clearing not sent, never as success', async () => {
  const t = await seedProgrammedValve();
  await unclaim(t.db);
  const out = await runUnclaimCleanup({ db: t.db, deviceEui: EUI, appId: '', flushQueue: countingFlush(), now: NOW, warn: noop });
  assert.equal(out.cleanup.outcome, 'clearing_not_sent');
  assert.equal(out.cleanup.reason, 'actuator_application_unset');
  assert.equal(out.cleanup.clearing_downlinks_sent, 0);
  assert.deepEqual(out.downlinks, []);
  assert.equal(out.cleanup.may_still_hold_plan, true);
  t.db.close();
});

test('outcome: a cleanup that throws is reported as failed with its reason', async () => {
  const t = await seedProgrammedValve();
  await unclaim(t.db);
  const broken = Object.assign({}, t.db, { all: () => Promise.reject(new Error('disk I/O error')) });
  const out = await runUnclaimCleanup({ db: broken, deviceEui: EUI, appId: 'app', flushQueue: countingFlush(), now: NOW, warn: noop });
  assert.equal(out.cleanup.outcome, 'failed');
  assert.match(out.cleanup.reason, /disk I\/O error/);
  // R1 M3: the valve was found and may already have lost its schedules: say it may hold its plan.
  assert.equal(out.cleanup.may_still_hold_plan, true, 'a failed cleanup on a known valve may leave its plan in place');
  assert.deepEqual(out.downlinks, []);
  t.db.close();
});

test('outcome: a failed in-flight cancel stays visible next to a sent clearing', async () => {
  const t = await seedProgrammedValve();
  await t.db.run(
    "INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, trigger, created_at) " +
    "VALUES ('e-1', ?, '2026-09-17T05:50:00.000Z', 900, '2026-09-17T06:05:00.000Z', 'unknown', 'PENDING_OBSERVATION', 'manual', '2026-09-17T05:50:00.000Z')", [EUI]);
  await unclaim(t.db);
  const out = await runUnclaimCleanup({ db: t.db, deviceEui: EUI, appId: 'app', flushQueue: null, now: NOW, warn: noop });
  assert.equal(out.cleanup.in_flight_cancel, 'failed');
  assert.equal(out.cleanup.in_flight_cancel_error, 'chirpstack_unavailable');
  assert.match(out.cleanup.reason, /in_flight_cancel_failed/);
  assert.equal(out.cleanup.whole_queue_flushed, false);
  assertNoValveAction(out.downlinks);
  t.db.close();
});

test('outcome: a sensor is not applicable, and a still-claimed valve is not attempted', async () => {
  const t = await seedProgrammedValve();
  await t.db.run("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES ('0016C001F1000002','Soil probe','DRAGINO_LSN50',NULL,datetime('now'),datetime('now'))");
  const sensor = await runUnclaimCleanup({ db: t.db, deviceEui: '0016C001F1000002', appId: 'app', flushQueue: countingFlush(), now: NOW, warn: noop });
  assert.equal(sensor.cleanup.outcome, 'not_applicable');
  assert.equal(sensor.cleanup.reason, 'not_a_valve');
  assert.equal(sensor.cleanup.may_still_hold_plan, false);
  const claimed = await runUnclaimCleanup({ db: t.db, deviceEui: EUI, appId: 'app', flushQueue: countingFlush(), now: NOW, warn: noop });
  assert.equal(claimed.cleanup.outcome, 'not_attempted');
  assert.equal(claimed.cleanup.reason, 'still_claimed');
  assert.equal(claimed.cleanup.may_still_hold_plan, true);
  t.db.close();
});

test('outcome: a valve with no plan from this gateway reports nothing to clear, not a cleared plan', async () => {
  const t = await tempDb();
  await unclaim(t.db);
  const out = await runUnclaimCleanup({ db: t.db, deviceEui: EUI, appId: 'app', flushQueue: countingFlush(), now: NOW, warn: noop });
  assert.equal(out.cleanup.outcome, 'no_plan_to_clear');
  assert.equal(out.cleanup.may_still_hold_plan, null, 'a plan set another way cannot be ruled out');
  assert.equal(out.cleanup.plan_clear_confirmed, false);
  t.db.close();
});

test('outcome: missing helpers yield the not-attempted shape the flow nodes report', () => {
  const out = unclaimCleanupUnavailable('Cannot find module osi-valve-control');
  assert.equal(out.outcome, 'not_attempted');
  assert.match(out.reason, /^helpers_unavailable/);
  assert.equal(out.attempted, false);
  assert.equal(out.may_still_hold_plan, null);
  assert.equal(out.plan_clear_confirmed, false);
});

// R1 M3: before the device lookup nothing is known, so a failure there stays "unknown".
test('outcome: a failure before the device lookup leaves may_still_hold_plan unknown', async () => {
  const t = await seedProgrammedValve();
  await unclaim(t.db);
  const broken = Object.assign({}, t.db, { get: () => Promise.reject(new Error('database is locked')) });
  const out = await runUnclaimCleanup({ db: broken, deviceEui: EUI, appId: 'app', flushQueue: countingFlush(), now: NOW, warn: noop });
  assert.equal(out.cleanup.outcome, 'failed');
  assert.equal(out.cleanup.may_still_hold_plan, null);
  t.db.close();
});

// R1 M1: a claimed device of any type is refused, so the caller can tell the detach did not apply.
test('outcome: a still-claimed sensor is not attempted and holds no valve plan', async () => {
  const t = await seedProgrammedValve();
  await t.db.run("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES ('0016C001F1000002','Soil probe','DRAGINO_LSN50',1,datetime('now'),datetime('now'))");
  const out = await runUnclaimCleanup({ db: t.db, deviceEui: '0016C001F1000002', appId: 'app', flushQueue: countingFlush(), now: NOW, warn: noop });
  assert.equal(out.cleanup.outcome, 'not_attempted');
  assert.equal(out.cleanup.reason, 'still_claimed');
  assert.equal(out.cleanup.may_still_hold_plan, false);
  t.db.close();
});

// R1 L1: one key set for every outcome the module produces, including the helpers the flow
// nodes call when the cleanup could not start.
test('outcome: every outcome shape carries the same keys', async () => {
  const { unclaimCleanupFailed } = require('./unclaim');
  const t = await seedProgrammedValve();
  await unclaim(t.db);
  const sent = (await runUnclaimCleanup({ db: t.db, deviceEui: EUI, appId: 'app', flushQueue: countingFlush(), now: NOW, warn: noop })).cleanup;
  const keys = Object.keys(sent).sort();
  const failed = unclaimCleanupFailed(EUI, new Error('cannot open database'));
  assert.deepEqual(Object.keys(failed).sort(), keys);
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.device_eui, EUI);
  assert.match(failed.reason, /cannot open database/);
  const unavailable = unclaimCleanupUnavailable('db helper missing', EUI);
  assert.deepEqual(Object.keys(unavailable).sort(), keys);
  assert.equal(unavailable.device_eui, EUI);
  const sensor = (await runUnclaimCleanup({ db: t.db, deviceEui: '0016C001F1000009', appId: 'app', flushQueue: countingFlush(), now: NOW, warn: noop })).cleanup;
  assert.deepEqual(Object.keys(sensor).sort(), keys);
  t.db.close();
});
