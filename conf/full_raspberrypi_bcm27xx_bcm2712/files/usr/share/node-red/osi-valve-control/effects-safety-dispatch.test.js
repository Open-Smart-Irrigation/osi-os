'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { facade } = require('./test-helpers');
const dispatch = require('./dispatch');
const effects = require('./effects');

const SEED = path.resolve(__dirname, '../../db/farming.db');
const EUI = '0016C001F1000001';
const FRAME = { fPort: 2, data: Buffer.from([0x41, 1]).toString('base64'), confirmed: false, encrypted: false,
  provenance: { source: 'local_encoder', encoder: 'strega-v1' } };
const FRAME_FIVE_MINUTES = { fPort: 2, data: Buffer.from([0x41, 5]).toString('base64'), confirmed: false, encrypted: false,
  provenance: { source: 'local_encoder', encoder: 'strega-v1' } };

function releaseClock(at, suffix) {
  const markerAt = '2026-10-18T09:00:00.000Z';
  return { fs: { readFileSync(path) { if (path.includes('rejection') || path.includes('fallback')) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } throw new Error('unexpected read'); } },
    bootId: `boot-${suffix}`, uptime: 50000 + Date.parse(at) - Date.parse(markerAt), now: Date.parse(at),
    marker: { boot_id: `boot-${suffix}`, epoch_ms: Date.parse(markerAt), uptime_ms: 50000, stratum: 2 },
    markerPath: `/tmp/effects-dispatch-${suffix}-marker`, rejectionPath: `/tmp/effects-dispatch-${suffix}-rejection`, fallbackPath: `/tmp/effects-dispatch-${suffix}-fallback` };
}

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'effects-safety-'));
  const file = path.join(dir, 'farming.db');
  fs.copyFileSync(SEED, file);
  const raw = new DatabaseSync(file);
  const db = facade(raw);
  await db.run("INSERT INTO users(id, username, password_hash, created_at) VALUES (1,'effects-safety','x',datetime('now'))");
  await db.run("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES (?,'Valve A','STREGA_VALVE',1,datetime('now'),datetime('now'))", [EUI]);
  return { db, cleanup: () => { try { raw.close(); } catch (_) {} fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('capture derives the immutable snapshot from the owner frame and rejects caller snapshots', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const reservation = await dispatch.reserveValveCommand({ db: f.db, command: {
    device_eui: EUI, command_id: 'effects-owner', action: 'OPEN_FOR_DURATION', duration_minutes: 1,
    commanded_at: '2026-10-18T10:00:00.000Z', timezone: 'UTC',
  }, now: '2026-10-18T10:00:00.000Z' });
  const forged = effects.buildEffectSnapshot({ frame: FRAME, anchor_at: '2026-10-18T12:00:00.000Z', device_eui: EUI });
  await assert.rejects(dispatch.captureEffectSnapshot({ db: f.db, deviceEui: EUI,
    owner: { type: 'expectation', id: reservation.expectation.expectation_id }, frame: FRAME, snapshot: forged }),
  (error) => error.code === 'effect_snapshot_forbidden');
});

test('public capture binds the reservation anchor and conflict remains fail closed', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const reservation = await dispatch.reserveValveCommand({ db: f.db, command: {
    device_eui: EUI, command_id: 'capture-owner', action: 'OPEN_FOR_DURATION', duration_minutes: 1,
    commanded_at: '2026-10-18T23:45:00.000Z', timezone: 'UTC',
  }, now: '2026-10-18T23:45:00.000Z' });
  const captured = await dispatch.captureEffectSnapshot({ db: f.db, deviceEui: EUI,
    owner: { type: 'expectation', id: reservation.expectation.expectation_id }, frame: FRAME_FIVE_MINUTES,
    now: '2026-10-18T23:59:59.000Z' });
  assert.equal(captured.anchor_at, '2026-10-18T23:45:00.000Z');
  const stored = JSON.parse((await f.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id=?', [reservation.expectation.expectation_id])).transport_json);
  assert.equal(stored.effect_snapshot.anchor_at, captured.anchor_at);
  await assert.rejects(dispatch.reserveValveCommand({ db: f.db, command: {
    device_eui: EUI, command_id: 'capture-conflict', action: 'OPEN_FOR_DURATION', duration_minutes: 1,
    commanded_at: '2026-10-19T00:00:00.000Z', timezone: 'UTC',
  }, now: '2026-10-19T00:00:00.000Z' }), (error) => error.code === 'valve_busy');
});

test('conditional capture persists qualification, queue cutoff, and physical deadline together', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, requested_duration_minutes, reservation_start_at, reservation_end_at, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    'qualified-capture', '2026-10-18', '10:00', EUI, '2026-10-18T10:00:00.000Z', 'PENDING', '2026-10-18T10:30:55.000Z', 5, '2026-10-18T10:00:00.000Z', '2026-10-18T10:36:00.000Z', 5,
  ]);
  const qualificationProvider = () => ({ qualified: true, identity: 'fixture/gen1', margin_seconds: 5 });
  const reservation = await dispatch.reserveValveCommand({ db: f.db, effectContext: { qualificationProvider }, command: {
    device_eui: EUI, command_id: 'qualified-capture', action: 'OPEN_FOR_DURATION_CONDITIONAL', duration_minutes: 5,
    occurrence: { schedule_uuid: 'qualified-capture', local_date: '2026-10-18', local_time: '10:00' }, timezone: 'UTC',
  }, now: '2026-10-18T10:00:00.000Z' });
  const captured = await dispatch.captureEffectSnapshot({ db: f.db, deviceEui: EUI,
    owner: { type: 'expectation', id: reservation.expectation.expectation_id }, frame: FRAME_FIVE_MINUTES,
    qualificationProvider, now: '2026-10-18T10:01:00.000Z' });
  assert.equal(captured.queue_expires_at, '2026-10-18T10:30:55.000Z');
  assert.equal(captured.latest_physical_start_at, '2026-10-18T10:31:00.000Z');
  assert.equal(captured.future_effect_end, '2026-10-18T10:36:00.000Z');
  assert.equal(captured.qualification.margin_seconds, 5);
});

