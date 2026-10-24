#!/usr/bin/env node
'use strict';

// Task 5b2 integration checks: explicit STREGA observations own endpoint and
// event completion; the periodic worker only recovers durable command timeouts.
const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { tempDb, facade, linkCloud } = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/test-helpers');
const workers = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/workers');

const EUI = '0016C001F1000001';
let clockId = 0;

function trustedRuntime(at) {
  const id = ++clockId;
  const epoch = Date.parse('2026-10-18T10:00:00.000Z');
  const now = Date.parse(at);
  const boot = 'task5b2-observation-' + id;
  const markerPath = '/tmp/' + boot + '.json';
  const rejectionPath = '/tmp/' + boot + '-rejection.json';
  const fallbackPath = '/tmp/' + boot + '-rejection-fallback.json';
  const fs = { readFileSync(file) {
    if (file === '/proc/sys/kernel/random/boot_id') return boot + '\n';
    if (file === '/proc/uptime') return ((now - epoch) / 1000) + ' 0\n';
    if (file === markerPath) return JSON.stringify({ boot_id: boot, epoch_ms: epoch, uptime_ms: 0, stratum: 1 });
    throw Object.assign(new Error('missing test clock path'), { code: 'ENOENT' });
  } };
  return { runtimeNow: () => now, clockOptions: { fs, bootPath: '/proc/sys/kernel/random/boot_id', uptimePath: '/proc/uptime', markerPath, rejectionPath, fallbackPath } };
}

async function assignZone(db) {
  await db.run("INSERT INTO irrigation_zones(name, user_id, timezone) VALUES ('5b2 zone', 1, 'UTC')");
  const zone = await db.get("SELECT id FROM irrigation_zones WHERE name='5b2 zone'");
  await db.run('UPDATE devices SET irrigation_zone_id=? WHERE deveui=?', [zone.id, EUI]);
  return zone.id;
}

async function seedPhysicalRun(db, { expectationId, trigger = 'unexplained', commandId = null, state = 'PENDING_OBSERVATION', futureEffectEnd = null } = {}) {
  const marker = commandId == null ? { physical_run: { version: 1, source: 'explicit_report', earliest_possible_start_at: null, latest_possible_end_at: null } } : { effect_snapshot: { future_effect_end: futureEffectEnd } };
  const at = '2026-10-18T10:00:00.000Z';
  await db.run(
    `INSERT INTO valve_actuation_expectations(expectation_id,device_eui,zone_id,command_id,effect_key,commanded_at,commanded_duration_seconds,expected_close_at,volume_source,observed_open_at,observed_close_at,reconciliation_state,created_at,trigger,transport_json)
     SELECT ?,deveui,irrigation_zone_id,?,?,?,900,?,'unknown',NULL,NULL,?,?,?,? FROM devices WHERE deveui=?`,
    [expectationId, commandId, commandId ? 'effect' : null, at, new Date(Date.parse(at) + 900000).toISOString(), state, at, trigger, JSON.stringify(marker), EUI]
  );
}

async function observe(db, state, reportAt, checkedAt, warn = () => {}) {
  return workers.recordValveObservation({ db, deviceEui: EUI, observedState: state, observedAt: reportAt, runtimeContext: trustedRuntime(checkedAt), warn });
}

async function seedLegacyCandidate(db, { expectationId, supported = true, durationSeconds = 900, observedOpenAt = '2026-10-18T10:01:00Z' } = {}) {
  await seedPhysicalRun(db, { expectationId, trigger: 'on_valve_schedule', state: 'OBSERVED_RUNNING' });
  await db.run(
    "UPDATE valve_actuation_expectations SET commanded_at=?, commanded_duration_seconds=?, expected_close_at=?, observed_open_at=?, transport_json=? WHERE expectation_id=?",
    [supported ? '2026-10-18T10:00:00Z' : '2026-10-18T10:00:00+01:00', durationSeconds, supported ? '2026-10-18T10:15:00Z' : '2026-10-18T10:15:00+01:00', observedOpenAt, JSON.stringify({ phase: 'legacy-audit' }), expectationId]
  );
}

