#!/usr/bin/env node
'use strict';

// E3: legacy cloud zone commands (UPSERT_ZONE, UPSERT_ZONE_CONFIG,
// UPSERT_ZONE_LOCATION, DELETE_ZONE) are written only at a newer version, never
// on a tombstoned zone, and with the version check and the write in one
// transaction.
//
// Each case drives the shipped nodes of one profile the way a pending command
// travels after Route Command: "Lifecycle command adapter"
// (conditional-lifecycle-command-adapter, which calls osi-irrigation-policy routes
// and applyLegacyZoneCommand in osi-zone-commands). The adapter answers every
// legacy zone command itself on output 3 (MQTT). If a command ever left on output
// 1 again, the test would run "Build UPDATE SQL" and its ACK nodes as production
// does, and the assertions would catch the unguarded write. The assertions are
// about the zone row, its schedule, the sync outbox and the ACK, on a database
// built from database/seed-blank.sql with the gateway linked so the zone outbox
// triggers fire.
//
// The sequences "config A then a stale rename B" and "delete A then a stale
// rename B" replay the investigation's live reproductions r1 and r4. The race
// cases A, B and C are the #753 review's reproductions.
//
// Run: node --test scripts/test-legacy-zone-command-versions.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { executeFunction, loadNode, profilePaths } = require('./lib/scoped-access-harness');

const ROOT = path.resolve(__dirname, '..');
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const GATEWAY = '0016C001F1000001';
const ZONE_UUID = '11111111-2222-4333-8444-555555555555';
const USER_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROFILES = ['bcm2712', 'bcm2709'];

const ADAPTER = 'conditional-lifecycle-command-adapter';
const BUILD_SQL = '4f4a765f36cee6f3';
const ACK_ROUTE = 'command-postcondition-route';
const ACK_BUILD = 'e2e139678c3ddded';

function seed(db, { version = 5, deletedAt = null } = {}) {
  db.exec(SEED);
  db.prepare('INSERT INTO users(id, username, password_hash, created_at, user_uuid, role, sync_version) '
    + "VALUES (1, 'farmer', 'x', '2026-01-01', ?, 'admin', 1)").run(USER_UUID);
  db.prepare("INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) VALUES ('cloud', 1, ?, '2026-01-01')")
    .run(GATEWAY);
  db.prepare('INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, gateway_device_eui, sync_version, timezone, '
    + 'phenological_stage, calibration_key, area_m2, notes, irrigation_efficiency_pct, scheduling_mode, '
    + "prediction_card_enabled, deleted_at, created_at, updated_at) VALUES (1, 'zone A-applied', 1, ?, ?, ?, 'UTC', "
    + "'default', 'default', 456, 'cloud note A', 80, 'local', 0, ?, '2026-01-01', '2026-01-01')")
    .run(ZONE_UUID, GATEWAY, version, deletedAt);
  db.prepare('INSERT INTO irrigation_schedules(irrigation_zone_id, trigger_metric, threshold_kpa, enabled, '
    + "duration_minutes, response_mode, sync_version, deleted_at) VALUES (1, 'SWT_WM1', 45, 1, 20, 'proportional', 3, NULL)")
    .run();
  db.exec('DELETE FROM sync_outbox');
  return db;
}

// A zone the gateway holds at version 5, linked to the cloud, with an enabled
// schedule (45 kPa): the state after cloud edit A was applied and acknowledged.
function fixture(options) {
  return seed(new DatabaseSync(':memory:'), options);
}

let nextCommandId = 9001;

// The flattened message "Replay Pending Commands" builds for one cloud command.
function pending(commandType, version, payload) {
  const commandId = nextCommandId++;
  const envelope = {
    commandId,
    eventUuid: `00000000-0000-4000-8000-${String(commandId).padStart(12, '0')}`,
    commandType,
    aggregateType: 'ZONE',
    aggregateKey: ZONE_UUID,
    appliedSyncVersion: version,
    payload: { zoneUuid: ZONE_UUID, gatewayDeviceEui: GATEWAY, ...payload },
  };
  return {
    ...envelope.payload,
    commandId,
    commandType,
    command_type: commandType,
    eventUuid: envelope.eventUuid,
    aggregateType: envelope.aggregateType,
    aggregateKey: envelope.aggregateKey,
    appliedSyncVersion: version,
    effectKey: null,
    _pendingCommandEnvelope: envelope,
  };
}

// The cloud's full UPSERT_ZONE, built from its stale mirror (investigation
// offline/cmd.json): a rename that carries the old area and note and no efficiency.
function staleRename(version, name = 'renamed-by-cloud') {
  return pending('UPSERT_ZONE', version, {
    name,
    timezone: 'UTC',
    phenologicalStage: 'default',
    calibrationKey: 'default',
    areaM2: 123.0,
    notes: 'stale note',
    irrigationEfficiencyPct: null,
    schedulingMode: 'local',
    predictionCardEnabled: false,
    syncVersion: version,
    user: { userUuid: USER_UUID, username: 'farmer' },
  });
}

