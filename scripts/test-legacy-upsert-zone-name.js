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
const { execFileSync } = require('node:child_process');
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
// for many other command types. Prove the other branches are untouched by
// loading this node's source as it stood at this task's base commit and
// diffing the built msg.topic for a representative sample against the same
// commands run through the edited source. The only expected difference is the
// live `now = new Date().toISOString()` timestamp each run captures
// independently, so timestamps are normalized out before comparing.
const BASE_COMMIT = 'b0c60c9df';
const FLOWS_REL = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

function baseNode() {
  const baseFlows = JSON.parse(execFileSync(
    'git', ['show', BASE_COMMIT + ':' + FLOWS_REL],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 67108864 }
  ));
  const node = baseFlows.find((n) => n.id === '4f4a765f36cee6f3');
  assert.ok(node, BASE_COMMIT + ' must still carry node 4f4a765f36cee6f3');
  return node;
}

test('every other command type still builds the same SQL as the base commit', async () => {
  const base = baseNode();
  const head = loadNode('4f4a765f36cee6f3');
  const env = { DEVICE_EUI: GATEWAY };
  const cases = [
    { commandType: 'UPSERT_ZONE_CONFIG', zoneUuid: ZONE_UUID, cropType: 'olive', notes: 'n', appliedSyncVersion: 3 },
    { commandType: 'DELETE_ZONE', zoneUuid: ZONE_UUID, appliedSyncVersion: 4 },
    { commandType: 'UPSERT_DEVICE_FLAGS', deviceEui: 'AABBCCDDEEFF0011', dendroEnabled: true, appliedSyncVersion: 2 },
  ];
  for (const cmd of cases) {
    const baseRun = await executeFunction(base, { msg: { payload: cmd }, env });
    const headRun = await executeFunction(head, { msg: { payload: cmd }, env });
    const normalize = (topic) => String(topic).replace(ISO_TIMESTAMP, 'TS');
    assert.equal(
      normalize(headRun.result.topic),
      normalize(baseRun.result.topic),
      cmd.commandType + ': SQL must be byte-identical to the base commit (modulo the live timestamp)'
    );
  }
});