test('public accounting charges the full encoded duration from the immutable anchor across midnight', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const reservation = await dispatch.reserveValveCommand({ db: f.db, command: {
    device_eui: EUI, command_id: 'accounting-anchor', action: 'OPEN_FOR_DURATION', duration_minutes: 1,
    commanded_at: '2026-10-18T23:45:00.000Z', timezone: 'UTC',
  }, now: '2026-10-18T23:45:00.000Z' });
  await dispatch.captureEffectSnapshot({ db: f.db, deviceEui: EUI,
    owner: { type: 'expectation', id: reservation.expectation.expectation_id }, frame: FRAME,
    now: '2026-10-18T23:59:59.000Z' });
  const accounting = await dispatch.getDailyAccounting({ db: f.db, deviceEui: EUI, timezone: 'UTC' });
  const run = accounting.runs.find((entry) => entry.command_id === 'accounting-anchor');
  assert.equal(run.source, 'conservative');
  assert.equal(run.days['2026-10-18'], 1);
  assert.equal(run.days['2026-10-19'], 1);
});

test('ONCE capture uses immutable fire_at rather than late claim time', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const reservation = await dispatch.reserveValveCommand({ db: f.db, command: {
    device_eui: EUI, command_id: 'once-anchor', action: 'OPEN_FOR_DURATION', duration_minutes: 1,
    trigger: 'on_valve_schedule', commanded_at: '2026-10-18T10:00:00.000Z', timezone: 'UTC',
  }, now: '2026-10-18T10:00:00.000Z' });
  await f.db.run("INSERT INTO valve_schedules(schedule_uuid,device_eui,kind,fire_at,duration_minutes,timezone,enabled,once_state) VALUES (?,?,?,?,?,?,1,'PENDING')", ['once-anchor-schedule', EUI, 'ONCE', '2026-10-18T10:05:00.000Z', 1, 'UTC']);
  await f.db.run("INSERT INTO valve_once_dispatch_intents(schedule_uuid,device_eui,command_id,state) VALUES (?,?,?,'PENDING')", ['once-anchor-schedule', EUI, 'once-anchor']);
  const captured = await dispatch.captureEffectSnapshot({ db: f.db, deviceEui: EUI,
    owner: { type: 'expectation', id: reservation.expectation.expectation_id }, frame: FRAME,
    now: '2026-10-18T12:00:00.000Z' });
  assert.equal(captured.anchor_at, '2026-10-18T10:05:00.000Z');
});

