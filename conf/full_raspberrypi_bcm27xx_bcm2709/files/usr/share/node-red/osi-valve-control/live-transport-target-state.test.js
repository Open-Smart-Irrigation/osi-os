'use strict';
// #601: the STREGA encoder records devices.target_state once the transport accepted the frame.
// The flows "Build actuator_log INSERT" node used to append this UPDATE to its INSERT topic, and
// the SQLite node ran only the first statement of that topic.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDb, linkCloud, FIXTURE_EUI } = require('./test-helpers');
const { liveEncoder } = require('./live-transport');

const SEED_UPDATED_AT = '2026-01-01T00:00:00.000Z';
const ACCEPTED = { phase: 'ACCEPTED', queue_id: 'q-1' };

async function seedDevice(db, targetState) {
  await db.run('UPDATE devices SET target_state=?, updated_at=? WHERE deveui=?', [targetState, SEED_UPDATED_AT, FIXTURE_EUI]);
}

function deviceRow(db) {
  return db.get('SELECT target_state, updated_at, sync_version FROM devices WHERE deveui=?', [FIXTURE_EUI]);
}

async function runEncoder(db, data, { transportResult = ACCEPTED, failTargetWrite = false } = {}) {
  const warnings = [];
  const errors = [];
  const runs = [];
  // liveEncoder closes its handle when it finishes; the test keeps querying, so close is a no-op.
  const handle = {
    get: (sql, params) => db.get(sql, params),
    all: (sql, params) => db.all(sql, params),
    run: (sql, params) => {
      runs.push(sql);
      if (failTargetWrite && /target_state/.test(sql)) return Promise.reject(new Error('SQLITE_BUSY: database is locked'));
      return db.run(sql, params);
    },
    close: (cb) => { if (cb) cb(); },
  };
  const valveControl = {
    executeValveAttempt: async () => transportResult,
    enqueueValveCommand: async () => transportResult,
  };
  const osiLib = {
    require(name) {
      if (name === 'osi-db-helper') return { ok: true, value: { Database: function Database() { return handle; } } };
      if (name === 'osi-valve-control') return { ok: true, value: valveControl };
      return { ok: false, error: 'not stubbed: ' + name };
    },
  };
  const env = { get: (key) => ({ CHIRPSTACK_APP_ACTUATORS: 'actuators-app', DEVICE_EUI: FIXTURE_EUI })[key] };
  const node = {
    warn: (m) => warnings.push(typeof m === 'string' ? m : JSON.stringify(m)),
    error: (m) => errors.push(String(m)),
    status: () => {},
  };
  const msg = {
    payload: {
      type: 'actuator_command',
      device: { devEui: FIXTURE_EUI, zone_id: null },
      data: Object.assign({ reason: 'manual_gui' }, data),
    },
    _stregaHttpResponse: { statusCode: 200, payload: {} },
  };
  const out = await liveEncoder({ msg, node, env, osiLib, chirpstack: { createProvisioningClientFromEnv: () => ({}) } });
  return { out, warnings, errors, runs };
}

test('accepted OPEN_FOR_DURATION sets target_state OPEN and leaves updated_at and sync_version alone', async () => {
  const { db, cleanup } = await tempDb();
  try {
    await seedDevice(db, null);
    const before = await deviceRow(db);
    const { out, warnings, errors } = await runEncoder(db, { action: 'OPEN_FOR_DURATION', duration_minutes: 12 });
    const after = await deviceRow(db);
    assert.equal(after.target_state, 'OPEN');
    assert.equal(after.updated_at, SEED_UPDATED_AT, 'updated_at is the current_state time; a command write must not move it');
    assert.equal(after.sync_version, before.sync_version, 'a target_state write does not bump sync_version');
    assert.equal(out[1]._log_ctx.action, 'OPEN_FOR_DURATION', 'the log context still goes to the actuator_log builder');
    assert.equal(out[3].statusCode, 202);
    assert.deepEqual(warnings.filter((w) => /target_state/.test(w)), []);
    assert.deepEqual(errors, []);
  } finally { cleanup(); }
});