test('explicit OPEN/CLOSED completion logs one report-only event with null duration', async () => {
  const fixture = await tempDb();
  const zoneId = await assignZone(fixture.db);
  await seedPhysicalRun(fixture.db, { expectationId: 'physical-5b2', trigger: 'on_valve_schedule' });
  await observe(fixture.db, 'OPEN', '2026-10-18T10:00:01.000Z', '2026-10-18T10:00:02.000Z');
  await observe(fixture.db, 'CLOSED', '2026-10-18T10:00:20.000Z', '2026-10-18T10:00:21.000Z');
  await observe(fixture.db, 'CLOSED', '2026-10-18T10:00:30.000Z', '2026-10-18T10:00:31.000Z');
  const events = await fixture.db.all('SELECT * FROM irrigation_events WHERE valve_deveui=?', [EUI]);
  assert.equal(events.length, 1);
  assert.equal(events[0].irrigation_zone_id, zoneId);
  assert.equal(events[0].reason, 'on_valve_schedule_run');
  assert.equal(events[0].duration_minutes, null);
  assert.equal((await fixture.db.get('SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id=?', ['physical-5b2'])).reconciliation_state, 'OBSERVED_COMPLETE');
  fixture.cleanup();
});

test('zone-less report-only completion warns and remains local without an irrigation event', async () => {
  const fixture = await tempDb();
  await seedPhysicalRun(fixture.db, { expectationId: 'physical-zone-less-5b2' });
  const warnings = [];
  await observe(fixture.db, 'OPEN', '2026-10-18T10:00:01.000Z', '2026-10-18T10:00:02.000Z', (message) => warnings.push(message));
  await observe(fixture.db, 'CLOSED', '2026-10-18T10:00:20.000Z', '2026-10-18T10:00:21.000Z', (message) => warnings.push(message));
  assert.equal((await fixture.db.all('SELECT id FROM irrigation_events WHERE valve_deveui=?', [EUI])).length, 0);
  assert.ok(warnings.some((message) => /observed run not logged/.test(String(message))));
  fixture.cleanup();
});

test('restart recovery adopts a pre-existing on-valve row and preserves its v1 audit fields', async () => {
  const fixture = await tempDb();
  const zoneId = await assignZone(fixture.db);
  const expectationId = 'legacy-preexisting-5b2';
  await seedPhysicalRun(fixture.db, { expectationId, trigger: 'on_valve_schedule', state: 'OBSERVED_RUNNING' });
  await fixture.db.run(
    "UPDATE valve_actuation_expectations SET commanded_at=?, commanded_duration_seconds=?, expected_close_at=?, volume_source=?, observed_open_at=?, transport_json=? WHERE expectation_id=?",
    ['2026-10-18T10:00:00Z', 1800, '2026-10-18T10:30:00Z', 'measured', '2026-10-18T10:01:00Z', JSON.stringify({ phase: 'legacy-audit', estimated_gross_liters: 42 }), expectationId]
  );

  const recovered = await workers.recoverValveObservation({ db: fixture.db, deviceEui: EUI, now: new Date('2026-10-18T10:02:00.000Z') });
  assert.equal(recovered.adopted, true);
  assert.equal(recovered.physical_run_id, expectationId);
  const adopted = await fixture.db.get('SELECT * FROM valve_actuation_expectations WHERE expectation_id=?', [expectationId]);
  assert.equal(adopted.commanded_at, '2026-10-18T10:00:00Z');
  assert.equal(adopted.commanded_duration_seconds, 1800);
  assert.equal(adopted.expected_close_at, '2026-10-18T10:30:00Z');
  assert.equal(adopted.volume_source, 'measured');
  const adoptedTransport = JSON.parse(adopted.transport_json);
  assert.equal(adoptedTransport.phase, 'legacy-audit');
  assert.equal(adoptedTransport.estimated_gross_liters, 42);
  assert.deepEqual(adoptedTransport.physical_run.legacy_v1_compatibility, {
    version: 1,
    source: 'preexisting_on_valve_schedule',
    expectation_id: expectationId,
    commanded_at: '2026-10-18T10:00:00Z',
    commanded_duration_seconds: 1800,
    expected_close_at: '2026-10-18T10:30:00Z',
  });

  await observe(fixture.db, 'OPEN', '2026-10-18T10:03:00.000Z', '2026-10-18T10:03:01.000Z');
  fixture.raw.close();
  fixture.db = facade(new DatabaseSync(fixture.path));
  await observe(fixture.db, 'OPEN', '2026-10-18T10:04:00.000Z', '2026-10-18T10:04:01.000Z');
  const reopened = await fixture.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id=?', [expectationId]);
  assert.deepEqual(JSON.parse(reopened.transport_json).physical_run.legacy_v1_compatibility, adoptedTransport.physical_run.legacy_v1_compatibility);
  await observe(fixture.db, 'CLOSED', '2026-10-18T10:05:00.000Z', '2026-10-18T10:05:01.000Z');
  const completed = await fixture.db.get('SELECT * FROM valve_actuation_expectations WHERE expectation_id=?', [expectationId]);
  const completedTransport = JSON.parse(completed.transport_json);
  assert.equal(completed.reconciliation_state, 'OBSERVED_COMPLETE');
  assert.equal(completed.observed_close_at, '2026-10-18T10:05:00.000Z');
  assert.deepEqual(completedTransport.physical_run.legacy_v1_compatibility, adoptedTransport.physical_run.legacy_v1_compatibility);
  assert.equal((await fixture.db.all('SELECT * FROM irrigation_events WHERE valve_deveui=?', [EUI])).length, 1);
  const event = await fixture.db.get('SELECT irrigation_zone_id, duration_minutes FROM irrigation_events WHERE valve_deveui=?', [EUI]);
  assert.equal(event.irrigation_zone_id, zoneId);
  assert.equal(event.duration_minutes, null);
  await observe(fixture.db, 'CLOSED', '2026-10-18T10:06:00.000Z', '2026-10-18T10:06:01.000Z');
  assert.equal((await fixture.db.all('SELECT * FROM irrigation_events WHERE valve_deveui=?', [EUI])).length, 1);
  fixture.cleanup();
});

