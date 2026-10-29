'use strict';

// Legacy threshold scheduler: which SWT values may reach "Decide + build
// actuator cmd". Runs the shipped query builder and decision node of both
// maintained profiles against the real seed schema (database/seed-blank.sql).
// No output wire is followed and no event SQL is executed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { executeFunction, loadNode } = require('./lib/flow-node-harness');

const root = path.resolve(__dirname, '..');
const PROFILES = {
  bcm2712: path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'),
  bcm2709: path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'),
};
const QUERY_ID = 'd0b2b1c1a937e16d';
const DECISION_ID = '5f0d2b7e9b9b1b3a';
const KIWI = 'A840410000000011';
const SDI12 = 'A840410000000012';
const CLOVER = 'A840410000000013';
const CHAMELEON = 'A840410000000014';
const VALVE = 'A840410000000019';
const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(root, 'database/seed-blank.sql'), 'utf8'));
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(`
    INSERT INTO users (username, password_hash, created_at, user_uuid) VALUES ('owner', 'h', '2026-01-01', 'u-owner');
    INSERT INTO irrigation_zones (name, user_id, zone_uuid, timezone, scheduling_mode) VALUES
      ('Z One', 1, 'z-1', 'UTC', 'local'), ('Z Two', 1, 'z-2', 'UTC', 'local');`);
  const device = db.prepare(`INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, chameleon_enabled, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, '2026-01-01', '2026-01-01')`);
  for (const [eui, type, zone, chameleon] of [
    [KIWI, 'KIWI_SENSOR', 1, 0], [SDI12, 'DRAGINO_SDI12', 1, 0], [CLOVER, 'TEKTELIC_CLOVER', 1, 0],
    [CHAMELEON, 'DRAGINO_LSN50', 1, 1], [VALVE, 'STREGA_VALVE', 1, 0],
  ]) device.run(eui, eui, type, zone, chameleon);
  return db;
}

