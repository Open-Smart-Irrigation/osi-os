#!/usr/bin/env node
'use strict';
// rehearse-devices-type-migration.test.js - a POPULATED gateway must survive the
// devices table rebuild that a new devices.type_id member forces.
//
// Adding a device type means rebuilding devices, because SQLite cannot ALTER a
// CHECK in place. devices is the parent table of the edge database: eleven tables
// hold ON DELETE CASCADE foreign keys to it, and a rebuild that lets those fire
// destroys irreplaceable farm history. That is not hypothetical - it is the
// documented Uganda incident class (docs/operations/edge-history-retention.md).
//
// The standing gates do not cover this case:
//   * verify-seed-replay.js  replays every migration into a scratch database and
//                            diffs fingerprints against seed-blank.sql, but it runs
//                            against an EMPTY database, so no cascade can fire and
//                            no row can be observed to survive.
//   * verify-db-schema-consistency / verify-seed-db-ledger inspect the shipped
//                            bundled images, which also carry no device rows.
//   * rehearse-devices-rebuild.test.js covers the BOOT NODE's rebuild of the same
//                            table, not the MIGRATION RUNNER's.
//
// So this file carries the populated-cascade case. It builds a gateway at a
// pre-rebuild schema head with lib/osi-migrate's real runner, seeds devices plus
// rows in every cascading child, carries it to head through applyPending exactly
// as deploy.sh's migrate-cli does, and asserts that nothing was lost or altered.
//
// WHAT THE ROW COMPARISON HAS TO CATCH, and why it is built the way it is: the
// realistic failure here is not "the table vanished", it is a wrong column list in
// the rebuild's INSERT...SELECT - a dropped column or two columns transposed. The
// migration that prompted this file came within one careless `cp` of dropping
// sdi12_value_count and sdi12_channel_layout_json, which a precedent written before
// those columns existed does not mention. So:
//   * the before/after comparison covers EVERY column (SELECT *), not a readable
//     subset - a subset is blind to exactly that bug;
//   * every column of a seeded device gets a value unique to (row, column), so two
//     transposed columns differ after the swap instead of quietly matching. A
//     comparison over columns that are all NULL proves nothing;
//   * one device is seeded with every nullable column NULL, so a copy that turns
//     NULL into '' or 0 is caught too;
//   * the column list itself is compared, so a dropped column reports as a missing
//     column rather than as a wall of row diffs.
//
// Heads under test are the two real gateways that took migration 0060 (osi-os
// RAK10701 coverage program, 2026-09-22; numbered 0059 at authoring time and
// renumbered to 0060 before merge to avoid colliding with main's own
// 0059__sync_rejection_recovery.sql, #351): the target gateway at 56 and
// the test gateway at 53, both confirmed at 45 devices columns. Keep a case here
// for whichever heads the fleet is actually on when a future type is added; the
// point is a populated database crossing the rebuild, not these particular numbers.
//
// All fixtures are synthetic. No real DevEUI, gateway identity or site data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { cliRunner } = require(path.join(ROOT, 'lib/osi-migrate/runner-iface'));
const { bootstrapFresh, applyPending } = require(path.join(ROOT, 'lib/osi-migrate'));

const MIGRATIONS_DIR = path.join(ROOT, 'database/migrations/ordered');

const NEW_TYPE = 'RAK10701_FIELD_TESTER';
const NOT_A_TYPE = 'DEFINITELY_NOT_A_DEVICE_TYPE';

// Synthetic identities. 'FFFF' is not a real vendor OUI.
const eui = (n) => `FFFF0000000000${String(n).padStart(2, '0')}`;
const NEW_TYPE_EUI = eui(90);
const TS = '2026-01-01T00:00:00.000Z';
const ZONE_ID = 1;
const USER_ID = 1;
const FARM_ID = 'FARM-REHEARSAL-0001';

