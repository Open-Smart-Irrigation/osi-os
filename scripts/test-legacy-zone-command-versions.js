#!/usr/bin/env node
'use strict';

// E3: legacy cloud zone commands (UPSERT_ZONE, UPSERT_ZONE_CONFIG,
// UPSERT_ZONE_LOCATION, DELETE_ZONE) are written only at a newer version.
//
// Each case drives the shipped nodes of one profile in order, the way a pending
// command travels after Route Command:
//   "Lifecycle command adapter" (conditional-lifecycle-command-adapter, which
//   calls osi-irrigation-policy routes and the guard in osi-zone-commands)
//   -> output 1: "Build UPDATE SQL" (4f4a765f36cee6f3), its statement executed
//      on the database, then "Route command ACK verification" and
//      "Build Schedule ACK" for the MQTT ACK
//   -> output 3: the ACK the guard answers with, written nothing.
// The assertions are about the zone row, its schedule, the sync outbox and the
// ACK, on a database built from database/seed-blank.sql with the gateway linked
// so the zone outbox triggers fire.
//
// The sequences "config A then a stale rename B" and "delete A then a stale
// rename B" replay the two live reproductions of the lost-cloud-edit
// investigation (r1 and r4), with fixture identifiers.
//
// Run: node --test scripts/test-legacy-zone-command-versions.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
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