test('legacy-v1 adoption gates reject sentinels, markers, commands, malformed transport, and unsafe timing', () => {
  const valid = {
    expectation_id: 'legacy-gate-5b2', command_id: null, trigger: 'on_valve_schedule',
    commanded_at: '2026-10-18T10:00:00Z', commanded_duration_seconds: 1800,
    expected_close_at: '2026-10-18T10:30:00Z', transport_json: null,
  };
  assert.equal(workers.isLegacyV1CompatibilityCandidate(valid), true);
  for (const [name, mutation] of [
    ['command', { command_id: 'already-commanded' }],
    ['trigger', { trigger: 'service_action' }],
    ['zero duration', { commanded_duration_seconds: 0 }],
    ['string duration', { commanded_duration_seconds: '1800' }],
    ['unsafe duration', { commanded_duration_seconds: Number.MAX_SAFE_INTEGER + 1 }],
    ['bad commanded time', { commanded_at: 'not-a-time' }],
    ['non-UTC time', { expected_close_at: '2026-10-18T10:30:00+01:00' }],
    ['lowercase UTC marker', { expected_close_at: '2026-10-18T10:30:00z' }],
    ['too many fractional digits', { expected_close_at: '2026-10-18T10:30:00.1234567890Z' }],
    ['malformed transport', { transport_json: '{' }],
    ['pre-existing marker', { transport_json: JSON.stringify({ physical_run: { version: 1, source: 'explicit_report', earliest_possible_start_at: null, latest_possible_end_at: null } }) }],
    ['synthetic sentinel', { commanded_duration_seconds: -1, expected_close_at: '', transport_json: JSON.stringify({ physical_run: { version: 1, source: 'explicit_report', earliest_possible_start_at: null, latest_possible_end_at: null, legacy_v1_compatibility: { version: 1, source: 'preexisting_on_valve_schedule' } } }) }],
  ]) {
    assert.equal(workers.isLegacyV1CompatibilityCandidate({ ...valid, ...mutation }), false, name);
  }
});

test('unsupported pre-existing legacy timing stays untouched and fails closed on recovery', async () => {
  const fixture = await tempDb();
  const expectationId = 'legacy-unsupported-5b2';
  await seedPhysicalRun(fixture.db, { expectationId, trigger: 'on_valve_schedule', state: 'OBSERVED_RUNNING' });
  await fixture.db.run(
    "UPDATE valve_actuation_expectations SET commanded_at=?, expected_close_at=?, observed_open_at=?, transport_json=? WHERE expectation_id=?",
    ['2026-10-18T10:00:00+01:00', '2026-10-18T10:30:00+01:00', '2026-10-18T10:01:00Z', JSON.stringify({ phase: 'legacy-unsupported' }), expectationId]
  );
  const before = await fixture.db.get('SELECT commanded_at, expected_close_at, transport_json FROM valve_actuation_expectations WHERE expectation_id=?', [expectationId]);
  const recovered = await workers.recoverValveObservation({ db: fixture.db, deviceEui: EUI, now: new Date('2026-10-18T10:02:00.000Z') });
  assert.equal(recovered.reason, 'unsupported_legacy_recovery');
  const after = await fixture.db.get('SELECT commanded_at, expected_close_at, transport_json FROM valve_actuation_expectations WHERE expectation_id=?', [expectationId]);
  assert.deepEqual({ ...after }, { ...before });
  fixture.cleanup();
});

