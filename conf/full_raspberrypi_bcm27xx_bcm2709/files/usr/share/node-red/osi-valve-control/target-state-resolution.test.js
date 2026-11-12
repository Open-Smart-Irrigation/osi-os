'use strict';
// #601: an accepted OPEN_FOR_DURATION sets devices.target_state OPEN (live-transport.js), and the
// valve closes itself, so no command ever sets it back. These tests pin how that commanded intent
// ends: the observed close, the reconciliation tick after the expected close, and a proven cancel
// resolve it to CLOSED once no actuation for the valve is live, and the resolution reaches the
// cloud as a DEVICE_FLAGS_UPDATED event. Opens go through the real encoder and the real dispatch.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDb, linkCloud, fakeChirpStack, FIXTURE_EUI } = require('./test-helpers');
const VC = require('./index');
const workers = require('./workers');
const { cancelActuation } = require('./cancel');
const { liveEncoder } = require('./live-transport');

const GRACE_MS = 1800 * 1000;

let clockId = 0;
function trustedRuntime(at) {
  const id = ++clockId;
  const epoch = Date.parse('2026-10-18T10:00:00.000Z');
  const now = Date.parse(at);
  const boot = 'target-state-601-' + id;
  const markerPath = '/tmp/' + boot + '.json';
  const fs = { readFileSync(file) {
    if (file === '/proc/sys/kernel/random/boot_id') return boot + '\n';
    if (file === '/proc/uptime') return ((now - epoch) / 1000) + ' 0\n';
    if (file === markerPath) return JSON.stringify({ boot_id: boot, epoch_ms: epoch, uptime_ms: 0, stratum: 1 });
    throw Object.assign(new Error('missing test clock path'), { code: 'ENOENT' });
  } };
  return { runtimeNow: () => now, clockOptions: { fs, bootPath: '/proc/sys/kernel/random/boot_id', uptimePath: '/proc/uptime', markerPath,
    rejectionPath: '/tmp/' + boot + '-rejection.json', fallbackPath: '/tmp/' + boot + '-rejection-fallback.json' } };
}

// Runs one accepted OPEN_FOR_DURATION through liveEncoder. The encoder passes the wall clock to
// executeValveAttempt; the wrapper pins the attempt to the test clock and a trusted runtime.
async function acceptOpen(db, chirpstack, { commandId, at, minutes = 5 }) {
  const handle = {
    get: (sql, params) => db.get(sql, params),
    all: (sql, params) => db.all(sql, params),
    run: (sql, params) => db.run(sql, params),
    transaction: (executor) => db.transaction(executor),
    close: (cb) => { if (cb) cb(); },
  };
  const valveControl = Object.assign({}, VC, {
    executeValveAttempt: (args) => VC.executeValveAttempt(Object.assign({}, args, { now: at, trustedContext: trustedRuntime(at) })),
  });
  const osiLib = {
    require(name) {
      if (name === 'osi-db-helper') return { ok: true, value: { Database: function Database() { return handle; } } };
      if (name === 'osi-valve-control') return { ok: true, value: valveControl };
      return { ok: false, error: 'not stubbed: ' + name };
    },
  };
  const env = { get: (key) => ({ CHIRPSTACK_APP_ACTUATORS: 'actuators-app', DEVICE_EUI: FIXTURE_EUI })[key] };
  const warnings = [];
  const node = { warn: (m) => warnings.push(typeof m === 'string' ? m : JSON.stringify(m)), error: (m) => warnings.push(String(m)), status: () => {} };
  const msg = {
    payload: { type: 'actuator_command', device: { devEui: FIXTURE_EUI, zone_id: null },
      data: { action: 'OPEN_FOR_DURATION', duration_minutes: minutes, reason: 'manual_gui', commandId } },
    _stregaHttpResponse: { statusCode: 200, payload: {} },
  };
  const out = await liveEncoder({ msg, node, env, osiLib, chirpstack: { createProvisioningClientFromEnv: () => chirpstack.transport } });
  return { out, warnings };
}

function observe(db, state, reportAt) {
  const checkedAt = new Date(Date.parse(reportAt) + 1000).toISOString();
  return workers.recordValveObservation({ db, deviceEui: FIXTURE_EUI, observedState: state, observedAt: reportAt, runtimeContext: trustedRuntime(checkedAt), warn: () => {} });
}

function tick(db, at) {
  return workers.runReconciliationTick({ db, now: new Date(at), warn: () => {} });
}

async function effectEndMs(db, expectationId) {
  const row = await db.get('SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id=?', [expectationId]);
  return Date.parse(JSON.parse(row.transport_json).effect_snapshot.future_effect_end);
}