// An UPSERT_ZONE that sets every column the node writes.
const FULL_ZONE = {
  name: 'Full zone',
  timezone: 'Africa/Kampala',
  latitude: 0.35,
  longitude: 32.58,
  phenologicalStage: 'mid_season',
  calibrationKey: 'coffee',
  cropType: 'coffee',
  variety: 'arabica',
  soilType: 'loam',
  irrigationMethod: 'drip',
  areaM2: 1200,
  irrigationEfficiencyPct: 85,
  schedulingMode: 'server_preferred',
  predictionCardEnabled: true,
  notes: 'full note',
  weatherSource: 'provider_a',
  stageStartedOn: '2026-05-01',
  user: { userUuid: USER_UUID, username: 'farmer' },
};

async function run(profile, nodeId, db, msg, extra = {}) {
  const { flowsPath, nodeRedModules } = profilePaths(profile);
  return executeFunction(loadNode(nodeId, flowsPath), {
    msg,
    env: { DEVICE_EUI: GATEWAY },
    db,
    nodeRedModules,
    ...extra,
  });
}

// One pending command through the adapter. `hop` runs between the adapter and
// Build UPDATE SQL, the Node-RED hop where another writer could land.
async function deliver(profile, db, payload, extra = {}, hop = null) {
  const adapter = await run(profile, ADAPTER, db, { payload }, extra);
  const outputs = Array.isArray(adapter.result) ? adapter.result : [adapter.result];
  const out = { adapter, viaBuildSql: false, ack: null };
  if (hop) hop();
  if (outputs[0]) {
    // The pre-E3-round-2 route: Build UPDATE SQL writes after the adapter returned.
    out.viaBuildSql = true;
    const built = await run(profile, BUILD_SQL, db, outputs[0]);
    db.exec(built.result.topic);
    const routed = await run(profile, ACK_ROUTE, db, built.result);
    const ack = await run(profile, ACK_BUILD, db, routed.result[1]);
    out.ack = JSON.parse(ack.result.payload);
    out.ackTopic = ack.result.topic;
  } else if (outputs[1]) {
    out.ack = outputs[1].payload;
    out.ackTopic = outputs[1].topic;
  } else if (outputs[2]) {
    out.ack = JSON.parse(outputs[2].payload);
    out.ackTopic = outputs[2].topic;
  }
  return out;
}

function zone(db) {
  return { ...db.prepare('SELECT name, sync_version, area_m2, notes, irrigation_efficiency_pct, latitude, longitude, '
    + 'deleted_at FROM irrigation_zones WHERE zone_uuid = ?').get(ZONE_UUID) };
}
function fullZone(db) {
  const row = { ...db.prepare('SELECT * FROM irrigation_zones WHERE zone_uuid = ?').get(ZONE_UUID) };
  delete row.updated_at;
  return row;
}
function schedule(db) {
  return { ...db.prepare('SELECT enabled, threshold_kpa, sync_version, deleted_at FROM irrigation_schedules WHERE irrigation_zone_id = 1').get() };
}
function outbox(db) {
  return db.prepare("SELECT op, sync_version, json_extract(payload_json, '$.name') AS name, "
    + "json_extract(payload_json, '$.notes') AS notes, json_extract(payload_json, '$.irrigation_efficiency_pct') AS efficiency "
    + 'FROM sync_outbox ORDER BY rowid').all().map((r) => ({ ...r }));
}

function assertAnswered(out, result) {
  assert.equal(out.viaBuildSql, false, 'a legacy zone command never reaches Build UPDATE SQL');
  assert.ok(out.ack, 'the command is answered');
  assert.equal(out.ackTopic, `devices/${GATEWAY}/command_ack`);
  assert.equal(out.ack.result, result);
}

function assertConflict(out, version, current, reason) {
  assertAnswered(out, 'CONFLICT');
  assert.equal(out.ack.reason, reason);
  assert.equal(out.ack.appliedSyncVersion, version, 'the ACK echoes the command version (cloud matchesAckSource)');
  assert.equal(out.ack.requestedSyncVersion, version);
  assert.equal(out.ack.currentSyncVersion, current);
}

