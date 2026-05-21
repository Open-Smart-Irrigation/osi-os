#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const helper = require(path.resolve(__dirname, '..',
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper'));

function fail(msg) { console.error('FAIL:', msg); process.exit(1); }
function ok(msg) { console.log('ok -', msg); }

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function bindSql(sql, params) {
  let index = 0;
  // Verifier-only binder: replaces value placeholders, not SQL operators or quoted question marks.
  return sql.replace(/\?/g, () => {
    if (index >= params.length) fail('not enough SQL parameters for verifier query');
    return sqlLiteral(params[index++]);
  });
}

function createCliDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-chameleon-verify-'));
  const dbPath = path.join(dir, 'verify.db');
  return {
    exec(sql) {
      execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
    },
    prepare(sql) {
      return {
        run: (...params) => {
          execFileSync('sqlite3', [dbPath, bindSql(sql, params)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
        },
        get: (...params) => {
          const output = execFileSync('sqlite3', ['-json', dbPath, bindSql(sql, params)], { encoding: 'utf8' }).trim();
          const rows = output ? JSON.parse(output) : [];
          return rows[0];
        },
      };
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function setup() {
  const db = createCliDb();
  db.exec(fs.readFileSync(path.resolve(__dirname, '..', 'database/seed-blank.sql'), 'utf8'));
  db.exec("INSERT INTO users(username, password_hash, created_at) VALUES('test-user','hash',datetime('now'))");
  const userId = db.prepare("SELECT id FROM users WHERE username = 'test-user'").get().id;
  db.prepare("INSERT INTO devices(deveui, type_id, name, user_id, created_at, updated_at, chameleon_enabled) VALUES(?, ?, ?, ?, datetime('now'), datetime('now'), 1)")
    .run('0000000000000001', 'DRAGINO_LSN50', 'test-device', userId);
  return db;
}

function calibrationFromArrayId(db, arrayId) {
  const normalized = helper.normalizeArrayId(arrayId);
  if (!normalized) return null;
  const row = db.prepare(
    'SELECT sensor1_a, sensor1_b, sensor1_c, ' +
    'sensor2_a, sensor2_b, sensor2_c, ' +
    'sensor3_a, sensor3_b, sensor3_c ' +
    'FROM chameleon_calibrations WHERE array_id = ?'
  ).get(normalized);
  if (!row) return null;
  return {
    swt1: { a: row.sensor1_a, b: row.sensor1_b, c: row.sensor1_c },
    swt2: { a: row.sensor2_a, b: row.sensor2_b, c: row.sensor2_c },
    swt3: { a: row.sensor3_a, b: row.sensor3_b, c: row.sensor3_c },
  };
}

(function () {
  const db = setup();
  try {
    const ts = '2026-05-19T12:00:00.000Z';
    const arrayId = '28F8B2B40F0000C1';

  // Test 1: Reading with unknown array_id returns null
  db.prepare("INSERT INTO chameleon_readings(deveui, recorded_at, array_id, r1_ohm_comp, r2_ohm_comp, r3_ohm_comp) VALUES(?, ?, ?, ?, ?, ?)")
    .run('0000000000000001', ts, arrayId, 10000, 20000, 30000);
  let calibration = calibrationFromArrayId(db, arrayId);
  if (calibration !== null) fail('expected null calibration for unknown array_id');
  ok('unknown array_id returns null calibration');

  // Test 2: Insert calibration, verify kPa computed
  db.prepare("INSERT INTO chameleon_calibrations(array_id, sensor_id, sensor1_a, sensor1_b, sensor1_c, sensor2_a, sensor2_b, sensor2_c, sensor3_a, sensor3_b, sensor3_c, source, fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(arrayId, 'F8C1', 9.81, 0.13, 6.4, 9.98, 0.13, 6.63, 9.7, 0.12, 5.79, 'via_api', new Date().toISOString());
  calibration = calibrationFromArrayId(db, arrayId);
  if (!calibration) fail('expected calibration after insert');
  const metrics = helper.buildChameleonSwtMetrics(
    { r1OhmComp: 10000, r2OhmComp: 20000, r3OhmComp: 30000 },
    { enabled: true, calibration }
  );
  if (metrics.swt1Kpa === null || metrics.swt2Kpa === null || metrics.swt3Kpa === null) {
    fail('expected non-null kPa for all 3 sensors');
  }
  ok('kPa computed for all 3 sensors after calibration insert');

  // Test 3: Mixed-case input normalized to uppercase
  if (helper.normalizeArrayId(arrayId.toLowerCase()) !== arrayId) {
    fail('normalizeArrayId should canonicalize mixed-case array_id to uppercase');
  }
  if (calibrationFromArrayId(db, arrayId.toLowerCase()) === null) {
    fail('mixed-case array_id should normalize and hit cache');
  }
  ok('mixed-case array_id normalized');

  // Test 4: Calibration disabled — no kPa
  const disabled = helper.buildChameleonSwtMetrics(
    { r1OhmComp: 10000, r2OhmComp: 20000, r3OhmComp: 30000 },
    { enabled: false, calibration }
  );
  if (disabled.swt1Kpa !== null) fail('disabled chameleon should not emit kPa');
  ok('disabled chameleon emits no kPa');

  // Test 5: Miss table TTL (24h) — expired miss excluded from query
  db.prepare("INSERT INTO chameleon_calibration_misses(array_id, last_tried, reason) VALUES(?, ?, ?)")
    .run('0000000000000002', new Date(Date.now() - 25 * 3600 * 1000).toISOString(), 'not_found');
  const expiredMiss = db.prepare(
    "SELECT COUNT(*) AS n FROM chameleon_calibration_misses " +
    "WHERE array_id = ? AND datetime(last_tried) > datetime('now', '-24 hours')"
  ).get('0000000000000002');
  if (expiredMiss.n !== 0) fail('expected expired miss to be excluded by TTL filter');
  ok('expired miss row not selected by 24h TTL query');

  // Test 6: calibration_status on pending (enabled, no calibration)
  const ped = helper.buildChameleonSwtMetrics(
    { r1OhmComp: 10000 },
    { enabled: true, calibration: null }
  );
  if (ped.calibrationStatus !== 'pending') fail('expected calibrationStatus=pending, got ' + ped.calibrationStatus);
  ok('calibrationStatus is pending when enabled without calibration');

    console.log('verify-chameleon-calibration PASS');
  } finally {
    db.cleanup();
  }
})();