function deviceRow(db) {
  return db.get('SELECT current_state, target_state, updated_at, sync_version FROM devices WHERE deveui=?', [FIXTURE_EUI]);
}

async function deviceEvents(db) {
  const rows = await db.all("SELECT op, sync_version, payload_json FROM sync_outbox WHERE aggregate_type='DEVICE' AND aggregate_key=? ORDER BY rowid", [FIXTURE_EUI]);
  return rows.map((row) => {
    const payload = JSON.parse(row.payload_json);
    return { op: row.op, sync_version: row.sync_version, current_state: payload.current_state, target_state: payload.target_state };
  });
}

function liveExpectations(db) {
  return db.all("SELECT expectation_id FROM valve_actuation_expectations WHERE device_eui=? AND reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING')", [FIXTURE_EUI]);
}

// A valve that has reported CLOSED before, on a linked gateway. Seeded before linkCloud, so the
// seed itself queues no device event.
async function linkedClosedValve() {
  const fixture = await tempDb();
  await fixture.db.run("UPDATE devices SET current_state='CLOSED', updated_at='2026-10-18T09:00:00.000Z' WHERE deveui=?", [FIXTURE_EUI]);
  await linkCloud(fixture.db);
  return fixture;
}

test('timed open, then the valve reports OPEN and CLOSED: target_state CLOSED, carried by the close event', async () => {
  const { db, cleanup } = await linkedClosedValve();
  try {
    const { out } = await acceptOpen(db, fakeChirpStack(), { commandId: 'cmd-observed', at: '2026-10-18T10:00:00.000Z' });
    assert.equal(out[3].statusCode, 202, 'the open is accepted');
    assert.equal((await deviceRow(db)).target_state, 'OPEN');
    assert.equal((await observe(db, 'OPEN', '2026-10-18T10:00:30.000Z')).kind, 'owner', 'the OPEN report links the command owner');
    const before = await deviceRow(db);
    const eventsBefore = await deviceEvents(db);
    await observe(db, 'CLOSED', '2026-10-18T10:05:10.000Z');
    const after = await deviceRow(db);
    assert.equal(after.current_state, 'CLOSED');
    assert.equal(after.target_state, 'CLOSED', 'the observed close ends the commanded open');
    assert.equal(after.updated_at, '2026-10-18T10:05:10.000Z', 'updated_at is the time of the CLOSED report');
    assert.equal(after.sync_version, before.sync_version + 1, 'one sync_version step for the close');
    const added = (await deviceEvents(db)).slice(eventsBefore.length);
    assert.deepEqual(added, [{ op: 'DEVICE_FLAGS_UPDATED', sync_version: before.sync_version + 1, current_state: 'CLOSED', target_state: 'CLOSED' }],
      'exactly one device event, and it carries the resolved target');
    assert.equal((await db.get("SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id='cmd-observed'")).reconciliation_state, 'OBSERVED_COMPLETE');
  } finally { cleanup(); }
});

test('timed open with no report: the tick after the expected close resolves target_state and syncs it', async () => {
  const { db, cleanup } = await linkedClosedValve();
  try {
    await acceptOpen(db, fakeChirpStack(), { commandId: 'cmd-silent', at: '2026-10-18T10:00:00.000Z' });
    const end = await effectEndMs(db, 'cmd-silent');
    const before = await deviceRow(db);
    assert.equal(before.target_state, 'OPEN');
    await tick(db, end + GRACE_MS - 1000);
    assert.equal((await deviceRow(db)).target_state, 'OPEN', 'within the observation grace the open is still pending');
    assert.deepEqual(await deviceEvents(db), []);
    await tick(db, end + GRACE_MS + 1000);
    assert.equal((await db.get("SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id='cmd-silent'")).reconciliation_state, 'STALE_NO_OBSERVATION');
    const after = await deviceRow(db);
    assert.equal(after.target_state, 'CLOSED', 'an expired open is no longer a pending open');
    assert.equal(after.current_state, 'CLOSED');
    assert.equal(after.updated_at, before.updated_at, 'the resolution does not move updated_at');
    assert.deepEqual(await deviceEvents(db), [{ op: 'DEVICE_FLAGS_UPDATED', sync_version: before.sync_version + 1, current_state: 'CLOSED', target_state: 'CLOSED' }]);
  } finally { cleanup(); }
});

