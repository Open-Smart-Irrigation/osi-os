'use strict';
// v0.8.2 review, findings F-1 to F-4: the valve fence must end.
//
// These tests run the shipped composition: the function-node code of the STREGA encoder
// ("Build STREGA downlink + emit log ctx") and of the STREGA persistence node from flows.json,
// on the shipped osi-valve-control module, with nothing injected into either. In particular no
// qualification provider is passed, because the shipped flows pass none. The gateway is simulated
// at its two outer edges only:
//   - the clock: Date is mocked and moved forward instead of waiting, and the three files
//     osi-irrigation-policy/clock.js reads (boot id, uptime, NTP marker) follow that mocked time;
//   - ChirpStack: a recorder that accepts every enqueue.
//
// "F-n" tests fail on 1bdd49d5 with HTTP 503 valve_busy (or the state named in the test).
//
// Stage 1 of the fix (CTO ruling of 2026-11-12): an ordinary command is decided as v0.8.1 decided
// it; the fence of #515 holds only where a conditional-irrigation occurrence is involved.
// scripts/test-valve-v081-equivalence.js compares whole sequences with v0.8.1. The "stage 1"
// tests here cover what that comparison cannot: the two directions between ordinary and
// conditional owners, and the answers a caller gets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { tempDb, FIXTURE_EUI: EUI } = require('./test-helpers');
const control = require('./index');
const dispatch = require('./dispatch');

