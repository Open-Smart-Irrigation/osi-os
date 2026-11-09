'use strict';
// Co-located tests for osi-scheduler-mean-query (#356). They call
// buildSwtMeanQuery directly and run its SQL against a node:sqlite database
// seeded from database/seed-blank.sql. scripts/test-unified-soil-tension-scheduler.js
// runs the same module through the shipped query and decision nodes of both
// profiles.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { buildSwtMeanQuery } = require('./index');

const repo = path.resolve(__dirname, '../../../../../../..');
const SEED = fs.readFileSync(path.join(repo, 'database/seed-blank.sql'), 'utf8');
const KIWI = 'A840410000000011';
const CHAMELEON = 'A840410000000014';
const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();
const CUTOFF = () => minutesAgo(60);

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(SEED);
  db.exec(`
    INSERT INTO users (username, password_hash, created_at, user_uuid) VALUES ('owner', 'h', '2026-01-01', 'u-owner');
    INSERT INTO irrigation_zones (name, user_id, zone_uuid, timezone, scheduling_mode) VALUES ('Z One', 1, 'z-1', 'UTC', 'local');
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, chameleon_enabled, created_at, updated_at) VALUES
      ('${KIWI}', 'Kiwi', 'KIWI_SENSOR', 1, 1, 0, '2026-01-01', '2026-01-01'),
      ('${CHAMELEON}', 'Chameleon', 'DRAGINO_LSN50', 1, 1, 1, '2026-01-01', '2026-01-01');`);
  return db;
}

function reading(db, deveui, swt1, at = minutesAgo(5)) {
  return Number(db.prepare('INSERT INTO device_data (deveui, recorded_at, swt_1) VALUES (?, ?, ?) RETURNING id').get(deveui, at, swt1).id);
}

function linkedChameleon(db, swt1, flags = {}) {
  const at = minutesAgo(5);
  const dataId = reading(db, CHAMELEON, swt1, at);
  const f = { i2c_missing: 0, timeout: 0, data_invalid: 0, ch1_open: 0, ...flags };
  const readingId = Number(db.prepare(`INSERT INTO chameleon_readings (deveui, recorded_at, i2c_missing, timeout, data_invalid, ch1_open)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).get(CHAMELEON, at, f.i2c_missing, f.timeout, f.data_invalid, f.ch1_open).id);
  db.prepare('INSERT INTO chameleon_reading_links (chameleon_reading_id, device_data_id) VALUES (?, ?)').run(readingId, dataId);
  return dataId;
}

function mean(db, metric = 'SWT_1', zoneId = 1) {
  return { ...db.prepare(buildSwtMeanQuery(metric, zoneId, CUTOFF())).get() };
}

test('a linked clean Chameleon value and a KIWI value both count', () => {
  const db = database();
  try {
    reading(db, KIWI, 40);
    linkedChameleon(db, 60);
    const row = mean(db);
    assert.equal(row.n_points, 2);
    assert.equal(row.mean_kpa, 50);
  } finally { db.close(); }
});

test('an unlinked Chameleon value is excluded, even with a same-time diagnostic', () => {
  const db = database();
  try {
    const at = minutesAgo(5);
    reading(db, CHAMELEON, 60, at);
    db.prepare('INSERT INTO chameleon_readings (deveui, recorded_at, i2c_missing, timeout, data_invalid) VALUES (?, ?, 0, 0, 0)').run(CHAMELEON, at);
    assert.equal(mean(db).n_points, 0);
  } finally { db.close(); }
});

test('a faulted row or an open channel is excluded', () => {
  for (const flags of [{ i2c_missing: 1 }, { timeout: 1 }, { data_invalid: 1 }, { ch1_open: 1 }]) {
    const db = database();
    try {
      linkedChameleon(db, 60, flags);
      assert.equal(mean(db).n_points, 0, JSON.stringify(flags));
    } finally { db.close(); }
  }
});

test('Chameleon counts inside 0 to 300 kPa inclusive; KIWI up to 1,000,000 kPa', () => {
  const cases = [
    [CHAMELEON, 0, 1], [CHAMELEON, 300, 1], [CHAMELEON, 300.01, 0], [CHAMELEON, -0.01, 0],
    [KIWI, 301, 1], [KIWI, 1000000, 1], [KIWI, 1000001, 0], [KIWI, -1, 0],
  ];
  for (const [deveui, value, expected] of cases) {
    const db = database();
    try {
      if (deveui === CHAMELEON) linkedChameleon(db, value); else reading(db, deveui, value);
      assert.equal(mean(db).n_points, expected, deveui + ' ' + value);
    } finally { db.close(); }
  }
});

test('a WATERMARK-linked row never counts', () => {
  const db = database();
  try {
    const dataId = linkedChameleon(db, 60);
    db.prepare("INSERT INTO watermark_readings (deveui, recorded_at, device_data_id, payload_hex, frame_status, conversion_version) VALUES (?, ?, ?, '00', 'accepted', 'test')")
      .run(CHAMELEON, minutesAgo(5), dataId);
    reading(db, KIWI, 30);
    const row = mean(db);
    assert.equal(row.n_points, 1);
    assert.equal(row.mean_kpa, 30);
  } finally { db.close(); }
});

test('rows before the cutoff and rows of another zone are excluded', () => {
  const db = database();
  try {
    reading(db, KIWI, 40, minutesAgo(61));
    reading(db, KIWI, 20);
    assert.equal(mean(db).n_points, 1);
    assert.equal(mean(db, 'SWT_1', 2).n_points, 0);
  } finally { db.close(); }
});

test('each metric selects its channel value; an unknown metric reads channel 1', () => {
  const selected = (metric) => buildSwtMeanQuery(metric, 1, CUTOFF()).match(/SELECT recorded_at, (.+) AS row_value/)[1];
  for (const metric of ['SWT_1', 'SWT_WM1', '', 'UNKNOWN']) assert.equal(selected(metric), 'v1', metric);
  for (const metric of ['SWT_2', 'SWT_WM2']) assert.equal(selected(metric), 'v2', metric);
  for (const metric of ['SWT_3', 'SWT_WM3']) assert.equal(selected(metric), 'v3', metric);
  assert.match(selected('SWT_AVG'), /^CASE WHEN \(v1 IS NOT NULL\)/);
});

test('zoneId and cutoffIso must be safe to interpolate', () => {
  const cutoff = '2026-11-09T09:00:00.000Z';
  for (const zoneId of [NaN, Infinity, '1', null, undefined]) {
    assert.throws(() => buildSwtMeanQuery('SWT_1', zoneId, cutoff), TypeError, String(zoneId));
  }
  for (const bad of ['2026-11-09', "2026-11-09T09:00:00.000Z' OR 1=1 --", undefined, Date.parse(cutoff)]) {
    assert.throws(() => buildSwtMeanQuery('SWT_1', 1, bad), TypeError, String(bad));
  }
  const sql = buildSwtMeanQuery('SWT_1', 7, cutoff);
  assert.match(sql, /WHERE ds\.irrigation_zone_id = 7\n/);
  assert.match(sql, /AND dd\.recorded_at >= '2026-11-09T09:00:00\.000Z'\n/);
});