function reading(db, deveui, { at = minutesAgo(5), swt1 = null, swt2 = null, swt3 = null, wm1 = null, wm2 = null } = {}) {
  return Number(db.prepare(`INSERT INTO device_data (deveui, recorded_at, swt_1, swt_2, swt_3, swt_wm1, swt_wm2)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(deveui, at, swt1, swt2, swt3, wm1, wm2).id);
}

const CLEAN = { i2c_missing: 0, timeout: 0, data_invalid: 0, ch1_open: 0, ch2_open: 0, ch3_open: 0 };
function diagnostic(db, deveui, flags = CLEAN, at = minutesAgo(5)) {
  const f = { ...CLEAN, ...flags };
  return Number(db.prepare(`INSERT INTO chameleon_readings (deveui, recorded_at, i2c_missing, timeout, data_invalid, ch1_open, ch2_open, ch3_open)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(deveui, at, f.i2c_missing, f.timeout, f.data_invalid, f.ch1_open, f.ch2_open, f.ch3_open).id);
}

function link(db, readingId, dataId) {
  db.prepare('INSERT INTO chameleon_reading_links (chameleon_reading_id, device_data_id) VALUES (?, ?)').run(readingId, dataId);
}

// A Chameleon canonical row linked to its own diagnostic, as ingest writes it.
function chameleonRow(db, values, flags = CLEAN) {
  const at = values.at || minutesAgo(5);
  const dataId = reading(db, CHAMELEON, { ...values, at });
  link(db, diagnostic(db, CHAMELEON, flags, at), dataId);
  return dataId;
}

async function schedule(profile, db, metric) {
  const flowsPath = PROFILES[profile];
  const buildQuery = new Function('msg', loadNode(QUERY_ID, flowsPath).func); // eslint-disable-line no-new-func
  const zone = {
    zone_id: 1, zone_name: 'Z One', user_id: 1, scheduling_mode: 'local', trigger_metric: metric,
    threshold_kpa: 50, duration_minutes: 10, enabled: 1, last_triggered_at: null,
    enabled_scope_holders: 1, valve_deveui: VALVE, shared_environment_json: null,
  };
  const query = buildQuery({ payload: zone });
  const row = { ...db.prepare(query.topic).get() };
  const { result } = await executeFunction(loadNode(DECISION_ID, flowsPath), { msg: { payload: [row], zone: query.zone }, db });
  return { row, result };
}

function assertNoData({ row, result }) {
  assert.equal(row.n_points, 0, 'no eligible value: ' + JSON.stringify(row));
  assert.equal(row.mean_kpa, null);
  assert.equal(result[0], null, 'no actuator message');
  assert.equal(result[2], null, 'last_triggered_at is not advanced');
  assert.match(result[1].topic, /'SKIP', 'no_data_last_hour'/);
}

// The decision node returns [{ payload: cmd, ... }, event, schedule update];
// cmd is { type: 'actuator_command', device: { devEui }, data: { action, ... } }.
function assertOpenCommand(result) {
  const command = result[0];
  assert.ok(command && command.payload && command.payload.data, 'an actuator message: ' + JSON.stringify(command));
  assert.equal(command.payload.type, 'actuator_command');
  assert.equal(command.payload.device.devEui, VALVE);
  assert.equal(command.payload.data.action, 'OPEN_FOR_DURATION');
  assert.equal(command.payload.data.reason, 'scheduler_threshold');
  assert.match(result[1].topic, /'IRRIGATE', 'scheduler_threshold'/);
}

function assertMean({ row, result }, n, mean, opens) {
  assert.equal(row.n_points, n, JSON.stringify(row));
  assert.equal(row.mean_kpa, mean);
  if (opens) assertOpenCommand(result);
  else assert.equal(result[0], null);
}

const cases = [
  // Controls carried over from the previous version of this test.
  ['KIWI, Tensiomark and a linked Chameleon count equally (SWT_1)', 'SWT_1', (db) => {
    reading(db, KIWI, { swt1: 30, swt2: 50 }); reading(db, SDI12, { swt1: 30, swt2: 50 }); chameleonRow(db, { swt1: 30, swt2: 50 });
  }, (out) => assertMean(out, 3, 30, false)],
  ['KIWI, Tensiomark and a linked Chameleon count equally (SWT_2)', 'SWT_2', (db) => {
    reading(db, KIWI, { swt1: 30, swt2: 50 }); reading(db, SDI12, { swt1: 30, swt2: 50 }); chameleonRow(db, { swt1: 30, swt2: 50 });
  }, (out) => assertMean(out, 3, 50, true)],
  ['KIWI, Tensiomark and a linked Chameleon count equally (SWT_AVG)', 'SWT_AVG', (db) => {
    reading(db, KIWI, { swt1: 30, swt2: 50 }); reading(db, SDI12, { swt1: 30, swt2: 50 }); chameleonRow(db, { swt1: 30, swt2: 50 });
  }, (out) => assertMean(out, 3, 40, false)],
  ['a WATERMARK-linked row stays out even with a clean Chameleon link or a rejected frame', 'SWT_1', (db) => {
    reading(db, KIWI, { swt1: 30 });
    const linked = chameleonRow(db, { swt1: 90 });
    db.prepare("INSERT INTO watermark_readings (deveui, recorded_at, device_data_id, payload_hex, frame_status, conversion_version) VALUES (?, ?, ?, '00', 'frame_rejected', 'test')")
      .run(CHAMELEON, minutesAgo(5), linked);
  }, (out) => assertMean(out, 1, 30, false)],
  ['missing channels and rows older than one hour are excluded; a measured Tensiomark zero counts', 'SWT_1', (db) => {
    reading(db, KIWI, { swt1: null, swt2: 40 }); reading(db, SDI12, { swt1: 0 }); chameleonRow(db, { swt1: 30 });
    chameleonRow(db, { swt1: 99, at: minutesAgo(70) });
  }, (out) => assertMean(out, 2, 15, false)],

  // Durable link (user decision 1).
  ['a linked clean Chameleon value drives the decision', 'SWT_1', (db) => { chameleonRow(db, { swt1: 80 }); }, (out) => assertMean(out, 1, 80, true)],
  ['an unlinked Chameleon value is excluded', 'SWT_1', (db) => { reading(db, CHAMELEON, { swt1: 80 }); }, assertNoData],
  ['a unique same-timestamp diagnostic does not stand in for a link', 'SWT_1', (db) => {
    const at = minutesAgo(5); reading(db, CHAMELEON, { swt1: 80, at }); diagnostic(db, CHAMELEON, CLEAN, at);
  }, assertNoData],
  ['a newer clean diagnostic does not clear an unlinked row', 'SWT_1', (db) => {
    reading(db, CHAMELEON, { swt1: 80, at: minutesAgo(20) }); diagnostic(db, CHAMELEON, CLEAN, minutesAgo(1));
  }, assertNoData],
  ['each row is judged by its own diagnostic, not the latest one', 'SWT_1', (db) => {
    chameleonRow(db, { swt1: 80, at: minutesAgo(30) }, { i2c_missing: 1 }); chameleonRow(db, { swt1: 40, at: minutesAgo(5) });
  }, (out) => assertMean(out, 1, 40, false)],
  ['duplicate canonical timestamps are told apart by their links', 'SWT_1', (db) => {
    const at = minutesAgo(5); chameleonRow(db, { swt1: 80, at }, { timeout: 1 }); chameleonRow(db, { swt1: 40, at });
  }, (out) => assertMean(out, 1, 40, false)],

  // Diagnostic flags on the linked row.
  ['I2C missing drops the row', 'SWT_1', (db) => { chameleonRow(db, { swt1: 80 }, { i2c_missing: 1 }); }, assertNoData],
  ['timeout drops the row', 'SWT_1', (db) => { chameleonRow(db, { swt1: 80 }, { timeout: 1 }); }, assertNoData],
  ['V2 data-invalid drops the row', 'SWT_1', (db) => {
    chameleonRow(db, { swt1: 80 }, { i2c_missing: null, timeout: null, data_invalid: 1, ch1_open: null, ch2_open: null, ch3_open: null });
  }, assertNoData],
  ['a clean V2 diagnostic (no I2C or timeout fields) counts', 'SWT_1', (db) => {
    chameleonRow(db, { swt1: 80 }, { i2c_missing: null, timeout: null });
  }, (out) => assertMean(out, 1, 80, true)],
  ['channel 2 open drops channel 2', 'SWT_2', (db) => { chameleonRow(db, { swt1: 40, swt2: 80 }, { ch2_open: 1 }); }, assertNoData],
  ['channel 2 open keeps channel 1', 'SWT_1', (db) => { chameleonRow(db, { swt1: 40, swt2: 80 }, { ch2_open: 1 }); }, (out) => assertMean(out, 1, 40, false)],
  ['channel 2 open leaves SWT_AVG with channel 1 only', 'SWT_AVG', (db) => { chameleonRow(db, { swt1: 40, swt2: 80 }, { ch2_open: 1 }); }, (out) => assertMean(out, 1, 40, false)],
  ['channel 3 open drops channel 3', 'SWT_3', (db) => { chameleonRow(db, { swt3: 80 }, { ch3_open: 1 }); }, assertNoData],
  ['channel 1 open drops channel 1', 'SWT_1', (db) => { chameleonRow(db, { swt1: 80, swt2: 40 }, { ch1_open: 1 }); }, assertNoData],

  // Source domains (user decision 2).
  ['a Chameleon 301 kPa is outside the converter range', 'SWT_1', (db) => { chameleonRow(db, { swt1: 301 }); }, assertNoData],
  ['a Chameleon 300 kPa counts', 'SWT_1', (db) => { chameleonRow(db, { swt1: 300 }); }, (out) => assertMean(out, 1, 300, true)],
  ['a Chameleon measured zero counts', 'SWT_1', (db) => { chameleonRow(db, { swt1: 0 }); }, (out) => assertMean(out, 1, 0, false)],
  ['a KIWI 301 kPa counts', 'SWT_1', (db) => { reading(db, KIWI, { swt1: 301 }); }, (out) => assertMean(out, 1, 301, true)],
  ['an SDI-12 301 kPa counts', 'SWT_1', (db) => { reading(db, SDI12, { swt1: 301 }); }, (out) => assertMean(out, 1, 301, true)],
  ['a CLOVER 301 kPa counts', 'SWT_1', (db) => { reading(db, CLOVER, { swt1: 301 }); }, (out) => assertMean(out, 1, 301, true)],
  ['a KIWI 1,000,000 kPa counts', 'SWT_1', (db) => { reading(db, KIWI, { swt1: 1000000 }); }, (out) => assertMean(out, 1, 1000000, true)],
  ['a negative KIWI value is excluded', 'SWT_1', (db) => { reading(db, KIWI, { swt1: -1 }); }, assertNoData],
  ['a KIWI value above 1,000,000 kPa is excluded', 'SWT_1', (db) => { reading(db, KIWI, { swt1: 1000001 }); }, assertNoData],
  ['an infinite KIWI value is excluded', 'SWT_1', (db) => { reading(db, KIWI, { swt1: Infinity }); }, assertNoData],
  ['a non-numeric stored value is excluded', 'SWT_1', (db) => { reading(db, KIWI, { swt1: 'invalid' }); }, assertNoData],
  ['a BLOB stored value is excluded', 'SWT_1', (db) => { reading(db, KIWI, { swt1: new Uint8Array([1, 2]) }); }, assertNoData],
  ['a row whose channels are all invalid yields no SWT_AVG value', 'SWT_AVG', (db) => { reading(db, KIWI, { swt1: -1, swt2: 1000001 }); }, assertNoData],

  // Alias precedence and averaging.
  ['the legacy alias fills a missing canonical channel', 'SWT_1', (db) => { reading(db, KIWI, { swt1: null, wm1: 45 }); }, (out) => assertMean(out, 1, 45, false)],
  ['an invalid canonical value does not fall back to its alias', 'SWT_1', (db) => { reading(db, KIWI, { swt1: -1, wm1: 45 }); }, assertNoData],
  ['SWT_AVG averages channels within a row before averaging rows', 'SWT_AVG', (db) => {
    reading(db, KIWI, { swt1: 40, swt2: 80 }); reading(db, SDI12, { swt1: 50 });
  }, (out) => assertMean(out, 2, 55, true)],
  ['SWT_1 weights each row once', 'SWT_1', (db) => { reading(db, KIWI, { swt1: 40 }); reading(db, SDI12, { swt1: 60 }); }, (out) => assertMean(out, 2, 50, true)],
  ['SWT_AVG keeps a fractional row mean', 'SWT_AVG', (db) => { reading(db, KIWI, { swt1: 41, swt2: 42 }); }, (out) => assertMean(out, 1, 41.5, false)],
  ['SWT_WM1 selects channel 1', 'SWT_WM1', (db) => { reading(db, KIWI, { swt1: 45, swt2: 80 }); }, (out) => assertMean(out, 1, 45, false)],
  ['SWT_WM2 selects channel 2', 'SWT_WM2', (db) => { reading(db, KIWI, { swt1: 45, swt2: 80 }); }, (out) => assertMean(out, 1, 80, true)],
  ['no rows means no data', 'SWT_1', () => {}, assertNoData],
];

for (const profile of Object.keys(PROFILES)) {
  for (const [name, metric, arrange, check] of cases) {
    test(`${profile}: ${name}`, async () => {
      const db = database();
      try {
        arrange(db);
        check(await schedule(profile, db, metric));
      } finally { db.close(); }
    });
  }

  test(`${profile}: the query associates diagnostics only through chameleon_reading_links`, () => {
    const func = loadNode(QUERY_ID, PROFILES[profile]).func;
    assert.match(func, /LEFT JOIN chameleon_reading_links crl\s+ON crl\.device_data_id = dd\.id/);
    assert.doesNotMatch(func, /recorded_at\s*=\s*dd\.recorded_at|dd\.recorded_at\s*=\s*cr\.recorded_at/);
    assert.doesNotMatch(func, /FROM chameleon_readings[^)]*ORDER BY/);
  });
}

test('both profiles ship the same query and decision bodies', () => {
  for (const id of [QUERY_ID, DECISION_ID]) {
    assert.equal(loadNode(id, PROFILES.bcm2709).func, loadNode(id, PROFILES.bcm2712).func, id);
  }
});