const ROOT = path.resolve(__dirname, '../../../../../../../');
const flow = JSON.parse(fs.readFileSync(path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'), 'utf8'));
const encoderNode = flow.find((node) => node.id === 'cdbaa3891d40d7a1');
const stregaSqlNode = flow.find((node) => node.id === 'strega-sql-fn');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const UPTIME_PATH = '/proc/uptime';
const MARKER_PATH = '/var/run/osi-irrigation-clock.json';
const REJECTION_PATHS = ['/var/run/osi-irrigation-clock-rejection.json', MARKER_PATH + '.rejected.json'];
const ACTIVE_STATES = ['PENDING_OBSERVATION', 'OBSERVED_RUNNING'];

function missing(file) {
  return Object.assign(new Error('ENOENT: no such file or directory, open ' + file), { code: 'ENOENT' });
}

// One simulated gateway: a database from the bundled seed with one STREGA valve, a ChirpStack
// recorder, and a clock that only moves when the test moves it. `ntp: false` is a gateway that
// has had no NTP reply since boot (no marker file); ntpArrives() writes the marker.
async function gateway(t, { ntp = true, procfs = true } = {}) {
  const start = Math.floor(Date.now() / SECOND) * SECOND;
  const bootedAt = start - 10 * MINUTE;
  const bootId = 'fence-release-test-boot';
  const markerAt = (at) => ({ boot_id: bootId, epoch_ms: at, uptime_ms: at - bootedAt, stratum: 2 });
  let marker = ntp ? markerAt(start - 5 * MINUTE) : null;
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...rest) {
    if (!procfs && (file === BOOT_ID_PATH || file === UPTIME_PATH)) throw missing(file);
    if (file === BOOT_ID_PATH) return bootId + '\n';
    if (file === UPTIME_PATH) return ((Date.now() - bootedAt) / SECOND).toFixed(3) + ' 0.00\n';
    if (file === MARKER_PATH) { if (!marker) throw missing(file); return JSON.stringify(marker); }
    if (REJECTION_PATHS.includes(file)) throw missing(file);
    return readFileSync.call(this, file, ...rest);
  });

  const fixture = await tempDb();
  t.after(fixture.cleanup);
  const db = fixture.db;
  // The valve last changed state, to CLOSED, an hour before the test starts.
  await db.run("UPDATE devices SET current_state='CLOSED', updated_at=? WHERE deveui=?", [new Date(start - HOUR).toISOString(), EUI]);

  const frames = [];
  const chirpstack = {
    async enqueueDownlink(item) {
      frames.push({ fPort: Number(item.fPort), hex: Buffer.from(item.data, 'base64').toString('hex').toUpperCase(), expiresAt: item.expiresAt == null ? null : item.expiresAt });
      return { id: 'fence-q-' + frames.length };
    },
    async getDeviceQueue() { return []; },
    async flushDeviceQueue() { return { statusCode: 200 }; },
  };
  const events = [];
  const runtimeDb = { get: db.get.bind(db), all: db.all.bind(db), run: db.run.bind(db), transaction: db.transaction.bind(db), close(callback) { if (callback) callback(); } };
  class Database { constructor() { return runtimeDb; } }
  function invoke(node, msg) {
    const context = {
      msg, Buffer, Date, setTimeout,
      env: { get(name) { return name === 'CHIRPSTACK_APP_ACTUATORS' ? 'actuators' : '0016C001F1000002'; } },
      node: { warn(value) { events.push(['warn', value]); }, error(value) { events.push(['error', value]); }, status() {}, log() {} },
      osiDb: { Database },
      osiLib: { require(name) {
        if (name === 'osi-db-helper') return { ok: true, value: { Database } };
        if (name === 'osi-valve-control') return { ok: true, value: control };
        return { ok: false, error: 'unsupported test module ' + name };
      } },
      chirpstack: { createProvisioningClientFromEnv() { return chirpstack; } },
    };
    return vm.runInNewContext('(function(){\n' + node.func + '\n})()', context, { timeout: 5000 });
  }

  let fCnt = 0;
  // A valve command as the local HTTP routes hand it to the encoder. Returns what the operator is
  // answered and how many frames went to ChirpStack because of it.
  async function command(data, { http = true } = {}) {
    const before = frames.length;
    const msg = { payload: { type: 'actuator_command', device: { devEui: EUI, zone_id: null }, data: { reason: 'manual_gui', ...data } } };
    if (http) msg._stregaHttpResponse = { statusCode: 200, payload: {} };
    const out = await invoke(encoderNode, msg);
    const response = out && out[3];
    return { status: response ? response.statusCode : null, error: response && response.payload ? response.payload.error || null : null,
      body: response ? response.payload : null, ack: out && out[2] ? JSON.parse(out[2].payload) : null, sent: frames.slice(before) };
  }
  return {
    db, frames, events,
    command,
    open: (minutes = 2) => command({ action: 'OPEN_FOR_DURATION', duration_minutes: minutes }),
    // A periodic or state-change uplink of the valve, as the decoder node hands it on.
    async report(state) {
      fCnt += 1;
      const at = new Date().toISOString();
      return invoke(stregaSqlNode, { formattedData: { devEui: EUI, timestamp: at, arrivalTimestamp: at, rawTimestamp: at, currentState: state, batPct: 90, eventIdentity: { deduplicationId: 'fence-' + fCnt, fCnt, fPort: 4 } } });
    },
    // The two 60 s workers that settle expectation rows.
    async ticks() {
      await control.runReconciliationTick({ db, now: new Date(), warn: (m) => events.push(['warn', m]) });
      await control.runObserveTick({ db, now: new Date(), warn: (m) => events.push(['warn', m]) });
    },
    advance(ms) { t.mock.timers.setTime(Date.now() + ms); },
    ntpArrives() { marker = markerAt(Date.now()); },
    rows: () => db.all('SELECT expectation_id, reconciliation_state, observed_open_at, observed_close_at, transport_json FROM valve_actuation_expectations WHERE device_eui=? ORDER BY rowid', [EUI]),
    currentState: async () => (await db.get('SELECT current_state FROM devices WHERE deveui=?', [EUI])).current_state,
    // A run as 0.8.0 and 0.8.1 wrote it ("Write STREGA Expectation" at v0.8.1): no transport_json,
    // expected_close_at = commanded_at + duration + 120 s.
    async legacyRun({ commandedAgoMs, minutes, state = 'PENDING_OBSERVATION', observedOpenAgoMs = null }) {
      const commandedAt = new Date(Date.now() - commandedAgoMs).toISOString();
      const expectedCloseAt = new Date(Date.now() - commandedAgoMs + (minutes * 60 + 120) * SECOND).toISOString();
      const id = 'legacy-' + (await db.get('SELECT COUNT(*) AS n FROM valve_actuation_expectations')).n;
      await db.run(
        'INSERT INTO valve_actuation_expectations (expectation_id, device_eui, zone_id, command_id, effect_key, commanded_at, commanded_duration_seconds, expected_close_at, flow_rate_lpm, flow_rate_source, estimated_gross_liters, volume_source, reconciliation_state, created_at, trigger, observed_open_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [id, EUI, null, id, null, commandedAt, minutes * 60, expectedCloseAt, null, 'none', null, 'unknown', state, commandedAt, 'manual',
          observedOpenAgoMs == null ? null : new Date(Date.now() - observedOpenAgoMs).toISOString()]
      );
      return id;
    },
  };
}

