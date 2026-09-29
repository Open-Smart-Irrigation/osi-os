#!/usr/bin/env node
'use strict';

// Legacy UPSERT_ZONE_CONFIG and UPSERT_ZONE branches of node 4f4a765f36cee6f3
// ("Build UPDATE SQL") and the zone stage start date (spec
// docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, B5). Builds
// the statement with the shipped function-node source and runs it against a
// seeded database, so the assertions are about the row, not the SQL string.
// The stage-date rules: controller rulings cloud/sync I7 (a change to unset
// clears) and plan review E2 I2 (another set stage without a date starts today).
//
// Run: node --test scripts/test-legacy-upsert-zone-config.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { executeFunction, loadNode } = require('./lib/scoped-access-harness');
const { normalizeStage } = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc');

const ROOT = path.resolve(__dirname, '..');
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const GATEWAY = '00000000000000B1';
const ZONE_UUID = '44444444-4444-4444-8444-444444444444';
const USER_UUID = '55555555-5555-4555-8555-555555555555';

function fixture({ stage = 'development', startedOn = '2026-04-20', withZone = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(SEED);
  db.exec("INSERT INTO users(id, username, password_hash, created_at, user_uuid, role, sync_version) "
    + `VALUES (1,'grower','x','2026-01-01','${USER_UUID}','admin',1)`);
  if (withZone) {
    db.prepare('INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, gateway_device_eui, sync_version, timezone, '
      + "phenological_stage, stage_started_on, created_at, updated_at) VALUES (1, 'North', 1, ?, ?, 3, 'UTC', ?, ?, '2026-01-01', '2026-01-01')")
      .run(ZONE_UUID, GATEWAY, stage, startedOn);
  }
  return db;
}

async function apply(db, cmd) {
  const run = await executeFunction(loadNode('4f4a765f36cee6f3'), {
    msg: { payload: { zoneUuid: ZONE_UUID, syncVersion: 9, ...cmd } },
    env: { DEVICE_EUI: GATEWAY },
    db,
  });
  assert.equal(typeof run.result.topic, 'string', 'the node must build a statement');
  db.exec(run.result.topic);
  return run;
}

function row(db) {
  return { ...db.prepare('SELECT phenological_stage, stage_started_on, notes FROM irrigation_zones WHERE zone_uuid = ?').get(ZONE_UUID) };
}

// Today in a timezone, read the way the node reads it, before and after a call:
// either value passes, so a midnight during the run cannot fail a test.
function localToday(timezone) {
  const p = {};
  for (const part of new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}
async function todayAround(timezone, work) {
  const before = localToday(timezone);
  await work();
  return [before, localToday(timezone)];
}

const CONFIG = { commandType: 'UPSERT_ZONE_CONFIG' };

test('UPSERT_ZONE_CONFIG: stageStartedOn sets, null clears, the snake-case key works', async () => {
  const db = fixture();
  try {
    await apply(db, { ...CONFIG, stageStartedOn: '2026-05-01' });
    assert.equal(row(db).stage_started_on, '2026-05-01');
    await apply(db, { ...CONFIG, stageStartedOn: null });
    assert.equal(row(db).stage_started_on, null);
    await apply(db, { ...CONFIG, stage_started_on: '2026-05-02' });
    assert.equal(row(db).stage_started_on, '2026-05-02');
  } finally {
    db.close();
  }
});

test('UPSERT_ZONE_CONFIG: an absent key leaves the column; an invalid date leaves it and warns once with the zone UUID', async () => {
  const db = fixture();
  try {
    const quiet = await apply(db, { ...CONFIG, notes: 'no date' });
    assert.deepEqual([row(db).stage_started_on, row(db).notes], ['2026-04-20', 'no date']);
    assert.deepEqual(quiet.warnings, []);
    const bad = await apply(db, { ...CONFIG, stageStartedOn: '2026-02-30', notes: 'kept going' });
    assert.deepEqual([row(db).stage_started_on, row(db).notes], ['2026-04-20', 'kept going']);
    assert.equal(bad.warnings.length, 1);
    assert.match(bad.warnings[0], new RegExp(ZONE_UUID));
  } finally {
    db.close();
  }
});

test('UPSERT_ZONE_CONFIG: a stage change from development to default clears the date, whatever the command says about it', async () => {
  const db = fixture();
  try {
    await apply(db, { ...CONFIG, phenologicalStage: 'default', stageStartedOn: '2026-05-01' });
    assert.deepEqual([row(db).phenological_stage, row(db).stage_started_on], ['default', null]);
  } finally {
    db.close();
  }
});

test('UPSERT_ZONE_CONFIG: a notes-only command with stage default on a zone already unset leaves the date; a set stage then starts today', async () => {
  const db = fixture({ stage: 'default', startedOn: '2026-04-20' });
  try {
    await apply(db, { ...CONFIG, phenologicalStage: 'default', notes: 'notes only' });
    assert.deepEqual([row(db).stage_started_on, row(db).notes], ['2026-04-20', 'notes only']);
    const days = await todayAround('UTC', () => apply(db, { ...CONFIG, phenological_stage: 'mid_season' }));
    assert.equal(row(db).phenological_stage, 'mid_season');
    assert.ok(days.includes(row(db).stage_started_on), 'unset to a set stage starts it today (UTC: the command names no timezone)');
  } finally {
    db.close();
  }
});

test('UPSERT_ZONE_CONFIG: another set stage without a date starts on the command zone-local today; the same stage keeps it; a supplied date wins', async () => {
  const db = fixture({ stage: 'development', startedOn: '2026-04-20' });
  try {
    // A UTC+14 zone: its date, not the gateway's.
    const days = await todayAround('Pacific/Kiritimati', () => apply(db, { ...CONFIG, phenologicalStage: 'late_season', timezone: 'Pacific/Kiritimati' }));
    assert.ok(days.includes(row(db).stage_started_on), String(row(db).stage_started_on));
    db.prepare("UPDATE irrigation_zones SET stage_started_on = '2026-08-01' WHERE zone_uuid = ?").run(ZONE_UUID);
    await apply(db, { ...CONFIG, phenologicalStage: 'harvest', timezone: 'Pacific/Kiritimati' });
    assert.equal(row(db).stage_started_on, '2026-08-01', 'harvest is the late season: the same stage keeps the date');
    await apply(db, { ...CONFIG, phenologicalStage: 'mid_season', stageStartedOn: '2026-07-15' });
    assert.equal(row(db).stage_started_on, '2026-07-15', 'a supplied date wins');
    const before = localToday('UTC');
    const bad = await apply(db, { ...CONFIG, phenologicalStage: 'initial', stageStartedOn: '2026-02-30' });
    const after = localToday('UTC');
    assert.ok([before, after].includes(row(db).stage_started_on), 'an invalid date is ignored with its warning, so the stage change starts today');
    // E-M1: the changed-stage case warns that the value is ignored (the rule
    // then decides the date), not that the stored date is kept -- it is not.
    assert.equal(bad.warnings.length, 1);
    assert.match(bad.warnings[0], /; ignoring the value$/);
  } finally {
    db.close();
  }
});

test('the node treats a stored stage as set exactly when osi-crop-kc normalizeStage maps it', async () => {
  for (const stored of ['initial', 'development', 'mid_season', 'late_season', 'dormancy', 'budbreak', 'bud_break', 'fruitset', 'cell_division', 'cell_expansion', 'veraison', 'fruit_maturation', 'harvest', 'post_harvest', ' Veraison ', 'default', '', null, 'flowering', 'mid-season']) {
    const db = fixture({ stage: stored, startedOn: '2026-04-20' });
    try {
      await apply(db, { ...CONFIG, phenologicalStage: 'default' });
      assert.equal(row(db).stage_started_on, normalizeStage(stored) ? null : '2026-04-20', JSON.stringify(stored));
    } finally {
      db.close();
    }
  }
});

test('legacy UPSERT_ZONE: inserts the valid date or NULL; on conflict a supplied date wins, the same stage keeps it, another set stage starts today, unset clears it', async () => {
  const db = fixture({ withZone: false });
  try {
    const upsert = { commandType: 'UPSERT_ZONE', name: 'North', gatewayDeviceEui: GATEWAY, user: { userUuid: USER_UUID } };
    await apply(db, upsert);
    assert.equal(row(db).stage_started_on, null);
    await apply(db, { ...upsert, syncVersion: 10, phenologicalStage: 'development', stageStartedOn: '2026-05-01' });
    assert.equal(row(db).stage_started_on, '2026-05-01');
    await apply(db, { ...upsert, syncVersion: 11, phenologicalStage: 'development' });
    assert.equal(row(db).stage_started_on, '2026-05-01', 'the same stage keeps the date');
    const bad = await apply(db, { ...upsert, syncVersion: 12, phenologicalStage: 'development', stageStartedOn: '01.05.2026' });
    assert.equal(row(db).stage_started_on, '2026-05-01');
    assert.equal(bad.warnings.length, 1);
    const days = await todayAround('Pacific/Kiritimati', () => apply(db, { ...upsert, syncVersion: 13, phenologicalStage: 'late_season', timezone: 'Pacific/Kiritimati' }));
    assert.ok(days.includes(row(db).stage_started_on), 'another set stage starts on the zone-local today');
    await apply(db, { ...upsert, syncVersion: 14, stageStartedOn: null });
    assert.equal(row(db).stage_started_on, null, 'a full upsert without a stage stores default (unset), which clears the date');
  } finally {
    db.close();
  }
});