test('a proven cancel resolves target_state and syncs it; the cancel route still writes its own row', async () => {
  const { db, cleanup } = await linkedClosedValve();
  try {
    // An open whose enqueue ChirpStack refused: never on the air, so the cancel is proven.
    // target_state OPEN is what an earlier accepted open left behind.
    await db.run(
      "INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, trigger, created_at, transport_json) " +
      "VALUES ('e-refused', ?, '2026-10-18T10:00:00.000Z', 300, '2026-10-18T10:05:00.000Z', 'unknown', 'PENDING_OBSERVATION', 'manual', '2026-10-18T10:00:00.000Z', ?)",
      [FIXTURE_EUI, JSON.stringify({ phase: 'enqueue_rejected', attempted_at: '2026-10-18T10:00:00.100Z' })]
    );
    await db.run("UPDATE devices SET target_state='OPEN' WHERE deveui=?", [FIXTURE_EUI]);
    const before = await deviceRow(db);
    const transport = {
      getDeviceQueue: async () => { throw new Error('a proven cancel reads no queue'); },
      flushDeviceQueue: async () => { throw new Error('a proven cancel flushes nothing'); },
      enqueueDownlink: async () => { throw new Error('a cancel never enqueues'); },
    };
    // wholeQueue: the D19/Q01 flush path (conditional irrigation, unclaim). Since stage 1 the
    // cancel of an ordinary open reads the queue as v0.8.1 did.
    const out = await cancelActuation({ db, deviceEui: FIXTURE_EUI, transport, wholeQueue: true, now: new Date('2026-10-18T10:02:00.000Z') });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.outcome, 'cancelled');
    const after = await deviceRow(db);
    assert.equal(after.target_state, 'CLOSED');
    assert.equal(after.updated_at, '2026-10-18T10:02:00.000Z', 'the cancel route keeps its existing updated_at write (out of scope)');
    assert.deepEqual(await deviceEvents(db), [{ op: 'DEVICE_FLAGS_UPDATED', sync_version: before.sync_version + 1, current_state: 'CLOSED', target_state: 'CLOSED' }],
      'the cancel resolution reaches the cloud');
  } finally { cleanup(); }
});

test('a handed-off cancel keeps the OPEN target until the tick expires the open', async () => {
  const { db, cleanup } = await linkedClosedValve();
  try {
    const chirpstack = fakeChirpStack();
    await acceptOpen(db, chirpstack, { commandId: 'cmd-handed-off', at: '2026-10-18T10:00:00.000Z' });
    const out = await cancelActuation({ db, deviceEui: FIXTURE_EUI, expectationId: 'cmd-handed-off', transport: chirpstack.transport, wholeQueue: true, now: new Date('2026-10-18T10:01:00.000Z') });
    assert.equal(out.outcome, 'handed_off', 'an accepted open may already be on the air (fail closed)');
    assert.equal((await deviceRow(db)).target_state, 'OPEN', 'the valve may still open, so the target stays');
    assert.deepEqual(await deviceEvents(db), []);
    const end = await effectEndMs(db, 'cmd-handed-off');
    const before = await deviceRow(db);
    await tick(db, end + GRACE_MS + 1000);
    assert.equal((await deviceRow(db)).target_state, 'CLOSED');
    assert.deepEqual(await deviceEvents(db), [{ op: 'DEVICE_FLAGS_UPDATED', sync_version: before.sync_version + 1, current_state: 'CLOSED', target_state: 'CLOSED' }]);
  } finally { cleanup(); }
});

test('a CLOSED report before the open is delivered keeps the OPEN target (Class A)', async () => {
  const { db, cleanup } = await linkedClosedValve();
  try {
    await acceptOpen(db, fakeChirpStack(), { commandId: 'cmd-not-yet', at: '2026-10-18T10:00:00.000Z' });
    await observe(db, 'CLOSED', '2026-10-18T10:00:20.000Z');
    assert.equal((await deviceRow(db)).target_state, 'OPEN', 'the downlink rides the next uplink; the command is still pending');
    assert.deepEqual((await liveExpectations(db)).map((row) => row.expectation_id), ['cmd-not-yet']);
    assert.deepEqual(await deviceEvents(db), [], 'no state change and no resolution, so no device event');
  } finally { cleanup(); }
});