const ACCEPTED = { status: 202, error: null };
const outcome = (result) => ({ status: result.status, error: result.error });
function assertAccepted(result, minutes, message) {
  assert.deepEqual(outcome(result), ACCEPTED, message);
  assert.deepEqual(result.sent.map((frame) => [frame.fPort, frame.hex]), [[2, '41' + minutes.toString(16).padStart(2, '0').toUpperCase()]], message + ' (frame handed to ChirpStack)');
}

// ---------------------------------------------------------------------------------------------
// F-1: one accepted open whose OPEN report is not received
// ---------------------------------------------------------------------------------------------

test('F-1: a valve can be opened again 3 hours after a 2-minute open that it never reported', async (t) => {
  const g = await gateway(t);
  assertAccepted(await g.open(2), 2, 'first open');
  g.advance(3 * HOUR);
  await g.ticks();
  assertAccepted(await g.open(2), 2, 'open 3 h after an unreported 2-minute open');
});

test('F-1: a valve can be opened again 33 days after an unreported open, when its run is long STALE_NO_OBSERVATION', async (t) => {
  const g = await gateway(t);
  assertAccepted(await g.open(2), 2, 'first open');
  g.advance(33 * DAY);
  await g.ticks();
  assert.deepEqual((await g.rows()).map((row) => row.reconciliation_state), ['STALE_NO_OBSERVATION'], 'the reconciliation tick has given up on the run');
  assertAccepted(await g.open(2), 2, 'open 33 days after an unreported 2-minute open');
});

test('F-1: a valve can be opened again when the OPEN report was lost and only CLOSED reports arrive', async (t) => {
  const g = await gateway(t);
  assertAccepted(await g.open(2), 2, 'first open');
  g.advance(1 * HOUR);
  await g.report('CLOSED');
  g.advance(1 * DAY);
  await g.report('CLOSED');
  await g.ticks();
  assertAccepted(await g.open(2), 2, 'open one day after the run, two CLOSED reports later');
});

test('F-1: a valve can be opened again 3 hours after a manual CLOSE that it never confirmed', async (t) => {
  const g = await gateway(t);
  const close = await g.command({ action: 'CLOSE' });
  assert.deepEqual(outcome(close), ACCEPTED, 'CLOSE accepted');
  assert.deepEqual(close.sent.map((frame) => [frame.fPort, frame.hex]), [[1, '30']], 'CLOSE handed to ChirpStack');
  g.advance(3 * HOUR);
  await g.ticks();
  assertAccepted(await g.open(2), 2, 'open 3 h after a manual CLOSE, no report since');
});

// Found while writing these tests, same class as F-1: an OPEN report that no gateway command
// explains (the valve's own weekly plan, Bluetooth, the magnet) creates a run without an end, and
// while devices.current_state says OPEN every stored open keeps blocking as well.
test('F-1 (extension): a valve whose last report said OPEN can be opened again 3 days later', async (t) => {
  const g = await gateway(t);
  await g.report('OPEN');
  assert.equal(await g.currentState(), 'OPEN');
  g.advance(3 * DAY);
  await g.ticks();
  assertAccepted(await g.open(2), 2, 'open 3 days after the last report, which said OPEN');
});

// ---------------------------------------------------------------------------------------------
// F-2: no NTP reply since boot
// ---------------------------------------------------------------------------------------------

test('F-2: without an NTP reply since boot, a CLOSED report after an OPEN report shows the valve closed', async (t) => {
  const g = await gateway(t, { ntp: false });
  assertAccepted(await g.open(2), 2, 'first open');
  g.advance(20 * SECOND);
  await g.report('OPEN');
  assert.equal(await g.currentState(), 'OPEN', 'the OPEN report is shown');
  g.advance(2 * MINUTE);
  await g.report('CLOSED');
  assert.equal(await g.currentState(), 'CLOSED', 'the valve reported CLOSED after OPEN in the same boot; the operator must not be shown an open valve');
});

test('F-2: without an NTP reply since boot, a valve can be opened again after its run has ended', async (t) => {
  const g = await gateway(t, { ntp: false });
  assertAccepted(await g.open(2), 2, 'first open');
  g.advance(20 * SECOND);
  await g.report('OPEN');
  g.advance(2 * MINUTE);
  await g.report('CLOSED');
  g.advance(3 * HOUR);
  await g.report('CLOSED');
  await g.ticks();
  assertAccepted(await g.open(2), 2, 'open 3 h after a run that was reported OPEN then CLOSED, clock never synchronised');
});

