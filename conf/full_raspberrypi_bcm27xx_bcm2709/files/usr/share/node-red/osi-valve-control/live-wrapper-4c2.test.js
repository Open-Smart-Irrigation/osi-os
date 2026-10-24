'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { tempDb, facade } = require('./test-helpers');

const ROOT = path.resolve(__dirname, '../../../../../../../');
const flow = JSON.parse(fs.readFileSync(path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'), 'utf8'));
const encoder = flow.find((node) => node.id === 'cdbaa3891d40d7a1');
const stregaProcess = flow.find((node) => node.id === 'strega-process-fn');
const stregaSql = flow.find((node) => node.id === 'strega-sql-fn');
const control = require('./index');
const { liveStregaSql } = require('./live-telemetry');
const EUI = '0016C001F1000001';

function runtimeControl() {
  const anchor = Date.now();
  const bootId = 'live-wrapper-test-boot';
  const fs = { readFileSync(file) {
    if (file === '/proc/sys/kernel/random/boot_id') return bootId + '\n';
    if (file === '/proc/uptime') return `${(Date.now() - anchor) / 1000} 0\n`;
    if (file === '/var/run/osi-irrigation-clock.json') return JSON.stringify({ boot_id: bootId, epoch_ms: anchor, uptime_ms: 0, stratum: 1 });
    throw Object.assign(new Error('missing test clock path'), { code: 'ENOENT' });
  } };
  return { ...control, executeValveAttempt(args) {
    return control.executeValveAttempt({ ...args, trustedContext: { clockOptions: { fs, bootPath: '/proc/sys/kernel/random/boot_id', uptimePath: '/proc/uptime', markerPath: '/var/run/osi-irrigation-clock.json', rejectionPath: '/tmp/live-wrapper-rejection.json', fallbackPath: '/tmp/live-wrapper-rejection-fallback.json' } } });
  } };
}

function trustedObservationRuntime(at) {
  const epoch = Date.parse('2026-10-18T10:00:00.000Z');
  const now = Date.parse(at);
  const bootId = 'live-observation-test-boot';
  const fs = { readFileSync(file) {
    if (file === '/proc/sys/kernel/random/boot_id') return bootId + '\n';
    if (file === '/proc/uptime') return `${(now - epoch) / 1000} 0\n`;
    if (file === '/var/run/osi-irrigation-clock.json') return JSON.stringify({ boot_id: bootId, epoch_ms: epoch, uptime_ms: 0, stratum: 1 });
    throw Object.assign(new Error('missing test clock path'), { code: 'ENOENT' });
  } };
  return { runtimeNow: () => now, clockOptions: { fs, bootPath: '/proc/sys/kernel/random/boot_id', uptimePath: '/proc/uptime', markerPath: '/var/run/osi-irrigation-clock.json', rejectionPath: '/tmp/live-observation-rejection.json', fallbackPath: '/tmp/live-observation-rejection-fallback.json' } };
}

function invoke(node, db, transport, msg, events, valveControl = control) {
  const runtimeDb = { get: db.get.bind(db), all: db.all.bind(db), run: db.run.bind(db), transaction: db.transaction.bind(db), close(callback) { callback(); } };
  class Database { constructor() { return runtimeDb; } }
  const context = {
    msg, Buffer, Date, setTimeout,
    env: { get(name) { return name === 'CHIRPSTACK_APP_ACTUATORS' ? 'actuators' : '0016C001F1000002'; } },
    node: { warn(value) { events.push(['warn', value]); }, error(value) { events.push(['error', value]); }, status(value) { events.push(['status', value]); }, log(value) { events.push(['log', value]); } },
    osiDb: { Database },
    osiLib: { require(name) {
      if (name === 'osi-db-helper') return { ok: true, value: { Database } };
      if (name === 'osi-valve-control') return { ok: true, value: valveControl };
      return { ok: false, error: 'unsupported test module ' + name };
    } },
    chirpstack: { createProvisioningClientFromEnv() { return transport; } },
  };
  return vm.runInNewContext('(function(){\n' + node.func + '\n})()', context, { timeout: 5000 });
}

async function invokeStregaProcess(db, msg, events) {
  const callbackDb = {
    all(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      db.all(sql, params || []).then((rows) => callback(null, rows), (error) => callback(error));
    },
    close(callback) { if (callback) callback(); },
  };
  class Database { constructor() { return callbackDb; } }
  const context = {
    msg, Buffer, Date, setTimeout,
    env: { get(name) {
      if (name === 'CHIRPSTACK_PROFILE_STREGA') return 'strega-profile';
      return '';
    } },
    global: { get() { return undefined; } },
    context: {},
    node: { warn(value) { events.push(['warn', value]); }, error(value) { events.push(['error', value]); }, status(value) { events.push(['status', value]); } },
    osiDb: { Database },
    osiLib: { require(name) {
      if (name === 'osi-db-helper') return { ok: true, value: { Database } };
      if (name === 'uplink-dedup') return { ok: true, value: { isDuplicateUplink() { return false; } } };
      return { ok: false, error: 'unsupported test module ' + name };
    } },
  };
  return vm.runInNewContext('(function(){\n' + stregaProcess.func + '\n})()', context, { timeout: 5000 });
}

test('shipped encoder uses the live composition for an untrusted-clock safety CLOSE', async () => {
  const fixture = await tempDb();
  const calls = [];
  const events = [];
  const result = await invoke(encoder, fixture.db, { async enqueueDownlink(item) { calls.push(item); return { id: 'live-safe-close-1' }; } }, {
    payload: { type: 'actuator_command', device: { devEui: EUI }, data: { action: 'CLOSE', commandType: 'CLOSE' } },
  }, events);
  assert.equal(result[0], null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].expiresAt, undefined);
  assert.equal(result[1]._log_ctx.action, 'CLOSE');
  const row = await fixture.db.get('SELECT transport_json FROM valve_actuation_expectations ORDER BY rowid DESC LIMIT 1');
  assert.equal(JSON.parse(row.transport_json).effect_snapshot.timing_contract, 'UNBOUNDED_SAFE_CLOSE_V1');
  fixture.cleanup();
});

test('shipped encoder restores an actual timed OPEN and accepted replay emits no second actuator log', async () => {
  const fixture = await tempDb();
  const calls = [];
  const events = [];
  const msg = { payload: { type: 'actuator_command', device: { devEui: EUI }, data: { action: 'OPEN_FOR_DURATION', duration_minutes: 2, commandId: 'live-open-replay-1', commandType: 'VALVE_COMMAND' } }, _stregaHttpResponse: { res: {}, statusCode: 202, payload: { status: 'queued' } } };
  const out = await invoke(encoder, fixture.db, { async enqueueDownlink(item) { calls.push(item); return { id: 'live-open-q1' }; } }, msg, events, runtimeControl());
  assert.equal(calls.length, 1);
  assert.deepEqual([...Buffer.from(calls[0].data, 'base64')], [0x41, 2]);
  assert.equal(out[1]._log_ctx.action, 'OPEN_FOR_DURATION');
  assert.equal(JSON.parse(out[2].payload).result, 'SUCCESS');
  const beforeLogs = events.filter((entry) => entry[0] === 'log').length;
  const replay = await invoke(encoder, fixture.db, { async enqueueDownlink() { throw new Error('accepted replay must not enqueue'); } }, msg, events, runtimeControl());
  assert.equal(replay[0], null);
  assert.equal(replay[1], null);
  assert.equal(JSON.parse(replay[2].payload).result, 'SUCCESS');
  assert.equal(events.filter((entry) => entry[0] === 'log').length, beforeLogs);
  fixture.cleanup();
});

// Owner decision 2026-10-24: no NTP-since-boot requirement for a timed OPEN.
test('shipped encoder sends an ordinary timed OPEN without an NTP marker', async () => {
  const fixture = await tempDb();
  let calls = 0;
  const events = [];
  await assert.doesNotReject(async () => {
    const result = await invoke(encoder, fixture.db, { async enqueueDownlink() { calls += 1; return { id: 'must-not-send' }; } }, {
      payload: { type: 'actuator_command', device: { devEui: EUI }, data: { action: 'OPEN_FOR_DURATION', duration_minutes: 2, commandId: 'live-clock-open-1' } },
      _stregaDispatchCommand: { device_eui: EUI, command_id: 'live-clock-open-1', action: 'OPEN_FOR_DURATION', duration_minutes: 2 },
    }, events);
  });
  assert.equal(calls, 1, 'the open is handed to ChirpStack');
  const row = await fixture.db.get('SELECT COUNT(*) AS count FROM valve_actuation_expectations WHERE command_id=?', ['live-clock-open-1']);
  assert.equal(row.count, 1, 'the open is reserved and tracked');
  fixture.cleanup();
});

test('telemetry cleanup reports a database close failure without replacing the persistence result', async () => {
  const fixture = await tempDb();
  const warnings = [];
  const runtimeDb = { transaction: fixture.db.transaction.bind(fixture.db), close() { throw new Error('close-fixture-failure'); } };
  class Database { constructor() { return runtimeDb; } }
  const msg = { formattedData: { devEui: EUI, timestamp: '2026-10-18T10:00:00.000Z', currentState: null } };
  const result = await liveStregaSql({ msg, node: { warn(value) { warnings.push(value); }, error() {}, status() {} }, osiDb: { Database }, osiLib: { require() { return { ok: true, value: { recordValveObservation() {} } }; } } });
  assert.equal(result, msg);
  assert.ok(warnings.some((value) => String(value).includes('close-fixture-failure')));
  fixture.cleanup();
});

test('actual STREGA telemetry wrapper composes raw telemetry and observation atomically', async () => {
  const fixture = await tempDb();
  const events = [];
  const runtimeDb = { get: fixture.db.get.bind(fixture.db), all: fixture.db.all.bind(fixture.db), run: fixture.db.run.bind(fixture.db), transaction: fixture.db.transaction.bind(fixture.db), close(callback) { if (callback) callback(); } };
  class Database { constructor() { return runtimeDb; } }
  const base = { devEui: EUI, ambientTemperature: 21.5, relativeHumidity: 55, batPct: 80 };
  const open = await liveStregaSql({
    msg: { formattedData: { ...base, timestamp: '2026-10-18T10:00:00.000Z', currentState: 'OPEN', eventIdentity: { fCnt: 1 }, runtimeContext: trustedObservationRuntime('2026-10-18T10:00:01.000Z') }, runtimeContext: trustedObservationRuntime('2026-10-18T10:00:01.000Z') },
    node: { warn(value) { events.push(['warn', value]); }, error(value) { events.push(['error', value]); }, status() {} },
    osiDb: { Database },
    osiLib: { require(name) { return name === 'osi-valve-control' ? { ok: true, value: control } : { ok: false, error: 'unused' }; } },
  });
  assert.ok(open);
  assert.equal((await fixture.db.get('SELECT COUNT(*) AS count FROM device_data WHERE deveui=?', [EUI])).count, 1);
  assert.equal((await fixture.db.get('SELECT current_state FROM devices WHERE deveui=?', [EUI])).current_state, 'OPEN');
  const observation = await fixture.db.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', [EUI]);
  assert.equal(JSON.parse(observation.conditional_control_json).observation.state, 'OPEN');

  const closed = await liveStregaSql({
    msg: { formattedData: { ...base, timestamp: '2026-10-18T10:00:30.000Z', currentState: 'CLOSED', eventIdentity: { fCnt: 2 } }, runtimeContext: trustedObservationRuntime('2026-10-18T10:00:31.000Z') },
    node: { warn(value) { events.push(['warn', value]); }, error(value) { events.push(['error', value]); }, status() {} },
    osiDb: { Database },
    osiLib: { require(name) { return name === 'osi-valve-control' ? { ok: true, value: control } : { ok: false, error: 'unused' }; } },
  });
  assert.ok(closed);
  assert.equal((await fixture.db.get('SELECT COUNT(*) AS count FROM device_data WHERE deveui=?', [EUI])).count, 2);
  assert.equal((await fixture.db.get('SELECT current_state FROM devices WHERE deveui=?', [EUI])).current_state, 'CLOSED');
  fixture.cleanup();
});

test('actual profile-gated STREGA decoder feeds the shipped SQL wrapper', async () => {
  const fixture = await tempDb();
  const events = [];
  const rejected = await invokeStregaProcess(fixture.db, {
    payload: { deviceInfo: { devEui: EUI, deviceProfileName: 'KIWI_SENSOR' }, object: { Valve: 1 }, time: '2026-10-18T10:00:00.000Z' },
  }, events);
  assert.equal(rejected, null);
  const decoded = await invokeStregaProcess(fixture.db, {
    payload: {
      deviceInfo: { devEui: EUI, deviceProfileName: 'STREGA Valve' },
      object: { Valve: 1, Battery: 82, Temperature: 21.2, Hygrometry: 54 },
      time: '2026-10-18T10:00:00.000Z', fCnt: 11, fPort: 2, deduplicationId: 'strega-real-flow-1',
    },
  }, events);
  assert.ok(decoded && decoded.formattedData);
  assert.equal(decoded.formattedData.currentState, 'OPEN');
  decoded.runtimeContext = trustedObservationRuntime('2026-10-18T10:00:01.000Z');
  const runtimeResult = await invoke(stregaSql, fixture.db, null, decoded, events);
  assert.ok(runtimeResult);
  assert.equal(runtimeResult.formattedData.currentState, 'OPEN');
  assert.equal((await fixture.db.get('SELECT COUNT(*) AS count FROM device_data WHERE deveui=?', [EUI])).count, 1);
  assert.equal((await fixture.db.get('SELECT current_state FROM devices WHERE deveui=?', [EUI])).current_state, 'OPEN');
  fixture.cleanup();
});

test('profile decoder preserves absent and malformed report times as untrusted audit input', async () => {
  const fixture = await tempDb();
  const events = [];
  const base = { deviceInfo: { devEui: EUI, deviceProfileName: 'STREGA Valve' }, object: { Valve: 1, Battery: 82 } };
  const missing = await invokeStregaProcess(fixture.db, { payload: { ...base } }, events);
  assert.ok(missing && missing.formattedData);
  assert.equal(missing.formattedData.timestamp, null);
  assert.match(missing.formattedData.arrivalTimestamp, /^\d{4}-\d\d-\d\dT/);
  missing.runtimeContext = trustedObservationRuntime('2026-10-18T10:00:01.000Z');
  await invoke(stregaSql, fixture.db, null, missing, events);
  const missingRaw = await fixture.db.get('SELECT recorded_at FROM device_data WHERE deveui=?', [EUI]);
  assert.equal(missingRaw.recorded_at, missing.formattedData.arrivalTimestamp);
  assert.equal((await fixture.db.get('SELECT current_state FROM devices WHERE deveui=?', [EUI])).current_state, 'OPEN');
  const missingControl = JSON.parse((await fixture.db.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', [EUI])).conditional_control_json);
  assert.equal(missingControl.observation.untrusted_reports.at(-1).reported_at, null);

  const malformed = await invokeStregaProcess(fixture.db, { payload: { ...base, object: { Valve: 0 }, time: 'not-a-time' } }, events);
  assert.ok(malformed && malformed.formattedData);
  assert.equal(malformed.formattedData.timestamp, null);
  malformed.runtimeContext = trustedObservationRuntime('2026-10-18T10:00:02.000Z');
  await invoke(stregaSql, fixture.db, null, malformed, events);
  assert.equal((await fixture.db.get('SELECT COUNT(*) AS count FROM device_data WHERE deveui=?', [EUI])).count, 2);
  assert.equal((await fixture.db.get('SELECT current_state FROM devices WHERE deveui=?', [EUI])).current_state, 'OPEN');
  assert.ok(events.some((entry) => entry[0] === 'warn' && String(entry[1]).includes('CLOSED evidence')));
  fixture.cleanup();
});

test('live wrapper invokes exact-CLOSE evidence after each committed CLOSED report', async () => {
  const fixture = await tempDb();
  const events = [];
  let closeCalls = 0;
  const valveControl = {
    ...control,
    observeClosedEvidence(args) {
      closeCalls += 1;
      return control.observeClosedEvidence(args);
    },
  };
  const invokeClosed = (time, fCnt) => liveStregaSql({
    msg: { formattedData: { devEui: EUI, timestamp: time, currentState: 'CLOSED', eventIdentity: { fCnt } }, runtimeContext: trustedObservationRuntime('2026-10-18T10:00:01.000Z') },
    node: { warn(value) { events.push(['warn', value]); }, error() {}, status() {} },
    osiDb: { Database: class Database { constructor() { return facade(new DatabaseSync(fixture.path)); } } },
    osiLib: { require(name) { return name === 'osi-valve-control' ? { ok: true, value: valveControl } : { ok: false, error: 'unused' }; } },
  });
  await invokeClosed('2026-10-18T10:00:00.000Z', 1);
  await invokeClosed('2026-10-18T10:00:00.000Z', 1);
  assert.equal(closeCalls, 2);
  fixture.cleanup();
});

test('live wrapper fails closed when the valve module cannot load', async () => {
  const fixture = await tempDb();
  const errors = [];
  const result = await liveStregaSql({
    msg: { formattedData: { devEui: EUI, timestamp: '2026-10-18T10:00:00.000Z', currentState: 'OPEN' } },
    node: { warn() {}, error(value) { errors.push(value); }, status() {} },
    osiDb: { Database: class Database { constructor() { return fixture.db; } } },
    osiLib: { require() { return { ok: false, error: 'module missing' }; } },
  });
  assert.equal(result, null);
  assert.ok(errors.some((value) => String(value).includes('helper unavailable')));
  fixture.cleanup();
});

test('actual wrapper rolls back raw telemetry when its transaction rejects', async () => {
  const fixture = await tempDb();
  const errors = [];
  const failingDb = {
    transaction(executor) {
      return fixture.db.transaction((tx) => executor({
        ...tx,
        async run(sql, params) {
          if (String(sql).includes('INSERT INTO device_data')) throw new Error('raw write failed');
          return tx.run(sql, params);
        },
      }));
    },
    close(callback) { if (callback) callback(); },
  };
  const result = await liveStregaSql({
    msg: { formattedData: { devEui: EUI, timestamp: '2026-10-18T10:00:00.000Z', currentState: 'OPEN' }, runtimeContext: trustedObservationRuntime('2026-10-18T10:00:01.000Z') },
    node: { warn() {}, error(value) { errors.push(value); }, status() {} },
    osiDb: { Database: class Database { constructor() { return failingDb; } } },
    osiLib: { require(name) { return name === 'osi-valve-control' ? { ok: true, value: control } : { ok: false, error: 'unused' }; } },
  });
  assert.equal(result, null);
  assert.equal((await fixture.db.get('SELECT COUNT(*) AS count FROM device_data WHERE deveui=?', [EUI])).count, 0);
  assert.equal((await fixture.db.get('SELECT current_state FROM devices WHERE deveui=?', [EUI])).current_state, null);
  assert.ok(errors.some((value) => String(value).includes('persistence failed')));
  fixture.cleanup();
});