// Every pre-0060 member of the CHECK, so the copy is exercised across the whole
// vocabulary rather than one representative value.
const SEEDED_TYPES = ['KIWI_SENSOR', 'STREGA_VALVE', 'DRAGINO_LSN50', 'TEKTELIC_CLOVER',
  'SENSECAP_S2120', 'AQUASCOPE_LORAIN', 'MILESIGHT_UC512', 'DRAGINO_SDI12'];

const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Columns whose value is not free: a CHECK vocabulary, a foreign key, or an identity
// the rest of the fixture depends on. Everything else is filled generically below.
function constrainedValue(name, deviceIndex, type) {
  switch (name) {
    case 'deveui': return sq(eui(deviceIndex));
    case 'type_id': return sq(type);
    case 'current_state': return deviceIndex % 2 ? "'OPEN'" : "'CLOSED'";
    case 'target_state': return deviceIndex % 2 ? "'CLOSED'" : "'OPEN'";
    case 'sdi12_probe_status':
      return sq(['pending_identify', 'identified', 'unmatched', 'manual'][deviceIndex % 4]);
    case 'sdi12_value_count': return String((deviceIndex % 8) + 1); // CHECK BETWEEN 1 AND 8
    case 'user_id': return String(USER_ID);
    case 'farm_id': return sq(FARM_ID);
    case 'irrigation_zone_id': return String(ZONE_ID);
    // A soft-deleted device must survive the rebuild like any other row.
    case 'deleted_at': return deviceIndex === 2 ? sq(TS) : null;
    case 'soil_moisture_probe_depths_json': return sq('{"depths":[10,20,30]}');
    case 'sdi12_channel_layout_json': return sq(`{"version":1,"address":"${deviceIndex}"}`);
    default: return null;
  }
}

// A value unique to (deviceIndex, cid) so two transposed columns cannot match.
function genericValue(col, deviceIndex) {
  const tag = `${deviceIndex * 1000 + col.cid}`;
  const t = String(col.type || '').toUpperCase();
  if (t.includes('INT')) return tag;
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return `${tag}.5`;
  return sq(`d${deviceIndex}c${col.cid}`);
}

// Builds the devices INSERT from the live column list rather than a hardcoded one, so
// a column added by a future migration is seeded automatically instead of silently
// staying NULL and dropping out of the transposition check.
function deviceInsert(columns, deviceIndex, type, { sparse }) {
  const names = [];
  const values = [];
  for (const col of columns) {
    if (col.name === 'id') continue; // let AUTOINCREMENT assign; the copy must preserve it
    const constrained = constrainedValue(col.name, deviceIndex, type);
    let value;
    if (constrained !== null) {
      value = constrained;
    } else if (sparse) {
      // The all-NULL row: only the NOT NULL columns get a value.
      if (!col.notnull) continue;
      value = genericValue(col, deviceIndex);
    } else {
      value = genericValue(col, deviceIndex);
    }
    names.push(col.name);
    values.push(value);
  }
  return `INSERT INTO devices (${names.join(',')}) VALUES (${values.join(',')});`;
}