test('F-2: the refusal does not outlive the missing clock', async (t) => {
  const g = await gateway(t, { ntp: false });
  assertAccepted(await g.open(2), 2, 'first open');
  g.advance(20 * SECOND);
  await g.report('OPEN');
  g.advance(2 * MINUTE);
  await g.report('CLOSED');
  g.advance(10 * MINUTE);
  g.ntpArrives();
  await g.report('CLOSED');
  assert.equal(await g.currentState(), 'CLOSED', 'the first report after the NTP reply is taken');
  g.advance(10 * HOUR);
  await g.report('CLOSED');
  await g.ticks();
  assertAccepted(await g.open(2), 2, 'open 10 h after the clock arrived');
});

test('F-2: a valve can be opened again after a manual CLOSE that was sent without an NTP reply', async (t) => {
  const g = await gateway(t, { ntp: false });
  const close = await g.command({ action: 'CLOSE' });
  assert.deepEqual(outcome(close), ACCEPTED, 'CLOSE accepted');
  assert.deepEqual(close.sent.map((frame) => [frame.fPort, frame.hex]), [[1, '30']], 'CLOSE handed to ChirpStack');
  g.advance(3 * HOUR);
  await g.ticks();
  assertAccepted(await g.open(2), 2, 'open 3 h after a manual CLOSE');
});

// ---------------------------------------------------------------------------------------------
// F-3: runs left unresolved by 0.8.0 or 0.8.1 at upgrade time
// ---------------------------------------------------------------------------------------------

test('F-3: a 0.8.1 run that was never observed does not block its valve after the upgrade', async (t) => {
  const g = await gateway(t);
  await g.legacyRun({ commandedAgoMs: 2 * DAY, minutes: 2 });
  await g.ticks();
  assertAccepted(await g.open(2), 2, 'open after upgrade; the 0.8.1 run ended two days ago');
});

test('F-3: a 0.8.1 run that was never observed leaves the active states after the upgrade', async (t) => {
  const g = await gateway(t);
  await g.legacyRun({ commandedAgoMs: 2 * DAY, minutes: 2 });
  await g.ticks();
  const states = (await g.rows()).map((row) => row.reconciliation_state);
  assert.equal(states.length, 1);
  assert.ok(!ACTIVE_STATES.includes(states[0]), 'two days past expected_close_at the row is still ' + states[0] + '; 0.8.1 moved it to STALE_NO_OBSERVATION after 30 minutes');
});

test('F-3: a 0.8.1 run that was in progress at upgrade releases its valve after the commanded end', async (t) => {
  const g = await gateway(t);
  await g.db.run("UPDATE devices SET current_state='OPEN', updated_at=? WHERE deveui=?", [new Date(Date.now() - 4 * MINUTE).toISOString(), EUI]);
  await g.legacyRun({ commandedAgoMs: 5 * MINUTE, minutes: 30, state: 'OBSERVED_RUNNING', observedOpenAgoMs: 4 * MINUTE });
  await g.ticks();
  g.advance(5 * DAY);
  await g.report('CLOSED');
  await g.ticks();
  assertAccepted(await g.open(2), 2, 'open 5 days after a 30-minute 0.8.1 run, after its CLOSED report');
});

// ---------------------------------------------------------------------------------------------
// F-4: service commands
// ---------------------------------------------------------------------------------------------

for (const service of [
  { name: '"close for 2 minutes"', data: { action: 'CLOSE_FOR_DURATION', duration_minutes: 2 }, frame: [2, '4002'] },
  { name: 'a timed CLOSE of 2 minutes', data: { action: 'TIMED_ACTION', valve_action: 'CLOSE', unit: 'MINUTES', amount: 2 }, frame: [2, '4002'] },
  { name: 'flushing 50 % with return to CLOSE', data: { action: 'SET_FLUSHING', return_position: 'CLOSE', percentage: 50 }, frame: [28, '3032'] },
]) {
  test('F-4: a valve can be opened again 3 days after ' + service.name, async (t) => {
    const g = await gateway(t);
    const sent = await g.command(service.data);
    assert.deepEqual(outcome(sent), ACCEPTED, 'service command accepted');
    assert.deepEqual(sent.sent.map((frame) => [frame.fPort, frame.hex]), [service.frame], 'service frame handed to ChirpStack');
    g.advance(1 * HOUR);
    await g.report('CLOSED');
    g.advance(3 * DAY);
    await g.report('CLOSED');
    await g.ticks();
    assertAccepted(await g.open(2), 2, 'open 3 days after ' + service.name);
  });
}