test('accepted CLOSE sets target_state CLOSED', async () => {
  const { db, cleanup } = await tempDb();
  try {
    await seedDevice(db, 'OPEN');
    await runEncoder(db, { action: 'CLOSE' });
    assert.equal((await deviceRow(db)).target_state, 'CLOSED');
  } finally { cleanup(); }
});

test('accepted CLOSE_FOR_DURATION sets target_state CLOSED', async () => {
  const { db, cleanup } = await tempDb();
  try {
    await seedDevice(db, 'OPEN');
    await runEncoder(db, { action: 'CLOSE_FOR_DURATION', duration_minutes: 5 });
    assert.equal((await deviceRow(db)).target_state, 'CLOSED');
  } finally { cleanup(); }
});

test('a failed target_state write keeps the accepted response and log context and is reported', async () => {
  const { db, cleanup } = await tempDb();
  try {
    await seedDevice(db, null);
    const { out, warnings, errors } = await runEncoder(db, { action: 'OPEN_FOR_DURATION', duration_minutes: 12 }, { failTargetWrite: true });
    assert.equal(out[3].statusCode, 202, 'the frame is with ChirpStack; the caller still gets 202');
    assert.equal(out[1]._log_ctx.action, 'OPEN_FOR_DURATION', 'the actuator_log context is still emitted');
    assert.ok(warnings.some((w) => /target_state update failed/.test(w)), 'the failure is reported: ' + JSON.stringify(warnings));
    assert.deepEqual(errors, []);
    assert.equal((await deviceRow(db)).target_state, null);
  } finally { cleanup(); }
});

test('target_state write on a linked gateway queues no sync_outbox event', async () => {
  const { db, cleanup } = await tempDb();
  try {
    await seedDevice(db, null);
    await linkCloud(db);
    const before = (await db.get('SELECT COUNT(*) AS n FROM sync_outbox')).n;
    await runEncoder(db, { action: 'OPEN_FOR_DURATION', duration_minutes: 12 });
    assert.equal((await deviceRow(db)).target_state, 'OPEN');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM sync_outbox')).n, before, 'the devices outbox trigger ignores target_state');
  } finally { cleanup(); }
});

test('a command the transport did not accept leaves target_state unchanged', async () => {
  const { db, cleanup } = await tempDb();
  try {
    await seedDevice(db, null);
    const { out, runs } = await runEncoder(db, { action: 'OPEN_FOR_DURATION', duration_minutes: 12 }, { transportResult: { accepted: false, phase: 'enqueue_rejected' } });
    assert.equal(out[1], null, 'no log context');
    assert.equal((await deviceRow(db)).target_state, null);
    assert.deepEqual(runs.filter((sql) => /target_state/.test(sql)), []);
  } finally { cleanup(); }
});

test('a replayed accepted open leaves target_state unchanged', async () => {
  const { db, cleanup } = await tempDb();
  try {
    await seedDevice(db, null);
    const { runs } = await runEncoder(db, { action: 'OPEN_FOR_DURATION', duration_minutes: 12 }, { transportResult: { phase: 'ACCEPTED', replayed: true } });
    assert.equal((await deviceRow(db)).target_state, null);
    assert.deepEqual(runs.filter((sql) => /target_state/.test(sql)), []);
  } finally { cleanup(); }
});

test('accepted config actions leave target_state unchanged', async () => {
  for (const data of [
    { action: 'SET_INTERVAL', closed_interval_minutes: 10, open_interval_minutes: 2 },
    { action: 'TIMED_ACTION', valve_action: 'OPEN', unit: 'MINUTES', amount: 5 },
  ]) {
    const { db, cleanup } = await tempDb();
    try {
      await seedDevice(db, null);
      const { out, runs } = await runEncoder(db, data);
      assert.ok(out[1], data.action + ' accepted and logged');
      assert.equal((await deviceRow(db)).target_state, null, data.action + ' does not set target_state');
      assert.deepEqual(runs.filter((sql) => /target_state/.test(sql)), [], data.action);
    } finally { cleanup(); }
  }
});
