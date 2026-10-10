'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const SCRIPT = path.join(__dirname, 'rain-history-diff.js');
const CSV_HEADER = 'deveui,instrument_type,zone_id,date,timezone,old_host_day_mm,old_zone_row_mm,old_rain_source,new_received_mm,new_coverage,new_selected_deveui,delta_mm,reasons';
const E1 = 'A840410000000001';
const E2 = 'A840410000000002';
const E3 = 'A840410000000003';
let legacyFixtureId = 0;

const TMP_ROOT = '/home/phil/.cache/osi-rain-continuation-20261010/task8-prep/tmp';
fs.mkdirSync(TMP_ROOT, { recursive: true });
function tmp() {
  return fs.mkdtempSync(path.join(TMP_ROOT, 'rain-diff-'));
}
function fixture(root) {
  const dbPath = path.join(root, 'legacy.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE irrigation_zones (id INTEGER PRIMARY KEY, name TEXT, timezone TEXT);
    CREATE TABLE devices (deveui TEXT PRIMARY KEY, type_id TEXT, irrigation_zone_id INTEGER, name TEXT);
    CREATE TABLE device_data (
      id INTEGER PRIMARY KEY, deveui TEXT, recorded_at TEXT, rain_mm_today REAL,
      rain_mm_delta REAL, rain_delta_status TEXT, rain_tips_delta INTEGER,
      flow_liters_delta REAL, rain_mm_per_hour REAL
    );
    CREATE TABLE zone_daily_environment (
      zone_id INTEGER, date TEXT, rainfall_mm REAL, rain_source TEXT, rain_selected_deveui TEXT, rain_coverage TEXT
    );
    INSERT INTO irrigation_zones VALUES (1, 'A, "Zone"', 'Europe/Zurich');
    INSERT INTO devices VALUES ('${E1}', 'AQUASCOPE_LORAIN', 1, 'Gauge, one');
    INSERT INTO devices VALUES ('${E2}', 'AQUASCOPE_LORAIN', 1, 'Gauge two');
    INSERT INTO devices VALUES ('${E3}', 'DRAGINO_LSN50', 1, 'Flow only');
  `);
  db.exec(`
    INSERT INTO device_data VALUES (1, '${E1}', '2026-03-29T19:00:00.000Z', 10, 1, 'ok', 2, NULL, NULL);
    INSERT INTO device_data VALUES (2, '${E1}', '2026-03-29T22:15:00.000Z', 10.5, 0.5, 'ok', 1, NULL, NULL);
    INSERT INTO device_data VALUES (3, '${E2}', '2026-03-29T20:30:00.000Z', 0, 2, 'ok', 4, NULL, NULL);
    INSERT INTO device_data VALUES (4, '${E3}', '2026-03-29T21:00:00.000Z', 0, 0, 'ok', 0, 0, NULL);
    INSERT INTO zone_daily_environment VALUES (1, '2026-03-29', 3, '=legacy, \"aggregate\"\nsecond line', NULL, NULL);
    INSERT INTO zone_daily_environment VALUES (1, '2026-03-30', 10.5, 'legacy_aggregate', NULL, NULL);
  `);
  db.close();
  return dbPath;
}
function provenanceFile(root, intervals = [
  { deveui: E1, zoneId: 1, timezone: 'Europe/Zurich', from: '2026-03-28T23:00:00Z', to: '2026-03-31T22:00:00Z', selected: false, sourceRef: 'synthetic:assignment-one' },
  { deveui: E2, zoneId: 1, timezone: 'Europe/Zurich', from: '2026-03-28T23:00:00Z', to: '2026-03-31T22:00:00Z', selected: false, sourceRef: 'synthetic:assignment-two' },
  { deveui: E3, zoneId: 1, timezone: 'Europe/Zurich', from: '2026-03-28T23:00:00Z', to: '2026-03-31T22:00:00Z', selected: false, sourceRef: 'synthetic:assignment-three' },
]) {
  const file = path.join(root, 'provenance.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, hostTimezone: 'UTC', intervals }));
  return file;
}
function legacyComparableDb(root, { old = 2, received = 3, source = 'local_gauge', days = ['2026-03-29'], observation = null } = {}) {
  const dbPath = path.join(root, `legacy-comparable-${legacyFixtureId++}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE irrigation_zones (id INTEGER PRIMARY KEY, timezone TEXT);
    CREATE TABLE devices (deveui TEXT, type_id TEXT, irrigation_zone_id INTEGER);
    CREATE TABLE device_data (id INTEGER PRIMARY KEY, deveui TEXT, recorded_at TEXT, rain_mm_today REAL, rain_mm_delta REAL, rain_delta_status TEXT);
    CREATE TABLE zone_daily_environment (zone_id INTEGER, date TEXT, rainfall_mm REAL, rain_source TEXT);
    INSERT INTO irrigation_zones VALUES (1, 'Europe/Zurich');
    INSERT INTO devices VALUES ('${E1}', 'AQUASCOPE_LORAIN', 1);`);
  let id = 1;
  for (const date of days) {
    db.prepare('INSERT INTO device_data VALUES (?, ?, ?, ?, ?, ?)').run(id++, E1, date + 'T10:00:00.000Z', received, received, 'ok');
    db.prepare('INSERT INTO zone_daily_environment VALUES (1, ?, ?, ?)').run(date, old, source);
  }
  if (observation) {
    db.exec('CREATE TABLE rain_observations (id INTEGER, device_data_id INTEGER, deveui TEXT, received_at TEXT, zone_id INTEGER, timezone TEXT)');
    db.prepare('INSERT INTO rain_observations VALUES (1, 1, ?, ?, ?, ?)').run(observation.deveui || E1, days[0] + 'T10:00:00.000Z', observation.zoneId, observation.timezone);
  }
  db.close();
  return dbPath;
}
function soleGaugeProvenance(root, from = '2026-03-28T23:00:00Z', to = '2026-04-07T22:00:00Z') {
  return provenanceFile(root, [{ deveui: E1, zoneId: 1, timezone: 'Europe/Zurich', from, to, selected: true, sourceRef: 'synthetic:sole-gauge-period' }]);
}
function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: '/home/phil/.cache/osi-rain-continuation-20261010/task8-prep/tmp' },
    timeout: 10000,
  });
}
function invoke(db, out, extra = []) {
  return run(['--db', db, '--from', '2026-03-29', '--to', '2026-03-31', '--out', out, ...extra]);
}
function parseCsv(contents) {
  const records = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < contents.length; i += 1) {
    const ch = contents[i];
    if (quoted && ch === '\"' && contents[i + 1] === '\"') { cell += '\"'; i += 1; }
    else if (ch === '\"') quoted = !quoted;
    else if (ch === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (ch === '\n' && !quoted) { row.push(cell); records.push(row); row = []; cell = ''; }
    else if (ch !== '\r' || quoted) cell += ch;
  }
  if (cell || row.length) { row.push(cell); records.push(row); }
  const header = records[0];
  assert.deepEqual(header, HEADER_NAMES);
  return records.slice(1).map((values) => Object.fromEntries(values.map((value, i) => [header[i], value])));
}
const HEADER_NAMES = CSV_HEADER.split(',');

test('reports per-device legacy received amounts without certifying gauge aggregates', () => {
  const root = tmp();
  try {
    const db = fixture(root);
    const out = path.join(root, 'out');
    const before = fs.readFileSync(db);
    const mtime = fs.statSync(db).mtimeMs;
    const sidecarsBeforeSuccess = fs.readdirSync(root).filter((name) => /legacy\.db-(wal|shm)$/.test(name)).sort();
    const result = invoke(db, out, ['--provenance', provenanceFile(root)]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const rows = parseCsv(fs.readFileSync(path.join(out, 'rain-diff-days.csv'), 'utf8'));
    const e1Mar29 = rows.find((row) => row.deveui === E1 && row.date === '2026-03-29');
    const e1Mar30 = rows.find((row) => row.deveui === E1 && row.date === '2026-03-30');
    const e2Mar29 = rows.find((row) => row.deveui === E2 && row.date === '2026-03-29');
    const flowZero = rows.find((row) => row.deveui === E3 && row.date === '2026-03-29');
    assert.equal(e1Mar29.timezone, 'Europe/Zurich');
    assert.equal(e1Mar29.new_received_mm, '1');
    assert.equal(e1Mar29.old_host_day_mm, '10.5', 'the retained running total is the last value from the known original UTC host day');
    assert.equal(e1Mar30.new_received_mm, '0.5', 'UTC 22:15 on the DST day is Zurich farm day 2026-03-30');
    assert.equal(e1Mar30.old_zone_row_mm, '10.5');
    assert.equal(e1Mar30.old_host_day_mm, '10.5');
    assert.ok(e1Mar30.reasons.includes('timezone_boundary'));
    assert.ok(e1Mar30.reasons.includes('host_day_carryover_suspected'));
    assert.equal(e1Mar30.delta_mm, '', 'an aggregate old row cannot be compared with one selected gauge without selection evidence');
    assert.ok(e1Mar30.reasons.includes('gauge_addition_suspected'));
    assert.ok(e1Mar29.reasons.includes('gauge_addition_suspected'));
    assert.equal(e2Mar29.new_received_mm, '2');
    assert.equal(e2Mar29.new_selected_deveui, '');
    assert.equal(flowZero.new_received_mm, '0');
    assert.ok(flowZero.reasons.includes('flow_only_zero'));
    assert.ok(rows.some((row) => row.date === '2026-03-31' && row.deveui === E1 && row.new_received_mm === '' && row.reasons.includes('dry_row_missing')));
    assert.equal(e1Mar29.old_rain_source, "'=legacy, \"aggregate\"\nsecond line");
    assert.ok(rows.every((row) => row.new_coverage === '' || row.new_coverage === 'received_only'));
    assert.deepEqual(fs.readFileSync(db), before);
    assert.equal(fs.statSync(db).mtimeMs, mtime);
    assert.deepEqual(fs.readdirSync(root).filter((name) => /legacy\.db-(wal|shm)$/.test(name)).sort(), sidecarsBeforeSuccess);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refuses unsafe database paths, malformed dates, output aliases, and WAL-bearing input', () => {
  const root = tmp();
  try {
    const db = fixture(root);
    assert.notEqual(invoke(path.join(root, 'missing.db'), path.join(root, 'missing-out')).status, 0);
    assert.notEqual(run(['--db', db, '--from', '2026-03-31', '--to', '2026-03-29', '--out', path.join(root, 'reverse')]).status, 0);
    assert.notEqual(run(['--db', '/data/farming.db', '--from', '2026-03-29', '--to', '2026-03-31', '--out', path.join(root, 'x')]).status, 0);
    assert.notEqual(invoke(db, path.join(root, 'x'), ['--from', '2026-02-30']).status, 0);
    assert.notEqual(invoke(db, db).status, 0);
    const wal = db + '-wal';
    fs.writeFileSync(wal, 'unaccounted');
    const before = fs.readFileSync(wal);
    const dbBeforeFailure = fs.readFileSync(db);
    const mtimeBeforeFailure = fs.statSync(db).mtimeMs;
    const sidecarsBeforeFailure = fs.readdirSync(root).filter((name) => /legacy\.db-(wal|shm)$/.test(name)).sort();
    const failed = invoke(db, path.join(root, 'safe'));
    assert.notEqual(failed.status, 0);
    assert.deepEqual(fs.readFileSync(wal), before);
    assert.deepEqual(fs.readFileSync(db), dbBeforeFailure);
    assert.equal(fs.statSync(db).mtimeMs, mtimeBeforeFailure);
    assert.deepEqual(fs.readdirSync(root).filter((name) => /legacy\.db-(wal|shm)$/.test(name)).sort(), sidecarsBeforeFailure);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('conflicting historical assignments and invalid provenance are refused', () => {
  const root = tmp();
  try {
    const db = fixture(root);
    const provenance = path.join(root, 'provenance.json');
    fs.writeFileSync(provenance, JSON.stringify({
      version: 1,
      hostTimezone: 'UTC',
      intervals: [
        { deveui: E1, zoneId: 1, timezone: 'Europe/Zurich', from: '2026-03-28T00:00:00Z', to: '2026-03-31T00:00:00Z', selected: true, sourceRef: 'synthetic:one' },
        { deveui: E1, zoneId: 2, timezone: 'Europe/Zurich', from: '2026-03-29T00:00:00Z', to: '2026-03-30T00:00:00Z', selected: true, sourceRef: 'synthetic:conflict' },
      ],
    }));
    assert.notEqual(invoke(db, path.join(root, 'out'), ['--provenance', provenance]).status, 0);
    const valid = provenanceFile(root);
    assert.notEqual(invoke(db, path.join(root, 'other-out'), ['--provenance', valid, '--host-timezone', 'Europe/Zurich']).status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('only proven sole-gauge full farm days receive numeric deltas; 23-hour DST window is respected', () => {
  const root = tmp();
  try {
    const db = fixture(root);
    const handle = new DatabaseSync(db);
    handle.prepare(`UPDATE zone_daily_environment SET rainfall_mm = 2, rain_source = 'local_gauge', rain_selected_deveui = '${E1}', rain_coverage = 'complete' WHERE date = '2026-03-29'`).run();
    handle.exec('CREATE TABLE rain_instrument_days (deveui TEXT, date TEXT, timezone TEXT, coverage TEXT); INSERT INTO rain_instrument_days VALUES (\'' + E1 + '\', \'2026-03-29\', \'Europe/Zurich\', \'complete\')');
    handle.prepare("UPDATE device_data SET rain_mm_delta = 3 WHERE id = 1").run();
    handle.prepare("DELETE FROM device_data WHERE deveui = ?").run(E2);
    handle.close();
    const prov = provenanceFile(root, [
      { deveui: E1, zoneId: 1, timezone: 'Europe/Zurich', from: '2026-03-28T23:00:00Z', to: '2026-03-31T22:00:00Z', selected: true, sourceRef: 'synthetic:sole-gauge' },
      { deveui: E3, zoneId: 1, timezone: 'Europe/Zurich', from: '2026-03-28T23:00:00Z', to: '2026-03-31T22:00:00Z', selected: false, sourceRef: 'synthetic:flow-device' },
    ]);
    const out = path.join(root, 'out');
    const rain = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-rain');
    assert.equal((Date.parse(rain.zoneDateWindow('2026-03-29', 'Europe/Zurich').endIso) - Date.parse(rain.zoneDateWindow('2026-03-29', 'Europe/Zurich').startIso)) / 3600000, 23);
    assert.equal((Date.parse(rain.zoneDateWindow('2026-10-25', 'Europe/Zurich').endIso) - Date.parse(rain.zoneDateWindow('2026-10-25', 'Europe/Zurich').startIso)) / 3600000, 25);
    const result = invoke(db, out, ['--provenance', prov]);
    assert.equal(result.status, 0, result.stderr);
    const rows = parseCsv(fs.readFileSync(path.join(out, 'rain-diff-days.csv'), 'utf8'));
    const match = rows.find((row) => row.deveui === E1 && row.date === '2026-03-29');
    assert.equal(match.new_received_mm, '3');
    assert.equal(match.old_zone_row_mm, '2');
    assert.equal(match.delta_mm, '1');
    assert.equal(match.new_selected_deveui, E1);
    assert.equal(match.new_coverage, 'received_only');
    const withoutSelectionDb = new DatabaseSync(db);
    withoutSelectionDb.prepare(`UPDATE zone_daily_environment SET rain_selected_deveui = NULL WHERE date = '2026-03-29'`).run();
    withoutSelectionDb.close();
    const unselectedProv = provenanceFile(root, [
      { deveui: E1, zoneId: 1, timezone: 'Europe/Zurich', from: '2026-03-28T23:00:00Z', to: '2026-03-31T22:00:00Z', selected: false, sourceRef: 'synthetic:not-selected' },
      { deveui: E3, zoneId: 1, timezone: 'Europe/Zurich', from: '2026-03-28T23:00:00Z', to: '2026-03-31T22:00:00Z', selected: false, sourceRef: 'synthetic:flow-device' },
    ]);
    const noSelection = invoke(db, path.join(root, 'without-selection'), ['--provenance', unselectedProv]);
    assert.equal(noSelection.status, 0, noSelection.stderr);
    const unproven = parseCsv(fs.readFileSync(path.join(root, 'without-selection', 'rain-diff-days.csv'), 'utf8')).find((row) => row.deveui === E1 && row.date === '2026-03-29');
    assert.equal(unproven.delta_mm, '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('retained observation timezone snapshots attribute farm dates without current assignments', () => {
  const root = tmp();
  try {
    const db = fixture(root);
    const handle = new DatabaseSync(db);
    handle.exec(`CREATE TABLE rain_observations (id INTEGER, device_data_id INTEGER, deveui TEXT, received_at TEXT, zone_id INTEGER, timezone TEXT); INSERT INTO rain_observations VALUES (1, 2, '${E1}', '2026-03-29T22:15:00.000Z', 1, 'Europe/Zurich'); UPDATE zone_daily_environment SET rain_selected_deveui = '${E1}', rain_coverage = 'complete' WHERE date = '2026-03-30'; CREATE TABLE rain_instrument_days (deveui TEXT, date TEXT, timezone TEXT, coverage TEXT); INSERT INTO rain_instrument_days VALUES ('${E1}', '2026-03-30', 'Europe/Zurich', 'partial');`);
    handle.close();
    const out = path.join(root, 'out');
    const result = run(['--db', db, '--from', '2026-03-29', '--to', '2026-03-31', '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const rows = parseCsv(fs.readFileSync(path.join(out, 'rain-diff-days.csv'), 'utf8'));
    const observed = rows.find((row) => row.deveui === E1 && row.date === '2026-03-30');
    assert.equal(observed.timezone, 'Europe/Zurich');
    assert.equal(observed.new_received_mm, '0.5');
    assert.equal(observed.new_selected_deveui, E1);
    assert.equal(observed.delta_mm, '', 'partial retained coverage cannot be compared as a complete day');
    assert.ok(!observed.reasons.includes('no_observation_identity'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a mid-day device reassignment stays ambiguous for the whole zone-day comparison', () => {
  const root = tmp();
  try {
    const db = fixture(root);
    const provenance = path.join(root, 'reassignment.json');
    fs.writeFileSync(provenance, JSON.stringify({ version: 1, hostTimezone: 'UTC', intervals: [
      { deveui: E1, zoneId: 1, timezone: 'Europe/Zurich', from: '2026-03-28T23:00:00Z', to: '2026-03-29T12:00:00Z', selected: true, sourceRef: 'synthetic:before-reassignment' },
      { deveui: E1, zoneId: 2, timezone: 'Europe/Zurich', from: '2026-03-29T12:00:00Z', to: '2026-03-31T22:00:00Z', selected: true, sourceRef: 'synthetic:after-reassignment' },
    ] }));
    const out = path.join(root, 'out');
    const result = invoke(db, out, ['--provenance', provenance]);
    assert.equal(result.status, 0, result.stderr);
    const rows = parseCsv(fs.readFileSync(path.join(out, 'rain-diff-days.csv'), 'utf8')).filter((row) => row.deveui === E1 && row.date === '2026-03-29');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.delta_mm === '' && row.new_received_mm === '' && row.reasons.includes('assignment_changed_within_day')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('current assignment cannot establish historical farm date, and pre-0071 schema without rain tables is supported', () => {
  const root = tmp();
  try {
    const db = path.join(root, 'pre-0071.db');
    const handle = new DatabaseSync(db);
    handle.exec(`CREATE TABLE irrigation_zones (id INTEGER PRIMARY KEY, timezone TEXT); CREATE TABLE devices (deveui TEXT, type_id TEXT, irrigation_zone_id INTEGER); CREATE TABLE device_data (id INTEGER PRIMARY KEY, deveui TEXT, recorded_at TEXT, rain_mm_today REAL); CREATE TABLE zone_daily_environment (zone_id INTEGER, date TEXT, rainfall_mm REAL, rain_source TEXT); INSERT INTO irrigation_zones VALUES (8, 'Europe/Zurich'); INSERT INTO irrigation_zones VALUES (9, 'America/Chicago'); INSERT INTO devices VALUES ('${E1}', 'AQUASCOPE_LORAIN', 9); INSERT INTO device_data VALUES (1, '${E1}', '2026-03-29T22:15:00Z', 10.5); INSERT INTO zone_daily_environment VALUES (8, '2026-03-30', 10.5, 'legacy');`);
    handle.close();
    const out = path.join(root, 'out');
    const result = run(['--db', db, '--from', '2026-03-29', '--to', '2026-03-31', '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const rows = parseCsv(fs.readFileSync(path.join(out, 'rain-diff-days.csv'), 'utf8'));
    const row = rows.find((item) => item.deveui === E1);
    assert.equal(row.timezone, '');
    assert.equal(row.new_received_mm, '');
    assert.equal(row.old_host_day_mm, '');
    assert.equal(row.delta_mm, '');
    assert.ok(row.reasons.includes('current_assignment_only'));
    assert.equal(row.zone_id, '9');
    const unattributedOldZone = rows.find((item) => item.zone_id === '8');
    assert.equal(unattributedOldZone.deveui, '');
    assert.equal(unattributedOldZone.delta_mm, '');
    const summary = fs.readFileSync(path.join(out, 'rain-diff-summary.md'), 'utf8');
    assert.match(summary, /Original host timezone: unknown/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('pre-0071 local-gauge row can compare on independently proven sole-gauge full farm day', () => {
  const root = tmp();
  try {
    const db = legacyComparableDb(root);
    const tables = new DatabaseSync(db);
    assert.deepEqual(tables.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name), ['device_data', 'devices', 'irrigation_zones', 'zone_daily_environment']);
    tables.close();
    const result = run(['--db', db, '--from', '2026-03-29', '--to', '2026-03-29', '--out', path.join(root, 'out'), '--provenance', soleGaugeProvenance(root)]);
    assert.equal(result.status, 0, result.stderr);
    const row = parseCsv(fs.readFileSync(path.join(root, 'out', 'rain-diff-days.csv'), 'utf8')).find((r) => r.deveui === E1);
    assert.equal(row.old_zone_row_mm, '2');
    assert.equal(row.new_received_mm, '3');
    assert.equal(row.delta_mm, '1');
    assert.equal(row.new_coverage, 'received_only');
    assert.ok(row.reasons.includes('no_observation_identity'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('weather-station old source cannot be compared to a selected local gauge', () => {
  const root = tmp();
  try {
    const db = legacyComparableDb(root, { source: 'weather_station' });
    const handle = new DatabaseSync(db);
    handle.exec(`ALTER TABLE zone_daily_environment ADD COLUMN rain_selected_deveui TEXT;
      ALTER TABLE zone_daily_environment ADD COLUMN rain_coverage TEXT;
      UPDATE zone_daily_environment SET rain_selected_deveui = '${E1}', rain_coverage = 'complete';
      CREATE TABLE rain_instrument_days (deveui TEXT, date TEXT, timezone TEXT, coverage TEXT);
      INSERT INTO rain_instrument_days VALUES ('${E1}', '2026-03-29', 'Europe/Zurich', 'complete');`);
    handle.close();
    const result = run(['--db', db, '--from', '2026-03-29', '--to', '2026-03-29', '--out', path.join(root, 'out'), '--provenance', soleGaugeProvenance(root)]);
    assert.equal(result.status, 0, result.stderr);
    const row = parseCsv(fs.readFileSync(path.join(root, 'out', 'rain-diff-days.csv'), 'utf8')).find((r) => r.deveui === E1);
    assert.equal(row.delta_mm, '');
    assert.ok(row.reasons.includes('old_source_mismatch'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('provenance contradicting a retained observation snapshot is refused', () => {
  const root = tmp();
  try {
    const conflicts = [
      { zoneId: 2, timezone: 'Europe/Zurich' },
      { zoneId: 1, timezone: 'America/Chicago' },
      { zoneId: 1, timezone: 'Europe/Zurich', deveui: E2 },
    ];
    for (let index = 0; index < conflicts.length; index += 1) {
      const db = legacyComparableDb(root, { observation: conflicts[index] });
      const out = path.join(root, 'out-' + index);
      const result = run(['--db', db, '--from', '2026-03-29', '--to', '2026-03-29', '--out', out, '--provenance', soleGaugeProvenance(root)]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /conflicts with retained observation/);
      assert.equal(fs.existsSync(out), false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('hypothetical daily and seven-day threshold candidates require comparable complete periods', () => {
  const root = tmp();
  try {
    const dailyDb = legacyComparableDb(root, { old: 4, received: 6 });
    let result = run(['--db', dailyDb, '--from', '2026-03-29', '--to', '2026-03-29', '--out', path.join(root, 'daily-out'), '--provenance', soleGaugeProvenance(root)]);
    assert.equal(result.status, 0, result.stderr);
    let summary = fs.readFileSync(path.join(root, 'daily-out', 'rain-diff-summary.md'), 'utf8');
    assert.match(summary, /hypothetical daily crossing.*5 mm.*2026-03-29/i);
    assert.match(summary, /received-only.*not certified/i);

    const downwardDb = legacyComparableDb(root, { old: 6, received: 4 });
    result = run(['--db', downwardDb, '--from', '2026-03-29', '--to', '2026-03-29', '--out', path.join(root, 'daily-down-out'), '--provenance', soleGaugeProvenance(root)]);
    assert.equal(result.status, 0, result.stderr);
    summary = fs.readFileSync(path.join(root, 'daily-down-out', 'rain-diff-summary.md'), 'utf8');
    assert.match(summary, /hypothetical daily crossing.*5 mm.*downward/i);

    const days = Array.from({ length: 7 }, (_, i) => `2026-03-${String(23 + i).padStart(2, '0')}`);
    const rollingDb = legacyComparableDb(root, { old: 2, received: 4, days });
    result = run(['--db', rollingDb, '--from', days[0], '--to', days[6], '--out', path.join(root, 'rolling-out'), '--provenance', soleGaugeProvenance(root, '2026-03-22T23:00:00Z', '2026-03-30T22:00:00Z')]);
    assert.equal(result.status, 0, result.stderr);
    summary = fs.readFileSync(path.join(root, 'rolling-out', 'rain-diff-summary.md'), 'utf8');
    assert.match(summary, /hypothetical seven-day crossing.*20 mm.*2026-03-23.*2026-03-29/i);

    const rollingDownDb = legacyComparableDb(root, { old: 4, received: 2, days });
    result = run(['--db', rollingDownDb, '--from', days[0], '--to', days[6], '--out', path.join(root, 'rolling-down-out'), '--provenance', soleGaugeProvenance(root, '2026-03-22T23:00:00Z', '2026-03-30T22:00:00Z')]);
    assert.equal(result.status, 0, result.stderr);
    summary = fs.readFileSync(path.join(root, 'rolling-down-out', 'rain-diff-summary.md'), 'utf8');
    assert.match(summary, /hypothetical seven-day crossing.*20 mm.*downward/i);

    const incompleteDb = legacyComparableDb(root, { old: 2, received: 4, days: days.slice(1) });
    result = run(['--db', incompleteDb, '--from', days[0], '--to', days[6], '--out', path.join(root, 'incomplete-out'), '--provenance', soleGaugeProvenance(root, '2026-03-22T23:00:00Z', '2026-03-30T22:00:00Z')]);
    assert.equal(result.status, 0, result.stderr);
    summary = fs.readFileSync(path.join(root, 'incomplete-out', 'rain-diff-summary.md'), 'utf8');
    assert.match(summary, /seven-day threshold assessment unverifiable.*(missing or ambiguous farm day|no seven-day window)/i);
    assert.doesNotMatch(summary, /hypothetical seven-day crossing/i);

    const ambiguousDb = legacyComparableDb(root, { old: 2, received: 4, days });
    const ambiguousHandle = new DatabaseSync(ambiguousDb);
    ambiguousHandle.prepare("UPDATE zone_daily_environment SET rain_source = 'legacy_aggregate' WHERE date = ?").run(days[3]);
    ambiguousHandle.close();
    result = run(['--db', ambiguousDb, '--from', days[0], '--to', days[6], '--out', path.join(root, 'ambiguous-out'), '--provenance', soleGaugeProvenance(root, '2026-03-22T23:00:00Z', '2026-03-30T22:00:00Z')]);
    assert.equal(result.status, 0, result.stderr);
    summary = fs.readFileSync(path.join(root, 'ambiguous-out', 'rain-diff-summary.md'), 'utf8');
    assert.match(summary, /seven-day threshold assessment unverifiable.*seven comparable, unambiguous farm days/i);
    assert.doesNotMatch(summary, /hypothetical seven-day crossing/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('malformed UTC provenance calendar and clock components are refused', () => {
  const root = tmp();
  try {
    const db = legacyComparableDb(root);
    for (const from of ['2026-02-30T00:00:00Z', '2026-03-29T25:00:00Z']) {
      const bad = soleGaugeProvenance(root, from, '2026-03-30T22:00:00Z');
      assert.notEqual(invoke(db, path.join(root, 'out-' + from.slice(11, 13)), ['--provenance', bad]).status, 0, from);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('negative numeric delta stays numeric in CSV while text cells remain formula escaped', () => {
  const root = tmp();
  try {
    const db = legacyComparableDb(root, { old: 4, received: 3, source: 'local_gauge' });
    const update = new DatabaseSync(db);
    update.exec("UPDATE devices SET type_id = '-AQUASCOPE_LORAIN'");
    update.close();
    const result = run(['--db', db, '--from', '2026-03-29', '--to', '2026-03-29', '--out', path.join(root, 'out'), '--provenance', soleGaugeProvenance(root)]);
    assert.equal(result.status, 0, result.stderr);
    const content = fs.readFileSync(path.join(root, 'out', 'rain-diff-days.csv'), 'utf8');
    assert.match(content, /,3,received_only,[^,]*,-1,/);
    const row = parseCsv(content).find((r) => r.deveui === E1);
    assert.equal(row.instrument_type, "'-AQUASCOPE_LORAIN");
    assert.equal(row.delta_mm, '-1');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('failed first output write removes partial task output and preserves preexisting files', () => {
  const root = tmp();
  try {
    const db = legacyComparableDb(root);
    const out = path.join(root, 'out');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'keep.txt'), 'preexisting');
    const tool = require('./rain-history-diff.js');
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = (file, data, options) => {
      if (String(file).includes('rain-diff-days.csv')) {
        originalWrite(file, 'partial', options);
        throw new Error('synthetic first write failure');
      }
      return originalWrite(file, data, options);
    };
    try {
      assert.throws(() => tool.run({ dbPath: db, from: '2026-03-29', to: '2026-03-29', outDir: out, provenancePath: soleGaugeProvenance(root), hostTimezone: null }), /synthetic first write failure/);
    } finally { fs.writeFileSync = originalWrite; }
    assert.equal(fs.existsSync(path.join(out, 'rain-diff-days.csv')), false);
    assert.equal(fs.readFileSync(path.join(out, 'keep.txt'), 'utf8'), 'preexisting');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