// ---------------------------------------------------------------------------------------------
// Stage 1: ordinary and conditional owners
// ---------------------------------------------------------------------------------------------

// A conditional occurrence that is due now, and its reservation, as the policy worker makes them.
// The shipped flows cannot create one (an enabled policy is refused without a qualification);
// the fixture writes what an activated conditional irrigation would.
async function conditionalReservation(g, { commandId = 'conditional-1', minutes = 5 } = {}) {
  const dueAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 31 * MINUTE).toISOString();
  const endAt = new Date(Date.now() + (31 + minutes) * MINUTE).toISOString();
  await g.db.run('INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, requested_duration_minutes, reservation_start_at, reservation_end_at, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ['conditional-schedule', dueAt.slice(0, 10), dueAt.slice(11, 16), EUI, dueAt, 'PENDING', expiresAt, minutes, dueAt, endAt, minutes]);
  return dispatch.reserveValveCommand({ db: g.db, now: dueAt, command: {
    device_eui: EUI, command_id: commandId, action: 'OPEN_FOR_DURATION_CONDITIONAL', duration_minutes: minutes, timezone: 'UTC',
    occurrence: { schedule_uuid: 'conditional-schedule', local_date: dueAt.slice(0, 10), local_time: dueAt.slice(11, 16) },
  } });
}

test('stage 1: an ordinary open after a conditional reservation is refused with 409 valve_busy and sends nothing', async (t) => {
  const g = await gateway(t);
  const reserved = await conditionalReservation(g);
  assert.equal(reserved.occurrence.state, 'RESERVED');
  g.advance(1 * MINUTE);
  const open = await g.open(2);
  assert.deepEqual(outcome(open), { status: 409, error: 'valve_busy' }, 'a decision, not a transport fault');
  assert.deepEqual(open.sent, []);
});

test('stage 1: an ordinary cloud open behind an active occurrence without its expectation is refused, also days later', async (t) => {
  const g = await gateway(t);
  const dueAt = new Date().toISOString();
  await g.db.run('INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, command_id) VALUES (?,?,?,?,?,?,?)',
    ['conditional-schedule', dueAt.slice(0, 10), dueAt.slice(11, 16), EUI, dueAt, 'SENT', 'conditional-orphan']);
  g.advance(3 * DAY);
  const open = await g.command({ action: 'OPEN_FOR_DURATION', duration_minutes: 2, commandId: 'cloud-after-conditional', commandType: 'VALVE_COMMAND' }, { http: false });
  assert.deepEqual(open.sent, []);
  // The cloud ACK of a busy refusal is unchanged (FAILED). Whether it should be final belongs to
  // the release that activates conditional irrigation; no such owner can exist before.
  assert.equal(open.ack.result, 'FAILED');
  assert.equal(open.ack.transportPhase, 'valve_busy');
});

test('stage 1: a manual CLOSE is accepted and sent while a conditional reservation holds the valve', async (t) => {
  const g = await gateway(t);
  await conditionalReservation(g);
  const close = await g.command({ action: 'CLOSE' });
  assert.deepEqual(outcome(close), ACCEPTED);
  assert.deepEqual(close.sent.map((frame) => [frame.fPort, frame.hex]), [[1, '30']]);
});

test('stage 1: a conditional open after an ordinary open keeps the rule of #515 and is refused, also days later', async (t) => {
  const g = await gateway(t);
  assertAccepted(await g.open(2), 2, 'ordinary open');
  g.advance(3 * DAY);
  await assert.rejects(conditionalReservation(g), (error) => error.code === 'valve_busy');
});

// ---------------------------------------------------------------------------------------------
// Stage 1: answers and frames
// ---------------------------------------------------------------------------------------------

// The STREGA manuals of both generations warn that a valve which is already open ignores a timed
// open and is not closed at the end of the period. v0.8.1 sent the open all the same; so does
// stage 1, and it tells the caller what the valve last reported.
test('stage 1: a timed open for a valve whose last report said OPEN is sent, and the answer says so', async (t) => {
  const g = await gateway(t);
  await g.report('OPEN');
  g.advance(1 * MINUTE);
  const open = await g.open(15);
  assertAccepted(open, 15, 'open for a valve that reports OPEN');
  assert.equal(open.body.warning, 'valve_last_reported_open');
  assert.equal(open.body.valve_last_report.state, 'OPEN');
});