for (const [label, reportAt, checkedAt] of [
  ['trusted', '2026-10-18T10:00:01.000Z', '2026-10-18T10:00:02.000Z'],
  ['untrusted', '2026-10-18T10:00:03.000Z', '2026-10-18T10:00:02.000Z'],
]) {
  test(`live ${label} OPEN leaves unsupported legacy row unchanged`, async () => {
    const fixture = await tempDb();
    await seedLegacyCandidate(fixture.db, { expectationId: `unsupported-live-${label}` , supported: false, observedOpenAt: null });
    const beforeRow = await fixture.db.get('SELECT * FROM valve_actuation_expectations WHERE expectation_id=?', [`unsupported-live-${label}`]);
    const beforeEvents = await fixture.db.all('SELECT * FROM irrigation_events');
    const beforeState = await fixture.db.get('SELECT current_state, updated_at FROM devices WHERE deveui=?', [EUI]);
    const result = await observe(fixture.db, 'OPEN', reportAt, checkedAt);
    assert.equal(result.kind, 'blocked');
    assert.equal(result.reason, 'unsupported_legacy_recovery');
    const afterRow = await fixture.db.get('SELECT * FROM valve_actuation_expectations WHERE expectation_id=?', [`unsupported-live-${label}`]);
    assert.deepEqual({ ...afterRow }, { ...beforeRow });
    assert.deepEqual(await fixture.db.all('SELECT * FROM irrigation_events'), beforeEvents);
    assert.deepEqual({ ...(await fixture.db.get('SELECT current_state, updated_at FROM devices WHERE deveui=?', [EUI])) }, { ...beforeState });
    fixture.cleanup();
  });
}

