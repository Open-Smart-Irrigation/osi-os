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

// The seed's one-off CLOCK_SYNC stays QUEUED across a compile (nothing supersedes it), so
// the plan-shaped assertions look only at the rows that carry the on-valve schedule.
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
  assert.equal(out.pushes_queued, 7);
  assert.ok(out.messages.length >= 7, 'the caller must get a downlink message for every queued clearing plan');
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

  assert.deepEqual(await queuedPushes(viaUnclaim.db), await queuedPushes(viaScheduleDelete.db),
    'the outstanding downlinks after an unclaim must equal the ones the explicit delete leaves');
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
  // scheduler clock/status ports (12/13, 21) the shared compile re-emits after its flush.
  const allowedPorts = new Set([12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 25]);
  for (const m of out.messages) {
    assert.ok(allowedPorts.has(m.payload.fPort), 'unexpected downlink on fPort ' + m.payload.fPort);
    assert.notEqual(m.payload.fPort, 1, 'a valve action must never leave the unclaim path');
    assert.notEqual(m.payload.fPort, 2, 'a valve action must never leave the unclaim path');
  }
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
  assert.equal(out.pushes_queued, 7, 'the clearing plans are still queued and go out when the valve is next reachable');
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