test('stage 1: a timed open for a valve whose last report said CLOSED carries no warning', async (t) => {
  const g = await gateway(t);
  const open = await g.open(15);
  assertAccepted(open, 15, 'open');
  assert.equal(open.body.warning, undefined);
});

test('stage 1: neither an open nor a CLOSE carries a queue expiry of the gateway', async (t) => {
  const g = await gateway(t);
  assertAccepted(await g.open(15), 15, 'open');
  assert.deepEqual(outcome(await g.command({ action: 'CLOSE' })), ACCEPTED);
  assert.deepEqual(g.frames.map((frame) => frame.expiresAt), [null, null]);
});

test('stage 1: a manual CLOSE is sent when the boot id and uptime cannot be read and no NTP reply was received', async (t) => {
  const g = await gateway(t, { ntp: false, procfs: false });
  const close = await g.command({ action: 'CLOSE' });
  assert.deepEqual(outcome(close), ACCEPTED);
  assert.deepEqual(close.sent.map((frame) => [frame.fPort, frame.hex, frame.expiresAt]), [[1, '30', null]]);
});

test('guard: a manual CLOSE is accepted and sent while an open is unresolved', async (t) => {
  const g = await gateway(t);
  assertAccepted(await g.open(15), 15, 'first open');
  g.advance(1 * MINUTE);
  const close = await g.command({ action: 'CLOSE' });
  assert.deepEqual(outcome(close), ACCEPTED);
  assert.deepEqual(close.sent.map((frame) => [frame.fPort, frame.hex]), [[1, '30']]);
});

test('guard: a manual CLOSE is accepted and sent without an NTP reply since boot', async (t) => {
  const g = await gateway(t, { ntp: false });
  assertAccepted(await g.open(15), 15, 'first open');
  g.advance(1 * MINUTE);
  const close = await g.command({ action: 'CLOSE' });
  assert.deepEqual(outcome(close), ACCEPTED);
  assert.deepEqual(close.sent.map((frame) => [frame.fPort, frame.hex]), [[1, '30']]);
});

test('guard: a run reported OPEN then CLOSED is followed by an accepted open', async (t) => {
  const g = await gateway(t);
  assertAccepted(await g.open(2), 2, 'first open');
  g.advance(20 * SECOND);
  await g.report('OPEN');
  g.advance(2 * MINUTE);
  await g.report('CLOSED');
  assertAccepted(await g.open(2), 2, 'open right after an observed complete run');
});

test('guard: a reporting-interval setting does not fence the valve', async (t) => {
  const g = await gateway(t);
  const interval = await g.command({ action: 'SET_INTERVAL', closed_interval_minutes: 10, open_interval_minutes: 2 });
  assert.deepEqual(outcome(interval), ACCEPTED);
  assertAccepted(await g.open(2), 2, 'open right after an interval setting');
});

// ---------------------------------------------------------------------------------------------
// Stage 1: reports received without a time signal (Sol's review 2, finding 2)
// ---------------------------------------------------------------------------------------------
// Measured on the 0.8.2 image: the valve's OPEN report reached the gateway before the first time
// signal and was booked as a second run, trigger 'unexplained'. Such a report is now attached to
// the ordinary open it uniquely belongs to, as evidence with an untrusted time. The record gets no
// observed time and no completion. Where the report fits no open or more than one, it is booked
// as a run without a command, and the record says which of the two it was.

const store = require('./store');
async function records(g) {
  return (await g.db.all('SELECT command_id, trigger, reconciliation_state, observed_open_at, observed_close_at, transport_json FROM valve_actuation_expectations WHERE device_eui=? ORDER BY rowid', [EUI])).map((row) => {
    const transport = JSON.parse(row.transport_json || '{}');
    return { commanded: row.command_id != null, state: row.reconciliation_state, observed: row.observed_open_at != null || row.observed_close_at != null,
      reports: Object.keys(transport.untrusted_report || {}).sort().join('+') || null, unattributed: (transport.observation || {}).unattributed || null };
  });
}
const commandedRecord = (reports, extra) => ({ commanded: true, state: 'PENDING_OBSERVATION', observed: false, reports, unattributed: null, ...(extra || {}) });