for (const durationSeconds of [0, 1.5]) {
  for (const [label, reportAt, checkedAt] of [
    ['trusted', '2026-10-18T10:00:01.000Z', '2026-10-18T10:00:02.000Z'],
    ['untrusted', '2026-10-18T10:00:03.000Z', '2026-10-18T10:00:02.000Z'],
  ]) {
    test(`live ${label} OPEN blocks unsupported duration ${durationSeconds} without mutation`, async () => {
      const fixture = await tempDb();
      const expectationId = `unsupported-duration-${durationSeconds}-${label}`;
      await seedLegacyCandidate(fixture.db, { expectationId, durationSeconds, observedOpenAt: null });
      const beforeRow = await fixture.db.get('SELECT * FROM valve_actuation_expectations WHERE expectation_id=?', [expectationId]);
      const beforeState = await fixture.db.get('SELECT current_state, updated_at FROM devices WHERE deveui=?', [EUI]);
      const result = await observe(fixture.db, 'OPEN', reportAt, checkedAt);
      assert.equal(result.kind, 'blocked');
      assert.equal(result.reason, 'unsupported_legacy_recovery');
      assert.deepEqual({ ...(await fixture.db.get('SELECT * FROM valve_actuation_expectations WHERE expectation_id=?', [expectationId])) }, { ...beforeRow });
      assert.deepEqual({ ...(await fixture.db.get('SELECT current_state, updated_at FROM devices WHERE deveui=?', [EUI])) }, { ...beforeState });
      const control = JSON.parse((await fixture.db.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', [EUI])).conditional_control_json);
      assert.equal(control.observation.physical_run_id, undefined);
      assert.equal(control.incident, undefined);
      assert.equal((await fixture.db.all('SELECT id FROM irrigation_events')).length, 0);
      fixture.cleanup();
    });
  }
}

for (const durationSeconds of [0, 1.5]) {
  for (const [label, reportAt, checkedAt] of [
    ['trusted', '2026-10-18T10:00:01.000Z', '2026-10-18T10:00:02.000Z'],
    ['untrusted', '2026-10-18T10:00:03.000Z', '2026-10-18T10:00:02.000Z'],
  ]) {
    test(`live ${label} OPEN blocks supported plus duration ${durationSeconds} legacy rows`, async () => {
      const fixture = await tempDb();
      await seedLegacyCandidate(fixture.db, { expectationId: `supported-competing-${durationSeconds}-${label}`, observedOpenAt: null });
      await seedLegacyCandidate(fixture.db, { expectationId: `unsupported-competing-${durationSeconds}-${label}`, durationSeconds, observedOpenAt: null });
      const before = await fixture.db.all('SELECT expectation_id, commanded_duration_seconds, transport_json FROM valve_actuation_expectations WHERE expectation_id LIKE ?', [`%-competing-${durationSeconds}-${label}`]);
      const result = await observe(fixture.db, 'OPEN', reportAt, checkedAt);
      assert.equal(result.kind, 'blocked');
      assert.equal(result.reason, 'ambiguous_legacy_recovery');
      const after = await fixture.db.all('SELECT expectation_id, commanded_duration_seconds, transport_json FROM valve_actuation_expectations WHERE expectation_id LIKE ?', [`%-competing-${durationSeconds}-${label}`]);
      assert.deepEqual(after.map((row) => ({ ...row })), before.map((row) => ({ ...row })));
      assert.equal((await fixture.db.all('SELECT id FROM irrigation_events')).length, 0);
      fixture.cleanup();
    });
  }
}

for (const [label, supportedFlags] of [
  ['two-supported', [true, true]],
  ['supported-and-unsupported', [true, false]],
]) {
  test(`recovery blocks ${label} legacy identity ambiguity without mutation`, async () => {
    const fixture = await tempDb();
    await seedLegacyCandidate(fixture.db, { expectationId: `${label}-old`, supported: supportedFlags[0] });
    await seedLegacyCandidate(fixture.db, { expectationId: `${label}-new`, supported: supportedFlags[1] });
    const before = await fixture.db.all('SELECT expectation_id, commanded_at, expected_close_at, transport_json FROM valve_actuation_expectations WHERE expectation_id LIKE ?', [`${label}-%`]);
    const result = await workers.recoverValveObservation({ db: fixture.db, deviceEui: EUI, now: new Date('2026-10-18T10:02:00.000Z') });
    assert.equal(result.reason, 'ambiguous_legacy_recovery');
    assert.equal(result.physical_run_id, null);
    const after = await fixture.db.all('SELECT expectation_id, commanded_at, expected_close_at, transport_json FROM valve_actuation_expectations WHERE expectation_id LIKE ?', [`${label}-%`]);
    assert.deepEqual(after.map((row) => ({ ...row })), before.map((row) => ({ ...row })));
    fixture.cleanup();
  });
}

test('service_action completion preserves its category and does not create an irrigation event', async () => {
  const fixture = await tempDb();
  await assignZone(fixture.db);
  await seedPhysicalRun(fixture.db, { expectationId: 'physical-service-5b2', trigger: 'service_action' });
  await observe(fixture.db, 'OPEN', '2026-10-18T10:00:01.000Z', '2026-10-18T10:00:02.000Z');
  await observe(fixture.db, 'CLOSED', '2026-10-18T10:00:20.000Z', '2026-10-18T10:00:21.000Z');
  assert.equal((await fixture.db.all('SELECT id FROM irrigation_events WHERE valve_deveui=?', [EUI])).length, 0);
  assert.equal((await fixture.db.get('SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id=?', ['physical-service-5b2'])).reconciliation_state, 'OBSERVED_COMPLETE');
  fixture.cleanup();
});

test('reconciliation recovers immutable command timeout and ignores generic current_state', async () => {
  const fixture = await tempDb();
  await linkCloud(fixture.db);
  await seedPhysicalRun(fixture.db, { expectationId: 'command-timeout-5b2', commandId: 'command-5b2', state: 'PENDING_OBSERVATION', futureEffectEnd: '2026-10-18T09:00:00.000Z' });
  const result = await workers.runReconciliationTick({ db: fixture.db, now: new Date('2026-10-18T10:00:00.000Z'), warn: () => {} });
  assert.equal(result.reconciled, 1);
  assert.equal(result.advanced, 1);
  assert.equal((await fixture.db.get('SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id=?', ['command-timeout-5b2'])).reconciliation_state, 'STALE_NO_OBSERVATION');
  assert.equal((await fixture.db.all("SELECT * FROM sync_outbox WHERE op='VALVE_ACTUATION_ARCHIVED'")).length, 1);

  const legacy = await tempDb();
  await legacy.db.run("UPDATE devices SET current_state='OPEN', updated_at='2026-10-18T10:00:00.000Z' WHERE deveui=?", [EUI]);
  await seedPhysicalRun(legacy.db, { expectationId: 'legacy-current-state-5b2', trigger: 'unexplained' });
  const recovery = await workers.runReconciliationTick({ db: legacy.db, now: new Date('2026-10-18T10:00:00.000Z'), warn: () => {} });
  assert.equal(recovery.advanced, 0);
  legacy.cleanup();
  fixture.cleanup();
});
