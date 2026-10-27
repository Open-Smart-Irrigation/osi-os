#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDb } = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/test-helpers');
const store = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/store');
const push = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/push');
const workers = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/workers');
const dispatch = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/dispatch');
const cancel = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/cancel');

const EUI = '0016C001F1000001';
const NOW = new Date('2026-10-18T10:00:00.000Z');

function trustedRuntime(at) {
  const epoch = Date.parse('2026-10-18T10:00:00.000Z');
  const bootId = '5b1-test-boot';
  const now = Date.parse(at);
  return {
    runtimeNow: () => now,
    clockOptions: {
      fs: { readFileSync(file) {
        if (file === '/proc/sys/kernel/random/boot_id') return bootId + '\n';
        if (file === '/proc/uptime') return `${(now - epoch) / 1000} 0\n`;
        if (file === '/var/run/osi-irrigation-clock.json') return JSON.stringify({ boot_id: bootId, epoch_ms: epoch, uptime_ms: 0, stratum: 1 });
        throw Object.assign(new Error('missing fixture path'), { code: 'ENOENT' });
      } },
      bootPath: '/proc/sys/kernel/random/boot_id', uptimePath: '/proc/uptime', markerPath: '/var/run/osi-irrigation-clock.json',
    },
  };
}

async function conditionalFixture(label) {
  const fixture = await tempDb();
  const { db } = fixture;
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN2' });
  await store.insertSchedule(db, {
    schedule_uuid: '5b1-' + label, device_eui: EUI, kind: 'WEEKLY', weekdays_mask: 127,
    start_time: '08:00', duration_minutes: 5, timezone: 'UTC', enabled: 1,
  });
  await db.run("INSERT INTO irrigation_policies(policy_uuid,zone_uuid,condition_json,timezone) VALUES ('5b1-policy','5b1-zone','{}','UTC')");
  await db.run("UPDATE valve_schedules SET condition_policy_uuid='5b1-policy' WHERE schedule_uuid=?", ['5b1-' + label]);
  return { fixture, db };
}

function productionFacade(db) {
  const scope = (tx) => ({
    get: tx.get.bind(tx), all: tx.all.bind(tx),
    run: async (...args) => { await tx.run(...args); },
  });
  return {
    get: db.get.bind(db), all: db.all.bind(db), run: async (...args) => { await db.run(...args); },
    transaction: (callback) => db.transaction((tx) => callback(scope(tx))),
  };
}