test('stage 1: without a time signal the OPEN and CLOSED reports of a run are attached to its open, and no second record is written', async (t) => {
  const g = await gateway(t, { ntp: false });
  assertAccepted(await g.open(2), 2, 'open');
  g.advance(20 * SECOND);
  await g.report('OPEN');
  assert.deepEqual(await records(g), [commandedRecord('open')], 'one record; no observed time is invented');
  g.advance(2 * MINUTE);
  await g.report('CLOSED');
  assert.deepEqual(await records(g), [commandedRecord('closed+open')], 'still one record, not marked complete');
  const evidence = JSON.parse((await g.rows())[0].transport_json).untrusted_report;
  assert.equal(typeof evidence.open.received_at, 'string');
  assert.equal(evidence.open.boot_id, 'fence-release-test-boot');
  assert.equal(evidence.closed.uptime_ms - evidence.open.uptime_ms, 2 * MINUTE, 'the two reports are two minutes of uptime apart');
  g.advance(3 * MINUTE);
  assertAccepted(await g.open(2), 2, 'the next open');
});

test('stage 1: without a time signal an OPEN report that is repeated before any CLOSED report adds nothing', async (t) => {
  const g = await gateway(t, { ntp: false });
  await g.open(15);
  g.advance(20 * SECOND);
  await g.report('OPEN');
  const first = JSON.parse((await g.rows())[0].transport_json).untrusted_report.open;
  g.advance(5 * MINUTE);
  await g.open(15);
  await g.report('OPEN');
  g.advance(5 * MINUTE);
  await g.report('OPEN');
  assert.deepEqual(await records(g), [commandedRecord('open'), commandedRecord(null)], 'the second open has been handed over since; the report stays with the run that is reporting');
  assert.deepEqual(JSON.parse((await g.rows())[0].transport_json).untrusted_report.open, first, 'the first OPEN report is kept');
});

test('stage 1: the OPEN report comes before the first time signal and the CLOSED report after it; the next run is observed with the clock', async (t) => {
  const g = await gateway(t, { ntp: false });
  await g.open(2);
  g.advance(20 * SECOND);
  await g.report('OPEN');
  g.advance(30 * SECOND);
  g.ntpArrives();
  g.advance(90 * SECOND);
  await g.report('CLOSED');
  assert.deepEqual(await records(g), [commandedRecord('closed+open')], 'the CLOSED report with a synchronised clock ends the evidence of the first run');
  g.advance(3 * MINUTE);
  assertAccepted(await g.open(2), 2, 'second open');
  g.advance(20 * SECOND);
  await g.report('OPEN');
  g.advance(2 * MINUTE);
  await g.report('CLOSED');
  assert.deepEqual(await records(g), [commandedRecord('closed+open'), { commanded: true, state: 'OBSERVED_COMPLETE', observed: true, reports: null, unattributed: null }],
    'the second run goes to the second open alone; no record without a command');
});

test('stage 1: without a time signal an OPEN report that fits two opens is attached to neither and is booked as ambiguous', async (t) => {
  const g = await gateway(t, { ntp: false });
  await g.open(2);
  g.advance(12 * SECOND);
  await g.open(2);
  g.advance(20 * SECOND);
  await g.report('OPEN');
  assert.deepEqual(await records(g), [commandedRecord(null), commandedRecord(null),
    { commanded: false, state: 'OBSERVED_RUNNING', observed: false, reports: null, unattributed: 'ambiguous_owner' }]);
  g.advance(2 * MINUTE);
  await g.report('CLOSED');
  g.advance(20 * SECOND);
  await g.report('OPEN');
  assert.equal((await records(g)).length, 3, 'the next report of that kind uses the same record');
});

test('stage 1: without a time signal a valve that already reported OPEN gives a later open no report of its own', async (t) => {
  const g = await gateway(t, { ntp: false });
  await g.report('OPEN');
  assert.deepEqual(await records(g), [{ commanded: false, state: 'OBSERVED_RUNNING', observed: false, reports: null, unattributed: 'no_owner' }], 'a run nobody commanded');
  g.advance(1 * MINUTE);
  assertAccepted(await g.open(15), 15, 'open for a valve that was opened at the valve');
  g.advance(1 * MINUTE);
  await g.report('OPEN');
  assert.deepEqual((await records(g)).map((row) => [row.commanded, row.reports]), [[false, null], [true, null]], 'the valve was open before the command; the report is not the command\'s');
});

test('stage 1: with a synchronised clock a report that fits two opens is booked as ambiguous, one that fits none as without owner', async (t) => {
  const g = await gateway(t);
  await g.report('OPEN');
  g.advance(1 * MINUTE);
  await g.report('CLOSED');
  g.advance(1 * MINUTE);
  await g.open(2);
  g.advance(12 * SECOND);
  await g.open(2);
  g.advance(20 * SECOND);
  await g.report('OPEN');
  assert.deepEqual((await records(g)).filter((row) => !row.commanded).map((row) => row.unattributed), ['no_owner', 'ambiguous_owner']);
});