test('capture replay is immutable and ordinary malformed accounting is unknown', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const reservation = await dispatch.reserveValveCommand({ db: f.db, command: {
    device_eui: EUI, command_id: 'capture-replay', action: 'OPEN_FOR_DURATION', duration_minutes: 1,
    commanded_at: '2026-10-18T10:00:00.000Z', timezone: 'UTC',
  }, now: '2026-10-18T10:00:00.000Z' });
  const owner = { type: 'expectation', id: reservation.expectation.expectation_id };
  await dispatch.captureEffectSnapshot({ db: f.db, deviceEui: EUI, owner, frame: FRAME, now: '2026-10-18T12:00:00.000Z' });
  await dispatch.captureEffectSnapshot({ db: f.db, deviceEui: EUI, owner, frame: FRAME, now: '2026-10-18T12:01:00.000Z' });
  await assert.rejects(dispatch.captureEffectSnapshot({ db: f.db, deviceEui: EUI, owner, frame: FRAME_FIVE_MINUTES }), (error) => error.code === 'effect_snapshot_immutable');
  const row = await f.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id=?', [owner.id]);
  const transport = JSON.parse(row.transport_json);
  transport.effect_snapshot.provenance = { source: 'queue_capture' };
  await f.db.run('UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?', [JSON.stringify(transport), owner.id]);
  const accounting = await dispatch.getDailyAccounting({ db: f.db, deviceEui: EUI, timezone: 'UTC' });
  assert.equal(accounting.runs.find((run) => run.command_id === 'capture-replay').source, 'unknown_duration');
});

test('accounting validates every persisted snapshot before trusting its effect class', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const makeOwner = async (commandId) => {
    const reservation = await dispatch.reserveValveCommand({ db: f.db, command: {
      device_eui: EUI, command_id: commandId, action: 'OPEN_FOR_DURATION', duration_minutes: 1,
      commanded_at: '2026-10-18T10:00:00.000Z', timezone: 'UTC',
    }, now: '2026-10-18T10:00:00.000Z' });
    const owner = { type: 'expectation', id: reservation.expectation.expectation_id };
    await dispatch.captureEffectSnapshot({ db: f.db, deviceEui: EUI, owner, frame: FRAME, now: '2026-10-18T10:00:00.000Z' });
    const row = await f.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id=?', [owner.id]);
    const transport = JSON.parse(row.transport_json);
    transport.effect_snapshot.effect_class = effects.EFFECTS.NON_ACTUATING;
    transport.effect_snapshot.encoded_duration_seconds = null;
    transport.effect_snapshot.future_effect_end = transport.effect_snapshot.latest_physical_start_at;
    transport.effect_snapshot.exclusion_end_at = transport.effect_snapshot.latest_physical_start_at;
    transport.effect_snapshot.reservation_end_at = transport.effect_snapshot.latest_physical_start_at;
    transport.effect_snapshot.minimum_gap_minutes = 0;
    await f.db.run('UPDATE valve_actuation_expectations SET transport_json=?, observed_open_at=?, observed_close_at=? WHERE expectation_id=?', [
      JSON.stringify(transport), '2026-10-18T10:01:00.000Z', '2026-10-18T10:11:00.000Z', owner.id,
    ]);
    return reservation;
  };
  const occurrenceReservation = await makeOwner('relabeled-occurrence');
  const occurrenceSnapshot = JSON.parse((await f.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id=?', [occurrenceReservation.expectation.expectation_id])).transport_json).effect_snapshot;
  await f.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, command_id, reservation_start_at, reservation_end_at, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    'relabeled-occurrence-schedule', '2026-10-18', '10:00', EUI, occurrenceSnapshot.anchor_at, 'UNKNOWN', occurrenceSnapshot.queue_expires_at,
    'relabeled-occurrence', occurrenceSnapshot.anchor_at, occurrenceSnapshot.future_effect_end, 1,
  ]);
  const accounting = await dispatch.getDailyAccounting({ db: f.db, deviceEui: EUI, timezone: 'UTC' });
  let run = accounting.runs.find((entry) => entry.command_id === 'relabeled-occurrence');
  assert.equal(run.source, 'unknown_duration');
  assert.ok(accounting.unknown_duration_command_ids.includes('relabeled-occurrence'));
  await f.db.run("DELETE FROM irrigation_occurrences WHERE command_id='relabeled-occurrence'");
  const ordinaryAccounting = await dispatch.getDailyAccounting({ db: f.db, deviceEui: EUI, timezone: 'UTC' });
  run = ordinaryAccounting.runs.find((entry) => entry.command_id === 'relabeled-occurrence');
  assert.equal(run.source, 'unknown_duration');
  assert.ok(ordinaryAccounting.unknown_duration_command_ids.includes('relabeled-occurrence'));
});