async function insertOwnerOccurrence(db, scheduleUuid, owner) {
  const transport = JSON.parse(owner.transport_json);
  const snapshot = transport.effect_snapshot;
  await db.run(`INSERT INTO irrigation_occurrences
    (schedule_uuid,local_date,local_time,policy_uuid,zone_uuid,device_eui,due_at,expires_at,decision_evidence_json,
     command_id,state,reservation_start_at,reservation_end_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [scheduleUuid, '2026-10-18', '10:00', '5b1-policy', '5b1-zone', owner.device_eui,
    snapshot.anchor_at, snapshot.queue_expires_at, JSON.stringify({ effect_snapshot: snapshot, effect_bounds: {
      queue_expires_at: snapshot.queue_expires_at, latest_physical_start_at: snapshot.latest_physical_start_at,
      future_effect_end: snapshot.future_effect_end, exclusion_end_at: snapshot.exclusion_end_at,
    } }), owner.command_id, 'ATTEMPTED', snapshot.anchor_at, snapshot.future_effect_end,
    '2026-10-18T09:59:00.000Z', '2026-10-18T09:59:00.000Z']);
}

test('conditional readiness rejects an incomplete required push set before recovery work', async () => {
  const { fixture, db } = await conditionalFixture('missing-set');
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  await db.run('DELETE FROM valve_schedule_pushes WHERE push_id=?', [prepared.required_push_ids[0]]);
  const result = await push.conditionalReconciliationNeeded(db, EUI, { profileId: 'gen2', generationProfileId: 'gen2' });
  assert.equal(result, false);
  fixture.cleanup();
});

test('incident finalization rejects a pre-incident READY revision', async () => {
  const { fixture, db } = await conditionalFixture('retry-proof');
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  await db.run("UPDATE valve_schedule_pushes SET state='ACKED', ack_status='OK', acked_at=? WHERE device_eui=?", [NOW.toISOString(), EUI]);
  await store.writeConditionalControl(db, EUI, {
    ...(await store.conditionalControl(db, EUI)),
    readiness: { state: 'READY', revision: prepared.revision },
    incident: { incident_id: 'incident-1', physical_run_reference: 'run-1', ended: true, ended_at: NOW.toISOString(), reconciled_at: null, state: 'ENDED' },
  });
  await assert.rejects(
    () => db.transaction((tx) => push.finalizeConditionalIncidentTx(tx, EUI, {
      revision: prepared.revision, physical_run_reference: 'run-1', ended_at: NOW.toISOString(), reconciled_at: NOW.toISOString(),
    })),
    (error) => error && error.code === 'conditional_incident_retry_required'
  );
  fixture.cleanup();
});

test('explicit retry binds its fresh revision to the incident before finalization', async () => {
  const { fixture, db } = await conditionalFixture('retry-bind');
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  await store.writeConditionalControl(db, EUI, {
    ...(await store.conditionalControl(db, EUI)),
    incident: { incident_id: 'incident-2', physical_run_reference: 'run-2', ended: true, ended_at: NOW.toISOString(), reconciled_at: null, state: 'ENDED' },
  });
  const retry = await push.retryClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  const control = await store.conditionalControl(db, EUI);
  assert.equal(control.incident.retry_revision, retry.revision);
  fixture.cleanup();
});

test('observation composition records an unknown physical run once and closes only that link', async () => {
  const { fixture, db } = await conditionalFixture('observation');
  let rawPersisted = false;
  const result = await workers.recordValveObservation({
    db, deviceEui: EUI, observedState: 'OPEN', observedAt: '2026-10-18T10:00:00.000Z',
    runtimeContext: trustedRuntime('2026-10-18T10:00:01.000Z'),
    persistRawTx: async (tx, raw) => {
      rawPersisted = raw.observed_state === 'OPEN' && raw.device_eui === EUI;
      await tx.run('UPDATE devices SET target_state=? WHERE deveui=?', ['OPEN', EUI]);
    },
  });
  assert.equal(result.kind, 'synthetic');
  assert.equal(rawPersisted, true);
  assert.equal((await db.get('SELECT target_state FROM devices WHERE deveui=?', [EUI])).target_state, 'OPEN');
  assert.equal(await dispatch.hasBlockingObservation(db, EUI), true);
  const conflict = await dispatch.findValveConflictTx(db, EUI, 'new-command', Date.parse('2026-10-18T10:00:30.000Z'));
  assert.equal(conflict.expectation_id, result.physical_run_id);
  const cancelled = await cancel.cancelActuation({ db, deviceEui: EUI, expectationId: result.physical_run_id, flushQueue: async () => { throw new Error('must not flush report-only run'); } });
  assert.equal(cancelled.error, 'actuation_not_active');
  assert.equal((await db.get('SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id=?', [result.physical_run_id])).reconciliation_state, 'OBSERVED_RUNNING');
  const again = await workers.recordValveObservation({
    db, deviceEui: EUI, observedState: 'OPEN', observedAt: '2026-10-18T10:00:00.500Z',
    runtimeContext: trustedRuntime('2026-10-18T10:00:02.000Z'),
  });
  assert.equal(again.physical_run_id, result.physical_run_id);
  const closed = await workers.recordValveObservation({
    db, deviceEui: EUI, observedState: 'CLOSED', observedAt: '2026-10-18T10:01:00.000Z',
    runtimeContext: trustedRuntime('2026-10-18T10:01:01.000Z'),
  });
  assert.equal(closed.physical_run_id, result.physical_run_id);
  assert.equal((await db.all("SELECT expectation_id FROM valve_actuation_expectations WHERE trigger='unexplained' AND device_eui=?", [EUI])).length, 1);
  assert.equal(await dispatch.hasBlockingObservation(db, EUI), false);
  const incident = (await store.conditionalControl(db, EUI)).incident;
  assert.equal(incident.state, 'ENDED');
  assert.equal(incident.physical_run_reference, result.physical_run_id);
  fixture.cleanup();
});

test('daily accounting includes commandless report-only physical runs once with null duration', async () => {
  const { fixture, db } = await conditionalFixture('accounting');
  await workers.recordValveObservation({ db, deviceEui: EUI, observedState: 'OPEN', observedAt: '2026-10-18T10:00:00.000Z', runtimeContext: trustedRuntime('2026-10-18T10:00:01.000Z') });
  await workers.recordValveObservation({ db, deviceEui: EUI, observedState: 'CLOSED', observedAt: '2026-10-18T10:10:00.000Z', runtimeContext: trustedRuntime('2026-10-18T10:10:01.000Z') });
  const accounting = await dispatch.getDailyAccounting({ db, deviceEui: EUI, timezone: 'UTC' });
  assert.equal(accounting.runs.filter((run) => run.physical_run_id).length, 1);
  assert.equal(accounting.runs.find((run) => run.physical_run_id).duration_minutes, null);
  assert.deepEqual(accounting.days, {});
  assert.equal(accounting.unknown_intervals.length, 1);
  assert.equal(accounting.unknown_intervals[0].possible_end_at, '2026-10-18T10:10:00.000Z');
  assert.equal(accounting.unknown_intervals[0].possible_end_unbounded, false);
  const raw = await db.get('SELECT * FROM valve_actuation_expectations WHERE command_id IS NULL AND device_eui=?', [EUI]);
  assert.equal(raw.command_id, null);
  assert.equal(raw.commanded_duration_seconds, -1);
  assert.equal(raw.expected_close_at, '');
  assert.deepEqual(JSON.parse(raw.transport_json).physical_run, {
    version: 1, source: 'explicit_report', earliest_possible_start_at: null, latest_possible_end_at: '2026-10-18T10:10:00.000Z',
  });
  const projected = dispatch.projectObservationExpectation(raw);
  assert.equal(projected, null);
  fixture.cleanup();
});

test('observation links exactly one strictly valid attempted timed owner', async () => {
  const { fixture, db } = await conditionalFixture('owner');
  const command = { device_eui: EUI, command_id: '5b1-owner-command', action: 'OPEN_FOR_DURATION', duration_minutes: 5 };
  await dispatch.executeValveAttempt({
    db, deviceEui: EUI, command,
    frame: { fPort: 2, data: Buffer.from([0x41, 5]).toString('base64'), confirmed: false, encrypted: false, provenance: { source: 'local_encoder', encoder: 'strega-v1' } },
    transport: { async enqueueDownlink() { return { id: '5b1-owner-queue' }; } },
    now: '2026-10-18T10:00:00.000Z', trustedContext: trustedRuntime('2026-10-18T10:00:00.000Z'),
  });
  const report = await workers.recordValveObservation({ db, deviceEui: EUI, observedState: 'OPEN', observedAt: '2026-10-18T10:00:05.000Z', runtimeContext: trustedRuntime('2026-10-18T10:00:06.000Z') });
  assert.equal(report.kind, 'owner');
  assert.equal((await db.get('SELECT observed_open_at FROM valve_actuation_expectations WHERE command_id=?', [command.command_id])).observed_open_at, '2026-10-18T10:00:05.000Z');
  assert.equal((await db.all("SELECT expectation_id FROM valve_actuation_expectations WHERE command_id IS NULL AND device_eui=?", [EUI])).length, 0);
  fixture.cleanup();
});

test('a newer OPEN reuses the durable command owner link without rematching', async () => {
  const { fixture, db } = await conditionalFixture('repeat-owner');
  const command = { device_eui: EUI, command_id: '5b1-repeat-owner', action: 'OPEN_FOR_DURATION', duration_minutes: 5 };
  await dispatch.executeValveAttempt({ db, deviceEui: EUI, command,
    frame: { fPort: 2, data: Buffer.from([0x41, 5]).toString('base64'), confirmed: false, encrypted: false, provenance: { source: 'local_encoder', encoder: 'strega-v1' } },
    transport: { async enqueueDownlink() { return { id: 'repeat-owner-queue' }; } }, now: '2026-10-18T10:00:00.000Z', trustedContext: trustedRuntime('2026-10-18T10:00:00.000Z') });
  const first = await workers.recordValveObservation({ db, deviceEui: EUI, observedState: 'OPEN', observedAt: '2026-10-18T10:00:05.000Z', runtimeContext: trustedRuntime('2026-10-18T10:00:06.000Z') });
  const owner = await db.get('SELECT transport_json FROM valve_actuation_expectations WHERE command_id=?', [command.command_id]);
  const snapshot = JSON.parse(owner.transport_json).effect_snapshot;
  const repeatAt = new Date(Date.parse(snapshot.future_effect_end) + 1000).toISOString();
  const runtimeAt = new Date(Date.parse(repeatAt) + 1000).toISOString();
  assert.ok(Date.parse(repeatAt) > Date.parse(snapshot.future_effect_end));
  const second = await workers.recordValveObservation({ db, deviceEui: EUI, observedState: 'OPEN', observedAt: repeatAt, runtimeContext: trustedRuntime(runtimeAt) });
  assert.equal(first.kind, 'owner');
  assert.equal(second.kind, 'linked');
  assert.equal(second.physical_run_id, first.physical_run_id);
  assert.equal((await store.conditionalControl(db, EUI)).incident, undefined);
  assert.equal((await db.all('SELECT expectation_id FROM valve_actuation_expectations WHERE command_id IS NULL AND device_eui=?', [EUI])).length, 0);
  fixture.cleanup();
});

test('a trusted OPEN after an untrusted OPEN keeps the synthetic physical run', async () => {
  const { fixture, db } = await conditionalFixture('untrusted-link');
  const command = { device_eui: EUI, command_id: '5b1-untrusted-owner', action: 'OPEN_FOR_DURATION', duration_minutes: 5 };
  await dispatch.executeValveAttempt({ db, deviceEui: EUI, command,
    frame: { fPort: 2, data: Buffer.from([0x41, 5]).toString('base64'), confirmed: false, encrypted: false, provenance: { source: 'local_encoder', encoder: 'strega-v1' } },
    transport: { async enqueueDownlink() { return { id: 'untrusted-owner-queue' }; } }, now: '2026-10-18T10:00:00.000Z', trustedContext: trustedRuntime('2026-10-18T10:00:00.000Z') });
  const first = await workers.recordValveObservation({ db, deviceEui: EUI, observedState: 'OPEN', observedAt: '2026-10-18T10:02:00.000Z', runtimeContext: trustedRuntime('2026-10-18T10:01:00.000Z') });
  const second = await workers.recordValveObservation({ db, deviceEui: EUI, observedState: 'OPEN', observedAt: '2026-10-18T10:00:30.000Z', runtimeContext: trustedRuntime('2026-10-18T10:01:00.000Z') });
  assert.equal(first.kind, 'untrusted');
  assert.equal(second.kind, 'linked');
  assert.equal(second.physical_run_id, first.physical_run_id);
  assert.equal((await db.get('SELECT observed_open_at FROM valve_actuation_expectations WHERE command_id=?', [command.command_id])).observed_open_at, null);
  assert.equal((await db.all("SELECT expectation_id FROM valve_actuation_expectations WHERE command_id IS NULL AND device_eui=?", [EUI])).length, 1);
  fixture.cleanup();
});

test('the sender flushes and enqueues zero rows when one or all required rows are missing', async () => {
  const { fixture, db } = await conditionalFixture('missing-sender');
  const prepared = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN1', now: NOW });
  let flushes = 0; let enqueues = 0;
  const transport = { async getDeviceQueue() { return []; }, async flushDeviceQueue() { flushes += 1; }, async enqueueDownlink() { enqueues += 1; return { id: 'must-not-send' }; } };
  await db.run('DELETE FROM valve_schedule_pushes WHERE push_id=?', [prepared.required_push_ids[0]]);
  const oneMissing = await push.sendPreparedRevision({ db, deviceEui: EUI, revision: prepared.revision, transport, now: NOW });
  assert.equal(oneMissing.invalidRequiredSet, true);
  assert.equal(flushes, 0); assert.equal(enqueues, 0);
  await db.run('DELETE FROM valve_schedule_pushes WHERE device_eui=?', [EUI]);
  const allMissing = await push.sendPreparedRevision({ db, deviceEui: EUI, revision: prepared.revision, transport, now: NOW });
  assert.equal(allMissing.invalidRequiredSet, true);
  assert.equal(flushes, 0); assert.equal(enqueues, 0);
  fixture.cleanup();
});

test('strict persisted occurrence bounds reject an owner whose immutable horizon was edited', async () => {
  const { fixture, db } = await conditionalFixture('bounds-relation');
  const command = { device_eui: EUI, command_id: '5b1-bounds-owner', action: 'OPEN_FOR_DURATION', duration_minutes: 5 };
  await dispatch.executeValveAttempt({ db, deviceEui: EUI, command,
    frame: { fPort: 2, data: Buffer.from([0x41, 5]).toString('base64'), confirmed: false, encrypted: false, provenance: { source: 'local_encoder', encoder: 'strega-v1' } },
    transport: { async enqueueDownlink() { return { id: 'bounds-owner-queue' }; } }, now: '2026-10-18T10:00:00.000Z', trustedContext: trustedRuntime('2026-10-18T10:00:00.000Z') });
  await insertOwnerOccurrence(db, '5b1-bounds-relation', await db.get('SELECT * FROM valve_actuation_expectations WHERE command_id=?', [command.command_id]));
  await db.run("UPDATE irrigation_occurrences SET expires_at='2026-10-18T10:20:00.000Z' WHERE command_id=?", [command.command_id]);
  const result = await workers.recordValveObservation({ db, deviceEui: EUI, observedState: 'OPEN', observedAt: '2026-10-18T10:00:05.000Z', runtimeContext: trustedRuntime('2026-10-18T10:00:06.000Z') });
  assert.equal(result.kind, 'synthetic');
  assert.equal((await db.get('SELECT observed_open_at FROM valve_actuation_expectations WHERE command_id=?', [command.command_id])).observed_open_at, null);
  assert.equal((await db.all('SELECT expectation_id FROM valve_actuation_expectations WHERE command_id IS NULL AND device_eui=?', [EUI])).length, 1);
  fixture.cleanup();
});

test('linked command CLOSED closes its occurrence in the same transaction', async () => {
  const { fixture, db } = await conditionalFixture('occurrence-close');
  const command = { device_eui: EUI, command_id: '5b1-occurrence-close', action: 'OPEN_FOR_DURATION', duration_minutes: 5 };
  await dispatch.executeValveAttempt({ db, deviceEui: EUI, command,
    frame: { fPort: 2, data: Buffer.from([0x41, 5]).toString('base64'), confirmed: false, encrypted: false, provenance: { source: 'local_encoder', encoder: 'strega-v1' } },
    transport: { async enqueueDownlink() { return { id: 'occurrence-close-queue' }; } }, now: '2026-10-18T10:00:00.000Z', trustedContext: trustedRuntime('2026-10-18T10:00:00.000Z') });
  const owner = await db.get('SELECT * FROM valve_actuation_expectations WHERE command_id=?', [command.command_id]);
  await insertOwnerOccurrence(db, '5b1-occurrence-close', owner);
  const opened = await workers.recordValveObservation({ db, deviceEui: EUI, observedState: 'OPEN', observedAt: '2026-10-18T10:00:05.000Z', runtimeContext: trustedRuntime('2026-10-18T10:00:06.000Z') });
  await workers.recordValveObservation({ db, deviceEui: EUI, observedState: 'CLOSED', observedAt: '2026-10-18T10:01:00.000Z', runtimeContext: trustedRuntime('2026-10-18T10:01:01.000Z') });
  const occurrence = await db.get('SELECT observed_open_at, observed_close_at FROM irrigation_occurrences WHERE command_id=?', [command.command_id]);
  assert.equal(occurrence.observed_open_at, '2026-10-18T10:00:05.000Z');
  assert.equal(occurrence.observed_close_at, '2026-10-18T10:01:00.000Z');
  assert.equal((await db.get('SELECT observed_close_at FROM valve_actuation_expectations WHERE expectation_id=?', [opened.physical_run_id])).observed_close_at, '2026-10-18T10:01:00.000Z');
  fixture.cleanup();
});

test('incident finalization handles ACK-before-CLOSED, CLOSED-before-ACK, and a later reset', async () => {
  const first = await conditionalFixture('incident-ack-first');
  const opened = await workers.recordValveObservation({ db: first.db, deviceEui: EUI, observedState: 'OPEN', observedAt: '2026-10-18T10:00:00.000Z', runtimeContext: trustedRuntime('2026-10-18T10:00:01.000Z') });
  await push.prepareClearRevision({ db: first.db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  const retry = await push.retryClearRevision({ db: first.db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  await first.db.run("UPDATE valve_schedule_pushes SET state='ACKED', ack_status='OK', acked_at=? WHERE device_eui=?", [NOW.toISOString(), EUI]);
  await workers.recordValveObservation({ db: first.db, deviceEui: EUI, observedState: 'CLOSED', observedAt: '2026-10-18T10:01:00.000Z', runtimeContext: trustedRuntime('2026-10-18T10:01:01.000Z') });
  assert.equal((await store.conditionalControl(first.db, EUI)).incident.state, 'RECONCILED');
  assert.equal(retry.revision, (await store.conditionalControl(first.db, EUI)).incident.retry_revision);
  const secondRun = await workers.recordValveObservation({ db: first.db, deviceEui: EUI, observedState: 'OPEN', observedAt: '2026-10-18T10:02:00.000Z', runtimeContext: trustedRuntime('2026-10-18T10:02:01.000Z') });
  const secondIncident = (await store.conditionalControl(first.db, EUI)).incident;
  assert.notEqual(secondIncident.incident_id, opened.incident && opened.incident.incident_id);
  assert.equal(secondIncident.retry_revision, null);
  assert.notEqual(secondRun.physical_run_id, opened.physical_run_id);
  first.fixture.cleanup();

  const second = await conditionalFixture('incident-close-first');
  const closeFirst = await workers.recordValveObservation({ db: second.db, deviceEui: EUI, observedState: 'OPEN', observedAt: '2026-10-18T10:00:00.000Z', runtimeContext: trustedRuntime('2026-10-18T10:00:01.000Z') });
  await push.prepareClearRevision({ db: second.db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  const closeRetry = await push.retryClearRevision({ db: second.db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  await workers.recordValveObservation({ db: second.db, deviceEui: EUI, observedState: 'CLOSED', observedAt: '2026-10-18T10:01:00.000Z', runtimeContext: trustedRuntime('2026-10-18T10:01:01.000Z') });
  assert.equal((await store.conditionalControl(second.db, EUI)).incident.state, 'ENDED');
  await second.db.run("UPDATE valve_schedule_pushes SET state='ACKED', ack_status='OK', acked_at=? WHERE device_eui=?", [NOW.toISOString(), EUI]);
  await second.db.transaction((tx) => push.finalizeConditionalIncidentTx(tx, EUI, { revision: closeRetry.revision, physical_run_reference: closeFirst.physical_run_id, reconciled_at: '2026-10-18T10:02:00.000Z' }));
  assert.equal((await store.conditionalControl(second.db, EUI)).incident.state, 'RECONCILED');
  second.fixture.cleanup();
});

test('an ordinary resend replacing an incident-bound retry cannot finalize the incident', async () => {
  const { fixture, db } = await conditionalFixture('retry-replaced');
  const opened = await workers.recordValveObservation({ db, deviceEui: EUI, observedState: 'OPEN', observedAt: '2026-10-18T10:00:00.000Z', runtimeContext: trustedRuntime('2026-10-18T10:00:01.000Z') });
  await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  const retry = await push.retryClearRevision({ db, deviceEui: EUI, generation: 'GEN2', now: NOW });
  await workers.recordValveObservation({ db, deviceEui: EUI, observedState: 'CLOSED', observedAt: '2026-10-18T10:01:00.000Z', runtimeContext: trustedRuntime('2026-10-18T10:01:01.000Z') });
  const ordinary = await push.prepareClearRevision({ db, deviceEui: EUI, generation: 'GEN2', reason: 'resend', now: NOW });
  await db.run("UPDATE valve_schedule_pushes SET state='ACKED', ack_status='OK', acked_at=? WHERE device_eui=?", [NOW.toISOString(), EUI]);
  await assert.rejects(() => db.transaction((tx) => push.finalizeConditionalIncidentTx(tx, EUI, { revision: ordinary.revision, physical_run_reference: opened.physical_run_id, reconciled_at: '2026-10-18T10:02:00.000Z' })), (error) => error.code === 'conditional_incident_retry_required');
  const incident = (await store.conditionalControl(db, EUI)).incident;
  assert.equal(incident.state, 'ENDED');
  assert.equal(incident.retry_revision, retry.revision);
  fixture.cleanup();
});

test('an ordinary fixed compile sends the current plan once after obsolete transition work is superseded', async () => {
  const fixture = await tempDb();
  const { db } = fixture;
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN1' });
  await store.insertSchedule(db, { schedule_uuid: '5b1-fixed-current', device_eui: EUI, kind: 'WEEKLY', weekdays_mask: 127, start_time: '08:00', duration_minutes: 5, timezone: 'UTC', enabled: 1 });
  await workers.handleUplink({ db, deviceEui: EUI, decoded: { Ack_Port: 25, Ack_Value: 1 }, receivedAt: '2026-10-18T10:00:00Z', warn: () => {} });
  await push.prepareFixedGenerationTransition({ db, deviceEui: EUI, now: NOW });
  await db.run("UPDATE valve_schedules SET timezone='Europe/Zurich' WHERE schedule_uuid='5b1-fixed-current'");
  let flushes = 0; let enqueues = 0;
  const transport = { async getDeviceQueue() { return []; }, async flushDeviceQueue() { flushes += 1; }, async enqueueDownlink() { enqueues += 1; return { id: 'current-fixed-' + enqueues }; } };
  const superseded = await push.reconcileGenerationTransition({ db, deviceEui: EUI, now: NOW, transport });
  assert.equal(superseded.superseded, true);
  assert.equal(flushes, 0); assert.equal(enqueues, 0);
  const current = await push.compileAndQueue({ db, deviceEui: EUI, force: true, now: NOW, transport });
  assert.equal((await store.conditionalControl(db, EUI)).fixed_generation_transition.state, 'SUPERSEDED');
  assert.ok(current.rows.length > 0);
  assert.equal(flushes, 1);
  // Design C (CMD-04 PR0): the compile writes the snapshot; the valve tick sends it once, after
  // the debounce window.
  assert.equal(enqueues, 0);
  await push.emitPendingSnapshots({ db, now: new Date(NOW.getTime() + push.SNAPSHOT_DEBOUNCE_MS), transport, warn: () => {} });
  assert.equal(enqueues, current.rows.length);
  fixture.cleanup();
});

test('production-shaped transaction scope rolls back raw persistence on observation failure', async () => {
  const { fixture, db } = await conditionalFixture('rollback-facade');
  const facade = productionFacade(db);
  await assert.rejects(() => workers.recordValveObservation({ db: facade, deviceEui: EUI, observedState: 'INVALID', observedAt: '2026-10-18T10:00:00.000Z', runtimeContext: trustedRuntime('2026-10-18T10:00:01.000Z'), persistRawTx: async (tx) => { await tx.run('UPDATE devices SET target_state=? WHERE deveui=?', ['OPEN', EUI]); } }), (error) => error.code === 'observation_invalid');
  assert.equal((await db.get('SELECT target_state FROM devices WHERE deveui=?', [EUI])).target_state, null);
  fixture.cleanup();
});

test('writer wait rechecks the runtime clock and invalidates a formerly trusted observation', async () => {
  const { fixture, db } = await conditionalFixture('writer-clock');
  let release;
  let entered;
  const held = new Promise((resolve) => { entered = resolve; });
  const blocker = dispatch.withValveWriter(EUI, async () => { entered(); await new Promise((resolve) => { release = resolve; }); });
  await held;
  let clockTrusted = true;
  const runtimeContext = { runtimeNow: () => Date.parse('2026-10-18T10:00:01.000Z'), clockOptions: { fs: { readFileSync(file) {
    if (!clockTrusted) throw Object.assign(new Error('clock changed'), { code: 'ENOENT' });
    if (file === '/proc/sys/kernel/random/boot_id') return 'writer-boot\n';
    if (file === '/proc/uptime') return '1 0\n';
    if (file === '/var/run/osi-irrigation-clock.json') return JSON.stringify({ boot_id: 'writer-boot', epoch_ms: Date.parse('2026-10-18T10:00:00.000Z'), uptime_ms: 0, stratum: 1 });
    throw Object.assign(new Error('missing fixture path'), { code: 'ENOENT' });
  } }, bootPath: '/proc/sys/kernel/random/boot_id', uptimePath: '/proc/uptime', markerPath: '/var/run/osi-irrigation-clock.json' } };
  const waiting = workers.recordValveObservation({ db, deviceEui: EUI, observedState: 'OPEN', observedAt: '2026-10-18T10:00:00.000Z', runtimeContext });
  clockTrusted = false;
  release();
  await blocker;
  const result = await waiting;
  assert.equal(result.kind, 'untrusted');
  assert.equal((await store.conditionalControl(db, EUI)).observation.last_reported_at, undefined);
  fixture.cleanup();
});

test('future report fails closed, retains audit, and a later trusted report does not regress the watermark', async () => {
  const { fixture, db } = await conditionalFixture('future');
  const future = await workers.recordValveObservation({ db, deviceEui: EUI, observedState: 'OPEN', observedAt: '2026-10-18T10:02:00.000Z', runtimeContext: trustedRuntime('2026-10-18T10:01:00.000Z') });
  assert.equal(future.kind, 'untrusted');
  const later = await workers.recordValveObservation({ db, deviceEui: EUI, observedState: 'OPEN', observedAt: '2026-10-18T10:00:30.000Z', runtimeContext: trustedRuntime('2026-10-18T10:01:00.000Z') });
  assert.ok(['synthetic', 'ambiguous', 'linked'].includes(later.kind));
  const control = await store.conditionalControl(db, EUI);
  assert.equal(control.observation.last_reported_at, '2026-10-18T10:00:30.000Z');
  assert.equal(control.observation.untrusted_reports.length, 1);
  fixture.cleanup();
});

test('malformed report time keeps raw audit and an unbounded report-only run', async () => {
  const { fixture, db } = await conditionalFixture('malformed-time');
  const malformed = await workers.recordValveObservation({ db, deviceEui: EUI, observedState: 'OPEN', observedAt: 'not-a-time', runtimeContext: trustedRuntime('2026-10-18T10:01:00.000Z') });
  assert.equal(malformed.kind, 'untrusted');
  const row = await db.get('SELECT * FROM valve_actuation_expectations WHERE expectation_id=?', [malformed.physical_run_id]);
  assert.equal(row.commanded_at, '2026-10-18T10:01:00.000Z');
  assert.equal(row.observed_open_at, null);
  const marker = JSON.parse(row.transport_json).physical_run;
  assert.equal(marker.earliest_possible_start_at, null);
  assert.equal(marker.latest_possible_end_at, null);
  assert.equal((await store.conditionalControl(db, EUI)).observation.untrusted_reports.length, 1);
  fixture.cleanup();
});

test('fixed transition source snapshot is superseded before recovery I/O after a timezone edit', async () => {
  const fixture = await tempDb();
  const { db } = fixture;
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN1' });
  await store.insertSchedule(db, { schedule_uuid: '5b1-fixed', device_eui: EUI, kind: 'WEEKLY', weekdays_mask: 127, start_time: '08:00', duration_minutes: 5, timezone: 'UTC', enabled: 1 });
  await workers.handleUplink({ db, deviceEui: EUI, decoded: { Ack_Port: 25, Ack_Value: 1 }, receivedAt: '2026-10-18T10:00:00Z', warn: () => {} });
  const prepared = await push.prepareFixedGenerationTransition({ db, deviceEui: EUI, now: NOW });
  assert.equal(prepared.source_schedule_snapshot.clock_timezone, 'UTC');
  assert.equal(prepared.source_schedule_snapshot.schedules[0].timezone, 'UTC');
  await db.run('UPDATE valve_schedule_pushes SET transport_json=? WHERE push_id=?', [JSON.stringify({ phase: 'ATTEMPTED', attempted_at: NOW.toISOString() }), prepared.required_push_ids[0]]);
  await db.run("UPDATE valve_schedules SET timezone='Europe/Zurich' WHERE schedule_uuid='5b1-fixed'");
  let io = 0;
  const result = await push.reconcileGenerationTransition({ db, deviceEui: EUI, now: NOW, transport: {
    async getDeviceQueue() { io += 1; return []; }, async flushDeviceQueue() { io += 1; }, async enqueueDownlink() { io += 1; return { id: 'obsolete' }; },
  } });
  assert.equal(result.superseded, true);
  assert.equal(io, 0);
  const transition = (await store.conditionalControl(db, EUI)).fixed_generation_transition;
  assert.equal(transition.state, 'SUPERSEDED');
  assert.equal(transition.transition_id, prepared.transition_id);
  assert.equal(await push.markGenerationTransitionApplied(db, EUI, { generation: 'GEN2', transitionId: prepared.transition_id, planRevision: prepared.plan_revision, requiredPushIds: prepared.required_push_ids, now: NOW }), false);
  fixture.cleanup();
});

test('fixed snapshot captures the resolved timezone for disabled and zero-schedule sources', async () => {
  const fixture = await tempDb();
  const { db } = fixture;
  await store.upsertSettings(db, EUI, { strega_generation: 'GEN1' });
  await store.insertSchedule(db, { schedule_uuid: '5b1-fixed-disabled', device_eui: EUI, kind: 'WEEKLY', weekdays_mask: 127, start_time: '08:00', duration_minutes: 5, timezone: 'UTC', enabled: 0 });
  await workers.handleUplink({ db, deviceEui: EUI, decoded: { Ack_Port: 25, Ack_Value: 1 }, receivedAt: '2026-10-18T10:00:00Z', warn: () => {} });
  const prepared = await push.prepareFixedGenerationTransition({ db, deviceEui: EUI, now: NOW, timeZoneFallback: 'Europe/Zurich' });
  assert.deepEqual(prepared.source_schedule_snapshot, { schedules: [], clock_timezone: 'UTC' });
  await db.run("UPDATE valve_schedules SET timezone='Europe/Zurich' WHERE schedule_uuid='5b1-fixed-disabled'");
  let io = 0;
  const superseded = await push.reconcileGenerationTransition({ db, deviceEui: EUI, now: NOW, timeZoneFallback: 'Europe/Zurich', transport: {
    async getDeviceQueue() { io += 1; return []; }, async flushDeviceQueue() { io += 1; }, async enqueueDownlink() { io += 1; return { id: 'stale-disabled' }; },
  } });
  assert.equal(superseded.superseded, true); assert.equal(io, 0);
  fixture.cleanup();

  const empty = await tempDb();
  await store.upsertSettings(empty.db, EUI, { strega_generation: 'GEN1' });
  await workers.handleUplink({ db: empty.db, deviceEui: EUI, decoded: { Ack_Port: 25, Ack_Value: 1 }, receivedAt: '2026-10-18T10:00:00Z', warn: () => {} });
  const noSchedule = await push.prepareFixedGenerationTransition({ db: empty.db, deviceEui: EUI, now: NOW, timeZoneFallback: 'Europe/Zurich' });
  assert.deepEqual(noSchedule.source_schedule_snapshot, { schedules: [], clock_timezone: 'Europe/Zurich' });
  empty.cleanup();
});

test('observation recovery refuses to infer a transition from legacy current_state alone', async () => {
  const { fixture, db } = await conditionalFixture('restart');
  await db.run("UPDATE devices SET current_state='OPEN', updated_at='2026-10-18T10:00:00.000Z' WHERE deveui=?", [EUI]);
  const recovered = await workers.recoverValveObservation({ db, deviceEui: EUI, now: NOW });
  assert.equal(recovered.uncertain, true);
  assert.equal(recovered.physical_run_id, null);
  assert.equal((await db.all('SELECT expectation_id FROM valve_actuation_expectations WHERE device_eui=?', [EUI])).length, 0);
  fixture.cleanup();
});