test('stage 1: with conditional irrigation configured on the valve an OPEN report without a time signal is not attached to a command', async (t) => {
  const g = await gateway(t, { ntp: false });
  await g.open(2);
  await store.writeConditionalControl(g.db, EUI, { mode: 'CONDITIONAL', desired_revision: 'rev-1', required_push_ids: [], readiness: { state: 'READY', revision: 'rev-1', reason: 'all_current_clear_acked' } });
  g.advance(20 * SECOND);
  await g.report('OPEN');
  const rows = await records(g);
  assert.deepEqual(rows.map((row) => [row.commanded, row.reports]), [[true, null], [false, null]], 'the rule of #515 for conditional irrigation: a run without a command, and an incident');
  const controlRow = await g.db.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', [EUI]);
  assert.equal(JSON.parse(controlRow.conditional_control_json).incident.state, 'OPEN');
});

// ---------------------------------------------------------------------------------------------
// Council on #648: what the control panel shows as the valve's active command
// ---------------------------------------------------------------------------------------------
// The panel replaces Open with "Cancel queued open" while the valve has an active pending command
// (store.listValvesForUser for the list, store.activeActuation for the runtime sent to the cloud).
// A run whose OPEN and CLOSED reports are attached, and a CLOSE, are not opens a cancel can
// delete, so they are not shown as one. The filter is the cancel's own (dispatch.cancellableOpen).

async function shownActive(g) {
  const owner = await g.db.get('SELECT user_id FROM devices WHERE deveui=?', [EUI]);
  const listed = (await store.listValvesForUser(g.db, owner.user_id)).find((row) => row.deveui === EUI);
  const single = await store.activeActuation(g.db, EUI);
  return { list: listed.active_reconciliation_state, single: single ? single.reconciliation_state : null };
}

test('council: without a time signal the panel shows an open as pending until its run is reported over, then nothing', async (t) => {
  const g = await gateway(t, { ntp: false });
  await g.open(2);
  assert.deepEqual(await shownActive(g), { list: 'PENDING_OBSERVATION', single: 'PENDING_OBSERVATION' }, 'a queued open can be cancelled');
  g.advance(20 * SECOND);
  await g.report('OPEN');
  assert.deepEqual(await shownActive(g), { list: 'PENDING_OBSERVATION', single: 'PENDING_OBSERVATION' }, 'still the same record while the valve reports OPEN');
  g.advance(2 * MINUTE);
  await g.report('CLOSED');
  assert.deepEqual(await shownActive(g), { list: null, single: null }, 'the run is reported over; the record itself stays pending');
  assert.equal((await g.rows())[0].reconciliation_state, 'PENDING_OBSERVATION');
  const cancel = await control.cancelActuation({ db: g.db, deviceEui: EUI, flushQueue: async () => ({}), now: new Date() });
  assert.equal(cancel.error, 'no_active_actuation', 'and the cancel agrees with what the panel shows');
});

test('council: a CLOSE sent without a time signal is never shown as a pending open, also days later', async (t) => {
  const g = await gateway(t, { ntp: false });
  const close = await g.command({ action: 'CLOSE' });
  assert.deepEqual(outcome(close), ACCEPTED);
  assert.deepEqual(await shownActive(g), { list: null, single: null });
  g.advance(3 * DAY);
  await g.ticks();
  assert.deepEqual(await shownActive(g), { list: null, single: null });
  assert.equal((await g.rows())[0].reconciliation_state, 'PENDING_OBSERVATION', 'the CLOSE record gets no deadline; it is only not shown as an open');
  assertAccepted(await g.open(2), 2, 'open after the CLOSE');
  assert.deepEqual(await shownActive(g), { list: 'PENDING_OBSERVATION', single: 'PENDING_OBSERVATION' }, 'the open behind the CLOSE record is shown');
});

test('council: with a time signal a running open is shown as running, and nothing after its CLOSED report', async (t) => {
  const g = await gateway(t);
  await g.open(2);
  g.advance(20 * SECOND);
  await g.report('OPEN');
  assert.deepEqual(await shownActive(g), { list: 'OBSERVED_RUNNING', single: 'OBSERVED_RUNNING' });
  g.advance(2 * MINUTE);
  await g.report('CLOSED');
  assert.deepEqual(await shownActive(g), { list: null, single: null });
});