test('accepted and unknown owners release only at qualified horizon, with timezone projection and deduplication', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const qualificationProvider = () => ({ qualified: true, identity: 'fixture/gen1', margin_seconds: 5 });
  const reservation = await dispatch.reserveValveCommand({ db: f.db, command: {
    device_eui: EUI, command_id: 'horizon-owner', action: 'OPEN_FOR_DURATION', duration_minutes: 1,
    commanded_at: '2026-10-18T22:45:00.000Z', timezone: 'UTC',
  }, now: '2026-10-18T22:45:00.000Z' });
  const owner = { type: 'expectation', id: reservation.expectation.expectation_id };
  const snapshot = await dispatch.captureEffectSnapshot({ db: f.db, deviceEui: EUI, owner, frame: FRAME, qualificationProvider });
  const conflictAt = (phase, at, suffix) => f.db.transaction(async (tx) => {
    const patch = { phase };
    if (phase === 'ACCEPTED' && suffix === 'accepted-before') patch.queue_id = `q-${suffix}`;
    await dispatch.updateOwnerTransportTx(tx, owner, patch);
    return dispatch.findValveConflictTx(tx, EUI, 'different-command', at, { qualificationProvider, clockOptions: releaseClock(at, suffix) });
  });
  assert.ok(await conflictAt('ACCEPTED', '2026-10-18T23:16:59.000Z', 'accepted-before'));
  assert.equal(await conflictAt('ACCEPTED', snapshot.exclusion_end_at, 'accepted-at'), null);
  assert.equal(await conflictAt('ACCEPTED', '2026-10-18T23:17:01.000Z', 'accepted-after'), null);
  assert.ok(await conflictAt('UNKNOWN', '2026-10-18T23:16:59.000Z', 'unknown-before'));
  assert.equal(await conflictAt('UNKNOWN', snapshot.exclusion_end_at, 'unknown-at'), null);
  assert.equal(await conflictAt('UNKNOWN', '2026-10-18T23:17:01.000Z', 'unknown-after'), null);
  const row = await f.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE expectation_id=?', [owner.id]);
  const transport = JSON.parse(row.transport_json);
  await f.db.run("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, expires_at, decision_evidence_json, command_id, reservation_start_at, reservation_end_at, reserved_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [
    'dedup-schedule', '2026-10-18', '22:45', EUI, snapshot.anchor_at, 'UNKNOWN', snapshot.queue_expires_at, '{}', 'horizon-owner', snapshot.anchor_at, snapshot.future_effect_end, 1,
  ]);
  const accounting = await dispatch.getDailyAccounting({ db: f.db, deviceEui: EUI, currentTimezone: 'Europe/Zurich' });
  assert.equal(accounting.runs.filter((run) => run.command_id === 'horizon-owner').length, 1);
  assert.equal(accounting.runs[0].days['2026-10-19'], 1);
  assert.equal(transport.effect_snapshot.anchor_at, snapshot.anchor_at);
});
