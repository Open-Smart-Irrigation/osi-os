#!/usr/bin/env node
'use strict';

// Legacy UPSERT_ZONE branch of node 4f4a765f36cee6f3 ("Build UPDATE SQL").
// Builds the statement with the shipped function-node source and then runs it
// against a seeded database, so the assertions are about the row, not the SQL
// string.
//
// Run: node --test scripts/test-legacy-upsert-zone-name.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { executeFunction, loadNode } = require('./lib/scoped-access-harness');

const ROOT = path.resolve(__dirname, '..');
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const GATEWAY = '0016C001F11715E2';
const ZONE_UUID = '44444444-4444-4444-8444-444444444444';
const USER_UUID = '55555555-5555-4555-8555-555555555555';

function fixture({ withZone }) {
  const db = new DatabaseSync(':memory:');
  db.exec(SEED);
  db.exec("INSERT INTO users(id, username, password_hash, created_at, user_uuid, role, sync_version) "
    + `VALUES (1,'grower','x','2026-01-01','${USER_UUID}','admin',1)`);
  if (withZone) {
    db.exec('INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, gateway_device_eui, sync_version, '
      + 'timezone, created_at, updated_at) '
      + `VALUES (1,'Stored name',1,'${ZONE_UUID}','${GATEWAY}',3,'UTC','2026-01-01','2026-01-01')`);
  }
  return db;
}

function command(name) {
  const cmd = {
    commandType: 'UPSERT_ZONE',
    zoneUuid: ZONE_UUID,
    gatewayDeviceEui: GATEWAY,
    syncVersion: 9,
    user: { userUuid: USER_UUID },
  };
  if (name !== undefined) cmd.name = name;
  return cmd;
}

async function buildAndApply(db, name) {
  const run = await executeFunction(loadNode('4f4a765f36cee6f3'), {
    msg: { payload: command(name) },
    env: { DEVICE_EUI: GATEWAY },
    db,
  });
  assert.equal(typeof run.result.topic, 'string', 'the node must build a statement');
  db.exec(run.result.topic);
  return run;
}

test('a valid name is written, exactly as today', async () => {
  const db = fixture({ withZone: true });
  try {
    await buildAndApply(db, '  North block \n');
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'North block');
  } finally {
    db.close();
  }
});

test('a missing name keeps the stored name and does not warn', async () => {
  const db = fixture({ withZone: true });
  try {
    const run = await buildAndApply(db, undefined);
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Stored name');
    assert.deepEqual(run.warnings, []);
  } finally {
    db.close();
  }
});

for (const [label, value, code] of [
  ['blank', '   ', 'name_empty'],
  ['over-long', 'a'.repeat(101), 'name_too_long'],
  ['control character', 'Row\t7', 'name_control_characters'],
  ['lone surrogate', '\ud83c', 'name_invalid_unicode'],
]) {
  test('a ' + label + ' name keeps the stored name and warns', async () => {
    const db = fixture({ withZone: true });
    try {
      const run = await buildAndApply(db, value);
      assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Stored name');
      assert.ok(run.warnings.some((w) => w.includes(code)), JSON.stringify(run.warnings));
    } finally {
      db.close();
    }
  });
}

test('an invalid name on a first insert falls back to Zone', async () => {
  const db = fixture({ withZone: false });
  try {
    const run = await buildAndApply(db, 'Row\t7');
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).name, 'Zone');
    assert.ok(run.warnings.some((w) => w.includes('name_control_characters')), JSON.stringify(run.warnings));
  } finally {
    db.close();
  }
});

test('a missing name on a first insert falls back to Zone', async () => {
  const db = fixture({ withZone: false });
  try {
    await buildAndApply(db, undefined);
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).name, 'Zone');
  } finally {
    db.close();
  }
});

test('a valid name on a first insert is written', async () => {
  const db = fixture({ withZone: false });
  try {
    await buildAndApply(db, 'Fresh zone');
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).name, 'Fresh zone');
  } finally {
    db.close();
  }
});