// One row per device in every table that cascades from devices. Keyed by table name so
// the assertion below can prove no discovered child is left unseeded - a child with no
// rows makes its own "0 -> 0" check vacuous, which is how a cascade could hide.
const CHILD_SEEDS = {
  device_data: (e, i) => `INSERT INTO device_data (deveui,recorded_at,swt_wm1) VALUES (${sq(e)},${sq(TS)},${10 + i});`,
  dendrometer_readings: (e, i) => `INSERT INTO dendrometer_readings (deveui,recorded_at,position_um) VALUES (${sq(e)},${sq(TS)},${1000 + i});`,
  chameleon_readings: (e) => `INSERT INTO chameleon_readings (deveui,recorded_at) VALUES (${sq(e)},${sq(TS)});`,
  dendro_baselines: (e) => `INSERT INTO dendro_baselines (deveui) VALUES (${sq(e)});`,
  valve_settings: (e) => `INSERT INTO valve_settings (device_eui) VALUES (${sq(e)});`,
  weather_station_zone_state: (e) => `INSERT INTO weather_station_zone_state (deveui) VALUES (${sq(e)});`,
  weather_station_zones: (e) => `INSERT INTO weather_station_zones (deveui,zone_id) VALUES (${sq(e)},${ZONE_ID});`,
  zone_valve_assignments: (e, i) => `INSERT INTO zone_valve_assignments (zone_id,deveui,valve_channel) VALUES (${ZONE_ID},${sq(e)},${i});`,
  sdi12_identify_attempts: (e) => `INSERT INTO sdi12_identify_attempts (deveui,stage,requested_at,updated_at) VALUES (${sq(e)},'discovering',${sq(TS)},${sq(TS)});`,
  sdi12_recipe_deployments: (e) => `INSERT INTO sdi12_recipe_deployments (deveui,status,updated_at) VALUES (${sq(e)},'not_applied',${sq(TS)});`,
  // valve_schedules carries a table-level CHECK: kind='ONCE' additionally requires
  // fire_at IS NOT NULL and duration_minutes BETWEEN 1 AND 255.
  valve_schedules: (e, i) => `INSERT INTO valve_schedules (schedule_uuid,device_eui,kind,fire_at,duration_minutes,timezone) VALUES (${sq(`sched-${i}`)},${sq(e)},'ONCE',${sq(TS)},15,'UTC');`,
};