// A zone the gateway holds at version 5, linked to the cloud, with an enabled
// schedule (45 kPa): the state after cloud edit A was applied and acknowledged.
function fixture({ version = 5, deletedAt = null } = {}) {
  const db = new DatabaseSync(':memory:');
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

// One pending command through the shipped nodes. Returns where it went, the
// ACK that left for the cloud (parsed) and what the nodes logged.
async function deliver(profile, db, payload, extra = {}) {
  const adapter = await run(profile, ADAPTER, db, { payload }, extra);
  const outputs = Array.isArray(adapter.result) ? adapter.result : [adapter.result];
  const out = { adapter, wrote: false, ack: null };
  if (outputs[0]) {
    const built = await run(profile, BUILD_SQL, db, outputs[0]);
    assert.equal(typeof built.result.topic, 'string', 'Build UPDATE SQL must build a statement');
    db.exec(built.result.topic);
    out.wrote = true;
    const routed = await run(profile, ACK_ROUTE, db, built.result);
    assert.equal(routed.result[0], null, 'a zone command is not postcondition-verified');
    const ack = await run(profile, ACK_BUILD, db, routed.result[1]);
    out.ack = JSON.parse(ack.result.payload);
    out.ackTopic = ack.result.topic;
  } else if (outputs[1]) {
    out.ack = outputs[1].payload;
    out.ackTopic = outputs[1].topic;
    out.restQueue = true;
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

function assertConflict(out, version, current, reason) {
  assert.equal(out.wrote, false, 'a conflicting command must not reach Build UPDATE SQL');
  assert.ok(out.ack, 'a conflicting command is answered');
  assert.equal(out.ackTopic, `devices/${GATEWAY}/command_ack`);
  assert.equal(out.ack.result, 'CONFLICT');
  assert.equal(out.ack.reason, reason);
  assert.equal(out.ack.appliedSyncVersion, version, 'the ACK echoes the command version (cloud matchesAckSource)');
  assert.equal(out.ack.requestedSyncVersion, version);
  assert.equal(out.ack.currentSyncVersion, current);
}

for (const profile of PROFILES) {
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
      const deleted = await deliver(profile, db, pending('DELETE_ZONE', 6, { syncVersion: 6 }));
      assert.equal(deleted.wrote, true, 'the delete at a newer version is applied as today');
      assert.equal(deleted.ack.result, 'SUCCESS');
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
        pending('UPSERT_ZONE_LOCATION', 9, { latitude: 1, longitude: 2, syncVersion: 9 })]) {
        const out = await deliver(profile, db, late);
        assertConflict(out, late.appliedSyncVersion, 6, 'zone_deleted');
      }
      assert.deepEqual(fullZone(db), tombstone);
      assert.deepEqual(outbox(db), outboxAfterDelete);
    } finally {
      db.close();
    }
  });

  test(`${profile}: config A then a stale rename B at A's version (investigation r1): B is a CONFLICT, A stays`, async () => {
    const db = fixture({ version: 1 });
    try {
      const a = await deliver(profile, db, pending('UPSERT_ZONE_CONFIG', 2, {
        areaM2: 456, notes: 'race A r1', irrigationEfficiencyPct: 80, syncVersion: 2,
      }));
      assert.equal(a.wrote, true);
      assert.equal(a.ack.result, 'SUCCESS');
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

  test(`${profile}: higher-version commands are applied exactly as Build UPDATE SQL alone applies them`, async () => {
    const commands = [
      staleRename(6, 'renamed at six'),
      pending('UPSERT_ZONE_CONFIG', 6, { notes: 'new note', irrigationEfficiencyPct: 75, syncVersion: 6 }),
      pending('UPSERT_ZONE_LOCATION', 6, { latitude: 0.35, longitude: 32.58, syncVersion: 6 }),
      pending('DELETE_ZONE', 6, { syncVersion: 6, deletedAt: '2026-11-23T00:00:00.000Z' }),
    ];
    for (const command of commands) {
      const guarded = fixture();
      const direct = fixture();
      try {
        const out = await deliver(profile, guarded, command);
        assert.equal(out.wrote, true, `${command.commandType} at a newer version reaches Build UPDATE SQL`);
        assert.equal(out.ack.result, 'SUCCESS');
        assert.equal(out.ack.appliedSyncVersion, 6);
        const built = await run(profile, BUILD_SQL, direct, { payload: command });
        direct.exec(built.result.topic);
        const pick = (row) => { const { created_at: _c, ...rest } = row; return rest; };
        assert.deepEqual(pick(fullZone(guarded)), pick(fullZone(direct)), `${command.commandType}: same row as today`);
        assert.deepEqual(outbox(guarded), outbox(direct), `${command.commandType}: same outbox as today`);
        assert.equal(fullZone(guarded).sync_version, 6);
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
      const out = await deliver(profile, db, staleRename(1, 'new from cloud'));
      assert.equal(out.wrote, true);
      assert.equal(out.ack.result, 'SUCCESS');
      assert.equal(zone(db).name, 'new from cloud');
    } finally {
      db.close();
    }
  });

  test(`${profile}: a redelivered command already applied is answered SUCCESS again and writes nothing`, async () => {
    const db = fixture();
    try {
      for (const command of [
        staleRename(6, 'renamed at six'),
        pending('UPSERT_ZONE_CONFIG', 7, { notes: 'seven', areaM2: 77, syncVersion: 7 }),
        pending('UPSERT_ZONE_LOCATION', 8, { latitude: 0.35, longitude: 32.58, syncVersion: 8 }),
        pending('DELETE_ZONE', 9, { syncVersion: 9 }),
      ]) {
        const first = await deliver(profile, db, command);
        assert.equal(first.wrote, true, `${command.commandType}: first delivery applies`);
        const applied = fullZone(db);
        const events = outbox(db);
        const again = await deliver(profile, db, command);
        assert.equal(again.wrote, false, `${command.commandType}: the replay is not written again`);
        assert.deepEqual(again.ack, first.ack, `${command.commandType}: the replay gets the same ACK`);
        assert.deepEqual(fullZone(db), applied);
        assert.deepEqual(outbox(db), events);
      }
    } finally {
      db.close();
    }
  });

  test(`${profile}: without the guard helper the command fails closed: no write, no ACK`, async () => {
    const db = fixture();
    try {
      const before = fullZone(db);
      const out = await deliver(profile, db, staleRename(6), { osiLibModules: { 'zone-commands': {} } });
      assert.equal(out.wrote, false);
      assert.equal(out.ack, null);
      assert.match(out.adapter.errors.join('\n'), /legacy zone command guard unavailable/);
      assert.deepEqual(fullZone(db), before);
    } finally {
      db.close();
    }
  });
}

test('both profiles ship the same guard', () => {
  for (const rel of ['osi-zone-commands/index.js', 'osi-irrigation-policy/routes.js']) {
    const [a, b] = PROFILES.map((profile) => fs.readFileSync(path.join(profilePaths(profile).nodeRedModules, rel)));
    assert.ok(a.equals(b), `${rel} differs between profiles`);
  }
});