// A SUCCESS is the command ledger's terminal ACK (osi-command-ledger, as for the
// legacy schedule commands), sent on MQTT and queued as a REST ACK row.
function assertSuccess(out, command) {
  assertAnswered(out, 'APPLIED');
  const { appliedAt, ...rest } = out.ack;
  assert.match(String(appliedAt), /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(rest, {
    commandId: command.commandId,
    eventUuid: command.eventUuid,
    aggregateType: 'ZONE',
    aggregateKey: ZONE_UUID,
    commandType: command.commandType,
    status: 'ACKED',
    result: 'APPLIED',
    requestedSyncVersion: command.appliedSyncVersion,
    appliedSyncVersion: command.appliedSyncVersion,
    duplicate: false,
    reason: null,
    detail: null,
  });
}

function normaliseClock(sql) {
  return String(sql).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<now>');
}

for (const profile of PROFILES) {
  const zoneCommands = require(path.join(profilePaths(profile).nodeRedModules, 'osi-zone-commands'));

  test(`${profile}: a stale UPSERT_ZONE at the stored version is a CONFLICT and writes nothing`, async () => {
    const db = fixture();
    try {
      const before = fullZone(db);
      const out = await deliver(profile, db, staleRename(5));
      assertConflict(out, 5, 5, 'version_conflict');
      assert.equal(out.ack.commandType, 'UPSERT_ZONE');
      assert.equal(out.ack.aggregateKey, ZONE_UUID);
      assert.deepEqual(fullZone(db), before, 'irrigation efficiency, area, note and name stay as the gateway had them');
      assert.deepEqual(outbox(db), [], 'no outbox event at the colliding version');
    } finally {
      db.close();
    }
  });

  test(`${profile}: a stale UPSERT_ZONE below the stored version is a CONFLICT and writes nothing`, async () => {
    const db = fixture();
    try {
      const before = fullZone(db);
      const out = await deliver(profile, db, staleRename(4));
      assertConflict(out, 4, 5, 'stale_sync_version');
      assert.deepEqual(fullZone(db), before);
      assert.deepEqual(outbox(db), []);
    } finally {
      db.close();
    }
  });

  test(`${profile}: a stale notes-only UPSERT_ZONE_CONFIG is a CONFLICT and leaves efficiency and area`, async () => {
    const db = fixture();
    try {
      const before = fullZone(db);
      const out = await deliver(profile, db, pending('UPSERT_ZONE_CONFIG', 5, {
        notes: 'race B notes only', areaM2: null, irrigationEfficiencyPct: null, syncVersion: 5,
      }));
      assertConflict(out, 5, 5, 'version_conflict');
      assert.deepEqual(fullZone(db), before);
      assert.equal(zone(db).irrigation_efficiency_pct, 80);
      assert.equal(zone(db).area_m2, 456);
      assert.deepEqual(outbox(db), []);
    } finally {
      db.close();
    }
  });

  test(`${profile}: a stale UPSERT_ZONE_LOCATION is a CONFLICT and leaves the location`, async () => {
    const db = fixture();
    try {
      const before = fullZone(db);
      const out = await deliver(profile, db, pending('UPSERT_ZONE_LOCATION', 5, { latitude: 1.5, longitude: 32.5, syncVersion: 5 }));
      assertConflict(out, 5, 5, 'version_conflict');
      assert.deepEqual(fullZone(db), before);
    } finally {
      db.close();
    }
  });

  test(`${profile}: a stale DELETE_ZONE is a CONFLICT and the zone stays live`, async () => {
    for (const version of [5, 4]) {
      const db = fixture();
      try {
        const out = await deliver(profile, db, pending('DELETE_ZONE', version, { syncVersion: version }));
        assertConflict(out, version, 5, version === 5 ? 'version_conflict' : 'stale_sync_version');
        assert.equal(zone(db).deleted_at, null);
        assert.equal(zone(db).sync_version, 5);
        assert.deepEqual(schedule(db), { enabled: 1, threshold_kpa: 45, sync_version: 3, deleted_at: null });
      } finally {
        db.close();
      }
    }
  });

  test(`${profile}: delete then a stale rename (investigation r4): the zone stays deleted, CONFLICT, schedule untouched`, async () => {
    const db = fixture();
    try {
      const deleteCommand = pending('DELETE_ZONE', 6, { syncVersion: 6 });
      const deleted = await deliver(profile, db, deleteCommand);
      assertSuccess(deleted, deleteCommand);
      const tombstone = fullZone(db);
      assert.notEqual(tombstone.deleted_at, null);
      assert.equal(tombstone.sync_version, 6);
      const scheduleAfterDelete = schedule(db);
      const outboxAfterDelete = outbox(db);
      const rename = await deliver(profile, db, staleRename(6, 'osi-test-race-B'));
      assertConflict(rename, 6, 6, 'zone_deleted');
      assert.deepEqual(fullZone(db), tombstone, 'deleted_at is never cleared by a legacy zone command');
      assert.deepEqual(schedule(db), scheduleAfterDelete, 'the schedule is not touched');
      assert.deepEqual(outbox(db), outboxAfterDelete);
      // A legacy command never brings a tombstoned zone back, whatever its version.
      for (const late of [staleRename(7, 'later'), pending('UPSERT_ZONE_CONFIG', 8, { notes: 'x', syncVersion: 8 }),
        pending('UPSERT_ZONE_LOCATION', 9, { latitude: 1, longitude: 2, syncVersion: 9 }),
        pending('DELETE_ZONE', 10, { syncVersion: 10 })]) {
        const out = await deliver(profile, db, late);
        assertConflict(out, late.appliedSyncVersion, 6, 'zone_deleted');
      }
      assert.deepEqual(fullZone(db), tombstone);
      assert.deepEqual(outbox(db), outboxAfterDelete);
    } finally {
      db.close();
    }
  });

  test(`${profile}: a DELETE_ZONE above a tombstone's version is a CONFLICT, not a replay`, async () => {
    const db = fixture({ version: 6, deletedAt: '2026-11-20T00:00:00.000Z' });
    try {
      const before = fullZone(db);
      const out = await deliver(profile, db, pending('DELETE_ZONE', 7, { syncVersion: 7 }));
      assertConflict(out, 7, 6, 'zone_deleted');
      assert.deepEqual(fullZone(db), before, 'the tombstone keeps its version and time');
      const replay = pending('DELETE_ZONE', 6, { syncVersion: 6, deletedAt: '2026-11-20T00:00:00.000Z' });
      assertSuccess(await deliver(profile, db, replay), replay);
      assert.deepEqual(fullZone(db), before, 'an equal-version delete that made this tombstone writes nothing');
    } finally {
      db.close();
    }
  });

  // CodeRabbit #753: a different delete at the tombstone's version is not a replay.
  test(`${profile}: an equal-version DELETE_ZONE is a replay only when it provably made the tombstone`, async () => {
    const db = fixture({ version: 6, deletedAt: '2026-11-20T00:00:00.000Z' });
    try {
      const before = fullZone(db);
      for (const other of [
        pending('DELETE_ZONE', 6, { syncVersion: 6, deletedAt: '2026-11-23T00:00:00.000Z' }),
        pending('DELETE_ZONE', 6, { syncVersion: 6 }),
      ]) {
        assertConflict(await deliver(profile, db, other), 6, 6, 'zone_deleted');
        assert.deepEqual(fullZone(db), before);
      }
    } finally {
      db.close();
    }
    // A delete that named no time: its exact retry is answered from the command ledger.
    const live = fixture();
    try {
      const del = pending('DELETE_ZONE', 6, { syncVersion: 6 });
      const first = await deliver(profile, live, del);
      assertSuccess(first, del);
      const tombstone = fullZone(live);
      const again = await deliver(profile, live, del);
      assert.deepEqual(again.ack, first.ack, 'the exact retry gets the stored ACK');
      assert.deepEqual(fullZone(live), tombstone);
      assertConflict(await deliver(profile, live, pending('DELETE_ZONE', 6, { syncVersion: 6 })), 6, 6, 'zone_deleted');
    } finally {
      live.close();
    }
  });

  // CodeRabbit #753: a NULL stored version is version 0 for the rules and the statement alike.
  test(`${profile}: a zone with a NULL sync_version takes a newer command and records it`, async () => {
    for (const make of [
      () => staleRename(6, 'from null'),
      () => pending('UPSERT_ZONE_CONFIG', 6, { notes: 'from null', syncVersion: 6 }),
      () => pending('UPSERT_ZONE_LOCATION', 6, { latitude: 1, longitude: 2, syncVersion: 6 }),
      () => pending('DELETE_ZONE', 6, { syncVersion: 6 }),
    ]) {
      const db = fixture();
      try {
        // The zone outbox trigger cannot carry a NULL version, so unlink for this write.
        db.exec(`UPDATE sync_link_state SET linked = 0; UPDATE irrigation_zones SET sync_version = NULL WHERE zone_uuid = '${ZONE_UUID}'; UPDATE sync_link_state SET linked = 1`);
        const command = make();
        const out = await deliver(profile, db, command);
        assert.equal(fullZone(db).sync_version, 6, `${command.commandType}: written, not a SUCCESS without a write`);
        assertSuccess(out, command);
      } finally {
        db.close();
      }
    }
  });

  // CodeRabbit #753: the exact redelivery of a stage reset, whose second run would
  // write the supplied date onto the now-unset stage, is answered SUCCESS.
  test(`${profile}: a redelivered stage reset is answered from the ledger, not judged again`, async () => {
    const db = fixture();
    try {
      db.exec(`UPDATE irrigation_zones SET phenological_stage = 'development', stage_started_on = '2026-04-20' WHERE zone_uuid = '${ZONE_UUID}'`);
      const reset = pending('UPSERT_ZONE_CONFIG', 6, { phenologicalStage: 'default', stageStartedOn: '2026-05-01', syncVersion: 6 });
      const first = await deliver(profile, db, reset);
      assertSuccess(first, reset);
      assert.deepEqual([fullZone(db).phenological_stage, fullZone(db).stage_started_on], ['default', null]);
      const applied = fullZone(db);
      const again = await deliver(profile, db, reset);
      assert.deepEqual(again.ack, first.ack);
      assert.deepEqual(fullZone(db), applied);
      // The same content in another delivery cannot be proven identical: CONFLICT.
      const copy = pending('UPSERT_ZONE_CONFIG', 6, { phenologicalStage: 'default', stageStartedOn: '2026-05-01', syncVersion: 6 });
      assertConflict(await deliver(profile, db, copy), 6, 6, 'version_conflict');
      assert.deepEqual(fullZone(db), applied);
    } finally {
      db.close();
    }
  });

  test(`${profile}: a SUCCESS is one command-ledger row and one REST ACK row; a CONFLICT is neither`, async () => {
    const db = fixture();
    try {
      const command = staleRename(6, 'ledgered');
      const out = await deliver(profile, db, command);
      assertSuccess(out, command);
      const ledgerRow = { ...db.prepare('SELECT command_type, result FROM applied_commands WHERE command_id = ?').get(String(command.commandId)) };
      assert.deepEqual(ledgerRow, { command_type: 'UPSERT_ZONE', result: 'APPLIED' });
      const rest = db.prepare('SELECT payload_json FROM command_ack_outbox WHERE command_id = ?').all(String(command.commandId));
      assert.equal(rest.length, 1);
      assert.deepEqual(JSON.parse(rest[0].payload_json), out.ack);
      const stale = staleRename(5, 'stale');
      assertConflict(await deliver(profile, db, stale), 5, 6, 'stale_sync_version');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id = ?').get(String(stale.commandId)).n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id = ?').get(String(stale.commandId)).n, 0);
    } finally {
      db.close();
    }
  });

  test(`${profile}: config A then a stale rename B at A's version (investigation r1): B is a CONFLICT, A stays`, async () => {
    const db = fixture({ version: 1 });
    try {
      const configA = pending('UPSERT_ZONE_CONFIG', 2, {
        areaM2: 456, notes: 'race A r1', irrigationEfficiencyPct: 80, syncVersion: 2,
      });
      assertSuccess(await deliver(profile, db, configA), configA);
      const afterA = fullZone(db);
      assert.equal(afterA.sync_version, 2);
      const outboxAfterA = outbox(db);
      assert.deepEqual(outboxAfterA.map((e) => [e.op, e.sync_version, e.notes, e.efficiency]),
        [['ZONE_CONFIG_UPSERTED', 2, 'race A r1', 80]], 'A emits its event at version 2');
      const b = await deliver(profile, db, staleRename(2, 'osi-test-race-B-r1'));
      assertConflict(b, 2, 2, 'version_conflict');
      assert.deepEqual(fullZone(db), afterA);
      assert.deepEqual(outbox(db), outboxAfterA, 'no second event at version 2 for the cloud to reject');
    } finally {
      db.close();
    }
  });

  const NEWER = [
    () => staleRename(6, 'renamed at six'),
    () => pending('UPSERT_ZONE', 6, { ...FULL_ZONE, syncVersion: 6 }),
    () => pending('UPSERT_ZONE', 6, { name: '  spaced  ', latitude: '0.5', areaM2: '77', schedulingMode: ' SERVER_PREFERRED ',
      weatherSource: 'Bad Value!', stageStartedOn: '2026-02-31', predictionCardEnabled: 'yes', syncVersion: 6,
      user: { userUuid: USER_UUID } }),
    () => pending('UPSERT_ZONE', 6, { name: 'with tombstone', deletedAt: '2026-11-23T00:00:00.000Z', syncVersion: 6,
      user: { username: 'farmer' } }),
    () => pending('UPSERT_ZONE_CONFIG', 6, { notes: 'new note', irrigationEfficiencyPct: 75, syncVersion: 6 }),
    () => pending('UPSERT_ZONE_CONFIG', 6, { notes: " it's padded ", variety: '', soil_type: 'sand', irrigationMethod: null,
      timezone: 'Europe/Zurich', calibration_key: 'apple', area_m2: '12.5', irrigation_efficiency_pct: null,
      scheduling_mode: 'bogus', prediction_card_enabled: 0, weather_source: 'provider_c', stage_started_on: null, syncVersion: 6 }),
    () => pending('UPSERT_ZONE', 6, { ...FULL_ZONE, notes: " it's padded ", crop_type: 'tea', soil_type: 'sand',
      irrigation_method: 'flood', area_m2: 5, irrigation_efficiency_pct: 60, scheduling_mode: 'server_preferred',
      prediction_card_enabled: 1, weather_source: 'provider_c', stage_started_on: '2026-04-01', gateway_device_eui: undefined,
      syncVersion: 6 }),
    () => pending('UPSERT_ZONE_CONFIG', 6, { cropType: 'maize', crop_type: 'beans', phenologicalStage: 'initial',
      weatherSource: '', schedulingMode: 'server_preferred', predictionCardEnabled: 1, syncVersion: 6 }),
    () => pending('UPSERT_ZONE_CONFIG', 6, { phenological_stage: 'late_season', stageStartedOn: '2026-06-01', syncVersion: 6 }),
    () => pending('UPSERT_ZONE_LOCATION', 6, { latitude: 0.35, longitude: 32.58, syncVersion: 6 }),
    () => pending('UPSERT_ZONE_LOCATION', 6, { latitude: null, longitude: null, syncVersion: 6 }),
    () => pending('DELETE_ZONE', 6, { syncVersion: 6, deletedAt: '2026-11-23T00:00:00.000Z' }),
    () => pending('DELETE_ZONE', 6, { syncVersion: 6 }),
    // The remaining shapes give every written field, in each key spelling the
    // node reads, at least one non-default value. Timestamps are written in a form
    // the clock normaliser leaves alone, so a dropped field cannot hide behind it.
    () => pending('UPSERT_ZONE_CONFIG', 6, { soilType: 'silt', calibrationKey: 'pear', areaM2: 33, irrigation_method: 'pivot',
      weatherSource: 'Bad Value!', phenologicalStage: 'default', stageStartedOn: '2026-03-01', notes: 'invalid provider',
      syncVersion: 6 }),
    () => pending('UPSERT_ZONE_CONFIG', 6, { weather_source: 'Not-Valid', variety: 'gala', calibrationKey: 'quince',
      calibration_key: 'medlar', soilType: 'peat', soil_type: 'chalk', irrigationMethod: 'drip', irrigation_method: 'flood',
      phenologicalStage: 'initial', phenological_stage: 'veraison', syncVersion: 6 }),
    () => pending('UPSERT_ZONE', 6, { name: '', phenological_stage: 'veraison', calibration_key: 'grape', variety: 'syrah',
      deleted_at: '2026-11-23 10:00:00', weather_source: 'provider_d', user: { cloudUserId: 42 }, syncVersion: 6 }),
    () => pending('UPSERT_ZONE', 6, { name: 'snake gateway', gatewayDeviceEui: undefined,
      gateway_device_eui: '0016C001F1000003', longitude: '-1.25', stage_started_on: '', user: { username: 'farmer', cloudUserId: 1 },
      syncVersion: 6 }),
    () => pending('DELETE_ZONE', 6, { syncVersion: 6, deletedAt: '2026-11-23 10:00:00' }),
  ];

  // Shapes the drift test covers but the adapter path cannot carry with the
  // legacy ACK assertions: a command version only in syncVersion, and a command
  // type only in `action`.
  const DRIFT_ONLY = [
    () => { const c = pending('UPSERT_ZONE', 6, { ...FULL_ZONE, syncVersion: 8 }); delete c.appliedSyncVersion; return c; },
    () => { const c = pending('UPSERT_ZONE_CONFIG', 6, { notes: 'version from syncVersion', syncVersion: 8 }); delete c.appliedSyncVersion; return c; },
    () => { const c = pending('UPSERT_ZONE_LOCATION', 6, { latitude: 2, longitude: 3, syncVersion: 'x' }); delete c.appliedSyncVersion; return c; },
    () => { const c = pending('DELETE_ZONE', 6, { syncVersion: 9 }); delete c.appliedSyncVersion; return c; },
    () => { const c = pending('UPSERT_ZONE_LOCATION', 6, { latitude: 4, longitude: 5, action: 'UPSERT_ZONE_LOCATION' });
      delete c.commandType; delete c.command_type; return c; },
    () => { const c = pending('UPSERT_ZONE', 6, { name: 'snake zone uuid', zone_uuid: ZONE_UUID, user: { username: 'farmer' } });
      delete c.zoneUuid; return c; },
  ];

  test(`${profile}: osi-zone-commands builds the statement Build UPDATE SQL builds, for every command shape`, async () => {
    for (const make of [...NEWER, ...DRIFT_ONLY]) {
      const command = make();
      const built = await run(profile, BUILD_SQL, fixture(), { payload: command });
      const warnings = [];
      const statement = zoneCommands.legacyZoneStatement(command, {
        now: new Date().toISOString(), gateway: GATEWAY, warn: (m) => warnings.push(m),
      });
      assert.equal(normaliseClock(statement), normaliseClock(built.result.topic), `${command.commandType}: same statement`);
      assert.deepEqual(warnings, built.warnings, `${command.commandType}: same warnings`);
    }
  });

  test(`${profile}: higher-version commands are applied exactly as Build UPDATE SQL alone applies them`, async () => {
    for (const make of NEWER) {
      const command = make();
      const guarded = fixture();
      const direct = fixture();
      try {
        const out = await deliver(profile, guarded, command);
        assertSuccess(out, command);
        const built = await run(profile, BUILD_SQL, direct, { payload: command });
        direct.exec(built.result.topic);
        // created_at and a DELETE_ZONE's deleted_at come from each writer's own clock.
        const pick = (row) => {
          const { created_at: _c, ...rest } = row;
          if (rest.deleted_at && !command.deletedAt) rest.deleted_at = normaliseClock(rest.deleted_at);
          return rest;
        };
        assert.deepEqual(pick(fullZone(guarded)), pick(fullZone(direct)), `${command.commandType}: same row as today`);
        assert.deepEqual(outbox(guarded), outbox(direct), `${command.commandType}: same outbox as today`);
        // An UPSERT_ZONE naming a user the gateway does not have inserts and updates
        // nothing, as Build UPDATE SQL does; every other shape writes version 6.
        const noUser = command.user && command.user.cloudUserId === 42;
        assert.equal(fullZone(guarded).sync_version, noUser ? 5 : 6);
      } finally {
        guarded.close();
        direct.close();
      }
    }
  });

  test(`${profile}: an UPSERT_ZONE for a zone the gateway does not have still inserts it`, async () => {
    const db = fixture();
    try {
      db.exec('DELETE FROM irrigation_schedules; DELETE FROM irrigation_zones; DELETE FROM sync_outbox');
      const command = staleRename(1, 'new from cloud');
      assertSuccess(await deliver(profile, db, command), command);
      assert.equal(zone(db).name, 'new from cloud');
      assert.equal(zone(db).sync_version, 1);
    } finally {
      db.close();
    }
  });

  test(`${profile}: a redelivered command already applied is answered SUCCESS again and writes nothing`, async () => {
    const db = fixture();
    try {
      for (const command of [
        staleRename(6, 'renamed at six'),
        pending('UPSERT_ZONE', 7, { ...FULL_ZONE, syncVersion: 7 }),
        pending('UPSERT_ZONE_CONFIG', 8, { notes: 'eight', areaM2: 77, syncVersion: 8 }),
        pending('UPSERT_ZONE_LOCATION', 9, { latitude: 0.35, longitude: 32.58, syncVersion: 9 }),
        pending('DELETE_ZONE', 10, { syncVersion: 10 }),
      ]) {
        const first = await deliver(profile, db, command);
        assertSuccess(first, command);
        const applied = fullZone(db);
        const events = outbox(db);
        const again = await deliver(profile, db, command);
        assert.deepEqual(again.ack, first.ack, `${command.commandType}: the replay gets the same ACK`);
        assert.deepEqual(fullZone(db), applied, `${command.commandType}: the replay is not written again`);
        assert.deepEqual(outbox(db), events, `${command.commandType}: the replay emits no event`);
      }
    } finally {
      db.close();
    }
  });

  test(`${profile}: an equal-version UPSERT_ZONE_CONFIG that sets no column is a replay`, async () => {
    const db = fixture();
    try {
      const before = fullZone(db);
      const command = pending('UPSERT_ZONE_CONFIG', 5, { syncVersion: 5 });
      assertSuccess(await deliver(profile, db, command), command);
      assert.deepEqual(fullZone(db), before);
      assert.deepEqual(outbox(db), []);
    } finally {
      db.close();
    }
  });

  // Every column the node writes is compared: an equal-version command that
  // differs from the stored row in any one of them is a CONFLICT, not a replay.
  const COLUMN_VARIANTS = {
    UPSERT_ZONE: {
      name: 'Other name', timezone: 'UTC', latitude: 1.1, longitude: 30.1, phenologicalStage: 'late_season',
      calibrationKey: 'banana', cropType: 'banana', variety: 'robusta', soilType: 'clay', irrigationMethod: 'sprinkler',
      areaM2: 1300, irrigationEfficiencyPct: 70, schedulingMode: 'local', predictionCardEnabled: false, notes: 'other note',
      weatherSource: 'provider_b', stageStartedOn: '2026-05-02', gatewayDeviceEui: '0016C001F1000002',
      deletedAt: '2026-11-23T00:00:00.000Z',
    },
    UPSERT_ZONE_CONFIG: {
      notes: 'other note', cropType: 'banana', variety: 'robusta', soilType: 'clay', irrigationMethod: 'sprinkler',
      timezone: 'UTC', phenologicalStage: 'late_season', calibrationKey: 'banana', areaM2: 1300,
      irrigationEfficiencyPct: 70, schedulingMode: 'local', predictionCardEnabled: false, weatherSource: 'provider_b',
      stageStartedOn: '2026-05-02',
    },
    UPSERT_ZONE_LOCATION: { latitude: 1.1, longitude: 30.1 },
  };

  test(`${profile}: an equal-version command differing in any single written column is a CONFLICT`, async () => {
    for (const [type, variants] of Object.entries(COLUMN_VARIANTS)) {
      for (const [field, value] of Object.entries(variants)) {
        const db = fixture();
        try {
          const base = pending('UPSERT_ZONE', 6, { ...FULL_ZONE, syncVersion: 6 });
          assertSuccess(await deliver(profile, db, base), base);
          const applied = fullZone(db);
          const events = outbox(db);
          const same = type === 'UPSERT_ZONE'
            ? { ...FULL_ZONE }
            : type === 'UPSERT_ZONE_LOCATION'
              ? { latitude: FULL_ZONE.latitude, longitude: FULL_ZONE.longitude }
              : Object.fromEntries(Object.keys(variants).map((key) => [key, FULL_ZONE[key]]));
          const replay = pending(type, 6, { ...same, syncVersion: 6 });
          assertSuccess(await deliver(profile, db, replay), replay);
          const out = await deliver(profile, db, pending(type, 6, { ...same, [field]: value, syncVersion: 6 }));
          assertConflict(out, 6, 6, 'version_conflict');
          assert.deepEqual(fullZone(db), applied, `${type}.${field}: no write`);
          assert.deepEqual(outbox(db), events, `${type}.${field}: no event`);
        } finally {
          db.close();
        }
      }
    }
  });

  test(`${profile}: fails closed with no write and no ACK on any output`, async () => {
    const cases = {
      'helper missing': { 'zone-commands': {} },
      'apply throws': { 'zone-commands': { applyLegacyZoneCommand: () => Promise.reject(new Error('injected guard failure')) } },
      'transaction fails': {
        'osi-db-helper': {
          Database: function Database() {
            return {
              transaction: () => Promise.reject(new Error('SQLITE_BUSY: injected')),
              close: (callback) => callback(),
            };
          },
        },
      },
    };
    for (const [name, osiLibModules] of Object.entries(cases)) {
      const db = fixture();
      try {
        const before = fullZone(db);
        const adapter = await run(profile, ADAPTER, db, { payload: staleRename(6) }, { osiLibModules });
        const outputs = Array.isArray(adapter.result) ? adapter.result : [adapter.result];
        assert.deepEqual(outputs, [null, null, null], `${name}: nothing on any output`);
        assert.ok(adapter.errors.length >= 1, `${name}: the failure is reported`);
        assert.deepEqual(fullZone(db), before, `${name}: no write`);
      } finally {
        db.close();
      }
    }
  });

  // Review reproduction A: a local delete (v7) lands in the hop between the
  // guard and the write of a cloud rename admitted at v6. The guard's read and
  // write share one BEGIN IMMEDIATE transaction on a file database, so a second
  // connection cannot write while it runs; the delete retried once the adapter
  // returns lands after the rename, and nothing writes after it.
  test(`${profile}: race A: a local delete between the version check and the write keeps its tombstone`, async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'e3-race-'));
    const file = path.join(dir, 'farming.db');
    const db = seed(new DatabaseSync(file));
    const local = new DatabaseSync(file);
    const localDelete = () => local.exec(`UPDATE irrigation_zones SET deleted_at = '2026-11-23T10:00:00.000Z', sync_version = 7 WHERE zone_uuid = '${ZONE_UUID}'`);
    let blocked = null;
    const dbCallGate = {
      select({ method, sql }) {
        if (blocked === null && method === 'get' && /FROM irrigation_zones WHERE zone_uuid/.test(sql)) {
          try {
            localDelete();
            blocked = false;
          } catch (error) {
            blocked = String(error && error.message || error);
          }
        }
        return { kind: 'execute', hold: false };
      },
    };
    try {
      const out = await deliver(profile, db, staleRename(6, 'renamed'), { dbCallGate }, () => {
        if (blocked !== false) localDelete();
      });
      const row = fullZone(db);
      assert.notEqual(row.deleted_at, null, 'the local delete keeps its tombstone');
      assert.equal(row.sync_version, 7, 'the version never goes back');
      assert.equal(schedule(db).enabled, 1);
      assert.equal(row.name, 'renamed', 'the rename was applied before the delete');
      assert.match(String(blocked), /locked|busy/i, 'no other connection writes during the check');
      assertAnswered(out, 'APPLIED');
    } finally {
      local.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Review reproductions B and C: two commands for one zone where both used to
  // pass the check before either write. The check and the write are now one
  // step, so the first is written before the second is checked.
  test(`${profile}: races B and C: the first command is written before the second is checked`, async () => {
    {
      const db = fixture();
      try {
        const del = pending('DELETE_ZONE', 7, { syncVersion: 7 });
        const first = await deliver(profile, db, del);
        assertSuccess(first, del);
        assert.notEqual(zone(db).deleted_at, null, 'B: written when the adapter returns');
        const second = await deliver(profile, db, staleRename(6, 'renamed'));
        assertConflict(second, 6, 7, 'zone_deleted');
        assert.notEqual(zone(db).deleted_at, null);
        assert.equal(zone(db).sync_version, 7);
      } finally {
        db.close();
      }
    }
    {
      const db = fixture();
      try {
        const config = pending('UPSERT_ZONE_CONFIG', 7, { irrigationEfficiencyPct: 90, syncVersion: 7 });
        assertSuccess(await deliver(profile, db, config), config);
        assert.equal(zone(db).irrigation_efficiency_pct, 90, 'C: written when the adapter returns');
        const second = await deliver(profile, db, staleRename(6, 'renamed'));
        assertConflict(second, 6, 7, 'stale_sync_version');
        assert.deepEqual([zone(db).sync_version, zone(db).irrigation_efficiency_pct, zone(db).area_m2], [7, 90, 456]);
      } finally {
        db.close();
      }
    }
  });

  test(`${profile}: the applied statement itself refuses a lower version and a tombstone`, async () => {
    // The rules above decide first; this pins the second line of defence in the
    // statement, by running it against rows the rules would have refused.
    for (const [type, payload] of [['UPSERT_ZONE', { name: 'x', user: { username: 'farmer' } }],
      ['UPSERT_ZONE_CONFIG', { notes: 'x' }], ['UPSERT_ZONE_LOCATION', { latitude: 1, longitude: 2 }], ['DELETE_ZONE', {}]]) {
      for (const state of [{ version: 9 }, { version: 2, deletedAt: '2026-11-20T00:00:00.000Z' }]) {
        const db = fixture(state);
        try {
          const before = fullZone(db);
          const command = pending(type, 6, { ...payload, syncVersion: 6 });
          const sql = zoneCommands.legacyZoneGuardedStatement(type, command,
            zoneCommands.legacyZoneStatement(command, { now: new Date().toISOString(), gateway: GATEWAY, warn: () => {} }));
          db.exec(sql);
          assert.deepEqual(fullZone(db), before, `${type} on ${JSON.stringify(state)}: no change`);
        } finally {
          db.close();
        }
      }
    }
  });
}

test('both profiles ship the same guard', () => {
  for (const rel of ['osi-zone-commands/index.js', 'osi-irrigation-policy/routes.js']) {
    const [a, b] = PROFILES.map((profile) => fs.readFileSync(path.join(profilePaths(profile).nodeRedModules, rel)));
    assert.ok(a.equals(b), `${rel} differs between profiles`);
  }
});