// Migrations 0001..upTo, copied into a scratch directory so bootstrapFresh builds a
// gateway that is genuinely behind head rather than one mutated after the fact.
function subsetDir(upTo, scratch) {
  const dir = path.join(scratch, `migrations-${upTo}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(MIGRATIONS_DIR)) {
    const m = /^(\d{4})__/.exec(name);
    if (m && Number(m[1]) <= upTo) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(dir, name));
    }
  }
  return dir;
}

const devicesColumns = async (runner) => (await runner.all('PRAGMA table_info(devices)'))
  .map((r) => ({ cid: Number(r.cid), name: r.name, type: r.type, notnull: Number(r.notnull) === 1 }));

async function tableCounts(runner, tables) {
  const out = {};
  for (const t of tables) out[t] = Number((await runner.all(`SELECT COUNT(*) AS n FROM ${t}`))[0].n);
  return out;
}

// Discovered, not hardcoded: a future migration that adds a twelfth cascading child
// must be covered by this test automatically, not silently skipped.
async function cascadingChildren(runner) {
  const rows = await runner.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%REFERENCES devices%' ORDER BY name");
  return rows.map((r) => r.name);
}

async function buildPopulatedGateway(head, scratch) {
  const dbPath = path.join(scratch, `gateway-${head}.db`);
  const runner = cliRunner(dbPath);
  await bootstrapFresh(runner, { migrationsDir: subsetDir(head, scratch), appVersion: `rehearsal-head-${head}` });

  // Referenced rows first: devices.user_id/farm_id/irrigation_zone_id and two of the
  // cascading children point at these, and PRAGMA foreign_key_check is asserted empty.
  await runner.exec(
    `INSERT INTO users (id,username,password_hash,created_at) VALUES (${USER_ID},'rehearsal','x',${sq(TS)});`
    + `INSERT INTO farms (farm_id,claim_code_hash) VALUES (${sq(FARM_ID)},'x');`
    + `INSERT INTO irrigation_zones (id,name,user_id) VALUES (${ZONE_ID},'rehearsal zone',${USER_ID});`);

  const columns = await devicesColumns(runner);
  const children = await cascadingChildren(runner);

  let sql = '';
  SEEDED_TYPES.forEach((type, i) => {
    // Device 0 is the sparse row: every nullable column stays NULL.
    sql += deviceInsert(columns, i, type, { sparse: i === 0 });
    for (const child of children) sql += CHILD_SEEDS[child](eui(i), i);
  });
  await runner.exec(sql);
  return { runner, columns, children };
}

async function rehearseHead(head) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `osi-devtype-${head}-`));
  try {
    const { runner, children } = await buildPopulatedGateway(head, scratch);

    // Witness the cascade is real in this schema before trusting any survival result.
    assert.ok(children.length >= 11,
      `expected at least 11 tables referencing devices, found ${children.length}`);
    assert.ok(children.includes('device_data') && children.includes('chameleon_readings'),
      'the two documented cascade victims must be among the discovered children');
    // A child with no fixture would make its own "0 -> 0" assertion vacuous, which is
    // precisely how a cascade into it could pass unnoticed. Fail loudly instead.
    const unseeded = children.filter((t) => !CHILD_SEEDS[t]);
    assert.deepEqual(unseeded, [],
      `these cascading children have no seed fixture, so their survival check would be vacuous: ${unseeded.join(', ')}`);

    const beforeCounts = await tableCounts(runner, ['devices', ...children]);
    const beforeColumns = (await devicesColumns(runner)).map((c) => c.name);
    const beforeRows = await runner.all('SELECT * FROM devices ORDER BY deveui');

    assert.equal(beforeCounts.devices, SEEDED_TYPES.length);
    for (const child of children) {
      assert.equal(beforeCounts[child], SEEDED_TYPES.length,
        `${child} must be seeded for its survival check to mean anything`);
    }
    // The two columns a careless copy of the pre-0028 precedent would have dropped.
    for (const c of ['sdi12_value_count', 'sdi12_channel_layout_json']) {
      assert.ok(beforeColumns.includes(c), `fixture must exercise ${c}`);
    }

    // Exactly how deploy.sh's migrate-cli carries a live gateway to head.
    await applyPending(runner, {
      migrationsDir: MIGRATIONS_DIR, appVersion: 'rehearsal', writersStopped: true,
    });

    const afterCounts = await tableCounts(runner, ['devices', ...children]);
    const afterColumns = (await devicesColumns(runner)).map((c) => c.name);
    const afterRows = await runner.all('SELECT * FROM devices ORDER BY deveui');

    for (const t of Object.keys(beforeCounts)) {
      assert.equal(afterCounts[t], beforeCounts[t],
        `${t}: ${beforeCounts[t]} -> ${afterCounts[t]} - rows lost crossing the devices rebuild at head ${head}`);
    }
    // Reported separately from the row diff so a dropped column says so plainly.
    assert.deepEqual(afterColumns, beforeColumns,
      `devices column list changed across the rebuild at head ${head}`);
    // Every column of every row, values unique per (row, column): catches a dropped
    // column, a transposed pair, and a NULL silently becoming '' or 0.
    assert.deepEqual(afterRows, beforeRows,
      `devices row content changed across the rebuild at head ${head}`);

    // The rebuild's whole purpose, and that it did not widen into "accepts anything".
    await runner.exec('INSERT INTO devices (deveui,name,type_id,created_at,updated_at)'
      + ` VALUES (${sq(NEW_TYPE_EUI)},'field tester',${sq(NEW_TYPE)},${sq(TS)},${sq(TS)});`);
    await assert.rejects(
      () => runner.exec('INSERT INTO devices (deveui,name,type_id,created_at,updated_at)'
        + ` VALUES (${sq(eui(91))},'x',${sq(NOT_A_TYPE)},${sq(TS)},${sq(TS)});`),
      `devices.type_id CHECK must still reject ${NOT_A_TYPE}`);

    assert.deepEqual(await runner.all('PRAGMA foreign_key_check'), [],
      `foreign_key_check must be empty after the rebuild at head ${head}`);
    assert.equal((await runner.all('PRAGMA integrity_check'))[0].integrity_check, 'ok');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

for (const head of [53, 56]) {
  test(`populated gateway at schema head ${head} reaches head with no row lost or altered by the devices rebuild`,
    async () => { await rehearseHead(head); });
}