test('a second open before the first resolves is accepted as in v0.8.1; the target resolves when the last one ends', async () => {
  const { db, cleanup } = await linkedClosedValve();
  try {
    const chirpstack = fakeChirpStack();
    await acceptOpen(db, chirpstack, { commandId: 'cmd-first', at: '2026-10-18T10:00:00.000Z' });
    // v0.8.2 fix, stage 1: an ordinary open is not fenced by an earlier ordinary open, so two
    // commanded opens can be live together, as in v0.8.1.
    const second = await acceptOpen(db, chirpstack, { commandId: 'cmd-second', at: '2026-10-18T10:20:00.000Z' });
    assert.equal(second.out[3].statusCode, 202);
    assert.equal((await deviceRow(db)).target_state, 'OPEN');
    assert.deepEqual((await liveExpectations(db)).map((row) => row.expectation_id), ['cmd-first', 'cmd-second']);
    assert.deepEqual(await deviceEvents(db), []);
    const before = await deviceRow(db);
    await tick(db, (await effectEndMs(db, 'cmd-first')) + GRACE_MS + 1000);
    assert.equal((await deviceRow(db)).target_state, 'OPEN', 'the second open is still live');
    assert.deepEqual(await deviceEvents(db), []);
    await tick(db, (await effectEndMs(db, 'cmd-second')) + GRACE_MS + 1000);
    assert.equal((await deviceRow(db)).target_state, 'CLOSED');
    assert.deepEqual(await deviceEvents(db), [{ op: 'DEVICE_FLAGS_UPDATED', sync_version: before.sync_version + 1, current_state: 'CLOSED', target_state: 'CLOSED' }]);
  } finally { cleanup(); }
});

test('a replayed open after the close leaves target_state CLOSED', async () => {
  const { db, cleanup } = await linkedClosedValve();
  try {
    const chirpstack = fakeChirpStack();
    await acceptOpen(db, chirpstack, { commandId: 'cmd-replay', at: '2026-10-18T10:00:00.000Z' });
    await observe(db, 'OPEN', '2026-10-18T10:00:30.000Z');
    await observe(db, 'CLOSED', '2026-10-18T10:05:10.000Z');
    assert.equal((await deviceRow(db)).target_state, 'CLOSED');
    const eventsBefore = await deviceEvents(db);
    const enqueuedBefore = chirpstack.log.enqueued.length;
    const replay = await acceptOpen(db, chirpstack, { commandId: 'cmd-replay', at: '2026-10-18T10:06:00.000Z' });
    assert.equal(replay.out[1], null, 'a replay writes no actuator_log context');
    assert.equal(chirpstack.log.enqueued.length, enqueuedBefore, 'a replay sends nothing');
    assert.equal((await deviceRow(db)).target_state, 'CLOSED', 'a replay does not reopen the target');
    assert.deepEqual(await liveExpectations(db), []);
    assert.deepEqual(await deviceEvents(db), eventsBefore);
  } finally { cleanup(); }
});

test('a CLOSED report on a valve already CLOSED resolves a stale OPEN target with its own event', async () => {
  const { db, cleanup } = await linkedClosedValve();
  try {
    // No live actuation and current_state already CLOSED: the report changes no state, so the
    // resolver has to queue the device event itself.
    await db.run("UPDATE devices SET target_state='OPEN' WHERE deveui=?", [FIXTURE_EUI]);
    const before = await deviceRow(db);
    await observe(db, 'CLOSED', '2026-10-18T10:00:20.000Z');
    const after = await deviceRow(db);
    assert.equal(after.target_state, 'CLOSED');
    assert.equal(after.updated_at, before.updated_at, 'an unchanged state keeps its time');
    assert.deepEqual(await deviceEvents(db), [{ op: 'DEVICE_FLAGS_UPDATED', sync_version: before.sync_version + 1, current_state: 'CLOSED', target_state: 'CLOSED' }]);
  } finally { cleanup(); }
});

test('the tick resolves an OPEN target that no live actuation backs', async () => {
  const { db, cleanup } = await linkedClosedValve();
  try {
    // For example a cancel that landed between transport acceptance and the encoder's write,
    // or a target left OPEN by an older firmware.
    await db.run("UPDATE devices SET target_state='OPEN' WHERE deveui=?", [FIXTURE_EUI]);
    const before = await deviceRow(db);
    await tick(db, '2026-10-18T12:00:00.000Z');
    const after = await deviceRow(db);
    assert.equal(after.target_state, 'CLOSED');
    assert.equal(after.updated_at, before.updated_at);
    assert.deepEqual(await deviceEvents(db), [{ op: 'DEVICE_FLAGS_UPDATED', sync_version: before.sync_version + 1, current_state: 'CLOSED', target_state: 'CLOSED' }]);
    await tick(db, '2026-10-18T12:01:00.000Z');
    assert.equal((await deviceEvents(db)).length, 1, 'a resolved target queues nothing on later ticks');
  } finally { cleanup(); }
});