test('the node binds the osi-lib seam on both profiles and bare-requires nothing', () => {
  for (const profile of ['bcm2712', 'bcm2709']) {
    const flows = JSON.parse(fs.readFileSync(path.join(
      ROOT, 'conf/full_raspberrypi_bcm27xx_' + profile + '/files/usr/share/flows.json'
    ), 'utf8'));
    const node = flows.find((n) => n.id === '4f4a765f36cee6f3');
    assert.deepEqual(node.libs, [{ var: 'osiLib', module: 'osi-lib' }], profile);
    assert.match(node.func, /osiLib\.require\('entity-name'\)/, profile);
    assert.doesNotMatch(node.func, /\brequire\(\s*'\.\.?\//, profile);
  }
});

// This task touches ONLY the UPSERT_ZONE branch of a node that also builds SQL
// for many other command types. Prove the other branches are untouched.
//
// The comparison is against FROZEN FIXTURES, not a live `git show` of the base
// commit: the SQL this node emitted for these five inputs before the legacy
// UPSERT_ZONE fix (base commit b0c60c9df, "Build UPDATE SQL"), captured once
// with a throwaway scratch script that ran the base node source through this
// same harness, and pasted here as literal strings. b0c60c9df is an
// intermediate branch commit this repo's squash-merge workflow will not keep
// reachable on main, so reading it with git show at test time would turn this
// CI step permanently red after merge (Task 10 review finding I1) -- freezing
// the expected output instead keeps the assertion meaningful forever, and
// still catches a change to any OTHER command branch, which is the point.
//
// Every one of these statements contains a `now = new Date().toISOString()`
// timestamp computed fresh inside the node on every call, so an exact string
// compare would never pass twice. Determinism is achieved by normalizing every
// ISO-8601 timestamp in the freshly-computed topic to the placeholder <TS>
// with one regular expression before comparing against the fixture (which was
// itself normalized the same way when captured) -- not by injecting a fixed
// clock, because this harness's sandbox (scripts/lib/scoped-access-harness.js)
// does not override the `Date` global the node's top-level `new Date()` call
// resolves against. ISO_TIMESTAMP only matches the exact
// YYYY-MM-DDTHH:MM:SS.sssZ shape `now` produces, so it cannot swallow a
// difference anywhere else in the statement (verified in Task 10 fix round 1
// by altering one character inside the frozen DELETE_ZONE fixture's non-
// timestamp SQL and confirming the comparison fails; see the fix-round report).
//
// To regenerate a fixture after a DELIBERATE change to one of these branches:
// run that branch's NON_UPSERT_ZONE_CASES entry through node 4f4a765f36cee6f3
// with scripts/lib/scoped-access-harness.js's executeFunction (the same call
// the loop below makes), pass the resulting msg.topic through
// normalizeTimestamps, and paste the string here.
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const normalizeTimestamps = (topic) => String(topic).replace(ISO_TIMESTAMP, '<TS>');

const BASE_COMMIT_TOPIC_FIXTURES = {
  UPSERT_ZONE_CONFIG: "UPDATE irrigation_zones SET crop_type = 'olive', notes = 'n', updated_at = '<TS>', sync_version = 3 WHERE zone_uuid = '44444444-4444-4444-8444-444444444444'",
  DELETE_ZONE: "UPDATE irrigation_zones SET deleted_at = '<TS>', updated_at = '<TS>', sync_version = 4 WHERE zone_uuid = '44444444-4444-4444-8444-444444444444'",
  UPSERT_DEVICE_FLAGS: "UPDATE devices SET dendro_enabled = 1, temp_enabled = 0, rain_gauge_enabled = 0, flow_meter_enabled = 0, is_reference_tree = 0, gateway_device_eui = '0016C001F11715E2', updated_at = '<TS>', sync_version = 2 WHERE deveui = 'AABBCCDDEEFF0011'",
  UPSERT_SCHEDULE: "INSERT INTO irrigation_schedules (irrigation_zone_id, trigger_metric, threshold_kpa, duration_minutes, enabled, response_mode, sync_version, created_at, updated_at, last_applied_at) SELECT id, 'SWT_WM1', 17.5, 12, 1, 'proportional', 5, '<TS>', '<TS>', '<TS>' FROM irrigation_zones WHERE zone_uuid = '44444444-4444-4444-8444-444444444444' ON CONFLICT(irrigation_zone_id) DO UPDATE SET trigger_metric=excluded.trigger_metric, threshold_kpa=excluded.threshold_kpa, duration_minutes=excluded.duration_minutes, enabled=excluded.enabled, response_mode=excluded.response_mode, sync_version=excluded.sync_version, updated_at=excluded.updated_at, last_applied_at=excluded.last_applied_at WHERE excluded.sync_version >= irrigation_schedules.sync_version",
  ASSIGN_DEVICE_TO_ZONE: "UPDATE devices SET irrigation_zone_id = (SELECT id FROM irrigation_zones WHERE zone_uuid = '44444444-4444-4444-8444-444444444444' LIMIT 1), gateway_device_eui = '0016C001F11715E2', updated_at = '<TS>', sync_version = 6 WHERE deveui = 'AABBCCDDEEFF0011' AND sync_version <= 6 AND EXISTS (SELECT 1 FROM irrigation_zones WHERE zone_uuid = '44444444-4444-4444-8444-444444444444')",
};

const NON_UPSERT_ZONE_CASES = [
  { commandType: 'UPSERT_ZONE_CONFIG', zoneUuid: ZONE_UUID, cropType: 'olive', notes: 'n', appliedSyncVersion: 3 },
  { commandType: 'DELETE_ZONE', zoneUuid: ZONE_UUID, appliedSyncVersion: 4 },
  { commandType: 'UPSERT_DEVICE_FLAGS', deviceEui: 'AABBCCDDEEFF0011', dendroEnabled: true, appliedSyncVersion: 2 },
  { commandType: 'UPSERT_SCHEDULE', zoneUuid: ZONE_UUID, triggerMetric: 'SWT_WM1', thresholdKpa: 17.5, durationMinutes: 12, enabled: true, responseMode: 'proportional', appliedSyncVersion: 5 },
  { commandType: 'ASSIGN_DEVICE_TO_ZONE', zoneUuid: ZONE_UUID, deviceEui: 'AABBCCDDEEFF0011', appliedSyncVersion: 6 },
];

for (const cmd of NON_UPSERT_ZONE_CASES) {
  test('command ' + cmd.commandType + ' still builds the base commit\'s SQL, unaffected by the UPSERT_ZONE fix', async () => {
    const head = loadNode('4f4a765f36cee6f3');
    const run = await executeFunction(head, { msg: { payload: cmd }, env: { DEVICE_EUI: GATEWAY } });
    const topic = normalizeTimestamps(run.result.topic);
    // T10-M2: the node's tail falls back to msg.topic = 'SELECT 1' for an
    // unrecognized commandType, so a misspelled sample here would compare
    // 'SELECT 1' with 'SELECT 1' and prove nothing -- assert the fixture (and
    // the run) never degrade to that no-op statement.
    assert.notEqual(BASE_COMMIT_TOPIC_FIXTURES[cmd.commandType], 'SELECT 1', cmd.commandType + ': fixture must not be the unrecognized-command fallback');
    assert.notEqual(topic, 'SELECT 1', cmd.commandType + ': must not fall through to the unrecognized-command fallback');
    assert.equal(topic, BASE_COMMIT_TOPIC_FIXTURES[cmd.commandType], cmd.commandType + ': SQL must match the frozen base-commit fixture (modulo the normalized timestamp)');
  });
}
